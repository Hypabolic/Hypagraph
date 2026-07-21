import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hypagraphExtension from "../src/extension.js";

describe("Pi extension registration", () => {
  it("registers the Hypagraph tool and command surface", () => {
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
      "workgraph_define",
      "workgraph_read",
      "workgraph_transition",
      "workgraph_revise",
    ]);
    expect(commands).toEqual(["hypagraph", "workgraph"]);
    expect(events).toEqual(expect.arrayContaining(["session_start", "session_tree", "before_agent_start", "tool_call"]));
  });
});
