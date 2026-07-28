import {
  childScopeIsWithinParent,
  validateChildBindingFacts,
  validateChildBudgetAgainstFamilyLimits,
  validateChildDefinitionScopes,
} from "./child-goal-binding.js";
import {
  GOAL_FAMILY_EVENT_VERSION,
  GOAL_FAMILY_SCHEMA_VERSION,
  applyFamilyEvent,
  requireGoalFamilyNonEmpty,
  requireGoalFamilyTimestamp,
  type ChildGoalBinding,
  type ChildGoalFailurePolicy,
  type GoalFamilyEvent,
  type GoalFamilyRuntime,
  type GoalParentBinding,
} from "./goal-family.js";
import { createHypagoalWorkflow } from "./hypagoal-creation.js";
import type { FactContract } from "./facts.js";
import type {
  Diagnostic,
  DomainEvent,
  GoalBudgetDefinition,
  HypagraphDefinition,
  HypagraphState,
} from "./model.js";
import { ACTIVE_ROOT_STATUSES } from "./goal-runnable.js";
import { validateGoalBudgetDefinition } from "./goal-budget.js";
import { handleCommand } from "./reducer.js";

export {
  childScopeIsWithinParent,
  pathIsWithinScope,
  validateChildBindingFacts,
  validateChildBudgetAgainstFamilyLimits,
  validateChildDefinitionScopes,
} from "./child-goal-binding.js";

const CHILD_FAILURE_POLICIES = new Set<ChildGoalFailurePolicy>([
  "fail-parent-node",
  "block-parent-node",
  "return-for-revision",
]);

export interface CreateBoundedChildGoalInput {
  family: GoalFamilyRuntime;
  /** Parent workflow state that owns the invoking task. */
  parentState: HypagraphState;
  parentNodeId: string;
  childDefinition: HypagraphDefinition;
  childGoalId: string;
  childWorkflowId: string;
  bindingId: string;
  at: string;
  /** Repository scope paths granted to the child. Empty means unrestricted only when parent scope is unrestricted. */
  scopePaths: string[];
  /** Budget reserved for the child from the root family budget. */
  budget?: GoalBudgetDefinition;
  failurePolicy?: ChildGoalFailurePolicy;
  inputFacts?: string[];
  outputFacts?: FactContract[];
  correlationId?: string;
  causationId?: string;
  familyEventId?: string;
  parentCommandId?: string;
}

export type BoundedChildGoalResult =
  | {
    ok: true;
    family: GoalFamilyRuntime;
    familyEvents: GoalFamilyEvent[];
    parentState: HypagraphState;
    parentEvents: DomainEvent[];
    childState: HypagraphState;
    childEvents: DomainEvent[];
    binding: ChildGoalBinding;
  }
  | { ok: false; diagnostics: Diagnostic[] };

const reject = (code: string, message: string, location?: string): BoundedChildGoalResult => ({
  ok: false,
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

/**
 * Resolve the scope available to a parent task for child creation.
 * Prefer the invoking parent node scope when declared.
 * For a nested parent without a node scope, require its creation binding.
 * Root without a node scope is unrestricted (empty path list).
 */
export function resolveParentAvailableScope(
  family: GoalFamilyRuntime,
  parentState: HypagraphState,
  parentNodeId: string,
  parentGoalId: string,
): { ok: true; paths: string[] } | { ok: false; code: string; message: string; location?: string } {
  const node = parentState.definition.nodes.find((item) => item.id === parentNodeId);
  if (node?.scope?.paths !== undefined) {
    return { ok: true, paths: structuredClone(node.scope.paths) };
  }
  const parentMember = family.members[parentGoalId];
  if (parentMember?.parent) {
    const parentBinding = Object.values(family.bindings).find(
      (binding) => binding.childGoalId === parentGoalId,
    );
    if (!parentBinding) {
      return {
        ok: false,
        code: "child_goal_parent_binding_missing",
        message: `Nested parent goal '${parentGoalId}' has no creation binding and no node scope. `
          + "A child goal cannot resolve available scope.",
        location: "parentState.goal.goalId",
      };
    }
    return { ok: true, paths: structuredClone(parentBinding.scopePaths) };
  }
  return { ok: true, paths: [] };
}

function safeClone<T>(value: T, code: string, message: string, location?: string):
  | { ok: true; value: T }
  | { ok: false; diagnostics: Diagnostic[] } {
  try {
    return { ok: true, value: structuredClone(value) };
  } catch {
    return {
      ok: false,
      diagnostics: [{ code, message, ...(location ? { location } : {}) }],
    };
  }
}

/**
 * Create a bounded child goal as one family-level atomic operation.
 *
 * On success the result includes:
 * - family membership and binding events;
 * - parent workflow wait-for-child events;
 * - a started child workflow and goal.
 *
 * On failure the result includes diagnostics only.
 * Inputs are not mutated. Partial child state is not returned.
 */
export function createBoundedChildGoal(input: CreateBoundedChildGoalInput): BoundedChildGoalResult {
  if (input.family.schemaVersion !== GOAL_FAMILY_SCHEMA_VERSION) {
    return reject(
      "unsupported_goal_family_schema",
      `Unsupported goal-family schema version '${String(input.family.schemaVersion)}'. `
      + `Expected schema version ${GOAL_FAMILY_SCHEMA_VERSION}.`,
      "family.schemaVersion",
    );
  }

  const childGoalError = requireGoalFamilyNonEmpty(input.childGoalId, "child goal ID");
  if (childGoalError) return reject("invalid_child_goal_id", childGoalError, "childGoalId");

  const childWorkflowError = requireGoalFamilyNonEmpty(input.childWorkflowId, "child workflow ID");
  if (childWorkflowError) {
    return reject("invalid_child_workflow_id", childWorkflowError, "childWorkflowId");
  }

  const bindingIdError = requireGoalFamilyNonEmpty(input.bindingId, "binding ID");
  if (bindingIdError) return reject("invalid_child_binding_id", bindingIdError, "bindingId");

  const parentNodeError = requireGoalFamilyNonEmpty(input.parentNodeId, "parent node ID");
  if (parentNodeError) return reject("invalid_parent_node_id", parentNodeError, "parentNodeId");

  const atError = requireGoalFamilyTimestamp(input.at);
  if (atError) return reject("invalid_goal_family_timestamp", atError, "at");

  if (!Array.isArray(input.scopePaths) || input.scopePaths.some((path) => typeof path !== "string")) {
    return reject(
      "invalid_child_scope",
      "The child scope paths must be an array of strings.",
      "scopePaths",
    );
  }
  if (input.scopePaths.some((path) => !path.trim())) {
    return reject(
      "invalid_child_scope",
      "Each child scope path must be a non-empty string.",
      "scopePaths",
    );
  }

  const failurePolicy = input.failurePolicy ?? "fail-parent-node";
  if (!CHILD_FAILURE_POLICIES.has(failurePolicy)) {
    return reject(
      "invalid_child_failure_policy",
      `Unsupported child failure policy '${String(input.failurePolicy)}'.`,
      "failurePolicy",
    );
  }

  const factsValidated = validateChildBindingFacts(input.inputFacts, input.outputFacts);
  if (!factsValidated.ok) return { ok: false, diagnostics: factsValidated.diagnostics };

  const budgetDiagnostics = validateGoalBudgetDefinition(input.budget);
  if (budgetDiagnostics.length > 0) {
    return { ok: false, diagnostics: budgetDiagnostics };
  }
  const budgetClone = safeClone(
    input.budget ?? {},
    "invalid_child_budget",
    "The child budget could not be cloned as a plain value.",
    "budget",
  );
  if (!budgetClone.ok) return budgetClone;
  const budget = budgetClone.value;

  const parentGoalId = input.parentState.goal?.goalId;
  if (!parentGoalId) {
    return reject(
      "child_goal_parent_goal_missing",
      `Parent workflow '${input.parentState.workflowId}' has no goal runtime.`,
      "parentState.goal",
    );
  }

  const parentMember = input.family.members[parentGoalId];
  if (!parentMember) {
    return reject(
      "goal_family_parent_missing",
      `Goal family '${input.family.familyId}' does not contain parent goal '${parentGoalId}'.`,
      "parentState.goal.goalId",
    );
  }
  if (parentMember.workflowId !== input.parentState.workflowId) {
    return reject(
      "goal_family_parent_workflow_mismatch",
      `Parent goal '${parentGoalId}' belongs to workflow '${parentMember.workflowId}', `
      + `not '${input.parentState.workflowId}'.`,
      "parentState.workflowId",
    );
  }

  if (input.parentState.goal?.status !== "active") {
    return reject(
      "child_goal_parent_goal_not_active",
      `Parent goal '${parentGoalId}' is '${input.parentState.goal?.status ?? "missing"}'. `
      + "A child goal can be created only while the parent goal is active.",
      "parentState.goal.status",
    );
  }
  if (input.parentState.phase !== "running") {
    return reject(
      "child_goal_parent_workflow_not_running",
      `Parent workflow '${input.parentState.workflowId}' is '${input.parentState.phase}'. `
      + "A child goal can be created only while the parent workflow is running.",
      "parentState.phase",
    );
  }

  const parentNodeDefinition = input.parentState.definition.nodes.find(
    (node) => node.id === input.parentNodeId,
  );
  if (!parentNodeDefinition) {
    return reject(
      "unknown_parent_node",
      `Parent workflow '${input.parentState.workflowId}' has no node '${input.parentNodeId}'.`,
      "parentNodeId",
    );
  }
  if ((parentNodeDefinition.kind ?? "task") !== "task") {
    return reject(
      "child_goal_parent_not_task",
      `Node '${input.parentNodeId}' cannot create a child goal. Only a task node can create a child goal.`,
      "parentNodeId",
    );
  }

  const parentNodeRuntime = input.parentState.runtime.nodes[input.parentNodeId];
  if (!parentNodeRuntime) {
    return reject(
      "unknown_parent_node",
      `Parent node '${input.parentNodeId}' has no runtime state.`,
      "parentNodeId",
    );
  }
  if (!ACTIVE_ROOT_STATUSES.has(parentNodeRuntime.status)) {
    return reject(
      "child_goal_parent_not_active",
      `Parent task '${input.parentNodeId}' is '${parentNodeRuntime.status}'. `
      + "A child goal can be created only from an active parent task attempt.",
      "parentNodeId",
    );
  }
  if (!parentNodeRuntime.currentAttemptId) {
    return reject(
      "child_goal_parent_attempt_missing",
      `Parent task '${input.parentNodeId}' has no current attempt.`,
      "parentNodeId",
    );
  }

  const childDepth = parentMember.depth + 1;
  if (childDepth > input.family.bounds.maxDepth) {
    return reject(
      "goal_family_depth_exceeded",
      `Child goal depth ${childDepth} exceeds family maxDepth ${input.family.bounds.maxDepth}.`,
      "bounds.maxDepth",
    );
  }

  const memberCount = Object.keys(input.family.members).length;
  if (memberCount + 1 > input.family.bounds.maxGoalsInFamily) {
    return reject(
      "goal_family_member_count_exceeded",
      `Goal family '${input.family.familyId}' already has ${memberCount} members. `
      + `maxGoalsInFamily is ${input.family.bounds.maxGoalsInFamily}.`,
      "bounds.maxGoalsInFamily",
    );
  }

  if (parentMember.childGoalIds.length + 1 > input.family.bounds.maxChildrenPerGoal) {
    return reject(
      "goal_family_children_per_goal_exceeded",
      `Parent goal '${parentGoalId}' already has ${parentMember.childGoalIds.length} children. `
      + `maxChildrenPerGoal is ${input.family.bounds.maxChildrenPerGoal}.`,
      "bounds.maxChildrenPerGoal",
    );
  }

  const attemptsFromNode = Object.values(input.family.bindings).filter(
    (binding) =>
      binding.parentGoalId === parentGoalId
      && binding.parentNodeId === input.parentNodeId,
  ).length;
  if (attemptsFromNode + 1 > input.family.bounds.maxChildCreationAttemptsPerNode) {
    return reject(
      "goal_family_child_creation_attempts_exceeded",
      `Parent node '${input.parentNodeId}' already created ${attemptsFromNode} child goals. `
      + `maxChildCreationAttemptsPerNode is ${input.family.bounds.maxChildCreationAttemptsPerNode}.`,
      "bounds.maxChildCreationAttemptsPerNode",
    );
  }

  if (input.family.members[input.childGoalId]) {
    return reject(
      "goal_family_member_exists",
      `Goal family '${input.family.familyId}' already contains member '${input.childGoalId}'.`,
      "childGoalId",
    );
  }
  const workflowOwner = Object.values(input.family.members).find(
    (member) => member.workflowId === input.childWorkflowId,
  );
  if (workflowOwner) {
    return reject(
      "goal_family_workflow_in_use",
      `Goal family '${input.family.familyId}' already uses workflow '${input.childWorkflowId}' `
      + `for member '${workflowOwner.goalId}'.`,
      "childWorkflowId",
    );
  }
  if (input.family.bindings[input.bindingId]) {
    return reject(
      "goal_family_binding_exists",
      `Goal family '${input.family.familyId}' already contains binding '${input.bindingId}'.`,
      "bindingId",
    );
  }

  const availableScope = resolveParentAvailableScope(
    input.family,
    input.parentState,
    input.parentNodeId,
    parentGoalId,
  );
  if (!availableScope.ok) {
    return reject(availableScope.code, availableScope.message, availableScope.location);
  }
  if (!childScopeIsWithinParent(input.scopePaths, availableScope.paths)) {
    return reject(
      "child_goal_scope_widened",
      `Child scope paths must equal or narrow the scope available to parent task '${input.parentNodeId}'.`,
      "scopePaths",
    );
  }

  const nodeScopeDiagnostics = validateChildDefinitionScopes(
    input.childDefinition,
    input.scopePaths,
  );
  if (nodeScopeDiagnostics.length > 0) {
    return { ok: false, diagnostics: nodeScopeDiagnostics };
  }

  const requiredAllocationDiagnostics = validateChildBudgetAgainstFamilyLimits(
    input.family.familyBudget.limits,
    budget,
  );
  if (requiredAllocationDiagnostics.length > 0) {
    return { ok: false, diagnostics: requiredAllocationDiagnostics };
  }

  const allocateTurns = budget.maximumTurns ?? 0;
  const allocateTokens = budget.maximumTokens ?? 0;
  const nextReservedTurns = input.family.familyBudget.reservedTurns + allocateTurns;
  const nextReservedTokens = input.family.familyBudget.reservedTokens + allocateTokens;
  if (
    input.family.familyBudget.limits.maximumTurns !== undefined
    && nextReservedTurns > input.family.familyBudget.limits.maximumTurns
  ) {
    return reject(
      "goal_family_budget_exceeded",
      `Child turn allocation ${allocateTurns} exceeds remaining family turn capacity `
      + `(reserved ${input.family.familyBudget.reservedTurns} of `
      + `${input.family.familyBudget.limits.maximumTurns}).`,
      "budget.maximumTurns",
    );
  }
  if (
    input.family.familyBudget.limits.maximumTokens !== undefined
    && nextReservedTokens > input.family.familyBudget.limits.maximumTokens
  ) {
    return reject(
      "goal_family_budget_exceeded",
      `Child token allocation ${allocateTokens} exceeds remaining family token capacity `
      + `(reserved ${input.family.familyBudget.reservedTokens} of `
      + `${input.family.familyBudget.limits.maximumTokens}).`,
      "budget.maximumTokens",
    );
  }

  const parentBinding: GoalParentBinding = {
    parentGoalId,
    parentWorkflowId: parentMember.workflowId,
    parentNodeId: input.parentNodeId,
  };

  const scopeClone = safeClone(
    input.scopePaths,
    "invalid_child_scope",
    "The child scope paths could not be cloned as plain values.",
    "scopePaths",
  );
  if (!scopeClone.ok) return scopeClone;

  const binding: ChildGoalBinding = {
    bindingId: input.bindingId,
    childGoalId: input.childGoalId,
    parentGoalId,
    parentWorkflowId: parentMember.workflowId,
    parentNodeId: input.parentNodeId,
    parentAttemptId: parentNodeRuntime.currentAttemptId,
    inputFacts: factsValidated.inputFacts,
    outputFacts: factsValidated.outputFacts,
    budget: structuredClone(budget),
    failurePolicy,
    scopePaths: scopeClone.value,
    status: "active",
    createdAt: input.at,
  };

  // Create and start the child workflow before family/parent commits so definition failures
  // produce diagnostics with no family or parent wait state.
  const childCreated = createHypagoalWorkflow(input.childDefinition, {
    workflowId: input.childWorkflowId,
    goalId: input.childGoalId,
    goalWorkflowId: input.childWorkflowId,
    at: input.at,
    ...(Object.keys(budget).length > 0 ? { budget: structuredClone(budget) } : {}),
  });
  if (!childCreated.ok) return { ok: false, diagnostics: childCreated.diagnostics };

  const correlationId = input.correlationId
    ?? `family-child-create:${input.family.familyId}:${input.childGoalId}`;
  const causationId = input.causationId ?? correlationId;

  const parentWait = handleCommand(input.parentState, {
    type: "wait-for-child",
    nodeId: input.parentNodeId,
    attemptId: parentNodeRuntime.currentAttemptId,
    childGoalId: input.childGoalId,
    bindingId: input.bindingId,
    commandId: input.parentCommandId ?? `wait-for-child:${input.parentNodeId}:${input.bindingId}`,
    correlationId,
    at: input.at,
  });
  if (!parentWait.ok) return { ok: false, diagnostics: parentWait.diagnostics };

  const familySequence = input.family.schedulerOrdinal + 1;
  const familyEvent: GoalFamilyEvent = {
    eventId: input.familyEventId ?? `family-child-created:${input.family.familyId}:${input.childGoalId}`,
    familyId: input.family.familyId,
    sequence: familySequence,
    type: "hypagraph.family.child-created",
    version: GOAL_FAMILY_EVENT_VERSION,
    timestamp: input.at,
    causationId,
    correlationId,
    data: {
      goalId: input.childGoalId,
      workflowId: input.childWorkflowId,
      parent: structuredClone(parentBinding),
      depth: childDepth,
      binding: structuredClone(binding),
    },
  };

  let nextFamily: GoalFamilyRuntime;
  try {
    nextFamily = applyFamilyEvent(input.family, familyEvent);
  } catch (error) {
    // Convert restore-style integrity failures into command diagnostics.
    // Inputs remain unchanged because applyFamilyEvent clones before mutation.
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "goal_family_child_create_failed";
    return reject(code, message);
  }

  return {
    ok: true,
    family: nextFamily,
    familyEvents: [familyEvent],
    parentState: parentWait.state,
    parentEvents: parentWait.events,
    childState: childCreated.state,
    childEvents: childCreated.events,
    binding: structuredClone(binding),
  };
}

