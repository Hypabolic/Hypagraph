/**
 * Schema and normalization for hypagoal_create_child.
 *
 * Creates a bounded child Hypagoal from an active parent task through the
 * product path. Pure domain rules live in child-goal-creation. Host commit
 * uses createBoundedChildGoalInFamily.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { FactContract } from "../domain/facts.js";
import type { ChildGoalFailurePolicy } from "../domain/goal-family.js";
import type { GoalBudgetDefinition, HypagraphDefinition } from "../domain/model.js";
import { definitionSchema, normalizeDefinition } from "./definition.js";

const goalBudgetSchema = Type.Object({
  maximumTurns: Type.Optional(Type.Integer({ minimum: 1 })),
  maximumTokens: Type.Optional(Type.Integer({ minimum: 1 })),
});

const factTypeSchema = Type.Union([
  Type.Literal("boolean"),
  Type.Literal("integer"),
  Type.Literal("number"),
  Type.Literal("string"),
  Type.Literal("duration"),
  Type.Literal("timestamp"),
  Type.Literal("string-list"),
]);

const outputFactSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  type: factTypeSchema,
  required: Type.Optional(Type.Boolean()),
});

const failurePolicySchema = StringEnum([
  "fail-parent-node",
  "block-parent-node",
  "return-for-revision",
] as const);

/**
 * Parameters for hypagoal_create_child.
 *
 * Prefer host-generated UUIDs for childGoalId, childWorkflowId, and bindingId.
 * Tests may supply explicit ids for determinism.
 */
export const hypagoalCreateChildSchema = Type.Object({
  parentNodeId: Type.String({ minLength: 1 }),
  childObjective: Type.String({ minLength: 1 }),
  /** Preferred: commit an open project draft as the child definition. */
  draftId: Type.Optional(Type.String({ minLength: 1 })),
  /** Free-form child definition when draftId is not used. */
  definition: Type.Optional(definitionSchema),
  /** Scope paths granted to the child. Must equal or narrow the parent grant. */
  scopePaths: Type.Array(Type.String()),
  outputFacts: Type.Optional(Type.Array(outputFactSchema)),
  inputFacts: Type.Optional(Type.Array(Type.String())),
  budget: Type.Optional(goalBudgetSchema),
  failurePolicy: Type.Optional(failurePolicySchema),
  /** Optional deterministic ids for tests. Prefer host-generated UUIDs in product. */
  childGoalId: Type.Optional(Type.String({ minLength: 1 })),
  childWorkflowId: Type.Optional(Type.String({ minLength: 1 })),
  bindingId: Type.Optional(Type.String({ minLength: 1 })),
});

export type HypagoalCreateChildInput = Static<typeof hypagoalCreateChildSchema>;

export interface NormalizedHypagoalCreateChildInput {
  parentNodeId: string;
  childObjective: string;
  draftId?: string;
  definition?: HypagraphDefinition;
  scopePaths: string[];
  outputFacts?: FactContract[];
  inputFacts?: string[];
  budget?: GoalBudgetDefinition;
  failurePolicy?: ChildGoalFailurePolicy;
  childGoalId?: string;
  childWorkflowId?: string;
  bindingId?: string;
}

/**
 * Normalize hypagoal_create_child params.
 * Requires draftId or definition. Does not load drafts from disk.
 */
export function normalizeHypagoalCreateChildInput(
  input: HypagoalCreateChildInput | Record<string, unknown>,
): NormalizedHypagoalCreateChildInput {
  const record = input as HypagoalCreateChildInput;
  const parentNodeId = typeof record.parentNodeId === "string" ? record.parentNodeId.trim() : "";
  if (!parentNodeId) {
    throw new Error("hypagoal_create_child requires parentNodeId.");
  }
  const childObjective = typeof record.childObjective === "string"
    ? record.childObjective.trim()
    : "";
  if (!childObjective) {
    throw new Error("hypagoal_create_child requires childObjective.");
  }
  const draftId = typeof record.draftId === "string" && record.draftId.trim().length > 0
    ? record.draftId.trim()
    : undefined;
  const hasDefinition = record.definition !== undefined && record.definition !== null;
  if (!draftId && !hasDefinition) {
    throw new Error(
      "hypagoal_create_child requires draftId or definition. Prefer draftId after authoring with construction tools.",
    );
  }
  if (!Array.isArray(record.scopePaths)) {
    throw new Error("hypagoal_create_child requires scopePaths as an array of strings.");
  }
  const scopePaths = record.scopePaths.map((path) => String(path));

  const outputFacts = record.outputFacts === undefined
    ? undefined
    : record.outputFacts.map((fact) => ({
      name: fact.name.trim(),
      type: fact.type,
      ...(fact.required === undefined ? {} : { required: fact.required }),
    }));

  const inputFacts = record.inputFacts === undefined
    ? undefined
    : record.inputFacts.map((name) => String(name).trim()).filter((name) => name.length > 0);

  const optionalId = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const childGoalId = optionalId(record.childGoalId);
  const childWorkflowId = optionalId(record.childWorkflowId);
  const bindingId = optionalId(record.bindingId);

  return {
    parentNodeId,
    childObjective,
    scopePaths,
    ...(draftId === undefined ? {} : { draftId }),
    ...(hasDefinition
      ? { definition: normalizeDefinition(record.definition as HypagoalCreateChildInput["definition"] & object) }
      : {}),
    ...(outputFacts === undefined ? {} : { outputFacts }),
    ...(inputFacts === undefined ? {} : { inputFacts }),
    ...(record.budget === undefined ? {} : { budget: structuredClone(record.budget) }),
    ...(record.failurePolicy === undefined
      ? {}
      : { failurePolicy: record.failurePolicy as ChildGoalFailurePolicy }),
    ...(childGoalId === undefined ? {} : { childGoalId }),
    ...(childWorkflowId === undefined ? {} : { childWorkflowId }),
    ...(bindingId === undefined ? {} : { bindingId }),
  };
}

/**
 * Align child definition goal text with the tool childObjective when free-form
 * definition is supplied. Draft projections keep their authored goal.
 */
export function applyChildObjectiveToDefinition(
  definition: HypagraphDefinition,
  childObjective: string,
): HypagraphDefinition {
  if (definition.goal === childObjective) return definition;
  return {
    ...definition,
    goal: childObjective,
  };
}

/**
 * Render a successful child-create tool result for the model and user.
 */
export function renderHypagoalChildCreated(input: {
  childGoalId: string;
  childWorkflowId: string;
  bindingId: string;
  parentNodeId: string;
  parentGoalId: string;
  familyId: string;
  memberCount: number;
  parentWaitStatus: string;
}): string {
  return [
    "Child Hypagoal created.",
    `Child goal ID: ${input.childGoalId}`,
    `Child workflow ID: ${input.childWorkflowId}`,
    `Binding ID: ${input.bindingId}`,
    `Parent node: ${input.parentNodeId} (${input.parentWaitStatus})`,
    `Parent goal ID: ${input.parentGoalId}`,
    `Family ID: ${input.familyId}`,
    `Family members: ${input.memberCount}`,
    "The parent task waits for the child. Integrate returned facts on the parent task after the child completes.",
  ].join("\n");
}
