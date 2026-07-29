/**
 * Product-path helpers for family UI projection.
 *
 * These pure helpers sit between session family records and status/graph surfaces.
 * They do not append session entries and do not migrate roots.
 */

import type { GoalFamilyRuntime } from "../domain/goal-family.js";
import type { HypagraphState } from "../domain/model.js";
import {
  projectFamilyGraphView,
  type FamilyExecutorHostSnapshot,
  type FamilyGraphViewModel,
} from "../graph/family-projection.js";
import type { PersistedGoalFamily } from "../persistence/family-store.js";

/**
 * True when the live workflow goal is a member of the family with a matching workflow ID.
 * After root replacement, a previous family record does not match the new root.
 */
export function liveStateMatchesFamilyMember(
  family: GoalFamilyRuntime,
  liveState: HypagraphState,
): boolean {
  const goalId = liveState.goal?.goalId;
  if (!goalId) return false;
  const member = family.members[goalId];
  if (!member) return false;
  if (member.workflowId !== liveState.workflowId) return false;
  if (liveState.goal?.workflowId !== member.workflowId) return false;
  return true;
}

/**
 * True when a persisted family record belongs to the live session goal/workflow.
 * Prefer this before paint projection so a replaced root does not show the old family.
 */
export function familyRecordMatchesLiveState(
  familyRecord: PersistedGoalFamily,
  liveState: HypagraphState,
): boolean {
  return liveStateMatchesFamilyMember(familyRecord.familySnapshot, liveState);
}

/**
 * Build member workflow states for family projection.
 * Prefer the live session workflow when it matches a family member.
 */
export function memberStatesForFamilyProjection(
  familyRecord: PersistedGoalFamily,
  liveState?: HypagraphState,
): Record<string, HypagraphState> {
  const memberStates: Record<string, HypagraphState> = {};
  for (const member of Object.values(familyRecord.familySnapshot.members)) {
    const stored = familyRecord.workflows[member.workflowId];
    if (stored) memberStates[member.goalId] = stored.snapshot;
  }
  if (liveState?.goal) {
    const goalId = liveState.goal.goalId;
    if (familyRecord.familySnapshot.members[goalId]) {
      memberStates[goalId] = liveState;
    }
  }
  return memberStates;
}

/**
 * Project family UI from a persisted family record and optional live state.
 * Returns undefined when the live goal is not a member of the family.
 */
export function projectProductFamilyView(
  familyRecord: PersistedGoalFamily,
  liveState: HypagraphState | undefined,
  executorHost?: FamilyExecutorHostSnapshot,
  expandedGoalIds?: ReadonlySet<string> | readonly string[],
): FamilyGraphViewModel | undefined {
  if (liveState && !familyRecordMatchesLiveState(familyRecord, liveState)) {
    return undefined;
  }
  return projectFamilyGraphView({
    family: familyRecord.familySnapshot,
    memberStates: memberStatesForFamilyProjection(familyRecord, liveState),
    ...(liveState?.goal?.goalId === undefined ? {} : { focusedGoalId: liveState.goal.goalId }),
    ...(expandedGoalIds === undefined ? {} : { expandedGoalIds }),
    ...(executorHost === undefined ? {} : { executorHost }),
  });
}
