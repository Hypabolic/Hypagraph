import type { DomainEvent, HypagraphState, PersistedHypagraph } from "../domain/model.js";
import { replayEvents } from "../domain/projection.js";

export const HYPAGRAPH_EVENT_BATCH_TYPE = "hypagraph.event-batch.v1";

export interface WorkflowEventAppend {
  workflowId: string;
  expectedSequence: number;
  events: DomainEvent[];
  snapshot: HypagraphState;
}

export interface PersistedEventBatch extends WorkflowEventAppend {
  version: 1;
}

export interface WorkflowEventStore {
  append(input: WorkflowEventAppend): Promise<void>;
}

export class WorkflowSequenceConflictError extends Error {
  constructor(
    readonly workflowId: string,
    readonly expectedSequence: number,
    readonly actualSequence: number,
  ) {
    super(`Workflow '${workflowId}' expected sequence ${expectedSequence}, but the store is at sequence ${actualSequence}.`);
    this.name = "WorkflowSequenceConflictError";
  }
}

export function validateEventAppend(input: WorkflowEventAppend): void {
  if (input.events.length === 0) throw new Error("An event-store append must contain at least one event.");
  if (input.snapshot.workflowId !== input.workflowId) throw new Error("The stored snapshot belongs to a different workflow.");

  let sequence = input.expectedSequence;
  for (const event of input.events) {
    sequence += 1;
    if (event.workflowId !== input.workflowId) throw new Error("An event batch contains an event for a different workflow.");
    if (event.sequence !== sequence) throw new Error(`The event batch expected sequence ${sequence}, but received ${event.sequence}.`);
  }

  if (input.snapshot.sequence !== sequence) {
    throw new Error(`The stored snapshot sequence ${input.snapshot.sequence} does not match the event batch sequence ${sequence}.`);
  }
}

export class InMemoryWorkflowEventStore implements WorkflowEventStore {
  private readonly streams = new Map<string, PersistedHypagraph>();

  seed(value: PersistedHypagraph): void {
    const snapshot = replayEvents(value.events);
    if (snapshot.snapshotHash !== value.snapshot.snapshotHash) throw new Error("The seed snapshot does not match its event stream.");
    this.streams.set(value.snapshot.workflowId, { events: structuredClone(value.events), snapshot });
  }

  async append(input: WorkflowEventAppend): Promise<void> {
    validateEventAppend(input);
    const current = this.streams.get(input.workflowId);
    const actualSequence = current?.snapshot.sequence ?? 0;
    if (actualSequence !== input.expectedSequence) {
      throw new WorkflowSequenceConflictError(input.workflowId, input.expectedSequence, actualSequence);
    }

    const events = [...(current?.events ?? []), ...structuredClone(input.events)];
    const snapshot = replayEvents(events);
    if (snapshot.snapshotHash !== input.snapshot.snapshotHash) throw new Error("The appended snapshot does not match the stored event stream.");
    this.streams.set(input.workflowId, { events, snapshot });
  }

  read(workflowId: string): PersistedHypagraph | undefined {
    const value = this.streams.get(workflowId);
    return value ? { events: structuredClone(value.events), snapshot: structuredClone(value.snapshot) } : undefined;
  }
}
