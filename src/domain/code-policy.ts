import type { CodeNodeDefinition, CodeResult, Diagnostic, NodeRuntime } from "./model.js";

export type CodeStartEligibility =
  | { ok: true; retry: boolean; previousAttemptId?: string }
  | { ok: false; diagnostic: Diagnostic };

const reject = (code: string, message: string, suggestion?: string): CodeStartEligibility => ({
  ok: false,
  diagnostic: { code, message, ...(suggestion ? { suggestion } : {}) },
});

const previousCodeStatus = (runtime: NodeRuntime): CodeResult["status"] | undefined => {
  const previousAttemptId = runtime.currentAttemptId;
  if (!previousAttemptId) return undefined;
  return runtime.attempts[previousAttemptId]?.codeResult?.status;
};

export function codeCanStartWithoutWaiting(
  runtime: NodeRuntime,
  definition: CodeNodeDefinition,
): boolean {
  if (runtime.status === "ready") return true;
  if (runtime.status !== "failed") return false;
  const policy = definition.retry;
  if (!policy || (policy.backoffMs ?? 0) > 0 || runtime.attemptCount >= policy.maxAttempts) return false;
  const previousStatus = previousCodeStatus(runtime);
  if (previousStatus !== "failed" && previousStatus !== "timed_out" && previousStatus !== "error") return false;
  return policy.retryOn.includes(previousStatus);
}

export function evaluateCodeStart(
  runtime: NodeRuntime,
  definition: CodeNodeDefinition,
  attemptId: string,
  at: string,
): CodeStartEligibility {
  if (runtime.attempts[attemptId]) {
    return reject("attempt_id_reused", `Attempt ID '${attemptId}' was already used.`, "Use a new attempt ID.");
  }
  if (runtime.status === "ready") return { ok: true, retry: false };
  if (runtime.status !== "failed") {
    return reject("code_not_ready", `The code node is not ready. It cannot start from '${runtime.status}'.`);
  }

  const policy = definition.retry;
  if (!policy) return reject("code_retry_not_allowed", "The code node does not permit retry.");
  if (runtime.attemptCount >= policy.maxAttempts) {
    return reject("code_retry_limit_reached", `The code node reached its limit of ${policy.maxAttempts} attempts.`);
  }

  const previousAttemptId = runtime.currentAttemptId;
  const previous = previousAttemptId ? runtime.attempts[previousAttemptId] : undefined;
  const previousStatus = previous?.codeResult?.status;
  if (!previousAttemptId || !previousStatus || !policy.retryOn.some((status) => status === previousStatus)) {
    return reject(
      "code_retry_status_not_allowed",
      `The previous code status '${previousStatus ?? "unknown"}' does not permit retry.`,
    );
  }

  const backoffMs = policy.backoffMs ?? 0;
  if (backoffMs > 0) {
    const previousCompletedAt = previous.completedAt ?? previous.codeResult?.completedAt;
    const previousTime = previousCompletedAt ? Date.parse(previousCompletedAt) : Number.NaN;
    const commandTime = Date.parse(at);
    if (!Number.isFinite(previousTime) || !Number.isFinite(commandTime)) {
      return reject("invalid_retry_time", "The retry time or previous completion time is not valid.");
    }
    const earliest = previousTime + backoffMs;
    if (commandTime < earliest) {
      return reject(
        "code_retry_backoff",
        `The code node cannot retry before ${new Date(earliest).toISOString()}.`,
        "Run the code node after the retry backoff ends.",
      );
    }
  }

  return { ok: true, retry: true, previousAttemptId };
}
