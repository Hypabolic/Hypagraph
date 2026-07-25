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
import { handleCommand } from "./reducer.js";

export type ReadyGateDecision = GoalContinuationStateIdentity & { kind: "evaluate-ready-gate"; nodeId: string; loopId?: string };

export function isReadyGateDecision(decision: GoalContinuationDecision): decision is ReadyGateDecision {
  return decision.kind === "evaluate-ready-gate";
}

export interface DeterministicGateDispatchRequest {
  dispatchId: string;
  decision: ReadyGateDecision;
  at: string;
}

export type DeterministicGateDispatchResult =
  | {
    ok: true;
    state: HypagraphState;
    events: DomainEvent[];
    outcome: "completed";
  }
  | {
    ok: true;
    state: HypagraphState;
    events: DomainEvent[];
    outcome: "failed";
    diagnostics: Diagnostic[];
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

const reject = (code: string, message: string, location?: string): DeterministicGateDispatchResult => ({
  ok: false,
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

const makeEvent = (
  state: HypagraphState,
  request: DeterministicGateDispatchRequest,
  type: DomainEvent["type"],
  data: Record<string, unknown>,
): DomainEvent => {
  const sequence = state.sequence + 1;
  const nodeId = request.decision.nodeId;
  const eventId = sha256({
    workflowId: state.workflowId,
    revision: state.revision,
    sequence,
    commandId: request.dispatchId,
    type,
    nodeId,
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
    nodeId,
    ...(request.decision.loopId ? { loopId: request.decision.loopId } : {}),
    data,
  };
};

const appendEvent = (
  state: HypagraphState,
  events: DomainEvent[],
  request: DeterministicGateDispatchRequest,
  type: DomainEvent["type"],
  data: Record<string, unknown>,
): HypagraphState => {
  const event = makeEvent(state, request, type, data);
  events.push(event);
  return applyEvent(state, event);
};

const validateRequest = (
  state: HypagraphState,
  request: DeterministicGateDispatchRequest,
): DeterministicGateDispatchResult | undefined => {
  const goal = state.goal;
  if (!goal) return reject("goal_not_started", "This workflow has no goal-control state.");
  if (goal.status !== "active" || state.phase !== "running") {
    return reject("goal_not_active", `The goal cannot dispatch a deterministic gate while it is '${goal.status}'.`);
  }
  if (goal.pendingContinuation) {
    return reject("goal_continuation_pending", "A model-lane continuation is already pending.");
  }
  if (goal.actionDispatch?.pending) {
    return reject("action_dispatch_pending", `Action dispatch '${goal.actionDispatch.pending.dispatchId}' is still pending.`);
  }
  if (!request.dispatchId.trim()) return reject("action_dispatch_id_required", "A deterministic gate dispatch requires an ID.", "dispatchId");
  if (!Number.isFinite(Date.parse(request.at))) return reject("action_dispatch_timestamp_invalid", "A deterministic gate dispatch requires a valid timestamp.", "at");

  const decision = request.decision;
  if (decision.goalId !== goal.goalId || decision.workflowId !== state.workflowId) {
    return reject("stale_action_dispatch", "The deterministic gate selection belongs to a different goal or workflow.");
  }
  if (decision.revision !== state.revision || decision.sequence !== state.sequence || decision.snapshotHash !== state.snapshotHash) {
    return reject("stale_action_dispatch", "Canonical state changed before the deterministic gate was dispatched.");
  }
  if (decision.continuationOrdinal !== goal.continuationOrdinal) {
    return reject("stale_action_dispatch", "The scheduler ordinal changed before the deterministic gate was dispatched.");
  }

  const selected = selectGoalContinuation(state);
  if (!isDispatchableGoalContinuation(selected)
    || selected.kind !== "evaluate-ready-gate"
    || !continuationActionMatches(selected, decision)) {
    return reject("stale_action_dispatch", "The selected deterministic gate changed before dispatch.", "decision");
  }
  return undefined;
};

export function dispatchReadyGate(
  state: HypagraphState,
  request: DeterministicGateDispatchRequest,
): DeterministicGateDispatchResult {
  const invalid = validateRequest(state, request);
  if (invalid) return invalid;

  const events: DomainEvent[] = [];
  const schedulerOrdinal = (state.goal?.schedulerOrdinal ?? state.goal?.continuationOrdinal ?? 0) + 1;
  const action = {
    kind: "evaluate-ready-gate" as const,
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
  next = appendEvent(next, events, request, "hypagraph.action.dispatched", {
    dispatchId: request.dispatchId,
  });

  const evaluated = handleCommand(next, {
    type: "evaluate-gate",
    nodeId: request.decision.nodeId,
    commandId: `${request.dispatchId}:evaluate`,
    correlationId: request.dispatchId,
    at: request.at,
  });
  if (!evaluated.ok) {
    next = appendEvent(next, events, request, "hypagraph.action.failed", {
      dispatchId: request.dispatchId,
      reason: evaluated.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"),
    });
    return {
      ok: true,
      state: next,
      events,
      outcome: "failed",
      diagnostics: evaluated.diagnostics,
    };
  }

  next = evaluated.state;
  events.push(...evaluated.events);
  next = appendEvent(next, events, request, "hypagraph.action.completed", {
    dispatchId: request.dispatchId,
  });
  return { ok: true, state: next, events, outcome: "completed" };
}
