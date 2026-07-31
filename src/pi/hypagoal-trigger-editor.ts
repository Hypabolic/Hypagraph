/**
 * Live Hypagoal trigger highlight for the Pi composer.
 *
 * Paint only. This module does not create goals, write events, or change domain state.
 * Matching tokens use an animated neon rainbow (time-based hue + shimmer).
 */

import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
  findHypagoalTriggerSpans,
  type HypagoalTriggerSettings,
  type TriggerMatchSpan,
} from "./hypagoal-arming.js";

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_UNDERLINE = "\x1b[4m";
const ANSI_ITALIC = "\x1b[3m";

/** Full hue loop period for the scrolling rainbow (ms). */
export const TRIGGER_RAINBOW_PERIOD_MS = 1_100;

/** Shimmer / pulse period (ms). */
export const TRIGGER_SHIMMER_PERIOD_MS = 380;

/** Animation tick rate while a match is visible (~20 fps). */
export const TRIGGER_ANIMATION_INTERVAL_MS = 50;

/** Degrees of hue advance per character (electric band spacing). */
const HUE_PER_CHAR = 42;

/** Optional clock for tests. Production uses Date.now. */
let animationNowMs: () => number = () => Date.now();

/** Test-only: replace the animation clock. Pass undefined to restore Date.now. */
export function configureTriggerAnimationClockForTests(now?: () => number): void {
  animationNowMs = now ?? (() => Date.now());
}

/**
 * Convert HSV (h in [0, 360), s/v in [0, 1]) to 8-bit RGB.
 * Pure helper for neon rainbow paint.
 */
export function hsvToRgb(h: number, s: number, v: number): readonly [number, number, number] {
  const hh = ((h % 360) + 360) % 360;
  const ss = Math.min(1, Math.max(0, s));
  const vv = Math.min(1, Math.max(0, v));
  const c = vv * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = vv - c;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hh < 60) {
    rp = c;
    gp = x;
  } else if (hh < 120) {
    rp = x;
    gp = c;
  } else if (hh < 180) {
    gp = c;
    bp = x;
  } else if (hh < 240) {
    gp = x;
    bp = c;
  } else if (hh < 300) {
    rp = x;
    bp = c;
  } else {
    rp = c;
    bp = x;
  }
  return [
    Math.round((rp + m) * 255),
    Math.round((gp + m) * 255),
    Math.round((bp + m) * 255),
  ];
}

/**
 * Truecolour SGR for one character: bold + italic + underline + neon RGB.
 */
function paintChar(char: string, r: number, g: number, b: number): string {
  return (
    `\x1b[38;2;${r};${g};${b}m`
    + `${ANSI_BOLD}${ANSI_ITALIC}${ANSI_UNDERLINE}${char}`
  );
}

/**
 * Strip CSI SGR sequences and the Pi hardware cursor marker so plain offsets
 * match the buffer coordinate system.
 *
 * Built fresh each call so global lastIndex cannot leak across helpers.
 */
const nonContentPattern = (): RegExp => /\x1b\[[0-9;]*m|\x1b_pi:c\x07/g;

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: unknown) => EditorComponent;

export interface HypagoalTriggerEditorHandle {
  /** Request a repaint so highlight uses the latest trigger settings. */
  refresh: () => void;
  /** Clear factory ownership on session shutdown when the host supports it. */
  dispose: () => void;
}

/** Result of painting rendered editor lines. */
export interface PaintHypagoalTriggerResult {
  lines: string[];
  /**
   * True when expanded paste content would arm but the matching token is not
   * present in the collapsed display text. The paint path colours paste markers.
   */
  armedInCollapsedPaste: boolean;
  /**
   * True when evaluation text arms (visible token or collapsed paste).
   * Drives the animation render loop.
   */
  armed: boolean;
}

/**
 * Whether this host can register a custom composer editor.
 *
 * Headless, RPC, and print hosts skip registration. Submit-time arming still runs.
 */
export function hostSupportsTriggerEditor(ctx: {
  hasUI?: boolean;
  mode?: string;
  ui?: {
    setEditorComponent?: unknown;
    getEditorComponent?: unknown;
  };
}): boolean {
  return ctx.hasUI === true
    && ctx.mode === "tui"
    && typeof ctx.ui?.setEditorComponent === "function";
}

/**
 * Colour one matched token with an animated neon rainbow.
 *
 * - Hue scrolls over time (gen-Y / terminal-core aesthetic).
 * - Per-character hue bands + a traveling brightness shimmer.
 * - Bold, italic, and underline stay as non-colour cues for monochrome hosts.
 *
 * @param text Token text to paint
 * @param nowMs Animation clock (default: live clock). Tests pass a fixed value.
 */
export function colorizeTriggerToken(text: string, nowMs: number = animationNowMs()): string {
  if (text.length === 0) return text;
  const chars = [...text];
  const hueBase = ((nowMs % TRIGGER_RAINBOW_PERIOD_MS) / TRIGGER_RAINBOW_PERIOD_MS) * 360;
  // Soft overall pulse so the word “breathes”.
  const breath = 0.88 + 0.12 * Math.sin((nowMs / TRIGGER_SHIMMER_PERIOD_MS) * Math.PI * 2);
  const painted = chars
    .map((char, index) => {
      // Flow left-to-right: later chars lag in hue.
      const hue = (hueBase + index * HUE_PER_CHAR) % 360;
      // Traveling glitter band across the word.
      const shimmer = 0.82 + 0.18 * Math.sin(
        (nowMs / (TRIGGER_SHIMMER_PERIOD_MS * 0.55)) * Math.PI * 2 - index * 0.95,
      );
      const value = Math.min(1, breath * shimmer);
      // Slightly oversaturated neon (clamp inside hsvToRgb).
      const sat = 0.92 + 0.08 * Math.sin((nowMs / 220) + index);
      const [r, g, b] = hsvToRgb(hue, sat, value);
      return paintChar(char, r, g, b);
    })
    .join("");
  return `${painted}${ANSI_RESET}`;
}

/**
 * Remove SGR and cursor-marker sequences so plain character offsets match the buffer.
 */
export function stripEditorDecorations(text: string): string {
  return text.replace(nonContentPattern(), "");
}

/**
 * Apply exact buffer spans to plain text by UTF-16 indices.
 *
 * Spans must be non-overlapping and within bounds. Order does not matter.
 */
export function applyTriggerSpansToPlainText(
  text: string,
  spans: readonly TriggerMatchSpan[],
  nowMs: number = animationNowMs(),
): string {
  if (spans.length === 0) return text;
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor || span.end > text.length || span.start >= span.end) continue;
    const slice = text.slice(span.start, span.end);
    // Guard against stale spans that no longer match the buffer.
    if (slice !== span.text) continue;
    parts.push(text.slice(cursor, span.start));
    parts.push(colorizeTriggerToken(slice, nowMs));
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/**
 * Map full-buffer spans to per-line column spans.
 */
export function spansToLineLocal(
  bufferText: string,
  spans: readonly TriggerMatchSpan[],
): Array<{ lineIndex: number; start: number; end: number; text: string }> {
  const lineStarts: number[] = [0];
  for (let i = 0; i < bufferText.length; i += 1) {
    if (bufferText[i] === "\n") lineStarts.push(i + 1);
  }
  const result: Array<{ lineIndex: number; start: number; end: number; text: string }> = [];
  for (const span of spans) {
    let lineIndex = 0;
    for (let i = 0; i < lineStarts.length; i += 1) {
      if (lineStarts[i]! <= span.start) lineIndex = i;
      else break;
    }
    const lineStart = lineStarts[lineIndex]!;
    result.push({
      lineIndex,
      start: span.start - lineStart,
      end: span.end - lineStart,
      text: span.text,
    });
  }
  return result;
}

/**
 * Replace one plain segment inside a rendered line (which may hold ANSI) with painted text.
 *
 * Returns null when the plain segment is not present as a contiguous plain run.
 * Only the first occurrence is replaced.
 */
export function replacePlainSegmentInRenderedLine(
  rendered: string,
  plainSegment: string,
  paintedSegment: string,
): string | null {
  if (plainSegment.length === 0) return null;
  if (plainSegment === paintedSegment) return null;

  // Fast path when the line has no decorations.
  if (!rendered.includes("\x1b")) {
    const idx = rendered.indexOf(plainSegment);
    if (idx === -1) return null;
    return rendered.slice(0, idx) + paintedSegment + rendered.slice(idx + plainSegment.length);
  }

  // Walk the rendered string, tracking plain character offsets.
  type Piece = { kind: "ansi" | "text"; value: string };
  const pieces: Piece[] = [];
  let i = 0;
  while (i < rendered.length) {
    if (rendered.startsWith("\x1b_pi:c\x07", i)) {
      pieces.push({ kind: "ansi", value: "\x1b_pi:c\x07" });
      i += "\x1b_pi:c\x07".length;
      continue;
    }
    if (rendered[i] === "\x1b") {
      const csi = rendered.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (csi) {
        pieces.push({ kind: "ansi", value: csi[0] });
        i += csi[0].length;
        continue;
      }
      // Unknown escape: keep as text so we do not drop content.
      pieces.push({ kind: "text", value: rendered[i]! });
      i += 1;
      continue;
    }
    // Consume a run of plain characters.
    let j = i + 1;
    while (j < rendered.length && rendered[j] !== "\x1b") j += 1;
    pieces.push({ kind: "text", value: rendered.slice(i, j) });
    i = j;
  }

  const plain = pieces.filter((p) => p.kind === "text").map((p) => p.value).join("");
  const matchAt = plain.indexOf(plainSegment);
  if (matchAt === -1) return null;
  const matchEnd = matchAt + plainSegment.length;

  // Rebuild: keep ANSI outside the plain range; replace the plain range with paintedSegment.
  let plainCursor = 0;
  let out = "";
  let replaced = false;
  for (const piece of pieces) {
    if (piece.kind === "ansi") {
      // Drop ANSI that sits inside the replaced plain range; keep outer decorations.
      if (plainCursor < matchAt || plainCursor >= matchEnd || !replaced) {
        if (plainCursor <= matchAt || plainCursor >= matchEnd) {
          out += piece.value;
        }
      }
      continue;
    }
    const start = plainCursor;
    const end = plainCursor + piece.value.length;
    plainCursor = end;

    if (end <= matchAt || start >= matchEnd) {
      out += piece.value;
      continue;
    }

    // This text piece overlaps the segment to replace.
    if (start < matchAt) {
      out += piece.value.slice(0, matchAt - start);
    }
    if (!replaced && start <= matchAt && end >= matchAt) {
      out += paintedSegment;
      replaced = true;
    }
    if (end > matchEnd) {
      out += piece.value.slice(matchEnd - start);
    }
  }
  return replaced ? out : null;
}

/**
 * Colour every Pi paste marker in a rendered line.
 *
 * Used when arming comes only from collapsed paste content.
 */
export function colorizePasteMarkersInLine(
  line: string,
  nowMs: number = animationNowMs(),
): string {
  return line.replace(
    /\[paste #\d+( (?:\+\d+ lines|\d+ chars))?\]/g,
    (match) => colorizeTriggerToken(match, nowMs),
  );
}

/**
 * Resolve display text and evaluation text from an editor component.
 *
 * Evaluation prefers `getExpandedText` so large-paste markers match submit arming.
 */
export function resolveEditorEvaluationText(editor: {
  getText: () => string;
  getExpandedText?: () => string;
}): {
  displayText: string;
  evaluationText: string;
  hasCollapsedPaste: boolean;
} {
  const displayText = editor.getText();
  const evaluationText = typeof editor.getExpandedText === "function"
    ? editor.getExpandedText()
    : displayText;
  return {
    displayText,
    evaluationText,
    hasCollapsedPaste: evaluationText !== displayText,
  };
}

/**
 * Paint line-local spans onto one rendered line that shows a wrap chunk of a buffer line.
 *
 * `chunkPlain` is the decoration-stripped content of the rendered line (without side padding).
 * `bufferLine` is the full logical buffer line. `localSpans` are columns into that buffer line.
 * Only spans that fall inside the chunk are painted. Other tokens on other lines are ignored.
 */
export function paintWrapChunkWithLocalSpans(
  rendered: string,
  bufferLine: string,
  localSpans: readonly { start: number; end: number; text: string }[],
  nowMs: number = animationNowMs(),
): string | null {
  const renderedPlain = stripEditorDecorations(rendered);
  // Trim only outer padding spaces that the editor adds around content.
  const leadingPad = renderedPlain.match(/^ */)?.[0].length ?? 0;
  const trailingPad = renderedPlain.match(/ *$/)?.[0].length ?? 0;
  const chunk = trailingPad > 0
    ? renderedPlain.slice(leadingPad, renderedPlain.length - trailingPad)
    : renderedPlain.slice(leadingPad);
  if (chunk.length === 0) return null;

  // Locate this chunk inside the buffer line (word-wrap segment).
  const chunkStart = bufferLine.indexOf(chunk);
  if (chunkStart === -1) return null;
  const chunkEnd = chunkStart + chunk.length;

  const active = localSpans.filter((span) => span.start >= chunkStart && span.end <= chunkEnd);
  if (active.length === 0) return null;

  // Paint relative to the chunk, then put the painted chunk back into the rendered line.
  const relative = active.map((span) => ({
    start: span.start - chunkStart,
    end: span.end - chunkStart,
    text: span.text,
  }));
  const paintedChunk = applyTriggerSpansToPlainText(chunk, relative, nowMs);
  if (paintedChunk === chunk) return null;
  return replacePlainSegmentInRenderedLine(rendered, chunk, paintedChunk);
}

/**
 * Paint matching trigger tokens on rendered editor lines.
 *
 * Decorates only the character ranges from `findHypagoalTriggerSpans` on the
 * evaluation buffer. Does not re-match with an independent regular expression.
 *
 * `bufferText` is the evaluation text (expanded paste when available).
 * `displayText` is the collapsed composer text used to map spans onto lines.
 * When the two differ and only expanded content arms, paste markers are coloured.
 */
export function paintHypagoalTriggerLines(
  lines: readonly string[],
  bufferText: string,
  settings: HypagoalTriggerSettings,
  displayText: string = bufferText,
  nowMs: number = animationNowMs(),
): PaintHypagoalTriggerResult {
  const evaluationSpans = findHypagoalTriggerSpans(bufferText, settings);
  const displaySpans = displayText === bufferText
    ? evaluationSpans
    : findHypagoalTriggerSpans(displayText, settings);

  if (evaluationSpans.length === 0) {
    return { lines: [...lines], armedInCollapsedPaste: false, armed: false };
  }

  const armedInCollapsedPaste = displaySpans.length === 0 && bufferText !== displayText;

  // Paint exact display spans onto buffer lines, then map those lines into render output.
  let result = [...lines];
  if (displaySpans.length > 0) {
    const paintedDisplay = applyTriggerSpansToPlainText(displayText, displaySpans, nowMs);
    const plainLines = displayText.split("\n");
    const paintedLines = paintedDisplay.split("\n");
    const allLocal = spansToLineLocal(displayText, displaySpans);
    const used = new Array(result.length).fill(false);

    for (let lineIndex = 0; lineIndex < plainLines.length; lineIndex += 1) {
      const plain = plainLines[lineIndex]!;
      const painted = paintedLines[lineIndex]!;
      if (plain === painted) continue;

      // Full buffer-line match (common unwrapped case). Exact spans already applied.
      let placed = false;
      for (let j = 0; j < result.length; j += 1) {
        if (used[j]) continue;
        const replaced = replacePlainSegmentInRenderedLine(result[j]!, plain, painted);
        if (replaced !== null) {
          result[j] = replaced;
          used[j] = true;
          placed = true;
          break;
        }
      }
      if (placed) continue;

      // Wrap fallback: map line-local spans onto wrap chunks of this buffer line only.
      const localSpans = allLocal.filter((span) => span.lineIndex === lineIndex);
      if (localSpans.length === 0) continue;
      for (let j = 0; j < result.length; j += 1) {
        if (used[j]) continue;
        const replaced = paintWrapChunkWithLocalSpans(result[j]!, plain, localSpans, nowMs);
        if (replaced !== null) {
          result[j] = replaced;
          used[j] = true;
        }
      }
    }
  }

  // Collapsed paste: evaluation arms but display has no visible token spans.
  // Colour paste markers so the pre-submit signal remains visible.
  if (armedInCollapsedPaste) {
    result = result.map((line) => colorizePasteMarkersInLine(line, nowMs));
  }

  return { lines: result, armedInCollapsedPaste, armed: true };
}

/**
 * Host-side animation driver. Request TUI frames only while a match is painted.
 */
export interface TriggerAnimationDriver {
  /** Called after a paint that shows a live match (or armed paste marker). */
  noteArmed: () => void;
  /** Called after a paint with no match so the loop can stop. */
  noteIdle: () => void;
  /** Stop the interval and drop the TUI handle. */
  dispose: () => void;
  /** Force one render (settings change). */
  requestRender: () => void;
}

/**
 * Create a render loop that keeps the neon rainbow moving while armed.
 *
 * When idle (no match), the interval stops so the TUI is not redrawn for nothing.
 */
export function createTriggerAnimationDriver(
  getTui: () => TUI | undefined,
  intervalMs: number = TRIGGER_ANIMATION_INTERVAL_MS,
): TriggerAnimationDriver {
  let timer: ReturnType<typeof setInterval> | undefined;
  let armed = false;

  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const start = (): void => {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      if (!armed) {
        stop();
        return;
      }
      try {
        getTui()?.requestRender();
      } catch {
        // Hostile TUI must not crash the extension.
        stop();
      }
    }, intervalMs);
    // Unref when available so the timer does not keep a Node process alive alone.
    const handle = timer as { unref?: () => void };
    if (typeof handle.unref === "function") handle.unref();
  };

  return {
    noteArmed: () => {
      armed = true;
      start();
    },
    noteIdle: () => {
      armed = false;
      stop();
    },
    dispose: () => {
      armed = false;
      stop();
    },
    requestRender: () => {
      try {
        getTui()?.requestRender();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Wrap an editor instance so render applies live trigger highlight.
 *
 * Prefers wrapping a previous factory result so Hypagraph cooperates with
 * other extensions when load order permits.
 *
 * Evaluation uses `getExpandedText` when present so large-paste markers keep
 * pre-submit parity with submit arming.
 *
 * When `animation` is supplied, a match keeps a short render loop running so
 * the rainbow scrolls without keystrokes.
 */
export function wrapEditorWithTriggerHighlight(
  editor: EditorComponent,
  getSettings: () => HypagoalTriggerSettings,
  animation?: TriggerAnimationDriver,
): EditorComponent {
  const baseRender = editor.render.bind(editor);
  editor.render = (width: number): string[] => {
    const lines = baseRender(width);
    const { displayText, evaluationText } = resolveEditorEvaluationText(editor);
    const painted = paintHypagoalTriggerLines(
      lines,
      evaluationText,
      getSettings(),
      displayText,
    );
    if (animation) {
      if (painted.armed) animation.noteArmed();
      else animation.noteIdle();
    }
    return painted.lines;
  };
  return editor;
}

/**
 * Build a factory that wraps the previous factory or the stock CustomEditor.
 */
export function createHypagoalTriggerEditorFactory(
  previous: EditorFactory | undefined,
  getSettings: () => HypagoalTriggerSettings,
  animation?: TriggerAnimationDriver,
): EditorFactory {
  return (tui, theme, keybindings) => {
    const base = previous
      ? previous(tui, theme, keybindings)
      : new CustomEditor(tui, theme, keybindings as never);
    return wrapEditorWithTriggerHighlight(base, getSettings, animation);
  };
}

/**
 * Register live trigger highlight for interactive TUI sessions.
 *
 * Returns a handle for settings refresh and shutdown. Headless hosts receive
 * a no-op handle.
 *
 * While the trigger word matches in the composer, a light render loop keeps
 * the neon rainbow animating without further keystrokes.
 */
export function registerHypagoalTriggerEditor(
  ctx: ExtensionContext,
  getSettings: () => HypagoalTriggerSettings,
): HypagoalTriggerEditorHandle {
  const noop: HypagoalTriggerEditorHandle = {
    refresh: () => {},
    dispose: () => {},
  };

  if (!hostSupportsTriggerEditor(ctx)) return noop;

  const ui = ctx.ui as {
    setEditorComponent: (factory: EditorFactory | undefined) => void;
    getEditorComponent?: () => EditorFactory | undefined;
  };

  let activeTui: TUI | undefined;
  const animation = createTriggerAnimationDriver(() => activeTui);
  const previous = typeof ui.getEditorComponent === "function"
    ? ui.getEditorComponent()
    : undefined;

  const factory: EditorFactory = (tui, theme, keybindings) => {
    activeTui = tui;
    const inner = createHypagoalTriggerEditorFactory(previous, getSettings, animation)(
      tui,
      theme,
      keybindings,
    );
    return inner;
  };

  try {
    ui.setEditorComponent(factory);
  } catch {
    // Missing or hostile UI must not break the extension. Submit arming remains.
    animation.dispose();
    return noop;
  }

  return {
    refresh: () => {
      animation.requestRender();
    },
    dispose: () => {
      animation.dispose();
      try {
        // Restore only when we still own the slot (last-writer may have replaced us).
        const current = typeof ui.getEditorComponent === "function"
          ? ui.getEditorComponent()
          : undefined;
        if (current === factory) {
          ui.setEditorComponent(previous);
        }
      } catch {
        // Ignore dispose failures on shutdown.
      }
      activeTui = undefined;
    },
  };
}
