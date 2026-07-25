import type { DomainEvent, GoalContinuationAction } from "./model.js";

export type DispatchLane = "deterministic" | "model" | "executor";
export type ActionDispatchPendingStatus = "selected" | "dispatched";
export type ActionDispatchTerminalStatus = "completed" | "failed" | "interrupted";

export interface ActionDispatch {
  dispatchId: string;
  action: GoalContinuationAction;
  lane: DispatchLane;
  selectedSequence: number;
  selectedSnapshotHash: string;
  schedulerOrdinal: number;
}

export interface PendingActionDispatch extends ActionDispatch {
  status: ActionDispatchPendingStatus;
  selectedAt: string;
  dispatchedAt?: string;
}

export interface ActionDispatchOutcome extends ActionDispatch {
  status: ActionDispatchTerminalStatus;
  selectedAt: string;
  dispatchedAt: string;
  completedAt: string;
  reason?: string;
}

export interface ActionDispatchRuntime {
  schedulerOrdinal: number;
  pending?: PendingActionDispatch;
  lastOutcome?: ActionDispatchOutcome;
}

export type ActionDispatchLifecycleEvent =
  | {
    type: "hypagraph.action.selected";
    dispatch: ActionDispatch;
    timestamp: string;
  }
  | {
    type: "hypagraph.action.dispatched";
    dispatchId: string;
    timestamp: string;
  }
  | {
    type: "hypagraph.action.completed" | "hypagraph.action.failed" | "hypagraph.action.interrupted";
    dispatchId: string;
    timestamp: string;
    reason?: string;
  };

export const createActionDispatchRuntime = (): ActionDispatchRuntime => ({ schedulerOrdinal: 0 });

const requireNonEmpty = (value: string, name: string): void => {
  if (!value.trim()) throw new Error(`An action dispatch requires a non-empty ${name}.`);
};

const requireTimestamp = (value: string): void => {
  if (!Number.isFinite(Date.parse(value))) throw new Error("An action dispatch requires a valid timestamp.");
};

const requireSafeInteger = (value: number, name: string, minimum: number): void => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`An action dispatch requires a valid ${name}.`);
};

const requireLane = (lane: DispatchLane): void => {
  if (lane !== "deterministic" && lane !== "model" && lane !== "executor") {
    throw new Error("An action dispatch requires a valid lane.");
  }
};

const requireAction = (action: GoalContinuationAction): void => {
  if (!action || typeof action !== "object" || typeof action.kind !== "string" || !action.kind.trim()) {
    throw new Error("An action dispatch requires a valid action.");
  }
};

const requireOrderedTimestamp = (value: string, previous: string, message: string): void => {
  if (Date.parse(value) < Date.parse(previous)) throw new Error(message);
};

const terminalStatus = (type: Extract<ActionDispatchLifecycleEvent, { dispatchId: string }>["type"]): ActionDispatchTerminalStatus => {
  if (type === "hypagraph.action.completed") return "completed";
  if (type === "hypagraph.action.failed") return "failed";
  if (type === "hypagraph.action.interrupted") return "interrupted";
  throw new Error(`Event '${type}' is not a terminal action-dispatch event.`);
};

export function applyActionDispatchEvent(
  runtime: ActionDispatchRuntime,
  event: ActionDispatchLifecycleEvent,
): ActionDispatchRuntime {
  requireTimestamp(event.timestamp);
  const next = structuredClone(runtime);

  if (event.type === "hypagraph.action.selected") {
    if (next.pending) throw new Error(`Action dispatch '${next.pending.dispatchId}' is still pending.`);
    requireNonEmpty(event.dispatch.dispatchId, "dispatch ID");
    requireAction(event.dispatch.action);
    requireLane(event.dispatch.lane);
    requireNonEmpty(event.dispatch.selectedSnapshotHash, "selected snapshot hash");
    requireSafeInteger(event.dispatch.selectedSequence, "selected sequence", 0);
    requireSafeInteger(event.dispatch.schedulerOrdinal, "scheduler ordinal", 1);
    if (event.dispatch.schedulerOrdinal !== next.schedulerOrdinal + 1) {
      throw new Error("An action-selected event has a non-contiguous scheduler ordinal.");
    }
    next.schedulerOrdinal = event.dispatch.schedulerOrdinal;
    next.pending = {
      ...structuredClone(event.dispatch),
      status: "selected",
      selectedAt: event.timestamp,
    };
    return next;
  }

  const pending = next.pending;
  if (!pending) throw new Error(`Action-dispatch event '${event.type}' requires a pending dispatch.`);
  if (event.dispatchId !== pending.dispatchId) throw new Error("An action-dispatch event belongs to a different dispatch.");

  if (event.type === "hypagraph.action.dispatched") {
    if (pending.status !== "selected") throw new Error(`Action dispatch '${pending.dispatchId}' was already dispatched.`);
    requireOrderedTimestamp(event.timestamp, pending.selectedAt, "An action cannot be dispatched before it was selected.");
    pending.status = "dispatched";
    pending.dispatchedAt = event.timestamp;
    return next;
  }

  if (pending.status !== "dispatched" || !pending.dispatchedAt) {
    throw new Error(`Action dispatch '${pending.dispatchId}' did not reach the dispatched state.`);
  }
  requireOrderedTimestamp(event.timestamp, pending.dispatchedAt, "An action cannot complete before it was dispatched.");
  const status = terminalStatus(event.type);
  next.lastOutcome = {
    dispatchId: pending.dispatchId,
    action: structuredClone(pending.action),
    lane: pending.lane,
    selectedSequence: pending.selectedSequence,
    selectedSnapshotHash: pending.selectedSnapshotHash,
    schedulerOrdinal: pending.schedulerOrdinal,
    status,
    selectedAt: pending.selectedAt,
    dispatchedAt: pending.dispatchedAt,
    completedAt: event.timestamp,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
  };
  delete next.pending;
  return next;
}

const asDispatch = (value: unknown): ActionDispatch => {
  if (!value || typeof value !== "object") throw new Error("An action-selected event requires dispatch data.");
  const dispatch = value as Partial<ActionDispatch>;
  return {
    dispatchId: String(dispatch.dispatchId ?? ""),
    action: structuredClone(dispatch.action as GoalContinuationAction),
    lane: dispatch.lane as DispatchLane,
    selectedSequence: Number(dispatch.selectedSequence),
    selectedSnapshotHash: String(dispatch.selectedSnapshotHash ?? ""),
    schedulerOrdinal: Number(dispatch.schedulerOrdinal),
  };
};

const canonicalActionEvent = (event: DomainEvent): ActionDispatchLifecycleEvent[] => {
  if (event.type === "hypagraph.action.selected") {
    return [{ type: event.type, dispatch: asDispatch(event.data.dispatch), timestamp: event.timestamp }];
  }
  if (event.type === "hypagraph.action.dispatched") {
    return [{ type: event.type, dispatchId: String(event.data.dispatchId ?? ""), timestamp: event.timestamp }];
  }
  if (event.type === "hypagraph.action.completed" || event.type === "hypagraph.action.failed" || event.type === "hypagraph.action.interrupted") {
    return [{
      type: event.type,
      dispatchId: String(event.data.dispatchId ?? ""),
      timestamp: event.timestamp,
      ...(event.data.reason === undefined ? {} : { reason: String(event.data.reason) }),
    }];
  }
  return [];
};

const modelLaneSelection = (event: DomainEvent): ActionDispatchLifecycleEvent[] => {
  const dispatchId = String(event.data.operationId ?? "");
  return [
    {
      type: "hypagraph.action.selected",
      dispatch: {
        dispatchId,
        action: structuredClone(event.data.action as GoalContinuationAction),
        lane: "model",
        selectedSequence: Number(event.data.selectedSequence),
        selectedSnapshotHash: String(event.data.selectedSnapshotHash ?? ""),
        schedulerOrdinal: Number(event.data.ordinal),
      },
      timestamp: event.timestamp,
    },
    {
      type: "hypagraph.action.dispatched",
      dispatchId,
      timestamp: event.timestamp,
    },
  ];
};

export function projectGoalEventToActionDispatch(
  runtime: ActionDispatchRuntime,
  event: DomainEvent,
): ActionDispatchLifecycleEvent[] {
  const canonical = canonicalActionEvent(event);
  if (canonical.length > 0) return canonical;
  if (event.type === "hypagraph.goal.continuation-requested") return modelLaneSelection(event);
  if (event.type === "hypagraph.goal.turn-recorded") {
    return [{
      type: "hypagraph.action.completed",
      dispatchId: String(event.data.continuationOperationId ?? ""),
      timestamp: event.timestamp,
    }];
  }
  if (event.type === "hypagraph.goal.continuation-abandoned") {
    return [{
      type: "hypagraph.action.interrupted",
      dispatchId: String(event.data.operationId ?? ""),
      timestamp: event.timestamp,
      reason: String(event.data.reason ?? "The model dispatch was abandoned."),
    }];
  }
  if (
    runtime.pending
    && (event.type === "hypagraph.goal.paused"
      || event.type === "hypagraph.goal.cancelled"
      || event.type === "hypagraph.goal.budget-limited"
      || event.type === "hypagraph.goal.completed"
      || event.type === "hypagraph.goal.failed")
  ) {
    return [{
      type: "hypagraph.action.interrupted",
      dispatchId: runtime.pending.dispatchId,
      timestamp: event.timestamp,
      reason: String(event.data.reason ?? "The goal stopped before the action dispatch completed."),
    }];
  }
  return [];
}

export function applyGoalEventToActionDispatch(
  runtime: ActionDispatchRuntime,
  event: DomainEvent,
): ActionDispatchRuntime {
  return projectGoalEventToActionDispatch(runtime, event).reduce(applyActionDispatchEvent, runtime);
}

export function validateActionDispatchRuntime(runtime: ActionDispatchRuntime): void {
  requireSafeInteger(runtime.schedulerOrdinal, "scheduler ordinal", 0);
  const pending = runtime.pending;
  if (pending) {
    requireNonEmpty(pending.dispatchId, "dispatch ID");
    requireAction(pending.action);
    requireLane(pending.lane);
    requireNonEmpty(pending.selectedSnapshotHash, "selected snapshot hash");
    requireSafeInteger(pending.selectedSequence, "selected sequence", 0);
    requireSafeInteger(pending.schedulerOrdinal, "scheduler ordinal", 1);
    requireTimestamp(pending.selectedAt);
    if (pending.schedulerOrdinal !== runtime.schedulerOrdinal) {
      throw new Error("A pending action dispatch does not match the scheduler ordinal.");
    }
    if (pending.status === "dispatched") {
      if (!pending.dispatchedAt) throw new Error("A dispatched action is missing its dispatch timestamp.");
      requireTimestamp(pending.dispatchedAt);
      requireOrderedTimestamp(pending.dispatchedAt, pending.selectedAt, "An action cannot be dispatched before it was selected.");
    } else if (pending.dispatchedAt !== undefined) {
      throw new Error("A selected action has an unexpected dispatch timestamp.");
    }
  }
  const outcome = runtime.lastOutcome;
  if (outcome) {
    requireNonEmpty(outcome.dispatchId, "dispatch ID");
    requireAction(outcome.action);
    requireLane(outcome.lane);
    requireNonEmpty(outcome.selectedSnapshotHash, "selected snapshot hash");
    requireSafeInteger(outcome.selectedSequence, "selected sequence", 0);
    requireSafeInteger(outcome.schedulerOrdinal, "scheduler ordinal", 1);
    requireTimestamp(outcome.selectedAt);
    requireTimestamp(outcome.dispatchedAt);
    requireTimestamp(outcome.completedAt);
    requireOrderedTimestamp(outcome.dispatchedAt, outcome.selectedAt, "An action cannot be dispatched before it was selected.");
    requireOrderedTimestamp(outcome.completedAt, outcome.dispatchedAt, "An action cannot complete before it was dispatched.");
    if (outcome.schedulerOrdinal > runtime.schedulerOrdinal) {
      throw new Error("An action outcome is ahead of the scheduler ordinal.");
    }
  }
}

/** @deprecated Use projectGoalEventToActionDispatch. */
export const projectLegacyGoalEvent = projectGoalEventToActionDispatch;
/** @deprecated Use applyGoalEventToActionDispatch. */
export const applyLegacyGoalEvent = applyGoalEventToActionDispatch;
