/**
 * Pure draft model for Hypagraph authoring.
 *
 * A draft is mutable construction state. It is not live runtime state.
 * Host code owns disk I/O and timestamps. This module stays pure.
 */

import type { FactContract } from "./facts.js";
import type {
  CheckDefinition,
  Diagnostic,
  HypagraphDefinition,
  LoopDefinition,
  LoopEvaluationDefinition,
  LoopFailurePolicy,
  LoopProgressDefinition,
  LoopSuccessPredicate,
  NodeDefinition,
  NodeKind,
  WorkflowEvaluationDefinition,
  WorkflowPolicy,
} from "./model.js";
import { buildOutgoing, isCyclicComponent, stronglyConnectedComponents } from "./scc.js";

export const HYPAGRAPH_DRAFT_SCHEMA_VERSION = 1 as const;

export type DraftStatus = "open" | "validated" | "committed" | "discarded";

export interface DraftCreationRequest {
  operationId: string;
  sessionGeneration: number;
  branchGeneration: number;
}

export interface DraftConstructionNote {
  code: string;
  message: string;
}

/**
 * One draft node under construction.
 * Requires edges live on the node. The loop tool owns cycle-closing requires.
 */
export interface DraftNodeRecord {
  id: string;
  title: string;
  description?: string;
  kind?: NodeKind;
  requires: string[];
  acceptance: string[];
  produces?: FactContract[];
  check?: CheckDefinition;
  scope?: { paths: string[] };
}

/**
 * One draft loop under construction.
 * feedbackEdges are not author-supplied. Projection always emits
 * [{ from: evaluateAfter, to: entry }] when the loop is present.
 */
export interface DraftLoopRecord {
  id: string;
  entry: string;
  evaluateAfter: string;
  successWhen: LoopSuccessPredicate;
  maxIterations: number;
  nodes?: string[];
  progress?: LoopProgressDefinition;
  patience?: number;
  evaluation?: LoopEvaluationDefinition;
  failurePolicy?: LoopFailurePolicy;
}

export interface HypagraphDraftRecord {
  schemaVersion: typeof HYPAGRAPH_DRAFT_SCHEMA_VERSION;
  draftId: string;
  createdAt: string;
  updatedAt: string;
  objective: string;
  status: DraftStatus;
  creationRequest?: DraftCreationRequest;
  title?: string;
  goal: string;
  nodes: DraftNodeRecord[];
  /** Dependency edges: to.requires includes from. Kept in sync with node.requires. */
  edges: Array<{ from: string; to: string }>;
  loops: DraftLoopRecord[];
  policy?: WorkflowPolicy;
  evaluation?: WorkflowEvaluationDefinition;
  constructionNotes?: DraftConstructionNote[];
}

export type DraftMutationResult =
  | {
    ok: true;
    draft: HypagraphDraftRecord;
    notes: DraftConstructionNote[];
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

export type DraftProjectionResult =
  | {
    ok: true;
    definition: HypagraphDefinition;
  }
  | {
    ok: false;
    diagnostics: Diagnostic[];
  };

export interface DraftSummary {
  draftId: string;
  status: DraftStatus;
  objective: string;
  title?: string;
  goal: string;
  nodeCount: number;
  edgeCount: number;
  loopCount: number;
  nodeIds: string[];
  loopIds: string[];
}

const cloneNode = (node: DraftNodeRecord): DraftNodeRecord => structuredClone(node);
const cloneLoop = (loop: DraftLoopRecord): DraftLoopRecord => structuredClone(loop);

/** Rebuild edges from node.requires. */
export function rebuildDraftEdges(nodes: readonly DraftNodeRecord[]): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  for (const node of nodes) {
    for (const required of node.requires) {
      edges.push({ from: required, to: node.id });
    }
  }
  return edges;
}

export function createEmptyDraft(input: {
  draftId: string;
  objective: string;
  createdAt: string;
  creationRequest?: DraftCreationRequest;
  title?: string;
  goal?: string;
}): HypagraphDraftRecord {
  const objective = input.objective.trim();
  return {
    schemaVersion: HYPAGRAPH_DRAFT_SCHEMA_VERSION,
    draftId: input.draftId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    objective,
    status: "open",
    ...(input.creationRequest === undefined ? {} : { creationRequest: structuredClone(input.creationRequest) }),
    ...(input.title === undefined ? {} : { title: input.title.trim() }),
    goal: (input.goal ?? objective).trim(),
    nodes: [],
    edges: [],
    loops: [],
    policy: { mode: "guided", requireEvidence: false },
    constructionNotes: [],
  };
}

export function summarizeDraft(draft: HypagraphDraftRecord): DraftSummary {
  return {
    draftId: draft.draftId,
    status: draft.status,
    objective: draft.objective,
    ...(draft.title === undefined ? {} : { title: draft.title }),
    goal: draft.goal,
    nodeCount: draft.nodes.length,
    edgeCount: draft.edges.length,
    loopCount: draft.loops.length,
    nodeIds: draft.nodes.map((node) => node.id),
    loopIds: draft.loops.map((loop) => loop.id),
  };
}

/**
 * Project a draft to a candidate HypagraphDefinition.
 * Loop feedback edges are always owned by this projection.
 */
export function projectDraftDefinition(draft: HypagraphDraftRecord): DraftProjectionResult {
  const diagnostics: Diagnostic[] = [];
  if (draft.nodes.length === 0) {
    return {
      ok: false,
      diagnostics: [{
        code: "draft_empty",
        message: "The draft has no nodes.",
        suggestion: "Add at least one task or check before validate or commit.",
      }],
    };
  }

  const nodes: NodeDefinition[] = draft.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    ...(node.description === undefined ? {} : { description: node.description }),
    ...(node.kind === undefined ? {} : { kind: node.kind }),
    requires: [...node.requires],
    acceptance: [...node.acceptance],
    ...(node.produces === undefined ? {} : { produces: structuredClone(node.produces) }),
    ...(node.check === undefined ? {} : { check: structuredClone(node.check) }),
    ...(node.scope === undefined ? {} : { scope: structuredClone(node.scope) }),
  }));

  const loops: LoopDefinition[] = [];
  for (const loop of draft.loops) {
    const projected = projectDraftLoop(nodes, loop);
    if (!projected.ok) {
      diagnostics.push(...projected.diagnostics);
      continue;
    }
    loops.push(projected.loop);
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const title = (draft.title ?? draft.goal).trim() || draft.objective.trim() || "Hypagraph draft";
  const definition: HypagraphDefinition = {
    title,
    goal: draft.goal.trim() || draft.objective.trim(),
    nodes,
    loops,
    ...(draft.evaluation === undefined ? {} : { evaluation: structuredClone(draft.evaluation) }),
    policy: draft.policy ?? { mode: "guided", requireEvidence: false },
  };
  return { ok: true, definition };
}

function projectDraftLoop(
  nodes: readonly NodeDefinition[],
  loop: DraftLoopRecord,
): { ok: true; loop: LoopDefinition } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (!nodeIds.has(loop.entry)) {
    diagnostics.push({
      code: "unknown_node",
      message: `Loop entry '${loop.entry}' is not in the draft.`,
      location: `loops.${loop.id}.entry`,
      suggestion: `Add node '${loop.entry}' before you declare the loop.`,
    });
  }
  if (!nodeIds.has(loop.evaluateAfter)) {
    diagnostics.push({
      code: "unknown_node",
      message: `Loop evaluateAfter '${loop.evaluateAfter}' is not in the draft.`,
      location: `loops.${loop.id}.evaluateAfter`,
      suggestion: `Add node '${loop.evaluateAfter}' before you declare the loop.`,
    });
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  // Feedback edge is always evaluateAfter -> entry as a real requires dependency.
  const withFeedback = nodes.map((node) => {
    if (node.id !== loop.entry) return { ...node, requires: [...node.requires] };
    const requires = node.requires.includes(loop.evaluateAfter)
      ? [...node.requires]
      : [...node.requires, loop.evaluateAfter];
    return { ...node, requires };
  });

  const derivedNodes = deriveLoopNodes(withFeedback, loop);
  if (!derivedNodes.ok) return derivedNodes;

  return {
    ok: true,
    loop: {
      id: loop.id,
      nodes: derivedNodes.nodes,
      entry: loop.entry,
      evaluateAfter: loop.evaluateAfter,
      feedbackEdges: [{ from: loop.evaluateAfter, to: loop.entry }],
      successWhen: structuredClone(loop.successWhen),
      maxIterations: loop.maxIterations,
      ...(loop.progress === undefined ? {} : { progress: structuredClone(loop.progress) }),
      ...(loop.patience === undefined ? {} : { patience: loop.patience }),
      ...(loop.evaluation === undefined ? {} : { evaluation: structuredClone(loop.evaluation) }),
      ...(loop.failurePolicy === undefined ? {} : { failurePolicy: loop.failurePolicy }),
    },
  };
}

/**
 * Derive loop.nodes as the cyclic SCC that contains the feedback edge.
 * When the author supplies nodes, validate they match that component.
 */
export function deriveLoopNodes(
  nodes: readonly NodeDefinition[],
  loop: Pick<DraftLoopRecord, "entry" | "evaluateAfter" | "nodes" | "id">,
): { ok: true; nodes: string[] } | { ok: false; diagnostics: Diagnostic[] } {
  const working = nodes.map((node) => {
    if (node.id !== loop.entry) return { id: node.id, requires: [...node.requires] };
    const requires = node.requires.includes(loop.evaluateAfter)
      ? [...node.requires]
      : [...node.requires, loop.evaluateAfter];
    return { id: node.id, requires };
  });

  const outgoing = buildOutgoing(working);
  const scc = stronglyConnectedComponents(
    working.map((node) => node.id),
    outgoing,
  );
  const componentIndex = scc.componentByNode.get(loop.entry);
  if (componentIndex === undefined) {
    return {
      ok: false,
      diagnostics: [{
        code: "missing_path_for_loop",
        message: `Loop '${loop.id}' cannot form a cycle that contains entry '${loop.entry}'.`,
        location: `loops.${loop.id}`,
        suggestion: "Ensure a forward path from entry to evaluateAfter exists, then let the loop tool add the feedback requires edge.",
      }],
    };
  }
  const component = scc.components[componentIndex] ?? [];
  if (!component.includes(loop.evaluateAfter) || !isCyclicComponent(component, outgoing)) {
    return {
      ok: false,
      diagnostics: [{
        code: "missing_path_for_loop",
        message: `Loop '${loop.id}' needs a path from '${loop.entry}' to '${loop.evaluateAfter}' and a cycle-closing feedback dependency.`,
        location: `loops.${loop.id}`,
        suggestion: `Add requires so work runs entry -> ... -> evaluateAfter, then call the loop tool so entry.requires includes '${loop.evaluateAfter}'.`,
      }],
    };
  }

  const derived = [...component].sort();
  if (loop.nodes !== undefined && loop.nodes.length > 0) {
    const supplied = [...new Set(loop.nodes)].sort();
    if (supplied.length !== derived.length || supplied.some((id, index) => id !== derived[index])) {
      return {
        ok: false,
        diagnostics: [{
          code: "loop_scc_mismatch",
          message: `The nodes in loop '${loop.id}' must be the same as one cyclic component.`,
          location: `loops.${loop.id}.nodes`,
          suggestion: `Use nodes [${derived.join(", ")}] or omit nodes and let the loop tool derive the SCC.`,
        }],
      };
    }
  }

  return { ok: true, nodes: derived };
}

/** Mark draft open again after a mutation. Host updates timestamps. */
export function withDraftUpdated(
  draft: HypagraphDraftRecord,
  updatedAt: string,
  patch: Partial<Pick<HypagraphDraftRecord, "title" | "goal" | "nodes" | "loops" | "policy" | "evaluation" | "status" | "constructionNotes">>,
): HypagraphDraftRecord {
  const nodes = patch.nodes ?? draft.nodes.map(cloneNode);
  return {
    ...draft,
    ...patch,
    nodes,
    edges: rebuildDraftEdges(nodes),
    loops: (patch.loops ?? draft.loops).map(cloneLoop),
    updatedAt,
    status: patch.status ?? (draft.status === "validated" ? "open" : draft.status),
  };
}

/**
 * Thrown when a draft record has a missing or unsupported schemaVersion.
 * Host adapters map this to project_schema_unsupported.
 */
export class UnsupportedDraftSchemaError extends Error {
  readonly code = "project_schema_unsupported" as const;

  constructor(message: string) {
    super(message);
    this.name = "UnsupportedDraftSchemaError";
  }
}

export function assertDraftSchemaVersion(value: unknown): asserts value is { schemaVersion: number } {
  if (value === null || typeof value !== "object") {
    throw new UnsupportedDraftSchemaError("The draft record must be an object with a schemaVersion field.");
  }
  const record = value as { schemaVersion?: unknown };
  if (typeof record.schemaVersion !== "number") {
    throw new UnsupportedDraftSchemaError(
      "The draft record must include a numeric schemaVersion.",
    );
  }
  if (record.schemaVersion !== HYPAGRAPH_DRAFT_SCHEMA_VERSION) {
    throw new UnsupportedDraftSchemaError(
      `Unsupported draft schema version '${String(record.schemaVersion)}'. Expected ${HYPAGRAPH_DRAFT_SCHEMA_VERSION}.`,
    );
  }
}

export function creationRequestsEqual(
  left: DraftCreationRequest,
  right: DraftCreationRequest,
): boolean {
  return left.operationId === right.operationId
    && left.sessionGeneration === right.sessionGeneration
    && left.branchGeneration === right.branchGeneration;
}

/**
 * Compare a draft binding to one creationRequest identity.
 */
export function draftMatchesCreationRequest(
  draft: HypagraphDraftRecord,
  request: DraftCreationRequest,
): Diagnostic | undefined {
  if (draft.creationRequest === undefined) {
    return {
      code: "draft_stale_creation_request",
      message: `Draft '${draft.draftId}' has no creationRequest binding.`,
      suggestion: "Call hypagraph_draft_begin with the exact creationRequest from the active /hypagoal turn.",
    };
  }
  if (!creationRequestsEqual(draft.creationRequest, request)) {
    return {
      code: "draft_stale_creation_request",
      message: `Draft '${draft.draftId}' creationRequest does not match the supplied creationRequest.`,
      suggestion: "Begin a new draft with the current creationRequest, or use the draft that belongs to this turn.",
    };
  }
  return undefined;
}

/**
 * Validate draft identity for hypagoal_start commit.
 *
 * Rules:
 * 1. If the draft is bound to a creationRequest, the caller must supply the same identity.
 * 2. If an active authoring turn exists, the draft must also match that identity.
 * 3. An unbound draft may commit without a creationRequest when no authoring turn is active.
 */
export function validateDraftCommitIdentity(
  draft: HypagraphDraftRecord,
  options: {
    suppliedCreationRequest?: DraftCreationRequest;
    activeCreationRequest?: DraftCreationRequest;
  },
): Diagnostic | undefined {
  const supplied = options.suppliedCreationRequest;
  const active = options.activeCreationRequest;

  if (draft.creationRequest !== undefined) {
    if (supplied === undefined) {
      return {
        code: "draft_stale_creation_request",
        message: `Draft '${draft.draftId}' is bound to a creationRequest. Supply the matching creationRequest to commit.`,
        suggestion: "Pass the exact creationRequest used when the draft began.",
      };
    }
    const boundMismatch = draftMatchesCreationRequest(draft, supplied);
    if (boundMismatch) return boundMismatch;
  }

  if (active !== undefined) {
    if (supplied === undefined) {
      return {
        code: "hypagoal_creation_request_required",
        message: "The active /hypagoal authoring turn requires its exact creationRequest identity.",
      };
    }
    if (!creationRequestsEqual(active, supplied)) {
      return {
        code: "stale_hypagoal_creation_request",
        message: "The creationRequest does not match the active authoring turn.",
      };
    }
    return draftMatchesCreationRequest(draft, active);
  }

  return undefined;
}

export function parseDraftRecord(value: unknown): HypagraphDraftRecord {
  assertDraftSchemaVersion(value);
  const record = value as HypagraphDraftRecord;
  if (typeof record.draftId !== "string" || record.draftId.length === 0) {
    throw new Error("The draft record must include a non-empty draftId.");
  }
  if (typeof record.objective !== "string") {
    throw new Error("The draft record must include objective.");
  }
  if (!Array.isArray(record.nodes) || !Array.isArray(record.loops)) {
    throw new Error("The draft record must include nodes and loops arrays.");
  }
  return {
    schemaVersion: HYPAGRAPH_DRAFT_SCHEMA_VERSION,
    draftId: record.draftId,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    objective: record.objective,
    status: record.status ?? "open",
    ...(record.creationRequest === undefined ? {} : { creationRequest: structuredClone(record.creationRequest) }),
    ...(record.title === undefined ? {} : { title: record.title }),
    goal: typeof record.goal === "string" ? record.goal : record.objective,
    nodes: structuredClone(record.nodes),
    edges: Array.isArray(record.edges) ? structuredClone(record.edges) : rebuildDraftEdges(record.nodes),
    loops: structuredClone(record.loops),
    ...(record.policy === undefined ? {} : { policy: structuredClone(record.policy) }),
    ...(record.evaluation === undefined ? {} : { evaluation: structuredClone(record.evaluation) }),
    ...(record.constructionNotes === undefined ? {} : { constructionNotes: structuredClone(record.constructionNotes) }),
  };
}
