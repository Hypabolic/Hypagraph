import { describe, expect, it } from "vitest";
import { createBoundedChildGoal } from "../src/domain/child-goal-creation.js";
import {
  goalStatusForChildReturnOutcome,
  returnChildGoal,
} from "../src/domain/child-goal-return.js";
import {
  GOAL_FAMILY_EVENT_VERSION,
  GOAL_FAMILY_SCHEMA_VERSION,
  GoalFamilyRestoreError,
  applyFamilyEvent,
  createRootFamily,
  replayFamilyEvents,
  restoreFamilyProjection,
  type ChildGoalFailurePolicy,
  type ChildReturnOutcomeKind,
  type FamilyBounds,
  type GoalFamilyEvent,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { DomainEvent, FactInput, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { handleCommand } from "../src/domain/reducer.js";
import {
  returnChildGoalInFamily,
} from "../src/persistence/family-session.js";
import {
  buildOneMemberPersistedFamily,
  commitBoundedChildGoalToPersistedFamily,
  commitChildReturnToPersistedFamily,
  restorePersistedGoalFamily,
  type PersistedGoalFamily,
} from "../src/persistence/family-store.js";

const at = "2026-07-29T19:00:00.000Z";
const later = "2026-07-29T19:05:00.000Z";
const returnAt = "2026-07-29T19:10:00.000Z";

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
    {
      id: "parent-task",
      title: "Parent task",
      requires: [],
      acceptance: [],
      scope: { paths: ["src/**"] },
    },
    {
      id: "sibling-task",
      title: "Sibling task",
      requires: [],
      acceptance: [],
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const outputFacts = [
  { name: "child.passed", type: "boolean" as const, required: true },
  { name: "child.note", type: "string" as const },
];

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

const startTask = (
  state: HypagraphState,
  nodeId: string,
  attemptId = `attempt-${nodeId}`,
): HypagraphState => {
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

const createFamilyWithChild = (options?: {
  familyId?: string;
  failurePolicy?: ChildGoalFailurePolicy;
  rootDefinition?: HypagraphDefinition;
  startNodeId?: string;
  outputFacts?: typeof outputFacts;
  bounds?: FamilyBounds;
}) => {
  const familyId = options?.familyId ?? "family-s5";
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
  });
  if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

  const child = createBoundedChildGoal({
    family: familyResult.family,
    parentState: rootState,
    parentNodeId: startNodeId,
    childDefinition: singleTask("Child work", ["src/**"]),
    childGoalId: "goal-child",
    childWorkflowId: "workflow-child",
    bindingId: "binding-child-1",
    at: later,
    scopePaths: ["src/**"],
    ...(options?.failurePolicy ? { failurePolicy: options.failurePolicy } : {}),
    ...(options?.outputFacts ? { outputFacts: options.outputFacts } : { outputFacts }),
  });
  if (!child.ok) throw new Error(JSON.stringify(child.diagnostics));

  return {
    family: child.family,
    familyEvents: [...familyResult.events, ...child.familyEvents],
    parentState: child.parentState,
    parentEvents: child.parentEvents,
    childState: child.childState,
    bindingId: "binding-child-1",
    parentNodeId: startNodeId,
  };
};

const freeze = <T>(value: T): T => structuredClone(value);

const completedFacts = (): FactInput[] => [
  { name: "child.passed", type: "boolean", value: true },
  { name: "child.note", type: "string", value: "done" },
];

/**
 * Produce a terminal child workflow for return validation.
 * Domain returnChildGoal only requires matching terminal goal status.
 * For completed and cancelled, drive real commands. For failed and budget_limited,
 * set the terminal goal status on a clone so tests stay focused on return policy.
 */
const terminalChildState = (
  state: HypagraphState,
  outcome: ChildReturnOutcomeKind,
): HypagraphState => {
  if (outcome === "completed") {
    const nodeId = state.definition.nodes[0]?.id ?? "work";
    const attemptId = `attempt-${nodeId}-terminal`;
    let next = state;
    const apply = (command: Parameters<typeof handleCommand>[1]): void => {
      const result = handleCommand(next, command);
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      next = result.state;
    };
    const runtime = next.runtime.nodes[nodeId];
    if (!runtime || runtime.status === "ready" || runtime.status === "pending") {
      apply({
        type: "start-node",
        nodeId,
        attemptId,
        commandId: `start-${attemptId}`,
        correlationId: `start-${attemptId}`,
        at: returnAt,
      });
    }
    const activeAttempt = next.runtime.nodes[nodeId]?.currentAttemptId ?? attemptId;
    if (next.runtime.nodes[nodeId]?.status === "running") {
      apply({
        type: "submit-result",
        nodeId,
        attemptId: activeAttempt,
        evidence: [{ ref: `evidence://${nodeId}-terminal`, kind: "note" }],
        commandId: `submit-${attemptId}`,
        correlationId: `submit-${attemptId}`,
        at: returnAt,
      });
      apply({
        type: "begin-verification",
        nodeId,
        attemptId: activeAttempt,
        commandId: `begin-${attemptId}`,
        correlationId: `begin-${attemptId}`,
        at: returnAt,
      });
      apply({
        type: "complete-verification",
        nodeId,
        attemptId: activeAttempt,
        passed: true,
        commandId: `complete-${attemptId}`,
        correlationId: `complete-${attemptId}`,
        at: returnAt,
      });
    }
    if (next.goal?.status !== "completed") {
      throw new Error(`Expected completed child goal, got '${next.goal?.status}'.`);
    }
    return next;
  }
  if (outcome === "cancelled") {
    const result = handleCommand(state, {
      type: "cancel-goal",
      reason: "Test cancelled the child goal.",
      commandId: "cancel-child-terminal",
      correlationId: "cancel-child-terminal",
      at: returnAt,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    return result.state;
  }
  const status = goalStatusForChildReturnOutcome(outcome);
  const next = structuredClone(state);
  if (!next.goal) throw new Error("Child state has no goal runtime.");
  next.goal = {
    ...next.goal,
    status,
    stopReason: `Test terminal child status '${status}'.`,
    completedAt: returnAt,
  };
  if (status === "failed") next.phase = "failed";
  return next;
};

/**
 * Drive the persisted child workflow to a terminal status that matches outcome.
 * Completed and cancelled use real commands so restore remains valid.
 * Failed and budget_limited set terminal status on the snapshot and append no events;
 * those product cases use domain returnChildGoal + commit rather than product return.
 */
const withTerminalChildInFamily = (
  family: PersistedGoalFamily,
  childGoalId: string,
  outcome: ChildReturnOutcomeKind,
): PersistedGoalFamily => {
  const member = family.familySnapshot.members[childGoalId];
  if (!member) throw new Error(`Missing child member '${childGoalId}'.`);
  const workflow = family.workflows[member.workflowId];
  if (!workflow) throw new Error(`Missing child workflow '${member.workflowId}'.`);

  if (outcome === "completed" || outcome === "cancelled") {
    const driven = driveChildWithEvents(workflow.snapshot, outcome);
    return {
      ...family,
      workflows: {
        ...family.workflows,
        [member.workflowId]: {
          events: [...workflow.events, ...driven.events],
          snapshot: driven.state,
        },
      },
    };
  }

  const terminal = terminalChildState(workflow.snapshot, outcome);
  return {
    ...family,
    workflows: {
      ...family.workflows,
      [member.workflowId]: {
        events: workflow.events,
        snapshot: terminal,
      },
    },
  };
};

const driveChildWithEvents = (
  state: HypagraphState,
  outcome: "completed" | "cancelled",
): { state: HypagraphState; events: DomainEvent[] } => {
  const events: DomainEvent[] = [];
  let next = state;
  const apply = (command: Parameters<typeof handleCommand>[1]): void => {
    const result = handleCommand(next, command);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    events.push(...result.events);
    next = result.state;
  };
  if (outcome === "cancelled") {
    apply({
      type: "cancel-goal",
      reason: "Test cancelled the child goal.",
      commandId: "cancel-child-terminal",
      correlationId: "cancel-child-terminal",
      at: returnAt,
    });
    return { state: next, events };
  }
  const nodeId = next.definition.nodes[0]?.id ?? "work";
  const attemptId = `attempt-${nodeId}-terminal`;
  apply({
    type: "start-node",
    nodeId,
    attemptId,
    commandId: `start-${attemptId}`,
    correlationId: `start-${attemptId}`,
    at: returnAt,
  });
  apply({
    type: "submit-result",
    nodeId,
    attemptId,
    evidence: [{ ref: `evidence://${nodeId}-terminal`, kind: "note" }],
    commandId: `submit-${attemptId}`,
    correlationId: `submit-${attemptId}`,
    at: returnAt,
  });
  apply({
    type: "begin-verification",
    nodeId,
    attemptId,
    commandId: `begin-${attemptId}`,
    correlationId: `begin-${attemptId}`,
    at: returnAt,
  });
  apply({
    type: "complete-verification",
    nodeId,
    attemptId,
    passed: true,
    commandId: `complete-${attemptId}`,
    correlationId: `complete-${attemptId}`,
    at: returnAt,
  });
  return { state: next, events };
};

describe("M7-S5 child return and parent failure policy", () => {
  it("validates output facts against binding contracts and resumes the parent task without completing it", () => {
    const setup = createFamilyWithChild();
    const familyBefore = freeze(setup.family);
    const parentBefore = freeze(setup.parentState);

    const result = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "completed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
      evidence: [{ ref: "evidence://child-result", kind: "note", summary: "Child done" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(result.binding.status).toBe("returned");
    expect(result.returnRecord.outcome).toBe("completed");
    expect(result.returnRecord.parentEffect).toBe("resumed");
    expect(result.family.bindings[setup.bindingId]?.status).toBe("returned");
    expect(result.family.bindings[setup.bindingId]?.returnRecord?.publishedFacts).toEqual([
      {
        name: "child.passed",
        type: "boolean",
        value: true,
        evidence: [],
      },
      {
        name: "child.note",
        type: "string",
        value: "done",
        evidence: [],
      },
    ]);

    expect(result.parentState.runtime.nodes[setup.parentNodeId]?.status).toBe("running");
    expect(result.parentState.runtime.nodes[setup.parentNodeId]?.currentAttemptId).toBe(
      "attempt-work",
    );
    expect(result.parentState.runtime.facts["child.passed"]?.value).toBe(true);
    expect(result.parentState.runtime.facts["child.note"]?.value).toBe("done");
    expect(result.parentState.goal?.status).toBe("active");
    expect(result.parentState.phase).toBe("running");
    expect(result.parentEvents.some((event) => event.type === "hypagraph.task.child-returned")).toBe(true);
    expect(result.parentEvents.some((event) => event.type === "hypagraph.fact.published")).toBe(true);

    // Inputs are not mutated.
    expect(setup.family).toEqual(familyBefore);
    expect(setup.parentState).toEqual(parentBefore);
  });

  it("rejects missing required output facts and leaves parent waiting with binding unchanged", () => {
    const setup = createFamilyWithChild();
    const familyBefore = freeze(setup.family);
    const parentBefore = freeze(setup.parentState);

    const result = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "completed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "completed",
      facts: [{ name: "child.note", type: "string", value: "partial" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected missing required fact rejection.");
    expect(result.diagnostics[0]?.code).toBe("child_return_required_fact_missing");
    expect(setup.family).toEqual(familyBefore);
    expect(setup.parentState).toEqual(parentBefore);
    expect(setup.parentState.runtime.nodes[setup.parentNodeId]?.status).toBe("waiting_for_child");
    expect(setup.family.bindings[setup.bindingId]?.status).toBe("active");
  });

  it("rejects invalid fact types and undeclared facts without mutating state", () => {
    const setup = createFamilyWithChild();
    const familyBefore = freeze(setup.family);
    const parentBefore = freeze(setup.parentState);

    const wrongType = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "completed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "completed",
      facts: [
        { name: "child.passed", type: "string", value: "yes" },
      ],
    });
    expect(wrongType.ok).toBe(false);
    if (wrongType.ok) throw new Error("Expected type mismatch rejection.");
    expect(wrongType.diagnostics[0]?.code).toBe("fact_type_mismatch");

    const undeclared = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "completed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "completed",
      facts: [
        { name: "child.passed", type: "boolean", value: true },
        { name: "child.unknown", type: "boolean", value: true },
      ],
    });
    expect(undeclared.ok).toBe(false);
    if (undeclared.ok) throw new Error("Expected undeclared fact rejection.");
    expect(undeclared.diagnostics[0]?.code).toBe("child_return_fact_not_declared");

    expect(setup.family).toEqual(familyBefore);
    expect(setup.parentState).toEqual(parentBefore);
  });

  it("applies fail-parent-node as a deterministic parent task failure", () => {
    const setup = createFamilyWithChild({ failurePolicy: "fail-parent-node" });
    const result = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "failed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "failed",
      reason: "Child checks failed.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(result.binding.status).toBe("failed");
    expect(result.returnRecord.parentEffect).toBe("failed");
    expect(result.parentState.runtime.nodes[setup.parentNodeId]?.status).toBe("failed");
    expect(result.parentState.runtime.nodes[setup.parentNodeId]?.currentAttemptId).toBeUndefined();
    expect(result.parentState.goal?.status).toBe("active");
    expect(result.parentEvents.some((event) => event.type === "hypagraph.task.child-return-failed")).toBe(true);
  });

  it("applies block-parent-node as a deterministic parent task block", () => {
    const setup = createFamilyWithChild({ failurePolicy: "block-parent-node" });
    const result = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "failed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "failed",
      reason: "Child is blocked on an external system.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(result.binding.status).toBe("failed");
    expect(result.returnRecord.parentEffect).toBe("blocked");
    const parentNode = result.parentState.runtime.nodes[setup.parentNodeId];
    expect(parentNode?.status).toBe("blocked");
    expect(parentNode?.blockerKind).toBe("external-dependency");
    expect(parentNode?.blockedReason).toContain("external system");
    // When the blocked parent is the only work item, the workflow phase can become blocked.
    // The deterministic policy effect is the parent task block, not a revision request.
    expect(result.parentState.goal?.pendingContinuation).toBeUndefined();
    expect(result.parentEvents.some((event) => event.type === "hypagraph.goal.revision-requested")).toBe(false);
  });

  it("applies return-for-revision as a deterministic parent revision request", () => {
    const setup = createFamilyWithChild({ failurePolicy: "return-for-revision" });
    const result = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "failed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "failed",
      reason: "Child needs a definition change.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(result.binding.status).toBe("failed");
    expect(result.returnRecord.parentEffect).toBe("revision-requested");
    const parentNode = result.parentState.runtime.nodes[setup.parentNodeId];
    expect(parentNode?.status).toBe("blocked");
    expect(parentNode?.blockerKind).toBe("repository-work");
    expect(result.parentState.goal?.status).toBe("blocked");
    expect(result.parentState.goal?.pendingContinuation?.action.kind).toBe("request-revision");
    expect(result.parentState.goal?.automaticRevision.lastAttempt?.outcome).toBe("pending");
    expect(result.parentEvents.some((event) => event.type === "hypagraph.goal.revision-requested")).toBe(true);
  });

  it("applies the child failure policy for budget exhaustion instead of success", () => {
    const setup = createFamilyWithChild({ failurePolicy: "fail-parent-node" });
    const result = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "budget_limited"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "budget_limited",
      facts: [{ name: "child.note", type: "string", value: "partial progress" }],
      reason: "Child turn budget exhausted.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(result.binding.status).toBe("budget_limited");
    expect(result.returnRecord.outcome).toBe("budget_limited");
    expect(result.returnRecord.parentEffect).toBe("failed");
    expect(result.returnRecord.publishedFacts?.[0]?.name).toBe("child.note");
    expect(result.parentState.runtime.nodes[setup.parentNodeId]?.status).toBe("failed");
    // Budget exhaustion must not publish success-path parent resume facts.
    expect(result.parentState.runtime.facts["child.note"]).toBeUndefined();
    expect(result.parentState.runtime.nodes[setup.parentNodeId]?.status).not.toBe("running");
    expect(result.parentState.runtime.nodes[setup.parentNodeId]?.status).not.toBe("succeeded");
  });

  it("applies the failure policy for cancellation and never completes the parent task", () => {
    const setup = createFamilyWithChild({ failurePolicy: "block-parent-node" });
    const result = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "cancelled"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "cancelled",
      reason: "User cancelled the child goal.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(result.binding.status).toBe("cancelled");
    expect(result.returnRecord.parentEffect).toBe("blocked");
    expect(result.parentState.runtime.nodes[setup.parentNodeId]?.status).toBe("blocked");
    expect(result.parentState.runtime.nodes[setup.parentNodeId]?.status).not.toBe("succeeded");
    expect(result.parentState.goal?.status).not.toBe("completed");
    expect(result.parentState.phase).not.toBe("completed");
  });

  it("rejects stale child returns for wrong binding, generation, and already-returned bindings", () => {
    const setup = createFamilyWithChild();

    const missingBinding = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "completed"),
      bindingId: "binding-missing",
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
    });
    expect(missingBinding.ok).toBe(false);
    if (missingBinding.ok) throw new Error("Expected missing binding rejection.");
    expect(missingBinding.diagnostics[0]?.code).toBe("goal_family_binding_missing");

    const wrongAttemptState = structuredClone(setup.parentState);
    wrongAttemptState.runtime.nodes[setup.parentNodeId]!.currentAttemptId = "attempt-other";
    const wrongAttempt = returnChildGoal({
      family: setup.family,
      parentState: wrongAttemptState,
      childState: terminalChildState(setup.childState, "completed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
    });
    expect(wrongAttempt.ok).toBe(false);
    if (wrongAttempt.ok) throw new Error("Expected attempt mismatch rejection.");
    expect(wrongAttempt.diagnostics[0]?.code).toBe("stale_child_return");

    const first = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "completed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));

    const second = returnChildGoal({
      family: first.family,
      parentState: first.parentState,
      childState: terminalChildState(setup.childState, "completed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("Expected already-returned rejection.");
    expect(second.diagnostics[0]?.code).toBe("stale_child_return");

    // Wrong parent goal identity is stale.
    const wrongParentGoal = structuredClone(setup.parentState);
    wrongParentGoal.goal = {
      ...wrongParentGoal.goal!,
      goalId: "goal-other",
    };
    const wrongGoal = returnChildGoal({
      family: setup.family,
      parentState: wrongParentGoal,
      childState: terminalChildState(setup.childState, "completed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
    });
    expect(wrongGoal.ok).toBe(false);
    if (wrongGoal.ok) throw new Error("Expected wrong parent goal rejection.");
    expect(wrongGoal.diagnostics[0]?.code).toBe("stale_child_return");
  });

  it("rejects an unsupported family schema version with a clear diagnostic", () => {
    const setup = createFamilyWithChild();
    const result = returnChildGoal({
      family: {
        ...setup.family,
        schemaVersion: 99 as typeof GOAL_FAMILY_SCHEMA_VERSION,
      },
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "completed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected unsupported schema rejection.");
    expect(result.diagnostics[0]?.code).toBe("unsupported_goal_family_schema");
    expect(result.diagnostics[0]?.message).toMatch(
      /Unsupported goal-family schema version '99'.*Expected schema version 2/,
    );
  });

  it("keeps independent runnable sibling work unaffected by child return", () => {
    const setup = createFamilyWithChild({
      rootDefinition: siblingTasks("Root with sibling"),
      startNodeId: "parent-task",
    });

    // Sibling remains ready while the parent waits.
    expect(setup.parentState.runtime.nodes["sibling-task"]?.status).toBe("ready");
    expect(setup.parentState.runtime.nodes["parent-task"]?.status).toBe("waiting_for_child");

    const result = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "completed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(result.parentState.runtime.nodes["parent-task"]?.status).toBe("running");
    expect(result.parentState.runtime.nodes["sibling-task"]?.status).toBe("ready");
    expect(result.parentState.runtime.nodes["sibling-task"]?.status).not.toBe("succeeded");
    expect(result.parentState.runtime.nodes["parent-task"]?.status).not.toBe("succeeded");
  });

  it("restores and replays family binding terminal status and parent effects", () => {
    const setup = createFamilyWithChild({ failurePolicy: "fail-parent-node" });
    const returned = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "failed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "failed",
      reason: "Child failed for restore test.",
    });
    expect(returned.ok).toBe(true);
    if (!returned.ok) throw new Error(JSON.stringify(returned.diagnostics));

    const events: GoalFamilyEvent[] = [...setup.familyEvents, ...returned.familyEvents];
    const replayed = replayFamilyEvents(events);
    expect(replayed.bindings[setup.bindingId]?.status).toBe("failed");
    expect(replayed.bindings[setup.bindingId]?.returnRecord?.parentEffect).toBe("failed");
    expect(restoreFamilyProjection(events, returned.family)).toEqual(returned.family);

    // Apply path validates identity on restore of the return event alone after creation stream.
    let family = undefined as ReturnType<typeof applyFamilyEvent> | undefined;
    for (const event of events) {
      family = applyFamilyEvent(family, event);
    }
    expect(family?.bindings[setup.bindingId]?.status).toBe("failed");
  });

  it("commits and restores child return through the persisted family product path", () => {
    let rootState = createStartedWorkflow(singleTask("Root", ["src/**"]), "workflow-root", "goal-root");
    rootState = startTask(rootState, "work");
    const rootCreated = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!rootCreated.ok) throw new Error(JSON.stringify(rootCreated.diagnostics));
    const started = handleCommand(rootCreated.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "attempt-work",
      commandId: "start-work",
      correlationId: "start-work",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));

    const oneMember = buildOneMemberPersistedFamily({
      familyId: "family-s5-persist",
      rootGoalId: "goal-root",
      workflow: {
        events: started.ok ? [...rootCreated.events, ...started.events] : [],
        snapshot: started.state,
      },
      at,
    });

    const creation = createBoundedChildGoal({
      family: oneMember.familySnapshot,
      parentState: oneMember.workflows["workflow-root"]!.snapshot,
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-child-1",
      at: later,
      scopePaths: ["src/**"],
      outputFacts,
      failurePolicy: "fail-parent-node",
    });
    expect(creation.ok).toBe(true);
    if (!creation.ok) throw new Error(JSON.stringify(creation.diagnostics));

    const withChild = commitBoundedChildGoalToPersistedFamily(oneMember, creation);
    const withTerminalChild = withTerminalChildInFamily(withChild, "goal-child", "completed");
    const productReturn = returnChildGoalInFamily({
      family: withTerminalChild,
      parentGoalId: "goal-root",
      bindingId: "binding-child-1",
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
    });
    expect(productReturn.ok).toBe(true);
    if (!productReturn.ok) throw new Error(JSON.stringify(productReturn.diagnostics));

    const restored = restorePersistedGoalFamily(productReturn.family);
    expect(restored.familySnapshot.bindings["binding-child-1"]?.status).toBe("returned");
    expect(restored.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status).toBe("running");
    expect(restored.workflows["workflow-root"]?.snapshot.runtime.facts["child.passed"]?.value).toBe(true);

    // Domain purity: ambient clock is not used; caller supplies at.
    expect(restored.familySnapshot.bindings["binding-child-1"]?.returnRecord?.returnedAt).toBe(returnAt);
  });

  it("commits a failed return through the low-level commit helper and restores parent failure", () => {
    let rootState = createStartedWorkflow(singleTask("Root", ["src/**"]), "workflow-root", "goal-root");
    rootState = startTask(rootState, "work");
    const rootCreated = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!rootCreated.ok) throw new Error(JSON.stringify(rootCreated.diagnostics));
    const started = handleCommand(rootCreated.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "attempt-work",
      commandId: "start-work",
      correlationId: "start-work",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));

    const oneMember = buildOneMemberPersistedFamily({
      familyId: "family-s5-fail-persist",
      rootGoalId: "goal-root",
      workflow: {
        events: [...rootCreated.events, ...started.events],
        snapshot: started.state,
      },
      at,
    });
    const creation = createBoundedChildGoal({
      family: oneMember.familySnapshot,
      parentState: oneMember.workflows["workflow-root"]!.snapshot,
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-child-1",
      at: later,
      scopePaths: ["src/**"],
      failurePolicy: "block-parent-node",
    });
    if (!creation.ok) throw new Error(JSON.stringify(creation.diagnostics));
    const withChild = commitBoundedChildGoalToPersistedFamily(oneMember, creation);

    const returned = returnChildGoal({
      family: withChild.familySnapshot,
      parentState: withChild.workflows["workflow-root"]!.snapshot,
      childState: terminalChildState(creation.childState, "cancelled"),
      bindingId: "binding-child-1",
      at: returnAt,
      outcome: "cancelled",
      reason: "Cancelled for commit test.",
    });
    expect(returned.ok).toBe(true);
    if (!returned.ok) throw new Error(JSON.stringify(returned.diagnostics));

    const committed = commitChildReturnToPersistedFamily(withChild, returned);
    const restored = restorePersistedGoalFamily(committed);
    expect(restored.familySnapshot.bindings["binding-child-1"]?.status).toBe("cancelled");
    expect(restored.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status).toBe("blocked");
  });

  it("rejects return-for-revision when automatic revision allowance is exhausted", () => {
    const setup = createFamilyWithChild({ failurePolicy: "return-for-revision" });
    const parentState = structuredClone(setup.parentState);
    parentState.goal = {
      ...parentState.goal!,
      automaticRevision: {
        maximumAttempts: 1,
        consumedAttempts: 1,
      },
    };

    const result = returnChildGoal({
      childState: terminalChildState(setup.childState, "failed"),
      family: setup.family,
      parentState,
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "failed",
      reason: "Revision already used.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected revision-exhausted rejection.");
    expect(result.diagnostics[0]?.code).toBe("child_return_revision_exhausted");
    expect(setup.family.bindings[setup.bindingId]?.status).toBe("active");
  });

  it("terminalises an open attempt that waited from awaiting_evidence on block policy", () => {
    const setup = createFamilyWithChild({ failurePolicy: "block-parent-node" });
    const parentState = structuredClone(setup.parentState);
    const attemptId = parentState.runtime.nodes[setup.parentNodeId]!.currentAttemptId!;
    parentState.runtime.nodes[setup.parentNodeId]!.attempts[attemptId] = {
      ...parentState.runtime.nodes[setup.parentNodeId]!.attempts[attemptId]!,
      status: "submitted",
    };
    // waiting_for_child is the node status; the attempt remains open as submitted/awaiting_evidence class.
    parentState.runtime.nodes[setup.parentNodeId]!.status = "waiting_for_child";
    parentState.runtime.nodes[setup.parentNodeId]!.attempts[attemptId]!.status = "running";
    // Force a non-running open status that used to skip cancellation on block path.
    parentState.runtime.nodes[setup.parentNodeId]!.attempts[attemptId]!.status = "submitted";

    const result = returnChildGoal({
      childState: terminalChildState(setup.childState, "failed"),
      family: setup.family,
      parentState,
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "failed",
      reason: "Block from submitted attempt wait.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const attempt = result.parentState.runtime.nodes[setup.parentNodeId]?.attempts[attemptId];
    expect(attempt?.status).toBe("cancelled");
    expect(result.parentState.runtime.nodes[setup.parentNodeId]?.currentAttemptId).toBeUndefined();
  });

  it("rejects apply when parent effect disagrees with binding failure policy", () => {
    const setup = createFamilyWithChild({ failurePolicy: "fail-parent-node" });
    const forged: GoalFamilyEvent = {
      eventId: "forged-return",
      familyId: setup.family.familyId,
      sequence: setup.family.schedulerOrdinal + 1,
      type: "hypagraph.family.child-return-recorded",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: returnAt,
      causationId: "forged",
      correlationId: "forged",
      data: {
        bindingId: setup.bindingId,
        childGoalId: "goal-child",
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: setup.parentNodeId,
        parentAttemptId: "attempt-work",
        outcome: "failed",
        parentEffect: "blocked",
        returnRecord: {
          outcome: "failed",
          parentEffect: "blocked",
          returnedAt: returnAt,
          stopReason: "Forged policy mismatch.",
        },
      },
    };
    expect(() => applyFamilyEvent(setup.family, forged)).toThrow(GoalFamilyRestoreError);
    try {
      applyFamilyEvent(setup.family, forged);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("child_return_parent_effect_policy_mismatch");
    }
  });

  it("rejects apply when completed return is missing a required output fact", () => {
    const setup = createFamilyWithChild();
    const forged: GoalFamilyEvent = {
      eventId: "forged-missing-required",
      familyId: setup.family.familyId,
      sequence: setup.family.schedulerOrdinal + 1,
      type: "hypagraph.family.child-return-recorded",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: returnAt,
      causationId: "forged",
      correlationId: "forged",
      data: {
        bindingId: setup.bindingId,
        childGoalId: "goal-child",
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: setup.parentNodeId,
        parentAttemptId: "attempt-work",
        outcome: "completed",
        parentEffect: "resumed",
        returnRecord: {
          outcome: "completed",
          parentEffect: "resumed",
          returnedAt: returnAt,
          publishedFacts: [
            { name: "child.note", type: "string", value: "only optional", evidence: [] },
          ],
        },
      },
    };
    expect(() => applyFamilyEvent(setup.family, forged)).toThrow(GoalFamilyRestoreError);
    try {
      applyFamilyEvent(setup.family, forged);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("child_return_required_fact_missing");
    }
  });

  it("rejects apply when published fact type or value is invalid", () => {
    const setup = createFamilyWithChild();
    const badType: GoalFamilyEvent = {
      eventId: "forged-bad-type",
      familyId: setup.family.familyId,
      sequence: setup.family.schedulerOrdinal + 1,
      type: "hypagraph.family.child-return-recorded",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: returnAt,
      causationId: "forged",
      correlationId: "forged",
      data: {
        bindingId: setup.bindingId,
        childGoalId: "goal-child",
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: setup.parentNodeId,
        parentAttemptId: "attempt-work",
        outcome: "completed",
        parentEffect: "resumed",
        returnRecord: {
          outcome: "completed",
          parentEffect: "resumed",
          returnedAt: returnAt,
          publishedFacts: [
            { name: "child.passed", type: "string", value: "yes", evidence: [] },
          ],
        },
      },
    };
    try {
      applyFamilyEvent(setup.family, badType);
      throw new Error("Expected type mismatch rejection.");
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("fact_type_mismatch");
    }

    const badValue: GoalFamilyEvent = {
      ...badType,
      eventId: "forged-bad-value",
      data: {
        ...badType.data,
        returnRecord: {
          outcome: "completed",
          parentEffect: "resumed",
          returnedAt: returnAt,
          publishedFacts: [
            { name: "child.passed", type: "boolean", value: "not-a-boolean" as unknown as boolean, evidence: [] },
          ],
        },
      },
    };
    try {
      applyFamilyEvent(setup.family, badValue);
      throw new Error("Expected value invalid rejection.");
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("fact_value_invalid");
    }

    const undeclared: GoalFamilyEvent = {
      ...badType,
      eventId: "forged-undeclared",
      data: {
        ...badType.data,
        returnRecord: {
          outcome: "completed",
          parentEffect: "resumed",
          returnedAt: returnAt,
          publishedFacts: [
            { name: "child.passed", type: "boolean", value: true, evidence: [] },
            { name: "child.unknown", type: "boolean", value: true, evidence: [] },
          ],
        },
      },
    };
    try {
      applyFamilyEvent(setup.family, undeclared);
      throw new Error("Expected undeclared fact rejection.");
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("child_return_fact_not_declared");
    }
  });

  it("rejects restore when parent return event disagrees with binding return record", () => {
    const rootCreated = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!rootCreated.ok) throw new Error(JSON.stringify(rootCreated.diagnostics));
    const started = handleCommand(rootCreated.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "attempt-work",
      commandId: "start-work",
      correlationId: "start-work",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const oneMember = buildOneMemberPersistedFamily({
      familyId: "family-s5-integrity",
      rootGoalId: "goal-root",
      workflow: {
        events: [...rootCreated.events, ...started.events],
        snapshot: started.state,
      },
      at,
    });
    const creation = createBoundedChildGoal({
      family: oneMember.familySnapshot,
      parentState: oneMember.workflows["workflow-root"]!.snapshot,
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-child-1",
      at: later,
      scopePaths: ["src/**"],
      failurePolicy: "fail-parent-node",
      outputFacts,
    });
    if (!creation.ok) throw new Error(JSON.stringify(creation.diagnostics));
    const withChild = commitBoundedChildGoalToPersistedFamily(oneMember, creation);
    const good = returnChildGoal({
      family: withChild.familySnapshot,
      parentState: withChild.workflows["workflow-root"]!.snapshot,
      childState: terminalChildState(creation.childState, "failed"),
      bindingId: "binding-child-1",
      at: returnAt,
      outcome: "failed",
      reason: "Integrity mismatch base.",
    });
    if (!good.ok) throw new Error(JSON.stringify(good.diagnostics));
    const committed = commitChildReturnToPersistedFamily(withChild, good);

    // Parent event outcome disagrees with binding return record (projection ignores outcome field).
    const outcomeMismatch: PersistedGoalFamily = structuredClone(committed);
    const returnEvent = outcomeMismatch.workflows["workflow-root"]!.events.find(
      (event) => event.type === "hypagraph.task.child-return-failed",
    );
    expect(returnEvent).toBeDefined();
    returnEvent!.data.outcome = "cancelled";
    try {
      restorePersistedGoalFamily(outcomeMismatch);
      throw new Error("Expected outcome mismatch rejection.");
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_binding_return_outcome_mismatch");
    }

    // Parent effect disagrees with durable binding effect (projection still fails the node).
    const effectMismatch: PersistedGoalFamily = structuredClone(committed);
    const effectEvent = effectMismatch.workflows["workflow-root"]!.events.find(
      (event) => event.type === "hypagraph.task.child-return-failed",
    );
    expect(effectEvent).toBeDefined();
    effectEvent!.data.parentEffect = "block-parent-node";
    // Keep snapshot consistent with the rewritten stream so integrity checks run.
    effectMismatch.workflows["workflow-root"]!.snapshot = replayEvents(
      effectMismatch.workflows["workflow-root"]!.events,
    );
    try {
      restorePersistedGoalFamily(effectMismatch);
      throw new Error("Expected parent effect mismatch rejection.");
    } catch (error) {
      // After re-replay, parent is blocked while binding still records fail-parent-node.
      // Either the effect mismatch or the resulting status/blocker mismatch is valid.
      const code = (error as GoalFamilyRestoreError).code;
      expect([
        "goal_family_binding_return_parent_effect_mismatch",
        "goal_family_binding_parent_status_mismatch",
        "goal_family_binding_parent_blocker_mismatch",
      ]).toContain(code);
    }

    // Binding expects completed resume while parent stream records failure after re-replay.
    const successBaseCreation = createBoundedChildGoal({
      family: oneMember.familySnapshot,
      parentState: oneMember.workflows["workflow-root"]!.snapshot,
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-child-1",
      at: later,
      scopePaths: ["src/**"],
      outputFacts,
    });
    if (!successBaseCreation.ok) throw new Error(JSON.stringify(successBaseCreation.diagnostics));
    const successWithChild = commitBoundedChildGoalToPersistedFamily(oneMember, successBaseCreation);
    const successReturn = returnChildGoal({
      family: successWithChild.familySnapshot,
      parentState: successWithChild.workflows["workflow-root"]!.snapshot,
      childState: terminalChildState(successBaseCreation.childState, "completed"),
      bindingId: "binding-child-1",
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
    });
    if (!successReturn.ok) throw new Error(JSON.stringify(successReturn.diagnostics));
    const successCommitted = commitChildReturnToPersistedFamily(successWithChild, successReturn);

    const typeMismatch: PersistedGoalFamily = structuredClone(successCommitted);
    const successEvent = typeMismatch.workflows["workflow-root"]!.events.find(
      (event) => event.type === "hypagraph.task.child-returned",
    );
    expect(successEvent).toBeDefined();
    (successEvent as { type: string }).type = "hypagraph.task.child-return-failed";
    successEvent!.data.parentEffect = "fail-parent-node";
    successEvent!.data.outcome = "failed";
    typeMismatch.workflows["workflow-root"]!.snapshot = replayEvents(
      typeMismatch.workflows["workflow-root"]!.events,
    );
    try {
      restorePersistedGoalFamily(typeMismatch);
      throw new Error("Expected event type mismatch rejection.");
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_binding_return_event_type_mismatch");
    }
  });

  it("rejects family replay when a completed return event omits a required contract fact", () => {
    const setup = createFamilyWithChild();
    const events: GoalFamilyEvent[] = [
      ...setup.familyEvents,
      {
        eventId: "forged-replay-required",
        familyId: setup.family.familyId,
        sequence: setup.family.schedulerOrdinal + 1,
        type: "hypagraph.family.child-return-recorded",
        version: GOAL_FAMILY_EVENT_VERSION,
        timestamp: returnAt,
        causationId: "forged",
        correlationId: "forged",
        data: {
          bindingId: setup.bindingId,
          childGoalId: "goal-child",
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: setup.parentNodeId,
          parentAttemptId: "attempt-work",
          outcome: "completed",
          parentEffect: "resumed",
          returnRecord: {
            outcome: "completed",
            parentEffect: "resumed",
            returnedAt: returnAt,
            publishedFacts: [
              { name: "child.note", type: "string", value: "optional only", evidence: [] },
            ],
          },
        },
      },
    ];
    try {
      replayFamilyEvents(events);
      throw new Error("Expected required fact rejection on replay.");
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("child_return_required_fact_missing");
    }
  });

  it("rejects invalid top-level evidence on the command path", () => {
    const setup = createFamilyWithChild();
    const result = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalChildState(setup.childState, "completed"),
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
      evidence: [{ ref: "" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid evidence rejection.");
    expect(result.diagnostics[0]?.code).toBe("invalid_child_return_evidence");
  });

  it("restores a family after the parent advances past resume after a successful child return", () => {
    const rootCreated = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!rootCreated.ok) throw new Error(JSON.stringify(rootCreated.diagnostics));
    const started = handleCommand(rootCreated.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "attempt-work",
      commandId: "start-work",
      correlationId: "start-work",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const oneMember = buildOneMemberPersistedFamily({
      familyId: "family-s5-post-return-progress",
      rootGoalId: "goal-root",
      workflow: {
        events: [...rootCreated.events, ...started.events],
        snapshot: started.state,
      },
      at,
    });
    const creation = createBoundedChildGoal({
      family: oneMember.familySnapshot,
      parentState: oneMember.workflows["workflow-root"]!.snapshot,
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-child-1",
      at: later,
      scopePaths: ["src/**"],
      outputFacts,
    });
    if (!creation.ok) throw new Error(JSON.stringify(creation.diagnostics));
    const withChild = commitBoundedChildGoalToPersistedFamily(oneMember, creation);

    const returned = returnChildGoal({
      family: withChild.familySnapshot,
      parentState: withChild.workflows["workflow-root"]!.snapshot,
      childState: terminalChildState(creation.childState, "completed"),
      bindingId: "binding-child-1",
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
    });
    if (!returned.ok) throw new Error(JSON.stringify(returned.diagnostics));
    const withReturn = commitChildReturnToPersistedFamily(withChild, returned);
    expect(withReturn.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status).toBe("running");

    // Parent continues integration after resume: submit, verify, succeed.
    const parentAfterReturn = withReturn.workflows["workflow-root"]!;
    const submitted = handleCommand(parentAfterReturn.snapshot, {
      type: "submit-result",
      nodeId: "work",
      attemptId: "attempt-work",
      evidence: [{ ref: "evidence://parent-integration", kind: "note" }],
      commandId: "submit-work",
      correlationId: "submit-work",
      at: "2026-07-29T19:15:00.000Z",
    });
    if (!submitted.ok) throw new Error(JSON.stringify(submitted.diagnostics));
    const verifying = handleCommand(submitted.state, {
      type: "begin-verification",
      nodeId: "work",
      attemptId: "attempt-work",
      commandId: "begin-verify-work",
      correlationId: "begin-verify-work",
      at: "2026-07-29T19:16:00.000Z",
    });
    if (!verifying.ok) throw new Error(JSON.stringify(verifying.diagnostics));
    const succeeded = handleCommand(verifying.state, {
      type: "complete-verification",
      nodeId: "work",
      attemptId: "attempt-work",
      passed: true,
      commandId: "complete-verify-work",
      correlationId: "complete-verify-work",
      at: "2026-07-29T19:17:00.000Z",
    });
    if (!succeeded.ok) throw new Error(JSON.stringify(succeeded.diagnostics));
    expect(succeeded.state.runtime.nodes.work?.status).toBe("succeeded");

    const advanced: PersistedGoalFamily = {
      ...withReturn,
      workflows: {
        ...withReturn.workflows,
        "workflow-root": {
          events: [
            ...parentAfterReturn.events,
            ...submitted.events,
            ...verifying.events,
            ...succeeded.events,
          ],
          snapshot: succeeded.state,
        },
      },
    };

    const restored = restorePersistedGoalFamily(advanced);
    expect(restored.familySnapshot.bindings["binding-child-1"]?.status).toBe("returned");
    expect(restored.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status).toBe("succeeded");
    expect(restored.familySnapshot.bindings["binding-child-1"]?.returnRecord?.parentEffect).toBe("resumed");
  });

  it("commits and restores a second child wait on the same parent node after a successful return", () => {
    const rootCreated = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!rootCreated.ok) throw new Error(JSON.stringify(rootCreated.diagnostics));
    const started = handleCommand(rootCreated.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "attempt-work",
      commandId: "start-work",
      correlationId: "start-work",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const oneMember = buildOneMemberPersistedFamily({
      familyId: "family-s5-second-child",
      rootGoalId: "goal-root",
      workflow: {
        events: [...rootCreated.events, ...started.events],
        snapshot: started.state,
      },
      at,
    });
    const firstCreation = createBoundedChildGoal({
      family: oneMember.familySnapshot,
      parentState: oneMember.workflows["workflow-root"]!.snapshot,
      parentNodeId: "work",
      childDefinition: singleTask("Child one", ["src/**"]),
      childGoalId: "goal-child-1",
      childWorkflowId: "workflow-child-1",
      bindingId: "binding-child-1",
      at: later,
      scopePaths: ["src/**"],
      outputFacts,
    });
    if (!firstCreation.ok) throw new Error(JSON.stringify(firstCreation.diagnostics));
    const withFirst = commitBoundedChildGoalToPersistedFamily(oneMember, firstCreation);

    const firstReturn = returnChildGoal({
      family: withFirst.familySnapshot,
      parentState: withFirst.workflows["workflow-root"]!.snapshot,
      childState: terminalChildState(firstCreation.childState, "completed"),
      bindingId: "binding-child-1",
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
    });
    if (!firstReturn.ok) throw new Error(JSON.stringify(firstReturn.diagnostics));
    const afterReturn = commitChildReturnToPersistedFamily(withFirst, firstReturn);
    expect(afterReturn.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status).toBe("running");
    expect(afterReturn.familySnapshot.bindings["binding-child-1"]?.status).toBe("returned");

    // Same parent node, same attempt, creates a second child and waits again.
    const secondCreation = createBoundedChildGoal({
      family: afterReturn.familySnapshot,
      parentState: afterReturn.workflows["workflow-root"]!.snapshot,
      parentNodeId: "work",
      childDefinition: singleTask("Child two", ["src/**"]),
      childGoalId: "goal-child-2",
      childWorkflowId: "workflow-child-2",
      bindingId: "binding-child-2",
      at: "2026-07-29T19:20:00.000Z",
      scopePaths: ["src/**"],
    });
    expect(secondCreation.ok).toBe(true);
    if (!secondCreation.ok) throw new Error(JSON.stringify(secondCreation.diagnostics));
    expect(secondCreation.parentState.runtime.nodes.work?.status).toBe("waiting_for_child");

    const withSecond = commitBoundedChildGoalToPersistedFamily(afterReturn, secondCreation);
    expect(withSecond.familySnapshot.bindings["binding-child-1"]?.status).toBe("returned");
    expect(withSecond.familySnapshot.bindings["binding-child-2"]?.status).toBe("active");
    expect(withSecond.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status).toBe(
      "waiting_for_child",
    );

    const restored = restorePersistedGoalFamily(withSecond);
    expect(restored.familySnapshot.bindings["binding-child-1"]?.status).toBe("returned");
    expect(restored.familySnapshot.bindings["binding-child-2"]?.status).toBe("active");
    expect(restored.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status).toBe(
      "waiting_for_child",
    );
    expect(restored.workflows["workflow-child-1"]?.snapshot.goal?.goalId).toBe("goal-child-1");
    expect(restored.workflows["workflow-child-2"]?.snapshot.goal?.goalId).toBe("goal-child-2");
  });

  it("rejects return when the child goal is still active", () => {
    const setup = createFamilyWithChild();
    const result = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: setup.childState,
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected active-child rejection.");
    expect(result.diagnostics[0]?.code).toBe("child_return_child_not_terminal");
    expect(setup.family.bindings[setup.bindingId]?.status).toBe("active");
  });

  it("rejects return when child status does not match the reported outcome", () => {
    const setup = createFamilyWithChild();
    const cancelledChild = terminalChildState(setup.childState, "cancelled");
    const result = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: cancelledChild,
      bindingId: setup.bindingId,
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected outcome-status mismatch rejection.");
    expect(result.diagnostics[0]?.code).toBe("child_return_outcome_status_mismatch");
  });

  it("product path rejects return while the persisted child workflow is still active", () => {
    let rootState = createStartedWorkflow(singleTask("Root", ["src/**"]), "workflow-root", "goal-root");
    rootState = startTask(rootState, "work");
    const rootCreated = createHypagoalWorkflow(singleTask("Root", ["src/**"]), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!rootCreated.ok) throw new Error(JSON.stringify(rootCreated.diagnostics));
    const started = handleCommand(rootCreated.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "attempt-work",
      commandId: "start-work",
      correlationId: "start-work",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const oneMember = buildOneMemberPersistedFamily({
      familyId: "family-s5-active-child",
      rootGoalId: "goal-root",
      workflow: {
        events: [...rootCreated.events, ...started.events],
        snapshot: started.state,
      },
      at,
    });
    const creation = createBoundedChildGoal({
      family: oneMember.familySnapshot,
      parentState: oneMember.workflows["workflow-root"]!.snapshot,
      parentNodeId: "work",
      childDefinition: singleTask("Child", ["src/**"]),
      childGoalId: "goal-child",
      childWorkflowId: "workflow-child",
      bindingId: "binding-child-1",
      at: later,
      scopePaths: ["src/**"],
      outputFacts,
    });
    if (!creation.ok) throw new Error(JSON.stringify(creation.diagnostics));
    const withChild = commitBoundedChildGoalToPersistedFamily(oneMember, creation);
    const productReturn = returnChildGoalInFamily({
      family: withChild,
      parentGoalId: "goal-root",
      bindingId: "binding-child-1",
      at: returnAt,
      outcome: "completed",
      facts: completedFacts(),
    });
    expect(productReturn.ok).toBe(false);
    if (productReturn.ok) throw new Error("Expected active child rejection on product path.");
    expect(productReturn.diagnostics[0]?.code).toBe("child_return_child_not_terminal");
    expect(withChild.familySnapshot.bindings["binding-child-1"]?.status).toBe("active");
    expect(withChild.workflows["workflow-child"]?.snapshot.goal?.status).toBe("active");
  });

});
