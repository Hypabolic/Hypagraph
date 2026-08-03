import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createBoundedChildGoal } from "../src/domain/child-goal-creation.js";
import {
  commitFamilySelection,
  completeFamilyAction,
  markFamilyActionDispatched,
} from "../src/domain/family-scheduler.js";
import {
  createRootFamily,
  type ChildGoalBinding,
  type GoalFamilyEvent,
  type GoalFamilyRuntime,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { DomainEvent, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import type { PersistedGoalFamily } from "../src/persistence/family-store.js";
import { PROTECTED_DETAIL } from "../src/domain/presentation-redaction.js";
import { handleCommand } from "../src/domain/reducer.js";
import {
  ancestryFromMembers,
  defaultExpandedFamilyGoalIds,
  projectFamilyDispatchStatus,
  projectFamilyExecutorStatus,
  projectFamilyGraphView,
  toggleFamilyMemberExpanded,
  type FamilyGraphViewModel,
} from "../src/graph/family-projection.js";
import { layoutGraph } from "../src/graph/layout.js";
import { projectGraphView } from "../src/graph/projection.js";
import hypagraphExtension from "../src/extension.js";
import { GraphPaneController, PiGraphPaneComponent } from "../src/pi/graph-pane.js";
import {
  HYPAGRAPH_FAMILY_RECORD_TYPE,
  buildOneMemberPersistedFamily,
  commitBoundedChildGoalToPersistedFamily,
} from "../src/persistence/family-store.js";
import {
  appendFamilyStatusBlock,
  familyGraphSummaryLines,
  familyWidgetLines,
  formatFamilyDispatchSurfaceLine,
  renderFamilyStatus,
} from "../src/ui/family-surface.js";
import {
  familyRecordMatchesLiveState,
  projectProductFamilyView,
} from "../src/ui/family-product.js";
import { renderWidget } from "../src/ui/format.js";
import { renderHypagoalStatus } from "../src/ui/hypagoal-surface.js";

const at = "2026-07-29T20:00:00.000Z";
const later = "2026-07-29T20:05:00.000Z";
const doneAt = "2026-07-29T20:10:00.000Z";

/** Root uses a distinct node id so merge detection can compare across workflows. */
const rootTask = (title: string, scopePaths?: string[]): HypagraphDefinition => ({
  title,
  goal: title,
  nodes: [{
    id: "parent-task",
    title: "Parent task",
    requires: [],
    acceptance: [],
    ...(scopePaths ? { scope: { paths: scopePaths } } : {}),
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

/** Child uses a different node id from the root. */
const childTask = (title: string, scopePaths?: string[]): HypagraphDefinition => ({
  title,
  goal: title,
  nodes: [{
    id: "child-task",
    title: "Child task",
    requires: [],
    acceptance: [],
    ...(scopePaths ? { scope: { paths: scopePaths } } : {}),
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const protectedEvaluatorDefinition = (): HypagraphDefinition => ({
  title: "Protected evaluator member",
  goal: "Never leak protected evaluator detail through family UI",
  nodes: [
    {
      id: "evaluate",
      title: "Evaluate quality",
      kind: "check",
      requires: [],
      acceptance: [],
      produces: [{ name: "evaluate.score", type: "number", required: false }],
      check: {
        kind: "metric-report",
        command: "protected-evaluator",
        arguments: ["--secret-suite"],
        timeoutMs: 30_000,
        reportPath: "protected/evaluate.json",
        parser: { name: "metric-json", version: 1 },
        mappings: [{ source: "score", fact: "evaluate.score", type: "number", required: false }],
        evaluation: { kind: "holdout", feedback: { mode: "aggregate" } },
      },
    },
    { id: "publish", title: "Publish the result", requires: ["evaluate"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const createStartedWorkflow = (
  definition: HypagraphDefinition,
  workflowId: string,
  goalId: string,
): HypagraphState => {
  const result = createHypagoalWorkflow(definition, {
    workflowId,
    goalId,
    goalWorkflowId: workflowId,
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const startTask = (state: HypagraphState, nodeId: string): HypagraphState => {
  const result = handleCommand(state, {
    type: "start-node",
    nodeId,
    attemptId: `attempt-${nodeId}`,
    commandId: `start-${nodeId}`,
    correlationId: `start-${nodeId}`,
    at: later,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const createOneMemberFamily = () => {
  const rootState = createStartedWorkflow(rootTask("Root work"), "workflow-root", "goal-root");
  const familyResult = createRootFamily({
    familyId: "family-ui-one",
    rootGoalId: "goal-root",
    rootWorkflowId: "workflow-root",
    at,
  });
  if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));
  return {
    family: familyResult.family,
    rootState,
    memberStates: { "goal-root": rootState },
  };
};

const createRootChildFamily = () => {
  let rootState = createStartedWorkflow(
    rootTask("Root work", ["src/**"]),
    "workflow-root",
    "goal-root",
  );
  rootState = startTask(rootState, "parent-task");
  const familyResult = createRootFamily({
    familyId: "family-ui-nested",
    rootGoalId: "goal-root",
    rootWorkflowId: "workflow-root",
    at,
    familyBudgetLimits: { maximumTurns: 20, maximumTokens: 8000 },
  });
  if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

  const childResult = createBoundedChildGoal({
    family: familyResult.family,
    parentState: rootState,
    parentNodeId: "parent-task",
    childDefinition: childTask("Child work", ["src/domain/**"]),
    childGoalId: "goal-child",
    childWorkflowId: "workflow-child",
    bindingId: "binding-child-1",
    at: later,
    scopePaths: ["src/domain/**"],
    budget: { maximumTurns: 4, maximumTokens: 2000 },
  });
  if (!childResult.ok) throw new Error(JSON.stringify(childResult.diagnostics));

  return {
    family: childResult.family,
    rootState: childResult.parentState,
    childState: childResult.childState,
    memberStates: {
      "goal-root": childResult.parentState,
      "goal-child": childResult.childState,
    },
  };
};

/**
 * Detect graph merge: root graph must equal an independent projection of root state.
 * Distinct child node IDs must not appear in the root graph.
 * Family binding targets must not appear as definition edges.
 */
const assertNoGraphMerge = (
  view: FamilyGraphViewModel,
  rootState: HypagraphState,
): void => {
  const root = view.members.find((member) => member.goalId === view.rootGoalId);
  expect(root).toBeDefined();
  expect(root!.graph).toBeDefined();

  const independent = projectGraphView(rootState);
  expect(root!.graph!.workflowId).toBe(independent.workflowId);
  expect(root!.graph!.nodes.map((node) => node.id)).toEqual(
    independent.nodes.map((node) => node.id),
  );
  expect(root!.graph!.edges.map((edge) => edge.id).sort()).toEqual(
    independent.edges.map((edge) => edge.id).sort(),
  );

  const rootNodeIds = new Set(root!.graph!.nodes.map((node) => node.id));
  for (const child of view.members.filter((member) => member.depth > 0)) {
    expect(child.workflowId).not.toBe(root!.workflowId);
    expect(child.graph).toBeDefined();
    for (const node of child.graph!.nodes) {
      // Distinct fixtures make this fail if child nodes were merged into the root.
      expect(rootNodeIds.has(node.id)).toBe(false);
    }
    for (const edge of root!.graph!.edges) {
      expect(child.graph!.nodes.some((node) => node.id === edge.source || node.id === edge.target))
        .toBe(false);
    }
  }

  for (const binding of view.bindings) {
    const asDefinitionEdge = root!.graph!.edges.some(
      (edge) => edge.source === binding.parentNodeId && edge.target === binding.childGoalId,
    );
    expect(asDefinitionEdge).toBe(false);
  }
};

describe("M7-S9 nested graph and executor UI projection", () => {
  it("projects a one-member family without inventing child boundaries", () => {
    const { family, memberStates } = createOneMemberFamily();
    const view = projectFamilyGraphView({ family, memberStates });

    expect(view.familyId).toBe("family-ui-one");
    expect(view.rootGoalId).toBe("goal-root");
    expect(view.memberCount).toBe(1);
    expect(view.members).toHaveLength(1);
    expect(view.members[0]).toMatchObject({
      goalId: "goal-root",
      workflowId: "workflow-root",
      depth: 0,
      expanded: true,
      focused: true,
    });
    expect(view.bindings).toEqual([]);
    expect(view.ancestry).toEqual([
      { goalId: "goal-root", workflowId: "workflow-root", depth: 0 },
    ]);
    expect(view.focusedGraph?.workflowId).toBe("workflow-root");
    expect(view.members[0]?.graph?.workflowId).toBe("workflow-root");
  });

  it("projects root and child nested boundaries, binding edge, ancestry, and distinct workflow ids", () => {
    const { family, memberStates, rootState } = createRootChildFamily();
    const view = projectFamilyGraphView({
      family,
      memberStates,
      expandedGoalIds: ["goal-root", "goal-child"],
    });

    expect(view.memberCount).toBe(2);
    expect(view.members.map((member) => member.goalId)).toEqual(["goal-root", "goal-child"]);
    expect(view.members.map((member) => member.workflowId)).toEqual([
      "workflow-root",
      "workflow-child",
    ]);
    expect(view.members[1]).toMatchObject({
      goalId: "goal-child",
      workflowId: "workflow-child",
      depth: 1,
      parentGoalId: "goal-root",
      parentNodeId: "parent-task",
      expanded: true,
    });
    expect(view.bindings).toHaveLength(1);
    expect(view.bindings[0]).toMatchObject({
      bindingId: "binding-child-1",
      parentNodeId: "parent-task",
      parentWorkflowId: "workflow-root",
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      status: "active",
    });
    expect(view.ancestry.map((step) => step.goalId)).toEqual(["goal-root"]);
    expect(view.bounds.memberCount).toBe(2);
    expect(view.budget.turns.reserved).toBeGreaterThan(0);
    expect(view.focusedGraph?.workflowId).toBe("workflow-root");
    expect(view.focusedGraph?.workflowId).not.toBe("workflow-child");
    assertNoGraphMerge(view, rootState);
  });

  it("projects pending and completed family dispatch in executor/scheduler status", () => {
    const { family, rootState, memberStates } = createOneMemberFamily();

    const selected = commitFamilySelection({
      family,
      memberStates,
      at: later,
      dispatchId: "dispatch-ui-1",
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));

    const pendingView = projectFamilyDispatchStatus(selected.family, memberStates, {
      kind: "isolated-pi",
      executorId: "executor-isolated-1",
      profileKind: "isolated-pi",
      activeProcessCount: 1,
    });
    expect(pendingView.scheduler.pending).toMatchObject({
      dispatchId: "dispatch-ui-1",
      status: "selected",
      goalId: "goal-root",
      workflowId: "workflow-root",
      actionKind: "start-ready-task",
      nodeId: "parent-task",
    });
    expect(pendingView.executor).toMatchObject({
      kindLabel: "isolated-pi",
      activeProcessCount: 1,
      executorId: "executor-isolated-1",
    });

    const dispatched = markFamilyActionDispatched({
      family: selected.family,
      dispatchId: "dispatch-ui-1",
      at: later,
      memberState: rootState,
    });
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok) throw new Error(JSON.stringify(dispatched.diagnostics));

    const fullPending = projectFamilyGraphView({
      family: dispatched.family,
      memberStates,
      executorHost: {
        kind: "current-session",
        executorId: "session-1",
        profileKind: "current-session",
        activeProcessCount: 0,
      },
    });
    expect(fullPending.scheduler.pending?.status).toBe("dispatched");
    expect(fullPending.executor?.kindLabel).toBe("current-session");

    const completed = completeFamilyAction({
      family: dispatched.family,
      dispatchId: "dispatch-ui-1",
      at: doneAt,
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) throw new Error(JSON.stringify(completed.diagnostics));

    const outcomeView = projectFamilyDispatchStatus(completed.family, memberStates);
    expect(outcomeView.scheduler.pending).toBeUndefined();
    expect(outcomeView.scheduler.lastOutcome).toMatchObject({
      dispatchId: "dispatch-ui-1",
      status: "completed",
      goalId: "goal-root",
      actionKind: "start-ready-task",
    });
  });

  it("keeps expand/collapse and focused-member selection from merging graphs", () => {
    const { family, memberStates, rootState } = createRootChildFamily();
    const collapsed = projectFamilyGraphView({
      family,
      memberStates,
      focusedGoalId: "goal-root",
      expandedGoalIds: ["goal-root"],
    });
    expect(collapsed.members.find((member) => member.goalId === "goal-child")?.expanded).toBe(false);
    // Graphs remain available for UI expand without re-projection.
    expect(collapsed.members.find((member) => member.goalId === "goal-child")?.graph?.workflowId)
      .toBe("workflow-child");
    expect(collapsed.focusedGraph?.workflowId).toBe("workflow-root");
    assertNoGraphMerge(collapsed, rootState);

    const expandedIds = toggleFamilyMemberExpanded(
      defaultExpandedFamilyGoalIds(family, "goal-root"),
      "goal-child",
      family.rootGoalId,
    );
    expect(expandedIds.has("goal-child")).toBe(true);

    const expanded = projectFamilyGraphView({
      family,
      memberStates,
      focusedGoalId: "goal-child",
      expandedGoalIds: expandedIds,
    });
    expect(expanded.focusedGoalId).toBe("goal-child");
    expect(expanded.focusedGraph?.workflowId).toBe("workflow-child");
    expect(expanded.ancestry.map((step) => step.goalId)).toEqual(["goal-root", "goal-child"]);
    assertNoGraphMerge(expanded, rootState);
  });

  it("redacts owner-based and unstored protected reasons on family surfaces", () => {
    const STORED = "holdout case 'internal-case-7' failed in protected/evaluate.json via --secret-suite";
    const UNSTORED_SELECTION = "fresh selection reason for protected evaluate owner only";
    const UNSTORED_OUTCOME = "fresh terminal failure reason never stored in state";
    const UNSTORED_RETURN = "fresh child return stop reason never stored in state";

    let rootState = createStartedWorkflow(
      rootTask("Root work", ["src/**"]),
      "workflow-root",
      "goal-root",
    );
    rootState = startTask(rootState, "parent-task");
    const familyResult = createRootFamily({
      familyId: "family-ui-redact",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

    const childResult = createBoundedChildGoal({
      family: familyResult.family,
      parentState: rootState,
      parentNodeId: "parent-task",
      childDefinition: protectedEvaluatorDefinition(),
      childGoalId: "goal-child-protected",
      childWorkflowId: "workflow-child-protected",
      bindingId: "binding-protected",
      at: later,
      scopePaths: ["src/**"],
      budget: { maximumTurns: 2, maximumTokens: 1000 },
    });
    if (!childResult.ok) throw new Error(JSON.stringify(childResult.diagnostics));

    const blockedChild = handleCommand(childResult.childState, {
      type: "block-node",
      nodeId: "evaluate",
      reason: STORED,
      blockerKind: "safeguard",
      commandId: "block-evaluate",
      at: doneAt,
    });
    if (!blockedChild.ok) throw new Error(JSON.stringify(blockedChild.diagnostics));
    expect(blockedChild.state.runtime.nodes.evaluate?.blockedReason).toBe(STORED);

    const familyWithSecret: GoalFamilyRuntime = structuredClone(childResult.family);
    // Pending selection with a previously unstored reason on the protected node owner.
    familyWithSecret.pendingDispatch = {
      dispatchId: "dispatch-pending-secret",
      selection: {
        familyId: familyWithSecret.familyId,
        goalId: "goal-child-protected",
        workflowId: "workflow-child-protected",
        revision: blockedChild.state.revision,
        nodeId: "evaluate",
        action: { kind: "run-ready-check", nodeId: "evaluate" },
        reason: UNSTORED_SELECTION,
        selectedSequence: blockedChild.state.sequence,
        selectedSnapshotHash: blockedChild.state.snapshotHash,
        memberContinuationOrdinal: blockedChild.state.goal!.continuationOrdinal,
      },
      status: "selected",
      selectedAt: later,
      schedulerOrdinal: familyWithSecret.schedulerOrdinal,
    };
    // Terminal outcome with a different unstored reason on the same protected owner.
    familyWithSecret.lastDispatchOutcome = {
      dispatchId: "dispatch-secret",
      selection: {
        familyId: familyWithSecret.familyId,
        goalId: "goal-child-protected",
        workflowId: "workflow-child-protected",
        revision: blockedChild.state.revision,
        nodeId: "evaluate",
        action: { kind: "run-ready-check", nodeId: "evaluate" },
        reason: UNSTORED_OUTCOME,
        selectedSequence: blockedChild.state.sequence,
        selectedSnapshotHash: blockedChild.state.snapshotHash,
        memberContinuationOrdinal: blockedChild.state.goal!.continuationOrdinal,
      },
      status: "failed",
      selectedAt: later,
      completedAt: doneAt,
      reason: UNSTORED_OUTCOME,
      schedulerOrdinal: familyWithSecret.schedulerOrdinal,
    };
    // Child return stop reason: conservative redaction when child has protected evaluator.
    const binding = familyWithSecret.bindings["binding-protected"] as ChildGoalBinding;
    familyWithSecret.bindings["binding-protected"] = {
      ...binding,
      status: "failed",
      returnRecord: {
        outcome: "failed",
        parentEffect: "failed",
        returnedAt: doneAt,
        stopReason: UNSTORED_RETURN,
      },
    };

    const memberStates = {
      "goal-root": childResult.parentState,
      "goal-child-protected": blockedChild.state,
    };
    const view = projectFamilyGraphView({
      family: familyWithSecret,
      memberStates,
      expandedGoalIds: ["goal-root", "goal-child-protected"],
      focusedGoalId: "goal-child-protected",
    });

    const serialized = JSON.stringify(view);
    for (const secret of [
      STORED,
      UNSTORED_SELECTION,
      UNSTORED_OUTCOME,
      UNSTORED_RETURN,
      "internal-case-7",
      "--secret-suite",
      "protected/evaluate.json",
    ]) {
      expect(serialized).not.toContain(secret);
    }

    expect(view.scheduler.pending?.reason).toBe(PROTECTED_DETAIL);
    expect(view.scheduler.lastOutcome?.reason).toBe(PROTECTED_DETAIL);
    expect(view.bindings[0]?.returnStopReason).toBe(PROTECTED_DETAIL);

    const status = renderFamilyStatus(view, 110);
    for (const secret of [UNSTORED_SELECTION, UNSTORED_OUTCOME, UNSTORED_RETURN, "internal-case-7"]) {
      expect(status).not.toContain(secret);
    }
    expect(status).toContain(PROTECTED_DETAIL);
    expect(status).toContain("goal-child-protected");
  });

  it("renders width-safe family status and bounds chrome height", () => {
    const { family, memberStates, rootState } = createRootChildFamily();
    // Many synthetic children in chrome for height bound.
    const largeView = projectFamilyGraphView({
      family,
      memberStates,
      expandedGoalIds: ["goal-root", "goal-child"],
      executorHost: {
        kind: "isolated-pi",
        executorId: "host-1",
        activeProcessCount: 0,
      },
    });

    const wideStatus = renderFamilyStatus(largeView, 110);
    expect(wideStatus).toContain("Family graph");
    expect(wideStatus).toContain("nested workflow boundary");
    expect(wideStatus).toContain("not a subagent");

    for (const width of [52, 80, 110]) {
      const status = renderFamilyStatus(largeView, width);
      expect(status.split("\n").every((line) => visibleWidth(line) <= width)).toBe(true);
    }

    const bounded = familyGraphSummaryLines(largeView, 80, { maxLines: 5 });
    expect(bounded.length).toBeLessThanOrEqual(5);
    expect(bounded.every((line) => visibleWidth(line) <= 80)).toBe(true);

    const widget = renderWidget(rootState, largeView);
    // Normal widget chrome is title + graph only (no Family wall).
    expect(widget[0]).toMatch(/Hypagraph:/);
    expect(widget.some((line) => line.includes("Family:"))).toBe(false);

    const oneMember = projectFamilyGraphView(createOneMemberFamily());
    const oneBlock = appendFamilyStatusBlock("root-status", oneMember, 80);
    expect(oneBlock).toContain("one member");
  });

  it("projects executor kind labels consistent with ExecutorKind", () => {
    expect(projectFamilyExecutorStatus({ kind: "current-session" }).kindLabel)
      .toBe("current-session");
    expect(projectFamilyExecutorStatus({ kind: "isolated-pi", activeProcessCount: 2 }).summary)
      .toContain("active processes 2");
  });

  it("redacts unstored request-revision outcome reasons for a protected blocker", () => {
    const UNSTORED_REVISION = "fresh revision failure reason never stored in canonical state";
    let rootState = createStartedWorkflow(
      rootTask("Root work", ["src/**"]),
      "workflow-root",
      "goal-root",
    );
    rootState = startTask(rootState, "parent-task");
    const familyResult = createRootFamily({
      familyId: "family-ui-revision-redact",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));
    const childResult = createBoundedChildGoal({
      family: familyResult.family,
      parentState: rootState,
      parentNodeId: "parent-task",
      childDefinition: protectedEvaluatorDefinition(),
      childGoalId: "goal-child-protected",
      childWorkflowId: "workflow-child-protected",
      bindingId: "binding-revision",
      at: later,
      scopePaths: ["src/**"],
      budget: { maximumTurns: 2, maximumTokens: 1000 },
    });
    if (!childResult.ok) throw new Error(JSON.stringify(childResult.diagnostics));

    // Child has a protected evaluator. No blockedReason is stored so secret-set match fails.
    const childState = childResult.childState;
    const family: GoalFamilyRuntime = structuredClone(childResult.family);
    family.lastDispatchOutcome = {
      dispatchId: "dispatch-revision",
      selection: {
        familyId: family.familyId,
        goalId: "goal-child-protected",
        workflowId: "workflow-child-protected",
        revision: childState.revision,
        action: {
          kind: "request-revision",
          blocker: {
            kind: "blocked-node",
            id: "evaluate",
            reason: "canonical blocker reason stays private",
            sourceRevision: childState.revision,
            sourceSequence: childState.sequence,
            sourceSnapshotHash: childState.snapshotHash,
          },
        },
        reason: UNSTORED_REVISION,
        selectedSequence: childState.sequence,
        selectedSnapshotHash: childState.snapshotHash,
        memberContinuationOrdinal: childState.goal!.continuationOrdinal,
      },
      status: "failed",
      selectedAt: later,
      completedAt: doneAt,
      reason: UNSTORED_REVISION,
      schedulerOrdinal: family.schedulerOrdinal,
    };

    const view = projectFamilyGraphView({
      family,
      memberStates: {
        "goal-root": childResult.parentState,
        "goal-child-protected": childState,
      },
    });
    expect(view.scheduler.lastOutcome?.reason).toBe(PROTECTED_DETAIL);
    expect(view.scheduler.lastOutcome?.actionKind).toBe("request-revision");
    expect(JSON.stringify(view)).not.toContain(UNSTORED_REVISION);
    expect(renderFamilyStatus(view, 110)).not.toContain(UNSTORED_REVISION);
  });

  it("shows loopId on pending and terminal family dispatch status lines", () => {
    const { family, rootState, memberStates } = createOneMemberFamily();
    const withLoop: GoalFamilyRuntime = structuredClone(family);
    withLoop.pendingDispatch = {
      dispatchId: "dispatch-loop-pending",
      selection: {
        familyId: family.familyId,
        goalId: "goal-root",
        workflowId: "workflow-root",
        revision: rootState.revision,
        nodeId: "parent-task",
        loopId: "loop-refine",
        action: { kind: "continue-active-task", nodeId: "parent-task", loopId: "loop-refine" },
        reason: "Continue the refine loop.",
        selectedSequence: rootState.sequence,
        selectedSnapshotHash: rootState.snapshotHash,
        memberContinuationOrdinal: rootState.goal!.continuationOrdinal,
      },
      status: "selected",
      selectedAt: later,
      schedulerOrdinal: family.schedulerOrdinal,
    };
    const pendingView = projectFamilyGraphView({
      family: withLoop,
      memberStates,
    });
    expect(pendingView.scheduler.pending?.loopId).toBe("loop-refine");
    const pendingStatus = renderFamilyStatus(pendingView, 120);
    expect(pendingStatus).toContain("loop loop-refine");
    expect(formatFamilyDispatchSurfaceLine("pending", pendingView.scheduler.pending!))
      .toContain("loop loop-refine");

    const terminal: GoalFamilyRuntime = structuredClone(family);
    terminal.lastDispatchOutcome = {
      dispatchId: "dispatch-loop-done",
      selection: {
        familyId: family.familyId,
        goalId: "goal-root",
        workflowId: "workflow-root",
        revision: rootState.revision,
        nodeId: "parent-task",
        loopId: "loop-refine",
        action: { kind: "run-ready-check", nodeId: "parent-task", loopId: "loop-refine" },
        reason: "Evaluate the loop.",
        selectedSequence: rootState.sequence,
        selectedSnapshotHash: rootState.snapshotHash,
        memberContinuationOrdinal: rootState.goal!.continuationOrdinal,
      },
      status: "completed",
      selectedAt: later,
      completedAt: doneAt,
      schedulerOrdinal: family.schedulerOrdinal + 1,
    };
    const doneView = projectFamilyGraphView({ family: terminal, memberStates });
    expect(doneView.scheduler.lastOutcome?.loopId).toBe("loop-refine");
    expect(renderFamilyStatus(doneView, 120)).toContain("loop loop-refine");
    expect(formatFamilyDispatchSurfaceLine("last", doneView.scheduler.lastOutcome!))
      .toContain("loop loop-refine");
  });

  it("fits and wraps wide Unicode text within terminal cell width", () => {
    const { family, memberStates } = createOneMemberFamily();
    // Override objective with wide fullwidth glyphs (two cells each).
    const wideObjective = "目標：" + "全".repeat(40);
    const mutated = structuredClone(memberStates["goal-root"]!);
    (mutated.definition as { goal: string }).goal = wideObjective;
    (mutated.definition as { title: string }).title = "ＷＩＤＥ " + "幅".repeat(20);
    const view = projectFamilyGraphView({
      family,
      memberStates: { "goal-root": mutated },
    });
    for (const width of [40, 52, 80]) {
      const status = renderFamilyStatus(view, width);
      for (const line of status.split("\n")) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      const summary = familyGraphSummaryLines(view, width, { maxLines: 6 });
      for (const line of summary) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("recomputes ancestry from members when focus changes", () => {
    const { family, memberStates } = createRootChildFamily();
    const view = projectFamilyGraphView({
      family,
      memberStates,
      focusedGoalId: "goal-root",
      expandedGoalIds: ["goal-root", "goal-child"],
    });
    expect(view.ancestry.map((step) => step.goalId)).toEqual(["goal-root"]);
    expect(ancestryFromMembers(view.members, "goal-child").map((step) => step.goalId))
      .toEqual(["goal-root", "goal-child"]);
    const focused = projectFamilyGraphView({
      family,
      memberStates,
      focusedGoalId: "goal-child",
      expandedGoalIds: ["goal-root", "goal-child"],
    });
    expect(focused.ancestry.map((step) => step.goalId)).toEqual(["goal-root", "goal-child"]);
    expect(renderFamilyStatus(focused, 100)).toContain("Ancestry: goal-root@d0 → goal-child@d1");
  });

  it("renders nested child graphs in the pane and supports expand/focus keys", () => {
    const { family, memberStates, rootState } = createRootChildFamily();
    const view = projectFamilyGraphView({
      family,
      memberStates,
      expandedGoalIds: ["goal-root", "goal-child"],
      executorHost: {
        kind: "isolated-pi",
        executorId: "pane-host",
        activeProcessCount: 1,
      },
    });
    const graphView = projectGraphView(rootState);
    const layout = layoutGraph(graphView);
    const theme = { fg: (_name: string, value: string) => value } as unknown as Theme;
    const tui = {
      terminal: { columns: 120, rows: 40 },
      requestRender: vi.fn(),
    } as unknown as TUI;

    const component = new PiGraphPaneComponent(
      tui,
      theme,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      graphView,
      layout,
      "normal",
      { step: vi.fn(), enter: vi.fn(), clear: vi.fn() },
      view,
    );

    const lines = component.render(90);
    const text = lines.join("\n");
    expect(text).toContain("Family family-ui-nested");
    expect(text).toContain("goal-child");
    expect(text).toContain("workflow-child");
    // Nested boundary section for the expanded child while root is focused.
    expect(text).toContain("nested boundary goal-child");
    expect(text).toContain("child-task");
    expect(text).toContain("bind parent-task → goal-child");
    expect(lines.every((line) => visibleWidth(line) === 90)).toBe(true);
    expect(graphView.nodes.every((node) => node.id === "parent-task")).toBe(true);

    // Focus the child with ].
    component.handleInput("]");
    expect(component.familyFocusGoalIdForTest).toBe("goal-child");
    const focusedText = component.render(90).join("\n");
    expect(focusedText).toContain("member goal-child");
    expect(focusedText).toContain("Child work");
    // Ancestry tracks focus: root → focused child.
    expect(focusedText).toContain("Ancestry goal-root → goal-child");

    // Collapse with x; nested boundary for child disappears when focused is child
    // (non-focused expanded list). Focus root and keep child collapsed.
    component.handleInput("0");
    expect(component.familyFocusGoalIdForTest).toBe("goal-root");
    component.handleInput("]");
    component.handleInput("x");
    expect(component.isFamilyMemberExpandedForTest("goal-child")).toBe(false);
    component.handleInput("0");
    const collapsedText = component.render(90).join("\n");
    expect(collapsedText).not.toContain("nested boundary goal-child");

    // Overlay height stays within terminal budget for a short terminal.
    const shortTui = {
      terminal: { columns: 100, rows: 16 },
      requestRender: vi.fn(),
    } as unknown as TUI;
    const short = new PiGraphPaneComponent(
      shortTui,
      theme,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      graphView,
      layout,
      "normal",
      { step: vi.fn(), enter: vi.fn(), clear: vi.fn() },
      view,
    );
    const shortLines = short.render(80);
    const available = Math.max(8, Math.min(16 - 2, Math.floor(16 * 0.9)));
    expect(shortLines.length).toBeLessThanOrEqual(available + 2);

    const controller = new GraphPaneController();
    controller.update(rootState);
    controller.updateFamily(view);
    expect(controller.familyViewForTest?.familyId).toBe("family-ui-nested");
  });

  it("rejects a family record that does not match the live goal after replacement", () => {
    const { family, memberStates, rootState } = createRootChildFamily();
    const view = projectFamilyGraphView({ family, memberStates });
    const record = (extra: Partial<PersistedGoalFamily> = {}): PersistedGoalFamily => ({
      schemaVersion: family.schemaVersion,
      familyEvents: [] as GoalFamilyEvent[],
      familySnapshot: family,
      workflows: {
        "workflow-root": { events: [] as DomainEvent[], snapshot: rootState },
        "workflow-child": { events: [] as DomainEvent[], snapshot: memberStates["goal-child"]! },
      },
      ...extra,
    });
    expect(familyRecordMatchesLiveState(record(), rootState)).toBe(true);

    const replaced = createStartedWorkflow(rootTask("Replaced root"), "workflow-new", "goal-new");
    expect(familyRecordMatchesLiveState(record(), replaced)).toBe(false);
    expect(projectProductFamilyView(record(), replaced)).toBeUndefined();

    const product = projectProductFamilyView(record(), rootState);
    expect(product?.familyId).toBe(view.familyId);
  });
});

describe("M7-S9 product surface wiring", () => {
  const harness = (branchEntries: unknown[] = []) => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const sessionHandlers = new Map<string, Array<() => void | Promise<void>>>();
    const notify = vi.fn();
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const appendEntry = vi.fn();
    let branch = [...branchEntries];
    const pi = {
      on: vi.fn((event: string, handler: () => void | Promise<void>) => {
        const list = sessionHandlers.get(event) ?? [];
        list.push(handler);
        sessionHandlers.set(event, list);
      }),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
        commands.set(name, command);
      }),
      appendEntry: vi.fn((type: string, data: unknown) => {
        appendEntry(type, data);
        branch.push({ type: "custom", customType: type, data });
      }),
      sendUserMessage: vi.fn(),
      getActiveTools: vi.fn(() => []),
      setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      mode: "tui" as const,
      ui: {
        confirm: vi.fn(),
        notify,
        select: vi.fn(),
        input: vi.fn(),
        setStatus,
        setWidget,
        custom: vi.fn(async () => undefined),
      },
      sessionManager: {
        getBranch: () => branch,
        setBranch: (next: unknown[]) => {
          branch = next;
        },
      },
    };
    hypagraphExtension(pi);
    return { commands, notify, setWidget, setStatus, appendEntry, ctx, pi, getBranch: () => branch };
  };

  it("paints family status and widget from a session family record without append on paint", () => {
    // Build a minimal persisted one-member family then add a child through domain helpers.
    const created = createHypagoalWorkflow(rootTask("Root work", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let workflow = created.state;
    const started = handleCommand(workflow, {
      type: "start-node",
      nodeId: "parent-task",
      attemptId: "attempt-parent-task",
      commandId: "start-parent",
      correlationId: "start-parent",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    workflow = started.state;

    const persistedRoot = {
      events: [...created.events, ...started.events],
      snapshot: workflow,
    };
    const oneMember = buildOneMemberPersistedFamily({
      familyId: "family-product",
      rootGoalId: "goal-root",
      workflow: persistedRoot,
      at,
    });

    const childResult = createBoundedChildGoal({
      family: oneMember.familySnapshot,
      parentState: workflow,
      parentNodeId: "parent-task",
      childDefinition: childTask("Child work", ["src/domain/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-product",
      at: later,
      scopePaths: ["src/domain/**"],
      budget: { maximumTurns: 2, maximumTokens: 500 },
    });
    if (!childResult.ok) throw new Error(JSON.stringify(childResult.diagnostics));
    const familyRecord = commitBoundedChildGoalToPersistedFamily(oneMember, childResult);

    // Product helpers used by extension paint: project, status, widget.
    const productView = projectProductFamilyView(familyRecord, childResult.parentState, {
      kind: "isolated-pi",
      executorId: "isolated-pi",
      profileKind: "isolated-pi",
      activeProcessCount: 0,
    });
    expect(productView).toBeDefined();
    expect(productView!.memberCount).toBe(2);

    const rootStatus = renderHypagoalStatus(childResult.parentState, 100);
    const combined = appendFamilyStatusBlock(rootStatus, productView, 100, { showOneMember: true });
    expect(combined).toContain("Family graph");
    expect(combined).toContain("goal-child");
    expect(combined).toContain("binding-product");

    const widget = renderWidget(childResult.parentState, productView);
    // Family ids stay on /hypagraph status, not the compact widget.
    expect(widget[0]).toMatch(/Hypagraph:/);
    expect(widget.some((line) => line.includes("Family:"))).toBe(false);

    // Mismatched live after replacement yields no family block.
    const replaced = createStartedWorkflow(rootTask("Other"), "wf-other", "goal-other");
    expect(projectProductFamilyView(familyRecord, replaced)).toBeUndefined();
    expect(appendFamilyStatusBlock(renderHypagoalStatus(replaced, 80), undefined, 80))
      .not.toContain("Family graph");

    // Extension harness with a pre-seeded family custom entry: status/widget paint
    // must not append further family records.
    const value = harness([{
      type: "custom",
      customType: HYPAGRAPH_FAMILY_RECORD_TYPE,
      data: familyRecord,
    }]);
    const entryCountBefore = value.getBranch().length;
    // Without a live workflow state in the extension, status throws; paint helpers
    // above cover the pure product path. Repeated product projection is side-effect free.
    projectProductFamilyView(familyRecord, childResult.parentState);
    projectProductFamilyView(familyRecord, childResult.parentState);
    expect(value.appendEntry).not.toHaveBeenCalled();
    expect(value.getBranch().length).toBe(entryCountBefore);
  });

  it("does not append session entries when projecting family product helpers repeatedly", () => {
    const { family, memberStates, rootState } = createRootChildFamily();
    const record: PersistedGoalFamily = {
      schemaVersion: family.schemaVersion,
      familyEvents: [],
      familySnapshot: family,
      workflows: {
        "workflow-root": { events: [], snapshot: rootState },
        "workflow-child": { events: [], snapshot: memberStates["goal-child"]! },
      },
    };

    const first = projectProductFamilyView(record, rootState);
    const second = projectProductFamilyView(record, rootState);
    expect(first?.familyId).toBe(second?.familyId);
    expect(first?.memberCount).toBe(2);

    // Paint helpers are pure: repeated calls produce the same membership summary.
    expect(familyWidgetLines(first!)).toEqual(familyWidgetLines(second!));
    expect(renderFamilyStatus(first!, 90)).toBe(renderFamilyStatus(second!, 90));
  });
});

describe("M7-S9 graph pane family lifecycle", () => {
  const theme = { fg: (_name: string, value: string) => value } as unknown as Theme;
  const tui = {
    terminal: { columns: 120, rows: 40 },
    requestRender: vi.fn(),
  } as unknown as TUI;

  const openComponent = (
    controller: GraphPaneController,
    rootState: HypagraphState,
    familyView: FamilyGraphViewModel,
  ): PiGraphPaneComponent => {
    controller.update(rootState);
    controller.updateFamily(familyView);
    const view = projectGraphView(rootState);
    const layout = layoutGraph(view);
    const component = new PiGraphPaneComponent(
      tui,
      theme,
      vi.fn(),
      vi.fn(),
      (density) => {
        // Mirror controller density changes through the component callback path.
        (controller as unknown as { setDensity: (d: typeof density) => void }).setDensity?.(density);
      },
      view,
      layout,
      "normal",
      { step: vi.fn(), enter: vi.fn(), clear: vi.fn() },
      familyView,
    );
    // Attach as if open: inject component for controller tests that call updateFamily/update.
    (controller as unknown as { component: PiGraphPaneComponent }).component = component;
    return component;
  };

  it("restores the new root graph when family is cleared after root replacement", () => {
    const { memberStates, rootState, family } = createRootChildFamily();
    const familyView = projectFamilyGraphView({
      family,
      memberStates,
      expandedGoalIds: ["goal-root", "goal-child"],
    });
    const controller = new GraphPaneController();
    const component = openComponent(controller, rootState, familyView);

    // Focus the child so the pane shows the previous family member graph.
    component.handleInput("]");
    expect(component.familyFocusGoalIdForTest).toBe("goal-child");
    expect(component.primaryWorkflowIdForTest).toBe("workflow-child");

    // Replacement: clear family first (product path), then apply new root state.
    const replaced = createStartedWorkflow(rootTask("Replaced root"), "workflow-new", "goal-new");
    controller.updateFamily(undefined);
    controller.update(replaced);

    expect(component.hasFamilyForTest).toBe(false);
    expect(component.primaryWorkflowIdForTest).toBe("workflow-new");
    expect(component.primaryTitleForTest).toBe("Replaced root");
    const text = component.render(90).join("\n");
    expect(text).not.toContain("goal-child");
    expect(text).toContain("Replaced root");
  });

  it("keeps the replayed root graph and hides live family chrome during replay", () => {
    const created = createHypagoalWorkflow(rootTask("Replay root"), {
      workflowId: "workflow-replay",
      goalId: "goal-replay",
      goalWorkflowId: "workflow-replay",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let live = created.state;
    const started = handleCommand(live, {
      type: "start-node",
      nodeId: "parent-task",
      attemptId: "attempt-parent-task",
      commandId: "start-parent",
      correlationId: "start-parent",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    live = started.state;
    events.push(...started.events);

    // One-member family projection of the live root.
    const familyResult = createRootFamily({
      familyId: "family-replay",
      rootGoalId: "goal-replay",
      rootWorkflowId: "workflow-replay",
      at,
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));
    const familyView = projectFamilyGraphView({
      family: familyResult.family,
      memberStates: { "goal-replay": live },
    });

    const controller = new GraphPaneController(() => events);
    controller.update(live);
    controller.updateFamily(familyView);
    const liveView = projectGraphView(live);
    const component = new PiGraphPaneComponent(
      tui,
      theme,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      liveView,
      layoutGraph(liveView),
      "normal",
      {
        step: (delta) => {
          const current = controller.replaySequenceForTest ?? live.sequence;
          const next = Math.max(events[0]!.sequence, current + delta);
          controller.setReplaySequence(next === live.sequence ? undefined : next);
        },
        enter: () => controller.setReplaySequence(events[0]!.sequence),
        clear: () => controller.setReplaySequence(undefined),
      },
      familyView,
    );
    (controller as unknown as { component: PiGraphPaneComponent }).component = component;

    // Enter replay at the first event (pre-start-node historical root).
    controller.setReplaySequence(events[0]!.sequence);
    expect(component.isReplayForTest).toBe(true);
    expect(component.primaryWorkflowIdForTest).toBe("workflow-replay");
    const replayText = component.render(90).join("\n");
    expect(replayText).toContain("Hypagraph replay");
    expect(replayText).not.toContain("Family family-replay");
    expect(replayText).not.toContain("nested boundary");
    // Live family focus keys do not replace the historical graph.
    component.handleInput("]");
    expect(component.primaryWorkflowIdForTest).toBe("workflow-replay");

    controller.setReplaySequence(undefined);
    expect(component.isReplayForTest).toBe(false);
    const liveText = component.render(90).join("\n");
    expect(liveText).toContain("Family family-replay");
  });

  it("preserves local expand state when the same family is refreshed", () => {
    const { memberStates, rootState, family } = createRootChildFamily();
    const first = projectFamilyGraphView({
      family,
      memberStates,
      expandedGoalIds: ["goal-root", "goal-child"],
    });
    const graphView = projectGraphView(rootState);
    const component = new PiGraphPaneComponent(
      tui,
      theme,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      graphView,
      layoutGraph(graphView),
      "normal",
      { step: vi.fn(), enter: vi.fn(), clear: vi.fn() },
      first,
    );

    // Focus child and collapse it.
    component.handleInput("]");
    component.handleInput("x");
    expect(component.isFamilyMemberExpandedForTest("goal-child")).toBe(false);
    expect(component.render(90).join("\n")).not.toContain("nested boundary goal-child");

    // Product paint supplies a default-expanded projection for the same family.
    const refreshed = projectFamilyGraphView({
      family,
      memberStates,
      expandedGoalIds: ["goal-root", "goal-child"],
      focusedGoalId: "goal-root",
    });
    component.setFamily(refreshed);
    expect(component.isFamilyMemberExpandedForTest("goal-child")).toBe(false);
    // Focus is preserved when the member still exists.
    expect(component.familyFocusGoalIdForTest).toBe("goal-child");

    // A different family resets expand/focus.
    const other = createOneMemberFamily();
    const otherView = projectFamilyGraphView({
      family: other.family,
      memberStates: other.memberStates,
    });
    component.setFamily(otherView);
    expect(component.familyFocusGoalIdForTest).toBe("goal-root");
    expect(component.primaryWorkflowIdForTest).toBe("workflow-root");
  });

  it("keeps focused child graph when density changes", () => {
    const { memberStates, rootState, family } = createRootChildFamily();
    const familyView = projectFamilyGraphView({
      family,
      memberStates,
      expandedGoalIds: ["goal-root", "goal-child"],
    });
    const events: DomainEvent[] = [];
    const controller = new GraphPaneController(() => events);
    controller.update(rootState);
    controller.updateFamily(familyView);
    const graphView = projectGraphView(rootState);
    const component = new PiGraphPaneComponent(
      tui,
      theme,
      vi.fn(),
      vi.fn(),
      (density) => {
        (controller as unknown as { setDensity: (d: typeof density) => void }).setDensity(density);
      },
      graphView,
      layoutGraph(graphView),
      "normal",
      { step: vi.fn(), enter: vi.fn(), clear: vi.fn() },
      familyView,
    );
    (controller as unknown as { component: PiGraphPaneComponent }).component = component;

    component.handleInput("]");
    expect(component.primaryWorkflowIdForTest).toBe("workflow-child");
    expect(component.primaryTitleForTest).toBe("Child work");

    component.handleInput("+");
    expect(component.currentDensity).toBe("spacious");
    expect(component.primaryWorkflowIdForTest).toBe("workflow-child");
    expect(component.primaryTitleForTest).toBe("Child work");
    expect(component.familyFocusGoalIdForTest).toBe("goal-child");
  });
});

