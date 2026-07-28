import type {
  Diagnostic,
  DomainEvent,
  EffectExecutor,
  EffectObservation,
  HypagraphState,
} from "../domain/model.js";
import type { ActiveEffectExecutionRegistry } from "../effect/active-executions.js";
import {
  runDurableEffectLifecycle,
  runDurableEffectReconcile,
} from "../effect/durable-lifecycle.js";
import { indeterminateEffectAttempts } from "../domain/effect-policy.js";
import type {
  DeterministicEffectDecision,
  DeterministicEffectDispatchRequest,
} from "../domain/deterministic-effect-dispatch.js";
import {
  beginReadyEffectDispatchAndCommit,
  finishReadyEffectDispatchAndCommit,
} from "../persistence/coordinator.js";
import type { WorkflowEventStore } from "../persistence/event-store.js";

export type DeterministicEffectOutcome = "completed" | "failed" | "interrupted";

export interface DeterministicEffectDispatchInput {
  state: HypagraphState;
  decision: DeterministicEffectDecision;
  dispatchId: string;
  attemptId: string;
  at: string;
  finishedAt?: string;
  store: WorkflowEventStore;
  executor: EffectExecutor;
  registry: ActiveEffectExecutionRegistry;
  forceLostResult?: boolean;
  stale?: () => boolean;
  upstreamSignal?: AbortSignal;
  onCommit?: (state: HypagraphState, events: readonly DomainEvent[]) => void;
}

export type DeterministicEffectDispatchRunnerResult =
  | {
    ok: false;
    dispatched: false;
    state: HypagraphState;
    events: DomainEvent[];
    diagnostics: Diagnostic[];
  }
  | {
    ok: false;
    dispatched: true;
    state: HypagraphState;
    events: DomainEvent[];
    diagnostics: Diagnostic[];
    outcome: DeterministicEffectOutcome;
    reason?: string;
    observation?: EffectObservation;
  }
  | {
    ok: true;
    dispatched: true;
    stale: boolean;
    state: HypagraphState;
    events: DomainEvent[];
    outcome: DeterministicEffectOutcome;
    reason?: string;
    observation?: EffectObservation;
  };

const diagnosticText = (diagnostics: readonly Diagnostic[]): string =>
  diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n");

/**
 * Dispatch one ready effect or reconcile one indeterminate effect in the deterministic lane.
 */
export async function runDeterministicEffectDispatch(
  input: DeterministicEffectDispatchInput,
): Promise<DeterministicEffectDispatchRunnerResult> {
  const request: DeterministicEffectDispatchRequest = {
    dispatchId: input.dispatchId,
    decision: input.decision,
    at: input.at,
  };
  const begun = await beginReadyEffectDispatchAndCommit(input.store, input.state, request);
  if (!begun.ok) {
    return { ok: false, dispatched: false, state: input.state, events: [], diagnostics: begun.diagnostics };
  }

  let state = begun.state;
  const events: DomainEvent[] = [...begun.events];
  input.onCommit?.(state, begun.events);

  const nodeId = input.decision.nodeId;
  let outcome: DeterministicEffectOutcome = "failed";
  let reason: string | undefined;
  let observation: EffectObservation | undefined;

  const phase = input.decision.kind === "reconcile-indeterminate-effect" ? "reconcile" : "effect";
  let attemptId = input.attemptId;
  if (phase === "reconcile") {
    const runtime = state.runtime.nodes[nodeId];
    const indeterminate = runtime ? indeterminateEffectAttempts(runtime) : [];
    if (indeterminate[0]) attemptId = indeterminate[0].attemptId;
  }

  const handle = input.registry.register({
    workflowId: state.workflowId,
    nodeId,
    attemptId,
    startedAt: input.at,
    phase,
    ...(input.upstreamSignal ? { upstreamSignal: input.upstreamSignal } : {}),
  });

  try {
    if (phase === "reconcile") {
      const lifecycle = await runDurableEffectReconcile({
        state,
        executor: input.executor,
        store: input.store,
        nodeId,
        attemptId,
        at: input.at,
        signal: handle.signal,
        onCommit: (transition) => {
          state = transition.state;
          events.push(...transition.events);
          if (!input.stale?.()) input.onCommit?.(state, transition.events);
        },
      });
      state = lifecycle.state;
      if (lifecycle.ok) {
        observation = lifecycle.observation;
        if (lifecycle.observation.durableState === "indeterminate") {
          outcome = "completed";
          reason = lifecycle.observation.error ?? "Reconciliation could not decide.";
        } else {
          outcome = "completed";
        }
      } else {
        outcome = "failed";
        reason = diagnosticText(lifecycle.diagnostics);
        if (lifecycle.observation) observation = lifecycle.observation;
      }
    } else {
      const lifecycle = await runDurableEffectLifecycle({
        state,
        executor: input.executor,
        store: input.store,
        nodeId,
        attemptId,
        requestedAt: input.at,
        signal: handle.signal,
        ...(input.forceLostResult ? { forceLostResult: true } : {}),
        onCommit: (transition) => {
          state = transition.state;
          events.push(...transition.events);
          if (!input.stale?.()) input.onCommit?.(state, transition.events);
        },
      });
      state = lifecycle.state;
      if (lifecycle.ok) {
        observation = lifecycle.observation;
        if (lifecycle.observation.durableState === "indeterminate") {
          outcome = "interrupted";
          reason = lifecycle.observation.error ?? "The effect result is indeterminate.";
        } else {
          outcome = "completed";
        }
      } else {
        outcome = "failed";
        reason = diagnosticText(lifecycle.diagnostics);
        if (lifecycle.observation) observation = lifecycle.observation;
      }
    }
  } catch (error) {
    outcome = "failed";
    reason = error instanceof Error ? error.message : String(error);
  } finally {
    handle.release();
  }

  if (input.stale?.()) {
    return {
      ok: true,
      dispatched: true,
      stale: true,
      state,
      events,
      outcome: "interrupted",
      reason: "The Pi session changed while the effect was active.",
      ...(observation ? { observation } : {}),
    };
  }

  const finished = await finishReadyEffectDispatchAndCommit(
    input.store,
    state,
    { ...request, at: input.finishedAt ?? new Date().toISOString() },
    outcome,
    reason,
  );
  if (!finished.ok) {
    return {
      ok: false,
      dispatched: true,
      state,
      events,
      diagnostics: finished.diagnostics,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(observation ? { observation } : {}),
    };
  }
  state = finished.state;
  events.push(...finished.events);
  input.onCommit?.(state, finished.events);

  return {
    ok: true,
    dispatched: true,
    stale: false,
    state,
    events,
    outcome,
    ...(reason === undefined ? {} : { reason }),
    ...(observation ? { observation } : {}),
  };
}
