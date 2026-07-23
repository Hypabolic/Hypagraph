import type { Diagnostic, FactInput } from "../domain/model.js";

export const ESLINT_JSON_PARSER_VERSION = 1 as const;

export interface ParsedLintReport {
  parser: "eslint-json";
  parserVersion: typeof ESLINT_JSON_PARSER_VERSION;
  facts: FactInput[];
}

export type LintReportParseResult =
  | { ok: true; value: ParsedLintReport }
  | { ok: false; diagnostics: Diagnostic[] };

interface EslintMessage {
  severity?: unknown;
  fix?: unknown;
}

interface EslintFileResult {
  filePath?: unknown;
  errorCount?: unknown;
  warningCount?: unknown;
  fixableErrorCount?: unknown;
  fixableWarningCount?: unknown;
  messages?: unknown;
}

const nonNegativeInteger = (
  value: unknown,
  location: string,
  diagnostics: Diagnostic[],
): number | undefined => {
  if (!Number.isInteger(value) || (value as number) < 0) {
    diagnostics.push({
      code: "invalid_lint_report_field",
      message: "The lint report count must be a non-negative integer.",
      location,
    });
    return undefined;
  }
  return value as number;
};

export function parseEslintJsonReport(input: string): LintReportParseResult {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_lint_report_json",
        message: `The ESLint report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        location: "report",
      }],
    };
  }

  if (!Array.isArray(value)) {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_lint_report_root",
        message: "The ESLint JSON report root must be an array.",
        location: "report",
      }],
    };
  }

  const diagnostics: Diagnostic[] = [];
  let errors = 0;
  let warnings = 0;
  let fixableErrors = 0;
  let fixableWarnings = 0;
  let filesWithErrors = 0;
  let filesWithWarnings = 0;

  value.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      diagnostics.push({ code: "invalid_lint_report_entry", message: "Each ESLint result must be an object.", location: `report.${index}` });
      return;
    }
    const result = entry as EslintFileResult;
    if (typeof result.filePath !== "string" || result.filePath.length === 0) {
      diagnostics.push({ code: "invalid_lint_report_field", message: "Each ESLint result must contain a non-empty file path.", location: `report.${index}.filePath` });
    }
    const errorCount = nonNegativeInteger(result.errorCount, `report.${index}.errorCount`, diagnostics);
    const warningCount = nonNegativeInteger(result.warningCount, `report.${index}.warningCount`, diagnostics);
    const fixableErrorCount = nonNegativeInteger(result.fixableErrorCount, `report.${index}.fixableErrorCount`, diagnostics);
    const fixableWarningCount = nonNegativeInteger(result.fixableWarningCount, `report.${index}.fixableWarningCount`, diagnostics);

    if (!Array.isArray(result.messages)) {
      diagnostics.push({ code: "invalid_lint_report_field", message: "Each ESLint result must contain a messages array.", location: `report.${index}.messages` });
    } else {
      let messageErrors = 0;
      let messageWarnings = 0;
      let messageFixableErrors = 0;
      let messageFixableWarnings = 0;
      result.messages.forEach((message, messageIndex) => {
        if (typeof message !== "object" || message === null || Array.isArray(message)) {
          diagnostics.push({ code: "invalid_lint_report_message", message: "Each ESLint message must be an object.", location: `report.${index}.messages.${messageIndex}` });
          return;
        }
        const lintMessage = message as EslintMessage;
        if (lintMessage.severity !== 1 && lintMessage.severity !== 2) {
          diagnostics.push({ code: "invalid_lint_report_severity", message: "ESLint message severity must be 1 or 2.", location: `report.${index}.messages.${messageIndex}.severity` });
          return;
        }
        const fixable = typeof lintMessage.fix === "object" && lintMessage.fix !== null;
        if (lintMessage.severity === 2) {
          messageErrors += 1;
          if (fixable) messageFixableErrors += 1;
        } else {
          messageWarnings += 1;
          if (fixable) messageFixableWarnings += 1;
        }
      });
      if (errorCount !== undefined && messageErrors !== errorCount) diagnostics.push({ code: "inconsistent_lint_report", message: "The ESLint error count does not match its messages.", location: `report.${index}.errorCount` });
      if (warningCount !== undefined && messageWarnings !== warningCount) diagnostics.push({ code: "inconsistent_lint_report", message: "The ESLint warning count does not match its messages.", location: `report.${index}.warningCount` });
      if (fixableErrorCount !== undefined && messageFixableErrors !== fixableErrorCount) diagnostics.push({ code: "inconsistent_lint_report", message: "The ESLint fixable error count does not match its messages.", location: `report.${index}.fixableErrorCount` });
      if (fixableWarningCount !== undefined && messageFixableWarnings !== fixableWarningCount) diagnostics.push({ code: "inconsistent_lint_report", message: "The ESLint fixable warning count does not match its messages.", location: `report.${index}.fixableWarningCount` });
    }

    if (errorCount !== undefined) {
      errors += errorCount;
      if (errorCount > 0) filesWithErrors += 1;
    }
    if (warningCount !== undefined) {
      warnings += warningCount;
      if (warningCount > 0) filesWithWarnings += 1;
    }
    if (fixableErrorCount !== undefined) fixableErrors += fixableErrorCount;
    if (fixableWarningCount !== undefined) fixableWarnings += fixableWarningCount;
  });

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const facts: FactInput[] = [
    { name: "passed", type: "boolean", value: errors === 0 },
    { name: "files.total", type: "integer", value: value.length },
    { name: "files.withErrors", type: "integer", value: filesWithErrors },
    { name: "files.withWarnings", type: "integer", value: filesWithWarnings },
    { name: "errors", type: "integer", value: errors },
    { name: "warnings", type: "integer", value: warnings },
    { name: "fixableErrors", type: "integer", value: fixableErrors },
    { name: "fixableWarnings", type: "integer", value: fixableWarnings },
  ];

  return { ok: true, value: { parser: "eslint-json", parserVersion: ESLINT_JSON_PARSER_VERSION, facts } };
}
