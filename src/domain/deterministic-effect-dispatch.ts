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

export type ReadyEffectDecision = GoalContinuationStateIdentity & {
  kind: "run-ready-effect";
  nodeId: string;
  loopId?: string;
};

export type ReconcileEffectDecision = GoalContinuationStateIdentity & {
  kind: "reconcile-indeterminate-effect";
  nodeId: string;
  loopId?: string;
};

export type DeterministicEffectDecision = ReadyEffectDecision | ReconcileEffectDecision;

export function isReadyEffectDecision(decision: GoalContinuationDecision): decision is ReadyEffectDecision {
  return decision.kind === "run-ready-effect";
}

export function isReconcileEffectDecision(decision: GoalContinuationDecision): decision is ReconcileEffectDecision {
  return decision.kind === "reconcile-indeterminate-effect";
}

export function isDeterministicEffectDecision(
  decision: GoalContinuationDecision,
): decision is DeterministicEffectDecision {
  return isReadyEffectDecision(decision) || isReconcileEffectDecision(decision);
}

export interface DeterministicEffectDispatchRequest {
  dispatchId: string;
  decision: DeterministicEffectDecision;
  at: string;
}

export type DeterministicEffectDispatchResult =
  | { ok: true; state: HypagraphState; events: DomainEvent[] }
  | { ok: false; diagnostics: Diagnostic[] };

const reject = (code: string, message: string, location?: string): DeterministicEffectDispatchResult => ({
  ok: false,
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

const makeEvent = (
  state: HypagraphState,
  request: DeterministicEffectDispatchRequest,
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
  request: DeterministicEffectDispatchRequest,
  type: DomainEvent["type"],
  data: Record<string, unknown>,
): HypagraphState => {
  const event = makeEvent(state, request, type, data);
  events.push(event);
  return applyEvent(state, event);
};

const validateSelection = (
  state: HypagraphState,
  request: DeterministicEffectDispatchRequest,
): DeterministicEffectDispatchResult | undefined => {
  const goal = state.goal;
  if (!goal) return reject("goal_not_started", "This workflow has no goal-control state.");
  if (goal.status !== "active" || state.phase !== "running") {
    return reject("goal_not_active", `The goal cannot dispatch a deterministic effect while it is '${goal.status}'.`);
  }
  if (goal.pendingContinuation) return reject("goal_continuation_pending", "A model-lane continuation is already pending.");
  if (goal.actionDispatch?.pending) {
    return reject("action_dispatch_pending", `Action dispatch '${goal.actionDispatch.pending.dispatchId}' is still pending.`);
  }
  if (!request.dispatchId.trim()) {
    return reject("action_dispatch_id_required", "A deterministic effect dispatch requires an ID.", "dispatchId");
  }
  if (!Number.isFinite(Date.parse(request.at))) {
    return reject("action_dispatch_timestamp_invalid", "A deterministic effect dispatch requires a valid timestamp.", "at");
  }

  const decision = request.decision;
  if (decision.goalId !== goal.goalId || decision.workflowId !== state.workflowId) {
    return reject("stale_action_dispatch", "The deterministic effect selection belongs to a different goal or workflow.");
  }
  if (decision.revision !== state.revision || decision.sequence !== state.sequence || decision.snapshotHash !== state.snapshotHash) {
    return reject("stale_action_dispatch", "Canonical state changed before the deterministic effect was dispatched.");
  }
  if (decision.continuationOrdinal !== goal.continuationOrdinal) {
    return reject("stale_action_dispatch", "The scheduler ordinal changed before the deterministic effect was dispatched.");
  }

  const selected = selectGoalContinuation(state);
  if (!isDispatchableGoalContinuation(selected)
    || (selected.kind !== "run-ready-effect" && selected.kind !== "reconcile-indeterminate-effect")
    || !continuationActionMatches(selected, decision)) {
    return reject("stale_action_dispatch", "The selected deterministic effect action changed before dispatch.", "decision");
  }
  return undefined;
};

export function beginReadyEffectDispatch(
  state: HypagraphState,
  request: DeterministicEffectDispatchRequest,
): DeterministicEffectDispatchResult {
  const invalid = validateSelection(state, request);
  if (invalid) return invalid;

  const events: DomainEvent[] = [];
  const schedulerOrdinal = (state.goal?.schedulerOrdinal ?? state.goal?.continuationOrdinal ?? 0) + 1;
  const action = {
    kind: request.decision.kind,
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

export function finishReadyEffectDispatch(
  state: HypagraphState,
  request: DeterministicEffectDispatchRequest,
  outcome: "completed" | "failed" | "interrupted",
  reason?: string,
): DeterministicEffectDispatchResult {
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
