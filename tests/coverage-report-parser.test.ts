import { describe, expect, it } from "vitest";
import { parseIstanbulCoverageSummary } from "../src/checks/coverage-report-parser.js";

const metric = (total: number, covered: number, skipped = 0) => ({
  total,
  covered,
  skipped,
  pct: total === 0 ? 100 : Math.floor((covered / total) * 10_000) / 100,
});

const report = (covered = 8): string => JSON.stringify({
  total: {
    lines: metric(10, covered),
    statements: metric(10, covered),
    functions: metric(10, covered),
    branches: metric(10, covered),
  },
  "src/example.ts": {
    lines: metric(10, covered),
    statements: metric(10, covered),
    functions: metric(10, covered),
    branches: metric(10, covered),
  },
});

describe("M3.1 Istanbul coverage summary parser", () => {
  it("publishes stable typed aggregate coverage facts", () => {
    const parsed = parseIstanbulCoverageSummary(report());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.parser).toBe("istanbul-coverage-summary");
    expect(parsed.value.parserVersion).toBe(1);
    expect(parsed.value.facts).toContainEqual({ name: "coverage.complete", type: "boolean", value: false });
    expect(parsed.value.facts).toContainEqual({ name: "coverage.lines.total", type: "integer", value: 10 });
    expect(parsed.value.facts).toContainEqual({ name: "coverage.lines.covered", type: "integer", value: 8 });
    expect(parsed.value.facts).toContainEqual({ name: "coverage.lines.percent", type: "number", value: 80 });
  });

  it("marks complete aggregate coverage when every metric is fully covered", () => {
    const parsed = parseIstanbulCoverageSummary(report(10));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.facts).toContainEqual({ name: "coverage.complete", type: "boolean", value: true });
  });

  it("is deterministic for identical input", () => {
    expect(parseIstanbulCoverageSummary(report())).toEqual(parseIstanbulCoverageSummary(report()));
  });

  it("rejects malformed JSON", () => {
    const parsed = parseIstanbulCoverageSummary("{");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics.map((item) => item.code)).toContain("invalid_coverage_report_json");
  });

  it("rejects missing total aggregates", () => {
    const parsed = parseIstanbulCoverageSummary(JSON.stringify({}));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics.map((item) => item.code)).toContain("invalid_coverage_report_total");
  });

  it("rejects non-finite or out-of-range percentages", () => {
    const value = JSON.parse(report()) as { total: { lines: { pct: number } } };
    value.total.lines.pct = 101;
    const parsed = parseIstanbulCoverageSummary(JSON.stringify(value));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics.map((item) => item.code)).toContain("invalid_coverage_percentage");
  });

  it("rejects percentages that disagree with covered and total counts", () => {
    const value = JSON.parse(report()) as { total: { lines: { pct: number } } };
    value.total.lines.pct = 79;
    const parsed = parseIstanbulCoverageSummary(JSON.stringify(value));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics.map((item) => item.code)).toContain("inconsistent_coverage_percentage");
  });

  it("rejects covered and skipped counts that exceed the total", () => {
    const value = JSON.parse(report()) as { total: { branches: { total: number; covered: number; skipped: number; pct: number } } };
    value.total.branches = { total: 4, covered: 4, skipped: 1, pct: 100 };
    const parsed = parseIstanbulCoverageSummary(JSON.stringify(value));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics.map((item) => item.code)).toContain("inconsistent_coverage_report");
  });
});
