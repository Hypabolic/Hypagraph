import { assessEvaluationAuthoring, formatEvaluationAuthoringAdvisories } from "../domain/evaluation-authoring.js";
import type { Diagnostic, HypagraphState } from "../domain/model.js";
import { readyNodeIds } from "../domain/readiness.js";
import { loopFailurePolicy } from "../domain/workflow-outcome.js";
import { loopSurfaceSummaries, renderLoopStatus } from "./loop-surface.js";

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
    loops: loopSurfaceSummaries(state),
    ...(state.goal === undefined ? {} : { goalControl: structuredClone(state.goal) }),
    evaluationAuthoringAdvisories: assessEvaluationAuthoring(state.definition),
    snapshotHash: state.snapshotHash,
  };
}

export function renderWorkflow(state: HypagraphState): string {
  const summary = workflowSummary(state);
  const lines = [
    `${state.definition.title} - ${state.phase} (revision ${state.revision}, event ${state.sequence})`,
    `Goal: ${state.definition.goal}`,
    `Active: ${String(summary.active ?? "none")}`,
    `Ready: ${(summary.ready as string[]).join(", ") || "none"}`,
    ...(state.goal === undefined ? [] : [`Goal control: ${state.goal.goalId} - ${state.goal.status}${state.goal.stopReason ? ` (${state.goal.stopReason})` : ""}`]),
  ];
  if (state.definition.loops.length > 0) {
    lines.push("Loops:");
    for (const line of renderLoopStatus(state).split("\n")) lines.push(`- ${line}`);
  }
  const authoringAdvisories = assessEvaluationAuthoring(state.definition);
  if (authoringAdvisories.length > 0) {
    lines.push(formatEvaluationAuthoringAdvisories(authoringAdvisories));
  }
  lines.push("Nodes:");
  for (const node of state.definition.nodes) {
    const runtime = state.runtime.nodes[node.id]!;
    const attempt = runtime.currentAttemptId ? runtime.attempts[runtime.currentAttemptId] : undefined;
    lines.push(`- ${node.id}: ${runtime.status} - ${node.title} (attempts ${runtime.attemptCount}${attempt?.iteration === undefined ? "" : `, iteration ${attempt.iteration}`})`);
  }
  return lines.join("\n");
}

export function renderWidget(state: HypagraphState): string[] {
  const ready = readyNodeIds(state);
  const shownLoop = loopSurfaceSummaries(state).find((loop) => loop.status === "running")
    ?? loopSurfaceSummaries(state).find((loop) => loop.status === "failed" || loop.status === "succeeded");
  const progress = shownLoop?.progress?.bestMetric === undefined
    ? ""
    : ` best ${shownLoop.progress.bestMetric} at ${shownLoop.progress.bestIteration}${shownLoop.progress.patience === undefined ? "" : ` patience ${shownLoop.progress.remainingPatience}/${shownLoop.progress.patience}`}`;
  const policy = shownLoop ? ` ${shownLoop.failurePolicy}` : "";
  const outcome = shownLoop?.exitReason ? ` ${shownLoop.exitReason}` : "";
  return [
    `Hypagraph: ${state.definition.title} [${state.phase}]${state.goal ? ` | Goal ${state.goal.status}` : ""}`,
    `Active: ${activeNodeId(state) ?? "none"} | Ready: ${ready.join(", ") || "none"}${shownLoop ? ` | Loop ${shownLoop.id}: ${shownLoop.iteration.current}/${shownLoop.iteration.limit}${policy}${outcome}${progress}` : ""}`,
  ];
}

export { loopFailurePolicy };
