import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { WorkGraphDefinition } from "../src/domain/model.js";
import { createWorkflow, reduceWorkGraph } from "../src/domain/reducer.js";
import { buildOutgoing, stronglyConnectedComponents } from "../src/domain/scc.js";
import { validateDefinition } from "../src/domain/validate.js";

const cycleDefinition = (): WorkGraphDefinition => ({
  title: "Repair loop",
  goal: "Converge on passing tests",
  nodes: [
    { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
    { id: "test", title: "Test", requires: ["implement"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: true },
});

describe("static graph validation", () => {
  it("rejects undeclared cycles", () => {
    const diagnostics = validateDefinition(cycleDefinition());
    expect(diagnostics.some((item) => item.code === "undeclared_cycle")).toBe(true);
  });

  it("accepts a bounded loop that exactly matches its SCC", () => {
    const definition = cycleDefinition();
    definition.loops = [{
      id: "repair",
      nodes: ["implement", "test"],
      entry: "implement",
      evaluateAfter: "test",
      feedbackEdges: [{ from: "test", to: "implement" }],
      successWhen: "tests.failed == 0",
      maxIterations: 8,
      patience: 2,
    }];
    expect(validateDefinition(definition)).toEqual([]);

    const created = createWorkflow(definition, "2026-07-19T00:00:00.000Z", "loop-workflow");
    if (!created.ok) throw new Error("failed to create loop fixture");
    const transition = reduceWorkGraph(created.state, {
      type: "transition",
      nodeId: "implement",
      action: "start",
      at: "2026-07-19T00:01:00.000Z",
    });
    expect(transition.ok).toBe(false);
    if (!transition.ok) expect(transition.diagnostics[0]?.code).toBe("loop_execution_pending");
  });

  it("rejects loop declarations that do not exactly match an SCC", () => {
    const definition = cycleDefinition();
    definition.nodes.push({ id: "report", title: "Report", requires: ["test"], acceptance: [] });
    definition.loops = [{
      id: "repair",
      nodes: ["implement", "test", "report"],
      entry: "implement",
      evaluateAfter: "report",
      feedbackEdges: [{ from: "test", to: "implement" }],
      successWhen: "tests.failed == 0",
      maxIterations: 8,
    }];
    expect(validateDefinition(definition).some((item) => item.code === "loop_scc_mismatch")).toBe(true);
  });

  it("finds only singleton SCCs in generated index-ordered DAGs", () => {
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
