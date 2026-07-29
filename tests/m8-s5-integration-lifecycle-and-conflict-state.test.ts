import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  WORKER_COMMIT_RESULT_SCHEMA_VERSION,
  type WorkerCommitResult,
} from "../src/domain/workspace-commit.js";
import {
  WORKSPACE_INTEGRATION_SCHEMA_VERSION,
  WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION,
  createEmptyWorkspaceIntegrationSet,
  deriveIntegrationId,
  getActiveIntegrationForLease,
  getIntegration,
  integrationMatchesExpectedIdentity,
  isActiveIntegrationStatus,
  isTerminalIntegrationStatus,
  listIntegrations,
  markIntegrationAborted,
  markIntegrationConflicted,
  markIntegrationFailed,
  markIntegrationIntegrated,
  markIntegrationIntegrating,
  parseIntegrationPreconditions,
  parseWorkspaceIntegration,
  proposePendingIntegration,
  proposePendingIntegrationFromParts,
  registerIntegration,
  pruneTerminalIntegrations,
  registerPendingIntegration,
  releaseIntegrationRecord,
  validateIntegrationIdentity,
  validateWorkspaceIntegration,
  validateWorkspaceIntegrationSet,
  validateWorkspaceIntegrationSetSchema,
  type WorkspaceIntegration,
} from "../src/domain/workspace-integration.js";
import type { WorkspaceLease, WorkspaceLeaseHolder } from "../src/domain/workspace-lease.js";
import {
  createEmptyWorkspaceWorktreeSet,
  type WorkspaceWorktree,
} from "../src/domain/workspace-worktree.js";
import {
  prepareMutatingAttemptWorktree,
  releaseAttemptWorktree,
} from "../src/workspace/git-worktree.js";
import {
  abortOwnedCherryPick,
  cherryPickHeadMatchesWorker,
  integrateWorkerCommit,
  isMissingVerifyRefExit,
  parseUnmergedPathsZ,
  parseUnmergedPathsZRaw,
  resolveAfterAbortedCherryPick,
} from "../src/workspace/integrate-worker-commit.js";
import {
  collectWorkerCommitResult,
  runGit,
} from "../src/workspace/worker-commit.js";

const run = promisify(execFile);
const roots: string[] = [];

const FULL_HASH_A = "a".repeat(40);
const FULL_HASH_B = "b".repeat(40);
const FULL_HASH_C = "c".repeat(40);

const holder = (
  attemptId: string,
  overrides: Partial<WorkspaceLeaseHolder> = {},
): WorkspaceLeaseHolder => ({
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

const validCommit = (overrides: Partial<WorkerCommitResult> = {}): WorkerCommitResult => ({
  schemaVersion: WORKER_COMMIT_RESULT_SCHEMA_VERSION,
  leaseId: "lease-a",
  worktreeId: "wt-lease-a",
  holder: holder("lease-a"),
  commitHash: FULL_HASH_B,
  baseRevision: FULL_HASH_A,
  changedPaths: ["src/domain/workspace-integration.ts"],
  status: "clean",
  headAdvanced: true,
  ...overrides,
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
  baseRevision: FULL_HASH_A,
  status: "ready",
  ...overrides,
});

const pendingIntegration = (
  overrides: Partial<WorkspaceIntegration> = {},
): WorkspaceIntegration => ({
  schemaVersion: WORKSPACE_INTEGRATION_SCHEMA_VERSION,
  integrationId: "int-lease-a",
  leaseId: "lease-a",
  worktreeId: "wt-lease-a",
  holder: holder("lease-a"),
  workerCommitHash: FULL_HASH_B,
  baseRevision: FULL_HASH_A,
  status: "pending",
  ...overrides,
});

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hypagraph-m8-s5-repo-"));
  roots.push(root);
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "hypagraph@example.invalid"], { cwd: root });
  await run("git", ["config", "user.name", "Hypagraph Test"], { cwd: root });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "tracked.txt"), "initial\n", "utf8");
  await run("git", ["add", "src/tracked.txt"], { cwd: root });
  await run("git", ["commit", "-m", "Initial"], { cwd: root });
  return root;
};

const headOf = async (cwd: string): Promise<string> => {
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.toString().trim().toLowerCase();
};

const fileContent = async (cwd: string, rel: string): Promise<string> =>
  readFile(join(cwd, rel), "utf8");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("m8-s5 integration lifecycle and conflict state", () => {
  describe("pure domain lifecycle", () => {
    it("rejects unsupported integration set schema versions", () => {
      expect(
        validateWorkspaceIntegrationSetSchema({ integrations: [] }).some(
          (d) => d.code === "workspace_integration_set_unsupported_schema",
        ),
      ).toBe(true);

      expect(
        validateWorkspaceIntegrationSetSchema({
          schemaVersion: 99,
          integrations: [],
        }).some((d) => d.code === "workspace_integration_set_unsupported_schema"),
      ).toBe(true);

      expect(
        validateWorkspaceIntegrationSetSchema({
          schemaVersion: WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION,
          integrations: [],
        }),
      ).toEqual([]);
    });

    it("rejects unsupported integration record schema and non-plain objects", () => {
      expect(
        validateWorkspaceIntegration({
          ...pendingIntegration(),
          schemaVersion: 99,
        }).some((d) => d.code === "workspace_integration_unsupported_schema"),
      ).toBe(true);

      class FakeIntegration {
        schemaVersion = WORKSPACE_INTEGRATION_SCHEMA_VERSION;
      }
      expect(
        validateWorkspaceIntegration(new FakeIntegration()).some(
          (d) => d.code === "workspace_integration_not_plain_object",
        ),
      ).toBe(true);

      expect(validateWorkspaceIntegration(pendingIntegration())).toEqual([]);
    });

    it("registers a pending integration after validated clean exclusive commit", () => {
      const set = createEmptyWorkspaceIntegrationSet();
      const commit = validCommit();
      const lease = exclusiveLease("lease-a");
      const worktree = readyWorktree("wt-lease-a", "lease-a", "/tmp/wt-a");

      const registered = registerPendingIntegration(set, {
        commit,
        lease,
        worktree,
      });
      expect(registered.ok).toBe(true);
      if (!registered.ok) return;

      expect(registered.integration.status).toBe("pending");
      expect(registered.integration.integrationId).toBe(deriveIntegrationId("lease-a"));
      expect(registered.integration.workerCommitHash).toBe(FULL_HASH_B);
      expect(registered.integration.leaseId).toBe("lease-a");
      expect(registered.set.integrations).toHaveLength(1);

      // Input set not mutated.
      expect(set.integrations).toHaveLength(0);
    });

    it("rejects shared lease at propose and register paths", () => {
      const proposed = proposePendingIntegrationFromParts({
        commit: validCommit(),
        lease: sharedLease("lease-shared"),
        worktree: readyWorktree("wt-shared", "lease-shared", "/tmp/wt-s", {
          holder: holder("lease-shared"),
        }),
      });
      expect(proposed.ok).toBe(false);
      if (proposed.ok) return;
      expect(
        proposed.diagnostics.some((d) => d.code === "workspace_scope_lease_not_exclusive"),
      ).toBe(true);
    });

    it("transitions integrating to integrated", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      const reg = registerIntegration(set, pendingIntegration());
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      set = reg.set;

      const integrating = markIntegrationIntegrating(set, "int-lease-a");
      expect(integrating.ok).toBe(true);
      if (!integrating.ok) return;
      expect(integrating.integration.status).toBe("integrating");
      // Input not mutated.
      expect(set.integrations[0]?.status).toBe("pending");
      set = integrating.set;

      const integrated = markIntegrationIntegrated(set, "int-lease-a", FULL_HASH_C);
      expect(integrated.ok).toBe(true);
      if (!integrated.ok) return;
      expect(integrated.integration.status).toBe("integrated");
      expect(integrated.integration.integratedCommitHash).toBe(FULL_HASH_C);
      expect(isTerminalIntegrationStatus(integrated.integration.status)).toBe(true);
    });

    it("transitions integrating to conflicted with explicit paths", () => {
      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        pendingIntegration(),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const integrating = markIntegrationIntegrating(reg.set, "int-lease-a");
      expect(integrating.ok).toBe(true);
      if (!integrating.ok) return;

      const conflicted = markIntegrationConflicted(
        integrating.set,
        "int-lease-a",
        {
          conflictingPaths: ["src/tracked.txt", "src/other.txt"],
          message: "Merge conflict on worker commit.",
        },
      );
      expect(conflicted.ok).toBe(true);
      if (!conflicted.ok) return;
      expect(conflicted.integration.status).toBe("conflicted");
      expect(conflicted.integration.conflict?.conflictingPaths).toEqual([
        "src/tracked.txt",
        "src/other.txt",
      ]);
      expect(conflicted.integration.conflict?.message).toBe("Merge conflict on worker commit.");
      expect(conflicted.integration.integratedCommitHash).toBeUndefined();
    });

    it("transitions integrating to failed with diagnostics", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      const reg = registerIntegration(set, pendingIntegration());
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      const integrating = markIntegrationIntegrating(reg.set, "int-lease-a");
      expect(integrating.ok).toBe(true);
      if (!integrating.ok) return;

      const failed = markIntegrationFailed(
        integrating.set,
        "int-lease-a",
        [{ code: "workspace_integration_git_failed", message: "git process exited 128." }],
        "git process exited 128.",
      );
      expect(failed.ok).toBe(true);
      if (!failed.ok) return;
      expect(failed.integration.status).toBe("failed");
      expect(failed.integration.diagnostics?.[0]?.code).toBe("workspace_integration_git_failed");
      expect(failed.integration.message).toBe("git process exited 128.");
    });

    it("rejects stale identity on transitions", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      const reg = registerIntegration(set, pendingIntegration());
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      set = reg.set;

      const stale = markIntegrationIntegrating(set, "int-lease-a", {
        leaseId: "other-lease",
      });
      expect(stale.ok).toBe(false);
      if (stale.ok) return;
      expect(
        stale.diagnostics.some((d) => d.code === "workspace_integration_stale_identity"),
      ).toBe(true);

      expect(
        validateIntegrationIdentity(pendingIntegration(), {
          workerCommitHash: FULL_HASH_C,
        }).some((d) => d.code === "workspace_integration_stale_identity"),
      ).toBe(true);

      expect(
        integrationMatchesExpectedIdentity(pendingIntegration(), {
          leaseId: "lease-a",
          workerCommitHash: FULL_HASH_B,
        }),
      ).toBe(true);
    });

    it("rejects integrate transitions when status is already conflicted or integrated", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      const reg = registerIntegration(set, pendingIntegration());
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      const integrating = markIntegrationIntegrating(reg.set, "int-lease-a");
      expect(integrating.ok).toBe(true);
      if (!integrating.ok) return;

      const integrated = markIntegrationIntegrated(
        integrating.set,
        "int-lease-a",
        FULL_HASH_C,
      );
      expect(integrated.ok).toBe(true);
      if (!integrated.ok) return;

      const againConflict = markIntegrationConflicted(
        integrated.set,
        "int-lease-a",
        { conflictingPaths: ["x"] },
      );
      expect(againConflict.ok).toBe(false);
      if (againConflict.ok) return;
      expect(
        againConflict.diagnostics.some((d) => d.code === "workspace_integration_already_integrated"),
      ).toBe(true);

      // Idempotent integrated with same hash.
      const againSame = markIntegrationIntegrated(
        integrated.set,
        "int-lease-a",
        FULL_HASH_C,
      );
      expect(againSame.ok).toBe(true);

      // Different hash when integrated is rejected.
      const againDiff = markIntegrationIntegrated(
        integrated.set,
        "int-lease-a",
        FULL_HASH_A,
      );
      expect(againDiff.ok).toBe(false);
      if (againDiff.ok) return;
      expect(
        againDiff.diagnostics.some((d) => d.code === "workspace_integration_already_integrated"),
      ).toBe(true);

      // Conflicted then integrated is rejected.
      const reg2 = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        pendingIntegration({ integrationId: "int-b", leaseId: "lease-b" }),
      );
      expect(reg2.ok).toBe(true);
      if (!reg2.ok) return;
      const int2 = markIntegrationIntegrating(reg2.set, "int-b");
      expect(int2.ok).toBe(true);
      if (!int2.ok) return;
      const conf = markIntegrationConflicted(int2.set, "int-b", {
        conflictingPaths: ["src/a.ts"],
      });
      expect(conf.ok).toBe(true);
      if (!conf.ok) return;
      const forceIntegrated = markIntegrationIntegrated(conf.set, "int-b", FULL_HASH_C);
      expect(forceIntegrated.ok).toBe(false);
      if (forceIntegrated.ok) return;
      expect(
        forceIntegrated.diagnostics.some(
          (d) => d.code === "workspace_integration_already_conflicted",
        ),
      ).toBe(true);
    });

    it("rejects double register of the same lease attempt when already integrated", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      const reg = registerIntegration(
        set,
        pendingIntegration({ status: "integrated", integratedCommitHash: FULL_HASH_C }),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      set = reg.set;

      const again = registerIntegration(
        set,
        pendingIntegration({ integrationId: "int-lease-a-retry" }),
      );
      expect(again.ok).toBe(false);
      if (again.ok) return;
      expect(
        again.diagnostics.some((d) => d.code === "workspace_integration_already_integrated"),
      ).toBe(true);
    });

    it("refuses release of integrated records and rejects failed to aborted", () => {
      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        pendingIntegration(),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      const integrating = markIntegrationIntegrating(reg.set, "int-lease-a");
      expect(integrating.ok).toBe(true);
      if (!integrating.ok) return;
      const integrated = markIntegrationIntegrated(
        integrating.set,
        "int-lease-a",
        FULL_HASH_C,
      );
      expect(integrated.ok).toBe(true);
      if (!integrated.ok) return;

      const releaseIntegrated = releaseIntegrationRecord(integrated.set, "int-lease-a");
      expect(releaseIntegrated.ok).toBe(false);
      if (releaseIntegrated.ok) return;
      expect(
        releaseIntegrated.diagnostics.some(
          (d) => d.code === "workspace_integration_already_integrated",
        ),
      ).toBe(true);
      expect(integrated.set.integrations[0]?.status).toBe("integrated");

      const regFail = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        pendingIntegration({ integrationId: "int-fail", leaseId: "lease-fail" }),
      );
      expect(regFail.ok).toBe(true);
      if (!regFail.ok) return;
      const failIntegrating = markIntegrationIntegrating(regFail.set, "int-fail");
      expect(failIntegrating.ok).toBe(true);
      if (!failIntegrating.ok) return;
      const failed = markIntegrationFailed(
        failIntegrating.set,
        "int-fail",
        [{ code: "workspace_integration_git_failed", message: "boom" }],
      );
      expect(failed.ok).toBe(true);
      if (!failed.ok) return;
      const abortFailed = markIntegrationAborted(failed.set, "int-fail");
      expect(abortFailed.ok).toBe(false);
      if (abortFailed.ok) return;
      expect(
        abortFailed.diagnostics.some((d) => d.code === "workspace_integration_already_failed"),
      ).toBe(true);
      expect(failed.set.integrations[0]?.diagnostics?.[0]?.code).toBe(
        "workspace_integration_git_failed",
      );
    });

    it("deep-validates integration sets and rejects uncloneable corruption", () => {
      expect(
        validateWorkspaceIntegrationSet({
          schemaVersion: WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION,
          integrations: [{ not: "an integration" }],
        }).some((d) => d.code === "workspace_integration_set_invalid_record"),
      ).toBe(true);

      const corrupt = {
        schemaVersion: WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION,
        integrations: [
          {
            ...pendingIntegration(),
            // Extra function property: clone must not throw; list returns diagnostics.
            fn: () => 1,
          },
        ],
      } as unknown as ReturnType<typeof createEmptyWorkspaceIntegrationSet>;

      const listed = listIntegrations(corrupt);
      expect(listed.ok).toBe(false);
      if (listed.ok) return;
      expect(
        listed.diagnostics.some((d) => d.code === "workspace_integration_set_invalid_record"),
      ).toBe(true);

      const got = getIntegration(corrupt, "int-lease-a");
      expect(got.ok).toBe(false);
      if (got.ok) return;
      expect(
        got.diagnostics.some((d) => d.code === "workspace_integration_set_invalid_record"),
      ).toBe(true);
    });

    it("allows re-register after failed for the same lease and worker commit", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      const failed = registerIntegration(
        set,
        pendingIntegration({ status: "failed" }),
      );
      expect(failed.ok).toBe(true);
      if (!failed.ok) return;
      set = failed.set;

      const retry = registerIntegration(
        set,
        pendingIntegration({ integrationId: "int-lease-a", status: "pending" }),
      );
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.integration.status).toBe("pending");
      expect(retry.set.integrations).toHaveLength(1);
    });

    it("prunes terminal non-integrated records and counts only active toward the limit", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      const reg = registerIntegration(
        set,
        pendingIntegration({
          integrationId: "int-done",
          leaseId: "lease-done",
          status: "failed",
        }),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      set = reg.set;

      const pruned = pruneTerminalIntegrations(set);
      expect(pruned.ok).toBe(true);
      if (!pruned.ok) return;
      expect(pruned.pruned).toBe(1);
      expect(pruned.set.integrations).toHaveLength(0);

      // Active-only limit: many failed rows must not block a new active register after prune.
      let filled = createEmptyWorkspaceIntegrationSet();
      for (let i = 0; i < 3; i += 1) {
        const r = registerIntegration(
          filled,
          pendingIntegration({
            integrationId: `int-f${i}`,
            leaseId: `lease-f${i}`,
            status: "failed",
            workerCommitHash: FULL_HASH_B,
          }),
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        filled = r.set;
      }
      const active = registerIntegration(
        filled,
        pendingIntegration({ integrationId: "int-active", leaseId: "lease-active" }),
        { maxIntegrations: 1 },
      );
      expect(active.ok).toBe(true);
    });

    it("pure helpers do not mutate inputs", () => {
      const set = createEmptyWorkspaceIntegrationSet();
      const candidate = pendingIntegration();
      const frozenPaths = Object.freeze(["src/a.ts"]);
      const reg = registerIntegration(set, candidate);
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const integrating = markIntegrationIntegrating(reg.set, "int-lease-a");
      expect(integrating.ok).toBe(true);
      if (!integrating.ok) return;

      const conflicted = markIntegrationConflicted(
        integrating.set,
        "int-lease-a",
        { conflictingPaths: frozenPaths as string[] },
      );
      expect(conflicted.ok).toBe(true);
      if (!conflicted.ok) return;

      expect(set.integrations).toHaveLength(0);
      expect(candidate.status).toBe("pending");
      expect(reg.set.integrations[0]?.status).toBe("pending");
      expect(integrating.set.integrations[0]?.status).toBe("integrating");
      expect(frozenPaths).toEqual(["src/a.ts"]);
    });

    it("rejects invalid plain objects and lists/gets/releases without mutation", () => {
      const empty = createEmptyWorkspaceIntegrationSet();
      expect(listIntegrations(empty).ok).toBe(true);

      const reg = registerIntegration(empty, pendingIntegration());
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const got = getIntegration(reg.set, "int-lease-a");
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.integration?.status).toBe("pending");
      expect(isActiveIntegrationStatus("pending")).toBe(true);

      const active = getActiveIntegrationForLease(reg.set, "lease-a");
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      expect(active.integration?.integrationId).toBe("int-lease-a");

      const released = releaseIntegrationRecord(reg.set, "int-lease-a");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(true);
      expect(released.set.integrations[0]?.status).toBe("released");
      expect(reg.set.integrations[0]?.status).toBe("pending");

      const aborted = markIntegrationAborted(reg.set, "int-lease-a", "cancelled");
      expect(aborted.ok).toBe(true);
      if (!aborted.ok) return;
      expect(aborted.integration.status).toBe("aborted");

      // Release of conflicted clears conflict so the set remains valid.
      const confReg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        pendingIntegration({ integrationId: "int-rel-c", leaseId: "lease-rel-c" }),
      );
      expect(confReg.ok).toBe(true);
      if (!confReg.ok) return;
      const confInt = markIntegrationIntegrating(confReg.set, "int-rel-c");
      expect(confInt.ok).toBe(true);
      if (!confInt.ok) return;
      const confed = markIntegrationConflicted(confInt.set, "int-rel-c", {
        conflictingPaths: ["src/a.ts"],
        message: "conflict",
      });
      expect(confed.ok).toBe(true);
      if (!confed.ok) return;
      const relConf = releaseIntegrationRecord(confed.set, "int-rel-c");
      expect(relConf.ok).toBe(true);
      if (!relConf.ok) return;
      expect(relConf.set.integrations[0]?.status).toBe("released");
      expect(relConf.set.integrations[0]?.conflict).toBeUndefined();
      expect(validateWorkspaceIntegration(relConf.set.integrations[0]!)).toEqual([]);

      // Release of failed clears diagnostics.
      const failReg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        pendingIntegration({ integrationId: "int-rel-f", leaseId: "lease-rel-f" }),
      );
      expect(failReg.ok).toBe(true);
      if (!failReg.ok) return;
      const failInt = markIntegrationIntegrating(failReg.set, "int-rel-f");
      expect(failInt.ok).toBe(true);
      if (!failInt.ok) return;
      const failedRec = markIntegrationFailed(
        failInt.set,
        "int-rel-f",
        [{ code: "workspace_integration_git_failed", message: "x" }],
      );
      expect(failedRec.ok).toBe(true);
      if (!failedRec.ok) return;
      const relFail = releaseIntegrationRecord(failedRec.set, "int-rel-f");
      expect(relFail.ok).toBe(true);
      if (!relFail.ok) return;
      expect(relFail.set.integrations[0]?.status).toBe("released");
      expect(relFail.set.integrations[0]?.diagnostics).toBeUndefined();
      expect(validateWorkspaceIntegration(relFail.set.integrations[0]!)).toEqual([]);

      const emptyPropose = proposePendingIntegration({} as never);
      expect(emptyPropose.ok).toBe(false);
      if (emptyPropose.ok) return;
      expect(
        emptyPropose.diagnostics.some(
          (d) => d.code === "workspace_integration_input_not_plain_object",
        ),
      ).toBe(true);

      const bad = parseWorkspaceIntegration({ not: "valid" });
      expect(bad.ok).toBe(false);

      const pre = parseIntegrationPreconditions({
        commit: validCommit({ status: "dirty", headAdvanced: true }),
        lease: exclusiveLease("lease-a"),
        worktree: readyWorktree("wt-lease-a", "lease-a", "/tmp/x"),
      });
      expect(pre.ok).toBe(false);
      if (pre.ok) return;
      expect(pre.diagnostics.some((d) => d.code === "workspace_scope_status_dirty")).toBe(true);
    });
  });

  describe("host integrate worker commit", () => {
    it("successfully integrates a worker commit into base and advances HEAD", async () => {
      const base = await repository();
      const baseHead = await headOf(base);
      const lease = exclusiveLease("lease-ok", "lease-ok", baseHead);
      let worktreeSet = createEmptyWorkspaceWorktreeSet();

      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set: worktreeSet,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      worktreeSet = prepared.set;
      const worktree = prepared.worktree;

      await mkdir(join(worktree.path, "src"), { recursive: true });
      await writeFile(join(worktree.path, "src", "feature.ts"), "export const x = 1;\n", "utf8");
      await run("git", ["add", "src/feature.ts"], { cwd: worktree.path });
      await run("git", ["commit", "-m", "Worker feature"], { cwd: worktree.path });

      const collected = await collectWorkerCommitResult({ worktree });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;
      expect(collected.value.status).toBe("clean");
      expect(collected.value.headAdvanced).toBe(true);

      const beforeBase = await headOf(base);
      expect(beforeBase).toBe(baseHead);

      let integrationSet = createEmptyWorkspaceIntegrationSet();
      const result = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree,
        set: integrationSet,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.integration.status).toBe("integrated");
      expect(result.integration.integratedCommitHash).toBeTruthy();
      expect(result.integratedCommitHash).toBe(result.integration.integratedCommitHash);

      const afterBase = await headOf(base);
      expect(afterBase).toBe(result.integratedCommitHash);
      expect(afterBase).not.toBe(beforeBase);

      const feature = await fileContent(base, "src/feature.ts");
      expect(feature).toContain("export const x = 1");

      // Idempotent re-run with same integration id.
      const again = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree,
        set: result.set,
        integrationId: result.integration.integrationId,
      });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.integration.status).toBe("integrated");
      expect(await headOf(base)).toBe(afterBase);

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: worktreeSet,
        worktreeId: worktree.worktreeId,
      });
    });

    it("records conflicted state for concurrent conflicting changes without force merge", async () => {
      const base = await repository();
      const baseHead = await headOf(base);
      const lease = exclusiveLease("lease-conflict", "lease-conflict", baseHead);
      let worktreeSet = createEmptyWorkspaceWorktreeSet();

      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set: worktreeSet,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      worktreeSet = prepared.set;
      const worktree = prepared.worktree;

      // Worker changes the same file.
      await writeFile(join(worktree.path, "src", "tracked.txt"), "worker-change\n", "utf8");
      await run("git", ["add", "src/tracked.txt"], { cwd: worktree.path });
      await run("git", ["commit", "-m", "Worker conflict change"], { cwd: worktree.path });

      const collected = await collectWorkerCommitResult({ worktree });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;

      // Concurrent base change on the same lines.
      await writeFile(join(base, "src", "tracked.txt"), "base-concurrent\n", "utf8");
      await run("git", ["add", "src/tracked.txt"], { cwd: base });
      await run("git", ["commit", "-m", "Base concurrent change"], { cwd: base });
      const baseAfterConcurrent = await headOf(base);

      const result = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree,
        set: createEmptyWorkspaceIntegrationSet(),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.integration?.status).toBe("conflicted");
      expect(
        result.diagnostics.some((d) => d.code === "workspace_integration_conflict"),
      ).toBe(true);

      // Explicit conflict paths required (not vacuous message-only assertion).
      expect(result.integration?.conflict?.conflictingPaths).toContain("src/tracked.txt");
      expect((result.integration?.conflict?.message ?? "").length).toBeGreaterThan(0);

      // Not success; base must not be left mid-merge as success.
      // After abort, HEAD remains the concurrent base commit (no silent overwrite).
      const headAfter = await headOf(base);
      expect(headAfter).toBe(baseAfterConcurrent);

      // Working tree should not still be in an applying state with success claim.
      expect(result.integration?.status).not.toBe("integrated");

      // Content is not forced to worker version.
      const content = await fileContent(base, "src/tracked.txt");
      expect(content).toBe("base-concurrent\n");
      expect(content).not.toBe("worker-change\n");

      // Re-run on conflicted must not overwrite.
      expect(result.integration?.integrationId).toBeTruthy();
      const conflictedId = result.integration!.integrationId;
      const rerun = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree,
        set: result.set,
        integrationId: conflictedId,
      });
      expect(rerun.ok).toBe(false);
      if (rerun.ok) return;
      expect(
        rerun.diagnostics.some((d) => d.code === "workspace_integration_already_conflicted"),
      ).toBe(true);
      expect(await headOf(base)).toBe(baseAfterConcurrent);
      expect(await fileContent(base, "src/tracked.txt")).toBe("base-concurrent\n");

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: worktreeSet,
        worktreeId: worktree.worktreeId,
      });
    });

    it("returns failed diagnostics when aborted via signal before start", async () => {
      const base = await repository();
      const baseHead = await headOf(base);
      const lease = exclusiveLease("lease-abort", "lease-abort", baseHead);
      let worktreeSet = createEmptyWorkspaceWorktreeSet();

      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set: worktreeSet,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      worktreeSet = prepared.set;

      await writeFile(
        join(prepared.worktree.path, "src", "abort.ts"),
        "export {};\n",
        "utf8",
      );
      await run("git", ["add", "src/abort.ts"], { cwd: prepared.worktree.path });
      await run("git", ["commit", "-m", "Worker abort fixture"], {
        cwd: prepared.worktree.path,
      });

      const collected = await collectWorkerCommitResult({ worktree: prepared.worktree });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;

      const controller = new AbortController();
      controller.abort();

      const result = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree: prepared.worktree,
        set: createEmptyWorkspaceIntegrationSet(),
        signal: controller.signal,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some((d) => d.code === "workspace_integration_aborted"),
      ).toBe(true);
      expect(result.integration?.status).not.toBe("integrated");

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: worktreeSet,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("marks failed when signal aborts after durable integrating persist", async () => {
      const base = await repository();
      const baseHead = await headOf(base);
      const lease = exclusiveLease("lease-mid-abort", "lease-mid-abort", baseHead);
      let worktreeSet = createEmptyWorkspaceWorktreeSet();

      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set: worktreeSet,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      worktreeSet = prepared.set;

      await writeFile(
        join(prepared.worktree.path, "src", "mid.ts"),
        "export const mid = 1;\n",
        "utf8",
      );
      await run("git", ["add", "src/mid.ts"], { cwd: prepared.worktree.path });
      await run("git", ["commit", "-m", "Worker mid abort"], {
        cwd: prepared.worktree.path,
      });

      const collected = await collectWorkerCommitResult({ worktree: prepared.worktree });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;

      const controller = new AbortController();
      const before = await headOf(base);
      const result = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree: prepared.worktree,
        set: createEmptyWorkspaceIntegrationSet(),
        signal: controller.signal,
        persist: () => {
          controller.abort();
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.integration?.status).toBe("failed");
      expect(
        result.diagnostics.some((d) => d.code === "workspace_integration_aborted"),
      ).toBe(true);
      expect(await headOf(base)).toBe(before);

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: worktreeSet,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("rejects uncommitted tracked base changes and allows untracked base paths", async () => {
      const base = await repository();
      const baseHead = await headOf(base);
      const lease = exclusiveLease("lease-dirty-base", "lease-dirty-base", baseHead);
      let worktreeSet = createEmptyWorkspaceWorktreeSet();

      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set: worktreeSet,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      worktreeSet = prepared.set;

      await writeFile(
        join(prepared.worktree.path, "src", "ok.ts"),
        "export const ok = 1;\n",
        "utf8",
      );
      await run("git", ["add", "src/ok.ts"], { cwd: prepared.worktree.path });
      await run("git", ["commit", "-m", "Worker ok"], { cwd: prepared.worktree.path });
      const collected = await collectWorkerCommitResult({ worktree: prepared.worktree });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;

      // Tracked dirty base blocks integrate before durable integrating.
      await writeFile(join(base, "src", "tracked.txt"), "dirty-base\n", "utf8");
      let integrationSet = createEmptyWorkspaceIntegrationSet();
      const dirtyResult = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree: prepared.worktree,
        set: integrationSet,
      });
      expect(dirtyResult.ok).toBe(false);
      if (dirtyResult.ok) return;
      expect(
        dirtyResult.diagnostics.some((d) => d.code === "workspace_integration_base_dirty"),
      ).toBe(true);
      // Cheap precheck: no integrating/failed record is created.
      expect(dirtyResult.integration).toBeUndefined();
      expect(await headOf(base)).toBe(baseHead);
      integrationSet = dirtyResult.set;

      // Restore tracked base.
      await run("git", ["checkout", "--", "src/tracked.txt"], { cwd: base });

      // Untracked path under base must not false-fail. Retry with the same set.
      await mkdir(join(base, "untracked-noise"), { recursive: true });
      await writeFile(join(base, "untracked-noise", "x.txt"), "noise\n", "utf8");

      const cleanResult = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree: prepared.worktree,
        set: integrationSet,
      });
      expect(cleanResult.ok).toBe(true);
      if (!cleanResult.ok) return;
      expect(cleanResult.integration.status).toBe("integrated");
      expect(await headOf(base)).not.toBe(baseHead);

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: worktreeSet,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("pre-integration validation failure does not mark integrated", async () => {
      const base = await repository();
      const baseHead = await headOf(base);
      const lease = exclusiveLease("lease-pre", "lease-pre", baseHead);

      // Dirty commit is not eligible; host must not mark integrated.
      const dirtyCommit = validCommit({
        leaseId: "lease-pre",
        worktreeId: "wt-lease-pre",
        holder: holder("lease-pre"),
        commitHash: FULL_HASH_B,
        baseRevision: baseHead.length === 40 ? baseHead : FULL_HASH_A,
        status: "dirty",
        headAdvanced: true,
        changedPaths: ["src/tracked.txt"],
      });

      // Use a synthetic ready worktree path that will not be needed after validation.
      const worktree = readyWorktree("wt-lease-pre", "lease-pre", join(base, "missing-wt"), {
        holder: holder("lease-pre"),
        baseRevision: dirtyCommit.baseRevision,
      });

      const before = await headOf(base);
      const result = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: dirtyCommit,
        lease,
        worktree,
        set: createEmptyWorkspaceIntegrationSet(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some((d) => d.code === "workspace_scope_status_dirty"),
      ).toBe(true);
      expect(result.integration).toBeUndefined();
      expect(await headOf(base)).toBe(before);
    });

    it("rejects multi-commit worker ranges before cherry-pick (single-commit contract)", async () => {
      const base = await repository();
      const baseHead = await headOf(base);
      const lease = exclusiveLease("lease-multi", "lease-multi", baseHead);
      let worktreeSet = createEmptyWorkspaceWorktreeSet();

      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set: worktreeSet,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      worktreeSet = prepared.set;
      const worktree = prepared.worktree;

      await mkdir(join(worktree.path, "src"), { recursive: true });
      await writeFile(join(worktree.path, "src", "first.ts"), "export const a = 1;\n", "utf8");
      await run("git", ["add", "src/first.ts"], { cwd: worktree.path });
      await run("git", ["commit", "-m", "Worker first"], { cwd: worktree.path });

      await writeFile(join(worktree.path, "src", "second.ts"), "export const b = 2;\n", "utf8");
      await run("git", ["add", "src/second.ts"], { cwd: worktree.path });
      await run("git", ["commit", "-m", "Worker second"], { cwd: worktree.path });

      const collected = await collectWorkerCommitResult({ worktree });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;
      expect(collected.value.status).toBe("clean");
      expect(collected.value.commitHash.toLowerCase()).not.toBe(baseHead);
      // HEAD is two commits ahead of baseRevision; sole parent is not baseRevision.
      expect(collected.value.baseRevision.toLowerCase()).toBe(baseHead);

      const beforeBase = await headOf(base);
      const result = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree,
        set: createEmptyWorkspaceIntegrationSet(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some(
          (d) => d.code === "workspace_integration_worker_commit_not_direct_child",
        ),
      ).toBe(true);
      // No partial integrate of only the tip commit.
      expect(await headOf(base)).toBe(beforeBase);
      await expect(fileContent(base, "src/first.ts")).rejects.toThrow();
      await expect(fileContent(base, "src/second.ts")).rejects.toThrow();

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: worktreeSet,
        worktreeId: worktree.worktreeId,
      });
    });

    it("aborted path records conflicted when owned CHERRY_PICK_HEAD conflict exists", async () => {
      const base = await repository();
      const head = await headOf(base);
      // Divergent commits so cherry-pick leaves conflict and CHERRY_PICK_HEAD.
      await writeFile(join(base, "src", "tracked.txt"), "base-side\n", "utf8");
      await run("git", ["add", "src/tracked.txt"], { cwd: base });
      await run("git", ["commit", "-m", "Base side"], { cwd: base });
      const baseSide = await headOf(base);

      await run("git", ["checkout", "-b", "worker-abort-conflict", head], { cwd: base });
      await writeFile(join(base, "src", "tracked.txt"), "worker-side\n", "utf8");
      await run("git", ["add", "src/tracked.txt"], { cwd: base });
      await run("git", ["commit", "-m", "Worker side"], { cwd: base });
      const workerHash = await headOf(base);

      await run("git", ["checkout", "main"], { cwd: base });
      await run("git", ["reset", "--hard", baseSide], { cwd: base });
      try {
        await run("git", ["cherry-pick", workerHash], { cwd: base });
      } catch {
        // Expected conflict leaves CHERRY_PICK_HEAD and unmerged paths.
      }

      const owned = await cherryPickHeadMatchesWorker(base, workerHash);
      expect(owned.ok).toBe(true);
      if (!owned.ok) return;
      expect(owned.owned).toBe(true);

      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        pendingIntegration({
          integrationId: "int-lease-abort-conflict",
          leaseId: "lease-abort-conflict",
          worktreeId: "wt-lease-abort-conflict",
          holder: holder("lease-abort-conflict"),
          workerCommitHash: workerHash,
          baseRevision: head,
        }),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      const integrating = markIntegrationIntegrating(
        reg.set,
        "int-lease-abort-conflict",
        undefined,
        { baseHeadBeforeIntegrate: baseSide },
      );
      expect(integrating.ok).toBe(true);
      if (!integrating.ok) return;

      const expectedIdentity = {
        integrationId: "int-lease-abort-conflict",
        leaseId: "lease-abort-conflict",
        worktreeId: "wt-lease-abort-conflict",
        holder: holder("lease-abort-conflict"),
        workerCommitHash: workerHash,
        baseRevision: head,
      };

      // Simulate runGit returning aborted after conflict state exists.
      const result = await resolveAfterAbortedCherryPick({
        baseCwd: base,
        workerCommitHash: workerHash,
        abortExpectedHead: baseSide,
        thisCallOwnedSequencer: true,
        set: integrating.set,
        integrationId: "int-lease-abort-conflict",
        expectedIdentity,
        integration: integrating.integration,
        cherryMessage: "The worker commit inspection was cancelled.",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.integration).toBeDefined();
      if (result.integration === undefined) return;
      expect(result.integration.status).toBe("conflicted");
      expect(
        result.diagnostics.some((d) => d.code === "workspace_integration_conflict"),
      ).toBe(true);
      // Must not report plain aborted/failed that hides the conflict.
      expect(result.integration.status).not.toBe("failed");
      expect(result.integration.status).not.toBe("aborted");
      // Owned cleanup restores pre-pick HEAD.
      expect(await headOf(base)).toBe(baseSide);
      const afterOwned = await cherryPickHeadMatchesWorker(base, workerHash);
      expect(afterOwned.ok).toBe(true);
      if (!afterOwned.ok) return;
      expect(afterOwned.owned).toBe(false);
    });

    it("parses unmerged path lists from git -z output", () => {
      const sample =
        "100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1\tsrc/a.ts\0"
        + "100644 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2\tsrc/a.ts\0"
        + "100644 cccccccccccccccccccccccccccccccccccccccc 3\tsrc/a.ts\0"
        + "100644 dddddddddddddddddddddddddddddddddddddddd 1\tsrc/b.ts\0";
      expect(parseUnmergedPathsZ(sample)).toEqual(["src/a.ts", "src/b.ts"]);

      const raw = parseUnmergedPathsZRaw(Buffer.from(sample, "utf8"));
      expect(raw.ok).toBe(true);
      if (!raw.ok) return;
      expect(raw.paths).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("reconciles after integrating when the patch is already on base HEAD", async () => {
      const base = await repository();
      const baseHead = await headOf(base);
      const lease = exclusiveLease("lease-reconcile", "lease-reconcile", baseHead);
      let worktreeSet = createEmptyWorkspaceWorktreeSet();

      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set: worktreeSet,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      worktreeSet = prepared.set;

      await writeFile(
        join(prepared.worktree.path, "src", "recon.ts"),
        "export const recon = 1;\n",
        "utf8",
      );
      await run("git", ["add", "src/recon.ts"], { cwd: prepared.worktree.path });
      await run("git", ["commit", "-m", "Worker reconcile"], {
        cwd: prepared.worktree.path,
      });
      const collected = await collectWorkerCommitResult({ worktree: prepared.worktree });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;

      let persistedSet = createEmptyWorkspaceIntegrationSet();
      const first = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree: prepared.worktree,
        set: persistedSet,
        persist: (s) => {
          persistedSet = s;
        },
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.integration.status).toBe("integrated");
      const afterHead = await headOf(base);

      // Simulate crash after cherry-pick: record still integrating, base already advanced.
      const resumedSet: typeof first.set = {
        schemaVersion: first.set.schemaVersion,
        integrations: first.set.integrations.map((item) => {
          const { integratedCommitHash: _removed, ...rest } = item;
          return {
            ...rest,
            status: "integrating" as const,
            baseHeadBeforeIntegrate: baseHead,
          };
        }),
      };

      const resume = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree: prepared.worktree,
        set: resumedSet,
        integrationId: first.integration.integrationId,
      });
      expect(resume.ok).toBe(true);
      if (!resume.ok) return;
      expect(resume.integration.status).toBe("integrated");
      expect(resume.integratedCommitHash).toBe(afterHead);
      expect(await headOf(base)).toBe(afterHead);

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: worktreeSet,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("does not mark integrated on resume after the worker patch was reverted", async () => {
      const base = await repository();
      const baseHead = await headOf(base);
      const lease = exclusiveLease("lease-revert", "lease-revert", baseHead);
      let worktreeSet = createEmptyWorkspaceWorktreeSet();

      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set: worktreeSet,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      worktreeSet = prepared.set;

      await writeFile(
        join(prepared.worktree.path, "src", "rev.ts"),
        "export const rev = 1;\n",
        "utf8",
      );
      await run("git", ["add", "src/rev.ts"], { cwd: prepared.worktree.path });
      await run("git", ["commit", "-m", "Worker rev"], { cwd: prepared.worktree.path });
      const collected = await collectWorkerCommitResult({ worktree: prepared.worktree });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;

      const first = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree: prepared.worktree,
        set: createEmptyWorkspaceIntegrationSet(),
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const integratedHead = await headOf(base);

      // Revert the applied worker change so HEAD no longer carries the worker tree.
      await run("git", ["revert", "--no-edit", "HEAD"], { cwd: base });
      const afterRevert = await headOf(base);
      expect(afterRevert).not.toBe(integratedHead);

      const resumedSet: typeof first.set = {
        schemaVersion: first.set.schemaVersion,
        integrations: first.set.integrations.map((item) => {
          const { integratedCommitHash: _h, ...rest } = item;
          return {
            ...rest,
            status: "integrating" as const,
            baseHeadBeforeIntegrate: baseHead,
          };
        }),
      };

      const resume = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree: prepared.worktree,
        set: resumedSet,
        integrationId: first.integration.integrationId,
      });
      // Must not treat historical patch-id as completion while tree is reverted.
      if (resume.ok) {
        // Re-apply is allowed: HEAD must advance past the revert and restore content.
        expect(resume.integration.status).toBe("integrated");
        expect(resume.integratedCommitHash).not.toBe(afterRevert);
        const content = await fileContent(base, "src/rev.ts");
        expect(content).toContain("export const rev = 1");
      } else {
        expect(resume.integration?.status).not.toBe("integrated");
        expect(resume.integration?.integratedCommitHash).toBeUndefined();
      }

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: worktreeSet,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("treats a second apply of the same patch as already applied, not conflicted empty", async () => {
      const base = await repository();
      const baseHead = await headOf(base);
      const leaseA = exclusiveLease("lease-twice-a", "lease-twice-a", baseHead);
      const leaseB = exclusiveLease("lease-twice-b", "lease-twice-b", baseHead);
      let worktreeSet = createEmptyWorkspaceWorktreeSet();

      // Prepare both worktrees from the same base so B's baseRevision is the original HEAD.
      const preparedA = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease: leaseA,
        set: worktreeSet,
      });
      expect(preparedA.ok).toBe(true);
      if (!preparedA.ok) return;
      worktreeSet = preparedA.set;

      const preparedB = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease: leaseB,
        set: worktreeSet,
      });
      expect(preparedB.ok).toBe(true);
      if (!preparedB.ok) return;
      worktreeSet = preparedB.set;

      const sameContent = "export const twice = 1;\n";
      await writeFile(join(preparedA.worktree.path, "src", "twice.ts"), sameContent, "utf8");
      await run("git", ["add", "src/twice.ts"], { cwd: preparedA.worktree.path });
      await run("git", ["commit", "-m", "Worker twice A"], { cwd: preparedA.worktree.path });
      const collectedA = await collectWorkerCommitResult({ worktree: preparedA.worktree });
      expect(collectedA.ok).toBe(true);
      if (!collectedA.ok) return;

      await writeFile(join(preparedB.worktree.path, "src", "twice.ts"), sameContent, "utf8");
      await run("git", ["add", "src/twice.ts"], { cwd: preparedB.worktree.path });
      await run("git", ["commit", "-m", "Worker twice B"], { cwd: preparedB.worktree.path });
      const collectedB = await collectWorkerCommitResult({ worktree: preparedB.worktree });
      expect(collectedB.ok).toBe(true);
      if (!collectedB.ok) return;

      const first = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collectedA.value,
        lease: leaseA,
        worktree: preparedA.worktree,
        set: createEmptyWorkspaceIntegrationSet(),
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const headBeforeSecond = await headOf(base);
      const second = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collectedB.value,
        lease: leaseB,
        worktree: preparedB.worktree,
        set: createEmptyWorkspaceIntegrationSet(),
      });
      // Pin one outcome: same patch already on base must integrate (not conflicted).
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.integration.status).toBe("integrated");
      expect(second.integratedCommitHash).toBeTruthy();
      expect(second.integration.conflict).toBeUndefined();
      expect(await headOf(base)).toBe(headBeforeSecond);

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: worktreeSet,
        worktreeId: preparedA.worktree.worktreeId,
      });
      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: worktreeSet,
        worktreeId: preparedB.worktree.worktreeId,
      });
    });

    it("reconciles when baseHeadBeforeIntegrate is missing using commit.baseRevision", async () => {
      const base = await repository();
      const baseHead = await headOf(base);
      const lease = exclusiveLease("lease-missing-base", "lease-missing-base", baseHead);
      let worktreeSet = createEmptyWorkspaceWorktreeSet();

      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set: worktreeSet,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      worktreeSet = prepared.set;

      await writeFile(
        join(prepared.worktree.path, "src", "miss.ts"),
        "export const miss = 1;\n",
        "utf8",
      );
      await run("git", ["add", "src/miss.ts"], { cwd: prepared.worktree.path });
      await run("git", ["commit", "-m", "Worker miss base"], {
        cwd: prepared.worktree.path,
      });
      const collected = await collectWorkerCommitResult({ worktree: prepared.worktree });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;

      const first = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree: prepared.worktree,
        set: createEmptyWorkspaceIntegrationSet(),
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const afterHead = await headOf(base);

      // Crash resume without baseHeadBeforeIntegrate on the record.
      const resumedSet: typeof first.set = {
        schemaVersion: first.set.schemaVersion,
        integrations: first.set.integrations.map((item) => {
          const {
            integratedCommitHash: _h,
            baseHeadBeforeIntegrate: _b,
            ...rest
          } = item;
          return {
            ...rest,
            status: "integrating" as const,
            baseRevision: baseHead,
          };
        }),
      };

      const resume = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree: prepared.worktree,
        set: resumedSet,
        integrationId: first.integration.integrationId,
      });
      expect(resume.ok).toBe(true);
      if (!resume.ok) return;
      expect(resume.integration.status).toBe("integrated");
      expect(await headOf(base)).toBe(afterHead);

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: worktreeSet,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("refuses integrate when base has an incomplete git operation", async () => {
      const base = await repository();
      const baseHead = await headOf(base);
      const lease = exclusiveLease("lease-inprog", "lease-inprog", baseHead);
      let worktreeSet = createEmptyWorkspaceWorktreeSet();

      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set: worktreeSet,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      worktreeSet = prepared.set;

      // Worker changes the same lines as a later base commit so cherry-pick conflicts.
      await writeFile(join(prepared.worktree.path, "src", "tracked.txt"), "worker-side\n", "utf8");
      await run("git", ["add", "src/tracked.txt"], { cwd: prepared.worktree.path });
      await run("git", ["commit", "-m", "Worker conflict lines"], {
        cwd: prepared.worktree.path,
      });
      const collected = await collectWorkerCommitResult({ worktree: prepared.worktree });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;

      await writeFile(join(base, "src", "tracked.txt"), "base-side\n", "utf8");
      await run("git", ["add", "src/tracked.txt"], { cwd: base });
      await run("git", ["commit", "-m", "Base conflict lines"], { cwd: base });
      try {
        await run("git", ["cherry-pick", collected.value.commitHash], { cwd: base });
      } catch {
        // Expected conflict leaves CHERRY_PICK_HEAD.
      }

      const emptySet = createEmptyWorkspaceIntegrationSet();
      const result = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree: prepared.worktree,
        set: emptySet,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some(
          (d) => d.code === "workspace_integration_base_operation_in_progress",
        ),
      ).toBe(true);
      expect(result.integration).toBeUndefined();
      // Must not register a pending record before rejection.
      expect(result.set.integrations).toHaveLength(0);

      try {
        await run("git", ["cherry-pick", "--abort"], { cwd: base });
      } catch {
        // ignore
      }

      // Retry after cleanup must not hit duplicate-id or operation-in-progress.
      const retry = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree: prepared.worktree,
        set: result.set,
      });
      if (!retry.ok) {
        expect(
          retry.diagnostics.some((d) => d.code === "workspace_integration_duplicate_id"),
        ).toBe(false);
        expect(
          retry.diagnostics.some(
            (d) => d.code === "workspace_integration_base_operation_in_progress",
          ),
        ).toBe(false);
      }

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: worktreeSet,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("enforces maxRetainedIntegrations and rejects invalid baseHeadBeforeIntegrate", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      for (let i = 0; i < 3; i += 1) {
        const r = registerIntegration(
          set,
          pendingIntegration({
            integrationId: `int-ret-${i}`,
            leaseId: `lease-ret-${i}`,
            status: "integrated",
            integratedCommitHash: FULL_HASH_C,
            workerCommitHash: FULL_HASH_B,
          }),
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        set = r.set;
      }
      const over = registerIntegration(
        set,
        pendingIntegration({
          integrationId: "int-ret-new",
          leaseId: "lease-ret-new",
        }),
        { maxRetainedIntegrations: 3 },
      );
      expect(over.ok).toBe(false);
      if (over.ok) return;
      expect(
        over.diagnostics.some((d) => d.code === "workspace_integration_retained_limit"),
      ).toBe(true);

      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        pendingIntegration(),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      const badHead = markIntegrationIntegrating(reg.set, "int-lease-a", undefined, {
        baseHeadBeforeIntegrate: "not-a-hash",
      });
      expect(badHead.ok).toBe(false);
      if (badHead.ok) return;
      expect(
        badHead.diagnostics.some(
          (d) => d.code === "workspace_integration_invalid_base_head_before",
        ),
      ).toBe(true);
    });

    it("proves CHERRY_PICK_HEAD ownership and aborts owned conflict sequencers", async () => {
      const base = await repository();
      const head = await headOf(base);
      // Divergent commits so cherry-pick leaves a conflict sequencer.
      await writeFile(join(base, "src", "tracked.txt"), "base-side\n", "utf8");
      await run("git", ["add", "src/tracked.txt"], { cwd: base });
      await run("git", ["commit", "-m", "Base side"], { cwd: base });
      const baseSide = await headOf(base);

      await run("git", ["checkout", "-b", "worker-branch", head], { cwd: base });
      await writeFile(join(base, "src", "tracked.txt"), "worker-side\n", "utf8");
      await run("git", ["add", "src/tracked.txt"], { cwd: base });
      await run("git", ["commit", "-m", "Worker side"], { cwd: base });
      const workerHash = await headOf(base);

      await run("git", ["checkout", "main"], { cwd: base });
      // main may be baseSide; ensure we are on the base-side tip.
      await run("git", ["reset", "--hard", baseSide], { cwd: base });
      try {
        await run("git", ["cherry-pick", workerHash], { cwd: base });
      } catch {
        // Expected conflict.
      }

      const owned = await cherryPickHeadMatchesWorker(base, workerHash);
      expect(owned.ok).toBe(true);
      if (!owned.ok) return;
      expect(owned.owned).toBe(true);

      const absent = await cherryPickHeadMatchesWorker(base, "a".repeat(40));
      expect(absent.ok).toBe(true);
      if (!absent.ok) return;
      expect(absent.owned).toBe(false);

      const cleaned = await abortOwnedCherryPick(base, workerHash, baseSide, true);
      expect(cleaned.ok).toBe(true);
      if (!cleaned.ok) return;
      expect(cleaned.aborted).toBe(true);

      const after = await cherryPickHeadMatchesWorker(base, workerHash);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.owned).toBe(false);
      expect(await headOf(base)).toBe(baseSide);
    });

    it("classifies missing-ref exits without treating all exits as absent", () => {
      expect(
        isMissingVerifyRefExit({
          ok: false,
          kind: "exit",
          message: "fatal: Needed a single revision",
          aborted: false,
          exitCode: 128,
        }),
      ).toBe(true);
      expect(
        isMissingVerifyRefExit({
          ok: false,
          kind: "exit",
          message: "fatal: not a git repository",
          aborted: false,
          exitCode: 128,
        }),
      ).toBe(false);
      expect(
        isMissingVerifyRefExit({
          ok: false,
          kind: "process",
          message: "spawn git ENOENT",
          aborted: false,
        }),
      ).toBe(false);
    });

    it("distinguishes merge-base --is-ancestor exit 1 from other exit codes", async () => {
      const base = await repository();
      const head = await headOf(base);
      // Create a second commit so HEAD is not an ancestor of the root? 
      // A is ancestor of HEAD; reverse is false with exit 1.
      await writeFile(join(base, "src", "anc.txt"), "x\n", "utf8");
      await run("git", ["add", "src/anc.txt"], { cwd: base });
      await run("git", ["commit", "-m", "Second"], { cwd: base });
      const head2 = await headOf(base);

      const isAnc = await runGit(base, ["merge-base", "--is-ancestor", head, head2]);
      expect(isAnc.ok).toBe(true);

      const notAnc = await runGit(base, ["merge-base", "--is-ancestor", head2, head]);
      expect(notAnc.ok).toBe(false);
      if (notAnc.ok) return;
      expect(notAnc.kind).toBe("exit");
      expect(notAnc.exitCode).toBe(1);

      const bad = await runGit(base, ["merge-base", "--is-ancestor", "not-a-commit", head2]);
      expect(bad.ok).toBe(false);
      if (bad.ok) return;
      expect(bad.kind).toBe("exit");
      expect(bad.exitCode).not.toBe(1);
      expect(bad.exitCode).toBeGreaterThan(1);
    });

    it("runGit with stdin does not throw when the process exits early", async () => {
      const base = await repository();
      // `git cat-file --batch-check` reads stdin; closing after a short payload is fine.
      // Feed a large buffer to a command that exits immediately without reading stdin.
      const large = Buffer.alloc(64 * 1024, 0x61);
      const result = await runGit(
        base,
        ["rev-parse", "--verify", "HEAD"],
        undefined,
        { stdin: large },
      );
      // rev-parse ignores stdin; success or typed failure, never an uncaught throw.
      expect(result.ok === true || result.ok === false).toBe(true);
      if (result.ok) {
        expect(result.raw.length).toBeGreaterThan(0);
      }
    });

    it("runGit returns only after the child process closes on abort", async () => {
      const base = await repository();
      const controller = new AbortController();
      let childPid: number | undefined;
      const pending = runGit(
        base,
        ["cat-file", "--batch"],
        controller.signal,
        {
          leaveStdinOpen: true,
          onSpawn: (pid) => {
            childPid = pid;
          },
        },
      );

      // Wait until spawn reports a process id (deterministic; no fixed sleep).
      const spawnDeadline = Date.now() + 5_000;
      while (childPid === undefined && Date.now() < spawnDeadline) {
        await new Promise<void>((resolveWait) => {
          setTimeout(resolveWait, 10);
        });
      }
      expect(childPid).toBeTypeOf("number");
      if (childPid === undefined) return;
      const pid = childPid;

      // Child must still be alive before abort (signal 0 is a liveness probe).
      expect(() => {
        process.kill(pid, 0);
      }).not.toThrow();

      controller.abort();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("aborted");
      expect(result.aborted).toBe(true);

      // After runGit returns, the child must be gone. A regression that returns
      // on AbortError before 'close' would leave cat-file --batch still running.
      expect(() => {
        process.kill(pid, 0);
      }).toThrow();
    });

    it("rejects pure register when a conflicted row blocks the same lease and worker", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      const conf = registerIntegration(
        set,
        pendingIntegration({
          status: "conflicted",
          conflict: {
            conflictingPaths: ["src/a.ts"],
            message: "conflict",
          },
        }),
      );
      expect(conf.ok).toBe(true);
      if (!conf.ok) return;
      set = conf.set;
      const again = registerIntegration(
        set,
        pendingIntegration({ integrationId: "int-lease-a-retry" }),
      );
      expect(again.ok).toBe(false);
      if (again.ok) return;
      expect(
        again.diagnostics.some((d) => d.code === "workspace_integration_already_conflicted"),
      ).toBe(true);
    });
  });
});
