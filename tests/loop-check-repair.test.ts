import { describe, expect, it, vi } from "vitest";
import { runDurableCheckLifecycle } from "../src/checks/durable-lifecycle.js";
import type { CheckExecutor, CheckResult, DomainEvent, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow } from "../src/domain/reducer.js";
import { applyCommandsAndCommit } from "../src/persistence/coordinator.js";
import { InMemoryWorkflowEventStore, type WorkflowEventAppend, type WorkflowEventStore } from "../src/persistence/event-store.js";

const at = "2026-07-23T03:00:00.000Z";

const repairDefinition = (): HypagraphDefinition => ({
  title: "Check-driven repair loop",
  goal: "Use a failing test result as an observation and pass the next iteration",
  nodes: [
    { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
    {
      id: "test",
      title: "Test",
      kind: "check",
      requires: ["implement"],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "node",
        arguments: ["-e", "process.exit(0)"],
        timeoutMs: 10_000,
        publish: [{ source: "passed", fact: "tests.passed" }],
      },
    },
    { id: "document", title: "Document", requires: ["test"], acceptance: [] },
  ],
  loops: [{
    id: "repair",
    nodes: ["implement", "test"],
    entry: "implement",
    evaluateAfter: "test",
    feedbackEdges: [{ from: "test", to: "implement" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "tests.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 3,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const nonEvaluationCheckDefinition = (): HypagraphDefinition => ({
  title: "Check retry stays in one iteration",
  goal: "Retry a non-evaluation check without incrementing the loop",
  nodes: [
    { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
    {
      id: "lint",
      title: "Lint",
      kind: "check",
      requires: ["implement"],
      acceptance: [],
      produces: [{ name: "lint.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "node",
        arguments: ["-e", "process.exit(0)"],
        timeoutMs: 10_000,
        retry: { maxAttempts: 2, retryOn: ["error"] },
        publish: [{ source: "passed", fact: "lint.passed" }],
      },
    },
    { id: "test", title: "Test", requires: ["lint"], acceptance: [] },
  ],
  loops: [{
    id: "repair",
    nodes: ["implement", "lint", "test"],
    entry: "implement",
    evaluateAfter: "test",
    feedbackEdges: [{ from: "test", to: "implement" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "lint.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 3,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const failedResult = (attemptId: string): CheckResult => ({
  checkKind: "command",
  attemptId,
  startedAt: at,
  completedAt: "2026-07-23T03:00:02.000Z",
  status: "failed",
  exitCode: 1,
  facts: [],
  evidence: [{ ref: `command://${attemptId}`, kind: "command", summary: "The command failed." }],
});

const passedResult = (attemptId: string): CheckResult => ({
  checkKind: "command",
  attemptId,
  startedAt: at,
  completedAt: "2026-07-23T03:00:02.000Z",
  status: "passed",
  exitCode: 0,
  facts: [],
  evidence: [{ ref: `command://${attemptId}`, kind: "command", summary: "The command passed." }],
});

const errorResult = (attemptId: string): CheckResult => ({
  checkKind: "command",
  attemptId,
  startedAt: at,
  completedAt: "2026-07-23T03:00:02.000Z",
  status: "error",
  facts: [],
  evidence: [],
  error: "The lint adapter failed.",
});

const completeTask = async (
  store: InMemoryWorkflowEventStore,
  state: HypagraphState,
  nodeId: string,
  attemptId: string,
): Promise<HypagraphState> => {
  const commands: HypagraphCommand[] = [
    { type: "start-node", nodeId, attemptId, commandId: `${attemptId}-start`, at },
    { type: "submit-result", nodeId, attemptId, evidence: [{ ref: `note://${attemptId}`, kind: "note" }], commandId: `${attemptId}-submit`, at },
    { type: "begin-verification", nodeId, attemptId, commandId: `${attemptId}-begin`, at },
    { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${attemptId}-complete`, at },
  ];
  const committed = await applyCommandsAndCommit(store, state, commands);
  if (!committed.ok) throw new Error(JSON.stringify(committed.diagnostics));
  return committed.value.state;
};

class RecordingStore implements WorkflowEventStore {
  readonly appends: WorkflowEventAppend[] = [];
  constructor(private readonly inner: WorkflowEventStore) {}
  async append(input: WorkflowEventAppend): Promise<void> {
    await this.inner.append(input);
    this.appends.push(structuredClone(input));
  }
}

describe("M4 Slice 3 check-driven repair loops", () => {
  it("continues after a failed evaluation check and completes on the next check", async () => {
    const created = createWorkflow(repairDefinition(), at, "workflow-check-repair");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const inner = new InMemoryWorkflowEventStore();
    inner.seed({ events: created.events, snapshot: created.state });
    const store = new RecordingStore(inner);

    let state = await completeTask(inner, created.state, "implement", "implement-1");
    const first = await runDurableCheckLifecycle({
      state,
      executor: { execute: vi.fn(async () => failedResult("test-1")) },
      store,
      nodeId: "test",
      attemptId: "test-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.state;

    expect(state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 2, lastSuccess: false });
    expect(state.runtime.loops.repair?.iterations[0]).toMatchObject({ iteration: 1, success: false, decision: "continue" });
    expect(state.runtime.nodes.implement?.status).toBe("ready");
    expect(state.runtime.nodes.test?.attempts["test-1"]).toMatchObject({ status: "failed", loopId: "repair", iteration: 1 });
    expect(state.runtime.facts["tests.passed"]).toBeUndefined();
    const firstVerification = store.appends.at(-1)!;
    expect(firstVerification.events.map((event) => event.type)).toEqual([
      "hypagraph.verification.started",
      "hypagraph.verification.failed",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.iteration-started",
      "hypagraph.node.ready",
    ]);
    const firstEvaluation = firstVerification.events.find((event) => event.type === "hypagraph.loop.evaluated")!;
    expect(firstEvaluation.data).toMatchObject({ success: false, decision: "continue", verificationPassed: false, observationStatus: "failed" });
    expect(first.events.find((event) => event.type === "hypagraph.check.started")?.data.retry).toBe(false);

    state = await completeTask(inner, state, "implement", "implement-2");
    const second = await runDurableCheckLifecycle({
      state,
      executor: { execute: vi.fn(async () => passedResult("test-2")) },
      store,
      nodeId: "test",
      attemptId: "test-2",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    state = second.state;

    expect(state.runtime.loops.repair).toMatchObject({ status: "succeeded", currentIteration: 2, lastSuccess: true, exitReason: "success" });
    expect(state.runtime.nodes.document?.status).toBe("ready");
    expect(state.runtime.nodes.test?.attempts["test-1"]?.iteration).toBe(1);
    expect(state.runtime.nodes.test?.attempts["test-2"]?.iteration).toBe(2);
    expect(second.events.find((event) => event.type === "hypagraph.check.started")?.data.retry).toBe(false);
    expect(state.runtime.facts["tests.passed"]).toMatchObject({ value: true, attemptId: "test-2", iteration: 2 });

    const stored = inner.read(state.workflowId)!;
    expect(replayEvents(stored.events)).toEqual(state);
    expect(replayEvents(stored.events).snapshotHash).toBe(state.snapshotHash);
  });

  it("keeps a true condition pending when the evaluation check failed verification", async () => {
    const value = repairDefinition();
    value.loops[0]!.successWhen = {
      kind: "compare",
      left: { kind: "fact", name: "tests.passed" },
      operator: "eq",
      right: { kind: "literal", value: false },
    };
    const created = createWorkflow(value, at, "workflow-failed-check-true-condition");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: created.events, snapshot: created.state });
    const state = await completeTask(store, created.state, "implement", "implement-1");
    const lifecycle = await runDurableCheckLifecycle({
      state,
      executor: { execute: vi.fn(async () => failedResult("test-1")) },
      store,
      nodeId: "test",
      attemptId: "test-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(true);
    if (!lifecycle.ok) return;
    expect(lifecycle.state.runtime.nodes.test?.status).toBe("failed");
    expect(lifecycle.state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1, lastSuccess: true });
    expect(lifecycle.state.runtime.loops.repair?.iterations[0]).toMatchObject({ success: true, decision: "pending" });
    expect(lifecycle.events.some((event) => event.type === "hypagraph.loop.completed")).toBe(false);
  });

  it.each(["timed_out", "cancelled", "interrupted", "error"] as const)(
    "does not continue from an evaluation check with status %s",
    async (status) => {
      const created = createWorkflow(repairDefinition(), at, `workflow-check-${status}`);
      if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
      const store = new InMemoryWorkflowEventStore();
      store.seed({ events: created.events, snapshot: created.state });
      const state = await completeTask(store, created.state, "implement", "implement-1");
      const result: CheckResult = {
        checkKind: "command",
        attemptId: "test-1",
        startedAt: at,
        completedAt: "2026-07-23T03:00:02.000Z",
        status,
        facts: [],
        evidence: [],
      };
      const lifecycle = await runDurableCheckLifecycle({
        state,
        executor: { execute: vi.fn(async () => result) },
        store,
        nodeId: "test",
        attemptId: "test-1",
        requestedAt: at,
        signal: new AbortController().signal,
      });
      expect(lifecycle.ok).toBe(true);
      if (!lifecycle.ok) return;
      expect(lifecycle.state.runtime.nodes.test?.status).toBe("failed");
      const blocksRegion = status === "cancelled" || status === "interrupted";
      expect(lifecycle.state.runtime.loops.repair).toMatchObject({ status: blocksRegion ? "blocked" : "running", currentIteration: 1 });
      expect(lifecycle.events.some((event) => event.type === "hypagraph.loop.evaluated")).toBe(false);
      expect(lifecycle.events.some((event) => event.type === "hypagraph.loop.blocked")).toBe(blocksRegion);
    },
  );

  it("does not continue after a failed non-evaluation check and keeps retries in the same iteration", async () => {
    const created = createWorkflow(nonEvaluationCheckDefinition(), at, "workflow-check-retry");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: created.events, snapshot: created.state });
    let state = await completeTask(store, created.state, "implement", "implement-1");

    const firstExecutor: CheckExecutor = { execute: vi.fn(async () => errorResult("lint-1")) };
    const first = await runDurableCheckLifecycle({
      state,
      executor: firstExecutor,
      store,
      nodeId: "lint",
      attemptId: "lint-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.state;
    expect(state.runtime.nodes.lint?.status).toBe("failed");
    expect(state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1 });
    expect(first.events.some((event) => event.type === "hypagraph.loop.evaluated")).toBe(false);

    const second = await runDurableCheckLifecycle({
      state,
      executor: { execute: vi.fn(async () => passedResult("lint-2")) },
      store,
      nodeId: "lint",
      attemptId: "lint-2",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    state = second.state;
    expect(state.runtime.loops.repair?.currentIteration).toBe(1);
    expect(state.runtime.nodes.lint?.attempts["lint-1"]?.iteration).toBe(1);
    expect(state.runtime.nodes.lint?.attempts["lint-2"]?.iteration).toBe(1);
    expect(second.events.find((event) => event.type === "hypagraph.check.started")?.data).toMatchObject({ retry: true, previousAttemptId: "lint-1", iteration: 1 });
    expect(state.runtime.nodes.test?.status).toBe("ready");
  });
});
