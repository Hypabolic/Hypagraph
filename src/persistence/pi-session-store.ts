import type { PersistedHypagraph } from "../domain/model.js";
import {
  HYPAGRAPH_EVENT_BATCH_TYPE,
  type PersistedEventBatch,
  type WorkflowEventAppend,
  type WorkflowEventStore,
  WorkflowBranchChangedError,
  WorkflowSequenceConflictError,
  validateEventAppend,
} from "./event-store.js";

export interface PiSessionEntryAppender {
  appendEntry<T = unknown>(customType: string, data?: T): void;
}

export class PiSessionWorkflowEventStore implements WorkflowEventStore {
  private readonly sequences = new Map<string, number>();
  private generation = 0;

  constructor(private readonly appender: PiSessionEntryAppender) {}

  synchronize(value: PersistedHypagraph | undefined): void {
    this.generation += 1;
    this.sequences.clear();
    if (value) this.sequences.set(value.snapshot.workflowId, value.snapshot.sequence);
  }

  /**
   * Seed or refresh one workflow sequence without clearing other members.
   * Use after family restore or before the first append for a child workflow
   * whose history lives only in the family record until product dispatch.
   */
  noteWorkflowSequence(workflowId: string, sequence: number): void {
    if (typeof workflowId !== "string" || !workflowId.trim()) {
      throw new Error("noteWorkflowSequence requires a non-empty workflow ID.");
    }
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new Error("noteWorkflowSequence requires a non-negative integer sequence.");
    }
    this.sequences.set(workflowId, sequence);
  }

  /**
   * Seed sequences for every workflow stored on a family record.
   * Does not clear an existing live root sequence when the family omits it.
   * Prefer calling after synchronize(liveRoot) so the live root stays authoritative.
   */
  noteFamilyWorkflowSequences(
    workflows: Readonly<Record<string, PersistedHypagraph>>,
  ): void {
    for (const [workflowId, stream] of Object.entries(workflows)) {
      if (!stream?.snapshot) continue;
      this.sequences.set(workflowId, stream.snapshot.sequence);
    }
  }

  knownSequence(workflowId: string): number | undefined {
    return this.sequences.get(workflowId);
  }

  lease(): WorkflowEventStore {
    const generation = this.generation;
    return {
      append: async (input) => {
        if (generation !== this.generation) throw new WorkflowBranchChangedError(input.workflowId);
        await this.append(input);
      },
    };
  }

  async append(input: WorkflowEventAppend): Promise<void> {
    const actualSequence = this.sequences.get(input.workflowId) ?? 0;
    if (actualSequence !== input.expectedSequence) {
      throw new WorkflowSequenceConflictError(input.workflowId, input.expectedSequence, actualSequence);
    }
    validateEventAppend(input);

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
