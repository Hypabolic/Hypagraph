import { describe, expect, it } from "vitest";
import {
  CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
  admitGroupAttempt,
  canAdmitGroupAttempt,
  createEmptyConcurrencyGroupState,
  filterAdmissibleCandidates,
  getConcurrencyGroupActiveAttempt,
  getGroupActiveCount,
  listConcurrencyGroupActiveAttempts,
  parseConcurrencyGroupActiveAttempt,
  parseFairnessCandidate,
  proposeConcurrencyGroupActiveAttempt,
  releaseGroupAttempt,
  resolveConcurrencyGroupRegistry,
  resolveGroupMaxConcurrent,
  selectAndAdmitFairCandidate,
  selectFairBatch,
  selectFairCandidate,
  validateConcurrencyGroupActiveAttempt,
  validateConcurrencyGroupStateSchema,
  type ConcurrencyGroupActiveAttempt,
  type ConcurrencyGroupState,
  type FairnessCandidate,
} from "../src/domain/concurrency-groups.js";

const registry = (...groups: Array<{ groupId: string; maxConcurrent: number }>) => ({
  groups,
});

const attempt = (
  attemptId: string,
  groupIds: string[] = [],
): ConcurrencyGroupActiveAttempt => ({
  attemptId,
  groupIds,
});

const candidate = (
  attemptId: string,
  readySequence: number,
  fairnessKey: string,
  groupIds: string[] = [],
): FairnessCandidate => ({
  attemptId,
  readySequence,
  fairnessKey,
  groupIds,
});

const expectActiveIds = (state: ConcurrencyGroupState, ids: string[]): void => {
  const listed = listConcurrencyGroupActiveAttempts(state);
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect(listed.attempts.map((item) => item.attemptId)).toEqual(ids);
};

describe("m8-s8 concurrency groups and fairness", () => {
  describe("defaults and empty occupancy state", () => {
    it("creates an empty occupancy state with schema version one", () => {
      const state = createEmptyConcurrencyGroupState();
      expect(state.schemaVersion).toBe(CONCURRENCY_GROUP_STATE_SCHEMA_VERSION);
      expect(state.schemaVersion).toBe(1);
      expect(state.attempts).toEqual([]);

      const listed = listConcurrencyGroupActiveAttempts(state);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.attempts).toEqual([]);
    });

    it("resolves an omitted registry as empty and rejects unknown group membership", () => {
      const emptyRegistry = resolveConcurrencyGroupRegistry(undefined);
      expect(emptyRegistry.ok).toBe(true);
      if (!emptyRegistry.ok) return;
      expect(emptyRegistry.value.definitions).toEqual([]);

      const emptyObject = resolveConcurrencyGroupRegistry({ groups: [] });
      expect(emptyObject.ok).toBe(true);
      if (!emptyObject.ok) return;
      expect(emptyObject.value.definitions).toEqual([]);

      // Empty membership does not require registry entries.
      const free = admitGroupAttempt(
        createEmptyConcurrencyGroupState(),
        attempt("free-1", []),
        undefined,
      );
      expect(free.ok).toBe(true);

      // Membership that names an absent group is invalid.
      const unknown = admitGroupAttempt(
        createEmptyConcurrencyGroupState(),
        attempt("blocked-1", ["missing-group"]),
        undefined,
      );
      expect(unknown.ok).toBe(false);
      if (unknown.ok) return;
      expect(unknown.diagnostics.some((d) => d.code === "concurrency_group_unknown_group")).toBe(
        true,
      );
    });
  });

  describe("exclusive group maxConcurrent 1", () => {
    it("rejects a second member of the same exclusive group and admits different groups", () => {
      const groups = registry(
        { groupId: "mutex-a", maxConcurrent: 1 },
        { groupId: "mutex-b", maxConcurrent: 1 },
      );

      const empty = createEmptyConcurrencyGroupState();
      const first = admitGroupAttempt(empty, attempt("a1", ["mutex-a"]), groups);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const secondSame = admitGroupAttempt(first.state, attempt("a2", ["mutex-a"]), groups);
      expect(secondSame.ok).toBe(false);
      if (secondSame.ok) return;
      expect(secondSame.diagnostics.some((d) => d.code === "concurrency_group_limit")).toBe(true);

      const canSecond = canAdmitGroupAttempt(first.state, attempt("a2", ["mutex-a"]), groups);
      expect(canSecond.ok).toBe(false);
      if (canSecond.ok) return;
      expect(canSecond.diagnostics.some((d) => d.code === "concurrency_group_limit")).toBe(true);

      // Different exclusive groups do not block each other.
      const otherGroup = admitGroupAttempt(first.state, attempt("b1", ["mutex-b"]), groups);
      expect(otherGroup.ok).toBe(true);
      if (!otherGroup.ok) return;
      expectActiveIds(otherGroup.state, ["a1", "b1"]);

      const countA = getGroupActiveCount(otherGroup.state, "mutex-a");
      expect(countA.ok).toBe(true);
      if (!countA.ok) return;
      expect(countA.count).toBe(1);

      const countB = getGroupActiveCount(otherGroup.state, "mutex-b");
      expect(countB.ok).toBe(true);
      if (!countB.ok) return;
      expect(countB.count).toBe(1);
    });
  });

  describe("shared group maxConcurrent 2", () => {
    it("admits two members and rejects a third", () => {
      const groups = registry({ groupId: "shared", maxConcurrent: 2 });
      let state = createEmptyConcurrencyGroupState();

      const first = admitGroupAttempt(state, attempt("s1", ["shared"]), groups);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      state = first.state;

      const second = admitGroupAttempt(state, attempt("s2", ["shared"]), groups);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      state = second.state;

      const third = admitGroupAttempt(state, attempt("s3", ["shared"]), groups);
      expect(third.ok).toBe(false);
      if (third.ok) return;
      expect(third.diagnostics.some((d) => d.code === "concurrency_group_limit")).toBe(true);

      const count = getGroupActiveCount(state, "shared");
      expect(count.ok).toBe(true);
      if (!count.ok) return;
      expect(count.count).toBe(2);
    });

    it("rejects all admits when maxConcurrent is zero", () => {
      const groups = registry({ groupId: "closed", maxConcurrent: 0 });
      const result = admitGroupAttempt(
        createEmptyConcurrencyGroupState(),
        attempt("c1", ["closed"]),
        groups,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics.some((d) => d.code === "concurrency_group_limit")).toBe(true);
    });
  });

  describe("release frees group capacity", () => {
    it("releases an attempt and frees a group slot for a waiting member", () => {
      const groups = registry({ groupId: "exclusive", maxConcurrent: 1 });
      let state = createEmptyConcurrencyGroupState();

      const first = admitGroupAttempt(state, attempt("holder", ["exclusive"]), groups);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      state = first.state;

      const blocked = admitGroupAttempt(state, attempt("waiter", ["exclusive"]), groups);
      expect(blocked.ok).toBe(false);

      const released = releaseGroupAttempt(state, "holder");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(true);
      state = released.state;

      const count = getGroupActiveCount(state, "exclusive");
      expect(count.ok).toBe(true);
      if (!count.ok) return;
      expect(count.count).toBe(0);

      const admitted = admitGroupAttempt(state, attempt("waiter", ["exclusive"]), groups);
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;
      expectActiveIds(admitted.state, ["waiter"]);
    });

    it("reports released false when the attempt id is absent", () => {
      const admitted = admitGroupAttempt(
        createEmptyConcurrencyGroupState(),
        attempt("a1", []),
        registry(),
      );
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;

      const released = releaseGroupAttempt(admitted.state, "missing");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(false);
      expectActiveIds(released.state, ["a1"]);
    });

    it("trims release ids and does not mutate the input state", () => {
      const admitted = admitGroupAttempt(
        createEmptyConcurrencyGroupState(),
        attempt("a1", []),
      );
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;

      const before = structuredClone(admitted.state);
      const released = releaseGroupAttempt(admitted.state, "  a1  ");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(true);
      expect(admitted.state).toEqual(before);
      expectActiveIds(released.state, []);
    });
  });

  describe("multi-group membership", () => {
    it("blocks an attempt when any of its groups is full", () => {
      const groups = registry(
        { groupId: "g1", maxConcurrent: 1 },
        { groupId: "g2", maxConcurrent: 2 },
      );

      let state = createEmptyConcurrencyGroupState();
      const holder = admitGroupAttempt(state, attempt("h1", ["g1"]), groups);
      expect(holder.ok).toBe(true);
      if (!holder.ok) return;
      state = holder.state;

      // Candidate needs g1 (full) and g2 (open). Any full group blocks admit.
      const multi = admitGroupAttempt(state, attempt("m1", ["g1", "g2"]), groups);
      expect(multi.ok).toBe(false);
      if (multi.ok) return;
      expect(multi.diagnostics.some((d) => d.code === "concurrency_group_limit")).toBe(true);

      // g2 alone still admits.
      const onlyG2 = admitGroupAttempt(state, attempt("m2", ["g2"]), groups);
      expect(onlyG2.ok).toBe(true);
    });
  });

  describe("fairness selection", () => {
    it("prefers the older readySequence when both candidates are admissible", () => {
      const groups = registry({ groupId: "open", maxConcurrent: 4 });
      const state = createEmptyConcurrencyGroupState();

      // Naive list order prefers newer first. Fair selection uses ready age.
      const candidates = [
        candidate("newer", 10, "key-a", ["open"]),
        candidate("older", 3, "key-b", ["open"]),
      ];

      const selected = selectFairCandidate(state, groups, candidates, 0);
      expect(selected.ok).toBe(true);
      if (!selected.ok) return;
      expect(selected.kind).toBe("select");
      if (selected.kind !== "select") return;
      expect(selected.candidate.attemptId).toBe("older");
      expect(selected.candidate.readySequence).toBe(3);
    });

    it("rotates fairness keys with the ordinal so one key is not permanently starved", () => {
      const groups = registry({ groupId: "open", maxConcurrent: 8 });
      const state = createEmptyConcurrencyGroupState();

      // Same readySequence so age does not decide. List order always puts key-a first.
      const candidates = [
        candidate("a1", 5, "key-a", ["open"]),
        candidate("a2", 5, "key-a", ["open"]),
        candidate("b1", 5, "key-b", ["open"]),
        candidate("c1", 5, "key-c", ["open"]),
      ];

      // Keys sort as key-a, key-b, key-c. Ordinal rotates across those keys.
      const pick0 = selectFairCandidate(state, groups, candidates, 0);
      expect(pick0.ok && pick0.kind === "select" && pick0.candidate.fairnessKey).toBe("key-a");

      const pick1 = selectFairCandidate(state, groups, candidates, 1);
      expect(pick1.ok && pick1.kind === "select" && pick1.candidate.fairnessKey).toBe("key-b");
      if (pick1.ok && pick1.kind === "select") {
        expect(pick1.candidate.attemptId).toBe("b1");
      }

      const pick2 = selectFairCandidate(state, groups, candidates, 2);
      expect(pick2.ok && pick2.kind === "select" && pick2.candidate.fairnessKey).toBe("key-c");

      const pick3 = selectFairCandidate(state, groups, candidates, 3);
      expect(pick3.ok && pick3.kind === "select" && pick3.candidate.fairnessKey).toBe("key-a");

      // Over three consecutive ordinals, every key is selected at least once.
      const keysSeen = new Set<string>();
      for (let ordinal = 0; ordinal < 3; ordinal += 1) {
        const decision = selectFairCandidate(state, groups, candidates, ordinal);
        expect(decision.ok).toBe(true);
        if (!decision.ok || decision.kind !== "select") continue;
        keysSeen.add(decision.candidate.fairnessKey);
      }
      expect(keysSeen).toEqual(new Set(["key-a", "key-b", "key-c"]));
    });

    it("prevents key starvation across repeated dispatch with advancing ordinal", () => {
      // Exclusive capacity forces one selection per dispatch. List order always
      // places key-a first. Each dispatch uses selectFairBatch(maxCount: 1) and
      // feeds the domain-returned fairnessOrdinal into the next dispatch so the
      // test fails if domain ordinal advancement changes or breaks.
      const groups = registry({ groupId: "open", maxConcurrent: 1 });
      let state = createEmptyConcurrencyGroupState();
      let ordinal = 0;
      const keysSeen = new Set<string>();
      const selectionOrder: string[] = [];
      const ordinalsAfterDispatch: number[] = [];

      for (let round = 0; round < 6; round += 1) {
        // Fresh candidates each round. Same readySequence so age does not decide.
        // Naive first-in-list order prefers key-a on every round.
        const candidates = [
          candidate(`a-${round}`, 0, "key-a", ["open"]),
          candidate(`b-${round}`, 0, "key-b", ["open"]),
          candidate(`c-${round}`, 0, "key-c", ["open"]),
        ];

        const batch = selectFairBatch(state, groups, candidates, ordinal, 1);
        expect(batch.ok, `round ${round}`).toBe(true);
        if (!batch.ok) return;
        expect(batch.selected, `round ${round}`).toHaveLength(1);
        const selected = batch.selected[0]!;

        keysSeen.add(selected.fairnessKey);
        selectionOrder.push(selected.fairnessKey);
        ordinalsAfterDispatch.push(batch.fairnessOrdinal);

        // Release from the domain-returned occupancy state. Pass the returned
        // fairnessOrdinal into the next dispatch without manual increment.
        const released = releaseGroupAttempt(batch.state, selected.attemptId);
        expect(released.ok, `round ${round}`).toBe(true);
        if (!released.ok) return;
        state = released.state;
        ordinal = batch.fairnessOrdinal;
      }

      // Domain advanced the ordinal once per successful selection.
      expect(ordinalsAfterDispatch).toEqual([1, 2, 3, 4, 5, 6]);
      // Within six dispatches (two full rotations of three keys), every key runs.
      expect(keysSeen).toEqual(new Set(["key-a", "key-b", "key-c"]));
      // First three rounds must cover all keys under round-robin, not only key-a.
      expect(new Set(selectionOrder.slice(0, 3))).toEqual(
        new Set(["key-a", "key-b", "key-c"]),
      );
      // Cursor advancement is deterministic: keys repeat as a, b, c, a, b, c.
      expect(selectionOrder).toEqual([
        "key-a",
        "key-b",
        "key-c",
        "key-a",
        "key-b",
        "key-c",
      ]);

      // Multi-admit batch also advances the returned ordinal and covers all keys.
      const batchCandidates = [
        candidate("ba", 0, "key-a", ["open"]),
        candidate("bb", 0, "key-b", ["open"]),
        candidate("bc", 0, "key-c", ["open"]),
      ];
      // Higher capacity so the batch can admit one from each key.
      const multi = registry({ groupId: "open", maxConcurrent: 3 });
      const multiBatch = selectFairBatch(
        createEmptyConcurrencyGroupState(),
        multi,
        batchCandidates,
        0,
        3,
      );
      expect(multiBatch.ok).toBe(true);
      if (!multiBatch.ok) return;
      expect(multiBatch.selected).toHaveLength(3);
      expect(multiBatch.fairnessOrdinal).toBe(3);
      expect(new Set(multiBatch.selected.map((item) => item.fairnessKey))).toEqual(
        new Set(["key-a", "key-b", "key-c"]),
      );
    });

    it("rejects an invalid ordinal when the candidate list is empty or fully blocked", () => {
      const groups = registry({ groupId: "exclusive", maxConcurrent: 1 });
      const emptyState = createEmptyConcurrencyGroupState();

      const emptyList = selectFairCandidate(emptyState, groups, [], -1);
      expect(emptyList.ok).toBe(false);
      if (emptyList.ok) return;
      expect(emptyList.diagnostics.some((d) => d.code === "fairness_invalid_ordinal")).toBe(
        true,
      );

      const held = admitGroupAttempt(
        emptyState,
        attempt("holder", ["exclusive"]),
        groups,
      );
      expect(held.ok).toBe(true);
      if (!held.ok) return;

      const blocked = selectFairCandidate(
        held.state,
        groups,
        [candidate("waiter", 0, "key-a", ["exclusive"])],
        -1,
      );
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.diagnostics.some((d) => d.code === "fairness_invalid_ordinal")).toBe(
        true,
      );

      // A valid ordinal still yields idle when capacity is full.
      const idle = selectFairCandidate(
        held.state,
        groups,
        [candidate("waiter", 0, "key-a", ["exclusive"])],
        0,
      );
      expect(idle.ok).toBe(true);
      if (!idle.ok) return;
      expect(idle.kind).toBe("idle");
    });

    it("surfaces unknown group membership as diagnostics instead of idle", () => {
      const groups = registry({ groupId: "known", maxConcurrent: 2 });
      const state = createEmptyConcurrencyGroupState();
      const candidates = [
        candidate("good", 0, "key-a", ["known"]),
        candidate("bad", 1, "key-b", ["missing-group"]),
      ];

      const filtered = filterAdmissibleCandidates(state, groups, candidates);
      expect(filtered.ok).toBe(false);
      if (filtered.ok) return;
      expect(
        filtered.diagnostics.some((d) => d.code === "concurrency_group_unknown_group"),
      ).toBe(true);

      const selected = selectFairCandidate(state, groups, candidates, 0);
      expect(selected.ok).toBe(false);
      if (selected.ok) return;
      expect(
        selected.diagnostics.some((d) => d.code === "concurrency_group_unknown_group"),
      ).toBe(true);

      const batch = selectFairBatch(state, groups, candidates, 0, 2);
      expect(batch.ok).toBe(false);
      if (batch.ok) return;
      expect(
        batch.diagnostics.some((d) => d.code === "concurrency_group_unknown_group"),
      ).toBe(true);
    });

    it("wraps the fairness ordinal at Number.MAX_SAFE_INTEGER", () => {
      const groups = registry({ groupId: "open", maxConcurrent: 4 });
      const state = createEmptyConcurrencyGroupState();
      const candidates = [
        candidate("a1", 0, "key-a", ["open"]),
        candidate("b1", 0, "key-b", ["open"]),
      ];

      const batch = selectFairBatch(
        state,
        groups,
        candidates,
        Number.MAX_SAFE_INTEGER,
        1,
      );
      expect(batch.ok).toBe(true);
      if (!batch.ok) return;
      expect(batch.selected).toHaveLength(1);
      // After one selection from MAX_SAFE_INTEGER, the ordinal wraps to 0.
      expect(batch.fairnessOrdinal).toBe(0);
      expect(Number.isSafeInteger(batch.fairnessOrdinal)).toBe(true);

      // A second batch that starts at the wrapped ordinal continues safely.
      const next = selectFairBatch(
        batch.state,
        groups,
        candidates.filter((item) => item.attemptId !== batch.selected[0]!.attemptId),
        batch.fairnessOrdinal,
        1,
      );
      expect(next.ok).toBe(true);
      if (!next.ok) return;
      expect(next.selected).toHaveLength(1);
      expect(next.fairnessOrdinal).toBe(1);
    });

    it("selects the older waiting candidate after exclusive release over a newer rival", () => {
      const groups = registry({ groupId: "exclusive", maxConcurrent: 1 });
      let state = createEmptyConcurrencyGroupState();

      // Holder occupies the exclusive group.
      const held = admitGroupAttempt(state, attempt("holder", ["exclusive"]), groups);
      expect(held.ok).toBe(true);
      if (!held.ok) return;
      state = held.state;

      const waiting = [
        // Newer rival is first in the naive list order.
        candidate("newer-rival", 20, "rival", ["exclusive"]),
        // Older waiter has waited longer.
        candidate("older-waiter", 2, "waiter", ["exclusive"]),
      ];

      // While the exclusive group is full, selection is idle (no admissible).
      const whileHeld = selectFairCandidate(state, groups, waiting, 0);
      expect(whileHeld.ok).toBe(true);
      if (!whileHeld.ok) return;
      expect(whileHeld.kind).toBe("idle");

      const released = releaseGroupAttempt(state, "holder");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      state = released.state;

      // After release, older waiter wins over the newer rival despite list order.
      const afterRelease = selectFairCandidate(state, groups, waiting, 0);
      expect(afterRelease.ok).toBe(true);
      if (!afterRelease.ok) return;
      expect(afterRelease.kind).toBe("select");
      if (afterRelease.kind !== "select") return;
      expect(afterRelease.candidate.attemptId).toBe("older-waiter");

      // Composition helper admits the fair choice.
      const admitted = selectAndAdmitFairCandidate(state, groups, waiting, 0);
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;
      expect(admitted.kind).toBe("select");
      if (admitted.kind !== "select") return;
      expect(admitted.candidate.attemptId).toBe("older-waiter");
      expectActiveIds(admitted.state, ["older-waiter"]);
    });

    it("selects a fair batch with re-checked group capacity after each virtual admit", () => {
      const groups = registry({ groupId: "pair", maxConcurrent: 2 });
      const state = createEmptyConcurrencyGroupState();
      const candidates = [
        candidate("c1", 1, "k1", ["pair"]),
        candidate("c2", 2, "k2", ["pair"]),
        candidate("c3", 3, "k3", ["pair"]),
      ];

      const batch = selectFairBatch(state, groups, candidates, 0, 3);
      expect(batch.ok).toBe(true);
      if (!batch.ok) return;
      // Capacity is two, so only two admits even when three candidates exist.
      expect(batch.selected.map((item) => item.attemptId)).toEqual(["c1", "c2"]);
      expect(batch.fairnessOrdinal).toBe(2);
      expectActiveIds(batch.state, ["c1", "c2"]);
    });

    it("is deterministic for the same inputs", () => {
      const groups = registry({ groupId: "open", maxConcurrent: 4 });
      const state = createEmptyConcurrencyGroupState();
      const candidates = [
        candidate("z-last", 1, "key-z", ["open"]),
        candidate("a-first", 1, "key-a", ["open"]),
      ];

      const first = selectFairCandidate(state, groups, candidates, 7);
      const second = selectFairCandidate(state, groups, candidates, 7);
      expect(first).toEqual(second);
      expect(first.ok && first.kind === "select" && first.candidate.attemptId).toBeTruthy();
    });
  });

  describe("input immutability and defensive validation", () => {
    it("does not mutate input state or candidate on admit", () => {
      const groups = registry({ groupId: "g", maxConcurrent: 2 });
      const state = createEmptyConcurrencyGroupState();
      const candidateRecord = attempt("a1", ["g"]);
      const stateBefore = structuredClone(state);
      const candidateBefore = structuredClone(candidateRecord);

      const result = admitGroupAttempt(state, candidateRecord, groups);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(state).toEqual(stateBefore);
      expect(candidateRecord).toEqual(candidateBefore);
      expect(result.state).not.toBe(state);
      expect(result.state.attempts[0]).not.toBe(candidateRecord);
    });

    it("returns clean field copies from list and get helpers", () => {
      const admitted = admitGroupAttempt(
        createEmptyConcurrencyGroupState(),
        attempt("a1", ["g1"]),
        registry({ groupId: "g1", maxConcurrent: 2 }),
      );
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;

      const listed = listConcurrencyGroupActiveAttempts(admitted.state);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      listed.attempts[0]!.attemptId = "mutated";
      listed.attempts[0]!.groupIds.push("mutated-group");
      expect(admitted.state.attempts[0]!.attemptId).toBe("a1");
      expect(admitted.state.attempts[0]!.groupIds).toEqual(["g1"]);

      const got = getConcurrencyGroupActiveAttempt(admitted.state, "a1");
      expect(got.ok).toBe(true);
      if (!got.ok || got.attempt === undefined) return;
      got.attempt.attemptId = "mutated-again";
      expect(admitted.state.attempts[0]!.attemptId).toBe("a1");
    });

    it("rejects class instances, arrays, and unsupported schema without throw", () => {
      class StateClass {
        schemaVersion = 1;
        attempts: ConcurrencyGroupActiveAttempt[] = [];
      }
      const classDiag = validateConcurrencyGroupStateSchema(new StateClass());
      expect(classDiag.some((d) => d.code === "concurrency_group_state_not_plain_object")).toBe(
        true,
      );

      const badSchema = {
        schemaVersion: 99,
        attempts: [],
      } as unknown as ConcurrencyGroupState;
      const schemaDiag = validateConcurrencyGroupStateSchema(badSchema);
      expect(
        schemaDiag.some((d) => d.code === "concurrency_group_state_unsupported_schema"),
      ).toBe(true);

      const paths: Array<{
        name: string;
        run: () => { ok: boolean; diagnostics?: { code: string }[] };
      }> = [
        {
          name: "canAdmitGroupAttempt",
          run: () => canAdmitGroupAttempt(badSchema, attempt("a1")),
        },
        {
          name: "admitGroupAttempt",
          run: () => admitGroupAttempt(badSchema, attempt("a1")),
        },
        {
          name: "releaseGroupAttempt",
          run: () => releaseGroupAttempt(badSchema, "a1"),
        },
        {
          name: "listConcurrencyGroupActiveAttempts",
          run: () => listConcurrencyGroupActiveAttempts(badSchema),
        },
        {
          name: "getConcurrencyGroupActiveAttempt",
          run: () => getConcurrencyGroupActiveAttempt(badSchema, "a1"),
        },
        {
          name: "getGroupActiveCount",
          run: () => getGroupActiveCount(badSchema, "g"),
        },
        {
          name: "filterAdmissibleCandidates",
          run: () => filterAdmissibleCandidates(badSchema, undefined, []),
        },
        {
          name: "selectFairCandidate",
          run: () => selectFairCandidate(badSchema, undefined, [], 0),
        },
      ];

      for (const path of paths) {
        const result = path.run();
        expect(result.ok, path.name).toBe(false);
        if (result.ok) continue;
        expect(
          result.diagnostics?.some(
            (d) => d.code === "concurrency_group_state_unsupported_schema",
          ),
          path.name,
        ).toBe(true);
      }

      class AttemptClass {
        attemptId = "a1";
        groupIds: string[] = [];
      }
      const classAttempt = validateConcurrencyGroupActiveAttempt(new AttemptClass());
      expect(
        classAttempt.some((d) => d.code === "concurrency_group_attempt_not_plain_object"),
      ).toBe(true);

      const arrayRegistry = resolveConcurrencyGroupRegistry([]);
      expect(arrayRegistry.ok).toBe(false);
      if (arrayRegistry.ok) return;
      expect(
        arrayRegistry.diagnostics.some((d) => d.code === "concurrency_group_invalid_registry"),
      ).toBe(true);
    });

    it("rejects accessor properties without throwing", () => {
      const candidateRecord: Record<string, unknown> = { groupIds: [] };
      Object.defineProperty(candidateRecord, "attemptId", {
        enumerable: true,
        get() {
          throw new Error("attemptId getter must not run");
        },
      });
      const validated = validateConcurrencyGroupActiveAttempt(candidateRecord);
      expect(validated.some((d) => d.code === "concurrency_group_invalid_accessor")).toBe(true);

      const admit = admitGroupAttempt(
        createEmptyConcurrencyGroupState(),
        candidateRecord,
      );
      expect(admit.ok).toBe(false);
      if (admit.ok) return;
      expect(admit.diagnostics.some((d) => d.code === "concurrency_group_invalid_accessor")).toBe(
        true,
      );

      const schemaGetter: Record<string, unknown> = { attempts: [] };
      Object.defineProperty(schemaGetter, "schemaVersion", {
        enumerable: true,
        get() {
          throw new Error("schemaVersion getter must not run");
        },
      });
      const schemaState = schemaGetter as unknown as ConcurrencyGroupState;
      const schemaDiag = validateConcurrencyGroupStateSchema(schemaState);
      expect(schemaDiag.some((d) => d.code === "concurrency_group_invalid_accessor")).toBe(true);
      expect(releaseGroupAttempt(schemaState, "a1").ok).toBe(false);
    });

    it("returns clean copies that drop uncloneable extra properties", () => {
      const dirtyCandidate: Record<string, unknown> = {
        attemptId: "extra-fn",
        groupIds: ["g1"],
        onEvent: () => "side-effect",
      };
      const admitted = admitGroupAttempt(
        createEmptyConcurrencyGroupState(),
        dirtyCandidate,
        registry({ groupId: "g1", maxConcurrent: 2 }),
      );
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;
      expect(admitted.state.attempts[0]).toEqual({
        attemptId: "extra-fn",
        groupIds: ["g1"],
      });
      expect(
        Object.prototype.hasOwnProperty.call(admitted.state.attempts[0], "onEvent"),
      ).toBe(false);
    });

    it("rejects duplicate attempt ids in state and on admit", () => {
      const groups = registry({ groupId: "g", maxConcurrent: 4 });
      const first = admitGroupAttempt(
        createEmptyConcurrencyGroupState(),
        attempt("same", ["g"]),
        groups,
      );
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const duplicate = admitGroupAttempt(first.state, attempt("same", ["g"]), groups);
      expect(duplicate.ok).toBe(false);
      if (duplicate.ok) return;
      expect(
        duplicate.diagnostics.some((d) => d.code === "concurrency_group_duplicate_attempt"),
      ).toBe(true);

      const storedDuplicate = {
        schemaVersion: 1,
        attempts: [
          { attemptId: "same", groupIds: [] },
          { attemptId: "  same  ", groupIds: [] },
        ],
      } as unknown as ConcurrencyGroupState;
      const schema = validateConcurrencyGroupStateSchema(storedDuplicate);
      expect(
        schema.some((d) => d.code === "concurrency_group_state_duplicate_attempt_id"),
      ).toBe(true);
    });
  });

  describe("invalid bounds and empty identities", () => {
    it("rejects invalid group ids, bounds, and membership with diagnostics", () => {
      const emptyId = resolveConcurrencyGroupRegistry({
        groups: [{ groupId: "  ", maxConcurrent: 1 }],
      });
      expect(emptyId.ok).toBe(false);
      if (emptyId.ok) return;
      expect(
        emptyId.diagnostics.some((d) => d.code === "concurrency_group_invalid_group_id"),
      ).toBe(true);

      const negative = resolveConcurrencyGroupRegistry({
        groups: [{ groupId: "g", maxConcurrent: -1 }],
      });
      expect(negative.ok).toBe(false);
      if (negative.ok) return;
      expect(
        negative.diagnostics.some((d) => d.code === "concurrency_group_invalid_max_concurrent"),
      ).toBe(true);

      const notInteger = resolveConcurrencyGroupRegistry({
        groups: [{ groupId: "g", maxConcurrent: 1.5 }],
      });
      expect(notInteger.ok).toBe(false);
      if (notInteger.ok) return;
      expect(
        notInteger.diagnostics.some((d) => d.code === "concurrency_group_invalid_max_concurrent"),
      ).toBe(true);

      const emptyAttemptId = validateConcurrencyGroupActiveAttempt({
        attemptId: "  ",
        groupIds: [],
      });
      expect(
        emptyAttemptId.some((d) => d.code === "concurrency_group_invalid_attempt_id"),
      ).toBe(true);

      const emptyGroupInMembership = validateConcurrencyGroupActiveAttempt({
        attemptId: "a1",
        groupIds: [""],
      });
      expect(
        emptyGroupInMembership.some((d) => d.code === "concurrency_group_invalid_group_id"),
      ).toBe(true);

      const duplicateMembership = validateConcurrencyGroupActiveAttempt({
        attemptId: "a1",
        groupIds: ["g", "g"],
      });
      expect(
        duplicateMembership.some((d) => d.code === "concurrency_group_duplicate_membership"),
      ).toBe(true);

      const badReady = parseFairnessCandidate({
        attemptId: "a1",
        readySequence: -1,
        fairnessKey: "k",
        groupIds: [],
      });
      expect(badReady.ok).toBe(false);
      if (badReady.ok) return;
      expect(
        badReady.diagnostics.some((d) => d.code === "fairness_invalid_ready_sequence"),
      ).toBe(true);

      const badOrdinal = selectFairCandidate(
        createEmptyConcurrencyGroupState(),
        undefined,
        [candidate("a1", 0, "k", [])],
        -1,
      );
      expect(badOrdinal.ok).toBe(false);
      if (badOrdinal.ok) return;
      expect(badOrdinal.diagnostics.some((d) => d.code === "fairness_invalid_ordinal")).toBe(true);

      const emptyCountId = getGroupActiveCount(createEmptyConcurrencyGroupState(), "  ");
      expect(emptyCountId.ok).toBe(false);
      if (emptyCountId.ok) return;
      expect(
        emptyCountId.diagnostics.some((d) => d.code === "concurrency_group_invalid_group_id"),
      ).toBe(true);
    });

    it("parses trimmed identity fields and resolves registry limits", () => {
      const parsed = parseConcurrencyGroupActiveAttempt({
        attemptId: "  attempt-x  ",
        groupIds: ["  g2  ", "g1"],
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.attemptId).toBe("attempt-x");
      // Membership is unique and sorted with locale-insensitive identity order.
      expect(parsed.value.groupIds).toEqual(["g1", "g2"]);

      const resolved = resolveConcurrencyGroupRegistry({
        groups: [
          { groupId: "  beta  ", maxConcurrent: 2 },
          { groupId: "alpha", maxConcurrent: 1 },
        ],
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.value.definitions.map((d) => d.groupId)).toEqual(["alpha", "beta"]);
      expect(resolveGroupMaxConcurrent(resolved.value, "alpha")).toBe(1);
      expect(resolveGroupMaxConcurrent(resolved.value, "beta")).toBe(2);
      expect(resolveGroupMaxConcurrent(resolved.value, "missing")).toBeUndefined();

      const proposed = proposeConcurrencyGroupActiveAttempt({
        attemptId: "p1",
        groupIds: [],
      });
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      expect(proposed.value.attemptId).toBe("p1");

      const fair = parseFairnessCandidate({
        attemptId: "  f1  ",
        readySequence: 0,
        fairnessKey: "  component-a  ",
        groupIds: [],
      });
      expect(fair.ok).toBe(true);
      if (!fair.ok) return;
      expect(fair.value.attemptId).toBe("f1");
      expect(fair.value.fairnessKey).toBe("component-a");
    });

    it("rejects filter and select when candidates include invalid records", () => {
      const filtered = filterAdmissibleCandidates(
        createEmptyConcurrencyGroupState(),
        undefined,
        [{ attemptId: "", readySequence: 0, fairnessKey: "k", groupIds: [] }],
      );
      expect(filtered.ok).toBe(false);
      if (filtered.ok) return;
      expect(filtered.diagnostics.some((d) => d.code === "fairness_invalid_attempt_id")).toBe(
        true,
      );
    });
  });
});
