import { describe, expect, it } from "vitest";
import type {
  DomainEvent,
  GoalContinuationAction,
  HypagraphCommand,
  HypagraphDefinition,
  HypagraphState,
} from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { replayEvents } from "../src/domain/projection.js";
import {
  enumerateGoalContinuationCandidates,
  isRunnableGoalContinuation,
  selectGoalContinuation,
} from "../src/domain/goal-continuation.js";
import { validateRestoredGoalState } from "../src/persistence/session-rebuild.js";

const at = "2026-07-24T08:30:00.000Z";

const createGoal = (definition: HypagraphDefinition, workflowId = "workflow-continuation") => {
  const created = createWorkflow(definition, at, workflowId);
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  const started = handleCommand(created.state, {
    type: "start-goal",
    goalId: "continue-root",
    commandId: "start-goal",
    at,
  });
  if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
  return { state: started.state, events: [...created.events, ...started.events] };
};

const apply = (
  state: HypagraphState,
  events: DomainEvent[],
  command: HypagraphCommand,
): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const completeTask = (
  state: HypagraphState,
  events: DomainEvent[],
  nodeId: string,
  attemptId: string,
): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId, attemptId, commandId: `${attemptId}-start`, at });
  next = apply(next, events, { type: "submit-result", nodeId, attemptId, evidence: [], commandId: `${attemptId}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId, attemptId, commandId: `${attemptId}-verify`, at });
  return apply(next, events, { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${attemptId}-complete`, at });
};

const requestContinuation = (
  state: HypagraphState,
  events: DomainEvent[],
  action: GoalContinuationAction,
  suffix: string,
): HypagraphState => apply(state, events, {
  type: "request-goal-continuation",
  goalId: state.goal!.goalId,
  workflowId: state.workflowId,
  expectedRevision: state.revision,
  expectedSequence: state.sequence,
  expectedSnapshotHash: state.snapshotHash,
  expectedContinuationOrdinal: state.goal!.continuationOrdinal,
  action,
  commandId: `continue-${suffix}`,
  at,
});

const twoTasks = (): HypagraphDefinition => ({
  title: "Two independent tasks",
  goal: "Complete two independent tasks",
  nodes: [
    { id: "first", title: "First", requires: [], acceptance: [] },
    { id: "second", title: "Second", requires: [], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const readyCheck = (): HypagraphDefinition => ({
  title: "Ready check",
  goal: "Run one check",
  nodes: [{
    id: "verify",
    title: "Verify",
    kind: "check",
    requires: [],
    acceptance: [],
    check: {
      kind: "command",
      command: "node",
      arguments: ["--version"],
      timeoutMs: 1_000,
      publish: [],
    },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const readyGate = (): HypagraphDefinition => ({
  title: "Ready gate",
  goal: "Evaluate one gate",
  nodes: [
    {
      id: "choose",
      title: "Choose",
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
    { id: "selected", title: "Selected", requires: ["choose"], acceptance: [] },
    { id: "rejected", title: "Rejected", requires: ["choose"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const loopAndIndependent = (): HypagraphDefinition => ({
  title: "Loop and independent task",
  goal: "Interleave a loop component and an independent task",
  nodes: [
    { id: "loop-entry", title: "Loop entry", requires: ["loop-evaluate"], acceptance: [] },
    {
      id: "loop-evaluate",
      title: "Loop evaluation",
      requires: ["loop-entry"],
      acceptance: [],
      produces: [{ name: "loop.done", type: "boolean", required: true }],
    },
    { id: "independent", title: "Independent", requires: [], acceptance: [] },
  ],
  loops: [{
    id: "work-loop",
    nodes: ["loop-entry", "loop-evaluate"],
    entry: "loop-entry",
    evaluateAfter: "loop-evaluate",
    feedbackEdges: [{ from: "loop-evaluate", to: "loop-entry" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "loop.done" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 2,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

describe("Hypagoal continuation selection", () => {
  it("returns explicit stop decisions from canonical goal-control state", () => {
    const value = createGoal(twoTasks());

    const paused = structuredClone(value.state);
    paused.goal!.status = "paused";
    paused.goal!.stopReason = "Wait for review.";
    expect(selectGoalContinuation(paused)).toMatchObject({ kind: "stop-paused", reason: "Wait for review." });

    const blocked = structuredClone(value.state);
    blocked.goal!.status = "blocked";
    blocked.goal!.stopReason = "An input is missing.";
    expect(selectGoalContinuation(blocked)).toMatchObject({ kind: "stop-blocked", reason: "An input is missing." });

    const failed = structuredClone(value.state);
    failed.goal!.status = "failed";
    failed.goal!.stopReason = "The workflow failed.";
    expect(selectGoalContinuation(failed)).toMatchObject({ kind: "stop-failed" });

    const cancelled = structuredClone(value.state);
    cancelled.goal!.status = "cancelled";
    cancelled.goal!.stopReason = "The user cancelled the goal.";
    expect(selectGoalContinuation(cancelled)).toMatchObject({ kind: "stop-cancelled" });

    const completed = structuredClone(value.state);
    completed.goal!.status = "completed";
    expect(selectGoalContinuation(completed)).toMatchObject({ kind: "stop-completed" });
  });

  it("selects ready checks and gates through canonical node kinds", () => {
    expect(selectGoalContinuation(createGoal(readyCheck()).state)).toMatchObject({
      kind: "run-ready-check",
      nodeId: "verify",
    });
    expect(selectGoalContinuation(createGoal(readyGate()).state)).toMatchObject({
      kind: "evaluate-ready-gate",
      nodeId: "choose",
    });
  });

  it("uses stable definition order and explicit workflow-local identity", () => {
    const { state } = createGoal(twoTasks());
    const candidates = enumerateGoalContinuationCandidates(state);
    expect(candidates.map((item) => item.nodeId)).toEqual(["first", "second"]);
    expect(candidates[0]).toMatchObject({
      kind: "start-ready-task",
      goalId: "continue-root",
      workflowId: state.workflowId,
      revision: state.revision,
      sequence: state.sequence,
      snapshotHash: state.snapshotHash,
      continuationOrdinal: 0,
    });
    expect(selectGoalContinuation(state)).toMatchObject({ kind: "start-ready-task", nodeId: "first" });
  });

  it("records continuation requests and rotates the deterministic selection cursor", () => {
    const value = createGoal(twoTasks());
    const events = [...value.events];
    const first = selectGoalContinuation(value.state);
    expect(isRunnableGoalContinuation(first)).toBe(true);
    if (!isRunnableGoalContinuation(first)) throw new Error(`Unexpected decision: ${first.kind}`);

    let state = requestContinuation(value.state, events, first, "first");
    expect(state.goal?.continuationOrdinal).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "hypagraph.goal.continuation-requested",
      nodeId: "first",
      data: { goalId: "continue-root", ordinal: 1, action: { kind: "start-ready-task", nodeId: "first" } },
    });

    const second = selectGoalContinuation(state);
    expect(second).toMatchObject({ kind: "start-ready-task", nodeId: "second", continuationOrdinal: 1 });
    if (!isRunnableGoalContinuation(second)) throw new Error(`Unexpected decision: ${second.kind}`);
    state = requestContinuation(state, events, second, "second");

    expect(state.goal?.continuationOrdinal).toBe(2);
    expect(selectGoalContinuation(state)).toMatchObject({ kind: "start-ready-task", nodeId: "first" });
    expect(replayEvents(events)).toEqual(state);
    expect(() => validateRestoredGoalState(state)).not.toThrow();
  });

  it("selects an independent component after progress in the earlier loop component", () => {
    const value = createGoal(loopAndIndependent());
    const events = [...value.events];
    const first = selectGoalContinuation(value.state);
    expect(first).toMatchObject({ kind: "start-ready-task", nodeId: "loop-entry", loopId: "work-loop" });
    if (!isRunnableGoalContinuation(first)) throw new Error(`Unexpected decision: ${first.kind}`);

    let state = requestContinuation(value.state, events, first, "loop-entry");
    state = completeTask(state, events, "loop-entry", "loop-entry-1");

    expect(enumerateGoalContinuationCandidates(state).map((item) => item.nodeId)).toEqual([
      "loop-evaluate",
      "independent",
    ]);
    expect(selectGoalContinuation(state)).toMatchObject({
      kind: "start-ready-task",
      nodeId: "independent",
      continuationOrdinal: 1,
    });
  });

  it("continues one active task before it selects another ready component", () => {
    const value = createGoal(twoTasks());
    const events = [...value.events];
    const state = apply(value.state, events, {
      type: "start-node",
      nodeId: "first",
      attemptId: "first-1",
      commandId: "start-first",
      at,
    });
    expect(selectGoalContinuation(state)).toMatchObject({ kind: "continue-active-task", nodeId: "first" });
  });

  it.each([
    ["goalId", "different-goal"],
    ["workflowId", "different-workflow"],
    ["expectedRevision", 2],
    ["expectedSequence", 999],
    ["expectedSnapshotHash", "different-snapshot"],
    ["expectedContinuationOrdinal", 4],
  ] as const)("rejects stale continuation field %s without changing canonical state", (field, value) => {
    const root = createGoal(twoTasks());
    const selected = selectGoalContinuation(root.state);
    if (!isRunnableGoalContinuation(selected)) throw new Error(`Unexpected decision: ${selected.kind}`);
    const before = structuredClone(root.state);
    const command = {
      type: "request-goal-continuation" as const,
      goalId: selected.goalId,
      workflowId: selected.workflowId,
      expectedRevision: selected.revision,
      expectedSequence: selected.sequence,
      expectedSnapshotHash: selected.snapshotHash,
      expectedContinuationOrdinal: selected.continuationOrdinal,
      action: { kind: selected.kind, nodeId: selected.nodeId },
      commandId: `stale-${field}`,
      at,
      [field]: value,
    };
    const rejected = handleCommand(root.state, command);
    expect(rejected).toMatchObject({ ok: false, diagnostics: [{ code: "stale_goal_continuation" }] });
    expect(root.state).toEqual(before);
  });


  it("rejects an invalid restored continuation ordinal", () => {
    const value = createGoal(twoTasks());
    const invalid = structuredClone(value.state);
    invalid.goal!.continuationOrdinal = -1;
    expect(() => validateRestoredGoalState(invalid)).toThrow("invalid continuation ordinal");
  });
});
