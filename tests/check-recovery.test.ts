import { describe, expect, it, vi } from "vitest";
import { recoverInterruptedChecks } from "../src/checks/recovery.js";
import type { CheckExecutor, CheckResult, HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";
import { runDurableCheckLifecycle } from "../src/checks/durable-lifecycle.js";
import { InMemoryWorkflowEventStore, type WorkflowEventStore } from "../src/persistence/event-store.js";

const startedAt = "2026-07-22T13:00:00.000Z";
const recoveredAt = "2026-07-22T13:05:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Recover check",
  goal: "Close orphaned checks without rerun",
  nodes: [{
    id: "tests",
    title: "Run tests",
    kind: "check",
    requires: [],
    acceptance: [],
    produces: [{ name: "tests.passed", type: "boolean", required: true }],
    check: {
      kind: "command",
      command: "npm",
      arguments: ["test"],
      timeoutMs: 60_000,
      publish: [{ source: "passed", fact: "tests.passed" }],
    },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const fixture = () => {
  const created = createWorkflow(definition(), startedAt, "workflow-recovery");
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  const store = new InMemoryWorkflowEventStore();
  store.seed({ events: created.events, snapshot: created.state });
  return { created, store };
};

const passedResult = (): CheckResult => ({
  checkKind: "command",
  attemptId: "attempt-1",
  startedAt: "2026-07-22T13:00:01.000Z",
  completedAt: "2026-07-22T13:00:03.000Z",
  status: "passed",
  exitCode: 0,
  facts: [],
  evidence: [],
});

describe("interrupted check recovery", () => {
  it("records an interrupted result and fails a check that only has a stored start", async () => {
    const value = fixture();
    const started = handleCommand(value.created.state, {
      type: "start-check",
      nodeId: "tests",
      attemptId: "attempt-1",
      commandId: "start-check",
      at: startedAt,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    await value.store.append({
      workflowId: started.state.workflowId,
      expectedSequence: value.created.state.sequence,
      events: started.events,
      snapshot: started.state,
    });
    const execute = vi.fn();

    const recovered = await recoverInterruptedChecks({
      state: started.state,
      store: value.store,
      at: recoveredAt,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(recovered.recoveredAttemptIds).toEqual(["attempt-1"]);
    expect(recovered.state.runtime.nodes.tests?.status).toBe("failed");
    expect(recovered.state.runtime.nodes.tests?.attempts["attempt-1"]?.checkResult?.status).toBe("interrupted");
    expect(recovered.state.runtime.nodes.tests?.attempts["attempt-1"]?.failureReason).toContain("interrupted");
    expect(Object.keys(recovered.state.runtime.facts)).toEqual([]);
    const stored = value.store.read(recovered.state.workflowId)!;
    expect(replayEvents(stored.events)).toEqual(recovered.state);
  });

  it("finishes verification from a stored raw result without executor invocation", async () => {
    const value = fixture();
    let appendCount = 0;
    const stoppingStore: WorkflowEventStore = {
      append: async (input) => {
        appendCount += 1;
        if (appendCount === 4) throw new Error("The verification commit failed.");
        await value.store.append(input);
      },
    };
    const executor: CheckExecutor = { execute: vi.fn(async () => passedResult()) };
    const lifecycle = await runDurableCheckLifecycle({
      state: value.created.state,
      executor,
      store: stoppingStore,
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt: startedAt,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(false);
    if (lifecycle.ok) return;
    expect(lifecycle.state.runtime.nodes.tests?.status).toBe("awaiting_evidence");

    const recovered = await recoverInterruptedChecks({
      state: lifecycle.state,
      store: value.store,
      at: recoveredAt,
    });

    expect(executor.execute).toHaveBeenCalledOnce();
    expect(recovered.state.runtime.nodes.tests?.status).toBe("succeeded");
    expect(recovered.state.runtime.facts["tests.passed"]?.value).toBe(true);
    expect(recovered.state.phase).toBe("completed");
  });

  it("does not change state when there is no orphaned check", async () => {
    const value = fixture();
    const recovered = await recoverInterruptedChecks({
      state: value.created.state,
      store: value.store,
      at: recoveredAt,
    });
    expect(recovered.state).toEqual(value.created.state);
    expect(recovered.events).toEqual([]);
    expect(recovered.recoveredAttemptIds).toEqual([]);
  });
});
