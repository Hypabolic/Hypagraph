import { describe, expect, it } from "vitest";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import { isRunnableGoalContinuation, selectGoalContinuation } from "../src/domain/goal-continuation.js";
import type { DomainEvent, GoalTokenUsage, HypagraphCommand, HypagraphState } from "../src/domain/model.js";
import { handleCommand } from "../src/domain/reducer.js";
import { replayEvents } from "../src/domain/projection.js";
import { validateRestoredGoalState } from "../src/persistence/session-rebuild.js";

const at = "2026-07-24T10:00:00.000Z";
const usage = (totalTokens = 20): GoalTokenUsage => ({
  input: totalTokens - 5,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
});

const create = (budget?: { maximumTurns?: number; maximumTokens?: number }) => {
  const result = createHypagoalWorkflow({
    title: "Budgeted root",
    goal: "Complete the budgeted root",
    nodes: [{ id: "work", title: "Work", requires: [], acceptance: [] }],
    loops: [],
    policy: { mode: "guided", requireEvidence: false },
  }, {
    workflowId: "budget-workflow",
    goalId: "budget-goal",
    goalWorkflowId: "budget-workflow",
    at,
    ...(budget ? { budget } : {}),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return { state: result.state, events: [...result.events] };
};

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const request = (state: HypagraphState, events: DomainEvent[], operationId = "continue-1"): HypagraphState => {
  const decision = selectGoalContinuation(state);
  if (!isRunnableGoalContinuation(decision)) throw new Error(`Unexpected decision ${decision.kind}`);
  return apply(state, events, {
    type: "request-goal-continuation",
    goalId: decision.goalId,
    workflowId: decision.workflowId,
    expectedRevision: decision.revision,
    expectedSequence: decision.sequence,
    expectedSnapshotHash: decision.snapshotHash,
    expectedContinuationOrdinal: decision.continuationOrdinal,
    sessionGeneration: 1,
    branchGeneration: 2,
    action: { kind: decision.kind, nodeId: decision.nodeId },
    commandId: operationId,
    at,
  });
};

const record = (state: HypagraphState, events: DomainEvent[], tokens = 20, turnId = "turn-1") => {
  const pending = state.goal!.pendingContinuation!;
  return apply(state, events, {
    type: "record-goal-turn-usage",
    goalId: state.goal!.goalId,
    workflowId: state.workflowId,
    expectedRevision: state.revision,
    expectedSequence: state.sequence,
    expectedSnapshotHash: state.snapshotHash,
    continuationOperationId: pending.operationId,
    continuationOrdinal: pending.ordinal,
    requestSequence: pending.requestSequence,
    selectedSequence: pending.selectedSequence,
    selectedSnapshotHash: pending.selectedSnapshotHash,
    sessionGeneration: pending.sessionGeneration,
    branchGeneration: pending.branchGeneration,
    turnId,
    source: "pi-assistant-usage-v1",
    usage: usage(tokens),
    commandId: `record-${turnId}`,
    at,
  });
};

describe("Hypagoal budgets", () => {
  it("initializes explicit workflow-local limits without inventing usage", () => {
    const value = create({ maximumTurns: 3, maximumTokens: 100 });
    expect(value.state.goal?.budget).toEqual({
      limits: { maximumTurns: 3, maximumTokens: 100 },
      consumedTurns: 0,
      consumedTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    });
  });

  it("records one delivered continuation exactly once", () => {
    const value = create({ maximumTurns: 3, maximumTokens: 100 });
    let state = request(value.state, value.events);
    state = record(state, value.events, 20);
    expect(state.goal?.budget).toMatchObject({
      consumedTurns: 1,
      consumedTokens: { input: 15, output: 5, totalTokens: 20 },
      lastAccountedTurn: { turnId: "turn-1", continuationOperationId: "continue-1" },
    });
    expect(state.goal?.pendingContinuation).toBeUndefined();
    expect(replayEvents(value.events)).toEqual(state);
    expect(() => validateRestoredGoalState(state)).not.toThrow();
  });

  it("stops at the turn limit and does not mark the workflow successful", () => {
    const value = create({ maximumTurns: 1 });
    let state = request(value.state, value.events);
    state = record(state, value.events);
    expect(state.goal?.status).toBe("budget_limited");
    expect(state.goal?.budget.stop).toMatchObject({ reason: "turn_limit", limit: 1, consumed: 1 });
    expect(state.phase).toBe("running");
    expect(state.runtime.nodes.work?.status).toBe("ready");
  });

  it("stops at the token limit after charging the final permitted turn", () => {
    const value = create({ maximumTokens: 20 });
    let state = request(value.state, value.events);
    state = record(state, value.events, 20);
    expect(state.goal?.status).toBe("budget_limited");
    expect(state.goal?.budget).toMatchObject({
      consumedTurns: 1,
      consumedTokens: { totalTokens: 20 },
      stop: { reason: "token_limit", limit: 20, consumed: 20 },
    });
  });

  it("uses the turn limit first when both limits are exhausted", () => {
    const value = create({ maximumTurns: 1, maximumTokens: 20 });
    let state = request(value.state, value.events);
    state = record(state, value.events, 20);
    expect(state.goal?.budget.stop?.reason).toBe("turn_limit");
  });

  it("rejects duplicate usage without double charging", () => {
    const value = create({ maximumTurns: 3 });
    let state = request(value.state, value.events);
    state = record(state, value.events);
    const before = structuredClone(state);
    const result = handleCommand(state, {
      type: "record-goal-turn-usage",
      goalId: state.goal!.goalId,
      workflowId: state.workflowId,
      expectedRevision: state.revision,
      expectedSequence: state.sequence,
      expectedSnapshotHash: state.snapshotHash,
      continuationOperationId: "continue-1",
      continuationOrdinal: 1,
      requestSequence: 0,
      selectedSequence: 0,
      selectedSnapshotHash: "old",
      sessionGeneration: 1,
      branchGeneration: 2,
      turnId: "turn-1",
      source: "pi-assistant-usage-v1",
      usage: usage(),
      commandId: "duplicate",
      at,
    });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "duplicate_goal_turn_usage" }] });
    expect(state).toEqual(before);
  });

  it("rejects malformed usage without clearing the pending continuation", () => {
    const value = create({ maximumTokens: 100 });
    const state = request(value.state, value.events);
    const pending = structuredClone(state.goal?.pendingContinuation);
    const command = {
      type: "record-goal-turn-usage" as const,
      goalId: state.goal!.goalId,
      workflowId: state.workflowId,
      expectedRevision: state.revision,
      expectedSequence: state.sequence,
      expectedSnapshotHash: state.snapshotHash,
      continuationOperationId: pending!.operationId,
      continuationOrdinal: pending!.ordinal,
      requestSequence: pending!.requestSequence,
      selectedSequence: pending!.selectedSequence,
      selectedSnapshotHash: pending!.selectedSnapshotHash,
      sessionGeneration: pending!.sessionGeneration,
      branchGeneration: pending!.branchGeneration,
      turnId: "invalid-turn",
      source: "pi-assistant-usage-v1" as const,
      usage: { ...usage(), totalTokens: 99 },
      commandId: "invalid-usage",
      at,
    };
    const result = handleCommand(state, command);
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "invalid_goal_token_total" }] });
    expect(state.goal?.pendingContinuation).toEqual(pending);
  });

  it("charges a turn after its semantic work completes the workflow", () => {
    const value = create({ maximumTurns: 1 });
    let state = request(value.state, value.events);
    state = apply(state, value.events, { type: "start-node", nodeId: "work", attemptId: "a1", commandId: "start", at });
    state = apply(state, value.events, { type: "submit-result", nodeId: "work", attemptId: "a1", evidence: [], commandId: "submit", at });
    state = apply(state, value.events, { type: "begin-verification", nodeId: "work", attemptId: "a1", commandId: "verify", at });
    state = apply(state, value.events, { type: "complete-verification", nodeId: "work", attemptId: "a1", passed: true, commandId: "complete", at });
    expect(state.goal?.status).toBe("completed");
    expect(state.goal?.pendingContinuation).toBeDefined();
    state = record(state, value.events);
    expect(state.goal?.status).toBe("completed");
    expect(state.goal?.budget.consumedTurns).toBe(1);
    expect(state.goal?.budget.stop).toBeUndefined();
  });

  it("persists pause causes and clears a pending continuation", () => {
    const value = create({ maximumTurns: 3 });
    let state = request(value.state, value.events);
    state = apply(state, value.events, {
      type: "pause-goal",
      cause: "session_reload",
      reason: "Reloaded",
      commandId: "pause-reload",
      at,
    });
    expect(state.goal).toMatchObject({ status: "paused", pauseCause: "session_reload", stopReason: "Reloaded" });
    expect(state.goal?.pendingContinuation).toBeUndefined();
  });
});
