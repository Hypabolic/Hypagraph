import {
  GOAL_FAMILY_SCHEMA_VERSION,
  GoalFamilyRestoreError,
  assertSupportedGoalFamilySchemaVersion,
  createRootFamily,
  restoreFamilyProjection,
  type GoalFamilyEvent,
  type GoalFamilyRuntime,
} from "../domain/goal-family.js";
import type { PersistedHypagraph } from "../domain/model.js";
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

/**
 * Build a one-member persisted family that references an existing workflow stream.
 * The returned workflows map holds a deep clone of the workflow value.
 * The caller-supplied workflow object is not mutated.
 * Requires a started root goal whose identity matches the wrap inputs.
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

  const replayed = replayEvents(input.workflow.events);
  if (replayed.snapshotHash !== input.workflow.snapshot.snapshotHash) {
    throw new GoalFamilyRestoreError(
      "goal_family_workflow_snapshot_mismatch",
      `Workflow '${rootWorkflowId}' snapshot does not match its event stream.`,
    );
  }

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

  const workflowClone: PersistedHypagraph = {
    events: structuredClone(input.workflow.events),
    snapshot: structuredClone(input.workflow.snapshot),
  };

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
 * Replays each nested workflow and requires snapshotHash equality.
 * Does not rewrite workflow event streams.
 */
export function restorePersistedGoalFamily(value: PersistedGoalFamily): PersistedGoalFamily {
  assertSupportedGoalFamilySchemaVersion(value.schemaVersion);
  assertSupportedGoalFamilySchemaVersion(value.familySnapshot.schemaVersion);

  const familySnapshot = restoreFamilyProjection(value.familyEvents, value.familySnapshot);

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
    const replayed = replayEvents(workflow.events);
    if (replayed.snapshotHash !== workflow.snapshot.snapshotHash) {
      throw new GoalFamilyRestoreError(
        "goal_family_workflow_snapshot_mismatch",
        `Goal-family '${familySnapshot.familyId}' workflow '${workflowId}' snapshot does not match its event stream.`,
      );
    }
    workflows[workflowId] = {
      events: structuredClone(workflow.events),
      snapshot: structuredClone(workflow.snapshot),
    };
  }

  for (const member of Object.values(familySnapshot.members)) {
    if (!workflows[member.workflowId]) {
      throw new GoalFamilyRestoreError(
        "goal_family_member_workflow_missing",
        `Goal-family '${familySnapshot.familyId}' member '${member.goalId}' references missing workflow '${member.workflowId}'.`,
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
