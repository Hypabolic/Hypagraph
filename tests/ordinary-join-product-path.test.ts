/**
 * J3 ordinary join product path: host helpers end-to-end without author produce
 * and without hand expectedBindingCount.
 *
 * Proves:
 * - 2-child all-success pass publishes host-default join.passed and leaves parent running;
 * - 3-child does not join early after two of three completed returns;
 * - skill text documents ordinary multi-child join without mandatory produce or expectedBindingCount.
 *
 * Reuses product helpers from family-product-synthesis and patterns from
 * ordinary-join-n-child-wait / s6-synthesis-fan-in. Does not claim Live Pi dogfood.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createBoundedChildGoal } from "../src/domain/child-goal-creation.js";
import {
  listActiveBindingsForParentNode,
  returnChildGoal,
} from "../src/domain/child-goal-return.js";
import {
  DEFAULT_JOIN_RESULT_FACT_NAME,
  listBindingsForParentJoin,
} from "../src/domain/child-outcome-synthesis.js";
import {
  GOAL_FAMILY_SCHEMA_VERSION,
  createRootFamily,
  type GoalFamilyRuntime,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { handleCommand } from "../src/domain/reducer.js";
import {
  applyReadyJoinSynthesesAfterReturns,
  applyReadyJoinSynthesesToPersistedFamily,
} from "../src/pi/family-product-synthesis.js";
import type { PersistedGoalFamily } from "../src/persistence/family-store.js";

const at = "2026-08-05T16:00:00.000Z";
const later = "2026-08-05T16:05:00.000Z";
const returnAt = "2026-08-05T16:10:00.000Z";
const joinAt = "2026-08-05T16:15:00.000Z";

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

const familyBounds = {
  maxDepth: 3,
  maxChildrenPerGoal: 4,
  maxGoalsInFamily: 16,
  maxChildCreationAttemptsPerNode: 4,
} as const;

/**
 * Create N children while the parent stays waiting_for_child.
 * Parent has no join.passed produce. No expectedBindingCount is set.
 */
const createNChildrenWhileWaiting = (input: {
  familyId: string;
  count: number;
}): {
  family: GoalFamilyRuntime;
  parentState: HypagraphState;
  childStates: HypagraphState[];
  bindingIds: string[];
} => {
  let rootState = createStartedWorkflow(
    ordinaryParent(`Product path parent ${input.familyId}`),
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
      failurePolicy: "block-parent-node",
    });
    if (!child.ok) throw new Error(JSON.stringify(child.diagnostics));
    family = child.family;
    parentState = child.parentState;
    childStates.push(child.childState);
    bindingIds.push(bindingId);
    expect(parentState.runtime.nodes.work?.status).toBe("waiting_for_child");
  }

  const workNode = parentState.definition.nodes.find((node) => node.id === "work");
  expect(
    (workNode?.produces ?? []).some(
      (contract) => contract.name === DEFAULT_JOIN_RESULT_FACT_NAME,
    ),
  ).toBe(false);

  return { family, parentState, childStates, bindingIds };
};

const assertNoAuthorJoinProduce = (parentState: HypagraphState): void => {
  const workNode = parentState.definition.nodes.find((node) => node.id === "work");
  expect(
    (workNode?.produces ?? []).some(
      (contract) => contract.name === DEFAULT_JOIN_RESULT_FACT_NAME,
    ),
  ).toBe(false);
};

describe("J3 ordinary join product path", () => {
  it("joins two completed children without author produce or expectedBindingCount", () => {
    const setup = createNChildrenWhileWaiting({
      familyId: "family-j3-product-n2",
      count: 2,
    });

    expect(listBindingsForParentJoin({
      family: setup.family,
      parentGoalId: "goal-root",
      parentNodeId: "work",
    })).toEqual(["binding-1", "binding-2"]);

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
    expect(afterFirst.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]).toBeUndefined();

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

    // Persisted-family product helper path (extension substitute).
    const persisted: PersistedGoalFamily = {
      schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
      familyEvents: [],
      familySnapshot: second.family,
      workflows: {
        "workflow-root": {
          events: [],
          snapshot: second.parentState,
        },
        "workflow-child-1": {
          events: [],
          snapshot: setup.childStates[0]!,
        },
        "workflow-child-2": {
          events: [],
          snapshot: setup.childStates[1]!,
        },
      },
    };

    const synthesized = applyReadyJoinSynthesesToPersistedFamily({
      family: persisted,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(synthesized.ok).toBe(true);
    if (!synthesized.ok) throw new Error(JSON.stringify(synthesized.diagnostics));
    expect(synthesized.applied).toHaveLength(1);
    expect(synthesized.applied[0]?.result.status).toBe("passed");
    expect(synthesized.applied[0]?.factPublished).toBe(true);
    expect(synthesized.applied[0]?.policy.expectedBindingCount).toBeUndefined();
    expect(synthesized.applied[0]?.policy.resultFactName).toBe(DEFAULT_JOIN_RESULT_FACT_NAME);

    const parentWorkflow = synthesized.family.workflows["workflow-root"];
    expect(parentWorkflow?.snapshot.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(true);
    expect(parentWorkflow?.snapshot.runtime.nodes.work?.status).toBe("running");
    expect(parentWorkflow?.events.some((event) => event.type === "hypagraph.fact.published")).toBe(true);
    assertNoAuthorJoinProduce(parentWorkflow!.snapshot);
  });

  it("does not join early for three children after two completed returns", () => {
    const setup = createNChildrenWhileWaiting({
      familyId: "family-j3-product-n3",
      count: 3,
    });

    expect(listBindingsForParentJoin({
      family: setup.family,
      parentGoalId: "goal-root",
      parentNodeId: "work",
    })).toEqual(["binding-1", "binding-2", "binding-3"]);

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
    expect(afterThree.applied[0]?.policy.expectedBindingCount).toBeUndefined();
    expect(afterThree.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(true);
    expect(afterThree.parentState.runtime.nodes.work?.status).toBe("running");
    assertNoAuthorJoinProduce(afterThree.parentState);
  });

  it("skill documents ordinary multi-child join without mandatory produce or expectedBindingCount", () => {
    const skill = readFileSync(resolve(process.cwd(), "skills/hypagraph/SKILL.md"), "utf8");
    expect(skill).toMatch(/Multi-child fan-out and ordinary join/i);
    expect(skill).toMatch(/waiting_for_child/);
    expect(skill).toMatch(/Create siblings while the parent waits|hypagoal_create_child.*more than once/i);
    expect(skill).toMatch(/auto-joins|auto join/i);
    expect(skill).toContain("join.passed");
    expect(skill).toMatch(/Do not set `expectedBindingCount` for the ordinary path/i);
    expect(skill).toMatch(/Do not declare produce `join\.passed` on the parent for ordinary multi-child join/i);
    expect(skill).toMatch(/not mandatory for ordinary multi-child join|not required for the default path/i);
    expect(skill).toMatch(/One child alone does not trigger multi-child auto join|multi-child minimum is two/i);
    expect(skill).not.toMatch(
      /must declare produce [`']?join\.passed for (ordinary|multi-child)|must set `expectedBindingCount` for (ordinary|multi-child)/i,
    );
  });
});
