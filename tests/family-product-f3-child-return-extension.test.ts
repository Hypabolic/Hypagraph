/**
 * Wave F3: child return and parent integration on the product extension path.
 *
 * Covers A6/A7: terminal child success returns facts and leaves parent wait;
 * failure policies apply on the product path; parent is not completed by child success.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { handleCommand } from "../src/domain/reducer.js";
import type { DomainEvent, FactInput, HypagraphState } from "../src/domain/model.js";
import {
  HYPAGRAPH_FAMILY_RECORD_TYPE,
  type PersistedGoalFamily,
} from "../src/persistence/family-store.js";
import { restoreLatestFamilySession } from "../src/persistence/family-session.js";
import {
  childReturnOutcomeFromGoalStatus,
  collectChildReturnFacts,
  detectPendingChildReturn,
} from "../src/pi/family-product-return.js";

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
  title: "Root with delegate",
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

const at = "2026-07-31T15:00:00.000Z";

const driveChildToCompleted = (
  state: HypagraphState,
  facts: FactInput[],
): { state: HypagraphState; events: DomainEvent[] } => {
  const events: DomainEvent[] = [];
  let next = state;
  const nodeId = "implement-auth";
  const attemptId = "attempt-implement-auth-terminal";
  const apply = (command: Parameters<typeof handleCommand>[1]): void => {
    const result = handleCommand(next, command);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    events.push(...result.events);
    next = result.state;
  };
  apply({
    type: "start-node",
    nodeId,
    attemptId,
    commandId: `start-${attemptId}`,
    correlationId: `start-${attemptId}`,
    at,
  });
  apply({
    type: "publish-facts",
    nodeId,
    attemptId,
    facts: structuredClone(facts),
    commandId: `publish-${attemptId}`,
    correlationId: `publish-${attemptId}`,
    at,
  });
  apply({
    type: "submit-result",
    nodeId,
    attemptId,
    evidence: [{ ref: "evidence://child-terminal", kind: "note" }],
    commandId: `submit-${attemptId}`,
    correlationId: `submit-${attemptId}`,
    at,
  });
  apply({
    type: "begin-verification",
    nodeId,
    attemptId,
    commandId: `begin-${attemptId}`,
    correlationId: `begin-${attemptId}`,
    at,
  });
  apply({
    type: "complete-verification",
    nodeId,
    attemptId,
    passed: true,
    commandId: `complete-${attemptId}`,
    correlationId: `complete-${attemptId}`,
    at,
  });
  if (next.goal?.status !== "completed") {
    throw new Error(`Expected completed child goal, got '${next.goal?.status}'.`);
  }
  return { state: next, events };
};

const driveChildToCancelled = (
  state: HypagraphState,
): { state: HypagraphState; events: DomainEvent[] } => {
  const events: DomainEvent[] = [];
  let next = state;
  const result = handleCommand(next, {
    type: "cancel-goal",
    reason: "Test cancelled the child goal.",
    commandId: "cancel-child-terminal",
    correlationId: "cancel-child-terminal",
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  events.push(...result.events);
  next = result.state;
  return { state: next, events };
};

const withTerminalChildInFamily = (
  family: PersistedGoalFamily,
  childWorkflowId: string,
  driven: { state: HypagraphState; events: DomainEvent[] },
): PersistedGoalFamily => {
  const workflow = family.workflows[childWorkflowId];
  if (!workflow) throw new Error(`Missing child workflow '${childWorkflowId}'.`);
  return {
    ...family,
    workflows: {
      ...family.workflows,
      [childWorkflowId]: {
        events: [...workflow.events, ...driven.events],
        snapshot: driven.state,
      },
    },
  };
};

const startRootParentAndChild = async (value: ReturnType<typeof harness>, failurePolicy?: string) => {
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
      ...(failurePolicy === undefined ? {} : { failurePolicy }),
      childGoalId: "goal-child-f3",
      childWorkflowId: "workflow-child-f3",
      bindingId: "binding-f3",
    },
    undefined,
    undefined,
    value.ctx,
  );
  expect(created.details?.hypagoalChild?.kind).toBe("created");
  return created;
};

describe("Wave F3 product child return helpers", () => {
  it("maps terminal goal statuses to return outcomes", () => {
    expect(childReturnOutcomeFromGoalStatus("completed")).toBe("completed");
    expect(childReturnOutcomeFromGoalStatus("failed")).toBe("failed");
    expect(childReturnOutcomeFromGoalStatus("cancelled")).toBe("cancelled");
    expect(childReturnOutcomeFromGoalStatus("budget_limited")).toBe("budget_limited");
    expect(childReturnOutcomeFromGoalStatus("active")).toBeUndefined();
  });
});

describe("Wave F3 child return extension path", () => {
  it("returns completed child into parent and leaves waiting_for_child without completing parent", async () => {
    const value = harness();
    await startRootParentAndChild(value);

    let family = restoreLatestFamilySession(value.entries);
    expect(family).toBeDefined();
    const childStream = family!.workflows["workflow-child-f3"];
    expect(childStream).toBeDefined();

    const driven = driveChildToCompleted(childStream!.snapshot, [
      { name: "auth.ready", type: "boolean", value: true },
    ]);
    family = withTerminalChildInFamily(family!, "workflow-child-f3", driven);

    // Detect pending return before product apply.
    const pending = detectPendingChildReturn({
      family,
      childState: driven.state,
    });
    expect(pending).toMatchObject({
      bindingId: "binding-f3",
      outcome: "completed",
      childGoalId: "goal-child-f3",
    });
    expect(collectChildReturnFacts(driven.state, family!.familySnapshot.bindings["binding-f3"]!).length).toBe(1);

    // Append terminal child family record so controller sees it.
    value.entries.push({
      type: "custom",
      customType: HYPAGRAPH_FAMILY_RECORD_TYPE,
      data: family,
    });

    value.notify.mockClear();
    await agentEnd(value);

    const notifyText = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(notifyText).toMatch(/child completed|integrate returned facts/i);

    const after = restoreLatestFamilySession(value.entries);
    expect(after).toBeDefined();
    expect(after!.familySnapshot.bindings["binding-f3"]?.status).toBe("returned");
    expect(after!.familySnapshot.bindings["binding-f3"]?.returnRecord?.outcome).toBe("completed");
    expect(after!.familySnapshot.bindings["binding-f3"]?.returnRecord?.parentEffect).toBe("resumed");

    const parentSnap = after!.workflows[after!.familySnapshot.members[
      Object.keys(after!.familySnapshot.members).find((id) => id !== "goal-child-f3")!
    ]!.workflowId]?.snapshot
      ?? (await value.tools.get("hypagraph_read")!.execute("read", {}, undefined, undefined, value.ctx))
        .details?.hypagraph?.snapshot;

    const read = await value.tools.get("hypagraph_read")!.execute(
      "read",
      {},
      undefined,
      undefined,
      value.ctx,
    );
    const live = read.details?.hypagraph?.snapshot;
    expect(live?.runtime?.nodes?.delegate?.status).toBe("running");
    expect(live?.runtime?.nodes?.delegate?.currentAttemptId).toBeTruthy();
    // Parent task must not be succeeded solely because the child completed.
    expect(live?.runtime?.nodes?.delegate?.status).not.toBe("succeeded");
    expect(live?.goal?.status).toBe("active");
    // Integrate becomes ready only after parent completes; parent still running for integration.
    expect(live?.runtime?.nodes?.integrate?.status).toMatch(/pending|ready/);
    void parentSnap;
  });

  it("applies fail-parent-node when the child is cancelled", async () => {
    const value = harness();
    await startRootParentAndChild(value, "fail-parent-node");

    let family = restoreLatestFamilySession(value.entries);
    expect(family).toBeDefined();
    const childStream = family!.workflows["workflow-child-f3"];
    const driven = driveChildToCancelled(childStream!.snapshot);
    family = withTerminalChildInFamily(family!, "workflow-child-f3", driven);
    value.entries.push({
      type: "custom",
      customType: HYPAGRAPH_FAMILY_RECORD_TYPE,
      data: family,
    });

    value.notify.mockClear();
    await agentEnd(value);

    const after = restoreLatestFamilySession(value.entries);
    expect(after!.familySnapshot.bindings["binding-f3"]?.status).toMatch(/failed|cancelled|returned/);
    // Binding terminal status for cancelled child depends on domain mapping.
    const binding = after!.familySnapshot.bindings["binding-f3"];
    expect(binding?.status).not.toBe("active");
    expect(binding?.returnRecord?.outcome).toBe("cancelled");
    expect(binding?.returnRecord?.parentEffect).toBe("failed");

    const read = await value.tools.get("hypagraph_read")!.execute(
      "read",
      {},
      undefined,
      undefined,
      value.ctx,
    );
    const live = read.details?.hypagraph?.snapshot;
    expect(live?.runtime?.nodes?.delegate?.status).toBe("failed");
  });

  it("applies block-parent-node when the child is cancelled under block policy", async () => {
    const value = harness();
    await startRootParentAndChild(value, "block-parent-node");

    let family = restoreLatestFamilySession(value.entries);
    const childStream = family!.workflows["workflow-child-f3"];
    const driven = driveChildToCancelled(childStream!.snapshot);
    family = withTerminalChildInFamily(family!, "workflow-child-f3", driven);
    value.entries.push({
      type: "custom",
      customType: HYPAGRAPH_FAMILY_RECORD_TYPE,
      data: family,
    });

    await agentEnd(value);

    const after = restoreLatestFamilySession(value.entries);
    const binding = after!.familySnapshot.bindings["binding-f3"];
    expect(binding?.status).not.toBe("active");
    expect(binding?.returnRecord?.outcome).toBe("cancelled");
    expect(binding?.returnRecord?.parentEffect).toBe("blocked");

    const read = await value.tools.get("hypagraph_read")!.execute(
      "read",
      {},
      undefined,
      undefined,
      value.ctx,
    );
    const live = read.details?.hypagraph?.snapshot;
    expect(live?.runtime?.nodes?.delegate?.status).toBe("blocked");
  });

  it("does not complete the parent task when child return resumes it", async () => {
    const value = harness();
    await startRootParentAndChild(value);

    let family = restoreLatestFamilySession(value.entries)!;
    const driven = driveChildToCompleted(family.workflows["workflow-child-f3"]!.snapshot, [
      { name: "auth.ready", type: "boolean", value: true },
    ]);
    family = withTerminalChildInFamily(family, "workflow-child-f3", driven);
    value.entries.push({
      type: "custom",
      customType: HYPAGRAPH_FAMILY_RECORD_TYPE,
      data: family,
    });
    await agentEnd(value);

    const read = await value.tools.get("hypagraph_read")!.execute(
      "read",
      {},
      undefined,
      undefined,
      value.ctx,
    );
    const live = read.details?.hypagraph?.snapshot;
    expect(live?.runtime?.nodes?.delegate?.status).toBe("running");
    expect(live?.goal?.status).toBe("active");
    expect(live?.phase).not.toBe("completed");
  });
});
