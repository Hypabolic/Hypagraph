import { describe, expect, it } from "vitest";
import { parseMetricJsonReport, type MetricReportMapping } from "../src/checks/metric-report-parser.js";

const mappings: MetricReportMapping[] = [
  { source: "valid", fact: "evaluation.valid", type: "boolean" },
  { source: "score", fact: "evaluation.score", type: "number" },
  { source: "metrics.precision", fact: "evaluation.precision", type: "number" },
  { source: "metrics.cases", fact: "evaluation.cases", type: "integer" },
  { source: "summaryCode", fact: "evaluation.summary-code", type: "string" },
  { source: "metrics.optional", fact: "evaluation.optional", type: "number", required: false },
];

const report = JSON.stringify({
  schemaVersion: 1,
  valid: true,
  score: 0.847,
  metrics: { precision: 0.88, cases: 12 },
  summaryCode: "below_target",
});

describe("M5A deterministic metric JSON parser", () => {
  it("publishes declared scalar facts in mapping order", () => {
    const parsed = parseMetricJsonReport(report, mappings);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.parser).toBe("metric-json");
    expect(parsed.value.parserVersion).toBe(1);
    expect(parsed.value.facts).toEqual([
      { name: "evaluation.valid", type: "boolean", value: true },
      { name: "evaluation.score", type: "number", value: 0.847 },
      { name: "evaluation.precision", type: "number", value: 0.88 },
      { name: "evaluation.cases", type: "integer", value: 12 },
      { name: "evaluation.summary-code", type: "string", value: "below_target" },
    ]);
  });

  it("is deterministic for identical input and mappings", () => {
    expect(parseMetricJsonReport(report, mappings)).toEqual(parseMetricJsonReport(report, mappings));
  });

  it("rejects malformed JSON, a non-object root, and unsupported schema versions", () => {
    const malformed = parseMetricJsonReport("{", mappings);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.diagnostics[0]?.code).toBe("invalid_metric_report_json");

    const arrayRoot = parseMetricJsonReport("[]", mappings);
    expect(arrayRoot.ok).toBe(false);
    if (!arrayRoot.ok) expect(arrayRoot.diagnostics[0]?.code).toBe("invalid_metric_report_json");

    const version = parseMetricJsonReport(JSON.stringify({ schemaVersion: 2 }), mappings);
    expect(version.ok).toBe(false);
    if (!version.ok) expect(version.diagnostics.map((item) => item.code)).toContain("unsupported_metric_report_schema");
  });

  it("rejects missing required values and permits absent optional values", () => {
    const parsed = parseMetricJsonReport(JSON.stringify({
      schemaVersion: 1,
      valid: true,
      metrics: { precision: 0.88, cases: 12 },
      summaryCode: "missing_score",
    }), mappings);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics.map((item) => item.code)).toContain("missing_metric_report_value");
  });

  it("rejects non-finite numbers and scalar type mismatches", () => {
    const nonFinite = parseMetricJsonReport(JSON.stringify({
      schemaVersion: 1,
      valid: true,
      score: "NaN",
      metrics: { precision: 0.88, cases: 12 },
      summaryCode: "bad_score",
    }), mappings);
    expect(nonFinite.ok).toBe(false);
    if (!nonFinite.ok) expect(nonFinite.diagnostics.map((item) => item.code)).toContain("metric_report_type_mismatch");

    const direct = parseMetricJsonReport("{\"schemaVersion\":1,\"score\":1e999}", [
      { source: "score", fact: "evaluation.score", type: "number" },
    ]);
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.diagnostics.map((item) => item.code)).toContain("non_finite_metric_report_value");
  });

  it("rejects unsafe paths and duplicate mappings", () => {
    const parsed = parseMetricJsonReport(report, [
      { source: "__proto__.score", fact: "evaluation.score", type: "number" },
      { source: "score", fact: "evaluation.score", type: "number" },
      { source: "score", fact: "evaluation.score-two", type: "number" },
    ]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const codes = parsed.diagnostics.map((item) => item.code);
      expect(codes).toContain("invalid_metric_source_path");
      expect(codes).toContain("duplicate_metric_source");
    }
  });

  it("requires at least one declared mapping", () => {
    const parsed = parseMetricJsonReport(report, []);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics.map((item) => item.code)).toContain("metric_report_mapping_required");
  });
});
