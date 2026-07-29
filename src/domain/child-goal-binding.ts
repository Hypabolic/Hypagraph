import { isFactValueOfType, type FactContract, type FactType, type FactValue } from "./facts.js";
import type {
  Diagnostic,
  EvidenceReference,
  GoalBudgetDefinition,
  HypagraphDefinition,
} from "./model.js";
import { FACT_NAME_PATTERN } from "./validate.js";

const FACT_TYPES = new Set<FactType>([
  "boolean",
  "integer",
  "number",
  "string",
  "duration",
  "timestamp",
  "string-list",
]);

const EVIDENCE_KINDS = new Set(["tool", "command", "file", "approval", "note"]);
const EVIDENCE_VISIBILITIES = new Set(["public", "protected"]);

/** One validated fact published on a child return (shared by command and restore). */
export interface ValidatedChildReturnFact {
  name: string;
  type: FactType;
  value: FactValue;
  evidence: EvidenceReference[];
}

/**
 * Validate evidence reference list shape.
 * Shared by command helpers and restore validation.
 * Returns diagnostics without throwing.
 */
export function validateEvidenceReferences(
  value: unknown,
  location: string,
): { ok: true; evidence: EvidenceReference[] } | { ok: false; diagnostics: Diagnostic[] } {
  if (value === undefined) return { ok: true, evidence: [] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_child_return_evidence",
        message: "Child return evidence must be an array when present.",
        location,
      }],
    };
  }
  const evidence: EvidenceReference[] = [];
  const diagnostics: Diagnostic[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      diagnostics.push({
        code: "invalid_child_return_evidence",
        message: `Evidence at index ${index} must be a plain object.`,
        location: `${location}[${index}]`,
      });
      continue;
    }
    const raw = item as Record<string, unknown>;
    if (typeof raw.ref !== "string" || !raw.ref.trim()) {
      diagnostics.push({
        code: "invalid_child_return_evidence",
        message: `Evidence at index ${index} requires a non-empty ref.`,
        location: `${location}[${index}].ref`,
      });
      continue;
    }
    if (raw.kind !== undefined && (typeof raw.kind !== "string" || !EVIDENCE_KINDS.has(raw.kind))) {
      diagnostics.push({
        code: "invalid_child_return_evidence",
        message: `Evidence at index ${index} has an unsupported kind.`,
        location: `${location}[${index}].kind`,
      });
      continue;
    }
    if (
      raw.visibility !== undefined
      && (typeof raw.visibility !== "string" || !EVIDENCE_VISIBILITIES.has(raw.visibility))
    ) {
      diagnostics.push({
        code: "invalid_child_return_evidence",
        message: `Evidence at index ${index} has an unsupported visibility.`,
        location: `${location}[${index}].visibility`,
      });
      continue;
    }
    if (raw.summary !== undefined && typeof raw.summary !== "string") {
      diagnostics.push({
        code: "invalid_child_return_evidence",
        message: `Evidence at index ${index} summary must be a string when present.`,
        location: `${location}[${index}].summary`,
      });
      continue;
    }
    const reference: EvidenceReference = { ref: raw.ref };
    if (typeof raw.kind === "string") reference.kind = raw.kind as NonNullable<EvidenceReference["kind"]>;
    if (typeof raw.summary === "string") reference.summary = raw.summary;
    if (typeof raw.visibility === "string") {
      reference.visibility = raw.visibility as NonNullable<EvidenceReference["visibility"]>;
    }
    evidence.push(reference);
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, evidence };
}

/**
 * Validate returned facts against binding output contracts.
 * Required contracts must be present when requireRequired is true.
 * Shared by command helpers, event application, and restore.
 * Returns diagnostics without throwing.
 */
export function validateChildReturnFacts(
  contracts: readonly FactContract[],
  facts: readonly { name: string; type: FactType; value: FactValue; evidence?: EvidenceReference[] }[] | undefined,
  options: { requireRequired: boolean },
): { ok: true; published: ValidatedChildReturnFact[] } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const inputList = facts ?? [];
  if (!Array.isArray(inputList)) {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_child_return_facts",
        message: "Child return facts must be an array when present.",
        location: "facts",
      }],
    };
  }

  const byName = new Map<string, { name: string; type: FactType; value: FactValue; evidence?: EvidenceReference[] }>();
  for (let index = 0; index < inputList.length; index += 1) {
    const fact = inputList[index];
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) {
      diagnostics.push({
        code: "invalid_child_return_facts",
        message: `Child return fact at index ${index} must be a plain object.`,
        location: `facts[${index}]`,
      });
      continue;
    }
    if (typeof fact.name !== "string" || !fact.name.trim()) {
      diagnostics.push({
        code: "invalid_child_return_facts",
        message: `Child return fact at index ${index} requires a non-empty name.`,
        location: `facts[${index}].name`,
      });
      continue;
    }
    if (byName.has(fact.name)) {
      diagnostics.push({
        code: "duplicate_child_return_fact",
        message: `Child return fact '${fact.name}' is supplied more than once.`,
        location: `facts[${index}].name`,
      });
      continue;
    }
    if (typeof fact.type !== "string" || !FACT_TYPES.has(fact.type as FactType)) {
      diagnostics.push({
        code: "invalid_child_return_facts",
        message: `Child return fact '${fact.name}' requires a known fact type.`,
        location: `facts[${index}].type`,
      });
      continue;
    }
    byName.set(fact.name, fact as { name: string; type: FactType; value: FactValue; evidence?: EvidenceReference[] });
  }

  const contractByName = new Map(contracts.map((contract) => [contract.name, contract]));
  const published: ValidatedChildReturnFact[] = [];

  for (const [name, fact] of byName) {
    const contract = contractByName.get(name);
    if (!contract) {
      diagnostics.push({
        code: "child_return_fact_not_declared",
        message: `Child return fact '${name}' is not declared by the binding output contracts.`,
        location: `facts.${name}`,
      });
      continue;
    }
    if (fact.type !== contract.type) {
      diagnostics.push({
        code: "fact_type_mismatch",
        message: `Child return fact '${name}' must have type '${contract.type}'.`,
        location: `facts.${name}.type`,
      });
      continue;
    }
    if (!isFactValueOfType(fact.type, fact.value)) {
      diagnostics.push({
        code: "fact_value_invalid",
        message: `Child return fact '${name}' has an invalid value for type '${fact.type}'.`,
        location: `facts.${name}.value`,
      });
      continue;
    }
    const evidenceValidation = validateEvidenceReferences(fact.evidence, `facts.${name}.evidence`);
    if (!evidenceValidation.ok) {
      diagnostics.push(...evidenceValidation.diagnostics);
      continue;
    }
    published.push({
      name: fact.name,
      type: fact.type,
      value: structuredClone(fact.value),
      evidence: evidenceValidation.evidence,
    });
  }

  if (options.requireRequired) {
    for (const contract of contracts) {
      if (contract.required !== true) continue;
      if (!byName.has(contract.name)) {
        diagnostics.push({
          code: "child_return_required_fact_missing",
          message: `Child return is missing required output fact '${contract.name}'.`,
          location: `facts.${contract.name}`,
        });
      }
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, published };
}

/** Report whether a string is a known fact type. */
export function isKnownFactType(value: unknown): value is FactType {
  return typeof value === "string" && FACT_TYPES.has(value as FactType);
}

/**
 * Report whether child scope paths equal or narrow parent available paths.
 * An empty parent path list means unrestricted parent scope.
 * An empty child path list under a restricted parent widens scope and is rejected.
 */
export function childScopeIsWithinParent(
  childPaths: readonly string[],
  parentPaths: readonly string[],
): boolean {
  if (parentPaths.length === 0) return true;
  if (childPaths.length === 0) return false;
  return childPaths.every((child) => parentPaths.some((parent) => pathIsWithinScope(child, parent)));
}

/**
 * Report whether a child scope path equals or is nested under a parent scope path.
 * Supports exact paths and trailing `/**` directory globs.
 */
export function pathIsWithinScope(childPath: string, parentPath: string): boolean {
  if (childPath === parentPath) return true;
  if (parentPath.endsWith("/**")) {
    const base = parentPath.slice(0, -3);
    if (childPath === base) return true;
    if (childPath === `${base}/**`) return true;
    if (childPath.startsWith(`${base}/`)) return true;
  }
  return false;
}

/**
 * Validate that every declared child node scope equals or narrows the binding scope.
 * A node with no scope declaration inherits the binding scope and is accepted.
 */
export function validateChildDefinitionScopes(
  definition: HypagraphDefinition,
  bindingScopePaths: readonly string[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const node of definition.nodes) {
    const nodePaths = node.scope?.paths;
    if (nodePaths === undefined) continue;
    if (!Array.isArray(nodePaths) || nodePaths.some((path) => typeof path !== "string" || !path.trim())) {
      diagnostics.push({
        code: "invalid_child_node_scope",
        message: `Child node '${node.id}' scope paths must be an array of non-empty strings.`,
        location: `childDefinition.nodes.${node.id}.scope.paths`,
      });
      continue;
    }
    if (!childScopeIsWithinParent(nodePaths, bindingScopePaths)) {
      diagnostics.push({
        code: "child_node_scope_widened",
        message: `Child node '${node.id}' scope must equal or narrow the child binding scope.`,
        location: `childDefinition.nodes.${node.id}.scope.paths`,
      });
    }
  }
  return diagnostics;
}

/**
 * Validate binding fact contracts and input fact names.
 * Shared by command helpers, event application, and snapshot validation.
 * Returns diagnostics without throwing.
 */
export function validateChildBindingFacts(
  inputFacts: unknown,
  outputFacts: unknown,
): { ok: true; inputFacts: string[]; outputFacts: FactContract[] } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];

  if (inputFacts !== undefined && !Array.isArray(inputFacts)) {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_child_input_facts",
        message: "The child input facts must be an array of strings when present.",
        location: "inputFacts",
      }],
    };
  }
  const inputList = (inputFacts ?? []) as unknown[];
  const seenInputs = new Set<string>();
  const normalizedInputs: string[] = [];
  for (let index = 0; index < inputList.length; index += 1) {
    const name = inputList[index];
    if (typeof name !== "string" || !name.trim()) {
      diagnostics.push({
        code: "invalid_child_input_facts",
        message: `Child input fact at index ${index} must be a non-empty string.`,
        location: `inputFacts[${index}]`,
      });
      continue;
    }
    if (!FACT_NAME_PATTERN.test(name)) {
      diagnostics.push({
        code: "invalid_fact_name",
        message: `Child input fact '${name}' must use a dotted lower-case name.`,
        location: `inputFacts[${index}]`,
      });
      continue;
    }
    if (seenInputs.has(name)) {
      diagnostics.push({
        code: "duplicate_child_input_fact",
        message: `Child input fact '${name}' is declared more than once.`,
        location: `inputFacts[${index}]`,
      });
      continue;
    }
    seenInputs.add(name);
    normalizedInputs.push(name);
  }

  if (outputFacts !== undefined && !Array.isArray(outputFacts)) {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_child_output_facts",
        message: "The child output facts must be an array of fact contracts when present.",
        location: "outputFacts",
      }],
    };
  }
  const outputList = (outputFacts ?? []) as unknown[];
  const seenOutputs = new Set<string>();
  const normalizedOutputs: FactContract[] = [];
  for (let index = 0; index < outputList.length; index += 1) {
    const raw = outputList[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      diagnostics.push({
        code: "invalid_child_output_facts",
        message: `Child output fact at index ${index} must be a plain object.`,
        location: `outputFacts[${index}]`,
      });
      continue;
    }
    const contract = raw as Record<string, unknown>;
    if (typeof contract.name !== "string" || !contract.name.trim()) {
      diagnostics.push({
        code: "invalid_child_output_facts",
        message: `Child output fact at index ${index} requires a non-empty name.`,
        location: `outputFacts[${index}].name`,
      });
      continue;
    }
    if (!FACT_NAME_PATTERN.test(contract.name)) {
      diagnostics.push({
        code: "invalid_fact_name",
        message: `Child output fact '${contract.name}' must use a dotted lower-case name.`,
        location: `outputFacts[${index}].name`,
      });
      continue;
    }
    if (typeof contract.type !== "string" || !FACT_TYPES.has(contract.type as FactType)) {
      diagnostics.push({
        code: "invalid_child_output_facts",
        message: `Child output fact '${contract.name}' requires a known fact type.`,
        location: `outputFacts[${index}].type`,
      });
      continue;
    }
    if (contract.required !== undefined && typeof contract.required !== "boolean") {
      diagnostics.push({
        code: "invalid_child_output_facts",
        message: `Child output fact '${contract.name}' required flag must be a boolean when present.`,
        location: `outputFacts[${index}].required`,
      });
      continue;
    }
    if (seenOutputs.has(contract.name)) {
      diagnostics.push({
        code: "duplicate_child_output_fact",
        message: `Child output fact '${contract.name}' is declared more than once.`,
        location: `outputFacts[${index}].name`,
      });
      continue;
    }
    seenOutputs.add(contract.name);
    normalizedOutputs.push({
      name: contract.name,
      type: contract.type as FactType,
      ...(contract.required === undefined ? {} : { required: contract.required }),
    });
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, inputFacts: normalizedInputs, outputFacts: normalizedOutputs };
}

/**
 * Require a finite child allocation for each resource that the family limits.
 */
export function validateChildBudgetAgainstFamilyLimits(
  familyLimits: GoalBudgetDefinition,
  childBudget: GoalBudgetDefinition,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (familyLimits.maximumTurns !== undefined) {
    if (childBudget.maximumTurns === undefined) {
      diagnostics.push({
        code: "child_goal_budget_allocation_required",
        message: "The family limits turns. The child budget must declare maximumTurns.",
        location: "budget.maximumTurns",
      });
    }
  }
  if (familyLimits.maximumTokens !== undefined) {
    if (childBudget.maximumTokens === undefined) {
      diagnostics.push({
        code: "child_goal_budget_allocation_required",
        message: "The family limits tokens. The child budget must declare maximumTokens.",
        location: "budget.maximumTokens",
      });
    }
  }
  return diagnostics;
}

/**
 * Report whether two budget limit objects declare the same fields and values.
 */
export function goalBudgetDefinitionsEqual(
  left: GoalBudgetDefinition,
  right: GoalBudgetDefinition,
): boolean {
  return left.maximumTurns === right.maximumTurns
    && left.maximumTokens === right.maximumTokens;
}
