import type { FactRecord, FactValue } from "./facts.js";

export const CONDITION_SEMANTICS_VERSION = 1 as const;
export const MAX_CONDITION_NODES = 128 as const;
export const MAX_CONDITION_DEPTH = 32 as const;

export type ComparisonOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in";

export type ValueExpression =
  | { kind: "fact"; name: string }
  | { kind: "literal"; value: FactValue };

export type Condition =
  | { kind: "all"; conditions: Condition[] }
  | { kind: "any"; conditions: Condition[] }
  | { kind: "not"; condition: Condition }
  | { kind: "exists"; fact: string }
  | { kind: "compare"; left: ValueExpression; operator: ComparisonOperator; right: ValueExpression };

export type ConditionResult =
  | { ok: true; value: boolean; factsUsed: string[] }
  | { ok: false; code: string; message: string; factsUsed: string[] };

export type ConditionComplexityResult =
  | { ok: true; nodes: number; depth: number }
  | { ok: false; code: "condition_limit_exceeded" | "condition_depth_exceeded"; message: string; nodes: number; depth: number };

interface EvaluationBudget {
  remaining: number;
}

export const measureCondition = (condition: Condition): ConditionComplexityResult => {
  let nodes = 0;
  let maximumDepth = 0;
  const visit = (value: Condition, depth: number): ConditionComplexityResult | undefined => {
    nodes += 1;
    maximumDepth = Math.max(maximumDepth, depth);
    if (nodes > MAX_CONDITION_NODES) {
      return { ok: false, code: "condition_limit_exceeded", message: "The condition exceeds the node limit.", nodes, depth: maximumDepth };
    }
    if (depth > MAX_CONDITION_DEPTH) {
      return { ok: false, code: "condition_depth_exceeded", message: "The condition exceeds the depth limit.", nodes, depth: maximumDepth };
    }
    if (value.kind === "not") return visit(value.condition, depth + 1);
    if (value.kind === "all" || value.kind === "any") {
      for (const child of value.conditions) {
        const result = visit(child, depth + 1);
        if (result) return result;
      }
    }
    return undefined;
  };
  return visit(condition, 1) ?? { ok: true, nodes, depth: maximumDepth };
};

const resolve = (
  expression: ValueExpression,
  facts: Readonly<Record<string, FactRecord>>,
): { ok: true; value: FactValue; factsUsed: string[] } | { ok: false; message: string; factsUsed: string[] } => {
  if (expression.kind === "literal") return { ok: true, value: expression.value, factsUsed: [] };
  const fact = facts[expression.name];
  if (!fact) return { ok: false, message: `Fact '${expression.name}' is not available.`, factsUsed: [expression.name] };
  return { ok: true, value: fact.value, factsUsed: [expression.name] };
};

const equal = (left: FactValue, right: FactValue): boolean => Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);

const compare = (left: FactValue, operator: ComparisonOperator, right: FactValue): boolean | undefined => {
  switch (operator) {
    case "eq": return equal(left, right);
    case "neq": return !equal(left, right);
    case "gt": return typeof left === "number" && typeof right === "number" ? left > right : undefined;
    case "gte": return typeof left === "number" && typeof right === "number" ? left >= right : undefined;
    case "lt": return typeof left === "number" && typeof right === "number" ? left < right : undefined;
    case "lte": return typeof left === "number" && typeof right === "number" ? left <= right : undefined;
    case "contains": return Array.isArray(left) && typeof right === "string" ? left.includes(right) : typeof left === "string" && typeof right === "string" ? left.includes(right) : undefined;
    case "in": return Array.isArray(right) && typeof left === "string" ? right.includes(left) : undefined;
  }
};

const evaluate = (
  condition: Condition,
  facts: Readonly<Record<string, FactRecord>>,
  budget: EvaluationBudget,
): ConditionResult => {
  budget.remaining -= 1;
  if (budget.remaining < 0) return { ok: false, code: "condition_limit_exceeded", message: "The condition exceeds the evaluation limit.", factsUsed: [] };

  switch (condition.kind) {
    case "exists": return { ok: true, value: facts[condition.fact] !== undefined, factsUsed: [condition.fact] };
    case "not": {
      const result = evaluate(condition.condition, facts, budget);
      return result.ok ? { ok: true, value: !result.value, factsUsed: result.factsUsed } : result;
    }
    case "all": {
      const factsUsed: string[] = [];
      for (const item of condition.conditions) {
        const result = evaluate(item, facts, budget);
        factsUsed.push(...result.factsUsed);
        if (!result.ok) return { ...result, factsUsed: [...new Set(factsUsed)].sort() };
        if (!result.value) return { ok: true, value: false, factsUsed: [...new Set(factsUsed)].sort() };
      }
      return { ok: true, value: true, factsUsed: [...new Set(factsUsed)].sort() };
    }
    case "any": {
      const factsUsed: string[] = [];
      for (const item of condition.conditions) {
        const result = evaluate(item, facts, budget);
        factsUsed.push(...result.factsUsed);
        if (!result.ok) return { ...result, factsUsed: [...new Set(factsUsed)].sort() };
        if (result.value) return { ok: true, value: true, factsUsed: [...new Set(factsUsed)].sort() };
      }
      return { ok: true, value: false, factsUsed: [...new Set(factsUsed)].sort() };
    }
    case "compare": {
      const left = resolve(condition.left, facts);
      const right = resolve(condition.right, facts);
      const factsUsed = [...new Set([...left.factsUsed, ...right.factsUsed])].sort();
      if (!left.ok) return { ok: false, code: "fact_missing", message: left.message, factsUsed };
      if (!right.ok) return { ok: false, code: "fact_missing", message: right.message, factsUsed };
      const value = compare(left.value, condition.operator, right.value);
      if (value === undefined) return { ok: false, code: "condition_type_mismatch", message: `Operator '${condition.operator}' cannot compare these values.`, factsUsed };
      return { ok: true, value, factsUsed };
    }
  }
};

export const evaluateCondition = (
  condition: Condition,
  facts: Readonly<Record<string, FactRecord>>,
): ConditionResult => {
  const complexity = measureCondition(condition);
  if (!complexity.ok) return { ok: false, code: complexity.code, message: complexity.message, factsUsed: [] };
  return evaluate(condition, facts, { remaining: MAX_CONDITION_NODES });
};
