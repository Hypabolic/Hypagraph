import { describe, expect, it } from "vitest";

import {
  CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
  admitGroupAttempt,
  createEmptyConcurrencyGroupState,
  listConcurrencyGroupActiveAttempts,
  type ConcurrencyGroupState,
} from "../src/domain/concurrency-groups.js";
import {
  CONCURRENCY_STATE_SCHEMA_VERSION,
  admitAttempt,
  createEmptyConcurrencyState,
  listConcurrencyActiveAttempts,
  type ConcurrencyState,
} from "../src/domain/concurrency-limits.js";
import {
  WORKER_COMMIT_RESULT_SCHEMA_VERSION,
  type WorkerCommitResult,
} from "../src/domain/workspace-commit.js";
import {
  WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
  applyWorkspaceCrashRecovery,
  canApplyIntegrationSuccessResult,
  classifyAttemptLiveness,
  collectWorkspaceAttemptIds,
  excludeOrphanAttemptIds,
  liveAttemptIdsFromLiveness,
  planWorkspaceCrashRecovery,
  rejectLateSuccessForCancelledAttempt,
  rejectLateWorkerCommitForCancelledAttempt,
  rejectStaleIntegrationOrCommitSuccess,
  validateWorkspaceCrashRecoveryInputSchema,
  validateWorkspaceCrashRecoveryPlanSchema,
  type WorkspaceCrashRecoveryInput,
} from "../src/domain/workspace-crash-recovery.js";
import {
  WORKSPACE_INTEGRATION_SCHEMA_VERSION,
  WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION,
  createEmptyWorkspaceIntegrationSet,
  getIntegration,
  markIntegrationAborted,
  markIntegrationChecking,
  markIntegrationIntegrated,
  markIntegrationIntegrating,
  registerIntegration,
  type WorkspaceIntegration,
  type WorkspaceIntegrationSet,
} from "../src/domain/workspace-integration.js";
import {
  WORKSPACE_LEASE_SET_SCHEMA_VERSION,
  acquireWorkspaceLease,
  createEmptyWorkspaceLeaseSet,
  listWorkspaceLeases,
  type WorkspaceLease,
  type WorkspaceLeaseHolder,
  type WorkspaceLeaseSet,
} from "../src/domain/workspace-lease.js";
import {
  WORKSPACE_WORKTREE_SET_SCHEMA_VERSION,
  createEmptyWorkspaceWorktreeSet,
  listActiveWorktrees,
  registerWorktree,
  type WorkspaceWorktree,
  type WorkspaceWorktreeSet,
} from "../src/domain/workspace-worktree.js";
import {
  reconcileWorkspaceAfterCrash,
  resolveLiveAttemptIdsForCrashRecovery,
} from "../src/workspace/reconcile-workspace-after-crash.js";

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
  writePath = "src",
): WorkspaceLease => ({
  leaseId,
  mode: "exclusive",
  holder: holder(attemptId),
  paths: {
    readPaths: [writePath],
    writePaths: [writePath],
  },
  baseRevision: FULL_HASH_A,
});

const readyWorktree = (
  worktreeId: string,
  leaseId: string,
  attemptId = leaseId,
): WorkspaceWorktree => ({
  worktreeId,
  leaseId,
  holder: holder(attemptId),
  path: `/tmp/wt-${worktreeId}`,
  baseRevision: FULL_HASH_A,
  status: "ready",
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

const workerCommit = (
  overrides: Partial<WorkerCommitResult> = {},
): WorkerCommitResult => ({
  schemaVersion: WORKER_COMMIT_RESULT_SCHEMA_VERSION,
  leaseId: "lease-a",
  worktreeId: "wt-lease-a",
  holder: holder("lease-a"),
  commitHash: FULL_HASH_B,
  baseRevision: FULL_HASH_A,
  changedPaths: ["src/domain/workspace-crash-recovery.ts"],
  status: "clean",
  headAdvanced: true,
  ...overrides,
});

function acquireTwoLeases(): WorkspaceLeaseSet {
  const empty = createEmptyWorkspaceLeaseSet();
  const first = acquireWorkspaceLease(
    empty,
    exclusiveLease("lease-live", "attempt-live", "src/live"),
  );
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("acquire live failed");
  const second = acquireWorkspaceLease(
    first.set,
    exclusiveLease("lease-dead", "attempt-dead", "src/dead"),
  );
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error("acquire dead failed");
  return second.set;
}

function registerTwoWorktrees(set: WorkspaceWorktreeSet = createEmptyWorkspaceWorktreeSet()):
  WorkspaceWorktreeSet {
  const first = registerWorktree(
    set,
    readyWorktree("wt-live", "lease-live", "attempt-live"),
  );
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("register live worktree failed");
  const second = registerWorktree(
    first.set,
    readyWorktree("wt-dead", "lease-dead", "attempt-dead"),
  );
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error("register dead worktree failed");
  return second.set;
}

function registerIntegrating(
  integration: WorkspaceIntegration,
  set: WorkspaceIntegrationSet = createEmptyWorkspaceIntegrationSet(),
): WorkspaceIntegrationSet {
  const registered = registerIntegration(set, integration);
  expect(registered.ok).toBe(true);
  if (!registered.ok) throw new Error("register integration failed");
  if (integration.status === "pending") return registered.set;
  if (integration.status === "integrating") {
    const marked = markIntegrationIntegrating(registered.set, integration.integrationId);
    expect(marked.ok).toBe(true);
    if (!marked.ok) throw new Error("mark integrating failed");
    return marked.set;
  }
  return registered.set;
}

describe("m8-s10 cancellation crash recovery stale integration", () => {
  describe("crash recovery releases dead leases and keeps live holders", () => {
    it("releases leases for dead attempt holders and leaves live holders intact", () => {
      const leaseSet = acquireTwoLeases();
      const before = structuredClone(leaseSet);

      const recovered = applyWorkspaceCrashRecovery({
        schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet,
        liveAttemptIds: ["attempt-live"],
      });

      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;

      expect(recovered.plan.deadAttemptIds).toEqual(["attempt-dead"]);
      expect(recovered.plan.liveAttemptIds).toEqual(["attempt-live"]);
      expect(recovered.plan.releasedLeaseIds).toEqual(["lease-dead"]);

      const listed = listWorkspaceLeases(recovered.leaseSet);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.leases.map((item) => item.leaseId)).toEqual(["lease-live"]);
      expect(listed.leases[0]?.holder.attemptId).toBe("attempt-live");

      // Input not mutated.
      expect(leaseSet).toEqual(before);
      expect(listWorkspaceLeases(leaseSet).ok && listWorkspaceLeases(leaseSet)).toMatchObject({
        ok: true,
      });
      const originalListed = listWorkspaceLeases(leaseSet);
      expect(originalListed.ok).toBe(true);
      if (!originalListed.ok) return;
      expect(originalListed.leases.map((item) => item.leaseId).sort()).toEqual([
        "lease-dead",
        "lease-live",
      ]);
    });
  });

  describe("stale integration transitions", () => {
    it("rejects wrong attempt, lease, worktree, or revision identity without changing the set", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      set = registerIntegrating(pendingIntegration({
        integrationId: "int-lease-a",
        leaseId: "lease-a",
        worktreeId: "wt-lease-a",
        holder: holder("lease-a"),
        status: "pending",
      }), set);
      const integrating = markIntegrationIntegrating(set, "int-lease-a");
      expect(integrating.ok).toBe(true);
      if (!integrating.ok) return;
      set = integrating.set;
      const before = structuredClone(set);

      const wrongAttempt = markIntegrationIntegrated(
        set,
        "int-lease-a",
        FULL_HASH_C,
        { holder: holder("other-attempt") },
      );
      expect(wrongAttempt.ok).toBe(false);
      if (wrongAttempt.ok) return;
      expect(wrongAttempt.diagnostics.some((d) => d.code === "workspace_integration_stale_identity"))
        .toBe(true);

      const wrongLease = markIntegrationIntegrated(
        set,
        "int-lease-a",
        FULL_HASH_C,
        { leaseId: "lease-other" },
      );
      expect(wrongLease.ok).toBe(false);
      if (wrongLease.ok) return;
      expect(wrongLease.diagnostics.some((d) => d.code === "workspace_integration_stale_identity"))
        .toBe(true);

      const wrongWorktree = markIntegrationIntegrated(
        set,
        "int-lease-a",
        FULL_HASH_C,
        { worktreeId: "wt-other" },
      );
      expect(wrongWorktree.ok).toBe(false);
      if (wrongWorktree.ok) return;
      expect(wrongWorktree.diagnostics.some((d) => d.code === "workspace_integration_stale_identity"))
        .toBe(true);

      const wrongRevision = markIntegrationIntegrated(
        set,
        "int-lease-a",
        FULL_HASH_C,
        { baseRevision: FULL_HASH_C },
      );
      expect(wrongRevision.ok).toBe(false);
      if (wrongRevision.ok) return;
      expect(wrongRevision.diagnostics.some((d) => d.code === "workspace_integration_stale_identity"))
        .toBe(true);

      expect(set).toEqual(before);
      const still = getIntegration(set, "int-lease-a");
      expect(still.ok).toBe(true);
      if (!still.ok) return;
      expect(still.integration?.status).toBe("integrating");
    });
  });

  describe("cancelled attempt late success", () => {
    it("rejects a late success after cancel or abort and does not change the set", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      set = registerIntegrating(pendingIntegration({
        status: "pending",
        holder: holder("attempt-cancel"),
        leaseId: "lease-a",
        integrationId: "int-cancel",
      }), set);
      const aborted = markIntegrationAborted(
        set,
        "int-cancel",
        "Caller cancelled the attempt.",
      );
      expect(aborted.ok).toBe(true);
      if (!aborted.ok) return;
      set = aborted.set;
      const before = structuredClone(set);

      const late = markIntegrationIntegrated(
        set,
        "int-cancel",
        FULL_HASH_C,
      );
      expect(late.ok).toBe(false);
      if (late.ok) return;
      expect(late.diagnostics.some((d) =>
        d.code === "workspace_integration_already_terminal"
        || d.code === "workspace_integration_stale_success"
        || d.code === "workspace_integration_invalid_transition"
      )).toBe(true);

      const integration = getIntegration(set, "int-cancel");
      expect(integration.ok).toBe(true);
      if (!integration.ok || !integration.integration) return;

      const cancelledGate = rejectLateSuccessForCancelledAttempt(
        integration.integration,
        ["attempt-cancel"],
      );
      expect(cancelledGate.some((d) =>
        d.code === "workspace_integration_cancelled_stale_success"
      )).toBe(true);

      const successGate = canApplyIntegrationSuccessResult(integration.integration);
      expect(successGate.ok).toBe(false);

      const commitGate = rejectLateWorkerCommitForCancelledAttempt(
        workerCommit({ holder: holder("attempt-cancel") }),
        ["attempt-cancel"],
      );
      expect(commitGate.some((d) =>
        d.code === "workspace_commit_cancelled_stale_success"
      )).toBe(true);

      const combined = rejectStaleIntegrationOrCommitSuccess({
        integration: integration.integration,
        cancelledAttemptIds: ["attempt-cancel"],
        workerCommit: workerCommit({ holder: holder("attempt-cancel") }),
      });
      expect(combined.length).toBeGreaterThan(0);

      expect(set).toEqual(before);
      expect(integration.integration.status).toBe("aborted");
    });

    it("rejects late success while status is still integrating when attempt is cancelled", () => {
      let set = createEmptyWorkspaceIntegrationSet();
      set = registerIntegrating(pendingIntegration({
        status: "pending",
        holder: holder("attempt-cancel"),
        leaseId: "lease-a",
        integrationId: "int-still-integrating",
      }), set);
      const integrating = markIntegrationIntegrating(set, "int-still-integrating");
      expect(integrating.ok).toBe(true);
      if (!integrating.ok) return;
      set = integrating.set;
      const before = structuredClone(set);

      const late = markIntegrationIntegrated(
        set,
        "int-still-integrating",
        FULL_HASH_C,
        undefined,
        { cancelledAttemptIds: ["attempt-cancel"] },
      );
      expect(late.ok).toBe(false);
      if (late.ok) return;
      expect(late.diagnostics.some((d) =>
        d.code === "workspace_integration_cancelled_stale_success"
      )).toBe(true);
      expect(set).toEqual(before);
      const still = getIntegration(set, "int-still-integrating");
      expect(still.ok).toBe(true);
      if (!still.ok) return;
      expect(still.integration?.status).toBe("integrating");
    });

    it("marks cancelled dead pending integrations aborted during recovery", () => {
      const leaseSet = acquireWorkspaceLease(
        createEmptyWorkspaceLeaseSet(),
        exclusiveLease("lease-a", "attempt-cancel"),
      );
      expect(leaseSet.ok).toBe(true);
      if (!leaseSet.ok) return;

      let integrations = createEmptyWorkspaceIntegrationSet();
      integrations = registerIntegrating(pendingIntegration({
        integrationId: "int-cancel",
        leaseId: "lease-a",
        worktreeId: "wt-lease-a",
        holder: holder("attempt-cancel"),
        status: "pending",
      }), integrations);

      const recovered = applyWorkspaceCrashRecovery({
        schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet: leaseSet.set,
        integrationSet: integrations,
        liveAttemptIds: [],
        cancelledAttemptIds: ["attempt-cancel"],
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;
      expect(recovered.plan.abortedIntegrationIds).toEqual(["int-cancel"]);
      expect(recovered.integrationSet).toBeDefined();
      const item = getIntegration(recovered.integrationSet!, "int-cancel");
      expect(item.ok).toBe(true);
      if (!item.ok) return;
      expect(item.integration?.status).toBe("aborted");
    });

    it("aborts live cancelled integrating with or without resume flags and never resumes", () => {
      const leaseSet = acquireWorkspaceLease(
        createEmptyWorkspaceLeaseSet(),
        exclusiveLease("lease-a", "attempt-live-cancel"),
      );
      expect(leaseSet.ok).toBe(true);
      if (!leaseSet.ok) return;

      let integrations = createEmptyWorkspaceIntegrationSet();
      integrations = registerIntegrating(pendingIntegration({
        integrationId: "int-live-cancel",
        leaseId: "lease-a",
        holder: holder("attempt-live-cancel"),
        status: "pending",
      }), integrations);
      const integrating = markIntegrationIntegrating(integrations, "int-live-cancel");
      expect(integrating.ok).toBe(true);
      if (!integrating.ok) return;

      for (const resume of [false, true] as const) {
        const recovered = applyWorkspaceCrashRecovery({
          schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
          leaseSet: leaseSet.set,
          integrationSet: integrating.set,
          liveAttemptIds: ["attempt-live-cancel"],
          cancelledAttemptIds: ["attempt-live-cancel"],
          resumeLiveIntegrating: resume,
        });
        expect(recovered.ok).toBe(true);
        if (!recovered.ok) return;
        expect(recovered.plan.abortedIntegrationIds).toEqual(["int-live-cancel"]);
        expect(recovered.plan.resumeIntegrateIds).toEqual([]);
        expect(recovered.plan.hostActions.some((a) => a.kind === "resume_integrate")).toBe(false);
        const item = getIntegration(recovered.integrationSet!, "int-live-cancel");
        expect(item.ok).toBe(true);
        if (!item.ok) return;
        expect(item.integration?.status).toBe("aborted");
      }
    });

    it("fails live cancelled checking without resume host action", () => {
      const leaseSet = acquireWorkspaceLease(
        createEmptyWorkspaceLeaseSet(),
        exclusiveLease("lease-a", "attempt-live-cancel"),
      );
      expect(leaseSet.ok).toBe(true);
      if (!leaseSet.ok) return;

      let integrations = createEmptyWorkspaceIntegrationSet();
      integrations = registerIntegrating(pendingIntegration({
        integrationId: "int-check-cancel",
        leaseId: "lease-a",
        holder: holder("attempt-live-cancel"),
        status: "pending",
      }), integrations);
      const integrating = markIntegrationIntegrating(integrations, "int-check-cancel");
      expect(integrating.ok).toBe(true);
      if (!integrating.ok) return;
      const integrated = markIntegrationIntegrated(
        integrating.set,
        "int-check-cancel",
        FULL_HASH_C,
      );
      expect(integrated.ok).toBe(true);
      if (!integrated.ok) return;
      const checking = markIntegrationChecking(integrated.set, "int-check-cancel");
      expect(checking.ok).toBe(true);
      if (!checking.ok) return;

      for (const resume of [false, true] as const) {
        const recovered = applyWorkspaceCrashRecovery({
          schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
          leaseSet: leaseSet.set,
          integrationSet: checking.set,
          liveAttemptIds: ["attempt-live-cancel"],
          cancelledAttemptIds: ["attempt-live-cancel"],
          resumeLiveChecking: resume,
        });
        expect(recovered.ok).toBe(true);
        if (!recovered.ok) return;
        expect(recovered.plan.checksFailedIntegrationIds).toEqual(["int-check-cancel"]);
        expect(recovered.plan.resumeCheckingIds).toEqual([]);
        expect(recovered.plan.hostActions.some((a) =>
          a.kind === "resume_post_integration_checks"
        )).toBe(false);
        const item = getIntegration(recovered.integrationSet!, "int-check-cancel");
        expect(item.ok).toBe(true);
        if (!item.ok) return;
        expect(item.integration?.status).toBe("checks_failed");
      }
    });
  });

  describe("in-flight integrating and checking recovery", () => {
    it("does not invent success for dead integrating or checking records", () => {
      const leaseSet = acquireTwoLeases();

      let integrations = createEmptyWorkspaceIntegrationSet();
      const pendingA = pendingIntegration({
        integrationId: "int-dead-integrating",
        leaseId: "lease-dead",
        worktreeId: "wt-dead",
        holder: holder("attempt-dead"),
        status: "pending",
      });
      integrations = registerIntegrating(pendingA, integrations);
      const toIntegrating = markIntegrationIntegrating(
        integrations,
        "int-dead-integrating",
      );
      expect(toIntegrating.ok).toBe(true);
      if (!toIntegrating.ok) return;
      integrations = toIntegrating.set;

      const pendingB = pendingIntegration({
        integrationId: "int-dead-checking",
        leaseId: "lease-live",
        worktreeId: "wt-live",
        holder: holder("attempt-checking"),
        status: "pending",
        workerCommitHash: FULL_HASH_B,
      });
      // Separate holder for checking path: use a third lease with a distinct path.
      const withThird = acquireWorkspaceLease(
        leaseSet,
        exclusiveLease("lease-checking", "attempt-checking", "src/checking"),
      );
      expect(withThird.ok).toBe(true);
      if (!withThird.ok) return;

      integrations = registerIntegrating({
        ...pendingB,
        leaseId: "lease-checking",
        worktreeId: "wt-checking",
      }, integrations);
      const toIntegratingB = markIntegrationIntegrating(
        integrations,
        "int-dead-checking",
      );
      expect(toIntegratingB.ok).toBe(true);
      if (!toIntegratingB.ok) return;
      const toIntegrated = markIntegrationIntegrated(
        toIntegratingB.set,
        "int-dead-checking",
        FULL_HASH_C,
      );
      expect(toIntegrated.ok).toBe(true);
      if (!toIntegrated.ok) return;
      const toChecking = markIntegrationChecking(
        toIntegrated.set,
        "int-dead-checking",
      );
      expect(toChecking.ok).toBe(true);
      if (!toChecking.ok) return;
      integrations = toChecking.set;

      const recovered = applyWorkspaceCrashRecovery({
        schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet: withThird.set,
        integrationSet: integrations,
        liveAttemptIds: [],
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;

      expect(recovered.integrationSet).toBeDefined();
      const deadIntegrating = getIntegration(
        recovered.integrationSet!,
        "int-dead-integrating",
      );
      expect(deadIntegrating.ok).toBe(true);
      if (!deadIntegrating.ok) return;
      expect(deadIntegrating.integration?.status).toBe("failed");
      expect(recovered.plan.failedIntegrationIds).toContain("int-dead-integrating");

      const deadChecking = getIntegration(
        recovered.integrationSet!,
        "int-dead-checking",
      );
      expect(deadChecking.ok).toBe(true);
      if (!deadChecking.ok) return;
      expect(deadChecking.integration?.status).toBe("checks_failed");
      expect(recovered.plan.checksFailedIntegrationIds).toContain("int-dead-checking");

      // Never invented success.
      expect(deadIntegrating.integration?.status).not.toBe("integrated");
      expect(deadChecking.integration?.status).not.toBe("checks_passed");
    });

    it("keeps live integrating or checking only when resume flags request evidence-based resume", () => {
      const leaseSet = acquireWorkspaceLease(
        createEmptyWorkspaceLeaseSet(),
        exclusiveLease("lease-a", "attempt-live"),
      );
      expect(leaseSet.ok).toBe(true);
      if (!leaseSet.ok) return;

      let integrations = createEmptyWorkspaceIntegrationSet();
      integrations = registerIntegrating(pendingIntegration({
        integrationId: "int-live",
        leaseId: "lease-a",
        holder: holder("attempt-live"),
        status: "pending",
      }), integrations);
      const integrating = markIntegrationIntegrating(integrations, "int-live");
      expect(integrating.ok).toBe(true);
      if (!integrating.ok) return;

      const withoutResume = applyWorkspaceCrashRecovery({
        schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet: leaseSet.set,
        integrationSet: integrating.set,
        liveAttemptIds: ["attempt-live"],
        resumeLiveIntegrating: false,
      });
      expect(withoutResume.ok).toBe(true);
      if (!withoutResume.ok) return;
      const failedItem = getIntegration(withoutResume.integrationSet!, "int-live");
      expect(failedItem.ok && failedItem.integration?.status).toBe("failed");

      const withResume = applyWorkspaceCrashRecovery({
        schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet: leaseSet.set,
        integrationSet: integrating.set,
        liveAttemptIds: ["attempt-live"],
        resumeLiveIntegrating: true,
      });
      expect(withResume.ok).toBe(true);
      if (!withResume.ok) return;
      const resumed = getIntegration(withResume.integrationSet!, "int-live");
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.integration?.status).toBe("integrating");
      expect(withResume.plan.resumeIntegrateIds).toEqual(["int-live"]);
      expect(withResume.plan.hostActions.some((a) => a.kind === "resume_integrate")).toBe(true);
    });

    it("keeps live checking only when resumeLiveChecking requests evidence-based resume", () => {
      const leaseSet = acquireWorkspaceLease(
        createEmptyWorkspaceLeaseSet(),
        exclusiveLease("lease-a", "attempt-live"),
      );
      expect(leaseSet.ok).toBe(true);
      if (!leaseSet.ok) return;

      let integrations = createEmptyWorkspaceIntegrationSet();
      integrations = registerIntegrating(pendingIntegration({
        integrationId: "int-check-live",
        leaseId: "lease-a",
        holder: holder("attempt-live"),
        status: "pending",
      }), integrations);
      const integrating = markIntegrationIntegrating(integrations, "int-check-live");
      expect(integrating.ok).toBe(true);
      if (!integrating.ok) return;
      const integrated = markIntegrationIntegrated(
        integrating.set,
        "int-check-live",
        FULL_HASH_C,
      );
      expect(integrated.ok).toBe(true);
      if (!integrated.ok) return;
      const checking = markIntegrationChecking(integrated.set, "int-check-live");
      expect(checking.ok).toBe(true);
      if (!checking.ok) return;

      const withoutResume = applyWorkspaceCrashRecovery({
        schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet: leaseSet.set,
        integrationSet: checking.set,
        liveAttemptIds: ["attempt-live"],
        resumeLiveChecking: false,
      });
      expect(withoutResume.ok).toBe(true);
      if (!withoutResume.ok) return;
      const failedItem = getIntegration(withoutResume.integrationSet!, "int-check-live");
      expect(failedItem.ok && failedItem.integration?.status).toBe("checks_failed");
      expect(withoutResume.plan.resumeCheckingIds).toEqual([]);

      const withResume = applyWorkspaceCrashRecovery({
        schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet: leaseSet.set,
        integrationSet: checking.set,
        liveAttemptIds: ["attempt-live"],
        resumeLiveChecking: true,
      });
      expect(withResume.ok).toBe(true);
      if (!withResume.ok) return;
      const resumed = getIntegration(withResume.integrationSet!, "int-check-live");
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.integration?.status).toBe("checking");
      expect(withResume.plan.resumeCheckingIds).toEqual(["int-check-live"]);
      expect(withResume.plan.hostActions.some((a) =>
        a.kind === "resume_post_integration_checks"
      )).toBe(true);
    });
  });

  describe("child-process teardown composition", () => {
    it("composes mock liveness and orphan inputs without mutating unrelated leases", () => {
      const leaseSet = acquireTwoLeases();
      const worktreeSet = registerTwoWorktrees();
      const beforeLeases = structuredClone(leaseSet);
      const beforeWorktrees = structuredClone(worktreeSet);

      const liveFromProbe = liveAttemptIdsFromLiveness([
        { attemptId: "attempt-live", live: true },
        { attemptId: "attempt-dead", live: false },
        { attemptId: "attempt-orphan", live: true },
      ]);
      expect(liveFromProbe).toEqual(["attempt-live", "attempt-orphan"]);

      const afterOrphans = excludeOrphanAttemptIds(liveFromProbe, ["attempt-orphan"]);
      expect(afterOrphans).toEqual(["attempt-live"]);

      const recovered = reconcileWorkspaceAfterCrash({
        schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet,
        worktreeSet,
        processLiveness: [
          { attemptId: "attempt-live", live: true },
          { attemptId: "attempt-dead", live: false },
        ],
        orphanAttemptIds: ["attempt-dead"],
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;

      const listed = listWorkspaceLeases(recovered.leaseSet);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.leases.map((item) => item.leaseId)).toEqual(["lease-live"]);

      expect(recovered.worktreeSet).toBeDefined();
      const activeWt = listActiveWorktrees(recovered.worktreeSet!);
      expect(activeWt.ok).toBe(true);
      if (!activeWt.ok) return;
      expect(activeWt.worktrees.map((item) => item.worktreeId)).toEqual(["wt-live"]);

      expect(recovered.plan.hostActions.some((a) =>
        a.kind === "teardown_child_attempt" && a.attemptId === "attempt-dead"
      )).toBe(true);
      expect(recovered.plan.hostActions.some((a) =>
        a.kind === "release_worktree_disk" && a.worktreeId === "wt-dead"
      )).toBe(true);

      // Unrelated input objects stay intact.
      expect(leaseSet).toEqual(beforeLeases);
      expect(worktreeSet).toEqual(beforeWorktrees);
    });

    it("resolveLiveAttemptIdsForCrashRecovery prefers orphan exclusion", () => {
      const resolved = resolveLiveAttemptIdsForCrashRecovery({
        liveAttemptIds: ["attempt-a", "attempt-b"],
        orphanAttemptIds: ["attempt-b"],
      });
      expect(resolved).toEqual(["attempt-a"]);
    });
  });

  describe("purity and schema version", () => {
    it("pure helpers do not mutate inputs", () => {
      const leaseSet = acquireTwoLeases();
      const worktreeSet = registerTwoWorktrees();
      const concurrency = createEmptyConcurrencyState();
      const admitted = admitAttempt(concurrency, {
        attemptId: "attempt-dead",
        executorKind: "isolated-pi",
      });
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;

      const input: WorkspaceCrashRecoveryInput = {
        schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet,
        worktreeSet,
        concurrencyState: admitted.state,
        liveAttemptIds: ["attempt-live"],
      };
      const frozen = structuredClone(input);

      const planned = planWorkspaceCrashRecovery(input);
      expect(planned.ok).toBe(true);
      const applied = applyWorkspaceCrashRecovery(input);
      expect(applied.ok).toBe(true);

      expect(input).toEqual(frozen);
      expect(leaseSet.leases.length).toBe(2);
      expect(worktreeSet.worktrees.filter((w) => w.status === "ready").length).toBe(2);
      expect(admitted.state.attempts.length).toBe(1);
    });

    it("rejects unsupported crash recovery schema versions clearly", () => {
      const planDiagnostics = validateWorkspaceCrashRecoveryPlanSchema({
        schemaVersion: 99,
        deadAttemptIds: [],
      });
      expect(planDiagnostics.some((d) =>
        d.code === "workspace_crash_recovery_plan_unsupported_schema"
      )).toBe(true);
      expect(planDiagnostics[0]?.message).toMatch(/Expected 1/);

      const inputDiagnostics = validateWorkspaceCrashRecoveryInputSchema({
        schemaVersion: 0,
        leaseSet: createEmptyWorkspaceLeaseSet(),
        liveAttemptIds: [],
      });
      expect(inputDiagnostics.some((d) =>
        d.code === "workspace_crash_recovery_input_unsupported_schema"
      )).toBe(true);

      const applied = applyWorkspaceCrashRecovery({
        schemaVersion: 2 as unknown as typeof WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet: createEmptyWorkspaceLeaseSet(),
        liveAttemptIds: [],
      });
      expect(applied.ok).toBe(false);
      if (applied.ok) return;
      expect(applied.diagnostics.some((d) =>
        d.code === "workspace_crash_recovery_input_unsupported_schema"
      )).toBe(true);
    });

    it("rejects unsupported nested lease set schema during recovery", () => {
      const applied = applyWorkspaceCrashRecovery({
        schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet: {
          schemaVersion: 99 as unknown as typeof WORKSPACE_LEASE_SET_SCHEMA_VERSION,
          leases: [],
        },
        liveAttemptIds: [],
      });
      expect(applied.ok).toBe(false);
      if (applied.ok) return;
      expect(applied.diagnostics.some((d) =>
        d.code === "workspace_lease_set_unsupported_schema"
      )).toBe(true);
    });
  });

  describe("concurrency occupancy cleanup", () => {
    it("releases concurrency and group slots for recovered dead attempts", () => {
      let concurrency: ConcurrencyState = createEmptyConcurrencyState();
      const admitLive = admitAttempt(concurrency, {
        attemptId: "attempt-live",
        executorKind: "isolated-pi",
      });
      expect(admitLive.ok).toBe(true);
      if (!admitLive.ok) return;
      const admitDead = admitAttempt(admitLive.state, {
        attemptId: "attempt-dead",
        executorKind: "cli",
      });
      expect(admitDead.ok).toBe(true);
      if (!admitDead.ok) return;
      concurrency = admitDead.state;

      const groupRegistry = {
        groups: [{ groupId: "group-a", maxConcurrent: 2 }],
      };
      let groups: ConcurrencyGroupState = createEmptyConcurrencyGroupState();
      const groupLive = admitGroupAttempt(
        groups,
        { attemptId: "attempt-live", groupIds: ["group-a"] },
        groupRegistry,
      );
      expect(groupLive.ok).toBe(true);
      if (!groupLive.ok) return;
      const groupDead = admitGroupAttempt(
        groupLive.state,
        { attemptId: "attempt-dead", groupIds: ["group-a"] },
        groupRegistry,
      );
      expect(groupDead.ok).toBe(true);
      if (!groupDead.ok) return;
      groups = groupDead.state;

      const leaseSet = acquireTwoLeases();
      const recovered = applyWorkspaceCrashRecovery({
        schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet,
        concurrencyState: concurrency,
        groupState: groups,
        liveAttemptIds: ["attempt-live"],
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;

      expect(recovered.plan.releasedConcurrencyAttemptIds).toEqual(["attempt-dead"]);
      expect(recovered.plan.releasedGroupAttemptIds).toEqual(["attempt-dead"]);

      expect(recovered.concurrencyState).toBeDefined();
      expect(recovered.groupState).toBeDefined();
      const remainingConcurrency = listConcurrencyActiveAttempts(recovered.concurrencyState!);
      expect(remainingConcurrency.ok).toBe(true);
      if (!remainingConcurrency.ok) return;
      expect(remainingConcurrency.attempts.map((a) => a.attemptId)).toEqual(["attempt-live"]);

      const remainingGroups = listConcurrencyGroupActiveAttempts(recovered.groupState!);
      expect(remainingGroups.ok).toBe(true);
      if (!remainingGroups.ok) return;
      expect(remainingGroups.attempts.map((a) => a.attemptId)).toEqual(["attempt-live"]);
    });
  });

  describe("optional omitted sets and failed worktrees", () => {
    it("returns only sets the caller supplied", () => {
      const leaseSet = acquireTwoLeases();
      const recovered = applyWorkspaceCrashRecovery({
        schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet,
        liveAttemptIds: ["attempt-live"],
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;
      expect(recovered.leaseSet).toBeDefined();
      expect(recovered.integrationSet).toBeUndefined();
      expect(recovered.worktreeSet).toBeUndefined();
      expect(recovered.concurrencyState).toBeUndefined();
      expect(recovered.groupState).toBeUndefined();
    });

    it("releases dead failed worktrees and emits disk cleanup", () => {
      const leaseSet = acquireTwoLeases();
      let worktrees = createEmptyWorkspaceWorktreeSet();
      const failed = registerWorktree(worktrees, {
        ...readyWorktree("wt-failed", "lease-dead", "attempt-dead"),
        status: "failed",
      });
      expect(failed.ok).toBe(true);
      if (!failed.ok) return;
      worktrees = failed.set;
      const liveReady = registerWorktree(
        worktrees,
        readyWorktree("wt-live", "lease-live", "attempt-live"),
      );
      expect(liveReady.ok).toBe(true);
      if (!liveReady.ok) return;

      const recovered = applyWorkspaceCrashRecovery({
        schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet,
        worktreeSet: liveReady.set,
        liveAttemptIds: ["attempt-live"],
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;
      expect(recovered.plan.releasedWorktreeIds).toContain("wt-failed");
      expect(recovered.plan.hostActions.some((a) =>
        a.kind === "release_worktree_disk" && a.worktreeId === "wt-failed"
      )).toBe(true);
      const wt = recovered.worktreeSet?.worktrees.find((w) => w.worktreeId === "wt-failed");
      expect(wt?.status).toBe("released");
    });
  });

  describe("controller restore contract", () => {
    it("composes the four-step restore path with mock teardown and liveness", () => {
      // Step 1: isolated-Pi teardown / orphan reconciliation (mocked).
      const orphanAttemptIds = ["attempt-dead"];
      // Step 2: live process records after teardown.
      const processLiveness = [
        { attemptId: "attempt-live", live: true },
        { attemptId: "attempt-dead", live: false },
      ];
      const leaseSet = acquireTwoLeases();
      const worktreeSet = registerTwoWorktrees();
      let concurrency = createEmptyConcurrencyState();
      const admitLive = admitAttempt(concurrency, {
        attemptId: "attempt-live",
        executorKind: "isolated-pi",
      });
      expect(admitLive.ok).toBe(true);
      if (!admitLive.ok) return;
      const admitDead = admitAttempt(admitLive.state, {
        attemptId: "attempt-dead",
        executorKind: "cli",
      });
      expect(admitDead.ok).toBe(true);
      if (!admitDead.ok) return;
      concurrency = admitDead.state;

      // Step 3: reconcile owned workspace sets.
      const recovered = reconcileWorkspaceAfterCrash({
        schemaVersion: WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION,
        leaseSet,
        worktreeSet,
        concurrencyState: concurrency,
        processLiveness,
        orphanAttemptIds,
      });
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;

      // Step 4: host applies hostActions (assert they are present and ordered).
      expect(recovered.plan.hostActions.some((a) =>
        a.kind === "teardown_child_attempt" && a.attemptId === "attempt-dead"
      )).toBe(true);
      expect(recovered.plan.hostActions.some((a) =>
        a.kind === "release_worktree_disk" && a.worktreeId === "wt-dead"
      )).toBe(true);
      expect(recovered.plan.releasedLeaseIds).toEqual(["lease-dead"]);
      expect(recovered.plan.releasedConcurrencyAttemptIds).toEqual(["attempt-dead"]);
      // Omitted integrationSet is not returned (must not wipe host state).
      expect(recovered.integrationSet).toBeUndefined();
      expect(recovered.worktreeSet).toBeDefined();
      expect(recovered.concurrencyState).toBeDefined();
    });
  });

  describe("classification helpers", () => {
    it("ignores class-instance liveness rows", () => {
      class Row {
        constructor(
          public attemptId: string,
          public live: boolean,
        ) {}
      }
      const live = liveAttemptIdsFromLiveness([
        { attemptId: "plain-live", live: true },
        new Row("class-live", true) as unknown as { attemptId: string; live: boolean },
      ]);
      expect(live).toEqual(["plain-live"]);
    });

    it("collects attempt ids and classifies dead holders", () => {
      const leaseSet = acquireTwoLeases();
      const ids = collectWorkspaceAttemptIds({ leaseSet });
      expect(ids).toEqual(["attempt-dead", "attempt-live"]);

      const classified = classifyAttemptLiveness(ids, ["attempt-live"]);
      expect(classified.liveAttemptIds).toEqual(["attempt-live"]);
      expect(classified.deadAttemptIds).toEqual(["attempt-dead"]);
    });

    it("uses expected plan schema version one", () => {
      expect(WORKSPACE_CRASH_RECOVERY_SCHEMA_VERSION).toBe(1);
      expect(WORKSPACE_LEASE_SET_SCHEMA_VERSION).toBe(1);
      expect(WORKSPACE_INTEGRATION_SET_SCHEMA_VERSION).toBe(2);
      expect(WORKSPACE_WORKTREE_SET_SCHEMA_VERSION).toBe(1);
      expect(CONCURRENCY_STATE_SCHEMA_VERSION).toBe(1);
      expect(CONCURRENCY_GROUP_STATE_SCHEMA_VERSION).toBe(1);
    });
  });
});
