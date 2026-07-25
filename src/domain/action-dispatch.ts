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

const terminalStatus = (type: Extract<ActionDispatchLifecycleEvent, { dispatchId: string }>['type']): ActionDispatchTerminalStatus => {
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
    pending.status = "dispatched";
    pending.dispatchedAt = event.timestamp;
    return next;
  }

  if (pending.status !== "dispatched" || !pending.dispatchedAt) {
    throw new Error(`Action dispatch '${pending.dispatchId}' did not reach the dispatched state.`);
  }
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

const legacySelection = (event: DomainEvent): ActionDispatchLifecycleEvent[] => {
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

export function projectLegacyGoalEvent(
  runtime: ActionDispatchRuntime,
  event: DomainEvent,
): ActionDispatchLifecycleEvent[] {
  if (event.type === "hypagraph.goal.continuation-requested") return legacySelection(event);
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
      || event.type === "hypagraph.goal.budget-limited")
  ) {
    return [{
      type: "hypagraph.action.interrupted",
      dispatchId: runtime.pending.dispatchId,
      timestamp: event.timestamp,
      reason: String(event.data.reason ?? "The goal stopped before the model dispatch completed."),
    }];
  }
  return [];
}

export function applyLegacyGoalEvent(
  runtime: ActionDispatchRuntime,
  event: DomainEvent,
): ActionDispatchRuntime {
  return projectLegacyGoalEvent(runtime, event).reduce(applyActionDispatchEvent, runtime);
}
