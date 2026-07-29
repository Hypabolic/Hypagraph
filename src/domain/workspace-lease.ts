/**
 * Pure workspace lease contracts for concurrent attempt isolation (M8-s1).
 *
 * A lease records who may mutate or read repository path scopes. The controller
 * acquires a lease before it creates a worktree or starts an executor. This
 * module does not create worktrees, call git, or schedule dispatch.
 *
 * Domain helpers are pure: no clock, random, files, network, or input mutation.
 * The active lease set is an in-memory value. Persistence and schema restore
 * belong to later M8 slices; the set type carries schemaVersion for that work.
 */

import type { ExecutorWorkspaceLeaseRef } from "./executor-contract.js";
import { canonicalProtectedPath } from "./integrity-policy.js";
import type { Diagnostic } from "./model.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema version for a future persisted lease set. Always 1 in this slice. */
export const WORKSPACE_LEASE_SET_SCHEMA_VERSION = 1 as const;

/** Default maximum read or write paths on one lease. Always enforced when set. */
export const DEFAULT_MAX_LEASE_PATHS = 64;

/** Default maximum active leases in one set. Always enforced when set. */
export const DEFAULT_MAX_ACTIVE_LEASES = 32;

export const WORKSPACE_LEASE_MODES = ["exclusive", "shared"] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lease mode.
 * - exclusive: mutating lease; write scopes must not overlap another exclusive write.
 * - shared: read-compatible lease; conflicts with exclusive writes on overlapping paths.
 */
export type WorkspaceLeaseMode = (typeof WORKSPACE_LEASE_MODES)[number];

/** Who holds the lease (family / goal / workflow / revision / node / attempt). */
export interface WorkspaceLeaseHolder {
  familyId: string;
  goalId: string;
  workflowId: string;
  revision: number;
  nodeId: string;
  attemptId: string;
}

/** Read and write repository path scopes for one lease. */
export interface WorkspaceLeasePaths {
  readPaths: string[];
  writePaths: string[];
}

/**
 * Explicit workspace lease record.
 * Aligns with ExecutorWorkspaceLeaseRef (leaseId, optional baseRevision).
 */
export interface WorkspaceLease {
  leaseId: string;
  mode: WorkspaceLeaseMode;
  holder: WorkspaceLeaseHolder;
  paths: WorkspaceLeasePaths;
  /** Base git revision when known. */
  baseRevision?: string;
}

/**
 * In-memory active lease set.
 * Not restored from disk in this slice. schemaVersion is reserved for later
 * persistence and must be WORKSPACE_LEASE_SET_SCHEMA_VERSION when present.
 */
export interface WorkspaceLeaseSet {
  schemaVersion: typeof WORKSPACE_LEASE_SET_SCHEMA_VERSION;
  leases: WorkspaceLease[];
}

export type WorkspaceLeaseAcquireResult =
  | { ok: true; set: WorkspaceLeaseSet }
  | {
    ok: false;
    diagnostics: Diagnostic[];
    conflictingLeaseIds?: string[];
  };

export type WorkspaceLeaseCompatibilityResult =
  | { ok: true }
  | {
    ok: false;
    diagnostics: Diagnostic[];
    conflictingLeaseIds: string[];
  };

export type WorkspaceLeaseReleaseResult =
  | {
    ok: true;
    set: WorkspaceLeaseSet;
    released: boolean;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

export type WorkspaceLeaseListResult =
  | { ok: true; leases: WorkspaceLease[] }
  | { ok: false; diagnostics: Diagnostic[] };

export type WorkspaceLeaseGetResult =
  | { ok: true; lease: WorkspaceLease | undefined }
  | { ok: false; diagnostics: Diagnostic[] };

export interface WorkspaceLeaseBounds {
  /**
   * Maximum paths in readPaths and in writePaths.
   * Default DEFAULT_MAX_LEASE_PATHS. When present must be a non-negative safe integer.
   */
  maxPaths?: number;
  /**
   * Maximum active leases after acquire.
   * Default DEFAULT_MAX_ACTIVE_LEASES. When present must be a non-negative safe integer.
   */
  maxActiveLeases?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const WORKSPACE_LEASE_MODE_SET = new Set<string>(WORKSPACE_LEASE_MODES);

/**
 * Accept Object.prototype and null-prototype objects only.
 * Reject arrays, Date, Map, Set, RegExp, and other class instances.
 */
const isStrictPlainObject = (value: unknown): boolean => {
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

/**
 * Resolve an optional bound. Omitted values use the fallback.
 * Present values must be non-negative safe integers; invalid values produce a diagnostic.
 */
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
        "workspace_lease_invalid_bound",
        `Bound at ${location} must be a non-negative safe integer when present.`,
        location,
      ),
    };
  }
  return { ok: true, value };
}

function resolveLeaseBounds(
  bounds: WorkspaceLeaseBounds | undefined,
): { ok: true; maxPaths: number; maxActiveLeases: number } | { ok: false; diagnostics: Diagnostic[] } {
  const maxPaths = resolveNonNegativeSafeIntegerBound(
    bounds?.maxPaths,
    DEFAULT_MAX_LEASE_PATHS,
    "bounds.maxPaths",
  );
  if (!maxPaths.ok) return { ok: false, diagnostics: [maxPaths.diagnostic] };
  const maxActiveLeases = resolveNonNegativeSafeIntegerBound(
    bounds?.maxActiveLeases,
    DEFAULT_MAX_ACTIVE_LEASES,
    "bounds.maxActiveLeases",
  );
  if (!maxActiveLeases.ok) return { ok: false, diagnostics: [maxActiveLeases.diagnostic] };
  return {
    ok: true,
    maxPaths: maxPaths.value,
    maxActiveLeases: maxActiveLeases.value,
  };
}

/**
 * Normalise a lease scope path for comparison.
 * Strips a trailing `/**` directory glob so scope declarations match file paths.
 * Uses the same workspace-relative rules as canonicalProtectedPath.
 */
export function canonicalLeasePath(value: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalised = value.replaceAll("\\", "/").trim();
  const isDirectoryGlob = normalised.endsWith("/**");
  const base = isDirectoryGlob ? normalised.slice(0, -3) : normalised;
  if (isDirectoryGlob && (base === "" || base === ".")) {
    // Whole-workspace directory scope: represent as empty base with glob marker.
    return "/**";
  }
  const canonical = canonicalProtectedPath(base);
  if (canonical === undefined) return undefined;
  return isDirectoryGlob ? `${canonical}/**` : canonical;
}

/**
 * Report whether two canonical lease paths overlap by equality or containment.
 * `src` overlaps `src/a`. `src/**` overlaps `src` and `src/a`. `src` does not
 * overlap `src2`. Invalid paths do not overlap.
 */
export function leasePathsOverlap(left: string, right: string): boolean {
  const a = canonicalLeasePath(left);
  const b = canonicalLeasePath(right);
  if (a === undefined || b === undefined) return false;
  return leaseCanonicalPathsOverlap(a, b);
}

/**
 * Overlap for already-canonical lease paths.
 * Glob and non-glob scopes use the same mutual base containment so that
 * `src` overlaps `src/domain/**` and `src/**` overlaps `src/domain`.
 */
function leaseCanonicalPathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === "/**" || b === "/**") return true;

  const aBase = a.endsWith("/**") ? a.slice(0, -3) : a;
  const bBase = b.endsWith("/**") ? b.slice(0, -3) : b;

  return (
    aBase === bBase
    || aBase.startsWith(`${bBase}/`)
    || bBase.startsWith(`${aBase}/`)
  );
}

function anyPathPairOverlaps(left: readonly string[], right: readonly string[]): boolean {
  for (const a of left) {
    for (const b of right) {
      if (leasePathsOverlap(a, b)) return true;
    }
  }
  return false;
}

/**
 * Compatibility matrix:
 * - exclusive + exclusive: conflict when write paths overlap.
 * - exclusive + shared: conflict when exclusive write paths overlap shared read paths.
 * - shared + shared: always compatible (read-only coexistence).
 *
 * Write paths on a shared lease are rejected at validation time.
 */
export function workspaceLeasesConflict(left: WorkspaceLease, right: WorkspaceLease): boolean {
  if (left.mode === "exclusive" && right.mode === "exclusive") {
    return anyPathPairOverlaps(left.paths.writePaths, right.paths.writePaths);
  }
  if (left.mode === "exclusive" && right.mode === "shared") {
    return anyPathPairOverlaps(left.paths.writePaths, right.paths.readPaths);
  }
  if (left.mode === "shared" && right.mode === "exclusive") {
    return anyPathPairOverlaps(right.paths.writePaths, left.paths.readPaths);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validatePathList(
  paths: unknown,
  location: string,
  maxPaths: number,
  diagnostics: Diagnostic[],
): string[] | undefined {
  if (!Array.isArray(paths)) {
    diagnostics.push(reject(
      "workspace_lease_invalid_path_list",
      "Lease path lists must be string arrays.",
      location,
    ));
    return undefined;
  }
  if (paths.length > maxPaths) {
    diagnostics.push(reject(
      "workspace_lease_path_limit",
      `A lease path list must not exceed ${maxPaths} entries.`,
      location,
    ));
    return undefined;
  }

  const canonicals: string[] = [];
  const seen = new Set<string>();
  let failed = false;
  for (let index = 0; index < paths.length; index += 1) {
    const item = paths[index];
    if (typeof item !== "string") {
      diagnostics.push(reject(
        "workspace_lease_invalid_path",
        `Path at index ${index} must be a string.`,
        `${location}[${index}]`,
      ));
      failed = true;
      continue;
    }
    const canonical = canonicalLeasePath(item);
    if (canonical === undefined) {
      diagnostics.push(reject(
        "workspace_lease_invalid_path",
        `Path '${item}' must be a non-empty workspace-relative path.`,
        `${location}[${index}]`,
      ));
      failed = true;
      continue;
    }
    if (seen.has(canonical)) {
      diagnostics.push(reject(
        "workspace_lease_duplicate_path",
        `Path '${item}' duplicates a canonical path on this lease.`,
        `${location}[${index}]`,
      ));
      failed = true;
      continue;
    }
    seen.add(canonical);
    canonicals.push(canonical);
  }
  return failed ? undefined : canonicals;
}

function validateHolder(
  holder: unknown,
  location: string,
  diagnostics: Diagnostic[],
): WorkspaceLeaseHolder | undefined {
  if (!isStrictPlainObject(holder)) {
    diagnostics.push(reject(
      "workspace_lease_invalid_holder",
      "Lease holder must be a plain object.",
      location,
    ));
    return undefined;
  }
  const record = holder as Record<string, unknown>;
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
        "workspace_lease_invalid_holder",
        `Lease holder.${field} must be a non-empty string.`,
        `${location}.${field}`,
      ));
      failed = true;
    }
  }
  if (!isNonNegativeSafeInteger(record.revision)) {
    diagnostics.push(reject(
      "workspace_lease_invalid_holder",
      "Lease holder.revision must be a non-negative safe integer.",
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

/**
 * Validate a workspace lease record.
 * Accepts untrusted input. Rejects class instances. Does not mutate input.
 */
export function validateWorkspaceLease(
  value: unknown,
  location = "lease",
  bounds?: Pick<WorkspaceLeaseBounds, "maxPaths">,
): Diagnostic[] {
  const boundResolution = resolveNonNegativeSafeIntegerBound(
    bounds?.maxPaths,
    DEFAULT_MAX_LEASE_PATHS,
    "bounds.maxPaths",
  );
  if (!boundResolution.ok) return [boundResolution.diagnostic];
  const maxPaths = boundResolution.value;
  const diagnostics: Diagnostic[] = [];

  if (!isStrictPlainObject(value)) {
    return [reject(
      "workspace_lease_not_plain_object",
      "Workspace lease must be a plain object.",
      location,
    )];
  }

  const record = value as Record<string, unknown>;

  if (!isNonEmptyString(record.leaseId)) {
    diagnostics.push(reject(
      "workspace_lease_invalid_id",
      "leaseId must be a non-empty string.",
      `${location}.leaseId`,
    ));
  }

  if (typeof record.mode !== "string" || !WORKSPACE_LEASE_MODE_SET.has(record.mode)) {
    diagnostics.push(reject(
      "workspace_lease_invalid_mode",
      "mode must be 'exclusive' or 'shared'.",
      `${location}.mode`,
    ));
  }

  if (
    record.baseRevision !== undefined
    && !isNonEmptyString(record.baseRevision)
  ) {
    diagnostics.push(reject(
      "workspace_lease_invalid_base_revision",
      "baseRevision must be a non-empty string when present.",
      `${location}.baseRevision`,
    ));
  }

  validateHolder(record.holder, `${location}.holder`, diagnostics);

  if (!isStrictPlainObject(record.paths)) {
    diagnostics.push(reject(
      "workspace_lease_invalid_paths_object",
      "paths must be a plain object with readPaths and writePaths.",
      `${location}.paths`,
    ));
  } else {
    const paths = record.paths as Record<string, unknown>;
    const readPaths = validatePathList(
      paths.readPaths,
      `${location}.paths.readPaths`,
      maxPaths,
      diagnostics,
    );
    const writePaths = validatePathList(
      paths.writePaths,
      `${location}.paths.writePaths`,
      maxPaths,
      diagnostics,
    );

    if (record.mode === "exclusive" && writePaths !== undefined && writePaths.length === 0) {
      diagnostics.push(reject(
        "workspace_lease_empty_write_scope",
        "An exclusive lease must declare at least one write path.",
        `${location}.paths.writePaths`,
      ));
    }
    if (record.mode === "shared" && writePaths !== undefined && writePaths.length > 0) {
      diagnostics.push(reject(
        "workspace_lease_shared_with_writes",
        "A shared lease must not declare write paths.",
        `${location}.paths.writePaths`,
      ));
    }
    if (record.mode === "shared" && readPaths !== undefined && readPaths.length === 0) {
      diagnostics.push(reject(
        "workspace_lease_empty_read_scope",
        "A shared lease must declare at least one read path.",
        `${location}.paths.readPaths`,
      ));
    }
  }

  return diagnostics;
}

/**
 * Parse and clone a valid workspace lease.
 * Canonicalises paths. Does not mutate input.
 */
export function parseWorkspaceLease(
  value: unknown,
  location = "lease",
  bounds?: Pick<WorkspaceLeaseBounds, "maxPaths">,
): { ok: true; value: WorkspaceLease } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics = validateWorkspaceLease(value, location, bounds);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const record = value as Record<string, unknown>;
  const paths = record.paths as Record<string, unknown>;
  const holder = record.holder as Record<string, unknown>;

  const readPaths = (paths.readPaths as string[])
    .map((path) => canonicalLeasePath(path)!)
    .sort((left, right) => left.localeCompare(right));
  const writePaths = (paths.writePaths as string[])
    .map((path) => canonicalLeasePath(path)!)
    .sort((left, right) => left.localeCompare(right));

  const lease: WorkspaceLease = {
    leaseId: (record.leaseId as string).trim(),
    mode: record.mode as WorkspaceLeaseMode,
    holder: {
      familyId: (holder.familyId as string).trim(),
      goalId: (holder.goalId as string).trim(),
      workflowId: (holder.workflowId as string).trim(),
      revision: holder.revision as number,
      nodeId: (holder.nodeId as string).trim(),
      attemptId: (holder.attemptId as string).trim(),
    },
    paths: {
      readPaths,
      writePaths,
    },
  };
  if (record.baseRevision !== undefined) {
    lease.baseRevision = (record.baseRevision as string).trim();
  }
  return { ok: true, value: lease };
}

/**
 * Build an ExecutorWorkspaceLeaseRef from a full lease.
 * Does not mutate the lease.
 */
export function toExecutorWorkspaceLeaseRef(lease: WorkspaceLease): ExecutorWorkspaceLeaseRef {
  return {
    leaseId: lease.leaseId,
    ...(lease.baseRevision !== undefined ? { baseRevision: lease.baseRevision } : {}),
  };
}

// ---------------------------------------------------------------------------
// Active set operations
// ---------------------------------------------------------------------------

/**
 * Create an empty active lease set.
 * schemaVersion is fixed for this contract version.
 */
export function createEmptyWorkspaceLeaseSet(): WorkspaceLeaseSet {
  return {
    schemaVersion: WORKSPACE_LEASE_SET_SCHEMA_VERSION,
    leases: [],
  };
}

/**
 * Reject an unsupported lease-set schema version.
 * Used when a future restore path supplies a set with a version field.
 */
export function validateWorkspaceLeaseSetSchema(
  value: unknown,
  location = "leaseSet",
): Diagnostic[] {
  if (!isStrictPlainObject(value)) {
    return [reject(
      "workspace_lease_set_not_plain_object",
      "Workspace lease set must be a plain object.",
      location,
    )];
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== WORKSPACE_LEASE_SET_SCHEMA_VERSION) {
    return [reject(
      "workspace_lease_set_unsupported_schema",
      `Unsupported workspace lease set schema version '${String(record.schemaVersion)}'. Expected ${WORKSPACE_LEASE_SET_SCHEMA_VERSION}.`,
      `${location}.schemaVersion`,
    )];
  }
  if (!Array.isArray(record.leases)) {
    return [reject(
      "workspace_lease_set_invalid_leases",
      "Workspace lease set leases must be an array.",
      `${location}.leases`,
    )];
  }
  return [];
}

function cloneLeaseSet(set: WorkspaceLeaseSet): WorkspaceLeaseSet {
  return {
    schemaVersion: WORKSPACE_LEASE_SET_SCHEMA_VERSION,
    leases: set.leases.map((lease) => structuredClone(lease)),
  };
}

/**
 * List active leases as deep clones so callers cannot mutate the set.
 * Rejects an unsupported lease-set schema version.
 */
export function listWorkspaceLeases(set: WorkspaceLeaseSet): WorkspaceLeaseListResult {
  const schemaDiagnostics = validateWorkspaceLeaseSetSchema(set, "leaseSet");
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }
  return {
    ok: true,
    leases: set.leases
      .map((lease) => structuredClone(lease))
      .sort((left, right) => left.leaseId.localeCompare(right.leaseId)),
  };
}

/**
 * Return a deep clone of one active lease, or undefined when absent.
 * Trims the lookup id to match stored identity. Rejects unsupported schema.
 */
export function getWorkspaceLease(
  set: WorkspaceLeaseSet,
  leaseId: string,
): WorkspaceLeaseGetResult {
  const schemaDiagnostics = validateWorkspaceLeaseSetSchema(set, "leaseSet");
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }
  if (typeof leaseId !== "string") {
    return { ok: true, lease: undefined };
  }
  const id = leaseId.trim();
  if (id.length === 0) return { ok: true, lease: undefined };
  const found = set.leases.find((lease) => lease.leaseId === id);
  return { ok: true, lease: found ? structuredClone(found) : undefined };
}

/**
 * Check whether a candidate lease can join the active set.
 * Validates the candidate and checks identity uniqueness and path compatibility.
 * Does not mutate inputs.
 */
export function canAcquireWorkspaceLease(
  set: WorkspaceLeaseSet,
  candidate: unknown,
  bounds?: WorkspaceLeaseBounds,
): WorkspaceLeaseCompatibilityResult {
  const resolvedBounds = resolveLeaseBounds(bounds);
  if (!resolvedBounds.ok) {
    return { ok: false, diagnostics: resolvedBounds.diagnostics, conflictingLeaseIds: [] };
  }
  const { maxPaths, maxActiveLeases } = resolvedBounds;

  const schemaDiagnostics = validateWorkspaceLeaseSetSchema(set, "leaseSet");
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics, conflictingLeaseIds: [] };
  }

  const parsed = parseWorkspaceLease(candidate, "lease", { maxPaths });
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics, conflictingLeaseIds: [] };
  }
  const lease = parsed.value;

  if (set.leases.length >= maxActiveLeases) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_lease_active_limit",
        `The active lease set must not exceed ${maxActiveLeases} leases.`,
        "leaseSet.leases",
      )],
      conflictingLeaseIds: [],
    };
  }

  if (set.leases.some((active) => active.leaseId === lease.leaseId)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_lease_duplicate_id",
        `Lease id '${lease.leaseId}' is already active.`,
        "lease.leaseId",
      )],
      conflictingLeaseIds: [lease.leaseId],
    };
  }

  const duplicateAttempt = set.leases.find(
    (active) => active.holder.attemptId === lease.holder.attemptId,
  );
  if (duplicateAttempt) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_lease_duplicate_attempt",
        `Attempt id '${lease.holder.attemptId}' already holds lease '${duplicateAttempt.leaseId}'.`,
        "lease.holder.attemptId",
      )],
      conflictingLeaseIds: [duplicateAttempt.leaseId],
    };
  }

  const conflicting = set.leases.filter((active) => workspaceLeasesConflict(active, lease));
  if (conflicting.length > 0) {
    const conflictingLeaseIds = conflicting
      .map((item) => item.leaseId)
      .sort((left, right) => left.localeCompare(right));
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_lease_incompatible",
        `Requested lease conflicts with active lease(s): ${conflictingLeaseIds.join(", ")}.`,
        "lease",
      )],
      conflictingLeaseIds,
    };
  }

  return { ok: true };
}

/**
 * Validate, check compatibility, and add a lease to a new active set.
 * Does not mutate the input set or candidate.
 */
export function acquireWorkspaceLease(
  set: WorkspaceLeaseSet,
  candidate: unknown,
  bounds?: WorkspaceLeaseBounds,
): WorkspaceLeaseAcquireResult {
  const check = canAcquireWorkspaceLease(set, candidate, bounds);
  if (!check.ok) {
    return {
      ok: false,
      diagnostics: check.diagnostics,
      ...(check.conflictingLeaseIds !== undefined
        ? { conflictingLeaseIds: check.conflictingLeaseIds }
        : {}),
    };
  }

  const resolvedBounds = resolveLeaseBounds(bounds);
  if (!resolvedBounds.ok) {
    return { ok: false, diagnostics: resolvedBounds.diagnostics };
  }

  const parsed = parseWorkspaceLease(candidate, "lease", { maxPaths: resolvedBounds.maxPaths });
  if (!parsed.ok) {
    // Defensive: canAcquire already validated.
    return { ok: false, diagnostics: parsed.diagnostics };
  }

  const next = cloneLeaseSet(set);
  next.leases.push(structuredClone(parsed.value));
  next.leases.sort((left, right) => left.leaseId.localeCompare(right.leaseId));
  return { ok: true, set: next };
}

/**
 * Release a lease by id. Returns a new set.
 * When the id is absent, released is false and the set is still cloned.
 * Trims the release id to match stored identity.
 * Rejects an unsupported lease-set schema version without rewriting it.
 * Does not mutate the input set.
 */
export function releaseWorkspaceLease(
  set: WorkspaceLeaseSet,
  leaseId: string,
): WorkspaceLeaseReleaseResult {
  const schemaDiagnostics = validateWorkspaceLeaseSetSchema(set, "leaseSet");
  if (schemaDiagnostics.length > 0) {
    return { ok: false, diagnostics: schemaDiagnostics };
  }

  if (typeof leaseId !== "string" || leaseId.trim().length === 0) {
    return {
      ok: true,
      set: cloneLeaseSet(set),
      released: false,
    };
  }

  const id = leaseId.trim();
  const remaining = set.leases.filter((lease) => lease.leaseId !== id);
  const released = remaining.length !== set.leases.length;
  return {
    ok: true,
    set: {
      schemaVersion: WORKSPACE_LEASE_SET_SCHEMA_VERSION,
      leases: remaining.map((lease) => structuredClone(lease)),
    },
    released,
  };
}

/**
 * Propose a lease from holder identity and scopes without assigning acquisition.
 * Validates and returns a canonical lease record. Does not mutate inputs.
 */
export function proposeWorkspaceLease(input: {
  leaseId: string;
  mode: WorkspaceLeaseMode;
  holder: WorkspaceLeaseHolder;
  paths: WorkspaceLeasePaths;
  baseRevision?: string;
}, bounds?: Pick<WorkspaceLeaseBounds, "maxPaths">):
  | { ok: true; value: WorkspaceLease }
  | { ok: false; diagnostics: Diagnostic[] } {
  const payload: Record<string, unknown> = {
    leaseId: input.leaseId,
    mode: input.mode,
    holder: {
      familyId: input.holder.familyId,
      goalId: input.holder.goalId,
      workflowId: input.holder.workflowId,
      revision: input.holder.revision,
      nodeId: input.holder.nodeId,
      attemptId: input.holder.attemptId,
    },
    paths: {
      readPaths: [...input.paths.readPaths],
      writePaths: [...input.paths.writePaths],
    },
  };
  if (input.baseRevision !== undefined) {
    payload.baseRevision = input.baseRevision;
  }
  return parseWorkspaceLease(payload, "lease", bounds);
}
