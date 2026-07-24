import { describe, expect, it } from "vitest";
import type { HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { projectHypagoalSurface, renderHypagoalLifecycleMessage, renderHypagoalStatus } from "../src/ui/hypagoal-surface.js";

const at = "2026-07-24T14:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Product surface",
  goal: "Expose exact Hypagoal state without raw event inspection.",
  nodes: [
    { id: "implement", title: "Implement the product surface", requires: [], acceptance: ["Status is explicit."] },
    { id: "verify", title: "Verify the product surface", kind: "check", requires: ["implement"], acceptance: [], check: { kind: "command", command: "npm", arguments: ["test"], timeoutMs: 120000, publish: [] } },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: true },
});

const apply = (state: HypagraphState, command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const activeGoal = (): HypagraphState => {
  const created = createWorkflow(definition(), at, "surface-workflow");
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  return apply(created.state, {
    type: "start-goal",
    goalId: "surface-goal",
    budget: { maximumTurns: 8, maximumTokens: 4000 },
    commandId: "start-surface-goal",
    at,
  });
};

describe("Hypagoal product surface", () => {
  it("projects objective, current action, ready work, independent budgets, revision state, and controls", () => {
    const state = activeGoal();
    const surface = projectHypagoalSurface(state);
    expect(surface).toMatchObject({
      objective: definition().goal,
      workflow: { phase: "running", revision: 1 },
      goal: { id: "surface-goal", status: "active" },
      action: { readyNodeIds: ["implement"], next: "start task 'implement'" },
      budget: {
        turns: { consumed: 0, limit: 8, remaining: 8 },
        tokens: { consumed: 0, limit: 4000, remaining: 4000 },
      },
      automaticRevision: { consumed: 0, maximum: 1, remaining: 1, pending: false },
    });
    expect(surface?.controls).toEqual([
      "/hypagoal status",
      "/hypagoal graph",
      "/hypagoal pause",
      "/hypagoal cancel",
    ]);
  });

  it("renders complete narrow and wide status without exceeding the requested width", () => {
    const state = activeGoal();
    const narrow = renderHypagoalStatus(state, 52);
    const wide = renderHypagoalStatus(state, 110);
    expect(narrow).toContain("Hypagoal active · workflow running");
    expect(narrow).toContain("Budget: turns 0/8");
    expect(narrow).toContain("/hypagoal status");
    expect(narrow.split("\n").every((line) => line.length <= 52)).toBe(true);
    expect(wide).toContain("Hypagoal status");
    expect(wide).toContain(`Objective: ${definition().goal}`);
    expect(wide).toContain("Current action: none");
    expect(wide).toContain("Next action: start task 'implement'");
    expect(wide).toContain("Automatic revision: 0/1; remaining 1");
    expect(wide.split("\n").every((line) => line.length <= 110)).toBe(true);
  });

  it("distinguishes explicit pause, budget limits, cancellation, and revision-eligible blockage", () => {
    const paused = apply(activeGoal(), {
      type: "pause-goal",
      cause: "explicit",
      reason: "Wait for user review.",
      commandId: "pause-surface-goal",
      at,
    });
    expect(projectHypagoalSurface(paused)).toMatchObject({
      goal: { status: "paused", pauseCause: "explicit", stopReason: "Wait for user review." },
      stopCode: "pause_explicit",
    });
    expect(renderHypagoalLifecycleMessage(paused)).toContain("Stop: pause_explicit");

    const cancelled = apply(activeGoal(), {
      type: "cancel-goal",
      reason: "The user cancelled the goal.",
      commandId: "cancel-surface-goal",
      at,
    });
    expect(projectHypagoalSurface(cancelled)).toMatchObject({
      goal: { status: "cancelled" },
      stopCode: "goal_cancelled",
    });

    const blocked = apply(activeGoal(), {
      type: "block-node",
      nodeId: "implement",
      blockerKind: "repository-work",
      reason: "A bounded repository step is missing.",
      commandId: "block-surface-goal",
      at,
    });
    expect(projectHypagoalSurface(blocked)).toMatchObject({
      goal: { status: "blocked" },
      blockage: { kind: "revision-eligible", blocker: { kind: "blocked-node", id: "implement" } },
      stopCode: "automatic_revision_eligible",
    });

    const budgetLimited = structuredClone(activeGoal());
    budgetLimited.goal!.status = "budget_limited";
    budgetLimited.goal!.stopReason = "The goal turn budget is exhausted.";
    budgetLimited.goal!.budget.stop = { reason: "turn_limit", limit: 8, consumed: 8, at };
    expect(projectHypagoalSurface(budgetLimited)).toMatchObject({ stopCode: "turn_limit" });
  });

  it.each([
    ["completed", "goal_completed", (state: HypagraphState) => {
      state.phase = "completed";
      state.goal!.status = "completed";
      state.goal!.stopReason = "The canonical workflow completed.";
    }],
    ["failed", "goal_failed", (state: HypagraphState) => {
      state.phase = "failed";
      state.goal!.status = "failed";
      state.goal!.stopReason = "The canonical workflow failed.";
    }],
    ["session reload pause", "pause_session_reload", (state: HypagraphState) => {
      state.goal!.status = "paused";
      state.goal!.pauseCause = "session_reload";
      state.goal!.stopReason = "The Pi session reloaded.";
    }],
    ["branch change pause", "pause_branch_change", (state: HypagraphState) => {
      state.goal!.status = "paused";
      state.goal!.pauseCause = "branch_change";
      state.goal!.stopReason = "The Pi branch changed.";
    }],
    ["invalid usage pause", "pause_usage_invalid", (state: HypagraphState) => {
      state.goal!.status = "paused";
      state.goal!.pauseCause = "usage_invalid";
      state.goal!.stopReason = "Assistant usage was invalid.";
    }],
    ["token limit", "token_limit", (state: HypagraphState) => {
      state.goal!.status = "budget_limited";
      state.goal!.stopReason = "The goal token budget is exhausted.";
      state.goal!.budget.stop = { reason: "token_limit", limit: 4000, consumed: 4000, at };
    }],
  ] as const)("surfaces %s with an explicit stop code", (_label, code, mutate) => {
    const state = activeGoal();
    mutate(state);
    expect(projectHypagoalSurface(state)).toMatchObject({ stopCode: code });
    expect(renderHypagoalLifecycleMessage(state)).toContain(`Stop: ${code}`);
  });

  it("distinguishes non-revisable and exhausted blockage", () => {
    const external = apply(activeGoal(), {
      type: "block-node",
      nodeId: "implement",
      blockerKind: "external-dependency",
      reason: "Wait for an external approval.",
      commandId: "block-external-surface-goal",
      at,
    });
    expect(projectHypagoalSurface(external)).toMatchObject({
      blockage: { kind: "revision-not-allowed", blocker: { kind: "external-dependency" } },
      stopCode: "blocker_external-dependency",
    });

    const exhausted = apply(activeGoal(), {
      type: "block-node",
      nodeId: "implement",
      blockerKind: "repository-work",
      reason: "A bounded repository step is missing.",
      commandId: "block-exhausted-surface-goal",
      at,
    });
    exhausted.goal!.automaticRevision.consumedAttempts = 1;
    expect(projectHypagoalSurface(exhausted)).toMatchObject({
      blockage: { kind: "revision-exhausted" },
      automaticRevision: { remaining: 0 },
      stopCode: "automatic_revision_exhausted",
    });
  });

  it.each([
    ["max_iterations", "loop_max_iterations"],
    ["no_progress", "loop_no_progress"],
    ["invalid_evaluations", "loop_invalid_evaluations"],
    ["evaluation_budget", "loop_evaluation_budget"],
  ] as const)("surfaces loop stop %s instead of a generic goal failure", (exitReason, code) => {
    const state = activeGoal();
    state.definition.loops = [{
      id: "surface-loop",
      nodes: ["implement", "verify"],
      entry: "implement",
      evaluateAfter: "verify",
      feedbackEdges: [{ from: "verify", to: "implement" }],
      successWhen: { kind: "compare", left: { kind: "literal", value: false }, operator: "eq", right: { kind: "literal", value: true } },
      maxIterations: 2,
      patience: 1,
      evaluation: {
        maximumInvalidEvaluations: 1,
        validWhen: { kind: "compare", left: { kind: "literal", value: true }, operator: "eq", right: { kind: "literal", value: true } },
      },
      failurePolicy: "fail-workflow",
    }];
    state.runtime.loops["surface-loop"] = {
      loopId: "surface-loop",
      status: "failed",
      currentIteration: 2,
      maxIterations: 2,
      iterations: [],
      factsUsed: [],
      lastSuccess: false,
      exitReason,
      failurePolicy: "fail-workflow",
    };
    state.phase = "failed";
    state.goal!.status = "failed";
    state.goal!.stopReason = `Loop stopped with ${exitReason}.`;
    expect(projectHypagoalSurface(state)).toMatchObject({ stopCode: code });
  });

  it.each([
    ["stale_goal_revision", "stale proposal"],
    ["revision_turn_interrupted", "interrupted revision turn"],
  ] as const)("surfaces %s revision outcome", (outcomeCode, reason) => {
    const state = activeGoal();
    state.phase = "blocked";
    state.goal!.status = "blocked";
    state.goal!.stopReason = reason;
    state.goal!.automaticRevision.consumedAttempts = 1;
    state.goal!.automaticRevision.lastAttempt = {
      operationId: "revision-surface",
      blocker: {
        kind: "blocked-node",
        id: "implement",
        reason,
        sourceRevision: state.revision,
        sourceSequence: state.sequence,
        sourceSnapshotHash: state.snapshotHash,
      },
      sourceRevision: state.revision,
      sourceSequence: state.sequence,
      sourceSnapshotHash: state.snapshotHash,
      requestSequence: state.sequence,
      sessionGeneration: 0,
      branchGeneration: 0,
      requestedAt: at,
      outcome: "abandoned",
      outcomeCode,
      reason,
      completedAt: at,
    };
    expect(projectHypagoalSurface(state)).toMatchObject({
      automaticRevision: { lastOutcomeCode: outcomeCode },
      stopCode: outcomeCode,
    });
  });

  it("reports no product state for an ordinary workflow without a Hypagoal", () => {
    const created = createWorkflow(definition(), at, "ordinary-workflow");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    expect(projectHypagoalSurface(created.state)).toBeUndefined();
    expect(renderHypagoalStatus(created.state)).toContain("There is no active Hypagoal");
  });
});
