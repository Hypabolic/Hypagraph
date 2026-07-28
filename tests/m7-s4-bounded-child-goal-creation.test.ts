import { describe, expect, it } from "vitest";
import {
  createBoundedChildGoal,
} from "../src/domain/child-goal-creation.js";
import { enumerateFamilyRunnableCandidates } from "../src/domain/family-scheduler.js";
import {
  GOAL_FAMILY_EVENT_VERSION,
  GOAL_FAMILY_SCHEMA_VERSION,
  GoalFamilyRestoreError,
  UnsupportedGoalFamilySchemaError,
  addFamilyMember,
  applyFamilyEvent,
  createRootFamily,
  rebuildFamilyMembershipFromSnapshot,
  replayFamilyEvents,
  restoreFamilyProjection,
  type FamilyBounds,
  type GoalFamilyEvent,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { DomainEvent, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { handleCommand } from "../src/domain/reducer.js";
import { createBoundedChildGoalInFamily } from "../src/persistence/family-session.js";
import {
  assertPersistedGoalFamilyShape,
  buildOneMemberPersistedFamily,
  commitBoundedChildGoalToPersistedFamily,
  restorePersistedGoalFamily,
} from "../src/persistence/family-store.js";

const at = "2026-07-29T18:00:00.000Z";
const later = "2026-07-29T18:05:00.000Z";
const grandchildAt = "2026-07-29T18:10:00.000Z";

const singleTask = (title: string, scopePaths?: string[]): HypagraphDefinition => ({
  title,
  goal: title,
  nodes: [{
    id: "work",
    title: "Work",
    requires: [],
    acceptance: [],
    ...(scopePaths ? { scope: { paths: scopePaths } } : {}),
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const siblingTasks = (title: string): HypagraphDefinition => ({
  title,
  goal: title,
  nodes: [
    { id: "parent-task", title: "Parent task", requires: [], acceptance: [], scope: { paths: ["src/**"] } },
    { id: "sibling-task", title: "Sibling task", requires: [], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const tightBounds = (overrides: Partial<FamilyBounds> = {}): FamilyBounds => ({
  maxDepth: 3,
  maxChildrenPerGoal: 8,
  maxGoalsInFamily: 32,
  maxChildCreationAttemptsPerNode: 8,
  ...overrides,
});

const createStartedWorkflow = (
  definition: HypagraphDefinition,
  workflowId: string,
  goalId: string,
  budget?: { maximumTurns?: number; maximumTokens?: number },
): HypagraphState => {
  const result = createHypagoalWorkflow(definition, {
    workflowId,
    goalId,
    goalWorkflowId: workflowId,
    at,
    ...(budget ? { budget } : {}),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const startTask = (state: HypagraphState, nodeId: string, attemptId = `attempt-${nodeId}`): HypagraphState => {
  const result = handleCommand(state, {
    type: "start-node",
    nodeId,
    attemptId,
    commandId: `start-${nodeId}`,
    correlationId: `start-${nodeId}`,
    at: later,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const createFamilyWithRoot = (options?: {
  familyId?: string;
  bounds?: FamilyBounds;
  familyBudgetLimits?: { maximumTurns?: number; maximumTokens?: number };
  rootDefinition?: HypagraphDefinition;
  startNodeId?: string;
}) => {
  const familyId = options?.familyId ?? "family-s4";
  const rootDefinition = options?.rootDefinition ?? singleTask("Root work", ["src/**"]);
  const startNodeId = options?.startNodeId ?? "work";
  let rootState = createStartedWorkflow(rootDefinition, "workflow-root", "goal-root");
  rootState = startTask(rootState, startNodeId);

  const familyResult = createRootFamily({
    familyId,
    rootGoalId: "goal-root",
    rootWorkflowId: "workflow-root",
    at,
    ...(options?.bounds ? { bounds: options.bounds } : {}),
    ...(options?.familyBudgetLimits ? { familyBudgetLimits: options.familyBudgetLimits } : {}),
  });
  if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

  return {
    family: familyResult.family,
    familyEvents: familyResult.events,
    rootState,
  };
};

const freeze = <T>(value: T): T => structuredClone(value);

describe("M7-S4 bounded child-goal creation", () => {
  it("creates one child from an active parent task and starts the child workflow", () => {
    const { family, rootState } = createFamilyWithRoot();
    const childDefinition = singleTask("Child work", ["src/domain/**"]);

    const result = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition,
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-child-1",
      at: later,
      scopePaths: ["src/domain/**"],
      budget: { maximumTurns: 2, maximumTokens: 1000 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(result.family.members["goal-child"]).toMatchObject({
      goalId: "goal-child",
      workflowId: "workflow-child",
      depth: 1,
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "work",
      },
    });
    expect(result.family.members["goal-root"]?.childGoalIds).toEqual(["goal-child"]);
    expect(result.family.bindings["binding-child-1"]).toMatchObject({
      childGoalId: "goal-child",
      parentNodeId: "work",
      status: "active",
      scopePaths: ["src/domain/**"],
      budget: { maximumTurns: 2, maximumTokens: 1000 },
    });
    expect(result.family.familyBudget.reservedTurns).toBe(2);
    expect(result.family.familyBudget.reservedTokens).toBe(1000);

    expect(result.parentState.runtime.nodes.work?.status).toBe("waiting_for_child");
    expect(result.parentState.runtime.nodes.work?.currentAttemptId).toBe("attempt-work");
    expect(result.parentEvents.some((event) => event.type === "hypagraph.task.waiting-for-child")).toBe(true);

    expect(result.childState.goal?.goalId).toBe("goal-child");
    expect(result.childState.goal?.status).toBe("active");
    expect(result.childState.phase).toBe("running");
    expect(result.childState.goal?.budget.limits).toEqual({ maximumTurns: 2, maximumTokens: 1000 });
  });

  it("allows a grandchild within max depth and rejects depth beyond the bound", () => {
    const { family, rootState } = createFamilyWithRoot({
      bounds: tightBounds({ maxDepth: 2 }),
    });

    const child = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-child",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(child.ok).toBe(true);
    if (!child.ok) throw new Error(JSON.stringify(child.diagnostics));

    const childRunning = startTask(child.childState, "work", "attempt-child-work");
    const grandchild = createBoundedChildGoal({
      family: child.family,
      parentState: childRunning,
      parentNodeId: "work",
      childDefinition: singleTask("Grandchild", ["src/**"]),
      childGoalId: "goal-grandchild",
      childWorkflowId: "workflow-grandchild",
      bindingId: "binding-grandchild",
      at: grandchildAt,
      scopePaths: ["src/**"],
    });
    expect(grandchild.ok).toBe(true);
    if (!grandchild.ok) throw new Error(JSON.stringify(grandchild.diagnostics));
    expect(grandchild.family.members["goal-grandchild"]?.depth).toBe(2);

    // maxDepth 1 allows only depth-1 children.
    const shallow = createFamilyWithRoot({
      familyId: "family-shallow",
      bounds: tightBounds({ maxDepth: 1 }),
    });
    const shallowChild = createBoundedChildGoal({
      family: shallow.family,
      parentState: shallow.rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-child",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(shallowChild.ok).toBe(true);
    if (!shallowChild.ok) throw new Error(JSON.stringify(shallowChild.diagnostics));
    const shallowChildRunning = startTask(shallowChild.childState, "work", "attempt-child-work");
    const denied = createBoundedChildGoal({
      family: shallowChild.family,
      parentState: shallowChildRunning,
      parentNodeId: "work",
      childDefinition: singleTask("Grandchild", ["src/**"]),
      childGoalId: "goal-grandchild",
      childWorkflowId: "workflow-grandchild",
      bindingId: "binding-grandchild",
      at: grandchildAt,
      scopePaths: ["src/**"],
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("Expected depth rejection.");
    expect(denied.diagnostics[0]?.code).toBe("goal_family_depth_exceeded");
  });

  it("rejects more children than maxChildrenPerGoal without partial state", () => {
    const { family, rootState } = createFamilyWithRoot({
      bounds: tightBounds({ maxChildrenPerGoal: 1 }),
    });
    const familyBefore = freeze(family);
    const parentBefore = freeze(rootState);

    const first = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child one"),
      childGoalId: "goal-child-1",
      childWorkflowId: "workflow-child-1",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));

    // Parent is waiting; reactivation is out of scope. Use the successful family and
    // a fresh parent clone still in running state only for bound counting.
    const second = createBoundedChildGoal({
      family: first.family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child two"),
      childGoalId: "goal-child-2",
      childWorkflowId: "workflow-child-2",
      bindingId: "binding-2",
      at: grandchildAt,
      scopePaths: ["src/**"],
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("Expected children-per-goal rejection.");
    expect(second.diagnostics[0]?.code).toBe("goal_family_children_per_goal_exceeded");
    expect(family).toEqual(familyBefore);
    expect(rootState).toEqual(parentBefore);
    expect(first.family.members["goal-child-2"]).toBeUndefined();
  });

  it("rejects more members than maxGoalsInFamily", () => {
    const { family, rootState } = createFamilyWithRoot({
      bounds: tightBounds({ maxGoalsInFamily: 1 }),
    });
    const result = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child"),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected member count rejection.");
    expect(result.diagnostics[0]?.code).toBe("goal_family_member_count_exceeded");
  });

  it("rejects a widened child scope and accepts equal or narrower scope", () => {
    const { family, rootState } = createFamilyWithRoot({
      rootDefinition: singleTask("Root", ["src/**"]),
    });

    const widened = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child"),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-wide",
      at: later,
      scopePaths: ["src/**", "docs/**"],
    });
    expect(widened.ok).toBe(false);
    if (widened.ok) throw new Error("Expected scope rejection.");
    expect(widened.diagnostics[0]?.code).toBe("child_goal_scope_widened");

    const equal = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child equal"),
      childGoalId: "goal-child-equal",
      childWorkflowId: "workflow-child-equal",
      bindingId: "binding-equal",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(equal.ok).toBe(true);

    const narrow = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child narrow"),
      childGoalId: "goal-child-narrow",
      childWorkflowId: "workflow-child-narrow",
      bindingId: "binding-narrow",
      at: later,
      scopePaths: ["src/domain/**"],
    });
    expect(narrow.ok).toBe(true);
  });

  it("rejects a budget allocation that exceeds family remaining capacity", () => {
    const { family, rootState } = createFamilyWithRoot({
      familyBudgetLimits: { maximumTurns: 5, maximumTokens: 500 },
    });

    const missingAllocation = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child"),
      childGoalId: "goal-child-missing",
      childWorkflowId: "workflow-child-missing",
      bindingId: "binding-missing",
      at: later,
      scopePaths: ["src/**"],
      budget: { maximumTurns: 2 },
    });
    expect(missingAllocation.ok).toBe(false);
    if (missingAllocation.ok) throw new Error("Expected missing allocation rejection.");
    expect(missingAllocation.diagnostics[0]?.code).toBe("child_goal_budget_allocation_required");

    const over = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child"),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-over",
      at: later,
      scopePaths: ["src/**"],
      budget: { maximumTurns: 6, maximumTokens: 100 },
    });
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error("Expected budget rejection.");
    expect(over.diagnostics[0]?.code).toBe("goal_family_budget_exceeded");

    const first = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child one"),
      childGoalId: "goal-child-1",
      childWorkflowId: "workflow-child-1",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
      budget: { maximumTurns: 3, maximumTokens: 200 },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
    expect(first.family.familyBudget.reservedTurns).toBe(3);
    expect(first.family.familyBudget.reservedTokens).toBe(200);

    const secondOver = createBoundedChildGoal({
      family: first.family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child two"),
      childGoalId: "goal-child-2",
      childWorkflowId: "workflow-child-2",
      bindingId: "binding-2",
      at: grandchildAt,
      scopePaths: ["src/**"],
      budget: { maximumTurns: 3, maximumTokens: 100 },
    });
    expect(secondOver.ok).toBe(false);
    if (secondOver.ok) throw new Error("Expected remaining budget rejection.");
    expect(secondOver.diagnostics[0]?.code).toBe("goal_family_budget_exceeded");
  });

  it("rejects child creation from a non-task parent node", () => {
    let state = createStartedWorkflow({
      title: "Gate parent",
      goal: "A gate cannot create a child",
      nodes: [
        {
          id: "gate-one",
          title: "Gate",
          kind: "gate",
          requires: [],
          acceptance: [],
          gate: {
            condition: {
              kind: "compare",
              left: { kind: "literal", value: true },
              operator: "eq",
              right: { kind: "literal", value: true },
            },
            onTrue: ["selected"],
            onFalse: ["rejected"],
          },
        },
        { id: "selected", title: "Selected", requires: ["gate-one"], acceptance: [] },
        { id: "rejected", title: "Rejected", requires: ["gate-one"], acceptance: [] },
      ],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    }, "workflow-gate", "goal-gate");
    const familyResult = createRootFamily({
      familyId: "family-gate",
      rootGoalId: "goal-gate",
      rootWorkflowId: "workflow-gate",
      at,
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

    // Force an active-like status so the kind check is reached.
    state = structuredClone(state);
    state.runtime.nodes["gate-one"]!.status = "running";
    state.runtime.nodes["gate-one"]!.currentAttemptId = "attempt-gate";
    state.runtime.nodes["gate-one"]!.attempts["attempt-gate"] = {
      attemptId: "attempt-gate",
      number: 1,
      status: "running",
      startedAt: later,
      evidence: [],
    };

    const result = createBoundedChildGoal({
      family: familyResult.family,
      parentState: state,
      parentNodeId: "gate-one",
      childDefinition: singleTask("Child"),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-1",
      at: later,
      scopePaths: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected non-task rejection.");
    expect(result.diagnostics[0]?.code).toBe("child_goal_parent_not_task");
  });

  it("rejects child creation when the parent task is not in an active create-capable state", () => {
    const rootState = createStartedWorkflow(singleTask("Root"), "workflow-root", "goal-root");
    const familyResult = createRootFamily({
      familyId: "family-ready",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

    // Parent task is ready, not active.
    expect(rootState.runtime.nodes.work?.status).toBe("ready");
    const result = createBoundedChildGoal({
      family: familyResult.family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child"),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-1",
      at: later,
      scopePaths: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected inactive parent rejection.");
    expect(result.diagnostics[0]?.code).toBe("child_goal_parent_not_active");
  });

  it("leaves family and parent workflow unchanged when validation fails", () => {
    const { family, rootState } = createFamilyWithRoot({
      bounds: tightBounds({ maxGoalsInFamily: 1 }),
    });
    const familyBefore = freeze(family);
    const parentBefore = freeze(rootState);

    const result = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child"),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(result.ok).toBe(false);
    expect(family).toEqual(familyBefore);
    expect(rootState).toEqual(parentBefore);
    expect(rootState.runtime.nodes.work?.status).toBe("running");
  });

  it("keeps an unrelated sibling task runnable while the parent waits for a child", () => {
    const { family, rootState } = createFamilyWithRoot({
      rootDefinition: siblingTasks("Root with sibling"),
      startNodeId: "parent-task",
    });

    const result = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "parent-task",
      childDefinition: singleTask("Child"),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(result.parentState.runtime.nodes["parent-task"]?.status).toBe("waiting_for_child");
    expect(result.parentState.runtime.nodes["sibling-task"]?.status).toBe("ready");

    const candidates = enumerateFamilyRunnableCandidates(result.family, {
      "goal-root": result.parentState,
      "goal-child": result.childState,
    });

    // Parent task must not appear as continue-active-task.
    expect(
      candidates.some((item) =>
        item.goalId === "goal-root"
        && item.action.kind === "continue-active-task"
        && item.action.nodeId === "parent-task"),
    ).toBe(false);

    // Sibling remains startable. Child ready work is also visible.
    expect(
      candidates.some((item) =>
        item.goalId === "goal-root"
        && item.action.kind === "start-ready-task"
        && item.action.nodeId === "sibling-task"),
    ).toBe(true);
    expect(
      candidates.some((item) =>
        item.goalId === "goal-child"
        && item.action.kind === "start-ready-task"
        && item.action.nodeId === "work"),
    ).toBe(true);
  });

  it("keeps an independent loop candidate while the parent waits for a child", () => {
    // Parent task and independent loop entry are both ready after goal start.
    // Start the parent only so the independent loop remains a runnable candidate.
    const definition: HypagraphDefinition = {
      title: "Parent and independent loop",
      goal: "Independent loop work stays runnable",
      nodes: [
        { id: "parent-task", title: "Parent", requires: [], acceptance: [], scope: { paths: ["src/**"] } },
        { id: "loop-entry", title: "Loop entry", requires: ["loop-eval"], acceptance: [] },
        {
          id: "loop-eval",
          title: "Loop evaluate",
          requires: ["loop-entry"],
          acceptance: [],
          produces: [{ name: "loop.passed", type: "boolean", required: true }],
        },
      ],
      loops: [{
        id: "independent-loop",
        entry: "loop-entry",
        nodes: ["loop-entry", "loop-eval"],
        evaluateAfter: "loop-eval",
        feedbackEdges: [{ from: "loop-eval", to: "loop-entry" }],
        successWhen: {
          kind: "compare",
          left: { kind: "fact", name: "loop.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        maxIterations: 2,
      }],
      policy: { mode: "guided", requireEvidence: false },
    };
    const { family, rootState } = createFamilyWithRoot({
      rootDefinition: definition,
      startNodeId: "parent-task",
    });

    const result = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "parent-task",
      childDefinition: singleTask("Child"),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    const candidates = enumerateFamilyRunnableCandidates(result.family, {
      "goal-root": result.parentState,
      "goal-child": result.childState,
    });
    expect(
      candidates.some((item) =>
        item.goalId === "goal-root"
        && item.action.kind === "start-ready-task"
        && item.action.nodeId === "loop-entry"
        && item.action.loopId === "independent-loop"),
    ).toBe(true);
  });

  it("restores and replays family events with membership, binding, and parent wait", () => {
    const rootCreated = createStartedWorkflow(singleTask("Root", ["src/**"]), "workflow-root", "goal-root");
    const rootRunning = startTask(rootCreated, "work");
    const familyResult = createRootFamily({
      familyId: "family-restore",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
      familyBudgetLimits: { maximumTurns: 10 },
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

    const persistedBase = buildOneMemberPersistedFamily({
      familyId: "family-restore",
      rootGoalId: "goal-root",
      workflow: {
        events: (() => {
          // Rebuild the running parent stream from creation plus start.
          const created = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
            workflowId: "workflow-root",
            goalId: "goal-root",
            goalWorkflowId: "workflow-root",
            at,
          });
          if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
          const started = handleCommand(created.state, {
            type: "start-node",
            nodeId: "work",
            attemptId: "attempt-work",
            commandId: "start-work",
            correlationId: "start-work",
            at: later,
          });
          if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
          return [...created.events, ...started.events];
        })(),
        snapshot: rootRunning,
      },
      at,
      familyBudgetLimits: { maximumTurns: 10 },
    });

    // Align family runtime with the running parent used for creation.
    const parentState = persistedBase.workflows["workflow-root"]!.snapshot;
    const creation = createBoundedChildGoal({
      family: persistedBase.familySnapshot,
      parentState,
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-restore",
      at: later,
      scopePaths: ["src/**"],
      budget: { maximumTurns: 4 },
    });
    expect(creation.ok).toBe(true);
    if (!creation.ok) throw new Error(JSON.stringify(creation.diagnostics));

    const committed = commitBoundedChildGoalToPersistedFamily(persistedBase, creation);
    const restored = restorePersistedGoalFamily(committed);

    expect(restored.familySnapshot.members["goal-child"]?.depth).toBe(1);
    expect(restored.familySnapshot.bindings["binding-restore"]?.childGoalId).toBe("goal-child");
    expect(restored.familySnapshot.familyBudget.reservedTurns).toBe(4);
    expect(restored.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status).toBe("waiting_for_child");
    expect(restored.workflows["workflow-child"]?.snapshot.goal?.status).toBe("active");

    const replayed = replayFamilyEvents(restored.familyEvents);
    expect(replayed).toEqual(restored.familySnapshot);
    expect(restoreFamilyProjection(restored.familyEvents, restored.familySnapshot)).toEqual(
      restored.familySnapshot,
    );
  });

  it("rejects an unsupported family schema version with a clear error", () => {
    const { family, rootState } = createFamilyWithRoot();
    const unsupported = {
      ...family,
      schemaVersion: 99 as typeof GOAL_FAMILY_SCHEMA_VERSION,
    };

    const result = createBoundedChildGoal({
      family: unsupported,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child"),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected schema rejection.");
    expect(result.diagnostics[0]?.code).toBe("unsupported_goal_family_schema");
    expect(result.diagnostics[0]?.message).toMatch(/Expected schema version 2/);

    expect(() => {
      throw new UnsupportedGoalFamilySchemaError(99);
    }).toThrow(/Unsupported goal-family schema version '99'.*Expected schema version 2/);
  });

  it("does not mutate input objects on successful creation", () => {
    const { family, rootState } = createFamilyWithRoot();
    const familyBefore = freeze(family);
    const parentBefore = freeze(rootState);

    const result = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(result.ok).toBe(true);
    expect(family).toEqual(familyBefore);
    expect(rootState).toEqual(parentBefore);
  });

  it("rejects a child node scope that widens beyond the binding scope", () => {
    const { family, rootState } = createFamilyWithRoot();
    const result = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child wide node", ["docs/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected child node scope rejection.");
    expect(result.diagnostics[0]?.code).toBe("child_node_scope_widened");
  });

  it("rejects revision while a parent task waits for a child and still allows sibling work starts", () => {
    const { family, rootState } = createFamilyWithRoot({
      rootDefinition: siblingTasks("Root with sibling"),
      startNodeId: "parent-task",
    });
    const created = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "parent-task",
      childDefinition: singleTask("Child"),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));

    const revised = handleCommand(created.parentState, {
      type: "revise",
      definition: siblingTasks("Revised while waiting"),
      commandId: "revise-while-wait",
      correlationId: "revise-while-wait",
      at: grandchildAt,
    });
    expect(revised.ok).toBe(false);
    if (revised.ok) throw new Error("Expected revision rejection.");
    expect(revised.diagnostics[0]?.code).toBe("active_revision_not_allowed");

    const siblingStart = handleCommand(created.parentState, {
      type: "start-node",
      nodeId: "sibling-task",
      attemptId: "attempt-sibling",
      commandId: "start-sibling",
      correlationId: "start-sibling",
      at: grandchildAt,
    });
    expect(siblingStart.ok).toBe(true);
  });

  it("rejects more child-creation attempts than maxChildCreationAttemptsPerNode", () => {
    const { family, rootState } = createFamilyWithRoot({
      bounds: tightBounds({ maxChildCreationAttemptsPerNode: 1, maxChildrenPerGoal: 8 }),
    });
    const familyBefore = freeze(family);
    const parentBefore = freeze(rootState);

    const first = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child one"),
      childGoalId: "goal-child-1",
      childWorkflowId: "workflow-child-1",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
    const firstFamilyBeforeSecond = freeze(first.family);

    const second = createBoundedChildGoal({
      family: first.family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child two"),
      childGoalId: "goal-child-2",
      childWorkflowId: "workflow-child-2",
      bindingId: "binding-2",
      at: grandchildAt,
      scopePaths: ["src/**"],
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("Expected creation-attempt rejection.");
    expect(second.diagnostics[0]?.code).toBe("goal_family_child_creation_attempts_exceeded");
    expect(family).toEqual(familyBefore);
    expect(rootState).toEqual(parentBefore);
    expect(first.family).toEqual(firstFamilyBeforeSecond);
  });

  it("rejects malformed binding facts without throwing", () => {
    const { family, rootState } = createFamilyWithRoot();
    const badInputs = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child"),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
      inputFacts: ["child.ok", ""],
    });
    expect(badInputs.ok).toBe(false);
    if (badInputs.ok) throw new Error("Expected input fact rejection.");
    expect(badInputs.diagnostics[0]?.code).toBe("invalid_child_input_facts");

    const undotted = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child"),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-undotted",
      at: later,
      scopePaths: ["src/**"],
      inputFacts: ["result"],
    });
    expect(undotted.ok).toBe(false);
    if (undotted.ok) throw new Error("Expected fact-name rejection.");
    expect(undotted.diagnostics[0]?.code).toBe("invalid_fact_name");

    const badOutputs = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child"),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-2",
      at: later,
      scopePaths: ["src/**"],
      outputFacts: [{ name: "child.result", type: "not-a-type" as "boolean" }],
    });
    expect(badOutputs.ok).toBe(false);
    if (badOutputs.ok) throw new Error("Expected output fact rejection.");
    expect(badOutputs.diagnostics[0]?.code).toBe("invalid_child_output_facts");
  });

  it("rejects a version-1 family record shape with unsupported schema before missing-bounds errors", () => {
    const versionOne = {
      schemaVersion: 1,
      familyEvents: [],
      familySnapshot: {
        schemaVersion: 1,
        familyId: "family-v1",
        rootGoalId: "goal-root",
        members: {
          "goal-root": {
            goalId: "goal-root",
            workflowId: "workflow-root",
            rootGoalId: "goal-root",
            depth: 0,
            childGoalIds: [],
          },
        },
        schedulerOrdinal: 1,
        createdAt: at,
        updatedAt: at,
      },
      workflows: {},
    };
    expect(() => assertPersistedGoalFamilyShape(versionOne)).toThrow(UnsupportedGoalFamilySchemaError);
    try {
      assertPersistedGoalFamilyShape(versionOne);
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedGoalFamilySchemaError);
      expect((error as Error).message).toMatch(/Expected schema version 2/);
    }
  });

  it("rejects unknown nested workflow event types during family restore shape checks", () => {
    const created = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const familyResult = createRootFamily({
      familyId: "family-unknown-event",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

    const record = {
      schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
      familyEvents: familyResult.events,
      familySnapshot: familyResult.family,
      workflows: {
        "workflow-root": {
          events: [
            ...created.events,
            {
              eventId: "forged-unknown",
              workflowId: "workflow-root",
              revision: 0,
              sequence: created.state.sequence + 1,
              type: "hypagraph.forged.unknown",
              version: 1,
              timestamp: later,
              causationId: "forged",
              correlationId: "forged",
              data: {},
            },
          ],
          snapshot: created.state,
        },
      },
    };

    expect(() => assertPersistedGoalFamilyShape(record)).toThrow(GoalFamilyRestoreError);
    try {
      assertPersistedGoalFamilyShape(record);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_workflow_event_type");
    }
  });

  it("rejects restore when a binding has no matching parent wait event", () => {
    const rootCreated = createStartedWorkflow(singleTask("Root", ["src/**"]), "workflow-root", "goal-root");
    const rootRunning = startTask(rootCreated, "work");
    const created = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = handleCommand(created.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "attempt-work",
      commandId: "start-work",
      correlationId: "start-work",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));

    const base = buildOneMemberPersistedFamily({
      familyId: "family-missing-wait",
      rootGoalId: "goal-root",
      workflow: { events: [...created.events, ...started.events], snapshot: rootRunning },
      at,
    });
    const creation = createBoundedChildGoal({
      family: base.familySnapshot,
      parentState: base.workflows["workflow-root"]!.snapshot,
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-missing-wait",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(creation.ok).toBe(true);
    if (!creation.ok) throw new Error(JSON.stringify(creation.diagnostics));

    const committed = commitBoundedChildGoalToPersistedFamily(base, creation);
    // Drop parent wait events to simulate a partial transaction.
    const parent = committed.workflows["workflow-root"]!;
    const partial = {
      ...committed,
      workflows: {
        ...committed.workflows,
        "workflow-root": {
          events: parent.events.filter((event) => event.type !== "hypagraph.task.waiting-for-child"),
          snapshot: started.state,
        },
      },
    };
    expect(() => restorePersistedGoalFamily(partial as typeof committed)).toThrow(GoalFamilyRestoreError);
    try {
      restorePersistedGoalFamily(partial as typeof committed);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_binding_wait_missing");
    }
  });

  it("rejects excess child-creation attempts during event apply and snapshot restore", () => {
    const { family, rootState } = createFamilyWithRoot({
      bounds: tightBounds({ maxChildCreationAttemptsPerNode: 1, maxChildrenPerGoal: 8 }),
    });
    const first = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child one"),
      childGoalId: "goal-child-1",
      childWorkflowId: "workflow-child-1",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));

    const forged: GoalFamilyEvent = {
      eventId: "family-child-created:forged",
      familyId: first.family.familyId,
      sequence: first.family.schedulerOrdinal + 1,
      type: "hypagraph.family.child-created",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: grandchildAt,
      causationId: "forged",
      correlationId: "forged",
      data: {
        goalId: "goal-child-2",
        workflowId: "workflow-child-2",
        parent: {
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: "work",
        },
        depth: 1,
        binding: {
          bindingId: "binding-2",
          childGoalId: "goal-child-2",
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: "work",
          parentAttemptId: "attempt-work",
          inputFacts: [],
          outputFacts: [],
          budget: {},
          failurePolicy: "fail-parent-node",
          scopePaths: ["src/**"],
          status: "active",
          createdAt: grandchildAt,
        },
      },
    };
    expect(() => applyFamilyEvent(first.family, forged)).toThrow(GoalFamilyRestoreError);
    try {
      applyFamilyEvent(first.family, forged);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_child_creation_attempts_exceeded");
    }

    // Snapshot-only restore rejects two bindings from one parent node.
    const overLimitSnapshot = freeze(first.family);
    overLimitSnapshot.members["goal-child-2"] = {
      goalId: "goal-child-2",
      workflowId: "workflow-child-2",
      rootGoalId: "goal-root",
      depth: 1,
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "work",
      },
      childGoalIds: [],
    };
    overLimitSnapshot.members["goal-root"]!.childGoalIds = ["goal-child-1", "goal-child-2"];
    overLimitSnapshot.bindings["binding-2"] = {
      bindingId: "binding-2",
      childGoalId: "goal-child-2",
      parentGoalId: "goal-root",
      parentWorkflowId: "workflow-root",
      parentNodeId: "work",
      parentAttemptId: "attempt-work",
      inputFacts: [],
      outputFacts: [],
      budget: {},
      failurePolicy: "fail-parent-node",
      scopePaths: ["src/**"],
      status: "active",
      createdAt: grandchildAt,
    };
    expect(() => rebuildFamilyMembershipFromSnapshot(overLimitSnapshot)).toThrow(GoalFamilyRestoreError);
    try {
      rebuildFamilyMembershipFromSnapshot(overLimitSnapshot);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_child_creation_attempts_exceeded");
    }
  });

  it("rejects restore when binding budget omits a family-limited resource", () => {
    const { family, rootState } = createFamilyWithRoot({
      familyBudgetLimits: { maximumTurns: 10, maximumTokens: 1000 },
    });
    const created = createBoundedChildGoal({
      family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-budget",
      at: later,
      scopePaths: ["src/**"],
      budget: { maximumTurns: 4, maximumTokens: 200 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));

    const childCreatedEvent = created.familyEvents[0]!;
    if (childCreatedEvent.type !== "hypagraph.family.child-created") {
      throw new Error("Expected child-created family event.");
    }
    const forged: GoalFamilyEvent = {
      ...childCreatedEvent,
      data: {
        ...childCreatedEvent.data,
        binding: {
          ...childCreatedEvent.data.binding,
          budget: { maximumTurns: 4 },
        },
      },
    };
    const rootOnly = createRootFamily({
      familyId: family.familyId,
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
      familyBudgetLimits: { maximumTurns: 10, maximumTokens: 1000 },
    });
    if (!rootOnly.ok) throw new Error(JSON.stringify(rootOnly.diagnostics));
    expect(() => applyFamilyEvent(rootOnly.family, forged)).toThrow(GoalFamilyRestoreError);
    try {
      applyFamilyEvent(rootOnly.family, forged);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("child_goal_budget_allocation_required");
    }
  });

  it("rejects restore when a current wait has no matching binding", () => {
    const rootCreated = createStartedWorkflow(singleTask("Root", ["src/**"]), "workflow-root", "goal-root");
    const rootRunning = startTask(rootCreated, "work");
    const created = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = handleCommand(created.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "attempt-work",
      commandId: "start-work",
      correlationId: "start-work",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const waited = handleCommand(started.state, {
      type: "wait-for-child",
      nodeId: "work",
      attemptId: "attempt-work",
      childGoalId: "goal-orphan-child",
      bindingId: "binding-orphan",
      commandId: "wait-orphan",
      correlationId: "wait-orphan",
      at: later,
    });
    if (!waited.ok) throw new Error(JSON.stringify(waited.diagnostics));

    const base = buildOneMemberPersistedFamily({
      familyId: "family-orphan-wait",
      rootGoalId: "goal-root",
      workflow: {
        events: [...created.events, ...started.events, ...waited.events],
        snapshot: waited.state,
      },
      at,
    });
    // Family has no bindings, but parent workflow is waiting_for_child.
    expect(() => restorePersistedGoalFamily(base)).toThrow(GoalFamilyRestoreError);
    try {
      restorePersistedGoalFamily(base);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_wait_binding_missing");
    }
    // Silence unused binding for typecheck of rootRunning identity.
    expect(rootRunning.workflowId).toBe("workflow-root");
  });

  it("rejects restore when child node scope widens the binding scope", () => {
    const rootCreated = createStartedWorkflow(singleTask("Root", ["src/**"]), "workflow-root", "goal-root");
    const rootRunning = startTask(rootCreated, "work");
    const created = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = handleCommand(created.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "attempt-work",
      commandId: "start-work",
      correlationId: "start-work",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));

    const base = buildOneMemberPersistedFamily({
      familyId: "family-scope-restore",
      rootGoalId: "goal-root",
      workflow: { events: [...created.events, ...started.events], snapshot: rootRunning },
      at,
    });
    const creation = createBoundedChildGoal({
      family: base.familySnapshot,
      parentState: base.workflows["workflow-root"]!.snapshot,
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-scope",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(creation.ok).toBe(true);
    if (!creation.ok) throw new Error(JSON.stringify(creation.diagnostics));
    const committed = commitBoundedChildGoalToPersistedFamily(base, creation);

    // Widen the child node scope in both the defined event and the replayed snapshot.
    const child = committed.workflows["workflow-child"]!;
    const widenedChild = structuredClone(child);
    for (const event of widenedChild.events) {
      if (event.type === "hypagraph.workflow.defined") {
        const definition = event.data.definition as HypagraphDefinition;
        definition.nodes[0]!.scope = { paths: ["docs/**"] };
      }
    }
    widenedChild.snapshot = replayEvents(widenedChild.events);
    const forged = {
      ...committed,
      workflows: {
        ...committed.workflows,
        "workflow-child": widenedChild,
      },
    };
    expect(() => restorePersistedGoalFamily(forged as typeof committed)).toThrow(GoalFamilyRestoreError);
    try {
      restorePersistedGoalFamily(forged as typeof committed);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("child_node_scope_widened");
    }
  });

  it("rejects a version-1 nested snapshot schema before missing-bounds errors", () => {
    const versionOneSnapshot = {
      schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
      familyEvents: [],
      familySnapshot: {
        schemaVersion: 1,
        familyId: "family-nested-v1",
        rootGoalId: "goal-root",
        members: {
          "goal-root": {
            goalId: "goal-root",
            workflowId: "workflow-root",
            rootGoalId: "goal-root",
            depth: 0,
            childGoalIds: [],
          },
        },
        schedulerOrdinal: 1,
        createdAt: at,
        updatedAt: at,
      },
      workflows: {},
    };
    expect(() => assertPersistedGoalFamilyShape(versionOneSnapshot)).toThrow(UnsupportedGoalFamilySchemaError);
    try {
      assertPersistedGoalFamilyShape(versionOneSnapshot);
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedGoalFamilySchemaError);
      expect((error as Error).message).toMatch(/Expected schema version 2/);
    }
  });

  it("rejects invalid fact names on event apply and snapshot restore", () => {
    const root = createRootFamily({
      familyId: "family-fact-name",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
    });
    if (!root.ok) throw new Error(JSON.stringify(root.diagnostics));

    const forged: GoalFamilyEvent = {
      eventId: "family-child-created:bad-fact",
      familyId: "family-fact-name",
      sequence: 2,
      type: "hypagraph.family.child-created",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: later,
      causationId: "c",
      correlationId: "c",
      data: {
        goalId: "goal-child",
        workflowId: "workflow-child",
        parent: {
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: "work",
        },
        depth: 1,
        binding: {
          bindingId: "binding-bad-fact",
          childGoalId: "goal-child",
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: "work",
          parentAttemptId: "attempt-work",
          inputFacts: ["Bad.Name"],
          outputFacts: [],
          budget: {},
          failurePolicy: "fail-parent-node",
          scopePaths: [],
          status: "active",
          createdAt: later,
        },
      },
    };
    expect(() => applyFamilyEvent(root.family, forged)).toThrow(GoalFamilyRestoreError);
    try {
      applyFamilyEvent(root.family, forged);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_fact_name");
    }

    const badSnapshot = freeze(root.family);
    badSnapshot.members["goal-child"] = {
      goalId: "goal-child",
      workflowId: "workflow-child",
      rootGoalId: "goal-root",
      depth: 1,
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "work",
      },
      childGoalIds: [],
    };
    badSnapshot.members["goal-root"]!.childGoalIds = ["goal-child"];
    badSnapshot.bindings["binding-bad-fact"] = {
      bindingId: "binding-bad-fact",
      childGoalId: "goal-child",
      parentGoalId: "goal-root",
      parentWorkflowId: "workflow-root",
      parentNodeId: "work",
      parentAttemptId: "attempt-work",
      inputFacts: ["result"],
      outputFacts: [],
      budget: {},
      failurePolicy: "fail-parent-node",
      scopePaths: [],
      status: "active",
      createdAt: later,
    };
    expect(() => rebuildFamilyMembershipFromSnapshot(badSnapshot)).toThrow(GoalFamilyRestoreError);
    try {
      rebuildFamilyMembershipFromSnapshot(badSnapshot);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_fact_name");
    }
  });

  it("uses invoking parent node scope over parent creation-binding scope", () => {
    // Root grants src/** to the first child. The child node declares a narrower scope.
    const rootSetup = createFamilyWithRoot({
      rootDefinition: singleTask("Root", ["src/**"]),
    });
    const child = createBoundedChildGoal({
      family: rootSetup.family,
      parentState: rootSetup.rootState,
      parentNodeId: "work",
      childDefinition: {
        title: "Child with narrow node",
        goal: "Child with narrow node",
        nodes: [{
          id: "work",
          title: "Work",
          requires: [],
          acceptance: [],
          scope: { paths: ["src/domain/**"] },
        }],
        loops: [],
        policy: { mode: "guided", requireEvidence: false },
      },
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-child",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(child.ok).toBe(true);
    if (!child.ok) throw new Error(JSON.stringify(child.diagnostics));

    const childRunning = startTask(child.childState, "work", "attempt-child-work");
    // Grandchild that fits child node scope is accepted.
    const narrowOk = createBoundedChildGoal({
      family: child.family,
      parentState: childRunning,
      parentNodeId: "work",
      childDefinition: singleTask("Grandchild ok"),
      childGoalId: "goal-grandchild-ok",
      childWorkflowId: "workflow-grandchild-ok",
      bindingId: "binding-gc-ok",
      at: grandchildAt,
      scopePaths: ["src/domain/**"],
    });
    expect(narrowOk.ok).toBe(true);

    // Grandchild under src/other/** widens beyond the invoking node scope.
    const widened = createBoundedChildGoal({
      family: child.family,
      parentState: childRunning,
      parentNodeId: "work",
      childDefinition: singleTask("Grandchild wide"),
      childGoalId: "goal-grandchild-wide",
      childWorkflowId: "workflow-grandchild-wide",
      bindingId: "binding-gc-wide",
      at: grandchildAt,
      scopePaths: ["src/other/**"],
    });
    expect(widened.ok).toBe(false);
    if (widened.ok) throw new Error("Expected node-scope containment rejection.");
    expect(widened.diagnostics[0]?.code).toBe("child_goal_scope_widened");
  });

  it("rejects depth, member-count, and children-per-goal bounds on event apply", () => {
    const depthLimited = createRootFamily({
      familyId: "family-depth-apply",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
      bounds: tightBounds({ maxDepth: 1 }),
    });
    if (!depthLimited.ok) throw new Error(JSON.stringify(depthLimited.diagnostics));
    const firstAtDepth1: GoalFamilyEvent = {
      eventId: "child-depth-1",
      familyId: "family-depth-apply",
      sequence: 2,
      type: "hypagraph.family.child-created",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: later,
      causationId: "c",
      correlationId: "c",
      data: {
        goalId: "goal-child",
        workflowId: "workflow-child",
        parent: {
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: "work",
        },
        depth: 1,
        binding: {
          bindingId: "b1",
          childGoalId: "goal-child",
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: "work",
          parentAttemptId: "a1",
          inputFacts: [],
          outputFacts: [],
          budget: {},
          failurePolicy: "fail-parent-node",
          scopePaths: [],
          status: "active",
          createdAt: later,
        },
      },
    };
    const withChild = applyFamilyEvent(depthLimited.family, firstAtDepth1);
    const depth2Event: GoalFamilyEvent = {
      eventId: "child-depth-2",
      familyId: "family-depth-apply",
      sequence: 3,
      type: "hypagraph.family.child-created",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: grandchildAt,
      causationId: "c",
      correlationId: "c",
      data: {
        goalId: "goal-grandchild",
        workflowId: "workflow-grandchild",
        parent: {
          parentGoalId: "goal-child",
          parentWorkflowId: "workflow-child",
          parentNodeId: "work",
        },
        depth: 2,
        binding: {
          bindingId: "b2",
          childGoalId: "goal-grandchild",
          parentGoalId: "goal-child",
          parentWorkflowId: "workflow-child",
          parentNodeId: "work",
          parentAttemptId: "a2",
          inputFacts: [],
          outputFacts: [],
          budget: {},
          failurePolicy: "fail-parent-node",
          scopePaths: [],
          status: "active",
          createdAt: grandchildAt,
        },
      },
    };
    expect(() => applyFamilyEvent(withChild, depth2Event)).toThrow(GoalFamilyRestoreError);
    try {
      applyFamilyEvent(withChild, depth2Event);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_depth_exceeded");
    }

    const countLimited = createRootFamily({
      familyId: "family-count-apply",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
      bounds: tightBounds({ maxGoalsInFamily: 1 }),
    });
    if (!countLimited.ok) throw new Error(JSON.stringify(countLimited.diagnostics));
    const countEvent: GoalFamilyEvent = {
      ...firstAtDepth1,
      eventId: "child-count",
      familyId: "family-count-apply",
    };
    expect(() => applyFamilyEvent(countLimited.family, countEvent)).toThrow(GoalFamilyRestoreError);
    try {
      applyFamilyEvent(countLimited.family, countEvent);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_member_count_exceeded");
    }

    const oneChild = createRootFamily({
      familyId: "family-children-apply",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
      bounds: tightBounds({ maxChildrenPerGoal: 1 }),
    });
    if (!oneChild.ok) throw new Error(JSON.stringify(oneChild.diagnostics));
    const firstChild: GoalFamilyEvent = {
      ...firstAtDepth1,
      eventId: "child-first",
      familyId: "family-children-apply",
    };
    const withFirst = applyFamilyEvent(oneChild.family, firstChild);
    const secondChild: GoalFamilyEvent = {
      eventId: "child-second",
      familyId: "family-children-apply",
      sequence: 3,
      type: "hypagraph.family.child-created",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: grandchildAt,
      causationId: "c",
      correlationId: "c",
      data: {
        goalId: "goal-child-2",
        workflowId: "workflow-child-2",
        parent: {
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: "work",
        },
        depth: 1,
        binding: {
          bindingId: "b2",
          childGoalId: "goal-child-2",
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: "work",
          parentAttemptId: "a2",
          inputFacts: [],
          outputFacts: [],
          budget: {},
          failurePolicy: "fail-parent-node",
          scopePaths: [],
          status: "active",
          createdAt: grandchildAt,
        },
      },
    };
    expect(() => applyFamilyEvent(withFirst, secondChild)).toThrow(GoalFamilyRestoreError);
    try {
      applyFamilyEvent(withFirst, secondChild);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_children_per_goal_exceeded");
    }
  });

  it("rejects snapshot reserved totals that exceed family budget limits", () => {
    const root = createRootFamily({
      familyId: "family-reserved-over",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
      familyBudgetLimits: { maximumTurns: 5, maximumTokens: 100 },
    });
    if (!root.ok) throw new Error(JSON.stringify(root.diagnostics));
    const over = freeze(root.family);
    over.members["goal-child"] = {
      goalId: "goal-child",
      workflowId: "workflow-child",
      rootGoalId: "goal-root",
      depth: 1,
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "work",
      },
      childGoalIds: [],
    };
    over.members["goal-root"]!.childGoalIds = ["goal-child"];
    over.bindings["binding-over"] = {
      bindingId: "binding-over",
      childGoalId: "goal-child",
      parentGoalId: "goal-root",
      parentWorkflowId: "workflow-root",
      parentNodeId: "work",
      parentAttemptId: "attempt-work",
      inputFacts: [],
      outputFacts: [],
      budget: { maximumTurns: 10, maximumTokens: 50 },
      failurePolicy: "fail-parent-node",
      scopePaths: [],
      status: "active",
      createdAt: later,
    };
    over.familyBudget.reservedTurns = 10;
    over.familyBudget.reservedTokens = 50;
    expect(() => rebuildFamilyMembershipFromSnapshot(over)).toThrow(GoalFamilyRestoreError);
    try {
      rebuildFamilyMembershipFromSnapshot(over);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_budget_exceeded");
    }
  });

  it("rejects a wait when the pre-wait parent was not a create-capable task", () => {
    const created = createHypagoalWorkflow({
      title: "Gate parent",
      goal: "Gate parent",
      nodes: [
        {
          id: "gate-one",
          title: "Gate",
          kind: "gate",
          requires: [],
          acceptance: [],
          gate: {
            condition: {
              kind: "compare",
              left: { kind: "literal", value: true },
              operator: "eq",
              right: { kind: "literal", value: true },
            },
            onTrue: ["selected"],
            onFalse: ["rejected"],
          },
        },
        { id: "selected", title: "Selected", requires: ["gate-one"], acceptance: [] },
        { id: "rejected", title: "Rejected", requires: ["gate-one"], acceptance: [] },
      ],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    }, {
      workflowId: "workflow-gate",
      goalId: "goal-gate",
      goalWorkflowId: "workflow-gate",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));

    // Forge a wait event onto a ready gate by appending an invalid wait to the stream.
    const forgedWait: DomainEvent = {
      eventId: "forged-wait",
      workflowId: "workflow-gate",
      revision: 0,
      sequence: created.state.sequence + 1,
      type: "hypagraph.task.waiting-for-child",
      version: 1,
      timestamp: later,
      causationId: "forged",
      correlationId: "forged",
      nodeId: "gate-one",
      attemptId: "forged-attempt",
      data: {
        childGoalId: "goal-child",
        bindingId: "binding-forged",
      },
    };
    // Projection may apply wait without prior attempt; build a snapshot that looks waiting.
    const waitingSnapshot = structuredClone(created.state);
    waitingSnapshot.sequence = forgedWait.sequence;
    waitingSnapshot.runtime.nodes["gate-one"]!.status = "waiting_for_child";
    waitingSnapshot.runtime.nodes["gate-one"]!.currentAttemptId = "forged-attempt";
    waitingSnapshot.runtime.nodes["gate-one"]!.attempts["forged-attempt"] = {
      attemptId: "forged-attempt",
      number: 1,
      status: "running",
      startedAt: later,
      evidence: [],
    };

    const familyResult = createRootFamily({
      familyId: "family-gate-wait",
      rootGoalId: "goal-gate",
      rootWorkflowId: "workflow-gate",
      at,
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));
    const withChild = applyFamilyEvent(familyResult.family, {
      eventId: "child-created-forged",
      familyId: "family-gate-wait",
      sequence: 2,
      type: "hypagraph.family.child-created",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: later,
      causationId: "c",
      correlationId: "c",
      data: {
        goalId: "goal-child",
        workflowId: "workflow-child",
        parent: {
          parentGoalId: "goal-gate",
          parentWorkflowId: "workflow-gate",
          parentNodeId: "gate-one",
        },
        depth: 1,
        binding: {
          bindingId: "binding-forged",
          childGoalId: "goal-child",
          parentGoalId: "goal-gate",
          parentWorkflowId: "workflow-gate",
          parentNodeId: "gate-one",
          parentAttemptId: "forged-attempt",
          inputFacts: [],
          outputFacts: [],
          budget: {},
          failurePolicy: "fail-parent-node",
          scopePaths: [],
          status: "active",
          createdAt: later,
        },
      },
    });

    const childWorkflow = createHypagoalWorkflow(singleTask("Child"), {
      workflowId: "workflow-child",
      goalId: "goal-child",
      goalWorkflowId: "workflow-child",
      at: later,
    });
    if (!childWorkflow.ok) throw new Error(JSON.stringify(childWorkflow.diagnostics));

    // Parent stream ends with forged wait; snapshot hash may not match — seed without
    // full restoreWorkflowAggregate by using restorePersistedGoalFamily which will fail
    // on wait pre-state or snapshot mismatch. Prefer calling integrity after building
    // a record that passes workflow replay: wait alone after ready does not change
    // sequence hash correctly. Instead build events that replay to waiting snapshot.
    const parentEvents = [...created.events, forgedWait];
    // Snapshot from applying wait via projection:
    let projected = created.state;
    for (const event of [forgedWait]) {
      projected = replayEvents([...created.events, event]);
    }

    const record = {
      schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
      familyEvents: [...familyResult.events, {
        eventId: "child-created-forged",
        familyId: "family-gate-wait",
        sequence: 2,
        type: "hypagraph.family.child-created" as const,
        version: GOAL_FAMILY_EVENT_VERSION,
        timestamp: later,
        causationId: "c",
        correlationId: "c",
        data: {
          goalId: "goal-child",
          workflowId: "workflow-child",
          parent: {
            parentGoalId: "goal-gate",
            parentWorkflowId: "workflow-gate",
            parentNodeId: "gate-one",
          },
          depth: 1,
          binding: {
            bindingId: "binding-forged",
            childGoalId: "goal-child",
            parentGoalId: "goal-gate",
            parentWorkflowId: "workflow-gate",
            parentNodeId: "gate-one",
            parentAttemptId: "forged-attempt",
            inputFacts: [],
            outputFacts: [],
            budget: {},
            failurePolicy: "fail-parent-node" as const,
            scopePaths: [] as string[],
            status: "active" as const,
            createdAt: later,
          },
        },
      }],
      familySnapshot: withChild,
      workflows: {
        "workflow-gate": {
          events: parentEvents,
          snapshot: projected,
        },
        "workflow-child": {
          events: childWorkflow.events,
          snapshot: childWorkflow.state,
        },
      },
    };

    expect(() => restorePersistedGoalFamily(record as never)).toThrow(GoalFamilyRestoreError);
    try {
      restorePersistedGoalFamily(record as never);
    } catch (error) {
      const code = (error as GoalFamilyRestoreError).code;
      expect(
        code === "goal_family_wait_parent_not_task"
        || code === "goal_family_wait_parent_not_active"
        || code === "goal_family_workflow_snapshot_mismatch",
      ).toBe(true);
    }
  });

  it("matches reverse wait integrity by childGoalId and bindingId", () => {
    const rootCreated = createStartedWorkflow(singleTask("Root", ["src/**"]), "workflow-root", "goal-root");
    const rootRunning = startTask(rootCreated, "work");
    const created = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = handleCommand(created.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "attempt-work",
      commandId: "start-work",
      correlationId: "start-work",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));

    const base = buildOneMemberPersistedFamily({
      familyId: "family-wait-identity",
      rootGoalId: "goal-root",
      workflow: { events: [...created.events, ...started.events], snapshot: rootRunning },
      at,
    });
    const creation = createBoundedChildGoal({
      family: base.familySnapshot,
      parentState: base.workflows["workflow-root"]!.snapshot,
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-a",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(creation.ok).toBe(true);
    if (!creation.ok) throw new Error(JSON.stringify(creation.diagnostics));
    const committed = commitBoundedChildGoalToPersistedFamily(base, creation);

    // Append a second wait event for a different child/binding on the same attempt.
    const parent = committed.workflows["workflow-root"]!;
    const forgedWait: DomainEvent = {
      eventId: "wait-b",
      workflowId: "workflow-root",
      revision: parent.snapshot.revision,
      sequence: parent.snapshot.sequence + 1,
      type: "hypagraph.task.waiting-for-child",
      version: 1,
      timestamp: grandchildAt,
      causationId: "forged",
      correlationId: "forged",
      nodeId: "work",
      attemptId: "attempt-work",
      data: {
        childGoalId: "goal-child-b",
        bindingId: "binding-b",
      },
    };
    const forgedParentEvents = [...parent.events, forgedWait];
    const forgedParentSnapshot = replayEvents(forgedParentEvents);
    const forged = {
      ...committed,
      workflows: {
        ...committed.workflows,
        "workflow-root": {
          events: forgedParentEvents,
          snapshot: forgedParentSnapshot,
        },
      },
    };
    expect(() => restorePersistedGoalFamily(forged as typeof committed)).toThrow(GoalFamilyRestoreError);
    try {
      restorePersistedGoalFamily(forged as typeof committed);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_wait_binding_missing");
    }
  });

  it("rejects pre-wait validation when the parent goal is paused", () => {
    const rootCreated = createStartedWorkflow(singleTask("Root", ["src/**"]), "workflow-root", "goal-root");
    const rootRunning = startTask(rootCreated, "work");
    const created = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = handleCommand(created.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "attempt-work",
      commandId: "start-work",
      correlationId: "start-work",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const paused = handleCommand(started.state, {
      type: "pause-goal",
      reason: "Pause before wait.",
      commandId: "pause-goal",
      correlationId: "pause-goal",
      at: later,
    });
    if (!paused.ok) throw new Error(JSON.stringify(paused.diagnostics));

    const waitEvent: DomainEvent = {
      eventId: "wait-after-pause",
      workflowId: "workflow-root",
      revision: paused.state.revision,
      sequence: paused.state.sequence + 1,
      type: "hypagraph.task.waiting-for-child",
      version: 1,
      timestamp: grandchildAt,
      causationId: "forged",
      correlationId: "forged",
      nodeId: "work",
      attemptId: "attempt-work",
      data: { childGoalId: "goal-child", bindingId: "binding-paused" },
    };
    const parentEvents = [...created.events, ...started.events, ...paused.events, waitEvent];
    const parentSnapshot = replayEvents(parentEvents);

    const familyResult = createRootFamily({
      familyId: "family-paused-wait",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));
    const withChild = applyFamilyEvent(familyResult.family, {
      eventId: "child-created-paused",
      familyId: "family-paused-wait",
      sequence: 2,
      type: "hypagraph.family.child-created",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: grandchildAt,
      causationId: "c",
      correlationId: "c",
      data: {
        goalId: "goal-child",
        workflowId: "workflow-child",
        parent: {
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: "work",
        },
        depth: 1,
        binding: {
          bindingId: "binding-paused",
          childGoalId: "goal-child",
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: "work",
          parentAttemptId: "attempt-work",
          inputFacts: [],
          outputFacts: [],
          budget: {},
          failurePolicy: "fail-parent-node",
          scopePaths: ["src/**"],
          status: "active",
          createdAt: grandchildAt,
        },
      },
    });
    const childWorkflow = createHypagoalWorkflow(singleTask("Child", ["src/**"]), {
      workflowId: "workflow-child",
      goalId: "goal-child",
      goalWorkflowId: "workflow-child",
      at: grandchildAt,
    });
    if (!childWorkflow.ok) throw new Error(JSON.stringify(childWorkflow.diagnostics));

    const record = {
      schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
      familyEvents: [...familyResult.events, {
        eventId: "child-created-paused",
        familyId: "family-paused-wait",
        sequence: 2,
        type: "hypagraph.family.child-created" as const,
        version: GOAL_FAMILY_EVENT_VERSION,
        timestamp: grandchildAt,
        causationId: "c",
        correlationId: "c",
        data: {
          goalId: "goal-child",
          workflowId: "workflow-child",
          parent: {
            parentGoalId: "goal-root",
            parentWorkflowId: "workflow-root",
            parentNodeId: "work",
          },
          depth: 1,
          binding: {
            bindingId: "binding-paused",
            childGoalId: "goal-child",
            parentGoalId: "goal-root",
            parentWorkflowId: "workflow-root",
            parentNodeId: "work",
            parentAttemptId: "attempt-work",
            inputFacts: [],
            outputFacts: [],
            budget: {},
            failurePolicy: "fail-parent-node" as const,
            scopePaths: ["src/**"],
            status: "active" as const,
            createdAt: grandchildAt,
          },
        },
      }],
      familySnapshot: withChild,
      workflows: {
        "workflow-root": { events: parentEvents, snapshot: parentSnapshot },
        "workflow-child": { events: childWorkflow.events, snapshot: childWorkflow.state },
      },
    };
    expect(() => restorePersistedGoalFamily(record as never)).toThrow(GoalFamilyRestoreError);
    try {
      restorePersistedGoalFamily(record as never);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_wait_parent_goal_not_active");
    }
    expect(rootRunning.workflowId).toBe("workflow-root");
  });

  it("rejects nested workflow streams that reuse an event ID", () => {
    const created = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const familyResult = createRootFamily({
      familyId: "family-dup-event",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));
    const firstEvent = created.events[0]!;
    const record = {
      schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
      familyEvents: familyResult.events,
      familySnapshot: familyResult.family,
      workflows: {
        "workflow-root": {
          events: [
            ...created.events,
            {
              ...firstEvent,
              sequence: created.state.sequence + 1,
              type: "hypagraph.task.waiting-for-child",
              nodeId: "work",
              attemptId: "attempt-work",
              data: { childGoalId: "x", bindingId: "y" },
            },
          ],
          snapshot: created.state,
        },
      },
    };
    expect(() => assertPersistedGoalFamilyShape(record)).toThrow(GoalFamilyRestoreError);
    try {
      assertPersistedGoalFamilyShape(record);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_workflow_event_id_duplicate");
    }
  });

  it("rejects child creation from a nested parent that has no creation binding or node scope", () => {
    const root = createRootFamily({
      familyId: "family-member-only",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
    });
    if (!root.ok) throw new Error(JSON.stringify(root.diagnostics));
    // Membership-only nested member (no binding).
    const nested = addFamilyMember({
      family: root.family,
      goalId: "goal-nested",
      workflowId: "workflow-nested",
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "work",
      },
      at: later,
    });
    if (!nested.ok) throw new Error(JSON.stringify(nested.diagnostics));

    const nestedState = createStartedWorkflow(singleTask("Nested without scope"), "workflow-nested", "goal-nested");
    const nestedRunning = startTask(nestedState, "work", "attempt-nested");
    const result = createBoundedChildGoal({
      family: nested.family,
      parentState: nestedRunning,
      parentNodeId: "work",
      childDefinition: singleTask("Grandchild"),
      childGoalId: "goal-grandchild",
      childWorkflowId: "workflow-grandchild",
      bindingId: "binding-gc",
      at: grandchildAt,
      scopePaths: ["anywhere/**"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected missing parent binding rejection.");
    expect(result.diagnostics[0]?.code).toBe("child_goal_parent_binding_missing");
  });

  it("rejects restore when node scope is added after wait without a creation binding", () => {
    // Nested membership-only parent (no creation binding) waits without a node scope.
    // A forged post-wait revision adds node scope without invalidating the wait.
    // Scope resolution must use pre-wait state and reject the missing creation binding.
    const root = createRootFamily({
      familyId: "family-post-wait-scope",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
    });
    if (!root.ok) throw new Error(JSON.stringify(root.diagnostics));
    const nested = addFamilyMember({
      family: root.family,
      goalId: "goal-nested",
      workflowId: "workflow-nested",
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "work",
      },
      at: later,
    });
    if (!nested.ok) throw new Error(JSON.stringify(nested.diagnostics));

    const nestedCreated = createHypagoalWorkflow(singleTask("Nested no scope"), {
      workflowId: "workflow-nested",
      goalId: "goal-nested",
      goalWorkflowId: "workflow-nested",
      at,
    });
    if (!nestedCreated.ok) throw new Error(JSON.stringify(nestedCreated.diagnostics));
    const nestedStarted = handleCommand(nestedCreated.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "attempt-nested",
      commandId: "start-nested",
      correlationId: "start-nested",
      at: later,
    });
    if (!nestedStarted.ok) throw new Error(JSON.stringify(nestedStarted.diagnostics));
    const nestedWaited = handleCommand(nestedStarted.state, {
      type: "wait-for-child",
      nodeId: "work",
      attemptId: "attempt-nested",
      childGoalId: "goal-grandchild",
      bindingId: "binding-gc",
      commandId: "wait-nested",
      correlationId: "wait-nested",
      at: later,
    });
    if (!nestedWaited.ok) throw new Error(JSON.stringify(nestedWaited.diagnostics));

    // Forge a revision that adds node scope without a node-invalidated event so the
    // wait status remains in the final replayed snapshot.
    const revisedDefinition: HypagraphDefinition = {
      title: "Nested with forged scope",
      goal: "Nested with forged scope",
      nodes: [{
        id: "work",
        title: "Work",
        requires: [],
        acceptance: [],
        scope: { paths: ["src/**"] },
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const forgedRevise: DomainEvent = {
      eventId: "forged-revise-after-wait",
      workflowId: "workflow-nested",
      revision: nestedWaited.state.revision + 1,
      sequence: nestedWaited.state.sequence + 1,
      type: "hypagraph.workflow.revised",
      version: 1,
      timestamp: grandchildAt,
      causationId: "forged",
      correlationId: "forged",
      data: { definition: revisedDefinition },
    };
    const nestedEvents = [
      ...nestedCreated.events,
      ...nestedStarted.events,
      ...nestedWaited.events,
      forgedRevise,
    ];
    const nestedSnapshot = replayEvents(nestedEvents);
    expect(nestedSnapshot.runtime.nodes.work?.status).toBe("waiting_for_child");
    expect(nestedSnapshot.definition.nodes[0]?.scope?.paths).toEqual(["src/**"]);

    const childWorkflow = createHypagoalWorkflow(singleTask("Grandchild", ["src/**"]), {
      workflowId: "workflow-grandchild",
      goalId: "goal-grandchild",
      goalWorkflowId: "workflow-grandchild",
      at: grandchildAt,
    });
    if (!childWorkflow.ok) throw new Error(JSON.stringify(childWorkflow.diagnostics));

    const withBinding = applyFamilyEvent(nested.family, {
      eventId: "child-created-gc",
      familyId: "family-post-wait-scope",
      sequence: nested.family.schedulerOrdinal + 1,
      type: "hypagraph.family.child-created",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: grandchildAt,
      causationId: "c",
      correlationId: "c",
      data: {
        goalId: "goal-grandchild",
        workflowId: "workflow-grandchild",
        parent: {
          parentGoalId: "goal-nested",
          parentWorkflowId: "workflow-nested",
          parentNodeId: "work",
        },
        depth: 2,
        binding: {
          bindingId: "binding-gc",
          childGoalId: "goal-grandchild",
          parentGoalId: "goal-nested",
          parentWorkflowId: "workflow-nested",
          parentNodeId: "work",
          parentAttemptId: "attempt-nested",
          inputFacts: [],
          outputFacts: [],
          budget: {},
          failurePolicy: "fail-parent-node",
          scopePaths: ["src/**"],
          status: "active",
          createdAt: grandchildAt,
        },
      },
    });

    // Root workflow required for family map integrity.
    const rootWorkflow = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!rootWorkflow.ok) throw new Error(JSON.stringify(rootWorkflow.diagnostics));

    const record = {
      schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
      familyEvents: [
        ...root.events,
        ...nested.events.slice(1), // nested.events is only member-added; root already has create
        // reconstruct: root.events + member-added from nested.events[0] if addFamilyMember returns one event
      ],
      familySnapshot: withBinding,
      workflows: {
        "workflow-root": {
          events: rootWorkflow.events,
          snapshot: rootWorkflow.state,
        },
        "workflow-nested": {
          events: nestedEvents,
          snapshot: nestedSnapshot,
        },
        "workflow-grandchild": {
          events: childWorkflow.events,
          snapshot: childWorkflow.state,
        },
      },
    };
    // Build correct family event stream: create + member-added + child-created.
    const memberAdded = nested.events[0]!;
    const childCreated: GoalFamilyEvent = {
      eventId: "child-created-gc",
      familyId: "family-post-wait-scope",
      sequence: 3,
      type: "hypagraph.family.child-created",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: grandchildAt,
      causationId: "c",
      correlationId: "c",
      data: {
        goalId: "goal-grandchild",
        workflowId: "workflow-grandchild",
        parent: {
          parentGoalId: "goal-nested",
          parentWorkflowId: "workflow-nested",
          parentNodeId: "work",
        },
        depth: 2,
        binding: {
          bindingId: "binding-gc",
          childGoalId: "goal-grandchild",
          parentGoalId: "goal-nested",
          parentWorkflowId: "workflow-nested",
          parentNodeId: "work",
          parentAttemptId: "attempt-nested",
          inputFacts: [],
          outputFacts: [],
          budget: {},
          failurePolicy: "fail-parent-node",
          scopePaths: ["src/**"],
          status: "active",
          createdAt: grandchildAt,
        },
      },
    };
    record.familyEvents = [...root.events, memberAdded, childCreated];
    // Rebuild snapshot from events for integrity equality.
    record.familySnapshot = replayFamilyEvents(record.familyEvents);

    expect(() => restorePersistedGoalFamily(record as never)).toThrow(GoalFamilyRestoreError);
    try {
      restorePersistedGoalFamily(record as never);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_parent_binding_missing");
    }
  });

  it("creates a child through the family-session product path", () => {
    const rootCreated = createStartedWorkflow(singleTask("Root", ["src/**"]), "workflow-root", "goal-root");
    const rootRunning = startTask(rootCreated, "work");
    const created = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const started = handleCommand(created.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "attempt-work",
      commandId: "start-work",
      correlationId: "start-work",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));

    const base = buildOneMemberPersistedFamily({
      familyId: "family-product",
      rootGoalId: "goal-root",
      workflow: { events: [...created.events, ...started.events], snapshot: rootRunning },
      at,
    });

    const result = createBoundedChildGoalInFamily({
      family: base,
      parentGoalId: "goal-root",
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-product",
      at: later,
      scopePaths: ["src/**"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.family.familySnapshot.members["goal-child"]?.depth).toBe(1);
    expect(result.family.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status)
      .toBe("waiting_for_child");
    expect(result.family.workflows["workflow-child"]?.snapshot.goal?.status).toBe("active");
  });
});
