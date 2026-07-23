from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old in text:
        file.write_text(text.replace(old, new, 1))
        return
    if new not in text:
        raise SystemExit(f"Required text was not found in {path}")


def write(path: str, content: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    if not file.exists() or file.read_text() != content:
        file.write_text(content)


replace_once(
    "src/domain/reducer.ts",
    '''const prepareLoopEvaluation = (state: HypagraphState, nodeId: string): LoopEvaluation | Rejection | undefined => {
  const definition = state.definition.loops.find((loop) => loop.evaluateAfter === nodeId);
  if (!definition) return undefined;
  const runtime = state.runtime.loops[definition.id];
  if (!runtime || runtime.status !== "running") return reject("loop_not_running", `Loop '${definition.id}' is not running.`);
  if (isLegacyPredicate(definition.successWhen)) return reject("loop_predicate_revision_required", `Loop '${definition.id}' requires a typed success condition before it can run.`, `loops.${definition.id}.successWhen`);
  const result = evaluateCondition(definition.successWhen, state.runtime.facts);
  if (!result.ok) return reject(result.code, result.message, `loops.${definition.id}.successWhen`);
  return {
    loopId: definition.id,
    iteration: runtime.currentIteration,
    success: result.value,
    factsUsed: result.factsUsed,
    semanticsVersion: CONDITION_SEMANTICS_VERSION,
  };
};
''',
    '''const prepareLoopEvaluation = (state: HypagraphState, nodeId: string): LoopEvaluation | Rejection | undefined => {
  const definition = state.definition.loops.find((loop) => loop.evaluateAfter === nodeId);
  if (!definition) return undefined;
  const runtime = state.runtime.loops[definition.id];
  if (!runtime || runtime.status !== "running") return reject("loop_not_running", `Loop '${definition.id}' is not running.`);
  if (isLegacyPredicate(definition.successWhen)) return reject("loop_predicate_revision_required", `Loop '${definition.id}' requires a typed success condition before it can run.`, `loops.${definition.id}.successWhen`);
  const result = evaluateCondition(definition.successWhen, state.runtime.facts);
  if (!result.ok) return reject(result.code, result.message, `loops.${definition.id}.successWhen`);
  return {
    loopId: definition.id,
    iteration: runtime.currentIteration,
    success: result.value,
    factsUsed: result.factsUsed,
    semanticsVersion: CONDITION_SEMANTICS_VERSION,
  };
};

const isFailedCheckLoopObservation = (state: HypagraphState, nodeId: string, attemptId: string): boolean => {
  const definition = state.definition.nodes.find((item) => item.id === nodeId);
  if ((definition?.kind ?? "task") !== "check") return false;
  if (!state.definition.loops.some((loop) => loop.evaluateAfter === nodeId)) return false;
  const attempt = state.runtime.nodes[nodeId]?.attempts[attemptId];
  if (attempt?.checkResult?.status !== "failed") return false;
  return requiredFactsArePresent(state, nodeId, attemptId).length === 0;
};
''',
)

replace_once(
    "src/domain/reducer.ts",
    '''      const evaluation = command.passed ? prepareLoopEvaluation(state, command.nodeId) : undefined;
      if (evaluation && "ok" in evaluation) return evaluation;
      next = append(next, events, command, { type: command.passed ? "hypagraph.verification.passed" : "hypagraph.verification.failed", nodeId: command.nodeId, attemptId: command.attemptId, data: command.reason ? { reason: command.reason } : {} });
      if (evaluation) {
        const loopRuntime = next.runtime.loops[evaluation.loopId];
        const canContinue = !evaluation.success && !!loopRuntime && evaluation.iteration < loopRuntime.maxIterations;
        const decision = evaluation.success ? "complete" : canContinue ? "continue" : "pending";
''',
    '''      const failedCheckObservation = !command.passed && isFailedCheckLoopObservation(state, command.nodeId, command.attemptId);
      const evaluation = command.passed || failedCheckObservation ? prepareLoopEvaluation(state, command.nodeId) : undefined;
      if (evaluation && "ok" in evaluation) return evaluation;
      next = append(next, events, command, { type: command.passed ? "hypagraph.verification.passed" : "hypagraph.verification.failed", nodeId: command.nodeId, attemptId: command.attemptId, data: command.reason ? { reason: command.reason } : {} });
      if (evaluation) {
        const loopRuntime = next.runtime.loops[evaluation.loopId];
        const completes = command.passed && evaluation.success;
        const canContinue = !evaluation.success && !!loopRuntime && evaluation.iteration < loopRuntime.maxIterations;
        const decision = completes ? "complete" : canContinue ? "continue" : "pending";
''',
)

replace_once(
    "src/domain/reducer.ts",
    '''            semanticsVersion: evaluation.semanticsVersion,
            decision,
          },
        });
        if (evaluation.success) {
          next = append(next, events, command, { type: "hypagraph.loop.completed", loopId: evaluation.loopId, data: { loopId: evaluation.loopId, iteration: evaluation.iteration, exitReason: "success" } });
''',
    '''            semanticsVersion: evaluation.semanticsVersion,
            decision,
            verificationPassed: command.passed,
            ...(failedCheckObservation ? { observationStatus: "failed" } : {}),
          },
        });
        if (completes) {
          next = append(next, events, command, { type: "hypagraph.loop.completed", loopId: evaluation.loopId, data: { loopId: evaluation.loopId, iteration: evaluation.iteration, exitReason: "success" } });
''',
)

write("tests/loop-check-repair.test.ts", r'''import { describe, expect, it, vi } from "vitest";
import { runDurableCheckLifecycle } from "../src/checks/durable-lifecycle.js";
import type { CheckExecutor, CheckResult, DomainEvent, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow } from "../src/domain/reducer.js";
import { applyCommandsAndCommit } from "../src/persistence/coordinator.js";
import { InMemoryWorkflowEventStore, type WorkflowEventAppend, type WorkflowEventStore } from "../src/persistence/event-store.js";

const at = "2026-07-23T03:00:00.000Z";

const repairDefinition = (): HypagraphDefinition => ({
  title: "Check-driven repair loop",
  goal: "Use a failing test result as an observation and pass the next iteration",
  nodes: [
    { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
    {
      id: "test",
      title: "Test",
      kind: "check",
      requires: ["implement"],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "node",
        arguments: ["-e", "process.exit(0)"],
        timeoutMs: 10_000,
        publish: [{ source: "passed", fact: "tests.passed" }],
      },
    },
    { id: "document", title: "Document", requires: ["test"], acceptance: [] },
  ],
  loops: [{
    id: "repair",
    nodes: ["implement", "test"],
    entry: "implement",
    evaluateAfter: "test",
    feedbackEdges: [{ from: "test", to: "implement" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "tests.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 3,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const nonEvaluationCheckDefinition = (): HypagraphDefinition => ({
  title: "Check retry stays in one iteration",
  goal: "Retry a non-evaluation check without incrementing the loop",
  nodes: [
    { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
    {
      id: "lint",
      title: "Lint",
      kind: "check",
      requires: ["implement"],
      acceptance: [],
      check: {
        kind: "command",
        command: "node",
        arguments: ["-e", "process.exit(0)"],
        timeoutMs: 10_000,
        retry: { maxAttempts: 2, retryOn: ["error"] },
        publish: [],
      },
    },
    { id: "test", title: "Test", requires: ["lint"], acceptance: [] },
  ],
  loops: [{
    id: "repair",
    nodes: ["implement", "lint", "test"],
    entry: "implement",
    evaluateAfter: "test",
    feedbackEdges: [{ from: "test", to: "implement" }],
    successWhen: { kind: "literal", value: true },
    maxIterations: 3,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const failedResult = (attemptId: string): CheckResult => ({
  checkKind: "command",
  attemptId,
  startedAt: at,
  completedAt: "2026-07-23T03:00:02.000Z",
  status: "failed",
  exitCode: 1,
  facts: [],
  evidence: [{ ref: `command://${attemptId}`, kind: "command", summary: "The command failed." }],
});

const passedResult = (attemptId: string): CheckResult => ({
  checkKind: "command",
  attemptId,
  startedAt: at,
  completedAt: "2026-07-23T03:00:02.000Z",
  status: "passed",
  exitCode: 0,
  facts: [],
  evidence: [{ ref: `command://${attemptId}`, kind: "command", summary: "The command passed." }],
});

const errorResult = (attemptId: string): CheckResult => ({
  checkKind: "command",
  attemptId,
  startedAt: at,
  completedAt: "2026-07-23T03:00:02.000Z",
  status: "error",
  facts: [],
  evidence: [],
  error: "The lint adapter failed.",
});

const completeTask = async (
  store: InMemoryWorkflowEventStore,
  state: HypagraphState,
  nodeId: string,
  attemptId: string,
): Promise<HypagraphState> => {
  const commands: HypagraphCommand[] = [
    { type: "start-node", nodeId, attemptId, commandId: `${attemptId}-start`, at },
    { type: "submit-result", nodeId, attemptId, evidence: [{ ref: `note://${attemptId}`, kind: "note" }], commandId: `${attemptId}-submit`, at },
    { type: "begin-verification", nodeId, attemptId, commandId: `${attemptId}-begin`, at },
    { type: "complete-verification", nodeId, attemptId, passed: true, commandId: `${attemptId}-complete`, at },
  ];
  const committed = await applyCommandsAndCommit(store, state, commands);
  if (!committed.ok) throw new Error(JSON.stringify(committed.diagnostics));
  return committed.value.state;
};

class RecordingStore implements WorkflowEventStore {
  readonly appends: WorkflowEventAppend[] = [];
  constructor(private readonly inner: WorkflowEventStore) {}
  async append(input: WorkflowEventAppend): Promise<void> {
    await this.inner.append(input);
    this.appends.push(structuredClone(input));
  }
}

describe("M4 Slice 3 check-driven repair loops", () => {
  it("continues after a failed evaluation check and completes on the next check", async () => {
    const created = createWorkflow(repairDefinition(), at, "workflow-check-repair");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const inner = new InMemoryWorkflowEventStore();
    inner.seed({ events: created.events, snapshot: created.state });
    const store = new RecordingStore(inner);

    let state = await completeTask(inner, created.state, "implement", "implement-1");
    const first = await runDurableCheckLifecycle({
      state,
      executor: { execute: vi.fn(async () => failedResult("test-1")) },
      store,
      nodeId: "test",
      attemptId: "test-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.state;

    expect(state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 2, lastSuccess: false });
    expect(state.runtime.loops.repair?.iterations[0]).toMatchObject({ iteration: 1, success: false, decision: "continue" });
    expect(state.runtime.nodes.implement?.status).toBe("ready");
    expect(state.runtime.nodes.test?.attempts["test-1"]).toMatchObject({ status: "failed", loopId: "repair", iteration: 1 });
    expect(state.runtime.facts["tests.passed"]).toBeUndefined();
    const firstVerification = store.appends.at(-1)!;
    expect(firstVerification.events.map((event) => event.type)).toEqual([
      "hypagraph.verification.started",
      "hypagraph.verification.failed",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.iteration-started",
      "hypagraph.node.ready",
    ]);
    const firstEvaluation = firstVerification.events.find((event) => event.type === "hypagraph.loop.evaluated")!;
    expect(firstEvaluation.data).toMatchObject({ success: false, decision: "continue", verificationPassed: false, observationStatus: "failed" });
    expect(first.events.find((event) => event.type === "hypagraph.check.started")?.data.retry).toBe(false);

    state = await completeTask(inner, state, "implement", "implement-2");
    const second = await runDurableCheckLifecycle({
      state,
      executor: { execute: vi.fn(async () => passedResult("test-2")) },
      store,
      nodeId: "test",
      attemptId: "test-2",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    state = second.state;

    expect(state.runtime.loops.repair).toMatchObject({ status: "succeeded", currentIteration: 2, lastSuccess: true, exitReason: "success" });
    expect(state.runtime.nodes.document?.status).toBe("ready");
    expect(state.runtime.nodes.test?.attempts["test-1"]?.iteration).toBe(1);
    expect(state.runtime.nodes.test?.attempts["test-2"]?.iteration).toBe(2);
    expect(second.events.find((event) => event.type === "hypagraph.check.started")?.data.retry).toBe(false);
    expect(state.runtime.facts["tests.passed"]).toMatchObject({ value: true, attemptId: "test-2", iteration: 2 });

    const stored = inner.read(state.workflowId)!;
    expect(replayEvents(stored.events)).toEqual(state);
    expect(replayEvents(stored.events).snapshotHash).toBe(state.snapshotHash);
  });

  it("does not continue after a failed non-evaluation check and keeps retries in the same iteration", async () => {
    const created = createWorkflow(nonEvaluationCheckDefinition(), at, "workflow-check-retry");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: created.events, snapshot: created.state });
    let state = await completeTask(store, created.state, "implement", "implement-1");

    const firstExecutor: CheckExecutor = { execute: vi.fn(async () => errorResult("lint-1")) };
    const first = await runDurableCheckLifecycle({
      state,
      executor: firstExecutor,
      store,
      nodeId: "lint",
      attemptId: "lint-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    state = first.state;
    expect(state.runtime.nodes.lint?.status).toBe("failed");
    expect(state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1 });
    expect(first.events.some((event) => event.type === "hypagraph.loop.evaluated")).toBe(false);

    const second = await runDurableCheckLifecycle({
      state,
      executor: { execute: vi.fn(async () => passedResult("lint-2")) },
      store,
      nodeId: "lint",
      attemptId: "lint-2",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    state = second.state;
    expect(state.runtime.loops.repair.currentIteration).toBe(1);
    expect(state.runtime.nodes.lint?.attempts["lint-1"]?.iteration).toBe(1);
    expect(state.runtime.nodes.lint?.attempts["lint-2"]?.iteration).toBe(1);
    expect(second.events.find((event) => event.type === "hypagraph.check.started")?.data).toMatchObject({ retry: true, previousAttemptId: "lint-1", iteration: 1 });
    expect(state.runtime.nodes.test?.status).toBe("ready");
  });
});
''')

write("tests/loop-check-recovery.test.ts", r'''import { describe, expect, it, vi } from "vitest";
import { recoverInterruptedChecks } from "../src/checks/recovery.js";
import { runDurableCheckLifecycle } from "../src/checks/durable-lifecycle.js";
import type { CheckExecutor, CheckResult, HypagraphCommand, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import { createWorkflow } from "../src/domain/reducer.js";
import { applyCommandAndCommit, applyCommandsAndCommit } from "../src/persistence/coordinator.js";
import { InMemoryWorkflowEventStore, type WorkflowEventStore } from "../src/persistence/event-store.js";

const at = "2026-07-23T04:00:00.000Z";
const recoveredAt = "2026-07-23T04:05:00.000Z";

const definition = (): HypagraphDefinition => ({
  title: "Recover a loop check",
  goal: "Recover without rerunning the evaluator",
  nodes: [
    { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
    {
      id: "test",
      title: "Test",
      kind: "check",
      requires: ["implement"],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "node",
        arguments: ["-e", "process.exit(1)"],
        timeoutMs: 10_000,
        publish: [{ source: "passed", fact: "tests.passed" }],
      },
    },
  ],
  loops: [{
    id: "repair",
    nodes: ["implement", "test"],
    entry: "implement",
    evaluateAfter: "test",
    feedbackEdges: [{ from: "test", to: "implement" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "tests.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 3,
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const failedResult = (): CheckResult => ({
  checkKind: "command",
  attemptId: "test-1",
  startedAt: at,
  completedAt: "2026-07-23T04:00:02.000Z",
  status: "failed",
  exitCode: 1,
  facts: [],
  evidence: [],
});

const completeImplement = async (store: InMemoryWorkflowEventStore, state: HypagraphState): Promise<HypagraphState> => {
  const commands: HypagraphCommand[] = [
    { type: "start-node", nodeId: "implement", attemptId: "implement-1", commandId: "implement-start", at },
    { type: "submit-result", nodeId: "implement", attemptId: "implement-1", evidence: [], commandId: "implement-submit", at },
    { type: "begin-verification", nodeId: "implement", attemptId: "implement-1", commandId: "implement-begin", at },
    { type: "complete-verification", nodeId: "implement", attemptId: "implement-1", passed: true, commandId: "implement-complete", at },
  ];
  const committed = await applyCommandsAndCommit(store, state, commands);
  if (!committed.ok) throw new Error(JSON.stringify(committed.diagnostics));
  return committed.value.state;
};

describe("M4 Slice 3 loop check recovery", () => {
  it("finishes a stored failed observation and starts iteration 2 without rerun", async () => {
    const created = createWorkflow(definition(), at, "workflow-loop-recovery-result");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const inner = new InMemoryWorkflowEventStore();
    inner.seed({ events: created.events, snapshot: created.state });
    let state = await completeImplement(inner, created.state);
    let appendCount = 0;
    const stoppingStore: WorkflowEventStore = {
      append: async (input) => {
        appendCount += 1;
        if (appendCount == 4) throw new Error("The verification commit stopped.");
        await inner.append(input);
      },
    };
    const executor: CheckExecutor = { execute: vi.fn(async () => failedResult()) };
    const lifecycle = await runDurableCheckLifecycle({
      state,
      executor,
      store: stoppingStore,
      nodeId: "test",
      attemptId: "test-1",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(lifecycle.ok).toBe(false);
    if (lifecycle.ok) return;
    expect(lifecycle.state.runtime.nodes.test?.status).toBe("awaiting_evidence");
    expect(lifecycle.state.runtime.facts["tests.passed"]?.value).toBe(false);

    const recovered = await recoverInterruptedChecks({ state: lifecycle.state, store: inner, at: recoveredAt });
    expect(executor.execute).toHaveBeenCalledOnce();
    expect(recovered.state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 2, lastSuccess: false });
    expect(recovered.state.runtime.nodes.implement?.status).toBe("ready");
    expect(recovered.events.map((event) => event.type)).toEqual([
      "hypagraph.verification.started",
      "hypagraph.verification.failed",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.iteration-started",
      "hypagraph.node.ready",
    ]);
    const stored = inner.read(recovered.state.workflowId)!;
    expect(replayEvents(stored.events)).toEqual(recovered.state);
  });

  it("records interruption without continuing when no raw result was stored", async () => {
    const created = createWorkflow(definition(), at, "workflow-loop-recovery-start");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: created.events, snapshot: created.state });
    let state = await completeImplement(store, created.state);
    const started = await applyCommandAndCommit(store, state, {
      type: "start-check",
      nodeId: "test",
      attemptId: "test-1",
      commandId: "test-start",
      at,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    state = started.value.state;

    const recovered = await recoverInterruptedChecks({ state, store, at: recoveredAt });
    expect(recovered.state.runtime.nodes.test?.status).toBe("failed");
    expect(recovered.state.runtime.nodes.test?.attempts["test-1"]?.checkResult?.status).toBe("interrupted");
    expect(recovered.state.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 1 });
    expect(recovered.events.some((event) => event.type === "hypagraph.loop.evaluated")).toBe(false);
    expect(recovered.state.runtime.nodes.implement?.status).toBe("succeeded");
  });
});
''')

write("tests/pi-loop-check-repair.test.ts", r'''import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import type { PersistedEventBatch } from "../src/persistence/event-store.js";
import type { PersistedHypagraph } from "../src/domain/model.js";

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("M4 Slice 3 Pi check repair loop", () => {
  it("uses a failed command check to continue and a later pass to exit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "hypagraph-check-loop-"));
    workspaces.push(workspace);
    const tools = new Map<string, RegisteredTool>();
    const entries: Array<{ customType: string; data: unknown }> = [];
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => tools.set(tool.name, tool)),
      appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ customType, data })),
    } as unknown as ExtensionAPI;
    hypagraphExtension(pi);

    const ctx = {
      cwd: workspace,
      sessionManager: { getBranch: () => [] },
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    };
    const signal = new AbortController().signal;
    const define = tools.get("hypagraph_define")!;
    const transition = tools.get("hypagraph_transition")!;
    const runCheck = tools.get("hypagraph_run_check")!;
    const call = (id: string, params: Record<string, unknown>) => transition.execute(id, params, signal, undefined, ctx);

    await define.execute("define", {
      title: "Pi command-check repair loop",
      goal: "Fail once and pass after the repair marker exists",
      nodes: [
        { id: "implement", title: "Implement", requires: ["test"], acceptance: [] },
        {
          id: "test",
          title: "Test",
          kind: "check",
          requires: ["implement"],
          acceptance: [],
          produces: [{ name: "tests.passed", type: "boolean", required: true }],
          check: {
            kind: "command",
            command: process.execPath,
            arguments: ["-e", "process.exit(require('node:fs').existsSync('repair.complete') ? 0 : 1)"],
            timeoutMs: 10_000,
            publish: [{ source: "passed", fact: "tests.passed" }],
          },
        },
        { id: "document", title: "Document", requires: ["test"], acceptance: [] },
      ],
      loops: [{
        id: "repair",
        nodes: ["implement", "test"],
        entry: "implement",
        evaluateAfter: "test",
        feedbackEdges: [{ from: "test", to: "implement" }],
        successWhen: {
          kind: "compare",
          left: { kind: "fact", name: "tests.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        maxIterations: 3,
      }],
      policy: { mode: "guided", requireEvidence: false },
    }, signal, undefined, ctx);

    await call("start-implement-1", { action: "start", nodeId: "implement" });
    await call("submit-implement-1", { action: "submit", nodeId: "implement", evidence: [] });
    await call("verify-implement-1", { action: "verify", nodeId: "implement", passed: true });
    const firstResult = await runCheck.execute("run-test-1", { nodeId: "test" }, signal, undefined, ctx);
    const first = firstResult.details.hypagraph as PersistedHypagraph;

    expect(first.result.status).toBe("failed");
    expect(first.snapshot.runtime.loops.repair).toMatchObject({ status: "running", currentIteration: 2, lastSuccess: false });
    expect(first.snapshot.runtime.nodes.implement?.status).toBe("ready");
    expect(first.snapshot.runtime.nodes.test?.attempts[first.commands.find((command) => command.type === "start-check")!.attemptId!]).toMatchObject({ status: "failed", iteration: 1 });
    const continuationBatch = entries
      .map((entry) => entry.data as PersistedEventBatch)
      .find((batch) => Array.isArray(batch.events) && batch.events.some((event) => event.type === "hypagraph.loop.evaluated" && event.data.decision === "continue"));
    expect(continuationBatch?.events.map((event) => event.type)).toEqual([
      "hypagraph.verification.started",
      "hypagraph.verification.failed",
      "hypagraph.loop.evaluated",
      "hypagraph.loop.iteration-started",
      "hypagraph.node.ready",
    ]);

    await writeFile(join(workspace, "repair.complete"), "complete\n");
    await call("start-implement-2", { action: "start", nodeId: "implement" });
    await call("submit-implement-2", { action: "submit", nodeId: "implement", evidence: [] });
    await call("verify-implement-2", { action: "verify", nodeId: "implement", passed: true });
    const secondResult = await runCheck.execute("run-test-2", { nodeId: "test" }, signal, undefined, ctx);
    const second = secondResult.details.hypagraph as PersistedHypagraph;

    expect(second.result.status).toBe("passed");
    expect(second.snapshot.runtime.loops.repair).toMatchObject({ status: "succeeded", currentIteration: 2, lastSuccess: true, exitReason: "success" });
    expect(second.snapshot.runtime.nodes.document?.status).toBe("ready");
    const attempts = Object.values(second.snapshot.runtime.nodes.test!.attempts);
    expect(attempts.map((attempt) => attempt.iteration).sort()).toEqual([1, 2]);
    expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(2);
  });
});
''')

replace_once(
    "docs/m4-vertical-slice-plan.md",
    '''### Slice 3 - Run a check-driven repair loop

#### User result
''',
    '''### Slice 3 - Run a check-driven repair loop

- Status: implemented

#### User result
''',
)

replace_once(
    "README.md",
    "M4 is the selected next milestone. Slices 1 and 2 add typed loop success conditions, structured iteration-region validation, schema version 3, canonical loop runtime, deterministic feedback continuation, and isolated multi-iteration task loops. Later slices add check-driven continuation, hard iteration limits, progress and patience rules, recovery hardening, and the complete Pi loop surface. M3.1 parser adapters are deferred until after v0.5.",
    "M4 is the selected next milestone. Slices 1 to 3 add typed loop success conditions, structured iteration-region validation, schema version 3, deterministic feedback continuation, isolated multi-iteration task loops, and check-driven repair loops. A failed evaluation check can publish a valid false observation and start the next iteration. Later slices add hard iteration limits, progress and patience rules, recovery hardening, and the complete Pi loop surface. M3.1 parser adapters are deferred until after v0.5.",
)

replace_once(
    "skills/hypagraph/SKILL.md",
    "M4 Slices 1 and 2 execute task-based loops across multiple isolated iterations. When a verified evaluation produces a false success condition, Hypagraph follows the declared feedback edge, clears current loop facts and routes, keeps prior attempts and evidence, and makes the entry ready for the next iteration. Do not select a feedback route manually. Check-driven continuation, hard-limit failure, and patience are not active yet.",
    "M4 Slices 1 to 3 execute task-based and command-check repair loops across isolated iterations. A failed evaluation check can continue the loop only when the raw result status is `failed`, normalization succeeded, and all required facts were published. Cancellation, interruption, timeout, executor error, or a failed non-evaluation check does not continue automatically. A check retry stays in the current iteration. A loop continuation creates a new iteration and a new attempt ID. Do not select a feedback route manually. Hard-limit failure and patience are not active yet.",
)

replace_once(
    "docs/event-runtime.md",
    '''The default stdout and stderr capture limit is 1,048,576 bytes for each stream.
''',
    '''The default stdout and stderr capture limit is 1,048,576 bytes for each stream.

## Failed check observations

A command check at the declared loop evaluation node can be a valid failed observation.

Hypagraph continues the loop only when:

- the raw check result status is `failed`;
- result normalization succeeded;
- all required facts from that check attempt are present and valid;
- the typed loop success condition is false;
- another iteration is available.

The verification event remains `hypagraph.verification.failed`. The same durable verification batch stores the loop evaluation, the `continue` decision, the next iteration start, and entry readiness. A true success condition cannot complete a loop when verification failed.

A cancelled, interrupted, timed-out, or executor-error result does not continue the loop. A failed check that is not the evaluation node does not continue the loop. Check retry stays in the same iteration. Loop continuation starts a new iteration and requires a new attempt ID.
''',
)

for path in [
    "src/domain/reducer.ts",
    "tests/loop-check-repair.test.ts",
    "tests/loop-check-recovery.test.ts",
    "tests/pi-loop-check-repair.test.ts",
    "docs/m4-vertical-slice-plan.md",
    "README.md",
    "skills/hypagraph/SKILL.md",
    "docs/event-runtime.md",
]:
    data = Path(path).read_bytes()
    if b"\x00" in data:
        raise SystemExit(f"NUL control character found in {path}")
