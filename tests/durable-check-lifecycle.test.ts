import { describe, expect, it, vi } from "vitest";
import { runDurableCheckLifecycle } from "../src/checks/durable-lifecycle.js";
import type { CheckExecutor, CheckResult, HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, replayEvents } from "../src/domain/reducer.js";
import {
  InMemoryWorkflowEventStore,
  type WorkflowEventAppend,
  type WorkflowEventStore,
  WorkflowSequenceConflictError,
} from "../src/persistence/event-store.js";

const requestedAt = "2026-07-22T12:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Durable check",
  goal: "Store each check boundary",
  nodes: [{
    id: "tests",
    title: "Run tests",
    kind: "check",
    requires: [],
    acceptance: [],
    produces: [
      { name: "tests.passed", type: "boolean", required: true },
      { name: "tests.status", type: "string", required: true },
    ],
    check: {
      kind: "command",
      command: "npm",
      arguments: ["test"],
      timeoutMs: 60_000,
      publish: [
        { source: "passed", fact: "tests.passed" },
        { source: "status", fact: "tests.status" },
      ],
    },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const fixture = () => {
  const created = createWorkflow(definition(), requestedAt, "workflow-durable-check");
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  const store = new InMemoryWorkflowEventStore();
  store.seed({ events: created.events, snapshot: created.state });
  return { created, store };
};

const passedResult = (): CheckResult => ({
  checkKind: "command",
  attemptId: "attempt-1",
  startedAt: "2026-07-22T12:00:01.000Z",
  completedAt: "2026-07-22T12:00:03.000Z",
  status: "passed",
  exitCode: 0,
  facts: [],
  evidence: [],
});

class RecordingStore implements WorkflowEventStore {
  readonly appends: WorkflowEventAppend[] = [];

  constructor(
    private readonly inner: WorkflowEventStore,
    private readonly onAppend?: (input: WorkflowEventAppend) => void,
  ) {}

  async append(input: WorkflowEventAppend): Promise<void> {
    this.onAppend?.(input);
    await this.inner.append(input);
    this.appends.push(structuredClone(input));
  }
}

describe("durable check lifecycle", () => {
  it("stores the start event before executor invocation and commits four boundaries", async () => {
    const value = fixture();
    const order: string[] = [];
    const store = new RecordingStore(value.store, (input) => order.push(`store:${input.events.map((event) => event.type).join(",")}`));
    const executor: CheckExecutor = {
      execute: vi.fn(async () => {
        order.push("execute");
        return passedResult();
      }),
    };

    const result = await runDurableCheckLifecycle({
      state: value.created.state,
      executor,
      store,
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    expect(order[0]).toBe("store:hypagraph.check.started");
    expect(order[1]).toBe("execute");
    expect(store.appends).toHaveLength(4);
    expect(store.appends.map((append) => append.events.map((event) => event.type))).toEqual([
      ["hypagraph.check.started"],
      ["hypagraph.fact.published", "hypagraph.fact.published"],
      ["hypagraph.check.result-recorded"],
      ["hypagraph.verification.started", "hypagraph.verification.passed", "hypagraph.workflow.completed"],
    ]);
    if (!result.ok) return;
    const stored = value.store.read(result.state.workflowId);
    expect(stored?.snapshot).toEqual(result.state);
    expect(replayEvents(stored!.events)).toEqual(result.state);
  });

  it("does not invoke the executor when the start commit fails", async () => {
    const value = fixture();
    const execute = vi.fn(async () => passedResult());
    const store: WorkflowEventStore = {
      append: vi.fn(async () => { throw new Error("The session is not writable."); }),
    };

    const result = await runDurableCheckLifecycle({
      state: value.created.state,
      executor: { execute },
      store,
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    if (result.ok) return;
    expect(result.stage).toBe("start");
    expect(result.diagnostics[0]?.code).toBe("event_store_append_failed");
    expect(result.state).toEqual(value.created.state);
    expect(result.events).toEqual([]);
  });

  it("stops on an optimistic sequence conflict", async () => {
    const value = fixture();
    const execute = vi.fn(async () => passedResult());
    const store: WorkflowEventStore = {
      append: vi.fn(async (input) => {
        throw new WorkflowSequenceConflictError(input.workflowId, input.expectedSequence, input.expectedSequence + 1);
      }),
    };

    const result = await runDurableCheckLifecycle({
      state: value.created.state,
      executor: { execute },
      store,
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe("event_store_sequence_conflict");
  });

  it("leaves the last committed state when a later append fails", async () => {
    const value = fixture();
    let appendCount = 0;
    const store: WorkflowEventStore = {
      append: vi.fn(async (input) => {
        appendCount += 1;
        if (appendCount === 2) throw new Error("The second commit failed.");
        await value.store.append(input);
      }),
    };

    const result = await runDurableCheckLifecycle({
      state: value.created.state,
      executor: { execute: vi.fn(async () => passedResult()) },
      store,
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("publish");
    expect(result.state.runtime.nodes.tests?.status).toBe("running");
    expect(result.events.map((event) => event.type)).toEqual(["hypagraph.check.started"]);
    expect(value.store.read(result.state.workflowId)?.snapshot).toEqual(result.state);
  });
});
