import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ActiveCheckExecutionRegistry } from "./checks/active-executions.js";
import { CommandCheckExecutor } from "./checks/command-executor.js";
import { FileCheckArtifactStore } from "./checks/file-artifact-store.js";
import { recoverInterruptedChecks, recoverOrphanedLoopAttempts } from "./checks/recovery.js";
import { evaluateCheckStart } from "./domain/check-policy.js";
import type { DomainEvent, HypagraphCommand, HypagraphState, PersistedHypagraph } from "./domain/model.js";
import { createWorkflow } from "./domain/reducer.js";
import { readyNodeIds } from "./domain/readiness.js";
import { projectGraphView } from "./graph/projection.js";
import { applyCommandsAndCommit, commitCreatedWorkflow } from "./persistence/coordinator.js";
import { PiSessionWorkflowEventStore } from "./persistence/pi-session-store.js";
import { restoreLatestSession } from "./persistence/session-rebuild.js";
import { formatPiCheckResult, requireRunnableCommandCheck, runPiCommandCheck } from "./pi/check-tool.js";
import { definitionSchema, evidenceSchema, factInputSchema, normalizeDefinition } from "./pi/definition.js";
import { GraphPaneController } from "./pi/graph-pane.js";
import { formatDiagnostics, renderWidget, renderWorkflow, workflowSummary } from "./ui/format.js";

const throwDiagnostics = (diagnostics: readonly { code: string; message: string; location?: string }[]): never => {
  throw new Error(`Hypagraph rejected the operation:\n${formatDiagnostics(diagnostics)}`);
};

const patternToRegExp = (pattern: string): RegExp => {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*" && normalized[index + 1] === "*") { source += ".*"; index += 1; }
    else if (char === "*") source += "[^/]*";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}(?:/.*)?$`);
};

const scopeAllows = (cwd: string, candidatePath: string, patterns: readonly string[]): boolean => {
  const absolute = resolve(cwd, candidatePath.replace(/^@/, ""));
  const root = resolve(cwd);
  const local = relative(root, absolute).split(sep).join("/");
  if (local === ".." || local.startsWith("../")) return false;
  return patterns.some((pattern) => patternToRegExp(pattern).test(local));
};

const activeNode = (state: HypagraphState) => state.definition.nodes.find((node) => {
  const status = state.runtime.nodes[node.id]?.status;
  return status === "starting" || status === "running" || status === "awaiting_evidence" || status === "verifying";
});

function updateUi(
  state: HypagraphState | undefined,
  ctx: ExtensionContext,
  graphPane: GraphPaneController,
): void {
  graphPane.update(state);
  if (!state) {
    ctx.ui.setStatus("hypagraph", undefined);
    ctx.ui.setWidget("hypagraph", undefined);
    return;
  }
  const active = activeNode(state);
  ctx.ui.setStatus("hypagraph", `HG ${state.phase}: ${active?.id ?? `${readyNodeIds(state).length} ready`}`);
  ctx.ui.setWidget("hypagraph", renderWidget(state));
}

export default function hypagraphExtension(pi: ExtensionAPI): void {
  let state: HypagraphState | undefined;
  let events: DomainEvent[] = [];
  let sessionGeneration = 0;
  const graphPane = new GraphPaneController();
  const eventStore = new PiSessionWorkflowEventStore(pi);
  const activeExecutions = new ActiveCheckExecutionRegistry();

  const persisted = (): PersistedHypagraph => ({ events: structuredClone(events), snapshot: structuredClone(state!) });
  const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: { hypagraph: persisted() } });

  const ensureNoActiveExecution = (): void => {
    if (activeExecutions.hasActive()) throw new Error("A check is active. Cancel it or let it finish before another workflow change.");
  };

  const restore = async (ctx: ExtensionContext): Promise<void> => {
    sessionGeneration += 1;
    activeExecutions.cancelAll("The Pi session branch changed.");
    const session = restoreLatestSession(ctx.sessionManager.getBranch());
    eventStore.synchronize(session);
    state = session?.snapshot;
    events = session?.events ?? [];
    if (state) {
      const recoveryStore = eventStore.lease();
      const recovery = await recoverInterruptedChecks({
        state,
        store: recoveryStore,
        at: new Date().toISOString(),
        onCommit: (next) => graphPane.update(next),
      });
      state = recovery.state;
      events.push(...recovery.events);
      const orphaned = await recoverOrphanedLoopAttempts({
        state,
        store: recoveryStore,
        at: new Date().toISOString(),
        onCommit: (next) => graphPane.update(next),
      });
      state = orphaned.state;
      events.push(...orphaned.events);
      const recovered = [...recovery.recoveredAttemptIds, ...orphaned.recoveredAttemptIds];
      if (recovered.length > 0) {
        ctx.ui.notify(`Hypagraph closed interrupted attempts: ${recovered.join(", ")}.`, "warning");
      }
    }
    updateUi(state, ctx, graphPane);
  };

  const runCommands = async (commands: readonly HypagraphCommand[]): Promise<void> => {
    if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
    const result = await applyCommandsAndCommit(eventStore.lease(), state, commands);
    if (!result.ok) return throwDiagnostics(result.diagnostics);
    state = result.value.state;
    events.push(...result.value.events);
  };

  const nodeIdRequired = (nodeId: string | undefined): string => {
    if (!nodeId) throw new Error("This action requires a node ID.");
    return nodeId;
  };

  const cancelActiveChecks = (nodeId: string | undefined, reason: string): string[] => {
    if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
    return activeExecutions.cancel({
      workflowId: state.workflowId,
      ...(nodeId ? { nodeId } : {}),
      reason,
    }).map((entry) => entry.nodeId);
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", async () => {
    activeExecutions.cancelAll();
    graphPane.dispose();
  });

  pi.on("before_agent_start", async (event) => {
    if (!state || ["completed", "cancelled", "failed"].includes(state.phase)) return;
    const ready = readyNodeIds(state);
    const at = new Date().toISOString();
    const runnableChecks = state.definition.nodes
      .filter((node) => (node.kind ?? "task") === "check" && node.check)
      .filter((node) => {
        const runtime = state!.runtime.nodes[node.id];
        if (!runtime || !node.check) return false;
        return evaluateCheckStart(runtime, node.check, `preview-${state!.sequence}-${node.id}`, at).ok;
      })
      .map((node) => node.id);
    const active = activeNode(state);
    return {
      systemPrompt: `${event.systemPrompt}\n\nHYPAGRAPH CONTROL:\n${renderWorkflow(state)}\nUse hypagraph_transition before and after task work. Use hypagraph_run_check for a ready or retryable check node. Use hypagraph_cancel_check to stop an active check. Work only on the active task node. Publish declared task facts before result submission. Submit task evidence before a separate verification action. Evaluate ready gates with the evaluate action. Ready nodes are [${ready.join(", ")}]. Runnable checks are [${runnableChecks.join(", ")}].${active ? ` The active node is '${active.id}'.` : " Start one ready task, run one runnable check, or evaluate one ready gate before you change the repository."}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!state || state.definition.policy.mode !== "strict") return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const active = activeNode(state);
    if (!active) return { block: true, reason: "Hypagraph strict mode: Start a ready node before you change files." };
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return { block: true, reason: "Hypagraph strict mode: The file operation has no path." };
    const paths = active.scope?.paths ?? [];
    if (paths.length === 0) return { block: true, reason: `Hypagraph strict mode: Active node '${active.id}' has no writable scope.` };
    if (!scopeAllows(ctx.cwd, input.path, paths)) return { block: true, reason: `Hypagraph strict mode: '${input.path}' is outside the scope of node '${active.id}' [${paths.join(", ")}].` };
  });

  pi.registerTool({
    name: "hypagraph_define",
    label: "Define Hypagraph",
    description: "Define and validate a directed coding workflow with task, gate, and command-check nodes.",
    promptSnippet: "Define a validated workflow before multi-step coding work",
    promptGuidelines: ["Use hypagraph_define for work that needs explicit dependencies, typed facts, deterministic gates, checks, and evidence."],
    parameters: definitionSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureNoActiveExecution();
      const result = await commitCreatedWorkflow(
        eventStore.lease(),
        createWorkflow(normalizeDefinition(params), new Date().toISOString(), randomUUID()),
      );
      if (!result.ok) return throwDiagnostics(result.diagnostics);
      state = result.state;
      events = [...result.events];
      updateUi(state, ctx, graphPane);
      return textResult(`${renderWorkflow(state)}\n\nHypagraph accepted the definition.`);
    },
  });

  pi.registerTool({
    name: "hypagraph_read",
    label: "Read Hypagraph",
    description: "Read the workflow, graph projection, active node, ready nodes, attempts, facts, routes, checks, and node states.",
    promptSnippet: "Read the current Hypagraph state",
    parameters: Type.Object({ view: Type.Optional(StringEnum(["summary", "full", "graph"] as const)) }),
    async execute(_toolCallId, params) {
      if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
      const text = params.view === "full"
        ? renderWorkflow(state)
        : params.view === "graph"
          ? JSON.stringify(projectGraphView(state), null, 2)
          : JSON.stringify(workflowSummary(state), null, 2);
      return textResult(text);
    },
  });

  pi.registerTool({
    name: "hypagraph_run_check",
    label: "Run Hypagraph Check",
    description: "Run one ready or retryable command-check node with durable lifecycle commits, timeout, cancellation, bounded output, typed facts, and artifact references.",
    promptSnippet: "Run a deterministic command check",
    promptGuidelines: ["Use hypagraph_run_check only for a ready or retryable check node. Each retry uses a new attempt ID. Do not start a check with hypagraph_transition."],
    parameters: Type.Object({ nodeId: Type.String() }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
      if (activeExecutions.hasActive()) throw new Error("Another check tool call is active.");

      const runState = state;
      const nodeId = params.nodeId;
      const attemptId = randomUUID();
      const requestedAt = new Date().toISOString();
      const runnable = requireRunnableCommandCheck(runState, nodeId, attemptId, requestedAt);
      const commandText = [runnable.definition.command, ...(runnable.definition.arguments ?? [])].join(" ");
      const executor = new CommandCheckExecutor({
        rootDirectory: ctx.cwd,
        artifactStore: new FileCheckArtifactStore(resolve(ctx.cwd, ".hypagraph", "check-artifacts")),
      });
      const runGeneration = sessionGeneration;
      const execution = activeExecutions.register({
        workflowId: runState.workflowId,
        nodeId,
        attemptId,
        startedAt: requestedAt,
        ...(signal ? { upstreamSignal: signal } : {}),
      });

      let elapsedSeconds = 0;
      const action = runnable.retry ? "Retrying" : "Starting";
      onUpdate?.({
        content: [{ type: "text", text: `${action} check '${nodeId}': ${commandText}` }],
        details: { nodeId, attemptId, state: "starting", retry: runnable.retry, elapsedSeconds },
      });
      ctx.ui.setStatus("hypagraph-check", `Check ${nodeId}: starting`);
      const timer = setInterval(() => {
        elapsedSeconds += 1;
        onUpdate?.({
          content: [{ type: "text", text: `Check '${nodeId}' is running (${elapsedSeconds} s).` }],
          details: { nodeId, attemptId, state: "running", retry: runnable.retry, elapsedSeconds },
        });
        ctx.ui.setStatus("hypagraph-check", `Check ${nodeId}: ${elapsedSeconds}s`);
      }, 1_000);
      timer.unref();

      try {
        const lifecycle = await runPiCommandCheck({
          state: runState,
          executor,
          store: eventStore.lease(),
          nodeId,
          attemptId,
          requestedAt,
          signal: execution.signal,
          onTransition: (transition) => {
            if (sessionGeneration !== runGeneration) return;
            state = transition.state;
            events.push(...transition.events);
            updateUi(state, ctx, graphPane);
          },
        });
        if (sessionGeneration !== runGeneration) throw new Error("The Pi session changed while the check was active.");
        state = lifecycle.state;
        updateUi(state, ctx, graphPane);
        if (!lifecycle.ok) return throwDiagnostics(lifecycle.diagnostics);
        const text = `${formatPiCheckResult(state, nodeId, lifecycle.result)}\n\n${renderWorkflow(state)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: {
            hypagraph: persisted(),
            graph: projectGraphView(state),
            check: {
              nodeId,
              attemptId,
              retry: runnable.retry,
              result: structuredClone(lifecycle.result),
              commands: structuredClone(lifecycle.commands),
            },
          },
        };
      } finally {
        clearInterval(timer);
        execution.release();
        ctx.ui.setStatus("hypagraph-check", undefined);
      }
    },
  });

  pi.registerTool({
    name: "hypagraph_cancel_check",
    label: "Cancel Hypagraph Check",
    description: "Request cancellation of the active command check.",
    promptSnippet: "Cancel an active Hypagraph check",
    promptGuidelines: ["Use this tool only when a running check must stop. Cancellation is terminal for the current attempt."],
    parameters: Type.Object({
      nodeId: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const cancelled = cancelActiveChecks(params.nodeId, params.reason?.trim() || "The check was cancelled through Pi.");
      if (cancelled.length === 0) throw new Error(params.nodeId ? `Check '${params.nodeId}' is not active.` : "There is no active check.");
      return textResult(`Cancellation requested for: ${cancelled.join(", ")}.`);
    },
  });

  pi.registerTool({
    name: "hypagraph_transition",
    label: "Transition Hypagraph",
    description: "Start, publish, submit, verify, evaluate, block, cancel, pause, or resume through the durable event-driven lifecycle.",
    promptSnippet: "Move Hypagraph through its deterministic lifecycle",
    promptGuidelines: ["Use hypagraph_transition for task and gate lifecycle actions. Use hypagraph_run_check and hypagraph_cancel_check for checks."],
    parameters: Type.Object({
      nodeId: Type.Optional(Type.String()),
      action: StringEnum(["start", "publish", "submit", "verify", "evaluate", "block", "unblock", "cancel", "pause", "resume"] as const),
      facts: Type.Optional(Type.Array(factInputSchema)),
      evidence: Type.Optional(Type.Array(evidenceSchema)),
      passed: Type.Optional(Type.Boolean()),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
      const at = new Date().toISOString();
      const correlationId = randomUUID();
      const commands: HypagraphCommand[] = [];
      if (params.action === "pause") {
        ensureNoActiveExecution();
        commands.push({ type: "pause-workflow", commandId: randomUUID(), correlationId, at });
      } else if (params.action === "resume") {
        ensureNoActiveExecution();
        commands.push({ type: "resume-workflow", commandId: randomUUID(), correlationId, at });
      } else {
        const nodeId = nodeIdRequired(params.nodeId);
        if (params.action === "cancel") {
          const cancelled = cancelActiveChecks(nodeId, params.reason?.trim() || "The check was cancelled through Hypagraph transition.");
          if (cancelled.length > 0) return textResult(`Cancellation requested for check '${nodeId}'.`);
        }
        ensureNoActiveExecution();
        if (params.action === "start") {
          const node = state.definition.nodes.find((item) => item.id === nodeId);
          if ((node?.kind ?? "task") === "check") throw new Error(`Use hypagraph_run_check for check node '${nodeId}'.`);
          commands.push({ type: "start-node", nodeId, attemptId: randomUUID(), commandId: randomUUID(), correlationId, at });
        } else if (params.action === "evaluate") commands.push({ type: "evaluate-gate", nodeId, commandId: randomUUID(), correlationId, at });
        else if (params.action === "publish") {
          const attemptId = state.runtime.nodes[nodeId]?.currentAttemptId;
          if (!attemptId) throw new Error(`Node '${nodeId}' has no current attempt.`);
          commands.push({ type: "publish-facts", nodeId, attemptId, facts: structuredClone(params.facts ?? []), commandId: randomUUID(), correlationId, at });
        } else if (params.action === "submit") {
          const attemptId = state.runtime.nodes[nodeId]?.currentAttemptId;
          if (!attemptId) throw new Error(`Node '${nodeId}' has no current attempt.`);
          commands.push({ type: "submit-result", nodeId, attemptId, evidence: params.evidence ?? [], commandId: randomUUID(), correlationId, at });
        } else if (params.action === "verify") {
          const attemptId = state.runtime.nodes[nodeId]?.currentAttemptId;
          if (!attemptId) throw new Error(`Node '${nodeId}' has no current attempt.`);
          if (state.runtime.nodes[nodeId]?.status === "awaiting_evidence") {
            commands.push({ type: "begin-verification", nodeId, attemptId, commandId: randomUUID(), correlationId, at });
          }
          commands.push({ type: "complete-verification", nodeId, attemptId, passed: params.passed ?? true, ...(params.reason ? { reason: params.reason } : {}), commandId: randomUUID(), correlationId, at });
        } else if (params.action === "block") commands.push({ type: "block-node", nodeId, reason: params.reason ?? "", commandId: randomUUID(), correlationId, at });
        else if (params.action === "unblock") commands.push({ type: "unblock-node", nodeId, commandId: randomUUID(), correlationId, at });
        else {
          const attemptId = state.runtime.nodes[nodeId]?.currentAttemptId;
          if (!attemptId) throw new Error(`Node '${nodeId}' has no current attempt.`);
          commands.push({ type: "cancel-attempt", nodeId, attemptId, ...(params.reason ? { reason: params.reason } : {}), commandId: randomUUID(), correlationId, at });
        }
      }
      await runCommands(commands);
      updateUi(state, ctx, graphPane);
      return textResult(renderWorkflow(state));
    },
  });

  pi.registerTool({
    name: "hypagraph_revise",
    label: "Revise Hypagraph",
    description: "Replace the graph and invalidate changed work.",
    promptSnippet: "Revise a Hypagraph",
    parameters: definitionSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureNoActiveExecution();
      await runCommands([{ type: "revise", definition: normalizeDefinition(params), commandId: randomUUID(), at: new Date().toISOString() }]);
      updateUi(state, ctx, graphPane);
      return textResult(`${renderWorkflow(state!)}\n\nHypagraph accepted the revision.`);
    },
  });

  pi.registerCommand("hypagraph", {
    description: "Show Hypagraph status, cancel a check, or control the graph pane",
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const action = words.map((word) => word.toLowerCase()).join(" ");
      if (action === "graph" || action === "graph open") graphPane.open(ctx);
      else if (action === "graph close") graphPane.close();
      else if (action === "graph toggle") graphPane.toggle(ctx);
      else if (action === "graph focus") graphPane.focus();
      else if (words[0]?.toLowerCase() === "check" && words[1]?.toLowerCase() === "cancel") {
        const cancelled = cancelActiveChecks(words[2], "The user cancelled the check from Pi.");
        ctx.ui.notify(cancelled.length > 0 ? `Cancellation requested for: ${cancelled.join(", ")}.` : "There is no matching active check.", cancelled.length > 0 ? "warning" : "info");
      } else if (words[0]?.toLowerCase() === "check" && words[1]?.toLowerCase() === "active") {
        const active = state ? activeExecutions.list(state.workflowId) : [];
        ctx.ui.notify(active.length > 0 ? active.map((entry) => `${entry.nodeId} (${entry.attemptId})`).join("\n") : "There is no active check.", "info");
      } else ctx.ui.notify(state ? renderWorkflow(state) : "There is no active Hypagraph.", "info");
    },
  });
}
