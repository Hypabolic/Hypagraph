/**
 * Pure workspace integration lifecycle for worker commits (M8-s5, M8-s6).
 *
 * After pre-integration validation (m8-s4), the controller registers an
 * integration record, marks it integrating before any base git mutation, then
 * records integrated, conflicted, or failed outcomes. Conflict is an explicit
 * recoverable state. It is never treated as success or silent overwrite.
 *
 * After a successful integrate (status integrated), the controller must run
 * post-integration checks in the base workspace (m8-s6). Statuses checking,
 * checks_passed, and checks_failed track that phase. Node completion requires
 * checks_passed. Integration success and post-integration check success remain
 * separate.
 *
 * Execution success and integration success remain separate states.
 *
 * Domain helpers are pure: no clock, random, files, network, or input mutation.
 * The integration set is an in-memory value. Persistence and schema restore
 * belong to later M8 slices; the set type carries schemaVersion for that work.
 */

import type { Diagnostic } from "./model.js";
import {
  isFullGitObjectId,
  parseWorkerCommitResult,
  type WorkerCommitResult,
} from "./workspace-commit.js";
import {
  parseWorkspaceLease,
  type WorkspaceLease,
  type WorkspaceLeaseHolder,
} from "./workspace-lease.js";
import {
  validateWorkerResultForIntegration,
  type ValidatedWorkerResultForIntegration,
} from "./workspace-scope-validation.js";
import {
  parseWorkspaceWorktree,
  type WorkspaceWorktree,
} from "./workspace-worktree.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Schema version for a future persisted integration set.
 * Version 2 matches member records that include post-integration check statuses.
 * Version 1 is rejected (incompatible status model).
 */
export const WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION = 2 as const;

/**
 * Schema version for one integration record.
 * Version 2 adds checking, checks_passed, and checks_failed with new invariants.
 * Version 1 is rejected as unsupported.
 */
export const WORKSPACE_INTEGRATION_SCHEMA_VERSION = 2 as const;

/** Default maximum integration records in one set. */
export const DEFAULT_MAX_INTEGRATIONS = 64;

/**
 * Integration lifecycle status.
 *
 * - pending: validated, not started.
 * - integrating: host integrate is in progress (durable before base mutates).
 * - integrated: worker commit successfully integrated into base.
 *   Not sufficient for node completion after m8-s6.
 * - checking: post-integration checks are running in the base workspace.
 * - checks_passed: post-integration checks succeeded; node completion is allowed.
 * - checks_failed: post-integration checks failed; node must not complete.
 * - conflicted: merge or apply conflict; explicit recoverable state.
 * - failed: non-conflict failure (identity, validation, git process, stale).
 *   Host cancellation also uses failed with workspace_integration_aborted so
 *   the record keeps failure diagnostics. Pure markIntegrationAborted remains
 *   available for controller cancel paths that do not need failure detail.
 * - aborted: pure cancel without failure diagnostics (controller path).
 * - released: record released from the active set. Integrated records must not
 *   be released; they keep completion identity for double-integrate rejection.
 */
export const WORKSPACE_INTEGRATION_STATUSES = [
  "pending",
  "integrating",
  "integrated",
  "checking",
  "checks_passed",
  "checks_failed",
  "conflicted",
  "failed",
  "aborted",
  "released",
] as const;

/**
 * Status values that still allow a start or progress transition for integrate.
 * Checking is not integrate-active; it is check-phase active.
 */
export const WORKSPACE_INTEGRATION_ACTIVE_STATUSES = [
  "pending",
  "integrating",
] as const;

/**
 * Status values that mean post-integration checks are in progress.
 * Records in the check phase must not be released as complete.
 */
export const WORKSPACE_INTEGRATION_CHECK_ACTIVE_STATUSES = [
  "checking",
] as const;

/**
 * Terminal status values that block a second integrate attempt.
 * Includes integrated and all post-integration check statuses that retain
 * completion identity.
 */
export const WORKSPACE_INTEGRATION_TERMINAL_STATUSES = [
  "integrated",
  "checking",
  "checks_passed",
  "checks_failed",
  "conflicted",
  "failed",
  "aborted",
  "released",
] as const;

/**
 * Status values that retain integratedCommitHash after a successful integrate.
 */
export const WORKSPACE_INTEGRATION_POST_INTEGRATE_STATUSES = [
  "integrated",
  "checking",
  "checks_passed",
  "checks_failed",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkspaceIntegrationStatus =
  (typeof WORKSPACE_INTEGRATION_STATUSES)[number];

/**
 * Explicit conflict details when status is conflicted.
 * conflictingPaths lists git-relative paths when known.
 * pathsUnavailable is true when the host could not list unmerged paths.
 */
export interface WorkspaceIntegrationConflict {
  conflictingPaths: string[];
  message?: string;
  /** True when path listing failed; required when conflictingPaths is empty. */
  pathsUnavailable?: boolean;
}

/**
 * Integration record that links lease, worktree, worker commit, and outcome.
 */
export interface WorkspaceIntegration {
  schemaVersion: typeof WORKSPACE_INTEGRATION_SCHEMA_VERSION;
  integrationId: string;
  leaseId: string;
  worktreeId: string;
  holder: WorkspaceLeaseHolder;
  /** Full git object id of the worker commit to integrate. */
  workerCommitHash: string;
  /** Full git object id of the base revision at worktree prepare / commit. */
  baseRevision: string;
  status: WorkspaceIntegrationStatus;
  /** New base HEAD after a successful integrate. */
  integratedCommitHash?: string;
  /**
   * Base HEAD when integrating started, before any base mutation.
   * Used as historical range context for resume. Completion on resume still
   * requires current-state evidence (tree equality or exact HEAD match).
   */
  baseHeadBeforeIntegrate?: string;
  /** Present when status is conflicted. */
  conflict?: WorkspaceIntegrationConflict;
  /**
   * Diagnostics from the latest failed transition when status is failed
   * or checks_failed.
   */
  diagnostics?: Diagnostic[];
  /** Optional human-readable failure or abort message. */
  message?: string;
}

/**
 * In-memory integration registry.
 * Not restored from disk in this slice. schemaVersion is reserved for later
 * persistence and must be WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION when present.
 */
export interface WorkspaceIntegrationSet {
  schemaVersion: typeof WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION;
  integrations: WorkspaceIntegration[];
}

export type WorkspaceIntegrationRegisterResult =
  | { ok: true; set: WorkspaceIntegrationSet; integration: WorkspaceIntegration }
  | { ok: false; diagnostics: Diagnostic[] };

export type WorkspaceIntegrationTransitionResult =
  | { ok: true; set: WorkspaceIntegrationSet; integration: WorkspaceIntegration }
  | { ok: false; diagnostics: Diagnostic[] };

export type WorkspaceIntegrationListResult =
  | { ok: true; integrations: WorkspaceIntegration[] }
  | { ok: false; diagnostics: Diagnostic[] };

export type WorkspaceIntegrationGetResult =
  | { ok: true; integration: WorkspaceIntegration | undefined }
  | { ok: false; diagnostics: Diagnostic[] };

export type WorkspaceIntegrationReleaseResult =
  | {
    ok: true;
    set: WorkspaceIntegrationSet;
    released: boolean;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

/**
 * Expected identity for stale-result rejection on transitions.
 * All present fields must match the record. Omitted fields are not checked.
 */
export interface WorkspaceIntegrationExpectedIdentity {
  integrationId?: string;
  leaseId?: string;
  worktreeId?: string;
  holder?: WorkspaceLeaseHolder;
  workerCommitHash?: string;
  baseRevision?: string;
  /**
   * Full git object id of the integrated base HEAD.
   * Post-integration checks bind to this commit.
   */
  integratedCommitHash?: string;
}

export interface WorkspaceIntegrationBounds {
  /**
   * Maximum active (pending or integrating) records after register.
   * Default DEFAULT_MAX_INTEGRATIONS. When present must be a non-negative
   * safe integer.
   */
  maxIntegrations?: number;
  /**
   * Maximum total retained records after register (any status).
   * Default DEFAULT_MAX_INTEGRATIONS * 4. When present must be a non-negative
   * safe integer.
   */
  maxRetainedIntegrations?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const WORKSPACE_INTEGRATION_STATUS_SET = new Set<string>(
  WORKSPACE_INTEGRATION_STATUSES,
);
const WORKSPACE_INTEGRATION_ACTIVE_STATUS_SET = new Set<string>(
  WORKSPACE_INTEGRATION_ACTIVE_STATUSES,
);
const WORKSPACE_INTEGRATION_CHECK_ACTIVE_STATUS_SET = new Set<string>(
  WORKSPACE_INTEGRATION_CHECK_ACTIVE_STATUSES,
);
const WORKSPACE_INTEGRATION_TERMINAL_STATUS_SET = new Set<string>(
  WORKSPACE_INTEGRATION_TERMINAL_STATUSES,
);
const WORKSPACE_INTEGRATION_POST_INTEGRATE_STATUS_SET = new Set<string>(
  WORKSPACE_INTEGRATION_POST_INTEGRATE_STATUSES,
);

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

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const reject = (code: string, message: string, location?: string): Diagnostic => ({
  code,
  message,
  ...(location !== undefined ? { location } : {}),
});

function resolveNonNegativeSafeIntegerBound(
  value: number | undefined,
  fallback: number,
  location: string,
): { ok: true; value: number } | { ok: false; diagnostic: Diagnostic } {
  if (value === undefined) return { ok: true, value: fallback };
  if (!isNonNegativeSafeInteger(value)) {
    return {
      ok: false,
      diagnostic: reject(
        "workspace_integration_invalid_bound",
        `Bound at ${location} must be a non-negative safe integer when present.`,
        location,
      ),
    };
  }
  return { ok: true, value };
}

/** Default total retained records (active and terminal). */
export const DEFAULT_MAX_RETAINED_INTEGRATIONS = DEFAULT_MAX_INTEGRATIONS * 4;

function resolveIntegrationBounds(
  bounds: WorkspaceIntegrationBounds | undefined,
):
  | { ok: true; maxIntegrations: number; maxRetainedIntegrations: number }
  | { ok: false; diagnostics: Diagnostic[] } {
  const maxIntegrations = resolveNonNegativeSafeIntegerBound(
    bounds?.maxIntegrations,
    DEFAULT_MAX_INTEGRATIONS,
    "bounds.maxIntegrations",
  );
  if (!maxIntegrations.ok) {
    return { ok: false, diagnostics: [maxIntegrations.diagnostic] };
  }
  const maxRetained = resolveNonNegativeSafeIntegerBound(
    bounds?.maxRetainedIntegrations,
    DEFAULT_MAX_RETAINED_INTEGRATIONS,
    "bounds.maxRetainedIntegrations",
  );
  if (!maxRetained.ok) {
    return { ok: false, diagnostics: [maxRetained.diagnostic] };
  }
  return {
    ok: true,
    maxIntegrations: maxIntegrations.value,
    maxRetainedIntegrations: maxRetained.value,
  };
}

function validateHolder(
  holder: unknown,
  location: string,
  diagnostics: Diagnostic[],
): WorkspaceLeaseHolder | undefined {
  if (!isStrictPlainObject(holder)) {
    diagnostics.push(reject(
      "workspace_integration_invalid_holder",
      "Integration holder must be a plain object.",
      location,
    ));
    return undefined;
  }
  const record = holder;
  const stringFields: Array<keyof WorkspaceLeaseHolder> = [
    "familyId",
    "goalId",
    "workflowId",
    "nodeId",
    "attemptId",
  ];
  let failed = false;
  for (const field of stringFields) {
    if (!isNonEmptyString(record[field])) {
      diagnostics.push(reject(
        "workspace_integration_invalid_holder",
        `Integration holder.${field} must be a non-empty string.`,
        `${location}.${field}`,
      ));
      failed = true;
    }
  }
  if (!isNonNegativeSafeInteger(record.revision)) {
    diagnostics.push(reject(
      "workspace_integration_invalid_holder",
      "Integration holder.revision must be a non-negative safe integer.",
      `${location}.revision`,
    ));
    failed = true;
  }
  if (failed) return undefined;
  return {
    familyId: (record.familyId as string).trim(),
    goalId: (record.goalId as string).trim(),
    workflowId: (record.workflowId as string).trim(),
    revision: record.revision as number,
    nodeId: (record.nodeId as string).trim(),
    attemptId: (record.attemptId as string).trim(),
  };
}

function holdersEqual(left: WorkspaceLeaseHolder, right: WorkspaceLeaseHolder): boolean {
  return (
    left.familyId === right.familyId
    && left.goalId === right.goalId
    && left.workflowId === right.workflowId
    && left.revision === right.revision
    && left.nodeId === right.nodeId
    && left.attemptId === right.attemptId
  );
}

function isActiveStatus(status: string): boolean {
  return WORKSPACE_INTEGRATION_ACTIVE_STATUS_SET.has(status);
}

function isCheckActiveStatus(status: string): boolean {
  return WORKSPACE_INTEGRATION_CHECK_ACTIVE_STATUS_SET.has(status);
}

function isTerminalStatus(status: string): boolean {
  return WORKSPACE_INTEGRATION_TERMINAL_STATUS_SET.has(status);
}

function hasPostIntegrateStatus(status: string): boolean {
  return WORKSPACE_INTEGRATION_POST_INTEGRATE_STATUS_SET.has(status);
}

/**
 * Report whether a status is active for integrate (pending or integrating).
 */
export function isActiveIntegrationStatus(
  status: WorkspaceIntegrationStatus,
): boolean {
  return isActiveStatus(status);
}

/**
 * Report whether a status is active for the post-integration check phase.
 */
export function isCheckPhaseActiveStatus(
  status: WorkspaceIntegrationStatus,
): boolean {
  return isCheckActiveStatus(status);
}

/**
 * Report whether a status is terminal for double-integrate rejection.
 */
export function isTerminalIntegrationStatus(
  status: WorkspaceIntegrationStatus,
): boolean {
  return isTerminalStatus(status);
}

/**
 * Report whether the integration retains a successful integrate outcome.
 * Includes integrated and all post-integration check statuses.
 */
export function isPostIntegrateIntegrationStatus(
  status: WorkspaceIntegrationStatus,
): boolean {
  return hasPostIntegrateStatus(status);
}

/**
 * Report whether the integration is eligible for node completion.
 * Requires successful post-integration checks (checks_passed).
 * Status integrated alone is not enough after m8-s6.
 */
export function isIntegrationEligibleForNodeCompletion(
  integration: WorkspaceIntegration,
): boolean {
  return integration.status === "checks_passed"
    && typeof integration.integratedCommitHash === "string"
    && isFullGitObjectId(integration.integratedCommitHash);
}

/**
 * Derive a stable integration id from a lease id.
 * Pure string rule only.
 */
export function deriveIntegrationId(leaseId: string): string {
  return `int-${leaseId.trim()}`;
}

// ---------------------------------------------------------------------------
// Validation and parse
// ---------------------------------------------------------------------------

function validateConflictObject(
  value: unknown,
  location: string,
  diagnostics: Diagnostic[],
): WorkspaceIntegrationConflict | undefined {
  if (!isStrictPlainObject(value)) {
    diagnostics.push(reject(
      "workspace_integration_invalid_conflict",
      "conflict must be a plain object when present.",
      location,
    ));
    return undefined;
  }
  const record = value;
  if (!Array.isArray(record.conflictingPaths)) {
    diagnostics.push(reject(
      "workspace_integration_invalid_conflict",
      "conflict.conflictingPaths must be a string array.",
      `${location}.conflictingPaths`,
    ));
    return undefined;
  }
  const paths: string[] = [];
  let failed = false;
  for (let index = 0; index < record.conflictingPaths.length; index += 1) {
    const item = record.conflictingPaths[index];
    if (typeof item !== "string" || item.trim().length === 0) {
      diagnostics.push(reject(
        "workspace_integration_invalid_conflict",
        `conflict.conflictingPaths at index ${index} must be a non-empty string.`,
        `${location}.conflictingPaths[${index}]`,
      ));
      failed = true;
      continue;
    }
    paths.push(item.trim());
  }
  if (
    record.message !== undefined
    && typeof record.message !== "string"
  ) {
    diagnostics.push(reject(
      "workspace_integration_invalid_conflict",
      "conflict.message must be a string when present.",
      `${location}.message`,
    ));
    failed = true;
  }
  if (
    record.pathsUnavailable !== undefined
    && typeof record.pathsUnavailable !== "boolean"
  ) {
    diagnostics.push(reject(
      "workspace_integration_invalid_conflict",
      "conflict.pathsUnavailable must be a boolean when present.",
      `${location}.pathsUnavailable`,
    ));
    failed = true;
  }
  if (paths.length === 0 && record.pathsUnavailable !== true) {
    diagnostics.push(reject(
      "workspace_integration_invalid_conflict",
      "conflict.conflictingPaths may be empty only when conflict.pathsUnavailable is true.",
      `${location}.conflictingPaths`,
    ));
    failed = true;
  }
  if (failed) return undefined;
  const conflict: WorkspaceIntegrationConflict = {
    conflictingPaths: paths,
  };
  if (typeof record.message === "string" && record.message.trim().length > 0) {
    conflict.message = record.message.trim();
  }
  if (record.pathsUnavailable === true) {
    conflict.pathsUnavailable = true;
  }
  return conflict;
}

function validateDiagnosticsList(
  value: unknown,
  location: string,
  diagnostics: Diagnostic[],
): Diagnostic[] | undefined {
  if (!Array.isArray(value)) {
    diagnostics.push(reject(
      "workspace_integration_invalid_diagnostics",
      "diagnostics must be an array when present.",
      location,
    ));
    return undefined;
  }
  const items: Diagnostic[] = [];
  let failed = false;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isStrictPlainObject(item)) {
      diagnostics.push(reject(
        "workspace_integration_invalid_diagnostics",
        `diagnostics at index ${index} must be a plain object.`,
        `${location}[${index}]`,
      ));
      failed = true;
      continue;
    }
    if (!isNonEmptyString(item.code) || !isNonEmptyString(item.message)) {
      diagnostics.push(reject(
        "workspace_integration_invalid_diagnostics",
        `diagnostics at index ${index} must include non-empty code and message.`,
        `${location}[${index}]`,
      ));
      failed = true;
      continue;
    }
    const entry: Diagnostic = {
      code: (item.code as string).trim(),
      message: (item.message as string).trim(),
    };
    if (item.location !== undefined) {
      if (typeof item.location !== "string") {
        diagnostics.push(reject(
          "workspace_integration_invalid_diagnostics",
          `diagnostics at index ${index} location must be a string when present.`,
          `${location}[${index}].location`,
        ));
        failed = true;
        continue;
      }
      entry.location = item.location;
    }
    items.push(entry);
  }
  return failed ? undefined : items;
}

/**
 * Validate a workspace integration record.
 * Accepts untrusted input. Rejects class instances. Does not mutate input.
 */
export function validateWorkspaceIntegration(
  value: unknown,
  location = "integration",
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (!isStrictPlainObject(value)) {
    return [reject(
      "workspace_integration_not_plain_object",
      "Workspace integration must be a plain object.",
      location,
    )];
  }

  const record = value;

  if (record.schemaVersion !== WORKSPACE_INTEGRATION_SCHEMA_VERSION) {
    diagnostics.push(reject(
      "workspace_integration_unsupported_schema",
      `Unsupported workspace integration schema version '${String(record.schemaVersion)}'. Expected ${WORKSPACE_INTEGRATION_SCHEMA_VERSION}.`,
      `${location}.schemaVersion`,
    ));
  }

  if (!isNonEmptyString(record.integrationId)) {
    diagnostics.push(reject(
      "workspace_integration_invalid_id",
      "integrationId must be a non-empty string.",
      `${location}.integrationId`,
    ));
  }

  if (!isNonEmptyString(record.leaseId)) {
    diagnostics.push(reject(
      "workspace_integration_invalid_lease_id",
      "leaseId must be a non-empty string.",
      `${location}.leaseId`,
    ));
  }

  if (!isNonEmptyString(record.worktreeId)) {
    diagnostics.push(reject(
      "workspace_integration_invalid_worktree_id",
      "worktreeId must be a non-empty string.",
      `${location}.worktreeId`,
    ));
  }

  if (
    !isNonEmptyString(record.workerCommitHash)
    || !isFullGitObjectId(record.workerCommitHash.trim())
  ) {
    diagnostics.push(reject(
      "workspace_integration_invalid_worker_commit_hash",
      "workerCommitHash must be a full git object id (40 or 64 hexadecimal characters).",
      `${location}.workerCommitHash`,
    ));
  }

  if (
    !isNonEmptyString(record.baseRevision)
    || !isFullGitObjectId(record.baseRevision.trim())
  ) {
    diagnostics.push(reject(
      "workspace_integration_invalid_base_revision",
      "baseRevision must be a full git object id (40 or 64 hexadecimal characters).",
      `${location}.baseRevision`,
    ));
  }

  if (
    typeof record.status !== "string"
    || !WORKSPACE_INTEGRATION_STATUS_SET.has(record.status)
  ) {
    diagnostics.push(reject(
      "workspace_integration_invalid_status",
      "status must be a known integration status.",
      `${location}.status`,
    ));
  }

  if (record.integratedCommitHash !== undefined) {
    if (
      !isNonEmptyString(record.integratedCommitHash)
      || !isFullGitObjectId(record.integratedCommitHash.trim())
    ) {
      diagnostics.push(reject(
        "workspace_integration_invalid_integrated_commit_hash",
        "integratedCommitHash must be a full git object id when present.",
        `${location}.integratedCommitHash`,
      ));
    }
  }

  if (record.baseHeadBeforeIntegrate !== undefined) {
    if (
      !isNonEmptyString(record.baseHeadBeforeIntegrate)
      || !isFullGitObjectId(record.baseHeadBeforeIntegrate.trim())
    ) {
      diagnostics.push(reject(
        "workspace_integration_invalid_base_head_before",
        "baseHeadBeforeIntegrate must be a full git object id when present.",
        `${location}.baseHeadBeforeIntegrate`,
      ));
    }
  }

  // Status-field invariants: each optional field belongs to one status only.
  // integratedCommitHash is required for all post-integrate statuses.
  if (
    typeof record.status === "string"
    && hasPostIntegrateStatus(record.status)
  ) {
    if (
      record.integratedCommitHash === undefined
      || !isNonEmptyString(record.integratedCommitHash)
    ) {
      diagnostics.push(reject(
        "workspace_integration_missing_integrated_commit",
        "A post-integrate record must include integratedCommitHash.",
        `${location}.integratedCommitHash`,
      ));
    }
    if (record.conflict !== undefined) {
      diagnostics.push(reject(
        "workspace_integration_status_field_mismatch",
        "A post-integrate record must not include conflict details.",
        `${location}.conflict`,
      ));
    }
    // diagnostics only on checks_failed among post-integrate statuses.
    // checks_failed requires a non-empty diagnostics array (restore invariant).
    if (record.status === "checks_failed") {
      if (record.diagnostics === undefined) {
        diagnostics.push(reject(
          "workspace_integration_missing_check_diagnostics",
          "A checks_failed record must include a non-empty diagnostics array.",
          `${location}.diagnostics`,
        ));
      } else {
        const list = validateDiagnosticsList(
          record.diagnostics,
          `${location}.diagnostics`,
          diagnostics,
        );
        if (list !== undefined && list.length === 0) {
          diagnostics.push(reject(
            "workspace_integration_missing_check_diagnostics",
            "A checks_failed record must include a non-empty diagnostics array.",
            `${location}.diagnostics`,
          ));
        }
      }
    } else if (record.diagnostics !== undefined) {
      diagnostics.push(reject(
        "workspace_integration_status_field_mismatch",
        "Failure diagnostics on a post-integrate record are permitted only when status is checks_failed.",
        `${location}.diagnostics`,
      ));
    }
  } else if (record.integratedCommitHash !== undefined) {
    diagnostics.push(reject(
      "workspace_integration_status_field_mismatch",
      "integratedCommitHash is permitted only after a successful integrate.",
      `${location}.integratedCommitHash`,
    ));
  }

  if (record.status === "conflicted") {
    if (record.conflict === undefined) {
      diagnostics.push(reject(
        "workspace_integration_missing_conflict",
        "A conflicted record must include conflict details.",
        `${location}.conflict`,
      ));
    } else {
      validateConflictObject(record.conflict, `${location}.conflict`, diagnostics);
    }
  } else if (record.conflict !== undefined) {
    diagnostics.push(reject(
      "workspace_integration_status_field_mismatch",
      "conflict is permitted only when status is conflicted.",
      `${location}.conflict`,
    ));
  }

  if (record.diagnostics !== undefined) {
    if (record.status === "checks_failed") {
      // Already validated under post-integrate invariants above.
    } else if (record.status !== "failed") {
      diagnostics.push(reject(
        "workspace_integration_status_field_mismatch",
        "diagnostics is permitted only when status is failed or checks_failed.",
        `${location}.diagnostics`,
      ));
    } else {
      validateDiagnosticsList(record.diagnostics, `${location}.diagnostics`, diagnostics);
    }
  }

  if (record.message !== undefined && typeof record.message !== "string") {
    diagnostics.push(reject(
      "workspace_integration_invalid_message",
      "message must be a string when present.",
      `${location}.message`,
    ));
  }

  validateHolder(record.holder, `${location}.holder`, diagnostics);

  return diagnostics;
}

/**
 * Parse and clone a valid workspace integration record.
 * Lowercases commit ids. Does not mutate input.
 */
export function parseWorkspaceIntegration(
  value: unknown,
  location = "integration",
): { ok: true; value: WorkspaceIntegration } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics = validateWorkspaceIntegration(value, location);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const record = value as Record<string, unknown>;
  const holder = record.holder as Record<string, unknown>;

  const integration: WorkspaceIntegration = {
    schemaVersion: WORKSPACE_INTEGRATION_SCHEMA_VERSION,
    integrationId: (record.integrationId as string).trim(),
    leaseId: (record.leaseId as string).trim(),
    worktreeId: (record.worktreeId as string).trim(),
    holder: {
      familyId: (holder.familyId as string).trim(),
      goalId: (holder.goalId as string).trim(),
      workflowId: (holder.workflowId as string).trim(),
      revision: holder.revision as number,
      nodeId: (holder.nodeId as string).trim(),
      attemptId: (holder.attemptId as string).trim(),
    },
    workerCommitHash: (record.workerCommitHash as string).trim().toLowerCase(),
    baseRevision: (record.baseRevision as string).trim().toLowerCase(),
    status: record.status as WorkspaceIntegrationStatus,
  };

  if (record.integratedCommitHash !== undefined) {
    integration.integratedCommitHash = (record.integratedCommitHash as string)
      .trim()
      .toLowerCase();
  }

  if (record.baseHeadBeforeIntegrate !== undefined) {
    integration.baseHeadBeforeIntegrate = (record.baseHeadBeforeIntegrate as string)
      .trim()
      .toLowerCase();
  }

  if (record.conflict !== undefined) {
    const conflictDiagnostics: Diagnostic[] = [];
    const conflict = validateConflictObject(
      record.conflict,
      `${location}.conflict`,
      conflictDiagnostics,
    );
    if (conflict !== undefined) {
      integration.conflict = {
        conflictingPaths: [...conflict.conflictingPaths],
        ...(conflict.message !== undefined ? { message: conflict.message } : {}),
        ...(conflict.pathsUnavailable === true ? { pathsUnavailable: true } : {}),
      };
    }
  }

  if (record.diagnostics !== undefined) {
    const listDiagnostics: Diagnostic[] = [];
    const list = validateDiagnosticsList(
      record.diagnostics,
      `${location}.diagnostics`,
      listDiagnostics,
    );
    if (list !== undefined) {
      integration.diagnostics = list.map((item) => ({ ...item }));
    }
  }

  if (typeof record.message === "string" && record.message.trim().length > 0) {
    integration.message = record.message.trim();
  }

  return { ok: true, value: integration };
}

/**
 * Reject an unsupported integration-set schema version.
 * Does not validate individual records. Prefer validateWorkspaceIntegrationSet.
 */
export function validateWorkspaceIntegrationSetSchema(
  value: unknown,
  location = "integrationSet",
): Diagnostic[] {
  if (!isStrictPlainObject(value)) {
    return [reject(
      "workspace_integration_set_not_plain_object",
      "Workspace integration set must be a plain object.",
      location,
    )];
  }
  const record = value;
  if (record.schemaVersion !== WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION) {
    return [reject(
      "workspace_integration_set_unsupported_schema",
      `Unsupported workspace integration set schema version '${String(record.schemaVersion)}'. Expected ${WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION}.`,
      `${location}.schemaVersion`,
    )];
  }
  if (!Array.isArray(record.integrations)) {
    return [reject(
      "workspace_integration_set_invalid_integrations",
      "Workspace integration set integrations must be an array.",
      `${location}.integrations`,
    )];
  }
  return [];
}

/**
 * Validate an integration set including every record and cross-record rules.
 * Unique integrationId. At most one active record per leaseId.
 * Does not clone. Does not throw. Returns diagnostics for invalid content.
 */
export function validateWorkspaceIntegrationSet(
  value: unknown,
  location = "integrationSet",
): Diagnostic[] {
  const schemaDiagnostics = validateWorkspaceIntegrationSetSchema(value, location);
  if (schemaDiagnostics.length > 0) {
    return schemaDiagnostics;
  }
  const record = value as Record<string, unknown>;
  const items = record.integrations as unknown[];
  const diagnostics: Diagnostic[] = [];
  const seenIds = new Set<string>();
  const activeLeases = new Set<string>();

  for (let index = 0; index < items.length; index += 1) {
    const itemLocation = `${location}.integrations[${index}]`;
    const itemDiagnostics = validateWorkspaceIntegration(items[index], itemLocation);
    if (itemDiagnostics.length > 0) {
      diagnostics.push(reject(
        "workspace_integration_set_invalid_record",
        `Integration set record at index ${index} is invalid.`,
        itemLocation,
      ));
      diagnostics.push(...itemDiagnostics);
      continue;
    }
    // Parse to read canonical fields for uniqueness checks.
    const parsed = parseWorkspaceIntegration(items[index], itemLocation);
    if (!parsed.ok) {
      diagnostics.push(reject(
        "workspace_integration_set_invalid_record",
        `Integration set record at index ${index} is invalid.`,
        itemLocation,
      ));
      diagnostics.push(...parsed.diagnostics);
      continue;
    }
    if (seenIds.has(parsed.value.integrationId)) {
      diagnostics.push(reject(
        "workspace_integration_duplicate_id",
        `Integration id '${parsed.value.integrationId}' appears more than once in the set.`,
        `${itemLocation}.integrationId`,
      ));
    }
    seenIds.add(parsed.value.integrationId);
    if (isActiveStatus(parsed.value.status)) {
      if (activeLeases.has(parsed.value.leaseId)) {
        diagnostics.push(reject(
          "workspace_integration_duplicate_active_lease",
          `Lease id '${parsed.value.leaseId}' has more than one active integration in the set.`,
          `${itemLocation}.leaseId`,
        ));
      }
      activeLeases.add(parsed.value.leaseId);
    }
  }
  return diagnostics;
}

/**
 * Create an empty integration set.
 */
export function createEmptyWorkspaceIntegrationSet(): WorkspaceIntegrationSet {
  return {
    schemaVersion: WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION,
    integrations: [],
  };
}

/**
 * Clone an integration set. Returns diagnostics when a record is not cloneable.
 * Does not throw for DataCloneError.
 */
function cloneIntegrationSet(
  set: WorkspaceIntegrationSet,
): { ok: true; set: WorkspaceIntegrationSet } | { ok: false; diagnostics: Diagnostic[] } {
  try {
    return {
      ok: true,
      set: {
        schemaVersion: WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION,
        integrations: set.integrations.map((item) => structuredClone(item)),
      },
    };
  } catch {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_set_invalid_record",
        "An integration set record could not be cloned. Records must be structured-cloneable plain data.",
        "integrationSet.integrations",
      )],
    };
  }
}

/**
 * Drop finished records that are not completion markers.
 * Remove conflicted, failed, aborted, and released records that have no
 * integratedCommitHash. Keep pending and integrating records. Keep every
 * record that has integratedCommitHash. Do not mutate the input set.
 */
export function pruneTerminalIntegrations(
  set: WorkspaceIntegrationSet,
):
  | { ok: true; set: WorkspaceIntegrationSet; pruned: number }
  | { ok: false; diagnostics: Diagnostic[] } {
  const validated = validateWorkspaceIntegrationSet(set, "integrationSet");
  if (validated.length > 0) {
    return { ok: false, diagnostics: validated };
  }
  const kept = set.integrations.filter((item) => {
    // Completion markers and active records stay. Terminal rows without a
    // completion marker are removed.
    if (item.integratedCommitHash !== undefined) return true;
    if (item.status === "pending" || item.status === "integrating") return true;
    return false;
  });
  const pruned = set.integrations.length - kept.length;
  try {
    return {
      ok: true,
      set: {
        schemaVersion: WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION,
        integrations: kept.map((item) => structuredClone(item)),
      },
      pruned,
    };
  } catch {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_set_invalid_record",
        "An integration set record could not be cloned during prune.",
        "integrationSet.integrations",
      )],
    };
  }
}

/**
 * Select a distinct already-* diagnostic code for a terminal status.
 */
export function alreadyTerminalDiagnosticCode(
  status: WorkspaceIntegrationStatus,
): string {
  if (status === "integrated") return "workspace_integration_already_integrated";
  if (status === "checking") return "workspace_integration_already_checking";
  if (status === "checks_passed") return "workspace_integration_already_checks_passed";
  if (status === "checks_failed") return "workspace_integration_already_checks_failed";
  if (status === "conflicted") return "workspace_integration_already_conflicted";
  if (status === "failed") return "workspace_integration_already_failed";
  return "workspace_integration_already_terminal";
}

/**
 * Shared cross-entity identity checks for commit, lease, and worktree.
 * Used by proposePendingIntegration and parseIntegrationPreconditions.
 */
export function validateIntegrationCrossEntityIdentity(
  commit: WorkerCommitResult,
  lease: WorkspaceLease,
  worktree: WorkspaceWorktree,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (worktree.leaseId !== lease.leaseId) {
    diagnostics.push(reject(
      "workspace_integration_stale_identity",
      `Worktree leaseId '${worktree.leaseId}' does not match exclusive lease id '${lease.leaseId}'.`,
      "worktree.leaseId",
    ));
  }
  if (!holdersEqual(worktree.holder, lease.holder)) {
    diagnostics.push(reject(
      "workspace_integration_stale_identity",
      "Worktree holder does not match the exclusive lease holder.",
      "worktree.holder",
    ));
  }
  if (commit.worktreeId !== worktree.worktreeId) {
    diagnostics.push(reject(
      "workspace_integration_stale_identity",
      `Worker commit worktreeId '${commit.worktreeId}' does not match worktree id '${worktree.worktreeId}'.`,
      "commit.worktreeId",
    ));
  }
  const worktreeBase = worktree.baseRevision.trim().toLowerCase();
  if (isFullGitObjectId(worktreeBase) && worktreeBase !== commit.baseRevision) {
    diagnostics.push(reject(
      "workspace_integration_stale_identity",
      "Worktree baseRevision does not match the worker commit baseRevision.",
      "worktree.baseRevision",
    ));
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Identity checks
// ---------------------------------------------------------------------------

/**
 * Parse and clone an expected-identity object from untrusted input.
 * Rejects class instances and non-string identity fields.
 * Does not mutate input. Never throws for shape errors.
 */
export function parseWorkspaceIntegrationExpectedIdentity(
  value: unknown,
  location = "expected",
):
  | { ok: true; value: WorkspaceIntegrationExpectedIdentity }
  | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(value)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_expected_identity",
        "Expected identity must be a plain object when present.",
        location,
      )],
    };
  }

  const record = value;
  const diagnostics: Diagnostic[] = [];
  const result: WorkspaceIntegrationExpectedIdentity = {};

  const stringFields: Array<
    keyof Pick<
      WorkspaceIntegrationExpectedIdentity,
      | "integrationId"
      | "leaseId"
      | "worktreeId"
      | "workerCommitHash"
      | "baseRevision"
      | "integratedCommitHash"
    >
  > = [
    "integrationId",
    "leaseId",
    "worktreeId",
    "workerCommitHash",
    "baseRevision",
    "integratedCommitHash",
  ];

  for (const field of stringFields) {
    if (record[field] === undefined) continue;
    if (typeof record[field] !== "string") {
      diagnostics.push(reject(
        "workspace_integration_invalid_expected_identity",
        `Expected identity.${field} must be a string when present.`,
        `${location}.${field}`,
      ));
      continue;
    }
    const trimmed = (record[field] as string).trim();
    if (trimmed.length === 0) {
      diagnostics.push(reject(
        "workspace_integration_invalid_expected_identity",
        `Expected identity.${field} must be a non-empty string when present.`,
        `${location}.${field}`,
      ));
      continue;
    }
    if (
      (field === "workerCommitHash"
        || field === "baseRevision"
        || field === "integratedCommitHash")
      && !isFullGitObjectId(trimmed)
    ) {
      diagnostics.push(reject(
        "workspace_integration_invalid_expected_identity",
        `Expected identity.${field} must be a full git object id when present.`,
        `${location}.${field}`,
      ));
      continue;
    }
    result[field] = field === "workerCommitHash"
      || field === "baseRevision"
      || field === "integratedCommitHash"
      ? trimmed.toLowerCase()
      : trimmed;
  }

  if (record.holder !== undefined) {
    const holder = validateHolder(record.holder, `${location}.holder`, diagnostics);
    if (holder !== undefined) {
      result.holder = holder;
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return { ok: true, value: result };
}

/**
 * Report whether an integration matches expected identity fields.
 * Present expected fields must match. Omitted fields are not checked.
 * Does not mutate inputs.
 */
export function integrationMatchesExpectedIdentity(
  integration: WorkspaceIntegration,
  expected: WorkspaceIntegrationExpectedIdentity,
): boolean {
  const parsed = parseWorkspaceIntegrationExpectedIdentity(expected, "expected");
  if (!parsed.ok) return false;
  const safe = parsed.value;
  if (safe.integrationId !== undefined) {
    if (integration.integrationId !== safe.integrationId) return false;
  }
  if (safe.leaseId !== undefined) {
    if (integration.leaseId !== safe.leaseId) return false;
  }
  if (safe.worktreeId !== undefined) {
    if (integration.worktreeId !== safe.worktreeId) return false;
  }
  if (safe.holder !== undefined) {
    if (!holdersEqual(integration.holder, safe.holder)) return false;
  }
  if (safe.workerCommitHash !== undefined) {
    if (integration.workerCommitHash !== safe.workerCommitHash) return false;
  }
  if (safe.baseRevision !== undefined) {
    if (integration.baseRevision !== safe.baseRevision) return false;
  }
  if (safe.integratedCommitHash !== undefined) {
    if (
      integration.integratedCommitHash === undefined
      || integration.integratedCommitHash !== safe.integratedCommitHash
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Validate identity against expected fields. Returns diagnostics when stale.
 * Accepts a typed expected object or untrusted unknown shape.
 * Does not mutate inputs. Never throws for shape errors.
 */
export function validateIntegrationIdentity(
  integration: WorkspaceIntegration,
  expected: WorkspaceIntegrationExpectedIdentity | unknown,
  location = "integration",
): Diagnostic[] {
  const parsed = parseWorkspaceIntegrationExpectedIdentity(expected, "expected");
  if (!parsed.ok) {
    return parsed.diagnostics;
  }
  const safe = parsed.value;
  const diagnostics: Diagnostic[] = [];

  if (safe.integrationId !== undefined) {
    if (integration.integrationId !== safe.integrationId) {
      diagnostics.push(reject(
        "workspace_integration_stale_identity",
        `Integration id '${integration.integrationId}' does not match expected id '${safe.integrationId}'.`,
        `${location}.integrationId`,
      ));
    }
  }

  if (safe.leaseId !== undefined) {
    if (integration.leaseId !== safe.leaseId) {
      diagnostics.push(reject(
        "workspace_integration_stale_identity",
        `Integration leaseId '${integration.leaseId}' does not match expected leaseId '${safe.leaseId}'.`,
        `${location}.leaseId`,
      ));
    }
  }

  if (safe.worktreeId !== undefined) {
    if (integration.worktreeId !== safe.worktreeId) {
      diagnostics.push(reject(
        "workspace_integration_stale_identity",
        `Integration worktreeId '${integration.worktreeId}' does not match expected worktreeId '${safe.worktreeId}'.`,
        `${location}.worktreeId`,
      ));
    }
  }

  if (safe.holder !== undefined) {
    if (!holdersEqual(integration.holder, safe.holder)) {
      diagnostics.push(reject(
        "workspace_integration_stale_identity",
        "Integration holder does not match the expected lease holder.",
        `${location}.holder`,
      ));
    }
  }

  if (safe.workerCommitHash !== undefined) {
    if (integration.workerCommitHash !== safe.workerCommitHash) {
      diagnostics.push(reject(
        "workspace_integration_stale_identity",
        "Integration workerCommitHash does not match the expected worker commit.",
        `${location}.workerCommitHash`,
      ));
    }
  }

  if (safe.baseRevision !== undefined) {
    if (integration.baseRevision !== safe.baseRevision) {
      diagnostics.push(reject(
        "workspace_integration_stale_identity",
        "Integration baseRevision does not match the expected base revision.",
        `${location}.baseRevision`,
      ));
    }
  }

  if (safe.integratedCommitHash !== undefined) {
    if (
      integration.integratedCommitHash === undefined
      || integration.integratedCommitHash !== safe.integratedCommitHash
    ) {
      diagnostics.push(reject(
        "workspace_integration_stale_identity",
        "Integration integratedCommitHash does not match the expected integrated commit.",
        `${location}.integratedCommitHash`,
      ));
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Registry list / get
// ---------------------------------------------------------------------------

/**
 * List integration records as deep clones.
 * Validates every record. Returns diagnostics when the set is invalid or not cloneable.
 */
export function listIntegrations(
  set: WorkspaceIntegrationSet,
): WorkspaceIntegrationListResult {
  const setDiagnostics = validateWorkspaceIntegrationSet(set, "integrationSet");
  if (setDiagnostics.length > 0) {
    return { ok: false, diagnostics: setDiagnostics };
  }
  const cloned = cloneIntegrationSet(set);
  if (!cloned.ok) {
    return { ok: false, diagnostics: cloned.diagnostics };
  }
  return {
    ok: true,
    integrations: cloned.set.integrations
      .sort((left, right) => left.integrationId.localeCompare(right.integrationId)),
  };
}

/**
 * Return a deep clone of one integration by id, or undefined when absent.
 */
export function getIntegration(
  set: WorkspaceIntegrationSet,
  integrationId: string,
): WorkspaceIntegrationGetResult {
  const setDiagnostics = validateWorkspaceIntegrationSet(set, "integrationSet");
  if (setDiagnostics.length > 0) {
    return { ok: false, diagnostics: setDiagnostics };
  }
  if (typeof integrationId !== "string") {
    return { ok: true, integration: undefined };
  }
  const id = integrationId.trim();
  if (id.length === 0) return { ok: true, integration: undefined };
  const found = set.integrations.find((item) => item.integrationId === id);
  if (found === undefined) {
    return { ok: true, integration: undefined };
  }
  try {
    return { ok: true, integration: structuredClone(found) };
  } catch {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_set_invalid_record",
        "Integration record could not be cloned.",
        "integration",
      )],
    };
  }
}

/**
 * Return a deep clone of the active integration for a lease, or undefined.
 */
export function getActiveIntegrationForLease(
  set: WorkspaceIntegrationSet,
  leaseId: string,
): WorkspaceIntegrationGetResult {
  const setDiagnostics = validateWorkspaceIntegrationSet(set, "integrationSet");
  if (setDiagnostics.length > 0) {
    return { ok: false, diagnostics: setDiagnostics };
  }
  if (typeof leaseId !== "string") {
    return { ok: true, integration: undefined };
  }
  const id = leaseId.trim();
  if (id.length === 0) return { ok: true, integration: undefined };
  const found = set.integrations.find(
    (item) => item.leaseId === id && isActiveStatus(item.status),
  );
  if (found === undefined) {
    return { ok: true, integration: undefined };
  }
  try {
    return { ok: true, integration: structuredClone(found) };
  } catch {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_set_invalid_record",
        "Integration record could not be cloned.",
        "integration",
      )],
    };
  }
}

// ---------------------------------------------------------------------------
// Propose and register
// ---------------------------------------------------------------------------

/**
 * Build a pending integration from validated pre-integration clones.
 * Pure construction and validation only. Does not mutate inputs.
 */
export function proposePendingIntegration(input: {
  validated: ValidatedWorkerResultForIntegration;
  worktree: WorkspaceWorktree;
  integrationId?: string;
}): { ok: true; value: WorkspaceIntegration } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(input as unknown)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_input_not_plain_object",
        "Integration proposal input must be a plain object.",
        "input",
      )],
    };
  }

  const record = input as Record<string, unknown>;
  if (!isStrictPlainObject(record.validated)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_input_not_plain_object",
        "Integration proposal validated must be a plain object with commit and lease.",
        "input.validated",
      )],
    };
  }
  const validatedInput = record.validated as Record<string, unknown>;
  if (validatedInput.commit === undefined || validatedInput.lease === undefined) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_input_not_plain_object",
        "Integration proposal validated must include commit and lease.",
        "input.validated",
      )],
    };
  }

  const worktreeParsed = parseWorkspaceWorktree(input.worktree, "worktree");
  if (!worktreeParsed.ok) {
    return { ok: false, diagnostics: worktreeParsed.diagnostics };
  }
  const worktree = worktreeParsed.value;

  if (worktree.status !== "ready") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_worktree_not_ready",
        `Worktree status must be 'ready' for integration. Found '${worktree.status}'.`,
        "worktree.status",
      )],
    };
  }

  // Re-run exclusive lease + clean commit validation on the provided clones.
  const revalidated = validateWorkerResultForIntegration({
    commit: validatedInput.commit,
    lease: validatedInput.lease,
    expected: { worktreeId: worktree.worktreeId },
    ...(validatedInput.executorResult !== undefined
      ? { executorResult: validatedInput.executorResult }
      : {}),
  });
  if (!revalidated.ok) {
    return { ok: false, diagnostics: revalidated.diagnostics };
  }

  const { commit, lease } = revalidated.value;

  const crossEntity = validateIntegrationCrossEntityIdentity(commit, lease, worktree);
  if (crossEntity.length > 0) {
    return { ok: false, diagnostics: crossEntity };
  }

  const integrationId = input.integrationId !== undefined
    ? input.integrationId
    : deriveIntegrationId(lease.leaseId);

  return parseWorkspaceIntegration({
    schemaVersion: WORKSPACE_INTEGRATION_SCHEMA_VERSION,
    integrationId,
    leaseId: lease.leaseId,
    worktreeId: worktree.worktreeId,
    holder: {
      familyId: lease.holder.familyId,
      goalId: lease.holder.goalId,
      workflowId: lease.holder.workflowId,
      revision: lease.holder.revision,
      nodeId: lease.holder.nodeId,
      attemptId: lease.holder.attemptId,
    },
    workerCommitHash: commit.commitHash,
    baseRevision: commit.baseRevision,
    status: "pending",
  }, "integration");
}

/**
 * Propose a pending integration from untrusted commit, lease, and worktree.
 * Runs validateWorkerResultForIntegration first. Does not mutate inputs.
 */
export function proposePendingIntegrationFromParts(input: {
  commit: unknown;
  lease: unknown;
  worktree: unknown;
  integrationId?: string;
}): { ok: true; value: WorkspaceIntegration } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(input as unknown)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_input_not_plain_object",
        "Integration proposal input must be a plain object.",
        "input",
      )],
    };
  }

  const worktreeParsed = parseWorkspaceWorktree(input.worktree, "worktree");
  if (!worktreeParsed.ok) {
    return { ok: false, diagnostics: worktreeParsed.diagnostics };
  }

  const validated = validateWorkerResultForIntegration({
    commit: input.commit,
    lease: input.lease,
    expected: { worktreeId: worktreeParsed.value.worktreeId },
  });
  if (!validated.ok) {
    return { ok: false, diagnostics: validated.diagnostics };
  }

  return proposePendingIntegration({
    validated: validated.value,
    worktree: worktreeParsed.value,
    ...(input.integrationId !== undefined
      ? { integrationId: input.integrationId }
      : {}),
  });
}

/**
 * Register an integration into a new set.
 * Enforces unique integrationId and one active integration per leaseId.
 * Rejects shared-lease payloads through validation on the candidate.
 * Does not mutate inputs.
 */
export function registerIntegration(
  set: WorkspaceIntegrationSet,
  candidate: unknown,
  bounds?: WorkspaceIntegrationBounds,
): WorkspaceIntegrationRegisterResult {
  const resolvedBounds = resolveIntegrationBounds(bounds);
  if (!resolvedBounds.ok) {
    return { ok: false, diagnostics: resolvedBounds.diagnostics };
  }
  const { maxIntegrations, maxRetainedIntegrations } = resolvedBounds;

  const setDiagnostics = validateWorkspaceIntegrationSet(set, "integrationSet");
  if (setDiagnostics.length > 0) {
    return { ok: false, diagnostics: setDiagnostics };
  }

  const parsed = parseWorkspaceIntegration(candidate, "integration");
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  const integration = parsed.value;

  // Permanent block only when integration completed (integratedCommitHash set).
  const completedSameAttempt = set.integrations.find(
    (item) =>
      item.leaseId === integration.leaseId
      && item.workerCommitHash === integration.workerCommitHash
      && item.integratedCommitHash !== undefined,
  );
  if (completedSameAttempt) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_already_integrated",
        `Lease id '${integration.leaseId}' already integrated worker commit via '${completedSameAttempt.integrationId}'.`,
        "integration.leaseId",
      )],
    };
  }

  // Conflicted blocks until resolved. Call pruneTerminalIntegrations after resolve
  // or keep a new integrationId after the conflict is cleared from the base.
  const conflictedSameAttempt = set.integrations.find(
    (item) =>
      item.leaseId === integration.leaseId
      && item.workerCommitHash === integration.workerCommitHash
      && item.status === "conflicted",
  );
  if (conflictedSameAttempt) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_already_conflicted",
        `Lease id '${integration.leaseId}' has conflicted integration '${conflictedSameAttempt.integrationId}'. Resolve the base conflict, then call pruneTerminalIntegrations, or use a new worker commit.`,
        "integration.leaseId",
      )],
    };
  }

  // Supersede failed/aborted/released rows for the same lease+worker (no completion marker).
  // Also drop same integrationId when it is supersedable so derived ids can retry.
  const supersedable = (item: WorkspaceIntegration): boolean => {
    if (item.integratedCommitHash !== undefined) return false;
    if (item.status === "failed" || item.status === "aborted" || item.status === "released") {
      return (
        (item.leaseId === integration.leaseId
          && item.workerCommitHash === integration.workerCommitHash)
        || item.integrationId === integration.integrationId
      );
    }
    return false;
  };

  const workingRows = set.integrations.filter((item) => !supersedable(item));

  if (workingRows.some((item) => item.integrationId === integration.integrationId)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_duplicate_id",
        `Integration id '${integration.integrationId}' is already registered.`,
        "integration.integrationId",
      )],
    };
  }

  const activeCount = workingRows.filter((item) => isActiveStatus(item.status)).length;
  if (isActiveStatus(integration.status) && activeCount >= maxIntegrations) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_active_limit",
        `The integration set must not exceed ${maxIntegrations} active records. Call pruneTerminalIntegrations to drop finished records, or raise bounds.maxIntegrations.`,
        "integrationSet.integrations",
      )],
    };
  }

  if (workingRows.length + 1 > maxRetainedIntegrations) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_retained_limit",
        `The integration set must not exceed ${maxRetainedIntegrations} retained records. Call pruneTerminalIntegrations or raise bounds.maxRetainedIntegrations.`,
        "integrationSet.integrations",
      )],
    };
  }

  if (isActiveStatus(integration.status)) {
    const activeForLease = workingRows.find(
      (item) => item.leaseId === integration.leaseId && isActiveStatus(item.status),
    );
    if (activeForLease) {
      return {
        ok: false,
        diagnostics: [reject(
          "workspace_integration_duplicate_active_lease",
          `Lease id '${integration.leaseId}' already has active integration '${activeForLease.integrationId}'.`,
          "integration.leaseId",
        )],
      };
    }
  }

  try {
    const next: WorkspaceIntegrationSet = {
      schemaVersion: WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION,
      integrations: workingRows.map((item) => structuredClone(item)),
    };
    next.integrations.push(structuredClone(integration));
    next.integrations.sort((left, right) =>
      left.integrationId.localeCompare(right.integrationId),
    );
    return {
      ok: true,
      set: next,
      integration: structuredClone(integration),
    };
  } catch {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_set_invalid_record",
        "Integration candidate could not be cloned.",
        "integration",
      )],
    };
  }
}

/**
 * Validate, propose pending, and register in one step.
 * Does not mutate inputs.
 */
export function registerPendingIntegration(
  set: WorkspaceIntegrationSet,
  input: {
    commit: unknown;
    lease: unknown;
    worktree: unknown;
    integrationId?: string;
  },
  bounds?: WorkspaceIntegrationBounds,
): WorkspaceIntegrationRegisterResult {
  const proposed = proposePendingIntegrationFromParts(input);
  if (!proposed.ok) {
    return { ok: false, diagnostics: proposed.diagnostics };
  }
  return registerIntegration(set, proposed.value, bounds);
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function findIntegrationIndex(
  set: WorkspaceIntegrationSet,
  integrationId: string,
): number {
  const id = integrationId.trim();
  return set.integrations.findIndex((item) => item.integrationId === id);
}

/**
 * Validate the set deeply, then clone it for a transition.
 */
function openSetClone(
  set: WorkspaceIntegrationSet,
): { ok: true; set: WorkspaceIntegrationSet } | { ok: false; diagnostics: Diagnostic[] } {
  const setDiagnostics = validateWorkspaceIntegrationSet(set, "integrationSet");
  if (setDiagnostics.length > 0) {
    return { ok: false, diagnostics: setDiagnostics };
  }
  return cloneIntegrationSet(set);
}

/**
 * Mark an integration as integrating.
 * Must be durable before the host mutates the base workspace.
 * Accepts pending. Rejects other statuses (except idempotent integrating).
 * Optional baseHeadBeforeIntegrate records the base HEAD when integrating
 * started. Resume uses current-state evidence, not this field alone.
 * Does not mutate the input set.
 */
export function markIntegrationIntegrating(
  set: WorkspaceIntegrationSet,
  integrationId: string,
  expected?: WorkspaceIntegrationExpectedIdentity,
  options?: { baseHeadBeforeIntegrate?: string },
): WorkspaceIntegrationTransitionResult {
  const opened = openSetClone(set);
  if (!opened.ok) {
    return { ok: false, diagnostics: opened.diagnostics };
  }

  if (typeof integrationId !== "string" || integrationId.trim().length === 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_id",
        "integrationId must be a non-empty string.",
        "integrationId",
      )],
    };
  }

  let baseHead: string | undefined;
  if (options?.baseHeadBeforeIntegrate !== undefined) {
    if (
      typeof options.baseHeadBeforeIntegrate !== "string"
      || !isFullGitObjectId(options.baseHeadBeforeIntegrate.trim())
    ) {
      return {
        ok: false,
        diagnostics: [reject(
          "workspace_integration_invalid_base_head_before",
          "baseHeadBeforeIntegrate must be a full git object id when present.",
          "baseHeadBeforeIntegrate",
        )],
      };
    }
    baseHead = options.baseHeadBeforeIntegrate.trim().toLowerCase();
  }

  const index = findIntegrationIndex(opened.set, integrationId);
  if (index < 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_not_found",
        `Integration id '${integrationId.trim()}' was not found.`,
        "integrationId",
      )],
    };
  }

  const current = opened.set.integrations[index]!;

  if (expected !== undefined) {
    const identityDiagnostics = validateIntegrationIdentity(current, expected);
    if (identityDiagnostics.length > 0) {
      return { ok: false, diagnostics: identityDiagnostics };
    }
  }

  // Idempotent when already integrating with matching identity.
  // Fill baseHeadBeforeIntegrate only when it was missing.
  if (current.status === "integrating") {
    if (
      baseHead !== undefined
      && current.baseHeadBeforeIntegrate === undefined
    ) {
      const filled: WorkspaceIntegration = {
        ...structuredClone(current),
        baseHeadBeforeIntegrate: baseHead,
      };
      opened.set.integrations[index] = filled;
      return {
        ok: true,
        set: opened.set,
        integration: structuredClone(filled),
      };
    }
    return {
      ok: true,
      set: opened.set,
      integration: structuredClone(current),
    };
  }

  if (current.status !== "pending") {
    const code = isTerminalStatus(current.status)
      ? alreadyTerminalDiagnosticCode(current.status)
      : "workspace_integration_invalid_transition";
    return {
      ok: false,
      diagnostics: [reject(
        code,
        `Cannot mark integrating from status '${current.status}'. Expected 'pending'.`,
        "integration.status",
      )],
    };
  }

  const updated: WorkspaceIntegration = {
    ...structuredClone(current),
    status: "integrating",
  };
  delete updated.integratedCommitHash;
  delete updated.conflict;
  delete updated.diagnostics;
  delete updated.message;
  if (baseHead !== undefined) {
    updated.baseHeadBeforeIntegrate = baseHead;
  } else {
    delete updated.baseHeadBeforeIntegrate;
  }
  opened.set.integrations[index] = updated;
  return {
    ok: true,
    set: opened.set,
    integration: structuredClone(updated),
  };
}

/**
 * Mark an integration as integrated with the resulting base commit hash.
 * Accepts integrating. Idempotent when already integrated with the same hash.
 * Does not mutate the input set.
 */
export function markIntegrationIntegrated(
  set: WorkspaceIntegrationSet,
  integrationId: string,
  integratedCommitHash: string,
  expected?: WorkspaceIntegrationExpectedIdentity,
): WorkspaceIntegrationTransitionResult {
  const opened = openSetClone(set);
  if (!opened.ok) {
    return { ok: false, diagnostics: opened.diagnostics };
  }

  if (typeof integrationId !== "string" || integrationId.trim().length === 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_id",
        "integrationId must be a non-empty string.",
        "integrationId",
      )],
    };
  }

  if (
    typeof integratedCommitHash !== "string"
    || !isFullGitObjectId(integratedCommitHash.trim())
  ) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_integrated_commit_hash",
        "integratedCommitHash must be a full git object id.",
        "integratedCommitHash",
      )],
    };
  }

  const hash = integratedCommitHash.trim().toLowerCase();
  const index = findIntegrationIndex(opened.set, integrationId);
  if (index < 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_not_found",
        `Integration id '${integrationId.trim()}' was not found.`,
        "integrationId",
      )],
    };
  }

  const current = opened.set.integrations[index]!;

  if (expected !== undefined) {
    const identityDiagnostics = validateIntegrationIdentity(current, expected);
    if (identityDiagnostics.length > 0) {
      return { ok: false, diagnostics: identityDiagnostics };
    }
  }

  // Idempotent success when already integrated with the same resulting commit.
  // Post-integration check statuses with the same hash also count as already
  // integrated.
  if (
    current.status === "integrated"
    || current.status === "checking"
    || current.status === "checks_passed"
    || current.status === "checks_failed"
  ) {
    if (current.integratedCommitHash === hash) {
      if (current.status === "integrated") {
        return {
          ok: true,
          set: opened.set,
          integration: structuredClone(current),
        };
      }
      return {
        ok: false,
        diagnostics: [reject(
          alreadyTerminalDiagnosticCode(current.status),
          `Integration '${current.integrationId}' already completed integrate and is in status '${current.status}'.`,
          "integration.status",
        )],
      };
    }
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_already_integrated",
        `Integration '${current.integrationId}' is already integrated with a different commit hash.`,
        "integration.status",
      )],
    };
  }

  if (current.status === "conflicted" || current.status === "failed") {
    return {
      ok: false,
      diagnostics: [reject(
        alreadyTerminalDiagnosticCode(current.status),
        `Cannot mark integrated from status '${current.status}'.`,
        "integration.status",
      )],
    };
  }

  if (current.status !== "integrating") {
    const code = isTerminalStatus(current.status)
      ? alreadyTerminalDiagnosticCode(current.status)
      : "workspace_integration_invalid_transition";
    return {
      ok: false,
      diagnostics: [reject(
        code,
        `Cannot mark integrated from status '${current.status}'. Expected 'integrating'.`,
        "integration.status",
      )],
    };
  }

  const updated: WorkspaceIntegration = {
    ...structuredClone(current),
    status: "integrated",
    integratedCommitHash: hash,
  };
  delete updated.conflict;
  delete updated.diagnostics;
  delete updated.message;
  opened.set.integrations[index] = updated;
  return {
    ok: true,
    set: opened.set,
    integration: structuredClone(updated),
  };
}

/**
 * Mark an integration as conflicted with explicit conflict paths.
 * Never treats conflict as integrated. Does not mutate the input set.
 */
export function markIntegrationConflicted(
  set: WorkspaceIntegrationSet,
  integrationId: string,
  conflict: {
    conflictingPaths: readonly string[];
    message?: string;
    pathsUnavailable?: boolean;
  },
  expected?: WorkspaceIntegrationExpectedIdentity,
): WorkspaceIntegrationTransitionResult {
  const opened = openSetClone(set);
  if (!opened.ok) {
    return { ok: false, diagnostics: opened.diagnostics };
  }

  if (typeof integrationId !== "string" || integrationId.trim().length === 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_id",
        "integrationId must be a non-empty string.",
        "integrationId",
      )],
    };
  }

  if (!isStrictPlainObject(conflict as unknown)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_conflict",
        "conflict must be a plain object.",
        "conflict",
      )],
    };
  }

  const conflictDiagnostics: Diagnostic[] = [];
  const parsedConflict = validateConflictObject(
    {
      conflictingPaths: Array.isArray(conflict.conflictingPaths)
        ? [...conflict.conflictingPaths]
        : conflict.conflictingPaths,
      ...(conflict.message !== undefined ? { message: conflict.message } : {}),
      ...(conflict.pathsUnavailable === true ? { pathsUnavailable: true } : {}),
    },
    "conflict",
    conflictDiagnostics,
  );
  if (parsedConflict === undefined) {
    return {
      ok: false,
      diagnostics: conflictDiagnostics.length > 0
        ? conflictDiagnostics
        : [reject(
          "workspace_integration_invalid_conflict",
          "conflict details are invalid.",
          "conflict",
        )],
    };
  }

  const index = findIntegrationIndex(opened.set, integrationId);
  if (index < 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_not_found",
        `Integration id '${integrationId.trim()}' was not found.`,
        "integrationId",
      )],
    };
  }

  const current = opened.set.integrations[index]!;

  if (expected !== undefined) {
    const identityDiagnostics = validateIntegrationIdentity(current, expected);
    if (identityDiagnostics.length > 0) {
      return { ok: false, diagnostics: identityDiagnostics };
    }
  }

  if (current.status === "integrated") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_already_integrated",
        "Cannot mark conflicted: integration is already integrated.",
        "integration.status",
      )],
    };
  }

  if (current.status === "conflicted") {
    const existing = current.conflict?.conflictingPaths ?? [];
    const samePaths = existing.length === parsedConflict.conflictingPaths.length
      && existing.every((path, i) => path === parsedConflict.conflictingPaths[i]);
    if (samePaths) {
      return {
        ok: true,
        set: opened.set,
        integration: structuredClone(current),
      };
    }
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_already_conflicted",
        "Integration is already conflicted with different conflict details.",
        "integration.status",
      )],
    };
  }

  if (current.status !== "integrating" && current.status !== "pending") {
    const code = isTerminalStatus(current.status)
      ? alreadyTerminalDiagnosticCode(current.status)
      : "workspace_integration_invalid_transition";
    return {
      ok: false,
      diagnostics: [reject(
        code,
        `Cannot mark conflicted from status '${current.status}'. Expected 'integrating' or 'pending'.`,
        "integration.status",
      )],
    };
  }

  const updated: WorkspaceIntegration = {
    ...structuredClone(current),
    status: "conflicted",
    conflict: {
      conflictingPaths: [...parsedConflict.conflictingPaths],
      ...(parsedConflict.message !== undefined
        ? { message: parsedConflict.message }
        : {}),
      ...(parsedConflict.pathsUnavailable === true
        ? { pathsUnavailable: true }
        : {}),
    },
  };
  delete updated.integratedCommitHash;
  delete updated.diagnostics;
  if (parsedConflict.message !== undefined) {
    updated.message = parsedConflict.message;
  } else {
    delete updated.message;
  }
  opened.set.integrations[index] = updated;
  return {
    ok: true,
    set: opened.set,
    integration: structuredClone(updated),
  };
}

/**
 * Mark an integration as failed with diagnostics.
 * Does not mutate the input set.
 */
export function markIntegrationFailed(
  set: WorkspaceIntegrationSet,
  integrationId: string,
  failureDiagnostics: readonly Diagnostic[],
  message?: string,
  expected?: WorkspaceIntegrationExpectedIdentity,
): WorkspaceIntegrationTransitionResult {
  const opened = openSetClone(set);
  if (!opened.ok) {
    return { ok: false, diagnostics: opened.diagnostics };
  }

  if (typeof integrationId !== "string" || integrationId.trim().length === 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_id",
        "integrationId must be a non-empty string.",
        "integrationId",
      )],
    };
  }

  if (!Array.isArray(failureDiagnostics)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_diagnostics",
        "failure diagnostics must be an array.",
        "diagnostics",
      )],
    };
  }

  const listDiagnostics: Diagnostic[] = [];
  const parsedList = validateDiagnosticsList(
    failureDiagnostics.map((item) => ({ ...item })),
    "diagnostics",
    listDiagnostics,
  );
  if (parsedList === undefined) {
    return {
      ok: false,
      diagnostics: listDiagnostics.length > 0
        ? listDiagnostics
        : [reject(
          "workspace_integration_invalid_diagnostics",
          "failure diagnostics are invalid.",
          "diagnostics",
        )],
    };
  }

  const index = findIntegrationIndex(opened.set, integrationId);
  if (index < 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_not_found",
        `Integration id '${integrationId.trim()}' was not found.`,
        "integrationId",
      )],
    };
  }

  const current = opened.set.integrations[index]!;

  if (expected !== undefined) {
    const identityDiagnostics = validateIntegrationIdentity(current, expected);
    if (identityDiagnostics.length > 0) {
      return { ok: false, diagnostics: identityDiagnostics };
    }
  }

  if (
    current.status === "integrated"
    || current.status === "checking"
    || current.status === "checks_passed"
    || current.status === "checks_failed"
    || current.status === "conflicted"
  ) {
    return {
      ok: false,
      diagnostics: [reject(
        alreadyTerminalDiagnosticCode(current.status),
        `Cannot mark failed from status '${current.status}'.`,
        "integration.status",
      )],
    };
  }

  // Idempotent when already failed.
  if (current.status === "failed") {
    return {
      ok: true,
      set: opened.set,
      integration: structuredClone(current),
    };
  }

  if (current.status !== "integrating" && current.status !== "pending") {
    const code = isTerminalStatus(current.status)
      ? alreadyTerminalDiagnosticCode(current.status)
      : "workspace_integration_invalid_transition";
    return {
      ok: false,
      diagnostics: [reject(
        code,
        `Cannot mark failed from status '${current.status}'. Expected 'integrating' or 'pending'.`,
        "integration.status",
      )],
    };
  }

  const updated: WorkspaceIntegration = {
    ...structuredClone(current),
    status: "failed",
    diagnostics: parsedList.map((item) => ({ ...item })),
  };
  delete updated.integratedCommitHash;
  delete updated.conflict;
  if (typeof message === "string" && message.trim().length > 0) {
    updated.message = message.trim();
  } else if (parsedList[0] !== undefined) {
    updated.message = parsedList[0].message;
  } else {
    delete updated.message;
  }
  opened.set.integrations[index] = updated;
  return {
    ok: true,
    set: opened.set,
    integration: structuredClone(updated),
  };
}

/**
 * Mark an integration as aborted.
 * Accepts only pending or integrating. Rejects integrated, checking,
 * checks_passed, checks_failed, conflicted, failed, and released so failure
 * diagnostics and completion identity survive.
 * Idempotent for aborted. Does not mutate the input set.
 */
export function markIntegrationAborted(
  set: WorkspaceIntegrationSet,
  integrationId: string,
  message?: string,
  expected?: WorkspaceIntegrationExpectedIdentity,
): WorkspaceIntegrationTransitionResult {
  const opened = openSetClone(set);
  if (!opened.ok) {
    return { ok: false, diagnostics: opened.diagnostics };
  }

  if (typeof integrationId !== "string" || integrationId.trim().length === 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_id",
        "integrationId must be a non-empty string.",
        "integrationId",
      )],
    };
  }

  const index = findIntegrationIndex(opened.set, integrationId);
  if (index < 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_not_found",
        `Integration id '${integrationId.trim()}' was not found.`,
        "integrationId",
      )],
    };
  }

  const current = opened.set.integrations[index]!;

  if (expected !== undefined) {
    const identityDiagnostics = validateIntegrationIdentity(current, expected);
    if (identityDiagnostics.length > 0) {
      return { ok: false, diagnostics: identityDiagnostics };
    }
  }

  if (
    current.status === "integrated"
    || current.status === "checking"
    || current.status === "checks_passed"
    || current.status === "checks_failed"
    || current.status === "conflicted"
    || current.status === "failed"
    || current.status === "released"
  ) {
    return {
      ok: false,
      diagnostics: [reject(
        alreadyTerminalDiagnosticCode(current.status),
        `Cannot mark aborted from status '${current.status}'.`,
        "integration.status",
      )],
    };
  }

  if (current.status === "aborted") {
    return {
      ok: true,
      set: opened.set,
      integration: structuredClone(current),
    };
  }

  if (current.status !== "pending" && current.status !== "integrating") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_transition",
        `Cannot mark aborted from status '${current.status}'. Expected 'pending' or 'integrating'.`,
        "integration.status",
      )],
    };
  }

  const updated: WorkspaceIntegration = {
    ...structuredClone(current),
    status: "aborted",
  };
  delete updated.integratedCommitHash;
  delete updated.conflict;
  delete updated.diagnostics;
  if (typeof message === "string" && message.trim().length > 0) {
    updated.message = message.trim();
  } else {
    delete updated.message;
  }
  opened.set.integrations[index] = updated;
  return {
    ok: true,
    set: opened.set,
    integration: structuredClone(updated),
  };
}

/**
 * Options for starting the post-integration check phase.
 */
export interface MarkIntegrationCheckingOptions {
  /**
   * When true, permit resume from status checking after the caller asserts
   * that no host runner is active. Use this only for crash recovery.
   * Default false. A second concurrent host runner must not use this flag.
   */
  allowResume?: boolean;
}

/**
 * Mark an integration as checking (post-integration checks in progress).
 * Accepts integrated. Rejects status checking unless allowResume is true
 * (recovery path only). Rejects other statuses. Does not mutate the input set.
 */
export function markIntegrationChecking(
  set: WorkspaceIntegrationSet,
  integrationId: string,
  expected?: WorkspaceIntegrationExpectedIdentity,
  options?: MarkIntegrationCheckingOptions,
): WorkspaceIntegrationTransitionResult {
  const opened = openSetClone(set);
  if (!opened.ok) {
    return { ok: false, diagnostics: opened.diagnostics };
  }

  if (typeof integrationId !== "string" || integrationId.trim().length === 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_id",
        "integrationId must be a non-empty string.",
        "integrationId",
      )],
    };
  }

  const index = findIntegrationIndex(opened.set, integrationId);
  if (index < 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_not_found",
        `Integration id '${integrationId.trim()}' was not found.`,
        "integrationId",
      )],
    };
  }

  const current = opened.set.integrations[index]!;

  if (expected !== undefined) {
    const identityDiagnostics = validateIntegrationIdentity(current, expected);
    if (identityDiagnostics.length > 0) {
      return { ok: false, diagnostics: identityDiagnostics };
    }
  }

  // Status checking means post-integration checks are in progress.
  // Reject a second start unless allowResume is true for recovery.
  if (current.status === "checking") {
    if (options?.allowResume === true) {
      return {
        ok: true,
        set: opened.set,
        integration: structuredClone(current),
      };
    }
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_already_checking",
        "Post-integration checks are already in progress. "
          + "A concurrent second start is not permitted. "
          + "Set allowResume only after crash recovery when no host runner is active.",
        "integration.status",
      )],
    };
  }

  // Status checks_passed is not a valid start of the check phase.
  if (current.status === "checks_passed") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_already_checks_passed",
        "Post-integration checks already passed. Cannot start checking again.",
        "integration.status",
      )],
    };
  }

  if (current.status === "checks_failed") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_already_checks_failed",
        "Post-integration checks already failed. Cannot start checking again from this record.",
        "integration.status",
      )],
    };
  }

  if (current.status !== "integrated") {
    const code = isTerminalStatus(current.status)
      ? alreadyTerminalDiagnosticCode(current.status)
      : "workspace_integration_invalid_transition";
    return {
      ok: false,
      diagnostics: [reject(
        code,
        `Cannot start post-integration checks from status '${current.status}'. Expected 'integrated'.`,
        "integration.status",
      )],
    };
  }

  if (
    current.integratedCommitHash === undefined
    || !isFullGitObjectId(current.integratedCommitHash)
  ) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_missing_integrated_commit",
        "An integrated record must include integratedCommitHash before checks start.",
        "integration.integratedCommitHash",
      )],
    };
  }

  const updated: WorkspaceIntegration = {
    ...structuredClone(current),
    status: "checking",
  };
  delete updated.conflict;
  delete updated.diagnostics;
  delete updated.message;
  opened.set.integrations[index] = updated;
  return {
    ok: true,
    set: opened.set,
    integration: structuredClone(updated),
  };
}

/**
 * Mark an integration as checks_passed after successful base-workspace checks.
 * Accepts checking. Idempotent when already checks_passed with matching identity.
 * Does not mutate the input set.
 */
export function markIntegrationChecksPassed(
  set: WorkspaceIntegrationSet,
  integrationId: string,
  expected?: WorkspaceIntegrationExpectedIdentity,
): WorkspaceIntegrationTransitionResult {
  const opened = openSetClone(set);
  if (!opened.ok) {
    return { ok: false, diagnostics: opened.diagnostics };
  }

  if (typeof integrationId !== "string" || integrationId.trim().length === 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_id",
        "integrationId must be a non-empty string.",
        "integrationId",
      )],
    };
  }

  const index = findIntegrationIndex(opened.set, integrationId);
  if (index < 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_not_found",
        `Integration id '${integrationId.trim()}' was not found.`,
        "integrationId",
      )],
    };
  }

  const current = opened.set.integrations[index]!;

  if (expected !== undefined) {
    const identityDiagnostics = validateIntegrationIdentity(current, expected);
    if (identityDiagnostics.length > 0) {
      return { ok: false, diagnostics: identityDiagnostics };
    }
  }

  if (current.status === "checks_passed") {
    return {
      ok: true,
      set: opened.set,
      integration: structuredClone(current),
    };
  }

  if (current.status !== "checking") {
    const code = isTerminalStatus(current.status)
      ? alreadyTerminalDiagnosticCode(current.status)
      : "workspace_integration_invalid_transition";
    return {
      ok: false,
      diagnostics: [reject(
        code,
        `Cannot mark checks_passed from status '${current.status}'. Expected 'checking'.`,
        "integration.status",
      )],
    };
  }

  const updated: WorkspaceIntegration = {
    ...structuredClone(current),
    status: "checks_passed",
  };
  delete updated.conflict;
  delete updated.diagnostics;
  delete updated.message;
  opened.set.integrations[index] = updated;
  return {
    ok: true,
    set: opened.set,
    integration: structuredClone(updated),
  };
}

/**
 * Mark an integration as checks_failed with diagnostics from base-workspace checks.
 * Accepts checking. Idempotent when already checks_failed.
 * Does not mutate the input set.
 */
export function markIntegrationChecksFailed(
  set: WorkspaceIntegrationSet,
  integrationId: string,
  failureDiagnostics: readonly Diagnostic[],
  message?: string,
  expected?: WorkspaceIntegrationExpectedIdentity,
): WorkspaceIntegrationTransitionResult {
  const opened = openSetClone(set);
  if (!opened.ok) {
    return { ok: false, diagnostics: opened.diagnostics };
  }

  if (typeof integrationId !== "string" || integrationId.trim().length === 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_id",
        "integrationId must be a non-empty string.",
        "integrationId",
      )],
    };
  }

  if (!Array.isArray(failureDiagnostics)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_diagnostics",
        "failure diagnostics must be an array.",
        "diagnostics",
      )],
    };
  }

  // Validate the original diagnostic objects before any clone or spread.
  // Spreading first would convert class instances into plain objects.
  const listDiagnostics: Diagnostic[] = [];
  const parsedList = validateDiagnosticsList(
    failureDiagnostics,
    "diagnostics",
    listDiagnostics,
  );
  if (parsedList === undefined) {
    return {
      ok: false,
      diagnostics: listDiagnostics.length > 0
        ? listDiagnostics
        : [reject(
          "workspace_integration_invalid_diagnostics",
          "failure diagnostics are invalid.",
          "diagnostics",
        )],
    };
  }

  if (parsedList.length === 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_diagnostics",
        "checks_failed requires at least one diagnostic.",
        "diagnostics",
      )],
    };
  }

  const index = findIntegrationIndex(opened.set, integrationId);
  if (index < 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_not_found",
        `Integration id '${integrationId.trim()}' was not found.`,
        "integrationId",
      )],
    };
  }

  const current = opened.set.integrations[index]!;

  if (expected !== undefined) {
    const identityDiagnostics = validateIntegrationIdentity(current, expected);
    if (identityDiagnostics.length > 0) {
      return { ok: false, diagnostics: identityDiagnostics };
    }
  }

  if (current.status === "checks_failed") {
    return {
      ok: true,
      set: opened.set,
      integration: structuredClone(current),
    };
  }

  if (current.status === "checks_passed") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_already_checks_passed",
        "Cannot mark checks_failed: post-integration checks already passed.",
        "integration.status",
      )],
    };
  }

  if (current.status !== "checking") {
    const code = isTerminalStatus(current.status)
      ? alreadyTerminalDiagnosticCode(current.status)
      : "workspace_integration_invalid_transition";
    return {
      ok: false,
      diagnostics: [reject(
        code,
        `Cannot mark checks_failed from status '${current.status}'. Expected 'checking'.`,
        "integration.status",
      )],
    };
  }

  // Clone only after validation succeeds.
  const updated: WorkspaceIntegration = {
    ...structuredClone(current),
    status: "checks_failed",
    diagnostics: parsedList.map((item) => ({ ...item })),
  };
  delete updated.conflict;
  if (typeof message === "string" && message.trim().length > 0) {
    updated.message = message.trim();
  } else if (parsedList[0] !== undefined) {
    updated.message = parsedList[0].message;
  } else {
    delete updated.message;
  }
  opened.set.integrations[index] = updated;
  return {
    ok: true,
    set: opened.set,
    integration: structuredClone(updated),
  };
}

/**
 * Mark an integration as released by id.
 * Refuses to release an integrated record so completion identity remains.
 * When the id is absent, released is false and the set is still cloned.
 * Does not mutate the input set.
 */
export function releaseIntegrationRecord(
  set: WorkspaceIntegrationSet,
  integrationId: string,
): WorkspaceIntegrationReleaseResult {
  const opened = openSetClone(set);
  if (!opened.ok) {
    return { ok: false, diagnostics: opened.diagnostics };
  }

  if (typeof integrationId !== "string" || integrationId.trim().length === 0) {
    return {
      ok: true,
      set: opened.set,
      released: false,
    };
  }

  const id = integrationId.trim();
  const found = opened.set.integrations.find((item) => item.integrationId === id);
  if (found === undefined) {
    return {
      ok: true,
      set: opened.set,
      released: false,
    };
  }

  if (
    found.status === "integrated"
    || found.status === "checking"
    || found.status === "checks_passed"
    || found.status === "checks_failed"
    || found.integratedCommitHash !== undefined
  ) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_already_integrated",
        `Cannot release post-integrate record '${id}'. Completion identity must remain for double-integrate rejection.`,
        "integrationId",
      )],
    };
  }

  if (found.status === "released") {
    return {
      ok: true,
      set: opened.set,
      released: false,
    };
  }

  let released = false;
  const integrations = opened.set.integrations.map((item) => {
    if (item.integrationId !== id) {
      return item;
    }
    released = true;
    // Clear fields that are not valid for status released.
    const next: WorkspaceIntegration = {
      schemaVersion: item.schemaVersion,
      integrationId: item.integrationId,
      leaseId: item.leaseId,
      worktreeId: item.worktreeId,
      holder: structuredClone(item.holder),
      workerCommitHash: item.workerCommitHash,
      baseRevision: item.baseRevision,
      status: "released",
    };
    if (item.baseHeadBeforeIntegrate !== undefined) {
      next.baseHeadBeforeIntegrate = item.baseHeadBeforeIntegrate;
    }
    return next;
  });

  return {
    ok: true,
    set: {
      schemaVersion: WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION,
      integrations,
    },
    released,
  };
}

// ---------------------------------------------------------------------------
// Convenience: parse helpers for host preconditions
// ---------------------------------------------------------------------------

/**
 * Parse exclusive lease, clean worker commit, and ready worktree for integrate.
 * Applies the same cross-entity identity checks as proposePendingIntegration.
 * Returns clones on success. Does not mutate inputs.
 */
export function parseIntegrationPreconditions(input: {
  commit: unknown;
  lease: unknown;
  worktree: unknown;
}):
  | {
    ok: true;
    value: {
      commit: WorkerCommitResult;
      lease: WorkspaceLease;
      worktree: WorkspaceWorktree;
    };
  }
  | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(input as unknown)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_input_not_plain_object",
        "Integration precondition input must be a plain object.",
        "input",
      )],
    };
  }

  const worktreeParsed = parseWorkspaceWorktree(input.worktree, "worktree");
  if (!worktreeParsed.ok) {
    return { ok: false, diagnostics: worktreeParsed.diagnostics };
  }
  if (worktreeParsed.value.status !== "ready") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_worktree_not_ready",
        `Worktree status must be 'ready' for integration. Found '${worktreeParsed.value.status}'.`,
        "worktree.status",
      )],
    };
  }

  const validated = validateWorkerResultForIntegration({
    commit: input.commit,
    lease: input.lease,
    expected: { worktreeId: worktreeParsed.value.worktreeId },
  });
  if (!validated.ok) {
    return { ok: false, diagnostics: validated.diagnostics };
  }

  const leaseParsed = parseWorkspaceLease(validated.value.lease, "lease");
  if (!leaseParsed.ok) {
    return { ok: false, diagnostics: leaseParsed.diagnostics };
  }

  const commitParsed = parseWorkerCommitResult(validated.value.commit, "commit");
  if (!commitParsed.ok) {
    return { ok: false, diagnostics: commitParsed.diagnostics };
  }

  const crossEntity = validateIntegrationCrossEntityIdentity(
    commitParsed.value,
    leaseParsed.value,
    worktreeParsed.value,
  );
  if (crossEntity.length > 0) {
    return { ok: false, diagnostics: crossEntity };
  }

  return {
    ok: true,
    value: {
      commit: structuredClone(commitParsed.value),
      lease: structuredClone(leaseParsed.value),
      worktree: structuredClone(worktreeParsed.value),
    },
  };
}
