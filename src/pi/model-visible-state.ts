import { shortEvaluatorFingerprint } from "../domain/evaluation-presentation.js";
import type { HypagraphState } from "../domain/model.js";
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

export function projectModelVisibleWorkflowSummary(state: HypagraphState): Record<string, unknown> {
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
  return summary;
}
