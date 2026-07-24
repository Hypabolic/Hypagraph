import type { EventType, GoalRuntime, GoalStatus, HypagraphState } from "./model.js";

export interface GoalWorkflowOutcome {
  type: Extract<EventType,
    | "hypagraph.goal.paused"
    | "hypagraph.goal.blocked"
    | "hypagraph.goal.completed"
    | "hypagraph.goal.failed"
    | "hypagraph.goal.cancelled">;
  status: Exclude<GoalStatus, "active">;
  reason: string;
}

const terminalGoalStatuses = new Set<GoalStatus>(["completed", "failed", "cancelled"]);

export function goalIsTerminal(goal: GoalRuntime | undefined): boolean {
  return goal !== undefined && terminalGoalStatuses.has(goal.status);
}

export function workflowBlockedReason(state: HypagraphState): string {
  for (const node of state.definition.nodes) {
    const runtime = state.runtime.nodes[node.id];
    if (runtime?.status === "blocked" && runtime.blockedReason?.trim()) return runtime.blockedReason.trim();
  }
  for (const loop of state.definition.loops) {
    const runtime = state.runtime.loops[loop.id];
    if (runtime?.status === "blocked" && runtime.blockedReason?.trim()) return runtime.blockedReason.trim();
    if (runtime?.status === "failed" && runtime.exitReason) return `Loop '${loop.id}' stopped with '${runtime.exitReason}'.`;
  }
  return "The workflow has no executable path.";
}

export function goalOutcomeFromWorkflow(state: HypagraphState): GoalWorkflowOutcome | undefined {
  const goal = state.goal;
  if (!goal || goalIsTerminal(goal)) return undefined;
  switch (state.phase) {
    case "completed":
      return { type: "hypagraph.goal.completed", status: "completed", reason: "The canonical workflow completed." };
    case "failed":
      return { type: "hypagraph.goal.failed", status: "failed", reason: "The canonical workflow failed." };
    case "cancelled":
      return { type: "hypagraph.goal.cancelled", status: "cancelled", reason: "The canonical workflow was cancelled." };
    case "blocked":
      return goal.status === "blocked"
        ? undefined
        : { type: "hypagraph.goal.blocked", status: "blocked", reason: workflowBlockedReason(state) };
    case "paused":
      return goal.status === "active"
        ? { type: "hypagraph.goal.paused", status: "paused", reason: "The canonical workflow is paused." }
        : undefined;
    default:
      return undefined;
  }
}
