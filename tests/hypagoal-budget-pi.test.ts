import { describe, expect, it } from "vitest";
import { normalizePiGoalUsage } from "../src/pi/hypagoal-budget.js";

const message = (usage: Record<string, number>) => ({ role: "assistant", usage });

describe("Pi Hypagoal usage normalization", () => {
  it("sums every assistant usage record with cache tokens", () => {
    expect(normalizePiGoalUsage([
      message({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20 }),
      { role: "user" },
      message({ input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5 }),
    ])).toEqual({
      ok: true,
      assistantMessages: 2,
      usage: { input: 14, output: 6, cacheRead: 3, cacheWrite: 2, totalTokens: 25 },
    });
  });

  it("rejects a missing assistant usage record", () => {
    expect(normalizePiGoalUsage([{ role: "user" }])).toMatchObject({ ok: false, code: "goal_usage_missing" });
  });

  it("rejects partial usage", () => {
    expect(normalizePiGoalUsage([message({ input: 1, output: 1, totalTokens: 2 })])).toMatchObject({ ok: false, code: "goal_usage_invalid" });
  });

  it("rejects a reported total which does not match normalized fields", () => {
    expect(normalizePiGoalUsage([message({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3 })])).toMatchObject({ ok: false, code: "goal_usage_total_mismatch" });
  });
});
