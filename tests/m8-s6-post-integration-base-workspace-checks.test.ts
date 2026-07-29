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
  getIntegration,
  isActiveIntegrationStatus,
  isCheckPhaseActiveStatus,
  isIntegrationEligibleForNodeCompletion,
  isPostIntegrateIntegrationStatus,
  isTerminalIntegrationStatus,
  markIntegrationChecking,
  markIntegrationChecksFailed,
  markIntegrationChecksPassed,
  markIntegrationIntegrated,
  markIntegrationIntegrating,
  registerIntegration,
  releaseIntegrationRecord,
  validateWorkspaceIntegration,
  validateWorkspaceIntegrationSetSchema,
  type WorkspaceIntegration,
} from "../src/domain/workspace-integration.js";
import type { WorkspaceLease, WorkspaceLeaseHolder } from "../src/domain/workspace-lease.js";
import {
  POST_INTEGRATION_CHECK_LIST_SCHEMA_VERSION,
  canStartPostIntegrationChecks,
  evaluateNodeCompletionEligibility,
  parsePostIntegrationCheckList,
  requireChecksPassedForNodeCompletion,
  startPostIntegrationChecks,
  validatePostIntegrationCheckList,
} from "../src/domain/workspace-post-integration-checks.js";
import {
  createEmptyWorkspaceWorktreeSet,
  type WorkspaceWorktree,
} from "../src/domain/workspace-worktree.js";
import {
  prepareMutatingAttemptWorktree,
  releaseAttemptWorktree,
} from "../src/workspace/git-worktree.js";
import { integrateWorkerCommit } from "../src/workspace/integrate-worker-commit.js";
import {
  resolveMaxOutputBytes,
  runBaseWorkspaceCheckCommand,
  runPostIntegrationChecks,
} from "../src/workspace/run-post-integration-checks.js";
import { collectWorkerCommitResult } from "../src/workspace/worker-commit.js";

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

const integratedRecord = (
  overrides: Partial<WorkspaceIntegration> = {},
): WorkspaceIntegration => ({
  ...pendingIntegration({
    status: "integrated",
    integratedCommitHash: FULL_HASH_C,
  }),
  ...overrides,
});

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hypagraph-m8-s6-repo-"));
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("m8-s6 post-integration base workspace checks", () => {
  describe("pure domain check list and schema", () => {
    it("rejects unsupported check list schema versions", () => {
      expect(
        validatePostIntegrationCheckList({ checks: [] }).some(
          (d) => d.code === "workspace_post_check_list_unsupported_schema",
        ),
      ).toBe(true);

      expect(
        validatePostIntegrationCheckList({
          schemaVersion: 99,
          checks: [{ id: "a", command: "true" }],
        }).some((d) => d.code === "workspace_post_check_list_unsupported_schema"),
      ).toBe(true);

      expect(
        validatePostIntegrationCheckList({
          schemaVersion: POST_INTEGRATION_CHECK_LIST_SCHEMA_VERSION,
          checks: [{ id: "a", command: "true" }],
        }),
      ).toEqual([]);
    });

    it("rejects non-plain objects for check commands and lists", () => {
      class FakeList {
        schemaVersion = POST_INTEGRATION_CHECK_LIST_SCHEMA_VERSION;
        checks = [{ id: "a", command: "true" }];
      }
      expect(
        validatePostIntegrationCheckList(new FakeList()).some(
          (d) => d.code === "workspace_post_check_list_not_plain_object",
        ),
      ).toBe(true);

      class FakeCheck {
        id = "a";
        command = "true";
      }
      expect(
        validatePostIntegrationCheckList({
          schemaVersion: POST_INTEGRATION_CHECK_LIST_SCHEMA_VERSION,
          checks: [new FakeCheck()],
        }).some((d) => d.code === "workspace_post_check_not_plain_object"),
      ).toBe(true);
    });

    it("rejects empty lists, duplicate ids, and oversized args", () => {
      expect(
        validatePostIntegrationCheckList({
          schemaVersion: POST_INTEGRATION_CHECK_LIST_SCHEMA_VERSION,
          checks: [],
        }).some((d) => d.code === "workspace_post_check_list_empty"),
      ).toBe(true);

      expect(
        validatePostIntegrationCheckList({
          schemaVersion: POST_INTEGRATION_CHECK_LIST_SCHEMA_VERSION,
          checks: [
            { id: "dup", command: "true" },
            { id: "dup", command: "false" },
          ],
        }).some((d) => d.code === "workspace_post_check_duplicate_id"),
      ).toBe(true);

      expect(
        validatePostIntegrationCheckList(
          {
            schemaVersion: POST_INTEGRATION_CHECK_LIST_SCHEMA_VERSION,
            checks: [{ id: "a", command: "echo", args: ["x", "y", "z"] }],
          },
          "checkList",
          { maxArgsPerCheck: 2 },
        ).some((d) => d.code === "workspace_post_check_args_limit"),
      ).toBe(true);
    });

    it("does not mutate check list input when parsing", () => {
      const input = {
        schemaVersion: POST_INTEGRATION_CHECK_LIST_SCHEMA_VERSION,
        checks: [{ id: "a", command: "true", args: ["keep"] }],
      };
      const snapshot = structuredClone(input);
      const parsed = parsePostIntegrationCheckList(input);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      parsed.value.checks[0]!.args!.push("mutated");
      expect(input).toEqual(snapshot);
    });
  });

  describe("pure domain post-integration check lifecycle", () => {
    it("rejects unsupported integration schema and non-plain objects", () => {
      expect(WORKSPACE_INTEGRATION_SCHEMA_VERSION).toBe(2);
      expect(WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION).toBe(2);

      expect(
        validateWorkspaceIntegration({
          ...integratedRecord(),
          schemaVersion: 99,
        }).some((d) => d.code === "workspace_integration_unsupported_schema"),
      ).toBe(true);

      // Version 1 is the pre-m8-s6 shape and must be rejected.
      expect(
        validateWorkspaceIntegration({
          ...integratedRecord(),
          schemaVersion: 1,
        }).some((d) => d.code === "workspace_integration_unsupported_schema"),
      ).toBe(true);

      expect(
        validateWorkspaceIntegrationSetSchema({
          schemaVersion: 1,
          integrations: [],
        }).some((d) => d.code === "workspace_integration_set_unsupported_schema"),
      ).toBe(true);

      class FakeIntegration {
        schemaVersion = WORKSPACE_INTEGRATION_SCHEMA_VERSION;
      }
      expect(
        validateWorkspaceIntegration(new FakeIntegration()).some(
          (d) => d.code === "workspace_integration_not_plain_object",
        ),
      ).toBe(true);
    });

    it("requires non-empty diagnostics for checks_failed on validate/restore", () => {
      const missing = validateWorkspaceIntegration({
        ...integratedRecord({
          status: "checks_failed",
        }),
      });
      expect(
        missing.some((d) => d.code === "workspace_integration_missing_check_diagnostics"),
      ).toBe(true);

      const empty = validateWorkspaceIntegration({
        ...integratedRecord({
          status: "checks_failed",
          diagnostics: [],
        }),
      });
      expect(
        empty.some((d) => d.code === "workspace_integration_missing_check_diagnostics"),
      ).toBe(true);

      const ok = validateWorkspaceIntegration({
        ...integratedRecord({
          status: "checks_failed",
          diagnostics: [{ code: "workspace_post_check_command_failed", message: "fail" }],
        }),
      });
      expect(ok).toEqual([]);
    });

    it("cannot start post-integration checks unless successfully integrated", () => {
      const statuses: Array<WorkspaceIntegration["status"]> = [
        "pending",
        "integrating",
        "conflicted",
        "failed",
        "aborted",
        "released",
      ];

      for (const status of statuses) {
        let set = createEmptyWorkspaceIntegrationSet();
        const base: WorkspaceIntegration = status === "conflicted"
          ? pendingIntegration({
            status: "conflicted",
            conflict: { conflictingPaths: ["src/a.ts"] },
          })
          : status === "failed"
            ? pendingIntegration({
              status: "failed",
              diagnostics: [{ code: "x", message: "y" }],
            })
            : pendingIntegration({ status });
        const reg = registerIntegration(set, base);
        expect(reg.ok).toBe(true);
        if (!reg.ok) return;
        set = reg.set;

        const started = startPostIntegrationChecks(set, "int-lease-a");
        expect(started.ok).toBe(false);
        if (started.ok) return;
        expect(
          started.diagnostics.some(
            (d) =>
              d.code === "workspace_integration_invalid_transition"
              || d.code.startsWith("workspace_integration_already_"),
          ),
        ).toBe(true);
      }
    });

    it("transitions integrated to checking to checks_passed", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      const reg = registerIntegration(set, integratedRecord());
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      set = reg.set;

      expect(isIntegrationEligibleForNodeCompletion(reg.integration)).toBe(false);
      expect(canStartPostIntegrationChecks(reg.integration)).toBe(true);
      expect(isTerminalIntegrationStatus("integrated")).toBe(true);
      expect(isPostIntegrateIntegrationStatus("integrated")).toBe(true);

      const checking = markIntegrationChecking(set, "int-lease-a");
      expect(checking.ok).toBe(true);
      if (!checking.ok) return;
      expect(checking.integration.status).toBe("checking");
      expect(isCheckPhaseActiveStatus("checking")).toBe(true);
      expect(isActiveIntegrationStatus("checking")).toBe(false);
      expect(set.integrations[0]?.status).toBe("integrated");
      set = checking.set;

      expect(isIntegrationEligibleForNodeCompletion(checking.integration)).toBe(false);

      const passed = markIntegrationChecksPassed(set, "int-lease-a");
      expect(passed.ok).toBe(true);
      if (!passed.ok) return;
      expect(passed.integration.status).toBe("checks_passed");
      expect(isIntegrationEligibleForNodeCompletion(passed.integration)).toBe(true);
      expect(isTerminalIntegrationStatus("checks_passed")).toBe(true);

      const eligibility = evaluateNodeCompletionEligibility(passed.set, "int-lease-a");
      expect(eligibility.ok).toBe(true);
      if (!eligibility.ok) return;
      expect(eligibility.eligible).toBe(true);
    });

    it("failed checks block completion and record diagnostics", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      const reg = registerIntegration(set, integratedRecord());
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      const checking = markIntegrationChecking(reg.set, "int-lease-a");
      expect(checking.ok).toBe(true);
      if (!checking.ok) return;

      const failed = markIntegrationChecksFailed(
        checking.set,
        "int-lease-a",
        [{ code: "workspace_post_check_command_failed", message: "typecheck failed." }],
        "typecheck failed.",
      );
      expect(failed.ok).toBe(true);
      if (!failed.ok) return;
      expect(failed.integration.status).toBe("checks_failed");
      expect(failed.integration.diagnostics?.[0]?.code).toBe(
        "workspace_post_check_command_failed",
      );
      expect(isIntegrationEligibleForNodeCompletion(failed.integration)).toBe(false);

      const eligibility = evaluateNodeCompletionEligibility(failed.set, "int-lease-a");
      expect(eligibility.ok).toBe(true);
      if (!eligibility.ok) return;
      expect(eligibility.eligible).toBe(false);
      if (eligibility.eligible) return;
      expect(
        eligibility.diagnostics.some((d) => d.code === "workspace_post_check_not_eligible"),
      ).toBe(true);
    });

    it("rejects stale identity on post-integration check transitions", () => {
      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        integratedRecord(),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const staleLease = markIntegrationChecking(reg.set, "int-lease-a", {
        leaseId: "other-lease",
      });
      expect(staleLease.ok).toBe(false);
      if (staleLease.ok) return;
      expect(
        staleLease.diagnostics.some((d) => d.code === "workspace_integration_stale_identity"),
      ).toBe(true);

      const staleHash = markIntegrationChecking(reg.set, "int-lease-a", {
        workerCommitHash: FULL_HASH_A,
      });
      expect(staleHash.ok).toBe(false);
      if (staleHash.ok) return;
      expect(
        staleHash.diagnostics.some((d) => d.code === "workspace_integration_stale_identity"),
      ).toBe(true);

      const staleIntegrated = markIntegrationChecking(reg.set, "int-lease-a", {
        integratedCommitHash: FULL_HASH_A,
      });
      expect(staleIntegrated.ok).toBe(false);
      if (staleIntegrated.ok) return;
      expect(
        staleIntegrated.diagnostics.some(
          (d) => d.code === "workspace_integration_stale_identity",
        ),
      ).toBe(true);
    });

    it("rejects concurrent checking by default; resume only with allowResume", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      const reg = registerIntegration(set, integratedRecord());
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const first = markIntegrationChecking(reg.set, "int-lease-a");
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      set = first.set;

      expect(canStartPostIntegrationChecks(first.integration)).toBe(false);
      expect(
        canStartPostIntegrationChecks(first.integration, { allowResume: true }),
      ).toBe(true);

      // Concurrent start is rejected while status is checking.
      const second = markIntegrationChecking(set, "int-lease-a");
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(
        second.diagnostics.some(
          (d) => d.code === "workspace_integration_already_checking",
        ),
      ).toBe(true);

      // Crash recovery resume when the caller asserts no host runner is active.
      const resume = markIntegrationChecking(set, "int-lease-a", undefined, {
        allowResume: true,
      });
      expect(resume.ok).toBe(true);
      if (!resume.ok) return;
      expect(resume.integration.status).toBe("checking");

      const passed = markIntegrationChecksPassed(resume.set, "int-lease-a");
      expect(passed.ok).toBe(true);
      if (!passed.ok) return;

      const againPassed = markIntegrationChecksPassed(passed.set, "int-lease-a");
      expect(againPassed.ok).toBe(true);

      const restart = markIntegrationChecking(passed.set, "int-lease-a");
      expect(restart.ok).toBe(false);
      if (restart.ok) return;
      expect(
        restart.diagnostics.some(
          (d) => d.code === "workspace_integration_already_checks_passed",
        ),
      ).toBe(true);
    });

    it("refuses release of checking and checks_passed records", () => {
      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        integratedRecord(),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      const checking = markIntegrationChecking(reg.set, "int-lease-a");
      expect(checking.ok).toBe(true);
      if (!checking.ok) return;

      const releaseChecking = releaseIntegrationRecord(checking.set, "int-lease-a");
      expect(releaseChecking.ok).toBe(false);
      if (releaseChecking.ok) return;
      expect(
        releaseChecking.diagnostics.some(
          (d) => d.code === "workspace_integration_already_integrated",
        ),
      ).toBe(true);

      const passed = markIntegrationChecksPassed(checking.set, "int-lease-a");
      expect(passed.ok).toBe(true);
      if (!passed.ok) return;
      const releasePassed = releaseIntegrationRecord(passed.set, "int-lease-a");
      expect(releasePassed.ok).toBe(false);
    });

    it("completion gate is false until checks pass", () => {
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

      const before = evaluateNodeCompletionEligibility(integrated.set, "int-lease-a");
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      expect(before.eligible).toBe(false);

      const requireBefore = requireChecksPassedForNodeCompletion(
        integrated.set,
        "int-lease-a",
      );
      expect(requireBefore.ok).toBe(false);
      if (requireBefore.ok) return;
      expect(
        requireBefore.diagnostics.some((d) => d.code === "workspace_post_check_not_eligible"),
      ).toBe(true);

      const checking = markIntegrationChecking(integrated.set, "int-lease-a");
      expect(checking.ok).toBe(true);
      if (!checking.ok) return;
      const mid = evaluateNodeCompletionEligibility(checking.set, "int-lease-a");
      expect(mid.ok).toBe(true);
      if (!mid.ok) return;
      expect(mid.eligible).toBe(false);
      expect(requireChecksPassedForNodeCompletion(checking.set, "int-lease-a").ok).toBe(false);

      const passed = markIntegrationChecksPassed(checking.set, "int-lease-a");
      expect(passed.ok).toBe(true);
      if (!passed.ok) return;
      const after = evaluateNodeCompletionEligibility(passed.set, "int-lease-a");
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.eligible).toBe(true);

      const requireAfter = requireChecksPassedForNodeCompletion(passed.set, "int-lease-a");
      expect(requireAfter.ok).toBe(true);
      if (!requireAfter.ok) return;
      expect(requireAfter.integration.status).toBe("checks_passed");
    });

    it("rejects class-instance failure diagnostics without spreading them into plain objects", () => {
      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        integratedRecord(),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      const checking = markIntegrationChecking(reg.set, "int-lease-a");
      expect(checking.ok).toBe(true);
      if (!checking.ok) return;

      class FakeDiagnostic {
        code = "workspace_post_check_command_failed";
        message = "from class";
      }
      const failed = markIntegrationChecksFailed(
        checking.set,
        "int-lease-a",
        [new FakeDiagnostic() as never],
      );
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      expect(
        failed.diagnostics.some(
          (d) => d.code === "workspace_integration_invalid_diagnostics",
        ),
      ).toBe(true);
      expect(checking.set.integrations[0]?.status).toBe("checking");
    });
  });

  describe("host base-workspace checks", () => {
    it("runs check commands with cwd equal to the base repository", async () => {
      const base = await repository();
      const marker = join(base, "check-cwd-marker.txt");
      // Write a script in the base repo that records process.cwd().
      const scriptPath = join(base, "record-cwd.sh");
      await writeFile(
        scriptPath,
        "#!/bin/sh\npwd > check-cwd-marker.txt\n",
        "utf8",
      );
      await run("chmod", ["+x", scriptPath]);

      let set = createEmptyWorkspaceIntegrationSet();
      const reg = registerIntegration(set, integratedRecord({
        integratedCommitHash: await headOf(base),
      }));
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      set = reg.set;

      const result = await runPostIntegrationChecks({
        baseRepoPath: base,
        set,
        integrationId: "int-lease-a",
        checks: [
          {
            id: "record-cwd",
            command: "sh",
            args: [scriptPath],
          },
        ],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.integration.status).toBe("checks_passed");

      const recorded = (await readFile(marker, "utf8")).trim();
      const { realpath } = await import("node:fs/promises");
      const expectedCwd = await realpath(base);
      expect(recorded).toBe(expectedCwd);
    });

    it("successful check path after a real integrate", async () => {
      const base = await repository();
      const baseHead = await headOf(base);
      const lease = exclusiveLease("lease-host", "lease-host", baseHead);
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
      await writeFile(join(worktree.path, "src", "tracked.txt"), "worker change\n", "utf8");
      await run("git", ["add", "src/tracked.txt"], { cwd: worktree.path });
      await run("git", ["commit", "-m", "Worker change"], { cwd: worktree.path });

      const collected = await collectWorkerCommitResult({ worktree });
      expect(collected.ok).toBe(true);
      if (!collected.ok) return;
      expect(collected.value.status).toBe("clean");

      const integrated = await integrateWorkerCommit({
        baseRepoPath: base,
        commit: collected.value,
        lease,
        worktree,
        set: createEmptyWorkspaceIntegrationSet(),
      });
      expect(integrated.ok).toBe(true);
      if (!integrated.ok) return;
      expect(integrated.integration.status).toBe("integrated");

      // Completion must be false before checks.
      const before = evaluateNodeCompletionEligibility(
        integrated.set,
        integrated.integration.integrationId,
      );
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      expect(before.eligible).toBe(false);

      const checked = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: integrated.set,
        integrationId: integrated.integration.integrationId,
        checks: [
          { id: "true", command: "true" },
          {
            id: "verify-content",
            command: "grep",
            args: ["-q", "worker change", "src/tracked.txt"],
          },
        ],
        expected: {
          integrationId: integrated.integration.integrationId,
          leaseId: lease.leaseId,
          workerCommitHash: collected.value.commitHash,
          ...(integrated.integration.integratedCommitHash !== undefined
            ? { integratedCommitHash: integrated.integration.integratedCommitHash }
            : {}),
        },
      });
      expect(checked.ok).toBe(true);
      if (!checked.ok) return;
      expect(checked.integration.status).toBe("checks_passed");
      expect(isIntegrationEligibleForNodeCompletion(checked.integration)).toBe(true);

      const after = evaluateNodeCompletionEligibility(
        checked.set,
        integrated.integration.integrationId,
      );
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.eligible).toBe(true);

      // Idempotent when already checks_passed.
      const again = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: checked.set,
        integrationId: integrated.integration.integrationId,
        checks: [{ id: "true", command: "true" }],
      });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.alreadyPassed).toBe(true);

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: worktreeSet,
        worktreeId: worktree.worktreeId,
      });
    });

    it("failed check command marks checks_failed and blocks completion", async () => {
      const base = await repository();
      let set = createEmptyWorkspaceIntegrationSet();
      const reg = registerIntegration(set, integratedRecord({
        integratedCommitHash: await headOf(base),
      }));
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const result = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: reg.set,
        integrationId: "int-lease-a",
        checks: [
          { id: "pass", command: "true" },
          { id: "fail", command: "false" },
        ],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.integration?.status).toBe("checks_failed");
      expect(
        result.diagnostics.some((d) => d.code === "workspace_post_check_command_failed"),
      ).toBe(true);
      expect(
        result.integration !== undefined
        && isIntegrationEligibleForNodeCompletion(result.integration),
      ).toBe(false);

      const eligibility = evaluateNodeCompletionEligibility(
        result.set,
        "int-lease-a",
      );
      expect(eligibility.ok).toBe(true);
      if (!eligibility.ok) return;
      expect(eligibility.eligible).toBe(false);
    });

    it("rejects host run when integration is not integrated", async () => {
      const base = await repository();
      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        pendingIntegration(),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const result = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: reg.set,
        integrationId: "int-lease-a",
        checks: [{ id: "true", command: "true" }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some((d) => d.code === "workspace_post_check_not_integrated"),
      ).toBe(true);
    });

    it("rejects stale integratedCommitHash on host run", async () => {
      const base = await repository();
      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        integratedRecord({ integratedCommitHash: await headOf(base) }),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const result = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: reg.set,
        integrationId: "int-lease-a",
        checks: [{ id: "true", command: "true" }],
        expected: {
          integratedCommitHash: FULL_HASH_A,
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some((d) => d.code === "workspace_integration_stale_identity"),
      ).toBe(true);
    });

    it("marks checking before commands and rejects concurrent checking without allowResume", async () => {
      const base = await repository();
      let set = createEmptyWorkspaceIntegrationSet();
      const reg = registerIntegration(set, integratedRecord({
        integratedCommitHash: await headOf(base),
      }));
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      let sawChecking = false;
      const result = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: reg.set,
        integrationId: "int-lease-a",
        checks: [{ id: "true", command: "true" }],
        persist: async (nextSet) => {
          const got = getIntegration(nextSet, "int-lease-a");
          expect(got.ok).toBe(true);
          if (!got.ok) return;
          expect(got.integration?.status).toBe("checking");
          sawChecking = true;
        },
      });
      expect(result.ok).toBe(true);
      expect(sawChecking).toBe(true);
      if (!result.ok) return;
      expect(result.integration.status).toBe("checks_passed");

      // Concurrent re-entry from status checking without allowResume is rejected.
      const mid = createEmptyWorkspaceIntegrationSet();
      const midReg = registerIntegration(mid, {
        ...integratedRecord({
          integratedCommitHash: await headOf(base),
          status: "checking",
        }),
      });
      expect(midReg.ok).toBe(true);
      if (!midReg.ok) return;
      const blocked = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: midReg.set,
        integrationId: "int-lease-a",
        checks: [{ id: "true", command: "true" }],
      });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(
        blocked.diagnostics.some(
          (d) => d.code === "workspace_integration_already_checking",
        ),
      ).toBe(true);

      // Crash recovery with allowResume when no host runner is active.
      const resumed = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: midReg.set,
        integrationId: "int-lease-a",
        checks: [{ id: "true", command: "true" }],
        allowResume: true,
      });
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.integration.status).toBe("checks_passed");
    });

    it("rejects a linked worker worktree as baseRepoPath", async () => {
      const base = await repository();
      const baseHead = await headOf(base);
      const lease = exclusiveLease("lease-wt", "lease-wt", baseHead);
      let worktreeSet = createEmptyWorkspaceWorktreeSet();
      const prepared = await prepareMutatingAttemptWorktree({
        baseRepoPath: base,
        lease,
        set: worktreeSet,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      worktreeSet = prepared.set;

      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        integratedRecord({ integratedCommitHash: baseHead }),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const result = await runPostIntegrationChecks({
        baseRepoPath: prepared.worktree.path,
        set: reg.set,
        integrationId: "int-lease-a",
        checks: [{ id: "true", command: "true" }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some(
          (d) => d.code === "workspace_post_check_base_is_linked_worktree",
        ),
      ).toBe(true);

      await releaseAttemptWorktree({
        baseRepoPath: base,
        set: worktreeSet,
        worktreeId: prepared.worktree.worktreeId,
      });
    });

    it("rejects when base HEAD no longer matches integratedCommitHash", async () => {
      const base = await repository();
      const headAtIntegrate = await headOf(base);
      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        integratedRecord({ integratedCommitHash: headAtIntegrate }),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      // Move base HEAD after the integrate identity was recorded.
      await writeFile(join(base, "src", "tracked.txt"), "moved after integrate\n", "utf8");
      await run("git", ["add", "src/tracked.txt"], { cwd: base });
      await run("git", ["commit", "-m", "Move base after integrate"], { cwd: base });
      const movedHead = await headOf(base);
      expect(movedHead).not.toBe(headAtIntegrate);

      const result = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: reg.set,
        integrationId: "int-lease-a",
        checks: [{ id: "true", command: "true" }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some((d) => d.code === "workspace_post_check_stale_base_head"),
      ).toBe(true);
      expect(result.integration?.status).toBe("checks_failed");
    });

    it("waits for child close and force-kills a SIGTERM-ignoring check", async () => {
      const base = await repository();
      const script = join(base, "ignore-term.js");
      await writeFile(
        script,
        [
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );

      const controller = new AbortController();
      const started = Date.now();
      const runPromise = runBaseWorkspaceCheckCommand(
        base,
        {
          id: "ignore-term",
          command: process.execPath,
          args: [script],
          timeoutMs: 30_000,
        },
        {
          signal: controller.signal,
          killGraceMs: 50,
        },
      );

      // Abort after the child process starts.
      await new Promise((r) => setTimeout(r, 100));
      controller.abort();
      const result = await runPromise;
      const elapsed = Date.now() - started;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("aborted");
      // Host must wait for process close. Force kill ends a process that ignores SIGTERM.
      expect(elapsed).toBeLessThan(5_000);
    });

    it("terminates descendant processes when a check is cancelled", async () => {
      // POSIX only: process-group kill. Windows uses taskkill /T separately.
      if (process.platform === "win32") return;

      const base = await repository();
      const pidFile = join(base, "grandchild.pid");
      // Use .cjs so Node loads CommonJS even when the repo package is ESM.
      const script = join(base, "spawn-descendant.cjs");
      await writeFile(
        script,
        [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "const pidPath = process.argv[2];",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {",
          "  stdio: 'ignore',",
          "  detached: false,",
          "});",
          "if (typeof child.pid !== 'number') process.exit(2);",
          "writeFileSync(pidPath, String(child.pid), 'utf8');",
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );

      const controller = new AbortController();
      const runPromise = runBaseWorkspaceCheckCommand(
        base,
        {
          id: "with-descendant",
          command: process.execPath,
          args: [script, pidFile],
          timeoutMs: 30_000,
        },
        {
          signal: controller.signal,
          killGraceMs: 50,
        },
      );

      // Wait until the grandchild pid is written.
      let grandchildPid: number | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const text = await readFile(pidFile, "utf8");
          const parsed = Number(text.trim());
          if (Number.isSafeInteger(parsed) && parsed > 0) {
            grandchildPid = parsed;
            break;
          }
        } catch {
          // not written yet
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(grandchildPid).toBeTypeOf("number");

      controller.abort();
      const result = await runPromise;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("aborted");

      // Descendant must not survive process-group termination.
      await new Promise((r) => setTimeout(r, 150));
      let stillLive = true;
      try {
        process.kill(grandchildPid!, 0);
      } catch {
        stillLive = false;
      }
      expect(stillLive).toBe(false);
    });

    it("force-kills SIGTERM-ignoring grandchild after parent exits on SIGTERM", async () => {
      // Parent exits on SIGTERM; grandchild ignores SIGTERM with independent stdio.
      // Force-kill must still run after the direct child closes.
      if (process.platform === "win32") return;

      const base = await repository();
      const pidFile = join(base, "orphan-grandchild.pid");
      const script = join(base, "parent-exits-on-term.cjs");
      await writeFile(
        script,
        [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "const pidPath = process.argv[2];",
          // Grandchild ignores SIGTERM and does not share parent stdio.
          "const child = spawn(",
          "  process.execPath,",
          "  ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"],",
          "  { stdio: 'ignore', detached: false },",
          ");",
          "if (typeof child.pid !== 'number') process.exit(2);",
          "writeFileSync(pidPath, String(child.pid), 'utf8');",
          // Parent does not ignore SIGTERM: it exits and closes before SIGKILL.
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );

      const controller = new AbortController();
      const runPromise = runBaseWorkspaceCheckCommand(
        base,
        {
          id: "parent-exits-grandchild-stays",
          command: process.execPath,
          args: [script, pidFile],
          timeoutMs: 30_000,
        },
        {
          signal: controller.signal,
          killGraceMs: 80,
        },
      );

      let grandchildPid: number | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const text = await readFile(pidFile, "utf8");
          const parsed = Number(text.trim());
          if (Number.isSafeInteger(parsed) && parsed > 0) {
            grandchildPid = parsed;
            break;
          }
        } catch {
          // not written yet
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(grandchildPid).toBeTypeOf("number");

      controller.abort();
      const result = await runPromise;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe("aborted");

      // After grace-period SIGKILL of the process group, grandchild must be dead.
      await new Promise((r) => setTimeout(r, 50));
      let stillLive = true;
      try {
        process.kill(grandchildPid!, 0);
      } catch {
        stillLive = false;
      }
      expect(stillLive).toBe(false);
    });

    it("does not mutate the input integration set", async () => {
      const base = await repository();
      const set = createEmptyWorkspaceIntegrationSet();
      const reg = registerIntegration(set, integratedRecord({
        integratedCommitHash: await headOf(base),
      }));
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;
      const inputSet = reg.set;
      const snapshot = structuredClone(inputSet);

      const result = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: inputSet,
        integrationId: "int-lease-a",
        checks: [{ id: "true", command: "true" }],
      });
      expect(result.ok).toBe(true);
      expect(inputSet).toEqual(snapshot);
      expect(inputSet.schemaVersion).toBe(WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION);
      if (!result.ok) return;
      expect(result.eligibleForNodeCompletion).toBe(true);
    });

    it("marks checks_failed when a successful check command moves base HEAD", async () => {
      const base = await repository();
      const headBefore = await headOf(base);
      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        integratedRecord({ integratedCommitHash: headBefore }),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const script = join(base, "move-head.sh");
      await writeFile(
        script,
        [
          "#!/bin/sh",
          "echo moved > src/tracked.txt",
          "git add src/tracked.txt",
          "git -c user.email=hypagraph@example.invalid -c user.name=Test commit -m move",
          "exit 0",
        ].join("\n"),
        "utf8",
      );
      await run("chmod", ["+x", script]);

      const result = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: reg.set,
        integrationId: "int-lease-a",
        checks: [{ id: "move-head", command: "sh", args: [script] }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.eligibleForNodeCompletion).toBe(false);
      expect(result.integration?.status).toBe("checks_failed");
      expect(
        result.diagnostics.some((d) => d.code === "workspace_post_check_stale_base_head"),
      ).toBe(true);
      expect(await headOf(base)).not.toBe(headBefore);
      expect(requireChecksPassedForNodeCompletion(result.set, "int-lease-a").ok).toBe(false);
    });

    it("marks checks_failed when a successful check dirties tracked files without moving HEAD", async () => {
      const base = await repository();
      const headBefore = await headOf(base);
      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        integratedRecord({ integratedCommitHash: headBefore }),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const script = join(base, "dirty-tracked.sh");
      await writeFile(
        script,
        [
          "#!/bin/sh",
          "echo dirty-without-commit > src/tracked.txt",
          "exit 0",
        ].join("\n"),
        "utf8",
      );
      await run("chmod", ["+x", script]);

      const result = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: reg.set,
        integrationId: "int-lease-a",
        checks: [{ id: "dirty-tracked", command: "sh", args: [script] }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.eligibleForNodeCompletion).toBe(false);
      expect(result.integration?.status).toBe("checks_failed");
      expect(
        result.diagnostics.some((d) => d.code === "workspace_post_check_base_dirty"),
      ).toBe(true);
      // HEAD still matches; dirty tracked files alone must fail the gate.
      expect(await headOf(base)).toBe(headBefore);
      expect(requireChecksPassedForNodeCompletion(result.set, "int-lease-a").ok).toBe(false);
    });

    it("rejects class-instance and non-string expected identity without throwing", async () => {
      const base = await repository();
      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        integratedRecord({ integratedCommitHash: await headOf(base) }),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      class FakeExpected {
        leaseId = "lease-a";
      }
      const classResult = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: reg.set,
        integrationId: "int-lease-a",
        checks: [{ id: "true", command: "true" }],
        expected: new FakeExpected() as never,
      });
      expect(classResult.ok).toBe(false);
      if (classResult.ok) return;
      expect(classResult.eligibleForNodeCompletion).toBe(false);
      expect(
        classResult.diagnostics.some(
          (d) => d.code === "workspace_integration_invalid_expected_identity",
        ),
      ).toBe(true);

      const badField = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: reg.set,
        integrationId: "int-lease-a",
        checks: [{ id: "true", command: "true" }],
        expected: { integratedCommitHash: 12345 } as never,
      });
      expect(badField.ok).toBe(false);
      if (badField.ok) return;
      expect(
        badField.diagnostics.some(
          (d) => d.code === "workspace_integration_invalid_expected_identity",
        ),
      ).toBe(true);
    });

    it("enforces a shared maxOutputBytes limit and rejects invalid bounds", async () => {
      expect(resolveMaxOutputBytes(-1).ok).toBe(false);
      expect(resolveMaxOutputBytes(1.5).ok).toBe(false);
      expect(resolveMaxOutputBytes(Number.NaN).ok).toBe(false);
      expect(resolveMaxOutputBytes(64).ok).toBe(true);

      const base = await repository();
      const invalidHost = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: createEmptyWorkspaceIntegrationSet(),
        integrationId: "missing",
        checks: [{ id: "true", command: "true" }],
        maxOutputBytes: -10,
      });
      expect(invalidHost.ok).toBe(false);
      if (invalidHost.ok) return;
      expect(
        invalidHost.diagnostics.some(
          (d) => d.code === "workspace_post_check_invalid_max_output_bytes",
        ),
      ).toBe(true);

      // Combined stdout+stderr must not exceed the limit (shared counter).
      const script = join(base, "both-streams.js");
      await writeFile(
        script,
        [
          "process.stdout.write('A'.repeat(40));",
          "process.stderr.write('B'.repeat(40));",
        ].join("\n"),
        "utf8",
      );
      const captured = await runBaseWorkspaceCheckCommand(
        base,
        {
          id: "both",
          command: process.execPath,
          args: [script],
        },
        { maxOutputBytes: 50 },
      );
      expect(captured.ok).toBe(true);
      if (!captured.ok) return;
      const total =
        Buffer.byteLength(captured.stdout, "utf8")
        + Buffer.byteLength(captured.stderr, "utf8");
      expect(total).toBeLessThanOrEqual(50);
      // Without a shared limit, each stream could keep 50 (100 total).
      expect(total).toBeLessThan(80);
    });

    it("host success exposes eligibleForNodeCompletion only for checks_passed", async () => {
      const base = await repository();
      const reg = registerIntegration(
        createEmptyWorkspaceIntegrationSet(),
        integratedRecord({ integratedCommitHash: await headOf(base) }),
      );
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const ok = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: reg.set,
        integrationId: "int-lease-a",
        checks: [{ id: "true", command: "true" }],
      });
      expect(ok.ok).toBe(true);
      if (!ok.ok) return;
      expect(ok.eligibleForNodeCompletion).toBe(true);
      expect(ok.integration.status).toBe("checks_passed");
      expect(requireChecksPassedForNodeCompletion(ok.set, "int-lease-a").ok).toBe(true);

      // Host does not mutate the input set. Status on reg.set remains integrated.
      // A new run from that input set starts post-integration checks again.
      const fail = await runPostIntegrationChecks({
        baseRepoPath: base,
        set: reg.set,
        integrationId: "int-lease-a",
        checks: [{ id: "false", command: "false" }],
      });
      expect(fail.ok).toBe(false);
      if (fail.ok) return;
      expect(fail.eligibleForNodeCompletion).toBe(false);
      expect(fail.integration?.status).toBe("checks_failed");
    });
  });
});
