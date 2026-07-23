import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import type { CheckExecutionRequest, CheckExecutor, CheckResult, CommandCheckDefinition, EvidenceReference } from "../domain/model.js";
import type { CheckArtifactStore } from "./artifacts.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_ENVIRONMENT_VARIABLES = process.platform === "win32"
  ? ["Path", "PATHEXT", "SystemRoot", "COMSPEC", "TEMP", "TMP"]
  : ["PATH", "HOME", "TMPDIR"];

interface OutputCapture {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

export interface CommandCheckExecutorOptions {
  rootDirectory: string;
  artifactStore: CheckArtifactStore;
  maxOutputBytes?: number;
  killGraceMs?: number;
  now?: () => Date;
}

const appendOutput = (capture: OutputCapture, chunk: Buffer, limit: number): void => {
  if (capture.bytes >= limit) {
    capture.truncated = true;
    return;
  }
  const remaining = limit - capture.bytes;
  const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  capture.chunks.push(Buffer.from(accepted));
  capture.bytes += accepted.length;
  if (accepted.length < chunk.length) capture.truncated = true;
};

const materialise = (capture: OutputCapture): Uint8Array => new Uint8Array(Buffer.concat(capture.chunks));

const resolveWorkingDirectory = (rootDirectory: string, definition: CommandCheckDefinition): string => {
  const root = resolve(rootDirectory);
  const workingDirectory = resolve(root, definition.workingDirectory ?? ".");
  const local = relative(root, workingDirectory);
  if (local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("The check working directory is outside the configured workspace root.");
  }
  return workingDirectory;
};

const inheritedEnvironment = (definition: CommandCheckDefinition): NodeJS.ProcessEnv => {
  const requested = definition.environmentVariables ?? DEFAULT_ENVIRONMENT_VARIABLES;
  const sourceNames = Object.keys(process.env);
  const result: NodeJS.ProcessEnv = {};
  for (const requestedName of requested) {
    const sourceName = process.platform === "win32"
      ? sourceNames.find((name) => name.toUpperCase() === requestedName.toUpperCase())
      : requestedName;
    if (!sourceName) continue;
    const value = process.env[sourceName];
    if (value !== undefined) result[sourceName] = value;
  }
  return result;
};

export class CommandCheckExecutor implements CheckExecutor {
  private readonly rootDirectory: string;
  private readonly artifactStore: CheckArtifactStore;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;
  private readonly now: () => Date;

  constructor(options: CommandCheckExecutorOptions) {
    if (!Number.isInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES) || (options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES) < 1) {
      throw new Error("The maximum output size must be a positive integer.");
    }
    if (!Number.isInteger(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS) || (options.killGraceMs ?? DEFAULT_KILL_GRACE_MS) < 0) {
      throw new Error("The kill grace period must be a non-negative integer.");
    }
    this.rootDirectory = resolve(options.rootDirectory);
    this.artifactStore = options.artifactStore;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.now = options.now ?? (() => new Date());
  }

  async execute(request: CheckExecutionRequest, signal: AbortSignal): Promise<CheckResult> {
    if (request.definition.kind === "file-assertion" || request.definition.kind === "git-assertion") {
      const { AssertionCheckExecutor } = await import("./assertion-check-executor.js");
      return new AssertionCheckExecutor({
        rootDirectory: this.rootDirectory,
        artifactStore: this.artifactStore,
        now: this.now,
      }).execute(request, signal);
    }
    if (request.definition.kind !== "command") {
      const { ReportCheckExecutor } = await import("./report-check-executor.js");
      return new ReportCheckExecutor({
        rootDirectory: this.rootDirectory,
        artifactStore: this.artifactStore,
        producerExecutor: this,
        now: this.now,
      }).execute(request, signal);
    }

    const definition = request.definition;
    const startedAt = this.now().toISOString();
    const stdout: OutputCapture = { chunks: [], bytes: 0, truncated: false };
    const stderr: OutputCapture = { chunks: [], bytes: 0, truncated: false };
    let termination: "timed_out" | "cancelled" | undefined;
    let spawnError: Error | undefined;
    let exitCode: number | undefined;

    let workingDirectory: string;
    try {
      workingDirectory = resolveWorkingDirectory(this.rootDirectory, definition);
    } catch (error) {
      const completedAt = this.now().toISOString();
      return {
        checkKind: "command",
        attemptId: request.attemptId,
        startedAt,
        completedAt,
        status: "error",
        facts: [],
        evidence: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const child = spawn(definition.command, definition.arguments ?? [], {
      cwd: workingDirectory,
      env: inheritedEnvironment(definition),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.on("data", (chunk: Buffer) => appendOutput(stdout, chunk, this.maxOutputBytes));
    child.stderr.on("data", (chunk: Buffer) => appendOutput(stderr, chunk, this.maxOutputBytes));

    let forceKillTimer: NodeJS.Timeout | undefined;
    const stop = (reason: "timed_out" | "cancelled"): void => {
      if (termination) return;
      termination = reason;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), this.killGraceMs);
      forceKillTimer.unref();
    };

    const timeout = setTimeout(() => stop("timed_out"), definition.timeoutMs);
    timeout.unref();
    const abort = (): void => stop("cancelled");
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });

    await new Promise<void>((complete) => {
      child.once("error", (error) => {
        spawnError = error;
        complete();
      });
      child.once("close", (code) => {
        if (typeof code === "number") exitCode = code;
        complete();
      });
    });

    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    signal.removeEventListener("abort", abort);

    const stdoutRef = stdout.bytes > 0
      ? await this.artifactStore.write({ workflowId: request.workflowId, nodeId: request.nodeId, attemptId: request.attemptId, name: "stdout.txt", mediaType: "text/plain; charset=utf-8", content: materialise(stdout) })
      : undefined;
    const stderrRef = stderr.bytes > 0
      ? await this.artifactStore.write({ workflowId: request.workflowId, nodeId: request.nodeId, attemptId: request.attemptId, name: "stderr.txt", mediaType: "text/plain; charset=utf-8", content: materialise(stderr) })
      : undefined;

    const evidence: EvidenceReference[] = [];
    if (stdoutRef) evidence.push({ ref: stdoutRef, kind: "file", summary: stdout.truncated ? "Command stdout. Output was truncated." : "Command stdout." });
    if (stderrRef) evidence.push({ ref: stderrRef, kind: "file", summary: stderr.truncated ? "Command stderr. Output was truncated." : "Command stderr." });

    const completedAt = this.now().toISOString();
    if (termination === "timed_out") {
      return { checkKind: "command", attemptId: request.attemptId, startedAt, completedAt, status: "timed_out", facts: [], evidence, ...(exitCode === undefined ? {} : { exitCode }), ...(stdoutRef ? { stdoutRef } : {}), ...(stderrRef ? { stderrRef } : {}), error: "The command exceeded its timeout." };
    }
    if (termination === "cancelled") {
      return { checkKind: "command", attemptId: request.attemptId, startedAt, completedAt, status: "cancelled", facts: [], evidence, ...(exitCode === undefined ? {} : { exitCode }), ...(stdoutRef ? { stdoutRef } : {}), ...(stderrRef ? { stderrRef } : {}), error: "The command was cancelled." };
    }
    if (spawnError) {
      return { checkKind: "command", attemptId: request.attemptId, startedAt, completedAt, status: "error", facts: [], evidence, ...(stdoutRef ? { stdoutRef } : {}), ...(stderrRef ? { stderrRef } : {}), error: spawnError.message };
    }

    const expectedExitCodes = definition.expectedExitCodes ?? [0];
    const passed = exitCode !== undefined && expectedExitCodes.includes(exitCode);
    return {
      checkKind: "command",
      attemptId: request.attemptId,
      startedAt,
      completedAt,
      status: passed ? "passed" : "failed",
      ...(exitCode === undefined ? {} : { exitCode }),
      facts: [],
      evidence,
      ...(stdoutRef ? { stdoutRef } : {}),
      ...(stderrRef ? { stderrRef } : {}),
    };
  }
}
