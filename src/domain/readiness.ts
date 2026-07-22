import type { HypagraphState, LoopDefinition } from "./model.js";

export function feedbackEdgeKeys(state: HypagraphState): Set<string> {
  return new Set(
    state.definition.loops.flatMap((loop) => loop.feedbackEdges.map((edge) => `${edge.from}\u0000${edge.to}`)),
  );
}

const loopForNode = (state: HypagraphState, nodeId: string): LoopDefinition | undefined =>
  state.definition.loops.find((loop) => loop.nodes.includes(nodeId));

export function dependencyStatuses(state: HypagraphState, nodeId: string): string[] | undefined {
  const node = state.definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return undefined;
  const feedback = feedbackEdgeKeys(state);
  return node.requires
    .filter((required) => !feedback.has(`${required}\u0000${node.id}`))
    .map((required) => state.runtime.nodes[required]?.status ?? "missing");
}

const loopBarriersAreSatisfied = (state: HypagraphState, nodeId: string): boolean => {
  const node = state.definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return false;
  const targetLoop = loopForNode(state, nodeId);
  for (const required of node.requires) {
    const sourceLoop = loopForNode(state, required);
    if (!sourceLoop || sourceLoop.id === targetLoop?.id) continue;
    if (state.runtime.loops[sourceLoop.id]?.status !== "completed") return false;
  }
  return true;
};

export function dependenciesAreSatisfied(state: HypagraphState, nodeId: string): boolean {
  const statuses = dependencyStatuses(state, nodeId);
  return statuses !== undefined
    && statuses.every((status) => status === "succeeded" || status === "skipped")
    && loopBarriersAreSatisfied(state, nodeId);
}

export function dependenciesSelectSkip(state: HypagraphState, nodeId: string): boolean {
  const statuses = dependencyStatuses(state, nodeId);
  return !!statuses && statuses.length > 0 && statuses.every((status) => status === "skipped");
}

export function isNodeReady(state: HypagraphState, nodeId: string): boolean {
  return state.runtime.nodes[nodeId]?.status === "ready";
}

export function readyNodeIds(state: HypagraphState): string[] {
  return state.definition.nodes
    .filter((node) => state.runtime.nodes[node.id]?.status === "ready")
    .map((node) => node.id);
}
