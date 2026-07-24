import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import { runAutomaticCheckLifecycle } from "../src/checks/lifecycle.js";
import { ReportCheckExecutor } from "../src/checks/report-check-executor.js";
import type { CheckExecutor, CheckResult, DomainEvent, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow, handleCommand } from "../src/domain/reducer.js";
import { projectGraphView } from "../src/graph/projection.js";
import { restoreLatestSession } from "../src/persistence/session-rebuild.js";
import { formatPiCheckResult } from "../src/pi/check-runner.js";
import { loopSurfaceSummaries, renderLoopStatus } from "../src/ui/loop-surface.js";

const roots: string[] = [];
const at = "2026-07-24T01:20:00.000Z";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const workspace = async (): Promise<string> => {
  const root = await mkdtemp(join(process.cwd(), ".hypagraph-integrity-loop-"));
  roots.push(root);
  await mkdir(join(root, "protected"));
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const definition = (expectedHash: string, maximumInvalidEvaluations = 2): HypagraphDefinition => ({
  title: "Integrity progress loop",
  goal: "Keep untrusted scores out of progress state",
  nodes: [
    { id: "improve", title: "Improve", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate",
      kind: "check",
      requires: ["improve"],
      acceptance: [],
      produces: [
        { name: "evaluation.report-valid", type: "boolean", required: true },
        { name: "evaluation.accepted", type: "boolean", required: true },
        { name: "evaluation.score", type: "number", required: true },
        { name: "evaluation.version", type: "string", required: true },
      ],
      check: {
        kind: "metric-report",
        command: "protected-evaluator",
        arguments: ["--hidden-case", "private-case-7"],
        timeoutMs: 30_000,
        reportPath: "metric.json",
        parser: { name: "metric-json", version: 1 },
        mappings: [
          { source: "valid", fact: "evaluation.report-valid", type: "boolean" },
          { source: "accepted", fact: "evaluation.accepted", type: "boolean" },
          { source: "score", fact: "evaluation.score", type: "number" },
        ],
        evaluation: {
          kind: "development",
          feedback: { mode: "aggregate" },
          integrity: {
            trustLevel: "protected",
            protectedPaths: [{ path: "protected/evaluator.mjs", sha256: expectedHash, maxBytes: 4_096 }],
            evaluatorVersion: { value: "evaluator-3", fact: "evaluation.version" },
          },
        },
      },
    },
  ],
  loops: [{
    id: "quality-loop",
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
    maxIterations: 6,
    progress: { fact: "evaluation.score", direction: "maximize", minDelta: 1 },
    patience: 2,
    evaluation: {
      validWhen: {
        kind: "compare",
        left: { kind: "fact", name: "evaluation.report-valid" },
        operator: "eq",
        right: { kind: "literal", value: true },
      },
      maximumInvalidEvaluations,
    },
  }],
  evaluation: { budget: { maximumEvaluations: 6, maximumDevelopmentEvaluations: 6 } },
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const completeWork = (state: HypagraphState, events: DomainEvent[], iteration: number): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId: "improve", attemptId: `improve-${iteration}`, commandId: `improve-${iteration}-start`, at });
  next = apply(next, events, { type: "submit-result", nodeId: "improve", attemptId: `improve-${iteration}`, evidence: [], commandId: `improve-${iteration}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId: "improve", attemptId: `improve-${iteration}`, commandId: `improve-${iteration}-begin`, at });
  return apply(next, events, { type: "complete-verification", nodeId: "improve", attemptId: `improve-${iteration}`, passed: true, commandId: `improve-${iteration}-complete`, at });
};

const producer = () => {
  const execute = vi.fn(async (request): Promise<CheckResult> => ({
    checkKind: "command",
    attemptId: request.attemptId,
    startedAt: request.requestedAt,
    completedAt: "2026-07-24T01:20:01.000Z",
    status: "passed",
    exitCode: 0,
    facts: [],
    evidence: [{ ref: "memory://protected-output", kind: "file", summary: "Protected output." }],
    stdoutRef: "memory://protected-output",
  }));
  return { execute, executor: { execute } satisfies CheckExecutor };
};

describe("M5A evaluator integrity loop enforcement", () => {
  it("consumes budget but protects completion, best progress, and patience", async () => {
    const root = await workspace();
    const evaluatorSource = "export const evaluator = 3;\n";
    await writeFile(join(root, "protected", "evaluator.mjs"), evaluatorSource, "utf8");
    const created = createWorkflow(definition(hash(evaluatorSource)), at, "workflow-integrity-loop");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    const trackedProducer = producer();
    const executor = new ReportCheckExecutor({
      rootDirectory: root,
      artifactStore: new MemoryCheckArtifactStore(),
      producerExecutor: trackedProducer.executor,
      now: () => new Date("2026-07-24T01:20:02.000Z"),
    });
    let state = created.state;

    const evaluate = async (iteration: number, report: { valid: boolean; accepted: boolean; score: number }) => {
      state = completeWork(state, events, iteration);
      await writeFile(join(root, "metric.json"), JSON.stringify({ schemaVersion: 1, ...report, privateCase: "do-not-expose" }), "utf8");
      const result = await runAutomaticCheckLifecycle({
        state,
        executor,
        nodeId: "evaluate",
        attemptId: `evaluation-${iteration}`,
        requestedAt: at,
        signal: new AbortController().signal,
      });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      events.push(...result.events);
      state = result.state;
      return result.result;
    };

    await evaluate(1, { valid: true, accepted: false, score: 10 });
    expect(state.runtime.loops["quality-loop"]).toMatchObject({
      bestMetric: 10,
      bestIteration: 1,
      noProgressCount: 0,
    });

    await evaluate(2, { valid: true, accepted: false, score: 10 });
    expect(state.runtime.loops["quality-loop"]).toMatchObject({
      bestMetric: 10,
      bestIteration: 1,
      noProgressCount: 1,
    });

    await writeFile(join(root, "protected", "evaluator.mjs"), "export const evaluator = 999;\n", "utf8");
    const invalidResult = await evaluate(3, { valid: true, accepted: true, score: 999 });
    expect(invalidResult.evaluation?.integrity).toMatchObject({
      status: "invalid",
      diagnosticCodes: ["integrity_protected_file_hash_mismatch"],
    });
    expect(state.runtime.evaluations).toMatchObject({ total: 3, development: 3 });
    expect(state.runtime.loops["quality-loop"]).toMatchObject({
      status: "running",
      currentIteration: 4,
      lastValid: false,
      lastSuccess: false,
      currentMetric: 10,
      bestMetric: 10,
      bestIteration: 1,
      noProgressCount: 1,
      invalidEvaluationCount: 1,
      evaluatorIntegrity: { status: "invalid" },
    });
    expect(state.runtime.loops["quality-loop"]?.iterations[2]).toMatchObject({
      valid: false,
      success: false,
      metric: 999,
      noProgressCount: 1,
      evaluatorIntegrity: { status: "invalid" },
    });
    expect(state.runtime.loops["quality-loop"]?.iterations[2]?.improved).toBeUndefined();
    expect(state.runtime.nodes.evaluate?.attempts["evaluation-3"]?.status).toBe("failed");
    expect(state.runtime.nodes.evaluate?.attempts["evaluation-3"]?.checkResult?.evaluation?.integrity).toEqual(invalidResult.evaluation?.integrity);

    const graph = projectGraphView(state);
    expect(graph.loops[0]?.evaluator).toMatchObject({
      purpose: "development",
      trustLevel: "protected",
      evaluatorVersion: "evaluator-3",
      integrityStatus: "invalid",
      integrityDiagnosticCode: "integrity_protected_file_hash_mismatch",
      protectedEvidence: { verified: 0, invalid: 1, total: 1 },
    });
    expect(graph.nodes.find((node) => node.id === "evaluate")?.evaluator).toMatchObject({
      purpose: "development",
      trustLevel: "protected",
      integrityStatus: "invalid",
    });
    expect(loopSurfaceSummaries(state)[0]?.evaluator).toMatchObject({
      purpose: "development",
      trustLevel: "protected",
      integrityStatus: "invalid",
    });
    expect(renderLoopStatus(state)).toContain("integrity invalid");
    expect(renderLoopStatus(state)).toContain("protected evidence 0/1");

    const pi = formatPiCheckResult(state, "evaluate", invalidResult);
    expect(pi).toContain("Evaluation purpose: development");
    expect(pi).toContain("Evaluator trust: protected");
    expect(pi).toContain("Integrity diagnostic: integrity_protected_file_hash_mismatch");
    expect(pi).not.toContain("--hidden-case");
    expect(pi).not.toContain("private-case-7");
    expect(pi).not.toContain("protected/evaluator.mjs");
    expect(pi).not.toContain(hash(evaluatorSource));
    expect(pi).not.toContain("do-not-expose");

    expect(replayEvents(events)).toEqual(state);
    const callCount = trackedProducer.execute.mock.calls.length;
    const restored = restoreLatestSession([{
      type: "message",
      message: {
        role: "toolResult",
        toolName: "hypagraph_read",
        details: { hypagraph: { events, snapshot: state } },
      },
    }]);
    expect(restored?.snapshot).toEqual(state);
    expect(trackedProducer.execute).toHaveBeenCalledTimes(callCount);

    const unsupportedEvents = structuredClone(events);
    const recorded = unsupportedEvents.find((event) => event.type === "hypagraph.check.result-recorded");
    const recordedResult = recorded?.data.result as CheckResult | undefined;
    if (!recordedResult?.evaluation?.integrity) throw new Error("The stored integrity observation is missing.");
    (recordedResult.evaluation.integrity as { version: number }).version = 2;
    expect(() => replayEvents(unsupportedEvents)).toThrow("unsupported_evaluation_integrity_version");

    state = completeWork(state, events, 4);
    const started = handleCommand(state, { type: "start-check", nodeId: "evaluate", attemptId: "evaluation-4", commandId: "evaluation-4-start", at });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const stale = handleCommand(started.state, {
      type: "record-check-result",
      nodeId: "evaluate",
      attemptId: "evaluation-3",
      result: invalidResult,
      commandId: "stale-integrity-result",
      at,
    });
    expect(stale).toMatchObject({ ok: false, diagnostics: [{ code: "stale_check_attempt" }] });
  });

  it("counts integrity failure against the invalid-evaluation limit and replays the stop reason", async () => {
    const root = await workspace();
    const expectedSource = "export const evaluator = 1;\n";
    await writeFile(join(root, "protected", "evaluator.mjs"), "export const evaluator = 2;\n", "utf8");
    await writeFile(join(root, "metric.json"), JSON.stringify({ schemaVersion: 1, valid: true, accepted: true, score: 100 }), "utf8");
    const created = createWorkflow(definition(hash(expectedSource), 1), at, "workflow-integrity-invalid-limit");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    const state = completeWork(created.state, events, 1);
    const result = await runAutomaticCheckLifecycle({
      state,
      executor: new ReportCheckExecutor({
        rootDirectory: root,
        artifactStore: new MemoryCheckArtifactStore(),
        producerExecutor: producer().executor,
        now: () => new Date("2026-07-24T01:20:02.000Z"),
      }),
      nodeId: "evaluate",
      attemptId: "evaluation-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    events.push(...result.events);

    expect(result.state.phase).toBe("failed");
    expect(result.state.runtime.evaluations).toMatchObject({ total: 1, development: 1 });
    expect(result.state.runtime.loops["quality-loop"]).toMatchObject({
      status: "failed",
      exitReason: "invalid_evaluations",
      invalidEvaluationCount: 1,
    });
    expect(result.state.runtime.loops["quality-loop"]?.bestMetric).toBeUndefined();
    expect(result.state.runtime.loops["quality-loop"]?.bestIteration).toBeUndefined();
    expect(replayEvents(events)).toEqual(result.state);
  });
});
