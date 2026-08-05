/**
 * Concurrent-safe family bag merge helpers (S4).
 *
 * Host writers that settle two model members at the same time must:
 * 1. Serialize under one free-slot / family lock.
 * 2. Reload the latest family bag before each write.
 * 3. Merge only this workflow id (and optional pending settle) onto that bag.
 *
 * These pure helpers encode the merge order for tests and host use.
 */

import type { DomainEvent, HypagraphState } from "../domain/model.js";
import type { GoalFamilyRuntime } from "../domain/goal-family.js";
import {
  settleFamilyPendingForHost,
  type FamilyPendingSettleOutcome,
} from "./family-controller-host.js";
import { replaceFamilyMemberWorkflow } from "./family-product-dispatch.js";
import type { PersistedGoalFamily } from "../persistence/family-store.js";

export interface ApplyMemberStreamAndPendingSettleInput {
  /** Latest family bag (must be reloaded under the same lock as the write). */
  family: PersistedGoalFamily;
  workflowId: string;
  nextEvents: DomainEvent[];
  nextSnapshot: HypagraphState;
  /** When set, settle this family pending in the same write. */
  dispatchId?: string;
  settleOutcome?: FamilyPendingSettleOutcome;
  settleReason?: string;
  at: string;
}

export type ApplyMemberStreamAndPendingSettleResult =
  | { ok: true; family: PersistedGoalFamily }
  | { ok: false; reason: string };

/**
 * Replace one member workflow stream on the family bag.
 * Optionally settle one pending dispatch on the same snapshot.
 * Does not append to Pi session storage; the host does that after merge.
 */
export function applyMemberStreamAndPendingSettle(
  input: ApplyMemberStreamAndPendingSettleInput,
): ApplyMemberStreamAndPendingSettleResult {
  if (!input.family.workflows[input.workflowId]) {
    return {
      ok: false,
      reason: `Family bag has no workflow '${input.workflowId}'.`,
    };
  }

  let nextFamily = replaceFamilyMemberWorkflow(input.family, input.workflowId, {
    events: input.nextEvents,
    snapshot: input.nextSnapshot,
  });

  if (input.dispatchId && input.settleOutcome) {
    if (!nextFamily.familySnapshot.pendingDispatches[input.dispatchId]) {
      // Already settled by a prior locked write; keep member stream merge.
      return { ok: true, family: nextFamily };
    }
    const settled = settleFamilyPendingForHost({
      family: nextFamily.familySnapshot,
      dispatchId: input.dispatchId,
      at: input.at,
      outcome: input.settleOutcome,
      ...(input.settleReason !== undefined ? { reason: input.settleReason } : {}),
    });
    if (!settled.ok) {
      return {
        ok: false,
        reason: settled.diagnostics.map((d) => d.message).join("; "),
      };
    }
    nextFamily = {
      ...nextFamily,
      familySnapshot: settled.family,
      familyEvents: [
        ...nextFamily.familyEvents,
        ...settled.events,
      ],
    };
  }

  return { ok: true, family: nextFamily };
}

/**
 * Simulate two concurrent member settles serialized by a lock.
 * Proves last writer does not drop the first member stream or pending settle.
 */
export async function simulateConcurrentMemberSettles(input: {
  initialFamily: PersistedGoalFamily;
  memberA: {
    workflowId: string;
    dispatchId: string;
    nextSnapshot: HypagraphState;
    nextEvents: DomainEvent[];
  };
  memberB: {
    workflowId: string;
    dispatchId: string;
    nextSnapshot: HypagraphState;
    nextEvents: DomainEvent[];
  };
  atA: string;
  atB: string;
  /** Hold ms inside each settle after reload to force interleaving attempts. */
  holdMs?: number;
}): Promise<PersistedGoalFamily> {
  let bag = input.initialFamily;
  let chain: Promise<void> = Promise.resolve();
  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = chain;
    chain = previous.then(() => gate);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const settleOne = async (
    member: typeof input.memberA,
    at: string,
  ): Promise<void> => {
    await withLock(async () => {
      // Reload under lock (mirrors host latestFamilyRecord read).
      const latest = bag;
      await new Promise((resolve) => setTimeout(resolve, input.holdMs ?? 5));
      const applied = applyMemberStreamAndPendingSettle({
        family: latest,
        workflowId: member.workflowId,
        nextEvents: member.nextEvents,
        nextSnapshot: member.nextSnapshot,
        dispatchId: member.dispatchId,
        settleOutcome: "completed",
        at,
      });
      if (!applied.ok) {
        throw new Error(applied.reason);
      }
      bag = applied.family;
    });
  };

  await Promise.all([
    settleOne(input.memberA, input.atA),
    settleOne(input.memberB, input.atB),
  ]);
  return bag;
}

/** Count pending dispatches on a family snapshot. */
export function countFamilyPendings(family: GoalFamilyRuntime | PersistedGoalFamily): number {
  const snapshot = "familySnapshot" in family ? family.familySnapshot : family;
  return Object.keys(snapshot.pendingDispatches ?? {}).length;
}

/**
 * Simulate two concurrent bag writers that each reload under a lock, then merge.
 * Models product child-return and residual persist: reload latest, mutate, write.
 * Proves last writer does not drop the first writer's field when serialized.
 */
export async function simulateConcurrentLockedBagReloads(input: {
  initial: Record<string, string>;
  writerA: { key: string; value: string };
  writerB: { key: string; value: string };
  holdMs?: number;
}): Promise<Record<string, string>> {
  let bag = { ...input.initial };
  let chain: Promise<void> = Promise.resolve();
  const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = chain;
    chain = previous.then(() => gate);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const writeOne = async (writer: { key: string; value: string }): Promise<void> => {
    await withLock(async () => {
      // Reload under lock (mirrors latestFamilyRecord).
      const latest = { ...bag };
      await new Promise((resolve) => setTimeout(resolve, input.holdMs ?? 5));
      latest[writer.key] = writer.value;
      bag = latest;
    });
  };

  await Promise.all([
    writeOne(input.writerA),
    writeOne(input.writerB),
  ]);
  return bag;
}
