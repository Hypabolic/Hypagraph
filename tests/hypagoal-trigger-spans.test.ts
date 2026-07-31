import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultHypagoalTriggerSettings,
  disableHypagoalTrigger,
  findHypagoalTriggerSpans,
  messageArmsHypagoal,
  setHypagoalTriggerWord,
  type HypagoalTriggerSettings,
} from "../src/pi/hypagoal-arming.js";
import {
  applyTriggerSpansToPlainText,
  colorizeTriggerToken,
  configureTriggerAnimationClockForTests,
  createTriggerAnimationDriver,
  hostSupportsTriggerEditor,
  hsvToRgb,
  paintHypagoalTriggerLines,
  paintWrapChunkWithLocalSpans,
  resolveEditorEvaluationText,
  spansToLineLocal,
  stripEditorDecorations,
} from "../src/pi/hypagoal-trigger-editor.js";

const settings = defaultHypagoalTriggerSettings();

const assertParity = (text: string, cfg: HypagoalTriggerSettings = settings): void => {
  const spans = findHypagoalTriggerSpans(text, cfg);
  const armed = messageArmsHypagoal(text, cfg);
  expect(spans.length > 0).toBe(armed);
};

/** True when the decoration-stripped line still contains contiguous `token`. */
const plainContains = (line: string, token: string): boolean =>
  stripEditorDecorations(line).includes(token);

/** True when a painted (non-contiguous after colour) token is present via ANSI. */
const hasColourPaint = (line: string): boolean => line.includes("\x1b[38;2;");

describe("findHypagoalTriggerSpans", () => {
  it("returns empty spans when the trigger is absent", () => {
    const text = "implement the graph workflow";
    expect(findHypagoalTriggerSpans(text, settings)).toEqual([]);
    assertParity(text);
  });

  it("returns a span for a whole-token default match", () => {
    const text = "please hypagoal this feature";
    const spans = findHypagoalTriggerSpans(text, settings);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text.toLowerCase()).toBe("hypagoal");
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe(spans[0]!.text);
    assertParity(text);
  });

  it("matches case-insensitively and strips trailing punctuation from the span core", () => {
    const text = "run Hypagoal.";
    const spans = findHypagoalTriggerSpans(text, settings);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe("Hypagoal");
    assertParity(text);
  });

  it("returns empty spans for a fenced-only match", () => {
    const text = [
      "Here is an example:",
      "```",
      "hypagoal start the goal",
      "```",
      "Continue the ordinary work.",
    ].join("\n");
    expect(findHypagoalTriggerSpans(text, settings)).toEqual([]);
    assertParity(text);
  });

  it("returns empty spans for an inline-code-only match", () => {
    const text = "Use the `hypagoal` tool carefully.";
    expect(findHypagoalTriggerSpans(text, settings)).toEqual([]);
    assertParity(text);
  });

  it("returns a span when the word is outside a fence", () => {
    const text = [
      "Please hypagoal the following change.",
      "```",
      "const x = 1;",
      "```",
    ].join("\n");
    const spans = findHypagoalTriggerSpans(text, settings);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe("hypagoal");
    assertParity(text);
  });

  it("returns empty spans for path-like tokens", () => {
    expect(findHypagoalTriggerSpans("edit docs/hypagoal-vertical-slice-plan.md", settings)).toEqual([]);
    expect(findHypagoalTriggerSpans("open ./skills/hypagoal/SKILL.md", settings)).toEqual([]);
    expect(findHypagoalTriggerSpans("see path\\hypagoal\\file.ts", settings)).toEqual([]);
    assertParity("edit docs/hypagoal-vertical-slice-plan.md");
  });

  it("returns empty spans when arming is off", () => {
    const text = "please hypagoal this";
    expect(findHypagoalTriggerSpans(text, disableHypagoalTrigger())).toEqual([]);
    assertParity(text, disableHypagoalTrigger());
  });

  it("uses the configured custom word", () => {
    const custom = setHypagoalTriggerWord("shipit");
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;
    const spans = findHypagoalTriggerSpans("please shipit the fix", custom.settings);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe("shipit");
    expect(findHypagoalTriggerSpans("please hypagoal the fix", custom.settings)).toEqual([]);
    assertParity("please shipit the fix", custom.settings);
    assertParity("please hypagoal the fix", custom.settings);
  });

  it("returns every match when the draft has multiple tokens", () => {
    const text = "hypagoal once and hypagoal twice";
    const spans = findHypagoalTriggerSpans(text, settings);
    expect(spans).toHaveLength(2);
    expect(spans.map((span) => span.text)).toEqual(["hypagoal", "hypagoal"]);
    expect(spans[0]!.start).toBeLessThan(spans[1]!.start);
    assertParity(text);
  });

  it("does not match a partial token", () => {
    expect(findHypagoalTriggerSpans("read hypagoal-plan.md carefully", settings)).toEqual([]);
    expect(findHypagoalTriggerSpans("prehypagoal post", settings)).toEqual([]);
    assertParity("prehypagoal post");
  });

  it("keeps span indices on UTF-16 code units for ordinary ASCII text", () => {
    const text = "ab hypagoal cd";
    const spans = findHypagoalTriggerSpans(text, settings);
    expect(spans[0]!.start).toBe(3);
    expect(spans[0]!.end).toBe(11);
    expect(text.slice(3, 11)).toBe("hypagoal");
  });

  it("holds empty-span iff not armed across a fixed fixture set", () => {
    const fixtures = [
      "",
      "hypagoal",
      "please Hypagoal now",
      "```\nhypagoal\n```",
      "`hypagoal`",
      "docs/hypagoal.ts",
      "hypagoal and hypagoal",
      "(hypagoal)",
      "hypagoal.",
    ];
    for (const text of fixtures) {
      assertParity(text);
    }
  });
});

describe("applyTriggerSpansToPlainText", () => {
  it("paints only exact span ranges", () => {
    const text = "hypagoal now\n`hypagoal`";
    const spans = findHypagoalTriggerSpans(text, settings);
    expect(spans).toHaveLength(1);
    const painted = applyTriggerSpansToPlainText(text, spans);
    const [first, second] = painted.split("\n");
    expect(hasColourPaint(first!)).toBe(true);
    expect(second).toBe("`hypagoal`");
    expect(plainContains(second!, "hypagoal")).toBe(true);
  });
});

describe("paintHypagoalTriggerLines", () => {
  it("leaves lines unchanged when there is no match", () => {
    const lines = ["no trigger here"];
    expect(paintHypagoalTriggerLines(lines, "no trigger here", settings).lines).toEqual(lines);
  });

  it("paints a matching token with ANSI colour and secondary cues", () => {
    const lines = ["please hypagoal this"];
    const painted = paintHypagoalTriggerLines(lines, "please hypagoal this", settings).lines;
    expect(painted[0]).toContain("\x1b[38;2;");
    expect(painted[0]).toContain("\x1b[1m");
    expect(painted[0]).toContain("\x1b[4m");
    expect(painted[0]).toContain("please ");
    expect(painted[0]).toContain(" this");
  });

  it("does not paint path-only drafts", () => {
    const text = "edit docs/hypagoal.ts";
    const lines = [text];
    expect(paintHypagoalTriggerLines(lines, text, settings).lines).toEqual(lines);
  });

  it("paints a valid token and leaves an inline-code token unpainted", () => {
    const buffer = "hypagoal now\n`hypagoal`";
    const lines = buffer.split("\n");
    const { lines: painted } = paintHypagoalTriggerLines(lines, buffer, settings);
    expect(hasColourPaint(painted[0]!)).toBe(true);
    expect(painted[1]).toBe("`hypagoal`");
    expect(hasColourPaint(painted[1]!)).toBe(false);
  });

  it("paints a valid token and leaves a path token unpainted", () => {
    const buffer = "please hypagoal this\nedit docs/hypagoal.ts";
    const lines = buffer.split("\n");
    const { lines: painted } = paintHypagoalTriggerLines(lines, buffer, settings);
    expect(hasColourPaint(painted[0]!)).toBe(true);
    expect(painted[1]).toBe("edit docs/hypagoal.ts");
    expect(hasColourPaint(painted[1]!)).toBe(false);
  });

  it("paints a valid token and leaves a partial token unpainted", () => {
    const buffer = "run hypagoal\nsee hypagoal-plan.md";
    const lines = buffer.split("\n");
    const { lines: painted } = paintHypagoalTriggerLines(lines, buffer, settings);
    expect(hasColourPaint(painted[0]!)).toBe(true);
    expect(painted[1]).toBe("see hypagoal-plan.md");
    expect(hasColourPaint(painted[1]!)).toBe(false);
  });

  it("paints a valid token next to a fenced-only line", () => {
    const buffer = [
      "hypagoal implement",
      "```",
      "hypagoal",
      "```",
    ].join("\n");
    const lines = buffer.split("\n");
    const { lines: painted } = paintHypagoalTriggerLines(lines, buffer, settings);
    expect(hasColourPaint(painted[0]!)).toBe(true);
    expect(painted[2]).toBe("hypagoal");
    expect(hasColourPaint(painted[2]!)).toBe(false);
  });

  it("maps exact spans through a simulated editor chrome frame", () => {
    const buffer = "hypagoal now\n`hypagoal`";
    const lines = [
      "────────────────",
      "hypagoal now",
      "`hypagoal`",
      "────────────────",
    ];
    const { lines: painted } = paintHypagoalTriggerLines(lines, buffer, settings);
    expect(hasColourPaint(painted[1]!)).toBe(true);
    expect(painted[2]).toBe("`hypagoal`");
    expect(hasColourPaint(painted[0]!)).toBe(false);
    expect(hasColourPaint(painted[3]!)).toBe(false);
  });

  it("colorizes paste markers when only expanded paste content arms", () => {
    const display = "intro [paste #1 +2 lines] outro";
    const expanded = "intro please hypagoal this change outro";
    const lines = [display];
    const result = paintHypagoalTriggerLines(lines, expanded, settings, display);
    expect(result.armedInCollapsedPaste).toBe(true);
    expect(hasColourPaint(result.lines[0]!)).toBe(true);
    expect(stripEditorDecorations(result.lines[0]!)).toContain("[paste #1 +2 lines]");
  });

  it("does not colour paste markers when expanded paste does not arm", () => {
    const display = "intro [paste #1 +2 lines] outro";
    const expanded = "intro ordinary text without the word outro";
    const result = paintHypagoalTriggerLines([display], expanded, settings, display);
    expect(result.armedInCollapsedPaste).toBe(false);
    expect(result.lines[0]).toBe(display);
  });

  it("paints display spans when both display and expanded arm", () => {
    const display = "hypagoal visible";
    const expanded = "hypagoal visible";
    const result = paintHypagoalTriggerLines([display], expanded, settings, display);
    expect(result.armedInCollapsedPaste).toBe(false);
    expect(hasColourPaint(result.lines[0]!)).toBe(true);
  });

  it("colorizes every character of a short token", () => {
    const out = colorizeTriggerToken("ab", 0);
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out.endsWith("\x1b[0m")).toBe(true);
    expect(out).toContain("\x1b[38;2;");
    expect(out).toContain("\x1b[1m"); // bold
    expect(out).toContain("\x1b[3m"); // italic
    expect(out).toContain("\x1b[4m"); // underline
  });

  it("animates rainbow colours over time for the same token", () => {
    const a = colorizeTriggerToken("hypagoal", 0);
    const b = colorizeTriggerToken("hypagoal", 400);
    expect(a).not.toBe(b);
    expect(hasColourPaint(a)).toBe(true);
    expect(hasColourPaint(b)).toBe(true);
  });

  it("marks paint results as armed when the trigger matches", () => {
    const result = paintHypagoalTriggerLines(
      ["please hypagoal this"],
      "please hypagoal this",
      settings,
    );
    expect(result.armed).toBe(true);
    expect(result.armedInCollapsedPaste).toBe(false);
  });
});

describe("trigger animation helpers", () => {
  afterEach(() => {
    configureTriggerAnimationClockForTests(undefined);
  });

  it("converts HSV primary hues to expected RGB corners", () => {
    expect(hsvToRgb(0, 1, 1)).toEqual([255, 0, 0]);
    expect(hsvToRgb(120, 1, 1)).toEqual([0, 255, 0]);
    expect(hsvToRgb(240, 1, 1)).toEqual([0, 0, 255]);
  });

  it("starts and stops the animation driver from armed/idle notes", () => {
    vi.useFakeTimers();
    const renders: number[] = [];
    const driver = createTriggerAnimationDriver(() => ({
      requestRender: () => {
        renders.push(1);
      },
    } as never), 50);
    driver.noteArmed();
    vi.advanceTimersByTime(120);
    expect(renders.length).toBeGreaterThanOrEqual(2);
    driver.noteIdle();
    const afterIdle = renders.length;
    vi.advanceTimersByTime(200);
    expect(renders.length).toBe(afterIdle);
    driver.dispose();
    vi.useRealTimers();
  });
});

describe("paintWrapChunkWithLocalSpans", () => {
  it("paints a span that falls inside a wrap chunk", () => {
    const bufferLine = "please hypagoal this feature carefully";
    const spans = findHypagoalTriggerSpans(bufferLine, settings);
    const local = spansToLineLocal(bufferLine, spans);
    const chunk = "please hypagoal this";
    const painted = paintWrapChunkWithLocalSpans(chunk, bufferLine, local);
    expect(painted).not.toBeNull();
    expect(hasColourPaint(painted!)).toBe(true);
  });

  it("does not paint a chunk that only holds excluded context", () => {
    const bufferLine = "please hypagoal this";
    const spans = findHypagoalTriggerSpans(bufferLine, settings);
    const local = spansToLineLocal(bufferLine, spans);
    const painted = paintWrapChunkWithLocalSpans("please ", bufferLine, local);
    expect(painted).toBeNull();
  });
});

describe("resolveEditorEvaluationText", () => {
  it("uses getExpandedText when present", () => {
    const editor = {
      getText: () => "see [paste #1 +1 lines]",
      getExpandedText: () => "see please hypagoal now",
    };
    const resolved = resolveEditorEvaluationText(editor);
    expect(resolved.displayText).toBe("see [paste #1 +1 lines]");
    expect(resolved.evaluationText).toBe("see please hypagoal now");
    expect(resolved.hasCollapsedPaste).toBe(true);
  });

  it("falls back to getText when getExpandedText is absent", () => {
    const editor = { getText: () => "hypagoal only" };
    const resolved = resolveEditorEvaluationText(editor);
    expect(resolved.evaluationText).toBe("hypagoal only");
    expect(resolved.hasCollapsedPaste).toBe(false);
  });
});

describe("hostSupportsTriggerEditor", () => {
  it("requires interactive TUI with setEditorComponent", () => {
    expect(hostSupportsTriggerEditor({
      hasUI: true,
      mode: "tui",
      ui: { setEditorComponent: () => {} },
    })).toBe(true);
    expect(hostSupportsTriggerEditor({
      hasUI: false,
      mode: "tui",
      ui: { setEditorComponent: () => {} },
    })).toBe(false);
    expect(hostSupportsTriggerEditor({
      hasUI: true,
      mode: "rpc",
      ui: { setEditorComponent: () => {} },
    })).toBe(false);
    expect(hostSupportsTriggerEditor({
      hasUI: true,
      mode: "tui",
      ui: {},
    })).toBe(false);
  });
});
