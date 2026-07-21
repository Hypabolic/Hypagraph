import type { Diagnostic, WorkGraphState } from "../domain/model.js";
import { readyNodeIds } from "../domain/readiness.js";

export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((item) => `- ${item.code}${item.location ? ` at ${item.location}` : ""}: ${item.message}${item.suggestion ? ` ${item.suggestion}` : ""}`)
    .join("\n");
}

export function workflowSummary(state: WorkGraphState): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const runtime of Object.values(state.runtime.nodes)) counts[runtime.status] = (counts[runtime.status] ?? 0) + 1;
  return {
    workflowId: state.workflowId,
    revision: state.revision,
    phase: state.phase,
    title: state.definition.title,
    goal: state.definition.goal,
    counts,
    active: state.definition.nodes.find((node) => state.runtime.nodes[node.id]?.status === "active")?.id ?? null,
    ready: readyNodeIds(state),
    loops: state.definition.loops.map((loop) => ({
      id: loop.id,
      nodes: loop.nodes,
      maxIterations: loop.maxIterations,
      status: "validated-not-yet-iterating",
    })),
    snapshotHash: state.snapshotHash,
  };
}

export function renderWorkflow(state: WorkGraphState): string {
  const summary = workflowSummary(state);
  const lines = [
    `${state.definition.title} — ${state.phase} (revision ${state.revision})`,
    `Goal: ${state.definition.goal}`,
    `Active: ${String(summary.active ?? "none")}`,
    `Ready: ${(summary.ready as string[]).join(", ") || "none"}`,
    "Nodes:",
  ];
  for (const node of state.definition.nodes) {
    const runtime = state.runtime.nodes[node.id]!;
    lines.push(`- ${node.id}: ${runtime.status} — ${node.title}`);
  }
  return lines.join("\n");
}

export function renderWidget(state: WorkGraphState): string[] {
  const active = state.definition.nodes.find((node) => state.runtime.nodes[node.id]?.status === "active");
  const ready = readyNodeIds(state);
  return [
    `Hypagraph: ${state.definition.title} [${state.phase}]`,
    `Active: ${active?.id ?? "none"} | Ready: ${ready.join(", ") || "none"}`,
  ];
}
