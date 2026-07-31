import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";

interface CommandDefinition {
  handler: (args: string, ctx: any) => Promise<void>;
}

interface ToolDefinition {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

const harness = () => {
  const commands = new Map<string, CommandDefinition>();
  const tools = new Map<string, ToolDefinition>();
  const notify = vi.fn();
  const entries: unknown[] = [];
  const pi = {
    on: vi.fn(),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: CommandDefinition) => commands.set(name, command)),
    appendEntry: vi.fn((customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    ui: {
      confirm: vi.fn(async () => true),
      notify,
      select: vi.fn(),
      input: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: { getBranch: () => [] },
  };
  hypagraphExtension(pi);
  return { commands, tools, notify, entries, ctx, pi };
};

const createGoal = async (value: ReturnType<typeof harness>) => {
  await value.tools.get("hypagoal_start")!.execute(
    "create",
    {
      objective: "Merge the command surface",
      definition: {
        title: "Command surface",
        goal: "ignored",
        nodes: [{ id: "work", title: "Work", requires: [], acceptance: ["done"] }],
        policy: { mode: "guided", requireEvidence: false },
      },
    },
    undefined,
    undefined,
    value.ctx,
  );
};

describe("Merged /hypagraph control surface", () => {
  it("lists status pause resume cancel and trigger in usage", async () => {
    const value = harness();
    await value.commands.get("hypagraph")!.handler("help", value.ctx);
    const text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toContain("status");
    expect(text).toContain("pause [reason]");
    expect(text).toContain("resume");
    expect(text).toContain("cancel [reason]");
    expect(text).toContain("trigger set <word>");
    expect(text).toContain("/hypagoal <objective>");
  });

  it("shows goal status through /hypagraph status", async () => {
    const value = harness();
    await createGoal(value);
    value.notify.mockClear();
    await value.commands.get("hypagraph")!.handler("status", value.ctx);
    const text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toContain("Hypagoal");
    expect(text).toContain("Merge the command surface");
  });

  it("pauses and resumes through /hypagraph", async () => {
    const value = harness();
    await createGoal(value);
    value.notify.mockClear();
    await value.commands.get("hypagraph")!.handler("pause wait for review", value.ctx);
    let text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text.toLowerCase()).toContain("pause");

    value.notify.mockClear();
    await value.commands.get("hypagraph")!.handler("resume", value.ctx);
    text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text.toLowerCase()).toMatch(/active|resume/);
  });

  it("cancels through /hypagraph cancel", async () => {
    const value = harness();
    await createGoal(value);
    value.notify.mockClear();
    await value.commands.get("hypagraph")!.handler("cancel stop work", value.ctx);
    const text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text.toLowerCase()).toContain("cancel");
  });

  it("still reports an unknown subcommand", async () => {
    const value = harness();
    await value.commands.get("hypagraph")!.handler("histroy", value.ctx);
    const text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toContain("has no 'histroy' subcommand");
    expect(text).toContain("Usage: /hypagraph");
  });

  it("keeps /hypagoal status as a compatibility control path", async () => {
    const value = harness();
    await createGoal(value);
    value.notify.mockClear();
    await value.commands.get("hypagoal")!.handler("status", value.ctx);
    const text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toContain("Merge the command surface");
  });
});
