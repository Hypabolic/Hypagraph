import type { Diagnostic, HypagraphState } from "../domain/model.js";
import { readyNodeIds } from "../domain/readiness.js";

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
    loops: state.definition.loops.map((loop) => {
      const runtime = state.runtime.loops[loop.id];
      return {
        id: loop.id,
        nodes: loop.nodes,
        maxIterations: loop.maxIterations,
        status: runtime?.status ?? "inactive",
        currentIteration: runtime?.currentIteration ?? 0,
        ...(runtime?.lastSuccess === undefined ? {} : { lastSuccess: runtime.lastSuccess }),
        ...(runtime?.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
      };
    }),
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
  ];
  if (state.definition.loops.length > 0) {
    lines.push("Loops:");
    for (const loop of state.definition.loops) {
      const runtime = state.runtime.loops[loop.id];
      lines.push(`- ${loop.id}: ${runtime?.status ?? "inactive"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""}`);
    }
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
  const activeLoop = Object.values(state.runtime.loops).find((loop) => loop.status === "running");
  return [
    `Hypagraph: ${state.definition.title} [${state.phase}]`,
    `Active: ${activeNodeId(state) ?? "none"} | Ready: ${ready.join(", ") || "none"}${activeLoop ? ` | Loop ${activeLoop.loopId}: ${activeLoop.currentIteration}/${activeLoop.maxIterations}` : ""}`,
  ];
}
