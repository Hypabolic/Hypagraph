import type {
  CodeExecutor,
  CodeResult,
  Diagnostic,
  DomainEvent,
  HypagraphState,
} from "../domain/model.js";
import type { ActiveCodeExecutionRegistry } from "../code/active-executions.js";
import { runDurableCodeLifecycle } from "../code/durable-lifecycle.js";
import type {
  DeterministicCodeDispatchRequest,
  ReadyCodeDecision,
} from "../domain/deterministic-code-dispatch.js";
import {
  beginReadyCodeDispatchAndCommit,
  finishReadyCodeDispatchAndCommit,
} from "../persistence/coordinator.js";
import type { WorkflowEventStore } from "../persistence/event-store.js";

export type DeterministicCodeOutcome = "completed" | "failed" | "interrupted";

export interface DeterministicCodeDispatchInput {
  state: HypagraphState;
  decision: ReadyCodeDecision;
  dispatchId: string;
  attemptId: string;
  at: string;
  finishedAt?: string;
  store: WorkflowEventStore;
  executor: CodeExecutor;
  registry: ActiveCodeExecutionRegistry;
  rootDirectory?: string;
  stale?: () => boolean;
  upstreamSignal?: AbortSignal;
  onCommit?: (state: HypagraphState, events: readonly DomainEvent[]) => void;
}

export type DeterministicCodeDispatchRunnerResult =
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
    outcome: DeterministicCodeOutcome;
    reason?: string;
    result?: CodeResult;
  }
  | {
    ok: true;
    dispatched: true;
    stale: boolean;
    state: HypagraphState;
    events: DomainEvent[];
    outcome: DeterministicCodeOutcome;
    reason?: string;
    result?: CodeResult;
  };

const diagnosticText = (diagnostics: readonly Diagnostic[]): string =>
  diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n");

/**
 * Dispatch one ready code node in the deterministic lane.
 * Store selected and dispatched events, run the durable lifecycle, then store one terminal action event.
 */
export async function runDeterministicCodeDispatch(
  input: DeterministicCodeDispatchInput,
): Promise<DeterministicCodeDispatchRunnerResult> {
  const request: DeterministicCodeDispatchRequest = {
    dispatchId: input.dispatchId,
    decision: input.decision,
    at: input.at,
  };
  const begun = await beginReadyCodeDispatchAndCommit(input.store, input.state, request);
  if (!begun.ok) {
    return { ok: false, dispatched: false, state: input.state, events: [], diagnostics: begun.diagnostics };
  }

  let state = begun.state;
  const events: DomainEvent[] = [...begun.events];
  input.onCommit?.(state, begun.events);

  const nodeId = input.decision.nodeId;
  let outcome: DeterministicCodeOutcome = "failed";
  let reason: string | undefined;
  let result: CodeResult | undefined;
  const handle = input.registry.register({
    workflowId: state.workflowId,
    nodeId,
    attemptId: input.attemptId,
    startedAt: input.at,
    ...(input.upstreamSignal ? { upstreamSignal: input.upstreamSignal } : {}),
  });

  try {
    const lifecycle = await runDurableCodeLifecycle({
      state,
      executor: input.executor,
      store: input.store,
      nodeId,
      attemptId: input.attemptId,
      requestedAt: input.at,
      signal: handle.signal,
      ...(input.rootDirectory ? { rootDirectory: input.rootDirectory } : {}),
      onCommit: (transition) => {
        state = transition.state;
        events.push(...transition.events);
        if (!input.stale?.()) input.onCommit?.(state, transition.events);
      },
    });
    state = lifecycle.state;
    if (lifecycle.ok) {
      result = lifecycle.result;
      if (lifecycle.result.status === "cancelled" || lifecycle.result.status === "interrupted") {
        outcome = "interrupted";
        reason = lifecycle.result.error?.trim() || `The code attempt was ${lifecycle.result.status}.`;
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
    return {
      ok: true,
      dispatched: true,
      stale: true,
      state,
      events,
      outcome: "interrupted",
      reason: "The Pi session changed while the code node was active.",
      ...(result ? { result } : {}),
    };
  }

  const finished = await finishReadyCodeDispatchAndCommit(
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
      ...(result ? { result } : {}),
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
    ...(result ? { result } : {}),
  };
}
