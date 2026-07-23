import { describe, expect, it, vi } from "vitest";
import { runDurableCheckLifecycle } from "../src/checks/durable-lifecycle.js";
import type { CheckExecutor, CheckResult, DomainEvent, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { InMemoryWorkflowEventStore } from "../src/persistence/event-store.js";

const at = "2026-07-23T05:10:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Check hard limit",
  goal: "Fail after one unsuccessful command check",
  nodes: [
    { id: "repair", title: "Repair", requires: ["test"], acceptance: [] },
    {
      id: "test",
      title: "Test",
      kind: "check",
      requires: ["repair"],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "test-command",
        timeoutMs: 10_000,
        publish: [{ source: "passed", fact: "tests.passed" }],
      },
    },
    { id: "document", title: "Document", requires: ["test"], acceptance: [] },
  ],
  loops: [{
    id: "repair-loop",
    nodes: ["repair", "test"],
    entry: "repair",
    evaluateAfter: "test",
    feedbackEdges: [{ from: "test", to: "repair" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "tests.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 1,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const completeRepair = (state: HypagraphState, events: DomainEvent[]): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId: "repair", attemptId: "repair-1", commandId: "repair-start", at });
  next = apply(next, events, { type: "submit-result", nodeId: "repair", attemptId: "repair-1", evidence: [], commandId: "repair-submit", at });
  next = apply(next, events, { type: "begin-verification", nodeId: "repair", attemptId: "repair-1", commandId: "repair-begin", at });
  return apply(next, events, { type: "complete-verification", nodeId: "repair", attemptId: "repair-1", passed: true, commandId: "repair-complete", at });
};

describe("M4 Slice 4 check exhaustion", () => {
  it("stores the failed check observation and hard-stop events in one verification batch", async () => {
    const created = createWorkflow(definition(), at, "workflow-check-hard-limit");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    const ready = completeRepair(created.state, events);
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events, snapshot: ready });
    const resultValue: CheckResult = {
      checkKind: "command",
      attemptId: "test-1",
      startedAt: at,
      completedAt: "2026-07-23T05:10:01.000Z",
      status: "failed",
      exitCode: 1,
      facts: [],
      evidence: [{ ref: "artifact://test-1", kind: "file" }],
      stdoutRef: "artifact://test-1/stdout",
      stderrRef: "artifact://test-1/stderr",
    };
    const executor: CheckExecutor = { execute: vi.fn(async () => resultValue) };

    const lifecycle = await runDurableCheckLifecycle({
      state: ready,
      executor,
      store,
      nodeId: "test",
      attemptId: "test-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });

    expect(lifecycle.ok).toBe(true);
    if (!lifecycle.ok) return;
    expect(lifecycle.state.phase).toBe("failed");
    expect(lifecycle.state.runtime.loops["repair-loop"]).toMatchObject({ status: "failed", exitReason: "max_iterations" });
    expect(lifecycle.state.runtime.facts["tests.passed"]).toMatchObject({ value: false, attemptId: "test-1", iteration: 1 });
    expect(lifecycle.state.runtime.nodes.test?.attempts["test-1"]?.checkResult).toMatchObject({
      status: "failed",
      stdoutRef: "artifact://test-1/stdout",
      stderrRef: "artifact://test-1/stderr",
    });
    expect(lifecycle.events.slice(-5).map((event) => event.type)).toEqual([
      "hypagraph.check.result-recorded",
      "hypagraph.verification.started",
      "hypagraph.verification.failed",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.failed",
      "hypagraph.workflow.failed",
    ].slice(-5));
    const stored = store.read(lifecycle.state.workflowId)!;
    expect(stored.events.slice(-4).map((event) => event.type)).toEqual([
      "hypagraph.verification.failed",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.failed",
      "hypagraph.workflow.failed",
    ]);
    expect(replayEvents(stored.events)).toEqual(lifecycle.state);
  });
});
