import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { access, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DefaultPresentationExecutor } from "../src/checks/presentation-executor.js";
import {
  awaitingInteractionNodeIds,
  interactionPresentationIsAllowed,
  interactionPresentationNeedsEffect,
  interactionPresentationSucceeded,
  isDerivedWaitingForUser,
} from "../src/domain/interaction-presentation.js";
import type { DomainEvent, HypagraphDefinition, HypagraphState, InteractionDefinition } from "../src/domain/model.js";
import { createWorkflow, handleCommand, replayEvents } from "../src/domain/reducer.js";
import { selectGoalContinuation } from "../src/domain/goal-continuation.js";
import hypagraphExtension from "../src/extension.js";
import { projectGraphView } from "../src/graph/projection.js";
import { layoutGraph } from "../src/graph/layout.js";
import { renderGraphScene } from "../src/graph/renderer.js";
import { PiGraphPaneComponent } from "../src/pi/graph-pane.js";
import {
  derivedWaitingLines,
  waitingQuestionLines,
} from "../src/ui/interaction-surface.js";
import { renderHypagoalStatus } from "../src/ui/hypagoal-surface.js";

const at = "2026-07-28T15:00:00.000Z";

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

const objective = "Ask the user to approve the plan after a reload.";

const closedInteraction = (
  presentation: InteractionDefinition["presentation"] = { class: "deterministic", kind: "none" },
): InteractionDefinition => ({
  kind: "interaction",
  version: 1,
  presentation,
  question: "Approve the implementation plan?",
  responses: [
    {
      id: "approve",
      label: "Approve",
      publish: [{ name: "plan.approved", type: "boolean", value: true }],
    },
    {
      id: "reject",
      label: "Reject",
      publish: [{ name: "plan.approved", type: "boolean", value: false }],
    },
  ],
});

const soleInteractionDefinition = (
  presentation: InteractionDefinition["presentation"] = { class: "deterministic", kind: "none" },
): HypagraphDefinition => ({
  title: "Plan approval reload",
  goal: "Survive reload with an open question",
  nodes: [
    {
      id: "approve-plan",
      title: "Approve the plan",
      kind: "interaction",
      requires: [],
      acceptance: ["The user answers the plan question."],
      produces: [{ name: "plan.approved", type: "boolean", required: true }],
      interaction: closedInteraction(presentation),
    },
    {
      id: "after-approval",
      title: "Continue after approval",
      requires: ["approve-plan"],
      acceptance: ["Work continues after the answer."],
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const independentWorkDefinition = (): HypagraphDefinition => ({
  title: "Approval with independent work",
  goal: "Independent work continues while approval waits",
  nodes: [
    {
      id: "approve-plan",
      title: "Approve the plan",
      kind: "interaction",
      requires: [],
      acceptance: ["The user answers the plan question."],
      produces: [{ name: "plan.approved", type: "boolean", required: true }],
      interaction: closedInteraction(),
    },
    {
      id: "after-approval",
      title: "Continue after approval",
      requires: ["approve-plan"],
      acceptance: ["Work continues after the answer."],
    },
    {
      id: "document",
      title: "Document independently",
      requires: [],
      acceptance: ["Independent documentation continues."],
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const apply = (state: HypagraphState, command: Parameters<typeof handleCommand>[1]) => {
  const result = handleCommand(state, command);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const startGoal = (state: HypagraphState, goalId = "goal-reload"): HypagraphState =>
  apply(state, {
    type: "start-goal",
    goalId,
    budget: { maximumTurns: 8, maximumTokens: 4_000 },
    commandId: `start-${goalId}`,
    at,
  }).state;

const requestAndPresent = (
  state: HypagraphState,
  nodeId = "approve-plan",
  attemptId = "attempt-1",
): { state: HypagraphState; events: DomainEvent[] } => {
  const events: DomainEvent[] = [];
  const requested = apply(state, {
    type: "request-interaction",
    nodeId,
    attemptId,
    commandId: `request-${attemptId}`,
    at,
  });
  events.push(...requested.events);
  let next = requested.state;
  const presented = apply(next, {
    type: "present-interaction",
    nodeId,
    attemptId,
    result: {
      status: "succeeded",
      kind: next.definition.nodes.find((node) => node.id === nodeId)?.interaction?.presentation.kind ?? "none",
      presentedAt: at,
      ...(next.definition.nodes.find((node) => node.id === nodeId)?.interaction?.presentation.kind === "report"
        ? { artifactRef: "memory://presentation-report" }
        : {}),
    },
    commandId: `present-${attemptId}`,
    at,
  });
  events.push(...presented.events);
  next = presented.state;
  return { state: next, events };
};

const harness = (options: { hasUI?: boolean; select?: any } = {}) => {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: any[] = [];
  const select = options.select ?? vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: CommandDefinition) => commands.set(name, command)),
    appendEntry: vi.fn((customType: string, data?: unknown) => entries.push({ type: "custom", customType, data })),
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn(() => ["read", "write", "edit"]),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    hasUI: options.hasUI ?? true,
    ui: {
      confirm: vi.fn().mockResolvedValue(true),
      notify,
      select,
      input: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: { getBranch: () => entries },
  };
  hypagraphExtension(pi);
  return { tools, commands, handlers, entries, notify, select, ctx };
};

const createRoot = async (
  value: ReturnType<typeof harness>,
  definition: HypagraphDefinition = soleInteractionDefinition(),
) => value.tools.get("hypagoal_start")!.execute(
  "create-root",
  { objective, definition },
  undefined,
  undefined,
  value.ctx,
);

const currentState = (value: ReturnType<typeof harness>): HypagraphState => {
  const batch = [...value.entries].reverse().find((entry) => entry.data?.snapshot);
  if (!batch) throw new Error("The session holds no Hypagraph snapshot.");
  return batch.data.snapshot as HypagraphState;
};

const allEvents = (value: ReturnType<typeof harness>): DomainEvent[] =>
  value.entries.flatMap((entry) => (entry.data?.events ?? []) as DomainEvent[]);

const statusOf = (value: ReturnType<typeof harness>, nodeId: string): string =>
  currentState(value).runtime.nodes[nodeId]!.status;

const ask = async (value: ReturnType<typeof harness>, nodeId = "approve-plan") =>
  value.tools.get("hypagraph_ask")!.execute("ask", { nodeId }, undefined, undefined, value.ctx);

const invoke = async (value: ReturnType<typeof harness>, name: string, event: any) => {
  for (const handler of value.handlers.get(name) ?? []) {
    await handler(event, value.ctx);
  }
};

const theme = {
  fg: (_name: string, text: string) => text,
} as any;

const tui = (columns = 120, rows = 40) => ({
  terminal: { columns, rows },
  requestRender: vi.fn(),
} as any);

describe("M6.1 Slice 4 reload, restore, and product surface", () => {
  describe("presentation effect after restore", () => {
    it("does not need the presentation effect after a successful observation is restored", () => {
      const created = createWorkflow(
        soleInteractionDefinition({ class: "deterministic", kind: "report", maxBytes: 4_096 }),
        at,
        "workflow-restore-no-repeat",
      );
      if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
      const events: DomainEvent[] = [...created.events];
      const withGoal = apply(created.state, {
        type: "start-goal",
        goalId: "goal-restore-no-repeat",
        budget: { maximumTurns: 8, maximumTokens: 4_000 },
        commandId: "start-goal-restore-no-repeat",
        at,
      });
      let state = withGoal.state;
      events.push(...withGoal.events);
      const presented = requestAndPresent(state);
      state = presented.state;
      events.push(...presented.events);

      expect(interactionPresentationSucceeded(state, "approve-plan", "attempt-1")).toBe(true);
      expect(interactionPresentationNeedsEffect(state, "approve-plan", "attempt-1")).toBe(false);

      const restored = replayEvents(events);
      expect(restored.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
      expect(interactionPresentationSucceeded(restored, "approve-plan", "attempt-1")).toBe(true);
      expect(interactionPresentationNeedsEffect(restored, "approve-plan", "attempt-1")).toBe(false);
      expect(restored.runtime.nodes["approve-plan"]?.attempts["attempt-1"]?.presentation?.status)
        .toBe("succeeded");
    });

    it("restore does not repeat the presentation effect on the product surface", async () => {
      const executeSpy = vi.spyOn(DefaultPresentationExecutor.prototype, "execute");
      try {
        const select = vi.fn().mockResolvedValue(undefined);
        const value = harness({ select });
        await createRoot(value, soleInteractionDefinition({
          class: "deterministic",
          kind: "report",
          maxBytes: 4_096,
        }));

        await ask(value);
        expect(statusOf(value, "approve-plan")).toBe("awaiting_response");
        const attemptId = currentState(value).runtime.nodes["approve-plan"]!.currentAttemptId!;
        expect(interactionPresentationSucceeded(currentState(value), "approve-plan", attemptId)).toBe(true);
        const executeCountAfterPresent = executeSpy.mock.calls.length;
        expect(executeCountAfterPresent).toBeGreaterThanOrEqual(1);
        const presentedCountAfterAsk = allEvents(value)
          .filter((event) => event.type === "hypagraph.interaction.presented").length;
        expect(presentedCountAfterAsk).toBe(1);

        // Reload rebuilds from session events and pauses autonomous continuation.
        await invoke(value, "session_start", { type: "session_start", reason: "reload" });
        const afterReload = currentState(value);
        expect(afterReload.goal).toMatchObject({ status: "paused", pauseCause: "session_reload" });
        expect(afterReload.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
        expect(interactionPresentationNeedsEffect(afterReload, "approve-plan", attemptId)).toBe(false);
        expect(executeSpy.mock.calls.length).toBe(executeCountAfterPresent);

        // Explicit resume re-presents the dialog without a second presentation effect.
        select.mockClear();
        select.mockResolvedValue(undefined);
        await value.commands.get("hypagoal")!.handler("resume", value.ctx);

        expect(currentState(value).goal?.status).toBe("active");
        expect(statusOf(value, "approve-plan")).toBe("awaiting_response");
        expect(select).toHaveBeenCalled();
        expect(executeSpy.mock.calls.length).toBe(executeCountAfterPresent);
        expect(allEvents(value).filter((event) => event.type === "hypagraph.interaction.presented").length)
          .toBe(1);
        expect(interactionPresentationNeedsEffect(
          currentState(value),
          "approve-plan",
          attemptId,
        )).toBe(false);
      } finally {
        executeSpy.mockRestore();
      }
    });

    it("restores a request-only wait and runs the presentation effect once on resume", async () => {
      const executeSpy = vi.spyOn(DefaultPresentationExecutor.prototype, "execute");
      try {
        // Domain: request only, no presentation observation (crash between request and present).
        const created = createWorkflow(
          soleInteractionDefinition({ class: "deterministic", kind: "report", maxBytes: 4_096 }),
          at,
          "workflow-request-only-restore",
        );
        if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
        const withGoal = apply(created.state, {
          type: "start-goal",
          goalId: "goal-request-only",
          budget: { maximumTurns: 8, maximumTokens: 4_000 },
          commandId: "start-request-only",
          at,
        });
        const requested = apply(withGoal.state, {
          type: "request-interaction",
          nodeId: "approve-plan",
          attemptId: "attempt-request-only",
          commandId: "request-only",
          at,
        });
        const restored = replayEvents([...created.events, ...withGoal.events, ...requested.events]);
        expect(restored.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
        expect(interactionPresentationNeedsEffect(restored, "approve-plan", "attempt-request-only")).toBe(true);

        // Product: request through transition without presentation, then resume re-presents.
        const select = vi.fn().mockResolvedValue(undefined);
        const value = harness({ select });
        await createRoot(value, soleInteractionDefinition({
          class: "deterministic",
          kind: "report",
          maxBytes: 4_096,
        }));
        executeSpy.mockClear();
        await value.tools.get("hypagraph_transition")!.execute(
          "request-only",
          { nodeId: "approve-plan", action: "start" },
          undefined,
          undefined,
          value.ctx,
        );
        expect(statusOf(value, "approve-plan")).toBe("awaiting_response");
        const attemptId = currentState(value).runtime.nodes["approve-plan"]!.currentAttemptId!;
        expect(interactionPresentationNeedsEffect(currentState(value), "approve-plan", attemptId)).toBe(true);
        expect(executeSpy).not.toHaveBeenCalled();
        expect(allEvents(value).some((event) => event.type === "hypagraph.interaction.presented")).toBe(false);

        await invoke(value, "session_start", { type: "session_start", reason: "reload" });
        expect(currentState(value).goal).toMatchObject({ status: "paused", pauseCause: "session_reload" });
        expect(interactionPresentationNeedsEffect(currentState(value), "approve-plan", attemptId)).toBe(true);

        await value.commands.get("hypagoal")!.handler("resume", value.ctx);
        expect(currentState(value).goal?.status).toBe("active");
        expect(select).toHaveBeenCalled();
        expect(executeSpy).toHaveBeenCalledTimes(1);
        expect(allEvents(value).filter((event) => event.type === "hypagraph.interaction.presented")).toHaveLength(1);
        expect(interactionPresentationSucceeded(currentState(value), "approve-plan", attemptId)).toBe(true);
      } finally {
        executeSpy.mockRestore();
      }
    });

    it("does not repeat a successful command presentation effect after restore", async () => {
      const executeSpy = vi.spyOn(DefaultPresentationExecutor.prototype, "execute");
      try {
        const select = vi.fn().mockResolvedValue(undefined);
        const value = harness({ select });
        await createRoot(value, soleInteractionDefinition({
          class: "deterministic",
          kind: "command",
          command: process.execPath,
          arguments: ["-e", ""],
          timeoutMs: 5_000,
        }));
        await ask(value);
        const afterPresent = executeSpy.mock.calls.length;
        expect(afterPresent).toBeGreaterThanOrEqual(1);
        expect(allEvents(value).filter((event) => event.type === "hypagraph.interaction.presented")).toHaveLength(1);

        await invoke(value, "session_start", { type: "session_start", reason: "reload" });
        await value.commands.get("hypagoal")!.handler("resume", value.ctx);
        expect(select).toHaveBeenCalled();
        expect(executeSpy.mock.calls.length).toBe(afterPresent);
        expect(allEvents(value).filter((event) => event.type === "hypagraph.interaction.presented")).toHaveLength(1);
      } finally {
        executeSpy.mockRestore();
      }
    });

    it("regenerates a missing presentation artifact once without a second present event", async () => {
      const executeSpy = vi.spyOn(DefaultPresentationExecutor.prototype, "execute");
      try {
        const select = vi.fn().mockResolvedValue(undefined);
        const value = harness({ select });
        await createRoot(value, soleInteractionDefinition({
          class: "deterministic",
          kind: "report",
          maxBytes: 4_096,
        }));
        await ask(value);
        const attemptId = currentState(value).runtime.nodes["approve-plan"]!.currentAttemptId!;
        const observation = currentState(value).runtime.nodes["approve-plan"]!.attempts[attemptId]!.presentation!;
        expect(observation.status).toBe("succeeded");
        expect(observation.artifactRef).toBeDefined();
        const artifactPath = fileURLToPath(observation.artifactRef!);
        await access(artifactPath);
        await rm(artifactPath);
        await expect(access(artifactPath)).rejects.toThrow();

        const executeAfterPresent = executeSpy.mock.calls.length;
        const presentedAfterAsk = allEvents(value)
          .filter((event) => event.type === "hypagraph.interaction.presented").length;
        expect(presentedAfterAsk).toBe(1);

        await invoke(value, "session_start", { type: "session_start", reason: "reload" });
        select.mockClear();
        select.mockResolvedValue(undefined);
        await value.commands.get("hypagoal")!.handler("resume", value.ctx);

        expect(currentState(value).goal?.status).toBe("active");
        expect(statusOf(value, "approve-plan")).toBe("awaiting_response");
        expect(select).toHaveBeenCalled();
        expect(executeSpy.mock.calls.length).toBe(executeAfterPresent + 1);
        expect(allEvents(value).filter((event) => event.type === "hypagraph.interaction.presented")).toHaveLength(1);
        expect(interactionPresentationSucceeded(currentState(value), "approve-plan", attemptId)).toBe(true);
        // Successful regenerate rewrites the same deterministic path.
        await access(artifactPath);
      } finally {
        executeSpy.mockRestore();
      }
    });

    it("opens the dialog when artifact regenerate fails after a successful observation", async () => {
      const executeSpy = vi.spyOn(DefaultPresentationExecutor.prototype, "execute");
      try {
        const select = vi.fn().mockResolvedValue(undefined);
        const value = harness({ select });
        await createRoot(value, soleInteractionDefinition({
          class: "deterministic",
          kind: "report",
          maxBytes: 4_096,
        }));
        await ask(value);
        const attemptId = currentState(value).runtime.nodes["approve-plan"]!.currentAttemptId!;
        const observation = currentState(value).runtime.nodes["approve-plan"]!.attempts[attemptId]!.presentation!;
        expect(observation.artifactRef).toBeDefined();
        await rm(fileURLToPath(observation.artifactRef!));

        // Force regenerate to fail. The durable successful observation must still open the dialog.
        executeSpy.mockImplementationOnce(async () => ({
          status: "error" as const,
          kind: "report" as const,
          presentedAt: new Date().toISOString(),
          error: "forced regenerate failure",
        }));

        await invoke(value, "session_start", { type: "session_start", reason: "reload" });
        select.mockClear();
        value.notify.mockClear();
        select.mockResolvedValue(undefined);
        await value.commands.get("hypagoal")!.handler("resume", value.ctx);

        expect(statusOf(value, "approve-plan")).toBe("awaiting_response");
        expect(interactionPresentationSucceeded(currentState(value), "approve-plan", attemptId)).toBe(true);
        expect(select).toHaveBeenCalled();
        expect(allEvents(value).filter((event) => event.type === "hypagraph.interaction.presented")).toHaveLength(1);
        const notes = value.notify.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
        expect(notes).toContain("could not be regenerated");
        expect(notes).not.toContain("The node is failed");
      } finally {
        executeSpy.mockRestore();
      }
    });
  });

  describe("outstanding question after restore and resume", () => {
    it("keeps the outstanding question visible after restore", async () => {
      const value = harness({ select: vi.fn().mockResolvedValue(undefined) });
      await createRoot(value);
      await ask(value);
      expect(statusOf(value, "approve-plan")).toBe("awaiting_response");

      await invoke(value, "session_start", { type: "session_start", reason: "reload" });
      const restored = currentState(value);

      expect(restored.goal).toMatchObject({ status: "paused", pauseCause: "session_reload" });
      expect(restored.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
      expect(awaitingInteractionNodeIds(restored)).toEqual(["approve-plan"]);
      const status = renderHypagoalStatus(restored);
      expect(status).toContain("Approve the implementation plan?");
      expect(status).toContain("approve-plan");
      expect(waitingQuestionLines(restored).join("\n")).toContain("approve - Approve");
    });

    it("re-presents the outstanding question after reload and explicit resume", async () => {
      const select = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce("approve - Approve");
      const value = harness({ select });
      await createRoot(value);
      await ask(value);
      expect(statusOf(value, "approve-plan")).toBe("awaiting_response");
      expect(select).toHaveBeenCalledTimes(1);

      await invoke(value, "session_start", { type: "session_start", reason: "reload" });
      expect(currentState(value).goal).toMatchObject({ status: "paused", pauseCause: "session_reload" });
      // Reload must not open a dialog while the goal is paused.
      expect(select).toHaveBeenCalledTimes(1);

      await value.commands.get("hypagoal")!.handler("resume", value.ctx);

      expect(select).toHaveBeenCalledTimes(2);
      expect(select).toHaveBeenLastCalledWith(
        "Approve the implementation plan?",
        ["approve - Approve", "reject - Reject"],
      );
      expect(statusOf(value, "approve-plan")).toBe("succeeded");
      expect(currentState(value).runtime.facts["plan.approved"]?.value).toBe(true);
    });

    it("rebuilds an outstanding wait from stored events without losing the attempt", () => {
      const created = createWorkflow(soleInteractionDefinition(), at, "workflow-rebuild-wait");
      if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
      const events: DomainEvent[] = [...created.events];
      let state = startGoal(created.state, "goal-rebuild");
      // start-goal events are not in created.events; re-apply for a complete stream.
      const withGoal = apply(created.state, {
        type: "start-goal",
        goalId: "goal-rebuild",
        budget: { maximumTurns: 8, maximumTokens: 4_000 },
        commandId: "start-goal-rebuild",
        at,
      });
      state = withGoal.state;
      events.push(...withGoal.events);
      const presented = requestAndPresent(state);
      state = presented.state;
      events.push(...presented.events);

      const paused = apply(state, {
        type: "pause-goal",
        cause: "session_reload",
        reason: "The Pi session reloaded. Resume the Hypagoal explicitly after reviewing canonical state.",
        commandId: "pause-reload",
        at,
      });
      state = paused.state;
      events.push(...paused.events);

      const rebuilt = replayEvents(events);
      expect(rebuilt).toEqual(state);
      expect(rebuilt.goal?.status).toBe("paused");
      expect(rebuilt.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
      expect(rebuilt.runtime.nodes["approve-plan"]?.currentAttemptId).toBe("attempt-1");
      expect(interactionPresentationSucceeded(rebuilt, "approve-plan", "attempt-1")).toBe(true);

      const resumed = apply(rebuilt, {
        type: "resume-goal",
        commandId: "resume-after-reload",
        at,
      }).state;
      expect(resumed.goal?.status).toBe("active");
      expect(resumed.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
      const decision = selectGoalContinuation(resumed);
      expect(decision.kind).toBe("stop-waiting-response");
      if (decision.kind === "stop-waiting-response") {
        expect(decision.nodeIds).toEqual(["approve-plan"]);
      }
    });
  });

  describe("derived waiting state", () => {
    it("appears only when no runnable action exists", () => {
      const soleCreated = createWorkflow(soleInteractionDefinition(), at, "workflow-derived-sole");
      if (!soleCreated.ok) throw new Error(JSON.stringify(soleCreated.diagnostics));
      let sole = startGoal(soleCreated.state, "goal-derived-sole");
      sole = requestAndPresent(sole).state;

      expect(isDerivedWaitingForUser(sole)).toBe(true);
      expect(derivedWaitingLines(sole).join("\n")).toContain("No other runnable work is available");
      expect(selectGoalContinuation(sole).kind).toBe("stop-waiting-response");
      expect(renderHypagoalStatus(sole)).toContain("No other runnable work is available");

      const independentCreated = createWorkflow(independentWorkDefinition(), at, "workflow-derived-indep");
      if (!independentCreated.ok) throw new Error(JSON.stringify(independentCreated.diagnostics));
      let independent = startGoal(independentCreated.state, "goal-derived-indep");
      independent = requestAndPresent(independent).state;

      expect(independent.runtime.nodes["document"]?.status).toBe("ready");
      expect(independent.runtime.nodes["approve-plan"]?.status).toBe("awaiting_response");
      expect(isDerivedWaitingForUser(independent)).toBe(false);
      expect(derivedWaitingLines(independent)).toEqual([]);
      expect(waitingQuestionLines(independent).join("\n")).toContain("approve-plan");
      expect(waitingQuestionLines(independent).join("\n")).not.toContain("No other runnable work is available");
      expect(selectGoalContinuation(independent).kind).not.toBe("stop-waiting-response");
    });

    it("does not claim derived waiting while the goal is paused after reload", async () => {
      const value = harness({ select: vi.fn().mockResolvedValue(undefined) });
      await createRoot(value);
      await ask(value);
      await invoke(value, "session_start", { type: "session_start", reason: "reload" });
      const restored = currentState(value);

      expect(isDerivedWaitingForUser(restored)).toBe(false);
      expect(derivedWaitingLines(restored)).toEqual([]);
      expect(awaitingInteractionNodeIds(restored)).toEqual(["approve-plan"]);
      // Outstanding questions remain visible without the goal-level only-waiting claim.
      expect(waitingQuestionLines(restored).join("\n")).toContain("Approve the implementation plan?");
      expect(waitingQuestionLines(restored).join("\n")).not.toContain("No other runnable work is available");
    });

    it("orders stop-waiting node IDs in definition order", () => {
      const orderedInteraction = (fact: string): InteractionDefinition => ({
        kind: "interaction",
        version: 1,
        presentation: { class: "deterministic", kind: "none" },
        question: "Choose?",
        responses: [
          { id: "approve", label: "Approve", publish: [{ name: fact, type: "boolean", value: true }] },
          { id: "reject", label: "Reject", publish: [{ name: fact, type: "boolean", value: false }] },
        ],
      });
      const definition: HypagraphDefinition = {
        title: "Two waits order",
        goal: "Keep definition order",
        nodes: [
          {
            id: "zebra-ask",
            title: "Zebra",
            kind: "interaction",
            requires: [],
            acceptance: [],
            produces: [{ name: "z.done", type: "boolean", required: true }],
            interaction: orderedInteraction("z.done"),
          },
          {
            id: "alpha-ask",
            title: "Alpha",
            kind: "interaction",
            requires: [],
            acceptance: [],
            produces: [{ name: "a.done", type: "boolean", required: true }],
            interaction: orderedInteraction("a.done"),
          },
        ],
        loops: [],
        policy: { mode: "guided", requireEvidence: false },
      };
      const created = createWorkflow(definition, at, "workflow-wait-order");
      if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
      let state = startGoal(created.state, "goal-wait-order");
      for (const nodeId of ["zebra-ask", "alpha-ask"] as const) {
        state = apply(state, {
          type: "request-interaction",
          nodeId,
          attemptId: `attempt-${nodeId}`,
          commandId: `request-${nodeId}`,
          at,
        }).state;
        state = apply(state, {
          type: "present-interaction",
          nodeId,
          attemptId: `attempt-${nodeId}`,
          result: { status: "succeeded", kind: "none", presentedAt: at },
          commandId: `present-${nodeId}`,
          at,
        }).state;
      }
      expect(awaitingInteractionNodeIds(state)).toEqual(["zebra-ask", "alpha-ask"]);
      const decision = selectGoalContinuation(state);
      expect(decision.kind).toBe("stop-waiting-response");
      if (decision.kind === "stop-waiting-response") {
        expect(decision.nodeIds).toEqual(["zebra-ask", "alpha-ask"]);
      }
    });
  });

  describe("Rule 1.1.1 dialog allow check", () => {
    it("blocks a dialog while independent work is ready, including after a reload pause", () => {
      const created = createWorkflow(independentWorkDefinition(), at, "workflow-allow-paused");
      if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
      let state = startGoal(created.state, "goal-allow-paused");
      state = requestAndPresent(state).state;
      expect(interactionPresentationIsAllowed(state, "approve-plan")).toBe(false);

      const paused = apply(state, {
        type: "pause-goal",
        cause: "session_reload",
        reason: "Reloaded",
        commandId: "pause-allow",
        at,
      }).state;
      // Goal is paused, but document remains ready. Rule 1.1.1 still blocks the dialog.
      expect(paused.goal?.status).toBe("paused");
      expect(paused.runtime.nodes["document"]?.status).toBe("ready");
      expect(interactionPresentationIsAllowed(paused, "approve-plan")).toBe(false);
    });

    it("does not open the dialog after reload and resume when independent work is ready", async () => {
      const select = vi.fn().mockResolvedValue(undefined);
      const value = harness({ select });
      await createRoot(value, independentWorkDefinition());

      // Request without a dialog. Independent work stays ready.
      await value.tools.get("hypagraph_transition")!.execute(
        "request-with-independent-work",
        { nodeId: "approve-plan", action: "start" },
        undefined,
        undefined,
        value.ctx,
      );
      expect(statusOf(value, "approve-plan")).toBe("awaiting_response");
      expect(currentState(value).runtime.nodes["document"]?.status).toBe("ready");
      expect(isDerivedWaitingForUser(currentState(value))).toBe(false);
      expect(select).not.toHaveBeenCalled();

      const blockedAsk = await ask(value);
      expect(select).not.toHaveBeenCalled();
      expect(String(blockedAsk.content[0].text)).toContain("other runnable work");

      await invoke(value, "session_start", { type: "session_start", reason: "reload" });
      expect(currentState(value).goal).toMatchObject({ status: "paused", pauseCause: "session_reload" });
      expect(statusOf(value, "approve-plan")).toBe("awaiting_response");
      expect(currentState(value).runtime.nodes["document"]?.status).toBe("ready");
      expect(interactionPresentationIsAllowed(currentState(value), "approve-plan")).toBe(false);

      select.mockClear();
      await value.commands.get("hypagoal")!.handler("resume", value.ctx);
      expect(currentState(value).goal?.status).toBe("active");
      expect(statusOf(value, "approve-plan")).toBe("awaiting_response");
      expect(currentState(value).runtime.nodes["document"]?.status).toBe("ready");
      expect(isDerivedWaitingForUser(currentState(value))).toBe(false);
      // Controller continues independent work. It must not open the interaction dialog.
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe("graph projection and pane", () => {
    it("marks awaiting_response nodes distinctly on the graph projection", () => {
      const created = createWorkflow(soleInteractionDefinition(), at, "workflow-graph-await");
      if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
      let state = startGoal(created.state, "goal-graph-await");
      state = requestAndPresent(state).state;

      const view = projectGraphView(state);
      const node = view.nodes.find((item) => item.id === "approve-plan");
      expect(node).toMatchObject({
        kind: "interaction",
        status: "awaiting_response",
        ready: false,
        active: false,
      });
      expect(view.awaitingNodeIds).toEqual(["approve-plan"]);
      expect(view.derivedWaitingForUser).toBe(true);

      const spacious = layoutGraph(view, { density: "spacious" });
      const spaciousScene = renderGraphScene(view, spacious, {
        width: Math.max(80, spacious.width),
        height: Math.max(20, spacious.height),
        unicode: true,
      }).join("\n");
      expect(spaciousScene).toContain("…");
      expect(spaciousScene).toContain("[interaction wait]");
      expect(spaciousScene).toContain("…w approve-plan");

      // Default normal density must also show the compact wait tag on the status line.
      const normal = layoutGraph(view, { density: "normal" });
      const normalScene = renderGraphScene(view, normal, {
        width: Math.max(80, normal.width),
        height: Math.max(20, normal.height),
        unicode: true,
      }).join("\n");
      expect(normalScene).toContain("…");
      expect(normalScene).toContain("…w approve-plan");
    });

    it("shows node-local awaiting without derived goal waiting when independent work is ready", () => {
      const created = createWorkflow(independentWorkDefinition(), at, "workflow-graph-indep");
      if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
      let state = startGoal(created.state, "goal-graph-indep");
      state = requestAndPresent(state).state;

      const view = projectGraphView(state);
      expect(view.awaitingNodeIds).toEqual(["approve-plan"]);
      expect(view.derivedWaitingForUser).toBe(false);
      expect(view.readyNodeIds).toContain("document");
      expect(view.nodes.find((item) => item.id === "approve-plan")?.status).toBe("awaiting_response");

      const component = new PiGraphPaneComponent(
        tui(),
        theme,
        vi.fn(),
        vi.fn(),
        vi.fn(),
        view,
        layoutGraph(view),
        "normal",
        { step: vi.fn(), enter: vi.fn(), clear: vi.fn() },
      );
      const text = component.render(100).join("\n");
      expect(text).toContain("Awaiting response: approve-plan");
      expect(text).not.toContain("Waiting for a user response");
    });

    it("shows the derived waiting line on the graph pane when the wait is the only stop", () => {
      const created = createWorkflow(soleInteractionDefinition(), at, "workflow-pane-derived");
      if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
      let state = startGoal(created.state, "goal-pane-derived");
      state = requestAndPresent(state).state;

      const view = projectGraphView(state);
      expect(view.derivedWaitingForUser).toBe(true);
      const component = new PiGraphPaneComponent(
        tui(),
        theme,
        vi.fn(),
        vi.fn(),
        vi.fn(),
        view,
        layoutGraph(view),
        "normal",
        { step: vi.fn(), enter: vi.fn(), clear: vi.fn() },
      );
      const text = component.render(100).join("\n");
      expect(text).toContain("Waiting for a user response · approve-plan");
      expect(text).not.toContain("Awaiting response: approve-plan");
    });

    it("renders the node-local awaiting line on the pane after reload", async () => {
      const value = harness({ select: vi.fn().mockResolvedValue(undefined) });
      await createRoot(value);
      await ask(value);
      await invoke(value, "session_start", { type: "session_start", reason: "reload" });
      const restored = currentState(value);
      const view = projectGraphView(restored);

      expect(view.awaitingNodeIds).toEqual(["approve-plan"]);
      // Goal is paused, so derived goal waiting is false.
      expect(view.derivedWaitingForUser).toBe(false);
      expect(view.nodes.find((item) => item.id === "approve-plan")?.status).toBe("awaiting_response");

      const component = new PiGraphPaneComponent(
        tui(),
        theme,
        vi.fn(),
        vi.fn(),
        vi.fn(),
        view,
        layoutGraph(view),
        "normal",
        { step: vi.fn(), enter: vi.fn(), clear: vi.fn() },
      );
      const text = component.render(100).join("\n");
      expect(text).toContain("Awaiting response: approve-plan");
      expect(text).not.toContain("Waiting for a user response ·");

      // After explicit resume with sole wait, derived waiting appears.
      await value.commands.get("hypagoal")!.handler("resume", value.ctx);
      const afterResume = currentState(value);
      expect(afterResume.goal?.status).toBe("active");
      const resumedView = projectGraphView(afterResume);
      expect(resumedView.derivedWaitingForUser).toBe(true);
      const resumedComponent = new PiGraphPaneComponent(
        tui(),
        theme,
        vi.fn(),
        vi.fn(),
        vi.fn(),
        resumedView,
        layoutGraph(resumedView),
        "normal",
        { step: vi.fn(), enter: vi.fn(), clear: vi.fn() },
      );
      expect(resumedComponent.render(100).join("\n")).toContain("Waiting for a user response · approve-plan");
    });
  });
});

