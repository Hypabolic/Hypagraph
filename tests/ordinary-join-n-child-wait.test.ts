/**
 * J2 ordinary join: multi-child wait set and parent continue/fail.
 *
 * Proves:
 * - parent may create siblings while waiting_for_child;
 * - intermediate completed returns keep parent waiting while siblings are active;
 * - auto join does not apply early for N=3 without expectedBindingCount;
 * - create-return-create while a sibling is active never joins early;
 * - all-success pass leaves parent running with host-default join.passed;
 * - non-completed return applies failure policy, terminalises siblings, quiet-skips synthesis;
 * - two-child wait set still joins after both terminal;
 * - expectedBindingCount still works for advanced callers;
 * - multi-wait and mixed-failure states commit and restore on the family store.
 *
 * Create tally is not required for J2: create and return commits are single-threaded
 * on one parent wait set, so natural wait-set safety is sufficient.
 *
 * Does not claim ledger Ordinary or Live. Domain and host substitute only.
 */

import { describe, expect, it } from "vitest";
import { createBoundedChildGoal } from "../src/domain/child-goal-creation.js";
import {
  SIBLING_CANCELLED_BY_PARENT_FAILURE_REASON,
  listActiveBindingsForParentNode,
  returnChildGoal,
} from "../src/domain/child-goal-return.js";
import {
  DEFAULT_JOIN_RESULT_FACT_NAME,
  createAllSuccessJoinPolicy,
  isJoinSetTerminal,
  listBindingsForParentJoin,
} from "../src/domain/child-outcome-synthesis.js";
import {
  GOAL_FAMILY_SCHEMA_VERSION,
  createRootFamily,
  type ChildGoalFailurePolicy,
  type GoalFamilyRuntime,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { handleCommand } from "../src/domain/reducer.js";
import {
  applyProductJoinSynthesis,
  applyReadyJoinSynthesesAfterReturns,
  isAutoProductJoinEligible,
} from "../src/pi/family-product-synthesis.js";
import {
  buildOneMemberPersistedFamily,
  commitBoundedChildGoalToPersistedFamily,
  commitChildReturnToPersistedFamily,
  restorePersistedGoalFamily,
  type PersistedGoalFamily,
} from "../src/persistence/family-store.js";

const at = "2026-08-05T15:00:00.000Z";
const later = "2026-08-05T15:05:00.000Z";
const returnAt = "2026-08-05T15:10:00.000Z";
const joinAt = "2026-08-05T15:15:00.000Z";

/** Ordinary parent: no author produce for join.passed. */
const ordinaryParent = (title: string): HypagraphDefinition => ({
  title,
  goal: title,
  nodes: [{
    id: "work",
    title: "Work",
    requires: [],
    acceptance: [],
    scope: { paths: ["src/**"] },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const childTask = (title: string): HypagraphDefinition => ({
  title,
  goal: title,
  nodes: [{
    id: "work",
    title: "Work",
    requires: [],
    acceptance: [],
    scope: { paths: ["src/**"] },
  }],
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

const terminalCompletedChild = (state: HypagraphState): HypagraphState => {
  const nodeId = state.definition.nodes[0]?.id ?? "work";
  const attemptId = `attempt-${nodeId}-terminal`;
  let next = state;
  const apply = (command: Parameters<typeof handleCommand>[1]): void => {
    const result = handleCommand(next, command);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    next = result.state;
  };
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
  if (next.goal?.status !== "completed") {
    throw new Error(`Expected completed child goal, got '${next.goal?.status}'.`);
  }
  return next;
};

const terminalFailedChild = (state: HypagraphState): HypagraphState => {
  const clone = structuredClone(state);
  if (!clone.goal) throw new Error("Child goal missing.");
  clone.goal = {
    ...clone.goal,
    status: "failed",
    stopReason: "Child failed for ordinary join wait-set test.",
  };
  clone.phase = "failed";
  return clone;
};

const familyBounds = {
  maxDepth: 3,
  maxChildrenPerGoal: 4,
  maxGoalsInFamily: 16,
  maxChildCreationAttemptsPerNode: 4,
} as const;

/**
 * Create N children while the parent stays waiting_for_child (multi-child wait set).
 * Does not return any child.
 */
const createNChildrenWhileWaiting = (input: {
  familyId: string;
  count: number;
  failurePolicy?: "fail-parent-node" | "block-parent-node" | "return-for-revision";
}): {
  family: GoalFamilyRuntime;
  parentState: HypagraphState;
  childStates: HypagraphState[];
  bindingIds: string[];
} => {
  let rootState = createStartedWorkflow(
    ordinaryParent(`Wait-set parent ${input.familyId}`),
    "workflow-root",
    "goal-root",
  );
  rootState = startTask(rootState, "work");
  const familyResult = createRootFamily({
    familyId: input.familyId,
    rootGoalId: "goal-root",
    rootWorkflowId: "workflow-root",
    at,
    bounds: familyBounds,
  });
  if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

  let family = familyResult.family;
  let parentState = rootState;
  const childStates: HypagraphState[] = [];
  const bindingIds: string[] = [];

  for (let index = 1; index <= input.count; index += 1) {
    const bindingId = `binding-${index}`;
    const child = createBoundedChildGoal({
      family,
      parentState,
      parentNodeId: "work",
      childDefinition: childTask(`Child ${index}`),
      childGoalId: `goal-child-${index}`,
      childWorkflowId: `workflow-child-${index}`,
      bindingId,
      at: index === 1 ? later : returnAt,
      scopePaths: ["src/**"],
      failurePolicy: input.failurePolicy ?? "block-parent-node",
    });
    if (!child.ok) throw new Error(JSON.stringify(child.diagnostics));
    family = child.family;
    parentState = child.parentState;
    childStates.push(child.childState);
    bindingIds.push(bindingId);
    expect(parentState.runtime.nodes.work?.status).toBe("waiting_for_child");
  }

  // Parent definition must not declare join.passed produce (J1 holds).
  const workNode = parentState.definition.nodes.find((node) => node.id === "work");
  expect(
    (workNode?.produces ?? []).some(
      (contract) => contract.name === DEFAULT_JOIN_RESULT_FACT_NAME,
    ),
  ).toBe(false);

  return { family, parentState, childStates, bindingIds };
};

describe("J2 ordinary join multi-child wait set", () => {
  it("keeps parent waiting and does not join after two of three completed returns", () => {
    const setup = createNChildrenWhileWaiting({
      familyId: "family-j2-n3",
      count: 3,
    });

    expect(listBindingsForParentJoin({
      family: setup.family,
      parentGoalId: "goal-root",
      parentNodeId: "work",
    })).toEqual(["binding-1", "binding-2", "binding-3"]);

    expect(listActiveBindingsForParentNode({
      family: setup.family,
      parentGoalId: "goal-root",
      parentNodeId: "work",
    }).map((binding) => binding.bindingId)).toEqual([
      "binding-1",
      "binding-2",
      "binding-3",
    ]);

    let family = setup.family;
    let parentState = setup.parentState;

    for (const index of [1, 2] as const) {
      const returned = returnChildGoal({
        family,
        parentState,
        childState: terminalCompletedChild(setup.childStates[index - 1]!),
        bindingId: `binding-${index}`,
        at: joinAt,
        outcome: "completed",
      });
      if (!returned.ok) throw new Error(JSON.stringify(returned.diagnostics));
      family = returned.family;
      parentState = returned.parentState;
      expect(parentState.runtime.nodes.work?.status).toBe("waiting_for_child");
      expect(listActiveBindingsForParentNode({
        family,
        parentGoalId: "goal-root",
        parentNodeId: "work",
      }).map((binding) => binding.bindingId)).toEqual(
        index === 1 ? ["binding-2", "binding-3"] : ["binding-3"],
      );

      const ready = applyReadyJoinSynthesesAfterReturns({
        family,
        parentState,
        parentGoalId: "goal-root",
        at: joinAt,
      });
      expect(ready.ok).toBe(true);
      expect(ready.applied).toHaveLength(0);
      expect(ready.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]).toBeUndefined();
    }

    // Third return clears the wait set; parent becomes running; join applies once.
    const third = returnChildGoal({
      family,
      parentState,
      childState: terminalCompletedChild(setup.childStates[2]!),
      bindingId: "binding-3",
      at: joinAt,
      outcome: "completed",
    });
    if (!third.ok) throw new Error(JSON.stringify(third.diagnostics));
    expect(third.parentState.runtime.nodes.work?.status).toBe("running");
    expect(listActiveBindingsForParentNode({
      family: third.family,
      parentGoalId: "goal-root",
      parentNodeId: "work",
    })).toHaveLength(0);

    const afterThree = applyReadyJoinSynthesesAfterReturns({
      family: third.family,
      parentState: third.parentState,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(afterThree.ok).toBe(true);
    expect(afterThree.applied).toHaveLength(1);
    expect(afterThree.applied[0]?.result.status).toBe("passed");
    expect(afterThree.applied[0]?.factPublished).toBe(true);
    expect(afterThree.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(true);
    expect(afterThree.parentState.runtime.nodes.work?.status).toBe("running");
    expect(afterThree.applied[0]?.policy.expectedBindingCount).toBeUndefined();
    expect(afterThree.applied[0]?.policy.resultFactName).toBe(DEFAULT_JOIN_RESULT_FACT_NAME);

    // No author produce for join.passed.
    const workNode = afterThree.parentState.definition.nodes.find((node) => node.id === "work");
    expect(
      (workNode?.produces ?? []).some(
        (contract) => contract.name === DEFAULT_JOIN_RESULT_FACT_NAME,
      ),
    ).toBe(false);

    // Second ready pass is quiet (idempotent).
    const again = applyReadyJoinSynthesesAfterReturns({
      family: third.family,
      parentState: afterThree.parentState,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(again.ok).toBe(true);
    expect(again.applied).toHaveLength(0);
  });

  it("joins two-child concurrent-style wait after both terminal without expectedBindingCount", () => {
    const setup = createNChildrenWhileWaiting({
      familyId: "family-j2-n2",
      count: 2,
    });

    let family = setup.family;
    let parentState = setup.parentState;

    const first = returnChildGoal({
      family,
      parentState,
      childState: terminalCompletedChild(setup.childStates[0]!),
      bindingId: "binding-1",
      at: returnAt,
      outcome: "completed",
    });
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
    family = first.family;
    parentState = first.parentState;
    expect(parentState.runtime.nodes.work?.status).toBe("waiting_for_child");

    const afterFirst = applyReadyJoinSynthesesAfterReturns({
      family,
      parentState,
      parentGoalId: "goal-root",
      at: returnAt,
    });
    expect(afterFirst.ok).toBe(true);
    expect(afterFirst.applied).toHaveLength(0);

    const second = returnChildGoal({
      family,
      parentState,
      childState: terminalCompletedChild(setup.childStates[1]!),
      bindingId: "binding-2",
      at: joinAt,
      outcome: "completed",
    });
    if (!second.ok) throw new Error(JSON.stringify(second.diagnostics));
    expect(second.parentState.runtime.nodes.work?.status).toBe("running");

    const applied = applyProductJoinSynthesis({
      family: second.family,
      parentState: second.parentState,
      parentGoalId: "goal-root",
      parentNodeId: "work",
      parentAttemptId: second.parentState.runtime.nodes.work!.currentAttemptId!,
      at: joinAt,
      commandId: "j2-two-child-pass",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok || applied.status !== "applied") {
      throw new Error(JSON.stringify(applied));
    }
    expect(applied.result.status).toBe("passed");
    expect(applied.factPublished).toBe(true);
    expect(applied.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(true);
    expect(applied.parentState.runtime.nodes.work?.status).toBe("running");
    expect(applied.policy.expectedBindingCount).toBeUndefined();
  });

  it("does not join early on create-return-create while a sibling remains active", () => {
    // Acceptance: sequential create-return-create that leaves an active sibling
    // never joins early. No produce and no expectedBindingCount.
    let rootState = createStartedWorkflow(
      ordinaryParent("Create return create"),
      "workflow-root",
      "goal-root",
    );
    rootState = startTask(rootState, "work");
    const familyResult = createRootFamily({
      familyId: "family-j2-crc",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
      bounds: familyBounds,
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

    const child1 = createBoundedChildGoal({
      family: familyResult.family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: childTask("Child one"),
      childGoalId: "goal-child-1",
      childWorkflowId: "workflow-child-1",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
      failurePolicy: "block-parent-node",
    });
    if (!child1.ok) throw new Error(JSON.stringify(child1.diagnostics));

    const child2 = createBoundedChildGoal({
      family: child1.family,
      parentState: child1.parentState,
      parentNodeId: "work",
      childDefinition: childTask("Child two"),
      childGoalId: "goal-child-2",
      childWorkflowId: "workflow-child-2",
      bindingId: "binding-2",
      at: returnAt,
      scopePaths: ["src/**"],
      failurePolicy: "block-parent-node",
    });
    if (!child2.ok) throw new Error(JSON.stringify(child2.diagnostics));
    expect(child2.parentState.runtime.nodes.work?.status).toBe("waiting_for_child");

    // Return first child while second remains active.
    const return1 = returnChildGoal({
      family: child2.family,
      parentState: child2.parentState,
      childState: terminalCompletedChild(child1.childState),
      bindingId: "binding-1",
      at: returnAt,
      outcome: "completed",
    });
    if (!return1.ok) throw new Error(JSON.stringify(return1.diagnostics));
    expect(return1.parentState.runtime.nodes.work?.status).toBe("waiting_for_child");

    // Create third while sibling two is still active.
    const child3 = createBoundedChildGoal({
      family: return1.family,
      parentState: return1.parentState,
      parentNodeId: "work",
      childDefinition: childTask("Child three"),
      childGoalId: "goal-child-3",
      childWorkflowId: "workflow-child-3",
      bindingId: "binding-3",
      at: joinAt,
      scopePaths: ["src/**"],
      failurePolicy: "block-parent-node",
    });
    if (!child3.ok) throw new Error(JSON.stringify(child3.diagnostics));
    expect(child3.parentState.runtime.nodes.work?.status).toBe("waiting_for_child");

    const midReady = applyReadyJoinSynthesesAfterReturns({
      family: child3.family,
      parentState: child3.parentState,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(midReady.ok).toBe(true);
    expect(midReady.applied).toHaveLength(0);
    expect(midReady.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]).toBeUndefined();

    const return2 = returnChildGoal({
      family: child3.family,
      parentState: child3.parentState,
      childState: terminalCompletedChild(child2.childState),
      bindingId: "binding-2",
      at: joinAt,
      outcome: "completed",
    });
    if (!return2.ok) throw new Error(JSON.stringify(return2.diagnostics));
    expect(return2.parentState.runtime.nodes.work?.status).toBe("waiting_for_child");

    const afterTwo = applyReadyJoinSynthesesAfterReturns({
      family: return2.family,
      parentState: return2.parentState,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(afterTwo.ok).toBe(true);
    expect(afterTwo.applied).toHaveLength(0);

    const return3 = returnChildGoal({
      family: return2.family,
      parentState: return2.parentState,
      childState: terminalCompletedChild(child3.childState),
      bindingId: "binding-3",
      at: joinAt,
      outcome: "completed",
    });
    if (!return3.ok) throw new Error(JSON.stringify(return3.diagnostics));
    expect(return3.parentState.runtime.nodes.work?.status).toBe("running");

    const finalReady = applyReadyJoinSynthesesAfterReturns({
      family: return3.family,
      parentState: return3.parentState,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(finalReady.ok).toBe(true);
    expect(finalReady.applied).toHaveLength(1);
    expect(finalReady.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(true);
    expect(finalReady.parentState.runtime.nodes.work?.status).toBe("running");
  });

  it("quiet-skips synthesis when a non-completed return blocks the parent via failure policy", () => {
    // Plan §7.2: first non-completed return applies failure policy even when
    // sibling bindings remain active. Siblings are terminalised (cancelled).
    // Synthesis does not re-own the parent.
    const setup = createNChildrenWhileWaiting({
      familyId: "family-j2-fail-policy",
      count: 3,
      failurePolicy: "block-parent-node",
    });

    const first = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalCompletedChild(setup.childStates[0]!),
      bindingId: "binding-1",
      at: returnAt,
      outcome: "completed",
    });
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
    expect(first.parentState.runtime.nodes.work?.status).toBe("waiting_for_child");

    const failed = returnChildGoal({
      family: first.family,
      parentState: first.parentState,
      childState: terminalFailedChild(setup.childStates[1]!),
      bindingId: "binding-2",
      at: joinAt,
      outcome: "failed",
    });
    if (!failed.ok) throw new Error(JSON.stringify(failed.diagnostics));
    expect(failed.parentState.runtime.nodes.work?.status).toBe("blocked");

    // Remaining siblings are cancelled; join set is fully terminal.
    expect(listActiveBindingsForParentNode({
      family: failed.family,
      parentGoalId: "goal-root",
      parentNodeId: "work",
    })).toHaveLength(0);
    expect(failed.family.bindings["binding-3"]?.status).toBe("cancelled");
    expect(failed.family.bindings["binding-3"]?.returnRecord?.stopReason)
      .toBe(SIBLING_CANCELLED_BY_PARENT_FAILURE_REASON);
    expect(isJoinSetTerminal(failed.family, ["binding-1", "binding-2", "binding-3"])).toBe(true);

    const ready = applyReadyJoinSynthesesAfterReturns({
      family: failed.family,
      parentState: failed.parentState,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(ready.ok).toBe(true);
    expect(ready.applied).toHaveLength(0);
    expect(ready.diagnostics).toHaveLength(0);
    expect(ready.pending).toHaveLength(0);
    expect(ready.skipped.some((item) => item.parentNodeId === "work")).toBe(true);
    expect(ready.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]).toBeUndefined();
    expect(ready.parentState.runtime.nodes.work?.status).toBe("blocked");

    const again = applyReadyJoinSynthesesAfterReturns({
      family: failed.family,
      parentState: failed.parentState,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(again.ok).toBe(true);
    expect(again.applied).toHaveLength(0);
    expect(again.diagnostics).toHaveLength(0);
    expect(again.skipped.some((item) => item.parentNodeId === "work")).toBe(true);
  });

  it("fail-parent-node failure policy owns the parent and terminalises remaining siblings", () => {
    const setup = createNChildrenWhileWaiting({
      familyId: "family-j2-fail-node",
      count: 2,
      failurePolicy: "fail-parent-node",
    });

    const failed = returnChildGoal({
      family: setup.family,
      parentState: setup.parentState,
      childState: terminalFailedChild(setup.childStates[0]!),
      bindingId: "binding-1",
      at: joinAt,
      outcome: "failed",
    });
    if (!failed.ok) throw new Error(JSON.stringify(failed.diagnostics));
    expect(failed.parentState.runtime.nodes.work?.status).toBe("failed");
    expect(failed.family.bindings["binding-1"]?.status).toBe("failed");
    expect(failed.family.bindings["binding-2"]?.status).toBe("cancelled");
    expect(listActiveBindingsForParentNode({
      family: failed.family,
      parentGoalId: "goal-root",
      parentNodeId: "work",
    })).toHaveLength(0);

    const ready = applyReadyJoinSynthesesAfterReturns({
      family: failed.family,
      parentState: failed.parentState,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(ready.ok).toBe(true);
    expect(ready.applied).toHaveLength(0);
    expect(ready.pending).toHaveLength(0);
    expect(ready.diagnostics).toHaveLength(0);
    expect(ready.skipped.some((item) => item.parentNodeId === "work")).toBe(true);
    expect(ready.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]).toBeUndefined();
    expect(ready.parentState.runtime.nodes.work?.status).toBe("failed");
  });

  it("publishes join.passed false and blocks when all-success join fails while parent is running", () => {
    // Real non-completed returns apply failure policy first. Force a failed join
    // evaluation on a running parent after three completed returns so the product
    // fail path (fact + block) is covered without author produce.
    const setup = createNChildrenWhileWaiting({
      familyId: "family-j2-join-fail",
      count: 3,
    });

    let family = setup.family;
    let parentState = setup.parentState;
    for (const index of [1, 2, 3] as const) {
      const returned = returnChildGoal({
        family,
        parentState,
        childState: terminalCompletedChild(setup.childStates[index - 1]!),
        bindingId: `binding-${index}`,
        at: joinAt,
        outcome: "completed",
      });
      if (!returned.ok) throw new Error(JSON.stringify(returned.diagnostics));
      family = returned.family;
      parentState = returned.parentState;
    }
    expect(parentState.runtime.nodes.work?.status).toBe("running");

    const patched = structuredClone(family);
    const binding3 = patched.bindings["binding-3"];
    if (!binding3?.returnRecord) throw new Error("expected binding-3 return record");
    patched.bindings["binding-3"] = {
      ...binding3,
      status: "failed",
      returnRecord: {
        ...binding3.returnRecord,
        outcome: "failed",
        parentEffect: "blocked",
        stopReason: "Forced failed outcome for ordinary join fail path.",
      },
    };

    const attemptId = parentState.runtime.nodes.work?.currentAttemptId;
    expect(attemptId).toBeTruthy();

    const applied = applyProductJoinSynthesis({
      family: patched,
      parentState,
      parentGoalId: "goal-root",
      parentNodeId: "work",
      parentAttemptId: attemptId!,
      at: joinAt,
      commandId: "j2-join-fail",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok || applied.status !== "applied") {
      throw new Error(JSON.stringify(applied));
    }
    expect(applied.result.status).toBe("failed");
    expect(applied.factPublished).toBe(true);
    expect(applied.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(false);
    expect(applied.parentState.runtime.nodes.work?.status).toBe("blocked");
    expect(applied.policy.expectedBindingCount).toBeUndefined();
  });

  it("honours expectedBindingCount for advanced callers", () => {
    const setup = createNChildrenWhileWaiting({
      familyId: "family-j2-expected",
      count: 3,
    });

    let family = setup.family;
    let parentState = setup.parentState;
    for (const index of [1, 2] as const) {
      const returned = returnChildGoal({
        family,
        parentState,
        childState: terminalCompletedChild(setup.childStates[index - 1]!),
        bindingId: `binding-${index}`,
        at: joinAt,
        outcome: "completed",
      });
      if (!returned.ok) throw new Error(JSON.stringify(returned.diagnostics));
      family = returned.family;
      parentState = returned.parentState;
    }

    // Advanced path: hand expectedBindingCount keeps eligibility pending until count is met.
    // Wait-set already prevents early join; expectedBindingCount remains available as a
    // second gate when a policy includes it (auto path, host-default fact ok).
    const twoIdPolicy = createAllSuccessJoinPolicy({
      bindingIds: ["binding-1", "binding-2"],
      expectedBindingCount: 3,
    });
    if (!twoIdPolicy.ok) throw new Error(JSON.stringify(twoIdPolicy.diagnostics));
    const attemptId = parentState.runtime.nodes.work?.currentAttemptId;
    expect(attemptId).toBeTruthy();
    const pendingEligibility = isAutoProductJoinEligible({
      policy: twoIdPolicy.policy,
      explicit: false,
      parentState,
      parentNodeId: "work",
      parentAttemptId: attemptId!,
    });
    expect(pendingEligibility.eligible).toBe(false);
    if (pendingEligibility.eligible) throw new Error("expected ineligible");
    expect(pendingEligibility.pending).toBe(true);

    // After third return, policy with expectedBindingCount 3 becomes eligible.
    const third = returnChildGoal({
      family,
      parentState,
      childState: terminalCompletedChild(setup.childStates[2]!),
      bindingId: "binding-3",
      at: joinAt,
      outcome: "completed",
    });
    if (!third.ok) throw new Error(JSON.stringify(third.diagnostics));

    const fullPolicy = createAllSuccessJoinPolicy({
      bindingIds: ["binding-1", "binding-2", "binding-3"],
      expectedBindingCount: 3,
    });
    if (!fullPolicy.ok) throw new Error(JSON.stringify(fullPolicy.diagnostics));
    const fullAttemptId = third.parentState.runtime.nodes.work?.currentAttemptId;
    expect(fullAttemptId).toBeTruthy();
    const readyEligibility = isAutoProductJoinEligible({
      policy: fullPolicy.policy,
      explicit: false,
      parentState: third.parentState,
      parentNodeId: "work",
      parentAttemptId: fullAttemptId!,
    });
    expect(readyEligibility.eligible).toBe(true);

    // Product ready path (no hand policy) applies the wait-set join once.
    const applied = applyReadyJoinSynthesesAfterReturns({
      family: third.family,
      parentState: third.parentState,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(applied.ok).toBe(true);
    expect(applied.applied).toHaveLength(1);
    expect(applied.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(true);
    expect(applied.applied[0]?.policy.expectedBindingCount).toBeUndefined();
  });

  it("uses goal family schema version on multi-wait family state", () => {
    const setup = createNChildrenWhileWaiting({
      familyId: "family-j2-schema",
      count: 2,
    });
    expect(setup.family.schemaVersion).toBe(GOAL_FAMILY_SCHEMA_VERSION);
  });
});

describe("J2 multi-child wait set persistence", () => {
  const buildRunningPersisted = (familyId: string): PersistedGoalFamily => {
    const created = createHypagoalWorkflow(ordinaryParent(`Persist ${familyId}`), {
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
    return buildOneMemberPersistedFamily({
      familyId,
      rootGoalId: "goal-root",
      workflow: {
        events: [...created.events, ...started.events],
        snapshot: started.state,
      },
      at,
      bounds: familyBounds,
    });
  };

  const commitCreate = (
    family: PersistedGoalFamily,
    index: number,
    failurePolicy: ChildGoalFailurePolicy = "block-parent-node",
  ): {
    family: PersistedGoalFamily;
    childState: HypagraphState;
  } => {
    const creation = createBoundedChildGoal({
      family: family.familySnapshot,
      parentState: family.workflows["workflow-root"]!.snapshot,
      parentNodeId: "work",
      childDefinition: childTask(`Persist child ${index}`),
      childGoalId: `goal-child-${index}`,
      childWorkflowId: `workflow-child-${index}`,
      bindingId: `binding-${index}`,
      at: index === 1 ? later : returnAt,
      scopePaths: ["src/**"],
      failurePolicy,
    });
    if (!creation.ok) throw new Error(JSON.stringify(creation.diagnostics));
    return {
      family: commitBoundedChildGoalToPersistedFamily(family, creation),
      childState: creation.childState,
    };
  };

  it("commits and restores three creates while parent is waiting", () => {
    let persisted = buildRunningPersisted("family-j2-restore-creates");
    for (const index of [1, 2, 3] as const) {
      const created = commitCreate(persisted, index);
      persisted = created.family;
      expect(persisted.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status)
        .toBe("waiting_for_child");
    }
    const restored = restorePersistedGoalFamily(persisted);
    expect(Object.keys(restored.familySnapshot.bindings).sort()).toEqual([
      "binding-1",
      "binding-2",
      "binding-3",
    ]);
    expect(restored.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status)
      .toBe("waiting_for_child");
    expect(listActiveBindingsForParentNode({
      family: restored.familySnapshot,
      parentGoalId: "goal-root",
      parentNodeId: "work",
    })).toHaveLength(3);
  });

  it("commits and restores remain-waiting after one completed return with active siblings", () => {
    let persisted = buildRunningPersisted("family-j2-restore-remain");
    const c1 = commitCreate(persisted, 1);
    const c2 = commitCreate(c1.family, 2);
    const c3 = commitCreate(c2.family, 3);
    persisted = c3.family;

    const returned = returnChildGoal({
      family: persisted.familySnapshot,
      parentState: persisted.workflows["workflow-root"]!.snapshot,
      childState: terminalCompletedChild(c1.childState),
      bindingId: "binding-1",
      at: joinAt,
      outcome: "completed",
    });
    if (!returned.ok) throw new Error(JSON.stringify(returned.diagnostics));
    expect(returned.parentState.runtime.nodes.work?.status).toBe("waiting_for_child");

    const committed = commitChildReturnToPersistedFamily(persisted, returned);
    const restored = restorePersistedGoalFamily(committed);
    expect(restored.familySnapshot.bindings["binding-1"]?.status).toBe("returned");
    expect(restored.familySnapshot.bindings["binding-2"]?.status).toBe("active");
    expect(restored.familySnapshot.bindings["binding-3"]?.status).toBe("active");
    expect(restored.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status)
      .toBe("waiting_for_child");
  });

  it("commits and restores out-of-order return of the last-created child first", () => {
    // Issue 1: latest wait binding is terminal while parent still waits for older siblings.
    let persisted = buildRunningPersisted("family-j2-restore-ooo");
    const c1 = commitCreate(persisted, 1);
    const c2 = commitCreate(c1.family, 2);
    const c3 = commitCreate(c2.family, 3);
    persisted = c3.family;

    const returned = returnChildGoal({
      family: persisted.familySnapshot,
      parentState: persisted.workflows["workflow-root"]!.snapshot,
      childState: terminalCompletedChild(c3.childState),
      bindingId: "binding-3",
      at: joinAt,
      outcome: "completed",
    });
    if (!returned.ok) throw new Error(JSON.stringify(returned.diagnostics));
    expect(returned.parentState.runtime.nodes.work?.status).toBe("waiting_for_child");

    const committed = commitChildReturnToPersistedFamily(persisted, returned);
    const restored = restorePersistedGoalFamily(committed);
    expect(restored.familySnapshot.bindings["binding-3"]?.status).toBe("returned");
    expect(restored.familySnapshot.bindings["binding-1"]?.status).toBe("active");
    expect(restored.familySnapshot.bindings["binding-2"]?.status).toBe("active");
    expect(restored.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status)
      .toBe("waiting_for_child");
  });

  it("commits and restores all completed returns then join-ready running parent", () => {
    let persisted = buildRunningPersisted("family-j2-restore-all");
    const c1 = commitCreate(persisted, 1);
    const c2 = commitCreate(c1.family, 2);
    persisted = c2.family;

    const r1 = returnChildGoal({
      family: persisted.familySnapshot,
      parentState: persisted.workflows["workflow-root"]!.snapshot,
      childState: terminalCompletedChild(c1.childState),
      bindingId: "binding-1",
      at: returnAt,
      outcome: "completed",
    });
    if (!r1.ok) throw new Error(JSON.stringify(r1.diagnostics));
    persisted = commitChildReturnToPersistedFamily(persisted, r1);

    const r2 = returnChildGoal({
      family: persisted.familySnapshot,
      parentState: persisted.workflows["workflow-root"]!.snapshot,
      childState: terminalCompletedChild(c2.childState),
      bindingId: "binding-2",
      at: joinAt,
      outcome: "completed",
    });
    if (!r2.ok) throw new Error(JSON.stringify(r2.diagnostics));
    persisted = commitChildReturnToPersistedFamily(persisted, r2);

    const restored = restorePersistedGoalFamily(persisted);
    expect(restored.familySnapshot.bindings["binding-1"]?.status).toBe("returned");
    expect(restored.familySnapshot.bindings["binding-2"]?.status).toBe("returned");
    expect(restored.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status)
      .toBe("running");
    expect(listActiveBindingsForParentNode({
      family: restored.familySnapshot,
      parentGoalId: "goal-root",
      parentNodeId: "work",
    })).toHaveLength(0);
  });

  it("commits and restores non-completed return that terminalises remaining siblings", () => {
    let persisted = buildRunningPersisted("family-j2-restore-fail");
    const c1 = commitCreate(persisted, 1, "block-parent-node");
    const c2 = commitCreate(c1.family, 2, "block-parent-node");
    const c3 = commitCreate(c2.family, 3, "block-parent-node");
    persisted = c3.family;

    const failed = returnChildGoal({
      family: persisted.familySnapshot,
      parentState: persisted.workflows["workflow-root"]!.snapshot,
      childState: terminalFailedChild(c2.childState),
      bindingId: "binding-2",
      at: joinAt,
      outcome: "failed",
    });
    if (!failed.ok) throw new Error(JSON.stringify(failed.diagnostics));
    expect(failed.parentState.runtime.nodes.work?.status).toBe("blocked");
    expect(failed.family.bindings["binding-1"]?.status).toBe("cancelled");
    expect(failed.family.bindings["binding-3"]?.status).toBe("cancelled");

    const committed = commitChildReturnToPersistedFamily(persisted, failed);
    const restored = restorePersistedGoalFamily(committed);
    expect(restored.familySnapshot.bindings["binding-2"]?.status).toBe("failed");
    expect(restored.familySnapshot.bindings["binding-1"]?.status).toBe("cancelled");
    expect(restored.familySnapshot.bindings["binding-3"]?.status).toBe("cancelled");
    expect(restored.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status)
      .toBe("blocked");
    expect(listActiveBindingsForParentNode({
      family: restored.familySnapshot,
      parentGoalId: "goal-root",
      parentNodeId: "work",
    })).toHaveLength(0);

    const ready = applyReadyJoinSynthesesAfterReturns({
      family: restored.familySnapshot,
      parentState: restored.workflows["workflow-root"]!.snapshot,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(ready.ok).toBe(true);
    expect(ready.applied).toHaveLength(0);
    expect(ready.pending).toHaveLength(0);
    expect(ready.skipped.some((item) => item.parentNodeId === "work")).toBe(true);
    expect(ready.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]).toBeUndefined();
  });

  it("commits and restores second-wave wait after failure sibling cancel on a prior attempt", () => {
    // Historical family-only sibling cancels must still restore when the parent
    // later unblocks, starts a new attempt, and creates a child while waiting.
    let persisted = buildRunningPersisted("family-j2-restore-second-wave");
    const c1 = commitCreate(persisted, 1, "block-parent-node");
    const c2 = commitCreate(c1.family, 2, "block-parent-node");
    persisted = c2.family;

    const failed = returnChildGoal({
      family: persisted.familySnapshot,
      parentState: persisted.workflows["workflow-root"]!.snapshot,
      childState: terminalFailedChild(c1.childState),
      bindingId: "binding-1",
      at: joinAt,
      outcome: "failed",
    });
    if (!failed.ok) throw new Error(JSON.stringify(failed.diagnostics));
    expect(failed.parentState.runtime.nodes.work?.status).toBe("blocked");
    expect(failed.family.bindings["binding-2"]?.status).toBe("cancelled");
    expect(failed.family.bindings["binding-2"]?.returnRecord?.stopReason)
      .toBe(SIBLING_CANCELLED_BY_PARENT_FAILURE_REASON);

    persisted = commitChildReturnToPersistedFamily(persisted, failed);
    const firstAttemptId = failed.family.bindings["binding-1"]?.parentAttemptId;
    expect(firstAttemptId).toBeTruthy();
    expect(persisted.workflows["workflow-root"]?.snapshot.goal?.status).toBe("blocked");

    // Unblock the node (phase returns to running when work is ready), then resume the goal.
    const unblocked = handleCommand(persisted.workflows["workflow-root"]!.snapshot, {
      type: "unblock-node",
      nodeId: "work",
      commandId: "unblock-work-second-wave",
      correlationId: "unblock-work-second-wave",
      at: joinAt,
    });
    if (!unblocked.ok) throw new Error(JSON.stringify(unblocked.diagnostics));
    expect(unblocked.state.phase).toBe("running");

    const goalResumed = handleCommand(unblocked.state, {
      type: "resume-goal",
      commandId: "resume-goal-second-wave",
      correlationId: "resume-goal-second-wave",
      at: joinAt,
    });
    if (!goalResumed.ok) throw new Error(JSON.stringify(goalResumed.diagnostics));
    expect(goalResumed.state.goal?.status).toBe("active");

    const restarted = handleCommand(goalResumed.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "attempt-work-second",
      commandId: "start-work-second",
      correlationId: "start-work-second",
      at: joinAt,
    });
    if (!restarted.ok) throw new Error(JSON.stringify(restarted.diagnostics));
    expect(restarted.state.runtime.nodes.work?.status).toBe("running");
    expect(restarted.state.runtime.nodes.work?.currentAttemptId).toBe("attempt-work-second");

    const parentWorkflow = persisted.workflows["workflow-root"]!;
    const afterRestart: PersistedGoalFamily = {
      schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
      familyEvents: structuredClone(persisted.familyEvents),
      familySnapshot: structuredClone(persisted.familySnapshot),
      workflows: {
        ...structuredClone(persisted.workflows),
        "workflow-root": {
          events: [
            ...structuredClone(parentWorkflow.events),
            ...structuredClone(unblocked.events),
            ...structuredClone(goalResumed.events),
            ...structuredClone(restarted.events),
          ],
          snapshot: structuredClone(restarted.state),
        },
      },
    };
    // Historical cancelled sibling still present; parent not waiting yet.
    expect(() => restorePersistedGoalFamily(afterRestart)).not.toThrow();

    const secondWave = createBoundedChildGoal({
      family: afterRestart.familySnapshot,
      parentState: afterRestart.workflows["workflow-root"]!.snapshot,
      parentNodeId: "work",
      childDefinition: childTask("Second wave child"),
      childGoalId: "goal-child-3",
      childWorkflowId: "workflow-child-3",
      bindingId: "binding-3",
      at: joinAt,
      scopePaths: ["src/**"],
      failurePolicy: "block-parent-node",
    });
    if (!secondWave.ok) throw new Error(JSON.stringify(secondWave.diagnostics));
    expect(secondWave.parentState.runtime.nodes.work?.status).toBe("waiting_for_child");
    expect(secondWave.binding.parentAttemptId).toBe("attempt-work-second");
    expect(secondWave.binding.parentAttemptId).not.toBe(firstAttemptId);

    const withSecondWave = commitBoundedChildGoalToPersistedFamily(afterRestart, secondWave);
    // Parent is waiting again while historical sibling-cancels lack parent return events.
    const restored = restorePersistedGoalFamily(withSecondWave);
    expect(restored.familySnapshot.bindings["binding-1"]?.status).toBe("failed");
    expect(restored.familySnapshot.bindings["binding-2"]?.status).toBe("cancelled");
    expect(restored.familySnapshot.bindings["binding-2"]?.returnRecord?.stopReason)
      .toBe(SIBLING_CANCELLED_BY_PARENT_FAILURE_REASON);
    expect(restored.familySnapshot.bindings["binding-3"]?.status).toBe("active");
    expect(restored.familySnapshot.bindings["binding-3"]?.parentAttemptId)
      .toBe("attempt-work-second");
    expect(restored.workflows["workflow-root"]?.snapshot.runtime.nodes.work?.status)
      .toBe("waiting_for_child");
  });
});
