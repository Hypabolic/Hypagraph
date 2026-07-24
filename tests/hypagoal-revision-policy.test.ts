import { describe, expect, it } from "vitest";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { validateAutomaticRevision } from "../src/domain/goal-revision-policy.js";

const condition = {
  kind: "compare" as const,
  left: { kind: "literal" as const, value: true },
  operator: "eq" as const,
  right: { kind: "literal" as const, value: true },
};

const definition = (): HypagraphDefinition => ({
  title: "Protected revision contract",
  goal: "Preserve every declared safeguard while completing the repository work.",
  nodes: [
    {
      id: "prepare",
      title: "Prepare",
      requires: [],
      acceptance: ["The repository input remains valid."],
      produces: [{ name: "prepare.done", type: "boolean", required: true }],
      scope: { paths: ["src/**"] },
    },
    {
      id: "choose",
      title: "Choose",
      kind: "gate",
      requires: ["prepare"],
      acceptance: [],
      gate: { condition, onTrue: ["evaluate"], onFalse: ["alternate"] },
    },
    {
      id: "evaluate",
      title: "Evaluate",
      kind: "check",
      requires: ["choose"],
      acceptance: ["The protected evaluator passes."],
      check: {
        kind: "metric-report",
        command: "node",
        arguments: ["scripts/evaluate.mjs"],
        timeoutMs: 1_000,
        reportPath: ".hypagraph/evaluation.json",
        parser: { name: "metric-json", version: 1 },
        mappings: [{ source: "score", fact: "quality.score", type: "number", required: true }],
        evaluation: {
          kind: "development",
          feedback: { mode: "aggregate" },
          integrity: {
            trustLevel: "protected",
            protectedPaths: [{ path: "scripts/evaluate.mjs", sha256: "a".repeat(64) }],
          },
        },
      },
    },
    { id: "alternate", title: "Alternate", requires: ["choose"], acceptance: ["The alternate path remains valid."] },
    { id: "refine", title: "Refine", requires: ["loop-evaluate"], acceptance: [] },
    {
      id: "loop-evaluate",
      title: "Loop evaluation",
      requires: ["refine"],
      acceptance: [],
      produces: [
        { name: "loop.done", type: "boolean", required: true },
        { name: "loop.score", type: "number", required: true },
      ],
    },
  ],
  loops: [{
    id: "quality-loop",
    nodes: ["refine", "loop-evaluate"],
    entry: "refine",
    evaluateAfter: "loop-evaluate",
    feedbackEdges: [{ from: "loop-evaluate", to: "refine" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "loop.done" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 3,
    progress: { fact: "loop.score", direction: "maximize", minDelta: 0.1 },
    patience: 2,
    evaluation: { validWhen: condition, maximumInvalidEvaluations: 2 },
    failurePolicy: "block-dependants",
  }],
  evaluation: {
    budget: {
      maximumEvaluations: 5,
      maximumDevelopmentEvaluations: 4,
      maximumProbeEvaluations: 2,
      maximumHoldoutEvaluations: 1,
    },
  },
  policy: { mode: "strict", requireEvidence: true },
});

const codesFor = (mutate: (proposal: HypagraphDefinition) => void): string[] => {
  const previous = definition();
  const proposal = structuredClone(previous);
  mutate(proposal);
  return validateAutomaticRevision(previous, proposal).map((item) => item.code);
};

describe("automatic revision non-weakening policy", () => {
  it.each([
    ["typed success", (value: HypagraphDefinition) => { value.loops[0]!.successWhen = condition; }, "automatic_revision_typed_success_changed"],
    ["loop failure policy", (value: HypagraphDefinition) => { value.loops[0]!.failurePolicy = "record-and-continue"; }, "automatic_revision_failure_policy_changed"],
    ["iteration limit", (value: HypagraphDefinition) => { value.loops[0]!.maxIterations = 4; }, "automatic_revision_iteration_limit_raised"],
    ["patience limit", (value: HypagraphDefinition) => { value.loops[0]!.patience = 3; }, "automatic_revision_patience_limit_raised"],
    ["invalid-evaluation limit", (value: HypagraphDefinition) => { value.loops[0]!.evaluation!.maximumInvalidEvaluations = 3; }, "automatic_revision_invalid_limit_raised"],
    ["progress contract", (value: HypagraphDefinition) => { value.loops[0]!.progress!.minDelta = 0; }, "automatic_revision_progress_changed"],
    ["validity contract", (value: HypagraphDefinition) => { value.loops[0]!.evaluation!.validWhen = { ...condition, operator: "neq" }; }, "automatic_revision_validity_changed"],
    ["evaluation budget", (value: HypagraphDefinition) => { value.evaluation!.budget.maximumEvaluations = 6; }, "automatic_revision_evaluation_budget_raised"],
    ["required check", (value: HypagraphDefinition) => { delete value.nodes.find((node) => node.id === "evaluate")!.check; }, "automatic_revision_check_changed"],
    ["evaluator trust", (value: HypagraphDefinition) => { const check = value.nodes.find((node) => node.id === "evaluate")!.check!; if (check.kind === "metric-report" && check.evaluation?.integrity) check.evaluation.integrity.trustLevel = "transparent"; }, "automatic_revision_check_changed"],
    ["required gate", (value: HypagraphDefinition) => { delete value.nodes.find((node) => node.id === "choose")!.gate; }, "automatic_revision_gate_changed"],
    ["acceptance requirement", (value: HypagraphDefinition) => { value.nodes.find((node) => node.id === "prepare")!.acceptance = []; }, "automatic_revision_acceptance_removed"],
    ["fact contract", (value: HypagraphDefinition) => { value.nodes.find((node) => node.id === "prepare")!.produces = []; }, "automatic_revision_fact_contract_removed"],
    ["required dependency", (value: HypagraphDefinition) => { value.nodes.find((node) => node.id === "choose")!.requires = []; }, "automatic_revision_required_dependency_removed"],
    ["repository scope", (value: HypagraphDefinition) => { value.nodes.find((node) => node.id === "prepare")!.scope = { paths: ["src/**", "tests/**"] }; }, "automatic_revision_scope_weakened"],
  ] as const)("rejects weakened %s", (_label, mutate, code) => {
    expect(codesFor(mutate)).toContain(code);
  });

  it("rejects a new route which can make existing required work optional", () => {
    const codes = codesFor((value) => {
      value.nodes.push({
        id: "bypass",
        title: "Bypass",
        kind: "gate",
        requires: [],
        acceptance: [],
        gate: { condition, onTrue: ["alternate"], onFalse: ["evaluate"] },
      });
    });
    expect(codes).toContain("automatic_revision_existing_work_rerouted");
  });

  it("accepts an additive bounded repository step without changing safeguards", () => {
    const previous = definition();
    const proposal = structuredClone(previous);
    proposal.nodes.push({
      id: "normalize-input",
      title: "Normalize input",
      requires: [],
      acceptance: ["The input is normalized without changing protected evaluation."],
      scope: { paths: ["src/**"] },
    });
    proposal.nodes.find((node) => node.id === "prepare")!.requires.push("normalize-input");

    expect(validateAutomaticRevision(previous, proposal)).toEqual([]);
  });
});
