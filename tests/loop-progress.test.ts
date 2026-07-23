import { describe, expect, it } from "vitest";
import type { DomainEvent, FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { validateDefinition } from "../src/domain/validate.js";

const at = "2026-07-23T06:00:00.000Z";

const definition = (overrides: Partial<HypagraphDefinition["loops"][number]> = {}): HypagraphDefinition => ({
  title: "Progress loop",
  goal: "Track quality progress",
  nodes: [
    { id: "repair", title: "Repair", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate",
      requires: ["repair"],
      acceptance: [],
      produces: [
        { name: "quality.passed", type: "boolean", required: true },
        { name: "quality.score", type: "number", required: false },
      ],
    },
    { id: "document", title: "Document", requires: ["evaluate"], acceptance: [] },
  ],
  loops: [{
    id: "quality-loop",
    nodes: ["repair", "evaluate"],
    entry: "repair",
    evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "repair" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "quality.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 6,
    progress: { fact: "quality.score", direction: "maximize", minDelta: 1 },
    patience: 2,
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

const iteration = (state: HypagraphState, events: DomainEvent[], number: number, score: number | undefined, passed = false): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId: "repair", attemptId: `repair-${number}`, commandId: `repair-${number}-start`, at });
  next = apply(next, events, { type: "submit-result", nodeId: "repair", attemptId: `repair-${number}`, evidence: [], commandId: `repair-${number}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId: "repair", attemptId: `repair-${number}`, commandId: `repair-${number}-begin`, at });
  next = apply(next, events, { type: "complete-verification", nodeId: "repair", attemptId: `repair-${number}`, passed: true, commandId: `repair-${number}-verify`, at });
  next = apply(next, events, { type: "start-node", nodeId: "evaluate", attemptId: `evaluate-${number}`, commandId: `evaluate-${number}-start`, at });
  const facts: FactInput[] = [{ name: "quality.passed", type: "boolean", value: passed }];
  if (score !== undefined) facts.push({ name: "quality.score", type: "number", value: score });
  next = apply(next, events, { type: "publish-facts", nodeId: "evaluate", attemptId: `evaluate-${number}`, facts, commandId: `evaluate-${number}-facts`, at });
  next = apply(next, events, { type: "submit-result", nodeId: "evaluate", attemptId: `evaluate-${number}`, evidence: [], commandId: `evaluate-${number}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId: "evaluate", attemptId: `evaluate-${number}`, commandId: `evaluate-${number}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId: "evaluate", attemptId: `evaluate-${number}`, passed: true, commandId: `evaluate-${number}-verify`, at });
};

describe("M4 Slice 5 progress and patience", () => {
  it("tracks best progress, applies strict minDelta, resets patience, and fails on no progress", () => {
    const created = createWorkflow(definition(), at, "workflow-progress");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = iteration(created.state, events, 1, 10);
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ currentIteration: 2, bestMetric: 10, bestIteration: 1, noProgressCount: 0 });
    state = iteration(state, events, 2, 11);
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ currentIteration: 3, currentMetric: 11, bestMetric: 10, bestIteration: 1, noProgressCount: 1 });
    state = iteration(state, events, 3, 12.1);
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ currentIteration: 4, bestMetric: 12.1, bestIteration: 3, noProgressCount: 0 });
    state = iteration(state, events, 4, 12.1);
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ currentIteration: 5, noProgressCount: 1 });
    state = iteration(state, events, 5, 12);
    expect(state.phase).toBe("failed");
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ status: "failed", exitReason: "no_progress", bestMetric: 12.1, bestIteration: 3, noProgressCount: 2 });
    expect(state.runtime.loops["quality-loop"]?.iterations.map((item) => ({ iteration: item.iteration, metric: item.metric, improved: item.improved, count: item.noProgressCount, decision: item.decision }))).toEqual([
      { iteration: 1, metric: 10, improved: true, count: 0, decision: "continue" },
      { iteration: 2, metric: 11, improved: false, count: 1, decision: "continue" },
      { iteration: 3, metric: 12.1, improved: true, count: 0, decision: "continue" },
      { iteration: 4, metric: 12.1, improved: false, count: 1, decision: "continue" },
      { iteration: 5, metric: 12, improved: false, count: 2, decision: "fail" },
    ]);
    expect(replayEvents(events)).toEqual(state);
  });

  it("lets success complete without metric improvement", () => {
    const created = createWorkflow(definition({ maxIterations: 3, patience: 1 }), at, "workflow-success-progress");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = iteration(created.state, events, 1, 10);
    state = iteration(state, events, 2, 10, true);
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ status: "succeeded", exitReason: "success", bestMetric: 10, bestIteration: 1, noProgressCount: 1 });
    expect(state.runtime.nodes.document?.status).toBe("ready");
  });

  it("uses hard-limit failure before patience when both apply", () => {
    const created = createWorkflow(definition({ maxIterations: 2, patience: 1 }), at, "workflow-progress-order");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = iteration(created.state, events, 1, 10);
    state = iteration(state, events, 2, 10);
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ status: "failed", exitReason: "max_iterations", noProgressCount: 1 });
  });

  it("supports minimize direction", () => {
    const created = createWorkflow(definition({ progress: { fact: "quality.score", direction: "minimize", minDelta: 0.5 }, patience: 2 }), at, "workflow-minimize");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = iteration(created.state, events, 1, 10);
    state = iteration(state, events, 2, 9.4);
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ bestMetric: 9.4, bestIteration: 2, noProgressCount: 0 });
  });

  it("fails with evaluation_error when the current metric is missing", () => {
    const created = createWorkflow(definition(), at, "workflow-progress-missing");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    const state = iteration(created.state, events, 1, undefined);
    expect(state.phase).toBe("failed");
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ status: "failed", exitReason: "evaluation_error" });
    expect(events.at(-2)).toMatchObject({ type: "hypagraph.loop.failed", data: { exitReason: "evaluation_error" } });
  });

  it("validates progress and patience definitions", () => {
    const invalid = definition({ progress: { fact: "quality.passed", direction: "maximize", minDelta: -1 }, patience: 0 });
    expect(validateDefinition(invalid).map((item) => item.code)).toEqual(expect.arrayContaining(["progress_fact_not_numeric", "invalid_progress_delta", "invalid_loop_patience"]));
    const noProgress = definition();
    delete noProgress.loops[0]!.progress;
    noProgress.loops[0]!.patience = 2;
    expect(validateDefinition(noProgress).map((item) => item.code)).toContain("patience_requires_progress");
  });
});
