/**
 * In-memory external effect host for tests and simulated dogfood.
 * Models an external system which accepts an idempotency key and supports a read-only query.
 */

export type MemoryEffectOutcome = "success" | "failure" | "lost";

export interface MemoryEffectRecord {
  idempotencyKey: string;
  payload: unknown;
  completed: boolean;
  outcome: "success" | "failure";
  externalId: string;
  createdAt: string;
}

export interface MemoryEffectHostOptions {
  now?: () => Date;
  /**
   * Behaviour for the next apply call.
   * - success: complete and return observation
   * - failure: complete as external failure
   * - lost: apply side effect, then lose the result (caller stores indeterminate)
   */
  nextOutcome?: MemoryEffectOutcome | (() => MemoryEffectOutcome);
}

export class MemoryEffectHost {
  private readonly records = new Map<string, MemoryEffectRecord>();
  private readonly now: () => Date;
  private nextOutcome: MemoryEffectOutcome | (() => MemoryEffectOutcome);

  constructor(options: MemoryEffectHostOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.nextOutcome = options.nextOutcome ?? "success";
  }

  setNextOutcome(outcome: MemoryEffectOutcome | (() => MemoryEffectOutcome)): void {
    this.nextOutcome = outcome;
  }

  /**
   * Apply a mutating external effect.
   * A repeated call with the same idempotency key does not create a second record.
   */
  apply(input: {
    idempotencyKey: string;
    payload?: unknown;
  }): { status: "ok" | "lost" | "failed"; record?: MemoryEffectRecord; error?: string } {
    const existing = this.records.get(input.idempotencyKey);
    if (existing) {
      return { status: existing.outcome === "success" ? "ok" : "failed", record: structuredClone(existing) };
    }

    const outcome = typeof this.nextOutcome === "function" ? this.nextOutcome() : this.nextOutcome;
    const externalId = `ext-${this.records.size + 1}`;
    const record: MemoryEffectRecord = {
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? null,
      completed: outcome !== "lost",
      outcome: outcome === "failure" ? "failure" : "success",
      externalId,
      createdAt: this.now().toISOString(),
    };

    // Persist the side effect even when the result is lost.
    if (outcome === "lost") {
      this.records.set(input.idempotencyKey, {
        ...record,
        completed: true,
        outcome: "success",
      });
      return { status: "lost", error: "The host lost the effect result after the external call." };
    }

    this.records.set(input.idempotencyKey, record);
    if (outcome === "failure") {
      return { status: "failed", record: structuredClone(record), error: "The external effect failed." };
    }
    return { status: "ok", record: structuredClone(record) };
  }

  /**
   * Read-only reconciliation query.
   * Answers whether the effect with this idempotency key completed.
   */
  query(input: { idempotencyKey: string }): {
    found: boolean;
    outcome?: "success" | "failure";
    externalId?: string;
    undecidable?: boolean;
  } {
    const record = this.records.get(input.idempotencyKey);
    if (!record) {
      return { found: false };
    }
    return {
      found: true,
      outcome: record.outcome,
      externalId: record.externalId,
    };
  }

  /** Force the next query to report undecidable. */
  markUndecidable(idempotencyKey: string): void {
    this.records.delete(idempotencyKey);
    // Special marker stored under a different key is not used; tests call setQueryOverride.
  }

  clear(): void {
    this.records.clear();
  }

  list(): MemoryEffectRecord[] {
    return [...this.records.values()]
      .map((item) => structuredClone(item))
      .sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey));
  }
}
