/**
 * S4: worker pool and true multi-model fan-out.
 *
 * Proves host-path concurrency under policy:
 * - pool admits two model workers under globalConcurrency 2;
 * - extension batch path no longer uses modelSlots = 1;
 * - concurrent registration and independent settle free one seat only;
 * - deferred-interrupt-for-one-seat language is gone from the product path.
 *
 * Does not earn ledger Live. Automated host substitute only.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_CONCURRENCY } from "../src/domain/concurrency-limits.js";
import {
  GOAL_FAMILY_SCHEMA_VERSION,
  addFamilyMember,
  createRootFamily,
  listPendingDispatches,
  pendingDispatchCount,
  type GoalFamilyRuntime,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import {
  commitConcurrentFamilyBatchForHost,
  markFamilyPendingDispatchedForHost,
  settleFamilyPendingForHost,
} from "../src/pi/family-controller-host.js";
import {
  resolveFamilyProductConcurrencyPolicy,
  selectFamilyProductControllerAction,
} from "../src/pi/family-product-dispatch.js";
import {
  applyMemberStreamAndPendingSettle,
  countFamilyPendings,
  simulateConcurrentLockedBagReloads,
  simulateConcurrentMemberSettles,
} from "../src/pi/family-concurrent-bag.js";
import {
  runIsolatedWithFreeSlotProtocol,
  traceConcurrentIsolatedFreeSlotProtocol,
} from "../src/pi/isolated-free-slot-protocol.js";
import {
  canAdmitIsolatedWorker,
  countUnsettledIsolatedWorkers,
  createIsolatedWorkerPool,
  deleteIsolatedWorkerForAttempt,
  findIsolatedWorkerByFamilyDispatchId,
  listUnsettledIsolatedWorkers,
  registerIsolatedWorker,
  type ActiveIsolatedRootAttempt,
} from "../src/pi/isolated-root-dispatch.js";
import { createSessionContext } from "../src/pi/session-context.js";
import { DEFAULT_MODEL_EXECUTOR_PROFILE } from "../src/domain/model-executor-profile.js";
import type { PersistedGoalFamily } from "../src/persistence/family-store.js";

const at = "2026-08-05T12:00:00.000Z";
const later = "2026-08-05T12:05:00.000Z";
const dispatchedAt = "2026-08-05T12:06:00.000Z";
const repoRoot = resolve(import.meta.dirname, "..");

const singleTask = (title: string): HypagraphDefinition => ({
  title,
  goal: title,
  nodes: [{
    id: "work",
    title: "Work",
    requires: [],
    acceptance: [],
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const createMemberWorkflow = (
  definition: HypagraphDefinition,
  workflowId: string,
  goalId: string,
): HypagraphState => {
  const result = createHypagoalWorkflow(definition, {
    workflowId,
    goalId,
    goalWorkflowId: workflowId,
    at,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const pauseMember = (state: HypagraphState, reason: string): HypagraphState => {
  const paused: HypagraphState = structuredClone(state);
  paused.goal = {
    ...paused.goal!,
    status: "paused",
    stopReason: reason,
  };
  paused.phase = "paused";
  return paused;
};

const createTwoChildReadyFamily = (familyId: string) => {
  const root = createRootFamily({
    familyId,
    rootGoalId: "goal-root",
    rootWorkflowId: "workflow-root",
    at,
  });
  if (!root.ok) throw new Error(JSON.stringify(root.diagnostics));
  const childA = addFamilyMember({
    family: root.family,
    goalId: "goal-child-a",
    workflowId: "workflow-child-a",
    parent: {
      parentGoalId: "goal-root",
      parentWorkflowId: "workflow-root",
      parentNodeId: "work",
    },
    at: later,
  });
  if (!childA.ok) throw new Error(JSON.stringify(childA.diagnostics));
  const childB = addFamilyMember({
    family: childA.family,
    goalId: "goal-child-b",
    workflowId: "workflow-child-b",
    parent: {
      parentGoalId: "goal-root",
      parentWorkflowId: "workflow-root",
      parentNodeId: "work",
    },
    at: later,
  });
  if (!childB.ok) throw new Error(JSON.stringify(childB.diagnostics));
  const rootState = pauseMember(
    createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root"),
    "Pause root for multi-child concurrent batch.",
  );
  const childAState = createMemberWorkflow(
    singleTask("Child A work"),
    "workflow-child-a",
    "goal-child-a",
  );
  const childBState = createMemberWorkflow(
    singleTask("Child B work"),
    "workflow-child-b",
    "goal-child-b",
  );
  const memberStates = {
    "goal-root": rootState,
    "goal-child-a": childAState,
    "goal-child-b": childBState,
  };
  return {
    family: childB.family as GoalFamilyRuntime,
    rootState,
    memberStates,
  };
};

const toPersisted = (
  family: GoalFamilyRuntime,
  memberStates: Record<string, HypagraphState>,
): PersistedGoalFamily => ({
  schemaVersion: family.schemaVersion,
  familyEvents: [],
  familySnapshot: family,
  workflows: Object.fromEntries(
    Object.entries(memberStates).map(([, snapshot]) => [
      snapshot.workflowId,
      { events: [], snapshot },
    ]),
  ),
});

const makePoolAttempt = (input: {
  attemptId: string;
  familyDispatchId: string;
  nodeId: string;
  goalId: string;
  workflowId: string;
}): ActiveIsolatedRootAttempt => ({
  operationId: `op-${input.attemptId}`,
  nodeId: input.nodeId,
  attemptId: input.attemptId,
  goalId: input.goalId,
  workflowId: input.workflowId,
  familyDispatchId: input.familyDispatchId,
  profile: DEFAULT_MODEL_EXECUTOR_PROFILE,
  actionKind: "start-ready-task",
  sessionGeneration: 0,
  branchGeneration: 0,
  settled: false,
  abortController: new AbortController(),
  startedAt: at,
  timeoutMs: 60_000,
});

/**
 * Host batch admit algorithm (S4): free seats = globalConcurrency - unsettled.
 * Deterministic always startable; model items consume free seats.
 */
const partitionBatchForStart = <T extends { decision: { kind: string } }>(
  items: readonly T[],
  poolUnsettled: number,
  globalConcurrency: number,
  isDeterministic: (item: T) => boolean,
): { startable: T[]; deferred: T[] } => {
  let modelSeatsFree = Math.max(0, globalConcurrency - poolUnsettled);
  const startable: T[] = [];
  const deferred: T[] = [];
  for (const item of items) {
    if (isDeterministic(item)) {
      startable.push(item);
      continue;
    }
    if (modelSeatsFree > 0) {
      startable.push(item);
      modelSeatsFree -= 1;
    } else {
      deferred.push(item);
    }
  }
  return { startable, deferred };
};

describe("S4 worker pool and concurrent fan-out", () => {
  it("session context owns an empty worker pool Map by default", () => {
    const session = createSessionContext();
    expect(session.workerPool).toBeInstanceOf(Map);
    expect(session.workerPool.size).toBe(0);
    expect(DEFAULT_GLOBAL_CONCURRENCY).toBe(2);
  });

  it("extension batch path no longer hard-codes modelSlots = 1 or one-seat interrupt", () => {
    const extensionSource = readFileSync(resolve(repoRoot, "src/extension.ts"), "utf8");
    expect(extensionSource).not.toMatch(/modelSlots\s*=\s*modelCapacityFree\s*\?\s*1\s*:\s*0/);
    expect(extensionSource).not.toMatch(/Host model capacity is one isolated attempt/);
    expect(extensionSource).not.toMatch(/Host isolated worker pool has no free seat/);
    expect(extensionSource).toMatch(/resolvedGlobalConcurrency/);
    expect(extensionSource).toMatch(/Promise\.all\(modelWork\)/);
    expect(extensionSource).toMatch(/countUnsettledIsolatedWorkers/);
    expect(extensionSource).toMatch(/registerIsolatedWorker/);
    expect(extensionSource).toMatch(/runIsolatedWithFreeSlotProtocol/);
    expect(extensionSource).toMatch(/itemsToCommit/);
    expect(extensionSource).toMatch(/isolatedFamilyPersistedWorkflowIds/);
    expect(extensionSource).toMatch(/applyMemberStreamAndPendingSettle/);
    expect(extensionSource).toMatch(/deferChildReturn:\s*true/);
    expect(extensionSource).toMatch(/One child-return pass after all concurrent model workers finish/);
    // Residual persist holds free-slot lock for full merge (Issue 10).
    expect(extensionSource).toMatch(/Full residual merge \+ append \+ remember under free-slot lock/);
    // Isolated path routes without outer free-slot bind spanning the await.
    expect(extensionSource).toMatch(/Isolated worker path: route against MemberContext without an outer free-slot/);
    // Non-isolated bind holds free-slot lock across awaits (current-session + isolated race).
    expect(extensionSource).toMatch(/Hold free-slot lock for the entire non-isolated bind/);
    expect(extensionSource).toMatch(/Free-slot identity guard: after await, free slots must still be this member/);
    // No leave-selected-without-start residual path.
    expect(extensionSource).not.toMatch(/deferredSelectedModelItems/);
    // Single-slot variable must not remain.
    expect(extensionSource).not.toMatch(/let activeIsolatedRootAttempt/);
  });

  it("admits two model family members under default globalConcurrency without deferred interrupt", () => {
    const { family, rootState, memberStates } = createTwoChildReadyFamily("family-s4-two");
    expect(family.schemaVersion).toBe(GOAL_FAMILY_SCHEMA_VERSION);

    const policy = resolveFamilyProductConcurrencyPolicy(undefined);
    expect(policy.globalConcurrency).toBe(2);
    expect(policy.concurrent).toBe(true);

    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;
    expect(selection.items).toHaveLength(2);
    expect(selection.items.every((item) => item.decision.kind === "start-ready-task")).toBe(true);

    const pool = createIsolatedWorkerPool();
    const partitioned = partitionBatchForStart(
      selection.items,
      countUnsettledIsolatedWorkers(pool),
      selection.concurrencyPolicy.globalConcurrency,
      () => false,
    );
    // Both model members start; no deferred interrupt for one seat.
    expect(partitioned.startable).toHaveLength(2);
    expect(partitioned.deferred).toHaveLength(0);

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      resolvedConcurrencyPolicy: selection.concurrencyPolicy,
      createDispatchId: (index, item) => `s4-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(pendingDispatchCount(committed.family)).toBe(2);

    // Simulate concurrent host registration of both workers after mark.
    let familyAfterMark = committed.family;
    for (const item of committed.items) {
      const memberState = memberStates[item.memberGoalId as keyof typeof memberStates];
      if (!memberState) throw new Error(`missing memberState for ${item.memberGoalId}`);
      const marked = markFamilyPendingDispatchedForHost({
        family: familyAfterMark,
        dispatchId: item.dispatchId,
        at: dispatchedAt,
        memberState,
      });
      expect(marked.ok).toBe(true);
      if (!marked.ok) return;
      familyAfterMark = marked.family;
      registerIsolatedWorker(pool, makePoolAttempt({
        attemptId: `attempt-${item.memberGoalId}`,
        familyDispatchId: item.dispatchId,
        nodeId: "work",
        goalId: item.memberGoalId,
        workflowId: item.memberWorkflowId,
      }));
    }

    expect(countUnsettledIsolatedWorkers(pool)).toBe(2);
    expect(listUnsettledIsolatedWorkers(pool).map((w) => w.goalId).sort()).toEqual([
      "goal-child-a",
      "goal-child-b",
    ]);
    expect(canAdmitIsolatedWorker(pool, 2)).toBe(false);
    expect(
      listPendingDispatches(familyAfterMark).every((p) => p.status === "dispatched"),
    ).toBe(true);

    // Independent settle of first worker leaves second in flight.
    const firstId = committed.items[0]!.dispatchId;
    const secondId = committed.items[1]!.dispatchId;
    const firstWorker = findIsolatedWorkerByFamilyDispatchId(pool, firstId)!;
    firstWorker.settled = true;
    deleteIsolatedWorkerForAttempt(pool, firstWorker);

    const settledFirst = settleFamilyPendingForHost({
      family: familyAfterMark,
      dispatchId: firstId,
      at: "2026-08-05T12:10:00.000Z",
      outcome: "completed",
      partialFailureMode: "independent-settle",
    });
    expect(settledFirst.ok).toBe(true);
    if (!settledFirst.ok) return;
    expect(settledFirst.family.pendingDispatches[secondId]?.status).toBe("dispatched");
    expect(countUnsettledIsolatedWorkers(pool)).toBe(1);
    expect(canAdmitIsolatedWorker(pool, 2)).toBe(true);
  });

  it("limits commit to free pool seats (no leave-selected without start)", () => {
    const pool = createIsolatedWorkerPool();
    registerIsolatedWorker(pool, makePoolAttempt({
      attemptId: "existing-1",
      familyDispatchId: "existing-d1",
      nodeId: "work",
      goalId: "goal-existing-1",
      workflowId: "wf-existing-1",
    }));
    registerIsolatedWorker(pool, makePoolAttempt({
      attemptId: "existing-2",
      familyDispatchId: "existing-d2",
      nodeId: "work",
      goalId: "goal-existing-2",
      workflowId: "wf-existing-2",
    }));
    expect(countUnsettledIsolatedWorkers(pool)).toBe(2);

    const fakeItems = [
      { decision: { kind: "start-ready-task" }, memberGoalId: "goal-new-a" },
      { decision: { kind: "start-ready-task" }, memberGoalId: "goal-new-b" },
    ];
    // Host filters before commit: free seats 0 → commit nothing (Issue 8).
    const partitioned = partitionBatchForStart(
      fakeItems,
      countUnsettledIsolatedWorkers(pool),
      2,
      () => false,
    );
    expect(partitioned.startable).toHaveLength(0);
    expect(partitioned.deferred).toHaveLength(2);
  });

  it("proves two pool entries can be in flight at the same time (concurrent occupancy)", async () => {
    const pool = createIsolatedWorkerPool();
    let concurrentPeak = 0;
    const hold = new Map<string, () => void>();

    const startWorker = async (id: string, dispatchId: string) => {
      registerIsolatedWorker(pool, makePoolAttempt({
        attemptId: id,
        familyDispatchId: dispatchId,
        nodeId: "work",
        goalId: `goal-${id}`,
        workflowId: `wf-${id}`,
      }));
      concurrentPeak = Math.max(concurrentPeak, countUnsettledIsolatedWorkers(pool));
      await new Promise<void>((resolve) => {
        hold.set(id, resolve);
      });
      const entry = findIsolatedWorkerByFamilyDispatchId(pool, dispatchId)!;
      entry.settled = true;
      deleteIsolatedWorkerForAttempt(pool, entry);
    };

    const runA = startWorker("attempt-a", "dispatch-a");
    const runB = startWorker("attempt-b", "dispatch-b");
    // Yield so both register before either settles.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(countUnsettledIsolatedWorkers(pool)).toBe(2);
    expect(concurrentPeak).toBe(2);

    hold.get("attempt-a")?.();
    await runA;
    expect(countUnsettledIsolatedWorkers(pool)).toBe(1);

    hold.get("attempt-b")?.();
    await runB;
    expect(countUnsettledIsolatedWorkers(pool)).toBe(0);
  });

  it("free-slot protocol: concurrent awaits hold no free slots; member streams stay uncorrupted", async () => {
    // Thin extract of extension start/settle algorithm (isolated-free-slot-protocol).
    const traced = await traceConcurrentIsolatedFreeSlotProtocol({ workerHoldMs: 20 });
    expect(traced.bothCompleted).toBe(true);
    expect(traced.peakConcurrentAwaits).toBe(2);
    // No await phase may observe free slots bound to the worker.
    const awaitTraces = traced.traces.filter((t) => t.phase === "await");
    expect(awaitTraces.length).toBeGreaterThanOrEqual(2);
    expect(awaitTraces.every((t) => t.freeSlotsBound === false)).toBe(true);
    expect(awaitTraces.every((t) => t.lockHeld === false)).toBe(true);
    expect(traced.awaitOverlapBoundCount).toBe(0);
    // Start and settle must hold free slots under lock.
    const startTraces = traced.traces.filter((t) => t.phase === "start");
    const settleTraces = traced.traces.filter((t) => t.phase === "settle");
    expect(startTraces.every((t) => t.freeSlotsBound && t.lockHeld)).toBe(true);
    expect(settleTraces.every((t) => t.freeSlotsBound && t.lockHeld)).toBe(true);
  });

  it("free-slot protocol with two member streams: free root identity and independent settle", async () => {
    // Simulate free host root + two child member contexts (extension free-slot shape).
    type Stream = { workflowId: string; facts: string[] };
    let freeSlots: Stream = { workflowId: "workflow-root", facts: ["root"] };
    const memberA: Stream = { workflowId: "workflow-child-a", facts: ["a-ready"] };
    const memberB: Stream = { workflowId: "workflow-child-b", facts: ["b-ready"] };
    const pool = createIsolatedWorkerPool();
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

    const freeRootSamples: string[] = [];
    const runMember = async (member: Stream, dispatchId: string): Promise<Stream> => {
      let working = { ...member, facts: [...member.facts] };
      await runIsolatedWithFreeSlotProtocol<{ attemptId: string }, { outcome: string }>({
        withLock,
        bindFreeSlots: () => {
          const savedRoot = freeSlots;
          freeSlots = working;
          return {
            release: () => {
              // Sync member from free slots, restore root.
              working = { ...freeSlots, facts: [...freeSlots.facts] };
              freeSlots = savedRoot;
            },
          };
        },
        runStart: async () => {
          expect(freeSlots.workflowId).toBe(member.workflowId);
          freeSlots.facts.push("started");
          const attemptId = `attempt-${member.workflowId}`;
          registerIsolatedWorker(pool, makePoolAttempt({
            attemptId,
            familyDispatchId: dispatchId,
            nodeId: "work",
            goalId: `goal-${member.workflowId}`,
            workflowId: member.workflowId,
          }));
          return { attemptId };
        },
        awaitWorker: async (started) => {
          // Free slots must be desk root while both workers await.
          freeRootSamples.push(freeSlots.workflowId);
          expect(freeSlots.workflowId).toBe("workflow-root");
          expect(countUnsettledIsolatedWorkers(pool)).toBeGreaterThanOrEqual(1);
          await new Promise((resolve) => setTimeout(resolve, 15));
          return { outcome: `done-${started.attemptId}` };
        },
        runSettle: async (started) => {
          expect(freeSlots.workflowId).toBe(member.workflowId);
          freeSlots.facts.push("settled");
          const entry = findIsolatedWorkerByFamilyDispatchId(pool, dispatchId);
          if (entry) {
            entry.settled = true;
            deleteIsolatedWorkerForAttempt(pool, entry);
          }
          void started;
          return true;
        },
      });
      return working;
    };

    const [doneA, doneB] = await Promise.all([
      runMember(memberA, "dispatch-a"),
      runMember(memberB, "dispatch-b"),
    ]);

    // Free root was visible during concurrent awaits (at least once per worker).
    expect(freeRootSamples.every((id) => id === "workflow-root")).toBe(true);
    expect(freeRootSamples.length).toBeGreaterThanOrEqual(2);
    // Free slots restored to root after both settle.
    expect(freeSlots.workflowId).toBe("workflow-root");
    expect(freeSlots.facts).toEqual(["root"]);
    // Each member stream received its own start+settle facts; no cross-write.
    expect(doneA.facts).toEqual(["a-ready", "started", "settled"]);
    expect(doneB.facts).toEqual(["b-ready", "started", "settled"]);
    expect(countUnsettledIsolatedWorkers(pool)).toBe(0);
  });

  it("concurrent member stream + pending settle keeps both workflows and clears both pendings", async () => {
    // S4 Issues 6–7: locked reload + merge-only-this-workflow + pending settle.
    const { family, rootState, memberStates } = createTwoChildReadyFamily("family-s4-bag");
    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      resolvedConcurrencyPolicy: selection.concurrencyPolicy,
      createDispatchId: (index, item) => `s4-bag-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    let familyMarked = committed.family;
    for (const item of committed.items) {
      const memberState = memberStates[item.memberGoalId as keyof typeof memberStates];
      if (!memberState) throw new Error(`missing ${item.memberGoalId}`);
      const marked = markFamilyPendingDispatchedForHost({
        family: familyMarked,
        dispatchId: item.dispatchId,
        at: dispatchedAt,
        memberState,
      });
      expect(marked.ok).toBe(true);
      if (!marked.ok) return;
      familyMarked = marked.family;
    }
    expect(listPendingDispatches(familyMarked)).toHaveLength(2);

    const itemA = committed.items.find((i) => i.memberGoalId === "goal-child-a")!;
    const itemB = committed.items.find((i) => i.memberGoalId === "goal-child-b")!;
    const snapA = structuredClone(memberStates["goal-child-a"]!);
    const snapB = structuredClone(memberStates["goal-child-b"]!);
    // Distinct post-settle facts so clobber is detectable.
    (snapA as { sequence: number }).sequence = 99;
    (snapB as { sequence: number }).sequence = 88;

    const initial: PersistedGoalFamily = {
      schemaVersion: familyMarked.schemaVersion,
      familyEvents: [],
      familySnapshot: familyMarked,
      workflows: {
        "workflow-root": {
          events: [],
          snapshot: memberStates["goal-root"]!,
        },
        "workflow-child-a": {
          events: [],
          snapshot: memberStates["goal-child-a"]!,
        },
        "workflow-child-b": {
          events: [],
          snapshot: memberStates["goal-child-b"]!,
        },
      },
    };

    const bag = await simulateConcurrentMemberSettles({
      initialFamily: initial,
      memberA: {
        workflowId: "workflow-child-a",
        dispatchId: itemA.dispatchId,
        nextSnapshot: snapA,
        nextEvents: [{ type: "s4-test-a" } as never],
      },
      memberB: {
        workflowId: "workflow-child-b",
        dispatchId: itemB.dispatchId,
        nextSnapshot: snapB,
        nextEvents: [{ type: "s4-test-b" } as never],
      },
      atA: "2026-08-05T12:20:00.000Z",
      atB: "2026-08-05T12:20:01.000Z",
      holdMs: 10,
    });

    // Both member streams keep independent post-settle identity (Issue 6).
    expect(bag.workflows["workflow-child-a"]?.snapshot.sequence).toBe(99);
    expect(bag.workflows["workflow-child-b"]?.snapshot.sequence).toBe(88);
    expect(bag.workflows["workflow-child-a"]?.events).toHaveLength(1);
    expect(bag.workflows["workflow-child-b"]?.events).toHaveLength(1);
    // Both pendings cleared (Issue 7).
    expect(countFamilyPendings(bag)).toBe(0);
    expect(listPendingDispatches(bag.familySnapshot)).toHaveLength(0);
  });

  it("applyMemberStreamAndPendingSettle is independent-settle for one of two pendings", () => {
    const { family, rootState, memberStates } = createTwoChildReadyFamily("family-s4-one");
    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
    });
    if (selection.kind !== "dispatch-batch") return;
    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      resolvedConcurrencyPolicy: selection.concurrencyPolicy,
      createDispatchId: (index, item) => `s4-one-${item.memberGoalId}-${index}`,
    });
    if (!committed.ok) return;
    let familyMarked = committed.family;
    for (const item of committed.items) {
      const memberState = memberStates[item.memberGoalId as keyof typeof memberStates]!;
      const marked = markFamilyPendingDispatchedForHost({
        family: familyMarked,
        dispatchId: item.dispatchId,
        at: dispatchedAt,
        memberState,
      });
      if (!marked.ok) return;
      familyMarked = marked.family;
    }
    const first = committed.items[0]!;
    const second = committed.items[1]!;
    const persisted: PersistedGoalFamily = {
      schemaVersion: familyMarked.schemaVersion,
      familyEvents: [],
      familySnapshot: familyMarked,
      workflows: Object.fromEntries(
        Object.entries(memberStates).map(([, snap]) => [
          snap.workflowId,
          { events: [], snapshot: snap },
        ]),
      ),
    };
    const nextSnap = structuredClone(memberStates[first.memberGoalId as keyof typeof memberStates]!);
    (nextSnap as { sequence: number }).sequence = 42;
    const applied = applyMemberStreamAndPendingSettle({
      family: persisted,
      workflowId: first.memberWorkflowId,
      nextEvents: [],
      nextSnapshot: nextSnap,
      dispatchId: first.dispatchId,
      settleOutcome: "completed",
      at: "2026-08-05T12:30:00.000Z",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.family.familySnapshot.pendingDispatches[first.dispatchId]).toBeUndefined();
    expect(applied.family.familySnapshot.pendingDispatches[second.dispatchId]?.status)
      .toBe("dispatched");
    expect(applied.family.workflows[first.memberWorkflowId]?.snapshot.sequence).toBe(42);
  });

  it("concurrent locked bag reloads keep both writers (child-return / residual persist pattern)", async () => {
    // Issue 9–10 proof: reload under lock, mutate, write; both keys survive.
    const bag = await simulateConcurrentLockedBagReloads({
      initial: { root: "alive" },
      writerA: { key: "child-a-return", value: "applied-a" },
      writerB: { key: "child-b-return", value: "applied-b" },
      holdMs: 10,
    });
    expect(bag.root).toBe("alive");
    expect(bag["child-a-return"]).toBe("applied-a");
    expect(bag["child-b-return"]).toBe("applied-b");
  });

  it("current-session free-slot bind under lock cannot interleave with isolated rebind", async () => {
    // Host race that F2 hit: current-session awaits applyCommands without the free-slot
    // lock while isolated start rebinds free slots to a child events array; resume then
    // pushes root continuation onto the child stream. Protocol: hold lock for the whole
    // non-isolated bind, including awaits.
    type Stream = { workflowId: string; facts: string[] };
    let freeSlots: Stream = { workflowId: "workflow-root", facts: ["root"] };
    const child: Stream = { workflowId: "workflow-child", facts: ["child-ready"] };
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

    const currentSessionUnderLock = async (): Promise<Stream> => {
      return withLock(async () => {
        const saved = freeSlots;
        freeSlots = { workflowId: "workflow-root", facts: [...saved.facts] };
        try {
          // Simulate applyCommandsAndCommit await while still owning free slots.
          await new Promise((resolve) => setTimeout(resolve, 20));
          // After await, free slots must still be root (isolated cannot rebind).
          expect(freeSlots.workflowId).toBe("workflow-root");
          freeSlots.facts.push("root-continuation");
          return { ...freeSlots, facts: [...freeSlots.facts] };
        } finally {
          freeSlots = saved;
        }
      });
    };

    const isolatedStartUnderLock = async (): Promise<Stream> => {
      return withLock(async () => {
        const saved = freeSlots;
        freeSlots = { ...child, facts: [...child.facts] };
        try {
          freeSlots.facts.push("child-started");
          return { ...freeSlots, facts: [...freeSlots.facts] };
        } finally {
          freeSlots = saved;
        }
      });
    };

    const [rootDone, childDone] = await Promise.all([
      currentSessionUnderLock(),
      isolatedStartUnderLock(),
    ]);

    expect(rootDone.workflowId).toBe("workflow-root");
    expect(rootDone.facts).toContain("root-continuation");
    expect(rootDone.facts).not.toContain("child-started");
    expect(childDone.workflowId).toBe("workflow-child");
    expect(childDone.facts).toEqual(["child-ready", "child-started"]);
    expect(childDone.facts).not.toContain("root-continuation");
    // Desk free slots restored to root without foreign facts.
    expect(freeSlots.workflowId).toBe("workflow-root");
    expect(freeSlots.facts).toEqual(["root"]);
  });
});
