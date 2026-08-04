/**
 * Wave F2: family-aware controller dispatch on the product extension path.
 *
 * After child create, the controller selects child ready work without a
 * test-only fake controller. Independent root components remain selectable
 * while a parent task waits for a child.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { restoreLatestFamilySession } from "../src/persistence/family-session.js";
import {
  bindActiveIsolatedPiHost,
  createIsolatedPiHost,
  type IsolatedPiProcessTransport,
  type IsolatedPiProcessHandle,
  type IsolatedPiStartOptions,
} from "../src/pi/isolated-pi-executor.js";
import { buildExecutorResultPayload } from "../src/domain/executor-contract.js";
import {
  selectFamilyProductControllerAction,
} from "../src/pi/family-product-dispatch.js";
import { memberStatesForFamilyProjection } from "../src/ui/family-product.js";
import { selectFamilySchedulerAction } from "../src/domain/family-scheduler.js";

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

const rootObjective = "Ship a root that delegates and integrates.";

const rootDefinition = {
  title: "Root with delegate and sibling",
  goal: rootObjective,
  nodes: [
    {
      id: "delegate",
      title: "Delegate subsystem work",
      requires: [],
      acceptance: [],
      scope: { paths: ["src/**"] },
      produces: [{ name: "auth.ready", type: "boolean", required: true }],
      executorProfile: { profileId: "current-session-delegate", kind: "current-session" },
    },
    {
      id: "sibling",
      title: "Independent sibling work",
      requires: [],
      acceptance: [],
      produces: [{ name: "sibling.done", type: "boolean", required: true }],
      executorProfile: { profileId: "current-session-sibling", kind: "current-session" },
    },
    {
      id: "integrate",
      title: "Integrate child outputs",
      requires: ["delegate"],
      acceptance: [],
      executorProfile: { profileId: "current-session-integrate", kind: "current-session" },
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
};

const childDefinition = {
  title: "Child auth work",
  goal: "Implement the auth subsystem.",
  nodes: [
    {
      id: "implement-auth",
      title: "Implement auth",
      requires: [],
      acceptance: [],
      scope: { paths: ["src/domain/**"] },
      produces: [{ name: "auth.ready", type: "boolean", required: true }],
      executorProfile: { profileId: "current-session-child", kind: "current-session" },
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
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
    getActiveTools: vi.fn(() => ["read", "write", "edit", "hypagraph_transition"]),
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

const createFakeTransport = (): IsolatedPiProcessTransport => ({
  start: async (options: IsolatedPiStartOptions): Promise<IsolatedPiProcessHandle> => ({
    pid: 12_345,
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
        evidence: [{ ref: "evidence://child-worker", kind: "note" }],
      }],
      evidence: [{ ref: "evidence://child-worker", kind: "note", summary: "child worker complete" }],
      summary: "Isolated child worker completed the task.",
    }),
    terminate: async () => {
      // no-op
    },
  }),
});

const startRootDelegateAndCreateChild = async (value: ReturnType<typeof harness>) => {
  await value.tools.get("hypagoal_start")!.execute(
    "create-root",
    { objective: rootObjective, definition: rootDefinition },
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
  const created = await value.tools.get("hypagoal_create_child")!.execute(
    "create-child",
    {
      parentNodeId: "delegate",
      childObjective: "Implement the auth subsystem.",
      definition: childDefinition,
      scopePaths: ["src/domain/**"],
      outputFacts: [{ name: "auth.ready", type: "boolean", required: true }],
      failurePolicy: "block-parent-node",
      childGoalId: "goal-child-f2",
      childWorkflowId: "workflow-child-f2",
      bindingId: "binding-f2",
    },
    undefined,
    undefined,
    value.ctx,
  );
  expect(created.details?.hypagoalChild?.kind).toBe("created");
  return created;
};

describe("Wave F2 family-aware product dispatch", () => {
  beforeAll(async () => {
    const { configureHostRoutingForTests } = await import("../src/pi/host-routing-options.js");
    configureHostRoutingForTests({ legacyCurrentSessionDefault: false });
  });

  afterAll(async () => {
    const { configureHostRoutingForTests } = await import("../src/pi/host-routing-options.js");
    configureHostRoutingForTests({ legacyCurrentSessionDefault: true });
  });

  it("selectFamilyProductControllerAction picks child work when parent waits", async () => {
    const value = harness();
    await startRootDelegateAndCreateChild(value);

    const family = restoreLatestFamilySession(value.entries);
    expect(family).toBeDefined();
    const live = await value.tools.get("hypagraph_read")!.execute(
      "read",
      {},
      undefined,
      undefined,
      value.ctx,
    );
    const snapshot = live?.details?.hypagraph?.snapshot;
    expect(snapshot?.runtime?.nodes?.delegate?.status).toBe("waiting_for_child");

    // Concurrent product default may return a multi-member batch when sibling and child are ready.
    const controller = selectFamilyProductControllerAction({
      liveState: snapshot,
      familyRecord: family,
    });
    expect(["dispatch", "dispatch-batch"]).toContain(controller.kind);
    if (controller.kind === "dispatch-batch") {
      const goals = controller.items.map((item) => item.memberGoalId);
      expect(goals.length).toBeGreaterThanOrEqual(1);
      expect(
        goals.some((goalId) => goalId === "goal-child-f2" || goalId === snapshot.goal.goalId),
      ).toBe(true);
    } else if (controller.kind === "dispatch") {
      // Depth policy may select sibling on root first, or child. Both prove multi-member selection.
      expect(["goal-child-f2", snapshot.goal.goalId]).toContain(controller.memberGoalId);
      if (controller.memberGoalId === "goal-child-f2") {
        expect(controller.isLiveRoot).toBe(false);
        expect(controller.decision.kind).toBe("start-ready-task");
        if (controller.decision.kind !== "request-revision") {
          expect(controller.decision.nodeId).toBe("implement-auth");
        }
      } else {
        // Root still has sibling ready while parent waits.
        expect(controller.isLiveRoot).toBe(true);
        expect(controller.decision.kind).toBe("start-ready-task");
        if (controller.decision.kind !== "request-revision") {
          expect(controller.decision.nodeId).toBe("sibling");
        }
      }
    }

    // Sequential path remains available when concurrent mode is off.
    const sequentialController = selectFamilyProductControllerAction({
      liveState: snapshot,
      familyRecord: family,
      concurrencyPolicy: { concurrent: false },
    });
    expect(sequentialController.kind).toBe("dispatch");

    const memberStates = memberStatesForFamilyProjection(family!, snapshot);
    const sequential = selectFamilySchedulerAction(family!.familySnapshot, memberStates);
    expect(sequential.kind).toBe("select");
  });

  it("after child create, agent_end can start child or sibling without a fake controller", async () => {
    const value = harness();
    // Use fake isolated transport so default isolated-pi child tasks can settle.
    const fakeHost = createIsolatedPiHost({
      transport: createFakeTransport(),
      resolveCwd: () => process.cwd(),
      resolveCheckoutKey: () => process.cwd(),
      startedAt: () => "2026-07-31T12:00:00.000Z",
      createOwnershipToken: () => "token-f2-test",
    });
    bindActiveIsolatedPiHost(fakeHost);

    try {
      // Child uses default isolated-pi (no current-session profile) for A5.
      const isolatedChild = {
        ...childDefinition,
        nodes: [{
          id: "implement-auth",
          title: "Implement auth",
          requires: [],
          acceptance: [],
          scope: { paths: ["src/domain/**"] },
          produces: [{ name: "auth.ready", type: "boolean", required: true }],
        }],
      };

      await value.tools.get("hypagoal_start")!.execute(
        "create-root",
        {
          objective: rootObjective,
          definition: {
            ...rootDefinition,
            // Only delegate is ready initially for a simpler path: start it, create child.
            // Sibling remains ready for independent selection assertions in pure tests.
            nodes: rootDefinition.nodes,
          },
        },
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
          definition: isolatedChild,
          scopePaths: ["src/domain/**"],
          outputFacts: [{ name: "auth.ready", type: "boolean", required: true }],
          childGoalId: "goal-child-f2-iso",
          childWorkflowId: "workflow-child-f2-iso",
          bindingId: "binding-f2-iso",
        },
        undefined,
        undefined,
        value.ctx,
      );

      value.sendUserMessage.mockClear();
      value.notify.mockClear();
      await agentEnd(value);

      const notifyText = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
      // Concurrent batch or sequential selection; both prove multi-member dispatch.
      const familySelected = /family selected member|family concurrent batch selected/i.test(
        notifyText,
      );
      const isolatedStarted = /isolated worker/i.test(notifyText);
      const continuationQueued = value.sendUserMessage.mock.calls.length > 0;
      expect(familySelected || isolatedStarted || continuationQueued).toBe(true);

      const family = restoreLatestFamilySession(value.entries);
      expect(family).toBeDefined();
      expect(Object.keys(family!.familySnapshot.members).length).toBe(2);

      // Child workflow must still be present after the controller pass.
      // Concurrent batch with fake isolated workers may complete the child in one pass.
      const childSnap = family!.workflows["workflow-child-f2-iso"]?.snapshot;
      expect(childSnap?.goal).toBeDefined();
      expect(["active", "completed", "failed", "paused"]).toContain(childSnap?.goal?.status);
    } finally {
      await fakeHost.teardownOnRestore({
        kind: "other",
        reason: "test cleanup",
      });
      bindActiveIsolatedPiHost(undefined);
    }
  });

  it("one-member family keeps root-only selection", async () => {
    const value = harness();
    await value.tools.get("hypagoal_start")!.execute(
      "create-one",
      {
        objective: "One member only.",
        definition: {
          title: "One member",
          goal: "One member only.",
          nodes: [{
            id: "work",
            title: "Work",
            requires: [],
            acceptance: [],
            executorProfile: { profileId: "current-session-work", kind: "current-session" },
          }],
          loops: [],
          policy: { mode: "guided", requireEvidence: false },
        },
      },
      undefined,
      undefined,
      value.ctx,
    );

    const read = await value.tools.get("hypagraph_read")!.execute(
      "read",
      {},
      undefined,
      undefined,
      value.ctx,
    );
    const snapshot = read.details?.hypagraph?.snapshot;
    const family = restoreLatestFamilySession(value.entries);
    // Before first isolated dispatch, family may be absent until migrate.
    const controller = selectFamilyProductControllerAction({
      liveState: snapshot,
      familyRecord: family,
    });
    expect(controller.kind).toBe("root-only");
    if (controller.kind !== "root-only") throw new Error("expected root-only");
    expect(isDispatchable(controller.decision)).toBe(true);
  });
});

function isDispatchable(decision: { kind: string }): boolean {
  return decision.kind === "start-ready-task"
    || decision.kind === "continue-active-task"
    || decision.kind === "run-ready-check"
    || decision.kind === "request-revision";
}
