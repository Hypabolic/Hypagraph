import { evaluateCheckStart } from "../domain/check-policy.js";
import { evaluateCodeStart } from "../domain/code-policy.js";
import { evaluateEffectStart } from "../domain/effect-policy.js";
import {
  isProtectedEvaluatorNode,
  redactGoalBlockage,
  redactProtectedReason,
  redactStopReason,
} from "../domain/evaluation-presentation.js";
import { protectedTextPolicy } from "../domain/presentation-redaction.js";
import { classifyGoalBlockage, type GoalBlockageDecision } from "../domain/goal-blockage.js";
import { selectGoalContinuation } from "../domain/goal-continuation.js";
import { ACTIVE_ROOT_STATUSES, rootWorkActionIsRunnable } from "../domain/goal-runnable.js";
import type { GoalWorkContinuationAction, HypagraphState, NodeDefinition } from "../domain/model.js";
import { dependenciesAreSatisfied, dependencyStatuses, feedbackEdgeKeys } from "../domain/readiness.js";

export type NotRunnableReason =
  | { kind: "runnable"; action: GoalWorkContinuationAction["kind"] }
  | { kind: "unknown-node" }
  | { kind: "dependency"; blockedBy: Array<{ nodeId: string; status: string }> }
  | { kind: "skipped-route"; gateNodeId?: string; outcomeId?: string }
  | { kind: "terminal"; status: string }
  | { kind: "stale"; revision: number }
  | { kind: "blocked"; reason: string; blockerKind: string }
  | { kind: "loop-not-running"; loopId: string; status: string; exitReason?: string }
  | { kind: "check-policy"; code: string; message: string }
  | { kind: "code-policy"; code: string; message: string }
  | { kind: "effect-policy"; code: string; message: string }
  | { kind: "active-elsewhere"; nodeId: string }
  | { kind: "goal-stopped"; status: string; reason: string }
  | { kind: "awaiting-model-turn"; nodeId?: string };

export interface NodeExplanation {
  nodeId: string;
  status: string;
  kind: string;
  reason: NotRunnableReason;
  summary: string;
  /** The explanation replaced protected evaluator detail with a stable reason. */
  redacted: boolean;
}

export interface GoalExplanation {
  goalStatus?: string;
  decision: string;
  summary: string;
  /** The blockage is a presentation copy. A protected blocker reason is replaced. */
  blockage: GoalBlockageDecision;
  blockageRedacted: boolean;
  runnableNodeIds: string[];
}

const nodeKind = (node: NodeDefinition | undefined): string => node?.kind ?? "task";

const skippedBy = (state: HypagraphState, nodeId: string): { gateNodeId?: string; outcomeId?: string } => {
  for (const [gateNodeId, route] of Object.entries(state.runtime.routes)) {
    if (route.targetNodeIds.includes(nodeId)) continue;
    const gate = state.definition.nodes.find((item) => item.id === gateNodeId)?.gate;
    if (!gate) continue;
    const reachable = [...gate.onTrue, ...gate.onFalse];
    if (reachable.includes(nodeId)) return { gateNodeId, outcomeId: route.outcomeId };
  }
  return {};
};

const unsatisfiedDependencies = (
  state: HypagraphState,
  node: NodeDefinition,
): Array<{ nodeId: string; status: string }> => {
  if (dependenciesAreSatisfied(state, node.id)) return [];
  const statuses = dependencyStatuses(state, node.id) ?? [];
  const feedback = feedbackEdgeKeys(state);
  const required = node.requires.filter((source) => !feedback.has(`${source}\u0000${node.id}`));
  return required
    .map((source, index) => ({ nodeId: source, status: statuses[index] ?? "missing" }))
    .filter((item) => item.status !== "succeeded" && item.status !== "skipped");
};

const activeElsewhere = (state: HypagraphState, nodeId: string): string | undefined =>
  state.definition.nodes.find((node) => node.id !== nodeId
    && ACTIVE_ROOT_STATUSES.has(state.runtime.nodes[node.id]?.status ?? ""))?.id;

const loopReason = (state: HypagraphState, nodeId: string): NotRunnableReason | undefined => {
  const loop = state.definition.loops.find((item) => item.nodes.includes(nodeId));
  if (!loop) return undefined;
  const runtime = state.runtime.loops[loop.id];
  const status = runtime?.status ?? "pending";
  if (status === "pending" || status === "running") return undefined;
  return {
    kind: "loop-not-running",
    loopId: loop.id,
    status,
    ...(runtime?.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
  };
};

const summarize = (nodeId: string, reason: NotRunnableReason): string => {
  switch (reason.kind) {
    case "runnable":
      return `Node '${nodeId}' is runnable. The scheduler can select it as '${reason.action}'.`;
    case "unknown-node":
      return `The workflow has no node '${nodeId}'.`;
    case "dependency": {
      const blockers = reason.blockedBy.map((item) => `'${item.nodeId}' is ${item.status}`).join(", ");
      return `Node '${nodeId}' waits for its dependencies: ${blockers}.`;
    }
    case "skipped-route":
      return reason.gateNodeId
        ? `Node '${nodeId}' was skipped, because gate '${reason.gateNodeId}' selected outcome '${reason.outcomeId}'.`
        : `Node '${nodeId}' was skipped by a route.`;
    case "terminal":
      return `Node '${nodeId}' reached the terminal status '${reason.status}'.`;
    case "stale":
      return `Node '${nodeId}' became stale at revision ${reason.revision}. Its earlier result no longer applies.`;
    case "blocked":
      return `Node '${nodeId}' is blocked as ${reason.blockerKind}: ${reason.reason}`;
    case "loop-not-running":
      return reason.exitReason
        ? `Node '${nodeId}' belongs to loop '${reason.loopId}', which is ${reason.status} through ${reason.exitReason}.`
        : `Node '${nodeId}' belongs to loop '${reason.loopId}', which is ${reason.status}.`;
    case "check-policy":
      return `Check '${nodeId}' cannot start: ${reason.code}: ${reason.message}`;
    case "code-policy":
      return `Code node '${nodeId}' cannot start: ${reason.code}: ${reason.message}`;
    case "effect-policy":
      return `Effect node '${nodeId}' cannot start: ${reason.code}: ${reason.message}`;
    case "active-elsewhere":
      return `Node '${nodeId}' waits, because node '${reason.nodeId}' has an active attempt.`;
    case "goal-stopped":
      return `Node '${nodeId}' waits, because the goal is ${reason.status}: ${reason.reason}`;
    case "awaiting-model-turn":
      return reason.nodeId
        ? `Node '${nodeId}' waits, because the model lane holds a pending action for node '${reason.nodeId}'.`
        : `Node '${nodeId}' waits, because the model lane holds a pending action.`;
  }
};

/**
 * Explain why one node is runnable or is not runnable.
 *
 * The explanation reads canonical state through the existing readiness, check
 * policy, loop, and goal rules. It does not restate those rules.
 */
export function explainNode(state: HypagraphState, nodeId: string): NodeExplanation {
  const node = state.definition.nodes.find((item) => item.id === nodeId);
  const runtime = state.runtime.nodes[nodeId];
  if (!node || !runtime) {
    return {
      nodeId,
      status: "absent",
      kind: "unknown",
      reason: { kind: "unknown-node" },
      summary: summarize(nodeId, { kind: "unknown-node" }),
      redacted: false,
    };
  }

  const kind = nodeKind(node);
  const status = runtime.status;
  const policy = protectedTextPolicy(state);
  const canonicalReason = ((): NotRunnableReason => {
    if (status === "skipped") return { kind: "skipped-route", ...skippedBy(state, nodeId) };
    if (status === "stale") return { kind: "stale", revision: state.revision };
    if (status === "cancelled") return { kind: "terminal", status };
    if (status === "blocked") {
      // A stored blocker reason is free text. It can repeat protected evaluator detail.
      const blocked = redactProtectedReason(
        state.definition,
        nodeId,
        runtime.blockedReason ?? "No reason was stored.",
      );
      return {
        kind: "blocked",
        reason: blocked.reason,
        blockerKind: runtime.blockerKind ?? "unknown",
      };
    }

    const loop = loopReason(state, nodeId);
    if (loop) return loop;

    if (status === "succeeded") return { kind: "terminal", status };

    if (ACTIVE_ROOT_STATUSES.has(status)) {
      return kind === "task"
        ? { kind: "runnable", action: "continue-active-task" }
        : { kind: "terminal", status };
    }

    const active = activeElsewhere(state, nodeId);
    if (active) return { kind: "active-elsewhere", nodeId: active };

    // Structural gating comes first. Check retry eligibility is relevant only once the
    // node is otherwise eligible, so a pending check reports its dependencies and not
    // the check-policy code which describes a node that is simply not ready yet.
    if (status !== "ready" && status !== "failed") {
      const unsatisfied = unsatisfiedDependencies(state, node);
      if (unsatisfied.length > 0) return { kind: "dependency", blockedBy: unsatisfied };
      return { kind: "terminal", status };
    }

    if (kind === "check" && node.check) {
      const unsatisfied = unsatisfiedDependencies(state, node);
      if (unsatisfied.length > 0) return { kind: "dependency", blockedBy: unsatisfied };
      const eligibility = evaluateCheckStart(runtime, node.check, `explain-${state.sequence}-${nodeId}`, state.updatedAt);
      if (!eligibility.ok) {
        return { kind: "check-policy", code: eligibility.diagnostic.code, message: eligibility.diagnostic.message };
      }
    } else if (kind === "code" && node.code) {
      const unsatisfied = unsatisfiedDependencies(state, node);
      if (unsatisfied.length > 0) return { kind: "dependency", blockedBy: unsatisfied };
      const eligibility = evaluateCodeStart(runtime, node.code, `explain-${state.sequence}-${nodeId}`, state.updatedAt);
      if (!eligibility.ok) {
        return { kind: "code-policy", code: eligibility.diagnostic.code, message: eligibility.diagnostic.message };
      }
    } else if (kind === "effect" && node.effect) {
      const unsatisfied = unsatisfiedDependencies(state, node);
      if (unsatisfied.length > 0) return { kind: "dependency", blockedBy: unsatisfied };
      if (runtime.status === "blocked" || runtime.status === "failed") {
        const indeterminate = Object.values(runtime.attempts).some(
          (attempt) => attempt.effectObservation?.durableState === "indeterminate",
        );
        if (indeterminate) {
          return { kind: "runnable", action: "reconcile-indeterminate-effect" };
        }
      }
      const eligibility = evaluateEffectStart(runtime, node.effect, `explain-${state.sequence}-${nodeId}`);
      if (!eligibility.ok) {
        return { kind: "effect-policy", code: eligibility.diagnostic.code, message: eligibility.diagnostic.message };
      }
    } else if (status === "failed") {
      return { kind: "terminal", status };
    }

    const goal = state.goal;
    if (goal && goal.status !== "active") {
      return { kind: "goal-stopped", status: goal.status, reason: goal.stopReason ?? "The goal is not active." };
    }
    const pending = goal?.pendingContinuation?.action;
    if (pending && "nodeId" in pending && pending.nodeId !== nodeId) {
      return { kind: "awaiting-model-turn", nodeId: pending.nodeId };
    }

    const action: GoalWorkContinuationAction = kind === "check"
      ? { kind: "run-ready-check", nodeId }
      : kind === "code"
        ? { kind: "run-ready-code", nodeId }
        : kind === "effect"
          ? { kind: "run-ready-effect", nodeId }
          : kind === "gate"
            ? { kind: "evaluate-ready-gate", nodeId }
            : kind === "interaction"
              ? { kind: "request-ready-interaction", nodeId }
              : { kind: "start-ready-task", nodeId };
    const loopId = state.definition.loops.find((item) => item.nodes.includes(nodeId))?.id;
    const withLoop = { ...action, ...(loopId ? { loopId } : {}) } as GoalWorkContinuationAction;
    if (rootWorkActionIsRunnable(state, withLoop)) return { kind: "runnable", action: action.kind };
    return { kind: "terminal", status };
  })();

  // The policy covers every free-text value which the node reason can repeat, such as the
  // goal stop reason. A per-reason rule alone misses a value which the node does not own.
  const reason = policy.redact(canonicalReason);
  const redacted = (isProtectedEvaluatorNode(state.definition, nodeId)
      && (reason.kind === "blocked" || reason.kind === "check-policy"))
    || JSON.stringify(reason) !== JSON.stringify(canonicalReason);
  return { nodeId, status, kind, reason, summary: summarize(nodeId, reason), redacted };
}

const decisionSummary = (
  state: HypagraphState,
  blockageRedacted: boolean,
): { decision: string; summary: string } => {
  // The stop reason stays free text after the goal leaves the blocked classification, so
  // the policy must cover it. The blockage flag alone reports false at that point.
  const policy = protectedTextPolicy(state);
  const decision = policy.redact(redactStopReason(selectGoalContinuation(state), blockageRedacted));
  switch (decision.kind) {
    case "continue-active-task":
    case "start-ready-task":
    case "run-ready-check":
    case "run-ready-code":
    case "run-ready-effect":
    case "reconcile-indeterminate-effect":
    case "evaluate-ready-gate":
    case "request-ready-interaction":
      return {
        decision: decision.kind,
        summary: `The scheduler selects '${decision.kind}' for node '${decision.nodeId}'.`,
      };
    case "request-revision":
      return {
        decision: decision.kind,
        summary: `The scheduler requests one bounded revision for ${decision.blocker.kind} '${decision.blocker.id}'.`,
      };
    case "stop-completed":
      return { decision: decision.kind, summary: "The canonical workflow completed." };
    case "invariant-error":
      return { decision: decision.kind, summary: `The goal reached an invariant error: ${decision.reason}` };
    default:
      return { decision: decision.kind, summary: `The goal stopped: ${decision.reason}` };
  }
};

/** Explain the canonical goal decision and the runnable work which supports it. */
export function explainGoal(state: HypagraphState): GoalExplanation {
  const blockage = redactGoalBlockage(state, classifyGoalBlockage(state));
  const { decision, summary } = decisionSummary(state, blockage.redacted);
  const runnableNodeIds = state.definition.nodes
    .filter((node) => explainNode(state, node.id).reason.kind === "runnable")
    .map((node) => node.id);
  return {
    ...(state.goal?.status === undefined ? {} : { goalStatus: state.goal.status }),
    decision,
    summary,
    blockage: blockage.decision,
    blockageRedacted: blockage.redacted,
    runnableNodeIds,
  };
}
