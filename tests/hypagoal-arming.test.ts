import { describe, expect, it } from "vitest";
import {
  DEFAULT_HYPAGOAL_TRIGGER_WORD,
  defaultHypagoalTriggerSettings,
  disableHypagoalTrigger,
  hypagoalArmedPromptBlock,
  messageArmsHypagoal,
  normalizeTriggerToken,
  parseHypagoalTriggerSettings,
  setHypagoalTriggerWord,
  stripFencedCodeBlocks,
  tokenLooksLikePath,
} from "../src/pi/hypagoal-arming.js";

const settings = defaultHypagoalTriggerSettings();

describe("Hypagoal arming detection", () => {
  it("arms when the default trigger word appears as a whole token", () => {
    expect(messageArmsHypagoal("please hypagoal this feature", settings)).toBe(true);
    expect(messageArmsHypagoal("Hypagoal: fix the bug", settings)).toBe(true);
    expect(messageArmsHypagoal("run hypagoal.", settings)).toBe(true);
  });

  it("does not arm when the trigger word is absent", () => {
    expect(messageArmsHypagoal("implement the graph workflow", settings)).toBe(false);
    expect(messageArmsHypagoal("", settings)).toBe(false);
  });

  it("does not arm for a partial token match", () => {
    expect(messageArmsHypagoal("read hypagoal-plan.md carefully", settings)).toBe(false);
    expect(messageArmsHypagoal("prehypagoal post", settings)).toBe(false);
  });

  it("does not arm when the word is only inside a fenced code block", () => {
    const text = [
      "Here is an example:",
      "```",
      "hypagoal start the goal",
      "```",
      "Continue the ordinary work.",
    ].join("\n");
    expect(messageArmsHypagoal(text, settings)).toBe(false);
  });

  it("does not arm when the word is only inside inline code", () => {
    expect(messageArmsHypagoal("Use the `hypagoal` tool carefully.", settings)).toBe(false);
  });

  it("arms when the word appears outside a code fence", () => {
    const text = [
      "Please hypagoal the following change.",
      "```",
      "const x = 1;",
      "```",
    ].join("\n");
    expect(messageArmsHypagoal(text, settings)).toBe(true);
  });

  it("does not arm when the word appears only in a file path", () => {
    expect(messageArmsHypagoal("edit docs/hypagoal-vertical-slice-plan.md", settings)).toBe(false);
    expect(messageArmsHypagoal("open ./skills/hypagoal/SKILL.md", settings)).toBe(false);
    expect(messageArmsHypagoal("see path\\hypagoal\\file.ts", settings)).toBe(false);
  });

  it("does not arm when arming is off", () => {
    expect(messageArmsHypagoal("please hypagoal this", disableHypagoalTrigger())).toBe(false);
  });

  it("uses the configured trigger word", () => {
    const custom = setHypagoalTriggerWord("shipit");
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;
    expect(messageArmsHypagoal("please shipit the fix", custom.settings)).toBe(true);
    expect(messageArmsHypagoal("please hypagoal the fix", custom.settings)).toBe(false);
  });
});

describe("Hypagoal trigger helpers", () => {
  it("strips fenced code blocks", () => {
    expect(stripFencedCodeBlocks("a ```\nhypagoal\n``` b").includes("hypagoal")).toBe(false);
  });

  it("detects path-like tokens", () => {
    expect(tokenLooksLikePath("docs/hypagoal.md")).toBe(true);
    expect(tokenLooksLikePath("./hypagoal")).toBe(true);
    expect(tokenLooksLikePath("hypagoal")).toBe(false);
  });

  it("normalizes punctuation around tokens", () => {
    expect(normalizeTriggerToken("(hypagoal)")).toBe("hypagoal");
    expect(normalizeTriggerToken("hypagoal.")).toBe("hypagoal");
  });

  it("parses stored settings with schema version", () => {
    expect(parseHypagoalTriggerSettings({ schemaVersion: 1, word: "go" })).toEqual({
      schemaVersion: 1,
      word: "go",
    });
    expect(parseHypagoalTriggerSettings({ schemaVersion: 1, word: null })).toEqual({
      schemaVersion: 1,
      word: null,
    });
    expect(parseHypagoalTriggerSettings({ schemaVersion: 99, word: "x" })).toEqual(
      defaultHypagoalTriggerSettings(),
    );
  });

  it("rejects an empty trigger word", () => {
    expect(setHypagoalTriggerWord("   ").ok).toBe(false);
    expect(setHypagoalTriggerWord("two words").ok).toBe(false);
  });

  it("builds a non-forcing armed prompt block", () => {
    const block = hypagoalArmedPromptBlock(DEFAULT_HYPAGOAL_TRIGGER_WORD);
    expect(block).toContain("HYPAGOAL ARMING:");
    expect(block).toContain("does not need a graph");
    expect(block).toContain("hypagoal_start");
  });
});
