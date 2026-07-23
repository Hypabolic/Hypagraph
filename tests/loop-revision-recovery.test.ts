import { describe, expect, it } from "vitest";
import type { DomainEvent, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { validateRestoredLoopState } from "../src/persistence/session-rebuild.js";

const at = "2026-07-23T07:00:00.000Z";

const definition = (maxIterations = 2): HypagraphDefinition => ({
  title: "Revision recovery",
  goal: "Keep one bounded region deterministic",
  nodes: [
    { id: "work", title: "Work", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate",
      requires: ["work"],
      acceptance: [],
      produces: [{ name: "loop.passed", type: "boolean", required: true }],
    },
    { id: "outside", title: "Outside", requires: [], acceptance: [] },
  ],
  loops: [{
    id: "region",
    nodes: ["work", "evaluate"],
    entry: "work",
    evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "work" }],
    successWhen: { kind: "compare", left: { kind: "fact", name: "loop.passed" }, operator: "eq", right: { kind: "literal", value: true } },
    maxIterations,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const completeTask = (state: HypagraphState, events: DomainEvent[], nodeId: string, attemptId: string): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId, attemptId, commandId: `${attemptId}-start`, at });
  next = apply(next, events, { type: "submit-result", nodeId, attemptId, evidence: [], commandId: `${attemptId}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId, attemptId, commandId: `${attemptId}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${attemptId}-verify`, at });
};

const completeRegion = (state: HypagraphState, events: DomainEvent[], passed: boolean): HypagraphState => {
  let next = completeTask(state, events, "work", `work-${events.length}`);
  const attemptId = `evaluate-${events.length}`;
  next = apply(next, events, { type: "start-node", nodeId: "evaluate", attemptId, commandId: `${attemptId}-start`, at });
  next = apply(next, events, { type: "publish-facts", nodeId: "evaluate", attemptId, facts: [{ name: "loop.passed", type: "boolean", value: passed }], commandId: `${attemptId}-fact`, at });
  next = apply(next, events, { type: "submit-result", nodeId: "evaluate", attemptId, evidence: [], commandId: `${attemptId}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId: "evaluate", attemptId, commandId: `${attemptId}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId: "evaluate", attemptId, passed: true, commandId: `${attemptId}-verify`, at });
};

describe("M4 Slice 7 loop revision and recovery", () => {
  it("rejects revision while a loop attempt is active", () => {
    const created = createWorkflow(definition(), at, "workflow-active-revision");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = handleCommand(created.state, { type: "start-node", nodeId: "work", attemptId: "work-active", commandId: "start", at });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const revised = handleCommand(started.state, { type: "revise", definition: definition(3), commandId: "revise", at });
    expect(revised).toMatchObject({ ok: false, diagnostics: [{ code: "active_loop_revision_not_allowed" }] });
  });

  it("invalidates a completed loop after a relevant revision and restarts at iteration 1", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-invalidation");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = completeRegion(created.state, events, true);
    expect(state.runtime.loops.region?.status).toBe("succeeded");
    const oldAttempts = state.runtime.nodes.work!.attemptCount;
    const revised = handleCommand(state, { type: "revise", definition: definition(3), commandId: "revise-limit", at });
    if (!revised.ok) throw new Error(JSON.stringify(revised.diagnostics));
    state = revised.state;
    events.push(...revised.events);
    expect(revised.events.map((event) => event.type)).toContain("hypagraph.loop.invalidated");
    expect(state.runtime.loops.region).toMatchObject({ status: "pending", currentIteration: 0, maxIterations: 3, iterations: [] });
    expect(state.runtime.nodes.work).toMatchObject({ status: "ready", attemptCount: oldAttempts });
    expect(state.runtime.facts["loop.passed"]).toBeUndefined();
    const restarted = handleCommand(state, { type: "start-node", nodeId: "work", attemptId: "work-restarted", commandId: "restart", at });
    if (!restarted.ok) throw new Error(JSON.stringify(restarted.diagnostics));
    expect(restarted.state.runtime.loops.region).toMatchObject({ status: "running", currentIteration: 1 });
    expect(restarted.state.runtime.nodes.work?.attempts["work-restarted"]?.iteration).toBe(1);
    expect(replayEvents([...events, ...restarted.events])).toEqual(restarted.state);
  });

  it("restarts a failed fail-workflow loop after a relevant revision", () => {
    const created = createWorkflow(definition(), at, "workflow-failed-loop-revision");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = completeRegion(created.state, events, false);
    state = completeRegion(state, events, false);
    expect(state.phase).toBe("failed");
    expect(state.runtime.loops.region).toMatchObject({ status: "failed", currentIteration: 2, exitReason: "max_iterations" });

    const revised = handleCommand(state, { type: "revise", definition: definition(3), commandId: "revise-failed-loop", at });
    if (!revised.ok) throw new Error(JSON.stringify(revised.diagnostics));
    expect(revised.state.phase).toBe("running");
    expect(revised.state.runtime.loops.region).toMatchObject({ status: "pending", currentIteration: 0, maxIterations: 3 });
    expect(revised.state.runtime.nodes.work?.status).toBe("ready");

    const restarted = handleCommand(revised.state, { type: "start-node", nodeId: "work", attemptId: "work-after-failure", commandId: "restart-after-failure", at });
    if (!restarted.ok) throw new Error(JSON.stringify(restarted.diagnostics));
    expect(restarted.state.runtime.loops.region).toMatchObject({ status: "running", currentIteration: 1 });
  });

  it("preserves an unchanged completed loop when unrelated work changes", () => {
    const created = createWorkflow(definition(), at, "workflow-safe-loop-revision");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = completeRegion(created.state, events, true);
    state = completeTask(state, events, "outside", "outside-1");
    expect(state.phase).toBe("completed");
    const next = definition();
    next.nodes = next.nodes.map((node) => node.id === "outside" ? { ...node, title: "Outside revised" } : node);
    const revised = handleCommand(state, { type: "revise", definition: next, commandId: "revise-outside", at });
    if (!revised.ok) throw new Error(JSON.stringify(revised.diagnostics));
    expect(revised.events.some((event) => event.type === "hypagraph.loop.invalidated")).toBe(false);
    expect(revised.state.runtime.loops.region).toEqual(state.runtime.loops.region);
    expect(revised.state.runtime.nodes.outside?.status).toBe("ready");
  });

  it("blocks a cancelled loop attempt, rejects late results, and requires relevant revision", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-cancel");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = handleCommand(created.state, { type: "start-node", nodeId: "work", attemptId: "work-cancel", commandId: "start", at });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const cancelled = handleCommand(started.state, { type: "cancel-attempt", nodeId: "work", attemptId: "work-cancel", reason: "Stop this iteration.", commandId: "cancel", at });
    if (!cancelled.ok) throw new Error(JSON.stringify(cancelled.diagnostics));
    expect(cancelled.state.phase).toBe("running");
    expect(cancelled.state.runtime.nodes.outside?.status).toBe("ready");
    expect(cancelled.state.runtime.loops.region).toMatchObject({ status: "blocked", blockedAttemptId: "work-cancel", blockedReason: "Stop this iteration." });
    const late = handleCommand(cancelled.state, { type: "submit-result", nodeId: "work", attemptId: "work-cancel", evidence: [], commandId: "late", at });
    expect(late).toMatchObject({ ok: false, diagnostics: [{ code: "stale_attempt" }] });
    const startAgain = handleCommand(cancelled.state, { type: "start-node", nodeId: "work", attemptId: "work-again", commandId: "again", at });
    expect(startAgain).toMatchObject({ ok: false, diagnostics: [{ code: "node_not_ready" }] });
    const revised = handleCommand(cancelled.state, { type: "revise", definition: definition(3), commandId: "recover", at });
    if (!revised.ok) throw new Error(JSON.stringify(revised.diagnostics));
    expect(revised.state.runtime.loops.region).toMatchObject({ status: "pending", currentIteration: 0 });
    expect(revised.state.runtime.nodes.work?.status).toBe("ready");
  });

  it("accepts every replay boundary around evaluation and continuation", () => {
    const created = createWorkflow(definition(), at, "workflow-boundary-restore");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    completeRegion(created.state, events, false);
    const loopEventIndexes = events.map((event, index) => ({ event, index })).filter(({ event }) => event.type.startsWith("hypagraph.loop.")).map(({ index }) => index);
    for (const index of loopEventIndexes) {
      const restored = replayEvents(events.slice(0, index + 1));
      expect(() => validateRestoredLoopState(restored)).not.toThrow();
    }
  });

  it("rejects a restored active attempt with the wrong loop iteration", () => {
    const created = createWorkflow(definition(), at, "workflow-invalid-restore");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = handleCommand(created.state, { type: "start-node", nodeId: "work", attemptId: "bad-attempt", commandId: "start", at });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const invalid = structuredClone(started.state);
    invalid.runtime.nodes.work!.attempts["bad-attempt"]!.iteration = 2;
    expect(() => validateRestoredLoopState(invalid)).toThrow("does not match loop 'region' iteration 1");
  });
});
