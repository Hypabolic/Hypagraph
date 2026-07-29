/**
 * Pure workspace crash recovery and stale integration rejection (M8-s10).
 *
 * After host restore, the controller reconciles workspace leases, worktrees,
 * integrations, and concurrency occupancy against attempt liveness. Dead or
 * orphaned holders release leases and concurrency slots. In-flight integrate
 * and check statuses never become success without evidence.
 *
 * Stale success results for cancelled, aborted, failed, or identity-mismatched
 * records are rejected and must not change current state.
 *
 * Domain helpers are pure: no clock, random, files, network, or input mutation.
 * The recovery plan type carries schemaVersion for future persistence.
 * Host I/O (process liveness, git worktree disk cleanup, isolated Pi teardown)
 * stays outside this module.
 */

import {
  CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
  createEmptyConcurrencyGroupState,
  releaseGroupAttempt,
  validateConcurrencyGroupStateSchema,
  type ConcurrencyGroupState,
} from "./concurrency-groups.js";
import {
  CONCURRENCY_STATE_SCHEMA_VERSION,
  createEmptyConcurrencyState,
  releaseAttempt,
  validateConcurrencyStateSchema,
  type ConcurrencyState,
} from "./concurrency-limits.js";
import type { Diagnostic } from "./model.js";
import {
  parseWorkerCommitResult,
  type WorkerCommitResult,
} from "./workspace-commit.js";
import {
  WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION,
  createEmptyWorkspaceIntegrationSet,
  markIntegrationAborted,
  markIntegrationChecksFailed,
  markIntegrationFailed,
  validateIntegrationIdentity,
  validateWorkspaceIntegrationSet,
  type WorkspaceIntegration,
  type WorkspaceIntegrationExpectedIdentity,
  type WorkspaceIntegrationSet,
} from "./workspace-integration.js";
import {
  WORKSPACE_LEASE_SET_SCHEMA_VERSION,
  releaseWorkspaceLease,
  validateWorkspaceLeaseSetSchema,
  type WorkspaceLeaseSet,
} from "./workspace-lease.js";
import {
  WORKSPACE_WORKTREE_SET_SCHEMA_VERSION,
  createEmptyWorkspaceWorktreeSet,
  releaseWorktreeRecord,
  validateWorkspaceWorktreeSetSchema,
  type WorkspaceWorktreeSet,
} from "./workspace-worktree.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Schema version for workspace crash recovery input and plan snapshots.
 * Always 1 in this slice. Reject unsupported versions with a clear diagnostic.
 */
export const WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Host-side follow-up actions produced by recovery.
 * Pure domain never executes these. The host runs them after apply.
 */
export type WorkspaceCrashRecoveryHostActionKind =
  | "teardown_child_attempt"
  | "release_worktree_disk"
  | "resume_integrate"
  | "resume_post_integration_checks";

export interface WorkspaceCrashRecoveryHostAction {
  kind: WorkspaceCrashRecoveryHostActionKind;
  attemptId: string;
  leaseId?: string;
  worktreeId?: string;
  integrationId?: string;
  reason: string;
}

/**
 * Recovery plan describing what changed and what the host must do next.
 * Not restored from disk in this slice. schemaVersion is reserved for later
 * persistence and must be WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION when present.
 */
export interface WorkspaceCrashRecoveryPlan {
  schemaVersion: typeof WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION;
  deadAttemptIds: string[];
  liveAttemptIds: string[];
  releasedLeaseIds: string[];
  releasedWorktreeIds: string[];
  failedIntegrationIds: string[];
  checksFailedIntegrationIds: string[];
  abortedIntegrationIds: string[];
  releasedConcurrencyAttemptIds: string[];
  releasedGroupAttemptIds: string[];
  /**
   * Live integrating records left unchanged for host resume with evidence.
   * Never recorded as success without a later host integrate path.
   */
  resumeIntegrateIds: string[];
  /**
   * Live checking records left unchanged for host resume with allowResume.
   * Never recorded as checks_passed without a later host check path.
   */
  resumeCheckingIds: string[];
  hostActions: WorkspaceCrashRecoveryHostAction[];
  /** Informational diagnostics that describe recovery decisions. */
  notes: Diagnostic[];
}

/**
 * Input for pure crash recovery.
 * liveAttemptIds lists attempt holders that still have a live process.
 * Every other attempt id found in the supplied sets is treated as dead.
 */
export interface WorkspaceCrashRecoveryInput {
  schemaVersion: typeof WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION;
  leaseSet: WorkspaceLeaseSet;
  integrationSet?: WorkspaceIntegrationSet;
  worktreeSet?: WorkspaceWorktreeSet;
  concurrencyState?: ConcurrencyState;
  groupState?: ConcurrencyGroupState;
  /**
   * Attempt ids known to still be live after restore.
   * May be empty. Empty means every known holder is recovered as dead.
   */
  liveAttemptIds: readonly string[];
  /**
   * Attempt ids cancelled before or during crash recovery.
   * Pending or integrating records for these attempts become aborted.
   * Late success results for these attempts are rejected.
   */
  cancelledAttemptIds?: readonly string[];
  /**
   * When true, live integrating records stay integrating and emit
   * resume_integrate. When false (default), mark them failed so recovery
   * never invents success without an active host runner.
   */
  resumeLiveIntegrating?: boolean;
  /**
   * When true, live checking records stay checking and emit
   * resume_post_integration_checks. When false (default), mark them
   * checks_failed so recovery never invents check success.
   */
  resumeLiveChecking?: boolean;
}

/**
 * Successful recovery result.
 * leaseSet is always returned (required on input).
 * integrationSet, worktreeSet, concurrencyState, and groupState are returned
 * only when the caller supplied that set. Omitted inputs are not replaced with
 * empty sets on the result. Hosts must not assign missing result fields over
 * real in-memory state.
 */
export type WorkspaceCrashRecoveryApplyResult =
  | {
    ok: true;
    plan: WorkspaceCrashRecoveryPlan;
    leaseSet: WorkspaceLeaseSet;
    integrationSet?: WorkspaceIntegrationSet;
    worktreeSet?: WorkspaceWorktreeSet;
    concurrencyState?: ConcurrencyState;
    groupState?: ConcurrencyGroupState;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

export type WorkspaceCrashRecoveryPlanResult =
  | { ok: true; plan: WorkspaceCrashRecoveryPlan }
  | { ok: false; diagnostics: Diagnostic[] };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Accept Object.prototype and null-prototype objects only.
 * Reject arrays, Date, Map, Set, RegExp, and other class instances.
 */
const isStrictPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Locale-insensitive identity order for strings.
 * Uses UTF-16 code unit order (`<` / `>`), not localeCompare.
 */
const compareIdentityOrdinal = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const reject = (code: string, message: string, location?: string): Diagnostic => ({
  code,
  message,
  ...(location !== undefined ? { location } : {}),
});

/**
 * Build an informational recovery plan note.
 * Same Diagnostic shape as errors, but callers must treat plan.notes as
 * non-fatal decisions. Failure diagnostics use reject() only.
 */
const recoveryNote = (
  code: string,
  message: string,
  location?: string,
): Diagnostic => ({
  code,
  message,
  ...(location !== undefined ? { location } : {}),
});

function normaliseIdList(
  value: unknown,
  location: string,
  diagnostics: Diagnostic[],
): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    diagnostics.push(reject(
      "workspace_crash_recovery_invalid_attempt_ids",
      `${location} must be an array of non-empty strings.`,
      location,
    ));
    return undefined;
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  let failed = false;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isNonEmptyString(item)) {
      diagnostics.push(reject(
        "workspace_crash_recovery_invalid_attempt_ids",
        `${location} at index ${index} must be a non-empty string.`,
        `${location}[${index}]`,
      ));
      failed = true;
      continue;
    }
    const id = item.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (failed) return undefined;
  return ids.sort((left, right) => left.localeCompare(right));
}

function validateSchemaField(
  value: unknown,
  expected: number,
  code: string,
  label: string,
  location: string,
): Diagnostic[] {
  if (!isStrictPlainObject(value)) {
    return [reject(
      `${code}_not_plain_object`,
      `${label} must be a plain object.`,
      location,
    )];
  }
  if (value.schemaVersion !== expected) {
    return [reject(
      `${code}_unsupported_schema`,
      `Unsupported ${label} schema version '${String(value.schemaVersion)}'. Expected ${expected}.`,
      `${location}.schemaVersion`,
    )];
  }
  return [];
}

/**
 * Collect unique attempt ids from optional workspace coordination sets.
 * Does not mutate inputs.
 */
export function collectWorkspaceAttemptIds(input: {
  leaseSet?: WorkspaceLeaseSet;
  integrationSet?: WorkspaceIntegrationSet;
  worktreeSet?: WorkspaceWorktreeSet;
  concurrencyState?: ConcurrencyState;
  groupState?: ConcurrencyGroupState;
}): string[] {
  const ids = new Set<string>();
  if (input.leaseSet !== undefined) {
    for (const lease of input.leaseSet.leases) {
      if (isNonEmptyString(lease.holder?.attemptId)) {
        ids.add(lease.holder.attemptId.trim());
      }
    }
  }
  if (input.integrationSet !== undefined) {
    for (const integration of input.integrationSet.integrations) {
      if (isNonEmptyString(integration.holder?.attemptId)) {
        ids.add(integration.holder.attemptId.trim());
      }
    }
  }
  if (input.worktreeSet !== undefined) {
    for (const worktree of input.worktreeSet.worktrees) {
      if (isNonEmptyString(worktree.holder?.attemptId)) {
        ids.add(worktree.holder.attemptId.trim());
      }
    }
  }
  if (input.concurrencyState !== undefined) {
    for (const attempt of input.concurrencyState.attempts) {
      if (isNonEmptyString(attempt.attemptId)) {
        ids.add(attempt.attemptId.trim());
      }
    }
  }
  if (input.groupState !== undefined) {
    for (const attempt of input.groupState.attempts) {
      if (isNonEmptyString(attempt.attemptId)) {
        ids.add(attempt.attemptId.trim());
      }
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/**
 * Classify attempt ids into live and dead sets.
 * liveAttemptIds that are not present in known holders remain live for host
 * composition but do not affect set mutations. Dead = known holders not live.
 * Does not mutate inputs.
 */
export function classifyAttemptLiveness(
  knownAttemptIds: readonly string[],
  liveAttemptIds: readonly string[],
): { liveAttemptIds: string[]; deadAttemptIds: string[] } {
  const live = new Set(
    liveAttemptIds
      .filter((id): id is string => isNonEmptyString(id))
      .map((id) => id.trim()),
  );
  const deadAttemptIds = knownAttemptIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && !live.has(id))
    .sort((left, right) => left.localeCompare(right));
  const liveAttemptIdsSorted = [...live].sort((left, right) => left.localeCompare(right));
  return {
    liveAttemptIds: liveAttemptIdsSorted,
    deadAttemptIds,
  };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/**
 * Reject an unsupported crash recovery plan schema version.
 * Does not validate plan members.
 */
export function validateWorkspaceCrashRecoveryPlanSchema(
  value: unknown,
  location = "recoveryPlan",
): Diagnostic[] {
  return validateSchemaField(
    value,
    WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
    "workspace_crash_recovery_plan",
    "Workspace crash recovery plan",
    location,
  );
}

/**
 * Reject an unsupported crash recovery input schema version.
 * Does not validate nested workspace sets.
 */
export function validateWorkspaceCrashRecoveryInputSchema(
  value: unknown,
  location = "recoveryInput",
): Diagnostic[] {
  return validateSchemaField(
    value,
    WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
    "workspace_crash_recovery_input",
    "Workspace crash recovery input",
    location,
  );
}

// ---------------------------------------------------------------------------
// Stale success rejection
// ---------------------------------------------------------------------------

/**
 * Status values that must not accept a late integrate success result.
 */
const INTEGRATION_SUCCESS_BLOCKED_STATUSES = new Set<string>([
  "pending",
  "aborted",
  "failed",
  "conflicted",
  "released",
  "checks_passed",
  "checks_failed",
  "integrated",
  "checking",
]);

/**
 * Report whether an integration may accept a late integrate success transition.
 * Success is allowed only from status integrating (host path marks integrated).
 * Rejects cancelled, aborted, failed, conflicted, released, and check-phase
 * records. Optional expected identity rejects stale identity mismatches.
 * Does not mutate inputs.
 */
export function canApplyIntegrationSuccessResult(
  integration: WorkspaceIntegration,
  expected?: WorkspaceIntegrationExpectedIdentity,
): { ok: true } | { ok: false; diagnostics: Diagnostic[] } {
  if (expected !== undefined) {
    const identityDiagnostics = validateIntegrationIdentity(
      integration,
      expected,
      "integration",
    );
    if (identityDiagnostics.length > 0) {
      return { ok: false, diagnostics: identityDiagnostics };
    }
  }

  if (integration.status === "integrating") {
    return { ok: true };
  }

  if (integration.status === "integrated") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_already_integrated",
        "A late integrate success cannot change an already integrated record.",
        "integration.status",
      )],
    };
  }

  if (INTEGRATION_SUCCESS_BLOCKED_STATUSES.has(integration.status)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_stale_success",
        `A late integrate success cannot apply when status is '${integration.status}'.`,
        "integration.status",
      )],
    };
  }

  return {
    ok: false,
    diagnostics: [reject(
      "workspace_integration_stale_success",
      `A late integrate success cannot apply when status is '${integration.status}'.`,
      "integration.status",
    )],
  };
}

/**
 * Reject a late success when the holder attempt was cancelled.
 * Does not mutate inputs.
 */
export function rejectLateSuccessForCancelledAttempt(
  integration: WorkspaceIntegration,
  cancelledAttemptIds: readonly string[],
  expected?: WorkspaceIntegrationExpectedIdentity,
): Diagnostic[] {
  const cancelled = new Set(
    cancelledAttemptIds
      .filter((id): id is string => isNonEmptyString(id))
      .map((id) => id.trim()),
  );
  if (!cancelled.has(integration.holder.attemptId)) {
    return [];
  }
  const diagnostics: Diagnostic[] = [];
  if (expected !== undefined) {
    diagnostics.push(
      ...validateIntegrationIdentity(integration, expected, "integration"),
    );
  }
  diagnostics.push(reject(
    "workspace_integration_cancelled_stale_success",
    `Attempt '${integration.holder.attemptId}' was cancelled. `
      + "A late success result must not change integration state.",
    "integration.holder.attemptId",
  ));
  return diagnostics;
}

/**
 * Reject a late worker commit success for a cancelled attempt.
 * Does not mutate inputs.
 */
export function rejectLateWorkerCommitForCancelledAttempt(
  commit: WorkerCommitResult,
  cancelledAttemptIds: readonly string[],
): Diagnostic[] {
  const cancelled = new Set(
    cancelledAttemptIds
      .filter((id): id is string => isNonEmptyString(id))
      .map((id) => id.trim()),
  );
  if (!cancelled.has(commit.holder.attemptId)) {
    return [];
  }
  return [reject(
    "workspace_commit_cancelled_stale_success",
    `Attempt '${commit.holder.attemptId}' was cancelled. `
      + "A late worker commit success must not change lease or integration state.",
    "workerCommit.holder.attemptId",
  )];
}

/**
 * Guard for a host that receives an untrusted late success payload.
 * Combines cancelled-attempt rejection, identity checks, and status gates.
 * Does not mutate inputs. Never throws for shape errors.
 */
export function rejectStaleIntegrationOrCommitSuccess(input: {
  integration: WorkspaceIntegration;
  cancelledAttemptIds?: readonly string[];
  expected?: WorkspaceIntegrationExpectedIdentity;
  workerCommit?: unknown;
}): Diagnostic[] {
  const cancelled = input.cancelledAttemptIds ?? [];
  const diagnostics: Diagnostic[] = [];

  diagnostics.push(
    ...rejectLateSuccessForCancelledAttempt(
      input.integration,
      cancelled,
      input.expected,
    ),
  );
  if (diagnostics.length > 0) {
    return diagnostics;
  }

  if (input.workerCommit !== undefined) {
    const parsed = parseWorkerCommitResult(input.workerCommit, "workerCommit");
    if (!parsed.ok) {
      return parsed.diagnostics;
    }
    diagnostics.push(
      ...rejectLateWorkerCommitForCancelledAttempt(parsed.value, cancelled),
    );
    if (diagnostics.length > 0) {
      return diagnostics;
    }
  }

  const gate = canApplyIntegrationSuccessResult(
    input.integration,
    input.expected,
  );
  if (!gate.ok) {
    return gate.diagnostics;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Plan and apply
// ---------------------------------------------------------------------------

function emptyPlan(
  liveAttemptIds: string[],
  deadAttemptIds: string[],
): WorkspaceCrashRecoveryPlan {
  return {
    schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
    deadAttemptIds: [...deadAttemptIds],
    liveAttemptIds: [...liveAttemptIds],
    releasedLeaseIds: [],
    releasedWorktreeIds: [],
    failedIntegrationIds: [],
    checksFailedIntegrationIds: [],
    abortedIntegrationIds: [],
    releasedConcurrencyAttemptIds: [],
    releasedGroupAttemptIds: [],
    resumeIntegrateIds: [],
    resumeCheckingIds: [],
    hostActions: [],
    notes: [],
  };
}

function crashFailureDiagnostics(attemptId: string, phase: string): Diagnostic[] {
  return [reject(
    "workspace_crash_recovery_interrupted",
    `Crash recovery interrupted ${phase} for attempt '${attemptId}'. `
      + "No success was recorded without evidence.",
    "recovery",
  )];
}

function checksFailureDiagnostics(attemptId: string): Diagnostic[] {
  return [reject(
    "workspace_crash_recovery_checks_interrupted",
    `Crash recovery interrupted post-integration checks for attempt '${attemptId}'. `
      + "Checks did not pass. No success was recorded without evidence.",
    "recovery",
  )];
}

/**
 * Validate recovery input shape and nested set schemas.
 * Does not mutate input. Returns diagnostics without throwing.
 */
export function validateWorkspaceCrashRecoveryInput(
  value: unknown,
  location = "recoveryInput",
): Diagnostic[] {
  const schemaDiagnostics = validateWorkspaceCrashRecoveryInputSchema(value, location);
  if (schemaDiagnostics.length > 0) {
    return schemaDiagnostics;
  }
  if (!isStrictPlainObject(value)) {
    return [reject(
      "workspace_crash_recovery_input_not_plain_object",
      "Workspace crash recovery input must be a plain object.",
      location,
    )];
  }

  const diagnostics: Diagnostic[] = [];
  const record = value;

  const leaseSchema = validateWorkspaceLeaseSetSchema(
    record.leaseSet,
    `${location}.leaseSet`,
  );
  diagnostics.push(...leaseSchema);

  if (record.integrationSet !== undefined) {
    diagnostics.push(
      ...validateWorkspaceIntegrationSet(
        record.integrationSet,
        `${location}.integrationSet`,
      ),
    );
  }

  if (record.worktreeSet !== undefined) {
    diagnostics.push(
      ...validateWorkspaceWorktreeSetSchema(
        record.worktreeSet,
        `${location}.worktreeSet`,
      ),
    );
  }

  if (record.concurrencyState !== undefined) {
    diagnostics.push(
      ...validateConcurrencyStateSchema(
        record.concurrencyState,
        `${location}.concurrencyState`,
      ),
    );
  }

  if (record.groupState !== undefined) {
    diagnostics.push(
      ...validateConcurrencyGroupStateSchema(
        record.groupState,
        `${location}.groupState`,
      ),
    );
  }

  normaliseIdList(
    record.liveAttemptIds,
    `${location}.liveAttemptIds`,
    diagnostics,
  );

  if (record.cancelledAttemptIds !== undefined) {
    normaliseIdList(
      record.cancelledAttemptIds,
      `${location}.cancelledAttemptIds`,
      diagnostics,
    );
  }

  if (
    record.resumeLiveIntegrating !== undefined
    && typeof record.resumeLiveIntegrating !== "boolean"
  ) {
    diagnostics.push(reject(
      "workspace_crash_recovery_invalid_flag",
      "resumeLiveIntegrating must be a boolean when present.",
      `${location}.resumeLiveIntegrating`,
    ));
  }

  if (
    record.resumeLiveChecking !== undefined
    && typeof record.resumeLiveChecking !== "boolean"
  ) {
    diagnostics.push(reject(
      "workspace_crash_recovery_invalid_flag",
      "resumeLiveChecking must be a boolean when present.",
      `${location}.resumeLiveChecking`,
    ));
  }

  return diagnostics;
}

/**
 * Plan crash recovery without applying set mutations.
 * Prefer applyWorkspaceCrashRecovery for the full next-state result.
 * Does not mutate inputs.
 */
export function planWorkspaceCrashRecovery(
  input: WorkspaceCrashRecoveryInput,
): WorkspaceCrashRecoveryPlanResult {
  const applied = applyWorkspaceCrashRecovery(input);
  if (!applied.ok) {
    return { ok: false, diagnostics: applied.diagnostics };
  }
  return { ok: true, plan: applied.plan };
}

/**
 * Reconcile workspace coordination state after crash or restore.
 *
 * Rules:
 * 1. Attempt holders not listed in liveAttemptIds are dead.
 * 2. Dead holders release leases, non-released worktrees (including failed),
 *    and concurrency slots.
 * 3. Cancel is evaluated before resume or fail for live and dead rows.
 *    Cancelled pending/integrating become aborted. Cancelled checking becomes
 *    checks_failed (abort is illegal from checking). Resume is never emitted
 *    for a cancelled attempt.
 * 4. Non-cancelled dead pending/integrating become failed. Checking becomes
 *    checks_failed. Terminal rows stay terminal.
 * 5. Live non-cancelled integrating/checking never become success here. They
 *    either fail without evidence or stay in-flight with an explicit resume
 *    host action when resume flags are set.
 * 6. Result includes only sets the caller supplied (plus required leaseSet).
 * 7. Inputs are never mutated.
 */
export function applyWorkspaceCrashRecovery(
  input: WorkspaceCrashRecoveryInput,
): WorkspaceCrashRecoveryApplyResult {
  const inputDiagnostics = validateWorkspaceCrashRecoveryInput(input, "recoveryInput");
  if (inputDiagnostics.length > 0) {
    return { ok: false, diagnostics: inputDiagnostics };
  }

  const liveList = normaliseIdList(
    input.liveAttemptIds,
    "recoveryInput.liveAttemptIds",
    [],
  ) ?? [];
  const cancelledList = normaliseIdList(
    input.cancelledAttemptIds ?? [],
    "recoveryInput.cancelledAttemptIds",
    [],
  ) ?? [];
  const cancelled = new Set(cancelledList);
  const resumeLiveIntegrating = input.resumeLiveIntegrating === true;
  const resumeLiveChecking = input.resumeLiveChecking === true;

  const suppliedIntegration = input.integrationSet !== undefined;
  const suppliedWorktree = input.worktreeSet !== undefined;
  const suppliedConcurrency = input.concurrencyState !== undefined;
  const suppliedGroup = input.groupState !== undefined;

  const leaseSet = input.leaseSet;
  const integrationSet = input.integrationSet
    ?? createEmptyWorkspaceIntegrationSet();
  const worktreeSet = input.worktreeSet
    ?? createEmptyWorkspaceWorktreeSet();
  const concurrencyState = input.concurrencyState
    ?? createEmptyConcurrencyState();
  const groupState = input.groupState
    ?? createEmptyConcurrencyGroupState();

  const knownIdInput: {
    leaseSet?: WorkspaceLeaseSet;
    integrationSet?: WorkspaceIntegrationSet;
    worktreeSet?: WorkspaceWorktreeSet;
    concurrencyState?: ConcurrencyState;
    groupState?: ConcurrencyGroupState;
  } = { leaseSet };
  if (suppliedIntegration) knownIdInput.integrationSet = integrationSet;
  if (suppliedWorktree) knownIdInput.worktreeSet = worktreeSet;
  if (suppliedConcurrency) knownIdInput.concurrencyState = concurrencyState;
  if (suppliedGroup) knownIdInput.groupState = groupState;
  const knownIds = collectWorkspaceAttemptIds(knownIdInput);
  const { liveAttemptIds, deadAttemptIds } = classifyAttemptLiveness(
    knownIds,
    liveList,
  );
  const dead = new Set(deadAttemptIds);
  const live = new Set(liveAttemptIds);

  const plan = emptyPlan(liveAttemptIds, deadAttemptIds);

  // Clone working sets through pure release/mark helpers only.
  let nextLeases: WorkspaceLeaseSet = {
    schemaVersion: WORKSPACE_LEASE_SET_SCHEMA_VERSION,
    leases: leaseSet.leases.map((lease) => structuredClone(lease)),
  };
  let nextIntegrations: WorkspaceIntegrationSet = {
    schemaVersion: WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION,
    integrations: integrationSet.integrations.map((item) => structuredClone(item)),
  };
  let nextWorktrees: WorkspaceWorktreeSet = {
    schemaVersion: WORKSPACE_WORKTREE_SET_SCHEMA_VERSION,
    worktrees: worktreeSet.worktrees.map((item) => structuredClone(item)),
  };
  let nextConcurrency: ConcurrencyState = {
    schemaVersion: CONCURRENCY_STATE_SCHEMA_VERSION,
    attempts: concurrencyState.attempts.map((item) => structuredClone(item)),
  };
  let nextGroups: ConcurrencyGroupState = {
    schemaVersion: CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
    attempts: groupState.attempts.map((item) => structuredClone(item)),
  };

  // 1. Integrations: cancel first, then fail/resume without inventing success.
  if (suppliedIntegration) {
    const integrationOrder = [...nextIntegrations.integrations]
      .map((item) => item.integrationId)
      .sort((left, right) => left.localeCompare(right));

    for (const integrationId of integrationOrder) {
      const current = nextIntegrations.integrations.find(
        (item) => item.integrationId === integrationId,
      );
      if (current === undefined) continue;

      const attemptId = current.holder.attemptId;
      const isDead = dead.has(attemptId);
      const isLive = live.has(attemptId);
      const isCancelled = cancelled.has(attemptId);

      // Cancel before resume or crash-fail for both live and dead holders.
      if (isCancelled) {
        if (current.status === "pending" || current.status === "integrating") {
          const marked = markIntegrationAborted(
            nextIntegrations,
            current.integrationId,
            `Crash recovery aborted cancelled attempt '${attemptId}'.`,
          );
          if (!marked.ok) {
            return { ok: false, diagnostics: marked.diagnostics };
          }
          nextIntegrations = marked.set;
          plan.abortedIntegrationIds.push(current.integrationId);
          plan.notes.push(recoveryNote(
            "workspace_crash_recovery_aborted_cancelled",
            `Integration '${current.integrationId}' was aborted for cancelled attempt '${attemptId}'.`,
            "integration.status",
          ));
        } else if (current.status === "checking") {
          // markIntegrationAborted rejects checking. Fail checks instead.
          // Never emit resume for a cancelled checking record.
          const marked = markIntegrationChecksFailed(
            nextIntegrations,
            current.integrationId,
            checksFailureDiagnostics(attemptId),
            `Crash recovery failed post-integration checks for cancelled attempt '${attemptId}'.`,
          );
          if (!marked.ok) {
            return { ok: false, diagnostics: marked.diagnostics };
          }
          nextIntegrations = marked.set;
          plan.checksFailedIntegrationIds.push(current.integrationId);
          plan.notes.push(recoveryNote(
            "workspace_crash_recovery_cancelled_checking",
            `Integration '${current.integrationId}' checks failed for cancelled attempt '${attemptId}'. Resume is not permitted.`,
            "integration.status",
          ));
        }
        if (isDead) {
          plan.hostActions.push({
            kind: "teardown_child_attempt",
            attemptId,
            leaseId: current.leaseId,
            worktreeId: current.worktreeId,
            integrationId: current.integrationId,
            reason: `Dead attempt '${attemptId}' requires child process teardown if still owned.`,
          });
        }
        continue;
      }

      if (isDead) {
        if (current.status === "pending" || current.status === "integrating") {
          const marked = markIntegrationFailed(
            nextIntegrations,
            current.integrationId,
            crashFailureDiagnostics(attemptId, current.status),
            `Crash recovery failed ${current.status} integration for dead attempt '${attemptId}'.`,
          );
          if (!marked.ok) {
            return { ok: false, diagnostics: marked.diagnostics };
          }
          nextIntegrations = marked.set;
          plan.failedIntegrationIds.push(current.integrationId);
        } else if (current.status === "checking") {
          const marked = markIntegrationChecksFailed(
            nextIntegrations,
            current.integrationId,
            checksFailureDiagnostics(attemptId),
            `Crash recovery failed post-integration checks for dead attempt '${attemptId}'.`,
          );
          if (!marked.ok) {
            return { ok: false, diagnostics: marked.diagnostics };
          }
          nextIntegrations = marked.set;
          plan.checksFailedIntegrationIds.push(current.integrationId);
        }
        // Terminal rows (integrated, checks_*, conflicted, failed, aborted, released) stay.
        plan.hostActions.push({
          kind: "teardown_child_attempt",
          attemptId,
          leaseId: current.leaseId,
          worktreeId: current.worktreeId,
          integrationId: current.integrationId,
          reason: `Dead attempt '${attemptId}' requires child process teardown if still owned.`,
        });
        continue;
      }

      if (isLive) {
        if (current.status === "integrating") {
          if (resumeLiveIntegrating) {
            plan.resumeIntegrateIds.push(current.integrationId);
            plan.hostActions.push({
              kind: "resume_integrate",
              attemptId,
              leaseId: current.leaseId,
              worktreeId: current.worktreeId,
              integrationId: current.integrationId,
              reason:
                `Live attempt '${attemptId}' is still integrating. `
                + "Resume only with current-state evidence. Do not invent success.",
            });
            plan.notes.push(recoveryNote(
              "workspace_crash_recovery_resume_integrate",
              `Integration '${current.integrationId}' remains integrating for resume with evidence.`,
              "integration.status",
            ));
          } else {
            const marked = markIntegrationFailed(
              nextIntegrations,
              current.integrationId,
              crashFailureDiagnostics(attemptId, "integrating"),
              `Crash recovery failed integrating record for live attempt '${attemptId}' without resume evidence.`,
            );
            if (!marked.ok) {
              return { ok: false, diagnostics: marked.diagnostics };
            }
            nextIntegrations = marked.set;
            plan.failedIntegrationIds.push(current.integrationId);
          }
        } else if (current.status === "checking") {
          if (resumeLiveChecking) {
            plan.resumeCheckingIds.push(current.integrationId);
            plan.hostActions.push({
              kind: "resume_post_integration_checks",
              attemptId,
              leaseId: current.leaseId,
              worktreeId: current.worktreeId,
              integrationId: current.integrationId,
              reason:
                `Live attempt '${attemptId}' is still checking. `
                + "Resume only with allowResume when no host runner is active. "
                + "Do not invent checks_passed.",
            });
            plan.notes.push(recoveryNote(
              "workspace_crash_recovery_resume_checking",
              `Integration '${current.integrationId}' remains checking for resume with allowResume.`,
              "integration.status",
            ));
          } else {
            const marked = markIntegrationChecksFailed(
              nextIntegrations,
              current.integrationId,
              checksFailureDiagnostics(attemptId),
              `Crash recovery failed checking record for live attempt '${attemptId}' without resume evidence.`,
            );
            if (!marked.ok) {
              return { ok: false, diagnostics: marked.diagnostics };
            }
            nextIntegrations = marked.set;
            plan.checksFailedIntegrationIds.push(current.integrationId);
          }
        }
      }
    }
  }

  plan.failedIntegrationIds.sort((left, right) => left.localeCompare(right));
  plan.checksFailedIntegrationIds.sort((left, right) => left.localeCompare(right));
  plan.abortedIntegrationIds.sort((left, right) => left.localeCompare(right));
  plan.resumeIntegrateIds.sort((left, right) => left.localeCompare(right));
  plan.resumeCheckingIds.sort((left, right) => left.localeCompare(right));

  // 2. Worktrees: release non-released rows for dead holders (including failed).
  if (suppliedWorktree) {
    for (const worktree of [...nextWorktrees.worktrees]) {
      if (worktree.status === "released") continue;
      if (!dead.has(worktree.holder.attemptId)) continue;
      const released = releaseWorktreeRecord(nextWorktrees, worktree.worktreeId);
      if (!released.ok) {
        return { ok: false, diagnostics: released.diagnostics };
      }
      nextWorktrees = released.set;
      if (released.released) {
        plan.releasedWorktreeIds.push(worktree.worktreeId);
        plan.hostActions.push({
          kind: "release_worktree_disk",
          attemptId: worktree.holder.attemptId,
          leaseId: worktree.leaseId,
          worktreeId: worktree.worktreeId,
          reason:
            `Dead attempt '${worktree.holder.attemptId}' worktree '${worktree.worktreeId}' `
            + "must release disk resources.",
        });
      }
    }
    plan.releasedWorktreeIds.sort((left, right) => left.localeCompare(right));
  }

  // 3. Leases: release dead holders. Live holders stay intact.
  for (const lease of [...nextLeases.leases]) {
    if (!dead.has(lease.holder.attemptId)) continue;
    const released = releaseWorkspaceLease(nextLeases, lease.leaseId);
    if (!released.ok) {
      return { ok: false, diagnostics: released.diagnostics };
    }
    nextLeases = released.set;
    if (released.released) {
      plan.releasedLeaseIds.push(lease.leaseId);
    }
  }
  plan.releasedLeaseIds.sort((left, right) => left.localeCompare(right));

  // 4. Concurrency occupancy: free slots for dead attempts.
  if (suppliedConcurrency) {
    for (const attempt of [...nextConcurrency.attempts]) {
      if (!dead.has(attempt.attemptId)) continue;
      const released = releaseAttempt(nextConcurrency, attempt.attemptId);
      if (!released.ok) {
        return { ok: false, diagnostics: released.diagnostics };
      }
      nextConcurrency = released.state;
      if (released.released) {
        plan.releasedConcurrencyAttemptIds.push(attempt.attemptId);
      }
    }
    plan.releasedConcurrencyAttemptIds.sort((left, right) => left.localeCompare(right));
  }

  // 5. Group occupancy: free group slots for dead attempts.
  if (suppliedGroup) {
    for (const attempt of [...nextGroups.attempts]) {
      if (!dead.has(attempt.attemptId)) continue;
      const released = releaseGroupAttempt(nextGroups, attempt.attemptId);
      if (!released.ok) {
        return { ok: false, diagnostics: released.diagnostics };
      }
      nextGroups = released.state;
      if (released.released) {
        plan.releasedGroupAttemptIds.push(attempt.attemptId);
      }
    }
    plan.releasedGroupAttemptIds.sort((left, right) => left.localeCompare(right));
  }

  // Ensure every dead attempt has one teardown host action (lease-only holders too).
  const teardownAttempts = new Set(
    plan.hostActions
      .filter((action) => action.kind === "teardown_child_attempt")
      .map((action) => action.attemptId),
  );
  for (const attemptId of deadAttemptIds) {
    if (teardownAttempts.has(attemptId)) continue;
    plan.hostActions.push({
      kind: "teardown_child_attempt",
      attemptId,
      reason:
        `Dead attempt '${attemptId}' requires child process teardown if still owned.`,
    });
    teardownAttempts.add(attemptId);
  }

  // Stable host action order: kind, then attemptId, then integrationId.
  // Use code-unit ordinal compare so order does not depend on host locale.
  plan.hostActions.sort((left, right) => {
    const kindOrder = compareIdentityOrdinal(left.kind, right.kind);
    if (kindOrder !== 0) return kindOrder;
    const attemptOrder = compareIdentityOrdinal(left.attemptId, right.attemptId);
    if (attemptOrder !== 0) return attemptOrder;
    return compareIdentityOrdinal(left.integrationId ?? "", right.integrationId ?? "");
  });

  // Deduplicate teardown_child_attempt by attemptId (one per dead attempt).
  const seenTeardown = new Set<string>();
  plan.hostActions = plan.hostActions.filter((action) => {
    if (action.kind !== "teardown_child_attempt") return true;
    if (seenTeardown.has(action.attemptId)) return false;
    seenTeardown.add(action.attemptId);
    return true;
  });

  const result: Extract<WorkspaceCrashRecoveryApplyResult, { ok: true }> = {
    ok: true,
    plan,
    leaseSet: nextLeases,
  };
  if (suppliedIntegration) {
    result.integrationSet = nextIntegrations;
  }
  if (suppliedWorktree) {
    result.worktreeSet = nextWorktrees;
  }
  if (suppliedConcurrency) {
    result.concurrencyState = nextConcurrency;
  }
  if (suppliedGroup) {
    result.groupState = nextGroups;
  }
  return result;
}

/**
 * Build liveAttemptIds from process liveness rows (mock or host registry).
 * Each row must be a strict plain object. Class instances are ignored.
 * Dead or orphan rows are excluded. Does not mutate inputs.
 */
export function liveAttemptIdsFromLiveness(
  rows: readonly { attemptId: string; live: boolean }[],
): string[] {
  if (!Array.isArray(rows)) return [];
  const ids = new Set<string>();
  for (const row of rows) {
    if (!isStrictPlainObject(row)) continue;
    const attemptId = row.attemptId;
    const live = row.live;
    if (!isNonEmptyString(attemptId) || live !== true) continue;
    ids.add(attemptId.trim());
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/**
 * Remove orphan attempt ids from a live list after child-process teardown input.
 * Used to compose isolated-Pi orphan reconciliation with workspace recovery.
 * Does not mutate inputs.
 */
export function excludeOrphanAttemptIds(
  liveAttemptIds: readonly string[],
  orphanAttemptIds: readonly string[],
): string[] {
  const orphans = new Set(
    orphanAttemptIds
      .filter((id): id is string => isNonEmptyString(id))
      .map((id) => id.trim()),
  );
  return liveAttemptIds
    .filter((id): id is string => isNonEmptyString(id))
    .map((id) => id.trim())
    .filter((id) => !orphans.has(id))
    .sort((left, right) => left.localeCompare(right));
}
