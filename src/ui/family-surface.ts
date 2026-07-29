/**
 * Family graph and executor status presentation for Hypagraph product surfaces.
 *
 * Rendering is pure. Callers supply a FamilyGraphViewModel from projectFamilyGraphView.
 * A child Hypagoal is a nested workflow boundary. It is not a subagent.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
  FamilyBindingEdgeView,
  FamilyGraphViewModel,
  FamilyMemberBoundaryView,
  FamilyPendingDispatchView,
  FamilyDispatchOutcomeView,
  FamilyDispatchSelectionView,
} from "../graph/family-projection.js";
import { sanitizeTerminalText } from "../graph/renderer.js";

/** Truncate one line to the requested terminal cell width. */
const fit = (line: string, width: number): string => {
  const safe = sanitizeTerminalText(line);
  if (width <= 0) return "";
  if (visibleWidth(safe) <= width) return safe;
  return truncateToWidth(safe, width, "…", true);
};

/**
 * Wrap free text by terminal cell width.
 * Prefix width is measured with visibleWidth so wide glyphs stay inside the limit.
 */
const wrap = (prefix: string, value: string, width: number): string[] => {
  const safeWidth = Math.max(24, width);
  const words = sanitizeTerminalText(value).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [fit(prefix, safeWidth)];
  const lines: string[] = [];
  let line = prefix;
  const indent = " ".repeat(Math.min(prefix.length, safeWidth));
  for (const word of words) {
    const separator = line === prefix ? "" : " ";
    const candidate = `${line}${separator}${word}`;
    if (visibleWidth(candidate) <= safeWidth) {
      line = candidate;
      continue;
    }
    lines.push(fit(line, safeWidth));
    const next = `${indent}${word}`;
    line = visibleWidth(next) <= safeWidth ? next : truncateToWidth(next, safeWidth, "…", true);
  }
  lines.push(fit(line, safeWidth));
  return lines;
};

const indentForDepth = (depth: number): string => "  ".repeat(Math.max(0, depth));

const memberLine = (member: FamilyMemberBoundaryView): string => {
  const marker = member.expanded ? "▼" : "▶";
  const focus = member.focused ? " [focused]" : "";
  const parent = member.parentNodeId
    ? ` ← parent node ${member.parentNodeId}`
    : "";
  const phase = member.phase ? ` · ${member.phase}` : "";
  const goal = member.goalStatus ? ` · goal ${member.goalStatus}` : "";
  return `${indentForDepth(member.depth)}${marker} ${member.goalId} · ${member.workflowId}${phase}${goal}${focus}${parent}`;
};

const bindingLine = (binding: FamilyBindingEdgeView): string => {
  const outcome = binding.returnOutcome ? ` · return ${binding.returnOutcome}` : "";
  const stop = binding.returnStopReason ? ` · ${binding.returnStopReason}` : "";
  return `${binding.bindingId}: ${binding.parentNodeId}@${binding.parentWorkflowId}`
    + ` → ${binding.childGoalId} (${binding.status}; policy ${binding.failurePolicy}${outcome}${stop})`;
};

/** Identity fragment shared by pending and terminal family dispatch lines. */
const dispatchIdentity = (item: FamilyDispatchSelectionView): string => {
  const node = item.nodeId ? ` node ${item.nodeId}` : "";
  const loop = item.loopId ? ` loop ${item.loopId}` : "";
  return `on ${item.goalId}/${item.workflowId}${node}${loop}`;
};

const pendingLine = (pending: FamilyPendingDispatchView): string =>
  `pending ${pending.status}: ${pending.actionKind} ${dispatchIdentity(pending)}`
  + ` (dispatch ${pending.dispatchId})`;

const outcomeLine = (outcome: FamilyDispatchOutcomeView): string => {
  const reason = outcome.reason ? `; ${outcome.reason}` : "";
  return `last ${outcome.status}: ${outcome.actionKind} ${dispatchIdentity(outcome)}`
    + ` (dispatch ${outcome.dispatchId})${reason}`;
};

/**
 * Format one family dispatch line for executor status and related product surfaces.
 * Includes loop identity when the projection supplies loopId.
 */
export function formatFamilyDispatchSurfaceLine(
  kind: "pending" | "last",
  item: FamilyPendingDispatchView | FamilyDispatchOutcomeView,
): string {
  if (kind === "pending" && "status" in item) {
    const pending = item as FamilyPendingDispatchView;
    if (pending.status === "selected" || pending.status === "dispatched") {
      return `Family dispatch pending: ${pending.status} ${pending.actionKind}`
        + ` ${dispatchIdentity(pending)}`
        + ` (${pending.dispatchId})`;
    }
  }
  const last = item as FamilyDispatchOutcomeView;
  return `Family dispatch last: ${last.status} ${last.actionKind}`
    + ` ${dispatchIdentity(last)}`
    + ` (${last.dispatchId})`;
}

/**
 * Compact widget lines for a family with one or more members.
 * One-member families still report family identity without inventing child boundaries.
 */
export function familyWidgetLines(view: FamilyGraphViewModel): string[] {
  const childCount = Math.max(0, view.memberCount - 1);
  const bindingWait = view.bindings.filter((binding) => binding.status === "active").length;
  const dispatch = view.scheduler.pending
    ? `dispatch ${view.scheduler.pending.status}`
    : view.scheduler.lastOutcome
      ? `last dispatch ${view.scheduler.lastOutcome.status}`
      : "dispatch idle";
  const executor = view.executor
    ? ` | executor ${view.executor.kindLabel}`
      + (view.executor.activeProcessCount === undefined
        ? ""
        : ` x${view.executor.activeProcessCount}`)
    : "";
  return [
    `Family: ${view.familyId} | members ${view.memberCount}`
      + (childCount > 0 ? ` | children ${childCount}` : "")
      + (bindingWait > 0 ? ` | binding waits ${bindingWait}` : "")
      + ` | ${dispatch}${executor}`,
  ];
}

/**
 * Render a full family status block for /hypagoal status and related surfaces.
 * Lines stay width-safe.
 */
export function renderFamilyStatus(view: FamilyGraphViewModel, width = 100): string {
  const lines: string[] = [];
  lines.push("Family graph");
  lines.push(...wrap("Family: ", `${view.familyId} | root ${view.rootGoalId} | members ${view.memberCount}`, width));
  lines.push(
    `Bounds: depth ${view.bounds.maxDepth}; children/goal ${view.bounds.maxChildrenPerGoal}; `
    + `goals ${view.bounds.memberCount}/${view.bounds.maxGoalsInFamily}; `
    + `creations/node ${view.bounds.maxChildCreationAttemptsPerNode}`,
  );
  const turns = view.budget.turns.limit === undefined
    ? `${view.budget.turns.reserved}/unlimited reserved turns`
    : `${view.budget.turns.reserved}/${view.budget.turns.limit} reserved turns`;
  const tokens = view.budget.tokens.limit === undefined
    ? `${view.budget.tokens.reserved}/unlimited reserved tokens`
    : `${view.budget.tokens.reserved}/${view.budget.tokens.limit} reserved tokens`;
  lines.push(`Family budget: ${turns}; ${tokens}`);

  if (view.ancestry.length > 0) {
    lines.push(
      `Ancestry: ${view.ancestry.map((step) => `${step.goalId}@d${step.depth}`).join(" → ")}`,
    );
  }

  lines.push("Members (nested workflow boundaries):");
  for (const member of view.members) {
    lines.push(...wrap("", memberLine(member), width));
    if (member.objective) {
      lines.push(...wrap(`${indentForDepth(member.depth)}  objective: `, member.objective, width));
    }
  }

  if (view.bindings.length > 0) {
    lines.push("Bindings (family edges, not definition edges):");
    for (const binding of view.bindings) {
      lines.push(...wrap("- ", bindingLine(binding), width));
    }
  } else {
    lines.push("Bindings: none");
  }

  lines.push(`Scheduler ordinal: ${view.scheduler.schedulerOrdinal}`);
  if (view.scheduler.pending) {
    lines.push(...wrap("Family dispatch: ", pendingLine(view.scheduler.pending), width));
  } else if (view.scheduler.lastOutcome) {
    lines.push(...wrap("Family dispatch: ", outcomeLine(view.scheduler.lastOutcome), width));
  } else {
    lines.push("Family dispatch: idle");
  }

  if (view.executor) {
    lines.push(...wrap("Executor: ", view.executor.summary, width));
  }

  lines.push(
    "Note: a child Hypagoal is a nested workflow boundary. It is not a subagent.",
  );

  return lines.map((line) => fit(line, width)).join("\n");
}

/** Default maximum family chrome lines in the graph overlay. */
export const DEFAULT_FAMILY_CHROME_MAX_LINES = 8;

export interface FamilyGraphSummaryOptions {
  /** Maximum chrome lines including the header block. Default 8. */
  maxLines?: number;
  /** Scroll offset into the member/binding list after the fixed header lines. */
  scrollOffset?: number;
}

/**
 * Short family chrome lines for the graph overlay.
 * Bounded height keeps the overlay inside the terminal.
 * Does not replace the focused workflow graph.
 */
export function familyGraphSummaryLines(
  view: FamilyGraphViewModel,
  width: number,
  options: FamilyGraphSummaryOptions = {},
): string[] {
  const maxLines = Math.max(3, options.maxLines ?? DEFAULT_FAMILY_CHROME_MAX_LINES);
  const scrollOffset = Math.max(0, options.scrollOffset ?? 0);
  const ancestry = view.ancestry.map((step) => step.goalId).join(" → ") || view.rootGoalId;
  const children = view.members.filter((member) => member.depth > 0);
  const expandedChildren = children.filter((member) => member.expanded).length;
  const bindingWait = view.bindings.filter((binding) => binding.status === "active").length;
  const dispatch = view.scheduler.pending
    ? `dispatch ${view.scheduler.pending.status} ${view.scheduler.pending.actionKind}`
    : view.scheduler.lastOutcome
      ? `last ${view.scheduler.lastOutcome.status}`
      : "dispatch idle";
  const executor = view.executor
    ? ` · ${view.executor.kindLabel}`
      + (view.executor.activeProcessCount === undefined
        ? ""
        : ` x${view.executor.activeProcessCount}`)
    : "";

  const header = [
    ` Family ${view.familyId} · ${view.memberCount} member(s) · focused ${view.focusedGoalId}`,
    ` Ancestry ${ancestry}`,
    ` Nested ${children.length} child workflow(s); expanded ${expandedChildren}`
      + (bindingWait > 0 ? `; binding waits ${bindingWait}` : "")
      + ` · ${dispatch}${executor}`
      + " · x expand · ]/[ focus · 0 root",
  ];

  const detail: string[] = [];
  for (const member of view.members) {
    if (member.depth === 0) continue;
    const mark = member.expanded ? "▼" : "▶";
    detail.push(
      ` ${mark} child ${member.goalId} · ${member.workflowId}`
        + (member.parentNodeId ? ` ← ${member.parentNodeId}` : "")
        + (member.focused ? " [focused]" : ""),
    );
  }
  for (const binding of view.bindings) {
    detail.push(
      ` bind ${binding.parentNodeId} → ${binding.childGoalId} (${binding.status})`,
    );
  }

  const fixed = header.map((line) => fit(line, width));
  if (fixed.length >= maxLines) return fixed.slice(0, maxLines);

  const detailBudget = maxLines - fixed.length;
  if (detail.length === 0) return fixed;

  const window = detail.slice(scrollOffset, scrollOffset + detailBudget);
  const omittedBefore = scrollOffset;
  const omittedAfter = Math.max(0, detail.length - scrollOffset - window.length);
  const lines = [...fixed, ...window.map((line) => fit(line, width))];
  if (omittedBefore > 0 || omittedAfter > 0) {
    // Prefer a single summary line when the window is full.
    if (lines.length >= maxLines) {
      lines[lines.length - 1] = fit(
        ` … ${omittedBefore + omittedAfter + (window.length > 0 ? 0 : 0)} more member/binding line(s); use PgUp/PgDn`,
        width,
      );
    } else {
      lines.push(fit(
        ` … ${omittedBefore > 0 ? `${omittedBefore} above, ` : ""}${omittedAfter} more`,
        width,
      ));
    }
  }
  return lines.slice(0, maxLines);
}

/**
 * Combine root Hypagoal status text with family status when a family exists.
 * Single-workflow sessions without a multi-member family keep the root block only
 * when showOneMember is false.
 */
export function appendFamilyStatusBlock(
  rootStatus: string,
  view: FamilyGraphViewModel | undefined,
  width = 100,
  options: { showOneMember?: boolean } = {},
): string {
  if (!view) return rootStatus;
  if (view.memberCount <= 1 && options.showOneMember !== true) {
    // Still show a one-line family identity so product paths prove family wiring.
    const line = fit(
      `Family: ${view.familyId} (one member; no nested child boundary)`,
      width,
    );
    return `${rootStatus}\n${line}`;
  }
  return `${rootStatus}\n\n${renderFamilyStatus(view, width)}`;
}
