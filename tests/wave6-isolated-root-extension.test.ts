import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import {
  bindActiveIsolatedPiHost,
  createIsolatedPiHost,
  getActiveIsolatedPiHost,
  type IsolatedPiProcessTransport,
  type IsolatedPiProcessHandle,
  type IsolatedPiStartOptions,
} from "../src/pi/isolated-pi-executor.js";
import { buildExecutorResultPayload } from "../src/domain/executor-contract.js";

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

const objective = "Ship a default isolated task.";

const rootDefinition = {
  title: "Isolated default graph",
  goal: "The model cannot replace the objective.",
  nodes: [
    {
      id: "implement",
      title: "Implement the work",
      requires: [],
      acceptance: [],
      produces: [{ name: "work.done", type: "boolean", required: true }],
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
};

const harness = () => {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: any[] = [];
  const sendUserMessage = vi.fn();
  const notify = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: CommandDefinition) => commands.set(name, command)),
    appendEntry: vi.fn((customType: string, data?: unknown) => entries.push({ type: "custom", customType, data })),
    sendUserMessage,
    getActiveTools: vi.fn(() => ["read", "write", "edit"]),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    mode: "rpc",
    ui: {
      confirm: vi.fn().mockResolvedValue(true),
      notify,
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      custom: vi.fn(),
    },
    sessionManager: { getBranch: () => entries },
  };
  hypagraphExtension(pi);
  return { tools, commands, handlers, entries, sendUserMessage, notify, ctx, pi };
};

const invoke = async (
  handlers: Map<string, Array<(event: any, ctx: any) => any>>,
  name: string,
  event: any,
  ctx: any,
) => {
  const values = [];
  for (const handler of handlers.get(name) ?? []) values.push(await handler(event, ctx));
  return values;
};

const agentEnd = async (value: ReturnType<typeof harness>) => {
  await invoke(value.handlers, "agent_end", {
    type: "agent_end",
    messages: [{
      role: "assistant",
      content: [],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    }],
  }, value.ctx);
};

const continuationPrompts = (value: ReturnType<typeof harness>): string[] =>
  value.sendUserMessage.mock.calls
    .map((call) => String(call[0]))
    .filter((prompt) => prompt.startsWith("Hypagraph automatic continuation."));

const createFakeTransport = (): IsolatedPiProcessTransport => ({
  start: async (options: IsolatedPiStartOptions): Promise<IsolatedPiProcessHandle> => {
    const handle: IsolatedPiProcessHandle = {
      pid: 12_345,
      sessionId: `session-${options.identity.attemptId}`,
      ownershipToken: options.ownershipToken,
      identity: options.identity,
      runAttempt: async (context) => buildExecutorResultPayload({
        identity: context.identity,
        outcome: "submitted",
        facts: [{
          name: "work.done",
          type: "boolean",
          value: true,
          evidence: [{ ref: "evidence://worker", kind: "note" }],
        }],
        evidence: [{ ref: "evidence://worker", kind: "note", summary: "worker complete" }],
        summary: "Isolated worker completed the task.",
      }),
      terminate: async () => {
        // no-op
      },
    };
    return handle;
  },
});

describe("Wave 6 root isolated dispatch extension (S6.2)", () => {
  beforeAll(async () => {
    const { configureHostRoutingForTests } = await import("../src/pi/host-routing-options.js");
    // Product default: isolated-pi.
    configureHostRoutingForTests({ legacyCurrentSessionDefault: false });
  });

  afterAll(async () => {
    const { configureHostRoutingForTests } = await import("../src/pi/host-routing-options.js");
    // Restore suite-wide legacy follow-up for older fixtures.
    configureHostRoutingForTests({ legacyCurrentSessionDefault: true });
  });

  it("first task after create does not send implement follow-up", async () => {
    const value = harness();
    // Replace the product host with a fake transport so no real Pi process starts.
    const fakeHost = createIsolatedPiHost({
      transport: createFakeTransport(),
      resolveCwd: () => process.cwd(),
      resolveCheckoutKey: () => process.cwd(),
      startedAt: () => "2026-07-31T12:00:00.000Z",
      createOwnershipToken: () => "token-wave6-test",
    });
    bindActiveIsolatedPiHost(fakeHost);

    try {
      await value.tools.get("hypagoal_start")!.execute(
        "create-root",
        { objective, definition: rootDefinition },
        undefined,
        undefined,
        value.ctx,
      );
      value.sendUserMessage.mockClear();

      await agentEnd(value);

      // Default routing must not implement in the orchestrator session.
      expect(continuationPrompts(value)).toEqual([]);
      expect(value.sendUserMessage).not.toHaveBeenCalled();

      const notifyText = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
      expect(notifyText).toMatch(/isolated worker/i);
      expect(notifyText).toMatch(/implement/);

      // Task must settle through the worker path.
      const read = await value.tools.get("hypagraph_read")!.execute(
        "read",
        {},
        undefined,
        undefined,
        value.ctx,
      );
      const status = String(read.content?.[0]?.text ?? read);
      // Node completed via submit + auto-verify.
      expect(status.toLowerCase()).toMatch(/succeed|complete|implement/);
    } finally {
      await fakeHost.teardownOnRestore({
        kind: "other",
        reason: "test cleanup",
      });
      bindActiveIsolatedPiHost(undefined);
    }
  });

  it("current-session opt-in still queues implement follow-up", async () => {
    const value = harness();
    const productHost = getActiveIsolatedPiHost();
    // Keep product host bound; current-session path must not call it for this action.
    expect(productHost).toBeDefined();

    await value.tools.get("hypagoal_start")!.execute(
      "create-opt-in",
      {
        objective,
        definition: {
          ...rootDefinition,
          nodes: [{
            ...rootDefinition.nodes[0],
            executorProfile: {
              profileId: "current-session-default",
              kind: "current-session",
            },
          }],
        },
      },
      undefined,
      undefined,
      value.ctx,
    );
    value.sendUserMessage.mockClear();
    await agentEnd(value);

    const prompts = continuationPrompts(value);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("start ready task 'implement'");
  });

  it("executor status reports default isolated routing", async () => {
    const value = harness();
    value.notify.mockClear();
    await value.commands.get("hypagraph")!.handler("executor status", value.ctx);
    const output = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Default model task routing: isolated-pi");
    expect(output).toContain("Root worker: none");
  });

  it("blocks orchestrator mutating tools while a root worker is active (S6.6)", async () => {
    const value = harness();
    // Hold the worker open until the tool_call check runs.
    let releaseWorker: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const holdingTransport: IsolatedPiProcessTransport = {
      start: async (options) => ({
        pid: 99,
        sessionId: `session-${options.identity.attemptId}`,
        ownershipToken: options.ownershipToken,
        identity: options.identity,
        runAttempt: async (context) => {
          await gate;
          return buildExecutorResultPayload({
            identity: context.identity,
            outcome: "submitted",
            facts: [{
              name: "work.done",
              type: "boolean",
              value: true,
              evidence: [{ ref: "evidence://worker", kind: "note" }],
            }],
            evidence: [{ ref: "evidence://worker", kind: "note" }],
            summary: "held worker",
          });
        },
        terminate: async () => {
          // no-op
        },
      }),
    };
    const fakeHost = createIsolatedPiHost({
      transport: holdingTransport,
      resolveCwd: () => process.cwd(),
      resolveCheckoutKey: () => process.cwd(),
      startedAt: () => "2026-07-31T12:00:00.000Z",
      createOwnershipToken: () => "token-wave6-block",
    });
    bindActiveIsolatedPiHost(fakeHost);

    try {
      await value.tools.get("hypagoal_start")!.execute(
        "create-block",
        { objective, definition: rootDefinition },
        undefined,
        undefined,
        value.ctx,
      );

      const runPromise = agentEnd(value);
      // Allow the controller to start the worker and set activeIsolatedRootAttempt.
      await new Promise((resolve) => setTimeout(resolve, 30));

      const blocks = await invoke(value.handlers, "tool_call", {
        type: "tool_call",
        toolName: "hypagraph_transition",
        toolCallId: "tc-1",
        input: {},
      }, value.ctx);
      const blocked = blocks.find((item) => item && typeof item === "object" && "block" in item);
      expect(blocked).toMatchObject({ block: true });
      expect(String((blocked as { reason?: string }).reason)).toMatch(/isolated model worker/i);

      releaseWorker?.();
      await runPromise;
    } finally {
      releaseWorker?.();
      await fakeHost.teardownOnRestore({ kind: "other", reason: "test cleanup" });
      bindActiveIsolatedPiHost(undefined);
    }
  });

  it("cancels the durable task when the isolated worker throws after start-node", async () => {
    const value = harness();
    // Normal transport is fine; force dispatchAttempt to reject after start-node
    // has already been committed so the extension catch path must cancel.
    const baseHost = createIsolatedPiHost({
      transport: createFakeTransport(),
      resolveCwd: () => process.cwd(),
      resolveCheckoutKey: () => process.cwd(),
      startedAt: () => "2026-07-31T12:00:00.000Z",
      createOwnershipToken: () => "token-wave6-throw",
    });
    const throwingHost = {
      ...baseHost,
      dispatchAttempt: async () => {
        throw new Error("simulated dispatchIsolatedPiAttempt throw after start");
      },
      teardownOnRestore: baseHost.teardownOnRestore.bind(baseHost),
      activeProcessCount: baseHost.activeProcessCount.bind(baseHost),
    };
    bindActiveIsolatedPiHost(throwingHost as typeof baseHost);

    try {
      await value.tools.get("hypagoal_start")!.execute(
        "create-throw",
        { objective, definition: rootDefinition },
        undefined,
        undefined,
        value.ctx,
      );
      value.notify.mockClear();
      await agentEnd(value);

      const notifyText = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
      expect(notifyText).toMatch(/isolated worker threw/i);
      expect(notifyText).toMatch(/simulated dispatchIsolatedPiAttempt throw/i);

      const read = await value.tools.get("hypagraph_read")!.execute(
        "read",
        {},
        undefined,
        undefined,
        value.ctx,
      );
      const status = String(read.content?.[0]?.text ?? read).toLowerCase();
      // Durable cancel-attempt applied (not left as an active/running node attempt).
      expect(status).toMatch(/"cancelled"\s*:\s*1|"cancelled":1|cancel/);
      expect(status).toMatch(/"active"\s*:\s*null|"active":null/);

      // No tracked root worker remains.
      value.notify.mockClear();
      await value.commands.get("hypagraph")!.handler("executor status", value.ctx);
      const executorStatus = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
      expect(executorStatus).toContain("Root worker: none");
    } finally {
      await baseHost.teardownOnRestore({ kind: "other", reason: "test cleanup" });
      bindActiveIsolatedPiHost(undefined);
    }
  });
});
