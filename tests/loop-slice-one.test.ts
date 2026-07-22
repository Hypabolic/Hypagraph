import { describe, expect, it } from "vitest";
import type { DomainEvent, FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { replayEvents } from "../src/domain/projection.js";
import { restoreLatestSession } from "../src/persistence/session-rebuild.js";

const at = "2026-07-22T16:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "One successful loop iteration",
  goal: "Pass the evaluation and release documentation",
  nodes: [
    { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
    {
      id: "test",
      title: "Test",
      requires: ["implement"],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
    },
    { id: "document", title: "Document", requires: ["test"], acceptance: [] },
  ],
  loops: [{
    id: "repair",
    nodes: ["implement", "test"],
    entry: "implement",
    evaluateAfter: "test",
    feedbackEdges: [{ from: "test", to: "implement" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "tests.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 3,
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
  commandPrefix: string,
  facts: FactInput[] = [],
): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId, attemptId, commandId: `${commandPrefix}-start`, at });
  if (facts.length > 0) next = apply(next, events, { type: "publish-facts", nodeId, attemptId, facts, commandId: `${commandPrefix}-facts`, at });
  next = apply(next, events, { type: "submit-result", nodeId, attemptId, evidence: [], commandId: `${commandPrefix}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId, attemptId, commandId: `${commandPrefix}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${commandPrefix}-complete`, at });
};

describe("M4 Slice 1 loop execution", () => {
  it("completes one iteration and releases downstream work", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-one");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];

    expect(created.state.schemaVersion).toBe(3);
    expect(created.state.runtime.loops.repair).toMatchObject({ status: "pending", currentIteration: 0 });
    expect(created.state.runtime.nodes.implement?.status).toBe("ready");
    expect(created.state.runtime.nodes.document?.status).toBe("pending");

    let state = completeTask(created.state, events, "implement", "attempt-implement", "implement");
    expect(state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1 });
    expect(state.runtime.nodes.implement?.attempts["attempt-implement"]).toMatchObject({ loopId: "repair", iteration: 1 });
    expect(state.runtime.nodes.test?.status).toBe("ready");
    expect(state.runtime.nodes.document?.status).toBe("pending");

    state = completeTask(state, events, "test", "attempt-test", "test", [{ name: "tests.passed", type: "boolean", value: true }]);
    expect(state.runtime.facts["tests.passed"]).toMatchObject({ loopId: "repair", iteration: 1, attemptId: "attempt-test" });
    expect(state.runtime.loops.repair).toMatchObject({
      status: "succeeded",
      currentIteration: 1,
      lastSuccess: true,
      exitReason: "success",
      factsUsed: ["tests.passed"],
    });
    expect(state.runtime.loops.repair?.iterations).toEqual([
      expect.objectContaining({ iteration: 1, success: true, decision: "complete", factsUsed: ["tests.passed"], evaluationEventId: expect.any(String), evaluationSequence: expect.any(Number) }),
    ]);
    expect(state.runtime.nodes.document?.status).toBe("ready");

    const evaluationTypes = events.filter((event) => event.loopId === "repair").map((event) => event.type);
    expect(evaluationTypes).toEqual([
      "hypagraph.loop.iteration-started",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.completed",
    ]);

    const replayed = replayEvents(events);
    expect(replayed).toEqual(state);
    expect(replayed.snapshotHash).toBe(state.snapshotHash);
  });

  it("keeps downstream work blocked when the success condition is false", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-false");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = completeTask(created.state, events, "implement", "attempt-implement", "implement");
    state = completeTask(state, events, "test", "attempt-test", "test", [{ name: "tests.passed", type: "boolean", value: false }]);
    expect(state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1, lastSuccess: false });
    expect(state.runtime.nodes.document?.status).toBe("pending");
    expect(events.at(-1)?.type).toBe("hypagraph.loop.evaluated");
  });

  it("migrates a version 2 loop with text to requires_revision", () => {
    const legacyDefinition = definition() as HypagraphDefinition;
    legacyDefinition.loops[0]!.successWhen = "tests.passed == true";
    const legacyEvent: DomainEvent = {
      eventId: "legacy-defined",
      workflowId: "legacy-loop",
      revision: 1,
      sequence: 1,
      type: "hypagraph.workflow.defined",
      version: 1,
      timestamp: at,
      causationId: "legacy",
      correlationId: "legacy",
      data: { definition: legacyDefinition },
    };
    const restored = restoreLatestSession([{
      type: "message",
      message: {
        role: "toolResult",
        toolName: "hypagraph_define",
        details: {
          hypagraph: {
            events: [legacyEvent],
            snapshot: {
              schemaVersion: 2,
              workflowId: "legacy-loop",
              revision: 1,
              sequence: 1,
              snapshotHash: "legacy-hash",
              definition: legacyDefinition,
              runtime: { nodes: {} },
            },
          },
        },
      },
    }]);
    expect(restored?.snapshot.schemaVersion).toBe(3);
    expect(restored?.snapshot.runtime.loops.repair).toMatchObject({ status: "requires_revision", currentIteration: 0, legacyPredicate: "tests.passed == true" });
    expect(restored?.snapshot.definition.loops[0]?.successWhen).toEqual({ kind: "legacy-text", text: "tests.passed == true" });
  });

  it("migrates a version 2 workflow without loops", () => {
    const noLoop: HypagraphDefinition = {
      title: "Legacy acyclic workflow",
      goal: "Migrate",
      nodes: [{ id: "task", title: "Task", requires: [], acceptance: [] }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const legacyEvent: DomainEvent = {
      eventId: "legacy-no-loop-defined",
      workflowId: "legacy-no-loop",
      revision: 1,
      sequence: 1,
      type: "hypagraph.workflow.defined",
      version: 1,
      timestamp: at,
      causationId: "legacy",
      correlationId: "legacy",
      data: { definition: noLoop },
    };
    const restored = restoreLatestSession([{
      type: "message",
      message: {
        role: "toolResult",
        toolName: "hypagraph_define",
        details: {
          hypagraph: {
            events: [legacyEvent],
            snapshot: {
              schemaVersion: 2,
              workflowId: "legacy-no-loop",
              revision: 1,
              sequence: 1,
              snapshotHash: "legacy-hash",
              definition: noLoop,
              runtime: { nodes: {} },
            },
          },
        },
      },
    }]);
    expect(restored?.snapshot.schemaVersion).toBe(3);
    expect(restored?.snapshot.runtime.loops).toEqual({});
  });
});
