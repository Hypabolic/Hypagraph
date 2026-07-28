import {
  GOAL_FAMILY_SCHEMA_VERSION,
  GoalFamilyRestoreError,
  UnsupportedGoalFamilyEventVersionError,
  UnsupportedGoalFamilySchemaError,
  assertSupportedGoalFamilySchemaVersion,
  createRootFamily,
  parseGoalContinuationActionPayload,
  restoreFamilyProjection,
  type GoalFamilyEvent,
  type GoalFamilyRuntime,
} from "../domain/goal-family.js";
import { HYPAGRAPH_EVENT_VERSION, type HypagraphState, type PersistedHypagraph } from "../domain/model.js";
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
 * Validate and restore a persisted family record.
 * Rebuilds membership from family events and rejects unsupported schema versions.
 * Replays each nested workflow and requires full snapshot equality with event replay.
 * Requires each member goal identity to match the nested workflow goal runtime.
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

  for (const member of Object.values(familySnapshot.members)) {
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

  return {
    schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
    familyEvents: structuredClone(value.familyEvents),
    familySnapshot,
    workflows,
  };
}

/**
 * Validate the complete persisted family record shape before restore.
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
    for (let index = 0; index < workflow.events.length; index += 1) {
      assertWorkflowEventShape(workflow.events[index], workflowId, index);
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
 * Validate the common DomainEvent envelope before nested workflow replay.
 * Requires data to be a plain object and version to match HYPAGRAPH_EVENT_VERSION.
 * Full per-event-type payload schema is not required for this slice.
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
