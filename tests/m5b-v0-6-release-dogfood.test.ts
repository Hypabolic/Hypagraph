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

const developmentEvaluatorProgram = `
const fs = require("node:fs");
const counterPath = ".v0.6-development-count";
const current = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) : 0;
const next = current + 1;
fs.writeFileSync(counterPath, String(next));
const reports = [
  { schemaVersion: 1, valid: false, accepted: false, score: 0.1 },
  { schemaVersion: 1, valid: true, accepted: false, score: 0.4 },
  { schemaVersion: 1, valid: true, accepted: false, score: 0.7 },
  { schemaVersion: 1, valid: true, accepted: true, score: 0.9 }
];
fs.writeFileSync("development-metrics.json", JSON.stringify(reports[Math.min(next - 1, reports.length - 1)]));
`;

const probeEvaluatorProgram = `
const fs = require("node:fs");
fs.writeFileSync("probe-metrics.json", JSON.stringify({
  schemaVersion: 1,
  valid: true,
  accepted: true,
  score: 0.95
}));
`;

const objective = "Prepare a measured v0.6 release candidate and preserve every required verification safeguard.";

const baseDefinition = () => ({
  title: "Measured v0.6 release candidate",
  goal: objective,
  nodes: [
    { id: "refine", title: "Refine the release candidate", requires: ["evaluate"], acceptance: [] },
    {
      id: "evaluate",
      title: "Evaluate the release candidate",
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
        arguments: ["-e", developmentEvaluatorProgram],
        timeoutMs: 30_000,
        reportPath: "development-metrics.json",
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
            evaluatorVersion: { value: "v0.6-release-development-v1" },
          },
        },
      },
    },
    { id: "audit", title: "Audit release documentation", requires: ["audit-result"], acceptance: [] },
    {
      id: "audit-result",
      title: "Record the documentation audit",
      requires: ["audit"],
      acceptance: [],
      produces: [{ name: "audit.complete", type: "boolean", required: true }],
    },
    {
      id: "probe",
      title: "Run the release generalization probe",
      kind: "check",
      requires: ["evaluate", "audit-result"],
      acceptance: [],
      produces: [
        { name: "probe.valid", type: "boolean", required: true },
        { name: "probe.accepted", type: "boolean", required: true },
        { name: "probe.score", type: "number", required: true },
      ],
      check: {
        kind: "metric-report",
        command: process.execPath,
        arguments: ["-e", probeEvaluatorProgram],
        timeoutMs: 30_000,
        reportPath: "probe-metrics.json",
        parser: { name: "metric-json", version: 1 },
        mappings: [
          { source: "valid", fact: "probe.valid", type: "boolean" },
          { source: "accepted", fact: "probe.accepted", type: "boolean" },
          { source: "score", fact: "probe.score", type: "number" },
        ],
        evaluation: {
          kind: "probe",
          feedback: { mode: "aggregate" },
          integrity: {
            trustLevel: "transparent",
            evaluatorVersion: { value: "v0.6-release-probe-v1" },
          },
        },
      },
    },
    {
      id: "route",
      title: "Select the release route",
      kind: "gate",
      requires: ["probe"],
      acceptance: [],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "probe.accepted" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["finalize"],
        onFalse: ["repair-probe"],
      },
    },
    {
      id: "finalize",
      title: "Finalize the v0.6 release candidate",
      requires: ["route"],
      acceptance: ["Preserve the release verification path"],
      scope: { paths: ["docs/**"] },
    },
    {
      id: "repair-probe",
      title: "Repair the rejected probe result",
      requires: ["route"],
      acceptance: ["Preserve the release verification path"],
      scope: { paths: ["src/**", "tests/**"] },
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
  evaluation: {
    budget: {
      maximumEvaluations: 5,
      maximumDevelopmentEvaluations: 4,
      maximumProbeEvaluations: 1,
    },
  },
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
    setActiveTools: vi.fn((tools: string[]) => { activeTools = [...tools]; }),
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

const continuationPrompts = (value: ReturnType<typeof harness>): string[] => value.sendUserMessage.mock.calls
  .map((call) => String(call[0]))
  .filter((prompt) => prompt.startsWith("Hypagraph automatic continuation.")
    || prompt.startsWith("Hypagraph automatic bounded revision."));

const creationRequestFromPrompt = (prompt: string): unknown => {
  const match = prompt.match(/Use this exact creation request identity without changing any field:\n(\{[\s\S]*?\})\n\nCall hypagoal_start/);
  if (!match?.[1]) throw new Error("The authoring prompt did not contain a creation request identity.");
  return JSON.parse(match[1]);
};

const agentEnd = async (value: ReturnType<typeof harness>) => invoke(value, "agent_end", {
  type: "agent_end",
  messages: [{
    role: "assistant",
    content: [],
    usage: { input: 8, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 13 },
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

const startThroughCommand = async (value: ReturnType<typeof harness>) => {
  await value.commands.get("hypagoal")!.handler(objective, value.ctx);
  const authoringPrompt = String(value.sendUserMessage.mock.calls.at(-1)?.[0]);
  const creationRequest = creationRequestFromPrompt(authoringPrompt);
  await value.tools.get("hypagoal_start")!.execute(
    "create-release-goal",
    {
      objective,
      definition: baseDefinition(),
      budget: { maximumTurns: 30, maximumTokens: 5_000 },
      creationRequest,
    },
    undefined,
    undefined,
    value.ctx,
  );
};

describe("M5B v0.6 release dogfood", () => {
  it("runs the integrated root Hypagoal release path and completes only from canonical state", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-v0.6-release-"));
    roots.push(root);
    const value = harness(root);

    expect(value.tools.has("hypagoal_complete")).toBe(false);
    await startThroughCommand(value);
    expect(latestState(value).definition.goal).toBe(objective);
    expect(continuationPrompts(value)).toEqual([]);

    const selected: string[] = [];
    const evaluationSnapshots: any[] = [];
    let observedPromptCount = 0;
    let reloadVerified = false;
    await agentEnd(value);

    for (let guard = 0; guard < 30; guard += 1) {
      const automaticPrompts = continuationPrompts(value);
      if (automaticPrompts.length === observedPromptCount) break;
      const prompt = automaticPrompts.at(-1)!;
      observedPromptCount = automaticPrompts.length;
      const before = latestState(value);
      const action = before.goal.pendingContinuation?.action;
      if (!action) break;

      if (action.kind === "request-revision") {
        selected.push("revision");
        const system = await deliver(value, prompt);
        expect(system).toContain("HYPAGOAL BOUNDED REVISION CONTROL");
        expect(system).toContain(`Exact objective: ${objective}`);

        const revised = baseDefinition();
        revised.nodes = [
          ...revised.nodes.filter((node) => node.id !== "finalize"),
          {
            id: "write-release-note",
            title: "Write the missing release note",
            requires: ["route"],
            acceptance: ["Add the bounded missing release documentation"],
            scope: { paths: ["docs/**"] },
          },
          {
            id: "finalize",
            title: "Finalize the v0.6 release candidate",
            requires: ["route", "write-release-note"],
            acceptance: ["Preserve the release verification path"],
            scope: { paths: ["docs/**"] },
          },
        ];
        await value.tools.get("hypagoal_submit_revision")!.execute(
          "submit-release-revision",
          revised,
          undefined,
          undefined,
          value.ctx,
        );
        await agentEnd(value);
        continue;
      }

      const loop = action.loopId ? before.runtime.loops[action.loopId] : undefined;
      selected.push(`${action.nodeId}:${action.loopId ?? "root"}:${loop?.currentIteration ?? 0}`);
      const system = await deliver(value, prompt);

      if (action.loopId) {
        expect(system).toContain(`Loop '${action.loopId}'`);
        expect(system).toContain("Independent runnable components remain eligible");
      }

      if (action.nodeId === "refine" || action.nodeId === "audit" || action.nodeId === "write-release-note") {
        await completeTask(value, action.nodeId);
      } else if (action.nodeId === "audit-result") {
        await completeTask(value, action.nodeId, [{ name: "audit.complete", type: "boolean", value: true }]);
      } else if (action.nodeId === "evaluate") {
        await value.tools.get("hypagraph_run_check")!.execute(
          `run-development-${evaluationSnapshots.length + 1}`,
          { nodeId: "evaluate" },
          undefined,
          undefined,
          value.ctx,
        );
        evaluationSnapshots.push(structuredClone(latestState(value).runtime.loops.quality));
      } else if (action.nodeId === "probe") {
        await value.tools.get("hypagraph_run_check")!.execute(
          "run-release-probe",
          { nodeId: "probe" },
          undefined,
          undefined,
          value.ctx,
        );
      } else if (action.nodeId === "route") {
        await transition(value, "route", "evaluate");
      } else if (action.nodeId === "finalize" && before.goal.automaticRevision.consumedAttempts === 0) {
        await transition(value, "finalize", "block", {
          reason: "A bounded release-note step is missing.",
          blockerKind: "repository-work",
        });
      } else if (action.nodeId === "finalize") {
        await completeTask(value, "finalize");
      } else {
        throw new Error(`Unexpected selected node '${action.nodeId}'.`);
      }

      await agentEnd(value);

      if (action.nodeId === "evaluate" && evaluationSnapshots.length === 1 && !reloadVerified) {
        const promptCountBeforeReload = continuationPrompts(value).length;
        await invoke(value, "session_start", { type: "session_start", reason: "reload" });
        expect(continuationPrompts(value)).toHaveLength(promptCountBeforeReload);
        expect(latestState(value).goal).toMatchObject({ status: "paused", pauseCause: "session_reload" });

        await value.commands.get("hypagoal")!.handler("resume", value.ctx);
        expect(latestState(value).goal.status).toBe("active");
        expect(continuationPrompts(value)).toHaveLength(promptCountBeforeReload + 1);
        reloadVerified = true;
      }
    }

    const state = latestState(value);
    expect(reloadVerified).toBe(true);
    expect(selected.slice(0, 10)).toEqual([
      "refine:quality:0",
      "audit:documentation-audit:0",
      "evaluate:quality:1",
      "refine:quality:2",
      "audit-result:documentation-audit:1",
      "evaluate:quality:2",
      "refine:quality:3",
      "evaluate:quality:3",
      "refine:quality:4",
      "evaluate:quality:4",
    ]);
    expect(selected.slice(10)).toEqual([
      "probe:root:0",
      "route:root:0",
      "finalize:root:0",
      "revision",
      "write-release-note:root:0",
      "finalize:root:0",
    ]);

    expect(evaluationSnapshots[0]).toMatchObject({
      invalidEvaluationCount: 1,
      noProgressCount: 0,
    });
    expect(evaluationSnapshots[0].bestMetric).toBeUndefined();
    expect(evaluationSnapshots[1]).toMatchObject({ currentMetric: 0.4, bestMetric: 0.4 });
    expect(evaluationSnapshots[2]).toMatchObject({ currentMetric: 0.7, bestMetric: 0.7 });
    expect(evaluationSnapshots[3]).toMatchObject({
      status: "succeeded",
      currentMetric: 0.9,
      bestMetric: 0.9,
      bestIteration: 4,
      exitReason: "success",
    });

    expect(state.definition.goal).toBe(objective);
    expect(state.phase).toBe("completed");
    expect(state.goal.status).toBe("completed");
    expect(state.runtime.loops["documentation-audit"]).toMatchObject({
      status: "succeeded",
      currentIteration: 1,
      exitReason: "success",
    });
    expect(state.runtime.nodes.probe.status).toBe("succeeded");
    expect(state.runtime.nodes["repair-probe"].status).toBe("skipped");
    expect(state.runtime.nodes["write-release-note"].status).toBe("succeeded");
    expect(state.runtime.nodes.finalize.status).toBe("succeeded");
    expect(state.runtime.evaluations).toMatchObject({ total: 5, development: 4, probe: 1 });
    expect(state.goal.automaticRevision).toMatchObject({
      consumedAttempts: 1,
      lastAttempt: { outcome: "applied" },
    });
    expect(state.goal.budget).toMatchObject({
      consumedTurns: selected.length,
      consumedTokens: { totalTokens: selected.length * 13 },
    });

    const eventTypes = value.entries.flatMap((entry) => entry.data?.events?.map((event: any) => event.type) ?? []);
    expect(eventTypes).toContain("hypagraph.workflow.revised");
    expect(eventTypes).toContain("hypagraph.goal.completed");

    const familyReference = {
      goalId: state.goal.goalId,
      workflowId: state.workflowId,
      eventSequence: state.sequence,
      snapshotHash: state.snapshotHash,
    };
    const promptCountBeforeRestore = continuationPrompts(value).length;
    await invoke(value, "session_start", { type: "session_start", reason: "reload" });
    const restored = latestState(value);
    expect(continuationPrompts(value)).toHaveLength(promptCountBeforeRestore);
    expect({
      goalId: restored.goal.goalId,
      workflowId: restored.workflowId,
      eventSequence: restored.sequence,
      snapshotHash: restored.snapshotHash,
    }).toEqual(familyReference);
    expect(restored.phase).toBe("completed");
    expect(restored.goal.status).toBe("completed");
  }, 60_000);
});
