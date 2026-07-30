import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import {
  bindActiveIsolatedPiHost,
  getActiveIsolatedPiHost,
  type IsolatedPiHost,
} from "../src/pi/isolated-pi-executor.js";

interface CommandDefinition {
  handler: (args: string, ctx: any) => Promise<void>;
}

type SessionHandler = () => void | Promise<void>;

const harness = () => {
  const commands = new Map<string, CommandDefinition>();
  const sessionHandlers = new Map<string, SessionHandler[]>();
  const notify = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: SessionHandler) => {
      const list = sessionHandlers.get(event) ?? [];
      list.push(handler);
      sessionHandlers.set(event, list);
    }),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, command: CommandDefinition) => commands.set(name, command)),
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    ui: {
      confirm: vi.fn(),
      notify,
      select: vi.fn(),
      input: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: { getBranch: () => [] },
  };
  hypagraphExtension(pi);
  return { commands, notify, ctx, sessionHandlers };
};

const runHypagraph = async (
  value: ReturnType<typeof harness>,
  args: string,
): Promise<string> => {
  value.notify.mockClear();
  await value.commands.get("hypagraph")!.handler(args, value.ctx);
  return value.notify.mock.calls.map((call) => String(call[0])).join("\n");
};

const seedActiveIsolatedProcess = (host: IsolatedPiHost): string => {
  const token = `token-extension-${Math.random().toString(16).slice(2)}`;
  const registered = host.registry.register({
    ownershipToken: token,
    identity: {
      familyId: "family-ext",
      goalId: "goal-ext",
      workflowId: "workflow-ext",
      revision: 1,
      nodeId: "work",
      attemptId: "attempt-ext",
    },
    checkoutKey: process.cwd(),
    startedAt: "2026-07-29T22:00:00.000Z",
    live: true,
  });
  expect(registered.ok).toBe(true);
  host.registry.setTerminator(token, async () => {
    // stub — no real OS process
  });
  return token;
};

describe("m7-s8 isolated Pi extension surface", () => {
  it("executor status reports host identity and cancel guidance", async () => {
    const value = harness();
    const output = await runHypagraph(value, "executor status");
    expect(output).toContain("Isolated Pi host: isolated-pi");
    expect(output).toContain("Profile kind: isolated-pi");
    expect(output).toContain("ACP host bound: yes");
    expect(output).toContain("CLI host bound: yes");
    expect(output).toContain("Active processes: 0");
    expect(output).toContain("/hypagraph executor cancel");
    expect(output).toContain("probe [acp|cli]");
  });

  it("executor cancel with no active attempt reports idle", async () => {
    const value = harness();
    const output = await runHypagraph(value, "executor cancel");
    expect(output).toContain("There is no active executor attempt.");
  });

  it("product host binds an ACP registry for cancel and teardown", async () => {
    const value = harness();
    const host = getActiveIsolatedPiHost();
    expect(host).toBeDefined();
    expect(host!.acpRegistry).toBeDefined();
    expect(host!.acpRegistry!.hasActive()).toBe(false);
    // Seed an ACP session and cancel through the product command.
    const token = "token-acp-ext";
    expect(host!.acpRegistry!.register({
      sessionToken: token,
      identity: {
        familyId: "family-ext",
        goalId: "goal-ext",
        workflowId: "workflow-ext",
        revision: 1,
        nodeId: "work",
        attemptId: "attempt-acp-ext",
      },
      live: true,
      startedAt: "2026-07-30T10:00:00.000Z",
      sessionId: "sess-acp-ext",
    }).ok).toBe(true);
    host!.acpRegistry!.setCloser(token, async () => {
      // stub
    });
    expect(host!.hasActiveProcesses()).toBe(true);
    const output = await runHypagraph(value, "executor cancel");
    expect(output).toMatch(/ACP session/);
    expect(host!.acpRegistry!.hasActive()).toBe(false);
  });

  it("executor cancel terminates a seeded active record", async () => {
    const value = harness();
    const host = getActiveIsolatedPiHost();
    expect(host).toBeDefined();
    seedActiveIsolatedProcess(host!);
    expect(host!.hasActiveProcesses()).toBe(true);

    const output = await runHypagraph(value, "executor cancel");

    expect(output).toMatch(/Cancelled \d+ isolated Pi process/);
    expect(host!.hasActiveProcesses()).toBe(false);
  });

  it("executor probe without an active goal reports a clear message", async () => {
    const value = harness();
    const output = await runHypagraph(value, "executor probe");
    expect(output).toContain("requires an active goal workflow");
  });

  it("executor unknown subcommand reports usage", async () => {
    const value = harness();
    const output = await runHypagraph(value, "executor sideways");
    expect(output).toContain("has no 'sideways' subcommand");
    expect(output).toContain("status | probe | cancel");
  });

  it("help lists executor cancel", async () => {
    const value = harness();
    const output = await runHypagraph(value, "help");
    expect(output).toContain("executor [status | probe | cancel]");
  });

  it("session_shutdown tears down active isolated processes and unbinds the host", async () => {
    const value = harness();
    const host = getActiveIsolatedPiHost();
    expect(host).toBeDefined();
    seedActiveIsolatedProcess(host!);
    expect(host!.hasActiveProcesses()).toBe(true);

    const handlers = value.sessionHandlers.get("session_shutdown") ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) {
      await handler();
    }

    expect(host!.hasActiveProcesses()).toBe(false);
    expect(getActiveIsolatedPiHost()).toBeUndefined();

    // Restore binding for any later tests that share process state.
    bindActiveIsolatedPiHost(host);
  });

  it("ensureNoActiveExecution rejects workflow changes while isolated Pi is active", async () => {
    const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
    const commands = new Map<string, CommandDefinition>();
    const notify = vi.fn();
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn((definition: { name: string; execute: (...args: any[]) => Promise<any> }) => {
        tools.push(definition);
      }),
      registerCommand: vi.fn((name: string, command: CommandDefinition) => commands.set(name, command)),
      appendEntry: vi.fn(),
      sendUserMessage: vi.fn(),
      getActiveTools: vi.fn(() => []),
      setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      mode: "tui",
      ui: {
        confirm: vi.fn(),
        notify,
        select: vi.fn(),
        input: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      },
      sessionManager: { getBranch: () => [] },
    };

    hypagraphExtension(pi);
    const host = getActiveIsolatedPiHost();
    expect(host).toBeDefined();
    seedActiveIsolatedProcess(host!);
    expect(host!.hasActiveProcesses()).toBe(true);

    // hypagoal_start is a product path that calls ensureNoActiveExecution.
    const startTool = tools.find((tool) => tool.name === "hypagoal_start");
    expect(startTool).toBeDefined();

    await expect(
      startTool!.execute("call-1", {}, undefined, undefined, ctx),
    ).rejects.toThrow(/active executor is running/);
    await expect(
      startTool!.execute("call-1", {}, undefined, undefined, ctx),
    ).rejects.toThrow(/hypagraph executor cancel/);

    // Cleanup so later tests are not blocked.
    await host!.teardownOnRestore({
      kind: "user",
      reason: "test cleanup",
    });
  });
});
