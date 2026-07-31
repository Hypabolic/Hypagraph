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

export interface RenderMermaidArtOptions {
  /**
   * Maximum columns available for the diagram.
   *
   * When art width exceeds this value, the helper falls back to sourceBox or text.
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
   * Prefer sourceBox over text when art is missing or too wide.
   *
   * Default true.
   */
  preferSourceBox?: boolean;
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
}

const defaultTextFallback = (source: string): string[] => {
  const trimmed = source.trim();
  if (trimmed.length === 0) return ["(empty mermaid source)"];
  return trimmed.split("\n");
};

/**
 * Render Mermaid source for a terminal dock or status surface.
 *
 * Pipeline:
 * 1. Call grok-mermaid `render`.
 * 2. If art fits `maxWidth`, use plain or ANSI lines.
 * 3. If art is too wide or null, use `sourceBox` or text fallback.
 */
export function renderMermaidArt(
  source: string,
  options: RenderMermaidArtOptions = {},
): MermaidArtResult {
  const preferSourceBox = options.preferSourceBox !== false;
  const kind = diagramKind(source);
  const art = render(source);
  const maxWidth = options.maxWidth;

  const toLines = (drawn: MermaidArt): string[] =>
    options.ansi === true ? toAnsi(drawn, options.theme) : drawn.plain;

  if (art !== null && (maxWidth === undefined || art.width <= maxWidth)) {
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

  if (preferSourceBox) {
    const boxed = sourceBox(source, maxWidth);
    return {
      lines: toLines(boxed),
      width: boxed.width,
      mode: "source-box",
      warnings: art?.warnings ?? [],
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
    warnings: art?.warnings ?? [],
    kind,
    source,
    art,
  };
}
