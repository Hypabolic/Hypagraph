/**
 * Color live Mermaid graph art by node and loop status.
 *
 * Pure string painting against a Theme.fg palette. Does not own layout.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { LoopStatus, NodeStatus } from "../domain/model.js";
import type { GraphViewModel, GraphViewNode } from "../graph/projection.js";
import { escapeMermaidLabel } from "../graph/mermaid-projection.js";

/** Status glyphs embedded in live Mermaid labels (must match projection). */
export const LIVE_NODE_STATUS_GLYPH: Record<NodeStatus, string> = {
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

/** Theme token used for each node status on the live dock. */
export function themeTokenForNodeStatus(
  status: NodeStatus,
): "accent" | "success" | "error" | "warning" | "muted" | "toolTitle" {
  switch (status) {
    case "running":
    case "starting":
    case "awaiting_evidence":
    case "awaiting_response":
    case "waiting_for_child":
    case "verifying":
      return "accent";
    case "ready":
      return "toolTitle";
    case "succeeded":
      return "success";
    case "failed":
      return "error";
    case "blocked":
    case "stale":
      return "warning";
    case "cancelled":
    case "skipped":
    case "pending":
    default:
      return "muted";
  }
}

/** Theme token for loop status on subgraph titles. */
export function themeTokenForLoopStatus(status: LoopStatus): "accent" | "success" | "error" | "warning" | "muted" {
  switch (status) {
    case "running":
      return "accent";
    case "succeeded":
      return "success";
    case "failed":
      return "error";
    case "blocked":
    case "requires_revision":
      return "warning";
    default:
      return "muted";
  }
}

/** True when the node should be emphasised as currently active work. */
export function nodeIsLiveHot(node: GraphViewNode): boolean {
  if (node.active || node.ready) return true;
  return [
    "starting",
    "running",
    "awaiting_evidence",
    "awaiting_response",
    "waiting_for_child",
    "verifying",
    "blocked",
  ].includes(node.status);
}

/**
 * Build the live Mermaid label text for a node (glyph + title).
 * Kept in sync with mermaid-projection statusMarkers path.
 */
export function liveNodeLabel(node: GraphViewNode, maxLabelLength = 28): string {
  const glyph = LIVE_NODE_STATUS_GLYPH[node.status] ?? "·";
  return escapeMermaidLabel(`${glyph} ${node.title || node.id}`, maxLabelLength);
}

/** Label lengths used by compact Mermaid art fall-backs (widget + dock). */
const LIVE_LABEL_LENGTHS = [28, 18, 16, 12, 10, 8] as const;

/**
 * True when this node has already executed or been taken off the pending path.
 * Used to colour completed work distinctly from untouched pending nodes.
 */
export function nodePathHasRun(node: GraphViewNode): boolean {
  if (node.attemptCount > 0) return true;
  return [
    "succeeded",
    "failed",
    "cancelled",
    "skipped",
    "stale",
    "blocked",
  ].includes(node.status);
}

/**
 * Color plain Mermaid art lines using status-bearing substrings from the view.
 *
 * Longer needles paint first so nested titles do not steal shorter matches.
 * Tries several label lengths so compact/truncated art still matches.
 * Selected route outcomes (true/false) paint as taken path markers.
 */
export function colorizeLiveGraphArtLines(
  plainLines: readonly string[],
  view: GraphViewModel,
  theme: Theme,
  maxLabelLength = 28,
): string[] {
  type Needle = { text: string; token: string };
  const needles: Needle[] = [];
  const lengths = LIVE_LABEL_LENGTHS.includes(maxLabelLength as typeof LIVE_LABEL_LENGTHS[number])
    ? LIVE_LABEL_LENGTHS
    : [maxLabelLength, ...LIVE_LABEL_LENGTHS];

  for (const node of view.nodes) {
    const token = themeTokenForNodeStatus(node.status);
    const glyph = LIVE_NODE_STATUS_GLYPH[node.status] ?? "·";
    for (const length of lengths) {
      const label = liveNodeLabel(node, length);
      if (label.length > 0) {
        needles.push({ text: label, token });
      }
      // Truncated art often keeps the glyph + first words of the title.
      const shortTitle = escapeMermaidLabel(node.title || node.id, length);
      if (shortTitle.length > 0) {
        needles.push({ text: `${glyph} ${shortTitle}`, token });
      }
    }
    // Id-based needles when titles are clipped to unrecognisable stubs.
    needles.push({ text: `${glyph} ${node.id}`, token });
    if (nodeIsLiveHot(node) || nodePathHasRun(node)) {
      needles.push({ text: node.id, token });
    }
  }

  for (const loop of view.loops) {
    if (loop.nodeIds.length <= 1) continue;
    const token = themeTokenForLoopStatus(loop.status);
    for (const length of lengths) {
      const title = escapeMermaidLabel(
        `${loop.status === "running" ? "▶ " : ""}${loop.id}`,
        length,
      );
      needles.push({ text: title, token });
    }
    needles.push({ text: loop.id, token });
  }

  // Selected gate outcomes mark the taken path on the art.
  for (const edge of view.edges) {
    if (edge.kind !== "route" || edge.outcome === undefined) continue;
    if (edge.selected) {
      needles.push({ text: edge.outcome, token: "success" });
    } else if (edge.skipped) {
      needles.push({ text: edge.outcome, token: "muted" });
      needles.push({ text: "skipped", token: "muted" });
    }
  }

  // Longest match first for stable replace; de-dupe exact text keeping first token.
  const unique = new Map<string, Needle>();
  for (const needle of needles) {
    if (needle.text.length === 0) continue;
    if (!unique.has(needle.text)) unique.set(needle.text, needle);
  }
  const sorted = [...unique.values()].sort(
    (left, right) => right.text.length - left.text.length || left.text.localeCompare(right.text),
  );

  return plainLines.map((line) => paintLine(line, sorted, theme));
}

const paintLine = (line: string, needles: readonly { text: string; token: string }[], theme: Theme): string => {
  // Skip empty / pure border-like lines for speed.
  if (line.trim().length === 0) return line;

  // Walk left to right; at each index try longest needle.
  let out = "";
  let index = 0;
  while (index < line.length) {
    let matched: { text: string; token: string } | undefined;
    for (const needle of needles) {
      if (needle.text.length === 0) continue;
      if (line.startsWith(needle.text, index)) {
        matched = needle;
        break;
      }
    }
    if (matched) {
      out += theme.fg(matched.token as Parameters<Theme["fg"]>[0], matched.text);
      index += matched.text.length;
    } else {
      out += line[index]!;
      index += 1;
    }
  }
  return out;
};
