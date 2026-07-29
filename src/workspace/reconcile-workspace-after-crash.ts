/**
 * Host glue for workspace crash recovery after restore (M8-s10).
 *
 * Pure domain planning and apply live in workspace-crash-recovery.
 * This module composes process-liveness and orphan attempt inputs into that
 * pure entry point. It does not call git, kill processes, or touch the clock.
 *
 * Product restore controller contract (four steps):
 * 1. Run isolated Pi teardownOnRestore / orphan reconciliation.
 * 2. Build liveAttemptIds from remaining live process records (and orphan ids).
 * 3. Call reconcileWorkspaceAfterCrash with every workspace set the controller
 *    owns (lease required; integration, worktree, concurrency, group when held).
 * 4. Apply returned hostActions (disk worktree release, integrate resume).
 *    Assign only result fields that were supplied on input. Omitted sets are
 *    not returned and must not overwrite real in-memory state.
 *
 * Extension restore does not yet own session-scoped workspace sets. Controllers
 * that hold those sets must call this API. See the m8-s10 controller contract
 * test for the four-step composition.
 */

import {
  applyWorkspaceCrashRecovery,
  excludeOrphanAttemptIds,
  liveAttemptIdsFromLiveness,
  type WorkspaceCrashRecoveryApplyResult,
  type WorkspaceCrashRecoveryInput,
} from "../domain/workspace-crash-recovery.js";

/**
 * Optional process liveness rows for composition with pure recovery.
 * attemptId must match WorkspaceLeaseHolder.attemptId.
 */
export interface WorkspaceProcessLivenessRow {
  attemptId: string;
  live: boolean;
}

/**
 * Host input for reconcile after crash.
 * Either liveAttemptIds or processLiveness may be supplied.
 * orphanAttemptIds are always treated as dead (removed from live).
 */
export interface ReconcileWorkspaceAfterCrashInput
  extends Omit<WorkspaceCrashRecoveryInput, "liveAttemptIds"> {
  /**
   * Explicit live attempt ids. When omitted, processLiveness is used.
   * When both are omitted, every known holder is recovered as dead.
   */
  liveAttemptIds?: readonly string[];
  /**
   * Process liveness rows from the host registry or a test mock.
   * Used when liveAttemptIds is omitted.
   */
  processLiveness?: readonly WorkspaceProcessLivenessRow[];
  /**
   * Attempt ids from orphan reconciliation (dead child processes).
   * Always excluded from the live set.
   */
  orphanAttemptIds?: readonly string[];
}

/**
 * Resolve live attempt ids from host process inputs.
 * orphanAttemptIds win over live listings. Does not mutate inputs.
 */
export function resolveLiveAttemptIdsForCrashRecovery(input: {
  liveAttemptIds?: readonly string[];
  processLiveness?: readonly WorkspaceProcessLivenessRow[];
  orphanAttemptIds?: readonly string[];
}): string[] {
  let live: string[];
  if (input.liveAttemptIds !== undefined) {
    live = input.liveAttemptIds
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
  } else if (input.processLiveness !== undefined) {
    live = liveAttemptIdsFromLiveness(input.processLiveness);
  } else {
    live = [];
  }
  return excludeOrphanAttemptIds(live, input.orphanAttemptIds ?? []);
}

/**
 * Reconcile workspace leases, integrations, worktrees, and concurrency after
 * crash recovery. Pure domain apply; host supplies liveness composition only.
 * Does not mutate inputs. Does not perform process teardown or git I/O.
 */
export function reconcileWorkspaceAfterCrash(
  input: ReconcileWorkspaceAfterCrashInput,
): WorkspaceCrashRecoveryApplyResult {
  const livenessInput: {
    liveAttemptIds?: readonly string[];
    processLiveness?: readonly WorkspaceProcessLivenessRow[];
    orphanAttemptIds?: readonly string[];
  } = {};
  if (input.liveAttemptIds !== undefined) {
    livenessInput.liveAttemptIds = input.liveAttemptIds;
  }
  if (input.processLiveness !== undefined) {
    livenessInput.processLiveness = input.processLiveness;
  }
  if (input.orphanAttemptIds !== undefined) {
    livenessInput.orphanAttemptIds = input.orphanAttemptIds;
  }
  const liveAttemptIds = resolveLiveAttemptIdsForCrashRecovery(livenessInput);

  const domainInput: WorkspaceCrashRecoveryInput = {
    schemaVersion: input.schemaVersion,
    leaseSet: input.leaseSet,
    liveAttemptIds,
  };
  if (input.integrationSet !== undefined) {
    domainInput.integrationSet = input.integrationSet;
  }
  if (input.worktreeSet !== undefined) {
    domainInput.worktreeSet = input.worktreeSet;
  }
  if (input.concurrencyState !== undefined) {
    domainInput.concurrencyState = input.concurrencyState;
  }
  if (input.groupState !== undefined) {
    domainInput.groupState = input.groupState;
  }
  if (input.cancelledAttemptIds !== undefined) {
    domainInput.cancelledAttemptIds = input.cancelledAttemptIds;
  }
  if (input.resumeLiveIntegrating !== undefined) {
    domainInput.resumeLiveIntegrating = input.resumeLiveIntegrating;
  }
  if (input.resumeLiveChecking !== undefined) {
    domainInput.resumeLiveChecking = input.resumeLiveChecking;
  }

  return applyWorkspaceCrashRecovery(domainInput);
}
