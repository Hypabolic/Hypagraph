import {
  isKnownFactType,
  validateChildBindingFacts,
  validateChildBudgetAgainstFamilyLimits,
  validateChildReturnFacts,
  validateEvidenceReferences,
} from "./child-goal-binding.js";
import { isFactValueOfType, type FactContract, type FactType, type FactValue } from "./facts.js";
import type {
  Diagnostic,
  EvidenceReference,
  GoalBlockerIdentity,
  GoalBlockerKind,
  GoalBudgetDefinition,
  GoalContinuationAction,
  GoalWorkContinuationActionKind,
} from "./model.js";

/**
 * Schema version for goal-family runtime and persisted family records.
 * This version is independent of HYPAGRAPH_SCHEMA_VERSION on workflow aggregates.
 * Version 2 adds family bounds, child bindings, family budget reservation,
 * and terminal child-return fields on bindings.
 * Before the first external family adoption, unsupported versions are rejected.
 */
export const GOAL_FAMILY_SCHEMA_VERSION = 2 as const;

/** Event payload version for family-level events. */
export const GOAL_FAMILY_EVENT_VERSION = 1 as const;

const GOAL_WORK_ACTION_KINDS = new Set<GoalWorkContinuationActionKind>([
  "continue-active-task",
  "start-ready-task",
  "run-ready-check",
  "run-ready-code",
  "run-ready-effect",
  "reconcile-indeterminate-effect",
  "evaluate-ready-gate",
  "request-ready-interaction",
]);

const GOAL_BLOCKER_KINDS = new Set<GoalBlockerKind>([
  "blocked-node",
  "blocked-loop",
  "loop-dependants",
  "legacy-definition",
  "definition-no-path",
  "external-dependency",
  "terminal-policy",
]);

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

/**
 * Recursive creation bounds for one goal family.
 * All limits are positive safe integers supplied as pure inputs.
 */
export interface FamilyBounds {
  /** Maximum member depth. Root depth is 0. A child at depth maxDepth is allowed. */
  maxDepth: number;
  /** Maximum direct children for one parent goal. */
  maxChildrenPerGoal: number;
  /** Maximum total members in the family, including the root. */
  maxGoalsInFamily: number;
  /** Maximum child-creation operations from one parent node. */
  maxChildCreationAttemptsPerNode: number;
}

/**
 * Default recursive creation bounds.
 * Callers can override these pure inputs at family creation.
 */
export const DEFAULT_FAMILY_BOUNDS: FamilyBounds = {
  maxDepth: 3,
  maxChildrenPerGoal: 8,
  maxGoalsInFamily: 32,
  maxChildCreationAttemptsPerNode: 8,
};

/**
 * Family-level token and turn capacity.
 * Child allocations reserve capacity. They do not create new unaccounted capacity.
 */
export interface FamilyBudgetRuntime {
  limits: GoalBudgetDefinition;
  reservedTurns: number;
  reservedTokens: number;
}

export type ChildGoalFailurePolicy =
  | "fail-parent-node"
  | "block-parent-node"
  | "return-for-revision";

/**
 * Binding status for a child goal.
 * Terminal statuses are set only by a recorded child return.
 */
export type ChildGoalBindingStatus =
  | "active"
  | "returned"
  | "failed"
  | "cancelled"
  | "budget_limited";

/** Child terminal outcome recorded against a parent binding. */
export type ChildReturnOutcomeKind =
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_limited";

/** Deterministic parent effect applied for a child return. */
export type ChildReturnParentEffect =
  | "resumed"
  | "failed"
  | "blocked"
  | "revision-requested";

/** One validated fact published onto the parent runtime on successful child return. */
export interface ChildReturnPublishedFact {
  name: string;
  type: FactType;
  value: FactValue;
  evidence: EvidenceReference[];
}

/**
 * Terminal return record stored on a child-goal binding.
 * Present only when the binding status is terminal.
 */
export interface ChildReturnRecord {
  outcome: ChildReturnOutcomeKind;
  parentEffect: ChildReturnParentEffect;
  returnedAt: string;
  stopReason?: string;
  publishedFacts?: ChildReturnPublishedFact[];
  evidence?: EvidenceReference[];
}

/**
 * One parent fact value captured for a child at creation time.
 * Materialized into the child executor context as selected facts.
 */
export interface CapturedChildInputFact {
  name: string;
  type: FactType;
  value: FactValue;
  producerNodeId: string;
  attemptId: string;
  revision: number;
}

/**
 * Parent-to-child binding recorded on the family aggregate.
 */
export interface ChildGoalBinding {
  bindingId: string;
  childGoalId: string;
  parentGoalId: string;
  parentWorkflowId: string;
  parentNodeId: string;
  parentAttemptId: string;
  inputFacts: string[];
  /**
   * Parent fact values captured when the child is created.
   * Order matches inputFacts. Empty when the binding declares no input facts.
   */
  capturedInputFacts: CapturedChildInputFact[];
  outputFacts: FactContract[];
  budget: GoalBudgetDefinition;
  failurePolicy: ChildGoalFailurePolicy;
  scopePaths: string[];
  status: ChildGoalBindingStatus;
  createdAt: string;
  /** Present when the binding is terminal after a recorded child return. */
  returnRecord?: ChildReturnRecord;
}

/**
 * Identity for one family-scheduled action.
 * The family scheduler records this identity on selection so replay does not recompute the choice.
 * attemptId is deferred until executor attempt identity lands in a later slice.
 */
export interface ScheduledActionIdentity {
  familyId: string;
  goalId: string;
  workflowId: string;
  revision: number;
  nodeId?: string;
  loopId?: string;
}

/**
 * Selected family action with the continuation payload and selection reason.
 * Timestamps and IDs are pure inputs from the selection event.
 */
export interface FamilySelectedAction extends ScheduledActionIdentity {
  action: GoalContinuationAction;
  reason: string;
  selectedSequence: number;
  selectedSnapshotHash: string;
  memberContinuationOrdinal: number;
}

export type FamilyDispatchPendingStatus = "selected" | "dispatched";
export type FamilyDispatchTerminalStatus = "completed" | "failed" | "interrupted";

/**
 * In-flight family-level selection or dispatch.
 * Sequential policy permits at most one pending family dispatch.
 */
export interface FamilyPendingDispatch {
  dispatchId: string;
  selection: FamilySelectedAction;
  status: FamilyDispatchPendingStatus;
  selectedAt: string;
  dispatchedAt?: string;
  /** Family event sequence when this selection was recorded. */
  schedulerOrdinal: number;
}

/**
 * Terminal outcome of one family-level dispatch.
 * dispatchedAt is absent when the action is interrupted while still selected.
 */
export interface FamilyDispatchOutcome {
  dispatchId: string;
  selection: FamilySelectedAction;
  status: FamilyDispatchTerminalStatus;
  selectedAt: string;
  dispatchedAt?: string;
  completedAt: string;
  reason?: string;
  schedulerOrdinal: number;
}

export interface GoalFamilyRuntime {
  schemaVersion: typeof GOAL_FAMILY_SCHEMA_VERSION;
  familyId: string;
  rootGoalId: string;
  members: Record<string, GoalFamilyMember>;
  /**
   * Contiguous family event sequence.
   * Membership events and family scheduler lifecycle events share this ordinal.
   */
  schedulerOrdinal: number;
  createdAt: string;
  updatedAt: string;
  /** Recursive creation bounds for this family. */
  bounds: FamilyBounds;
  /** Child-goal bindings keyed by binding ID. */
  bindings: Record<string, ChildGoalBinding>;
  /**
   * Family budget capacity and reserved child allocations.
   * Descendant usage is charged against these limits.
   */
  familyBudget: FamilyBudgetRuntime;
  /** At most one pending family-level selection or dispatch. */
  pendingDispatch?: FamilyPendingDispatch;
  /**
   * Most recent terminal family dispatch outcome.
   * Dispatch ID uniqueness is bounded: a new selection rejects a dispatchId that
   * equals pendingDispatch.dispatchId (already exclusive) or lastDispatchOutcome.dispatchId.
   * The family does not retain a full historical set of dispatch IDs on the snapshot.
   */
  lastDispatchOutcome?: FamilyDispatchOutcome;
}

export type GoalFamilyEventType =
  | "hypagraph.family.created"
  | "hypagraph.family.member-added"
  | "hypagraph.family.child-created"
  | "hypagraph.family.child-return-recorded"
  | "hypagraph.family.action-selected"
  | "hypagraph.family.action-dispatched"
  | "hypagraph.family.action-completed"
  | "hypagraph.family.action-failed"
  | "hypagraph.family.action-interrupted";

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
      bounds: FamilyBounds;
      familyBudgetLimits: GoalBudgetDefinition;
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
  })
  | (GoalFamilyEventBase & {
    type: "hypagraph.family.child-created";
    data: {
      goalId: string;
      workflowId: string;
      parent: GoalParentBinding;
      depth: number;
      binding: ChildGoalBinding;
    };
  })
  | (GoalFamilyEventBase & {
    type: "hypagraph.family.child-return-recorded";
    data: {
      bindingId: string;
      childGoalId: string;
      parentGoalId: string;
      parentWorkflowId: string;
      parentNodeId: string;
      parentAttemptId: string;
      outcome: ChildReturnOutcomeKind;
      parentEffect: ChildReturnParentEffect;
      returnRecord: ChildReturnRecord;
    };
  })
  | (GoalFamilyEventBase & {
    type: "hypagraph.family.action-selected";
    data: {
      dispatchId: string;
      selection: FamilySelectedAction;
    };
  })
  | (GoalFamilyEventBase & {
    type: "hypagraph.family.action-dispatched";
    data: {
      dispatchId: string;
    };
  })
  | (GoalFamilyEventBase & {
    type: "hypagraph.family.action-completed" | "hypagraph.family.action-failed" | "hypagraph.family.action-interrupted";
    data: {
      dispatchId: string;
      reason?: string;
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

/** Build a failed GoalFamilyResult. Shared by membership and scheduler command helpers. */
export function rejectGoalFamily(code: string, message: string, location?: string): GoalFamilyResult {
  return {
    ok: false,
    diagnostics: [{ code, message, ...(location ? { location } : {}) }],
  };
}

/** Return an error message when the value is empty. Shared by command helpers. */
export function requireGoalFamilyNonEmpty(value: string, name: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return `The ${name} must be a non-empty string.`;
  return undefined;
}

/** Return an error message when the timestamp is not a valid date-time string. */
export function requireGoalFamilyTimestamp(value: string): string | undefined {
  if (!Number.isFinite(Date.parse(value))) return "The timestamp must be a valid date-time string.";
  return undefined;
}

const reject = rejectGoalFamily;
const requireNonEmpty = requireGoalFamilyNonEmpty;
const requireTimestamp = requireGoalFamilyTimestamp;

/**
 * Parse and validate a goal continuation action payload.
 * Rejects unknown kinds, missing nodeId on work actions, and incomplete revision blockers.
 */
export function parseGoalContinuationActionPayload(
  value: unknown,
): { ok: true; action: GoalContinuationAction } | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "The continuation action must be a plain object." };
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !raw.kind.trim()) {
    return { ok: false, message: "The continuation action must include a non-empty kind." };
  }

  if (raw.kind === "request-revision") {
    if (!raw.blocker || typeof raw.blocker !== "object" || Array.isArray(raw.blocker)) {
      return { ok: false, message: "A request-revision action requires a blocker object." };
    }
    const blockerRaw = raw.blocker as Record<string, unknown>;
    if (typeof blockerRaw.kind !== "string" || !GOAL_BLOCKER_KINDS.has(blockerRaw.kind as GoalBlockerKind)) {
      return { ok: false, message: "A request-revision action requires a known blocker kind." };
    }
    if (typeof blockerRaw.id !== "string" || !blockerRaw.id.trim()) {
      return { ok: false, message: "A request-revision action requires a non-empty blocker id." };
    }
    if (typeof blockerRaw.reason !== "string" || !blockerRaw.reason.trim()) {
      return { ok: false, message: "A request-revision action requires a non-empty blocker reason." };
    }
    if (!Number.isSafeInteger(blockerRaw.sourceRevision) || (blockerRaw.sourceRevision as number) < 0) {
      return { ok: false, message: "A request-revision action requires a non-negative safe integer sourceRevision." };
    }
    if (!Number.isSafeInteger(blockerRaw.sourceSequence) || (blockerRaw.sourceSequence as number) < 0) {
      return { ok: false, message: "A request-revision action requires a non-negative safe integer sourceSequence." };
    }
    if (typeof blockerRaw.sourceSnapshotHash !== "string" || !blockerRaw.sourceSnapshotHash.trim()) {
      return { ok: false, message: "A request-revision action requires a non-empty sourceSnapshotHash." };
    }
    const blocker: GoalBlockerIdentity = {
      kind: blockerRaw.kind as GoalBlockerKind,
      id: blockerRaw.id,
      reason: blockerRaw.reason,
      sourceRevision: blockerRaw.sourceRevision as number,
      sourceSequence: blockerRaw.sourceSequence as number,
      sourceSnapshotHash: blockerRaw.sourceSnapshotHash,
    };
    return { ok: true, action: { kind: "request-revision", blocker } };
  }

  if (!GOAL_WORK_ACTION_KINDS.has(raw.kind as GoalWorkContinuationActionKind)) {
    return {
      ok: false,
      message: `Unsupported continuation action kind '${raw.kind}'.`,
    };
  }
  if (typeof raw.nodeId !== "string" || !raw.nodeId.trim()) {
    return {
      ok: false,
      message: `Continuation action kind '${raw.kind}' requires a non-empty nodeId.`,
    };
  }
  const action: GoalContinuationAction = {
    kind: raw.kind as GoalWorkContinuationActionKind,
    nodeId: raw.nodeId,
  };
  if (raw.loopId !== undefined) {
    if (typeof raw.loopId !== "string" || !raw.loopId.trim()) {
      return { ok: false, message: "A continuation action loopId must be a non-empty string when present." };
    }
    action.loopId = raw.loopId;
  }
  return { ok: true, action };
}

/**
 * Serialize a value with sorted object keys so restore equality ignores key order.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      next[key] = canonicalizeJsonValue(record[key]);
    }
    return next;
  }
  return value;
}

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
 * Validate family bounds as pure positive safe integers.
 * Returns diagnostics without throwing.
 */
export function validateFamilyBounds(bounds: FamilyBounds): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const fields: Array<[keyof FamilyBounds, number]> = [
    ["maxDepth", bounds.maxDepth],
    ["maxChildrenPerGoal", bounds.maxChildrenPerGoal],
    ["maxGoalsInFamily", bounds.maxGoalsInFamily],
    ["maxChildCreationAttemptsPerNode", bounds.maxChildCreationAttemptsPerNode],
  ];
  for (const [name, value] of fields) {
    if (!Number.isSafeInteger(value) || value < 1) {
      diagnostics.push({
        code: "invalid_goal_family_bounds",
        message: `Family bound '${name}' must be a positive safe integer.`,
        location: `bounds.${name}`,
      });
    }
  }
  if (
    diagnostics.length === 0
    && Number.isSafeInteger(bounds.maxGoalsInFamily)
    && bounds.maxGoalsInFamily < 1
  ) {
    diagnostics.push({
      code: "invalid_goal_family_bounds",
      message: "Family bound 'maxGoalsInFamily' must allow at least the root member.",
      location: "bounds.maxGoalsInFamily",
    });
  }
  return diagnostics;
}

/**
 * Create a one-member goal family for a root goal and its workflow.
 * Timestamps and identifiers are pure inputs. This function does not read the clock.
 * Optional bounds and family budget limits default to pure constants and empty limits.
 */
export function createRootFamily(input: {
  familyId: string;
  rootGoalId: string;
  rootWorkflowId: string;
  at: string;
  bounds?: FamilyBounds;
  familyBudgetLimits?: GoalBudgetDefinition;
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

  const bounds = input.bounds ? structuredClone(input.bounds) : structuredClone(DEFAULT_FAMILY_BOUNDS);
  const boundsDiagnostics = validateFamilyBounds(bounds);
  if (boundsDiagnostics.length > 0) {
    return { ok: false, diagnostics: boundsDiagnostics };
  }

  const familyBudgetLimits = input.familyBudgetLimits
    ? structuredClone(input.familyBudgetLimits)
    : {};
  if (
    familyBudgetLimits.maximumTurns !== undefined
    && (!Number.isSafeInteger(familyBudgetLimits.maximumTurns) || familyBudgetLimits.maximumTurns < 1)
  ) {
    return reject(
      "invalid_goal_family_budget",
      "The family maximum turn budget must be a positive safe integer when present.",
      "familyBudgetLimits.maximumTurns",
    );
  }
  if (
    familyBudgetLimits.maximumTokens !== undefined
    && (!Number.isSafeInteger(familyBudgetLimits.maximumTokens) || familyBudgetLimits.maximumTokens < 1)
  ) {
    return reject(
      "invalid_goal_family_budget",
      "The family maximum token budget must be a positive safe integer when present.",
      "familyBudgetLimits.maximumTokens",
    );
  }

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
      bounds,
      familyBudgetLimits,
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
 * Membership events and family scheduler lifecycle events share one sequence.
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
    const bounds = requireFamilyBounds(event.data?.bounds, "family-created event");
    const familyBudgetLimits = requireFamilyBudgetLimits(
      event.data?.familyBudgetLimits,
      "family-created event",
    );

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
      bounds,
      bindings: {},
      familyBudget: {
        limits: familyBudgetLimits,
        reservedTurns: 0,
        reservedTokens: 0,
      },
    };
  }

  if (!family) {
    restoreFail(
      "goal_family_projection_missing",
      `A family event of type '${event.type}' requires an existing goal-family projection.`,
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

  if (event.type === "hypagraph.family.member-added") {
    return applyMemberAddedEvent(current, event);
  }

  if (event.type === "hypagraph.family.child-created") {
    return applyChildCreatedEvent(current, event);
  }

  if (event.type === "hypagraph.family.child-return-recorded") {
    return applyChildReturnRecordedEvent(current, event);
  }

  if (event.type === "hypagraph.family.action-selected") {
    return applyActionSelectedEvent(current, event);
  }

  if (event.type === "hypagraph.family.action-dispatched") {
    return applyActionDispatchedEvent(current, event);
  }

  if (
    event.type === "hypagraph.family.action-completed"
    || event.type === "hypagraph.family.action-failed"
    || event.type === "hypagraph.family.action-interrupted"
  ) {
    return applyActionTerminalEvent(current, event);
  }

  restoreFail(
    "unsupported_goal_family_event_type",
    `Unsupported goal-family event type '${String((event as { type?: unknown }).type)}'.`,
  );
}

function requireFamilyBounds(value: unknown, location: string): FamilyBounds {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    restoreFail("invalid_goal_family_bounds", `${location} must include a bounds object.`);
  }
  const raw = value as Record<string, unknown>;
  const fields: Array<keyof FamilyBounds> = [
    "maxDepth",
    "maxChildrenPerGoal",
    "maxGoalsInFamily",
    "maxChildCreationAttemptsPerNode",
  ];
  const bounds = {} as FamilyBounds;
  for (const field of fields) {
    const numberValue = raw[field];
    if (!Number.isSafeInteger(numberValue) || (numberValue as number) < 1) {
      restoreFail(
        "invalid_goal_family_bounds",
        `${location} bound '${field}' must be a positive safe integer.`,
      );
    }
    bounds[field] = numberValue as number;
  }
  return bounds;
}

function requireFamilyBudgetLimits(value: unknown, location: string): GoalBudgetDefinition {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    restoreFail("invalid_goal_family_budget", `${location} familyBudgetLimits must be a plain object.`);
  }
  const raw = value as Record<string, unknown>;
  const limits: GoalBudgetDefinition = {};
  if (raw.maximumTurns !== undefined) {
    if (!Number.isSafeInteger(raw.maximumTurns) || (raw.maximumTurns as number) < 1) {
      restoreFail(
        "invalid_goal_family_budget",
        `${location} maximumTurns must be a positive safe integer when present.`,
      );
    }
    limits.maximumTurns = raw.maximumTurns as number;
  }
  if (raw.maximumTokens !== undefined) {
    if (!Number.isSafeInteger(raw.maximumTokens) || (raw.maximumTokens as number) < 1) {
      restoreFail(
        "invalid_goal_family_budget",
        `${location} maximumTokens must be a positive safe integer when present.`,
      );
    }
    limits.maximumTokens = raw.maximumTokens as number;
  }
  return limits;
}

const CHILD_FAILURE_POLICIES = new Set<ChildGoalFailurePolicy>([
  "fail-parent-node",
  "block-parent-node",
  "return-for-revision",
]);

const CHILD_BINDING_STATUSES = new Set<ChildGoalBindingStatus>([
  "active",
  "returned",
  "failed",
  "cancelled",
  "budget_limited",
]);

const CHILD_RETURN_OUTCOMES = new Set<ChildReturnOutcomeKind>([
  "completed",
  "failed",
  "cancelled",
  "budget_limited",
]);

const CHILD_RETURN_PARENT_EFFECTS = new Set<ChildReturnParentEffect>([
  "resumed",
  "failed",
  "blocked",
  "revision-requested",
]);

/**
 * Map a terminal child outcome to the corresponding binding status.
 */
export function childBindingStatusForOutcome(outcome: ChildReturnOutcomeKind): ChildGoalBindingStatus {
  switch (outcome) {
    case "completed": return "returned";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "budget_limited": return "budget_limited";
  }
}

/**
 * Parent command effect applied by the parent workflow reducer for a child return.
 * The family binding stores the durable form via durableParentEffect.
 */
export type ChildReturnCommandParentEffect =
  | "resume"
  | "fail-parent-node"
  | "block-parent-node"
  | "return-for-revision";

/**
 * Map a failure policy to the parent command effect for a non-success child return.
 */
export function parentEffectForFailurePolicy(
  policy: ChildGoalFailurePolicy,
): Exclude<ChildReturnCommandParentEffect, "resume"> {
  return policy;
}

/**
 * Map a parent command effect to the durable parent effect stored on the family binding.
 */
export function durableParentEffect(
  effect: ChildReturnCommandParentEffect,
): ChildReturnParentEffect {
  switch (effect) {
    case "resume": return "resumed";
    case "fail-parent-node": return "failed";
    case "block-parent-node": return "blocked";
    case "return-for-revision": return "revision-requested";
  }
}

/**
 * Map a durable parent effect back to the parent workflow command effect.
 */
export function commandParentEffectFromDurable(
  effect: ChildReturnParentEffect,
): ChildReturnCommandParentEffect {
  switch (effect) {
    case "resumed": return "resume";
    case "failed": return "fail-parent-node";
    case "blocked": return "block-parent-node";
    case "revision-requested": return "return-for-revision";
  }
}

/**
 * Deterministic durable parent effect for a non-success outcome under a failure policy.
 */
export function durableParentEffectForFailurePolicy(
  policy: ChildGoalFailurePolicy,
): ChildReturnParentEffect {
  return durableParentEffect(parentEffectForFailurePolicy(policy));
}

/**
 * Parse and validate a child return record payload.
 * Shared by event application and snapshot validation.
 */
export function requireChildReturnRecord(value: unknown, location: string): ChildReturnRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    restoreFail("invalid_child_return_record", `${location} must include a return record object.`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.outcome !== "string" || !CHILD_RETURN_OUTCOMES.has(raw.outcome as ChildReturnOutcomeKind)) {
    restoreFail(
      "invalid_child_return_record",
      `${location} requires a known child return outcome.`,
    );
  }
  if (
    typeof raw.parentEffect !== "string"
    || !CHILD_RETURN_PARENT_EFFECTS.has(raw.parentEffect as ChildReturnParentEffect)
  ) {
    restoreFail(
      "invalid_child_return_record",
      `${location} requires a known parent effect.`,
    );
  }
  const returnedAt = requireIdentity(raw.returnedAt, "return returnedAt");
  if (!Number.isFinite(Date.parse(returnedAt))) {
    restoreFail(
      "invalid_child_return_record",
      `${location} returnedAt must be a valid date-time string.`,
    );
  }
  if (raw.stopReason !== undefined && (typeof raw.stopReason !== "string" || !raw.stopReason.trim())) {
    restoreFail(
      "invalid_child_return_record",
      `${location} stopReason must be a non-empty string when present.`,
    );
  }

  const outcome = raw.outcome as ChildReturnOutcomeKind;
  const parentEffect = raw.parentEffect as ChildReturnParentEffect;
  if (outcome === "completed" && parentEffect !== "resumed") {
    restoreFail(
      "invalid_child_return_record",
      `${location} completed outcome requires parent effect 'resumed'.`,
    );
  }
  if (outcome !== "completed" && parentEffect === "resumed") {
    restoreFail(
      "invalid_child_return_record",
      `${location} non-completed outcome cannot use parent effect 'resumed'.`,
    );
  }

  const evidence = raw.evidence === undefined
    ? undefined
    : requireEvidenceReferenceList(raw.evidence, `${location} evidence`);
  const publishedFacts = raw.publishedFacts === undefined
    ? undefined
    : requireChildReturnPublishedFacts(raw.publishedFacts, `${location} publishedFacts`);

  if (outcome === "completed" && (publishedFacts === undefined || publishedFacts.length === 0) && evidence === undefined) {
    // Completed return may publish zero optional facts when no required output contracts exist.
  }

  return {
    outcome,
    parentEffect,
    returnedAt,
    ...(raw.stopReason === undefined ? {} : { stopReason: raw.stopReason as string }),
    ...(publishedFacts === undefined ? {} : { publishedFacts }),
    ...(evidence === undefined ? {} : { evidence }),
  };
}

function requireEvidenceReferenceList(value: unknown, location: string): EvidenceReference[] {
  const validated = validateEvidenceReferences(value, location);
  if (!validated.ok) {
    const first = validated.diagnostics[0]!;
    restoreFail(first.code, `${location}: ${first.message}`);
  }
  return validated.evidence;
}

function requireChildReturnPublishedFacts(value: unknown, location: string): ChildReturnPublishedFact[] {
  if (!Array.isArray(value)) {
    restoreFail("invalid_child_return_facts", `${location} must be an array.`);
  }
  const seen = new Set<string>();
  const result: ChildReturnPublishedFact[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      restoreFail(
        "invalid_child_return_facts",
        `${location}[${index}] must be a plain object.`,
      );
    }
    const raw = item as Record<string, unknown>;
    if (typeof raw.name !== "string" || !raw.name.trim()) {
      restoreFail(
        "invalid_child_return_facts",
        `${location}[${index}] requires a non-empty name.`,
      );
    }
    if (seen.has(raw.name)) {
      restoreFail(
        "duplicate_child_return_fact",
        `${location} declares fact '${raw.name}' more than once.`,
      );
    }
    seen.add(raw.name);
    if (!isKnownFactType(raw.type)) {
      restoreFail(
        "invalid_child_return_facts",
        `${location}[${index}] requires a known fact type.`,
      );
    }
    const factType = raw.type;
    if (!isFactValueOfType(factType, raw.value as FactValue)) {
      restoreFail(
        "fact_value_invalid",
        `${location}[${index}]: Child return fact '${raw.name}' has an invalid value for type '${factType}'.`,
      );
    }
    const evidence = raw.evidence === undefined
      ? []
      : requireEvidenceReferenceList(raw.evidence, `${location}[${index}].evidence`);
    result.push({
      name: raw.name,
      type: factType,
      value: structuredClone(raw.value) as FactValue,
      evidence,
    });
  }
  return result;
}

function requireChildGoalBinding(value: unknown, location: string): ChildGoalBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    restoreFail("invalid_goal_family_binding", `${location} must include a binding object.`);
  }
  const raw = value as Record<string, unknown>;
  const bindingId = requireIdentity(raw.bindingId, "binding ID");
  const childGoalId = requireIdentity(raw.childGoalId, "child goal ID");
  const parentGoalId = requireIdentity(raw.parentGoalId, "parent goal ID");
  const parentWorkflowId = requireIdentity(raw.parentWorkflowId, "parent workflow ID");
  const parentNodeId = requireIdentity(raw.parentNodeId, "parent node ID");
  const parentAttemptId = requireIdentity(raw.parentAttemptId, "parent attempt ID");
  if (typeof raw.status !== "string" || !CHILD_BINDING_STATUSES.has(raw.status as ChildGoalBindingStatus)) {
    restoreFail(
      "invalid_goal_family_binding",
      `${location} binding status must be a known child-goal binding status.`,
    );
  }
  const status = raw.status as ChildGoalBindingStatus;
  if (typeof raw.failurePolicy !== "string" || !CHILD_FAILURE_POLICIES.has(raw.failurePolicy as ChildGoalFailurePolicy)) {
    restoreFail(
      "invalid_goal_family_binding",
      `${location} binding requires a known failure policy.`,
    );
  }
  const factsValidated = validateChildBindingFacts(raw.inputFacts, raw.outputFacts);
  if (!factsValidated.ok) {
    const first = factsValidated.diagnostics[0]!;
    restoreFail(first.code, `${location}: ${first.message}`);
  }
  const capturedInputFacts = requireCapturedChildInputFacts(
    raw.capturedInputFacts,
    factsValidated.inputFacts,
    `${location} capturedInputFacts`,
  );
  if (!Array.isArray(raw.scopePaths) || raw.scopePaths.some((item) => typeof item !== "string" || !item.trim())) {
    restoreFail(
      "invalid_goal_family_binding",
      `${location} binding scopePaths must be an array of non-empty strings.`,
    );
  }
  if (!raw.budget || typeof raw.budget !== "object" || Array.isArray(raw.budget)) {
    restoreFail(
      "invalid_goal_family_binding",
      `${location} binding budget must be a plain object.`,
    );
  }
  const budget = requireFamilyBudgetLimits(raw.budget, `${location} binding budget`);
  const createdAt = requireIdentity(raw.createdAt, "binding createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) {
    restoreFail(
      "invalid_goal_family_binding",
      `${location} binding createdAt must be a valid date-time string.`,
    );
  }

  let returnRecord: ChildReturnRecord | undefined;
  if (status === "active") {
    if (raw.returnRecord !== undefined) {
      restoreFail(
        "invalid_goal_family_binding",
        `${location} active binding must not include a return record.`,
      );
    }
  } else {
    if (raw.returnRecord === undefined) {
      restoreFail(
        "invalid_goal_family_binding",
        `${location} terminal binding requires a return record.`,
      );
    }
    returnRecord = requireChildReturnRecord(raw.returnRecord, `${location} returnRecord`);
    if (childBindingStatusForOutcome(returnRecord.outcome) !== status) {
      restoreFail(
        "invalid_goal_family_binding",
        `${location} binding status '${status}' does not match return outcome `
        + `'${returnRecord.outcome}'.`,
      );
    }
    const failurePolicy = raw.failurePolicy as ChildGoalFailurePolicy;
    if (returnRecord.outcome !== "completed") {
      const expectedEffect = durableParentEffectForFailurePolicy(failurePolicy);
      if (returnRecord.parentEffect !== expectedEffect) {
        restoreFail(
          "child_return_parent_effect_policy_mismatch",
          `${location}: return parent effect '${returnRecord.parentEffect}' does not match `
          + `failure policy '${failurePolicy}' (expected '${expectedEffect}').`,
        );
      }
    }
    const contractCheck = validateChildReturnFacts(
      factsValidated.outputFacts,
      returnRecord.publishedFacts,
      { requireRequired: returnRecord.outcome === "completed" },
    );
    if (!contractCheck.ok) {
      const first = contractCheck.diagnostics[0]!;
      restoreFail(first.code, `${location}: ${first.message}`);
    }
  }

  return {
    bindingId,
    childGoalId,
    parentGoalId,
    parentWorkflowId,
    parentNodeId,
    parentAttemptId,
    inputFacts: factsValidated.inputFacts,
    capturedInputFacts,
    outputFacts: factsValidated.outputFacts,
    budget,
    failurePolicy: raw.failurePolicy as ChildGoalFailurePolicy,
    scopePaths: structuredClone(raw.scopePaths as string[]),
    status,
    createdAt,
    ...(returnRecord === undefined ? {} : { returnRecord: structuredClone(returnRecord) }),
  };
}

/**
 * Validate captured parent input facts on a binding.
 * Names must match inputFacts in order. Empty array when inputFacts is empty.
 * Before first external adoption, missing capturedInputFacts is treated as empty
 * only when inputFacts is also empty.
 */
function requireCapturedChildInputFacts(
  value: unknown,
  inputFacts: readonly string[],
  location: string,
): CapturedChildInputFact[] {
  if (value === undefined || value === null) {
    if (inputFacts.length === 0) return [];
    restoreFail(
      "invalid_goal_family_binding",
      `${location} must capture parent values for declared inputFacts.`,
    );
  }
  if (!Array.isArray(value)) {
    restoreFail(
      "invalid_goal_family_binding",
      `${location} must be an array.`,
    );
  }
  if (value.length !== inputFacts.length) {
    restoreFail(
      "invalid_goal_family_binding",
      `${location} length (${value.length}) must match inputFacts length (${inputFacts.length}).`,
    );
  }
  const captured: CapturedChildInputFact[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      restoreFail(
        "invalid_goal_family_binding",
        `${location}[${index}] must be a plain object.`,
      );
    }
    const raw = item as Record<string, unknown>;
    const name = requireIdentity(raw.name, `${location}[${index}] name`);
    if (name !== inputFacts[index]) {
      restoreFail(
        "invalid_goal_family_binding",
        `${location}[${index}].name '${name}' does not match inputFacts[${index}] `
        + `'${inputFacts[index]}'.`,
      );
    }
    if (typeof raw.type !== "string" || !isKnownFactType(raw.type)) {
      restoreFail(
        "invalid_goal_family_binding",
        `${location}[${index}] requires a known fact type.`,
      );
    }
    const factType = raw.type as FactType;
    if (!isFactValueOfType(factType, raw.value as FactValue)) {
      restoreFail(
        "invalid_goal_family_binding",
        `${location}[${index}] has an invalid value for type '${factType}'.`,
      );
    }
    const producerNodeId = requireIdentity(raw.producerNodeId, `${location}[${index}] producerNodeId`);
    const attemptId = requireIdentity(raw.attemptId, `${location}[${index}] attemptId`);
    if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) {
      restoreFail(
        "invalid_goal_family_binding",
        `${location}[${index}] requires a non-negative safe integer revision.`,
      );
    }
    captured.push({
      name,
      type: factType,
      value: structuredClone(raw.value) as FactValue,
      producerNodeId,
      attemptId,
      revision: raw.revision as number,
    });
  }
  return captured;
}

function applyMemberAddedEvent(
  current: GoalFamilyRuntime,
  event: Extract<GoalFamilyEvent, { type: "hypagraph.family.member-added" }>,
): GoalFamilyRuntime {
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
 * Apply a family child-created event.
 * Enforces creation bounds before membership is added.
 * Records membership, the parent-child binding, and reserved family budget capacity.
 */
function applyChildCreatedEvent(
  current: GoalFamilyRuntime,
  event: Extract<GoalFamilyEvent, { type: "hypagraph.family.child-created" }>,
): GoalFamilyRuntime {
  const parentGoalId = requireIdentity(event.data.parent?.parentGoalId, "parent goal ID");
  const parentMember = current.members[parentGoalId];
  if (!parentMember) {
    restoreFail(
      "goal_family_parent_missing",
      `Goal family '${current.familyId}' does not contain parent goal '${parentGoalId}'.`,
    );
  }

  if (!Number.isSafeInteger(event.data.depth) || event.data.depth < 1) {
    restoreFail(
      "invalid_goal_family_member_depth",
      `Child member depth must be a positive safe integer.`,
    );
  }
  if (event.data.depth > current.bounds.maxDepth) {
    restoreFail(
      "goal_family_depth_exceeded",
      `Child goal depth ${event.data.depth} exceeds family maxDepth ${current.bounds.maxDepth}.`,
    );
  }
  const memberCount = Object.keys(current.members).length;
  if (memberCount + 1 > current.bounds.maxGoalsInFamily) {
    restoreFail(
      "goal_family_member_count_exceeded",
      `Goal family '${current.familyId}' already has ${memberCount} members. `
      + `maxGoalsInFamily is ${current.bounds.maxGoalsInFamily}.`,
    );
  }
  if (parentMember.childGoalIds.length + 1 > current.bounds.maxChildrenPerGoal) {
    restoreFail(
      "goal_family_children_per_goal_exceeded",
      `Parent goal '${parentGoalId}' already has ${parentMember.childGoalIds.length} children. `
      + `maxChildrenPerGoal is ${current.bounds.maxChildrenPerGoal}.`,
    );
  }

  // Reuse member-added rules for membership integrity, then attach binding and budget.
  const withMember = applyMemberAddedEvent(current, {
    ...event,
    type: "hypagraph.family.member-added",
    data: {
      goalId: event.data.goalId,
      workflowId: event.data.workflowId,
      parent: event.data.parent,
      depth: event.data.depth,
    },
  });

  const binding = requireChildGoalBinding(event.data.binding, "Family child-created event");
  if (binding.childGoalId !== event.data.goalId) {
    restoreFail(
      "goal_family_binding_child_mismatch",
      `Child-created event goal '${event.data.goalId}' does not match binding child '${binding.childGoalId}'.`,
    );
  }
  if (
    binding.parentGoalId !== event.data.parent.parentGoalId
    || binding.parentWorkflowId !== event.data.parent.parentWorkflowId
    || binding.parentNodeId !== event.data.parent.parentNodeId
  ) {
    restoreFail(
      "goal_family_binding_parent_mismatch",
      `Child-created event parent does not match binding parent for child '${binding.childGoalId}'.`,
    );
  }
  if (withMember.bindings[binding.bindingId]) {
    restoreFail(
      "goal_family_binding_exists",
      `Goal family '${withMember.familyId}' already contains binding '${binding.bindingId}'.`,
    );
  }
  for (const existing of Object.values(withMember.bindings)) {
    if (existing.childGoalId === binding.childGoalId) {
      restoreFail(
        "goal_family_binding_child_in_use",
        `Goal family '${withMember.familyId}' already binds child goal '${binding.childGoalId}'.`,
      );
    }
  }
  const attemptsFromNode = Object.values(withMember.bindings).filter(
    (existing) =>
      existing.parentGoalId === binding.parentGoalId
      && existing.parentNodeId === binding.parentNodeId,
  ).length;
  if (attemptsFromNode + 1 > withMember.bounds.maxChildCreationAttemptsPerNode) {
    restoreFail(
      "goal_family_child_creation_attempts_exceeded",
      `Parent node '${binding.parentNodeId}' on goal '${binding.parentGoalId}' already created `
      + `${attemptsFromNode} child goals. maxChildCreationAttemptsPerNode is `
      + `${withMember.bounds.maxChildCreationAttemptsPerNode}.`,
    );
  }

  const allocationDiagnostics = validateChildBudgetAgainstFamilyLimits(
    withMember.familyBudget.limits,
    binding.budget,
  );
  if (allocationDiagnostics.length > 0) {
    const first = allocationDiagnostics[0]!;
    restoreFail(first.code, first.message);
  }

  const reservedTurns = binding.budget.maximumTurns ?? 0;
  const reservedTokens = binding.budget.maximumTokens ?? 0;
  const nextReservedTurns = withMember.familyBudget.reservedTurns + reservedTurns;
  const nextReservedTokens = withMember.familyBudget.reservedTokens + reservedTokens;
  if (!Number.isSafeInteger(nextReservedTurns) || !Number.isSafeInteger(nextReservedTokens)) {
    restoreFail(
      "invalid_goal_family_budget",
      `Family '${withMember.familyId}' reserved budget exceeds the safe integer range.`,
    );
  }
  if (
    withMember.familyBudget.limits.maximumTurns !== undefined
    && nextReservedTurns > withMember.familyBudget.limits.maximumTurns
  ) {
    restoreFail(
      "goal_family_budget_exceeded",
      `Family '${withMember.familyId}' cannot reserve ${reservedTurns} turns for child '${binding.childGoalId}'.`,
    );
  }
  if (
    withMember.familyBudget.limits.maximumTokens !== undefined
    && nextReservedTokens > withMember.familyBudget.limits.maximumTokens
  ) {
    restoreFail(
      "goal_family_budget_exceeded",
      `Family '${withMember.familyId}' cannot reserve ${reservedTokens} tokens for child '${binding.childGoalId}'.`,
    );
  }

  const next: GoalFamilyRuntime = structuredClone(withMember);
  // Child-created events store the creation-time binding. Status must be active.
  if (binding.status !== "active" || binding.returnRecord !== undefined) {
    restoreFail(
      "invalid_goal_family_binding",
      `Child-created event binding '${binding.bindingId}' must be active without a return record.`,
    );
  }
  next.bindings[binding.bindingId] = structuredClone(binding);
  next.familyBudget.reservedTurns = nextReservedTurns;
  next.familyBudget.reservedTokens = nextReservedTokens;
  return next;
}

/**
 * Apply a family child-return-recorded event.
 * Marks the binding terminal and stores the validated return record.
 * Rejects a return against a missing, terminal, or identity-mismatched binding.
 */
function applyChildReturnRecordedEvent(
  current: GoalFamilyRuntime,
  event: Extract<GoalFamilyEvent, { type: "hypagraph.family.child-return-recorded" }>,
): GoalFamilyRuntime {
  const bindingId = requireIdentity(event.data.bindingId, "binding ID");
  const childGoalId = requireIdentity(event.data.childGoalId, "child goal ID");
  const parentGoalId = requireIdentity(event.data.parentGoalId, "parent goal ID");
  const parentWorkflowId = requireIdentity(event.data.parentWorkflowId, "parent workflow ID");
  const parentNodeId = requireIdentity(event.data.parentNodeId, "parent node ID");
  const parentAttemptId = requireIdentity(event.data.parentAttemptId, "parent attempt ID");

  const existing = current.bindings[bindingId];
  if (!existing) {
    restoreFail(
      "goal_family_binding_missing",
      `Goal family '${current.familyId}' has no binding '${bindingId}' for child return.`,
    );
  }
  if (existing.status !== "active") {
    restoreFail(
      "stale_child_return",
      `Binding '${bindingId}' is already '${existing.status}'. A terminal binding cannot accept another return.`,
    );
  }
  if (
    existing.childGoalId !== childGoalId
    || existing.parentGoalId !== parentGoalId
    || existing.parentWorkflowId !== parentWorkflowId
    || existing.parentNodeId !== parentNodeId
    || existing.parentAttemptId !== parentAttemptId
  ) {
    restoreFail(
      "stale_child_return",
      `Child return identity does not match active binding '${bindingId}'.`,
    );
  }

  const returnRecord = requireChildReturnRecord(event.data.returnRecord, "Family child-return-recorded event");
  if (event.data.outcome !== returnRecord.outcome) {
    restoreFail(
      "invalid_child_return_record",
      `Child return event outcome '${event.data.outcome}' does not match return record outcome `
      + `'${returnRecord.outcome}'.`,
    );
  }
  if (event.data.parentEffect !== returnRecord.parentEffect) {
    restoreFail(
      "invalid_child_return_record",
      `Child return event parent effect '${event.data.parentEffect}' does not match return record `
      + `parent effect '${returnRecord.parentEffect}'.`,
    );
  }
  if (returnRecord.returnedAt !== event.timestamp) {
    restoreFail(
      "invalid_child_return_record",
      `Child return record returnedAt must equal the family event timestamp.`,
    );
  }

  // Non-success parent effects must match the binding failure policy.
  if (returnRecord.outcome !== "completed") {
    const expectedEffect = durableParentEffectForFailurePolicy(existing.failurePolicy);
    if (returnRecord.parentEffect !== expectedEffect) {
      restoreFail(
        "child_return_parent_effect_policy_mismatch",
        `Child return parent effect '${returnRecord.parentEffect}' does not match failure policy `
        + `'${existing.failurePolicy}' (expected '${expectedEffect}').`,
      );
    }
  } else if (returnRecord.parentEffect !== "resumed") {
    restoreFail(
      "invalid_child_return_record",
      `Completed child return requires parent effect 'resumed'.`,
    );
  }

  // Output contracts must hold on apply/restore, not only on the command path.
  const contractCheck = validateChildReturnFacts(
    existing.outputFacts,
    returnRecord.publishedFacts,
    { requireRequired: returnRecord.outcome === "completed" },
  );
  if (!contractCheck.ok) {
    const first = contractCheck.diagnostics[0]!;
    restoreFail(first.code, first.message);
  }

  const nextStatus = childBindingStatusForOutcome(returnRecord.outcome);
  const next: GoalFamilyRuntime = structuredClone(current);
  next.schedulerOrdinal = event.sequence;
  next.updatedAt = event.timestamp;
  next.bindings[bindingId] = {
    ...structuredClone(existing),
    status: nextStatus,
    returnRecord: structuredClone(returnRecord),
  };
  return next;
}

function requireSelectedAction(value: FamilySelectedAction | undefined, location: string): FamilySelectedAction {
  if (!value || typeof value !== "object") {
    restoreFail("invalid_goal_family_selection", `${location} must include a selection object.`);
  }
  const familyId = requireIdentity(value.familyId, "selection family ID");
  const goalId = requireIdentity(value.goalId, "selection goal ID");
  const workflowId = requireIdentity(value.workflowId, "selection workflow ID");
  const reason = requireIdentity(value.reason, "selection reason");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    restoreFail("invalid_goal_family_selection", `${location} revision must be a non-negative safe integer.`);
  }
  if (!Number.isSafeInteger(value.selectedSequence) || value.selectedSequence < 0) {
    restoreFail("invalid_goal_family_selection", `${location} selectedSequence must be a non-negative safe integer.`);
  }
  if (!Number.isSafeInteger(value.memberContinuationOrdinal) || value.memberContinuationOrdinal < 0) {
    restoreFail(
      "invalid_goal_family_selection",
      `${location} memberContinuationOrdinal must be a non-negative safe integer.`,
    );
  }
  requireIdentity(value.selectedSnapshotHash, "selection snapshot hash");
  const parsedAction = parseGoalContinuationActionPayload(value.action);
  if (!parsedAction.ok) {
    restoreFail(
      "invalid_goal_family_continuation_action",
      `${location}: ${parsedAction.message}`,
    );
  }

  const selection: FamilySelectedAction = {
    familyId,
    goalId,
    workflowId,
    revision: value.revision,
    action: parsedAction.action,
    reason,
    selectedSequence: value.selectedSequence,
    selectedSnapshotHash: value.selectedSnapshotHash,
    memberContinuationOrdinal: value.memberContinuationOrdinal,
  };

  // Derive identity node fields from the action. Reject stored identity that disagrees.
  if (parsedAction.action.kind === "request-revision") {
    if (value.nodeId !== undefined) {
      restoreFail(
        "invalid_goal_family_selection",
        `${location} request-revision selection must not declare nodeId.`,
      );
    }
    if (value.loopId !== undefined) {
      restoreFail(
        "invalid_goal_family_selection",
        `${location} request-revision selection must not declare loopId.`,
      );
    }
  } else {
    selection.nodeId = parsedAction.action.nodeId;
    if (parsedAction.action.loopId !== undefined) {
      selection.loopId = parsedAction.action.loopId;
    }
    if (value.nodeId !== undefined) {
      if (typeof value.nodeId !== "string" || !value.nodeId.trim()) {
        restoreFail(
          "invalid_goal_family_selection",
          `${location} nodeId must be a non-empty string when present.`,
        );
      }
      if (value.nodeId !== parsedAction.action.nodeId) {
        restoreFail(
          "invalid_goal_family_selection",
          `${location} nodeId '${value.nodeId}' does not match action nodeId '${parsedAction.action.nodeId}'.`,
        );
      }
    }
    if (value.loopId !== undefined) {
      if (typeof value.loopId !== "string" || !value.loopId.trim()) {
        restoreFail(
          "invalid_goal_family_selection",
          `${location} loopId must be a non-empty string when present.`,
        );
      }
      if ((parsedAction.action.loopId ?? undefined) !== value.loopId) {
        restoreFail(
          "invalid_goal_family_selection",
          `${location} loopId does not match the continuation action loopId.`,
        );
      }
    }
  }
  return selection;
}

function applyActionSelectedEvent(
  current: GoalFamilyRuntime,
  event: Extract<GoalFamilyEvent, { type: "hypagraph.family.action-selected" }>,
): GoalFamilyRuntime {
  if (current.pendingDispatch) {
    restoreFail(
      "goal_family_dispatch_pending",
      `Goal family '${current.familyId}' still has pending dispatch '${current.pendingDispatch.dispatchId}'.`,
    );
  }

  const dispatchId = requireIdentity(event.data.dispatchId, "dispatch ID");
  // Bounded reuse policy: reject only the most recent terminal dispatch ID.
  // Pending is already exclusive. Full historical dispatch ID lists are not retained.
  if (current.lastDispatchOutcome?.dispatchId === dispatchId) {
    restoreFail(
      "goal_family_dispatch_id_reused",
      `Goal family '${current.familyId}' already used dispatch ID '${dispatchId}' `
      + "as the last terminal dispatch outcome.",
    );
  }

  const selection = requireSelectedAction(event.data.selection, "Family action-selected event");
  if (selection.familyId !== current.familyId) {
    restoreFail(
      "goal_family_id_mismatch",
      `Selection family '${selection.familyId}' does not match projection family '${current.familyId}'.`,
    );
  }
  if (!current.members[selection.goalId]) {
    restoreFail(
      "goal_family_member_missing",
      `Goal family '${current.familyId}' does not contain selected member '${selection.goalId}'.`,
    );
  }
  const member = current.members[selection.goalId]!;
  if (member.workflowId !== selection.workflowId) {
    restoreFail(
      "goal_family_selection_workflow_mismatch",
      `Selected member '${selection.goalId}' belongs to workflow '${member.workflowId}', `
      + `not '${selection.workflowId}'.`,
    );
  }

  const next: GoalFamilyRuntime = structuredClone(current);
  next.schedulerOrdinal = event.sequence;
  next.updatedAt = event.timestamp;
  next.pendingDispatch = {
    dispatchId,
    selection: structuredClone(selection),
    status: "selected",
    selectedAt: event.timestamp,
    schedulerOrdinal: event.sequence,
  };
  return next;
}

function applyActionDispatchedEvent(
  current: GoalFamilyRuntime,
  event: Extract<GoalFamilyEvent, { type: "hypagraph.family.action-dispatched" }>,
): GoalFamilyRuntime {
  const pending = current.pendingDispatch;
  if (!pending) {
    restoreFail(
      "goal_family_dispatch_missing",
      `Goal family '${current.familyId}' has no pending dispatch for action-dispatched.`,
    );
  }
  const dispatchId = requireIdentity(event.data.dispatchId, "dispatch ID");
  if (dispatchId !== pending.dispatchId) {
    restoreFail(
      "goal_family_dispatch_id_mismatch",
      `Family dispatch event targets '${dispatchId}', but pending dispatch is '${pending.dispatchId}'.`,
    );
  }
  if (pending.status !== "selected") {
    restoreFail(
      "goal_family_dispatch_already_dispatched",
      `Family dispatch '${dispatchId}' was already dispatched.`,
    );
  }
  if (Date.parse(event.timestamp) < Date.parse(pending.selectedAt)) {
    restoreFail(
      "goal_family_dispatch_timestamp_order",
      `Family dispatch '${dispatchId}' cannot be dispatched before it was selected.`,
    );
  }

  const next: GoalFamilyRuntime = structuredClone(current);
  next.schedulerOrdinal = event.sequence;
  next.updatedAt = event.timestamp;
  next.pendingDispatch = {
    ...structuredClone(pending),
    status: "dispatched",
    dispatchedAt: event.timestamp,
  };
  return next;
}

function applyActionTerminalEvent(
  current: GoalFamilyRuntime,
  event: Extract<
    GoalFamilyEvent,
    {
      type:
        | "hypagraph.family.action-completed"
        | "hypagraph.family.action-failed"
        | "hypagraph.family.action-interrupted";
    }
  >,
): GoalFamilyRuntime {
  const pending = current.pendingDispatch;
  if (!pending) {
    restoreFail(
      "goal_family_dispatch_missing",
      `Goal family '${current.familyId}' has no pending dispatch for '${event.type}'.`,
    );
  }
  const dispatchId = requireIdentity(event.data.dispatchId, "dispatch ID");
  if (dispatchId !== pending.dispatchId) {
    restoreFail(
      "goal_family_dispatch_id_mismatch",
      `Family dispatch event targets '${dispatchId}', but pending dispatch is '${pending.dispatchId}'.`,
    );
  }

  const isInterrupt = event.type === "hypagraph.family.action-interrupted";
  if (isInterrupt) {
    if (pending.status !== "selected" && pending.status !== "dispatched") {
      restoreFail(
        "goal_family_dispatch_invalid_status",
        `Family dispatch '${dispatchId}' has an invalid pending status for interrupt.`,
      );
    }
    if (pending.status === "dispatched") {
      if (!pending.dispatchedAt) {
        restoreFail(
          "goal_family_dispatch_not_dispatched",
          `Family dispatch '${dispatchId}' is marked dispatched without a dispatch timestamp.`,
        );
      }
      if (Date.parse(event.timestamp) < Date.parse(pending.dispatchedAt)) {
        restoreFail(
          "goal_family_dispatch_timestamp_order",
          `Family dispatch '${dispatchId}' cannot complete before it was dispatched.`,
        );
      }
    } else if (Date.parse(event.timestamp) < Date.parse(pending.selectedAt)) {
      restoreFail(
        "goal_family_dispatch_timestamp_order",
        `Family dispatch '${dispatchId}' cannot be interrupted before it was selected.`,
      );
    }
  } else {
    if (pending.status !== "dispatched" || !pending.dispatchedAt) {
      restoreFail(
        "goal_family_dispatch_not_dispatched",
        `Family dispatch '${dispatchId}' did not reach the dispatched state.`,
      );
    }
    if (Date.parse(event.timestamp) < Date.parse(pending.dispatchedAt)) {
      restoreFail(
        "goal_family_dispatch_timestamp_order",
        `Family dispatch '${dispatchId}' cannot complete before it was dispatched.`,
      );
    }
  }

  const status: FamilyDispatchTerminalStatus =
    event.type === "hypagraph.family.action-completed"
      ? "completed"
      : event.type === "hypagraph.family.action-failed"
        ? "failed"
        : "interrupted";

  const next: GoalFamilyRuntime = structuredClone(current);
  next.schedulerOrdinal = event.sequence;
  next.updatedAt = event.timestamp;
  next.lastDispatchOutcome = {
    dispatchId,
    selection: structuredClone(pending.selection),
    status,
    selectedAt: pending.selectedAt,
    completedAt: event.timestamp,
    schedulerOrdinal: pending.schedulerOrdinal,
    ...(pending.dispatchedAt === undefined ? {} : { dispatchedAt: pending.dispatchedAt }),
    ...(event.data.reason === undefined ? {} : { reason: event.data.reason }),
  };
  delete next.pendingDispatch;
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

  const bounds = requireFamilyBounds(family.bounds, `Goal family '${family.familyId}'`);
  if (!family.bindings || typeof family.bindings !== "object" || Array.isArray(family.bindings)) {
    restoreFail(
      "invalid_goal_family_bindings",
      `Goal-family snapshot '${family.familyId}' must include a bindings object.`,
    );
  }
  if (!family.familyBudget || typeof family.familyBudget !== "object" || Array.isArray(family.familyBudget)) {
    restoreFail(
      "invalid_goal_family_budget",
      `Goal-family snapshot '${family.familyId}' must include a familyBudget object.`,
    );
  }
  requireFamilyBudgetLimits(family.familyBudget.limits, `Goal family '${family.familyId}' familyBudget`);
  if (!Number.isSafeInteger(family.familyBudget.reservedTurns) || family.familyBudget.reservedTurns < 0) {
    restoreFail(
      "invalid_goal_family_budget",
      `Goal family '${family.familyId}' reservedTurns must be a non-negative safe integer.`,
    );
  }
  if (!Number.isSafeInteger(family.familyBudget.reservedTokens) || family.familyBudget.reservedTokens < 0) {
    restoreFail(
      "invalid_goal_family_budget",
      `Goal family '${family.familyId}' reservedTokens must be a non-negative safe integer.`,
    );
  }

  const memberCount = Object.keys(family.members).length;
  if (memberCount > bounds.maxGoalsInFamily) {
    restoreFail(
      "goal_family_member_count_exceeded",
      `Goal family '${family.familyId}' has ${memberCount} members, which exceeds maxGoalsInFamily ${bounds.maxGoalsInFamily}.`,
    );
  }

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

    if (member.childGoalIds.length > bounds.maxChildrenPerGoal) {
      restoreFail(
        "goal_family_children_per_goal_exceeded",
        `Member '${member.goalId}' has ${member.childGoalIds.length} children, `
        + `which exceeds maxChildrenPerGoal ${bounds.maxChildrenPerGoal}.`,
      );
    }
    if (member.depth > bounds.maxDepth) {
      restoreFail(
        "goal_family_depth_exceeded",
        `Member '${member.goalId}' depth ${member.depth} exceeds maxDepth ${bounds.maxDepth}.`,
      );
    }
  }

  let expectedReservedTurns = 0;
  let expectedReservedTokens = 0;
  const boundChildGoals = new Set<string>();
  const attemptsByParentNode = new Map<string, number>();
  for (const [bindingKey, binding] of Object.entries(family.bindings)) {
    const validated = requireChildGoalBinding(binding, `Binding '${bindingKey}'`);
    if (validated.bindingId !== bindingKey) {
      restoreFail(
        "goal_family_binding_key_mismatch",
        `Goal-family '${family.familyId}' binding key '${bindingKey}' does not match binding ID '${validated.bindingId}'.`,
      );
    }
    if (!family.members[validated.childGoalId]) {
      restoreFail(
        "goal_family_binding_child_missing",
        `Binding '${validated.bindingId}' references missing child goal '${validated.childGoalId}'.`,
      );
    }
    if (!family.members[validated.parentGoalId]) {
      restoreFail(
        "goal_family_binding_parent_missing",
        `Binding '${validated.bindingId}' references missing parent goal '${validated.parentGoalId}'.`,
      );
    }
    const childMember = family.members[validated.childGoalId]!;
    if (
      !childMember.parent
      || childMember.parent.parentGoalId !== validated.parentGoalId
      || childMember.parent.parentWorkflowId !== validated.parentWorkflowId
      || childMember.parent.parentNodeId !== validated.parentNodeId
    ) {
      restoreFail(
        "goal_family_binding_parent_mismatch",
        `Binding '${validated.bindingId}' parent does not match member '${validated.childGoalId}' parent link.`,
      );
    }
    if (boundChildGoals.has(validated.childGoalId)) {
      restoreFail(
        "goal_family_binding_child_in_use",
        `Goal family '${family.familyId}' has more than one binding for child '${validated.childGoalId}'.`,
      );
    }
    boundChildGoals.add(validated.childGoalId);
    const attemptKey = `${validated.parentGoalId}\0${validated.parentNodeId}`;
    const attemptCount = (attemptsByParentNode.get(attemptKey) ?? 0) + 1;
    attemptsByParentNode.set(attemptKey, attemptCount);
    if (attemptCount > bounds.maxChildCreationAttemptsPerNode) {
      restoreFail(
        "goal_family_child_creation_attempts_exceeded",
        `Parent node '${validated.parentNodeId}' on goal '${validated.parentGoalId}' has `
        + `${attemptCount} child-creation bindings, which exceeds maxChildCreationAttemptsPerNode `
        + `${bounds.maxChildCreationAttemptsPerNode}.`,
      );
    }
    const allocationDiagnostics = validateChildBudgetAgainstFamilyLimits(
      family.familyBudget.limits,
      validated.budget,
    );
    if (allocationDiagnostics.length > 0) {
      const first = allocationDiagnostics[0]!;
      restoreFail(first.code, first.message);
    }
    expectedReservedTurns += validated.budget.maximumTurns ?? 0;
    expectedReservedTokens += validated.budget.maximumTokens ?? 0;
  }

  // Every non-root member must have exactly one binding.
  for (const member of Object.values(family.members)) {
    if (member.goalId === family.rootGoalId) continue;
    if (!boundChildGoals.has(member.goalId)) {
      // Membership-only child links (from member-added without child-created) remain valid
      // for scheduler tests that add members without bindings.
      continue;
    }
  }

  if (!Number.isSafeInteger(expectedReservedTurns) || !Number.isSafeInteger(expectedReservedTokens)) {
    restoreFail(
      "invalid_goal_family_budget",
      `Goal family '${family.familyId}' reserved budget totals exceed the safe integer range.`,
    );
  }
  if (family.familyBudget.reservedTurns !== expectedReservedTurns) {
    restoreFail(
      "goal_family_budget_mismatch",
      `Goal family '${family.familyId}' reservedTurns ${family.familyBudget.reservedTurns} `
      + `does not match binding allocations ${expectedReservedTurns}.`,
    );
  }
  if (family.familyBudget.reservedTokens !== expectedReservedTokens) {
    restoreFail(
      "goal_family_budget_mismatch",
      `Goal family '${family.familyId}' reservedTokens ${family.familyBudget.reservedTokens} `
      + `does not match binding allocations ${expectedReservedTokens}.`,
    );
  }
  if (
    family.familyBudget.limits.maximumTurns !== undefined
    && family.familyBudget.reservedTurns > family.familyBudget.limits.maximumTurns
  ) {
    restoreFail(
      "goal_family_budget_exceeded",
      `Goal family '${family.familyId}' reservedTurns ${family.familyBudget.reservedTurns} `
      + `exceeds maximumTurns ${family.familyBudget.limits.maximumTurns}.`,
    );
  }
  if (
    family.familyBudget.limits.maximumTokens !== undefined
    && family.familyBudget.reservedTokens > family.familyBudget.limits.maximumTokens
  ) {
    restoreFail(
      "goal_family_budget_exceeded",
      `Goal family '${family.familyId}' reservedTokens ${family.familyBudget.reservedTokens} `
      + `exceeds maximumTokens ${family.familyBudget.limits.maximumTokens}.`,
    );
  }

  validateFamilySchedulerState(family);
}

/**
 * Validate pending and terminal family scheduler state on a snapshot.
 * Mirrors root validateActionDispatchRuntime rules for ordinal, status, and timestamps.
 * Dispatch ID uniqueness is not a full historical set: only pending and last outcome matter.
 */
export function validateFamilySchedulerState(family: GoalFamilyRuntime): void {
  const pending = family.pendingDispatch;
  if (pending) {
    if (typeof pending.dispatchId !== "string" || !pending.dispatchId.trim()) {
      restoreFail(
        "invalid_goal_family_scheduler_state",
        `Goal family '${family.familyId}' pending dispatch requires a non-empty dispatch ID.`,
      );
    }
    if (!Number.isSafeInteger(pending.schedulerOrdinal) || pending.schedulerOrdinal < 1) {
      restoreFail(
        "invalid_goal_family_scheduler_state",
        `Pending dispatch '${pending.dispatchId}' has an invalid scheduler ordinal.`,
      );
    }
    // pending.schedulerOrdinal is the selection event sequence.
    // Later membership or lifecycle events may advance family.schedulerOrdinal.
    if (pending.schedulerOrdinal > family.schedulerOrdinal) {
      restoreFail(
        "invalid_goal_family_scheduler_state",
        `Pending dispatch '${pending.dispatchId}' scheduler ordinal ${pending.schedulerOrdinal} `
        + `is ahead of family sequence ${family.schedulerOrdinal}.`,
      );
    }
    if (!Number.isFinite(Date.parse(pending.selectedAt))) {
      restoreFail(
        "invalid_goal_family_scheduler_state",
        `Pending dispatch '${pending.dispatchId}' has an invalid selectedAt timestamp.`,
      );
    }
    requireSelectedAction(pending.selection, "Pending family dispatch selection");
    if (!family.members[pending.selection.goalId]) {
      restoreFail(
        "goal_family_member_missing",
        `Pending dispatch selects missing member '${pending.selection.goalId}'.`,
      );
    }
    if (pending.status === "dispatched") {
      if (!pending.dispatchedAt || !Number.isFinite(Date.parse(pending.dispatchedAt))) {
        restoreFail(
          "invalid_goal_family_scheduler_state",
          `Dispatched pending '${pending.dispatchId}' requires a valid dispatchedAt timestamp.`,
        );
      }
      if (Date.parse(pending.dispatchedAt) < Date.parse(pending.selectedAt)) {
        restoreFail(
          "goal_family_dispatch_timestamp_order",
          `Pending dispatch '${pending.dispatchId}' cannot be dispatched before it was selected.`,
        );
      }
    } else if (pending.status === "selected") {
      if (pending.dispatchedAt !== undefined) {
        restoreFail(
          "invalid_goal_family_scheduler_state",
          `Selected pending '${pending.dispatchId}' must not include dispatchedAt.`,
        );
      }
    } else {
      restoreFail(
        "invalid_goal_family_scheduler_state",
        `Pending dispatch '${pending.dispatchId}' has an unsupported status.`,
      );
    }
  }

  const outcome = family.lastDispatchOutcome;
  if (outcome) {
    if (typeof outcome.dispatchId !== "string" || !outcome.dispatchId.trim()) {
      restoreFail(
        "invalid_goal_family_scheduler_state",
        `Goal family '${family.familyId}' last dispatch outcome requires a non-empty dispatch ID.`,
      );
    }
    if (!Number.isSafeInteger(outcome.schedulerOrdinal) || outcome.schedulerOrdinal < 1) {
      restoreFail(
        "invalid_goal_family_scheduler_state",
        `Last dispatch outcome '${outcome.dispatchId}' has an invalid scheduler ordinal.`,
      );
    }
    if (outcome.schedulerOrdinal > family.schedulerOrdinal) {
      restoreFail(
        "invalid_goal_family_scheduler_state",
        `Last dispatch outcome '${outcome.dispatchId}' is ahead of family sequence `
        + `${family.schedulerOrdinal}.`,
      );
    }
    if (!Number.isFinite(Date.parse(outcome.selectedAt)) || !Number.isFinite(Date.parse(outcome.completedAt))) {
      restoreFail(
        "invalid_goal_family_scheduler_state",
        `Last dispatch outcome '${outcome.dispatchId}' has an invalid selectedAt or completedAt.`,
      );
    }
    requireSelectedAction(outcome.selection, "Last family dispatch outcome selection");
    if (outcome.status === "completed" || outcome.status === "failed") {
      if (!outcome.dispatchedAt || !Number.isFinite(Date.parse(outcome.dispatchedAt))) {
        restoreFail(
          "invalid_goal_family_scheduler_state",
          `Last dispatch outcome '${outcome.dispatchId}' with status '${outcome.status}' `
          + "requires a valid dispatchedAt timestamp.",
        );
      }
      if (Date.parse(outcome.dispatchedAt) < Date.parse(outcome.selectedAt)) {
        restoreFail(
          "goal_family_dispatch_timestamp_order",
          `Last dispatch outcome '${outcome.dispatchId}' cannot be dispatched before it was selected.`,
        );
      }
      if (Date.parse(outcome.completedAt) < Date.parse(outcome.dispatchedAt)) {
        restoreFail(
          "goal_family_dispatch_timestamp_order",
          `Last dispatch outcome '${outcome.dispatchId}' cannot complete before it was dispatched.`,
        );
      }
    } else if (outcome.status === "interrupted") {
      if (outcome.dispatchedAt !== undefined) {
        if (!Number.isFinite(Date.parse(outcome.dispatchedAt))) {
          restoreFail(
            "invalid_goal_family_scheduler_state",
            `Interrupted outcome '${outcome.dispatchId}' has an invalid dispatchedAt timestamp.`,
          );
        }
        if (Date.parse(outcome.dispatchedAt) < Date.parse(outcome.selectedAt)) {
          restoreFail(
            "goal_family_dispatch_timestamp_order",
            `Interrupted outcome '${outcome.dispatchId}' cannot be dispatched before it was selected.`,
          );
        }
        if (Date.parse(outcome.completedAt) < Date.parse(outcome.dispatchedAt)) {
          restoreFail(
            "goal_family_dispatch_timestamp_order",
            `Interrupted outcome '${outcome.dispatchId}' cannot complete before it was dispatched.`,
          );
        }
      } else if (Date.parse(outcome.completedAt) < Date.parse(outcome.selectedAt)) {
        restoreFail(
          "goal_family_dispatch_timestamp_order",
          `Interrupted outcome '${outcome.dispatchId}' cannot complete before it was selected.`,
        );
      }
    } else {
      restoreFail(
        "invalid_goal_family_scheduler_state",
        `Last dispatch outcome '${outcome.dispatchId}' has an unsupported status.`,
      );
    }
  }
}

/**
 * Rebuild membership from a stored family snapshot.
 * Rejects an unsupported schema version with a clear error.
 * Validates the membership graph and scheduler state. Product restore must use restoreFamilyProjection.
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
  if (rebuilt.createdAt !== snapshot.createdAt || rebuilt.updatedAt !== snapshot.updatedAt) {
    restoreFail(
      "goal_family_timestamp_mismatch",
      `The restored family timestamps for '${snapshot.familyId}' do not match the stored snapshot.`,
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
      || canonicalJsonStringify(rebuiltMember.parent ?? null) !== canonicalJsonStringify(snapshotMember.parent ?? null)
      || JSON.stringify([...rebuiltMember.childGoalIds].sort()) !== JSON.stringify([...snapshotMember.childGoalIds].sort())
    ) {
      restoreFail(
        "goal_family_membership_mismatch",
        `The restored family member '${goalId}' does not match the stored snapshot for family '${snapshot.familyId}'.`,
      );
    }
  }

  if (canonicalJsonStringify(rebuilt.pendingDispatch ?? null) !== canonicalJsonStringify(snapshot.pendingDispatch ?? null)) {
    restoreFail(
      "goal_family_scheduler_mismatch",
      `The restored family pending dispatch for '${snapshot.familyId}' does not match the stored snapshot.`,
    );
  }
  if (
    canonicalJsonStringify(rebuilt.lastDispatchOutcome ?? null)
    !== canonicalJsonStringify(snapshot.lastDispatchOutcome ?? null)
  ) {
    restoreFail(
      "goal_family_scheduler_mismatch",
      `The restored family last dispatch outcome for '${snapshot.familyId}' does not match the stored snapshot.`,
    );
  }
  if (canonicalJsonStringify(rebuilt.bounds) !== canonicalJsonStringify(snapshot.bounds)) {
    restoreFail(
      "goal_family_bounds_mismatch",
      `The restored family bounds for '${snapshot.familyId}' do not match the stored snapshot.`,
    );
  }
  if (canonicalJsonStringify(rebuilt.bindings) !== canonicalJsonStringify(snapshot.bindings)) {
    restoreFail(
      "goal_family_bindings_mismatch",
      `The restored family bindings for '${snapshot.familyId}' do not match the stored snapshot.`,
    );
  }
  if (canonicalJsonStringify(rebuilt.familyBudget) !== canonicalJsonStringify(snapshot.familyBudget)) {
    restoreFail(
      "goal_family_budget_mismatch",
      `The restored family budget for '${snapshot.familyId}' does not match the stored snapshot.`,
    );
  }

  return rebuilt;
}
