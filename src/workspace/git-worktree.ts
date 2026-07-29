/**
 * Host operations for git worktrees used by mutating attempts (M8-s2).
 *
 * This module may call git and the filesystem. It never mutates canonical
 * graph or family state. Pure registry helpers live in workspace-worktree.ts.
 *
 * Controller path for this slice:
 * 1. Acquire an exclusive workspace lease (m8-s1).
 * 2. Call prepareMutatingAttemptWorktree for that lease.
 * 3. Use the returned worktree.path as the executor working directory later.
 *
 * Shared leases omit worktree creation. Only exclusive leases prepare one.
 *
 * Prepare recovery policy:
 * - ready + directory still present and inside parent: return existing record.
 * - ready + missing directory: release registry row and recreate.
 * - preparing (stuck mid-prepare): release registry row; disk/branch cleanup only
 *   when the path is inside the controlled parent; then recreate.
 * - path escapes parent after realpath: fail closed; do not recreate.
 */

import { spawn } from "node:child_process";
import { access, mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Diagnostic } from "../domain/model.js";
import type { WorkspaceLease } from "../domain/workspace-lease.js";
import {
  createEmptyWorkspaceWorktreeSet,
  deriveWorktreeBranchName,
  deriveWorktreeDirectoryName,
  deriveWorktreeId,
  getActiveWorktreeForLease,
  proposeReadyWorktree,
  registerWorktree,
  releaseWorktreeRecord,
  requireExclusiveLeaseForWorktree,
  type WorkspaceWorktree,
  type WorkspaceWorktreeSet,
} from "../domain/workspace-worktree.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_GIT_OUTPUT_BYTES = 1_048_576;

/** Default relative parent under a base repo when worktreeParentRoot is omitted. */
export const DEFAULT_WORKTREE_PARENT_SEGMENT = ".hypagraph/worktrees";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type PrepareMutatingAttemptWorktreeResult =
  | {
    ok: true;
    set: WorkspaceWorktreeSet;
    worktree: WorkspaceWorktree;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
    set: WorkspaceWorktreeSet;
  };

export type ReleaseAttemptWorktreeResult =
  | {
    ok: true;
    set: WorkspaceWorktreeSet;
    released: boolean;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
    set: WorkspaceWorktreeSet;
  };

export interface PrepareMutatingAttemptWorktreeInput {
  /** Absolute or relative path to the base git repository. */
  baseRepoPath: string;
  /**
   * Absolute or relative path to the controlled parent directory for worktrees.
   * When omitted, uses `<baseRepoPath>/.hypagraph/worktrees`.
   */
  worktreeParentRoot?: string;
  /** Exclusive workspace lease for this mutating attempt. */
  lease: WorkspaceLease;
  /** Current pure worktree registry. Not mutated. */
  set: WorkspaceWorktreeSet;
  /** Optional worktree id override. Default derives from leaseId. */
  worktreeId?: string;
  /** Optional branch name override. Default derives from leaseId. */
  branchName?: string;
  signal?: AbortSignal;
}

export interface ReleaseAttemptWorktreeInput {
  baseRepoPath: string;
  set: WorkspaceWorktreeSet;
  /**
   * Controlled parent for containment. When omitted, uses the record
   * parentRoot or `<baseRepoPath>/.hypagraph/worktrees`.
   */
  worktreeParentRoot?: string;
  /** Prefer worktreeId when known. */
  worktreeId?: string;
  /** Release by lease when worktreeId is absent. */
  leaseId?: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const reject = (code: string, message: string, location?: string): Diagnostic => ({
  code,
  message,
  ...(location !== undefined ? { location } : {}),
});

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

/**
 * Resolve a directory and confirm it does not escape via empty relative check.
 */
function resolveRoot(pathValue: string, location: string):
  | { ok: true; path: string }
  | { ok: false; diagnostic: Diagnostic } {
  if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
    return {
      ok: false,
      diagnostic: reject(
        "workspace_worktree_invalid_path",
        `${location} must be a non-empty path.`,
        location,
      ),
    };
  }
  try {
    return { ok: true, path: resolve(pathValue) };
  } catch {
    return {
      ok: false,
      diagnostic: reject(
        "workspace_worktree_invalid_path",
        `${location} could not be resolved.`,
        location,
      ),
    };
  }
}

/**
 * Fail closed when a candidate path is not strictly inside a parent root.
 * Uses path.relative after resolve. Does not follow symlinks.
 * Prefer isPathInsideParentCanonical when the path may exist on disk.
 */
export function isPathInsideParent(parentRoot: string, candidatePath: string): boolean {
  const parent = resolve(parentRoot);
  const candidate = resolve(candidatePath);
  if (parent === candidate) return false;
  const rel = relative(parent, candidate);
  if (rel === "") return false;
  if (isAbsolute(rel)) return false;
  if (rel === "..") return false;
  if (rel.startsWith(`..${sep}`) || rel.startsWith("../") || rel.startsWith("..\\")) {
    return false;
  }
  return true;
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await access(pathValue);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve to a canonical absolute path when the path exists.
 * When the leaf path is missing, realpath the nearest existing ancestor and
 * rejoin the missing segments so macOS /var versus /private/var still unifies.
 */
async function canonicalPath(pathValue: string): Promise<string> {
  const resolved = resolve(pathValue);
  try {
    return await realpath(resolved);
  } catch {
    // Walk up until an existing ancestor can be realpathed.
    const missing: string[] = [];
    let current = resolved;
    while (current !== dirname(current)) {
      missing.unshift(basename(current));
      const parent = dirname(current);
      try {
        const realParent = await realpath(parent);
        return join(realParent, ...missing);
      } catch {
        current = parent;
      }
    }
    return resolved;
  }
}

/**
 * Containment check that follows symlinks when paths exist.
 * - When the candidate does not exist: resolve-only containment.
 * - When the candidate exists: realpath both sides; fail closed if realpath fails.
 * - When requireExisting is true: candidate must exist and pass realpath containment.
 */
export async function isPathInsideParentCanonical(
  parentRoot: string,
  candidatePath: string,
  options?: { requireExisting?: boolean },
): Promise<boolean> {
  const resolvedParent = resolve(parentRoot);
  const resolvedCandidate = resolve(candidatePath);

  if (!isPathInsideParent(resolvedParent, resolvedCandidate)) {
    return false;
  }

  const candidateExists = await pathExists(resolvedCandidate);
  if (options?.requireExisting && !candidateExists) {
    return false;
  }
  if (!candidateExists) {
    return true;
  }

  let realParent: string;
  let realCandidate: string;
  try {
    if (await pathExists(resolvedParent)) {
      realParent = await realpath(resolvedParent);
    } else {
      realParent = resolvedParent;
    }
  } catch {
    return false;
  }
  try {
    realCandidate = await realpath(resolvedCandidate);
  } catch {
    // Existing path must realpath successfully (fail closed).
    return false;
  }
  return isPathInsideParent(realParent, realCandidate);
}

async function pathsReferToSameLocation(left: string, right: string): Promise<boolean> {
  const a = await canonicalPath(left);
  const b = await canonicalPath(right);
  return a === b;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<{ ok: true; stdout: string } | { ok: false; message: string; aborted: boolean }> {
  if (signal?.aborted) {
    return { ok: false, message: "The worktree operation was cancelled.", aborted: true };
  }

  const child = spawn("git", args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(signal === undefined ? {} : { signal }),
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputExceeded = false;

  const append = (target: Buffer[], chunk: Buffer, current: number): number => {
    if (current >= MAX_GIT_OUTPUT_BYTES) {
      outputExceeded = true;
      return current;
    }
    const accepted = chunk.subarray(0, MAX_GIT_OUTPUT_BYTES - current);
    if (accepted.length !== chunk.length) outputExceeded = true;
    target.push(Buffer.from(accepted));
    return current + accepted.length;
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes = append(stdoutChunks, chunk, stdoutBytes);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes = append(stderrChunks, chunk, stderrBytes);
  });

  try {
    const exitCode = await new Promise<number>((resolveExit, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code) => resolveExit(code ?? -1));
    });
    const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (outputExceeded) {
      return {
        ok: false,
        message: "Git output exceeded the fixed read limit.",
        aborted: false,
      };
    }
    if (exitCode !== 0) {
      return {
        ok: false,
        message: stderrText || `Git exited with code ${exitCode}.`,
        aborted: false,
      };
    }
    return {
      ok: true,
      stdout: Buffer.concat(stdoutChunks).toString("utf8").replace(/\r\n/g, "\n").trim(),
    };
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      return {
        ok: false,
        message: "The worktree operation was cancelled.",
        aborted: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message, aborted: false };
  }
}

async function assertGitRepository(
  baseRepoPath: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; diagnostics: Diagnostic[] }> {
  const result = await runGit(
    baseRepoPath,
    ["rev-parse", "--is-inside-work-tree"],
    signal,
  );
  if (!result.ok) {
    if (result.aborted) {
      return {
        ok: false,
        diagnostics: [reject(
          "workspace_worktree_aborted",
          "The worktree operation was cancelled.",
          "baseRepoPath",
        )],
      };
    }
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_worktree_not_git_repo",
        `Base path is not a git repository: ${result.message}`,
        "baseRepoPath",
      )],
    };
  }
  if (result.stdout !== "true") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_worktree_not_git_repo",
        "Base path is not a git work tree.",
        "baseRepoPath",
      )],
    };
  }
  return { ok: true };
}

async function resolveBaseRevision(
  baseRepoPath: string,
  leaseBaseRevision: string | undefined,
  signal?: AbortSignal,
): Promise<{ ok: true; revision: string } | { ok: false; diagnostics: Diagnostic[] }> {
  const revspec = leaseBaseRevision !== undefined && leaseBaseRevision.trim().length > 0
    ? `${leaseBaseRevision.trim()}^{commit}`
    : "HEAD^{commit}";
  const result = await runGit(
    baseRepoPath,
    ["rev-parse", "--verify", revspec],
    signal,
  );
  if (!result.ok) {
    if (result.aborted) {
      return {
        ok: false,
        diagnostics: [reject(
          "workspace_worktree_aborted",
          "The worktree operation was cancelled.",
          "lease.baseRevision",
        )],
      };
    }
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_worktree_git_failed",
        `Could not resolve base revision: ${result.message}`,
        "lease.baseRevision",
      )],
    };
  }
  if (result.stdout.trim().length === 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_worktree_git_failed",
        "Resolved base revision was empty.",
        "lease.baseRevision",
      )],
    };
  }
  return { ok: true, revision: result.stdout.trim() };
}

async function safeRemovePath(pathValue: string): Promise<void> {
  try {
    await rm(pathValue, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of partial prepare state.
  }
}

/**
 * Delete an isolation branch created by prepare.
 * Best-effort: missing branch is not an error.
 */
async function deleteIsolationBranch(
  baseRepoPath: string,
  branchName: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (branchName === undefined || branchName.trim().length === 0) return;
  await runGit(baseRepoPath, ["branch", "-D", branchName.trim()], signal);
}

/**
 * Full prepare rollback: remove worktree registration and isolation branch.
 * Caller must ensure worktreePath is inside the controlled parent when the path
 * comes from untrusted registry state.
 */
async function rollbackPreparedWorktree(
  baseRepoPath: string,
  worktreePath: string,
  branchName: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  await removeGitWorktree(baseRepoPath, worktreePath, signal);
  await deleteIsolationBranch(baseRepoPath, branchName, signal);
}

/**
 * Best-effort disk/branch cleanup only when the path is inside the parent.
 * When the path escapes or cannot be proven inside, skip filesystem remove and
 * branch delete so corrupted registry rows cannot delete unrelated trees.
 * Returns whether disk cleanup ran.
 */
async function safeCleanupIfInsideParent(
  baseRepoPath: string,
  parentRoot: string,
  worktreePath: string,
  branchName: string | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  if (worktreePath.trim().length === 0) return false;
  const inside = await isPathInsideParentCanonical(parentRoot, worktreePath, {
    requireExisting: false,
  });
  if (!inside) return false;
  if (await pathExists(worktreePath)) {
    const stillInside = await isPathInsideParentCanonical(parentRoot, worktreePath, {
      requireExisting: true,
    });
    if (!stillInside) return false;
  }
  await rollbackPreparedWorktree(baseRepoPath, worktreePath, branchName, signal);
  return true;
}

/**
 * Report whether git worktree list still names this worktree path.
 * Checks git metadata only. Path may already be missing on disk.
 * When list fails without abort, fail closed (treat as still listed).
 */
async function worktreeListedInGit(
  baseRepoPath: string,
  worktreePath: string,
  signal?: AbortSignal,
): Promise<{ listed: boolean; aborted: boolean; message?: string }> {
  const listed = await runGit(baseRepoPath, ["worktree", "list", "--porcelain"], signal);
  if (!listed.ok) {
    if (listed.aborted) {
      return { listed: true, aborted: true, message: listed.message };
    }
    // Fail closed: unknown list state is not treated as clean removal.
    return {
      listed: true,
      aborted: false,
      message: listed.message,
    };
  }
  const lines = listed.stdout.split("\n");
  for (const line of lines) {
    if (!line.startsWith("worktree ")) continue;
    const entryPath = line.slice("worktree ".length).trim();
    if (await pathsReferToSameLocation(entryPath, worktreePath)) {
      return { listed: true, aborted: false };
    }
  }
  return { listed: false, aborted: false };
}

async function removeGitWorktree(
  baseRepoPath: string,
  worktreePath: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; message: string; aborted: boolean }> {
  const remove = await runGit(
    baseRepoPath,
    ["worktree", "remove", "--force", worktreePath],
    signal,
  );
  if (remove.ok) {
    // Require git metadata gone even when remove reports success.
    const afterOk = await worktreeListedInGit(baseRepoPath, worktreePath, signal);
    if (afterOk.aborted) {
      return {
        ok: false,
        message: afterOk.message ?? "The worktree operation was cancelled.",
        aborted: true,
      };
    }
    if (afterOk.listed) {
      return {
        ok: false,
        message: "Git still lists the worktree after worktree remove.",
        aborted: false,
      };
    }
    return { ok: true };
  }
  if (remove.aborted) {
    return { ok: false, message: remove.message, aborted: true };
  }
  // Fall back to prune + filesystem remove when the worktree is already gone.
  await runGit(baseRepoPath, ["worktree", "prune"], signal);
  await safeRemovePath(worktreePath);
  const stillExists = await pathExists(worktreePath);
  if (stillExists) {
    return { ok: false, message: remove.message, aborted: false };
  }
  // Directory gone is not enough: locked or stale git admin data can remain.
  const afterFallback = await worktreeListedInGit(baseRepoPath, worktreePath, signal);
  if (afterFallback.aborted) {
    return {
      ok: false,
      message: afterFallback.message ?? remove.message,
      aborted: true,
    };
  }
  if (afterFallback.listed) {
    // One more prune after the path is gone; locked entries still fail closed.
    await runGit(baseRepoPath, ["worktree", "prune"], signal);
    const stillListed = await worktreeListedInGit(baseRepoPath, worktreePath, signal);
    if (stillListed.aborted) {
      return {
        ok: false,
        message: stillListed.message ?? remove.message,
        aborted: true,
      };
    }
    if (stillListed.listed) {
      return {
        ok: false,
        message:
          "Worktree path was removed but git still lists the worktree. "
          + "Registry release is refused while git metadata remains.",
        aborted: false,
      };
    }
  }
  return { ok: true };
}

async function worktreeStillPresent(
  baseRepoPath: string,
  worktreePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!(await pathExists(worktreePath))) {
    return false;
  }
  const listed = await worktreeListedInGit(baseRepoPath, worktreePath, signal);
  // For ready re-verify: list failure falls closed as present (do not recreate).
  return listed.listed;
}

function resolveDefaultParent(baseRepoPath: string, worktreeParentRoot?: string): string {
  if (worktreeParentRoot !== undefined && worktreeParentRoot.trim().length > 0) {
    return resolve(worktreeParentRoot);
  }
  return resolve(baseRepoPath, DEFAULT_WORKTREE_PARENT_SEGMENT);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create or re-verify a git worktree for one exclusive mutating lease.
 *
 * Steps:
 * 1. Validate the lease with the full exclusive lease parser (m8-s1).
 * 2. When an active ready worktree already exists for the lease, re-verify it.
 * 3. When preparing or ready-but-missing, release the stale row and recreate.
 * 4. Otherwise create a worktree under the controlled parent root.
 * 5. Check out the lease baseRevision when present; otherwise use HEAD.
 * 6. Register a ready record in a new set. Never mutates the input set.
 *
 * On prepare failure the registry keeps no ready record for this attempt.
 * Partial filesystem paths and isolation branches are removed when safe.
 */
export async function prepareMutatingAttemptWorktree(
  input: PrepareMutatingAttemptWorktreeInput,
): Promise<PrepareMutatingAttemptWorktreeResult> {
  const set = input.set ?? createEmptyWorkspaceWorktreeSet();

  if (input.signal?.aborted) {
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_aborted",
        "The worktree operation was cancelled.",
        "signal",
      )],
    };
  }

  const exclusive = requireExclusiveLeaseForWorktree(input.lease, "lease");
  if (!exclusive.ok) {
    return { ok: false, set, diagnostics: exclusive.diagnostics };
  }
  const lease = exclusive.lease;

  const baseResolved = resolveRoot(input.baseRepoPath, "baseRepoPath");
  if (!baseResolved.ok) {
    return { ok: false, set, diagnostics: [baseResolved.diagnostic] };
  }
  const baseRepoPath = baseResolved.path;

  const parentInput = resolveDefaultParent(baseRepoPath, input.worktreeParentRoot);
  const parentResolved = resolveRoot(parentInput, "worktreeParentRoot");
  if (!parentResolved.ok) {
    return { ok: false, set, diagnostics: [parentResolved.diagnostic] };
  }
  const worktreeParentRoot = parentResolved.path;

  const existing = getActiveWorktreeForLease(set, lease.leaseId);
  if (!existing.ok) {
    return { ok: false, set, diagnostics: existing.diagnostics };
  }

  if (existing.worktree !== undefined) {
    // Stuck preparing: recover by releasing the registry row and recreating.
    // Disk cleanup runs only when the path is inside the controlled parent.
    if (existing.worktree.status === "preparing") {
      const staleRelease = releaseWorktreeRecord(set, existing.worktree.worktreeId);
      if (!staleRelease.ok) {
        return { ok: false, set, diagnostics: staleRelease.diagnostics };
      }
      await safeCleanupIfInsideParent(
        baseRepoPath,
        worktreeParentRoot,
        existing.worktree.path,
        existing.worktree.branchName,
        input.signal,
      );
      return prepareMutatingAttemptWorktree({
        ...input,
        set: staleRelease.set,
      });
    }

    if (existing.worktree.status === "ready") {
      const existingPath = existing.worktree.path;
      const inside = await isPathInsideParentCanonical(
        worktreeParentRoot,
        existingPath,
        { requireExisting: false },
      );
      if (!inside) {
        // Fail closed on escape. Do not recreate from a corrupted path claim.
        return {
          ok: false,
          set,
          diagnostics: [reject(
            "workspace_worktree_path_escape",
            "Existing worktree path escapes the configured parent root.",
            "worktree.path",
          )],
        };
      }
      const stillThere = await worktreeStillPresent(baseRepoPath, existingPath, input.signal);
      if (input.signal?.aborted) {
        return {
          ok: false,
          set,
          diagnostics: [reject(
            "workspace_worktree_aborted",
            "The worktree operation was cancelled.",
            "signal",
          )],
        };
      }
      if (stillThere) {
        // Re-check realpath containment for existing checkouts (symlink escape).
        const stillInside = await isPathInsideParentCanonical(
          worktreeParentRoot,
          existingPath,
          { requireExisting: true },
        );
        if (!stillInside) {
          return {
            ok: false,
            set,
            diagnostics: [reject(
              "workspace_worktree_path_escape",
              "Existing worktree path escapes the configured parent root after realpath.",
              "worktree.path",
            )],
          };
        }
        return {
          ok: true,
          set,
          worktree: existing.worktree,
        };
      }
      // Stale registry entry: release record, clean branch if any, recreate.
      const staleRelease = releaseWorktreeRecord(set, existing.worktree.worktreeId);
      if (!staleRelease.ok) {
        return { ok: false, set, diagnostics: staleRelease.diagnostics };
      }
      await deleteIsolationBranch(
        baseRepoPath,
        existing.worktree.branchName,
        input.signal,
      );
      return prepareMutatingAttemptWorktree({
        ...input,
        set: staleRelease.set,
      });
    }

    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_duplicate_active_lease",
        `Lease id '${lease.leaseId}' already has active worktree '${existing.worktree.worktreeId}' with status '${existing.worktree.status}'.`,
        "lease.leaseId",
      )],
    };
  }

  const directoryName = deriveWorktreeDirectoryName(lease.leaseId);
  if (directoryName === undefined) {
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_invalid_lease_id",
        "leaseId could not produce a safe worktree directory name.",
        "lease.leaseId",
      )],
    };
  }

  const worktreePath = resolve(worktreeParentRoot, directoryName);
  if (!isPathInsideParent(worktreeParentRoot, worktreePath)) {
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_path_escape",
        "Computed worktree path escapes the configured parent root.",
        "worktree.path",
      )],
    };
  }

  if (worktreePath.includes(`${sep}..${sep}`) || worktreePath.endsWith(`${sep}..`)) {
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_path_escape",
        "Worktree path must not contain parent-segment traversal.",
        "worktree.path",
      )],
    };
  }

  const repoCheck = await assertGitRepository(baseRepoPath, input.signal);
  if (!repoCheck.ok) {
    return { ok: false, set, diagnostics: repoCheck.diagnostics };
  }

  const revision = await resolveBaseRevision(baseRepoPath, lease.baseRevision, input.signal);
  if (!revision.ok) {
    return { ok: false, set, diagnostics: revision.diagnostics };
  }

  if (input.signal?.aborted) {
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_aborted",
        "The worktree operation was cancelled.",
        "signal",
      )],
    };
  }

  try {
    await mkdir(worktreeParentRoot, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_prepare_failed",
        `Could not create worktree parent directory: ${message}`,
        "worktreeParentRoot",
      )],
    };
  }

  if (await pathExists(worktreePath)) {
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_prepare_failed",
        `Worktree path already exists: ${worktreePath}`,
        "worktree.path",
      )],
    };
  }

  const worktreeId = input.worktreeId !== undefined
    ? input.worktreeId.trim()
    : deriveWorktreeId(lease.leaseId);
  const branchName = input.branchName !== undefined
    ? input.branchName.trim()
    : deriveWorktreeBranchName(lease.leaseId);

  if (worktreeId.length === 0) {
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_invalid_id",
        "worktreeId must be a non-empty string.",
        "worktree.worktreeId",
      )],
    };
  }
  if (branchName === undefined || branchName.length === 0) {
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_invalid_branch",
        "branchName must be a non-empty string.",
        "worktree.branchName",
      )],
    };
  }

  const addResult = await runGit(
    baseRepoPath,
    ["worktree", "add", "-b", branchName, worktreePath, revision.revision],
    input.signal,
  );

  if (!addResult.ok) {
    // Add may have created a branch or partial path; always roll back both.
    await rollbackPreparedWorktree(baseRepoPath, worktreePath, branchName, input.signal);
    if (addResult.aborted) {
      return {
        ok: false,
        set,
        diagnostics: [reject(
          "workspace_worktree_aborted",
          "The worktree operation was cancelled.",
          "signal",
        )],
      };
    }
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_git_failed",
        `git worktree add failed: ${addResult.message}`,
        "worktree.path",
      )],
    };
  }

  // Confirm the path is a directory after add and stays inside the parent.
  try {
    const info = await stat(worktreePath);
    if (!info.isDirectory()) {
      await rollbackPreparedWorktree(baseRepoPath, worktreePath, branchName, input.signal);
      return {
        ok: false,
        set,
        diagnostics: [reject(
          "workspace_worktree_prepare_failed",
          "Worktree path is not a directory after git worktree add.",
          "worktree.path",
        )],
      };
    }
  } catch (error) {
    await rollbackPreparedWorktree(baseRepoPath, worktreePath, branchName, input.signal);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_prepare_failed",
        `Worktree path missing after git worktree add: ${message}`,
        "worktree.path",
      )],
    };
  }

  const postCreateInside = await isPathInsideParentCanonical(
    worktreeParentRoot,
    worktreePath,
    { requireExisting: true },
  );
  if (!postCreateInside) {
    await rollbackPreparedWorktree(baseRepoPath, worktreePath, branchName, input.signal);
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_path_escape",
        "Worktree path escapes the configured parent root after create.",
        "worktree.path",
      )],
    };
  }

  if (input.signal?.aborted) {
    await rollbackPreparedWorktree(baseRepoPath, worktreePath, branchName, undefined);
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_aborted",
        "The worktree operation was cancelled.",
        "signal",
      )],
    };
  }

  const proposed = proposeReadyWorktree({
    lease,
    path: worktreePath,
    baseRevision: revision.revision,
    worktreeId,
    branchName,
    parentRoot: worktreeParentRoot,
  });
  if (!proposed.ok) {
    await rollbackPreparedWorktree(baseRepoPath, worktreePath, branchName, input.signal);
    return { ok: false, set, diagnostics: proposed.diagnostics };
  }

  const registered = registerWorktree(set, proposed.value);
  if (!registered.ok) {
    await rollbackPreparedWorktree(baseRepoPath, worktreePath, branchName, input.signal);
    return { ok: false, set, diagnostics: registered.diagnostics };
  }

  return {
    ok: true,
    set: registered.set,
    worktree: registered.worktree,
  };
}

/**
 * Remove a git worktree and mark the registry record as released.
 * Refuses paths outside the controlled parent after realpath containment.
 * Deletes the isolation branch when recorded. Does not mutate the input set.
 */
export async function releaseAttemptWorktree(
  input: ReleaseAttemptWorktreeInput,
): Promise<ReleaseAttemptWorktreeResult> {
  const set = input.set;

  if (input.signal?.aborted) {
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_aborted",
        "The worktree operation was cancelled.",
        "signal",
      )],
    };
  }

  const baseResolved = resolveRoot(input.baseRepoPath, "baseRepoPath");
  if (!baseResolved.ok) {
    return { ok: false, set, diagnostics: [baseResolved.diagnostic] };
  }
  const baseRepoPath = baseResolved.path;

  let worktreeId = input.worktreeId?.trim();
  let worktreePath: string | undefined;
  let target: WorkspaceWorktree | undefined;

  if (worktreeId !== undefined && worktreeId.length > 0) {
    const found = set.worktrees.find((item) => item.worktreeId === worktreeId);
    if (found) {
      target = found;
      worktreePath = found.path;
    }
  } else if (input.leaseId !== undefined && input.leaseId.trim().length > 0) {
    const active = getActiveWorktreeForLease(set, input.leaseId);
    if (!active.ok) {
      return { ok: false, set, diagnostics: active.diagnostics };
    }
    if (active.worktree) {
      target = active.worktree;
      worktreeId = active.worktree.worktreeId;
      worktreePath = active.worktree.path;
    }
  } else {
    return {
      ok: false,
      set,
      diagnostics: [reject(
        "workspace_worktree_release_id_required",
        "releaseAttemptWorktree requires worktreeId or leaseId.",
        "worktreeId",
      )],
    };
  }

  if (target === undefined || worktreeId === undefined) {
    return {
      ok: true,
      set,
      released: false,
    };
  }

  const parentRoot = resolveDefaultParent(
    baseRepoPath,
    input.worktreeParentRoot ?? target.parentRoot,
  );

  if (worktreePath !== undefined && worktreePath.trim().length > 0) {
    const inside = await isPathInsideParentCanonical(parentRoot, worktreePath, {
      requireExisting: false,
    });
    if (!inside) {
      return {
        ok: false,
        set,
        diagnostics: [reject(
          "workspace_worktree_path_escape",
          "Release refused: worktree path escapes the controlled parent root.",
          "worktree.path",
        )],
      };
    }

    // When the path exists, require realpath containment before remove.
    if (await pathExists(worktreePath)) {
      const stillInside = await isPathInsideParentCanonical(parentRoot, worktreePath, {
        requireExisting: true,
      });
      if (!stillInside) {
        return {
          ok: false,
          set,
          diagnostics: [reject(
            "workspace_worktree_path_escape",
            "Release refused: worktree path escapes the controlled parent root after realpath.",
            "worktree.path",
          )],
        };
      }
    }

    const removed = await removeGitWorktree(baseRepoPath, worktreePath, input.signal);
    if (!removed.ok) {
      if (removed.aborted) {
        return {
          ok: false,
          set,
          diagnostics: [reject(
            "workspace_worktree_aborted",
            "The worktree operation was cancelled.",
            "signal",
          )],
        };
      }
      // Do not mark the registry released while the path or git metadata remains.
      return {
        ok: false,
        set,
        diagnostics: [reject(
          "workspace_worktree_remove_failed",
          `Failed to remove worktree path: ${removed.message}`,
          "worktree.path",
        )],
      };
    }
    await deleteIsolationBranch(baseRepoPath, target.branchName, input.signal);
  }

  const released = releaseWorktreeRecord(set, worktreeId);
  if (!released.ok) {
    return { ok: false, set, diagnostics: released.diagnostics };
  }
  return {
    ok: true,
    set: released.set,
    released: released.released,
  };
}

/**
 * Release every active worktree for a lease id (registry + git).
 */
export async function releaseAttemptWorktreeByLease(
  input: {
    baseRepoPath: string;
    set: WorkspaceWorktreeSet;
    leaseId: string;
    worktreeParentRoot?: string;
    signal?: AbortSignal;
  },
): Promise<ReleaseAttemptWorktreeResult> {
  const payload: ReleaseAttemptWorktreeInput = {
    baseRepoPath: input.baseRepoPath,
    set: input.set,
    leaseId: input.leaseId,
  };
  if (input.worktreeParentRoot !== undefined) {
    payload.worktreeParentRoot = input.worktreeParentRoot;
  }
  if (input.signal !== undefined) {
    payload.signal = input.signal;
  }
  return releaseAttemptWorktree(payload);
}

// Re-export pure helpers that hosts commonly need together.
export {
  createEmptyWorkspaceWorktreeSet,
  getActiveWorktreeForLease,
  listActiveWorktrees,
  listWorktrees,
  getWorktree,
  releaseWorktreeRecord,
  releaseWorktreeRecordByLease,
} from "../domain/workspace-worktree.js";
