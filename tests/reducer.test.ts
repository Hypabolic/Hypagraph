import { describe, expect, it } from "vitest";
import type { DomainEvent, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";
import { readyNodeIds } from "../src/domain/readiness.js";

const at = "2026-07-21T00:00:00.000Z";
const definition = (): HypagraphDefinition => ({
  title: "Build feature",
  goal: "Ship a tested feature",
  nodes: [
    { id: "implement", title: "Implement", requires: [], acceptance: ["Code exists"] },
    { id: "test", title: "Test", requires: ["implement"], acceptance: ["Tests pass"] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: true },
});

const created = () => {
  const result = createWorkflow(definition(), at, "workflow-1");
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const run = (state: HypagraphState, command: HypagraphCommand) => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const base = <T extends HypagraphCommand["type"]>(type: T, suffix: string) => ({ type, commandId: `command-${suffix}`, at } as const);

describe("event-driven runtime", () => {
  it("creates readiness events and rebuilds the same state by replay", () => {
    const result = created();
    expect(readyNodeIds(result.state)).toEqual(["implement"]);
    expect(result.events.map((event) => event.type)).toEqual(["hypagraph.workflow.defined", "hypagraph.node.ready"]);
    expect(replayEvents(result.events)).toEqual(result.state);
  });

  it("separates result submission from verification", () => {
    const initial = created();
    let state = initial.state;
    const events: DomainEvent[] = [...initial.events];
    const started = run(state, { ...base("start-node", "start"), nodeId: "implement", attemptId: "attempt-1" });
    state = started.state;
    events.push(...started.events);
    expect(state.runtime.nodes.implement?.status).toBe("running");
    const submitted = run(state, { ...base("submit-result", "submit"), nodeId: "implement", attemptId: "attempt-1", evidence: [{ ref: "file:src/feature.ts", kind: "file" }] });
    state = submitted.state;
    events.push(...submitted.events);
    expect(state.runtime.nodes.implement?.status).toBe("awaiting_evidence");
    const verifying = run(state, { ...base("begin-verification", "verify"), nodeId: "implement", attemptId: "attempt-1" });
    state = verifying.state;
    events.push(...verifying.events);
    expect(state.runtime.nodes.implement?.status).toBe("verifying");
    const passed = run(state, { ...base("complete-verification", "pass"), nodeId: "implement", attemptId: "attempt-1", passed: true });
    state = passed.state;
    events.push(...passed.events);
    expect(state.runtime.nodes.implement?.status).toBe("succeeded");
    expect(readyNodeIds(state)).toEqual(["test"]);
    expect(replayEvents(events)).toEqual(state);
  });

  it("rejects a stale attempt without events", () => {
    const initial = created();
    const started = run(initial.state, { ...base("start-node", "start"), nodeId: "implement", attemptId: "attempt-current" });
    const rejected = handleCommand(started.state, { ...base("submit-result", "stale"), nodeId: "implement", attemptId: "attempt-old", evidence: [{ ref: "note:old" }] });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.diagnostics[0]?.code).toBe("stale_attempt");
  });

  it("does not mutate command input or previous state", () => {
    const initial = created();
    const before = structuredClone(initial.state);
    const command = { ...base("start-node", "start"), nodeId: "implement", attemptId: "attempt-1" } as const;
    const commandBefore = structuredClone(command);
    run(initial.state, command);
    expect(initial.state).toEqual(before);
    expect(command).toEqual(commandBefore);
  });

  it("uses contiguous event sequence numbers", () => {
    const initial = created();
    const started = run(initial.state, { ...base("start-node", "start"), nodeId: "implement", attemptId: "attempt-1" });
    expect([...initial.events, ...started.events].map((event) => event.sequence)).toEqual([1, 2, 3]);
  });
});
