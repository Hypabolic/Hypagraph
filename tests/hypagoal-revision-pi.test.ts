import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { HYPAGRAPH_EVENT_BATCH_TYPE } from "../src/persistence/event-store.js";

interface ToolDefinition { name: string; execute: (id: string, params: any, signal: AbortSignal | undefined, onUpdate: undefined, ctx: any) => Promise<any> }
interface CommandDefinition { handler: (args: string, ctx: any) => Promise<void> }

const objective = "Add a repository migration and preserve the required verification path.";
const definition = () => ({
  title: "Repository migration delivery",
  goal: objective,
  nodes: [
    { id: "inventory", title: "Inventory current migration state", requires: [], acceptance: [], scope: { paths: ["src/**"] } },
    { id: "implement", title: "Implement the migration", requires: ["inventory"], acceptance: ["Keep the verification path"], scope: { paths: ["src/**"] } },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const harness = () => {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: any[] = [];
  const sendUserMessage = vi.fn();
  let activeTools = ["read", "write", "edit"];
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: any) => any) => handlers.set(event, [...(handlers.get(event) ?? []), handler])),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: CommandDefinition) => commands.set(name, command)),
    appendEntry: vi.fn((customType: string, data?: unknown) => entries.push({ type: "custom", customType, data })),
    sendUserMessage,
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((tools: string[]) => { activeTools = [...tools]; }),
  } as unknown as ExtensionAPI;
  const ctx = { cwd: process.cwd(), hasUI: true, ui: { confirm: vi.fn().mockResolvedValue(true), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }, sessionManager: { getBranch: () => entries } };
  hypagraphExtension(pi);
  return { tools, commands, handlers, entries, sendUserMessage, pi: pi as any, ctx };
};

const invoke = async (value: ReturnType<typeof harness>, name: string, event: any) => {
  const results = [];
  for (const handler of value.handlers.get(name) ?? []) results.push(await handler(event, value.ctx));
  return results;
};
const usage = { role: "assistant", content: [], usage: { input: 8, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
const agentEnd = (value: ReturnType<typeof harness>) => invoke(value, "agent_end", { type: "agent_end", messages: [usage] });
const prompts = (value: ReturnType<typeof harness>) => value.sendUserMessage.mock.calls.map((call) => String(call[0]));
const latest = (value: ReturnType<typeof harness>) => value.entries.filter((entry) => entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE).at(-1)?.data.snapshot;

const before = async (value: ReturnType<typeof harness>, prompt: string) => {
  const results = await invoke(value, "before_agent_start", { type: "before_agent_start", prompt, systemPrompt: "base", systemPromptOptions: {} });
  return String(results.find((item) => item?.systemPrompt)?.systemPrompt ?? "");
};
const transition = (value: ReturnType<typeof harness>, nodeId: string, action: string, extra: Record<string, unknown> = {}) => value.tools.get("hypagraph_transition")!.execute(`${nodeId}-${action}`, { nodeId, action, ...extra }, undefined, undefined, value.ctx);
const complete = async (value: ReturnType<typeof harness>, nodeId: string) => {
  await transition(value, nodeId, "start");
  await transition(value, nodeId, "submit", { evidence: [] });
  await transition(value, nodeId, "verify", { passed: true });
};

const create = async (value: ReturnType<typeof harness>) => value.tools.get("hypagoal_start")!.execute("create", { objective, definition: definition(), budget: { maximumTurns: 8, maximumTokens: 500 } }, undefined, undefined, value.ctx);

describe("Hypagoal bounded revision Pi smoke", () => {
  it("completes useful work, revises one recoverable blocker, preserves state, and resumes automatically", async () => {
    const value = harness();
    await create(value);
    await agentEnd(value);
    let prompt = prompts(value).at(-1)!;
    expect(prompt).toContain("start ready task 'inventory'");
    await before(value, prompt);
    await complete(value, "inventory");
    await agentEnd(value);

    prompt = prompts(value).at(-1)!;
    await before(value, prompt);
    await transition(value, "implement", "block", { reason: "A bounded schema-normalization step is missing.", blockerKind: "repository-work" });
    await agentEnd(value);

    prompt = prompts(value).at(-1)!;
    expect(prompt).toContain("automatic bounded revision");
    const system = await before(value, prompt);
    expect(system).toContain(`Exact objective: ${objective}`);
    expect(system).toContain("only automatic revision attempt");
    expect(value.pi.setActiveTools).toHaveBeenLastCalledWith(["hypagraph_read", "hypagoal_submit_revision"]);

    const revised = definition();
    revised.nodes = [
      revised.nodes[0]!,
      { id: "normalize-schema", title: "Normalize the schema", requires: ["inventory"], acceptance: ["Add the bounded missing repository step"], scope: { paths: ["src/**"] } },
      { ...revised.nodes[1]!, requires: ["inventory", "normalize-schema"] },
    ];
    await value.tools.get("hypagoal_submit_revision")!.execute("revise", revised, undefined, undefined, value.ctx);
    await agentEnd(value);

    let state = latest(value);
    expect(state.definition.goal).toBe(objective);
    expect(state.runtime.nodes.inventory.status).toBe("succeeded");
    expect(state.runtime.nodes.inventory.attemptCount).toBe(1);
    expect(state.goal.automaticRevision).toMatchObject({ consumedAttempts: 1, lastAttempt: { outcome: "applied" } });
    expect(state.goal.budget.consumedTurns).toBe(3);
    expect(state.goal.budget.consumedTokens.totalTokens).toBe(36);

    prompt = prompts(value).at(-1)!;
    expect(prompt).toContain("normalize-schema");
    await before(value, prompt);
    await complete(value, "normalize-schema");
    await agentEnd(value);
    prompt = prompts(value).at(-1)!;
    await before(value, prompt);
    await complete(value, "implement");
    await agentEnd(value);

    state = latest(value);
    expect(state.phase).toBe("completed");
    expect(state.goal.status).toBe("completed");
    expect(state.goal.automaticRevision.consumedAttempts).toBe(1);
    expect(state.runtime.nodes.inventory.status).toBe("succeeded");
    const types = value.entries.flatMap((entry) => entry.data?.events?.map((event: any) => event.type) ?? []);
    expect(types).toContain("hypagraph.workflow.revised");
    expect(types).toContain("hypagraph.goal.revision-applied");
  });

  it("consumes the allowance for a weakening proposal and does not request another revision", async () => {
    const value = harness();
    await create(value);
    await agentEnd(value);
    await before(value, prompts(value).at(-1)!);
    await transition(value, "inventory", "block", { reason: "A bounded repository step is missing.", blockerKind: "repository-work" });
    await agentEnd(value);
    const revisionPrompt = prompts(value).at(-1)!;
    await before(value, revisionPrompt);
    const weakened = definition();
    weakened.goal = "A different objective";
    await value.tools.get("hypagoal_submit_revision")!.execute("bad-revise", weakened, undefined, undefined, value.ctx);
    const promptCount = prompts(value).length;
    await agentEnd(value);
    expect(prompts(value)).toHaveLength(promptCount);
    const state = latest(value);
    expect(state.revision).toBe(1);
    expect(state.goal.status).toBe("blocked");
    expect(state.goal.automaticRevision).toMatchObject({ consumedAttempts: 1, lastAttempt: { outcome: "rejected", outcomeCode: "automatic_revision_objective_changed" } });
  });
});
