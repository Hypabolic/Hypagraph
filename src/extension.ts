import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CommandCheckExecutor } from "./checks/command-executor.js";
import { FileCheckArtifactStore } from "./checks/file-artifact-store.js";
import type { DomainEvent, HypagraphCommand, HypagraphState, PersistedHypagraph } from "./domain/model.js";
import { createWorkflow, handleCommand } from "./domain/reducer.js";
import { readyNodeIds } from "./domain/readiness.js";
import { projectGraphView } from "./graph/projection.js";
import { restoreLatestSession } from "./persistence/session-rebuild.js";
import { formatPiCheckResult, runPiCommandCheck } from "./pi/check-tool.js";
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
  let checkExecutionActive = false;
  const graphPane = new GraphPaneController();

  const persisted = (): PersistedHypagraph => ({ events: structuredClone(events), snapshot: structuredClone(state!) });
  const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: { hypagraph: persisted() } });

  const restore = (ctx: ExtensionContext): void => {
    const session = restoreLatestSession(ctx.sessionManager.getBranch());
    state = session?.snapshot;
    events = session?.events ?? [];
    updateUi(state, ctx, graphPane);
  };

  const run = (command: HypagraphCommand): void => {
    if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
    const result = handleCommand(state, command);
    if (!result.ok) return throwDiagnostics(result.diagnostics);
    state = result.state;
    events.push(...result.events);
  };

  const nodeIdRequired = (nodeId: string | undefined): string => {
    if (!nodeId) throw new Error("This action requires a node ID.");
    return nodeId;
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", async () => graphPane.dispose());

  pi.on("before_agent_start", async (event) => {
    if (!state || ["completed", "cancelled", "failed"].includes(state.phase)) return;
    const ready = readyNodeIds(state);
    const readyChecks = ready.filter((nodeId) => {
      const node = state!.definition.nodes.find((item) => item.id === nodeId);
      return (node?.kind ?? "task") === "check";
    });
    const active = activeNode(state);
    return {
      systemPrompt: `${event.systemPrompt}\n\nHYPAGRAPH CONTROL:\n${renderWorkflow(state)}\nUse hypagraph_transition before and after task work. Use hypagraph_run_check for a ready check node. Work only on the active task node. Publish declared task facts before result submission. Submit task evidence before a separate verification action. Evaluate ready gates with the evaluate action. Ready nodes are [${ready.join(", ")}]. Ready checks are [${readyChecks.join(", ")}].${active ? ` The active node is '${active.id}'.` : " Start one ready task, run one ready check, or evaluate one ready gate before you change the repository."}`,
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
      const result = createWorkflow(normalizeDefinition(params), new Date().toISOString(), randomUUID());
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
    description: "Run one ready command-check node with a timeout, cancellation, bounded output, typed facts, and artifact references.",
    promptSnippet: "Run a ready deterministic command check",
    promptGuidelines: ["Use hypagraph_run_check only for a ready check node. Do not start a check with hypagraph_transition."],
    parameters: Type.Object({ nodeId: Type.String() }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
      if (checkExecutionActive) throw new Error("Another check tool call is active.");

      const nodeId = params.nodeId;
      const definitionNode = state.definition.nodes.find((node) => node.id === nodeId);
      if (!definitionNode || (definitionNode.kind ?? "task") !== "check" || !definitionNode.check) {
        throw new Error(`Node '${nodeId}' is not a check.`);
      }

      const commandText = [definitionNode.check.command, ...(definitionNode.check.arguments ?? [])].join(" ");
      const attemptId = randomUUID();
      const requestedAt = new Date().toISOString();
      const executor = new CommandCheckExecutor({
        rootDirectory: ctx.cwd,
        artifactStore: new FileCheckArtifactStore(resolve(ctx.cwd, ".hypagraph", "check-artifacts")),
      });

      checkExecutionActive = true;
      let elapsedSeconds = 0;
      onUpdate?.({
        content: [{ type: "text", text: `Starting check '${nodeId}': ${commandText}` }],
        details: { nodeId, attemptId, state: "starting", elapsedSeconds },
      });
      ctx.ui.setStatus("hypagraph-check", `Check ${nodeId}: starting`);
      const timer = setInterval(() => {
        elapsedSeconds += 1;
        onUpdate?.({
          content: [{ type: "text", text: `Check '${nodeId}' is running (${elapsedSeconds} s).` }],
          details: { nodeId, attemptId, state: "running", elapsedSeconds },
        });
        ctx.ui.setStatus("hypagraph-check", `Check ${nodeId}: ${elapsedSeconds}s`);
      }, 1_000);
      timer.unref();

      try {
        const lifecycle = await runPiCommandCheck({
          state,
          executor,
          nodeId,
          attemptId,
          requestedAt,
          signal,
          onTransition: (transition) => graphPane.update(transition.state),
        });
        state = lifecycle.state;
        events.push(...lifecycle.events);
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
              result: structuredClone(lifecycle.result),
              commands: structuredClone(lifecycle.commands),
            },
          },
        };
      } finally {
        clearInterval(timer);
        checkExecutionActive = false;
        ctx.ui.setStatus("hypagraph-check", undefined);
      }
    },
  });

  pi.registerTool({
    name: "hypagraph_transition",
    label: "Transition Hypagraph",
    description: "Start, publish, submit, verify, evaluate, block, cancel, pause, or resume through the event-driven lifecycle.",
    promptSnippet: "Move Hypagraph through its deterministic lifecycle",
    promptGuidelines: ["Use hypagraph_transition for task and gate lifecycle actions. Use hypagraph_run_check for checks."],
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
      if (params.action === "pause") run({ type: "pause-workflow", commandId: randomUUID(), correlationId, at });
      else if (params.action === "resume") run({ type: "resume-workflow", commandId: randomUUID(), correlationId, at });
      else {
        const nodeId = nodeIdRequired(params.nodeId);
        if (params.action === "start") {
          const node = state.definition.nodes.find((item) => item.id === nodeId);
          if ((node?.kind ?? "task") === "check") throw new Error(`Use hypagraph_run_check for check node '${nodeId}'.`);
          run({ type: "start-node", nodeId, attemptId: randomUUID(), commandId: randomUUID(), correlationId, at });
        } else if (params.action === "evaluate") run({ type: "evaluate-gate", nodeId, commandId: randomUUID(), correlationId, at });
        else if (params.action === "publish") {
          const attemptId = state.runtime.nodes[nodeId]?.currentAttemptId;
          if (!attemptId) throw new Error(`Node '${nodeId}' has no current attempt.`);
          run({ type: "publish-facts", nodeId, attemptId, facts: structuredClone(params.facts ?? []), commandId: randomUUID(), correlationId, at });
        } else if (params.action === "submit") {
          const attemptId = state.runtime.nodes[nodeId]?.currentAttemptId;
          if (!attemptId) throw new Error(`Node '${nodeId}' has no current attempt.`);
          run({ type: "submit-result", nodeId, attemptId, evidence: params.evidence ?? [], commandId: randomUUID(), correlationId, at });
        } else if (params.action === "verify") {
          const attemptId = state.runtime.nodes[nodeId]?.currentAttemptId;
          if (!attemptId) throw new Error(`Node '${nodeId}' has no current attempt.`);
          if (state.runtime.nodes[nodeId]?.status === "awaiting_evidence") run({ type: "begin-verification", nodeId, attemptId, commandId: randomUUID(), correlationId, at });
          run({ type: "complete-verification", nodeId, attemptId, passed: params.passed ?? true, ...(params.reason ? { reason: params.reason } : {}), commandId: randomUUID(), correlationId, at });
        } else if (params.action === "block") run({ type: "block-node", nodeId, reason: params.reason ?? "", commandId: randomUUID(), correlationId, at });
        else if (params.action === "unblock") run({ type: "unblock-node", nodeId, commandId: randomUUID(), correlationId, at });
        else {
          const attemptId = state.runtime.nodes[nodeId]?.currentAttemptId;
          if (!attemptId) throw new Error(`Node '${nodeId}' has no current attempt.`);
          run({ type: "cancel-attempt", nodeId, attemptId, ...(params.reason ? { reason: params.reason } : {}), commandId: randomUUID(), correlationId, at });
        }
      }
      updateUi(state, ctx, graphPane);
      return textResult(renderWorkflow(state));
    },
  });

  pi.registerTool({
    name: "hypagraph_revise",
    label: "Revise Hypagraph",
    description: "Replace the graph definition and invalidate changed work.",
    promptSnippet: "Revise a Hypagraph",
    parameters: definitionSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      run({ type: "revise", definition: normalizeDefinition(params), commandId: randomUUID(), at: new Date().toISOString() });
      updateUi(state, ctx, graphPane);
      return textResult(`${renderWorkflow(state!)}\n\nHypagraph accepted the revision.`);
    },
  });

  pi.registerCommand("hypagraph", {
    description: "Show Hypagraph status or control the graph pane",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "graph" || action === "graph open") graphPane.open(ctx);
      else if (action === "graph close") graphPane.close();
      else if (action === "graph toggle") graphPane.toggle(ctx);
      else if (action === "graph focus") graphPane.focus();
      else ctx.ui.notify(state ? renderWorkflow(state) : "There is no active Hypagraph.", "info");
    },
  });
}
