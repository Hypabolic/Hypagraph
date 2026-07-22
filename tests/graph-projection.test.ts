import { describe, expect, it } from "vitest";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { projectGraphView } from "../src/graph/projection.js";

const at = "2026-07-22T00:00:00.000Z";

const routedDefinition = (): HypagraphDefinition => ({
  title: "Graph projection",
  goal: "Project routes and checks",
  nodes: [
    {
      id: "prepare",
      title: "Prepare",
      requires: [],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
    },
    {
      id: "choose",
      title: "Choose",
      kind: "gate",
      requires: ["prepare"],
      acceptance: [],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "tests.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["document"],
        onFalse: ["repair"],
      },
    },
    { id: "document", title: "Document", requires: ["choose"], acceptance: [] },
    { id: "repair", title: "Repair", requires: ["choose"], acceptance: [] },
    {
      id: "lint",
      title: "Run lint",
      kind: "check",
      requires: [],
      acceptance: [],
      produces: [{ name: "lint.passed", type: "boolean" }],
      check: {
        kind: "command",
        command: "node",
        arguments: ["--version"],
        timeoutMs: 1_000,
        publish: [{ source: "passed", fact: "lint.passed" }],
      },
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, command: Parameters<typeof handleCommand>[1]): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const routedState = (): HypagraphState => {
  const created = createWorkflow(routedDefinition(), at, "workflow-graph");
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  let state = apply(created.state, { type: "start-node", nodeId: "prepare", attemptId: "attempt-1", commandId: "start", at });
  state = apply(state, {
    type: "publish-facts",
    nodeId: "prepare",
    attemptId: "attempt-1",
    facts: [{ name: "tests.passed", type: "boolean", value: true }],
    commandId: "facts",
    at,
  });
  state = apply(state, { type: "submit-result", nodeId: "prepare", attemptId: "attempt-1", evidence: [], commandId: "submit", at });
  state = apply(state, { type: "begin-verification", nodeId: "prepare", attemptId: "attempt-1", commandId: "verify", at });
  state = apply(state, { type: "complete-verification", nodeId: "prepare", attemptId: "attempt-1", passed: true, commandId: "pass", at });
  return apply(state, { type: "evaluate-gate", nodeId: "choose", commandId: "route", at });
};

describe("graph view projection", () => {
  it("projects stable nodes and selected and skipped route edges", () => {
    const view = projectGraphView(routedState());

    expect(view.nodes.map((node) => node.id)).toEqual(["choose", "document", "lint", "prepare", "repair"]);
    expect(view.nodes.find((node) => node.id === "lint")).toMatchObject({ kind: "check", status: "ready", ready: true });
    expect(view.edges.filter((edge) => edge.source === "choose")).toEqual([
      expect.objectContaining({ target: "document", kind: "route", outcome: "true", selected: true, skipped: false }),
      expect.objectContaining({ target: "repair", kind: "route", outcome: "false", selected: false, skipped: true }),
    ]);
    expect(view.edges.filter((edge) => edge.source === "choose" && edge.kind === "dependency")).toEqual([]);
    expect(view.readyNodeIds).toEqual(["document", "lint"]);
  });

  it("projects declared loop membership and feedback edges", () => {
    const definition: HypagraphDefinition = {
      title: "Repair loop",
      goal: "Show the loop",
      nodes: [
        { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
        { id: "test", title: "Test", requires: ["implement"], acceptance: [], produces: [{ name: "tests.passed", type: "boolean", required: true }] },
      ],
      loops: [{
        id: "repair",
        nodes: ["implement", "test"],
        entry: "implement",
        evaluateAfter: "test",
        feedbackEdges: [{ from: "test", to: "implement" }],
        successWhen: { kind: "compare", left: { kind: "fact", name: "tests.passed" }, operator: "eq", right: { kind: "literal", value: true } },
        maxIterations: 3,
      }],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = createWorkflow(definition, at, "workflow-loop");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));

    const view = projectGraphView(created.state);
    expect(view.loops).toEqual([expect.objectContaining({ id: "repair", nodeIds: ["implement", "test"], maxIterations: 3, status: "pending", currentIteration: 0 })]);
    expect(view.nodes.every((node) => node.loopId === "repair")).toBe(true);
    expect(view.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "implement", target: "test", kind: "dependency" }),
      expect.objectContaining({ source: "test", target: "implement", kind: "feedback" }),
    ]));
  });
});
