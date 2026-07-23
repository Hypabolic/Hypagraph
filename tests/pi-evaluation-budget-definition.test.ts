import { describe, expect, it } from "vitest";
import { createWorkflow } from "../src/domain/reducer.js";
import { normalizeDefinition, type HypagraphDefineInput } from "../src/pi/definition.js";

const at = "2026-07-23T15:20:00.000Z";

const input = (): HypagraphDefineInput => ({
  title: "Evaluation budget authoring",
  goal: "Preserve evaluator feedback and budget settings",
  nodes: [{
    id: "evaluate",
    title: "Evaluate",
    kind: "check",
    requires: [],
    acceptance: [],
    produces: [{ name: "evaluation.score", type: "number", required: true }],
    check: {
      kind: "metric-report",
      command: "evaluator",
      timeoutMs: 30_000,
      reportPath: "metrics.json",
      parser: { name: "metric-json", version: 1 },
      mappings: [{ source: "score", fact: "evaluation.score", type: "number" }],
      evaluation: {
        kind: "probe",
        feedback: { mode: "bounded-diagnostics", maximumDiagnosticItems: 3 },
      },
    },
  }],
  loops: [],
  evaluation: {
    budget: {
      maximumEvaluations: 8,
      maximumDevelopmentEvaluations: 4,
      maximumProbeEvaluations: 3,
      maximumHoldoutEvaluations: 1,
    },
  },
  policy: { mode: "guided", requireEvidence: false },
});

describe("M5A evaluation budget authoring", () => {
  it("normalizes evaluator feedback and workflow budgets", () => {
    const source = input();
    const normalized = normalizeDefinition(source);
    expect(normalized.nodes[0]?.check).toMatchObject({
      kind: "metric-report",
      evaluation: { kind: "probe", feedback: { mode: "bounded-diagnostics", maximumDiagnosticItems: 3 } },
    });
    expect(normalized.evaluation?.budget).toEqual({
      maximumEvaluations: 8,
      maximumDevelopmentEvaluations: 4,
      maximumProbeEvaluations: 3,
      maximumHoldoutEvaluations: 1,
    });
    expect(createWorkflow(normalized, at, "workflow-evaluation-authoring").ok).toBe(true);
  });

  it("deep clones evaluator feedback and budget settings", () => {
    const source = input();
    const normalized = normalizeDefinition(source);
    const check = source.nodes[0]!.check;
    if (!check || check.kind !== "metric-report" || !check.evaluation) throw new Error("The metric evaluation is missing.");
    check.evaluation.kind = "development";
    source.evaluation!.budget.maximumEvaluations = 99;

    const normalizedCheck = normalized.nodes[0]?.check;
    if (!normalizedCheck || normalizedCheck.kind !== "metric-report") throw new Error("The normalized metric evaluation is missing.");
    expect(normalizedCheck.evaluation?.kind).toBe("probe");
    expect(normalized.evaluation?.budget.maximumEvaluations).toBe(8);
  });
});
