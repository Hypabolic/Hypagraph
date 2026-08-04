import {
  continuationActionMatches,
  isDispatchableGoalContinuation,
  selectGoalContinuation,
  enumerateGoalContinuationCandidates,
  type GoalDispatchableContinuation,
} from "./goal-continuation.js";
import {
  excludePendingFamilyConcurrentCandidates as excludePendingConcurrent,
  liftFamilyConcurrentCandidates as liftConcurrent,
  parseFamilyPendingDispatchOwnData,
  selectFamilyConcurrentBatch as selectFamilyConcurrentBatchCore,
  type FamilyConcurrentBatchInput,
  type FamilyConcurrentCandidate,
  type FamilyConcurrentCandidateAttributes,
  type FamilyConcurrentDecision,
} from "./family-concurrent-dispatch.js";
import {
  GOAL_FAMILY_EVENT_VERSION,
  GOAL_FAMILY_SCHEMA_VERSION,
  applyFamilyEvent,
  findPendingDispatchForGoal,
  getPendingDispatch,
  hasAnyPendingDispatch,
  listPendingDispatches,
  rejectGoalFamily,
  requireGoalFamilyNonEmpty,
  requireGoalFamilyTimestamp,
  type FamilyPendingDispatch,
  type FamilySelectedAction,
  type GoalFamilyEvent,
  type GoalFamilyMember,
  type GoalFamilyResult,
  type GoalFamilyRuntime,
  type ScheduledActionIdentity,
} from "./goal-family.js";
import type { Diagnostic, GoalContinuationAction, HypagraphState } from "./model.js";

export {
  FAMILY_CONCURRENT_OCCUPANCY_SCHEMA_VERSION,
  DEFAULT_FAMILY_CONCURRENT_EXECUTOR_KIND,
  buildFamilyConcurrentAttemptId,
  buildFamilyConcurrentAttemptIdFromSelection,
  defaultFamilyConcurrentBatchCapacity,
  encodeFamilyConcurrentIdField,
  excludePendingFamilyConcurrentCandidates,
  liftFamilyConcurrentCandidates,
  parseFamilyConcurrentLeaseSet,
  parseFamilyPendingDispatchOwnData,
  selectFamilyConcurrentBatch as selectFamilyConcurrentBatchFromCandidates,
  validateFamilyConcurrentOccupancySchema,
  validateLeaseHolderMatchesCandidate,
  workspaceLeasesCanonicallyEqual,
  type FamilyConcurrentBatchInput,
  type FamilyConcurrentCandidate,
  type FamilyConcurrentCandidateAttributes,
  type FamilyConcurrentDecision,
  type FamilyConcurrentOccupancy,
  type FamilyConcurrentSourceCandidate,
} from "./family-concurrent-dispatch.js";

/**
 * One runnable or dispatchable candidate tagged with family identity.
 * The union of these candidates is the family scheduler input set.
 */
export interface FamilyRunnableCandidate extends ScheduledActionIdentity {
  action: GoalContinuationAction;
  selectedSequence: number;
  selectedSnapshotHash: string;
  memberContinuationOrdinal: number;
  /** Stable depth of the owning family member at enumeration time. */
  memberDepth: number;
}

export type FamilySchedulerDecision =
  | {
    kind: "select";
    candidate: FamilyRunnableCandidate;
    reason: string;
  }
  | {
    kind: "idle";
    reason: string;
  }
  | {
    kind: "incomplete-input";
    reason: string;
    missingGoalIds: string[];
    mismatchedGoalIds: string[];
  }
  | {
    kind: "blocked-pending";
    reason: string;
    dispatchId: string;
  };

export type FamilySchedulerCommitResult =
  | {
    ok: true;
    family: GoalFamilyRuntime;
    events: GoalFamilyEvent[];
    decision: FamilySchedulerDecision;
  }
  | { ok: false; diagnostics: Diagnostic[] };

const reject = rejectGoalFamily;
const requireNonEmpty = requireGoalFamilyNonEmpty;
const requireTimestamp = requireGoalFamilyTimestamp;

const rejectCommit = (code: string, message: string, location?: string): FamilySchedulerCommitResult => ({
  ok: false,
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

/**
 * Sort family members for deterministic selection without cloning.
 * Primary key is depth ascending. Secondary key is goalId ascending.
 * Internal callers only read goalId, workflowId, and depth.
 */
function sortedMembers(family: GoalFamilyRuntime): GoalFamilyMember[] {
  return Object.values(family.members).sort((left, right) => {
    if (left.depth !== right.depth) return left.depth - right.depth;
    if (left.goalId < right.goalId) return -1;
    if (left.goalId > right.goalId) return 1;
    return 0;
  });
}

/**
 * Order family members for deterministic selection.
 * Primary key is depth ascending. Secondary key is goalId ascending.
 * Returns deep clones so callers cannot mutate the input family through the result.
 */
export function orderFamilyMembersForScheduler(family: GoalFamilyRuntime): GoalFamilyMember[] {
  return sortedMembers(family).map((member) => structuredClone(member));
}

function actionNodeFields(action: GoalContinuationAction): Pick<ScheduledActionIdentity, "nodeId" | "loopId"> {
  if (action.kind === "request-revision") return {};
  return {
    nodeId: action.nodeId,
    ...(action.loopId !== undefined ? { loopId: action.loopId } : {}),
  };
}

function liftDispatchable(
  family: GoalFamilyRuntime,
  member: GoalFamilyMember,
  decision: GoalDispatchableContinuation,
): FamilyRunnableCandidate {
  return {
    familyId: family.familyId,
    goalId: member.goalId,
    workflowId: member.workflowId,
    revision: decision.revision,
    ...actionNodeFields(decision),
    action: decision.kind === "request-revision"
      ? { kind: "request-revision", blocker: structuredClone(decision.blocker) }
      : {
        kind: decision.kind,
        nodeId: decision.nodeId,
        ...(decision.loopId !== undefined ? { loopId: decision.loopId } : {}),
      },
    selectedSequence: decision.sequence,
    selectedSnapshotHash: decision.snapshotHash,
    memberContinuationOrdinal: decision.continuationOrdinal,
    memberDepth: member.depth,
  };
}

function classifyMemberStateInput(
  family: GoalFamilyRuntime,
  memberStates: Readonly<Record<string, HypagraphState>>,
): { missingGoalIds: string[]; mismatchedGoalIds: string[] } {
  const missingGoalIds: string[] = [];
  const mismatchedGoalIds: string[] = [];
  for (const member of sortedMembers(family)) {
    const state = memberStates[member.goalId];
    if (!state) {
      missingGoalIds.push(member.goalId);
      continue;
    }
    if (state.workflowId !== member.workflowId || state.goal?.goalId !== member.goalId) {
      mismatchedGoalIds.push(member.goalId);
    }
  }
  return { missingGoalIds, mismatchedGoalIds };
}

/**
 * Enumerate the union of runnable work actions across all family members.
 * Members are ordered by depth, then goalId. Within a member, definition order from
 * enumerateGoalContinuationCandidates is preserved (reconcile actions come first).
 * Missing member states are skipped so callers can inspect a partial map.
 * This helper does not read the clock and does not mutate inputs.
 */
export function enumerateFamilyRunnableCandidates(
  family: GoalFamilyRuntime,
  memberStates: Readonly<Record<string, HypagraphState>>,
): FamilyRunnableCandidate[] {
  const candidates: FamilyRunnableCandidate[] = [];
  for (const member of sortedMembers(family)) {
    const state = memberStates[member.goalId];
    if (!state) continue;
    if (state.workflowId !== member.workflowId) continue;
    if (state.goal?.goalId !== member.goalId) continue;
    for (const action of enumerateGoalContinuationCandidates(state)) {
      candidates.push({
        familyId: family.familyId,
        goalId: member.goalId,
        workflowId: member.workflowId,
        revision: action.revision,
        ...actionNodeFields(action),
        action: {
          kind: action.kind,
          nodeId: action.nodeId,
          ...(action.loopId !== undefined ? { loopId: action.loopId } : {}),
        },
        selectedSequence: action.sequence,
        selectedSnapshotHash: action.snapshotHash,
        memberContinuationOrdinal: action.continuationOrdinal,
        memberDepth: member.depth,
      });
    }
  }
  return candidates;
}

/**
 * Enumerate preferred dispatchable actions, one per member when that member has work.
 * Uses selectGoalContinuation for each member so one-member families match root selection.
 * Members are ordered by depth ascending, then goalId ascending.
 * This helper does not read the clock and does not mutate inputs.
 */
export function enumerateFamilyPreferredDispatchables(
  family: GoalFamilyRuntime,
  memberStates: Readonly<Record<string, HypagraphState>>,
): FamilyRunnableCandidate[] {
  const preferred: FamilyRunnableCandidate[] = [];
  for (const member of sortedMembers(family)) {
    const state = memberStates[member.goalId];
    if (!state) continue;
    if (state.workflowId !== member.workflowId) continue;
    if (state.goal?.goalId !== member.goalId) continue;
    const decision = selectGoalContinuation(state);
    if (!isDispatchableGoalContinuation(decision)) continue;
    preferred.push(liftDispatchable(family, member, decision));
  }
  return preferred;
}

/**
 * Pure family scheduler decision for sequential dispatch.
 *
 * Selection policy for sequential mode:
 * 1. Reject a new selection while any family dispatch is pending.
 * 2. Report incomplete-input when any member state is missing or mismatched.
 * 3. Prefer each member's selectGoalContinuation result (reconcile and active work first).
 * 4. Order members by depth ascending, then goalId ascending.
 * 5. Select exactly one preferred dispatchable when any exist.
 * 6. Otherwise return idle.
 *
 * Concurrent multi-pending selection uses selectFamilyConcurrentActions instead.
 * The selected action must be committed through commitFamilySelection so replay is event-backed.
 * This helper does not read the clock and does not mutate inputs.
 */
export function selectFamilySchedulerAction(
  family: GoalFamilyRuntime,
  memberStates: Readonly<Record<string, HypagraphState>>,
): FamilySchedulerDecision {
  if (hasAnyPendingDispatch(family)) {
    const pendings = listPendingDispatches(family);
    const first = pendings[0]!;
    const idList = pendings.map((pending) => pending.dispatchId).join(", ");
    return {
      kind: "blocked-pending",
      reason:
        `Goal family '${family.familyId}' still has pending dispatch(es) `
        + `'${idList}'. Complete or interrupt them before a sequential selection.`,
      dispatchId: first.dispatchId,
    };
  }

  const { missingGoalIds, mismatchedGoalIds } = classifyMemberStateInput(family, memberStates);
  if (missingGoalIds.length > 0 || mismatchedGoalIds.length > 0) {
    return {
      kind: "incomplete-input",
      reason:
        "Member states are incomplete or mismatched. "
        + "Supply every family member state before pure selection.",
      missingGoalIds,
      mismatchedGoalIds,
    };
  }

  const preferred = enumerateFamilyPreferredDispatchables(family, memberStates);
  if (preferred.length === 0) {
    return {
      kind: "idle",
      reason: "No family member has a dispatchable continuation action.",
    };
  }

  const candidate = preferred[0]!;
  return {
    kind: "select",
    candidate,
    reason:
      `Selected by family sequential policy: member depth ${candidate.memberDepth}, `
      + `goal '${candidate.goalId}', then member continuation selection.`,
  };
}

function toSelectedAction(
  candidate: FamilyRunnableCandidate,
  reason: string,
): FamilySelectedAction {
  const selection: FamilySelectedAction = {
    familyId: candidate.familyId,
    goalId: candidate.goalId,
    workflowId: candidate.workflowId,
    revision: candidate.revision,
    action: structuredClone(candidate.action),
    reason,
    selectedSequence: candidate.selectedSequence,
    selectedSnapshotHash: candidate.selectedSnapshotHash,
    memberContinuationOrdinal: candidate.memberContinuationOrdinal,
  };
  if (candidate.nodeId !== undefined) selection.nodeId = candidate.nodeId;
  if (candidate.loopId !== undefined) selection.loopId = candidate.loopId;
  return selection;
}

function assertFamilySchema(family: GoalFamilyRuntime): Diagnostic[] | undefined {
  if (family.schemaVersion !== GOAL_FAMILY_SCHEMA_VERSION) {
    return [{
      code: "unsupported_goal_family_schema",
      message:
        `Unsupported goal-family schema version '${String(family.schemaVersion)}'. `
        + `Expected schema version ${GOAL_FAMILY_SCHEMA_VERSION}.`,
      location: "family.schemaVersion",
    }];
  }
  return undefined;
}

/**
 * Commit one sequential family selection when work exists.
 * Sequential policy admits at most one pending. A second selection while any
 * dispatch is pending fails with goal_family_dispatch_pending.
 * Use commitFamilyConcurrentBatch for multi-pending concurrent commit.
 * Idle decisions return ok with no events and an unchanged family clone.
 * Timestamps and identifiers are pure inputs.
 */
export function commitFamilySelection(input: {
  family: GoalFamilyRuntime;
  memberStates: Readonly<Record<string, HypagraphState>>;
  at: string;
  dispatchId: string;
  eventId?: string;
  correlationId?: string;
  causationId?: string;
}): FamilySchedulerCommitResult {
  const schemaError = assertFamilySchema(input.family);
  if (schemaError) {
    return { ok: false, diagnostics: schemaError };
  }

  const dispatchIdError = requireNonEmpty(input.dispatchId, "dispatch ID");
  if (dispatchIdError) return rejectCommit("invalid_goal_family_dispatch_id", dispatchIdError, "dispatchId");

  const atError = requireTimestamp(input.at);
  if (atError) return rejectCommit("invalid_goal_family_timestamp", atError, "at");

  if (hasAnyPendingDispatch(input.family)) {
    const pendings = listPendingDispatches(input.family);
    const idList = pendings.map((p) => p.dispatchId).join(", ");
    return rejectCommit(
      "goal_family_dispatch_pending",
      `Goal family '${input.family.familyId}' still has pending dispatch(es) `
      + `'${idList}'. Complete or interrupt them before a sequential selection.`,
      "family.pendingDispatches",
    );
  }

  // Bounded reuse policy: only the last terminal dispatch ID is retained for uniqueness.
  if (input.family.lastDispatchOutcome?.dispatchId === input.dispatchId) {
    return rejectCommit(
      "goal_family_dispatch_id_reused",
      `Goal family '${input.family.familyId}' already used dispatch ID '${input.dispatchId}' `
      + "as the last terminal dispatch outcome.",
      "dispatchId",
    );
  }

  const { missingGoalIds, mismatchedGoalIds } = classifyMemberStateInput(
    input.family,
    input.memberStates,
  );
  if (missingGoalIds.length > 0) {
    return rejectCommit(
      "goal_family_member_state_missing",
      `Goal family '${input.family.familyId}' member '${missingGoalIds[0]}' has no member state for selection.`,
      "memberStates",
    );
  }
  if (mismatchedGoalIds.length > 0) {
    const goalId = mismatchedGoalIds[0]!;
    const state = input.memberStates[goalId];
    const member = input.family.members[goalId]!;
    if (state && state.workflowId !== member.workflowId) {
      return rejectCommit(
        "goal_family_member_state_mismatch",
        `Member '${goalId}' expects workflow '${member.workflowId}', `
        + `but member state has workflow '${state.workflowId}'.`,
        "memberStates",
      );
    }
    return rejectCommit(
      "goal_family_member_state_mismatch",
      `Member '${goalId}' state does not contain a matching goal runtime.`,
      "memberStates",
    );
  }

  // Member states are complete. Pure select only yields select, idle, or blocked-pending.
  const decision = selectFamilySchedulerAction(input.family, input.memberStates);
  if (decision.kind === "blocked-pending") {
    return rejectCommit(
      "goal_family_dispatch_pending",
      decision.reason,
      "family.pendingDispatches",
    );
  }
  if (decision.kind === "idle") {
    return {
      ok: true,
      family: structuredClone(input.family),
      events: [],
      decision,
    };
  }
  if (decision.kind !== "select") {
    return rejectCommit(
      "goal_family_member_state_missing",
      "Member states are incomplete or mismatched.",
      "memberStates",
    );
  }

  const sequence = input.family.schedulerOrdinal + 1;
  const correlationId = input.correlationId
    ?? `family-select:${input.family.familyId}:${sequence}:${input.dispatchId}`;
  const causationId = input.causationId ?? correlationId;
  // Include sequence so default event IDs stay unique if a dispatchId is reused later.
  const eventId = input.eventId
    ?? `family-action-selected:${input.family.familyId}:${sequence}:${input.dispatchId}`;
  const selection = toSelectedAction(decision.candidate, decision.reason);

  const event: GoalFamilyEvent = {
    eventId,
    familyId: input.family.familyId,
    sequence,
    type: "hypagraph.family.action-selected",
    version: GOAL_FAMILY_EVENT_VERSION,
    timestamp: input.at,
    causationId,
    correlationId,
    data: {
      dispatchId: input.dispatchId,
      selection,
    },
  };

  const family = applyFamilyEvent(input.family, event);
  return { ok: true, family, events: [event], decision };
}

/**
 * Mark a selected family action as dispatched.
 * Targets one dispatchId. Other pendings stay intact.
 * When memberState is supplied, reject a stale selection that no longer matches the member snapshot.
 */
export function markFamilyActionDispatched(input: {
  family: GoalFamilyRuntime;
  dispatchId: string;
  at: string;
  memberState?: HypagraphState;
  eventId?: string;
  correlationId?: string;
  causationId?: string;
}): GoalFamilyResult {
  const schemaError = assertFamilySchema(input.family);
  if (schemaError) return { ok: false, diagnostics: schemaError };

  const dispatchIdError = requireNonEmpty(input.dispatchId, "dispatch ID");
  if (dispatchIdError) return reject("invalid_goal_family_dispatch_id", dispatchIdError, "dispatchId");

  const atError = requireTimestamp(input.at);
  if (atError) return reject("invalid_goal_family_timestamp", atError, "at");

  const pending = getPendingDispatch(input.family, input.dispatchId);
  if (!pending) {
    return reject(
      "goal_family_dispatch_missing",
      `Goal family '${input.family.familyId}' has no pending dispatch '${input.dispatchId}' to mark as dispatched.`,
      "family.pendingDispatches",
    );
  }
  if (pending.status !== "selected") {
    return reject(
      "goal_family_dispatch_already_dispatched",
      `Family dispatch '${input.dispatchId}' was already dispatched.`,
      "dispatchId",
    );
  }
  if (Date.parse(input.at) < Date.parse(pending.selectedAt)) {
    return reject(
      "goal_family_dispatch_timestamp_order",
      `Family dispatch '${input.dispatchId}' cannot be dispatched before it was selected.`,
      "at",
    );
  }

  if (input.memberState) {
    const state = input.memberState;
    if (state.workflowId !== pending.selection.workflowId || state.goal?.goalId !== pending.selection.goalId) {
      return reject(
        "goal_family_dispatch_stale_selection",
        `Member state for dispatch '${input.dispatchId}' does not match the selected goal or workflow.`,
        "memberState",
      );
    }
    if (state.snapshotHash !== pending.selection.selectedSnapshotHash) {
      return reject(
        "goal_family_dispatch_stale_selection",
        `Family dispatch '${input.dispatchId}' was selected against snapshot `
        + `'${pending.selection.selectedSnapshotHash}', but the member snapshot is `
        + `'${state.snapshotHash}'.`,
        "memberState",
      );
    }
    // Re-run the selection-time predicate. Do not use continuationActionIsRunnable:
    // for request-revision that predicate requires a pending continuation which exists
    // only after the revision request is recorded, not at family dispatch time.
    const currentDecision = selectGoalContinuation(state);
    if (
      !isDispatchableGoalContinuation(currentDecision)
      || !continuationActionMatches(currentDecision, pending.selection.action)
    ) {
      return reject(
        "goal_family_dispatch_stale_selection",
        `Family dispatch '${input.dispatchId}' is no longer the preferred dispatchable action `
        + "on the member state.",
        "memberState",
      );
    }
  }

  const sequence = input.family.schedulerOrdinal + 1;
  const correlationId = input.correlationId
    ?? `family-dispatch:${input.family.familyId}:${sequence}:${input.dispatchId}`;
  const causationId = input.causationId ?? correlationId;
  const eventId = input.eventId
    ?? `family-action-dispatched:${input.family.familyId}:${sequence}:${input.dispatchId}`;

  const event: GoalFamilyEvent = {
    eventId,
    familyId: input.family.familyId,
    sequence,
    type: "hypagraph.family.action-dispatched",
    version: GOAL_FAMILY_EVENT_VERSION,
    timestamp: input.at,
    causationId,
    correlationId,
    data: { dispatchId: input.dispatchId },
  };

  return { ok: true, family: applyFamilyEvent(input.family, event), events: [event] };
}

function completeFamilyActionWithStatus(input: {
  family: GoalFamilyRuntime;
  dispatchId: string;
  at: string;
  status: "completed" | "failed" | "interrupted";
  reason?: string;
  eventId?: string;
  correlationId?: string;
  causationId?: string;
}): GoalFamilyResult {
  const schemaError = assertFamilySchema(input.family);
  if (schemaError) return { ok: false, diagnostics: schemaError };

  const dispatchIdError = requireNonEmpty(input.dispatchId, "dispatch ID");
  if (dispatchIdError) return reject("invalid_goal_family_dispatch_id", dispatchIdError, "dispatchId");

  const atError = requireTimestamp(input.at);
  if (atError) return reject("invalid_goal_family_timestamp", atError, "at");

  const pending = getPendingDispatch(input.family, input.dispatchId);
  if (!pending) {
    return reject(
      "goal_family_dispatch_missing",
      `Goal family '${input.family.familyId}' has no pending dispatch '${input.dispatchId}' to complete.`,
      "family.pendingDispatches",
    );
  }

  if (input.status === "interrupted") {
    if (pending.status !== "selected" && pending.status !== "dispatched") {
      return reject(
        "goal_family_dispatch_invalid_status",
        `Family dispatch '${input.dispatchId}' has an invalid pending status for interrupt.`,
        "dispatchId",
      );
    }
    if (pending.status === "selected") {
      if (Date.parse(input.at) < Date.parse(pending.selectedAt)) {
        return reject(
          "goal_family_dispatch_timestamp_order",
          `Family dispatch '${input.dispatchId}' cannot be interrupted before it was selected.`,
          "at",
        );
      }
    } else {
      if (!pending.dispatchedAt) {
        return reject(
          "goal_family_dispatch_not_dispatched",
          `Family dispatch '${input.dispatchId}' is marked dispatched without a dispatch timestamp.`,
          "dispatchId",
        );
      }
      if (Date.parse(input.at) < Date.parse(pending.dispatchedAt)) {
        return reject(
          "goal_family_dispatch_timestamp_order",
          `Family dispatch '${input.dispatchId}' cannot complete before it was dispatched.`,
          "at",
        );
      }
    }
  } else {
    if (pending.status !== "dispatched") {
      return reject(
        "goal_family_dispatch_not_dispatched",
        `Family dispatch '${input.dispatchId}' must be dispatched before a terminal outcome.`,
        "dispatchId",
      );
    }
    if (!pending.dispatchedAt) {
      return reject(
        "goal_family_dispatch_not_dispatched",
        `Family dispatch '${input.dispatchId}' is marked dispatched without a dispatch timestamp.`,
        "dispatchId",
      );
    }
    if (Date.parse(input.at) < Date.parse(pending.dispatchedAt)) {
      return reject(
        "goal_family_dispatch_timestamp_order",
        `Family dispatch '${input.dispatchId}' cannot complete before it was dispatched.`,
        "at",
      );
    }
  }

  const type =
    input.status === "completed"
      ? "hypagraph.family.action-completed" as const
      : input.status === "failed"
        ? "hypagraph.family.action-failed" as const
        : "hypagraph.family.action-interrupted" as const;

  const sequence = input.family.schedulerOrdinal + 1;
  const correlationId = input.correlationId
    ?? `family-${input.status}:${input.family.familyId}:${sequence}:${input.dispatchId}`;
  const causationId = input.causationId ?? correlationId;
  const eventId = input.eventId
    ?? `family-action-${input.status}:${input.family.familyId}:${sequence}:${input.dispatchId}`;

  const event: GoalFamilyEvent = {
    eventId,
    familyId: input.family.familyId,
    sequence,
    type,
    version: GOAL_FAMILY_EVENT_VERSION,
    timestamp: input.at,
    causationId,
    correlationId,
    data: {
      dispatchId: input.dispatchId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
  };

  return { ok: true, family: applyFamilyEvent(input.family, event), events: [event] };
}

/**
 * Record successful completion of one pending family dispatch by dispatchId.
 * Clears only that pending. Unrelated pendings remain.
 */
export function completeFamilyAction(input: {
  family: GoalFamilyRuntime;
  dispatchId: string;
  at: string;
  reason?: string;
  eventId?: string;
  correlationId?: string;
  causationId?: string;
}): GoalFamilyResult {
  return completeFamilyActionWithStatus({ ...input, status: "completed" });
}

/**
 * Record failure of one pending family dispatch by dispatchId.
 * Clears only that pending. Unrelated pendings remain.
 */
export function failFamilyAction(input: {
  family: GoalFamilyRuntime;
  dispatchId: string;
  at: string;
  reason?: string;
  eventId?: string;
  correlationId?: string;
  causationId?: string;
}): GoalFamilyResult {
  return completeFamilyActionWithStatus({ ...input, status: "failed" });
}

/**
 * Record interruption of one pending family dispatch by dispatchId.
 * Clears only that pending. Unrelated pendings remain.
 * Interrupt is allowed while status is selected (abort before dispatch) or dispatched.
 */
export function interruptFamilyAction(input: {
  family: GoalFamilyRuntime;
  dispatchId: string;
  at: string;
  reason?: string;
  eventId?: string;
  correlationId?: string;
  causationId?: string;
}): GoalFamilyResult {
  return completeFamilyActionWithStatus({ ...input, status: "interrupted" });
}

/**
 * Concurrent family selection decision extended with incomplete-input reporting
 * for missing or mismatched member states (same contract as sequential select).
 */
export type FamilyConcurrentSchedulerDecision =
  | FamilyConcurrentDecision
  | {
    kind: "incomplete-input";
    reason: string;
    missingGoalIds: string[];
    mismatchedGoalIds: string[];
  };

export type FamilyConcurrentCommitResult =
  | {
    ok: true;
    family: GoalFamilyRuntime;
    events: GoalFamilyEvent[];
    decision: FamilyConcurrentSchedulerDecision;
    /** Dispatch IDs committed in selection order. Empty when idle. */
    committedDispatchIds: string[];
  }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Commit a concurrent family batch as multi-pending selected dispatches.
 *
 * Runs selectFamilyConcurrentActions, then applies one action-selected event
 * per selected candidate using the supplied dispatchIds (same order and length).
 * Existing pendings remain occupancy. Capacity is enforced by concurrent selection.
 * Timestamps and identifiers are pure inputs. Does not mutate inputs.
 */
export function commitFamilyConcurrentBatch(input: {
  family: GoalFamilyRuntime;
  memberStates: Readonly<Record<string, HypagraphState>>;
  at: string;
  /** One non-empty dispatch ID per selected candidate, in selection order. */
  dispatchIds: string[];
  candidateSource?: "preferred" | "runnable";
  attributesByAttemptId?: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>;
  attributesByGoalId?: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>;
  concurrencyLimits?: unknown;
  groupRegistry?: unknown;
  concurrencyState?: FamilyConcurrentBatchInput["concurrencyState"];
  groupState?: FamilyConcurrentBatchInput["groupState"];
  leaseSet?: FamilyConcurrentBatchInput["leaseSet"];
  fairnessOrdinal?: number;
  maxBatchSize?: number;
  treatPendingAsOccupancy?: boolean;
  eventIdPrefix?: string;
  correlationId?: string;
  causationId?: string;
}): FamilyConcurrentCommitResult {
  const schemaError = assertFamilySchema(input.family);
  if (schemaError) {
    return { ok: false, diagnostics: schemaError };
  }

  const atError = requireTimestamp(input.at);
  if (atError) {
    return rejectCommit("invalid_goal_family_timestamp", atError, "at") as FamilyConcurrentCommitResult;
  }

  if (!Array.isArray(input.dispatchIds)) {
    return rejectCommit(
      "invalid_goal_family_dispatch_id",
      "dispatchIds must be an array of non-empty strings.",
      "dispatchIds",
    ) as FamilyConcurrentCommitResult;
  }

  const seenDispatchIds = new Set<string>();
  for (let index = 0; index < input.dispatchIds.length; index += 1) {
    const dispatchId = input.dispatchIds[index];
    const idError = requireNonEmpty(dispatchId ?? "", "dispatch ID");
    if (idError) {
      return rejectCommit(
        "invalid_goal_family_dispatch_id",
        idError,
        `dispatchIds[${index}]`,
      ) as FamilyConcurrentCommitResult;
    }
    if (seenDispatchIds.has(dispatchId!)) {
      return rejectCommit(
        "goal_family_dispatch_id_duplicate",
        `dispatchIds contains duplicate dispatch ID '${dispatchId}'.`,
        `dispatchIds[${index}]`,
      ) as FamilyConcurrentCommitResult;
    }
    seenDispatchIds.add(dispatchId!);
    if (input.family.pendingDispatches[dispatchId!]) {
      return rejectCommit(
        "goal_family_dispatch_id_duplicate",
        `Goal family '${input.family.familyId}' already has pending dispatch '${dispatchId}'.`,
        `dispatchIds[${index}]`,
      ) as FamilyConcurrentCommitResult;
    }
    if (input.family.lastDispatchOutcome?.dispatchId === dispatchId) {
      return rejectCommit(
        "goal_family_dispatch_id_reused",
        `Goal family '${input.family.familyId}' already used dispatch ID '${dispatchId}' `
        + "as the last terminal dispatch outcome.",
        `dispatchIds[${index}]`,
      ) as FamilyConcurrentCommitResult;
    }
  }

  const concurrentInput: Parameters<typeof selectFamilyConcurrentActions>[0] = {
    family: input.family,
    memberStates: input.memberStates,
  };
  if (input.candidateSource !== undefined) concurrentInput.candidateSource = input.candidateSource;
  if (input.attributesByAttemptId !== undefined) {
    concurrentInput.attributesByAttemptId = input.attributesByAttemptId;
  }
  if (input.attributesByGoalId !== undefined) {
    concurrentInput.attributesByGoalId = input.attributesByGoalId;
  }
  if (input.concurrencyLimits !== undefined) {
    concurrentInput.concurrencyLimits = input.concurrencyLimits;
  }
  if (input.groupRegistry !== undefined) concurrentInput.groupRegistry = input.groupRegistry;
  if (input.concurrencyState !== undefined) {
    concurrentInput.concurrencyState = input.concurrencyState;
  }
  if (input.groupState !== undefined) concurrentInput.groupState = input.groupState;
  if (input.leaseSet !== undefined) concurrentInput.leaseSet = input.leaseSet;
  if (input.fairnessOrdinal !== undefined) concurrentInput.fairnessOrdinal = input.fairnessOrdinal;
  if (input.maxBatchSize !== undefined) concurrentInput.maxBatchSize = input.maxBatchSize;
  if (input.treatPendingAsOccupancy !== undefined) {
    concurrentInput.treatPendingAsOccupancy = input.treatPendingAsOccupancy;
  }
  const decision = selectFamilyConcurrentActions(concurrentInput);

  if (decision.kind === "incomplete-input") {
    return rejectCommit(
      "goal_family_member_state_missing",
      decision.reason,
      "memberStates",
    ) as FamilyConcurrentCommitResult;
  }
  if (decision.kind === "rejected") {
    return { ok: false, diagnostics: decision.diagnostics };
  }
  if (decision.kind === "idle") {
    return {
      ok: true,
      family: structuredClone(input.family),
      events: [],
      decision,
      committedDispatchIds: [],
    };
  }

  // decision.kind === "select-batch"
  if (input.dispatchIds.length !== decision.candidates.length) {
    return rejectCommit(
      "goal_family_concurrent_dispatch_id_count",
      `Expected ${decision.candidates.length} dispatch ID(s) for the concurrent batch, `
      + `but received ${input.dispatchIds.length}.`,
      "dispatchIds",
    ) as FamilyConcurrentCommitResult;
  }

  let family = input.family;
  const events: GoalFamilyEvent[] = [];
  const committedDispatchIds: string[] = [];
  const eventIdPrefix = input.eventIdPrefix ?? "family-action-selected";

  for (let index = 0; index < decision.candidates.length; index += 1) {
    const candidate = decision.candidates[index]!;
    const dispatchId = input.dispatchIds[index]!;
    // Exclusive goal occupancy is also enforced in applyActionSelectedEvent.
    if (findPendingDispatchForGoal(family, candidate.goalId)) {
      return rejectCommit(
        "goal_family_dispatch_goal_pending",
        `Goal family '${family.familyId}' already has a pending dispatch for member `
        + `'${candidate.goalId}'.`,
        `dispatchIds[${index}]`,
      ) as FamilyConcurrentCommitResult;
    }

    const sequence = family.schedulerOrdinal + 1;
    const correlationId = input.correlationId
      ?? `family-select-batch:${family.familyId}:${sequence}:${dispatchId}`;
    const causationId = input.causationId ?? correlationId;
    const eventId = `${eventIdPrefix}:${family.familyId}:${sequence}:${dispatchId}`;
    const selection = toSelectedAction(
      candidate as FamilyRunnableCandidate,
      `${decision.reason} (batch index ${index}).`,
    );

    const event: GoalFamilyEvent = {
      eventId,
      familyId: family.familyId,
      sequence,
      type: "hypagraph.family.action-selected",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: input.at,
      causationId,
      correlationId,
      data: {
        dispatchId,
        selection,
      },
    };

    family = applyFamilyEvent(family, event);
    events.push(event);
    committedDispatchIds.push(dispatchId);
  }

  return {
    ok: true,
    family,
    events,
    decision,
    committedDispatchIds,
  };
}

/**
 * Pure concurrent family scheduler selection for independent loops and child workflows.
 *
 * Unlike sequential selectFamilySchedulerAction, this helper does not block when
 * pendingDispatches is non-empty. Existing pendings occupy capacity and exclude
 * those goals from re-selection. Other compatible members remain selectable
 * when global limits, groups, and leases permit.
 *
 * Selection composes:
 * - preferred (default) or runnable family candidates;
 * - global and per-executor concurrency limits (default global capacity 2);
 * - concurrency groups and fair batch selection;
 * - optional workspace lease compatibility.
 *
 * Commit multi-pending state with commitFamilyConcurrentBatch.
 * Sequential commitFamilySelection remains the single-selection path.
 * Does not read the clock and does not mutate inputs.
 */
export function selectFamilyConcurrentActions(input: {
  family: GoalFamilyRuntime;
  memberStates: Readonly<Record<string, HypagraphState>>;
  candidateSource?: "preferred" | "runnable";
  attributesByAttemptId?: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>;
  attributesByGoalId?: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>;
  concurrencyLimits?: unknown;
  groupRegistry?: unknown;
  concurrencyState?: FamilyConcurrentBatchInput["concurrencyState"];
  groupState?: FamilyConcurrentBatchInput["groupState"];
  leaseSet?: FamilyConcurrentBatchInput["leaseSet"];
  fairnessOrdinal?: number;
  maxBatchSize?: number;
  treatPendingAsOccupancy?: boolean;
}): FamilyConcurrentSchedulerDecision {
  const schemaError = assertFamilySchema(input.family);
  if (schemaError) {
    return {
      kind: "rejected",
      reason: schemaError[0]!.message,
      diagnostics: schemaError,
    };
  }

  const { missingGoalIds, mismatchedGoalIds } = classifyMemberStateInput(
    input.family,
    input.memberStates,
  );
  if (missingGoalIds.length > 0 || mismatchedGoalIds.length > 0) {
    return {
      kind: "incomplete-input",
      reason:
        "Member states are incomplete or mismatched. "
        + "Supply every family member state before pure concurrent selection.",
      missingGoalIds,
      mismatchedGoalIds,
    };
  }

  const source = input.candidateSource ?? "preferred";
  const candidates = source === "runnable"
    ? enumerateFamilyRunnableCandidates(input.family, input.memberStates)
    : enumerateFamilyPreferredDispatchables(input.family, input.memberStates);

  const batchInput: FamilyConcurrentBatchInput = {
    family: input.family,
    candidates,
  };
  if (input.attributesByAttemptId !== undefined) {
    batchInput.attributesByAttemptId = input.attributesByAttemptId;
  }
  if (input.attributesByGoalId !== undefined) {
    batchInput.attributesByGoalId = input.attributesByGoalId;
  }
  if (input.concurrencyLimits !== undefined) {
    batchInput.concurrencyLimits = input.concurrencyLimits;
  }
  if (input.groupRegistry !== undefined) {
    batchInput.groupRegistry = input.groupRegistry;
  }
  if (input.concurrencyState !== undefined) {
    batchInput.concurrencyState = input.concurrencyState;
  }
  if (input.groupState !== undefined) {
    batchInput.groupState = input.groupState;
  }
  if (input.leaseSet !== undefined) {
    batchInput.leaseSet = input.leaseSet;
  }
  if (input.fairnessOrdinal !== undefined) {
    batchInput.fairnessOrdinal = input.fairnessOrdinal;
  }
  if (input.maxBatchSize !== undefined) {
    batchInput.maxBatchSize = input.maxBatchSize;
  }
  if (input.treatPendingAsOccupancy !== undefined) {
    batchInput.treatPendingAsOccupancy = input.treatPendingAsOccupancy;
  }

  return selectFamilyConcurrentBatchCore(batchInput);
}

/**
 * True when at least one pending dispatch is present and concurrent selection
 * can still choose at least one other compatible action under pending occupancy.
 * Returns false when the family has no pending dispatch.
 * Forces treatPendingAsOccupancy for this predicate. Pure. Does not mutate inputs.
 */
export function familyConcurrentSelectionAllowsOverlapWithPending(
  family: GoalFamilyRuntime,
  memberStates: Readonly<Record<string, HypagraphState>>,
  options?: Omit<
    Parameters<typeof selectFamilyConcurrentActions>[0],
    "family" | "memberStates" | "treatPendingAsOccupancy"
  >,
): boolean {
  // Parse pendingDispatches with own data properties only. Do not read it normally.
  const pendingParse = parseFamilyPendingDispatchOwnData(
    family as object,
    "family.pendingDispatches",
  );
  if (!pendingParse.ok || pendingParse.value.length === 0) {
    return false;
  }
  const decision = selectFamilyConcurrentActions({
    family,
    memberStates,
    ...options,
    treatPendingAsOccupancy: true,
  });
  return decision.kind === "select-batch" && decision.candidates.length > 0;
}

/**
 * Enumerate concurrent candidates after lifting preferred or runnable family work.
 * Excludes sequential pending goals when treatPendingAsOccupancy is true (default).
 * Does not mutate inputs.
 */
export function enumerateFamilyConcurrentCandidates(
  family: GoalFamilyRuntime,
  memberStates: Readonly<Record<string, HypagraphState>>,
  options?: {
    candidateSource?: "preferred" | "runnable";
    attributesByAttemptId?: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>;
    attributesByGoalId?: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>;
    treatPendingAsOccupancy?: boolean;
  },
):
  | {
    ok: true;
    candidates: FamilyConcurrentCandidate[];
    pendingAttemptId?: string;
  }
  | { ok: false; diagnostics: Diagnostic[] }
  | {
    ok: false;
    incomplete: true;
    missingGoalIds: string[];
    mismatchedGoalIds: string[];
  } {
  const schemaError = assertFamilySchema(family);
  if (schemaError) {
    return { ok: false, diagnostics: schemaError };
  }

  const { missingGoalIds, mismatchedGoalIds } = classifyMemberStateInput(family, memberStates);
  if (missingGoalIds.length > 0 || mismatchedGoalIds.length > 0) {
    return {
      ok: false,
      incomplete: true,
      missingGoalIds,
      mismatchedGoalIds,
    };
  }

  const source = options?.candidateSource ?? "preferred";
  const base = source === "runnable"
    ? enumerateFamilyRunnableCandidates(family, memberStates)
    : enumerateFamilyPreferredDispatchables(family, memberStates);

  const liftOptions: {
    attributesByAttemptId?: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>;
    attributesByGoalId?: Readonly<Record<string, FamilyConcurrentCandidateAttributes>>;
  } = {};
  if (options?.attributesByAttemptId !== undefined) {
    liftOptions.attributesByAttemptId = options.attributesByAttemptId;
  }
  if (options?.attributesByGoalId !== undefined) {
    liftOptions.attributesByGoalId = options.attributesByGoalId;
  }
  const lifted = liftConcurrent(base, liftOptions);
  if (!lifted.ok) {
    return lifted;
  }

  const treatPending = options?.treatPendingAsOccupancy !== false;
  let cleanPendings: FamilyPendingDispatch[] = [];
  if (treatPending) {
    const pendingParse = parseFamilyPendingDispatchOwnData(
      family as object,
      "family.pendingDispatches",
    );
    if (!pendingParse.ok) {
      return { ok: false, diagnostics: pendingParse.diagnostics };
    }
    cleanPendings = pendingParse.value;
  }
  const filtered = excludePendingConcurrent(
    lifted.candidates,
    cleanPendings,
  );

  return {
    ok: true,
    candidates: filtered.candidates,
    ...(filtered.pendingAttemptId !== undefined
      ? { pendingAttemptId: filtered.pendingAttemptId }
      : {}),
  };
}
