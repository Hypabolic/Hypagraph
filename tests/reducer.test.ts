import { describe, expect, it } from "vitest";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, reduceHypagraph } from "../src/domain/reducer.js";
import { readyNodeIds } from "../src/domain/readiness.js";

const at = "2026-07-19T00:00:00.000Z";

const basicDefinition = (): HypagraphDefinition => ({
  title: "Build feature",
  goal: "Ship a tested feature",
  nodes: [
    { id: "implement", title: "Implement", requires: [], acceptance: ["Code exists"] },
    { id: "test", title: "Test", requires: ["implement"], acceptance: ["Tests pass"] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: true },
});

const stateFrom = (definition = basicDefinition()): HypagraphState => {
  const result = createWorkflow(definition, at, "workflow-1");
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const apply = (state: HypagraphState, command: Parameters<typeof reduceHypagraph>[1]): HypagraphState => {
  const result = reduceHypagraph(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

describe("Hypagraph reducer", () => {
  it("enforces dependency order", () => {
    const state = stateFrom();
    expect(readyNodeIds(state)).toEqual(["implement"]);

    const rejected = reduceHypagraph(state, { type: "transition", nodeId: "test", action: "start", at });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.diagnostics[0]?.code).toBe("node_not_ready");
  });

  it("permits only one active node and requires evidence", () => {
    let state = stateFrom({
      ...basicDefinition(),
      nodes: [
        { id: "left", title: "Left", requires: [], acceptance: [] },
        { id: "right", title: "Right", requires: [], acceptance: [] },
      ],
    });
    state = apply(state, { type: "transition", nodeId: "left", action: "start", at });

    const parallelStart = reduceHypagraph(state, { type: "transition", nodeId: "right", action: "start", at });
    expect(parallelStart.ok).toBe(false);
    if (!parallelStart.ok) expect(parallelStart.diagnostics[0]?.code).toBe("node_already_active");

    const noEvidence = reduceHypagraph(state, { type: "transition", nodeId: "left", action: "complete", at });
    expect(noEvidence.ok).toBe(false);
    if (!noEvidence.ok) expect(noEvidence.diagnostics[0]?.code).toBe("evidence_required");
  });

  it("completes a workflow after valid transitions", () => {
    let state = stateFrom();
    state = apply(state, { type: "transition", nodeId: "implement", action: "start", at });
    state = apply(state, { type: "transition", nodeId: "implement", action: "complete", evidence: [{ ref: "tool:write-1", kind: "tool" }], at });
    expect(readyNodeIds(state)).toEqual(["test"]);
    state = apply(state, { type: "transition", nodeId: "test", action: "start", at });
    state = apply(state, { type: "transition", nodeId: "test", action: "complete", evidence: [{ ref: "command:npm-test", kind: "command" }], at });
    expect(state.phase).toBe("completed");
  });

  it("marks changed nodes and dependent nodes as stale", () => {
    let state = stateFrom();
    for (const nodeId of ["implement", "test"]) {
      state = apply(state, { type: "transition", nodeId, action: "start", at });
      state = apply(state, { type: "transition", nodeId, action: "complete", evidence: [{ ref: `evidence:${nodeId}` }], at });
    }

    const revised = basicDefinition();
    revised.nodes[0] = { ...revised.nodes[0]!, acceptance: ["Code exists", "Types pass"] };
    state = apply(state, { type: "revise", definition: revised, at });

    expect(state.revision).toBe(2);
    expect(state.runtime.nodes.implement?.status).toBe("stale");
    expect(state.runtime.nodes.test?.status).toBe("stale");
    expect(readyNodeIds(state)).toEqual(["implement"]);
  });

  it("does not change the input state", () => {
    const state = stateFrom();
    const before = structuredClone(state);
    const result = reduceHypagraph(state, { type: "transition", nodeId: "implement", action: "start", at });
    expect(result.ok).toBe(true);
    expect(state).toEqual(before);
  });

  it("gives the same result for the same input", () => {
    const state = stateFrom();
    const command = { type: "transition", nodeId: "implement", action: "start", at } as const;
    expect(reduceHypagraph(state, command)).toEqual(reduceHypagraph(state, command));
  });
});
