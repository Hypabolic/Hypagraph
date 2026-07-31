/**
 * Post-create graph review dock.
 *
 * After a successful interactive hypagoal_start, the TUI presents this bottom
 * dock so the user can choose Run, Question, or Cancel before autonomous work.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { HypagraphState } from "../domain/model.js";
import { projectMermaidFlowchart } from "../graph/mermaid-projection.js";
import { projectGraphView } from "../graph/projection.js";
import { hypagoalReadyWork } from "./hypagoal.js";
import { renderMermaidArt } from "../ui/mermaid-art.js";

/** User choice from the post-create dock. */
export type PostCreateDockResult =
  | { kind: "run" }
  | { kind: "question" }
  | { kind: "cancel" };

/** One selectable action row. */
export interface PostCreateDockRow {
  kind: "run" | "question" | "cancel";
  label: string;
  recommended: boolean;
}

/** Metadata lines under the diagram. */
export interface PostCreateDockMeta {
  title: string;
  objective: string;
  readySummary: string;
  loopSummary: string;
  budgetSummary: string;
}

/** Optional render budget for the bottom dock. */
export interface PostCreateDockOptions {
  /**
   * Maximum lines the component may return from render.
   *
   * When set, the dock keeps action rows and key help visible and trims diagram
   * art first. Host clipping keeps the head; without a budget, tall art is lost.
   */
  maxContentLines?: number;
  /** Maximum columns for Mermaid art. Default uses render width. */
  artMaxWidth?: number;
}

const KEY_HELP = "Enter · ↑/↓ · Esc = Question (safe dismiss) · 1 Run · 2 Question · 3 Cancel";
/** Blank separator + key-help footer. */
const FOOTER_LINE_COUNT = 2;

export const POST_CREATE_DOCK_ROWS: readonly PostCreateDockRow[] = [
  { kind: "run", label: "Run", recommended: true },
  { kind: "question", label: "Question", recommended: false },
  { kind: "cancel", label: "Cancel", recommended: false },
];

/**
 * Build compact metadata for the dock from durable state.
 */
export function postCreateDockMeta(state: HypagraphState): PostCreateDockMeta {
  const ready = hypagoalReadyWork(state);
  const readyParts: string[] = [];
  if (ready.tasks.length > 0) readyParts.push(`tasks ${ready.tasks.join(", ")}`);
  if (ready.checks.length > 0) readyParts.push(`checks ${ready.checks.join(", ")}`);
  if (ready.codes.length > 0) readyParts.push(`code ${ready.codes.join(", ")}`);
  if (ready.effects.length > 0) readyParts.push(`effects ${ready.effects.join(", ")}`);
  if (ready.gates.length > 0) readyParts.push(`gates ${ready.gates.join(", ")}`);
  if (ready.interactions.length > 0) readyParts.push(`interactions ${ready.interactions.join(", ")}`);
  if (ready.loopEntries.length > 0) readyParts.push(`loop entries ${ready.loopEntries.join(", ")}`);

  const loopCount = state.definition.loops.length;
  const turns = state.goal?.budget.limits.maximumTurns;
  const tokens = state.goal?.budget.limits.maximumTokens;
  const budgetParts: string[] = [];
  if (turns !== undefined) budgetParts.push(`turns ${state.goal?.budget.consumedTurns ?? 0}/${turns}`);
  if (tokens !== undefined) {
    budgetParts.push(`tokens ${state.goal?.budget.consumedTokens.totalTokens ?? 0}/${tokens}`);
  }

  return {
    title: state.definition.title,
    objective: state.definition.goal,
    readySummary: readyParts.length > 0 ? readyParts.join("; ") : "none",
    loopSummary: loopCount === 0 ? "none" : String(loopCount),
    budgetSummary: budgetParts.length > 0 ? budgetParts.join("; ") : "unlimited",
  };
}

/**
 * Project Mermaid and render Unicode art for the post-create dock.
 *
 * Returns plain lines. ANSI theming is optional for future polish.
 */
export function postCreateDiagramLines(
  state: HypagraphState,
  maxWidth: number,
): { lines: string[]; source: string; mode: string } {
  const view = projectGraphView(state);
  const projection = projectMermaidFlowchart(view);
  const art = renderMermaidArt(projection.source, {
    maxWidth: Math.max(20, maxWidth),
    preferSourceBox: true,
  });
  return {
    lines: art.lines,
    source: projection.source,
    mode: art.mode,
  };
}

/**
 * Whether this host can present the post-create bottom dock.
 *
 * Headless and RPC hosts without custom UI use auto-continue instead.
 */
export function hostSupportsPostCreateDock(ctx: {
  hasUI?: boolean;
  mode?: string;
  ui?: { custom?: unknown };
}): boolean {
  return ctx.hasUI === true
    && ctx.mode === "tui"
    && typeof ctx.ui?.custom === "function";
}

/**
 * The post-create review dock.
 *
 * Run is recommended and preselected. Esc maps to Question (safe dismiss).
 * Cancel requires the Cancel row or digit 3.
 */
export class PostCreateDockComponent implements Component, Focusable {
  focused = true;
  private index = 0;
  private finished = false;
  private readonly rows = POST_CREATE_DOCK_ROWS;
  private readonly maxContentLines: number | undefined;
  private readonly diagramLines: string[];
  private readonly meta: PostCreateDockMeta;
  private readonly diagramTruncated: boolean;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    state: HypagraphState,
    private readonly done: (result: PostCreateDockResult) => void,
    options: PostCreateDockOptions = {},
  ) {
    this.maxContentLines = options.maxContentLines;
    const preferred = this.rows.findIndex((row) => row.recommended);
    if (preferred >= 0) this.index = preferred;
    this.meta = postCreateDockMeta(state);

    const artWidth = options.artMaxWidth
      ?? (typeof this.tui.terminal?.columns === "number"
        ? Math.max(20, this.tui.terminal.columns - 4)
        : 76);
    const diagram = postCreateDiagramLines(state, artWidth);
    // Cap stored art so a huge graph does not keep thousands of lines in memory.
    const maxStored = 80;
    if (diagram.lines.length > maxStored) {
      this.diagramLines = diagram.lines.slice(0, maxStored);
      this.diagramTruncated = true;
    } else {
      this.diagramLines = diagram.lines;
      this.diagramTruncated = false;
    }
  }

  private finish(result: PostCreateDockResult): void {
    if (this.finished) return;
    this.finished = true;
    this.done(result);
  }

  invalidate(): void {}

  private rowText(row: PostCreateDockRow, position: number): string {
    const marked = row.recommended ? `${row.label} (Recommended)` : row.label;
    return `${position}. ${marked}`;
  }

  render(width: number): string[] {
    const inner = Math.max(20, width - 4);
    const footer = ["", `  ${this.theme.fg("muted", KEY_HELP)}`];
    const header = this.headerLines(width, inner);
    const actions = this.rows.map((row, position) => {
      const selected = position === this.index;
      const text = this.rowText(row, position + 1);
      return `${selected ? this.theme.fg("accent", "› ") : "  "}${
        selected ? this.theme.fg("accent", text) : text
      }`;
    });

    if (this.maxContentLines === undefined) {
      return [...header, ...actions, ...footer];
    }

    const max = Math.max(FOOTER_LINE_COUNT + this.rows.length + 1, this.maxContentLines);
    // Required: footer + all three action rows (always few).
    let room = max - footer.length - actions.length;
    if (room < 1) {
      // Pathological budget: keep selected action + help.
      const selected = actions[this.index] ?? actions[0]!;
      return [selected, footer[footer.length - 1]!].slice(0, max);
    }

    const fittedHeader = this.fitHeader(header, room);
    return [...fittedHeader, ...actions, ...footer].slice(0, max);
  }

  private headerLines(width: number, inner: number): string[] {
    const lines: string[] = [
      this.theme.fg("border", "─".repeat(Math.max(1, width))),
      `  ${this.theme.fg("accent", truncateToWidth(`Hypagoal created · ${this.meta.title}`, inner, "…"))}`,
      `  ${this.theme.fg("muted", truncateToWidth(this.meta.objective, inner, "…"))}`,
      "",
    ];

    for (const artLine of this.diagramLines) {
      lines.push(`  ${artLine}`);
    }
    if (this.diagramTruncated) {
      lines.push(`  ${this.theme.fg("muted", "… diagram truncated")}`);
    }

    lines.push("");
    lines.push(`  ${this.theme.fg("muted", truncateToWidth(`Ready: ${this.meta.readySummary}`, inner, "…"))}`);
    lines.push(`  ${this.theme.fg("muted", truncateToWidth(`Loops: ${this.meta.loopSummary}`, inner, "…"))}`);
    lines.push(`  ${this.theme.fg("muted", truncateToWidth(`Budget: ${this.meta.budgetSummary}`, inner, "…"))}`);
    lines.push("");
    return lines;
  }

  /**
   * Fit header under a line budget.
   *
   * Prefer: border, title, meta lines, and a short art window from the top.
   * Drop art first when space is tight. Keep at least title when possible.
   */
  private fitHeader(header: string[], budget: number): string[] {
    if (budget <= 0) return [];
    if (header.length <= budget) return header;

    // Structure: [border, title, objective, blank, ...art..., blank?, ready, loops, budget, blank]
    // When over budget, drop art lines from the end of the art block first.
    const border = header[0]!;
    const title = header[1]!;
    const objective = header[2]!;
    const blankAfterObjective = header[3] ?? "";

    // Find trailing meta block: Ready / Loops / Budget / blank.
    // Walk from the end.
    const trailing: string[] = [];
    let cursor = header.length - 1;
    // trailing blank
    if (cursor >= 0) {
      trailing.unshift(header[cursor]!);
      cursor -= 1;
    }
    // budget, loops, ready
    for (let i = 0; i < 3 && cursor >= 0; i += 1) {
      trailing.unshift(header[cursor]!);
      cursor -= 1;
    }
    // blank before meta (optional)
    if (cursor >= 4 && (header[cursor] === "" || header[cursor]?.trim() === "")) {
      trailing.unshift(header[cursor]!);
      cursor -= 1;
    }

    const art = header.slice(4, cursor + 1);
    const fixedPrefix = [border, title, objective, blankAfterObjective];
    const fixedCost = fixedPrefix.length + trailing.length;

    if (fixedCost >= budget) {
      // Keep border + title + as much trailing as fits after required rows.
      const kept: string[] = [border, title];
      const room = budget - kept.length;
      if (room > 0) kept.push(...trailing.slice(Math.max(0, trailing.length - room)));
      return kept.slice(0, budget);
    }

    const artBudget = budget - fixedCost;
    let artWindow = art.slice(0, Math.max(0, artBudget));
    if (art.length > artWindow.length && artBudget > 0) {
      // Replace last art line with truncation note when clipped.
      if (artWindow.length === 0) {
        artWindow = [`  ${this.theme.fg("muted", "… diagram truncated")}`];
      } else {
        artWindow = [
          ...artWindow.slice(0, Math.max(0, artWindow.length - 1)),
          `  ${this.theme.fg("muted", "… diagram truncated")}`,
        ];
      }
      // If note made us one over, trim again.
      if (fixedPrefix.length + artWindow.length + trailing.length > budget) {
        artWindow = artWindow.slice(0, Math.max(0, artBudget));
      }
    }

    return [...fixedPrefix, ...artWindow, ...trailing].slice(0, budget);
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, "up")) this.move(-1);
    else if (matchesKey(data, "down")) this.move(1);
    else if (matchesKey(data, "escape")) this.finish({ kind: "question" });
    else if (matchesKey(data, "return")) this.select();
    else if (data === "1") this.finish({ kind: "run" });
    else if (data === "2") this.finish({ kind: "question" });
    else if (data === "3") this.finish({ kind: "cancel" });
    this.tui.requestRender();
  }

  private move(delta: number): void {
    const count = this.rows.length;
    this.index = (this.index + delta + count) % count;
  }

  private select(): void {
    const row = this.rows[this.index];
    if (!row) return;
    this.finish({ kind: row.kind });
  }
}


