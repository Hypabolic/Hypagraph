import { describe, expect, it, vi } from "vitest";
import { runAutomaticCheckLifecycle } from "../src/checks/lifecycle.js";
import type {
  CheckExecutor,
  CheckResult,
  DomainEvent,
  EvaluationKind,
  FactInput,
  HypagraphCommand,
  HypagraphDefinition,
  HypagraphState,
} from "../src/domain/model.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";

const at = "2026-07-23T15:10:00.000Z";

const optionalMetricNode = (id: string, requires: string[], kind: EvaluationKind) => ({
  id,
  title: `Run ${kind} evaluation`,
  kind: "check" as const,
  requires,
  acceptance: [],
  produces: [{ name: `${id}.score`, type: "number" as const, required: false }],
  check: {
    kind: "metric-report" as const,
    command: "evaluator",
    timeoutMs: 30_000,
    reportPath: `${id}.json`,
    parser: { name: "metric-json" as const, version: 1 as const },
    mappings: [{ source: "score", fact: `${id}.score`, type: "number" as const, required: false }],
    evaluation: { kind, feedback: { mode: "aggregate" as const } },
  },
});

const result = (attemptId: string, status: CheckResult["status"] = "passed", facts: FactInput[] = []): CheckResult => ({
  checkKind: "metric-report",
  attemptId,
  startedAt: at,
  completedAt: "2026-07-23T15:10:01.000Z",
  status,
  facts,
  evidence: [],
  ...(status === "error" ? { error: "The evaluator failed." } : {}),
});

const executor = (factory: (attemptId: string) => CheckResult): CheckExecutor => ({
  execute: vi.fn(async (request) => factory(request.attemptId)),
});

const apply = (state: HypagraphState, events: DomainEvent[], command: HypagraphCommand): HypagraphState => {
  const reduced = handleCommand(state, command);
  if (!reduced.ok) throw new Error(JSON.stringify(reduced.diagnostics));
  events.push(...reduced.events);
  return reduced.state;
};

describe("M5A evaluation budgets", () => {
  it("records development, probe, and holdout starts and replays the counters", async () => {
    const definition: HypagraphDefinition = {
      title: "Evaluation kinds",
      goal: "Count each evaluation kind",
      nodes: [
        optionalMetricNode("development", [], "development"),
        optionalMetricNode("probe", ["development"], "probe"),
        optionalMetricNode("holdout", ["probe"], "holdout"),
      ],
      loops: [],
      evaluation: { budget: { maximumEvaluations: 6, maximumDevelopmentEvaluations: 2, maximumProbeEvaluations: 2, maximumHoldoutEvaluations: 2 } },
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = createWorkflow(definition, at, "workflow-evaluation-kinds");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = created.state;
    for (const nodeId of ["development", "probe", "holdout"]) {
      const lifecycle = await runAutomaticCheckLifecycle({
        state,
        executor: executor((attemptId) => result(attemptId)),
        nodeId,
        attemptId: `${nodeId}-1`,
        requestedAt: at,
        signal: new AbortController().signal,
      });
      if (!lifecycle.ok) throw new Error(JSON.stringify(lifecycle.diagnostics));
      state = lifecycle.state;
      events.push(...lifecycle.events);
    }

    expect(state.runtime.evaluations).toMatchObject({ total: 3, development: 1, probe: 1, holdout: 1, lastKind: "holdout" });
    expect(events.filter((event) => event.type === "hypagraph.evaluation.started").map((event) => event.data.kind)).toEqual(["development", "probe", "holdout"]);
    expect(replayEvents(events)).toEqual(state);
  });

  it.each(["failed", "timed_out", "cancelled", "error"] as const)("counts a %s evaluation after the external start", async (status) => {
    const definition: HypagraphDefinition = {
      title: "Failed evaluation budget",
      goal: "Count each external evaluation start",
      nodes: [{
        ...optionalMetricNode("evaluate", [], "development"),
        check: {
          ...optionalMetricNode("evaluate", [], "development").check,
          retry: { maxAttempts: 2, retryOn: [status === "cancelled" ? "error" : status === "timed_out" ? "timed_out" : status === "failed" ? "failed" : "error"] },
        },
      }],
      loops: [],
      evaluation: { budget: { maximumEvaluations: 1 } },
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = createWorkflow(definition, at, `workflow-${status}-budget`);
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const lifecycle = await runAutomaticCheckLifecycle({
      state: created.state,
      executor: executor((attemptId) => result(attemptId, status)),
      nodeId: "evaluate",
      attemptId: "evaluate-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    if (!lifecycle.ok) throw new Error(JSON.stringify(lifecycle.diagnostics));
    expect(lifecycle.state.runtime.evaluations).toMatchObject({ total: 1, development: 1 });
  });

  it("rejects a retry before it starts another external evaluation", async () => {
    const node = optionalMetricNode("evaluate", [], "development");
    node.check.retry = { maxAttempts: 2, retryOn: ["error"] };
    const definition: HypagraphDefinition = {
      title: "Retry budget",
      goal: "Stop a retry at the evaluation limit",
      nodes: [node],
      loops: [],
      evaluation: { budget: { maximumEvaluations: 1 } },
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = createWorkflow(definition, at, "workflow-retry-budget");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const first = await runAutomaticCheckLifecycle({
      state: created.state,
      executor: executor((attemptId) => result(attemptId, "error")),
      nodeId: "evaluate",
      attemptId: "evaluate-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));

    const retry = handleCommand(first.state, { type: "start-check", nodeId: "evaluate", attemptId: "evaluate-2", commandId: "retry", at });
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.diagnostics[0]?.code).toBe("evaluation_budget_exhausted");
    expect(first.state.runtime.evaluations?.total).toBe(1);
  });

  it("stops a loop after an invalid evaluation uses the remaining budget", async () => {
    const definition: HypagraphDefinition = {
      title: "Loop evaluation budget",
      goal: "Stop the loop at the evaluation budget",
      nodes: [
        { id: "improve", title: "Improve", requires: ["evaluate"], acceptance: [] },
        {
          ...optionalMetricNode("evaluate", ["improve"], "development"),
          produces: [
            { name: "evaluation.valid", type: "boolean", required: true },
            { name: "evaluation.accepted", type: "boolean", required: true },
            { name: "evaluation.score", type: "number", required: true },
          ],
          check: {
            ...optionalMetricNode("evaluate", ["improve"], "development").check,
            mappings: [
              { source: "valid", fact: "evaluation.valid", type: "boolean" },
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
        successWhen: { kind: "compare", left: { kind: "fact", name: "evaluation.accepted" }, operator: "eq", right: { kind: "literal", value: true } },
        maxIterations: 5,
        progress: { fact: "evaluation.score", direction: "maximize" },
        evaluation: {
          validWhen: { kind: "compare", left: { kind: "fact", name: "evaluation.valid" }, operator: "eq", right: { kind: "literal", value: true } },
          maximumInvalidEvaluations: 2,
        },
      }],
      evaluation: { budget: { maximumDevelopmentEvaluations: 1 } },
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = createWorkflow(definition, at, "workflow-loop-budget");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const events = [...created.events];
    let state = apply(created.state, events, { type: "start-node", nodeId: "improve", attemptId: "improve-1", commandId: "improve-start", at });
    state = apply(state, events, { type: "submit-result", nodeId: "improve", attemptId: "improve-1", evidence: [], commandId: "improve-submit", at });
    state = apply(state, events, { type: "begin-verification", nodeId: "improve", attemptId: "improve-1", commandId: "improve-begin", at });
    state = apply(state, events, { type: "complete-verification", nodeId: "improve", attemptId: "improve-1", passed: true, commandId: "improve-complete", at });

    const lifecycle = await runAutomaticCheckLifecycle({
      state,
      executor: executor((attemptId) => result(attemptId, "passed", [
        { name: "evaluation.valid", type: "boolean", value: false },
        { name: "evaluation.accepted", type: "boolean", value: true },
        { name: "evaluation.score", type: "number", value: 999 },
      ])),
      nodeId: "evaluate",
      attemptId: "evaluate-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    if (!lifecycle.ok) throw new Error(JSON.stringify(lifecycle.diagnostics));
    events.push(...lifecycle.events);

    expect(lifecycle.state.runtime.loops["quality-loop"]).toMatchObject({
      status: "failed",
      exitReason: "evaluation_budget",
      invalidEvaluationCount: 1,
    });
    expect(lifecycle.state.runtime.evaluations).toMatchObject({ total: 1, development: 1 });
    expect(lifecycle.events.findIndex((event) => event.type === "hypagraph.evaluation.started")).toBeLessThan(lifecycle.events.findIndex((event) => event.type === "hypagraph.check.started"));
    expect(replayEvents(events)).toEqual(lifecycle.state);
  });
});
