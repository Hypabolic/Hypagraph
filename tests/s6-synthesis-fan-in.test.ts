/**
 * S6: synthesis fan-in domain and host path.
 *
 * Proves:
 * - all-success join over terminal child outcomes;
 * - schema reject and policy validation;
 * - replay-stable pure evaluation (fixed timestamps);
 * - host product helpers apply join to parent state after multi-child return.
 *
 * Does not claim ledger Live. Automated domain and host substitute only.
 */

import { describe, expect, it } from "vitest";
import { createBoundedChildGoal } from "../src/domain/child-goal-creation.js";
import {
  CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION,
  DEFAULT_JOIN_RESULT_FACT_NAME,
  applyChildOutcomeSynthesisToParent,
  collectChildOutcomeMembersFromFamily,
  compareBindingId,
  createAllSuccessJoinPolicy,
  evaluateChildOutcomeSynthesis,
  isJoinSetTerminal,
  listBindingsForParentJoin,
  parseChildOutcomeSynthesisPolicy,
  synthesizeAndApplyChildOutcomes,
  synthesizeChildOutcomesFromFamily,
  validateChildOutcomeSynthesisPolicy,
  type ChildOutcomeMember,
  type ChildOutcomeSynthesisPolicy,
} from "../src/domain/child-outcome-synthesis.js";
import { returnChildGoal } from "../src/domain/child-goal-return.js";
import {
  GOAL_FAMILY_SCHEMA_VERSION,
  createRootFamily,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { applyEvent } from "../src/domain/projection.js";
import { handleCommand } from "../src/domain/reducer.js";
import {
  AUTO_JOIN_MIN_BINDING_COUNT,
  applyProductJoinSynthesis,
  applyReadyJoinSynthesesAfterReturns,
  applyReadyJoinSynthesesToPersistedFamily,
  isAutoProductJoinEligible,
  renderJoinSynthesisApplied,
  resolveProductJoinPolicy,
} from "../src/pi/family-product-synthesis.js";
import type { PersistedGoalFamily } from "../src/persistence/family-store.js";

const at = "2026-08-05T14:00:00.000Z";
const later = "2026-08-05T14:05:00.000Z";
const returnAt = "2026-08-05T14:10:00.000Z";
const joinAt = "2026-08-05T14:15:00.000Z";

const parentWithJoinFact = (title: string): HypagraphDefinition => ({
  title,
  goal: title,
  nodes: [{
    id: "work",
    title: "Work",
    requires: [],
    acceptance: [],
    scope: { paths: ["src/**"] },
    produces: [{ name: DEFAULT_JOIN_RESULT_FACT_NAME, type: "boolean" }],
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
    stopReason: "Child failed for synthesis test.",
  };
  clone.phase = "failed";
  return clone;
};

const freeze = <T>(value: T): T => structuredClone(value);

describe("S6 domain child outcome synthesis policy", () => {
  it("validates an all-success policy and rejects unsupported schema versions", () => {
    const ok = validateChildOutcomeSynthesisPolicy({
      schemaVersion: CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION,
      strategy: "all-success",
      bindingIds: ["b-2", "b-1"],
      resultFactName: "join.passed",
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("expected policy ok");
    expect(ok.policy.bindingIds).toEqual(["b-2", "b-1"]);
    expect(ok.policy.resultFactName).toBe("join.passed");

    const badSchema = parseChildOutcomeSynthesisPolicy({
      schemaVersion: 99,
      strategy: "all-success",
      bindingIds: ["b-1"],
    });
    expect(badSchema.ok).toBe(false);
    if (badSchema.ok) throw new Error("expected schema reject");
    expect(badSchema.diagnostics[0]?.code).toBe("unsupported_child_outcome_synthesis_schema");

    const badStrategy = validateChildOutcomeSynthesisPolicy({
      schemaVersion: 1,
      strategy: "quorum",
      bindingIds: ["b-1"],
    });
    expect(badStrategy.ok).toBe(false);
    if (badStrategy.ok) throw new Error("expected strategy reject");
    expect(badStrategy.diagnostics[0]?.code).toBe("child_outcome_synthesis_invalid_strategy");

    const duplicate = createAllSuccessJoinPolicy({ bindingIds: ["b-1", "b-1"] });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("expected duplicate reject");
    expect(duplicate.diagnostics[0]?.code).toBe("child_outcome_synthesis_duplicate_binding_id");

    const classInstance = validateChildOutcomeSynthesisPolicy(
      Object.assign(new (class Policy {})(), {
        schemaVersion: 1,
        strategy: "all-success",
        bindingIds: ["b-1"],
      }),
    );
    expect(classInstance.ok).toBe(false);
    if (classInstance.ok) throw new Error("expected class instance reject");
    expect(classInstance.diagnostics[0]?.code).toBe("child_outcome_synthesis_invalid_policy");

    const badExpected = validateChildOutcomeSynthesisPolicy({
      schemaVersion: 1,
      strategy: "all-success",
      bindingIds: ["b-1"],
      expectedBindingCount: 0,
    });
    expect(badExpected.ok).toBe(false);
    if (badExpected.ok) throw new Error("expected expectedBindingCount reject");
    expect(badExpected.diagnostics[0]?.code).toBe(
      "child_outcome_synthesis_invalid_expected_binding_count",
    );
  });

  it("rejects empty binding id entries and invalid result fact names", () => {
    const emptyId = validateChildOutcomeSynthesisPolicy({
      schemaVersion: 1,
      strategy: "all-success",
      bindingIds: ["  "],
    });
    expect(emptyId.ok).toBe(false);
    if (emptyId.ok) throw new Error("expected empty id reject");
    expect(emptyId.diagnostics[0]?.code).toBe("child_outcome_synthesis_invalid_binding_id");

    const badFact = validateChildOutcomeSynthesisPolicy({
      schemaVersion: 1,
      strategy: "all-success",
      bindingIds: [],
      resultFactName: "",
    });
    expect(badFact.ok).toBe(false);
    if (badFact.ok) throw new Error("expected fact name reject");
    expect(badFact.diagnostics[0]?.code).toBe("child_outcome_synthesis_invalid_result_fact_name");
  });
});

describe("S6 domain all-success evaluation", () => {
  const policy = (bindingIds: string[]): ChildOutcomeSynthesisPolicy => {
    const created = createAllSuccessJoinPolicy({ bindingIds });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    return created.policy;
  };

  it("passes when every child completed and fails when any child did not complete", () => {
    const two = policy(["b-a", "b-b"]);
    const allCompleted = evaluateChildOutcomeSynthesis(two, [
      { bindingId: "b-a", terminal: true, outcome: "completed" },
      { bindingId: "b-b", terminal: true, outcome: "completed" },
    ]);
    expect(allCompleted.ok).toBe(true);
    if (!allCompleted.ok) throw new Error("expected ok");
    expect(allCompleted.result.status).toBe("passed");
    expect(allCompleted.result.passed).toBe(true);
    expect(allCompleted.result.completedCount).toBe(2);
    expect(allCompleted.result.publishedFact).toEqual({
      name: DEFAULT_JOIN_RESULT_FACT_NAME,
      type: "boolean",
      value: true,
    });

    const oneFailed = evaluateChildOutcomeSynthesis(two, [
      { bindingId: "b-a", terminal: true, outcome: "completed" },
      { bindingId: "b-b", terminal: true, outcome: "failed" },
    ]);
    expect(oneFailed.ok).toBe(true);
    if (!oneFailed.ok) throw new Error("expected ok");
    expect(oneFailed.result.status).toBe("failed");
    expect(oneFailed.result.passed).toBe(false);
    expect(oneFailed.result.failedBindingIds).toEqual(["b-b"]);
    expect(oneFailed.result.publishedFact?.value).toBe(false);

    const cancelled = evaluateChildOutcomeSynthesis(two, [
      { bindingId: "b-a", terminal: true, outcome: "cancelled" },
      { bindingId: "b-b", terminal: true, outcome: "completed" },
    ]);
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) throw new Error("expected ok");
    expect(cancelled.result.status).toBe("failed");
  });

  it("returns pending when any join member is not terminal", () => {
    const three = policy(["b-1", "b-2", "b-3"]);
    const pending = evaluateChildOutcomeSynthesis(three, [
      { bindingId: "b-1", terminal: true, outcome: "completed" },
      { bindingId: "b-2", terminal: false },
      { bindingId: "b-3", terminal: true, outcome: "completed" },
    ]);
    expect(pending.ok).toBe(true);
    if (!pending.ok) throw new Error("expected ok");
    expect(pending.result.status).toBe("pending");
    expect(pending.result.passed).toBe(false);
    expect(pending.result.pendingBindingIds).toEqual(["b-2"]);
    expect(pending.result.publishedFact).toBeUndefined();
  });

  it("treats an empty join set as a pass under all-success", () => {
    const empty = policy([]);
    const result = evaluateChildOutcomeSynthesis(empty, []);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.result.status).toBe("passed");
    expect(result.result.passed).toBe(true);
    expect(result.result.reason).toMatch(/Empty join set/);
  });

  it("stays pending until expectedBindingCount bindings are present", () => {
    const withExpected = createAllSuccessJoinPolicy({
      bindingIds: ["b-1"],
      expectedBindingCount: 2,
    });
    expect(withExpected.ok).toBe(true);
    if (!withExpected.ok) throw new Error("policy");
    const pending = evaluateChildOutcomeSynthesis(withExpected.policy, [
      { bindingId: "b-1", terminal: true, outcome: "completed" },
    ]);
    expect(pending.ok).toBe(true);
    if (!pending.ok) throw new Error("expected ok");
    expect(pending.result.status).toBe("pending");
    expect(pending.result.reason).toMatch(/more binding/);
  });

  it("rejects a class-instance member object", () => {
    const member = Object.assign(new (class Member {})(), {
      bindingId: "b-1",
      terminal: true,
      outcome: "completed",
    });
    const result = evaluateChildOutcomeSynthesis(policy(["b-1"]), [member as ChildOutcomeMember]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected class instance member reject");
    expect(result.diagnostics[0]?.code).toBe("child_outcome_synthesis_invalid_member");
  });

  it("orders result arrays by binding id without locale-sensitive compare", () => {
    const members: ChildOutcomeMember[] = [
      { bindingId: "z-last", terminal: true, outcome: "failed" },
      { bindingId: "a-first", terminal: true, outcome: "completed" },
      { bindingId: "m-mid", terminal: true, outcome: "completed" },
    ];
    const result = evaluateChildOutcomeSynthesis(policy(["z-last", "a-first", "m-mid"]), members);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.result.completedBindingIds).toEqual(["a-first", "m-mid"]);
    expect(result.result.failedBindingIds).toEqual(["z-last"]);
    expect(compareBindingId("a", "b")).toBeLessThan(0);
  });

  it("is replay deterministic for the same pure inputs", () => {
    const p = policy(["bind-x", "bind-y"]);
    const members: ChildOutcomeMember[] = [
      { bindingId: "bind-x", terminal: true, outcome: "completed" },
      { bindingId: "bind-y", terminal: true, outcome: "completed" },
    ];
    const first = evaluateChildOutcomeSynthesis(p, members);
    const second = evaluateChildOutcomeSynthesis(p, members);
    expect(first).toEqual(second);
  });

  it("rejects a missing member row for a policy binding", () => {
    const result = evaluateChildOutcomeSynthesis(policy(["b-1", "b-2"]), [
      { bindingId: "b-1", terminal: true, outcome: "completed" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected missing member");
    expect(result.diagnostics[0]?.code).toBe("child_outcome_synthesis_member_missing");
  });
});

describe("S6 domain family collection and parent apply", () => {
  const setupTwoChildren = (options?: {
    secondOutcome?: "completed" | "failed";
    failurePolicy?: "fail-parent-node" | "block-parent-node";
  }) => {
    let rootState = createStartedWorkflow(parentWithJoinFact("Root join work"), "workflow-root", "goal-root");
    rootState = startTask(rootState, "work");

    const familyResult = createRootFamily({
      familyId: "family-s6",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
      bounds: {
        maxDepth: 3,
        maxChildrenPerGoal: 4,
        maxGoalsInFamily: 16,
        maxChildCreationAttemptsPerNode: 4,
      },
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
      failurePolicy: options?.failurePolicy ?? "block-parent-node",
    });
    if (!child1.ok) throw new Error(JSON.stringify(child1.diagnostics));

    const child1Terminal = options?.secondOutcome === undefined
      ? terminalCompletedChild(child1.childState)
      : terminalCompletedChild(child1.childState);
    const return1 = returnChildGoal({
      family: child1.family,
      parentState: child1.parentState,
      childState: child1Terminal,
      bindingId: "binding-1",
      at: returnAt,
      outcome: "completed",
    });
    if (!return1.ok) throw new Error(JSON.stringify(return1.diagnostics));

    // Parent is running after first return. Create second child on the same node.
    const child2 = createBoundedChildGoal({
      family: return1.family,
      parentState: return1.parentState,
      parentNodeId: "work",
      childDefinition: childTask("Child two"),
      childGoalId: "goal-child-2",
      childWorkflowId: "workflow-child-2",
      bindingId: "binding-2",
      at: returnAt,
      scopePaths: ["src/**"],
      failurePolicy: options?.failurePolicy ?? "block-parent-node",
    });
    if (!child2.ok) throw new Error(JSON.stringify(child2.diagnostics));

    const secondOutcome = options?.secondOutcome ?? "completed";
    const child2Terminal = secondOutcome === "completed"
      ? terminalCompletedChild(child2.childState)
      : terminalFailedChild(child2.childState);
    const return2 = returnChildGoal({
      family: child2.family,
      parentState: child2.parentState,
      childState: child2Terminal,
      bindingId: "binding-2",
      at: joinAt,
      outcome: secondOutcome,
    });
    if (!return2.ok) throw new Error(JSON.stringify(return2.diagnostics));

    return {
      family: return2.family,
      parentState: return2.parentState,
      bindingIds: ["binding-1", "binding-2"] as const,
    };
  };

  it("collects terminal members from family bindings in deterministic order", () => {
    const setup = setupTwoChildren();
    const ids = listBindingsForParentJoin({
      family: setup.family,
      parentGoalId: "goal-root",
      parentNodeId: "work",
    });
    expect(ids).toEqual(["binding-1", "binding-2"]);
    expect(isJoinSetTerminal(setup.family, ids)).toBe(true);

    const members = collectChildOutcomeMembersFromFamily(setup.family, ids);
    expect(members.ok).toBe(true);
    if (!members.ok) throw new Error("expected members");
    expect(members.members.every((item) => item.terminal)).toBe(true);

    const evaluated = synthesizeChildOutcomesFromFamily(
      setup.family,
      createAllSuccessJoinPolicy({ bindingIds: ids }).ok
        ? (createAllSuccessJoinPolicy({ bindingIds: ids }) as { ok: true; policy: ChildOutcomeSynthesisPolicy }).policy
        : { schemaVersion: 1, strategy: "all-success", bindingIds: ids, resultFactName: "join.passed" },
    );
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) throw new Error("expected evaluate ok");
    expect(evaluated.result.status).toBe("passed");
  });

  it("applies all-success pass to parent by publishing join.passed", () => {
    const setup = setupTwoChildren();
    const policyResult = createAllSuccessJoinPolicy({ bindingIds: [...setup.bindingIds] });
    if (!policyResult.ok) throw new Error(JSON.stringify(policyResult.diagnostics));

    const parentBefore = freeze(setup.parentState);
    const familyBefore = freeze(setup.family);
    const attemptId = setup.parentState.runtime.nodes.work?.currentAttemptId;
    expect(attemptId).toBeTruthy();

    const applied = synthesizeAndApplyChildOutcomes({
      family: setup.family,
      parentState: setup.parentState,
      policy: policyResult.policy,
      parentNodeId: "work",
      parentAttemptId: attemptId!,
      at: joinAt,
      commandId: "synth-pass-1",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok || !("parentState" in applied)) throw new Error("expected applied");
    expect(applied.result.status).toBe("passed");
    expect(applied.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(true);
    expect(applied.parentState.runtime.nodes.work?.status).toBe("running");
    expect(applied.parentEvents.some((event) => event.type === "hypagraph.fact.published")).toBe(true);
    expect(applied.record.schemaVersion).toBe(CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION);
    expect(applied.record.bindingIds).toEqual(["binding-1", "binding-2"]);

    // Inputs are not mutated.
    expect(setup.parentState).toEqual(parentBefore);
    expect(setup.family).toEqual(familyBefore);
  });

  it("applies all-success failure by publishing join.passed=false and blocking parent", () => {
    let rootState = createStartedWorkflow(parentWithJoinFact("Root fail join"), "workflow-root-f", "goal-root-f");
    rootState = startTask(rootState, "work", "attempt-work-f");
    const familyResult = createRootFamily({
      familyId: "family-s6-fail",
      rootGoalId: "goal-root-f",
      rootWorkflowId: "workflow-root-f",
      at,
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));
    const child = createBoundedChildGoal({
      family: familyResult.family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: childTask("Only child"),
      childGoalId: "goal-child-f",
      childWorkflowId: "workflow-child-f",
      bindingId: "binding-f",
      at: later,
      scopePaths: ["src/**"],
      failurePolicy: "block-parent-node",
    });
    if (!child.ok) throw new Error(JSON.stringify(child.diagnostics));
    // Return completed so parent is running, then apply a failed join evaluation.
    const returned = returnChildGoal({
      family: child.family,
      parentState: child.parentState,
      childState: terminalCompletedChild(child.childState),
      bindingId: "binding-f",
      at: returnAt,
      outcome: "completed",
    });
    if (!returned.ok) throw new Error(JSON.stringify(returned.diagnostics));

    const policy = createAllSuccessJoinPolicy({ bindingIds: ["binding-f"] });
    if (!policy.ok) throw new Error(JSON.stringify(policy.diagnostics));
    const failedEval = evaluateChildOutcomeSynthesis(
      policy.policy,
      [{ bindingId: "binding-f", terminal: true, outcome: "failed" }],
    );
    expect(failedEval.ok).toBe(true);
    if (!failedEval.ok) throw new Error("expected failed eval");
    expect(failedEval.result.status).toBe("failed");

    const attemptId = returned.parentState.runtime.nodes.work?.currentAttemptId;
    expect(attemptId).toBeTruthy();
    const applied = applyChildOutcomeSynthesisToParent({
      parentState: returned.parentState,
      policy: policy.policy,
      result: failedEval.result,
      parentNodeId: "work",
      parentAttemptId: attemptId!,
      at: joinAt,
      commandId: "synth-fail-1",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error(JSON.stringify(applied.diagnostics));
    expect(applied.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(false);
    expect(applied.parentState.runtime.nodes.work?.status).toBe("blocked");
    expect(returned.family.schemaVersion).toBe(GOAL_FAMILY_SCHEMA_VERSION);
  });

  it("returns pending from synthesizeAndApply when a binding is still active", () => {
    let rootState = createStartedWorkflow(parentWithJoinFact("Root pending"), "workflow-root-p", "goal-root-p");
    rootState = startTask(rootState, "work");
    const familyResult = createRootFamily({
      familyId: "family-s6-pending",
      rootGoalId: "goal-root-p",
      rootWorkflowId: "workflow-root-p",
      at,
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));
    const child = createBoundedChildGoal({
      family: familyResult.family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: childTask("Active child"),
      childGoalId: "goal-child-p",
      childWorkflowId: "workflow-child-p",
      bindingId: "binding-p",
      at: later,
      scopePaths: ["src/**"],
    });
    if (!child.ok) throw new Error(JSON.stringify(child.diagnostics));

    const policy = createAllSuccessJoinPolicy({ bindingIds: ["binding-p"] });
    if (!policy.ok) throw new Error("policy");
    const pending = synthesizeAndApplyChildOutcomes({
      family: child.family,
      parentState: child.parentState,
      policy: policy.policy,
      parentNodeId: "work",
      parentAttemptId: child.parentState.runtime.nodes.work?.currentAttemptId ?? "attempt-work",
      at: joinAt,
    });
    expect(pending.ok).toBe(true);
    if (!pending.ok || !("status" in pending)) throw new Error("expected pending");
    expect(pending.status).toBe("pending");
    expect(pending.result.pendingBindingIds).toEqual(["binding-p"]);
  });
});

describe("S6 host product synthesis path", () => {
  const setupHostFamily = (secondOutcome: "completed" | "failed" = "completed") => {
    let rootState = createStartedWorkflow(parentWithJoinFact("Host join root"), "workflow-root", "goal-root");
    rootState = startTask(rootState, "work");
    const familyResult = createRootFamily({
      familyId: "family-s6-host",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
      bounds: {
        maxDepth: 3,
        maxChildrenPerGoal: 4,
        maxGoalsInFamily: 16,
        maxChildCreationAttemptsPerNode: 4,
      },
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

    const child1 = createBoundedChildGoal({
      family: familyResult.family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: childTask("Host child one"),
      childGoalId: "goal-child-1",
      childWorkflowId: "workflow-child-1",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
      failurePolicy: "block-parent-node",
    });
    if (!child1.ok) throw new Error(JSON.stringify(child1.diagnostics));

    let family = child1.family;
    let parentState = child1.parentState;
    let child1State = terminalCompletedChild(child1.childState);
    const return1 = returnChildGoal({
      family,
      parentState,
      childState: child1State,
      bindingId: "binding-1",
      at: returnAt,
      outcome: "completed",
    });
    if (!return1.ok) throw new Error(JSON.stringify(return1.diagnostics));
    family = return1.family;
    parentState = return1.parentState;

    const child2 = createBoundedChildGoal({
      family,
      parentState,
      parentNodeId: "work",
      childDefinition: childTask("Host child two"),
      childGoalId: "goal-child-2",
      childWorkflowId: "workflow-child-2",
      bindingId: "binding-2",
      at: returnAt,
      scopePaths: ["src/**"],
      failurePolicy: "block-parent-node",
    });
    if (!child2.ok) throw new Error(JSON.stringify(child2.diagnostics));
    family = child2.family;
    parentState = child2.parentState;
    const child2State = secondOutcome === "completed"
      ? terminalCompletedChild(child2.childState)
      : terminalFailedChild(child2.childState);
    const return2 = returnChildGoal({
      family,
      parentState,
      childState: child2State,
      bindingId: "binding-2",
      at: joinAt,
      outcome: secondOutcome,
    });
    if (!return2.ok) throw new Error(JSON.stringify(return2.diagnostics));

    return {
      family: return2.family,
      parentState: return2.parentState,
      child1State,
      child2State,
    };
  };

  const setupAfterFirstChildOnly = () => {
    let rootState = createStartedWorkflow(parentWithJoinFact("Host join root"), "workflow-root", "goal-root");
    rootState = startTask(rootState, "work");
    const familyResult = createRootFamily({
      familyId: "family-s6-first",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
      bounds: {
        maxDepth: 3,
        maxChildrenPerGoal: 4,
        maxGoalsInFamily: 16,
        maxChildCreationAttemptsPerNode: 4,
      },
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));
    const child1 = createBoundedChildGoal({
      family: familyResult.family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: childTask("Host child one only"),
      childGoalId: "goal-child-1",
      childWorkflowId: "workflow-child-1",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
      failurePolicy: "block-parent-node",
    });
    if (!child1.ok) throw new Error(JSON.stringify(child1.diagnostics));
    const return1 = returnChildGoal({
      family: child1.family,
      parentState: child1.parentState,
      childState: terminalCompletedChild(child1.childState),
      bindingId: "binding-1",
      at: returnAt,
      outcome: "completed",
    });
    if (!return1.ok) throw new Error(JSON.stringify(return1.diagnostics));
    return { family: return1.family, parentState: return1.parentState };
  };

  it("resolves an all-success policy from parent bindings on the host path", () => {
    const setup = setupHostFamily();
    const resolved = resolveProductJoinPolicy({
      family: setup.family,
      parentGoalId: "goal-root",
      parentNodeId: "work",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("expected resolve ok");
    expect(resolved.policy.strategy).toBe("all-success");
    expect(resolved.policy.bindingIds).toEqual(["binding-1", "binding-2"]);
    expect(resolved.explicit).toBe(false);
  });

  it("does not auto-complete join after the first of two sequential children", () => {
    const first = setupAfterFirstChildOnly();
    expect(first.parentState.runtime.nodes.work?.status).toBe("running");
    const ready = applyReadyJoinSynthesesAfterReturns({
      family: first.family,
      parentState: first.parentState,
      parentGoalId: "goal-root",
      at: returnAt,
    });
    expect(ready.ok).toBe(true);
    expect(ready.applied).toHaveLength(0);
    expect(ready.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]).toBeUndefined();
    expect(ready.pending.length + ready.skipped.length).toBeGreaterThan(0);
    // Auto path waits for at least two bindings without expectedBindingCount.
    expect(AUTO_JOIN_MIN_BINDING_COUNT).toBe(2);
  });

  it("does not apply join early when expectedBindingCount is two and one binding exists", () => {
    const first = setupAfterFirstChildOnly();
    const policy = createAllSuccessJoinPolicy({
      bindingIds: ["binding-1"],
      expectedBindingCount: 2,
    });
    if (!policy.ok) throw new Error(JSON.stringify(policy.diagnostics));
    const attemptId = first.parentState.runtime.nodes.work?.currentAttemptId;
    expect(attemptId).toBeTruthy();
    const product = applyProductJoinSynthesis({
      family: first.family,
      parentState: first.parentState,
      policy: policy.policy,
      parentGoalId: "goal-root",
      parentNodeId: "work",
      parentAttemptId: attemptId!,
      at: returnAt,
    });
    expect(product.ok).toBe(true);
    if (!product.ok) throw new Error("expected ok");
    expect(product.status).toBe("pending");
    expect(first.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]).toBeUndefined();
  });

  it("applies product join synthesis after multi-child return and changes parent state", () => {
    const setup = setupHostFamily("completed");
    const attemptId = setup.parentState.runtime.nodes.work?.currentAttemptId;
    expect(attemptId).toBeTruthy();
    expect(setup.parentState.runtime.nodes.work?.status).toBe("running");

    const applied = applyProductJoinSynthesis({
      family: setup.family,
      parentState: setup.parentState,
      parentGoalId: "goal-root",
      parentNodeId: "work",
      parentAttemptId: attemptId!,
      at: joinAt,
      commandId: "host-synth-pass",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok || applied.status !== "applied") {
      throw new Error(JSON.stringify(applied));
    }
    expect(applied.result.status).toBe("passed");
    expect(applied.factPublished).toBe(true);
    expect(applied.parentMutated).toBe(true);
    expect(applied.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(true);
    expect(applied.parentState.runtime.nodes.work?.status).toBe("running");
    expect(applied.parentEvents.length).toBeGreaterThan(0);
  });

  it("applies ready join syntheses after returns helper for the parent goal", () => {
    const setup = setupHostFamily("completed");
    const ready = applyReadyJoinSynthesesAfterReturns({
      family: setup.family,
      parentState: setup.parentState,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(ready.ok).toBe(true);
    expect(ready.applied).toHaveLength(1);
    expect(ready.applied[0]?.result.status).toBe("passed");
    expect(ready.applied[0]?.factPublished).toBe(true);
    expect(ready.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(true);
    expect(ready.pending).toHaveLength(0);
  });

  it("applies join on restore-style re-entry when returns already settled and fact is missing", () => {
    // Mimic extension re-entry: applied returns are already committed; synthesis
    // still runs when the join set is ready and join.passed is absent.
    const setup = setupHostFamily("completed");
    expect(setup.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]).toBeUndefined();
    const persisted: PersistedGoalFamily = {
      schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
      familyEvents: [],
      familySnapshot: setup.family,
      workflows: {
        "workflow-root": {
          events: [],
          snapshot: setup.parentState,
        },
        "workflow-child-1": {
          events: [],
          snapshot: setup.child1State,
        },
        "workflow-child-2": {
          events: [],
          snapshot: setup.child2State,
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
    expect(synthesized.applied[0]?.factPublished).toBe(true);
    const parentWorkflow = synthesized.family.workflows["workflow-root"];
    expect(parentWorkflow?.snapshot.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(true);
    expect(parentWorkflow?.events.some((event) => event.type === "hypagraph.fact.published")).toBe(true);

    // Second pass is quiet: fact already present, no further mutation.
    const again = applyReadyJoinSynthesesToPersistedFamily({
      family: synthesized.family,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error(JSON.stringify(again.diagnostics));
    expect(again.applied).toHaveLength(0);
    expect(again.skipped.length + again.pending.length).toBeGreaterThanOrEqual(0);
  });

  it("quiet-skips failed join when child failure policy already blocked the parent", () => {
    // Product path: non-completed child return applies failure policy first.
    // Parent is not running, so host synthesis does not publish join.passed=false.
    // Child failure policy owns the parent effect. Re-entry stays quiet.
    const setup = setupHostFamily("failed");
    expect(setup.parentState.runtime.nodes.work?.status).toBe("blocked");
    const ready = applyReadyJoinSynthesesAfterReturns({
      family: setup.family,
      parentState: setup.parentState,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(ready.ok).toBe(true);
    expect(ready.applied).toHaveLength(0);
    expect(ready.diagnostics).toHaveLength(0);
    expect(ready.skipped.some((item) => item.parentNodeId === "work")).toBe(true);

    const again = applyReadyJoinSynthesesAfterReturns({
      family: setup.family,
      parentState: setup.parentState,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(again.ok).toBe(true);
    expect(again.applied).toHaveLength(0);
    expect(again.diagnostics).toHaveLength(0);
  });

  it("documents that auto join without expectedBindingCount applies after second of three sequential children", () => {
    // Honest product rule: auto multi without expectedBindingCount is only safe
    // for a planned join of exactly two. After two of three returns, set size is
    // two, auto eligibility passes, and join.passed can publish early.
    // For three or more, callers must set expectedBindingCount.
    let rootState = createStartedWorkflow(parentWithJoinFact("Three child root"), "workflow-root", "goal-root");
    rootState = startTask(rootState, "work");
    const familyResult = createRootFamily({
      familyId: "family-s6-three",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
      bounds: {
        maxDepth: 3,
        maxChildrenPerGoal: 4,
        maxGoalsInFamily: 16,
        maxChildCreationAttemptsPerNode: 4,
      },
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

    let family = familyResult.family;
    let parentState = rootState;
    for (const index of [1, 2] as const) {
      const child = createBoundedChildGoal({
        family,
        parentState,
        parentNodeId: "work",
        childDefinition: childTask(`Child ${index}`),
        childGoalId: `goal-child-${index}`,
        childWorkflowId: `workflow-child-${index}`,
        bindingId: `binding-${index}`,
        at: index === 1 ? later : returnAt,
        scopePaths: ["src/**"],
        failurePolicy: "block-parent-node",
      });
      if (!child.ok) throw new Error(JSON.stringify(child.diagnostics));
      const returned = returnChildGoal({
        family: child.family,
        parentState: child.parentState,
        childState: terminalCompletedChild(child.childState),
        bindingId: `binding-${index}`,
        at: index === 1 ? returnAt : joinAt,
        outcome: "completed",
      });
      if (!returned.ok) throw new Error(JSON.stringify(returned.diagnostics));
      family = returned.family;
      parentState = returned.parentState;
    }

    expect(listBindingsForParentJoin({
      family,
      parentGoalId: "goal-root",
      parentNodeId: "work",
    })).toEqual(["binding-1", "binding-2"]);

    // Auto path (no expectedBindingCount): second-of-three applies early.
    const autoReady = applyReadyJoinSynthesesAfterReturns({
      family,
      parentState,
      parentGoalId: "goal-root",
      at: joinAt,
    });
    expect(autoReady.ok).toBe(true);
    expect(autoReady.applied).toHaveLength(1);
    expect(autoReady.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(true);

    // With expectedBindingCount 3, the same two-binding set stays pending.
    const withExpected = createAllSuccessJoinPolicy({
      bindingIds: ["binding-1", "binding-2"],
      expectedBindingCount: 3,
    });
    if (!withExpected.ok) throw new Error(JSON.stringify(withExpected.diagnostics));
    const attemptId = parentState.runtime.nodes.work?.currentAttemptId;
    expect(attemptId).toBeTruthy();
    const pending = applyProductJoinSynthesis({
      family,
      parentState,
      policy: withExpected.policy,
      parentGoalId: "goal-root",
      parentNodeId: "work",
      parentAttemptId: attemptId!,
      at: joinAt,
    });
    expect(pending.ok).toBe(true);
    if (!pending.ok) throw new Error("expected ok");
    expect(pending.status).toBe("pending");
  });

  it("applies join synthesis on the persisted family product path", () => {
    const setup = setupHostFamily("completed");
    const persisted: PersistedGoalFamily = {
      schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
      familyEvents: [],
      familySnapshot: setup.family,
      workflows: {
        "workflow-root": {
          events: [],
          snapshot: setup.parentState,
        },
        "workflow-child-1": {
          events: [],
          snapshot: setup.child1State,
        },
        "workflow-child-2": {
          events: [],
          snapshot: setup.child2State,
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
    const parentWorkflow = synthesized.family.workflows["workflow-root"];
    expect(parentWorkflow?.snapshot.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(true);
    expect(parentWorkflow?.events.some((event) => event.type === "hypagraph.fact.published")).toBe(true);
  });

  it("renders notify text without claiming publish when fact was not published", () => {
    const published = renderJoinSynthesisApplied({
      parentNodeId: "work",
      status: "passed",
      completedCount: 2,
      totalCount: 2,
      resultFactName: "join.passed",
      parentNodeStatus: "running",
      factPublished: true,
      parentMutated: true,
    });
    expect(published).toMatch(/Published 'join.passed'=true/);

    const evaluationOnly = renderJoinSynthesisApplied({
      parentNodeId: "work",
      status: "passed",
      completedCount: 2,
      totalCount: 2,
      resultFactName: "join.passed",
      parentNodeStatus: "running",
      factPublished: false,
      parentMutated: false,
    });
    expect(evaluationOnly).toMatch(/Evaluation only/);
    expect(evaluationOnly).not.toMatch(/Published 'join.passed'=true/);
  });

  it("allows auto product eligibility without join.passed produce", () => {
    let plainRoot = createStartedWorkflow(
      {
        title: "No join produce",
        goal: "No join produce",
        nodes: [{
          id: "work",
          title: "Work",
          requires: [],
          acceptance: [],
          scope: { paths: ["src/**"] },
        }],
        loops: [],
        policy: { mode: "guided", requireEvidence: false },
      },
      "workflow-plain",
      "goal-plain",
    );
    plainRoot = startTask(plainRoot, "work");
    const policy = createAllSuccessJoinPolicy({ bindingIds: ["binding-1", "binding-2"] });
    if (!policy.ok) throw new Error("policy");
    const eligibility = isAutoProductJoinEligible({
      policy: policy.policy,
      explicit: false,
      parentState: plainRoot,
      parentNodeId: "work",
      parentAttemptId: plainRoot.runtime.nodes.work?.currentAttemptId ?? "attempt-work",
    });
    expect(eligibility.eligible).toBe(true);
    expect(policy.policy.expectedBindingCount).toBeUndefined();
    expect(policy.policy.resultFactName).toBe(DEFAULT_JOIN_RESULT_FACT_NAME);
  });

  it("requires produce for explicit policy when join.passed is undeclared", () => {
    let plainRoot = createStartedWorkflow(
      {
        title: "Explicit no produce",
        goal: "Explicit no produce",
        nodes: [{
          id: "work",
          title: "Work",
          requires: [],
          acceptance: [],
          scope: { paths: ["src/**"] },
        }],
        loops: [],
        policy: { mode: "guided", requireEvidence: false },
      },
      "workflow-explicit-plain",
      "goal-explicit-plain",
    );
    plainRoot = startTask(plainRoot, "work");
    const policy = createAllSuccessJoinPolicy({ bindingIds: ["binding-1", "binding-2"] });
    if (!policy.ok) throw new Error("policy");
    const eligibility = isAutoProductJoinEligible({
      policy: policy.policy,
      explicit: true,
      parentState: plainRoot,
      parentNodeId: "work",
      parentAttemptId: plainRoot.runtime.nodes.work?.currentAttemptId ?? "attempt-work",
    });
    expect(eligibility.eligible).toBe(false);
    if (eligibility.eligible) throw new Error("expected ineligible");
    expect(eligibility.reason).toMatch(/does not declare boolean produce/);
  });

  it("requires produce for custom resultFactName on auto path", () => {
    let plainRoot = createStartedWorkflow(
      {
        title: "Custom fact no produce",
        goal: "Custom fact no produce",
        nodes: [{
          id: "work",
          title: "Work",
          requires: [],
          acceptance: [],
          scope: { paths: ["src/**"] },
        }],
        loops: [],
        policy: { mode: "guided", requireEvidence: false },
      },
      "workflow-custom-fact",
      "goal-custom-fact",
    );
    plainRoot = startTask(plainRoot, "work");
    const policy = createAllSuccessJoinPolicy({
      bindingIds: ["binding-1", "binding-2"],
      resultFactName: "custom.join.ok",
    });
    if (!policy.ok) throw new Error("policy");
    const eligibility = isAutoProductJoinEligible({
      policy: policy.policy,
      explicit: false,
      parentState: plainRoot,
      parentNodeId: "work",
      parentAttemptId: plainRoot.runtime.nodes.work?.currentAttemptId ?? "attempt-work",
    });
    expect(eligibility.eligible).toBe(false);
    if (eligibility.eligible) throw new Error("expected ineligible");
    expect(eligibility.reason).toMatch(/does not declare boolean produce/);
  });

  it("applies one-child join when an explicit policy is supplied", () => {
    const first = setupAfterFirstChildOnly();
    const policy = createAllSuccessJoinPolicy({
      bindingIds: ["binding-1"],
      expectedBindingCount: 1,
    });
    if (!policy.ok) throw new Error(JSON.stringify(policy.diagnostics));
    const attemptId = first.parentState.runtime.nodes.work?.currentAttemptId;
    expect(attemptId).toBeTruthy();
    const applied = applyProductJoinSynthesis({
      family: first.family,
      parentState: first.parentState,
      policy: policy.policy,
      parentGoalId: "goal-root",
      parentNodeId: "work",
      parentAttemptId: attemptId!,
      at: returnAt,
      commandId: "host-synth-one",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok || applied.status !== "applied") {
      throw new Error(JSON.stringify(applied));
    }
    expect(applied.factPublished).toBe(true);
    expect(applied.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(true);
  });
});

describe("J1 ordinary join default fact without author produce", () => {
  const parentWithoutJoinProduce = (): HypagraphDefinition => ({
    title: "Ordinary parent",
    goal: "Ordinary parent",
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

  const setupOrdinaryTwoChildren = (secondOutcome: "completed" | "failed" = "completed") => {
    let rootState = createStartedWorkflow(parentWithoutJoinProduce(), "workflow-root", "goal-root");
    rootState = startTask(rootState, "work");
    const familyResult = createRootFamily({
      familyId: "family-j1-ordinary",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
      bounds: {
        maxDepth: 3,
        maxChildrenPerGoal: 4,
        maxGoalsInFamily: 16,
        maxChildCreationAttemptsPerNode: 4,
      },
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

    const child1 = createBoundedChildGoal({
      family: familyResult.family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: childTask("Ordinary child one"),
      childGoalId: "goal-child-1",
      childWorkflowId: "workflow-child-1",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
      failurePolicy: "block-parent-node",
    });
    if (!child1.ok) throw new Error(JSON.stringify(child1.diagnostics));

    let family = child1.family;
    let parentState = child1.parentState;
    const return1 = returnChildGoal({
      family,
      parentState,
      childState: terminalCompletedChild(child1.childState),
      bindingId: "binding-1",
      at: returnAt,
      outcome: "completed",
    });
    if (!return1.ok) throw new Error(JSON.stringify(return1.diagnostics));
    family = return1.family;
    parentState = return1.parentState;

    const child2 = createBoundedChildGoal({
      family,
      parentState,
      parentNodeId: "work",
      childDefinition: childTask("Ordinary child two"),
      childGoalId: "goal-child-2",
      childWorkflowId: "workflow-child-2",
      bindingId: "binding-2",
      at: returnAt,
      scopePaths: ["src/**"],
      failurePolicy: "block-parent-node",
    });
    if (!child2.ok) throw new Error(JSON.stringify(child2.diagnostics));
    family = child2.family;
    parentState = child2.parentState;
    const child2State = secondOutcome === "completed"
      ? terminalCompletedChild(child2.childState)
      : terminalFailedChild(child2.childState);
    const return2 = returnChildGoal({
      family,
      parentState,
      childState: child2State,
      bindingId: "binding-2",
      at: joinAt,
      outcome: secondOutcome,
    });
    if (!return2.ok) throw new Error(JSON.stringify(return2.diagnostics));

    // Parent definition must not declare join.passed produce.
    const workNode = return2.parentState.definition.nodes.find((node) => node.id === "work");
    expect(workNode?.produces ?? []).not.toEqual(
      expect.arrayContaining([{ name: DEFAULT_JOIN_RESULT_FACT_NAME, type: "boolean" }]),
    );
    expect(
      (workNode?.produces ?? []).some(
        (contract) => contract.name === DEFAULT_JOIN_RESULT_FACT_NAME,
      ),
    ).toBe(false);

    return {
      family: return2.family,
      parentState: return2.parentState,
    };
  };

  it("publishes join.passed true without author produce after two completed children", () => {
    const setup = setupOrdinaryTwoChildren("completed");
    const attemptId = setup.parentState.runtime.nodes.work?.currentAttemptId;
    expect(attemptId).toBeTruthy();
    expect(setup.parentState.runtime.nodes.work?.status).toBe("running");
    expect(setup.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]).toBeUndefined();

    const applied = applyProductJoinSynthesis({
      family: setup.family,
      parentState: setup.parentState,
      parentGoalId: "goal-root",
      parentNodeId: "work",
      parentAttemptId: attemptId!,
      at: joinAt,
      commandId: "j1-auto-pass",
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
    expect(applied.policy.resultFactName).toBe(DEFAULT_JOIN_RESULT_FACT_NAME);

    // Definition must not gain a produces entry for join.passed.
    const workNode = applied.parentState.definition.nodes.find((node) => node.id === "work");
    expect(
      (workNode?.produces ?? []).some(
        (contract) => contract.name === DEFAULT_JOIN_RESULT_FACT_NAME,
      ),
    ).toBe(false);

    // snapshotHash must match canonical projection of the original stream plus parent events.
    let projected = setup.parentState;
    for (const event of applied.parentEvents) {
      projected = applyEvent(projected, event);
    }
    expect(applied.parentState.snapshotHash).toBe(projected.snapshotHash);
    expect(applied.parentState.definition).toEqual(setup.parentState.definition);
  });

  it("does not append duplicate join.passed events on second apply", () => {
    const setup = setupOrdinaryTwoChildren("completed");
    const attemptId = setup.parentState.runtime.nodes.work?.currentAttemptId;
    expect(attemptId).toBeTruthy();

    const first = applyProductJoinSynthesis({
      family: setup.family,
      parentState: setup.parentState,
      parentGoalId: "goal-root",
      parentNodeId: "work",
      parentAttemptId: attemptId!,
      at: joinAt,
      commandId: "j1-idempotent-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.status !== "applied") {
      throw new Error(JSON.stringify(first));
    }
    const firstFactEvents = first.parentEvents.filter(
      (event) => event.type === "hypagraph.fact.published",
    );
    expect(firstFactEvents).toHaveLength(1);

    const second = applyProductJoinSynthesis({
      family: setup.family,
      parentState: first.parentState,
      parentGoalId: "goal-root",
      parentNodeId: "work",
      parentAttemptId: attemptId!,
      at: joinAt,
      commandId: "j1-idempotent-2",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(JSON.stringify(second));
    expect(second.status).toBe("skipped");
    if (second.status !== "skipped") throw new Error("expected skipped");
    expect(second.reason).toMatch(/already present/);
  });

  it("does not join early on first of two returns without author produce", () => {
    let rootState = createStartedWorkflow(parentWithoutJoinProduce(), "workflow-root", "goal-root");
    rootState = startTask(rootState, "work");
    const familyResult = createRootFamily({
      familyId: "family-j1-first",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
      bounds: {
        maxDepth: 3,
        maxChildrenPerGoal: 4,
        maxGoalsInFamily: 16,
        maxChildCreationAttemptsPerNode: 4,
      },
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));
    const child1 = createBoundedChildGoal({
      family: familyResult.family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: childTask("First only"),
      childGoalId: "goal-child-1",
      childWorkflowId: "workflow-child-1",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
      failurePolicy: "block-parent-node",
    });
    if (!child1.ok) throw new Error(JSON.stringify(child1.diagnostics));
    const return1 = returnChildGoal({
      family: child1.family,
      parentState: child1.parentState,
      childState: terminalCompletedChild(child1.childState),
      bindingId: "binding-1",
      at: returnAt,
      outcome: "completed",
    });
    if (!return1.ok) throw new Error(JSON.stringify(return1.diagnostics));

    const ready = applyReadyJoinSynthesesAfterReturns({
      family: return1.family,
      parentState: return1.parentState,
      parentGoalId: "goal-root",
      at: returnAt,
    });
    expect(ready.ok).toBe(true);
    expect(ready.applied).toHaveLength(0);
    expect(ready.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]).toBeUndefined();
  });

  it("publishes join.passed false and blocks when join fails without author produce", () => {
    // Build two completed bindings, then force a failed evaluation so the parent
    // stays running (child failure policy would block first on a real fail return).
    const setup = setupOrdinaryTwoChildren("completed");
    const policy = createAllSuccessJoinPolicy({ bindingIds: ["binding-1", "binding-2"] });
    if (!policy.ok) throw new Error(JSON.stringify(policy.diagnostics));
    const failedEval = evaluateChildOutcomeSynthesis(
      policy.policy,
      [
        { bindingId: "binding-1", terminal: true, outcome: "completed" },
        { bindingId: "binding-2", terminal: true, outcome: "failed" },
      ],
    );
    expect(failedEval.ok).toBe(true);
    if (!failedEval.ok) throw new Error("expected failed eval");
    const attemptId = setup.parentState.runtime.nodes.work?.currentAttemptId;
    expect(attemptId).toBeTruthy();

    const applied = applyChildOutcomeSynthesisToParent({
      parentState: setup.parentState,
      policy: policy.policy,
      result: failedEval.result,
      parentNodeId: "work",
      parentAttemptId: attemptId!,
      at: joinAt,
      commandId: "j1-fail-host-default",
      allowHostDefaultJoinFact: true,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error(JSON.stringify(applied.diagnostics));
    expect(applied.factPublished).toBe(true);
    expect(applied.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(false);
    expect(applied.parentState.runtime.nodes.work?.status).toBe("blocked");
    const workNode = applied.parentState.definition.nodes.find((node) => node.id === "work");
    expect(
      (workNode?.produces ?? []).some(
        (contract) => contract.name === DEFAULT_JOIN_RESULT_FACT_NAME,
      ),
    ).toBe(false);

    // Host-default fail path must also keep snapshotHash canonical.
    let projected = setup.parentState;
    for (const event of applied.parentEvents) {
      projected = applyEvent(projected, event);
    }
    expect(applied.parentState.snapshotHash).toBe(projected.snapshotHash);
  });

  it("publishes join.passed false via product path when a binding failed", () => {
    // Two completed returns keep the parent running. Patch one binding to failed
    // so product apply sees a failed join without child failure policy blocking first.
    const setup = setupOrdinaryTwoChildren("completed");
    const family = structuredClone(setup.family);
    const binding2 = family.bindings["binding-2"];
    if (!binding2?.returnRecord) throw new Error("expected binding-2 return record");
    family.bindings["binding-2"] = {
      ...binding2,
      status: "failed",
      returnRecord: {
        ...binding2.returnRecord,
        outcome: "failed",
        parentEffect: "blocked",
        stopReason: "Forced failed outcome for product join fail path.",
      },
    };

    const attemptId = setup.parentState.runtime.nodes.work?.currentAttemptId;
    expect(attemptId).toBeTruthy();
    expect(setup.parentState.runtime.nodes.work?.status).toBe("running");

    const applied = applyProductJoinSynthesis({
      family,
      parentState: setup.parentState,
      parentGoalId: "goal-root",
      parentNodeId: "work",
      parentAttemptId: attemptId!,
      at: joinAt,
      commandId: "j1-product-fail",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok || applied.status !== "applied") {
      throw new Error(JSON.stringify(applied));
    }
    expect(applied.result.status).toBe("failed");
    expect(applied.factPublished).toBe(true);
    expect(applied.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]?.value).toBe(false);
    expect(applied.parentState.runtime.nodes.work?.status).toBe("blocked");
    expect(applied.parentMutated).toBe(true);

    let projected = setup.parentState;
    for (const event of applied.parentEvents) {
      projected = applyEvent(projected, event);
    }
    expect(applied.parentState.snapshotHash).toBe(projected.snapshotHash);
  });

  it("skips host-default publish when join.passed is declared as non-boolean", () => {
    const parentWithStringJoin: HypagraphDefinition = {
      title: "Non-boolean join produce",
      goal: "Non-boolean join produce",
      nodes: [{
        id: "work",
        title: "Work",
        requires: [],
        acceptance: [],
        scope: { paths: ["src/**"] },
        produces: [{ name: DEFAULT_JOIN_RESULT_FACT_NAME, type: "string" }],
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };

    let rootState = createStartedWorkflow(parentWithStringJoin, "workflow-root-nb", "goal-root-nb");
    rootState = startTask(rootState, "work");
    const familyResult = createRootFamily({
      familyId: "family-j1-nonboolean",
      rootGoalId: "goal-root-nb",
      rootWorkflowId: "workflow-root-nb",
      at,
      bounds: {
        maxDepth: 3,
        maxChildrenPerGoal: 4,
        maxGoalsInFamily: 16,
        maxChildCreationAttemptsPerNode: 4,
      },
    });
    if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));

    const child1 = createBoundedChildGoal({
      family: familyResult.family,
      parentState: rootState,
      parentNodeId: "work",
      childDefinition: childTask("NB child one"),
      childGoalId: "goal-child-nb-1",
      childWorkflowId: "workflow-child-nb-1",
      bindingId: "binding-1",
      at: later,
      scopePaths: ["src/**"],
      failurePolicy: "block-parent-node",
    });
    if (!child1.ok) throw new Error(JSON.stringify(child1.diagnostics));
    const return1 = returnChildGoal({
      family: child1.family,
      parentState: child1.parentState,
      childState: terminalCompletedChild(child1.childState),
      bindingId: "binding-1",
      at: returnAt,
      outcome: "completed",
    });
    if (!return1.ok) throw new Error(JSON.stringify(return1.diagnostics));

    const child2 = createBoundedChildGoal({
      family: return1.family,
      parentState: return1.parentState,
      parentNodeId: "work",
      childDefinition: childTask("NB child two"),
      childGoalId: "goal-child-nb-2",
      childWorkflowId: "workflow-child-nb-2",
      bindingId: "binding-2",
      at: returnAt,
      scopePaths: ["src/**"],
      failurePolicy: "block-parent-node",
    });
    if (!child2.ok) throw new Error(JSON.stringify(child2.diagnostics));
    const return2 = returnChildGoal({
      family: child2.family,
      parentState: child2.parentState,
      childState: terminalCompletedChild(child2.childState),
      bindingId: "binding-2",
      at: joinAt,
      outcome: "completed",
    });
    if (!return2.ok) throw new Error(JSON.stringify(return2.diagnostics));

    const attemptId = return2.parentState.runtime.nodes.work?.currentAttemptId;
    expect(attemptId).toBeTruthy();

    const policy = createAllSuccessJoinPolicy({ bindingIds: ["binding-1", "binding-2"] });
    if (!policy.ok) throw new Error(JSON.stringify(policy.diagnostics));
    const eligibility = isAutoProductJoinEligible({
      policy: policy.policy,
      explicit: false,
      parentState: return2.parentState,
      parentNodeId: "work",
      parentAttemptId: attemptId!,
    });
    expect(eligibility.eligible).toBe(false);
    if (eligibility.eligible) throw new Error("expected ineligible for non-boolean produce");
    expect(eligibility.reason).toMatch(/non-boolean type/);

    const product = applyProductJoinSynthesis({
      family: return2.family,
      parentState: return2.parentState,
      parentGoalId: "goal-root-nb",
      parentNodeId: "work",
      parentAttemptId: attemptId!,
      at: joinAt,
      commandId: "j1-nonboolean",
    });
    expect(product.ok).toBe(true);
    if (!product.ok) throw new Error(JSON.stringify(product));
    expect(product.status).toBe("skipped");
    if (product.status !== "skipped") throw new Error("expected skipped");
    expect(product.reason).toMatch(/non-boolean type/);
    expect(return2.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]).toBeUndefined();
  });

  it("does not publish custom undeclared resultFactName on domain apply", () => {
    const setup = setupOrdinaryTwoChildren("completed");
    const policy = createAllSuccessJoinPolicy({
      bindingIds: ["binding-1", "binding-2"],
      resultFactName: "custom.join.ok",
    });
    if (!policy.ok) throw new Error(JSON.stringify(policy.diagnostics));
    const passed = evaluateChildOutcomeSynthesis(
      policy.policy,
      [
        { bindingId: "binding-1", terminal: true, outcome: "completed" },
        { bindingId: "binding-2", terminal: true, outcome: "completed" },
      ],
    );
    expect(passed.ok).toBe(true);
    if (!passed.ok) throw new Error("expected pass eval");
    const attemptId = setup.parentState.runtime.nodes.work?.currentAttemptId;
    expect(attemptId).toBeTruthy();

    const applied = applyChildOutcomeSynthesisToParent({
      parentState: setup.parentState,
      policy: policy.policy,
      result: passed.result,
      parentNodeId: "work",
      parentAttemptId: attemptId!,
      at: joinAt,
      commandId: "j1-custom-no-publish",
      allowHostDefaultJoinFact: true,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error(JSON.stringify(applied.diagnostics));
    expect(applied.factPublished).toBe(false);
    expect(applied.parentState.runtime.facts["custom.join.ok"]).toBeUndefined();
    expect(applied.parentState.runtime.facts[DEFAULT_JOIN_RESULT_FACT_NAME]).toBeUndefined();
  });
});


