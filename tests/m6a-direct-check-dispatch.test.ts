import { describe, expect, it, vi } from "vitest";
import { ActiveCheckExecutionRegistry } from "../src/checks/active-executions.js";
import { recoverInterruptedChecks } from "../src/checks/recovery.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import { isReadyCheckDecision, type ReadyCheckDecision } from "../src/domain/deterministic-check-dispatch.js";
import { isRunnableGoalContinuation, selectGoalContinuation } from "../src/domain/goal-continuation.js";
import type {
  CheckExecutor,
  CheckResult,
  CheckRetryPolicy,
  DomainEvent,
  HypagraphDefinition,
  HypagraphState,
} from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { handleCommand } from "../src/domain/reducer.js";
import { formatPiCheckResult, protectsEvaluatorOutput } from "../src/pi/check-runner.js";
import { runDeterministicCheckDispatch } from "../src/pi/deterministic-check-runner.js";
import {
  InMemoryWorkflowEventStore,
  type WorkflowEventAppend,
  type WorkflowEventStore,
} from "../src/persistence/event-store.js";

const at = "2026-07-25T13:00:00.000Z";
const completedAt = "2026-07-25T13:00:05.000Z";
const finishedAt = "2026-07-25T13:00:06.000Z";

const commandCheckNode = (id: string, retry?: CheckRetryPolicy) => ({
  id,
  title: `Run ${id}`,
  kind: "check" as const,
  requires: [],
  acceptance: [],
  produces: [{ name: `${id}.passed`, type: "boolean" as const, required: true }],
  check: {
    kind: "command" as const,
    command: "npm",
    arguments: ["test"],
    timeoutMs: 60_000,
    publish: [{ source: "passed" as const, fact: `${id}.passed` }],
    ...(retry ? { retry } : {}),
  },
});

const definition = (): HypagraphDefinition => ({
  title: "Direct check with independent work",
  goal: "Run a ready check without a model turn",
  nodes: [
    commandCheckNode("tests"),
    { id: "independent", title: "Independent work", requires: [], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const create = (source: HypagraphDefinition = definition(), workflowId = "direct-check-workflow") => {
  const result = createHypagoalWorkflow(source, {
    workflowId,
    goalId: "direct-check-goal",
    goalWorkflowId: workflowId,
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const readyCheck = (state: HypagraphState): ReadyCheckDecision => {
  const decision = selectGoalContinuation(state);
  if (!isRunnableGoalContinuation(decision) || !isReadyCheckDecision(decision)) {
    throw new Error(`Expected a ready check, received '${decision.kind}'.`);
  }
  return decision;
};

const checkResult = (
  attemptId: string,
  status: CheckResult["status"],
  overrides: Partial<CheckResult> = {},
): CheckResult => ({
  checkKind: "command",
  attemptId,
  startedAt: at,
  completedAt,
  status,
  exitCode: status === "passed" ? 0 : 1,
  facts: [{ name: "tests.passed", type: "boolean", value: status === "passed" }],
  evidence: [],
  ...(status === "passed" ? {} : { error: `The check ${status}.` }),
  ...overrides,
});

const executorFor = (
  factory: (attemptId: string, signal: AbortSignal) => Promise<CheckResult> | CheckResult,
): CheckExecutor => ({
  execute: vi.fn(async (request, signal) => factory(request.attemptId, signal)),
});

class RecordingStore implements WorkflowEventStore {
  readonly appends: WorkflowEventAppend[] = [];

  constructor(private readonly inner: WorkflowEventStore) {}

  async append(input: WorkflowEventAppend): Promise<void> {
    await this.inner.append(input);
    this.appends.push(structuredClone(input));
  }

  eventTypes(): string[][] {
    return this.appends.map((append) => append.events.map((event) => event.type));
  }
}

const seededStore = (created: { state: HypagraphState; events: DomainEvent[] }) => {
  const inner = new InMemoryWorkflowEventStore();
  inner.seed({ events: created.events, snapshot: created.state });
  return new RecordingStore(inner);
};

describe("M6A Slice 3 deterministic check dispatch", () => {
  it("runs a ready check in the deterministic lane without a model turn", async () => {
    const created = create();
    const store = seededStore(created);
    const order: string[] = [];
    const executor = executorFor((attemptId) => {
      order.push("execute");
      return checkResult(attemptId, "passed");
    });
    const originalAppend = store.append.bind(store);
    store.append = async (input) => {
      order.push(`store:${input.events.map((event) => event.type).join(",")}`);
      return originalAppend(input);
    };

    const dispatch = await runDeterministicCheckDispatch({
      state: created.state,
      decision: readyCheck(created.state),
      dispatchId: "check-dispatch-1",
      attemptId: "attempt-1",
      at,
      finishedAt,
      store,
      executor,
      registry: new ActiveCheckExecutionRegistry(),
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    expect(dispatch.outcome).toBe("completed");
    expect(dispatch.events.map((event) => event.type)).toEqual([
      "hypagraph.action.selected",
      "hypagraph.action.dispatched",
      "hypagraph.check.started",
      "hypagraph.fact.published",
      "hypagraph.check.result-recorded",
      "hypagraph.verification.started",
      "hypagraph.verification.passed",
      "hypagraph.action.completed",
    ]);

    // Rule 5.2: the durable check start must reach the store before the external effect runs.
    expect(order[0]).toBe("store:hypagraph.action.selected,hypagraph.action.dispatched");
    expect(order[1]).toBe("store:hypagraph.check.started");
    expect(order[2]).toBe("execute");
    expect(order.at(-1)).toBe("store:hypagraph.action.completed");

    expect(dispatch.state.runtime.nodes.tests?.status).toBe("succeeded");
    expect(dispatch.state.runtime.facts["tests.passed"]?.value).toBe(true);
    expect(dispatch.state.goal?.budget.consumedTurns).toBe(0);
    expect(dispatch.state.goal?.schedulerOrdinal).toBe(1);
    expect(dispatch.state.goal?.pendingContinuation).toBeUndefined();
    expect(dispatch.state.goal?.actionDispatch?.pending).toBeUndefined();
    expect(dispatch.state.goal?.actionDispatch?.lastOutcome).toMatchObject({
      dispatchId: "check-dispatch-1",
      lane: "deterministic",
      status: "completed",
      schedulerOrdinal: 1,
      action: { kind: "run-ready-check", nodeId: "tests" },
    });
  });

  it("keeps replay determinism and the stored snapshot", async () => {
    const created = create();
    const store = seededStore(created);
    const dispatch = await runDeterministicCheckDispatch({
      state: created.state,
      decision: readyCheck(created.state),
      dispatchId: "check-dispatch-replay",
      attemptId: "attempt-replay",
      at,
      finishedAt,
      store,
      executor: executorFor((attemptId) => checkResult(attemptId, "passed")),
      registry: new ActiveCheckExecutionRegistry(),
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    expect(replayEvents([...created.events, ...dispatch.events])).toEqual(dispatch.state);
    expect(store.appends.at(-1)?.snapshot).toEqual(dispatch.state);
  });

  it("rotates to an independent component after the deterministic check", async () => {
    const created = create();
    const dispatch = await runDeterministicCheckDispatch({
      state: created.state,
      decision: readyCheck(created.state),
      dispatchId: "check-dispatch-fairness",
      attemptId: "attempt-fairness",
      at,
      finishedAt,
      store: seededStore(created),
      executor: executorFor((attemptId) => checkResult(attemptId, "passed")),
      registry: new ActiveCheckExecutionRegistry(),
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    expect(selectGoalContinuation(dispatch.state)).toMatchObject({
      kind: "start-ready-task",
      nodeId: "independent",
      continuationOrdinal: 1,
    });
  });

  it("retries a failed check under the existing retry policy", async () => {
    const source: HypagraphDefinition = {
      title: "Direct check retry",
      goal: "Retry a failed check without a model turn",
      nodes: [commandCheckNode("tests", { maxAttempts: 2, retryOn: ["failed"] })],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = create(source, "direct-check-retry-workflow");
    const store = seededStore(created);
    const registry = new ActiveCheckExecutionRegistry();
    let state = created.state;
    const events: DomainEvent[] = [];
    const statuses: CheckResult["status"][] = ["failed", "passed"];

    for (const [index, status] of statuses.entries()) {
      const decision = readyCheck(state);
      const dispatch = await runDeterministicCheckDispatch({
        state,
        decision,
        dispatchId: `check-dispatch-retry-${index}`,
        attemptId: `attempt-retry-${index}`,
        at,
        finishedAt,
        store,
        executor: executorFor((attemptId) => checkResult(attemptId, status)),
        registry,
      });
      if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));
      // A check verdict does not fail the dispatch. The lane completed its durable work.
      expect(dispatch.outcome).toBe("completed");
      state = dispatch.state;
      events.push(...dispatch.events);
    }

    expect(state.runtime.nodes.tests?.attemptCount).toBe(2);
    expect(state.runtime.nodes.tests?.status).toBe("succeeded");
    expect(state.goal?.budget.consumedTurns).toBe(0);
    expect(state.goal?.schedulerOrdinal).toBe(2);
    expect(replayEvents([...created.events, ...events])).toEqual(state);
  });

  it("reports a retry-exhausted check as a failed dispatch", async () => {
    const source: HypagraphDefinition = {
      title: "Direct check without retry",
      goal: "Stop a failed check without a retry policy",
      nodes: [commandCheckNode("tests")],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = create(source, "direct-check-no-retry-workflow");
    const dispatch = await runDeterministicCheckDispatch({
      state: created.state,
      decision: readyCheck(created.state),
      dispatchId: "check-dispatch-no-retry",
      attemptId: "attempt-no-retry",
      at,
      finishedAt,
      store: seededStore(created),
      executor: executorFor((attemptId) => checkResult(attemptId, "failed")),
      registry: new ActiveCheckExecutionRegistry(),
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    expect(dispatch.outcome).toBe("completed");
    expect(dispatch.state.runtime.nodes.tests?.status).toBe("failed");
    expect(selectGoalContinuation(dispatch.state).kind).not.toBe("run-ready-check");
  });

  it("stops a directly dispatched check through the active-execution registry", async () => {
    const created = create();
    const registry = new ActiveCheckExecutionRegistry();
    const executor: CheckExecutor = {
      execute: vi.fn(async (request, signal) => {
        registry.cancel({ workflowId: created.state.workflowId, reason: "The user cancelled the check." });
        expect(signal.aborted).toBe(true);
        return checkResult(request.attemptId, "cancelled", { error: "The user cancelled the check." });
      }),
    };

    const dispatch = await runDeterministicCheckDispatch({
      state: created.state,
      decision: readyCheck(created.state),
      dispatchId: "check-dispatch-cancel",
      attemptId: "attempt-cancel",
      at,
      finishedAt,
      store: seededStore(created),
      executor,
      registry,
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    expect(dispatch.outcome).toBe("interrupted");
    expect(dispatch.reason).toBe("The user cancelled the check.");
    expect(dispatch.events.map((event) => event.type)).toContain("hypagraph.action.interrupted");
    expect(dispatch.state.runtime.nodes.tests?.status).toBe("failed");
    expect(dispatch.state.goal?.actionDispatch?.lastOutcome).toMatchObject({
      dispatchId: "check-dispatch-cancel",
      lane: "deterministic",
      status: "interrupted",
    });
    expect(dispatch.state.goal?.budget.consumedTurns).toBe(0);
    expect(registry.hasActive()).toBe(false);
  });

  it("registers the dispatched attempt so cancellation can reach it", async () => {
    const created = create();
    const registry = new ActiveCheckExecutionRegistry();
    let active: ReturnType<ActiveCheckExecutionRegistry["list"]> = [];
    const executor = executorFor((attemptId) => {
      active = registry.list(created.state.workflowId);
      return checkResult(attemptId, "passed");
    });

    const dispatch = await runDeterministicCheckDispatch({
      state: created.state,
      decision: readyCheck(created.state),
      dispatchId: "check-dispatch-registry",
      attemptId: "attempt-registry",
      at,
      finishedAt,
      store: seededStore(created),
      executor,
      registry,
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    expect(active).toEqual([{
      workflowId: created.state.workflowId,
      nodeId: "tests",
      attemptId: "attempt-registry",
      startedAt: at,
    }]);
    expect(registry.hasActive()).toBe(false);
  });

  it("does not close a stale dispatch when the Pi session changes", async () => {
    const created = create();
    const store = seededStore(created);
    let stale = false;
    const dispatch = await runDeterministicCheckDispatch({
      state: created.state,
      decision: readyCheck(created.state),
      dispatchId: "check-dispatch-stale",
      attemptId: "attempt-stale",
      at,
      finishedAt,
      store,
      executor: executorFor((attemptId) => {
        stale = true;
        return checkResult(attemptId, "passed");
      }),
      registry: new ActiveCheckExecutionRegistry(),
      stale: () => stale,
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    expect(dispatch.stale).toBe(true);
    expect(dispatch.outcome).toBe("interrupted");
    expect(dispatch.events.map((event) => event.type)).not.toContain("hypagraph.action.interrupted");
    expect(store.appends.at(-1)?.snapshot.goal?.actionDispatch?.pending).toMatchObject({
      dispatchId: "check-dispatch-stale",
      status: "dispatched",
    });
  });

  it("recovers an interrupted directly dispatched check through the existing recovery path", async () => {
    const created = create();
    const store = seededStore(created);
    const dispatch = await runDeterministicCheckDispatch({
      state: created.state,
      decision: readyCheck(created.state),
      dispatchId: "check-dispatch-interrupted",
      attemptId: "attempt-interrupted",
      at,
      finishedAt,
      store,
      executor: executorFor(() => {
        throw new Error("The host stopped before the check produced a result.");
      }),
      registry: new ActiveCheckExecutionRegistry(),
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    expect(dispatch.outcome).toBe("completed");
    expect(dispatch.state.runtime.nodes.tests?.status).toBe("failed");

    const orphaned = handleCommand(dispatch.state, {
      type: "start-check",
      nodeId: "tests",
      attemptId: "attempt-orphaned",
      commandId: "start-orphaned",
      at,
    });
    // The check reached a terminal state, so a new attempt requires a retry policy.
    expect(orphaned.ok).toBe(false);

    const recovery = await recoverInterruptedChecks({
      state: dispatch.state,
      store,
      at: finishedAt,
    });
    expect(recovery.recoveredAttemptIds).toEqual([]);
    expect(recovery.state).toEqual(dispatch.state);
  });

  it("closes an interrupted check attempt through recovery after a lost dispatch", async () => {
    const created = create();
    const store = seededStore(created);
    const started = handleCommand(created.state, {
      type: "start-check",
      nodeId: "tests",
      attemptId: "attempt-lost",
      commandId: "start-lost",
      at,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    await store.append({
      workflowId: created.state.workflowId,
      expectedSequence: created.state.sequence,
      events: started.events,
      snapshot: started.state,
    });

    const recovery = await recoverInterruptedChecks({ state: started.state, store, at: finishedAt });
    expect(recovery.recoveredAttemptIds).toEqual(["attempt-lost"]);
    expect(recovery.state.runtime.nodes.tests?.status).toBe("failed");
    expect(recovery.state.goal?.budget.consumedTurns).toBe(0);
  });

  it("rejects a stale check selection without producing events", async () => {
    const created = create();
    const decision = readyCheck(created.state);
    const paused = handleCommand(created.state, {
      type: "pause-goal",
      reason: "Change canonical state.",
      commandId: "pause-before-check-dispatch",
      at,
    });
    if (!paused.ok) throw new Error(JSON.stringify(paused.diagnostics));

    const store = seededStore(created);
    const executor = executorFor((attemptId) => checkResult(attemptId, "passed"));
    const dispatch = await runDeterministicCheckDispatch({
      state: paused.state,
      decision,
      dispatchId: "check-dispatch-stale-selection",
      attemptId: "attempt-stale-selection",
      at,
      finishedAt,
      store,
      executor,
      registry: new ActiveCheckExecutionRegistry(),
    });

    expect(dispatch).toMatchObject({ ok: false, dispatched: false, diagnostics: [{ code: "goal_not_active" }] });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(store.appends).toEqual([]);
  });

  it("does not dispatch while a model-lane continuation is pending", async () => {
    const created = create();
    const decision = readyCheck(created.state);
    const requested = handleCommand(created.state, {
      type: "request-goal-continuation",
      goalId: decision.goalId,
      workflowId: decision.workflowId,
      expectedRevision: decision.revision,
      expectedSequence: decision.sequence,
      expectedSnapshotHash: decision.snapshotHash,
      expectedContinuationOrdinal: decision.continuationOrdinal,
      sessionGeneration: 0,
      branchGeneration: 0,
      action: { kind: "run-ready-check", nodeId: "tests" },
      commandId: "model-lane-operation",
      correlationId: "model-lane-operation",
      at,
    });
    if (!requested.ok) throw new Error(JSON.stringify(requested.diagnostics));

    const dispatch = await runDeterministicCheckDispatch({
      state: requested.state,
      decision,
      dispatchId: "check-dispatch-during-model-turn",
      attemptId: "attempt-during-model-turn",
      at,
      finishedAt,
      store: seededStore(created),
      executor: executorFor((attemptId) => checkResult(attemptId, "passed")),
      registry: new ActiveCheckExecutionRegistry(),
    });

    expect(dispatch).toMatchObject({
      ok: false,
      diagnostics: [{ code: "goal_continuation_pending" }],
    });
  });

  it("consumes evaluation budget exactly once for a directly dispatched metric evaluation", async () => {
    const source: HypagraphDefinition = {
      title: "Direct metric evaluation",
      goal: "Count one evaluation for one deterministic dispatch",
      nodes: [{
        id: "evaluate",
        title: "Evaluate quality",
        kind: "check",
        requires: [],
        acceptance: [],
        produces: [{ name: "evaluate.score", type: "number", required: false }],
        check: {
          kind: "metric-report",
          command: "evaluator",
          timeoutMs: 30_000,
          reportPath: "evaluate.json",
          parser: { name: "metric-json", version: 1 },
          mappings: [{ source: "score", fact: "evaluate.score", type: "number", required: false }],
          evaluation: { kind: "development", feedback: { mode: "aggregate" } },
        },
      }],
      loops: [],
      evaluation: { budget: { maximumEvaluations: 2, maximumDevelopmentEvaluations: 1 } },
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = create(source, "direct-metric-workflow");
    const dispatch = await runDeterministicCheckDispatch({
      state: created.state,
      decision: readyCheck(created.state),
      dispatchId: "check-dispatch-metric",
      attemptId: "attempt-metric",
      at,
      finishedAt,
      store: seededStore(created),
      executor: executorFor((attemptId) => ({
        checkKind: "metric-report",
        attemptId,
        startedAt: at,
        completedAt,
        status: "passed",
        exitCode: 0,
        facts: [{ name: "evaluate.score", type: "number", value: 0.9 }],
        evidence: [],
        evaluation: { kind: "development", feedbackMode: "aggregate", diagnostics: [], diagnosticsTruncated: false },
      })),
      registry: new ActiveCheckExecutionRegistry(),
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    expect(dispatch.outcome).toBe("completed");
    expect(dispatch.state.runtime.evaluations).toMatchObject({ total: 1, development: 1, lastKind: "development" });
    expect(dispatch.events.filter((event) => event.type === "hypagraph.evaluation.started")).toHaveLength(1);
    expect(dispatch.state.goal?.budget.consumedTurns).toBe(0);
  });

  it("keeps protected evaluator output protected for a directly dispatched check", async () => {
    const source: HypagraphDefinition = {
      title: "Direct protected evaluation",
      goal: "Protect evaluator output in the deterministic lane",
      nodes: [{
        id: "evaluate",
        title: "Evaluate quality",
        kind: "check",
        requires: [],
        acceptance: [],
        produces: [{ name: "evaluate.score", type: "number", required: false }],
        check: {
          kind: "metric-report",
          command: "protected-evaluator",
          arguments: ["--secret-suite"],
          timeoutMs: 30_000,
          reportPath: "protected/evaluate.json",
          parser: { name: "metric-json", version: 1 },
          mappings: [{ source: "score", fact: "evaluate.score", type: "number", required: false }],
          evaluation: { kind: "holdout", feedback: { mode: "aggregate" } },
        },
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const created = create(source, "direct-protected-workflow");
    const dispatch = await runDeterministicCheckDispatch({
      state: created.state,
      decision: readyCheck(created.state),
      dispatchId: "check-dispatch-protected",
      attemptId: "attempt-protected",
      at,
      finishedAt,
      store: seededStore(created),
      executor: executorFor((attemptId) => ({
        checkKind: "metric-report",
        attemptId,
        startedAt: at,
        completedAt,
        status: "failed",
        exitCode: 1,
        facts: [{ name: "evaluate.score", type: "number", value: 0.2 }],
        evidence: [],
        error: "secret expectation 'internal-case-7' did not hold",
        stdoutRef: "artifact://protected-stdout",
        stderrRef: "artifact://protected-stderr",
        evaluation: { kind: "holdout", feedbackMode: "aggregate", diagnostics: [], diagnosticsTruncated: false },
      })),
      registry: new ActiveCheckExecutionRegistry(),
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    const node = dispatch.state.definition.nodes.find((item) => item.id === "evaluate");
    expect(protectsEvaluatorOutput(node?.check)).toBe(true);
    const rendered = formatPiCheckResult(dispatch.state, "evaluate", dispatch.result!);
    expect(rendered).toContain("Command: protected evaluator command");
    expect(rendered).toContain("Report: protected evaluator report");
    expect(rendered).toContain("Stdout: protected");
    expect(rendered).toContain("Stderr: protected");
    expect(rendered).not.toContain("internal-case-7");
    expect(rendered).not.toContain("--secret-suite");
  });
});
