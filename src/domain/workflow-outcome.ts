import type { HypagraphDefinition, HypagraphState, LoopDefinition, LoopFailurePolicy } from "./model.js";
import { buildOutgoing } from "./scc.js";

export const loopFailurePolicy = (loop: LoopDefinition): LoopFailurePolicy => loop.failurePolicy ?? "fail-workflow";

export const loopIsTerminal = (state: HypagraphState, loopId: string): boolean => {
  const status = state.runtime.loops[loopId]?.status;
  return status === "succeeded" || status === "failed";
};

const loopForNode = (state: HypagraphState, nodeId: string): LoopDefinition | undefined =>
  state.definition.loops.find((loop) => loop.nodes.includes(nodeId));

export const affectedDependants = (definition: HypagraphDefinition, loopId: string): string[] => {
  const loop = definition.loops.find((candidate) => candidate.id === loopId);
  if (!loop) return [];
  const loopNodes = new Set(loop.nodes);
  const outgoing = buildOutgoing(definition.nodes);
  const queue = (outgoing.get(loop.evaluateAfter) ?? []).filter((nodeId) => !loopNodes.has(nodeId)).sort();
  const affected = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]!;
    if (loopNodes.has(nodeId) || affected.has(nodeId)) continue;
    affected.add(nodeId);
    for (const dependent of outgoing.get(nodeId) ?? []) {
      if (!loopNodes.has(dependent) && !affected.has(dependent)) queue.push(dependent);
    }
  }
  return [...affected].sort();
};

export const nodeIsSettledForWorkflow = (state: HypagraphState, nodeId: string): boolean => {
  const status = state.runtime.nodes[nodeId]?.status;
  if (status === "succeeded" || status === "skipped") return true;
  const loop = loopForNode(state, nodeId);
  if (!loop || state.runtime.loops[loop.id]?.status !== "failed") return false;
  return loopFailurePolicy(loop) !== "fail-workflow";
};

export const workflowCanComplete = (state: HypagraphState): boolean =>
  state.definition.loops.every((loop) => loopIsTerminal(state, loop.id))
  && state.definition.nodes.every((node) => nodeIsSettledForWorkflow(state, node.id));

export const workflowBlockedByFailedLoop = (state: HypagraphState): boolean =>
  state.definition.loops.some((loop) => {
    const status = state.runtime.loops[loop.id]?.status;
    if (status === "blocked") return true;
    if (status !== "failed" || loopFailurePolicy(loop) === "fail-workflow") return false;
    return affectedDependants(state.definition, loop.id).some((nodeId) => !nodeIsSettledForWorkflow(state, nodeId));
  });
