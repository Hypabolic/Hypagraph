import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import { runAutomaticCheckLifecycle } from "../src/checks/lifecycle.js";
import { ReportCheckExecutor } from "../src/checks/report-check-executor.js";
import type { CheckExecutor, CheckResult, HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, replayEvents } from "../src/domain/reducer.js";

const roots: string[] = [];
const at = "2026-07-23T11:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const definition = (): HypagraphDefinition => ({
  title: "Run parsed tests",
  goal: "Publish deterministic test report facts",
  nodes: [{
    id: "tests",
    title: "Run tests",
    kind: "check",
    requires: [],
    acceptance: ["The test report passes."],
    produces: [
      { name: "tests.success", type: "boolean", required: true },
      { name: "tests.total", type: "integer", required: true },
      { name: "tests.passed", type: "integer", required: true },
      { name: "tests.suites.total", type: "integer", required: true },
    ],
    check: {
      kind: "test-report",
      command: "npm",
      arguments: ["test"],
      timeoutMs: 60_000,
      reportPath: "vitest.json",
      parser: { name: "vitest-json", version: 1 },
      namespace: "tests",
    },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: true },
});

const producerResult = (): CheckResult => ({
  checkKind: "command",
  attemptId: "attempt-1",
  startedAt: at,
  completedAt: "2026-07-23T11:00:01.000Z",
  status: "passed",
  exitCode: 0,
  facts: [],
  evidence: [{ ref: "memory://stdout", kind: "file", summary: "Command stdout." }],
  stdoutRef: "memory://stdout",
});

const producer = (): CheckExecutor => ({ execute: vi.fn(async () => producerResult()) });

describe("M3.1 report check lifecycle", () => {
  it("publishes parsed facts, records evidence, verifies, and replays", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-report-lifecycle-"));
    roots.push(root);
    await writeFile(join(root, "vitest.json"), JSON.stringify({
      success: true,
      numTotalTestSuites: 1,
      numPassedTestSuites: 1,
      numFailedTestSuites: 0,
      numTotalTests: 2,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 0,
    }), "utf8");

    const created = createWorkflow(definition(), at, "workflow-report-lifecycle");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const executor = new ReportCheckExecutor({
      rootDirectory: root,
      artifactStore: new MemoryCheckArtifactStore(),
      producerExecutor: producer(),
      now: () => new Date("2026-07-23T11:00:02.000Z"),
    });

    const result = await runAutomaticCheckLifecycle({
      state: created.state,
      executor,
      nodeId: "tests",
      attemptId: "attempt-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.phase).toBe("completed");
    expect(result.state.runtime.nodes.tests?.status).toBe("succeeded");
    expect(result.state.runtime.facts["tests.success"]?.value).toBe(true);
    expect(result.state.runtime.facts["tests.total"]?.value).toBe(2);
    expect(result.state.runtime.facts["tests.passed"]?.value).toBe(2);
    expect(result.state.runtime.facts["tests.suites.total"]?.value).toBe(1);
    expect(result.state.runtime.nodes.tests?.attempts["attempt-1"]?.checkResult?.checkKind).toBe("test-report");
    expect(result.events.some((event) => event.type === "hypagraph.check.result-recorded")).toBe(true);
    expect(replayEvents([...created.events, ...result.events])).toEqual(result.state);
  });
});
