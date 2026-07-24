import type { EvaluationKind, EvaluatorTrustLevel } from "./model.js";

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
