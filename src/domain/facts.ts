import type { EvidenceReference } from "./model.js";

export type FactType = "boolean" | "integer" | "number" | "string" | "duration" | "timestamp" | "string-list";
export type FactValue = boolean | number | string | string[];

export interface FactContract {
  name: string;
  type: FactType;
  required?: boolean;
}

export interface PublishedFact {
  name: string;
  type: FactType;
  value: FactValue;
  producerNodeId: string;
  attemptId: string;
  revision: number;
  evidence: EvidenceReference[];
}

export interface FactRecord extends PublishedFact {
  eventId: string;
  sequence: number;
}

export interface FactValidationContext {
  contracts: FactContract[];
  currentRevision: number;
  currentAttemptId: string;
}

export type FactValidationResult =
  | { ok: true; fact: PublishedFact }
  | { ok: false; code: string; message: string };

const isInteger = (value: FactValue): value is number => typeof value === "number" && Number.isInteger(value);
const isNumber = (value: FactValue): value is number => typeof value === "number" && Number.isFinite(value);
const isTimestamp = (value: FactValue): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isDuration = (value: FactValue): value is string => typeof value === "string" && /^P(?!$)/.test(value);

export const isFactValueOfType = (type: FactType, value: FactValue): boolean => {
  switch (type) {
    case "boolean": return typeof value === "boolean";
    case "integer": return isInteger(value);
    case "number": return isNumber(value);
    case "string": return typeof value === "string";
    case "duration": return isDuration(value);
    case "timestamp": return isTimestamp(value);
    case "string-list": return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
};

export const validatePublishedFact = (
  fact: PublishedFact,
  context: FactValidationContext,
): FactValidationResult => {
  const contract = context.contracts.find((item) => item.name === fact.name);
  if (!contract) {
    return { ok: false, code: "fact_not_declared", message: `Fact '${fact.name}' is not declared by the node.` };
  }
  if (fact.revision !== context.currentRevision) {
    return { ok: false, code: "stale_fact_revision", message: `Fact '${fact.name}' belongs to an old workflow revision.` };
  }
  if (fact.attemptId !== context.currentAttemptId) {
    return { ok: false, code: "stale_fact_attempt", message: `Fact '${fact.name}' belongs to an old attempt.` };
  }
  if (fact.type !== contract.type) {
    return { ok: false, code: "fact_type_mismatch", message: `Fact '${fact.name}' must have type '${contract.type}'.` };
  }
  if (!isFactValueOfType(fact.type, fact.value)) {
    return { ok: false, code: "fact_value_invalid", message: `Fact '${fact.name}' has an invalid value for type '${fact.type}'.` };
  }
  return { ok: true, fact };
};

export const indexFacts = (facts: FactRecord[]): Readonly<Record<string, FactRecord>> => {
  const result: Record<string, FactRecord> = {};
  for (const fact of facts) result[fact.name] = fact;
  return result;
};
