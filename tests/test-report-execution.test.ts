import { describe, expect, it } from "vitest";
import type { CheckExecutionRequest, CheckResult } from "../src/domain/model.js";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import { executeStoredVitestReport } from "../src/checks/test-report-execution.js";

const request = (): CheckExecutionRequest => ({
  workflowId: "workflow-1",
  revision: 2,
  nodeId: "run-tests",
  attemptId: "attempt-1",
  requestedAt: "2026-07-23T10:00:00.000Z",
  definition: {
    kind: "command",
    command: "npm",
    arguments: ["test"],
    timeoutMs: 60_000,
    publish: [],
  },
});

const report = JSON.stringify({
  success: true,
  numTotalTestSuites: 2,
  numPassedTestSuites: 2,
  numFailedTestSuites: 0,
  numTotalTests: 5,
  numPassedTests: 4,
  numFailedTests: 0,
  numPendingTests: 1,
  startTime: 1000,
  testResults: [{ endTime: 1250 }, { endTime: 1500 }],
});

const storeReport = async (store: MemoryCheckArtifactStore, text = report): Promise<string> => store.write({
  workflowId: "workflow-1",
  nodeId: "run-tests",
  attemptId: "attempt-1",
  name: "vitest.json",
  mediaType: "application/json; charset=utf-8",
  content: new TextEncoder().encode(text),
});

const commandResult = (reportRef: string): CheckResult => ({
  checkKind: "command",
  attemptId: "attempt-1",
  startedAt: "2026-07-23T10:00:01.000Z",
  completedAt: "2026-07-23T10:00:02.000Z",
  status: "passed",
  exitCode: 0,
  facts: [],
  evidence: [{ ref: reportRef, kind: "file", summary: "Vitest JSON report." }],
});

describe("M3.1 stored test report execution", () => {
  it("reads bounded recorded evidence and creates a deterministic publication command", async () => {
    const store = new MemoryCheckArtifactStore();
    const reportRef = await storeReport(store);
    const first = await executeStoredVitestReport(request(), commandResult(reportRef), store, reportRef, "2026-07-23T10:00:03.000Z");
    const second = await executeStoredVitestReport(request(), commandResult(reportRef), store, reportRef, "2026-07-23T10:00:03.000Z");

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result.checkKind).toBe("test-report");
    expect(first.publicationCommand).toMatchObject({
      type: "publish-facts",
      nodeId: "run-tests",
      attemptId: "attempt-1",
    });
    if (first.publicationCommand.type !== "publish-facts") return;
    expect(first.publicationCommand.facts).toContainEqual({
      name: "tests.total",
      type: "integer",
      value: 5,
      evidence: commandResult(reportRef).evidence,
    });
  });

  it("rejects an artifact that was not recorded as command evidence", async () => {
    const store = new MemoryCheckArtifactStore();
    const reportRef = await storeReport(store);
    const result = commandResult(reportRef);
    result.evidence = [];
    const executed = await executeStoredVitestReport(request(), result, store, reportRef, "2026-07-23T10:00:03.000Z");
    expect(executed.ok).toBe(false);
    if (!executed.ok) expect(executed.diagnostics.map((item) => item.code)).toContain("undeclared_test_report_artifact");
  });

  it("rejects a report that exceeds its bounded read limit", async () => {
    const store = new MemoryCheckArtifactStore();
    const reportRef = await storeReport(store);
    const executed = await executeStoredVitestReport(
      request(),
      commandResult(reportRef),
      store,
      reportRef,
      "2026-07-23T10:00:03.000Z",
      { maxReportBytes: 10 },
    );
    expect(executed.ok).toBe(false);
    if (!executed.ok) expect(executed.diagnostics.map((item) => item.code)).toContain("test_report_artifact_read_failed");
  });

  it("rejects malformed stored JSON without publishing facts", async () => {
    const store = new MemoryCheckArtifactStore();
    const reportRef = await storeReport(store, "{bad json");
    const executed = await executeStoredVitestReport(request(), commandResult(reportRef), store, reportRef, "2026-07-23T10:00:03.000Z");
    expect(executed.ok).toBe(false);
    if (!executed.ok) expect(executed.diagnostics.map((item) => item.code)).toContain("invalid_test_report_json");
  });
});
