/**
 * Pure low-level draft constructors.
 *
 * Tools call these functions. Disk I/O stays in the host.
 * The loop constructor owns feedback edges and cycle-closing requires.
 */

import type { FactContract } from "./facts.js";
import type { CheckDefinition, Diagnostic, LoopSuccessPredicate, NodeKind } from "./model.js";
import {
  deriveLoopNodes,
  type DraftConstructionNote,
  type DraftLoopRecord,
  type DraftMutationResult,
  type DraftNodeRecord,
  type HypagraphDraftRecord,
  rebuildDraftEdges,
  withDraftUpdated,
} from "./draft.js";

export type { DraftMutationResult };

const reject = (diagnostics: Diagnostic[]): DraftMutationResult => ({ ok: false, diagnostics });

const note = (code: string, message: string): DraftConstructionNote => ({ code, message });

const findNode = (draft: HypagraphDraftRecord, nodeId: string): DraftNodeRecord | undefined =>
  draft.nodes.find((node) => node.id === nodeId);

const requireOpen = (draft: HypagraphDraftRecord): Diagnostic | undefined => {
  if (draft.status === "discarded") {
    return {
      code: "draft_not_open",
      message: `Draft '${draft.draftId}' is discarded.`,
      suggestion: "Begin a new draft.",
    };
  }
  if (draft.status === "committed") {
    return {
      code: "draft_not_open",
      message: `Draft '${draft.draftId}' is already committed.`,
      suggestion: "Begin a new draft for further authoring.",
    };
  }
  return undefined;
};

export function addTaskToDraft(
  draft: HypagraphDraftRecord,
  input: {
    id: string;
    title: string;
    acceptance?: string[];
    description?: string;
    produces?: FactContract[];
    scopePaths?: string[];
    requires?: string[];
  },
  updatedAt: string,
): DraftMutationResult {
  const openError = requireOpen(draft);
  if (openError) return reject([openError]);
  const id = input.id.trim();
  if (!id) {
    return reject([{ code: "invalid_node_id", message: "Task id must be non-empty.", suggestion: "Use a stable lowercase id such as implement." }]);
  }
  if (findNode(draft, id)) {
    return reject([{
      code: "duplicate_node",
      message: `Node '${id}' already exists in the draft.`,
      location: `nodes.${id}`,
      suggestion: "Choose a different id or remove the existing node first.",
    }]);
  }
  for (const required of input.requires ?? []) {
    if (!findNode(draft, required)) {
      return reject([{
        code: "unknown_node",
        message: `Required node '${required}' is not in the draft.`,
        location: `nodes.${id}.requires`,
        suggestion: `Add '${required}' before you reference it, or omit requires and call hypagraph_require later.`,
      }]);
    }
  }

  const node: DraftNodeRecord = {
    id,
    title: input.title.trim() || id,
    ...(input.description === undefined ? {} : { description: input.description }),
    kind: "task",
    requires: [...(input.requires ?? [])],
    acceptance: [...(input.acceptance ?? [])],
    ...(input.produces === undefined ? {} : { produces: structuredClone(input.produces) }),
    ...(input.scopePaths === undefined ? {} : { scope: { paths: [...input.scopePaths] } }),
  };

  const next = withDraftUpdated(draft, updatedAt, {
    nodes: [...draft.nodes.map((item) => structuredClone(item)), node],
    constructionNotes: [
      ...(draft.constructionNotes ?? []),
      note("task_added", `Added task '${id}'.`),
    ],
  });
  return { ok: true, draft: next, notes: [note("task_added", `Added task '${id}'.`)] };
}

export function addCheckToDraft(
  draft: HypagraphDraftRecord,
  input: {
    id: string;
    title: string;
    check: CheckDefinition;
    acceptance?: string[];
    description?: string;
    produces?: FactContract[];
    requires?: string[];
  },
  updatedAt: string,
): DraftMutationResult {
  const openError = requireOpen(draft);
  if (openError) return reject([openError]);
  const id = input.id.trim();
  if (!id) {
    return reject([{ code: "invalid_node_id", message: "Check id must be non-empty." }]);
  }
  if (findNode(draft, id)) {
    return reject([{
      code: "duplicate_node",
      message: `Node '${id}' already exists in the draft.`,
      location: `nodes.${id}`,
      suggestion: "Choose a different id.",
    }]);
  }
  for (const required of input.requires ?? []) {
    if (!findNode(draft, required)) {
      return reject([{
        code: "unknown_node",
        message: `Required node '${required}' is not in the draft.`,
        location: `nodes.${id}.requires`,
      }]);
    }
  }

  const node: DraftNodeRecord = {
    id,
    title: input.title.trim() || id,
    ...(input.description === undefined ? {} : { description: input.description }),
    kind: "check" as NodeKind,
    requires: [...(input.requires ?? [])],
    acceptance: [...(input.acceptance ?? [])],
    ...(input.produces === undefined ? {} : { produces: structuredClone(input.produces) }),
    check: structuredClone(input.check),
  };

  const next = withDraftUpdated(draft, updatedAt, {
    nodes: [...draft.nodes.map((item) => structuredClone(item)), node],
    constructionNotes: [
      ...(draft.constructionNotes ?? []),
      note("check_added", `Added check '${id}'.`),
    ],
  });
  return { ok: true, draft: next, notes: [note("check_added", `Added check '${id}'.`)] };
}

/**
 * Add dependency: to.requires includes from.
 */
export function requireOnDraft(
  draft: HypagraphDraftRecord,
  input: { from: string; to: string },
  updatedAt: string,
): DraftMutationResult {
  const openError = requireOpen(draft);
  if (openError) return reject([openError]);
  const from = input.from.trim();
  const to = input.to.trim();
  if (!findNode(draft, from)) {
    return reject([{
      code: "unknown_node",
      message: `Dependency source '${from}' is not in the draft.`,
      suggestion: `Add node '${from}' first.`,
    }]);
  }
  if (!findNode(draft, to)) {
    return reject([{
      code: "unknown_node",
      message: `Dependency target '${to}' is not in the draft.`,
      suggestion: `Add node '${to}' first.`,
    }]);
  }
  if (from === to) {
    return reject([{
      code: "self_dependency",
      message: `Node '${to}' cannot require itself through hypagraph_require.`,
      suggestion: "Use hypagraph_loop to close a feedback cycle.",
    }]);
  }

  const nodes = draft.nodes.map((node) => {
    if (node.id !== to) return structuredClone(node);
    if (node.requires.includes(from)) return structuredClone(node);
    return { ...structuredClone(node), requires: [...node.requires, from] };
  });

  const next = withDraftUpdated(draft, updatedAt, {
    nodes,
    constructionNotes: [
      ...(draft.constructionNotes ?? []),
      note("require_added", `Node '${to}' requires '${from}'.`),
    ],
  });
  return { ok: true, draft: next, notes: [note("require_added", `Node '${to}' requires '${from}'.`)] };
}

export interface LoopConstructorInput {
  loopId: string;
  entry: string;
  evaluateAfter: string;
  successWhen: LoopSuccessPredicate;
  maxIterations: number;
  nodes?: string[];
  progress?: DraftLoopRecord["progress"];
  patience?: number;
  evaluation?: DraftLoopRecord["evaluation"];
  failurePolicy?: DraftLoopRecord["failurePolicy"];
}

/**
 * Declare a bounded loop. Owns feedback structure:
 * - entry.requires includes evaluateAfter
 * - projected feedbackEdges is [{ from: evaluateAfter, to: entry }]
 * - nodes equal the cyclic SCC when derivation succeeds
 */
export function declareLoopOnDraft(
  draft: HypagraphDraftRecord,
  input: LoopConstructorInput,
  updatedAt: string,
): DraftMutationResult {
  const openError = requireOpen(draft);
  if (openError) return reject([openError]);

  const loopId = input.loopId.trim();
  const entry = input.entry.trim();
  const evaluateAfter = input.evaluateAfter.trim();
  if (!loopId) {
    return reject([{ code: "invalid_loop_id", message: "loopId must be non-empty." }]);
  }
  if (draft.loops.some((loop) => loop.id === loopId)) {
    return reject([{
      code: "duplicate_loop",
      message: `Loop '${loopId}' already exists in the draft.`,
      suggestion: "Use a different loopId or discard and rebuild the draft.",
    }]);
  }
  if (!findNode(draft, entry)) {
    return reject([{
      code: "unknown_node",
      message: `Loop entry '${entry}' is not in the draft.`,
      location: `loops.${loopId}.entry`,
      suggestion: `Add node '${entry}' before hypagraph_loop.`,
    }]);
  }
  if (!findNode(draft, evaluateAfter)) {
    return reject([{
      code: "unknown_node",
      message: `Loop evaluateAfter '${evaluateAfter}' is not in the draft.`,
      location: `loops.${loopId}.evaluateAfter`,
      suggestion: `Add node '${evaluateAfter}' before hypagraph_loop.`,
    }]);
  }
  if (!Number.isInteger(input.maxIterations) || input.maxIterations < 1) {
    return reject([{
      code: "invalid_max_iterations",
      message: "maxIterations must be a positive integer.",
      location: `loops.${loopId}.maxIterations`,
    }]);
  }

  // Ensure a forward path exists from entry to evaluateAfter when they differ.
  // For the common two-node case, add evaluateAfter.requires includes entry when missing.
  let nodes = draft.nodes.map((node) => structuredClone(node));
  if (entry !== evaluateAfter) {
    const canReach = hasPath(nodes, entry, evaluateAfter);
    if (!canReach) {
      // Minimal repair: if evaluateAfter has no path from entry, add the direct forward edge.
      nodes = nodes.map((node) => {
        if (node.id !== evaluateAfter) return node;
        if (node.requires.includes(entry)) return node;
        return { ...node, requires: [...node.requires, entry] };
      });
    }
  }

  // Own the cycle-closing feedback dependency.
  nodes = nodes.map((node) => {
    if (node.id !== entry) return node;
    if (node.requires.includes(evaluateAfter)) return node;
    return { ...node, requires: [...node.requires, evaluateAfter] };
  });

  const derived = deriveLoopNodes(
    nodes.map((node) => ({
      id: node.id,
      title: node.title,
      requires: node.requires,
      acceptance: node.acceptance,
    })),
    {
      id: loopId,
      entry,
      evaluateAfter,
      ...(input.nodes === undefined ? {} : { nodes: input.nodes }),
    },
  );
  if (!derived.ok) return reject(derived.diagnostics);

  const loop: DraftLoopRecord = {
    id: loopId,
    entry,
    evaluateAfter,
    successWhen: structuredClone(input.successWhen),
    maxIterations: input.maxIterations,
    nodes: derived.nodes,
    ...(input.progress === undefined ? {} : { progress: structuredClone(input.progress) }),
    ...(input.patience === undefined ? {} : { patience: input.patience }),
    ...(input.evaluation === undefined ? {} : { evaluation: structuredClone(input.evaluation) }),
    ...(input.failurePolicy === undefined ? {} : { failurePolicy: input.failurePolicy }),
  };

  const next: HypagraphDraftRecord = {
    ...draft,
    nodes,
    edges: rebuildDraftEdges(nodes),
    loops: [...draft.loops.map((item) => structuredClone(item)), loop],
    updatedAt,
    status: draft.status === "validated" ? "open" : draft.status,
    constructionNotes: [
      ...(draft.constructionNotes ?? []),
      note(
        "loop_declared",
        `Declared loop '${loopId}' with feedback '${evaluateAfter}' -> '${entry}'. nodes=[${derived.nodes.join(", ")}].`,
      ),
    ],
  };

  return {
    ok: true,
    draft: next,
    notes: [note("loop_declared", `Declared loop '${loopId}'. Feedback edge is owned by the tool.`)],
  };
}

function hasPath(
  nodes: readonly DraftNodeRecord[],
  from: string,
  to: string,
): boolean {
  if (from === to) return true;
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const node of nodes) {
    for (const required of node.requires) {
      // required -> node is a forward edge for readiness (node waits on required)
      outgoing.get(required)?.push(node.id);
    }
  }
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of outgoing.get(current) ?? []) queue.push(next);
  }
  return false;
}
