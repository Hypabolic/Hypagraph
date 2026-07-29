import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildExecutorResultPayload,
  type ExecutorAttemptIdentity,
} from "../src/domain/executor-contract.js";
import type { WorkspaceLease, WorkspaceLeaseHolder } from "../src/domain/workspace-lease.js";
import {
  DEFAULT_MAX_CHANGED_PATHS,
  WORKER_COMMIT_RESULT_SCHEMA_VERSION,
  canonicalGitRelativePath,
  compareGitPathOrdinal,
  executorWorkspaceFromWorkerCommit,
  isFullGitObjectId,
  mapWorkerCommitToExecutorWorkspace,
  parseWorkerCommitResult,
  proposeWorkerCommitResult,
  toExecutorWorkspaceResult,
  validateWorkerCommitIdentity,
  validateWorkerCommitResult,
  workerCommitFromExecutorWorkspace,
  workerCommitMatchesExpectedIdentity,
  type WorkerCommitResult,
} from "../src/domain/workspace-commit.js";
import {
  createEmptyWorkspaceWorktreeSet,
} from "../src/domain/workspace-worktree.js";
import {
  prepareMutatingAttemptWorktree,
  releaseAttemptWorktree,
} from "../src/workspace/git-worktree.js";
import {
  collectWorkerCommitResult,
  decodeGitUtf8,
  mapGitRunFailureToDiagnostic,
  parseGitNameOnlyPaths,
  parseGitNameStatusZ,
  parseGitNameStatusZRaw,
  parseGitPorcelainPaths,
  parseGitStatusZ,
  parseGitStatusZRaw,
  probeMarkerPath,
  worktreeSnapshotsEqual,
  type WorktreeSnapshotSample,
} from "../src/workspace/worker-commit.js";

const run = promisify(execFile);
const roots: string[] = [];

const FULL_HASH_A = "a".repeat(40);
const FULL_HASH_B = "b".repeat(40);

const holder = (attemptId: string, overrides: Partial<WorkspaceLeaseHolder> = {}): WorkspaceLeaseHolder => ({
  familyId: "family-1",
  goalId: "goal-1",
  workflowId: "workflow-1",
  revision: 1,
  nodeId: "node-1",
  attemptId,
  ...overrides,
});

const exclusiveLease = (
  leaseId: string,
  attemptId = leaseId,
  baseRevision?: string,
): WorkspaceLease => ({
  leaseId,
  mode: "exclusive",
  holder: holder(attemptId),
  paths: {
    readPaths: ["src"],
    writePaths: ["src"],
  },
  ...(baseRevision !== undefined ? { baseRevision } : {}),
});

const validCommit = (overrides: Partial<WorkerCommitResult> = {}): WorkerCommitResult => ({
  schemaVersion: WORKER_COMMIT_RESULT_SCHEMA_VERSION,
  leaseId: "lease-a",
  worktreeId: "wt-lease-a",
  holder: holder("lease-a"),
  commitHash: FULL_HASH_B,
  baseRevision: FULL_HASH_A,
  changedPaths: ["src/domain/workspace-commit.ts"],
  status: "clean",
  headAdvanced: true,
  ...overrides,
});

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hypagraph-m8-s3-repo-"));
  roots.push(root);
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "hypagraph@example.invalid"], { cwd: root });
  await run("git", ["config", "user.name", "Hypagraph Test"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "initial\n", "utf8");
  await run("git", ["add", "tracked.txt"], { cwd: root });
  await run("git", ["commit", "-m", "Initial"], { cwd: root });
  return root;
};

const headOf = async (cwd: string): Promise<string> => {
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.toString().trim().toLowerCase();
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("m8-s3 structured worker commit results", () => {
  describe("pure validation and mapping", () => {
    it("accepts a well-formed commit result and maps to ExecutorWorkspaceResult", () => {
      const raw = validCommit();
      expect(validateWorkerCommitResult(raw)).toEqual([]);
      const parsed = parseWorkerCommitResult(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.value.schemaVersion).toBe(WORKER_COMMIT_RESULT_SCHEMA_VERSION);
      expect(parsed.value.commitHash).toBe(FULL_HASH_B);
      expect(parsed.value.changedPaths).toEqual(["src/domain/workspace-commit.ts"]);
      expect(parsed.value.status).toBe("clean");
      expect(parsed.value.headAdvanced).toBe(true);

      const mapped = toExecutorWorkspaceResult(parsed.value);
      expect(mapped).toEqual({
        leaseId: "lease-a",
        commitHash: FULL_HASH_B,
        changedPaths: ["src/domain/workspace-commit.ts"],
        status: "clean",
      });

      const viaHelper = mapWorkerCommitToExecutorWorkspace(raw);
      expect(viaHelper.ok).toBe(true);
      if (!viaHelper.ok) return;
      expect(viaHelper.value.commitHash).toBe(FULL_HASH_B);
      expect(viaHelper.value.leaseId).toBe("lease-a");
    });

    it("fills ExecutorResult.workspace through buildExecutorResultPayload", () => {
      const commit = validCommit();
      const workspace = executorWorkspaceFromWorkerCommit(commit);
      expect(workspace.ok).toBe(true);
      if (!workspace.ok) return;

      const identity: ExecutorAttemptIdentity = {
        familyId: "family-1",
        goalId: "goal-1",
        workflowId: "workflow-1",
        revision: 1,
        nodeId: "node-1",
        attemptId: "lease-a",
      };
      const payload = buildExecutorResultPayload({
        identity,
        outcome: "submitted",
        workspace: workspace.value,
        defaultSummary: () => "Worker finished.",
      });
      expect(payload.workspace).toEqual({
        leaseId: "lease-a",
        commitHash: FULL_HASH_B,
        changedPaths: ["src/domain/workspace-commit.ts"],
        status: "clean",
      });
    });

    it("rejects empty commit hash, non-array paths, over-bound lists, wrong schema, and non-plain objects", () => {
      expect(
        validateWorkerCommitResult(validCommit({ commitHash: "" })).some(
          (d) => d.code === "workspace_commit_invalid_commit_hash",
        ),
      ).toBe(true);

      expect(
        validateWorkerCommitResult(validCommit({ commitHash: "deadbeef" })).some(
          (d) => d.code === "workspace_commit_invalid_commit_hash",
        ),
      ).toBe(true);

      expect(
        validateWorkerCommitResult({
          ...validCommit(),
          changedPaths: "not-array",
        }).some((d) => d.code === "workspace_commit_invalid_path_list"),
      ).toBe(true);

      const overBound = validCommit({
        changedPaths: Array.from({ length: DEFAULT_MAX_CHANGED_PATHS + 1 }, (_, i) => `p${i}.ts`),
      });
      expect(
        validateWorkerCommitResult(overBound).some(
          (d) => d.code === "workspace_commit_path_limit",
        ),
      ).toBe(true);

      expect(
        validateWorkerCommitResult(
          validCommit({ changedPaths: ["a.ts", "b.ts"] }),
          "workerCommit",
          { maxChangedPaths: 1 },
        ).some((d) => d.code === "workspace_commit_path_limit"),
      ).toBe(true);

      expect(
        validateWorkerCommitResult({
          ...validCommit(),
          schemaVersion: 99,
        }).some((d) => d.code === "workspace_commit_unsupported_schema"),
      ).toBe(true);

      expect(
        validateWorkerCommitResult({
          ...validCommit(),
          schemaVersion: undefined,
        }).some((d) => d.code === "workspace_commit_unsupported_schema"),
      ).toBe(true);

      expect(
        validateWorkerCommitResult(null).some(
          (d) => d.code === "workspace_commit_not_plain_object",
        ),
      ).toBe(true);

      class CommitClass {
        schemaVersion = 1;
      }
      expect(
        validateWorkerCommitResult(new CommitClass()).some(
          (d) => d.code === "workspace_commit_not_plain_object",
        ),
      ).toBe(true);

      expect(
        validateWorkerCommitResult(validCommit({
          changedPaths: ["../escape.ts"],
        })).some((d) => d.code === "workspace_commit_invalid_path"),
      ).toBe(true);

      expect(
        validateWorkerCommitResult(validCommit({
          changedPaths: ["/abs/path.ts"],
        })).some((d) => d.code === "workspace_commit_invalid_path"),
      ).toBe(true);

      expect(
        validateWorkerCommitResult(validCommit({
          changedPaths: ["src/a.ts", "src/./a.ts"],
        })).some((d) => d.code === "workspace_commit_duplicate_path"),
      ).toBe(true);

      expect(
        validateWorkerCommitResult(validCommit({ status: "ready" as "clean" })).some(
          (d) => d.code === "workspace_commit_invalid_status",
        ),
      ).toBe(true);

      expect(isFullGitObjectId(FULL_HASH_A)).toBe(true);
      expect(isFullGitObjectId("a".repeat(64))).toBe(true);
      expect(isFullGitObjectId("abc")).toBe(false);
    });

    it("rejects contradictory headAdvanced values", () => {
      // Hashes differ but headAdvanced is false.
      expect(
        validateWorkerCommitResult(validCommit({
          commitHash: FULL_HASH_B,
          baseRevision: FULL_HASH_A,
          headAdvanced: false,
        })).some((d) => d.code === "workspace_commit_head_advanced_invariant"),
      ).toBe(true);

      // Hashes equal but headAdvanced is true.
      expect(
        validateWorkerCommitResult(validCommit({
          commitHash: FULL_HASH_A,
          baseRevision: FULL_HASH_A,
          headAdvanced: true,
          changedPaths: [],
        })).some((d) => d.code === "workspace_commit_head_advanced_invariant"),
      ).toBe(true);

      // Consistent: equal hashes, headAdvanced false.
      expect(
        validateWorkerCommitResult(validCommit({
          commitHash: FULL_HASH_A,
          baseRevision: FULL_HASH_A,
          headAdvanced: false,
          changedPaths: [],
        })),
      ).toEqual([]);
    });

    it("rejects stale identity when leaseId, worktreeId, or holder do not match", () => {
      const commit = validCommit();
      expect(
        validateWorkerCommitIdentity(commit, { leaseId: "lease-other" }).some(
          (d) => d.code === "workspace_commit_stale_identity",
        ),
      ).toBe(true);

      expect(
        validateWorkerCommitIdentity(commit, { worktreeId: "wt-other" }).some(
          (d) => d.code === "workspace_commit_stale_identity",
        ),
      ).toBe(true);

      expect(
        validateWorkerCommitIdentity(commit, {
          holder: holder("other-attempt"),
        }).some((d) => d.code === "workspace_commit_stale_identity"),
      ).toBe(true);

      expect(
        validateWorkerCommitIdentity(commit, {
          leaseId: "lease-a",
          worktreeId: "wt-lease-a",
          holder: holder("lease-a"),
        }),
      ).toEqual([]);

      expect(
        workerCommitMatchesExpectedIdentity(commit, {
          leaseId: "lease-a",
          worktreeId: "wt-lease-a",
        }),
      ).toBe(true);
      expect(
        workerCommitMatchesExpectedIdentity(commit, { leaseId: "nope" }),
      ).toBe(false);
    });

    it("rebuilds a worker commit from ExecutorWorkspaceResult plus identity", () => {
      const original = validCommit();
      const workspace = toExecutorWorkspaceResult(original);
      const rebuilt = workerCommitFromExecutorWorkspace(workspace, {
        worktreeId: original.worktreeId,
        holder: original.holder,
        baseRevision: original.baseRevision,
        headAdvanced: original.headAdvanced,
      });
      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;
      expect(rebuilt.value.leaseId).toBe(original.leaseId);
      expect(rebuilt.value.commitHash).toBe(original.commitHash);
      expect(rebuilt.value.changedPaths).toEqual(original.changedPaths);
      expect(rebuilt.value.status).toBe("clean");
    });

    it("rejects invalid maxChangedPaths bounds", () => {
      expect(
        validateWorkerCommitResult(validCommit(), "workerCommit", {
          maxChangedPaths: -1,
        }).some((d) => d.code === "workspace_commit_invalid_bound"),
      ).toBe(true);
    });

    it("proposeWorkerCommitResult does not throw on malformed holder or class input", () => {
      const missingHolder = proposeWorkerCommitResult({
        leaseId: "lease-a",
        worktreeId: "wt-1",
        commitHash: FULL_HASH_B,
        baseRevision: FULL_HASH_A,
        changedPaths: [],
        status: "clean",
        headAdvanced: true,
      });
      expect(missingHolder.ok).toBe(false);
      if (missingHolder.ok) return;
      expect(
        missingHolder.diagnostics.some((d) => d.code === "workspace_commit_invalid_holder"),
      ).toBe(true);

      const nullHolder = proposeWorkerCommitResult({
        leaseId: "lease-a",
        worktreeId: "wt-1",
        holder: null,
        commitHash: FULL_HASH_B,
        baseRevision: FULL_HASH_A,
        changedPaths: [],
        status: "clean",
        headAdvanced: true,
      });
      expect(nullHolder.ok).toBe(false);

      class HolderClass {
        familyId = "f";
      }
      const classHolder = proposeWorkerCommitResult({
        leaseId: "lease-a",
        worktreeId: "wt-1",
        holder: new HolderClass(),
        commitHash: FULL_HASH_B,
        baseRevision: FULL_HASH_A,
        changedPaths: [],
        status: "clean",
        headAdvanced: true,
      });
      expect(classHolder.ok).toBe(false);
      if (classHolder.ok) return;
      expect(
        classHolder.diagnostics.some((d) => d.code === "workspace_commit_invalid_holder"),
      ).toBe(true);

      const notObject = proposeWorkerCommitResult(null);
      expect(notObject.ok).toBe(false);
      if (notObject.ok) return;
      expect(
        notObject.diagnostics.some((d) => d.code === "workspace_commit_not_plain_object"),
      ).toBe(true);

      const emptyLease = proposeWorkerCommitResult({
        leaseId: "  ",
        worktreeId: "wt-1",
        holder: holder("a"),
        commitHash: FULL_HASH_B,
        baseRevision: FULL_HASH_A,
        changedPaths: [],
        status: "clean",
        headAdvanced: true,
      });
      expect(emptyLease.ok).toBe(false);
      if (emptyLease.ok) return;
      expect(
        emptyLease.diagnostics.some((d) => d.code === "workspace_commit_invalid_lease_id"),
      ).toBe(true);
    });

    it("parses null-delimited status with renames, spaces, and arrow names", () => {
      // Normal dirty entries.
      expect(parseGitStatusZ(" M src/a.ts\0?? src/b.ts\0").paths).toEqual([
        "src/a.ts",
        "src/b.ts",
      ]);

      // Rename includes both destination and source.
      const rename = parseGitStatusZ("R  new.ts\0old.ts\0");
      expect(rename.paths).toContain("new.ts");
      expect(rename.paths).toContain("old.ts");

      // Ordinary name that contains " -> " is not split as a rename (status is ??).
      const awkward = parseGitStatusZ("?? file -> name.ts\0");
      expect(awkward.paths).toEqual(["file -> name.ts"]);

      // Spaces preserved (no trim).
      expect(parseGitStatusZ("??  leading space.ts\0").paths).toEqual([" leading space.ts"]);
      expect(parseGitStatusZ(" M path with spaces.ts\0").paths).toEqual(["path with spaces.ts"]);

      // name-status -z renames include both paths.
      expect(parseGitNameStatusZ("R100\0dst.ts\0src.ts\0")).toEqual(["dst.ts", "src.ts"]);
      expect(parseGitNameStatusZ("A\0added.ts\0")).toEqual(["added.ts"]);

      // Empty.
      expect(parseGitStatusZ("").paths).toEqual([]);
      expect(parseGitNameStatusZ("")).toEqual([]);

      // Line-oriented fallback still includes both rename paths for R status.
      expect(parseGitPorcelainPaths("R  old.ts -> new.ts\n")).toEqual(["old.ts", "new.ts"]);
      // Non-rename line with " -> " keeps the full path.
      expect(parseGitPorcelainPaths("?? file -> name.ts\n")).toEqual(["file -> name.ts"]);
      expect(parseGitNameOnlyPaths("src/a.ts\nsrc/b.ts\n")).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("preserves literal backslashes and drive-like POSIX names in git-relative paths", () => {
      expect(canonicalGitRelativePath("a\\b.ts")).toBe("a\\b.ts");
      expect(canonicalGitRelativePath("dir/a\\b.ts")).toBe("dir/a\\b.ts");
      // Leading backslash is a valid relative POSIX name, not absolute for git.
      expect(canonicalGitRelativePath("\\abs.ts")).toBe("\\abs.ts");
      // Drive-like prefix is ordinary relative text on POSIX.
      expect(canonicalGitRelativePath("C:notes.ts")).toBe("C:notes.ts");
      expect(canonicalGitRelativePath("../escape.ts")).toBeUndefined();
      // Only a leading forward slash is absolute.
      expect(canonicalGitRelativePath("/abs.ts")).toBeUndefined();

      const withBackslash = validCommit({
        changedPaths: ["a\\b.ts", "dir/file.ts", "\\abs.ts", "C:notes.ts"],
      });
      const parsed = parseWorkerCommitResult(withBackslash);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.changedPaths).toContain("a\\b.ts");
      expect(parsed.value.changedPaths).toContain("\\abs.ts");
      expect(parsed.value.changedPaths).toContain("C:notes.ts");
      // Must not rewrite to a/b.ts.
      expect(parsed.value.changedPaths).not.toContain("a/b.ts");
    });

    it("sorts changed paths with deterministic ordinal UTF-16 order", () => {
      // Ordinal code-unit order: uppercase before lowercase (unlike many locales).
      expect(compareGitPathOrdinal("B.ts", "a.ts")).toBeLessThan(0);
      expect(compareGitPathOrdinal("a.ts", "B.ts")).toBeGreaterThan(0);
      expect(compareGitPathOrdinal("a.ts", "a.ts")).toBe(0);

      // Non-ASCII: fixed order independent of host locale.
      const paths = ["été.ts", "alpha.ts", "Zed.ts", "ä.ts", "beta.ts"];
      const sorted = [...paths].sort(compareGitPathOrdinal);
      const expected = [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      expect(sorted).toEqual(expected);

      const parsed = parseWorkerCommitResult(validCommit({
        changedPaths: ["été.ts", "alpha.ts", "Zed.ts", "ä.ts"],
        // headAdvanced consistent with distinct hashes
      }));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.changedPaths).toEqual(
        ["Zed.ts", "alpha.ts", "ä.ts", "été.ts"].sort(compareGitPathOrdinal),
      );
      // Explicit fixed order for this set under UTF-16 code units.
      expect(parsed.value.changedPaths).toEqual(
        ["Zed.ts", "alpha.ts", "ä.ts", "été.ts"].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    });

    it("rejects invalid UTF-8 path buffers without lossy replacement", () => {
      // Invalid UTF-8 sequence (lone 0xFF).
      const invalid = Buffer.from([0x3f, 0x3f, 0x20, 0xff, 0x2e, 0x74, 0x73, 0x00]);
      const decoded = decodeGitUtf8(invalid, "status");
      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.diagnostic.code).toBe("workspace_commit_invalid_utf8");

      const statusRaw = parseGitStatusZRaw(invalid);
      expect(statusRaw.ok).toBe(false);
      if (statusRaw.ok) return;
      expect(statusRaw.diagnostic.code).toBe("workspace_commit_invalid_utf8");

      const nameStatusRaw = parseGitNameStatusZRaw(Buffer.from([0x41, 0x00, 0xff, 0x00]));
      expect(nameStatusRaw.ok).toBe(false);
      if (nameStatusRaw.ok) return;
      expect(nameStatusRaw.diagnostic.code).toBe("workspace_commit_invalid_utf8");

      // Valid UTF-8 with non-ASCII still works.
      const nonAscii = Buffer.from("?? café.ts\0", "utf8");
      const okStatus = parseGitStatusZRaw(nonAscii);
      expect(okStatus.ok).toBe(true);
      if (!okStatus.ok) return;
      expect(okStatus.paths).toEqual(["café.ts"]);
    });

    it("compares snapshot samples including active operation and unmerged bytes", () => {
      const base: WorktreeSnapshotSample = {
        head: FULL_HASH_A,
        porcelainRaw: Buffer.from(" M a.ts\0", "utf8"),
        unmergedRaw: Buffer.alloc(0),
        activeOperation: false,
      };
      expect(worktreeSnapshotsEqual(base, { ...base })).toBe(true);
      expect(worktreeSnapshotsEqual(base, {
        ...base,
        activeOperation: true,
      })).toBe(false);
      expect(worktreeSnapshotsEqual(base, {
        ...base,
        unmergedRaw: Buffer.from("u\0", "utf8"),
      })).toBe(false);
      expect(worktreeSnapshotsEqual(base, {
        ...base,
        porcelainRaw: Buffer.from(" M b.ts\0", "utf8"),
      })).toBe(false);
      expect(worktreeSnapshotsEqual(base, {
        ...base,
        head: FULL_HASH_B,
      })).toBe(false);
    });

    it("maps each stable git failure code from structured run results", () => {
      const aborted = mapGitRunFailureToDiagnostic(
        { ok: false, kind: "aborted", message: "x", aborted: true },
        "repo",
        "signal",
        "detail",
      );
      expect(aborted.code).toBe("workspace_commit_aborted");

      const processFail = mapGitRunFailureToDiagnostic(
        { ok: false, kind: "process", message: "spawn failed", aborted: false },
        "head",
        "commitHash",
        "Could not resolve HEAD",
      );
      expect(processFail.code).toBe("workspace_commit_git_process");

      const limit = mapGitRunFailureToDiagnostic(
        { ok: false, kind: "output_limit", message: "limit", aborted: false },
        "diff",
        "changedPaths",
        "detail",
      );
      expect(limit.code).toBe("workspace_commit_git_output_limit");

      expect(mapGitRunFailureToDiagnostic(
        { ok: false, kind: "exit", message: "not a repo", aborted: false },
        "repo",
        "worktree.path",
        "Worktree path is not a git repository",
      ).code).toBe("workspace_commit_not_git_repo");

      expect(mapGitRunFailureToDiagnostic(
        { ok: false, kind: "exit", message: "bad head", aborted: false },
        "head",
        "commitHash",
        "Could not resolve HEAD",
      ).code).toBe("workspace_commit_git_head_failed");

      expect(mapGitRunFailureToDiagnostic(
        { ok: false, kind: "exit", message: "bad base", aborted: false },
        "base",
        "worktree.baseRevision",
        "Could not resolve base revision",
      ).code).toBe("workspace_commit_git_base_failed");

      expect(mapGitRunFailureToDiagnostic(
        { ok: false, kind: "exit", message: "status err", aborted: false },
        "status",
        "status",
        "Could not read worktree status",
      ).code).toBe("workspace_commit_git_status_failed");

      expect(mapGitRunFailureToDiagnostic(
        { ok: false, kind: "exit", message: "diff err", aborted: false },
        "diff",
        "changedPaths",
        "Could not list committed changed paths",
      ).code).toBe("workspace_commit_git_diff_failed");
    });
  });

  describe("host collectWorkerCommitResult", () => {
    it("after prepare, file change, and commit: clean with commit hash and changed path", async () => {
      const base = await repository();
      const set = createEmptyWorkspaceWorktreeSet();
      const lease = exclusiveLease("lease-commit-clean");
      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const wt = prepared.worktree.path;
      await writeFile(join(wt, "worker-file.ts"), "export const x = 1;\n", "utf8");
      await run("git", ["add", "worker-file.ts"], { cwd: wt });
      await run("git", ["commit", "-m", "Worker change"], { cwd: wt });
      const expectedHead = await headOf(wt);

      const collected = await collectWorkerCommitResult({
        worktree: prepared.worktree,
      });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;

      expect(collected.value.commitHash).toBe(expectedHead);
      expect(collected.value.baseRevision).toBe(prepared.worktree.baseRevision.toLowerCase());
      expect(collected.value.status).toBe("clean");
      expect(collected.value.headAdvanced).toBe(true);
      expect(collected.value.changedPaths).toContain("worker-file.ts");
      expect(collected.value.leaseId).toBe(lease.leaseId);
      expect(collected.value.worktreeId).toBe(prepared.worktree.worktreeId);

      const mapped = toExecutorWorkspaceResult(collected.value);
      expect(mapped.commitHash).toBe(expectedHead);
      expect(mapped.changedPaths).toContain("worker-file.ts");
      expect(mapped.status).toBe("clean");
      expect(mapped.leaseId).toBe(lease.leaseId);

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: prepared.set,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("change without commit yields dirty status and includes the path", async () => {
      const base = await repository();
      const set = createEmptyWorkspaceWorktreeSet();
      const lease = exclusiveLease("lease-commit-dirty");
      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const wt = prepared.worktree.path;
      const headBefore = await headOf(wt);
      await writeFile(join(wt, "uncommitted.ts"), "export const y = 2;\n", "utf8");

      const collected = await collectWorkerCommitResult({
        worktree: prepared.worktree,
      });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;

      expect(collected.value.status).toBe("dirty");
      expect(collected.value.commitHash).toBe(headBefore);
      expect(collected.value.headAdvanced).toBe(false);
      expect(collected.value.changedPaths).toContain("uncommitted.ts");

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: prepared.set,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("no changes after prepare yields clean empty changedPaths", async () => {
      const base = await repository();
      const set = createEmptyWorkspaceWorktreeSet();
      const lease = exclusiveLease("lease-commit-empty");
      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const collected = await collectWorkerCommitResult({
        worktree: prepared.worktree,
      });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;

      expect(collected.value.status).toBe("clean");
      expect(collected.value.changedPaths).toEqual([]);
      expect(collected.value.headAdvanced).toBe(false);
      expect(collected.value.commitHash).toBe(
        prepared.worktree.baseRevision.toLowerCase(),
      );

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: prepared.set,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("includes both paths for uncommitted rename and preserves awkward names", async () => {
      const base = await repository();
      const set = createEmptyWorkspaceWorktreeSet();
      const lease = exclusiveLease("lease-commit-rename");
      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const wt = prepared.worktree.path;
      await writeFile(join(wt, "rename-src.ts"), "export const r = 1;\n", "utf8");
      await run("git", ["add", "rename-src.ts"], { cwd: wt });
      await run("git", ["commit", "-m", "Add rename source"], { cwd: wt });
      await run("git", ["mv", "rename-src.ts", "rename-dst.ts"], { cwd: wt });

      // Awkward untracked name with arrow substring and spaces.
      await writeFile(join(wt, "file -> name.ts"), "export const a = 1;\n", "utf8");
      await writeFile(join(wt, "path with spaces.ts"), "export const s = 1;\n", "utf8");

      const collected = await collectWorkerCommitResult({
        worktree: prepared.worktree,
      });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;

      expect(collected.value.status).toBe("dirty");
      expect(collected.value.changedPaths).toContain("rename-src.ts");
      expect(collected.value.changedPaths).toContain("rename-dst.ts");
      expect(collected.value.changedPaths).toContain("file -> name.ts");
      expect(collected.value.changedPaths).toContain("path with spaces.ts");

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: prepared.set,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("reports conflicted for active merge even when unmerged paths are empty", async () => {
      const base = await repository();
      // Need a second commit on main so merge has a base.
      await writeFile(join(base, "base-extra.txt"), "extra\n", "utf8");
      await run("git", ["add", "base-extra.txt"], { cwd: base });
      await run("git", ["commit", "-m", "Base extra"], { cwd: base });

      const set = createEmptyWorkspaceWorktreeSet();
      const lease = exclusiveLease("lease-commit-merge");
      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const wt = prepared.worktree.path;
      // Create a side branch commit in the worktree, then start a merge that can complete.
      await run("git", ["checkout", "-b", "side"], { cwd: wt });
      await writeFile(join(wt, "side.txt"), "side\n", "utf8");
      await run("git", ["add", "side.txt"], { cwd: wt });
      await run("git", ["commit", "-m", "Side"], { cwd: wt });
      await run("git", ["checkout", "-"], { cwd: wt });
      await writeFile(join(wt, "main-only.txt"), "main\n", "utf8");
      await run("git", ["add", "main-only.txt"], { cwd: wt });
      await run("git", ["commit", "-m", "Main only"], { cwd: wt });

      // Start merge without committing (no conflicts expected).
      await run("git", ["merge", "--no-commit", "--no-ff", "side"], { cwd: wt });

      const collected = await collectWorkerCommitResult({
        worktree: prepared.worktree,
      });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;
      expect(collected.value.status).toBe("conflicted");

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: prepared.set,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("rejects path outside parent, missing worktree, non-git, malformed identity, and aborted signal", async () => {
      const base = await repository();
      const set = createEmptyWorkspaceWorktreeSet();
      const lease = exclusiveLease("lease-commit-errors");
      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const escape = await collectWorkerCommitResult({
        worktree: {
          ...prepared.worktree,
          path: resolve(tmpdir(), "outside-hypagraph-worktree"),
        },
      });
      expect(escape.ok).toBe(false);
      if (escape.ok) return;
      // Path may fail worktree validation (absolute path ok) or path_escape.
      expect(
        escape.diagnostics.some((d) =>
          d.code === "workspace_commit_path_escape"
          || d.code === "workspace_worktree_invalid_path"
          || d.code === "workspace_worktree_invalid_path"
        ),
      ).toBe(true);

      // Actually escape path is absolute which is valid for worktree path field.
      // Containment should yield path_escape.
      expect(
        escape.diagnostics.some((d) => d.code === "workspace_commit_path_escape"),
      ).toBe(true);

      const missing = await collectWorkerCommitResult({
        worktree: {
          ...prepared.worktree,
          path: join(prepared.worktree.parentRoot!, "does-not-exist-lease"),
        },
      });
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(
        missing.diagnostics.some((d) => d.code === "workspace_commit_missing_worktree"),
      ).toBe(true);

      const notReady = await collectWorkerCommitResult({
        worktree: {
          ...prepared.worktree,
          status: "released",
        },
      });
      expect(notReady.ok).toBe(false);
      if (notReady.ok) return;
      expect(
        notReady.diagnostics.some((d) => d.code === "workspace_commit_worktree_not_ready"),
      ).toBe(true);

      // Malformed holder: diagnostics, not throw.
      const badHolder = await collectWorkerCommitResult({
        worktree: {
          ...prepared.worktree,
          holder: null as unknown as WorkspaceLeaseHolder,
        },
      });
      expect(badHolder.ok).toBe(false);
      if (badHolder.ok) return;
      expect(
        badHolder.diagnostics.some((d) =>
          d.code === "workspace_worktree_invalid_holder"
          || d.code === "workspace_commit_invalid_holder"
        ),
      ).toBe(true);

      // Non-git: empty temp dir inside the controlled parent.
      const parent = prepared.worktree.parentRoot!;
      const nonGitPath = join(parent, "non-git-dir");
      await mkdir(nonGitPath, { recursive: true });
      const nonGit = await collectWorkerCommitResult({
        worktree: {
          ...prepared.worktree,
          path: nonGitPath,
        },
      });
      expect(nonGit.ok).toBe(false);
      if (nonGit.ok) return;
      expect(
        nonGit.diagnostics.some((d) => d.code === "workspace_commit_not_git_repo"),
      ).toBe(true);

      const controller = new AbortController();
      controller.abort();
      const aborted = await collectWorkerCommitResult({
        worktree: prepared.worktree,
        signal: controller.signal,
      });
      expect(aborted.ok).toBe(false);
      if (aborted.ok) return;
      expect(
        aborted.diagnostics.some((d) => d.code === "workspace_commit_aborted"),
      ).toBe(true);

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: prepared.set,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("includes committed and uncommitted paths when dirty after a commit", async () => {
      const base = await repository();
      const set = createEmptyWorkspaceWorktreeSet();
      const lease = exclusiveLease("lease-commit-mixed");
      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const wt = prepared.worktree.path;
      await writeFile(join(wt, "committed.ts"), "export const c = 1;\n", "utf8");
      await run("git", ["add", "committed.ts"], { cwd: wt });
      await run("git", ["commit", "-m", "Committed"], { cwd: wt });
      await writeFile(join(wt, "still-dirty.ts"), "export const d = 2;\n", "utf8");

      const collected = await collectWorkerCommitResult({
        worktree: prepared.worktree,
      });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;
      expect(collected.value.status).toBe("dirty");
      expect(collected.value.headAdvanced).toBe(true);
      expect(collected.value.changedPaths).toContain("committed.ts");
      expect(collected.value.changedPaths).toContain("still-dirty.ts");

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: prepared.set,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("uses distinct diagnostic codes for repository versus abort failures", async () => {
      const base = await repository();
      const set = createEmptyWorkspaceWorktreeSet();
      const lease = exclusiveLease("lease-commit-codes");
      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const parent = prepared.worktree.parentRoot!;
      const nonGitPath = join(parent, "not-a-repo");
      await mkdir(nonGitPath, { recursive: true });
      const nonGit = await collectWorkerCommitResult({
        worktree: { ...prepared.worktree, path: nonGitPath },
      });
      expect(nonGit.ok).toBe(false);
      if (nonGit.ok) return;
      expect(nonGit.diagnostics.map((d) => d.code)).toContain("workspace_commit_not_git_repo");
      expect(nonGit.diagnostics.every((d) => d.code !== "workspace_commit_git_failed")).toBe(true);

      const controller = new AbortController();
      controller.abort();
      const aborted = await collectWorkerCommitResult({
        worktree: prepared.worktree,
        signal: controller.signal,
      });
      expect(aborted.ok).toBe(false);
      if (aborted.ok) return;
      expect(aborted.diagnostics.map((d) => d.code)).toContain("workspace_commit_aborted");

      // Invalid base revision yields a dedicated base-failure code.
      const badBase = await collectWorkerCommitResult({
        worktree: {
          ...prepared.worktree,
          baseRevision: "0".repeat(40),
        },
      });
      expect(badBase.ok).toBe(false);
      if (badBase.ok) return;
      expect(
        badBase.diagnostics.some((d) => d.code === "workspace_commit_git_base_failed"),
      ).toBe(true);

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: prepared.set,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("preserves a POSIX backslash filename in uncommitted changed paths", async () => {
      const base = await repository();
      const set = createEmptyWorkspaceWorktreeSet();
      const lease = exclusiveLease("lease-commit-backslash");
      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const wt = prepared.worktree.path;
      // On POSIX, a backslash is a normal filename character.
      const oddName = "a\\b.ts";
      await writeFile(join(wt, oddName), "export const z = 1;\n", "utf8");

      const collected = await collectWorkerCommitResult({
        worktree: prepared.worktree,
      });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;
      expect(collected.value.status).toBe("dirty");
      expect(collected.value.changedPaths).toContain(oddName);
      expect(collected.value.changedPaths).not.toContain("a/b.ts");

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: prepared.set,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("probeMarkerPath treats missing markers as absent and reports present files", async () => {
      const root = await mkdtemp(join(tmpdir(), "hypagraph-m8-s3-marker-"));
      roots.push(root);
      const missing = await probeMarkerPath(join(root, "MERGE_HEAD"), "file");
      expect(missing.ok).toBe(true);
      if (!missing.ok) return;
      expect(missing.present).toBe(false);

      const filePath = join(root, "MERGE_HEAD");
      await writeFile(filePath, "abc\n", "utf8");
      const present = await probeMarkerPath(filePath, "file");
      expect(present.ok).toBe(true);
      if (!present.ok) return;
      expect(present.present).toBe(true);

      const missingDir = await probeMarkerPath(join(root, "rebase-merge"), "directory");
      expect(missingDir.ok).toBe(true);
      if (!missingDir.ok) return;
      expect(missingDir.present).toBe(false);

      await mkdir(join(root, "rebase-merge"), { recursive: true });
      const presentDir = await probeMarkerPath(join(root, "rebase-merge"), "directory");
      expect(presentDir.ok).toBe(true);
      if (!presentDir.ok) return;
      expect(presentDir.present).toBe(true);
    });
  });
});
