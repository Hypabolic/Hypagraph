import { describe, expect, it } from "vitest";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import { dispatchReadyGate, isReadyGateDecision } from "../src/domain/deterministic-gate-dispatch.js";
import { isRunnableGoalContinuation, selectGoalContinuation } from "../src/domain/goal-continuation.js";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { handleCommand } from "../src/domain/reducer.js";
import { dispatchReadyGateAndCommit } from "../src/persistence/coordinator.js";
import { InMemoryWorkflowEventStore } from "../src/persistence/event-store.js";

const at = "2026-07-25T12:30:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Direct gate with independent work",
  goal: "Route work and preserve independent fairness",
  nodes: [
    {
      id: "route",
      title: "Select route",
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
    { id: "selected", title: "Selected work", requires: ["route"], acceptance: [] },
    { id: "rejected", title: "Rejected work", requires: ["route"], acceptance: [] },
    { id: "independent", title: "Independent work", requires: [], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const create = () => {
  const result = createHypagoalWorkflow(definition(), {
    workflowId: "direct-gate-workflow",
    goalId: "direct-gate-goal",
    goalWorkflowId: "direct-gate-workflow",
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const readyGate = (state: ReturnType<typeof create>["state"]) => {
  const decision = selectGoalContinuation(state);
  if (!isRunnableGoalContinuation(decision) || !isReadyGateDecision(decision)) {
    throw new Error(`Expected a ready gate, received '${decision.kind}'.`);
  }
  return decision;
};

describe("M6A Slice 2 deterministic gate dispatch", () => {
  it("persists the full deterministic lifecycle and the existing route semantics", () => {
    const created = create();
    const decision = readyGate(created.state);
    const result = dispatchReadyGate(created.state, {
      dispatchId: "gate-dispatch-1",
      decision,
      at,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(result.outcome).toBe("completed");
    expect(result.events.map((event) => event.type)).toEqual([
      "hypagraph.action.selected",
      "hypagraph.action.dispatched",
      "hypagraph.route.selected",
      "hypagraph.node.skipped",
      "hypagraph.node.ready",
      "hypagraph.action.completed",
    ]);
    expect(result.state.runtime.routes.route).toMatchObject({
      outcomeId: "true",
      targetNodeIds: ["selected"],
      factsUsed: [],
    });
    expect(result.state.runtime.nodes.rejected?.status).toBe("skipped");
    expect(result.state.runtime.nodes.selected?.status).toBe("ready");
    expect(result.state.goal?.budget.consumedTurns).toBe(0);
    expect(result.state.goal?.schedulerOrdinal).toBe(1);
    expect(result.state.goal?.continuationOrdinal).toBe(1);
    expect(result.state.goal?.actionDispatch?.lastOutcome).toMatchObject({
      dispatchId: "gate-dispatch-1",
      lane: "deterministic",
      status: "completed",
      schedulerOrdinal: 1,
    });

    const manual = handleCommand(created.state, {
      type: "evaluate-gate",
      nodeId: "route",
      commandId: "manual-route",
      at,
    });
    if (!manual.ok) throw new Error(JSON.stringify(manual.diagnostics));
    const directRoute = result.events.find((event) => event.type === "hypagraph.route.selected");
    const manualRoute = manual.events.find((event) => event.type === "hypagraph.route.selected");
    expect(directRoute?.data).toEqual(manualRoute?.data);

    expect(replayEvents([...created.events, ...result.events])).toEqual(result.state);
  });

  it("rotates to an independent component after the deterministic gate", () => {
    const created = create();
    const result = dispatchReadyGate(created.state, {
      dispatchId: "gate-dispatch-fairness",
      decision: readyGate(created.state),
      at,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(selectGoalContinuation(result.state)).toMatchObject({
      kind: "start-ready-task",
      nodeId: "independent",
      continuationOrdinal: 1,
    });
  });

  it("commits the deterministic lifecycle atomically", async () => {
    const created = create();
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: created.events, snapshot: created.state });

    const result = await dispatchReadyGateAndCommit(store, created.state, {
      dispatchId: "gate-dispatch-store",
      decision: readyGate(created.state),
      at,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    const stored = store.read(created.state.workflowId);
    expect(stored?.snapshot).toEqual(result.state);
    expect(stored?.events.slice(created.events.length).map((event) => event.type)).toEqual(
      result.events.map((event) => event.type),
    );
  });

  it("rejects a stale selected gate without producing events", () => {
    const created = create();
    const decision = readyGate(created.state);
    const changed = handleCommand(created.state, {
      type: "pause-goal",
      reason: "Change canonical state.",
      commandId: "pause-before-dispatch",
      at,
    });
    if (!changed.ok) throw new Error(JSON.stringify(changed.diagnostics));

    const result = dispatchReadyGate(changed.state, {
      dispatchId: "stale-gate-dispatch",
      decision,
      at,
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: "goal_not_active" }],
    });
  });
});
