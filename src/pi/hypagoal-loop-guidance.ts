import { evaluationBudgetStatus, metricEvaluationKind } from "../domain/evaluation-policy.js";
import {
  evaluationResultClaim,
  evaluationResultClaimLabel,
  shortEvaluatorFingerprint,
} from "../domain/evaluation-presentation.js";
import type {
  EvaluationKind,
  GoalWorkContinuationAction,
  HypagraphState,
  LoopSuccessPredicate,
} from "../domain/model.js";
import { loopFailurePolicy } from "../domain/workflow-outcome.js";

export interface GoalLoopEvaluationGuidance {
  nodeId: string;
  purpose: EvaluationKind;
  feedbackMode: "aggregate" | "bounded-diagnostics";
  trustLevel: "transparent" | "protected" | "isolated" | "undeclared";
  isolation: "isolated" | "not-isolated";
  resultClaim: string;
  count: number;
  maximum?: number;
  totalCount: number;
  totalMaximum?: number;
  evaluatorVersion?: string;
  evaluatorFingerprint?: string;
  integrityStatus?: "pending" | "valid" | "invalid";
  protectedEvidence?: { verified: number; total: number };
}

export interface GoalLoopContinuationGuidance {
  loopId: string;
  status: string;
  iteration: number;
  maximumIterations: number;
  successCondition: LoopSuccessPredicate;
  lastValid?: boolean;
  lastSuccess?: boolean;
  progress?: {
    fact: string;
    direction: "minimize" | "maximize";
    minimumDelta: number;
    currentMetric?: number;
    bestMetric?: number;
    bestIteration?: number;
    noProgressCount: number;
    patience?: number;
  };
  validity?: {
    invalidEvaluationCount: number;
    maximumInvalidEvaluations: number;
  };
  evaluation?: GoalLoopEvaluationGuidance;
  failurePolicy: "fail-workflow" | "block-dependants" | "record-and-continue";
  exitReason?: string;
  blockedReason?: string;
}

const kindMaximum = (
  state: HypagraphState,
  kind: EvaluationKind,
): number | undefined => {
  const limits = state.definition.evaluation?.budget;
  if (!limits) return undefined;
  if (kind === "development") return limits.maximumDevelopmentEvaluations;
  if (kind === "probe") return limits.maximumProbeEvaluations;
  return limits.maximumHoldoutEvaluations;
};

export function projectGoalLoopContinuationGuidance(
  state: HypagraphState,
  action: Pick<GoalWorkContinuationAction, "nodeId" | "loopId">,
): GoalLoopContinuationGuidance | undefined {
  if (!action.loopId) return undefined;
  const definition = state.definition.loops.find((loop) => loop.id === action.loopId);
  const runtime = state.runtime.loops[action.loopId];
  if (!definition || !runtime || !definition.nodes.includes(action.nodeId)) return undefined;

  const evaluatorNode = state.definition.nodes.find((node) => node.id === definition.evaluateAfter);
  const evaluatorCheck = evaluatorNode?.check?.kind === "metric-report" ? evaluatorNode.check : undefined;
  const evaluatorPurpose = evaluatorCheck === undefined ? undefined : metricEvaluationKind(evaluatorCheck);
  const evaluationBudget = evaluationBudgetStatus(state);
  const integrity = runtime.evaluatorIntegrity;
  const declaredIntegrity = evaluatorCheck?.evaluation?.integrity;
  const evidence = integrity?.protectedEvidence ?? [];
  const trustLevel = declaredIntegrity?.trustLevel ?? "undeclared";
  const evaluatorMaximum = evaluatorPurpose === undefined ? undefined : kindMaximum(state, evaluatorPurpose);

  return {
    loopId: definition.id,
    status: runtime.status,
    iteration: runtime.currentIteration,
    maximumIterations: runtime.maxIterations,
    successCondition: structuredClone(definition.successWhen),
    ...(runtime.lastValid === undefined ? {} : { lastValid: runtime.lastValid }),
    ...(runtime.lastSuccess === undefined ? {} : { lastSuccess: runtime.lastSuccess }),
    ...(definition.progress === undefined ? {} : {
      progress: {
        fact: definition.progress.fact,
        direction: definition.progress.direction,
        minimumDelta: definition.progress.minDelta ?? 0,
        ...(runtime.currentMetric === undefined ? {} : { currentMetric: runtime.currentMetric }),
        ...(runtime.bestMetric === undefined ? {} : { bestMetric: runtime.bestMetric }),
        ...(runtime.bestIteration === undefined ? {} : { bestIteration: runtime.bestIteration }),
        noProgressCount: runtime.noProgressCount ?? 0,
        ...(definition.patience === undefined ? {} : { patience: definition.patience }),
      },
    }),
    ...(definition.evaluation === undefined ? {} : {
      validity: {
        invalidEvaluationCount: runtime.invalidEvaluationCount ?? 0,
        maximumInvalidEvaluations: definition.evaluation.maximumInvalidEvaluations,
      },
    }),
    ...(evaluatorCheck?.evaluation === undefined || evaluatorPurpose === undefined ? {} : {
      evaluation: {
        nodeId: definition.evaluateAfter,
        purpose: evaluatorPurpose,
        feedbackMode: evaluatorCheck.evaluation.feedback.mode,
        trustLevel,
        isolation: trustLevel === "isolated" ? "isolated" : "not-isolated",
        resultClaim: evaluationResultClaimLabel(evaluationResultClaim(evaluatorPurpose, declaredIntegrity?.trustLevel)),
        count: state.runtime.evaluations?.[evaluatorPurpose] ?? 0,
        ...(evaluatorMaximum === undefined ? {} : { maximum: evaluatorMaximum }),
        totalCount: state.runtime.evaluations?.total ?? 0,
        ...(state.definition.evaluation?.budget.maximumEvaluations === undefined
          ? {}
          : { totalMaximum: state.definition.evaluation.budget.maximumEvaluations }),
        ...(integrity?.evaluatorVersion === undefined && declaredIntegrity?.evaluatorVersion?.value === undefined
          ? {}
          : { evaluatorVersion: integrity?.evaluatorVersion ?? declaredIntegrity!.evaluatorVersion!.value }),
        ...(integrity?.evaluatorFingerprint === undefined
          ? {}
          : { evaluatorFingerprint: shortEvaluatorFingerprint(integrity.evaluatorFingerprint) }),
        ...(integrity?.status === undefined ? {} : { integrityStatus: integrity.status }),
        ...(evidence.length === 0 ? {} : {
          protectedEvidence: {
            verified: evidence.filter((item) => item.status === "verified").length,
            total: evidence.length,
          },
        }),
      },
    }),
    failurePolicy: loopFailurePolicy(definition),
    ...(runtime.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
    ...(runtime.blockedReason === undefined ? {} : { blockedReason: runtime.blockedReason }),
  };
}

const value = (candidate: number | boolean | string | undefined): string => candidate === undefined ? "none" : String(candidate);

export function renderGoalLoopContinuationGuidance(
  state: HypagraphState,
  action: Pick<GoalWorkContinuationAction, "nodeId" | "loopId">,
): string[] {
  const guidance = projectGoalLoopContinuationGuidance(state, action);
  if (!guidance) return [];
  const lines = [
    `Loop '${guidance.loopId}' is '${guidance.status}' at iteration ${guidance.iteration} of ${guidance.maximumIterations}.`,
    `Typed success condition: ${JSON.stringify(guidance.successCondition)}.`,
    `Last evaluation validity: ${value(guidance.lastValid)}. Last typed success result: ${value(guidance.lastSuccess)}.`,
  ];
  if (guidance.progress) {
    lines.push(
      `Progress fact '${guidance.progress.fact}' uses direction '${guidance.progress.direction}' and minimum delta ${guidance.progress.minimumDelta}.`,
      `Current accepted metric: ${value(guidance.progress.currentMetric)}. Best accepted metric: ${value(guidance.progress.bestMetric)}${guidance.progress.bestIteration === undefined ? "." : ` at iteration ${guidance.progress.bestIteration}.`}`,
      `No-progress count: ${guidance.progress.noProgressCount}${guidance.progress.patience === undefined ? "." : ` of patience limit ${guidance.progress.patience}.`}`,
    );
  } else {
    lines.push("This loop has no declared numeric progress metric. Typed success and evidence remain authoritative.");
  }
  if (guidance.validity) {
    lines.push(`Invalid evaluations: ${guidance.validity.invalidEvaluationCount} of ${guidance.validity.maximumInvalidEvaluations}.`);
  }
  if (guidance.evaluation) {
    const evaluation = guidance.evaluation;
    lines.push(
      `Evaluation node '${evaluation.nodeId}' has purpose '${evaluation.purpose}', feedback mode '${evaluation.feedbackMode}', trust '${evaluation.trustLevel}', and isolation '${evaluation.isolation}'.`,
      `Evaluation result claim: ${evaluation.resultClaim}.`,
      `Evaluation attempts: ${evaluation.count}${evaluation.maximum === undefined ? "" : ` of ${evaluation.maximum}`}; total ${evaluation.totalCount}${evaluation.totalMaximum === undefined ? "" : ` of ${evaluation.totalMaximum}`}.`,
    );
    if (evaluation.evaluatorVersion || evaluation.evaluatorFingerprint || evaluation.integrityStatus) {
      lines.push(`Evaluator identity: version ${evaluation.evaluatorVersion ?? "none"}; fingerprint ${evaluation.evaluatorFingerprint ?? "none"}; integrity ${evaluation.integrityStatus ?? "pending"}.`);
    }
    if (evaluation.protectedEvidence) {
      lines.push(`Protected evaluator evidence: ${evaluation.protectedEvidence.verified} of ${evaluation.protectedEvidence.total} verified.`);
    }
  }
  lines.push(
    `Loop failure policy: '${guidance.failurePolicy}'.`,
    `Loop stop state: ${guidance.exitReason ?? guidance.blockedReason ?? "none"}.`,
    "Evaluation validity, numeric progress, and typed success are separate canonical values.",
    "Do not reveal protected evaluator commands, paths, hashes, reports, standard output, standard error, hidden assertions, or holdout details.",
    "Do not keep this loop selected because it produced the latest event. Independent runnable components remain eligible for the next continuation.",
  );
  return lines;
}
