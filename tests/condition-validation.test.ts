import { describe, expect, it } from "vitest";
import type { Condition } from "../src/domain/conditions.js";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { validateDefinition } from "../src/domain/validate.js";

const definition = (condition: Condition): HypagraphDefinition => ({
  title: "Validate conditions",
  goal: "Reject invalid gate conditions before execution",
  nodes: [
    {
      id: "inspect",
      title: "Inspect",
      requires: [],
      acceptance: [],
      produces: [
        { name: "tests.failed", type: "integer" },
        { name: "tests.names", type: "string-list" },
        { name: "tests.label", type: "string" },
      ],
    },
    {
      id: "choose",
      title: "Choose",
      kind: "gate",
      requires: ["inspect"],
      acceptance: [],
      gate: { condition, onTrue: ["pass"], onFalse: ["fail"] },
    },
    { id: "pass", title: "Pass", requires: ["choose"], acceptance: [] },
    { id: "fail", title: "Fail", requires: ["choose"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const codes = (value: HypagraphDefinition): string[] => validateDefinition(value).map((item) => item.code);

describe("condition validation", () => {
  it("accepts compatible numeric and collection operators", () => {
    expect(codes(definition({
      kind: "all",
      conditions: [
        { kind: "compare", left: { kind: "fact", name: "tests.failed" }, operator: "lte", right: { kind: "literal", value: 0.5 } },
        { kind: "compare", left: { kind: "fact", name: "tests.names" }, operator: "contains", right: { kind: "literal", value: "unit" } },
        { kind: "compare", left: { kind: "fact", name: "tests.label" }, operator: "in", right: { kind: "literal", value: ["unit", "integration"] } },
      ],
    }))).toEqual([]);
  });

  it("rejects an operator that cannot use the operand types", () => {
    expect(codes(definition({
      kind: "compare",
      left: { kind: "fact", name: "tests.names" },
      operator: "gt",
      right: { kind: "literal", value: 0 },
    }))).toContain("condition_type_mismatch");
  });

  it("rejects empty condition groups", () => {
    expect(codes(definition({ kind: "any", conditions: [] }))).toContain("empty_condition_group");
  });

  it("rejects facts that are not produced upstream", () => {
    const value = definition({ kind: "exists", fact: "later.value" });
    value.nodes.push({ id: "later", title: "Later", requires: ["pass"], acceptance: [], produces: [{ name: "later.value", type: "boolean" }] });
    expect(codes(value)).toContain("condition_fact_not_upstream");
  });

  it("rejects facts produced by a gate", () => {
    const value = definition({ kind: "exists", fact: "tests.failed" });
    value.nodes[1]!.produces = [{ name: "gate.result", type: "boolean" }];
    expect(codes(value)).toContain("gate_produces_facts");
  });
});
