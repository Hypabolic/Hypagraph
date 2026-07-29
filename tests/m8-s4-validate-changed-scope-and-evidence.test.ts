import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_RESULT_ARTIFACTS,
  DEFAULT_MAX_RESULT_DIAGNOSTICS,
  DEFAULT_MAX_RESULT_EVIDENCE,
  DEFAULT_MAX_RESULT_FACTS,
  DEFAULT_MAX_RESULT_SUMMARY_CHARS,
  EXECUTOR_OUTCOMES,
  buildExecutorResultPayload,
  type ExecutorAttemptIdentity,
  type StructuredResultProtocolDescriptor,
} from "../src/domain/executor-contract.js";
import {
  WORKER_COMMIT_RESULT_SCHEMA_VERSION,
  toExecutorWorkspaceResult,
  type WorkerCommitResult,
} from "../src/domain/workspace-commit.js";
import {
  pathWithinLeaseScope,
  pathWithinSingleLeaseScope,
  type WorkspaceLease,
  type WorkspaceLeaseHolder,
} from "../src/domain/workspace-lease.js";
import {
  defaultIntegrationResultProtocol,
  looksLikeWorkspaceRelativeEvidencePath,
  parseIntegrationResultProtocol,
  validateChangedPathsWithinWriteScope,
  validateExecutorWorkspaceMatchesCommit,
  validateFileEvidencePathsWithinLeaseScope,
  validateIntegrationWorkspaceStatus,
  validateWorkerResultForIntegration,
} from "../src/domain/workspace-scope-validation.js";

const FULL_HASH_A = "a".repeat(40);
const FULL_HASH_B = "b".repeat(40);

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
  writePaths: string[],
  attemptId = leaseId,
  readPaths?: string[],
): WorkspaceLease => ({
  leaseId,
  mode: "exclusive",
  holder: holder(attemptId),
  paths: {
    readPaths: readPaths !== undefined ? [...readPaths] : [...writePaths],
    writePaths: [...writePaths],
  },
});

const sharedLease = (
  leaseId: string,
  readPaths: string[],
  attemptId = leaseId,
): WorkspaceLease => ({
  leaseId,
  mode: "shared",
  holder: holder(attemptId),
  paths: {
    readPaths: [...readPaths],
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
  changedPaths: ["src/domain/workspace-scope-validation.ts"],
  status: "clean",
  headAdvanced: true,
  ...overrides,
});

const identityFromHolder = (h: WorkspaceLeaseHolder): ExecutorAttemptIdentity => ({
  familyId: h.familyId,
  goalId: h.goalId,
  workflowId: h.workflowId,
  revision: h.revision,
  nodeId: h.nodeId,
  attemptId: h.attemptId,
});

const protocolWithRequiredEvidence = (
  requiredEvidence: string[] = ["evidence://proof"],
): StructuredResultProtocolDescriptor => ({
  version: 1,
  outcomes: [...EXECUTOR_OUTCOMES],
  factContracts: [],
  requiredEvidence,
  maxSummaryChars: DEFAULT_MAX_RESULT_SUMMARY_CHARS,
  maxDiagnostics: DEFAULT_MAX_RESULT_DIAGNOSTICS,
  maxArtifacts: DEFAULT_MAX_RESULT_ARTIFACTS,
  maxFacts: DEFAULT_MAX_RESULT_FACTS,
  maxEvidence: DEFAULT_MAX_RESULT_EVIDENCE,
});

const submittedExecutorPayload = (
  lease: WorkspaceLease,
  commit: WorkerCommitResult,
  overrides: {
    evidence?: Array<{ ref: string; kind?: "note" | "file" | "tool" | "command" | "approval" }>;
    artifacts?: Array<{ ref: string; kind?: string }>;
    facts?: Array<{ name: string; type: "boolean" | "string"; value: unknown }>;
    workspace?: Record<string, unknown> | null;
    outcome?: "submitted" | "failed" | "cancelled" | "timed_out" | "interrupted";
  } = {},
): Record<string, unknown> => {
  const workspace = overrides.workspace === null
    ? undefined
    : (overrides.workspace ?? toExecutorWorkspaceResult(commit));
  return buildExecutorResultPayload({
    identity: identityFromHolder(lease.holder),
    outcome: overrides.outcome ?? "submitted",
    evidence: overrides.evidence ?? [{ ref: "evidence://proof", kind: "note" }],
    artifacts: overrides.artifacts ?? [{ ref: "artifact://report", kind: "report" }],
    facts: (overrides.facts as never) ?? [],
    ...(workspace !== undefined
      ? { workspace: workspace as ReturnType<typeof toExecutorWorkspaceResult> }
      : {}),
    defaultSummary: () => "Worker finished.",
  });
};

describe("m8-s4 validate changed scope and evidence", () => {
  describe("pathWithinLeaseScope", () => {
    it("accepts nested files under non-glob and glob write scopes", () => {
      expect(pathWithinSingleLeaseScope("src/domain/a.ts", "src")).toBe(true);
      expect(pathWithinSingleLeaseScope("src/domain/a.ts", "src/**")).toBe(true);
      expect(pathWithinLeaseScope("src/domain/a.ts", ["src"])).toBe(true);
      expect(pathWithinLeaseScope("src/domain/a.ts", ["src/**"])).toBe(true);
      expect(pathWithinLeaseScope("src/domain/a.ts", ["docs", "src/**"])).toBe(true);
    });

    it("rejects sibling prefix tricks and unrelated paths", () => {
      expect(pathWithinLeaseScope("src2/a.ts", ["src"])).toBe(false);
      expect(pathWithinLeaseScope("src2/a.ts", ["src/**"])).toBe(false);
      expect(pathWithinLeaseScope("other/pkg/a.ts", ["src"])).toBe(false);
      expect(pathWithinLeaseScope("../escape", ["src"])).toBe(false);
      expect(pathWithinLeaseScope("src/a.ts", [])).toBe(false);
    });

    it("treats whole-workspace /** as covering any valid path", () => {
      expect(pathWithinLeaseScope("any/file.ts", ["/**"])).toBe(true);
    });
  });

  describe("validateWorkerResultForIntegration happy paths", () => {
    it("accepts clean commit with changed paths inside exclusive write scope", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const commit = validCommit({
        changedPaths: [
          "src/domain/workspace-scope-validation.ts",
          "src/nested/deep/file.ts",
        ],
      });
      const result = validateWorkerResultForIntegration({ commit, lease });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.commit.status).toBe("clean");
      expect(result.value.commit.changedPaths).toEqual([
        "src/domain/workspace-scope-validation.ts",
        "src/nested/deep/file.ts",
      ]);
      expect(result.value.lease.mode).toBe("exclusive");
      expect(result.value.executorResult).toBeUndefined();
    });

    it("accepts nested paths under src/** write scope", () => {
      const lease = exclusiveLease("lease-a", ["src/**"]);
      const commit = validCommit({
        changedPaths: ["src/a.ts", "src/domain/b.ts"],
      });
      const result = validateWorkerResultForIntegration({ commit, lease });
      expect(result.ok).toBe(true);
    });

    it("accepts clean empty changedPaths", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const commit = validCommit({
        commitHash: FULL_HASH_A,
        baseRevision: FULL_HASH_A,
        headAdvanced: false,
        changedPaths: [],
      });
      const result = validateWorkerResultForIntegration({ commit, lease });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.commit.changedPaths).toEqual([]);
    });

    it("accepts valid evidence and artifacts when protocol is satisfied", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const commit = validCommit();
      const protocol = protocolWithRequiredEvidence(["evidence://proof"]);
      const executorResult = submittedExecutorPayload(lease, commit, {
        evidence: [{ ref: "evidence://proof", kind: "note" }],
        artifacts: [{ ref: "artifact://report", kind: "report" }],
      });
      const result = validateWorkerResultForIntegration({
        commit,
        lease,
        executorResult,
        protocol,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.executorResult?.evidence).toEqual([
        { ref: "evidence://proof", kind: "note" },
      ]);
      expect(result.value.executorResult?.artifacts).toEqual([
        { ref: "artifact://report", kind: "report" },
      ]);
      expect(result.value.executorResult?.workspace?.commitHash).toBe(FULL_HASH_B);
    });
  });

  describe("scope rejections", () => {
    it("rejects path outside write scope", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const cases = [
        "other/pkg/a.ts",
        "src2/a.ts",
        "docs/readme.md",
      ];
      for (const path of cases) {
        const result = validateWorkerResultForIntegration({
          commit: validCommit({ changedPaths: [path] }),
          lease,
        });
        expect(result.ok, path).toBe(false);
        if (result.ok) continue;
        expect(
          result.diagnostics.some((d) => d.code === "workspace_scope_path_outside_write_scope"),
          path,
        ).toBe(true);
      }
    });

    it("rejects mixed list when any path is outside write scope", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const result = validateWorkerResultForIntegration({
        commit: validCommit({
          changedPaths: ["src/ok.ts", "escape/out.ts"],
        }),
        lease,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics.some(
          (d) => d.code === "workspace_scope_path_outside_write_scope",
        )).toBe(true);
      }
    });

    it("rejects invalid commit path traversal before scope check", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const result = validateWorkerResultForIntegration({
        commit: validCommit({ changedPaths: ["../escape"] }),
        lease,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics.some(
          (d) => d.code === "workspace_commit_invalid_path",
        )).toBe(true);
      }
    });
  });

  describe("status gate", () => {
    it("rejects dirty, conflicted, and unknown status for integration", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const cases: Array<{
        status: WorkerCommitResult["status"];
        code: string;
      }> = [
        { status: "dirty", code: "workspace_scope_status_dirty" },
        { status: "conflicted", code: "workspace_scope_status_conflicted" },
        { status: "unknown", code: "workspace_scope_status_unknown" },
      ];
      for (const item of cases) {
        const result = validateWorkerResultForIntegration({
          commit: validCommit({ status: item.status }),
          lease,
        });
        expect(result.ok, item.status).toBe(false);
        if (result.ok) continue;
        expect(
          result.diagnostics.some((d) => d.code === item.code),
          item.status,
        ).toBe(true);
      }
    });

    it("exposes validateIntegrationWorkspaceStatus helpers with distinct codes", () => {
      expect(validateIntegrationWorkspaceStatus("clean")).toEqual([]);
      expect(validateIntegrationWorkspaceStatus("dirty")[0]?.code)
        .toBe("workspace_scope_status_dirty");
      expect(validateIntegrationWorkspaceStatus("conflicted")[0]?.code)
        .toBe("workspace_scope_status_conflicted");
      expect(validateIntegrationWorkspaceStatus("unknown")[0]?.code)
        .toBe("workspace_scope_status_unknown");
    });
  });

  describe("identity", () => {
    it("rejects stale leaseId, worktreeId, and holder mismatch", () => {
      const lease = exclusiveLease("lease-a", ["src"]);

      const badLeaseId = validateWorkerResultForIntegration({
        commit: validCommit({ leaseId: "lease-other" }),
        lease,
      });
      expect(badLeaseId.ok).toBe(false);
      if (!badLeaseId.ok) {
        expect(badLeaseId.diagnostics.some(
          (d) => d.code === "workspace_commit_stale_identity",
        )).toBe(true);
      }

      const badWorktree = validateWorkerResultForIntegration({
        commit: validCommit(),
        lease,
        expected: { worktreeId: "wt-other" },
      });
      expect(badWorktree.ok).toBe(false);
      if (!badWorktree.ok) {
        expect(badWorktree.diagnostics.some(
          (d) => d.code === "workspace_commit_stale_identity",
        )).toBe(true);
      }

      const badHolder = validateWorkerResultForIntegration({
        commit: validCommit({ holder: holder("other-attempt") }),
        lease,
      });
      expect(badHolder.ok).toBe(false);
      if (!badHolder.ok) {
        expect(badHolder.diagnostics.some(
          (d) => d.code === "workspace_commit_stale_identity",
        )).toBe(true);
      }
    });

    it("accepts matching expected worktreeId", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const result = validateWorkerResultForIntegration({
        commit: validCommit(),
        lease,
        expected: {
          worktreeId: "wt-lease-a",
          leaseId: "lease-a",
          holder: holder("lease-a"),
        },
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("lease mode", () => {
    it("rejects non-exclusive shared lease for mutating integration precheck", () => {
      const lease = sharedLease("lease-shared", ["src"]);
      const commit = validCommit({
        leaseId: "lease-shared",
        holder: holder("lease-shared"),
        worktreeId: "wt-lease-shared",
      });
      const result = validateWorkerResultForIntegration({ commit, lease });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics.some(
          (d) => d.code === "workspace_scope_lease_not_exclusive",
        )).toBe(true);
      }
    });

    it("rejects invalid lease mode with workspace_lease_invalid_mode not exclusive code", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const result = validateWorkerResultForIntegration({
        commit: validCommit(),
        lease: { ...lease, mode: "bogus" },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics.some(
          (d) => d.code === "workspace_lease_invalid_mode",
        )).toBe(true);
        expect(result.diagnostics.some(
          (d) => d.code === "workspace_scope_lease_not_exclusive",
        )).toBe(false);
      }
    });
  });

  describe("evidence and protocol", () => {
    it("rejects missing required evidence when protocol demands it and outcome is submitted", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const commit = validCommit();
      const protocol = protocolWithRequiredEvidence(["evidence://required-proof"]);
      const executorResult = submittedExecutorPayload(lease, commit, {
        evidence: [{ ref: "evidence://other", kind: "note" }],
      });
      const result = validateWorkerResultForIntegration({
        commit,
        lease,
        executorResult,
        protocol,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics.some(
          (d) => d.code === "executor_result_required_evidence_missing",
        )).toBe(true);
      }
    });

    it("rejects workspace field mismatch between executor result and commit", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const commit = validCommit();
      const protocol = protocolWithRequiredEvidence();
      const executorResult = submittedExecutorPayload(lease, commit, {
        workspace: {
          leaseId: "lease-a",
          commitHash: FULL_HASH_A,
          changedPaths: ["src/domain/workspace-scope-validation.ts"],
          status: "clean",
        },
      });
      const result = validateWorkerResultForIntegration({
        commit,
        lease,
        executorResult,
        protocol,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics.some(
          (d) => d.code === "workspace_scope_workspace_mismatch",
        )).toBe(true);
      }
    });

    it("rejects changedPaths set mismatch on executor workspace", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const commit = validCommit({
        changedPaths: ["src/a.ts", "src/b.ts"],
      });
      const protocol = defaultIntegrationResultProtocol();
      const executorResult = submittedExecutorPayload(lease, commit, {
        evidence: [],
        artifacts: [],
        workspace: {
          leaseId: "lease-a",
          commitHash: FULL_HASH_B,
          changedPaths: ["src/a.ts"],
          status: "clean",
        },
      });
      const result = validateWorkerResultForIntegration({
        commit,
        lease,
        executorResult,
        protocol,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics.some(
          (d) => d.code === "workspace_scope_workspace_mismatch",
        )).toBe(true);
      }
    });

    it("rejects executor identity that does not match lease holder", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const commit = validCommit();
      const protocol = defaultIntegrationResultProtocol();
      const payload = buildExecutorResultPayload({
        identity: {
          ...identityFromHolder(lease.holder),
          attemptId: "wrong-attempt",
        },
        outcome: "submitted",
        workspace: toExecutorWorkspaceResult(commit),
        defaultSummary: () => "done",
      });
      const result = validateWorkerResultForIntegration({
        commit,
        lease,
        executorResult: payload,
        protocol,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics.some(
          (d) => d.code === "executor_result_identity_mismatch",
        )).toBe(true);
      }
    });

    it("returns diagnostics without throwing for a malformed plain-object protocol", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const commit = validCommit();
      let thrown: unknown;
      let result: ReturnType<typeof validateWorkerResultForIntegration> | undefined;
      try {
        result = validateWorkerResultForIntegration({
          commit,
          lease,
          executorResult: {},
          protocol: {} as never,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeUndefined();
      expect(result).toBeDefined();
      if (result === undefined) throw new Error("expected result");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics.some(
          (d) => d.code === "workspace_scope_protocol_invalid"
            || d.code === "workspace_scope_protocol_not_plain_object",
        )).toBe(true);
      }

      // requiredEvidence missing (undefined) must not throw.
      let thrownMissing: unknown;
      let resultMissing: ReturnType<typeof validateWorkerResultForIntegration> | undefined;
      try {
        resultMissing = validateWorkerResultForIntegration({
          commit,
          lease,
          executorResult: {},
          protocol: {
            ...defaultIntegrationResultProtocol(),
            requiredEvidence: undefined,
          } as never,
        });
      } catch (error) {
        thrownMissing = error;
      }
      expect(thrownMissing).toBeUndefined();
      expect(resultMissing).toBeDefined();
      if (resultMissing === undefined) throw new Error("expected resultMissing");
      expect(resultMissing.ok).toBe(false);
      if (!resultMissing.ok) {
        expect(resultMissing.diagnostics.some(
          (d) => d.code === "workspace_scope_protocol_invalid",
        )).toBe(true);
      }
    });

    it("rejects class-instance protocol before clone", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const commit = validCommit();
      class ProtocolClass {
        version = 1 as const;
        outcomes = [...EXECUTOR_OUTCOMES];
        factContracts: [] = [];
        requiredEvidence: string[] = [];
        maxSummaryChars = DEFAULT_MAX_RESULT_SUMMARY_CHARS;
        maxDiagnostics = DEFAULT_MAX_RESULT_DIAGNOSTICS;
        maxArtifacts = DEFAULT_MAX_RESULT_ARTIFACTS;
        maxFacts = DEFAULT_MAX_RESULT_FACTS;
        maxEvidence = DEFAULT_MAX_RESULT_EVIDENCE;
      }
      const payload = submittedExecutorPayload(lease, commit, {
        evidence: [],
        artifacts: [],
      });
      const result = validateWorkerResultForIntegration({
        commit,
        lease,
        executorResult: payload,
        protocol: new ProtocolClass() as never,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics.some(
          (d) => d.code === "workspace_scope_protocol_not_plain_object",
        )).toBe(true);
      }
      expect(parseIntegrationResultProtocol(new ProtocolClass()).ok).toBe(false);
    });

    it("accepts equivalent ./-prefixed executor workspace changedPaths", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const commit = validCommit({ changedPaths: ["src/a.ts"] });
      const protocol = defaultIntegrationResultProtocol();
      const executorResult = submittedExecutorPayload(lease, commit, {
        evidence: [],
        artifacts: [],
        workspace: {
          leaseId: "lease-a",
          commitHash: FULL_HASH_B,
          changedPaths: ["./src/a.ts"],
          status: "clean",
        },
      });
      const result = validateWorkerResultForIntegration({
        commit,
        lease,
        executorResult,
        protocol,
      });
      expect(result.ok).toBe(true);
    });

    it("trims leaseId and lowercases commitHash when comparing executor workspace", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const commit = validCommit({ changedPaths: ["src/a.ts"] });
      const protocol = defaultIntegrationResultProtocol();
      const executorResult = submittedExecutorPayload(lease, commit, {
        evidence: [],
        artifacts: [],
        workspace: {
          leaseId: " lease-a ",
          commitHash: FULL_HASH_B.toUpperCase(),
          changedPaths: ["src/a.ts"],
          status: "clean",
        },
      });
      const result = validateWorkerResultForIntegration({
        commit,
        lease,
        executorResult,
        protocol,
      });
      expect(result.ok).toBe(true);

      // Documented: whitespace-only mismatch after trim still fails.
      const mismatch = validateExecutorWorkspaceMatchesCommit(
        { leaseId: " lease-other ", commitHash: FULL_HASH_B },
        commit,
      );
      expect(mismatch.some((d) => d.code === "workspace_scope_workspace_mismatch")).toBe(true);
    });
  });

  describe("bounds and plain objects", () => {
    it("enforces maxChangedPaths when provided", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const commit = validCommit({
        changedPaths: ["src/a.ts", "src/b.ts"],
      });
      const result = validateWorkerResultForIntegration({
        commit,
        lease,
        bounds: { maxChangedPaths: 1 },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics.some(
          (d) => d.code === "workspace_commit_path_limit",
        )).toBe(true);
      }
    });

    it("rejects class instances for commit and lease", () => {
      class LeaseClass {
        leaseId = "lease-a";
        mode = "exclusive";
      }
      class CommitClass {
        schemaVersion = 1;
      }
      const lease = exclusiveLease("lease-a", ["src"]);
      const commit = validCommit();

      expect(
        validateWorkerResultForIntegration({
          commit: new CommitClass(),
          lease,
        }).ok,
      ).toBe(false);

      expect(
        validateWorkerResultForIntegration({
          commit,
          lease: new LeaseClass(),
        }).ok,
      ).toBe(false);

      expect(
        validateWorkerResultForIntegration({
          commit: null,
          lease,
        }).ok,
      ).toBe(false);
    });

    it("does not mutate inputs (purity)", () => {
      const lease = exclusiveLease("lease-a", ["src"]);
      const commit = validCommit({
        changedPaths: ["src/z.ts", "src/a.ts"],
      });
      const leaseSnapshot = structuredClone(lease);
      const commitSnapshot = structuredClone(commit);
      const executorResult = submittedExecutorPayload(lease, commit, {
        evidence: [{ ref: "evidence://proof", kind: "note" }],
      });
      const executorSnapshot = structuredClone(executorResult);

      const result = validateWorkerResultForIntegration({
        commit,
        lease,
        executorResult,
        protocol: protocolWithRequiredEvidence(),
      });
      expect(result.ok).toBe(true);
      expect(lease).toEqual(leaseSnapshot);
      expect(commit).toEqual(commitSnapshot);
      expect(executorResult).toEqual(executorSnapshot);

      if (result.ok) {
        result.value.commit.changedPaths.push("mutated.ts");
        result.value.lease.paths.writePaths.push("mutated");
        expect(commit.changedPaths).toEqual(commitSnapshot.changedPaths);
        expect(lease.paths.writePaths).toEqual(leaseSnapshot.paths.writePaths);
      }
    });
  });

  describe("optional file evidence path check", () => {
    it("detects workspace-relative refs and rejects paths outside lease scope", () => {
      expect(looksLikeWorkspaceRelativeEvidencePath("src/file.ts")).toBe(true);
      expect(looksLikeWorkspaceRelativeEvidencePath("evidence://uri")).toBe(false);
      expect(looksLikeWorkspaceRelativeEvidencePath("file:///abs")).toBe(false);

      const lease = exclusiveLease("lease-a", ["src"], "lease-a", ["src", "docs"]);
      const outside = validateFileEvidencePathsWithinLeaseScope(
        [{ ref: "other/secret.ts", kind: "file" }],
        lease,
      );
      expect(outside.some(
        (d) => d.code === "workspace_scope_file_evidence_outside_scope",
      )).toBe(true);

      const inside = validateFileEvidencePathsWithinLeaseScope(
        [{ ref: "src/ok.ts", kind: "file" }, { ref: "evidence://uri", kind: "file" }],
        lease,
      );
      expect(inside).toEqual([]);

      const commit = validCommit();
      const protocol = defaultIntegrationResultProtocol();
      const executorResult = submittedExecutorPayload(lease, commit, {
        evidence: [{ ref: "other/secret.ts", kind: "file" }],
        artifacts: [],
      });
      const gated = validateWorkerResultForIntegration({
        commit,
        lease,
        executorResult,
        protocol,
        checkFileEvidencePaths: true,
      });
      expect(gated.ok).toBe(false);
      if (!gated.ok) {
        expect(gated.diagnostics.some(
          (d) => d.code === "workspace_scope_file_evidence_outside_scope",
        )).toBe(true);
      }

      const ungated = validateWorkerResultForIntegration({
        commit,
        lease,
        executorResult,
        protocol,
        checkFileEvidencePaths: false,
      });
      expect(ungated.ok).toBe(true);
    });
  });

  describe("helper composition", () => {
    it("validateChangedPathsWithinWriteScope returns dedicated code", () => {
      const diagnostics = validateChangedPathsWithinWriteScope(
        ["src/ok.ts", "out/bad.ts"],
        ["src"],
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.code).toBe("workspace_scope_path_outside_write_scope");
    });

    it("validateExecutorWorkspaceMatchesCommit accepts matching workspace", () => {
      const commit = validCommit({
        changedPaths: ["src/b.ts", "src/a.ts"],
      });
      // Order and ./ prefix differ; set must still match after canonicalisation.
      const diagnostics = validateExecutorWorkspaceMatchesCommit(
        {
          leaseId: "lease-a",
          commitHash: FULL_HASH_B,
          changedPaths: ["./src/a.ts", "src/b.ts"],
          status: "clean",
        },
        commit,
      );
      expect(diagnostics).toEqual([]);
    });
  });
});
