import { describe, expect, it } from "vitest";
import { parseVitestJsonReport, VITEST_JSON_PARSER_VERSION } from "../src/checks/test-report-parser.js";

const report = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  success: true,
  numTotalTestSuites: 2,
  numPassedTestSuites: 2,
  numFailedTestSuites: 0,
  numTotalTests: 5,
  numPassedTests: 4,
  numFailedTests: 0,
  numPendingTests: 1,
  startTime: 1_000,
  testResults: [{ endTime: 1_250 }, { endTime: 1_500 }],
  ...overrides,
});

describe("M3.1 Vitest JSON parser", () => {
  it("publishes stable typed facts", () => {
    const parsed = parseVitestJsonReport(report());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.parser).toBe("vitest-json");
    expect(parsed.value.parserVersion).toBe(VITEST_JSON_PARSER_VERSION);
    expect(parsed.value.facts).toEqual([
      { name: "passed", type: "boolean", value: true },
      { name: "testSuites.total", type: "integer", value: 2 },
      { name: "testSuites.passed", type: "integer", value: 2 },
      { name: "testSuites.failed", type: "integer", value: 0 },
      { name: "tests.total", type: "integer", value: 5 },
      { name: "tests.passed", type: "integer", value: 4 },
      { name: "tests.failed", type: "integer", value: 0 },
      { name: "tests.skipped", type: "integer", value: 1 },
      { name: "durationMs", type: "number", value: 500 },
    ]);
  });

  it("is deterministic for identical input", () => {
    expect(parseVitestJsonReport(report())).toEqual(parseVitestJsonReport(report()));
  });

  it("rejects malformed JSON", () => {
    const parsed = parseVitestJsonReport("{");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics.map((item) => item.code)).toContain("invalid_test_report_json");
  });

  it("rejects missing and incorrectly typed fields", () => {
    const parsed = parseVitestJsonReport(report({ success: "yes", numTotalTests: -1 }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "invalid_test_report_field",
    ]));
  });

  it("rejects inconsistent test totals", () => {
    const parsed = parseVitestJsonReport(report({ numTotalTests: 4 }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics.map((item) => item.code)).toContain("inconsistent_test_report");
  });

  it("rejects an end time before the start time", () => {
    const parsed = parseVitestJsonReport(report({ testResults: [{ endTime: 999 }] }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics.map((item) => item.code)).toContain("invalid_test_report_time");
  });

  it("omits duration when the report has no timing data", () => {
    const value = JSON.parse(report()) as Record<string, unknown>;
    delete value.startTime;
    delete value.testResults;
    const parsed = parseVitestJsonReport(JSON.stringify(value));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.facts.some((fact) => fact.name === "durationMs")).toBe(false);
  });
});
