import type { PersistedHypagraph } from "../domain/model.js";
import type { PiSessionEntryAppender } from "./pi-session-store.js";
import {
  HYPAGRAPH_FAMILY_RECORD_TYPE,
  assertPersistedGoalFamilyShape,
  defaultOneMemberFamilyId,
  migrateRootWorkflowToOneMemberFamily,
  restorePersistedGoalFamily,
  type PersistedGoalFamily,
} from "./family-store.js";
import { restoreLatestSession } from "./session-rebuild.js";

interface CustomEntry {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface RestoreOrMigrateOneMemberFamilyResult {
  family: PersistedGoalFamily;
  /** True when the family was built by migrating a root workflow. False when a family custom entry was restored. */
  migrated: boolean;
}

export interface RestoreOrMigrateOneMemberFamilyOptions {
  /**
   * Optional stable family ID for migration when no family record exists.
   * When omitted, product restore uses defaultOneMemberFamilyId from root identities.
   */
  familyId?: string;
  /**
   * Optional family-created timestamp for migration.
   * When omitted, product restore uses the root goal startedAt from pure stored state.
   */
  at?: string;
}

const isCustomEntry = (entry: unknown): entry is CustomEntry => {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<CustomEntry>;
  return candidate.type === "custom" && typeof candidate.customType === "string";
};

/**
 * Restore the latest goal-family custom entry from a Pi session branch.
 * Family records are additive. This path does not rewrite workflow event batches.
 * Rejects an unsupported family schema version with a clear error.
 * Rejects a malformed record shape with a typed GoalFamilyRestoreError.
 */
export function restoreLatestFamilySession(
  entries: readonly unknown[],
): PersistedGoalFamily | undefined {
  let latest: PersistedGoalFamily | undefined;
  for (const entry of entries) {
    if (!isCustomEntry(entry) || entry.customType !== HYPAGRAPH_FAMILY_RECORD_TYPE) continue;
    assertPersistedGoalFamilyShape(entry.data);
    latest = restorePersistedGoalFamily(entry.data);
  }
  return latest;
}

/**
 * Restore a family projection from session entries, or migrate a latest root into one member.
 *
 * Prefer an explicit family custom entry when its root membership matches the latest restored root.
 * When the latest family record targets a different root, migrate the current root.
 * When no matching family record exists, migrate the latest restored root workflow that has a started goal.
 * Migration does not rewrite workflow event history or snapshot hash.
 * The returned record is not appended automatically. Call appendOneMemberFamilyRecord for an additive write.
 */
export function restoreOrMigrateOneMemberFamilySession(
  entries: readonly unknown[],
  options: RestoreOrMigrateOneMemberFamilyOptions = {},
): RestoreOrMigrateOneMemberFamilyResult | undefined {
  const root = restoreLatestSession(entries);
  const existing = restoreLatestFamilySession(entries);

  if (existing && familyMatchesRoot(existing, root)) {
    return { family: existing, migrated: false };
  }

  if (!root) return undefined;
  return migrateRestoredRootToOneMemberFamily(root, options);
}

/**
 * True when the family root membership matches the restored root workflow identities.
 */
export function familyMatchesRoot(
  family: PersistedGoalFamily,
  root: PersistedHypagraph | undefined,
): boolean {
  if (!root) return false;
  const rootGoalId = family.familySnapshot.rootGoalId;
  const rootMember = family.familySnapshot.members[rootGoalId];
  if (!rootMember) return false;
  if (root.snapshot.workflowId !== rootMember.workflowId) return false;
  if (root.snapshot.goal?.goalId !== rootGoalId) return false;
  if (root.snapshot.goal.workflowId !== rootMember.workflowId) return false;
  return true;
}

/**
 * Lift a restored root workflow into a one-member family projection.
 * Use this when restoreLatestSession returned a v0.6-style root and no matching family record exists.
 * Migration does not rewrite workflow event history or snapshot hash.
 * The input workflow object is not mutated.
 */
export function migrateRestoredRootToOneMemberFamily(
  root: PersistedHypagraph,
  options: RestoreOrMigrateOneMemberFamilyOptions = {},
): RestoreOrMigrateOneMemberFamilyResult | undefined {
  const goal = root.snapshot.goal;
  if (!goal) return undefined;

  const familyId = options.familyId
    ?? defaultOneMemberFamilyId(goal.goalId, root.snapshot.workflowId);
  const at = options.at ?? goal.startedAt;

  const family = migrateRootWorkflowToOneMemberFamily({
    familyId,
    workflow: root,
    at,
  });

  return { family, migrated: true };
}

/**
 * Append a family record as an additive Pi custom entry.
 * This never rewrites prior workflow event batches.
 */
export function appendOneMemberFamilyRecord(
  appender: PiSessionEntryAppender,
  family: PersistedGoalFamily,
): void {
  const restored = restorePersistedGoalFamily(family);
  appender.appendEntry(HYPAGRAPH_FAMILY_RECORD_TYPE, restored);
}
