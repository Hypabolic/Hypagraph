import { describe, expect, it } from "vitest";
import {
  DERIVED_FAN_OUT_SCHEMA_VERSION,
  appendDerivedBranchEvidence,
  areAllDerivedBranchesTerminal,
  completeDerivedBranch,
  derivedBranchId,
  evaluateDerivedFanIn,
  expandDerivedFanOutRegion,
  getDerivedBranch,
  listDerivedBranches,
  parseDerivedFanOutExpansion,
  parseDerivedFanOutRegionDefinition,
  startDerivedBranchAttempt,
  validateDerivedFanOutExpansion,
  validateDerivedFanOutExpansionSchema,
  validateDerivedFanOutRegionDefinition,
  type DerivedFanOutExpansion,
  type DerivedFanOutRegionDefinition,
} from "../src/domain/derived-fan-out.js";

const region = (
  overrides: Partial<DerivedFanOutRegionDefinition> = {},
): DerivedFanOutRegionDefinition => ({
  id: "review-files",
  collectionFact: "changed.files",
  maxBranches: 8,
  fanInPolicy: "require-all-success",
  ...overrides,
});

const expandOk = (
  def: DerivedFanOutRegionDefinition,
  values: string[],
): DerivedFanOutExpansion => {
  const result = expandDerivedFanOutRegion(def, values);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => d.message).join("; "));
  }
  return result.expansion;
};

const schemaOnly = (): DerivedFanOutExpansion =>
  ({ schemaVersion: DERIVED_FAN_OUT_SCHEMA_VERSION } as DerivedFanOutExpansion);

const unsupportedSchema = (expansion: DerivedFanOutExpansion): DerivedFanOutExpansion =>
  ({ ...expansion, schemaVersion: 99 } as unknown as DerivedFanOutExpansion);

describe("m8.1-s1 derived fan-out from typed collection fact", () => {
  describe("definition validation", () => {
    it("accepts a valid derived fan-out region definition", () => {
      const diagnostics = validateDerivedFanOutRegionDefinition(region());
      expect(diagnostics).toEqual([]);

      const parsed = parseDerivedFanOutRegionDefinition(region());
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.id).toBe("review-files");
      expect(parsed.value.collectionFact).toBe("changed.files");
      expect(parsed.value.maxBranches).toBe(8);
      expect(parsed.value.fanInPolicy).toBe("require-all-success");
    });

    it("rejects empty id, missing collection fact, invalid max, and invalid policy", () => {
      const emptyId = validateDerivedFanOutRegionDefinition(region({ id: "  " }));
      expect(emptyId.some((d) => d.code === "derived_fan_out_invalid_id")).toBe(true);

      const badFact = validateDerivedFanOutRegionDefinition(region({ collectionFact: "" }));
      expect(badFact.some((d) => d.code === "derived_fan_out_invalid_collection_fact")).toBe(true);

      const zeroMax = validateDerivedFanOutRegionDefinition(region({ maxBranches: 0 }));
      expect(zeroMax.some((d) => d.code === "derived_fan_out_invalid_max_branches")).toBe(true);

      const badPolicy = validateDerivedFanOutRegionDefinition({
        ...region(),
        fanInPolicy: "best-effort",
      });
      expect(badPolicy.some((d) => d.code === "derived_fan_out_invalid_fan_in_policy")).toBe(true);
    });

    it("rejects class instances and non-plain objects", () => {
      class RegionClass {
        id = "review-files";
        collectionFact = "changed.files";
        maxBranches = 4;
        fanInPolicy = "fail-all";
      }
      const classInstance = validateDerivedFanOutRegionDefinition(new RegionClass());
      expect(classInstance.some((d) => d.code === "derived_fan_out_not_plain_object")).toBe(true);

      const arrayValue = validateDerivedFanOutRegionDefinition([]);
      expect(arrayValue.some((d) => d.code === "derived_fan_out_not_plain_object")).toBe(true);
    });
  });

  describe("expansion from string-list fact", () => {
    it("expands N branches from a string-list fact of length N when N is at most max", () => {
      const values = ["src/a.ts", "src/b.ts", "docs/readme.md"];
      const expansion = expandOk(region({ maxBranches: 8 }), values);

      expect(expansion.schemaVersion).toBe(DERIVED_FAN_OUT_SCHEMA_VERSION);
      expect(expansion.regionId).toBe("review-files");
      expect(expansion.collectionFact).toBe("changed.files");
      expect(expansion.collectionValues).toEqual(values);
      expect(expansion.usedAttemptIds).toEqual([]);
      expect(expansion.branches).toHaveLength(3);

      for (let index = 0; index < values.length; index += 1) {
        const branch = expansion.branches[index]!;
        expect(branch.branchId).toBe(derivedBranchId("review-files", index));
        expect(branch.regionId).toBe("review-files");
        expect(branch.index).toBe(index);
        expect(branch.itemValue).toBe(values[index]);
        expect(branch.status).toBe("pending");
        expect(branch.attemptNumber).toBe(0);
        expect(branch.attemptId).toBeUndefined();
        expect(branch.evidence).toEqual([]);
      }
    });

    it("rejects a collection larger than maxBranches without truncation", () => {
      const values = ["a", "b", "c", "d"];
      const result = expandDerivedFanOutRegion(region({ maxBranches: 3 }), values);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics.some((d) => d.code === "derived_fan_out_collection_exceeds_max")).toBe(true);
      expect(result.diagnostics[0]!.message).toMatch(/does not truncate/);
    });

    it("rejects a non-array collection and non-string items", () => {
      const notArray = expandDerivedFanOutRegion(region(), "not-a-list");
      expect(notArray.ok).toBe(false);
      if (notArray.ok) return;
      expect(notArray.diagnostics.some((d) => d.code === "derived_fan_out_collection_not_array")).toBe(true);

      const badItem = expandDerivedFanOutRegion(region(), ["ok", 42 as unknown as string]);
      expect(badItem.ok).toBe(false);
      if (badItem.ok) return;
      expect(badItem.diagnostics.some((d) => d.code === "derived_fan_out_collection_item_invalid")).toBe(true);
    });

    it("produces stable branch identities across two expand calls with the same inputs", () => {
      const def = region({ fanInPolicy: "fail-all" });
      const values = ["pkg/alpha", "pkg/beta", "pkg/alpha"];

      const first = expandOk(def, values);
      const second = expandOk(def, values);

      expect(first.branches.map((b) => b.branchId)).toEqual(
        second.branches.map((b) => b.branchId),
      );
      expect(first.branches.map((b) => b.itemValue)).toEqual(values);
      expect(first.branches[0]!.branchId).not.toBe(first.branches[2]!.branchId);
      expect(first.branches[0]!.branchId).toBe("review-files/item/0");
      expect(first.branches[2]!.branchId).toBe("review-files/item/2");
    });

    it("allows an empty collection and expands to zero branches", () => {
      const expansion = expandOk(region(), []);
      expect(expansion.branches).toEqual([]);
      expect(expansion.collectionValues).toEqual([]);
      expect(expansion.usedAttemptIds).toEqual([]);

      const fanIn = evaluateDerivedFanIn(expansion);
      expect(fanIn.ok).toBe(true);
      if (!fanIn.ok) return;
      expect(fanIn.result.status).toBe("succeeded");
      expect(fanIn.result.reason).toMatch(/Empty branch set/);
    });
  });

  describe("branch attempt, evidence, and status", () => {
    it("gives each branch independent attempt, evidence, and status fields", () => {
      const expansion = expandOk(region(), ["file-a", "file-b"]);

      const startedA = startDerivedBranchAttempt(expansion, expansion.branches[0]!.branchId, "attempt-a-1");
      expect(startedA.ok).toBe(true);
      if (!startedA.ok) return;
      expect(startedA.expansion.usedAttemptIds).toEqual(["attempt-a-1"]);

      const withEvidence = appendDerivedBranchEvidence(
        startedA.expansion,
        expansion.branches[0]!.branchId,
        [{ ref: "ev-a", kind: "file", summary: "diff for file-a" }],
      );
      expect(withEvidence.ok).toBe(true);
      if (!withEvidence.ok) return;

      const doneA = completeDerivedBranch(
        withEvidence.expansion,
        expansion.branches[0]!.branchId,
        "succeeded",
        { evidence: [{ ref: "ev-a-done", kind: "note" }] },
      );
      expect(doneA.ok).toBe(true);
      if (!doneA.ok) return;

      const startedB = startDerivedBranchAttempt(
        doneA.expansion,
        expansion.branches[1]!.branchId,
        "attempt-b-1",
      );
      expect(startedB.ok).toBe(true);
      if (!startedB.ok) return;

      const failedB = completeDerivedBranch(
        startedB.expansion,
        expansion.branches[1]!.branchId,
        "failed",
        { failureReason: "lint failed" },
      );
      expect(failedB.ok).toBe(true);
      if (!failedB.ok) return;

      const branchA = getDerivedBranch(failedB.expansion, "review-files/item/0");
      const branchB = getDerivedBranch(failedB.expansion, "review-files/item/1");
      expect(branchA.ok).toBe(true);
      expect(branchB.ok).toBe(true);
      if (!branchA.ok || !branchB.ok) return;

      expect(branchA.branch?.status).toBe("succeeded");
      expect(branchA.branch?.attemptId).toBe("attempt-a-1");
      expect(branchA.branch?.attemptNumber).toBe(1);
      expect(branchA.branch?.evidence.map((e) => e.ref)).toEqual(["ev-a", "ev-a-done"]);

      expect(branchB.branch?.status).toBe("failed");
      expect(branchB.branch?.attemptId).toBe("attempt-b-1");
      expect(branchB.branch?.attemptNumber).toBe(1);
      expect(branchB.branch?.failureReason).toBe("lint failed");
      expect(branchB.branch?.evidence).toEqual([]);
      expect(failedB.expansion.usedAttemptIds).toEqual(["attempt-a-1", "attempt-b-1"]);
    });

    it("rejects duplicate attempt ids across branches and reuses after retry", () => {
      const expansion = expandOk(region(), ["a", "b"]);
      const first = startDerivedBranchAttempt(expansion, "review-files/item/0", "shared-attempt");
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const second = startDerivedBranchAttempt(first.expansion, "review-files/item/1", "shared-attempt");
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.diagnostics.some((d) => d.code === "derived_fan_out_duplicate_attempt_id")).toBe(true);

      // While running, a second start is rejected for status before attempt-id checks.
      const sameWhileRunning = startDerivedBranchAttempt(
        first.expansion,
        "review-files/item/0",
        "other-attempt",
      );
      expect(sameWhileRunning.ok).toBe(false);
      if (!sameWhileRunning.ok) {
        expect(sameWhileRunning.diagnostics.some((d) => d.code === "derived_fan_out_invalid_status")).toBe(true);
      }

      // Fail branch 0, reject reuse of the same attempt id on retry, then accept a new id.
      const failed = completeDerivedBranch(first.expansion, "review-files/item/0", "failed");
      expect(failed.ok).toBe(true);
      if (!failed.ok) return;

      const sameAfterFail = startDerivedBranchAttempt(
        failed.expansion,
        "review-files/item/0",
        "shared-attempt",
      );
      expect(sameAfterFail.ok).toBe(false);
      if (!sameAfterFail.ok) {
        expect(sameAfterFail.diagnostics.some((d) => d.code === "derived_fan_out_duplicate_attempt_id")).toBe(true);
      }

      const retry = startDerivedBranchAttempt(failed.expansion, "review-files/item/0", "retry-attempt");
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.expansion.branches[0]!.attemptNumber).toBe(2);
      expect(retry.expansion.usedAttemptIds).toEqual(["shared-attempt", "retry-attempt"]);

      const reuseStale = startDerivedBranchAttempt(
        retry.expansion,
        "review-files/item/1",
        "shared-attempt",
      );
      expect(reuseStale.ok).toBe(false);
      if (reuseStale.ok) return;
      expect(reuseStale.diagnostics.some((d) => d.code === "derived_fan_out_duplicate_attempt_id")).toBe(true);
    });

    it("allows start only from pending or failed, and rejects running, succeeded, and cancelled", () => {
      const expansion = expandOk(region(), ["a"]);
      const started = startDerivedBranchAttempt(expansion, "review-files/item/0", "a1");
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      // In-flight running attempt must not be replaced by a second start.
      const startWhileRunning = startDerivedBranchAttempt(
        started.expansion,
        "review-files/item/0",
        "a2",
      );
      expect(startWhileRunning.ok).toBe(false);
      if (!startWhileRunning.ok) {
        expect(startWhileRunning.diagnostics.some((d) => d.code === "derived_fan_out_invalid_status")).toBe(true);
        expect(startWhileRunning.diagnostics[0]!.message).toMatch(/pending or failed/);
      }

      const succeeded = completeDerivedBranch(started.expansion, "review-files/item/0", "succeeded");
      expect(succeeded.ok).toBe(true);
      if (!succeeded.ok) return;
      const restartOk = startDerivedBranchAttempt(succeeded.expansion, "review-files/item/0", "a3");
      expect(restartOk.ok).toBe(false);
      if (restartOk.ok) return;
      expect(restartOk.diagnostics.some((d) => d.code === "derived_fan_out_invalid_status")).toBe(true);

      const cancelledBase = expandOk(region(), ["b"]);
      const cancelled = completeDerivedBranch(cancelledBase, "review-files/item/0", "cancelled");
      expect(cancelled.ok).toBe(true);
      if (!cancelled.ok) return;
      const restartCancelled = startDerivedBranchAttempt(
        cancelled.expansion,
        "review-files/item/0",
        "c1",
      );
      expect(restartCancelled.ok).toBe(false);
      if (restartCancelled.ok) return;
      expect(restartCancelled.diagnostics.some((d) => d.code === "derived_fan_out_invalid_status")).toBe(true);
    });

    it("requires a running attempt for succeeded or failed and rejects terminal rewrite", () => {
      const expansion = expandOk(region(), ["a"]);

      const pendingToSucceeded = completeDerivedBranch(
        expansion,
        "review-files/item/0",
        "succeeded",
      );
      expect(pendingToSucceeded.ok).toBe(false);
      if (pendingToSucceeded.ok) return;
      expect(pendingToSucceeded.diagnostics.some((d) => d.code === "derived_fan_out_invalid_status")).toBe(true);

      const pendingToFailed = completeDerivedBranch(expansion, "review-files/item/0", "failed");
      expect(pendingToFailed.ok).toBe(false);
      if (pendingToFailed.ok) return;
      expect(pendingToFailed.diagnostics.some((d) => d.code === "derived_fan_out_invalid_status")).toBe(true);

      const cancelledFromPending = completeDerivedBranch(
        expansion,
        "review-files/item/0",
        "cancelled",
      );
      expect(cancelledFromPending.ok).toBe(true);

      const started = startDerivedBranchAttempt(expansion, "review-files/item/0", "a1");
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const succeeded = completeDerivedBranch(started.expansion, "review-files/item/0", "succeeded");
      expect(succeeded.ok).toBe(true);
      if (!succeeded.ok) return;

      const rewrite = completeDerivedBranch(succeeded.expansion, "review-files/item/0", "failed");
      expect(rewrite.ok).toBe(false);
      if (rewrite.ok) return;
      expect(rewrite.diagnostics.some((d) => d.code === "derived_fan_out_invalid_status")).toBe(true);
      expect(rewrite.diagnostics[0]!.message).toMatch(/already 'succeeded'/);
    });

    it("rejects unknown and empty branchId on lifecycle helpers with distinct codes", () => {
      const expansion = expandOk(region(), ["a"]);

      const emptyStart = startDerivedBranchAttempt(expansion, "  ", "a1");
      expect(emptyStart.ok).toBe(false);
      if (!emptyStart.ok) {
        expect(emptyStart.diagnostics.some((d) => d.code === "derived_fan_out_invalid_branch_id_argument")).toBe(true);
      }

      const missingStart = startDerivedBranchAttempt(expansion, "review-files/item/9", "a1");
      expect(missingStart.ok).toBe(false);
      if (!missingStart.ok) {
        expect(missingStart.diagnostics.some((d) => d.code === "derived_fan_out_branch_not_found")).toBe(true);
      }

      const emptyComplete = completeDerivedBranch(expansion, "", "cancelled");
      expect(emptyComplete.ok).toBe(false);
      if (!emptyComplete.ok) {
        expect(emptyComplete.diagnostics.some((d) => d.code === "derived_fan_out_invalid_branch_id_argument")).toBe(true);
      }

      const missingComplete = completeDerivedBranch(expansion, "nope", "cancelled");
      expect(missingComplete.ok).toBe(false);
      if (!missingComplete.ok) {
        expect(missingComplete.diagnostics.some((d) => d.code === "derived_fan_out_branch_not_found")).toBe(true);
      }

      const emptyEvidence = appendDerivedBranchEvidence(expansion, " ", [{ ref: "e1" }]);
      expect(emptyEvidence.ok).toBe(false);
      if (!emptyEvidence.ok) {
        expect(emptyEvidence.diagnostics.some((d) => d.code === "derived_fan_out_invalid_branch_id_argument")).toBe(true);
      }

      const emptyAttemptId = startDerivedBranchAttempt(expansion, "review-files/item/0", "  ");
      expect(emptyAttemptId.ok).toBe(false);
      if (!emptyAttemptId.ok) {
        expect(emptyAttemptId.diagnostics.some((d) => d.code === "derived_fan_out_invalid_attempt_id")).toBe(true);
      }
    });

    it("rejects invalid evidence lists", () => {
      const expansion = expandOk(region(), ["a"]);
      const notArray = appendDerivedBranchEvidence(
        expansion,
        "review-files/item/0",
        "nope" as unknown as [],
      );
      expect(notArray.ok).toBe(false);
      if (!notArray.ok) {
        expect(notArray.diagnostics.some((d) => d.code === "derived_fan_out_invalid_evidence")).toBe(true);
      }

      const badEntry = appendDerivedBranchEvidence(expansion, "review-files/item/0", [
        1 as unknown as { ref: string },
      ]);
      expect(badEntry.ok).toBe(false);
      if (!badEntry.ok) {
        expect(badEntry.diagnostics.some((d) => d.code === "derived_fan_out_invalid_evidence")).toBe(true);
      }

      const missingRef = appendDerivedBranchEvidence(expansion, "review-files/item/0", [
        { ref: "  " },
      ]);
      expect(missingRef.ok).toBe(false);
      if (!missingRef.ok) {
        expect(missingRef.diagnostics.some((d) => d.code === "derived_fan_out_invalid_evidence")).toBe(true);
      }

      const badKind = appendDerivedBranchEvidence(expansion, "review-files/item/0", [
        { ref: "e1", kind: "mystery" as "file" },
      ]);
      expect(badKind.ok).toBe(false);
      if (!badKind.ok) {
        expect(badKind.diagnostics.some((d) => d.code === "derived_fan_out_invalid_evidence")).toBe(true);
      }

      const badVisibility = appendDerivedBranchEvidence(expansion, "review-files/item/0", [
        { ref: "e1", visibility: "secret" as "public" },
      ]);
      expect(badVisibility.ok).toBe(false);
      if (!badVisibility.ok) {
        expect(badVisibility.diagnostics.some((d) => d.code === "derived_fan_out_invalid_evidence")).toBe(true);
      }
    });

    it("lists branches in collection index order", () => {
      const expansion = expandOk(region(), ["z", "a", "m"]);
      const listed = listDerivedBranches(expansion);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.branches.map((b) => b.index)).toEqual([0, 1, 2]);
      expect(listed.branches.map((b) => b.itemValue)).toEqual(["z", "a", "m"]);
    });

    it("rejects invalid branchId on getDerivedBranch and returns undefined for an absent valid id", () => {
      const expansion = expandOk(region(), ["a"]);
      const empty = getDerivedBranch(expansion, "  ");
      expect(empty.ok).toBe(false);
      if (!empty.ok) {
        expect(empty.diagnostics.some((d) => d.code === "derived_fan_out_invalid_branch_id_argument")).toBe(true);
      }

      const nonString = getDerivedBranch(expansion, 12 as unknown as string);
      expect(nonString.ok).toBe(false);
      if (!nonString.ok) {
        expect(nonString.diagnostics.some((d) => d.code === "derived_fan_out_invalid_branch_id_argument")).toBe(true);
      }

      const missing = getDerivedBranch(expansion, "review-files/item/9");
      expect(missing.ok).toBe(true);
      if (!missing.ok) return;
      expect(missing.branch).toBeUndefined();
    });
  });

  describe("fan-in policy", () => {
    const completeAll = (
      expansion: DerivedFanOutExpansion,
      outcomes: Array<"succeeded" | "failed" | "cancelled">,
    ): DerivedFanOutExpansion => {
      let current = expansion;
      for (let index = 0; index < outcomes.length; index += 1) {
        const branchId = current.branches[index]!.branchId;
        const outcome = outcomes[index]!;
        if (outcome === "cancelled" && current.branches[index]!.status === "pending") {
          const done = completeDerivedBranch(current, branchId, "cancelled");
          expect(done.ok).toBe(true);
          if (!done.ok) throw new Error("cancel failed");
          current = done.expansion;
          continue;
        }
        const started = startDerivedBranchAttempt(current, branchId, `attempt-${index}`);
        expect(started.ok).toBe(true);
        if (!started.ok) throw new Error("start failed");
        const done = completeDerivedBranch(started.expansion, branchId, outcome);
        expect(done.ok).toBe(true);
        if (!done.ok) throw new Error("complete failed");
        current = done.expansion;
      }
      return current;
    };

    it("waits for every branch before it applies policy", () => {
      const expansion = expandOk(region({ fanInPolicy: "fail-all" }), ["a", "b"]);
      const started = startDerivedBranchAttempt(expansion, "review-files/item/0", "a1");
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      const partial = completeDerivedBranch(
        started.expansion,
        "review-files/item/0",
        "succeeded",
      );
      expect(partial.ok).toBe(true);
      if (!partial.ok) return;

      const terminal = areAllDerivedBranchesTerminal(partial.expansion);
      expect(terminal.ok).toBe(true);
      if (!terminal.ok) return;
      expect(terminal.terminal).toBe(false);

      const fanIn = evaluateDerivedFanIn(partial.expansion);
      expect(fanIn.ok).toBe(true);
      if (!fanIn.ok) return;
      expect(fanIn.result.status).toBe("pending");
      expect(fanIn.result.pendingBranchIds).toEqual(["review-files/item/1"]);
      expect(fanIn.result.reason).toBe("Fan-in waits for 1 branch that is not terminal.");
    });

    it("applies fail-all when any branch fails", () => {
      const base = expandOk(region({ fanInPolicy: "fail-all" }), ["a", "b"]);
      const done = completeAll(base, ["succeeded", "failed"]);
      const fanIn = evaluateDerivedFanIn(done);
      expect(fanIn.ok).toBe(true);
      if (!fanIn.ok) return;
      expect(fanIn.result.status).toBe("failed");
      expect(fanIn.result.failedBranchIds).toEqual(["review-files/item/1"]);
      expect(fanIn.result.succeededBranchIds).toEqual(["review-files/item/0"]);
    });

    it("applies continue-with-successes when some branches fail", () => {
      const base = expandOk(region({ fanInPolicy: "continue-with-successes" }), ["a", "b", "c"]);
      const done = completeAll(base, ["succeeded", "failed", "succeeded"]);
      const fanIn = evaluateDerivedFanIn(done);
      expect(fanIn.ok).toBe(true);
      if (!fanIn.ok) return;
      expect(fanIn.result.status).toBe("succeeded");
      expect(fanIn.result.succeededBranchIds).toEqual([
        "review-files/item/0",
        "review-files/item/2",
      ]);
      expect(fanIn.result.failedBranchIds).toEqual(["review-files/item/1"]);
    });

    it("fails continue-with-successes when no branch succeeds and one fails", () => {
      const base = expandOk(region({ fanInPolicy: "continue-with-successes" }), ["a", "b"]);
      const done = completeAll(base, ["failed", "cancelled"]);
      const fanIn = evaluateDerivedFanIn(done);
      expect(fanIn.ok).toBe(true);
      if (!fanIn.ok) return;
      expect(fanIn.result.status).toBe("failed");
    });

    it("succeeds continue-with-successes when every branch is cancelled", () => {
      const base = expandOk(region({ fanInPolicy: "continue-with-successes" }), ["a", "b"]);
      const done = completeAll(base, ["cancelled", "cancelled"]);
      const fanIn = evaluateDerivedFanIn(done);
      expect(fanIn.ok).toBe(true);
      if (!fanIn.ok) return;
      expect(fanIn.result.status).toBe("succeeded");
      expect(fanIn.result.reason).toMatch(/all branches cancelled/);
    });

    it("applies require-all-success only when every branch succeeds", () => {
      const base = expandOk(region({ fanInPolicy: "require-all-success" }), ["a", "b"]);
      const allOk = completeAll(base, ["succeeded", "succeeded"]);
      const okFanIn = evaluateDerivedFanIn(allOk);
      expect(okFanIn.ok).toBe(true);
      if (!okFanIn.ok) return;
      expect(okFanIn.result.status).toBe("succeeded");

      const partial = completeAll(base, ["succeeded", "failed"]);
      const failFanIn = evaluateDerivedFanIn(partial);
      expect(failFanIn.ok).toBe(true);
      if (!failFanIn.ok) return;
      expect(failFanIn.result.status).toBe("failed");

      const withCancel = completeAll(base, ["succeeded", "cancelled"]);
      const cancelFanIn = evaluateDerivedFanIn(withCancel);
      expect(cancelFanIn.ok).toBe(true);
      if (!cancelFanIn.ok) return;
      expect(cancelFanIn.result.status).toBe("failed");
    });

    it("treats fail-all as succeeded when branches only cancel", () => {
      const base = expandOk(region({ fanInPolicy: "fail-all" }), ["a"]);
      const done = completeAll(base, ["cancelled"]);
      const fanIn = evaluateDerivedFanIn(done);
      expect(fanIn.ok).toBe(true);
      if (!fanIn.ok) return;
      expect(fanIn.result.status).toBe("succeeded");
    });
  });

  describe("schema restore and unsupported version", () => {
    it("rejects an unsupported expansion schema version with a clear error", () => {
      const expansion = expandOk(region(), ["a"]);
      const bad = unsupportedSchema(expansion);

      const schema = validateDerivedFanOutExpansionSchema(bad);
      expect(schema.some((d) => d.code === "derived_fan_out_unsupported_schema")).toBe(true);
      expect(schema[0]!.message).toMatch(/Expected 1/);

      const full = validateDerivedFanOutExpansion(bad);
      expect(full.some((d) => d.code === "derived_fan_out_unsupported_schema")).toBe(true);

      for (const result of [
        listDerivedBranches(bad),
        evaluateDerivedFanIn(bad),
        getDerivedBranch(bad, "review-files/item/0"),
        areAllDerivedBranchesTerminal(bad),
        startDerivedBranchAttempt(bad, "review-files/item/0", "a1"),
        completeDerivedBranch(bad, "review-files/item/0", "cancelled"),
        appendDerivedBranchEvidence(bad, "review-files/item/0", [{ ref: "e" }]),
      ]) {
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.diagnostics.some((d) => d.code === "derived_fan_out_unsupported_schema")).toBe(true);
      }
    });

    it("rejects schemaVersion-only records that omit structural arrays on every guarded helper", () => {
      const bare = schemaOnly();
      const schema = validateDerivedFanOutExpansionSchema(bare);
      expect(schema.some((d) => d.code === "derived_fan_out_collection_not_array")).toBe(true);
      expect(schema.some((d) => d.code === "derived_fan_out_invalid_branches")).toBe(true);
      expect(schema.some((d) => d.code === "derived_fan_out_invalid_used_attempt_ids")).toBe(true);

      expect(listDerivedBranches(bare).ok).toBe(false);
      expect(evaluateDerivedFanIn(bare).ok).toBe(false);
      expect(getDerivedBranch(bare, "x").ok).toBe(false);
      expect(areAllDerivedBranchesTerminal(bare).ok).toBe(false);
      expect(startDerivedBranchAttempt(bare, "x", "a").ok).toBe(false);
      expect(completeDerivedBranch(bare, "x", "cancelled").ok).toBe(false);
      expect(appendDerivedBranchEvidence(bare, "x", [{ ref: "e" }]).ok).toBe(false);
    });

    it("rejects malformed branch elements on every guarded helper without throwing", () => {
      const base = expandOk(region(), ["a"]);
      const wellFormedShell = {
        schemaVersion: DERIVED_FAN_OUT_SCHEMA_VERSION,
        regionId: base.regionId,
        collectionFact: base.collectionFact,
        collectionValues: base.collectionValues,
        fanInPolicy: base.fanInPolicy,
        maxBranches: base.maxBranches,
        usedAttemptIds: [],
      };

      const emptyObjectBranch = {
        ...wellFormedShell,
        branches: [{}],
      } as unknown as DerivedFanOutExpansion;
      const nullBranch = {
        ...wellFormedShell,
        branches: [null],
      } as unknown as DerivedFanOutExpansion;
      const missingEvidence = {
        ...wellFormedShell,
        branches: [{
          ...base.branches[0]!,
          evidence: undefined,
        }],
      } as unknown as DerivedFanOutExpansion;

      for (const corrupt of [emptyObjectBranch, nullBranch, missingEvidence]) {
        const schema = validateDerivedFanOutExpansionSchema(corrupt);
        expect(schema.length).toBeGreaterThan(0);

        const helpers = [
          listDerivedBranches(corrupt),
          evaluateDerivedFanIn(corrupt),
          getDerivedBranch(corrupt, "review-files/item/0"),
          areAllDerivedBranchesTerminal(corrupt),
          startDerivedBranchAttempt(corrupt, "review-files/item/0", "a1"),
          completeDerivedBranch(corrupt, "review-files/item/0", "cancelled"),
          appendDerivedBranchEvidence(corrupt, "review-files/item/0", [{ ref: "e" }]),
        ];
        for (const result of helpers) {
          expect(result.ok).toBe(false);
          if (result.ok) continue;
          expect(result.diagnostics.length).toBeGreaterThan(0);
        }
      }

      // Empty object branch: status and evidence shape failures.
      const emptyDiags = validateDerivedFanOutExpansionSchema(emptyObjectBranch);
      expect(emptyDiags.some((d) => d.code === "derived_fan_out_invalid_status")).toBe(true);
      expect(emptyDiags.some((d) => d.code === "derived_fan_out_invalid_evidence")).toBe(true);

      // Null branch: structural branch failure.
      const nullDiags = validateDerivedFanOutExpansionSchema(nullBranch);
      expect(nullDiags.some((d) => d.code === "derived_fan_out_invalid_branches")).toBe(true);

      // Missing evidence only.
      const missingEvidenceDiags = validateDerivedFanOutExpansionSchema(missingEvidence);
      expect(missingEvidenceDiags.some((d) => d.code === "derived_fan_out_invalid_evidence")).toBe(true);
    });

    it("rejects a non-plain expansion object", () => {
      const schema = validateDerivedFanOutExpansionSchema([]);
      expect(schema.some((d) => d.code === "derived_fan_out_expansion_not_plain_object")).toBe(true);
    });

    it("restores a valid expansion through parse and rejects integrity breaks", () => {
      const base = expandOk(region(), ["x", "y"]);
      const withAttempt = startDerivedBranchAttempt(base, "review-files/item/0", "a1");
      expect(withAttempt.ok).toBe(true);
      if (!withAttempt.ok) return;

      const restored = parseDerivedFanOutExpansion(structuredClone(withAttempt.expansion));
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.value.branches.map((b) => b.branchId)).toEqual([
        "review-files/item/0",
        "review-files/item/1",
      ]);
      expect(restored.value.usedAttemptIds).toEqual(["a1"]);

      const missingRegion = structuredClone(withAttempt.expansion) as unknown as Record<string, unknown>;
      const branches = missingRegion.branches as Array<Record<string, unknown>>;
      delete branches[0]!.regionId;
      const missingRegionDiags = validateDerivedFanOutExpansion(missingRegion);
      expect(missingRegionDiags.some((d) => d.code === "derived_fan_out_invalid_branch_region_id")).toBe(true);
      const missingRegionParse = parseDerivedFanOutExpansion(missingRegion);
      expect(missingRegionParse.ok).toBe(false);
      if (!missingRegionParse.ok) {
        expect(missingRegionParse.diagnostics.some((d) => d.code === "derived_fan_out_invalid_branch_region_id")).toBe(true);
      }

      const numericRegion = structuredClone(withAttempt.expansion) as unknown as Record<string, unknown>;
      (numericRegion.branches as Array<Record<string, unknown>>)[0]!.regionId = 42;
      const numericRegionDiags = validateDerivedFanOutExpansion(numericRegion);
      expect(numericRegionDiags.some((d) => d.code === "derived_fan_out_invalid_branch_region_id")).toBe(true);
      expect(parseDerivedFanOutExpansion(numericRegion).ok).toBe(false);

      const brokenId = structuredClone(withAttempt.expansion);
      brokenId.branches[0]!.branchId = "review-files/item/9";
      const badId = validateDerivedFanOutExpansion(brokenId);
      expect(badId.some((d) => d.code === "derived_fan_out_branch_identity_mismatch")).toBe(true);

      const duplicate = structuredClone(withAttempt.expansion);
      duplicate.branches[1]!.branchId = duplicate.branches[0]!.branchId;
      const dup = validateDerivedFanOutExpansion(duplicate);
      expect(dup.some((d) => d.code === "derived_fan_out_duplicate_branch_id")).toBe(true);

      const exceeds = {
        ...structuredClone(withAttempt.expansion),
        maxBranches: 1,
        collectionValues: ["x", "y"],
      };
      const maxDiag = validateDerivedFanOutExpansion(exceeds);
      expect(maxDiag.some((d) => d.code === "derived_fan_out_collection_exceeds_max")).toBe(true);

      const startedB = startDerivedBranchAttempt(withAttempt.expansion, "review-files/item/1", "a2");
      expect(startedB.ok).toBe(true);
      if (!startedB.ok) return;
      const clash = structuredClone(startedB.expansion);
      clash.branches[1]!.attemptId = clash.branches[0]!.attemptId!;
      const clashDiags = validateDerivedFanOutExpansion(clash);
      expect(clashDiags.some((d) => d.code === "derived_fan_out_duplicate_attempt_id")).toBe(true);
      expect(parseDerivedFanOutExpansion(clash).ok).toBe(false);

      const unrecorded = structuredClone(startedB.expansion);
      unrecorded.usedAttemptIds = ["a1"];
      // branch 1 still holds a2 which is no longer recorded
      const unrecordedDiags = validateDerivedFanOutExpansion(unrecorded);
      expect(unrecordedDiags.some((d) => d.code === "derived_fan_out_attempt_id_not_recorded")).toBe(true);

      const badStatus = structuredClone(withAttempt.expansion);
      (badStatus.branches[0] as { status: string }).status = "flying";
      expect(validateDerivedFanOutExpansion(badStatus).some((d) => d.code === "derived_fan_out_invalid_status")).toBe(true);

      const badAttemptNumber = structuredClone(withAttempt.expansion);
      badAttemptNumber.branches[0]!.attemptNumber = -1;
      expect(validateDerivedFanOutExpansion(badAttemptNumber).some((d) => d.code === "derived_fan_out_invalid_attempt_number")).toBe(true);

      const indexMismatch = structuredClone(withAttempt.expansion);
      indexMismatch.branches[0]!.index = 1;
      expect(validateDerivedFanOutExpansion(indexMismatch).some((d) => d.code === "derived_fan_out_invalid_branch_index")).toBe(true);

      const itemMismatch = structuredClone(withAttempt.expansion);
      itemMismatch.branches[0]!.itemValue = "other";
      expect(validateDerivedFanOutExpansion(itemMismatch).some((d) => d.code === "derived_fan_out_item_value_mismatch")).toBe(true);

      const countMismatch = structuredClone(withAttempt.expansion);
      countMismatch.branches = [countMismatch.branches[0]!];
      expect(validateDerivedFanOutExpansion(countMismatch).some((d) => d.code === "derived_fan_out_branch_count_mismatch")).toBe(true);
    });
  });

  describe("purity", () => {
    it("does not mutate definition or collection inputs on expand", () => {
      const def = region();
      const values = ["a", "b"];
      const defSnapshot = structuredClone(def);
      const valuesSnapshot = structuredClone(values);

      const result = expandDerivedFanOutRegion(def, values);
      expect(result.ok).toBe(true);
      expect(def).toEqual(defSnapshot);
      expect(values).toEqual(valuesSnapshot);

      if (!result.ok) return;
      result.expansion.branches[0]!.itemValue = "mutated";
      result.expansion.collectionValues.push("extra");
      result.expansion.usedAttemptIds.push("x");
      expect(values).toEqual(valuesSnapshot);
    });

    it("does not mutate expansion on attempt, evidence, complete, or fan-in", () => {
      const expansion = expandOk(region(), ["a", "b"]);
      const snapshot = structuredClone(expansion);

      const started = startDerivedBranchAttempt(expansion, "review-files/item/0", "a1");
      expect(started.ok).toBe(true);
      expect(expansion).toEqual(snapshot);

      if (!started.ok) return;
      const startedSnapshot = structuredClone(started.expansion);
      const withEvidence = appendDerivedBranchEvidence(
        started.expansion,
        "review-files/item/0",
        [{ ref: "e1" }],
      );
      expect(withEvidence.ok).toBe(true);
      expect(started.expansion).toEqual(startedSnapshot);

      if (!withEvidence.ok) return;
      const evidenceSnapshot = structuredClone(withEvidence.expansion);
      const completed = completeDerivedBranch(
        withEvidence.expansion,
        "review-files/item/0",
        "succeeded",
      );
      expect(completed.ok).toBe(true);
      expect(withEvidence.expansion).toEqual(evidenceSnapshot);

      if (!completed.ok) return;
      const completeSnapshot = structuredClone(completed.expansion);
      evaluateDerivedFanIn(completed.expansion);
      listDerivedBranches(completed.expansion);
      expect(completed.expansion).toEqual(completeSnapshot);

      const listed = listDerivedBranches(completed.expansion);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      listed.branches[0]!.evidence.push({ ref: "mutated" });
      const got = getDerivedBranch(completed.expansion, "review-files/item/0");
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.branch?.evidence.map((e) => e.ref)).toEqual(["e1"]);
    });

    it("parse and validate do not mutate the raw definition object", () => {
      const raw = {
        id: "region-1",
        collectionFact: "items",
        maxBranches: 4,
        fanInPolicy: "fail-all" as const,
      };
      const snapshot = structuredClone(raw);
      expect(validateDerivedFanOutRegionDefinition(raw)).toEqual([]);
      const parsed = parseDerivedFanOutRegionDefinition(raw);
      expect(parsed.ok).toBe(true);
      expect(raw).toEqual(snapshot);
    });
  });
});
