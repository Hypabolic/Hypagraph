import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import type {
  EvaluatorAdapter,
  EvaluatorAdapterRequest,
  EvaluatorAdapterResponse,
} from "../src/checks/evaluator-adapter.js";
import { runAutomaticCheckLifecycle } from "../src/checks/lifecycle.js";
import { ReportCheckExecutor } from "../src/checks/report-check-executor.js";
import type {
  CheckResult,
  DomainEvent,
  FactInput,
  HypagraphCommand,
  HypagraphDefinition,
  HypagraphState,
} from "../src/domain/model.js";
import { assessEvaluationAuthoring } from "../src/domain/evaluation-authoring.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";
import { restoreLatestSession } from "../src/persistence/session-rebuild.js";
import { formatPiCheckResult } from "../src/pi/check-runner.js";
import { renderLoopStatus } from "../src/ui/loop-surface.js";

const roots: string[] = [];
const at = "2026-07-24T06:00:00.000Z";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const workspace = async (name: string): Promise<string> => {
  const root = await mkdtemp(join(process.cwd(), `.hypagraph-${name}-`));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const apply = (
  state: HypagraphState,
  events: DomainEvent[],
  command: HypagraphCommand,
): HypagraphState => {
  const reduced = handleCommand(state, command);
  if (!reduced.ok) throw new Error(JSON.stringify(reduced.diagnostics));
  events.push(...reduced.events);
  return reduced.state;
};

const completeTask = (
  state: HypagraphState,
  events: DomainEvent[],
  nodeId: string,
  attemptId: string,
  facts: FactInput[] = [],
): HypagraphState => {
  let next = apply(state, events, { type: "start-node", nodeId, attemptId, commandId: `${attemptId}-start`, at });
  if (facts.length > 0) {
    next = apply(next, events, { type: "publish-facts", nodeId, attemptId, facts, commandId: `${attemptId}-facts`, at });
  }
  next = apply(next, events, { type: "submit-result", nodeId, attemptId, evidence: [], commandId: `${attemptId}-submit`, at });
  next = apply(next, events, { type: "begin-verification", nodeId, attemptId, commandId: `${attemptId}-verify`, at });
  return apply(next, events, { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${attemptId}-complete`, at });
};

const adapter = (
  report: (request: EvaluatorAdapterRequest) => Record<string, unknown>,
): EvaluatorAdapter => ({
  id: "dogfood-adapter",
  version: 1,
  async evaluate(request): Promise<EvaluatorAdapterResponse> {
    const trustLevel = request.definition.evaluation?.integrity?.trustLevel ?? "transparent";
    return {
      outcome: "report",
      producer: {
        checkKind: "command",
        attemptId: request.attemptId,
        startedAt: request.requestedAt,
        completedAt: "2026-07-24T06:00:01.000Z",
        status: "passed",
        exitCode: 0,
        facts: [],
        evidence: [{ ref: "memory://dogfood-private-output", kind: "file", summary: "Private evaluator output." }],
        stdoutRef: "memory://dogfood-private-output",
      },
      report: {
        name: `${request.nodeId}-${request.attemptId}.json`,
        mediaType: "application/json; charset=utf-8",
        content: new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, ...report(request), hiddenCase: "do-not-expose" })),
      },
      trust: {
        adapterId: "dogfood-adapter",
        adapterVersion: 1,
        profile: request.profile,
        boundary: "local-workspace",
        trustLevel,
        isolated: false,
      },
    };
  },
});

const executor = (
  rootDirectory: string,
  report: (request: EvaluatorAdapterRequest) => Record<string, unknown>,
): ReportCheckExecutor => new ReportCheckExecutor({
  rootDirectory,
  artifactStore: new MemoryCheckArtifactStore(),
  evaluatorAdapter: adapter(report),
  now: () => new Date("2026-07-24T06:00:02.000Z"),
});

const runMetric = async (
  state: HypagraphState,
  events: DomainEvent[],
  checkExecutor: ReportCheckExecutor,
  nodeId: string,
  attemptId: string,
) => {
  const lifecycle = await runAutomaticCheckLifecycle({
    state,
    executor: checkExecutor,
    nodeId,
    attemptId,
    requestedAt: at,
    signal: new AbortController().signal,
  });
  if (!lifecycle.ok) throw new Error(JSON.stringify(lifecycle.diagnostics));
  events.push(...lifecycle.events);
  return lifecycle;
};

const metricCheck = (
  kind: "development" | "probe",
  reportPath: string,
  mappings: Array<{ source: string; fact: string; type: "boolean" | "number" }>,
  trust: "transparent" | "protected" = "transparent",
  protectedPath?: { path: string; sha256: string },
) => ({
  kind: "metric-report" as const,
  command: "dogfood-evaluator",
  timeoutMs: 30_000,
  reportPath,
  parser: { name: "metric-json" as const, version: 1 as const },
  mappings,
  evaluation: {
    kind,
    feedback: kind === "development"
      ? { mode: "bounded-diagnostics" as const, maximumDiagnosticItems: 2 }
      : { mode: "aggregate" as const },
    integrity: {
      trustLevel: trust,
      ...(protectedPath === undefined ? {} : { protectedPaths: [protectedPath] }),
      evaluatorVersion: { value: `${kind}-dogfood-1` },
    },
  },
});

const optimizationDefinition = (): HypagraphDefinition => ({
  title: "M5A optimization dogfood",
  goal: "Improve a deterministic parser quality score after an inner specification gate",
  nodes: [
    {
      id: "spec",
      title: "Pass the inner specification gate",
      requires: [],
      acceptance: ["The deterministic inner specification passes."],
      produces: [{ name: "spec.green", type: "boolean", required: true }],
    },
    {
      id: "route",
      title: "Route from the specification gate",
      kind: "gate",
      requires: ["spec"],
      acceptance: [],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "spec.green" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["improve"],
        onFalse: ["stop"],
      },
    },
    { id: "stop", title: "Stop after a failed specification", requires: ["route"], acceptance: [] },
    { id: "improve", title: "Improve candidate", requires: ["route", "evaluate"], acceptance: ["Produce the next bounded candidate."] },
    {
      id: "evaluate",
      title: "Run development evaluation",
      kind: "check",
      requires: ["improve"],
      acceptance: [],
      produces: [
        { name: "evaluation.valid", type: "boolean", required: true },
        { name: "evaluation.accepted", type: "boolean", required: true },
        { name: "evaluation.score", type: "number", required: true },
        { name: "evaluation.precision", type: "number", required: true },
      ],
      check: metricCheck("development", "development.json", [
        { source: "valid", fact: "evaluation.valid", type: "boolean" },
        { source: "accepted", fact: "evaluation.accepted", type: "boolean" },
        { source: "score", fact: "evaluation.score", type: "number" },
        { source: "precision", fact: "evaluation.precision", type: "number" },
      ]),
    },
    {
      id: "probe",
      title: "Run generalization probe",
      kind: "check",
      requires: ["evaluate"],
      acceptance: [],
      produces: [
        { name: "evaluation.probe-score", type: "number", required: true },
        { name: "evaluation.generalization-valid", type: "boolean", required: true },
      ],
      check: metricCheck("probe", "probe.json", [
        { source: "score", fact: "evaluation.probe-score", type: "number" },
        { source: "generalizationValid", fact: "evaluation.generalization-valid", type: "boolean" },
      ]),
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
    maxIterations: 5,
    progress: { fact: "evaluation.score", direction: "maximize", minDelta: 0.5 },
    patience: 3,
    evaluation: {
      validWhen: {
        kind: "compare",
        left: { kind: "fact", name: "evaluation.valid" },
        operator: "eq",
        right: { kind: "literal", value: true },
      },
      maximumInvalidEvaluations: 2,
    },
    failurePolicy: "fail-workflow",
  }],
  evaluation: {
    budget: {
      maximumEvaluations: 5,
      maximumDevelopmentEvaluations: 3,
      maximumProbeEvaluations: 2,
    },
  },
  policy: { mode: "strict", requireEvidence: false },
});

const protectedLoopDefinition = (expectedHash: string, budget = 5): HypagraphDefinition => ({
  title: "M5A protected evaluator dogfood",
  goal: "Reject an evaluator change and stop later through patience",
  nodes: [
    { id: "improve", title: "Improve candidate", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate candidate",
      kind: "check",
      requires: ["improve"],
      acceptance: [],
      produces: [
        { name: "evaluation.valid", type: "boolean", required: true },
        { name: "evaluation.accepted", type: "boolean", required: true },
        { name: "evaluation.score", type: "number", required: true },
      ],
      check: metricCheck("development", "metric.json", [
        { source: "valid", fact: "evaluation.valid", type: "boolean" },
        { source: "accepted", fact: "evaluation.accepted", type: "boolean" },
        { source: "score", fact: "evaluation.score", type: "number" },
      ], "protected", { path: "tools/evaluator.mjs", sha256: expectedHash }),
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
    maxIterations: 6,
    progress: { fact: "evaluation.score", direction: "maximize", minDelta: 0.5 },
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
  evaluation: { budget: { maximumEvaluations: budget, maximumDevelopmentEvaluations: budget } },
  policy: { mode: "guided", requireEvidence: false },
});

const restoredSnapshot = (events: DomainEvent[], snapshot: HypagraphState): HypagraphState | undefined => restoreLatestSession([{
  type: "message",
  message: {
    role: "toolResult",
    toolName: "hypagraph_read",
    details: { hypagraph: { events, snapshot } },
  },
}])?.snapshot;

describe("M5A complete evaluation-contract dogfood", () => {
  it("starts from a prose-derived contract, passes a gate, improves three times, probes, accepts, restores, and replays", async () => {
    const root = await workspace("m5a-success");
    const scores: Record<string, Record<string, unknown>> = {
      "evaluation-1": { valid: true, accepted: false, score: 10, precision: 0.70 },
      "evaluation-2": { valid: true, accepted: false, score: 20, precision: 0.80 },
      "evaluation-3": { valid: true, accepted: true, score: 30, precision: 0.90 },
      "probe-1": { score: 28, generalizationValid: true },
    };
    const definition = optimizationDefinition();
    expect(assessEvaluationAuthoring(definition)).toEqual([]);
    const created = createWorkflow(definition, at, "workflow-m5a-success-dogfood");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = completeTask(created.state, events, "spec", "spec-1", [{ name: "spec.green", type: "boolean", value: true }]);
    state = apply(state, events, { type: "evaluate-gate", nodeId: "route", commandId: "route-true", at });
    expect(state.runtime.routes.route?.outcomeId).toBe("true");
    expect(state.runtime.nodes.stop?.status).toBe("skipped");

    const checkExecutor = executor(root, (request) => scores[request.attemptId] ?? {});
    let lastDevelopmentResult: CheckResult | undefined;
    for (let iteration = 1; iteration <= 3; iteration += 1) {
      state = completeTask(state, events, "improve", `improve-${iteration}`);
      const evaluated = await runMetric(state, events, checkExecutor, "evaluate", `evaluation-${iteration}`);
      state = evaluated.state;
      lastDevelopmentResult = evaluated.result;
      expect(state.runtime.loops.quality?.bestMetric).toBe(iteration * 10);
      expect(state.runtime.loops.quality?.bestIteration).toBe(iteration);
      if (iteration < 3) expect(state.runtime.loops.quality?.status).toBe("running");
    }

    expect(state.runtime.loops.quality).toMatchObject({ status: "succeeded", bestMetric: 30, bestIteration: 3 });
    expect(state.runtime.nodes.probe?.status).toBe("ready");
    const probed = await runMetric(state, events, checkExecutor, "probe", "probe-1");
    state = probed.state;

    expect(state.phase).toBe("completed");
    expect(state.runtime.facts["evaluation.probe-score"]?.value).toBe(28);
    expect(state.runtime.facts["evaluation.generalization-valid"]?.value).toBe(true);
    expect(state.runtime.evaluations).toMatchObject({ total: 4, development: 3, probe: 1 });
    expect(events.filter((event) => event.type === "hypagraph.evaluation.started").map((event) => event.data.kind)).toEqual(["development", "development", "development", "probe"]);
    expect(replayEvents(events)).toEqual(state);
    expect(restoredSnapshot(events, state)).toEqual(state);

    const developmentText = formatPiCheckResult(state, "evaluate", lastDevelopmentResult!);
    expect(developmentText).toContain("Result claim: development score");
    expect(developmentText).toContain("Evaluator trust: transparent");
    expect(developmentText).toContain("Evaluator adapter: dogfood-adapter v1");
    expect(developmentText).not.toContain("do-not-expose");
    const probeText = formatPiCheckResult(state, "probe", probed.result);
    expect(probeText).toContain("Result claim: probe score");
    expect(probeText).not.toContain("trusted isolated holdout");
  });

  it("rejects a changed evaluator score, preserves best progress, and later stops through patience", async () => {
    const root = await workspace("m5a-integrity-patience");
    await mkdir(join(root, "tools"));
    const source = "export const evaluator = 1;\n";
    await writeFile(join(root, "tools", "evaluator.mjs"), source, "utf8");
    const reports: Record<string, Record<string, unknown>> = {
      "evaluation-1": { valid: true, accepted: false, score: 10 },
      "evaluation-2": { valid: true, accepted: false, score: 10 },
      "evaluation-3": { valid: true, accepted: true, score: 999 },
      "evaluation-4": { valid: true, accepted: false, score: 10 },
    };
    const created = createWorkflow(protectedLoopDefinition(hash(source)), at, "workflow-m5a-integrity-dogfood");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = created.state;
    const checkExecutor = executor(root, (request) => reports[request.attemptId] ?? {});
    let invalidResult: CheckResult | undefined;

    for (let iteration = 1; iteration <= 4; iteration += 1) {
      state = completeTask(state, events, "improve", `improve-${iteration}`);
      if (iteration === 3) await writeFile(join(root, "tools", "evaluator.mjs"), "export const evaluator = 999;\n", "utf8");
      if (iteration === 4) await writeFile(join(root, "tools", "evaluator.mjs"), source, "utf8");
      const evaluated = await runMetric(state, events, checkExecutor, "evaluate", `evaluation-${iteration}`);
      state = evaluated.state;
      if (iteration === 3) invalidResult = evaluated.result;
    }

    expect(invalidResult?.evaluation?.integrity).toMatchObject({
      status: "invalid",
      diagnosticCodes: ["integrity_protected_file_hash_mismatch"],
    });
    expect(state.runtime.loops.quality).toMatchObject({
      status: "failed",
      exitReason: "no_progress",
      bestMetric: 10,
      bestIteration: 1,
      invalidEvaluationCount: 1,
      noProgressCount: 2,
    });
    expect(state.runtime.loops.quality?.iterations[2]).toMatchObject({
      valid: false,
      success: false,
      metric: 999,
      noProgressCount: 1,
      evaluatorIntegrity: { status: "invalid" },
    });
    expect(state.runtime.loops.quality?.iterations[2]?.improved).toBeUndefined();
    expect(renderLoopStatus(state)).toContain("exit no_progress");
    expect(replayEvents(events)).toEqual(state);
    expect(restoredSnapshot(events, state)).toEqual(state);

    const text = formatPiCheckResult(state, "evaluate", invalidResult!);
    expect(text).toContain("Evaluator integrity: invalid");
    expect(text).toContain("integrity_protected_file_hash_mismatch");
    expect(text).not.toContain("tools/evaluator.mjs");
    expect(text).not.toContain(hash(source));
    expect(text).not.toContain("do-not-expose");
  });

  it("stops at the evaluation budget and rejects a stale evaluator result", async () => {
    const root = await workspace("m5a-budget");
    await mkdir(join(root, "tools"));
    const source = "export const evaluator = 1;\n";
    await writeFile(join(root, "tools", "evaluator.mjs"), source, "utf8");
    const created = createWorkflow(protectedLoopDefinition(hash(source), 1), at, "workflow-m5a-budget-dogfood");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = completeTask(created.state, events, "improve", "improve-1");
    const evaluated = await runMetric(state, events, executor(root, () => ({ valid: false, accepted: true, score: 500 })), "evaluate", "evaluation-1");
    state = evaluated.state;

    expect(state.runtime.loops.quality).toMatchObject({
      status: "failed",
      exitReason: "evaluation_budget",
      invalidEvaluationCount: 1,
    });
    expect(state.runtime.loops.quality?.bestMetric).toBeUndefined();
    expect(state.runtime.evaluations).toMatchObject({ total: 1, development: 1 });
    expect(replayEvents(events)).toEqual(state);
    expect(restoredSnapshot(events, state)).toEqual(state);

    const standalone: HypagraphDefinition = {
      title: "Stale evaluator result",
      goal: "Reject a result from another attempt",
      nodes: [{
        id: "evaluate",
        title: "Evaluate",
        kind: "check",
        requires: [],
        acceptance: [],
        produces: [{ name: "evaluation.score", type: "number", required: true }],
        check: metricCheck("development", "metric.json", [{ source: "score", fact: "evaluation.score", type: "number" }]),
      }],
      loops: [],
      evaluation: { budget: { maximumEvaluations: 2 } },
      policy: { mode: "guided", requireEvidence: false },
    };
    const staleCreated = createWorkflow(standalone, at, "workflow-m5a-stale-dogfood");
    if (!staleCreated.ok) throw new Error(JSON.stringify(staleCreated.diagnostics));
    const started = handleCommand(staleCreated.state, { type: "start-check", nodeId: "evaluate", attemptId: "current", commandId: "start-current", at });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    const stale = handleCommand(started.state, {
      type: "record-check-result",
      nodeId: "evaluate",
      attemptId: "stale",
      result: {
        checkKind: "metric-report",
        attemptId: "stale",
        startedAt: at,
        completedAt: "2026-07-24T06:00:01.000Z",
        status: "passed",
        facts: [],
        evidence: [],
      },
      commandId: "record-stale",
      at,
    });
    expect(stale).toMatchObject({ ok: false, diagnostics: [{ code: "stale_check_attempt" }] });
  });
});
