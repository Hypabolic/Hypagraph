import { describe, expect, it } from "vitest";
import type { DomainEvent, FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";

const at = "2026-07-24T07:30:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Goal failure projection",
  goal: "Stop after one unsuccessful bounded iteration",
  nodes: [
    { id: "improve", title: "Improve", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate",
      requires: ["improve"],
      acceptance: [],
      produces: [{ name: "goal.done", type: "boolean", required: true }],
    },
  ],
  loops: [{
    id: "bounded",
    nodes: ["improve", "evaluate"],
    entry: "improve",
    evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "improve" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "goal.done" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 1,
    failurePolicy: "fail-workflow",
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const complete = (
  state: HypagraphState,
  events: DomainEvent[],
  nodeId: string,
  attemptId: string,
  facts: FactInput[] = [],
): { state: HypagraphState; finalEvents: DomainEvent[] } => {
  let next = apply(state, events, { type: "start-node", nodeId, attemptId, commandId: `${attemptId}-start`, at });
  if (facts.length > 0) {
    next = apply(next, events, { type: "publish-facts", nodeId, attemptId, facts, commandId: `${attemptId}-facts`, at });
  }
  next = apply(next, events, { type: "submit-result", nodeId, attemptId, evidence: [], commandId: `${attemptId}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId, attemptId, commandId: `${attemptId}-verify`, at });
  const final = handleCommand(next, { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${attemptId}-complete`, at });
  if (!final.ok) throw new Error(JSON.stringify(final.diagnostics));
  events.push(...final.events);
  return { state: final.state, finalEvents: final.events };
};

describe("workflow-derived goal failure", () => {
  it("fails the goal only after the canonical workflow fails", () => {
    const created = createWorkflow(definition(), at, "workflow-goal-failure");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = apply(created.state, events, {
      type: "start-goal",
      goalId: "bounded-failure",
      commandId: "goal-start",
      at,
    });

    state = complete(state, events, "improve", "improve-1").state;
    const evaluated = complete(state, events, "evaluate", "evaluate-1", [{
      name: "goal.done",
      type: "boolean",
      value: false,
    }]);
    state = evaluated.state;

    expect(evaluated.finalEvents.map((event) => event.type)).toEqual([
      "hypagraph.verification.passed",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.failed",
      "hypagraph.workflow.failed",
      "hypagraph.goal.failed",
    ]);
    expect(state.phase).toBe("failed");
    expect(state.goal).toMatchObject({
      status: "failed",
      stopReason: "The canonical workflow failed.",
      completedAt: at,
    });
    expect(replayEvents(events)).toEqual(state);
  });
});
