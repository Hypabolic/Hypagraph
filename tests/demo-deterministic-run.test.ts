/**
 * Demo catalog graphs must advance on the deterministic lane only.
 * No model follow-up, no token budget limit, no task nodes.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ActiveCheckExecutionRegistry } from "../src/checks/active-executions.js";
import { CommandCheckExecutor } from "../src/checks/command-executor.js";
import { FileCheckArtifactStore } from "../src/checks/file-artifact-store.js";
import {
  isReadyCheckDecision,
  type ReadyCheckDecision,
} from "../src/domain/deterministic-check-dispatch.js";
import {
  dispatchReadyGate,
  isReadyGateDecision,
} from "../src/domain/deterministic-gate-dispatch.js";
import {
  isDispatchableGoalContinuation,
  isRunnableGoalContinuation,
  selectGoalContinuation,
} from "../src/domain/goal-continuation.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { DomainEvent, HypagraphState } from "../src/domain/model.js";
import { runDeterministicCheckDispatch } from "../src/pi/deterministic-check-runner.js";
import {
  listDemoExamples,
  resolveDemoExample,
} from "../src/pi/demo-catalog.js";
import {
  InMemoryWorkflowEventStore,
  type WorkflowEventStore,
} from "../src/persistence/event-store.js";
import hypagraphExtension from "../src/extension.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seededStore = (created: { state: HypagraphState; events: DomainEvent[] }): WorkflowEventStore => {
  const store = new InMemoryWorkflowEventStore();
  store.seed({ events: created.events, snapshot: created.state });
  return store;
};

const readyCheck = (state: HypagraphState): ReadyCheckDecision => {
  const decision = selectGoalContinuation(state);
  if (!isRunnableGoalContinuation(decision) || !isReadyCheckDecision(decision)) {
    throw new Error(`Expected a ready check, received '${decision.kind}'.`);
  }
  return decision;
};

/**
 * Advance one catalog graph through every check and gate until the controller
 * stops (interaction wait or completion). Never uses a model lane.
 */
const advanceDeterministicUntilStop = async (
  exampleId: string,
): Promise<{ state: HypagraphState; steps: string[] }> => {
  const example = resolveDemoExample(exampleId);
  if (!example) throw new Error(`Unknown demo '${exampleId}'.`);
  const workflowId = `workflow-demo-${exampleId}`;
  const created = createHypagoalWorkflow(example.definition(), {
    workflowId,
    goalId: `goal-demo-${exampleId}`,
    goalWorkflowId: workflowId,
    at: new Date().toISOString(),
    budget: example.budget,
  });
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));

  expect(created.state.goal?.budget.limits.maximumTokens).toBeUndefined();
  expect(created.state.goal?.budget.limits.maximumTurns).toBeGreaterThan(0);

  let state = created.state;
  const store = seededStore(created);
  const root = mkdtempSync(join(tmpdir(), "hypagraph-demo-"));
  const executor = new CommandCheckExecutor({
    rootDirectory: root,
    artifactStore: new FileCheckArtifactStore(join(root, "artifacts")),
  });
  const registry = new ActiveCheckExecutionRegistry();
  const steps: string[] = [];
  let guard = 0;

  while (guard < 64) {
    guard += 1;
    const decision = selectGoalContinuation(state);
    if (!isDispatchableGoalContinuation(decision)) {
      steps.push(decision.kind);
      break;
    }
    if (decision.kind === "request-ready-interaction") {
      steps.push(`interaction:${decision.nodeId}`);
      break;
    }
    if (isReadyCheckDecision(decision)) {
      // Use wall-clock times. The command executor stamps real completion times.
      const startedAt = new Date().toISOString();
      const dispatch = await runDeterministicCheckDispatch({
        state,
        decision: readyCheck(state),
        dispatchId: `check-${randomUUID()}`,
        attemptId: randomUUID(),
        at: startedAt,
        store,
        executor,
        registry,
      });
      if (!dispatch.ok) {
        throw new Error(
          `Check dispatch failed: ${JSON.stringify(dispatch.diagnostics ?? dispatch)}`,
        );
      }
      expect(dispatch.outcome).toBe("completed");
      state = dispatch.state;
      steps.push(`check:${decision.nodeId}`);
      continue;
    }
    if (isReadyGateDecision(decision)) {
      const gateAt = new Date().toISOString();
      const gate = dispatchReadyGate(state, {
        dispatchId: `gate-${randomUUID()}`,
        decision,
        at: gateAt,
      });
      if (!gate.ok) {
        throw new Error(`Gate dispatch failed: ${JSON.stringify(gate.diagnostics)}`);
      }
      state = gate.state;
      await store.append({
        workflowId: state.workflowId,
        expectedSequence: state.sequence - gate.events.length,
        events: gate.events,
        snapshot: state,
      });
      steps.push(`gate:${decision.nodeId}`);
      continue;
    }
    throw new Error(
      `Demo '${exampleId}' selected model-lane action '${decision.kind}' `
      + `(node ${(decision as { nodeId?: string }).nodeId ?? "n/a"}). Demos must stay deterministic.`,
    );
  }

  expect(state.goal?.status).not.toBe("budget_limited");
  expect(state.goal?.budget.consumedTurns ?? 0).toBe(0);
  expect(state.goal?.budget.consumedTokens.totalTokens ?? 0).toBe(0);
  return { state, steps };
};

describe("demo deterministic domain advance", () => {
  it("every catalog example advances without model-lane actions or token budget", async () => {
    for (const example of listDemoExamples()) {
      const { state, steps } = await advanceDeterministicUntilStop(example.id);
      expect(steps.length, `demo ${example.id} made no progress`).toBeGreaterThan(0);
      expect(
        steps.some((step) => step.startsWith("check:") || step.startsWith("gate:")),
        `demo ${example.id} must run at least one check or gate: ${steps.join(", ")}`,
      ).toBe(true);
      // Demos with interactions stop when the interaction is ready.
      const hasInteraction = example.definition().nodes.some(
        (node) => (node.kind ?? "task") === "interaction",
      );
      if (hasInteraction) {
        expect(
          steps.some((step) => step.startsWith("interaction:")),
          `demo ${example.id} must reach an interaction without model work: ${steps.join(", ")}`,
        ).toBe(true);
      }
      expect(state.goal?.budget.limits.maximumTokens).toBeUndefined();
    }
  }, 60_000);

  it("rich combined graph reaches final-approve through checks, gates, and the polish loop", async () => {
    const { state, steps } = await advanceDeterministicUntilStop("rich");
    expect(steps).toContain("check:docs-scan");
    expect(steps).toContain("check:code-scan");
    expect(steps).toContain("check:merge-intake");
    expect(steps).toContain("gate:risk-gate");
    expect(steps).toContain("check:light-touch");
    expect(steps).toContain("check:polish");
    expect(steps).toContain("check:acceptance");
    expect(steps.at(-1)).toBe("interaction:final-approve");
    expect(state.runtime.nodes["final-approve"]?.status).toBe("ready");
    expect(state.runtime.facts["intake.ready"]?.value).toBe(true);
    expect(state.runtime.facts["accept.ok"]?.value).toBe(true);
  }, 30_000);
});

describe("/hypagraph demo showcase Run is model-free", () => {
  interface CommandDefinition {
    handler: (args: string, ctx: any) => Promise<void>;
  }

  const harness = () => {
    const commands = new Map<string, CommandDefinition>();
    const notify = vi.fn();
    const sendUserMessage = vi.fn();
    const entries: any[] = [];
    // custom surfaces: post-create → Run, graph modal (stays open),
    // then interactions (basic: approve; pipeline/rich: ship).
    let graphDockOpened = false;
    let productDockCount = 0;
    let interactionAnswers = 0;
    const custom = vi.fn((factory: any, options?: any) => {
      // Live graph modal/dock factories pass onHandle.
      if (options?.onHandle) {
        graphDockOpened = true;
        return new Promise<void>(() => {
          try {
            const tui = {
              terminal: { columns: 120, rows: 40 },
              requestRender: vi.fn(),
            };
            const theme = { fg: (_n: string, v: string) => v };
            const handle = {
              focus: vi.fn(),
              unfocus: vi.fn(),
              hide: vi.fn(),
              setHidden: vi.fn(),
              isHidden: vi.fn(() => false),
              isFocused: vi.fn(() => false),
            };
            factory(tui, theme, {}, () => undefined);
            options.onHandle(handle);
          } catch {
            // Host-only paint; tests care that open was requested.
          }
        });
      }
      productDockCount += 1;
      // First product dock is post-create Run.
      if (productDockCount === 1) {
        return Promise.resolve({ kind: "run" as const });
      }
      // Tour interactions: basic uses approve; pipeline and rich use ship.
      interactionAnswers += 1;
      const responseId = interactionAnswers === 1 ? "approve" : "ship";
      return Promise.resolve({ kind: "response" as const, responseId });
    });
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, command: CommandDefinition) => {
        commands.set(name, command);
      }),
      appendEntry: vi.fn((customType: string, data?: unknown) => {
        entries.push({ type: "custom", customType, data });
      }),
      sendUserMessage,
      getActiveTools: vi.fn(() => ["read"]),
      setActiveTools: vi.fn(),
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      mode: "tui",
      ui: {
        confirm: vi.fn().mockResolvedValue(true),
        notify,
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        custom,
        input: vi.fn().mockResolvedValue(undefined),
        select: vi.fn(),
      },
      sessionManager: { getBranch: () => entries },
    };
    hypagraphExtension(pi);
    return { commands, notify, custom, sendUserMessage, ctx, entries, get graphDockOpened() { return graphDockOpened; } };
  };

  it("runs showcase tour after Run without model follow-up or token budget limit", async () => {
    const value = harness();
    await value.commands.get("hypagraph")!.handler("demo showcase", value.ctx);

    // No remote model continuation was queued.
    expect(value.sendUserMessage).not.toHaveBeenCalled();
    // Live graph sits in the above-composer widget (setWidget factory or lines).
    expect(value.ctx.ui.setWidget).toHaveBeenCalled();
    const widgetCalls = value.ctx.ui.setWidget.mock.calls
      .filter((call: unknown[]) => call[0] === "hypagraph");
    expect(widgetCalls.length).toBeGreaterThan(0);

    const text = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).not.toMatch(/token_limit|budget_limited/i);
    // Tour announces multiple graphs (Tour 1/6 · basic, …) or completes the tour.
    expect(text).toMatch(/Tour 1\/|Showcase tour|basic|loop|fanout|parallel|pipeline|rich/i);

    // Prefer reading final widget/status path via a status command.
    await value.commands.get("hypagraph")!.handler("status", value.ctx);
    const statusText = value.notify.mock.calls.map((call) => String(call[0])).join("\n");
    // Budget must not cap tokens (the previous failure mode charged chat tokens).
    expect(statusText).not.toMatch(/tokens \d+\/40000/);
    expect(statusText).not.toMatch(/budget_limited/);
  }, 120_000);
});
