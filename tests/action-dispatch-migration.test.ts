import { describe, expect, it } from "vitest";
import { migrateV5ActionDispatchRuntime } from "../src/domain/action-dispatch-migration.js";
import type { DomainEvent, GoalContinuationAction } from "../src/domain/model.js";

const at = "2026-07-25T09:00:00.000Z";
const action: GoalContinuationAction = { kind: "start-ready-task", nodeId: "work" };

const event = (
  sequence: number,
  type: DomainEvent["type"],
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
  correlationId: "migration-test",
  data,
});

const requested = (sequence: number, ordinal: number, operationId: string): DomainEvent => event(
  sequence,
  "hypagraph.goal.continuation-requested",
  {
    goalId: "goal-1",
    operationId,
    ordinal,
    action,
    selectedRevision: 1,
    selectedSequence: sequence - 1,
    selectedSnapshotHash: `snapshot-${sequence - 1}`,
    sessionGeneration: 1,
    branchGeneration: 1,
  },
);

describe("v0.6 action-dispatch migration", () => {
  it("projects one completed model dispatch without changing the source events", () => {
    const events = [
      requested(1, 1, "dispatch-1"),
      event(2, "hypagraph.goal.turn-recorded", {
        goalId: "goal-1",
        turnId: "turn-1",
        continuationOperationId: "dispatch-1",
        continuationOrdinal: 1,
        source: "pi-assistant-usage-v1",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
      }),
    ];
    const before = structuredClone(events);

    const migrated = migrateV5ActionDispatchRuntime(events);

    expect(migrated).toMatchObject({
      version: 1,
      runtime: {
        schedulerOrdinal: 1,
        lastOutcome: {
          dispatchId: "dispatch-1",
          lane: "model",
          status: "completed",
          schedulerOrdinal: 1,
          selectedSequence: 0,
          selectedSnapshotHash: "snapshot-0",
          action,
        },
      },
    });
    expect(migrated.runtime.pending).toBeUndefined();
    expect(events).toEqual(before);
  });

  it("projects a pending v0.6 continuation as a dispatched model action", () => {
    const migrated = migrateV5ActionDispatchRuntime([
      requested(1, 1, "dispatch-1"),
    ]);

    expect(migrated.runtime).toMatchObject({
      schedulerOrdinal: 1,
      pending: {
        dispatchId: "dispatch-1",
        lane: "model",
        status: "dispatched",
        schedulerOrdinal: 1,
        action,
      },
    });
  });

  it("projects abandonment as an interrupted model dispatch", () => {
    const migrated = migrateV5ActionDispatchRuntime([
      requested(1, 1, "dispatch-1"),
      event(2, "hypagraph.goal.continuation-abandoned", {
        goalId: "goal-1",
        operationId: "dispatch-1",
        reason: "The session reloaded.",
      }),
    ]);

    expect(migrated.runtime.lastOutcome).toMatchObject({
      dispatchId: "dispatch-1",
      lane: "model",
      status: "interrupted",
      reason: "The session reloaded.",
    });
    expect(migrated.runtime.pending).toBeUndefined();
  });

  it("preserves contiguous scheduler ordinals across completed dispatches", () => {
    const migrated = migrateV5ActionDispatchRuntime([
      requested(1, 1, "dispatch-1"),
      event(2, "hypagraph.goal.turn-recorded", {
        goalId: "goal-1",
        turnId: "turn-1",
        continuationOperationId: "dispatch-1",
        continuationOrdinal: 1,
        source: "pi-assistant-usage-v1",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      }),
      requested(3, 2, "dispatch-2"),
      event(4, "hypagraph.goal.turn-recorded", {
        goalId: "goal-1",
        turnId: "turn-2",
        continuationOperationId: "dispatch-2",
        continuationOrdinal: 2,
        source: "pi-assistant-usage-v1",
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
      }),
    ]);

    expect(migrated.runtime.schedulerOrdinal).toBe(2);
    expect(migrated.runtime.lastOutcome).toMatchObject({
      dispatchId: "dispatch-2",
      schedulerOrdinal: 2,
      status: "completed",
    });
  });

  it("rejects a non-contiguous legacy ordinal", () => {
    expect(() => migrateV5ActionDispatchRuntime([
      requested(1, 2, "dispatch-2"),
    ])).toThrow("non-contiguous scheduler ordinal");
  });
});
