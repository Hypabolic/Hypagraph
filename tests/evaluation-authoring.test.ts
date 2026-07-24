import { describe, expect, it } from "vitest";
import {
  assessEvaluationAuthoring,
  formatEvaluationAuthoringAdvisories,
} from "../src/domain/evaluation-authoring.js";
import type { HypagraphDefinition, MetricReportCheckDefinition } from "../src/domain/model.js";
import { createWorkflow } from "../src/domain/reducer.js";
import { renderWorkflow, workflowSummary } from "../src/ui/format.js";

const at = "2026-07-24T05:10:00.000Z";

const factEquals = (name: string, value: boolean) => ({
  kind: "compare" as const,
  left: { kind: "fact" as const, name },
  operator: "eq" as const,
  right: { kind: "literal" as const, value },
});

const metricCheck = (
  kind: "development" | "probe" | "holdout",
  mappings: MetricReportCheckDefinition["mappings"],
): MetricReportCheckDefinition => ({
  kind: "metric-report",
  command: "node",
  arguments: ["tools/evaluate.mjs"],
  timeoutMs: 30_000,
  reportPath: `${kind}.json`,
  parser: { name: "metric-json", version: 1 },
  mappings,
  evaluation: {
    kind,
    feedback: { mode: "aggregate" },
    integrity: {
      trustLevel: "transparent",
      evaluatorVersion: { value: `${kind}-1` },
    },
  },
});

const completeOptimization = (): HypagraphDefinition => ({
  title: "Optimize parser throughput",
  goal: "Improve parser throughput without breaking correctness",
  nodes: [
    {
      id: "improve",
      title: "Improve parser",
      requires: ["evaluate"],
      acceptance: ["Preserve parser behavior."],
      scope: { paths: ["src/parser/**", "tests/parser/**"] },
    },
    {
      id: "evaluate",
      title: "Run development evaluator",
      kind: "check",
      requires: ["improve"],
      acceptance: [],
      produces: [
        { name: "evaluation.valid", type: "boolean", required: true },
        { name: "evaluation.accepted", type: "boolean", required: true },
        { name: "evaluation.score", type: "number", required: true },
      ],
      check: metricCheck("development", [
        { source: "valid", fact: "evaluation.valid", type: "boolean" },
        { source: "accepted", fact: "evaluation.accepted", type: "boolean" },
        { source: "score", fact: "evaluation.score", type: "number" },
      ]),
    },
    {
      id: "probe",
      title: "Run generalization probe",
      kind: "check",
      requires: [],
      acceptance: [],
      produces: [{ name: "evaluation.probe-score", type: "number", required: true }],
      check: metricCheck("probe", [
        { source: "score", fact: "evaluation.probe-score", type: "number" },
      ]),
    },
  ],
  loops: [{
    id: "optimization",
    nodes: ["improve", "evaluate"],
    entry: "improve",
    evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "improve" }],
    successWhen: factEquals("evaluation.accepted", true),
    maxIterations: 8,
    progress: { fact: "evaluation.score", direction: "maximize", minDelta: 0.01 },
    patience: 3,
    evaluation: {
      validWhen: factEquals("evaluation.valid", true),
      maximumInvalidEvaluations: 2,
    },
    failurePolicy: "fail-workflow",
  }],
  evaluation: {
    budget: {
      maximumEvaluations: 12,
      maximumDevelopmentEvaluations: 8,
      maximumProbeEvaluations: 4,
    },
  },
  policy: { mode: "strict", requireEvidence: true },
});

const weakOptimization = (): HypagraphDefinition => {
  const definition = completeOptimization();
  definition.nodes = definition.nodes.filter((node) => node.id !== "probe");
  const evaluator = definition.nodes.find((node) => node.id === "evaluate")?.check;
  if (evaluator?.kind !== "metric-report" || !evaluator.evaluation) throw new Error("The evaluator is missing.");
  delete evaluator.evaluation.integrity;
  delete definition.loops[0]!.evaluation;
  delete definition.evaluation;
  return definition;
};

const nonMetricObjective = (): HypagraphDefinition => ({
  title: "Document architecture decision",
  goal: "Record the accepted architecture decision and verify the document exists",
  nodes: [
    {
      id: "write-decision",
      title: "Write the decision record",
      requires: [],
      acceptance: ["Record context, decision, consequences, and rejected alternatives."],
      scope: { paths: ["docs/adr/**"] },
    },
    {
      id: "verify-decision",
      title: "Verify the decision record",
      kind: "check",
      requires: ["write-decision"],
      acceptance: [],
      produces: [
        { name: "decision.success", type: "boolean", required: true },
        { name: "decision.kind", type: "string", required: true },
        { name: "decision.path", type: "string", required: true },
        { name: "decision.exists", type: "boolean", required: false },
        { name: "decision.size-bytes", type: "integer", required: false },
      ],
      check: {
        kind: "file-assertion",
        version: 1,
        namespace: "decision",
        assertion: { kind: "exists", path: "docs/adr/decision.md" },
      },
    },
  ],
  loops: [],
  policy: { mode: "strict", requireEvidence: true },
});

describe("M5A evaluation-contract authoring assessment", () => {
  it("accepts a complete development and probe optimization contract without advisories", () => {
    const definition = completeOptimization();
    const created = createWorkflow(definition, at, "workflow-authoring-complete");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));

    expect(assessEvaluationAuthoring(definition)).toEqual([]);
    expect(workflowSummary(created.state).evaluationAuthoringAdvisories).toEqual([]);
    expect(renderWorkflow(created.state)).not.toContain("Evaluation authoring advisories");
  });

  it("reports precise non-blocking advisories for a weak but valid optimization contract", () => {
    const definition = weakOptimization();
    const created = createWorkflow(definition, at, "workflow-authoring-weak");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));

    const advisories = assessEvaluationAuthoring(definition);
    expect(advisories.map((item) => item.code)).toEqual([
      "evaluation_budget_undeclared",
      "probe_evaluation_undeclared",
      "evaluation_validity_undeclared",
      "evaluation_trust_undeclared",
    ]);
    expect(formatEvaluationAuthoringAdvisories(advisories)).toContain("warning evaluation_budget_undeclared");
    expect(renderWorkflow(created.state)).toContain("Evaluation authoring advisories:");
    expect(renderWorkflow(created.state)).toContain("recommendation probe_evaluation_undeclared");
  });

  it("warns when holdout purpose has no isolated trust", () => {
    const definition = completeOptimization();
    definition.nodes = definition.nodes.filter((node) => node.id !== "probe");
    const evaluator = definition.nodes.find((node) => node.id === "evaluate")?.check;
    if (evaluator?.kind !== "metric-report" || !evaluator.evaluation) throw new Error("The evaluator is missing.");
    evaluator.evaluation.kind = "holdout";
    delete evaluator.evaluation.integrity;

    const advisories = assessEvaluationAuthoring(definition);
    expect(advisories.map((item) => item.code)).toContain("holdout_requires_isolated_authoring");
    expect(advisories.map((item) => item.code)).toContain("evaluation_trust_undeclared");
  });

  it("does not invent a metric or evaluation warning for a non-metric objective", () => {
    const definition = nonMetricObjective();
    const created = createWorkflow(definition, at, "workflow-authoring-non-metric");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));

    expect(assessEvaluationAuthoring(definition)).toEqual([]);
  });
});
