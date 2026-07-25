import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { HYPAGRAPH_EVENT_BATCH_TYPE } from "../src/persistence/event-store.js";
import { projectHypagoalSurface, renderHypagoalStatus, TURN_ACCOUNTING_NOTE } from "../src/ui/hypagoal-surface.js";
import { renderWorkflow } from "../src/ui/format.js";
import type { HypagraphState } from "../src/domain/model.js";
import { selectGoalContinuation } from "../src/domain/goal-continuation.js";

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

const objective = "Complete one task and let Hypagraph run every deterministic action.";

const definition = () => ({
  title: "Deterministic remainder",
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
        onTrue: ["confirm"],
        onFalse: ["repair"],
      },
    },
    {
      id: "confirm",
      title: "Confirm the change",
      kind: "check",
      requires: ["route"],
      acceptance: [],
      produces: [{ name: "confirm.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: process.execPath,
        arguments: ["-e", ""],
        timeoutMs: 30_000,
        publish: [{ source: "passed", fact: "confirm.passed" }],
      },
    },
    { id: "repair", title: "Repair the change", requires: ["route"], acceptance: [] },
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

const latestState = (value: ReturnType<typeof harness>): any => value.entries
  .filter((entry) => entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE)
  .at(-1)?.data.snapshot;

const prompts = (value: ReturnType<typeof harness>): string[] => value.sendUserMessage.mock.calls
  .map((call) => String(call[0]))
  .filter((prompt) => prompt.startsWith("Hypagraph automatic continuation."));

const notifications = (value: ReturnType<typeof harness>): string[] => value.notify.mock.calls
  .map((call) => String(call[0]));

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

const deliver = async (value: ReturnType<typeof harness>, prompt: string): Promise<string> => {
  const results = await invoke(value, "before_agent_start", {
    type: "before_agent_start",
    prompt,
    systemPrompt: "base-system",
    systemPromptOptions: {},
  });
  return String(results.find((result) => result?.systemPrompt)?.systemPrompt ?? "");
};

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

const start = async (value: ReturnType<typeof harness>, budget?: { maximumTurns?: number; maximumTokens?: number }) =>
  value.tools.get("hypagoal_start")!.execute(
    "create-root",
    { objective, definition: definition(), ...(budget ? { budget } : {}) },
    undefined,
    undefined,
    value.ctx,
  );

/** A graph with no task node. Only the loop iteration limit can stop it. */
const deterministicOnlyDefinition = () => ({
  title: "Deterministic iteration region",
  goal: "Stop a graph which has no task node",
  nodes: [
    {
      id: "probe",
      title: "Probe the repository",
      kind: "check",
      requires: ["assess"],
      acceptance: [],
      produces: [{ name: "probe.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: process.execPath,
        arguments: ["-e", ""],
        timeoutMs: 30_000,
        publish: [{ source: "passed", fact: "probe.passed" }],
      },
    },
    {
      id: "assess",
      title: "Assess the probe",
      kind: "check",
      requires: ["probe"],
      acceptance: [],
      produces: [{ name: "assess.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: process.execPath,
        arguments: ["-e", "process.exit(1)"],
        timeoutMs: 30_000,
        publish: [{ source: "passed", fact: "assess.passed" }],
      },
    },
  ],
  loops: [{
    id: "watch",
    nodes: ["probe", "assess"],
    entry: "probe",
    evaluateAfter: "assess",
    feedbackEdges: [{ from: "assess", to: "probe" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "assess.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 2,
    failurePolicy: "record-and-continue",
  }],
  policy: { mode: "guided", requireEvidence: false },
});

describe("M6A Slice 4 turn accounting and budgets", () => {
  it("stops a graph which has no task node at the loop iteration limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6a-bound-"));
    roots.push(root);
    const value = harness(root);
    await value.tools.get("hypagoal_start")!.execute(
      "create-root",
      { objective, definition: deterministicOnlyDefinition() },
      undefined,
      undefined,
      value.ctx,
    );
    await agentEnd(value);

    const state = latestState(value) as HypagraphState;
    expect(prompts(value)).toEqual([]);
    expect(state.goal?.budget.consumedTurns).toBe(0);
    expect(state.runtime.loops.watch).toMatchObject({
      status: "failed",
      currentIteration: 2,
      exitReason: "max_iterations",
    });
    expect(state.goal?.schedulerOrdinal).toBe(4);
    expect(["completed", "failed", "blocked"]).toContain(state.phase);
    expect(selectGoalContinuation(state).kind.startsWith("stop-")).toBe(true);
  }, 30_000);

  it("charges one model turn and completes the deterministic remainder", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6a-accounting-"));
    roots.push(root);
    const value = harness(root);
    await start(value);
    await agentEnd(value);

    const queued = prompts(value);
    expect(queued).toHaveLength(1);
    const system = await deliver(value, queued[0]!);
    expect(system).toContain("start task 'plan'");
    await completeTask(value, "plan");
    await agentEnd(value);

    const state = latestState(value);
    // Two checks and one gate ran without a model turn.
    expect(prompts(value)).toHaveLength(1);
    expect(state.goal.budget.consumedTurns).toBe(1);
    expect(state.goal.budget.consumedTokens.totalTokens).toBe(7);
    expect(state.goal.schedulerOrdinal).toBe(4);
    expect(state.runtime.nodes.verify.status).toBe("succeeded");
    expect(state.runtime.nodes.confirm.status).toBe("succeeded");
    expect(state.runtime.nodes.repair.status).toBe("skipped");
    expect(state.phase).toBe("completed");
    expect(state.goal.status).toBe("completed");

    // The model lane records its selection through the continuation-requested event.
    const selections = value.entries
      .filter((entry: any) => entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE)
      .flatMap((entry: any) => entry.data.events ?? [])
      .filter((event: any) => event.type === "hypagraph.action.selected"
        || event.type === "hypagraph.goal.continuation-requested")
      .map((event: any) => event.type === "hypagraph.action.selected"
        ? `${event.data.dispatch.lane}:${event.data.dispatch.action.kind}`
        : `model:${event.data.action.kind}`);
    expect(selections).toEqual([
      "model:start-ready-task",
      "deterministic:run-ready-check",
      "deterministic:evaluate-ready-gate",
      "deterministic:run-ready-check",
    ]);
  }, 30_000);

  it("does not report a no-progress stop when a deterministic dispatch follows the model turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6a-progress-"));
    roots.push(root);
    const value = harness(root);
    await start(value);
    await agentEnd(value);

    await deliver(value, prompts(value)[0]!);
    await completeTask(value, "plan");
    await agentEnd(value);

    expect(notifications(value).some((message) => message.includes("made no canonical progress"))).toBe(false);
    expect(latestState(value).goal.status).toBe("completed");
  }, 30_000);

  it("reports a no-progress stop when a delivered model turn changes nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6a-no-progress-"));
    roots.push(root);
    const value = harness(root);
    await start(value);
    await agentEnd(value);

    await deliver(value, prompts(value)[0]!);
    await agentEnd(value);

    expect(notifications(value).some((message) => message.includes("made no canonical progress"))).toBe(true);
    expect(prompts(value)).toHaveLength(1);
    expect(latestState(value).runtime.nodes.verify.status).toBe("pending");
  }, 30_000);

  it("stops every lane when the model-turn budget is exhausted", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6a-budget-"));
    roots.push(root);
    const value = harness(root);
    await start(value, { maximumTurns: 1 });
    await agentEnd(value);

    await deliver(value, prompts(value)[0]!);
    await completeTask(value, "plan");
    await agentEnd(value);

    const state = latestState(value) as HypagraphState;
    expect(state.goal?.status).toBe("budget_limited");
    expect(state.goal?.budget.consumedTurns).toBe(1);
    expect(state.runtime.nodes.verify?.status).toBe("ready");
    expect(state.runtime.nodes.confirm?.status).toBe("pending");
    // A budget stop is the recorded decision. The deterministic remainder does not run.
    expect(state.goal?.schedulerOrdinal).toBe(1);
    expect(prompts(value)).toHaveLength(1);

    const surface = projectHypagoalSurface(state)!;
    expect(surface.stopCode).toBe("turn_limit");
    expect(surface.dispatch).toMatchObject({ scheduledActions: 1, chargedModelTurns: 1 });
    expect(notifications(value).some((message) => message.includes("budget_limited"))).toBe(true);
  }, 30_000);

  it("explains the turn meaning in the status surface and the model-visible view", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6a-surface-"));
    roots.push(root);
    const value = harness(root);
    await start(value, { maximumTurns: 6, maximumTokens: 900 });
    await agentEnd(value);
    await deliver(value, prompts(value)[0]!);
    await completeTask(value, "plan");
    await agentEnd(value);

    const state = latestState(value) as HypagraphState;
    const surface = projectHypagoalSurface(state)!;
    expect(surface.dispatch.turnAccounting).toBe(TURN_ACCOUNTING_NOTE);
    expect(surface.dispatch.scheduledActions).toBe(4);
    expect(surface.dispatch.chargedModelTurns).toBe(1);
    expect(surface.dispatch.lastOutcome).toMatchObject({
      lane: "deterministic",
      status: "completed",
      schedulerOrdinal: 4,
      action: "run check 'confirm'",
    });

    const wide = renderHypagoalStatus(state, 110);
    expect(wide).toContain("Scheduled actions: 4; charged model turns 1");
    expect(wide).toContain("Turn accounting: Consumed turns count model turns only.");
    expect(wide).toContain("Last action: deterministic lane; completed");
    expect(wide.split("\n").every((line) => line.length <= 110)).toBe(true);

    const narrow = renderHypagoalStatus(state, 60);
    expect(narrow).toContain("Actions: 4 scheduled · 1 model turns charged");
    expect(narrow.split("\n").every((line) => line.length <= 60)).toBe(true);

    const modelVisible = renderWorkflow(state);
    expect(modelVisible).toContain("Goal budget: model turns 1/6");
    expect(modelVisible).toContain("Scheduled actions: 4");
    expect(modelVisible).toContain(`Turn accounting: ${TURN_ACCOUNTING_NOTE}`);
  }, 30_000);
});
