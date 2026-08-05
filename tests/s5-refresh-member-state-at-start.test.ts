/**
 * S5: refresh memberState at mark/start from the live family record.
 *
 * Proves:
 * - mark/start re-read member state from the family bag (not selection-time only);
 * - a truly advanced member fails mark with goal_family_dispatch_stale_selection;
 * - selection-time clones would make mark accept an advanced stream without refresh;
 * - isLiveRoot is stable family root identity, not free-slot occupancy;
 * - root+child concurrent batch still marks when hashes stay valid after refresh;
 * - real mid-pass bag field advances are what start attaches;
 * - start re-validates hash/action against the pending;
 * - extension product path calls the refresh helpers at mark and start.
 *
 * Does not earn ledger Live. Pure host-unit substitute.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GOAL_FAMILY_SCHEMA_VERSION,
  addFamilyMember,
  createRootFamily,
  listPendingDispatches,
  type GoalFamilyRuntime,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { DomainEvent, HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import {
  commitConcurrentFamilyBatchForHost,
  markFamilyPendingDispatchedForHost,
  markFamilyPendingDispatchedWithRefreshedMemberState,
  refreshFamilyProductMemberState,
  validateMemberStateAgainstFamilyPending,
} from "../src/pi/family-controller-host.js";
import {
  replaceFamilyMemberWorkflow,
  selectFamilyProductControllerAction,
} from "../src/pi/family-product-dispatch.js";
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

const createRootAndChildFamily = (familyId: string) => {
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
  const rootState = createMemberWorkflow(
    singleTask("Root work"),
    "workflow-root",
    "goal-root",
  );
  const childState = createMemberWorkflow(
    singleTask("Child work"),
    "workflow-child",
    "goal-child",
  );
  const memberStates = {
    "goal-root": rootState,
    "goal-child": childState,
  };
  return {
    family: child.family as GoalFamilyRuntime,
    rootState,
    childState,
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

const advanceMemberHashInRecord = (
  record: PersistedGoalFamily,
  workflowId: string,
  nextHash: string,
): PersistedGoalFamily => {
  const stream = record.workflows[workflowId];
  if (!stream) throw new Error(`missing workflow ${workflowId}`);
  const advanced: HypagraphState = structuredClone(stream.snapshot);
  advanced.snapshotHash = nextHash;
  return replaceFamilyMemberWorkflow(record, workflowId, {
    events: stream.events,
    snapshot: advanced,
  });
};

/**
 * Advance bag content for one workflow while keeping snapshotHash selection-valid.
 * Models a mid-pass sibling or residual merge that does not change selection hash.
 */
const advanceBagFieldsKeepHash = (
  record: PersistedGoalFamily,
  workflowId: string,
  input: { sequenceDelta: number; eventId: string },
): PersistedGoalFamily => {
  const stream = record.workflows[workflowId];
  if (!stream) throw new Error(`missing workflow ${workflowId}`);
  const nextSnap: HypagraphState = structuredClone(stream.snapshot);
  const priorSequence = nextSnap.sequence;
  const priorHash = nextSnap.snapshotHash;
  nextSnap.sequence = priorSequence + input.sequenceDelta;
  const event: DomainEvent = {
    eventId: input.eventId,
    workflowId,
    revision: nextSnap.revision,
    sequence: nextSnap.sequence,
    type: "hypagraph.goal.paused",
    version: 1,
    timestamp: dispatchedAt,
    causationId: input.eventId,
    correlationId: input.eventId,
    data: { reason: "s5-mid-pass-bag-advance" },
  };
  return replaceFamilyMemberWorkflow(record, workflowId, {
    events: [...stream.events, event],
    snapshot: nextSnap,
  });
};

describe("S5 refresh memberState at mark/start", () => {
  it("refresh prefers live desk root content and bag for children", () => {
    const { family, rootState, childState, memberStates } = createRootAndChildFamily(
      "family-s5-refresh-lookup",
    );
    const record = toPersisted(family, memberStates);

    const liveRootAdvanced: HypagraphState = structuredClone(rootState);
    liveRootAdvanced.snapshotHash = "live-root-hash-ahead";

    const rootRefresh = refreshFamilyProductMemberState({
      familyRecord: record,
      memberGoalId: "goal-root",
      memberWorkflowId: "workflow-root",
      liveState: liveRootAdvanced,
    });
    expect(rootRefresh.ok).toBe(true);
    if (!rootRefresh.ok) return;
    expect(rootRefresh.isLiveRoot).toBe(true);
    expect(rootRefresh.memberState.snapshotHash).toBe("live-root-hash-ahead");

    const childRefresh = refreshFamilyProductMemberState({
      familyRecord: record,
      memberGoalId: "goal-child",
      memberWorkflowId: "workflow-child",
      liveState: liveRootAdvanced,
    });
    expect(childRefresh.ok).toBe(true);
    if (!childRefresh.ok) return;
    expect(childRefresh.isLiveRoot).toBe(false);
    expect(childRefresh.memberState.snapshotHash).toBe(childState.snapshotHash);
  });

  it("isLiveRoot is stable family root identity, not free-slot occupancy", () => {
    const { family, rootState, childState, memberStates } = createRootAndChildFamily(
      "family-s5-live-root-stable",
    );
    const record = toPersisted(family, memberStates);

    // Simulate concurrent free-slot bind: free slots hold the child mid-start.
    const freeSlotsBoundChild: HypagraphState = structuredClone(childState);
    freeSlotsBoundChild.sequence = childState.sequence + 7;

    const rootWhileChildBound = refreshFamilyProductMemberState({
      familyRecord: record,
      memberGoalId: "goal-root",
      memberWorkflowId: "workflow-root",
      liveState: freeSlotsBoundChild,
    });
    expect(rootWhileChildBound.ok).toBe(true);
    if (!rootWhileChildBound.ok) return;
    // Desk root must still route as live root; content from bag (not child free slots).
    expect(rootWhileChildBound.isLiveRoot).toBe(true);
    expect(rootWhileChildBound.memberState.workflowId).toBe("workflow-root");
    expect(rootWhileChildBound.memberState.snapshotHash).toBe(rootState.snapshotHash);
    expect(rootWhileChildBound.memberState.sequence).toBe(rootState.sequence);

    const childWhileChildBound = refreshFamilyProductMemberState({
      familyRecord: record,
      memberGoalId: "goal-child",
      memberWorkflowId: "workflow-child",
      liveState: freeSlotsBoundChild,
    });
    expect(childWhileChildBound.ok).toBe(true);
    if (!childWhileChildBound.ok) return;
    // Child must not flip to isLiveRoot when free slots hold the child.
    expect(childWhileChildBound.isLiveRoot).toBe(false);
    // Non-root content always from bag (not free-slot ephemeral stream).
    expect(childWhileChildBound.memberState.sequence).toBe(childState.sequence);
    expect(childWhileChildBound.memberState).toBe(record.workflows["workflow-child"]!.snapshot);
  });

  it("refresh fails with clear stale diagnostic when member is missing from the family bag", () => {
    const { family, memberStates } = createRootAndChildFamily("family-s5-missing");
    const record = toPersisted(family, memberStates);
    const withoutChild: PersistedGoalFamily = {
      ...record,
      workflows: {
        "workflow-root": record.workflows["workflow-root"]!,
      },
    };

    const missing = refreshFamilyProductMemberState({
      familyRecord: withoutChild,
      memberGoalId: "goal-child",
      memberWorkflowId: "workflow-child",
      liveState: memberStates["goal-root"],
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.diagnostics[0]?.code).toBe("goal_family_dispatch_stale_selection");
    expect(missing.diagnostics[0]?.message).toMatch(/no workflow state/i);
  });

  it("mark with refresh fails when family bag advanced after selection; selection-time clone would accept", () => {
    const { family, rootState, memberStates } = createRootAndChildFamily("family-s5-stale-mark");
    expect(family.schemaVersion).toBe(GOAL_FAMILY_SCHEMA_VERSION);

    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;
    expect(selection.items.length).toBeGreaterThanOrEqual(2);

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      resolvedConcurrencyPolicy: selection.concurrencyPolicy,
      createDispatchId: (index, item) => `s5-stale-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const childItem = committed.items.find((item) => item.memberGoalId === "goal-child");
    expect(childItem).toBeDefined();
    if (!childItem) return;

    // Intermediate mutation within the pass: child stream advances after commit.
    let record = toPersisted(committed.family, memberStates);
    record = advanceMemberHashInRecord(record, "workflow-child", "post-select-advanced-hash");

    // Frozen selection-time clone still matches pending selectedSnapshotHash —
    // mark would accept without refresh. Run on a clone so the refresh case stays selected.
    const masked = markFamilyPendingDispatchedForHost({
      family: structuredClone(record.familySnapshot),
      dispatchId: childItem.dispatchId,
      at: dispatchedAt,
      memberState: childItem.memberState,
    });
    expect(masked.ok).toBe(true);

    // Refresh reads the advanced bag and mark fails with a clear stale code.
    const withRefresh = markFamilyPendingDispatchedWithRefreshedMemberState({
      familyRecord: record,
      dispatchId: childItem.dispatchId,
      at: dispatchedAt,
      memberGoalId: childItem.memberGoalId,
      memberWorkflowId: childItem.memberWorkflowId,
      liveState: rootState,
    });
    expect(withRefresh.ok).toBe(false);
    if (withRefresh.ok) return;
    expect(withRefresh.diagnostics[0]?.code).toBe("goal_family_dispatch_stale_selection");
    expect(withRefresh.diagnostics[0]?.message).toMatch(/snapshot/);
  });

  it("root+child batch mark succeeds after real sibling bag field advances", () => {
    const { family, rootState, memberStates } = createRootAndChildFamily("family-s5-root-child");

    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;
    const goals = selection.items.map((item) => item.memberGoalId).sort();
    expect(goals).toEqual(["goal-child", "goal-root"]);

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      resolvedConcurrencyPolicy: selection.concurrencyPolicy,
      createDispatchId: (index, item) => `s5-rc-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    let record = toPersisted(committed.family, memberStates);
    const markedGoalIds: string[] = [];
    for (const item of committed.items) {
      // Real intermediate sibling mutation: bump sequence and append an event.
      // Selected member hash stays valid for mark.
      const siblingId = item.memberGoalId === "goal-root" ? "workflow-child" : "workflow-root";
      const siblingBefore = record.workflows[siblingId]!.snapshot.sequence;
      record = advanceBagFieldsKeepHash(record, siblingId, {
        sequenceDelta: 3,
        eventId: `s5-sibling-advance-${item.memberGoalId}`,
      });
      expect(record.workflows[siblingId]!.snapshot.sequence).toBe(siblingBefore + 3);
      expect(record.workflows[siblingId]!.events).toHaveLength(1);

      const marked = markFamilyPendingDispatchedWithRefreshedMemberState({
        familyRecord: record,
        dispatchId: item.dispatchId,
        at: dispatchedAt,
        memberGoalId: item.memberGoalId,
        memberWorkflowId: item.memberWorkflowId,
        liveState: rootState,
      });
      expect(marked.ok).toBe(true);
      if (!marked.ok) return;
      expect(marked.memberState.snapshotHash).toBe(
        memberStates[item.memberGoalId as keyof typeof memberStates]!.snapshotHash,
      );
      if (item.memberGoalId === "goal-root") {
        expect(marked.isLiveRoot).toBe(true);
      } else {
        expect(marked.isLiveRoot).toBe(false);
      }
      record = {
        ...record,
        familySnapshot: marked.family,
      };
      markedGoalIds.push(item.memberGoalId);
    }

    expect(markedGoalIds.sort()).toEqual(["goal-child", "goal-root"]);
    expect(
      listPendingDispatches(record.familySnapshot).every((p) => p.status === "dispatched"),
    ).toBe(true);
  });

  it("start-time refresh attaches advanced bag fields and re-validates pending", () => {
    const { family, rootState, childState, memberStates } = createRootAndChildFamily(
      "family-s5-start-refresh",
    );
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
      createDispatchId: (index, item) => `s5-start-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    let record = toPersisted(committed.family, memberStates);
    // Mark all with refresh while bag matches selection hashes.
    for (const item of committed.items) {
      const marked = markFamilyPendingDispatchedWithRefreshedMemberState({
        familyRecord: record,
        dispatchId: item.dispatchId,
        at: dispatchedAt,
        memberGoalId: item.memberGoalId,
        memberWorkflowId: item.memberWorkflowId,
        liveState: rootState,
      });
      expect(marked.ok).toBe(true);
      if (!marked.ok) return;
      record = { ...record, familySnapshot: marked.family };
    }

    // Mid-pass bag advance after mark: sequence + event, same selection hash.
    const priorSequence = childState.sequence;
    record = advanceBagFieldsKeepHash(record, "workflow-child", {
      sequenceDelta: 11,
      eventId: "s5-child-post-mark-advance",
    });
    expect(record.workflows["workflow-child"]!.snapshot.sequence).toBe(priorSequence + 11);
    expect(record.workflows["workflow-child"]!.snapshot.snapshotHash).toBe(
      childState.snapshotHash,
    );
    expect(record.workflows["workflow-child"]!.events.map((e) => e.eventId)).toEqual([
      "s5-child-post-mark-advance",
    ]);

    const childItem = committed.items.find((item) => item.memberGoalId === "goal-child")!;
    const startRefresh = refreshFamilyProductMemberState({
      familyRecord: record,
      memberGoalId: childItem.memberGoalId,
      memberWorkflowId: childItem.memberWorkflowId,
      liveState: rootState,
    });
    expect(startRefresh.ok).toBe(true);
    if (!startRefresh.ok) return;
    // Start attaches updated bag fields, not the selection-time clone.
    expect(startRefresh.memberState).not.toBe(childItem.memberState);
    expect(startRefresh.memberState.sequence).toBe(priorSequence + 11);
    expect(startRefresh.memberState.snapshotHash).toBe(childState.snapshotHash);
    expect(startRefresh.memberState).toBe(record.workflows["workflow-child"]!.snapshot);
    expect(startRefresh.isLiveRoot).toBe(false);

    // Light re-check against pending still passes (hash and action valid).
    const stillValid = validateMemberStateAgainstFamilyPending({
      family: record.familySnapshot,
      dispatchId: childItem.dispatchId,
      memberState: startRefresh.memberState,
    });
    expect(stillValid.ok).toBe(true);

    // Hash advance after mark fails start validation with clear stale code.
    const hashAdvanced = advanceMemberHashInRecord(
      record,
      "workflow-child",
      "post-mark-stale-hash",
    );
    const staleStart = refreshFamilyProductMemberState({
      familyRecord: hashAdvanced,
      memberGoalId: childItem.memberGoalId,
      memberWorkflowId: childItem.memberWorkflowId,
      liveState: rootState,
    });
    expect(staleStart.ok).toBe(true);
    if (!staleStart.ok) return;
    const staleCheck = validateMemberStateAgainstFamilyPending({
      family: hashAdvanced.familySnapshot,
      dispatchId: childItem.dispatchId,
      memberState: staleStart.memberState,
    });
    expect(staleCheck.ok).toBe(false);
    if (staleCheck.ok) return;
    expect(staleCheck.diagnostics[0]?.code).toBe("goal_family_dispatch_stale_selection");
    expect(staleCheck.diagnostics[0]?.message).toMatch(/snapshot/);
  });

  it("extension concurrent and sequential paths refresh at mark/start with stable isLiveRoot", () => {
    const extensionSource = readFileSync(resolve(repoRoot, "src/extension.ts"), "utf8");
    expect(extensionSource).toMatch(/markFamilyPendingDispatchedWithRefreshedMemberState/);
    expect(extensionSource).toMatch(/refreshFamilyProductMemberState/);
    expect(extensionSource).toMatch(/validateMemberStateAgainstFamilyPending/);
    // Concurrent batch mark no longer passes selection-time item.memberState.
    expect(extensionSource).not.toMatch(
      /markFamilyPendingDispatchedForHost\(\{\s*family: familyRecord\.familySnapshot,\s*dispatchId: item\.dispatchId,[\s\S]*?memberState: item\.memberState/,
    );
    // Sequential mark no longer passes controller.memberState from selection.
    expect(extensionSource).not.toMatch(
      /memberState: controller\.memberState/,
    );
    // Concurrent start attaches refreshed content.
    expect(extensionSource).toMatch(/memberState: refreshed\.memberState/);
    expect(extensionSource).toMatch(/memberState: sequentialStart\.memberState/);
    // Start routing uses mark-time isLiveRoot, not re-derived free-slot occupancy.
    expect(extensionSource).toMatch(/isLiveRoot: item\.isLiveRoot/);
    expect(extensionSource).toMatch(/isLiveRoot: sequentialMarked\.isLiveRoot/);
    // Must not pass refreshed.isLiveRoot into dispatch at concurrent start.
    expect(extensionSource).not.toMatch(/isLiveRoot: refreshed\.isLiveRoot/);
    expect(extensionSource).not.toMatch(/isLiveRoot: sequentialStart\.isLiveRoot/);
  });
});
