/**
 * Pure workspace worktree records for mutating attempt isolation (M8-s2).
 *
 * A worktree record links one exclusive workspace lease to one git worktree
 * checkout. The controller prepares a worktree after it acquires a lease.
 * This module does not call git, touch the filesystem, or schedule dispatch.
 *
 * Domain helpers are pure: no clock, random, files, network, or input mutation.
 * The worktree set is an in-memory value. Persistence and schema restore belong
 * to later M8 slices; the set type carries schemaVersion for that work.
 *
 * Shared or read-only leases do not use worktrees. Only exclusive (mutating)
 * leases register a worktree. The host layer enforces that rule at prepare.
 */

import type { Diagnostic } from "./model.js";
import {
  parseWorkspaceLease,
  type WorkspaceLease,
  type WorkspaceLeaseHolder,
} from "./workspace-lease.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema version for a future persisted worktree set. Always 1 in this slice. */
export const WORKSPACE_WORKTREE_SET_SCHEMA_VERSION = 1 as const;

/** Default maximum active (preparing or ready) worktrees in one set. */
export const DEFAULT_MAX_ACTIVE_WORKTREES = 32;

export const WORKSPACE_WORKTREE_STATUSES = [
  "preparing",
  "ready",
  "failed",
  "released",
] as const;

/** Status values that count as active for lease uniqueness. */
export const WORKSPACE_WORKTREE_ACTIVE_STATUSES = ["preparing", "ready"] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkspaceWorktreeStatus = (typeof WORKSPACE_WORKTREE_STATUSES)[number];

/**
 * Worktree record for one mutating attempt.
 * path is absolute at host prepare time; pure validation only checks non-empty.
 */
export interface WorkspaceWorktree {
  worktreeId: string;
  leaseId: string;
  holder: WorkspaceLeaseHolder;
  /** Absolute path to the worktree checkout root. */
  path: string;
  /** Git commit or ref the worktree was created from. */
  baseRevision: string;
  /** Branch used for isolation when the host created a branch. */
  branchName?: string;
  /**
   * Controlled parent root used when the host prepared this worktree.
   * Release uses this path for containment checks when present.
   */
  parentRoot?: string;
  status: WorkspaceWorktreeStatus;
}

/**
 * In-memory worktree registry.
 * Not restored from disk in this slice. schemaVersion is reserved for later
 * persistence and must be WORKSPACE_WORKTREE_SET_SCHEMA_VERSION when present.
 */
export interface WorkspaceWorktreeSet {
  schemaVersion: typeof WORKSPACE_WORKTREE_SET_SCHEMA_VERSION;
  worktrees: WorkspaceWorktree[];
}

export type WorkspaceWorktreeRegisterResult =
  | { ok: true; set: WorkspaceWorktreeSet; worktree: WorkspaceWorktree }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

export type WorkspaceWorktreeReleaseResult =
  | {
    ok: true;
    set: WorkspaceWorktreeSet;
    released: boolean;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

export type WorkspaceWorktreeListResult =
  | { ok: true; worktrees: WorkspaceWorktree[] }
  | { ok: false; diagnostics: Diagnostic[] };

export type WorkspaceWorktreeGetResult =
  | { ok: true; worktree: WorkspaceWorktree | undefined }
  | { ok: false; diagnostics: Diagnostic[] };

export interface WorkspaceWorktreeBounds {
  /**
   * Maximum active (preparing or ready) worktrees after register.
   * Default DEFAULT_MAX_ACTIVE_WORKTREES. When present must be a non-negative
   * safe integer.
   */
  maxActiveWorktrees?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const WORKSPACE_WORKTREE_STATUS_SET = new Set<string>(WORKSPACE_WORKTREE_STATUSES);
const WORKSPACE_WORKTREE_ACTIVE_STATUS_SET = new Set<string>(
  WORKSPACE_WORKTREE_ACTIVE_STATUSES,
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
        "workspace_worktree_invalid_bound",
        `Bound at ${location} must be a non-negative safe integer when present.`,
        location,
      ),
    };
  }
  return { ok: true, value };
}

function resolveWorktreeBounds(
  bounds: WorkspaceWorktreeBounds | undefined,
): { ok: true; maxActiveWorktrees: number } | { ok: false; diagnostics: Diagnostic[] } {
  const maxActive = resolveNonNegativeSafeIntegerBound(
    bounds?.maxActiveWorktrees,
    DEFAULT_MAX_ACTIVE_WORKTREES,
    "bounds.maxActiveWorktrees",
  );
  if (!maxActive.ok) return { ok: false, diagnostics: [maxActive.diagnostic] };
  return { ok: true, maxActiveWorktrees: maxActive.value };
}

function isActiveStatus(status: string): boolean {
  return WORKSPACE_WORKTREE_ACTIVE_STATUS_SET.has(status);
}

function validateHolder(
  holder: unknown,
  location: string,
  diagnostics: Diagnostic[],
): WorkspaceLeaseHolder | undefined {
  if (!isStrictPlainObject(holder)) {
    diagnostics.push(reject(
      "workspace_worktree_invalid_holder",
      "Worktree holder must be a plain object.",
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
        "workspace_worktree_invalid_holder",
        `Worktree holder.${field} must be a non-empty string.`,
        `${location}.${field}`,
      ));
      failed = true;
    }
  }
  if (!isNonNegativeSafeInteger(record.revision)) {
    diagnostics.push(reject(
      "workspace_worktree_invalid_holder",
      "Worktree holder.revision must be a non-negative safe integer.",
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

// ---------------------------------------------------------------------------
// Pure identity and path-key helpers
// ---------------------------------------------------------------------------

/**
 * Derive a stable worktree id from a lease id.
 * Pure string rule only. Does not call git or the filesystem.
 */
export function deriveWorktreeId(leaseId: string): string {
  return `wt-${leaseId.trim()}`;
}

/**
 * Pure FNV-1a 32-bit hash as eight lowercase hex characters.
 * Used only to disambiguate sanitized directory names. No I/O.
 */
export function leaseIdDisambiguator(leaseId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < leaseId.length; index += 1) {
    hash ^= leaseId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Derive a safe single-segment directory name from a lease id.
 * Pure string rule only. Replaces characters that are unsafe for path segments.
 * Dots are replaced so names cannot form parent-segment traversal such as `..`.
 * Appends a short hash of the original lease id so distinct ids cannot collide
 * after sanitisation (for example `a.b` and `a_b`).
 * Rejects empty results after sanitisation by returning undefined.
 */
export function deriveWorktreeDirectoryName(leaseId: string): string | undefined {
  if (typeof leaseId !== "string") return undefined;
  const trimmed = leaseId.trim();
  if (trimmed.length === 0) return undefined;
  const safe = trimmed
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
  if (safe.length === 0) return undefined;
  const disambiguator = leaseIdDisambiguator(trimmed);
  return `lease-${safe}-${disambiguator}`;
}

/**
 * Derive a git branch name for an isolated worktree.
 * Pure string rule only.
 */
export function deriveWorktreeBranchName(leaseId: string): string | undefined {
  const directoryName = deriveWorktreeDirectoryName(leaseId);
  if (directoryName === undefined) return undefined;
  return `hypagraph/${directoryName}`;
}

/**
 * Report whether a worktree status is active (preparing or ready).
 */
export function isActiveWorktreeStatus(status: WorkspaceWorktreeStatus): boolean {
  return isActiveStatus(status);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a workspace worktree record.
 * Accepts untrusted input. Rejects class instances. Does not mutate input.
 */
export function validateWorkspaceWorktree(
  value: unknown,
  location = "worktree",
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (!isStrictPlainObject(value)) {
    return [reject(
      "workspace_worktree_not_plain_object",
      "Workspace worktree must be a plain object.",
      location,
    )];
  }

  const record = value;

  if (!isNonEmptyString(record.worktreeId)) {
    diagnostics.push(reject(
      "workspace_worktree_invalid_id",
      "worktreeId must be a non-empty string.",
      `${location}.worktreeId`,
    ));
  }

  if (!isNonEmptyString(record.leaseId)) {
    diagnostics.push(reject(
      "workspace_worktree_invalid_lease_id",
      "leaseId must be a non-empty string.",
      `${location}.leaseId`,
    ));
  }

  if (!isNonEmptyString(record.path)) {
    diagnostics.push(reject(
      "workspace_worktree_invalid_path",
      "path must be a non-empty string.",
      `${location}.path`,
    ));
  }

  if (!isNonEmptyString(record.baseRevision)) {
    diagnostics.push(reject(
      "workspace_worktree_invalid_base_revision",
      "baseRevision must be a non-empty string.",
      `${location}.baseRevision`,
    ));
  }

  if (
    typeof record.status !== "string"
    || !WORKSPACE_WORKTREE_STATUS_SET.has(record.status)
  ) {
    diagnostics.push(reject(
      "workspace_worktree_invalid_status",
      "status must be 'preparing', 'ready', 'failed', or 'released'.",
      `${location}.status`,
    ));
  }

  if (
    record.branchName !== undefined
    && !isNonEmptyString(record.branchName)
  ) {
    diagnostics.push(reject(
      "workspace_worktree_invalid_branch",
      "branchName must be a non-empty string when present.",
      `${location}.branchName`,
    ));
  }

  if (
    record.parentRoot !== undefined
    && !isNonEmptyString(record.parentRoot)
  ) {
    diagnostics.push(reject(
      "workspace_worktree_invalid_parent_root",
      "parentRoot must be a non-empty string when present.",
      `${location}.parentRoot`,
    ));
  }

  validateHolder(record.holder, `${location}.holder`, diagnostics);

  return diagnostics;
}

/**
 * Parse and clone a valid workspace worktree.
 * Does not mutate input.
 */
export function parseWorkspaceWorktree(
  value: unknown,
  location = "worktree",
): { ok: true; value: WorkspaceWorktree } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics = validateWorkspaceWorktree(value, location);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const record = value as Record<string, unknown>;
  const holder = record.holder as Record<string, unknown>;

  const worktree: WorkspaceWorktree = {
    worktreeId: (record.worktreeId as string).trim(),
    leaseId: (record.leaseId as string).trim(),
    holder: {
      familyId: (holder.familyId as string).trim(),
      goalId: (holder.goalId as string).trim(),
      workflowId: (holder.workflowId as string).trim(),
      revision: holder.revision as number,
      nodeId: (holder.nodeId as string).trim(),
      attemptId: (holder.attemptId as string).trim(),
    },
    path: (record.path as string).trim(),
    baseRevision: (record.baseRevision as string).trim(),
    status: record.status as WorkspaceWorktreeStatus,
  };
  if (record.branchName !== undefined) {
    worktree.branchName = (record.branchName as string).trim();
  }
  if (record.parentRoot !== undefined) {
    worktree.parentRoot = (record.parentRoot as string).trim();
  }
  return { ok: true, value: worktree };
}

/**
 * Reject an unsupported worktree-set schema version.
 * Used when a future restore path supplies a set with a version field.
 */
export function validateWorkspaceWorktreeSetSchema(
  value: unknown,
  location = "worktreeSet",
): Diagnostic[] {
  if (!isStrictPlainObject(value)) {
    return [reject(
      "workspace_worktree_set_not_plain_object",
      "Workspace worktree set must be a plain object.",
      location,
    )];
  }
  const record = value;
  if (record.schemaVersion !== WORKSPACE_WORKTREE_SET_SCHEMA_VERSION) {
    return [reject(
      "workspace_worktree_set_unsupported_schema",
      `Unsupported workspace worktree set schema version '${String(record.schemaVersion)}'. Expected ${WORKSPACE_WORKTREE_SET_SCHEMA_VERSION}.`,
      `${location}.schemaVersion`,
    )];
  }
  if (!Array.isArray(record.worktrees)) {
    return [reject(
      "workspace_worktree_set_invalid_worktrees",
      "Workspace worktree set worktrees must be an array.",
      `${location}.worktrees`,
    )];
  }
  return [];
}

/**
 * Create an empty worktree set.
 * schemaVersion is fixed for this contract version.
 */
export function createEmptyWorkspaceWorktreeSet(): WorkspaceWorktreeSet {
  return {
    schemaVersion: WORKSPACE_WORKTREE_SET_SCHEMA_VERSION,
    worktrees: [],
  };
}

function cloneWorktreeSet(set: WorkspaceWorktreeSet): WorkspaceWorktreeSet {
  return {
    schemaVersion: WORKSPACE_WORKTREE_SET_SCHEMA_VERSION,
    worktrees: set.worktrees.map((worktree) => structuredClone(worktree)),
  };
}

// ---------------------------------------------------------------------------
// Registry operations
// ---------------------------------------------------------------------------

/**
 * List all worktree records as deep clones so callers cannot mutate the set.
 * Rejects an unsupported worktree-set schema version.
 */
export function listWorktrees(set: WorkspaceWorktreeSet): WorkspaceWorktreeListResult {
  const schemaDiagnostics = validateWorkspaceWorktreeSetSchema(set, "worktreeSet");
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }
  return {
    ok: true,
    worktrees: set.worktrees
      .map((worktree) => structuredClone(worktree))
      .sort((left, right) => left.worktreeId.localeCompare(right.worktreeId)),
  };
}

/**
 * List active (preparing or ready) worktree records as deep clones.
 * Rejects an unsupported worktree-set schema version.
 */
export function listActiveWorktrees(set: WorkspaceWorktreeSet): WorkspaceWorktreeListResult {
  const schemaDiagnostics = validateWorkspaceWorktreeSetSchema(set, "worktreeSet");
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }
  return {
    ok: true,
    worktrees: set.worktrees
      .filter((worktree) => isActiveStatus(worktree.status))
      .map((worktree) => structuredClone(worktree))
      .sort((left, right) => left.worktreeId.localeCompare(right.worktreeId)),
  };
}

/**
 * Return a deep clone of one worktree by id, or undefined when absent.
 * Trims the lookup id to match stored identity. Rejects unsupported schema.
 */
export function getWorktree(
  set: WorkspaceWorktreeSet,
  worktreeId: string,
): WorkspaceWorktreeGetResult {
  const schemaDiagnostics = validateWorkspaceWorktreeSetSchema(set, "worktreeSet");
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }
  if (typeof worktreeId !== "string") {
    return { ok: true, worktree: undefined };
  }
  const id = worktreeId.trim();
  if (id.length === 0) return { ok: true, worktree: undefined };
  const found = set.worktrees.find((worktree) => worktree.worktreeId === id);
  return { ok: true, worktree: found ? structuredClone(found) : undefined };
}

/**
 * Return a deep clone of the active worktree for a lease, or undefined.
 * Trims the lease id. Rejects unsupported schema.
 */
export function getActiveWorktreeForLease(
  set: WorkspaceWorktreeSet,
  leaseId: string,
): WorkspaceWorktreeGetResult {
  const schemaDiagnostics = validateWorkspaceWorktreeSetSchema(set, "worktreeSet");
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }
  if (typeof leaseId !== "string") {
    return { ok: true, worktree: undefined };
  }
  const id = leaseId.trim();
  if (id.length === 0) return { ok: true, worktree: undefined };
  const found = set.worktrees.find(
    (worktree) => worktree.leaseId === id && isActiveStatus(worktree.status),
  );
  return { ok: true, worktree: found ? structuredClone(found) : undefined };
}

/**
 * Validate that a lease is exclusive (mutating) and can own a worktree.
 * Runs the full m8-s1 workspace lease parser so path scopes and shape match
 * acquireWorkspaceLease. Does not mutate inputs.
 */
export function requireExclusiveLeaseForWorktree(
  lease: unknown,
  location = "lease",
): { ok: true; lease: WorkspaceLease } | { ok: false; diagnostics: Diagnostic[] } {
  if (!isStrictPlainObject(lease)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_worktree_lease_not_plain_object",
        "Lease must be a plain object.",
        location,
      )],
    };
  }

  // Prefer the exclusive-mode diagnostic when mode is clearly not exclusive,
  // so shared leases do not surface unrelated path diagnostics first.
  if (
    typeof (lease as Record<string, unknown>).mode === "string"
    && (lease as Record<string, unknown>).mode !== "exclusive"
  ) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_worktree_lease_not_exclusive",
        "A worktree requires an exclusive (mutating) lease. Shared leases omit worktree creation.",
        `${location}.mode`,
      )],
    };
  }

  const parsed = parseWorkspaceLease(lease, location);
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  if (parsed.value.mode !== "exclusive") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_worktree_lease_not_exclusive",
        "A worktree requires an exclusive (mutating) lease. Shared leases omit worktree creation.",
        `${location}.mode`,
      )],
    };
  }
  return { ok: true, lease: parsed.value };
}

/**
 * Validate holder identity matches a lease holder when both are supplied.
 * Does not mutate inputs.
 */
export function worktreeHolderMatchesLease(
  worktreeHolder: WorkspaceLeaseHolder,
  leaseHolder: WorkspaceLeaseHolder,
): boolean {
  return holdersEqual(worktreeHolder, leaseHolder);
}

/**
 * Register a worktree into a new set.
 * Enforces one active worktree per leaseId.
 * worktreeId may replace an existing non-active record (released or failed)
 * so stable host ids such as `wt-<leaseId>` can re-prepare after release.
 * An active record with the same worktreeId is still rejected.
 * Validates the candidate and the set schema. Does not mutate inputs.
 */
export function registerWorktree(
  set: WorkspaceWorktreeSet,
  candidate: unknown,
  bounds?: WorkspaceWorktreeBounds,
): WorkspaceWorktreeRegisterResult {
  const resolvedBounds = resolveWorktreeBounds(bounds);
  if (!resolvedBounds.ok) {
    return { ok: false, diagnostics: resolvedBounds.diagnostics };
  }
  const { maxActiveWorktrees } = resolvedBounds;

  const schemaDiagnostics = validateWorkspaceWorktreeSetSchema(set, "worktreeSet");
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }

  const parsed = parseWorkspaceWorktree(candidate, "worktree");
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  const worktree = parsed.value;

  const sameId = set.worktrees.filter((item) => item.worktreeId === worktree.worktreeId);
  if (sameId.some((item) => isActiveStatus(item.status))) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_worktree_duplicate_id",
        `Worktree id '${worktree.worktreeId}' is already registered as active.`,
        "worktree.worktreeId",
      )],
    };
  }
  // Non-active same-id rows are replaced below so re-prepare can reuse the id.

  if (isActiveStatus(worktree.status)) {
    const activeCount = set.worktrees.filter((item) => isActiveStatus(item.status)).length;
    if (activeCount >= maxActiveWorktrees) {
      return {
        ok: false,
        diagnostics: [reject(
          "workspace_worktree_active_limit",
          `The active worktree set must not exceed ${maxActiveWorktrees} worktrees.`,
          "worktreeSet.worktrees",
        )],
      };
    }

    const duplicateLease = set.worktrees.find(
      (item) => item.leaseId === worktree.leaseId && isActiveStatus(item.status),
    );
    if (duplicateLease) {
      return {
        ok: false,
        diagnostics: [reject(
          "workspace_worktree_duplicate_active_lease",
          `Lease id '${worktree.leaseId}' already has active worktree '${duplicateLease.worktreeId}'.`,
          "worktree.leaseId",
        )],
      };
    }
  }

  const next: WorkspaceWorktreeSet = {
    schemaVersion: WORKSPACE_WORKTREE_SET_SCHEMA_VERSION,
    worktrees: set.worktrees
      .filter((item) => item.worktreeId !== worktree.worktreeId)
      .map((item) => structuredClone(item)),
  };
  next.worktrees.push(structuredClone(worktree));
  next.worktrees.sort((left, right) => left.worktreeId.localeCompare(right.worktreeId));
  return {
    ok: true,
    set: next,
    worktree: structuredClone(worktree),
  };
}

/**
 * Mark a worktree as released by id and return a new set.
 * When the id is absent, released is false and the set is still cloned.
 * Trims the release id. Rejects unsupported schema without rewriting it.
 * Does not mutate the input set.
 */
export function releaseWorktreeRecord(
  set: WorkspaceWorktreeSet,
  worktreeId: string,
): WorkspaceWorktreeReleaseResult {
  const schemaDiagnostics = validateWorkspaceWorktreeSetSchema(set, "worktreeSet");
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }

  if (typeof worktreeId !== "string" || worktreeId.trim().length === 0) {
    return {
      ok: true,
      set: cloneWorktreeSet(set),
      released: false,
    };
  }

  const id = worktreeId.trim();
  let released = false;
  const worktrees = set.worktrees.map((worktree) => {
    if (worktree.worktreeId !== id) {
      return structuredClone(worktree);
    }
    if (worktree.status === "released") {
      return structuredClone(worktree);
    }
    released = true;
    const next: WorkspaceWorktree = {
      ...structuredClone(worktree),
      status: "released",
    };
    return next;
  });

  const found = set.worktrees.some((worktree) => worktree.worktreeId === id);
  if (!found) {
    return {
      ok: true,
      set: cloneWorktreeSet(set),
      released: false,
    };
  }

  return {
    ok: true,
    set: {
      schemaVersion: WORKSPACE_WORKTREE_SET_SCHEMA_VERSION,
      worktrees,
    },
    released,
  };
}

/**
 * Release the active worktree for a lease id.
 * Marks matching active records as released. Does not mutate the input set.
 */
export function releaseWorktreeRecordByLease(
  set: WorkspaceWorktreeSet,
  leaseId: string,
): WorkspaceWorktreeReleaseResult {
  const schemaDiagnostics = validateWorkspaceWorktreeSetSchema(set, "worktreeSet");
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }

  if (typeof leaseId !== "string" || leaseId.trim().length === 0) {
    return {
      ok: true,
      set: cloneWorktreeSet(set),
      released: false,
    };
  }

  const id = leaseId.trim();
  let released = false;
  const worktrees = set.worktrees.map((worktree) => {
    if (worktree.leaseId !== id || !isActiveStatus(worktree.status)) {
      return structuredClone(worktree);
    }
    released = true;
    return {
      ...structuredClone(worktree),
      status: "released" as const,
    };
  });

  return {
    ok: true,
    set: {
      schemaVersion: WORKSPACE_WORKTREE_SET_SCHEMA_VERSION,
      worktrees,
    },
    released,
  };
}

/**
 * Build a ready worktree candidate from an exclusive lease and host path data.
 * Pure construction and validation only. Does not call git.
 */
export function proposeReadyWorktree(input: {
  lease: WorkspaceLease;
  path: string;
  baseRevision: string;
  worktreeId?: string;
  branchName?: string;
  parentRoot?: string;
}): { ok: true; value: WorkspaceWorktree } | { ok: false; diagnostics: Diagnostic[] } {
  const exclusive = requireExclusiveLeaseForWorktree(input.lease, "lease");
  if (!exclusive.ok) {
    return { ok: false, diagnostics: exclusive.diagnostics };
  }
  const lease = exclusive.lease;
  const worktreeId = input.worktreeId !== undefined
    ? input.worktreeId
    : deriveWorktreeId(lease.leaseId);
  const payload: Record<string, unknown> = {
    worktreeId,
    leaseId: lease.leaseId,
    holder: {
      familyId: lease.holder.familyId,
      goalId: lease.holder.goalId,
      workflowId: lease.holder.workflowId,
      revision: lease.holder.revision,
      nodeId: lease.holder.nodeId,
      attemptId: lease.holder.attemptId,
    },
    path: input.path,
    baseRevision: input.baseRevision,
    status: "ready",
  };
  if (input.branchName !== undefined) {
    payload.branchName = input.branchName;
  }
  if (input.parentRoot !== undefined) {
    payload.parentRoot = input.parentRoot;
  }
  return parseWorkspaceWorktree(payload, "worktree");
}
