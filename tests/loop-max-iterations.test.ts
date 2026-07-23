import { describe, expect, it } from "vitest";
import type { DomainEvent, FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { projectGraphView } from "../src/graph/projection.js";
import { workflowSummary } from "../src/ui/format.js";

const at = "2026-07-23T05:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Hard loop limit",
  goal: "Stop after two unsuccessful iterations",
  nodes: [
    { id: "repair", title: "Repair", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate",
      requires: ["repair"],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
    },
    { id: "document", title: "Document", requires: ["evaluate"], acceptance: [] },
  ],
  loops: [{
    id: "repair-loop",
    nodes: ["repair", "evaluate"],
    entry: "repair",
    evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "repair" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "tests.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 2,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const completeTask = (
  state: HypagraphState,
  events: DomainEvent[],
  nodeId: string,
  attemptId: string,
  facts: FactInput[] = [],
): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId, attemptId, commandId: `${attemptId}-start`, at });
  if (facts.length > 0) next = apply(next, events, { type: "publish-facts", nodeId, attemptId, facts, commandId: `${attemptId}-facts`, at });
  next = apply(next, events, { type: "submit-result", nodeId, attemptId, evidence: [{ ref: `note://${attemptId}`, kind: "note" }], commandId: `${attemptId}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId, attemptId, commandId: `${attemptId}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${attemptId}-complete`, at });
};

const runIteration = (state: HypagraphState, events: DomainEvent[], iteration: number, passed: boolean): HypagraphState => {
  let next = completeTask(state, events, "repair", `repair-${iteration}`);
  return completeTask(next, events, "evaluate", `evaluate-${iteration}`, [{ name: "tests.passed", type: "boolean", value: passed }]);
};

describe("M4 Slice 4 hard iteration limit", () => {
  it("fails exactly after the final unsuccessful iteration and keeps its history", () => {
    const created = createWorkflow(definition(), at, "workflow-hard-limit");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];

    let state = runIteration(created.state, events, 1, false);
    expect(state.runtime.loops["repair-loop"]).toMatchObject({ status: "running", currentIteration: 2 });
    state = runIteration(state, events, 2, false);

    expect(state.phase).toBe("failed");
    expect(state.runtime.loops["repair-loop"]).toMatchObject({
      status: "failed",
      currentIteration: 2,
      lastSuccess: false,
      exitReason: "max_iterations",
    });
    expect(state.runtime.loops["repair-loop"]?.iterations).toEqual([
      expect.objectContaining({ iteration: 1, success: false, decision: "continue" }),
      expect.objectContaining({ iteration: 2, success: false, decision: "fail" }),
    ]);
    expect(state.runtime.nodes.document?.status).toBe("pending");
    expect(state.runtime.facts["tests.passed"]).toMatchObject({ value: false, attemptId: "evaluate-2", iteration: 2 });
    expect(Object.keys(state.runtime.nodes.repair!.attempts).sort()).toEqual(["repair-1", "repair-2"]);
    expect(Object.keys(state.runtime.nodes.evaluate!.attempts).sort()).toEqual(["evaluate-1", "evaluate-2"]);
    expect(events.slice(-4).map((event) => event.type)).toEqual([
      "hypagraph.verification.passed",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.failed",
      "hypagraph.workflow.failed",
    ]);
    expect(events.at(-3)?.data).toMatchObject({ decision: "fail", exitReason: "max_iterations" });

    const graph = projectGraphView(state);
    expect(graph.phase).toBe("failed");
    expect(graph.loops[0]).toMatchObject({ status: "failed", currentIteration: 2, exitReason: "max_iterations" });
    const summary = workflowSummary(state);
    expect(summary.loops).toEqual([expect.objectContaining({ status: "failed", exitReason: "max_iterations" })]);

    const rejected = handleCommand(state, {
      type: "start-node",
      nodeId: "repair",
      attemptId: "repair-3",
      commandId: "repair-3-start",
      at,
    });
    expect(rejected).toMatchObject({ ok: false, diagnostics: [{ code: "loop_exhausted" }] });

    const replayed = replayEvents(events);
    expect(replayed).toEqual(state);
    expect(replayed.runtime.loops["repair-loop"]?.exitReason).toBe("max_iterations");
  });

  it("succeeds on the final allowed iteration", () => {
    const created = createWorkflow(definition(), at, "workflow-final-success");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];

    let state = runIteration(created.state, events, 1, false);
    state = runIteration(state, events, 2, true);

    expect(state.phase).toBe("running");
    expect(state.runtime.loops["repair-loop"]).toMatchObject({ status: "succeeded", currentIteration: 2, exitReason: "success" });
    expect(state.runtime.nodes.document?.status).toBe("ready");
    expect(events.some((event) => event.type === "hypagraph.loop.failed")).toBe(false);
    expect(events.some((event) => event.type === "hypagraph.workflow.failed")).toBe(false);
  });
});
