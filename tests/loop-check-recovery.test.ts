import { describe, expect, it, vi } from "vitest";
import { recoverInterruptedChecks } from "../src/checks/recovery.js";
import { runDurableCheckLifecycle } from "../src/checks/durable-lifecycle.js";
import type { CheckExecutor, CheckResult, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow } from "../src/domain/reducer.js";
import { applyCommandAndCommit, applyCommandsAndCommit } from "../src/persistence/coordinator.js";
import { InMemoryWorkflowEventStore, type WorkflowEventStore } from "../src/persistence/event-store.js";

const at = "2026-07-23T04:00:00.000Z";
const recoveredAt = "2026-07-23T04:05:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Recover a loop check",
  goal: "Recover without rerunning the evaluator",
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
        arguments: ["-e", "process.exit(1)"],
        timeoutMs: 10_000,
        publish: [{ source: "passed", fact: "tests.passed" }],
      },
    },
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

const failedResult = (): CheckResult => ({
  checkKind: "command",
  attemptId: "test-1",
  startedAt: at,
  completedAt: "2026-07-23T04:00:02.000Z",
  status: "failed",
  exitCode: 1,
  facts: [],
  evidence: [],
});

const completeImplement = async (store: InMemoryWorkflowEventStore, state: HypagraphState): Promise<HypagraphState> => {
  const commands: HypagraphCommand[] = [
    { type: "start-node", nodeId: "implement", attemptId: "implement-1", commandId: "implement-start", at },
    { type: "submit-result", nodeId: "implement", attemptId: "implement-1", evidence: [], commandId: "implement-submit", at },
    { type: "begin-verification", nodeId: "implement", attemptId: "implement-1", commandId: "implement-begin", at },
    { type: "complete-verification", nodeId: "implement", attemptId: "implement-1", passed: true, commandId: "implement-complete", at },
  ];
  const committed = await applyCommandsAndCommit(store, state, commands);
  if (!committed.ok) throw new Error(JSON.stringify(committed.diagnostics));
  return committed.value.state;
};

describe("M4 Slice 3 loop check recovery", () => {
  it("finishes a stored failed observation and starts iteration 2 without rerun", async () => {
    const created = createWorkflow(definition(), at, "workflow-loop-recovery-result");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const inner = new InMemoryWorkflowEventStore();
    inner.seed({ events: created.events, snapshot: created.state });
    let state = await completeImplement(inner, created.state);
    let appendCount = 0;
    const stoppingStore: WorkflowEventStore = {
      append: async (input) => {
        appendCount += 1;
        if (appendCount == 4) throw new Error("The verification commit stopped.");
        await inner.append(input);
      },
    };
    const executor: CheckExecutor = { execute: vi.fn(async () => failedResult()) };
    const lifecycle = await runDurableCheckLifecycle({
      state,
      executor,
      store: stoppingStore,
      nodeId: "test",
      attemptId: "test-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(false);
    if (lifecycle.ok) return;
    expect(lifecycle.state.runtime.nodes.test?.status).toBe("awaiting_evidence");
    expect(lifecycle.state.runtime.facts["tests.passed"]?.value).toBe(false);

    const recovered = await recoverInterruptedChecks({ state: lifecycle.state, store: inner, at: recoveredAt });
    expect(executor.execute).toHaveBeenCalledOnce();
    expect(recovered.state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 2, lastSuccess: false });
    expect(recovered.state.runtime.nodes.implement?.status).toBe("ready");
    expect(recovered.events.map((event) => event.type)).toEqual([
      "hypagraph.verification.started",
      "hypagraph.verification.failed",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.iteration-started",
      "hypagraph.node.ready",
    ]);
    const stored = inner.read(recovered.state.workflowId)!;
    expect(replayEvents(stored.events)).toEqual(recovered.state);
  });

  it("records interruption without continuing when no raw result was stored", async () => {
    const created = createWorkflow(definition(), at, "workflow-loop-recovery-start");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: created.events, snapshot: created.state });
    let state = await completeImplement(store, created.state);
    const started = await applyCommandAndCommit(store, state, {
      type: "start-check",
      nodeId: "test",
      attemptId: "test-1",
      commandId: "test-start",
      at,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    state = started.value.state;

    const recovered = await recoverInterruptedChecks({ state, store, at: recoveredAt });
    expect(recovered.state.runtime.nodes.test?.status).toBe("failed");
    expect(recovered.state.runtime.nodes.test?.attempts["test-1"]?.checkResult?.status).toBe("interrupted");
    expect(recovered.state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1 });
    expect(recovered.events.some((event) => event.type === "hypagraph.loop.evaluated")).toBe(false);
    expect(recovered.state.runtime.nodes.implement?.status).toBe("succeeded");
  });
});
