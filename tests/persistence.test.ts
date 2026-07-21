import { describe, expect, it } from "vitest";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { restoreLatestSession, restoreLatestSnapshot } from "../src/persistence/session-rebuild.js";

const definition: HypagraphDefinition = {
  title: "Persist state",
  goal: "Restore state from the active branch",
  nodes: [{ id: "one", title: "One", requires: [], acceptance: [] }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
};

describe("session restoration", () => {
  it("replays the newest event stream from the supplied branch", () => {
    const created = createWorkflow(definition, "2026-07-21T00:00:00.000Z", "workflow-1");
    if (!created.ok) throw new Error("The fixture did not start.");
    const started = handleCommand(created.state, {
      type: "start-node",
      nodeId: "one",
      attemptId: "attempt-1",
      commandId: "command-1",
      at: "2026-07-21T00:01:00.000Z",
    });
    if (!started.ok) throw new Error("The fixture did not change state.");
    const events = [...created.events, ...started.events];
    const stored = { events, snapshot: started.state };
    const entries = [
      { type: "message", message: { role: "toolResult", toolName: "hypagraph_define", details: { hypagraph: { events: created.events, snapshot: created.state } } } },
      { type: "message", message: { role: "toolResult", toolName: "unrelated", details: { hypagraph: { fake: true } } } },
      { type: "message", message: { role: "toolResult", toolName: "hypagraph_transition", details: { hypagraph: stored } } },
    ];
    const restored = restoreLatestSession(entries);
    expect(restored?.snapshot.runtime.nodes.one?.status).toBe("running");
    expect(restored?.events).toEqual(events);
    expect(restored?.snapshot).not.toBe(started.state);
  });

  it("rejects a snapshot that does not match its events", () => {
    const created = createWorkflow(definition, "2026-07-21T00:00:00.000Z", "workflow-1");
    if (!created.ok) throw new Error("The fixture did not start.");
    const changed = { ...created.state, snapshotHash: "invalid" };
    const entries = [{ type: "message", message: { role: "toolResult", toolName: "hypagraph_read", details: { hypagraph: { events: created.events, snapshot: changed } } } }];
    expect(() => restoreLatestSnapshot(entries)).toThrow("does not match");
  });
});
