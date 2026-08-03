/**
 * Pure Mermaid flowchart projection from a GraphViewModel.
 *
 * This module builds Mermaid source only. It must not import grok-mermaid,
 * ANSI helpers, the filesystem, the network, or the clock.
 */

import type { GraphViewEdge, GraphViewModel, GraphViewNode } from "./projection.js";

/** Flowchart direction for Mermaid graph / flowchart headers. */
export type MermaidDirection = "TD" | "LR";

export interface MermaidProjectionOptions {
  /**
   * Flowchart direction.
   *
   * When omitted, the projector defaults to LR (horizontal left-to-right).
   * Pass TD only when a vertical layout is required.
   */
  direction?: MermaidDirection;
  /** Maximum nodes to emit. Extra nodes produce a diagnostic. Default: 48. */
  maxNodes?: number;
  /** Maximum characters in a node label. Default: 28. */
  maxLabelLength?: number;
  /**
   * When true, omit skipped route edges.
   *
   * When false (default), emit skipped routes as dotted edges with a label.
   */
  compact?: boolean;
  /**
   * When true, prefix node labels with live status glyphs and mark running loops.
   * Used by the live bottom graph dock for colour highlighting.
   */
  statusMarkers?: boolean;
}

export interface MermaidProjectionDiagnostic {
  code: string;
  message: string;
}

export interface MermaidProjectionResult {
  /** Mermaid flowchart source. */
  source: string;
  /** Non-fatal projection notes (truncation, empty graph, omitted edges). */
  diagnostics: MermaidProjectionDiagnostic[];
  /** Direction that was written into the source header. */
  direction: MermaidDirection;
  /** Number of nodes written into the source. */
  nodeCount: number;
  /** Number of edges written into the source. */
  edgeCount: number;
  /**
   * Map from Hypagraph node id to the unique Mermaid identifier used in source.
   *
   * Exposed for tests and hosts that need stable id resolution.
   */
  mermaidNodeIds: ReadonlyMap<string, string>;
  /**
   * Map from Hypagraph loop id to the unique Mermaid subgraph identifier.
   */
  mermaidSubgraphIds: ReadonlyMap<string, string>;
}

const DEFAULT_MAX_NODES = 48;
const DEFAULT_MAX_LABEL_LENGTH = 28;
/** Default flowchart direction: horizontal left-to-right. */
const DEFAULT_MERMAID_DIRECTION: MermaidDirection = "LR";
/** Structural prefix so subgraph ids cannot equal any node mermaidSafeId output. */
const SUBGRAPH_PREFIX = "sg_";

/**
 * Encode one Hypagraph identifier into a Mermaid-safe identifier injectively.
 *
 * Letters and digits stay as-is. Every other code point becomes `_` + hex + `_`.
 * That form cannot collide with pure alphanumeric text, and distinct special
 * characters (for example `-` vs `_`) produce distinct encodings.
 *
 * The result always starts with a letter so Mermaid accepts it as an id.
 */
export function mermaidSafeId(raw: string): string {
  if (raw.length === 0) return "n_empty";
  let body = "";
  for (const ch of raw) {
    if (/[A-Za-z0-9]/.test(ch)) {
      body += ch;
    } else {
      body += `_${ch.codePointAt(0)!.toString(16)}_`;
    }
  }
  if (body.length === 0) return "n_empty";
  if (/^[A-Za-z]/.test(body)) return body;
  return `n_${body}`;
}

/**
 * Allocate unique Mermaid identifiers for a set of preferred base names.
 *
 * When two preferred bases collide after encoding, the second and later entries
 * receive a numeric suffix (`base_2`, `base_3`, …).
 */
export function allocateUniqueMermaidIds(
  entries: ReadonlyArray<{ key: string; preferred: string }>,
): Map<string, string> {
  const used = new Set<string>();
  const assigned = new Map<string, string>();
  for (const entry of entries) {
    let candidate = entry.preferred;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${entry.preferred}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    assigned.set(entry.key, candidate);
  }
  return assigned;
}

/**
 * Escape a label for use inside a double-quoted Mermaid node label.
 *
 * Replaces characters that break quoted labels and truncates long text.
 */
export function escapeMermaidLabel(raw: string, maxLength: number): string {
  const singleLine = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/"/g, "'")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/#/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (singleLine.length === 0) return "(untitled)";
  if (singleLine.length <= maxLength) return singleLine;
  if (maxLength <= 1) return "…";
  return `${singleLine.slice(0, Math.max(1, maxLength - 1))}…`;
}

const nodeShapeOpen = (kind: GraphViewNode["kind"]): string => {
  switch (kind) {
    case "gate":
      return "{";
    case "check":
      return "([";
    case "interaction":
      return "([";
    case "code":
      return "[/";
    case "effect":
      return "[/";
    case "task":
    default:
      return "[";
  }
};

const nodeShapeClose = (kind: GraphViewNode["kind"]): string => {
  switch (kind) {
    case "gate":
      return "}";
    case "check":
      return "])";
    case "interaction":
      return "])";
    case "code":
      return "/]";
    case "effect":
      return "/]";
    case "task":
    default:
      return "]";
  }
};

/** Status glyph for live Mermaid labels (keep in sync with live-graph-color). */
const STATUS_GLYPH: Record<GraphViewNode["status"], string> = {
  pending: "○",
  ready: "◇",
  starting: "▶",
  running: "▶",
  awaiting_evidence: "?",
  awaiting_response: "…",
  waiting_for_child: "↓",
  verifying: "V",
  succeeded: "✓",
  failed: "✗",
  blocked: "■",
  cancelled: "×",
  skipped: "–",
  stale: "!",
};

const nodeDeclaration = (
  node: GraphViewNode,
  mermaidId: string,
  maxLabelLength: number,
  statusMarkers: boolean,
): string => {
  const base = node.title || node.id;
  const text = statusMarkers
    ? `${STATUS_GLYPH[node.status] ?? "·"} ${base}`
    : base;
  const label = escapeMermaidLabel(text, maxLabelLength);
  return `${mermaidId}${nodeShapeOpen(node.kind)}"${label}"${nodeShapeClose(node.kind)}`;
};

const edgeLine = (
  edge: GraphViewEdge,
  nodeIds: ReadonlyMap<string, string>,
  compact: boolean,
): string | undefined => {
  const source = nodeIds.get(edge.source);
  const target = nodeIds.get(edge.target);
  if (source === undefined || target === undefined) return undefined;
  if (edge.kind === "dependency") {
    return `${source} --> ${target}`;
  }
  if (edge.kind === "feedback") {
    return `${source} -->|feedback| ${target}`;
  }
  // route
  if (edge.skipped) {
    if (compact) return undefined;
    const label = edge.outcome === undefined ? "skipped" : `${edge.outcome}`;
    return `${source} -.->|${label}| ${target}`;
  }
  if (edge.outcome !== undefined) {
    return `${source} -->|${edge.outcome}| ${target}`;
  }
  return `${source} --> ${target}`;
};

const chooseDirection = (
  _view: GraphViewModel,
  options: MermaidProjectionOptions | undefined,
): MermaidDirection => {
  if (options?.direction !== undefined) return options.direction;
  return DEFAULT_MERMAID_DIRECTION;
};

/**
 * Build unique Mermaid ids for nodes and multi-node loop subgraphs in one space.
 *
 * Nodes use injective `mermaidSafeId`. Subgraphs use a structural `sg_` prefix
 * plus the encoded loop id. A final allocator adds numeric suffixes if any
 * preferred bases still collide.
 */
export function buildMermaidIdTables(
  nodeIds: readonly string[],
  loopIds: readonly string[],
): {
  mermaidNodeIds: Map<string, string>;
  mermaidSubgraphIds: Map<string, string>;
} {
  const sortedNodes = [...nodeIds].sort((left, right) => left.localeCompare(right));
  const sortedLoops = [...loopIds].sort((left, right) => left.localeCompare(right));
  const entries: Array<{ key: string; preferred: string }> = [
    ...sortedNodes.map((id) => ({ key: `node:${id}`, preferred: mermaidSafeId(id) })),
    ...sortedLoops.map((id) => ({
      key: `loop:${id}`,
      preferred: `${SUBGRAPH_PREFIX}${mermaidSafeId(id)}`,
    })),
  ];
  const assigned = allocateUniqueMermaidIds(entries);
  const mermaidNodeIds = new Map<string, string>();
  const mermaidSubgraphIds = new Map<string, string>();
  for (const id of sortedNodes) {
    mermaidNodeIds.set(id, assigned.get(`node:${id}`)!);
  }
  for (const id of sortedLoops) {
    mermaidSubgraphIds.set(id, assigned.get(`loop:${id}`)!);
  }
  return { mermaidNodeIds, mermaidSubgraphIds };
}

/**
 * Project a GraphViewModel to Mermaid flowchart source.
 *
 * The result is a view string. It is not canonical state.
 */
export function projectMermaidFlowchart(
  view: GraphViewModel,
  options: MermaidProjectionOptions = {},
): MermaidProjectionResult {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxLabelLength = options.maxLabelLength ?? DEFAULT_MAX_LABEL_LENGTH;
  const compact = options.compact === true;
  const statusMarkers = options.statusMarkers === true;
  const direction = chooseDirection(view, options);
  const diagnostics: MermaidProjectionDiagnostic[] = [];
  const emptyMaps = {
    mermaidNodeIds: new Map<string, string>(),
    mermaidSubgraphIds: new Map<string, string>(),
  };

  if (view.nodes.length === 0) {
    return {
      source: `flowchart ${direction}\n  empty["(empty graph)"]`,
      diagnostics: [{
        code: "mermaid.empty-graph",
        message: "The graph has no nodes. The projection emits a placeholder node.",
      }],
      direction,
      nodeCount: 0,
      edgeCount: 0,
      ...emptyMaps,
    };
  }

  const sortedNodes = [...view.nodes].sort((left, right) => left.id.localeCompare(right.id));
  let nodes = sortedNodes;
  if (nodes.length > maxNodes) {
    nodes = nodes.slice(0, maxNodes);
    diagnostics.push({
      code: "mermaid.node-limit",
      message: `The projection keeps the first ${maxNodes} nodes of ${sortedNodes.length} by id order.`,
    });
  }
  const includedIds = new Set(nodes.map((node) => node.id));

  const multiNodeLoops = view.loops
    .filter((loop) => loop.nodeIds.filter((id) => includedIds.has(id)).length > 1)
    .sort((left, right) => left.id.localeCompare(right.id));

  const loopMemberIds = new Set<string>();
  for (const loop of multiNodeLoops) {
    for (const nodeId of loop.nodeIds) {
      if (includedIds.has(nodeId)) loopMemberIds.add(nodeId);
    }
  }

  const { mermaidNodeIds, mermaidSubgraphIds } = buildMermaidIdTables(
    nodes.map((node) => node.id),
    multiNodeLoops.map((loop) => loop.id),
  );

  const lines: string[] = [`flowchart ${direction}`];
  const declared = new Set<string>();

  const declareNode = (node: GraphViewNode, indent: string): void => {
    if (declared.has(node.id)) return;
    const mermaidId = mermaidNodeIds.get(node.id);
    if (mermaidId === undefined) return;
    lines.push(`${indent}${nodeDeclaration(node, mermaidId, maxLabelLength, statusMarkers)}`);
    declared.add(node.id);
  };

  // Nodes outside multi-node loops first.
  for (const node of nodes) {
    if (!loopMemberIds.has(node.id)) declareNode(node, "  ");
  }

  // Multi-node loops as subgraphs.
  for (const loop of multiNodeLoops) {
    const subgraphId = mermaidSubgraphIds.get(loop.id)!;
    const loopTitle = statusMarkers && loop.status === "running"
      ? `▶ ${loop.id}`
      : loop.id;
    const subgraphTitle = escapeMermaidLabel(loopTitle, maxLabelLength);
    lines.push(`  subgraph ${subgraphId} ["${subgraphTitle}"]`);
    const members = nodes
      .filter((node) => loop.nodeIds.includes(node.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const node of members) declareNode(node, "    ");
    lines.push("  end");
  }

  // Edges that connect included nodes.
  const sortedEdges = [...view.edges].sort((left, right) =>
    left.source.localeCompare(right.source)
    || left.target.localeCompare(right.target)
    || left.kind.localeCompare(right.kind)
    || (left.outcome ?? "").localeCompare(right.outcome ?? "")
  );

  let edgeCount = 0;
  let omittedSkipped = 0;
  for (const edge of sortedEdges) {
    if (!includedIds.has(edge.source) || !includedIds.has(edge.target)) continue;
    const line = edgeLine(edge, mermaidNodeIds, compact);
    if (line === undefined) {
      if (edge.kind === "route" && edge.skipped && compact) omittedSkipped += 1;
      continue;
    }
    lines.push(`  ${line}`);
    edgeCount += 1;
  }

  if (omittedSkipped > 0) {
    diagnostics.push({
      code: "mermaid.skipped-routes-omitted",
      message: `Compact mode omits ${omittedSkipped} skipped route edge(s).`,
    });
  }

  return {
    source: lines.join("\n"),
    diagnostics,
    direction,
    nodeCount: nodes.length,
    edgeCount,
    mermaidNodeIds,
    mermaidSubgraphIds,
  };
}
