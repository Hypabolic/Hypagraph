import type { PersistedHypagraph } from "../domain/model.js";
import {
  HYPAGRAPH_EVENT_BATCH_TYPE,
  type PersistedEventBatch,
  type WorkflowEventAppend,
  type WorkflowEventStore,
  WorkflowSequenceConflictError,
  validateEventAppend,
} from "./event-store.js";

export interface PiSessionEntryAppender {
  appendEntry<T = unknown>(customType: string, data?: T): void;
}

export class PiSessionWorkflowEventStore implements WorkflowEventStore {
  private readonly sequences = new Map<string, number>();

  constructor(private readonly appender: PiSessionEntryAppender) {}

  synchronize(value: PersistedHypagraph | undefined): void {
    this.sequences.clear();
    if (value) this.sequences.set(value.snapshot.workflowId, value.snapshot.sequence);
  }

  async append(input: WorkflowEventAppend): Promise<void> {
    validateEventAppend(input);
    const actualSequence = this.sequences.get(input.workflowId) ?? 0;
    if (actualSequence !== input.expectedSequence) {
      throw new WorkflowSequenceConflictError(input.workflowId, input.expectedSequence, actualSequence);
    }

    const batch: PersistedEventBatch = {
      version: 1,
      workflowId: input.workflowId,
      expectedSequence: input.expectedSequence,
      events: structuredClone(input.events),
      snapshot: structuredClone(input.snapshot),
    };
    this.appender.appendEntry(HYPAGRAPH_EVENT_BATCH_TYPE, batch);
    this.sequences.set(input.workflowId, input.snapshot.sequence);
  }
}
