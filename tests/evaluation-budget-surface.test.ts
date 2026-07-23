import { describe, expect, it } from "vitest";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";
import { projectGraphView } from "../src/graph/projection.js";

const at = "2026-07-23T15:30:00.000Z";

const definition: HypagraphDefinition = {
  title: "Evaluation budget surface",
  goal: "Show evaluation counts and remaining limits",
  nodes: [{
    id: "evaluate",
    title: "Evaluate",
    kind: "check",
    requires: [],
    acceptance: [],
    produces: [{ name: "evaluation.score", type: "number", required: false }],
    check: {
      kind: "metric-report",
      command: "evaluator",
      timeoutMs: 30_000,
      reportPath: "metrics.json",
      parser: { name: "metric-json", version: 1 },
      mappings: [{ source: "score", fact: "evaluation.score", type: "number", required: false }],
      evaluation: { kind: "probe", feedback: { mode: "aggregate" } },
    },
  }],
  loops: [],
  evaluation: { budget: { maximumEvaluations: 5, maximumProbeEvaluations: 2 } },
  policy: { mode: "guided", requireEvidence: false },
};

describe("M5A evaluation budget projection", () => {
  it("projects counts, limits, remaining values, and replay state", () => {
    const created = createWorkflow(definition, at, "workflow-evaluation-surface");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = handleCommand(created.state, { type: "start-check", nodeId: "evaluate", attemptId: "evaluate-1", commandId: "start", at });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));

    expect(projectGraphView(started.state).evaluationBudget).toEqual({
      counts: expect.objectContaining({ total: 1, development: 0, probe: 1, holdout: 0 }),
      limits: { maximumEvaluations: 5, maximumProbeEvaluations: 2 },
      remaining: { total: 4, probe: 1 },
    });
    expect(replayEvents([...created.events, ...started.events])).toEqual(started.state);
  });
});
