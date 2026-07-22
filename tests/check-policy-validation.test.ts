import { describe, expect, it } from "vitest";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow } from "../src/domain/reducer.js";

const definition = (): HypagraphDefinition => ({
  title: "Validate check policy",
  goal: "Reject invalid retry and environment policy",
  nodes: [{
    id: "tests",
    title: "Run tests",
    kind: "check",
    requires: [],
    acceptance: [],
    check: {
      kind: "command",
      command: "test-command",
      timeoutMs: 60_000,
      environmentVariables: ["PATH"],
      retry: { maxAttempts: 3, retryOn: ["failed"], backoffMs: 0 },
      publish: [],
    },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const diagnostics = (value: HypagraphDefinition) => {
  const result = createWorkflow(value, "2026-07-22T12:00:00.000Z", "workflow-check-policy-validation");
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.diagnostics;
};

describe("check execution policy validation", () => {
  it("rejects invalid and repeated environment variable names", () => {
    const value = definition();
    value.nodes[0]!.check!.environmentVariables = ["PATH", "Path", "A=B"];
    const result = diagnostics(value);
    expect(result.some((item) => item.code === "duplicate_environment_variable")).toBe(true);
    expect(result.some((item) => item.code === "invalid_environment_variable")).toBe(true);
  });

  it("rejects an unbounded or empty retry policy", () => {
    const value = definition();
    value.nodes[0]!.check!.retry = { maxAttempts: 1, retryOn: [] };
    const result = diagnostics(value);
    expect(result.some((item) => item.code === "invalid_check_attempt_limit")).toBe(true);
    expect(result.some((item) => item.code === "retry_status_required")).toBe(true);
  });

  it("rejects repeated retry statuses and excessive backoff", () => {
    const value = definition();
    value.nodes[0]!.check!.retry = {
      maxAttempts: 3,
      retryOn: ["failed", "failed"],
      backoffMs: 86_400_001,
    };
    const result = diagnostics(value);
    expect(result.some((item) => item.code === "duplicate_retry_status")).toBe(true);
    expect(result.some((item) => item.code === "invalid_retry_backoff")).toBe(true);
  });
});
