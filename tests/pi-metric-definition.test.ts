import { describe, expect, it } from "vitest";
import { createWorkflow } from "../src/domain/reducer.js";
import { normalizeDefinition, type HypagraphDefineInput } from "../src/pi/definition.js";

const at = "2026-07-23T13:00:00.000Z";

const input = (): HypagraphDefineInput => ({
  title: "Evaluate quality",
  goal: "Publish typed evaluator metrics",
  nodes: [{
    id: "evaluate",
    title: "Evaluate",
    kind: "check",
    requires: [],
    acceptance: ["The evaluator report is valid."],
    produces: [
      { name: "evaluation.valid", type: "boolean", required: true },
      { name: "evaluation.score", type: "number", required: true },
      { name: "evaluation.cases", type: "integer", required: true },
      { name: "evaluation.summary-code", type: "string", required: false },
    ],
    check: {
      kind: "metric-report",
      command: "node",
      arguments: ["evaluate.mjs"],
      timeoutMs: 30_000,
      reportPath: "artifacts/metrics.json",
      parser: { name: "metric-json", version: 1 },
      mappings: [
        { source: "valid", fact: "evaluation.valid", type: "boolean" },
        { source: "score", fact: "evaluation.score", type: "number" },
        { source: "metrics.cases", fact: "evaluation.cases", type: "integer" },
        { source: "summaryCode", fact: "evaluation.summary-code", type: "string", required: false },
      ],
      retry: { maxAttempts: 2, retryOn: ["error"] },
    },
  }],
});

describe("M5A metric report authoring", () => {
  it("normalizes and validates a metric report definition", () => {
    const value = input();
    const normalized = normalizeDefinition(value);
    const check = normalized.nodes[0]?.check;
    expect(check?.kind).toBe("metric-report");
    if (!check || check.kind !== "metric-report") return;
    expect(check.parser).toEqual({ name: "metric-json", version: 1 });
    expect(check.mappings.map((mapping) => mapping.fact)).toEqual([
      "evaluation.valid",
      "evaluation.score",
      "evaluation.cases",
      "evaluation.summary-code",
    ]);
    expect(createWorkflow(normalized, at, "workflow-metric-definition").ok).toBe(true);
  });

  it("deep clones mappings, command arguments, and retry policy", () => {
    const value = input();
    const normalized = normalizeDefinition(value);
    const source = value.nodes[0]!.check;
    if (!source || source.kind !== "metric-report") throw new Error("Expected metric report input.");
    source.arguments![0] = "changed.mjs";
    source.mappings[0]!.fact = "evaluation.changed";
    source.retry!.retryOn[0] = "failed";

    const check = normalized.nodes[0]?.check;
    if (!check || check.kind !== "metric-report") throw new Error("Expected normalized metric report.");
    expect(check.arguments).toEqual(["evaluate.mjs"]);
    expect(check.mappings[0]?.fact).toBe("evaluation.valid");
    expect(check.retry?.retryOn).toEqual(["error"]);
  });

  it("rejects missing, mismatched, optional, and unmapped fact contracts", () => {
    const cases: Array<{ mutate: (value: HypagraphDefineInput) => void; code: string }> = [
      {
        mutate: (value) => {
          value.nodes[0]!.produces = value.nodes[0]!.produces!.filter((fact) => fact.name !== "evaluation.score");
        },
        code: "metric_fact_not_declared",
      },
      {
        mutate: (value) => {
          value.nodes[0]!.produces!.find((fact) => fact.name === "evaluation.score")!.type = "string";
        },
        code: "metric_fact_type_mismatch",
      },
      {
        mutate: (value) => {
          value.nodes[0]!.produces!.find((fact) => fact.name === "evaluation.score")!.required = false;
        },
        code: "metric_fact_must_be_required",
      },
      {
        mutate: (value) => {
          value.nodes[0]!.produces!.push({ name: "evaluation.phantom", type: "number" });
        },
        code: "metric_fact_not_mapped",
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const value = input();
      testCase.mutate(value);
      const result = createWorkflow(normalizeDefinition(value), at, `workflow-invalid-metric-${index}`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(testCase.code);
    }
  });

  it("rejects unsafe and duplicate scalar mappings", () => {
    const value = input();
    const check = value.nodes[0]!.check;
    if (!check || check.kind !== "metric-report") throw new Error("Expected metric report input.");
    check.mappings.push(
      { source: "__proto__.score", fact: "evaluation.unsafe", type: "number" },
      { source: "score", fact: "evaluation.duplicate-source", type: "number" },
      { source: "otherScore", fact: "evaluation.score", type: "number" },
    );
    value.nodes[0]!.produces!.push(
      { name: "evaluation.unsafe", type: "number", required: true },
      { name: "evaluation.duplicate-source", type: "number", required: true },
    );
    const result = createWorkflow(normalizeDefinition(value), at, "workflow-invalid-mappings");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
      expect(codes).toContain("invalid_metric_source_path");
      expect(codes).toContain("duplicate_metric_source");
      expect(codes).toContain("duplicate_metric_fact");
    }
  });
});
