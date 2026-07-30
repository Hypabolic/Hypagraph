/**
 * Named direct CLI node executor adapter.
 *
 * Direct CLI execution is a compatibility mechanism for agents without ACP.
 * Strict execution uses named adapters only. Arbitrary shell commands are not
 * strict mutating executors.
 *
 * Each named adapter defines:
 * 1. fixed command invocation (argv array only; shell is never used);
 * 2. context input format;
 * 3. result output format;
 * 4. cancellation (AbortSignal ends the process tree);
 * 5. timeout (finite default; timed_out outcome);
 * 6. result normalization via validateExecutorResult;
 * 7. security limits (output bounds, env allowlist, binary path checks).
 *
 * Lifecycle for one attempt:
 * 1. resolve named adapter (fail closed when unknown);
 * 2. materialize / receive context envelope;
 * 3. serialize context to the adapter input format;
 * 4. spawn fixed command + args (no shell);
 * 5. apply timeout and AbortSignal cancel;
 * 6. bound stdout and stderr;
 * 7. parse untrusted result from stdout;
 * 8. validateExecutorResult; controllers still settle before commit.
 *
 * The adapter never mutates graph or family state.
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import {
  buildExecutorResultPayload,
  materializeExecutorContext,
  validateExecutorResult,
  type ExecutorAttemptIdentity,
  type ExecutorContextEnvelope,
  type ExecutorDiagnostic,
  type ExecutorOutcome,
  type ExecutorProfileRef,
  type ExecutorResult,
  type ExecutorUsage,
  type MaterializeExecutorContextResult,
  type NodeExecutor,
} from "../domain/executor-contract.js";
import { stableStringify } from "../domain/hash.js";
import {
  settleExecutorResult,
  type SettleExecutorResultMeta,
  type SettleExecutorResultResult,
} from "../domain/executor-settlement.js";
import type { GoalFamilyRuntime } from "../domain/goal-family.js";
import type {
  Diagnostic,
  EvidenceReference,
  FactInput,
  HypagraphState,
} from "../domain/model.js";
import { terminateChildProcessTree } from "./child-process-jsonrpc.js";

// ---------------------------------------------------------------------------
// Profile and identity constants
// ---------------------------------------------------------------------------

/** Built-in product adapter name for JSON stdin/stdout CLI agents. */
export const HYPAGRAPH_CLI_JSON_ADAPTER_NAME = "hypagraph-cli-json";

/** Stable profile for the default named CLI adapter. */
export const CLI_PROFILE: ExecutorProfileRef = {
  profileId: "cli-hypagraph-json",
  kind: "cli",
};

export const CLI_EXECUTOR_ID = "cli";
export const CLI_EXECUTOR_VERSION = 1;

/**
 * Default attempt timeout (5 minutes).
 * A finite default keeps hung CLI agents cancellable and bounded.
 */
export const DEFAULT_CLI_TIMEOUT_MS = 5 * 60 * 1000;

/** Default maximum stdout bytes retained for result parsing. */
export const DEFAULT_CLI_MAX_STDOUT_BYTES = 1_048_576;

/** Default maximum stderr bytes retained for diagnostics. */
export const DEFAULT_CLI_MAX_STDERR_BYTES = 65_536;

/** Minimum allowed timeout when callers override adapter defaults. */
export const MIN_CLI_TIMEOUT_MS = 1;

/** Maximum allowed timeout (24 hours). */
export const MAX_CLI_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Environment variable for the hypagraph-cli-json binary path. */
export const HYPAGRAPH_CLI_JSON_BIN_ENV = "HYPAGRAPH_CLI_JSON_BIN";

// ---------------------------------------------------------------------------
// Named adapter registry
// ---------------------------------------------------------------------------

/** How the context envelope is passed to the CLI process. */
export type CliContextFormat = "stdin-json";

/** How the structured result is read from the CLI process. */
export type CliResultFormat = "stdout-json";

/**
 * One named CLI adapter definition.
 * Definitions are fixed and tested. They are not free-form user shell strings.
 */
export interface NamedCliAdapterDefinition {
  /** Registry key (for example hypagraph-cli-json). */
  name: string;
  /** Executor profile id used when materializing context for this adapter. */
  profileId: string;
  /**
   * Fixed binary path or basename.
   * Production child-process transport may override via env when allowEnvBin is set.
   */
  command: string;
  /** Fixed argument list. Never joined into a shell string. */
  args: readonly string[];
  contextFormat: CliContextFormat;
  resultFormat: CliResultFormat;
  defaultTimeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  /**
   * Host env keys the transport may forward into the child.
   * Keys outside this list are dropped.
   */
  allowedEnvKeys: readonly string[];
  /**
   * When set, the child-process transport may replace command with this env var
   * when the value is a valid binary path.
   */
  allowEnvBin?: string;
  /**
   * Working directory policy.
   * - require-absolute: host cwd must be an absolute path when provided
   * - host: accept host-resolved cwd when present
   */
  cwdPolicy: "require-absolute" | "host";
}

const CONTEXT_FORMATS = new Set<CliContextFormat>(["stdin-json"]);
const RESULT_FORMATS = new Set<CliResultFormat>(["stdout-json"]);

/**
 * Built-in named adapters.
 * Product and tests use these. Unknown names never fall through to shell.
 */
const BUILTIN_CLI_ADAPTERS: NamedCliAdapterDefinition[] = [
  {
    name: HYPAGRAPH_CLI_JSON_ADAPTER_NAME,
    profileId: CLI_PROFILE.profileId,
    // Placeholder; product sets HYPAGRAPH_CLI_JSON_BIN or resolveCommand.
    command: "hypagraph-cli-json",
    args: [],
    contextFormat: "stdin-json",
    resultFormat: "stdout-json",
    defaultTimeoutMs: DEFAULT_CLI_TIMEOUT_MS,
    maxStdoutBytes: DEFAULT_CLI_MAX_STDOUT_BYTES,
    maxStderrBytes: DEFAULT_CLI_MAX_STDERR_BYTES,
    allowedEnvKeys: [
      "PATH",
      "HOME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "USER",
      "LOGNAME",
      "HYPAGRAPH_CLI_ATTEMPT",
    ],
    allowEnvBin: HYPAGRAPH_CLI_JSON_BIN_ENV,
    cwdPolicy: "require-absolute",
  },
];

const namedCliAdapterRegistry = new Map<string, NamedCliAdapterDefinition>(
  BUILTIN_CLI_ADAPTERS.map((adapter) => [adapter.name, freezeAdapter(adapter)]),
);

function freezeAdapter(adapter: NamedCliAdapterDefinition): NamedCliAdapterDefinition {
  return {
    name: adapter.name,
    profileId: adapter.profileId,
    command: adapter.command,
    args: Object.freeze([...adapter.args]),
    contextFormat: adapter.contextFormat,
    resultFormat: adapter.resultFormat,
    defaultTimeoutMs: adapter.defaultTimeoutMs,
    maxStdoutBytes: adapter.maxStdoutBytes,
    maxStderrBytes: adapter.maxStderrBytes,
    allowedEnvKeys: Object.freeze([...adapter.allowedEnvKeys]),
    ...(adapter.allowEnvBin !== undefined ? { allowEnvBin: adapter.allowEnvBin } : {}),
    cwdPolicy: adapter.cwdPolicy,
  };
}

/**
 * Look up a named CLI adapter by name.
 * Returns a clear diagnostic when the name is unknown. Never falls through to shell.
 */
export function getNamedCliAdapter(
  name: string,
): { ok: true; value: NamedCliAdapterDefinition } | { ok: false; code: string; message: string } {
  if (!isNonEmptyString(name)) {
    return {
      ok: false,
      code: "cli_adapter_name_invalid",
      message: "CLI adapter name must be a non-empty string.",
    };
  }
  const adapter = namedCliAdapterRegistry.get(name);
  if (!adapter) {
    return {
      ok: false,
      code: "cli_adapter_unknown",
      message:
        `Unknown CLI adapter '${name}'. `
        + "Strict CLI execution requires a named adapter from the registry. "
        + "Arbitrary shell commands are not allowed.",
    };
  }
  return { ok: true, value: cloneAdapter(adapter) };
}

/**
 * List registered named CLI adapters (sorted by name).
 * Returns deep clones so callers cannot mutate the registry.
 */
export function listNamedCliAdapters(): NamedCliAdapterDefinition[] {
  return [...namedCliAdapterRegistry.values()]
    .map((adapter) => cloneAdapter(adapter))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Register or replace a named CLI adapter.
 * Intended for tests and product extension of the built-in set.
 * Rejects invalid definitions with clear diagnostics. Does not throw.
 */
export function registerNamedCliAdapter(
  adapter: NamedCliAdapterDefinition,
): { ok: true } | { ok: false; code: string; message: string; location?: string } {
  const validated = validateNamedCliAdapterDefinition(adapter);
  if (!validated.ok) return validated;
  namedCliAdapterRegistry.set(adapter.name, freezeAdapter(validated.value));
  return { ok: true };
}

/**
 * Remove a named CLI adapter from the registry.
 * Built-in adapters can be removed in tests; product hosts normally keep them.
 */
export function unregisterNamedCliAdapter(name: string): boolean {
  return namedCliAdapterRegistry.delete(name);
}

/**
 * Validate a named adapter definition without registering it.
 */
export function validateNamedCliAdapterDefinition(
  adapter: unknown,
):
  | { ok: true; value: NamedCliAdapterDefinition }
  | { ok: false; code: string; message: string; location?: string } {
  if (!isStrictPlainObject(adapter)) {
    return {
      ok: false,
      code: "cli_adapter_invalid",
      message: "CLI adapter definition must be a plain object.",
      location: "adapter",
    };
  }
  const record = adapter as Record<string, unknown>;
  if (!isNonEmptyString(record.name)) {
    return {
      ok: false,
      code: "cli_adapter_invalid",
      message: "CLI adapter requires a non-empty name.",
      location: "adapter.name",
    };
  }
  if (!isNonEmptyString(record.profileId)) {
    return {
      ok: false,
      code: "cli_adapter_invalid",
      message: "CLI adapter requires a non-empty profileId.",
      location: "adapter.profileId",
    };
  }
  if (!isNonEmptyString(record.command)) {
    return {
      ok: false,
      code: "cli_adapter_invalid",
      message: "CLI adapter requires a non-empty command.",
      location: "adapter.command",
    };
  }
  const commandCheck = validateCliBinaryPath(record.command);
  if (!commandCheck.ok) {
    return {
      ok: false,
      code: commandCheck.code,
      message: commandCheck.message,
      location: "adapter.command",
    };
  }
  if (!Array.isArray(record.args)) {
    return {
      ok: false,
      code: "cli_adapter_invalid",
      message: "CLI adapter args must be an array of strings.",
      location: "adapter.args",
    };
  }
  for (let index = 0; index < record.args.length; index += 1) {
    if (typeof record.args[index] !== "string") {
      return {
        ok: false,
        code: "cli_adapter_invalid",
        message: `CLI adapter args at index ${index} must be a string.`,
        location: `adapter.args[${index}]`,
      };
    }
  }
  if (typeof record.contextFormat !== "string" || !CONTEXT_FORMATS.has(record.contextFormat as CliContextFormat)) {
    return {
      ok: false,
      code: "cli_adapter_invalid",
      message: "CLI adapter contextFormat must be a known format (stdin-json).",
      location: "adapter.contextFormat",
    };
  }
  if (typeof record.resultFormat !== "string" || !RESULT_FORMATS.has(record.resultFormat as CliResultFormat)) {
    return {
      ok: false,
      code: "cli_adapter_invalid",
      message: "CLI adapter resultFormat must be a known format (stdout-json).",
      location: "adapter.resultFormat",
    };
  }
  if (!isPositiveSafeInteger(record.defaultTimeoutMs)) {
    return {
      ok: false,
      code: "cli_adapter_invalid",
      message: "CLI adapter defaultTimeoutMs must be a positive safe integer.",
      location: "adapter.defaultTimeoutMs",
    };
  }
  if ((record.defaultTimeoutMs as number) > MAX_CLI_TIMEOUT_MS) {
    return {
      ok: false,
      code: "cli_adapter_invalid",
      message: `CLI adapter defaultTimeoutMs must be at most ${MAX_CLI_TIMEOUT_MS}.`,
      location: "adapter.defaultTimeoutMs",
    };
  }
  if (!isPositiveSafeInteger(record.maxStdoutBytes)) {
    return {
      ok: false,
      code: "cli_adapter_invalid",
      message: "CLI adapter maxStdoutBytes must be a positive safe integer.",
      location: "adapter.maxStdoutBytes",
    };
  }
  if (!isPositiveSafeInteger(record.maxStderrBytes)) {
    return {
      ok: false,
      code: "cli_adapter_invalid",
      message: "CLI adapter maxStderrBytes must be a positive safe integer.",
      location: "adapter.maxStderrBytes",
    };
  }
  if (!Array.isArray(record.allowedEnvKeys)) {
    return {
      ok: false,
      code: "cli_adapter_invalid",
      message: "CLI adapter allowedEnvKeys must be an array of strings.",
      location: "adapter.allowedEnvKeys",
    };
  }
  for (let index = 0; index < record.allowedEnvKeys.length; index += 1) {
    if (!isNonEmptyString(record.allowedEnvKeys[index])) {
      return {
        ok: false,
        code: "cli_adapter_invalid",
        message: `CLI adapter allowedEnvKeys at index ${index} must be a non-empty string.`,
        location: `adapter.allowedEnvKeys[${index}]`,
      };
    }
  }
  if (record.allowEnvBin !== undefined && !isNonEmptyString(record.allowEnvBin)) {
    return {
      ok: false,
      code: "cli_adapter_invalid",
      message: "CLI adapter allowEnvBin must be a non-empty string when present.",
      location: "adapter.allowEnvBin",
    };
  }
  if (record.cwdPolicy !== "require-absolute" && record.cwdPolicy !== "host") {
    return {
      ok: false,
      code: "cli_adapter_invalid",
      message: "CLI adapter cwdPolicy must be 'require-absolute' or 'host'.",
      location: "adapter.cwdPolicy",
    };
  }

  return {
    ok: true,
    value: {
      name: record.name as string,
      profileId: record.profileId as string,
      command: record.command as string,
      args: (record.args as string[]).map(String),
      contextFormat: record.contextFormat as CliContextFormat,
      resultFormat: record.resultFormat as CliResultFormat,
      defaultTimeoutMs: record.defaultTimeoutMs as number,
      maxStdoutBytes: record.maxStdoutBytes as number,
      maxStderrBytes: record.maxStderrBytes as number,
      allowedEnvKeys: (record.allowedEnvKeys as string[]).map(String),
      ...(isNonEmptyString(record.allowEnvBin) ? { allowEnvBin: record.allowEnvBin } : {}),
      cwdPolicy: record.cwdPolicy as "require-absolute" | "host",
    },
  };
}

function cloneAdapter(adapter: NamedCliAdapterDefinition): NamedCliAdapterDefinition {
  return {
    name: adapter.name,
    profileId: adapter.profileId,
    command: adapter.command,
    args: [...adapter.args],
    contextFormat: adapter.contextFormat,
    resultFormat: adapter.resultFormat,
    defaultTimeoutMs: adapter.defaultTimeoutMs,
    maxStdoutBytes: adapter.maxStdoutBytes,
    maxStderrBytes: adapter.maxStderrBytes,
    allowedEnvKeys: [...adapter.allowedEnvKeys],
    ...(adapter.allowEnvBin !== undefined ? { allowEnvBin: adapter.allowEnvBin } : {}),
    cwdPolicy: adapter.cwdPolicy,
  };
}

/**
 * Resolve adapter name from a CLI profile ref.
 * Prefers profile.instanceId when it matches a registered adapter.
 * Else matches profileId against registered profileId values.
 * Else strips a leading "cli-" from profileId when that name is registered.
 */
export function resolveCliAdapterNameFromProfile(
  profile: ExecutorProfileRef,
): { ok: true; name: string } | { ok: false; code: string; message: string } {
  if (profile.kind !== "cli") {
    return {
      ok: false,
      code: "cli_profile_mismatch",
      message: `CLI adapter resolve requires profile kind 'cli', got '${profile.kind}'.`,
    };
  }
  if (isNonEmptyString(profile.instanceId)) {
    const byInstance = namedCliAdapterRegistry.get(profile.instanceId);
    if (byInstance) return { ok: true, name: byInstance.name };
  }
  for (const adapter of namedCliAdapterRegistry.values()) {
    if (adapter.profileId === profile.profileId) {
      return { ok: true, name: adapter.name };
    }
  }
  if (isNonEmptyString(profile.profileId) && profile.profileId.startsWith("cli-")) {
    const stripped = profile.profileId.slice("cli-".length);
    if (namedCliAdapterRegistry.has(stripped)) {
      return { ok: true, name: stripped };
    }
  }
  if (namedCliAdapterRegistry.has(profile.profileId)) {
    return { ok: true, name: profile.profileId };
  }
  return {
    ok: false,
    code: "cli_adapter_unknown",
    message:
      `No named CLI adapter is registered for profileId '${profile.profileId}'. `
      + "Strict CLI execution requires a named adapter from the registry.",
  };
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

/**
 * Characters that must never appear in a CLI binary path for strict mode.
 * Spawn uses shell:false. Spaces are allowed only in absolute paths (see
 * validateCliBinaryPath) so Windows Program Files paths remain usable.
 */
const CLI_BINARY_SHELL_METACHAR_PATTERN = /[;&|`$<>'"\\\n\r\t]/;

/**
 * Known shell interpreter basenames rejected for strict named adapters.
 * Registry authors must not register shell front-ends as mutating executors.
 * A mistaken registration of /bin/sh with args ["-c", "..."] would reintroduce
 * shell execution under shell:false. This denylist fails closed at registration.
 */
const CLI_SHELL_INTERPRETER_BASENAMES = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "csh",
  "tcsh",
  "ksh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

/**
 * Validate a CLI binary path for strict spawn.
 * Rejects empty paths, null bytes, path traversal, shell metacharacters,
 * known shell interpreters, and relative paths that contain whitespace.
 * Absolute paths may contain spaces (shell:false; argv is a single path).
 */
export function validateCliBinaryPath(
  command: string,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!isNonEmptyString(command)) {
    return {
      ok: false,
      code: "cli_binary_path_invalid",
      message: "CLI binary path must be a non-empty string.",
    };
  }
  if (command.includes("\0")) {
    return {
      ok: false,
      code: "cli_binary_path_invalid",
      message: "CLI binary path must not contain a null byte.",
    };
  }
  if (CLI_BINARY_SHELL_METACHAR_PATTERN.test(command)) {
    return {
      ok: false,
      code: "cli_binary_shell_metacharacters",
      message:
        "CLI binary path must not contain shell metacharacters. "
        + "Strict CLI adapters spawn argv arrays only (no shell).",
    };
  }
  // Relative paths with whitespace cannot be a single safe basename token.
  // Absolute paths with spaces are allowed (for example Program Files).
  if (/\s/.test(command) && !isAbsolutePath(command)) {
    return {
      ok: false,
      code: "cli_binary_shell_metacharacters",
      message:
        "CLI binary path must not contain whitespace unless it is an absolute path. "
        + "Strict CLI adapters spawn argv arrays only (no shell).",
    };
  }
  // Reject path traversal segments in both absolute and relative forms.
  const segments = command.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    return {
      ok: false,
      code: "cli_binary_path_traversal",
      message: "CLI binary path must not contain path traversal segments ('..').",
    };
  }
  const basename = (segments[segments.length - 1] ?? "").toLowerCase();
  if (isNonEmptyString(basename) && CLI_SHELL_INTERPRETER_BASENAMES.has(basename)) {
    return {
      ok: false,
      code: "cli_binary_shell_interpreter",
      message:
        `CLI binary '${basename}' is a shell interpreter and is not allowed. `
        + "Strict named adapters must not register shell front-ends. "
        + "Use a fixed non-shell binary and argv array only.",
    };
  }
  return { ok: true };
}

/**
 * Assert that shell execution is refused for this adapter surface.
 * Used by tests and product probes. Always returns a fixed diagnostic.
 */
export function refuseCliShellExecution(
  reason = "Arbitrary shell execution is not a strict mutating executor.",
): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: "cli_shell_refused",
    message:
      `${reason} Use a named CLI adapter from the registry instead.`,
  };
}

/**
 * Filter env to adapter-allowed keys only.
 * Always injects HYPAGRAPH_CLI_ATTEMPT when identity is known.
 */
export function filterCliEnv(
  source: Record<string, string | undefined> | NodeJS.ProcessEnv,
  allowedKeys: readonly string[],
  attemptId?: string,
): Record<string, string> {
  const allowed = new Set(allowedKeys);
  const result: Record<string, string> = {};
  for (const key of allowed) {
    const value = source[key];
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  if (isNonEmptyString(attemptId) && allowed.has("HYPAGRAPH_CLI_ATTEMPT")) {
    result.HYPAGRAPH_CLI_ATTEMPT = attemptId;
  }
  return result;
}

/**
 * Serialize a context envelope for the adapter input format.
 * stdin-json uses stableStringify so serialization is reproducible.
 */
export function serializeCliContextInput(
  context: ExecutorContextEnvelope,
  format: CliContextFormat,
): { ok: true; value: string } | { ok: false; code: string; message: string } {
  if (format === "stdin-json") {
    try {
      // stableStringify sorts keys so identical envelopes produce identical bytes.
      return { ok: true, value: `${stableStringify(context)}\n` };
    } catch (error) {
      return {
        ok: false,
        code: "cli_context_serialize_failed",
        message: errorMessage(error, "Failed to serialize CLI context envelope."),
      };
    }
  }
  return {
    ok: false,
    code: "cli_context_format_unknown",
    message: `Unknown CLI context format '${String(format)}'.`,
  };
}

/**
 * Parse a CLI result from captured stdout according to the adapter format.
 * stdout-json: last plain JSON object in the text (line-oriented preferred).
 */
export function parseCliResultOutput(
  stdout: string,
  format: CliResultFormat,
): { ok: true; value: Record<string, unknown> } | { ok: false; code: string; message: string } {
  if (format !== "stdout-json") {
    return {
      ok: false,
      code: "cli_result_format_unknown",
      message: `Unknown CLI result format '${String(format)}'.`,
    };
  }
  if (typeof stdout !== "string" || stdout.trim().length === 0) {
    return {
      ok: false,
      code: "cli_result_empty",
      message:
        "The CLI process returned no stdout for the structured result. "
        + "Raw empty output is not a valid canonical result.",
    };
  }

  // Prefer the last non-empty line that parses as a plain JSON object.
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isStrictPlainObject(parsed)) {
        return { ok: true, value: parsed as Record<string, unknown> };
      }
    } catch {
      // try previous line
    }
  }

  // Fall back to whole-buffer parse (single multi-line JSON object).
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (isStrictPlainObject(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return {
      ok: false,
      code: "cli_result_not_object",
      message:
        "The CLI stdout JSON value is not a plain object. "
        + "Arrays and class instances are not valid ExecutorResult payloads.",
    };
  } catch {
    return {
      ok: false,
      code: "cli_result_invalid_json",
      message:
        "The CLI stdout did not contain a parseable JSON object. "
        + "Raw text is not a valid canonical result.",
    };
  }
}

/**
 * Clamp a timeout to the allowed bounds. Returns diagnostics when invalid.
 */
export function resolveCliTimeoutMs(
  requested: number | undefined,
  adapterDefault: number,
): { ok: true; value: number } | { ok: false; code: string; message: string } {
  const value = requested ?? adapterDefault;
  if (!isPositiveSafeInteger(value)) {
    return {
      ok: false,
      code: "cli_timeout_invalid",
      message: "CLI timeout must be a positive safe integer.",
    };
  }
  if (value < MIN_CLI_TIMEOUT_MS || value > MAX_CLI_TIMEOUT_MS) {
    return {
      ok: false,
      code: "cli_timeout_out_of_bounds",
      message:
        `CLI timeout must be between ${MIN_CLI_TIMEOUT_MS} and ${MAX_CLI_TIMEOUT_MS} ms.`,
    };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Process-side session registry (not domain schema)
// ---------------------------------------------------------------------------

/** One host-owned CLI process record. Not persisted in the domain reducer. */
export interface OwnedCliProcessRecord {
  processToken: string;
  /** Optional OS pid when known. */
  pid?: number;
  adapterName: string;
  identity: ExecutorAttemptIdentity;
  startedAt: string;
  live: boolean;
}

/**
 * Why the host terminated an owned CLI process.
 * Classification of cancelled vs interrupted uses this kind, not free-text reason.
 */
export type CliHostTeardownKind = "restore" | "branch" | "user" | "other";

/** Tombstone left after host-initiated teardown so in-flight execute can map outcome. */
export interface CliHostTeardownTombstone {
  processToken: string;
  kind: CliHostTeardownKind;
  /** Human-readable reason for diagnostics. Not used for outcome classification. */
  reason: string;
}

/** Failure shape returned by CLI registry operations. */
export type CliRegistryFailure = {
  ok: false;
  code: string;
  message: string;
  hostTeardown?: CliHostTeardownTombstone;
};

/**
 * Host-side registry of in-flight CLI processes.
 * Supports host teardown tombstones so in-flight execute maps restore/branch to
 * interrupted and user/other to cancelled. Does not store canonical attempt context.
 */
export class CliProcessRegistry {
  private readonly records = new Map<string, OwnedCliProcessRecord>();
  private readonly closers = new Map<string, (reason: string) => Promise<void>>();
  private readonly hostTeardowns = new Map<string, CliHostTeardownTombstone>();
  private readonly activeExecuteTokens = new Set<string>();

  register(
    record: OwnedCliProcessRecord,
  ): { ok: true } | CliRegistryFailure {
    if (this.records.has(record.processToken)) {
      return {
        ok: false,
        code: "cli_process_token_duplicate",
        message: `Process token '${record.processToken}' is already registered.`,
      };
    }
    const existingTeardown = this.hostTeardowns.get(record.processToken);
    if (existingTeardown) {
      return {
        ok: false,
        code: "cli_host_teardown",
        message: existingTeardown.reason,
        hostTeardown: structuredClone(existingTeardown),
      };
    }
    this.records.set(record.processToken, {
      ...record,
      identity: structuredClone(record.identity),
    });
    return { ok: true };
  }

  update(
    processToken: string,
    patch: Partial<Pick<OwnedCliProcessRecord, "pid" | "live" | "startedAt" | "adapterName">>,
  ): { ok: true; record: OwnedCliProcessRecord } | CliRegistryFailure {
    const record = this.records.get(processToken);
    if (!record) {
      const teardown = this.hostTeardowns.get(processToken);
      if (teardown) {
        return {
          ok: false,
          code: "cli_host_teardown",
          message: teardown.reason,
          hostTeardown: structuredClone(teardown),
        };
      }
      return {
        ok: false,
        code: "cli_process_token_unknown",
        message: `Process token '${processToken}' is not registered.`,
      };
    }
    if (patch.pid !== undefined) record.pid = patch.pid;
    if (patch.live !== undefined) record.live = patch.live;
    if (patch.startedAt !== undefined) record.startedAt = patch.startedAt;
    if (patch.adapterName !== undefined) record.adapterName = patch.adapterName;
    return { ok: true, record: structuredClone(record) };
  }

  setCloser(processToken: string, close: (reason: string) => Promise<void>): void {
    if (!this.records.has(processToken) && !this.hostTeardowns.has(processToken)) return;
    this.closers.set(processToken, close);
  }

  get(processToken: string): OwnedCliProcessRecord | undefined {
    const record = this.records.get(processToken);
    return record ? structuredClone(record) : undefined;
  }

  getHostTeardown(processToken: string): CliHostTeardownTombstone | undefined {
    const tombstone = this.hostTeardowns.get(processToken);
    return tombstone ? structuredClone(tombstone) : undefined;
  }

  clearHostTeardown(processToken: string): void {
    this.hostTeardowns.delete(processToken);
    this.closers.delete(processToken);
  }

  noteExecuteStarted(processToken: string): void {
    this.activeExecuteTokens.add(processToken);
  }

  noteExecuteFinished(processToken: string): void {
    this.activeExecuteTokens.delete(processToken);
    this.clearHostTeardown(processToken);
  }

  list(): OwnedCliProcessRecord[] {
    return [...this.records.values()]
      .map((record) => structuredClone(record))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)
        || left.processToken.localeCompare(right.processToken));
  }

  hasActive(): boolean {
    return [...this.records.values()].some((record) => record.live);
  }

  activeCount(): number {
    return [...this.records.values()].filter((record) => record.live).length;
  }

  markNotLive(processToken: string): void {
    const record = this.records.get(processToken);
    if (!record) return;
    record.live = false;
  }

  unregister(processToken: string): void {
    this.records.delete(processToken);
    this.closers.delete(processToken);
  }

  /**
   * Close one owned process and leave a host-teardown tombstone for in-flight execute.
   */
  async closeOwned(
    processToken: string,
    input: { reason: string; kind: CliHostTeardownKind },
  ): Promise<boolean> {
    const record = this.records.get(processToken);
    const existingTeardown = this.hostTeardowns.get(processToken);
    if (!record && !existingTeardown) return false;

    this.hostTeardowns.set(processToken, {
      processToken,
      kind: input.kind,
      reason: input.reason,
    });
    const closer = this.closers.get(processToken);
    if (closer) {
      try {
        await closer(input.reason);
      } catch {
        // best effort
      }
    }
    if (record) {
      this.markNotLive(processToken);
      this.unregister(processToken);
    }
    if (!this.activeExecuteTokens.has(processToken)) {
      this.clearHostTeardown(processToken);
    }
    return true;
  }

  /**
   * Close every owned process. Used on session restore and branch change.
   * Callers must pass kind so restore/branch are not misclassified as cancel.
   */
  async closeAll(input: { reason: string; kind: CliHostTeardownKind }): Promise<number> {
    const tokens = this.list().map((record) => record.processToken);
    let count = 0;
    for (const token of tokens) {
      const done = await this.closeOwned(token, input);
      if (done) count += 1;
    }
    for (const token of [...this.hostTeardowns.keys()]) {
      if (!this.activeExecuteTokens.has(token)) {
        this.clearHostTeardown(token);
      }
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

export interface BuildCliResultPayloadInput {
  identity: ExecutorAttemptIdentity;
  outcome: ExecutorOutcome;
  facts?: FactInput[];
  evidence?: EvidenceReference[];
  summary?: string;
  diagnostics?: ExecutorDiagnostic[];
  usage?: ExecutorUsage;
  artifacts?: ExecutorResult["artifacts"];
}

/**
 * Build a plain-object untrusted result with identity from the context envelope.
 * The payload is not trusted until settleExecutorResult validates it.
 */
export function buildCliResultPayload(
  input: BuildCliResultPayloadInput,
): Record<string, unknown> {
  return buildExecutorResultPayload({
    identity: input.identity,
    outcome: input.outcome,
    ...(input.facts !== undefined ? { facts: input.facts } : {}),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.diagnostics !== undefined ? { diagnostics: input.diagnostics } : {}),
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
    defaultSummary: defaultSummaryForOutcome,
  });
}

/**
 * Clamp diagnostics so the payload stays within the result protocol bound.
 */
export function clampCliDiagnostics(
  diagnostics: readonly ExecutorDiagnostic[],
  maxDiagnostics: number,
): ExecutorDiagnostic[] {
  const max = Number.isSafeInteger(maxDiagnostics) && maxDiagnostics >= 0
    ? maxDiagnostics
    : 0;
  if (max === 0) return [];
  if (diagnostics.length <= max) {
    return diagnostics.map((item) => structuredClone(item));
  }
  const truncation: ExecutorDiagnostic = {
    code: "cli_diagnostics_truncated",
    message:
      `Executor diagnostics were truncated from ${diagnostics.length} to ${max} `
      + "to satisfy the result protocol bound.",
  };
  if (max === 1) return [truncation];
  const kept = diagnostics.slice(0, max - 1).map((item) => structuredClone(item));
  kept.push(truncation);
  return kept;
}

/**
 * Keep only non-negative safe integer usage fields. Drop invalid values.
 */
export function normalizeCliUsage(usage: unknown): ExecutorUsage {
  if (!isStrictPlainObject(usage)) return {};
  const result: ExecutorUsage = {};
  const record = usage as Record<string, unknown>;
  if (isNonNegativeSafeInteger(record.turns)) result.turns = record.turns;
  if (isNonNegativeSafeInteger(record.inputTokens)) result.inputTokens = record.inputTokens;
  if (isNonNegativeSafeInteger(record.outputTokens)) result.outputTokens = record.outputTokens;
  if (isNonNegativeSafeInteger(record.totalTokens)) result.totalTokens = record.totalTokens;
  return result;
}

/**
 * Build a structured failure/cancel/interrupt result from the context envelope.
 * Preserves canonical identity when the CLI process is lost.
 */
export function resultFromCliContext(
  context: ExecutorContextEnvelope,
  outcome: ExecutorOutcome,
  diagnostics: ExecutorDiagnostic[],
  summary?: string,
  usage?: ExecutorUsage,
): ExecutorResult {
  const maxDiagnostics = context.resultProtocol?.maxDiagnostics ?? 64;
  const maxSummaryChars = context.resultProtocol?.maxSummaryChars ?? 4096;
  const clamped = clampCliDiagnostics(diagnostics, maxDiagnostics);
  const safeUsage = normalizeCliUsage(usage ?? {});
  const rawSummary = isNonEmptyString(summary)
    ? summary
    : defaultSummaryForOutcome(outcome);
  const safeSummary = rawSummary.slice(0, maxSummaryChars);

  const payload = buildCliResultPayload({
    identity: context.identity,
    outcome,
    summary: safeSummary,
    diagnostics: clamped,
    usage: safeUsage,
  });

  const validated = validateExecutorResult(context, payload);
  if (validated.ok) return validated.value;

  const minimalDiagnostics = clampCliDiagnostics(
    [{
      code: "cli_result_construction_failed",
      message:
        "The CLI executor could not build a fully validated failure result. "
        + "Identity is preserved from the context envelope.",
    }],
    maxDiagnostics,
  );
  const minimalPayload = buildCliResultPayload({
    identity: context.identity,
    outcome,
    summary: safeSummary,
    diagnostics: minimalDiagnostics,
    usage: {},
  });
  const minimalValidated = validateExecutorResult(context, minimalPayload);
  if (minimalValidated.ok) return minimalValidated.value;

  return {
    familyId: context.identity.familyId,
    goalId: context.identity.goalId,
    workflowId: context.identity.workflowId,
    revision: context.identity.revision,
    nodeId: context.identity.nodeId,
    attemptId: context.identity.attemptId,
    outcome,
    facts: [],
    evidence: [],
    artifacts: [],
    summary: safeSummary,
    diagnostics: maxDiagnostics === 0 ? [] : (
      minimalDiagnostics.length > 0
        ? minimalDiagnostics
        : [{
          code: "cli_result_construction_failed",
          message: "The CLI executor could not build a validated failure result.",
        }]
    ),
    usage: {},
  };
}

// ---------------------------------------------------------------------------
// Context materialization
// ---------------------------------------------------------------------------

export interface MaterializeCliContextInput {
  family: GoalFamilyRuntime;
  state: HypagraphState;
  nodeId: string;
  attemptId: string;
  /** Defaults to CLI_PROFILE. */
  profile?: ExecutorProfileRef;
  rootObjective?: string;
}

/**
 * Materialize a CLI context envelope for one running attempt.
 * Returns diagnostics when the family, state, or identity is incomplete.
 */
export function materializeCliContext(
  input: MaterializeCliContextInput,
): MaterializeExecutorContextResult {
  if (!isNonEmptyString(input.nodeId)) {
    return reject(
      "cli_invalid_node",
      "CLI context requires a non-empty nodeId.",
      "nodeId",
    );
  }
  if (!isNonEmptyString(input.attemptId)) {
    return reject(
      "cli_invalid_attempt",
      "CLI context requires a non-empty attemptId.",
      "attemptId",
    );
  }

  const goalId = input.state.goal?.goalId;
  if (!isNonEmptyString(goalId)) {
    return reject(
      "cli_goal_missing",
      "CLI context requires a started goal runtime on the workflow state.",
      "state.goal",
    );
  }

  const familyId = input.family.familyId;
  if (!isNonEmptyString(familyId)) {
    return reject(
      "cli_family_missing",
      "CLI context requires a non-empty familyId.",
      "family.familyId",
    );
  }

  const identity: ExecutorAttemptIdentity = {
    familyId,
    goalId,
    workflowId: input.state.workflowId,
    revision: input.state.revision,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
  };

  const profile = input.profile ?? CLI_PROFILE;
  return materializeExecutorContext({
    family: input.family,
    state: input.state,
    identity,
    profile,
    ...(input.rootObjective !== undefined ? { rootObjective: input.rootObjective } : {}),
  });
}

// ---------------------------------------------------------------------------
// Transport (testable)
// ---------------------------------------------------------------------------

/** Options for one CLI attempt run. */
export interface CliRunAttemptOptions {
  identity: ExecutorAttemptIdentity;
  adapter: NamedCliAdapterDefinition;
  context: ExecutorContextEnvelope;
  signal: AbortSignal;
  timeoutMs: number;
  /** Working directory for the child process. Absolute path preferred. */
  cwd?: string;
  /** Extra environment (already filtered by the executor). */
  env?: Record<string, string>;
  /**
   * Optional command override after security validation.
   * Defaults to adapter.command (and allowEnvBin resolution in child transport).
   */
  command?: string;
  /** Optional args override. Defaults to adapter.args. */
  args?: readonly string[];
}

/**
 * Injectable CLI transport for production and tests.
 * Implementations must spawn argv arrays only (shell: false).
 */
export interface CliTransport {
  /**
   * Run one attempt to completion, cancel, timeout, or process loss.
   * Returns an untrusted plain object (or throws typed transport errors).
   */
  runAttempt(options: CliRunAttemptOptions): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Executor factory and lifecycle
// ---------------------------------------------------------------------------

export interface CreateCliExecutorOptions {
  transport: CliTransport;
  /** Host-side process registry. Defaults to a new registry. */
  registry?: CliProcessRegistry;
  /**
   * Produce a process token for each attempt registration.
   * Defaults to a collision-proof random token. Injectable for tests.
   */
  createProcessToken?: (context: ExecutorContextEnvelope) => string;
  /**
   * Pure started-at timestamp supplier for registry records.
   * Defaults to a fixed placeholder; hosts must inject wall-clock when needed.
   */
  startedAt?: () => string;
  /** Working directory for the child process. */
  resolveCwd?: (context: ExecutorContextEnvelope) => string | undefined;
  /**
   * Optional extra environment. Keys are still filtered by the adapter allowlist.
   */
  resolveEnv?: (context: ExecutorContextEnvelope) => Record<string, string> | undefined;
  /**
   * Resolve the named adapter for this context.
   * Defaults to resolveCliAdapterNameFromProfile(context.profile).
   */
  resolveAdapterName?: (context: ExecutorContextEnvelope) => string;
  /**
   * Override attempt timeout in milliseconds.
   * When omitted, uses the adapter defaultTimeoutMs.
   */
  timeoutMs?: number;
}

/**
 * Create a CLI NodeExecutor for named adapters only.
 *
 * Lifecycle:
 * 1. Durable attempt identity comes from the context envelope.
 * 2. Resolve named adapter (fail closed when unknown).
 * 3. AbortSignal cancels the process when abort wins without a completed result.
 * 4. Parse CLI output into a plain object for validateExecutorResult.
 * 5. Host teardown maps restore/branch to interrupted and user/other to cancelled.
 *
 * execute always returns ExecutorResult for normal failure modes.
 * Controllers must still call settleExecutorResult before commit.
 */
export function createCliExecutor(
  options: CreateCliExecutorOptions,
): NodeExecutor {
  const registry = options.registry ?? new CliProcessRegistry();
  const createProcessToken = options.createProcessToken
    ?? ((context: ExecutorContextEnvelope) =>
      `cli-${context.identity.attemptId}-${randomUUID()}`);
  const startedAt = options.startedAt ?? (() => "1970-01-01T00:00:00.000Z");
  const resolveCwd = options.resolveCwd;
  const resolveEnv = options.resolveEnv;
  const resolveAdapterName = options.resolveAdapterName;
  const fixedTimeoutMs = options.timeoutMs;

  return {
    id: CLI_EXECUTOR_ID,
    version: CLI_EXECUTOR_VERSION,
    async execute(context: ExecutorContextEnvelope, signal: AbortSignal): Promise<ExecutorResult> {
      if (context.profile.kind !== "cli") {
        return resultFromCliContext(context, "failed", [{
          code: "cli_profile_mismatch",
          message:
            `CLI executor requires profile kind 'cli', got '${context.profile.kind}'.`,
          location: "context.profile.kind",
        }]);
      }

      if (signal.aborted) {
        return resultFromCliContext(context, "cancelled", [{
          code: "cli_aborted_before_start",
          message: "The CLI executor was aborted before process start.",
        }]);
      }

      let adapterName: string;
      try {
        if (resolveAdapterName) {
          adapterName = resolveAdapterName(context);
        } else {
          const resolved = resolveCliAdapterNameFromProfile(context.profile);
          if (!resolved.ok) {
            return resultFromCliContext(context, "failed", [{
              code: resolved.code,
              message: resolved.message,
              location: "context.profile",
            }]);
          }
          adapterName = resolved.name;
        }
      } catch (error) {
        return resultFromCliContext(context, "failed", [{
          code: "cli_adapter_resolve_failed",
          message: errorMessage(error, "CLI adapter name resolve failed."),
        }]);
      }

      if (!isNonEmptyString(adapterName)) {
        return resultFromCliContext(context, "failed", [{
          code: "cli_adapter_name_invalid",
          message: "resolveAdapterName must return a non-empty string.",
        }]);
      }

      const adapterLookup = getNamedCliAdapter(adapterName);
      if (!adapterLookup.ok) {
        return resultFromCliContext(context, "failed", [{
          code: adapterLookup.code,
          message: adapterLookup.message,
          location: "adapter.name",
        }]);
      }
      const adapter = adapterLookup.value;

      const timeoutResolved = resolveCliTimeoutMs(fixedTimeoutMs, adapter.defaultTimeoutMs);
      if (!timeoutResolved.ok) {
        return resultFromCliContext(context, "failed", [{
          code: timeoutResolved.code,
          message: timeoutResolved.message,
        }]);
      }

      let processToken: string;
      let cwd: string | undefined;
      let env: Record<string, string> | undefined;
      let startedAtValue: string;
      try {
        processToken = createProcessToken(context);
        if (!isNonEmptyString(processToken)) {
          return resultFromCliContext(context, "failed", [{
            code: "cli_invalid_process_token",
            message: "createProcessToken must return a non-empty string.",
          }]);
        }
        cwd = resolveCwd?.(context);
        if (adapter.cwdPolicy === "require-absolute") {
          // Fail closed when cwd is missing. Product hosts always inject cwd;
          // alternate hosts must not spawn without an absolute directory.
          if (cwd === undefined || !isNonEmptyString(cwd)) {
            return resultFromCliContext(context, "failed", [{
              code: "cli_cwd_required",
              message:
                "CLI adapter requires an absolute working directory path. "
                + "resolveCwd must return a non-empty absolute path.",
              location: "cwd",
            }]);
          }
          if (!isAbsolutePath(cwd)) {
            return resultFromCliContext(context, "failed", [{
              code: "cli_cwd_not_absolute",
              message:
                "CLI adapter requires an absolute working directory path.",
              location: "cwd",
            }]);
          }
        } else if (cwd !== undefined) {
          if (!isNonEmptyString(cwd)) {
            return resultFromCliContext(context, "failed", [{
              code: "cli_cwd_invalid",
              message: "resolveCwd must return a non-empty string when present.",
            }]);
          }
        }
        const rawEnv = resolveEnv?.(context);
        env = filterCliEnv(
          { ...process.env, ...(rawEnv ?? {}) },
          adapter.allowedEnvKeys,
          context.identity.attemptId,
        );
        startedAtValue = startedAt();
        if (!isNonEmptyString(startedAtValue)) {
          return resultFromCliContext(context, "failed", [{
            code: "cli_host_setup_failed",
            message: "startedAt must return a non-empty string.",
          }]);
        }
      } catch (error) {
        return resultFromCliContext(context, "failed", [{
          code: "cli_host_setup_failed",
          message: errorMessage(
            error,
            "CLI host setup failed before process start.",
          ),
        }]);
      }

      const registration = registry.register({
        processToken,
        adapterName: adapter.name,
        identity: structuredClone(context.identity),
        live: true,
        startedAt: startedAtValue,
      });
      if (!registration.ok) {
        if (registration.code === "cli_host_teardown" && registration.hostTeardown) {
          return resultFromCliHostTeardown(context, registration.hostTeardown);
        }
        return resultFromCliContext(context, "failed", [{
          code: registration.code,
          message: registration.message,
        }]);
      }

      registry.noteExecuteStarted(processToken);

      // Linked abort controller: host closer and external AbortSignal both stop work.
      // registry.closeOwned / closeAll invoke this closer so cancel and restore kill
      // the in-flight CLI process without requiring the product to abort the caller's signal.
      const attemptAbort = new AbortController();
      const stopAttempt = async (_reason: string): Promise<void> => {
        if (!attemptAbort.signal.aborted) {
          attemptAbort.abort();
        }
      };
      registry.setCloser(processToken, stopAttempt);

      let externalAbortListener: (() => void) | undefined;
      let attemptAbortListener: (() => void) | undefined;

      try {
        if (signal.aborted || attemptAbort.signal.aborted) {
          const teardown = registry.getHostTeardown(processToken);
          if (teardown) {
            return resultFromCliHostTeardown(context, teardown);
          }
          return resultFromCliContext(context, "cancelled", [{
            code: "cli_cancelled",
            message: "The CLI executor was aborted after registration.",
          }]);
        }

        // Forward call-site AbortSignal into the attempt controller.
        externalAbortListener = () => {
          if (!attemptAbort.signal.aborted) {
            attemptAbort.abort();
          }
        };
        signal.addEventListener("abort", externalAbortListener, { once: true });

        const abortPromise = new Promise<"aborted">((resolveAbort) => {
          if (attemptAbort.signal.aborted) {
            resolveAbort("aborted");
            return;
          }
          attemptAbortListener = () => resolveAbort("aborted");
          attemptAbort.signal.addEventListener("abort", attemptAbortListener, { once: true });
        });

        // Transport receives the linked signal so host closer terminates the process tree.
        const runPromise = options.transport.runAttempt({
          identity: structuredClone(context.identity),
          adapter,
          context,
          signal: attemptAbort.signal,
          timeoutMs: timeoutResolved.value,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(env !== undefined ? { env } : {}),
        }).then(
          (value) => ({ kind: "result" as const, value }),
          (error: unknown) => ({ kind: "error" as const, error }),
        );

        const raced = await Promise.race([
          runPromise,
          abortPromise.then((kind) => ({ kind })),
        ]);

        // Host teardown always wins over a late transport result so cancel/restore
        // cannot settle as submitted after the host closed the process.
        const hostTeardownNow = registry.getHostTeardown(processToken);
        if (hostTeardownNow) {
          return resultFromCliHostTeardown(context, hostTeardownNow);
        }

        // Completed result wins over concurrent call-site abort when no host teardown.
        if (raced.kind === "result") {
          const untrusted = parseCliTransportReply(raced.value);
          if (untrusted.kind === "transport_error") {
            return resultFromCliContext(context, "failed", [{
              code: untrusted.code,
              message: untrusted.message,
            }]);
          }
          if (untrusted.kind === "timed_out") {
            return resultFromCliContext(context, "timed_out", [{
              code: "cli_timeout",
              message: untrusted.message,
            }]);
          }
          if (untrusted.kind === "cancelled") {
            return resultFromCliContext(context, "cancelled", [{
              code: "cli_cancelled",
              message: untrusted.message,
            }]);
          }
          if (untrusted.kind === "process_lost") {
            return resultFromCliContext(context, "interrupted", [{
              code: "cli_process_lost",
              message: untrusted.message,
            }]);
          }
          if (untrusted.kind === "invalid") {
            return resultFromCliContext(context, "failed", [{
              code: untrusted.code ?? "cli_invalid_result",
              message: untrusted.message,
            }]);
          }

          const validated = validateExecutorResult(context, untrusted.value);
          if (!validated.ok) {
            const diagnostics: ExecutorDiagnostic[] = validated.diagnostics.map((item) => ({
              code: item.code,
              message: item.message,
              ...(item.location ? { location: item.location } : {}),
            }));
            const hasIdentityMismatch = validated.diagnostics.some(
              (item) => item.code === "executor_result_identity_mismatch",
            );
            if (hasIdentityMismatch) {
              diagnostics.unshift({
                code: "cli_stale_result",
                message:
                  "CLI result identity does not match the context envelope. Result rejected.",
              });
            }
            return resultFromCliContext(
              context,
              "failed",
              diagnostics,
              "CLI result failed validation.",
              normalizeCliUsage(
                isStrictPlainObject(untrusted.value)
                  ? (untrusted.value as Record<string, unknown>).usage
                  : {},
              ),
            );
          }

          // Attach non-fatal truncation diagnostic when the transport reported bounds.
          if (untrusted.stdoutTruncated || untrusted.stderrTruncated) {
            return mergeCliTruncationDiagnostics(
              validated.value,
              context.resultProtocol?.maxDiagnostics ?? 64,
              {
                stdoutTruncated: untrusted.stdoutTruncated === true,
                stderrTruncated: untrusted.stderrTruncated === true,
              },
            );
          }
          return validated.value;
        }

        if (raced.kind === "aborted" || attemptAbort.signal.aborted || signal.aborted) {
          const hostTeardownOnAbort = registry.getHostTeardown(processToken);
          if (hostTeardownOnAbort) {
            return resultFromCliHostTeardown(context, hostTeardownOnAbort);
          }
          return resultFromCliContext(context, "cancelled", [{
            code: "cli_cancelled",
            message: "The CLI attempt was cancelled by AbortSignal.",
          }]);
        }

        // raced.kind === "error"
        const hostTeardown = registry.getHostTeardown(processToken);
        if (hostTeardown) {
          return resultFromCliHostTeardown(context, hostTeardown);
        }
        const message = errorMessage(raced.error, "CLI process failed.");
        let code = "cli_transport_error";
        let outcome: ExecutorOutcome = "failed";
        if (isCliProcessLostError(raced.error)) {
          code = "cli_process_lost";
          outcome = "interrupted";
        } else if (isCliTimeoutError(raced.error)) {
          code = "cli_timeout";
          outcome = "timed_out";
        } else if (isCliAbortError(raced.error)) {
          code = "cli_cancelled";
          outcome = "cancelled";
        } else if (isCliSpawnError(raced.error)) {
          code = raced.error.code;
          outcome = "failed";
        }
        return resultFromCliContext(context, outcome, [{ code, message }]);
      } finally {
        if (externalAbortListener) {
          signal.removeEventListener("abort", externalAbortListener);
        }
        if (attemptAbortListener) {
          attemptAbort.signal.removeEventListener("abort", attemptAbortListener);
        }
        registry.markNotLive(processToken);
        registry.unregister(processToken);
        registry.noteExecuteFinished(processToken);
      }
    },
  };
}

/**
 * Host-initiated teardown (session restore / branch change / user cancel).
 * Outcome classification uses tombstone.kind only.
 * - restore | branch → interrupted
 * - user | other → cancelled
 */
function resultFromCliHostTeardown(
  context: ExecutorContextEnvelope,
  tombstone: Pick<CliHostTeardownTombstone, "kind" | "reason">,
): ExecutorResult {
  const interrupted = tombstone.kind === "restore" || tombstone.kind === "branch";
  let summary: string;
  if (tombstone.kind === "restore") {
    summary = "The host interrupted the CLI attempt during session restore.";
  } else if (tombstone.kind === "branch") {
    summary = "The host interrupted the CLI attempt during a branch change.";
  } else {
    summary = "The host cancelled the CLI attempt.";
  }
  return resultFromCliContext(
    context,
    interrupted ? "interrupted" : "cancelled",
    [{
      code: "cli_host_teardown",
      message: tombstone.reason,
      location: `hostTeardown.kind:${tombstone.kind}`,
    }],
    summary,
  );
}

/**
 * Run one CLI attempt and settle the result with the shared path.
 * Maps thrown execute errors to { ok: false, diagnostics }.
 */
export async function executeAndSettleCli(
  executor: NodeExecutor,
  context: ExecutorContextEnvelope,
  signal: AbortSignal,
  meta: SettleExecutorResultMeta,
): Promise<SettleExecutorResultResult> {
  if (context.profile.kind !== "cli") {
    return {
      ok: false,
      diagnostics: [{
        code: "cli_profile_mismatch",
        message:
          `executeAndSettleCli requires profile kind 'cli', got '${context.profile.kind}'.`,
        location: "context.profile.kind",
      }],
    };
  }
  let raw: unknown;
  try {
    raw = await executor.execute(context, signal);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: "cli_execute_threw",
        message: errorMessage(error, "The CLI executor threw during execute."),
      }],
    };
  }
  return settleExecutorResult(context, raw, meta);
}

/**
 * Settle an untrusted payload against an already materialized CLI context.
 */
export function settleCliResult(
  context: ExecutorContextEnvelope,
  untrustedResult: unknown,
  meta: SettleExecutorResultMeta,
): SettleExecutorResultResult {
  return settleExecutorResult(context, untrustedResult, meta);
}

// ---------------------------------------------------------------------------
// Fake transport (tests)
// ---------------------------------------------------------------------------

export interface FakeCliTransportOptions {
  /**
   * Produce the untrusted CLI reply for a runAttempt call.
   * May throw CliProcessLostError / CliTimeoutError / CliAbortError.
   */
  runAttempt: (
    options: CliRunAttemptOptions,
  ) => Promise<unknown>;
  /** When true or a message, runAttempt rejects before calling the hook. */
  failRun?: boolean | string;
}

/**
 * In-memory CLI transport for tests. Does not spawn a real process.
 */
export function createFakeCliTransport(
  options: FakeCliTransportOptions,
): CliTransport & {
  runs: CliRunAttemptOptions[];
} {
  const runs: CliRunAttemptOptions[] = [];

  return {
    runs,
    async runAttempt(runOptions: CliRunAttemptOptions): Promise<unknown> {
      // Clone non-function fields for inspection. Context is deep-cloned.
      runs.push({
        identity: structuredClone(runOptions.identity),
        adapter: cloneAdapter(runOptions.adapter),
        context: structuredClone(runOptions.context),
        signal: runOptions.signal,
        timeoutMs: runOptions.timeoutMs,
        ...(runOptions.cwd !== undefined ? { cwd: runOptions.cwd } : {}),
        ...(runOptions.env !== undefined ? { env: structuredClone(runOptions.env) } : {}),
        ...(runOptions.command !== undefined ? { command: runOptions.command } : {}),
        ...(runOptions.args !== undefined ? { args: [...runOptions.args] } : {}),
      });

      if (options.failRun) {
        const message = typeof options.failRun === "string"
          ? options.failRun
          : "Fake CLI transport failed to run the attempt.";
        throw new CliSpawnError("cli_spawn_failed", message);
      }
      if (runOptions.signal.aborted) {
        throw new CliAbortError("The CLI attempt was aborted before run.");
      }
      return options.runAttempt(runOptions);
    },
  };
}

// ---------------------------------------------------------------------------
// Production-shaped child-process transport
// ---------------------------------------------------------------------------

/**
 * Minimal process shape used by the CLI stdio transport.
 * Production uses child_process.spawn. Tests inject a scripted process.
 */
export interface CliSpawnedProcess {
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(event: "exit", listener: (...args: unknown[]) => void): this;
}

export interface ChildProcessCliTransportOptions {
  /**
   * When true, open fails if the binary is not configured via adapter command
   * or allowEnvBin. Default true.
   */
  requireBinary?: boolean;
  /** SIGTERM wait before SIGKILL, in milliseconds. Default 2000. */
  terminateGraceMs?: number;
  /** Final bound after SIGKILL before resolve, in milliseconds. Default 1000. */
  terminateForceMs?: number;
  /**
   * Injectable process factory for tests. When set, spawn is not used.
   * The factory receives resolved binary and args. shell must stay false.
   */
  createProcess?: (input: {
    command: string;
    args: string[];
    cwd?: string;
    env: NodeJS.ProcessEnv;
  }) => CliSpawnedProcess;
}

/**
 * Child-process transport for named CLI adapters.
 *
 * Flow:
 * 1. resolve binary (adapter.command or allowEnvBin);
 * 2. validate binary path (no shell metacharacters, no path traversal);
 * 3. spawn with shell: false and argv array only;
 * 4. write context to stdin when format is stdin-json;
 * 5. collect bounded stdout and stderr;
 * 6. race process exit against timeout and AbortSignal;
 * 7. parse structured ExecutorResult from stdout;
 * 8. terminate process tree on cancel or timeout.
 */
export function createChildProcessCliTransport(
  options: ChildProcessCliTransportOptions = {},
): CliTransport {
  const requireBinary = options.requireBinary ?? true;
  const terminateGraceMs = options.terminateGraceMs ?? 2_000;
  const terminateForceMs = options.terminateForceMs ?? 1_000;

  return {
    async runAttempt(runOptions: CliRunAttemptOptions): Promise<unknown> {
      if (runOptions.signal.aborted) {
        throw new CliAbortError("The CLI attempt was aborted before process start.");
      }

      const adapter = runOptions.adapter;
      let command = runOptions.command ?? adapter.command;
      if (adapter.allowEnvBin && !runOptions.command) {
        const fromEnv = process.env[adapter.allowEnvBin];
        if (isNonEmptyString(fromEnv)) {
          command = fromEnv;
        }
      }

      const pathCheck = validateCliBinaryPath(command);
      if (!pathCheck.ok) {
        throw new CliSpawnError(pathCheck.code, pathCheck.message);
      }

      if (
        requireBinary
        && !options.createProcess
        && command === adapter.command
        && adapter.allowEnvBin
        && !isNonEmptyString(process.env[adapter.allowEnvBin])
        && !command.includes("/")
      ) {
        // Basename-only default without env override: fail closed with a clear code.
        throw new CliSpawnError(
          "cli_binary_not_configured",
          `CLI binary is not configured for adapter '${adapter.name}'. `
          + `Set ${adapter.allowEnvBin} to an absolute binary path.`,
        );
      }

      const args = [...(runOptions.args ?? adapter.args)];
      for (const arg of args) {
        if (typeof arg !== "string") {
          throw new CliSpawnError(
            "cli_args_invalid",
            "CLI adapter args must be an array of strings.",
          );
        }
      }

      const env: NodeJS.ProcessEnv = {
        ...(runOptions.env ?? {}),
      };

      let child: CliSpawnedProcess;
      try {
        if (options.createProcess) {
          child = options.createProcess({
            command,
            args,
            ...(runOptions.cwd !== undefined ? { cwd: runOptions.cwd } : {}),
            env,
          });
        } else {
          // shell: false is mandatory. Never pass a user shell string.
          const spawned = spawn(command, args, {
            cwd: runOptions.cwd,
            env,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }) as ChildProcessWithoutNullStreams;
          child = spawned as unknown as CliSpawnedProcess;
        }
      } catch (error) {
        throw new CliSpawnError(
          "cli_spawn_failed",
          errorMessage(error, `Failed to spawn CLI binary '${command}'.`),
        );
      }

      let lastChildError: Error | undefined;
      let sessionLost = false;
      let terminated = false;

      child.on("error", (error: Error) => {
        lastChildError = error;
        sessionLost = true;
      });

      if (child.pid === undefined && !options.createProcess) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        throw new CliSpawnError(
          "cli_spawn_failed",
          errorMessage(
            lastChildError,
            `Failed to spawn CLI binary '${command}'.`,
          ),
        );
      }

      if (!child.stdout || !child.stderr || !child.stdin) {
        throw new CliSpawnError(
          "cli_spawn_failed",
          `Failed to spawn CLI binary '${command}' (stdio not available).`,
        );
      }

      const maxStdout = adapter.maxStdoutBytes;
      const maxStderr = adapter.maxStderrBytes;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutBytes >= maxStdout) {
          stdoutTruncated = true;
          return;
        }
        const remaining = maxStdout - stdoutBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        if (chunk.length > remaining) stdoutTruncated = true;
        stdoutChunks.push(Buffer.from(slice));
        stdoutBytes += slice.length;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes >= maxStderr) {
          stderrTruncated = true;
          return;
        }
        const remaining = maxStderr - stderrBytes;
        const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        if (chunk.length > remaining) stderrTruncated = true;
        stderrChunks.push(Buffer.from(slice));
        stderrBytes += slice.length;
      });
      child.stdout.on("error", () => {
        // ignore stream errors; exit/error handlers decide outcome
      });
      child.stderr.on("error", () => {
        // ignore
      });
      child.stdin.on("error", () => {
        sessionLost = true;
      });

      // Serialize and write context input.
      const serialized = serializeCliContextInput(
        runOptions.context,
        adapter.contextFormat,
      );
      if (!serialized.ok) {
        await terminateCliChild(child, terminateGraceMs, terminateForceMs);
        throw new CliSpawnError(serialized.code, serialized.message);
      }

      try {
        child.stdin.write(serialized.value);
        child.stdin.end();
      } catch (error) {
        await terminateCliChild(child, terminateGraceMs, terminateForceMs);
        throw new CliProcessLostError(
          errorMessage(error, "Failed to write CLI context to stdin."),
        );
      }

      const exitPromise = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.once("exit", (code, exitSignal) => {
          resolve({ code, signal: exitSignal });
        });
      });

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), runOptions.timeoutMs);
      });

      const abortPromise = new Promise<"aborted">((resolve) => {
        if (runOptions.signal.aborted) {
          resolve("aborted");
          return;
        }
        runOptions.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      });

      try {
        const raced = await Promise.race([
          exitPromise.then((exit) => ({ kind: "exit" as const, exit })),
          timeoutPromise.then((kind) => ({ kind })),
          abortPromise.then((kind) => ({ kind })),
        ]);

        if (raced.kind === "timeout") {
          terminated = true;
          await terminateCliChild(child, terminateGraceMs, terminateForceMs);
          throw new CliTimeoutError(
            `CLI process timed out after ${runOptions.timeoutMs}ms.`,
          );
        }

        if (raced.kind === "aborted") {
          terminated = true;
          await terminateCliChild(child, terminateGraceMs, terminateForceMs);
          throw new CliAbortError("The CLI process was cancelled by AbortSignal.");
        }

        // exit
        if (sessionLost || lastChildError) {
          throw new CliProcessLostError(
            errorMessage(
              lastChildError,
              "The CLI process reported an error before exit.",
            ),
          );
        }

        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const exitCode = raced.exit.code;

        if (adapter.resultFormat === "stdout-json") {
          const parsed = parseCliResultOutput(stdout, "stdout-json");
          if (!parsed.ok) {
            // Non-zero exit without structured result is a failed transport parse.
            const detail = stderr.trim().length > 0
              ? ` stderr: ${stderr.trim().slice(0, 512)}`
              : "";
            const exitDetail = exitCode !== null && exitCode !== 0
              ? ` Process exit code was ${exitCode}.`
              : "";
            return {
              [CLI_TRANSPORT_SIGNAL]: true,
              type: "invalid",
              code: parsed.code,
              message: `${parsed.message}${exitDetail}${detail}`,
              stdoutTruncated,
              stderrTruncated,
            };
          }

          // Attach truncation flags as Symbol so agents cannot forge them via JSON.
          return markCliOutputTruncation(parsed.value, {
            stdoutTruncated,
            stderrTruncated,
          });
        }

        return {
          [CLI_TRANSPORT_SIGNAL]: true,
          type: "invalid",
          code: "cli_result_format_unknown",
          message: `Unknown CLI result format '${adapter.resultFormat}'.`,
        };
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        if (!terminated) {
          // Ensure the process is gone even if it already exited (idempotent).
          await terminateCliChild(child, terminateGraceMs, terminateForceMs);
        }
      }
    },
  };
}

async function terminateCliChild(
  child: CliSpawnedProcess,
  graceMs: number,
  forceMs: number,
): Promise<void> {
  try {
    if (isNodeChildProcess(child)) {
      await terminateChildProcessTree(child, { graceMs, forceMs });
      return;
    }
    // Scripted test process: best-effort kill.
    if (child.exitCode === null && child.signalCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  } catch {
    // best effort
  }
}

function isNodeChildProcess(value: CliSpawnedProcess): value is ChildProcess & CliSpawnedProcess {
  return typeof (value as ChildProcess).pid === "number"
    || Object.prototype.hasOwnProperty.call(value, "stdio");
}

// ---------------------------------------------------------------------------
// Transport reply parsing
// ---------------------------------------------------------------------------

/** Module-private Symbol key for transport signals (not forgeable in JSON). */
const CLI_TRANSPORT_SIGNAL = Symbol("hypagraph.cli.transport_signal");

/** Module-private flags for output truncation. */
const CLI_STDOUT_TRUNCATED = Symbol("hypagraph.cli.stdout_truncated");
const CLI_STDERR_TRUNCATED = Symbol("hypagraph.cli.stderr_truncated");

function markCliOutputTruncation(
  value: Record<string, unknown>,
  flags: { stdoutTruncated: boolean; stderrTruncated: boolean },
): Record<string | symbol, unknown> {
  const next: Record<string | symbol, unknown> = { ...value };
  if (flags.stdoutTruncated) next[CLI_STDOUT_TRUNCATED] = true;
  if (flags.stderrTruncated) next[CLI_STDERR_TRUNCATED] = true;
  return next;
}

type ParsedCliReply =
  | {
    kind: "result";
    value: Record<string, unknown>;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
  }
  | { kind: "transport_error"; code: string; message: string }
  | { kind: "timed_out"; message: string }
  | { kind: "cancelled"; message: string }
  | { kind: "process_lost"; message: string }
  | { kind: "invalid"; code?: string; message: string };

/**
 * Parse a CLI transport reply into a validation candidate.
 * Transport sentinels use a module-private Symbol and cannot be forged in JSON.
 */
export function parseCliTransportReply(value: unknown): ParsedCliReply {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const asRecord = value as Record<string | symbol, unknown>;
    if (asRecord[CLI_TRANSPORT_SIGNAL] === true) {
      const type = asRecord.type;
      const message = isNonEmptyString(asRecord.message)
        ? asRecord.message
        : "The CLI transport reported an error without a message.";
      if (type === "error") {
        const code = isNonEmptyString(asRecord.code) ? asRecord.code : "cli_transport_error";
        return { kind: "transport_error", code, message };
      }
      if (type === "timed_out") {
        return { kind: "timed_out", message };
      }
      if (type === "cancelled") {
        return { kind: "cancelled", message };
      }
      if (type === "process_lost") {
        return { kind: "process_lost", message };
      }
      if (type === "invalid") {
        return {
          kind: "invalid",
          ...(isNonEmptyString(asRecord.code) ? { code: asRecord.code } : {}),
          message,
        };
      }
    }
  }

  if (!isStrictPlainObject(value) && !(
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      (value as Record<string | symbol, unknown>)[CLI_STDOUT_TRUNCATED] === true
      || (value as Record<string | symbol, unknown>)[CLI_STDERR_TRUNCATED] === true
    )
  )) {
    if (typeof value === "string") {
      const parsed = parseCliResultOutput(value, "stdout-json");
      if (!parsed.ok) {
        return { kind: "invalid", code: parsed.code, message: parsed.message };
      }
      return { kind: "result", value: parsed.value };
    }
    return {
      kind: "invalid",
      code: "cli_invalid_result",
      message:
        "The CLI process did not return a plain object result. "
        + "Raw text is not a valid canonical result.",
    };
  }

  const stdoutTruncated = value !== null
    && typeof value === "object"
    && (value as Record<string | symbol, unknown>)[CLI_STDOUT_TRUNCATED] === true;
  const stderrTruncated = value !== null
    && typeof value === "object"
    && (value as Record<string | symbol, unknown>)[CLI_STDERR_TRUNCATED] === true;

  // Build a plain copy (Symbols dropped by Object.entries / spread of string keys).
  const asPlain: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if (!isStrictPlainObject(asPlain) && Object.keys(asPlain).length === 0 && !stdoutTruncated && !stderrTruncated) {
    return {
      kind: "invalid",
      code: "cli_invalid_result",
      message: "The CLI process did not return a plain object result.",
    };
  }

  // Class instances without our truncation Symbols are invalid.
  if (!isStrictPlainObject(value) && !stdoutTruncated && !stderrTruncated) {
    return {
      kind: "invalid",
      code: "cli_invalid_result",
      message:
        "The CLI process did not return a plain object result. "
        + "Class instances are not valid ExecutorResult payloads.",
    };
  }

  return {
    kind: "result",
    value: asPlain,
    ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
    ...(stderrTruncated ? { stderrTruncated: true } : {}),
  };
}

const STDOUT_TRUNCATION_DIAGNOSTIC: ExecutorDiagnostic = {
  code: "cli_stdout_truncated",
  message:
    "CLI stdout exceeded the adapter maxStdoutBytes bound. "
    + "Output was truncated before result parse.",
};

const STDERR_TRUNCATION_DIAGNOSTIC: ExecutorDiagnostic = {
  code: "cli_stderr_truncated",
  message:
    "CLI stderr exceeded the adapter maxStderrBytes bound. "
    + "Stderr was truncated for diagnostics.",
};

/**
 * Merge non-fatal truncation diagnostics onto an already validated result.
 */
export function mergeCliTruncationDiagnostics(
  result: ExecutorResult,
  maxDiagnostics: number,
  flags: { stdoutTruncated: boolean; stderrTruncated: boolean },
): ExecutorResult {
  const max = Number.isSafeInteger(maxDiagnostics) && maxDiagnostics >= 0
    ? maxDiagnostics
    : 0;
  if (max === 0) return result;

  const existing = result.diagnostics.map((item) => structuredClone(item));
  const toAdd: ExecutorDiagnostic[] = [];
  if (
    flags.stdoutTruncated
    && !existing.some((item) => item.code === "cli_stdout_truncated")
  ) {
    toAdd.push(structuredClone(STDOUT_TRUNCATION_DIAGNOSTIC));
  }
  if (
    flags.stderrTruncated
    && !existing.some((item) => item.code === "cli_stderr_truncated")
  ) {
    toAdd.push(structuredClone(STDERR_TRUNCATION_DIAGNOSTIC));
  }
  if (toAdd.length === 0) return result;

  for (const diagnostic of toAdd) {
    if (existing.length < max) {
      existing.push(diagnostic);
    } else {
      existing[max - 1] = diagnostic;
    }
  }
  return {
    ...result,
    diagnostics: existing,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error that signals the CLI process is no longer reachable.
 * The adapter maps this to outcome "interrupted" and diagnostic cli_process_lost.
 */
export class CliProcessLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliProcessLostError";
  }
}

/**
 * Structured spawn failure with a stable diagnostic code.
 */
export class CliSpawnError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CliSpawnError";
    this.code = code;
  }
}

/**
 * Abort during CLI run. Maps to cancelled.
 */
export class CliAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliAbortError";
  }
}

/**
 * Wall-clock timeout. Maps to outcome timed_out.
 */
export class CliTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isStrictPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAbsolutePath(value: string): boolean {
  // POSIX absolute or Windows drive / UNC.
  return value.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith("\\\\");
}

function reject(code: string, message: string, location?: string): { ok: false; diagnostics: Diagnostic[] } {
  return {
    ok: false,
    diagnostics: [{ code, message, ...(location ? { location } : {}) }],
  };
}

function defaultSummaryForOutcome(outcome: ExecutorOutcome): string {
  switch (outcome) {
    case "submitted":
      return "The CLI executor submitted a structured result.";
    case "failed":
      return "The CLI executor reported failure.";
    case "cancelled":
      return "The CLI executor cancelled the attempt.";
    case "timed_out":
      return "The CLI executor timed out.";
    case "interrupted":
      return "The CLI executor was interrupted.";
    default:
      return "The CLI executor completed.";
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && isNonEmptyString(error.message)) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return fallback;
}

function isCliProcessLostError(error: unknown): boolean {
  return error instanceof CliProcessLostError
    || (error instanceof Error && error.name === "CliProcessLostError");
}

function isCliTimeoutError(error: unknown): boolean {
  return error instanceof CliTimeoutError
    || (error instanceof Error && error.name === "CliTimeoutError");
}

function isCliAbortError(error: unknown): boolean {
  return error instanceof CliAbortError
    || (error instanceof Error && error.name === "CliAbortError");
}

function isCliSpawnError(error: unknown): error is CliSpawnError {
  return error instanceof CliSpawnError
    || (
      error instanceof Error
      && error.name === "CliSpawnError"
      && typeof (error as CliSpawnError).code === "string"
    );
}
