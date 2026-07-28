import type { Diagnostic } from "./model.js";

/**
 * Schema version for goal-family runtime and persisted family records.
 * This version is independent of HYPAGRAPH_SCHEMA_VERSION on workflow aggregates.
 */
export const GOAL_FAMILY_SCHEMA_VERSION = 1 as const;

/** Event payload version for family-level events. */
export const GOAL_FAMILY_EVENT_VERSION = 1 as const;

export interface GoalParentBinding {
  parentGoalId: string;
  parentWorkflowId: string;
  parentNodeId: string;
}

export interface GoalFamilyMember {
  goalId: string;
  workflowId: string;
  rootGoalId: string;
  parent?: GoalParentBinding;
  depth: number;
  childGoalIds: string[];
}

export interface GoalFamilyRuntime {
  schemaVersion: typeof GOAL_FAMILY_SCHEMA_VERSION;
  familyId: string;
  rootGoalId: string;
  members: Record<string, GoalFamilyMember>;
  schedulerOrdinal: number;
  createdAt: string;
  updatedAt: string;
}

export type GoalFamilyEventType =
  | "hypagraph.family.created"
  | "hypagraph.family.member-added";

interface GoalFamilyEventBase {
  eventId: string;
  familyId: string;
  sequence: number;
  version: typeof GOAL_FAMILY_EVENT_VERSION;
  timestamp: string;
  causationId: string;
  correlationId: string;
}

export type GoalFamilyEvent =
  | (GoalFamilyEventBase & {
    type: "hypagraph.family.created";
    data: {
      rootGoalId: string;
      rootWorkflowId: string;
    };
  })
  | (GoalFamilyEventBase & {
    type: "hypagraph.family.member-added";
    data: {
      goalId: string;
      workflowId: string;
      parent: GoalParentBinding;
      depth: number;
    };
  });

export type GoalFamilyResult =
  | { ok: true; family: GoalFamilyRuntime; events: GoalFamilyEvent[] }
  | { ok: false; diagnostics: Diagnostic[] };

/** Thrown when a stored family schema version is not supported. */
export class UnsupportedGoalFamilySchemaError extends Error {
  readonly code = "unsupported_goal_family_schema" as const;

  constructor(readonly schemaVersion: unknown) {
    super(
      `Unsupported goal-family schema version '${String(schemaVersion)}'. `
      + `Expected schema version ${GOAL_FAMILY_SCHEMA_VERSION}.`,
    );
    this.name = "UnsupportedGoalFamilySchemaError";
  }
}

/** Thrown when a stored family event version is not supported. */
export class UnsupportedGoalFamilyEventVersionError extends Error {
  readonly code = "unsupported_goal_family_event_version" as const;

  constructor(readonly eventVersion: unknown) {
    super(
      `Unsupported goal-family event version '${String(eventVersion)}'. `
      + `Expected event version ${GOAL_FAMILY_EVENT_VERSION}.`,
    );
    this.name = "UnsupportedGoalFamilyEventVersionError";
  }
}

/**
 * Thrown for family restore and replay integrity failures.
 * Command helpers return GoalFamilyResult diagnostics instead of this error.
 */
export class GoalFamilyRestoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoalFamilyRestoreError";
  }
}

const reject = (code: string, message: string, location?: string): GoalFamilyResult => ({
  ok: false,
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

const requireNonEmpty = (value: string, name: string): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return `The ${name} must be a non-empty string.`;
  return undefined;
};

const requireTimestamp = (value: string): string | undefined => {
  if (!Number.isFinite(Date.parse(value))) return "The timestamp must be a valid date-time string.";
  return undefined;
};

function restoreFail(code: string, message: string): never {
  throw new GoalFamilyRestoreError(code, message);
}

function requireIdentity(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    restoreFail("invalid_goal_family_identity", `The ${name} must be a non-empty string.`);
  }
  return value;
}

const findMemberByWorkflowId = (
  members: Record<string, GoalFamilyMember>,
  workflowId: string,
): GoalFamilyMember | undefined => Object.values(members).find((member) => member.workflowId === workflowId);

/**
 * Assert that a family schema version is supported.
 * Throws UnsupportedGoalFamilySchemaError when the version is not supported.
 */
export function assertSupportedGoalFamilySchemaVersion(schemaVersion: unknown): asserts schemaVersion is typeof GOAL_FAMILY_SCHEMA_VERSION {
  if (schemaVersion !== GOAL_FAMILY_SCHEMA_VERSION) {
    throw new UnsupportedGoalFamilySchemaError(schemaVersion);
  }
}

/**
 * Create a one-member goal family for a root goal and its workflow.
 * Timestamps and identifiers are pure inputs. This function does not read the clock.
 */
export function createRootFamily(input: {
  familyId: string;
  rootGoalId: string;
  rootWorkflowId: string;
  at: string;
  eventId?: string;
  correlationId?: string;
  causationId?: string;
}): GoalFamilyResult {
  const familyIdError = requireNonEmpty(input.familyId, "family ID");
  if (familyIdError) return reject("invalid_goal_family_id", familyIdError, "familyId");

  const rootGoalError = requireNonEmpty(input.rootGoalId, "root goal ID");
  if (rootGoalError) return reject("invalid_goal_family_root_goal_id", rootGoalError, "rootGoalId");

  const rootWorkflowError = requireNonEmpty(input.rootWorkflowId, "root workflow ID");
  if (rootWorkflowError) return reject("invalid_goal_family_root_workflow_id", rootWorkflowError, "rootWorkflowId");

  const atError = requireTimestamp(input.at);
  if (atError) return reject("invalid_goal_family_timestamp", atError, "at");

  const correlationId = input.correlationId ?? `family-create:${input.familyId}`;
  const causationId = input.causationId ?? correlationId;
  const eventId = input.eventId ?? `family-created:${input.familyId}`;

  const event: GoalFamilyEvent = {
    eventId,
    familyId: input.familyId,
    sequence: 1,
    type: "hypagraph.family.created",
    version: GOAL_FAMILY_EVENT_VERSION,
    timestamp: input.at,
    causationId,
    correlationId,
    data: {
      rootGoalId: input.rootGoalId,
      rootWorkflowId: input.rootWorkflowId,
    },
  };

  const family = applyFamilyEvent(undefined, event);
  return { ok: true, family, events: [event] };
}

/**
 * Add a child member to an existing family projection.
 * This helper only updates family membership. It does not create workflow state.
 * Timestamps and identifiers are pure inputs.
 * Command failures return GoalFamilyResult diagnostics and do not throw for schema mismatch.
 */
export function addFamilyMember(input: {
  family: GoalFamilyRuntime;
  goalId: string;
  workflowId: string;
  parent: GoalParentBinding;
  at: string;
  eventId?: string;
  correlationId?: string;
  causationId?: string;
}): GoalFamilyResult {
  if (input.family.schemaVersion !== GOAL_FAMILY_SCHEMA_VERSION) {
    return reject(
      "unsupported_goal_family_schema",
      `Unsupported goal-family schema version '${String(input.family.schemaVersion)}'. `
      + `Expected schema version ${GOAL_FAMILY_SCHEMA_VERSION}.`,
      "family.schemaVersion",
    );
  }

  const goalError = requireNonEmpty(input.goalId, "goal ID");
  if (goalError) return reject("invalid_goal_family_member_goal_id", goalError, "goalId");

  const workflowError = requireNonEmpty(input.workflowId, "workflow ID");
  if (workflowError) return reject("invalid_goal_family_member_workflow_id", workflowError, "workflowId");

  const parentGoalError = requireNonEmpty(input.parent.parentGoalId, "parent goal ID");
  if (parentGoalError) return reject("invalid_goal_family_parent_goal_id", parentGoalError, "parent.parentGoalId");

  const parentWorkflowError = requireNonEmpty(input.parent.parentWorkflowId, "parent workflow ID");
  if (parentWorkflowError) {
    return reject("invalid_goal_family_parent_workflow_id", parentWorkflowError, "parent.parentWorkflowId");
  }

  const parentNodeError = requireNonEmpty(input.parent.parentNodeId, "parent node ID");
  if (parentNodeError) return reject("invalid_goal_family_parent_node_id", parentNodeError, "parent.parentNodeId");

  const atError = requireTimestamp(input.at);
  if (atError) return reject("invalid_goal_family_timestamp", atError, "at");

  if (input.family.members[input.goalId]) {
    return reject(
      "goal_family_member_exists",
      `Goal family '${input.family.familyId}' already contains member '${input.goalId}'.`,
      "goalId",
    );
  }

  const workflowOwner = findMemberByWorkflowId(input.family.members, input.workflowId);
  if (workflowOwner) {
    return reject(
      "goal_family_workflow_in_use",
      `Goal family '${input.family.familyId}' already uses workflow '${input.workflowId}' `
      + `for member '${workflowOwner.goalId}'.`,
      "workflowId",
    );
  }

  const parentMember = input.family.members[input.parent.parentGoalId];
  if (!parentMember) {
    return reject(
      "goal_family_parent_missing",
      `Goal family '${input.family.familyId}' does not contain parent goal '${input.parent.parentGoalId}'.`,
      "parent.parentGoalId",
    );
  }

  if (parentMember.workflowId !== input.parent.parentWorkflowId) {
    return reject(
      "goal_family_parent_workflow_mismatch",
      `Parent goal '${input.parent.parentGoalId}' belongs to workflow '${parentMember.workflowId}', `
      + `not '${input.parent.parentWorkflowId}'.`,
      "parent.parentWorkflowId",
    );
  }

  const depth = parentMember.depth + 1;
  const correlationId = input.correlationId ?? `family-member-add:${input.family.familyId}:${input.goalId}`;
  const causationId = input.causationId ?? correlationId;
  const eventId = input.eventId ?? `family-member-added:${input.family.familyId}:${input.goalId}`;
  const sequence = input.family.schedulerOrdinal + 1;

  const event: GoalFamilyEvent = {
    eventId,
    familyId: input.family.familyId,
    sequence,
    type: "hypagraph.family.member-added",
    version: GOAL_FAMILY_EVENT_VERSION,
    timestamp: input.at,
    causationId,
    correlationId,
    data: {
      goalId: input.goalId,
      workflowId: input.workflowId,
      parent: structuredClone(input.parent),
      depth,
    },
  };

  const family = applyFamilyEvent(input.family, event);
  return { ok: true, family, events: [event] };
}

/**
 * Apply one family event to a family projection.
 * The first event must create the family. Later events require an existing projection.
 * Replay and restore throw typed errors for integrity failures.
 */
export function applyFamilyEvent(
  family: GoalFamilyRuntime | undefined,
  event: GoalFamilyEvent,
): GoalFamilyRuntime {
  if (event.version !== GOAL_FAMILY_EVENT_VERSION) {
    throw new UnsupportedGoalFamilyEventVersionError(event.version);
  }

  requireIdentity(event.eventId, "event ID");
  requireIdentity(event.familyId, "family ID");
  requireIdentity(event.timestamp, "event timestamp");
  if (!Number.isFinite(Date.parse(event.timestamp))) {
    restoreFail("invalid_goal_family_event_timestamp", "The family event timestamp must be a valid date-time string.");
  }

  if (event.type === "hypagraph.family.created") {
    if (family) {
      restoreFail(
        "goal_family_already_created",
        `Goal family '${event.familyId}' is already created.`,
      );
    }
    if (event.sequence !== 1) {
      restoreFail(
        "goal_family_sequence_mismatch",
        `The family-created event must use sequence 1, but received ${event.sequence}.`,
      );
    }

    const rootGoalId = requireIdentity(event.data?.rootGoalId, "root goal ID");
    const rootWorkflowId = requireIdentity(event.data?.rootWorkflowId, "root workflow ID");

    const rootMember: GoalFamilyMember = {
      goalId: rootGoalId,
      workflowId: rootWorkflowId,
      rootGoalId,
      depth: 0,
      childGoalIds: [],
    };

    return {
      schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
      familyId: event.familyId,
      rootGoalId,
      members: { [rootGoalId]: rootMember },
      schedulerOrdinal: event.sequence,
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
    };
  }

  if (event.type !== "hypagraph.family.member-added") {
    restoreFail(
      "unsupported_goal_family_event_type",
      `Unsupported goal-family event type '${String((event as { type?: unknown }).type)}'.`,
    );
  }

  if (!family) {
    restoreFail(
      "goal_family_projection_missing",
      "A family member-added event requires an existing goal-family projection.",
    );
  }
  const current = family;
  assertSupportedGoalFamilySchemaVersion(current.schemaVersion);

  if (event.familyId !== current.familyId) {
    restoreFail(
      "goal_family_id_mismatch",
      `Family event '${event.eventId}' targets family '${event.familyId}', `
      + `but the projection is for family '${current.familyId}'.`,
    );
  }

  const expectedSequence = current.schedulerOrdinal + 1;
  if (event.sequence !== expectedSequence) {
    restoreFail(
      "goal_family_sequence_mismatch",
      `Goal family '${current.familyId}' expected sequence ${expectedSequence}, but received ${event.sequence}.`,
    );
  }

  const goalId = requireIdentity(event.data.goalId, "member goal ID");
  const workflowId = requireIdentity(event.data.workflowId, "member workflow ID");
  const parentGoalId = requireIdentity(event.data.parent.parentGoalId, "parent goal ID");
  const parentWorkflowId = requireIdentity(event.data.parent.parentWorkflowId, "parent workflow ID");
  const parentNodeId = requireIdentity(event.data.parent.parentNodeId, "parent node ID");

  if (!Number.isSafeInteger(event.data.depth) || event.data.depth < 1) {
    restoreFail(
      "invalid_goal_family_member_depth",
      `Member '${goalId}' depth must be a positive safe integer.`,
    );
  }

  if (current.members[goalId]) {
    restoreFail(
      "goal_family_member_exists",
      `Goal family '${current.familyId}' already contains member '${goalId}'.`,
    );
  }

  const workflowOwner = findMemberByWorkflowId(current.members, workflowId);
  if (workflowOwner) {
    restoreFail(
      "goal_family_workflow_in_use",
      `Goal family '${current.familyId}' already uses workflow '${workflowId}' `
      + `for member '${workflowOwner.goalId}'.`,
    );
  }

  const parentMember = current.members[parentGoalId];
  if (!parentMember) {
    restoreFail(
      "goal_family_parent_missing",
      `Goal family '${current.familyId}' does not contain parent goal '${parentGoalId}'.`,
    );
  }

  if (parentMember.workflowId !== parentWorkflowId) {
    restoreFail(
      "goal_family_parent_workflow_mismatch",
      `Parent goal '${parentGoalId}' belongs to workflow '${parentMember.workflowId}', `
      + `not '${parentWorkflowId}'.`,
    );
  }

  const expectedDepth = parentMember.depth + 1;
  if (event.data.depth !== expectedDepth) {
    restoreFail(
      "goal_family_depth_mismatch",
      `Member '${goalId}' expected depth ${expectedDepth}, but received ${event.data.depth}.`,
    );
  }

  const parentBinding: GoalParentBinding = {
    parentGoalId,
    parentWorkflowId,
    parentNodeId,
  };

  const next: GoalFamilyRuntime = structuredClone(current);
  next.schedulerOrdinal = event.sequence;
  next.updatedAt = event.timestamp;
  next.members[goalId] = {
    goalId,
    workflowId,
    rootGoalId: current.rootGoalId,
    parent: parentBinding,
    depth: event.data.depth,
    childGoalIds: [],
  };

  const parent = next.members[parentGoalId]!;
  if (!parent.childGoalIds.includes(goalId)) {
    parent.childGoalIds = [...parent.childGoalIds, goalId];
  }

  return next;
}

/**
 * Rebuild family membership from an ordered family event stream.
 */
export function replayFamilyEvents(events: readonly GoalFamilyEvent[]): GoalFamilyRuntime {
  if (events.length === 0) {
    restoreFail("empty_goal_family_event_stream", "The goal-family event stream is empty.");
  }
  let family: GoalFamilyRuntime | undefined;
  for (const event of events) {
    family = applyFamilyEvent(family, event);
  }
  return family!;
}

/**
 * Validate parent links, depths, child lists, and one-workflow-per-member uniqueness.
 * Product restore must use restoreFamilyProjection. Snapshot-only rebuild also runs this check.
 */
export function validateFamilyMembershipGraph(family: GoalFamilyRuntime): void {
  assertSupportedGoalFamilySchemaVersion(family.schemaVersion);
  requireIdentity(family.familyId, "family ID");
  requireIdentity(family.rootGoalId, "root goal ID");

  const root = family.members[family.rootGoalId];
  if (!root) {
    restoreFail(
      "goal_family_root_missing",
      `Goal-family snapshot '${family.familyId}' does not contain root member '${family.rootGoalId}'.`,
    );
  }

  const seenWorkflows = new Map<string, string>();
  for (const [key, member] of Object.entries(family.members)) {
    requireIdentity(member.goalId, "member goal ID");
    requireIdentity(member.workflowId, "member workflow ID");
    requireIdentity(member.rootGoalId, "member root goal ID");

    if (member.goalId !== key) {
      restoreFail(
        "goal_family_member_key_mismatch",
        `Goal-family '${family.familyId}' member key '${key}' does not match goal ID '${member.goalId}'.`,
      );
    }
    if (member.rootGoalId !== family.rootGoalId) {
      restoreFail(
        "goal_family_root_goal_mismatch",
        `Member '${member.goalId}' root goal '${member.rootGoalId}' does not match family root '${family.rootGoalId}'.`,
      );
    }

    const previousOwner = seenWorkflows.get(member.workflowId);
    if (previousOwner) {
      restoreFail(
        "goal_family_workflow_in_use",
        `Goal family '${family.familyId}' already uses workflow '${member.workflowId}' `
        + `for member '${previousOwner}'.`,
      );
    }
    seenWorkflows.set(member.workflowId, member.goalId);

    if (member.goalId === family.rootGoalId) {
      if (member.parent !== undefined) {
        restoreFail(
          "goal_family_root_has_parent",
          `Root member '${member.goalId}' must not declare a parent binding.`,
        );
      }
      if (member.depth !== 0) {
        restoreFail(
          "goal_family_depth_mismatch",
          `Root member '${member.goalId}' expected depth 0, but received ${member.depth}.`,
        );
      }
    } else {
      const parentBinding = member.parent;
      if (!parentBinding) {
        restoreFail(
          "goal_family_parent_missing",
          `Member '${member.goalId}' is not the root and requires a parent binding.`,
        );
      }
      const parentMember = family.members[parentBinding.parentGoalId];
      if (!parentMember) {
        restoreFail(
          "goal_family_parent_missing",
          `Goal family '${family.familyId}' does not contain parent goal '${parentBinding.parentGoalId}'.`,
        );
      }
      if (parentMember.workflowId !== parentBinding.parentWorkflowId) {
        restoreFail(
          "goal_family_parent_workflow_mismatch",
          `Parent goal '${parentBinding.parentGoalId}' belongs to workflow '${parentMember.workflowId}', `
          + `not '${parentBinding.parentWorkflowId}'.`,
        );
      }
      if (member.depth !== parentMember.depth + 1) {
        restoreFail(
          "goal_family_depth_mismatch",
          `Member '${member.goalId}' expected depth ${parentMember.depth + 1}, but received ${member.depth}.`,
        );
      }
      if (!parentMember.childGoalIds.includes(member.goalId)) {
        restoreFail(
          "goal_family_child_link_missing",
          `Parent '${parentMember.goalId}' does not list child '${member.goalId}'.`,
        );
      }
    }

    for (const childGoalId of member.childGoalIds) {
      const child = family.members[childGoalId];
      if (!child) {
        restoreFail(
          "goal_family_child_missing",
          `Member '${member.goalId}' lists missing child '${childGoalId}'.`,
        );
      }
      if (child.parent?.parentGoalId !== member.goalId) {
        restoreFail(
          "goal_family_child_link_mismatch",
          `Child '${childGoalId}' does not name '${member.goalId}' as its parent.`,
        );
      }
    }
  }
}

/**
 * Rebuild membership from a stored family snapshot.
 * Rejects an unsupported schema version with a clear error.
 * Validates the membership graph. Product restore must use restoreFamilyProjection.
 * Returns a deep clone so callers do not mutate the stored object.
 */
export function rebuildFamilyMembershipFromSnapshot(snapshot: GoalFamilyRuntime): GoalFamilyRuntime {
  assertSupportedGoalFamilySchemaVersion(snapshot.schemaVersion);
  validateFamilyMembershipGraph(snapshot);
  return structuredClone(snapshot);
}

/**
 * Rebuild membership from family events and check that the stored snapshot matches.
 * This is the integrity path for product restore.
 */
export function restoreFamilyProjection(
  events: readonly GoalFamilyEvent[],
  snapshot: GoalFamilyRuntime,
): GoalFamilyRuntime {
  assertSupportedGoalFamilySchemaVersion(snapshot.schemaVersion);
  const rebuilt = replayFamilyEvents(events);
  assertSupportedGoalFamilySchemaVersion(rebuilt.schemaVersion);
  validateFamilyMembershipGraph(rebuilt);
  validateFamilyMembershipGraph(snapshot);

  if (rebuilt.familyId !== snapshot.familyId) {
    restoreFail(
      "goal_family_id_mismatch",
      `The restored family ID '${rebuilt.familyId}' does not match snapshot family ID '${snapshot.familyId}'.`,
    );
  }
  if (rebuilt.rootGoalId !== snapshot.rootGoalId) {
    restoreFail(
      "goal_family_root_goal_mismatch",
      `The restored root goal ID '${rebuilt.rootGoalId}' does not match snapshot root goal ID '${snapshot.rootGoalId}'.`,
    );
  }
  if (rebuilt.schedulerOrdinal !== snapshot.schedulerOrdinal) {
    restoreFail(
      "goal_family_sequence_mismatch",
      `The restored family sequence ${rebuilt.schedulerOrdinal} does not match snapshot sequence ${snapshot.schedulerOrdinal}.`,
    );
  }

  const rebuiltMemberIds = Object.keys(rebuilt.members).sort();
  const snapshotMemberIds = Object.keys(snapshot.members).sort();
  if (rebuiltMemberIds.length !== snapshotMemberIds.length
    || rebuiltMemberIds.some((id, index) => id !== snapshotMemberIds[index])) {
    restoreFail(
      "goal_family_membership_mismatch",
      `The restored family membership for '${snapshot.familyId}' does not match the stored snapshot.`,
    );
  }

  for (const goalId of rebuiltMemberIds) {
    const rebuiltMember = rebuilt.members[goalId]!;
    const snapshotMember = snapshot.members[goalId]!;
    if (
      rebuiltMember.workflowId !== snapshotMember.workflowId
      || rebuiltMember.rootGoalId !== snapshotMember.rootGoalId
      || rebuiltMember.depth !== snapshotMember.depth
      || JSON.stringify(rebuiltMember.parent ?? null) !== JSON.stringify(snapshotMember.parent ?? null)
      || JSON.stringify([...rebuiltMember.childGoalIds].sort()) !== JSON.stringify([...snapshotMember.childGoalIds].sort())
    ) {
      restoreFail(
        "goal_family_membership_mismatch",
        `The restored family member '${goalId}' does not match the stored snapshot for family '${snapshot.familyId}'.`,
      );
    }
  }

  return rebuilt;
}
