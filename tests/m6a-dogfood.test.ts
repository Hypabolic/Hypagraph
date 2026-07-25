import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { replayEvents } from "../src/domain/projection.js";
import type { HypagraphState } from "../src/domain/model.js";
import { HYPAGRAPH_EVENT_BATCH_TYPE } from "../src/persistence/event-store.js";
import { projectHypagoalSurface } from "../src/ui/hypagoal-surface.js";

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

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const objective = "Repair the failing lint rule, record the release note, and verify the released documentation.";

/** The lint check fails on its first attempt and passes after the repair marker exists. */
const lintProgram = "const fs = require('node:fs');"
  + "const marker = 'repair.complete';"
  + "if (fs.existsSync(marker)) process.exit(0);"
  + "fs.writeFileSync(marker, 'repaired');"
  + "process.exit(1);";

const definition = () => ({
  title: "Bounded lint repair and release note",
  goal: objective,
  nodes: [
    { id: "repair-lint", title: "Repair the lint rule", requires: ["lint"], acceptance: [] },
    {
      id: "lint",
      title: "Run the lint check",
      kind: "check",
      requires: ["repair-lint"],
      acceptance: [],
      produces: [{ name: "lint.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: process.execPath,
        arguments: ["-e", lintProgram],
        timeoutMs: 30_000,
        publish: [{ source: "passed", fact: "lint.passed" }],
      },
    },
    {
      id: "route",
      title: "Select the release route",
      kind: "gate",
      requires: ["lint"],
      acceptance: [],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "lint.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["release-note"],
        onFalse: ["investigate"],
      },
    },
    { id: "release-note", title: "Write the release note", requires: ["route"], acceptance: [] },
    { id: "investigate", title: "Investigate the rejected lint result", requires: ["route"], acceptance: [] },
    {
      id: "documentation",
      title: "Verify the released documentation",
      kind: "check",
      requires: ["release-note"],
      acceptance: [],
      produces: [{ name: "documentation.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: process.execPath,
        arguments: ["-e", ""],
        timeoutMs: 30_000,
        publish: [{ source: "passed", fact: "documentation.passed" }],
      },
    },
    {
      id: "publish-gate",
      title: "Confirm the publish route",
      kind: "gate",
      requires: ["documentation"],
      acceptance: [],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "documentation.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["publish"],
        onFalse: ["revise-documentation"],
      },
    },
    { id: "publish", title: "Publish the release", requires: ["publish-gate"], acceptance: [] },
    { id: "revise-documentation", title: "Revise the documentation", requires: ["publish-gate"], acceptance: [] },
  ],
  loops: [{
    id: "lint-repair",
    nodes: ["repair-lint", "lint"],
    entry: "repair-lint",
    evaluateAfter: "lint",
    feedbackEdges: [{ from: "lint", to: "repair-lint" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "lint.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 3,
    failurePolicy: "fail-workflow",
  }],
  policy: { mode: "guided", requireEvidence: false },
});

const harness = (cwd: string) => {
  const tools = new Map<string, ToolDefinition>();
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
    registerCommand: vi.fn(),
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
  return { tools, handlers, entries, sendUserMessage, notify, ctx };
};

const invoke = async (value: ReturnType<typeof harness>, name: string, event: any) => {
  const results = [];
  for (const handler of value.handlers.get(name) ?? []) results.push(await handler(event, value.ctx));
  return results;
};

const batches = (value: ReturnType<typeof harness>): any[] => value.entries
  .filter((entry) => entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE);

const latestState = (value: ReturnType<typeof harness>): any => batches(value).at(-1)?.data.snapshot;

const allEvents = (value: ReturnType<typeof harness>): any[] => batches(value)
  .flatMap((entry) => entry.data.events ?? []);

const prompts = (value: ReturnType<typeof harness>): string[] => value.sendUserMessage.mock.calls
  .map((call) => String(call[0]))
  .filter((prompt) => prompt.startsWith("Hypagraph automatic continuation."));

const agentEnd = async (value: ReturnType<typeof harness>) => invoke(value, "agent_end", {
  type: "agent_end",
  messages: [{
    role: "assistant",
    content: [],
    usage: { input: 9, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    stopReason: "stop",
    timestamp: Date.now(),
  }],
});

const deliver = async (value: ReturnType<typeof harness>, prompt: string): Promise<string> => {
  const results = await invoke(value, "before_agent_start", {
    type: "before_agent_start",
    prompt,
    systemPrompt: "base-system",
    systemPromptOptions: {},
  });
  return String(results.find((result) => result?.systemPrompt)?.systemPrompt ?? "");
};

const transition = async (
  value: ReturnType<typeof harness>,
  nodeId: string,
  action: string,
  extra: Record<string, unknown> = {},
) => value.tools.get("hypagraph_transition")!.execute(
  `${nodeId}-${action}-${Math.random()}`,
  { nodeId, action, ...extra },
  undefined,
  undefined,
  value.ctx,
);

const completeTask = async (value: ReturnType<typeof harness>, nodeId: string) => {
  await transition(value, nodeId, "start");
  await transition(value, nodeId, "submit", { evidence: [] });
  await transition(value, nodeId, "verify", { passed: true });
};

describe("M6A dogfood", () => {
  it("completes one realistic objective and charges a turn for each task only", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6a-dogfood-"));
    roots.push(root);
    const value = harness(root);
    await value.tools.get("hypagoal_start")!.execute(
      "create-root",
      { objective, definition: definition(), budget: { maximumTurns: 12, maximumTokens: 2_000 } },
      undefined,
      undefined,
      value.ctx,
    );

    const selected: string[] = [];
    let observedPromptCount = 0;
    await agentEnd(value);

    for (let guard = 0; guard < 20; guard += 1) {
      const queued = prompts(value);
      if (queued.length === observedPromptCount) break;
      const prompt = queued.at(-1)!;
      observedPromptCount = queued.length;
      const before = latestState(value);
      const action = before.goal.pendingContinuation.action;
      const loop = action.loopId ? before.runtime.loops[action.loopId] : undefined;
      selected.push(`${action.nodeId}:${action.loopId ?? "root"}:${loop?.currentIteration ?? 0}`);
      await deliver(value, prompt);
      if (action.kind !== "start-ready-task" && action.kind !== "continue-active-task") {
        throw new Error(`The model lane received a deterministic action '${action.kind}'.`);
      }
      await completeTask(value, action.nodeId);
      await agentEnd(value);
    }

    const state = latestState(value) as HypagraphState;
    expect(selected).toEqual([
      "repair-lint:lint-repair:0",
      "repair-lint:lint-repair:2",
      "release-note:root:0",
      "publish:root:0",
    ]);

    const selections = allEvents(value)
      .filter((event) => event.type === "hypagraph.action.selected"
        || event.type === "hypagraph.goal.continuation-requested")
      .map((event) => event.type === "hypagraph.action.selected"
        ? { lane: event.data.dispatch.lane as string, kind: event.data.dispatch.action.kind as string }
        : { lane: "model", kind: event.data.action.kind as string });
    expect(selections).toEqual([
      { lane: "model", kind: "start-ready-task" },
      { lane: "deterministic", kind: "run-ready-check" },
      { lane: "model", kind: "start-ready-task" },
      { lane: "deterministic", kind: "run-ready-check" },
      { lane: "deterministic", kind: "evaluate-ready-gate" },
      { lane: "model", kind: "start-ready-task" },
      { lane: "deterministic", kind: "run-ready-check" },
      { lane: "deterministic", kind: "evaluate-ready-gate" },
      { lane: "model", kind: "start-ready-task" },
    ]);

    const modelActions = selections.filter((item) => item.lane === "model").length;
    const deterministicActions = selections.filter((item) => item.lane === "deterministic").length;

    // Before M6A every selected action was delivered as a Pi follow-up and charged one turn.
    const modelTurnsBeforeM6A = selections.length;
    const modelTurnsAfterM6A = state.goal!.budget.consumedTurns;
    expect(modelActions).toBe(4);
    expect(deterministicActions).toBe(5);
    expect(modelTurnsBeforeM6A).toBe(9);
    expect(modelTurnsAfterM6A).toBe(4);
    expect(state.goal?.schedulerOrdinal).toBe(9);
    expect(state.goal?.budget.consumedTokens.totalTokens).toBe(4 * 15);

    // The canonical result does not change.
    expect(state.phase).toBe("completed");
    expect(state.goal?.status).toBe("completed");
    expect(state.runtime.loops["lint-repair"]).toMatchObject({
      status: "succeeded",
      currentIteration: 2,
      exitReason: "success",
    });
    expect(state.runtime.nodes.lint?.status).toBe("succeeded");
    expect(state.runtime.nodes.lint?.attemptCount).toBe(2);
    expect(state.runtime.nodes.documentation?.status).toBe("succeeded");
    expect(state.runtime.routes.route).toMatchObject({ outcomeId: "true", targetNodeIds: ["release-note"] });
    expect(state.runtime.routes["publish-gate"]).toMatchObject({ outcomeId: "true", targetNodeIds: ["publish"] });
    expect(state.runtime.nodes.investigate?.status).toBe("skipped");
    expect(state.runtime.nodes["revise-documentation"]?.status).toBe("skipped");

    // Replay reproduces the same state and the same stop decision.
    expect(replayEvents(allEvents(value))).toEqual(state);
    const surface = projectHypagoalSurface(state)!;
    expect(surface.dispatch).toMatchObject({ scheduledActions: 9, chargedModelTurns: 4 });
    expect(surface.budget.turns).toMatchObject({ consumed: 4, limit: 12, remaining: 8 });

    const promptCountBeforeRestore = prompts(value).length;
    await invoke(value, "session_start", { type: "session_start", reason: "reload" });
    expect(prompts(value)).toHaveLength(promptCountBeforeRestore);
    const restored = latestState(value);
    expect(restored.phase).toBe("completed");
    expect(restored.goal.status).toBe("completed");
    expect(restored.snapshotHash).toBe(state.snapshotHash);
  }, 60_000);
});
