/**
 * /hypagraph demo list and create paths on the product extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { listDemoExamples } from "../src/pi/demo-catalog.js";

interface CommandDefinition {
  handler: (args: string, ctx: any) => Promise<void>;
}

const harness = (options?: { hasUI?: boolean; mode?: string }) => {
  const commands = new Map<string, CommandDefinition>();
  const notify = vi.fn();
  // Post-create Run; live graph dock keeps a hanging promise (product path).
  const custom = vi.fn((factory: any, options?: any) => {
    if (options?.onHandle) {
      return new Promise<void>(() => {
        try {
          const tui = { terminal: { columns: 100, rows: 40 }, requestRender: vi.fn() };
          const theme = { fg: (_n: string, v: string) => v };
          factory(tui, theme, {}, () => undefined);
          options.onHandle({
            focus: vi.fn(),
            unfocus: vi.fn(),
            hide: vi.fn(),
            setHidden: vi.fn(),
            isHidden: vi.fn(() => false),
            isFocused: vi.fn(() => false),
          });
        } catch {
          // ignore component construction in list-only tests
        }
      });
    }
    return Promise.resolve({ kind: "run" as const });
  });
  const entries: any[] = [];
  const pi = {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, command: CommandDefinition) => {
      commands.set(name, command);
    }),
    appendEntry: vi.fn((customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => ["read"]),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    hasUI: options?.hasUI ?? true,
    mode: options?.mode ?? "tui",
    ui: {
      confirm: vi.fn().mockResolvedValue(true),
      notify,
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      custom,
    },
    sessionManager: { getBranch: () => entries },
  };
  hypagraphExtension(pi);
  return { commands, notify, custom, ctx, entries };
};

describe("/hypagraph demo command", () => {
  it("lists the catalog", async () => {
    const value = harness();
    await value.commands.get("hypagraph")!.handler("demo list", value.ctx);
    const text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    for (const example of listDemoExamples()) {
      expect(text).toContain(example.id);
    }
  });

  it("help mentions demo ids", async () => {
    const value = harness();
    await value.commands.get("hypagraph")!.handler("help", value.ctx);
    const text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toMatch(/demo/);
    expect(text).toMatch(/showcase|loop|fanout/);
  });

  it("starts the showcase tour with basic as the first graph", async () => {
    const value = harness({ hasUI: true, mode: "tui" });
    await value.commands.get("hypagraph")!.handler("demo showcase", value.ctx);
    const text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toMatch(/Tour 1\/|basic|showcase tour|Showcase tour/i);
    expect(text).toMatch(/Goal|Run|graph/i);
  });

  it("creates the loop demo", async () => {
    const value = harness({ hasUI: true, mode: "tui" });
    await value.commands.get("hypagraph")!.handler("demo loop", value.ctx);
    const text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toMatch(/loop/i);
  });

  it("rejects unknown demo ids with catalog help", async () => {
    const value = harness();
    await value.commands.get("hypagraph")!.handler("demo not-a-real-id", value.ctx);
    const text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toMatch(/Unknown demo/);
    expect(text).toMatch(/showcase/);
  });
});
