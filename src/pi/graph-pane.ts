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
import type { DomainEvent, HypagraphState } from "../domain/model.js";
import {
  ancestryFromMembers,
  type FamilyGraphViewModel,
  type FamilyMemberBoundaryView,
} from "../graph/family-projection.js";
import { layoutGraph, type GraphLayout, type GraphLayoutNode } from "../graph/layout.js";
import { graphLayoutKey, projectGraphView, type GraphViewModel, type GraphViewNode } from "../graph/projection.js";
import { renderGraphScene, sanitizeTerminalText } from "../graph/renderer.js";
import { compareReplayWithLive, replayToSequence } from "../history/replay.js";
import type { TimelineEntry } from "../history/timeline.js";
import { familyGraphSummaryLines } from "../ui/family-surface.js";

export type GraphDensity = "compact" | "normal" | "spacious";

/** The replay mode of the pane. The pane renders stored history and changes no canonical state. */
export interface ReplayPaneState {
  sequence: number;
  firstSequence: number;
  liveSequence: number;
  entry: TimelineEntry;
  differenceLines: string[];
}

export interface ReplayPaneControls {
  step(delta: number): void;
  enter(): void;
  clear(): void;
}

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

/** Minimum rows reserved for the primary focused workflow graph. */
const MIN_PRIMARY_GRAPH_HEIGHT = 3;
/** Maximum rows for one nested child graph boundary. */
const MAX_NESTED_GRAPH_HEIGHT = 6;
/** Minimum rows for one nested child graph when space allows. */
const MIN_NESTED_GRAPH_HEIGHT = 3;
/** Maximum family chrome lines before nested graphs and primary graph. */
const MAX_FAMILY_CHROME_LINES = 8;

export class PiGraphPaneComponent implements Component, Focusable {
  focused = false;
  private replay: ReplayPaneState | undefined;
  private family: FamilyGraphViewModel | undefined;
  private selectedNodeId: string | undefined;
  private viewportX = 0;
  private viewportY = 0;
  private showDetails = false;
  private closed = false;
  private graphWidth = 1;
  private graphHeight = 1;
  /** UI focus among family members. Defaults to the projected focused goal. */
  private familyFocusGoalId: string | undefined;
  /** Family id bound to local expand/focus state. Reset when the family changes. */
  private boundFamilyId: string | undefined;
  /** Local expand set preserved across paintUi family refreshes for the same family. */
  private expandedMemberGoalIds = new Set<string>();
  /** Scroll offset for bounded family chrome detail lines. */
  private familyChromeScroll = 0;
  /** Nested/primary layout cache. Keys include density. */
  private nestedLayouts = new Map<string, GraphLayout>();

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly onReleaseFocus: () => void,
    private readonly onDensityChange: (density: GraphDensity) => void,
    private view: GraphViewModel,
    private layout: GraphLayout,
    private density: GraphDensity,
    private readonly replayControls: ReplayPaneControls,
    family?: FamilyGraphViewModel,
  ) {
    this.selectedNodeId = firstSelection(view);
    if (family) this.ingestFamilyModel(family);
  }

  get replayState(): ReplayPaneState | undefined {
    return this.replay;
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

  update(
    view: GraphViewModel,
    layout: GraphLayout,
    density: GraphDensity,
    replay?: ReplayPaneState,
    family?: FamilyGraphViewModel,
  ): void {
    const densityChanged = density !== this.density;
    this.density = density;
    this.replay = replay;
    if (densityChanged) this.nestedLayouts.clear();

    if (family !== undefined) {
      this.ingestFamilyModel(family);
    }

    // Replay: keep the supplied historical root graph. Do not replace it with a
    // live family member graph. Family chrome is hidden while replay is active.
    if (this.replay) {
      this.view = view;
      this.layout = layout;
    } else if (this.family) {
      this.applyFamilyFocusToPrimaryView();
    } else {
      this.view = view;
      this.layout = layout;
    }

    if (!this.selectedNodeId || !this.view.nodes.some((node) => node.id === this.selectedNodeId)) {
      this.selectedNodeId = firstSelection(this.view);
    }
    this.ensureSelectedVisible();
    this.invalidate();
  }

  /**
   * Replace or clear the companion family view.
   * Clearing does not invent a graph. The controller must refresh the root view.
   * Does not merge child graphs into a parent definition.
   */
  setFamily(family: FamilyGraphViewModel | undefined): void {
    if (!family) {
      this.clearFamilyLocalState();
      this.invalidate();
      return;
    }
    this.ingestFamilyModel(family);
    if (!this.replay) this.applyFamilyFocusToPrimaryView();
    this.invalidate();
  }

  /** Test helper: current family focus goal. */
  get familyFocusGoalIdForTest(): string | undefined {
    return this.familyFocusGoalId;
  }

  /** Test helper: whether a member is expanded in the UI model. */
  isFamilyMemberExpandedForTest(goalId: string): boolean {
    return this.expandedMemberGoalIds.has(goalId)
      || this.family?.members.find((member) => member.goalId === goalId)?.expanded === true;
  }

  /** Test helper: primary workflow identity currently rendered. */
  get primaryWorkflowIdForTest(): string {
    return this.view.workflowId;
  }

  /** Test helper: primary workflow title currently rendered. */
  get primaryTitleForTest(): string {
    return this.view.title;
  }

  /** Test helper: whether family chrome is bound. */
  get hasFamilyForTest(): boolean {
    return this.family !== undefined;
  }

  /** Test helper: whether replay mode is active. */
  get isReplayForTest(): boolean {
    return this.replay !== undefined;
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
    if (data === "," || data === "<") {
      this.replayControls.step(-1);
      return;
    }
    if (data === "." || data === ">") {
      this.replayControls.step(1);
      return;
    }
    if (data === "t") {
      if (this.replay) this.replayControls.clear();
      else this.replayControls.enter();
      return;
    }
    if (data === "L") {
      this.replayControls.clear();
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
    // Family navigation is live-only. Replay keeps the historical root graph.
    if (this.family && this.replay === undefined) {
      if (data === "x" || data === "X") {
        this.toggleFocusedMemberExpanded();
        return;
      }
      if (data === "]" || data === "n") {
        this.cycleFamilyFocus(1);
        return;
      }
      if (data === "[" || data === "p") {
        this.cycleFamilyFocus(-1);
        return;
      }
      if (data === "0") {
        this.focusFamilyMember(this.family.rootGoalId);
        return;
      }
      if (matchesKey(data, "pageUp")) {
        this.familyChromeScroll = Math.max(0, this.familyChromeScroll - 1);
        this.invalidate();
        return;
      }
      if (matchesKey(data, "pageDown")) {
        this.familyChromeScroll += 1;
        this.invalidate();
        return;
      }
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
    const replayLines = this.renderReplaySummary(innerWidth);
    // Frame chrome: top, header, status, help, bottom = 5. Graph height is computed after
    // family chrome and nested sections fit inside availableHeight.
    const fixedChrome = 5 + goalLines.length + detailLines.length + replayLines.length;
    const remainingAfterFixed = Math.max(MIN_PRIMARY_GRAPH_HEIGHT + 2, availableHeight - fixedChrome);

    // During replay, hide live family chrome so the primary graph is historical only.
    const showFamily = this.family !== undefined && this.replay === undefined;
    const nestedCandidates = showFamily ? this.expandedNonFocusedMembers() : [];
    const nestedBudgetCap = nestedCandidates.length > 0
      ? Math.min(
        nestedCandidates.length * (MAX_NESTED_GRAPH_HEIGHT + 1),
        Math.max(0, remainingAfterFixed - MIN_PRIMARY_GRAPH_HEIGHT - 2),
      )
      : 0;
    const familyChromeBudget = showFamily
      ? Math.min(
        MAX_FAMILY_CHROME_LINES,
        Math.max(3, remainingAfterFixed - MIN_PRIMARY_GRAPH_HEIGHT - nestedBudgetCap),
      )
      : 0;
    const familyLines = showFamily ? this.renderFamilySummary(innerWidth, familyChromeBudget) : [];

    const spaceForGraphs = Math.max(MIN_PRIMARY_GRAPH_HEIGHT, remainingAfterFixed - familyLines.length);
    const nestedLines = showFamily
      ? this.renderNestedMemberGraphs(innerWidth, spaceForGraphs - MIN_PRIMARY_GRAPH_HEIGHT)
      : [];
    const graphHeight = Math.max(MIN_PRIMARY_GRAPH_HEIGHT, spaceForGraphs - nestedLines.length);
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
    const focusGoal = showFamily
      ? (this.familyFocusGoalId ?? this.family?.focusedGoalId)
      : undefined;
    const header = `${this.view.phase} · r${this.view.revision} · e${this.view.sequence}`
      + (focusGoal ? ` · member ${focusGoal}` : "");
    const title = this.replay ? `Hypagraph replay · ${this.view.title}` : `Hypagraph · ${this.view.title}`;
    const lines = [frameLine(this.theme, "╭", "─", "╮", paneWidth, title), row(` ${header}`)];
    for (const line of replayLines) lines.push(row(line));
    for (const line of familyLines) lines.push(row(line));
    for (const line of goalLines) lines.push(row(line));
    for (const line of graphLines) lines.push(row(line));
    for (const line of nestedLines) lines.push(row(line));
    for (const line of detailLines) lines.push(row(line));
    const focusText = this.focused ? "navigation" : "passive";
    const mode = this.replay ? `replay e${this.replay.sequence}/${this.replay.liveSequence}` : "live";
    lines.push(row(` ${selected?.id ?? "no node"} · ${focusText} · ${this.density} · ${mode}`));
    lines.push(row(
      " arrows/hjkl move · Enter details · Home active · r ready"
      + (showFamily ? " · x expand · ]/[ focus · 0 root" : "")
      + " · ,/. replay · t replay · L live · +/- density · Esc release · q close",
    ));
    lines.push(frameLine(this.theme, "╰", "─", "╯", paneWidth));
    // Hard cap: never exceed availableHeight + frame border rows outside the budget math.
    // The frame top/bottom are inside the returned lines; truncate if a calculation slipped.
    const maxTotal = availableHeight + 2;
    if (lines.length > maxTotal) {
      return [...lines.slice(0, maxTotal - 1), frameLine(this.theme, "╰", "─", "╯", paneWidth)];
    }
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

  private renderReplaySummary(width: number): string[] {
    const replay = this.replay;
    if (!replay) return [];
    const lines = [
      ` REPLAY event ${replay.sequence} of ${replay.liveSequence} · ${replay.entry.type}${replay.entry.redacted ? " · protected" : ""}`,
      ` ${sanitizeTerminalText(replay.entry.summary)}`,
      ...replay.differenceLines.map((line) => ` ${sanitizeTerminalText(line)}`),
      " Replay reads stored events only. It changes no canonical state.",
    ];
    return lines.map((line) => truncateToWidth(line, width, "…", true));
  }

  private renderFamilySummary(width: number, maxLines: number): string[] {
    if (!this.family) return [];
    return familyGraphSummaryLines(this.family, width, {
      maxLines,
      scrollOffset: this.familyChromeScroll,
    });
  }

  private clearFamilyLocalState(): void {
    this.family = undefined;
    this.familyFocusGoalId = undefined;
    this.boundFamilyId = undefined;
    this.expandedMemberGoalIds.clear();
    this.familyChromeScroll = 0;
    this.nestedLayouts.clear();
  }

  /**
   * Ingest a product family projection while preserving local expand/focus state
   * for the same familyId. Reset local state when the family identity changes.
   */
  private ingestFamilyModel(family: FamilyGraphViewModel): void {
    if (this.boundFamilyId !== family.familyId) {
      this.boundFamilyId = family.familyId;
      this.expandedMemberGoalIds = new Set(
        family.members.filter((member) => member.expanded).map((member) => member.goalId),
      );
      this.familyFocusGoalId = family.focusedGoalId;
      this.familyChromeScroll = 0;
    } else if (
      this.familyFocusGoalId === undefined
      || !family.members.some((member) => member.goalId === this.familyFocusGoalId)
    ) {
      this.familyFocusGoalId = family.focusedGoalId;
    }
    // Drop expand entries for members that no longer exist.
    for (const goalId of [...this.expandedMemberGoalIds]) {
      if (!family.members.some((member) => member.goalId === goalId)) {
        this.expandedMemberGoalIds.delete(goalId);
      }
    }
    // Root stays expanded for chrome defaults.
    this.expandedMemberGoalIds.add(family.rootGoalId);
    const focusId = this.familyFocusGoalId ?? family.focusedGoalId;
    const members = family.members.map((member) => ({
      ...member,
      expanded: member.depth === 0 || this.expandedMemberGoalIds.has(member.goalId),
      focused: member.goalId === focusId,
    }));
    this.family = {
      ...family,
      focusedGoalId: focusId,
      members,
      ancestry: ancestryFromMembers(members, focusId),
    };
  }

  /**
   * Switch the primary graph to the focused family member without merging graphs.
   * Layout stays per-workflow. Not used during replay.
   * Ancestry is recomputed root → focused when focus changes.
   */
  private applyFamilyFocusToPrimaryView(): void {
    const family = this.family;
    if (!family || this.replay) return;
    const goalId = this.familyFocusGoalId ?? family.focusedGoalId;
    const member = family.members.find((item) => item.goalId === goalId);
    if (!member?.graph) return;
    const members = family.members.map((item) => ({
      ...item,
      expanded: item.depth === 0 || this.expandedMemberGoalIds.has(item.goalId),
      focused: item.goalId === member.goalId,
    }));
    this.family = {
      ...family,
      focusedGoalId: member.goalId,
      members,
      ancestry: ancestryFromMembers(members, member.goalId),
      focusedGraph: member.graph,
    };
    this.view = member.graph;
    const nextKey = graphLayoutKey(this.view);
    const cacheKey = `primary:${member.workflowId}:${this.density}:${nextKey}`;
    const cached = this.nestedLayouts.get(cacheKey);
    if (cached) {
      this.layout = cached;
    } else {
      this.layout = layoutGraph(this.view, { density: this.density });
      this.nestedLayouts.set(cacheKey, this.layout);
    }
    this.selectedNodeId = firstSelection(this.view);
    this.viewportX = 0;
    this.viewportY = 0;
  }

  private focusFamilyMember(goalId: string): void {
    if (!this.family?.members.some((member) => member.goalId === goalId)) return;
    if (this.replay) return;
    this.familyFocusGoalId = goalId;
    this.applyFamilyFocusToPrimaryView();
    this.invalidate();
  }

  private cycleFamilyFocus(direction: 1 | -1): void {
    const family = this.family;
    if (!family || family.members.length === 0 || this.replay) return;
    const ordered = [...family.members].sort(
      (left, right) => left.depth - right.depth || left.goalId.localeCompare(right.goalId),
    );
    const currentId = this.familyFocusGoalId ?? family.focusedGoalId;
    const index = Math.max(0, ordered.findIndex((member) => member.goalId === currentId));
    const next = ordered[(index + direction + ordered.length) % ordered.length]!;
    this.focusFamilyMember(next.goalId);
  }

  private toggleFocusedMemberExpanded(): void {
    const family = this.family;
    if (!family || this.replay) return;
    const goalId = this.familyFocusGoalId ?? family.focusedGoalId;
    if (goalId === family.rootGoalId) {
      this.expandedMemberGoalIds.add(goalId);
      this.invalidate();
      return;
    }
    if (this.expandedMemberGoalIds.has(goalId)) this.expandedMemberGoalIds.delete(goalId);
    else this.expandedMemberGoalIds.add(goalId);
    this.family = {
      ...family,
      members: family.members.map((member) => (
        member.goalId === goalId
          ? { ...member, expanded: this.expandedMemberGoalIds.has(goalId) }
          : {
            ...member,
            expanded: member.depth === 0 || this.expandedMemberGoalIds.has(member.goalId),
          }
      )),
    };
    this.invalidate();
  }

  private expandedNonFocusedMembers(): FamilyMemberBoundaryView[] {
    const family = this.family;
    if (!family || this.replay) return [];
    const focusId = this.familyFocusGoalId ?? family.focusedGoalId;
    return family.members
      .filter((member) => (
        (member.depth === 0 || this.expandedMemberGoalIds.has(member.goalId))
        && member.goalId !== focusId
        && member.graph
      ))
      .sort((left, right) => left.depth - right.depth || left.goalId.localeCompare(right.goalId));
  }

  /**
   * Render expanded non-focused members as separate nested workflow boundaries.
   * Family binding edges stay as chrome text, not definition edges.
   */
  private renderNestedMemberGraphs(width: number, budgetRows: number): string[] {
    if (budgetRows < MIN_NESTED_GRAPH_HEIGHT + 1) return [];
    const members = this.expandedNonFocusedMembers();
    if (members.length === 0) return [];

    const lines: string[] = [];
    let remaining = budgetRows;
    for (const member of members) {
      if (remaining < MIN_NESTED_GRAPH_HEIGHT + 1) {
        const omitted = members.length - members.indexOf(member);
        lines.push(truncateToWidth(
          ` … ${omitted} more expanded nested workflow(s) omitted for height`,
          width,
          "…",
          true,
        ));
        break;
      }
      const header = truncateToWidth(
        ` nested boundary ${member.goalId} · ${member.workflowId}`
          + (member.parentNodeId ? ` ← bind ${member.parentNodeId}` : "")
          + ` · depth ${member.depth}`,
        width,
        "…",
        true,
      );
      lines.push(header);
      remaining -= 1;
      const graph = member.graph!;
      const height = Math.min(MAX_NESTED_GRAPH_HEIGHT, Math.max(MIN_NESTED_GRAPH_HEIGHT, remaining));
      const layoutKey = graphLayoutKey(graph);
      const cacheKey = `nested:${member.workflowId}:compact:${layoutKey}`;
      let nestedLayout = this.nestedLayouts.get(cacheKey);
      if (!nestedLayout) {
        nestedLayout = layoutGraph(graph, { density: "compact" });
        this.nestedLayouts.set(cacheKey, nestedLayout);
      }
      const scene = renderGraphScene(graph, nestedLayout, {
        width,
        height,
        unicode: true,
      });
      lines.push(...scene);
      remaining -= scene.length;
    }
    return lines;
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
    // Derived goal waiting: only when no runnable action remains. Node-local
    // awaiting status still appears on graph nodes while other work runs.
    if (this.view.derivedWaitingForUser) {
      const ids = this.view.awaitingNodeIds.join(", ") || "unknown";
      lines.push(` Waiting for a user response · ${ids}`);
    } else if (this.view.awaitingNodeIds.length > 0) {
      lines.push(` Awaiting response: ${this.view.awaitingNodeIds.join(", ")}`);
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
    if (node.code) {
      details.push(` code=${node.code.status} bridgeCalls=${node.code.bridgeCallCount ?? 0}`);
      if (node.code.error) details.push(` error=${sanitizeTerminalText(node.code.error)}`);
    }
    return details.map((line) => truncateToWidth(line, width, "…", true));
  }
}

export class GraphPaneController {
  private state: HypagraphState | undefined;
  private view: GraphViewModel | undefined;
  private family: FamilyGraphViewModel | undefined;
  private layout: GraphLayout | undefined;
  private layoutKey: string | undefined;
  private component: PiGraphPaneComponent | undefined;
  private handle: OverlayHandle | undefined;
  private openPromise: Promise<void> | undefined;
  private density: GraphDensity = "normal";
  private replaySequence: number | undefined;

  /** The controller reads the stored event stream for replay. It never stores an event. */
  constructor(private readonly readEvents: () => readonly DomainEvent[] = () => []) {}

  get isOpen(): boolean {
    return this.openPromise !== undefined;
  }

  get replaySequenceForTest(): number | undefined {
    return this.replaySequence;
  }

  /** Companion family chrome for nested membership. Does not merge child graphs. */
  get familyViewForTest(): FamilyGraphViewModel | undefined {
    return this.family;
  }

  /** Live/replay root graph identity held by the controller. */
  get primaryWorkflowIdForTest(): string | undefined {
    return this.component?.primaryWorkflowIdForTest ?? this.view?.workflowId;
  }

  get componentForTest(): PiGraphPaneComponent | undefined {
    return this.component;
  }

  update(state: HypagraphState | undefined): void {
    this.state = state === undefined ? undefined : structuredClone(state);
    if (!state) {
      this.view = undefined;
      this.layout = undefined;
      this.layoutKey = undefined;
      this.replaySequence = undefined;
      this.family = undefined;
      this.component?.setFamily(undefined);
      this.component?.finish();
      return;
    }
    this.refresh();
  }

  /**
   * Attach or clear family projection chrome.
   * Clearing restores the live/replay root graph so a replaced root cannot leave
   * a previous member graph on the open pane.
   * Child member graphs stay separate boundaries. They are never merged.
   */
  updateFamily(family: FamilyGraphViewModel | undefined): void {
    if (family === undefined) {
      this.family = undefined;
      this.component?.setFamily(undefined);
      // Restore primary graph from the current live or replayed root state.
      if (this.state) this.refresh();
      return;
    }
    this.family = structuredClone(family);
    this.component?.setFamily(this.family);
  }

  /** Render one stored event. The pane keeps live state unchanged. */
  setReplaySequence(sequence: number | undefined): void {
    this.replaySequence = sequence;
    if (this.state) this.refresh();
  }

  private replayView(): { state: HypagraphState; replay: ReplayPaneState } | undefined {
    const live = this.state;
    const sequence = this.replaySequence;
    if (!live || sequence === undefined) return undefined;
    const events = this.readEvents();
    if (events.length === 0) return undefined;
    try {
      const replay = replayToSequence(events, sequence);
      const comparison = compareReplayWithLive(replay.state, live);
      const differenceLines = comparison.identical
        ? ["No canonical difference from live state."]
        : [
          `Difference: ${comparison.nodes.length} nodes, ${comparison.routes.length} routes, ${comparison.loops.length} loops`,
          `Turns charged after this event: ${comparison.consumedTurnsDelta}; scheduled actions: ${comparison.scheduledActionsDelta}`,
        ];
      return {
        state: replay.state,
        replay: {
          sequence: replay.sequence,
          firstSequence: events[0]!.sequence,
          liveSequence: live.sequence,
          entry: replay.entry,
          differenceLines,
        },
      };
    } catch {
      return undefined;
    }
  }

  private refresh(): void {
    const live = this.state;
    if (!live) return;
    const replayed = this.replayView();
    const rendered = replayed?.state ?? live;
    const view = projectGraphView(rendered);
    // Include density so a density change rebuilds layout for the root view.
    const nextKey = `${this.density}:${graphLayoutKey(view)}`;
    if (!this.layout || this.layoutKey !== nextKey) {
      this.layout = layoutGraph(view, {
        density: this.density,
        ...(this.layout === undefined ? {} : { previous: this.layout }),
      });
      this.layoutKey = nextKey;
    }
    this.view = view;
    // During replay, still pass the family model for later restore, but the
    // component ignores family focus while replay is active.
    this.component?.update(view, this.layout, this.density, replayed?.replay, this.family);
  }

  private replayControls(): ReplayPaneControls {
    return {
      step: (delta: number) => {
        const events = this.readEvents();
        const live = this.state;
        if (!live || events.length === 0) return;
        const first = events[0]!.sequence;
        const current = this.replaySequence ?? live.sequence;
        const next = Math.min(live.sequence, Math.max(first, current + delta));
        this.setReplaySequence(next === live.sequence ? undefined : next);
      },
      enter: () => {
        const events = this.readEvents();
        const live = this.state;
        if (!live || events.length === 0) return;
        this.setReplaySequence(Math.max(events[0]!.sequence, live.sequence - 1));
      },
      clear: () => this.setReplaySequence(undefined),
    };
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
          this.replayControls(),
          this.family,
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
    this.family = undefined;
    this.layout = undefined;
    this.layoutKey = undefined;
  }

  private setDensity(density: GraphDensity): void {
    if (density === this.density) return;
    this.density = density;
    // Rebuild through refresh so replay state and family focus stay consistent.
    // Layout cache keys include density on the controller and the component.
    if (this.state) {
      this.layoutKey = undefined;
      this.refresh();
      return;
    }
    if (!this.view) return;
    this.layout = layoutGraph(this.view, {
      density,
      ...(this.layout === undefined ? {} : { previous: this.layout }),
    });
    this.layoutKey = `${density}:${graphLayoutKey(this.view)}`;
    this.component?.update(this.view, this.layout, density, undefined, this.family);
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
