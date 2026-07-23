import type {
  Diagnostic,
  EvaluationDiagnostic,
  EvaluationFeedbackPolicy,
  FactInput,
  MetricReportMapping,
  MetricScalarType,
} from "../domain/model.js";

export type { MetricReportMapping, MetricScalarType } from "../domain/model.js";

export const METRIC_JSON_PARSER_VERSION = 1 as const;

export interface ParsedMetricReport {
  parser: "metric-json";
  parserVersion: typeof METRIC_JSON_PARSER_VERSION;
  facts: FactInput[];
  diagnostics: EvaluationDiagnostic[];
  diagnosticsTruncated: boolean;
}

export type MetricReportParseResult =
  | { ok: true; value: ParsedMetricReport }
  | { ok: false; diagnostics: Diagnostic[] };

const SOURCE_PATH_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const DIAGNOSTIC_CODE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const readPath = (root: Record<string, unknown>, source: string): { found: boolean; value?: unknown } => {
  let current: unknown = root;
  for (const segment of source.split(".")) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: current };
};

const validScalar = (value: unknown, type: MetricScalarType): boolean => {
  switch (type) {
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
  }
};

export function parseMetricJsonReport(
  input: string,
  mappings: readonly MetricReportMapping[],
  feedback?: EvaluationFeedbackPolicy,
): MetricReportParseResult {
  let report: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(input);
    if (!isRecord(value)) throw new Error("The root value is not an object.");
    report = value;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_metric_report_json",
        message: `The metric report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        location: "report",
      }],
    };
  }

  const diagnostics: Diagnostic[] = [];
  if (report.schemaVersion !== METRIC_JSON_PARSER_VERSION) {
    diagnostics.push({
      code: "unsupported_metric_report_schema",
      message: `The metric report requires schemaVersion ${METRIC_JSON_PARSER_VERSION}.`,
      location: "report.schemaVersion",
    });
  }

  if (mappings.length === 0) {
    diagnostics.push({
      code: "metric_report_mapping_required",
      message: "A metric report requires at least one declared scalar mapping.",
      location: "check.mappings",
    });
  }

  const sources = new Set<string>();
  const facts = new Set<string>();
  const output: FactInput[] = [];


  const publicDiagnostics: EvaluationDiagnostic[] = [];
  let diagnosticsTruncated = false;
  if (feedback?.mode === "bounded-diagnostics") {
    const source = report.diagnostics;
    if (source !== undefined && !Array.isArray(source)) {
      diagnostics.push({
        code: "invalid_evaluation_diagnostics",
        message: "The metric report diagnostics value must be an array.",
        location: "report.diagnostics",
      });
    } else if (Array.isArray(source)) {
      const limit = feedback.maximumDiagnosticItems ?? 0;
      diagnosticsTruncated = source.length > limit;
      source.slice(0, limit).forEach((item, index) => {
        const location = `report.diagnostics[${index}]`;
        if (!isRecord(item)
          || typeof item.code !== "string"
          || !DIAGNOSTIC_CODE_PATTERN.test(item.code)
          || typeof item.message !== "string"
          || item.message.length < 1
          || item.message.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH) {
          diagnostics.push({
            code: "invalid_evaluation_diagnostic",
            message: "Each public evaluation diagnostic must contain a stable code and a bounded message.",
            location,
          });
          return;
        }
        publicDiagnostics.push({ code: item.code, message: item.message });
      });
    }
  }

  mappings.forEach((mapping, index) => {
    const location = `check.mappings[${index}]`;
    const segments = mapping.source.split(".");
    if (!SOURCE_PATH_PATTERN.test(mapping.source) || segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
      diagnostics.push({
        code: "invalid_metric_source_path",
        message: `Metric source '${mapping.source}' is not a safe scalar path.`,
        location: `${location}.source`,
      });
      return;
    }
    if (sources.has(mapping.source)) {
      diagnostics.push({ code: "duplicate_metric_source", message: `Metric source '${mapping.source}' is mapped more than one time.`, location: `${location}.source` });
      return;
    }
    if (facts.has(mapping.fact)) {
      diagnostics.push({ code: "duplicate_metric_fact", message: `Metric fact '${mapping.fact}' is mapped more than one time.`, location: `${location}.fact` });
      return;
    }
    sources.add(mapping.source);
    facts.add(mapping.fact);

    const selected = readPath(report, mapping.source);
    if (!selected.found) {
      if (mapping.required !== false) diagnostics.push({
        code: "missing_metric_report_value",
        message: `The metric report does not contain required source '${mapping.source}' for fact '${mapping.fact}'.`,
        location: `report.${mapping.source}`,
      });
      return;
    }
    if (!validScalar(selected.value, mapping.type)) {
      diagnostics.push({
        code: typeof selected.value === "number" && !Number.isFinite(selected.value)
          ? "non_finite_metric_report_value"
          : "metric_report_type_mismatch",
        message: `Metric source '${mapping.source}' for fact '${mapping.fact}' must have type '${mapping.type}'.`,
        location: `report.${mapping.source}`,
      });
      return;
    }
    output.push({ name: mapping.fact, type: mapping.type, value: selected.value as boolean | number | string });
  });

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return {
    ok: true,
    value: {
      parser: "metric-json",
      parserVersion: METRIC_JSON_PARSER_VERSION,
      facts: output,
      diagnostics: publicDiagnostics,
      diagnosticsTruncated,
    },
  };
}
