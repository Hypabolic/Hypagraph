import { checkCanStartWithoutWaiting } from "./check-policy.js";
import type {
  GoalContinuationAction,
  HypagraphState,
  NodeDefinition,
} from "./model.js";

const ACTIVE_STATUSES = new Set(["starting", "running", "awaiting_evidence", "verifying"]);

export interface GoalContinuationStateIdentity {
  goalId: string;
  workflowId: string;
  revision: number;
  sequence: number;
  snapshotHash: string;
  continuationOrdinal: number;
}

export type GoalRunnableContinuation = GoalContinuationStateIdentity & GoalContinuationAction;

export type GoalContinuationDecision =
  | GoalRunnableContinuation
  | (GoalContinuationStateIdentity & { kind: "stop-completed" })
  | (GoalContinuationStateIdentity & { kind: "stop-paused"; reason: string })
  | (GoalContinuationStateIdentity & { kind: "stop-blocked"; reason: string })
  | (GoalContinuationStateIdentity & { kind: "stop-failed"; reason: string })
  | (GoalContinuationStateIdentity & { kind: "stop-cancelled"; reason: string })
  | (GoalContinuationStateIdentity & { kind: "stop-budget-limited"; reason: string })
  | {
    kind: "invariant-error";
    reason: string;
    goalId?: string;
    workflowId?: string;
    revision?: number;
    sequence?: number;
    snapshotHash?: string;
    continuationOrdinal?: number;
  };

const stateIdentity = (state: HypagraphState): GoalContinuationStateIdentity | undefined => {
  if (!state.goal) return undefined;
  return {
    goalId: state.goal.goalId,
    workflowId: state.workflowId,
    revision: state.revision,
    sequence: state.sequence,
    snapshotHash: state.snapshotHash,
    continuationOrdinal: state.goal.continuationOrdinal,
  };
};

const loopIdForNode = (state: HypagraphState, nodeId: string): string | undefined =>
  state.definition.loops.find((loop) => loop.nodes.includes(nodeId))?.id;

const actionForReadyNode = (
  state: HypagraphState,
  node: NodeDefinition,
): GoalContinuationAction | undefined => {
  const runtime = state.runtime.nodes[node.id];
  if (!runtime) return undefined;
  const kind = node.kind ?? "task";
  const loopId = loopIdForNode(state, node.id);
  if (kind === "task" && runtime.status === "ready") {
    return { kind: "start-ready-task", nodeId: node.id, ...(loopId ? { loopId } : {}) };
  }
  if (kind === "gate" && runtime.status === "ready") {
    return { kind: "evaluate-ready-gate", nodeId: node.id, ...(loopId ? { loopId } : {}) };
  }
  if (kind === "check" && node.check && checkCanStartWithoutWaiting(runtime, node.check)) {
    return { kind: "run-ready-check", nodeId: node.id, ...(loopId ? { loopId } : {}) };
  }
  return undefined;
};

export function enumerateGoalContinuationCandidates(state: HypagraphState): GoalRunnableContinuation[] {
  const identity = stateIdentity(state);
  if (!identity || state.goal?.status !== "active" || state.phase !== "running") return [];

  const active = state.definition.nodes.filter((node) => ACTIVE_STATUSES.has(state.runtime.nodes[node.id]?.status ?? "pending"));
  if (active.length === 1) {
    const node = active[0]!;
    if ((node.kind ?? "task") !== "task") return [];
    const loopId = loopIdForNode(state, node.id);
    return [{ ...identity, kind: "continue-active-task", nodeId: node.id, ...(loopId ? { loopId } : {}) }];
  }
  if (active.length > 1) return [];

  return state.definition.nodes.flatMap((node) => {
    const action = actionForReadyNode(state, node);
    return action ? [{ ...identity, ...action }] : [];
  });
}

export function selectGoalContinuation(state: HypagraphState): GoalContinuationDecision {
  const identity = stateIdentity(state);
  if (!identity || !state.goal) {
    return {
      kind: "invariant-error",
      reason: "The workflow has no goal-control state.",
      workflowId: state.workflowId,
      revision: state.revision,
      sequence: state.sequence,
      snapshotHash: state.snapshotHash,
    };
  }
  if (state.goal.workflowId !== state.workflowId) {
    return { ...identity, kind: "invariant-error", reason: "The goal belongs to a different workflow." };
  }

  switch (state.goal.status) {
    case "completed": return { ...identity, kind: "stop-completed" };
    case "paused": return { ...identity, kind: "stop-paused", reason: state.goal.stopReason ?? "The goal is paused." };
    case "blocked": return { ...identity, kind: "stop-blocked", reason: state.goal.stopReason ?? "The goal is blocked." };
    case "failed": return { ...identity, kind: "stop-failed", reason: state.goal.stopReason ?? "The goal failed." };
    case "cancelled": return { ...identity, kind: "stop-cancelled", reason: state.goal.stopReason ?? "The goal was cancelled." };
    case "budget_limited": return { ...identity, kind: "stop-budget-limited", reason: state.goal.stopReason ?? "The goal budget is exhausted." };
  }

  if (state.phase !== "running") {
    return { ...identity, kind: "invariant-error", reason: `The active goal does not match workflow phase '${state.phase}'.` };
  }

  const active = state.definition.nodes.filter((node) => ACTIVE_STATUSES.has(state.runtime.nodes[node.id]?.status ?? "pending"));
  if (active.length > 1) {
    return { ...identity, kind: "invariant-error", reason: "More than one node has an active attempt." };
  }
  if (active.length === 1 && (active[0]!.kind ?? "task") !== "task") {
    return { ...identity, kind: "invariant-error", reason: `Active node '${active[0]!.id}' is not a task continuation.` };
  }

  const candidates = enumerateGoalContinuationCandidates(state);
  if (candidates.length === 0) {
    return { ...identity, kind: "invariant-error", reason: "The active goal has no runnable continuation action." };
  }
  return candidates[state.goal.continuationOrdinal % candidates.length]!;
}

export function continuationActionMatches(
  left: GoalContinuationAction,
  right: GoalContinuationAction,
): boolean {
  return left.kind === right.kind
    && left.nodeId === right.nodeId
    && (left.loopId ?? null) === (right.loopId ?? null);
}

export function continuationActionIsRunnable(
  state: HypagraphState,
  action: GoalContinuationAction,
): boolean {
  if (!state.goal || state.goal.status !== "active" || state.phase !== "running") return false;
  const node = state.definition.nodes.find((candidate) => candidate.id === action.nodeId);
  const runtime = state.runtime.nodes[action.nodeId];
  if (!node || !runtime || loopIdForNode(state, action.nodeId) !== action.loopId) return false;
  const kind = node.kind ?? "task";
  if (action.kind === "continue-active-task") return kind === "task" && ACTIVE_STATUSES.has(runtime.status);
  if (action.kind === "start-ready-task") return kind === "task" && runtime.status === "ready";
  if (action.kind === "evaluate-ready-gate") return kind === "gate" && runtime.status === "ready";
  return kind === "check" && !!node.check && checkCanStartWithoutWaiting(runtime, node.check);
}

export function isRunnableGoalContinuation(
  decision: GoalContinuationDecision,
): decision is GoalRunnableContinuation {
  return decision.kind === "continue-active-task"
    || decision.kind === "start-ready-task"
    || decision.kind === "run-ready-check"
    || decision.kind === "evaluate-ready-gate";
}
