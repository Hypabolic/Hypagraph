import type {
  CodeExecutionRequest,
  CodeExecutor,
  CodeResult,
  HypagraphState,
} from "../domain/model.js";
import type { FactValue } from "../domain/facts.js";

export function createCodeExecutionRequest(
  state: HypagraphState,
  nodeId: string,
  attemptId: string,
  requestedAt: string,
): CodeExecutionRequest {
  const node = state.definition.nodes.find((item) => item.id === nodeId);
  if (!node || (node.kind ?? "task") !== "code" || !node.code) {
    throw new Error(`Node '${nodeId}' is not a code node.`);
  }
  const runtime = state.runtime.nodes[nodeId];
  if (!runtime || runtime.status !== "running" || runtime.currentAttemptId !== attemptId) {
    throw new Error(`Code node '${nodeId}' does not have the requested running attempt.`);
  }

  const bindings: Record<string, FactValue> = {};
  for (const name of node.code.execution.inputs) {
    const fact = state.runtime.facts[name];
    if (!fact) {
      throw new Error(`Code node '${nodeId}' requires fact binding '${name}', but that fact is not published.`);
    }
    bindings[name] = structuredClone(fact.value);
  }

  return {
    workflowId: state.workflowId,
    revision: state.revision,
    nodeId,
    attemptId,
    requestedAt,
    definition: structuredClone(node.code),
    bindings,
    produces: structuredClone(node.produces ?? []),
    ...(node.scope?.paths ? { scopePaths: structuredClone(node.scope.paths) } : {}),
  };
}

export async function executeCode(
  executor: CodeExecutor,
  request: CodeExecutionRequest,
  signal: AbortSignal,
): Promise<CodeResult> {
  return structuredClone(await executor.execute(structuredClone(request), signal));
}
