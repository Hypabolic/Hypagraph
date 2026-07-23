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
        status: runtime?.status ?? "pending",
        currentIteration: runtime?.currentIteration ?? 0,
        noProgressCount: runtime?.noProgressCount ?? 0,
        ...(loop.patience === undefined ? {} : { patience: loop.patience, remainingPatience: Math.max(0, loop.patience - (runtime?.noProgressCount ?? 0)) }),
        ...(runtime?.lastSuccess === undefined ? {} : { lastSuccess: runtime.lastSuccess }),
        ...(runtime?.exitReason === undefined ? {} : { exitReason: runtime.exitReason }),
        ...(runtime?.currentMetric === undefined ? {} : { currentMetric: runtime.currentMetric }),
        ...(runtime?.bestMetric === undefined ? {} : { bestMetric: runtime.bestMetric }),
        ...(runtime?.bestIteration === undefined ? {} : { bestIteration: runtime.bestIteration }),
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
      const progress = runtime?.currentMetric === undefined ? "" : ` - metric ${runtime.currentMetric}${runtime.bestMetric === undefined ? "" : `, best ${runtime.bestMetric} at ${runtime.bestIteration}`}${loop.patience === undefined ? "" : `, patience ${Math.max(0, loop.patience - (runtime.noProgressCount ?? 0))}/${loop.patience}`}`;
      lines.push(`- ${loop.id}: ${runtime?.status ?? "pending"} - iteration ${runtime?.currentIteration ?? 0}/${loop.maxIterations}${runtime?.exitReason ? ` - ${runtime.exitReason}` : ""}${progress}`);
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
  const shownLoop = Object.values(state.runtime.loops).find((loop) => loop.status === "running") ?? Object.values(state.runtime.loops).find((loop) => loop.status === "failed" || loop.status === "succeeded");
  const definition = shownLoop ? state.definition.loops.find((loop) => loop.id === shownLoop.loopId) : undefined;
  const progress = shownLoop?.bestMetric === undefined ? "" : ` best ${shownLoop.bestMetric} at ${shownLoop.bestIteration}${definition?.patience === undefined ? "" : ` patience ${Math.max(0, definition.patience - (shownLoop.noProgressCount ?? 0))}/${definition.patience}`}`;
  return [
    `Hypagraph: ${state.definition.title} [${state.phase}]`,
    `Active: ${activeNodeId(state) ?? "none"} | Ready: ${ready.join(", ") || "none"}${shownLoop ? ` | Loop ${shownLoop.loopId}: ${shownLoop.currentIteration}/${shownLoop.maxIterations}${progress}` : ""}`,
  ];
}
