/**
 * Product-path helpers for family-aware controller selection (Wave F2).
 *
 * Pure selection uses selectFamilySchedulerAction. Host I/O stays in extension.ts.
 * Sequential multi-member dispatch is the F2 product default.
 */

import {
  selectFamilySchedulerAction,
  type FamilyRunnableCandidate,
  type FamilySchedulerDecision,
} from "../domain/family-scheduler.js";
import type { GoalFamilyRuntime } from "../domain/goal-family.js";
import {
  isDispatchableGoalContinuation,
  selectGoalContinuation,
  type GoalDispatchableContinuation,
} from "../domain/goal-continuation.js";
import type { DomainEvent, HypagraphState } from "../domain/model.js";
import type { PersistedGoalFamily } from "../persistence/family-store.js";
import { memberStatesForFamilyProjection } from "../ui/family-product.js";

/**
 * Controller selection for one sequential family or root pass.
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
  };

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
 * Multi-member families use sequential selectFamilySchedulerAction.
 */
export function selectFamilyProductControllerAction(input: {
  liveState: HypagraphState;
  familyRecord: PersistedGoalFamily | undefined;
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
  const familyDecision = selectFamilySchedulerAction(
    familyRecord.familySnapshot,
    memberStates,
  );

  return mapFamilySchedulerDecision(familyDecision, familyRecord, memberStates, liveState);
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
