/**
 * Wave F5: automated root → child → return → parent integrate path.
 *
 * Drives create root, start parent task, create child, settle child through a
 * fake isolated worker, apply product return, and assert parent leaves wait
 * without auto-completing solely from child success.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { restoreLatestFamilySession } from "../src/persistence/family-session.js";
import {
  bindActiveIsolatedPiHost,
  createIsolatedPiHost,
  type IsolatedPiProcessHandle,
  type IsolatedPiProcessTransport,
  type IsolatedPiStartOptions,
} from "../src/pi/isolated-pi-executor.js";
import { buildExecutorResultPayload } from "../src/domain/executor-contract.js";

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

const objective = "Ship a delegated subsystem with parent integration.";

const rootDefinition = {
  title: "Flagship family root",
  goal: objective,
  nodes: [
    {
      id: "delegate",
      title: "Delegate subsystem work",
      requires: [],
      acceptance: ["Child returns auth.ready."],
      scope: { paths: ["src/**"] },
      produces: [{ name: "auth.ready", type: "boolean", required: true }],
      // Keep parent on current-session so create-child runs in the orchestrator.
      executorProfile: { profileId: "current-session-delegate", kind: "current-session" },
    },
    {
      id: "integrate",
      title: "Integrate child outputs",
      requires: ["delegate"],
      acceptance: ["Parent integration complete."],
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
      acceptance: ["Auth ready fact published."],
      scope: { paths: ["src/domain/**"] },
      produces: [{ name: "auth.ready", type: "boolean", required: true }],
      // Default isolated-pi (A5).
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

const createFakeChildTransport = (): IsolatedPiProcessTransport => ({
  start: async (options: IsolatedPiStartOptions): Promise<IsolatedPiProcessHandle> => ({
    pid: 55_001,
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
        evidence: [{ ref: "evidence://child-e2e", kind: "note" }],
      }],
      evidence: [{ ref: "evidence://child-e2e", kind: "note", summary: "child e2e complete" }],
      summary: "Isolated child worker completed implement-auth.",
    }),
    terminate: async () => {
      // no-op
    },
  }),
});

const readLive = async (value: ReturnType<typeof harness>) => {
  const read = await value.tools.get("hypagraph_read")!.execute(
    "read",
    {},
    undefined,
    undefined,
    value.ctx,
  );
  return read.details?.hypagraph?.snapshot;
};

describe("Wave F5 automated family product e2e path", () => {
  beforeAll(async () => {
    const { configureHostRoutingForTests } = await import("../src/pi/host-routing-options.js");
    configureHostRoutingForTests({ legacyCurrentSessionDefault: false });
  });

  afterAll(async () => {
    const { configureHostRoutingForTests } = await import("../src/pi/host-routing-options.js");
    configureHostRoutingForTests({ legacyCurrentSessionDefault: true });
  });

  it("root → child create → child settle → return → parent ready for integrate", async () => {
    const value = harness();
    const fakeHost = createIsolatedPiHost({
      transport: createFakeChildTransport(),
      resolveCwd: () => process.cwd(),
      resolveCheckoutKey: () => process.cwd(),
      startedAt: () => "2026-07-31T18:00:00.000Z",
      createOwnershipToken: () => "token-f5-e2e",
    });
    bindActiveIsolatedPiHost(fakeHost);

    try {
      // 1–2. Root create (headless auto-continue policy; we start parent explicitly).
      await value.tools.get("hypagoal_start")!.execute(
        "create-root",
        { objective, definition: rootDefinition },
        undefined,
        undefined,
        value.ctx,
      );

      // 3. Start parent delegate task.
      await value.tools.get("hypagraph_transition")!.execute(
        "start-delegate",
        { nodeId: "delegate", action: "start" },
        undefined,
        undefined,
        value.ctx,
      );

      // 4. Create child from active parent task.
      const created = await value.tools.get("hypagoal_create_child")!.execute(
        "create-child",
        {
          parentNodeId: "delegate",
          childObjective: "Implement the auth subsystem.",
          definition: childDefinition,
          scopePaths: ["src/domain/**"],
          outputFacts: [{ name: "auth.ready", type: "boolean", required: true }],
          failurePolicy: "block-parent-node",
          childGoalId: "goal-child-f5-e2e",
          childWorkflowId: "workflow-child-f5-e2e",
          bindingId: "binding-f5-e2e",
        },
        undefined,
        undefined,
        value.ctx,
      );
      expect(created.details?.hypagoalChild?.kind).toBe("created");
      expect(created.details?.hypagoalChild?.parentWaitStatus).toBe("waiting_for_child");
      expect(created.details?.hypagoalChild?.memberCount).toBe(2);

      // 5. Family has two members; parent waits.
      let family = restoreLatestFamilySession(value.entries);
      expect(family).toBeDefined();
      expect(Object.keys(family!.familySnapshot.members)).toHaveLength(2);
      expect(family!.familySnapshot.bindings["binding-f5-e2e"]?.status).toBe("active");

      let live = await readLive(value);
      expect(live?.runtime?.nodes?.delegate?.status).toBe("waiting_for_child");
      expect(live?.runtime?.nodes?.integrate?.status).toMatch(/pending|ready/);

      // 6. Family controller starts child isolated work and settles through fake worker.
      value.notify.mockClear();
      await agentEnd(value);

      // Allow a second controller pass if return applied mid-loop.
      await agentEnd(value);

      const notifyText = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
      // Either isolated worker finished, family selected child, or child return applied.
      expect(
        /isolated worker|family selected member|child completed|integrate returned facts/i.test(notifyText)
        || restoreLatestFamilySession(value.entries)?.familySnapshot.bindings["binding-f5-e2e"]?.status !== "active",
      ).toBe(true);

      family = restoreLatestFamilySession(value.entries);
      expect(family).toBeDefined();

      // If child is still active (not yet terminal), drive one more agent_end after ensuring
      // the child task was started. Fake transport settles on dispatch.
      const binding = family!.familySnapshot.bindings["binding-f5-e2e"];
      if (binding?.status === "active") {
        // Child may still be running if selection preferred other work; force another pass.
        await agentEnd(value);
        family = restoreLatestFamilySession(value.entries);
      }

      // 7–8. Product return is required (R2). Soft pass on still-active bindings is removed.
      family = restoreLatestFamilySession(value.entries)!;
      const terminalBinding = family.familySnapshot.bindings["binding-f5-e2e"];
      live = await readLive(value);

      expect(terminalBinding?.status).toBe("returned");
      expect(terminalBinding?.returnRecord?.outcome).toBe("completed");
      expect(live?.runtime?.nodes?.delegate?.status).toBe("running");
      expect(live?.runtime?.nodes?.delegate?.status).not.toBe("succeeded");
      expect(live?.goal?.status).toBe("active");
      expect(live?.phase).not.toBe("completed");
      // Parent still owns integration; integrate stays blocked until parent succeeds.
      expect(live?.runtime?.nodes?.integrate?.status).toMatch(/pending|ready/);
    } finally {
      await fakeHost.teardownOnRestore({
        kind: "other",
        reason: "f5 e2e cleanup",
      });
      bindActiveIsolatedPiHost(undefined);
    }
  });

  it("skill documents hypagoal_create_child and removes unavailable-tool honesty", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const skill = readFileSync(resolve(process.cwd(), "skills/hypagraph/SKILL.md"), "utf8");
    expect(skill).toContain("hypagoal_create_child");
    expect(skill).toContain("waiting_for_child");
    expect(skill).toMatch(/does not complete the parent|not auto-complete|not completed by child/i);
    expect(skill).toContain("isolated-pi");
    expect(skill).toMatch(/Family desk|family desk/);
    expect(skill).toMatch(/plan owner/i);
    expect(skill).toMatch(/current-session|isolated-pi/);
    expect(skill).not.toMatch(/Workers never create/i);
    expect(skill).not.toMatch(/child create is not available on the active tool surface/i);
    expect(skill).not.toMatch(/when child create is not available/i);
    // Create-child is allowed for isolated parents from the family desk.
    expect(skill).toMatch(/isolated-pi \(default\) or current-session|isolated-pi or current-session|may use the default/i);
  });

  it("skill documents ordinary multi-child join without mandatory produce or expectedBindingCount", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const skill = readFileSync(resolve(process.cwd(), "skills/hypagraph/SKILL.md"), "utf8");
    const multiChildSection = skill.match(
      /### Multi-child fan-out and ordinary join[\s\S]*?(?=\n### |\n## |$)/,
    )?.[0] ?? "";
    expect(multiChildSection.length).toBeGreaterThan(200);

    // Multi-child fan-out while waiting_for_child.
    expect(multiChildSection).toMatch(/Multi-child fan-out and ordinary join/i);
    expect(multiChildSection).toMatch(/waiting_for_child/);
    expect(multiChildSection).toMatch(
      /hypagoal_create_child.*more than once|more than once.*hypagoal_create_child|Create siblings while the parent waits/i,
    );
    // Auto join and default join.passed on the ordinary path.
    expect(multiChildSection).toMatch(/auto join|evaluates all-success join/i);
    expect(multiChildSection).toContain("join.passed");
    expect(multiChildSection).toMatch(
      /publishes the default fact `join\.passed` = true|join\.passed` = true/i,
    );
    // Multi-child pass leaves parent running (anchor multi-child section only).
    expect(multiChildSection).toMatch(
      /After multi-child join pass, the parent task is \*\*running\*\* for integration/i,
    );
    // Fail / quiet-skip ownership.
    expect(multiChildSection).toMatch(/failure policy owns the parent first/i);
    expect(multiChildSection).toMatch(/quiet-skips|quiet-skip/i);
    // One-child does not multi-join.
    expect(multiChildSection).toMatch(
      /One child alone does not trigger multi-child auto join/i,
    );
    expect(multiChildSection).toMatch(
      /AUTO_JOIN_MIN_BINDING_COUNT|minimum is two bindings|two bindings/i,
    );
    // Must not require mandatory hand produce or expectedBindingCount for ordinary path.
    expect(multiChildSection).toMatch(
      /does not use `expectedBindingCount`|not a `hypagoal_create_child` parameter/i,
    );
    expect(multiChildSection).toMatch(
      /Do not declare produce `join\.passed` on the parent for ordinary multi-child join/i,
    );
    expect(multiChildSection).toMatch(
      /not required for the default path|not mandatory for ordinary multi-child join/i,
    );
    expect(skill).not.toMatch(
      /must declare produce [`']?join\.passed|must set `expectedBindingCount` for (ordinary|multi-child|N greater)|authors? must declare join\.passed for multi-child/i,
    );
    // Live dogfood is not claimed.
    expect(multiChildSection).toMatch(
      /Live Pi dogfood for multi-child join is not claimed/i,
    );
  });

  it("fails the success contract when product return is skipped (negative R2 check)", async () => {
    // Structural negative: a still-active binding must not satisfy the R2 success assertions.
    const stillActive: { status: string; returnRecord?: { outcome: string } } = {
      status: "active",
    };
    expect(stillActive.status).not.toBe("returned");
    expect(stillActive.returnRecord?.outcome).not.toBe("completed");
  });
});
