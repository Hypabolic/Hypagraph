/**
 * Product-path helpers for family-aware controller selection (Wave F2 / Gate 1.1).
 *
 * Pure selection uses sequential or concurrent family schedulers.
 * Host I/O stays in extension.ts and family-controller-host.ts.
 * Concurrent multi-pending is the default when policy allows (maxBatchSize > 1).
 * Sequential remains when concurrent mode is off or maxBatchSize is 1.
 */

import {
  commitFamilyConcurrentBatch,
  commitFamilySelection,
  selectFamilyConcurrentActions,
  selectFamilySchedulerAction,
  type FamilyConcurrentCommitResult,
  type FamilyRunnableCandidate,
  type FamilySchedulerCommitResult,
  type FamilySchedulerDecision,
} from "../domain/family-scheduler.js";
import {
  hasAnyPendingDispatch,
  type GoalFamilyRuntime,
} from "../domain/goal-family.js";
import {
  isDispatchableGoalContinuation,
  selectGoalContinuation,
  type GoalDispatchableContinuation,
} from "../domain/goal-continuation.js";
import type { DomainEvent, HypagraphState } from "../domain/model.js";
import type { PersistedGoalFamily } from "../persistence/family-store.js";
import { memberStatesForFamilyProjection } from "../ui/family-product.js";

/**
 * Product concurrency policy for multi-member family selection.
 */
export interface FamilyProductConcurrencyPolicy {
  /**
   * When true, use concurrent batch selection for multi-member families.
   * Default is true.
   */
  concurrent?: boolean;
  /**
   * Maximum members to select and commit in one batch.
   * Default is 2. When 1, sequential selection is used.
   */
  maxBatchSize?: number;
}

/**
 * One dispatchable member selection inside a concurrent product batch.
 */
export interface FamilyProductDispatchItem {
  memberGoalId: string;
  memberWorkflowId: string;
  memberState: HypagraphState;
  isLiveRoot: boolean;
  decision: GoalDispatchableContinuation;
  /** Family dispatch id when the host already committed multi-pending. */
  dispatchId?: string;
  selectionReason: string;
}

/**
 * Controller selection for one family or root pass.
 */
export type FamilyProductControllerDecision =
  | {
    kind: "dispatch";
    /** Live root goal id when the selected member is the session root. */
    memberGoalId: string;
    memberWorkflowId: string;
    memberState: HypagraphState;
    /** True when memberState is the live session root workflow. */
    isLiveRoot: boolean;
    decision: GoalDispatchableContinuation;
    family: PersistedGoalFamily;
    selectionReason: string;
  }
  | {
    kind: "dispatch-batch";
    items: FamilyProductDispatchItem[];
    family: PersistedGoalFamily;
    selectionReason: string;
    maxBatchSize: number;
  }
  | {
    kind: "root-only";
    decision: ReturnType<typeof selectGoalContinuation>;
  }
  | {
    kind: "family-idle";
    reason: string;
    family: PersistedGoalFamily;
  }
  | {
    kind: "family-blocked";
    reason: string;
    family: PersistedGoalFamily;
    dispatchId?: string;
  }
  | {
    kind: "family-incomplete";
    reason: string;
    missingGoalIds: string[];
    mismatchedGoalIds: string[];
    family: PersistedGoalFamily;
  }
  | {
    kind: "family-rejected";
    reason: string;
    family: PersistedGoalFamily;
    diagnostics: { code: string; message: string; location?: string }[];
  };

/**
 * Resolve product concurrency policy with defaults.
 * Concurrent is on when concurrent is not false and maxBatchSize is greater than 1.
 */
export function resolveFamilyProductConcurrencyPolicy(
  policy?: FamilyProductConcurrencyPolicy,
): { concurrent: boolean; maxBatchSize: number } {
  const maxBatchSize = policy?.maxBatchSize !== undefined
    ? policy.maxBatchSize
    : 2;
  const concurrent = policy?.concurrent !== false && maxBatchSize > 1;
  return {
    concurrent,
    maxBatchSize: maxBatchSize < 1 ? 1 : maxBatchSize,
  };
}

/**
 * Lift a family preferred candidate into a GoalDispatchableContinuation for host dispatch.
 * Sequence and snapshot hash come from the member state at selection time.
 */
export function dispatchableFromFamilyCandidate(
  candidate: FamilyRunnableCandidate,
  memberState: HypagraphState,
): GoalDispatchableContinuation | undefined {
  if (memberState.workflowId !== candidate.workflowId) return undefined;
  if (memberState.goal?.goalId !== candidate.goalId) return undefined;
  if (memberState.revision !== candidate.revision) return undefined;
  if (memberState.sequence !== candidate.selectedSequence) return undefined;
  if (memberState.snapshotHash !== candidate.selectedSnapshotHash) return undefined;

  const identity = {
    goalId: candidate.goalId,
    workflowId: candidate.workflowId,
    revision: candidate.revision,
    sequence: candidate.selectedSequence,
    snapshotHash: candidate.selectedSnapshotHash,
    continuationOrdinal: candidate.memberContinuationOrdinal,
  };

  if (candidate.action.kind === "request-revision") {
    // Family preferred enumeration only lifts dispatchable member selections.
    // request-revision is dispatchable; action payload is on the member decision path.
    return undefined;
  }

  return {
    ...identity,
    kind: candidate.action.kind,
    nodeId: candidate.action.nodeId,
    ...(candidate.action.loopId !== undefined ? { loopId: candidate.action.loopId } : {}),
  } as GoalDispatchableContinuation;
}

/**
 * Build member states for controller selection.
 * Prefer live root state when it matches a family member.
 */
export function buildFamilyControllerMemberStates(
  familyRecord: PersistedGoalFamily,
  liveState: HypagraphState | undefined,
): Record<string, HypagraphState> {
  return memberStatesForFamilyProjection(familyRecord, liveState);
}

/**
 * Select the next product controller action.
 *
 * One-member families and missing family records keep the root-only path.
 * Multi-member families use concurrent batch selection when policy allows.
 * Sequential selection remains when concurrent mode is off or maxBatchSize is 1.
 */
export function selectFamilyProductControllerAction(input: {
  liveState: HypagraphState;
  familyRecord: PersistedGoalFamily | undefined;
  concurrencyPolicy?: FamilyProductConcurrencyPolicy;
}): FamilyProductControllerDecision {
  const { liveState, familyRecord } = input;
  if (!familyRecord) {
    return { kind: "root-only", decision: selectGoalContinuation(liveState) };
  }

  const memberCount = Object.keys(familyRecord.familySnapshot.members).length;
  if (memberCount <= 1) {
    return { kind: "root-only", decision: selectGoalContinuation(liveState) };
  }

  // Keep live parent stream authoritative inside the family map.
  const memberStates = buildFamilyControllerMemberStates(familyRecord, liveState);
  const policy = resolveFamilyProductConcurrencyPolicy(input.concurrencyPolicy);

  if (!policy.concurrent || policy.maxBatchSize <= 1) {
    const familyDecision = selectFamilySchedulerAction(
      familyRecord.familySnapshot,
      memberStates,
    );
    return mapFamilySchedulerDecision(familyDecision, familyRecord, memberStates, liveState);
  }

  return mapConcurrentProductDecision(
    familyRecord,
    memberStates,
    liveState,
    policy.maxBatchSize,
  );
}

function mapConcurrentProductDecision(
  familyRecord: PersistedGoalFamily,
  memberStates: Readonly<Record<string, HypagraphState>>,
  liveState: HypagraphState,
  maxBatchSize: number,
): FamilyProductControllerDecision {
  const concurrentDecision = selectFamilyConcurrentActions({
    family: familyRecord.familySnapshot,
    memberStates,
    maxBatchSize,
    treatPendingAsOccupancy: true,
  });

  if (concurrentDecision.kind === "incomplete-input") {
    return {
      kind: "family-incomplete",
      reason: concurrentDecision.reason,
      missingGoalIds: concurrentDecision.missingGoalIds,
      mismatchedGoalIds: concurrentDecision.mismatchedGoalIds,
      family: familyRecord,
    };
  }
  if (concurrentDecision.kind === "rejected") {
    return {
      kind: "family-rejected",
      reason: concurrentDecision.reason,
      family: familyRecord,
      diagnostics: concurrentDecision.diagnostics,
    };
  }
  if (concurrentDecision.kind === "idle") {
    // When capacity is full of pendings, surface blocked so the host waits for settle.
    if (hasAnyPendingDispatch(familyRecord.familySnapshot)) {
      return {
        kind: "family-blocked",
        reason:
          concurrentDecision.reason
          + " Existing pending dispatches occupy concurrent capacity.",
        family: familyRecord,
      };
    }
    return {
      kind: "family-idle",
      reason: concurrentDecision.reason,
      family: familyRecord,
    };
  }

  // concurrentDecision.kind === "select-batch"
  const items: FamilyProductDispatchItem[] = [];
  for (const candidate of concurrentDecision.candidates) {
    const memberState = memberStates[candidate.goalId];
    if (!memberState) {
      return {
        kind: "family-incomplete",
        reason: `Selected member '${candidate.goalId}' has no member state.`,
        missingGoalIds: [candidate.goalId],
        mismatchedGoalIds: [],
        family: familyRecord,
      };
    }
    const memberDecision = selectGoalContinuation(memberState);
    if (!isDispatchableGoalContinuation(memberDecision)) {
      return {
        kind: "family-idle",
        reason:
          `Family selected member '${candidate.goalId}' but the member has no dispatchable continuation `
          + `(${memberDecision.kind}).`,
        family: familyRecord,
      };
    }
    const liveGoalId = liveState.goal?.goalId;
    const isLiveRoot = liveGoalId === candidate.goalId
      && liveState.workflowId === candidate.workflowId;
    items.push({
      memberGoalId: candidate.goalId,
      memberWorkflowId: candidate.workflowId,
      memberState: isLiveRoot ? liveState : memberState,
      isLiveRoot,
      decision: memberDecision,
      selectionReason: concurrentDecision.reason,
    });
  }

  if (items.length === 0) {
    return {
      kind: "family-idle",
      reason: concurrentDecision.reason,
      family: familyRecord,
    };
  }

  // Keep concurrent commit mode for length-1 batches. Do not collapse to sequential
  // dispatch; sequential commit blocks while any other pending exists.
  return {
    kind: "dispatch-batch",
    items,
    family: familyRecord,
    selectionReason: concurrentDecision.reason,
    maxBatchSize,
  };
}

function mapFamilySchedulerDecision(
  familyDecision: FamilySchedulerDecision,
  familyRecord: PersistedGoalFamily,
  memberStates: Readonly<Record<string, HypagraphState>>,
  liveState: HypagraphState,
): FamilyProductControllerDecision {
  if (familyDecision.kind === "idle") {
    return {
      kind: "family-idle",
      reason: familyDecision.reason,
      family: familyRecord,
    };
  }
  if (familyDecision.kind === "blocked-pending") {
    return {
      kind: "family-blocked",
      reason: familyDecision.reason,
      family: familyRecord,
      dispatchId: familyDecision.dispatchId,
    };
  }
  if (familyDecision.kind === "incomplete-input") {
    return {
      kind: "family-incomplete",
      reason: familyDecision.reason,
      missingGoalIds: familyDecision.missingGoalIds,
      mismatchedGoalIds: familyDecision.mismatchedGoalIds,
      family: familyRecord,
    };
  }

  const candidate = familyDecision.candidate;
  const memberState = memberStates[candidate.goalId];
  if (!memberState) {
    return {
      kind: "family-incomplete",
      reason: `Selected member '${candidate.goalId}' has no member state.`,
      missingGoalIds: [candidate.goalId],
      mismatchedGoalIds: [],
      family: familyRecord,
    };
  }

  // Re-run member select so revision actions and full identity match host dispatch helpers.
  const memberDecision = selectGoalContinuation(memberState);
  if (!isDispatchableGoalContinuation(memberDecision)) {
    return {
      kind: "family-idle",
      reason:
        `Family selected member '${candidate.goalId}' but the member has no dispatchable continuation `
        + `(${memberDecision.kind}).`,
      family: familyRecord,
    };
  }

  const liveGoalId = liveState.goal?.goalId;
  const isLiveRoot = liveGoalId === candidate.goalId
    && liveState.workflowId === candidate.workflowId;

  return {
    kind: "dispatch",
    memberGoalId: candidate.goalId,
    memberWorkflowId: candidate.workflowId,
    memberState: isLiveRoot ? liveState : memberState,
    isLiveRoot,
    decision: memberDecision,
    family: familyRecord,
    selectionReason: familyDecision.reason,
  };
}

/**
 * Commit a concurrent product batch into multi-pending family state.
 * Pure domain call. Host persists the returned family snapshot and events.
 */
export function commitFamilyProductConcurrentBatch(input: {
  family: GoalFamilyRuntime;
  memberStates: Readonly<Record<string, HypagraphState>>;
  at: string;
  dispatchIds: string[];
  maxBatchSize?: number;
}): FamilyConcurrentCommitResult {
  const batchInput: Parameters<typeof commitFamilyConcurrentBatch>[0] = {
    family: input.family,
    memberStates: input.memberStates,
    at: input.at,
    dispatchIds: input.dispatchIds,
    treatPendingAsOccupancy: true,
  };
  if (input.maxBatchSize !== undefined) batchInput.maxBatchSize = input.maxBatchSize;
  return commitFamilyConcurrentBatch(batchInput);
}

/**
 * Commit one sequential product selection into family pending state.
 */
export function commitFamilyProductSelection(input: {
  family: GoalFamilyRuntime;
  memberStates: Readonly<Record<string, HypagraphState>>;
  at: string;
  dispatchId: string;
}): FamilySchedulerCommitResult {
  return commitFamilySelection(input);
}

/**
 * Replace one member workflow stream inside a persisted family record.
 * Does not mutate the input family. Caller appends the result to the session.
 */
export function replaceFamilyMemberWorkflow(
  family: PersistedGoalFamily,
  workflowId: string,
  next: { events: DomainEvent[]; snapshot: HypagraphState },
): PersistedGoalFamily {
  return {
    schemaVersion: family.schemaVersion,
    familyEvents: structuredClone(family.familyEvents),
    familySnapshot: structuredClone(family.familySnapshot),
    workflows: {
      ...structuredClone(family.workflows),
      [workflowId]: {
        events: structuredClone(next.events),
        snapshot: structuredClone(next.snapshot),
      },
    },
  };
}

/**
 * Merge the current live root events and snapshot into the family record.
 * Used before child workflow replace so sibling root progress is not overwritten (R5).
 * Does not mutate the input family.
 */
export function mergeLiveRootIntoFamily(
  family: PersistedGoalFamily,
  liveRoot: { workflowId: string; events: DomainEvent[]; snapshot: HypagraphState },
): PersistedGoalFamily {
  return {
    schemaVersion: family.schemaVersion,
    familyEvents: structuredClone(family.familyEvents),
    familySnapshot: structuredClone(family.familySnapshot),
    workflows: {
      ...structuredClone(family.workflows),
      [liveRoot.workflowId]: {
        events: structuredClone(liveRoot.events),
        snapshot: structuredClone(liveRoot.snapshot),
      },
    },
  };
}

/**
 * True when the family runtime has more than one member.
 */
export function familyHasMultipleMembers(family: GoalFamilyRuntime): boolean {
  return Object.keys(family.members).length > 1;
}
