/**
 * Host inspection for structured worker commit results (M8-s3).
 *
 * After a worker mutates a prepared worktree, call collectWorkerCommitResult
 * to read HEAD identity, base revision, changed paths, and clean/dirty status.
 * This module does not integrate into the base workspace, push, merge, or
 * mutate canonical graph or family state.
 *
 * Reuses path containment helpers from git-worktree.ts. Git spawn style and
 * output byte limits match that module.
 *
 * Status rules:
 * - clean: no uncommitted changes and no active merge/rebase/cherry-pick/revert.
 * - dirty: uncommitted changes remain and no active incomplete operation.
 * - conflicted: unmerged paths, conflict porcelain codes, or an active incomplete
 *   merge, rebase, cherry-pick, or revert (including resolved-but-incomplete).
 *
 * Snapshot stability: rechecks HEAD, porcelain, unmerged list, and active
 * operation state after path collection. Retries a fixed number of times.
 * Does not stop worker process trees.
 */

import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { Diagnostic } from "../domain/model.js";
import {
  DEFAULT_MAX_CHANGED_PATHS,
  compareGitPathOrdinal,
  proposeWorkerCommitResult,
  type WorkerCommitResult,
  type WorkerWorkspaceStatus,
} from "../domain/workspace-commit.js";
import {
  parseWorkspaceWorktree,
  type WorkspaceWorktree,
} from "../domain/workspace-worktree.js";
import { isPathInsideParent } from "./git-worktree.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_GIT_OUTPUT_BYTES = 1_048_576;

/** Maximum collect attempts when any snapshot field changes mid-read. */
const MAX_SNAPSHOT_ATTEMPTS = 3;

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type CollectWorkerCommitResultOutcome =
  | { ok: true; value: WorkerCommitResult }
  | { ok: false; diagnostics: Diagnostic[] };

export interface CollectWorkerCommitResultInput {
  /**
   * Ready worktree record from prepareMutatingAttemptWorktree.
   * path, baseRevision, leaseId, worktreeId, and holder are required identity.
   */
  worktree: WorkspaceWorktree;
  /**
   * Controlled parent for containment checks.
   * When omitted, uses worktree.parentRoot when present.
   */
  worktreeParentRoot?: string;
  /**
   * Maximum changed paths. Default DEFAULT_MAX_CHANGED_PATHS.
   * Always enforced when set (including the default).
   */
  maxChangedPaths?: number;
  signal?: AbortSignal;
}

/** Structured failure kinds from runGit for distinct diagnostic codes. */
export type GitRunFailureKind =
  | "aborted"
  | "process"
  | "output_limit"
  | "exit";

export type GitRunResult =
  | { ok: true; raw: Buffer }
  | {
    ok: false;
    kind: GitRunFailureKind;
    message: string;
    aborted: boolean;
  };

export type GitFailureMode =
  | "repo"
  | "head"
  | "base"
  | "status"
  | "diff"
  | "operation"
  | "git_path";

/**
 * One stable sample of worktree state used for snapshot comparison.
 * Includes active-operation state and unmerged output, not only HEAD/porcelain.
 */
export interface WorktreeSnapshotSample {
  head: string;
  porcelainRaw: Buffer;
  unmergedRaw: Buffer;
  activeOperation: boolean;
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

function isAbsentFsError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Decode git path-bearing output as strict UTF-8.
 * Invalid sequences produce a diagnostic (no lossy replacement).
 */
export function decodeGitUtf8(
  raw: Buffer,
  location = "changedPaths",
): { ok: true; text: string } | { ok: false; diagnostic: Diagnostic } {
  try {
    return { ok: true, text: UTF8_FATAL.decode(raw) };
  } catch {
    return {
      ok: false,
      diagnostic: reject(
        "workspace_commit_invalid_utf8",
        "Git path output contains invalid UTF-8 bytes.",
        location,
      ),
    };
  }
}

/**
 * Decode a non-path git text result (rev-parse, flags). Trims newlines only.
 */
function decodeGitTextLine(
  raw: Buffer,
  location: string,
  emptyCode: string,
  emptyMessage: string,
): { ok: true; text: string } | { ok: false; diagnostic: Diagnostic } {
  const decoded = decodeGitUtf8(raw, location);
  if (!decoded.ok) return decoded;
  const text = decoded.text.replace(/\r\n/g, "\n").replace(/\n/g, "").trim();
  if (text.length === 0) {
    return {
      ok: false,
      diagnostic: reject(emptyCode, emptyMessage, location),
    };
  }
  return { ok: true, text };
}

/**
 * Map a structured git failure to a stable diagnostic code.
 * Exported for unit tests of each failure mode.
 */
export function mapGitRunFailureToDiagnostic(
  failure: Extract<GitRunResult, { ok: false }>,
  mode: GitFailureMode,
  location: string,
  detail: string,
): Diagnostic {
  if (failure.kind === "aborted") {
    return reject(
      "workspace_commit_aborted",
      "The worker commit inspection was cancelled.",
      "signal",
    );
  }
  if (failure.kind === "output_limit") {
    return reject(
      "workspace_commit_git_output_limit",
      failure.message,
      location,
    );
  }
  if (failure.kind === "process") {
    return reject(
      "workspace_commit_git_process",
      `${detail}: ${failure.message}`,
      location,
    );
  }
  switch (mode) {
    case "repo":
      return reject(
        "workspace_commit_not_git_repo",
        `${detail}: ${failure.message}`,
        location,
      );
    case "head":
      return reject(
        "workspace_commit_git_head_failed",
        `${detail}: ${failure.message}`,
        location,
      );
    case "base":
      return reject(
        "workspace_commit_git_base_failed",
        `${detail}: ${failure.message}`,
        location,
      );
    case "status":
    case "operation":
    case "git_path":
      return reject(
        "workspace_commit_git_status_failed",
        `${detail}: ${failure.message}`,
        location,
      );
    case "diff":
      return reject(
        "workspace_commit_git_diff_failed",
        `${detail}: ${failure.message}`,
        location,
      );
    default:
      return reject(
        "workspace_commit_git_process",
        `${detail}: ${failure.message}`,
        location,
      );
  }
}

/**
 * Report whether two snapshot samples are identical.
 * Compares HEAD, porcelain bytes, unmerged bytes, and active-operation flag.
 */
export function worktreeSnapshotsEqual(
  left: WorktreeSnapshotSample,
  right: WorktreeSnapshotSample,
): boolean {
  return (
    left.head === right.head
    && left.activeOperation === right.activeOperation
    && left.porcelainRaw.equals(right.porcelainRaw)
    && left.unmergedRaw.equals(right.unmergedRaw)
  );
}

/**
 * Run git and return structured success or failure with a raw stdout buffer.
 * Does not decode or trim path payloads. Callers decode with strict UTF-8.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<GitRunResult> {
  if (signal?.aborted) {
    return {
      ok: false,
      kind: "aborted",
      message: "The worker commit inspection was cancelled.",
      aborted: true,
    };
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("git", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "process",
      message,
      aborted: false,
    };
  }

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

  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = append(stdoutChunks, chunk, stdoutBytes);
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = append(stderrChunks, chunk, stderrBytes);
    });
  }

  try {
    const exitCode = await new Promise<number>((resolveExit, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code) => resolveExit(code ?? -1));
    });
    const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (outputExceeded) {
      return {
        ok: false,
        kind: "output_limit",
        message: "Git output exceeded the fixed read limit.",
        aborted: false,
      };
    }
    const raw = Buffer.concat(stdoutChunks);
    if (exitCode !== 0) {
      return {
        ok: false,
        kind: "exit",
        message: stderrText || `Git exited with code ${exitCode}.`,
        aborted: false,
      };
    }
    return { ok: true, raw };
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      return {
        ok: false,
        kind: "aborted",
        message: "The worker commit inspection was cancelled.",
        aborted: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "process",
      message,
      aborted: false,
    };
  }
}

/**
 * Parse git status --porcelain=v1 -z text (already strict-UTF-8 decoded).
 *
 * Record format:
 * - Normal entry: `XY PATH` then NUL.
 * - Rename or copy: `XY PATH` then NUL then `ORIG_PATH` then NUL.
 *
 * Paths are not trimmed. Rename and copy entries include both paths.
 */
export function parseGitStatusZ(stdout: string): {
  paths: string[];
  hasConflictCodes: boolean;
  dirty: boolean;
} {
  const paths: string[] = [];
  let hasConflictCodes = false;
  if (stdout.length === 0) {
    return { paths, hasConflictCodes, dirty: false };
  }

  const tokens = stdout.split("\0");
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    if (token === undefined || token.length === 0) {
      continue;
    }
    if (token.length < 2) {
      continue;
    }
    const x = token[0]!;
    const y = token[1]!;
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      hasConflictCodes = true;
    }

    let pathValue = "";
    if (token.length >= 3 && token[2] === " ") {
      pathValue = token.slice(3);
    } else if (token.length > 2) {
      pathValue = token.slice(2);
    }

    if (pathValue.length > 0) {
      paths.push(pathValue);
    }

    const isRenameOrCopy = x === "R" || x === "C" || y === "R" || y === "C";
    if (isRenameOrCopy) {
      const origin = tokens[index];
      index += 1;
      if (origin !== undefined && origin.length > 0) {
        paths.push(origin);
      }
    }
  }

  return {
    paths,
    hasConflictCodes,
    dirty: paths.length > 0 || hasConflictCodes,
  };
}

/**
 * Parse git status -z from a raw buffer with strict UTF-8 validation.
 */
export function parseGitStatusZRaw(
  raw: Buffer,
):
  | { ok: true; paths: string[]; hasConflictCodes: boolean; dirty: boolean }
  | { ok: false; diagnostic: Diagnostic } {
  const decoded = decodeGitUtf8(raw, "status");
  if (!decoded.ok) return decoded;
  const parsed = parseGitStatusZ(decoded.text);
  return { ok: true, ...parsed };
}

/**
 * Parse git diff --name-status -z text.
 * Rename/copy status includes both paths. Paths are not trimmed.
 */
export function parseGitNameStatusZ(stdout: string): string[] {
  if (stdout.length === 0) return [];
  const paths: string[] = [];
  const tokens = stdout.split("\0");
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    index += 1;
    if (status === undefined || status.length === 0) {
      continue;
    }
    const isRenameOrCopy = status.startsWith("R") || status.startsWith("C");
    if (isRenameOrCopy) {
      const first = tokens[index];
      index += 1;
      const second = tokens[index];
      index += 1;
      if (first !== undefined && first.length > 0) paths.push(first);
      if (second !== undefined && second.length > 0) paths.push(second);
    } else {
      const pathValue = tokens[index];
      index += 1;
      if (pathValue !== undefined && pathValue.length > 0) {
        paths.push(pathValue);
      }
    }
  }
  return paths;
}

/**
 * Parse git diff --name-status -z from a raw buffer with strict UTF-8 validation.
 */
export function parseGitNameStatusZRaw(
  raw: Buffer,
): { ok: true; paths: string[] } | { ok: false; diagnostic: Diagnostic } {
  const decoded = decodeGitUtf8(raw, "changedPaths");
  if (!decoded.ok) return decoded;
  return { ok: true, paths: parseGitNameStatusZ(decoded.text) };
}

/**
 * Line-oriented porcelain fallback for fixtures.
 * Does not treat ` -> ` in ordinary names as a rename when status is not R/C.
 */
export function parseGitPorcelainPaths(stdout: string): string[] {
  if (stdout.includes("\0")) {
    return parseGitStatusZ(stdout).paths;
  }
  if (stdout.length === 0) return [];
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 3) continue;
    const x = line[0]!;
    const y = line[1]!;
    const rest = line[2] === " " ? line.slice(3) : line.slice(2);
    const isRenameOrCopy = x === "R" || x === "C" || y === "R" || y === "C";
    if (isRenameOrCopy) {
      const arrow = " -> ";
      const at = rest.indexOf(arrow);
      if (at >= 0) {
        const left = rest.slice(0, at);
        const right = rest.slice(at + arrow.length);
        if (left.length > 0) paths.push(left);
        if (right.length > 0) paths.push(right);
      } else if (rest.length > 0) {
        paths.push(rest);
      }
    } else if (rest.length > 0) {
      paths.push(rest);
    }
  }
  return paths;
}

/**
 * Line-oriented name-only fallback for fixtures.
 */
export function parseGitNameOnlyPaths(stdout: string): string[] {
  if (stdout.includes("\0")) {
    return stdout.split("\0").filter((part) => part.length > 0);
  }
  if (stdout.length === 0) return [];
  return stdout
    .split("\n")
    .filter((line) => line.length > 0);
}

function resolveParentRoot(
  worktree: WorkspaceWorktree,
  worktreeParentRoot: string | undefined,
): { ok: true; path: string } | { ok: false; diagnostic: Diagnostic } {
  const raw = worktreeParentRoot !== undefined && worktreeParentRoot.trim().length > 0
    ? worktreeParentRoot
    : worktree.parentRoot;
  if (raw === undefined || raw.trim().length === 0) {
    return {
      ok: false,
      diagnostic: reject(
        "workspace_commit_path_escape",
        "A controlled worktree parent root is required for commit inspection.",
        "worktreeParentRoot",
      ),
    };
  }
  try {
    return { ok: true, path: resolve(raw) };
  } catch {
    return {
      ok: false,
      diagnostic: reject(
        "workspace_commit_path_escape",
        "worktreeParentRoot could not be resolved.",
        "worktreeParentRoot",
      ),
    };
  }
}

/**
 * Probe a marker path. Only ENOENT/ENOTDIR mean absent.
 * Other filesystem errors produce workspace_commit_git_dir_failed.
 */
export async function probeMarkerPath(
  pathValue: string,
  kind: "file" | "directory",
): Promise<
  | { ok: true; present: boolean }
  | { ok: false; diagnostic: Diagnostic }
> {
  try {
    if (kind === "file") {
      await access(pathValue);
      return { ok: true, present: true };
    }
    const info = await stat(pathValue);
    return { ok: true, present: info.isDirectory() };
  } catch (error) {
    if (isAbsentFsError(error)) {
      return { ok: true, present: false };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostic: reject(
        "workspace_commit_git_dir_failed",
        `Could not inspect git operation marker at '${pathValue}': ${message}`,
        "status",
      ),
    };
  }
}

/**
 * Detect active incomplete merge, rebase, cherry-pick, or revert.
 * Resolved conflicts with an unfinished operation still count as conflicted.
 * Filesystem errors other than absence return diagnostics.
 */
export async function detectActiveGitOperation(
  gitCwd: string,
  signal?: AbortSignal,
): Promise<{ ok: true; active: boolean } | { ok: false; diagnostics: Diagnostic[] }> {
  const gitDirResult = await runGit(gitCwd, ["rev-parse", "--absolute-git-dir"], signal);
  if (!gitDirResult.ok) {
    return {
      ok: false,
      diagnostics: [mapGitRunFailureToDiagnostic(
        gitDirResult,
        "git_path",
        "status",
        "Could not resolve absolute git directory",
      )],
    };
  }
  const gitDirDecoded = decodeGitTextLine(
    gitDirResult.raw,
    "status",
    "workspace_commit_git_status_failed",
    "Resolved git directory was empty.",
  );
  if (!gitDirDecoded.ok) {
    return { ok: false, diagnostics: [gitDirDecoded.diagnostic] };
  }
  const gitDir = gitDirDecoded.text;

  const markerFiles = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
  ];
  for (const name of markerFiles) {
    const probe = await probeMarkerPath(resolve(gitDir, name), "file");
    if (!probe.ok) {
      return { ok: false, diagnostics: [probe.diagnostic] };
    }
    if (probe.present) {
      return { ok: true, active: true };
    }
  }

  const markerDirs = ["rebase-merge", "rebase-apply"];
  for (const name of markerDirs) {
    const probe = await probeMarkerPath(resolve(gitDir, name), "directory");
    if (!probe.ok) {
      return { ok: false, diagnostics: [probe.diagnostic] };
    }
    if (probe.present) {
      return { ok: true, active: true };
    }
  }

  return { ok: true, active: false };
}

/**
 * Resolve the worktree path once and confirm it stays inside the parent.
 * Returns the single absolute realpath used for all subsequent git commands.
 *
 * Both parent and worktree are realpath'd once, then compared. That avoids
 * false escapes when resolve() and realpath() disagree (for example /var versus
 * /private/var on macOS). Containment is checked on the exact git cwd.
 */
async function resolveContainedGitCwd(
  worktreePathInput: string,
  parentRootInput: string,
): Promise<{ ok: true; gitCwd: string } | { ok: false; diagnostics: Diagnostic[] }> {
  const worktreePath = resolve(worktreePathInput);
  const parentRoot = resolve(parentRootInput);

  // Fast reject for obvious escape before any filesystem call.
  // This may false-negative on symlink spelling; realpath checks below are authoritative.
  if (
    !isPathInsideParent(parentRoot, worktreePath)
    && resolve(worktreePath) !== resolve(parentRoot)
  ) {
    // Still allow candidates that only match after realpath (symlink parents).
    // Fall through when resolve-only containment fails; realpath may still be inside.
  }

  let gitCwd: string;
  try {
    gitCwd = await realpath(worktreePath);
  } catch (error) {
    if (isAbsentFsError(error)) {
      // Missing path: still report escape when resolve-only path is outside parent.
      if (!isPathInsideParent(parentRoot, worktreePath)) {
        return {
          ok: false,
          diagnostics: [reject(
            "workspace_commit_path_escape",
            "Worktree path escapes the controlled parent root.",
            "worktree.path",
          )],
        };
      }
      return {
        ok: false,
        diagnostics: [reject(
          "workspace_commit_missing_worktree",
          `Worktree path does not exist: ${worktreePath}`,
          "worktree.path",
        )],
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_commit_path_escape",
        `Could not realpath worktree path: ${message}`,
        "worktree.path",
      )],
    };
  }

  let parentCanonical: string;
  try {
    parentCanonical = await realpath(parentRoot);
  } catch (error) {
    if (isAbsentFsError(error)) {
      return {
        ok: false,
        diagnostics: [reject(
          "workspace_commit_path_escape",
          "Controlled parent root does not exist.",
          "worktreeParentRoot",
        )],
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_commit_path_escape",
        `Could not realpath parent root: ${message}`,
        "worktreeParentRoot",
      )],
    };
  }

  // Authoritative containment on the single path used for git.
  if (!isPathInsideParent(parentCanonical, gitCwd)) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_commit_path_escape",
        "Worktree path escapes the controlled parent root after realpath.",
        "worktree.path",
      )],
    };
  }

  return { ok: true, gitCwd };
}

/**
 * Re-resolve the worktree path and confirm it still equals the git cwd in use.
 * Fail closed when the path was replaced or escapes the parent after realpath.
 *
 * Residual TOCTOU: a same-path directory swap can still yield the same realpath
 * string for a different checkout. Full elimination needs a worker process-tree
 * stop (or OS directory pinning) before collection. That work belongs to later
 * M8 recovery. Controllers must stop the executor before collectWorkerCommitResult.
 */
async function revalidateGitCwd(
  worktreePathInput: string,
  parentRootInput: string,
  expectedGitCwd: string,
): Promise<{ ok: true } | { ok: false; diagnostics: Diagnostic[] }> {
  const again = await resolveContainedGitCwd(worktreePathInput, parentRootInput);
  if (!again.ok) {
    return again;
  }
  if (again.gitCwd !== expectedGitCwd) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_commit_path_escape",
        "Worktree path changed during commit inspection (realpath no longer matches the git cwd).",
        "worktree.path",
      )],
    };
  }
  return { ok: true };
}

async function readSnapshotSample(
  gitCwd: string,
  signal?: AbortSignal,
): Promise<
  | { ok: true; sample: WorktreeSnapshotSample }
  | { ok: false; diagnostics: Diagnostic[] }
> {
  const headResult = await runGit(
    gitCwd,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    signal,
  );
  if (!headResult.ok) {
    return {
      ok: false,
      diagnostics: [mapGitRunFailureToDiagnostic(
        headResult,
        "head",
        "commitHash",
        "Could not resolve HEAD",
      )],
    };
  }
  const headDecoded = decodeGitTextLine(
    headResult.raw,
    "commitHash",
    "workspace_commit_git_head_failed",
    "Resolved HEAD commit was empty.",
  );
  if (!headDecoded.ok) {
    return { ok: false, diagnostics: [headDecoded.diagnostic] };
  }

  const unmerged = await runGit(gitCwd, ["ls-files", "-z", "--unmerged"], signal);
  if (!unmerged.ok) {
    return {
      ok: false,
      diagnostics: [mapGitRunFailureToDiagnostic(
        unmerged,
        "status",
        "status",
        "Could not list unmerged paths",
      )],
    };
  }

  const porcelain = await runGit(
    gitCwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    signal,
  );
  if (!porcelain.ok) {
    return {
      ok: false,
      diagnostics: [mapGitRunFailureToDiagnostic(
        porcelain,
        "status",
        "status",
        "Could not read worktree status",
      )],
    };
  }

  const activeOp = await detectActiveGitOperation(gitCwd, signal);
  if (!activeOp.ok) {
    return { ok: false, diagnostics: activeOp.diagnostics };
  }

  return {
    ok: true,
    sample: {
      head: headDecoded.text.toLowerCase(),
      porcelainRaw: Buffer.from(porcelain.raw),
      unmergedRaw: Buffer.from(unmerged.raw),
      activeOperation: activeOp.active,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect a prepared worktree and return a structured worker commit result.
 *
 * Collects:
 * - HEAD full commit hash;
 * - baseRevision from the worktree record;
 * - changed paths versus base (committed) plus uncommitted when dirty;
 * - clean | dirty | conflicted | unknown status;
 * - headAdvanced when HEAD differs from baseRevision.
 *
 * Resolves the worktree path once and uses that path for all git commands.
 * Rechecks HEAD, porcelain, unmerged, and active-operation state after path
 * collection. Retries up to MAX_SNAPSHOT_ATTEMPTS. Does not stop worker trees.
 *
 * Does not mutate the worktree, base repo, or graph state.
 * Returns diagnostics for expected validation and git failures.
 */
export async function collectWorkerCommitResult(
  input: CollectWorkerCommitResultInput,
): Promise<CollectWorkerCommitResultOutcome> {
  if (input.signal?.aborted) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_commit_aborted",
        "The worker commit inspection was cancelled.",
        "signal",
      )],
    };
  }

  const parsedWorktree = parseWorkspaceWorktree(input.worktree, "worktree");
  if (!parsedWorktree.ok) {
    return { ok: false, diagnostics: parsedWorktree.diagnostics };
  }
  const worktree = parsedWorktree.value;

  if (worktree.status !== "ready") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_commit_worktree_not_ready",
        `Worktree status must be 'ready' for commit inspection. Found '${worktree.status}'.`,
        "worktree.status",
      )],
    };
  }

  const parent = resolveParentRoot(worktree, input.worktreeParentRoot);
  if (!parent.ok) {
    return { ok: false, diagnostics: [parent.diagnostic] };
  }

  const contained = await resolveContainedGitCwd(worktree.path, parent.path);
  if (!contained.ok) {
    return { ok: false, diagnostics: contained.diagnostics };
  }
  // Single resolved path for every git command in this collect call.
  const gitCwd = contained.gitCwd;

  if (input.signal?.aborted) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_commit_aborted",
        "The worker commit inspection was cancelled.",
        "signal",
      )],
    };
  }

  const insideCheck = await runGit(
    gitCwd,
    ["rev-parse", "--is-inside-work-tree"],
    input.signal,
  );
  if (!insideCheck.ok) {
    return {
      ok: false,
      diagnostics: [mapGitRunFailureToDiagnostic(
        insideCheck,
        "repo",
        "worktree.path",
        "Worktree path is not a git repository",
      )],
    };
  }
  const insideText = decodeGitTextLine(
    insideCheck.raw,
    "worktree.path",
    "workspace_commit_not_git_repo",
    "Worktree path is not a git work tree.",
  );
  if (!insideText.ok) {
    return { ok: false, diagnostics: [insideText.diagnostic] };
  }
  if (insideText.text !== "true") {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_commit_not_git_repo",
        "Worktree path is not a git work tree.",
        "worktree.path",
      )],
    };
  }

  const toplevel = await runGit(
    gitCwd,
    ["rev-parse", "--show-toplevel"],
    input.signal,
  );
  if (!toplevel.ok) {
    return {
      ok: false,
      diagnostics: [mapGitRunFailureToDiagnostic(
        toplevel,
        "repo",
        "worktree.path",
        "Could not resolve git toplevel",
      )],
    };
  }
  const toplevelDecoded = decodeGitTextLine(
    toplevel.raw,
    "worktree.path",
    "workspace_commit_not_git_repo",
    "Resolved git toplevel was empty.",
  );
  if (!toplevelDecoded.ok) {
    return { ok: false, diagnostics: [toplevelDecoded.diagnostic] };
  }
  // Compare show-toplevel to the single resolved gitCwd without re-resolving gitCwd.
  let toplevelCanonical = resolve(toplevelDecoded.text);
  try {
    toplevelCanonical = await realpath(toplevelCanonical);
  } catch {
    // Keep resolve() form when realpath fails.
  }
  if (toplevelCanonical !== gitCwd) {
    return {
      ok: false,
      diagnostics: [reject(
        "workspace_commit_not_git_repo",
        "Worktree path is not the root of a git work tree.",
        "worktree.path",
      )],
    };
  }

  const baseSpec = worktree.baseRevision;
  const baseResult = await runGit(
    gitCwd,
    ["rev-parse", "--verify", `${baseSpec}^{commit}`],
    input.signal,
  );
  if (!baseResult.ok) {
    return {
      ok: false,
      diagnostics: [mapGitRunFailureToDiagnostic(
        baseResult,
        "base",
        "worktree.baseRevision",
        "Could not resolve base revision",
      )],
    };
  }
  const baseDecoded = decodeGitTextLine(
    baseResult.raw,
    "worktree.baseRevision",
    "workspace_commit_git_base_failed",
    "Resolved base revision was empty.",
  );
  if (!baseDecoded.ok) {
    return { ok: false, diagnostics: [baseDecoded.diagnostic] };
  }
  const baseRevision = baseDecoded.text.toLowerCase();

  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    if (input.signal?.aborted) {
      return {
        ok: false,
        diagnostics: [reject(
          "workspace_commit_aborted",
          "The worker commit inspection was cancelled.",
          "signal",
        )],
      };
    }

    const first = await readSnapshotSample(gitCwd, input.signal);
    if (!first.ok) {
      return { ok: false, diagnostics: first.diagnostics };
    }
    const sample = first.sample;
    const commitHash = sample.head;

    const statusParsed = parseGitStatusZRaw(sample.porcelainRaw);
    if (!statusParsed.ok) {
      return { ok: false, diagnostics: [statusParsed.diagnostic] };
    }

    const unmergedDecoded = decodeGitUtf8(sample.unmergedRaw, "status");
    if (!unmergedDecoded.ok) {
      return { ok: false, diagnostics: [unmergedDecoded.diagnostic] };
    }
    const hasUnmerged = unmergedDecoded.text.split("\0").some((part) => part.length > 0);
    const hasDirty = statusParsed.paths.length > 0 || sample.porcelainRaw.length > 0;

    let status: WorkerWorkspaceStatus;
    if (hasUnmerged || statusParsed.hasConflictCodes || sample.activeOperation) {
      status = "conflicted";
    } else if (hasDirty) {
      status = "dirty";
    } else {
      status = "clean";
    }

    const committedDiff = await runGit(
      gitCwd,
      ["diff", "--name-status", "-z", baseRevision, commitHash],
      input.signal,
    );
    if (!committedDiff.ok) {
      return {
        ok: false,
        diagnostics: [mapGitRunFailureToDiagnostic(
          committedDiff,
          "diff",
          "changedPaths",
          "Could not list committed changed paths",
        )],
      };
    }
    const committedParsed = parseGitNameStatusZRaw(committedDiff.raw);
    if (!committedParsed.ok) {
      return { ok: false, diagnostics: [committedParsed.diagnostic] };
    }

    const pathSet = new Set<string>([...committedParsed.paths, ...statusParsed.paths]);
    // Ordinal UTF-16 order (not localeCompare) for host-independent determinism.
    const changedPaths = [...pathSet].sort(compareGitPathOrdinal);

    // Full snapshot recheck: HEAD, porcelain, unmerged, and active operation.
    const second = await readSnapshotSample(gitCwd, input.signal);
    if (!second.ok) {
      return { ok: false, diagnostics: second.diagnostics };
    }

    if (!worktreeSnapshotsEqual(sample, second.sample)) {
      if (attempt + 1 < MAX_SNAPSHOT_ATTEMPTS) {
        continue;
      }
      return {
        ok: false,
        diagnostics: [reject(
          "workspace_commit_unstable",
          "Worktree HEAD, status, unmerged paths, or active operation changed during commit inspection. Retry later after workers settle.",
          "worktree",
        )],
      };
    }

    // Re-pin path before accepting the result: realpath + containment must still
    // yield the same gitCwd. Process-tree stop is out of this slice.
    const pathRecheck = await revalidateGitCwd(worktree.path, parent.path, gitCwd);
    if (!pathRecheck.ok) {
      if (attempt + 1 < MAX_SNAPSHOT_ATTEMPTS) {
        continue;
      }
      return { ok: false, diagnostics: pathRecheck.diagnostics };
    }

    const headAdvanced = commitHash !== baseRevision;

    const proposed = proposeWorkerCommitResult(
      {
        leaseId: worktree.leaseId,
        worktreeId: worktree.worktreeId,
        holder: worktree.holder,
        commitHash,
        baseRevision,
        changedPaths,
        status,
        headAdvanced,
      },
      { maxChangedPaths: input.maxChangedPaths ?? DEFAULT_MAX_CHANGED_PATHS },
    );

    if (!proposed.ok) {
      return { ok: false, diagnostics: proposed.diagnostics };
    }
    return { ok: true, value: proposed.value };
  }

  return {
    ok: false,
    diagnostics: [reject(
      "workspace_commit_unstable",
      "Worktree HEAD, status, unmerged paths, or active operation changed during commit inspection. Retry later after workers settle.",
      "worktree",
    )],
  };
}
