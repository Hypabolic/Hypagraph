import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRAILLE_SPINNER_FRAMES,
  brailleFrame,
  createWidgetAnimationDriver,
  formatGoalStatusBadge,
  formatPhaseBadge,
  formatStatusPhaseChip,
  GOLD_RGB,
  widgetPhaseAnimates,
} from "../src/ui/widget-chrome.js";
import { renderWidget } from "../src/ui/format.js";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";

const at = "2026-07-31T16:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Widget chrome",
  goal: "Show a gold running badge",
  nodes: [{ id: "work", title: "Work", requires: [], acceptance: [] }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

describe("widget chrome", () => {
  it("cycles braille spinner frames", () => {
    expect(brailleFrame(BRAILLE_SPINNER_FRAMES, 0)).toBe(BRAILLE_SPINNER_FRAMES[0]);
    expect(brailleFrame(BRAILLE_SPINNER_FRAMES, 1)).toBe(BRAILLE_SPINNER_FRAMES[1]);
    expect(brailleFrame(BRAILLE_SPINNER_FRAMES, BRAILLE_SPINNER_FRAMES.length))
      .toBe(BRAILLE_SPINNER_FRAMES[0]);
  });

  it("paints running phase in gold with a spinner glyph", () => {
    const badge = formatPhaseBadge("running", 2);
    expect(badge).toContain("running");
    expect(badge).toContain(BRAILLE_SPINNER_FRAMES[2]);
    expect(badge).toContain(`\x1b[38;2;${GOLD_RGB[0]};${GOLD_RGB[1]};${GOLD_RGB[2]}m`);
    expect(badge).toContain("\x1b[1m");
  });

  it("changes spinner glyph across frames for running", () => {
    const a = formatPhaseBadge("running", 0);
    const b = formatPhaseBadge("running", 3);
    expect(a).not.toBe(b);
  });

  it("marks running, blocked, and paused as animating phases", () => {
    expect(widgetPhaseAnimates("running")).toBe(true);
    expect(widgetPhaseAnimates("blocked")).toBe(true);
    expect(widgetPhaseAnimates("paused")).toBe(true);
    expect(widgetPhaseAnimates("completed")).toBe(false);
  });

  it("formats active goal status with gold spinner", () => {
    const badge = formatGoalStatusBadge("active", 1);
    expect(badge).toContain("active");
    expect(badge).toContain(BRAILLE_SPINNER_FRAMES[1]);
    expect(badge).toContain("\x1b[38;2;");
  });

  it("formats status phase chip for the footer", () => {
    const chip = formatStatusPhaseChip("running", 0);
    expect(chip).toContain("running");
    expect(chip).toContain(BRAILLE_SPINNER_FRAMES[0]);
  });

  it("puts gold running badge on the widget title line", () => {
    const created = createHypagoalWorkflow(definition(), {
      workflowId: "w-widget",
      goalId: "g-widget",
      goalWorkflowId: "w-widget",
      at,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const lines = renderWidget(created.state, undefined, { frameIndex: 4 });
    const line = lines[0]!;
    expect(line).toContain("Hypagraph: Widget chrome");
    expect(line).toContain("running");
    expect(line).toContain(BRAILLE_SPINNER_FRAMES[4 % BRAILLE_SPINNER_FRAMES.length]);
    expect(line).toContain("Goal");
    expect(line).toContain("active");
    // Plain completed text still searchable without ANSI for other tests.
    expect(line).toMatch(/running/);
    // Compact chrome: no Active/Family walls; live graph sits under the title.
    expect(lines.some((row) => row.includes("Active:"))).toBe(false);
    expect(lines.some((row) => row.includes("Family:"))).toBe(false);
    expect(lines.length).toBeGreaterThan(1);
  });

  it("can suppress the widget diagram while another dock shows a graph", () => {
    const created = createHypagoalWorkflow(definition(), {
      workflowId: "w-widget-nodiag",
      goalId: "g-widget-nodiag",
      goalWorkflowId: "w-widget-nodiag",
      at,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const withDiagram = renderWidget(created.state, undefined, { includeDiagram: true });
    const without = renderWidget(created.state, undefined, { includeDiagram: false });
    expect(withDiagram.length).toBeGreaterThan(without.length);
    // Title only (no blank + art) while post-create owns the graph.
    expect(without).toHaveLength(1);
    expect(without[0]).toMatch(/Hypagraph:/);
  });

  it("drives widget animation painter while sync(true)", () => {
    vi.useFakeTimers();
    let paints = 0;
    const driver = createWidgetAnimationDriver(50);
    driver.setPainter(() => {
      paints += 1;
    });
    driver.sync(true);
    vi.advanceTimersByTime(160);
    expect(paints).toBeGreaterThanOrEqual(2);
    driver.sync(false);
    const after = paints;
    vi.advanceTimersByTime(200);
    expect(paints).toBe(after);
    driver.dispose();
    vi.useRealTimers();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
