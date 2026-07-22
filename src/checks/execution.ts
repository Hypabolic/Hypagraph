import type { CheckExecutionRequest, CheckExecutor, CheckResult, HypagraphState } from "../domain/model.js";

export function createCheckExecutionRequest(state: HypagraphState, nodeId: string, attemptId: string, requestedAt: string): CheckExecutionRequest {
  const node = state.definition.nodes.find((item) => item.id === nodeId);
  if (!node || (node.kind ?? "task") !== "check" || !node.check) throw new Error(`Node '${nodeId}' is not a check.`);
  const runtime = state.runtime.nodes[nodeId];
  if (!runtime || runtime.status !== "running" || runtime.currentAttemptId !== attemptId) throw new Error(`Check '${nodeId}' does not have the requested running attempt.`);
  return {
    workflowId: state.workflowId,
    revision: state.revision,
    nodeId,
    attemptId,
    requestedAt,
    definition: structuredClone(node.check),
  };
}

export async function executeCheck(executor: CheckExecutor, request: CheckExecutionRequest, signal: AbortSignal): Promise<CheckResult> {
  const result = await executor.execute(structuredClone(request), signal);
  return structuredClone(result);
}
