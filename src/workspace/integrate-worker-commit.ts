/**
 * Host integration of a validated worker commit into the base workspace (M8-s5).
 *
 * Flow:
 * 1. Validate exclusive lease, clean commit, ready worktree (cross-entity checks).
 * 2. Resolve the base repository and run cheap checks (repo, dirty tree,
 *    reachable commits, current HEAD) before any durable integrating transition.
 * 3. Register or reuse an integration record. Failed rows are supersedable.
 * 4. Mark integrating with baseHeadBeforeIntegrate, then optional persist.
 * 5. When already integrating, reconcile with current-state evidence only
 *    (worker tree equals HEAD, or HEAD equals the worker commit). Historical
 *    patch-id matches are not enough. If the change is absent, resume
 *    cherry-pick.
 * 6. Enforce the single-commit range contract: worker commitHash must have
 *    baseRevision as its sole parent. Multi-commit worker ranges are rejected.
 *    This slice integrates exactly one commit (not a commit range).
 * 7. Cherry-pick the worker commit (no force, no -X theirs).
 * 8. On success, require HEAD advance and proof of lineage or tree equality.
 * 9. On empty or already-applied, abort owned incomplete state first. Only after
 *    successful cleanup, use tree equality (then unbounded patch-id recovery).
 *    Failed cleanup returns failed with recovery diagnostics, not integrated.
 *    Otherwise already_applied failed (not conflicted).
 * 10. On textual conflict, classify without the caller signal so a late cancel
 *    cannot hide conflict. Abort owned incomplete state, confirm recovery, mark
 *    conflicted with paths (or conflict_paths_unavailable when paths cannot
 *    be listed). Proven CHERRY_PICK_HEAD ownership with a path-list failure
 *    still records conflicted with pathsUnavailable.
 * 11. When cherry-pick returns aborted, inspect conflict evidence without the
 *    caller signal before cleanup. Owned conflict is recorded as conflicted,
 *    not failed that hides the conflict.
 *
 * Base HEAD may have moved relative to worker baseRevision. Only textual
 * cherry-pick conflicts are detected here. Semantic conflicts are deferred to
 * post-integration checks (m8-s6).
 *
 * This module may call git and the filesystem. It never mutates canonical
 * graph or family state.
 *
 * Execution success and integration success remain separate states.
 */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { Diagnostic } from "../domain/model.js";
import {
  createEmptyWorkspaceIntegrationSet,
  getIntegration,
  markIntegrationConflicted,
  markIntegrationFailed,
  markIntegrationIntegrated,
  markIntegrationIntegrating,
  parseIntegrationPreconditions,
  registerPendingIntegration,
  type WorkspaceIntegration,
  type WorkspaceIntegrationSet,
} from "../domain/workspace-integration.js";
import type { WorkerCommitResult } from "../domain/workspace-commit.js";
import type { WorkspaceLease } from "../domain/workspace-lease.js";
import type { WorkspaceWorktree } from "../domain/workspace-worktree.js";
import {
  decodeGitTextLine,
  decodeGitUtf8,
  detectActiveGitOperation,
  runGit,
  type GitRunResult,
} from "./worker-commit.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTEGRATION_UTF8_CODE = "workspace_integration_invalid_utf8";

/** Deterministic identity and locale for commit-creating git operations. */
const GIT_WRITE_ENV: NodeJS.ProcessEnv = {
  LC_ALL: "C",
  LANG: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Hypagraph Integration",
  GIT_AUTHOR_EMAIL: "hypagraph-integration@example.invalid",
  GIT_COMMITTER_NAME: "Hypagraph Integration",
  GIT_COMMITTER_EMAIL: "hypagraph-integration@example.invalid",
};

const CHERRY_PICK_ARGS = [
  "-c",
  "user.name=Hypagraph Integration",
  "-c",
  "user.email=hypagraph-integration@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "cherry-pick",
  "--no-gpg-sign",
] as const;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type IntegrateWorkerCommitResult =
  | {
    ok: true;
    set: WorkspaceIntegrationSet;
    integration: WorkspaceIntegration;
    /** New base HEAD when status is integrated. */
    integratedCommitHash?: string;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
    set: WorkspaceIntegrationSet;
    integration?: WorkspaceIntegration;
  };

export interface IntegrateWorkerCommitInput {
  /** Absolute or relative path to the base git repository. */
  baseRepoPath: string;
  /**
   * Validated worker commit result (clean exclusive attempt).
   * May be untrusted; preconditions re-validate.
   */
  commit: WorkerCommitResult | unknown;
  /** Exclusive lease for the attempt. */
  lease: WorkspaceLease | unknown;
  /** Ready worktree for the attempt. */
  worktree: WorkspaceWorktree | unknown;
  /** Current pure integration registry. Not mutated. */
  set: WorkspaceIntegrationSet;
  /**
   * Optional existing integration id.
   * When present and found, reuses that record.
   * When omitted, registers a new pending integration first.
   */
  integrationId?: string;
  /**
   * Optional durable-intent hook. Awaited after the set transitions to
   * integrating and before any base repository mutation.
   */
  persist?: (set: WorkspaceIntegrationSet) => Promise<void> | void;
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

function mapGitFailure(
  failure: Extract<GitRunResult, { ok: false }>,
  location: string,
  detail: string,
): Diagnostic {
  if (failure.kind === "aborted") {
    return reject(
      "workspace_integration_aborted",
      "The integration operation was cancelled.",
      "signal",
    );
  }
  if (failure.kind === "output_limit") {
    return reject(
      "workspace_integration_git_output_limit",
      failure.message,
      location,
    );
  }
  if (failure.kind === "process") {
    return reject(
      "workspace_integration_git_process",
      `${detail}: ${failure.message}`,
      location,
    );
  }
  return reject(
    "workspace_integration_git_failed",
    `${detail}: ${failure.message}`,
    location,
  );
}

/**
 * Rewrite workspace_commit_* diagnostics into the integration namespace.
 */
function wrapAsIntegrationDiagnostics(
  diagnostics: readonly Diagnostic[],
  leadCode: string,
  leadMessage: string,
  location: string,
): Diagnostic[] {
  return [
    reject(leadCode, leadMessage, location),
    ...diagnostics.map((item) => {
      if (item.code.startsWith("workspace_integration_")) {
        return { ...item };
      }
      return {
        code: "workspace_integration_git_failed",
        message: `${item.code}: ${item.message}`,
        ...(item.location !== undefined ? { location: item.location } : { location }),
      };
    }),
  ];
}

function decodeIntegrationTextLine(
  raw: Buffer,
  location: string,
  emptyCode: string,
  emptyMessage: string,
): { ok: true; text: string } | { ok: false; diagnostic: Diagnostic } {
  return decodeGitTextLine(
    raw,
    location,
    emptyCode,
    emptyMessage,
    INTEGRATION_UTF8_CODE,
  );
}

function resolveBaseRepoPath(
  pathValue: string,
): { ok: true; path: string } | { ok: false; diagnostic: Diagnostic } {
  if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
    return {
      ok: false,
      diagnostic: reject(
        "workspace_integration_invalid_base_path",
        "baseRepoPath must be a non-empty path.",
        "baseRepoPath",
      ),
    };
  }
  try {
    return { ok: true, path: resolve(pathValue) };
  } catch {
    return {
      ok: false,
      diagnostic: reject(
        "workspace_integration_invalid_base_path",
        "baseRepoPath could not be resolved.",
        "baseRepoPath",
      ),
    };
  }
}

/**
 * Parse unmerged path names from `git ls-files -z --unmerged` output.
 * Format per entry: mode SP object SP stage TAB path NUL.
 */
export function parseUnmergedPathsZ(stdout: string): string[] {
  if (stdout.length === 0) return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const token of stdout.split("\0")) {
    if (token.length === 0) continue;
    const tab = token.indexOf("\t");
    const pathValue = tab >= 0 ? token.slice(tab + 1) : token;
    if (pathValue.length === 0) continue;
    if (seen.has(pathValue)) continue;
    seen.add(pathValue);
    paths.push(pathValue);
  }
  paths.sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  return paths;
}

/**
 * Parse unmerged paths from a raw buffer with strict UTF-8 validation.
 */
export function parseUnmergedPathsZRaw(
  raw: Buffer,
): { ok: true; paths: string[] } | { ok: false; diagnostic: Diagnostic } {
  const decoded = decodeGitUtf8(raw, "conflict.conflictingPaths", INTEGRATION_UTF8_CODE);
  if (!decoded.ok) return decoded;
  return { ok: true, paths: parseUnmergedPathsZ(decoded.text) };
}

async function readHeadCommit(
  baseCwd: string,
  signal?: AbortSignal,
): Promise<{ ok: true; hash: string } | { ok: false; diagnostics: Diagnostic[] }> {
  const headResult = await runGit(
    baseCwd,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    signal,
  );
  if (!headResult.ok) {
    return {
      ok: false,
      diagnostics: [mapGitFailure(headResult, "baseRepoPath", "Could not resolve base HEAD")],
    };
  }
  const decoded = decodeIntegrationTextLine(
    headResult.raw,
    "baseRepoPath",
    "workspace_integration_git_head_failed",
    "Resolved base HEAD was empty.",
  );
  if (!decoded.ok) {
    return { ok: false, diagnostics: [decoded.diagnostic] };
  }
  return { ok: true, hash: decoded.text.toLowerCase() };
}

async function collectConflictPaths(
  baseCwd: string,
  signal?: AbortSignal,
): Promise<{ ok: true; paths: string[] } | { ok: false; diagnostics: Diagnostic[] }> {
  const unmerged = await runGit(baseCwd, ["ls-files", "-z", "--unmerged"], signal);
  if (!unmerged.ok) {
    return {
      ok: false,
      diagnostics: [mapGitFailure(
        unmerged,
        "conflict.conflictingPaths",
        "Could not list unmerged paths after integrate conflict",
      )],
    };
  }
  const parsed = parseUnmergedPathsZRaw(unmerged.raw);
  if (!parsed.ok) {
    return { ok: false, diagnostics: [parsed.diagnostic] };
  }
  return { ok: true, paths: parsed.paths };
}

async function detectActiveIntegrationOperation(
  baseCwd: string,
  signal?: AbortSignal,
): Promise<{ ok: true; active: boolean } | { ok: false; diagnostics: Diagnostic[] }> {
  const active = await detectActiveGitOperation(baseCwd, signal);
  if (!active.ok) {
    return {
      ok: false,
      diagnostics: wrapAsIntegrationDiagnostics(
        active.diagnostics,
        "workspace_integration_git_failed",
        "Could not inspect incomplete git operations in the base repository.",
        "baseRepoPath",
      ),
    };
  }
  return { ok: true, active: active.active };
}

/**
 * Abort incomplete cherry-pick or merge. Returns diagnostics when cleanup fails.
 */
async function abortIncompleteIntegrate(
  baseCwd: string,
  expectedHead: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; diagnostics: Diagnostic[] }> {
  await runGit(baseCwd, ["cherry-pick", "--abort"], signal);
  await runGit(baseCwd, ["merge", "--abort"], signal);

  const headAfter = await readHeadCommit(baseCwd, signal);
  if (!headAfter.ok) {
    return {
      ok: false,
      diagnostics: [
        reject(
          "workspace_integration_abort_failed",
          "Could not confirm base HEAD after abort of incomplete integrate.",
          "baseRepoPath",
        ),
        ...headAfter.diagnostics,
      ],
    };
  }

  if (headAfter.hash !== expectedHead) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_abort_failed",
        `Abort did not restore base HEAD. Expected '${expectedHead}', found '${headAfter.hash}'. Manual cleanup is required.`,
        "baseRepoPath",
      )],
    };
  }

  const unmerged = await collectConflictPaths(baseCwd, signal);
  if (!unmerged.ok) {
    return {
      ok: false,
      diagnostics: [
        reject(
          "workspace_integration_abort_failed",
          "Could not confirm unmerged paths were cleared after abort.",
          "baseRepoPath",
        ),
        ...unmerged.diagnostics,
      ],
    };
  }
  if (unmerged.paths.length > 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_abort_failed",
        `Abort left unmerged paths: ${unmerged.paths.join(", ")}. Manual cleanup is required.`,
        "baseRepoPath",
      )],
    };
  }

  const active = await detectActiveIntegrationOperation(baseCwd, signal);
  if (!active.ok) {
    return {
      ok: false,
      diagnostics: [
        reject(
          "workspace_integration_abort_failed",
          "Could not confirm incomplete git operations were cleared after abort.",
          "baseRepoPath",
        ),
        ...active.diagnostics,
      ],
    };
  }
  if (active.active) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_abort_failed",
        "Abort left an incomplete git operation active. Manual cleanup is required.",
        "baseRepoPath",
      )],
    };
  }

  return { ok: true };
}

function looksLikeConflictFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("conflict")
    || lower.includes("could not apply")
    || lower.includes("after resolving the conflicts")
    || lower.includes("fix conflict")
    || lower.includes("merge conflict")
  );
}

/**
 * Match git cherry-pick empty / already-applied messages only.
 * Do not match git am / apply failure wording.
 */
function looksLikeEmptyOrAlreadyApplied(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("the previous cherry-pick is now empty")
    || lower.includes("nothing to commit")
    || lower.includes("empty commit")
    || lower.includes("--allow-empty")
  );
}

/**
 * Report whether two commits have the same tree.
 * Exit 0 means equal. Exit 1 means different. Other exits are errors.
 */
async function commitTreesEqual(
  baseCwd: string,
  left: string,
  right: string,
  signal?: AbortSignal,
): Promise<{ ok: true; equal: boolean } | { ok: false; diagnostics: Diagnostic[] }> {
  const result = await runGit(
    baseCwd,
    ["diff", "--quiet", left, right],
    signal,
  );
  if (result.ok) {
    return { ok: true, equal: true };
  }
  if (result.kind === "exit" && result.exitCode === 1) {
    return { ok: true, equal: false };
  }
  return {
    ok: false,
    diagnostics: [mapGitFailure(
      result,
      "baseRepoPath",
      "Could not compare commit trees",
    )],
  };
}

/**
 * Report whether ancestor is an ancestor of descendant.
 * Exit code 1 means not an ancestor. Other non-zero exits are errors.
 */
async function isAncestor(
  baseCwd: string,
  ancestor: string,
  descendant: string,
  signal?: AbortSignal,
): Promise<{ ok: true; isAncestor: boolean } | { ok: false; diagnostics: Diagnostic[] }> {
  const result = await runGit(
    baseCwd,
    ["merge-base", "--is-ancestor", ancestor, descendant],
    signal,
  );
  if (result.ok) {
    return { ok: true, isAncestor: true };
  }
  if (result.kind === "exit" && result.exitCode === 1) {
    return { ok: true, isAncestor: false };
  }
  return {
    ok: false,
    diagnostics: [mapGitFailure(
      result,
      "baseRepoPath",
      "Could not test commit ancestry",
    )],
  };
}

/**
 * Enforce the single-commit integrate contract.
 * Worker commitHash must have baseRevision as its sole parent.
 * Multi-commit ranges and merge commits are rejected (out of scope for this slice).
 */
async function assertWorkerCommitIsDirectChildOfBase(
  baseCwd: string,
  workerCommitHash: string,
  baseRevision: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; diagnostics: Diagnostic[] }> {
  const result = await runGit(
    baseCwd,
    ["rev-list", "--parents", "-n", "1", workerCommitHash],
    signal,
  );
  if (!result.ok) {
    return {
      ok: false,
      diagnostics: [mapGitFailure(
        result,
        "commit.commitHash",
        "Could not read parents of the worker commit",
      )],
    };
  }
  const decoded = decodeIntegrationTextLine(
    result.raw,
    "commit.commitHash",
    "workspace_integration_git_failed",
    "Worker commit parent list was empty.",
  );
  if (!decoded.ok) {
    return { ok: false, diagnostics: [decoded.diagnostic] };
  }
  // Format: "<commit> [<parent>...]"
  const tokens = decoded.text
    .split(/\s+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (tokens.length === 0) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_git_failed",
        "Worker commit parent list was empty.",
        "commit.commitHash",
      )],
    };
  }
  const parents = tokens.slice(1);
  const base = baseRevision.toLowerCase();
  if (parents.length !== 1 || parents[0] !== base) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_worker_commit_not_direct_child",
        "Worker commitHash must have baseRevision as its sole parent. "
          + "This integrate path applies exactly one commit. "
          + "Multi-commit worker ranges are not supported.",
        "commit.commitHash",
      )],
    };
  }
  return { ok: true };
}

/**
 * Stable patch-id for one commit (first token of git patch-id --stable).
 * Empty output (merge commits, empty trees) yields patchId undefined (non-match).
 * When requireNonEmpty is true, empty is a hard error (worker commit must have a patch).
 */
async function getCommitPatchId(
  baseCwd: string,
  commitHash: string,
  signal: AbortSignal | undefined,
  requireNonEmpty: boolean,
): Promise<
  | { ok: true; patchId: string | undefined }
  | { ok: false; diagnostics: Diagnostic[] }
> {
  const show = await runGit(
    baseCwd,
    ["show", commitHash, "--pretty=format:", "--binary"],
    signal,
  );
  if (!show.ok) {
    return {
      ok: false,
      diagnostics: [mapGitFailure(show, "commit.commitHash", "Could not show commit for patch-id")],
    };
  }
  const pid = await runGit(
    baseCwd,
    ["patch-id", "--stable"],
    signal,
    { stdin: show.raw },
  );
  if (!pid.ok) {
    return {
      ok: false,
      diagnostics: [mapGitFailure(pid, "commit.commitHash", "Could not compute patch-id")],
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(pid.raw).trim();
  } catch {
    return {
      ok: false,
      diagnostics: [reject(
        INTEGRATION_UTF8_CODE,
        "Git patch-id output contains invalid UTF-8 bytes.",
        "commit.commitHash",
      )],
    };
  }
  const patchId = text.split(/\s+/)[0] ?? "";
  if (patchId.length === 0) {
    if (requireNonEmpty) {
      return {
        ok: false,
        diagnostics: [reject(
          "workspace_integration_git_failed",
          "Worker commit patch-id was empty.",
          "commit.commitHash",
        )],
      };
    }
    // Merge commits and empty diffs are non-matches, not errors.
    return { ok: true, patchId: undefined };
  }
  return { ok: true, patchId };
}

/**
 * Report whether the worker patch already appears in rangeStart..rangeEnd.
 * Scans non-merge commits only. When maxCount is set, the walk is capped.
 * Overflow or list failure returns applied: false so the caller can use tree
 * equality or attempt cherry-pick again.
 */
async function workerPatchAppliedInRange(
  baseCwd: string,
  workerCommitHash: string,
  rangeStart: string,
  rangeEnd: string,
  signal?: AbortSignal,
  maxCount?: number,
): Promise<{ ok: true; applied: boolean } | { ok: false; diagnostics: Diagnostic[] }> {
  const workerPid = await getCommitPatchId(baseCwd, workerCommitHash, signal, true);
  if (!workerPid.ok) {
    return workerPid;
  }
  if (workerPid.patchId === undefined) {
    return { ok: true, applied: false };
  }

  if (rangeStart.toLowerCase() === rangeEnd.toLowerCase()) {
    return { ok: true, applied: false };
  }

  const revListArgs = [
    "rev-list",
    "--no-merges",
    ...(maxCount !== undefined ? [`--max-count=${maxCount}`] : []),
    `${rangeStart}..${rangeEnd}`,
  ];
  const list = await runGit(baseCwd, revListArgs, signal);
  if (!list.ok) {
    // Truncated or failed list: not applied by patch-id (caller may use tree equality).
    return { ok: true, applied: false };
  }
  const decoded = decodeGitUtf8(list.raw, "baseRepoPath", INTEGRATION_UTF8_CODE);
  if (!decoded.ok) {
    return { ok: true, applied: false };
  }
  const commits = decoded.text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0);

  // At max-count the range may be truncated; still scan what we have.
  for (const commit of commits) {
    const pid = await getCommitPatchId(baseCwd, commit, signal, false);
    if (!pid.ok) {
      // Skip unreadable commits; do not stick the reconcile.
      continue;
    }
    if (pid.patchId !== undefined && pid.patchId === workerPid.patchId) {
      return { ok: true, applied: true };
    }
  }
  return { ok: true, applied: false };
}

type ExpectedIdentity = {
  integrationId: string;
  leaseId: string;
  worktreeId: string;
  holder: WorkspaceLease["holder"];
  workerCommitHash: string;
  baseRevision: string;
};

async function markFailedAndReturn(
  set: WorkspaceIntegrationSet,
  integrationId: string,
  diagnostics: Diagnostic[],
  expectedIdentity: ExpectedIdentity,
  integration: WorkspaceIntegration | undefined,
): Promise<IntegrateWorkerCommitResult> {
  const failed = markIntegrationFailed(
    set,
    integrationId,
    diagnostics,
    diagnostics[0]?.message,
    expectedIdentity,
  );
  if (failed.ok) {
    return {
      ok: false,
      diagnostics,
      set: failed.set,
      integration: failed.integration,
    };
  }
  if (integration !== undefined) {
    return {
      ok: false,
      diagnostics,
      set,
      integration,
    };
  }
  return {
    ok: false,
    diagnostics,
    set,
  };
}

/**
 * After a successful cherry-pick that advanced HEAD, mark integrated only when
 * evidence shows the worker result is present (lineage from the pre-pick HEAD
 * or tree equality with the worker commit).
 */
async function completeAfterHeadAdvance(
  baseCwd: string,
  set: WorkspaceIntegrationSet,
  integrationId: string,
  headAfter: string,
  headBeforePick: string,
  workerCommitHash: string,
  expectedIdentity: ExpectedIdentity,
  integration: WorkspaceIntegration | undefined,
  signal?: AbortSignal,
): Promise<IntegrateWorkerCommitResult> {
  if (headAfter === headBeforePick) {
    return markFailedAndReturn(
      set,
      integrationId,
      [reject(
        "workspace_integration_no_change",
        "Cherry-pick completed but base HEAD did not advance. Integration did not change the base.",
        "baseRepoPath",
      )],
      expectedIdentity,
      integration,
    );
  }

  const observedDiag = reject(
    "workspace_integration_git_failed",
    `Observed base HEAD after cherry-pick is '${headAfter}'.`,
    "baseRepoPath",
  );

  // Lineage: first parent of HEAD must be the pre-pick HEAD for a normal cherry-pick.
  const parentResult = await runGit(
    baseCwd,
    ["rev-parse", "--verify", `${headAfter}^`],
    signal,
  );
  let lineageOk = false;
  if (parentResult.ok) {
    const parentDecoded = decodeIntegrationTextLine(
      parentResult.raw,
      "baseRepoPath",
      "workspace_integration_git_failed",
      "Could not resolve parent of new HEAD.",
    );
    if (parentDecoded.ok) {
      lineageOk = parentDecoded.text.toLowerCase() === headBeforePick.toLowerCase();
    }
  }

  const descendant = await isAncestor(baseCwd, headBeforePick, headAfter, signal);
  if (!descendant.ok) {
    return markFailedAndReturn(
      set,
      integrationId,
      [
        ...descendant.diagnostics,
        observedDiag,
        reject(
          "workspace_integration_git_failed",
          "Could not prove the new base HEAD descends from the pre-pick HEAD. Integration is not marked integrated.",
          "baseRepoPath",
        ),
      ],
      expectedIdentity,
      integration,
    );
  }

  const trees = await commitTreesEqual(
    baseCwd,
    workerCommitHash,
    headAfter,
    signal,
  );
  const treesEqual = trees.ok && trees.equal;

  // Accept when lineage is proven, or when the worker tree fully matches HEAD.
  const workerPresent = (
    (lineageOk && descendant.isAncestor)
    || treesEqual
  );
  if (!workerPresent) {
    return markFailedAndReturn(
      set,
      integrationId,
      [
        observedDiag,
        reject(
          "workspace_integration_git_failed",
          "Base HEAD advanced but the worker commit result is not present. Integration is not marked integrated.",
          "baseRepoPath",
        ),
        ...(trees.ok ? [] : trees.diagnostics),
      ],
      expectedIdentity,
      integration,
    );
  }

  const integrated = markIntegrationIntegrated(
    set,
    integrationId,
    headAfter,
    expectedIdentity,
  );
  if (!integrated.ok) {
    return {
      ok: false,
      diagnostics: [
        ...integrated.diagnostics,
        reject(
          "workspace_integration_mark_integrated_failed",
          `Base HEAD advanced to '${headAfter}' but the integration record could not be marked integrated.`,
          "integration",
        ),
      ],
      set,
      ...(integration !== undefined ? { integration } : {}),
    };
  }
  return {
    ok: true,
    set: integrated.set,
    integration: integrated.integration,
    integratedCommitHash: headAfter,
  };
}

/**
 * Report whether a rev-parse --verify failure means the ref is absent.
 * Missing ref is not an ownership diagnostic. Other exits are real failures.
 */
export function isMissingVerifyRefExit(
  failure: Extract<GitRunResult, { ok: false }>,
): boolean {
  if (failure.kind !== "exit") return false;
  const msg = failure.message.toLowerCase();
  if (
    msg.includes("needed a single revision")
    || msg.includes("unknown revision")
    || msg.includes("not a valid object name")
    || msg.includes("ambiguous argument")
  ) {
    return true;
  }
  // Some Git builds use exit 1 for missing --verify targets.
  if (failure.exitCode === 1) return true;
  return false;
}

/**
 * Report whether CHERRY_PICK_HEAD exists and equals the worker commit.
 * Always inspects with an uncancelled signal so cancellation cannot hide
 * an incomplete sequencer that this call must clean up.
 * Confirmed missing ref means owned: false.
 * Other exit, process, abort, and output-limit failures return diagnostics.
 */
export async function cherryPickHeadMatchesWorker(
  baseCwd: string,
  workerCommitHash: string,
): Promise<{ ok: true; owned: boolean } | { ok: false; diagnostics: Diagnostic[] }> {
  // Do not pass a cancelled AbortSignal. Post-cancel inspection must run.
  const result = await runGit(
    baseCwd,
    ["rev-parse", "--verify", "CHERRY_PICK_HEAD"],
    undefined,
  );
  if (!result.ok) {
    if (isMissingVerifyRefExit(result)) {
      return { ok: true, owned: false };
    }
    return {
      ok: false,
      diagnostics: [mapGitFailure(
        result,
        "baseRepoPath",
        "Could not inspect CHERRY_PICK_HEAD after integrate",
      )],
    };
  }
  const decoded = decodeIntegrationTextLine(
    result.raw,
    "baseRepoPath",
    "workspace_integration_git_failed",
    "CHERRY_PICK_HEAD was empty.",
  );
  if (!decoded.ok) {
    return { ok: false, diagnostics: [decoded.diagnostic] };
  }
  return {
    ok: true,
    owned: decoded.text.toLowerCase() === workerCommitHash.toLowerCase(),
  };
}

/**
 * Abort only when this call owns CHERRY_PICK_HEAD for the worker commit.
 * Ownership inspection and abort never use a cancelled signal.
 */
export async function abortOwnedCherryPick(
  baseCwd: string,
  workerCommitHash: string,
  abortExpectedHead: string,
  thisCallOwnedSequencer: boolean,
): Promise<{ ok: true; aborted: boolean } | { ok: false; diagnostics: Diagnostic[] }> {
  if (!thisCallOwnedSequencer) {
    return { ok: true, aborted: false };
  }
  const ownership = await cherryPickHeadMatchesWorker(baseCwd, workerCommitHash);
  if (!ownership.ok) {
    return { ok: false, diagnostics: ownership.diagnostics };
  }
  if (!ownership.owned) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_interrupted",
        "An incomplete git operation is present but does not match this worker commit. Hypagraph did not abort it.",
        "baseRepoPath",
      )],
    };
  }
  // Abort without a cancelled signal so cleanup can complete.
  const aborted = await abortIncompleteIntegrate(baseCwd, abortExpectedHead, undefined);
  if (!aborted.ok) {
    return { ok: false, diagnostics: aborted.diagnostics };
  }
  return { ok: true, aborted: true };
}

type ConflictInspectResult = {
  conflictPathsResult: Awaited<ReturnType<typeof collectConflictPaths>>;
  activeOp: Awaited<ReturnType<typeof detectActiveIntegrationOperation>>;
  incomplete: boolean;
  emptyPaths: boolean;
  hasPaths: boolean;
  pathInspectionFailed: boolean;
  ownedIncomplete: boolean;
};

/**
 * Inspect conflict and active-operation state without the caller signal.
 */
async function inspectConflictStateUncancelled(
  baseCwd: string,
  thisCallOwnedSequencer: boolean,
): Promise<ConflictInspectResult> {
  const conflictPathsResult = await collectConflictPaths(baseCwd, undefined);
  const activeOp = await detectActiveIntegrationOperation(baseCwd, undefined);
  const incomplete = activeOp.ok && activeOp.active;
  const emptyPaths = conflictPathsResult.ok && conflictPathsResult.paths.length === 0;
  const hasPaths = conflictPathsResult.ok && conflictPathsResult.paths.length > 0;
  const pathInspectionFailed = !conflictPathsResult.ok;
  const ownedIncomplete = incomplete && thisCallOwnedSequencer;
  return {
    conflictPathsResult,
    activeOp,
    incomplete,
    emptyPaths,
    hasPaths,
    pathInspectionFailed,
    ownedIncomplete,
  };
}

/**
 * Record conflicted after owned conflict evidence, with cleanup of owned sequencer.
 * Used by non-ok cherry-pick classification and by the aborted signal path.
 */
async function recordOwnedConflictResult(
  baseCwd: string,
  set: WorkspaceIntegrationSet,
  integrationId: string,
  workerCommitHash: string,
  abortExpectedHead: string,
  thisCallOwnedSequencer: boolean,
  expectedIdentity: ExpectedIdentity,
  integration: WorkspaceIntegration | undefined,
  inspect: ConflictInspectResult,
  cherryMessage: string,
): Promise<IntegrateWorkerCommitResult> {
  const pathDiagnostics: Diagnostic[] = [];
  let paths: string[] = [];
  let pathsUnavailable = false;
  if (inspect.conflictPathsResult.ok) {
    paths = inspect.conflictPathsResult.paths;
  } else if (thisCallOwnedSequencer || looksLikeConflictFailure(cherryMessage)) {
    pathsUnavailable = true;
    pathDiagnostics.push(...inspect.conflictPathsResult.diagnostics);
    pathDiagnostics.push(reject(
      "workspace_integration_conflict_paths_unavailable",
      "Integration conflicted but conflicting paths could not be listed.",
      "conflict.conflictingPaths",
    ));
  } else {
    const diags: Diagnostic[] = [...inspect.conflictPathsResult.diagnostics];
    const abortResult = await abortOwnedCherryPick(
      baseCwd,
      workerCommitHash,
      abortExpectedHead,
      thisCallOwnedSequencer,
    );
    if (!abortResult.ok) {
      diags.push(...abortResult.diagnostics);
    }
    return markFailedAndReturn(
      set,
      integrationId,
      diags,
      expectedIdentity,
      integration,
    );
  }
  if (!inspect.activeOp.ok) {
    pathDiagnostics.push(...inspect.activeOp.diagnostics);
  }

  if (paths.length === 0 && !pathsUnavailable) {
    const diags: Diagnostic[] = [reject(
      "workspace_integration_no_change",
      cherryMessage
        || "Integrate failed without unmerged paths. Treated as no change, not conflicted.",
      "baseRepoPath",
    )];
    const abortResult = await abortOwnedCherryPick(
      baseCwd,
      workerCommitHash,
      abortExpectedHead,
      thisCallOwnedSequencer,
    );
    if (!abortResult.ok) {
      diags.push(...abortResult.diagnostics);
    }
    return markFailedAndReturn(
      set,
      integrationId,
      diags,
      expectedIdentity,
      integration,
    );
  }

  const message = cherryMessage || "Worker commit integration produced a merge conflict.";
  const abortResult = await abortOwnedCherryPick(
    baseCwd,
    workerCommitHash,
    abortExpectedHead,
    thisCallOwnedSequencer,
  );
  if (!abortResult.ok) {
    pathDiagnostics.push(...abortResult.diagnostics);
  }

  const conflictMessage = pathDiagnostics.length > 0
    ? `${message} ${pathDiagnostics.map((d) => d.message).join(" ")}`
    : message;

  const conflicted = markIntegrationConflicted(
    set,
    integrationId,
    {
      conflictingPaths: paths,
      message: conflictMessage,
      ...(pathsUnavailable ? { pathsUnavailable: true } : {}),
    },
    expectedIdentity,
  );
  if (!conflicted.ok) {
    return {
      ok: false,
      diagnostics: [...conflicted.diagnostics, ...pathDiagnostics],
      set,
      ...(integration !== undefined ? { integration } : {}),
    };
  }

  const conflictDiag = reject(
    "workspace_integration_conflict",
    paths.length > 0
      ? `Integration conflicted on paths: ${paths.join(", ")}.`
      : `Integration conflicted: ${message}`,
    "integration.conflict",
  );

  return {
    ok: false,
    diagnostics: [conflictDiag, ...pathDiagnostics],
    set: conflicted.set,
    integration: conflicted.integration,
  };
}

/**
 * After cherry-pick returns aborted, inspect conflict without the caller signal.
 * Prefer conflicted over failed when this call owns conflict evidence.
 * Exported for deterministic tests of the abort-with-conflict path.
 */
export async function resolveAfterAbortedCherryPick(input: {
  baseCwd: string;
  workerCommitHash: string;
  abortExpectedHead: string;
  thisCallOwnedSequencer: boolean;
  set: WorkspaceIntegrationSet;
  integrationId: string;
  expectedIdentity: {
    integrationId: string;
    leaseId: string;
    worktreeId: string;
    holder: WorkspaceLease["holder"];
    workerCommitHash: string;
    baseRevision: string;
  };
  integration?: WorkspaceIntegration;
  cherryMessage?: string;
}): Promise<IntegrateWorkerCommitResult> {
  const inspect = await inspectConflictStateUncancelled(
    input.baseCwd,
    input.thisCallOwnedSequencer,
  );
  // Owned conflict evidence: unmerged paths, path-list failure with ownership,
  // or an incomplete sequencer this call owns (CHERRY_PICK_HEAD match).
  const ownedConflictEvidence = input.thisCallOwnedSequencer && (
    inspect.hasPaths
    || inspect.pathInspectionFailed
    || inspect.ownedIncomplete
  );
  if (ownedConflictEvidence) {
    const conflictMessage = inspect.hasPaths || inspect.pathInspectionFailed
      ? "Worker commit integration produced a merge conflict."
      : (input.cherryMessage || "Worker commit integration produced a merge conflict.");
    return recordOwnedConflictResult(
      input.baseCwd,
      input.set,
      input.integrationId,
      input.workerCommitHash,
      input.abortExpectedHead,
      input.thisCallOwnedSequencer,
      input.expectedIdentity,
      input.integration,
      inspect,
      conflictMessage,
    );
  }

  const abortDiags: Diagnostic[] = [reject(
    "workspace_integration_aborted",
    "The integration operation was cancelled.",
    "signal",
  )];
  const headAfterCancel = await readHeadCommit(input.baseCwd, undefined);
  if (headAfterCancel.ok && headAfterCancel.hash !== input.abortExpectedHead) {
    const completion = await completeAfterHeadAdvance(
      input.baseCwd,
      input.set,
      input.integrationId,
      headAfterCancel.hash,
      input.abortExpectedHead,
      input.workerCommitHash,
      input.expectedIdentity,
      input.integration,
      undefined,
    );
    if (completion.ok) {
      return completion;
    }
    const abortResult = await abortOwnedCherryPick(
      input.baseCwd,
      input.workerCommitHash,
      input.abortExpectedHead,
      input.thisCallOwnedSequencer,
    );
    const failDiags = [
      ...abortDiags,
      ...completion.diagnostics,
      reject(
        "workspace_integration_git_failed",
        `Base HEAD advanced to '${headAfterCancel.hash}' during cancelled cherry-pick but completion was not proved.`,
        "baseRepoPath",
      ),
    ];
    if (!abortResult.ok) {
      failDiags.push(...abortResult.diagnostics);
    }
    return markFailedAndReturn(
      input.set,
      input.integrationId,
      failDiags,
      input.expectedIdentity,
      input.integration,
    );
  }

  const abortResult = await abortOwnedCherryPick(
    input.baseCwd,
    input.workerCommitHash,
    input.abortExpectedHead,
    input.thisCallOwnedSequencer,
  );
  if (!abortResult.ok) {
    abortDiags.push(...abortResult.diagnostics);
  }
  return markFailedAndReturn(
    input.set,
    input.integrationId,
    abortDiags,
    input.expectedIdentity,
    input.integration,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Integrate a validated worker commit into the base repository.
 *
 * Does not mutate the input set. Early validation failures may return the
 * input set by reference. Transition paths return a new set.
 */
export async function integrateWorkerCommit(
  input: IntegrateWorkerCommitInput,
): Promise<IntegrateWorkerCommitResult> {
  let set: WorkspaceIntegrationSet = input.set ?? createEmptyWorkspaceIntegrationSet();

  if (input.signal?.aborted) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_aborted",
        "The integration operation was cancelled.",
        "signal",
      )],
      set,
    };
  }

  // ---- 1. Domain preconditions ----
  const preconditions = parseIntegrationPreconditions({
    commit: input.commit,
    lease: input.lease,
    worktree: input.worktree,
  });
  if (!preconditions.ok) {
    return {
      ok: false,
      diagnostics: preconditions.diagnostics,
      set,
    };
  }
  const { commit, lease, worktree } = preconditions.value;

  // ---- 2. Resolve base repo ----
  const baseResolved = resolveBaseRepoPath(input.baseRepoPath);
  if (!baseResolved.ok) {
    return { ok: false, diagnostics: [baseResolved.diagnostic], set };
  }

  let baseCwd: string;
  try {
    baseCwd = await realpath(baseResolved.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_base_path",
        `Hypagraph could not resolve the canonical base repository path: ${message}`,
        "baseRepoPath",
      )],
      set,
    };
  }

  const inside = await runGit(
    baseCwd,
    ["rev-parse", "--is-inside-work-tree"],
    input.signal,
  );
  if (!inside.ok) {
    return {
      ok: false,
      diagnostics: [mapGitFailure(inside, "baseRepoPath", "Base path is not a git repository")],
      set,
    };
  }
  const insideText = decodeIntegrationTextLine(
    inside.raw,
    "baseRepoPath",
    "workspace_integration_not_git_repo",
    "Base path is not a git work tree.",
  );
  if (!insideText.ok) {
    return { ok: false, diagnostics: [insideText.diagnostic], set };
  }
  if (insideText.text !== "true") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_not_git_repo",
        "Base path is not a git work tree.",
        "baseRepoPath",
      )],
      set,
    };
  }

  // Resolve Git top-level roots so a worktree subdirectory cannot be used as base.
  const baseTop = await runGit(baseCwd, ["rev-parse", "--show-toplevel"], input.signal);
  if (!baseTop.ok) {
    return {
      ok: false,
      diagnostics: [mapGitFailure(baseTop, "baseRepoPath", "Could not resolve base git top-level")],
      set,
    };
  }
  const baseTopDecoded = decodeIntegrationTextLine(
    baseTop.raw,
    "baseRepoPath",
    "workspace_integration_not_git_repo",
    "Base git top-level was empty.",
  );
  if (!baseTopDecoded.ok) {
    return { ok: false, diagnostics: [baseTopDecoded.diagnostic], set };
  }
  let baseRoot: string;
  try {
    baseRoot = await realpath(baseTopDecoded.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_invalid_base_path",
        `Hypagraph could not resolve the canonical base repository path: ${message}`,
        "baseRepoPath",
      )],
      set,
    };
  }
  baseCwd = baseRoot;

  try {
    const worktreeReal = await realpath(resolve(worktree.path));
    const worktreeTop = await runGit(
      worktreeReal,
      ["rev-parse", "--show-toplevel"],
      input.signal,
    );
    if (worktreeTop.ok) {
      const wtDecoded = decodeIntegrationTextLine(
        worktreeTop.raw,
        "worktree.path",
        "workspace_integration_base_is_worktree",
        "Worktree git top-level was empty.",
      );
      if (wtDecoded.ok) {
        let worktreeRoot: string;
        try {
          worktreeRoot = await realpath(wtDecoded.text);
        } catch {
          worktreeRoot = resolve(wtDecoded.text);
        }
        if (
          baseRoot === worktreeRoot
          || baseRoot.startsWith(`${worktreeRoot}/`)
          || baseRoot.startsWith(`${worktreeRoot}\\`)
        ) {
          return {
            ok: false,
            diagnostics: [reject(
              "workspace_integration_base_is_worktree",
              "Base repository path must not be the worker worktree root or a path inside the worker worktree.",
              "baseRepoPath",
            )],
            set,
          };
        }
      }
    } else if (worktreeReal === baseRoot || baseRoot.startsWith(`${worktreeReal}/`)) {
      return {
        ok: false,
        diagnostics: [reject(
          "workspace_integration_base_is_worktree",
          "Base repository path must not be the worker worktree root or a path inside the worker worktree.",
          "baseRepoPath",
        )],
        set,
      };
    }
  } catch {
    // Missing worktree path is acceptable when the commit object is shared.
  }

  // ---- 3. Cheap base checks before registration (do not consume the attempt) ----
  const earlyActiveCheap = await detectActiveIntegrationOperation(baseCwd, input.signal);
  if (!earlyActiveCheap.ok) {
    return {
      ok: false,
      diagnostics: earlyActiveCheap.diagnostics,
      set,
    };
  }

  const porcelain = await runGit(
    baseCwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=no"],
    input.signal,
  );
  if (!porcelain.ok) {
    return {
      ok: false,
      diagnostics: [mapGitFailure(
        porcelain,
        "baseRepoPath",
        "Could not read base worktree status",
      )],
      set,
    };
  }
  if (porcelain.raw.length > 0 && !earlyActiveCheap.active) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_base_dirty",
        "Base worktree has uncommitted tracked changes. Integration requires a clean base.",
        "baseRepoPath",
      )],
      set,
    };
  }

  const verifyBase = await runGit(
    baseCwd,
    ["rev-parse", "--verify", `${commit.baseRevision}^{commit}`],
    input.signal,
  );
  if (!verifyBase.ok) {
    return {
      ok: false,
      diagnostics: [mapGitFailure(
        verifyBase,
        "commit.baseRevision",
        "Worker baseRevision is not reachable from the base repository",
      )],
      set,
    };
  }

  const verifyWorker = await runGit(
    baseCwd,
    ["rev-parse", "--verify", `${commit.commitHash}^{commit}`],
    input.signal,
  );
  if (!verifyWorker.ok) {
    return {
      ok: false,
      diagnostics: [mapGitFailure(
        verifyWorker,
        "commit.commitHash",
        "Worker commit is not reachable from the base repository",
      )],
      set,
    };
  }

  // Single-commit contract: commitHash must be a direct child of baseRevision.
  const directChild = await assertWorkerCommitIsDirectChildOfBase(
    baseCwd,
    commit.commitHash,
    commit.baseRevision,
    input.signal,
  );
  if (!directChild.ok) {
    return {
      ok: false,
      diagnostics: directChild.diagnostics,
      set,
    };
  }

  const headSnapshot = await readHeadCommit(baseCwd, input.signal);
  if (!headSnapshot.ok) {
    return {
      ok: false,
      diagnostics: headSnapshot.diagnostics,
      set,
    };
  }
  const currentHead = headSnapshot.hash;

  // ---- 4. Resolve existing record, refuse active op, then register ----
  let resolvedIntegrationId = input.integrationId?.trim() ?? "";
  let integration: WorkspaceIntegration | undefined;
  // Keep the caller's set until registration succeeds.
  const originalSet = set;

  if (resolvedIntegrationId.length > 0) {
    const existing = getIntegration(set, resolvedIntegrationId);
    if (!existing.ok) {
      return { ok: false, diagnostics: existing.diagnostics, set: originalSet };
    }
    integration = existing.integration;
  }

  if (integration !== undefined && integration.status === "integrated") {
    const identityMismatch = (
      integration.leaseId !== lease.leaseId
      || integration.worktreeId !== worktree.worktreeId
      || integration.workerCommitHash !== commit.commitHash
      || integration.baseRevision !== commit.baseRevision
      || integration.holder.familyId !== lease.holder.familyId
      || integration.holder.goalId !== lease.holder.goalId
      || integration.holder.workflowId !== lease.holder.workflowId
      || integration.holder.revision !== lease.holder.revision
      || integration.holder.nodeId !== lease.holder.nodeId
      || integration.holder.attemptId !== lease.holder.attemptId
    );
    if (identityMismatch) {
      return {
        ok: false,
        diagnostics: [reject(
          "workspace_integration_stale_identity",
          "Existing integrated record identity does not match the current worker commit, lease, or worktree.",
          "integration",
        )],
        set: originalSet,
        integration,
      };
    }
    return {
      ok: true,
      set: originalSet,
      integration,
      ...(integration.integratedCommitHash !== undefined
        ? { integratedCommitHash: integration.integratedCommitHash }
        : {}),
    };
  }

  if (integration !== undefined && integration.status === "conflicted") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_already_conflicted",
        "Integration is already conflicted. Resolve the base conflict, then call pruneTerminalIntegrations, or use a new worker commit.",
        "integration.status",
      )],
      set: originalSet,
      integration,
    };
  }

  // Failed / aborted / released: supersede by re-registering (domain drops them).
  if (
    integration !== undefined
    && (integration.status === "failed"
      || integration.status === "aborted"
      || integration.status === "released")
  ) {
    integration = undefined;
  }

  const wasAlreadyIntegrating = integration?.status === "integrating";

  // Reject incomplete base operations before any registration mutates the set.
  if (earlyActiveCheap.active && !wasAlreadyIntegrating) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_integration_base_operation_in_progress",
        "Base repository has an incomplete git operation. Finish or abort it before integrate.",
        "baseRepoPath",
      )],
      set: originalSet,
    };
  }

  if (integration === undefined) {
    const registered = registerPendingIntegration(set, {
      commit,
      lease,
      worktree,
      ...(resolvedIntegrationId.length > 0
        ? { integrationId: resolvedIntegrationId }
        : {}),
    });
    if (!registered.ok) {
      return {
        ok: false,
        diagnostics: registered.diagnostics,
        set: originalSet,
      };
    }
    set = registered.set;
    integration = registered.integration;
    resolvedIntegrationId = integration.integrationId;
  } else {
    resolvedIntegrationId = integration.integrationId;
    if (
      integration.leaseId !== lease.leaseId
      || integration.worktreeId !== worktree.worktreeId
      || integration.workerCommitHash !== commit.commitHash
      || integration.baseRevision !== commit.baseRevision
    ) {
      return {
        ok: false,
        diagnostics: [reject(
          "workspace_integration_stale_identity",
          "Existing integration identity does not match the current worker commit, lease, or worktree.",
          "integration",
        )],
        set: originalSet,
        integration,
      };
    }
  }

  const expectedIdentity: ExpectedIdentity = {
    integrationId: resolvedIntegrationId,
    leaseId: lease.leaseId,
    worktreeId: worktree.worktreeId,
    holder: lease.holder,
    workerCommitHash: commit.commitHash,
    baseRevision: commit.baseRevision,
  };

  // Range start for reconcile. Never use current HEAD to fill a missing
  // baseHeadBeforeIntegrate (that collapses the range).
  const reconcileRangeStart = wasAlreadyIntegrating
    ? (integration?.baseHeadBeforeIntegrate ?? commit.baseRevision)
    : currentHead;

  // HEAD already equals the worker commit: integrate without cherry-pick.
  if (commit.commitHash === currentHead && !wasAlreadyIntegrating) {
    const integratingNoOp = markIntegrationIntegrating(
      set,
      resolvedIntegrationId,
      expectedIdentity,
      { baseHeadBeforeIntegrate: currentHead },
    );
    if (!integratingNoOp.ok) {
      return {
        ok: false,
        diagnostics: integratingNoOp.diagnostics,
        set,
        integration,
      };
    }
    set = integratingNoOp.set;
    const integrated = markIntegrationIntegrated(
      set,
      resolvedIntegrationId,
      currentHead,
      expectedIdentity,
    );
    if (!integrated.ok) {
      return {
        ok: false,
        diagnostics: integrated.diagnostics,
        set,
        integration: integratingNoOp.integration,
      };
    }
    return {
      ok: true,
      set: integrated.set,
      integration: integrated.integration,
      integratedCommitHash: currentHead,
    };
  }

  // ---- 5. Durable integrating with baseHeadBeforeIntegrate ----
  // Resume: preserve existing baseHeadBeforeIntegrate or fall back to baseRevision.
  // Fresh: store current HEAD before mutation.
  const integrating = markIntegrationIntegrating(
    set,
    resolvedIntegrationId,
    expectedIdentity,
    { baseHeadBeforeIntegrate: reconcileRangeStart },
  );
  if (!integrating.ok) {
    return {
      ok: false,
      diagnostics: integrating.diagnostics,
      set,
      integration,
    };
  }
  set = integrating.set;
  integration = integrating.integration;

  if (input.persist !== undefined) {
    try {
      await input.persist(set);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return markFailedAndReturn(
        set,
        resolvedIntegrationId,
        [reject(
          "workspace_integration_persist_failed",
          `Failed to persist integrating intent: ${message}`,
          "persist",
        )],
        expectedIdentity,
        integration,
      );
    }
  }

  if (input.signal?.aborted) {
    return markFailedAndReturn(
      set,
      resolvedIntegrationId,
      [reject(
        "workspace_integration_aborted",
        "The integration operation was cancelled.",
        "signal",
      )],
      expectedIdentity,
      integration,
    );
  }

  // Snapshot immediately before each cherry-pick for abort restore and advancement.
  let abortExpectedHead = currentHead;
  // True only when this call owns CHERRY_PICK_HEAD for the worker commit.
  let thisCallOwnedSequencer = false;

  // ---- 6. Reconcile interrupted integrate by current-state evidence only ----
  if (wasAlreadyIntegrating) {
    const headForRangeEnd = currentHead;
    const active = await detectActiveIntegrationOperation(baseCwd, input.signal);
    if (!active.ok) {
      // Mark failed so re-register can supersede. Do not leave integrating forever.
      return markFailedAndReturn(
        set,
        resolvedIntegrationId,
        [
          reject(
            "workspace_integration_interrupted",
            "Integration is integrating but incomplete git state could not be inspected. Retry after the base is clean.",
            "integration.status",
          ),
          ...active.diagnostics,
        ],
        expectedIdentity,
        integration,
      );
    }
    if (active.active) {
      // Do not abort foreign operations. Ownership is not proven on resume.
      return markFailedAndReturn(
        set,
        resolvedIntegrationId,
        [reject(
          "workspace_integration_interrupted",
          "Integration is integrating and the base has an incomplete git operation that this call did not start. Finish or abort that operation, then retry.",
          "integration.status",
        )],
        expectedIdentity,
        integration,
      );
    }

    // Current-state evidence only. A historical patch-id match is not enough:
    // a later revert would still show the original patch in the range.
    const trees = await commitTreesEqual(
      baseCwd,
      commit.commitHash,
      headForRangeEnd,
      input.signal,
    );
    if (!trees.ok) {
      return markFailedAndReturn(
        set,
        resolvedIntegrationId,
        [
          reject(
            "workspace_integration_interrupted",
            "Integration is integrating but current tree comparison failed. Retry with a clean base.",
            "integration.status",
          ),
          ...trees.diagnostics,
        ],
        expectedIdentity,
        integration,
      );
    }
    if (trees.equal || commit.commitHash === headForRangeEnd) {
      const integrated = markIntegrationIntegrated(
        set,
        resolvedIntegrationId,
        headForRangeEnd,
        expectedIdentity,
      );
      if (!integrated.ok) {
        return {
          ok: false,
          diagnostics: [
            ...integrated.diagnostics,
            reject(
              "workspace_integration_mark_integrated_failed",
              `Worker tree matches base HEAD '${headForRangeEnd}' but the record could not be marked integrated.`,
              "integration",
            ),
          ],
          set,
          integration,
        };
      }
      return {
        ok: true,
        set: integrated.set,
        integration: integrated.integration,
        integratedCommitHash: headForRangeEnd,
      };
    }
    // Not present at HEAD: fall through and resume cherry-pick (may re-apply).
  }

  // ---- 7. Cherry-pick worker commit ----
  // Refuse if another operation appeared after the early precheck.
  const prePickActive = await detectActiveIntegrationOperation(baseCwd, input.signal);
  if (!prePickActive.ok) {
    return markFailedAndReturn(
      set,
      resolvedIntegrationId,
      prePickActive.diagnostics,
      expectedIdentity,
      integration,
    );
  }
  if (prePickActive.active) {
    return markFailedAndReturn(
      set,
      resolvedIntegrationId,
      [reject(
        "workspace_integration_base_operation_in_progress",
        "Base repository has an incomplete git operation. Finish or abort it before integrate.",
        "baseRepoPath",
      )],
      expectedIdentity,
      integration,
    );
  }

  // Snapshot HEAD for this pick only (abort restore and advancement checks).
  const headBeforePick = await readHeadCommit(baseCwd, input.signal);
  if (!headBeforePick.ok) {
    return markFailedAndReturn(
      set,
      resolvedIntegrationId,
      headBeforePick.diagnostics,
      expectedIdentity,
      integration,
    );
  }
  abortExpectedHead = headBeforePick.hash;

  const cherry = await runGit(
    baseCwd,
    [...CHERRY_PICK_ARGS, commit.commitHash],
    input.signal,
    { env: GIT_WRITE_ENV },
  );

  // Prove ownership only after the pick attempt (uncancelled inspection).
  if (!cherry.ok) {
    const ownership = await cherryPickHeadMatchesWorker(
      baseCwd,
      commit.commitHash,
    );
    if (!ownership.ok) {
      // Inspection failure: do not assume unowned; report diagnostics.
      return markFailedAndReturn(
        set,
        resolvedIntegrationId,
        ownership.diagnostics,
        expectedIdentity,
        integration,
      );
    }
    thisCallOwnedSequencer = ownership.owned;
  }

  if (cherry.ok) {
    // Mutation already succeeded. Reconcile without the caller signal so a late
    // cancel cannot mark failed after HEAD advanced.
    const headAfter = await readHeadCommit(baseCwd, undefined);
    if (!headAfter.ok) {
      return markFailedAndReturn(
        set,
        resolvedIntegrationId,
        headAfter.diagnostics,
        expectedIdentity,
        integration,
      );
    }
    return completeAfterHeadAdvance(
      baseCwd,
      set,
      resolvedIntegrationId,
      headAfter.hash,
      abortExpectedHead,
      commit.commitHash,
      expectedIdentity,
      integration,
      undefined,
    );
  }

  // ---- Cancel after cherry-pick started ----
  // Inspect conflict evidence before cleanup so a late cancel cannot hide it.
  if (cherry.kind === "aborted") {
    return resolveAfterAbortedCherryPick({
      baseCwd,
      workerCommitHash: commit.commitHash,
      abortExpectedHead,
      thisCallOwnedSequencer,
      set,
      integrationId: resolvedIntegrationId,
      expectedIdentity,
      integration,
      cherryMessage: cherry.message,
    });
  }

  // ---- Classify failure: empty / already-applied / conflict / other ----
  // Inspect without the caller signal. A late cancel must not hide conflict
  // evidence after a non-ok cherry-pick (including a conflict exit).
  const inspect = await inspectConflictStateUncancelled(
    baseCwd,
    thisCallOwnedSequencer,
  );
  const emptyOrApplied = looksLikeEmptyOrAlreadyApplied(cherry.message)
    || (inspect.emptyPaths && inspect.incomplete && !looksLikeConflictFailure(cherry.message));

  // Require empty unmerged paths so conflicts with paths are not misclassified.
  if (emptyOrApplied && inspect.emptyPaths) {
    const diags: Diagnostic[] = [];
    const abortResult = await abortOwnedCherryPick(
      baseCwd,
      commit.commitHash,
      abortExpectedHead,
      thisCallOwnedSequencer,
    );
    // Cleanup must succeed before any integrated result. A failed abort can
    // leave CHERRY_PICK_HEAD or another incomplete operation in the repository.
    if (!abortResult.ok) {
      diags.push(...abortResult.diagnostics);
      diags.unshift(reject(
        "workspace_integration_abort_failed",
        "Cleanup after empty or already-applied cherry-pick failed. Manual recovery is required.",
        "baseRepoPath",
      ));
      return markFailedAndReturn(
        set,
        resolvedIntegrationId,
        diags,
        expectedIdentity,
        integration,
      );
    }
    const headNow = await readHeadCommit(baseCwd, undefined);
    // Prefer conclusive tree equality (not limited by patch-id scan depth).
    if (headNow.ok) {
      const trees = await commitTreesEqual(
        baseCwd,
        commit.commitHash,
        headNow.hash,
        undefined,
      );
      if (trees.ok && trees.equal) {
        const integrated = markIntegrationIntegrated(
          set,
          resolvedIntegrationId,
          headNow.hash,
          expectedIdentity,
        );
        if (integrated.ok) {
          return {
            ok: true,
            set: integrated.set,
            integration: integrated.integration,
            integratedCommitHash: headNow.hash,
          };
        }
      }
      // Unbounded patch-id walk for recovery of older applied patches.
      const applied = await workerPatchAppliedInRange(
        baseCwd,
        commit.commitHash,
        commit.baseRevision,
        headNow.hash,
        undefined,
        undefined,
      );
      if (applied.ok && applied.applied) {
        const integrated = markIntegrationIntegrated(
          set,
          resolvedIntegrationId,
          headNow.hash,
          expectedIdentity,
        );
        if (integrated.ok) {
          return {
            ok: true,
            set: integrated.set,
            integration: integrated.integration,
            integratedCommitHash: headNow.hash,
          };
        }
      }
    }
    // Supersedable failed: not conflicted, not a permanent completion marker.
    diags.unshift(reject(
      "workspace_integration_already_applied",
      cherry.message || "Worker commit produced no base change (empty or already applied).",
      "baseRepoPath",
    ));
    return markFailedAndReturn(
      set,
      resolvedIntegrationId,
      diags,
      expectedIdentity,
      integration,
    );
  }

  // Conflict requires real evidence. A path-list failure alone is not a conflict
  // unless this call owns CHERRY_PICK_HEAD (incomplete owned sequencer).
  const isConflict = inspect.hasPaths
    || (inspect.ownedIncomplete && looksLikeConflictFailure(cherry.message))
    || (inspect.pathInspectionFailed && thisCallOwnedSequencer);

  if (isConflict) {
    return recordOwnedConflictResult(
      baseCwd,
      set,
      resolvedIntegrationId,
      commit.commitHash,
      abortExpectedHead,
      thisCallOwnedSequencer,
      expectedIdentity,
      integration,
      inspect,
      cherry.message,
    );
  }

  // Non-conflict failure.
  const diags: Diagnostic[] = [mapGitFailure(
    cherry,
    "baseRepoPath",
    "Worker commit cherry-pick failed",
  )];
  const abortResult = await abortOwnedCherryPick(
    baseCwd,
    commit.commitHash,
    abortExpectedHead,
    thisCallOwnedSequencer,
  );
  if (!abortResult.ok) {
    diags.push(...abortResult.diagnostics);
  }
  return markFailedAndReturn(
    set,
    resolvedIntegrationId,
    diags,
    expectedIdentity,
    integration,
  );
}
