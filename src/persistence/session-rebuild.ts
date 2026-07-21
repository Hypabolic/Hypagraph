import type { WorkGraphState } from "../domain/model.js";

interface ToolResultEntry {
  type: "message";
  message: {
    role: "toolResult";
    toolName: string;
    details?: {
      workgraph?: unknown;
    };
  };
}

const isToolResultEntry = (entry: unknown): entry is ToolResultEntry => {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<ToolResultEntry>;
  return candidate.type === "message" && candidate.message?.role === "toolResult";
};

export function isWorkGraphState(value: unknown): value is WorkGraphState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkGraphState>;
  return candidate.schemaVersion === 1
    && typeof candidate.workflowId === "string"
    && typeof candidate.revision === "number"
    && typeof candidate.snapshotHash === "string"
    && !!candidate.definition
    && !!candidate.runtime;
}

/** Rebuilds the latest state from the active session branch, never from abandoned siblings. */
export function restoreLatestSnapshot(entries: readonly unknown[]): WorkGraphState | undefined {
  let latest: WorkGraphState | undefined;
  for (const entry of entries) {
    if (!isToolResultEntry(entry)) continue;
    if (!entry.message.toolName.startsWith("workgraph_")) continue;
    const snapshot = entry.message.details?.workgraph;
    if (isWorkGraphState(snapshot)) latest = structuredClone(snapshot);
  }
  return latest;
}
