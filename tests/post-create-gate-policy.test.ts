import { describe, expect, it } from "vitest";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import {
  goalHasNeverDispatchedNode,
  shouldReopenPostCreateGate,
} from "../src/pi/post-create-gate-policy.js";

const at = "2026-07-31T14:30:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Gate policy",
  goal: "Never dispatched until Run",
  nodes: [{ id: "work", title: "Work", requires: [], acceptance: [] }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

describe("post-create gate policy", () => {
  it("treats a freshly started goal as never dispatched", () => {
    const created = createWorkflow(definition(), at, "gate-policy");
    if (!created.ok) throw new Error("create failed");
    const started = handleCommand(created.state, {
      type: "start-goal",
      goalId: "goal-gate",
      commandId: "start",
      at,
    });
    if (!started.ok) throw new Error("start failed");
    expect(goalHasNeverDispatchedNode(started.state)).toBe(true);
    expect(shouldReopenPostCreateGate(started.state)).toBe(true);
  });

  it("returns false after a node attempt starts", () => {
    const created = createWorkflow(definition(), at, "gate-policy-2");
    if (!created.ok) throw new Error("create failed");
    let state = handleCommand(created.state, {
      type: "start-goal",
      goalId: "goal-gate-2",
      commandId: "start",
      at,
    });
    if (!state.ok) throw new Error("start failed");
    state = handleCommand(state.state, {
      type: "start-node",
      nodeId: "work",
      attemptId: "a1",
      commandId: "start-node",
      at,
    });
    if (!state.ok) throw new Error("start-node failed");
    expect(goalHasNeverDispatchedNode(state.state)).toBe(false);
    expect(shouldReopenPostCreateGate(state.state)).toBe(false);
  });

  it("reopens for a paused goal that never dispatched", () => {
    const created = createWorkflow(definition(), at, "gate-policy-3");
    if (!created.ok) throw new Error("create failed");
    let state = handleCommand(created.state, {
      type: "start-goal",
      goalId: "goal-gate-3",
      commandId: "start",
      at,
    });
    if (!state.ok) throw new Error("start failed");
    state = handleCommand(state.state, {
      type: "pause-goal",
      cause: "session_reload",
      reason: "reload",
      commandId: "pause",
      at,
    });
    if (!state.ok) throw new Error("pause failed");
    expect(state.state.goal?.status).toBe("paused");
    expect(shouldReopenPostCreateGate(state.state)).toBe(true);
  });
});
