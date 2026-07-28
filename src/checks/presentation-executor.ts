import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import type {
  EvidenceReference,
  HypagraphState,
  InteractionPresentation,
  InteractionPresentationCommand,
  InteractionPresentationObservation,
} from "../domain/model.js";
import { renderInteractionReport } from "../domain/presentation-report.js";
import type { CheckArtifactStore } from "./artifacts.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_ENVIRONMENT_VARIABLES = process.platform === "win32"
  ? ["Path", "PATHEXT", "SystemRoot", "COMSPEC", "TEMP", "TMP"]
  : ["PATH", "HOME", "TMPDIR"];

export interface PresentationExecutionRequest {
  state: HypagraphState;
  nodeId: string;
  attemptId: string;
  presentation: InteractionPresentation;
  requestedAt: string;
}

export interface PresentationExecutor {
  execute(request: PresentationExecutionRequest, signal: AbortSignal): Promise<InteractionPresentationObservation>;
}

export interface PresentationExecutorOptions {
  rootDirectory: string;
  artifactStore: CheckArtifactStore;
  killGraceMs?: number;
  now?: () => Date;
}

interface OutputCapture {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
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

const resolveWorkingDirectory = (rootDirectory: string, workingDirectory: string | undefined): string => {
  const root = resolve(rootDirectory);
  const target = resolve(root, workingDirectory ?? ".");
  const local = relative(root, target);
  if (local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("The presentation working directory is outside the configured workspace root.");
  }
  return target;
};

const inheritedEnvironment = (definition: InteractionPresentationCommand): NodeJS.ProcessEnv => {
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

/**
 * Run deterministic presentation effects outside the domain reducer.
 *
 * Call this only after the request-interaction event is stored.
 */
export class DefaultPresentationExecutor implements PresentationExecutor {
  private readonly rootDirectory: string;
  private readonly artifactStore: CheckArtifactStore;
  private readonly killGraceMs: number;
  private readonly now: () => Date;

  constructor(options: PresentationExecutorOptions) {
    if (!Number.isInteger(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS) || (options.killGraceMs ?? DEFAULT_KILL_GRACE_MS) < 0) {
      throw new Error("The kill grace period must be a non-negative integer.");
    }
    this.rootDirectory = resolve(options.rootDirectory);
    this.artifactStore = options.artifactStore;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.now = options.now ?? (() => new Date());
  }

  async execute(request: PresentationExecutionRequest, signal: AbortSignal): Promise<InteractionPresentationObservation> {
    const presentedAt = this.now().toISOString();
    if (signal.aborted) {
      return {
        status: "cancelled",
        kind: request.presentation.kind,
        presentedAt,
        error: "The presentation was cancelled before it started.",
      };
    }

    switch (request.presentation.kind) {
      case "none":
        return { status: "succeeded", kind: "none", presentedAt };
      case "report":
        return this.executeReport(request, presentedAt);
      case "command":
        return this.executeCommand(request, signal, presentedAt);
    }
  }

  private async executeReport(
    request: PresentationExecutionRequest,
    presentedAt: string,
  ): Promise<InteractionPresentationObservation> {
    const presentation = request.presentation;
    if (presentation.kind !== "report") {
      return { status: "error", kind: "report", presentedAt, error: "The presentation kind is not report." };
    }
    const mediaType = presentation.mediaType ?? "text/markdown; charset=utf-8";
    const maxBytes = presentation.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const content = renderInteractionReport(request.state, request.nodeId);
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > maxBytes) {
      return {
        status: "failed",
        kind: "report",
        presentedAt,
        error: `The report exceeds the maximum of ${maxBytes} bytes.`,
      };
    }
    const artifactRef = await this.artifactStore.write({
      workflowId: request.state.workflowId,
      nodeId: request.nodeId,
      attemptId: request.attemptId,
      name: mediaType.startsWith("text/plain") ? "presentation.txt" : "presentation.md",
      mediaType,
      content: new Uint8Array(bytes),
    });
    const evidence: EvidenceReference[] = [{
      ref: artifactRef,
      kind: "file",
      summary: "Interaction presentation report.",
    }];
    return {
      status: "succeeded",
      kind: "report",
      presentedAt,
      artifactRef,
      evidence,
    };
  }

  private async executeCommand(
    request: PresentationExecutionRequest,
    signal: AbortSignal,
    presentedAt: string,
  ): Promise<InteractionPresentationObservation> {
    const presentation = request.presentation;
    if (presentation.kind !== "command") {
      return { status: "error", kind: "command", presentedAt, error: "The presentation kind is not command." };
    }

    const maxOutputBytes = presentation.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const stdout: OutputCapture = { chunks: [], bytes: 0, truncated: false };
    const stderr: OutputCapture = { chunks: [], bytes: 0, truncated: false };
    let termination: "timed_out" | "cancelled" | undefined;
    let spawnError: Error | undefined;
    let exitCode: number | undefined;

    let workingDirectory: string;
    try {
      workingDirectory = resolveWorkingDirectory(this.rootDirectory, presentation.workingDirectory);
    } catch (error) {
      return {
        status: "error",
        kind: "command",
        presentedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const child = spawn(presentation.command, presentation.arguments ?? [], {
      cwd: workingDirectory,
      env: inheritedEnvironment(presentation),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.on("data", (chunk: Buffer) => appendOutput(stdout, chunk, maxOutputBytes));
    child.stderr.on("data", (chunk: Buffer) => appendOutput(stderr, chunk, maxOutputBytes));

    let forceKillTimer: NodeJS.Timeout | undefined;
    const stop = (reason: "timed_out" | "cancelled"): void => {
      if (termination) return;
      termination = reason;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), this.killGraceMs);
      forceKillTimer.unref();
    };

    const timeout = setTimeout(() => stop("timed_out"), presentation.timeoutMs);
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

    const evidence: EvidenceReference[] = [];
    let artifactRef: string | undefined;
    if (stdout.bytes > 0) {
      artifactRef = await this.artifactStore.write({
        workflowId: request.state.workflowId,
        nodeId: request.nodeId,
        attemptId: request.attemptId,
        name: "presentation-stdout.txt",
        mediaType: "text/plain; charset=utf-8",
        content: materialise(stdout),
      });
      evidence.push({
        ref: artifactRef,
        kind: "command",
        summary: stdout.truncated ? "Presentation command stdout. Output was truncated." : "Presentation command stdout.",
      });
    }
    if (stderr.bytes > 0) {
      const stderrRef = await this.artifactStore.write({
        workflowId: request.state.workflowId,
        nodeId: request.nodeId,
        attemptId: request.attemptId,
        name: "presentation-stderr.txt",
        mediaType: "text/plain; charset=utf-8",
        content: materialise(stderr),
      });
      evidence.push({
        ref: stderrRef,
        kind: "command",
        summary: stderr.truncated ? "Presentation command stderr. Output was truncated." : "Presentation command stderr.",
      });
      if (!artifactRef) artifactRef = stderrRef;
    }

    if (termination === "timed_out") {
      return {
        status: "timed_out",
        kind: "command",
        presentedAt,
        ...(artifactRef ? { artifactRef } : {}),
        error: "The presentation command exceeded its timeout.",
        ...(evidence.length > 0 ? { evidence } : {}),
      };
    }
    if (termination === "cancelled") {
      return {
        status: "cancelled",
        kind: "command",
        presentedAt,
        ...(artifactRef ? { artifactRef } : {}),
        error: "The presentation command was cancelled.",
        ...(evidence.length > 0 ? { evidence } : {}),
      };
    }
    if (spawnError) {
      return {
        status: "error",
        kind: "command",
        presentedAt,
        ...(artifactRef ? { artifactRef } : {}),
        error: spawnError.message,
        ...(evidence.length > 0 ? { evidence } : {}),
      };
    }

    const expectedExitCodes = presentation.expectedExitCodes ?? [0];
    const passed = exitCode !== undefined && expectedExitCodes.includes(exitCode);
    if (!passed) {
      return {
        status: "failed",
        kind: "command",
        presentedAt,
        ...(artifactRef ? { artifactRef } : {}),
        error: exitCode === undefined
          ? "The presentation command failed."
          : `The presentation command failed with exit code ${exitCode}.`,
        ...(evidence.length > 0 ? { evidence } : {}),
      };
    }

    return {
      status: "succeeded",
      kind: "command",
      presentedAt,
      ...(artifactRef ? { artifactRef } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
    };
  }
}
