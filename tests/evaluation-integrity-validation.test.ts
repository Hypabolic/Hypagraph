import { describe, expect, it } from "vitest";
import type { HypagraphDefinition, MetricReportCheckDefinition } from "../src/domain/model.js";
import { createWorkflow } from "../src/domain/reducer.js";
import { validateDefinition } from "../src/domain/validate.js";
import { projectGraphView } from "../src/graph/projection.js";
import { normalizeDefinition, type HypagraphDefineInput } from "../src/pi/definition.js";

const at = "2026-07-24T01:00:00.000Z";
const hash = "a".repeat(64);
const revision = "b".repeat(40);

const definition = (): HypagraphDefinition => ({
  title: "Evaluator integrity",
  goal: "Accept scores from an unchanged evaluator",
  nodes: [{
    id: "evaluate",
    title: "Evaluate",
    kind: "check",
    requires: [],
    acceptance: [],
    produces: [
      { name: "evaluation.score", type: "number", required: true },
      { name: "evaluation.version", type: "string", required: true },
    ],
    check: {
      kind: "metric-report",
      command: "evaluator",
      timeoutMs: 30_000,
      reportPath: "metric.json",
      parser: { name: "metric-json", version: 1 },
      mappings: [{ source: "score", fact: "evaluation.score", type: "number" }],
      evaluation: {
        kind: "development",
        feedback: { mode: "aggregate" },
        integrity: {
          trustLevel: "protected",
          protectedPaths: [{ path: "tools/evaluate.mjs", sha256: hash, maxBytes: 4_096 }],
          git: {
            expectedRevision: revision,
            requireCleanWorktree: true,
            protectedPathsUnchangedFrom: revision,
          },
          evaluatorVersion: { value: "evaluator-1", fact: "evaluation.version" },
        },
      },
    },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const check = (value: HypagraphDefinition): MetricReportCheckDefinition => {
  const candidate = value.nodes[0]?.check;
  if (candidate?.kind !== "metric-report") throw new Error("The metric report check is missing.");
  return candidate;
};

describe("M5A evaluator integrity validation", () => {
  it("keeps evaluation purpose separate from protected trust", () => {
    const value = definition();
    expect(validateDefinition(value)).toEqual([]);
    expect(check(value).evaluation).toMatchObject({
      kind: "development",
      integrity: { trustLevel: "protected" },
    });
    expect(createWorkflow(value, at, "workflow-integrity-validation").ok).toBe(true);
  });

  it("rejects invalid and duplicate protected paths, hashes, and limits", () => {
    const cases: Array<{ mutate: (paths: NonNullable<NonNullable<MetricReportCheckDefinition["evaluation"]>["integrity"]>["protectedPaths"]) => void; code: string }> = [
      { mutate: (paths) => { paths![0]!.path = ""; }, code: "invalid_protected_path" },
      { mutate: (paths) => { paths![0]!.path = "../evaluate.mjs"; }, code: "invalid_protected_path" },
      { mutate: (paths) => { paths![0]!.path = "/evaluate.mjs"; }, code: "invalid_protected_path" },
      { mutate: (paths) => { paths![0]!.path = "C:evaluate.mjs"; }, code: "invalid_protected_path" },
      { mutate: (paths) => { paths![0]!.sha256 = "not-a-hash"; }, code: "invalid_protected_path_hash" },
      { mutate: (paths) => { paths![0]!.maxBytes = 0; }, code: "invalid_protected_path_limit" },
      { mutate: (paths) => { paths!.push({ path: "tools\\evaluate.mjs", sha256: hash }); }, code: "duplicate_protected_path" },
    ];

    for (const testCase of cases) {
      const value = definition();
      const paths = check(value).evaluation!.integrity!.protectedPaths;
      testCase.mutate(paths);
      expect(validateDefinition(value).map((item) => item.code)).toContain(testCase.code);
    }
  });

  it("rejects inaccurate trust and incompatible holdout claims", () => {
    const protectedWithoutInstrument = definition();
    const protectedIntegrity = check(protectedWithoutInstrument).evaluation!.integrity!;
    delete protectedIntegrity.protectedPaths;
    delete protectedIntegrity.git;
    expect(validateDefinition(protectedWithoutInstrument).map((item) => item.code)).toContain("protected_integrity_instrument_required");

    const isolated = definition();
    check(isolated).evaluation!.integrity!.trustLevel = "isolated";
    expect(validateDefinition(isolated).map((item) => item.code)).toContain("isolated_evaluator_unavailable");

    const holdout = definition();
    check(holdout).evaluation!.kind = "holdout";
    expect(validateDefinition(holdout).map((item) => item.code)).toContain("holdout_requires_isolated_trust");

    const publicReport = definition();
    check(publicReport).evaluation!.feedback.exposeRawReport = true;
    expect(validateDefinition(publicReport).map((item) => item.code)).toContain("protected_raw_report_not_allowed");
  });

  it("rejects invalid Git declarations and missing version fact contracts", () => {
    const emptyGit = definition();
    check(emptyGit).evaluation!.integrity!.git = {};
    expect(validateDefinition(emptyGit).map((item) => item.code)).toContain("git_integrity_constraint_required");

    const invalidRevision = definition();
    check(invalidRevision).evaluation!.integrity!.git!.expectedRevision = "abc";
    expect(validateDefinition(invalidRevision).map((item) => item.code)).toContain("invalid_integrity_git_revision");

    const noPaths = definition();
    delete check(noPaths).evaluation!.integrity!.protectedPaths;
    expect(validateDefinition(noPaths).map((item) => item.code)).toContain("git_protected_paths_required");

    const noContract = definition();
    noContract.nodes[0]!.produces = noContract.nodes[0]!.produces!.filter((item) => item.name !== "evaluation.version");
    expect(validateDefinition(noContract).map((item) => item.code)).toContain("evaluator_version_fact_not_declared");
  });

  it("supports transparent declared identity and preserves definitions without integrity", () => {
    const transparent = definition();
    check(transparent).evaluation!.integrity = {
      trustLevel: "transparent",
      evaluatorVersion: { value: "local-1", fact: "evaluation.version" },
    };
    expect(validateDefinition(transparent)).toEqual([]);
    const created = createWorkflow(transparent, at, "workflow-transparent-integrity");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    expect(projectGraphView(created.state).nodes[0]?.evaluator).toMatchObject({
      purpose: "development",
      trustLevel: "transparent",
      integrityStatus: "pending",
    });

    const compatible = definition();
    delete check(compatible).evaluation!.integrity;
    check(compatible).evaluation!.kind = "holdout";
    compatible.nodes[0]!.produces = compatible.nodes[0]!.produces!.filter((item) => item.name !== "evaluation.version");
    expect(validateDefinition(compatible)).toEqual([]);

    const noEvaluationContract = definition();
    delete check(noEvaluationContract).evaluation;
    noEvaluationContract.nodes[0]!.produces = noEvaluationContract.nodes[0]!.produces!.filter((item) => item.name !== "evaluation.version");
    expect(validateDefinition(noEvaluationContract)).toEqual([]);
  });

  it("normalizes protected path separators and hashes in Pi input", () => {
    const input = definition() as HypagraphDefineInput;
    const metric = input.nodes[0]!.check;
    if (metric?.kind !== "metric-report" || !metric.evaluation?.integrity?.protectedPaths) throw new Error("The Pi integrity definition is missing.");
    metric.evaluation.integrity.protectedPaths[0]!.path = "tools\\evaluate.mjs";
    metric.evaluation.integrity.protectedPaths[0]!.sha256 = hash.toUpperCase();

    const normalized = normalizeDefinition(input);
    const normalizedCheck = check(normalized);
    expect(normalizedCheck.evaluation?.integrity?.protectedPaths).toEqual([
      { path: "tools/evaluate.mjs", sha256: hash, maxBytes: 4_096 },
    ]);
  });
});
