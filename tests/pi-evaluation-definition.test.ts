import { describe, expect, it } from "vitest";
import { createWorkflow } from "../src/domain/reducer.js";
import { normalizeDefinition, type HypagraphDefineInput } from "../src/pi/definition.js";

const at = "2026-07-23T14:20:00.000Z";

const input = (): HypagraphDefineInput => ({
  title: "Author trusted evaluation",
  goal: "Keep score validity separate from success",
  nodes: [
    { id: "improve", title: "Improve", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate",
      requires: ["improve"],
      acceptance: [],
      produces: [
        { name: "evaluation.valid", type: "boolean", required: true },
        { name: "evaluation.accepted", type: "boolean", required: true },
        { name: "evaluation.score", type: "number", required: true },
      ],
    },
  ],
  loops: [{
    id: "quality-loop",
    nodes: ["improve", "evaluate"],
    entry: "improve",
    evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "improve" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "evaluation.accepted" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 6,
    progress: { fact: "evaluation.score", direction: "maximize", minDelta: 0.01 },
    evaluation: {
      validWhen: {
        kind: "compare",
        left: { kind: "fact", name: "evaluation.valid" },
        operator: "eq",
        right: { kind: "literal", value: true },
      },
      maximumInvalidEvaluations: 3,
    },
  }],
});

describe("M5A evaluation validity authoring", () => {
  it("normalizes and validates the loop evaluation policy", () => {
    const normalized = normalizeDefinition(input());
    expect(normalized.loops[0]?.evaluation).toEqual({
      validWhen: {
        kind: "compare",
        left: { kind: "fact", name: "evaluation.valid" },
        operator: "eq",
        right: { kind: "literal", value: true },
      },
      maximumInvalidEvaluations: 3,
    });
    expect(createWorkflow(normalized, at, "workflow-pi-evaluation-validity").ok).toBe(true);
  });

  it("deep clones the validity condition", () => {
    const value = input();
    const normalized = normalizeDefinition(value);
    const condition = value.loops![0]!.evaluation!.validWhen;
    if (condition.kind !== "compare" || condition.left.kind !== "fact") throw new Error("Expected comparison validity condition.");
    condition.left.name = "evaluation.changed";
    value.loops![0]!.evaluation!.maximumInvalidEvaluations = 9;

    expect(normalized.loops[0]?.evaluation).toEqual({
      validWhen: {
        kind: "compare",
        left: { kind: "fact", name: "evaluation.valid" },
        operator: "eq",
        right: { kind: "literal", value: true },
      },
      maximumInvalidEvaluations: 3,
    });
  });
});
