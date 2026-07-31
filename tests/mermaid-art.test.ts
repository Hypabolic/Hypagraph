import { describe, expect, it } from "vitest";
import { render as grokRender } from "grok-mermaid";
import { projectMermaidFlowchart } from "../src/graph/mermaid-projection.js";
import type { GraphViewModel } from "../src/graph/projection.js";
import { renderMermaidArt } from "../src/ui/mermaid-art.js";

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
});
