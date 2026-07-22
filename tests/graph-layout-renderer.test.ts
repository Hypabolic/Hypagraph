import { describe, expect, it } from "vitest";
import { layoutGraph } from "../src/graph/layout.js";
import type { GraphViewModel } from "../src/graph/projection.js";
import { renderGraphScene, sanitizeTerminalText } from "../src/graph/renderer.js";

const view = (): GraphViewModel => ({
  workflowId: "workflow-layout",
  revision: 1,
  sequence: 4,
  phase: "running",
  title: "Layout graph",
  nodes: [
    { id: "build", title: "Build", kind: "task", status: "succeeded", attemptCount: 1, active: false, ready: false, factCount: 0, evidenceCount: 1 },
    { id: "choose", title: "Choose route", kind: "gate", status: "succeeded", attemptCount: 0, active: false, ready: false, factCount: 0, evidenceCount: 0 },
    { id: "docs", title: "Write docs", kind: "task", status: "ready", attemptCount: 0, active: false, ready: true, factCount: 0, evidenceCount: 0 },
    { id: "repair", title: "Repair", kind: "task", status: "skipped", attemptCount: 0, active: false, ready: false, factCount: 0, evidenceCount: 0, loopId: "repair-loop" },
    { id: "test", title: "Test", kind: "check", status: "pending", attemptCount: 0, active: false, ready: false, factCount: 0, evidenceCount: 0, loopId: "repair-loop" },
  ],
  edges: [
    { id: "dependency:build:choose", source: "build", target: "choose", kind: "dependency", selected: false, skipped: false },
    { id: "route:choose:docs:true", source: "choose", target: "docs", kind: "route", selected: true, skipped: false, outcome: "true" },
    { id: "route:choose:repair:false", source: "choose", target: "repair", kind: "route", selected: false, skipped: true, outcome: "false" },
    { id: "dependency:repair:test", source: "repair", target: "test", kind: "dependency", selected: false, skipped: false },
    { id: "feedback:test:repair", source: "test", target: "repair", kind: "feedback", selected: false, skipped: false },
  ],
  loops: [{
    id: "repair-loop",
    nodeIds: ["repair", "test"],
    entryNodeId: "repair",
    evaluationNodeId: "test",
    feedbackEdges: [{ source: "test", target: "repair" }],
    maxIterations: 3,
  }],
  readyNodeIds: ["docs"],
});

describe("graph layout and renderer", () => {
  it("assigns deterministic ranks and a separate feedback lane", () => {
    const first = layoutGraph(view());
    const second = layoutGraph(view());

    expect(second).toEqual(first);
    const byId = new Map(first.nodes.map((node) => [node.id, node]));
    expect(byId.get("choose")!.rank).toBeGreaterThan(byId.get("build")!.rank);
    expect(byId.get("docs")!.rank).toBeGreaterThan(byId.get("choose")!.rank);
    const feedback = first.edges.find((edge) => edge.kind === "feedback")!;
    expect(feedback.points.length).toBe(4);
    expect(first.loops[0]).toMatchObject({ id: "repair-loop", maxIterations: 3 });
  });

  it("preserves positions when only runtime decorations change", () => {
    const initialView = view();
    const initial = layoutGraph(initialView);
    const changed: GraphViewModel = {
      ...initialView,
      sequence: 5,
      nodes: initialView.nodes.map((node) => node.id === "docs" ? { ...node, status: "running", ready: false, active: true } : node),
      readyNodeIds: [],
      activeNodeId: "docs",
    };
    const next = layoutGraph(changed, { previous: initial });
    expect(next.nodes).toEqual(initial.nodes);
  });

  it("clips every rendered line and supports ASCII output", () => {
    const layout = layoutGraph(view());
    const unicode = renderGraphScene(view(), layout, { width: 42, height: 18, selectedNodeId: "choose" });
    const ascii = renderGraphScene(view(), layout, { width: 30, height: 12, unicode: false });

    expect(unicode.every((line) => line.length === 42)).toBe(true);
    expect(ascii.every((line) => line.length === 30)).toBe(true);
    expect(unicode.join("\n")).toContain("loop repair-loop");
    expect(ascii.join("\n")).not.toMatch(/[┌┐└┘╭╮╰╯]/);
  });

  it("removes terminal control characters from untrusted labels", () => {
    expect(sanitizeTerminalText("safe\u001b[31m red\u0007 title")).toBe("safe red title");
  });
});
