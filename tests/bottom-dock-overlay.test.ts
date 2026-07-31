import { describe, expect, it } from "vitest";
import {
  BOTTOM_DOCK_FOOTER_MARGIN,
  BOTTOM_DOCK_HEIGHT_FRACTION,
  BOTTOM_DOCK_MAX_HEIGHT,
  BOTTOM_DOCK_MIN_HEIGHT_ROWS,
  BOTTOM_DOCK_MIN_WIDTH,
  bottomDockOverlayOptions,
  interactionDockOverlayOptions,
  resolveBottomDockMaxHeight,
} from "../src/ui/bottom-dock-overlay.js";

describe("bottomDockOverlayOptions", () => {
  it("anchors a full-width dock to the bottom center with a footer margin", () => {
    const options = bottomDockOverlayOptions();
    expect(options).toEqual({
      anchor: "bottom-center",
      width: "100%",
      minWidth: BOTTOM_DOCK_MIN_WIDTH,
      maxHeight: BOTTOM_DOCK_MAX_HEIGHT,
      margin: {
        top: 0,
        right: 0,
        bottom: BOTTOM_DOCK_FOOTER_MARGIN,
        left: 0,
      },
    });
  });

  it("uses a footer margin that covers a multi-line Pi footer", () => {
    expect(BOTTOM_DOCK_FOOTER_MARGIN).toBeGreaterThanOrEqual(3);
    const margin = bottomDockOverlayOptions().margin;
    expect(typeof margin === "object" ? margin.bottom : margin).toBe(BOTTOM_DOCK_FOOTER_MARGIN);
  });

  it("defaults maxHeight high enough that short terminals keep the dialog tail", () => {
    // Prior 40% on 24 rows left ~9 rows and clipped key help / lower options.
    expect(BOTTOM_DOCK_MAX_HEIGHT).toBe("55%");
    const percent = Number.parseInt(BOTTOM_DOCK_MAX_HEIGHT, 10);
    expect(percent).toBeGreaterThanOrEqual(55);
    expect(Math.floor(24 * (percent / 100))).toBeGreaterThanOrEqual(13);
  });

  it("accepts size overrides", () => {
    const options = bottomDockOverlayOptions({
      width: "90%",
      minWidth: 32,
      maxHeight: "50%",
      footerMargin: 2,
    });
    expect(options.anchor).toBe("bottom-center");
    expect(options.width).toBe("90%");
    expect(options.minWidth).toBe(32);
    expect(options.maxHeight).toBe("50%");
    expect(options.margin).toEqual({ top: 0, right: 0, bottom: 2, left: 0 });
  });

  it("derives maxHeight from live terminal rows when tui is present", () => {
    const tui = { terminal: { columns: 80, rows: 24 } };
    const options = bottomDockOverlayOptions({ tui });
    const preferred = Math.floor(24 * BOTTOM_DOCK_HEIGHT_FRACTION);
    const usable = 24 - BOTTOM_DOCK_FOOTER_MARGIN - 1;
    expect(options.maxHeight).toBe(Math.max(BOTTOM_DOCK_MIN_HEIGHT_ROWS, Math.min(preferred, usable)));
    expect(options.maxHeight).toBe(13);
    const margin = options.margin;
    expect(typeof margin === "object" ? margin.bottom : margin).toBe(BOTTOM_DOCK_FOOTER_MARGIN);
  });

  it("keeps a minimum row budget on very short terminals", () => {
    const tui = { terminal: { columns: 80, rows: 10 } };
    const options = bottomDockOverlayOptions({ tui });
    expect(options.maxHeight).toBe(BOTTOM_DOCK_MIN_HEIGHT_ROWS);
  });

  it("exposes the interaction-plan alias", () => {
    expect(interactionDockOverlayOptions()).toEqual(bottomDockOverlayOptions());
  });

  it("never uses the center modal default", () => {
    const options = bottomDockOverlayOptions();
    expect(options.anchor).not.toBe("center");
    expect(options.anchor).not.toBeUndefined();
  });
});

describe("resolveBottomDockMaxHeight", () => {
  it("returns the percentage default without a tui", () => {
    expect(resolveBottomDockMaxHeight()).toBe(BOTTOM_DOCK_MAX_HEIGHT);
  });

  it("honours an explicit override over terminal size", () => {
    expect(
      resolveBottomDockMaxHeight({
        maxHeight: 20,
        tui: { terminal: { columns: 80, rows: 24 } },
      }),
    ).toBe(20);
  });
});
