import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { InteractionDefinition } from "../domain/model.js";

/** What the person chose in the dialog. */
export type InteractionDialogResult =
  | { kind: "response"; responseId: string }
  | { kind: "open"; openText: string }
  | { kind: "chat" }
  | { kind: "cancelled" };

/** One selectable row. */
export interface InteractionDialogRow {
  /** The row publishes this response. A runtime row has no response. */
  responseId?: string;
  label: string;
  description?: string;
  recommended: boolean;
  /** The row ends the dialog and returns to the conversation. */
  chat?: boolean;
}

/** Optional render budget for the bottom dock. */
export interface InteractionDialogOptions {
  /**
   * Maximum lines the component may return from render.
   *
   * When the dock host clips by maxHeight, the component must already keep the
   * selected option label and key help inside this budget so keyboard selection stays visible.
   */
  maxContentLines?: number;
}

const ESCAPE = "\u001b";
const DELETE = "\u007f";
const KEY_HELP_CLOSED = "Enter to select · ↑/↓ to navigate · Esc to cancel";
const KEY_HELP_OPEN = "Enter to submit · Esc to cancel";
/** Lines reserved for blank separator + key-help footer. */
const FOOTER_LINE_COUNT = 2;

const isPrintable = (data: string): boolean =>
  data.length > 0 && !data.startsWith(ESCAPE) && [...data].every((character) => character >= " " && character !== DELETE);

const wrapText = (text: string, width: number): string[] => {
  if (width <= 0) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [""];
};

/**
 * Build every dialog row for a closed question.
 *
 * The declared responses come first, in declaration order. The chat row always
 * appears last, because it always ends the dialog without an answer. An open
 * question has no rows. The person types the answer.
 */
export function interactionDialogRows(interaction: InteractionDefinition): InteractionDialogRow[] {
  const rows: InteractionDialogRow[] = (interaction.responses ?? []).map((response) => ({
    responseId: response.id,
    label: response.label,
    ...(response.description === undefined ? {} : { description: response.description }),
    recommended: response.recommended === true,
  }));
  rows.push({ label: "Chat about this", recommended: false, chat: true });
  return rows;
}

/**
 * Choose a contiguous option window that includes the selected index and fits
 * the line budget. Heights are label-core heights (no description). Expand down first, then up.
 */
export function optionWindowForSelection(
  optionHeights: number[],
  selectedIndex: number,
  lineBudget: number,
): { start: number; end: number } {
  const count = optionHeights.length;
  if (count === 0 || lineBudget <= 0) return { start: 0, end: 0 };

  const index = Math.max(0, Math.min(selectedIndex, count - 1));
  let start = index;
  let end = index + 1;
  let used = optionHeights[index] ?? 1;

  // If the selected core alone exceeds the budget, still show it alone.
  if (used > lineBudget) return { start, end };

  let expanded = true;
  while (expanded) {
    expanded = false;
    if (end < count) {
      const next = optionHeights[end] ?? 1;
      if (used + next <= lineBudget) {
        used += next;
        end += 1;
        expanded = true;
        continue;
      }
    }
    if (start > 0) {
      const prev = optionHeights[start - 1] ?? 1;
      if (used + prev <= lineBudget) {
        used += prev;
        start -= 1;
        expanded = true;
      }
    }
  }

  return { start, end };
}

/**
 * The interaction dialog.
 *
 * The dialog shows one declared question, every declared response, and the
 * runtime rows. It never invents a response and it never publishes a fact. The
 * caller stores the answer through the canonical reducer.
 *
 * When maxContentLines is set, option lists window around the selection so the
 * selected label and key help stay visible under a clipped bottom dock.
 */
export class InteractionDialogComponent implements Component, Focusable {
  focused = true;
  private index = 0;
  private readonly rows: InteractionDialogRow[];
  private editing: boolean;
  private buffer = "";
  private finished = false;
  private readonly maxContentLines: number | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly interaction: InteractionDefinition,
    private readonly done: (result: InteractionDialogResult) => void,
    options: InteractionDialogOptions = {},
  ) {
    this.rows = interactionDialogRows(interaction);
    // An open question needs typed input, so the editor opens at once.
    this.editing = interaction.openAnswer !== undefined;
    const preferred = this.rows.findIndex((row) => row.recommended);
    if (preferred >= 0) this.index = preferred;
    this.maxContentLines = options.maxContentLines;
  }

  private finish(result: InteractionDialogResult): void {
    if (this.finished) return;
    this.finished = true;
    this.done(result);
  }

  /** The dialog renders from its own state only. It caches nothing. */
  invalidate(): void {}

  private rowText(row: InteractionDialogRow, position: number): string {
    const marked = row.recommended ? `${row.label} (Recommended)` : row.label;
    return `${position}. ${marked}`;
  }

  /** Label core: optional chat separator + selected/unselected label line. */
  private optionCoreLines(row: InteractionDialogRow, position: number, inner: number): string[] {
    const lines: string[] = [];
    if (row.chat) lines.push(`  ${this.theme.fg("border", "─".repeat(Math.min(inner, 40)))}`);
    const selected = position - 1 === this.index;
    const text = this.rowText(row, position);
    lines.push(`${selected ? this.theme.fg("accent", "› ") : "  "}${selected ? this.theme.fg("accent", text) : text}`);
    return lines;
  }

  private optionDescriptionLines(row: InteractionDialogRow, inner: number): string[] {
    if (!row.description) return [];
    return wrapText(row.description, Math.max(10, inner - 5)).map(
      (line) => `     ${this.theme.fg("muted", line)}`,
    );
  }

  private optionCoreHeight(row: InteractionDialogRow): number {
    return row.chat ? 2 : 1;
  }

  render(width: number): string[] {
    const inner = Math.max(20, width - 4);
    if (this.editing) return this.renderOpen(width, inner);
    return this.renderClosed(width, inner);
  }

  private renderOpen(width: number, inner: number): string[] {
    const footer = ["", `  ${this.theme.fg("muted", KEY_HELP_OPEN)}`];
    const header = this.headerLines(width, inner);
    const body = [
      `  ${this.theme.fg("muted", truncateToWidth(this.interaction.openAnswer?.prompt ?? "Type your answer.", inner, "…"))}`,
      `  > ${this.buffer}${CURSOR_MARKER}`,
    ];
    if (this.maxContentLines === undefined) return [...header, ...body, ...footer];

    const max = Math.max(FOOTER_LINE_COUNT + 1, this.maxContentLines);
    // Keep footer and input line; trim header then prompt.
    const inputLine = body[1]!;
    let room = max - footer.length - 1;
    const fittedHeader = this.fitHeaderFromTop(header, Math.max(0, room - 1));
    room -= fittedHeader.length;
    const prompt = room > 0 ? [body[0]!] : [];
    return [...fittedHeader, ...prompt, inputLine, ...footer].slice(0, max);
  }

  /**
   * Closed list layout under an optional line budget.
   *
   * Always keep: key help footer + selected option label (› marker).
   * Drop first: indicators, other options, selected description (end first),
   * then question wrap lines.
   */
  private renderClosed(width: number, inner: number): string[] {
    const footer = ["", `  ${this.theme.fg("muted", KEY_HELP_CLOSED)}`];
    const fullHeader = this.headerLines(width, inner);
    const selected = this.rows[this.index];
    if (!selected) return [...fullHeader, ...footer];

    const selectedCore = this.optionCoreLines(selected, this.index + 1, inner);
    const selectedDesc = this.optionDescriptionLines(selected, inner);

    if (this.maxContentLines === undefined) {
      const body = this.rows.flatMap((row, position) => [
        ...this.optionCoreLines(row, position + 1, inner),
        ...this.optionDescriptionLines(row, inner),
      ]);
      return [...fullHeader, ...body, ...footer];
    }

    const max = Math.max(FOOTER_LINE_COUNT + 1, this.maxContentLines);

    // Required: selected label line (and chat separator when present if it fits).
    // Always keep the label line with the › marker.
    const labelLine = selectedCore[selectedCore.length - 1]!;
    const chatSep = selectedCore.length > 1 ? selectedCore[0] : undefined;

    // Budget after non-negotiable footer + selected label.
    let room = max - footer.length - 1;
    if (room < 0) {
      // Pathological maxContentLines < 3: still emit label + help.
      return [labelLine, footer[footer.length - 1]!];
    }

    // Optional chat separator before the label when room allows.
    const corePrefix: string[] = [];
    if (chatSep !== undefined && room > 0) {
      corePrefix.push(chatSep);
      room -= 1;
    }

    // Question header next (higher priority than description / neighbors).
    const header = this.fitHeaderFromTop(fullHeader, room);
    room -= header.length;

    // Neighbor option cores (no descriptions) using remaining room.
    const coreHeights = this.rows.map((row) => this.optionCoreHeight(row));
    // Window only counts neighbor cores; selected already reserved.
    const { start, end } = optionWindowForSelection(
      coreHeights.map((height, index) => (index === this.index ? 0 : height)),
      this.index,
      room,
    );

    const aboveCores: string[] = [];
    for (let position = start; position < this.index; position += 1) {
      const row = this.rows[position];
      if (row) aboveCores.push(...this.optionCoreLines(row, position + 1, inner));
    }
    const belowCores: string[] = [];
    for (let position = this.index + 1; position < end; position += 1) {
      const row = this.rows[position];
      if (row) belowCores.push(...this.optionCoreLines(row, position + 1, inner));
    }

    // Fit below first, then above (closest to selection kept when trimming above).
    const belowFitted: string[] = [];
    for (const line of belowCores) {
      if (room <= 0) break;
      belowFitted.push(line);
      room -= 1;
    }
    const aboveFitted: string[] = [];
    for (let i = aboveCores.length - 1; i >= 0 && room > 0; i -= 1) {
      aboveFitted.unshift(aboveCores[i]!);
      room -= 1;
    }

    // Selected description: keep leading wrap lines; drop trailing lines first.
    const descFitted: string[] = [];
    for (const line of selectedDesc) {
      if (room <= 0) break;
      descFitted.push(line);
      room -= 1;
    }

    // Indicators last; steal from description end, then far neighbors, if needed.
    const hasMoreAbove = start > 0;
    const hasMoreBelow = end < this.rows.length;
    let indicatorAbove: string | undefined;
    let indicatorBelow: string | undefined;

    const stealOneLine = (): boolean => {
      if (room > 0) {
        room -= 1;
        return true;
      }
      if (descFitted.length > 0) {
        descFitted.pop();
        return true;
      }
      if (aboveFitted.length > 0) {
        aboveFitted.shift();
        return true;
      }
      if (belowFitted.length > 0) {
        belowFitted.pop();
        return true;
      }
      return false;
    };

    if (hasMoreAbove && stealOneLine()) {
      indicatorAbove = `  ${this.theme.fg("muted", "… more above")}`;
    }
    if (hasMoreBelow && stealOneLine()) {
      indicatorBelow = `  ${this.theme.fg("muted", "… more below")}`;
    }

    const lines: string[] = [
      ...header,
      ...(indicatorAbove ? [indicatorAbove] : []),
      ...aboveFitted,
      ...corePrefix,
      labelLine,
      ...descFitted,
      ...belowFitted,
      ...(indicatorBelow ? [indicatorBelow] : []),
      ...footer,
    ];

    // Final safety: if we still overflow, drop from the top of the header only.
    // Never drop the selected label or footer.
    if (lines.length <= max) return lines;
    const overflow = lines.length - max;
    const headerCount = header.length;
    if (overflow <= headerCount) {
      return lines.slice(overflow);
    }
    // Drop entire header, then anything before the label except we must keep label+footer.
    const labelIndex = lines.indexOf(labelLine);
    const keptFromLabel = lines.slice(labelIndex);
    if (keptFromLabel.length <= max) {
      // Prepend as many post-header body lines as fit before the label.
      const beforeLabel = lines.slice(headerCount, labelIndex);
      const roomBefore = max - keptFromLabel.length;
      const prefix = beforeLabel.slice(Math.max(0, beforeLabel.length - roomBefore));
      return [...prefix, ...keptFromLabel];
    }
    // Keep label + trailing lines (description may go) + footer end.
    return [labelLine, ...footer].slice(0, max);
  }

  private headerLines(width: number, inner: number): string[] {
    const header: string[] = [
      this.theme.fg("border", "─".repeat(Math.max(1, width))),
    ];
    for (const line of wrapText(this.interaction.question, inner)) {
      header.push(`  ${this.theme.fg("accent", line)}`);
    }
    header.push("");
    return header;
  }

  /** Drop header lines from the top until the budget fits. */
  private fitHeaderFromTop(header: string[], budget: number): string[] {
    if (budget <= 0) return [];
    if (header.length <= budget) return header;
    return header.slice(header.length - budget);
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (this.editing) this.handleEditingInput(data);
    else this.handleSelectionInput(data);
    this.tui.requestRender();
  }

  private handleSelectionInput(data: string): void {
    if (matchesKey(data, "up")) this.move(-1);
    else if (matchesKey(data, "down")) this.move(1);
    else if (matchesKey(data, "escape")) this.finish({ kind: "cancelled" });
    else if (matchesKey(data, "return")) this.select();
    else if (/^[1-9]$/.test(data)) {
      const position = Number.parseInt(data, 10) - 1;
      if (position < this.rows.length) {
        this.index = position;
        this.select();
      }
    }
  }

  private handleEditingInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.finish({ kind: "cancelled" });
    } else if (matchesKey(data, "return")) {
      const text = this.buffer.trim();
      if (text.length > 0) this.finish({ kind: "open", openText: text });
    } else if (matchesKey(data, "backspace")) {
      this.buffer = this.buffer.slice(0, -1);
    } else if (isPrintable(data)) {
      const limit = this.interaction.openAnswer?.maxBytes ?? 0;
      const next = `${this.buffer}${data}`;
      if (Buffer.byteLength(next, "utf8") <= limit) this.buffer = next;
    }
  }

  private move(delta: number): void {
    const count = this.rows.length;
    this.index = (this.index + delta + count) % count;
  }

  private select(): void {
    const row = this.rows[this.index];
    if (!row) return;
    if (row.chat) this.finish({ kind: "chat" });
    else if (row.responseId) this.finish({ kind: "response", responseId: row.responseId });
  }
}
