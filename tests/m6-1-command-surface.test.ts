import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { isTimelineLane, TIMELINE_LANES, renderEventTimeline } from "../src/ui/history-surface.js";
import { projectEventTimeline, type TimelineLane } from "../src/history/timeline.js";
import type { DomainEvent } from "../src/domain/model.js";

interface CommandDefinition {
  handler: (args: string, ctx: any) => Promise<void>;
}

const harness = () => {
  const commands = new Map<string, CommandDefinition>();
  const notify = vi.fn();
  const pi = {
    on: vi.fn(),
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
    ui: { confirm: vi.fn(), notify, select: vi.fn(), input: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
    sessionManager: { getBranch: () => [] },
  };
  hypagraphExtension(pi);
  return { commands, notify, ctx };
};

const run = async (value: ReturnType<typeof harness>, args: string): Promise<string> => {
  value.notify.mockClear();
  await value.commands.get("hypagraph")!.handler(args, value.ctx);
  return value.notify.mock.calls.map((call) => String(call[0])).join("\n");
};

const interactionEvent = (): DomainEvent => ({
  eventId: "e1",
  workflowId: "w1",
  revision: 1,
  sequence: 1,
  type: "hypagraph.interaction.requested",
  version: 1,
  timestamp: "2026-07-28T00:00:00.000Z",
  causationId: "c1",
  correlationId: "c1",
  nodeId: "approve-plan",
  data: {},
} as DomainEvent);

describe("Review finding 1: every timeline lane is selectable", () => {
  it("accepts the interaction lane which Slice 1 added", () => {
    expect(isTimelineLane("interaction")).toBe(true);
  });

  it("offers every lane which the projection can produce", () => {
    const lanes: TimelineLane[] = [
      "workflow", "goal", "dispatch", "node", "check", "code",
      "interaction", "evaluation", "fact", "route", "loop", "unknown",
    ];

    expect([...TIMELINE_LANES].sort()).toEqual([...lanes].sort());
  });

  it("filters the timeline by the interaction lane instead of reporting a usage error", () => {
    const events = [interactionEvent()];
    expect(projectEventTimeline(events)[0]!.lane).toBe("interaction");

    const rendered = renderEventTimeline(events, { lane: "interaction" });

    expect(rendered).toContain("approve-plan");
    expect(rendered).not.toContain("Usage:");
  });

  it("names the interaction lane in the command usage text", async () => {
    const value = harness();

    const output = await run(value, "help");

    expect(output).toContain("interaction");
    for (const lane of TIMELINE_LANES) expect(output).toContain(lane);
  });
});

describe("Review finding 2: the command reports an unknown subcommand", () => {
  it("shows usage for help", async () => {
    const value = harness();

    const output = await run(value, "help");

    expect(output).toContain("Usage: /hypagraph");
    expect(output).toContain("ask [<nodeId>]");
  });

  it("reports an unknown subcommand instead of rendering the workflow", async () => {
    const value = harness();

    const output = await run(value, "histroy");

    expect(output).toContain("has no 'histroy' subcommand");
    expect(output).toContain("Usage: /hypagraph");
  });

  it("reports an unknown graph subcommand", async () => {
    const value = harness();

    const output = await run(value, "graph sideways");

    expect(output).toContain("has no 'graph sideways' subcommand");
  });

  it("still shows the workflow when the command has no argument", async () => {
    const value = harness();

    const output = await run(value, "");

    expect(output).toBe("There is no active Hypagraph.");
    expect(output).not.toContain("subcommand");
  });
});
