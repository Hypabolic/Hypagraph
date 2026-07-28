import { describe, expect, it } from "vitest";
import { MemoryCodeExecutor } from "../src/code/memory-executor.js";
import { QuickJSSandboxExecutor } from "../src/code/sandbox-executor.js";
import { createSandboxRuntimeIdentity } from "../src/domain/code-authoring.js";
import {
  isDeterministicEffectDecision,
  isReadyEffectDecision,
  isReconcileEffectDecision,
} from "../src/domain/deterministic-effect-dispatch.js";
import { capabilityIsPermittedForRole } from "../src/domain/effect-authoring.js";
import { effectIdempotencyKey } from "../src/domain/effect-idempotency.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import { isRunnableGoalContinuation, selectGoalContinuation } from "../src/domain/goal-continuation.js";
import { validateAutomaticRevision } from "../src/domain/goal-revision-policy.js";
import type {
  DomainEvent,
  EffectNodeDefinition,
  HypagraphDefinition,
  HypagraphState,
  NodeDefinition,
  SandboxProgramDefinition,
} from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { handleCommand } from "../src/domain/reducer.js";
import { validateDefinition } from "../src/domain/validate.js";
import { ActiveEffectExecutionRegistry } from "../src/effect/active-executions.js";
import { runDurableEffectLifecycle, runDurableEffectReconcile } from "../src/effect/durable-lifecycle.js";
import {
  EFFECT_HOST_BINDING_IDEMPOTENCY_KEY,
  MemoryEffectExecutor,
  SandboxEffectExecutor,
} from "../src/effect/execution.js";
import { MemoryEffectHost } from "../src/effect/memory-effect-host.js";
import { prepareEffectNodeDefinition } from "../src/effect/prepare.js";
import { recoverInterruptedEffects } from "../src/effect/recovery.js";
import { projectGraphView } from "../src/graph/projection.js";
import { InMemoryWorkflowEventStore } from "../src/persistence/event-store.js";
import { runDeterministicEffectDispatch } from "../src/pi/deterministic-effect-runner.js";
import { projectHypagoalSurface, renderHypagoalStatus } from "../src/ui/hypagoal-surface.js";

const at = "2026-07-29T12:00:00.000Z";
const finishedAt = "2026-07-29T12:00:05.000Z";

const baseProgram = (
  program: string,
  capabilities: SandboxProgramDefinition["capabilities"],
  inputs: string[] = ["seed.ready"],
): SandboxProgramDefinition => ({
  version: 1,
  program,
  inputs,
  capabilities,
  timeoutMs: 5_000,
  maxMemoryBytes: 8 * 1024 * 1024,
  maxBridgeCalls: 10,
  maxResultBytes: 64_000,
  runtimeIdentity: createSandboxRuntimeIdentity(),
});

const preparedEffect = (overrides: Partial<EffectNodeDefinition> = {}): EffectNodeDefinition => {
  const prepared = prepareEffectNodeDefinition({
    kind: "effect",
    version: 1,
    effect: baseProgram(
      `return { "effect.ok": true, "effect.external_id": "pr-1" };`,
      [{
        kind: "mcp",
        server: "effect",
        methods: ["apply"],
        effectClass: "external-effect",
      }],
    ),
    reconcile: baseProgram(
      `return { decision: "observed-success", "effect.ok": true, "effect.external_id": "pr-1" };`,
      [{
        kind: "mcp",
        server: "effect",
        methods: ["query"],
        effectClass: "observation",
      }],
    ),
    idempotency: { from: "canonical-identity" },
    externalIdentity: [
      { name: "effect.ok", type: "boolean", required: true },
      { name: "effect.external_id", type: "string", required: true },
    ],
    onIndeterminate: "block-dependants",
    ...overrides,
  });
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
  return prepared.definition;
};

const sourceNode = (): NodeDefinition => ({
  id: "seed",
  title: "Seed",
  kind: "task",
  requires: [],
  acceptance: [],
  produces: [{ name: "seed.ready", type: "boolean", required: true }],
});

const effectNode = (effect: EffectNodeDefinition = preparedEffect()): NodeDefinition => ({
  id: "open-pr",
  title: "Open pull request",
  kind: "effect",
  requires: ["seed"],
  acceptance: [],
  produces: [
    { name: "effect.ok", type: "boolean", required: true },
    { name: "effect.external_id", type: "string", required: true },
  ],
  effect,
});

const dependantNode = (): NodeDefinition => ({
  id: "after-pr",
  title: "After pull request",
  kind: "task",
  requires: ["open-pr"],
  acceptance: [],
});

const definition = (effect?: EffectNodeDefinition): HypagraphDefinition => ({
  title: "M6.3 external effect",
  goal: "Open a pull request and reconcile lost results",
  nodes: [sourceNode(), effectNode(effect), dependantNode()],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const create = (source: HypagraphDefinition = definition()) => {
  const result = createHypagoalWorkflow(source, {
    workflowId: "m6-3-effect-workflow",
    goalId: "m6-3-effect-goal",
    goalWorkflowId: "m6-3-effect-workflow",
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const seedFacts = (state: HypagraphState, priorEvents: DomainEvent[] = []): {
  state: HypagraphState;
  events: DomainEvent[];
} => {
  let next = state;
  const events: DomainEvent[] = [...priorEvents];
  const apply = (command: Parameters<typeof handleCommand>[1]): void => {
    const result = handleCommand(next, command);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    next = result.state;
    events.push(...result.events);
  };
  apply({
    type: "start-node",
    nodeId: "seed",
    attemptId: "seed-1",
    commandId: "seed-start",
    at,
  });
  apply({
    type: "publish-facts",
    nodeId: "seed",
    attemptId: "seed-1",
    facts: [{ name: "seed.ready", type: "boolean", value: true }],
    commandId: "seed-publish",
    at,
  });
  apply({
    type: "submit-result",
    nodeId: "seed",
    attemptId: "seed-1",
    evidence: [{ ref: "seed", kind: "note", summary: "seed" }],
    commandId: "seed-submit",
    at,
  });
  apply({
    type: "begin-verification",
    nodeId: "seed",
    attemptId: "seed-1",
    commandId: "seed-begin",
    at,
  });
  apply({
    type: "complete-verification",
    nodeId: "seed",
    attemptId: "seed-1",
    passed: true,
    commandId: "seed-complete",
    at,
  });
  return { state: next, events };
};

const readyEffect = (state: HypagraphState) => {
  const decision = selectGoalContinuation(state);
  if (!isRunnableGoalContinuation(decision) || !isReadyEffectDecision(decision)) {
    throw new Error(`Expected a ready effect node, received '${decision.kind}'.`);
  }
  return decision;
};

const seededStore = (state: HypagraphState, events: DomainEvent[]) => {
  const store = new InMemoryWorkflowEventStore();
  store.seed({ events, snapshot: state });
  return store;
};

const makeHostExecutor = (host: MemoryEffectHost, options?: {
  forceLostOnApply?: boolean;
  undecidableQuery?: boolean;
}) => new MemoryEffectExecutor({
  handlers: {
    "mcp.effect.apply": (args) => {
      const key = typeof (args as { idempotencyKey?: unknown })?.idempotencyKey === "string"
        ? (args as { idempotencyKey: string }).idempotencyKey
        : "";
      if (options?.forceLostOnApply) host.setNextOutcome("lost");
      return host.apply({ idempotencyKey: key, payload: args });
    },
    "mcp.effect.query": (args) => {
      const key = typeof (args as { idempotencyKey?: unknown })?.idempotencyKey === "string"
        ? (args as { idempotencyKey: string }).idempotencyKey
        : "";
      if (options?.undecidableQuery) {
        return { found: true, undecidable: true };
      }
      return host.query({ idempotencyKey: key });
    },
  },
  evaluateEffect: (request, bridge) => {
    const applied = bridge.callSync("mcp.effect.apply", {
      idempotencyKey: request.idempotencyKey,
      payload: request.bindings,
    }) as { status: string; record?: { externalId: string }; error?: string };
    if (applied.status === "lost") {
      throw new Error("LOST_RESULT: The host lost the effect result after the external call.");
    }
    if (applied.status === "failed") {
      return {
        "effect.ok": false,
        ...(applied.record ? { "effect.external_id": applied.record.externalId } : {}),
      };
    }
    return {
      "effect.ok": true,
      "effect.external_id": applied.record?.externalId ?? "unknown",
    };
  },
  evaluateReconcile: (request, bridge) => {
    if (options?.undecidableQuery) {
      return { decision: "undecidable" };
    }
    const query = bridge.callSync("mcp.effect.query", {
      idempotencyKey: request.idempotencyKey,
    }) as { found: boolean; outcome?: string; externalId?: string };
    if (!query.found) {
      return { decision: "never-reached", "effect.ok": false };
    }
    if (query.outcome === "failure") {
      return {
        decision: "observed-failure",
        "effect.ok": false,
        ...(query.externalId ? { "effect.external_id": query.externalId } : {}),
      };
    }
    return {
      decision: "observed-success",
      "effect.ok": true,
      "effect.external_id": query.externalId ?? "unknown",
    };
  },
});

describe("M6.3 external effects and reconciliation", () => {
  it("validates an effect node and rejects a mutating reconciliation program", () => {
    const ok = preparedEffect();
    expect(validateDefinition(definition(ok))).toEqual([]);

    const mutatingReconcile = preparedEffect({
      reconcile: baseProgram(
        `return { decision: "observed-success" };`,
        [{
          kind: "mcp",
          server: "effect",
          methods: ["apply"],
          effectClass: "external-effect",
        }],
      ),
    });
    // prepare succeeds; validation rejects mutating reconcile.
    const diagnostics = validateDefinition(definition(mutatingReconcile));
    expect(diagnostics.some((item) => item.code === "effect_reconcile_capability_denied")).toBe(true);
  });

  it("stores requested before the external call starts", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    const host = new MemoryEffectHost();
    const stages: string[] = [];
    let hostCalls = 0;
    const originalApply = host.apply.bind(host);
    host.apply = (input) => {
      hostCalls += 1;
      return originalApply(input);
    };

    const lifecycle = await runDurableEffectLifecycle({
      state: seeded.state,
      executor: makeHostExecutor(host),
      store,
      nodeId: "open-pr",
      attemptId: "effect-1",
      requestedAt: at,
      signal: new AbortController().signal,
      onCommit: (transition) => {
        stages.push(transition.stage);
        if (transition.stage === "request") {
          expect(hostCalls).toBe(0);
          const observation = transition.state.runtime.nodes["open-pr"]?.attempts["effect-1"]?.effectObservation;
          expect(observation?.durableState).toBe("requested");
        }
      },
    });
    expect(lifecycle.ok).toBe(true);
    expect(stages[0]).toBe("request");
    expect(hostCalls).toBe(1);
    if (!lifecycle.ok) return;
    expect(lifecycle.observation.durableState).toBe("observed");
    expect(lifecycle.observation.observedOutcome).toBe("success");
  });

  it("produces indeterminate for a lost result and never silent success", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    const host = new MemoryEffectHost({ nextOutcome: "lost" });

    const lifecycle = await runDurableEffectLifecycle({
      state: seeded.state,
      executor: makeHostExecutor(host, { forceLostOnApply: true }),
      store,
      nodeId: "open-pr",
      attemptId: "effect-lost-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(true);
    if (!lifecycle.ok) return;
    expect(lifecycle.observation.durableState).toBe("indeterminate");
    expect(lifecycle.observation.observedOutcome).toBeUndefined();
    expect(lifecycle.state.runtime.nodes["open-pr"]?.status).toBe("blocked");
    expect(lifecycle.state.runtime.nodes["after-pr"]?.status).toBe("pending");
    expect(lifecycle.state.phase).not.toBe("completed");
    // External side effect happened once.
    expect(host.list()).toHaveLength(1);
  });

  it("blocks dependants while an indeterminate effect is unresolved", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    const host = new MemoryEffectHost({ nextOutcome: "lost" });
    const lifecycle = await runDurableEffectLifecycle({
      state: seeded.state,
      executor: makeHostExecutor(host, { forceLostOnApply: true }),
      store,
      nodeId: "open-pr",
      attemptId: "effect-block-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(true);
    if (!lifecycle.ok) return;
    expect(lifecycle.state.runtime.nodes["open-pr"]?.status).toBe("blocked");
    expect(lifecycle.state.runtime.nodes["after-pr"]?.status).toBe("pending");
    const decision = selectGoalContinuation(lifecycle.state);
    expect(isReconcileEffectDecision(decision)).toBe(true);
  });

  it("derives a stable idempotency key from canonical identity only", () => {
    const left = effectIdempotencyKey({
      workflowId: "wf",
      revision: 1,
      nodeId: "open-pr",
      attemptId: "a1",
    });
    const right = effectIdempotencyKey({
      workflowId: "wf",
      revision: 1,
      nodeId: "open-pr",
      attemptId: "a1",
    });
    const other = effectIdempotencyKey({
      workflowId: "wf",
      revision: 1,
      nodeId: "open-pr",
      attemptId: "a2",
    });
    expect(left).toBe(right);
    expect(left).not.toBe(other);
  });

  it("does not duplicate an external effect for the same idempotency key", async () => {
    const host = new MemoryEffectHost();
    const key = effectIdempotencyKey({
      workflowId: "wf",
      revision: 1,
      nodeId: "open-pr",
      attemptId: "same",
    });
    const first = host.apply({ idempotencyKey: key, payload: { n: 1 } });
    const second = host.apply({ idempotencyKey: key, payload: { n: 2 } });
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(host.list()).toHaveLength(1);
    expect(first.record?.externalId).toBe(second.record?.externalId);
  });

  it("denies an effect capability that the program does not declare", async () => {
    const host = new MemoryEffectHost();
    const executor = new MemoryEffectExecutor({
      handlers: {
        "mcp.other.apply": () => ({ status: "ok" }),
      },
      evaluateEffect: (_request, bridge) => {
        bridge.callSync("mcp.other.apply", {});
        return { "effect.ok": true, "effect.external_id": "x" };
      },
      evaluateReconcile: () => ({ decision: "undecidable" }),
    });
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    const lifecycle = await runDurableEffectLifecycle({
      state: seeded.state,
      executor,
      store,
      nodeId: "open-pr",
      attemptId: "effect-deny-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(true);
    if (!lifecycle.ok) return;
    // Denied bridge call is lost knowledge, not confirmed external failure.
    expect(lifecycle.observation.durableState).toBe("indeterminate");
    expect(host.list()).toHaveLength(0);
  });

  it("reconciles a completed external effect with a lost result to observed success", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    const host = new MemoryEffectHost({ nextOutcome: "lost" });
    const lost = await runDurableEffectLifecycle({
      state: seeded.state,
      executor: makeHostExecutor(host, { forceLostOnApply: true }),
      store,
      nodeId: "open-pr",
      attemptId: "effect-reconcile-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lost.ok).toBe(true);
    if (!lost.ok) return;
    expect(lost.observation.durableState).toBe("indeterminate");

    // Before any new work, reconciliation is selected.
    const decision = selectGoalContinuation(lost.state);
    expect(isReconcileEffectDecision(decision)).toBe(true);

    const reconciled = await runDurableEffectReconcile({
      state: lost.state,
      executor: makeHostExecutor(host),
      store,
      nodeId: "open-pr",
      attemptId: "effect-reconcile-1",
      at: finishedAt,
      signal: new AbortController().signal,
    });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    expect(reconciled.observation.durableState).toBe("observed");
    expect(reconciled.observation.observedOutcome).toBe("success");
    expect(reconciled.state.runtime.nodes["open-pr"]?.status).toBe("succeeded");
    expect(reconciled.state.runtime.facts["effect.external_id"]).toBeDefined();
    // One external record only.
    expect(host.list()).toHaveLength(1);
  });

  it("reconciles a never-reached effect to observed failure", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    // Simulate indeterminate without host side effect: force lost without apply persistence.
    const emptyHost = new MemoryEffectHost();
    // Manually request then mark indeterminate without apply.
    const key = effectIdempotencyKey({
      workflowId: seeded.state.workflowId,
      revision: seeded.state.revision,
      nodeId: "open-pr",
      attemptId: "effect-never-1",
    });
    let state = seeded.state;
    const request = handleCommand(state, {
      type: "request-effect",
      nodeId: "open-pr",
      attemptId: "effect-never-1",
      idempotencyKey: key,
      commandId: "req-never",
      at,
    });
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    state = request.state;
    const indeterminate = handleCommand(state, {
      type: "record-effect-indeterminate",
      nodeId: "open-pr",
      attemptId: "effect-never-1",
      observation: {
        durableState: "indeterminate",
        idempotencyKey: key,
        requestedAt: at,
        reconciliationAttempts: 0,
        evidence: [],
        error: "Lost before external call completed.",
      },
      commandId: "indet-never",
      at,
    });
    expect(indeterminate.ok).toBe(true);
    if (!indeterminate.ok) return;
    state = indeterminate.state;
    store.seed({ events: [...seeded.events, ...request.events, ...indeterminate.events], snapshot: state });

    const reconciled = await runDurableEffectReconcile({
      state,
      executor: makeHostExecutor(emptyHost),
      store,
      nodeId: "open-pr",
      attemptId: "effect-never-1",
      at: finishedAt,
      signal: new AbortController().signal,
    });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    expect(reconciled.observation.durableState).toBe("observed");
    expect(reconciled.observation.observedOutcome).toBe("failure");
    expect(reconciled.state.runtime.nodes["open-pr"]?.status).toBe("failed");
  });

  it("keeps indeterminate and blocks when reconciliation is undecidable", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    const host = new MemoryEffectHost({ nextOutcome: "lost" });
    const lost = await runDurableEffectLifecycle({
      state: seeded.state,
      executor: makeHostExecutor(host, { forceLostOnApply: true }),
      store,
      nodeId: "open-pr",
      attemptId: "effect-undecidable-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lost.ok).toBe(true);
    if (!lost.ok) return;

    const reconciled = await runDurableEffectReconcile({
      state: lost.state,
      executor: makeHostExecutor(host, { undecidableQuery: true }),
      store,
      nodeId: "open-pr",
      attemptId: "effect-undecidable-1",
      at: finishedAt,
      signal: new AbortController().signal,
    });
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    expect(reconciled.observation.durableState).toBe("indeterminate");
    expect(reconciled.observation.lastReconciliationDecision).toBe("undecidable");
    expect(reconciled.state.runtime.nodes["open-pr"]?.status).toBe("blocked");
    expect(reconciled.state.runtime.nodes["after-pr"]?.status).toBe("pending");
  });

  it("runs reconciliation before selecting new work", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    const host = new MemoryEffectHost({ nextOutcome: "lost" });
    const lost = await runDurableEffectLifecycle({
      state: seeded.state,
      executor: makeHostExecutor(host, { forceLostOnApply: true }),
      store,
      nodeId: "open-pr",
      attemptId: "effect-order-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lost.ok).toBe(true);
    if (!lost.ok) return;
    const decision = selectGoalContinuation(lost.state);
    expect(decision.kind).toBe("reconcile-indeterminate-effect");
    expect(isDeterministicEffectDecision(decision)).toBe(true);
  });

  it("keeps execution success separate from external success", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    // Sandbox passes. Host reports external failure through effect.ok: false.
    const executor = new MemoryEffectExecutor({
      evaluateEffect: () => ({ "effect.ok": false, "effect.external_id": "none" }),
      evaluateReconcile: () => ({ decision: "never-reached" }),
    });
    const lifecycle = await runDurableEffectLifecycle({
      state: seeded.state,
      executor,
      store,
      nodeId: "open-pr",
      attemptId: "effect-sep-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(true);
    if (!lifecycle.ok) return;
    expect(lifecycle.observation.executionStatus).toBe("passed");
    expect(lifecycle.observation.durableState).toBe("observed");
    expect(lifecycle.observation.observedOutcome).toBe("failure");
    expect(lifecycle.state.runtime.nodes["open-pr"]?.status).toBe("failed");
  });

  it("stores indeterminate for cancel, error, and timed-out after request", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    for (const mode of ["cancelled", "error", "timed_out"] as const) {
      const store = seededStore(seeded.state, seeded.events);
      const controller = new AbortController();
      const executor = new MemoryEffectExecutor({
        evaluateEffect: () => {
          if (mode === "cancelled") {
            controller.abort();
            throw new Error("cancelled mid-flight");
          }
          if (mode === "timed_out") {
            throw new Error("The code program exceeded its timeout.");
          }
          throw new Error("host transport error after the call may have started");
        },
        evaluateReconcile: () => ({ decision: "undecidable" }),
      });
      if (mode === "cancelled") controller.abort();
      const lifecycle = await runDurableEffectLifecycle({
        state: seeded.state,
        executor,
        store,
        nodeId: "open-pr",
        attemptId: `effect-${mode}-1`,
        requestedAt: at,
        signal: controller.signal,
      });
      expect(lifecycle.ok).toBe(true);
      if (!lifecycle.ok) return;
      expect(lifecycle.observation.durableState).toBe("indeterminate");
      expect(lifecycle.observation.observedOutcome).toBeUndefined();
      if (mode === "timed_out") {
        expect(lifecycle.observation.executionStatus).toBe("timed_out");
      }
    }
  });

  it("recovers a requested-only effect to indeterminate on restore", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const key = effectIdempotencyKey({
      workflowId: seeded.state.workflowId,
      revision: seeded.state.revision,
      nodeId: "open-pr",
      attemptId: "effect-restore-1",
    });
    const requested = handleCommand(seeded.state, {
      type: "request-effect",
      nodeId: "open-pr",
      attemptId: "effect-restore-1",
      idempotencyKey: key,
      commandId: "req-restore",
      at,
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    expect(requested.state.runtime.nodes["open-pr"]?.attempts["effect-restore-1"]?.effectObservation?.durableState)
      .toBe("requested");
    const store = seededStore(requested.state, [...seeded.events, ...requested.events]);
    const recovery = await recoverInterruptedEffects({
      state: requested.state,
      store,
      at: finishedAt,
    });
    expect(recovery.recoveredAttemptIds).toEqual(["effect-restore-1"]);
    const observation = recovery.state.runtime.nodes["open-pr"]?.attempts["effect-restore-1"]?.effectObservation;
    expect(observation?.durableState).toBe("indeterminate");
    expect(observation?.idempotencyKey).toBe(key);
    expect(recovery.state.runtime.nodes["open-pr"]?.status).toBe("blocked");
    const decision = selectGoalContinuation(recovery.state);
    expect(isReconcileEffectDecision(decision)).toBe(true);
  });

  it("rejects concurrent effect executions on the same node", () => {
    const registry = new ActiveEffectExecutionRegistry();
    const first = registry.register({
      workflowId: "wf",
      nodeId: "open-pr",
      attemptId: "a1",
      startedAt: at,
      phase: "effect",
    });
    expect(() => registry.register({
      workflowId: "wf",
      nodeId: "open-pr",
      attemptId: "a2",
      startedAt: at,
      phase: "reconcile",
    })).toThrow(/already has an in-flight/);
    first.release();
  });

  it("fails the workflow when onIndeterminate is fail-workflow", async () => {
    const effect = preparedEffect({ onIndeterminate: "fail-workflow" });
    const created = create(definition(effect));
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    const host = new MemoryEffectHost({ nextOutcome: "lost" });
    const lifecycle = await runDurableEffectLifecycle({
      state: seeded.state,
      executor: makeHostExecutor(host, { forceLostOnApply: true }),
      store,
      nodeId: "open-pr",
      attemptId: "effect-fail-wf-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(true);
    if (!lifecycle.ok) return;
    expect(lifecycle.observation.durableState).toBe("indeterminate");
    expect(lifecycle.state.runtime.nodes["open-pr"]?.status).toBe("failed");
    expect(lifecycle.state.phase).toBe("failed");
  });

  it("injects the idempotency key into sandbox effect programs", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    const key = effectIdempotencyKey({
      workflowId: seeded.state.workflowId,
      revision: seeded.state.revision,
      nodeId: "open-pr",
      attemptId: "effect-key-1",
    });
    let seenKey: string | undefined;
    const codeExecutor = new MemoryCodeExecutor({
      evaluate: (request) => {
        seenKey = String(request.bindings[EFFECT_HOST_BINDING_IDEMPOTENCY_KEY] ?? "");
        return {
          "effect.ok": true,
          "effect.external_id": "from-sandbox",
        };
      },
    });
    const executor = new SandboxEffectExecutor({ codeExecutor });
    const lifecycle = await runDurableEffectLifecycle({
      state: seeded.state,
      executor,
      store,
      nodeId: "open-pr",
      attemptId: "effect-key-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(true);
    if (!lifecycle.ok) return;
    expect(seenKey).toBe(key);
    expect(lifecycle.observation.durableState).toBe("observed");
    expect(lifecycle.observation.observedOutcome).toBe("success");
  });

  it("runs a prepared effect program through QuickJS with the host idempotency key", async () => {
    const keyProgram = `
const key = String(inputs["effect.idempotency_key"]);
const phase = String(inputs["effect.phase"]);
if (phase !== "effect") {
  throw new Error("Expected effect phase.");
}
return {
  "effect.ok": true,
  "effect.external_id": key,
};
`;
    const effectDef = preparedEffect({
      effect: baseProgram(
        keyProgram,
        [{ kind: "pure", effectClass: "pure" }],
        ["seed.ready"],
      ),
      // Reconciliation may use observation capabilities only (empty allowlist is valid for pure returns).
      reconcile: baseProgram(
        `return { decision: "observed-success", "effect.ok": true, "effect.external_id": String(inputs["effect.idempotency_key"]) };`,
        [],
        ["seed.ready"],
      ),
    });
    // Prepare must accept programs that reference host bindings without fact inputs.
    expect(effectDef.effect.inputs).toEqual(["seed.ready"]);
    expect(effectDef.effect.inputs).not.toContain(EFFECT_HOST_BINDING_IDEMPOTENCY_KEY);

    const created = create(definition(effectDef));
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    const key = effectIdempotencyKey({
      workflowId: seeded.state.workflowId,
      revision: seeded.state.revision,
      nodeId: "open-pr",
      attemptId: "effect-quickjs-key-1",
    });
    const executor = new SandboxEffectExecutor({
      codeExecutor: new QuickJSSandboxExecutor({
        capabilityPermit: (capability) => capabilityIsPermittedForRole(capability, "effect"),
      }),
      createCodeExecutor: (role) => new QuickJSSandboxExecutor({
        capabilityPermit: (capability) => capabilityIsPermittedForRole(capability, role),
      }),
    });
    const lifecycle = await runDurableEffectLifecycle({
      state: seeded.state,
      executor,
      store,
      nodeId: "open-pr",
      attemptId: "effect-quickjs-key-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(true);
    if (!lifecycle.ok) return;
    expect(lifecycle.observation.durableState).toBe("observed");
    expect(lifecycle.observation.observedOutcome).toBe("success");
    expect(lifecycle.observation.executionStatus).toBe("passed");
    expect(lifecycle.state.runtime.facts["effect.external_id"]?.value).toBe(key);
    expect(lifecycle.state.runtime.nodes["open-pr"]?.status).toBe("succeeded");
  });

  it("rejects reserved host binding names as declared program inputs", () => {
    const withHostInput = preparedEffect({
      effect: baseProgram(
        `return { "effect.ok": true, "effect.external_id": "x" };`,
        [{ kind: "pure", effectClass: "pure" }],
        ["seed.ready", EFFECT_HOST_BINDING_IDEMPOTENCY_KEY],
      ),
    });
    // Prepare strips reserved names from stored inputs.
    expect(withHostInput.effect.inputs).toEqual(["seed.ready"]);
    // Explicit validation rejects if reserved names remain after prepare.
    const raw = structuredClone(withHostInput);
    raw.effect.inputs = ["seed.ready", EFFECT_HOST_BINDING_IDEMPOTENCY_KEY];
    const diagnostics = validateDefinition(definition(raw));
    expect(diagnostics.some((item) => item.code === "effect_host_binding_input_reserved")).toBe(true);
  });

  it("exposes effect state on the hypagoal status surface", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    const host = new MemoryEffectHost({ nextOutcome: "lost" });
    const lifecycle = await runDurableEffectLifecycle({
      state: seeded.state,
      executor: makeHostExecutor(host, { forceLostOnApply: true }),
      store,
      nodeId: "open-pr",
      attemptId: "effect-status-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(true);
    if (!lifecycle.ok) return;
    const surface = projectHypagoalSurface(lifecycle.state);
    expect(surface?.effects[0]?.durableState).toBe("indeterminate");
    const text = renderHypagoalStatus(lifecycle.state);
    expect(text).toContain("Effect state:");
    expect(text).toContain("open-pr");
    expect(text).toContain("durable indeterminate");
  });

  it("replays effect state without repeating the external call", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    const host = new MemoryEffectHost();
    const lifecycle = await runDurableEffectLifecycle({
      state: seeded.state,
      executor: makeHostExecutor(host),
      store,
      nodeId: "open-pr",
      attemptId: "effect-replay-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(true);
    if (!lifecycle.ok) return;
    const callCount = host.list().length;
    expect(callCount).toBe(1);

    const allEvents = store.read(seeded.state.workflowId)?.events ?? [];
    const replayed = replayEvents(allEvents);
    expect(replayed.runtime.nodes["open-pr"]?.status).toBe(lifecycle.state.runtime.nodes["open-pr"]?.status);
    const observation = Object.values(replayed.runtime.nodes["open-pr"]?.attempts ?? {})
      .map((item) => item.effectObservation)
      .find((item) => item !== undefined);
    expect(observation?.durableState).toBe("observed");
    expect(observation?.observedOutcome).toBe("success");
    // Replay does not call the host again.
    expect(host.list()).toHaveLength(1);
  });

  it("dispatches a ready effect through the deterministic lane", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    const host = new MemoryEffectHost();
    const decision = readyEffect(seeded.state);
    const dispatch = await runDeterministicEffectDispatch({
      state: seeded.state,
      decision,
      dispatchId: "dispatch-effect-1",
      attemptId: "effect-dispatch-1",
      at,
      finishedAt,
      store,
      executor: makeHostExecutor(host),
      registry: new ActiveEffectExecutionRegistry(),
    });
    expect(dispatch.ok).toBe(true);
    if (!dispatch.ok) return;
    expect(dispatch.outcome).toBe("completed");
    expect(dispatch.observation?.durableState).toBe("observed");
    expect(dispatch.state.runtime.nodes["open-pr"]?.status).toBe("succeeded");
  });

  it("shows effect state on the graph projection", async () => {
    const created = create();
    const seeded = seedFacts(created.state, created.events);
    const store = seededStore(seeded.state, seeded.events);
    const host = new MemoryEffectHost({ nextOutcome: "lost" });
    const lifecycle = await runDurableEffectLifecycle({
      state: seeded.state,
      executor: makeHostExecutor(host, { forceLostOnApply: true }),
      store,
      nodeId: "open-pr",
      attemptId: "effect-graph-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(true);
    if (!lifecycle.ok) return;
    const view = projectGraphView(lifecycle.state);
    const node = view.nodes.find((item) => item.id === "open-pr");
    expect(node?.effect?.durableState).toBe("indeterminate");
    expect(node?.status).toBe("blocked");
  });

  it("rejects automatic revision that widens effect authority", () => {
    const base = definition();
    const widened = structuredClone(base);
    const effect = widened.nodes.find((node) => node.id === "open-pr")!.effect!;
    effect.effect.capabilities.push({
      kind: "mcp",
      server: "deploy",
      methods: ["promote"],
      effectClass: "external-effect",
    });
    const diagnostics = validateAutomaticRevision(base, widened);
    expect(diagnostics.some((item) => item.code === "automatic_revision_effect_authority_widened")).toBe(true);
  });
});
