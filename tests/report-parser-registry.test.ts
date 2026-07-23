import { describe, expect, it } from "vitest";
import { parseReport, REPORT_PARSERS, reportParserDescriptor } from "../src/checks/report-parser-registry.js";

const vitestReport = JSON.stringify({
  success: true,
  numTotalTestSuites: 1,
  numPassedTestSuites: 1,
  numFailedTestSuites: 0,
  numTotalTests: 2,
  numPassedTests: 2,
  numFailedTests: 0,
  numPendingTests: 0,
});

const eslintReport = JSON.stringify([{
  filePath: "src/index.ts",
  errorCount: 0,
  warningCount: 0,
  fixableErrorCount: 0,
  fixableWarningCount: 0,
  messages: [],
}]);

const coverageReport = JSON.stringify({
  total: {
    lines: { total: 1, covered: 1, skipped: 0, pct: 100 },
    statements: { total: 1, covered: 1, skipped: 0, pct: 100 },
    functions: { total: 1, covered: 1, skipped: 0, pct: 100 },
    branches: { total: 1, covered: 1, skipped: 0, pct: 100 },
  },
});

const metricReport = JSON.stringify({ schemaVersion: 1, score: 0.8 });

describe("report parser registry", () => {
  it("publishes a stable parser catalog", () => {
    expect(REPORT_PARSERS).toEqual([
      expect.objectContaining({ name: "vitest-json", version: 1, checkKind: "test-report" }),
      expect.objectContaining({ name: "eslint-json", version: 1, checkKind: "lint-report" }),
      expect.objectContaining({ name: "istanbul-coverage-summary", version: 1, checkKind: "coverage-report" }),
      expect.objectContaining({ name: "metric-json", version: 1, checkKind: "metric-report" }),
    ]);
  });

  it.each([
    ["vitest-json", vitestReport, "passed"],
    ["eslint-json", eslintReport, "errors"],
    ["istanbul-coverage-summary", coverageReport, "coverage.complete"],
  ] as const)("dispatches %s deterministically", (name, report, expectedFact) => {
    const first = parseReport(name, 1, report);
    const second = parseReport(name, 1, report);
    expect(second).toEqual(first);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.parser).toBe(name);
    expect(first.value.facts.some((fact) => fact.name === expectedFact)).toBe(true);
  });

  it("dispatches metric-json with explicit scalar mappings", () => {
    const options = { metricMappings: [{ source: "score", fact: "evaluation.score", type: "number" as const }] };
    const first = parseReport("metric-json", 1, metricReport, options);
    const second = parseReport("metric-json", 1, metricReport, options);
    expect(second).toEqual(first);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.facts).toEqual([{ name: "evaluation.score", type: "number", value: 0.8 }]);
  });

  it("rejects a metric parser call without mappings", () => {
    const parsed = parseReport("metric-json", 1, metricReport);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics[0]?.code).toBe("metric_report_mapping_required");
  });

  it("rejects unknown parser names and versions before input parsing", () => {
    expect(parseReport("unknown", 1, "not-json")).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "unsupported_report_parser" })],
    });
    expect(reportParserDescriptor("vitest-json", 2)).toBeUndefined();
  });

  it("keeps media-type declarations explicit", () => {
    for (const parser of REPORT_PARSERS) {
      expect(parser.mediaTypes).toContain("application/json");
    }
  });
});
