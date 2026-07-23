import type {
  EvaluationBudgetDefinition,
  EvaluationKind,
  EvaluationRuntime,
  HypagraphDefinition,
  HypagraphState,
  MetricReportCheckDefinition,
} from "./model.js";

export interface EvaluationBudgetStatus {
  counts: EvaluationRuntime;
  limits: EvaluationBudgetDefinition;
  remaining: {
    total?: number;
    development?: number;
    probe?: number;
    holdout?: number;
  };
}

const emptyCounts = (): EvaluationRuntime => ({
  total: 0,
  development: 0,
  probe: 0,
  holdout: 0,
});

export const metricEvaluationKind = (definition: MetricReportCheckDefinition): EvaluationKind => definition.evaluation?.kind ?? "development";

const kindLimit = (budget: EvaluationBudgetDefinition, kind: EvaluationKind): number | undefined => {
  switch (kind) {
    case "development": return budget.maximumDevelopmentEvaluations;
    case "probe": return budget.maximumProbeEvaluations;
    case "holdout": return budget.maximumHoldoutEvaluations;
  }
};

const kindCount = (counts: EvaluationRuntime, kind: EvaluationKind): number => counts[kind];

export const evaluationBudgetStatus = (state: Pick<HypagraphState, "definition" | "runtime">): EvaluationBudgetStatus | undefined => {
  const limits = state.definition.evaluation?.budget;
  if (!limits) return undefined;
  const counts = structuredClone(state.runtime.evaluations ?? emptyCounts());
  const remaining = {
    ...(limits.maximumEvaluations === undefined ? {} : { total: Math.max(0, limits.maximumEvaluations - counts.total) }),
    ...(limits.maximumDevelopmentEvaluations === undefined ? {} : { development: Math.max(0, limits.maximumDevelopmentEvaluations - counts.development) }),
    ...(limits.maximumProbeEvaluations === undefined ? {} : { probe: Math.max(0, limits.maximumProbeEvaluations - counts.probe) }),
    ...(limits.maximumHoldoutEvaluations === undefined ? {} : { holdout: Math.max(0, limits.maximumHoldoutEvaluations - counts.holdout) }),
  };
  return { counts, limits: structuredClone(limits), remaining };
};

export const evaluationStartDiagnostic = (
  definition: HypagraphDefinition,
  counts: EvaluationRuntime | undefined,
  kind: EvaluationKind,
): { code: "evaluation_budget_exhausted"; message: string } | undefined => {
  const budget = definition.evaluation?.budget;
  if (!budget) return undefined;
  const current = counts ?? emptyCounts();
  if (budget.maximumEvaluations !== undefined && current.total >= budget.maximumEvaluations) {
    return {
      code: "evaluation_budget_exhausted",
      message: `The workflow reached its limit of ${budget.maximumEvaluations} evaluations.`,
    };
  }
  const limit = kindLimit(budget, kind);
  if (limit !== undefined && kindCount(current, kind) >= limit) {
    return {
      code: "evaluation_budget_exhausted",
      message: `The workflow reached its limit of ${limit} ${kind} evaluations.`,
    };
  }
  return undefined;
};

export const evaluationBudgetExhaustedForKind = (state: HypagraphState, kind: EvaluationKind): boolean => (
  evaluationStartDiagnostic(state.definition, state.runtime.evaluations, kind) !== undefined
);
