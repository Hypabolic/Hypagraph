/**
 * S2: family pending restore sweep, familyDispatchId on active attempt, operator reclaim.
 */

import { describe, expect, it } from "vitest";
import {
  GOAL_FAMILY_SCHEMA_VERSION,
  addFamilyMember,
  createRootFamily,
  hasAnyPendingDispatch,
  listPendingDispatches,
  pendingDispatchCount,
  type GoalFamilyRuntime,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { DEFAULT_MODEL_EXECUTOR_PROFILE } from "../src/domain/model-executor-profile.js";
import {
  selectFamilyProductControllerAction,
} from "../src/pi/family-product-dispatch.js";
import {
  commitConcurrentFamilyBatchForHost,
  interruptAllFamilyPendingsForHost,
  markFamilyPendingDispatchedForHost,
  resolveFamilyRecordForPendingSweep,
  resolveFamilyRecordForPostOrphanPendingSweep,
  settleFamilyPendingForHost,
} from "../src/pi/family-controller-host.js";
import {
  prepareIsolatedRootAttempt,
} from "../src/pi/isolated-root-dispatch.js";
import type { PersistedGoalFamily } from "../src/persistence/family-store.js";

const at = "2026-08-05T12:00:00.000Z";
const later = "2026-08-05T12:05:00.000Z";
const restoreAt = "2026-08-05T12:10:00.000Z";

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

const createTwoMemberFamily = (familyId = "family-s2"): {
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

const toPersisted = (
  family: GoalFamilyRuntime,
  memberStates: Record<string, HypagraphState>,
): PersistedGoalFamily => ({
  schemaVersion: family.schemaVersion,
  familyEvents: [],
  familySnapshot: structuredClone(family),
  workflows: Object.fromEntries(
    Object.entries(memberStates).map(([goalId, snapshot]) => {
      const workflowId = snapshot.workflowId;
      return [workflowId, { events: [], snapshot }];
    }),
  ),
});

const commitTwoPendings = (familyId: string) => {
  const { family, rootState, memberStates } = createTwoMemberFamily(familyId);
  const selection = selectFamilyProductControllerAction({
    liveState: rootState,
    familyRecord: toPersisted(family, memberStates),
    concurrencyPolicy: { concurrent: true, maxBatchSize: 2 },
  });
  expect(selection.kind).toBe("dispatch-batch");
  if (selection.kind !== "dispatch-batch") {
    throw new Error(`expected dispatch-batch, got ${selection.kind}`);
  }
  const committed = commitConcurrentFamilyBatchForHost({
    family,
    memberStates,
    items: selection.items,
    at: later,
    createDispatchId: (index, item) => `s2-${item.memberGoalId}-${index}`,
  });
  expect(committed.ok).toBe(true);
  if (!committed.ok) throw new Error(JSON.stringify(committed.diagnostics));
  return {
    family: committed.family,
    rootState,
    memberStates,
    dispatchIds: committed.items.map((item) => item.dispatchId),
  };
};

describe("S2 family pending restore sweep", () => {
  it("sweeps multi-pending occupancy on restore so the family is not permanently blocked", () => {
    const { family, rootState, memberStates, dispatchIds } = commitTwoPendings("family-s2-restore");
    expect(pendingDispatchCount(family)).toBe(2);
    expect(dispatchIds).toHaveLength(2);

    // Before sweep, capacity is full and selection is blocked.
    const blocked = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2, globalConcurrency: 2 },
    });
    expect(blocked.kind).toBe("family-blocked");

    const swept = interruptAllFamilyPendingsForHost({
      family,
      at: restoreAt,
      reason: "The Pi session reloaded before family pending dispatches completed.",
    });
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;
    expect(swept.interruptedDispatchIds).toHaveLength(2);
    expect(swept.interruptedDispatchIds).toEqual(
      expect.arrayContaining(dispatchIds),
    );
    expect(pendingDispatchCount(swept.family)).toBe(0);
    expect(hasAnyPendingDispatch(swept.family)).toBe(false);
    expect(swept.family.schemaVersion).toBe(GOAL_FAMILY_SCHEMA_VERSION);
    expect(listPendingDispatches(swept.family)).toEqual([]);

    // After sweep, the family can select again.
    const after = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(swept.family, memberStates),
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2, globalConcurrency: 2 },
    });
    expect(after.kind).toBe("dispatch-batch");
  });

  it("uses distinct branch-change and session-reload reasons", () => {
    const branchReason =
      "The Pi branch changed before family pending dispatches completed.";
    const reloadReason =
      "The Pi session reloaded before family pending dispatches completed.";

    const { family } = commitTwoPendings("family-s2-reason");
    const branchSweep = interruptAllFamilyPendingsForHost({
      family,
      at: restoreAt,
      reason: branchReason,
    });
    expect(branchSweep.ok).toBe(true);
    if (!branchSweep.ok) return;
    expect(branchSweep.interruptedDispatchIds).toHaveLength(2);
    expect(branchSweep.events).toHaveLength(2);
    expect(branchSweep.events.every((event) =>
      event.type === "hypagraph.family.action-interrupted",
    )).toBe(true);
    expect(branchSweep.events.every((event) =>
      event.type === "hypagraph.family.action-interrupted"
      && event.data.reason === branchReason,
    )).toBe(true);

    const { family: reloadFamily } = commitTwoPendings("family-s2-reason-reload");
    const reloadSweep = interruptAllFamilyPendingsForHost({
      family: reloadFamily,
      at: restoreAt,
      reason: reloadReason,
    });
    expect(reloadSweep.ok).toBe(true);
    if (!reloadSweep.ok) return;
    expect(reloadSweep.interruptedDispatchIds).toHaveLength(2);
    expect(reloadSweep.events.every((event) =>
      event.type === "hypagraph.family.action-interrupted"
      && event.data.reason === reloadReason,
    )).toBe(true);
  });

  it("does nothing when there are no pendings", () => {
    const { family } = createTwoMemberFamily("family-s2-empty");
    const swept = interruptAllFamilyPendingsForHost({
      family,
      at: restoreAt,
      reason: "The Pi session reloaded before family pending dispatches completed.",
    });
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;
    expect(swept.interruptedDispatchIds).toEqual([]);
    expect(swept.events).toEqual([]);
    expect(pendingDispatchCount(swept.family)).toBe(0);
  });

  it("does not mutate the input family object", () => {
    const { family } = commitTwoPendings("family-s2-immut");
    const beforeKeys = Object.keys(family.pendingDispatches).sort();
    const swept = interruptAllFamilyPendingsForHost({
      family,
      at: restoreAt,
      reason: "The Pi session reloaded before family pending dispatches completed.",
    });
    expect(swept.ok).toBe(true);
    expect(Object.keys(family.pendingDispatches).sort()).toEqual(beforeKeys);
    expect(pendingDispatchCount(family)).toBe(2);
  });
});

describe("S2 ActiveIsolatedRootAttempt familyDispatchId", () => {
  it("carries familyDispatchId from prepare onto the active attempt", () => {
    const state = createMemberWorkflow(singleTask("Isolated"), "workflow-iso", "goal-iso");
    const root = createRootFamily({
      familyId: "family-iso",
      rootGoalId: state.goal!.goalId,
      rootWorkflowId: state.workflowId,
      at,
    });
    if (!root.ok) throw new Error(JSON.stringify(root.diagnostics));

    const prepared = prepareIsolatedRootAttempt({
      state,
      family: root.family,
      action: {
        kind: "start-ready-task",
        nodeId: "work",
        goalId: state.goal!.goalId,
        workflowId: state.workflowId,
        revision: state.revision,
        sequence: state.sequence,
        snapshotHash: state.snapshotHash,
        continuationOrdinal: state.goal!.continuationOrdinal,
      },
      profile: DEFAULT_MODEL_EXECUTOR_PROFILE,
      attemptId: "attempt-s2",
      operationId: "op-s2",
      sessionGeneration: 1,
      branchGeneration: 0,
      startedAt: at,
      familyDispatchId: "dispatch-family-s2",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.active.familyDispatchId).toBe("dispatch-family-s2");
    expect(prepared.active.attemptId).toBe("attempt-s2");
    expect(prepared.active.settled).toBe(false);
  });

  it("omits familyDispatchId when prepare does not receive one", () => {
    const state = createMemberWorkflow(singleTask("Isolated bare"), "workflow-bare", "goal-bare");
    const root = createRootFamily({
      familyId: "family-bare",
      rootGoalId: state.goal!.goalId,
      rootWorkflowId: state.workflowId,
      at,
    });
    if (!root.ok) throw new Error(JSON.stringify(root.diagnostics));

    const prepared = prepareIsolatedRootAttempt({
      state,
      family: root.family,
      action: {
        kind: "start-ready-task",
        nodeId: "work",
        goalId: state.goal!.goalId,
        workflowId: state.workflowId,
        revision: state.revision,
        sequence: state.sequence,
        snapshotHash: state.snapshotHash,
        continuationOrdinal: state.goal!.continuationOrdinal,
      },
      profile: DEFAULT_MODEL_EXECUTOR_PROFILE,
      attemptId: "attempt-bare",
      operationId: "op-bare",
      sessionGeneration: 1,
      branchGeneration: 0,
      startedAt: at,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.active.familyDispatchId).toBeUndefined();
  });

  it("orphan settle of familyDispatchId clears only that family pending", () => {
    const { family, dispatchIds } = commitTwoPendings("family-s2-orphan");
    const [firstId, secondId] = dispatchIds;
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();

    // Mark first as dispatched (in-flight worker), leave second selected.
    const marked = markFamilyPendingDispatchedForHost({
      family,
      dispatchId: firstId!,
      at: later,
    });
    expect(marked.ok).toBe(true);
    if (!marked.ok) return;

    // Orphan cancel settles the attempt's familyDispatchId only.
    const orphaned = settleFamilyPendingForHost({
      family: marked.family,
      dispatchId: firstId!,
      at: restoreAt,
      outcome: "interrupted",
      reason: "The Pi session reloaded before the isolated model worker completed.",
    });
    expect(orphaned.ok).toBe(true);
    if (!orphaned.ok) return;
    expect(orphaned.family.pendingDispatches[firstId!]).toBeUndefined();
    expect(orphaned.family.pendingDispatches[secondId!]?.status).toBe("selected");
    expect(pendingDispatchCount(orphaned.family)).toBe(1);

    // Full restore sweep then clears the remaining stranded pending.
    const swept = interruptAllFamilyPendingsForHost({
      family: orphaned.family,
      at: restoreAt,
      reason: "The Pi session reloaded before family pending dispatches completed.",
    });
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;
    expect(swept.interruptedDispatchIds).toEqual([secondId]);
    expect(pendingDispatchCount(swept.family)).toBe(0);
  });
});

describe("S2 operator reclaim of stranded family pendings", () => {
  it("reclaims all stranded pendings so occupancy is free", () => {
    const { family, rootState, memberStates } = commitTwoPendings("family-s2-reclaim-all");
    expect(pendingDispatchCount(family)).toBe(2);

    const reclaimed = interruptAllFamilyPendingsForHost({
      family,
      at: restoreAt,
      reason: "The operator reclaimed stranded family pending dispatches.",
    });
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) return;
    expect(reclaimed.interruptedDispatchIds).toHaveLength(2);
    expect(pendingDispatchCount(reclaimed.family)).toBe(0);

    const after = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(reclaimed.family, memberStates),
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2, globalConcurrency: 2 },
    });
    expect(after.kind).toBe("dispatch-batch");
  });

  it("reclaims only named dispatch ids when supplied", () => {
    const { family, dispatchIds } = commitTwoPendings("family-s2-reclaim-named");
    const [firstId, secondId] = dispatchIds;
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();

    const reclaimed = interruptAllFamilyPendingsForHost({
      family,
      at: restoreAt,
      reason: "The operator reclaimed named family pending dispatches.",
      dispatchIds: [firstId!],
    });
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) return;
    expect(reclaimed.interruptedDispatchIds).toEqual([firstId]);
    expect(reclaimed.family.pendingDispatches[firstId!]).toBeUndefined();
    expect(reclaimed.family.pendingDispatches[secondId!]?.status).toBe("selected");
    expect(pendingDispatchCount(reclaimed.family)).toBe(1);
  });

  it("reports no work when named ids do not match any pending", () => {
    const { family } = commitTwoPendings("family-s2-reclaim-miss");
    const reclaimed = interruptAllFamilyPendingsForHost({
      family,
      at: restoreAt,
      reason: "The operator reclaimed named family pending dispatches.",
      dispatchIds: ["missing-dispatch-id"],
    });
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) return;
    expect(reclaimed.interruptedDispatchIds).toEqual([]);
    expect(pendingDispatchCount(reclaimed.family)).toBe(2);
  });

  it("reports unmatched named ids as unknown while reclaiming matches", () => {
    const { family, dispatchIds } = commitTwoPendings("family-s2-reclaim-mixed");
    const [firstId, secondId] = dispatchIds;
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();

    const namedIds = [firstId!, "missing-dispatch-id"];
    const reclaimed = interruptAllFamilyPendingsForHost({
      family,
      at: restoreAt,
      reason: "The operator reclaimed named family pending dispatches.",
      dispatchIds: namedIds,
    });
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) return;
    expect(reclaimed.interruptedDispatchIds).toEqual([firstId]);
    const reclaimedSet = new Set(reclaimed.interruptedDispatchIds);
    const unknownIds = namedIds.filter((id) => !reclaimedSet.has(id));
    expect(unknownIds).toEqual(["missing-dispatch-id"]);
    expect(pendingDispatchCount(reclaimed.family)).toBe(1);
    expect(reclaimed.family.pendingDispatches[secondId!]?.status).toBe("selected");
  });
});

describe("S2 resolveFamilyRecordForPendingSweep branch-local precedence", () => {
  it("prefers familyProjection over branch session and host memory", () => {
    const projection = { id: "projection" };
    const branch = { id: "branch" };
    const host = { id: "host-previous-branch" };
    const resolved = resolveFamilyRecordForPendingSweep({
      familyProjection: projection,
      branchSessionFamily: branch,
      hostLatestFamily: host,
    });
    expect(resolved).toBe(projection);
  });

  it("prefers branch session family over host memory when projection is absent", () => {
    const branch = { id: "branch" };
    const host = { id: "host-previous-branch" };
    const resolved = resolveFamilyRecordForPendingSweep({
      branchSessionFamily: branch,
      hostLatestFamily: host,
    });
    expect(resolved).toBe(branch);
  });

  it("uses host memory only as last resort", () => {
    const host = { id: "host-only" };
    const resolved = resolveFamilyRecordForPendingSweep({
      hostLatestFamily: host,
    });
    expect(resolved).toBe(host);
  });

  it("returns undefined when no family source is available", () => {
    expect(resolveFamilyRecordForPendingSweep({})).toBeUndefined();
  });

  it("on branch change, host memory alone must not win when branch family exists", () => {
    // Simulates session_tree after branch change: host still holds previous
    // branch family; current branch has its own family with multi-pending.
    const previous = commitTwoPendings("family-s2-prev-branch");
    const previousBranchFamily = toPersisted(previous.family, previous.memberStates);
    const current = commitTwoPendings("family-s2-curr-branch");
    const currentBranchFamily = toPersisted(current.family, current.memberStates);

    // Wrong order (historical bug): host first would sweep the previous branch.
    const wrongOrder = previousBranchFamily ?? currentBranchFamily;
    expect(wrongOrder.familySnapshot.familyId).toBe("family-s2-prev-branch");

    // Correct order: branch-local first.
    const resolved = resolveFamilyRecordForPendingSweep({
      branchSessionFamily: currentBranchFamily,
      hostLatestFamily: previousBranchFamily,
    });
    expect(resolved).toBe(currentBranchFamily);
    expect(resolved?.familySnapshot.familyId).toBe("family-s2-curr-branch");
    expect(pendingDispatchCount(resolved!.familySnapshot)).toBe(2);

    const swept = interruptAllFamilyPendingsForHost({
      family: resolved!.familySnapshot,
      at: restoreAt,
      reason: "The Pi branch changed before family pending dispatches completed.",
    });
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;
    expect(pendingDispatchCount(swept.family)).toBe(0);
    // Previous branch host memory remains untouched by the pure resolver + sweep.
    expect(pendingDispatchCount(previousBranchFamily.familySnapshot)).toBe(2);
  });
});

describe("S2 post-orphan pending sweep ordering", () => {
  it("prefers post-orphan host family over reloaded branch family", () => {
    const postOrphan = { id: "post-orphan-host" };
    const reloaded = { id: "reloaded-branch" };
    const resolved = resolveFamilyRecordForPostOrphanPendingSweep({
      postOrphanHostFamily: postOrphan,
      reloadedBranchFamily: reloaded,
    });
    expect(resolved).toBe(postOrphan);
  });

  it("falls back to reloaded branch family when host memory is empty", () => {
    const reloaded = { id: "reloaded-only" };
    const resolved = resolveFamilyRecordForPostOrphanPendingSweep({
      reloadedBranchFamily: reloaded,
    });
    expect(resolved).toBe(reloaded);
  });

  it("orphan-then-sweep uses post-orphan family and does not restore pre-orphan workflows", () => {
    // Pre-orphan: multi-pending on branch-local family (stale capture for sweep).
    const committed = commitTwoPendings("family-s2-orphan-then-sweep");
    const [firstId, secondId] = committed.dispatchIds;
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();

    const preOrphanPersisted = toPersisted(committed.family, committed.memberStates);
    // Tag workflows so a stale rewrite is detectable.
    const preOrphanWorkflows = structuredClone(preOrphanPersisted.workflows);
    for (const stream of Object.values(preOrphanWorkflows)) {
      (stream.snapshot as HypagraphState & { _marker?: string })._marker = "pre-orphan";
    }
    const preOrphanCapture: PersistedGoalFamily = {
      ...preOrphanPersisted,
      workflows: preOrphanWorkflows,
      familySnapshot: structuredClone(committed.family),
    };

    // Orphan settle of familyDispatchId firstId: clear that pending only.
    // Also mark workflows as post-orphan (member cancel path).
    const afterOrphanPending = settleFamilyPendingForHost({
      family: committed.family,
      dispatchId: firstId!,
      at: restoreAt,
      outcome: "interrupted",
      reason: "The Pi session reloaded before the isolated model worker completed.",
    });
    expect(afterOrphanPending.ok).toBe(true);
    if (!afterOrphanPending.ok) return;
    expect(afterOrphanPending.family.pendingDispatches[firstId!]).toBeUndefined();
    expect(afterOrphanPending.family.pendingDispatches[secondId!]?.status).toBe("selected");

    const postOrphanWorkflows = structuredClone(preOrphanPersisted.workflows);
    for (const stream of Object.values(postOrphanWorkflows)) {
      (stream.snapshot as HypagraphState & { _marker?: string })._marker = "post-orphan-cancel";
    }
    const postOrphanHost: PersistedGoalFamily = {
      schemaVersion: afterOrphanPending.family.schemaVersion,
      familyEvents: [
        ...structuredClone(preOrphanPersisted.familyEvents),
        ...structuredClone(afterOrphanPending.events),
      ],
      familySnapshot: structuredClone(afterOrphanPending.family),
      workflows: postOrphanWorkflows,
    };

    // Wrong order (Issue 9 bug): pre-orphan projection wins over post-orphan host.
    const wrongSweepBase = resolveFamilyRecordForPendingSweep({
      familyProjection: preOrphanCapture,
      hostLatestFamily: postOrphanHost,
    });
    expect(wrongSweepBase).toBe(preOrphanCapture);
    expect(pendingDispatchCount(wrongSweepBase!.familySnapshot)).toBe(2);
    const wrongMarker = (
      Object.values(wrongSweepBase!.workflows)[0]!.snapshot as HypagraphState & { _marker?: string }
    )._marker;
    expect(wrongMarker).toBe("pre-orphan");

    // Correct order: post-orphan host wins; pre-orphan captures are not inputs.
    const sweepBase = resolveFamilyRecordForPostOrphanPendingSweep({
      postOrphanHostFamily: postOrphanHost,
      reloadedBranchFamily: preOrphanCapture,
    });
    expect(sweepBase).toBe(postOrphanHost);
    expect(pendingDispatchCount(sweepBase!.familySnapshot)).toBe(1);
    const postMarker = (
      Object.values(sweepBase!.workflows)[0]!.snapshot as HypagraphState & { _marker?: string }
    )._marker;
    expect(postMarker).toBe("post-orphan-cancel");

    // Sweep remaining pendings only; does not reintroduce firstId from stale base.
    const swept = interruptAllFamilyPendingsForHost({
      family: sweepBase!.familySnapshot,
      at: restoreAt,
      reason: "The Pi session reloaded before family pending dispatches completed.",
    });
    expect(swept.ok).toBe(true);
    if (!swept.ok) return;
    expect(swept.interruptedDispatchIds).toEqual([secondId]);
    expect(pendingDispatchCount(swept.family)).toBe(0);
    expect(swept.family.pendingDispatches[firstId!]).toBeUndefined();

    // Persist shape: keep post-orphan workflows when applying sweep snapshot.
    const persistedAfterSweep: PersistedGoalFamily = {
      schemaVersion: sweepBase!.schemaVersion,
      familyEvents: [
        ...structuredClone(sweepBase!.familyEvents),
        ...structuredClone(swept.events),
      ],
      familySnapshot: structuredClone(swept.family),
      workflows: structuredClone(sweepBase!.workflows),
    };
    const finalMarker = (
      Object.values(persistedAfterSweep.workflows)[0]!.snapshot as HypagraphState & { _marker?: string }
    )._marker;
    expect(finalMarker).toBe("post-orphan-cancel");
    expect(pendingDispatchCount(persistedAfterSweep.familySnapshot)).toBe(0);
  });
});
