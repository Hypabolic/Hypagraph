import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveCheckExecutionRegistry } from "../src/checks/active-executions.js";
import { interruptPendingActionDispatch } from "../src/domain/action-dispatch-recovery.js";
import { isReadyCheckDecision, type ReadyCheckDecision } from "../src/domain/deterministic-check-dispatch.js";
import { isRunnableGoalContinuation, selectGoalContinuation } from "../src/domain/goal-continuation.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { CheckExecutor, CheckResult, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { replayEvents } from "../src/domain/projection.js";
import hypagraphExtension from "../src/extension.js";
import { runDeterministicCheckDispatch } from "../src/pi/deterministic-check-runner.js";
import { HYPAGRAPH_EVENT_BATCH_TYPE, InMemoryWorkflowEventStore } from "../src/persistence/event-store.js";
import { PiSessionWorkflowEventStore } from "../src/persistence/pi-session-store.js";
import { restoreLatestSession } from "../src/persistence/session-rebuild.js";

interface ToolDefinition {
  name: string;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: any,
  ) => Promise<any>;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const objective = "Run one check and one gate after a single task.";

const definition = () => ({
  title: "Restore and replay",
  goal: objective,
  nodes: [
    { id: "plan", title: "Plan the change", requires: [], acceptance: [] },
    {
      id: "verify",
      title: "Verify the change",
      kind: "check",
      requires: ["plan"],
      acceptance: [],
      produces: [{ name: "verify.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: process.execPath,
        arguments: ["-e", ""],
        timeoutMs: 30_000,
        publish: [{ source: "passed", fact: "verify.passed" }],
      },
    },
    {
      id: "route",
      title: "Select the route",
      kind: "gate",
      requires: ["verify"],
      acceptance: [],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "verify.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["ship"],
        onFalse: ["repair"],
      },
    },
    { id: "ship", title: "Ship the change", requires: ["route"], acceptance: [] },
    { id: "repair", title: "Repair the change", requires: ["route"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

/** A workflow whose first runnable action is a check, so restore has deterministic work waiting. */
const checkFirstDefinition = () => ({
  title: "Check first",
  goal: "Run one ready check without a task",
  nodes: [
    {
      id: "verify",
      title: "Verify the repository",
      kind: "check",
      requires: [],
      acceptance: [],
      produces: [{ name: "verify.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: process.execPath,
        arguments: ["-e", ""],
        timeoutMs: 30_000,
        publish: [{ source: "passed", fact: "verify.passed" }],
      },
    },
    { id: "ship", title: "Ship the verified repository", requires: ["verify"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const harness = (cwd: string) => {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: any[] = [];
  const sendUserMessage = vi.fn();
  const notify = vi.fn();
  let activeTools = ["read", "write", "edit"];
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    appendEntry: vi.fn((customType: string, data?: unknown) => entries.push({ type: "custom", customType, data })),
    sendUserMessage,
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((next: string[]) => { activeTools = [...next]; }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      confirm: vi.fn().mockResolvedValue(true),
      notify,
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: { getBranch: () => entries },
  };
  hypagraphExtension(pi);
  return { tools, handlers, entries, sendUserMessage, notify, ctx };
};

const invoke = async (value: ReturnType<typeof harness>, name: string, event: any) => {
  const results = [];
  for (const handler of value.handlers.get(name) ?? []) results.push(await handler(event, value.ctx));
  return results;
};

const batches = (value: ReturnType<typeof harness>): any[] => value.entries
  .filter((entry) => entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE);

const latestState = (value: ReturnType<typeof harness>): any => batches(value).at(-1)?.data.snapshot;

const allEvents = (value: ReturnType<typeof harness>): any[] => batches(value)
  .flatMap((entry) => entry.data.events ?? []);

const prompts = (value: ReturnType<typeof harness>): string[] => value.sendUserMessage.mock.calls
  .map((call) => String(call[0]))
  .filter((prompt) => prompt.startsWith("Hypagraph automatic continuation."));

const agentEnd = async (value: ReturnType<typeof harness>) => invoke(value, "agent_end", {
  type: "agent_end",
  messages: [{
    role: "assistant",
    content: [],
    usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7 },
    stopReason: "stop",
    timestamp: Date.now(),
  }],
});

const deliver = async (value: ReturnType<typeof harness>, prompt: string) => invoke(value, "before_agent_start", {
  type: "before_agent_start",
  prompt,
  systemPrompt: "base-system",
  systemPromptOptions: {},
});

const transition = async (
  value: ReturnType<typeof harness>,
  nodeId: string,
  action: string,
  extra: Record<string, unknown> = {},
) => value.tools.get("hypagraph_transition")!.execute(
  `${nodeId}-${action}`,
  { nodeId, action, ...extra },
  undefined,
  undefined,
  value.ctx,
);

const completeTask = async (value: ReturnType<typeof harness>, nodeId: string) => {
  await transition(value, nodeId, "start");
  await transition(value, nodeId, "submit", { evidence: [] });
  await transition(value, nodeId, "verify", { passed: true });
};

const start = async (value: ReturnType<typeof harness>, source: unknown = definition()) =>
  value.tools.get("hypagoal_start")!.execute(
    "create-root",
    { objective, definition: source },
    undefined,
    undefined,
    value.ctx,
  );

const at = "2026-07-25T14:00:00.000Z";

const runnerFixture = () => {
  const source: HypagraphDefinition = {
    title: "Pending dispatch recovery",
    goal: "Close a lost deterministic dispatch",
    nodes: [{
      id: "tests",
      title: "Run tests",
      kind: "check",
      requires: [],
      acceptance: [],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "npm",
        arguments: ["test"],
        timeoutMs: 60_000,
        publish: [{ source: "passed", fact: "tests.passed" }],
      },
    }, { id: "ship", title: "Ship the change", requires: ["tests"], acceptance: [] }],
    loops: [],
    policy: { mode: "guided", requireEvidence: false },
  };
  const created = createHypagoalWorkflow(source, {
    workflowId: "restore-replay-workflow",
    goalId: "restore-replay-goal",
    goalWorkflowId: "restore-replay-workflow",
    at,
  });
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  const store = new InMemoryWorkflowEventStore();
  store.seed({ events: created.events, snapshot: created.state });
  return { created, store };
};

const readyCheck = (state: HypagraphState): ReadyCheckDecision => {
  const decision = selectGoalContinuation(state);
  if (!isRunnableGoalContinuation(decision) || !isReadyCheckDecision(decision)) {
    throw new Error(`Expected a ready check, received '${decision.kind}'.`);
  }
  return decision;
};

const passedResult = (attemptId: string): CheckResult => ({
  checkKind: "command",
  attemptId,
  startedAt: at,
  completedAt: "2026-07-25T14:00:02.000Z",
  status: "passed",
  exitCode: 0,
  facts: [],
  evidence: [],
});

/** A passed result which uses host time, so restored goal timestamps stay ordered. */
const freshPassedResult = (attemptId: string): CheckResult => {
  const now = new Date().toISOString();
  return {
    checkKind: "command",
    attemptId,
    startedAt: now,
    completedAt: now,
    status: "passed",
    exitCode: 0,
    facts: [],
    evidence: [],
  };
};

const executorFor = (factory: (attemptId: string) => CheckResult): CheckExecutor => ({
  execute: vi.fn(async (request) => factory(request.attemptId)),
});

describe("M6A Slice 5 restore, reload, and replay", () => {
  it("rebuilds state on reload and runs no deterministic action", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6a-restore-"));
    roots.push(root);
    const value = harness(root);
    await start(value, checkFirstDefinition());
    expect(latestState(value).runtime.nodes.verify.status).toBe("ready");

    await invoke(value, "session_start", { type: "session_start", reason: "reload" });

    const state = latestState(value);
    expect(state.goal).toMatchObject({ status: "paused", pauseCause: "session_reload" });
    expect(state.runtime.nodes.verify.status).toBe("ready");
    expect(state.goal.schedulerOrdinal).toBe(0);
    expect(allEvents(value).some((event) => event.type === "hypagraph.action.selected")).toBe(false);
    expect(allEvents(value).some((event) => event.type === "hypagraph.check.started")).toBe(false);
    expect(prompts(value)).toEqual([]);
  }, 30_000);

  it("pauses the goal on a branch change and runs no deterministic action", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6a-branch-"));
    roots.push(root);
    const value = harness(root);
    await start(value, checkFirstDefinition());

    await invoke(value, "session_tree", { type: "session_tree", reason: "branch" });

    const state = latestState(value);
    expect(state.goal).toMatchObject({ status: "paused", pauseCause: "branch_change" });
    expect(state.runtime.nodes.verify.status).toBe("ready");
    expect(allEvents(value).some((event) => event.type === "hypagraph.action.selected")).toBe(false);
    expect(prompts(value)).toEqual([]);
  }, 30_000);

  it("replays a mixed model and deterministic run to the same state, routes, and stop decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6a-replay-"));
    roots.push(root);
    const value = harness(root);
    await start(value);
    await agentEnd(value);
    await deliver(value, prompts(value)[0]!);
    await completeTask(value, "plan");
    await agentEnd(value);
    await deliver(value, prompts(value)[1]!);
    await completeTask(value, "ship");
    await agentEnd(value);

    const state = latestState(value) as HypagraphState;
    expect(state.phase).toBe("completed");
    expect(state.goal?.status).toBe("completed");
    expect(state.goal?.budget.consumedTurns).toBe(2);
    expect(state.goal?.schedulerOrdinal).toBe(4);

    const events = allEvents(value);
    const laneTypes = events
      .map((event) => event.type)
      .filter((type: string) => type.startsWith("hypagraph.action.") || type === "hypagraph.goal.continuation-requested");
    expect(laneTypes).toEqual([
      "hypagraph.goal.continuation-requested",
      "hypagraph.action.selected",
      "hypagraph.action.dispatched",
      "hypagraph.action.completed",
      "hypagraph.action.selected",
      "hypagraph.action.dispatched",
      "hypagraph.action.completed",
      "hypagraph.goal.continuation-requested",
    ]);

    const replayed = replayEvents(events);
    expect(replayed).toEqual(state);
    expect(replayed.runtime.routes).toEqual(state.runtime.routes);
    expect(replayed.runtime.routes.route).toMatchObject({ outcomeId: "true", targetNodeIds: ["ship"] });
    expect(selectGoalContinuation(replayed)).toMatchObject({ kind: "stop-completed" });
    expect(selectGoalContinuation(replayed)).toEqual(selectGoalContinuation(state));

    const restored = restoreLatestSession(value.entries)!;
    expect(restored.snapshot).toEqual(state);
  }, 30_000);

  it("keeps a pending deterministic dispatch when the branch generation changes", async () => {
    const value = runnerFixture();
    const dispatch = await runDeterministicCheckDispatch({
      state: value.created.state,
      decision: readyCheck(value.created.state),
      dispatchId: "lost-dispatch",
      attemptId: "lost-attempt",
      at,
      store: value.store,
      executor: executorFor(passedResult),
      registry: new ActiveCheckExecutionRegistry(),
      stale: () => true,
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    expect(dispatch.stale).toBe(true);
    const stored = value.store.read(value.created.state.workflowId)!;
    expect(stored.snapshot.goal?.actionDispatch?.pending).toMatchObject({
      dispatchId: "lost-dispatch",
      lane: "deterministic",
      status: "dispatched",
    });
    // A pending dispatch blocks a later selection until restore closes it.
    const blocked = await runDeterministicCheckDispatch({
      state: stored.snapshot,
      decision: readyCheck(value.created.state),
      dispatchId: "second-dispatch",
      attemptId: "second-attempt",
      at,
      store: value.store,
      executor: executorFor(passedResult),
      registry: new ActiveCheckExecutionRegistry(),
    });
    expect(blocked).toMatchObject({ ok: false, diagnostics: [{ code: "action_dispatch_pending" }] });
  });

  it("closes a lost deterministic dispatch and restores a dispatchable goal", async () => {
    const value = runnerFixture();
    const dispatch = await runDeterministicCheckDispatch({
      state: value.created.state,
      decision: readyCheck(value.created.state),
      dispatchId: "lost-dispatch",
      attemptId: "lost-attempt",
      at,
      store: value.store,
      executor: executorFor(passedResult),
      registry: new ActiveCheckExecutionRegistry(),
      stale: () => true,
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    const stored = value.store.read(value.created.state.workflowId)!;
    const closed = interruptPendingActionDispatch(stored.snapshot, {
      commandId: "interrupt-lost-dispatch",
      reason: "The Pi session reloaded before the action dispatch completed.",
      at: "2026-07-25T14:05:00.000Z",
    });
    if (!closed.ok || !closed.interrupted) throw new Error("The pending dispatch was not closed.");

    expect(closed.dispatchId).toBe("lost-dispatch");
    expect(closed.state.goal?.actionDispatch?.pending).toBeUndefined();
    expect(closed.state.goal?.actionDispatch?.lastOutcome).toMatchObject({
      dispatchId: "lost-dispatch",
      lane: "deterministic",
      status: "interrupted",
    });
    expect(closed.state.goal?.budget.consumedTurns).toBe(0);
    expect(replayEvents([...value.created.events, ...dispatch.events, ...closed.events])).toEqual(closed.state);
  });

  it("does not close a pending model dispatch", () => {
    const value = runnerFixture();
    const unchanged = interruptPendingActionDispatch(value.created.state, {
      commandId: "interrupt-nothing",
      reason: "The Pi session reloaded.",
      at,
    });
    expect(unchanged).toMatchObject({ ok: true, interrupted: false, events: [] });
  });

  it("closes a lost deterministic dispatch through the reload path", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6a-reload-dispatch-"));
    roots.push(root);
    const value = harness(root);
    await start(value, checkFirstDefinition());

    // Simulate a host which stored the dispatch boundary and then stopped.
    const snapshot = latestState(value) as HypagraphState;
    const decision = readyCheck(snapshot);
    const store = new PiSessionWorkflowEventStore({
      appendEntry: (customType: string, data?: unknown) => value.entries.push({ type: "custom", customType, data }),
    });
    store.synchronize({ events: allEvents(value), snapshot });
    const dispatch = await runDeterministicCheckDispatch({
      state: snapshot,
      decision,
      dispatchId: "reload-lost-dispatch",
      attemptId: "reload-lost-attempt",
      at: new Date().toISOString(),
      store,
      executor: executorFor(freshPassedResult),
      registry: new ActiveCheckExecutionRegistry(),
      stale: () => true,
    });
    if (!dispatch.ok) throw new Error(JSON.stringify(dispatch.diagnostics));

    await invoke(value, "session_start", { type: "session_start", reason: "reload" });

    const state = latestState(value);
    expect(state.goal.actionDispatch.pending).toBeUndefined();
    expect(state.goal.actionDispatch.lastOutcome).toMatchObject({
      dispatchId: "reload-lost-dispatch",
      status: "interrupted",
    });
    expect(state.goal.status).toBe("paused");
    expect(replayEvents(allEvents(value))).toEqual(state);
  }, 30_000);
});
