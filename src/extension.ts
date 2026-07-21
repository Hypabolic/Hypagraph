import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { HypagraphDefinition, HypagraphState } from "./domain/model.js";
import { createWorkflow, reduceHypagraph } from "./domain/reducer.js";
import { readyNodeIds } from "./domain/readiness.js";
import { restoreLatestSnapshot } from "./persistence/session-rebuild.js";
import { formatDiagnostics, renderWidget, renderWorkflow, workflowSummary } from "./ui/format.js";

const nodeSchema = Type.Object({
  id: Type.String({ description: "Stable lowercase node ID" }),
  title: Type.String(),
  description: Type.Optional(Type.String()),
  requires: Type.Optional(Type.Array(Type.String())),
  acceptance: Type.Optional(Type.Array(Type.String())),
  scope: Type.Optional(Type.Object({ paths: Type.Array(Type.String()) })),
});

const feedbackEdgeSchema = Type.Object({ from: Type.String(), to: Type.String() });
const loopSchema = Type.Object({
  id: Type.String(),
  nodes: Type.Array(Type.String()),
  entry: Type.String(),
  evaluateAfter: Type.String(),
  feedbackEdges: Type.Array(feedbackEdgeSchema),
  successWhen: Type.String({ description: "Reserved CEL-style Boolean success predicate" }),
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

export type HypagraphDefineInput = Static<typeof definitionSchema>;

function normalizeDefinition(input: HypagraphDefineInput): HypagraphDefinition {
  return {
    title: input.title.trim(),
    goal: input.goal.trim(),
    nodes: input.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      ...(node.description === undefined ? {} : { description: node.description }),
      requires: [...(node.requires ?? [])],
      acceptance: [...(node.acceptance ?? [])],
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
    policy: {
      mode: input.policy?.mode ?? "guided",
      requireEvidence: input.policy?.requireEvidence ?? true,
    },
  };
}

const textResult = (text: string, state: HypagraphState) => ({
  content: [{ type: "text" as const, text }],
  details: { hypagraph: state },
});

const throwDiagnostics = (diagnostics: readonly { code: string; message: string; location?: string }[]): never => {
  throw new Error(`Hypagraph rejected the operation:\n${formatDiagnostics(diagnostics)}`);
};

const patternToRegExp = (pattern: string): RegExp => {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
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

function updateUi(state: HypagraphState | undefined, ctx: ExtensionContext): void {
  if (!state) {
    ctx.ui.setStatus("hypagraph", undefined);
    ctx.ui.setWidget("hypagraph", undefined);
    return;
  }
  const active = state.definition.nodes.find((node) => state.runtime.nodes[node.id]?.status === "active");
  ctx.ui.setStatus("hypagraph", `HG ${state.phase}: ${active?.id ?? `${readyNodeIds(state).length} ready`}`);
  ctx.ui.setWidget("hypagraph", renderWidget(state));
}

export default function hypagraphExtension(pi: ExtensionAPI): void {
  let state: HypagraphState | undefined;

  const restore = (ctx: ExtensionContext): void => {
    state = restoreLatestSnapshot(ctx.sessionManager.getBranch());
    updateUi(state, ctx);
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));

  pi.on("before_agent_start", async (event) => {
    if (!state || state.phase === "completed" || state.phase === "cancelled") return;
    const ready = readyNodeIds(state);
    const active = state.definition.nodes.find((node) => state!.runtime.nodes[node.id]?.status === "active");
    return {
      systemPrompt: `${event.systemPrompt}\n\nHYPAGRAPH CONTROL:\n${renderWorkflow(state)}\nUse hypagraph_transition before you start work and after you complete or block work. Work only on the active node. Give concrete evidence references before you claim completion. Ready nodes are [${ready.join(", ")}].${active ? ` The only active node is '${active.id}'.` : " Start one ready node before you change the repository."}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!state || state.definition.policy.mode !== "strict") return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const active = state.definition.nodes.find((node) => state!.runtime.nodes[node.id]?.status === "active");
    if (!active) return { block: true, reason: "Hypagraph strict mode: Start a ready node before you change files." };
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return { block: true, reason: "Hypagraph strict mode: The file operation has no path." };
    const paths = active.scope?.paths ?? [];
    if (paths.length === 0) return { block: true, reason: `Hypagraph strict mode: Active node '${active.id}' has no writable scope.` };
    if (!scopeAllows(ctx.cwd, input.path, paths)) {
      return { block: true, reason: `Hypagraph strict mode: '${input.path}' is outside the scope of node '${active.id}' [${paths.join(", ")}].` };
    }
  });

  pi.registerTool({
    name: "hypagraph_define",
    label: "Define Hypagraph",
    description: "Define and validate a directed coding workflow. Hypagraph rejects a cycle unless it is an exact bounded loop.",
    promptSnippet: "Define a validated directed workflow before multi-step coding work",
    promptGuidelines: ["Use hypagraph_define for multi-step coding work that needs explicit dependencies and completion evidence."],
    parameters: definitionSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = createWorkflow(normalizeDefinition(params), new Date().toISOString(), randomUUID());
      if (!result.ok) return throwDiagnostics(result.diagnostics);
      state = result.state;
      updateUi(state, ctx);
      return textResult(`${renderWorkflow(state)}\n\nHypagraph accepted the definition.`, state);
    },
  });

  pi.registerTool({
    name: "hypagraph_read",
    label: "Read Hypagraph",
    description: "Read the workflow, active node, ready nodes, and node states.",
    promptSnippet: "Read the current Hypagraph state and ready nodes",
    parameters: Type.Object({ view: Type.Optional(StringEnum(["summary", "full"] as const)) }),
    async execute(_toolCallId, params) {
      if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
      const text = params.view === "full" ? renderWorkflow(state) : JSON.stringify(workflowSummary(state), null, 2);
      return textResult(text, state);
    },
  });

  pi.registerTool({
    name: "hypagraph_transition",
    label: "Transition Hypagraph Node",
    description: "Start, complete, block, or unblock one node. Hypagraph enforces dependencies, one active node, and evidence rules.",
    promptSnippet: "Move a Hypagraph node through its state machine",
    promptGuidelines: ["Call hypagraph_transition with action=start before you work on a node. Call it with action=complete and concrete evidence after the work."],
    parameters: Type.Object({
      nodeId: Type.String(),
      action: StringEnum(["start", "complete", "block", "unblock"] as const),
      evidence: Type.Optional(Type.Array(evidenceSchema)),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
      const result = reduceHypagraph(state, {
        type: "transition",
        nodeId: params.nodeId,
        action: params.action,
        ...(params.evidence === undefined ? {} : { evidence: params.evidence }),
        ...(params.reason === undefined ? {} : { reason: params.reason }),
        at: new Date().toISOString(),
      });
      if (!result.ok) return throwDiagnostics(result.diagnostics);
      state = result.state;
      updateUi(state, ctx);
      return textResult(renderWorkflow(state), state);
    },
  });

  pi.registerTool({
    name: "hypagraph_revise",
    label: "Revise Hypagraph",
    description: "Replace the graph definition. Preserve completed work that did not change. Mark changed nodes and their dependents as stale.",
    promptSnippet: "Revise a Hypagraph and invalidate downstream work",
    parameters: definitionSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
      const result = reduceHypagraph(state, {
        type: "revise",
        definition: normalizeDefinition(params),
        at: new Date().toISOString(),
      });
      if (!result.ok) return throwDiagnostics(result.diagnostics);
      state = result.state;
      updateUi(state, ctx);
      return textResult(`${renderWorkflow(state)}\n\nHypagraph accepted the revision.`, state);
    },
  });

  pi.registerCommand("hypagraph", {
    description: "Show the active Hypagraph status",
    handler: async (_args, ctx) => {
      if (!state) {
        ctx.ui.notify("There is no active Hypagraph.", "info");
        return;
      }
      ctx.ui.notify(renderWorkflow(state), "info");
    },
  });
}
