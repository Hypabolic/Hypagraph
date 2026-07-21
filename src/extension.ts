import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { WorkGraphDefinition, WorkGraphState } from "./domain/model.js";
import { createWorkflow, reduceWorkGraph } from "./domain/reducer.js";
import { readyNodeIds } from "./domain/readiness.js";
import { restoreLatestSnapshot } from "./persistence/session-rebuild.js";
import { formatDiagnostics, renderWidget, renderWorkflow, workflowSummary } from "./ui/format.js";

const nodeSchema = Type.Object({
  id: Type.String({ description: "Stable lowercase node id" }),
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
  ref: Type.String({ description: "Concrete tool-call, command, file, approval, or event reference" }),
  kind: Type.Optional(StringEnum(["tool", "command", "file", "approval", "note"] as const)),
  summary: Type.Optional(Type.String()),
});

export type WorkgraphDefineInput = Static<typeof definitionSchema>;

function normalizeDefinition(input: WorkgraphDefineInput): WorkGraphDefinition {
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

const textResult = (text: string, state: WorkGraphState) => ({
  content: [{ type: "text" as const, text }],
  details: { workgraph: state },
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

function updateUi(state: WorkGraphState | undefined, ctx: ExtensionContext): void {
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
  let state: WorkGraphState | undefined;

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
      systemPrompt: `${event.systemPrompt}\n\nHYPAGRAPH CONTROL:\n${renderWorkflow(state)}\nUse workgraph_transition before starting work and after completing or blocking it. Work on only the active node. Do not claim completion without concrete evidence references. Ready nodes are [${ready.join(", ")}].${active ? ` The only active node is '${active.id}'.` : " Start one ready node before mutating the repository."}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!state || state.definition.policy.mode !== "strict") return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const active = state.definition.nodes.find((node) => state!.runtime.nodes[node.id]?.status === "active");
    if (!active) return { block: true, reason: "Hypagraph strict mode: start a ready node before mutating files." };
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return { block: true, reason: "Hypagraph strict mode: file mutation has no inspectable path." };
    const paths = active.scope?.paths ?? [];
    if (paths.length === 0) return { block: true, reason: `Hypagraph strict mode: active node '${active.id}' declares no writable scope.` };
    if (!scopeAllows(ctx.cwd, input.path, paths)) {
      return { block: true, reason: `Hypagraph strict mode: '${input.path}' is outside node '${active.id}' scope [${paths.join(", ")}].` };
    }
  });

  pi.registerTool({
    name: "workgraph_define",
    label: "Define Hypagraph",
    description: "Define and validate a directed coding workflow. Cycles are rejected unless they exactly match a bounded loop declaration.",
    promptSnippet: "Define a validated directed workflow before multi-step coding work",
    promptGuidelines: ["Use workgraph_define for multi-step coding work that benefits from explicit dependencies and completion evidence."],
    parameters: definitionSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = createWorkflow(normalizeDefinition(params), new Date().toISOString(), randomUUID());
      if (!result.ok) return throwDiagnostics(result.diagnostics);
      state = result.state;
      updateUi(state, ctx);
      return textResult(`${renderWorkflow(state)}\n\nDefinition accepted.`, state);
    },
  });

  pi.registerTool({
    name: "workgraph_read",
    label: "Read Hypagraph",
    description: "Read the canonical workflow, active node, ready frontier, and statuses.",
    promptSnippet: "Read current Hypagraph state and ready nodes",
    parameters: Type.Object({ view: Type.Optional(StringEnum(["summary", "full"] as const)) }),
    async execute(_toolCallId, params) {
      if (!state) throw new Error("No active Hypagraph. Call workgraph_define first.");
      const text = params.view === "full" ? renderWorkflow(state) : JSON.stringify(workflowSummary(state), null, 2);
      return textResult(text, state);
    },
  });

  pi.registerTool({
    name: "workgraph_transition",
    label: "Transition Hypagraph Node",
    description: "Start, complete, block, or unblock one node. Dependency, single-active-node, and evidence rules are enforced.",
    promptSnippet: "Transition a Hypagraph node through an enforced state machine",
    promptGuidelines: ["Call workgraph_transition(action=start) before working on a node and workgraph_transition(action=complete) with concrete evidence afterward."],
    parameters: Type.Object({
      nodeId: Type.String(),
      action: StringEnum(["start", "complete", "block", "unblock"] as const),
      evidence: Type.Optional(Type.Array(evidenceSchema)),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state) throw new Error("No active Hypagraph. Call workgraph_define first.");
      const result = reduceWorkGraph(state, {
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
    name: "workgraph_revise",
    label: "Revise Hypagraph",
    description: "Replace the graph definition while preserving unchanged completed work and invalidating changed nodes plus downstream dependents.",
    promptSnippet: "Revise a Hypagraph with downstream invalidation",
    parameters: definitionSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state) throw new Error("No active Hypagraph. Call workgraph_define first.");
      const result = reduceWorkGraph(state, {
        type: "revise",
        definition: normalizeDefinition(params),
        at: new Date().toISOString(),
      });
      if (!result.ok) return throwDiagnostics(result.diagnostics);
      state = result.state;
      updateUi(state, ctx);
      return textResult(`${renderWorkflow(state)}\n\nRevision accepted.`, state);
    },
  });

  pi.registerCommand("hypagraph", {
    description: "Show the active Hypagraph status",
    handler: async (_args, ctx) => {
      if (!state) {
        ctx.ui.notify("No active Hypagraph.", "info");
        return;
      }
      ctx.ui.notify(renderWorkflow(state), "info");
    },
  });

  pi.registerCommand("workgraph", {
    description: "Compatibility alias for /hypagraph",
    handler: async (_args, ctx) => {
      if (!state) {
        ctx.ui.notify("No active Hypagraph.", "info");
        return;
      }
      ctx.ui.notify(renderWorkflow(state), "info");
    },
  });
}
