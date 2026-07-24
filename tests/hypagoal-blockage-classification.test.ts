import { describe, expect, it } from "vitest";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { classifyGoalBlockage } from "../src/domain/goal-blockage.js";
import { selectGoalContinuation } from "../src/domain/goal-continuation.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";

const at = "2026-07-24T12:30:00.000Z";

const startGoal = (definition: HypagraphDefinition): HypagraphState => {
  const created = createWorkflow(definition, at, "blockage-classification");
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  const started = handleCommand(created.state, {
    type: "start-goal",
    goalId: "classification-root",
    commandId: "start-classification-goal",
    at,
  });
  if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
  return started.state;
};

const loopDefinition = (successWhen: HypagraphDefinition["loops"][number]["successWhen"]): HypagraphDefinition => ({
  title: "Bounded loop classification",
  goal: "Complete the bounded repository workflow.",
  nodes: [
    { id: "iterate", title: "Iterate", requires: ["evaluate"], acceptance: [] },
    { id: "evaluate", title: "Evaluate", requires: ["iterate"], acceptance: [] },
  ],
  loops: [{
    id: "bounded-loop",
    nodes: ["iterate", "evaluate"],
    entry: "iterate",
    evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "iterate" }],
    successWhen,
    maxIterations: 3,
    failurePolicy: "block-dependants",
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const typedSuccess = {
  kind: "compare" as const,
  left: { kind: "literal" as const, value: true },
  operator: "eq" as const,
  right: { kind: "literal" as const, value: true },
};

describe("Hypagoal blocker classification", () => {
  it("requests revision for a legacy loop instead of selecting its ready entry", () => {
    const state = startGoal(loopDefinition("legacy prose success"));

    expect(state.runtime.loops["bounded-loop"]?.status).toBe("requires_revision");
    expect(classifyGoalBlockage(state)).toMatchObject({
      kind: "revision-eligible",
      blocker: { kind: "legacy-definition", id: "bounded-loop" },
    });
    expect(selectGoalContinuation(state)).toMatchObject({
      kind: "request-revision",
      blocker: { kind: "legacy-definition", id: "bounded-loop" },
    });
  });

  it("classifies an interrupted blocked loop as revisable when no root work remains", () => {
    const state = structuredClone(startGoal(loopDefinition(typedSuccess)));
    const loop = state.runtime.loops["bounded-loop"]!;
    loop.status = "blocked";
    loop.currentIteration = 1;
    loop.iterations = [{ iteration: 1, startedAt: at, factsUsed: [] }];
    loop.blockedReason = "The repository evaluator was interrupted before it produced a usable result.";

    expect(classifyGoalBlockage(state)).toMatchObject({
      kind: "revision-eligible",
      blocker: { kind: "blocked-loop", id: "bounded-loop" },
    });
  });

  it("permits a bounded alternative route after recoverable block-dependants evaluation failure", () => {
    const state = structuredClone(startGoal(loopDefinition(typedSuccess)));
    const loop = state.runtime.loops["bounded-loop"]!;
    loop.status = "failed";
    loop.currentIteration = 1;
    loop.iterations = [{ iteration: 1, startedAt: at, factsUsed: [] }];
    loop.exitReason = "evaluation_error";
    loop.failurePolicy = "block-dependants";

    expect(classifyGoalBlockage(state)).toMatchObject({
      kind: "revision-eligible",
      blocker: { kind: "loop-dependants", id: "bounded-loop" },
    });
  });

  it.each(["max_iterations", "no_progress", "invalid_evaluations", "evaluation_budget"] as const)(
    "does not revise terminal block-dependants outcome %s",
    (exitReason) => {
      const state = structuredClone(startGoal(loopDefinition(typedSuccess)));
      const loop = state.runtime.loops["bounded-loop"]!;
      loop.status = "failed";
      loop.currentIteration = 3;
      loop.iterations = [{ iteration: 3, startedAt: at, factsUsed: [] }];
      loop.exitReason = exitReason;
      loop.failurePolicy = "block-dependants";

      expect(classifyGoalBlockage(state)).toMatchObject({
        kind: "revision-not-allowed",
        blocker: { kind: "loop-dependants", id: "bounded-loop" },
      });
      expect(selectGoalContinuation(state)).toMatchObject({ kind: "stop-blocked" });
    },
  );

  it("classifies a malformed definition with no executable path as revisable", () => {
    const definition: HypagraphDefinition = {
      title: "Incomplete generated workflow",
      goal: "Complete the bounded repository workflow.",
      nodes: [{ id: "unreachable", title: "Unreachable", requires: [], acceptance: [] }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const state = structuredClone(startGoal(definition));
    state.runtime.nodes.unreachable!.status = "pending";
    state.phase = "blocked";
    state.goal!.status = "blocked";
    state.goal!.stopReason = "The generated definition has no executable path.";

    expect(classifyGoalBlockage(state)).toMatchObject({
      kind: "revision-eligible",
      blocker: { kind: "definition-no-path", id: "workflow" },
    });
  });
});
