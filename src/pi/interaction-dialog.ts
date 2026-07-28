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

const ESCAPE = "\u001b";
const DELETE = "\u007f";

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
 * The interaction dialog.
 *
 * The dialog shows one declared question, every declared response, and the
 * runtime rows. It never invents a response and it never publishes a fact. The
 * caller stores the answer through the canonical reducer.
 */
export class InteractionDialogComponent implements Component, Focusable {
  focused = true;
  private index = 0;
  private readonly rows: InteractionDialogRow[];
  private editing: boolean;
  private buffer = "";
  private finished = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly interaction: InteractionDefinition,
    private readonly done: (result: InteractionDialogResult) => void,
  ) {
    this.rows = interactionDialogRows(interaction);
    // An open question needs typed input, so the editor opens at once.
    this.editing = interaction.openAnswer !== undefined;
    const preferred = this.rows.findIndex((row) => row.recommended);
    if (preferred >= 0) this.index = preferred;
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

  render(width: number): string[] {
    const inner = Math.max(20, width - 4);
    const lines: string[] = ["" ];
    for (const line of wrapText(this.interaction.question, inner)) {
      lines.push(`  ${this.theme.fg("accent", line)}`);
    }
    lines.push("");

    if (this.editing) {
      const prompt = this.interaction.openAnswer?.prompt ?? "Type your answer.";
      lines.push(`  ${this.theme.fg("muted", truncateToWidth(prompt, inner, "…"))}`);
      lines.push(`  > ${this.buffer}${CURSOR_MARKER}`);
      lines.push("");
      lines.push(`  ${this.theme.fg("muted", "Enter to submit · Esc to cancel")}`);
      return lines;
    }

    this.rows.forEach((row, position) => {
      if (row.chat) lines.push(`  ${this.theme.fg("border", "─".repeat(Math.min(inner, 40)))}`);
      const selected = position === this.index;
      const text = this.rowText(row, position + 1);
      lines.push(`${selected ? this.theme.fg("accent", "› ") : "  "}${selected ? this.theme.fg("accent", text) : text}`);
      if (row.description) {
        for (const line of wrapText(row.description, Math.max(10, inner - 5))) {
          lines.push(`     ${this.theme.fg("muted", line)}`);
        }
      }
    });

    lines.push("");
    lines.push(`  ${this.theme.fg("muted", "Enter to select · ↑/↓ to navigate · Esc to cancel")}`);
    return lines;
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
