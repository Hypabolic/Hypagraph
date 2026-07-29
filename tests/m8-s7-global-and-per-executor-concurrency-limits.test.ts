import { describe, expect, it } from "vitest";
import type { ExecutorKind } from "../src/domain/executor-contract.js";
import {
  CONCURRENCY_STATE_SCHEMA_VERSION,
  DEFAULT_GLOBAL_CONCURRENCY,
  admitAttempt,
  canAdmitAttempt,
  createEmptyConcurrencyState,
  getConcurrencyActiveAttempt,
  getExecutorActiveCount,
  getGlobalActiveCount,
  listConcurrencyActiveAttempts,
  parseConcurrencyActiveAttempt,
  proposeConcurrencyActiveAttempt,
  releaseAttempt,
  resolveConcurrencyLimits,
  resolveExecutorKindLimit,
  validateConcurrencyActiveAttempt,
  validateConcurrencyStateSchema,
  type ConcurrencyActiveAttempt,
  type ConcurrencyState,
} from "../src/domain/concurrency-limits.js";

const attempt = (
  attemptId: string,
  executorKind: ExecutorKind = "isolated-pi",
  profileId?: string,
): ConcurrencyActiveAttempt => ({
  attemptId,
  executorKind,
  ...(profileId !== undefined ? { profileId } : {}),
});

const expectActiveIds = (state: ConcurrencyState, ids: string[]): void => {
  const listed = listConcurrencyActiveAttempts(state);
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect(listed.attempts.map((item) => item.attemptId)).toEqual(ids);
};

describe("m8-s7 global and per-executor concurrency limits", () => {
  describe("defaults and empty state", () => {
    it("uses default global concurrency of two isolated attempts", () => {
      expect(DEFAULT_GLOBAL_CONCURRENCY).toBe(2);

      const resolved = resolveConcurrencyLimits(undefined);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.value.globalConcurrency).toBe(2);
      // Absent kind inherits the resolved global limit.
      expect(resolveExecutorKindLimit(resolved.value, "isolated-pi")).toBe(2);
      expect(resolveExecutorKindLimit(resolved.value, "cli")).toBe(2);
    });

    it("creates an empty concurrency state with schema version one", () => {
      const state = createEmptyConcurrencyState();
      expect(state.schemaVersion).toBe(CONCURRENCY_STATE_SCHEMA_VERSION);
      expect(state.schemaVersion).toBe(1);
      expect(state.attempts).toEqual([]);

      const count = getGlobalActiveCount(state);
      expect(count.ok).toBe(true);
      if (!count.ok) return;
      expect(count.count).toBe(0);
    });
  });

  describe("global limit enforcement", () => {
    it("admits two attempts under defaults and rejects a third", () => {
      const empty = createEmptyConcurrencyState();

      const first = admitAttempt(empty, attempt("attempt-1", "isolated-pi"));
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const second = admitAttempt(first.state, attempt("attempt-2", "cli"));
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      const global = getGlobalActiveCount(second.state);
      expect(global.ok).toBe(true);
      if (!global.ok) return;
      expect(global.count).toBe(2);

      const third = admitAttempt(second.state, attempt("attempt-3", "acp"));
      expect(third.ok).toBe(false);
      if (third.ok) return;
      expect(third.diagnostics.some((d) => d.code === "concurrency_global_limit")).toBe(true);

      const canThird = canAdmitAttempt(second.state, attempt("attempt-3", "acp"));
      expect(canThird.ok).toBe(false);
      if (canThird.ok) return;
      expect(canThird.diagnostics.some((d) => d.code === "concurrency_global_limit")).toBe(true);

      // Original state is unchanged after rejection.
      expectActiveIds(second.state, ["attempt-1", "attempt-2"]);
    });

    it("rejects all admits when global concurrency is zero", () => {
      const empty = createEmptyConcurrencyState();
      const result = admitAttempt(empty, attempt("attempt-1"), { globalConcurrency: 0 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics.some((d) => d.code === "concurrency_global_limit")).toBe(true);
    });
  });

  describe("per-executor limit enforcement", () => {
    it("enforces a per-executor limit without blocking a different executor when global capacity remains", () => {
      // Global capacity is three. Executor isolated-pi is capped at one.
      const limits = {
        globalConcurrency: 3,
        perExecutorKind: {
          "isolated-pi": 1,
          cli: 2,
        } satisfies Partial<Record<ExecutorKind, number>>,
      };

      const empty = createEmptyConcurrencyState();
      const firstPi = admitAttempt(empty, attempt("pi-1", "isolated-pi"), limits);
      expect(firstPi.ok).toBe(true);
      if (!firstPi.ok) return;

      // Second isolated-pi hits the per-executor limit while global still has room.
      const secondPi = admitAttempt(firstPi.state, attempt("pi-2", "isolated-pi"), limits);
      expect(secondPi.ok).toBe(false);
      if (secondPi.ok) return;
      expect(secondPi.diagnostics.some((d) => d.code === "concurrency_executor_limit")).toBe(true);

      // cli can still admit because global capacity remains and cli is under its cap.
      const firstCli = admitAttempt(firstPi.state, attempt("cli-1", "cli"), limits);
      expect(firstCli.ok).toBe(true);
      if (!firstCli.ok) return;

      const secondCli = admitAttempt(firstCli.state, attempt("cli-2", "cli"), limits);
      expect(secondCli.ok).toBe(true);
      if (!secondCli.ok) return;

      const piCount = getExecutorActiveCount(secondCli.state, "isolated-pi");
      expect(piCount.ok).toBe(true);
      if (!piCount.ok) return;
      expect(piCount.count).toBe(1);

      const cliCount = getExecutorActiveCount(secondCli.state, "cli");
      expect(cliCount.ok).toBe(true);
      if (!cliCount.ok) return;
      expect(cliCount.count).toBe(2);

      const global = getGlobalActiveCount(secondCli.state);
      expect(global.ok).toBe(true);
      if (!global.ok) return;
      expect(global.count).toBe(3);
    });

    it("blocks every executor when the global limit is exhausted", () => {
      const limits = {
        globalConcurrency: 2,
        perExecutorKind: {
          "isolated-pi": 2,
          cli: 2,
        } satisfies Partial<Record<ExecutorKind, number>>,
      };

      let state = createEmptyConcurrencyState();
      const a = admitAttempt(state, attempt("a", "isolated-pi"), limits);
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      state = a.state;

      const b = admitAttempt(state, attempt("b", "cli"), limits);
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      state = b.state;

      // Global is full. A different executor kind is still rejected.
      const c = admitAttempt(state, attempt("c", "acp"), limits);
      expect(c.ok).toBe(false);
      if (c.ok) return;
      expect(c.diagnostics.some((d) => d.code === "concurrency_global_limit")).toBe(true);
    });

    it("rejects admits for a kind when its per-executor limit is zero", () => {
      const limits = {
        globalConcurrency: 2,
        perExecutorKind: { cli: 0 } satisfies Partial<Record<ExecutorKind, number>>,
      };
      const empty = createEmptyConcurrencyState();
      const result = admitAttempt(empty, attempt("cli-1", "cli"), limits);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics.some((d) => d.code === "concurrency_executor_limit")).toBe(true);

      // Other kinds still inherit the global default and can admit.
      const other = admitAttempt(empty, attempt("pi-1", "isolated-pi"), limits);
      expect(other.ok).toBe(true);
    });
  });

  describe("release frees capacity", () => {
    it("releases an attempt and frees a global slot for a new admit", () => {
      let state = createEmptyConcurrencyState();
      const a = admitAttempt(state, attempt("attempt-1"));
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      state = a.state;

      const b = admitAttempt(state, attempt("attempt-2"));
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      state = b.state;

      const blocked = admitAttempt(state, attempt("attempt-3"));
      expect(blocked.ok).toBe(false);

      const released = releaseAttempt(state, "attempt-1");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(true);
      state = released.state;

      const global = getGlobalActiveCount(state);
      expect(global.ok).toBe(true);
      if (!global.ok) return;
      expect(global.count).toBe(1);

      const admitted = admitAttempt(state, attempt("attempt-3"));
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;
      expectActiveIds(admitted.state, ["attempt-2", "attempt-3"]);
    });

    it("reports released false when the attempt id is absent", () => {
      const state = createEmptyConcurrencyState();
      const admitted = admitAttempt(state, attempt("attempt-1"));
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;

      const released = releaseAttempt(admitted.state, "missing");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(false);
      expectActiveIds(released.state, ["attempt-1"]);
    });

    it("trims release ids and does not mutate the input state", () => {
      const admitted = admitAttempt(createEmptyConcurrencyState(), attempt("attempt-1"));
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;

      const before = structuredClone(admitted.state);
      const released = releaseAttempt(admitted.state, "  attempt-1  ");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(true);
      expect(admitted.state).toEqual(before);
      expectActiveIds(released.state, []);
    });
  });

  describe("attempt identity uniqueness", () => {
    it("rejects double registration of the same attempt id", () => {
      const first = admitAttempt(createEmptyConcurrencyState(), attempt("same-id", "isolated-pi"));
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const duplicate = admitAttempt(first.state, attempt("same-id", "cli"));
      expect(duplicate.ok).toBe(false);
      if (duplicate.ok) return;
      expect(duplicate.diagnostics.some((d) => d.code === "concurrency_duplicate_attempt")).toBe(true);

      // Global capacity remains one under defaults, so only uniqueness blocked this.
      const other = admitAttempt(first.state, attempt("other-id", "cli"));
      expect(other.ok).toBe(true);
    });
  });

  describe("schema version and stored state integrity", () => {
    it("rejects an unsupported schema version on every state-touching helper", () => {
      const bad = {
        schemaVersion: 99,
        attempts: [],
      } as unknown as ConcurrencyState;

      const schema = validateConcurrencyStateSchema(bad);
      expect(schema.some((d) => d.code === "concurrency_state_unsupported_schema")).toBe(true);

      const paths: Array<{ name: string; run: () => { ok: boolean; diagnostics?: { code: string }[] } }> = [
        {
          name: "canAdmitAttempt",
          run: () => canAdmitAttempt(bad, attempt("a1")),
        },
        {
          name: "admitAttempt",
          run: () => admitAttempt(bad, attempt("a1")),
        },
        {
          name: "releaseAttempt",
          run: () => releaseAttempt(bad, "a1"),
        },
        {
          name: "getGlobalActiveCount",
          run: () => getGlobalActiveCount(bad),
        },
        {
          name: "getExecutorActiveCount",
          run: () => getExecutorActiveCount(bad, "cli"),
        },
        {
          name: "listConcurrencyActiveAttempts",
          run: () => listConcurrencyActiveAttempts(bad),
        },
        {
          name: "getConcurrencyActiveAttempt",
          run: () => getConcurrencyActiveAttempt(bad, "a1"),
        },
      ];

      for (const path of paths) {
        const result = path.run();
        expect(result.ok, path.name).toBe(false);
        if (result.ok) continue;
        expect(
          result.diagnostics?.some((d) => d.code === "concurrency_state_unsupported_schema"),
          path.name,
        ).toBe(true);
      }
    });

    it("rejects a non-plain-object concurrency state", () => {
      class StateClass {
        schemaVersion = 1;
        attempts: ConcurrencyActiveAttempt[] = [];
      }
      const diagnostics = validateConcurrencyStateSchema(new StateClass());
      expect(diagnostics.some((d) => d.code === "concurrency_state_not_plain_object")).toBe(true);
    });

    it("rejects malformed stored attempts without throwing", () => {
      const withNull = {
        schemaVersion: 1,
        attempts: [null],
      } as unknown as ConcurrencyState;

      const schema = validateConcurrencyStateSchema(withNull);
      expect(schema.some((d) => d.code === "concurrency_attempt_not_plain_object")).toBe(true);

      const admit = canAdmitAttempt(withNull, attempt("a1"));
      expect(admit.ok).toBe(false);
      if (admit.ok) return;
      expect(admit.diagnostics.some((d) => d.code === "concurrency_attempt_not_plain_object")).toBe(true);

      const release = releaseAttempt(withNull, "a1");
      expect(release.ok).toBe(false);
      if (release.ok) return;
      expect(release.diagnostics.some((d) => d.code === "concurrency_attempt_not_plain_object")).toBe(true);

      const list = listConcurrencyActiveAttempts(withNull);
      expect(list.ok).toBe(false);

      const withBadRecord = {
        schemaVersion: 1,
        attempts: [{ attemptId: "", executorKind: "cli" }],
      } as unknown as ConcurrencyState;
      const badId = validateConcurrencyStateSchema(withBadRecord);
      expect(badId.some((d) => d.code === "concurrency_invalid_attempt_id")).toBe(true);

      const withBadKind = {
        schemaVersion: 1,
        attempts: [
          {
            attemptId: "x",
            executorKind: "not-a-kind",
          },
        ],
      } as unknown as ConcurrencyState;
      // Plain object with invalid kind is rejected by field validation.
      const badKindStored = validateConcurrencyStateSchema(withBadKind);
      expect(badKindStored.some((d) => d.code === "concurrency_invalid_executor_kind")).toBe(true);

      class AttemptClass {
        attemptId = "a1";
        executorKind = "cli" as ExecutorKind;
      }
      const withInstance = {
        schemaVersion: 1,
        attempts: [new AttemptClass()],
      } as unknown as ConcurrencyState;
      const classStored = validateConcurrencyStateSchema(withInstance);
      expect(classStored.some((d) => d.code === "concurrency_attempt_not_plain_object")).toBe(true);
    });

    it("rejects stored states that contain duplicate canonical attempt ids", () => {
      const duplicate = {
        schemaVersion: 1,
        attempts: [
          { attemptId: "same", executorKind: "cli" },
          { attemptId: "  same  ", executorKind: "isolated-pi" },
        ],
      } as unknown as ConcurrencyState;

      const schema = validateConcurrencyStateSchema(duplicate);
      expect(schema.some((d) => d.code === "concurrency_state_duplicate_attempt_id")).toBe(true);

      const release = releaseAttempt(duplicate, "same");
      expect(release.ok).toBe(false);
      if (release.ok) return;
      expect(release.diagnostics.some((d) => d.code === "concurrency_state_duplicate_attempt_id")).toBe(true);

      const admit = admitAttempt(duplicate, attempt("other"));
      expect(admit.ok).toBe(false);
      if (admit.ok) return;
      expect(admit.diagnostics.some((d) => d.code === "concurrency_state_duplicate_attempt_id")).toBe(true);
    });
  });

  describe("input immutability", () => {
    it("does not mutate input state or candidate on admit", () => {
      const state = createEmptyConcurrencyState();
      const candidate = attempt("attempt-1", "isolated-pi", "profile-a");
      const stateBefore = structuredClone(state);
      const candidateBefore = structuredClone(candidate);

      const result = admitAttempt(state, candidate);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(state).toEqual(stateBefore);
      expect(candidate).toEqual(candidateBefore);
      expect(result.state).not.toBe(state);
      expect(result.state.attempts[0]).not.toBe(candidate);
    });

    it("does not mutate input state on release", () => {
      const admitted = admitAttempt(createEmptyConcurrencyState(), attempt("attempt-1"));
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;
      const before = structuredClone(admitted.state);

      const released = releaseAttempt(admitted.state, "attempt-1");
      expect(released.ok).toBe(true);
      expect(admitted.state).toEqual(before);
    });

    it("returns deep clones from list and get helpers", () => {
      const admitted = admitAttempt(
        createEmptyConcurrencyState(),
        attempt("attempt-1", "cli", "profile-x"),
      );
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;

      const listed = listConcurrencyActiveAttempts(admitted.state);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      listed.attempts[0]!.attemptId = "mutated";
      expect(admitted.state.attempts[0]!.attemptId).toBe("attempt-1");

      const got = getConcurrencyActiveAttempt(admitted.state, "attempt-1");
      expect(got.ok).toBe(true);
      if (!got.ok || got.attempt === undefined) return;
      got.attempt.attemptId = "mutated-again";
      expect(admitted.state.attempts[0]!.attemptId).toBe("attempt-1");
    });
  });

  describe("invalid bounds and validation", () => {
    it("rejects invalid bounds with diagnostics and does not throw", () => {
      const empty = createEmptyConcurrencyState();

      const negative = canAdmitAttempt(empty, attempt("a1"), { globalConcurrency: -1 });
      expect(negative.ok).toBe(false);
      if (negative.ok) return;
      expect(negative.diagnostics.some((d) => d.code === "concurrency_invalid_bound")).toBe(true);

      const notInteger = resolveConcurrencyLimits({ globalConcurrency: 1.5 });
      expect(notInteger.ok).toBe(false);
      if (notInteger.ok) return;
      expect(notInteger.diagnostics.some((d) => d.code === "concurrency_invalid_bound")).toBe(true);

      const badKindMap = resolveConcurrencyLimits({
        perExecutorKind: { "not-a-kind": 1 } as unknown as Partial<Record<ExecutorKind, number>>,
      });
      expect(badKindMap.ok).toBe(false);
      if (badKindMap.ok) return;
      expect(badKindMap.diagnostics.some((d) => d.code === "concurrency_invalid_executor_kind")).toBe(true);

      const badKindBound = resolveConcurrencyLimits({
        perExecutorKind: { cli: -2 },
      });
      expect(badKindBound.ok).toBe(false);
      if (badKindBound.ok) return;
      expect(badKindBound.diagnostics.some((d) => d.code === "concurrency_invalid_bound")).toBe(true);

      const nanBound = resolveConcurrencyLimits({ globalConcurrency: Number.NaN });
      expect(nanBound.ok).toBe(false);
      if (nanBound.ok) return;
      expect(nanBound.diagnostics.some((d) => d.code === "concurrency_invalid_bound")).toBe(true);

      const nonPlainMap = resolveConcurrencyLimits({
        perExecutorKind: new Map() as unknown as Partial<Record<ExecutorKind, number>>,
      });
      expect(nonPlainMap.ok).toBe(false);
      if (nonPlainMap.ok) return;
      expect(nonPlainMap.diagnostics.some((d) => d.code === "concurrency_invalid_per_executor_map")).toBe(true);
    });

    it("rejects non-plain concurrency limits containers and ignores inherited bounds", () => {
      class LimitsClass {
        globalConcurrency = 1;
      }
      const classLimits = resolveConcurrencyLimits(new LimitsClass());
      expect(classLimits.ok).toBe(false);
      if (classLimits.ok) return;
      expect(classLimits.diagnostics.some((d) => d.code === "concurrency_invalid_limits")).toBe(true);

      const primitiveNull = resolveConcurrencyLimits(null);
      expect(primitiveNull.ok).toBe(false);
      if (primitiveNull.ok) return;
      expect(primitiveNull.diagnostics.some((d) => d.code === "concurrency_invalid_limits")).toBe(true);

      const primitiveNumber = resolveConcurrencyLimits(2);
      expect(primitiveNumber.ok).toBe(false);
      if (primitiveNumber.ok) return;
      expect(primitiveNumber.diagnostics.some((d) => d.code === "concurrency_invalid_limits")).toBe(true);

      const primitiveString = resolveConcurrencyLimits("limits");
      expect(primitiveString.ok).toBe(false);
      if (primitiveString.ok) return;
      expect(primitiveString.diagnostics.some((d) => d.code === "concurrency_invalid_limits")).toBe(true);

      const arrayLimits = resolveConcurrencyLimits([]);
      expect(arrayLimits.ok).toBe(false);
      if (arrayLimits.ok) return;
      expect(arrayLimits.diagnostics.some((d) => d.code === "concurrency_invalid_limits")).toBe(true);

      // Custom prototypes (including inherited bounds) are not strict plain objects.
      const withInheritedBound = Object.create({ globalConcurrency: 1 });
      const inheritedResult = resolveConcurrencyLimits(withInheritedBound);
      expect(inheritedResult.ok).toBe(false);
      if (inheritedResult.ok) return;
      expect(inheritedResult.diagnostics.some((d) => d.code === "concurrency_invalid_limits")).toBe(true);

      // Empty plain object uses defaults (no own bounds).
      const defaults = resolveConcurrencyLimits({});
      expect(defaults.ok).toBe(true);
      if (!defaults.ok) return;
      expect(defaults.value.globalConcurrency).toBe(DEFAULT_GLOBAL_CONCURRENCY);

      // Own-property-only: a null-prototype bag with only an own empty shape uses defaults.
      const nullProto = Object.create(null) as Record<string, unknown>;
      const nullProtoResult = resolveConcurrencyLimits(nullProto);
      expect(nullProtoResult.ok).toBe(true);
      if (!nullProtoResult.ok) return;
      expect(nullProtoResult.value.globalConcurrency).toBe(DEFAULT_GLOBAL_CONCURRENCY);

      // admitAttempt rejects class-instance limits with diagnostics (no throw).
      const admitWithClass = admitAttempt(
        createEmptyConcurrencyState(),
        attempt("a1"),
        new LimitsClass(),
      );
      expect(admitWithClass.ok).toBe(false);
      if (admitWithClass.ok) return;
      expect(admitWithClass.diagnostics.some((d) => d.code === "concurrency_invalid_limits")).toBe(true);
    });

    it("rejects invalid attempt records and class instances", () => {
      const emptyId = validateConcurrencyActiveAttempt({
        attemptId: "  ",
        executorKind: "cli",
      });
      expect(emptyId.some((d) => d.code === "concurrency_invalid_attempt_id")).toBe(true);

      const badKind = validateConcurrencyActiveAttempt({
        attemptId: "a1",
        executorKind: "unknown",
      });
      expect(badKind.some((d) => d.code === "concurrency_invalid_executor_kind")).toBe(true);

      const badProfile = validateConcurrencyActiveAttempt({
        attemptId: "a1",
        executorKind: "cli",
        profileId: "  ",
      });
      expect(badProfile.some((d) => d.code === "concurrency_invalid_profile_id")).toBe(true);

      class AttemptClass {
        attemptId = "a1";
        executorKind = "cli" as ExecutorKind;
      }
      const classInstance = validateConcurrencyActiveAttempt(new AttemptClass());
      expect(classInstance.some((d) => d.code === "concurrency_attempt_not_plain_object")).toBe(true);

      const parsed = parseConcurrencyActiveAttempt({
        attemptId: "  attempt-x  ",
        executorKind: "deterministic",
        profileId: "  profile-1  ",
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.attemptId).toBe("attempt-x");
      expect(parsed.value.profileId).toBe("profile-1");

      const proposed = proposeConcurrencyActiveAttempt({
        attemptId: "p1",
        executorKind: "acp",
      });
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      expect(proposed.value.executorKind).toBe("acp");
    });

    it("rejects admit of an invalid candidate with diagnostics", () => {
      const result = admitAttempt(createEmptyConcurrencyState(), {
        attemptId: "",
        executorKind: "cli",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics.some((d) => d.code === "concurrency_invalid_attempt_id")).toBe(true);
    });

    it("rejects getExecutorActiveCount for an unknown executor kind", () => {
      const state = createEmptyConcurrencyState();
      const result = getExecutorActiveCount(state, "not-real" as ExecutorKind);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics.some((d) => d.code === "concurrency_invalid_executor_kind")).toBe(true);
    });
  });

  describe("accessor properties and clean field copies", () => {
    it("rejects limits with throwing getters and accessor properties without throwing", () => {
      const throwingGlobal: Record<string, unknown> = {};
      Object.defineProperty(throwingGlobal, "globalConcurrency", {
        enumerable: true,
        get() {
          throw new Error("getter must not run");
        },
      });
      const globalResult = resolveConcurrencyLimits(throwingGlobal);
      expect(globalResult.ok).toBe(false);
      if (globalResult.ok) return;
      expect(globalResult.diagnostics.some((d) => d.code === "concurrency_invalid_accessor")).toBe(true);

      const throwingPerKind: Record<string, unknown> = { globalConcurrency: 2 };
      Object.defineProperty(throwingPerKind, "perExecutorKind", {
        enumerable: true,
        get() {
          throw new Error("getter must not run");
        },
      });
      const perKindResult = resolveConcurrencyLimits(throwingPerKind);
      expect(perKindResult.ok).toBe(false);
      if (perKindResult.ok) return;
      expect(perKindResult.diagnostics.some((d) => d.code === "concurrency_invalid_accessor")).toBe(true);

      const kindMap: Record<string, unknown> = {};
      Object.defineProperty(kindMap, "cli", {
        enumerable: true,
        get() {
          throw new Error("kind getter must not run");
        },
      });
      const nested = resolveConcurrencyLimits({
        globalConcurrency: 2,
        perExecutorKind: kindMap,
      });
      expect(nested.ok).toBe(false);
      if (nested.ok) return;
      expect(nested.diagnostics.some((d) => d.code === "concurrency_invalid_accessor")).toBe(true);

      const admitWithAccessor = admitAttempt(
        createEmptyConcurrencyState(),
        attempt("a1"),
        throwingGlobal,
      );
      expect(admitWithAccessor.ok).toBe(false);
      if (admitWithAccessor.ok) return;
      expect(admitWithAccessor.diagnostics.some((d) => d.code === "concurrency_invalid_accessor")).toBe(true);
    });

    it("rejects attempts with throwing getters without throwing", () => {
      const candidate: Record<string, unknown> = { executorKind: "cli" };
      Object.defineProperty(candidate, "attemptId", {
        enumerable: true,
        get() {
          throw new Error("attemptId getter must not run");
        },
      });
      const validated = validateConcurrencyActiveAttempt(candidate);
      expect(validated.some((d) => d.code === "concurrency_invalid_accessor")).toBe(true);

      const admit = admitAttempt(createEmptyConcurrencyState(), candidate);
      expect(admit.ok).toBe(false);
      if (admit.ok) return;
      expect(admit.diagnostics.some((d) => d.code === "concurrency_invalid_accessor")).toBe(true);

      const kindGetter: Record<string, unknown> = { attemptId: "a1" };
      Object.defineProperty(kindGetter, "executorKind", {
        enumerable: true,
        get() {
          throw new Error("executorKind getter must not run");
        },
      });
      const kindResult = parseConcurrencyActiveAttempt(kindGetter);
      expect(kindResult.ok).toBe(false);
      if (kindResult.ok) return;
      expect(kindResult.diagnostics.some((d) => d.code === "concurrency_invalid_accessor")).toBe(true);
    });

    it("rejects state with throwing getters on schemaVersion or attempts without throwing", () => {
      const schemaGetter: Record<string, unknown> = { attempts: [] };
      Object.defineProperty(schemaGetter, "schemaVersion", {
        enumerable: true,
        get() {
          throw new Error("schemaVersion getter must not run");
        },
      });
      const schemaState = schemaGetter as unknown as ConcurrencyState;
      const schemaDiag = validateConcurrencyStateSchema(schemaState);
      expect(schemaDiag.some((d) => d.code === "concurrency_invalid_accessor")).toBe(true);
      expect(canAdmitAttempt(schemaState, attempt("a1")).ok).toBe(false);
      expect(releaseAttempt(schemaState, "a1").ok).toBe(false);
      expect(getGlobalActiveCount(schemaState).ok).toBe(false);
      expect(listConcurrencyActiveAttempts(schemaState).ok).toBe(false);

      const attemptsGetter: Record<string, unknown> = { schemaVersion: 1 };
      Object.defineProperty(attemptsGetter, "attempts", {
        enumerable: true,
        get() {
          throw new Error("attempts getter must not run");
        },
      });
      const attemptsState = attemptsGetter as unknown as ConcurrencyState;
      const attemptsDiag = validateConcurrencyStateSchema(attemptsState);
      expect(attemptsDiag.some((d) => d.code === "concurrency_invalid_accessor")).toBe(true);
      expect(getExecutorActiveCount(attemptsState, "cli").ok).toBe(false);
      expect(getConcurrencyActiveAttempt(attemptsState, "a1").ok).toBe(false);
    });

    it("admits and lists attempts that carry uncloneable extra properties without throwing", () => {
      const candidate: Record<string, unknown> = {
        attemptId: "extra-fn",
        executorKind: "cli",
        // Uncloneable extra property must not be copied or cloned.
        onEvent: () => "side-effect",
      };

      const admitted = admitAttempt(createEmptyConcurrencyState(), candidate);
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;
      expect(admitted.state.attempts).toHaveLength(1);
      expect(admitted.state.attempts[0]).toEqual({
        attemptId: "extra-fn",
        executorKind: "cli",
      });
      expect(
        Object.prototype.hasOwnProperty.call(admitted.state.attempts[0], "onEvent"),
      ).toBe(false);

      // Stored dirty object with extra function must still list/get/release cleanly.
      const dirtyState = {
        schemaVersion: 1,
        attempts: [
          {
            attemptId: "stored-dirty",
            executorKind: "isolated-pi",
            helper: () => 1,
            marker: Symbol("x"),
          },
        ],
      } as unknown as ConcurrencyState;

      const listed = listConcurrencyActiveAttempts(dirtyState);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.attempts).toEqual([
        { attemptId: "stored-dirty", executorKind: "isolated-pi" },
      ]);

      const got = getConcurrencyActiveAttempt(dirtyState, "stored-dirty");
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.attempt).toEqual({
        attemptId: "stored-dirty",
        executorKind: "isolated-pi",
      });

      const released = releaseAttempt(dirtyState, "stored-dirty");
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.released).toBe(true);
      expect(released.state.attempts).toEqual([]);

      const secondAdmit = admitAttempt(dirtyState, attempt("next", "cli"), {
        globalConcurrency: 2,
      });
      expect(secondAdmit.ok).toBe(true);
      if (!secondAdmit.ok) return;
      expect(secondAdmit.state.attempts.map((item) => item.attemptId).sort()).toEqual([
        "next",
        "stored-dirty",
      ]);
      for (const item of secondAdmit.state.attempts) {
        expect(Object.keys(item).sort()).toEqual(["attemptId", "executorKind"]);
      }
    });

    it("rejects proposeConcurrencyActiveAttempt when fields use throwing getters", () => {
      const hostile: Record<string, unknown> = { executorKind: "cli" };
      Object.defineProperty(hostile, "attemptId", {
        enumerable: true,
        get() {
          throw new Error("propose attemptId getter must not run");
        },
      });
      const proposed = proposeConcurrencyActiveAttempt(hostile);
      expect(proposed.ok).toBe(false);
      if (proposed.ok) return;
      expect(proposed.diagnostics.some((d) => d.code === "concurrency_invalid_accessor")).toBe(true);
    });

    it("rejects empty accessor descriptors without treating them as data defaults", () => {
      // Empty accessor: get/set keys present with undefined functions (not a data property).
      const emptyAccessorDescriptor = {
        enumerable: true,
        configurable: true,
        get: undefined,
        set: undefined,
      } as unknown as PropertyDescriptor;

      const emptyAccessorLimits: Record<string, unknown> = {};
      Object.defineProperty(emptyAccessorLimits, "globalConcurrency", emptyAccessorDescriptor);
      const limitsResult = resolveConcurrencyLimits(emptyAccessorLimits);
      expect(limitsResult.ok).toBe(false);
      if (limitsResult.ok) return;
      expect(limitsResult.diagnostics.some((d) => d.code === "concurrency_invalid_accessor")).toBe(true);

      const emptyAccessorAttempt: Record<string, unknown> = {
        executorKind: "cli",
      };
      Object.defineProperty(emptyAccessorAttempt, "attemptId", emptyAccessorDescriptor);
      const attemptResult = parseConcurrencyActiveAttempt(emptyAccessorAttempt);
      expect(attemptResult.ok).toBe(false);
      if (attemptResult.ok) return;
      expect(attemptResult.diagnostics.some((d) => d.code === "concurrency_invalid_accessor")).toBe(true);
    });

    it("reads attempts length via data descriptor and survives a hostile length getter trap", () => {
      const realAttempts = [
        { attemptId: "hidden-1", executorKind: "cli" as const },
      ];
      const hostileAttempts = new Proxy(realAttempts, {
        get(target, prop, receiver) {
          if (prop === "length") {
            throw new Error("length getter trap must not run");
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const state = {
        schemaVersion: 1,
        attempts: hostileAttempts,
      } as unknown as ConcurrencyState;

      const count = getGlobalActiveCount(state);
      expect(count.ok).toBe(true);
      if (!count.ok) return;
      expect(count.count).toBe(1);

      const listed = listConcurrencyActiveAttempts(state);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.attempts.map((item) => item.attemptId)).toEqual(["hidden-1"]);
    });

    it("rejects unsupported schema values with hostile string conversion without throwing", () => {
      const hostileVersion = {
        toString() {
          throw new Error("toString must not run");
        },
        valueOf() {
          throw new Error("valueOf must not run");
        },
      };
      const state = {
        schemaVersion: hostileVersion,
        attempts: [],
      } as unknown as ConcurrencyState;

      const diagnostics = validateConcurrencyStateSchema(state);
      expect(diagnostics.some((d) => d.code === "concurrency_state_unsupported_schema")).toBe(true);
      expect(diagnostics[0]?.message).toContain("[object]");
      expect(canAdmitAttempt(state, attempt("a1")).ok).toBe(false);
    });

    it("admits from a single clean snapshot when the candidate proxy changes attemptId between reads", () => {
      // First admit a fixed attempt so the flaky id collides if the first snapshot is used.
      const first = admitAttempt(createEmptyConcurrencyState(), attempt("stable-id", "cli"));
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      let attemptIdReads = 0;
      const flakyCandidate = new Proxy(
        {
          attemptId: "stable-id",
          executorKind: "cli",
        },
        {
          getOwnPropertyDescriptor(target, prop) {
            if (prop === "attemptId") {
              attemptIdReads += 1;
              // First parse sees the colliding id. Later reads would flip to a free id.
              // admitAttempt must not re-parse and admit the free id after a first-pass reject.
              const value = attemptIdReads === 1 ? "stable-id" : "free-id";
              return {
                configurable: true,
                enumerable: true,
                writable: true,
                value,
              };
            }
            return Reflect.getOwnPropertyDescriptor(target, prop);
          },
          ownKeys(target) {
            return Reflect.ownKeys(target);
          },
          get(target, prop, receiver) {
            // Force descriptor path: direct gets are not used for validation.
            return Reflect.get(target, prop, receiver);
          },
        },
      );

      const second = admitAttempt(first.state, flakyCandidate, { globalConcurrency: 2 });
      // First (and only) parse sees stable-id, which is already active.
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.diagnostics.some((d) => d.code === "concurrency_duplicate_attempt")).toBe(true);
      // A second untrusted parse would have increased attemptIdReads further and admitted free-id.
      expect(attemptIdReads).toBe(1);
      expect(first.state.attempts.map((item) => item.attemptId)).toEqual(["stable-id"]);
    });
  });
});
