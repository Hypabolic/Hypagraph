import { describe, expect, it } from "vitest";
import {
  evaluationResultClaim,
  evaluationResultClaimLabel,
  shortEvaluatorFingerprint,
} from "../src/domain/evaluation-presentation.js";
import type { CheckResult, HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow } from "../src/domain/reducer.js";
import { formatPiCheckResult } from "../src/pi/check-runner.js";
import { loopSurfaceSummaries, renderLoopStatus } from "../src/ui/loop-surface.js";

const at = "2026-07-24T05:40:00.000Z";
const fingerprint = "0123456789abcdef".repeat(4);

const standaloneHoldout = (): HypagraphDefinition => ({
  title: "Holdout-purpose evaluation",
  goal: "Show the evaluation purpose without overstating trust",
  nodes: [{
    id: "evaluate",
    title: "Evaluate final candidate",
    kind: "check",
    requires: [],
    acceptance: [],
    produces: [{ name: "evaluation.score", type: "number", required: true }],
    check: {
      kind: "metric-report",
      command: "evaluator",
      timeoutMs: 30_000,
      reportPath: "metric.json",
      parser: { name: "metric-json", version: 1 },
      mappings: [{ source: "score", fact: "evaluation.score", type: "number" }],
      evaluation: {
        kind: "holdout",
        feedback: { mode: "aggregate" },
      },
    },
  }],
  loops: [],
  evaluation: { budget: { maximumEvaluations: 1, maximumHoldoutEvaluations: 1 } },
  policy: { mode: "guided", requireEvidence: false },
});

const loopDefinition = (): HypagraphDefinition => ({
  title: "Evaluation surface loop",
  goal: "Expose compact evaluation state",
  nodes: [
    { id: "improve", title: "Improve", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate",
      kind: "check",
      requires: ["improve"],
      acceptance: [],
      produces: [
        { name: "evaluation.valid", type: "boolean", required: true },
        { name: "evaluation.accepted", type: "boolean", required: true },
        { name: "evaluation.score", type: "number", required: true },
      ],
      check: {
        kind: "metric-report",
        command: "evaluator",
        timeoutMs: 30_000,
        reportPath: "metric.json",
        parser: { name: "metric-json", version: 1 },
        mappings: [
          { source: "valid", fact: "evaluation.valid", type: "boolean" },
          { source: "accepted", fact: "evaluation.accepted", type: "boolean" },
          { source: "score", fact: "evaluation.score", type: "number" },
        ],
        evaluation: {
          kind: "development",
          feedback: { mode: "bounded-diagnostics", maximumDiagnosticItems: 3 },
          integrity: {
            trustLevel: "protected",
            protectedPaths: [{ path: "tools/evaluator.mjs", sha256: "a".repeat(64) }],
            evaluatorVersion: { value: "surface-1" },
          },
        },
      },
    },
  ],
  loops: [{
    id: "quality",
    nodes: ["improve", "evaluate"],
    entry: "improve",
    evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "improve" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "evaluation.accepted" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 4,
    progress: { fact: "evaluation.score", direction: "maximize", minDelta: 0.1 },
    patience: 2,
    evaluation: {
      validWhen: {
        kind: "compare",
        left: { kind: "fact", name: "evaluation.valid" },
        operator: "eq",
        right: { kind: "literal", value: true },
      },
      maximumInvalidEvaluations: 2,
    },
  }],
  evaluation: { budget: { maximumEvaluations: 4, maximumDevelopmentEvaluations: 4 } },
  policy: { mode: "guided", requireEvidence: false },
});

const integrityResult = (): CheckResult => ({
  checkKind: "metric-report",
  attemptId: "evaluation-1",
  startedAt: at,
  completedAt: "2026-07-24T05:40:01.000Z",
  status: "passed",
  facts: [],
  evidence: [{
    ref: "evaluator-adapter://local-command-report/1",
    kind: "note",
    summary: "Local evaluator adapter.",
    visibility: "protected",
  }],
  evaluation: {
    kind: "development",
    feedbackMode: "bounded-diagnostics",
    diagnostics: [],
    diagnosticsTruncated: false,
    integrity: {
      version: 1,
      trustLevel: "protected",
      status: "valid",
      evaluatorVersion: "surface-1",
      evaluatorFingerprint: fingerprint,
      diagnosticCodes: [],
      protectedEvidence: [{ kind: "protected-file-sha256", status: "verified" }],
    },
  },
});

describe("M5A evaluation product surface", () => {
  it("keeps evaluation purpose separate from the trust claim", () => {
    expect(evaluationResultClaim("holdout", undefined)).toBe("holdout-purpose-only");
    expect(evaluationResultClaimLabel("holdout-purpose-only")).toBe("holdout purpose only; trusted holdout unavailable");
    expect(evaluationResultClaim("holdout", "protected")).toBe("holdout-purpose-only");
    expect(evaluationResultClaim("holdout", "isolated")).toBe("trusted-holdout");
    expect(evaluationResultClaim("development", "protected")).toBe("development-score");
  });

  it("uses compact fingerprints in normal output", () => {
    expect(shortEvaluatorFingerprint(fingerprint)).toBe("0123456789ab…");
    expect(shortEvaluatorFingerprint(undefined)).toBe("pending");
  });

  it("labels a standalone non-isolated holdout accurately in Pi", () => {
    const created = createWorkflow(standaloneHoldout(), at, "workflow-holdout-surface");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const result: CheckResult = {
      checkKind: "metric-report",
      attemptId: "evaluation-1",
      startedAt: at,
      completedAt: "2026-07-24T05:40:01.000Z",
      status: "passed",
      facts: [],
      evidence: [{ ref: "evaluator-adapter://local-command-report/1", kind: "note", summary: "Local adapter." }],
      evaluation: {
        kind: "holdout",
        feedbackMode: "aggregate",
        diagnostics: [],
        diagnosticsTruncated: false,
      },
    };

    const text = formatPiCheckResult(created.state, "evaluate", result);
    expect(text).toContain("Evaluation purpose: holdout");
    expect(text).toContain("Result claim: holdout purpose only; trusted holdout unavailable");
    expect(text).toContain("Evaluator trust: undeclared");
    expect(text).toContain("Evaluator adapter: local-command-report v1");
    expect(text).not.toContain("trusted isolated holdout");
  });

  it("renders compact loop evaluation details while preserving structured full identity", () => {
    const created = createWorkflow(loopDefinition(), at, "workflow-loop-surface");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const state = structuredClone(created.state);
    const integrity = integrityResult().evaluation?.integrity;
    if (!integrity) throw new Error("The integrity fixture is missing.");
    state.runtime.loops.quality!.evaluatorIntegrity = integrity;

    const summary = loopSurfaceSummaries(state)[0]!;
    expect(summary.evaluator).toMatchObject({
      purpose: "development",
      feedbackMode: "bounded-diagnostics",
      resultClaim: "development-score",
      trustLevel: "protected",
      evaluatorFingerprint: fingerprint,
    });

    const text = renderLoopStatus(state);
    expect(text).toContain("\n  evaluator purpose development");
    expect(text).toContain("claim development score");
    expect(text).toContain("feedback bounded-diagnostics");
    expect(text).toContain("fingerprint 0123456789ab…");
    expect(text).toContain("protected evidence 1/1");
    expect(text).not.toContain(fingerprint);
  });

  it("shows adapter identity and compact integrity details in check results", () => {
    const created = createWorkflow(loopDefinition(), at, "workflow-check-surface");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const text = formatPiCheckResult(created.state, "evaluate", integrityResult());

    expect(text).toContain("Result claim: development score");
    expect(text).toContain("Feedback mode: bounded-diagnostics");
    expect(text).toContain("Evaluator adapter: local-command-report v1");
    expect(text).toContain("Evaluator fingerprint: 0123456789ab…");
    expect(text).not.toContain(fingerprint);
  });
});
