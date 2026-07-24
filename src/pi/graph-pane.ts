import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";
import type { HypagraphState } from "../domain/model.js";
import { layoutGraph, type GraphLayout, type GraphLayoutNode } from "../graph/layout.js";
import { graphLayoutKey, projectGraphView, type GraphViewModel, type GraphViewNode } from "../graph/projection.js";
import { renderGraphScene, sanitizeTerminalText } from "../graph/renderer.js";

export type GraphDensity = "compact" | "normal" | "spacious";

const MIN_SIDE_WIDTH = 48;
const MAX_SIDE_WIDTH = 96;
const WIDE_TERMINAL_WIDTH = 100;

const selectedNode = (view: GraphViewModel, selectedNodeId: string | undefined): GraphViewNode | undefined =>
  selectedNodeId === undefined ? undefined : view.nodes.find((node) => node.id === selectedNodeId);

const firstSelection = (view: GraphViewModel): string | undefined =>
  view.activeNodeId ?? view.readyNodeIds[0] ?? view.nodes[0]?.id;

const frameLine = (theme: Theme, left: string, fill: string, right: string, width: number, title = ""): string => {
  const inner = Math.max(0, width - 2);
  const cleanTitle = sanitizeTerminalText(title);
  if (!cleanTitle) return theme.fg("border", `${left}${fill.repeat(inner)}${right}`);
  const label = truncateToWidth(` ${cleanTitle} `, inner, "…");
  const labelWidth = visibleWidth(label);
  const before = Math.max(0, Math.floor((inner - labelWidth) / 2));
  const after = Math.max(0, inner - labelWidth - before);
  return theme.fg("border", `${left}${fill.repeat(before)}`)
    + theme.fg("accent", label)
    + theme.fg("border", `${fill.repeat(after)}${right}`);
};

export class PiGraphPaneComponent implements Component, Focusable {
  focused = false;
  private selectedNodeId: string | undefined;
  private viewportX = 0;
  private viewportY = 0;
  private showDetails = false;
  private closed = false;
  private graphWidth = 1;
  private graphHeight = 1;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly onReleaseFocus: () => void,
    private readonly onDensityChange: (density: GraphDensity) => void,
    private view: GraphViewModel,
    private layout: GraphLayout,
    private density: GraphDensity,
  ) {
    this.selectedNodeId = firstSelection(view);
  }

  get terminalWidth(): number {
    return this.tui.terminal.columns;
  }

  get terminalHeight(): number {
    return this.tui.terminal.rows;
  }

  get currentDensity(): GraphDensity {
    return this.density;
  }

  update(view: GraphViewModel, layout: GraphLayout, density: GraphDensity): void {
    this.view = view;
    this.layout = layout;
    this.density = density;
    if (!this.selectedNodeId || !view.nodes.some((node) => node.id === this.selectedNodeId)) {
      this.selectedNodeId = firstSelection(view);
    }
    this.ensureSelectedVisible();
    this.invalidate();
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.done();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.terminalWidth >= WIDE_TERMINAL_WIDTH) this.onReleaseFocus();
      else this.finish();
      return;
    }
    if (data === "q") {
      this.finish();
      return;
    }
    if (matchesKey(data, "return")) {
      this.showDetails = !this.showDetails;
      this.invalidate();
      return;
    }
    if (matchesKey(data, "home")) {
      this.selectedNodeId = this.view.activeNodeId ?? firstSelection(this.view);
      this.ensureSelectedVisible();
      this.invalidate();
      return;
    }
    if (data === "r") {
      this.selectedNodeId = this.view.readyNodeIds[0] ?? this.selectedNodeId;
      this.ensureSelectedVisible();
      this.invalidate();
      return;
    }
    if (data === "+" || data === "=") {
      this.changeDensity(1);
      return;
    }
    if (data === "-") {
      this.changeDensity(-1);
      return;
    }
    if (matchesKey(data, "left") || data === "h") this.moveSelection(-1, 0);
    else if (matchesKey(data, "right") || data === "l") this.moveSelection(1, 0);
    else if (matchesKey(data, "up") || data === "k") this.moveSelection(0, -1);
    else if (matchesKey(data, "down") || data === "j") this.moveSelection(0, 1);
  }

  render(width: number): string[] {
    const paneWidth = Math.max(20, width);
    const innerWidth = Math.max(1, paneWidth - 2);
    const availableHeight = Math.max(8, Math.min(this.terminalHeight - 2, Math.floor(this.terminalHeight * 0.9)));
    const detailLines = this.showDetails ? this.renderDetails(innerWidth) : [];
    const goalLines = this.renderGoalSummary(innerWidth);
    const chromeRows = 4 + goalLines.length + detailLines.length;
    const graphHeight = Math.max(4, availableHeight - chromeRows);
    this.graphWidth = innerWidth;
    this.graphHeight = graphHeight;
    this.ensureSelectedVisible();

    const graphLines = renderGraphScene(this.view, this.layout, {
      width: innerWidth,
      height: graphHeight,
      viewportX: this.viewportX,
      viewportY: this.viewportY,
      ...(this.selectedNodeId === undefined ? {} : { selectedNodeId: this.selectedNodeId }),
      unicode: true,
    });

    const row = (content: string): string => {
      const clipped = truncateToWidth(content, innerWidth, "", true);
      return this.theme.fg("border", "│")
        + clipped
        + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))
        + this.theme.fg("border", "│");
    };

    const selected = selectedNode(this.view, this.selectedNodeId);
    const header = `${this.view.phase} · r${this.view.revision} · e${this.view.sequence}`;
    const lines = [frameLine(this.theme, "╭", "─", "╮", paneWidth, `Hypagraph · ${this.view.title}`), row(` ${header}`)];
    for (const line of goalLines) lines.push(row(line));
    for (const line of graphLines) lines.push(row(line));
    for (const line of detailLines) lines.push(row(line));
    const focusText = this.focused ? "navigation" : "passive";
    lines.push(row(` ${selected?.id ?? "no node"} · ${focusText} · ${this.density}`));
    lines.push(row(" arrows/hjkl move · Enter details · Home active · r ready · +/- density · Esc release · q close"));
    lines.push(frameLine(this.theme, "╰", "─", "╯", paneWidth));
    return lines;
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  dispose(): void {
    this.closed = true;
  }

  private changeDensity(direction: 1 | -1): void {
    const values: GraphDensity[] = ["compact", "normal", "spacious"];
    const current = values.indexOf(this.density);
    const next = Math.max(0, Math.min(values.length - 1, current + direction));
    const density = values[next]!;
    if (density === this.density) return;
    this.onDensityChange(density);
  }

  private moveSelection(horizontal: -1 | 0 | 1, vertical: -1 | 0 | 1): void {
    const current = this.layout.nodes.find((node) => node.id === this.selectedNodeId);
    if (!current) return;
    const currentX = current.x + current.width / 2;
    const currentY = current.y + current.height / 2;
    const candidates = this.layout.nodes
      .filter((node) => node.id !== current.id)
      .map((node) => {
        const dx = node.x + node.width / 2 - currentX;
        const dy = node.y + node.height / 2 - currentY;
        const inDirection = horizontal < 0 ? dx < 0 : horizontal > 0 ? dx > 0 : vertical < 0 ? dy < 0 : dy > 0;
        const primary = horizontal === 0 ? Math.abs(dy) : Math.abs(dx);
        const secondary = horizontal === 0 ? Math.abs(dx) : Math.abs(dy);
        return { node, inDirection, score: primary * 10 + secondary };
      })
      .filter((candidate) => candidate.inDirection)
      .sort((left, right) => left.score - right.score || left.node.id.localeCompare(right.node.id));
    const next = candidates[0]?.node;
    if (!next) return;
    this.selectedNodeId = next.id;
    this.ensureSelectedVisible();
    this.invalidate();
  }

  private ensureSelectedVisible(): void {
    const node = this.layout.nodes.find((candidate) => candidate.id === this.selectedNodeId);
    if (!node) return;
    if (node.x < this.viewportX) this.viewportX = node.x;
    else if (node.x + node.width > this.viewportX + this.graphWidth) {
      this.viewportX = Math.max(0, node.x + node.width - this.graphWidth);
    }
    if (node.y < this.viewportY) this.viewportY = node.y;
    else if (node.y + node.height > this.viewportY + this.graphHeight) {
      this.viewportY = Math.max(0, node.y + node.height - this.graphHeight);
    }
  }

  private renderGoalSummary(width: number): string[] {
    const goal = this.view.goal;
    if (!goal) return [];
    const turns = `${goal.budget.turns.consumed}/${goal.budget.turns.limit ?? "∞"}`;
    const tokens = `${goal.budget.tokens.consumed}/${goal.budget.tokens.limit ?? "∞"}`;
    const revision = `${goal.automaticRevision.consumed}/${goal.automaticRevision.maximum}`;
    const lines = [
      ` Goal ${goal.goalId} · ${goal.status} · turns ${turns} · tokens ${tokens} · revision ${revision}${goal.automaticRevision.pending ? " pending" : ""}${goal.automaticRevision.lastOutcomeCode ? ` · ${goal.automaticRevision.lastOutcomeCode}` : ""}`,
      ` Objective ${sanitizeTerminalText(goal.objective)}`,
    ];
    if (goal.stopReason || goal.blockage.kind !== "not-blocked") {
      lines.push(` Stop ${goal.blockage.kind}${goal.blockage.blockerKind ? ` · ${goal.blockage.blockerKind} ${goal.blockage.blockerId}` : ""}${goal.stopReason ? ` · ${sanitizeTerminalText(goal.stopReason)}` : ""}`);
    }
    return lines.map((line) => truncateToWidth(line, width, "…", true));
  }

  private renderDetails(width: number): string[] {
    const node = selectedNode(this.view, this.selectedNodeId);
    if (!node) return ["", " No node is selected."];
    const incoming = this.view.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source).sort();
    const outgoing = this.view.edges.filter((edge) => edge.source === node.id).map((edge) => edge.target).sort();
    const details = [
      "",
      ` ${this.theme.fg("accent", sanitizeTerminalText(node.title))}`,
      ` kind=${node.kind} status=${node.status} attempts=${node.attemptCount}`,
      ` requires=${incoming.join(", ") || "none"}`,
      ` leads-to=${outgoing.join(", ") || "none"}`,
      ` facts=${node.factCount} evidence=${node.evidenceCount}${node.loopId ? ` loop=${node.loopId}` : ""}`,
    ];
    if (node.check) {
      details.push(` check=${node.check.status} exit=${node.check.exitCode ?? "none"}`);
      if (node.check.error) details.push(` error=${sanitizeTerminalText(node.check.error)}`);
    }
    return details.map((line) => truncateToWidth(line, width, "…", true));
  }
}

export class GraphPaneController {
  private state: HypagraphState | undefined;
  private view: GraphViewModel | undefined;
  private layout: GraphLayout | undefined;
  private layoutKey: string | undefined;
  private component: PiGraphPaneComponent | undefined;
  private handle: OverlayHandle | undefined;
  private openPromise: Promise<void> | undefined;
  private density: GraphDensity = "normal";

  get isOpen(): boolean {
    return this.openPromise !== undefined;
  }

  update(state: HypagraphState | undefined): void {
    this.state = state === undefined ? undefined : structuredClone(state);
    if (!state) {
      this.view = undefined;
      this.layout = undefined;
      this.layoutKey = undefined;
      this.component?.finish();
      return;
    }
    const view = projectGraphView(state);
    const nextKey = graphLayoutKey(view);
    if (!this.layout || this.layoutKey !== nextKey) {
      this.layout = layoutGraph(view, { density: this.density, ...(this.layout === undefined ? {} : { previous: this.layout }) });
      this.layoutKey = nextKey;
    }
    this.view = view;
    this.component?.update(view, this.layout, this.density);
  }

  open(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("The Hypagraph graph pane is available only in TUI mode.", "warning");
      return;
    }
    if (!this.view || !this.layout) {
      ctx.ui.notify("There is no active Hypagraph to show.", "warning");
      return;
    }
    if (this.isOpen) {
      this.focus();
      return;
    }

    let tuiReference: TUI | undefined;
    const initialView = this.view;
    const initialLayout = this.layout;
    const promise = ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        tuiReference = tui;
        const component = new PiGraphPaneComponent(
          tui,
          theme,
          done,
          () => this.releaseFocus(),
          (density) => this.setDensity(density),
          initialView,
          initialLayout,
          this.density,
        );
        this.component = component;
        return component;
      },
      {
        overlay: true,
        overlayOptions: (): OverlayOptions => this.overlayOptions(tuiReference),
        onHandle: (handle) => {
          this.handle = handle;
          if ((tuiReference?.terminal.columns ?? WIDE_TERMINAL_WIDTH) >= WIDE_TERMINAL_WIDTH) {
            handle.unfocus({ target: null });
          }
        },
      },
    );
    this.openPromise = promise;
    void promise
      .catch((error: unknown) => ctx.ui.notify(`Hypagraph graph pane failed: ${error instanceof Error ? error.message : String(error)}`, "error"))
      .finally(() => {
        this.openPromise = undefined;
        this.component = undefined;
        this.handle = undefined;
      });
  }

  close(): void {
    this.component?.finish();
    this.handle?.hide();
    this.component = undefined;
    this.handle = undefined;
  }

  toggle(ctx: ExtensionContext): void {
    if (this.isOpen) this.close();
    else this.open(ctx);
  }

  focus(): void {
    this.handle?.focus();
    this.component?.invalidate();
  }

  releaseFocus(): void {
    this.handle?.unfocus({ target: null });
    this.component?.invalidate();
  }

  dispose(): void {
    this.close();
    this.state = undefined;
    this.view = undefined;
    this.layout = undefined;
    this.layoutKey = undefined;
  }

  private setDensity(density: GraphDensity): void {
    if (!this.view || density === this.density) return;
    this.density = density;
    this.layout = layoutGraph(this.view, { density, ...(this.layout === undefined ? {} : { previous: this.layout }) });
    this.component?.update(this.view, this.layout, density);
  }

  private overlayOptions(tui: TUI | undefined): OverlayOptions {
    const columns = tui?.terminal.columns ?? WIDE_TERMINAL_WIDTH;
    const rows = tui?.terminal.rows ?? 40;
    if (columns < WIDE_TERMINAL_WIDTH) {
      return {
        anchor: "center",
        width: Math.max(20, columns - 2),
        maxHeight: Math.max(8, rows - 2),
        margin: 0,
        nonCapturing: false,
      };
    }
    return {
      anchor: "right-center",
      width: Math.min(MAX_SIDE_WIDTH, Math.max(MIN_SIDE_WIDTH, Math.floor(columns * 0.45))),
      maxHeight: "90%",
      margin: { right: 1 },
      nonCapturing: true,
    };
  }
}
