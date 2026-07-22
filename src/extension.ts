import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { DomainEvent, HypagraphCommand, HypagraphDefinition, HypagraphState, PersistedHypagraph } from "./domain/model.js";
import { createWorkflow, handleCommand } from "./domain/reducer.js";
import { readyNodeIds } from "./domain/readiness.js";
import { restoreLatestSession } from "./persistence/session-rebuild.js";
import { formatDiagnostics, renderWidget, renderWorkflow, workflowSummary } from "./ui/format.js";

const factTypeSchema = StringEnum(["boolean", "integer", "number", "string", "duration", "timestamp", "string-list"] as const);
const factValueSchema = Type.Union([Type.Boolean(), Type.Number(), Type.String(), Type.Array(Type.String())]);
const conditionSchema = Type.Any({ description: "A Hypagraph condition AST. The domain validator checks its recursive structure, fact references, types, and limits." });
const factContractSchema = Type.Object({
  name: Type.String(),
  type: factTypeSchema,
  required: Type.Optional(Type.Boolean()),
});
const gateSchema = Type.Object({
  condition: conditionSchema,
  onTrue: Type.Array(Type.String(), { minItems: 1 }),
  onFalse: Type.Array(Type.String(), { minItems: 1 }),
});
const nodeSchema = Type.Object({
  id: Type.String({ description: "Stable lowercase node ID" }),
  title: Type.String(),
  description: Type.Optional(Type.String()),
  kind: Type.Optional(StringEnum(["task", "gate"] as const)),
  requires: Type.Optional(Type.Array(Type.String())),
  acceptance: Type.Optional(Type.Array(Type.String())),
  produces: Type.Optional(Type.Array(factContractSchema)),
  gate: Type.Optional(gateSchema),
  scope: Type.Optional(Type.Object({ paths: Type.Array(Type.String()) })),
});
const feedbackEdgeSchema = Type.Object({ from: Type.String(), to: Type.String() });
const loopSchema = Type.Object({
  id: Type.String(),
  nodes: Type.Array(Type.String()),
  entry: Type.String(),
  evaluateAfter: Type.String(),
  feedbackEdges: Type.Array(feedbackEdgeSchema),
  successWhen: Type.String({ description: "Reserved Boolean success predicate. Loop execution is not available before M4." }),
  maxIterations: Type.Integer({ minimum: 1 }),
  patience: Type.Optional(Type.Integer({ minimum: 1 })),
});
const definitionSchema = Type.Object({
  title: Type.String(),
  goal: Type.String(),
  nodes: Type.Array(nodeSchema, { minItems: 1 }),
  loops: Type.Optional(Type.Array(loopSchema)),
  policy: Type.Optional(Type.Object({
    mode: Type.Optional(StringEnum(["guided", "strict"] as const)),
    requireEvidence: Type.Optional(Type.Boolean()),
  })),
});
const evidenceSchema = Type.Object({
  ref: Type.String({ description: "Tool call, command, file, approval, or event reference" }),
  kind: Type.Optional(StringEnum(["tool", "command", "file", "approval", "note"] as const)),
  summary: Type.Optional(Type.String()),
});
const factInputSchema = Type.Object({
  name: Type.String(),
  type: factTypeSchema,
  value: factValueSchema,
  evidence: Type.Optional(Type.Array(evidenceSchema)),
});

export type HypagraphDefineInput = Static<typeof definitionSchema>;

function normalizeDefinition(input: HypagraphDefineInput): HypagraphDefinition {
  return {
    title: input.title.trim(),
    goal: input.goal.trim(),
    nodes: input.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      ...(node.description === undefined ? {} : { description: node.description }),
      ...(node.kind === undefined ? {} : { kind: node.kind }),
      requires: [...(node.requires ?? [])],
      acceptance: [...(node.acceptance ?? [])],
      ...(node.produces === undefined ? {} : { produces: node.produces.map((fact) => ({ ...fact })) }),
      ...(node.gate === undefined ? {} : { gate: structuredClone(node.gate) }),
      ...(node.scope === undefined ? {} : { scope: { paths: [...node.scope.paths] } }),
    })),
    loops: (input.loops ?? []).map((loop) => ({
      id: loop.id,
      nodes: [...loop.nodes],
      entry: loop.entry,
      evaluateAfter: loop.evaluateAfter,
      feedbackEdges: loop.feedbackEdges.map((edge) => ({ ...edge })),
      successWhen: loop.successWhen,
      maxIterations: loop.maxIterations,
      ...(loop.patience === undefined ? {} : { patience: loop.patience }),
    })),
    policy: { mode: input.policy?.mode ?? "guided", requireEvidence: input.policy?.requireEvidence ?? true },
  };
}

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

function updateUi(state: HypagraphState | undefined, ctx: ExtensionContext): void {
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

  const persisted = (): PersistedHypagraph => ({ events: structuredClone(events), snapshot: structuredClone(state!) });
  const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: { hypagraph: persisted() } });

  const restore = (ctx: ExtensionContext): void => {
    const session = restoreLatestSession(ctx.sessionManager.getBranch());
    state = session?.snapshot;
    events = session?.events ?? [];
    updateUi(state, ctx);
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

  pi.on("before_agent_start", async (event) => {
    if (!state || ["completed", "cancelled", "failed"].includes(state.phase)) return;
    const ready = readyNodeIds(state);
    const active = activeNode(state);
    return {
      systemPrompt: `${event.systemPrompt}\n\nHYPAGRAPH CONTROL:\n${renderWorkflow(state)}\nUse hypagraph_transition before and after work. Work only on the active node. Publish declared facts before result submission. Submit evidence before a separate verification action. Evaluate ready gates with the evaluate action. Ready nodes are [${ready.join(", ")}].${active ? ` The active node is '${active.id}'.` : " Start one ready task or evaluate one ready gate before you change the repository."}`,
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
    description: "Define and validate a directed coding workflow with task nodes, facts, and gates.",
    promptSnippet: "Define a validated workflow before multi-step coding work",
    promptGuidelines: ["Use hypagraph_define for work that needs explicit dependencies, typed facts, deterministic gates, and evidence."],
    parameters: definitionSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = createWorkflow(normalizeDefinition(params), new Date().toISOString(), randomUUID());
      if (!result.ok) return throwDiagnostics(result.diagnostics);
      state = result.state;
      events = [...result.events];
      updateUi(state, ctx);
      return textResult(`${renderWorkflow(state)}\n\nHypagraph accepted the definition.`);
    },
  });

  pi.registerTool({
    name: "hypagraph_read",
    label: "Read Hypagraph",
    description: "Read the workflow, active node, ready nodes, attempts, facts, routes, and node states.",
    promptSnippet: "Read the current Hypagraph state",
    parameters: Type.Object({ view: Type.Optional(StringEnum(["summary", "full"] as const)) }),
    async execute(_toolCallId, params) {
      if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
      const text = params.view === "full" ? renderWorkflow(state) : JSON.stringify(workflowSummary(state), null, 2);
      return textResult(text);
    },
  });

  pi.registerTool({
    name: "hypagraph_transition",
    label: "Transition Hypagraph",
    description: "Start, publish, submit, verify, evaluate, block, cancel, pause, or resume through the event-driven lifecycle.",
    promptSnippet: "Move Hypagraph through its deterministic lifecycle",
    promptGuidelines: ["Publish facts before submit. Submit evidence before a separate verify action. Evaluate gates instead of starting them."],
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
        if (params.action === "start") run({ type: "start-node", nodeId, attemptId: randomUUID(), commandId: randomUUID(), correlationId, at });
        else if (params.action === "evaluate") run({ type: "evaluate-gate", nodeId, commandId: randomUUID(), correlationId, at });
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
      updateUi(state, ctx);
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
      updateUi(state, ctx);
      return textResult(`${renderWorkflow(state!)}\n\nHypagraph accepted the revision.`);
    },
  });

  pi.registerCommand("hypagraph", {
    description: "Show the active Hypagraph status",
    handler: async (_args, ctx) => ctx.ui.notify(state ? renderWorkflow(state) : "There is no active Hypagraph.", "info"),
  });
}
