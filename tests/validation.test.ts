import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { buildOutgoing, stronglyConnectedComponents } from "../src/domain/scc.js";
import { validateDefinition } from "../src/domain/validate.js";

const successCondition = {
  kind: "compare" as const,
  left: { kind: "fact" as const, name: "tests.passed" },
  operator: "eq" as const,
  right: { kind: "literal" as const, value: true },
};

const cycleDefinition = (): HypagraphDefinition => ({
  title: "Repair loop",
  goal: "Make all tests pass",
  nodes: [
    { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
    { id: "test", title: "Test", requires: ["implement"], acceptance: [], produces: [{ name: "tests.passed", type: "boolean", required: true }] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: true },
});

describe("static graph validation", () => {
  it("rejects a cycle that has no loop declaration", () => {
    const diagnostics = validateDefinition(cycleDefinition());
    expect(diagnostics.some((item) => item.code === "undeclared_cycle")).toBe(true);
  });

  it("accepts a structured bounded loop and starts iteration 1", () => {
    const definition = cycleDefinition();
    definition.loops = [{
      id: "repair",
      nodes: ["implement", "test"],
      entry: "implement",
      evaluateAfter: "test",
      feedbackEdges: [{ from: "test", to: "implement" }],
      successWhen: successCondition,
      maxIterations: 8,
    }];
    expect(validateDefinition(definition)).toEqual([]);
    const created = createWorkflow(definition, "2026-07-21T00:00:00.000Z", "loop-workflow");
    if (!created.ok) throw new Error("The loop fixture did not start.");
    const transition = handleCommand(created.state, {
      type: "start-node",
      nodeId: "implement",
      attemptId: "attempt-1",
      commandId: "command-1",
      at: "2026-07-21T00:01:00.000Z",
    });
    expect(transition.ok).toBe(true);
    if (transition.ok) {
      expect(transition.events.map((event) => event.type)).toEqual(["hypagraph.loop.iteration-started", "hypagraph.attempt.started"]);
      expect(transition.state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1 });
    }
  });

  it("rejects a free-text success predicate", () => {
    const definition = cycleDefinition();
    definition.loops = [{
      id: "repair",
      nodes: ["implement", "test"],
      entry: "implement",
      evaluateAfter: "test",
      feedbackEdges: [{ from: "test", to: "implement" }],
      successWhen: "tests.passed == true",
      maxIterations: 8,
    }];
    expect(validateDefinition(definition).some((item) => item.code === "loop_predicate_must_be_typed")).toBe(true);
  });

  it("rejects a loop that is not the same as one cyclic component", () => {
    const definition = cycleDefinition();
    definition.nodes.push({ id: "report", title: "Report", requires: ["test"], acceptance: [] });
    definition.loops = [{
      id: "repair",
      nodes: ["implement", "test", "report"],
      entry: "implement",
      evaluateAfter: "report",
      feedbackEdges: [{ from: "test", to: "implement" }],
      successWhen: successCondition,
      maxIterations: 8,
    }];
    expect(validateDefinition(definition).some((item) => item.code === "loop_scc_mismatch")).toBe(true);
  });

  it("rejects an external input that bypasses the entry", () => {
    const definition = cycleDefinition();
    definition.nodes.unshift({ id: "bootstrap", title: "Bootstrap", requires: [], acceptance: [] });
    definition.nodes[2]!.requires.push("bootstrap");
    definition.loops = [{
      id: "repair",
      nodes: ["implement", "test"],
      entry: "implement",
      evaluateAfter: "test",
      feedbackEdges: [{ from: "test", to: "implement" }],
      successWhen: successCondition,
      maxIterations: 8,
    }];
    expect(validateDefinition(definition).some((item) => item.code === "loop_external_input_not_entry")).toBe(true);
  });

  it("rejects a loop gate that reads a fact from after the gate", () => {
    const definition: HypagraphDefinition = {
      title: "Loop gate fact order",
      goal: "Reject a later fact",
      nodes: [
        { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
        {
          id: "choose",
          title: "Choose",
          kind: "gate",
          requires: ["implement"],
          acceptance: [],
          gate: {
            condition: successCondition,
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
      ],
      loops: [{
        id: "repair",
        nodes: ["implement", "choose", "repair-a", "repair-b", "test"],
        entry: "implement",
        evaluateAfter: "test",
        feedbackEdges: [{ from: "test", to: "implement" }],
        successWhen: successCondition,
        maxIterations: 3,
      }],
      policy: { mode: "guided", requireEvidence: false },
    };
    expect(validateDefinition(definition).some((item) => item.code === "condition_fact_not_upstream" && item.location?.includes("nodes[1].gate.condition"))).toBe(true);
  });

  it("finds only one-node components in generated directed acyclic graphs", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 15 }),
      fc.array(fc.tuple(fc.nat({ max: 14 }), fc.nat({ max: 14 })), { maxLength: 80 }),
      (size, candidates) => {
        const nodes = Array.from({ length: size }, (_, index) => ({ id: `n${index}`, requires: [] as string[] }));
        for (const [left, right] of candidates) {
          if (left >= size || right >= size || left === right) continue;
          const from = Math.min(left, right);
          const to = Math.max(left, right);
          const requirement = `n${from}`;
          if (!nodes[to]!.requires.includes(requirement)) nodes[to]!.requires.push(requirement);
        }
        const outgoing = buildOutgoing(nodes);
        const components = stronglyConnectedComponents(nodes.map((node) => node.id), outgoing).components;
        expect(components.every((component) => component.length === 1)).toBe(true);
      },
    ));
  });
});
