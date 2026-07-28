import type {
  CodeExecutionRequest,
  CodeExecutor,
  CodeResult,
  EvidenceReference,
} from "../domain/model.js";
import { createStrictBindings, CodeHostBridge } from "./bridge.js";
import { resolveExecutableJavaScript } from "./prepare.js";
import { validateCodeReturnValue } from "./result-validation.js";

export interface MemoryCodeExecutorOptions {
  id?: string;
  version?: number;
  now?: () => Date;
  /**
   * Optional pure evaluator for tests.
   * When omitted, the executor evaluates a restricted pure program body.
   */
  evaluate?: (
    request: CodeExecutionRequest,
    bindings: Record<string, unknown>,
    bridge: CodeHostBridge,
    signal: AbortSignal,
  ) => Promise<unknown> | unknown;
  handlers?: ConstructorParameters<typeof CodeHostBridge>[0]["handlers"];
}

/**
 * Test-only in-memory code executor.
 * It does not use QuickJS and has no process isolation.
 * Production hosts must use QuickJSSandboxExecutor. Do not select this class outside tests.
 */
export class MemoryCodeExecutor implements CodeExecutor {
  readonly id: string;
  readonly version: number;
  private readonly now: () => Date;
  private readonly evaluate?: MemoryCodeExecutorOptions["evaluate"];
  private readonly handlers: MemoryCodeExecutorOptions["handlers"];

  constructor(options: MemoryCodeExecutorOptions = {}) {
    this.id = options.id ?? "memory-code-executor";
    this.version = options.version ?? 1;
    this.now = options.now ?? (() => new Date());
    this.evaluate = options.evaluate;
    this.handlers = options.handlers;
  }

  async execute(request: CodeExecutionRequest, signal: AbortSignal): Promise<CodeResult> {
    const startedAt = this.now().toISOString();
    const execution = request.definition.execution;
    const evidence: EvidenceReference[] = [{
      ref: `code:${request.nodeId}:${request.attemptId}`,
      kind: "note",
      summary: "In-memory code execution.",
    }];

    if (signal.aborted) {
      return {
        attemptId: request.attemptId,
        startedAt,
        completedAt: this.now().toISOString(),
        status: "cancelled",
        facts: [],
        evidence,
        error: "The code execution was cancelled.",
      };
    }

    try {
      const bindings = createStrictBindings(execution.inputs, request.bindings);
      const bridge = new CodeHostBridge({
        definition: request.definition,
        maxBridgeCalls: execution.maxBridgeCalls,
        ...(this.handlers ? { handlers: this.handlers } : {}),
      });

      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("The code program exceeded its timeout.")), execution.timeoutMs);
        timer.unref?.();
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("The code execution was cancelled."));
        }, { once: true });
      });

      const run = async (): Promise<unknown> => {
        if (this.evaluate) return this.evaluate(request, bindings, bridge, signal);
        const resolved = resolveExecutableJavaScript(request.definition);
        if (!resolved.ok) {
          throw new Error(resolved.diagnostics.map((item) => item.message).join(" "));
        }
        return evaluatePureProgram(resolved.compiledJavaScript, bindings);
      };

      const value = await Promise.race([run(), timeout]);
      const serialised = JSON.stringify(value ?? null);
      if (Buffer.byteLength(serialised, "utf8") > execution.maxResultBytes) {
        return {
          attemptId: request.attemptId,
          startedAt,
          completedAt: this.now().toISOString(),
          status: "error",
          facts: [],
          evidence,
          bridgeCalls: structuredClone(bridge.audit),
          error: `The code result exceeded maxResultBytes (${execution.maxResultBytes}).`,
        };
      }

      const validated = validateCodeReturnValue(value, request.produces, evidence);
      if (!validated.ok) {
        return {
          attemptId: request.attemptId,
          startedAt,
          completedAt: this.now().toISOString(),
          status: "failed",
          value,
          facts: [],
          evidence,
          bridgeCalls: structuredClone(bridge.audit),
          error: validated.diagnostics.map((item) => item.message).join(" "),
        };
      }

      return {
        attemptId: request.attemptId,
        startedAt,
        completedAt: this.now().toISOString(),
        status: "passed",
        value,
        facts: validated.facts,
        evidence,
        bridgeCalls: structuredClone(bridge.audit),
        runtimeIdentity: structuredClone(execution.runtimeIdentity),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = signal.aborted || message.includes("cancelled");
      const timedOut = message.includes("timeout");
      return {
        attemptId: request.attemptId,
        startedAt,
        completedAt: this.now().toISOString(),
        status: cancelled ? "cancelled" : timedOut ? "timed_out" : "error",
        facts: [],
        evidence,
        error: message,
      };
    }
  }
}

/**
 * Evaluate a pure program body that returns an expression or uses `return`.
 * No file system, network, or process access.
 *
 * Compiled sandbox output ends with `__hypagraphMain();`. Convert that trailing
 * call into an explicit `return` so `new Function` yields the program value.
 */
function evaluatePureProgram(source: string, bindings: Record<string, unknown>): unknown {
  let body = source.replace(/__hypagraphMain\(\);\s*$/, "return __hypagraphMain();");
  if (!/\breturn\b/.test(body)) {
    body = `return (${body});`;
  }
  // The Function constructor still runs in-process. Production isolation uses QuickJS.
  // eslint-disable-next-line no-new-func
  const fn = new Function("inputs", "host", `"use strict";\n${body}`);
  const host = {
    call: () => {
      throw new Error("Capability is denied by default in the pure memory evaluator.");
    },
  };
  return fn(bindings, host);
}
