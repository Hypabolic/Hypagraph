import { describe, expect, it } from "vitest";
import type { DomainEvent, FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";
import { validateDefinition } from "../src/domain/validate.js";

const at = "2026-07-23T14:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Trusted evaluation loop",
  goal: "Reject invalid score observations",
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
    maxIterations: 8,
    progress: { fact: "evaluation.score", direction: "maximize", minDelta: 1 },
    patience: 2,
    evaluation: {
      validWhen: {
        kind: "compare",
        left: { kind: "fact", name: "evaluation.valid" },
        operator: "eq",
        right: { kind: "literal", value: true },
      },
      maximumInvalidEvaluations: 2,
    },
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const iteration = (
  state: HypagraphState,
  events: DomainEvent[],
  number: number,
  input: { valid: boolean; accepted: boolean; score: number },
): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId: "improve", attemptId: `improve-${number}`, commandId: `improve-${number}-start`, at });
  next = apply(next, events, { type: "submit-result", nodeId: "improve", attemptId: `improve-${number}`, evidence: [], commandId: `improve-${number}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId: "improve", attemptId: `improve-${number}`, commandId: `improve-${number}-begin`, at });
  next = apply(next, events, { type: "complete-verification", nodeId: "improve", attemptId: `improve-${number}`, passed: true, commandId: `improve-${number}-verify`, at });
  next = apply(next, events, { type: "start-node", nodeId: "evaluate", attemptId: `evaluate-${number}`, commandId: `evaluate-${number}-start`, at });
  const facts: FactInput[] = [
    { name: "evaluation.valid", type: "boolean", value: input.valid },
    { name: "evaluation.accepted", type: "boolean", value: input.accepted },
    { name: "evaluation.score", type: "number", value: input.score },
  ];
  next = apply(next, events, { type: "publish-facts", nodeId: "evaluate", attemptId: `evaluate-${number}`, facts, commandId: `evaluate-${number}-facts`, at });
  next = apply(next, events, { type: "submit-result", nodeId: "evaluate", attemptId: `evaluate-${number}`, evidence: [], commandId: `evaluate-${number}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId: "evaluate", attemptId: `evaluate-${number}`, commandId: `evaluate-${number}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId: "evaluate", attemptId: `evaluate-${number}`, passed: true, commandId: `evaluate-${number}-verify`, at });
};

describe("M5A Slice 2 evaluation validity", () => {
  it("does not promote an invalid first score into progress state", () => {
    const created = createWorkflow(definition(), at, "workflow-invalid-first");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    const state = iteration(created.state, events, 1, { valid: false, accepted: true, score: 999 });

    expect(state.runtime.loops["quality-loop"]).toMatchObject({
      currentIteration: 2,
      lastValid: false,
      lastSuccess: false,
      invalidEvaluationCount: 1,
      noProgressCount: 0,
      status: "running",
    });
    expect(state.runtime.loops["quality-loop"]?.bestMetric).toBeUndefined();
    expect(state.runtime.loops["quality-loop"]?.currentMetric).toBeUndefined();
    expect(state.runtime.loops["quality-loop"]?.iterations[0]).toMatchObject({
      valid: false,
      success: false,
      metric: 999,
      invalidEvaluationCount: 1,
      decision: "continue",
    });
    expect(replayEvents(events)).toEqual(state);
  });

  it("preserves best progress and patience, then stops at the invalid limit", () => {
    const created = createWorkflow(definition(), at, "workflow-evaluation-validity");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];

    let state = iteration(created.state, events, 1, { valid: true, accepted: false, score: 10 });
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ bestMetric: 10, bestIteration: 1, noProgressCount: 0, invalidEvaluationCount: 0 });

    state = iteration(state, events, 2, { valid: true, accepted: false, score: 10 });
    expect(state.runtime.loops["quality-loop"]).toMatchObject({ bestMetric: 10, bestIteration: 1, noProgressCount: 1, invalidEvaluationCount: 0 });

    state = iteration(state, events, 3, { valid: false, accepted: true, score: 100 });
    expect(state.runtime.loops["quality-loop"]).toMatchObject({
      currentIteration: 4,
      lastValid: false,
      lastSuccess: false,
      currentMetric: 10,
      bestMetric: 10,
      bestIteration: 1,
      noProgressCount: 1,
      invalidEvaluationCount: 1,
      status: "running",
    });
    expect(state.runtime.loops["quality-loop"]?.iterations[2]).toMatchObject({ valid: false, success: false, metric: 100, noProgressCount: 1 });
    expect(state.runtime.loops["quality-loop"]?.iterations[2]?.improved).toBeUndefined();

    state = iteration(state, events, 4, { valid: false, accepted: true, score: 200 });
    expect(state.phase).toBe("failed");
    expect(state.runtime.loops["quality-loop"]).toMatchObject({
      status: "failed",
      exitReason: "invalid_evaluations",
      lastValid: false,
      lastSuccess: false,
      currentMetric: 10,
      bestMetric: 10,
      bestIteration: 1,
      noProgressCount: 1,
      invalidEvaluationCount: 2,
    });
    expect(events.at(-2)).toMatchObject({ type: "hypagraph.loop.failed", data: { exitReason: "invalid_evaluations", invalidEvaluationCount: 2, maximumInvalidEvaluations: 2 } });
    expect(replayEvents(events)).toEqual(state);
  });

  it("validates the condition and bounded invalid-observation limit", () => {
    const invalid = definition();
    invalid.loops[0]!.evaluation = {
      validWhen: { kind: "exists", fact: "evaluation.unknown" },
      maximumInvalidEvaluations: 0,
    };
    expect(validateDefinition(invalid).map((item) => item.code)).toEqual(expect.arrayContaining(["unknown_condition_fact", "invalid_evaluation_limit"]));
  });
});
