import type {
  CheckExecutor,
  CheckResult,
  Diagnostic,
  DomainEvent,
  HypagraphState,
} from "../domain/model.js";
import type { ActiveCheckExecutionRegistry } from "../checks/active-executions.js";
import type {
  DeterministicCheckDispatchRequest,
  ReadyCheckDecision,
} from "../domain/deterministic-check-dispatch.js";
import {
  beginReadyCheckDispatchAndCommit,
  finishReadyCheckDispatchAndCommit,
} from "../persistence/coordinator.js";
import type { WorkflowEventStore } from "../persistence/event-store.js";
import { runPiCheck } from "./check-runner.js";

export type DeterministicCheckOutcome = "completed" | "failed" | "interrupted";

export interface DeterministicCheckDispatchInput {
  state: HypagraphState;
  decision: ReadyCheckDecision;
  dispatchId: string;
  attemptId: string;
  at: string;
  finishedAt?: string;
  store: WorkflowEventStore;
  executor: CheckExecutor;
  registry: ActiveCheckExecutionRegistry;
  /** The controller marks the dispatch stale when the Pi session or branch generation changes. */
  stale?: () => boolean;
  upstreamSignal?: AbortSignal;
  onCommit?: (state: HypagraphState, events: readonly DomainEvent[]) => void;
}

export type DeterministicCheckDispatchResult =
  | {
    ok: false;
    dispatched: false;
    state: HypagraphState;
    events: DomainEvent[];
    diagnostics: Diagnostic[];
  }
  | {
    ok: true;
    dispatched: true;
    stale: boolean;
    state: HypagraphState;
    events: DomainEvent[];
    outcome: DeterministicCheckOutcome;
    reason?: string;
    result?: CheckResult;
  };

const diagnosticText = (diagnostics: readonly Diagnostic[]): string =>
  diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n");

/**
 * Dispatch one ready check in the deterministic lane.
 *
 * The order is durable. The runner stores the selected and dispatched events, runs the
 * existing durable check lifecycle, and then stores one terminal action event. The runner
 * does not change check retry, backoff, artifact, cancellation, or evaluation behaviour.
 */
export async function runDeterministicCheckDispatch(
  input: DeterministicCheckDispatchInput,
): Promise<DeterministicCheckDispatchResult> {
  const request: DeterministicCheckDispatchRequest = {
    dispatchId: input.dispatchId,
    decision: input.decision,
    at: input.at,
  };
  const begun = await beginReadyCheckDispatchAndCommit(input.store, input.state, request);
  if (!begun.ok) {
    return { ok: false, dispatched: false, state: input.state, events: [], diagnostics: begun.diagnostics };
  }

  let state = begun.state;
  const events: DomainEvent[] = [...begun.events];
  input.onCommit?.(state, begun.events);

  const nodeId = input.decision.nodeId;
  let outcome: DeterministicCheckOutcome = "failed";
  let reason: string | undefined;
  let result: CheckResult | undefined;
  const handle = input.registry.register({
    workflowId: state.workflowId,
    nodeId,
    attemptId: input.attemptId,
    startedAt: input.at,
    ...(input.upstreamSignal ? { upstreamSignal: input.upstreamSignal } : {}),
  });

  try {
    const lifecycle = await runPiCheck({
      state,
      executor: input.executor,
      store: input.store,
      nodeId,
      attemptId: input.attemptId,
      requestedAt: input.at,
      signal: handle.signal,
      onTransition: (transition) => {
        if (input.stale?.()) return;
        state = transition.state;
        events.push(...transition.events);
        input.onCommit?.(state, transition.events);
      },
    });
    state = lifecycle.state;
    if (lifecycle.ok) {
      result = lifecycle.result;
      if (lifecycle.result.status === "cancelled" || lifecycle.result.status === "interrupted") {
        outcome = "interrupted";
        reason = lifecycle.result.error?.trim() || `The check attempt was ${lifecycle.result.status}.`;
      } else {
        outcome = "completed";
      }
    } else {
      outcome = "failed";
      reason = diagnosticText(lifecycle.diagnostics);
      if (lifecycle.result) result = lifecycle.result;
    }
  } catch (error) {
    outcome = "failed";
    reason = error instanceof Error ? error.message : String(error);
  } finally {
    handle.release();
  }

  if (input.stale?.()) {
    return { ok: true, dispatched: true, stale: true, state, events, outcome: "interrupted", reason: "The Pi session changed while the check was active.", ...(result ? { result } : {}) };
  }

  const finished = await finishReadyCheckDispatchAndCommit(
    input.store,
    state,
    { ...request, at: input.finishedAt ?? new Date().toISOString() },
    outcome,
    reason,
  );
  if (!finished.ok) {
    return { ok: false, dispatched: false, state, events, diagnostics: finished.diagnostics };
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
    ...(result ? { result } : {}),
  };
}
