import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
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

const objective = "Ship the authenticated upload flow, pass the protected quality gate, pass the independent documentation audit, and publish release notes.";

const definition = () => ({
  title: "v0.6 release dogfood",
  goal: objective,
  nodes: [
    {
      id: "refine",
      title: "Refine implementation",
      requires: ["evaluate"],
      acceptance: [],
      produces: [{ name: "quality.score", type: "number", required: true }],
    },
    {
      id: "evaluate",
      title: "Evaluate implementation",
      kind: "check",
      requires: ["refine"],
      acceptance: [],
      produces: [
        { name: "quality.valid", type: "boolean", required: true },
        { name: "quality.passed", type: "boolean", required: true },
        { name: "quality.score", type: "number", required: true },
      ],
      check: {
        kind: "metric-report",
        command: "node",
        arguments: ["-e", "process.exit(0)"],
        timeoutMs: 1_000,
        reportPath: "quality.json",
        parser: { name: "metric-json", version: 1 },
        namespace: "quality",
        mappings: [
          { source: "valid", fact: "quality.valid", type: "boolean", required: true },
          { source: "passed", fact: "quality.passed", type: "boolean", required: true },
          { source: "score", fact: "quality.score", type: "number", required: true },
        ],
        evaluation: {
          kind: "development",
          feedback: { mode: "bounded-diagnostics", maximumDiagnosticItems: 2, exposeRawReport: false },
          integrity: { trustLevel: "protected" },
        },
      },
    },
    {
      id: "audit",
      title: "Prepare documentation audit",
      requires: ["audit-result"],
      acceptance: [],
      produces: [{ name: "docs.ready", type: "boolean", required: true }],
    },
    {
      id: "audit-result",
      title: "Evaluate documentation audit",
      kind: "check",
      requires: ["audit"],
      acceptance: [],
      produces: [{ name: "docs.passed", type: "boolean", required: true }],
      check: {
        kind: "command",
        command: "node",
        arguments: ["-e", "process.exit(0)"],
        timeoutMs: 1_000,
        publish: [{ source: "passed", fact: "docs.passed" }],
      },
    },
    {
      id: "probe",
      title: "Run holdout probe",
      kind: "check",
      requires: ["evaluate", "audit-result"],
      acceptance: [],
      produces: [{ name: "probe.passed", type: "boolean", required: true }],
      check: {
        kind: "metric-report",
        command: "node",
        arguments: ["-e", "process.exit(0)"],
        timeoutMs: 1_000,
        reportPath: "probe.json",
        parser: { name: "metric-json", version: 1 },
        namespace: "probe",
        mappings: [{ source: "passed", fact: "probe.passed", type: "boolean", required: true }],
        evaluation: {
          kind: "probe",
          feedback: { mode: "aggregate" },
          integrity: { trustLevel: "protected" },
        },
      },
    },
    {
      id: "route",
      title: "Route probe outcome",
      kind: "gate",
      requires: ["probe"],
      acceptance: [],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "probe.passed" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["finalize"],
        onFalse: ["repair-probe"],
      },
    },
    { id: "repair-probe", title: "Repair failed probe", requires: ["route"], acceptance: [] },
    { id: "finalize", title: "Finalize release", requires: ["route"], acceptance: [] },
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
        left: { kind: "fact", name: "quality.passed" },
        operator: "eq",
        right: { kind: "literal", value: true },
      },
      progress: { fact: "quality.score", direction: "maximize", minDelta: 0.2 },
      evaluation: {
        validWhen: {
          kind: "compare",
          left: { kind: "fact", name: "quality.valid" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        maximumInvalidEvaluations: 2,
      },
      patience: 2,
      maxIterations: 4,
    },
    {
      id: "documentation-audit",
      nodes: ["audit", "audit-result"],
      entry: "audit",
      evaluateAfter: "audit-result",
      feedbackEdges: [{ from: "audit-result", to: "audit" }],
      successWhen: {
        kind: "compare",
        left: { kind: "fact", name: "docs.passed" },
        operator: "eq",
        right: { kind: "literal", value: true },
      },
      maxIterations: 2,
    },
  ],
  evaluation: {
    budget: {
      maximumEvaluations: 6,
      maximumDevelopmentEvaluations: 4,
      maximumProbeEvaluations: 1,
    },
  },
  policy: { mode: "guided", requireEvidence: false },
});

const revisedDefinition = () => {
  const value = definition();
  value.nodes = value.nodes.flatMap((node) => node.id === "finalize"
    ? [
      { id: "write-release-note", title: "Write release note", requires: ["route"], acceptance: [] },
      { ...node, requires: ["write-release-note"] },
    ]
    : [node]);
  return value;
};

const harness = () => {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: any[] = [];
  const sendUserMessage = vi.fn();
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
    cwd: process.cwd(),
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
  return { tools, commands, handlers, entries, sendUserMessage, ctx };
};

const invoke = async (value: ReturnType<typeof harness>, name: string, event: any) => {
  const results = [];
  for (const handler of value.handlers.get(name) ?? []) results.push(await handler(event, value.ctx));
  return results;
};

const agentEnd = async (value: ReturnType<typeof harness>) => {
  await invoke(value, "agent_end", {
    type: "agent_end",
    messages: [{
      role: "assistant",
      content: [],
      usage: { input: 8, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    }],
  });
};

const beforeAgentStart = async (value: ReturnType<typeof harness>, prompt: string): Promise<void> => {
  await invoke(value, "before_agent_start", {
    type: "before_agent_start",
    prompt,
    systemPrompt: "base",
    systemPromptOptions: {},
  });
};

const continuationPrompts = (value: ReturnType<typeof harness>): string[] => value.sendUserMessage.mock.calls
  .map((call) => String(call[0]))
  .filter((prompt) => prompt.startsWith("Hypagraph automatic continuation.") || prompt.startsWith("Hypagraph automatic bounded revision."));

const latestState = (value: ReturnType<typeof harness>): any => value.entries
  .filter((entry) => entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE)
  .at(-1)?.data.snapshot;

const transition = async (
  value: ReturnType<typeof harness>,
  nodeId: string,
  action: string,
  extra: Record<string, unknown> = {},
) => value.tools.get("hypagraph_transition")!.execute(
  `${nodeId}-${action}-${value.entries.length}`,
  { nodeId, action, ...extra },
  undefined,
  undefined,
  value.ctx,
);

const completeTask = async (
  value: ReturnType<typeof harness>,
  nodeId: string,
  facts: Array<{ name: string; type: string; value: unknown }> = [],
) => {
  await transition(value, nodeId, "start");
  if (facts.length > 0) await transition(value, nodeId, "publish", { facts });
  await transition(value, nodeId, "submit", { evidence: [] });
  await transition(value, nodeId, "verify", { passed: true });
};

const runCheck = async (
  value: ReturnType<typeof harness>,
  nodeId: string,
  result: any,
) => value.tools.get("hypagraph_run_check")!.execute(
  `run-${nodeId}-${value.entries.length}`,
  { nodeId },
  undefined,
  undefined,
  {
    ...value.ctx,
    __hypagraphTestCheckResult: result,
  },
);

const selectedAction = (prompt: string): { kind: string; nodeId?: string; blocker?: string } => {
  if (prompt.startsWith("Hypagraph automatic bounded revision.")) return { kind: "request-revision" };
  const line = prompt.split("\n").find((item) => item.startsWith("Selected action:"));
  if (!line) throw new Error(`No selected action in prompt:\n${prompt}`);
  const task = line.match(/(?:continue active task|start ready task|run ready check|evaluate ready gate) '([^']+)'/);
  if (!task?.[1]) throw new Error(`Unknown selected action: ${line}`);
  return {
    kind: line.includes("continue active task") ? "continue-active-task"
      : line.includes("start ready task") ? "start-ready-task"
        : line.includes("run ready check") ? "run-ready-check"
          : "evaluate-ready-gate",
    nodeId: task[1],
  };
};

const qualityResult = (
  attemptId: string,
  valid: boolean,
  passed: boolean,
  score: number,
  diagnostics: Array<{ code: string; message: string }> = [],
) => ({
  checkKind: "metric-report",
  attemptId,
  startedAt: "2026-07-25T09:00:00.000Z",
  completedAt: "2026-07-25T09:00:01.000Z",
  status: "passed",
  facts: [
    { name: "quality.valid", type: "boolean", value: valid },
    { name: "quality.passed", type: "boolean", value: passed },
    { name: "quality.score", type: "number", value: score },
  ],
  evidence: [],
  evaluation: {
    kind: "development",
    feedbackMode: "bounded-diagnostics",
    diagnostics,
    diagnosticsTruncated: false,
    integrity: {
      version: 1,
      trustLevel: "protected",
      status: "valid",
      evaluatorFingerprint: "dogfood-quality-evaluator",
      diagnosticCodes: diagnostics.map((item) => item.code),
      protectedEvidence: [],
    },
  },
});

const auditResult = (attemptId: string) => ({
  checkKind: "command",
  attemptId,
  startedAt: "2026-07-25T09:00:00.000Z",
  completedAt: "2026-07-25T09:00:01.000Z",
  status: "passed",
  exitCode: 0,
  facts: [{ name: "docs.passed", type: "boolean", value: true }],
  evidence: [],
});

const probeResult = (attemptId: string) => ({
  checkKind: "metric-report",
  attemptId,
  startedAt: "2026-07-25T09:00:00.000Z",
  completedAt: "2026-07-25T09:00:01.000Z",
  status: "passed",
  facts: [{ name: "probe.passed", type: "boolean", value: true }],
  evidence: [],
  evaluation: {
    kind: "probe",
    feedbackMode: "aggregate",
    diagnostics: [],
    diagnosticsTruncated: false,
    integrity: {
      version: 1,
      trustLevel: "protected",
      status: "valid",
      evaluatorFingerprint: "dogfood-probe-evaluator",
      diagnosticCodes: [],
      protectedEvidence: [],
    },
  },
});

describe("M5B v0.6 release dogfood", () => {
  it("runs concurrent loop components, protected evaluation, reload recovery, probe routing, and bounded revision", async () => {
    const value = harness();
    await value.tools.get("hypagoal_start")!.execute(
      "dogfood-create",
      { objective, definition: definition(), budget: { maximumTurns: 20, maximumTokens: 2_000 } },
      undefined,
      undefined,
      value.ctx,
    );

    const selected: string[] = [];
    const evaluationSnapshots: any[] = [];
    let handledPrompts = 0;
    let qualityTurn = 0;
    let reloadVerified = false;

    for (let step = 0; step < 30 && latestState(value)?.goal.status !== "completed"; step += 1) {
      await agentEnd(value);
      const prompts = continuationPrompts(value);
      if (prompts.length <= handledPrompts) continue;
      const prompt = prompts[handledPrompts++]!;
      const action = selectedAction(prompt);
      const before = latestState(value);
      await beforeAgentStart(value, prompt);

      if (action.kind === "request-revision") {
        selected.push("revision");
        await value.tools.get("hypagoal_submit_revision")!.execute(
          "dogfood-revision",
          { definition: revisedDefinition() },
          undefined,
          undefined,
          value.ctx,
        );
        await agentEnd(value);
        continue;
      }

      const loopId = action.nodeId === "refine" || action.nodeId === "evaluate" ? "quality"
        : action.nodeId === "audit" || action.nodeId === "audit-result" ? "documentation-audit"
          : "root";
      const iteration = loopId === "root" ? 0 : before.runtime.loops[loopId].currentIteration;
      selected.push(`${action.nodeId}:${loopId}:${iteration}`);

      if (action.nodeId === "refine") {
        await completeTask(value, "refine");
      } else if (action.nodeId === "evaluate") {
        qualityTurn += 1;
        const attemptId = `quality-evaluate-${qualityTurn}`;
        const result = qualityTurn === 1
          ? qualityResult(attemptId, false, false, 0.1, [{ code: "invalid-format", message: "The protected evaluator rejected malformed output." }])
          : qualityTurn === 2
            ? qualityResult(attemptId, true, false, 0.4, [{ code: "quality-low", message: "Improve the authenticated upload path." }])
            : qualityTurn === 3
              ? qualityResult(attemptId, true, false, 0.7, [{ code: "quality-near", message: "Add the final protected-path assertion." }])
              : qualityResult(attemptId, true, true, 0.9);
        await runCheck(value, "evaluate", result);
        evaluationSnapshots.push(structuredClone(latestState(value).runtime.loops.quality));
      } else if (action.nodeId === "audit") {
        await completeTask(value, "audit", [{ name: "docs.ready", type: "boolean", value: true }]);
      } else if (action.nodeId === "audit-result") {
        await runCheck(value, "audit-result", auditResult("documentation-audit-result"));
      } else if (action.nodeId === "probe") {
        await runCheck(value, "probe", probeResult("release-probe"));
      } else if (action.nodeId === "route") {
        await transition(value, "route", "evaluate");
      } else if (action.nodeId === "finalize" && before.goal.automaticRevision.consumedAttempts === 0) {
        await transition(value, "finalize", "block", {
          reason: "A bounded release-note step is missing.",
          blockerKind: "repository-work",
        });
      } else if (action.nodeId === "finalize") {
        await completeTask(value, "finalize");
      } else if (action.nodeId === "write-release-note") {
        await completeTask(value, "write-release-note");
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
    expect(state.goal.schedulerOrdinal).toBe(selected.length + 1);
    expect(state.goal.continuationOrdinal).toBe(selected.length + 1);

    const eventTypes = value.entries.flatMap((entry) => entry.data?.events?.map((event: any) => event.type) ?? []);
    expect(eventTypes).toContain("hypagraph.workflow.revised");
    expect(eventTypes).toContain("hypagraph.goal.completed");
    const actionSelections = value.entries.flatMap((entry) => entry.data?.events
      ?.filter((event: any) => event.type === "hypagraph.action.selected")
      .map((event: any) => event.data.dispatch) ?? []);
    expect(actionSelections).toContainEqual(expect.objectContaining({
      lane: "deterministic",
      action: expect.objectContaining({ kind: "evaluate-ready-gate", nodeId: "route" }),
    }));

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
