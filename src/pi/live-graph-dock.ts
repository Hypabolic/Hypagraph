/**
 * Live Hypagraph bottom dock.
 *
 * Replaces the right-side box-layout pane for product use. Renders a horizontal
 * Mermaid diagram above the composer, colour-codes active nodes and loops, and
 * refreshes when canonical state changes.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { HypagraphState } from "../domain/model.js";
import type { FamilyGraphViewModel } from "../graph/family-projection.js";
import { projectMermaidFlowchart } from "../graph/mermaid-projection.js";
import { projectGraphView, type GraphViewModel } from "../graph/projection.js";
import {
  colorizeLiveGraphArtLines,
  nodeIsLiveHot,
} from "../ui/live-graph-color.js";
import { renderMermaidArtBestFit } from "../ui/mermaid-art.js";
import { familyGraphSummaryLines } from "../ui/family-surface.js";

const KEY_HELP_DOCK =
  "q close · Esc release · ]/[ family member · 0 root · arrows select · Enter details";

const KEY_HELP_MODAL =
  "q / Esc close · ]/[ family member · 0 root · arrows select · Enter details · ctrl+shift+g reopen";

const MAX_ART_LINES_DOCK = 40;
const MAX_ART_LINES_MODAL = 80;

/** Product presentation for the live Mermaid graph surface. */
export type LiveGraphPresentation = "dock" | "modal";

export interface LiveGraphDockOptions {
  maxContentLines?: number;
  artMaxWidth?: number;
  /**
   * dock — bottom companion chrome (default product path).
   * modal — large centered full-view overlay (ctrl+shift+g / graph full).
   */
  presentation?: LiveGraphPresentation;
}

/**
 * Build live Mermaid source with status markers (LR default).
 */
export function liveGraphMermaidSource(view: GraphViewModel): {
  source: string;
  direction: string;
  nodeCount: number;
} {
  const projection = projectMermaidFlowchart(view, {
    statusMarkers: true,
    direction: "LR",
  });
  return {
    source: projection.source,
    direction: projection.direction,
    nodeCount: projection.nodeCount,
  };
}

/**
 * Render and colour-code live graph art lines for a view.
 *
 * Always keeps a horizontal (LR) layout. Vertical TD is not used: it fits
 * narrow terminals by width but is tall and gets dock height truncation.
 * When LR is wider than the dock, try shorter labels, then clip the art.
 * Never shows raw Mermaid source in the product dock.
 */
export function renderLiveGraphDiagram(
  view: GraphViewModel,
  theme: Theme,
  maxWidth: number,
  options: { maxArtLines?: number } = {},
): { lines: string[]; mode: string; hotSummary: string; clipped?: boolean; direction: string } {
  const budget = Math.max(20, maxWidth);
  // Prefer full titles first; fall back to compact labels when the art is wide.
  const lr = projectMermaidFlowchart(view, {
    statusMarkers: true,
    direction: "LR",
    maxLabelLength: 22,
  });
  const lrCompact = projectMermaidFlowchart(view, {
    statusMarkers: true,
    direction: "LR",
    maxLabelLength: 16,
    compact: true,
  });
  const lrTight = projectMermaidFlowchart(view, {
    statusMarkers: true,
    direction: "LR",
    maxLabelLength: 10,
    compact: true,
  });
  const art = renderMermaidArtBestFit(
    [lr.source, lrCompact.source, lrTight.source],
    {
      maxWidth: budget,
      preferSourceBox: false,
      whenTooWide: "clip-art",
    },
  );
  const colored = colorizeLiveGraphArtLines(art.lines, view, theme);
  const hot = view.nodes.filter(nodeIsLiveHot).map((node) => `${node.id}:${node.status}`);
  const run = view.nodes
    .filter((node) => !nodeIsLiveHot(node) && node.attemptCount > 0)
    .map((node) => `${node.id}:${node.status}`);
  const loops = view.loops
    .filter((loop) => loop.status === "running" || loop.status === "blocked")
    .map((loop) => `${loop.id}:${loop.status}`);
  const takenRoutes = view.edges
    .filter((edge) => edge.kind === "route" && edge.selected && edge.outcome !== undefined)
    .map((edge) => `${edge.source}→${edge.target}:${edge.outcome}`);
  const hotSummary = [...hot, ...run.slice(0, 4), ...loops, ...takenRoutes].join(", ") || "none";
  const maxArt = options.maxArtLines ?? MAX_ART_LINES_DOCK;
  return {
    lines: colored.slice(0, maxArt),
    mode: art.mode,
    hotSummary,
    direction: "LR",
    ...(art.clipped === true ? { clipped: true } : {}),
  };
}

/**
 * Live bottom-dock graph surface.
 */
export class LiveGraphDockComponent implements Component, Focusable {
  focused = false;
  private closed = false;
  private showDetails = false;
  private selectedIndex = 0;
  private view: GraphViewModel;
  private family: FamilyGraphViewModel | undefined;
  private familyFocusGoalId: string | undefined;
  private state: HypagraphState | undefined;
  private readonly presentation: LiveGraphPresentation;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly onReleaseFocus: () => void,
    state: HypagraphState,
    family?: FamilyGraphViewModel,
    private readonly options: LiveGraphDockOptions = {},
  ) {
    this.state = state;
    this.view = projectGraphView(state);
    this.family = family;
    this.familyFocusGoalId = family?.focusedGoalId;
    this.selectedIndex = this.defaultSelectionIndex();
    this.presentation = options.presentation ?? "dock";
  }

  get presentationForTest(): LiveGraphPresentation {
    return this.presentation;
  }

  get primaryWorkflowIdForTest(): string {
    return this.view.workflowId;
  }

  get primaryTitleForTest(): string {
    return this.view.title;
  }

  get familyFocusGoalIdForTest(): string | undefined {
    return this.familyFocusGoalId ?? this.family?.focusedGoalId;
  }

  get hasFamilyForTest(): boolean {
    return this.family !== undefined;
  }

  /** Apply a new live state snapshot (controller paint path). */
  updateState(state: HypagraphState, family?: FamilyGraphViewModel): void {
    this.state = state;
    if (family !== undefined) {
      this.family = family;
      if (!this.familyFocusGoalId || !family.members.some((m) => m.goalId === this.familyFocusGoalId)) {
        this.familyFocusGoalId = family.focusedGoalId;
      }
    }
    this.view = this.resolveView();
    if (this.selectedIndex >= this.view.nodes.length) {
      this.selectedIndex = this.defaultSelectionIndex();
    }
    this.invalidate();
  }

  setFamily(family: FamilyGraphViewModel | undefined): void {
    this.family = family;
    this.familyFocusGoalId = family?.focusedGoalId;
    this.view = this.resolveView();
    this.invalidate();
  }

  focusFamilyMemberByGoalId(goalId: string): { ok: true; goalId: string } | { ok: false; reason: string } {
    const trimmed = goalId.trim();
    if (!trimmed) return { ok: false, reason: "A family member goal id is required." };
    if (!this.family) return { ok: false, reason: "There is no family projection on the graph dock." };
    const member = this.family.members.find((item) => item.goalId === trimmed);
    if (!member) {
      return { ok: false, reason: `Family member '${trimmed}' is not in the current family projection.` };
    }
    this.familyFocusGoalId = trimmed;
    this.view = this.resolveView();
    this.selectedIndex = this.defaultSelectionIndex();
    this.invalidate();
    return { ok: true, goalId: trimmed };
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.done();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      // Modal: Esc closes the full view. Dock: Esc only releases focus to the composer.
      if (this.presentation === "modal") {
        this.finish();
      } else {
        this.onReleaseFocus();
      }
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
    if (this.family) {
      if (data === "]" || data === "n") {
        this.cycleFamily(1);
        return;
      }
      if (data === "[" || data === "p") {
        this.cycleFamily(-1);
        return;
      }
      if (data === "0") {
        this.focusFamilyMemberByGoalId(this.family.rootGoalId);
        return;
      }
    }
    if (matchesKey(data, "left") || data === "h" || matchesKey(data, "up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, "right") || data === "l" || matchesKey(data, "down") || data === "j") {
      this.selectedIndex = Math.min(this.view.nodes.length - 1, this.selectedIndex + 1);
      this.invalidate();
    }
  }

  render(width: number): string[] {
    const paneWidth = Math.max(24, width);
    const inner = Math.max(20, paneWidth - 4);
    const isModal = this.presentation === "modal";
    const artWidth = this.options.artMaxWidth
      ?? (typeof this.tui.terminal?.columns === "number"
        ? Math.max(20, this.tui.terminal.columns - (isModal ? 4 : 6))
        : inner);
    const maxArt = isModal ? MAX_ART_LINES_MODAL : MAX_ART_LINES_DOCK;

    const diagram = renderLiveGraphDiagram(this.view, this.theme, artWidth, {
      maxArtLines: maxArt,
    });
    const selected = this.view.nodes[this.selectedIndex];
    const focusGoal = this.familyFocusGoalId ?? this.family?.focusedGoalId;
    const titlePrefix = isModal ? "Hypagraph full graph" : "Hypagraph live";
    const header = [
      this.theme.fg("border", "─".repeat(Math.max(1, paneWidth))),
      `  ${this.theme.fg("accent", truncateToWidth(`${titlePrefix} · ${this.view.title}`, inner, "…"))}`,
      `  ${this.theme.fg("muted", truncateToWidth(
        `${this.view.phase} · r${this.view.revision} · e${this.view.sequence}`
        + (focusGoal ? ` · member ${focusGoal}` : "")
        + ` · ${diagram.hotSummary}`,
        inner,
        "…",
      ))}`,
      `  ${this.theme.fg("muted", "Colour: accent=active · green=done · red=failed · yellow=blocked · true=taken route")}`,
      "",
    ];

    const artLines = diagram.lines.map((line) => `  ${line}`);
    if (diagram.lines.length >= maxArt) {
      artLines.push(`  ${this.theme.fg("muted", "… diagram truncated")}`);
    }

    const familyLines: string[] = [];
    if (this.family) {
      for (const line of familyGraphSummaryLines(this.family, inner, { maxLines: isModal ? 6 : 4 })) {
        familyLines.push(`  ${this.theme.fg("muted", truncateToWidth(line, inner, "…"))}`);
      }
    }

    const statusToken = selected
      ? (selected.active || selected.ready
        ? "accent"
        : selected.status === "succeeded"
          ? "success"
          : selected.status === "failed"
            ? "error"
            : "muted")
      : "muted";
    const statusLine = `  ${this.theme.fg(
      statusToken,
      truncateToWidth(
        selected
          ? `selected ${selected.id} · ${selected.status}${selected.active ? " · active" : ""}${selected.ready ? " · ready" : ""}${selected.attemptCount > 0 ? ` · attempts ${selected.attemptCount}` : ""}`
          : "no node selected",
        inner,
        "…",
      ),
    )}`;

    const detailLines: string[] = [];
    if (this.showDetails && selected) {
      detailLines.push(
        `  ${this.theme.fg("muted", truncateToWidth(
          `kind=${selected.kind} attempts=${selected.attemptCount}`
          + (selected.loopId ? ` loop=${selected.loopId}` : ""),
          inner,
          "…",
        ))}`,
      );
    }

    const keyHelp = isModal ? KEY_HELP_MODAL : KEY_HELP_DOCK;
    const footer = [
      "",
      `  ${this.theme.fg("muted", truncateToWidth(keyHelp, inner, "…"))}`,
    ];

    const body = [
      ...header,
      ...artLines,
      "",
      ...familyLines,
      statusLine,
      ...detailLines,
      ...footer,
    ];

    if (this.options.maxContentLines === undefined) return body;
    return body.slice(0, Math.max(6, this.options.maxContentLines));
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  private resolveView(): GraphViewModel {
    if (this.family && this.familyFocusGoalId) {
      const member = this.family.members.find((item) => item.goalId === this.familyFocusGoalId);
      if (member?.graph) return member.graph;
    }
    if (this.state) return projectGraphView(this.state);
    return this.view;
  }

  private defaultSelectionIndex(): number {
    const active = this.view.nodes.findIndex((node) => node.active);
    if (active >= 0) return active;
    const ready = this.view.nodes.findIndex((node) => node.ready);
    if (ready >= 0) return ready;
    return 0;
  }

  private cycleFamily(delta: 1 | -1): void {
    if (!this.family || this.family.members.length === 0) return;
    const ids = this.family.members.map((member) => member.goalId);
    const current = this.familyFocusGoalId ?? this.family.focusedGoalId;
    const index = Math.max(0, ids.indexOf(current));
    const next = (index + delta + ids.length) % ids.length;
    this.focusFamilyMemberByGoalId(ids[next]!);
  }
}
