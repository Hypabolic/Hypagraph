import { afterEach, describe, expect, it } from "vitest";
import {
  configureHostRoutingForTests,
  getHostRoutingOptions,
  resetHostRoutingOptionsForTests,
} from "../src/pi/host-routing-options.js";
import { resolveModelNodeExecutorProfile } from "../src/domain/model-executor-profile.js";
import { routeRootModelLaneAction } from "../src/pi/isolated-root-dispatch.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";

const at = "2026-07-31T14:00:00.000Z";

afterEach(() => {
  // Suite setup wants legacy true for old fixtures; restore that after pure tests.
  configureHostRoutingForTests({ legacyCurrentSessionDefault: true });
});

describe("host routing options (no production env override)", () => {
  it("defaults to isolated-pi when tests inject product defaults", () => {
    configureHostRoutingForTests({ legacyCurrentSessionDefault: false });
    expect(getHostRoutingOptions().legacyCurrentSessionDefault).toBe(false);
    const resolved = resolveModelNodeExecutorProfile({
      node: { id: "work" },
      legacyCurrentSessionDefault: getHostRoutingOptions().legacyCurrentSessionDefault,
    });
    expect(resolved.profile.kind).toBe("isolated-pi");
    expect(resolved.source).toBe("default");
  });

  it("does not read HYPAGRAPH_LEGACY_CURRENT_SESSION from the environment for profile resolution", () => {
    configureHostRoutingForTests({ legacyCurrentSessionDefault: false });
    const previous = process.env.HYPAGRAPH_LEGACY_CURRENT_SESSION;
    process.env.HYPAGRAPH_LEGACY_CURRENT_SESSION = "1";
    try {
      const resolved = resolveModelNodeExecutorProfile({
        node: { id: "work" },
        legacyCurrentSessionDefault: getHostRoutingOptions().legacyCurrentSessionDefault,
      });
      // Production-style call uses host options, not the ambient env var.
      expect(resolved.profile.kind).toBe("isolated-pi");
    } finally {
      if (previous === undefined) delete process.env.HYPAGRAPH_LEGACY_CURRENT_SESSION;
      else process.env.HYPAGRAPH_LEGACY_CURRENT_SESSION = previous;
    }
  });

  it("still supports explicit current-session opt-in on the node", () => {
    configureHostRoutingForTests({ legacyCurrentSessionDefault: false });
    const resolved = resolveModelNodeExecutorProfile({
      node: {
        id: "work",
        executorProfile: { profileId: "current-session-default", kind: "current-session" },
      },
      legacyCurrentSessionDefault: false,
    });
    expect(resolved.profile.kind).toBe("current-session");
    expect(resolved.source).toBe("node");
  });

  it("routes start-ready-task to isolated-worker under product defaults", () => {
    configureHostRoutingForTests({ legacyCurrentSessionDefault: false });
    const definition: HypagraphDefinition = {
      title: "Route",
      goal: "Route one task",
      nodes: [{ id: "work", title: "Work", requires: [], acceptance: [] }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = createWorkflow(definition, at, "route-workflow");
    if (!created.ok) throw new Error("create failed");
    const started = handleCommand(created.state, {
      type: "start-goal",
      goalId: "goal-route",
      commandId: "start",
      at,
    });
    if (!started.ok) throw new Error("start failed");
    const state = started.state as HypagraphState;
    const decision = {
      kind: "start-ready-task" as const,
      goalId: state.goal!.goalId,
      workflowId: state.workflowId,
      revision: state.revision,
      sequence: state.sequence,
      snapshotHash: state.snapshotHash,
      continuationOrdinal: state.goal!.continuationOrdinal,
      nodeId: "work",
    };
    const routing = routeRootModelLaneAction(decision, state, {
      legacyCurrentSessionDefault: getHostRoutingOptions().legacyCurrentSessionDefault,
    });
    expect(routing.kind).toBe("isolated-worker");
  });
});
