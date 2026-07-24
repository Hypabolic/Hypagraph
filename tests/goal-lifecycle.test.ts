import { describe, expect, it } from "vitest";
import type { DomainEvent, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";
import { restoreLatestSession, validateRestoredGoalState } from "../src/persistence/session-rebuild.js";
import { renderWidget, renderWorkflow, workflowSummary } from "../src/ui/format.js";

const at = "2026-07-24T07:00:00.000Z";
const objective = "Complete one manually driven canonical workflow";

const definition = (): HypagraphDefinition => ({
  title: "Canonical goal lifecycle",
  goal: objective,
  nodes: [{ id: "work", title: "Do the work", requires: [], acceptance: ["The work is verified."] }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const created = () => {
  const result = createWorkflow(definition(), at, "workflow-goal-lifecycle");
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const run = (state: HypagraphState, command: HypagraphCommand) => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const command = <T extends HypagraphCommand["type"]>(type: T, suffix: string) => ({
  type,
  commandId: `goal-${suffix}`,
  at,
} as const);

const apply = (state: HypagraphState, events: DomainEvent[], result: ReturnType<typeof run>): HypagraphState => {
  events.push(...result.events);
  return result.state;
};

describe("canonical goal lifecycle", () => {
  it("derives completion from the canonical workflow and reproduces it through replay and restore", () => {
    const initial = created();
    const events = [...initial.events];
    let state = apply(initial.state, events, run(initial.state, {
      ...command("start-goal", "start"),
      goalId: "ship-feature",
    }));

    expect(state.goal).toMatchObject({
      goalId: "ship-feature",
      workflowId: state.workflowId,
      status: "active",
      continuationOrdinal: 0,
    });
    expect(state.snapshotHash).not.toBe(initial.state.snapshotHash);

    state = apply(state, events, run(state, {
      ...command("start-node", "node-start"),
      nodeId: "work",
      attemptId: "work-1",
    }));
    state = apply(state, events, run(state, {
      ...command("submit-result", "submit"),
      nodeId: "work",
      attemptId: "work-1",
      evidence: [],
    }));
    state = apply(state, events, run(state, {
      ...command("begin-verification", "verify"),
      nodeId: "work",
      attemptId: "work-1",
    }));
    const completed = run(state, {
      ...command("complete-verification", "complete"),
      nodeId: "work",
      attemptId: "work-1",
      passed: true,
    });
    state = apply(state, events, completed);

    expect(completed.events.map((event) => event.type)).toEqual([
      "hypagraph.verification.passed",
      "hypagraph.workflow.completed",
      "hypagraph.goal.completed",
    ]);
    expect(state.phase).toBe("completed");
    expect(state.goal).toMatchObject({
      status: "completed",
      stopReason: "The canonical workflow completed.",
      completedAt: at,
    });
    expect(replayEvents(events)).toEqual(state);

    const restored = restoreLatestSession([{
      type: "message",
      message: {
        role: "toolResult",
        toolName: "hypagraph_read",
        details: { hypagraph: { events, snapshot: state } },
      },
    }]);
    expect(restored?.snapshot).toEqual(state);

    const summary = workflowSummary(state);
    expect(summary.goal).toBe(objective);
    expect(summary.goalControl).toEqual(state.goal);
    expect(renderWorkflow(state)).toContain("Goal control: ship-feature - completed");
    expect(renderWidget(state)[0]).toContain("Goal completed");
  });

  it("projects blockage from workflow state and requires explicit recovery", () => {
    const initial = created();
    const events = [...initial.events];
    let state = apply(initial.state, events, run(initial.state, {
      ...command("start-goal", "start-blocked"),
      goalId: "recover-blockage",
    }));

    const blocked = run(state, {
      ...command("block-node", "block"),
      nodeId: "work",
      reason: "A required external input is missing.",
    });
    state = apply(state, events, blocked);

    expect(blocked.events.map((event) => event.type)).toEqual([
      "hypagraph.node.blocked",
      "hypagraph.goal.blocked",
    ]);
    expect(state.phase).toBe("blocked");
    expect(state.goal).toMatchObject({
      status: "blocked",
      stopReason: "A required external input is missing.",
    });

    state = apply(state, events, run(state, {
      ...command("unblock-node", "unblock"),
      nodeId: "work",
    }));
    expect(state.phase).toBe("running");
    expect(state.goal?.status).toBe("blocked");

    state = apply(state, events, run(state, command("resume-goal", "resume-blocked")));
    expect(state.goal?.status).toBe("active");
    expect(state.goal?.stopReason).toBeUndefined();
    expect(replayEvents(events)).toEqual(state);
  });

  it("records explicit pause, workflow pause, resume, and cancellation", () => {
    const initial = created();
    const events = [...initial.events];
    let state = apply(initial.state, events, run(initial.state, {
      ...command("start-goal", "start-controls"),
      goalId: "control-goal",
    }));

    state = apply(state, events, run(state, {
      ...command("pause-goal", "pause-goal"),
      reason: "Wait for user review.",
    }));
    expect(state.goal).toMatchObject({ status: "paused", stopReason: "Wait for user review." });
    expect(state.phase).toBe("running");

    state = apply(state, events, run(state, command("resume-goal", "resume-goal")));
    state = apply(state, events, run(state, command("pause-workflow", "pause-workflow")));
    expect(state.phase).toBe("paused");
    expect(state.goal).toMatchObject({ status: "paused", stopReason: "The canonical workflow is paused." });

    state = apply(state, events, run(state, command("resume-workflow", "resume-workflow")));
    expect(state.phase).toBe("running");
    expect(state.goal?.status).toBe("paused");

    state = apply(state, events, run(state, command("resume-goal", "resume-after-workflow")));
    state = apply(state, events, run(state, {
      ...command("cancel-goal", "cancel"),
      reason: "The user stopped autonomous control.",
    }));

    expect(state.phase).toBe("running");
    expect(state.goal).toMatchObject({
      status: "cancelled",
      stopReason: "The user stopped autonomous control.",
      completedAt: at,
    });
    expect(replayEvents(events)).toEqual(state);

    const rejected = handleCommand(state, command("resume-goal", "resume-cancelled"));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.diagnostics[0]?.code).toBe("terminal_goal");
  });

  it("keeps ordinary workflows compatible and rejects invented model completion", () => {
    const initial = created();
    expect(initial.state.goal).toBeUndefined();
    expect(replayEvents(initial.events)).toEqual(initial.state);

    const started = run(initial.state, {
      ...command("start-goal", "start-guard"),
      goalId: "guard-completion",
    });
    const before = structuredClone(started.state);
    const invented = handleCommand(started.state, {
      type: "complete-goal",
      commandId: "invented-completion",
      at,
    } as unknown as HypagraphCommand);

    expect(invented.ok).toBe(false);
    if (!invented.ok) expect(invented.diagnostics[0]?.code).toBe("unknown_node");
    expect(started.state).toEqual(before);
    expect(started.state.goal?.status).toBe("active");
  });

  it("validates restored goal identity, timestamps, terminal state, and workflow alignment", () => {
    const initial = created();
    const started = run(initial.state, {
      ...command("start-goal", "start-validation"),
      goalId: "validate-restore",
    });
    expect(() => validateRestoredGoalState(started.state)).not.toThrow();

    const wrongWorkflow = structuredClone(started.state);
    wrongWorkflow.goal!.workflowId = "different-workflow";
    expect(() => validateRestoredGoalState(wrongWorkflow)).toThrow("belongs to a different workflow");

    const invalidTerminal = structuredClone(started.state);
    invalidTerminal.goal!.status = "completed";
    invalidTerminal.goal!.completedAt = at;
    expect(() => validateRestoredGoalState(invalidTerminal)).toThrow("does not match workflow phase");

    const missingReason = structuredClone(started.state);
    missingReason.goal!.status = "blocked";
    delete missingReason.goal!.stopReason;
    expect(() => validateRestoredGoalState(missingReason)).toThrow("without a stop reason");
  });

  it("rejects invalid and duplicate goal identities", () => {
    const initial = created();
    const invalid = handleCommand(initial.state, {
      ...command("start-goal", "invalid-id"),
      goalId: "Invalid Goal",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.diagnostics[0]?.code).toBe("invalid_goal_id");

    const started = run(initial.state, {
      ...command("start-goal", "valid-id"),
      goalId: "valid-goal",
    });
    const duplicate = handleCommand(started.state, {
      ...command("start-goal", "duplicate"),
      goalId: "second-goal",
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.diagnostics[0]?.code).toBe("goal_already_started");
  });
});
