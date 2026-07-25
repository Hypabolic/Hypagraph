import type {
  Diagnostic,
  DomainEvent,
  HypagraphState,
} from "./model.js";
import { HYPAGRAPH_EVENT_VERSION } from "./model.js";
import {
  continuationActionMatches,
  isDispatchableGoalContinuation,
  selectGoalContinuation,
  type GoalContinuationDecision,
  type GoalContinuationStateIdentity,
} from "./goal-continuation.js";
import { sha256 } from "./hash.js";
import { applyEvent } from "./projection.js";

export type ReadyCheckDecision = GoalContinuationStateIdentity & {
  kind: "run-ready-check";
  nodeId: string;
  loopId?: string;
};

export function isReadyCheckDecision(decision: GoalContinuationDecision): decision is ReadyCheckDecision {
  return decision.kind === "run-ready-check";
}

export interface DeterministicCheckDispatchRequest {
  dispatchId: string;
  decision: ReadyCheckDecision;
  at: string;
}

export type DeterministicCheckDispatchResult =
  | { ok: true; state: HypagraphState; events: DomainEvent[] }
  | { ok: false; diagnostics: Diagnostic[] };

const reject = (code: string, message: string, location?: string): DeterministicCheckDispatchResult => ({
  ok: false,
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

const makeEvent = (
  state: HypagraphState,
  request: DeterministicCheckDispatchRequest,
  type: DomainEvent["type"],
  data: Record<string, unknown>,
): DomainEvent => {
  const sequence = state.sequence + 1;
  const eventId = sha256({
    workflowId: state.workflowId,
    revision: state.revision,
    sequence,
    commandId: request.dispatchId,
    type,
    nodeId: request.decision.nodeId,
    attemptId: null,
    loopId: request.decision.loopId ?? null,
  });
  return {
    eventId,
    workflowId: state.workflowId,
    revision: state.revision,
    sequence,
    type,
    version: HYPAGRAPH_EVENT_VERSION,
    timestamp: request.at,
    causationId: request.dispatchId,
    correlationId: request.dispatchId,
    nodeId: request.decision.nodeId,
    ...(request.decision.loopId ? { loopId: request.decision.loopId } : {}),
    data,
  };
};

const appendEvent = (
  state: HypagraphState,
  events: DomainEvent[],
  request: DeterministicCheckDispatchRequest,
  type: DomainEvent["type"],
  data: Record<string, unknown>,
): HypagraphState => {
  const event = makeEvent(state, request, type, data);
  events.push(event);
  return applyEvent(state, event);
};

const validateSelection = (
  state: HypagraphState,
  request: DeterministicCheckDispatchRequest,
): DeterministicCheckDispatchResult | undefined => {
  const goal = state.goal;
  if (!goal) return reject("goal_not_started", "This workflow has no goal-control state.");
  if (goal.status !== "active" || state.phase !== "running") {
    return reject("goal_not_active", `The goal cannot dispatch a deterministic check while it is '${goal.status}'.`);
  }
  if (goal.pendingContinuation) return reject("goal_continuation_pending", "A model-lane continuation is already pending.");
  if (goal.actionDispatch?.pending) {
    return reject("action_dispatch_pending", `Action dispatch '${goal.actionDispatch.pending.dispatchId}' is still pending.`);
  }
  if (!request.dispatchId.trim()) return reject("action_dispatch_id_required", "A deterministic check dispatch requires an ID.", "dispatchId");
  if (!Number.isFinite(Date.parse(request.at))) return reject("action_dispatch_timestamp_invalid", "A deterministic check dispatch requires a valid timestamp.", "at");

  const decision = request.decision;
  if (decision.goalId !== goal.goalId || decision.workflowId !== state.workflowId) {
    return reject("stale_action_dispatch", "The deterministic check selection belongs to a different goal or workflow.");
  }
  if (decision.revision !== state.revision || decision.sequence !== state.sequence || decision.snapshotHash !== state.snapshotHash) {
    return reject("stale_action_dispatch", "Canonical state changed before the deterministic check was dispatched.");
  }
  if (decision.continuationOrdinal !== goal.continuationOrdinal) {
    return reject("stale_action_dispatch", "The scheduler ordinal changed before the deterministic check was dispatched.");
  }

  const selected = selectGoalContinuation(state);
  if (!isDispatchableGoalContinuation(selected)
    || selected.kind !== "run-ready-check"
    || !continuationActionMatches(selected, decision)) {
    return reject("stale_action_dispatch", "The selected deterministic check changed before dispatch.", "decision");
  }
  return undefined;
};

export function beginReadyCheckDispatch(
  state: HypagraphState,
  request: DeterministicCheckDispatchRequest,
): DeterministicCheckDispatchResult {
  const invalid = validateSelection(state, request);
  if (invalid) return invalid;

  const events: DomainEvent[] = [];
  const schedulerOrdinal = (state.goal?.schedulerOrdinal ?? state.goal?.continuationOrdinal ?? 0) + 1;
  const action = {
    kind: "run-ready-check" as const,
    nodeId: request.decision.nodeId,
    ...(request.decision.loopId ? { loopId: request.decision.loopId } : {}),
  };
  let next = appendEvent(state, events, request, "hypagraph.action.selected", {
    dispatch: {
      dispatchId: request.dispatchId,
      action,
      lane: "deterministic",
      selectedSequence: state.sequence,
      selectedSnapshotHash: state.snapshotHash,
      schedulerOrdinal,
    },
  });
  next = appendEvent(next, events, request, "hypagraph.action.dispatched", { dispatchId: request.dispatchId });
  return { ok: true, state: next, events };
}

export function finishReadyCheckDispatch(
  state: HypagraphState,
  request: DeterministicCheckDispatchRequest,
  outcome: "completed" | "failed" | "interrupted",
  reason?: string,
): DeterministicCheckDispatchResult {
  const pending = state.goal?.actionDispatch?.pending;
  if (!pending || pending.dispatchId !== request.dispatchId) {
    return reject("action_dispatch_not_pending", `Action dispatch '${request.dispatchId}' is not pending.`);
  }
  const type = outcome === "completed"
    ? "hypagraph.action.completed"
    : outcome === "failed"
      ? "hypagraph.action.failed"
      : "hypagraph.action.interrupted";
  const events: DomainEvent[] = [];
  const next = appendEvent(state, events, request, type, {
    dispatchId: request.dispatchId,
    ...(reason ? { reason } : {}),
  });
  return { ok: true, state: next, events };
}
