import { describe, expect, it } from "vitest";
import {
  applyActionDispatchEvent,
  applyLegacyGoalEvent,
  createActionDispatchRuntime,
  type ActionDispatch,
  type ActionDispatchLifecycleEvent,
  type DispatchLane,
} from "../src/domain/action-dispatch.js";
import type { DomainEvent, EventType } from "../src/domain/model.js";

const at = "2026-07-25T09:00:00.000Z";

const selection = (
  lane: DispatchLane,
  schedulerOrdinal = 1,
  dispatchId = `${lane}-${schedulerOrdinal}`,
): ActionDispatchLifecycleEvent => ({
  type: "hypagraph.action.selected",
  dispatch: {
    dispatchId,
    action: { kind: "start-ready-task", nodeId: "work" },
    lane,
    selectedSequence: 12,
    selectedSnapshotHash: "snapshot-12",
    schedulerOrdinal,
  },
  timestamp: at,
});

const legacyEvent = (
  type: EventType,
  sequence: number,
  data: Record<string, unknown>,
): DomainEvent => ({
  eventId: `event-${sequence}`,
  workflowId: "workflow-1",
  revision: 1,
  sequence,
  type,
  version: 1,
  timestamp: at,
  causationId: `cause-${sequence}`,
  correlationId: "correlation-1",
  data,
});

describe("M6A action dispatch", () => {
  it.each<DispatchLane>(["deterministic", "model", "executor"])(
    "uses one lifecycle for the %s lane",
    (lane) => {
      let runtime = createActionDispatchRuntime();
      runtime = applyActionDispatchEvent(runtime, selection(lane));
      expect(runtime).toMatchObject({
        schedulerOrdinal: 1,
        pending: { dispatchId: `${lane}-1`, lane, status: "selected" },
      });

      runtime = applyActionDispatchEvent(runtime, {
        type: "hypagraph.action.dispatched",
        dispatchId: `${lane}-1`,
        timestamp: at,
      });
      expect(runtime.pending).toMatchObject({ status: "dispatched", dispatchedAt: at });

      runtime = applyActionDispatchEvent(runtime, {
        type: "hypagraph.action.completed",
        dispatchId: `${lane}-1`,
        timestamp: at,
      });
      expect(runtime.pending).toBeUndefined();
      expect(runtime.lastOutcome).toMatchObject({
        dispatchId: `${lane}-1`,
        lane,
        status: "completed",
        schedulerOrdinal: 1,
      });
    },
  );

  it("projects the v0.6 continuation lifecycle into the model lane", () => {
    let runtime = createActionDispatchRuntime();
    runtime = applyLegacyGoalEvent(runtime, legacyEvent(
      "hypagraph.goal.continuation-requested",
      10,
      {
        operationId: "continue-1",
        ordinal: 1,
        action: { kind: "start-ready-task", nodeId: "work" },
        selectedSequence: 9,
        selectedSnapshotHash: "snapshot-9",
      },
    ));

    expect(runtime).toMatchObject({
      schedulerOrdinal: 1,
      pending: {
        dispatchId: "continue-1",
        lane: "model",
        status: "dispatched",
        selectedSequence: 9,
        selectedSnapshotHash: "snapshot-9",
      },
    });

    runtime = applyLegacyGoalEvent(runtime, legacyEvent(
      "hypagraph.goal.turn-recorded",
      11,
      { continuationOperationId: "continue-1", continuationOrdinal: 1 },
    ));

    expect(runtime.schedulerOrdinal).toBe(1);
    expect(runtime.pending).toBeUndefined();
    expect(runtime.lastOutcome).toMatchObject({
      dispatchId: "continue-1",
      lane: "model",
      status: "completed",
      schedulerOrdinal: 1,
    });
  });

  it("advances the scheduler ordinal at selection and not at completion", () => {
    let runtime = createActionDispatchRuntime();
    runtime = applyActionDispatchEvent(runtime, selection("model"));
    runtime = applyActionDispatchEvent(runtime, {
      type: "hypagraph.action.dispatched",
      dispatchId: "model-1",
      timestamp: at,
    });
    runtime = applyActionDispatchEvent(runtime, {
      type: "hypagraph.action.completed",
      dispatchId: "model-1",
      timestamp: at,
    });
    expect(runtime.schedulerOrdinal).toBe(1);

    runtime = applyActionDispatchEvent(runtime, selection("deterministic", 2));
    expect(runtime.schedulerOrdinal).toBe(2);
  });

  it("projects a v0.6 abandonment as an interrupted model dispatch", () => {
    let runtime = createActionDispatchRuntime();
    runtime = applyLegacyGoalEvent(runtime, legacyEvent(
      "hypagraph.goal.continuation-requested",
      10,
      {
        operationId: "continue-1",
        ordinal: 1,
        action: { kind: "start-ready-task", nodeId: "work" },
        selectedSequence: 9,
        selectedSnapshotHash: "snapshot-9",
      },
    ));
    runtime = applyLegacyGoalEvent(runtime, legacyEvent(
      "hypagraph.goal.continuation-abandoned",
      11,
      { operationId: "continue-1", reason: "The session reloaded." },
    ));

    expect(runtime.pending).toBeUndefined();
    expect(runtime.lastOutcome).toMatchObject({
      dispatchId: "continue-1",
      status: "interrupted",
      reason: "The session reloaded.",
    });
  });

  it("rejects a non-contiguous scheduler ordinal", () => {
    expect(() => applyActionDispatchEvent(createActionDispatchRuntime(), selection("model", 2))).toThrow(
      "An action-selected event has a non-contiguous scheduler ordinal.",
    );
  });

  it("rejects a terminal event for a different dispatch", () => {
    let runtime = applyActionDispatchEvent(createActionDispatchRuntime(), selection("model"));
    runtime = applyActionDispatchEvent(runtime, {
      type: "hypagraph.action.dispatched",
      dispatchId: "model-1",
      timestamp: at,
    });
    expect(() => applyActionDispatchEvent(runtime, {
      type: "hypagraph.action.completed",
      dispatchId: "other",
      timestamp: at,
    })).toThrow("An action-dispatch event belongs to a different dispatch.");
  });

  it("does not change the input runtime", () => {
    const runtime = createActionDispatchRuntime();
    const dispatch = selection("model") as Extract<ActionDispatchLifecycleEvent, { type: "hypagraph.action.selected" }>;
    const originalDispatch = structuredClone(dispatch.dispatch) as ActionDispatch;
    const next = applyActionDispatchEvent(runtime, dispatch);

    expect(runtime).toEqual({ schedulerOrdinal: 0 });
    expect(dispatch.dispatch).toEqual(originalDispatch);
    expect(next).not.toBe(runtime);
  });
});
