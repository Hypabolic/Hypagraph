import { checkCanStartWithoutWaiting } from "./check-policy.js";
import type { GoalWorkContinuationAction, HypagraphState, NodeDefinition } from "./model.js";

export const ACTIVE_ROOT_STATUSES = new Set(["starting", "running", "awaiting_evidence", "verifying"]);

const loopIdForNode = (state: HypagraphState, nodeId: string): string | undefined =>
  state.definition.loops.find((loop) => loop.nodes.includes(nodeId))?.id;

const actionForReadyNode = (
  state: HypagraphState,
  node: NodeDefinition,
): GoalWorkContinuationAction | undefined => {
  const runtime = state.runtime.nodes[node.id];
  if (!runtime) return undefined;
  const kind = node.kind ?? "task";
  const loopId = loopIdForNode(state, node.id);
  if (kind === "task" && runtime.status === "ready") {
    return { kind: "start-ready-task", nodeId: node.id, ...(loopId ? { loopId } : {}) };
  }
  if (kind === "gate" && runtime.status === "ready") {
    return { kind: "evaluate-ready-gate", nodeId: node.id, ...(loopId ? { loopId } : {}) };
  }
  if (kind === "check" && node.check && checkCanStartWithoutWaiting(runtime, node.check)) {
    return { kind: "run-ready-check", nodeId: node.id, ...(loopId ? { loopId } : {}) };
  }
  return undefined;
};

export function enumerateRootWorkActions(state: HypagraphState): GoalWorkContinuationAction[] {
  const active = state.definition.nodes.filter((node) => ACTIVE_ROOT_STATUSES.has(state.runtime.nodes[node.id]?.status ?? "pending"));
  if (active.length === 1) {
    const node = active[0]!;
    if ((node.kind ?? "task") !== "task") return [];
    const loopId = loopIdForNode(state, node.id);
    return [{ kind: "continue-active-task", nodeId: node.id, ...(loopId ? { loopId } : {}) }];
  }
  if (active.length > 1) return [];
  return state.definition.nodes.flatMap((node) => {
    const action = actionForReadyNode(state, node);
    return action ? [action] : [];
  });
}

export function rootWorkActionIsRunnable(state: HypagraphState, action: GoalWorkContinuationAction): boolean {
  const node = state.definition.nodes.find((candidate) => candidate.id === action.nodeId);
  const runtime = state.runtime.nodes[action.nodeId];
  if (!node || !runtime || loopIdForNode(state, action.nodeId) !== action.loopId) return false;
  const kind = node.kind ?? "task";
  if (action.kind === "continue-active-task") return kind === "task" && ACTIVE_ROOT_STATUSES.has(runtime.status);
  if (action.kind === "start-ready-task") return kind === "task" && runtime.status === "ready";
  if (action.kind === "evaluate-ready-gate") return kind === "gate" && runtime.status === "ready";
  return kind === "check" && !!node.check && checkCanStartWithoutWaiting(runtime, node.check);
}
