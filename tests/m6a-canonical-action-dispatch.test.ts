import { describe, expect, it } from "vitest";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import { isRunnableGoalContinuation, selectGoalContinuation } from "../src/domain/goal-continuation.js";
import {
  HYPAGRAPH_SCHEMA_VERSION,
  type DomainEvent,
  type GoalTokenUsage,
  type HypagraphCommand,
  type HypagraphState,
} from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { handleCommand } from "../src/domain/reducer.js";
import { restoreLatestSession, validateRestoredGoalState } from "../src/persistence/session-rebuild.js";

const at = "2026-07-25T12:00:00.000Z";
const later = "2026-07-25T12:00:01.000Z";
const latest = "2026-07-25T12:00:02.000Z";

const usage: GoalTokenUsage = {
  input: 12,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
};

const create = () => {
  const result = createHypagoalWorkflow({
    title: "Canonical dispatch",
    goal: "Complete one task",
    nodes: [{ id: "work", title: "Work", requires: [], acceptance: [] }],
    loops: [],
    policy: { mode: "guided", requireEvidence: false },
  }, {
    workflowId: "dispatch-workflow",
    goalId: "dispatch-goal",
    goalWorkflowId: "dispatch-workflow",
    at,
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

const event = (
  state: HypagraphState,
  sequence: number,
  type: DomainEvent["type"],
  timestamp: string,
  data: Record<string, unknown>,
): DomainEvent => ({
  eventId: `dispatch-event-${sequence}`,
  workflowId: state.workflowId,
  revision: state.revision,
  sequence,
  type,
  version: 1,
  timestamp,
  causationId: `dispatch-cause-${sequence}`,
  correlationId: "dispatch-correlation",
  data,
});

describe("M6A canonical action dispatch projection", () => {
  it("initializes schema 6 goal state with an independent scheduler ordinal", () => {
    const { state } = create();
    expect(HYPAGRAPH_SCHEMA_VERSION).toBe(6);
    expect(state.schemaVersion).toBe(6);
    expect(state.goal?.schedulerOrdinal).toBe(0);
    expect(state.goal?.actionDispatch).toEqual({ schedulerOrdinal: 0 });
    expect(() => validateRestoredGoalState(state)).not.toThrow();
  });

  it("projects the current continuation lifecycle into a completed model dispatch", () => {
    const value = create();
    const decision = selectGoalContinuation(value.state);
    if (!isRunnableGoalContinuation(decision)) throw new Error(`Unexpected decision ${decision.kind}`);

    let state = apply(value.state, value.events, {
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
      commandId: "model-dispatch-1",
      at,
    });

    expect(state.goal?.actionDispatch).toMatchObject({
      schedulerOrdinal: 1,
      pending: {
        dispatchId: "model-dispatch-1",
        lane: "model",
        status: "dispatched",
        schedulerOrdinal: 1,
      },
    });
    expect(state.goal?.schedulerOrdinal).toBe(1);

    const pending = state.goal!.pendingContinuation!;
    state = apply(state, value.events, {
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
      turnId: "turn-1",
      source: "pi-assistant-usage-v1",
      usage,
      commandId: "record-turn-1",
      at: later,
    });

    expect(state.goal?.budget.consumedTurns).toBe(1);
    expect(state.goal?.actionDispatch?.pending).toBeUndefined();
    expect(state.goal?.actionDispatch?.lastOutcome).toMatchObject({
      dispatchId: "model-dispatch-1",
      lane: "model",
      status: "completed",
      schedulerOrdinal: 1,
    });
    expect(replayEvents(value.events)).toEqual(state);
  });

  it("advances the scheduler for a deterministic action without charging a model turn", () => {
    const value = create();
    const start = value.state.sequence;
    const selected = event(value.state, start + 1, "hypagraph.action.selected", at, {
      dispatch: {
        dispatchId: "gate-1",
        action: { kind: "evaluate-ready-gate", nodeId: "work" },
        lane: "deterministic",
        selectedSequence: value.state.sequence,
        selectedSnapshotHash: value.state.snapshotHash,
        schedulerOrdinal: 1,
      },
    });
    const dispatched = event(value.state, start + 2, "hypagraph.action.dispatched", later, { dispatchId: "gate-1" });
    const completed = event(value.state, start + 3, "hypagraph.action.completed", latest, { dispatchId: "gate-1" });

    const state = replayEvents([...value.events, selected, dispatched, completed]);
    expect(state.goal?.schedulerOrdinal).toBe(1);
    expect(state.goal?.budget.consumedTurns).toBe(0);
    expect(state.goal?.actionDispatch?.lastOutcome).toMatchObject({
      dispatchId: "gate-1",
      lane: "deterministic",
      status: "completed",
    });
  });

  it("rejects stored development state from an unsupported schema", () => {
    const entry = {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "hypagraph_status",
        details: {
          hypagraph: {
            events: [],
            snapshot: { schemaVersion: 5 },
          },
        },
      },
    };
    expect(() => restoreLatestSession([entry])).toThrow(
      "Unsupported Hypagraph schema version '5'. Expected schema version 6.",
    );
  });
});
