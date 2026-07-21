import { describe, expect, it } from "vitest";
import { evaluateCondition, type Condition } from "../src/domain/conditions.js";
import { indexFacts, validatePublishedFact, type FactContract, type FactRecord, type PublishedFact } from "../src/domain/facts.js";

const contracts: FactContract[] = [
  { name: "tests.failed", type: "integer" },
  { name: "coverage.line", type: "number" },
  { name: "build.platform", type: "string" },
];

const fact = (overrides: Partial<PublishedFact> = {}): PublishedFact => ({
  name: "tests.failed",
  type: "integer",
  value: 0,
  producerNodeId: "test",
  attemptId: "attempt-1",
  revision: 2,
  evidence: [{ ref: "command:npm-test", kind: "command" }],
  ...overrides,
});

const record = (overrides: Partial<FactRecord> = {}): FactRecord => ({
  ...fact(),
  eventId: "event-1",
  sequence: 1,
  ...overrides,
});

describe("typed facts", () => {
  it("accepts a declared fact from the current attempt", () => {
    expect(validatePublishedFact(fact(), { contracts, currentRevision: 2, currentAttemptId: "attempt-1" })).toEqual({ ok: true, fact: fact() });
  });

  it("rejects undeclared and stale facts", () => {
    expect(validatePublishedFact(fact({ name: "tests.total" }), { contracts, currentRevision: 2, currentAttemptId: "attempt-1" })).toMatchObject({ ok: false, code: "fact_not_declared" });
    expect(validatePublishedFact(fact({ revision: 1 }), { contracts, currentRevision: 2, currentAttemptId: "attempt-1" })).toMatchObject({ ok: false, code: "stale_fact_revision" });
    expect(validatePublishedFact(fact({ attemptId: "attempt-old" }), { contracts, currentRevision: 2, currentAttemptId: "attempt-1" })).toMatchObject({ ok: false, code: "stale_fact_attempt" });
  });

  it("rejects invalid fact values", () => {
    expect(validatePublishedFact(fact({ value: 1.5 }), { contracts, currentRevision: 2, currentAttemptId: "attempt-1" })).toMatchObject({ ok: false, code: "fact_value_invalid" });
  });
});

describe("condition evaluator", () => {
  const facts = indexFacts([
    record(),
    record({ name: "coverage.line", type: "number", value: 92, eventId: "event-2", sequence: 2 }),
    record({ name: "build.platform", type: "string", value: "linux", eventId: "event-3", sequence: 3 }),
  ]);

  it("evaluates an all condition with deterministic fact tracking", () => {
    const condition: Condition = {
      kind: "all",
      conditions: [
        { kind: "compare", left: { kind: "fact", name: "tests.failed" }, operator: "eq", right: { kind: "literal", value: 0 } },
        { kind: "compare", left: { kind: "fact", name: "coverage.line" }, operator: "gte", right: { kind: "literal", value: 90 } },
        { kind: "compare", left: { kind: "fact", name: "build.platform" }, operator: "in", right: { kind: "literal", value: ["linux", "macos"] } },
      ],
    };

    expect(evaluateCondition(condition, facts)).toEqual({
      ok: true,
      value: true,
      factsUsed: ["build.platform", "coverage.line", "tests.failed"],
    });
  });

  it("reports a missing fact instead of guessing", () => {
    expect(evaluateCondition({ kind: "compare", left: { kind: "fact", name: "lint.errors" }, operator: "eq", right: { kind: "literal", value: 0 } }, facts)).toMatchObject({
      ok: false,
      code: "fact_missing",
      factsUsed: ["lint.errors"],
    });
  });
});
