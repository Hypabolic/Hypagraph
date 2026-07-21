import type { HypagraphState } from "./model.js";

export function feedbackEdgeKeys(state: HypagraphState): Set<string> {
  return new Set(
    state.definition.loops.flatMap((loop) => loop.feedbackEdges.map((edge) => `${edge.from}\u0000${edge.to}`)),
  );
}

export function isNodeReady(state: HypagraphState, nodeId: string): boolean {
  const node = state.definition.nodes.find((candidate) => candidate.id === nodeId);
  const runtime = state.runtime.nodes[nodeId];
  if (!node || !runtime || (runtime.status !== "pending" && runtime.status !== "stale")) return false;

  const feedback = feedbackEdgeKeys(state);
  return node.requires.every((required) => {
    if (feedback.has(`${required}\u0000${node.id}`)) return true;
    return state.runtime.nodes[required]?.status === "completed";
  });
}

export function readyNodeIds(state: HypagraphState): string[] {
  return state.definition.nodes
    .filter((node) => isNodeReady(state, node.id))
    .map((node) => node.id);
}
