import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import { runAutomaticCheckLifecycle } from "../src/checks/lifecycle.js";
import { ReportCheckExecutor } from "../src/checks/report-check-executor.js";
import type { CheckExecutor, CheckResult, DomainEvent, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";

const roots: string[] = [];
const at = "2026-07-23T13:20:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const definition = (): HypagraphDefinition => ({
  title: "Metric progress loop",
  goal: "Use a parsed evaluator score as bounded loop progress",
  nodes: [
    { id: "improve", title: "Improve", kind: "task", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate",
      kind: "check",
      requires: ["improve"],
      acceptance: [],
      produces: [
        { name: "evaluation.accepted", type: "boolean", required: true },
        { name: "evaluation.score", type: "number", required: true },
      ],
      check: {
        kind: "metric-report",
        command: "evaluator",
        timeoutMs: 30_000,
        reportPath: "metrics.json",
        parser: { name: "metric-json", version: 1 },
        mappings: [
          { source: "accepted", fact: "evaluation.accepted", type: "boolean" },
          { source: "score", fact: "evaluation.score", type: "number" },
        ],
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
    maxIterations: 4,
    progress: { fact: "evaluation.score", direction: "maximize", minDelta: 0.01 },
    patience: 2,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  return result.state;
};

const producerResult = (): CheckResult => ({
  checkKind: "command",
  attemptId: "evaluate-1",
  startedAt: at,
  completedAt: "2026-07-23T13:20:01.000Z",
  status: "passed",
  exitCode: 0,
  facts: [],
  evidence: [],
});

describe("M5A metric report loop integration", () => {
  it("feeds a parsed scalar score into M4 best-result and patience state", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-metric-loop-"));
    roots.push(root);
    await writeFile(join(root, "metrics.json"), JSON.stringify({ schemaVersion: 1, accepted: false, score: 0.72 }), "utf8");

    const created = createWorkflow(definition(), at, "workflow-metric-loop");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const events = [...created.events];
    let state = apply(created.state, events, { type: "start-node", nodeId: "improve", attemptId: "improve-1", commandId: "improve-start", at });
    state = apply(state, events, { type: "submit-result", nodeId: "improve", attemptId: "improve-1", evidence: [], commandId: "improve-submit", at });
    state = apply(state, events, { type: "begin-verification", nodeId: "improve", attemptId: "improve-1", commandId: "improve-begin", at });
    state = apply(state, events, { type: "complete-verification", nodeId: "improve", attemptId: "improve-1", passed: true, commandId: "improve-verify", at });

    const producer: CheckExecutor = { execute: vi.fn(async () => producerResult()) };
    const result = await runAutomaticCheckLifecycle({
      state,
      executor: new ReportCheckExecutor({
        rootDirectory: root,
        artifactStore: new MemoryCheckArtifactStore(),
        producerExecutor: producer,
        now: () => new Date("2026-07-23T13:20:02.000Z"),
      }),
      nodeId: "evaluate",
      attemptId: "evaluate-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    events.push(...result.events);
    expect(result.state.runtime.facts["evaluation.score"]?.value).toBe(0.72);
    expect(result.state.runtime.loops["quality-loop"]).toMatchObject({
      currentIteration: 2,
      currentMetric: 0.72,
      bestMetric: 0.72,
      bestIteration: 1,
      noProgressCount: 0,
      status: "running",
    });
    expect(result.state.runtime.loops["quality-loop"]?.iterations[0]).toMatchObject({
      iteration: 1,
      metric: 0.72,
      improved: true,
      decision: "continue",
    });
    expect(result.state.runtime.nodes.improve?.status).toBe("ready");
    expect(replayEvents(events)).toEqual(result.state);
  });
});
