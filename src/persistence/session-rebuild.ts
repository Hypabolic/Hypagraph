import { HYPAGRAPH_SCHEMA_VERSION, type HypagraphState } from "../domain/model.js";

interface ToolResultEntry {
  type: "message";
  message: {
    role: "toolResult";
    toolName: string;
    details?: {
      hypagraph?: unknown;
    };
  };
}

const isToolResultEntry = (entry: unknown): entry is ToolResultEntry => {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<ToolResultEntry>;
  return candidate.type === "message" && candidate.message?.role === "toolResult";
};

export function isHypagraphState(value: unknown): value is HypagraphState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HypagraphState>;
  return candidate.schemaVersion === HYPAGRAPH_SCHEMA_VERSION
    && typeof candidate.workflowId === "string"
    && typeof candidate.revision === "number"
    && typeof candidate.snapshotHash === "string"
    && !!candidate.definition
    && !!candidate.runtime;
}

/** Get the newest state from the active session branch. Do not use abandoned sibling branches. */
export function restoreLatestSnapshot(entries: readonly unknown[]): HypagraphState | undefined {
  let latest: HypagraphState | undefined;
  for (const entry of entries) {
    if (!isToolResultEntry(entry)) continue;
    if (!entry.message.toolName.startsWith("hypagraph_")) continue;
    const snapshot = entry.message.details?.hypagraph;
    if (isHypagraphState(snapshot)) latest = structuredClone(snapshot);
  }
  return latest;
}
