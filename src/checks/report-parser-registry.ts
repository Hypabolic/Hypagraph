import type { Diagnostic, FactInput } from "../domain/model.js";
import { parseIstanbulCoverageSummary } from "./coverage-report-parser.js";
import { parseEslintJsonReport } from "./lint-report-parser.js";
import { parseVitestJsonReport } from "./test-report-parser.js";

export type ReportParserName = "vitest-json" | "eslint-json" | "istanbul-coverage-summary";

export interface ReportParserDescriptor {
  name: ReportParserName;
  version: 1;
  checkKind: "test-report" | "lint-report" | "coverage-report";
  mediaTypes: readonly string[];
}

export interface ParsedReport {
  parser: ReportParserName;
  parserVersion: 1;
  facts: FactInput[];
}

export type ReportParserResult =
  | { ok: true; value: ParsedReport }
  | { ok: false; diagnostics: Diagnostic[] };

export const REPORT_PARSERS: readonly ReportParserDescriptor[] = [
  {
    name: "vitest-json",
    version: 1,
    checkKind: "test-report",
    mediaTypes: ["application/json", "application/json; charset=utf-8"],
  },
  {
    name: "eslint-json",
    version: 1,
    checkKind: "lint-report",
    mediaTypes: ["application/json", "application/json; charset=utf-8"],
  },
  {
    name: "istanbul-coverage-summary",
    version: 1,
    checkKind: "coverage-report",
    mediaTypes: ["application/json", "application/json; charset=utf-8"],
  },
] as const;

export function reportParserDescriptor(name: string, version: number): ReportParserDescriptor | undefined {
  return REPORT_PARSERS.find((parser) => parser.name === name && parser.version === version);
}

export function parseReport(name: string, version: number, input: string): ReportParserResult {
  const descriptor = reportParserDescriptor(name, version);
  if (!descriptor) {
    return {
      ok: false,
      diagnostics: [{
        code: "unsupported_report_parser",
        message: `Report parser '${name}' version '${version}' is not supported.`,
        location: "check.parser",
      }],
    };
  }

  switch (descriptor.name) {
    case "vitest-json": return parseVitestJsonReport(input);
    case "eslint-json": return parseEslintJsonReport(input);
    case "istanbul-coverage-summary": return parseIstanbulCoverageSummary(input);
  }
}
