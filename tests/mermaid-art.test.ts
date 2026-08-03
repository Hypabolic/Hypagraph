import { describe, expect, it } from "vitest";
import { render as grokRender } from "grok-mermaid";
import { projectMermaidFlowchart } from "../src/graph/mermaid-projection.js";
import type { GraphViewModel } from "../src/graph/projection.js";
import { renderMermaidArt, renderMermaidArtBestFit } from "../src/ui/mermaid-art.js";
import { resolveDemoExample } from "../src/pi/demo-catalog.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import { projectGraphView } from "../src/graph/projection.js";

const simpleView = (): GraphViewModel => ({
  workflowId: "workflow-art",
  revision: 1,
  sequence: 1,
  phase: "running",
  title: "Art sample",
  nodes: [
    {
      id: "start",
      title: "Start",
      kind: "task",
      status: "ready",
      attemptCount: 0,
      active: false,
      ready: true,
      factCount: 0,
      evidenceCount: 0,
    },
    {
      id: "done",
      title: "Done",
      kind: "task",
      status: "pending",
      attemptCount: 0,
      active: false,
      ready: false,
      factCount: 0,
      evidenceCount: 0,
    },
  ],
  edges: [
    {
      id: "dependency:start:done",
      source: "start",
      target: "done",
      kind: "dependency",
      selected: false,
      skipped: false,
    },
  ],
  loops: [],
  readyNodeIds: ["start"],
  awaitingNodeIds: [],
  derivedWaitingForUser: false,
});

describe("renderMermaidArt", () => {
  it("renders a simple flowchart as non-empty plain art", () => {
    const projection = projectMermaidFlowchart(simpleView());
    const result = renderMermaidArt(projection.source);

    expect(result.mode).toBe("art");
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.lines.join("\n").trim().length).toBeGreaterThan(0);
    expect(result.width).toBeGreaterThan(0);
    expect(result.kind).toBe("flowchart");
    expect(result.art).not.toBeNull();
    // Plain art should not include ANSI escape sequences.
    expect(result.lines.join("")).not.toMatch(/\u001b\[/);
  });

  it("falls back to sourceBox when art is wider than maxWidth", () => {
    const source = "flowchart LR\n  A[Start] --> B[Middle] --> C[End] --> D[Extra]";
    const full = renderMermaidArt(source);
    expect(full.mode).toBe("art");
    expect(full.width).toBeGreaterThan(1);

    const tight = renderMermaidArt(source, { maxWidth: 1 });
    expect(tight.mode).toBe("source-box");
    expect(tight.lines.length).toBeGreaterThan(0);
    expect(tight.lines.join("\n")).toMatch(/mermaid|flowchart|A\[Start\]/i);
  });

  it("falls back to text when sourceBox is disabled and render fails width", () => {
    const source = "flowchart TD\n  A[Start] --> B[Done]";
    const result = renderMermaidArt(source, {
      maxWidth: 1,
      preferSourceBox: false,
      textFallback: "compact summary",
    });
    expect(result.mode).toBe("text");
    expect(result.lines).toEqual(["compact summary"]);
  });

  it("can emit ANSI lines when requested", () => {
    const projection = projectMermaidFlowchart(simpleView());
    const result = renderMermaidArt(projection.source, { ansi: true });
    expect(result.mode).toBe("art");
    expect(result.lines.length).toBeGreaterThan(0);
    // toAnsi may or may not insert escapes depending on theme; join is non-empty.
    expect(result.lines.join("\n").length).toBeGreaterThan(0);
  });

  it("falls back to sourceBox when render returns null", () => {
    // Empty source and unsupported diagram kinds yield null from grok-mermaid.
    expect(grokRender("")).toBeNull();
    expect(grokRender("not a mermaid diagram at all")).toBeNull();

    const empty = renderMermaidArt("");
    expect(empty.art).toBeNull();
    expect(empty.mode).toBe("source-box");
    expect(empty.lines.length).toBeGreaterThan(0);

    const unsupported = renderMermaidArt("gantt\n  title Unsupported here");
    expect(unsupported.art).toBeNull();
    expect(unsupported.mode).toBe("source-box");
    expect(unsupported.lines.length).toBeGreaterThan(0);
    expect(unsupported.lines.join("\n")).toMatch(/gantt|Unsupported|mermaid/i);
  });

  it("falls back to text when render returns null and sourceBox is disabled", () => {
    expect(grokRender("")).toBeNull();
    const result = renderMermaidArt("", {
      preferSourceBox: false,
      textFallback: "text when art is null",
    });
    expect(result.art).toBeNull();
    expect(result.mode).toBe("text");
    expect(result.lines).toEqual(["text when art is null"]);
  });

  it("clip-art keeps Unicode art instead of raw Mermaid source when too wide", () => {
    const source = "flowchart LR\n  A[Start] --> B[Middle] --> C[End] --> D[Extra]";
    const full = renderMermaidArt(source);
    expect(full.mode).toBe("art");
    expect(full.width).toBeGreaterThan(10);

    const clipped = renderMermaidArt(source, {
      maxWidth: 12,
      whenTooWide: "clip-art",
      preferSourceBox: false,
    });
    expect(clipped.mode).toBe("art");
    expect(clipped.clipped).toBe(true);
    expect(clipped.lines.every((line) => line.length <= 12)).toBe(true);
    // Must not dump flowchart source into the dock.
    expect(clipped.lines.join("\n")).not.toMatch(/flowchart LR/);
  });

  it("best-fit keeps horizontal LR and clips instead of switching to tall TD", () => {
    const example = resolveDemoExample("showcase")!;
    const created = createHypagoalWorkflow(example.definition(), {
      workflowId: "workflow-fit",
      goalId: "goal-fit",
      goalWorkflowId: "workflow-fit",
      at: "2026-07-31T20:00:00.000Z",
      ...(example.budget === undefined ? {} : { budget: example.budget }),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const view = projectGraphView(created.state);
    const lr = projectMermaidFlowchart(view, { direction: "LR", statusMarkers: true });
    const lrTight = projectMermaidFlowchart(view, {
      direction: "LR",
      statusMarkers: true,
      maxLabelLength: 10,
      compact: true,
    });
    const td = projectMermaidFlowchart(view, { direction: "TD", statusMarkers: true });
    const lrArt = grokRender(lr.source);
    const tdArt = grokRender(td.source);
    expect(lrArt).not.toBeNull();
    expect(tdArt).not.toBeNull();
    expect(lrArt!.width).toBeGreaterThan(80);
    expect(tdArt!.width).toBeLessThanOrEqual(80);
    // TD is short in width but much taller — product docks must not pick it.
    expect(tdArt!.plain.length).toBeGreaterThan(lrArt!.plain.length);

    const fit = renderMermaidArtBestFit([lr.source, lrTight.source], {
      maxWidth: 80,
      preferSourceBox: false,
      whenTooWide: "clip-art",
    });
    expect(fit.mode).toBe("art");
    expect(fit.source.startsWith("flowchart LR")).toBe(true);
    expect(fit.clipped).toBe(true);
    expect(fit.lines.every((line) => line.length <= 80)).toBe(true);
    expect(fit.lines.join("\n")).not.toMatch(/flowchart (LR|TD)/);
    // Horizontal art stays short; product docks must not become a tall strip.
    expect(fit.lines.length).toBeLessThanOrEqual(16);
  });

  it("product post-create and live diagrams stay LR even at 80 columns", async () => {
    const { postCreateDiagramLines } = await import("../src/pi/post-create-dock.js");
    const { renderLiveGraphDiagram } = await import("../src/pi/live-graph-dock.js");
    const example = resolveDemoExample("showcase")!;
    const created = createHypagoalWorkflow(example.definition(), {
      workflowId: "workflow-lr-product",
      goalId: "goal-lr-product",
      goalWorkflowId: "workflow-lr-product",
      at: "2026-07-31T20:00:00.000Z",
      budget: example.budget,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const view = projectGraphView(created.state);
    const theme = { fg: (_n: string, v: string) => v } as any;

    const post = postCreateDiagramLines(created.state, 80);
    expect(post.direction).toBe("LR");
    expect(post.source.startsWith("flowchart LR")).toBe(true);
    expect(post.lines.length).toBeLessThanOrEqual(16);

    const live = renderLiveGraphDiagram(view, theme, 80);
    expect(live.direction).toBe("LR");
    expect(live.lines.length).toBeLessThanOrEqual(16);
  });
});
