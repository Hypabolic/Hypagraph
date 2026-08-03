/**
 * Live bottom graph dock: Mermaid LR art, status markers, colour paint, controller wiring.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { projectGraphView } from "../src/graph/projection.js";
import { GraphPaneController } from "../src/pi/graph-pane.js";
import {
  liveGraphMermaidSource,
  LiveGraphDockComponent,
  renderLiveGraphDiagram,
} from "../src/pi/live-graph-dock.js";
import {
  colorizeLiveGraphArtLines,
  liveNodeLabel,
  nodeIsLiveHot,
  nodePathHasRun,
  themeTokenForNodeStatus,
} from "../src/ui/live-graph-color.js";

const at = "2026-07-31T22:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Live dock graph",
  goal: "Show live status colour",
  nodes: [
    { id: "plan", title: "Plan work", requires: [], acceptance: [] },
    { id: "code", title: "Code work", requires: ["plan"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const state = () => {
  const created = createWorkflow(definition(), at, "workflow-live-dock");
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  return created.state;
};

const runningState = () => {
  let next = state();
  const started = handleCommand(next, {
    type: "start-goal",
    goalId: "goal-live",
    budget: { maximumTurns: 8, maximumTokens: 4000 },
    commandId: "start-goal-live",
    at,
  });
  if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
  next = started.state;
  const node = handleCommand(next, {
    type: "start-node",
    nodeId: "plan",
    attemptId: "attempt-plan",
    commandId: "start-plan",
    at,
  });
  if (!node.ok) throw new Error(JSON.stringify(node.diagnostics));
  return node.state;
};

const theme = {
  fg: (name: string, value: string) => `[${name}]${value}[/${name}]`,
} as unknown as Theme;

const tui = (columns = 100, rows = 40) => ({
  terminal: { columns, rows },
  requestRender: vi.fn(),
} as unknown as TUI);

describe("live graph colour helpers", () => {
  it("marks hot statuses and maps tokens", () => {
    expect(themeTokenForNodeStatus("running")).toBe("accent");
    expect(themeTokenForNodeStatus("ready")).toBe("toolTitle");
    expect(themeTokenForNodeStatus("succeeded")).toBe("success");
    expect(themeTokenForNodeStatus("failed")).toBe("error");
    const view = projectGraphView(runningState());
    const plan = view.nodes.find((node) => node.id === "plan")!;
    expect(nodeIsLiveHot(plan)).toBe(true);
    expect(liveNodeLabel(plan)).toMatch(/▶/);
  });

  it("paints status labels in art lines", () => {
    const view = projectGraphView(runningState());
    const plan = view.nodes.find((node) => node.id === "plan")!;
    const label = liveNodeLabel(plan);
    const plain = [`box ${label} box`];
    const colored = colorizeLiveGraphArtLines(plain, view, theme);
    expect(colored[0]).toContain("[accent]");
    expect(colored[0]).toContain(label);
  });

  it("marks active nodes as path-has-run candidates and paints truncated labels", () => {
    const view = projectGraphView(runningState());
    const plan = view.nodes.find((node) => node.id === "plan")!;
    expect(nodeIsLiveHot(plan)).toBe(true);
    expect(plan.attemptCount).toBeGreaterThan(0);
    // Compact art often truncates titles; colour must still match short labels.
    const short = liveNodeLabel(plan, 10);
    const colored = colorizeLiveGraphArtLines([`>> ${short} <<`], view, theme, 10);
    expect(colored[0]).toMatch(/\[(accent|success|toolTitle)\]/);
  });
});

describe("live graph mermaid projection", () => {
  it("defaults to LR with status markers", () => {
    const view = projectGraphView(runningState());
    const { source, direction } = liveGraphMermaidSource(view);
    expect(direction).toBe("LR");
    expect(source.startsWith("flowchart LR")).toBe(true);
    expect(source).toMatch(/▶/);
  });

  it("renderLiveGraphDiagram reports hot summary", () => {
    const view = projectGraphView(runningState());
    const diagram = renderLiveGraphDiagram(view, theme, 80);
    expect(diagram.lines.length).toBeGreaterThan(0);
    expect(diagram.hotSummary).toMatch(/plan:/);
  });
});

describe("LiveGraphDockComponent", () => {
  it("renders live title and updates when state changes", () => {
    const initial = state();
    const component = new LiveGraphDockComponent(
      tui(),
      theme,
      vi.fn(),
      vi.fn(),
      initial,
    );
    const before = component.render(80).join("\n");
    expect(before).toContain("Hypagraph live");
    expect(before).toContain("Live dock graph");

    const next = runningState();
    component.updateState(next);
    const after = component.render(80).join("\n");
    expect(after).toMatch(/plan:running/);
    expect(after).toMatch(/▶|running|starting|ready/);
    expect(after).toMatch(/\[accent\].*Plan work|▶ Plan work/);
  });

  it("releases focus on Escape and closes on q", () => {
    const release = vi.fn();
    const done = vi.fn();
    const component = new LiveGraphDockComponent(
      tui(),
      theme,
      done,
      release,
      state(),
    );
    component.handleInput("\u001b");
    expect(release).toHaveBeenCalledOnce();
    component.handleInput("q");
    expect(done).toHaveBeenCalledOnce();
  });

  it("closes the modal on Escape instead of only releasing focus", () => {
    const release = vi.fn();
    const done = vi.fn();
    const component = new LiveGraphDockComponent(
      tui(120, 40),
      theme,
      done,
      release,
      state(),
      undefined,
      { presentation: "modal" },
    );
    expect(component.presentationForTest).toBe("modal");
    const text = component.render(100).join("\n");
    expect(text).toContain("Hypagraph full graph");
    expect(text).toMatch(/Colour:/);
    component.handleInput("\u001b");
    expect(done).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });
});

describe("GraphPaneController live dock product path", () => {
  it("opens a bottom-center companion dock, not a right-side overlay", () => {
    const controller = new GraphPaneController();
    controller.update(state());
    const fakeTui = tui(140, 50);
    const unfocus = vi.fn();
    const handle = {
      focus: vi.fn(),
      unfocus,
      hide: vi.fn(),
      setHidden: vi.fn(),
      isHidden: vi.fn(() => false),
      isFocused: vi.fn(() => false),
    } satisfies OverlayHandle;
    let overlayOptions: (() => Record<string, unknown>) | undefined;
    let finish: (() => void) | undefined;
    const custom = vi.fn((factory, options) => new Promise<void>((resolve) => {
      finish = resolve;
      factory(fakeTui, theme, {}, resolve);
      overlayOptions = options.overlayOptions;
      options.onHandle(handle);
    }));
    const ctx = {
      mode: "tui",
      ui: { custom, notify: vi.fn() },
    } as unknown as ExtensionContext;

    controller.open(ctx);
    expect(custom).toHaveBeenCalledOnce();
    expect(overlayOptions?.()).toMatchObject({
      anchor: "bottom-center",
      nonCapturing: true,
      width: "100%",
    });
    expect(unfocus).toHaveBeenCalledWith({ target: null });

    const text = controller.componentForTest!.render(90).join("\n");
    expect(text).toContain("Hypagraph live");
    expect(text).not.toMatch(/right-center|side pane/i);

    controller.close();
    finish?.();
  });

  it("repaints the dock when state advances", () => {
    const controller = new GraphPaneController();
    controller.update(state());
    const fakeTui = tui(100, 40);
    const handle = {
      focus: vi.fn(),
      unfocus: vi.fn(),
      hide: vi.fn(),
      setHidden: vi.fn(),
      isHidden: vi.fn(() => false),
      isFocused: vi.fn(() => false),
    } satisfies OverlayHandle;
    let finish: (() => void) | undefined;
    const custom = vi.fn((factory, options) => new Promise<void>((resolve) => {
      finish = resolve;
      factory(fakeTui, theme, {}, resolve);
      options.onHandle(handle);
    }));
    const ctx = {
      mode: "tui",
      ui: { custom, notify: vi.fn() },
    } as unknown as ExtensionContext;

    controller.open(ctx);
    const before = controller.componentForTest!.render(80).join("\n");
    controller.update(runningState());
    const after = controller.componentForTest!.render(80).join("\n");
    expect(after).not.toBe(before);
    expect(after).toMatch(/plan:/);
    controller.close();
    finish?.();
  });

  it("opens a centered full-view modal that captures focus", () => {
    const controller = new GraphPaneController();
    controller.update(runningState());
    const fakeTui = tui(140, 50);
    const focus = vi.fn();
    const unfocus = vi.fn();
    const handle = {
      focus,
      unfocus,
      hide: vi.fn(),
      setHidden: vi.fn(),
      isHidden: vi.fn(() => false),
      isFocused: vi.fn(() => false),
    } satisfies OverlayHandle;
    let overlayOptions: (() => Record<string, unknown>) | undefined;
    let finish: (() => void) | undefined;
    const custom = vi.fn((factory, options) => new Promise<void>((resolve) => {
      finish = resolve;
      factory(fakeTui, theme, {}, resolve);
      overlayOptions = options.overlayOptions;
      options.onHandle(handle);
    }));
    const ctx = {
      mode: "tui",
      ui: { custom, notify: vi.fn() },
    } as unknown as ExtensionContext;

    controller.openFull(ctx);
    expect(custom).toHaveBeenCalledOnce();
    expect(overlayOptions?.()).toMatchObject({
      anchor: "center",
      width: "98%",
      nonCapturing: false,
    });
    expect(focus).toHaveBeenCalled();
    expect(controller.presentationForTest).toBe("modal");
    const text = controller.componentForTest!.render(120).join("\n");
    expect(text).toContain("Hypagraph full graph");
    expect(text).toMatch(/\[accent\]|\[success\]|▶|✓/);
    controller.close();
    finish?.();
  });

  it("keeps the modal open when the graph is replaced (tour member advance)", async () => {
    const controller = new GraphPaneController();
    controller.update(state());
    const fakeTui = tui(120, 40);
    const handle = {
      focus: vi.fn(),
      unfocus: vi.fn(),
      hide: vi.fn(),
      setHidden: vi.fn(),
      isHidden: vi.fn(() => false),
      isFocused: vi.fn(() => false),
    } satisfies OverlayHandle;
    let openCount = 0;
    const custom = vi.fn((factory, options) => new Promise<void>((resolve) => {
      openCount += 1;
      factory(fakeTui, theme, {}, resolve);
      options.onHandle(handle);
      // Simulate previous custom() resolving after a tour close+open race.
      if (openCount === 1) {
        queueMicrotask(() => resolve());
      }
    }));
    const ctx = {
      mode: "tui",
      ui: { custom, notify: vi.fn() },
    } as unknown as ExtensionContext;

    controller.openFull(ctx);
    const first = controller.componentForTest;
    expect(first).toBeDefined();

    // Tour advance: new workflow state, openFull again without closing.
    controller.update(runningState());
    controller.openFull(ctx);
    // Same presentation: refresh in place, do not spawn a second overlay.
    expect(custom).toHaveBeenCalledOnce();
    expect(controller.componentForTest).toBe(first);
    expect(controller.isOpen).toBe(true);
    expect(controller.componentForTest!.render(100).join("\n")).toMatch(/plan:/);

    // close then open: old finally must not wipe the new surface.
    controller.close();
    await Promise.resolve();
    controller.update(state());
    controller.openFull(ctx);
    expect(custom).toHaveBeenCalledTimes(2);
    const second = controller.componentForTest;
    expect(second).toBeDefined();
    // Let the first (and any) custom finally run.
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.componentForTest).toBe(second);
    expect(controller.isOpen).toBe(true);
  });
});

