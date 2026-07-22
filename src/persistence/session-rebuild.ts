import {
  HYPAGRAPH_EVENT_VERSION,
  HYPAGRAPH_SCHEMA_VERSION,
  type DomainEvent,
  type HypagraphDefinition,
  type HypagraphState,
  type PersistedHypagraph,
} from "../domain/model.js";
import { sha256 } from "../domain/hash.js";
import { dependenciesAreSatisfied } from "../domain/readiness.js";
import { replayEvents } from "../domain/projection.js";
import {
  HYPAGRAPH_EVENT_BATCH_TYPE,
  type PersistedEventBatch,
  validateEventAppend,
  WorkflowSequenceConflictError,
} from "./event-store.js";

interface ToolResultEntry {
  type: "message";
  message: {
    role: "toolResult";
    toolName: string;
    details?: { hypagraph?: unknown };
  };
}

interface CustomEntry {
  type: "custom";
  customType: string;
  data?: unknown;
}

const isToolResultEntry = (entry: unknown): entry is ToolResultEntry => {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<ToolResultEntry>;
  return candidate.type === "message" && candidate.message?.role === "toolResult";
};

const isCustomEntry = (entry: unknown): entry is CustomEntry => {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<CustomEntry>;
  return candidate.type === "custom" && typeof candidate.customType === "string";
};

export function isHypagraphState(value: unknown): value is HypagraphState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HypagraphState>;
  return candidate.schemaVersion === HYPAGRAPH_SCHEMA_VERSION
    && typeof candidate.workflowId === "string"
    && typeof candidate.revision === "number"
    && typeof candidate.sequence === "number"
    && typeof candidate.snapshotHash === "string"
    && !!candidate.definition
    && !!candidate.runtime;
}

const isPersisted = (value: unknown): value is PersistedHypagraph => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedHypagraph>;
  return Array.isArray(candidate.events) && isHypagraphState(candidate.snapshot);
};

export const isPersistedEventBatch = (value: unknown): value is PersistedEventBatch => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedEventBatch>;
  return candidate.version === 1
    && typeof candidate.workflowId === "string"
    && typeof candidate.expectedSequence === "number"
    && Array.isArray(candidate.events)
    && isHypagraphState(candidate.snapshot);
};

const event = (
  workflowId: string,
  revision: number,
  sequence: number,
  timestamp: string,
  type: DomainEvent["type"],
  data: Record<string, unknown> = {},
  nodeId?: string,
  attemptId?: string,
): DomainEvent => ({
  eventId: sha256({ workflowId, revision, sequence, type, nodeId: nodeId ?? null, attemptId: attemptId ?? null, migration: 1 }),
  workflowId,
  revision,
  sequence,
  type,
  version: HYPAGRAPH_EVENT_VERSION,
  timestamp,
  causationId: "schema-1-migration",
  correlationId: "schema-1-migration",
  ...(nodeId ? { nodeId } : {}),
  ...(attemptId ? { attemptId } : {}),
  data,
});

const migrateVersionOne = (value: unknown): PersistedHypagraph | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const source = value as {
    schemaVersion?: unknown;
    workflowId?: unknown;
    revision?: unknown;
    definition?: unknown;
    runtime?: { nodes?: Record<string, { status?: string; evidence?: unknown[]; startedAt?: string; completedAt?: string; blockedReason?: string }> };
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  if (source.schemaVersion !== 1 || typeof source.workflowId !== "string" || typeof source.revision !== "number") return undefined;
  if (!source.definition || !source.runtime?.nodes || typeof source.createdAt !== "string") return undefined;

  const definition = source.definition as HypagraphDefinition;
  const updatedAt = typeof source.updatedAt === "string" ? source.updatedAt : source.createdAt;
  const events: DomainEvent[] = [event(source.workflowId, source.revision, 1, source.createdAt, "hypagraph.workflow.defined", { definition })];
  let sequence = 1;

  for (const node of definition.nodes) {
    const old = source.runtime.nodes[node.id];
    if (!old) continue;
    if (old.status === "blocked") {
      events.push(event(source.workflowId, source.revision, ++sequence, updatedAt, "hypagraph.node.blocked", { reason: old.blockedReason ?? "Migrated blocked node." }, node.id));
      continue;
    }
    if (old.status === "active" || old.status === "completed") {
      const attemptId = `migration-${sha256({ workflowId: source.workflowId, nodeId: node.id }).slice(0, 24)}`;
      events.push(event(source.workflowId, source.revision, ++sequence, old.startedAt ?? source.createdAt, "hypagraph.attempt.started", {}, node.id, attemptId));
      if (old.status === "completed") {
        const timestamp = old.completedAt ?? updatedAt;
        events.push(event(source.workflowId, source.revision, ++sequence, timestamp, "hypagraph.attempt.result-submitted", { evidence: old.evidence ?? [] }, node.id, attemptId));
        events.push(event(source.workflowId, source.revision, ++sequence, timestamp, "hypagraph.verification.started", {}, node.id, attemptId));
        events.push(event(source.workflowId, source.revision, ++sequence, timestamp, "hypagraph.verification.passed", {}, node.id, attemptId));
      }
    }
  }

  let snapshot = replayEvents(events);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of definition.nodes) {
      const runtime = snapshot.runtime.nodes[node.id];
      if (!runtime || runtime.status !== "pending" || !dependenciesAreSatisfied(snapshot, node.id)) continue;
      events.push(event(source.workflowId, source.revision, ++sequence, updatedAt, "hypagraph.node.ready", {}, node.id));
      snapshot = replayEvents(events);
      changed = true;
    }
  }

  snapshot = replayEvents(events);
  return { events, snapshot };
};

const acceptPersisted = (stored: PersistedHypagraph): PersistedHypagraph => {
  const snapshot = replayEvents(stored.events);
  if (snapshot.snapshotHash !== stored.snapshot.snapshotHash) throw new Error("The stored Hypagraph snapshot does not match its event stream.");
  return { events: structuredClone(stored.events), snapshot };
};

const appendStoredBatch = (
  latest: PersistedHypagraph | undefined,
  batch: PersistedEventBatch,
): PersistedHypagraph => {
  validateEventAppend(batch);
  const sameWorkflow = latest?.snapshot.workflowId === batch.workflowId;
  const actualSequence = sameWorkflow ? latest.snapshot.sequence : 0;
  if (actualSequence !== batch.expectedSequence) {
    throw new WorkflowSequenceConflictError(batch.workflowId, batch.expectedSequence, actualSequence);
  }

  const events = [...(sameWorkflow ? latest.events : []), ...structuredClone(batch.events)];
  const snapshot = replayEvents(events);
  if (snapshot.snapshotHash !== batch.snapshot.snapshotHash) {
    throw new Error("The stored Hypagraph event batch does not match its snapshot.");
  }
  return { events, snapshot };
};

export function restoreLatestSession(entries: readonly unknown[]): PersistedHypagraph | undefined {
  let latest: PersistedHypagraph | undefined;
  for (const entry of entries) {
    if (isCustomEntry(entry) && entry.customType === HYPAGRAPH_EVENT_BATCH_TYPE) {
      if (!isPersistedEventBatch(entry.data)) throw new Error("The stored Hypagraph event batch is invalid.");
      latest = appendStoredBatch(latest, entry.data);
      continue;
    }
    if (!isToolResultEntry(entry) || !entry.message.toolName.startsWith("hypagraph_")) continue;
    const stored = entry.message.details?.hypagraph;
    if (isPersisted(stored)) {
      latest = acceptPersisted(stored);
      continue;
    }
    const migrated = migrateVersionOne(stored);
    if (migrated) latest = migrated;
  }
  return latest;
}

export function restoreLatestSnapshot(entries: readonly unknown[]): HypagraphState | undefined {
  return restoreLatestSession(entries)?.snapshot;
}
