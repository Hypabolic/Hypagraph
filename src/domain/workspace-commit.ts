/**
 * Pure structured worker commit results for mutating attempts (M8-s3).
 *
 * After a worker mutates a prepared worktree, the host collects commit identity
 * and changed paths into this record. The controller later validates scope and
 * integrates the commit. This module does not call git or touch the filesystem.
 *
 * Domain helpers are pure: no clock, random, files, network, or input mutation.
 * schemaVersion is reserved for later persistence. Unsupported versions fail
 * with a clear diagnostic.
 *
 * Maps to ExecutorWorkspaceResult for ExecutorResult.workspace population.
 */

import type { ExecutorWorkspaceResult } from "./executor-contract.js";
import type { Diagnostic } from "./model.js";
import type { WorkspaceLeaseHolder } from "./workspace-lease.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema version for a worker commit result record. Always 1 in this slice. */
export const WORKER_COMMIT_RESULT_SCHEMA_VERSION = 1 as const;

/**
 * Default maximum changed paths on one worker commit result.
 * Always enforced when a max bound is set (including the default).
 */
export const DEFAULT_MAX_CHANGED_PATHS = 4096;

/**
 * Workspace clean/dirty status for a worker commit result.
 * Aligns with ExecutorWorkspaceResult.status.
 *
 * - clean: worktree HEAD has no uncommitted changes (index and work tree match
 *   HEAD). changedPaths lists paths that differ between baseRevision and HEAD.
 * - dirty: uncommitted staged, unstaged, or untracked changes remain.
 * - conflicted: unmerged paths, porcelain conflict codes, or an active incomplete
 *   merge, rebase, cherry-pick, or revert (even when unmerged paths are empty).
 * - unknown: the host could not determine clean, dirty, or conflicted status.
 */
export const WORKER_WORKSPACE_STATUSES = [
  "clean",
  "dirty",
  "conflicted",
  "unknown",
] as const;

export type WorkerWorkspaceStatus = (typeof WORKER_WORKSPACE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structured worker commit result after work in a prepared worktree.
 * Identity fields (leaseId, worktreeId, holder) let later slices reject stale
 * results that no longer match the active lease or worktree.
 */
export interface WorkerCommitResult {
  schemaVersion: typeof WORKER_COMMIT_RESULT_SCHEMA_VERSION;
  leaseId: string;
  worktreeId: string;
  holder: WorkspaceLeaseHolder;
  /**
   * Full git commit object id at HEAD (40 hex SHA-1 or 64 hex SHA-256).
   * Host collectors prefer the full hash from rev-parse.
   */
  commitHash: string;
  /** Base git revision the worktree was prepared from. */
  baseRevision: string;
  /**
   * Workspace-relative changed paths versus baseRevision.
   * When status is dirty or conflicted, uncommitted paths are included.
   * Paths are git-relative: no absolute form, no `..` segments.
   * Literal backslashes are preserved (POSIX treats `\` as a normal character).
   */
  changedPaths: string[];
  status: WorkerWorkspaceStatus;
  /** True when commitHash differs from baseRevision (HEAD advanced). */
  headAdvanced: boolean;
}

export type WorkerCommitParseResult =
  | { ok: true; value: WorkerCommitResult }
  | { ok: false; diagnostics: Diagnostic[] };

export type WorkerCommitMapResult =
  | { ok: true; value: ExecutorWorkspaceResult }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Expected identity for stale-result rejection.
 * All present fields must match the result. Omitted fields are not checked.
 */
export interface WorkerCommitExpectedIdentity {
  leaseId?: string;
  worktreeId?: string;
  holder?: WorkspaceLeaseHolder;
}

export interface WorkerCommitBounds {
  /**
   * Maximum changed path entries.
   * Default DEFAULT_MAX_CHANGED_PATHS. When present must be a non-negative
   * safe integer. The bound is always enforced.
   */
  maxChangedPaths?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const WORKER_WORKSPACE_STATUS_SET = new Set<string>(WORKER_WORKSPACE_STATUSES);

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

/**
 * Full git object id: 40 hex (SHA-1) or 64 hex (SHA-256).
 * Host collectors produce full hashes. Validation rejects short prefixes.
 */
export function isFullGitObjectId(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

/**
 * Normalise a git worktree-relative path without rewriting path bytes.
 *
 * Rules:
 * - Reject empty strings and control characters (including NUL).
 * - Reject absolute form only when the path starts with `/` (git multi-segment
 *   root). Leading `\` and drive-like prefixes such as `C:` are kept as ordinary
 *   relative path text (valid POSIX file names).
 * - Split only on `/` (git multi-segment separator).
 * - Reject `..` segments.
 * - Drop empty and `.` segments.
 * - Preserve literal backslashes (POSIX path characters, not separators).
 *
 * Returns undefined when the path is unsupported. Callers must fail closed.
 */
export function canonicalGitRelativePath(value: string): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  // Only a leading forward slash is absolute for this git-relative contract.
  if (value.startsWith("/")) return undefined;
  // Control characters are not valid path components for this contract.
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  // Do not rewrite `\` to `/`. Split only on forward slash.
  const segments = value.split("/");
  if (segments.includes("..")) return undefined;
  const kept = segments.filter((segment) => segment !== "" && segment !== ".");
  if (kept.length === 0) return undefined;
  return kept.join("/");
}

/**
 * Deterministic ordinal compare for git-relative path strings.
 * Uses UTF-16 code unit order (`<` / `>`), not locale-sensitive collation.
 * Domain and host must use this helper so ordering does not depend on host locale.
 */
export function compareGitPathOrdinal(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

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
        "workspace_commit_invalid_bound",
        `Bound at ${location} must be a non-negative safe integer when present.`,
        location,
      ),
    };
  }
  return { ok: true, value };
}

function resolveCommitBounds(
  bounds: WorkerCommitBounds | undefined,
): { ok: true; maxChangedPaths: number } | { ok: false; diagnostics: Diagnostic[] } {
  const maxPaths = resolveNonNegativeSafeIntegerBound(
    bounds?.maxChangedPaths,
    DEFAULT_MAX_CHANGED_PATHS,
    "bounds.maxChangedPaths",
  );
  if (!maxPaths.ok) return { ok: false, diagnostics: [maxPaths.diagnostic] };
  return { ok: true, maxChangedPaths: maxPaths.value };
}

function validateHolder(
  holder: unknown,
  location: string,
  diagnostics: Diagnostic[],
): WorkspaceLeaseHolder | undefined {
  if (!isStrictPlainObject(holder)) {
    diagnostics.push(reject(
      "workspace_commit_invalid_holder",
      "Worker commit holder must be a plain object.",
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
        "workspace_commit_invalid_holder",
        `Worker commit holder.${field} must be a non-empty string.`,
        `${location}.${field}`,
      ));
      failed = true;
    }
  }
  if (!isNonNegativeSafeInteger(record.revision)) {
    diagnostics.push(reject(
      "workspace_commit_invalid_holder",
      "Worker commit holder.revision must be a non-negative safe integer.",
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

/**
 * Validate and normalise a changed-path list with git path rules.
 * Rejects non-arrays, over-bound lists, non-strings, absolute paths, and `..`.
 * Preserves literal backslashes. Always enforces maxChangedPaths.
 */
function validateChangedPaths(
  paths: unknown,
  location: string,
  maxChangedPaths: number,
  diagnostics: Diagnostic[],
): string[] | undefined {
  if (!Array.isArray(paths)) {
    diagnostics.push(reject(
      "workspace_commit_invalid_path_list",
      "changedPaths must be a string array.",
      location,
    ));
    return undefined;
  }
  if (paths.length > maxChangedPaths) {
    diagnostics.push(reject(
      "workspace_commit_path_limit",
      `changedPaths must not exceed ${maxChangedPaths} entries.`,
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
        "workspace_commit_invalid_path",
        `Path at index ${index} must be a string.`,
        `${location}[${index}]`,
      ));
      failed = true;
      continue;
    }
    const canonical = canonicalGitRelativePath(item);
    if (canonical === undefined) {
      diagnostics.push(reject(
        "workspace_commit_invalid_path",
        `Path at index ${index} must be a non-empty git-relative path without traversal or absolute form.`,
        `${location}[${index}]`,
      ));
      failed = true;
      continue;
    }
    if (seen.has(canonical)) {
      diagnostics.push(reject(
        "workspace_commit_duplicate_path",
        `Path at index ${index} duplicates a git-relative path on this result.`,
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

// ---------------------------------------------------------------------------
// Validation and parse
// ---------------------------------------------------------------------------

/**
 * Validate a worker commit result.
 * Accepts untrusted input. Rejects class instances. Does not mutate input.
 * Always enforces the changed-path bound (default or supplied).
 */
export function validateWorkerCommitResult(
  value: unknown,
  location = "workerCommit",
  bounds?: WorkerCommitBounds,
): Diagnostic[] {
  const boundResolution = resolveCommitBounds(bounds);
  if (!boundResolution.ok) return boundResolution.diagnostics;
  const { maxChangedPaths } = boundResolution;
  const diagnostics: Diagnostic[] = [];

  if (!isStrictPlainObject(value)) {
    return [reject(
      "workspace_commit_not_plain_object",
      "Worker commit result must be a plain object.",
      location,
    )];
  }

  const record = value;

  if (record.schemaVersion !== WORKER_COMMIT_RESULT_SCHEMA_VERSION) {
    diagnostics.push(reject(
      "workspace_commit_unsupported_schema",
      `Unsupported worker commit result schema version '${String(record.schemaVersion)}'. Expected ${WORKER_COMMIT_RESULT_SCHEMA_VERSION}.`,
      `${location}.schemaVersion`,
    ));
  }

  if (!isNonEmptyString(record.leaseId)) {
    diagnostics.push(reject(
      "workspace_commit_invalid_lease_id",
      "leaseId must be a non-empty string.",
      `${location}.leaseId`,
    ));
  }

  if (!isNonEmptyString(record.worktreeId)) {
    diagnostics.push(reject(
      "workspace_commit_invalid_worktree_id",
      "worktreeId must be a non-empty string.",
      `${location}.worktreeId`,
    ));
  }

  if (!isNonEmptyString(record.commitHash) || !isFullGitObjectId(record.commitHash.trim())) {
    diagnostics.push(reject(
      "workspace_commit_invalid_commit_hash",
      "commitHash must be a full git object id (40 or 64 hexadecimal characters).",
      `${location}.commitHash`,
    ));
  }

  if (!isNonEmptyString(record.baseRevision) || !isFullGitObjectId(record.baseRevision.trim())) {
    diagnostics.push(reject(
      "workspace_commit_invalid_base_revision",
      "baseRevision must be a full git object id (40 or 64 hexadecimal characters).",
      `${location}.baseRevision`,
    ));
  }

  if (
    typeof record.status !== "string"
    || !WORKER_WORKSPACE_STATUS_SET.has(record.status)
  ) {
    diagnostics.push(reject(
      "workspace_commit_invalid_status",
      "status must be 'clean', 'dirty', 'conflicted', or 'unknown'.",
      `${location}.status`,
    ));
  }

  if (typeof record.headAdvanced !== "boolean") {
    diagnostics.push(reject(
      "workspace_commit_invalid_head_advanced",
      "headAdvanced must be a boolean.",
      `${location}.headAdvanced`,
    ));
  } else if (
    isNonEmptyString(record.commitHash)
    && isFullGitObjectId(record.commitHash.trim())
    && isNonEmptyString(record.baseRevision)
    && isFullGitObjectId(record.baseRevision.trim())
  ) {
    const expectedAdvanced = record.commitHash.trim().toLowerCase()
      !== record.baseRevision.trim().toLowerCase();
    if (record.headAdvanced !== expectedAdvanced) {
      diagnostics.push(reject(
        "workspace_commit_head_advanced_invariant",
        `headAdvanced must equal (commitHash !== baseRevision). Expected ${String(expectedAdvanced)}.`,
        `${location}.headAdvanced`,
      ));
    }
  }

  validateHolder(record.holder, `${location}.holder`, diagnostics);
  validateChangedPaths(record.changedPaths, `${location}.changedPaths`, maxChangedPaths, diagnostics);

  return diagnostics;
}

/**
 * Parse and clone a valid worker commit result.
 * Normalises changed paths with git-relative rules and lowercases commit ids.
 * Does not mutate input.
 */
export function parseWorkerCommitResult(
  value: unknown,
  location = "workerCommit",
  bounds?: WorkerCommitBounds,
): WorkerCommitParseResult {
  const diagnostics = validateWorkerCommitResult(value, location, bounds);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const record = value as Record<string, unknown>;
  const holder = record.holder as Record<string, unknown>;
  const pathList = record.changedPaths as string[];
  const changedPaths = pathList
    .map((path) => canonicalGitRelativePath(path)!)
    .sort(compareGitPathOrdinal);

  const commitHash = (record.commitHash as string).trim().toLowerCase();
  const baseRevision = (record.baseRevision as string).trim().toLowerCase();

  const result: WorkerCommitResult = {
    schemaVersion: WORKER_COMMIT_RESULT_SCHEMA_VERSION,
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
    commitHash,
    baseRevision,
    changedPaths,
    status: record.status as WorkerWorkspaceStatus,
    headAdvanced: record.headAdvanced as boolean,
  };
  return { ok: true, value: result };
}

/**
 * Build a worker commit result from host-collected fields.
 * Accepts untrusted input. Does not read nested holder fields before validation.
 * Validates and returns a canonical record. Does not mutate inputs. Does not throw.
 */
export function proposeWorkerCommitResult(
  input: unknown,
  bounds?: WorkerCommitBounds,
): WorkerCommitParseResult {
  if (!isStrictPlainObject(input)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_commit_not_plain_object",
        "Worker commit proposal must be a plain object.",
        "workerCommit",
      )],
    };
  }
  const record = input;
  // Pass holder through without nested field access so malformed holders
  // produce diagnostics from parseWorkerCommitResult instead of exceptions.
  const changedPaths = Array.isArray(record.changedPaths)
    ? [...record.changedPaths]
    : record.changedPaths;
  const payload: Record<string, unknown> = {
    schemaVersion: WORKER_COMMIT_RESULT_SCHEMA_VERSION,
    leaseId: record.leaseId,
    worktreeId: record.worktreeId,
    holder: record.holder,
    commitHash: record.commitHash,
    baseRevision: record.baseRevision,
    changedPaths,
    status: record.status,
    headAdvanced: record.headAdvanced,
  };
  return parseWorkerCommitResult(payload, "workerCommit", bounds);
}

// ---------------------------------------------------------------------------
// Identity checks
// ---------------------------------------------------------------------------

/**
 * Report whether a commit result matches expected lease/worktree/holder identity.
 * Present expected fields must match. Omitted expected fields are not checked.
 * Does not mutate inputs.
 */
export function workerCommitMatchesExpectedIdentity(
  result: WorkerCommitResult,
  expected: WorkerCommitExpectedIdentity,
): boolean {
  if (expected.leaseId !== undefined) {
    if (result.leaseId !== expected.leaseId.trim()) return false;
  }
  if (expected.worktreeId !== undefined) {
    if (result.worktreeId !== expected.worktreeId.trim()) return false;
  }
  if (expected.holder !== undefined) {
    if (!holdersEqual(result.holder, expected.holder)) return false;
  }
  return true;
}

/**
 * Validate identity fields against an expected holder/lease/worktree.
 * Returns diagnostics when the result is stale or mismatched.
 * Does not mutate inputs.
 */
export function validateWorkerCommitIdentity(
  result: unknown,
  expected: WorkerCommitExpectedIdentity,
  location = "workerCommit",
  bounds?: WorkerCommitBounds,
): Diagnostic[] {
  const parsed = parseWorkerCommitResult(result, location, bounds);
  if (!parsed.ok) return parsed.diagnostics;

  const diagnostics: Diagnostic[] = [];
  const value = parsed.value;

  if (expected.leaseId !== undefined) {
    const expectedLease = expected.leaseId.trim();
    if (expectedLease.length === 0) {
      diagnostics.push(reject(
        "workspace_commit_stale_identity",
        "Expected leaseId must be a non-empty string when present.",
        "expected.leaseId",
      ));
    } else if (value.leaseId !== expectedLease) {
      diagnostics.push(reject(
        "workspace_commit_stale_identity",
        `Worker commit leaseId '${value.leaseId}' does not match expected leaseId '${expectedLease}'.`,
        `${location}.leaseId`,
      ));
    }
  }

  if (expected.worktreeId !== undefined) {
    const expectedWorktree = expected.worktreeId.trim();
    if (expectedWorktree.length === 0) {
      diagnostics.push(reject(
        "workspace_commit_stale_identity",
        "Expected worktreeId must be a non-empty string when present.",
        "expected.worktreeId",
      ));
    } else if (value.worktreeId !== expectedWorktree) {
      diagnostics.push(reject(
        "workspace_commit_stale_identity",
        `Worker commit worktreeId '${value.worktreeId}' does not match expected worktreeId '${expectedWorktree}'.`,
        `${location}.worktreeId`,
      ));
    }
  }

  if (expected.holder !== undefined) {
    if (!holdersEqual(value.holder, expected.holder)) {
      diagnostics.push(reject(
        "workspace_commit_stale_identity",
        "Worker commit holder does not match the expected lease holder.",
        `${location}.holder`,
      ));
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// ExecutorWorkspaceResult mapping
// ---------------------------------------------------------------------------

/**
 * Map a validated worker commit result to ExecutorWorkspaceResult.
 * Populates leaseId, commitHash, changedPaths, and status.
 * Does not mutate the input.
 */
export function toExecutorWorkspaceResult(
  result: WorkerCommitResult,
): ExecutorWorkspaceResult {
  return {
    leaseId: result.leaseId,
    commitHash: result.commitHash,
    changedPaths: [...result.changedPaths],
    status: result.status,
  };
}

/**
 * Parse untrusted input and map to ExecutorWorkspaceResult.
 * Returns diagnostics on validation failure. Does not mutate input.
 */
export function mapWorkerCommitToExecutorWorkspace(
  value: unknown,
  location = "workerCommit",
  bounds?: WorkerCommitBounds,
): WorkerCommitMapResult {
  const parsed = parseWorkerCommitResult(value, location, bounds);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  return { ok: true, value: toExecutorWorkspaceResult(parsed.value) };
}

/**
 * Rebuild a WorkerCommitResult from ExecutorWorkspaceResult plus identity.
 * Requires identity fields that ExecutorWorkspaceResult does not carry.
 * Does not mutate inputs.
 */
export function workerCommitFromExecutorWorkspace(
  workspace: ExecutorWorkspaceResult,
  identity: {
    worktreeId: string;
    holder: WorkspaceLeaseHolder;
    baseRevision: string;
    headAdvanced?: boolean;
  },
  bounds?: WorkerCommitBounds,
): WorkerCommitParseResult {
  if (!isStrictPlainObject(workspace as unknown)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_commit_not_plain_object",
        "Executor workspace result must be a plain object.",
        "workspace",
      )],
    };
  }

  const commitHash = workspace.commitHash;
  const leaseId = workspace.leaseId;
  const status = workspace.status;
  const changedPaths = workspace.changedPaths;

  if (!isNonEmptyString(leaseId)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_commit_invalid_lease_id",
        "workspace.leaseId must be a non-empty string to rebuild a worker commit.",
        "workspace.leaseId",
      )],
    };
  }
  if (!isNonEmptyString(commitHash)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_commit_invalid_commit_hash",
        "workspace.commitHash must be a non-empty string to rebuild a worker commit.",
        "workspace.commitHash",
      )],
    };
  }
  if (status === undefined || typeof status !== "string" || !WORKER_WORKSPACE_STATUS_SET.has(status)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_commit_invalid_status",
        "workspace.status must be a known status to rebuild a worker commit.",
        "workspace.status",
      )],
    };
  }

  const headAdvanced = identity.headAdvanced !== undefined
    ? identity.headAdvanced
    : commitHash.trim().toLowerCase() !== identity.baseRevision.trim().toLowerCase();

  // Pass identity fields as a plain object; propose does not nest-read holder.
  return proposeWorkerCommitResult({
    leaseId,
    worktreeId: identity.worktreeId,
    holder: identity.holder as unknown,
    commitHash,
    baseRevision: identity.baseRevision,
    changedPaths: changedPaths !== undefined ? [...changedPaths] : [],
    status: status as WorkerWorkspaceStatus,
    headAdvanced,
  }, bounds);
}

/**
 * Build the workspace field for buildExecutorResultPayload from a worker commit.
 * Validates first. Does not mutate input.
 */
export function executorWorkspaceFromWorkerCommit(
  value: unknown,
  location = "workerCommit",
  bounds?: WorkerCommitBounds,
): WorkerCommitMapResult {
  return mapWorkerCommitToExecutorWorkspace(value, location, bounds);
}
