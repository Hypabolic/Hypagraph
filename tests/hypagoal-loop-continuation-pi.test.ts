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

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const evaluatorProgram = `
const fs = require("node:fs");
const counterPath = ".slice5-evaluation-count";
const current = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) : 0;
const next = current + 1;
fs.writeFileSync(counterPath, String(next));
const reports = [
  { schemaVersion: 1, valid: false, accepted: false, score: 0.1 },
  { schemaVersion: 1, valid: true, accepted: false, score: 0.4 },
  { schemaVersion: 1, valid: true, accepted: false, score: 0.7 },
  { schemaVersion: 1, valid: true, accepted: true, score: 0.9 }
];
fs.writeFileSync("metrics.json", JSON.stringify(reports[Math.min(next - 1, reports.length - 1)]));
`;

const objective = "Improve a candidate through measured refinement while completing an independent bounded documentation audit.";

const rootInput = () => ({
  objective,
  budget: { maximumTurns: 20, maximumTokens: 1_000 },
  definition: {
    title: "Measured refinement with independent audit",
    goal: objective,
    nodes: [
      { id: "refine", title: "Refine the candidate", requires: ["evaluate"], acceptance: [] },
      {
        id: "evaluate",
        title: "Evaluate the candidate",
        kind: "check",
        requires: ["refine"],
        acceptance: [],
        produces: [
          { name: "evaluation.valid", type: "boolean", required: true },
          { name: "evaluation.accepted", type: "boolean", required: true },
          { name: "evaluation.score", type: "number", required: true },
        ],
        check: {
          kind: "metric-report",
          command: process.execPath,
          arguments: ["-e", evaluatorProgram],
          timeoutMs: 30_000,
          reportPath: "metrics.json",
          parser: { name: "metric-json", version: 1 },
          mappings: [
            { source: "valid", fact: "evaluation.valid", type: "boolean" },
            { source: "accepted", fact: "evaluation.accepted", type: "boolean" },
            { source: "score", fact: "evaluation.score", type: "number" },
          ],
          evaluation: {
            kind: "development",
            feedback: { mode: "aggregate" },
            integrity: {
              trustLevel: "transparent",
              evaluatorVersion: { value: "slice5-smoke-v1" },
            },
          },
        },
      },
      { id: "audit", title: "Audit the documentation", requires: ["audit-result"], acceptance: [] },
      {
        id: "audit-result",
        title: "Record the audit result",
        requires: ["audit"],
        acceptance: [],
        produces: [{ name: "audit.complete", type: "boolean", required: true }],
      },
    ],
    loops: [
      {
        id: "quality",
        nodes: ["refine", "evaluate"],
        entry: "refine",
        evaluateAfter: "evaluate",
        feedbackEdges: [{ from: "evaluate", to: "refine" }],
        successWhen: {
          kind: "compare",
          left: { kind: "fact", name: "evaluation.accepted" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        maxIterations: 4,
        progress: { fact: "evaluation.score", direction: "maximize", minDelta: 0.05 },
        patience: 3,
        evaluation: {
          validWhen: {
            kind: "compare",
            left: { kind: "fact", name: "evaluation.valid" },
            operator: "eq",
            right: { kind: "literal", value: true },
          },
          maximumInvalidEvaluations: 2,
        },
        failurePolicy: "fail-workflow",
      },
      {
        id: "documentation-audit",
        nodes: ["audit", "audit-result"],
        entry: "audit",
        evaluateAfter: "audit-result",
        feedbackEdges: [{ from: "audit-result", to: "audit" }],
        successWhen: {
          kind: "compare",
          left: { kind: "fact", name: "audit.complete" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        maxIterations: 2,
        failurePolicy: "record-and-continue",
      },
    ],
    evaluation: { budget: { maximumEvaluations: 4, maximumDevelopmentEvaluations: 4 } },
    policy: { mode: "guided", requireEvidence: false },
  },
});

const harness = (cwd: string) => {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: any[] = [];
  const sendUserMessage = vi.fn();
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
    setActiveTools: vi.fn((tools: string[]) => { activeTools = [...tools]; }),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      confirm: vi.fn().mockResolvedValue(true),
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: { getBranch: () => entries },
  };
  hypagraphExtension(pi);
  return { tools, handlers, entries, sendUserMessage, ctx };
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

const agentEnd = async (value: ReturnType<typeof harness>) => invoke(value, "agent_end", {
  type: "agent_end",
  messages: [{
    role: "assistant",
    content: [],
    usage: { input: 6, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 11 },
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
  `${nodeId}-${action}`,
  { nodeId, action, ...extra },
  undefined,
  undefined,
  value.ctx,
);

const completeTask = async (
  value: ReturnType<typeof harness>,
  nodeId: string,
  facts?: Array<{ name: string; type: string; value: unknown }>,
) => {
  await transition(value, nodeId, "start");
  if (facts) await transition(value, nodeId, "publish", { facts });
  await transition(value, nodeId, "submit", { evidence: [] });
  await transition(value, nodeId, "verify", { passed: true });
};

describe("M5B Slice 5 Pi loop continuation", () => {
  it("interleaves an independent region, rejects one invalid evaluation, improves for three iterations, and completes through typed success", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-slice5-smoke-"));
    roots.push(root);
    const value = harness(root);
    await value.tools.get("hypagoal_start")!.execute("create-root", rootInput(), undefined, undefined, value.ctx);

    const selected: string[] = [];
    const evaluationSnapshots: any[] = [];
    let observedPromptCount = 0;
    await agentEnd(value);

    for (let guard = 0; guard < 20; guard += 1) {
      const automaticPrompts = prompts(value);
      if (automaticPrompts.length === observedPromptCount) break;
      const prompt = automaticPrompts.at(-1)!;
      observedPromptCount = automaticPrompts.length;
      const before = latestState(value);
      const action = before.goal.pendingContinuation.action;
      const loop = action.loopId ? before.runtime.loops[action.loopId] : undefined;
      selected.push(`${action.nodeId}:${action.loopId ?? "none"}:${loop?.currentIteration ?? 0}`);
      const system = await deliver(value, prompt);
      expect(system).toContain(`Loop '${action.loopId}'`);
      expect(system).toContain("Independent runnable components remain eligible");

      if (action.nodeId === "refine" || action.nodeId === "audit") {
        await completeTask(value, action.nodeId);
      } else if (action.nodeId === "audit-result") {
        await completeTask(value, action.nodeId, [{ name: "audit.complete", type: "boolean", value: true }]);
      } else if (action.nodeId === "evaluate") {
        await value.tools.get("hypagraph_run_check")!.execute("run-evaluator", { nodeId: "evaluate" }, undefined, undefined, value.ctx);
        evaluationSnapshots.push(structuredClone(latestState(value).runtime.loops.quality));
      } else {
        throw new Error(`Unexpected selected node '${action.nodeId}'.`);
      }
      await agentEnd(value);
    }

    const state = latestState(value);
    expect(selected).toEqual([
      "refine:quality:0",
      "audit:documentation-audit:0",
      "evaluate:quality:1",
      "audit-result:documentation-audit:1",
      "refine:quality:2",
      "evaluate:quality:2",
      "refine:quality:3",
      "evaluate:quality:3",
      "refine:quality:4",
      "evaluate:quality:4",
    ]);
    expect(selected.filter((item) => item.startsWith("evaluate:"))).toHaveLength(4);
    expect(evaluationSnapshots[0]).toMatchObject({
      currentIteration: 2,
      invalidEvaluationCount: 1,
      noProgressCount: 0,
    });
    expect(evaluationSnapshots[0].bestMetric).toBeUndefined();
    expect(evaluationSnapshots[1]).toMatchObject({ currentIteration: 3, currentMetric: 0.4, bestMetric: 0.4, bestIteration: 2 });
    expect(evaluationSnapshots[2]).toMatchObject({ currentIteration: 4, currentMetric: 0.7, bestMetric: 0.7, bestIteration: 3 });
    expect(evaluationSnapshots[3]).toMatchObject({ status: "succeeded", currentMetric: 0.9, bestMetric: 0.9, bestIteration: 4, exitReason: "success" });
    expect(state.runtime.loops["documentation-audit"]).toMatchObject({ status: "succeeded", currentIteration: 1, exitReason: "success" });
    expect(state.runtime.evaluations).toMatchObject({ total: 4, development: 4 });
    expect(state.phase).toBe("completed");
    expect(state.goal.status).toBe("completed");
    expect(state.goal.budget.consumedTurns).toBe(selected.length);
    expect(state.goal.budget.consumedTokens.totalTokens).toBe(selected.length * 11);
    expect(prompts(value)).toHaveLength(selected.length);

    const promptCountBeforeRestore = prompts(value).length;
    await invoke(value, "session_start", { type: "session_start", reason: "reload" });
    const restored = latestState(value);
    expect(prompts(value)).toHaveLength(promptCountBeforeRestore);
    expect(restored.runtime.loops.quality).toMatchObject({
      status: "succeeded",
      currentMetric: 0.9,
      bestMetric: 0.9,
      bestIteration: 4,
      invalidEvaluationCount: 1,
    });
    expect(restored.runtime.evaluations).toMatchObject({ total: 4, development: 4 });
    expect(restored.goal.budget).toMatchObject({ consumedTurns: selected.length, consumedTokens: { totalTokens: selected.length * 11 } });
  }, 30_000);
});
