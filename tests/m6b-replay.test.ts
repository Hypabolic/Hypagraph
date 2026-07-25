import { describe, expect, it, vi } from "vitest";
import { ActiveCheckExecutionRegistry } from "../src/checks/active-executions.js";
import { isReadyCheckDecision } from "../src/domain/deterministic-check-dispatch.js";
import { dispatchReadyGate, isReadyGateDecision } from "../src/domain/deterministic-gate-dispatch.js";
import { isRunnableGoalContinuation, selectGoalContinuation } from "../src/domain/goal-continuation.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { CheckExecutor, CheckResult, DomainEvent, HypagraphDefinition } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { handleCommand } from "../src/domain/reducer.js";
import { compareReplayWithLive, replayToSequence } from "../src/history/replay.js";
import { runDeterministicCheckDispatch } from "../src/pi/deterministic-check-runner.js";
import { InMemoryWorkflowEventStore } from "../src/persistence/event-store.js";

const at = "2026-07-25T18:30:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Replay coverage",
  goal: "Rebuild any historical state",
  nodes: [
    {
      id: "tests",
      title: "Run tests",
      kind: "check",
      requires: [],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "npm",
        arguments: ["test"],
        timeoutMs: 60_000,
        publish: [{ source: "passed", fact: "tests.passed" }],
      },
    },
    {
      id: "route",
      title: "Select the route",
      kind: "gate",
      requires: ["tests"],
      acceptance: [],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "tests.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["ship"],
        onFalse: ["repair"],
      },
    },
    { id: "ship", title: "Ship the change", requires: ["route"], acceptance: [] },
    { id: "repair", title: "Repair the change", requires: ["route"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const executorFor = (factory: (attemptId: string) => CheckResult): CheckExecutor => ({
  execute: vi.fn(async (request) => factory(request.attemptId)),
});

/** Run one deterministic check and one deterministic gate, and return the complete stream. */
const runFixture = async () => {
  const created = createHypagoalWorkflow(definition(), {
    workflowId: "replay-workflow",
    goalId: "replay-goal",
    goalWorkflowId: "replay-workflow",
    at,
  });
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));

  const store = new InMemoryWorkflowEventStore();
  store.seed({ events: created.events, snapshot: created.state });
  const events: DomainEvent[] = [...created.events];

  const checkDecision = selectGoalContinuation(created.state);
  if (!isRunnableGoalContinuation(checkDecision) || !isReadyCheckDecision(checkDecision)) {
    throw new Error(`Expected a ready check, received '${checkDecision.kind}'.`);
  }
  const executor = executorFor((attemptId) => ({
    checkKind: "command",
    attemptId,
    startedAt: at,
    completedAt: at,
    status: "passed",
    exitCode: 0,
    facts: [],
    evidence: [],
  }));
  const dispatch = await runDeterministicCheckDispatch({
    state: created.state,
    decision: checkDecision,
    dispatchId: "replay-check-dispatch",
    attemptId: "tests-1",
    at,
    finishedAt: at,
    store,
    executor,
    registry: new ActiveCheckExecutionRegistry(),
  });
  if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));
  events.push(...dispatch.events);

  const gateDecision = selectGoalContinuation(dispatch.state);
  if (!isRunnableGoalContinuation(gateDecision) || !isReadyGateDecision(gateDecision)) {
    throw new Error(`Expected a ready gate, received '${gateDecision.kind}'.`);
  }
  const gate = dispatchReadyGate(dispatch.state, {
    dispatchId: "replay-gate-dispatch",
    decision: gateDecision,
    at,
  });
  if (!gate.ok) throw new Error(JSON.stringify(gate.diagnostics));
  events.push(...gate.events);

  return { created, events, live: gate.state, executor };
};

describe("M6B Slice 2 replay to an event", () => {
  it("replays the final sequence to the live state", async () => {
    const value = await runFixture();
    const replay = replayToSequence(value.events, value.live.sequence);

    expect(replay.sequence).toBe(value.live.sequence);
    expect(replay.state).toEqual(value.live);
    expect(replay.state.snapshotHash).toBe(value.live.snapshotHash);
    expect(replay.entry.sequence).toBe(value.live.sequence);
  });

  it("replays an intermediate sequence to the historical state", async () => {
    const value = await runFixture();
    const routeEvent = value.events.find((event) => event.type === "hypagraph.route.selected")!;
    const before = replayToSequence(value.events, routeEvent.sequence - 1);

    // Before the route event the gate has not routed, so no branch is selected.
    expect(before.state.runtime.routes.route).toBeUndefined();
    expect(before.state.runtime.nodes.ship?.status).toBe("pending");
    expect(before.state.runtime.nodes.repair?.status).toBe("pending");
    expect(before.state.sequence).toBe(routeEvent.sequence - 1);

    // The live state routed to ship and skipped repair.
    expect(value.live.runtime.routes.route).toMatchObject({ outcomeId: "true", targetNodeIds: ["ship"] });
    expect(value.live.runtime.nodes.repair?.status).toBe("skipped");
    expect(before.state).not.toEqual(value.live);
  });

  it("replays each stored sequence and agrees with a full replay", async () => {
    const value = await runFixture();
    for (const event of value.events) {
      const replay = replayToSequence(value.events, event.sequence);
      const expected = replayEvents(value.events.filter((item) => item.sequence <= event.sequence));
      expect(replay.state).toEqual(expected);
    }
  });

  it("runs no check and calls no executor during replay", async () => {
    const value = await runFixture();
    const callsAfterRun = (value.executor.execute as ReturnType<typeof vi.fn>).mock.calls.length;

    for (const event of value.events) replayToSequence(value.events, event.sequence);

    expect((value.executor.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterRun);
  });

  it("rejects a sequence which the stream does not hold", async () => {
    const value = await runFixture();
    const last = value.live.sequence;

    expect(() => replayToSequence(value.events, last + 1))
      .toThrow(`The event stream has no sequence ${last + 1}. It holds sequence 1 to ${last}.`);
    expect(() => replayToSequence(value.events, 0))
      .toThrow(`The event stream has no sequence 0. It holds sequence 1 to ${last}.`);
    expect(() => replayToSequence(value.events, 1.5)).toThrow("A replay sequence must be a safe integer.");
    expect(() => replayToSequence([], 1)).toThrow("The event stream is empty.");
  });

  it("reports no difference when the replay reaches the live sequence", async () => {
    const value = await runFixture();
    const replay = replayToSequence(value.events, value.live.sequence);
    const comparison = compareReplayWithLive(replay.state, value.live);

    expect(comparison).toMatchObject({
      identical: true,
      phaseChanged: false,
      goalStatusChanged: false,
      nodes: [],
      routes: [],
      loops: [],
      addedFacts: [],
      removedFacts: [],
      consumedTurnsDelta: 0,
      scheduledActionsDelta: 0,
    });
  });

  it("reports the changed nodes, routes, facts, and scheduler state for an earlier sequence", async () => {
    const value = await runFixture();
    const checkStart = value.events.find((event) => event.type === "hypagraph.check.started")!;
    const replay = replayToSequence(value.events, checkStart.sequence);
    const comparison = compareReplayWithLive(replay.state, value.live);

    expect(comparison.identical).toBe(false);
    expect(comparison.replaySequence).toBe(checkStart.sequence);
    expect(comparison.liveSequence).toBe(value.live.sequence);
    expect(comparison.nodes).toContainEqual({ nodeId: "tests", replayStatus: "running", liveStatus: "succeeded" });
    expect(comparison.nodes).toContainEqual({ nodeId: "repair", replayStatus: "pending", liveStatus: "skipped" });
    expect(comparison.routes).toContainEqual({ nodeId: "route", liveOutcomeId: "true" });
    expect(comparison.addedFacts).toEqual(["tests.passed"]);
    expect(comparison.removedFacts).toEqual([]);
    // The deterministic lane charges no turn, and the scheduler advanced by one gate action.
    expect(comparison.consumedTurnsDelta).toBe(0);
    expect(comparison.scheduledActionsDelta).toBe(1);
    // The workflow is still running at both sequences, because task 'ship' remains ready.
    expect(comparison.phaseChanged).toBe(false);
    expect(comparison.replayPhase).toBe("running");
    expect(comparison.livePhase).toBe("running");
    expect(comparison.goalStatusChanged).toBe(false);
  });

  it("reports a loop difference across iterations", async () => {
    const source: HypagraphDefinition = {
      title: "Replay a loop",
      goal: "Compare loop iterations",
      nodes: [
        { id: "refine", title: "Refine", requires: ["assess"], acceptance: [] },
        {
          id: "assess",
          title: "Assess",
          kind: "check",
          requires: ["refine"],
          acceptance: [],
          produces: [{ name: "assess.passed", type: "boolean", required: true }],
          check: {
            kind: "command",
            command: "npm",
            arguments: ["test"],
            timeoutMs: 60_000,
            publish: [{ source: "passed", fact: "assess.passed" }],
          },
        },
      ],
      loops: [{
        id: "refine-loop",
        nodes: ["refine", "assess"],
        entry: "refine",
        evaluateAfter: "assess",
        feedbackEdges: [{ from: "assess", to: "refine" }],
        successWhen: {
          kind: "compare",
          left: { kind: "fact", name: "assess.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        maxIterations: 3,
        failurePolicy: "fail-workflow",
      }],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = createHypagoalWorkflow(source, {
      workflowId: "replay-loop-workflow",
      goalId: "replay-loop-goal",
      goalWorkflowId: "replay-loop-workflow",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));

    const events: DomainEvent[] = [...created.events];
    let state = created.state;
    for (const command of [
      { type: "start-node" as const, nodeId: "refine", attemptId: "refine-1", commandId: "start-refine", at },
      { type: "submit-result" as const, nodeId: "refine", attemptId: "refine-1", evidence: [], commandId: "submit-refine", at },
      { type: "begin-verification" as const, nodeId: "refine", attemptId: "refine-1", commandId: "begin-refine", at },
      { type: "complete-verification" as const, nodeId: "refine", attemptId: "refine-1", passed: true, commandId: "verify-refine", at },
    ]) {
      const reduced = handleCommand(state, command);
      if (!reduced.ok) throw new Error(JSON.stringify(reduced.diagnostics));
      state = reduced.state;
      events.push(...reduced.events);
    }

    const iterationStart = events.find((event) => event.type === "hypagraph.loop.iteration-started")!;
    const replay = replayToSequence(events, iterationStart.sequence);
    const comparison = compareReplayWithLive(replay.state, state);

    expect(replay.state.runtime.loops["refine-loop"]).toMatchObject({ currentIteration: 1 });
    expect(comparison.nodes).toContainEqual({ nodeId: "refine", replayStatus: "ready", liveStatus: "succeeded" });
    expect(comparison.loops.length + comparison.nodes.length).toBeGreaterThan(0);
  });
});
