import { describe, expect, it, vi } from "vitest";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import {
  HYPAGRAPH_EVENT_BATCH_TYPE,
  InMemoryWorkflowEventStore,
  WorkflowSequenceConflictError,
} from "../src/persistence/event-store.js";
import { PiSessionWorkflowEventStore } from "../src/persistence/pi-session-store.js";
import { restoreLatestSession } from "../src/persistence/session-rebuild.js";

const at = "2026-07-22T14:00:00.000Z";
const definition: HypagraphDefinition = {
  title: "Store workflow",
  goal: "Test durable storage",
  nodes: [{ id: "one", title: "One", requires: [], acceptance: [] }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
};

const created = () => {
  const result = createWorkflow(definition, at, "workflow-store");
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

describe("workflow event stores", () => {
  it("rejects an optimistic sequence conflict", async () => {
    const value = created();
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: value.events, snapshot: value.state });
    const started = handleCommand(value.state, {
      type: "start-node",
      nodeId: "one",
      attemptId: "attempt-1",
      commandId: "start",
      at,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));

    await expect(store.append({
      workflowId: value.state.workflowId,
      expectedSequence: value.state.sequence - 1,
      events: started.events,
      snapshot: started.state,
    })).rejects.toBeInstanceOf(WorkflowSequenceConflictError);
  });

  it("writes a Pi custom entry and restores the append-only journal", async () => {
    const value = created();
    const entries: unknown[] = [];
    const appendEntry = vi.fn((customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    });
    const store = new PiSessionWorkflowEventStore({ appendEntry });

    await store.append({
      workflowId: value.state.workflowId,
      expectedSequence: 0,
      events: value.events,
      snapshot: value.state,
    });
    const started = handleCommand(value.state, {
      type: "start-node",
      nodeId: "one",
      attemptId: "attempt-1",
      commandId: "start",
      at,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    await store.append({
      workflowId: value.state.workflowId,
      expectedSequence: value.state.sequence,
      events: started.events,
      snapshot: started.state,
    });

    expect(appendEntry).toHaveBeenCalledTimes(2);
    expect(appendEntry.mock.calls[0]?.[0]).toBe(HYPAGRAPH_EVENT_BATCH_TYPE);
    const restored = restoreLatestSession(entries);
    expect(restored?.snapshot).toEqual(started.state);
    expect(restored?.events).toEqual([...value.events, ...started.events]);
  });

  it("detects a sequence conflict while restoring custom entries", () => {
    const value = created();
    const entries = [{
      type: "custom",
      customType: HYPAGRAPH_EVENT_BATCH_TYPE,
      data: {
        version: 1,
        workflowId: value.state.workflowId,
        expectedSequence: 1,
        events: value.events,
        snapshot: value.state,
      },
    }];
    expect(() => restoreLatestSession(entries)).toThrow("expected sequence 1");
  });
});
