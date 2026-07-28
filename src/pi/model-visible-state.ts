import {
  PROTECTED_REASON,
  protectedBlockerReason,
  shortEvaluatorFingerprint,
} from "../domain/evaluation-presentation.js";
import { classifyGoalBlockage } from "../domain/goal-blockage.js";
import type { HypagraphState } from "../domain/model.js";
import { projectAllTaskContexts, projectTaskContext } from "../domain/task-context.js";
import { projectGraphView, type GraphViewModel } from "../graph/projection.js";
import { workflowSummary } from "../ui/format.js";

export function projectModelVisibleGraphView(state: HypagraphState): GraphViewModel {
  const view = structuredClone(projectGraphView(state));
  for (const loop of view.loops) {
    if (loop.evaluator?.evaluatorFingerprint) {
      loop.evaluator.evaluatorFingerprint = shortEvaluatorFingerprint(loop.evaluator.evaluatorFingerprint);
    }
  }
  for (const node of view.nodes) {
    if (node.evaluator?.evaluatorFingerprint) {
      node.evaluator.evaluatorFingerprint = shortEvaluatorFingerprint(node.evaluator.evaluatorFingerprint);
    }
    if (node.check?.evaluator?.evaluatorFingerprint) {
      node.check.evaluator.evaluatorFingerprint = shortEvaluatorFingerprint(node.check.evaluator.evaluatorFingerprint);
    }
  }
  return view;
}

/**
 * Replace every copy of a protected blocker reason inside a cloned canonical value.
 *
 * `workflowSummary` copies canonical goal state, which holds the exact blocker reason,
 * because the automatic revision binds to that text.
 */
const redactProtectedText = (value: unknown, secret: string): unknown => {
  if (typeof value === "string") return value === secret ? PROTECTED_REASON : value;
  if (Array.isArray(value)) return value.map((item) => redactProtectedText(item, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, redactProtectedText(item, secret)]),
    );
  }
  return value;
};

export function projectModelVisibleWorkflowSummary(state: HypagraphState): Record<string, unknown> {
  const secret = protectedBlockerReason(state, classifyGoalBlockage(state));
  const summary = structuredClone(workflowSummary(state));
  const loops = summary.loops;
  if (Array.isArray(loops)) {
    for (const item of loops) {
      if (!item || typeof item !== "object") continue;
      const evaluator = (item as { evaluator?: { evaluatorFingerprint?: string } }).evaluator;
      if (evaluator?.evaluatorFingerprint) {
        evaluator.evaluatorFingerprint = shortEvaluatorFingerprint(evaluator.evaluatorFingerprint);
      }
    }
  }
  // Explicit task context is model-visible so a worker can read feedback refs.
  summary.taskContexts = projectAllTaskContexts(state);
  return secret === undefined ? summary : redactProtectedText(summary, secret) as Record<string, unknown>;
}

/**
 * Project the explicit task context for one node, or every bound task when
 * nodeId is omitted.
 */
export function projectModelVisibleTaskContext(
  state: HypagraphState,
  nodeId?: string,
): ReturnType<typeof projectTaskContext> | ReturnType<typeof projectAllTaskContexts> {
  if (nodeId) return projectTaskContext(state, nodeId);
  return projectAllTaskContexts(state);
}
