import { describe, expect, it } from "vitest";
import type { CheckResult, HypagraphDefinition } from "../src/domain/model.js";
import type { GoalRunnableContinuation } from "../src/domain/goal-continuation.js";
import { createWorkflow } from "../src/domain/reducer.js";
import { buildGoalContinuationPrompt, continuationSystemPrompt } from "../src/pi/hypagoal-continuation.js";
import {
  projectGoalLoopContinuationGuidance,
  renderGoalLoopContinuationGuidance,
} from "../src/pi/hypagoal-loop-guidance.js";
import { projectModelVisibleGraphView, projectModelVisibleWorkflowSummary } from "../src/pi/model-visible-state.js";
import { formatPiCheckCommand, formatPiCheckResult } from "../src/pi/check-runner.js";

const at = "2026-07-24T11:00:00.000Z";
const fingerprint = "0123456789abcdef".repeat(4);
const protectedHash = "f".repeat(64);

const definition = (): HypagraphDefinition => ({
  title: "Protected optimization",
  goal: "Improve one candidate without exposing the protected evaluator",
  nodes: [
    { id: "refine", title: "Refine the candidate", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate the candidate",
      kind: "check",
      requires: ["refine"],
      acceptance: [],
      produces: [
        { name: "evaluation.valid", type: "boolean", required: true },
        { name: "evaluation.accepted", type: "boolean", required: true },
        { name: "evaluation.score", type: "number", required: true },
      ],
      check: {
        kind: "metric-report",
        command: "node",
        arguments: ["tools/private-evaluator.mjs", "--holdout-secret"],
        timeoutMs: 30_000,
        reportPath: ".private/evaluation.json",
        parser: { name: "metric-json", version: 1 },
        mappings: [
          { source: "valid", fact: "evaluation.valid", type: "boolean" },
          { source: "accepted", fact: "evaluation.accepted", type: "boolean" },
          { source: "score", fact: "evaluation.score", type: "number" },
        ],
        evaluation: {
          kind: "development",
          feedback: { mode: "bounded-diagnostics", maximumDiagnosticItems: 2 },
          integrity: {
            trustLevel: "protected",
            protectedPaths: [{ path: "tools/private-evaluator.mjs", sha256: protectedHash }],
            evaluatorVersion: { value: "private-v3" },
          },
        },
      },
    },
  ],
  loops: [{
    id: "quality",
    nodes: ["refine", "evaluate"],
    entry: "refine",
    evaluateAfter: "evaluate",
    feedbackEdges: [{ from: "evaluate", to: "refine" }],
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
    failurePolicy: "record-and-continue",
  }],
  evaluation: { budget: { maximumEvaluations: 5, maximumDevelopmentEvaluations: 4 } },
  policy: { mode: "guided", requireEvidence: false },
});

const fixture = () => {
  const created = createWorkflow(definition(), at, "workflow-loop-guidance");
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  const state = structuredClone(created.state);
  const runtime = state.runtime.loops.quality!;
  runtime.currentIteration = 2;
  runtime.currentMetric = 0.65;
  runtime.bestMetric = 0.8;
  runtime.bestIteration = 1;
  runtime.noProgressCount = 1;
  runtime.invalidEvaluationCount = 1;
  runtime.lastValid = false;
  runtime.lastSuccess = false;
  runtime.evaluatorIntegrity = {
    version: 1,
    trustLevel: "protected",
    status: "valid",
    evaluatorVersion: "private-v3",
    evaluatorFingerprint: fingerprint,
    diagnosticCodes: [],
    protectedEvidence: [{ kind: "protected-file-sha256", status: "verified" }],
  };
  state.runtime.evaluations = { total: 2, development: 2, probe: 0, holdout: 0, lastKind: "development", lastNodeId: "evaluate", lastAttemptId: "evaluation-2" };
  state.runtime.nodes.refine!.status = "succeeded";
  state.runtime.nodes.evaluate!.status = "ready";
  const action: GoalRunnableContinuation = {
    goalId: "goal-loop-guidance",
    workflowId: state.workflowId,
    revision: state.revision,
    sequence: state.sequence,
    snapshotHash: state.snapshotHash,
    continuationOrdinal: 2,
    kind: "run-ready-check",
    nodeId: "evaluate",
    loopId: "quality",
  };
  return { state, action };
};

describe("M5B Slice 5 loop continuation guidance", () => {
  it("projects current progress, best progress, validity, patience, evaluation budget, and trust separately", () => {
    const { state, action } = fixture();
    expect(projectGoalLoopContinuationGuidance(state, action)).toEqual(expect.objectContaining({
      loopId: "quality",
      iteration: 2,
      maximumIterations: 4,
      lastValid: false,
      lastSuccess: false,
      progress: expect.objectContaining({
        direction: "maximize",
        currentMetric: 0.65,
        bestMetric: 0.8,
        bestIteration: 1,
        noProgressCount: 1,
        patience: 2,
      }),
      validity: { invalidEvaluationCount: 1, maximumInvalidEvaluations: 2 },
      evaluation: expect.objectContaining({
        purpose: "development",
        feedbackMode: "bounded-diagnostics",
        trustLevel: "protected",
        isolation: "not-isolated",
        resultClaim: "development score",
        count: 2,
        maximum: 4,
        totalCount: 2,
        totalMaximum: 5,
        evaluatorVersion: "private-v3",
        evaluatorFingerprint: "0123456789ab…",
      }),
      failurePolicy: "record-and-continue",
    }));
  });

  it("renders canonical loop guidance without protected evaluator details", () => {
    const { state, action } = fixture();
    const text = renderGoalLoopContinuationGuidance(state, action).join("\n");
    expect(text).toContain("iteration 2 of 4");
    expect(text).toContain("Current accepted metric: 0.65");
    expect(text).toContain("Best accepted metric: 0.8 at iteration 1");
    expect(text).toContain("Invalid evaluations: 1 of 2");
    expect(text).toContain("Evaluation attempts: 2 of 4; total 2 of 5");
    expect(text).toContain("fingerprint 0123456789ab…");
    expect(text).not.toContain(fingerprint);
    expect(text).not.toContain("tools/private-evaluator.mjs");
    expect(text).not.toContain(protectedHash);
    expect(text).not.toContain(".private/evaluation.json");
    expect(text).not.toContain("--holdout-secret");
  });

  it("adds loop identity to both the queued prompt and the delivered system prompt", () => {
    const { state, action } = fixture();
    const prompt = buildGoalContinuationPrompt(action, state, "continue-quality-2");
    expect(prompt).toContain("Loop iteration: 2/4");
    expect(prompt).toContain("Evaluation purpose: development");
    const system = continuationSystemPrompt({
      operationId: "continue-quality-2",
      turnId: "turn-quality-2",
      action,
      requestedOrdinal: 3,
      requestSequence: state.sequence,
      selectedSequence: state.sequence,
      selectedSnapshotHash: state.snapshotHash,
      committedSequence: state.sequence,
      committedSnapshotHash: state.snapshotHash,
      sessionGeneration: 0,
      branchGeneration: 0,
      prompt,
    }, state);
    expect(system).toContain("Typed success condition");
    expect(system).toContain("Evaluation validity, numeric progress, and typed success are separate");
    expect(system).toContain("Independent runnable components remain eligible");
    expect(system).not.toContain("tools/private-evaluator.mjs");
  });

  it("redacts full evaluator fingerprints from model-visible state output", () => {
    const { state } = fixture();
    const view = projectModelVisibleGraphView(state);
    expect(view.loops[0]?.evaluator?.evaluatorFingerprint).toBe("0123456789ab…");
    expect(JSON.stringify(view)).not.toContain(fingerprint);
    const summary = projectModelVisibleWorkflowSummary(state);
    expect(JSON.stringify(summary)).toContain("0123456789ab…");
    expect(JSON.stringify(summary)).not.toContain(fingerprint);
  });

  it("redacts the protected evaluator command before check execution", () => {
    const { state } = fixture();
    const check = state.definition.nodes.find((node) => node.id === "evaluate")?.check;
    if (!check) throw new Error("The check fixture is missing.");
    expect(formatPiCheckCommand(check)).toBe("protected evaluator command");
  });

  it("redacts protected process output references in normal check output", () => {
    const { state } = fixture();
    const evaluatorIntegrity = state.runtime.loops.quality!.evaluatorIntegrity;
    if (!evaluatorIntegrity) throw new Error("The evaluator integrity fixture is missing.");
    const result: CheckResult = {
      checkKind: "metric-report",
      attemptId: "evaluation-2",
      startedAt: at,
      completedAt: "2026-07-24T11:00:01.000Z",
      status: "passed",
      facts: [],
      evidence: [],
      stdoutRef: ".hypagraph/check-artifacts/private-stdout.txt",
      stderrRef: ".hypagraph/check-artifacts/private-stderr.txt",
      evaluation: {
        kind: "development",
        feedbackMode: "bounded-diagnostics",
        diagnostics: [],
        diagnosticsTruncated: false,
        integrity: evaluatorIntegrity,
      },
    };
    const text = formatPiCheckResult(state, "evaluate", result);
    expect(text).toContain("Stdout: protected");
    expect(text).toContain("Stderr: protected");
    expect(text).not.toContain("private-stdout.txt");
    expect(text).not.toContain("private-stderr.txt");
  });
});
