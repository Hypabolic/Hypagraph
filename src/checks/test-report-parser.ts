import type { Diagnostic, FactInput } from "../domain/model.js";

export const VITEST_JSON_PARSER_VERSION = 1 as const;

export interface ParsedTestReport {
  parser: "vitest-json";
  parserVersion: typeof VITEST_JSON_PARSER_VERSION;
  facts: FactInput[];
}

export type TestReportParseResult =
  | { ok: true; value: ParsedTestReport }
  | { ok: false; diagnostics: Diagnostic[] };

interface VitestJsonReport {
  success?: unknown;
  numTotalTestSuites?: unknown;
  numPassedTestSuites?: unknown;
  numFailedTestSuites?: unknown;
  numTotalTests?: unknown;
  numPassedTests?: unknown;
  numFailedTests?: unknown;
  numPendingTests?: unknown;
  startTime?: unknown;
  testResults?: unknown;
}

const integerField = (
  report: VitestJsonReport,
  name: keyof VitestJsonReport,
  diagnostics: Diagnostic[],
): number | undefined => {
  const value = report[name];
  if (!Number.isInteger(value) || (value as number) < 0) {
    diagnostics.push({
      code: "invalid_test_report_field",
      message: `The test report field '${String(name)}' must be a non-negative integer.`,
      location: `report.${String(name)}`,
    });
    return undefined;
  }
  return value as number;
};

const optionalDuration = (report: VitestJsonReport, diagnostics: Diagnostic[]): number | undefined => {
  if (report.startTime === undefined || !Array.isArray(report.testResults)) return undefined;
  if (typeof report.startTime !== "number" || !Number.isFinite(report.startTime)) {
    diagnostics.push({ code: "invalid_test_report_time", message: "The test report start time must be a finite number.", location: "report.startTime" });
    return undefined;
  }

  const endTimes = report.testResults.map((item, index) => {
    if (typeof item !== "object" || item === null || typeof (item as { endTime?: unknown }).endTime !== "number" || !Number.isFinite((item as { endTime: number }).endTime)) {
      diagnostics.push({ code: "invalid_test_report_time", message: "Each test suite end time must be a finite number.", location: `report.testResults.${index}.endTime` });
      return undefined;
    }
    return (item as { endTime: number }).endTime;
  });
  if (endTimes.some((value) => value === undefined)) return undefined;
  const completedAt = endTimes.length === 0 ? report.startTime : Math.max(...endTimes as number[]);
  if (completedAt < report.startTime) {
    diagnostics.push({ code: "invalid_test_report_time", message: "The test report end time cannot be before its start time.", location: "report.testResults" });
    return undefined;
  }
  return completedAt - report.startTime;
};

export function parseVitestJsonReport(input: string): TestReportParseResult {
  let report: VitestJsonReport;
  try {
    const value: unknown = JSON.parse(input);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("The root value is not an object.");
    report = value as VitestJsonReport;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_test_report_json",
        message: `The Vitest report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        location: "report",
      }],
    };
  }

  const diagnostics: Diagnostic[] = [];
  if (typeof report.success !== "boolean") {
    diagnostics.push({ code: "invalid_test_report_field", message: "The test report field 'success' must be Boolean.", location: "report.success" });
  }

  const suitesTotal = integerField(report, "numTotalTestSuites", diagnostics);
  const suitesPassed = integerField(report, "numPassedTestSuites", diagnostics);
  const suitesFailed = integerField(report, "numFailedTestSuites", diagnostics);
  const testsTotal = integerField(report, "numTotalTests", diagnostics);
  const testsPassed = integerField(report, "numPassedTests", diagnostics);
  const testsFailed = integerField(report, "numFailedTests", diagnostics);
  const testsSkipped = integerField(report, "numPendingTests", diagnostics);
  const durationMs = optionalDuration(report, diagnostics);

  if (suitesTotal !== undefined && suitesPassed !== undefined && suitesFailed !== undefined && suitesPassed + suitesFailed > suitesTotal) {
    diagnostics.push({ code: "inconsistent_test_report", message: "Passed and failed suite counts cannot exceed the total suite count.", location: "report.numTotalTestSuites" });
  }
  if (testsTotal !== undefined && testsPassed !== undefined && testsFailed !== undefined && testsSkipped !== undefined && testsPassed + testsFailed + testsSkipped !== testsTotal) {
    diagnostics.push({ code: "inconsistent_test_report", message: "Passed, failed, and skipped test counts must equal the total test count.", location: "report.numTotalTests" });
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const facts: FactInput[] = [
    { name: "passed", type: "boolean", value: report.success as boolean },
    { name: "testSuites.total", type: "integer", value: suitesTotal as number },
    { name: "testSuites.passed", type: "integer", value: suitesPassed as number },
    { name: "testSuites.failed", type: "integer", value: suitesFailed as number },
    { name: "tests.total", type: "integer", value: testsTotal as number },
    { name: "tests.passed", type: "integer", value: testsPassed as number },
    { name: "tests.failed", type: "integer", value: testsFailed as number },
    { name: "tests.skipped", type: "integer", value: testsSkipped as number },
  ];
  if (durationMs !== undefined) facts.push({ name: "durationMs", type: "number", value: durationMs });

  return { ok: true, value: { parser: "vitest-json", parserVersion: VITEST_JSON_PARSER_VERSION, facts } };
}
