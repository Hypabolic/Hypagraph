import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { explainNode } from "../src/history/explain.js";
import { compareReplayWithLive, replayToSequence } from "../src/history/replay.js";
import { projectRevisionHistory } from "../src/history/revisions.js";
import { filterTimelineByLane, projectEventTimeline } from "../src/history/timeline.js";
import type { HypagraphState } from "../src/domain/model.js";
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

const objective = "Repair the failing lint rule, prepare the release note, and verify the released documentation.";

/** The lint check fails on its first attempt and passes after the repair marker exists. */
const lintProgram = "const fs = require('node:fs');"
  + "const marker = 'repair.complete';"
  + "if (fs.existsSync(marker)) process.exit(0);"
  + "fs.writeFileSync(marker, 'repaired');"
  + "process.exit(1);";

const definition = () => ({
  title: "Inspectable lint repair and release note",
  goal: objective,
  nodes: [
    { id: "repair-lint", title: "Repair the lint rule", requires: ["lint"], acceptance: [] as string[] },
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

/** One non-weakening revision adds a prepare step before the release note. */
const revisedDefinition = () => {
  const base = definition();
  return {
    ...base,
    nodes: [
      ...base.nodes.slice(0, 3),
      {
        id: "prepare-note",
        title: "Prepare the release note sources",
        requires: ["route"],
        acceptance: ["Collect the release evidence for the note"],
        scope: { paths: ["docs/**"] },
      },
      { ...base.nodes[3]!, requires: ["route", "prepare-note"] },
      ...base.nodes.slice(4),
    ],
  };
};

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

const batches = (value: ReturnType<typeof harness>): any[] => value.entries
  .filter((entry) => entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE);

const latestState = (value: ReturnType<typeof harness>): any => batches(value).at(-1)?.data.snapshot;

const allEvents = (value: ReturnType<typeof harness>): any[] => batches(value)
  .flatMap((entry) => entry.data.events ?? []);

const prompts = (value: ReturnType<typeof harness>): string[] => value.sendUserMessage.mock.calls
  .map((call) => String(call[0]))
  .filter((prompt) => prompt.startsWith("Hypagraph automatic continuation.")
    || prompt.startsWith("Hypagraph automatic bounded revision."));

const lastNotification = (value: ReturnType<typeof harness>): string =>
  String(value.notify.mock.calls.at(-1)?.[0] ?? "");

const history = async (value: ReturnType<typeof harness>, args: string): Promise<string> => {
  await value.commands.get("hypagraph")!.handler(args, value.ctx);
  return lastNotification(value);
};

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

describe("M6B dogfood", () => {
  it("completes one realistic objective and makes its decisions inspectable", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-m6b-dogfood-"));
    roots.push(root);
    const value = harness(root);
    await value.tools.get("hypagoal_start")!.execute(
      "create-root",
      { objective, definition: definition(), budget: { maximumTurns: 16, maximumTokens: 3_000 } },
      undefined,
      undefined,
      value.ctx,
    );

    const selected: string[] = [];
    let observedPromptCount = 0;
    let blockedExplanation = "";
    let revisionApplied = false;
    await agentEnd(value);

    for (let guard = 0; guard < 24; guard += 1) {
      const queued = prompts(value);
      if (queued.length === observedPromptCount) break;
      const prompt = queued.at(-1)!;
      observedPromptCount = queued.length;
      const before = latestState(value);
      const action = before.goal.pendingContinuation.action;

      if (action.kind === "request-revision") {
        selected.push("revision:request");
        await deliver(value, prompt);
        await value.tools.get("hypagoal_submit_revision")!.execute(
          "revise",
          revisedDefinition(),
          undefined,
          undefined,
          value.ctx,
        );
        revisionApplied = true;
        await agentEnd(value);
        continue;
      }

      if (action.kind !== "start-ready-task" && action.kind !== "continue-active-task") {
        throw new Error(`The model lane received an unexpected action '${action.kind}'.`);
      }

      const loop = action.loopId ? before.runtime.loops[action.loopId] : undefined;
      selected.push(`${action.nodeId}:${action.loopId ?? "root"}:${loop?.currentIteration ?? 0}`);
      await deliver(value, prompt);

      // After the lint region and the release route, block the release note once.
      // The automatic revision adds a prepare step. The history surface must explain that block.
      if (action.nodeId === "release-note" && !revisionApplied) {
        await transition(value, "release-note", "block", {
          reason: "A bounded prepare step for the release note is missing.",
          blockerKind: "repository-work",
        });
        blockedExplanation = (await history(value, "explain release-note"));
        const explanation = explainNode(latestState(value) as HypagraphState, "release-note");
        expect(explanation.reason.kind).toBe("blocked");
        expect(blockedExplanation).toContain("Node 'release-note' is blocked");
        expect(blockedExplanation).toContain("Reason: blocked");
        await agentEnd(value);
        continue;
      }

      await completeTask(value, action.nodeId);
      await agentEnd(value);
    }

    const state = latestState(value) as HypagraphState;
    const events = allEvents(value);

    expect(revisionApplied).toBe(true);
    expect(selected).toEqual([
      "repair-lint:lint-repair:0",
      "repair-lint:lint-repair:2",
      "release-note:root:0",
      "revision:request",
      "prepare-note:root:0",
      "release-note:root:0",
      "publish:root:0",
    ]);

    // Canonical result: loop, gates, revision, and completion.
    expect(state.phase).toBe("completed");
    expect(state.goal?.status).toBe("completed");
    expect(state.revision).toBe(2);
    expect(state.goal?.automaticRevision).toMatchObject({
      consumedAttempts: 1,
      lastAttempt: { outcome: "applied", appliedRevision: 2 },
    });
    expect(state.runtime.loops["lint-repair"]).toMatchObject({
      status: "succeeded",
      currentIteration: 2,
      exitReason: "success",
    });
    expect(state.runtime.nodes.lint?.status).toBe("succeeded");
    expect(state.runtime.nodes.lint?.attemptCount).toBe(2);
    expect(state.runtime.nodes["prepare-note"]?.status).toBe("succeeded");
    expect(state.runtime.nodes["release-note"]?.status).toBe("succeeded");
    expect(state.runtime.nodes.documentation?.status).toBe("succeeded");
    expect(state.runtime.routes.route).toMatchObject({ outcomeId: "true", targetNodeIds: ["release-note"] });
    expect(state.runtime.routes["publish-gate"]).toMatchObject({ outcomeId: "true", targetNodeIds: ["publish"] });
    expect(state.runtime.nodes.investigate?.status).toBe("skipped");
    expect(state.runtime.nodes["revise-documentation"]?.status).toBe("skipped");

    // M6A lane mix still holds: checks and gates use the deterministic lane.
    // The model lane still closes through the continuation lifecycle events.
    const selections = events
      .filter((event) => event.type === "hypagraph.action.selected"
        || event.type === "hypagraph.goal.continuation-requested")
      .map((event) => event.type === "hypagraph.action.selected"
        ? { lane: event.data.dispatch.lane as string, kind: event.data.dispatch.action.kind as string }
        : { lane: "model", kind: event.data.action.kind as string });
    expect(selections.filter((item) => item.lane === "deterministic").map((item) => item.kind)).toEqual([
      "run-ready-check",
      "run-ready-check",
      "evaluate-ready-gate",
      "run-ready-check",
      "evaluate-ready-gate",
    ]);
    expect(selections.filter((item) => item.lane === "model").map((item) => item.kind)).toEqual([
      "start-ready-task",
      "start-ready-task",
      "start-ready-task",
      "request-revision",
      "start-ready-task",
      "start-ready-task",
      "start-ready-task",
    ]);

    // Timeline: one stream, with model and deterministic dispatch markers.
    const timeline = projectEventTimeline(events);
    expect(timeline.length).toBe(state.sequence);
    expect(timeline.some((entry) => entry.lane === "dispatch" && entry.dispatch?.lane === "model")).toBe(true);
    expect(timeline.some((entry) => entry.lane === "dispatch" && entry.dispatch?.lane === "deterministic")).toBe(true);
    expect(timeline.some((entry) => entry.revisionBoundary === true)).toBe(true);

    const timelinePage = await history(value, "history");
    expect(timelinePage).toMatch(/^Hypagraph event timeline: \d+ of \d+ entries, sequence \d+ to \d+\./);
    expect(timelinePage).toContain("M model lane");
    expect(timelinePage).toContain("D deterministic lane");

    const dispatchPage = await history(value, "history dispatch");
    expect(dispatchPage).toContain("in lane 'dispatch'");
    expect(dispatchPage).toMatch(/The scheduler selected .+ in the deterministic lane/);
    expect(dispatchPage).toMatch(/The model lane selected start task/);

    // Replay three points: early work, the revision boundary, and the live sequence.
    const firstTaskSequence = events.find((event) => event.type === "hypagraph.attempt.started"
      && event.nodeId === "repair-lint")!.sequence;
    const revisionSequence = events.find((event) => event.type === "hypagraph.workflow.revised")!.sequence;
    const liveSequence = state.sequence;

    const early = replayToSequence(events, firstTaskSequence);
    expect(early.state.revision).toBe(1);
    expect(early.state.runtime.nodes["repair-lint"]?.status).toBe("running");
    expect(early.state.phase).not.toBe("completed");
    const earlyRendered = await history(value, `history ${firstTaskSequence}`);
    expect(earlyRendered).toContain(`Hypagraph replay at sequence ${firstTaskSequence} of ${liveSequence}.`);
    expect(earlyRendered).toContain("Difference from live sequence");
    expect(earlyRendered).toContain("Replay reads stored events only. It runs no check and calls no executor.");

    const atRevision = replayToSequence(events, revisionSequence);
    expect(atRevision.state.revision).toBe(2);
    expect(atRevision.state.definition.nodes.some((node) => node.id === "prepare-note")).toBe(true);
    expect(atRevision.state.runtime.nodes["prepare-note"]).toBeDefined();
    expect(["ready", "pending"]).toContain(atRevision.state.runtime.nodes["prepare-note"]?.status);
    const revisionRendered = await history(value, `history ${revisionSequence}`);
    expect(revisionRendered).toContain(`Hypagraph replay at sequence ${revisionSequence} of ${liveSequence}.`);
    expect(revisionRendered).toContain("prepare-note");

    const live = replayToSequence(events, liveSequence);
    expect(live.state).toEqual(state);
    expect(compareReplayWithLive(live.state, state).identical).toBe(true);
    const liveRendered = await history(value, `history ${liveSequence}`);
    expect(liveRendered).toContain("Difference from live: none. The replay reached the live sequence.");

    // Replay never runs work. The stored event count does not grow after three replays.
    const eventCountBeforeReplaySurface = events.length;
    await history(value, `history ${firstTaskSequence}`);
    await history(value, `history ${revisionSequence}`);
    await history(value, `history ${liveSequence}`);
    expect(allEvents(value)).toHaveLength(eventCountBeforeReplaySurface);
    expect(latestState(value).snapshotHash).toBe(state.snapshotHash);

    // Explain a skipped route and the completed goal.
    const investigate = await history(value, "explain investigate");
    expect(investigate).toContain("Node 'investigate' is skipped (task).");
    expect(investigate).toContain("Reason: skipped-route");
    expect(investigate).toContain("gate 'route' selected outcome 'true'");

    const goalExplain = await history(value, "explain");
    expect(goalExplain).toContain("Decision:");
    expect(goalExplain).toContain("publish");
    expect(blockedExplanation.length).toBeGreaterThan(0);

    // Revision history names both segments and the discarded release-note attempt.
    const revisionHistory = await history(value, "history revisions");
    expect(revisionHistory).toContain("Hypagraph revision history: 2 revisions");
    expect(revisionHistory).toContain("revision 1:");
    expect(revisionHistory).toContain("revision 2:");
    expect(revisionHistory).toContain("to current");
    const segments = projectRevisionHistory(events);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.revision).toBe(1);
    expect(segments[1]!.revision).toBe(2);

    // Model-visible history keeps the same redacted projection.
    const read = value.tools.get("hypagraph_read")!;
    const historyResult = await read.execute("read-history", { view: "history" }, undefined, undefined, value.ctx);
    const historyPayload = JSON.parse(String(historyResult.content[0].text));
    expect(historyPayload.totalEvents).toBe(state.sequence);
    expect(historyPayload.entries.some((entry: any) => entry.dispatch?.lane === "deterministic")).toBe(true);
    expect(historyPayload.entries.some((entry: any) => entry.dispatch?.lane === "model")).toBe(true);

    const explainResult = await read.execute(
      "read-explain",
      { view: "explain", nodeId: "investigate" },
      undefined,
      undefined,
      value.ctx,
    );
    expect(String(explainResult.content[0].text)).toContain("Reason: skipped-route");

    // Dispatch lane filter matches the projection helper used by the surface.
    const dispatchEntries = filterTimelineByLane(timeline, "dispatch");
    expect(dispatchEntries.length).toBeGreaterThan(0);
    expect(dispatchEntries.every((entry) => entry.lane === "dispatch")).toBe(true);

    // Restore after completion still runs no work.
    const promptCountBeforeRestore = prompts(value).length;
    await invoke(value, "session_start", { type: "session_start", reason: "reload" });
    expect(prompts(value)).toHaveLength(promptCountBeforeRestore);
    const restored = latestState(value);
    expect(restored.phase).toBe("completed");
    expect(restored.goal.status).toBe("completed");
    expect(restored.snapshotHash).toBe(state.snapshotHash);
  }, 90_000);
});
