import type { Theme } from "@earendil-works/pi-coding-agent";
import { assessEvaluationAuthoring, formatEvaluationAuthoringAdvisories } from "../domain/evaluation-authoring.js";
import { assessCodeAuthoring, formatCodeAuthoringAdvisories } from "../domain/code-authoring.js";
import type { Diagnostic, HypagraphState } from "../domain/model.js";
import { readyNodeIds } from "../domain/readiness.js";
import { loopFailurePolicy } from "../domain/workflow-outcome.js";
import type { FamilyGraphViewModel } from "../graph/family-projection.js";
import { projectMermaidFlowchart } from "../graph/mermaid-projection.js";
import { projectGraphView } from "../graph/projection.js";
import { loopSurfaceSummaries, renderLoopStatus } from "./loop-surface.js";
import { waitingQuestionLines, waitingWidgetLines } from "./interaction-surface.js";
import { projectGoalControlSurface, projectHypagoalSurface } from "./hypagoal-surface.js";
import { protectedTextPolicy } from "../domain/presentation-redaction.js";
import { colorizeLiveGraphArtLines } from "./live-graph-color.js";
import { renderMermaidArtBestFit } from "./mermaid-art.js";
import {
  formatGoalStatusBadge,
  formatPhaseBadge,
  formatStatusPhaseChip,
} from "./widget-chrome.js";

const activeNodeId = (state: HypagraphState): string | null => state.definition.nodes.find((node) => {
  const status = state.runtime.nodes[node.id]?.status;
  return status === "starting" || status === "running" || status === "awaiting_evidence" || status === "verifying";
})?.id ?? null;

export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((item) => `- ${item.code}${item.location ? ` at ${item.location}` : ""}: ${item.message}${item.suggestion ? ` ${item.suggestion}` : ""}`)
    .join("\n");
}

export function workflowSummary(state: HypagraphState): Record<string, unknown> {
  const counts: Record<string, number> = {};
  const policy = protectedTextPolicy(state);
  const hypagoal = projectHypagoalSurface(state);
  for (const runtime of Object.values(state.runtime.nodes)) counts[runtime.status] = (counts[runtime.status] ?? 0) + 1;
  return {
    workflowId: state.workflowId,
    revision: state.revision,
    sequence: state.sequence,
    phase: state.phase,
    title: state.definition.title,
    goal: state.definition.goal,
    counts,
    active: activeNodeId(state),
    ready: readyNodeIds(state),
    attempts: Object.fromEntries(Object.entries(state.runtime.nodes).map(([nodeId, runtime]) => [nodeId, runtime.attemptCount])),
    loops: policy.redact(loopSurfaceSummaries(state)),
    // Canonical runtime state is not a safe presentation model. Publish a named goal
    // control projection, so a later canonical field does not reach a reader by default.
    ...(state.goal === undefined ? {} : { goalControl: projectGoalControlSurface(state) }),
    ...(hypagoal === undefined ? {} : { hypagoal: policy.redact(structuredClone(hypagoal)) }),
    evaluationAuthoringAdvisories: assessEvaluationAuthoring(state.definition),
    codeAuthoringAdvisories: assessCodeAuthoring(state.definition),
    snapshotHash: state.snapshotHash,
  };
}

export function renderWorkflow(state: HypagraphState): string {
  const summary = workflowSummary(state);
  const hypagoal = projectHypagoalSurface(state);
  const policy = protectedTextPolicy(state);
  const lines = [
    `${state.definition.title} - ${state.phase} (revision ${state.revision}, event ${state.sequence})`,
    `Goal: ${state.definition.goal}`,
    `Active: ${String(summary.active ?? "none")}`,
    `Ready: ${(summary.ready as string[]).join(", ") || "none"}`,
    ...(state.goal === undefined || hypagoal === undefined ? [] : [
      `Goal control: ${state.goal.goalId} - ${state.goal.status}${state.goal.pauseCause ? ` [${state.goal.pauseCause}]` : ""}${state.goal.stopReason ? ` (${policy.text(state.goal.stopReason)})` : ""}`,
      `Goal next: ${hypagoal.action.next}`,
      `Goal budget: model turns ${state.goal.budget.consumedTurns}/${state.goal.budget.limits.maximumTurns ?? "unlimited"}; tokens ${state.goal.budget.consumedTokens.totalTokens}/${state.goal.budget.limits.maximumTokens ?? "unlimited"}`,
      `Scheduled actions: ${hypagoal.dispatch.scheduledActions}`,
      `Turn accounting: ${hypagoal.dispatch.turnAccounting}`,
      `Automatic revision: ${state.goal.automaticRevision.consumedAttempts}/${state.goal.automaticRevision.maximumAttempts}${state.goal.automaticRevision.lastAttempt ? ` - ${state.goal.automaticRevision.lastAttempt.outcome}${state.goal.automaticRevision.lastAttempt.outcomeCode ? ` (${state.goal.automaticRevision.lastAttempt.outcomeCode})` : ""}` : ""}`,
      ...(hypagoal.stopCode ? [`Goal stop: ${hypagoal.stopCode}${state.goal.stopReason ? ` - ${policy.text(state.goal.stopReason)}` : ""}`] : []),
    ]),
  ];
  if (state.definition.loops.length > 0) {
    lines.push("Loops:");
    for (const line of renderLoopStatus(state).split("\n")) lines.push(`- ${line}`);
  }
  const authoringAdvisories = assessEvaluationAuthoring(state.definition);
  if (authoringAdvisories.length > 0) {
    lines.push(formatEvaluationAuthoringAdvisories(authoringAdvisories));
  }
  const codeAdvisories = assessCodeAuthoring(state.definition);
  if (codeAdvisories.length > 0) {
    lines.push(formatCodeAuthoringAdvisories(codeAdvisories));
  }
  lines.push("Nodes:");
  for (const node of state.definition.nodes) {
    const runtime = state.runtime.nodes[node.id]!;
    const attempt = runtime.currentAttemptId ? runtime.attempts[runtime.currentAttemptId] : undefined;
    lines.push(`- ${node.id}: ${runtime.status} - ${node.title} (attempts ${runtime.attemptCount}${attempt?.iteration === undefined ? "" : `, iteration ${attempt.iteration}`})`);
  }
  lines.push(...waitingQuestionLines(state));
  return lines.join("\n");
}

export interface RenderWidgetOptions {
  /**
   * Animation frame index for braille spinners and live phase paint.
   * Host increments this while the goal is running, blocked, or paused.
   */
  frameIndex?: number;
  /**
   * Maximum columns for the live Mermaid art in the widget.
   * Defaults to 100 when omitted.
   */
  maxWidth?: number;
  /**
   * When false, omit Mermaid art (title + waiting only).
   * Default true so the graph sits above the composer with the status line.
   */
  includeDiagram?: boolean;
  /**
   * Precomputed diagram lines. When set, skips Mermaid render (animation ticks).
   */
  diagramLines?: readonly string[];
  /**
   * Optional Pi theme for status colour on node labels in the compact widget.
   * When omitted, art stays plain (tests and hosts without theme).
   */
  theme?: Theme;
}

/** Default art width when the host does not supply terminal columns. */
const DEFAULT_WIDGET_DIAGRAM_WIDTH = 100;

/**
 * Pi InteractiveMode.MAX_WIDGET_LINES (see pi-coding-agent interactive-mode.js).
 *
 * String-array widgets longer than this are clipped and show "... (widget truncated)".
 * Hypagraph must stay within this budget so the live graph is not cut off.
 */
export const PI_MAX_WIDGET_LINES = 10;

/**
 * Maximum Mermaid art rows in the widget when the title uses one line.
 * Title + art must not exceed PI_MAX_WIDGET_LINES.
 */
export const MAX_WIDGET_DIAGRAM_LINES = PI_MAX_WIDGET_LINES - 1;

/**
 * Cache key → plain art lines. Avoid re-layout on every braille animation frame.
 */
const widgetDiagramCache = new Map<string, string[]>();

/**
 * Horizontal Mermaid art for the above-composer hypagraph widget.
 *
 * LR only (same product rule as the live dock). Compact labels when needed,
 * then horizontal clip. Never vertical TD.
 *
 * @param maxHeight - Max art rows (default MAX_WIDGET_DIAGRAM_LINES).
 */
export function renderWidgetDiagramLines(
  state: HypagraphState,
  maxWidth = DEFAULT_WIDGET_DIAGRAM_WIDTH,
  maxHeight = MAX_WIDGET_DIAGRAM_LINES,
  theme?: Theme,
): string[] {
  const budget = Math.max(20, maxWidth);
  const height = Math.max(1, maxHeight);
  // Plain art is cacheable; coloured lines include theme SGR and skip the cache.
  const cacheKey = `${state.workflowId}:${state.sequence}:${state.snapshotHash}:${budget}:${height}`;
  let lines: string[];
  if (!theme) {
    const cached = widgetDiagramCache.get(cacheKey);
    if (cached) return cached;
  }

  const view = projectGraphView(state);
  // Prefer slightly longer labels first; fall back to compact when art is wide.
  const lr = projectMermaidFlowchart(view, { direction: "LR", statusMarkers: true, maxLabelLength: 18 });
  const lrCompact = projectMermaidFlowchart(view, {
    direction: "LR",
    statusMarkers: true,
    maxLabelLength: 12,
    compact: true,
  });
  const lrTight = projectMermaidFlowchart(view, {
    direction: "LR",
    statusMarkers: true,
    maxLabelLength: 8,
    compact: true,
  });
  const art = renderMermaidArtBestFit(
    [lr.source, lrCompact.source, lrTight.source],
    {
      maxWidth: budget,
      preferSourceBox: false,
      whenTooWide: "clip-art",
    },
  );
  lines = art.lines.slice(0, height);
  if (!theme) {
    // Keep the cache small: one entry per live paint path is enough in practice.
    if (widgetDiagramCache.size > 8) widgetDiagramCache.clear();
    widgetDiagramCache.set(cacheKey, lines);
    return lines;
  }
  return colorizeLiveGraphArtLines(lines, view, theme);
}

/**
 * Compact above-composer hypagraph chrome.
 *
 * Normal use: one title line and the live horizontal graph (no blank separator).
 * Total lines stay at or under PI_MAX_WIDGET_LINES so Pi does not truncate.
 * Active / Ready / Budget / Family detail stays on /hypagraph status.
 */
export function renderWidget(
  state: HypagraphState,
  _family?: FamilyGraphViewModel,
  options: RenderWidgetOptions = {},
): string[] {
  const frameIndex = options.frameIndex ?? 0;
  const hypagoal = projectHypagoalSurface(state);
  const phaseBadge = formatPhaseBadge(state.phase, frameIndex);
  const goalFragment = state.goal
    ? ` | Goal ${formatGoalStatusBadge(state.goal.status, frameIndex)}${hypagoal?.stopCode ? ` (${hypagoal.stopCode})` : ""}`
    : "";
  const lines: string[] = [
    `Hypagraph: ${state.definition.title} ${phaseBadge}${goalFragment}`,
  ];

  const includeDiagram = options.includeDiagram !== false;
  if (includeDiagram) {
    // Reserve title line. Do not insert a blank separator (wastes a Pi slot).
    const artBudget = Math.max(1, PI_MAX_WIDGET_LINES - lines.length);
    const diagram = options.diagramLines
      ? options.diagramLines.slice(0, artBudget)
      : renderWidgetDiagramLines(
        state,
        options.maxWidth ?? DEFAULT_WIDGET_DIAGRAM_WIDTH,
        artBudget,
        options.theme,
      );
    if (diagram.length > 0) {
      lines.push(...diagram);
    }
  }

  // Wait hints only if they still fit under Pi's hard line cap.
  const waiting = waitingWidgetLines(state);
  for (const row of waiting) {
    if (lines.length >= PI_MAX_WIDGET_LINES) break;
    lines.push(row);
  }
  return lines.slice(0, PI_MAX_WIDGET_LINES);
}

/**
 * Compact footer status line phase segment with gold spinner when running.
 */
export function renderStatusPhaseLabel(phase: string, frameIndex = 0): string {
  return formatStatusPhaseChip(phase, frameIndex);
}

export { loopFailurePolicy };
