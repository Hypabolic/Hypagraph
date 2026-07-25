import type { CheckDefinition, EvaluationKind, EvaluatorTrustLevel } from "./model.js";

/**
 * Report whether a check hides its evaluator detail.
 *
 * A protected evaluator must not expose its command, report path, raw report,
 * standard output, standard error, or failure reason. Each presentation surface
 * uses this rule, including the live check output and the M6B history views.
 */
export function protectsEvaluatorOutput(definition: CheckDefinition | undefined): boolean {
  return definition?.kind === "metric-report"
    && definition.evaluation !== undefined
    && definition.evaluation.feedback.exposeRawReport !== true;
}

export type EvaluationResultClaim =
  | "development-score"
  | "probe-score"
  | "holdout-purpose-only"
  | "trusted-holdout";

export function evaluationResultClaim(
  purpose: EvaluationKind,
  trustLevel: EvaluatorTrustLevel | undefined,
): EvaluationResultClaim {
  if (purpose === "holdout") return trustLevel === "isolated" ? "trusted-holdout" : "holdout-purpose-only";
  return purpose === "probe" ? "probe-score" : "development-score";
}

export function evaluationResultClaimLabel(claim: EvaluationResultClaim): string {
  switch (claim) {
    case "development-score": return "development score";
    case "probe-score": return "probe score";
    case "trusted-holdout": return "trusted isolated holdout";
    case "holdout-purpose-only": return "holdout purpose only; trusted holdout unavailable";
  }
}

export function shortEvaluatorFingerprint(value: string | undefined, length = 12): string {
  if (!value) return "pending";
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}
