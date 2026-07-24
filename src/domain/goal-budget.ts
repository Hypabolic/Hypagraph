import type {
  Diagnostic,
  GoalBudgetDefinition,
  GoalBudgetRuntime,
  GoalBudgetStop,
  GoalTokenUsage,
} from "./model.js";

const positiveInteger = (value: number | undefined): boolean =>
  value === undefined || (Number.isSafeInteger(value) && value > 0);

export function validateGoalBudgetDefinition(
  budget: GoalBudgetDefinition | undefined,
): Diagnostic[] {
  if (!budget) return [];
  const diagnostics: Diagnostic[] = [];
  if (!positiveInteger(budget.maximumTurns)) {
    diagnostics.push({
      code: "invalid_goal_turn_budget",
      message: "The maximum substantive turn count must be a positive safe integer.",
      location: "budget.maximumTurns",
    });
  }
  if (!positiveInteger(budget.maximumTokens)) {
    diagnostics.push({
      code: "invalid_goal_token_budget",
      message: "The maximum token count must be a positive safe integer.",
      location: "budget.maximumTokens",
    });
  }
  if (budget.maximumTurns === undefined && budget.maximumTokens === undefined) {
    diagnostics.push({
      code: "empty_goal_budget",
      message: "A goal budget must define a maximum substantive turn count, a maximum token count, or both.",
      location: "budget",
    });
  }
  return diagnostics;
}

export function createGoalBudgetRuntime(
  budget: GoalBudgetDefinition | undefined,
): GoalBudgetRuntime {
  return {
    limits: budget ? structuredClone(budget) : {},
    consumedTurns: 0,
    consumedTokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    },
  };
}

const safeUsageValue = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

export function validateGoalTokenUsage(usage: GoalTokenUsage): Diagnostic[] {
  const values: Array<[keyof GoalTokenUsage, number]> = [
    ["input", usage.input],
    ["output", usage.output],
    ["cacheRead", usage.cacheRead],
    ["cacheWrite", usage.cacheWrite],
    ["totalTokens", usage.totalTokens],
  ];
  const invalid = values.find(([, value]) => !safeUsageValue(value));
  if (invalid) {
    return [{
      code: "invalid_goal_token_usage",
      message: `The token usage field '${invalid[0]}' must be a non-negative safe integer.`,
      location: `usage.${invalid[0]}`,
    }];
  }
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  if (!Number.isSafeInteger(total) || usage.totalTokens !== total) {
    return [{
      code: "invalid_goal_token_total",
      message: "The total token count must equal input, output, cache-read, and cache-write tokens.",
      location: "usage.totalTokens",
    }];
  }
  return [];
}

export function addGoalTokenUsage(
  current: GoalTokenUsage,
  addition: GoalTokenUsage,
): GoalTokenUsage {
  const next: GoalTokenUsage = {
    input: current.input + addition.input,
    output: current.output + addition.output,
    cacheRead: current.cacheRead + addition.cacheRead,
    cacheWrite: current.cacheWrite + addition.cacheWrite,
    totalTokens: current.totalTokens + addition.totalTokens,
  };
  if (Object.values(next).some((value) => !Number.isSafeInteger(value))) {
    throw new Error("The accumulated goal token usage exceeds the safe integer range.");
  }
  return next;
}

export function goalBudgetStop(
  budget: GoalBudgetRuntime,
  at: string,
): GoalBudgetStop | undefined {
  if (budget.limits.maximumTurns !== undefined && budget.consumedTurns >= budget.limits.maximumTurns) {
    return {
      reason: "turn_limit",
      limit: budget.limits.maximumTurns,
      consumed: budget.consumedTurns,
      at,
    };
  }
  if (budget.limits.maximumTokens !== undefined && budget.consumedTokens.totalTokens >= budget.limits.maximumTokens) {
    return {
      reason: "token_limit",
      limit: budget.limits.maximumTokens,
      consumed: budget.consumedTokens.totalTokens,
      at,
    };
  }
  return undefined;
}

export function formatGoalBudgetStop(stop: GoalBudgetStop): string {
  const unit = stop.reason === "turn_limit" ? "substantive turns" : "tokens";
  return `The Hypagoal used ${stop.consumed} of ${stop.limit} ${unit}. The budget prevents another automatic continuation.`;
}
