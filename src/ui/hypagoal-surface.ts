import type { DispatchLane } from "../domain/action-dispatch.js";
import { classifyGoalBlockage, type GoalBlockageDecision } from "../domain/goal-blockage.js";
import { selectGoalContinuation, type GoalContinuationDecision } from "../domain/goal-continuation.js";
import type { GoalContinuationAction, HypagraphState } from "../domain/model.js";
import { readyNodeIds } from "../domain/readiness.js";
import { loopSurfaceSummaries, type LoopSurfaceSummary } from "./loop-surface.js";

/**
 * M6A turn accounting. Hypagraph charges a turn for a model-lane action only.
 * A user who compares node count with turn count must not think that work is missing.
 */
export const TURN_ACCOUNTING_NOTE = "Consumed turns count model turns only. "
  + "A deterministic action, such as a ready check or a ready gate, consumes no turn. "
  + "A turn-budget stop ends automatic continuation in every lane.";

export interface HypagoalBudgetSurface {
  consumed: number;
  limit?: number;
  remaining?: number;
}

export interface HypagoalDispatchAction {
  dispatchId: string;
  lane: DispatchLane;
  status: string;
  action: string;
  schedulerOrdinal: number;
}

export interface HypagoalDispatchSurface {
  /** The scheduler ordinal counts every selected action in every lane. */
  scheduledActions: number;
  chargedModelTurns: number;
  turnAccounting: string;
  pending?: HypagoalDispatchAction;
  lastOutcome?: HypagoalDispatchAction;
}

export interface HypagoalSurface {
  objective: string;
  workflow: {
    id: string;
    phase: HypagraphState["phase"];
    revision: number;
    sequence: number;
  };
  goal: {
    id: string;
    status: NonNullable<HypagraphState["goal"]>["status"];
    pauseCause?: NonNullable<HypagraphState["goal"]>["pauseCause"];
    stopReason?: string;
  };
  action: {
    activeNodeId?: string;
    readyNodeIds: string[];
    next: string;
  };
  budget: {
    turns: HypagoalBudgetSurface;
    tokens: HypagoalBudgetSurface;
  };
  dispatch: HypagoalDispatchSurface;
  blockage: GoalBlockageDecision;
  automaticRevision: {
    consumed: number;
    maximum: number;
    remaining: number;
    pending: boolean;
    lastOutcome?: string;
    lastOutcomeCode?: string;
    lastReason?: string;
  };
  loops: LoopSurfaceSummary[];
  stopCode?: string;
  controls: string[];
}

const ACTIVE_NODE_STATUSES = new Set(["starting", "running", "awaiting_evidence", "verifying"]);

const budgetSurface = (consumed: number, limit: number | undefined): HypagoalBudgetSurface => ({
  consumed,
  ...(limit === undefined ? {} : { limit, remaining: Math.max(0, limit - consumed) }),
});

const actionLabel = (action: GoalContinuationAction): string => {
  if (action.kind === "request-revision") return `request one bounded revision for ${action.blocker.kind} '${action.blocker.id}'`;
  const loop = action.loopId ? ` in loop '${action.loopId}'` : "";
  if (action.kind === "continue-active-task") return `continue task '${action.nodeId}'${loop}`;
  if (action.kind === "start-ready-task") return `start task '${action.nodeId}'${loop}`;
  if (action.kind === "run-ready-check") return `run check '${action.nodeId}'${loop}`;
  return `evaluate gate '${action.nodeId}'${loop}`;
};

const decisionLabel = (decision: GoalContinuationDecision): string => {
  if ("nodeId" in decision) return actionLabel(decision);
  if (decision.kind === "request-revision") return actionLabel(decision);
  if (decision.kind === "stop-completed") return "none; the canonical workflow completed";
  if (decision.kind === "stop-paused") return `none; paused: ${decision.reason}`;
  if (decision.kind === "stop-blocked") return `none; blocked: ${decision.reason}`;
  if (decision.kind === "stop-failed") return `none; failed: ${decision.reason}`;
  if (decision.kind === "stop-cancelled") return `none; cancelled: ${decision.reason}`;
  if (decision.kind === "stop-budget-limited") return `none; budget limited: ${decision.reason}`;
  return `none; invariant error: ${decision.reason}`;
};

const stopCode = (
  state: HypagraphState,
  blockage: GoalBlockageDecision,
  loops: readonly LoopSurfaceSummary[],
): string | undefined => {
  const goal = state.goal;
  if (!goal) return undefined;
  if (goal.status === "budget_limited") return goal.budget.stop?.reason ?? "budget_limited";
  if (goal.status === "paused") return `pause_${goal.pauseCause ?? "explicit"}`;
  if (goal.status === "completed" || goal.status === "cancelled") return `goal_${goal.status}`;
  const loopExit = loops.find((loop) => loop.exitReason)?.exitReason;
  if (goal.status === "failed") return loopExit ? `loop_${loopExit}` : "goal_failed";
  if (goal.status === "blocked" && loopExit) return `loop_${loopExit}`;
  const revisionCode = goal.automaticRevision.lastAttempt?.outcomeCode;
  if (revisionCode && goal.status === "blocked") return revisionCode;
  if (blockage.kind === "revision-exhausted") return "automatic_revision_exhausted";
  if (blockage.kind === "revision-not-allowed") return `blocker_${blockage.blocker.kind}`;
  if (blockage.kind === "revision-eligible") return "automatic_revision_eligible";
  if (goal.status === "blocked") return "goal_blocked";
  return undefined;
};

const dispatchAction = (
  value: {
    dispatchId: string;
    lane: DispatchLane;
    status: string;
    schedulerOrdinal: number;
    action: GoalContinuationAction;
  },
): HypagoalDispatchAction => ({
  dispatchId: value.dispatchId,
  lane: value.lane,
  status: value.status,
  action: actionLabel(value.action),
  schedulerOrdinal: value.schedulerOrdinal,
});

const dispatchSurface = (state: HypagraphState): HypagoalDispatchSurface => {
  const goal = state.goal!;
  const runtime = goal.actionDispatch;
  const pending = runtime?.pending;
  const lastOutcome = runtime?.lastOutcome;
  return {
    scheduledActions: goal.schedulerOrdinal ?? goal.continuationOrdinal,
    chargedModelTurns: goal.budget.consumedTurns,
    turnAccounting: TURN_ACCOUNTING_NOTE,
    ...(pending === undefined ? {} : { pending: dispatchAction(pending) }),
    ...(lastOutcome === undefined ? {} : { lastOutcome: dispatchAction(lastOutcome) }),
  };
};

const controls = (state: HypagraphState): string[] => {
  const goal = state.goal;
  if (!goal) return ["/hypagoal <objective>"];
  const values = ["/hypagoal status", "/hypagoal graph"];
  if (goal.status === "active" || goal.status === "blocked") values.push("/hypagoal pause", "/hypagoal cancel");
  else if (goal.status === "paused") values.push("/hypagoal resume", "/hypagoal cancel");
  return values;
};

export function projectHypagoalSurface(state: HypagraphState): HypagoalSurface | undefined {
  const goal = state.goal;
  if (!goal) return undefined;
  const activeNodeId = state.definition.nodes.find((node) => ACTIVE_NODE_STATUSES.has(state.runtime.nodes[node.id]?.status ?? ""))?.id;
  const ready = readyNodeIds(state);
  const blockage = classifyGoalBlockage(state);
  const pendingAction = goal.pendingContinuation?.action;
  const next = pendingAction ? actionLabel(pendingAction) : decisionLabel(selectGoalContinuation(state));
  const lastAttempt = goal.automaticRevision.lastAttempt;
  const loops = loopSurfaceSummaries(state);
  const code = stopCode(state, blockage, loops);
  return {
    objective: state.definition.goal,
    workflow: {
      id: state.workflowId,
      phase: state.phase,
      revision: state.revision,
      sequence: state.sequence,
    },
    goal: {
      id: goal.goalId,
      status: goal.status,
      ...(goal.pauseCause === undefined ? {} : { pauseCause: goal.pauseCause }),
      ...(goal.stopReason === undefined ? {} : { stopReason: goal.stopReason }),
    },
    action: {
      ...(activeNodeId === undefined ? {} : { activeNodeId }),
      readyNodeIds: ready,
      next,
    },
    budget: {
      turns: budgetSurface(goal.budget.consumedTurns, goal.budget.limits.maximumTurns),
      tokens: budgetSurface(goal.budget.consumedTokens.totalTokens, goal.budget.limits.maximumTokens),
    },
    dispatch: dispatchSurface(state),
    blockage,
    automaticRevision: {
      consumed: goal.automaticRevision.consumedAttempts,
      maximum: goal.automaticRevision.maximumAttempts,
      remaining: Math.max(0, goal.automaticRevision.maximumAttempts - goal.automaticRevision.consumedAttempts),
      pending: goal.pendingContinuation?.action.kind === "request-revision" || lastAttempt?.outcome === "pending",
      ...(lastAttempt?.outcome === undefined ? {} : { lastOutcome: lastAttempt.outcome }),
      ...(lastAttempt?.outcomeCode === undefined ? {} : { lastOutcomeCode: lastAttempt.outcomeCode }),
      ...(lastAttempt?.reason === undefined ? {} : { lastReason: lastAttempt.reason }),
    },
    loops,
    ...(code === undefined ? {} : { stopCode: code }),
    controls: controls(state),
  };
}

const displayBudget = (budget: HypagoalBudgetSurface): string =>
  budget.limit === undefined
    ? `${budget.consumed}/unlimited`
    : `${budget.consumed}/${budget.limit} (${budget.remaining} remaining)`;

const blockageLine = (blockage: GoalBlockageDecision): string => {
  if (blockage.kind === "not-blocked") return "none";
  const prefix = blockage.kind === "revision-eligible"
    ? "revision eligible"
    : blockage.kind === "revision-exhausted"
      ? "revision exhausted"
      : "revision not allowed";
  return `${prefix}; ${blockage.blocker.kind} '${blockage.blocker.id}': ${"reason" in blockage ? blockage.reason : blockage.blocker.reason}`;
};

const loopLine = (loop: LoopSurfaceSummary, compact: boolean): string => {
  const progress = loop.progress
    ? `; metric ${loop.progress.currentMetric ?? "none"}, best ${loop.progress.bestMetric ?? "none"}${loop.progress.bestIteration === undefined ? "" : ` at ${loop.progress.bestIteration}`}${loop.progress.patience === undefined ? "" : `, patience ${loop.progress.remainingPatience}/${loop.progress.patience}`}`
    : "";
  const validity = loop.evaluation
    ? `; valid ${loop.evaluation.lastValid ?? "none"}, invalid ${loop.evaluation.invalidCount}/${loop.evaluation.maximumInvalid}`
    : "";
  const budget = loop.evaluationBudget
    ? `; eval ${loop.evaluationBudget.kind} ${loop.evaluationBudget.count}/${loop.evaluationBudget.maximum ?? "unlimited"}, total ${loop.evaluationBudget.totalCount}/${loop.evaluationBudget.totalMaximum ?? "unlimited"}`
    : "";
  const evaluator = loop.evaluator
    ? `; trust ${loop.evaluator.trustLevel ?? "undeclared"}, integrity ${loop.evaluator.integrityStatus ?? "undeclared"}`
    : "";
  const stop = loop.exitReason ? `; exit ${loop.exitReason}` : "";
  const text = `${loop.id}: ${loop.status}; iteration ${loop.iteration.current}/${loop.iteration.limit}; typed success ${loop.lastSuccess ?? "none"}${validity}${progress}${budget}${evaluator}${stop}`;
  return compact ? text.replaceAll("; ", " · ") : text;
};

const wrap = (prefix: string, value: string, width: number): string[] => {
  const safeWidth = Math.max(24, width);
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = prefix;
  for (const word of words) {
    const separator = line === prefix ? "" : " ";
    if (line.length + separator.length + word.length <= safeWidth) {
      line += `${separator}${word}`;
      continue;
    }
    lines.push(line);
    line = `${" ".repeat(prefix.length)}${word}`;
  }
  lines.push(line);
  return lines;
};

const fit = (line: string, width: number): string =>
  line.length <= width ? line : `${line.slice(0, Math.max(1, width - 1))}…`;

export function renderHypagoalStatus(state: HypagraphState, width = 100): string {
  const surface = projectHypagoalSurface(state);
  if (!surface) return "There is no active Hypagoal. Use /hypagoal <objective> to create one.";
  const narrow = width < 80;
  const lines: string[] = [];
  if (narrow) {
    lines.push(`Hypagoal ${surface.goal.status} · workflow ${surface.workflow.phase}`);
    lines.push(...wrap("Objective: ", surface.objective, width));
    lines.push(...wrap("Next: ", surface.action.next, width));
    lines.push(`Ready: ${surface.action.readyNodeIds.join(", ") || "none"}`);
    lines.push(`Budget: turns ${displayBudget(surface.budget.turns)}; tokens ${displayBudget(surface.budget.tokens)}`);
    lines.push(`Actions: ${surface.dispatch.scheduledActions} scheduled · ${surface.dispatch.chargedModelTurns} model turns charged`);
    lines.push(...wrap("Turns: ", surface.dispatch.turnAccounting, width));
    lines.push(`Revision: ${surface.automaticRevision.consumed}/${surface.automaticRevision.maximum}${surface.automaticRevision.pending ? " pending" : ""}${surface.automaticRevision.lastOutcomeCode ? ` · ${surface.automaticRevision.lastOutcomeCode}` : ""}`);
    if (surface.stopCode || surface.goal.stopReason) lines.push(...wrap(`Stop ${surface.stopCode ?? "reason"}: `, surface.goal.stopReason ?? "none", width));
    if (surface.blockage.kind !== "not-blocked") lines.push(...wrap("Blockage: ", blockageLine(surface.blockage), width));
    for (const loop of surface.loops) lines.push(...wrap("Loop: ", loopLine(loop, true), width));
    lines.push(...wrap("Controls: ", surface.controls.join(" · "), width));
    return lines.map((line) => fit(line, width)).join("\n");
  }

  lines.push("Hypagoal status");
  lines.push(...wrap("Objective: ", surface.objective, width));
  lines.push(`Workflow: ${surface.workflow.id} | phase ${surface.workflow.phase} | revision ${surface.workflow.revision} | event ${surface.workflow.sequence}`);
  lines.push(`Goal: ${surface.goal.id} | status ${surface.goal.status}${surface.goal.pauseCause ? ` | pause ${surface.goal.pauseCause}` : ""}`);
  lines.push(`Current action: ${surface.action.activeNodeId ?? "none"}`);
  lines.push(...wrap("Next action: ", surface.action.next, width));
  lines.push(`Ready work: ${surface.action.readyNodeIds.join(", ") || "none"}`);
  lines.push(`Goal budget: turns ${displayBudget(surface.budget.turns)}; tokens ${displayBudget(surface.budget.tokens)}`);
  lines.push(`Scheduled actions: ${surface.dispatch.scheduledActions}; charged model turns ${surface.dispatch.chargedModelTurns}`);
  lines.push(...wrap("Turn accounting: ", surface.dispatch.turnAccounting, width));
  const lastDispatch = surface.dispatch.pending ?? surface.dispatch.lastOutcome;
  if (lastDispatch) {
    lines.push(...wrap("Last action: ", `${lastDispatch.lane} lane; ${lastDispatch.status}; ordinal ${lastDispatch.schedulerOrdinal}; ${lastDispatch.action}`, width));
  }
  lines.push(`Automatic revision: ${surface.automaticRevision.consumed}/${surface.automaticRevision.maximum}; remaining ${surface.automaticRevision.remaining}${surface.automaticRevision.pending ? "; pending" : ""}${surface.automaticRevision.lastOutcome ? `; last ${surface.automaticRevision.lastOutcome}` : ""}${surface.automaticRevision.lastOutcomeCode ? ` (${surface.automaticRevision.lastOutcomeCode})` : ""}`);
  lines.push(...wrap("Blockage: ", blockageLine(surface.blockage), width));
  if (surface.loops.length > 0) {
    lines.push("Loop and evaluation state:");
    for (const loop of surface.loops) lines.push(...wrap(`- ${loop.id}: `, loopLine(loop, false).replace(`${loop.id}: `, ""), width));
  }
  if (surface.stopCode || surface.goal.stopReason) {
    lines.push(...wrap(`Stop ${surface.stopCode ?? "reason"}: `, surface.goal.stopReason ?? surface.automaticRevision.lastReason ?? "none", width));
  }
  lines.push(...wrap("Controls: ", surface.controls.join(" | "), width));
  return lines.map((line) => fit(line, width)).join("\n");
}

export function renderHypagoalLifecycleMessage(state: HypagraphState): string {
  const surface = projectHypagoalSurface(state);
  if (!surface) return "There is no active Hypagoal.";
  const stop = surface.stopCode ? ` Stop: ${surface.stopCode}${surface.goal.stopReason ? ` — ${surface.goal.stopReason}` : ""}.` : "";
  return `Hypagoal ${surface.goal.status}; workflow ${surface.workflow.phase}; next ${surface.action.next}; model turns ${displayBudget(surface.budget.turns)}; tokens ${displayBudget(surface.budget.tokens)}; scheduled actions ${surface.dispatch.scheduledActions}; revision ${surface.automaticRevision.consumed}/${surface.automaticRevision.maximum}.${stop}`;
}
