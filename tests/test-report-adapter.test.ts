import { describe, expect, it } from "vitest";
import type { CheckResult } from "../src/domain/model.js";
import { adaptVitestJsonResult } from "../src/checks/test-report-adapter.js";

const commandResult = (status: CheckResult["status"] = "passed"): CheckResult => ({
  checkKind: "command",
  attemptId: "attempt-1",
  startedAt: "2026-07-23T10:00:00.000Z",
  completedAt: "2026-07-23T10:00:01.000Z",
  status,
  exitCode: status === "passed" ? 0 : 1,
  facts: [],
  evidence: [{ ref: "artifact://vitest.json", kind: "file", summary: "Vitest JSON report." }],
});

const report = (success = true): string => JSON.stringify({
  success,
  numTotalTestSuites: 2,
  numPassedTestSuites: success ? 2 : 1,
  numFailedTestSuites: success ? 0 : 1,
  numTotalTests: 5,
  numPassedTests: success ? 4 : 3,
  numFailedTests: success ? 0 : 1,
  numPendingTests: 1,
  startTime: 1000,
  testResults: [{ endTime: 1250 }, { endTime: 1500 }],
});

describe("M3.1 test report result adapter", () => {
  it("converts a bounded command result and Vitest report into typed namespaced facts", () => {
    const adapted = adaptVitestJsonResult(commandResult(), report());
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.result.checkKind).toBe("test-report");
    expect(adapted.result.facts).toContainEqual({
      name: "tests.total",
      type: "integer",
      value: 5,
      evidence: commandResult().evidence,
    });
    expect(adapted.result.facts).toContainEqual({
      name: "tests.durationMs",
      type: "number",
      value: 500,
      evidence: commandResult().evidence,
    });
  });

  it("is deterministic for identical input", () => {
    expect(adaptVitestJsonResult(commandResult(), report())).toEqual(adaptVitestJsonResult(commandResult(), report()));
  });

  it("rejects a report whose pass state disagrees with the command status", () => {
    const adapted = adaptVitestJsonResult(commandResult("failed"), report(true));
    expect(adapted.ok).toBe(false);
    if (!adapted.ok) expect(adapted.diagnostics.map((item) => item.code)).toContain("inconsistent_test_report_status");
  });

  it("rejects incomplete command execution before facts can be published", () => {
    const adapted = adaptVitestJsonResult(commandResult("timed_out"), report(false));
    expect(adapted.ok).toBe(false);
    if (!adapted.ok) expect(adapted.diagnostics.map((item) => item.code)).toContain("test_report_command_incomplete");
  });

  it("rejects invalid fact namespaces", () => {
    const adapted = adaptVitestJsonResult(commandResult(), report(), { namespace: "Tests bad" });
    expect(adapted.ok).toBe(false);
    if (!adapted.ok) expect(adapted.diagnostics.map((item) => item.code)).toContain("invalid_test_report_namespace");
  });
});
