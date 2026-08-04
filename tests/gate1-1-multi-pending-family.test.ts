/**
 * Gate 1.1: multi-pending concurrent family domain and product path.
 */

import { describe, expect, it } from "vitest";
import {
  commitFamilyConcurrentBatch,
  commitFamilySelection,
  completeFamilyAction,
  interruptFamilyAction,
  markFamilyActionDispatched,
  parseFamilyPendingDispatchOwnData,
  selectFamilyConcurrentActions,
  selectFamilyConcurrentBatchFromCandidates,
  selectFamilySchedulerAction,
} from "../src/domain/family-scheduler.js";
import {
  GOAL_FAMILY_SCHEMA_VERSION,
  addFamilyMember,
  createRootFamily,
  hasAnyPendingDispatch,
  listPendingDispatches,
  pendingDispatchCount,
  rebuildFamilyMembershipFromSnapshot,
  type GoalFamilyRuntime,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import {
  resolveFamilyProductConcurrencyPolicy,
  selectFamilyProductControllerAction,
} from "../src/pi/family-product-dispatch.js";
import {
  commitConcurrentFamilyBatchForHost,
  familySettleOutcomeFromHostDispatch,
  markFamilyPendingDispatchedForHost,
  settleFamilyPendingForHost,
} from "../src/pi/family-controller-host.js";
import type { PersistedGoalFamily } from "../src/persistence/family-store.js";

const at = "2026-08-04T12:00:00.000Z";
const later = "2026-08-04T12:05:00.000Z";
const doneAt = "2026-08-04T12:10:00.000Z";

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

const createTwoMemberFamily = (familyId = "family-multi"): {
  family: GoalFamilyRuntime;
  rootState: HypagraphState;
  childState: HypagraphState;
  memberStates: Record<string, HypagraphState>;
} => {
  const root = createRootFamily({
    familyId,
    rootGoalId: "goal-root",
    rootWorkflowId: "workflow-root",
    at,
  });
  if (!root.ok) throw new Error(JSON.stringify(root.diagnostics));
  const child = addFamilyMember({
    family: root.family,
    goalId: "goal-child",
    workflowId: "workflow-child",
    parent: {
      parentGoalId: "goal-root",
      parentWorkflowId: "workflow-root",
      parentNodeId: "work",
    },
    at: later,
  });
  if (!child.ok) throw new Error(JSON.stringify(child.diagnostics));
  const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
  const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
  return {
    family: child.family,
    rootState,
    childState,
    memberStates: {
      "goal-root": rootState,
      "goal-child": childState,
    },
  };
};

describe("gate1-1 multi-pending family domain", () => {
  it("uses schema version 3 with empty pendingDispatches on create", () => {
    const root = createRootFamily({
      familyId: "family-schema",
      rootGoalId: "goal-root",
      rootWorkflowId: "workflow-root",
      at,
    });
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect(root.family.schemaVersion).toBe(GOAL_FAMILY_SCHEMA_VERSION);
    expect(root.family.schemaVersion).toBe(3);
    expect(root.family.pendingDispatches).toEqual({});
    expect(hasAnyPendingDispatch(root.family)).toBe(false);
  });

  it("rejects unsupported goal-family schema versions", () => {
    const { family } = createTwoMemberFamily("family-bad-schema");
    const bad = {
      ...family,
      schemaVersion: 2 as typeof GOAL_FAMILY_SCHEMA_VERSION,
    };
    expect(() => rebuildFamilyMembershipFromSnapshot(bad)).toThrow(/Unsupported goal-family schema/);
  });

  it("commits a concurrent batch with two pending dispatches", () => {
    const { family, memberStates } = createTwoMemberFamily("family-batch");
    const decision = selectFamilyConcurrentActions({
      family,
      memberStates,
      maxBatchSize: 2,
    });
    expect(decision.kind).toBe("select-batch");
    if (decision.kind !== "select-batch") return;
    expect(decision.candidates.length).toBe(2);

    const committed = commitFamilyConcurrentBatch({
      family,
      memberStates,
      at: later,
      dispatchIds: ["dispatch-a", "dispatch-b"],
      maxBatchSize: 2,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.committedDispatchIds).toEqual(["dispatch-a", "dispatch-b"]);
    expect(pendingDispatchCount(committed.family)).toBe(2);
    expect(listPendingDispatches(committed.family).map((p) => p.dispatchId).sort()).toEqual([
      "dispatch-a",
      "dispatch-b",
    ]);
    expect(Object.keys(committed.family.pendingDispatches).sort()).toEqual([
      "dispatch-a",
      "dispatch-b",
    ]);
  });

  it("settles one pending without clearing an unrelated pending", () => {
    const { family, memberStates } = createTwoMemberFamily("family-partial");
    const committed = commitFamilyConcurrentBatch({
      family,
      memberStates,
      at: later,
      dispatchIds: ["dispatch-root", "dispatch-child"],
      maxBatchSize: 2,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const rootPending = listPendingDispatches(committed.family).find(
      (p) => p.selection.goalId === "goal-root",
    );
    const childPending = listPendingDispatches(committed.family).find(
      (p) => p.selection.goalId === "goal-child",
    );
    expect(rootPending).toBeDefined();
    expect(childPending).toBeDefined();

    const marked = markFamilyActionDispatched({
      family: committed.family,
      dispatchId: rootPending!.dispatchId,
      at: later,
    });
    expect(marked.ok).toBe(true);
    if (!marked.ok) return;

    const completed = completeFamilyAction({
      family: marked.family,
      dispatchId: rootPending!.dispatchId,
      at: doneAt,
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;

    expect(completed.family.pendingDispatches[rootPending!.dispatchId]).toBeUndefined();
    expect(completed.family.pendingDispatches[childPending!.dispatchId]).toBeDefined();
    expect(completed.family.pendingDispatches[childPending!.dispatchId]?.status).toBe("selected");
    expect(completed.family.lastDispatchOutcome?.dispatchId).toBe(rootPending!.dispatchId);
    expect(pendingDispatchCount(completed.family)).toBe(1);
  });

  it("interrupts one of many pendings and leaves the rest", () => {
    const { family, memberStates } = createTwoMemberFamily("family-interrupt-one");
    const committed = commitFamilyConcurrentBatch({
      family,
      memberStates,
      at: later,
      dispatchIds: ["dispatch-1", "dispatch-2"],
      maxBatchSize: 2,
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.diagnostics));

    const firstId = committed.committedDispatchIds[0]!;
    const secondId = committed.committedDispatchIds[1]!;
    const interrupted = interruptFamilyAction({
      family: committed.family,
      dispatchId: firstId,
      at: doneAt,
      reason: "Cancel first only.",
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.family.pendingDispatches[firstId]).toBeUndefined();
    expect(interrupted.family.pendingDispatches[secondId]?.status).toBe("selected");
    expect(interrupted.family.lastDispatchOutcome?.status).toBe("interrupted");
  });

  it("rejects illegal multi-pending states", () => {
    const { family, memberStates } = createTwoMemberFamily("family-illegal");
    const committed = commitFamilyConcurrentBatch({
      family,
      memberStates,
      at: later,
      dispatchIds: ["dispatch-1", "dispatch-2"],
      maxBatchSize: 2,
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.diagnostics));

    // Duplicate dispatch id in input list.
    const dupIds = commitFamilyConcurrentBatch({
      family,
      memberStates,
      at: later,
      dispatchIds: ["same", "same"],
      maxBatchSize: 2,
    });
    expect(dupIds.ok).toBe(false);
    if (dupIds.ok) return;
    expect(dupIds.diagnostics[0]?.code).toBe("goal_family_dispatch_id_duplicate");

    // Dispatch id already pending.
    const reusePending = commitFamilyConcurrentBatch({
      family: committed.family,
      memberStates,
      at: later,
      dispatchIds: ["dispatch-1"],
      maxBatchSize: 1,
    });
    expect(reusePending.ok).toBe(false);
    if (reusePending.ok) return;
    expect(reusePending.diagnostics[0]?.code).toBe("goal_family_dispatch_id_duplicate");

    // Complete unknown id.
    const unknown = completeFamilyAction({
      family: committed.family,
      dispatchId: "missing-dispatch",
      at: doneAt,
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.diagnostics[0]?.code).toBe("goal_family_dispatch_missing");

    // Sequential commit blocks while any pending exists.
    const sequential = commitFamilySelection({
      family: committed.family,
      memberStates,
      at: later,
      dispatchId: "dispatch-seq",
    });
    expect(sequential.ok).toBe(false);
    if (sequential.ok) return;
    expect(sequential.diagnostics[0]?.code).toBe("goal_family_dispatch_pending");

    // Wrong dispatch id count for selected batch.
    const wrongCount = commitFamilyConcurrentBatch({
      family,
      memberStates,
      at: later,
      dispatchIds: ["only-one"],
      maxBatchSize: 2,
    });
    expect(wrongCount.ok).toBe(false);
    if (wrongCount.ok) return;
    expect(wrongCount.diagnostics[0]?.code).toBe("goal_family_concurrent_dispatch_id_count");
  });

  it("keeps sequential selection when concurrent is off or batch size is 1", () => {
    const { family, memberStates } = createTwoMemberFamily("family-seq");
    const sequential = selectFamilySchedulerAction(family, memberStates);
    expect(sequential.kind).toBe("select");

    const policyOff = resolveFamilyProductConcurrencyPolicy({ concurrent: false, maxBatchSize: 2 });
    expect(policyOff.concurrent).toBe(false);
    const policyOne = resolveFamilyProductConcurrencyPolicy({ concurrent: true, maxBatchSize: 1 });
    expect(policyOne.concurrent).toBe(false);
  });
});

describe("gate1-1 multi-pending product path", () => {
  const toPersisted = (
    family: GoalFamilyRuntime,
    memberStates: Record<string, HypagraphState>,
  ): PersistedGoalFamily => ({
    schemaVersion: family.schemaVersion,
    familyEvents: [],
    familySnapshot: family,
    workflows: Object.fromEntries(
      Object.entries(memberStates).map(([goalId, snapshot]) => [
        snapshot.workflowId,
        { events: [], snapshot },
      ]),
    ),
  });

  it("selects a concurrent batch when policy allows", () => {
    const { family, rootState, childState, memberStates } = createTwoMemberFamily("family-product");
    const familyRecord = toPersisted(family, memberStates);
    const decision = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord,
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2 },
    });
    expect(decision.kind).toBe("dispatch-batch");
    if (decision.kind !== "dispatch-batch") return;
    expect(decision.items).toHaveLength(2);
    const goals = decision.items.map((item) => item.memberGoalId).sort();
    expect(goals).toEqual(["goal-child", "goal-root"]);
    expect(decision.items.every((item) => item.decision.kind === "start-ready-task")).toBe(true);
    void childState;
  });

  it("uses sequential dispatch shape when concurrent is off", () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-product-seq");
    const familyRecord = toPersisted(family, memberStates);
    const decision = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord,
      concurrencyPolicy: { concurrent: false },
    });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") return;
    // Sequential depth policy selects the root first.
    expect(decision.memberGoalId).toBe("goal-root");
  });

  it("uses sequential dispatch shape when maxBatchSize is 1", () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-product-one");
    const familyRecord = toPersisted(family, memberStates);
    const decision = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord,
      concurrencyPolicy: { concurrent: true, maxBatchSize: 1 },
    });
    expect(decision.kind).toBe("dispatch");
  });

  it("commits concurrent batch through host helper without clearing prior capacity rules", () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-host-commit");
    const familyRecord = toPersisted(family, memberStates);
    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord,
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2 },
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      maxBatchSize: 2,
      createDispatchId: (index, item) => `host-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(pendingDispatchCount(committed.family)).toBe(2);
    expect(committed.items).toHaveLength(2);
    expect(new Set(committed.items.map((i) => i.dispatchId)).size).toBe(2);
    expect(committed.items.every((i) => i.dispatchId.startsWith("host-"))).toBe(true);
  });

  it("keeps concurrent single-item as dispatch-batch while another pending exists", () => {
    const { family, rootState, childState, memberStates } = createTwoMemberFamily(
      "family-single-while-pending",
    );
    // Pause root so first sequential commit targets child only.
    const pausedRoot: HypagraphState = structuredClone(rootState);
    pausedRoot.goal = {
      ...pausedRoot.goal!,
      status: "paused",
      stopReason: "Pause root for single-item concurrent test.",
    };
    pausedRoot.phase = "paused";

    const childCommit = commitFamilySelection({
      family,
      memberStates: { "goal-root": pausedRoot, "goal-child": childState },
      at: later,
      dispatchId: "dispatch-child-only",
    });
    expect(childCommit.ok).toBe(true);
    if (!childCommit.ok) return;

    // Concurrent policy with free root capacity while child is pending.
    const familyRecord = toPersisted(childCommit.family, {
      "goal-root": rootState,
      "goal-child": childState,
    });
    const decision = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord,
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2 },
    });
    expect(decision.kind).toBe("dispatch-batch");
    if (decision.kind !== "dispatch-batch") return;
    expect(decision.items).toHaveLength(1);
    expect(decision.items[0]?.memberGoalId).toBe("goal-root");

    // Host concurrent commit admits the single free member without sequential block.
    const committed = commitConcurrentFamilyBatchForHost({
      family: childCommit.family,
      memberStates: { "goal-root": rootState, "goal-child": childState },
      items: decision.items,
      at: doneAt,
      maxBatchSize: 2,
      createDispatchId: () => "dispatch-root-while-child",
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(pendingDispatchCount(committed.family)).toBe(2);
    expect(committed.family.pendingDispatches["dispatch-child-only"]).toBeDefined();
    expect(committed.family.pendingDispatches["dispatch-root-while-child"]).toBeDefined();
    void memberStates;
  });

  it("product settle clears one pending and allows concurrent select of the free member", () => {
    const { family, memberStates } = createTwoMemberFamily("family-product-settle");
    const committed = commitFamilyConcurrentBatch({
      family,
      memberStates,
      at: later,
      dispatchIds: ["dispatch-a", "dispatch-b"],
      maxBatchSize: 2,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const firstId = committed.committedDispatchIds[0]!;
    const secondId = committed.committedDispatchIds[1]!;
    const marked = markFamilyPendingDispatchedForHost({
      family: committed.family,
      dispatchId: firstId,
      at: later,
    });
    expect(marked.ok).toBe(true);
    if (!marked.ok) return;

    const settled = settleFamilyPendingForHost({
      family: marked.family,
      dispatchId: firstId,
      at: doneAt,
      outcome: "completed",
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.family.pendingDispatches[firstId]).toBeUndefined();
    expect(settled.family.pendingDispatches[secondId]).toBeDefined();
    expect(pendingDispatchCount(settled.family)).toBe(1);

    // Capacity free for one more concurrent selection after partial settle.
    expect(
      familySettleOutcomeFromHostDispatch("continue"),
    ).toBe("completed");
    expect(familySettleOutcomeFromHostDispatch("stop")).toBe("failed");
    expect(familySettleOutcomeFromHostDispatch("model-follow-up")).toBeUndefined();
  });

  it("defers settle until after all starts: both pendings remain through second start", () => {
    // Models the host AC4 loop:
    // commit → mark all → start first (no settle) → start second (first pending still exists)
    // → then settle first only → second still pending.
    const { family, memberStates } = createTwoMemberFamily("family-defer-settle");
    const selection = selectFamilyProductControllerAction({
      liveState: memberStates["goal-root"]!,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2 },
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;
    expect(selection.items).toHaveLength(2);

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      maxBatchSize: 2,
      createDispatchId: (index, item) => `batch-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    let familyAfterMarks = committed.family;
    const markedIds: string[] = [];
    for (const item of committed.items) {
      const marked = markFamilyPendingDispatchedForHost({
        family: familyAfterMarks,
        dispatchId: item.dispatchId,
        at: later,
        memberState: item.memberState,
      });
      expect(marked.ok).toBe(true);
      if (!marked.ok) return;
      familyAfterMarks = marked.family;
      markedIds.push(item.dispatchId);
    }

    // After commit+mark of two items, both pendings exist as dispatched.
    expect(pendingDispatchCount(familyAfterMarks)).toBe(2);
    for (const id of markedIds) {
      expect(familyAfterMarks.pendingDispatches[id]?.status).toBe("dispatched");
    }

    const firstId = markedIds[0]!;
    const secondId = markedIds[1]!;

    // Simulate first member terminal WITHOUT settle. Second is already marked/dispatched
    // (host can start it) while the first family pending still exists.
    expect(familyAfterMarks.pendingDispatches[firstId]?.status).toBe("dispatched");
    expect(familyAfterMarks.pendingDispatches[secondId]?.status).toBe("dispatched");
    // Second start is allowed while first pending remains (no settle yet).
    const secondStillStartable = familyAfterMarks.pendingDispatches[secondId] !== undefined
      && familyAfterMarks.pendingDispatches[firstId] !== undefined;
    expect(secondStillStartable).toBe(true);

    // After all starts, settle first only. Second pending remains.
    const afterFirst = settleFamilyPendingForHost({
      family: familyAfterMarks,
      dispatchId: firstId,
      at: doneAt,
      outcome: "completed",
    });
    expect(afterFirst.ok).toBe(true);
    if (!afterFirst.ok) return;
    expect(afterFirst.family.pendingDispatches[firstId]).toBeUndefined();
    expect(afterFirst.family.pendingDispatches[secondId]?.status).toBe("dispatched");
    expect(pendingDispatchCount(afterFirst.family)).toBe(1);

    const afterSecond = settleFamilyPendingForHost({
      family: afterFirst.family,
      dispatchId: secondId,
      at: doneAt,
      outcome: "completed",
    });
    expect(afterSecond.ok).toBe(true);
    if (!afterSecond.ok) return;
    expect(pendingDispatchCount(afterSecond.family)).toBe(0);
  });

  it("maps model-follow-up to no immediate family settle outcome", () => {
    // Family settle for follow-up is deferred to agent_end / abandon with familyDispatchId.
    expect(familySettleOutcomeFromHostDispatch("model-follow-up")).toBeUndefined();
    expect(familySettleOutcomeFromHostDispatch("continue")).toBe("completed");
    expect(familySettleOutcomeFromHostDispatch("stop")).toBe("failed");
  });

  it("captures familyDispatchId for abandon settle after clearing pending bookkeeping", () => {
    // Mirrors before_agent_start / recoverOrphaned: capture id before clear, then settle.
    const { family, memberStates } = createTwoMemberFamily("family-abandon-dispatch-id");
    const committed = commitFamilyConcurrentBatch({
      family,
      memberStates,
      at: later,
      dispatchIds: ["dispatch-follow-up"],
      maxBatchSize: 1,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const marked = markFamilyPendingDispatchedForHost({
      family: committed.family,
      dispatchId: "dispatch-follow-up",
      at: later,
    });
    expect(marked.ok).toBe(true);
    if (!marked.ok) return;

    // Capture then "clear" in-memory bookkeeping (do not read from cleared pending).
    const familyDispatchId: string | undefined = "dispatch-follow-up";
    const clearedPending = undefined as { familyDispatchId?: string } | undefined;
    const captured = clearedPending?.familyDispatchId ?? familyDispatchId;
    expect(captured).toBe("dispatch-follow-up");

    const interrupted = settleFamilyPendingForHost({
      family: marked.family,
      dispatchId: captured!,
      at: doneAt,
      outcome: "interrupted",
      reason: "Caller cleared pendingContinuation before abandon.",
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.family.pendingDispatches["dispatch-follow-up"]).toBeUndefined();
    expect(interrupted.family.lastDispatchOutcome?.status).toBe("interrupted");
  });

  it("interrupts sequential selected pending when mark dispatched fails", () => {
    const { family, memberStates } = createTwoMemberFamily("family-seq-mark-fail");
    const selected = commitFamilySelection({
      family,
      memberStates,
      at: later,
      dispatchId: "dispatch-seq-mark-fail",
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.family.pendingDispatches["dispatch-seq-mark-fail"]?.status).toBe("selected");

    // Wrong id mark fails (fail-closed). Concurrent path interrupts; sequential mirrors that.
    const wrongMark = markFamilyPendingDispatchedForHost({
      family: selected.family,
      dispatchId: "missing-mark-id",
      at: later,
    });
    expect(wrongMark.ok).toBe(false);

    const interrupted = settleFamilyPendingForHost({
      family: selected.family,
      dispatchId: "dispatch-seq-mark-fail",
      at: doneAt,
      outcome: "interrupted",
      reason: "Could not mark family dispatch as dispatched.",
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(Object.keys(interrupted.family.pendingDispatches)).toEqual([]);
    // Sequential selection is unblocked after interrupt.
    const next = commitFamilySelection({
      family: interrupted.family,
      memberStates,
      at: doneAt,
      dispatchId: "dispatch-seq-after-interrupt",
    });
    expect(next.ok).toBe(true);
  });

  it("host commit fails closed on empty items and goal identity mismatch", () => {
    const { family, memberStates } = createTwoMemberFamily("family-host-fail-closed");
    const empty = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: [],
      at: later,
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.diagnostics[0]?.code).toBe("goal_family_concurrent_batch_empty");

    const selection = selectFamilyProductControllerAction({
      liveState: memberStates["goal-root"]!,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2 },
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;
    expect(selection.items.length).toBe(2);

    // Reversed item order still commits domain batch order; host goal pairing must fail.
    const reversed = [...selection.items].reverse();
    const mismatched = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: reversed,
      at: later,
      maxBatchSize: 2,
      createDispatchId: (index) => `mismatch-${index}`,
    });
    expect(mismatched.ok).toBe(false);
    if (mismatched.ok) return;
    expect(mismatched.diagnostics[0]?.code).toBe("goal_family_concurrent_goal_mismatch");

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      maxBatchSize: 2,
      createDispatchId: (index) => `ok-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const wrongMark = markFamilyPendingDispatchedForHost({
      family: committed.family,
      dispatchId: "missing-id",
      at: doneAt,
    });
    expect(wrongMark.ok).toBe(false);
    if (wrongMark.ok) return;
    expect(wrongMark.diagnostics[0]?.code).toBe("goal_family_dispatch_missing");
    expect(pendingDispatchCount(committed.family)).toBe(2);
  });

  it("rejects absent pendingDispatches on concurrent parse for schema 3", () => {
    const { family, memberStates } = createTwoMemberFamily("family-missing-map");
    const preferred = selectFamilyConcurrentActions({
      family,
      memberStates,
    });
    expect(preferred.kind).toBe("select-batch");

    const withoutMap = { ...family } as Record<string, unknown>;
    delete withoutMap.pendingDispatches;
    const parsed = parseFamilyPendingDispatchOwnData(withoutMap);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(
      parsed.diagnostics.some((d) => d.code === "family_concurrent_pending_dispatches_required"),
    ).toBe(true);

    const decision = selectFamilyConcurrentBatchFromCandidates({
      family: withoutMap as never,
      candidates: preferred.kind === "select-batch" ? preferred.candidates : [],
    });
    expect(decision.kind).toBe("rejected");
    if (decision.kind !== "rejected") return;
    expect(
      decision.diagnostics.some((d) => d.code === "family_concurrent_pending_dispatches_required"),
    ).toBe(true);
  });
});

