import { describe, expect, it } from "vitest";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow } from "../src/domain/reducer.js";
import { projectGraphView } from "../src/graph/projection.js";
import { loopSurfaceSummaries, renderLoopStatus } from "../src/ui/loop-surface.js";

const at = "2026-07-23T14:30:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Evaluation validity surface",
  goal: "Show trustworthy observation state",
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
    successWhen: { kind: "compare", left: { kind: "fact", name: "evaluation.accepted" }, operator: "eq", right: { kind: "literal", value: true } },
    maxIterations: 5,
    progress: { fact: "evaluation.score", direction: "maximize" },
    patience: 2,
    evaluation: {
      validWhen: { kind: "compare", left: { kind: "fact", name: "evaluation.valid" }, operator: "eq", right: { kind: "literal", value: true } },
      maximumInvalidEvaluations: 3,
    },
  }],
  policy: { mode: "guided", requireEvidence: false },
});

describe("M5A evaluation validity surfaces", () => {
  it("projects current validity and remaining invalid observations", () => {
    const created = createWorkflow(definition(), at, "workflow-evaluation-surface");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const state = structuredClone(created.state);
    Object.assign(state.runtime.loops["quality-loop"]!, {
      status: "running",
      currentIteration: 3,
      lastValid: false,
      lastSuccess: false,
      invalidEvaluationCount: 1,
      currentMetric: 10,
      bestMetric: 10,
      bestIteration: 1,
      noProgressCount: 1,
    });

    expect(projectGraphView(state).loops[0]).toMatchObject({
      lastValid: false,
      invalidEvaluationCount: 1,
      maximumInvalidEvaluations: 3,
      remainingInvalidEvaluations: 2,
      currentMetric: 10,
      bestMetric: 10,
    });
    expect(loopSurfaceSummaries(state)[0]).toMatchObject({
      evaluation: { lastValid: false, invalidCount: 1, maximumInvalid: 3, remainingInvalid: 2 },
    });
    expect(renderLoopStatus(state)).toContain("valid false, invalid 1/3");
  });

  it("explains invalid-evaluation exhaustion", () => {
    const created = createWorkflow(definition(), at, "workflow-evaluation-surface-failed");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const state = structuredClone(created.state);
    Object.assign(state.runtime.loops["quality-loop"]!, {
      status: "failed",
      currentIteration: 3,
      lastValid: false,
      invalidEvaluationCount: 3,
      exitReason: "invalid_evaluations",
    });

    expect(loopSurfaceSummaries(state)[0]).toMatchObject({
      exitReason: "invalid_evaluations",
      warning: { code: "loop_invalid_evaluations_exhausted" },
    });
    expect(renderLoopStatus(state)).toContain("loop_invalid_evaluations_exhausted");
  });
});
