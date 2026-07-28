import {
  childScopeIsWithinParent,
  goalBudgetDefinitionsEqual,
  validateChildDefinitionScopes,
} from "../domain/child-goal-binding.js";
import type { BoundedChildGoalResult } from "../domain/child-goal-creation.js";
import {
  GOAL_FAMILY_SCHEMA_VERSION,
  GoalFamilyRestoreError,
  UnsupportedGoalFamilyEventVersionError,
  UnsupportedGoalFamilySchemaError,
  assertSupportedGoalFamilySchemaVersion,
  createRootFamily,
  parseGoalContinuationActionPayload,
  restoreFamilyProjection,
  type ChildGoalBinding,
  type FamilyBounds,
  type GoalFamilyEvent,
  type GoalFamilyRuntime,
} from "../domain/goal-family.js";
import { ACTIVE_ROOT_STATUSES } from "../domain/goal-runnable.js";
import {
  HYPAGRAPH_EVENT_VERSION,
  type DomainEvent,
  type GoalBudgetDefinition,
  type HypagraphState,
  type PersistedHypagraph,
} from "../domain/model.js";
import { replayEvents } from "../domain/projection.js";
import type { WorkflowEventStore } from "./event-store.js";

/** Custom entry type for a persisted goal-family record. */
export const HYPAGRAPH_FAMILY_RECORD_TYPE = "hypagraph.family-record.v1";

/**
 * Persisted goal-family aggregate.
 * Family state sits above per-workflow PersistedHypagraph streams.
 * Saving a family must not rewrite workflow event history.
 */
export interface PersistedGoalFamily {
  schemaVersion: typeof GOAL_FAMILY_SCHEMA_VERSION;
  familyEvents: GoalFamilyEvent[];
  familySnapshot: GoalFamilyRuntime;
  workflows: Record<string, PersistedHypagraph>;
}

export interface GoalFamilyStore {
  save(value: PersistedGoalFamily): Promise<PersistedGoalFamily>;
  load(familyId: string): Promise<PersistedGoalFamily | undefined>;
}

export interface CreateOneMemberFamilyInput {
  familyId: string;
  rootGoalId: string;
  /** Existing workflow aggregate. Its event history is cloned by reference value, not rewritten. */
  workflow: PersistedHypagraph;
  at: string;
  bounds?: FamilyBounds;
  familyBudgetLimits?: GoalBudgetDefinition;
  eventId?: string;
  correlationId?: string;
  causationId?: string;
}

export interface MigrateRootWorkflowToOneMemberFamilyInput {
  /**
   * Stable family identity. The caller supplies this pure input.
   * Domain helpers do not invent family IDs from the clock or random values.
   * Product restore can use defaultOneMemberFamilyId when no family record exists yet.
   */
  familyId: string;
  /**
   * Existing root workflow aggregate with a started goal runtime.
   * Migration clones this value. It does not mutate the input object.
   * Migration does not append workflow-domain events and does not re-hash the workflow snapshot.
   */
  workflow: PersistedHypagraph;
  /** Family-created event timestamp. Pure input. */
  at: string;
  eventId?: string;
  correlationId?: string;
  causationId?: string;
}

/**
 * Derive a stable one-member family ID from pure root identities.
 * The result is deterministic for the same goal and workflow IDs.
 * Encoding is length-prefixed so identities that contain ':' cannot collide.
 * Example: goal `a:b` with workflow `c` is distinct from goal `a` with workflow `b:c`.
 * This helper does not read the clock or create random values.
 */
export function defaultOneMemberFamilyId(rootGoalId: string, rootWorkflowId: string): string {
  if (typeof rootGoalId !== "string" || !rootGoalId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_root_goal_id",
      "A one-member family ID requires a non-empty root goal ID.",
    );
  }
  if (typeof rootWorkflowId !== "string" || !rootWorkflowId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_root_workflow_id",
      "A one-member family ID requires a non-empty root workflow ID.",
    );
  }
  return `family:${rootGoalId.length}:${rootGoalId}:${rootWorkflowId.length}:${rootWorkflowId}`;
}

/**
 * Migrate an existing root workflow into a one-member family projection.
 * Use this entry point when a v0.6-style root must become a family member.
 * This reuses buildOneMemberPersistedFamily and keeps the same no-rewrite rules.
 *
 * Guarantees:
 * - root goalId and workflowId are preserved in family membership;
 * - workflow events and snapshot.snapshotHash are deep-equal to the pre-migration stream;
 * - the input workflow object is not mutated;
 * - no workflow-domain events are appended;
 * - the workflow snapshot is not re-hashed.
 *
 * familyId is a pure caller-supplied input. Prefer defaultOneMemberFamilyId for product restore.
 */
export function migrateRootWorkflowToOneMemberFamily(
  input: MigrateRootWorkflowToOneMemberFamilyInput,
): PersistedGoalFamily {
  const goal = input.workflow.snapshot.goal;
  if (!goal) {
    throw new GoalFamilyRestoreError(
      "goal_family_root_goal_missing",
      `Workflow '${input.workflow.snapshot.workflowId}' has no goal runtime. `
      + "Migration requires a started root goal.",
    );
  }

  return buildOneMemberPersistedFamily({
    familyId: input.familyId,
    rootGoalId: goal.goalId,
    workflow: input.workflow,
    at: input.at,
    ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
  });
}

/**
 * Build a one-member persisted family that references an existing workflow stream.
 * The returned workflows map holds a deep clone of the workflow value.
 * The caller-supplied workflow object is not mutated.
 * Requires a started root goal whose identity matches the wrap inputs.
 * Nested workflow snapshot must fully match event replay. The canonical snapshot is event-derived.
 *
 * For migration of an existing root, prefer migrateRootWorkflowToOneMemberFamily.
 */
export function buildOneMemberPersistedFamily(input: CreateOneMemberFamilyInput): PersistedGoalFamily {
  const rootWorkflowId = input.workflow.snapshot.workflowId;
  if (typeof rootWorkflowId !== "string" || !rootWorkflowId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_root_workflow_id",
      "A one-member family requires a non-empty workflow ID on the workflow snapshot.",
    );
  }

  if (input.workflow.events.length === 0) {
    throw new GoalFamilyRestoreError(
      "empty_workflow_event_stream",
      `Workflow '${rootWorkflowId}' has an empty event stream.`,
    );
  }

  if (input.workflow.events.some((event) => event.workflowId !== rootWorkflowId)) {
    throw new GoalFamilyRestoreError(
      "goal_family_workflow_event_mismatch",
      `The workflow event stream for '${rootWorkflowId}' contains events for a different workflow.`,
    );
  }

  const goal = input.workflow.snapshot.goal;
  if (!goal) {
    throw new GoalFamilyRestoreError(
      "goal_family_root_goal_missing",
      `Workflow '${rootWorkflowId}' has no goal runtime. A one-member family requires a started root goal.`,
    );
  }
  if (goal.goalId !== input.rootGoalId) {
    throw new GoalFamilyRestoreError(
      "goal_family_root_goal_mismatch",
      `Root goal '${input.rootGoalId}' does not match workflow goal '${goal.goalId}'.`,
    );
  }
  if (goal.workflowId !== rootWorkflowId) {
    throw new GoalFamilyRestoreError(
      "goal_family_goal_workflow_mismatch",
      `Goal '${goal.goalId}' targets workflow '${goal.workflowId}', `
      + `but the workflow snapshot ID is '${rootWorkflowId}'.`,
    );
  }

  const workflowClone = restoreWorkflowAggregate(
    input.workflow,
    `Workflow '${rootWorkflowId}'`,
  );

  const created = createRootFamily({
    familyId: input.familyId,
    rootGoalId: input.rootGoalId,
    rootWorkflowId,
    at: input.at,
    ...(input.bounds !== undefined ? { bounds: input.bounds } : {}),
    ...(input.familyBudgetLimits !== undefined
      ? { familyBudgetLimits: input.familyBudgetLimits }
      : {}),
    ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
  });
  if (!created.ok) {
    const first = created.diagnostics[0];
    throw new GoalFamilyRestoreError(
      first?.code ?? "goal_family_create_failed",
      first?.message ?? "The one-member goal family could not be created.",
    );
  }

  return {
    schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
    familyEvents: created.events,
    familySnapshot: created.family,
    workflows: {
      [rootWorkflowId]: workflowClone,
    },
  };
}

/**
 * Commit a successful bounded child-goal creation into a persisted family record.
 * Updates the parent workflow stream, adds the child workflow stream, and appends family events.
 * The input family record is not mutated.
 * Rejects a failed creation result with a typed restore error.
 */
export function commitBoundedChildGoalToPersistedFamily(
  family: PersistedGoalFamily,
  creation: Extract<BoundedChildGoalResult, { ok: true }>,
): PersistedGoalFamily {
  if (!creation.ok) {
    throw new GoalFamilyRestoreError(
      "goal_family_child_create_failed",
      "A failed child-goal creation cannot be committed to a persisted family.",
    );
  }

  const parentWorkflowId = creation.parentState.workflowId;
  const childWorkflowId = creation.childState.workflowId;
  const existingParent = family.workflows[parentWorkflowId];
  if (!existingParent) {
    throw new GoalFamilyRestoreError(
      "goal_family_member_workflow_missing",
      `Persisted family '${family.familySnapshot.familyId}' is missing parent workflow '${parentWorkflowId}'.`,
    );
  }
  if (family.workflows[childWorkflowId]) {
    throw new GoalFamilyRestoreError(
      "goal_family_workflow_in_use",
      `Persisted family '${family.familySnapshot.familyId}' already contains workflow '${childWorkflowId}'.`,
    );
  }

  const next: PersistedGoalFamily = {
    schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
    familyEvents: [...structuredClone(family.familyEvents), ...structuredClone(creation.familyEvents)],
    familySnapshot: structuredClone(creation.family),
    workflows: {
      ...cloneWorkflowMap(family.workflows),
      [parentWorkflowId]: {
        events: [...structuredClone(existingParent.events), ...structuredClone(creation.parentEvents)],
        snapshot: structuredClone(creation.parentState),
      },
      [childWorkflowId]: {
        events: structuredClone(creation.childEvents),
        snapshot: structuredClone(creation.childState),
      },
    },
  };

  return restorePersistedGoalFamily(next);
}

/**
 * Validate and restore a persisted family record.
 * Rebuilds membership from family events and rejects unsupported schema versions.
 * Replays each nested workflow and requires full snapshot equality with event replay.
 * Requires each member goal identity to match the nested workflow goal runtime.
 * Requires each child binding to match a parent wait-for-child event and member workflow.
 * Does not rewrite workflow event streams.
 */
export function restorePersistedGoalFamily(value: PersistedGoalFamily): PersistedGoalFamily {
  assertPersistedGoalFamilyShape(value);
  assertSupportedGoalFamilySchemaVersion(value.schemaVersion);
  assertSupportedGoalFamilySchemaVersion(value.familySnapshot.schemaVersion);

  const familySnapshot = withTypedFamilyRestoreError(
    () => restoreFamilyProjection(value.familyEvents, value.familySnapshot),
    "invalid_goal_family_custom_entry",
    "The stored goal-family membership could not be restored",
  );

  const workflows: Record<string, PersistedHypagraph> = {};
  for (const [workflowId, workflow] of Object.entries(value.workflows)) {
    if (workflow.snapshot.workflowId !== workflowId) {
      throw new GoalFamilyRestoreError(
        "goal_family_workflow_map_key_mismatch",
        `Workflow map key '${workflowId}' does not match snapshot workflow ID '${workflow.snapshot.workflowId}'.`,
      );
    }
    if (workflow.events.length === 0) {
      throw new GoalFamilyRestoreError(
        "empty_workflow_event_stream",
        `Goal-family '${familySnapshot.familyId}' workflow '${workflowId}' has an empty event stream.`,
      );
    }
    workflows[workflowId] = restoreWorkflowAggregate(
      workflow,
      `Goal-family '${familySnapshot.familyId}' workflow '${workflowId}'`,
    );
  }

  const memberWorkflowIds = new Set<string>();
  for (const member of Object.values(familySnapshot.members)) {
    memberWorkflowIds.add(member.workflowId);
    const workflow = workflows[member.workflowId];
    if (!workflow) {
      throw new GoalFamilyRestoreError(
        "goal_family_member_workflow_missing",
        `Goal-family '${familySnapshot.familyId}' member '${member.goalId}' references missing workflow '${member.workflowId}'.`,
      );
    }

    const goal = workflow.snapshot.goal;
    if (!goal) {
      throw new GoalFamilyRestoreError(
        "goal_family_member_goal_missing",
        `Goal-family '${familySnapshot.familyId}' member '${member.goalId}' workflow '${member.workflowId}' has no goal runtime.`,
      );
    }
    if (goal.goalId !== member.goalId) {
      throw new GoalFamilyRestoreError(
        "goal_family_member_goal_mismatch",
        `Goal-family '${familySnapshot.familyId}' member '${member.goalId}' does not match workflow goal '${goal.goalId}'.`,
      );
    }
    if (goal.workflowId !== member.workflowId) {
      throw new GoalFamilyRestoreError(
        "goal_family_member_goal_workflow_mismatch",
        `Goal-family '${familySnapshot.familyId}' member '${member.goalId}' workflow binding '${member.workflowId}' `
        + `does not match goal workflow '${goal.workflowId}'.`,
      );
    }
  }

  for (const workflowId of Object.keys(workflows)) {
    if (!memberWorkflowIds.has(workflowId)) {
      throw new GoalFamilyRestoreError(
        "goal_family_orphan_workflow",
        `Goal-family '${familySnapshot.familyId}' stores workflow '${workflowId}' without a family member.`,
      );
    }
  }

  validateChildBindingWorkflowIntegrity(familySnapshot, workflows);

  return {
    schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
    familyEvents: structuredClone(value.familyEvents),
    familySnapshot,
    workflows,
  };
}

/**
 * Validate that each child binding matches parent wait state and child workflow membership.
 * Active bindings require a matching hypagraph.task.waiting-for-child event and current wait status.
 * Each current parent wait requires exactly one matching binding and child workflow.
 * Child workflow budgets must equal binding budgets. Child node scopes must not widen the binding.
 */
function validateChildBindingWorkflowIntegrity(
  family: GoalFamilyRuntime,
  workflows: Record<string, PersistedHypagraph>,
): void {
  const bindings = Object.values(family.bindings);

  for (const binding of bindings) {
    const parentWorkflow = workflows[binding.parentWorkflowId];
    if (!parentWorkflow) {
      throw new GoalFamilyRestoreError(
        "goal_family_binding_parent_workflow_missing",
        `Binding '${binding.bindingId}' references missing parent workflow '${binding.parentWorkflowId}'.`,
      );
    }
    const childMember = family.members[binding.childGoalId];
    if (!childMember) {
      throw new GoalFamilyRestoreError(
        "goal_family_binding_child_missing",
        `Binding '${binding.bindingId}' references missing child member '${binding.childGoalId}'.`,
      );
    }
    const childWorkflow = workflows[childMember.workflowId];
    if (!childWorkflow) {
      throw new GoalFamilyRestoreError(
        "goal_family_binding_child_workflow_missing",
        `Binding '${binding.bindingId}' child '${binding.childGoalId}' references missing workflow `
        + `'${childMember.workflowId}'.`,
      );
    }

    const waitMatch = findMatchingWaitEvent(parentWorkflow, binding);
    if (!waitMatch) {
      throw new GoalFamilyRestoreError(
        "goal_family_binding_wait_missing",
        `Binding '${binding.bindingId}' has no matching parent wait-for-child event on workflow `
        + `'${binding.parentWorkflowId}' for node '${binding.parentNodeId}'.`,
      );
    }
    // Pre-wait state is authoritative for create-time scope. Post-wait revisions must not
    // invent a node scope that bypasses the parent creation-binding requirement.
    const preWaitState = validateWaitEventCreateCapableParent(
      parentWorkflow,
      waitMatch.index,
      waitMatch.event,
      binding.bindingId,
    );

    const parentNode = parentWorkflow.snapshot.runtime.nodes[binding.parentNodeId];
    if (!parentNode || parentNode.status !== "waiting_for_child") {
      throw new GoalFamilyRestoreError(
        "goal_family_binding_parent_not_waiting",
        `Binding '${binding.bindingId}' requires parent node '${binding.parentNodeId}' `
        + "to be in waiting_for_child status.",
      );
    }
    if (parentNode.currentAttemptId !== binding.parentAttemptId) {
      throw new GoalFamilyRestoreError(
        "goal_family_binding_parent_attempt_mismatch",
        `Binding '${binding.bindingId}' parent attempt '${binding.parentAttemptId}' does not match `
        + `current attempt '${parentNode.currentAttemptId ?? "none"}' on node '${binding.parentNodeId}'.`,
      );
    }

    const childGoalBudget = childWorkflow.snapshot.goal?.budget.limits ?? {};
    if (!goalBudgetDefinitionsEqual(childGoalBudget, binding.budget)) {
      throw new GoalFamilyRestoreError(
        "goal_family_binding_budget_mismatch",
        `Binding '${binding.bindingId}' budget does not match child goal budget limits `
        + `on workflow '${childMember.workflowId}'.`,
      );
    }

    const parentAvailableScope = resolvePersistedParentAvailableScope(
      family,
      preWaitState,
      binding,
    );
    if (!childScopeIsWithinParent(binding.scopePaths, parentAvailableScope)) {
      throw new GoalFamilyRestoreError(
        "goal_family_binding_scope_widened",
        `Binding '${binding.bindingId}' scope widens beyond the scope available to parent node `
        + `'${binding.parentNodeId}'.`,
      );
    }

    const nodeScopeDiagnostics = validateChildDefinitionScopes(
      childWorkflow.snapshot.definition,
      binding.scopePaths,
    );
    if (nodeScopeDiagnostics.length > 0) {
      const first = nodeScopeDiagnostics[0]!;
      throw new GoalFamilyRestoreError(first.code, first.message);
    }
  }

  // Reverse direction: each current parent wait must have exactly one matching binding.
  for (const [workflowId, workflow] of Object.entries(workflows)) {
    const parentGoalId = workflow.snapshot.goal?.goalId;
    if (!parentGoalId) continue;
    for (const [nodeId, nodeRuntime] of Object.entries(workflow.snapshot.runtime.nodes)) {
      if (nodeRuntime.status !== "waiting_for_child") continue;
      const attemptId = nodeRuntime.currentAttemptId;
      if (!attemptId) {
        throw new GoalFamilyRestoreError(
          "goal_family_wait_attempt_missing",
          `Workflow '${workflowId}' node '${nodeId}' is waiting_for_child without a current attempt.`,
        );
      }
      const currentWait = findCurrentWaitEvent(workflow, nodeId, attemptId);
      if (!currentWait) {
        throw new GoalFamilyRestoreError(
          "goal_family_wait_event_missing",
          `Workflow '${workflowId}' node '${nodeId}' is waiting_for_child without a wait event.`,
        );
      }
      const waitChildGoalId = typeof currentWait.event.data.childGoalId === "string"
        ? currentWait.event.data.childGoalId
        : "";
      const waitBindingId = typeof currentWait.event.data.bindingId === "string"
        ? currentWait.event.data.bindingId
        : "";
      if (!waitChildGoalId || !waitBindingId) {
        throw new GoalFamilyRestoreError(
          "goal_family_wait_event_incomplete",
          `Workflow '${workflowId}' wait event on node '${nodeId}' requires childGoalId and bindingId.`,
        );
      }

      const matches = bindings.filter((binding) =>
        binding.parentWorkflowId === workflowId
        && binding.parentGoalId === parentGoalId
        && binding.parentNodeId === nodeId
        && binding.parentAttemptId === attemptId
        && binding.childGoalId === waitChildGoalId
        && binding.bindingId === waitBindingId);
      if (matches.length === 0) {
        throw new GoalFamilyRestoreError(
          "goal_family_wait_binding_missing",
          `Workflow '${workflowId}' node '${nodeId}' is waiting_for_child without a matching family binding.`,
        );
      }
      if (matches.length > 1) {
        throw new GoalFamilyRestoreError(
          "goal_family_wait_binding_ambiguous",
          `Workflow '${workflowId}' node '${nodeId}' has ${matches.length} matching family bindings `
          + "for one current wait.",
        );
      }
      const binding = matches[0]!;
      validateWaitEventCreateCapableParent(
        workflow,
        currentWait.index,
        currentWait.event,
        binding.bindingId,
      );
      if (!family.members[binding.childGoalId] || !workflows[family.members[binding.childGoalId]!.workflowId]) {
        throw new GoalFamilyRestoreError(
          "goal_family_wait_child_workflow_missing",
          `Workflow '${workflowId}' wait on node '${nodeId}' binding '${binding.bindingId}' `
          + "has no child member workflow.",
        );
      }
    }
  }
}

/**
 * Find the wait event that matches a binding identity completely.
 * Returns the event and its exact array index for pre-wait replay.
 */
function findMatchingWaitEvent(
  parentWorkflow: PersistedHypagraph,
  binding: ChildGoalBinding,
): { event: DomainEvent; index: number } | undefined {
  for (let index = 0; index < parentWorkflow.events.length; index += 1) {
    const event = parentWorkflow.events[index]!;
    if (
      event.type === "hypagraph.task.waiting-for-child"
      && event.nodeId === binding.parentNodeId
      && event.attemptId === binding.parentAttemptId
      && event.data?.childGoalId === binding.childGoalId
      && event.data?.bindingId === binding.bindingId
    ) {
      return { event, index };
    }
  }
  return undefined;
}

/**
 * Find the latest wait-for-child event for a node attempt (current wait identity).
 * Returns the event and its exact array index for pre-wait replay.
 */
function findCurrentWaitEvent(
  workflow: PersistedHypagraph,
  nodeId: string,
  attemptId: string,
): { event: DomainEvent; index: number } | undefined {
  let latest: { event: DomainEvent; index: number } | undefined;
  for (let index = 0; index < workflow.events.length; index += 1) {
    const event = workflow.events[index]!;
    if (
      event.type === "hypagraph.task.waiting-for-child"
      && event.nodeId === nodeId
      && event.attemptId === attemptId
    ) {
      latest = { event, index };
    }
  }
  return latest;
}

/**
 * Replay the parent workflow up to but not including the wait event at waitIndex.
 * Require a running workflow, active goal, task node in a create-capable state, and matching attempt.
 * Returns the pre-wait state for create-time scope resolution.
 */
function validateWaitEventCreateCapableParent(
  workflow: PersistedHypagraph,
  waitIndex: number,
  waitEvent: DomainEvent,
  bindingId: string,
): HypagraphState {
  if (waitIndex < 0 || waitIndex >= workflow.events.length) {
    throw new GoalFamilyRestoreError(
      "goal_family_binding_wait_missing",
      `Binding '${bindingId}' wait event index ${waitIndex} is outside workflow `
      + `'${workflow.snapshot.workflowId}'.`,
    );
  }
  if (workflow.events[waitIndex] !== waitEvent) {
    throw new GoalFamilyRestoreError(
      "goal_family_binding_wait_missing",
      `Binding '${bindingId}' wait event does not match workflow event at index ${waitIndex}.`,
    );
  }
  const prefix = workflow.events.slice(0, waitIndex);
  if (prefix.length === 0) {
    throw new GoalFamilyRestoreError(
      "goal_family_wait_parent_not_active",
      `Binding '${bindingId}' wait event has no preceding workflow state.`,
    );
  }
  let preState: HypagraphState;
  try {
    preState = replayEvents(prefix);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GoalFamilyRestoreError(
      "goal_family_wait_prestate_replay_failed",
      `Binding '${bindingId}' wait pre-state could not be replayed: ${detail}`,
    );
  }
  if (preState.phase !== "running") {
    throw new GoalFamilyRestoreError(
      "goal_family_wait_parent_workflow_not_running",
      `Binding '${bindingId}' wait event requires parent workflow phase 'running'. `
      + `Found '${preState.phase}'.`,
    );
  }
  if (preState.goal?.status !== "active") {
    throw new GoalFamilyRestoreError(
      "goal_family_wait_parent_goal_not_active",
      `Binding '${bindingId}' wait event requires parent goal status 'active'. `
      + `Found '${preState.goal?.status ?? "missing"}'.`,
    );
  }
  const nodeId = waitEvent.nodeId;
  if (!nodeId) {
    throw new GoalFamilyRestoreError(
      "goal_family_wait_parent_not_task",
      `Binding '${bindingId}' wait event requires a parent node ID.`,
    );
  }
  const definitionNode = preState.definition.nodes.find((node) => node.id === nodeId);
  if (!definitionNode || (definitionNode.kind ?? "task") !== "task") {
    throw new GoalFamilyRestoreError(
      "goal_family_wait_parent_not_task",
      `Binding '${bindingId}' wait event requires parent node '${nodeId}' to be a task.`,
    );
  }
  const runtime = preState.runtime.nodes[nodeId];
  if (!runtime || !ACTIVE_ROOT_STATUSES.has(runtime.status)) {
    throw new GoalFamilyRestoreError(
      "goal_family_wait_parent_not_active",
      `Binding '${bindingId}' wait event requires parent node '${nodeId}' to be in an active `
      + `create-capable state. Found '${runtime?.status ?? "missing"}'.`,
    );
  }
  if (!runtime.currentAttemptId || runtime.currentAttemptId !== waitEvent.attemptId) {
    throw new GoalFamilyRestoreError(
      "goal_family_wait_parent_attempt_mismatch",
      `Binding '${bindingId}' wait event attempt does not match the pre-wait current attempt `
      + `on node '${nodeId}'.`,
    );
  }
  return preState;
}

/**
 * Resolve the scope available to a parent binding from persisted workflows.
 * Prefer the invoking parent node scope when declared.
 * Nested parents without a node scope require a creation binding.
 * Root without a node scope is unrestricted (empty path list).
 */
function resolvePersistedParentAvailableScope(
  family: GoalFamilyRuntime,
  parentState: HypagraphState,
  binding: ChildGoalBinding,
): string[] {
  const node = parentState.definition.nodes.find((item) => item.id === binding.parentNodeId);
  if (node?.scope?.paths !== undefined) {
    return structuredClone(node.scope.paths);
  }
  const parentMember = family.members[binding.parentGoalId];
  if (parentMember?.parent) {
    const parentCreationBinding = Object.values(family.bindings).find(
      (candidate) => candidate.childGoalId === binding.parentGoalId,
    );
    if (!parentCreationBinding) {
      throw new GoalFamilyRestoreError(
        "goal_family_parent_binding_missing",
        `Nested parent goal '${binding.parentGoalId}' has no creation binding and no node scope `
        + `for child binding '${binding.bindingId}'.`,
      );
    }
    return structuredClone(parentCreationBinding.scopePaths);
  }
  return [];
}

/**
 * Validate the complete persisted family record shape before restore.
 * Checks the outer schema version before version-specific field requirements.
 * Rejects malformed family events, members, nested workflows, and workflow events with typed errors.
 * Call this before domain replay so malformed data does not throw an untyped TypeError.
 */
export function assertPersistedGoalFamilyShape(value: unknown): asserts value is PersistedGoalFamily {
  if (!isPlainObject(value)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_custom_entry",
      "The stored goal-family record must be a plain object.",
    );
  }

  if (typeof value.schemaVersion !== "number") {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_custom_entry",
      "The stored goal-family record must include a numeric schemaVersion.",
    );
  }

  // Reject unsupported schema versions before version-specific shape rules.
  assertSupportedGoalFamilySchemaVersion(value.schemaVersion);

  if (!Array.isArray(value.familyEvents)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_custom_entry",
      "The stored goal-family record must include a familyEvents array.",
    );
  }
  for (let index = 0; index < value.familyEvents.length; index += 1) {
    assertFamilyEventShape(value.familyEvents[index], index);
  }

  if (!isPlainObject(value.familySnapshot)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_custom_entry",
      "The stored goal-family record must include a familySnapshot object.",
    );
  }

  const snapshot = value.familySnapshot;
  if (typeof snapshot.schemaVersion !== "number") {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_custom_entry",
      "The stored goal-family snapshot must include a numeric schemaVersion.",
    );
  }
  // Reject unsupported nested snapshot schema before version-specific field checks.
  assertSupportedGoalFamilySchemaVersion(snapshot.schemaVersion);
  if (typeof snapshot.familyId !== "string" || !snapshot.familyId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_custom_entry",
      "The stored goal-family snapshot must include a non-empty familyId.",
    );
  }
  if (typeof snapshot.rootGoalId !== "string" || !snapshot.rootGoalId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_custom_entry",
      "The stored goal-family snapshot must include a non-empty rootGoalId.",
    );
  }
  if (typeof snapshot.schedulerOrdinal !== "number") {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_custom_entry",
      "The stored goal-family snapshot must include a numeric schedulerOrdinal.",
    );
  }
  if (typeof snapshot.createdAt !== "string" || typeof snapshot.updatedAt !== "string") {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_custom_entry",
      "The stored goal-family snapshot must include createdAt and updatedAt strings.",
    );
  }
  if (!isPlainObject(snapshot.members)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_custom_entry",
      "The stored goal-family snapshot must include a members object.",
    );
  }
  for (const [memberKey, member] of Object.entries(snapshot.members)) {
    assertFamilyMemberShape(member, memberKey);
  }
  if (!isPlainObject(snapshot.bounds)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_custom_entry",
      "The stored goal-family snapshot must include a bounds object.",
    );
  }
  if (!isPlainObject(snapshot.bindings) || Array.isArray(snapshot.bindings)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_custom_entry",
      "The stored goal-family snapshot must include a bindings object map.",
    );
  }
  if (!isPlainObject(snapshot.familyBudget) || Array.isArray(snapshot.familyBudget)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_custom_entry",
      "The stored goal-family snapshot must include a familyBudget object.",
    );
  }

  if (!isPlainObject(value.workflows) || Array.isArray(value.workflows)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_custom_entry",
      "The stored goal-family record must include a workflows object map.",
    );
  }

  for (const [workflowId, workflow] of Object.entries(value.workflows)) {
    if (!isPlainObject(workflow)) {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_workflow",
        `Goal-family workflow '${workflowId}' must be a plain object.`,
      );
    }
    if (!Array.isArray(workflow.events)) {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_workflow_events",
        `Goal-family workflow '${workflowId}' must include an events array.`,
      );
    }
    const seenEventIds = new Set<string>();
    for (let index = 0; index < workflow.events.length; index += 1) {
      assertWorkflowEventShape(workflow.events[index], workflowId, index);
      const eventId = (workflow.events[index] as { eventId?: unknown }).eventId;
      if (typeof eventId === "string" && eventId.trim()) {
        if (seenEventIds.has(eventId)) {
          throw new GoalFamilyRestoreError(
            "invalid_goal_family_workflow_event_id_duplicate",
            `Goal-family workflow '${workflowId}' reuses event ID '${eventId}' at index ${index}.`,
          );
        }
        seenEventIds.add(eventId);
      }
    }
    if (!isPlainObject(workflow.snapshot)) {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_workflow_snapshot",
        `Goal-family workflow '${workflowId}' must include a snapshot object.`,
      );
    }
  }
}

/**
 * Known workflow event types accepted in nested family workflow streams.
 * Unknown types are rejected so fall-through projection cannot accept forged streams.
 */
const KNOWN_WORKFLOW_EVENT_TYPES = new Set<string>([
  "hypagraph.workflow.defined",
  "hypagraph.workflow.revised",
  "hypagraph.workflow.paused",
  "hypagraph.workflow.resumed",
  "hypagraph.workflow.completed",
  "hypagraph.workflow.failed",
  "hypagraph.goal.started",
  "hypagraph.goal.paused",
  "hypagraph.goal.resumed",
  "hypagraph.goal.blocked",
  "hypagraph.goal.completed",
  "hypagraph.goal.failed",
  "hypagraph.goal.cancelled",
  "hypagraph.goal.continuation-requested",
  "hypagraph.goal.continuation-abandoned",
  "hypagraph.goal.turn-recorded",
  "hypagraph.goal.budget-limited",
  "hypagraph.goal.revision-requested",
  "hypagraph.goal.revision-rejected",
  "hypagraph.goal.revision-abandoned",
  "hypagraph.goal.revision-applied",
  "hypagraph.node.ready",
  "hypagraph.node.skipped",
  "hypagraph.node.invalidated",
  "hypagraph.node.blocked",
  "hypagraph.node.unblocked",
  "hypagraph.attempt.started",
  "hypagraph.attempt.result-submitted",
  "hypagraph.check.started",
  "hypagraph.evaluation.started",
  "hypagraph.check.result-recorded",
  "hypagraph.code.started",
  "hypagraph.code.result-recorded",
  "hypagraph.effect.requested",
  "hypagraph.effect.observed",
  "hypagraph.effect.indeterminate",
  "hypagraph.effect.reconciled",
  "hypagraph.interaction.requested",
  "hypagraph.interaction.presented",
  "hypagraph.interaction.answered",
  "hypagraph.interaction.expired",
  "hypagraph.task.waiting-for-child",
  "hypagraph.fact.published",
  "hypagraph.route.selected",
  "hypagraph.verification.started",
  "hypagraph.verification.passed",
  "hypagraph.verification.failed",
  "hypagraph.attempt.cancelled",
  "hypagraph.loop.iteration-started",
  "hypagraph.loop.evaluated",
  "hypagraph.loop.invalidated",
  "hypagraph.loop.blocked",
  "hypagraph.loop.completed",
  "hypagraph.loop.failed",
  "hypagraph.action.selected",
  "hypagraph.action.dispatched",
  "hypagraph.action.completed",
  "hypagraph.action.failed",
  "hypagraph.action.interrupted",
]);

/**
 * Validate the common DomainEvent envelope before nested workflow replay.
 * Requires data to be a plain object and version to match HYPAGRAPH_EVENT_VERSION.
 * Rejects unknown event types so nested family restore does not accept fall-through events.
 */
function assertWorkflowEventShape(event: unknown, workflowId: string, index: number): void {
  const location = `Goal-family workflow '${workflowId}' event at index ${index}`;
  if (!isPlainObject(event)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_workflow_event",
      `${location} must be a plain object.`,
    );
  }
  if (typeof event.eventId !== "string" || !event.eventId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_workflow_event",
      `${location} must include a non-empty eventId.`,
    );
  }
  if (typeof event.workflowId !== "string" || !event.workflowId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_workflow_event",
      `${location} must include a non-empty workflowId.`,
    );
  }
  if (typeof event.revision !== "number" || !Number.isSafeInteger(event.revision)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_workflow_event",
      `${location} must include a safe integer revision.`,
    );
  }
  if (typeof event.sequence !== "number" || !Number.isSafeInteger(event.sequence)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_workflow_event",
      `${location} must include a safe integer sequence.`,
    );
  }
  if (typeof event.type !== "string" || !event.type.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_workflow_event",
      `${location} must include a non-empty type.`,
    );
  }
  if (!KNOWN_WORKFLOW_EVENT_TYPES.has(event.type)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_workflow_event_type",
      `${location} has unsupported event type '${event.type}'.`,
    );
  }
  if (event.version !== HYPAGRAPH_EVENT_VERSION) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_workflow_event_version",
      `${location} has unsupported event version '${String(event.version)}'. `
      + `Expected event version ${HYPAGRAPH_EVENT_VERSION}.`,
    );
  }
  if (typeof event.timestamp !== "string" || !event.timestamp.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_workflow_event",
      `${location} must include a non-empty timestamp.`,
    );
  }
  if (typeof event.causationId !== "string" || !event.causationId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_workflow_event",
      `${location} must include a non-empty causationId.`,
    );
  }
  if (typeof event.correlationId !== "string" || !event.correlationId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_workflow_event",
      `${location} must include a non-empty correlationId.`,
    );
  }
  if (!isPlainObject(event.data)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_workflow_event",
      `${location} must include a plain object data payload.`,
    );
  }
}

function assertFamilyEventShape(event: unknown, index: number): void {
  if (!isPlainObject(event)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `Family event at index ${index} must be a plain object.`,
    );
  }
  if (typeof event.type !== "string" || !event.type.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `Family event at index ${index} must include a non-empty type.`,
    );
  }
  if (typeof event.eventId !== "string" || !event.eventId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `Family event at index ${index} must include a non-empty eventId.`,
    );
  }
  if (typeof event.familyId !== "string" || !event.familyId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `Family event at index ${index} must include a non-empty familyId.`,
    );
  }
  if (typeof event.sequence !== "number") {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `Family event at index ${index} must include a numeric sequence.`,
    );
  }
  if (typeof event.version !== "number") {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `Family event at index ${index} must include a numeric version.`,
    );
  }
  if (typeof event.timestamp !== "string" || !event.timestamp.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `Family event at index ${index} must include a non-empty timestamp.`,
    );
  }
  if (typeof event.causationId !== "string" || typeof event.correlationId !== "string") {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `Family event at index ${index} must include causationId and correlationId strings.`,
    );
  }
  if (!isPlainObject(event.data)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `Family event at index ${index} must include a data object.`,
    );
  }

  if (event.type === "hypagraph.family.created") {
    if (typeof event.data.rootGoalId !== "string" || typeof event.data.rootWorkflowId !== "string") {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `Family-created event at index ${index} must include rootGoalId and rootWorkflowId strings.`,
      );
    }
    if (!isPlainObject(event.data.bounds)) {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `Family-created event at index ${index} must include a bounds object.`,
      );
    }
    if (!isPlainObject(event.data.familyBudgetLimits)) {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `Family-created event at index ${index} must include a familyBudgetLimits object.`,
      );
    }
    return;
  }

  if (event.type === "hypagraph.family.member-added") {
    if (typeof event.data.goalId !== "string" || typeof event.data.workflowId !== "string") {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `Family member-added event at index ${index} must include goalId and workflowId strings.`,
      );
    }
    if (typeof event.data.depth !== "number") {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `Family member-added event at index ${index} must include a numeric depth.`,
      );
    }
    assertParentBindingShape(event.data.parent, `Family member-added event at index ${index}`);
    return;
  }

  if (event.type === "hypagraph.family.child-created") {
    if (typeof event.data.goalId !== "string" || typeof event.data.workflowId !== "string") {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `Family child-created event at index ${index} must include goalId and workflowId strings.`,
      );
    }
    if (typeof event.data.depth !== "number") {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `Family child-created event at index ${index} must include a numeric depth.`,
      );
    }
    assertParentBindingShape(event.data.parent, `Family child-created event at index ${index}`);
    if (!isPlainObject(event.data.binding)) {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `Family child-created event at index ${index} must include a binding object.`,
      );
    }
    if (typeof event.data.binding.bindingId !== "string" || !event.data.binding.bindingId.trim()) {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `Family child-created event at index ${index} binding must include a non-empty bindingId.`,
      );
    }
    if (typeof event.data.binding.childGoalId !== "string" || !event.data.binding.childGoalId.trim()) {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `Family child-created event at index ${index} binding must include a non-empty childGoalId.`,
      );
    }
    return;
  }

  if (event.type === "hypagraph.family.action-selected") {
    if (typeof event.data.dispatchId !== "string" || !event.data.dispatchId.trim()) {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `Family action-selected event at index ${index} must include a non-empty dispatchId.`,
      );
    }
    assertFamilySelectionShape(event.data.selection, `Family action-selected event at index ${index}`);
    return;
  }

  if (
    event.type === "hypagraph.family.action-dispatched"
    || event.type === "hypagraph.family.action-completed"
    || event.type === "hypagraph.family.action-failed"
    || event.type === "hypagraph.family.action-interrupted"
  ) {
    if (typeof event.data.dispatchId !== "string" || !event.data.dispatchId.trim()) {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `Family ${String(event.type)} event at index ${index} must include a non-empty dispatchId.`,
      );
    }
    if (event.data.reason !== undefined && typeof event.data.reason !== "string") {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `Family ${String(event.type)} event at index ${index} reason must be a string when present.`,
      );
    }
    return;
  }

  throw new GoalFamilyRestoreError(
    "invalid_goal_family_event",
    `Family event at index ${index} has unsupported type '${String(event.type)}'.`,
  );
}

function assertFamilySelectionShape(selection: unknown, location: string): void {
  if (!isPlainObject(selection)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `${location} must include a selection object.`,
    );
  }
  if (typeof selection.familyId !== "string" || !selection.familyId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `${location} selection must include a non-empty familyId.`,
    );
  }
  if (typeof selection.goalId !== "string" || !selection.goalId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `${location} selection must include a non-empty goalId.`,
    );
  }
  if (typeof selection.workflowId !== "string" || !selection.workflowId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `${location} selection must include a non-empty workflowId.`,
    );
  }
  if (typeof selection.revision !== "number" || !Number.isSafeInteger(selection.revision)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `${location} selection must include a safe integer revision.`,
    );
  }
  if (typeof selection.selectedSequence !== "number" || !Number.isSafeInteger(selection.selectedSequence)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `${location} selection must include a safe integer selectedSequence.`,
    );
  }
  if (typeof selection.selectedSnapshotHash !== "string" || !selection.selectedSnapshotHash.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `${location} selection must include a non-empty selectedSnapshotHash.`,
    );
  }
  if (
    typeof selection.memberContinuationOrdinal !== "number"
    || !Number.isSafeInteger(selection.memberContinuationOrdinal)
  ) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `${location} selection must include a safe integer memberContinuationOrdinal.`,
    );
  }
  if (typeof selection.reason !== "string" || !selection.reason.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `${location} selection must include a non-empty reason.`,
    );
  }
  const parsedAction = parseGoalContinuationActionPayload(selection.action);
  if (!parsedAction.ok) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_event",
      `${location} selection action is invalid: ${parsedAction.message}`,
    );
  }
  const action = parsedAction.action;
  if (action.kind === "request-revision") {
    if (selection.nodeId !== undefined) {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `${location} request-revision selection must not declare nodeId.`,
      );
    }
    if (selection.loopId !== undefined) {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_event",
        `${location} request-revision selection must not declare loopId.`,
      );
    }
  } else {
    if (selection.nodeId !== undefined) {
      if (typeof selection.nodeId !== "string" || !selection.nodeId.trim()) {
        throw new GoalFamilyRestoreError(
          "invalid_goal_family_event",
          `${location} selection nodeId must be a non-empty string when present.`,
        );
      }
      if (selection.nodeId !== action.nodeId) {
        throw new GoalFamilyRestoreError(
          "invalid_goal_family_event",
          `${location} selection nodeId does not match action nodeId.`,
        );
      }
    }
    if (selection.loopId !== undefined) {
      if (typeof selection.loopId !== "string" || !selection.loopId.trim()) {
        throw new GoalFamilyRestoreError(
          "invalid_goal_family_event",
          `${location} selection loopId must be a non-empty string when present.`,
        );
      }
      if ((action.loopId ?? undefined) !== selection.loopId) {
        throw new GoalFamilyRestoreError(
          "invalid_goal_family_event",
          `${location} selection loopId does not match action loopId.`,
        );
      }
    }
  }
}

function assertFamilyMemberShape(member: unknown, memberKey: string): void {
  if (!isPlainObject(member)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_member",
      `Family member '${memberKey}' must be a plain object.`,
    );
  }
  if (typeof member.goalId !== "string" || !member.goalId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_member",
      `Family member '${memberKey}' must include a non-empty goalId.`,
    );
  }
  if (typeof member.workflowId !== "string" || !member.workflowId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_member",
      `Family member '${memberKey}' must include a non-empty workflowId.`,
    );
  }
  if (typeof member.rootGoalId !== "string" || !member.rootGoalId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_member",
      `Family member '${memberKey}' must include a non-empty rootGoalId.`,
    );
  }
  if (typeof member.depth !== "number") {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_member",
      `Family member '${memberKey}' must include a numeric depth.`,
    );
  }
  if (!Array.isArray(member.childGoalIds)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_member",
      `Family member '${memberKey}' must include a childGoalIds array.`,
    );
  }
  for (let index = 0; index < member.childGoalIds.length; index += 1) {
    if (typeof member.childGoalIds[index] !== "string") {
      throw new GoalFamilyRestoreError(
        "invalid_goal_family_member",
        `Family member '${memberKey}' childGoalIds[${index}] must be a string.`,
      );
    }
  }
  if (member.parent !== undefined) {
    assertParentBindingShape(member.parent, `Family member '${memberKey}'`);
  }
}

function assertParentBindingShape(parent: unknown, location: string): void {
  if (!isPlainObject(parent)) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_parent",
      `${location} parent binding must be a plain object.`,
    );
  }
  if (typeof parent.parentGoalId !== "string" || !parent.parentGoalId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_parent",
      `${location} parent binding must include a non-empty parentGoalId.`,
    );
  }
  if (typeof parent.parentWorkflowId !== "string" || !parent.parentWorkflowId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_parent",
      `${location} parent binding must include a non-empty parentWorkflowId.`,
    );
  }
  if (typeof parent.parentNodeId !== "string" || !parent.parentNodeId.trim()) {
    throw new GoalFamilyRestoreError(
      "invalid_goal_family_parent",
      `${location} parent binding must include a non-empty parentNodeId.`,
    );
  }
}

/**
 * Replay a workflow aggregate and require full snapshot integrity.
 * Returns a deep clone that stores the event-derived snapshot as the canonical value.
 * The input workflow object is not mutated.
 * Malformed event payloads become GoalFamilyRestoreError instead of untyped TypeError.
 */
function restoreWorkflowAggregate(
  workflow: PersistedHypagraph,
  detail: string,
): PersistedHypagraph {
  const replayed = withTypedFamilyRestoreError(
    () => replayEvents(workflow.events),
    "invalid_goal_family_workflow_event",
    `${detail} event stream could not be replayed`,
  );
  if (replayed.snapshotHash !== workflow.snapshot.snapshotHash) {
    throw new GoalFamilyRestoreError(
      "goal_family_workflow_snapshot_mismatch",
      `${detail} snapshot does not match its event stream.`,
    );
  }
  if (!workflowSnapshotsEqual(replayed, workflow.snapshot)) {
    throw new GoalFamilyRestoreError(
      "goal_family_workflow_snapshot_mismatch",
      `${detail} snapshot fields do not match event replay.`,
    );
  }
  return {
    events: structuredClone(workflow.events),
    snapshot: structuredClone(replayed),
  };
}

function withTypedFamilyRestoreError<T>(
  run: () => T,
  code: string,
  message: string,
): T {
  try {
    return run();
  } catch (error) {
    if (
      error instanceof GoalFamilyRestoreError
      || error instanceof UnsupportedGoalFamilySchemaError
      || error instanceof UnsupportedGoalFamilyEventVersionError
    ) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new GoalFamilyRestoreError(code, `${message}: ${detail}`);
  }
}

function workflowSnapshotsEqual(left: HypagraphState, right: HypagraphState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * True for plain JSON-like objects only.
 * Accepts Object.prototype and null-prototype objects.
 * Rejects arrays, Date, Map, Set, RegExp, and other class instances.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * In-memory family store above workflow aggregates.
 * Optional workflow store is used only for read-through of existing streams.
 * Family save never appends to or rewrites workflow event history.
 */
export class InMemoryGoalFamilyStore implements GoalFamilyStore {
  private readonly families = new Map<string, PersistedGoalFamily>();

  constructor(private readonly workflowStore?: WorkflowEventStore & {
    read?(workflowId: string): PersistedHypagraph | undefined;
  }) {}

  /**
   * Seed a family record without restore validation.
   * Tests use this for unsupported-schema fixtures. Production load uses restore paths.
   */
  seed(value: PersistedGoalFamily): void {
    this.families.set(value.familySnapshot.familyId, {
      schemaVersion: value.schemaVersion,
      familyEvents: structuredClone(value.familyEvents),
      familySnapshot: structuredClone(value.familySnapshot),
      workflows: cloneWorkflowMap(value.workflows),
    });
  }

  async save(value: PersistedGoalFamily): Promise<PersistedGoalFamily> {
    const restored = restorePersistedGoalFamily(value);
    this.families.set(restored.familySnapshot.familyId, restored);
    return restored;
  }

  async load(familyId: string): Promise<PersistedGoalFamily | undefined> {
    const stored = this.families.get(familyId);
    if (!stored) return undefined;
    return restorePersistedGoalFamily(stored);
  }

  /**
   * Create and store a one-member family for an existing workflow aggregate.
   * The existing workflow event history is not rewritten.
   * Returns the canonical restored record stored by save.
   */
  async saveOneMemberFamily(input: CreateOneMemberFamilyInput): Promise<PersistedGoalFamily> {
    return this.save(buildOneMemberPersistedFamily(input));
  }

  /**
   * Migrate an existing root workflow into a stored one-member family projection.
   * The existing workflow event history is not rewritten.
   * Returns the canonical restored record stored by save.
   */
  async migrateRootToOneMemberFamily(
    input: MigrateRootWorkflowToOneMemberFamilyInput,
  ): Promise<PersistedGoalFamily> {
    return this.save(migrateRootWorkflowToOneMemberFamily(input));
  }

  /**
   * Read a workflow that a family references.
   * Prefers the family-local copy so family restore does not depend on mutating the workflow store.
   */
  readFamilyWorkflow(familyId: string, workflowId: string): PersistedHypagraph | undefined {
    const family = this.families.get(familyId);
    const fromFamily = family?.workflows[workflowId];
    if (fromFamily) {
      return {
        events: structuredClone(fromFamily.events),
        snapshot: structuredClone(fromFamily.snapshot),
      };
    }
    if (this.workflowStore?.read) {
      return this.workflowStore.read(workflowId);
    }
    return undefined;
  }

  listFamilyIds(): string[] {
    return [...this.families.keys()].sort();
  }
}

function cloneWorkflowMap(
  workflows: Record<string, PersistedHypagraph>,
): Record<string, PersistedHypagraph> {
  const next: Record<string, PersistedHypagraph> = {};
  for (const [workflowId, workflow] of Object.entries(workflows)) {
    next[workflowId] = {
      events: structuredClone(workflow.events),
      snapshot: structuredClone(workflow.snapshot),
    };
  }
  return next;
}
