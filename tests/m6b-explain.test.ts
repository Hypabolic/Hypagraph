import { describe, expect, it } from "vitest";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { CheckResult, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { handleCommand } from "../src/domain/reducer.js";
import { explainGoal, explainNode } from "../src/history/explain.js";
import { PROTECTED_REASON } from "../src/domain/evaluation-presentation.js";
import { PROTECTED_DETAIL } from "../src/domain/presentation-redaction.js";
import { classifyGoalBlockage } from "../src/domain/goal-blockage.js";
import { isDispatchableGoalContinuation, selectGoalContinuation } from "../src/domain/goal-continuation.js";
import { renderExplanation } from "../src/ui/history-surface.js";
import {
  projectGoalControlSurface,
  projectHypagoalSurface,
  renderHypagoalLifecycleMessage,
  renderHypagoalStatus,
} from "../src/ui/hypagoal-surface.js";
import { projectModelVisibleWorkflowSummary } from "../src/pi/model-visible-state.js";
import { projectGraphView } from "../src/graph/projection.js";
import { replayToSequence } from "../src/history/replay.js";
import { renderReplayAtSequence } from "../src/ui/history-surface.js";
import { renderWorkflow, workflowSummary } from "../src/ui/format.js";

const protectedSourceForReplay = (): HypagraphDefinition => ({
  title: "Protected evaluator replay",
  goal: "Hide protected evaluator detail in replay",
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

describe("M6B protected evaluator redaction in explanations", () => {
  const SENTINEL = "holdout case 'internal-case-7' failed in protected/evaluate.json via --secret-suite";

  const protectedSource = (): HypagraphDefinition => ({
    title: "Protected evaluator blockage",
    goal: "Never repeat protected evaluator detail",
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

  /** Block the protected evaluator with a reason which repeats evaluator detail. */
  const blockedFixture = (blockerKind: "repository-work" | "safeguard" = "repository-work") => {
    const created = create(protectedSource(), "protected-blocked-workflow");
    const state = apply(created.state, {
      type: "block-node",
      nodeId: "evaluate",
      reason: SENTINEL,
      blockerKind,
      commandId: "block-evaluate",
      at,
    });
    return { created, state };
  };

  it("replaces a protected blocker reason in explainNode", () => {
    const value = blockedFixture();
    // Canonical state keeps the exact text, because the revision identity binds to it.
    expect(value.state.runtime.nodes.evaluate?.blockedReason).toBe(SENTINEL);

    const explanation = explainNode(value.state, "evaluate");
    expect(explanation.redacted).toBe(true);
    expect(explanation.reason).toEqual({
      kind: "blocked",
      reason: PROTECTED_REASON,
      blockerKind: "repository-work",
    });
    expect(JSON.stringify(explanation)).not.toContain("internal-case-7");
    expect(JSON.stringify(explanation)).not.toContain("--secret-suite");
    expect(JSON.stringify(explanation)).not.toContain("protected/evaluate.json");
  });

  it("keeps an unprotected blocker reason readable", () => {
    const created = create(definition(), "unprotected-blocked-workflow");
    const state = apply(created.state, {
      type: "block-node",
      nodeId: "plan",
      reason: "A bounded release note is missing.",
      blockerKind: "repository-work",
      commandId: "block-plan",
      at,
    });

    const explanation = explainNode(state, "plan");
    expect(explanation.redacted).toBe(false);
    expect(explanation.reason).toMatchObject({ reason: "A bounded release note is missing." });
  });

  it("replaces the protected blocker reason in the goal blockage and the stop decision", () => {
    const value = blockedFixture("safeguard");
    const goal = explainGoal(value.state);

    expect(goal.blockageRedacted).toBe(true);
    expect(JSON.stringify(goal)).not.toContain("internal-case-7");
    expect(JSON.stringify(goal)).not.toContain("--secret-suite");
    expect(JSON.stringify(goal)).not.toContain("protected/evaluate.json");
    if (goal.blockage.kind === "not-blocked") throw new Error("Expected a blocked goal.");
    expect(goal.blockage.blocker.reason).toBe(PROTECTED_REASON);
    // The blocker identity fields stay canonical, so the revision decision is unchanged.
    expect(goal.blockage.blocker.id).toBe("evaluate");
    expect(goal.blockage.blocker.kind).toBe("terminal-policy");
  });

  it("keeps the canonical blocker reason for the reducer", () => {
    const value = blockedFixture();
    // The presentation copy must not change what the reducer classifies.
    const canonical = classifyGoalBlockage(value.state);
    if (canonical.kind === "not-blocked") throw new Error("Expected a blocked goal.");
    expect(canonical.blocker.reason).toBe(SENTINEL);
  });

  it("does not expose protected detail through the rendered explain surfaces", () => {
    const value = blockedFixture();

    const node = renderExplanation(value.state, "evaluate");
    const all = renderExplanation(value.state);
    for (const rendered of [node, all]) {
      expect(rendered).not.toContain("internal-case-7");
      expect(rendered).not.toContain("--secret-suite");
      expect(rendered).not.toContain("protected/evaluate.json");
    }
    expect(node).toContain(PROTECTED_REASON);
  });

  it("does not expose protected detail through the Hypagoal status surface", () => {
    const value = blockedFixture();
    const surface = projectHypagoalSurface(value.state)!;
    const status = renderHypagoalStatus(value.state, 110);
    const lifecycle = renderHypagoalLifecycleMessage(value.state);
    const summary = JSON.stringify(projectModelVisibleWorkflowSummary(value.state));

    for (const rendered of [JSON.stringify(surface), status, lifecycle, summary]) {
      expect(rendered).not.toContain("internal-case-7");
      expect(rendered).not.toContain("--secret-suite");
      expect(rendered).not.toContain("protected/evaluate.json");
    }
  });

  it("does not expose a protected check-result failure reason", () => {
    const created = create(protectedSource(), "protected-failed-workflow");
    let state = apply(created.state, {
      type: "start-check",
      nodeId: "evaluate",
      attemptId: "evaluate-1",
      commandId: "start-evaluate",
      at,
    });
    state = apply(state, {
      type: "record-check-result",
      nodeId: "evaluate",
      attemptId: "evaluate-1",
      result: {
        checkKind: "metric-report",
        attemptId: "evaluate-1",
        startedAt: at,
        completedAt: at,
        status: "failed",
        exitCode: 1,
        facts: [],
        evidence: [],
        error: SENTINEL,
        stdoutRef: "artifact://protected-stdout",
      },
      commandId: "record-evaluate",
      at,
    });
    state = apply(state, { type: "begin-verification", nodeId: "evaluate", attemptId: "evaluate-1", commandId: "begin-evaluate", at });
    state = apply(state, {
      type: "complete-verification",
      nodeId: "evaluate",
      attemptId: "evaluate-1",
      passed: false,
      reason: SENTINEL,
      commandId: "verify-evaluate",
      at,
    });

    const explanation = explainNode(state, "evaluate");
    const rendered = [
      JSON.stringify(explanation),
      renderExplanation(state, "evaluate"),
      renderExplanation(state),
      renderHypagoalStatus(state, 110),
      JSON.stringify(explainGoal(state)),
    ];
    for (const value of rendered) {
      expect(value).not.toContain("internal-case-7");
      expect(value).not.toContain("--secret-suite");
      expect(value).not.toContain("protected/evaluate.json");
      expect(value).not.toContain("protected-stdout");
    }
  });
});

describe("M6B pending check dependency explanation", () => {
  it("reports the unsatisfied dependency of a pending check, not a check-policy code", () => {
    const created = create();
    // 'tests' requires 'plan', which has not run.
    expect(created.state.runtime.nodes.tests?.status).toBe("pending");

    const explanation = explainNode(created.state, "tests");
    expect(explanation.reason).toEqual({
      kind: "dependency",
      blockedBy: [{ nodeId: "plan", status: "ready" }],
    });
    expect(explanation.summary).toBe("Node 'tests' waits for its dependencies: 'plan' is ready.");
  });

  it("still reports the check-policy code once the dependency is satisfied", () => {
    const created = create();
    let state = completeTask(created.state, "plan", "plan-1");
    state = runCheck(state, "tests", "tests-1", "failed");

    const explanation = explainNode(state, "tests");
    expect(explanation.reason).toMatchObject({ kind: "check-policy", code: "check_retry_not_allowed" });
  });

  it("reports a ready check as runnable", () => {
    const created = create();
    const state = completeTask(created.state, "plan", "plan-1");
    expect(state.runtime.nodes.tests?.status).toBe("ready");
    expect(explainNode(state, "tests").reason).toEqual({ kind: "runnable", action: "run-ready-check" });
  });
});

describe("M6B protected redaction through replay and the loop surface", () => {
  const SENTINEL = "holdout case 'internal-case-7' failed in protected/evaluate.json via --secret-suite";

  const leak = (value: string) => {
    expect(value).not.toContain("internal-case-7");
    expect(value).not.toContain("--secret-suite");
    expect(value).not.toContain("protected/evaluate.json");
  };

  const protectedLoopSource = (): HypagraphDefinition => ({
    title: "Protected loop blockage",
    goal: "Hide protected loop detail",
    nodes: [
      { id: "refine", title: "Refine", requires: ["evaluate"], acceptance: [] },
      {
        id: "evaluate",
        title: "Evaluate quality",
        kind: "check",
        requires: ["refine"],
        acceptance: [],
        produces: [{ name: "evaluate.accepted", type: "boolean", required: true }],
        check: {
          kind: "metric-report",
          command: "protected-evaluator",
          arguments: ["--secret-suite"],
          timeoutMs: 30_000,
          reportPath: "protected/evaluate.json",
          parser: { name: "metric-json", version: 1 },
          mappings: [{ source: "accepted", fact: "evaluate.accepted", type: "boolean", required: true }],
          evaluation: { kind: "holdout", feedback: { mode: "aggregate" } },
        },
      },
    ],
    loops: [{
      id: "quality",
      nodes: ["refine", "evaluate"],
      entry: "refine",
      evaluateAfter: "evaluate",
      feedbackEdges: [{ from: "evaluate", to: "refine" }],
      successWhen: {
        kind: "compare",
        left: { kind: "fact", name: "evaluate.accepted" },
        operator: "eq",
        right: { kind: "literal", value: true },
      },
      maxIterations: 2,
      failurePolicy: "block-dependants",
    }],
    policy: { mode: "guided", requireEvidence: false },
  });

  it("does not leak a protected blockage through a replayed sequence", () => {
    const created = create(protectedSourceForReplay(), "replay-protected-workflow");
    const events = [...created.events];
    const blocked = handleCommand(created.state, {
      type: "block-node",
      nodeId: "evaluate",
      reason: SENTINEL,
      blockerKind: "repository-work",
      commandId: "block-evaluate",
      at,
    });
    if (!blocked.ok) throw new Error(JSON.stringify(blocked.diagnostics));
    events.push(...blocked.events);

    // The replay surface renders a historical state through the same live projection.
    for (const event of events) {
      const replay = replayToSequence(events, event.sequence);
      leak(renderWorkflow(replay.state));
      leak(JSON.stringify(projectGraphView(replay.state)));
      leak(JSON.stringify(projectModelVisibleWorkflowSummary(replay.state)));
    }
    leak(renderReplayAtSequence(events, blocked.state, blocked.state.sequence));
  });

  it("does not leak a protected loop blocked reason through the model-visible summary", () => {
    const created = create(protectedLoopSource(), "protected-loop-workflow");
    const state = created.state;
    // Inject the canonical loop blocker text which the block-dependants policy would store.
    const mutated: HypagraphState = structuredClone(state);
    mutated.runtime.loops.quality = {
      ...mutated.runtime.loops.quality!,
      status: "blocked",
      blockedReason: SENTINEL,
    };

    leak(JSON.stringify(projectModelVisibleWorkflowSummary(mutated)));
    leak(JSON.stringify(projectHypagoalSurface(mutated)));
    leak(renderWorkflow(mutated));
    leak(JSON.stringify(projectGraphView(mutated)));
  });
});

describe("M6B goal control presentation projection", () => {
  it("publishes a named field list, so a later canonical field does not leak by default", () => {
    const created = create();
    const surface = projectGoalControlSurface(created.state)!;

    // Every published key is named by the projection. A new canonical field is absent
    // until this list adds it.
    expect(Object.keys(surface).sort()).toEqual([
      "actionDispatch",
      "automaticRevision",
      "budget",
      "continuationOrdinal",
      "goalId",
      "schedulerOrdinal",
      "startedAt",
      "status",
      "updatedAt",
      "workflowId",
    ]);
    expect(surface.goalId).toBe("explain-goal");
    expect(surface.status).toBe("active");
  });

  it("does not publish an unknown canonical field", () => {
    const created = create();
    const mutated: HypagraphState = structuredClone(created.state);
    // Simulate a canonical field which a later milestone adds.
    (mutated.goal as unknown as Record<string, unknown>).futureSecretField = "internal-case-7";

    const surface = projectGoalControlSurface(mutated)!;
    expect(JSON.stringify(surface)).not.toContain("internal-case-7");
    expect(Object.keys(surface)).not.toContain("futureSecretField");
    expect(JSON.stringify(projectModelVisibleWorkflowSummary(mutated))).not.toContain("futureSecretField");
  });
});

describe("M6B protected blocker in a recorded automatic revision", () => {
  const SENTINEL = "holdout case 'internal-case-7' failed in protected/evaluate.json via --secret-suite";

  const leak = (value: string) => {
    expect(value).not.toContain("internal-case-7");
    expect(value).not.toContain("--secret-suite");
    expect(value).not.toContain("protected/evaluate.json");
  };

  const protectedRevisionSource = (): HypagraphDefinition => ({
    title: "Protected evaluator revision",
    goal: "Hide protected evaluator detail in a recorded revision attempt",
    nodes: [
      {
        id: "evaluate",
        title: "Evaluate quality",
        kind: "check",
        requires: [],
        acceptance: ["Record the evaluation"],
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
      { id: "publish", title: "Publish the result", requires: ["evaluate"], acceptance: ["Record the publication"] },
    ],
    loops: [],
    policy: { mode: "strict", requireEvidence: true },
  });

  /** Block the protected evaluator, then store the durable automatic revision request. */
  const requestedRevision = () => {
    const created = create(protectedRevisionSource(), "protected-revision-workflow");
    const blocked = apply(created.state, {
      type: "block-node",
      nodeId: "evaluate",
      reason: SENTINEL,
      blockerKind: "repository-work",
      commandId: "block-evaluate",
      at,
    });

    const selected = selectGoalContinuation(blocked);
    if (!isDispatchableGoalContinuation(selected) || selected.kind !== "request-revision") {
      throw new Error(`Unexpected decision: ${selected.kind}`);
    }
    const state = apply(blocked, {
      type: "request-goal-continuation",
      goalId: selected.goalId,
      workflowId: selected.workflowId,
      expectedRevision: selected.revision,
      expectedSequence: selected.sequence,
      expectedSnapshotHash: selected.snapshotHash,
      expectedContinuationOrdinal: selected.continuationOrdinal,
      sessionGeneration: 1,
      branchGeneration: 2,
      action: { kind: "request-revision", blocker: selected.blocker },
      commandId: "revision-operation",
      at,
    });
    return { created, state };
  };

  it("keeps the recorded revision blocker canonical, so the identity match is unchanged", () => {
    const value = requestedRevision();
    const lastAttempt = value.state.goal?.automaticRevision.lastAttempt;

    // The reducer binds the bounded revision to the exact blocker reason. Canonical state
    // must hold the unchanged text.
    expect(lastAttempt).toMatchObject({ outcome: "pending", blocker: { id: "evaluate", reason: SENTINEL } });
    expect(value.state.goal?.pendingContinuation?.action).toMatchObject({
      kind: "request-revision",
      blocker: { reason: SENTINEL },
    });
  });

  it("replaces the recorded revision blocker in the model-visible summary", () => {
    const value = requestedRevision();
    const summary = projectModelVisibleWorkflowSummary(value.state) as {
      goalControl?: {
        automaticRevision: { lastAttempt?: { blocker?: { id: string; reason: string } } };
        pendingContinuation?: { action: { blocker?: { reason: string } } };
      };
    };

    const blocker = summary.goalControl?.automaticRevision.lastAttempt?.blocker;
    expect(blocker?.reason).toBe(PROTECTED_DETAIL);
    // The identity fields stay readable, so a reader still knows which node blocks the goal.
    expect(blocker?.id).toBe("evaluate");
    expect(summary.goalControl?.pendingContinuation?.action.blocker?.reason).toBe(PROTECTED_DETAIL);
    leak(JSON.stringify(summary));
  });

  it("replaces the recorded revision blocker on every other reader surface", () => {
    const value = requestedRevision();

    leak(JSON.stringify(workflowSummary(value.state)));
    leak(renderWorkflow(value.state));
    leak(JSON.stringify(projectHypagoalSurface(value.state)));
    leak(renderHypagoalStatus(value.state, 110));
    leak(renderHypagoalLifecycleMessage(value.state));
    leak(JSON.stringify(projectGraphView(value.state)));
    leak(JSON.stringify(explainGoal(value.state)));
    leak(renderExplanation(value.state));
  });

  it("replaces the recorded revision blocker after the proposal is rejected", () => {
    const value = requestedRevision();
    const pending = value.state.goal!.pendingContinuation!;
    if (pending.action.kind !== "request-revision") throw new Error("Expected a revision action.");
    const proposal = structuredClone(value.state.definition);
    // A changed objective is rejected byte-for-byte, so the attempt records a failure reason.
    proposal.goal += " ";

    const rejected = apply(value.state, {
      type: "apply-goal-revision",
      goalId: value.state.goal!.goalId,
      workflowId: value.state.workflowId,
      expectedRevision: value.state.revision,
      expectedSequence: value.state.sequence,
      expectedSnapshotHash: value.state.snapshotHash,
      revisionOperationId: pending.operationId,
      continuationOperationId: pending.operationId,
      continuationOrdinal: pending.ordinal,
      requestSequence: pending.requestSequence,
      sessionGeneration: pending.sessionGeneration,
      branchGeneration: pending.branchGeneration,
      blocker: pending.action.blocker,
      definition: proposal,
      commandId: "apply-revision",
      at,
    });

    expect(rejected.goal?.automaticRevision.lastAttempt).toMatchObject({
      outcome: "rejected",
      outcomeCode: "automatic_revision_objective_changed",
      blocker: { reason: SENTINEL },
    });

    leak(JSON.stringify(projectModelVisibleWorkflowSummary(rejected)));
    leak(JSON.stringify(workflowSummary(rejected)));
    leak(renderWorkflow(rejected));
    leak(renderHypagoalStatus(rejected, 110));
    leak(JSON.stringify(projectGraphView(rejected)));
  });
});
