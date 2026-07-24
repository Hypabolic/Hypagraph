import { goalBudgetStop } from "./goal-budget.js";
import { enumerateRootWorkActions, ACTIVE_ROOT_STATUSES } from "./goal-runnable.js";
import type { GoalBlockerIdentity, HypagraphState } from "./model.js";
import { loopFailurePolicy } from "./workflow-outcome.js";

export type GoalBlockageDecision =
  | { kind: "not-blocked" }
  | { kind: "revision-eligible"; blocker: GoalBlockerIdentity }
  | { kind: "revision-not-allowed"; blocker: GoalBlockerIdentity; reason: string }
  | { kind: "revision-exhausted"; blocker: GoalBlockerIdentity; reason: string };

const identity = (
  state: HypagraphState,
  kind: GoalBlockerIdentity["kind"],
  id: string,
  reason: string,
): GoalBlockerIdentity => ({
  kind,
  id,
  reason,
  sourceRevision: state.revision,
  sourceSequence: state.sequence,
  sourceSnapshotHash: state.snapshotHash,
});

const finalize = (
  state: HypagraphState,
  blocker: GoalBlockerIdentity,
  eligible: boolean,
  ineligibleReason?: string,
): GoalBlockageDecision => {
  if (!eligible) return { kind: "revision-not-allowed", blocker, reason: ineligibleReason ?? blocker.reason };
  const revision = state.goal?.automaticRevision;
  if (!revision || revision.consumedAttempts >= revision.maximumAttempts) {
    return { kind: "revision-exhausted", blocker, reason: "The one automatic revision attempt is exhausted." };
  }
  const budgetStop = state.goal ? goalBudgetStop(state.goal.budget, state.updatedAt) : undefined;
  if (budgetStop) {
    return { kind: "revision-not-allowed", blocker, reason: `The goal ${budgetStop.reason === "turn_limit" ? "turn" : "token"} budget is exhausted.` };
  }
  return { kind: "revision-eligible", blocker };
};

export function classifyGoalBlockage(state: HypagraphState): GoalBlockageDecision {
  const goal = state.goal;
  if (!goal) return { kind: "not-blocked" };
  if (goal.pendingContinuation) return { kind: "not-blocked" };
  if (goal.status === "budget_limited") {
    const blocker = identity(state, "terminal-policy", "goal-budget", goal.stopReason ?? "The goal budget is exhausted.");
    return { kind: "revision-not-allowed", blocker, reason: blocker.reason };
  }
  if (goal.status === "paused") {
    const blocker = identity(state, "terminal-policy", `goal-pause:${goal.pauseCause ?? "explicit"}`, goal.stopReason ?? "The goal is paused.");
    return { kind: "revision-not-allowed", blocker, reason: blocker.reason };
  }
  if (goal.status === "failed" || goal.status === "cancelled" || goal.status === "completed") {
    const blocker = identity(state, "terminal-policy", `goal-${goal.status}`, goal.stopReason ?? `The goal is ${goal.status}.`);
    return { kind: "revision-not-allowed", blocker, reason: blocker.reason };
  }
  if (state.phase === "failed" || state.phase === "cancelled" || state.phase === "completed" || state.phase === "paused") {
    const blocker = identity(state, "terminal-policy", `workflow-${state.phase}`, `The workflow is ${state.phase}.`);
    return { kind: "revision-not-allowed", blocker, reason: blocker.reason };
  }
  if (enumerateRootWorkActions(state).length > 0) return { kind: "not-blocked" };
  if (state.definition.nodes.some((node) => ACTIVE_ROOT_STATUSES.has(state.runtime.nodes[node.id]?.status ?? "pending"))) {
    return { kind: "not-blocked" };
  }
  const unsafeAttempt = state.definition.nodes.find((node) => Object.values(state.runtime.nodes[node.id]?.attempts ?? {}).some(
    (attempt) => attempt.status === "running" || attempt.status === "submitted" || attempt.status === "verifying",
  ));
  if (unsafeAttempt) {
    const blocker = identity(state, "terminal-policy", `active-attempt:${unsafeAttempt.id}`, `Node '${unsafeAttempt.id}' retains an active attempt or check which cannot be safely invalidated.`);
    return { kind: "revision-not-allowed", blocker, reason: blocker.reason };
  }

  for (const node of state.definition.nodes) {
    const runtime = state.runtime.nodes[node.id];
    if (runtime?.status !== "blocked") continue;
    const reason = runtime.blockedReason?.trim() || `Node '${node.id}' is blocked.`;
    if (runtime.blockerKind === "repository-work") {
      return finalize(state, identity(state, "blocked-node", node.id, reason), true);
    }
    if (runtime.blockerKind === "external-dependency") {
      return finalize(state, identity(state, "external-dependency", node.id, reason), false, "The blocker is an external dependency and cannot be represented as bounded repository work.");
    }
    if (runtime.blockerKind === "safeguard") {
      return finalize(state, identity(state, "terminal-policy", node.id, reason), false, "Automatic revision cannot bypass a safeguard.");
    }
    return finalize(state, identity(state, "blocked-node", node.id, reason), false, "The blocked node has no typed recoverable repository-work classification.");
  }

  for (const loop of state.definition.loops) {
    const runtime = state.runtime.loops[loop.id];
    if (!runtime) continue;
    if (runtime.status === "requires_revision") {
      return finalize(state, identity(state, "legacy-definition", loop.id, `Loop '${loop.id}' requires a typed success condition.`), true);
    }
    if (runtime.status === "blocked") {
      return finalize(state, identity(state, "blocked-loop", loop.id, runtime.blockedReason ?? `Loop '${loop.id}' is blocked.`), true);
    }
    if (runtime.status === "failed" && loopFailurePolicy(loop) === "block-dependants") {
      const reason = `Loop '${loop.id}' stopped with '${runtime.exitReason ?? "unknown"}' and blocks required dependants.`;
      const recoverable = runtime.exitReason === "evaluation_error";
      return finalize(
        state,
        identity(state, "loop-dependants", loop.id, reason),
        recoverable,
        recoverable ? undefined : "The loop reached a terminal bounded stop. Automatic revision cannot extend or bypass that policy.",
      );
    }
  }

  if (goal.status === "blocked" || state.phase === "blocked" || (goal.status === "active" && state.phase === "running")) {
    return finalize(
      state,
      identity(state, "definition-no-path", "workflow", goal.stopReason ?? "The workflow has no executable path."),
      true,
    );
  }
  return { kind: "not-blocked" };
}

export function blockerIdentityMatches(left: GoalBlockerIdentity, right: GoalBlockerIdentity): boolean {
  return left.kind === right.kind
    && left.id === right.id
    && left.reason === right.reason
    && left.sourceRevision === right.sourceRevision
    && left.sourceSequence === right.sourceSequence
    && left.sourceSnapshotHash === right.sourceSnapshotHash;
}
