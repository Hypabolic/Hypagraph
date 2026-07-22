import type { CheckExecutionRequest, CheckExecutor, CheckResult, Diagnostic, HypagraphCommand, HypagraphState } from "../domain/model.js";
import { createCheckFactPublicationCommand } from "./normalization.js";

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

export type ExecutedCheck =
  | { ok: true; result: CheckResult; publicationCommand: HypagraphCommand }
  | { ok: false; result: CheckResult; diagnostics: Diagnostic[] };

export async function executeAndNormalizeCheck(
  executor: CheckExecutor,
  request: CheckExecutionRequest,
  signal: AbortSignal,
  recordedAt: string,
): Promise<ExecutedCheck> {
  const result = await executeCheck(executor, request, signal);
  const publication = createCheckFactPublicationCommand(request, result, recordedAt);
  if (!publication.ok) return { ok: false, result, diagnostics: publication.diagnostics };
  return { ok: true, result, publicationCommand: publication.command };
}
