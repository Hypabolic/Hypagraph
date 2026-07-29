import { describe, expect, it } from "vitest";
import type { ExecutorWorkspaceLeaseRef } from "../src/domain/executor-contract.js";
import {
  DEFAULT_MAX_ACTIVE_LEASES,
  DEFAULT_MAX_LEASE_PATHS,
  WORKSPACE_LEASE_SET_SCHEMA_VERSION,
  acquireWorkspaceLease,
  canAcquireWorkspaceLease,
  createEmptyWorkspaceLeaseSet,
  getWorkspaceLease,
  leasePathsOverlap,
  listWorkspaceLeases,
  parseWorkspaceLease,
  proposeWorkspaceLease,
  releaseWorkspaceLease,
  toExecutorWorkspaceLeaseRef,
  validateWorkspaceLease,
  validateWorkspaceLeaseSetSchema,
  workspaceLeasesConflict,
  type WorkspaceLease,
  type WorkspaceLeaseHolder,
  type WorkspaceLeaseSet,
} from "../src/domain/workspace-lease.js";

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
  writePaths: string[],
  attemptId = leaseId,
  baseRevision?: string,
): WorkspaceLease => ({
  leaseId,
  mode: "exclusive",
  holder: holder(attemptId),
  paths: {
    readPaths: [...writePaths],
    writePaths: [...writePaths],
  },
  ...(baseRevision !== undefined ? { baseRevision } : {}),
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
    readPaths,
    writePaths: [],
  },
});

const expectListedIds = (set: WorkspaceLeaseSet, ids: string[]): void => {
  const listed = listWorkspaceLeases(set);
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect(listed.leases.map((lease) => lease.leaseId)).toEqual(ids);
};

describe("m8-s1 workspace lease contracts", () => {
  describe("validation", () => {
    it("accepts a valid exclusive lease and canonicalises paths", () => {
      const raw = {
        leaseId: "lease-a",
        mode: "exclusive",
        holder: holder("attempt-a"),
        paths: {
          readPaths: ["./src", "src/domain"],
          writePaths: ["src//domain", "docs"],
        },
        baseRevision: "abc123",
      };
      const diagnostics = validateWorkspaceLease(raw);
      expect(diagnostics).toEqual([]);

      const parsed = parseWorkspaceLease(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.leaseId).toBe("lease-a");
      expect(parsed.value.mode).toBe("exclusive");
      expect(parsed.value.baseRevision).toBe("abc123");
      expect(parsed.value.paths.writePaths).toEqual(["docs", "src/domain"]);
      expect(parsed.value.paths.readPaths).toEqual(["src", "src/domain"]);
    });

    it("accepts a valid shared lease", () => {
      const proposed = proposeWorkspaceLease({
        leaseId: "lease-read",
        mode: "shared",
        holder: holder("attempt-read"),
        paths: { readPaths: ["src/**"], writePaths: [] },
      });
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      expect(proposed.value.mode).toBe("shared");
      expect(proposed.value.paths.writePaths).toEqual([]);
      expect(proposed.value.paths.readPaths).toEqual(["src/**"]);
    });

    it("rejects empty lease id, invalid mode, and class instances", () => {
      const emptyId = validateWorkspaceLease({
        leaseId: "  ",
        mode: "exclusive",
        holder: holder("a1"),
        paths: { readPaths: [], writePaths: ["src"] },
      });
      expect(emptyId.some((d) => d.code === "workspace_lease_invalid_id")).toBe(true);

      const badMode = validateWorkspaceLease({
        leaseId: "lease-x",
        mode: "mutable",
        holder: holder("a1"),
        paths: { readPaths: [], writePaths: ["src"] },
      });
      expect(badMode.some((d) => d.code === "workspace_lease_invalid_mode")).toBe(true);

      class LeaseClass {
        leaseId = "lease-x";
        mode = "exclusive";
        holder = holder("a1");
        paths = { readPaths: [], writePaths: ["src"] };
      }
      const classInstance = validateWorkspaceLease(new LeaseClass());
      expect(classInstance.some((d) => d.code === "workspace_lease_not_plain_object")).toBe(true);
    });

    it("rejects invalid holder fields and path shapes", () => {
      const badHolder = validateWorkspaceLease({
        leaseId: "lease-x",
        mode: "exclusive",
        holder: {
          familyId: "f",
          goalId: "",
          workflowId: "w",
          revision: -1,
          nodeId: "n",
          attemptId: "a",
        },
        paths: { readPaths: [], writePaths: ["src"] },
      });
      expect(badHolder.some((d) => d.code === "workspace_lease_invalid_holder")).toBe(true);

      const absolutePath = validateWorkspaceLease({
        leaseId: "lease-x",
        mode: "exclusive",
        holder: holder("a1"),
        paths: { readPaths: [], writePaths: ["/etc/passwd"] },
      });
      expect(absolutePath.some((d) => d.code === "workspace_lease_invalid_path")).toBe(true);

      const parentEscape = validateWorkspaceLease({
        leaseId: "lease-x",
        mode: "exclusive",
        holder: holder("a1"),
        paths: { readPaths: [], writePaths: ["src/../secret"] },
      });
      expect(parentEscape.some((d) => d.code === "workspace_lease_invalid_path")).toBe(true);

      const duplicate = validateWorkspaceLease({
        leaseId: "lease-x",
        mode: "exclusive",
        holder: holder("a1"),
        paths: { readPaths: [], writePaths: ["src/a", "./src/a"] },
      });
      expect(duplicate.some((d) => d.code === "workspace_lease_duplicate_path")).toBe(true);

      const notArrayList = validateWorkspaceLease({
        leaseId: "lease-x",
        mode: "exclusive",
        holder: holder("a1"),
        paths: { readPaths: "src", writePaths: ["src"] },
      });
      expect(notArrayList.some((d) => d.code === "workspace_lease_invalid_path_list")).toBe(true);

      const pathsNotObject = validateWorkspaceLease({
        leaseId: "lease-x",
        mode: "exclusive",
        holder: holder("a1"),
        paths: ["src"],
      });
      expect(pathsNotObject.some((d) => d.code === "workspace_lease_invalid_paths_object")).toBe(true);
    });

    it("rejects exclusive without write paths and shared with write paths", () => {
      const emptyWrite = validateWorkspaceLease({
        leaseId: "lease-x",
        mode: "exclusive",
        holder: holder("a1"),
        paths: { readPaths: ["src"], writePaths: [] },
      });
      expect(emptyWrite.some((d) => d.code === "workspace_lease_empty_write_scope")).toBe(true);

      const sharedWrite = validateWorkspaceLease({
        leaseId: "lease-x",
        mode: "shared",
        holder: holder("a1"),
        paths: { readPaths: ["src"], writePaths: ["src"] },
      });
      expect(sharedWrite.some((d) => d.code === "workspace_lease_shared_with_writes")).toBe(true);

      const emptyRead = validateWorkspaceLease({
        leaseId: "lease-x",
        mode: "shared",
        holder: holder("a1"),
        paths: { readPaths: [], writePaths: [] },
      });
      expect(emptyRead.some((d) => d.code === "workspace_lease_empty_read_scope")).toBe(true);
    });

    it("enforces path count bounds and rejects invalid bound values", () => {
      const tooMany = validateWorkspaceLease(
        {
          leaseId: "lease-x",
          mode: "exclusive",
          holder: holder("a1"),
          paths: {
            readPaths: [],
            writePaths: ["a", "b", "c"],
          },
        },
        "lease",
        { maxPaths: 2 },
      );
      expect(tooMany.some((d) => d.code === "workspace_lease_path_limit")).toBe(true);
      expect(DEFAULT_MAX_LEASE_PATHS).toBeGreaterThan(0);

      const invalidBound = validateWorkspaceLease(
        {
          leaseId: "lease-x",
          mode: "exclusive",
          holder: holder("a1"),
          paths: { readPaths: [], writePaths: ["src"] },
        },
        "lease",
        { maxPaths: -1 },
      );
      expect(invalidBound.some((d) => d.code === "workspace_lease_invalid_bound")).toBe(true);

      const nanBound = canAcquireWorkspaceLease(
        createEmptyWorkspaceLeaseSet(),
        exclusiveLease("lease-a", ["src"]),
        { maxActiveLeases: Number.NaN },
      );
      expect(nanBound.ok).toBe(false);
      if (nanBound.ok) return;
      expect(nanBound.diagnostics.some((d) => d.code === "workspace_lease_invalid_bound")).toBe(true);
    });

    it("rejects empty baseRevision when present", () => {
      const diagnostics = validateWorkspaceLease({
        leaseId: "lease-x",
        mode: "exclusive",
        holder: holder("a1"),
        paths: { readPaths: [], writePaths: ["src"] },
        baseRevision: " ",
      });
      expect(diagnostics.some((d) => d.code === "workspace_lease_invalid_base_revision")).toBe(true);
    });
  });

  describe("path overlap and compatibility", () => {
    it("detects overlapping and non-overlapping path scopes", () => {
      expect(leasePathsOverlap("src", "src/domain")).toBe(true);
      expect(leasePathsOverlap("src/**", "src/domain/file.ts")).toBe(true);
      expect(leasePathsOverlap("src", "src/domain/**")).toBe(true);
      expect(leasePathsOverlap("src/domain/**", "src")).toBe(true);
      expect(leasePathsOverlap("/**", "docs/a")).toBe(true);
      expect(leasePathsOverlap("./**", "src")).toBe(true);
      expect(leasePathsOverlap("src", "docs")).toBe(false);
      expect(leasePathsOverlap("src", "src2")).toBe(false);
      expect(leasePathsOverlap("/abs", "src")).toBe(false);
    });

    it("marks two exclusive overlapping write leases as incompatible", () => {
      const left = exclusiveLease("lease-a", ["src"]);
      const right = exclusiveLease("lease-b", ["src/domain"], "attempt-b");
      expect(workspaceLeasesConflict(left, right)).toBe(true);

      const empty = createEmptyWorkspaceLeaseSet();
      const first = acquireWorkspaceLease(empty, left);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const second = canAcquireWorkspaceLease(first.set, right);
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.diagnostics.some((d) => d.code === "workspace_lease_incompatible")).toBe(true);
      expect(second.conflictingLeaseIds).toEqual(["lease-a"]);
    });

    it("blocks exclusive parent non-glob against nested child glob write scopes", () => {
      const parent = exclusiveLease("lease-parent", ["src"]);
      const childGlob = exclusiveLease("lease-child", ["src/domain/**"], "attempt-child");
      expect(workspaceLeasesConflict(parent, childGlob)).toBe(true);
      expect(workspaceLeasesConflict(childGlob, parent)).toBe(true);

      const first = acquireWorkspaceLease(createEmptyWorkspaceLeaseSet(), parent);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const blocked = acquireWorkspaceLease(first.set, childGlob);
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.diagnostics.some((d) => d.code === "workspace_lease_incompatible")).toBe(true);
      expect(blocked.conflictingLeaseIds).toEqual(["lease-parent"]);
    });

    it("allows two exclusive non-overlapping write scopes", () => {
      const left = exclusiveLease("lease-a", ["src"]);
      const right = exclusiveLease("lease-b", ["docs"], "attempt-b");
      expect(workspaceLeasesConflict(left, right)).toBe(false);

      const empty = createEmptyWorkspaceLeaseSet();
      const first = acquireWorkspaceLease(empty, left);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const second = acquireWorkspaceLease(first.set, right);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expectListedIds(second.set, ["lease-a", "lease-b"]);
    });

    it("allows shared leases with each other and with non-overlapping exclusive writes", () => {
      const readA = sharedLease("lease-read-a", ["src"]);
      const readB = sharedLease("lease-read-b", ["src/domain"], "attempt-read-b");
      expect(workspaceLeasesConflict(readA, readB)).toBe(false);

      const writeDocs = exclusiveLease("lease-write-docs", ["docs"], "attempt-write-docs");
      expect(workspaceLeasesConflict(readA, writeDocs)).toBe(false);

      let set = createEmptyWorkspaceLeaseSet();
      for (const lease of [readA, readB, writeDocs]) {
        const result = acquireWorkspaceLease(set, lease);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        set = result.set;
      }
      const listed = listWorkspaceLeases(set);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.leases).toHaveLength(3);
    });

    it("blocks shared read when an exclusive write overlaps the read scope", () => {
      const writeSrc = exclusiveLease("lease-write", ["src"]);
      const readSrc = sharedLease("lease-read", ["src/domain"], "attempt-read");
      expect(workspaceLeasesConflict(writeSrc, readSrc)).toBe(true);

      const first = acquireWorkspaceLease(createEmptyWorkspaceLeaseSet(), writeSrc);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const blocked = canAcquireWorkspaceLease(first.set, readSrc);
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.diagnostics[0]?.code).toBe("workspace_lease_incompatible");
    });

    it("blocks exclusive write when a shared read was acquired first on an overlapping scope", () => {
      const readSrc = sharedLease("lease-read", ["src"]);
      const writeNested = exclusiveLease("lease-write", ["src/domain"], "attempt-write");
      expect(workspaceLeasesConflict(readSrc, writeNested)).toBe(true);

      const first = acquireWorkspaceLease(createEmptyWorkspaceLeaseSet(), readSrc);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const blocked = canAcquireWorkspaceLease(first.set, writeNested);
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.diagnostics[0]?.code).toBe("workspace_lease_incompatible");
    });

    it("blocks shared read against exclusive nested glob write in both acquire orders", () => {
      const sharedParent = sharedLease("lease-read", ["src"]);
      const exclusiveChildGlob = exclusiveLease("lease-write", ["src/domain/**"], "attempt-write");
      expect(workspaceLeasesConflict(sharedParent, exclusiveChildGlob)).toBe(true);
      expect(workspaceLeasesConflict(exclusiveChildGlob, sharedParent)).toBe(true);

      const sharedFirst = acquireWorkspaceLease(createEmptyWorkspaceLeaseSet(), sharedParent);
      expect(sharedFirst.ok).toBe(true);
      if (!sharedFirst.ok) return;
      const blockedWrite = canAcquireWorkspaceLease(sharedFirst.set, exclusiveChildGlob);
      expect(blockedWrite.ok).toBe(false);

      const writeFirst = acquireWorkspaceLease(createEmptyWorkspaceLeaseSet(), exclusiveChildGlob);
      expect(writeFirst.ok).toBe(true);
      if (!writeFirst.ok) return;
      const blockedRead = canAcquireWorkspaceLease(writeFirst.set, sharedParent);
      expect(blockedRead.ok).toBe(false);
    });

    it("blocks any path against a whole-workspace exclusive lease", () => {
      const whole = exclusiveLease("lease-all", ["/**"]);
      const docs = exclusiveLease("lease-docs", ["docs"], "attempt-docs");
      expect(workspaceLeasesConflict(whole, docs)).toBe(true);

      const first = acquireWorkspaceLease(createEmptyWorkspaceLeaseSet(), whole);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const blocked = canAcquireWorkspaceLease(first.set, docs);
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.diagnostics.some((d) => d.code === "workspace_lease_incompatible")).toBe(true);
    });
  });

  describe("acquire, release, and query", () => {
    it("releases a lease so a previously blocked lease can acquire", () => {
      const firstLease = exclusiveLease("lease-a", ["src"]);
      const secondLease = exclusiveLease("lease-b", ["src/foo"], "attempt-b");

      const first = acquireWorkspaceLease(createEmptyWorkspaceLeaseSet(), firstLease);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const blocked = acquireWorkspaceLease(first.set, secondLease);
      expect(blocked.ok).toBe(false);

      const released = releaseWorkspaceLease(first.set, "lease-a");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(true);
      expectListedIds(released.set, []);

      const afterRelease = acquireWorkspaceLease(released.set, secondLease);
      expect(afterRelease.ok).toBe(true);
      if (!afterRelease.ok) return;
      const got = getWorkspaceLease(afterRelease.set, "lease-b");
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.lease?.holder.attemptId).toBe("attempt-b");
    });

    it("trims lease id on get and release", () => {
      const first = acquireWorkspaceLease(
        createEmptyWorkspaceLeaseSet(),
        exclusiveLease("lease-a", ["src"]),
      );
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const got = getWorkspaceLease(first.set, "  lease-a  ");
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.lease?.leaseId).toBe("lease-a");

      const released = releaseWorkspaceLease(first.set, "  lease-a  ");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(true);
      expectListedIds(released.set, []);
    });

    it("rejects duplicate lease ids and duplicate attempt ids among active leases", () => {
      const lease = exclusiveLease("lease-a", ["src"], "attempt-a");
      const first = acquireWorkspaceLease(createEmptyWorkspaceLeaseSet(), lease);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const sameId = acquireWorkspaceLease(first.set, exclusiveLease("lease-a", ["docs"], "attempt-other"));
      expect(sameId.ok).toBe(false);
      if (sameId.ok) return;
      expect(sameId.diagnostics.some((d) => d.code === "workspace_lease_duplicate_id")).toBe(true);

      const sameAttempt = acquireWorkspaceLease(
        first.set,
        exclusiveLease("lease-b", ["docs"], "attempt-a"),
      );
      expect(sameAttempt.ok).toBe(false);
      if (sameAttempt.ok) return;
      expect(sameAttempt.diagnostics.some((d) => d.code === "workspace_lease_duplicate_attempt")).toBe(true);
    });

    it("enforces max active lease bounds", () => {
      const first = acquireWorkspaceLease(
        createEmptyWorkspaceLeaseSet(),
        exclusiveLease("lease-a", ["src"], "attempt-a"),
        { maxActiveLeases: 1 },
      );
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const second = acquireWorkspaceLease(
        first.set,
        exclusiveLease("lease-b", ["docs"], "attempt-b"),
        { maxActiveLeases: 1 },
      );
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.diagnostics.some((d) => d.code === "workspace_lease_active_limit")).toBe(true);
      expect(DEFAULT_MAX_ACTIVE_LEASES).toBeGreaterThan(0);
    });

    it("release of unknown id is a no-op with released false", () => {
      const first = acquireWorkspaceLease(
        createEmptyWorkspaceLeaseSet(),
        exclusiveLease("lease-a", ["src"]),
      );
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const released = releaseWorkspaceLease(first.set, "missing");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(false);
      expectListedIds(released.set, ["lease-a"]);
    });

    it("builds ExecutorWorkspaceLeaseRef from a full lease", () => {
      const lease = exclusiveLease("lease-a", ["src"], "attempt-a", "deadbeef");
      const ref: ExecutorWorkspaceLeaseRef = toExecutorWorkspaceLeaseRef(lease);
      expect(ref).toEqual({ leaseId: "lease-a", baseRevision: "deadbeef" });

      const withoutRevision = toExecutorWorkspaceLeaseRef(exclusiveLease("lease-b", ["docs"]));
      expect(withoutRevision).toEqual({ leaseId: "lease-b" });
      expect("baseRevision" in withoutRevision).toBe(false);
    });

    it("rejects unsupported lease set schema versions on acquire, release, list, and get", () => {
      const diagnostics = validateWorkspaceLeaseSetSchema({
        schemaVersion: 99,
        leases: [],
      });
      expect(diagnostics.some((d) => d.code === "workspace_lease_set_unsupported_schema")).toBe(true);

      const empty = createEmptyWorkspaceLeaseSet();
      expect(empty.schemaVersion).toBe(WORKSPACE_LEASE_SET_SCHEMA_VERSION);
      expect(validateWorkspaceLeaseSetSchema(empty)).toEqual([]);

      const badSet = {
        schemaVersion: 99,
        leases: [exclusiveLease("lease-a", ["src"])],
      } as unknown as WorkspaceLeaseSet;

      const acquire = acquireWorkspaceLease(badSet, exclusiveLease("lease-b", ["docs"], "attempt-b"));
      expect(acquire.ok).toBe(false);
      if (acquire.ok) return;
      expect(acquire.diagnostics.some((d) => d.code === "workspace_lease_set_unsupported_schema")).toBe(true);

      const release = releaseWorkspaceLease(badSet, "lease-a");
      expect(release.ok).toBe(false);
      if (release.ok) return;
      expect(release.diagnostics.some((d) => d.code === "workspace_lease_set_unsupported_schema")).toBe(true);

      const listed = listWorkspaceLeases(badSet);
      expect(listed.ok).toBe(false);
      if (listed.ok) return;
      expect(listed.diagnostics.some((d) => d.code === "workspace_lease_set_unsupported_schema")).toBe(true);

      const got = getWorkspaceLease(badSet, "lease-a");
      expect(got.ok).toBe(false);
      if (got.ok) return;
      expect(got.diagnostics.some((d) => d.code === "workspace_lease_set_unsupported_schema")).toBe(true);
    });
  });

  describe("purity", () => {
    it("does not mutate input set or candidate on acquire and release", () => {
      const candidate = exclusiveLease("lease-a", ["src"]);
      const candidateSnapshot = structuredClone(candidate);
      const empty = createEmptyWorkspaceLeaseSet();
      const emptySnapshot = structuredClone(empty);

      const acquired = acquireWorkspaceLease(empty, candidate);
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      expect(candidate).toEqual(candidateSnapshot);
      expect(empty).toEqual(emptySnapshot);

      const setSnapshot = structuredClone(acquired.set);
      const released = releaseWorkspaceLease(acquired.set, "lease-a");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(true);
      expect(acquired.set).toEqual(setSnapshot);
      expectListedIds(acquired.set, ["lease-a"]);
      expectListedIds(released.set, []);

      // Mutating returned leases must not affect the set.
      const listed = listWorkspaceLeases(acquired.set);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      listed.leases[0]!.paths.writePaths.push("mutated");
      const got = getWorkspaceLease(acquired.set, "lease-a");
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.lease?.paths.writePaths).toEqual(["src"]);
    });

    it("parse and validate do not mutate the raw lease object", () => {
      const raw = {
        leaseId: "lease-a",
        mode: "exclusive" as const,
        holder: holder("attempt-a"),
        paths: {
          readPaths: ["src"],
          writePaths: ["src"],
        },
      };
      const snapshot = structuredClone(raw);
      expect(validateWorkspaceLease(raw)).toEqual([]);
      const parsed = parseWorkspaceLease(raw);
      expect(parsed.ok).toBe(true);
      expect(raw).toEqual(snapshot);
      if (!parsed.ok) return;
      parsed.value.paths.writePaths.push("mutated");
      expect(raw.paths.writePaths).toEqual(["src"]);
    });
  });
});
