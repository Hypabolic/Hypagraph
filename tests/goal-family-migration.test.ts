import { describe, expect, it, vi } from "vitest";
import {
  GOAL_FAMILY_SCHEMA_VERSION,
  GoalFamilyRestoreError,
  UnsupportedGoalFamilySchemaError,
} from "../src/domain/goal-family.js";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { HYPAGRAPH_EVENT_BATCH_TYPE, InMemoryWorkflowEventStore } from "../src/persistence/event-store.js";
import {
  HYPAGRAPH_FAMILY_RECORD_TYPE,
  InMemoryGoalFamilyStore,
  assertPersistedGoalFamilyShape,
  buildOneMemberPersistedFamily,
  defaultOneMemberFamilyId,
  migrateRootWorkflowToOneMemberFamily,
  restorePersistedGoalFamily,
  type PersistedGoalFamily,
} from "../src/persistence/family-store.js";
import {
  appendOneMemberFamilyRecord,
  migrateRestoredRootToOneMemberFamily,
  restoreLatestFamilySession,
  restoreOrMigrateOneMemberFamilySession,
} from "../src/persistence/family-session.js";

const at = "2026-07-29T14:00:00.000Z";
const later = "2026-07-29T14:10:00.000Z";

const definition: HypagraphDefinition = {
  title: "Migration root workflow",
  goal: "Migrate an existing root into a one-member family",
  nodes: [{ id: "one", title: "One", requires: [], acceptance: [] }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
};

const createRootWorkflow = (workflowId = "workflow-root", goalId = "goal-root") => {
  const result = createHypagoalWorkflow(definition, {
    workflowId,
    goalId,
    goalWorkflowId: workflowId,
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const asPersisted = (created: ReturnType<typeof createRootWorkflow>) => ({
  events: created.events,
  snapshot: created.state,
});

describe("migrate root workflow to one-member family", () => {
  it("migrates a realistic root from the hypagoal creation path into one member", () => {
    const created = createRootWorkflow();
    const workflow = asPersisted(created);
    const familyId = defaultOneMemberFamilyId("goal-root", "workflow-root");

    const family = migrateRootWorkflowToOneMemberFamily({
      familyId,
      workflow,
      at,
    });

    expect(family.schemaVersion).toBe(GOAL_FAMILY_SCHEMA_VERSION);
    expect(family.familySnapshot.familyId).toBe(familyId);
    expect(family.familySnapshot.rootGoalId).toBe("goal-root");
    expect(Object.keys(family.familySnapshot.members)).toEqual(["goal-root"]);
    expect(family.familySnapshot.members["goal-root"]).toMatchObject({
      goalId: "goal-root",
      workflowId: "workflow-root",
      rootGoalId: "goal-root",
      depth: 0,
      childGoalIds: [],
    });
    expect(family.familySnapshot.members["goal-root"]?.parent).toBeUndefined();
  });

  it("keeps workflow events and snapshotHash identical before and after migration", () => {
    const created = createRootWorkflow();
    const workflow = asPersisted(created);
    const originalEvents = structuredClone(workflow.events);
    const originalHash = workflow.snapshot.snapshotHash;

    const family = migrateRootWorkflowToOneMemberFamily({
      familyId: "family-preserve",
      workflow,
      at,
    });

    const memberWorkflow = family.workflows[created.state.workflowId];
    expect(memberWorkflow?.events).toEqual(originalEvents);
    expect(memberWorkflow?.snapshot.snapshotHash).toBe(originalHash);
    expect(workflow.events).toEqual(originalEvents);
    expect(workflow.snapshot.snapshotHash).toBe(originalHash);
  });

  it("does not mutate the input workflow object", () => {
    const created = createRootWorkflow();
    const workflow = asPersisted(created);
    const eventsBefore = workflow.events;
    const snapshotBefore = workflow.snapshot;
    const eventsJson = JSON.stringify(workflow.events);
    const snapshotJson = JSON.stringify(workflow.snapshot);

    const family = migrateRootWorkflowToOneMemberFamily({
      familyId: "family-immutable",
      workflow,
      at,
    });

    expect(workflow.events).toBe(eventsBefore);
    expect(workflow.snapshot).toBe(snapshotBefore);
    expect(JSON.stringify(workflow.events)).toBe(eventsJson);
    expect(JSON.stringify(workflow.snapshot)).toBe(snapshotJson);
    expect(family.workflows[created.state.workflowId]?.events).not.toBe(workflow.events);
    expect(family.workflows[created.state.workflowId]?.snapshot).not.toBe(workflow.snapshot);
  });

  it("restores one-member membership and keeps the original workflow stream unchanged", () => {
    const created = createRootWorkflow();
    const family = migrateRootWorkflowToOneMemberFamily({
      familyId: "family-restore",
      workflow: asPersisted(created),
      at,
    });

    const restored = restorePersistedGoalFamily(family);
    expect(restored.familySnapshot.members["goal-root"]).toMatchObject({
      goalId: "goal-root",
      workflowId: "workflow-root",
      depth: 0,
      childGoalIds: [],
    });
    expect(restored.familySnapshot.members["goal-root"]?.parent).toBeUndefined();
    expect(Object.keys(restored.familySnapshot.members)).toEqual(["goal-root"]);
    expect(restored.workflows[created.state.workflowId]?.events).toEqual(created.events);
    expect(restored.workflows[created.state.workflowId]?.snapshot.snapshotHash).toBe(
      created.state.snapshotHash,
    );
  });

  it("stores migration through the family store without rewriting workflow history", async () => {
    const created = createRootWorkflow();
    const originalEvents = structuredClone(created.events);
    const originalHash = created.state.snapshotHash;
    const workflowStore = new InMemoryWorkflowEventStore();
    workflowStore.seed(asPersisted(created));

    const familyStore = new InMemoryGoalFamilyStore(workflowStore);
    const saved = await familyStore.migrateRootToOneMemberFamily({
      familyId: "family-store-migrate",
      workflow: workflowStore.read(created.state.workflowId)!,
      at,
    });

    expect(workflowStore.read(created.state.workflowId)?.events).toEqual(originalEvents);
    expect(workflowStore.read(created.state.workflowId)?.snapshot.snapshotHash).toBe(originalHash);
    expect(saved.workflows[created.state.workflowId]?.events).toEqual(originalEvents);

    const started = handleCommand(created.state, {
      type: "start-node",
      nodeId: "one",
      attemptId: "attempt-1",
      commandId: "start-one",
      at: later,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));

    await workflowStore.append({
      workflowId: created.state.workflowId,
      expectedSequence: created.state.sequence,
      events: started.events,
      snapshot: started.state,
    });

    const afterAppend = workflowStore.read(created.state.workflowId);
    expect(afterAppend?.events).toEqual([...originalEvents, ...started.events]);

    const reloaded = await familyStore.load("family-store-migrate");
    expect(reloaded?.workflows[created.state.workflowId]?.events).toEqual(originalEvents);
    expect(reloaded?.workflows[created.state.workflowId]?.events).not.toEqual(afterAppend?.events);
  });

  it("derives a stable injective family ID from pure root identities", () => {
    expect(defaultOneMemberFamilyId("goal-a", "workflow-b")).toBe("family:6:goal-a:10:workflow-b");
    expect(defaultOneMemberFamilyId("goal-a", "workflow-b")).toBe(
      defaultOneMemberFamilyId("goal-a", "workflow-b"),
    );

    // Colon characters in identities must not collide across (goal, workflow) pairs.
    const left = defaultOneMemberFamilyId("a:b", "c");
    const right = defaultOneMemberFamilyId("a", "b:c");
    expect(left).toBe("family:3:a:b:1:c");
    expect(right).toBe("family:1:a:3:b:c");
    expect(left).not.toBe(right);

    expect(defaultOneMemberFamilyId("goal:with:colons", "workflow:also:colons")).toBe(
      "family:16:goal:with:colons:20:workflow:also:colons",
    );
  });

  it("rejects migration when the workflow has no goal runtime", () => {
    const defined = createWorkflow(definition, at, "workflow-no-goal");
    if (!defined.ok) throw new Error(JSON.stringify(defined.diagnostics));

    expect(() => migrateRootWorkflowToOneMemberFamily({
      familyId: "family-no-goal",
      workflow: { events: defined.events, snapshot: defined.state },
      at,
    })).toThrow(GoalFamilyRestoreError);
    expect(() => migrateRootWorkflowToOneMemberFamily({
      familyId: "family-no-goal",
      workflow: { events: defined.events, snapshot: defined.state },
      at,
    })).toThrow(/has no goal runtime/);
    try {
      migrateRootWorkflowToOneMemberFamily({
        familyId: "family-no-goal",
        workflow: { events: defined.events, snapshot: defined.state },
        at,
      });
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_root_goal_missing");
    }
  });

  it("rejects migration when the goal workflow identity does not match the snapshot", () => {
    const created = createRootWorkflow();
    if (!created.state.goal) throw new Error("The fixture must include a goal runtime.");
    const split = {
      events: created.events,
      snapshot: {
        ...created.state,
        goal: { ...created.state.goal, workflowId: "workflow-other" },
      },
    };

    expect(() => migrateRootWorkflowToOneMemberFamily({
      familyId: "family-split",
      workflow: split,
      at,
    })).toThrow(GoalFamilyRestoreError);
    try {
      migrateRootWorkflowToOneMemberFamily({
        familyId: "family-split",
        workflow: split,
        at,
      });
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_goal_workflow_mismatch");
    }
  });

  it("rejects migration when the workflow event stream is empty", () => {
    const created = createRootWorkflow();
    const empty = {
      events: [],
      snapshot: created.state,
    };

    expect(() => migrateRootWorkflowToOneMemberFamily({
      familyId: "family-empty",
      workflow: empty,
      at,
    })).toThrow(GoalFamilyRestoreError);
    try {
      migrateRootWorkflowToOneMemberFamily({
        familyId: "family-empty",
        workflow: empty,
        at,
      });
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("empty_workflow_event_stream");
    }
  });

  it("rejects default family ID derivation for empty identities", () => {
    expect(() => defaultOneMemberFamilyId("", "workflow-root")).toThrow(GoalFamilyRestoreError);
    expect(() => defaultOneMemberFamilyId("goal-root", "  ")).toThrow(GoalFamilyRestoreError);
    try {
      defaultOneMemberFamilyId("", "workflow-root");
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_root_goal_id");
    }
    try {
      defaultOneMemberFamilyId("goal-root", "  ");
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_root_workflow_id");
    }
  });

  it("rejects migration when snapshot fields change without changing snapshotHash", () => {
    const created = createRootWorkflow();
    if (!created.state.goal) throw new Error("The fixture must include a goal runtime.");
    const tamperedGoal = structuredClone(created.state.goal);
    tamperedGoal.goalId = "tampered-goal";
    const tampered = {
      events: created.events,
      snapshot: {
        ...created.state,
        goal: tamperedGoal,
      },
    };

    expect(() => migrateRootWorkflowToOneMemberFamily({
      familyId: "family-tampered-goal",
      workflow: tampered,
      at,
    })).toThrow(GoalFamilyRestoreError);
    try {
      migrateRootWorkflowToOneMemberFamily({
        familyId: "family-tampered-goal",
        workflow: tampered,
        at,
      });
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_workflow_snapshot_mismatch");
      expect((error as Error).message).toMatch(/snapshot fields do not match event replay/);
    }
  });

  it("rejects restore when a nested workflow event has null data", () => {
    const created = createRootWorkflow();
    const record = migrateRootWorkflowToOneMemberFamily({
      familyId: "family-null-event-data",
      workflow: asPersisted(created),
      at,
    });
    const events = structuredClone(created.events);
    const readyIndex = events.findIndex((event) => event.type === "hypagraph.node.ready");
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    const ready = events[readyIndex]!;
    events[readyIndex] = {
      ...ready,
      data: null as unknown as Record<string, unknown>,
    };
    const broken: PersistedGoalFamily = {
      ...record,
      workflows: {
        [created.state.workflowId]: {
          events,
          snapshot: created.state,
        },
      },
    };

    expect(() => restorePersistedGoalFamily(broken)).toThrow(GoalFamilyRestoreError);
    try {
      restorePersistedGoalFamily(broken);
    } catch (error) {
      expect(error).toBeInstanceOf(GoalFamilyRestoreError);
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_workflow_event");
      expect((error as Error).message).toMatch(/plain object data payload/);
    }
  });

  it("rejects restore when a nested workflow event data is a non-plain object", () => {
    const created = createRootWorkflow();
    const record = migrateRootWorkflowToOneMemberFamily({
      familyId: "family-non-plain-event-data",
      workflow: asPersisted(created),
      at,
    });
    const events = structuredClone(created.events);
    const readyIndex = events.findIndex((event) => event.type === "hypagraph.node.ready");
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    const ready = events[readyIndex]!;
    events[readyIndex] = {
      ...ready,
      data: new Date(at) as unknown as Record<string, unknown>,
    };
    const broken: PersistedGoalFamily = {
      ...record,
      workflows: {
        [created.state.workflowId]: {
          events,
          snapshot: created.state,
        },
      },
    };

    expect(() => restorePersistedGoalFamily(broken)).toThrow(GoalFamilyRestoreError);
    try {
      restorePersistedGoalFamily(broken);
    } catch (error) {
      expect(error).toBeInstanceOf(GoalFamilyRestoreError);
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_workflow_event");
      expect((error as Error).message).toMatch(/plain object data payload/);
    }
  });

  it("rejects restore when a nested workflow event has an unsupported version", () => {
    const created = createRootWorkflow();
    const record = migrateRootWorkflowToOneMemberFamily({
      familyId: "family-bad-event-version",
      workflow: asPersisted(created),
      at,
    });
    const events = structuredClone(created.events);
    const first = events[0]!;
    events[0] = {
      ...first,
      version: 99 as typeof first.version,
    };
    const broken: PersistedGoalFamily = {
      ...record,
      workflows: {
        [created.state.workflowId]: {
          events,
          snapshot: created.state,
        },
      },
    };

    expect(() => restorePersistedGoalFamily(broken)).toThrow(GoalFamilyRestoreError);
    try {
      restorePersistedGoalFamily(broken);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_workflow_event_version");
    }
  });

  it("rejects restore when nested snapshot fields change without changing snapshotHash", () => {
    const created = createRootWorkflow();
    if (!created.state.goal) throw new Error("The fixture must include a goal runtime.");
    const record = migrateRootWorkflowToOneMemberFamily({
      familyId: "family-tampered-nested",
      workflow: asPersisted(created),
      at,
    });
    const tamperedGoal = structuredClone(created.state.goal);
    tamperedGoal.stopReason = "tampered stop reason without status change";
    const broken: PersistedGoalFamily = {
      ...record,
      workflows: {
        [created.state.workflowId]: {
          events: created.events,
          snapshot: {
            ...created.state,
            goal: tamperedGoal,
          },
        },
      },
    };

    expect(() => restorePersistedGoalFamily(broken)).toThrow(GoalFamilyRestoreError);
    try {
      restorePersistedGoalFamily(broken);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_workflow_snapshot_mismatch");
      expect((error as Error).message).toMatch(/snapshot fields do not match event replay/);
    }
  });

  it("rejects restore when a member goal runtime is missing", () => {
    const created = createRootWorkflow();
    const defined = createWorkflow(definition, at, "workflow-root");
    if (!defined.ok) throw new Error(JSON.stringify(defined.diagnostics));
    const record = migrateRootWorkflowToOneMemberFamily({
      familyId: "family-member-goal-missing",
      workflow: asPersisted(created),
      at,
    });
    const broken: PersistedGoalFamily = {
      ...record,
      workflows: {
        [created.state.workflowId]: {
          events: defined.events,
          snapshot: defined.state,
        },
      },
    };

    expect(() => restorePersistedGoalFamily(broken)).toThrow(GoalFamilyRestoreError);
    try {
      restorePersistedGoalFamily(broken);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_member_goal_missing");
    }
  });

  it("rejects restore when a member goalId does not match the nested workflow goal", () => {
    const root = createRootWorkflow("workflow-root", "goal-root");
    const alternate = createRootWorkflow("workflow-root", "goal-alternate");
    const record = migrateRootWorkflowToOneMemberFamily({
      familyId: "family-member-goal-mismatch",
      workflow: asPersisted(root),
      at,
    });
    const goalMismatch: PersistedGoalFamily = {
      ...record,
      workflows: {
        "workflow-root": asPersisted(alternate),
      },
    };

    expect(() => restorePersistedGoalFamily(goalMismatch)).toThrow(GoalFamilyRestoreError);
    try {
      restorePersistedGoalFamily(goalMismatch);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_member_goal_mismatch");
    }
  });

  it("rejects restore when nested goal.workflowId cannot align with the family member workflow binding", () => {
    // Event replay always sets goal.workflowId from the workflow aggregate. A stored
    // snapshot that claims a different goal.workflowId without a matching hash fails
    // full snapshot integrity before the member binding check runs.
    const created = createRootWorkflow("workflow-root", "goal-root");
    if (!created.state.goal) throw new Error("The fixture must include a goal runtime.");
    const record = migrateRootWorkflowToOneMemberFamily({
      familyId: "family-member-workflow-binding",
      workflow: asPersisted(created),
      at,
    });
    const splitGoal = structuredClone(created.state.goal);
    splitGoal.workflowId = "workflow-other";
    const bindingBroken: PersistedGoalFamily = {
      ...record,
      workflows: {
        "workflow-root": {
          events: created.events,
          snapshot: {
            ...created.state,
            goal: splitGoal,
          },
        },
      },
    };

    expect(() => restorePersistedGoalFamily(bindingBroken)).toThrow(GoalFamilyRestoreError);
    try {
      restorePersistedGoalFamily(bindingBroken);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_workflow_snapshot_mismatch");
    }

    // Direct wrap also rejects a split goal/workflow identity before migration completes.
    expect(() => buildOneMemberPersistedFamily({
      familyId: "family-wrap-split",
      rootGoalId: "goal-root",
      workflow: {
        events: created.events,
        snapshot: {
          ...created.state,
          goal: splitGoal,
        },
      },
      at,
    })).toThrow(/targets workflow 'workflow-other'/);
  });
});

describe("session product path for one-member family migration", () => {
  const rootCustomEntries = (created: ReturnType<typeof createRootWorkflow>) => [{
    type: "custom",
    customType: HYPAGRAPH_EVENT_BATCH_TYPE,
    data: {
      version: 1,
      workflowId: created.state.workflowId,
      expectedSequence: 0,
      events: created.events,
      snapshot: created.state,
    },
  }];

  it("migrates from restoreLatestSession output when no family record exists", () => {
    const created = createRootWorkflow();
    const entries = rootCustomEntries(created);

    const result = restoreOrMigrateOneMemberFamilySession(entries);
    expect(result).toBeDefined();
    expect(result?.migrated).toBe(true);
    expect(result?.family.familySnapshot.familyId).toBe(
      defaultOneMemberFamilyId("goal-root", "workflow-root"),
    );
    expect(result?.family.familySnapshot.members["goal-root"]).toMatchObject({
      goalId: "goal-root",
      workflowId: "workflow-root",
      depth: 0,
    });
    expect(result?.family.familySnapshot.members["goal-root"]?.parent).toBeUndefined();
    expect(result?.family.workflows[created.state.workflowId]?.events).toEqual(created.events);
    expect(result?.family.workflows[created.state.workflowId]?.snapshot.snapshotHash).toBe(
      created.state.snapshotHash,
    );
  });

  it("restores an existing family custom entry without migrating again", () => {
    const created = createRootWorkflow();
    const family = migrateRootWorkflowToOneMemberFamily({
      familyId: "family-existing",
      workflow: asPersisted(created),
      at,
    });
    const entries = [
      ...rootCustomEntries(created),
      {
        type: "custom",
        customType: HYPAGRAPH_FAMILY_RECORD_TYPE,
        data: family,
      },
    ];

    const result = restoreOrMigrateOneMemberFamilySession(entries);
    expect(result?.migrated).toBe(false);
    expect(result?.family.familySnapshot.familyId).toBe("family-existing");
    expect(result?.family.workflows[created.state.workflowId]?.events).toEqual(created.events);
  });

  it("appends a family record as an additive custom entry without rewriting workflow batches", () => {
    const created = createRootWorkflow();
    const entries: unknown[] = [...rootCustomEntries(created)];
    const appendEntry = vi.fn((customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    });

    const migrated = migrateRestoredRootToOneMemberFamily(asPersisted(created));
    expect(migrated?.migrated).toBe(true);
    appendOneMemberFamilyRecord({ appendEntry }, migrated!.family);

    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry.mock.calls[0]?.[0]).toBe(HYPAGRAPH_FAMILY_RECORD_TYPE);

    const workflowBatches = entries.filter(
      (entry) => (entry as { customType?: string }).customType === HYPAGRAPH_EVENT_BATCH_TYPE,
    );
    expect(workflowBatches).toHaveLength(1);
    expect((workflowBatches[0] as { data: { events: unknown[] } }).data.events).toEqual(created.events);

    const familyRestored = restoreLatestFamilySession(entries);
    expect(familyRestored?.familySnapshot.members["goal-root"]?.depth).toBe(0);
    expect(familyRestored?.workflows[created.state.workflowId]?.snapshot.snapshotHash).toBe(
      created.state.snapshotHash,
    );

    const second = restoreOrMigrateOneMemberFamilySession(entries);
    expect(second?.migrated).toBe(false);
  });

  it("returns undefined when the restored root has no goal runtime", () => {
    const defined = createWorkflow(definition, at, "workflow-no-goal");
    if (!defined.ok) throw new Error(JSON.stringify(defined.diagnostics));
    const entries = [{
      type: "custom",
      customType: HYPAGRAPH_EVENT_BATCH_TYPE,
      data: {
        version: 1,
        workflowId: defined.state.workflowId,
        expectedSequence: 0,
        events: defined.events,
        snapshot: defined.state,
      },
    }];

    expect(restoreOrMigrateOneMemberFamilySession(entries)).toBeUndefined();
    expect(migrateRestoredRootToOneMemberFamily({
      events: defined.events,
      snapshot: defined.state,
    })).toBeUndefined();
  });

  it("returns undefined when the session has no workflow", () => {
    expect(restoreOrMigrateOneMemberFamilySession([])).toBeUndefined();
  });

  it("rejects an unsupported family schema on custom-entry restore", () => {
    const created = createRootWorkflow();
    const family = buildOneMemberPersistedFamily({
      familyId: "family-bad-schema",
      rootGoalId: "goal-root",
      workflow: asPersisted(created),
      at,
    });
    const unsupported: PersistedGoalFamily = {
      ...family,
      schemaVersion: 99 as typeof GOAL_FAMILY_SCHEMA_VERSION,
      familySnapshot: {
        ...family.familySnapshot,
        schemaVersion: 99 as typeof GOAL_FAMILY_SCHEMA_VERSION,
      },
    };
    const entries = [{
      type: "custom",
      customType: HYPAGRAPH_FAMILY_RECORD_TYPE,
      data: unsupported,
    }];

    expect(() => restoreLatestFamilySession(entries)).toThrow(UnsupportedGoalFamilySchemaError);
    expect(() => restoreOrMigrateOneMemberFamilySession(entries)).toThrow(
      UnsupportedGoalFamilySchemaError,
    );
  });

  it("rejects an invalid family custom entry shape", () => {
    const entries = [{
      type: "custom",
      customType: HYPAGRAPH_FAMILY_RECORD_TYPE,
      data: { not: "a family" },
    }];

    expect(() => restoreLatestFamilySession(entries)).toThrow(GoalFamilyRestoreError);
    try {
      restoreLatestFamilySession(entries);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_custom_entry");
    }
  });

  it("accepts a caller-supplied family ID and migration timestamp", () => {
    const created = createRootWorkflow();
    const result = restoreOrMigrateOneMemberFamilySession(rootCustomEntries(created), {
      familyId: "family-caller",
      at: later,
    });

    expect(result?.family.familySnapshot.familyId).toBe("family-caller");
    expect(result?.family.familyEvents[0]?.timestamp).toBe(later);
  });

  it("migrates a replacement root when an older family record targets a previous root", () => {
    const oldRoot = createRootWorkflow("workflow-old", "goal-old");
    const oldFamily = migrateRootWorkflowToOneMemberFamily({
      familyId: "family-old",
      workflow: asPersisted(oldRoot),
      at,
    });
    const newRoot = createRootWorkflow("workflow-new", "goal-new");
    const entries = [
      ...rootCustomEntries(oldRoot),
      {
        type: "custom",
        customType: HYPAGRAPH_FAMILY_RECORD_TYPE,
        data: oldFamily,
      },
      ...rootCustomEntries(newRoot),
    ];

    const result = restoreOrMigrateOneMemberFamilySession(entries);
    expect(result?.migrated).toBe(true);
    expect(result?.family.familySnapshot.rootGoalId).toBe("goal-new");
    expect(result?.family.familySnapshot.members["goal-new"]?.workflowId).toBe("workflow-new");
    expect(result?.family.familySnapshot.familyId).toBe(
      defaultOneMemberFamilyId("goal-new", "workflow-new"),
    );
    expect(result?.family.workflows["workflow-new"]?.events).toEqual(newRoot.events);
    expect(result?.family.workflows["workflow-old"]).toBeUndefined();
  });

  it("rejects malformed family shapes with typed restore errors", () => {
    const baseSnapshot = {
      schemaVersion: 1,
      familyId: "family-1",
      rootGoalId: "goal-root",
      members: {
        "goal-root": {
          goalId: "goal-root",
          workflowId: "workflow-root",
          rootGoalId: "goal-root",
          depth: 0,
          childGoalIds: [],
        },
      },
      schedulerOrdinal: 1,
      createdAt: at,
      updatedAt: at,
    };

    expect(() => assertPersistedGoalFamilyShape({
      schemaVersion: 1,
      familyEvents: [],
      familySnapshot: baseSnapshot,
      workflows: [],
    })).toThrow(GoalFamilyRestoreError);
    try {
      assertPersistedGoalFamilyShape({
        schemaVersion: 1,
        familyEvents: [],
        familySnapshot: baseSnapshot,
        workflows: [],
      });
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_custom_entry");
      expect((error as Error).message).toMatch(/workflows object map/);
    }

    expect(() => assertPersistedGoalFamilyShape({
      schemaVersion: 1,
      familyEvents: [null],
      familySnapshot: baseSnapshot,
      workflows: {},
    })).toThrow(GoalFamilyRestoreError);
    try {
      assertPersistedGoalFamilyShape({
        schemaVersion: 1,
        familyEvents: [null],
        familySnapshot: baseSnapshot,
        workflows: {},
      });
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_event");
      expect((error as Error).message).toMatch(/index 0 must be a plain object/);
    }

    expect(() => assertPersistedGoalFamilyShape({
      schemaVersion: 1,
      familyEvents: [],
      familySnapshot: {
        ...baseSnapshot,
        members: {
          "goal-root": null,
        },
      },
      workflows: {},
    })).toThrow(GoalFamilyRestoreError);
    try {
      assertPersistedGoalFamilyShape({
        schemaVersion: 1,
        familyEvents: [],
        familySnapshot: {
          ...baseSnapshot,
          members: {
            "goal-root": null,
          },
        },
        workflows: {},
      });
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_member");
    }

    expect(() => assertPersistedGoalFamilyShape({
      schemaVersion: 1,
      familyEvents: [],
      familySnapshot: {
        ...baseSnapshot,
        members: {
          "goal-child": {
            goalId: "goal-child",
            workflowId: "workflow-child",
            rootGoalId: "goal-root",
            depth: 1,
            childGoalIds: [],
            parent: null,
          },
        },
      },
      workflows: {},
    })).toThrow(GoalFamilyRestoreError);
    try {
      assertPersistedGoalFamilyShape({
        schemaVersion: 1,
        familyEvents: [],
        familySnapshot: {
          ...baseSnapshot,
          members: {
            "goal-child": {
              goalId: "goal-child",
              workflowId: "workflow-child",
              rootGoalId: "goal-root",
              depth: 1,
              childGoalIds: [],
              parent: null,
            },
          },
        },
        workflows: {},
      });
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_parent");
    }

    expect(() => assertPersistedGoalFamilyShape({
      schemaVersion: 1,
      familyEvents: [],
      familySnapshot: baseSnapshot,
      workflows: {
        "workflow-root": {
          events: [null],
          snapshot: {},
        },
      },
    })).toThrow(GoalFamilyRestoreError);
    try {
      assertPersistedGoalFamilyShape({
        schemaVersion: 1,
        familyEvents: [],
        familySnapshot: baseSnapshot,
        workflows: {
          "workflow-root": {
            events: [null],
            snapshot: {},
          },
        },
      });
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_workflow_event");
    }

    expect(() => assertPersistedGoalFamilyShape({
      schemaVersion: 1,
      familyEvents: [],
      familySnapshot: baseSnapshot,
      workflows: {
        "workflow-root": {
          events: "not-an-array",
          snapshot: {},
        },
      },
    })).toThrow(GoalFamilyRestoreError);
    try {
      assertPersistedGoalFamilyShape({
        schemaVersion: 1,
        familyEvents: [],
        familySnapshot: baseSnapshot,
        workflows: {
          "workflow-root": {
            events: "not-an-array",
            snapshot: {},
          },
        },
      });
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_workflow_events");
    }

    expect(() => assertPersistedGoalFamilyShape({
      schemaVersion: 1,
      familyEvents: [],
      familySnapshot: baseSnapshot,
      workflows: {
        "workflow-root": {
          events: [],
        },
      },
    })).toThrow(GoalFamilyRestoreError);
    try {
      assertPersistedGoalFamilyShape({
        schemaVersion: 1,
        familyEvents: [],
        familySnapshot: baseSnapshot,
        workflows: {
          "workflow-root": {
            events: [],
          },
        },
      });
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_workflow_snapshot");
    }

    expect(() => assertPersistedGoalFamilyShape({
      schemaVersion: 1,
      familyEvents: [],
      familySnapshot: {
        ...baseSnapshot,
        members: "bad",
      },
      workflows: {},
    })).toThrow(GoalFamilyRestoreError);
    try {
      assertPersistedGoalFamilyShape({
        schemaVersion: 1,
        familyEvents: [],
        familySnapshot: {
          ...baseSnapshot,
          members: "bad",
        },
        workflows: {},
      });
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_custom_entry");
      expect((error as Error).message).toMatch(/members object/);
    }

    const entries = [{
      type: "custom",
      customType: HYPAGRAPH_FAMILY_RECORD_TYPE,
      data: {
        schemaVersion: 1,
        familyEvents: [null],
        familySnapshot: baseSnapshot,
        workflows: {},
      },
    }];
    expect(() => restoreLatestFamilySession(entries)).toThrow(GoalFamilyRestoreError);
    try {
      restoreLatestFamilySession(entries);
    } catch (error) {
      expect(error).toBeInstanceOf(GoalFamilyRestoreError);
      expect((error as GoalFamilyRestoreError).code).toBe("invalid_goal_family_event");
    }
  });
});
