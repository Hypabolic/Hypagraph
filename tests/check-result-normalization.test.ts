import { describe, expect, it } from "vitest";
import type { CheckExecutionRequest, CheckResult } from "../src/domain/model.js";
import { createCheckFactPublicationCommand, normalizeCheckResult } from "../src/checks/normalization.js";

const request = (): CheckExecutionRequest => ({
  workflowId: "workflow-1",
  revision: 3,
  nodeId: "run-tests",
  attemptId: "attempt-1",
  requestedAt: "2026-07-22T10:00:00.000Z",
  definition: {
    kind: "command",
    command: "npm",
    arguments: ["test"],
    timeoutMs: 60_000,
    publish: [
      { source: "passed", fact: "tests.passed" },
      { source: "status", fact: "tests.status" },
      { source: "exitCode", fact: "tests.exit_code" },
      { source: "durationMs", fact: "tests.duration_ms" },
      { source: "timedOut", fact: "tests.timed_out" },
      { source: "cancelled", fact: "tests.cancelled" },
    ],
  },
});

const result = (): CheckResult => ({
  checkKind: "command",
  attemptId: "attempt-1",
  startedAt: "2026-07-22T10:00:01.000Z",
  completedAt: "2026-07-22T10:00:02.250Z",
  status: "passed",
  exitCode: 0,
  facts: [],
  evidence: [{ ref: "artifact://stdout", kind: "file", summary: "Command stdout." }],
});

describe("M3 check result normalization", () => {
  it("maps command results to stable typed facts", () => {
    const normalized = normalizeCheckResult(request(), result());
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.facts).toEqual([
      { name: "tests.passed", type: "boolean", value: true, evidence: result().evidence },
      { name: "tests.status", type: "string", value: "passed", evidence: result().evidence },
      { name: "tests.exit_code", type: "integer", value: 0, evidence: result().evidence },
      { name: "tests.duration_ms", type: "number", value: 1250, evidence: result().evidence },
      { name: "tests.timed_out", type: "boolean", value: false, evidence: result().evidence },
      { name: "tests.cancelled", type: "boolean", value: false, evidence: result().evidence },
    ]);
  });

  it("creates an identical publication command for identical input", () => {
    const first = createCheckFactPublicationCommand(request(), result(), "2026-07-22T10:00:03.000Z");
    const second = createCheckFactPublicationCommand(request(), result(), "2026-07-22T10:00:03.000Z");
    expect(first).toEqual(second);
  });

  it("rejects an unavailable exit code", () => {
    const value = result();
    delete value.exitCode;
    const normalized = normalizeCheckResult(request(), value);
    expect(normalized.ok).toBe(false);
    if (!normalized.ok) expect(normalized.diagnostics.map((item) => item.code)).toContain("check_source_unavailable");
  });

  it("rejects mismatched attempts and invalid time order", () => {
    const value = result();
    value.attemptId = "attempt-2";
    value.completedAt = "2026-07-22T09:59:00.000Z";
    const normalized = normalizeCheckResult(request(), value);
    expect(normalized.ok).toBe(false);
    if (!normalized.ok) expect(normalized.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "check_attempt_mismatch",
      "invalid_check_result_time",
    ]));
  });
});
