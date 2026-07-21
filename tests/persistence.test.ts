import { describe, expect, it } from "vitest";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, reduceHypagraph } from "../src/domain/reducer.js";
import { restoreLatestSnapshot } from "../src/persistence/session-rebuild.js";

const definition: HypagraphDefinition = {
  title: "Persist state",
  goal: "Restore state from the active branch",
  nodes: [{ id: "one", title: "One", requires: [], acceptance: [] }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
};

describe("session restoration", () => {
  it("restores the newest Hypagraph snapshot from the supplied branch", () => {
    const created = createWorkflow(definition, "2026-07-19T00:00:00.000Z", "workflow-1");
    if (!created.ok) throw new Error("The fixture did not start.");
    const started = reduceHypagraph(created.state, {
      type: "transition",
      nodeId: "one",
      action: "start",
      at: "2026-07-19T00:01:00.000Z",
    });
    if (!started.ok) throw new Error("The fixture did not change state.");

    const entries = [
      { type: "message", message: { role: "toolResult", toolName: "hypagraph_define", details: { hypagraph: created.state } } },
      { type: "message", message: { role: "toolResult", toolName: "unrelated", details: { hypagraph: { fake: true } } } },
      { type: "message", message: { role: "toolResult", toolName: "hypagraph_transition", details: { hypagraph: started.state } } },
    ];

    const restored = restoreLatestSnapshot(entries);
    expect(restored?.runtime.nodes.one?.status).toBe("active");
    expect(restored).not.toBe(started.state);
  });

  it("rejects a snapshot with an unsupported schema version", () => {
    const created = createWorkflow(definition, "2026-07-19T00:00:00.000Z", "workflow-1");
    if (!created.ok) throw new Error("The fixture did not start.");
    const unsupported = { ...created.state, schemaVersion: 999 };
    const entries = [{ type: "message", message: { role: "toolResult", toolName: "hypagraph_read", details: { hypagraph: unsupported } } }];
    expect(restoreLatestSnapshot(entries)).toBeUndefined();
  });
});
