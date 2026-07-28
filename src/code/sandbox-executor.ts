import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import type {
  CodeExecutionRequest,
  CodeExecutor,
  CodeResult,
  EvidenceReference,
} from "../domain/model.js";
import { pinnedSandboxRuntimeIdentity, runtimeIdentityMatches } from "../domain/sandbox-runtime-identity.js";
import { createStrictBindings, CodeHostBridge } from "./bridge.js";
import { resolveExecutableJavaScript } from "./prepare.js";
import { validateCodeReturnValue } from "./result-validation.js";
import { SANDBOX_QUICKJS_VERSION } from "./runtime-identity.js";

export interface QuickJSSandboxExecutorOptions {
  id?: string;
  version?: number;
  now?: () => Date;
  /** Synchronous host handlers only. Async handlers are rejected. */
  handlers?: Record<string, (args: unknown) => unknown>;
}

let modulePromise: Promise<QuickJSWASMModule> | undefined;

const loadModule = (): Promise<QuickJSWASMModule> => {
  if (!modulePromise) {
    modulePromise = newQuickJSWASMModuleFromVariant(variant);
  }
  return modulePromise;
};

/**
 * QuickJS sandbox executor.
 * Each execution uses a fresh context. Globals for process, require, and network are absent.
 */
export class QuickJSSandboxExecutor implements CodeExecutor {
  readonly id: string;
  readonly version: number;
  private readonly now: () => Date;
  private readonly handlers: QuickJSSandboxExecutorOptions["handlers"];

  constructor(options: QuickJSSandboxExecutorOptions = {}) {
    this.id = options.id ?? "quickjs-sandbox-executor";
    this.version = options.version ?? 1;
    this.now = options.now ?? (() => new Date());
    this.handlers = options.handlers;
  }

  async execute(request: CodeExecutionRequest, signal: AbortSignal): Promise<CodeResult> {
    const startedAt = this.now().toISOString();
    const execution = request.definition.execution;
    const evidence: EvidenceReference[] = [{
      ref: `code:${request.nodeId}:${request.attemptId}`,
      kind: "note",
      summary: `QuickJS sandbox execution (${SANDBOX_QUICKJS_VERSION}).`,
    }];

    if (signal.aborted) {
      return terminal(request, startedAt, this.now(), "cancelled", evidence, "The code execution was cancelled.");
    }

    // Reject a program whose durable identity does not match the live host pin.
    const liveIdentity = pinnedSandboxRuntimeIdentity(execution.inputs);
    if (!runtimeIdentityMatches(execution.runtimeIdentity, liveIdentity)) {
      return terminal(
        request,
        startedAt,
        this.now(),
        "error",
        evidence,
        "The code program runtime identity does not match the live sandbox pin. Re-prepare the definition under the current toolchain.",
      );
    }

    // Prefer verified stored compiled JS. Recompile only when stored output is absent.
    const resolved = resolveExecutableJavaScript(request.definition);
    if (!resolved.ok) {
      return terminal(
        request,
        startedAt,
        this.now(),
        "error",
        evidence,
        resolved.diagnostics.map((item) => item.message).join(" "),
      );
    }
    const compiled = resolved.compiledJavaScript;

    let bridge: CodeHostBridge | undefined;
    let context: QuickJSContext | undefined;
    try {
      const bindings = createStrictBindings(execution.inputs, request.bindings);
      bridge = new CodeHostBridge({
        definition: request.definition,
        maxBridgeCalls: execution.maxBridgeCalls,
        ...(this.handlers
          ? {
            handlers: Object.fromEntries(
              Object.entries(this.handlers).map(([name, handler]) => [
                name,
                (args: unknown) => handler(args),
              ]),
            ),
          }
          : {}),
      });

      const QuickJS = await loadModule();
      context = QuickJS.newContext();
      const runtime = context.runtime;
      if (execution.maxMemoryBytes > 0) {
        runtime.setMemoryLimit(execution.maxMemoryBytes);
      }
      const deadline = Date.now() + execution.timeoutMs;
      runtime.setInterruptHandler(() => signal.aborted || Date.now() >= deadline);

      injectBindings(context, bindings);
      injectHost(context, bridge);

      if (signal.aborted) {
        return terminal(request, startedAt, this.now(), "cancelled", evidence, "The code execution was cancelled.", bridge);
      }

      const wrapped = wrapProgram(compiled);
      const result = context.evalCode(wrapped, "code-node.js", { type: "global" });
      if (result.error) {
        const message = context.dump(result.error);
        result.error.dispose();
        const text = formatSandboxError(message);
        const cancelled = signal.aborted;
        const timedOut = !cancelled && (/interrupt/i.test(text) || Date.now() >= deadline);
        return terminal(
          request,
          startedAt,
          this.now(),
          cancelled ? "cancelled" : timedOut ? "timed_out" : "failed",
          evidence,
          cancelled
            ? "The code execution was cancelled."
            : timedOut
              ? "The code program exceeded its timeout."
              : text,
          bridge,
        );
      }

      const value = context.dump(result.value);
      result.value.dispose();

      const serialised = JSON.stringify(value ?? null);
      if (Buffer.byteLength(serialised, "utf8") > execution.maxResultBytes) {
        return terminal(
          request,
          startedAt,
          this.now(),
          "error",
          evidence,
          `The code result exceeded maxResultBytes (${execution.maxResultBytes}).`,
          bridge,
        );
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
          runtimeIdentity: structuredClone(execution.runtimeIdentity),
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
      return terminal(
        request,
        startedAt,
        this.now(),
        cancelled ? "cancelled" : "error",
        evidence,
        message,
        bridge,
      );
    } finally {
      context?.dispose();
    }
  }
}

const terminal = (
  request: CodeExecutionRequest,
  startedAt: string,
  completed: Date,
  status: CodeResult["status"],
  evidence: EvidenceReference[],
  error: string,
  bridge?: CodeHostBridge,
): CodeResult => ({
  attemptId: request.attemptId,
  startedAt,
  completedAt: completed.toISOString(),
  status,
  facts: [],
  evidence,
  ...(bridge ? { bridgeCalls: structuredClone(bridge.audit) } : {}),
  ...(request.definition.execution.runtimeIdentity
    ? { runtimeIdentity: structuredClone(request.definition.execution.runtimeIdentity) }
    : {}),
  error,
});

const formatSandboxError = (message: unknown): string => {
  if (typeof message === "string") return message;
  if (message && typeof message === "object" && "message" in message && typeof (message as { message: unknown }).message === "string") {
    return (message as { message: string }).message;
  }
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
};

/**
 * Evaluate compiled JavaScript produced by the TypeScript check.
 * The compiler wraps the author program as __hypagraphMain and invokes it.
 */
const wrapProgram = (compiled: string): string => {
  const body = compiled
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, "")
    .trim();
  // The compiled form already calls __hypagraphMain(); evaluate as a script.
  return body;
};

const injectBindings = (context: QuickJSContext, bindings: Record<string, unknown>): void => {
  const bindingsJson = JSON.stringify(bindings);
  const proxyResult = context.evalCode(`
(() => {
  const data = ${bindingsJson};
  return new Proxy(data, {
    get(target, property) {
      if (typeof property !== "string") return Reflect.get(target, property);
      if (Object.prototype.hasOwnProperty.call(target, property)) return target[property];
      if (property in Object.prototype || property === "toJSON") {
        const value = Reflect.get(Object.prototype, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      throw new Error("Binding '" + property + "' is not declared on this code node.");
    },
    has(target, property) {
      return typeof property === "string" && Object.prototype.hasOwnProperty.call(target, property);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property === "string" && Object.prototype.hasOwnProperty.call(target, property)) {
        return { configurable: true, enumerable: true, value: target[property] };
      }
      return undefined;
    }
  });
})()
`);
  if (proxyResult.error) {
    const message = context.dump(proxyResult.error);
    proxyResult.error.dispose();
    throw new Error(formatSandboxError(message) || "Failed to inject bindings.");
  }
  context.setProp(context.global, "inputs", proxyResult.value);
  proxyResult.value.dispose();
};

const injectHost = (context: QuickJSContext, bridge: CodeHostBridge): void => {
  const callHandle = context.newFunction("call", (actionHandle, argsHandle) => {
    try {
      const action = context.getString(actionHandle);
      const args = argsHandle ? context.dump(argsHandle) : undefined;
      const direct = bridge.callSync(action, args);
      const json = JSON.stringify(direct ?? null);
      const result = context.evalCode(`JSON.parse(${JSON.stringify(json)})`);
      if (result.error) {
        const message = context.dump(result.error);
        result.error.dispose();
        throw new Error(formatSandboxError(message) || "Bridge result encoding failed.");
      }
      return result.value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message);
    }
  });

  const host = context.newObject();
  context.setProp(host, "call", callHandle);
  context.setProp(context.global, "host", host);
  callHandle.dispose();
  host.dispose();
};
