import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceLease, WorkspaceLeaseHolder } from "../src/domain/workspace-lease.js";
import {
  DEFAULT_MAX_ACTIVE_WORKTREES,
  WORKSPACE_WORKTREE_SET_SCHEMA_VERSION,
  createEmptyWorkspaceWorktreeSet,
  deriveWorktreeBranchName,
  deriveWorktreeDirectoryName,
  deriveWorktreeId,
  getActiveWorktreeForLease,
  getWorktree,
  leaseIdDisambiguator,
  listActiveWorktrees,
  listWorktrees,
  parseWorkspaceWorktree,
  proposeReadyWorktree,
  registerWorktree,
  releaseWorktreeRecord,
  requireExclusiveLeaseForWorktree,
  validateWorkspaceWorktree,
  validateWorkspaceWorktreeSetSchema,
  type WorkspaceWorktree,
  type WorkspaceWorktreeSet,
} from "../src/domain/workspace-worktree.js";
import {
  isPathInsideParent,
  isPathInsideParentCanonical,
  prepareMutatingAttemptWorktree,
  releaseAttemptWorktree,
} from "../src/workspace/git-worktree.js";

const run = promisify(execFile);
const roots: string[] = [];

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

const sharedLease = (leaseId: string, attemptId = leaseId): WorkspaceLease => ({
  leaseId,
  mode: "shared",
  holder: holder(attemptId),
  paths: {
    readPaths: ["src"],
    writePaths: [],
  },
});

const readyWorktree = (
  worktreeId: string,
  leaseId: string,
  path: string,
  overrides: Partial<WorkspaceWorktree> = {},
): WorkspaceWorktree => ({
  worktreeId,
  leaseId,
  holder: holder(leaseId),
  path,
  baseRevision: "abc123",
  status: "ready",
  ...overrides,
});

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-repo-"));
  roots.push(root);
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "hypagraph@example.invalid"], { cwd: root });
  await run("git", ["config", "user.name", "Hypagraph Test"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "initial\n", "utf8");
  await run("git", ["add", "tracked.txt"], { cwd: root });
  await run("git", ["commit", "-m", "Initial"], { cwd: root });
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("m8-s2 worktree per mutating attempt", () => {
  describe("pure registry and validation", () => {
    it("accepts a valid worktree record and rejects missing or wrong schemaVersion", () => {
      const raw = {
        worktreeId: "wt-lease-a",
        leaseId: "lease-a",
        holder: holder("attempt-a"),
        path: "/tmp/worktrees/lease-a",
        baseRevision: "deadbeef",
        branchName: "hypagraph/lease-lease-a",
        parentRoot: "/tmp/worktrees",
        status: "ready",
      };
      expect(validateWorkspaceWorktree(raw)).toEqual([]);
      const parsed = parseWorkspaceWorktree(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.worktreeId).toBe("wt-lease-a");
      expect(parsed.value.status).toBe("ready");
      expect(parsed.value.parentRoot).toBe("/tmp/worktrees");

      expect(
        validateWorkspaceWorktreeSetSchema({ worktrees: [] }).some(
          (d) => d.code === "workspace_worktree_set_unsupported_schema",
        ),
      ).toBe(true);

      expect(
        validateWorkspaceWorktreeSetSchema({
          schemaVersion: 99,
          worktrees: [],
        }).some((d) => d.code === "workspace_worktree_set_unsupported_schema"),
      ).toBe(true);

      expect(
        validateWorkspaceWorktreeSetSchema({
          schemaVersion: WORKSPACE_WORKTREE_SET_SCHEMA_VERSION,
          worktrees: [],
        }),
      ).toEqual([]);
    });

    it("rejects duplicate active worktreeId and allows re-register after release", () => {
      let set = createEmptyWorkspaceWorktreeSet();
      const first = registerWorktree(set, readyWorktree("wt-1", "lease-1", "/tmp/a"));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      set = first.set;

      const dupId = registerWorktree(set, readyWorktree("wt-1", "lease-2", "/tmp/b"));
      expect(dupId.ok).toBe(false);
      if (dupId.ok) return;
      expect(dupId.diagnostics.some((d) => d.code === "workspace_worktree_duplicate_id")).toBe(true);

      const dupLease = registerWorktree(set, readyWorktree("wt-2", "lease-1", "/tmp/c"));
      expect(dupLease.ok).toBe(false);
      if (dupLease.ok) return;
      expect(
        dupLease.diagnostics.some((d) => d.code === "workspace_worktree_duplicate_active_lease"),
      ).toBe(true);

      // Same worktreeId may re-register after release (stable host ids).
      const released = releaseWorktreeRecord(set, "wt-1");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      const again = registerWorktree(
        released.set,
        readyWorktree("wt-1", "lease-1", "/tmp/d"),
      );
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.worktree.path).toBe("/tmp/d");
      expect(again.set.worktrees.filter((item) => item.worktreeId === "wt-1")).toHaveLength(1);
      expect(again.set.worktrees[0]?.status).toBe("ready");
    });

    it("rejects empty paths and empty ids", () => {
      const emptyId = validateWorkspaceWorktree({
        worktreeId: "  ",
        leaseId: "lease-a",
        holder: holder("a"),
        path: "/tmp/x",
        baseRevision: "abc",
        status: "ready",
      });
      expect(emptyId.some((d) => d.code === "workspace_worktree_invalid_id")).toBe(true);

      const emptyPath = validateWorkspaceWorktree({
        worktreeId: "wt-a",
        leaseId: "lease-a",
        holder: holder("a"),
        path: "",
        baseRevision: "abc",
        status: "ready",
      });
      expect(emptyPath.some((d) => d.code === "workspace_worktree_invalid_path")).toBe(true);

      const emptyLease = validateWorkspaceWorktree({
        worktreeId: "wt-a",
        leaseId: " ",
        holder: holder("a"),
        path: "/tmp/x",
        baseRevision: "abc",
        status: "ready",
      });
      expect(emptyLease.some((d) => d.code === "workspace_worktree_invalid_lease_id")).toBe(true);

      class WorktreeClass {
        worktreeId = "wt-a";
        leaseId = "lease-a";
        holder = holder("a");
        path = "/tmp/x";
        baseRevision = "abc";
        status = "ready";
      }
      const classInstance = validateWorkspaceWorktree(new WorktreeClass());
      expect(classInstance.some((d) => d.code === "workspace_worktree_not_plain_object")).toBe(true);
    });

    it("lists and gets worktrees without mutating the set", () => {
      let set = createEmptyWorkspaceWorktreeSet();
      const first = registerWorktree(set, readyWorktree("wt-b", "lease-b", "/tmp/b"));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      set = first.set;
      const second = registerWorktree(set, readyWorktree("wt-a", "lease-a", "/tmp/a"));
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      set = second.set;

      const listed = listWorktrees(set);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.worktrees.map((item) => item.worktreeId)).toEqual(["wt-a", "wt-b"]);
      listed.worktrees[0]!.path = "/mutated";
      expect(set.worktrees.find((item) => item.worktreeId === "wt-a")?.path).toBe("/tmp/a");

      const got = getWorktree(set, "wt-b");
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.worktree?.leaseId).toBe("lease-b");
      if (got.worktree) got.worktree.path = "/mutated-again";
      expect(set.worktrees.find((item) => item.worktreeId === "wt-b")?.path).toBe("/tmp/b");

      const missing = getWorktree(set, "missing");
      expect(missing.ok).toBe(true);
      if (!missing.ok) return;
      expect(missing.worktree).toBeUndefined();
    });

    it("release marks released without mutating the input set object", () => {
      let set = createEmptyWorkspaceWorktreeSet();
      const registered = registerWorktree(set, readyWorktree("wt-1", "lease-1", "/tmp/a"));
      expect(registered.ok).toBe(true);
      if (!registered.ok) return;
      set = registered.set;
      const original = set;

      const released = releaseWorktreeRecord(set, "wt-1");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(true);
      expect(released.set).not.toBe(original);
      expect(original.worktrees[0]?.status).toBe("ready");
      expect(released.set.worktrees[0]?.status).toBe("released");

      const active = listActiveWorktrees(released.set);
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      expect(active.worktrees).toEqual([]);

      const absent = releaseWorktreeRecord(released.set, "nope");
      expect(absent.ok).toBe(true);
      if (!absent.ok) return;
      expect(absent.released).toBe(false);
    });

    it("derives stable pure identity keys and disambiguates sanitized names", () => {
      expect(deriveWorktreeId("lease-a")).toBe("wt-lease-a");
      const dirA = deriveWorktreeDirectoryName("lease-a");
      expect(dirA).toBe(`lease-lease-a-${leaseIdDisambiguator("lease-a")}`);
      expect(deriveWorktreeDirectoryName("../escape")).toBe(
        `lease-escape-${leaseIdDisambiguator("../escape")}`,
      );
      expect(deriveWorktreeDirectoryName("..")).toBeUndefined();
      expect(deriveWorktreeDirectoryName("  ")).toBeUndefined();
      expect(deriveWorktreeBranchName("lease-a")).toBe(`hypagraph/${dirA}`);

      // Distinct lease ids must not share a directory segment after sanitisation.
      const collA = deriveWorktreeDirectoryName("a.b");
      const collB = deriveWorktreeDirectoryName("a_b");
      expect(collA).toBeDefined();
      expect(collB).toBeDefined();
      expect(collA).not.toBe(collB);

      const exclusive = requireExclusiveLeaseForWorktree(exclusiveLease("lease-x"));
      expect(exclusive.ok).toBe(true);

      const shared = requireExclusiveLeaseForWorktree(sharedLease("lease-s"));
      expect(shared.ok).toBe(false);
      if (shared.ok) return;
      expect(shared.diagnostics.some((d) => d.code === "workspace_worktree_lease_not_exclusive")).toBe(
        true,
      );

      // Full m8-s1 validation: exclusive lease with empty write paths is rejected.
      const incomplete = requireExclusiveLeaseForWorktree({
        leaseId: "lease-empty",
        mode: "exclusive",
        holder: holder("attempt-empty"),
        paths: { readPaths: [], writePaths: [] },
      });
      expect(incomplete.ok).toBe(false);
      if (incomplete.ok) return;
      expect(incomplete.diagnostics.some((d) => d.code === "workspace_lease_empty_write_scope")).toBe(
        true,
      );

      const proposed = proposeReadyWorktree({
        lease: exclusiveLease("lease-p"),
        path: "/tmp/p",
        baseRevision: "rev1",
      });
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      expect(proposed.value.worktreeId).toBe("wt-lease-p");
      expect(proposed.value.status).toBe("ready");

      expect(DEFAULT_MAX_ACTIVE_WORKTREES).toBe(32);
    });

    it("rejects unsupported schema on list and register paths", () => {
      const badSet = {
        schemaVersion: 2,
        worktrees: [],
      } as unknown as WorkspaceWorktreeSet;
      const listed = listWorktrees(badSet);
      expect(listed.ok).toBe(false);
      if (listed.ok) return;
      expect(listed.diagnostics[0]?.code).toBe("workspace_worktree_set_unsupported_schema");

      const registered = registerWorktree(badSet, readyWorktree("wt-1", "lease-1", "/tmp/a"));
      expect(registered.ok).toBe(false);
      if (registered.ok) return;
      expect(registered.diagnostics[0]?.code).toBe("workspace_worktree_set_unsupported_schema");
    });

    it("enforces maxActiveWorktrees and rejects invalid bounds", () => {
      let set = createEmptyWorkspaceWorktreeSet();
      const first = registerWorktree(
        set,
        readyWorktree("wt-1", "lease-1", "/tmp/a"),
        { maxActiveWorktrees: 1 },
      );
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      set = first.set;

      const second = registerWorktree(
        set,
        readyWorktree("wt-2", "lease-2", "/tmp/b"),
        { maxActiveWorktrees: 1 },
      );
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.diagnostics.some((d) => d.code === "workspace_worktree_active_limit")).toBe(true);

      const badBound = registerWorktree(
        createEmptyWorkspaceWorktreeSet(),
        readyWorktree("wt-x", "lease-x", "/tmp/x"),
        { maxActiveWorktrees: -1 },
      );
      expect(badBound.ok).toBe(false);
      if (badBound.ok) return;
      expect(badBound.diagnostics.some((d) => d.code === "workspace_worktree_invalid_bound")).toBe(
        true,
      );
    });
  });

  describe("host git worktree", () => {
    it("prepare creates a real git worktree directory for an exclusive lease", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      const set = createEmptyWorkspaceWorktreeSet();
      const result = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-a"),
        set,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.worktree.status).toBe("ready");
      expect(result.worktree.leaseId).toBe("lease-a");
      expect(result.worktree.parentRoot).toBe(resolve(parent));
      expect(result.worktree.path.startsWith(parent) || result.worktree.path.includes("lease-")).toBe(
        true,
      );
      await access(result.worktree.path);
      await access(join(result.worktree.path, "tracked.txt"));
      const content = await readFile(join(result.worktree.path, "tracked.txt"), "utf8");
      expect(content).toBe("initial\n");
      expect(result.worktree.baseRevision.length).toBeGreaterThan(0);
    });

    it("two different attempts get two different worktree paths", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      let set = createEmptyWorkspaceWorktreeSet();

      const first = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-a", "attempt-a"),
        set,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      set = first.set;

      const second = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-b", "attempt-b"),
        set,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      expect(first.worktree.path).not.toBe(second.worktree.path);
      expect(first.worktree.worktreeId).not.toBe(second.worktree.worktreeId);
    });

    it("files written in worktree A do not appear in worktree B or the base checkout", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      let set = createEmptyWorkspaceWorktreeSet();

      const a = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-a"),
        set,
      });
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      set = a.set;

      const b = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-b"),
        set,
      });
      expect(b.ok).toBe(true);
      if (!b.ok) return;

      await writeFile(join(a.worktree.path, "only-a.txt"), "from-a\n", "utf8");

      await expect(access(join(b.worktree.path, "only-a.txt"))).rejects.toBeTruthy();
      await expect(access(join(root, "only-a.txt"))).rejects.toBeTruthy();
      await access(join(a.worktree.path, "only-a.txt"));
    });

    it("prepare without exclusive lease is rejected", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      const result = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: sharedLease("lease-shared"),
        set: createEmptyWorkspaceWorktreeSet(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some((d) => d.code === "workspace_worktree_lease_not_exclusive"),
      ).toBe(true);
      expect(result.set.worktrees).toEqual([]);
    });

    it("release removes the worktree and clears active registry state", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      let set = createEmptyWorkspaceWorktreeSet();

      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-a"),
        set,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      set = prepared.set;
      const worktreePath = prepared.worktree.path;
      const branchName = prepared.worktree.branchName;

      const released = await releaseAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        set,
        worktreeId: prepared.worktree.worktreeId,
      });
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(true);

      const active = listActiveWorktrees(released.set);
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      expect(active.worktrees).toEqual([]);

      const listed = await run("git", ["worktree", "list", "--porcelain"], { cwd: root });
      expect(listed.stdout).not.toContain(worktreePath);

      await expect(access(worktreePath)).rejects.toBeTruthy();

      if (branchName) {
        const branches = await run("git", ["branch", "--list", branchName], { cwd: root });
        expect(branches.stdout.trim()).toBe("");
      }
    });

    it("prepare after release succeeds for the same lease", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      let set = createEmptyWorkspaceWorktreeSet();
      const lease = exclusiveLease("lease-reprep");

      const first = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease,
        set,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      set = first.set;

      const released = await releaseAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        set,
        worktreeId: first.worktree.worktreeId,
      });
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      set = released.set;

      const second = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease,
        set,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.worktree.worktreeId).toBe(first.worktree.worktreeId);
      expect(second.worktree.status).toBe("ready");
      await access(second.worktree.path);
    });

    it("stale ready row with missing directory is recreated", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      let set = createEmptyWorkspaceWorktreeSet();
      const lease = exclusiveLease("lease-stale");

      const first = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease,
        set,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      set = first.set;

      // Simulate missing directory while registry still says ready.
      await run("git", ["worktree", "remove", "--force", first.worktree.path], { cwd: root });
      if (first.worktree.branchName) {
        await run("git", ["branch", "-D", first.worktree.branchName], { cwd: root }).catch(() => undefined);
      }

      const recovered = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease,
        set,
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;
      expect(recovered.worktree.status).toBe("ready");
      await access(recovered.worktree.path);
      const active = listActiveWorktrees(recovered.set);
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      expect(active.worktrees).toHaveLength(1);
    });

    it("leftover isolation branch does not block re-prepare after rollback", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      const lease = exclusiveLease("lease-branch");
      const branchName = deriveWorktreeBranchName(lease.leaseId);
      expect(branchName).toBeDefined();

      // Simulate orphan branch left by a prior failed prepare.
      await run("git", ["branch", branchName!], { cwd: root });

      const result = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease,
        set: createEmptyWorkspaceWorktreeSet(),
      });
      // First prepare may fail because branch exists; host rolls back branch then...
      // Actually git worktree add -b fails if branch exists. Rollback deletes branch.
      // Retry should succeed when we call prepare again after failure.
      if (!result.ok) {
        expect(result.diagnostics.some((d) => d.code === "workspace_worktree_git_failed")).toBe(true);
        // Rollback should have deleted the orphan branch.
        const retry = await prepareMutatingAttemptWorktree({
          baseRepoPath: root,
          worktreeParentRoot: parent,
          lease,
          set: createEmptyWorkspaceWorktreeSet(),
        });
        expect(retry.ok).toBe(true);
        if (!retry.ok) return;
        await access(retry.worktree.path);
      } else {
        await access(result.worktree.path);
      }
    });

    it("rejects path that escapes the configured parent root", async () => {
      const parent = resolve("/tmp/hypagraph-parent-root");
      expect(isPathInsideParent(parent, resolve(parent, "lease-a"))).toBe(true);
      expect(isPathInsideParent(parent, resolve(parent, "..", "escape"))).toBe(false);
      expect(isPathInsideParent(parent, "/etc/passwd")).toBe(false);
      expect(isPathInsideParent(parent, parent)).toBe(false);

      const root = await repository();
      const parentDir = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parentDir);

      let set = createEmptyWorkspaceWorktreeSet();
      const outside = resolve(parentDir, "..", "escape-outside");
      const registered = registerWorktree(
        set,
        readyWorktree("wt-escape", "lease-escape", outside, {
          parentRoot: parentDir,
        }),
      );
      expect(registered.ok).toBe(true);
      if (!registered.ok) return;
      set = registered.set;

      const reverify = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parentDir,
        lease: exclusiveLease("lease-escape"),
        set,
      });
      expect(reverify.ok).toBe(false);
      if (reverify.ok) return;
      expect(
        reverify.diagnostics.some((d) => d.code === "workspace_worktree_path_escape"),
      ).toBe(true);
    });

    it("rejects symlink escape under parent after realpath", async () => {
      const parentDir = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parentDir);
      const outside = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-outside-"));
      roots.push(outside);
      const linkPath = join(parentDir, "escape-link");
      try {
        await symlink(outside, linkPath);
      } catch {
        // Skip when the platform cannot create symlinks.
        return;
      }

      expect(isPathInsideParent(parentDir, linkPath)).toBe(true);
      const canonical = await isPathInsideParentCanonical(parentDir, linkPath, {
        requireExisting: true,
      });
      expect(canonical).toBe(false);
    });

    it("release refuses paths outside the controlled parent", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      const outside = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-outside-"));
      roots.push(outside);

      const setResult = registerWorktree(
        createEmptyWorkspaceWorktreeSet(),
        readyWorktree("wt-out", "lease-out", outside, {
          parentRoot: parent,
          branchName: "hypagraph/orphan",
        }),
      );
      expect(setResult.ok).toBe(true);
      if (!setResult.ok) return;

      const released = await releaseAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        set: setResult.set,
        worktreeId: "wt-out",
      });
      expect(released.ok).toBe(false);
      if (released.ok) return;
      expect(
        released.diagnostics.some((d) => d.code === "workspace_worktree_path_escape"),
      ).toBe(true);
    });

    it("prepare is idempotent for an existing ready worktree", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      let set = createEmptyWorkspaceWorktreeSet();

      const first = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-a"),
        set,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      set = first.set;

      const second = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-a"),
        set,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.worktree.path).toBe(first.worktree.path);
      expect(second.set.worktrees.filter((item) => item.status === "ready")).toHaveLength(1);
    });

    it("uses lease baseRevision when present", async () => {
      const root = await repository();
      const { stdout: head } = await run("git", ["rev-parse", "HEAD"], { cwd: root });
      const revision = head.trim();
      await writeFile(join(root, "tracked.txt"), "second\n", "utf8");
      await run("git", ["add", "tracked.txt"], { cwd: root });
      await run("git", ["commit", "-m", "Second"], { cwd: root });

      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      const result = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-rev", "lease-rev", revision),
        set: createEmptyWorkspaceWorktreeSet(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.worktree.baseRevision.toLowerCase()).toBe(revision.toLowerCase());
      const content = await readFile(join(result.worktree.path, "tracked.txt"), "utf8");
      expect(content).toBe("initial\n");
    });

    it("AbortSignal cancels prepare without leaving a ready registry record", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      const controller = new AbortController();
      controller.abort();
      const result = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-abort"),
        set: createEmptyWorkspaceWorktreeSet(),
        signal: controller.signal,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics.some((d) => d.code === "workspace_worktree_aborted")).toBe(true);
      expect(result.set.worktrees.filter((item) => item.status === "ready")).toEqual([]);
    });

    it("fails when base path is not a git repository", async () => {
      const notGit = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-notgit-"));
      roots.push(notGit);
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      const result = await prepareMutatingAttemptWorktree({
        baseRepoPath: notGit,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-nogit"),
        set: createEmptyWorkspaceWorktreeSet(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some((d) => d.code === "workspace_worktree_not_git_repo"),
      ).toBe(true);
    });

    it("getActiveWorktreeForLease returns the active record", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-active"),
        set: createEmptyWorkspaceWorktreeSet(),
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const active = getActiveWorktreeForLease(prepared.set, "lease-active");
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      expect(active.worktree?.worktreeId).toBe(prepared.worktree.worktreeId);
    });

    it("release by leaseId removes the active worktree", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-by-lease"),
        set: createEmptyWorkspaceWorktreeSet(),
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;

      const released = await releaseAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        set: prepared.set,
        leaseId: "lease-by-lease",
      });
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(true);
      const active = listActiveWorktrees(released.set);
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      expect(active.worktrees).toEqual([]);
    });

    it("release without worktreeId or leaseId uses a dedicated diagnostic code", async () => {
      const root = await repository();
      const result = await releaseAttemptWorktree({
        baseRepoPath: root,
        set: createEmptyWorkspaceWorktreeSet(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some((d) => d.code === "workspace_worktree_release_id_required"),
      ).toBe(true);
    });

    it("stuck preparing status is recovered on prepare", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      const preparingBranch = deriveWorktreeBranchName("lease-prep");
      const stuckOverrides: Partial<WorkspaceWorktree> = {
        status: "preparing",
        parentRoot: parent,
      };
      if (preparingBranch !== undefined) {
        stuckOverrides.branchName = preparingBranch;
      }
      const stuck = registerWorktree(
        createEmptyWorkspaceWorktreeSet(),
        readyWorktree("wt-lease-prep", "lease-prep", join(parent, "missing"), stuckOverrides),
      );
      expect(stuck.ok).toBe(true);
      if (!stuck.ok) return;

      const recovered = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-prep"),
        set: stuck.set,
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;
      expect(recovered.worktree.status).toBe("ready");
      await access(recovered.worktree.path);
    });

    it("preparing recovery does not delete paths outside the parent", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      const outside = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-outside-prep-"));
      roots.push(outside);
      const sentinel = join(outside, "must-not-delete.txt");
      await writeFile(sentinel, "keep\n", "utf8");

      const stuck = registerWorktree(
        createEmptyWorkspaceWorktreeSet(),
        readyWorktree("wt-lease-prep-out", "lease-prep-out", outside, {
          status: "preparing",
          parentRoot: parent,
        }),
      );
      expect(stuck.ok).toBe(true);
      if (!stuck.ok) return;

      const recovered = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("lease-prep-out"),
        set: stuck.set,
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;
      expect(recovered.worktree.status).toBe("ready");
      // Outside path must not be removed during preparing recovery.
      await access(sentinel);
      const kept = await readFile(sentinel, "utf8");
      expect(kept).toBe("keep\n");
      // A new worktree must be created under the controlled parent.
      expect(
        await isPathInsideParentCanonical(parent, recovered.worktree.path, {
          requireExisting: true,
        }),
      ).toBe(true);
    });

    it("host prepare rejects incomplete exclusive leases", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      const result = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: {
          leaseId: "lease-bad",
          mode: "exclusive",
          holder: holder("attempt-bad"),
          paths: { readPaths: [], writePaths: [] },
        },
        set: createEmptyWorkspaceWorktreeSet(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics.some((d) => d.code === "workspace_lease_empty_write_scope")).toBe(
        true,
      );
    });

    it("colliding sanitized lease ids get distinct worktree paths", async () => {
      const root = await repository();
      const parent = await mkdtemp(join(tmpdir(), "hypagraph-m8-s2-parent-"));
      roots.push(parent);
      let set = createEmptyWorkspaceWorktreeSet();

      const first = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("a.b", "attempt-dot"),
        set,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      set = first.set;

      const second = await prepareMutatingAttemptWorktree({
        baseRepoPath: root,
        worktreeParentRoot: parent,
        lease: exclusiveLease("a_b", "attempt-under"),
        set,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.worktree.path).not.toBe(first.worktree.path);
    });
  });
});
