import { describe, expect, it, vi } from "vitest";
import { runPiCommandCheck, requireReadyCommandCheck, formatPiCheckResult } from "../src/pi/check-tool.js";
import type { CheckExecutor, CheckResult, HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow } from "../src/domain/reducer.js";
import { InMemoryWorkflowEventStore } from "../src/persistence/event-store.js";

const requestedAt = "2026-07-22T11:10:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Pi check adapter",
  goal: "Run a ready check through the Pi adapter",
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

const created = () => {
  const result = createWorkflow(definition(), requestedAt, "workflow-pi-adapter");
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const store = new InMemoryWorkflowEventStore();
  store.seed({ events: result.events, snapshot: result.state });
  return { result, store };
};

const passedResult = (): CheckResult => ({
  checkKind: "command",
  attemptId: "attempt-1",
  startedAt: "2026-07-22T11:10:01.000Z",
  completedAt: "2026-07-22T11:10:03.000Z",
  status: "passed",
  exitCode: 0,
  facts: [],
  evidence: [{ ref: "file:///tmp/stdout.txt", kind: "file", summary: "Command stdout." }],
  stdoutRef: "file:///tmp/stdout.txt",
});

describe("Pi check execution adapter", () => {
  it("requires a ready command check", () => {
    const state = created().result.state;
    const check = requireReadyCommandCheck(state, "tests");
    expect(check.definition.command).toBe("npm");
    check.definition.arguments![0] = "changed";
    expect(state.definition.nodes[0]!.check?.arguments).toEqual(["test"]);
  });

  it("runs the durable lifecycle without changing the input state", async () => {
    const fixture = created();
    const state = fixture.result.state;
    const before = structuredClone(state);
    const execute = vi.fn(async () => passedResult());
    const result = await runPiCommandCheck({
      state,
      executor: { execute },
      store: fixture.store,
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(state).toEqual(before);
    if (!result.ok) return;
    expect(result.state.runtime.nodes.tests?.status).toBe("succeeded");
    expect(result.state.runtime.facts["tests.passed"]?.value).toBe(true);
    expect(result.state.runtime.facts["tests.status"]?.value).toBe("passed");
    expect(formatPiCheckResult(result.state, "tests", result.result)).toContain("Final status: passed");
    expect(fixture.store.read(result.state.workflowId)?.snapshot).toEqual(result.state);
  });

  it("rejects a task node", () => {
    const value = definition();
    value.nodes[0] = {
      id: "task",
      title: "Task",
      kind: "task",
      requires: [],
      acceptance: [],
    };
    const result = createWorkflow(value, requestedAt, "workflow-task");
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(() => requireReadyCommandCheck(result.state, "task")).toThrow("is not a check");
  });

  it("rejects a check that is not ready", async () => {
    const value = definition();
    value.nodes.unshift({
      id: "prepare",
      title: "Prepare",
      kind: "task",
      requires: [],
      acceptance: [],
    });
    value.nodes[1]!.requires = ["prepare"];
    const result = createWorkflow(value, requestedAt, "workflow-not-ready");
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: result.events, snapshot: result.state });
    await expect(runPiCommandCheck({
      state: result.state,
      executor: { execute: vi.fn(async () => passedResult()) },
      store,
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt,
      signal: new AbortController().signal,
    })).rejects.toThrow("is not ready");
  });

  it("passes the Pi abort signal to the executor", async () => {
    const controller = new AbortController();
    controller.abort();
    let receivedSignal: AbortSignal | undefined;
    const cancelled: CheckResult = {
      checkKind: "command",
      attemptId: "attempt-1",
      startedAt: requestedAt,
      completedAt: "2026-07-22T11:10:01.000Z",
      status: "cancelled",
      facts: [],
      evidence: [],
      error: "The command was cancelled.",
    };
    const executor: CheckExecutor = {
      execute: vi.fn(async (_request, signal) => {
        receivedSignal = signal;
        return cancelled;
      }),
    };
    const fixture = created();
    const result = await runPiCommandCheck({
      state: fixture.result.state,
      executor,
      store: fixture.store,
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt,
      signal: controller.signal,
    });
    expect(receivedSignal).toBe(controller.signal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("cancelled");
    expect(result.state.runtime.nodes.tests?.status).toBe("failed");
  });
});
