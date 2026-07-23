import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow } from "../src/domain/reducer.js";
import { layoutGraph } from "../src/graph/layout.js";
import { projectGraphView } from "../src/graph/projection.js";
import { GraphPaneController, PiGraphPaneComponent } from "../src/pi/graph-pane.js";

const definition = (): HypagraphDefinition => ({
  title: "Pane graph",
  goal: "Show graph state",
  nodes: [
    { id: "plan", title: "Plan", requires: [], acceptance: [] },
    { id: "code", title: "Code", requires: ["plan"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const state = () => {
  const created = createWorkflow(definition(), "2026-07-22T00:00:00.000Z", "workflow-pane");
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  return created.state;
};

const theme = {
  fg: (_name: string, value: string) => value,
} as unknown as Theme;

const tui = (columns: number, rows = 40) => ({
  terminal: { columns, rows },
  requestRender: vi.fn(),
} as unknown as TUI);

describe("Pi graph pane component", () => {
  it("renders graph state and releases focus on Escape in wide mode", () => {
    const view = projectGraphView(state());
    const layout = layoutGraph(view);
    const done = vi.fn();
    const release = vi.fn();
    const component = new PiGraphPaneComponent(
      tui(120),
      theme,
      done,
      release,
      vi.fn(),
      view,
      layout,
      "normal",
    );

    const lines = component.render(60);
    expect(lines.join("\n")).toContain("Hypagraph · Pane graph");
    expect(lines.join("\n")).toContain("plan");
    expect(lines.every((line) => visibleWidth(line) === 60)).toBe(true);

    component.handleInput("\r");
    expect(component.render(60).join("\n")).toContain("requires=none");
    component.handleInput("\u001b");
    expect(release).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
  });

  it("closes on Escape in narrow mode", () => {
    const view = projectGraphView(state());
    const done = vi.fn();
    const component = new PiGraphPaneComponent(
      tui(80),
      theme,
      done,
      vi.fn(),
      vi.fn(),
      view,
      layoutGraph(view),
      "normal",
    );

    component.handleInput("\u001b");
    expect(done).toHaveBeenCalledOnce();
  });
});

describe("graph pane controller", () => {
  it("uses a passive right-side overlay on wide terminals", () => {
    const controller = new GraphPaneController();
    controller.update(state());
    const fakeTui = tui(140, 50);
    const focus = vi.fn();
    const unfocus = vi.fn();
    const hide = vi.fn();
    const handle = {
      focus,
      unfocus,
      hide,
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
      anchor: "right-center",
      nonCapturing: true,
      width: 63,
      maxHeight: "90%",
    });
    expect(unfocus).toHaveBeenCalledWith({ target: null });

    controller.focus();
    expect(focus).toHaveBeenCalledOnce();
    controller.close();
    expect(hide).toHaveBeenCalledOnce();
    finish?.();
  });

  it("redraws an open pane for runtime changes without rebuilding its stable layout", () => {
    const controller = new GraphPaneController();
    const initial = state();
    controller.update(initial);
    const fakeTui = tui(140, 50);
    const handle = {
      focus: vi.fn(),
      unfocus: vi.fn(),
      hide: vi.fn(),
      setHidden: vi.fn(),
      isHidden: vi.fn(() => false),
      isFocused: vi.fn(() => false),
    } satisfies OverlayHandle;
    let component: PiGraphPaneComponent | undefined;
    let finish: (() => void) | undefined;
    const custom = vi.fn((factory, options) => new Promise<void>((resolve) => {
      finish = resolve;
      component = factory(fakeTui, theme, {}, resolve);
      options.onHandle(handle);
    }));
    const ctx = {
      mode: "tui",
      ui: { custom, notify: vi.fn() },
    } as unknown as ExtensionContext;

    controller.open(ctx);
    const before = component!.render(60).join("\n");
    const changed = structuredClone(initial);
    changed.sequence += 1;
    changed.runtime.nodes.plan!.status = "running";
    changed.runtime.nodes.plan!.attemptCount = 1;
    vi.mocked(fakeTui.requestRender).mockClear();

    controller.update(changed);

    expect(fakeTui.requestRender).toHaveBeenCalledOnce();
    const after = component!.render(60).join("\n");
    expect(after).not.toBe(before);
    expect(after).toContain("e3");
    controller.close();
    finish?.();
  });

  it("uses a capturing full-screen overlay on narrow terminals", () => {
    const controller = new GraphPaneController();
    controller.update(state());
    const fakeTui = tui(80, 30);
    const handle = {
      focus: vi.fn(),
      unfocus: vi.fn(),
      hide: vi.fn(),
      setHidden: vi.fn(),
      isHidden: vi.fn(() => false),
      isFocused: vi.fn(() => true),
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
    expect(overlayOptions?.()).toMatchObject({
      anchor: "center",
      nonCapturing: false,
      width: 78,
      maxHeight: 28,
    });
    expect(handle.unfocus).not.toHaveBeenCalled();
    controller.close();
    finish?.();
  });
});
