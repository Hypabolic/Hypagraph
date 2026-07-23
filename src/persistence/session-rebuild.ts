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

interface StoredSnapshotShape {
  schemaVersion: number;
  workflowId: string;
  revision: number;
  sequence: number;
  snapshotHash: string;
  definition: unknown;
  runtime: unknown;
}

interface StoredPersisted {
  events: DomainEvent[];
  snapshot: StoredSnapshotShape;
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

const isStoredSnapshot = (value: unknown): value is StoredSnapshotShape => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredSnapshotShape>;
  return (candidate.schemaVersion === HYPAGRAPH_SCHEMA_VERSION || candidate.schemaVersion === 2)
    && typeof candidate.workflowId === "string"
    && typeof candidate.revision === "number"
    && typeof candidate.sequence === "number"
    && typeof candidate.snapshotHash === "string"
    && !!candidate.definition
    && !!candidate.runtime;
};

export function isHypagraphState(value: unknown): value is HypagraphState {
  return isStoredSnapshot(value) && value.schemaVersion === HYPAGRAPH_SCHEMA_VERSION;
}

const isPersisted = (value: unknown): value is StoredPersisted => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredPersisted>;
  return Array.isArray(candidate.events) && isStoredSnapshot(candidate.snapshot);
};

export const isPersistedEventBatch = (value: unknown): value is PersistedEventBatch => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedEventBatch> & { snapshot?: unknown };
  return candidate.version === 1
    && typeof candidate.workflowId === "string"
    && typeof candidate.expectedSequence === "number"
    && Array.isArray(candidate.events)
    && isStoredSnapshot(candidate.snapshot);
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

export function validateRestoredLoopState(state: HypagraphState): void {
  const active = new Set(["starting", "running", "awaiting_evidence", "verifying"]);
  for (const definition of state.definition.loops) {
    const runtime = state.runtime.loops[definition.id];
    if (!runtime) throw new Error(`Restored loop '${definition.id}' has no runtime state.`);
    if (runtime.maxIterations !== definition.maxIterations) throw new Error(`Restored loop '${definition.id}' has a different iteration limit from its definition.`);
    if ((runtime.status === "pending" || runtime.status === "requires_revision") && runtime.currentIteration !== 0) {
      throw new Error(`Restored loop '${definition.id}' has not started but records iteration ${runtime.currentIteration}.`);
    }
    if (["running", "blocked", "succeeded", "failed"].includes(runtime.status)) {
      if (!Number.isInteger(runtime.currentIteration) || runtime.currentIteration < 1 || runtime.currentIteration > runtime.maxIterations) {
        throw new Error(`Restored loop '${definition.id}' has invalid current iteration ${runtime.currentIteration}.`);
      }
      if (!runtime.iterations.some((item) => item.iteration === runtime.currentIteration)) {
        throw new Error(`Restored loop '${definition.id}' has no record for iteration ${runtime.currentIteration}.`);
      }
    }
    if (runtime.status === "blocked" && !runtime.blockedReason?.trim()) throw new Error(`Restored loop '${definition.id}' is blocked without a reason.`);

    const loopNodes = new Set(definition.nodes);
    for (const nodeId of definition.nodes) {
      const node = state.runtime.nodes[nodeId];
      if (!node) throw new Error(`Restored loop '${definition.id}' cannot find node '${nodeId}'.`);
      const attemptId = node.currentAttemptId;
      if (!attemptId) continue;
      const attempt = node.attempts[attemptId];
      if (!attempt) throw new Error(`Restored node '${nodeId}' points to missing attempt '${attemptId}'.`);
      if (active.has(node.status)) {
        if (attempt.loopId !== definition.id || attempt.iteration !== runtime.currentIteration) {
          throw new Error(`Restored active attempt '${attemptId}' does not match loop '${definition.id}' iteration ${runtime.currentIteration}.`);
        }
        if (runtime.status === "blocked") throw new Error(`Restored blocked loop '${definition.id}' still has active attempt '${attemptId}'.`);
      }
    }
    for (const fact of Object.values(state.runtime.facts)) {
      if (!loopNodes.has(fact.producerNodeId)) continue;
      if (fact.loopId !== definition.id || (runtime.currentIteration > 0 && fact.iteration !== runtime.currentIteration)) {
        throw new Error(`Restored fact '${fact.name}' does not match loop '${definition.id}' iteration ${runtime.currentIteration}.`);
      }
    }
  }
}

const acceptPersisted = (stored: StoredPersisted): PersistedHypagraph => {
  const snapshot = replayEvents(stored.events);
  validateRestoredLoopState(snapshot);
  if (stored.snapshot.schemaVersion === HYPAGRAPH_SCHEMA_VERSION && snapshot.snapshotHash !== stored.snapshot.snapshotHash) throw new Error("The stored Hypagraph snapshot does not match its event stream.");
  return { events: structuredClone(stored.events), snapshot };
};

const appendStoredBatch = (
  latest: PersistedHypagraph | undefined,
  batch: PersistedEventBatch,
): PersistedHypagraph => {
  const sameWorkflow = latest?.snapshot.workflowId === batch.workflowId;
  const actualSequence = sameWorkflow ? latest.snapshot.sequence : 0;
  if (actualSequence !== batch.expectedSequence) {
    throw new WorkflowSequenceConflictError(batch.workflowId, batch.expectedSequence, actualSequence);
  }
  validateEventAppend(batch);

  const events = [...(sameWorkflow ? latest.events : []), ...structuredClone(batch.events)];
  const snapshot = replayEvents(events);
  validateRestoredLoopState(snapshot);
  const storedSchemaVersion = (batch.snapshot as unknown as StoredSnapshotShape).schemaVersion;
  if (storedSchemaVersion === HYPAGRAPH_SCHEMA_VERSION && snapshot.snapshotHash !== batch.snapshot.snapshotHash) {
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
