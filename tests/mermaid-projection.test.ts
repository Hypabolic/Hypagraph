import { describe, expect, it } from "vitest";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import {
  allocateUniqueMermaidIds,
  buildMermaidIdTables,
  escapeMermaidLabel,
  mermaidSafeId,
  projectMermaidFlowchart,
} from "../src/graph/mermaid-projection.js";
import { projectGraphView, type GraphViewModel } from "../src/graph/projection.js";

const at = "2026-07-22T00:00:00.000Z";

const apply = (state: HypagraphState, command: Parameters<typeof handleCommand>[1]): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const linearDefinition = (): HypagraphDefinition => ({
  title: "Linear flow",
  goal: "Build a short chain",
  nodes: [
    { id: "prepare", title: "Prepare work", requires: [], acceptance: [] },
    { id: "implement", title: "Implement", requires: ["prepare"], acceptance: [] },
    { id: "finish", title: "Finish", requires: ["implement"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const gateDefinition = (): HypagraphDefinition => ({
  title: "Gate branch",
  goal: "Project routes",
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
      title: "Choose route",
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
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const loopDefinition = (): HypagraphDefinition => ({
  title: "Repair loop",
  goal: "Show the loop",
  nodes: [
    { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
    {
      id: "test",
      title: "Test",
      kind: "check",
      requires: ["implement"],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "node",
        arguments: ["--version"],
        timeoutMs: 1_000,
        publish: [{ source: "passed", fact: "tests.passed" }],
      },
    },
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

const routedGateState = (): HypagraphState => {
  const created = createWorkflow(gateDefinition(), at, "workflow-gate");
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  let state = apply(created.state, {
    type: "start-node",
    nodeId: "prepare",
    attemptId: "attempt-1",
    commandId: "start",
    at,
  });
  state = apply(state, {
    type: "publish-facts",
    nodeId: "prepare",
    attemptId: "attempt-1",
    facts: [{ name: "tests.passed", type: "boolean", value: true }],
    commandId: "facts",
    at,
  });
  state = apply(state, {
    type: "submit-result",
    nodeId: "prepare",
    attemptId: "attempt-1",
    evidence: [],
    commandId: "submit",
    at,
  });
  state = apply(state, {
    type: "begin-verification",
    nodeId: "prepare",
    attemptId: "attempt-1",
    commandId: "verify",
    at,
  });
  state = apply(state, {
    type: "complete-verification",
    nodeId: "prepare",
    attemptId: "attempt-1",
    passed: true,
    commandId: "pass",
    at,
  });
  return apply(state, { type: "evaluate-gate", nodeId: "choose", commandId: "route", at });
};

const emptyView = (): GraphViewModel => ({
  workflowId: "empty",
  revision: 0,
  sequence: 0,
  phase: "running",
  title: "Empty",
  nodes: [],
  edges: [],
  loops: [],
  readyNodeIds: [],
  awaitingNodeIds: [],
  derivedWaitingForUser: false,
});

const baseNode = (
  id: string,
  title: string,
  extras: Partial<GraphViewModel["nodes"][number]> = {},
): GraphViewModel["nodes"][number] => ({
  id,
  title,
  kind: "task",
  status: "pending",
  attemptCount: 0,
  active: false,
  ready: false,
  factCount: 0,
  evidenceCount: 0,
  ...extras,
});

describe("mermaidSafeId and escapeMermaidLabel", () => {
  it("encodes non-alphanumeric characters injectively", () => {
    expect(mermaidSafeId("prepare")).toBe("prepare");
    expect(mermaidSafeId("repair-loop")).toBe("repair_2d_loop");
    expect(mermaidSafeId("9start")).toBe("n_9start");
    expect(mermaidSafeId("a/b:c")).toBe("a_2f_b_3a_c");
  });

  it("keeps hyphen and underscore as distinct identifiers", () => {
    expect(mermaidSafeId("a-b")).toBe("a_2d_b");
    expect(mermaidSafeId("a_b")).toBe("a_5f_b");
    expect(mermaidSafeId("a-b")).not.toBe(mermaidSafeId("a_b"));
    // Encoded form of a-b does not collide with the raw alphanumeric path for a_2d_b.
    expect(mermaidSafeId("a_2d_b")).toBe("a_5f_2d_5f_b");
    expect(mermaidSafeId("a-b")).not.toBe(mermaidSafeId("a_2d_b"));
  });

  it("escapes special characters and truncates long labels", () => {
    expect(escapeMermaidLabel('Say "hi"\nnow', 28)).toBe("Say 'hi' now");
    expect(escapeMermaidLabel("a[b]{c}", 28)).toBe("a(b)(c)");
    expect(escapeMermaidLabel("abcdefghijklmnopqrstuvwxyz0123456789", 10)).toBe("abcdefghi…");
    expect(escapeMermaidLabel("   ", 10)).toBe("(untitled)");
  });
});

describe("unique Mermaid id allocation", () => {
  it("assigns distinct Mermaid ids when preferred bases collide", () => {
    const assigned = allocateUniqueMermaidIds([
      { key: "first", preferred: "shared" },
      { key: "second", preferred: "shared" },
      { key: "third", preferred: "shared" },
    ]);
    expect(assigned.get("first")).toBe("shared");
    expect(assigned.get("second")).toBe("shared_2");
    expect(assigned.get("third")).toBe("shared_3");
    expect(new Set(assigned.values()).size).toBe(3);
  });

  it("keeps node ids and loop subgraph ids in one unique space", () => {
    // Hyphen vs underscore must not merge, and subgraphs use sg_ prefix.
    const tables = buildMermaidIdTables(["a-b", "a_b", "sg_repair"], ["repair"]);
    expect(tables.mermaidNodeIds.get("a-b")).toBe("a_2d_b");
    expect(tables.mermaidNodeIds.get("a_b")).toBe("a_5f_b");
    expect(tables.mermaidNodeIds.get("sg_repair")).toBe("sg_5f_repair");
    expect(tables.mermaidSubgraphIds.get("repair")).toBe("sg_repair");
    const all = [
      ...tables.mermaidNodeIds.values(),
      ...tables.mermaidSubgraphIds.values(),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("projectMermaidFlowchart", () => {
  it("projects a linear task chain", () => {
    const created = createWorkflow(linearDefinition(), at, "workflow-linear");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const view = projectGraphView(created.state);
    const result = projectMermaidFlowchart(view);

    expect(result.source.startsWith("flowchart ")).toBe(true);
    expect(result.source).toContain('prepare["Prepare work"]');
    expect(result.source).toContain('implement["Implement"]');
    expect(result.source).toContain('finish["Finish"]');
    expect(result.source).toContain("prepare --> implement");
    expect(result.source).toContain("implement --> finish");
    expect(result.nodeCount).toBe(3);
    expect(result.edgeCount).toBe(2);
    expect(result.diagnostics).toEqual([]);
    // Small graph without multi-node loop prefers LR.
    expect(result.direction).toBe("LR");
  });

  it("projects gate branches with selected and skipped route labels", () => {
    const view = projectGraphView(routedGateState());
    const result = projectMermaidFlowchart(view);

    expect(result.source).toContain('choose{"Choose route"}');
    expect(result.source).toMatch(/choose\s*-->\|true\|\s*document/);
    expect(result.source).toMatch(/choose\s*-\.->\|false\|\s*repair/);
    expect(result.source).toContain('document["Document"]');
    expect(result.source).toContain('repair["Repair"]');
    expect(result.source).not.toContain("subgraph");
  });

  it("omits skipped routes in compact mode", () => {
    const view = projectGraphView(routedGateState());
    const result = projectMermaidFlowchart(view, { compact: true });

    expect(result.source).toMatch(/choose\s*-->\|true\|\s*document/);
    expect(result.source).not.toMatch(/-\.->/);
    expect(result.diagnostics.some((item) => item.code === "mermaid.skipped-routes-omitted")).toBe(true);
  });

  it("projects a multi-node loop as a subgraph with a feedback edge", () => {
    const created = createWorkflow(loopDefinition(), at, "workflow-loop");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const view = projectGraphView(created.state);
    const result = projectMermaidFlowchart(view, { direction: "TD" });

    expect(result.source).toContain("subgraph sg_repair");
    expect(result.mermaidSubgraphIds.get("repair")).toBe("sg_repair");
    expect(result.source).toContain('implement["Implement"]');
    expect(result.source).toContain('test(["Test"])');
    expect(result.source).toMatch(/implement\s*-->\s*test/);
    expect(result.source).toMatch(/test\s*-->\|feedback\|\s*implement/);
    expect(result.source).toContain("  end");
    expect(result.direction).toBe("TD");
  });

  it("emits distinct Mermaid ids when node ids differ only by hyphen vs underscore", () => {
    const view: GraphViewModel = {
      workflowId: "collision-nodes",
      revision: 1,
      sequence: 1,
      phase: "running",
      title: "Collision nodes",
      nodes: [
        baseNode("a-b", "Hyphen node"),
        baseNode("a_b", "Underscore node"),
      ],
      edges: [{
        id: "dependency:a-b:a_b",
        source: "a-b",
        target: "a_b",
        kind: "dependency",
        selected: false,
        skipped: false,
      }],
      loops: [],
      readyNodeIds: [],
      awaitingNodeIds: [],
      derivedWaitingForUser: false,
    };
    const result = projectMermaidFlowchart(view, { direction: "TD" });
    const left = result.mermaidNodeIds.get("a-b")!;
    const right = result.mermaidNodeIds.get("a_b")!;
    expect(left).not.toBe(right);
    expect(result.source).toContain(`${left}["Hyphen node"]`);
    expect(result.source).toContain(`${right}["Underscore node"]`);
    expect(result.source).toContain(`${left} --> ${right}`);
    expect(result.nodeCount).toBe(2);
  });

  it("emits distinct Mermaid ids for a node and a loop subgraph that would share a base", () => {
    const view: GraphViewModel = {
      workflowId: "collision-subgraph",
      revision: 1,
      sequence: 1,
      phase: "running",
      title: "Subgraph collision",
      nodes: [
        baseNode("implement", "Implement", { loopId: "repair" }),
        baseNode("test", "Test", { kind: "check", loopId: "repair" }),
        // Would encode near subgraph space if prefixes were omitted.
        baseNode("sg_repair", "Named like subgraph"),
      ],
      edges: [
        {
          id: "dependency:implement:test",
          source: "implement",
          target: "test",
          kind: "dependency",
          selected: false,
          skipped: false,
        },
        {
          id: "feedback:test:implement",
          source: "test",
          target: "implement",
          kind: "feedback",
          selected: false,
          skipped: false,
        },
      ],
      loops: [{
        id: "repair",
        nodeIds: ["implement", "test"],
        entryNodeId: "implement",
        evaluationNodeId: "test",
        feedbackEdges: [{ source: "test", target: "implement" }],
        maxIterations: 3,
        status: "pending",
        currentIteration: 0,
      }],
      readyNodeIds: [],
      awaitingNodeIds: [],
      derivedWaitingForUser: false,
    };
    const result = projectMermaidFlowchart(view, { direction: "TD" });
    const nodeId = result.mermaidNodeIds.get("sg_repair")!;
    const subgraphId = result.mermaidSubgraphIds.get("repair")!;
    expect(nodeId).not.toBe(subgraphId);
    expect(result.source).toContain(`subgraph ${subgraphId}`);
    expect(result.source).toContain(`${nodeId}["Named like subgraph"]`);
    const allIds = [
      ...result.mermaidNodeIds.values(),
      ...result.mermaidSubgraphIds.values(),
    ];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("emits a placeholder for an empty graph", () => {
    const result = projectMermaidFlowchart(emptyView());
    expect(result.source).toContain('empty["(empty graph)"]');
    expect(result.nodeCount).toBe(0);
    expect(result.diagnostics[0]?.code).toBe("mermaid.empty-graph");
  });

  it("respects maxNodes and reports a diagnostic", () => {
    const created = createWorkflow(linearDefinition(), at, "workflow-limit");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const view = projectGraphView(created.state);
    const result = projectMermaidFlowchart(view, { maxNodes: 2, direction: "TD" });

    expect(result.nodeCount).toBe(2);
    expect(result.diagnostics.some((item) => item.code === "mermaid.node-limit")).toBe(true);
    // Only the first two ids by sort order: finish, implement (not prepare).
    expect(result.source).toContain("finish");
    expect(result.source).toContain("implement");
    expect(result.source).not.toContain("prepare");
  });

  it("honours an explicit direction override", () => {
    const created = createWorkflow(linearDefinition(), at, "workflow-dir");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const view = projectGraphView(created.state);
    expect(projectMermaidFlowchart(view, { direction: "TD" }).direction).toBe("TD");
    expect(projectMermaidFlowchart(view, { direction: "LR" }).direction).toBe("LR");
  });
});
