import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import { ReportCheckExecutor } from "../src/checks/report-check-executor.js";
import type { CheckExecutionRequest, CheckExecutor, CheckResult } from "../src/domain/model.js";

const roots: string[] = [];
const requestedAt = "2026-07-23T11:00:00.000Z";

const root = async (): Promise<string> => {
  const value = await mkdtemp(join(tmpdir(), "hypagraph-report-check-"));
  roots.push(value);
  return value;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

const producerResult = (status: CheckResult["status"] = "passed"): CheckResult => ({
  checkKind: "command",
  attemptId: "attempt-1",
  startedAt: requestedAt,
  completedAt: "2026-07-23T11:00:01.000Z",
  status,
  ...(status === "passed" ? { exitCode: 0 } : {}),
  facts: [],
  evidence: [{ ref: "memory://stdout", kind: "file", summary: "Command stdout." }],
  stdoutRef: "memory://stdout",
});

const producer = (result: CheckResult): CheckExecutor => ({
  execute: vi.fn(async () => structuredClone(result)),
});

const request = (reportPath: string): CheckExecutionRequest => ({
  workflowId: "workflow-1",
  revision: 1,
  nodeId: "tests",
  attemptId: "attempt-1",
  requestedAt,
  definition: {
    kind: "test-report",
    command: "npm",
    arguments: ["test"],
    timeoutMs: 60_000,
    reportPath,
    parser: { name: "vitest-json", version: 1 },
    namespace: "tests",
  },
});

const validReport = JSON.stringify({
  success: true,
  numTotalTestSuites: 1,
  numPassedTestSuites: 1,
  numFailedTestSuites: 0,
  numTotalTests: 2,
  numPassedTests: 2,
  numFailedTests: 0,
  numPendingTests: 0,
});

describe("M3.1 executable report checks", () => {
  it("runs a producer, stores the report, and publishes collision-free facts", async () => {
    const workspace = await root();
    await writeFile(join(workspace, "vitest.json"), validReport, "utf8");
    const store = new MemoryCheckArtifactStore();
    const executor = new ReportCheckExecutor({
      rootDirectory: workspace,
      artifactStore: store,
      producerExecutor: producer(producerResult()),
      now: () => new Date("2026-07-23T11:00:02.000Z"),
    });

    const result = await executor.execute(request("vitest.json"), new AbortController().signal);

    expect(result.checkKind).toBe("test-report");
    expect(result.status).toBe("passed");
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "tests.success", value: true }));
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "tests.passed", value: 2 }));
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "tests.suites.passed", value: 1 }));
    expect(new Set(result.facts.map((fact) => fact.name)).size).toBe(result.facts.length);
    expect(result.evidence.at(-1)?.summary).toBe("vitest-json report.");
  });

  it("does not read a report after an incomplete producer result", async () => {
    const workspace = await root();
    const executor = new ReportCheckExecutor({
      rootDirectory: workspace,
      artifactStore: new MemoryCheckArtifactStore(),
      producerExecutor: producer(producerResult("timed_out")),
    });

    const result = await executor.execute(request("missing.json"), new AbortController().signal);

    expect(result.status).toBe("timed_out");
    expect(result.checkKind).toBe("test-report");
    expect(result.facts).toEqual([]);
  });

  it("rejects report paths outside the workspace", async () => {
    const workspace = await root();
    const executor = new ReportCheckExecutor({
      rootDirectory: workspace,
      artifactStore: new MemoryCheckArtifactStore(),
      producerExecutor: producer(producerResult()),
      now: () => new Date("2026-07-23T11:00:02.000Z"),
    });

    const result = await executor.execute(request("../outside.json"), new AbortController().signal);

    expect(result.status).toBe("error");
    expect(result.error).toContain("outside the configured workspace root");
  });

  it("turns malformed reports into explicit executor errors", async () => {
    const workspace = await root();
    await writeFile(join(workspace, "vitest.json"), "not-json", "utf8");
    const executor = new ReportCheckExecutor({
      rootDirectory: workspace,
      artifactStore: new MemoryCheckArtifactStore(),
      producerExecutor: producer(producerResult()),
      now: () => new Date("2026-07-23T11:00:02.000Z"),
    });

    const result = await executor.execute(request("vitest.json"), new AbortController().signal);

    expect(result.status).toBe("error");
    expect(result.error).toContain("not valid JSON");
  });

  it("is deterministic for identical recorded producer output and report bytes", async () => {
    const workspace = await root();
    await writeFile(join(workspace, "vitest.json"), validReport, "utf8");
    const run = async () => new ReportCheckExecutor({
      rootDirectory: workspace,
      artifactStore: new MemoryCheckArtifactStore(),
      producerExecutor: producer(producerResult()),
      now: () => new Date("2026-07-23T11:00:02.000Z"),
    }).execute(request("vitest.json"), new AbortController().signal);

    expect(await run()).toEqual(await run());
  });
});
