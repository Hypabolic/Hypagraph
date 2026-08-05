/**
 * Wave F1: hypagoal_create_child on the product extension path.
 *
 * Covers A1/A2: tool registration, family commit, active-task gate,
 * post-create gate block, non-task parent rejection, and scope widen rejection.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { HYPAGRAPH_FAMILY_RECORD_TYPE } from "../src/persistence/family-store.js";
import { restoreLatestFamilySession } from "../src/persistence/family-session.js";

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

const rootObjective = "Ship a root that can create a child.";

const rootDefinition = {
  title: "Root with delegate task",
  goal: rootObjective,
  nodes: [
    {
      id: "delegate",
      title: "Delegate subsystem work",
      requires: [],
      acceptance: [],
      scope: { paths: ["src/**"] },
      produces: [{ name: "auth.ready", type: "boolean", required: true }],
    },
    {
      id: "integrate",
      title: "Integrate child outputs",
      requires: ["delegate"],
      acceptance: [],
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
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
};

const harness = (options?: { hasUI?: boolean; mode?: string }) => {
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
    getActiveTools: vi.fn(() => ["read", "write", "edit"]),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    hasUI: options?.hasUI ?? false,
    mode: options?.mode ?? "rpc",
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

const startRootAndParentTask = async (value: ReturnType<typeof harness>) => {
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
};

describe("Wave F1 hypagoal_create_child extension", () => {
  it("registers hypagoal_create_child", () => {
    const value = harness();
    expect(value.tools.has("hypagoal_create_child")).toBe(true);
  });

  it("creates a child from an active parent task and sets waiting_for_child", async () => {
    const value = harness();
    await startRootAndParentTask(value);

    const result = await value.tools.get("hypagoal_create_child")!.execute(
      "create-child",
      {
        parentNodeId: "delegate",
        childObjective: "Implement the auth subsystem.",
        definition: childDefinition,
        scopePaths: ["src/domain/**"],
        outputFacts: [{ name: "auth.ready", type: "boolean", required: true }],
        failurePolicy: "block-parent-node",
        childGoalId: "goal-child-f1",
        childWorkflowId: "workflow-child-f1",
        bindingId: "binding-f1",
      },
      undefined,
      undefined,
      value.ctx,
    );

    const text = String(result.content?.[0]?.text ?? "");
    expect(text).toContain("Child Hypagoal created.");
    expect(text).toContain("goal-child-f1");
    expect(text).toContain("waiting_for_child");
    expect(result.details?.hypagoalChild).toMatchObject({
      kind: "created",
      childGoalId: "goal-child-f1",
      childWorkflowId: "workflow-child-f1",
      bindingId: "binding-f1",
      parentNodeId: "delegate",
      parentWaitStatus: "waiting_for_child",
      memberCount: 2,
    });

    const family = restoreLatestFamilySession(value.entries);
    expect(family).toBeDefined();
    expect(Object.keys(family!.familySnapshot.members)).toHaveLength(2);
    expect(family!.familySnapshot.members["goal-child-f1"]?.depth).toBe(1);
    expect(family!.familySnapshot.bindings["binding-f1"]?.status).toBe("active");
    expect(family!.familySnapshot.bindings["binding-f1"]?.parentNodeId).toBe("delegate");
    expect(family!.workflows["workflow-child-f1"]?.snapshot.goal?.status).toBe("active");

    const parentSnapshot = result.details?.hypagraph?.snapshot;
    expect(parentSnapshot?.runtime?.nodes?.delegate?.status).toBe("waiting_for_child");

    const familyRecords = value.entries.filter(
      (entry) => entry.type === "custom" && entry.customType === HYPAGRAPH_FAMILY_RECORD_TYPE,
    );
    expect(familyRecords.length).toBeGreaterThan(0);
  });

  it("rejects child create when the parent node is not a task", async () => {
    const value = harness();
    await value.tools.get("hypagoal_start")!.execute(
      "create-root-check",
      {
        objective: "Root with a check parent.",
        definition: {
          title: "Check parent root",
          goal: "Root with a check parent.",
          nodes: [
            {
              id: "verify-only",
              title: "Verify only",
              kind: "check",
              requires: [],
              acceptance: [],
              check: {
                kind: "command",
                command: "true",
                timeoutMs: 1000,
                publish: [{ source: "passed", fact: "check.passed" }],
              },
              produces: [{ name: "check.passed", type: "boolean", required: true }],
            },
          ],
          loops: [],
          policy: { mode: "guided", requireEvidence: false },
        },
      },
      undefined,
      undefined,
      value.ctx,
    );

    // Start the check so it has an active attempt, then try child create.
    // Domain still rejects because kind is check, not task.
    await value.tools.get("hypagraph_run_check")!.execute(
      "run-check",
      { nodeId: "verify-only" },
      undefined,
      undefined,
      value.ctx,
    ).catch(() => undefined);

    const result = await value.tools.get("hypagoal_create_child")!.execute(
      "create-from-check",
      {
        parentNodeId: "verify-only",
        childObjective: "Should fail.",
        definition: childDefinition,
        scopePaths: ["src/**"],
      },
      undefined,
      undefined,
      value.ctx,
    );

    const text = String(result.content?.[0]?.text ?? "");
    expect(text).toContain("Child Hypagoal was not created");
    expect(result.details?.hypagoalChild?.kind).toBe("rejected");
    const codes = (result.details?.hypagoalChild?.diagnostics ?? []).map((d: { code: string }) => d.code);
    expect(codes.some((code: string) => /parent_not_task|child_goal_parent_not_task|not_active|no_current/i.test(code) || code.includes("task"))).toBe(true);
  });

  it("rejects child create before Run when the post-create gate is open", async () => {
    const value = harness({ hasUI: true, mode: "tui" });
    await value.tools.get("hypagoal_start")!.execute(
      "create-gated",
      { objective: rootObjective, definition: rootDefinition },
      undefined,
      undefined,
      value.ctx,
    );

    // Gate is open; do not start the parent task.
    const result = await value.tools.get("hypagoal_create_child")!.execute(
      "create-before-run",
      {
        parentNodeId: "delegate",
        childObjective: "Should fail before Run.",
        definition: childDefinition,
        scopePaths: ["src/**"],
      },
      undefined,
      undefined,
      value.ctx,
    );

    const text = String(result.content?.[0]?.text ?? "");
    expect(text).toContain("Child create is blocked until the user chooses Run after create");
    expect(result.details?.hypagoalChild).toMatchObject({
      kind: "rejected",
      diagnostics: [expect.objectContaining({ code: "child_create_blocked_post_create_gate" })],
    });
  });

  it("rejects a widened child scope beyond the parent grant", async () => {
    const value = harness();
    await startRootAndParentTask(value);

    const result = await value.tools.get("hypagoal_create_child")!.execute(
      "create-wide-scope",
      {
        parentNodeId: "delegate",
        childObjective: "Widen scope illegally.",
        definition: {
          ...childDefinition,
          nodes: [{
            ...childDefinition.nodes[0],
            scope: { paths: ["docs/**"] },
          }],
        },
        scopePaths: ["docs/**"],
      },
      undefined,
      undefined,
      value.ctx,
    );

    const text = String(result.content?.[0]?.text ?? "");
    expect(text).toContain("Child Hypagoal was not created");
    expect(result.details?.hypagoalChild?.kind).toBe("rejected");
    const message = JSON.stringify(result.details?.hypagoalChild?.diagnostics ?? []);
    expect(message.toLowerCase()).toMatch(/scope/);
  });

  it("rejects child create when the parent task is not active", async () => {
    const value = harness();
    await value.tools.get("hypagoal_start")!.execute(
      "create-root-idle",
      { objective: rootObjective, definition: rootDefinition },
      undefined,
      undefined,
      value.ctx,
    );
    // Parent task exists but was never started.

    const result = await value.tools.get("hypagoal_create_child")!.execute(
      "create-idle-parent",
      {
        parentNodeId: "delegate",
        childObjective: "Parent not active.",
        definition: childDefinition,
        scopePaths: ["src/**"],
      },
      undefined,
      undefined,
      value.ctx,
    );

    const text = String(result.content?.[0]?.text ?? "");
    expect(text).toContain("Child Hypagoal was not created");
    expect(result.details?.hypagoalChild?.kind).toBe("rejected");
  });

  it("blocks hypagoal_create_child through the post-create tool_call gate", async () => {
    const value = harness({ hasUI: true, mode: "tui" });
    await value.tools.get("hypagoal_start")!.execute(
      "create-for-tool-gate",
      { objective: rootObjective, definition: rootDefinition },
      undefined,
      undefined,
      value.ctx,
    );

    const blocked = await invoke(value.handlers, "tool_call", {
      type: "tool_call",
      toolName: "hypagoal_create_child",
      toolCallId: "gate-1",
      input: {},
    }, value.ctx);

    expect(blocked.some((item) => item && item.block === true)).toBe(true);
  });

  it("allows create-child from a current-session parent", async () => {
    const value = harness();
    const csRoot = {
      ...rootDefinition,
      nodes: [
        {
          ...rootDefinition.nodes[0],
          executorProfile: { profileId: "current-session-delegate", kind: "current-session" },
        },
        rootDefinition.nodes[1],
      ],
    };
    await value.tools.get("hypagoal_start")!.execute(
      "create-cs-root",
      { objective: rootObjective, definition: csRoot },
      undefined,
      undefined,
      value.ctx,
    );
    await value.tools.get("hypagraph_transition")!.execute(
      "start-cs-delegate",
      { nodeId: "delegate", action: "start" },
      undefined,
      undefined,
      value.ctx,
    );

    const result = await value.tools.get("hypagoal_create_child")!.execute(
      "create-from-cs",
      {
        parentNodeId: "delegate",
        childObjective: "Implement the auth subsystem.",
        definition: childDefinition,
        scopePaths: ["src/domain/**"],
        outputFacts: [{ name: "auth.ready", type: "boolean", required: true }],
        childGoalId: "goal-child-cs-f1",
        childWorkflowId: "workflow-child-cs-f1",
        bindingId: "binding-cs-f1",
      },
      undefined,
      undefined,
      value.ctx,
    );

    expect(result.details?.hypagoalChild?.kind).toBe("created");
    expect(String(result.content?.[0]?.text ?? "")).toContain("Child Hypagoal created.");
  });

  const hangWorkerHarness = async () => {
    const { configureHostRoutingForTests } = await import("../src/pi/host-routing-options.js");
    const {
      bindActiveIsolatedPiHost,
      createIsolatedPiHost,
    } = await import("../src/pi/isolated-pi-executor.js");
    const { buildExecutorResultPayload } = await import("../src/domain/executor-contract.js");

    configureHostRoutingForTests({ legacyCurrentSessionDefault: false });

    const value = harness();
    let releaseWorker: (() => void) | undefined;
    const hangPromise = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let workerSettledOutcome: string | undefined;

    const fakeHost = createIsolatedPiHost({
      transport: {
        start: async (options) => ({
          pid: 66_001,
          sessionId: `session-${options.identity.attemptId}`,
          ownershipToken: options.ownershipToken,
          identity: options.identity,
          runAttempt: async (context) => {
            await hangPromise;
            workerSettledOutcome = "submitted";
            return buildExecutorResultPayload({
              identity: context.identity,
              outcome: "submitted",
              facts: [{
                name: "worker.done",
                type: "boolean",
                value: true,
                evidence: [{ ref: "evidence://hang", kind: "note" }],
              }],
              evidence: [{ ref: "evidence://hang", kind: "note", summary: "released" }],
              summary: "hung worker released",
            });
          },
          terminate: async () => {
            releaseWorker?.();
          },
        }),
      },
      resolveCwd: () => process.cwd(),
      resolveCheckoutKey: () => process.cwd(),
      startedAt: () => "2026-07-31T19:00:00.000Z",
      createOwnershipToken: () => "token-f1-hang",
    });
    bindActiveIsolatedPiHost(fakeHost);

    return {
      value,
      fakeHost,
      configureHostRoutingForTests,
      bindActiveIsolatedPiHost,
      releaseWorker: () => releaseWorker?.(),
      getWorkerSettledOutcome: () => workerSettledOutcome,
      startAgentEnd: () => invoke(value.handlers, "agent_end", {
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
      }, value.ctx),
    };
  };

  it("rejects create-child when parentNodeId is the unsettled worker node", async () => {
    const hang = await hangWorkerHarness();
    try {
      await hang.value.tools.get("hypagoal_start")!.execute(
        "create-isolated-root",
        { objective: rootObjective, definition: rootDefinition },
        undefined,
        undefined,
        hang.value.ctx,
      );

      const agentEndPromise = hang.startAgentEnd();
      await new Promise((r) => setTimeout(r, 50));

      const result = await hang.value.tools.get("hypagoal_create_child")!.execute(
        "create-same-node-while-worker",
        {
          parentNodeId: "delegate",
          childObjective: "Must fail while worker owns delegate.",
          definition: childDefinition,
          scopePaths: ["src/domain/**"],
        },
        undefined,
        undefined,
        hang.value.ctx,
      );

      const text = String(result.content?.[0]?.text ?? "");
      expect(result.details?.hypagoalChild?.kind).toBe("rejected");
      expect(result.details?.hypagoalChild).toMatchObject({
        kind: "rejected",
        diagnostics: [expect.objectContaining({
          code: "child_create_blocked_active_worker_node",
        })],
      });
      expect(text).toMatch(/delegate/);
      expect(text).toMatch(/another parent node/i);
      expect(text).toMatch(/cancel the worker/i);

      // Tool gate must not block create-child while a worker is unsettled (family control).
      const gate = await invoke(hang.value.handlers, "tool_call", {
        type: "tool_call",
        toolName: "hypagoal_create_child",
        toolCallId: "worker-gate",
        input: {},
      }, hang.value.ctx);
      expect(gate.some((item) => item && item.block === true)).toBe(false);

      // Write/edit remain blocked while the worker owns the task.
      const writeBlocked = await invoke(hang.value.handlers, "tool_call", {
        type: "tool_call",
        toolName: "write",
        toolCallId: "write-gate",
        input: { path: "x.ts" },
      }, hang.value.ctx);
      expect(writeBlocked.some((item) => item && item.block === true)).toBe(true);

      // Worker settlement still succeeds after same-node create-child was rejected.
      hang.releaseWorker();
      await agentEndPromise;
      expect(hang.getWorkerSettledOutcome()).toBe("submitted");
    } finally {
      hang.releaseWorker();
      await hang.fakeHost.teardownOnRestore({ kind: "other", reason: "f1 same-node cleanup" });
      hang.bindActiveIsolatedPiHost(undefined);
      hang.configureHostRoutingForTests({ legacyCurrentSessionDefault: true });
    }
  });

  const multiTaskRootDefinition = (objective: string) => ({
    title: "Multi-task root",
    goal: objective,
    nodes: [
      {
        id: "worker-task",
        title: "Isolated worker task",
        requires: [],
        acceptance: [],
        scope: { paths: ["src/**"] },
        produces: [{ name: "worker.done", type: "boolean", required: true }],
      },
      {
        id: "desk-parent",
        title: "Desk parent for create-child",
        requires: [],
        acceptance: [],
        scope: { paths: ["src/**"] },
        produces: [{ name: "auth.ready", type: "boolean", required: true }],
        executorProfile: { profileId: "current-session-desk", kind: "current-session" },
      },
    ],
    loops: [],
    policy: { mode: "guided", requireEvidence: false },
  });

  /**
   * Desk-first concurrent path (acceptance #3 product reality).
   *
   * Start current-session desk-parent, then try to hang an isolated worker on
   * worker-task in the same workflow. Domain exclusive active-attempt ownership
   * rejects the second start. Concurrent create-child success on an active desk
   * parent while a worker is unsettled on another node is not reachable.
   *
   * Asserts: second start fails with exclusive-ownership diagnostic; create-child
   * on the already-active desk parent succeeds without a concurrent worker.
   */
  it("desk-first: exclusive ownership blocks worker hang while desk-parent is active; create-child succeeds on active desk without concurrent worker", async () => {
    const hang = await hangWorkerHarness();
    const multiRootObjective = "Ship multi-task root for desk-first concurrent path.";
    const multiRoot = multiTaskRootDefinition(multiRootObjective);

    try {
      await hang.value.tools.get("hypagoal_start")!.execute(
        "create-desk-first-root",
        { objective: multiRootObjective, definition: multiRoot },
        undefined,
        undefined,
        hang.value.ctx,
      );

      await hang.value.tools.get("hypagraph_transition")!.execute(
        "start-desk-first",
        { nodeId: "desk-parent", action: "start" },
        undefined,
        undefined,
        hang.value.ctx,
      );

      // Product outcome: cannot hang isolated worker on worker-task while desk is active.
      await expect(
        hang.value.tools.get("hypagraph_transition")!.execute(
          "start-worker-while-desk-active",
          { nodeId: "worker-task", action: "start" },
          undefined,
          undefined,
          hang.value.ctx,
        ),
      ).rejects.toThrow(/active attempt|already|node_already_active/i);

      // agent_end with one active current-session parent continues that parent; it does
      // not start a second isolated worker on worker-task under exclusive ownership.
      await hang.startAgentEnd();
      await new Promise((r) => setTimeout(r, 50));
      expect(hang.getWorkerSettledOutcome()).toBeUndefined();

      // create-child on the already-active desk parent succeeds (no concurrent worker).
      const createdOnDesk = await hang.value.tools.get("hypagoal_create_child")!.execute(
        "create-on-active-desk",
        {
          parentNodeId: "desk-parent",
          childObjective: "Child from active desk parent without concurrent worker.",
          definition: childDefinition,
          scopePaths: ["src/domain/**"],
          outputFacts: [{ name: "auth.ready", type: "boolean", required: true }],
          childGoalId: "goal-child-desk-first-f1",
          childWorkflowId: "workflow-child-desk-first-f1",
          bindingId: "binding-desk-first-f1",
        },
        undefined,
        undefined,
        hang.value.ctx,
      );
      expect(createdOnDesk.details?.hypagoalChild?.kind).toBe("created");
      expect(createdOnDesk.details?.hypagraph?.snapshot?.runtime?.nodes?.["desk-parent"]?.status)
        .toBe("waiting_for_child");
    } finally {
      hang.releaseWorker();
      await hang.fakeHost.teardownOnRestore({ kind: "other", reason: "f1 desk-first cleanup" });
      hang.bindActiveIsolatedPiHost(undefined);
      hang.configureHostRoutingForTests({ legacyCurrentSessionDefault: true });
    }
  });

  /**
   * Worker-first different parentNodeId + settlement.
   *
   * 1. worker-first, then start desk-parent is refused (host gate / exclusive ownership);
   * 2. while a worker is unsettled on worker-task, create-child with parentNodeId
   *    desk-parent is not rejected with child_create_blocked_active_worker_node;
   * 3. worker submit/settle still succeeds after that call;
   * 4. create-child succeeds on desk-parent when that parent is active after settlement.
   */
  it("same-node guard does not fire for a different parentNodeId; create-child succeeds on an active non-worker parent; worker settlement still succeeds", async () => {
    const hang = await hangWorkerHarness();
    const multiRootObjective = "Ship multi-task root for same-node guard tests.";
    const multiRoot = multiTaskRootDefinition(multiRootObjective);

    try {
      await hang.value.tools.get("hypagoal_start")!.execute(
        "create-multi-root",
        { objective: multiRootObjective, definition: multiRoot },
        undefined,
        undefined,
        hang.value.ctx,
      );

      // Worker first on worker-task (definition order prefers the isolated ready task).
      const agentEndPromise = hang.startAgentEnd();
      await new Promise((r) => setTimeout(r, 50));

      // Concurrent second task start is refused while the worker is unsettled.
      await expect(
        hang.value.tools.get("hypagraph_transition")!.execute(
          "start-desk-while-worker",
          { nodeId: "desk-parent", action: "start" },
          undefined,
          undefined,
          hang.value.ctx,
        ),
      ).rejects.toThrow(/isolated model worker/i);

      // Same-node guard must not fire for a different parentNodeId while worker is unsettled.
      // Domain rejects because desk-parent is not an active attempt.
      const whileWorker = await hang.value.tools.get("hypagoal_create_child")!.execute(
        "create-on-desk-while-worker",
        {
          parentNodeId: "desk-parent",
          childObjective: "Child while worker owns worker-task.",
          definition: childDefinition,
          scopePaths: ["src/domain/**"],
        },
        undefined,
        undefined,
        hang.value.ctx,
      );
      expect(whileWorker.details?.hypagoalChild?.kind).toBe("rejected");
      const whileCodes = (whileWorker.details?.hypagoalChild?.diagnostics ?? [])
        .map((d: { code: string }) => d.code);
      expect(whileCodes).not.toContain("child_create_blocked_active_worker_node");

      hang.releaseWorker();
      await agentEndPromise;
      expect(hang.getWorkerSettledOutcome()).toBe("submitted");

      // After worker settlement, create-child succeeds on an active non-worker parent.
      await hang.value.tools.get("hypagraph_transition")!.execute(
        "start-desk-parent-after-settle",
        { nodeId: "desk-parent", action: "start" },
        undefined,
        undefined,
        hang.value.ctx,
      );

      const createdOnDesk = await hang.value.tools.get("hypagoal_create_child")!.execute(
        "create-on-desk-after-settle",
        {
          parentNodeId: "desk-parent",
          childObjective: "Child from desk parent after worker settled.",
          definition: childDefinition,
          scopePaths: ["src/domain/**"],
          outputFacts: [{ name: "auth.ready", type: "boolean", required: true }],
          childGoalId: "goal-child-desk-f1",
          childWorkflowId: "workflow-child-desk-f1",
          bindingId: "binding-desk-f1",
        },
        undefined,
        undefined,
        hang.value.ctx,
      );
      expect(createdOnDesk.details?.hypagoalChild?.kind).toBe("created");
    } finally {
      hang.releaseWorker();
      await hang.fakeHost.teardownOnRestore({ kind: "other", reason: "f1 different-parent cleanup" });
      hang.bindActiveIsolatedPiHost(undefined);
      hang.configureHostRoutingForTests({ legacyCurrentSessionDefault: true });
    }
  });

  it("tool guidelines allow isolated parents and name the same-node worker guard", () => {
    const value = harness();
    const tool = (value.pi as any).registerTool.mock.calls
      .map((call: any[]) => call[0])
      .find((t: any) => t?.name === "hypagoal_create_child");
    expect(tool).toBeDefined();
    const guidelines = (tool.promptGuidelines ?? []).join("\n");
    expect(guidelines).toMatch(/isolated-pi/i);
    expect(guidelines).toMatch(/another parent node|cancel the worker/i);
    expect(guidelines).toMatch(/same-node|exclusive active task/i);
    expect(guidelines).not.toMatch(/Workers never create|never create child/i);
    expect(guidelines).not.toMatch(/must use.*current-session|requires.*current-session/i);
    expect(String(tool.description)).toMatch(/isolated-pi/i);
  });
});
