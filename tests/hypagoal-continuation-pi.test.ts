import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { selectGoalContinuation, isRunnableGoalContinuation } from "../src/domain/goal-continuation.js";
import { handleCommand } from "../src/domain/reducer.js";
import { HYPAGRAPH_EVENT_BATCH_TYPE } from "../src/persistence/event-store.js";
import { createPendingGoalContinuation, validatePendingGoalContinuation } from "../src/pi/hypagoal-continuation.js";

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

interface CommandDefinition {
  handler: (args: string, ctx: any) => Promise<void>;
}

const objective = "Complete a routed feature and one independent documentation task.";

const rootInput = (creationRequest?: unknown, budget?: { maximumTurns?: number; maximumTokens?: number }) => ({
  objective,
  definition: {
    title: "Routed feature with independent work",
    goal: "The model cannot replace the objective.",
    nodes: [
      {
        id: "implement",
        title: "Implement the feature",
        requires: [],
        acceptance: [],
        produces: [{ name: "route.use-primary", type: "boolean", required: true }],
      },
      {
        id: "route",
        title: "Select the route",
        kind: "gate",
        requires: ["implement"],
        acceptance: [],
        gate: {
          condition: {
            kind: "compare",
            left: { kind: "fact", name: "route.use-primary" },
            operator: "eq",
            right: { kind: "literal", value: true },
          },
          onTrue: ["finish-primary"],
          onFalse: ["finish-alternate"],
        },
      },
      { id: "finish-primary", title: "Finish the primary route", requires: ["route"], acceptance: [] },
      { id: "finish-alternate", title: "Finish the alternate route", requires: ["route"], acceptance: [] },
      { id: "document", title: "Document independently", requires: [], acceptance: [] },
    ],
    loops: [],
    policy: { mode: "guided", requireEvidence: false },
  },
  ...(budget === undefined ? {} : { budget }),
  ...(creationRequest === undefined ? {} : { creationRequest }),
});

const harness = () => {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: any[] = [];
  const sendUserMessage = vi.fn();
  let activeTools = ["read", "write", "edit"];
  const setActiveTools = vi.fn((tools: string[]) => { activeTools = [...tools]; });
  const notify = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: CommandDefinition) => commands.set(name, command)),
    appendEntry: vi.fn((customType: string, data?: unknown) => entries.push({ type: "custom", customType, data })),
    sendUserMessage,
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
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
  return { tools, commands, handlers, entries, sendUserMessage, setActiveTools, notify, ctx };
};

const creationRequestFromPrompt = (prompt: string): unknown => {
  const match = prompt.match(/Use this exact creation request identity without changing any field:\n(\{[\s\S]*?\})\n\nCall hypagoal_start/);
  if (!match?.[1]) throw new Error("The authoring prompt did not contain a creation request identity.");
  return JSON.parse(match[1]);
};

const invoke = async (handlers: Map<string, Array<(event: any, ctx: any) => any>>, name: string, event: any, ctx: any) => {
  const values = [];
  for (const handler of handlers.get(name) ?? []) values.push(await handler(event, ctx));
  return values;
};

const beforeAgentStart = async (value: ReturnType<typeof harness>, prompt: string): Promise<string> => {
  const results = await invoke(value.handlers, "before_agent_start", {
    type: "before_agent_start",
    prompt,
    systemPrompt: "base-system",
    systemPromptOptions: {},
  }, value.ctx);
  return String(results.find((item) => item?.systemPrompt)?.systemPrompt ?? "");
};

const usageMessage = (tokens = 15) => ({
  role: "assistant",
  content: [],
  usage: { input: tokens - 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: Date.now(),
});

const agentEnd = async (value: ReturnType<typeof harness>, messages: unknown[] = [usageMessage()]) => {
  await invoke(value.handlers, "agent_end", { type: "agent_end", messages }, value.ctx);
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

const completeTask = async (
  value: ReturnType<typeof harness>,
  nodeId: string,
  facts?: Array<{ name: string; type: string; value: unknown }>,
) => {
  await transition(value, nodeId, "start");
  if (facts) await transition(value, nodeId, "publish", { facts });
  await transition(value, nodeId, "submit", { evidence: [] });
  await transition(value, nodeId, "verify", { passed: true });
};

const createRoot = async (value: ReturnType<typeof harness>, throughCommand = false, budget?: { maximumTurns?: number; maximumTokens?: number }) => {
  let creationRequest: unknown;
  if (throughCommand) {
    await value.commands.get("hypagoal")!.handler(objective, value.ctx);
    creationRequest = creationRequestFromPrompt(String(value.sendUserMessage.mock.calls.at(-1)?.[0]));
  }
  return value.tools.get("hypagoal_start")!.execute(
    "create-root",
    rootInput(creationRequest, budget),
    undefined,
    undefined,
    value.ctx,
  );
};

const continuationPrompts = (value: ReturnType<typeof harness>): string[] =>
  value.sendUserMessage.mock.calls.map((call) => String(call[0])).filter((prompt) => prompt.startsWith("Hypagraph automatic continuation."));

describe("Hypagoal Pi continuation", () => {
  it("drives a routed graph and interleaves the independent component", async () => {
    const value = harness();
    await createRoot(value, true);
    expect(continuationPrompts(value)).toEqual([]);

    await agentEnd(value);
    let prompts = continuationPrompts(value);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("start ready task 'implement'");
    let system = await beforeAgentStart(value, prompts[0]!);
    expect(system).toContain("HYPAGOAL CONTINUATION CONTROL");
    expect(system).toContain("Start task 'implement'");
    expect(value.setActiveTools).toHaveBeenCalledWith(expect.arrayContaining(["hypagraph_read", "hypagraph_transition"]));
    await completeTask(value, "implement", [{ name: "route.use-primary", type: "boolean", value: true }]);

    await agentEnd(value);
    expect(value.setActiveTools).toHaveBeenCalledWith(["read", "write", "edit"]);
    prompts = continuationPrompts(value);
    expect(prompts.at(-1)).toContain("start ready task 'document'");
    system = await beforeAgentStart(value, prompts.at(-1)!);
    expect(system).toContain("Start task 'document'");
    await completeTask(value, "document");

    await agentEnd(value);
    prompts = continuationPrompts(value);
    expect(prompts.at(-1)).toContain("evaluate ready gate 'route'");
    system = await beforeAgentStart(value, prompts.at(-1)!);
    expect(system).toContain("Evaluate gate 'route'");
    await transition(value, "route", "evaluate");

    await agentEnd(value);
    prompts = continuationPrompts(value);
    expect(prompts.at(-1)).toContain("start ready task 'finish-primary'");
    await beforeAgentStart(value, prompts.at(-1)!);
    await completeTask(value, "finish-primary");

    const countBeforeTerminal = continuationPrompts(value).length;
    await agentEnd(value);
    expect(continuationPrompts(value)).toHaveLength(countBeforeTerminal);

    const batches = value.entries.filter((entry) => entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE);
    const lastSnapshot = batches.at(-1)?.data.snapshot;
    expect(lastSnapshot.phase).toBe("completed");
    expect(lastSnapshot.goal.status).toBe("completed");
    expect(lastSnapshot.runtime.nodes.document.status).toBe("succeeded");
    expect(lastSnapshot.runtime.nodes["finish-alternate"].status).toBe("skipped");
    expect(lastSnapshot.goal.continuationOrdinal).toBe(4);
  });

  it("queues at most one state-bound continuation", async () => {
    const value = harness();
    await createRoot(value);
    await agentEnd(value);
    await agentEnd(value);

    expect(continuationPrompts(value)).toHaveLength(1);
    const continuationBatches = value.entries.filter((entry) =>
      entry.data?.events?.some((event: { type: string }) => event.type === "hypagraph.goal.continuation-requested"));
    expect(continuationBatches).toHaveLength(1);
  });

  it("rejects stale continuation delivery after canonical state changes", async () => {
    const value = harness();
    await createRoot(value);
    await agentEnd(value);
    const prompt = continuationPrompts(value)[0]!;

    await transition(value, "implement", "start");
    const system = await beforeAgentStart(value, prompt);
    expect(system).toContain("STALE HYPAGOAL CONTINUATION");
    expect(system).toContain("stale_continuation_sequence");
    const [blocked] = await invoke(value.handlers, "tool_call", {
      type: "tool_call",
      toolName: "hypagraph_transition",
      input: { nodeId: "implement", action: "submit" },
    }, value.ctx);
    expect(blocked).toMatchObject({ block: true });
  });

  it("gives a different user prompt priority over a queued continuation", async () => {
    const value = harness();
    await createRoot(value);
    await agentEnd(value);

    const system = await beforeAgentStart(value, "The user changed the immediate priority.");
    expect(system).not.toContain("HYPAGOAL CONTINUATION CONTROL");
    const count = continuationPrompts(value).length;
    await agentEnd(value);
    expect(continuationPrompts(value)).toHaveLength(count);
  });

  it("does not queue after an interactive streaming interruption", async () => {
    const value = harness();
    await createRoot(value);
    await invoke(value.handlers, "input", {
      type: "input",
      text: "Stop and answer this first.",
      source: "interactive",
      streamingBehavior: "steer",
    }, value.ctx);
    await agentEnd(value);
    expect(continuationPrompts(value)).toEqual([]);
  });

  it.each([
    ["sessionGeneration", 2, { sessionGeneration: 1, branchGeneration: 0 }, "stale_continuation_session"],
    ["branchGeneration", 2, { sessionGeneration: 0, branchGeneration: 1 }, "stale_continuation_branch"],
    ["revision", 2, { sessionGeneration: 0, branchGeneration: 0 }, "stale_continuation_revision"],
    ["snapshotHash", "different", { sessionGeneration: 0, branchGeneration: 0 }, "stale_continuation_snapshot"],
  ] as const)("rejects pending continuation when %s changes", async (field, changed, generations, code) => {
    const value = harness();
    await createRoot(value);
    const creationBatch = value.entries.filter((entry) => entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE).at(-1);
    const selectedState = structuredClone(creationBatch.data.snapshot);
    const action = selectGoalContinuation(selectedState);
    if (!isRunnableGoalContinuation(action)) throw new Error(`Unexpected decision: ${action.kind}`);
    const stored = handleCommand(selectedState, {
      type: "request-goal-continuation",
      goalId: action.goalId,
      workflowId: action.workflowId,
      expectedRevision: action.revision,
      expectedSequence: action.sequence,
      expectedSnapshotHash: action.snapshotHash,
      expectedContinuationOrdinal: action.continuationOrdinal,
      sessionGeneration: 0,
      branchGeneration: 0,
      action: { kind: action.kind, nodeId: action.nodeId },
      commandId: "pending-validation",
      at: "2026-07-24T08:30:00.000Z",
    });
    if (!stored.ok) throw new Error(JSON.stringify(stored.diagnostics));
    const pending = createPendingGoalContinuation(action, stored.state, { sessionGeneration: 0, branchGeneration: 0 }, "pending-validation");
    const changedState = structuredClone(stored.state);
    if (field === "revision") changedState.revision = changed as number;
    if (field === "snapshotHash") changedState.snapshotHash = changed as string;
    expect(validatePendingGoalContinuation(pending, changedState, generations)).toMatchObject({ ok: false, code });
  });

  it("does not queue work during restore", async () => {
    const value = harness();
    await createRoot(value);
    value.sendUserMessage.mockClear();
    await invoke(value.handlers, "session_start", { type: "session_start" }, value.ctx);
    expect(value.sendUserMessage).not.toHaveBeenCalled();
  });

  it("stops automatic continuation after the first charged turn reaches its limit", async () => {
    const value = harness();
    await createRoot(value, false, { maximumTurns: 1 });
    await agentEnd(value);
    const prompt = continuationPrompts(value)[0]!;
    await beforeAgentStart(value, prompt);
    await completeTask(value, "implement", [{ name: "route.use-primary", type: "boolean", value: true }]);
    await agentEnd(value);
    expect(continuationPrompts(value)).toHaveLength(1);
    const latest = value.entries.filter((entry) => entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE).at(-1)?.data.snapshot;
    expect(latest.goal).toMatchObject({ status: "budget_limited", budget: { consumedTurns: 1, stop: { reason: "turn_limit" } } });
    expect(latest.phase).toBe("running");
  });

  it("pauses when Pi usage metadata is missing", async () => {
    const value = harness();
    await createRoot(value, false, { maximumTokens: 100 });
    await agentEnd(value);
    await beforeAgentStart(value, continuationPrompts(value)[0]!);
    await agentEnd(value, []);
    const latest = value.entries.filter((entry) => entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE).at(-1)?.data.snapshot;
    expect(latest.goal).toMatchObject({ status: "paused", pauseCause: "usage_invalid" });
    expect(value.notify).toHaveBeenCalledWith(expect.stringContaining("usage could not be accounted"), "warning");
  });

  it("persists reload pause and queues work only after explicit resume", async () => {
    const value = harness();
    await createRoot(value);
    value.sendUserMessage.mockClear();
    await invoke(value.handlers, "session_start", { type: "session_start", reason: "reload" }, value.ctx);
    expect(value.sendUserMessage).not.toHaveBeenCalled();
    let latest = value.entries.filter((entry) => entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE).at(-1)?.data.snapshot;
    expect(latest.goal).toMatchObject({ status: "paused", pauseCause: "session_reload" });
    await value.commands.get("hypagoal")!.handler("resume", value.ctx);
    expect(continuationPrompts(value)).toHaveLength(1);
    latest = value.entries.filter((entry) => entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE).at(-1)?.data.snapshot;
    expect(latest.goal.status).toBe("active");
    expect(latest.goal.pendingContinuation).toBeDefined();
  });

  it("persists a branch-change pause without dispatching work", async () => {
    const value = harness();
    await createRoot(value);
    value.sendUserMessage.mockClear();
    await invoke(value.handlers, "session_tree", { type: "session_tree" }, value.ctx);
    expect(value.sendUserMessage).not.toHaveBeenCalled();
    const latest = value.entries.filter((entry) => entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE).at(-1)?.data.snapshot;
    expect(latest.goal).toMatchObject({ status: "paused", pauseCause: "branch_change" });
  });

  it("stops when a delivered continuation makes no canonical progress", async () => {
    const value = harness();
    await createRoot(value);
    await agentEnd(value);
    const prompt = continuationPrompts(value)[0]!;
    await beforeAgentStart(value, prompt);

    await agentEnd(value);
    expect(continuationPrompts(value)).toHaveLength(1);
    expect(value.notify).toHaveBeenCalledWith(expect.stringContaining("made no canonical progress"), "warning");
  });
});
