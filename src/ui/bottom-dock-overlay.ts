/**
 * Shared bottom-dock overlay options for interactive TUI surfaces.
 *
 * Interaction ask, post-create graph review, and related docks use this contract
 * so placement stays in the composer zone instead of a centered modal.
 */

import type { OverlayOptions, TUI } from "@earendil-works/pi-tui";

/** Minimum dock width on narrow terminals. */
export const BOTTOM_DOCK_MIN_WIDTH = 40;

/**
 * Default maximum dock height as a fraction of the terminal.
 *
 * 55% keeps chat history above while leaving room for question, several
 * responses, and key help. The prior center modal used 70%; 40% clipped the
 * dialog tail on short terminals.
 */
export const BOTTOM_DOCK_MAX_HEIGHT: `${number}%` = "55%";

/**
 * Rows reserved above the footer so status chrome stays readable.
 *
 * Pi footer is often 2–3 lines (path, stats, extension status). One row is not enough.
 */
export const BOTTOM_DOCK_FOOTER_MARGIN = 3;

/** Fraction of terminal rows used when a live TUI is available. */
export const BOTTOM_DOCK_HEIGHT_FRACTION = 0.55;

/** Minimum maxHeight in rows when computing from terminal size. */
export const BOTTOM_DOCK_MIN_HEIGHT_ROWS = 8;

/** Terminal size fields used for dock sizing (full Terminal is not required). */
export type BottomDockTerminal = Pick<TUI["terminal"], "rows" | "columns"> | {
  rows?: number;
  columns?: number;
};

export interface BottomDockOverlayOptionsInput {
  /** Optional live TUI or terminal size for row-aware maxHeight. */
  tui?: { terminal?: BottomDockTerminal };
  /** Override maximum height (rows or percentage). */
  maxHeight?: OverlayOptions["maxHeight"];
  /** Override width (columns or percentage). */
  width?: OverlayOptions["width"];
  /** Override minimum width in columns. */
  minWidth?: number;
  /** Override bottom margin in rows. */
  footerMargin?: number;
}

/**
 * Resolve maxHeight from an override, live terminal rows, or the default percentage.
 *
 * When terminal rows are known, use an absolute row budget so the dock does not
 * cover the footer or the full history on short terminals.
 */
export function resolveBottomDockMaxHeight(input: {
  maxHeight?: OverlayOptions["maxHeight"] | undefined;
  tui?: BottomDockOverlayOptionsInput["tui"] | undefined;
  footerMargin?: number | undefined;
} = {}): NonNullable<OverlayOptions["maxHeight"]> {
  if (input.maxHeight !== undefined) return input.maxHeight;

  const rows = input.tui?.terminal?.rows;
  if (typeof rows === "number" && Number.isFinite(rows) && rows > 0) {
    const footerMargin = input.footerMargin ?? BOTTOM_DOCK_FOOTER_MARGIN;
    // Leave footer margin and one chat-history row above the dock.
    const usable = Math.max(BOTTOM_DOCK_MIN_HEIGHT_ROWS, rows - footerMargin - 1);
    const preferred = Math.floor(rows * BOTTOM_DOCK_HEIGHT_FRACTION);
    return Math.max(BOTTOM_DOCK_MIN_HEIGHT_ROWS, Math.min(preferred, usable));
  }

  return BOTTOM_DOCK_MAX_HEIGHT;
}

/**
 * Overlay options for a full-width dock anchored to the bottom center.
 *
 * Pi defaults missing anchors to center. Callers must use this helper (or set
 * anchor explicitly) for bottom placement.
 */
export function bottomDockOverlayOptions(
  input: BottomDockOverlayOptionsInput = {},
): OverlayOptions {
  const minWidth = input.minWidth ?? BOTTOM_DOCK_MIN_WIDTH;
  const footerMargin = input.footerMargin ?? BOTTOM_DOCK_FOOTER_MARGIN;

  return {
    anchor: "bottom-center",
    width: input.width ?? "100%",
    minWidth,
    maxHeight: resolveBottomDockMaxHeight({
      maxHeight: input.maxHeight,
      tui: input.tui,
      footerMargin,
    }),
    margin: {
      top: 0,
      right: 0,
      bottom: footerMargin,
      left: 0,
    },
  };
}

/**
 * Alias used by the interaction plan name.
 * Prefer bottomDockOverlayOptions in new call sites.
 */
export const interactionDockOverlayOptions = bottomDockOverlayOptions;
