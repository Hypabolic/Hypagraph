import {
  evaluationResultClaim,
  evaluationResultClaimLabel,
  shortEvaluatorFingerprint,
  type EvaluationResultClaim,
} from "../domain/evaluation-presentation.js";
import type {
  EvaluationFeedbackMode,
  HypagraphState,
  LoopDefinition,
  LoopFailurePolicy,
  LoopRuntime,
} from "../domain/model.js";
import { loopFailurePolicy } from "../domain/workflow-outcome.js";
import { projectGraphView } from "../graph/projection.js";

export interface LoopSurfaceSummary {
  id: string;
  status: string;
  iteration: { current: number; limit: number };
  evaluationNodeId: string;
  feedbackEdges: Array<{ source: string; target: string; selected: boolean }>;
  lastSuccess?: boolean;
  evaluation?: {
    lastValid?: boolean;
    invalidCount: number;
    maximumInvalid: number;
    remainingInvalid: number;
  };
  evaluationBudget?: {
    kind: "development" | "probe" | "holdout";
    count: number;
    maximum?: number;
    remaining?: number;
    totalCount: number;
    totalMaximum?: number;
    totalRemaining?: number;
  };
  evaluator?: {
    purpose: "development" | "probe" | "holdout";
    feedbackMode: EvaluationFeedbackMode;
    resultClaim: EvaluationResultClaim;
    trustLevel?: "transparent" | "protected" | "isolated";
    evaluatorVersion?: string;
    evaluatorFingerprint?: string;
    integrityStatus?: "pending" | "valid" | "invalid";
    integrityDiagnosticCode?: string;
    protectedEvidence: { verified: number; invalid: number; total: number };
  };
  progress?: {
    fact: string;
    direction: "minimize" | "maximize";
    minDelta: number;
    currentMetric?: number;
    bestMetric?: number;
    bestIteration?: number;
    noProgressCount: number;
    patience?: number;
    remainingPatience?: number;
  };
  failurePolicy: LoopFailurePolicy;
  componentId?: string;
  localOutcome: string;
  workflowEffect: string;
  exitReason?: string;
  blockedReason?: string;
  warning?: { code: string; message: string };
}

const workflowEffect = (runtime: LoopRuntime | undefined, policy: LoopFailurePolicy): string => {
  if (!runtime || runtime.status === "pending" || runtime.status === "running" || runtime.status === "requires_revision") return "pending";
  if (runtime.status === "succeeded") return "releases-dependants";
  if (runtime.status === "blocked") return "blocks-region";
  if (policy === "fail-workflow") return "fails-workflow";
  if (policy === "block-dependants") return "blocks-dependants";
  return "records-failure-and-continues";
};

const loopWarning = (loop: LoopDefinition, runtime: LoopRuntime | undefined): LoopSurfaceSummary["warning"] => {
  if (runtime?.status === "requires_revision" || runtime?.legacyPredicate !== undefined || typeof loop.successWhen === "string" || (typeof loop.successWhen === "object" && loop.successWhen !== null && "kind" in loop.successWhen && loop.successWhen.kind === "legacy-text")) {
    return { code: "loop_predicate_revision_required", message: "Replace the legacy text predicate with a typed success condition before this loop can run." };
  }
  if (runtime?.exitReason === "max_iterations") return { code: "loop_max_iterations_exhausted", message: "The loop reached its hard iteration limit without satisfying its success condition." };
  if (runtime?.exitReason === "invalid_evaluations") return { code: "loop_invalid_evaluations_exhausted", message: "The loop reached its invalid-evaluation limit without a trustworthy observation." };
  if (runtime?.exitReason === "evaluation_budget") return { code: "loop_evaluation_budget_exhausted", message: "The loop used its available evaluation budget before it satisfied the success condition." };
  if (runtime?.exitReason === "evaluation_error") return { code: "loop_evaluation_error", message: "The evaluation boundary could not produce a valid deterministic loop decision." };
  return undefined;
};

export function loopSurfaceSummaries(state: HypagraphState): LoopSurfaceSummary[] {
  const view = projectGraphView(state);
  const componentByLoop = new Map(view.loops.map((loop) => [loop.id, loop.componentId]));
  return state.definition.loops.map((loop) => {
    const runtime = state.runtime.loops[loop.id];
    const policy = loopFailurePolicy(loop);
    const selectedFeedback = runtime?.status === "running" && runtime.currentIteration > 1;
    const warning = loopWarning(loop, runtime);
    const invalidCount = runtime?.invalidEvaluationCount ?? 0;
    const evaluatorCheck = state.definition.nodes.find((node) => node.id === loop.evaluateAfter)?.check;
    const metricEvaluator = evaluatorCheck?.kind === "metric-report" ? evaluatorCheck : undefined;
    const evaluatorKind = metricEvaluator?.evaluation?.kind ?? (metricEvaluator === undefined ? undefined : "development");
    const budget = view.evaluationBudget;
    const projectedEvaluator = view.loops.find((item) => item.id === loop.id)?.evaluator;
    const evaluator = evaluatorKind === undefined || metricEvaluator?.evaluation === undefined
      ? undefined
      : {
          ...(projectedEvaluator ?? {
            purpose: evaluatorKind,
            protectedEvidence: { verified: 0, invalid: 0, total: 0 },
          }),
          feedbackMode: metricEvaluator.evaluation.feedback.mode,
          resultClaim: evaluationResultClaim(evaluatorKind, metricEvaluator.evaluation.integrity?.trustLevel),
        };
    const kindMaximum = evaluatorKind === "development" ? budget?.limits.maximumDevelopmentEvaluations
      : evaluatorKind === "probe" ? budget?.limits.maximumProbeEvaluations
        : evaluatorKind === "holdout" ? budget?.limits.maximumHoldoutEvaluations
          : undefined;
    const kindCount = evaluatorKind === undefined ? undefined : budget?.counts[evaluatorKind];
    const kindRemaining = evaluatorKind === undefined ? undefined : budget?.remaining[evaluatorKind];
    return {
      id: loop.id,
      status: runtime?.status ?? "pending",
      iteration: { current: runtime?.currentIteration ?? 0, limit: loop.maxIterations },
      evaluationNodeId: loop.evaluateAfter,
      feedbackEdges: loop.feedbackEdges.map((edge) => ({ source: edge.from, target: edge.to, selected: selectedFeedback })),
      ...(runtime?.lastSuccess === undefined ? {} : { lastSuccess: runtime.lastSuccess }),
      ...(loop.evaluation === undefined ? {} : {
        evaluation: {
          ...(runtime?.lastValid === undefined ? {} : { lastValid: runtime.lastValid }),
          invalidCount,
          maximumInvalid: loop.evaluation.maximumInvalidEvaluations,
          remainingInvalid: Math.max(0, loop.evaluation.maximumInvalidEvaluations - invalidCount),
        },
      }),
      ...(evaluatorKind === undefined || budget === undefined ? {} : {
        evaluationBudget: {
          kind: evaluatorKind,
          count: kindCount ?? 0,
          ...(kindMaximum === undefined ? {} : { maximum: kindMaximum }),
          ...(kindRemaining === undefined ? {} : { remaining: kindRemaining }),
          totalCount: budget.counts.total,
          ...(budget.limits.maximumEvaluations === undefined ? {} : { totalMaximum: budget.limits.maximumEvaluations }),
          ...(budget.remaining.total === undefined ? {} : { totalRemaining: budget.remaining.total }),
        },
      }),
      ...(evaluator === undefined ? {} : { evaluator: structuredClone(evaluator) }),
      ...(loop.progress === undefined ? {} : {
        progress: {
          fact: loop.progress.fact,
          direction: loop.progress.direction,
          minDelta: loop.progress.minDelta ?? 0,
          ...(runtime?.currentMetric === undefined ? {} : { currentMetric: runtime.currentMetric }),
          ...(runtime?.bestMetric === undefined ? {} : { bestMetric: runtime.bestMetric }),
          ...(runtime?.bestIteration === undefined ? {} : { bestIteration: runtime.bestIteration }),
          noProgressCount: runtime?.noProgressCount ?? 0,
          ...(loop.patience === undefined ? {} : {
            patience: loop.patience,
            remainingPatience: Math.max(0, loop.patience - (runtime?.noProgressCount ?? 0)),
          }),
        },
      }),
      failurePolicy: policy,
      ...(componentByLoop.get(loop.id) === undefined ? {} : { componentId: componentByLoop.get(loop.id)! }),
      localOutcome: runtime?.status ?? "pending",
      workflowEffect: workflowEffect(runtime, policy),
      ...(runtime?.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
      ...(runtime?.blockedReason === undefined ? {} : { blockedReason: runtime.blockedReason }),
      ...(warning === undefined ? {} : { warning }),
    };
  });
}

export function renderLoopStatus(state: HypagraphState): string {
  const loops = loopSurfaceSummaries(state);
  if (loops.length === 0) return "This Hypagraph has no bounded iteration regions.";
  return loops.map((loop) => {
    const feedback = loop.feedbackEdges.map((edge) => `${edge.source}->${edge.target}${edge.selected ? " (selected)" : ""}`).join(", ") || "none";
    const validity = loop.evaluation === undefined
      ? ""
      : ` | valid ${loop.evaluation.lastValid ?? "none"}, invalid ${loop.evaluation.invalidCount}/${loop.evaluation.maximumInvalid}`;
    const budget = loop.evaluationBudget === undefined
      ? ""
      : ` | budget ${loop.evaluationBudget.kind} ${loop.evaluationBudget.count}${loop.evaluationBudget.maximum === undefined ? "" : `/${loop.evaluationBudget.maximum}`}, total ${loop.evaluationBudget.totalCount}${loop.evaluationBudget.totalMaximum === undefined ? "" : `/${loop.evaluationBudget.totalMaximum}`}`;
    const metric = loop.progress === undefined
      ? ""
      : ` | metric ${loop.progress.currentMetric ?? "none"}, best ${loop.progress.bestMetric ?? "none"}${loop.progress.bestIteration === undefined ? "" : ` at ${loop.progress.bestIteration}`}, no-progress ${loop.progress.noProgressCount}${loop.progress.patience === undefined ? "" : `/${loop.progress.patience}`}`;
    const evaluator = loop.evaluator === undefined
      ? ""
      : `\n  evaluator purpose ${loop.evaluator.purpose} | claim ${evaluationResultClaimLabel(loop.evaluator.resultClaim)} | feedback ${loop.evaluator.feedbackMode} | trust ${loop.evaluator.trustLevel ?? "undeclared"} | integrity ${loop.evaluator.integrityStatus ?? "undeclared"} | version ${loop.evaluator.evaluatorVersion ?? "none"} | fingerprint ${shortEvaluatorFingerprint(loop.evaluator.evaluatorFingerprint)} | diagnostic ${loop.evaluator.integrityDiagnosticCode ?? "none"} | protected evidence ${loop.evaluator.protectedEvidence.verified}/${loop.evaluator.protectedEvidence.total}`;
    const warning = loop.warning ? `\n  warning ${loop.warning.code}: ${loop.warning.message}` : "";
    return `${loop.id}: ${loop.status} | iteration ${loop.iteration.current}/${loop.iteration.limit} | evaluate ${loop.evaluationNodeId} | feedback ${feedback} | policy ${loop.failurePolicy} | component ${loop.componentId ?? "none"} | outcome ${loop.localOutcome} | workflow ${loop.workflowEffect}${loop.exitReason ? ` | exit ${loop.exitReason}` : ""}${validity}${budget}${metric}${evaluator}${warning}`;
  }).join("\n");
}
