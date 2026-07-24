import type { HypagraphDefinition, MetricReportCheckDefinition } from "./model.js";

export type EvaluationAuthoringAdvisorySeverity = "warning" | "recommendation";

export type EvaluationAuthoringAdvisoryCode =
  | "evaluation_policy_undeclared"
  | "evaluation_trust_undeclared"
  | "holdout_requires_isolated_authoring"
  | "evaluation_budget_undeclared"
  | "evaluation_validity_undeclared"
  | "progress_source_not_metric_report"
  | "probe_evaluation_undeclared"
  | "raw_evaluator_report_exposed";

export interface EvaluationAuthoringAdvisory {
  code: EvaluationAuthoringAdvisoryCode;
  severity: EvaluationAuthoringAdvisorySeverity;
  message: string;
  location: string;
}

const metricCheck = (
  definition: HypagraphDefinition,
  nodeId: string,
): MetricReportCheckDefinition | undefined => {
  const check = definition.nodes.find((node) => node.id === nodeId)?.check;
  return check?.kind === "metric-report" ? check : undefined;
};

const budgetDeclared = (definition: HypagraphDefinition): boolean => {
  const budget = definition.evaluation?.budget;
  return budget !== undefined && Object.values(budget).some((value) => value !== undefined);
};

const advisory = (
  code: EvaluationAuthoringAdvisoryCode,
  severity: EvaluationAuthoringAdvisorySeverity,
  message: string,
  location: string,
): EvaluationAuthoringAdvisory => ({ code, severity, message, location });

export function assessEvaluationAuthoring(definition: HypagraphDefinition): EvaluationAuthoringAdvisory[] {
  const advisories: EvaluationAuthoringAdvisory[] = [];
  const metricEvaluators = definition.nodes
    .filter((node) => node.check?.kind === "metric-report")
    .map((node) => ({ node, check: node.check as MetricReportCheckDefinition }));
  const declaredEvaluators = metricEvaluators.filter((item) => item.check.evaluation !== undefined);
  const hasProbe = declaredEvaluators.some((item) => item.check.evaluation?.kind === "probe");

  for (const { node, check } of metricEvaluators) {
    const location = `nodes.${node.id}.check.evaluation`;
    const evaluation = check.evaluation;
    const evaluatesLoopProgress = definition.loops.some((loop) => loop.evaluateAfter === node.id && loop.progress !== undefined);

    if (!evaluation) {
      if (evaluatesLoopProgress) {
        advisories.push(advisory(
          "evaluation_policy_undeclared",
          "warning",
          `Metric evaluator '${node.id}' controls loop progress but does not declare evaluation purpose or feedback policy.`,
          location,
        ));
      }
      continue;
    }

    if (!evaluation.integrity) {
      advisories.push(advisory(
        "evaluation_trust_undeclared",
        "warning",
        `Metric evaluator '${node.id}' does not declare a transparent, protected, or isolated trust boundary.`,
        `${location}.integrity`,
      ));
    }

    if (evaluation.kind === "holdout" && evaluation.integrity?.trustLevel !== "isolated") {
      advisories.push(advisory(
        "holdout_requires_isolated_authoring",
        "warning",
        `Evaluator '${node.id}' has holdout purpose but does not have isolated trust. Do not present its result as trusted holdout acceptance.`,
        `${location}.integrity.trustLevel`,
      ));
    }

    if (evaluation.feedback.exposeRawReport === true) {
      advisories.push(advisory(
        "raw_evaluator_report_exposed",
        "warning",
        `Evaluator '${node.id}' exposes its raw report. Confirm that the report contains no protected cases, expected answers, or membership identifiers.`,
        `${location}.feedback.exposeRawReport`,
      ));
    }
  }

  if (declaredEvaluators.length > 0 && !budgetDeclared(definition)) {
    advisories.push(advisory(
      "evaluation_budget_undeclared",
      "warning",
      "The workflow declares evaluator execution but does not declare a total or per-purpose evaluation budget.",
      "evaluation.budget",
    ));
  }

  for (const loop of definition.loops) {
    if (!loop.progress) continue;
    const evaluator = metricCheck(definition, loop.evaluateAfter);
    if (!evaluator) {
      advisories.push(advisory(
        "progress_source_not_metric_report",
        "warning",
        `Loop '${loop.id}' uses numeric progress but its evaluation boundary is not a metric-report check. Confirm that the progress fact is produced by a deterministic instrument.`,
        `loops.${loop.id}.evaluateAfter`,
      ));
      continue;
    }

    if (!loop.evaluation) {
      advisories.push(advisory(
        "evaluation_validity_undeclared",
        "warning",
        `Loop '${loop.id}' uses metric progress but does not declare a typed evaluation-validity condition and invalid-observation limit.`,
        `loops.${loop.id}.evaluation`,
      ));
    }

    if (evaluator.evaluation?.kind === "development" && !hasProbe) {
      advisories.push(advisory(
        "probe_evaluation_undeclared",
        "recommendation",
        `Loop '${loop.id}' optimizes against a development evaluator but the workflow has no probe evaluator. Add one when generalization or metric gaming is a material risk.`,
        `loops.${loop.id}`,
      ));
    }
  }

  return advisories.sort((left, right) =>
    left.location.localeCompare(right.location)
    || left.code.localeCompare(right.code));
}

export function formatEvaluationAuthoringAdvisories(
  advisories: readonly EvaluationAuthoringAdvisory[],
): string {
  if (advisories.length === 0) return "";
  return [
    "Evaluation authoring advisories:",
    ...advisories.map((item) => `- ${item.severity} ${item.code} at ${item.location}: ${item.message}`),
  ].join("\n");
}
