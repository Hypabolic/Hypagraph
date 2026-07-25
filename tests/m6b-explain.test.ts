import { describe, expect, it } from "vitest";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { CheckResult, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { handleCommand } from "../src/domain/reducer.js";
import { explainGoal, explainNode } from "../src/history/explain.js";

const at = "2026-07-25T19:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Explanation coverage",
  goal: "Explain each canonical decision",
  nodes: [
    { id: "plan", title: "Plan the change", requires: [], acceptance: [] },
    {
      id: "tests",
      title: "Run tests",
      kind: "check",
      requires: ["plan"],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "npm",
        arguments: ["test"],
        timeoutMs: 60_000,
        publish: [{ source: "passed", fact: "tests.passed" }],
      },
    },
    {
      id: "route",
      title: "Select the route",
      kind: "gate",
      requires: ["tests"],
      acceptance: [],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "tests.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["ship"],
        onFalse: ["repair"],
      },
    },
    { id: "ship", title: "Ship the change", requires: ["route"], acceptance: [] },
    { id: "repair", title: "Repair the change", requires: ["route"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const create = (source: HypagraphDefinition = definition(), workflowId = "explain-workflow") => {
  const result = createHypagoalWorkflow(source, {
    workflowId,
    goalId: "explain-goal",
    goalWorkflowId: workflowId,
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const apply = (state: HypagraphState, command: Parameters<typeof handleCommand>[1]): HypagraphState => {
  const reduced = handleCommand(state, command);
  if (!reduced.ok) throw new Error(JSON.stringify(reduced.diagnostics));
  return reduced.state;
};

const checkResult = (attemptId: string, status: CheckResult["status"]): CheckResult => ({
  checkKind: "command",
  attemptId,
  startedAt: at,
  completedAt: at,
  status,
  exitCode: status === "passed" ? 0 : 1,
  facts: [],
  evidence: [],
  ...(status === "passed" ? {} : { error: "The check failed." }),
});

const completeTask = (state: HypagraphState, nodeId: string, attemptId: string): HypagraphState => {
  let next = apply(state, { type: "start-node", nodeId, attemptId, commandId: `start-${nodeId}`, at });
  next = apply(next, { type: "submit-result", nodeId, attemptId, evidence: [], commandId: `submit-${nodeId}`, at });
  next = apply(next, { type: "begin-verification", nodeId, attemptId, commandId: `begin-${nodeId}`, at });
  return apply(next, { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `verify-${nodeId}`, at });
};

const runCheck = (state: HypagraphState, nodeId: string, attemptId: string, status: CheckResult["status"]): HypagraphState => {
  let next = apply(state, { type: "start-check", nodeId, attemptId, commandId: `start-${attemptId}`, at });
  next = apply(next, {
    type: "publish-facts",
    nodeId,
    attemptId,
    facts: [{ name: "tests.passed", type: "boolean", value: status === "passed" }],
    commandId: `publish-${attemptId}`,
    at,
  });
  next = apply(next, {
    type: "record-check-result",
    nodeId,
    attemptId,
    result: checkResult(attemptId, status),
    commandId: `record-${attemptId}`,
    at,
  });
  next = apply(next, { type: "begin-verification", nodeId, attemptId, commandId: `begin-${attemptId}`, at });
  return apply(next, {
    type: "complete-verification",
    nodeId,
    attemptId,
    passed: status === "passed",
    ...(status === "passed" ? {} : { reason: "The check failed." }),
    commandId: `verify-${attemptId}`,
    at,
  });
};

describe("M6B Slice 3 decision explanation", () => {
  it("reports a runnable node and its scheduler action", () => {
    const created = create();
    const explanation = explainNode(created.state, "plan");

    expect(explanation).toMatchObject({
      nodeId: "plan",
      status: "ready",
      kind: "task",
      reason: { kind: "runnable", action: "start-ready-task" },
    });
    expect(explanation.summary).toBe("Node 'plan' is runnable. The scheduler can select it as 'start-ready-task'.");
  });

  it("reports the unsatisfied dependencies of a pending node by ID", () => {
    const created = create();
    const explanation = explainNode(created.state, "route");

    expect(explanation.reason).toEqual({
      kind: "dependency",
      blockedBy: [{ nodeId: "tests", status: "pending" }],
    });
    expect(explanation.summary).toBe("Node 'route' waits for its dependencies: 'tests' is pending.");
  });

  it("reports the gate and the outcome which skipped a node", () => {
    const created = create();
    let state = completeTask(created.state, "plan", "plan-1");
    state = runCheck(state, "tests", "tests-1", "passed");
    state = apply(state, { type: "evaluate-gate", nodeId: "route", commandId: "evaluate-route", at });

    expect(state.runtime.nodes.repair?.status).toBe("skipped");
    const explanation = explainNode(state, "repair");
    expect(explanation.reason).toEqual({ kind: "skipped-route", gateNodeId: "route", outcomeId: "true" });
    expect(explanation.summary).toBe("Node 'repair' was skipped, because gate 'route' selected outcome 'true'.");
  });

  it("reports the canonical check-policy code when a check cannot retry", () => {
    const source = definition();
    const created = create(source, "explain-retry-workflow");
    let state = completeTask(created.state, "plan", "plan-1");
    state = runCheck(state, "tests", "tests-1", "failed");

    expect(state.runtime.nodes.tests?.status).toBe("failed");
    const explanation = explainNode(state, "tests");
    expect(explanation.reason).toMatchObject({ kind: "check-policy", code: "check_retry_not_allowed" });
    expect(explanation.summary).toContain("Check 'tests' cannot start: check_retry_not_allowed");
  });

  it("reports the loop and the exit reason for a node in an exhausted loop", () => {
    const source: HypagraphDefinition = {
      title: "Exhausted loop",
      goal: "Explain an exhausted iteration region",
      nodes: [
        { id: "refine", title: "Refine", requires: ["assess"], acceptance: [] },
        {
          id: "assess",
          title: "Assess",
          kind: "check",
          requires: ["refine"],
          acceptance: [],
          produces: [{ name: "tests.passed", type: "boolean", required: true }],
          check: {
            kind: "command",
            command: "npm",
            arguments: ["test"],
            timeoutMs: 60_000,
            publish: [{ source: "passed", fact: "tests.passed" }],
          },
        },
      ],
      loops: [{
        id: "refine-loop",
        nodes: ["refine", "assess"],
        entry: "refine",
        evaluateAfter: "assess",
        feedbackEdges: [{ from: "assess", to: "refine" }],
        successWhen: {
          kind: "compare",
          left: { kind: "fact", name: "tests.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        maxIterations: 1,
        failurePolicy: "record-and-continue",
      }],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = create(source, "explain-loop-workflow");
    let state = completeTask(created.state, "refine", "refine-1");
    state = runCheck(state, "assess", "assess-1", "failed");

    expect(state.runtime.loops["refine-loop"]).toMatchObject({ status: "failed", exitReason: "max_iterations" });
    const explanation = explainNode(state, "refine");
    expect(explanation.reason).toMatchObject({
      kind: "loop-not-running",
      loopId: "refine-loop",
      status: "failed",
      exitReason: "max_iterations",
    });
    expect(explanation.summary)
      .toBe("Node 'refine' belongs to loop 'refine-loop', which is failed through max_iterations.");
  });

  it("reports a terminal node and an unknown node", () => {
    const created = create();
    const state = completeTask(created.state, "plan", "plan-1");

    expect(explainNode(state, "plan").reason).toEqual({ kind: "terminal", status: "succeeded" });
    expect(explainNode(state, "absent")).toMatchObject({
      status: "absent",
      reason: { kind: "unknown-node" },
      summary: "The workflow has no node 'absent'.",
    });
  });

  it("reports a blocked node with its canonical blocker", () => {
    const created = create();
    const state = apply(created.state, {
      type: "block-node",
      nodeId: "plan",
      reason: "A bounded release note is missing.",
      blockerKind: "repository-work",
      commandId: "block-plan",
      at,
    });

    expect(explainNode(state, "plan").reason).toEqual({
      kind: "blocked",
      reason: "A bounded release note is missing.",
      blockerKind: "repository-work",
    });
  });

  it("reports that a stopped goal prevents work", () => {
    const created = create();
    const state = apply(created.state, {
      type: "pause-goal",
      reason: "The user paused the goal.",
      commandId: "pause-goal",
      at,
    });

    const explanation = explainNode(state, "plan");
    expect(explanation.reason).toMatchObject({ kind: "goal-stopped", status: "paused" });
    expect(explanation.summary).toContain("because the goal is paused");
  });

  it("explains the canonical goal decision and lists the runnable nodes", () => {
    const created = create();
    const explanation = explainGoal(created.state);

    expect(explanation).toMatchObject({
      goalStatus: "active",
      decision: "start-ready-task",
      runnableNodeIds: ["plan"],
    });
    expect(explanation.summary).toBe("The scheduler selects 'start-ready-task' for node 'plan'.");
    expect(explanation.blockage.kind).toBe("not-blocked");
  });

  it("explains a completed goal", () => {
    const created = create();
    let state = completeTask(created.state, "plan", "plan-1");
    state = runCheck(state, "tests", "tests-1", "passed");
    state = apply(state, { type: "evaluate-gate", nodeId: "route", commandId: "evaluate-route", at });
    state = completeTask(state, "ship", "ship-1");

    expect(state.goal?.status).toBe("completed");
    const explanation = explainGoal(state);
    expect(explanation).toMatchObject({ goalStatus: "completed", decision: "stop-completed", runnableNodeIds: [] });
    expect(explanation.summary).toBe("The canonical workflow completed.");
  });

  it("does not expose protected evaluator detail in an explanation", () => {
    const source: HypagraphDefinition = {
      title: "Protected explanation",
      goal: "Hide evaluator detail in an explanation",
      nodes: [{
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
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = create(source, "explain-protected-workflow");
    const explanation = explainNode(created.state, "evaluate");

    expect(explanation.summary).not.toContain("--secret-suite");
    expect(explanation.summary).not.toContain("protected/evaluate.json");
    expect(explanation.reason).toMatchObject({ kind: "runnable", action: "run-ready-check" });
  });
});
