import { describe, expect, it, vi } from "vitest";
import { runAutomaticCheckLifecycle } from "../src/checks/lifecycle.js";
import type { CheckExecutor, CheckResult, CheckResultStatus, HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow } from "../src/domain/reducer.js";

const definition = (overrides: Partial<NonNullable<HypagraphDefinition["nodes"][number]["check"]>["retry"]> = {}): HypagraphDefinition => ({
  title: "Retry a check",
  goal: "Retry an allowed failed check with a new attempt",
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
      command: "test-command",
      timeoutMs: 60_000,
      retry: {
        maxAttempts: 2,
        retryOn: ["failed"],
        backoffMs: 1_000,
        ...overrides,
      },
      publish: [
        { source: "passed", fact: "tests.passed" },
        { source: "status", fact: "tests.status" },
      ],
    },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const create = (value = definition()) => {
  const result = createWorkflow(value, "2026-07-22T12:00:00.000Z", "workflow-check-retry");
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const executor = (status: CheckResultStatus, completedAt: string): CheckExecutor => ({
  execute: vi.fn(async (request): Promise<CheckResult> => ({
    checkKind: request.definition.kind,
    attemptId: request.attemptId,
    startedAt: request.requestedAt,
    completedAt,
    status,
    ...(status === "passed" ? { exitCode: 0 } : status === "failed" ? { exitCode: 1 } : {}),
    facts: [],
    evidence: [],
  })),
});

describe("check retry policy", () => {
  it("retries with a new attempt and removes facts from the old attempt", async () => {
    const first = await runAutomaticCheckLifecycle({
      state: create().state,
      executor: executor("failed", "2026-07-22T12:00:01.000Z"),
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt: "2026-07-22T12:00:00.000Z",
      signal: new AbortController().signal,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state.runtime.facts["tests.passed"]?.attemptId).toBe("attempt-1");

    const second = await runAutomaticCheckLifecycle({
      state: first.state,
      executor: executor("passed", "2026-07-22T12:00:03.000Z"),
      nodeId: "tests",
      attemptId: "attempt-2",
      requestedAt: "2026-07-22T12:00:02.000Z",
      signal: new AbortController().signal,
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.runtime.nodes.tests?.attemptCount).toBe(2);
    expect(second.state.runtime.nodes.tests?.attempts["attempt-1"]?.status).toBe("failed");
    expect(second.state.runtime.nodes.tests?.attempts["attempt-2"]?.status).toBe("succeeded");
    expect(second.state.runtime.facts["tests.passed"]?.attemptId).toBe("attempt-2");
    expect(second.state.runtime.facts["tests.passed"]?.value).toBe(true);
    expect(second.events[0]?.type).toBe("hypagraph.check.started");
    expect(second.events[0]?.data).toMatchObject({ retry: true, previousAttemptId: "attempt-1" });
  });

  it("enforces retry backoff before it invokes the executor", async () => {
    const first = await runAutomaticCheckLifecycle({
      state: create().state,
      executor: executor("failed", "2026-07-22T12:00:01.000Z"),
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt: "2026-07-22T12:00:00.000Z",
      signal: new AbortController().signal,
    });
    if (!first.ok) throw new Error("The first check did not complete.");
    const execute = vi.fn(async () => { throw new Error("The executor must not run."); });

    const retry = await runAutomaticCheckLifecycle({
      state: first.state,
      executor: { execute },
      nodeId: "tests",
      attemptId: "attempt-2",
      requestedAt: "2026-07-22T12:00:01.500Z",
      signal: new AbortController().signal,
    });

    expect(retry.ok).toBe(false);
    if (retry.ok) return;
    expect(retry.stage).toBe("start");
    expect(retry.diagnostics[0]?.code).toBe("check_retry_backoff");
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces the maximum attempt count", async () => {
    const first = await runAutomaticCheckLifecycle({
      state: create(definition({ backoffMs: 0 })).state,
      executor: executor("failed", "2026-07-22T12:00:01.000Z"),
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt: "2026-07-22T12:00:00.000Z",
      signal: new AbortController().signal,
    });
    if (!first.ok) throw new Error("The first check did not complete.");
    const second = await runAutomaticCheckLifecycle({
      state: first.state,
      executor: executor("failed", "2026-07-22T12:00:02.000Z"),
      nodeId: "tests",
      attemptId: "attempt-2",
      requestedAt: "2026-07-22T12:00:01.000Z",
      signal: new AbortController().signal,
    });
    if (!second.ok) throw new Error("The second check did not complete.");
    const execute = vi.fn(async () => { throw new Error("The executor must not run."); });

    const third = await runAutomaticCheckLifecycle({
      state: second.state,
      executor: { execute },
      nodeId: "tests",
      attemptId: "attempt-3",
      requestedAt: "2026-07-22T12:00:03.000Z",
      signal: new AbortController().signal,
    });

    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.diagnostics[0]?.code).toBe("check_retry_limit_reached");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not retry a status that the policy does not permit", async () => {
    const first = await runAutomaticCheckLifecycle({
      state: create(definition({ retryOn: ["failed"], backoffMs: 0 })).state,
      executor: executor("timed_out", "2026-07-22T12:00:01.000Z"),
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt: "2026-07-22T12:00:00.000Z",
      signal: new AbortController().signal,
    });
    if (!first.ok) throw new Error("The first check did not complete.");

    const retry = await runAutomaticCheckLifecycle({
      state: first.state,
      executor: executor("passed", "2026-07-22T12:00:03.000Z"),
      nodeId: "tests",
      attemptId: "attempt-2",
      requestedAt: "2026-07-22T12:00:02.000Z",
      signal: new AbortController().signal,
    });

    expect(retry.ok).toBe(false);
    if (retry.ok) return;
    expect(retry.diagnostics[0]?.code).toBe("check_retry_status_not_allowed");
  });
});
