import type { HypagraphState } from "../domain/model.js";
import {
  projectGoalLoopContinuationGuidance,
  renderGoalLoopContinuationGuidance,
} from "./hypagoal-loop-guidance.js";
import {
  continuationActionIsRunnable,
  type GoalDispatchableContinuation,
} from "../domain/goal-continuation.js";
import { projectModelVisibleWorkflowSummary } from "./model-visible-state.js";

export interface GoalContinuationGeneration {
  sessionGeneration: number;
  branchGeneration: number;
}

export interface PendingGoalContinuation extends GoalContinuationGeneration {
  operationId: string;
  turnId: string;
  action: GoalDispatchableContinuation;
  requestedOrdinal: number;
  requestSequence: number;
  selectedSequence: number;
  selectedSnapshotHash: string;
  committedSequence: number;
  committedSnapshotHash: string;
  prompt: string;
}

export interface GoalContinuationValidation {
  ok: boolean;
  code?: string;
  message?: string;
}

const actionLabel = (action: GoalDispatchableContinuation): string => {
  switch (action.kind) {
    case "continue-active-task": return `continue active task '${action.nodeId}'`;
    case "start-ready-task": return `start ready task '${action.nodeId}'`;
    case "run-ready-check": return `run ready check '${action.nodeId}'`;
    case "evaluate-ready-gate": return `evaluate ready gate '${action.nodeId}'`;
    case "request-revision": return `request one bounded revision for ${action.blocker.kind} '${action.blocker.id}'`;
  }
};

export function buildGoalContinuationPrompt(
  action: GoalDispatchableContinuation,
  state: HypagraphState,
  operationId: string,
): string {
  if (action.kind === "request-revision") {
    return [
      "Hypagraph automatic bounded revision.",
      `Operation: ${operationId}`,
      `Goal: ${action.goalId}`,
      `Workflow: ${action.workflowId}`,
      `Revision: ${action.revision}`,
      `Exact objective: ${state.definition.goal}`,
      `Blocker: ${action.blocker.kind} '${action.blocker.id}' - ${action.blocker.reason}`,
      "This is the only automatic revision attempt.",
      "Propose one complete replacement definition with hypagoal_submit_revision.",
      "Keep the exact objective byte-for-byte. Add or reroute only bounded repository work which addresses the blocker.",
      "Preserve typed success, checks, gates, evidence, evaluator trust, failure policy, hard limits, and goal budgets.",
      "Preserve unchanged valid completed work where possible. Do not mark the goal complete.",
      "The canonical reducer will validate and apply or reject the proposal.",
    ].join("\n");
  }
  const loop = projectGoalLoopContinuationGuidance(state, action);
  return [
    "Hypagraph automatic continuation.",
    `Operation: ${operationId}`,
    `Goal: ${action.goalId}`,
    `Workflow: ${action.workflowId}`,
    `Revision: ${action.revision}`,
    `Selected action: ${actionLabel(action)}`,
    ...(action.loopId ? [`Loop: ${action.loopId}`] : []),
    ...(loop ? [`Loop iteration: ${loop.iteration}/${loop.maximumIterations}`, `Loop status: ${loop.status}`] : []),
    ...(loop?.evaluation ? [`Evaluation purpose: ${loop.evaluation.purpose}`, `Evaluation feedback: ${loop.evaluation.feedbackMode}`] : []),
    "Continue only the selected canonical action. Use the Hypagraph lifecycle tools. Do not mark the goal complete directly.",
  ].join("\n");
}

export function createPendingGoalContinuation(
  action: GoalDispatchableContinuation,
  committedState: HypagraphState,
  generations: GoalContinuationGeneration,
  operationId: string,
): PendingGoalContinuation {
  const canonical = committedState.goal?.pendingContinuation;
  if (!canonical || canonical.operationId !== operationId) throw new Error("The committed state does not contain the requested durable continuation.");
  return {
    operationId,
    turnId: `hypagoal-turn:${operationId}`,
    action: structuredClone(action),
    requestedOrdinal: canonical.ordinal,
    requestSequence: canonical.requestSequence,
    selectedSequence: canonical.selectedSequence,
    selectedSnapshotHash: canonical.selectedSnapshotHash,
    committedSequence: committedState.sequence,
    committedSnapshotHash: committedState.snapshotHash,
    sessionGeneration: generations.sessionGeneration,
    branchGeneration: generations.branchGeneration,
    prompt: buildGoalContinuationPrompt(action, committedState, operationId),
  };
}

export function validatePendingGoalContinuation(
  pending: PendingGoalContinuation,
  state: HypagraphState | undefined,
  generations: GoalContinuationGeneration,
): GoalContinuationValidation {
  if (!state || !state.goal) return { ok: false, code: "continuation_state_missing", message: "The queued continuation has no active canonical state." };
  const canonical = state.goal.pendingContinuation;
  if (!canonical) return { ok: false, code: "continuation_request_missing", message: "The queued continuation is not present in canonical goal state." };
  if (canonical.operationId !== pending.operationId || canonical.ordinal !== pending.requestedOrdinal || canonical.requestSequence !== pending.requestSequence) return { ok: false, code: "stale_continuation_identity", message: "The durable continuation identity changed before delivery." };
  if (canonical.selectedSequence !== pending.selectedSequence || canonical.selectedSnapshotHash !== pending.selectedSnapshotHash) return { ok: false, code: "stale_continuation_selection", message: "The durable continuation selection changed before delivery." };
  if (pending.sessionGeneration !== generations.sessionGeneration) return { ok: false, code: "stale_continuation_session", message: "The Pi session generation changed before continuation delivery." };
  if (pending.branchGeneration !== generations.branchGeneration) return { ok: false, code: "stale_continuation_branch", message: "The Pi branch generation changed before continuation delivery." };
  if (pending.action.goalId !== state.goal.goalId) return { ok: false, code: "stale_continuation_goal", message: "The active goal changed before continuation delivery." };
  if (pending.action.workflowId !== state.workflowId) return { ok: false, code: "stale_continuation_workflow", message: "The active workflow changed before continuation delivery." };
  if (pending.action.revision !== state.revision) return { ok: false, code: "stale_continuation_revision", message: "The workflow revision changed before continuation delivery." };
  if (pending.committedSequence !== state.sequence) return { ok: false, code: "stale_continuation_sequence", message: "The workflow sequence changed before continuation delivery." };
  if (pending.committedSnapshotHash !== state.snapshotHash) return { ok: false, code: "stale_continuation_snapshot", message: "The workflow snapshot changed before continuation delivery." };
  if (pending.requestedOrdinal !== state.goal.continuationOrdinal) return { ok: false, code: "stale_continuation_ordinal", message: "The continuation ordinal changed before continuation delivery." };
  if (!continuationActionIsRunnable(state, pending.action)) return { ok: false, code: "stale_continuation_action", message: "The selected action is no longer runnable." };
  return { ok: true };
}

export function continuationSystemPrompt(pending: PendingGoalContinuation, state: HypagraphState): string {
  const action = pending.action;
  if (action.kind === "request-revision") {
    const visible = projectModelVisibleWorkflowSummary(state);
    return [
      "HYPAGOAL BOUNDED REVISION CONTROL:",
      `Operation '${pending.operationId}' is the only automatic revision attempt for this root goal.`,
      `Exact objective: ${state.definition.goal}`,
      `Canonical blocker: ${action.blocker.kind} '${action.blocker.id}' - ${action.blocker.reason}`,
      `Allowed scope: add or reroute bounded repository work which addresses this blocker.`,
      "The replacement definition must preserve the objective byte-for-byte.",
      "It must preserve typed success, evaluator trust and isolation, checks, gates, evidence, acceptance requirements, failure policy, and all hard budgets.",
      "Do not delete incomplete work. Do not mark nodes or the goal complete. Do not infer success from a score.",
      "Keep unchanged valid completed work unchanged where possible.",
      "Call hypagoal_submit_revision once with one complete replacement definition. The reducer decides whether it is valid and whether execution can resume.",
      `Model-visible canonical summary:\n${JSON.stringify(visible, null, 2)}`,
    ].join("\n");
  }
  const common = [
    "HYPAGOAL CONTINUATION CONTROL:",
    `Operation '${pending.operationId}' selected ${actionLabel(action)}.`,
    `Goal '${action.goalId}', workflow '${action.workflowId}', revision ${action.revision}, sequence ${state.sequence}, continuation ordinal ${pending.requestedOrdinal}.`,
    ...(action.loopId ? [`The selected action belongs to loop '${action.loopId}'.`] : []),
    ...renderGoalLoopContinuationGuidance(state, action),
  ];
  if (action.kind === "continue-active-task") common.push(`Continue only task '${action.nodeId}'. Publish declared facts, submit evidence, and use a separate verification action. Do not start another node.`);
  else if (action.kind === "start-ready-task") common.push(`Start task '${action.nodeId}' with hypagraph_transition before repository changes. Work only in its declared scope. Then publish facts, submit evidence, and verify it.`);
  else if (action.kind === "run-ready-check") common.push(`Run check '${action.nodeId}' with hypagraph_run_check. Do not start it with hypagraph_transition.`);
  else common.push(`Evaluate gate '${action.nodeId}' with the evaluate action of hypagraph_transition. Do not use model judgement to select the route.`);
  common.push("Do not revise the graph, replace the root, or mark the goal complete unless canonical state requires a separate supported action.");
  return common.join("\n");
}

export function requiredContinuationTools(action: GoalDispatchableContinuation): string[] {
  if (action.kind === "request-revision") return ["hypagraph_read", "hypagoal_submit_revision"];
  if (action.kind === "run-ready-check") return ["hypagraph_read", "hypagraph_run_check", "hypagraph_cancel_check"];
  return ["hypagraph_read", "hypagraph_transition"];
}
