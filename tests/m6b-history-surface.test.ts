import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { HYPAGRAPH_EVENT_BATCH_TYPE } from "../src/persistence/event-store.js";

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

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const objective = "Run one task, one check, and one gate, and keep the history readable.";

const definition = () => ({
  title: "History surface",
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
        onTrue: ["ship"],
        onFalse: ["repair"],
      },
    },
    { id: "ship", title: "Ship the change", requires: ["route"], acceptance: [] },
    { id: "repair", title: "Repair the change", requires: ["route"], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const harness = (cwd: string) => {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
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
    registerCommand: vi.fn((name: string, command: CommandDefinition) => commands.set(name, command)),
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
  return { tools, commands, handlers, entries, sendUserMessage, notify, ctx };
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

const lastNotification = (value: ReturnType<typeof harness>): string =>
  String(value.notify.mock.calls.at(-1)?.[0] ?? "");

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

const deliver = async (value: ReturnType<typeof harness>, prompt: string) => invoke(value, "before_agent_start", {
  type: "before_agent_start",
  prompt,
  systemPrompt: "base-system",
  systemPromptOptions: {},
});

const transition = async (value: ReturnType<typeof harness>, nodeId: string, action: string, extra: Record<string, unknown> = {}) =>
  value.tools.get("hypagraph_transition")!.execute(`${nodeId}-${action}`, { nodeId, action, ...extra }, undefined, undefined, value.ctx);

const history = async (value: ReturnType<typeof harness>, args: string): Promise<string> => {
  await value.commands.get("hypagraph")!.handler(args, value.ctx);
  return lastNotification(value);
};

/** Run one task through the model lane, so the controller then dispatches the check and the gate. */
const runToCompletion = async (value: ReturnType<typeof harness>) => {
  await value.tools.get("hypagoal_start")!.execute(
    "create-root",
    { objective, definition: definition() },
    undefined,
    undefined,
    value.ctx,
  );
  await agentEnd(value);
  await deliver(value, prompts(value)[0]!);
  await transition(value, "plan", "start");
  await transition(value, "plan", "submit", { evidence: [] });
  await transition(value, "plan", "verify", { passed: true });
  await agentEnd(value);
};

describe("M6B Slice 4 history surface", () => {
  it("renders the most recent timeline page and reports the total", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6b-history-"));
    roots.push(root);
    const value = harness(root);
    await runToCompletion(value);

    const rendered = await history(value, "history");
    const lines = rendered.split("\n");
    expect(lines[0]).toMatch(/^Hypagraph event timeline: \d+ of \d+ entries, sequence \d+ to \d+\.$/);
    expect(lines[1]).toContain("M model lane");
    expect(rendered).toContain("deterministic lane");
    // The default page is bounded.
    expect(lines.length).toBeLessThanOrEqual(24);
    const state = latestState(value);
    expect(rendered).toContain(`of ${state.sequence} entries`);
  }, 30_000);

  it("filters the timeline by lane and rejects an unknown argument", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6b-lane-"));
    roots.push(root);
    const value = harness(root);
    await runToCompletion(value);

    const dispatch = await history(value, "history dispatch");
    expect(dispatch).toContain("in lane 'dispatch'");
    expect(dispatch).toContain("The scheduler selected run check 'verify' in the deterministic lane");
    expect(dispatch).toContain("The model lane selected start task 'plan'");

    const loops = await history(value, "history loop");
    expect(loops).toBe("The event timeline has no 'loop' entry.");

    const invalid = await history(value, "history nonsense");
    expect(invalid).toContain("Usage: /hypagraph history");
  }, 30_000);

  it("renders the replayed workflow at a requested sequence with its difference from live", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6b-replay-surface-"));
    roots.push(root);
    const value = harness(root);
    await runToCompletion(value);

    const state = latestState(value);
    const rendered = await history(value, "history 3");
    expect(rendered).toContain(`Hypagraph replay at sequence 3 of ${state.sequence}.`);
    expect(rendered).toContain("Difference from live sequence");
    expect(rendered).toContain("Replay reads stored events only. It runs no check and calls no executor.");
    expect(rendered).toContain("charged model turns increased by");

    const live = await history(value, `history ${state.sequence}`);
    expect(live).toContain("Difference from live: none. The replay reached the live sequence.");
  }, 30_000);

  it("reports a clear error for an out-of-range sequence and changes no state", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6b-range-"));
    roots.push(root);
    const value = harness(root);
    await runToCompletion(value);

    const before = latestState(value);
    const rendered = await history(value, `history ${before.sequence + 5}`);
    expect(rendered).toContain(`The event stream has no sequence ${before.sequence + 5}.`);
    expect(latestState(value).snapshotHash).toBe(before.snapshotHash);
  }, 30_000);

  it("renders a canonical explanation for one node and for the goal", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6b-explain-surface-"));
    roots.push(root);
    const value = harness(root);
    await runToCompletion(value);

    const repair = await history(value, "explain repair");
    expect(repair).toContain("Node 'repair' is skipped (task).");
    expect(repair).toContain("Reason: skipped-route");
    expect(repair).toContain("gate 'route' selected outcome 'true'");

    const all = await history(value, "explain");
    expect(all).toContain("Decision:");
    expect(all).toContain("Runnable nodes: ship");
    expect(all).toContain("- plan: succeeded;");
  }, 30_000);

  it("gives the model a redacted history view and an explanation view", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6b-model-view-"));
    roots.push(root);
    const value = harness(root);
    await runToCompletion(value);

    const read = value.tools.get("hypagraph_read")!;
    const historyResult = await read.execute("read-history", { view: "history" }, undefined, undefined, value.ctx);
    const payload = JSON.parse(String(historyResult.content[0].text));
    expect(payload.totalEvents).toBeGreaterThan(0);
    expect(payload.firstSequence).toBe(1);
    expect(Array.isArray(payload.entries)).toBe(true);
    expect(payload.entries.every((entry: any) => typeof entry.summary === "string")).toBe(true);
    expect(payload.entries.some((entry: any) => entry.dispatch?.lane === "deterministic")).toBe(true);

    const explainResult = await read.execute("read-explain", { view: "explain", nodeId: "ship" }, undefined, undefined, value.ctx);
    expect(String(explainResult.content[0].text)).toContain("Node 'ship' is ready (task).");
  }, 30_000);

  it("reports that no Hypagraph is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6b-empty-"));
    roots.push(root);
    const value = harness(root);

    expect(await history(value, "history")).toBe("There is no active Hypagraph.");
    expect(await history(value, "explain plan")).toBe("There is no active Hypagraph.");
  }, 30_000);
});
