import type { GoalBlockageDecision } from "./goal-blockage.js";
import type { GoalContinuationDecision } from "./goal-continuation.js";
import type {
  CheckDefinition,
  EvaluationKind,
  EvaluatorTrustLevel,
  HypagraphDefinition,
  HypagraphState,
} from "./model.js";

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

/** The replacement for any free text which can contain protected evaluator detail. */
export const PROTECTED_REASON = "The reason is protected, because it can contain evaluator detail.";

/** Report whether one node of a definition hides its evaluator detail. */
export function isProtectedEvaluatorNode(
  definition: HypagraphDefinition,
  nodeId: string | undefined,
): boolean {
  if (nodeId === undefined) return false;
  return protectsEvaluatorOutput(definition.nodes.find((node) => node.id === nodeId)?.check);
}

/**
 * Replace a stored free-text reason which belongs to a protected evaluator node.
 *
 * A stored reason, such as a node blocker reason or a verification reason, can repeat
 * evaluator output, a report path, a hidden assertion, or holdout detail. Canonical state
 * keeps the exact text, because the blocker identity binds the automatic revision to it.
 * Each presentation surface must replace it.
 */
export function redactProtectedReason(
  definition: HypagraphDefinition,
  nodeId: string | undefined,
  reason: string,
): { reason: string; redacted: boolean } {
  return isProtectedEvaluatorNode(definition, nodeId)
    ? { reason: PROTECTED_REASON, redacted: true }
    : { reason, redacted: false };
}

export function shortEvaluatorFingerprint(value: string | undefined, length = 12): string {
  if (!value) return "pending";
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

/**
 * Replace a blocker reason which belongs to a protected evaluator node.
 *
 * `classifyGoalBlockage` copies the stored node blocker reason into the blocker identity,
 * because the automatic revision binds to that exact text. Canonical state keeps it. Each
 * presentation surface must replace it.
 */
export function redactGoalBlockage(
  state: HypagraphState,
  decision: GoalBlockageDecision,
): { decision: GoalBlockageDecision; redacted: boolean } {
  if (decision.kind === "not-blocked") return { decision, redacted: false };
  if (!isProtectedEvaluatorNode(state.definition, decision.blocker.id)) return { decision, redacted: false };
  const blocker = { ...structuredClone(decision.blocker), reason: PROTECTED_REASON };
  const next: GoalBlockageDecision = decision.kind === "revision-eligible"
    ? { kind: decision.kind, blocker }
    : { kind: decision.kind, blocker, reason: PROTECTED_REASON };
  return { decision: next, redacted: true };
}

/**
 * Replace a stop reason which the blockage of a protected evaluator node produced.
 *
 * `selectGoalContinuation` derives a `stop-blocked` reason from the same blocker, so the
 * scheduler decision needs the same replacement as the blockage itself.
 */
export function redactStopReason<T extends GoalContinuationDecision>(
  decision: T,
  blockageRedacted: boolean,
): T {
  if (!blockageRedacted || decision.kind !== "stop-blocked") return decision;
  return { ...decision, reason: PROTECTED_REASON };
}

/**
 * Report the canonical blocker reason when the blocker is a protected evaluator node.
 *
 * A presentation surface which copies canonical goal state, such as the model-visible
 * summary, replaces every occurrence of this exact text.
 */
export function protectedBlockerReason(
  state: HypagraphState,
  decision: GoalBlockageDecision,
): string | undefined {
  if (decision.kind === "not-blocked") return undefined;
  if (!isProtectedEvaluatorNode(state.definition, decision.blocker.id)) return undefined;
  return decision.blocker.reason;
}
