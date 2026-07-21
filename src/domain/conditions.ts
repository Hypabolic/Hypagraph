import type { FactRecord, FactValue } from "./facts.js";

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

const resolve = (
  expression: ValueExpression,
  facts: Readonly<Record<string, FactRecord>>,
): { ok: true; value: FactValue; factsUsed: string[] } | { ok: false; message: string; factsUsed: string[] } => {
  if (expression.kind === "literal") return { ok: true, value: expression.value, factsUsed: [] };
  const fact = facts[expression.name];
  if (!fact) return { ok: false, message: `Fact '${expression.name}' is not available.`, factsUsed: [expression.name] };
  return { ok: true, value: fact.value, factsUsed: [expression.name] };
};

const compare = (left: FactValue, operator: ComparisonOperator, right: FactValue): boolean | undefined => {
  switch (operator) {
    case "eq": return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
    case "neq": return !(Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right));
    case "gt": return typeof left === "number" && typeof right === "number" ? left > right : undefined;
    case "gte": return typeof left === "number" && typeof right === "number" ? left >= right : undefined;
    case "lt": return typeof left === "number" && typeof right === "number" ? left < right : undefined;
    case "lte": return typeof left === "number" && typeof right === "number" ? left <= right : undefined;
    case "contains": return Array.isArray(left) && typeof right === "string" ? left.includes(right) : typeof left === "string" && typeof right === "string" ? left.includes(right) : undefined;
    case "in": return Array.isArray(right) && typeof left === "string" ? right.includes(left) : undefined;
  }
};

export const evaluateCondition = (
  condition: Condition,
  facts: Readonly<Record<string, FactRecord>>,
): ConditionResult => {
  switch (condition.kind) {
    case "exists": return { ok: true, value: facts[condition.fact] !== undefined, factsUsed: [condition.fact] };
    case "not": {
      const result = evaluateCondition(condition.condition, facts);
      return result.ok ? { ok: true, value: !result.value, factsUsed: result.factsUsed } : result;
    }
    case "all":
    case "any": {
      const results = condition.conditions.map((item) => evaluateCondition(item, facts));
      const failed = results.find((item) => !item.ok);
      const factsUsed = [...new Set(results.flatMap((item) => item.factsUsed))].sort();
      if (failed && !failed.ok) return { ...failed, factsUsed };
      const values = results.map((item) => item.ok && item.value);
      return { ok: true, value: condition.kind === "all" ? values.every(Boolean) : values.some(Boolean), factsUsed };
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
