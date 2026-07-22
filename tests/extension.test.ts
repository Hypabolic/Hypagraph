import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";

describe("Pi extension registration", () => {
  it("registers the Hypagraph tools and command", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const pi = {
      on: vi.fn((event: string) => events.push(event)),
      registerTool: vi.fn((definition: { name: string }) => tools.push(definition.name)),
      registerCommand: vi.fn((name: string) => commands.push(name)),
    } as unknown as ExtensionAPI;

    hypagraphExtension(pi);

    expect(tools).toEqual([
      "hypagraph_define",
      "hypagraph_read",
      "hypagraph_run_check",
      "hypagraph_cancel_check",
      "hypagraph_transition",
      "hypagraph_revise",
    ]);
    expect(commands).toEqual(["hypagraph"]);
    expect(events).toEqual(expect.arrayContaining(["session_start", "session_tree", "before_agent_start", "tool_call"]));
  });
});
