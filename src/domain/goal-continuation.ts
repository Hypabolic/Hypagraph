import type {
  GoalBlockerIdentity,
  GoalContinuationAction,
  GoalWorkContinuationAction,
  HypagraphState,
} from "./model.js";
import { blockerIdentityMatches, classifyGoalBlockage } from "./goal-blockage.js";
import { enumerateRootWorkActions, rootWorkActionIsRunnable } from "./goal-runnable.js";

export interface GoalContinuationStateIdentity {
  goalId: string;
  workflowId: string;
  revision: number;
  sequence: number;
  snapshotHash: string;
  continuationOrdinal: number;
}

export type GoalRunnableContinuation = GoalContinuationStateIdentity & GoalWorkContinuationAction;
export type GoalRevisionContinuation = GoalContinuationStateIdentity & { kind: "request-revision"; blocker: GoalBlockerIdentity };
export type GoalDispatchableContinuation = GoalRunnableContinuation | GoalRevisionContinuation;

export type GoalContinuationDecision =
  | GoalDispatchableContinuation
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

export function enumerateGoalContinuationCandidates(state: HypagraphState): GoalRunnableContinuation[] {
  const identity = stateIdentity(state);
  if (!identity || state.goal?.status !== "active" || state.phase !== "running") return [];
  return enumerateRootWorkActions(state).map((action) => ({ ...identity, ...action }));
}

const revisionDecision = (state: HypagraphState, identity: GoalContinuationStateIdentity): GoalRevisionContinuation | { kind: "stop-blocked"; reason: string } | undefined => {
  const blockage = classifyGoalBlockage(state);
  if (blockage.kind === "revision-eligible") return { ...identity, kind: "request-revision", blocker: blockage.blocker };
  if (blockage.kind === "revision-not-allowed" || blockage.kind === "revision-exhausted") return { kind: "stop-blocked", reason: blockage.reason };
  return undefined;
};

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
  if (state.goal.workflowId !== state.workflowId) return { ...identity, kind: "invariant-error", reason: "The goal belongs to a different workflow." };

  switch (state.goal.status) {
    case "completed": return { ...identity, kind: "stop-completed" };
    case "paused": return { ...identity, kind: "stop-paused", reason: state.goal.stopReason ?? "The goal is paused." };
    case "blocked": {
      const revision = revisionDecision(state, identity);
      return revision ? { ...identity, ...revision } : { ...identity, kind: "stop-blocked", reason: state.goal.stopReason ?? "The goal is blocked." };
    }
    case "failed": return { ...identity, kind: "stop-failed", reason: state.goal.stopReason ?? "The goal failed." };
    case "cancelled": return { ...identity, kind: "stop-cancelled", reason: state.goal.stopReason ?? "The goal was cancelled." };
    case "budget_limited": return { ...identity, kind: "stop-budget-limited", reason: state.goal.stopReason ?? "The goal budget is exhausted." };
  }

  if (state.phase !== "running") return { ...identity, kind: "invariant-error", reason: `The active goal does not match workflow phase '${state.phase}'.` };
  const candidates = enumerateGoalContinuationCandidates(state);
  if (candidates.length === 0) {
    const revision = revisionDecision(state, identity);
    return revision ? { ...identity, ...revision } : { ...identity, kind: "invariant-error", reason: "The active goal has no runnable continuation action." };
  }
  return candidates[state.goal.continuationOrdinal % candidates.length]!;
}

export function continuationActionMatches(left: GoalContinuationAction, right: GoalContinuationAction): boolean {
  if (left.kind === "request-revision" || right.kind === "request-revision") {
    return left.kind === "request-revision" && right.kind === "request-revision" && blockerIdentityMatches(left.blocker, right.blocker);
  }
  return left.kind === right.kind && left.nodeId === right.nodeId && (left.loopId ?? null) === (right.loopId ?? null);
}

export function continuationActionIsRunnable(state: HypagraphState, action: GoalContinuationAction): boolean {
  if (action.kind === "request-revision") {
    const goal = state.goal;
    const pending = goal?.pendingContinuation;
    const automatic = goal?.automaticRevision.lastAttempt;
    return goal?.status === "blocked"
      && pending?.action.kind === "request-revision"
      && automatic?.outcome === "pending"
      && automatic.operationId === pending.operationId
      && blockerIdentityMatches(pending.action.blocker, action.blocker);
  }
  return state.goal?.status === "active" && state.phase === "running" && rootWorkActionIsRunnable(state, action);
}

export function isRunnableGoalContinuation(decision: GoalContinuationDecision): decision is GoalRunnableContinuation {
  return decision.kind === "continue-active-task"
    || decision.kind === "start-ready-task"
    || decision.kind === "run-ready-check"
    || decision.kind === "evaluate-ready-gate";
}

export function isDispatchableGoalContinuation(decision: GoalContinuationDecision): decision is GoalDispatchableContinuation {
  return isRunnableGoalContinuation(decision) || decision.kind === "request-revision";
}
