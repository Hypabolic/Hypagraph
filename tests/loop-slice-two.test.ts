import { describe, expect, it } from "vitest";
import type { DomainEvent, EvidenceReference, FactInput, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";

const at = "2026-07-23T01:00:00.000Z";
const evidence = (name: string): EvidenceReference[] => [{ ref: `note://${name}`, kind: "note", summary: name }];

const definition = (): HypagraphDefinition => ({
  title: "Two loop iterations",
  goal: "Reset one failed repair iteration and complete the next iteration",
  nodes: [
    {
      id: "implement",
      title: "Implement",
      requires: ["test"],
      acceptance: [],
      produces: [{ name: "repair.use_a", type: "boolean", required: true }],
    },
    {
      id: "choose",
      title: "Choose repair",
      kind: "gate",
      requires: ["implement"],
      acceptance: [],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "repair.use_a" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["repair-a"],
        onFalse: ["repair-b"],
      },
    },
    { id: "repair-a", title: "Repair A", requires: ["choose"], acceptance: [] },
    { id: "repair-b", title: "Repair B", requires: ["choose"], acceptance: [] },
    {
      id: "test",
      title: "Test",
      requires: ["repair-a", "repair-b"],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
    },
    { id: "document", title: "Document", requires: ["test"], acceptance: [] },
  ],
  loops: [{
    id: "repair",
    nodes: ["implement", "choose", "repair-a", "repair-b", "test"],
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
  prefix: string,
  facts: FactInput[] = [],
): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId, attemptId, commandId: `${prefix}-start`, at });
  if (facts.length > 0) next = apply(next, events, { type: "publish-facts", nodeId, attemptId, facts, commandId: `${prefix}-facts`, at });
  next = apply(next, events, { type: "submit-result", nodeId, attemptId, evidence: evidence(prefix), commandId: `${prefix}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId, attemptId, commandId: `${prefix}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${prefix}-complete`, at });
};

describe("M4 Slice 2 feedback continuation", () => {
  it("resets the loop and runs a second task iteration", () => {
    const created = createWorkflow(definition(), at, "workflow-loop-two");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];

    let state = completeTask(created.state, events, "implement", "implement-1", "implement-1", [{ name: "repair.use_a", type: "boolean", value: true }]);
    state = apply(state, events, { type: "evaluate-gate", nodeId: "choose", commandId: "choose-1", at });
    expect(state.runtime.routes.choose?.outcomeId).toBe("true");
    expect(state.runtime.nodes["repair-b"]?.status).toBe("skipped");
    state = completeTask(state, events, "repair-a", "repair-a-1", "repair-a-1");
    state = completeTask(state, events, "test", "test-1", "test-1", [{ name: "tests.passed", type: "boolean", value: false }]);

    expect(state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 2, lastSuccess: false });
    expect(state.runtime.loops.repair?.iterations).toEqual([
      expect.objectContaining({ iteration: 1, success: false, decision: "continue", factsUsed: ["tests.passed"] }),
      expect.objectContaining({ iteration: 2 }),
    ]);
    expect(state.runtime.nodes.implement?.status).toBe("ready");
    expect(state.runtime.nodes.choose?.status).toBe("pending");
    expect(state.runtime.nodes["repair-a"]?.status).toBe("pending");
    expect(state.runtime.nodes["repair-b"]?.status).toBe("pending");
    expect(state.runtime.nodes.test?.status).toBe("pending");
    expect(state.runtime.nodes.document?.status).toBe("pending");
    expect(state.runtime.routes.choose).toBeUndefined();
    expect(state.runtime.facts["repair.use_a"]).toBeUndefined();
    expect(state.runtime.facts["tests.passed"]).toBeUndefined();
    expect(state.runtime.nodes.implement?.currentAttemptId).toBeUndefined();
    expect(state.runtime.nodes.implement?.evidence).toEqual([]);
    expect(state.runtime.nodes.implement?.attempts["implement-1"]).toMatchObject({ iteration: 1, status: "succeeded", evidence: evidence("implement-1") });
    expect(state.runtime.nodes.test?.attempts["test-1"]).toMatchObject({ iteration: 1, status: "succeeded", evidence: evidence("test-1") });

    const staleFact = handleCommand(state, {
      type: "publish-facts",
      nodeId: "test",
      attemptId: "test-1",
      facts: [{ name: "tests.passed", type: "boolean", value: true }],
      commandId: "stale-fact",
      at,
    });
    expect(staleFact).toMatchObject({ ok: false, diagnostics: [{ code: "stale_fact_attempt" }] });
    const staleResult = handleCommand(state, { type: "submit-result", nodeId: "test", attemptId: "test-1", evidence: [], commandId: "stale-result", at });
    expect(staleResult).toMatchObject({ ok: false, diagnostics: [{ code: "stale_attempt" }] });

    state = completeTask(state, events, "implement", "implement-2", "implement-2", [{ name: "repair.use_a", type: "boolean", value: false }]);
    state = apply(state, events, { type: "evaluate-gate", nodeId: "choose", commandId: "choose-2", at });
    expect(state.runtime.routes.choose?.outcomeId).toBe("false");
    expect(state.runtime.nodes["repair-a"]?.status).toBe("skipped");
    state = completeTask(state, events, "repair-b", "repair-b-2", "repair-b-2");
    state = completeTask(state, events, "test", "test-2", "test-2", [{ name: "tests.passed", type: "boolean", value: true }]);

    expect(state.runtime.loops.repair).toMatchObject({ status: "succeeded", currentIteration: 2, lastSuccess: true, exitReason: "success" });
    expect(state.runtime.loops.repair?.iterations).toEqual([
      expect.objectContaining({ iteration: 1, success: false, decision: "continue" }),
      expect.objectContaining({ iteration: 2, success: true, decision: "complete" }),
    ]);
    expect(state.runtime.nodes.document?.status).toBe("ready");
    expect(state.runtime.nodes.implement?.attempts["implement-1"]?.iteration).toBe(1);
    expect(state.runtime.nodes.implement?.attempts["implement-2"]?.iteration).toBe(2);
    expect(state.runtime.nodes.test?.attempts["test-1"]?.iteration).toBe(1);
    expect(state.runtime.nodes.test?.attempts["test-2"]?.iteration).toBe(2);
    expect(state.runtime.facts["tests.passed"]).toMatchObject({ iteration: 2, attemptId: "test-2", value: true });

    const replayed = replayEvents(events);
    expect(replayed).toEqual(state);
    expect(replayed.snapshotHash).toBe(state.snapshotHash);
  });
});
