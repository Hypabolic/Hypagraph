import { describe, expect, it } from "vitest";
import {
  completeFamilyAction,
  commitFamilySelection,
  enumerateFamilyPreferredDispatchables,
  enumerateFamilyRunnableCandidates,
  failFamilyAction,
  interruptFamilyAction,
  markFamilyActionDispatched,
  orderFamilyMembersForScheduler,
  selectFamilySchedulerAction,
} from "../src/domain/family-scheduler.js";
import {
  GOAL_FAMILY_EVENT_VERSION,
  GOAL_FAMILY_SCHEMA_VERSION,
  GoalFamilyRestoreError,
  addFamilyMember,
  applyFamilyEvent,
  createRootFamily,
  parseGoalContinuationActionPayload,
  rebuildFamilyMembershipFromSnapshot,
  replayFamilyEvents,
  restoreFamilyProjection,
  type GoalFamilyEvent,
  type GoalFamilyRuntime,
} from "../src/domain/goal-family.js";
import { selectGoalContinuation } from "../src/domain/goal-continuation.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { handleCommand } from "../src/domain/reducer.js";
import {
  assertPersistedGoalFamilyShape,
  buildOneMemberPersistedFamily,
} from "../src/persistence/family-store.js";

const at = "2026-07-29T16:00:00.000Z";
const later = "2026-07-29T16:05:00.000Z";
const doneAt = "2026-07-29T16:10:00.000Z";
const earlier = "2026-07-29T15:00:00.000Z";

const singleTask = (title: string): HypagraphDefinition => ({
  title,
  goal: title,
  nodes: [{ id: "work", title: "Work", requires: [], acceptance: [] }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const twoTasks = (title: string): HypagraphDefinition => ({
  title,
  goal: title,
  nodes: [
    { id: "first", title: "First", requires: [], acceptance: [] },
    { id: "second", title: "Second", requires: [], acceptance: [] },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const revisionEligibleDefinition = (): HypagraphDefinition => ({
  title: "Bounded repository delivery",
  goal: "Deliver the requested repository feature with its required checks.",
  nodes: [
    {
      id: "prepare",
      title: "Prepare",
      requires: [],
      acceptance: ["Record the repository change"],
      scope: { paths: ["src/**"] },
    },
    {
      id: "finish",
      title: "Finish",
      requires: ["prepare"],
      acceptance: ["Keep the required acceptance condition"],
    },
  ],
  loops: [],
  policy: { mode: "strict", requireEvidence: true },
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

const createRootOnlyFamily = (familyId = "family-scheduler") => {
  const root = createRootFamily({
    familyId,
    rootGoalId: "goal-root",
    rootWorkflowId: "workflow-root",
    at,
  });
  if (!root.ok) throw new Error(JSON.stringify(root.diagnostics));
  return root;
};

const createTwoMemberFamily = () => {
  const root = createRootOnlyFamily("family-multi");
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
  return {
    family: child.family,
    events: [...root.events, ...child.events],
  };
};

const validSelection = (family: GoalFamilyRuntime, rootState: HypagraphState) => ({
  familyId: family.familyId,
  goalId: "goal-root",
  workflowId: "workflow-root",
  revision: rootState.revision,
  nodeId: "work",
  action: { kind: "start-ready-task" as const, nodeId: "work" },
  reason: "Test selection.",
  selectedSequence: rootState.sequence,
  selectedSnapshotHash: rootState.snapshotHash,
  memberContinuationOrdinal: rootState.goal!.continuationOrdinal,
});

describe("M7-S3 family scheduler sequential dispatch", () => {
  it("selects the same action as root selectGoalContinuation for a one-member family", () => {
    const { family } = createRootOnlyFamily();
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const memberStates = { "goal-root": rootState };

    const rootDecision = selectGoalContinuation(rootState);
    const familyDecision = selectFamilySchedulerAction(family, memberStates);

    expect(rootDecision).toMatchObject({ kind: "start-ready-task", nodeId: "work" });
    expect(familyDecision.kind).toBe("select");
    if (familyDecision.kind !== "select") throw new Error("Expected select decision.");
    expect(familyDecision.candidate).toMatchObject({
      familyId: family.familyId,
      goalId: "goal-root",
      workflowId: "workflow-root",
      action: { kind: "start-ready-task", nodeId: "work" },
      revision: rootState.revision,
      selectedSequence: rootState.sequence,
      selectedSnapshotHash: rootState.snapshotHash,
    });
  });

  it("enumerates the union of runnable candidates across members in stable order", () => {
    const { family } = createTwoMemberFamily();
    const rootState = createMemberWorkflow(twoTasks("Root two"), "workflow-root", "goal-root");
    const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
    const memberStates = {
      "goal-root": rootState,
      "goal-child": childState,
    };

    const union = enumerateFamilyRunnableCandidates(family, memberStates);
    expect(union.map((item) => `${item.goalId}:${item.action.kind}:${"nodeId" in item.action ? item.action.nodeId : ""}`))
      .toEqual([
        "goal-root:start-ready-task:first",
        "goal-root:start-ready-task:second",
        "goal-child:start-ready-task:work",
      ]);

    const preferred = enumerateFamilyPreferredDispatchables(family, memberStates);
    expect(preferred).toHaveLength(2);
    expect(preferred[0]).toMatchObject({
      goalId: "goal-root",
      memberDepth: 0,
      action: { kind: "start-ready-task", nodeId: "first" },
    });
    expect(preferred[1]).toMatchObject({
      goalId: "goal-child",
      memberDepth: 1,
      action: { kind: "start-ready-task", nodeId: "work" },
    });
  });

  it("selects exactly one action for multi-member work with deterministic tie-breaking", () => {
    const { family } = createTwoMemberFamily();
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
    const memberStates = {
      "goal-root": rootState,
      "goal-child": childState,
    };

    const first = selectFamilySchedulerAction(family, memberStates);
    const second = selectFamilySchedulerAction(family, memberStates);

    expect(first).toEqual(second);
    expect(first.kind).toBe("select");
    if (first.kind !== "select") throw new Error("Expected select decision.");
    expect(first.candidate).toMatchObject({
      goalId: "goal-root",
      memberDepth: 0,
      action: { kind: "start-ready-task", nodeId: "work" },
    });
  });

  it("orders same-depth sibling members by goalId ascending", () => {
    const root = createRootOnlyFamily("family-siblings");
    const childA = addFamilyMember({
      family: root.family,
      goalId: "goal-b",
      workflowId: "workflow-b",
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
      goalId: "goal-a",
      workflowId: "workflow-a",
      parent: {
        parentGoalId: "goal-root",
        parentWorkflowId: "workflow-root",
        parentNodeId: "work",
      },
      at: doneAt,
    });
    if (!childB.ok) throw new Error(JSON.stringify(childB.diagnostics));

    // Pause root so only depth-1 siblings are preferred.
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const pausedRoot: HypagraphState = structuredClone(rootState);
    pausedRoot.goal = { ...pausedRoot.goal!, status: "paused", stopReason: "Pause root." };
    pausedRoot.phase = "paused";
    const stateB = createMemberWorkflow(singleTask("B work"), "workflow-b", "goal-b");
    const stateA = createMemberWorkflow(singleTask("A work"), "workflow-a", "goal-a");

    const decision = selectFamilySchedulerAction(childB.family, {
      "goal-root": pausedRoot,
      "goal-b": stateB,
      "goal-a": stateA,
    });
    expect(decision.kind).toBe("select");
    if (decision.kind !== "select") throw new Error("Expected select.");
    expect(decision.candidate.goalId).toBe("goal-a");
  });

  it("reports incomplete-input when pure select is missing member states", () => {
    const { family } = createTwoMemberFamily();
    const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
    const decision = selectFamilySchedulerAction(family, { "goal-child": childState });
    expect(decision.kind).toBe("incomplete-input");
    if (decision.kind !== "incomplete-input") throw new Error("Expected incomplete-input.");
    expect(decision.missingGoalIds).toEqual(["goal-root"]);
    expect(decision.mismatchedGoalIds).toEqual([]);
  });

  it("commits selection through family events and rejects a second select while pending", () => {
    const { family } = createRootOnlyFamily();
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const memberStates = { "goal-root": rootState };

    const first = commitFamilySelection({
      family,
      memberStates,
      at: later,
      dispatchId: "dispatch-1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("Expected first commit to succeed.");
    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.type).toBe("hypagraph.family.action-selected");
    expect(first.family.pendingDispatch).toMatchObject({
      dispatchId: "dispatch-1",
      status: "selected",
      selection: {
        goalId: "goal-root",
        action: { kind: "start-ready-task", nodeId: "work" },
      },
    });
    expect(first.family.schedulerOrdinal).toBe(family.schedulerOrdinal + 1);

    const second = commitFamilySelection({
      family: first.family,
      memberStates,
      at: doneAt,
      dispatchId: "dispatch-2",
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("Expected second commit to fail.");
    expect(second.diagnostics[0]?.code).toBe("goal_family_dispatch_pending");
  });

  it("prefers goal_family_dispatch_pending before member-state validation on commit", () => {
    const { family } = createRootOnlyFamily("family-pending-first");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const selected = commitFamilySelection({
      family,
      memberStates: { "goal-root": rootState },
      at: later,
      dispatchId: "dispatch-1",
    });
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));

    const second = commitFamilySelection({
      family: selected.family,
      memberStates: {},
      at: doneAt,
      dispatchId: "dispatch-2",
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("Expected pending rejection.");
    expect(second.diagnostics[0]?.code).toBe("goal_family_dispatch_pending");
  });

  it("allows interrupt while selected and then permits the next selection", () => {
    const { family } = createRootOnlyFamily("family-abort");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const memberStates = { "goal-root": rootState };

    const selected = commitFamilySelection({
      family,
      memberStates,
      at: later,
      dispatchId: "dispatch-abort",
    });
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));

    const interrupted = interruptFamilyAction({
      family: selected.family,
      dispatchId: "dispatch-abort",
      at: doneAt,
      reason: "Abort before dispatch.",
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) throw new Error(JSON.stringify(interrupted.diagnostics));
    expect(interrupted.family.pendingDispatch).toBeUndefined();
    expect(interrupted.family.lastDispatchOutcome).toMatchObject({
      dispatchId: "dispatch-abort",
      status: "interrupted",
      reason: "Abort before dispatch.",
    });
    expect(interrupted.family.lastDispatchOutcome?.dispatchedAt).toBeUndefined();

    const next = commitFamilySelection({
      family: interrupted.family,
      memberStates,
      at: doneAt,
      dispatchId: "dispatch-next",
    });
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error(JSON.stringify(next.diagnostics));
    expect(next.family.pendingDispatch?.dispatchId).toBe("dispatch-next");
  });

  it("allows the next selection after complete, fail, or interrupt of a dispatched action", () => {
    const { family: rootFamily } = createRootOnlyFamily("family-lifecycle");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const memberStates = { "goal-root": rootState };

    const runCycle = (
      family: GoalFamilyRuntime,
      dispatchId: string,
      terminal: "completed" | "failed" | "interrupted",
    ): GoalFamilyRuntime => {
      const selected = commitFamilySelection({
        family,
        memberStates,
        at: later,
        dispatchId,
      });
      if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));

      const dispatched = markFamilyActionDispatched({
        family: selected.family,
        dispatchId,
        at: later,
      });
      if (!dispatched.ok) throw new Error(JSON.stringify(dispatched.diagnostics));

      const finished =
        terminal === "completed"
          ? completeFamilyAction({ family: dispatched.family, dispatchId, at: doneAt })
          : terminal === "failed"
            ? failFamilyAction({
              family: dispatched.family,
              dispatchId,
              at: doneAt,
              reason: "The action failed.",
            })
            : interruptFamilyAction({
              family: dispatched.family,
              dispatchId,
              at: doneAt,
              reason: "The action was interrupted.",
            });
      if (!finished.ok) throw new Error(JSON.stringify(finished.diagnostics));
      expect(finished.family.pendingDispatch).toBeUndefined();
      expect(finished.family.lastDispatchOutcome?.status).toBe(terminal);
      return finished.family;
    };

    let family = runCycle(rootFamily, "dispatch-complete", "completed");
    family = runCycle(family, "dispatch-failed", "failed");
    family = runCycle(family, "dispatch-interrupted", "interrupted");

    const next = commitFamilySelection({
      family,
      memberStates,
      at: doneAt,
      dispatchId: "dispatch-next",
    });
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error(JSON.stringify(next.diagnostics));
    expect(next.family.pendingDispatch?.dispatchId).toBe("dispatch-next");
  });

  it("rejects reuse of a prior dispatchId", () => {
    const { family } = createRootOnlyFamily("family-reuse");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const memberStates = { "goal-root": rootState };

    const selected = commitFamilySelection({
      family,
      memberStates,
      at: later,
      dispatchId: "same",
    });
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));
    const interrupted = interruptFamilyAction({
      family: selected.family,
      dispatchId: "same",
      at: doneAt,
    });
    if (!interrupted.ok) throw new Error(JSON.stringify(interrupted.diagnostics));

    const reused = commitFamilySelection({
      family: interrupted.family,
      memberStates,
      at: doneAt,
      dispatchId: "same",
    });
    expect(reused.ok).toBe(false);
    if (reused.ok) throw new Error("Expected reuse rejection.");
    expect(reused.diagnostics[0]?.code).toBe("goal_family_dispatch_id_reused");
  });

  it("returns diagnostics for out-of-order timestamps instead of throwing", () => {
    const { family } = createRootOnlyFamily("family-ts-order");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const selected = commitFamilySelection({
      family,
      memberStates: { "goal-root": rootState },
      at: later,
      dispatchId: "dispatch-ts",
    });
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));

    const earlyDispatch = markFamilyActionDispatched({
      family: selected.family,
      dispatchId: "dispatch-ts",
      at: earlier,
    });
    expect(earlyDispatch.ok).toBe(false);
    if (earlyDispatch.ok) throw new Error("Expected timestamp-order rejection.");
    expect(earlyDispatch.diagnostics[0]?.code).toBe("goal_family_dispatch_timestamp_order");

    const dispatched = markFamilyActionDispatched({
      family: selected.family,
      dispatchId: "dispatch-ts",
      at: later,
    });
    if (!dispatched.ok) throw new Error(JSON.stringify(dispatched.diagnostics));

    const earlyComplete = completeFamilyAction({
      family: dispatched.family,
      dispatchId: "dispatch-ts",
      at: earlier,
    });
    expect(earlyComplete.ok).toBe(false);
    if (earlyComplete.ok) throw new Error("Expected complete timestamp rejection.");
    expect(earlyComplete.diagnostics[0]?.code).toBe("goal_family_dispatch_timestamp_order");
  });

  it("rejects a stale selection when markFamilyActionDispatched receives member state", () => {
    const { family } = createRootOnlyFamily("family-stale");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const selected = commitFamilySelection({
      family,
      memberStates: { "goal-root": rootState },
      at: later,
      dispatchId: "dispatch-stale",
    });
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));

    const advanced: HypagraphState = structuredClone(rootState);
    advanced.snapshotHash = "changed-snapshot-hash";

    const staleHash = markFamilyActionDispatched({
      family: selected.family,
      dispatchId: "dispatch-stale",
      at: later,
      memberState: advanced,
    });
    expect(staleHash.ok).toBe(false);
    if (staleHash.ok) throw new Error("Expected stale selection rejection.");
    expect(staleHash.diagnostics[0]?.code).toBe("goal_family_dispatch_stale_selection");
    expect(staleHash.diagnostics[0]?.message).toMatch(/snapshot/);

    const wrongIdentity: HypagraphState = structuredClone(rootState);
    wrongIdentity.workflowId = "workflow-other";
    const staleIdentity = markFamilyActionDispatched({
      family: selected.family,
      dispatchId: "dispatch-stale",
      at: later,
      memberState: wrongIdentity,
    });
    expect(staleIdentity.ok).toBe(false);
    if (staleIdentity.ok) throw new Error("Expected identity mismatch.");
    expect(staleIdentity.diagnostics[0]?.code).toBe("goal_family_dispatch_stale_selection");
    expect(staleIdentity.diagnostics[0]?.message).toMatch(/goal or workflow/);

    // Selection-consistency branch: snapshot hash matches a tampered hash on the pending
    // selection, but selectGoalContinuation no longer names the stored action.
    const actionChanged: GoalFamilyRuntime = structuredClone(selected.family);
    actionChanged.pendingDispatch = {
      ...actionChanged.pendingDispatch!,
      selection: {
        ...actionChanged.pendingDispatch!.selection,
        action: { kind: "start-ready-task", nodeId: "missing-node" },
        nodeId: "missing-node",
        selectedSnapshotHash: rootState.snapshotHash,
      },
    };
    const staleAction = markFamilyActionDispatched({
      family: actionChanged,
      dispatchId: "dispatch-stale",
      at: later,
      memberState: rootState,
    });
    expect(staleAction.ok).toBe(false);
    if (staleAction.ok) throw new Error("Expected selection-consistency rejection.");
    expect(staleAction.diagnostics[0]?.code).toBe("goal_family_dispatch_stale_selection");
    expect(staleAction.diagnostics[0]?.message).toMatch(/preferred dispatchable action/);

    const ok = markFamilyActionDispatched({
      family: selected.family,
      dispatchId: "dispatch-stale",
      at: later,
      memberState: rootState,
    });
    expect(ok.ok).toBe(true);
  });

  it("rejects interrupt of a dispatched action when at is earlier than dispatchedAt", () => {
    const { family } = createRootOnlyFamily("family-interrupt-order");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const selected = commitFamilySelection({
      family,
      memberStates: { "goal-root": rootState },
      at: later,
      dispatchId: "dispatch-order",
    });
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));
    const dispatched = markFamilyActionDispatched({
      family: selected.family,
      dispatchId: "dispatch-order",
      at: doneAt,
    });
    if (!dispatched.ok) throw new Error(JSON.stringify(dispatched.diagnostics));

    const earlyInterrupt = interruptFamilyAction({
      family: dispatched.family,
      dispatchId: "dispatch-order",
      at: later,
    });
    expect(earlyInterrupt.ok).toBe(false);
    if (earlyInterrupt.ok) throw new Error("Expected timestamp-order rejection.");
    expect(earlyInterrupt.diagnostics[0]?.code).toBe("goal_family_dispatch_timestamp_order");
  });

  it("restores scheduler selection state from family events", () => {
    const created = createRootOnlyFamily("family-restore");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const memberStates = { "goal-root": rootState };

    const selected = commitFamilySelection({
      family: created.family,
      memberStates,
      at: later,
      dispatchId: "dispatch-restore",
    });
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));

    const dispatched = markFamilyActionDispatched({
      family: selected.family,
      dispatchId: "dispatch-restore",
      at: later,
    });
    if (!dispatched.ok) throw new Error(JSON.stringify(dispatched.diagnostics));

    const events: GoalFamilyEvent[] = [
      ...created.events,
      ...selected.events,
      ...dispatched.events,
    ];
    const rebuilt = replayFamilyEvents(events);
    expect(rebuilt.pendingDispatch).toEqual(dispatched.family.pendingDispatch);
    expect(rebuilt.schedulerOrdinal).toBe(dispatched.family.schedulerOrdinal);

    const restored = restoreFamilyProjection(events, dispatched.family);
    expect(restored.pendingDispatch).toMatchObject({
      dispatchId: "dispatch-restore",
      status: "dispatched",
      selection: {
        goalId: "goal-root",
        action: { kind: "start-ready-task", nodeId: "work" },
      },
    });
  });

  it("accepts key-reordered pendingDispatch on restore via canonical comparison", () => {
    const created = createRootOnlyFamily("family-canonical");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const selected = commitFamilySelection({
      family: created.family,
      memberStates: { "goal-root": rootState },
      at: later,
      dispatchId: "dispatch-canonical",
    });
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));

    const events = [...created.events, ...selected.events];
    const reordered: GoalFamilyRuntime = {
      schemaVersion: selected.family.schemaVersion,
      updatedAt: selected.family.updatedAt,
      createdAt: selected.family.createdAt,
      schedulerOrdinal: selected.family.schedulerOrdinal,
      familyId: selected.family.familyId,
      rootGoalId: selected.family.rootGoalId,
      members: selected.family.members,
      bounds: selected.family.bounds,
      bindings: selected.family.bindings,
      familyBudget: selected.family.familyBudget,
      pendingDispatch: {
        status: selected.family.pendingDispatch!.status,
        selectedAt: selected.family.pendingDispatch!.selectedAt,
        schedulerOrdinal: selected.family.pendingDispatch!.schedulerOrdinal,
        dispatchId: selected.family.pendingDispatch!.dispatchId,
        selection: (() => {
          const source = selected.family.pendingDispatch!.selection;
          return {
            reason: source.reason,
            memberContinuationOrdinal: source.memberContinuationOrdinal,
            selectedSnapshotHash: source.selectedSnapshotHash,
            selectedSequence: source.selectedSequence,
            action: source.action,
            revision: source.revision,
            workflowId: source.workflowId,
            goalId: source.goalId,
            familyId: source.familyId,
            ...(source.nodeId !== undefined ? { nodeId: source.nodeId } : {}),
            ...(source.loopId !== undefined ? { loopId: source.loopId } : {}),
          };
        })(),
      },
    };

    expect(restoreFamilyProjection(events, reordered).pendingDispatch?.dispatchId).toBe("dispatch-canonical");
  });

  it("rejects restore when pendingDispatch or timestamps are tampered", () => {
    const created = createRootOnlyFamily("family-mismatch");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const selected = commitFamilySelection({
      family: created.family,
      memberStates: { "goal-root": rootState },
      at: later,
      dispatchId: "dispatch-mismatch",
    });
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));
    const events = [...created.events, ...selected.events];

    const tamperedPending = structuredClone(selected.family);
    tamperedPending.pendingDispatch = {
      ...tamperedPending.pendingDispatch!,
      dispatchId: "tampered-id",
    };
    expect(() => restoreFamilyProjection(events, tamperedPending)).toThrow(GoalFamilyRestoreError);
    expect(() => restoreFamilyProjection(events, tamperedPending)).toThrow(/pending dispatch|scheduler/i);

    const tamperedTime = structuredClone(selected.family);
    tamperedTime.updatedAt = "1999-01-01T00:00:00.000Z";
    expect(() => restoreFamilyProjection(events, tamperedTime)).toThrow(/timestamp/i);
  });

  it("rejects invalid scheduler state on snapshot rebuild", () => {
    const { family } = createRootOnlyFamily("family-validate");
    const bad: GoalFamilyRuntime = {
      ...family,
      pendingDispatch: {
        dispatchId: "",
        status: "dispatched",
        selectedAt: at,
        schedulerOrdinal: 999,
        selection: validSelection(family, createMemberWorkflow(singleTask("x"), "workflow-root", "goal-root")),
      },
    };
    expect(() => rebuildFamilyMembershipFromSnapshot(bad)).toThrow(GoalFamilyRestoreError);
  });

  it("advances schedulerOrdinal across membership and selection on one event sequence", () => {
    const root = createRootOnlyFamily("family-ordinal");
    expect(root.family.schedulerOrdinal).toBe(1);

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
    expect(child.family.schedulerOrdinal).toBe(2);

    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
    const selected = commitFamilySelection({
      family: child.family,
      memberStates: {
        "goal-root": rootState,
        "goal-child": childState,
      },
      at: doneAt,
      dispatchId: "dispatch-ordinal",
    });
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));
    expect(selected.family.schedulerOrdinal).toBe(3);
    expect(selected.family.pendingDispatch?.schedulerOrdinal).toBe(3);

    const events = [...root.events, ...child.events, ...selected.events];
    expect(replayFamilyEvents(events)).toEqual(selected.family);
  });

  it("returns idle when no member has dispatchable work", () => {
    const { family } = createRootOnlyFamily("family-idle");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const paused: HypagraphState = structuredClone(rootState);
    paused.goal = {
      ...paused.goal!,
      status: "paused",
      stopReason: "Paused for idle test.",
    };
    paused.phase = "paused";

    const decision = selectFamilySchedulerAction(family, { "goal-root": paused });
    expect(decision).toMatchObject({
      kind: "idle",
      reason: "No family member has a dispatchable continuation action.",
    });

    const committed = commitFamilySelection({
      family,
      memberStates: { "goal-root": paused },
      at: later,
      dispatchId: "dispatch-idle",
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error(JSON.stringify(committed.diagnostics));
    expect(committed.events).toEqual([]);
    expect(committed.family.pendingDispatch).toBeUndefined();
    expect(committed.family.schedulerOrdinal).toBe(family.schedulerOrdinal);
  });

  it("rejects commit when a member state is missing or mismatched", () => {
    const { family } = createTwoMemberFamily();
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const missing = commitFamilySelection({
      family,
      memberStates: { "goal-root": rootState },
      at: later,
      dispatchId: "dispatch-missing",
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("Expected missing member state rejection.");
    expect(missing.diagnostics[0]?.code).toBe("goal_family_member_state_missing");

    const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
    const wrongWorkflow = structuredClone(rootState);
    wrongWorkflow.workflowId = "workflow-other";
    const mismatch = commitFamilySelection({
      family,
      memberStates: {
        "goal-root": wrongWorkflow,
        "goal-child": childState,
      },
      at: later,
      dispatchId: "dispatch-mismatch",
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) throw new Error("Expected mismatch rejection.");
    expect(mismatch.diagnostics[0]?.code).toBe("goal_family_member_state_mismatch");
  });

  it("rejects mark dispatched and terminal helpers without a valid pending dispatch", () => {
    const { family } = createRootOnlyFamily("family-reject");

    const missing = markFamilyActionDispatched({
      family,
      dispatchId: "missing",
      at: later,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("Expected missing dispatch rejection.");
    expect(missing.diagnostics[0]?.code).toBe("goal_family_dispatch_missing");

    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const selected = commitFamilySelection({
      family,
      memberStates: { "goal-root": rootState },
      at: later,
      dispatchId: "dispatch-1",
    });
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));

    const wrongId = markFamilyActionDispatched({
      family: selected.family,
      dispatchId: "other",
      at: later,
    });
    expect(wrongId.ok).toBe(false);
    if (wrongId.ok) throw new Error("Expected dispatch id mismatch.");
    expect(wrongId.diagnostics[0]?.code).toBe("goal_family_dispatch_id_mismatch");

    const beforeDispatch = completeFamilyAction({
      family: selected.family,
      dispatchId: "dispatch-1",
      at: doneAt,
    });
    expect(beforeDispatch.ok).toBe(false);
    if (beforeDispatch.ok) throw new Error("Expected not-dispatched rejection.");
    expect(beforeDispatch.diagnostics[0]?.code).toBe("goal_family_dispatch_not_dispatched");

    const dispatched = markFamilyActionDispatched({
      family: selected.family,
      dispatchId: "dispatch-1",
      at: later,
    });
    if (!dispatched.ok) throw new Error(JSON.stringify(dispatched.diagnostics));

    const already = markFamilyActionDispatched({
      family: dispatched.family,
      dispatchId: "dispatch-1",
      at: doneAt,
    });
    expect(already.ok).toBe(false);
    if (already.ok) throw new Error("Expected already-dispatched rejection.");
    expect(already.diagnostics[0]?.code).toBe("goal_family_dispatch_already_dispatched");
  });

  it("rejects empty dispatch ID, invalid timestamp, and unsupported schema on helpers", () => {
    const { family } = createRootOnlyFamily("family-inputs");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");

    const emptyId = commitFamilySelection({
      family,
      memberStates: { "goal-root": rootState },
      at: later,
      dispatchId: "  ",
    });
    expect(emptyId.ok).toBe(false);
    if (emptyId.ok) throw new Error("Expected empty dispatch id rejection.");
    expect(emptyId.diagnostics[0]?.code).toBe("invalid_goal_family_dispatch_id");

    const badAt = commitFamilySelection({
      family,
      memberStates: { "goal-root": rootState },
      at: "not-a-date",
      dispatchId: "dispatch-1",
    });
    expect(badAt.ok).toBe(false);
    if (badAt.ok) throw new Error("Expected timestamp rejection.");
    expect(badAt.diagnostics[0]?.code).toBe("invalid_goal_family_timestamp");

    const unsupported = {
      ...family,
      schemaVersion: 99 as typeof GOAL_FAMILY_SCHEMA_VERSION,
    };
    const schemaReject = commitFamilySelection({
      family: unsupported,
      memberStates: { "goal-root": rootState },
      at: later,
      dispatchId: "dispatch-1",
    });
    expect(schemaReject.ok).toBe(false);
    if (schemaReject.ok) throw new Error("Expected schema rejection.");
    expect(schemaReject.diagnostics[0]?.code).toBe("unsupported_goal_family_schema");

    for (const helper of [
      () => markFamilyActionDispatched({ family, dispatchId: "", at: later }),
      () => completeFamilyAction({ family, dispatchId: "x", at: "bad" }),
      () => failFamilyAction({ family, dispatchId: "", at: later }),
      () => interruptFamilyAction({ family, dispatchId: "x", at: "bad" }),
    ]) {
      const result = helper();
      expect(result.ok).toBe(false);
    }
  });

  it("rejects malformed continuation action payloads", () => {
    expect(parseGoalContinuationActionPayload({ kind: "start-ready-task" }).ok).toBe(false);
    expect(parseGoalContinuationActionPayload({ kind: "request-revision" }).ok).toBe(false);
    expect(parseGoalContinuationActionPayload({ kind: "totally-unknown-kind" }).ok).toBe(false);
    expect(parseGoalContinuationActionPayload({
      kind: "start-ready-task",
      nodeId: "work",
    }).ok).toBe(true);
    expect(parseGoalContinuationActionPayload({
      kind: "request-revision",
      blocker: {
        kind: "blocked-node",
        id: "prepare",
        reason: "Blocked.",
        sourceRevision: 1,
        sourceSequence: 2,
        sourceSnapshotHash: "hash",
      },
    }).ok).toBe(true);

    const { family } = createRootOnlyFamily("family-bad-action");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const badEvent: GoalFamilyEvent = {
      eventId: "bad-selected",
      familyId: family.familyId,
      sequence: family.schedulerOrdinal + 1,
      type: "hypagraph.family.action-selected",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: later,
      causationId: "c",
      correlationId: "c",
      data: {
        dispatchId: "dispatch-bad",
        selection: {
          ...validSelection(family, rootState),
          action: { kind: "start-ready-task" } as never,
        },
      },
    };
    expect(() => applyFamilyEvent(family, badEvent)).toThrow(/continuation action|nodeId/i);
  });

  it("lifts request-revision and dispatches it with unchanged member state", () => {
    const created = createHypagoalWorkflow(revisionEligibleDefinition(), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const blocked = handleCommand(created.state, {
      type: "block-node",
      nodeId: "prepare",
      reason: "A bounded migration step is missing.",
      blockerKind: "repository-work",
      commandId: "block",
      at: later,
    });
    if (!blocked.ok) throw new Error(JSON.stringify(blocked.diagnostics));

    const rootDecision = selectGoalContinuation(blocked.state);
    expect(rootDecision).toMatchObject({ kind: "request-revision", blocker: { kind: "blocked-node", id: "prepare" } });

    const { family } = createRootOnlyFamily("family-revision");
    const preferred = enumerateFamilyPreferredDispatchables(family, { "goal-root": blocked.state });
    expect(preferred).toHaveLength(1);
    expect(preferred[0]?.action).toMatchObject({
      kind: "request-revision",
      blocker: { kind: "blocked-node", id: "prepare" },
    });
    expect(preferred[0]?.nodeId).toBeUndefined();
    expect("nodeId" in (preferred[0]?.action ?? {})).toBe(false);

    const decision = selectFamilySchedulerAction(family, { "goal-root": blocked.state });
    expect(decision.kind).toBe("select");
    if (decision.kind !== "select") throw new Error("Expected select.");
    expect(decision.candidate.action.kind).toBe("request-revision");

    const selected = commitFamilySelection({
      family,
      memberStates: { "goal-root": blocked.state },
      at: later,
      dispatchId: "dispatch-revision",
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));
    expect(selected.family.pendingDispatch?.selection.action.kind).toBe("request-revision");
    expect(selected.family.pendingDispatch?.selection.nodeId).toBeUndefined();

    const dispatched = markFamilyActionDispatched({
      family: selected.family,
      dispatchId: "dispatch-revision",
      at: doneAt,
      memberState: blocked.state,
    });
    expect(dispatched.ok).toBe(true);
    if (!dispatched.ok) throw new Error(JSON.stringify(dispatched.diagnostics));
    expect(dispatched.family.pendingDispatch?.status).toBe("dispatched");
  });

  it("rejects selection identity nodeId that disagrees with the action", () => {
    const { family } = createRootOnlyFamily("family-identity");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const badEvent: GoalFamilyEvent = {
      eventId: "bad-identity",
      familyId: family.familyId,
      sequence: family.schedulerOrdinal + 1,
      type: "hypagraph.family.action-selected",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: later,
      causationId: "c",
      correlationId: "c",
      data: {
        dispatchId: "dispatch-identity",
        selection: {
          ...validSelection(family, rootState),
          nodeId: "second",
          action: { kind: "start-ready-task", nodeId: "first" },
        },
      },
    };
    expect(() => applyFamilyEvent(family, badEvent)).toThrow(/nodeId.*does not match/i);

    const created = createHypagoalWorkflow(singleTask("Store identity"), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const base = buildOneMemberPersistedFamily({
      familyId: "family-store-identity",
      rootGoalId: "goal-root",
      workflow: { events: created.events, snapshot: created.state },
      at,
    });
    const badShape = {
      ...base,
      familyEvents: [
        ...base.familyEvents,
        {
          eventId: "bad-identity-store",
          familyId: base.familySnapshot.familyId,
          sequence: 2,
          type: "hypagraph.family.action-selected",
          version: GOAL_FAMILY_EVENT_VERSION,
          timestamp: later,
          causationId: "c",
          correlationId: "c",
          data: {
            dispatchId: "d1",
            selection: {
              ...validSelection(base.familySnapshot, created.state),
              nodeId: "second",
              action: { kind: "start-ready-task", nodeId: "first" },
            },
          },
        },
      ],
    };
    expect(() => assertPersistedGoalFamilyShape(badShape)).toThrow(/nodeId/i);
  });

  it("rejects replay of a second action-selected while pending and mismatched terminal events", () => {
    const created = createRootOnlyFamily("family-replay-guards");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const selected = commitFamilySelection({
      family: created.family,
      memberStates: { "goal-root": rootState },
      at: later,
      dispatchId: "dispatch-replay",
    });
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));

    const secondSelect: GoalFamilyEvent = {
      eventId: "second-select",
      familyId: selected.family.familyId,
      sequence: selected.family.schedulerOrdinal + 1,
      type: "hypagraph.family.action-selected",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: doneAt,
      causationId: "c",
      correlationId: "c",
      data: {
        dispatchId: "dispatch-other",
        selection: validSelection(selected.family, rootState),
      },
    };
    expect(() => applyFamilyEvent(selected.family, secondSelect)).toThrow(/pending dispatch/i);

    const terminalBeforeDispatch: GoalFamilyEvent = {
      eventId: "term-early",
      familyId: selected.family.familyId,
      sequence: selected.family.schedulerOrdinal + 1,
      type: "hypagraph.family.action-completed",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: doneAt,
      causationId: "c",
      correlationId: "c",
      data: { dispatchId: "dispatch-replay" },
    };
    expect(() => applyFamilyEvent(selected.family, terminalBeforeDispatch)).toThrow(/dispatched/i);

    const wrongDispatch: GoalFamilyEvent = {
      eventId: "wrong-id",
      familyId: selected.family.familyId,
      sequence: selected.family.schedulerOrdinal + 1,
      type: "hypagraph.family.action-dispatched",
      version: GOAL_FAMILY_EVENT_VERSION,
      timestamp: doneAt,
      causationId: "c",
      correlationId: "c",
      data: { dispatchId: "not-the-pending" },
    };
    expect(() => applyFamilyEvent(selected.family, wrongDispatch)).toThrow(/different dispatch|pending dispatch is/i);
  });

  it("validates family-store shape for scheduler events and rejects unknown types", () => {
    const created = createHypagoalWorkflow(singleTask("Store shape"), {
      workflowId: "workflow-root",
      goalId: "goal-root",
      goalWorkflowId: "workflow-root",
      at,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const base = buildOneMemberPersistedFamily({
      familyId: "family-store-shape",
      rootGoalId: "goal-root",
      workflow: { events: created.events, snapshot: created.state },
      at,
    });

    const selected = commitFamilySelection({
      family: base.familySnapshot,
      memberStates: { "goal-root": created.state },
      at: later,
      dispatchId: "dispatch-store",
    });
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));
    const withSelection = {
      ...base,
      familyEvents: [...base.familyEvents, ...selected.events],
      familySnapshot: selected.family,
    };
    expect(() => assertPersistedGoalFamilyShape(withSelection)).not.toThrow();

    const unknownType = {
      ...base,
      familyEvents: [
        ...base.familyEvents,
        {
          eventId: "unknown",
          familyId: base.familySnapshot.familyId,
          sequence: 2,
          type: "hypagraph.family.who-knows",
          version: GOAL_FAMILY_EVENT_VERSION,
          timestamp: later,
          causationId: "c",
          correlationId: "c",
          data: {},
        },
      ],
    };
    expect(() => assertPersistedGoalFamilyShape(unknownType)).toThrow(/unsupported type/i);

    const badAction = {
      ...base,
      familyEvents: [
        ...base.familyEvents,
        {
          eventId: "bad-action",
          familyId: base.familySnapshot.familyId,
          sequence: 2,
          type: "hypagraph.family.action-selected",
          version: GOAL_FAMILY_EVENT_VERSION,
          timestamp: later,
          causationId: "c",
          correlationId: "c",
          data: {
            dispatchId: "d1",
            selection: {
              ...validSelection(base.familySnapshot, created.state),
              action: { kind: "start-ready-task" },
            },
          },
        },
      ],
    };
    expect(() => assertPersistedGoalFamilyShape(badAction)).toThrow(/action is invalid|nodeId/i);
  });

  it("does not mutate input family or ordered member references", () => {
    const { family } = createRootOnlyFamily("family-pure");
    const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
    const familyBefore = structuredClone(family);
    const stateBefore = structuredClone(rootState);

    const ordered = orderFamilyMembersForScheduler(family);
    ordered[0]!.goalId = "mutated";
    expect(family.members["goal-root"]?.goalId).toBe("goal-root");

    const selected = commitFamilySelection({
      family,
      memberStates: { "goal-root": rootState },
      at: later,
      dispatchId: "dispatch-pure",
    });
    if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));

    expect(family).toEqual(familyBefore);
    expect(rootState).toEqual(stateBefore);
    expect(selected.family).not.toBe(family);
  });
});
