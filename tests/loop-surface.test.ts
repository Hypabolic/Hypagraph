import { describe, expect, it } from "vitest";
import type { DomainEvent, FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { loopSurfaceSummaries, renderLoopStatus } from "../src/ui/loop-surface.js";

const at = "2026-07-23T10:00:00.000Z";

const definition = (overrides: Partial<HypagraphDefinition["loops"][number]> = {}): HypagraphDefinition => ({
  title: "Slice 8 loop surface",
  goal: "Explain bounded iteration state",
  nodes: [
    { id: "improve", title: "Improve", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate",
      requires: ["improve"],
      acceptance: [],
      produces: [
        { name: "quality.passed", type: "boolean", required: true },
        { name: "quality.score", type: "number", required: true },
      ],
    },
    { id: "publish", title: "Publish", requires: ["evaluate"], acceptance: [] },
  ],
  loops: [{
    id: "quality-loop",
    nodes: ["improve", "evaluate"],
    entry: "improve",
    evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "improve" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "quality.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 3,
    progress: { fact: "quality.score", direction: "maximize", minDelta: 1 },
    patience: 2,
    failurePolicy: "block-dependants",
    ...overrides,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const runIteration = (state: HypagraphState, events: DomainEvent[], number: number, score: number, passed = false): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId: "improve", attemptId: `improve-${number}`, commandId: `improve-${number}-start`, at });
  next = apply(next, events, { type: "submit-result", nodeId: "improve", attemptId: `improve-${number}`, evidence: [], commandId: `improve-${number}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId: "improve", attemptId: `improve-${number}`, commandId: `improve-${number}-begin`, at });
  next = apply(next, events, { type: "complete-verification", nodeId: "improve", attemptId: `improve-${number}`, passed: true, commandId: `improve-${number}-verify`, at });
  next = apply(next, events, { type: "start-node", nodeId: "evaluate", attemptId: `evaluate-${number}`, commandId: `evaluate-${number}-start`, at });
  const facts: FactInput[] = [
    { name: "quality.passed", type: "boolean", value: passed },
    { name: "quality.score", type: "number", value: score },
  ];
  next = apply(next, events, { type: "publish-facts", nodeId: "evaluate", attemptId: `evaluate-${number}`, facts, commandId: `evaluate-${number}-facts`, at });
  next = apply(next, events, { type: "submit-result", nodeId: "evaluate", attemptId: `evaluate-${number}`, evidence: [], commandId: `evaluate-${number}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId: "evaluate", attemptId: `evaluate-${number}`, commandId: `evaluate-${number}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId: "evaluate", attemptId: `evaluate-${number}`, passed: true, commandId: `evaluate-${number}-verify`, at });
};

describe("M4 Slice 8 loop product surface", () => {
  it("projects canonical pending loop details", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-surface-pending");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));

    expect(loopSurfaceSummaries(created.state)).toEqual([expect.objectContaining({
      id: "quality-loop",
      status: "pending",
      iteration: { current: 0, limit: 3 },
      evaluationNodeId: "evaluate",
      feedbackEdges: [{ source: "evaluate", target: "improve", selected: false }],
      failurePolicy: "block-dependants",
      localOutcome: "pending",
      workflowEffect: "pending",
      progress: expect.objectContaining({
        fact: "quality.score",
        direction: "maximize",
        minDelta: 1,
        noProgressCount: 0,
        patience: 2,
        remainingPatience: 2,
      }),
    })]);
  });

  it("shows selected feedback and ready entry after continuation", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-surface-running");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    const state = runIteration(created.state, events, 1, 10);
    const summary = loopSurfaceSummaries(state)[0]!;

    expect(state.runtime.nodes.improve?.status).toBe("ready");
    expect(summary).toMatchObject({
      status: "running",
      iteration: { current: 2, limit: 3 },
      lastSuccess: false,
      feedbackEdges: [{ source: "evaluate", target: "improve", selected: true }],
      progress: { currentMetric: 10, bestMetric: 10, bestIteration: 1, noProgressCount: 0, remainingPatience: 2 },
    });
    expect(renderLoopStatus(state)).toContain("evaluate->improve (selected)");
  });

  it("projects successful local outcome and dependant release", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-surface-success");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    const state = runIteration(created.state, events, 1, 10, true);

    expect(loopSurfaceSummaries(state)[0]).toMatchObject({
      status: "succeeded",
      localOutcome: "succeeded",
      workflowEffect: "releases-dependants",
      exitReason: "success",
      lastSuccess: true,
    });
    expect(state.runtime.nodes.publish?.status).toBe("ready");
  });

  it("explains hard-limit exhaustion without raw events", () => {
    const created = createWorkflow(definition({ maxIterations: 1 }), at, "workflow-loop-surface-exhausted");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    const state = runIteration(created.state, events, 1, 10);
    const summary = loopSurfaceSummaries(state)[0]!;

    expect(summary).toMatchObject({
      status: "failed",
      localOutcome: "failed",
      workflowEffect: "blocks-dependants",
      exitReason: "max_iterations",
      warning: { code: "loop_max_iterations_exhausted" },
    });
    expect(renderLoopStatus(state)).toContain("loop_max_iterations_exhausted");
  });

  it("warns when a legacy predicate requires typed revision", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-surface-legacy");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const state = structuredClone(created.state);
    state.definition.loops[0]!.successWhen = { kind: "legacy-text", text: "tests are good" };
    state.runtime.loops["quality-loop"]!.status = "requires_revision";
    state.runtime.loops["quality-loop"]!.legacyPredicate = "tests are good";

    expect(loopSurfaceSummaries(state)[0]).toMatchObject({
      status: "requires_revision",
      warning: { code: "loop_predicate_revision_required" },
    });
  });
});
