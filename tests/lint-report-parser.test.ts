import { describe, expect, it } from "vitest";
import { parseEslintJsonReport } from "../src/checks/lint-report-parser.js";

const report = JSON.stringify([
  {
    filePath: "/repo/src/a.ts",
    errorCount: 1,
    warningCount: 1,
    fixableErrorCount: 1,
    fixableWarningCount: 0,
    messages: [
      { severity: 2, ruleId: "semi", fix: { range: [10, 10], text: ";" } },
      { severity: 1, ruleId: "no-console" },
    ],
  },
  {
    filePath: "/repo/src/b.ts",
    errorCount: 0,
    warningCount: 1,
    fixableErrorCount: 0,
    fixableWarningCount: 1,
    messages: [
      { severity: 1, ruleId: "quotes", fix: { range: [1, 2], text: "'" } },
    ],
  },
]);

describe("M3.1 ESLint JSON parser", () => {
  it("publishes stable aggregate lint facts", () => {
    const parsed = parseEslintJsonReport(report);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.parser).toBe("eslint-json");
    expect(parsed.value.parserVersion).toBe(1);
    expect(parsed.value.facts).toEqual([
      { name: "passed", type: "boolean", value: false },
      { name: "files.total", type: "integer", value: 2 },
      { name: "files.withErrors", type: "integer", value: 1 },
      { name: "files.withWarnings", type: "integer", value: 2 },
      { name: "errors", type: "integer", value: 1 },
      { name: "warnings", type: "integer", value: 2 },
      { name: "fixableErrors", type: "integer", value: 1 },
      { name: "fixableWarnings", type: "integer", value: 1 },
    ]);
  });

  it("is deterministic for identical input", () => {
    expect(parseEslintJsonReport(report)).toEqual(parseEslintJsonReport(report));
  });

  it("rejects malformed JSON and non-array roots", () => {
    const malformed = parseEslintJsonReport("{");
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.diagnostics[0]?.code).toBe("invalid_lint_report_json");

    const wrongRoot = parseEslintJsonReport("{}");
    expect(wrongRoot.ok).toBe(false);
    if (!wrongRoot.ok) expect(wrongRoot.diagnostics[0]?.code).toBe("invalid_lint_report_root");
  });

  it("rejects inconsistent summary counts", () => {
    const parsed = parseEslintJsonReport(JSON.stringify([
      {
        filePath: "/repo/src/a.ts",
        errorCount: 0,
        warningCount: 0,
        fixableErrorCount: 0,
        fixableWarningCount: 0,
        messages: [{ severity: 2, ruleId: "semi" }],
      },
    ]));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain("inconsistent_lint_report");
  });

  it("rejects invalid severity values and negative counts", () => {
    const parsed = parseEslintJsonReport(JSON.stringify([
      {
        filePath: "/repo/src/a.ts",
        errorCount: -1,
        warningCount: 0,
        fixableErrorCount: 0,
        fixableWarningCount: 0,
        messages: [{ severity: 3, ruleId: "unknown" }],
      },
    ]));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const codes = parsed.diagnostics.map((diagnostic) => diagnostic.code);
      expect(codes).toContain("invalid_lint_report_field");
      expect(codes).toContain("invalid_lint_report_severity");
    }
  });
});
