/**
 * Wave F4: multi-member status, child-wait callouts, graph member focus, child artifacts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import { createRootFamily } from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import { handleCommand } from "../src/domain/reducer.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createBoundedChildGoal } from "../src/domain/child-goal-creation.js";
import {
  buildOneMemberPersistedFamily,
  commitBoundedChildGoalToPersistedFamily,
} from "../src/persistence/family-store.js";
import { projectFamilyGraphView } from "../src/graph/family-projection.js";
import { appendFamilyStatusBlock, renderFamilyStatus } from "../src/ui/family-surface.js";
import { GraphPaneController } from "../src/pi/graph-pane.js";
import { projectGraphView } from "../src/graph/projection.js";

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

const at = "2026-07-31T16:00:00.000Z";
const later = "2026-07-31T16:05:00.000Z";

const singleTask = (title: string, scopePaths?: string[]): HypagraphDefinition => ({
  title,
  goal: title,
  nodes: [{
    id: "work",
    title: "Work",
    requires: [],
    acceptance: [],
    ...(scopePaths ? { scope: { paths: scopePaths } } : {}),
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const createStartedWorkflow = (
  definition: HypagraphDefinition,
  workflowId: string,
  goalId: string,
): HypagraphState => {
  const result = createHypagoalWorkflow(definition, {
    workflowId,
    goalId,
    goalWorkflowId: workflowId,
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const startTask = (state: HypagraphState, nodeId: string): HypagraphState => {
  const result = handleCommand(state, {
    type: "start-node",
    nodeId,
    attemptId: `attempt-${nodeId}`,
    commandId: `start-${nodeId}`,
    correlationId: `start-${nodeId}`,
    at: later,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const multiMemberFamilyView = () => {
  let rootState = createStartedWorkflow(singleTask("Root", ["src/**"]), "workflow-root", "goal-root");
  rootState = startTask(rootState, "work");
  const familyResult = createRootFamily({
    familyId: "family-f4",
    rootGoalId: "goal-root",
    rootWorkflowId: "workflow-root",
    at,
  });
  if (!familyResult.ok) throw new Error(JSON.stringify(familyResult.diagnostics));
  const child = createBoundedChildGoal({
    family: familyResult.family,
    parentState: rootState,
    parentNodeId: "work",
    childDefinition: singleTask("Child", ["src/**"]),
    childGoalId: "goal-child-f4",
    childWorkflowId: "workflow-child-f4",
    bindingId: "binding-f4",
    at: later,
    scopePaths: ["src/**"],
    outputFacts: [{ name: "child.ready", type: "boolean", required: true }],
  });
  if (!child.ok) throw new Error(JSON.stringify(child.diagnostics));
  const view = projectFamilyGraphView({
    family: child.family,
    memberStates: {
      "goal-root": child.parentState,
      "goal-child-f4": child.childState,
    },
    focusedGoalId: "goal-root",
  });
  return { view, child, rootState: child.parentState };
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
    getActiveTools: vi.fn(() => ["read", "write", "edit"]),
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

describe("Wave F4 family status surface", () => {
  it("renderFamilyStatus includes child-wait callouts, members, bindings, budget, and focus", () => {
    const { view } = multiMemberFamilyView();
    const status = renderFamilyStatus(view, 120);
    expect(status).toContain("Family graph");
    expect(status).toContain("family-f4");
    expect(status).toContain("goal-root");
    expect(status).toContain("goal-child-f4");
    expect(status).toContain("Bindings (family edges, not definition edges)");
    expect(status).toContain("binding-f4");
    expect(status).toContain("Child wait:");
    expect(status).toMatch(/parent node 'work' waits for child 'goal-child-f4'/);
    expect(status).toContain("Focused member: goal-root");
    expect(status).toContain("Family budget:");
    expect(status).toContain("Members (nested workflow boundaries)");
  });

  it("appendFamilyStatusBlock shows full family block for multi-member views", () => {
    const { view } = multiMemberFamilyView();
    const combined = appendFamilyStatusBlock("ROOT STATUS", view, 100, { showOneMember: true });
    expect(combined).toContain("ROOT STATUS");
    expect(combined).toContain("Child wait:");
    expect(combined).toContain("goal-child-f4");
  });

  it("graph pane can focus a child member by goal id without merging graphs", () => {
    const { view, child } = multiMemberFamilyView();
    const pane = new GraphPaneController(() => []);
    pane.update(child.parentState);
    pane.updateFamily(view);

    expect(pane.familyFocusGoalIdForTest).toBe("goal-root");
    expect(pane.primaryWorkflowIdForTest).toBe("workflow-root");

    const focused = pane.focusFamilyMemberByGoalId("goal-child-f4");
    expect(focused).toEqual({ ok: true, goalId: "goal-child-f4" });
    expect(pane.familyFocusGoalIdForTest).toBe("goal-child-f4");
    expect(pane.primaryWorkflowIdForTest).toBe("workflow-child-f4");
    expect(pane.primaryTitleForTest).toContain("Child");

    const rootAgain = pane.focusFamilyMemberByGoalId("goal-root");
    expect(rootAgain.ok).toBe(true);
    expect(pane.primaryWorkflowIdForTest).toBe("workflow-root");

    const missing = pane.focusFamilyMemberByGoalId("goal-missing");
    expect(missing.ok).toBe(false);
  });

  it("/hypagraph status reports child wait and child artifact after create-child", async () => {
    const value = harness();
    const rootObjective = "Status surface root.";
    const rootDefinition = {
      title: "Status root",
      goal: rootObjective,
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
      ],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };
    const childDefinition = {
      title: "Child",
      goal: "Child work",
      nodes: [{
        id: "implement",
        title: "Implement",
        requires: [],
        acceptance: [],
        scope: { paths: ["src/**"] },
        produces: [{ name: "auth.ready", type: "boolean", required: true }],
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    };

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
    await value.tools.get("hypagoal_create_child")!.execute(
      "create-child",
      {
        parentNodeId: "delegate",
        childObjective: "Child work",
        definition: childDefinition,
        scopePaths: ["src/**"],
        outputFacts: [{ name: "auth.ready", type: "boolean", required: true }],
        childGoalId: "goal-child-status",
        childWorkflowId: "workflow-child-status",
        bindingId: "binding-status",
      },
      undefined,
      undefined,
      value.ctx,
    );

    value.notify.mockClear();
    await value.commands.get("hypagraph")!.handler("status", value.ctx);
    const statusText = value.notify.mock.calls.map((call) => String(call[0])).join("\n");

    expect(statusText).toMatch(/Family graph|Family:/);
    expect(statusText).toMatch(/Child wait:/);
    expect(statusText).toMatch(/parent node 'delegate' waits for child 'goal-child-status'/);
    expect(statusText).toMatch(/Child definition artifact:/);
    expect(statusText).toMatch(/workflow-child-status/);
    expect(statusText).toMatch(/Family focus:|Focused member:/);
    expect(statusText).toMatch(/members 2|memberCount|goal-child-status/);
  });

  it("/hypagraph graph member focuses a child when the family is live", async () => {
    const value = harness();
    const rootObjective = "Graph focus root.";
    await value.tools.get("hypagoal_start")!.execute(
      "create-root",
      {
        objective: rootObjective,
        definition: {
          title: "Graph focus root",
          goal: rootObjective,
          nodes: [{
            id: "delegate",
            title: "Delegate",
            requires: [],
            acceptance: [],
            scope: { paths: ["src/**"] },
            executorProfile: { profileId: "current-session-delegate", kind: "current-session" },
          }],
          loops: [],
          policy: { mode: "guided", requireEvidence: false },
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
        childObjective: "Child graph",
        definition: {
          title: "Child graph",
          goal: "Child graph",
          nodes: [{
            id: "implement",
            title: "Implement",
            requires: [],
            acceptance: [],
            scope: { paths: ["src/**"] },
          }],
          loops: [],
          policy: { mode: "guided", requireEvidence: false },
        },
        scopePaths: ["src/**"],
        childGoalId: "goal-child-graph",
        childWorkflowId: "workflow-child-graph",
        bindingId: "binding-graph",
      },
      undefined,
      undefined,
      value.ctx,
    );

    value.notify.mockClear();
    await value.commands.get("hypagraph")!.handler("graph member goal-child-graph", value.ctx);
    const text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toMatch(/focuses family member 'goal-child-graph'|Family member 'goal-child-graph'/);
  });
});
