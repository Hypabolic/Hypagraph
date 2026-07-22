import { describe, expect, it, vi } from "vitest";
import { createCheckExecutionRequest, executeCheck } from "../src/checks/execution.js";
import type { CheckExecutor, CheckResult, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";

const at = "2026-07-22T09:00:00.000Z";
const definition: HypagraphDefinition = {
  title: "Execute check",
  goal: "Record an external check result",
  nodes: [{
    id: "tests",
    title: "Run tests",
    kind: "check",
    requires: [],
    acceptance: [],
    produces: [{ name: "tests.passed", type: "boolean" }],
    check: { kind: "command", command: "npm", arguments: ["test"], timeoutMs: 60_000, publish: [{ source: "passed", fact: "tests.passed" }] },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
};

const create = () => {
  const result = createWorkflow(definition, at, "workflow-check");
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const run = (state: HypagraphState, command: Parameters<typeof handleCommand>[1]) => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const checkResult = (): CheckResult => ({
  checkKind: "command",
  attemptId: "attempt-1",
  startedAt: "2026-07-22T09:01:00.000Z",
  completedAt: "2026-07-22T09:01:02.000Z",
  status: "passed",
  exitCode: 0,
  facts: [{ name: "tests.passed", type: "boolean", value: true }],
  evidence: [{ ref: "check:attempt-1", kind: "command" }],
});

describe("M3 check execution boundary", () => {
  it("starts a check through a dedicated command", () => {
    const created = create();
    const started = run(created.state, { type: "start-check", nodeId: "tests", attemptId: "attempt-1", commandId: "start-check", at });
    expect(started.events.map((event) => event.type)).toEqual(["hypagraph.check.started"]);
    expect(started.state.runtime.nodes.tests?.status).toBe("running");
  });

  it("builds an immutable request and delegates only outside replay", async () => {
    const created = create();
    const started = run(created.state, { type: "start-check", nodeId: "tests", attemptId: "attempt-1", commandId: "start-check", at });
    const request = createCheckExecutionRequest(started.state, "tests", "attempt-1", at);
    const execute = vi.fn(async () => checkResult());
    const executor: CheckExecutor = { execute };
    const result = await executeCheck(executor, request, new AbortController().signal);
    expect(execute).toHaveBeenCalledOnce();
    expect(result).toEqual(checkResult());
    expect(request.definition).not.toBe(definition.nodes[0]?.check);
  });

  it("records a result as an event and rebuilds without invoking an executor", () => {
    const created = create();
    const started = run(created.state, { type: "start-check", nodeId: "tests", attemptId: "attempt-1", commandId: "start-check", at });
    const recorded = run(started.state, { type: "record-check-result", nodeId: "tests", attemptId: "attempt-1", result: checkResult(), commandId: "record-check", at: "2026-07-22T09:01:02.000Z" });
    const events = [...created.events, ...started.events, ...recorded.events];
    expect(recorded.events.map((event) => event.type)).toEqual(["hypagraph.check.result-recorded"]);
    expect(recorded.state.runtime.nodes.tests?.attempts["attempt-1"]?.checkResult).toEqual(checkResult());
    expect(recorded.state.runtime.nodes.tests?.status).toBe("awaiting_evidence");
    expect(replayEvents(events)).toEqual(recorded.state);
  });

  it("rejects stale and mismatched results without events", () => {
    const created = create();
    const started = run(created.state, { type: "start-check", nodeId: "tests", attemptId: "attempt-1", commandId: "start-check", at });
    const stale = handleCommand(started.state, { type: "record-check-result", nodeId: "tests", attemptId: "attempt-old", result: { ...checkResult(), attemptId: "attempt-old" }, commandId: "stale", at });
    expect(stale.ok).toBe(false);
    const wrongKind = handleCommand(started.state, { type: "record-check-result", nodeId: "tests", attemptId: "attempt-1", result: { ...checkResult(), checkKind: "test-report" }, commandId: "wrong-kind", at });
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) expect(wrongKind.diagnostics[0]?.code).toBe("check_kind_mismatch");
  });

  it("does not allow the task start command for a check", () => {
    const created = create();
    const result = handleCommand(created.state, { type: "start-node", nodeId: "tests", attemptId: "attempt-1", commandId: "wrong-start", at });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("check_start_required");
  });
});
