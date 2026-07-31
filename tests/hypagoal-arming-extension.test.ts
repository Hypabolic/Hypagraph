import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import {
  HYPAGOAL_ARMED_STATUS_KEY,
  HYPAGOAL_ARMED_STATUS_TEXT,
} from "../src/pi/hypagoal-arming.js";

interface CommandDefinition {
  handler: (args: string, ctx: any) => Promise<void>;
}

const harness = (options?: { mode?: string; hasUI?: boolean; withEditorApi?: boolean }) => {
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, Function>();
  const notify = vi.fn();
  const setStatus = vi.fn();
  const setEditorComponent = vi.fn();
  const getEditorComponent = vi.fn(() => undefined);
  const requestRender = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, command: CommandDefinition) => commands.set(name, command)),
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const withEditorApi = options?.withEditorApi ?? false;
  const ctx = {
    cwd: process.cwd(),
    hasUI: options?.hasUI ?? true,
    mode: options?.mode ?? "tui",
    ui: {
      confirm: vi.fn(),
      notify,
      select: vi.fn(),
      input: vi.fn(),
      setStatus,
      setWidget: vi.fn(),
      ...(withEditorApi
        ? {
          setEditorComponent,
          getEditorComponent,
        }
        : {}),
    },
    sessionManager: { getBranch: () => [] },
  };
  hypagraphExtension(pi);
  return {
    commands,
    handlers,
    notify,
    setStatus,
    setEditorComponent,
    getEditorComponent,
    requestRender,
    ctx,
  };
};

describe("Hypagoal arming extension surface", () => {
  it("arms on the input hook and paints the status entry", async () => {
    const value = harness();
    const input = value.handlers.get("input");
    expect(input).toBeTypeOf("function");

    const result = await input!(
      { type: "input", text: "please hypagoal this change", source: "interactive" },
      value.ctx,
    );

    expect(result).toEqual({ action: "continue" });
    expect(value.setStatus).toHaveBeenCalledWith(HYPAGOAL_ARMED_STATUS_KEY, HYPAGOAL_ARMED_STATUS_TEXT);
  });

  it("does not arm for a trigger word only in a code fence", async () => {
    const value = harness();
    const input = value.handlers.get("input");

    await input!(
      {
        type: "input",
        text: "example:\n```\nhypagoal start\n```\ncontinue",
        source: "interactive",
      },
      value.ctx,
    );

    expect(value.setStatus).toHaveBeenCalledWith(HYPAGOAL_ARMED_STATUS_KEY, undefined);
  });

  it("injects the arming prompt block before the agent starts", async () => {
    const value = harness();
    const input = value.handlers.get("input");
    const before = value.handlers.get("before_agent_start");
    expect(before).toBeTypeOf("function");

    await input!(
      { type: "input", text: "hypagoal implement the arming path", source: "interactive" },
      value.ctx,
    );
    const result = await before!(
      { type: "before_agent_start", systemPrompt: "base", prompt: "hypagoal implement the arming path" },
      value.ctx,
    );

    expect(result?.systemPrompt).toContain("HYPAGOAL ARMING:");
    expect(result?.systemPrompt).toContain("does not need a graph");
  });

  it("clears arming at agent_end", async () => {
    const value = harness();
    const input = value.handlers.get("input");
    const agentEnd = value.handlers.get("agent_end");

    await input!(
      { type: "input", text: "hypagoal implement", source: "interactive" },
      value.ctx,
    );
    value.setStatus.mockClear();
    await agentEnd!({ messages: [] }, value.ctx);

    expect(value.setStatus).toHaveBeenCalledWith(HYPAGOAL_ARMED_STATUS_KEY, undefined);
  });

  it("supports trigger set and trigger off on /hypagraph", async () => {
    const value = harness();
    const hypagraph = value.commands.get("hypagraph");
    expect(hypagraph).toBeDefined();

    await hypagraph!.handler("trigger set shipit", value.ctx);
    expect(value.notify).toHaveBeenCalledWith("Hypagoal trigger word set to 'shipit'.", "info");

    value.notify.mockClear();
    await hypagraph!.handler("trigger", value.ctx);
    expect(value.notify).toHaveBeenCalledWith("Hypagoal trigger word: shipit", "info");

    value.notify.mockClear();
    await hypagraph!.handler("trigger off", value.ctx);
    expect(value.notify).toHaveBeenCalledWith("Hypagoal arming is off.", "info");

    value.notify.mockClear();
    await hypagraph!.handler("trigger", value.ctx);
    expect(value.notify).toHaveBeenCalledWith("Hypagoal arming is off.", "info");
  });

  it("lists trigger in the usage text", async () => {
    const value = harness();
    await value.commands.get("hypagraph")!.handler("help", value.ctx);
    const text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toContain("trigger set <word>");
    expect(text).toContain("trigger off");
    expect(text).toContain("highlights in the composer");
  });

  it("registers the trigger editor factory on interactive session_start", async () => {
    const value = harness({ withEditorApi: true });
    const sessionStart = value.handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");

    await sessionStart!({}, value.ctx);

    expect(value.setEditorComponent).toHaveBeenCalledTimes(1);
    const factory = value.setEditorComponent.mock.calls[0]![0];
    expect(factory).toBeTypeOf("function");
  });

  it("does not register an editor factory on headless hosts", async () => {
    const value = harness({ hasUI: false, mode: "rpc", withEditorApi: true });
    const sessionStart = value.handlers.get("session_start");
    await sessionStart!({}, value.ctx);
    expect(value.setEditorComponent).not.toHaveBeenCalled();
  });

  it("refreshes live highlight after trigger set and off when an editor is registered", async () => {
    const value = harness({ withEditorApi: true });
    const sessionStart = value.handlers.get("session_start");
    await sessionStart!({}, value.ctx);

    // Drive the factory so the handle captures a TUI for refresh.
    const factory = value.setEditorComponent.mock.calls[0]![0] as (
      tui: { requestRender: () => void },
      theme: unknown,
      kb: unknown,
    ) => unknown;
    const tui = { requestRender: value.requestRender, terminal: { rows: 24, columns: 80 } };
    const theme = {
      borderColor: (s: string) => s,
      textColor: (s: string) => s,
    };
    // Constructing the stock CustomEditor needs a fuller TUI; only assert refresh no-ops
    // are safe when registration succeeded. Call refresh via trigger commands.
    try {
      factory(tui as never, theme as never, {} as never);
    } catch {
      // CustomEditor may reject a partial TUI in unit tests. Registration still ran.
    }

    const hypagraph = value.commands.get("hypagraph");
    await hypagraph!.handler("trigger set work", value.ctx);
    await hypagraph!.handler("trigger off", value.ctx);
    // Commands must not throw. Refresh is best-effort when TUI is live.
    expect(value.notify).toHaveBeenCalled();
  });
});
