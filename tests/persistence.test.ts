import { describe, expect, it } from "vitest";
import type { WorkGraphDefinition } from "../src/domain/model.js";
import { createWorkflow, reduceWorkGraph } from "../src/domain/reducer.js";
import { restoreLatestSnapshot } from "../src/persistence/session-rebuild.js";

const definition: WorkGraphDefinition = {
  title: "Persist me",
  goal: "Survive branch restoration",
  nodes: [{ id: "one", title: "One", requires: [], acceptance: [] }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
};

describe("session reconstruction", () => {
  it("restores the latest Workgraph snapshot on the supplied branch", () => {
    const created = createWorkflow(definition, "2026-07-19T00:00:00.000Z", "workflow-1");
    if (!created.ok) throw new Error("failed to create fixture");
    const started = reduceWorkGraph(created.state, {
      type: "transition",
      nodeId: "one",
      action: "start",
      at: "2026-07-19T00:01:00.000Z",
    });
    if (!started.ok) throw new Error("failed to transition fixture");

    const entries = [
      { type: "message", message: { role: "toolResult", toolName: "workgraph_define", details: { workgraph: created.state } } },
      { type: "message", message: { role: "toolResult", toolName: "unrelated", details: { workgraph: { fake: true } } } },
      { type: "message", message: { role: "toolResult", toolName: "workgraph_transition", details: { workgraph: started.state } } },
    ];

    const restored = restoreLatestSnapshot(entries);
    expect(restored?.runtime.nodes.one?.status).toBe("active");
    expect(restored).not.toBe(started.state);
  });
});
