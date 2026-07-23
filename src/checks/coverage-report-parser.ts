import type { Diagnostic, FactInput } from "../domain/model.js";

export const ISTANBUL_COVERAGE_SUMMARY_PARSER_VERSION = 1 as const;

type CoverageMetricName = "lines" | "statements" | "functions" | "branches";

interface IstanbulMetric {
  total?: unknown;
  covered?: unknown;
  skipped?: unknown;
  pct?: unknown;
}

interface IstanbulCoverageSummary {
  total?: unknown;
}

export interface ParsedCoverageReport {
  parser: "istanbul-coverage-summary";
  parserVersion: typeof ISTANBUL_COVERAGE_SUMMARY_PARSER_VERSION;
  facts: FactInput[];
}

export type CoverageReportParseResult =
  | { ok: true; value: ParsedCoverageReport }
  | { ok: false; diagnostics: Diagnostic[] };

const metricNames: readonly CoverageMetricName[] = ["lines", "statements", "functions", "branches"];

const nonNegativeInteger = (
  value: unknown,
  location: string,
  diagnostics: Diagnostic[],
): number | undefined => {
  if (!Number.isInteger(value) || (value as number) < 0) {
    diagnostics.push({
      code: "invalid_coverage_report_field",
      message: "Coverage counts must be non-negative integers.",
      location,
    });
    return undefined;
  }
  return value as number;
};

const percentage = (
  value: unknown,
  location: string,
  diagnostics: Diagnostic[],
): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    diagnostics.push({
      code: "invalid_coverage_percentage",
      message: "Coverage percentages must be finite numbers between 0 and 100.",
      location,
    });
    return undefined;
  }
  return value;
};

const parseMetric = (
  metricName: CoverageMetricName,
  value: unknown,
  diagnostics: Diagnostic[],
): FactInput[] => {
  const location = `report.total.${metricName}`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    diagnostics.push({
      code: "invalid_coverage_metric",
      message: `Coverage metric '${metricName}' must be an object.`,
      location,
    });
    return [];
  }

  const metric = value as IstanbulMetric;
  const total = nonNegativeInteger(metric.total, `${location}.total`, diagnostics);
  const covered = nonNegativeInteger(metric.covered, `${location}.covered`, diagnostics);
  const skipped = nonNegativeInteger(metric.skipped, `${location}.skipped`, diagnostics);
  const pct = percentage(metric.pct, `${location}.pct`, diagnostics);

  if (total !== undefined && covered !== undefined && covered > total) {
    diagnostics.push({
      code: "inconsistent_coverage_report",
      message: `Covered ${metricName} cannot exceed total ${metricName}.`,
      location,
    });
  }
  if (total !== undefined && skipped !== undefined && skipped > total) {
    diagnostics.push({
      code: "inconsistent_coverage_report",
      message: `Skipped ${metricName} cannot exceed total ${metricName}.`,
      location,
    });
  }
  if (total !== undefined && covered !== undefined && skipped !== undefined && covered + skipped > total) {
    diagnostics.push({
      code: "inconsistent_coverage_report",
      message: `Covered and skipped ${metricName} cannot exceed total ${metricName}.`,
      location,
    });
  }
  if (total !== undefined && covered !== undefined && pct !== undefined) {
    const expected = total === 0 ? 100 : Math.floor((covered / total) * 10_000) / 100;
    if (Math.abs(expected - pct) > 0.01) {
      diagnostics.push({
        code: "inconsistent_coverage_percentage",
        message: `Coverage percentage for '${metricName}' does not match its covered and total counts.`,
        location: `${location}.pct`,
      });
    }
  }

  if (total === undefined || covered === undefined || skipped === undefined || pct === undefined) return [];
  return [
    { name: `coverage.${metricName}.total`, type: "integer", value: total },
    { name: `coverage.${metricName}.covered`, type: "integer", value: covered },
    { name: `coverage.${metricName}.skipped`, type: "integer", value: skipped },
    { name: `coverage.${metricName}.percent`, type: "number", value: pct },
  ];
};

export function parseIstanbulCoverageSummary(input: string): CoverageReportParseResult {
  let report: IstanbulCoverageSummary;
  try {
    const value: unknown = JSON.parse(input);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("The root value is not an object.");
    }
    report = value as IstanbulCoverageSummary;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_coverage_report_json",
        message: `The Istanbul coverage summary is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        location: "report",
      }],
    };
  }

  if (typeof report.total !== "object" || report.total === null || Array.isArray(report.total)) {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_coverage_report_total",
        message: "The Istanbul coverage summary must contain a total object.",
        location: "report.total",
      }],
    };
  }

  const diagnostics: Diagnostic[] = [];
  const total = report.total as Record<string, unknown>;
  const facts = metricNames.flatMap((metricName) => parseMetric(metricName, total[metricName], diagnostics));
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const passed = metricNames.every((metricName) => {
    const fact = facts.find((item) => item.name === `coverage.${metricName}.percent`);
    return fact?.value === 100;
  });
  facts.unshift({ name: "coverage.complete", type: "boolean", value: passed });

  return {
    ok: true,
    value: {
      parser: "istanbul-coverage-summary",
      parserVersion: ISTANBUL_COVERAGE_SUMMARY_PARSER_VERSION,
      facts,
    },
  };
}
