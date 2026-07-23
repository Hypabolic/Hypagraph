import { describe, expect, it } from "vitest";
import type { DomainEvent, FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState, LoopFailurePolicy } from "../src/domain/model.js";
import { projectGraphView } from "../src/graph/projection.js";
import { layoutGraph } from "../src/graph/layout.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";

const at = "2026-07-23T07:00:00.000Z";

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const completeTask = (state: HypagraphState, events: DomainEvent[], nodeId: string, attemptId: string, facts: FactInput[] = []): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId, attemptId, commandId: `${attemptId}-start`, at });
  if (facts.length > 0) next = apply(next, events, { type: "publish-facts", nodeId, attemptId, facts, commandId: `${attemptId}-facts`, at });
  next = apply(next, events, { type: "submit-result", nodeId, attemptId, evidence: [], commandId: `${attemptId}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId, attemptId, commandId: `${attemptId}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${attemptId}-verify`, at });
};

const policyDefinition = (alphaPolicy: LoopFailurePolicy | undefined, includeDependent: boolean): HypagraphDefinition => ({
  title: "Independent regions",
  goal: "Apply local loop outcomes without coupling unrelated work",
  nodes: [
    { id: "alpha-work", title: "Alpha work", requires: ["alpha-eval"], acceptance: [] },
    { id: "alpha-eval", title: "Alpha evaluation", requires: ["alpha-work"], acceptance: [], produces: [{ name: "alpha.passed", type: "boolean", required: true }] },
    { id: "beta-work", title: "Beta work", requires: ["beta-eval"], acceptance: [] },
    { id: "beta-eval", title: "Beta evaluation", requires: ["beta-work"], acceptance: [], produces: [{ name: "beta.passed", type: "boolean", required: true }] },
    { id: "outside", title: "Unrelated work", requires: [], acceptance: [] },
    ...(includeDependent ? [{ id: "after-alpha", title: "Alpha dependant", requires: ["alpha-eval"], acceptance: [] }] : []),
  ],
  loops: [
    {
      id: "alpha",
      nodes: ["alpha-work", "alpha-eval"],
      entry: "alpha-work",
      evaluateAfter: "alpha-eval",
      feedbackEdges: [{ from: "alpha-eval", to: "alpha-work" }],
      successWhen: { kind: "compare", left: { kind: "fact", name: "alpha.passed" }, operator: "eq", right: { kind: "literal", value: true } },
      maxIterations: 1,
      ...(alphaPolicy === undefined ? {} : { failurePolicy: alphaPolicy }),
    },
    {
      id: "beta",
      nodes: ["beta-work", "beta-eval"],
      entry: "beta-work",
      evaluateAfter: "beta-eval",
      feedbackEdges: [{ from: "beta-eval", to: "beta-work" }],
      successWhen: { kind: "compare", left: { kind: "fact", name: "beta.passed" }, operator: "eq", right: { kind: "literal", value: true } },
      maxIterations: 1,
      failurePolicy: "record-and-continue",
    },
  ],
  policy: { mode: "guided", requireEvidence: false },
});

const runRegion = (state: HypagraphState, events: DomainEvent[], prefix: "alpha" | "beta", passed: boolean): HypagraphState => {
  let next = completeTask(state, events, `${prefix}-work`, `${prefix}-work-1`);
  return completeTask(next, events, `${prefix}-eval`, `${prefix}-eval-1`, [{ name: `${prefix}.passed`, type: "boolean", value: passed }]);
};

const interleavedDefinition = (): HypagraphDefinition => ({
  title: "Interleaved regions",
  goal: "Keep region facts and routes isolated",
  nodes: [
    { id: "alpha-work", title: "Alpha work", requires: ["alpha-eval"], acceptance: [], produces: [{ name: "alpha.route", type: "boolean", required: true }] },
    { id: "alpha-gate", title: "Alpha gate", kind: "gate", requires: ["alpha-work"], acceptance: [], gate: { condition: { kind: "compare", left: { kind: "fact", name: "alpha.route" }, operator: "eq", right: { kind: "literal", value: true } }, onTrue: ["alpha-a"], onFalse: ["alpha-b"] } },
    { id: "alpha-a", title: "Alpha A", requires: ["alpha-gate"], acceptance: [] },
    { id: "alpha-b", title: "Alpha B", requires: ["alpha-gate"], acceptance: [] },
    { id: "alpha-eval", title: "Alpha evaluation", requires: ["alpha-a", "alpha-b"], acceptance: [], produces: [{ name: "alpha.passed", type: "boolean", required: true }] },
    { id: "beta-work", title: "Beta work", requires: ["beta-eval"], acceptance: [], produces: [{ name: "beta.route", type: "boolean", required: true }] },
    { id: "beta-gate", title: "Beta gate", kind: "gate", requires: ["beta-work"], acceptance: [], gate: { condition: { kind: "compare", left: { kind: "fact", name: "beta.route" }, operator: "eq", right: { kind: "literal", value: true } }, onTrue: ["beta-a"], onFalse: ["beta-b"] } },
    { id: "beta-a", title: "Beta A", requires: ["beta-gate"], acceptance: [] },
    { id: "beta-b", title: "Beta B", requires: ["beta-gate"], acceptance: [] },
    { id: "beta-eval", title: "Beta evaluation", requires: ["beta-a", "beta-b"], acceptance: [], produces: [{ name: "beta.passed", type: "boolean", required: true }] },
  ],
  loops: [
    { id: "alpha", nodes: ["alpha-work", "alpha-gate", "alpha-a", "alpha-b", "alpha-eval"], entry: "alpha-work", evaluateAfter: "alpha-eval", feedbackEdges: [{ from: "alpha-eval", to: "alpha-work" }], successWhen: { kind: "compare", left: { kind: "fact", name: "alpha.passed" }, operator: "eq", right: { kind: "literal", value: true } }, maxIterations: 2, failurePolicy: "record-and-continue" },
    { id: "beta", nodes: ["beta-work", "beta-gate", "beta-a", "beta-b", "beta-eval"], entry: "beta-work", evaluateAfter: "beta-eval", feedbackEdges: [{ from: "beta-eval", to: "beta-work" }], successWhen: { kind: "compare", left: { kind: "fact", name: "beta.passed" }, operator: "eq", right: { kind: "literal", value: true } }, maxIterations: 2, failurePolicy: "record-and-continue" },
  ],
  policy: { mode: "guided", requireEvidence: false },
});

describe("M4 Slice 6 independent regions and outcome policy", () => {
  it("keeps disconnected region state isolated during an interleaved reset", () => {
    const created = createWorkflow(interleavedDefinition(), at, "workflow-independent-isolation");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    expect(created.state.phase).toBe("running");
    expect(created.state.runtime.nodes["alpha-work"]?.status).toBe("ready");
    expect(created.state.runtime.nodes["beta-work"]?.status).toBe("ready");

    let state = completeTask(created.state, events, "beta-work", "beta-work-1", [{ name: "beta.route", type: "boolean", value: true }]);
    state = apply(state, events, { type: "evaluate-gate", nodeId: "beta-gate", commandId: "beta-gate-1", at });
    expect(state.runtime.routes["beta-gate"]?.outcomeId).toBe("true");
    expect(state.runtime.nodes["beta-a"]?.status).toBe("ready");

    state = completeTask(state, events, "alpha-work", "alpha-work-1", [{ name: "alpha.route", type: "boolean", value: false }]);
    state = apply(state, events, { type: "evaluate-gate", nodeId: "alpha-gate", commandId: "alpha-gate-1", at });
    state = completeTask(state, events, "alpha-b", "alpha-b-1");
    state = completeTask(state, events, "alpha-eval", "alpha-eval-1", [{ name: "alpha.passed", type: "boolean", value: false }]);

    expect(state.runtime.loops.alpha).toMatchObject({ status: "running", currentIteration: 2 });
    expect(state.runtime.nodes["alpha-work"]?.status).toBe("ready");
    expect(state.runtime.facts["alpha.route"]).toBeUndefined();
    expect(state.runtime.routes["alpha-gate"]).toBeUndefined();
    expect(state.runtime.facts["beta.route"]).toMatchObject({ value: true, loopId: "beta", iteration: 1 });
    expect(state.runtime.routes["beta-gate"]?.outcomeId).toBe("true");
    expect(state.runtime.nodes["beta-a"]?.status).toBe("ready");
    expect(state.runtime.loops.beta).toMatchObject({ status: "running", currentIteration: 1 });
    expect(replayEvents(events)).toEqual(state);
  });

  it("keeps the omitted policy compatible with fail-workflow", () => {
    const created = createWorkflow(policyDefinition(undefined, false), at, "workflow-default-failure");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    const state = runRegion(created.state, events, "alpha", false);
    expect(state.phase).toBe("failed");
    expect(state.runtime.loops.alpha).toMatchObject({ status: "failed", exitReason: "max_iterations", failurePolicy: "fail-workflow" });
    expect(events.at(-1)).toMatchObject({ type: "hypagraph.workflow.failed", data: { failurePolicy: "fail-workflow" } });
  });

  it("blocks only the affected path and keeps unrelated work executable", () => {
    const created = createWorkflow(policyDefinition("block-dependants", true), at, "workflow-block-dependants");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = runRegion(created.state, events, "alpha", false);
    expect(state.phase).toBe("running");
    expect(state.runtime.nodes["after-alpha"]).toMatchObject({ status: "blocked", blockedReason: "Loop 'alpha' failed with 'max_iterations'." });
    expect(state.runtime.nodes.outside?.status).toBe("ready");
    expect(state.runtime.nodes["beta-work"]?.status).toBe("ready");
    state = completeTask(state, events, "outside", "outside-1");
    state = runRegion(state, events, "beta", true);
    expect(state.phase).toBe("blocked");
    expect(state.runtime.loops.beta?.status).toBe("succeeded");
    expect(replayEvents(events)).toEqual(state);
  });

  it("records an independent local failure and completes the workflow", () => {
    const created = createWorkflow(policyDefinition("record-and-continue", false), at, "workflow-record-local");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = runRegion(created.state, events, "alpha", false);
    expect(state.phase).toBe("running");
    expect(state.runtime.nodes["beta-work"]?.status).toBe("ready");
    state = runRegion(state, events, "beta", true);
    state = completeTask(state, events, "outside", "outside-record-1");
    expect(state.phase).toBe("completed");
    expect(state.runtime.loops.alpha).toMatchObject({ status: "failed", failurePolicy: "record-and-continue" });
    expect(state.runtime.loops.beta?.status).toBe("succeeded");
    expect(events.some((event) => event.type === "hypagraph.workflow.completed")).toBe(true);
    expect(replayEvents(events)).toEqual(state);
  });

  it("does not release a dependant under record-and-continue", () => {
    const created = createWorkflow(policyDefinition("record-and-continue", true), at, "workflow-record-blocked-path");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = runRegion(created.state, events, "alpha", false);
    expect(state.runtime.nodes["after-alpha"]?.status).toBe("pending");
    state = runRegion(state, events, "beta", true);
    state = completeTask(state, events, "outside", "outside-record-blocked-1");
    expect(state.phase).toBe("blocked");
    expect(state.runtime.nodes["after-alpha"]?.status).toBe("pending");
    expect(replayEvents(events)).toEqual(state);
  });

  it("projects disconnected loops as separate top-level components", () => {
    const created = createWorkflow(policyDefinition("record-and-continue", false), at, "workflow-components");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const view = projectGraphView(created.state);
    const alpha = view.loops.find((loop) => loop.id === "alpha")!;
    const beta = view.loops.find((loop) => loop.id === "beta")!;
    expect(alpha.componentId).not.toBe(beta.componentId);
    expect(alpha.failurePolicy).toBe("record-and-continue");
    expect(beta.failurePolicy).toBe("record-and-continue");
    expect(view.components?.map((component) => component.loopIds)).toEqual(expect.arrayContaining([["alpha"], ["beta"]]));
    const layout = layoutGraph(view);
    const alphaBox = layout.loops.find((loop) => loop.id === "alpha")!;
    const betaBox = layout.loops.find((loop) => loop.id === "beta")!;
    const overlap = alphaBox.x < betaBox.x + betaBox.width && alphaBox.x + alphaBox.width > betaBox.x && alphaBox.y < betaBox.y + betaBox.height && alphaBox.y + alphaBox.height > betaBox.y;
    expect(overlap).toBe(false);
  });
});
