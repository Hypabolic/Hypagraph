/**
 * Seam A: session and member context for the Pi host.
 *
 * SessionContext is one bag per extension session. MemberContext is the
 * working state and event stream for one family member during dispatch.
 * Dispatch must take an explicit MemberContext. Non-root work must not swap
 * free root state and events as the only execution path.
 *
 * Pure MemberContext values are independent. Product dispatch still uses a
 * temporary single-seat free-slot bind for nested helpers that close over
 * free host state. Concurrent dispatch is not safe until that bridge is
 * removed (S4).
 *
 * Domain reducers stay free of these types. Context types live in the host.
 */

import type { DomainEvent, HypagraphState } from "../domain/model.js";
import type { PersistedGoalFamily } from "../persistence/family-store.js";

/**
 * Placeholder for the S4 multi-worker pool.
 * S3 does not implement the Map pool. The field exists so session context
 * can grow without another type break.
 */
export type WorkerPoolPlaceholder = undefined;

/**
 * One instance per extension session.
 * Owns session-level generation counters, root identity, and optional caches.
 * Live root state and events may still live in the extension as root authority
 * for this slice. Member dispatch uses MemberContext.
 */
export interface SessionContext {
  /** Increments on each session restore. */
  sessionGeneration: number;
  /** Increments when the Pi session branch changes. */
  branchGeneration: number;
  /** Desk root workflow id when a root workflow is live. */
  rootWorkflowId: string | undefined;
  /** Latest family record known to the host. Optional cache slot. */
  familyRecord: PersistedGoalFamily | undefined;
  /**
   * Future multi-worker pool (S4). Always undefined in S3.
   * Do not start concurrent workers from this field in this slice.
   */
  workerPool: WorkerPoolPlaceholder;
  /** Host paint deferral flag. Optional until Seam F. */
  paintPending: boolean;
}

/**
 * Working context for one member action (root or non-root).
 * Dispatch mutates state and events on this object.
 * Two pure MemberContext values do not share mutable slots when attachMember
 * clones. Product free-slot bind is still a single seat until S4.
 */
export interface MemberContext {
  readonly workflowId: string;
  readonly goalId: string;
  /** True when this member is the live desk root workflow. */
  readonly isLiveRoot: boolean;
  /** Working workflow state for this member. */
  state: HypagraphState | undefined;
  /** Working event stream for this member. */
  events: DomainEvent[];
}

export interface CreateSessionContextInput {
  sessionGeneration?: number;
  branchGeneration?: number;
  rootWorkflowId?: string;
  familyRecord?: PersistedGoalFamily;
  paintPending?: boolean;
}

export interface AttachRootMemberInput {
  workflowId: string;
  goalId: string;
  state: HypagraphState;
  events: DomainEvent[];
}

export interface AttachMemberInput {
  workflowId: string;
  goalId: string;
  state: HypagraphState;
  events: DomainEvent[];
}

export interface MemberSnapshot {
  workflowId: string;
  goalId: string;
  isLiveRoot: boolean;
  state: HypagraphState | undefined;
  events: DomainEvent[];
}

export interface SessionSnapshot {
  sessionGeneration: number;
  branchGeneration: number;
  rootWorkflowId: string | undefined;
  paintPending: boolean;
  hasFamilyRecord: boolean;
  hasWorkerPool: boolean;
}

/**
 * Inputs for pure free-slot release rules (testable without the extension closure).
 */
export interface ResolveLiveSlotReleaseInput {
  memberWorkflowId: string;
  memberState: HypagraphState | undefined;
  memberEvents: DomainEvent[];
  freeState: HypagraphState | undefined;
  freeEvents: DomainEvent[];
  savedRootState: HypagraphState | undefined;
  savedRootEvents: DomainEvent[];
  bindSessionGeneration: number;
  bindBranchGeneration: number;
  currentSessionGeneration: number;
  currentBranchGeneration: number;
}

/**
 * Result of pure free-slot release rules.
 */
export interface ResolveLiveSlotReleaseResult {
  nextMemberState: HypagraphState | undefined;
  nextMemberEvents: DomainEvent[];
  nextFreeState: HypagraphState | undefined;
  nextFreeEvents: DomainEvent[];
  /** True when free slots were restored from the pre-bind root capture. */
  restoredSavedRoot: boolean;
  /** True when free slots still held the member and were written into MemberContext. */
  syncedMemberFromLive: boolean;
}

/**
 * Create one session context for a new extension session.
 */
export function createSessionContext(input: CreateSessionContextInput = {}): SessionContext {
  return {
    sessionGeneration: input.sessionGeneration ?? 0,
    branchGeneration: input.branchGeneration ?? 0,
    rootWorkflowId: input.rootWorkflowId,
    familyRecord: input.familyRecord,
    workerPool: undefined,
    paintPending: input.paintPending ?? false,
  };
}

/**
 * Attach the live desk root as a MemberContext.
 * Shares the caller state and events references (root authority).
 * When session.rootWorkflowId is set, isLiveRoot is true only when the
 * workflow id matches. When rootWorkflowId is unset, this call sets it.
 */
export function attachRootMember(
  session: SessionContext,
  input: AttachRootMemberInput,
): MemberContext {
  if (session.rootWorkflowId === undefined) {
    session.rootWorkflowId = input.workflowId;
  }
  const isLiveRoot = session.rootWorkflowId === input.workflowId;
  return {
    workflowId: input.workflowId,
    goalId: input.goalId,
    isLiveRoot,
    state: input.state,
    events: input.events,
  };
}

/**
 * Attach a non-root family member as a MemberContext.
 * Clones state and events so the member working set is independent of the
 * caller and of other members at the API boundary.
 * The session argument is reserved for later registration; S3 does not
 * register non-root members on the session bag.
 */
export function attachMember(
  session: SessionContext,
  input: AttachMemberInput,
): MemberContext {
  void session;
  return {
    workflowId: input.workflowId,
    goalId: input.goalId,
    isLiveRoot: false,
    state: structuredClone(input.state),
    events: structuredClone(input.events),
  };
}

/**
 * Deep-clone snapshot of one member for tests and diagnostics.
 */
export function snapshotMember(member: MemberContext): MemberSnapshot {
  return {
    workflowId: member.workflowId,
    goalId: member.goalId,
    isLiveRoot: member.isLiveRoot,
    state: member.state === undefined ? undefined : structuredClone(member.state),
    events: structuredClone(member.events),
  };
}

/**
 * Snapshot of session-level fields (no deep clone of family record).
 */
export function snapshotSession(session: SessionContext): SessionSnapshot {
  return {
    sessionGeneration: session.sessionGeneration,
    branchGeneration: session.branchGeneration,
    rootWorkflowId: session.rootWorkflowId,
    paintPending: session.paintPending,
    hasFamilyRecord: session.familyRecord !== undefined,
    hasWorkerPool: session.workerPool !== undefined,
  };
}

/**
 * Update generation counters after restore or branch change.
 * Mutates the session context in place and returns it.
 */
export function bumpSessionGenerations(
  session: SessionContext,
  input: { branchChanged: boolean },
): SessionContext {
  session.sessionGeneration += 1;
  if (input.branchChanged) {
    session.branchGeneration += 1;
  }
  return session;
}

/**
 * Record the live root workflow identity on the session context.
 */
export function setSessionRootWorkflowId(
  session: SessionContext,
  workflowId: string | undefined,
): void {
  session.rootWorkflowId = workflowId;
}

/**
 * Store or clear the family record cache on the session context.
 */
export function setSessionFamilyRecord(
  session: SessionContext,
  family: PersistedGoalFamily | undefined,
): void {
  session.familyRecord = family;
}

/**
 * Write live free-slot values back into a MemberContext after nested helpers
 * that still close over free host state/events have run.
 */
export function syncMemberFromLiveSlots(
  member: MemberContext,
  live: { state: HypagraphState | undefined; events: DomainEvent[] },
): void {
  member.state = live.state;
  member.events = live.events;
}

/**
 * Read the working slots from a MemberContext for install into free host slots.
 * Used only as a bridge for nested helpers that are not yet context-aware.
 * MemberContext remains the authority for the dispatch outcome.
 */
export function liveSlotsFromMember(member: MemberContext): {
  state: HypagraphState | undefined;
  events: DomainEvent[];
} {
  return {
    state: member.state,
    events: member.events,
  };
}

/**
 * True when session and branch generations still match the capture taken at
 * non-root bind or dispatch entry.
 */
export function sessionGenerationsMatch(input: {
  bindSessionGeneration: number;
  bindBranchGeneration: number;
  currentSessionGeneration: number;
  currentBranchGeneration: number;
}): boolean {
  return input.bindSessionGeneration === input.currentSessionGeneration
    && input.bindBranchGeneration === input.currentBranchGeneration;
}

/**
 * Whether non-root finally may persist member updates and R5 root merge.
 *
 * When restore advances generations mid-dispatch, skip persist so pre-bind
 * family and liveRoot capture do not rewrite the restored family bag.
 */
export function shouldPersistNonRootMemberAfterBind(input: {
  bindSessionGeneration: number;
  bindBranchGeneration: number;
  currentSessionGeneration: number;
  currentBranchGeneration: number;
  memberWorkflowId: string;
  memberState: HypagraphState | undefined;
}): boolean {
  if (!sessionGenerationsMatch(input)) return false;
  if (!input.memberState) return false;
  return input.memberState.workflowId === input.memberWorkflowId;
}

/**
 * Pure release rules for the temporary free-slot bind.
 *
 * - Sync free slots into the member only when free state still belongs to the
 *   member workflow (identity guard).
 * - Restore the pre-bind root only when session and branch generations still
 *   match the bind capture. When restore advanced generations, leave free
 *   slots as they are so post-restore root is not clobbered.
 */
export function resolveLiveSlotRelease(
  input: ResolveLiveSlotReleaseInput,
): ResolveLiveSlotReleaseResult {
  const syncedMemberFromLive = input.freeState?.workflowId === input.memberWorkflowId;
  const nextMemberState = syncedMemberFromLive ? input.freeState : input.memberState;
  const nextMemberEvents = syncedMemberFromLive ? input.freeEvents : input.memberEvents;

  const generationsMatch = sessionGenerationsMatch({
    bindSessionGeneration: input.bindSessionGeneration,
    bindBranchGeneration: input.bindBranchGeneration,
    currentSessionGeneration: input.currentSessionGeneration,
    currentBranchGeneration: input.currentBranchGeneration,
  });

  if (generationsMatch) {
    return {
      nextMemberState,
      nextMemberEvents,
      nextFreeState: input.savedRootState,
      nextFreeEvents: input.savedRootEvents,
      restoredSavedRoot: true,
      syncedMemberFromLive,
    };
  }

  return {
    nextMemberState,
    nextMemberEvents,
    nextFreeState: input.freeState,
    nextFreeEvents: input.freeEvents,
    restoredSavedRoot: false,
    syncedMemberFromLive,
  };
}
