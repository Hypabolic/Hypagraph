import type { CheckExecutionRequest, CheckResult } from "../domain/model.js";

const validTime = (value: string): boolean => Number.isFinite(Date.parse(value));

export function enforceCancelledResult(
  request: CheckExecutionRequest,
  result: CheckResult,
  signal: AbortSignal,
  completedAt: string,
): CheckResult {
  if (!signal.aborted || result.status === "cancelled") return result;
  return {
    checkKind: request.definition.kind,
    attemptId: request.attemptId,
    startedAt: validTime(result.startedAt) ? result.startedAt : request.requestedAt,
    completedAt,
    status: "cancelled",
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    facts: [],
    evidence: structuredClone(result.evidence),
    ...(result.stdoutRef ? { stdoutRef: result.stdoutRef } : {}),
    ...(result.stderrRef ? { stderrRef: result.stderrRef } : {}),
    error: "The check was cancelled. A later executor result was ignored.",
  };
}
