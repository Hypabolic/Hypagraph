/**
 * Gate 1.3: automated substitute for multi-child concurrent family live acceptance.
 *
 * Proves the multi-pending product path at host/product helper level (Seam C).
 * Does not earn ledger Live without a real Pi dogfood for CASE-G1-3-CONCURRENT-FAMILY.
 *
 * Family shape: root plus two sibling children. Root is paused so the concurrent
 * batch is multi-child (two children), not root+one-child only.
 */

import { describe, expect, it } from "vitest";
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
import { projectFamilyGraphView } from "../src/graph/family-projection.js";
import {
  commitConcurrentFamilyBatchForHost,
  markFamilyPendingDispatchedForHost,
  prepareFamilyControllerPass,
  settleFamilyPendingForHost,
} from "../src/pi/family-controller-host.js";
import {
  resolveFamilyProductConcurrencyPolicy,
  selectFamilyProductControllerAction,
} from "../src/pi/family-product-dispatch.js";
import type { PersistedGoalFamily } from "../src/persistence/family-store.js";
import {
  familyDispatchOccupancySummary,
  familyWidgetLines,
  listFamilyPendingViews,
  renderFamilyStatus,
} from "../src/ui/family-surface.js";

const at = "2026-08-04T16:00:00.000Z";
const later = "2026-08-04T16:05:00.000Z";
const dispatchedAt = "2026-08-04T16:06:00.000Z";
const settleFirstAt = "2026-08-04T16:10:00.000Z";
const settleSecondAt = "2026-08-04T16:15:00.000Z";

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

/**
 * Root plus two sibling children (multi-child family).
 * By default the root stays ready. Callers can pause the root for child-only batches.
 */
const createRootWithTwoChildren = (familyId = "family-g1-3"): {
  family: GoalFamilyRuntime;
  rootState: HypagraphState;
  childAState: HypagraphState;
  childBState: HypagraphState;
  memberStates: Record<string, HypagraphState>;
} => {
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
  const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
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
  return {
    family: childB.family,
    rootState,
    childAState,
    childBState,
    memberStates: {
      "goal-root": rootState,
      "goal-child-a": childAState,
      "goal-child-b": childBState,
    },
  };
};

/** Two sibling children concurrent-eligible; root paused so it is not selected. */
const createTwoChildReadyFamily = (familyId: string) => {
  const base = createRootWithTwoChildren(familyId);
  const pausedRoot = pauseMember(base.rootState, "Pause root for multi-child concurrent batch.");
  const memberStates = {
    "goal-root": pausedRoot,
    "goal-child-a": base.childAState,
    "goal-child-b": base.childBState,
  };
  return {
    family: base.family,
    rootState: pausedRoot,
    childAState: base.childAState,
    childBState: base.childBState,
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

const markAllDispatched = (
  family: GoalFamilyRuntime,
  items: Array<{ dispatchId: string; memberGoalId: string }>,
  memberStates: Record<string, HypagraphState>,
): GoalFamilyRuntime => {
  let next = family;
  for (const item of items) {
    const memberState = memberStates[item.memberGoalId];
    if (!memberState) {
      throw new Error(`missing memberState for ${item.memberGoalId}`);
    }
    const marked = markFamilyPendingDispatchedForHost({
      family: next,
      dispatchId: item.dispatchId,
      at: dispatchedAt,
      memberState,
    });
    if (!marked.ok) {
      throw new Error(JSON.stringify(marked.diagnostics));
    }
    next = marked.family;
  }
  return next;
};

describe("gate1-3 concurrent family live acceptance substitute", () => {
  it("runs multi-child product path: two siblings, select batch, host commit, mark with memberState, settle each, status honesty", () => {
    const { family, rootState, memberStates } = createTwoChildReadyFamily("family-g1-3-live-sub");
    expect(family.schemaVersion).toBe(GOAL_FAMILY_SCHEMA_VERSION);
    expect(family.schemaVersion).toBe(3);
    expect(Object.keys(memberStates).sort()).toEqual([
      "goal-child-a",
      "goal-child-b",
      "goal-root",
    ]);

    const defaultPolicy = resolveFamilyProductConcurrencyPolicy(undefined);
    expect(defaultPolicy.concurrent).toBe(true);
    expect(defaultPolicy.maxBatchSize).toBe(2);
    expect(defaultPolicy.globalConcurrency).toBe(2);
    expect(defaultPolicy.partialFailureMode).toBe("independent-settle");

    const prepared = prepareFamilyControllerPass({
      familyRecord: toPersisted(family, memberStates),
      liveState: rootState,
    });
    expect(prepared.pendingCount).toBe(0);
    expect(prepared.policy.concurrent).toBe(true);
    expect(Object.keys(prepared.memberStates).sort()).toEqual([
      "goal-child-a",
      "goal-child-b",
      "goal-root",
    ]);

    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;
    expect(selection.items).toHaveLength(2);
    expect(selection.items.every((item) => item.decision.kind === "start-ready-task")).toBe(true);
    const selectedGoals = selection.items.map((item) => item.memberGoalId).sort();
    // Multi-child: both siblings; root is paused and must not be selected.
    expect(selectedGoals).toEqual(["goal-child-a", "goal-child-b"]);
    expect(selection.items.every((item) => item.memberGoalId !== "goal-root")).toBe(true);
    expect(selection.concurrencyPolicy.globalConcurrency).toBe(2);
    expect(selection.concurrencyPolicy.partialFailureMode).toBe("independent-settle");

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      resolvedConcurrencyPolicy: selection.concurrencyPolicy,
      createDispatchId: (index, item) => `g13-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(pendingDispatchCount(committed.family)).toBe(2);
    expect(committed.items).toHaveLength(2);
    expect(new Set(committed.items.map((i) => i.dispatchId)).size).toBe(2);
    expect(listPendingDispatches(committed.family)).toHaveLength(2);
    expect(
      listPendingDispatches(committed.family).every((p) => p.status === "selected"),
    ).toBe(true);

    const viewAfterCommit = projectFamilyGraphView({
      family: committed.family,
      memberStates,
      focusedGoalId: "goal-root",
    });
    expect(listFamilyPendingViews(viewAfterCommit.scheduler)).toHaveLength(2);
    expect(familyDispatchOccupancySummary(viewAfterCommit.scheduler)).toBe(
      "dispatch multi-pending x2",
    );
    expect(familyWidgetLines(viewAfterCommit).join("\n")).toContain("dispatch multi-pending x2");
    const statusAfterCommit = renderFamilyStatus(viewAfterCommit, 120);
    expect(statusAfterCommit).toContain("multi-pending x2");
    expect(statusAfterCommit).toContain("goal-child-a");
    expect(statusAfterCommit).toContain("goal-child-b");
    expect(statusAfterCommit).not.toMatch(/Family dispatch: idle/);

    // Mark all startable as dispatched with memberState (matches extension call site).
    const familyAfterMark = markAllDispatched(
      committed.family,
      committed.items,
      memberStates,
    );
    expect(pendingDispatchCount(familyAfterMark)).toBe(2);
    expect(
      listPendingDispatches(familyAfterMark).every((p) => p.status === "dispatched"),
    ).toBe(true);

    const firstId = committed.items[0]!.dispatchId;
    const secondId = committed.items[1]!.dispatchId;

    const settledFirst = settleFamilyPendingForHost({
      family: familyAfterMark,
      dispatchId: firstId,
      at: settleFirstAt,
      outcome: "completed",
      partialFailureMode: "independent-settle",
    });
    expect(settledFirst.ok).toBe(true);
    if (!settledFirst.ok) return;
    expect(settledFirst.family.pendingDispatches[firstId]).toBeUndefined();
    expect(settledFirst.family.pendingDispatches[secondId]).toBeDefined();
    expect(settledFirst.family.pendingDispatches[secondId]?.status).toBe("dispatched");
    expect(pendingDispatchCount(settledFirst.family)).toBe(1);
    expect(settledFirst.family.lastDispatchOutcome?.dispatchId).toBe(firstId);
    expect(settledFirst.family.lastDispatchOutcome?.status).toBe("completed");

    const viewMidSettle = projectFamilyGraphView({
      family: settledFirst.family,
      memberStates,
      focusedGoalId: "goal-root",
    });
    expect(listFamilyPendingViews(viewMidSettle.scheduler)).toHaveLength(1);
    expect(familyDispatchOccupancySummary(viewMidSettle.scheduler)).not.toContain("idle");
    expect(renderFamilyStatus(viewMidSettle, 120)).not.toMatch(/Family dispatch: idle/);

    const settledSecond = settleFamilyPendingForHost({
      family: settledFirst.family,
      dispatchId: secondId,
      at: settleSecondAt,
      outcome: "completed",
      partialFailureMode: "independent-settle",
    });
    expect(settledSecond.ok).toBe(true);
    if (!settledSecond.ok) return;
    expect(pendingDispatchCount(settledSecond.family)).toBe(0);
    expect(settledSecond.family.pendingDispatches[secondId]).toBeUndefined();
    expect(settledSecond.family.lastDispatchOutcome?.dispatchId).toBe(secondId);
    expect(settledSecond.family.lastDispatchOutcome?.status).toBe("completed");

    const viewDone = projectFamilyGraphView({
      family: settledSecond.family,
      memberStates,
      focusedGoalId: "goal-root",
    });
    expect(listFamilyPendingViews(viewDone.scheduler)).toHaveLength(0);
    // After all pendings settle, occupancy reports last outcome (not multi-pending).
    expect(familyDispatchOccupancySummary(viewDone.scheduler)).toBe("last dispatch completed");
    expect(familyDispatchOccupancySummary(viewDone.scheduler)).not.toContain("multi-pending");
  });

  it("keeps independent-settle when one of two child pendings fails", () => {
    const { family, rootState, memberStates } = createTwoChildReadyFamily("family-g1-3-partial");
    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2, globalConcurrency: 2 },
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;
    expect(selection.items.map((i) => i.memberGoalId).sort()).toEqual([
      "goal-child-a",
      "goal-child-b",
    ]);

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      resolvedConcurrencyPolicy: selection.concurrencyPolicy,
      createDispatchId: (index, item) => `g13-fail-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const familyMarked = markAllDispatched(committed.family, committed.items, memberStates);

    const firstId = committed.items[0]!.dispatchId;
    const secondId = committed.items[1]!.dispatchId;

    const failed = settleFamilyPendingForHost({
      family: familyMarked,
      dispatchId: firstId,
      at: settleFirstAt,
      outcome: "failed",
      reason: "Controlled failure for independent-settle check.",
      partialFailureMode: "independent-settle",
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.family.pendingDispatches[firstId]).toBeUndefined();
    expect(failed.family.pendingDispatches[secondId]?.status).toBe("dispatched");
    expect(pendingDispatchCount(failed.family)).toBe(1);
    expect(failed.family.lastDispatchOutcome?.status).toBe("failed");
  });

  it("settles one of two pendings as interrupted and leaves the sibling pending", () => {
    // §5.2: deferred settle as interrupted in family state (helper layer).
    const { family, rootState, memberStates } = createTwoChildReadyFamily("family-g1-3-interrupt");
    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2, globalConcurrency: 2 },
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      resolvedConcurrencyPolicy: selection.concurrencyPolicy,
      createDispatchId: (index, item) => `g13-int-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const familyMarked = markAllDispatched(committed.family, committed.items, memberStates);
    const firstId = committed.items[0]!.dispatchId;
    const secondId = committed.items[1]!.dispatchId;

    const interrupted = settleFamilyPendingForHost({
      family: familyMarked,
      dispatchId: firstId,
      at: settleFirstAt,
      outcome: "interrupted",
      reason: "Deferred model capacity; interrupt first only.",
      partialFailureMode: "independent-settle",
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.family.pendingDispatches[firstId]).toBeUndefined();
    expect(interrupted.family.pendingDispatches[secondId]).toBeDefined();
    expect(interrupted.family.pendingDispatches[secondId]?.status).toBe("dispatched");
    expect(pendingDispatchCount(interrupted.family)).toBe(1);
    expect(interrupted.family.lastDispatchOutcome?.dispatchId).toBe(firstId);
    expect(interrupted.family.lastDispatchOutcome?.status).toBe("interrupted");

    const view = projectFamilyGraphView({
      family: interrupted.family,
      memberStates,
      focusedGoalId: "goal-root",
    });
    expect(listFamilyPendingViews(view.scheduler)).toHaveLength(1);
    expect(familyDispatchOccupancySummary(view.scheduler)).not.toContain("idle");
    expect(renderFamilyStatus(view, 120)).not.toMatch(/Family dispatch: idle/);
  });

  it("makes globalConcurrency binding: three ready members, admit two, block free third while occupancy full", () => {
    // All three members ready (root + two children). globalConcurrency 2 is the binding limit.
    const { family, rootState, memberStates } = createRootWithTwoChildren("family-g1-3-capacity");
    expect(Object.keys(memberStates)).toHaveLength(3);

    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: {
        concurrent: true,
        maxBatchSize: 3,
        globalConcurrency: 2,
      },
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;
    // Limit is binding: three ready members, admit at most two.
    expect(selection.items).toHaveLength(2);
    expect(selection.concurrencyPolicy.globalConcurrency).toBe(2);

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      resolvedConcurrencyPolicy: selection.concurrencyPolicy,
      createDispatchId: (index, item) => `g13-cap-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(pendingDispatchCount(committed.family)).toBe(2);

    const admittedGoals = new Set(committed.items.map((i) => i.memberGoalId));
    const freeGoals = Object.keys(memberStates).filter((id) => !admittedGoals.has(id));
    // One member remains free (no pending) while occupancy is at global capacity.
    expect(freeGoals).toHaveLength(1);

    const blocked = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(committed.family, memberStates),
      concurrencyPolicy: {
        concurrent: true,
        maxBatchSize: 3,
        globalConcurrency: 2,
      },
    });
    // Free third member cannot admit while global occupancy is full.
    expect(blocked.kind).toBe("family-blocked");
    if (blocked.kind !== "family-blocked") return;
    expect(blocked.reason).toMatch(/pending/i);
    expect(blocked.reason).not.toMatch(/idle/i);
  });
});
