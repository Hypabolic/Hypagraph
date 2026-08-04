/**
 * Transport-independent family graph and executor status projection.
 *
 * This module projects a GoalFamilyRuntime and member workflow states into a
 * view model for status text and graph pane chrome. It does not mutate inputs.
 * It does not invent parent-definition edges for child workflows.
 *
 * Each member workflow remains a nested boundary. Independent components stay
 * independent. Protected evaluator free text is redacted per member policy.
 */

import type { ExecutorKind } from "../domain/executor-contract.js";
import type {
  ChildGoalBindingStatus,
  ChildGoalFailurePolicy,
  ChildReturnOutcomeKind,
  FamilyDispatchPendingStatus,
  FamilyDispatchTerminalStatus,
  FamilySelectedAction,
  GoalFamilyMember,
  GoalFamilyRuntime,
} from "../domain/goal-family.js";
import type { GoalContinuationAction, HypagraphState, WorkflowPhase } from "../domain/model.js";
import {
  PROTECTED_DETAIL,
  protectedTextPolicy,
} from "../domain/presentation-redaction.js";
import { projectGraphView, type GraphViewModel } from "./projection.js";

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

/** One step on the root-to-leaf ancestry path for a focused goal. */
export interface FamilyAncestryStepView {
  goalId: string;
  workflowId: string;
  depth: number;
  parentNodeId?: string;
}

/** Family-level binding edge. This is not a definition edge inside a workflow. */
export interface FamilyBindingEdgeView {
  bindingId: string;
  parentGoalId: string;
  parentWorkflowId: string;
  parentNodeId: string;
  childGoalId: string;
  childWorkflowId: string;
  status: ChildGoalBindingStatus;
  failurePolicy: ChildGoalFailurePolicy;
  returnOutcome?: ChildReturnOutcomeKind;
  /** Redacted when the child workflow protected the free text. */
  returnStopReason?: string;
}

/**
 * Nested workflow boundary for one family member.
 * The graph field is a full workflow projection. It is never merged into a parent.
 */
export interface FamilyMemberBoundaryView {
  goalId: string;
  workflowId: string;
  depth: number;
  parentGoalId?: string;
  parentNodeId?: string;
  childGoalIds: string[];
  /** Expand/collapse for nested UI. Root defaults to expanded. */
  expanded: boolean;
  /** True when this member is the focused workflow graph. */
  focused: boolean;
  title: string;
  /** Present when the member workflow state is available. */
  phase?: WorkflowPhase;
  goalStatus?: NonNullable<HypagraphState["goal"]>["status"];
  objective: string;
  nodeCount: number;
  readyNodeIds: string[];
  activeNodeId?: string;
  /** Present when expanded or focused so layout can render the nested graph. */
  graph?: GraphViewModel;
}

export interface FamilyBoundsView {
  maxDepth: number;
  maxChildrenPerGoal: number;
  maxGoalsInFamily: number;
  maxChildCreationAttemptsPerNode: number;
  memberCount: number;
}

export interface FamilyBudgetView {
  turns: { reserved: number; limit?: number; remaining?: number };
  tokens: { reserved: number; limit?: number; remaining?: number };
}

/** Identity-only projection of one family dispatch selection. */
export interface FamilyDispatchSelectionView {
  dispatchId: string;
  goalId: string;
  workflowId: string;
  revision: number;
  nodeId?: string;
  loopId?: string;
  actionKind: string;
  /** Safe public reason only. Protected secrets are replaced. */
  reason?: string;
}

export interface FamilyPendingDispatchView extends FamilyDispatchSelectionView {
  status: FamilyDispatchPendingStatus;
}

export interface FamilyDispatchOutcomeView extends FamilyDispatchSelectionView {
  status: FamilyDispatchTerminalStatus;
}

export interface FamilySchedulerStatusView {
  schedulerOrdinal: number;
  /** First pending for compact surfaces (stable list order). */
  pending?: FamilyPendingDispatchView;
  /** All in-flight family dispatches in stable order. */
  pendings?: FamilyPendingDispatchView[];
  lastOutcome?: FamilyDispatchOutcomeView;
}

/**
 * Optional host process snapshot. Pure input from the product layer.
 * Projection does not spawn processes or read a registry.
 */
export interface FamilyExecutorHostSnapshot {
  kind: ExecutorKind;
  executorId?: string;
  profileKind?: ExecutorKind;
  activeProcessCount?: number;
}

export interface FamilyExecutorStatusView {
  /** Labels consistent with ExecutorKind. */
  kindLabel: string;
  profileKind?: ExecutorKind;
  executorId?: string;
  activeProcessCount?: number;
  /** Human-readable summary for status surfaces. */
  summary: string;
}

/**
 * Independent component identity across nested workflows.
 * Components never gain false edges across workflow boundaries.
 */
export interface FamilyIndependentComponentView {
  workflowId: string;
  goalId: string;
  componentId: string;
  nodeIds: string[];
}

export interface FamilyGraphViewModel {
  familyId: string;
  rootGoalId: string;
  focusedGoalId: string;
  memberCount: number;
  ancestry: FamilyAncestryStepView[];
  members: FamilyMemberBoundaryView[];
  bindings: FamilyBindingEdgeView[];
  bounds: FamilyBoundsView;
  budget: FamilyBudgetView;
  scheduler: FamilySchedulerStatusView;
  executor?: FamilyExecutorStatusView;
  independentComponents: FamilyIndependentComponentView[];
  /**
   * Focused member graph for the existing single-workflow renderer.
   * Absent only when the focused member state is missing.
   */
  focusedGraph?: GraphViewModel;
}

export interface ProjectFamilyGraphViewInput {
  family: GoalFamilyRuntime;
  /**
   * Member workflow states keyed by goal ID.
   * Missing members appear as identity-only boundaries without a nested graph.
   */
  memberStates: Readonly<Record<string, HypagraphState>>;
  /** Goal which owns the primary graph. Defaults to the family root. */
  focusedGoalId?: string;
  /**
   * Goal IDs whose nested graphs are expanded.
   * When omitted, the root and the focused goal are expanded.
   */
  expandedGoalIds?: ReadonlySet<string> | readonly string[];
  /** Optional isolated-Pi or other host status. Pure input. */
  executorHost?: FamilyExecutorHostSnapshot;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXECUTOR_KIND_LABELS: Record<ExecutorKind, string> = {
  "current-session": "current-session",
  "isolated-pi": "isolated-pi",
  acp: "acp",
  cli: "cli",
  deterministic: "deterministic",
};

const actionKind = (action: GoalContinuationAction): string => action.kind;

const toExpandedSet = (
  family: GoalFamilyRuntime,
  focusedGoalId: string,
  expandedGoalIds: ProjectFamilyGraphViewInput["expandedGoalIds"],
): Set<string> => {
  if (expandedGoalIds === undefined) {
    return new Set([family.rootGoalId, focusedGoalId]);
  }
  if (expandedGoalIds instanceof Set) return new Set(expandedGoalIds);
  return new Set(expandedGoalIds);
};

const memberStatesByGoal = (
  family: GoalFamilyRuntime,
  memberStates: Readonly<Record<string, HypagraphState>>,
): Map<string, HypagraphState> => {
  const byGoal = new Map<string, HypagraphState>();
  for (const [goalId, state] of Object.entries(memberStates)) {
    const member = family.members[goalId];
    if (!member) continue;
    if (state.workflowId !== member.workflowId) continue;
    byGoal.set(goalId, state);
  }
  return byGoal;
};

/**
 * Redact free text with the member protection policy.
 * When owner node or loop is protected, replace even if the text is not yet a stored secret.
 * When conservative is true and the member has any protected evaluator, replace the text.
 */
const redactMemberText = (
  value: string | undefined,
  memberState: HypagraphState | undefined,
  owner?: { nodeId?: string; loopId?: string },
  conservativeWhenProtected = false,
): string | undefined => {
  if (value === undefined) return undefined;
  if (!memberState) return value;
  const policy = protectedTextPolicy(memberState);
  if (conservativeWhenProtected && policy.active) return PROTECTED_DETAIL;
  return policy.text(value, owner);
};

/**
 * Owner identity for a family selection or outcome reason.
 * Work actions use nodeId/loopId. Revision actions use the blocker identity.
 * Ambiguous blockers mark conservative redaction when a protected evaluator exists.
 */
const selectionOwner = (
  selection: FamilySelectedAction,
): { owner: { nodeId?: string; loopId?: string }; conservative: boolean } => {
  const action = selection.action;
  if (action.kind === "request-revision") {
    const { kind, id } = action.blocker;
    if (kind === "blocked-loop" || kind === "loop-dependants") {
      return { owner: { loopId: id }, conservative: false };
    }
    if (kind === "blocked-node" || kind === "terminal-policy") {
      return { owner: { nodeId: id }, conservative: false };
    }
    // Ambiguous blocker kinds (legacy definition, external dependency, …):
    // try both owner slots and redact conservatively when the member is protected.
    return { owner: { nodeId: id, loopId: id }, conservative: true };
  }
  const nodeId = selection.nodeId
    ?? ("nodeId" in action ? action.nodeId : undefined);
  const loopId = selection.loopId
    ?? ("loopId" in action ? action.loopId : undefined);
  return {
    owner: {
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(loopId === undefined ? {} : { loopId }),
    },
    conservative: false,
  };
};

const ancestryFor = (
  family: GoalFamilyRuntime,
  focusedGoalId: string,
): FamilyAncestryStepView[] => {
  const steps: FamilyAncestryStepView[] = [];
  let currentId: string | undefined = focusedGoalId;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const member: GoalFamilyMember | undefined = family.members[currentId];
    if (!member) break;
    steps.push({
      goalId: member.goalId,
      workflowId: member.workflowId,
      depth: member.depth,
      ...(member.parent?.parentNodeId === undefined
        ? {}
        : { parentNodeId: member.parent.parentNodeId }),
    });
    currentId = member.parent?.parentGoalId;
  }
  return steps.reverse();
};

/**
 * Recompute root-to-focused ancestry from member boundary views.
 * Used when UI focus changes without re-projecting the whole family.
 */
export function ancestryFromMembers(
  members: readonly FamilyMemberBoundaryView[],
  focusedGoalId: string,
): FamilyAncestryStepView[] {
  const byGoal = new Map(members.map((member) => [member.goalId, member]));
  const steps: FamilyAncestryStepView[] = [];
  let currentId: string | undefined = focusedGoalId;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const member = byGoal.get(currentId);
    if (!member) break;
    steps.push({
      goalId: member.goalId,
      workflowId: member.workflowId,
      depth: member.depth,
      ...(member.parentNodeId === undefined ? {} : { parentNodeId: member.parentNodeId }),
    });
    currentId = member.parentGoalId;
  }
  return steps.reverse();
}

const orderedMembers = (family: GoalFamilyRuntime): string[] =>
  Object.values(family.members)
    .slice()
    .sort((left, right) => left.depth - right.depth || left.goalId.localeCompare(right.goalId))
    .map((member) => member.goalId);

const projectSelection = (
  selection: FamilySelectedAction,
  byGoal: ReadonlyMap<string, HypagraphState>,
): Omit<FamilyDispatchSelectionView, "dispatchId"> => {
  const memberState = byGoal.get(selection.goalId);
  const { owner, conservative } = selectionOwner(selection);
  const reason = redactMemberText(selection.reason, memberState, owner, conservative);
  return {
    goalId: selection.goalId,
    workflowId: selection.workflowId,
    revision: selection.revision,
    ...(selection.nodeId === undefined ? {} : { nodeId: selection.nodeId }),
    ...(selection.loopId === undefined ? {} : { loopId: selection.loopId }),
    actionKind: actionKind(selection.action),
    ...(reason === undefined ? {} : { reason }),
  };
};

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Project family membership, nested workflow boundaries, bindings, budgets,
 * scheduler dispatch, and optional executor host status.
 *
 * Missing member states produce identity-only boundaries without nested graphs.
 * Child graphs are never merged into the parent definition graph.
 */
export function projectFamilyGraphView(input: ProjectFamilyGraphViewInput): FamilyGraphViewModel {
  const { family } = input;
  const focusedGoalId = input.focusedGoalId && family.members[input.focusedGoalId]
    ? input.focusedGoalId
    : family.rootGoalId;
  const expanded = toExpandedSet(family, focusedGoalId, input.expandedGoalIds);
  const byGoal = memberStatesByGoal(family, input.memberStates);

  const members: FamilyMemberBoundaryView[] = orderedMembers(family).map((goalId) => {
    const member = family.members[goalId]!;
    const state = byGoal.get(goalId);
    const isExpanded = expanded.has(goalId);
    const isFocused = goalId === focusedGoalId;
    // Always project the member graph when state exists so expand/collapse is UI-only.
    // Expanded controls nested display. Focused selects the primary graph.
    const graph = state ? projectGraphView(state) : undefined;
    return {
      goalId: member.goalId,
      workflowId: member.workflowId,
      depth: member.depth,
      ...(member.parent === undefined
        ? {}
        : {
          parentGoalId: member.parent.parentGoalId,
          parentNodeId: member.parent.parentNodeId,
        }),
      childGoalIds: [...member.childGoalIds].sort(),
      expanded: isExpanded,
      focused: isFocused,
      title: state?.definition.title ?? member.workflowId,
      ...(state === undefined ? {} : { phase: state.phase }),
      ...(state?.goal === undefined ? {} : { goalStatus: state.goal.status }),
      objective: state?.definition.goal ?? "",
      nodeCount: state?.definition.nodes.length ?? 0,
      readyNodeIds: graph?.readyNodeIds ?? [],
      ...(graph?.activeNodeId === undefined ? {} : { activeNodeId: graph.activeNodeId }),
      ...(graph === undefined ? {} : { graph }),
    };
  });

  const bindings: FamilyBindingEdgeView[] = Object.values(family.bindings)
    .slice()
    .sort((left, right) => left.bindingId.localeCompare(right.bindingId))
    .map((binding) => {
      const childMember = family.members[binding.childGoalId];
      const childState = byGoal.get(binding.childGoalId);
      // Child return free text: owner is not always known. When the child has a
      // protected evaluator, apply conservative replacement.
      const returnStopReason = redactMemberText(
        binding.returnRecord?.stopReason,
        childState,
        undefined,
        true,
      );
      return {
        bindingId: binding.bindingId,
        parentGoalId: binding.parentGoalId,
        parentWorkflowId: binding.parentWorkflowId,
        parentNodeId: binding.parentNodeId,
        childGoalId: binding.childGoalId,
        childWorkflowId: childMember?.workflowId ?? "",
        status: binding.status,
        failurePolicy: binding.failurePolicy,
        ...(binding.returnRecord === undefined
          ? {}
          : { returnOutcome: binding.returnRecord.outcome }),
        ...(returnStopReason === undefined ? {} : { returnStopReason }),
      };
    });

  const budgetLimits = family.familyBudget.limits;
  const budget: FamilyBudgetView = {
    turns: {
      reserved: family.familyBudget.reservedTurns,
      ...(budgetLimits.maximumTurns === undefined
        ? {}
        : {
          limit: budgetLimits.maximumTurns,
          remaining: Math.max(0, budgetLimits.maximumTurns - family.familyBudget.reservedTurns),
        }),
    },
    tokens: {
      reserved: family.familyBudget.reservedTokens,
      ...(budgetLimits.maximumTokens === undefined
        ? {}
        : {
          limit: budgetLimits.maximumTokens,
          remaining: Math.max(0, budgetLimits.maximumTokens - family.familyBudget.reservedTokens),
        }),
    },
  };

  const scheduler: FamilySchedulerStatusView = {
    schedulerOrdinal: family.schedulerOrdinal,
  };
  const pendingList = Object.values(family.pendingDispatches ?? {}).sort((left, right) => {
    if (left.schedulerOrdinal !== right.schedulerOrdinal) {
      return left.schedulerOrdinal - right.schedulerOrdinal;
    }
    if (left.dispatchId < right.dispatchId) return -1;
    if (left.dispatchId > right.dispatchId) return 1;
    return 0;
  });
  if (pendingList.length > 0) {
    const pendingViews = pendingList.map((pending) => ({
      dispatchId: pending.dispatchId,
      status: pending.status,
      ...projectSelection(pending.selection, byGoal),
    }));
    scheduler.pendings = pendingViews;
    const firstPending = pendingViews[0];
    if (firstPending) scheduler.pending = firstPending;
  }
  if (family.lastDispatchOutcome) {
    const outcome = family.lastDispatchOutcome;
    const memberState = byGoal.get(outcome.selection.goalId);
    const { owner, conservative } = selectionOwner(outcome.selection);
    const reason = redactMemberText(outcome.reason, memberState, owner, conservative);
    scheduler.lastOutcome = {
      dispatchId: outcome.dispatchId,
      status: outcome.status,
      ...projectSelection(outcome.selection, byGoal),
      ...(reason === undefined ? {} : { reason }),
    };
  }

  const independentComponents: FamilyIndependentComponentView[] = [];
  for (const member of members) {
    const graph = member.graph;
    if (!graph?.components) continue;
    for (const component of graph.components) {
      independentComponents.push({
        workflowId: member.workflowId,
        goalId: member.goalId,
        componentId: component.id,
        nodeIds: [...component.nodeIds],
      });
    }
  }
  independentComponents.sort(
    (left, right) =>
      left.workflowId.localeCompare(right.workflowId)
      || left.componentId.localeCompare(right.componentId),
  );

  const focusedMember = members.find((member) => member.focused);
  const focusedGraph = focusedMember?.graph;

  return {
    familyId: family.familyId,
    rootGoalId: family.rootGoalId,
    focusedGoalId,
    memberCount: members.length,
    ancestry: ancestryFor(family, focusedGoalId),
    members,
    bindings,
    bounds: {
      maxDepth: family.bounds.maxDepth,
      maxChildrenPerGoal: family.bounds.maxChildrenPerGoal,
      maxGoalsInFamily: family.bounds.maxGoalsInFamily,
      maxChildCreationAttemptsPerNode: family.bounds.maxChildCreationAttemptsPerNode,
      memberCount: members.length,
    },
    budget,
    scheduler,
    ...(input.executorHost === undefined
      ? {}
      : { executor: projectFamilyExecutorStatus(input.executorHost) }),
    independentComponents,
    ...(focusedGraph === undefined ? {} : { focusedGraph }),
  };
}

/**
 * Project executor host status for status and graph chrome.
 * Pass process counts as pure inputs. This helper does not touch a process registry.
 */
export function projectFamilyExecutorStatus(
  host: FamilyExecutorHostSnapshot,
): FamilyExecutorStatusView {
  const kindLabel = EXECUTOR_KIND_LABELS[host.kind] ?? host.kind;
  const profileKind = host.profileKind ?? host.kind;
  const parts = [`executor ${kindLabel}`];
  if (host.executorId) parts.push(`id ${host.executorId}`);
  if (profileKind) parts.push(`profile ${profileKind}`);
  if (host.activeProcessCount !== undefined) {
    parts.push(`active processes ${host.activeProcessCount}`);
  }
  return {
    kindLabel,
    profileKind,
    ...(host.executorId === undefined ? {} : { executorId: host.executorId }),
    ...(host.activeProcessCount === undefined
      ? {}
      : { activeProcessCount: host.activeProcessCount }),
    summary: parts.join("; "),
  };
}

/**
 * Project scheduler and executor dispatch status from family state.
 * Optional host snapshot adds process counts without coupling to transport.
 */
export function projectFamilyDispatchStatus(
  family: GoalFamilyRuntime,
  memberStates: Readonly<Record<string, HypagraphState>> = {},
  executorHost?: FamilyExecutorHostSnapshot,
): {
  scheduler: FamilySchedulerStatusView;
  executor?: FamilyExecutorStatusView;
} {
  const byGoal = memberStatesByGoal(family, memberStates);
  const scheduler: FamilySchedulerStatusView = {
    schedulerOrdinal: family.schedulerOrdinal,
  };
  const pendingList = Object.values(family.pendingDispatches ?? {}).sort((left, right) => {
    if (left.schedulerOrdinal !== right.schedulerOrdinal) {
      return left.schedulerOrdinal - right.schedulerOrdinal;
    }
    if (left.dispatchId < right.dispatchId) return -1;
    if (left.dispatchId > right.dispatchId) return 1;
    return 0;
  });
  if (pendingList.length > 0) {
    const pendingViews = pendingList.map((pending) => ({
      dispatchId: pending.dispatchId,
      status: pending.status,
      ...projectSelection(pending.selection, byGoal),
    }));
    scheduler.pendings = pendingViews;
    const firstPending = pendingViews[0];
    if (firstPending) scheduler.pending = firstPending;
  }
  if (family.lastDispatchOutcome) {
    const outcome = family.lastDispatchOutcome;
    const memberState = byGoal.get(outcome.selection.goalId);
    const { owner, conservative } = selectionOwner(outcome.selection);
    const reason = redactMemberText(outcome.reason, memberState, owner, conservative);
    scheduler.lastOutcome = {
      dispatchId: outcome.dispatchId,
      status: outcome.status,
      ...projectSelection(outcome.selection, byGoal),
      ...(reason === undefined ? {} : { reason }),
    };
  }
  return {
    scheduler,
    ...(executorHost === undefined
      ? {}
      : { executor: projectFamilyExecutorStatus(executorHost) }),
  };
}

/**
 * Build the default expanded set: root plus focused goal.
 * Callers can toggle child goals for expand/collapse without merging graphs.
 */
export function defaultExpandedFamilyGoalIds(
  family: GoalFamilyRuntime,
  focusedGoalId?: string,
): Set<string> {
  const focused = focusedGoalId && family.members[focusedGoalId]
    ? focusedGoalId
    : family.rootGoalId;
  return new Set([family.rootGoalId, focused]);
}

/**
 * Toggle expansion of one child goal. Root expansion stays true.
 * Expansion never merges child nodes into a parent graph.
 */
export function toggleFamilyMemberExpanded(
  expandedGoalIds: ReadonlySet<string>,
  goalId: string,
  rootGoalId: string,
): Set<string> {
  const next = new Set(expandedGoalIds);
  if (goalId === rootGoalId) {
    next.add(rootGoalId);
    return next;
  }
  if (next.has(goalId)) next.delete(goalId);
  else next.add(goalId);
  return next;
}
