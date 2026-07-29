import {
  createBoundedChildGoal,
  type CreateBoundedChildGoalInput,
} from "../domain/child-goal-creation.js";
import {
  returnChildGoal,
  type ReturnChildGoalInput,
} from "../domain/child-goal-return.js";
import type {
  Diagnostic,
  HypagraphDefinition,
  PersistedHypagraph,
} from "../domain/model.js";
import type { PiSessionEntryAppender } from "./pi-session-store.js";
import {
  HYPAGRAPH_FAMILY_RECORD_TYPE,
  assertPersistedGoalFamilyShape,
  commitBoundedChildGoalToPersistedFamily,
  commitChildReturnToPersistedFamily,
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

/**
 * Input for product-path bounded child creation against a persisted family.
 * Pure identities and timestamps are caller-supplied.
 */
export type CreateBoundedChildGoalInFamilyInput = Omit<
  CreateBoundedChildGoalInput,
  "family" | "parentState"
> & {
  family: PersistedGoalFamily;
  parentGoalId: string;
};

export type CreateBoundedChildGoalInFamilyResult =
  | { ok: true; family: PersistedGoalFamily }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Create a bounded child goal on a persisted family record.
 *
 * Loads the parent workflow from the family record, runs createBoundedChildGoal,
 * and commits family plus workflow streams through commitBoundedChildGoalToPersistedFamily.
 * The input family record is not mutated.
 * Child return handling is out of scope for this path.
 *
 * Pi tool surface wiring waits for a later M7 slice. Controllers and tests use this API.
 */
export function createBoundedChildGoalInFamily(
  input: CreateBoundedChildGoalInFamilyInput,
): CreateBoundedChildGoalInFamilyResult {
  const parentMember = input.family.familySnapshot.members[input.parentGoalId];
  if (!parentMember) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_parent_missing",
        message: `Goal family '${input.family.familySnapshot.familyId}' does not contain parent goal `
          + `'${input.parentGoalId}'.`,
        location: "parentGoalId",
      }],
    };
  }

  const parentWorkflow = input.family.workflows[parentMember.workflowId];
  if (!parentWorkflow) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_member_workflow_missing",
        message: `Goal family '${input.family.familySnapshot.familyId}' parent '${input.parentGoalId}' `
          + `references missing workflow '${parentMember.workflowId}'.`,
        location: "parentGoalId",
      }],
    };
  }

  const creation = createBoundedChildGoal({
    family: input.family.familySnapshot,
    parentState: parentWorkflow.snapshot,
    parentNodeId: input.parentNodeId,
    childDefinition: input.childDefinition,
    childGoalId: input.childGoalId,
    childWorkflowId: input.childWorkflowId,
    bindingId: input.bindingId,
    at: input.at,
    scopePaths: input.scopePaths,
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    ...(input.failurePolicy !== undefined ? { failurePolicy: input.failurePolicy } : {}),
    ...(input.inputFacts !== undefined ? { inputFacts: input.inputFacts } : {}),
    ...(input.outputFacts !== undefined ? { outputFacts: input.outputFacts } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    ...(input.familyEventId !== undefined ? { familyEventId: input.familyEventId } : {}),
    ...(input.parentCommandId !== undefined ? { parentCommandId: input.parentCommandId } : {}),
  });
  if (!creation.ok) return { ok: false, diagnostics: creation.diagnostics };

  try {
    const committed = commitBoundedChildGoalToPersistedFamily(input.family, creation);
    return { ok: true, family: committed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "goal_family_child_commit_failed";
    return {
      ok: false,
      diagnostics: [{ code, message }],
    };
  }
}

/**
 * Input for product-path child return against a persisted family.
 * Pure identities and timestamps are caller-supplied.
 */
export type ReturnChildGoalInFamilyInput = Omit<
  ReturnChildGoalInput,
  "family" | "parentState" | "childState"
> & {
  family: PersistedGoalFamily;
  parentGoalId: string;
};

export type ReturnChildGoalInFamilyResult =
  | { ok: true; family: PersistedGoalFamily }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Record a child terminal return on a persisted family record.
 *
 * Loads the parent and child workflows from the family record, requires the
 * child goal status to match the reported outcome, runs returnChildGoal, and
 * commits family plus parent workflow streams through commitChildReturnToPersistedFamily.
 * The input family record is not mutated.
 *
 * Pi tool surface wiring waits for a later M7 slice. Controllers and tests use this API.
 */
export function returnChildGoalInFamily(
  input: ReturnChildGoalInFamilyInput,
): ReturnChildGoalInFamilyResult {
  const parentMember = input.family.familySnapshot.members[input.parentGoalId];
  if (!parentMember) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_parent_missing",
        message: `Goal family '${input.family.familySnapshot.familyId}' does not contain parent goal `
          + `'${input.parentGoalId}'.`,
        location: "parentGoalId",
      }],
    };
  }

  const parentWorkflow = input.family.workflows[parentMember.workflowId];
  if (!parentWorkflow) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_member_workflow_missing",
        message: `Goal family '${input.family.familySnapshot.familyId}' parent '${input.parentGoalId}' `
          + `references missing workflow '${parentMember.workflowId}'.`,
        location: "parentGoalId",
      }],
    };
  }

  const binding = input.family.familySnapshot.bindings[input.bindingId];
  if (!binding) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_binding_missing",
        message: `Goal family '${input.family.familySnapshot.familyId}' has no binding `
          + `'${input.bindingId}'.`,
        location: "bindingId",
      }],
    };
  }

  const childMember = input.family.familySnapshot.members[binding.childGoalId];
  if (!childMember) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_binding_child_missing",
        message: `Binding '${input.bindingId}' references missing child member `
          + `'${binding.childGoalId}'.`,
        location: "bindingId",
      }],
    };
  }

  const childWorkflow = input.family.workflows[childMember.workflowId];
  if (!childWorkflow) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_member_workflow_missing",
        message: `Goal family '${input.family.familySnapshot.familyId}' child '${binding.childGoalId}' `
          + `references missing workflow '${childMember.workflowId}'.`,
        location: "binding.childGoalId",
      }],
    };
  }

  const returned = returnChildGoal({
    family: input.family.familySnapshot,
    parentState: parentWorkflow.snapshot,
    childState: childWorkflow.snapshot,
    bindingId: input.bindingId,
    at: input.at,
    outcome: input.outcome,
    ...(input.facts !== undefined ? { facts: input.facts } : {}),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    ...(input.familyEventId !== undefined ? { familyEventId: input.familyEventId } : {}),
    ...(input.parentCommandId !== undefined ? { parentCommandId: input.parentCommandId } : {}),
  });
  if (!returned.ok) return { ok: false, diagnostics: returned.diagnostics };

  try {
    const committed = commitChildReturnToPersistedFamily(input.family, returned);
    return { ok: true, family: committed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "goal_family_child_return_commit_failed";
    return {
      ok: false,
      diagnostics: [{ code, message }],
    };
  }
}

/** Re-export for product callers that assemble child definitions. */
export type { HypagraphDefinition };
