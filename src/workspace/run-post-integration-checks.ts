/**
 * Host runner for post-integration checks in the base workspace (M8-s6).
 *
 * Flow:
 * 1. Validate the integration set and check command list (pure domain).
 * 2. Prove baseRepoPath is a main git workspace (not a linked worktree).
 * 3. Require status integrated (first start). Status checking needs allowResume
 *    for crash recovery when the caller asserts no host runner is active.
 * 4. Reject checks_failed. Treat checks_passed with matching identity as success.
 * 5. Mark checking and optional persist before any external command runs.
 * 6. Verify base HEAD still equals integratedCommitHash after marking checking.
 * 7. Run each check command with cwd set to the base repository top-level.
 * 8. Mark checks_passed on full success, or checks_failed with diagnostics.
 *
 * Checks run only in the base workspace. They never use a linked worker
 * worktree as cwd. This module may spawn processes and read paths. It never
 * mutates canonical graph or family state.
 *
 * Execution success, integration success, and post-integration check success
 * remain separate.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { Diagnostic } from "../domain/model.js";
import {
  getIntegration,
  isIntegrationEligibleForNodeCompletion,
  parseWorkspaceIntegrationExpectedIdentity,
  validateIntegrationIdentity,
  WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION,
  type WorkspaceIntegration,
  type WorkspaceIntegrationExpectedIdentity,
  type WorkspaceIntegrationSet,
} from "../domain/workspace-integration.js";
import {
  canStartPostIntegrationChecks,
  completePostIntegrationChecksFailed,
  completePostIntegrationChecksPassed,
  DEFAULT_POST_CHECK_TIMEOUT_MS,
  parsePostIntegrationCheckList,
  startPostIntegrationChecks,
  type PostIntegrationCheckCommand,
  type PostIntegrationCheckList,
  type PostIntegrationCheckListBounds,
} from "../domain/workspace-post-integration-checks.js";
import {
  decodeGitTextLine,
  runGit,
} from "./worker-commit.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_KILL_GRACE_MS = 1_000;
const POST_CHECK_UTF8_CODE = "workspace_post_check_invalid_utf8";

const DEFAULT_ENV_NAMES = process.platform === "win32"
  ? ["Path", "PATHEXT", "SystemRoot", "COMSPEC", "TEMP", "TMP"]
  : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type RunPostIntegrationChecksResult =
  | {
    ok: true;
    set: WorkspaceIntegrationSet;
    integration: WorkspaceIntegration;
    /**
     * True only when integration status is checks_passed.
     * Controllers must also call requireChecksPassedForNodeCompletion.
     */
    eligibleForNodeCompletion: true;
    /** True when status was already checks_passed and no commands re-ran. */
    alreadyPassed?: boolean;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
    set: WorkspaceIntegrationSet;
    integration?: WorkspaceIntegration;
    /** Always false on failure. Status is not checks_passed. */
    eligibleForNodeCompletion: false;
  };

export interface RunPostIntegrationChecksInput {
  /** Absolute or relative path to the base git repository (main worktree). */
  baseRepoPath: string;
  /** Current pure integration registry. Not mutated. */
  set: WorkspaceIntegrationSet;
  /**
   * Integration id that must already be integrated.
   * Status checking is accepted only when allowResume is true.
   */
  integrationId: string;
  /**
   * Check commands or a versioned check list.
   * The host always runs them with cwd = resolved base top-level.
   */
  checks: PostIntegrationCheckCommand[] | PostIntegrationCheckList | unknown;
  /** Optional identity for stale-result rejection. */
  expected?: WorkspaceIntegrationExpectedIdentity;
  /** Optional bounds for check list validation. */
  bounds?: PostIntegrationCheckListBounds;
  /**
   * Optional durable-intent callback. Awaited after the set transitions to
   * checking and before HEAD verification and post-integration check commands.
   */
  persist?: (set: WorkspaceIntegrationSet) => Promise<void> | void;
  signal?: AbortSignal;
  /** Maximum captured stdout+stderr bytes per command. */
  maxOutputBytes?: number;
  /** Grace period after SIGTERM before SIGKILL. */
  killGraceMs?: number;
  /**
   * Crash recovery only. When true, permit re-entry from status checking after
   * the caller asserts that no host runner is active for this integration.
   * Default false. Must not be set for concurrent host runners.
   */
  allowResume?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const reject = (code: string, message: string, location?: string): Diagnostic => ({
  code,
  message,
  ...(location !== undefined ? { location } : {}),
});

function resolveBaseRepoPath(
  pathValue: string,
): { ok: true; path: string } | { ok: false; diagnostic: Diagnostic } {
  if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
    return {
      ok: false,
      diagnostic: reject(
        "workspace_post_check_invalid_base_path",
        "baseRepoPath must be a non-empty path.",
        "baseRepoPath",
      ),
    };
  }
  try {
    return { ok: true, path: resolve(pathValue) };
  } catch {
    return {
      ok: false,
      diagnostic: reject(
        "workspace_post_check_invalid_base_path",
        "baseRepoPath could not be resolved.",
        "baseRepoPath",
      ),
    };
  }
}

function inheritedEnvironment(): NodeJS.ProcessEnv {
  const sourceNames = Object.keys(process.env);
  const result: NodeJS.ProcessEnv = {
    LC_ALL: "C",
    LANG: "C",
  };
  for (const requestedName of DEFAULT_ENV_NAMES) {
    const sourceName = process.platform === "win32"
      ? sourceNames.find((name) => name.toUpperCase() === requestedName.toUpperCase())
      : requestedName;
    if (!sourceName) continue;
    const value = process.env[sourceName];
    if (value !== undefined) result[sourceName] = value;
  }
  return result;
}

function mapGitDiag(
  failure: Extract<Awaited<ReturnType<typeof runGit>>, { ok: false }>,
  location: string,
  detail: string,
): Diagnostic {
  if (failure.kind === "aborted") {
    return reject(
      "workspace_post_check_aborted",
      "The post-integration check was cancelled.",
      "signal",
    );
  }
  if (failure.kind === "output_limit") {
    return reject(
      "workspace_post_check_git_output_limit",
      failure.message,
      location,
    );
  }
  if (failure.kind === "process") {
    return reject(
      "workspace_post_check_git_process",
      `${detail}: ${failure.message}`,
      location,
    );
  }
  return reject(
    "workspace_post_check_git_failed",
    `${detail}: ${failure.message}`,
    location,
  );
}

/**
 * Prove baseRepoPath is a main git worktree top-level (not a linked worktree).
 * Returns the canonical top-level path for use as check cwd.
 */
async function resolveAndValidateBaseWorkspace(
  baseRepoPath: string,
  signal?: AbortSignal,
): Promise<
  | { ok: true; baseCwd: string }
  | { ok: false; diagnostics: Diagnostic[] }
> {
  const pathResolved = resolveBaseRepoPath(baseRepoPath);
  if (!pathResolved.ok) {
    return { ok: false, diagnostics: [pathResolved.diagnostic] };
  }

  let baseCwd: string;
  try {
    baseCwd = await realpath(pathResolved.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_post_check_invalid_base_path",
        `Could not resolve the canonical base repository path: ${message}`,
        "baseRepoPath",
      )],
    };
  }

  const inside = await runGit(
    baseCwd,
    ["rev-parse", "--is-inside-work-tree"],
    signal,
  );
  if (!inside.ok) {
    return {
      ok: false,
      diagnostics: [mapGitDiag(inside, "baseRepoPath", "Base path is not a git repository")],
    };
  }
  const insideText = decodeGitTextLine(
    inside.raw,
    "baseRepoPath",
    "workspace_post_check_not_git_repo",
    "Base path is not a git work tree.",
    POST_CHECK_UTF8_CODE,
  );
  if (!insideText.ok) {
    return { ok: false, diagnostics: [insideText.diagnostic] };
  }
  if (insideText.text !== "true") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_post_check_not_git_repo",
        "Base path is not a git work tree.",
        "baseRepoPath",
      )],
    };
  }

  const baseTop = await runGit(baseCwd, ["rev-parse", "--show-toplevel"], signal);
  if (!baseTop.ok) {
    return {
      ok: false,
      diagnostics: [mapGitDiag(baseTop, "baseRepoPath", "Could not resolve base git top-level")],
    };
  }
  const topDecoded = decodeGitTextLine(
    baseTop.raw,
    "baseRepoPath",
    "workspace_post_check_not_git_repo",
    "Base git top-level was empty.",
    POST_CHECK_UTF8_CODE,
  );
  if (!topDecoded.ok) {
    return { ok: false, diagnostics: [topDecoded.diagnostic] };
  }
  try {
    baseCwd = await realpath(topDecoded.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_post_check_invalid_base_path",
        `Could not resolve the canonical base top-level path: ${message}`,
        "baseRepoPath",
      )],
    };
  }

  // Linked worktrees have a different git-dir from git-common-dir.
  // The main base workspace must use the shared common dir as its git-dir.
  const gitDirResult = await runGit(baseCwd, ["rev-parse", "--absolute-git-dir"], signal);
  if (!gitDirResult.ok) {
    return {
      ok: false,
      diagnostics: [mapGitDiag(gitDirResult, "baseRepoPath", "Could not resolve git-dir")],
    };
  }
  const gitDirDecoded = decodeGitTextLine(
    gitDirResult.raw,
    "baseRepoPath",
    "workspace_post_check_git_failed",
    "Git-dir was empty.",
    POST_CHECK_UTF8_CODE,
  );
  if (!gitDirDecoded.ok) {
    return { ok: false, diagnostics: [gitDirDecoded.diagnostic] };
  }

  const commonDirResult = await runGit(
    baseCwd,
    ["rev-parse", "--git-common-dir"],
    signal,
  );
  if (!commonDirResult.ok) {
    return {
      ok: false,
      diagnostics: [mapGitDiag(
        commonDirResult,
        "baseRepoPath",
        "Could not resolve git-common-dir",
      )],
    };
  }
  const commonDecoded = decodeGitTextLine(
    commonDirResult.raw,
    "baseRepoPath",
    "workspace_post_check_git_failed",
    "Git-common-dir was empty.",
    POST_CHECK_UTF8_CODE,
  );
  if (!commonDecoded.ok) {
    return { ok: false, diagnostics: [commonDecoded.diagnostic] };
  }

  let gitDirAbs: string;
  let commonDirAbs: string;
  try {
    gitDirAbs = await realpath(resolve(baseCwd, gitDirDecoded.text));
  } catch {
    gitDirAbs = resolve(baseCwd, gitDirDecoded.text);
  }
  try {
    commonDirAbs = await realpath(resolve(baseCwd, commonDecoded.text));
  } catch {
    commonDirAbs = resolve(baseCwd, commonDecoded.text);
  }

  if (gitDirAbs !== commonDirAbs) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_post_check_base_is_linked_worktree",
        "baseRepoPath must be the main base git workspace. "
          + "A linked worker worktree is not valid for post-integration checks.",
        "baseRepoPath",
      )],
    };
  }

  return { ok: true, baseCwd };
}

/**
 * Require the base worktree to have no uncommitted tracked changes.
 * Untracked files are ignored (matches integration pre-check policy).
 */
async function assertBaseWorktreeTrackedClean(
  baseCwd: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; diagnostics: Diagnostic[] }> {
  const porcelain = await runGit(
    baseCwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=no"],
    signal,
  );
  if (!porcelain.ok) {
    return {
      ok: false,
      diagnostics: [mapGitDiag(
        porcelain,
        "baseRepoPath",
        "Could not read base worktree status",
      )],
    };
  }
  if (porcelain.raw.length > 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_post_check_base_dirty",
        "Base worktree has uncommitted tracked changes after post-integration checks.",
        "baseRepoPath",
      )],
    };
  }
  return { ok: true };
}

/**
 * Read base HEAD and require it to match the integrated commit hash.
 */
async function assertBaseHeadMatchesIntegrated(
  baseCwd: string,
  integratedCommitHash: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; diagnostics: Diagnostic[] }> {
  const headResult = await runGit(
    baseCwd,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    signal,
  );
  if (!headResult.ok) {
    return {
      ok: false,
      diagnostics: [mapGitDiag(headResult, "baseRepoPath", "Could not resolve base HEAD")],
    };
  }
  const decoded = decodeGitTextLine(
    headResult.raw,
    "baseRepoPath",
    "workspace_post_check_git_failed",
    "Resolved base HEAD was empty.",
    POST_CHECK_UTF8_CODE,
  );
  if (!decoded.ok) {
    return { ok: false, diagnostics: [decoded.diagnostic] };
  }
  const head = decoded.text.toLowerCase();
  const expected = integratedCommitHash.trim().toLowerCase();
  if (head !== expected) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_post_check_stale_base_head",
        `Base HEAD '${head}' does not match integratedCommitHash '${expected}'. `
          + "Post-integration checks require the base workspace at the integrated commit.",
        "baseRepoPath",
      )],
    };
  }
  return { ok: true };
}

type CommandRunResult =
  | { ok: true; exitCode: number; stdout: string; stderr: string }
  | {
    ok: false;
    kind: "aborted" | "timeout" | "process" | "exit";
    message: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  };

/**
 * Resolve maxOutputBytes as a non-negative safe integer.
 * Combined limit for stdout and stderr of one command.
 */
export function resolveMaxOutputBytes(
  value: number | undefined,
): { ok: true; value: number } | { ok: false; diagnostic: Diagnostic } {
  if (value === undefined) {
    return { ok: true, value: DEFAULT_MAX_OUTPUT_BYTES };
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return {
      ok: false,
      diagnostic: reject(
        "workspace_post_check_invalid_max_output_bytes",
        "maxOutputBytes must be a non-negative safe integer when present.",
        "maxOutputBytes",
      ),
    };
  }
  return { ok: true, value };
}

/**
 * Terminate a check process and its descendants.
 * On POSIX, the child starts as a process group leader (detached).
 * A negative pid signals the whole group. On Windows, taskkill /T ends the tree.
 * groupPid must be the original process-group leader pid when the direct child
 * has already exited (child.pid may still be set, but callers must capture it
 * at kill time so SIGKILL still targets the group after leader exit).
 * Falls back to child.kill when group kill is unavailable.
 */
function killCheckProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  groupPid?: number,
): void {
  const pid = groupPid ?? child.pid;
  if (typeof pid !== "number") return;

  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
      return;
    } catch {
      // Fall through to child.kill.
    }
  } else {
    try {
      // Negative pid: signal the process group owned by the detached child.
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to child.kill.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // Process may already have exited.
  }
}

/**
 * Run one check command with cwd fixed to baseCwd.
 * Does not use a shell. Does not pass AbortSignal to spawn (host owns shutdown).
 * Always waits for the child close event.
 * On abort/timeout, keeps process-group SIGKILL until the grace period elapses
 * even when the direct child closes earlier (descendants may ignore SIGTERM).
 * The force-kill timer stays referenced so the event loop cannot exit before
 * SIGKILL runs. Awaiting the force-kill promise alone does not keep the loop
 * alive when the timer is unref'd.
 * Captures stdout and stderr under one shared maxOutputBytes limit.
 * Starts the child in an owned process group on POSIX so timeout and cancel
 * terminate the complete process tree.
 */
export async function runBaseWorkspaceCheckCommand(
  baseCwd: string,
  check: PostIntegrationCheckCommand,
  options?: {
    signal?: AbortSignal;
    maxOutputBytes?: number;
    killGraceMs?: number;
  },
): Promise<CommandRunResult> {
  const signal = options?.signal;
  if (signal?.aborted) {
    return {
      ok: false,
      kind: "aborted",
      message: "The post-integration check was cancelled.",
    };
  }

  const maxResolved = resolveMaxOutputBytes(options?.maxOutputBytes);
  if (!maxResolved.ok) {
    return {
      ok: false,
      kind: "process",
      message: maxResolved.diagnostic.message,
    };
  }
  const maxOutputBytes = maxResolved.value;
  const killGraceMs = options?.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const timeoutMs = check.timeoutMs ?? DEFAULT_POST_CHECK_TIMEOUT_MS;
  const args = check.args ?? [];

  let child: ChildProcess;
  try {
    // Do not attach AbortSignal to spawn. Host owns SIGTERM/SIGKILL so an
    // AbortError cannot bypass process shutdown.
    // On POSIX, detached makes the child a process group leader so timeout
    // and cancel can terminate descendants. stdio pipes keep the parent
    // linked until close. Do not unref the child.
    child = spawn(check.command, args, {
      cwd: baseCwd,
      env: inheritedEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "process",
      message,
    };
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  // One shared byte counter for stdout and stderr combined.
  let totalBytes = 0;

  const append = (target: Buffer[], chunk: Buffer): void => {
    if (totalBytes >= maxOutputBytes) return;
    const accepted = chunk.subarray(0, maxOutputBytes - totalBytes);
    if (accepted.length === 0) return;
    target.push(Buffer.from(accepted));
    totalBytes += accepted.length;
  };

  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer) => {
      append(stdoutChunks, chunk);
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      append(stderrChunks, chunk);
    });
  }

  let termination: "timed_out" | "cancelled" | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let forceKillDone: Promise<void> | undefined;
  let groupPid: number | undefined;
  let spawnError: Error | undefined;

  const stop = (reason: "timed_out" | "cancelled"): void => {
    if (termination) return;
    termination = reason;
    // Capture the process-group leader pid before any exit clears group state.
    if (typeof child.pid === "number") {
      groupPid = child.pid;
    }
    killCheckProcessTree(child, "SIGTERM", groupPid);
    // Keep process-group SIGKILL until the grace period elapses.
    // Do not clear this timer when the direct child closes early: a descendant
    // can ignore SIGTERM and keep independent stdio open.
    // Do not unref the force-kill timer. An unref'd timer does not keep the
    // event loop alive; the process can exit before SIGKILL runs after the
    // direct child closes and no other referenced handles remain.
    forceKillDone = new Promise<void>((resolveForceKill) => {
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        killCheckProcessTree(child, "SIGKILL", groupPid);
        resolveForceKill();
      }, killGraceMs);
    });
  };

  // Command timeout may unref: stop() still arms a referenced force-kill timer.
  const timeout = setTimeout(() => stop("timed_out"), timeoutMs);
  timeout.unref();

  const onAbort = (): void => stop("cancelled");
  if (signal !== undefined) {
    if (signal.aborted) {
      stop("cancelled");
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // Wait for close always. A process that ignores SIGTERM is killed by SIGKILL.
  const exitCode = await new Promise<number | null>((resolveExit) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolveExit(code);
    };
    child.once("error", (error) => {
      spawnError = error;
      // Close may still fire after a spawn-time error; if not, finish soon.
      if (child.exitCode !== null || child.signalCode !== null) {
        finish(child.exitCode);
        return;
      }
      // If the child never started, close may not fire. Finish after a tick if
      // still open, but prefer waiting for close when a pid exists.
      if (typeof child.pid !== "number") {
        finish(null);
      }
    });
    child.once("close", (code) => {
      finish(code);
    });
  });

  clearTimeout(timeout);
  if (signal !== undefined) {
    signal.removeEventListener("abort", onAbort);
  }
  // Abort/timeout: wait for process-group SIGKILL grace, even if the direct
  // child already closed. Normal exit: cancel any unused force-kill timer.
  if (termination !== undefined && forceKillDone !== undefined) {
    await forceKillDone;
  } else if (forceKillTimer !== undefined) {
    clearTimeout(forceKillTimer);
  }

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  if (termination === "cancelled" || signal?.aborted) {
    return {
      ok: false,
      kind: "aborted",
      message: "The post-integration check was cancelled.",
      stdout,
      stderr,
    };
  }
  if (termination === "timed_out") {
    return {
      ok: false,
      kind: "timeout",
      message: `Post-integration check '${check.id}' timed out after ${timeoutMs}ms.`,
      stdout,
      stderr,
    };
  }
  if (spawnError !== undefined && (exitCode === null || exitCode === undefined)) {
    return {
      ok: false,
      kind: "process",
      message: spawnError.message,
      stdout,
      stderr,
    };
  }

  const code = exitCode ?? 1;
  if (code !== 0) {
    return {
      ok: false,
      kind: "exit",
      message: `Post-integration check '${check.id}' exited with code ${code}.`,
      exitCode: code,
      stdout,
      stderr,
    };
  }

  return {
    ok: true,
    exitCode: code,
    stdout,
    stderr,
  };
}

function mapCommandFailure(
  check: PostIntegrationCheckCommand,
  failure: Extract<CommandRunResult, { ok: false }>,
): Diagnostic {
  if (failure.kind === "aborted") {
    return reject(
      "workspace_post_check_aborted",
      failure.message,
      "signal",
    );
  }
  if (failure.kind === "timeout") {
    return reject(
      "workspace_post_check_timeout",
      failure.message,
      `checks.${check.id}`,
    );
  }
  if (failure.kind === "process") {
    return reject(
      "workspace_post_check_process",
      `Check '${check.id}' failed to start: ${failure.message}`,
      `checks.${check.id}`,
    );
  }
  const detailParts = [failure.message];
  if (failure.stderr !== undefined && failure.stderr.trim().length > 0) {
    const trimmed = failure.stderr.trim();
    detailParts.push(
      trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed,
    );
  }
  return reject(
    "workspace_post_check_command_failed",
    detailParts.join(" "),
    `checks.${check.id}`,
  );
}

function normalizeChecksInput(
  checks: unknown,
  bounds?: PostIntegrationCheckListBounds,
):
  | { ok: true; value: PostIntegrationCheckList }
  | { ok: false; diagnostics: Diagnostic[] } {
  if (Array.isArray(checks)) {
    return parsePostIntegrationCheckList(
      {
        schemaVersion: 1,
        checks,
      },
      "checks",
      bounds,
    );
  }
  return parsePostIntegrationCheckList(checks, "checks", bounds);
}

function emptySet(): WorkspaceIntegrationSet {
  return {
    schemaVersion: WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION,
    integrations: [],
  };
}

function failChecks(
  diagnostics: Diagnostic[],
  set: WorkspaceIntegrationSet,
  integration?: WorkspaceIntegration,
): RunPostIntegrationChecksResult {
  return {
    ok: false,
    diagnostics,
    set,
    eligibleForNodeCompletion: false,
    ...(integration !== undefined ? { integration } : {}),
  };
}

function passChecks(
  set: WorkspaceIntegrationSet,
  integration: WorkspaceIntegration,
  alreadyPassed?: boolean,
): RunPostIntegrationChecksResult {
  // Success path always ends at checks_passed.
  const eligible = isIntegrationEligibleForNodeCompletion(integration);
  if (!eligible) {
    return failChecks(
      [reject(
        "workspace_post_check_not_eligible",
        "Host success path must produce checks_passed for node completion.",
        "integration.status",
      )],
      set,
      integration,
    );
  }
  return {
    ok: true,
    set,
    integration,
    eligibleForNodeCompletion: true,
    ...(alreadyPassed === true ? { alreadyPassed: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public host API
// ---------------------------------------------------------------------------

/**
 * Run post-integration checks in the base workspace for one integrated record.
 * Does not mutate the input set. Returns a new set with durable status updates.
 * Success results set eligibleForNodeCompletion true only for checks_passed.
 * Controllers must still call requireChecksPassedForNodeCompletion before
 * node completion.
 */
export async function runPostIntegrationChecks(
  input: RunPostIntegrationChecksInput,
): Promise<RunPostIntegrationChecksResult> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return failChecks(
      [reject(
        "workspace_post_check_input_not_plain_object",
        "Post-integration check input must be a plain object.",
        "input",
      )],
      input && typeof input === "object" && "set" in input
        ? (input as RunPostIntegrationChecksInput).set
        : emptySet(),
    );
  }

  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return failChecks(
      [reject(
        "workspace_post_check_input_not_plain_object",
        "Post-integration check input must be a plain object.",
        "input",
      )],
      input.set,
    );
  }

  const maxBytesResolved = resolveMaxOutputBytes(input.maxOutputBytes);
  if (!maxBytesResolved.ok) {
    return failChecks([maxBytesResolved.diagnostic], input.set);
  }

  const baseValidated = await resolveAndValidateBaseWorkspace(
    input.baseRepoPath,
    input.signal,
  );
  if (!baseValidated.ok) {
    return failChecks(baseValidated.diagnostics, input.set);
  }
  const baseCwd = baseValidated.baseCwd;

  const checksParsed = normalizeChecksInput(input.checks, input.bounds);
  if (!checksParsed.ok) {
    return failChecks(checksParsed.diagnostics, input.set);
  }

  if (typeof input.integrationId !== "string" || input.integrationId.trim().length === 0) {
    return failChecks(
      [reject(
        "workspace_post_check_invalid_integration_id",
        "integrationId must be a non-empty string.",
        "integrationId",
      )],
      input.set,
    );
  }

  const integrationId = input.integrationId.trim();
  const got = getIntegration(input.set, integrationId);
  if (!got.ok) {
    return failChecks(got.diagnostics, input.set);
  }
  if (got.integration === undefined) {
    return failChecks(
      [reject(
        "workspace_integration_not_found",
        `Integration id '${integrationId}' was not found.`,
        "integrationId",
      )],
      input.set,
    );
  }

  let integration = got.integration;
  let set = input.set;
  const allowResume = input.allowResume === true;
  const startOptions = allowResume ? { allowResume: true } : undefined;

  // Validate expected identity shape before any identity comparison.
  let expectedIdentity: WorkspaceIntegrationExpectedIdentity | undefined;
  if (input.expected !== undefined) {
    const parsedExpected = parseWorkspaceIntegrationExpectedIdentity(
      input.expected,
      "expected",
    );
    if (!parsedExpected.ok) {
      return failChecks(parsedExpected.diagnostics, set, integration);
    }
    expectedIdentity = parsedExpected.value;
    const identityDiagnostics = validateIntegrationIdentity(
      integration,
      expectedIdentity,
    );
    if (identityDiagnostics.length > 0) {
      return failChecks(identityDiagnostics, set, integration);
    }
  }

  if (integration.status === "checks_passed") {
    return passChecks(set, integration, true);
  }

  if (integration.status === "checks_failed") {
    return failChecks(
      [
        reject(
          "workspace_integration_already_checks_failed",
          "Post-integration checks already failed for this integration.",
          "integration.status",
        ),
        ...(integration.diagnostics ?? []).map((item) => ({ ...item })),
      ],
      set,
      integration,
    );
  }

  if (!canStartPostIntegrationChecks(integration, startOptions)) {
    if (integration.status === "checking" && !allowResume) {
      return failChecks(
        [reject(
          "workspace_integration_already_checking",
          "Post-integration checks are already in progress. "
            + "A concurrent second start is not permitted. "
            + "Set allowResume only after crash recovery when no host runner is active.",
          "integration.status",
        )],
        set,
        integration,
      );
    }
    return failChecks(
      [reject(
        "workspace_post_check_not_integrated",
        `Cannot run post-integration checks from status '${integration.status}'. Expected 'integrated'.`,
        "integration.status",
      )],
      set,
      integration,
    );
  }

  const started = startPostIntegrationChecks(
    set,
    integrationId,
    expectedIdentity,
    startOptions,
  );
  if (!started.ok) {
    return failChecks(started.diagnostics, set, integration);
  }
  set = started.set;
  integration = started.integration;

  if (input.persist !== undefined) {
    try {
      await input.persist(set);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = completePostIntegrationChecksFailed(
        set,
        integrationId,
        [reject(
          "workspace_post_check_persist_failed",
          `Failed to persist checking status: ${message}`,
          "persist",
        )],
        undefined,
        expectedIdentity,
      );
      if (failed.ok) {
        return failChecks(
          failed.integration.diagnostics ?? [],
          failed.set,
          failed.integration,
        );
      }
      return failChecks(
        [
          reject(
            "workspace_post_check_persist_failed",
            `Failed to persist checking status: ${message}`,
            "persist",
          ),
          ...failed.diagnostics,
        ],
        set,
        integration,
      );
    }
  }

  // After durable checking, require base HEAD still matches the integrate result.
  const expectedHead = integration.integratedCommitHash;
  if (expectedHead === undefined) {
    const failed = completePostIntegrationChecksFailed(
      set,
      integrationId,
      [reject(
        "workspace_integration_missing_integrated_commit",
        "Checking record is missing integratedCommitHash.",
        "integration.integratedCommitHash",
      )],
      undefined,
      expectedIdentity,
    );
    if (failed.ok) {
      return failChecks(
        failed.integration.diagnostics ?? [],
        failed.set,
        failed.integration,
      );
    }
    return failChecks(failed.diagnostics, set, integration);
  }

  const headOk = await assertBaseHeadMatchesIntegrated(
    baseCwd,
    expectedHead,
    input.signal,
  );
  if (!headOk.ok) {
    const failed = completePostIntegrationChecksFailed(
      set,
      integrationId,
      headOk.diagnostics,
      headOk.diagnostics[0]?.message,
      expectedIdentity,
    );
    if (failed.ok) {
      return failChecks(
        failed.integration.diagnostics ?? headOk.diagnostics,
        failed.set,
        failed.integration,
      );
    }
    return failChecks(
      [...headOk.diagnostics, ...failed.diagnostics],
      set,
      integration,
    );
  }

  for (const check of checksParsed.value.checks) {
    if (input.signal?.aborted) {
      const failed = completePostIntegrationChecksFailed(
        set,
        integrationId,
        [reject(
          "workspace_post_check_aborted",
          "The post-integration check run was cancelled.",
          "signal",
        )],
        undefined,
        expectedIdentity,
      );
      if (failed.ok) {
        return failChecks(
          failed.integration.diagnostics ?? [],
          failed.set,
          failed.integration,
        );
      }
      return failChecks(failed.diagnostics, set, integration);
    }

    const commandOptions: {
      signal?: AbortSignal;
      maxOutputBytes?: number;
      killGraceMs?: number;
    } = {
      maxOutputBytes: maxBytesResolved.value,
    };
    if (input.signal !== undefined) commandOptions.signal = input.signal;
    if (input.killGraceMs !== undefined) {
      commandOptions.killGraceMs = input.killGraceMs;
    }
    const result = await runBaseWorkspaceCheckCommand(baseCwd, check, commandOptions);

    if (!result.ok) {
      const diagnostic = mapCommandFailure(check, result);
      const failed = completePostIntegrationChecksFailed(
        set,
        integrationId,
        [diagnostic],
        diagnostic.message,
        expectedIdentity,
      );
      if (failed.ok) {
        return failChecks(
          failed.integration.diagnostics ?? [diagnostic],
          failed.set,
          failed.integration,
        );
      }
      return failChecks([diagnostic, ...failed.diagnostics], set, integration);
    }
  }

  // Final HEAD verify after all commands. A check must not leave base HEAD moved.
  const headAfter = await assertBaseHeadMatchesIntegrated(
    baseCwd,
    expectedHead,
    input.signal,
  );
  if (!headAfter.ok) {
    const failed = completePostIntegrationChecksFailed(
      set,
      integrationId,
      headAfter.diagnostics,
      headAfter.diagnostics[0]?.message,
      expectedIdentity,
    );
    if (failed.ok) {
      return failChecks(
        failed.integration.diagnostics ?? headAfter.diagnostics,
        failed.set,
        failed.integration,
      );
    }
    return failChecks(
      [...headAfter.diagnostics, ...failed.diagnostics],
      set,
      integration,
    );
  }

  // A successful check must not leave tracked files dirty without a commit.
  // HEAD can still equal integratedCommitHash while the base worktree is dirty.
  const cleanAfter = await assertBaseWorktreeTrackedClean(baseCwd, input.signal);
  if (!cleanAfter.ok) {
    const failed = completePostIntegrationChecksFailed(
      set,
      integrationId,
      cleanAfter.diagnostics,
      cleanAfter.diagnostics[0]?.message,
      expectedIdentity,
    );
    if (failed.ok) {
      return failChecks(
        failed.integration.diagnostics ?? cleanAfter.diagnostics,
        failed.set,
        failed.integration,
      );
    }
    return failChecks(
      [...cleanAfter.diagnostics, ...failed.diagnostics],
      set,
      integration,
    );
  }

  const passed = completePostIntegrationChecksPassed(
    set,
    integrationId,
    expectedIdentity,
  );
  if (!passed.ok) {
    return failChecks(passed.diagnostics, set, integration);
  }

  return passChecks(passed.set, passed.integration);
}
