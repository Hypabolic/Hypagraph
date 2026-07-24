import { describe, expect, it, vi } from "vitest";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import {
  replacementConfirmationFor,
  startRootHypagoal,
  type RootReplacementConfirmation,
} from "../src/hypagoal/root-creation.js";
import {
  HYPAGRAPH_EVENT_BATCH_TYPE,
  InMemoryWorkflowEventStore,
  WorkflowBranchChangedError,
  WorkflowSequenceConflictError,
  type WorkflowEventStore,
} from "../src/persistence/event-store.js";
import { restoreLatestSession } from "../src/persistence/session-rebuild.js";

const at = "2026-07-24T10:00:00.000Z";
const generations = { sessionGeneration: 7, branchGeneration: 3 };

const definition = (goal = "Implement atomic root goal creation"): HypagraphDefinition => ({
  title: "Atomic Hypagoal creation",
  goal,
  nodes: [
    { id: "inspect", title: "Inspect repository context", requires: [], acceptance: [] },
    { id: "implement", title: "Implement the change", requires: ["inspect"], acceptance: [] },
    { id: "independent", title: "Prepare independent documentation", requires: [], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const currentRoot = (): HypagraphState => {
  const result = createHypagoalWorkflow(definition("Existing root objective"), {
    workflowId: "workflow-existing",
    goalId: "goal-existing",
    goalWorkflowId: "workflow-existing",
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const request = (
  overrides: Partial<Parameters<typeof startRootHypagoal>[2]> = {},
): Parameters<typeof startRootHypagoal>[2] => ({
  objective: "Implement atomic root goal creation",
  definition: definition("Model supplied text is replaced"),
  workflowId: "workflow-new",
  goalId: "goal-new",
  goalWorkflowId: "workflow-new",
  at,
  ...generations,
  ...overrides,
});

describe("atomic Hypagoal creation", () => {
  it("creates the complete deterministic event batch in memory", () => {
    const result = createHypagoalWorkflow(definition(), {
      workflowId: "workflow-atomic",
      goalId: "goal-atomic",
      goalWorkflowId: "workflow-atomic",
      at,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.events.map((event) => `${event.type}:${event.nodeId ?? ""}`)).toEqual([
      "hypagraph.workflow.defined:",
      "hypagraph.node.ready:inspect",
      "hypagraph.node.ready:independent",
      "hypagraph.goal.started:",
    ]);
    expect(new Set(result.events.map((event) => event.correlationId))).toEqual(new Set(["define:workflow-atomic"]));
    expect(result.state.goal).toMatchObject({
      goalId: "goal-atomic",
      workflowId: "workflow-atomic",
      status: "active",
    });
    expect(result.state.definition.goal).toBe("Implement atomic root goal creation");
    expect(replayEvents(result.events)).toEqual(result.state);
  });

  it("persists workflow, readiness, and goal start in one append", async () => {
    const append = vi.fn<WorkflowEventStore["append"]>();
    const result = await startRootHypagoal({ append }, undefined, request());

    expect(result.kind).toBe("created");
    expect(append).toHaveBeenCalledTimes(1);
    const input = append.mock.calls[0]?.[0];
    expect(input?.expectedSequence).toBe(0);
    expect(input?.events.map((event) => event.type)).toEqual([
      "hypagraph.workflow.defined",
      "hypagraph.node.ready",
      "hypagraph.node.ready",
      "hypagraph.goal.started",
    ]);
    expect(input?.snapshot.goal?.status).toBe("active");
  });

  it("preserves the exact prose objective rather than the model definition goal", async () => {
    const objective = "  Preserve this ordinary prose objective exactly.  ";
    const store = new InMemoryWorkflowEventStore();
    const result = await startRootHypagoal(store, undefined, request({ objective }));
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.state.definition.goal).toBe(objective);
    expect(result.state.goal?.status).toBe("active");
  });

  it("replays and restores the same canonical state without running work", async () => {
    const store = new InMemoryWorkflowEventStore();
    const result = await startRootHypagoal(store, undefined, request());
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;

    const replayed = replayEvents(result.events);
    expect(replayed).toEqual(result.state);
    expect(replayed.snapshotHash).toBe(result.state.snapshotHash);
    expect(replayed.sequence).toBe(result.state.sequence);

    const restored = restoreLatestSession([{
      type: "custom",
      customType: HYPAGRAPH_EVENT_BATCH_TYPE,
      data: {
        version: 1,
        workflowId: result.state.workflowId,
        expectedSequence: 0,
        events: result.events,
        snapshot: result.state,
      },
    }]);
    expect(restored?.snapshot).toEqual(result.state);
    expect(Object.values(restored!.snapshot.runtime.nodes).every((node) => node.status === "ready" || node.status === "pending")).toBe(true);
    expect(Object.values(restored!.snapshot.runtime.nodes).some((node) => node.currentAttemptId !== undefined)).toBe(false);
  });

  it("rejects invalid graph output, invalid goal identity, and mismatched workflow identity before append", async () => {
    const append = vi.fn<WorkflowEventStore["append"]>();
    const invalidGraph = await startRootHypagoal({ append }, undefined, request({
      definition: { ...definition(), nodes: [] },
    }));
    expect(invalidGraph.kind).toBe("rejected");

    const invalidGoal = await startRootHypagoal({ append }, undefined, request({ goalId: "Invalid Goal" }));
    expect(invalidGoal.kind).toBe("rejected");

    const mismatch = await startRootHypagoal({ append }, undefined, request({ goalWorkflowId: "workflow-other" }));
    expect(mismatch.kind).toBe("rejected");
    if (mismatch.kind === "rejected") expect(mismatch.diagnostics[0]?.code).toBe("goal_workflow_mismatch");
    expect(append).not.toHaveBeenCalled();
  });

  it.each([
    ["sequence conflict", new WorkflowSequenceConflictError("workflow-new", 0, 1), "event_store_sequence_conflict"],
    ["branch conflict", new WorkflowBranchChangedError("workflow-new"), "event_store_branch_changed"],
    ["snapshot mismatch", new Error("The appended snapshot does not match the stored event stream."), "event_store_snapshot_mismatch"],
    ["restore mismatch", new Error("Replay restore mismatch."), "event_store_restore_mismatch"],
  ])("exposes no candidate state after %s", async (_name, error, code) => {
    const store: WorkflowEventStore = { append: vi.fn().mockRejectedValue(error) };
    const result = await startRootHypagoal(store, undefined, request());
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.diagnostics[0]?.code).toBe(code);
    expect("state" in result).toBe(false);
  });

  it("requires a typed replacement confirmation for an existing root", async () => {
    const append = vi.fn<WorkflowEventStore["append"]>();
    const current = currentRoot();
    const result = await startRootHypagoal({ append }, current, request());
    expect(result.kind).toBe("replacement-required");
    if (result.kind !== "replacement-required") return;
    expect(result.current).toMatchObject({
      workflowId: current.workflowId,
      goalId: current.goal?.goalId,
      objective: current.definition.goal,
      workflowRevision: current.revision,
      eventSequence: current.sequence,
      snapshotHash: current.snapshotHash,
      ...generations,
    });
    expect(result.confirmation).toEqual(replacementConfirmationFor(current, generations));
    expect(append).not.toHaveBeenCalled();
  });

  it("replaces only the exact confirmed root", async () => {
    const current = currentRoot();
    const store = new InMemoryWorkflowEventStore();
    const confirmation = replacementConfirmationFor(current, generations);
    const result = await startRootHypagoal(store, current, request({ replacementConfirmation: confirmation }));
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.replaced?.workflowId).toBe(current.workflowId);
    expect(result.state.workflowId).toBe("workflow-new");
    expect(result.state.goal?.goalId).toBe("goal-new");
  });

  it.each([
    ["eventSequence", (value: RootReplacementConfirmation) => ({ ...value, eventSequence: value.eventSequence - 1 })],
    ["snapshotHash", (value: RootReplacementConfirmation) => ({ ...value, snapshotHash: "older-hash" })],
    ["workflowRevision", (value: RootReplacementConfirmation) => ({ ...value, workflowRevision: value.workflowRevision + 1 })],
    ["sessionGeneration", (value: RootReplacementConfirmation) => ({ ...value, sessionGeneration: value.sessionGeneration - 1 })],
    ["branchGeneration", (value: RootReplacementConfirmation) => ({ ...value, branchGeneration: value.branchGeneration - 1 })],
  ])("rejects replacement confirmation bound to an older %s", async (field, mutate) => {
    const current = currentRoot();
    const append = vi.fn<WorkflowEventStore["append"]>();
    const confirmation = mutate(replacementConfirmationFor(current, generations));
    const result = await startRootHypagoal({ append }, current, request({ replacementConfirmation: confirmation }));
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.diagnostics[0]?.code).toBe("stale_replacement_confirmation");
      expect(result.diagnostics[0]?.location).toBe(`replacementConfirmation.${field}`);
    }
    expect(append).not.toHaveBeenCalled();
  });

  it("leaves the original root unchanged when replacement persistence fails", async () => {
    const current = currentRoot();
    const before = structuredClone(current);
    const store: WorkflowEventStore = { append: vi.fn().mockRejectedValue(new Error("disk unavailable")) };
    const result = await startRootHypagoal(store, current, request({
      replacementConfirmation: replacementConfirmationFor(current, generations),
    }));
    expect(result.kind).toBe("rejected");
    expect(current).toEqual(before);
  });

  it("keeps the one-root rule at the product boundary rather than the workflow domain", async () => {
    const store = new InMemoryWorkflowEventStore();
    const first = createHypagoalWorkflow(definition("First independent workflow"), {
      workflowId: "workflow-one",
      goalId: "goal-one",
      goalWorkflowId: "workflow-one",
      at,
    });
    const second = createHypagoalWorkflow(definition("Second independent workflow"), {
      workflowId: "workflow-two",
      goalId: "goal-two",
      goalWorkflowId: "workflow-two",
      at,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    await store.append({ workflowId: first.state.workflowId, expectedSequence: 0, events: first.events, snapshot: first.state });
    await store.append({ workflowId: second.state.workflowId, expectedSequence: 0, events: second.events, snapshot: second.state });
    expect(store.read("workflow-one")?.snapshot.goal?.goalId).toBe("goal-one");
    expect(store.read("workflow-two")?.snapshot.goal?.goalId).toBe("goal-two");
  });
});
