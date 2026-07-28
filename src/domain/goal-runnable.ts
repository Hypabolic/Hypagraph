import { checkCanStartWithoutWaiting } from "./check-policy.js";
import { codeCanStartWithoutWaiting } from "./code-policy.js";
import { effectCanStartWithoutWaiting, indeterminateEffectAttempts } from "./effect-policy.js";
import type { GoalWorkContinuationAction, HypagraphState, NodeDefinition } from "./model.js";

export const ACTIVE_ROOT_STATUSES = new Set(["starting", "running", "awaiting_evidence", "verifying"]);

const loopIdForNode = (state: HypagraphState, nodeId: string): string | undefined =>
  state.definition.loops.find((loop) => loop.nodes.includes(nodeId))?.id;

const loopAllowsWork = (state: HypagraphState, nodeId: string): boolean => {
  const loopId = loopIdForNode(state, nodeId);
  if (!loopId) return true;
  const status = state.runtime.loops[loopId]?.status;
  return status === "pending" || status === "running";
};

/**
 * Enumerate indeterminate effects that must reconcile before any new work.
 * Restart and controller wake must process these first.
 */
export function enumerateIndeterminateEffectActions(state: HypagraphState): GoalWorkContinuationAction[] {
  if (state.goal?.status !== "active" || state.phase !== "running") return [];
  const actions: GoalWorkContinuationAction[] = [];
  for (const node of state.definition.nodes) {
    if ((node.kind ?? "task") !== "effect" || !node.effect) continue;
    const runtime = state.runtime.nodes[node.id];
    if (!runtime) continue;
    const indeterminate = indeterminateEffectAttempts(runtime);
    if (indeterminate.length === 0) continue;
    if (runtime.status !== "blocked" && runtime.status !== "failed") continue;
    // fail-workflow already terminal at workflow level when policy fails the workflow.
    if (runtime.status === "failed" && node.effect.onIndeterminate === "fail-workflow") continue;
    const loopId = loopIdForNode(state, node.id);
    actions.push({
      kind: "reconcile-indeterminate-effect",
      nodeId: node.id,
      ...(loopId ? { loopId } : {}),
    });
  }
  return actions;
}

const actionForReadyNode = (
  state: HypagraphState,
  node: NodeDefinition,
): GoalWorkContinuationAction | undefined => {
  const runtime = state.runtime.nodes[node.id];
  if (!runtime || !loopAllowsWork(state, node.id)) return undefined;
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
  if (kind === "code" && node.code && codeCanStartWithoutWaiting(runtime, node.code)) {
    return { kind: "run-ready-code", nodeId: node.id, ...(loopId ? { loopId } : {}) };
  }
  if (kind === "effect" && node.effect && effectCanStartWithoutWaiting(runtime, node.effect)) {
    return { kind: "run-ready-effect", nodeId: node.id, ...(loopId ? { loopId } : {}) };
  }
  // A ready interaction is requested by the controller or product surface.
  // While awaiting_response, the node is intentionally not runnable.
  if (kind === "interaction" && runtime.status === "ready" && node.interaction) {
    return { kind: "request-ready-interaction", nodeId: node.id, ...(loopId ? { loopId } : {}) };
  }
  return undefined;
};

export function enumerateRootWorkActions(state: HypagraphState): GoalWorkContinuationAction[] {
  // Reconciliation always comes before new work.
  const reconcile = enumerateIndeterminateEffectActions(state);
  if (reconcile.length > 0) return reconcile;

  const active = state.definition.nodes.filter((node) =>
    loopAllowsWork(state, node.id)
    && ACTIVE_ROOT_STATUSES.has(state.runtime.nodes[node.id]?.status ?? "pending"));
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
  if (!node || !runtime || loopIdForNode(state, action.nodeId) !== action.loopId || !loopAllowsWork(state, action.nodeId)) return false;
  const kind = node.kind ?? "task";
  if (action.kind === "continue-active-task") return kind === "task" && ACTIVE_ROOT_STATUSES.has(runtime.status);
  if (action.kind === "start-ready-task") return kind === "task" && runtime.status === "ready";
  if (action.kind === "evaluate-ready-gate") return kind === "gate" && runtime.status === "ready";
  if (action.kind === "request-ready-interaction") {
    return kind === "interaction" && !!node.interaction && runtime.status === "ready";
  }
  if (action.kind === "run-ready-code") {
    return kind === "code" && !!node.code && codeCanStartWithoutWaiting(runtime, node.code);
  }
  if (action.kind === "run-ready-effect") {
    return kind === "effect" && !!node.effect && effectCanStartWithoutWaiting(runtime, node.effect);
  }
  if (action.kind === "reconcile-indeterminate-effect") {
    return kind === "effect"
      && !!node.effect
      && (runtime.status === "blocked" || runtime.status === "failed")
      && indeterminateEffectAttempts(runtime).length > 0
      && !(runtime.status === "failed" && node.effect.onIndeterminate === "fail-workflow");
  }
  return kind === "check" && !!node.check && checkCanStartWithoutWaiting(runtime, node.check);
}
