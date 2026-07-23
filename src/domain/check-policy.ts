import type { CheckDefinition, Diagnostic, NodeRuntime } from "./model.js";

export type CheckStartEligibility =
  | { ok: true; retry: boolean; previousAttemptId?: string }
  | { ok: false; diagnostic: Diagnostic };

const reject = (code: string, message: string, suggestion?: string): CheckStartEligibility => ({
  ok: false,
  diagnostic: { code, message, ...(suggestion ? { suggestion } : {}) },
});

export function evaluateCheckStart(
  runtime: NodeRuntime,
  definition: CheckDefinition,
  attemptId: string,
  at: string,
): CheckStartEligibility {
  if (runtime.attempts[attemptId]) {
    return reject("attempt_id_reused", `Attempt ID '${attemptId}' was already used.`, "Use a new attempt ID.");
  }
  if (runtime.status === "ready") return { ok: true, retry: false };
  if (runtime.status !== "failed") return reject("check_not_ready", `The check is not ready. It cannot start from '${runtime.status}'.`);

  const policy = definition.retry;
  if (!policy) return reject("check_retry_not_allowed", "The check does not permit retry.");
  if (runtime.attemptCount >= policy.maxAttempts) {
    return reject("check_retry_limit_reached", `The check reached its limit of ${policy.maxAttempts} attempts.`);
  }

  const previousAttemptId = runtime.currentAttemptId;
  const previous = previousAttemptId ? runtime.attempts[previousAttemptId] : undefined;
  const previousStatus = previous?.checkResult?.status;
  if (!previousAttemptId || !previousStatus || !policy.retryOn.some((status) => status === previousStatus)) {
    return reject("check_retry_status_not_allowed", `The previous check status '${previousStatus ?? "unknown"}' does not permit retry.`);
  }

  const backoffMs = policy.backoffMs ?? 0;
  if (backoffMs > 0) {
    const previousCompletedAt = previous.completedAt ?? previous.checkResult?.completedAt;
    const previousTime = previousCompletedAt ? Date.parse(previousCompletedAt) : Number.NaN;
    const commandTime = Date.parse(at);
    if (!Number.isFinite(previousTime) || !Number.isFinite(commandTime)) {
      return reject("invalid_retry_time", "The retry time or previous completion time is not valid.");
    }
    const earliest = previousTime + backoffMs;
    if (commandTime < earliest) {
      return reject(
        "check_retry_backoff",
        `The check cannot retry before ${new Date(earliest).toISOString()}.`,
        "Run the check after the retry backoff ends.",
      );
    }
  }

  return { ok: true, retry: true, previousAttemptId };
}
