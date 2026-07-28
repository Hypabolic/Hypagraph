import { describe, expect, it } from "vitest";
import {
  GOAL_FAMILY_EVENT_VERSION,
  GOAL_FAMILY_SCHEMA_VERSION,
  GoalFamilyRestoreError,
  UnsupportedGoalFamilyEventVersionError,
  UnsupportedGoalFamilySchemaError,
  addFamilyMember,
  applyFamilyEvent,
  createRootFamily,
  rebuildFamilyMembershipFromSnapshot,
  replayFamilyEvents,
  restoreFamilyProjection,
  type GoalFamilyEvent,
  type GoalFamilyRuntime,
} from "../src/domain/goal-family.js";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { InMemoryWorkflowEventStore } from "../src/persistence/event-store.js";
import {
  InMemoryGoalFamilyStore,
  buildOneMemberPersistedFamily,
  restorePersistedGoalFamily,
  type PersistedGoalFamily,
} from "../src/persistence/family-store.js";

const at = "2026-07-29T12:00:00.000Z";
const later = "2026-07-29T12:05:00.000Z";

const definition: HypagraphDefinition = {
  title: "Family root workflow",
  goal: "Persist a one-member goal family",
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

const createRootOnly = () => {
  const root = createRootFamily({
    familyId: "family-1",
    rootGoalId: "goal-root",
    rootWorkflowId: "workflow-root",
    at,
  });
  if (!root.ok) throw new Error(JSON.stringify(root.diagnostics));
  return root;
};

describe("goal family domain helpers", () => {
  it("creates a one-member family and rebuilds membership from events", () => {
    const created = createRootOnly();

    expect(created.family.schemaVersion).toBe(GOAL_FAMILY_SCHEMA_VERSION);
    expect(created.family.rootGoalId).toBe("goal-root");
    expect(Object.keys(created.family.members)).toEqual(["goal-root"]);
    expect(created.family.members["goal-root"]).toMatchObject({
      goalId: "goal-root",
      workflowId: "workflow-root",
      rootGoalId: "goal-root",
      depth: 0,
      childGoalIds: [],
    });
    expect(created.family.members["goal-root"]?.parent).toBeUndefined();

    const rebuilt = replayFamilyEvents(created.events);
    expect(rebuilt).toEqual(created.family);
    expect(rebuildFamilyMembershipFromSnapshot(created.family)).toEqual(created.family);
  });

  it("rebuilds multi-member membership from family events without child-creation product flow", () => {
    const root = createRootFamily({
      familyId: "family-multi",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
    });
    if (!root.ok) throw new Error(JSON.stringify(root.diagnostics));

    const child = addFamilyMember({
      family: root.family,
      goalId: "goal-child",
      workflowId: "workflow-child",
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "one",
      },
      at: later,
    });
    if (!child.ok) throw new Error(JSON.stringify(child.diagnostics));

    const grandchild = addFamilyMember({
      family: child.family,
      goalId: "goal-grandchild",
      workflowId: "workflow-grandchild",
      parent: {
        parentGoalId: "goal-child",
        parentWorkflowId: "workflow-child",
        parentNodeId: "one",
      },
      at: "2026-07-29T12:10:00.000Z",
    });
    if (!grandchild.ok) throw new Error(JSON.stringify(grandchild.diagnostics));

    const events = [...root.events, ...child.events, ...grandchild.events];
    const rebuilt = restoreFamilyProjection(events, grandchild.family);

    expect(rebuilt.members["goal-root"]?.childGoalIds).toEqual(["goal-child"]);
    expect(rebuilt.members["goal-child"]).toMatchObject({
      depth: 1,
      rootGoalId: "goal-root",
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "one",
      },
      childGoalIds: ["goal-grandchild"],
    });
    expect(rebuilt.members["goal-grandchild"]).toMatchObject({
      depth: 2,
      rootGoalId: "goal-root",
      parent: {
        parentGoalId: "goal-child",
        parentWorkflowId: "workflow-child",
        parentNodeId: "one",
      },
      childGoalIds: [],
    });
    expect(Object.keys(rebuilt.members).sort()).toEqual([
      "goal-child",
      "goal-grandchild",
      "goal-root",
    ]);
  });

  it("rejects an unsupported goal-family schema version with a clear error", () => {
    const created = createRootOnly();
    const unsupported = {
      ...created.family,
      schemaVersion: 99 as typeof GOAL_FAMILY_SCHEMA_VERSION,
    };

    expect(() => rebuildFamilyMembershipFromSnapshot(unsupported)).toThrow(UnsupportedGoalFamilySchemaError);
    expect(() => rebuildFamilyMembershipFromSnapshot(unsupported)).toThrow(
      /Unsupported goal-family schema version '99'.*Expected schema version 1/,
    );
  });

  it("rejects add-member when the parent goal is missing", () => {
    const root = createRootOnly();
    const added = addFamilyMember({
      family: root.family,
      goalId: "goal-child",
      workflowId: "workflow-child",
      parent: {
        parentGoalId: "missing-parent",
        parentWorkflowId: "workflow-root",
        parentNodeId: "one",
      },
      at: later,
    });

    expect(added.ok).toBe(false);
    if (added.ok) throw new Error("Expected rejection.");
    expect(added.diagnostics[0]?.code).toBe("goal_family_parent_missing");
  });

  it("rejects add-member when the member goal already exists", () => {
    const root = createRootOnly();
    const added = addFamilyMember({
      family: root.family,
      goalId: "goal-root",
      workflowId: "workflow-other",
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "one",
      },
      at: later,
    });

    expect(added.ok).toBe(false);
    if (added.ok) throw new Error("Expected rejection.");
    expect(added.diagnostics[0]?.code).toBe("goal_family_member_exists");
  });

  it("rejects add-member when the workflow ID is already in use", () => {
    const root = createRootOnly();
    const added = addFamilyMember({
      family: root.family,
      goalId: "goal-child",
      workflowId: "workflow-root",
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "one",
      },
      at: later,
    });

    expect(added.ok).toBe(false);
    if (added.ok) throw new Error("Expected rejection.");
    expect(added.diagnostics[0]?.code).toBe("goal_family_workflow_in_use");
  });

  it("rejects replay when a second member reuses a workflow ID", () => {
    const root = createRootOnly();
    const badEvent = {
      eventId: "dup-workflow",
      familyId: "family-1",
      sequence: 2,
      type: "hypagraph.family.member-added" as const,
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: later,
      causationId: "c",
      correlationId: "c",
      data: {
        goalId: "goal-child",
        workflowId: "workflow-root",
        parent: {
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: "one",
        },
        depth: 1,
      },
    };

    expect(() => applyFamilyEvent(root.family, badEvent)).toThrow(GoalFamilyRestoreError);
    expect(() => applyFamilyEvent(root.family, badEvent)).toThrow(/already uses workflow 'workflow-root'/);
    try {
      applyFamilyEvent(root.family, badEvent);
    } catch (error) {
      expect(error).toBeInstanceOf(GoalFamilyRestoreError);
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_workflow_in_use");
    }
  });

  it("rejects add-member when the parent workflow binding is wrong", () => {
    const root = createRootOnly();
    const added = addFamilyMember({
      family: root.family,
      goalId: "goal-child",
      workflowId: "workflow-child",
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-wrong",
        parentNodeId: "one",
      },
      at: later,
    });

    expect(added.ok).toBe(false);
    if (added.ok) throw new Error("Expected rejection.");
    expect(added.diagnostics[0]?.code).toBe("goal_family_parent_workflow_mismatch");
  });

  it("rejects add-member with a diagnostic when the family schema is unsupported", () => {
    const root = createRootOnly();
    const added = addFamilyMember({
      family: { ...root.family, schemaVersion: 99 as typeof GOAL_FAMILY_SCHEMA_VERSION },
      goalId: "goal-child",
      workflowId: "workflow-child",
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "one",
      },
      at: later,
    });

    expect(added.ok).toBe(false);
    if (added.ok) throw new Error("Expected rejection.");
    expect(added.diagnostics[0]?.code).toBe("unsupported_goal_family_schema");
  });

  it("rejects create when an identity field is empty", () => {
    const created = createRootFamily({
      familyId: "",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
    });
    expect(created.ok).toBe(false);
    if (created.ok) throw new Error("Expected rejection.");
    expect(created.diagnostics[0]?.code).toBe("invalid_goal_family_id");
  });

  it("rejects create when the timestamp is invalid", () => {
    const created = createRootFamily({
      familyId: "family-1",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at: "not-a-date",
    });
    expect(created.ok).toBe(false);
    if (created.ok) throw new Error("Expected rejection.");
    expect(created.diagnostics[0]?.code).toBe("invalid_goal_family_timestamp");
  });

  it("rejects replay of an unknown family event type", () => {
    const root = createRootOnly();
    const unknown = {
      ...root.events[0]!,
      type: "hypagraph.family.unknown",
      sequence: 2,
      eventId: "unknown-event",
      data: {},
    } as unknown as GoalFamilyEvent;

    expect(() => applyFamilyEvent(root.family, unknown)).toThrow(GoalFamilyRestoreError);
    expect(() => applyFamilyEvent(root.family, unknown)).toThrow(/Unsupported goal-family event type/);
    try {
      applyFamilyEvent(root.family, unknown);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("unsupported_goal_family_event_type");
    }
  });

  it("rejects an unsupported family event version with a typed error", () => {
    const root = createRootOnly();
    const badVersion = {
      ...root.events[0]!,
      version: 99 as typeof GOAL_FAMILY_EVENT_VERSION,
    };

    expect(() => applyFamilyEvent(undefined, badVersion)).toThrow(UnsupportedGoalFamilyEventVersionError);
    expect(() => applyFamilyEvent(undefined, badVersion)).toThrow(
      /Unsupported goal-family event version '99'.*Expected event version 1/,
    );
  });

  it("rejects an empty family event stream", () => {
    expect(() => replayFamilyEvents([])).toThrow(GoalFamilyRestoreError);
    expect(() => replayFamilyEvents([])).toThrow(/event stream is empty/);
  });

  it("rejects a sequence gap during replay", () => {
    const root = createRootOnly();
    const gapEvent: GoalFamilyEvent = {
      eventId: "gap",
      familyId: "family-1",
      sequence: 3,
      type: "hypagraph.family.member-added",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: later,
      causationId: "c",
      correlationId: "c",
      data: {
        goalId: "goal-child",
        workflowId: "workflow-child",
        parent: {
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: "one",
        },
        depth: 1,
      },
    };

    expect(() => applyFamilyEvent(root.family, gapEvent)).toThrow(/expected sequence 2, but received 3/);
    try {
      applyFamilyEvent(root.family, gapEvent);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_sequence_mismatch");
    }
  });

  it("rejects restore when the snapshot membership does not match events", () => {
    const root = createRootOnly();
    const child = addFamilyMember({
      family: root.family,
      goalId: "goal-child",
      workflowId: "workflow-child",
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "one",
      },
      at: later,
    });
    if (!child.ok) throw new Error(JSON.stringify(child.diagnostics));

    const mismatchedSnapshot: GoalFamilyRuntime = structuredClone(child.family);
    mismatchedSnapshot.members["goal-child"]!.workflowId = "workflow-other";
    expect(() => restoreFamilyProjection([...root.events, ...child.events], mismatchedSnapshot)).toThrow(
      GoalFamilyRestoreError,
    );
    expect(() => restoreFamilyProjection([...root.events, ...child.events], mismatchedSnapshot)).toThrow(
      /does not match the stored snapshot/,
    );
  });

  it("rejects replay when a member identity field is empty", () => {
    const root = createRootOnly();
    const emptyId: GoalFamilyEvent = {
      eventId: "empty-member",
      familyId: "family-1",
      sequence: 2,
      type: "hypagraph.family.member-added",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: later,
      causationId: "c",
      correlationId: "c",
      data: {
        goalId: "  ",
        workflowId: "workflow-child",
        parent: {
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: "one",
        },
        depth: 1,
      },
    };

    expect(() => applyFamilyEvent(root.family, emptyId)).toThrow(GoalFamilyRestoreError);
    expect(() => applyFamilyEvent(root.family, emptyId)).toThrow(/member goal ID must be a non-empty string/);
  });

  it("rejects a snapshot-only rebuild when child links are inconsistent", () => {
    const root = createRootOnly();
    const child = addFamilyMember({
      family: root.family,
      goalId: "goal-child",
      workflowId: "workflow-child",
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "one",
      },
      at: later,
    });
    if (!child.ok) throw new Error(JSON.stringify(child.diagnostics));

    const broken = structuredClone(child.family);
    broken.members["goal-root"]!.childGoalIds = [];

    expect(() => rebuildFamilyMembershipFromSnapshot(broken)).toThrow(GoalFamilyRestoreError);
    expect(() => rebuildFamilyMembershipFromSnapshot(broken)).toThrow(/does not list child/);
  });
});

describe("goal family persistence above workflow aggregates", () => {
  it("persists and restores a one-member family with membership rebuilt", async () => {
    const created = createRootWorkflow();
    const workflow = { events: created.events, snapshot: created.state };
    const store = new InMemoryGoalFamilyStore();

    const saved = await store.saveOneMemberFamily({
      familyId: "family-one",
      rootGoalId: "goal-root",
      workflow,
      at,
    });

    expect(saved.schemaVersion).toBe(GOAL_FAMILY_SCHEMA_VERSION);
    expect(saved.familySnapshot.members["goal-root"]?.workflowId).toBe(created.state.workflowId);
    expect(Object.keys(saved.workflows)).toEqual([created.state.workflowId]);

    const restored = await store.load("family-one");
    expect(restored).toBeDefined();
    expect(restored?.familySnapshot).toEqual(saved.familySnapshot);
    expect(restored?.familySnapshot.members["goal-root"]).toMatchObject({
      goalId: "goal-root",
      workflowId: "workflow-root",
      depth: 0,
      childGoalIds: [],
    });
    expect(restored?.workflows[created.state.workflowId]?.events).toEqual(created.events);
    expect(restored?.workflows[created.state.workflowId]?.snapshot.snapshotHash).toBe(created.state.snapshotHash);
  });

  it("returns the canonical restored record from saveOneMemberFamily", async () => {
    const created = createRootWorkflow();
    const store = new InMemoryGoalFamilyStore();
    const saved = await store.saveOneMemberFamily({
      familyId: "family-canonical",
      rootGoalId: "goal-root",
      workflow: { events: created.events, snapshot: created.state },
      at,
    });
    const loaded = await store.load("family-canonical");
    expect(loaded).toEqual(saved);
  });

  it("restores multi-member membership from a stored family record", async () => {
    const rootWorkflow = createRootWorkflow("workflow-root", "goal-root");
    const childWorkflow = createRootWorkflow("workflow-child", "goal-child");

    const root = createRootFamily({
      familyId: "family-two",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
    });
    if (!root.ok) throw new Error(JSON.stringify(root.diagnostics));

    const withChild = addFamilyMember({
      family: root.family,
      goalId: "goal-child",
      workflowId: "workflow-child",
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "one",
      },
      at: later,
    });
    if (!withChild.ok) throw new Error(JSON.stringify(withChild.diagnostics));

    const record: PersistedGoalFamily = {
      schemaVersion: GOAL_FAMILY_SCHEMA_VERSION,
      familyEvents: [...root.events, ...withChild.events],
      familySnapshot: withChild.family,
      workflows: {
        "workflow-root": { events: rootWorkflow.events, snapshot: rootWorkflow.state },
        "workflow-child": { events: childWorkflow.events, snapshot: childWorkflow.state },
      },
    };

    const store = new InMemoryGoalFamilyStore();
    await store.save(record);
    const restored = await store.load("family-two");

    expect(restored?.familySnapshot.members["goal-root"]?.childGoalIds).toEqual(["goal-child"]);
    expect(restored?.familySnapshot.members["goal-child"]?.depth).toBe(1);
    expect(Object.keys(restored?.workflows ?? {}).sort()).toEqual(["workflow-child", "workflow-root"]);
  });

  it("rejects load of an unsupported family schema version with a clear error", async () => {
    const created = createRootWorkflow();
    const record = buildOneMemberPersistedFamily({
      familyId: "family-bad-schema",
      rootGoalId: "goal-root",
      workflow: { events: created.events, snapshot: created.state },
      at,
    });

    const unsupported: PersistedGoalFamily = {
      ...record,
      schemaVersion: 99 as typeof GOAL_FAMILY_SCHEMA_VERSION,
      familySnapshot: {
        ...record.familySnapshot,
        schemaVersion: 99 as typeof GOAL_FAMILY_SCHEMA_VERSION,
      },
    };

    const store = new InMemoryGoalFamilyStore();
    store.seed(unsupported);

    await expect(store.load("family-bad-schema")).rejects.toBeInstanceOf(UnsupportedGoalFamilySchemaError);
    await expect(store.load("family-bad-schema")).rejects.toThrow(
      /Unsupported goal-family schema version '99'.*Expected schema version 1/,
    );
    expect(() => restorePersistedGoalFamily(unsupported)).toThrow(UnsupportedGoalFamilySchemaError);
  });

  it("does not rewrite workflow event history when a family wraps an existing root", async () => {
    const created = createRootWorkflow();
    const originalEvents = structuredClone(created.events);
    const originalHash = created.state.snapshotHash;

    const workflowStore = new InMemoryWorkflowEventStore();
    workflowStore.seed({ events: created.events, snapshot: created.state });

    const beforeWrap = workflowStore.read(created.state.workflowId);
    expect(beforeWrap?.events).toEqual(originalEvents);

    const familyStore = new InMemoryGoalFamilyStore(workflowStore);
    const family = await familyStore.saveOneMemberFamily({
      familyId: "family-wrap",
      rootGoalId: "goal-root",
      workflow: beforeWrap!,
      at,
    });

    const afterWrap = workflowStore.read(created.state.workflowId);
    expect(afterWrap?.events).toEqual(originalEvents);
    expect(afterWrap?.snapshot.snapshotHash).toBe(originalHash);
    expect(family.workflows[created.state.workflowId]?.events).toEqual(originalEvents);

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

    const afterWorkflowProgress = workflowStore.read(created.state.workflowId);
    expect(afterWorkflowProgress?.events).toEqual([...originalEvents, ...started.events]);

    const restoredFamily = await familyStore.load("family-wrap");
    expect(restoredFamily?.workflows[created.state.workflowId]?.events).toEqual(originalEvents);
    expect(restoredFamily?.workflows[created.state.workflowId]?.events).not.toEqual(
      afterWorkflowProgress?.events,
    );
  });

  it("keeps a deep clone of workflow history when the caller mutates the source after wrap", () => {
    const created = createRootWorkflow();
    const workflow = { events: created.events, snapshot: created.state };
    const originalLength = workflow.events.length;

    const record = buildOneMemberPersistedFamily({
      familyId: "family-clone",
      rootGoalId: "goal-root",
      workflow,
      at,
    });

    workflow.events.push({
      ...created.events[0]!,
      eventId: "mutated-after-wrap",
      sequence: created.events[0]!.sequence + 100,
    });

    expect(record.workflows[created.state.workflowId]?.events).toHaveLength(originalLength);
    expect(record.workflows[created.state.workflowId]?.events).not.toBe(workflow.events);
  });

  it("rejects a family record when a member workflow is missing", () => {
    const created = createRootWorkflow();
    const record = buildOneMemberPersistedFamily({
      familyId: "family-missing-workflow",
      rootGoalId: "goal-root",
      workflow: { events: created.events, snapshot: created.state },
      at,
    });

    const broken: PersistedGoalFamily = {
      ...record,
      workflows: {},
    };

    expect(() => restorePersistedGoalFamily(broken)).toThrow(GoalFamilyRestoreError);
    expect(() => restorePersistedGoalFamily(broken)).toThrow(/missing workflow/);
  });

  it("rejects restore when a nested workflow snapshot does not match its events", () => {
    const created = createRootWorkflow();
    const record = buildOneMemberPersistedFamily({
      familyId: "family-bad-nested",
      rootGoalId: "goal-root",
      workflow: { events: created.events, snapshot: created.state },
      at,
    });

    const broken: PersistedGoalFamily = {
      ...record,
      workflows: {
        [created.state.workflowId]: {
          events: created.events,
          snapshot: { ...created.state, snapshotHash: "corrupt-hash" },
        },
      },
    };

    expect(() => restorePersistedGoalFamily(broken)).toThrow(GoalFamilyRestoreError);
    expect(() => restorePersistedGoalFamily(broken)).toThrow(
      /workflow 'workflow-root' snapshot does not match its event stream/,
    );
    try {
      restorePersistedGoalFamily(broken);
    } catch (error) {
      expect((error as GoalFamilyRestoreError).code).toBe("goal_family_workflow_snapshot_mismatch");
    }
  });

  it("rejects wrap when the workflow has no goal runtime", () => {
    const defined = createWorkflow(definition, at, "workflow-no-goal");
    if (!defined.ok) throw new Error(JSON.stringify(defined.diagnostics));

    expect(() => buildOneMemberPersistedFamily({
      familyId: "family-no-goal",
      rootGoalId: "goal-root",
      workflow: { events: defined.events, snapshot: defined.state },
      at,
    })).toThrow(GoalFamilyRestoreError);
    expect(() => buildOneMemberPersistedFamily({
      familyId: "family-no-goal",
      rootGoalId: "goal-root",
      workflow: { events: defined.events, snapshot: defined.state },
      at,
    })).toThrow(/has no goal runtime/);
  });

  it("rejects wrap when the root goal ID does not match the workflow goal", () => {
    const created = createRootWorkflow();
    expect(() => buildOneMemberPersistedFamily({
      familyId: "family-goal-mismatch",
      rootGoalId: "other-goal",
      workflow: { events: created.events, snapshot: created.state },
      at,
    })).toThrow(GoalFamilyRestoreError);
    expect(() => buildOneMemberPersistedFamily({
      familyId: "family-goal-mismatch",
      rootGoalId: "other-goal",
      workflow: { events: created.events, snapshot: created.state },
      at,
    })).toThrow(/does not match workflow goal/);
  });

  it("rejects wrap when the goal workflow ID does not match the snapshot workflow ID", () => {
    const created = createRootWorkflow();
    if (!created.state.goal) throw new Error("The fixture must include a goal runtime.");
    const split = {
      events: created.events,
      snapshot: {
        ...created.state,
        goal: { ...created.state.goal, workflowId: "workflow-other" },
      },
    };

    expect(() => buildOneMemberPersistedFamily({
      familyId: "family-goal-workflow-split",
      rootGoalId: "goal-root",
      workflow: split,
      at,
    })).toThrow(GoalFamilyRestoreError);
    expect(() => buildOneMemberPersistedFamily({
      familyId: "family-goal-workflow-split",
      rootGoalId: "goal-root",
      workflow: split,
      at,
    })).toThrow(/targets workflow 'workflow-other'/);
  });
});
