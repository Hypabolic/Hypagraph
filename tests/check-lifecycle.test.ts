import { describe, expect, it, vi } from "vitest";
import { runAutomaticCheckLifecycle } from "../src/checks/lifecycle.js";
import type { CheckExecutor, CheckResult, HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";

const requestedAt = "2026-07-22T10:00:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Run automatic check",
  goal: "Complete a check without manual lifecycle commands",
  nodes: [{
    id: "tests",
    title: "Run tests",
    kind: "check",
    requires: [],
    acceptance: ["The test command passes."],
    produces: [
      { name: "tests.passed", type: "boolean", required: true },
      { name: "tests.status", type: "string", required: true },
      { name: "tests.exit_code", type: "integer", required: true },
      { name: "tests.duration_ms", type: "number", required: true },
    ],
    check: {
      kind: "command",
      command: "npm",
      arguments: ["test"],
      timeoutMs: 60_000,
      publish: [
        { source: "passed", fact: "tests.passed" },
        { source: "status", fact: "tests.status" },
        { source: "exitCode", fact: "tests.exit_code" },
        { source: "durationMs", fact: "tests.duration_ms" },
      ],
    },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: true },
});

const create = (value: HypagraphDefinition = definition()) => {
  const created = createWorkflow(value, requestedAt, "workflow-automatic-check");
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  return created;
};

const passedResult = (): CheckResult => ({
  checkKind: "command",
  attemptId: "attempt-1",
  startedAt: "2026-07-22T10:00:01.000Z",
  completedAt: "2026-07-22T10:00:03.500Z",
  status: "passed",
  exitCode: 0,
  facts: [],
  evidence: [{ ref: "artifact:stdout", kind: "file", summary: "Command stdout." }],
  stdoutRef: "artifact:stdout",
});

const failedResult = (): CheckResult => ({
  ...passedResult(),
  status: "failed",
  exitCode: 2,
  stderrRef: "artifact:stderr",
  evidence: [{ ref: "artifact:stderr", kind: "file", summary: "Command stderr." }],
});

const executor = (result: CheckResult): CheckExecutor => ({
  execute: vi.fn(async () => structuredClone(result)),
});

describe("M3 automatic check lifecycle", () => {
  it("runs, publishes, records, verifies, and completes a passed check", async () => {
    const created = create();
    const result = await runAutomaticCheckLifecycle({
      state: created.state,
      executor: executor(passedResult()),
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands.map((command) => command.type)).toEqual([
      "start-check",
      "publish-facts",
      "record-check-result",
      "begin-verification",
      "complete-verification",
    ]);
    expect(result.events.map((event) => event.type)).toEqual([
      "hypagraph.check.started",
      "hypagraph.fact.published",
      "hypagraph.fact.published",
      "hypagraph.fact.published",
      "hypagraph.fact.published",
      "hypagraph.check.result-recorded",
      "hypagraph.verification.started",
      "hypagraph.verification.passed",
      "hypagraph.workflow.completed",
    ]);
    expect(result.state.phase).toBe("completed");
    expect(result.state.runtime.nodes.tests?.status).toBe("succeeded");
    expect(result.state.runtime.facts["tests.passed"]?.value).toBe(true);
    expect(result.state.runtime.facts["tests.status"]?.value).toBe("passed");
    expect(result.state.runtime.facts["tests.exit_code"]?.value).toBe(0);
    expect(result.state.runtime.facts["tests.duration_ms"]?.value).toBe(2_500);
    expect(result.state.runtime.facts["tests.passed"]?.evidence).toEqual(passedResult().evidence);
    expect(replayEvents([...created.events, ...result.events])).toEqual(result.state);
  });

  it("records facts and fails the node when the check returns a failure", async () => {
    const created = create();
    const result = await runAutomaticCheckLifecycle({
      state: created.state,
      executor: executor(failedResult()),
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("failed");
    expect(result.state.runtime.nodes.tests?.status).toBe("failed");
    expect(result.state.runtime.nodes.tests?.attempts["attempt-1"]?.failureReason).toBe("The check failed with exit code 2.");
    expect(result.state.runtime.facts["tests.passed"]?.value).toBe(false);
    expect(result.state.runtime.facts["tests.status"]?.value).toBe("failed");
    expect(result.events.at(-1)?.type).toBe("hypagraph.verification.failed");
  });

  it("records the raw result and fails when normalization cannot provide a mapped value", async () => {
    const created = create();
    const incomplete = passedResult();
    delete incomplete.exitCode;
    const result = await runAutomaticCheckLifecycle({
      state: created.state,
      executor: executor(incomplete),
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands.map((command) => command.type)).toEqual([
      "start-check",
      "record-check-result",
      "begin-verification",
      "complete-verification",
    ]);
    expect(result.state.runtime.nodes.tests?.status).toBe("failed");
    expect(result.state.runtime.nodes.tests?.attempts["attempt-1"]?.checkResult).toEqual(incomplete);
    expect(result.state.runtime.nodes.tests?.attempts["attempt-1"]?.failureReason).toContain("normalization failed");
    expect(Object.keys(result.state.runtime.facts)).toEqual([]);
  });

  it("converts an executor exception into a recorded error result and fails the node", async () => {
    const value = definition();
    value.nodes[0]!.produces = [
      { name: "tests.passed", type: "boolean", required: true },
      { name: "tests.status", type: "string", required: true },
      { name: "tests.duration_ms", type: "number", required: true },
    ];
    value.nodes[0]!.check!.publish = [
      { source: "passed", fact: "tests.passed" },
      { source: "status", fact: "tests.status" },
      { source: "durationMs", fact: "tests.duration_ms" },
    ];
    const created = create(value);
    const throwing: CheckExecutor = { execute: vi.fn(async () => { throw new Error("The runner crashed."); }) };
    const result = await runAutomaticCheckLifecycle({
      state: created.state,
      executor: throwing,
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt,
      signal: new AbortController().signal,
      now: () => new Date("2026-07-22T10:00:04.000Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.status).toBe("error");
    expect(result.result.error).toBe("The runner crashed.");
    expect(result.state.runtime.nodes.tests?.status).toBe("failed");
    expect(result.state.runtime.nodes.tests?.attempts["attempt-1"]?.checkResult).toEqual(result.result);
    expect(result.state.runtime.facts["tests.status"]?.value).toBe("error");
  });

  it("does not call the executor when the start transition is rejected", async () => {
    const created = create();
    const started = handleCommand(created.state, {
      type: "start-check",
      nodeId: "tests",
      attemptId: "attempt-existing",
      commandId: "start-existing",
      at: requestedAt,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const execute = vi.fn(async () => passedResult());
    const result = await runAutomaticCheckLifecycle({
      state: started.state,
      executor: { execute },
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("start");
    expect(execute).not.toHaveBeenCalled();
    expect(result.events).toEqual([]);
  });

  it("produces identical commands and events for identical recorded results", async () => {
    const first = await runAutomaticCheckLifecycle({
      state: create().state,
      executor: executor(passedResult()),
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt,
      signal: new AbortController().signal,
    });
    const second = await runAutomaticCheckLifecycle({
      state: create().state,
      executor: executor(passedResult()),
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt,
      signal: new AbortController().signal,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.commands).toEqual(second.commands);
    expect(first.events).toEqual(second.events);
    expect(first.state).toEqual(second.state);
  });
});
