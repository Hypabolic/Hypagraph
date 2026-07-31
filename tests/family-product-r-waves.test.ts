/**
 * Remediation waves R3–R5 product and pure-helper coverage.
 *
 * R1 authority tests live in family-product-f1-create-child-extension.test.ts.
 * R2 e2e return requirement lives in family-product-f5-e2e-extension.test.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { handleCommand } from "../src/domain/reducer.js";
import type { DomainEvent, HypagraphState } from "../src/domain/model.js";
import { restoreLatestFamilySession } from "../src/persistence/family-session.js";
import {
  HYPAGRAPH_FAMILY_RECORD_TYPE,
  type PersistedGoalFamily,
} from "../src/persistence/family-store.js";
import {
  mergeLiveRootIntoFamily,
  replaceFamilyMemberWorkflow,
} from "../src/pi/family-product-dispatch.js";
import {
  NON_ROOT_CURRENT_SESSION_BAN_REASON,
} from "../src/pi/mutating-tool-policy.js";
import {
  bindActiveIsolatedPiHost,
  createIsolatedPiHost,
  type IsolatedPiProcessHandle,
  type IsolatedPiProcessTransport,
  type IsolatedPiStartOptions,
} from "../src/pi/isolated-pi-executor.js";
import { buildExecutorResultPayload } from "../src/domain/executor-contract.js";
import {
  prepareIsolatedRootAttempt,
  buildOrphanedTaskCancelCommands,
} from "../src/pi/isolated-root-dispatch.js";
import { createRootFamily } from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import { DEFAULT_MODEL_EXECUTOR_PROFILE } from "../src/domain/model-executor-profile.js";

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

const objective = "Ship remediation family path.";

const rootDefinition = {
  title: "R-wave root",
  goal: objective,
  nodes: [
    {
      id: "delegate",
      title: "Delegate",
      requires: [],
      acceptance: [],
      scope: { paths: ["src/**"] },
      produces: [{ name: "auth.ready", type: "boolean", required: true }],
      executorProfile: { profileId: "current-session-delegate", kind: "current-session" },
    },
    {
      id: "sibling",
      title: "Sibling",
      requires: [],
      acceptance: [],
      produces: [{ name: "sibling.done", type: "boolean", required: true }],
      executorProfile: { profileId: "current-session-sibling", kind: "current-session" },
    },
    {
      id: "integrate",
      title: "Integrate",
      requires: ["delegate"],
      acceptance: [],
      executorProfile: { profileId: "current-session-integrate", kind: "current-session" },
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
};

const isolatedChildDefinition = {
  title: "Child auth",
  goal: "Implement the auth subsystem.",
  nodes: [
    {
      id: "implement-auth",
      title: "Implement auth",
      requires: [],
      acceptance: [],
      scope: { paths: ["src/domain/**"] },
      produces: [{ name: "auth.ready", type: "boolean", required: true }],
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
};

const currentSessionChildDefinition = {
  ...isolatedChildDefinition,
  nodes: [{
    ...isolatedChildDefinition.nodes[0],
    executorProfile: { profileId: "current-session-child", kind: "current-session" },
  }],
};

const harness = () => {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: any[] = [];
  const sendUserMessage = vi.fn();
  const notify = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: CommandDefinition) => commands.set(name, command)),
    appendEntry: vi.fn((customType: string, data?: unknown) => entries.push({ type: "custom", customType, data })),
    sendUserMessage,
    getActiveTools: vi.fn(() => ["read", "write", "edit", "hypagraph_transition", "hypagoal_create_child"]),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    mode: "rpc",
    ui: {
      confirm: vi.fn().mockResolvedValue(true),
      notify,
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      custom: vi.fn(),
    },
    sessionManager: { getBranch: () => entries },
  };
  hypagraphExtension(pi);
  return { tools, commands, handlers, entries, sendUserMessage, notify, ctx, pi };
};

const invoke = async (
  handlers: Map<string, Array<(event: any, ctx: any) => any>>,
  name: string,
  event: any,
  ctx: any,
) => {
  const values = [];
  for (const handler of handlers.get(name) ?? []) values.push(await handler(event, ctx));
  return values;
};

const agentEnd = async (value: ReturnType<typeof harness>) => {
  await invoke(value.handlers, "agent_end", {
    type: "agent_end",
    messages: [{
      role: "assistant",
      content: [],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    }],
  }, value.ctx);
};

describe("Family product remediation R3–R5", () => {
  beforeAll(async () => {
    const { configureHostRoutingForTests } = await import("../src/pi/host-routing-options.js");
    configureHostRoutingForTests({ legacyCurrentSessionDefault: false });
  });

  afterAll(async () => {
    const { configureHostRoutingForTests } = await import("../src/pi/host-routing-options.js");
    configureHostRoutingForTests({ legacyCurrentSessionDefault: true });
  });

  it("R3 prepareIsolatedRootAttempt records member goalId and workflowId", () => {
    const created = createHypagoalWorkflow(isolatedChildDefinition as any, {
      workflowId: "workflow-member",
      goalId: "goal-member",
      goalWorkflowId: "workflow-member",
      at: "2026-07-31T20:00:00.000Z",
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const state = created.state;
    const family = createRootFamily({
      familyId: "family-r3",
      rootGoalId: state.goal!.goalId,
      rootWorkflowId: state.workflowId,
      at: "2026-07-31T20:00:00.000Z",
    });
    if (!family.ok) throw new Error(JSON.stringify(family.diagnostics));

    const prepared = prepareIsolatedRootAttempt({
      state,
      family: family.family,
      action: {
        kind: "start-ready-task",
        nodeId: "implement-auth",
        goalId: state.goal!.goalId,
        workflowId: state.workflowId,
        revision: state.revision,
        sequence: state.sequence,
        snapshotHash: state.snapshotHash,
        continuationOrdinal: state.goal!.continuationOrdinal,
      },
      profile: DEFAULT_MODEL_EXECUTOR_PROFILE,
      attemptId: "attempt-r3",
      operationId: "op-r3",
      sessionGeneration: 1,
      branchGeneration: 0,
      startedAt: "2026-07-31T20:00:00.000Z",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.active.goalId).toBe("goal-member");
    expect(prepared.active.workflowId).toBe("workflow-member");
  });

  it("R3 member cancel commands target the member attempt only", () => {
    const created = createHypagoalWorkflow(isolatedChildDefinition as any, {
      workflowId: "workflow-member",
      goalId: "goal-member",
      goalWorkflowId: "workflow-member",
      at: "2026-07-31T20:00:00.000Z",
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    let state = created.state;
    const started = handleCommand(state, {
      type: "start-node",
      nodeId: "implement-auth",
      attemptId: "attempt-child-run",
      commandId: "start-child",
      correlationId: "start-child",
      at: "2026-07-31T20:00:01.000Z",
    });
    if (!started.ok) throw new Error(JSON.stringify(started.diagnostics));
    state = started.state;

    const commands = buildOrphanedTaskCancelCommands({
      state,
      at: "2026-07-31T20:00:02.000Z",
      reason: "restore member cancel",
      correlationId: "corr-member",
      only: { nodeId: "implement-auth", attemptId: "attempt-child-run" },
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "cancel-attempt",
      nodeId: "implement-auth",
      attemptId: "attempt-child-run",
    });
  });

  /** Poll until the host reports an isolated worker start (or timeout). */
  const waitForWorkerStart = async (
    value: ReturnType<typeof harness>,
    timeoutMs = 2000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
      if (/started isolated worker for task 'implement-auth'/i.test(text)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(
      `Timed out waiting for isolated worker start.\n${value.notify.mock.calls.map((c) => String(c[0])).join("\n")}`,
    );
  };

  /**
   * Strict mid-flight settle proof: pre-start family would leave status ready.
   * cancel-attempt projects node + attempt to cancelled and emits hypagraph.attempt.cancelled.
   */
  const assertMemberAttemptCancelled = (
    family: NonNullable<ReturnType<typeof restoreLatestFamilySession>>,
    childWorkflowId: string,
    childGoalId: string,
  ): void => {
    const childStream = family.workflows[childWorkflowId];
    expect(childStream, `family must contain child workflow '${childWorkflowId}'`).toBeDefined();
    const node = childStream!.snapshot.runtime.nodes["implement-auth"];
    expect(node, "implement-auth runtime must exist").toBeDefined();
    expect(node!.status).toBe("cancelled");
    const attempts = Object.values(node!.attempts ?? {});
    expect(attempts.some((attempt) => attempt.status === "cancelled")).toBe(true);
    const cancelledEvents = childStream!.events.filter(
      (event) => event.type === "hypagraph.attempt.cancelled",
    );
    expect(cancelledEvents.length).toBeGreaterThan(0);
    expect(cancelledEvents[0]).toMatchObject({
      type: "hypagraph.attempt.cancelled",
      nodeId: "implement-auth",
    });
    expect(family.familySnapshot.members[childGoalId]).toBeDefined();
  };

  it("R3 executor cancel settles an active child worker into the family record", async () => {
    const value = harness();
    let resolveHang!: () => void;
    const hangPromise = new Promise<void>((resolve) => { resolveHang = resolve; });

    const fakeHost = createIsolatedPiHost({
      transport: {
        start: async (options: IsolatedPiStartOptions): Promise<IsolatedPiProcessHandle> => ({
          pid: 77_101,
          sessionId: `session-${options.identity.attemptId}`,
          ownershipToken: options.ownershipToken,
          identity: options.identity,
          runAttempt: async (context) => {
            await hangPromise;
            return buildExecutorResultPayload({
              identity: context.identity,
              outcome: "submitted",
              facts: [{
                name: "auth.ready",
                type: "boolean",
                value: true,
                evidence: [{ ref: "evidence://r3-cancel", kind: "note" }],
              }],
              evidence: [{ ref: "evidence://r3-cancel", kind: "note", summary: "released" }],
              summary: "hung child released",
            });
          },
          terminate: async () => {
            resolveHang();
          },
        }),
      },
      resolveCwd: () => process.cwd(),
      resolveCheckoutKey: () => process.cwd(),
      startedAt: () => "2026-07-31T20:10:00.000Z",
      createOwnershipToken: () => "token-r3-cancel",
    });
    bindActiveIsolatedPiHost(fakeHost);

    // Root without sibling so the controller selects the child after create.
    const rootNoSibling = {
      ...rootDefinition,
      nodes: rootDefinition.nodes.filter((node) => node.id !== "sibling"),
    };

    try {
      await value.tools.get("hypagoal_start")!.execute(
        "create-root",
        { objective, definition: rootNoSibling },
        undefined,
        undefined,
        value.ctx,
      );
      await value.tools.get("hypagraph_transition")!.execute(
        "start-delegate",
        { nodeId: "delegate", action: "start" },
        undefined,
        undefined,
        value.ctx,
      );
      await value.tools.get("hypagoal_create_child")!.execute(
        "create-child",
        {
          parentNodeId: "delegate",
          childObjective: "Implement the auth subsystem.",
          definition: isolatedChildDefinition,
          scopePaths: ["src/domain/**"],
          outputFacts: [{ name: "auth.ready", type: "boolean", required: true }],
          childGoalId: "goal-child-r3",
          childWorkflowId: "workflow-child-r3",
          bindingId: "binding-r3",
        },
        undefined,
        undefined,
        value.ctx,
      );

      // Start hanging child worker (mid-flight: family record still pre-start).
      const endPromise = agentEnd(value);
      await waitForWorkerStart(value);

      // Before cancel, family still has pre-start child (proves settle cannot rely on family alone).
      const familyBefore = restoreLatestFamilySession(value.entries);
      expect(
        familyBefore!.workflows["workflow-child-r3"]?.snapshot.runtime.nodes["implement-auth"]?.status,
      ).toBe("ready");

      value.notify.mockClear();
      await value.commands.get("hypagraph")!.handler("executor cancel", value.ctx);
      resolveHang();
      await endPromise;

      const notifyText = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
      // Success settle notify only — failure text must not pass.
      expect(notifyText).toMatch(
        /Hypagraph cancelled isolated task 'implement-auth' on member 'goal-child-r3'/,
      );
      expect(notifyText).not.toMatch(/could not cancel/i);
      expect(notifyText).not.toMatch(/stale_attempt/i);

      const family = restoreLatestFamilySession(value.entries);
      expect(family).toBeDefined();
      assertMemberAttemptCancelled(family!, "workflow-child-r3", "goal-child-r3");
    } finally {
      resolveHang?.();
      await fakeHost.teardownOnRestore({ kind: "other", reason: "r3 cancel cleanup" });
      bindActiveIsolatedPiHost(undefined);
    }
  });

  it("R3 session restore settles a mid-flight child worker into the family record", async () => {
    const value = harness();
    let resolveHang!: () => void;
    const hangPromise = new Promise<void>((resolve) => { resolveHang = resolve; });

    const fakeHost = createIsolatedPiHost({
      transport: {
        start: async (options: IsolatedPiStartOptions): Promise<IsolatedPiProcessHandle> => ({
          pid: 77_102,
          sessionId: `session-${options.identity.attemptId}`,
          ownershipToken: options.ownershipToken,
          identity: options.identity,
          runAttempt: async (context) => {
            await hangPromise;
            return buildExecutorResultPayload({
              identity: context.identity,
              outcome: "submitted",
              facts: [{
                name: "auth.ready",
                type: "boolean",
                value: true,
                evidence: [{ ref: "evidence://r3-restore", kind: "note" }],
              }],
              evidence: [{ ref: "evidence://r3-restore", kind: "note", summary: "released" }],
              summary: "hung child released after restore",
            });
          },
          terminate: async () => {
            resolveHang();
          },
        }),
      },
      resolveCwd: () => process.cwd(),
      resolveCheckoutKey: () => process.cwd(),
      startedAt: () => "2026-07-31T20:15:00.000Z",
      createOwnershipToken: () => "token-r3-restore",
    });
    bindActiveIsolatedPiHost(fakeHost);

    const rootNoSibling = {
      ...rootDefinition,
      nodes: rootDefinition.nodes.filter((node) => node.id !== "sibling"),
    };

    try {
      await value.tools.get("hypagoal_start")!.execute(
        "create-root",
        { objective, definition: rootNoSibling },
        undefined,
        undefined,
        value.ctx,
      );
      await value.tools.get("hypagraph_transition")!.execute(
        "start-delegate",
        { nodeId: "delegate", action: "start" },
        undefined,
        undefined,
        value.ctx,
      );
      await value.tools.get("hypagoal_create_child")!.execute(
        "create-child",
        {
          parentNodeId: "delegate",
          childObjective: "Implement the auth subsystem.",
          definition: isolatedChildDefinition,
          scopePaths: ["src/domain/**"],
          outputFacts: [{ name: "auth.ready", type: "boolean", required: true }],
          childGoalId: "goal-child-r3-restore",
          childWorkflowId: "workflow-child-r3-restore",
          bindingId: "binding-r3-restore",
        },
        undefined,
        undefined,
        value.ctx,
      );

      const endPromise = agentEnd(value);
      await waitForWorkerStart(value);

      // Family still pre-start. Restore sets host to root; settle must use cancelSnapshot.
      const familyBefore = restoreLatestFamilySession(value.entries);
      expect(
        familyBefore!.workflows["workflow-child-r3-restore"]?.snapshot.runtime.nodes["implement-auth"]?.status,
      ).toBe("ready");

      // session_start restore path (reload) while child worker is mid-flight.
      value.notify.mockClear();
      await invoke(value.handlers, "session_start", { type: "session_start" }, value.ctx);
      resolveHang();
      await endPromise.catch(() => undefined);

      const notifyText = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
      // Without cancelSnapshot, restore uses pre-start family → stale_attempt → "could not cancel".
      expect(notifyText).toMatch(
        /Hypagraph cancelled isolated task 'implement-auth' on member 'goal-child-r3-restore'/,
      );
      expect(notifyText).not.toMatch(/could not cancel/i);

      const family = restoreLatestFamilySession(value.entries);
      expect(family).toBeDefined();
      assertMemberAttemptCancelled(family!, "workflow-child-r3-restore", "goal-child-r3-restore");
    } finally {
      resolveHang?.();
      await fakeHost.teardownOnRestore({ kind: "other", reason: "r3 restore cleanup" });
      bindActiveIsolatedPiHost(undefined);
    }
  });

  it("R4 rejects current-session on non-root member dispatch with clear diagnostic", async () => {
    const value = harness();
    // No sibling: the only ready family work after create-child is the CS child.
    const rootNoSibling = {
      title: "R4 root no sibling",
      goal: objective,
      nodes: [
        {
          id: "delegate",
          title: "Delegate",
          requires: [],
          acceptance: [],
          scope: { paths: ["src/**"] },
          produces: [{ name: "auth.ready", type: "boolean", required: true }],
          executorProfile: { profileId: "current-session-delegate", kind: "current-session" },
        },
        {
          id: "integrate",
          title: "Integrate",
          requires: ["delegate"],
          acceptance: [],
          executorProfile: { profileId: "current-session-integrate", kind: "current-session" },
        },
      ],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };

    await value.tools.get("hypagoal_start")!.execute(
      "create-root",
      { objective, definition: rootNoSibling },
      undefined,
      undefined,
      value.ctx,
    );
    await value.tools.get("hypagraph_transition")!.execute(
      "start-delegate",
      { nodeId: "delegate", action: "start" },
      undefined,
      undefined,
      value.ctx,
    );
    await value.tools.get("hypagoal_create_child")!.execute(
      "create-child",
      {
        parentNodeId: "delegate",
        childObjective: "Implement the auth subsystem.",
        definition: currentSessionChildDefinition,
        scopePaths: ["src/domain/**"],
        outputFacts: [{ name: "auth.ready", type: "boolean", required: true }],
        childGoalId: "goal-child-r4",
        childWorkflowId: "workflow-child-r4",
        bindingId: "binding-r4",
      },
      undefined,
      undefined,
      value.ctx,
    );

    value.notify.mockClear();
    value.sendUserMessage.mockClear();
    await agentEnd(value);

    const allNotify = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(allNotify).toMatch(/Current-session is not supported on child/i);
    expect(allNotify).toContain("isolated-pi");
    // Must not deliver a CS implement follow-up for the child.
    const continuations = value.sendUserMessage.mock.calls.map((call) => String(call[0]));
    expect(continuations.some((text) => /implement-auth|automatic continuation/i.test(text))).toBe(false);
    expect(NON_ROOT_CURRENT_SESSION_BAN_REASON).toMatch(/Current-session is not supported on child/i);
  });

  it("R4 skill bans current-session on child members", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const skill = readFileSync(resolve(process.cwd(), "skills/hypagraph/SKILL.md"), "utf8");
    expect(skill).toMatch(/not supported on non-root member|until member continuation delivery/i);
    expect(skill).toMatch(/current-session/);
  });

  it("R5 mergeLiveRootIntoFamily keeps newer root sequence and child membership", () => {
    const rootCreated = createHypagoalWorkflow(rootDefinition as any, {
      workflowId: "workflow-root-r5",
      goalId: "goal-root-r5",
      goalWorkflowId: "workflow-root-r5",
      at: "2026-07-31T21:00:00.000Z",
    });
    if (!rootCreated.ok) throw new Error(JSON.stringify(rootCreated.diagnostics));
    let rootState = rootCreated.state;
    const rootEvents: DomainEvent[] = structuredClone(rootCreated.events ?? []);

    // Advance sibling on root so sequence grows.
    const startSibling = handleCommand(rootState, {
      type: "start-node",
      nodeId: "sibling",
      attemptId: "attempt-sibling",
      commandId: "start-sibling",
      correlationId: "start-sibling",
      at: "2026-07-31T21:00:01.000Z",
    });
    if (!startSibling.ok) throw new Error(JSON.stringify(startSibling.diagnostics));
    rootState = startSibling.state;
    const advancedRootEvents = [...rootEvents, ...startSibling.events];

    const childCreated = createHypagoalWorkflow(isolatedChildDefinition as any, {
      workflowId: "workflow-child-r5",
      goalId: "goal-child-r5",
      goalWorkflowId: "workflow-child-r5",
      at: "2026-07-31T21:00:00.000Z",
    });
    if (!childCreated.ok) throw new Error(JSON.stringify(childCreated.diagnostics));

    // Stale family root (pre-sibling advance) + child member stream.
    const family: PersistedGoalFamily = {
      schemaVersion: 1 as any,
      familyEvents: [],
      familySnapshot: {
        schemaVersion: 1,
        familyId: "family-r5",
        rootGoalId: "goal-root-r5",
        members: {
          "goal-root-r5": {
            goalId: "goal-root-r5",
            workflowId: "workflow-root-r5",
            depth: 0,
          },
          "goal-child-r5": {
            goalId: "goal-child-r5",
            workflowId: "workflow-child-r5",
            depth: 1,
            parentGoalId: "goal-root-r5",
          },
        },
        bindings: {},
        createdAt: "2026-07-31T21:00:00.000Z",
        updatedAt: "2026-07-31T21:00:00.000Z",
      } as any,
      workflows: {
        "workflow-root-r5": {
          events: structuredClone(rootCreated.events ?? []),
          snapshot: structuredClone(rootCreated.state),
        },
        "workflow-child-r5": {
          events: structuredClone(childCreated.events ?? []),
          snapshot: structuredClone(childCreated.state),
        },
      },
    };

    const staleRootSequence = family.workflows["workflow-root-r5"]!.snapshot.sequence;
    const merged = mergeLiveRootIntoFamily(family, {
      workflowId: "workflow-root-r5",
      events: advancedRootEvents,
      snapshot: rootState,
    });
    const withChild = replaceFamilyMemberWorkflow(merged, "workflow-child-r5", {
      events: childCreated.events ?? [],
      snapshot: childCreated.state,
    });

    expect(withChild.workflows["workflow-root-r5"]!.snapshot.sequence).toBeGreaterThan(staleRootSequence);
    expect(withChild.workflows["workflow-root-r5"]!.snapshot.runtime.nodes.sibling?.status).toMatch(
      /starting|running/,
    );
    expect(withChild.workflows["workflow-child-r5"]).toBeDefined();
    expect(withChild.familySnapshot.members["goal-child-r5"]).toBeDefined();
  });

  it("R5 extension path: sibling advance on root survives child isolated settle", async () => {
    const value = harness();
    const fakeHost = createIsolatedPiHost({
      transport: {
        start: async (options: IsolatedPiStartOptions): Promise<IsolatedPiProcessHandle> => ({
          pid: 88_001,
          sessionId: `session-${options.identity.attemptId}`,
          ownershipToken: options.ownershipToken,
          identity: options.identity,
          runAttempt: async (context) => buildExecutorResultPayload({
            identity: context.identity,
            outcome: "submitted",
            facts: [{
              name: "auth.ready",
              type: "boolean",
              value: true,
              evidence: [{ ref: "evidence://r5", kind: "note" }],
            }],
            evidence: [{ ref: "evidence://r5", kind: "note", summary: "r5" }],
            summary: "child done",
          }),
          terminate: async () => undefined,
        }),
      },
      resolveCwd: () => process.cwd(),
      resolveCheckoutKey: () => process.cwd(),
      startedAt: () => "2026-07-31T21:30:00.000Z",
      createOwnershipToken: () => "token-r5",
    });
    bindActiveIsolatedPiHost(fakeHost);

    try {
      await value.tools.get("hypagoal_start")!.execute(
        "create-root",
        { objective, definition: rootDefinition },
        undefined,
        undefined,
        value.ctx,
      );
      await value.tools.get("hypagraph_transition")!.execute(
        "start-delegate",
        { nodeId: "delegate", action: "start" },
        undefined,
        undefined,
        value.ctx,
      );
      await value.tools.get("hypagoal_create_child")!.execute(
        "create-child",
        {
          parentNodeId: "delegate",
          childObjective: "Implement the auth subsystem.",
          definition: isolatedChildDefinition,
          scopePaths: ["src/domain/**"],
          outputFacts: [{ name: "auth.ready", type: "boolean", required: true }],
          childGoalId: "goal-child-r5-e",
          childWorkflowId: "workflow-child-r5-e",
          bindingId: "binding-r5-e",
        },
        undefined,
        undefined,
        value.ctx,
      );

      // Advance and complete root sibling while parent waits (independent component).
      // Complete it fully so the controller does not prefer a pending sibling CS turn.
      await value.tools.get("hypagraph_transition")!.execute(
        "start-sibling",
        { nodeId: "sibling", action: "start" },
        undefined,
        undefined,
        value.ctx,
      );
      await value.tools.get("hypagraph_transition")!.execute(
        "publish-sibling",
        {
          nodeId: "sibling",
          action: "publish",
          facts: [{ name: "sibling.done", type: "boolean", value: true }],
        },
        undefined,
        undefined,
        value.ctx,
      );
      await value.tools.get("hypagraph_transition")!.execute(
        "submit-sibling",
        {
          nodeId: "sibling",
          action: "submit",
          evidence: [{ ref: "evidence://sibling-r5", kind: "note" }],
        },
        undefined,
        undefined,
        value.ctx,
      );
      await value.tools.get("hypagraph_transition")!.execute(
        "verify-sibling",
        { nodeId: "sibling", action: "verify" },
        undefined,
        undefined,
        value.ctx,
      );

      const liveBefore = await value.tools.get("hypagraph_read")!.execute(
        "read", {}, undefined, undefined, value.ctx,
      );
      const rootSeqBefore = liveBefore.details?.hypagraph?.snapshot?.sequence as number;
      expect(liveBefore.details?.hypagraph?.snapshot?.runtime?.nodes?.sibling?.status).toBe("succeeded");

      // Drive family controller (child isolated settle + return). Child persist must merge live root.
      await agentEnd(value);
      await agentEnd(value);
      await agentEnd(value);

      const family = restoreLatestFamilySession(value.entries);
      expect(family).toBeDefined();
      const rootMemberId = Object.keys(family!.familySnapshot.members).find(
        (id) => id !== "goal-child-r5-e",
      )!;
      const rootWorkflowId = family!.familySnapshot.members[rootMemberId]!.workflowId;
      const rootInFamily = family!.workflows[rootWorkflowId];
      expect(rootInFamily).toBeDefined();
      // After child persist + return, family root must keep sibling success (R5 merge).
      expect(rootInFamily!.snapshot.sequence).toBeGreaterThanOrEqual(rootSeqBefore);
      expect(rootInFamily!.snapshot.runtime.nodes.sibling?.status).toBe("succeeded");
      expect(family!.familySnapshot.members["goal-child-r5-e"]).toBeDefined();
    } finally {
      await fakeHost.teardownOnRestore({ kind: "other", reason: "r5 cleanup" });
      bindActiveIsolatedPiHost(undefined);
    }
  });
});
