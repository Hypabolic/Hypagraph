import type {
  CodeExecutionRequest,
  CodeExecutor,
  CodeNodeDefinition,
  CodeResult,
  EffectExecutionRequest,
  EffectExecutor,
  EffectNodeDefinition,
  HypagraphState,
} from "../domain/model.js";
import type { FactValue } from "../domain/facts.js";
import { effectIdempotencyKey } from "../domain/effect-idempotency.js";
import {
  capabilityIsPermittedForRole,
  effectAmbientInputs,
  EFFECT_HOST_BINDING_IDEMPOTENCY_KEY,
  EFFECT_HOST_BINDING_PHASE,
  isEffectHostBindingName,
  type EffectProgramRole,
} from "../domain/effect-authoring.js";
import { pinnedSandboxRuntimeIdentity } from "../domain/sandbox-runtime-identity.js";
import { CodeHostBridge, type BridgeHandler } from "../code/bridge.js";
import { validateCodeReturnValue } from "../code/result-validation.js";

export {
  effectAmbientInputs,
  EFFECT_HOST_BINDING_IDEMPOTENCY_KEY,
  EFFECT_HOST_BINDING_NAMES,
  EFFECT_HOST_BINDING_PHASE,
  isEffectHostBindingName,
} from "../domain/effect-authoring.js";

/**
 * Build an effect execution request after the request event is stored.
 */
export function createEffectExecutionRequest(
  state: HypagraphState,
  nodeId: string,
  attemptId: string,
  requestedAt: string,
  phase: "effect" | "reconcile",
): EffectExecutionRequest {
  const node = state.definition.nodes.find((item) => item.id === nodeId);
  if (!node || (node.kind ?? "task") !== "effect" || !node.effect) {
    throw new Error(`Node '${nodeId}' is not an effect node.`);
  }
  const runtime = state.runtime.nodes[nodeId];
  if (!runtime) {
    throw new Error(`Effect node '${nodeId}' has no runtime state.`);
  }

  if (phase === "effect") {
    if (runtime.status !== "running" || runtime.currentAttemptId !== attemptId) {
      throw new Error(`Effect node '${nodeId}' does not have the requested running attempt.`);
    }
  }

  const definition = node.effect;
  const program = phase === "effect" ? definition.effect : definition.reconcile;
  const attempt = runtime.attempts[attemptId] ?? Object.values(runtime.attempts).find(
    (item) => item.effectObservation?.durableState === "indeterminate",
  );
  const observation = attempt?.effectObservation;
  const idempotencyKey = observation?.idempotencyKey
    ?? effectIdempotencyKey({
      workflowId: state.workflowId,
      revision: state.revision,
      nodeId,
      attemptId,
    });

  const bindings: Record<string, FactValue> = {};
  for (const name of program.inputs) {
    // Host-injected names are not fact contracts. The executor supplies them.
    if (isEffectHostBindingName(name)) continue;
    const fact = state.runtime.facts[name];
    if (!fact) {
      throw new Error(`Effect node '${nodeId}' requires fact binding '${name}', but that fact is not published.`);
    }
    bindings[name] = structuredClone(fact.value);
  }

  return {
    workflowId: state.workflowId,
    revision: state.revision,
    nodeId,
    attemptId,
    requestedAt,
    phase,
    definition: structuredClone(definition),
    program: structuredClone(program),
    bindings,
    idempotencyKey,
    produces: structuredClone(node.produces ?? []),
    externalIdentity: structuredClone(definition.externalIdentity),
    ...(node.scope?.paths ? { scopePaths: structuredClone(node.scope.paths) } : {}),
  };
}

const asCodeDefinition = (request: EffectExecutionRequest): CodeNodeDefinition => ({
  kind: "code",
  execution: request.program,
});

/**
 * Build host-injected bindings for effect and reconcile programs.
 * Authors read `inputs["effect.idempotency_key"]` and `inputs["effect.phase"]`.
 * These names are not fact contracts. The host injects them at execution time.
 */
export function effectHostBindings(request: EffectExecutionRequest): Record<string, FactValue> {
  return {
    [EFFECT_HOST_BINDING_IDEMPOTENCY_KEY]: request.idempotencyKey,
    [EFFECT_HOST_BINDING_PHASE]: request.phase,
  };
}

/**
 * Adapter executor: runs effect and reconcile programs through a CodeExecutor seam.
 * Injects the idempotency key and phase as host bindings for sandbox programs.
 */
export class SandboxEffectExecutor implements EffectExecutor {
  readonly id: string;
  readonly version: number;
  private readonly codeExecutor: CodeExecutor;
  private readonly now: () => Date;
  /**
   * Optional factory so each phase can receive a role-specific capability permit
   * when the underlying code executor supports it (QuickJSSandboxExecutor).
   */
  private readonly createCodeExecutor: ((role: EffectProgramRole) => CodeExecutor) | undefined;

  constructor(options: {
    codeExecutor: CodeExecutor;
    /** When set, builds a fresh code executor for the effect or reconcile role. */
    createCodeExecutor?: (role: EffectProgramRole) => CodeExecutor;
    id?: string;
    version?: number;
    now?: () => Date;
  }) {
    this.codeExecutor = options.codeExecutor;
    this.createCodeExecutor = options.createCodeExecutor;
    this.id = options.id ?? "sandbox-effect-executor";
    this.version = options.version ?? 1;
    this.now = options.now ?? (() => new Date());
  }

  async execute(request: EffectExecutionRequest, signal: AbortSignal): Promise<CodeResult> {
    const role: EffectProgramRole = request.phase === "effect" ? "effect" : "reconcile";
    for (const capability of request.program.capabilities) {
      if (!capabilityIsPermittedForRole(capability, role)) {
        const startedAt = this.now().toISOString();
        return {
          attemptId: request.attemptId,
          startedAt,
          completedAt: this.now().toISOString(),
          status: "error",
          facts: [],
          evidence: [],
          error: `Capability effect class '${capability.effectClass}' is not permitted for the ${request.phase} program.`,
        };
      }
    }

    const hostBindings = effectHostBindings(request);
    // Ambient inputs include reserved host bindings. Re-pin identity so QuickJS
    // matches the prepare pin (prepare also uses effectAmbientInputs).
    const runtimeInputs = effectAmbientInputs(request.program.inputs);
    const runtimeIdentity = pinnedSandboxRuntimeIdentity(runtimeInputs);
    const codeDefinition: CodeNodeDefinition = {
      kind: "code",
      execution: {
        ...structuredClone(request.program),
        inputs: runtimeInputs,
        runtimeIdentity,
      },
    };
    const codeRequest: CodeExecutionRequest = {
      workflowId: request.workflowId,
      revision: request.revision,
      nodeId: request.nodeId,
      attemptId: request.attemptId,
      requestedAt: request.requestedAt,
      definition: codeDefinition,
      bindings: {
        ...request.bindings,
        ...hostBindings,
      },
      produces: request.produces,
      ...(request.scopePaths ? { scopePaths: request.scopePaths } : {}),
    };
    const executor = this.createCodeExecutor?.(role) ?? this.codeExecutor;
    return structuredClone(await executor.execute(structuredClone(codeRequest), signal));
  }
}

/**
 * Test executor which evaluates effect and reconcile through supplied functions.
 * Does not use QuickJS.
 */
export class MemoryEffectExecutor implements EffectExecutor {
  readonly id: string;
  readonly version: number;
  private readonly now: () => Date;
  private readonly evaluateEffect: (
    request: EffectExecutionRequest,
    bridge: CodeHostBridge,
    signal: AbortSignal,
  ) => Promise<unknown> | unknown;
  private readonly evaluateReconcile: (
    request: EffectExecutionRequest,
    bridge: CodeHostBridge,
    signal: AbortSignal,
  ) => Promise<unknown> | unknown;
  private readonly handlers: Record<string, BridgeHandler>;

  constructor(options: {
    evaluateEffect: MemoryEffectExecutor["evaluateEffect"];
    evaluateReconcile: MemoryEffectExecutor["evaluateReconcile"];
    handlers?: Record<string, BridgeHandler>;
    now?: () => Date;
    id?: string;
    version?: number;
  }) {
    this.evaluateEffect = options.evaluateEffect;
    this.evaluateReconcile = options.evaluateReconcile;
    this.handlers = options.handlers ?? {};
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? "memory-effect-executor";
    this.version = options.version ?? 1;
  }

  async execute(request: EffectExecutionRequest, signal: AbortSignal): Promise<CodeResult> {
    const startedAt = this.now().toISOString();
    const role: EffectProgramRole = request.phase === "effect" ? "effect" : "reconcile";
    const codeDefinition = asCodeDefinition(request);
    const bridge = new CodeHostBridge({
      definition: codeDefinition,
      maxBridgeCalls: request.program.maxBridgeCalls,
      handlers: this.handlers,
      capabilityPermit: (capability) => capabilityIsPermittedForRole(capability, role),
    });

    if (signal.aborted) {
      return {
        attemptId: request.attemptId,
        startedAt,
        completedAt: this.now().toISOString(),
        status: "cancelled",
        facts: [],
        evidence: [],
        error: "The effect execution was cancelled.",
        bridgeCalls: [...bridge.audit],
      };
    }

    try {
      const evaluator = request.phase === "effect" ? this.evaluateEffect : this.evaluateReconcile;
      const value = await evaluator(request, bridge, signal);
      const completedAt = this.now().toISOString();

      if (request.phase === "reconcile" && value && typeof value === "object") {
        const decision = (value as { decision?: string }).decision;
        if (decision === "undecidable") {
          return {
            attemptId: request.attemptId,
            startedAt,
            completedAt,
            status: "passed",
            value,
            facts: [],
            evidence: [{
              ref: `effect-reconcile:${request.nodeId}:${request.attemptId}`,
              kind: "note",
              summary: "Reconciliation could not decide.",
            }],
            bridgeCalls: [...bridge.audit],
          };
        }
      }

      const validated = validateCodeReturnValue(value, request.produces, [{
        ref: `effect:${request.phase}:${request.nodeId}:${request.attemptId}`,
        kind: "note",
        summary: `Memory effect ${request.phase} execution.`,
      }]);
      if (!validated.ok && request.phase === "effect") {
        // Effect may return external identity under produces; failure means execution error.
        return {
          attemptId: request.attemptId,
          startedAt,
          completedAt,
          status: "failed",
          value,
          facts: [],
          evidence: [],
          error: validated.diagnostics.map((item) => item.message).join(" "),
          bridgeCalls: [...bridge.audit],
        };
      }

      return {
        attemptId: request.attemptId,
        startedAt,
        completedAt,
        status: "passed",
        value,
        facts: validated.ok ? validated.facts : [],
        evidence: [{
          ref: `effect:${request.phase}:${request.nodeId}:${request.attemptId}`,
          kind: "note",
          summary: `Memory effect ${request.phase} execution.`,
        }],
        bridgeCalls: [...bridge.audit],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lost = message.startsWith("LOST_RESULT") || message.includes("LOST_RESULT:");
      const cancelled = signal.aborted || /cancell?ed/i.test(message);
      const timedOut = /timeout/i.test(message);
      return {
        attemptId: request.attemptId,
        startedAt,
        completedAt: this.now().toISOString(),
        status: lost ? "interrupted" : cancelled ? "cancelled" : timedOut ? "timed_out" : "error",
        facts: [],
        evidence: [],
        error: message,
        bridgeCalls: [...bridge.audit],
      };
    }
  }
}

export async function executeEffect(
  executor: EffectExecutor,
  request: EffectExecutionRequest,
  signal: AbortSignal,
): Promise<CodeResult> {
  return structuredClone(await executor.execute(structuredClone(request), signal));
}
