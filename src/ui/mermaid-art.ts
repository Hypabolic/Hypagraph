/**
 * Host helper: render Mermaid source as terminal Unicode art via grok-mermaid.
 *
 * Domain modules must not import this file. Projection stays pure in
 * `src/graph/mermaid-projection.ts`.
 */

import {
  diagramKind,
  render,
  sourceBox,
  toAnsi,
  type AnsiTheme,
  type MermaidArt,
} from "grok-mermaid";

export type { AnsiTheme, MermaidArt };

/** How the helper produced the display lines. */
export type MermaidArtMode = "art" | "source-box" | "text";

/**
 * When rendered art is wider than maxWidth:
 * - source-box: show boxed Mermaid source (readable for authors, ugly for product docks)
 * - clip-art: keep Unicode art and clip each line to maxWidth
 */
export type MermaidOverflowMode = "source-box" | "clip-art";

export interface RenderMermaidArtOptions {
  /**
   * Maximum columns available for the diagram.
   *
   * When art width exceeds this value, behaviour follows `whenTooWide`.
   */
  maxWidth?: number;
  /**
   * When true, colour lines with `toAnsi` and the optional theme.
   *
   * Default false so unit tests and plain docks get unstyled text.
   */
  ansi?: boolean;
  /** Optional SGR theme for `toAnsi`. Used only when `ansi` is true. */
  theme?: AnsiTheme;
  /**
   * Fallback plain text when render fails and sourceBox is not wanted.
   *
   * Default: first lines of the Mermaid source.
   */
  textFallback?: string;
  /**
   * Prefer sourceBox over text when art is missing (null render).
   *
   * Default true.
   */
  preferSourceBox?: boolean;
  /**
   * Overflow policy when art is wider than maxWidth.
   *
   * Default source-box. Product docks should use clip-art (or renderMermaidArtBestFit).
   */
  whenTooWide?: MermaidOverflowMode;
}

export interface MermaidArtResult {
  /** Display lines (plain or ANSI depending on options). */
  lines: string[];
  /** Display column width of the chosen representation. */
  width: number;
  /** Which representation was chosen. */
  mode: MermaidArtMode;
  /** Warnings from grok-mermaid when art rendered. */
  warnings: string[];
  /** Diagram kind from the Mermaid header, when known. */
  kind: ReturnType<typeof diagramKind>;
  /** Original Mermaid source. */
  source: string;
  /** Art from render when present, even if not used because of width. */
  art: MermaidArt | null;
  /** True when art lines were clipped to maxWidth. */
  clipped?: boolean;
}

const defaultTextFallback = (source: string): string[] => {
  const trimmed = source.trim();
  if (trimmed.length === 0) return ["(empty mermaid source)"];
  return trimmed.split("\n");
};

/** Clip plain lines to a column budget (code-point length, fine for box art). */
export function clipArtLinesToWidth(lines: readonly string[], maxWidth: number): string[] {
  if (maxWidth <= 0) return lines.map(() => "");
  return lines.map((line) => {
    if (line.length <= maxWidth) return line;
    if (maxWidth === 1) return line.slice(0, 1);
    return `${line.slice(0, maxWidth - 1)}…`;
  });
}

/**
 * Render Mermaid source for a terminal dock or status surface.
 *
 * Pipeline:
 * 1. Call grok-mermaid `render`.
 * 2. If art fits `maxWidth`, use plain or ANSI lines.
 * 3. If art is too wide, follow `whenTooWide` (source-box or clip-art).
 * 4. If art is null, use sourceBox or text fallback.
 */
export function renderMermaidArt(
  source: string,
  options: RenderMermaidArtOptions = {},
): MermaidArtResult {
  const preferSourceBox = options.preferSourceBox !== false;
  const whenTooWide = options.whenTooWide ?? "source-box";
  const kind = diagramKind(source);
  const art = render(source);
  const maxWidth = options.maxWidth;

  const toLines = (drawn: MermaidArt): string[] =>
    options.ansi === true ? toAnsi(drawn, options.theme) : drawn.plain;

  if (art !== null) {
    if (maxWidth === undefined || art.width <= maxWidth) {
      return {
        lines: toLines(art),
        width: art.width,
        mode: "art",
        warnings: art.warnings,
        kind,
        source,
        art,
      };
    }

    if (whenTooWide === "clip-art") {
      const clipped = clipArtLinesToWidth(toLines(art), maxWidth);
      return {
        lines: clipped,
        width: maxWidth,
        mode: "art",
        warnings: [
          ...art.warnings,
          `Diagram width ${art.width} exceeds dock width ${maxWidth}; art was clipped.`,
        ],
        kind,
        source,
        art,
        clipped: true,
      };
    }

    // whenTooWide === "source-box"
    if (preferSourceBox) {
      const boxed = sourceBox(source, maxWidth);
      return {
        lines: toLines(boxed),
        width: boxed.width,
        mode: "source-box",
        warnings: art.warnings,
        kind,
        source,
        art,
      };
    }

    const text = options.textFallback ?? defaultTextFallback(source).join("\n");
    const textLines = text.split("\n");
    const width = textLines.reduce((max, line) => Math.max(max, line.length), 0);
    return {
      lines: textLines,
      width,
      mode: "text",
      warnings: art.warnings,
      kind,
      source,
      art,
    };
  }

  if (preferSourceBox) {
    const boxed = sourceBox(source, maxWidth);
    return {
      lines: toLines(boxed),
      width: boxed.width,
      mode: "source-box",
      warnings: [],
      kind,
      source,
      art: null,
    };
  }

  const text = options.textFallback ?? defaultTextFallback(source).join("\n");
  const textLines = text.split("\n");
  const width = textLines.reduce((max, line) => Math.max(max, line.length), 0);
  return {
    lines: textLines,
    width,
    mode: "text",
    warnings: [],
    kind,
    source,
    art: null,
  };
}

/**
 * Pick the first source that renders art within maxWidth.
 * If none fit, use the first candidate and clip it (preserve source order).
 *
 * Product docks must pass horizontal (LR) sources first — and usually only LR.
 * Do not put vertical (TD) sources after LR as a "fit" fallback: TD is narrow
 * enough to win on width, then the tall art is clipped by dock height.
 * Prefer compact LR label variants, then horizontal clip-art.
 *
 * When clipping, uses the first source in the list (callers put preferred LR first)
 * unless a later source is both narrower and not taller (still LR-safe if only LR given).
 */
export function renderMermaidArtBestFit(
  sources: readonly string[],
  options: RenderMermaidArtOptions = {},
): MermaidArtResult {
  if (sources.length === 0) {
    return renderMermaidArt("", { ...options, whenTooWide: "clip-art" });
  }

  const maxWidth = options.maxWidth;
  let firstRenderable: { source: string; art: MermaidArt } | undefined;
  let narrowest: { source: string; art: MermaidArt } | undefined;

  for (const source of sources) {
    const art = render(source);
    if (art === null) continue;
    if (!firstRenderable) firstRenderable = { source, art };
    if (maxWidth === undefined || art.width <= maxWidth) {
      // Prefer clip-art when the caller asked for product overflow behaviour.
      return renderMermaidArt(source, {
        ...options,
        whenTooWide: options.whenTooWide ?? "source-box",
      });
    }
    if (!narrowest || art.width < narrowest.art.width) {
      narrowest = { source, art };
    }
  }

  // None fit the width. Clip the narrowest candidate (still LR when callers
  // only pass horizontal sources). Prefer first renderable if widths tie.
  const fallback = narrowest ?? firstRenderable;
  if (fallback) {
    return renderMermaidArt(fallback.source, {
      ...options,
      whenTooWide: "clip-art",
      preferSourceBox: false,
    });
  }

  // All renders null — last resort source-box on first source.
  return renderMermaidArt(sources[0]!, {
    ...options,
    whenTooWide: "source-box",
    preferSourceBox: true,
  });
}
