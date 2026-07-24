import type { GoalTokenUsage } from "../domain/model.js";

export const PI_ASSISTANT_USAGE_SOURCE = "pi-assistant-usage-v1" as const;

export type PiGoalUsageResult =
  | { ok: true; usage: GoalTokenUsage; assistantMessages: number }
  | { ok: false; code: string; message: string };

const value = (candidate: unknown, field: string): number | undefined => {
  if (!candidate || typeof candidate !== "object") return undefined;
  const item = (candidate as Record<string, unknown>)[field];
  return typeof item === "number" && Number.isSafeInteger(item) && item >= 0 ? item : undefined;
};

export function normalizePiGoalUsage(messages: readonly unknown[]): PiGoalUsageResult {
  const assistants = messages.filter((message) =>
    !!message && typeof message === "object" && (message as { role?: unknown }).role === "assistant");
  if (assistants.length === 0) {
    return {
      ok: false,
      code: "goal_usage_missing",
      message: "The completed Hypagoal continuation has no assistant usage record.",
    };
  }

  const total: GoalTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  for (const message of assistants) {
    const usage = (message as { usage?: unknown }).usage;
    const input = value(usage, "input");
    const output = value(usage, "output");
    const cacheRead = value(usage, "cacheRead");
    const cacheWrite = value(usage, "cacheWrite");
    const reportedTotal = value(usage, "totalTokens");
    if ([input, output, cacheRead, cacheWrite, reportedTotal].some((item) => item === undefined)) {
      return {
        ok: false,
        code: "goal_usage_invalid",
        message: "The completed Hypagoal continuation has an incomplete or invalid assistant usage record.",
      };
    }
    const derived = input! + output! + cacheRead! + cacheWrite!;
    if (!Number.isSafeInteger(derived) || reportedTotal !== derived) {
      return {
        ok: false,
        code: "goal_usage_total_mismatch",
        message: "The assistant total token count does not match its normalized token fields.",
      };
    }
    total.input += input!;
    total.output += output!;
    total.cacheRead += cacheRead!;
    total.cacheWrite += cacheWrite!;
    total.totalTokens += derived;
    if (Object.values(total).some((item) => !Number.isSafeInteger(item))) {
      return {
        ok: false,
        code: "goal_usage_overflow",
        message: "The normalized assistant usage exceeds the safe integer range.",
      };
    }
  }
  return { ok: true, usage: total, assistantMessages: assistants.length };
}
