import { describe, expect, it } from "vitest";
import { createWorkflow } from "../src/domain/reducer.js";
import { normalizeDefinition, type HypagraphDefineInput } from "../src/pi/definition.js";

const at = "2026-07-23T11:30:00.000Z";

const cases = [
  {
    kind: "test-report" as const,
    parser: "vitest-json" as const,
    namespace: "tests",
    produces: [
      { name: "tests.success", type: "boolean" as const },
      { name: "tests.suites.total", type: "integer" as const },
      { name: "tests.suites.passed", type: "integer" as const },
      { name: "tests.suites.failed", type: "integer" as const },
      { name: "tests.total", type: "integer" as const },
      { name: "tests.passed", type: "integer" as const },
      { name: "tests.failed", type: "integer" as const },
      { name: "tests.skipped", type: "integer" as const },
      { name: "tests.durationMs", type: "number" as const },
    ],
  },
  {
    kind: "lint-report" as const,
    parser: "eslint-json" as const,
    namespace: "lint",
    produces: [
      { name: "lint.passed", type: "boolean" as const },
      { name: "lint.files.total", type: "integer" as const },
      { name: "lint.files.withErrors", type: "integer" as const },
      { name: "lint.files.withWarnings", type: "integer" as const },
      { name: "lint.errors", type: "integer" as const },
      { name: "lint.warnings", type: "integer" as const },
      { name: "lint.fixableErrors", type: "integer" as const },
      { name: "lint.fixableWarnings", type: "integer" as const },
    ],
  },
  {
    kind: "coverage-report" as const,
    parser: "istanbul-coverage-summary" as const,
    namespace: "coverage",
    produces: [
      { name: "coverage.complete", type: "boolean" as const },
      ...["lines", "statements", "functions", "branches"].flatMap((metric) => [
        { name: `coverage.${metric}.total`, type: "integer" as const },
        { name: `coverage.${metric}.covered`, type: "integer" as const },
        { name: `coverage.${metric}.skipped`, type: "integer" as const },
        { name: `coverage.${metric}.percent`, type: "number" as const },
      ]),
    ],
  },
];

describe("Pi report check definitions", () => {
  for (const reportCase of cases) {
    it(`normalizes and validates ${reportCase.kind}`, () => {
      const input: HypagraphDefineInput = {
        title: `Run ${reportCase.kind}`,
        goal: "Publish deterministic report facts",
        nodes: [{
          id: "report",
          title: "Run report",
          kind: "check",
          requires: [],
          acceptance: ["The report is valid."],
          produces: reportCase.produces,
          check: {
            kind: reportCase.kind,
            command: "npm",
            arguments: ["run", "report"],
            workingDirectory: ".",
            timeoutMs: 60_000,
            expectedExitCodes: [0, 1],
            environmentVariables: ["PATH", "CI"],
            retry: { maxAttempts: 2, retryOn: ["failed", "error"], backoffMs: 100 },
            reportPath: "artifacts/report.json",
            parser: { name: reportCase.parser, version: 1 },
            namespace: reportCase.namespace,
            maxReportBytes: 1_048_576,
          } as never,
        }],
        policy: { mode: "guided", requireEvidence: true },
      };

      const normalized = normalizeDefinition(input);
      const check = normalized.nodes[0]?.check;
      expect(check?.kind).toBe(reportCase.kind);
      if (!check || check.kind === "command") return;
      expect(check.parser).toEqual({ name: reportCase.parser, version: 1 });
      expect(check.reportPath).toBe("artifacts/report.json");
      expect(check.namespace).toBe(reportCase.namespace);
      expect(check.retry?.retryOn).toEqual(["failed", "error"]);
      expect(createWorkflow(normalized, at, `workflow-${reportCase.kind}`).ok).toBe(true);
    });
  }

  it("deep clones report command arrays and retry policy", () => {
    const input: HypagraphDefineInput = {
      title: "Clone report definition",
      goal: "Keep normalized report definitions immutable",
      nodes: [{
        id: "tests",
        title: "Tests",
        kind: "check",
        requires: [],
        acceptance: [],
        produces: cases[0]!.produces,
        check: {
          kind: "test-report",
          command: "npm",
          arguments: ["test"],
          timeoutMs: 1_000,
          environmentVariables: ["PATH"],
          retry: { maxAttempts: 2, retryOn: ["failed"] },
          reportPath: "vitest.json",
          parser: { name: "vitest-json", version: 1 },
          namespace: "tests",
        },
      }],
    };

    const normalized = normalizeDefinition(input);
    input.nodes[0]!.check!.arguments![0] = "changed";
    input.nodes[0]!.check!.environmentVariables![0] = "SECRET";
    input.nodes[0]!.check!.retry!.retryOn[0] = "error";

    const check = normalized.nodes[0]?.check;
    expect(check?.arguments).toEqual(["test"]);
    expect(check?.environmentVariables).toEqual(["PATH"]);
    expect(check?.retry?.retryOn).toEqual(["failed"]);
  });
});
