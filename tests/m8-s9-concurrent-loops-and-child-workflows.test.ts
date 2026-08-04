import { describe, expect, it } from "vitest";
import { createBoundedChildGoal } from "../src/domain/child-goal-creation.js";
import {
  CONCURRENCY_STATE_SCHEMA_VERSION,
  DEFAULT_GLOBAL_CONCURRENCY,
  createEmptyConcurrencyState,
} from "../src/domain/concurrency-limits.js";
import {
  CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
  createEmptyConcurrencyGroupState,
} from "../src/domain/concurrency-groups.js";
import {
  FAMILY_CONCURRENT_OCCUPANCY_SCHEMA_VERSION,
  buildFamilyConcurrentAttemptId,
  commitFamilySelection,
  defaultFamilyConcurrentBatchCapacity,
  encodeFamilyConcurrentIdField,
  enumerateFamilyConcurrentCandidates,
  enumerateFamilyPreferredDispatchables,
  enumerateFamilyRunnableCandidates,
  familyConcurrentSelectionAllowsOverlapWithPending,
  liftFamilyConcurrentCandidates,
  parseFamilyConcurrentLeaseSet,
  parseFamilyPendingDispatchOwnData,
  selectFamilyConcurrentActions,
  selectFamilyConcurrentBatchFromCandidates,
  selectFamilySchedulerAction,
  validateFamilyConcurrentOccupancySchema,
  validateLeaseHolderMatchesCandidate,
  workspaceLeasesCanonicallyEqual,
} from "../src/domain/family-scheduler.js";
import {
  GOAL_FAMILY_SCHEMA_VERSION,
  addFamilyMember,
  createRootFamily,
  type GoalFamilyRuntime,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { handleCommand } from "../src/domain/reducer.js";
import {
  createEmptyWorkspaceLeaseSet,
  type WorkspaceLease,
} from "../src/domain/workspace-lease.js";

const at = "2026-07-29T20:00:00.000Z";
const later = "2026-07-29T20:05:00.000Z";
const doneAt = "2026-07-29T20:10:00.000Z";

const singleTask = (title: string, scopePaths?: string[]): HypagraphDefinition => ({
  title,
  goal: title,
  nodes: [{
    id: "work",
    title: "Work",
    requires: [],
    acceptance: [],
    ...(scopePaths ? { scope: { paths: scopePaths } } : {}),
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

const independentRootAndSibling = (): HypagraphDefinition => ({
  title: "Root with independent branch",
  goal: "Root with independent branch",
  nodes: [
    {
      id: "parent-task",
      title: "Parent task",
      requires: [],
      acceptance: [],
      scope: { paths: ["src/**"] },
    },
    {
      id: "independent-loop-work",
      title: "Independent loop work",
      requires: [],
      acceptance: [],
      scope: { paths: ["docs/**"] },
    },
  ],
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

const startTask = (
  state: HypagraphState,
  nodeId: string,
  attemptId = `attempt-${nodeId}`,
): HypagraphState => {
  const result = handleCommand(state, {
    type: "start-node",
    nodeId,
    attemptId,
    commandId: `start-${nodeId}`,
    correlationId: `start-${nodeId}`,
    at: later,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.state;
};

const createRootOnlyFamily = (familyId = "family-m8-s9") => {
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
  const root = createRootOnlyFamily("family-m8-s9-multi");
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

const exclusiveLease = (
  leaseId: string,
  attemptId: string,
  writePaths: string[],
  holder: {
    familyId: string;
    goalId: string;
    workflowId: string;
    revision: number;
    nodeId: string;
  },
): WorkspaceLease => ({
  leaseId,
  mode: "exclusive",
  holder: {
    ...holder,
    attemptId,
  },
  paths: {
    readPaths: [],
    writePaths,
  },
});

describe("m8-s9 concurrent loops and child workflows", () => {
  describe("defaults and sequential compatibility", () => {
    it("uses default concurrent batch capacity of two", () => {
      expect(DEFAULT_GLOBAL_CONCURRENCY).toBe(2);
      expect(defaultFamilyConcurrentBatchCapacity()).toBe(2);
    });

    it("keeps sequential selection blocked while pendingDispatch is set", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
      const memberStates = {
        "goal-root": rootState,
        "goal-child": childState,
      };

      const committed = commitFamilySelection({
        family,
        memberStates,
        at: later,
        dispatchId: "dispatch-child-first",
      });
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;

      // Sequential still selects root first by depth policy when no pending.
      // After commit of root, sequential blocks.
      const sequential = selectFamilySchedulerAction(committed.family, memberStates);
      expect(sequential.kind).toBe("blocked-pending");
    });
  });

  describe("independent loop remains selectable with child occupancy", () => {
    it("selects an independent root candidate while a child has pending dispatch", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
      const memberStates = {
        "goal-root": rootState,
        "goal-child": childState,
      };

      // Force child selection into pending by temporarily removing root readiness:
      // commit when only child is dispatchable, then restore root for concurrent select.
      const pausedRoot: HypagraphState = structuredClone(rootState);
      pausedRoot.goal = {
        ...pausedRoot.goal!,
        status: "paused",
        stopReason: "Pause root while child is selected.",
      };
      pausedRoot.phase = "paused";

      const childOnlyCommit = commitFamilySelection({
        family,
        memberStates: {
          "goal-root": pausedRoot,
          "goal-child": childState,
        },
        at: later,
        dispatchId: "dispatch-child",
      });
      expect(childOnlyCommit.ok).toBe(true);
      if (!childOnlyCommit.ok) return;
      expect(childOnlyCommit.family.pendingDispatches[Object.keys(childOnlyCommit.family.pendingDispatches)[0]!]?.selection.goalId).toBe("goal-child");

      // Sequential path remains blocked.
      const sequential = selectFamilySchedulerAction(childOnlyCommit.family, {
        "goal-root": rootState,
        "goal-child": childState,
      });
      expect(sequential.kind).toBe("blocked-pending");

      // Concurrent path still selects the independent root loop/work.
      const concurrent = selectFamilyConcurrentActions({
        family: childOnlyCommit.family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
      });
      expect(concurrent.kind).toBe("select-batch");
      if (concurrent.kind !== "select-batch") return;
      expect(concurrent.candidates).toHaveLength(1);
      expect(concurrent.candidates[0]).toMatchObject({
        goalId: "goal-root",
        action: { kind: "start-ready-task", nodeId: "work" },
      });
      expect(concurrent.occupancy.occupiedAttemptIds.length).toBeGreaterThanOrEqual(2);
      expect(
        familyConcurrentSelectionAllowsOverlapWithPending(childOnlyCommit.family, {
          "goal-root": rootState,
          "goal-child": childState,
        }),
      ).toBe(true);
    });

    it("keeps independent root work enumerable after child creation", () => {
      const root = createRootOnlyFamily("family-child-create");
      let rootState = createMemberWorkflow(
        independentRootAndSibling(),
        "workflow-root",
        "goal-root",
      );
      rootState = startTask(rootState, "parent-task", "attempt-parent");

      const childDefinition = singleTask("Child goal work", ["src/domain/**"]);
      const created = createBoundedChildGoal({
        family: root.family,
        parentState: rootState,
        parentNodeId: "parent-task",
        childDefinition,
        childGoalId: "goal-child",
        childWorkflowId: "workflow-child",
        bindingId: "binding-child-1",
        at: later,
        scopePaths: ["src/domain/**"],
        budget: { maximumTurns: 2, maximumTokens: 1000 },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const memberStates = {
        "goal-root": created.parentState,
        "goal-child": created.childState,
      };

      // Independent sibling on the root remains in the runnable union.
      const runnable = enumerateFamilyRunnableCandidates(created.family, memberStates);
      const independent = runnable.filter(
        (item) =>
          item.goalId === "goal-root"
          && "nodeId" in item.action
          && item.action.nodeId === "independent-loop-work",
      );
      expect(independent.length).toBeGreaterThanOrEqual(1);

      // Concurrent enumeration must still surface independent root work.
      const concurrentEnum = enumerateFamilyConcurrentCandidates(
        created.family,
        memberStates,
        { candidateSource: "runnable" },
      );
      expect(concurrentEnum.ok).toBe(true);
      if (!concurrentEnum.ok || !("candidates" in concurrentEnum)) return;
      expect(
        concurrentEnum.candidates.some(
          (item) =>
            item.goalId === "goal-root"
            && "nodeId" in item.action
            && item.action.nodeId === "independent-loop-work",
        ),
      ).toBe(true);

      // Child creation must not clear root goal lifecycle or independent work.
      expect(created.parentState.goal?.status).not.toBe("failed");
      expect(created.parentState.goal?.status).not.toBe("completed");
      expect(created.parentState.runtime.nodes["independent-loop-work"]?.status).toBe("ready");
      expect(created.parentState.runtime.nodes["parent-task"]?.status).toBe("waiting_for_child");
    });
  });

  describe("multi-candidate concurrent batch", () => {
    it("selects root and child together when limits, groups, and leases allow", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
      const memberStates = {
        "goal-root": rootState,
        "goal-child": childState,
      };

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates,
      });

      expect(decision.kind).toBe("select-batch");
      if (decision.kind !== "select-batch") return;
      expect(decision.candidates).toHaveLength(2);
      expect(decision.candidates.map((item) => item.goalId).sort()).toEqual([
        "goal-child",
        "goal-root",
      ]);
      // Capacity occupancy includes both selected attempts.
      expect(decision.occupancy.concurrencyState.attempts).toHaveLength(2);
    });

    it("respects the default global concurrency of two for batch size", () => {
      const root = createRootOnlyFamily("family-three");
      const childA = addFamilyMember({
        family: root.family,
        goalId: "goal-a",
        workflowId: "workflow-a",
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
        goalId: "goal-b",
        workflowId: "workflow-b",
        parent: {
          parentGoalId: "goal-root",
          parentWorkflowId: "workflow-root",
          parentNodeId: "work",
        },
        at: doneAt,
      });
      if (!childB.ok) throw new Error(JSON.stringify(childB.diagnostics));

      // Three dispatchable members. Default global concurrency admits only two.
      const readyRoot = createMemberWorkflow(singleTask("Root ready"), "workflow-root", "goal-root");
      const stateA = createMemberWorkflow(singleTask("A"), "workflow-a", "goal-a");
      const stateB = createMemberWorkflow(singleTask("B"), "workflow-b", "goal-b");

      const decision = selectFamilyConcurrentActions({
        family: childB.family,
        memberStates: {
          "goal-root": readyRoot,
          "goal-a": stateA,
          "goal-b": stateB,
        },
      });
      expect(decision.kind).toBe("select-batch");
      if (decision.kind !== "select-batch") return;
      expect(decision.candidates.length).toBe(2);
      expect(decision.candidates.length).toBeLessThanOrEqual(DEFAULT_GLOBAL_CONCURRENCY);
    });

    it("respects an explicit maxBatchSize of one", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        maxBatchSize: 1,
      });
      expect(decision.kind).toBe("select-batch");
      if (decision.kind !== "select-batch") return;
      expect(decision.candidates).toHaveLength(1);
      // Fairness may prefer either member when ready sequences tie.
      expect(["goal-root", "goal-child"]).toContain(decision.candidates[0]?.goalId);
    });
  });

  describe("group and lease incompatibility", () => {
    it("prevents unsafe overlap when candidates share an exclusive concurrency group", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        groupRegistry: {
          groups: [{ groupId: "exclusive-family", maxConcurrent: 1 }],
        },
        attributesByGoalId: {
          "goal-root": { groupIds: ["exclusive-family"] },
          "goal-child": { groupIds: ["exclusive-family"] },
        },
      });

      expect(decision.kind).toBe("select-batch");
      if (decision.kind !== "select-batch") return;
      // Exclusive group admits only one of the two members.
      expect(decision.candidates).toHaveLength(1);
    });

    it("prevents unsafe overlap when proposed exclusive leases conflict", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
        "goal-child": childState,
      });
      const rootPreferred = preferred.find((item) => item.goalId === "goal-root");
      const childPreferred = preferred.find((item) => item.goalId === "goal-child");
      expect(rootPreferred).toBeDefined();
      expect(childPreferred).toBeDefined();
      if (!rootPreferred || !childPreferred) return;

      const rootAttemptId = buildFamilyConcurrentAttemptId(rootPreferred);
      const childAttemptId = buildFamilyConcurrentAttemptId(childPreferred);

      const rootLease = exclusiveLease(
        "lease-root",
        rootAttemptId,
        ["src/**"],
        {
          familyId: family.familyId,
          goalId: "goal-root",
          workflowId: "workflow-root",
          revision: rootState.revision,
          nodeId: "work",
        },
      );
      const childLease = exclusiveLease(
        "lease-child",
        childAttemptId,
        ["src/**"],
        {
          familyId: family.familyId,
          goalId: "goal-child",
          workflowId: "workflow-child",
          revision: childState.revision,
          nodeId: "work",
        },
      );

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        attributesByAttemptId: {
          [rootAttemptId]: { lease: rootLease },
          [childAttemptId]: { lease: childLease },
        },
      });

      expect(decision.kind).toBe("select-batch");
      if (decision.kind !== "select-batch") return;
      // Conflicting exclusive write scopes must not both run.
      expect(decision.candidates).toHaveLength(1);
      expect(decision.occupancy.leaseSet.leases).toHaveLength(1);
    });

    it("admits two candidates with non-overlapping exclusive leases", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
        "goal-child": childState,
      });
      const rootPreferred = preferred.find((item) => item.goalId === "goal-root")!;
      const childPreferred = preferred.find((item) => item.goalId === "goal-child")!;
      const rootAttemptId = buildFamilyConcurrentAttemptId(rootPreferred);
      const childAttemptId = buildFamilyConcurrentAttemptId(childPreferred);

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        attributesByAttemptId: {
          [rootAttemptId]: {
            lease: exclusiveLease(
              "lease-root",
              rootAttemptId,
              ["src/**"],
              {
                familyId: family.familyId,
                goalId: "goal-root",
                workflowId: "workflow-root",
                revision: rootState.revision,
                nodeId: "work",
              },
            ),
          },
          [childAttemptId]: {
            lease: exclusiveLease(
              "lease-child",
              childAttemptId,
              ["docs/**"],
              {
                familyId: family.familyId,
                goalId: "goal-child",
                workflowId: "workflow-child",
                revision: childState.revision,
                nodeId: "work",
              },
            ),
          },
        },
      });

      expect(decision.kind).toBe("select-batch");
      if (decision.kind !== "select-batch") return;
      expect(decision.candidates).toHaveLength(2);
      expect(decision.occupancy.leaseSet.leases).toHaveLength(2);
    });
  });

  describe("purity, schema, and input validation", () => {
    it("does not mutate family, member states, or occupancy inputs", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
      const memberStates = {
        "goal-root": rootState,
        "goal-child": childState,
      };
      const concurrencyState = createEmptyConcurrencyState();
      const groupState = createEmptyConcurrencyGroupState();
      const leaseSet = createEmptyWorkspaceLeaseSet();

      const familyBefore = structuredClone(family);
      const membersBefore = structuredClone(memberStates);
      const concurrencyBefore = structuredClone(concurrencyState);
      const groupBefore = structuredClone(groupState);
      const leasesBefore = structuredClone(leaseSet);

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates,
        concurrencyState,
        groupState,
        leaseSet,
      });
      expect(decision.kind).toBe("select-batch");

      expect(family).toEqual(familyBefore);
      expect(memberStates).toEqual(membersBefore);
      expect(concurrencyState).toEqual(concurrencyBefore);
      expect(groupState).toEqual(groupBefore);
      expect(leaseSet).toEqual(leasesBefore);
    });

    it("rejects an unsupported goal-family schema version", () => {
      const { family } = createRootOnlyFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const badFamily = {
        ...family,
        schemaVersion: 999 as typeof GOAL_FAMILY_SCHEMA_VERSION,
      } as GoalFamilyRuntime;

      const decision = selectFamilyConcurrentActions({
        family: badFamily,
        memberStates: { "goal-root": rootState },
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(decision.diagnostics[0]?.code).toBe("unsupported_goal_family_schema");
    });

    it("rejects unsupported concurrent occupancy schema versions", () => {
      const ok = validateFamilyConcurrentOccupancySchema({
        schemaVersion: FAMILY_CONCURRENT_OCCUPANCY_SCHEMA_VERSION,
      });
      expect(ok).toEqual([]);

      const bad = validateFamilyConcurrentOccupancySchema({
        schemaVersion: 99,
      });
      expect(bad.some((d) => d.code === "family_concurrent_occupancy_unsupported_schema")).toBe(
        true,
      );

      const missing = validateFamilyConcurrentOccupancySchema({});
      expect(missing.some((d) => d.code === "family_concurrent_occupancy_unsupported_schema")).toBe(
        true,
      );

      const notPlain = validateFamilyConcurrentOccupancySchema(new Date());
      expect(notPlain.some((d) => d.code === "family_concurrent_occupancy_not_plain_object")).toBe(
        true,
      );
    });

    it("reports incomplete-input when member states are missing", () => {
      const { family } = createTwoMemberFamily();
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: { "goal-child": childState },
      });
      expect(decision.kind).toBe("incomplete-input");
      if (decision.kind !== "incomplete-input") return;
      expect(decision.missingGoalIds).toEqual(["goal-root"]);
    });

    it("rejects invalid maxBatchSize and fairnessOrdinal with distinct codes", () => {
      const { family } = createRootOnlyFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");

      const badBatch = selectFamilyConcurrentActions({
        family,
        memberStates: { "goal-root": rootState },
        maxBatchSize: -1,
      });
      expect(badBatch.kind).toBe("rejected");
      if (badBatch.kind !== "rejected") return;
      expect(badBatch.diagnostics[0]?.code).toBe("family_concurrent_invalid_batch_size");

      const badOrdinal = selectFamilyConcurrentActions({
        family,
        memberStates: { "goal-root": rootState },
        fairnessOrdinal: 1.5,
      });
      expect(badOrdinal.kind).toBe("rejected");
      if (badOrdinal.kind !== "rejected") return;
      expect(badOrdinal.diagnostics[0]?.code).toBe("family_concurrent_invalid_fairness_ordinal");
    });

    it("rejects unknown concurrency group membership as a hard input error", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        groupRegistry: { groups: [] },
        attributesByGoalId: {
          "goal-root": { groupIds: ["missing-group"] },
        },
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(
        decision.diagnostics.some((d) => d.code === "concurrency_group_unknown_group"),
      ).toBe(true);
    });

    it("builds stable concurrent attempt identities", () => {
      const { family } = createRootOnlyFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
      });
      expect(preferred).toHaveLength(1);
      const first = buildFamilyConcurrentAttemptId(preferred[0]!);
      const second = buildFamilyConcurrentAttemptId(preferred[0]!);
      expect(first).toBe(second);
      expect(first).toContain(family.familyId);
      expect(first).toContain("goal-root");
    });
  });

  describe("deferred multi-pending persistence", () => {
    it("documents that concurrent selection does not write multi-pending family state", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
      });
      expect(decision.kind).toBe("select-batch");
      // Pure selection returns occupancy for the caller. Family pendingDispatches stay empty.
      expect(Object.keys(family.pendingDispatches)).toEqual([]);
      expect(family.schemaVersion).toBe(GOAL_FAMILY_SCHEMA_VERSION);
    });
  });

  describe("review fix: pending lease occupancy", () => {
    it("seeds a pending child lease and blocks a conflicting independent root lease", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      const pausedRoot: HypagraphState = structuredClone(rootState);
      pausedRoot.goal = {
        ...pausedRoot.goal!,
        status: "paused",
        stopReason: "Pause root while child is selected.",
      };
      pausedRoot.phase = "paused";

      const childOnlyCommit = commitFamilySelection({
        family,
        memberStates: {
          "goal-root": pausedRoot,
          "goal-child": childState,
        },
        at: later,
        dispatchId: "dispatch-child-lease",
      });
      expect(childOnlyCommit.ok).toBe(true);
      if (!childOnlyCommit.ok) return;

      const pendingSelection = childOnlyCommit.family.pendingDispatches[Object.keys(childOnlyCommit.family.pendingDispatches)[0]!]!.selection;
      const pendingAttemptFields: Parameters<typeof buildFamilyConcurrentAttemptId>[0] = {
        familyId: pendingSelection.familyId,
        goalId: pendingSelection.goalId,
        workflowId: pendingSelection.workflowId,
        revision: pendingSelection.revision,
        selectedSequence: pendingSelection.selectedSequence,
        selectedSnapshotHash: pendingSelection.selectedSnapshotHash,
        memberContinuationOrdinal: pendingSelection.memberContinuationOrdinal,
        action: pendingSelection.action,
      };
      if (pendingSelection.nodeId !== undefined) {
        pendingAttemptFields.nodeId = pendingSelection.nodeId;
      }
      if (pendingSelection.loopId !== undefined) {
        pendingAttemptFields.loopId = pendingSelection.loopId;
      }
      const pendingAttemptId = buildFamilyConcurrentAttemptId(pendingAttemptFields);

      const preferredRoot = enumerateFamilyPreferredDispatchables(childOnlyCommit.family, {
        "goal-root": rootState,
        "goal-child": childState,
      }).find((item) => item.goalId === "goal-root");
      expect(preferredRoot).toBeDefined();
      if (!preferredRoot) return;
      const rootAttemptId = buildFamilyConcurrentAttemptId(preferredRoot);

      const decision = selectFamilyConcurrentActions({
        family: childOnlyCommit.family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        attributesByAttemptId: {
          [pendingAttemptId]: {
            lease: exclusiveLease(
              "lease-pending-child",
              pendingAttemptId,
              ["src/**"],
              {
                familyId: childOnlyCommit.family.familyId,
                goalId: "goal-child",
                workflowId: "workflow-child",
                revision: pendingSelection.revision,
                nodeId: "work",
              },
            ),
          },
          [rootAttemptId]: {
            lease: exclusiveLease(
              "lease-root",
              rootAttemptId,
              ["src/**"],
              {
                familyId: childOnlyCommit.family.familyId,
                goalId: "goal-root",
                workflowId: "workflow-root",
                revision: rootState.revision,
                nodeId: "work",
              },
            ),
          },
        },
      });

      // Pending exclusive lease on src/** must block the root exclusive lease.
      expect(decision.kind).toBe("idle");
      if (decision.kind !== "idle") return;
      expect(decision.occupancy.leaseSet.leases.some((lease) => lease.leaseId === "lease-pending-child"))
        .toBe(true);
    });
  });

  describe("review fix: lease holder identity binding", () => {
    it("rejects a lease with an incorrect attempt id", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
        "goal-child": childState,
      });
      const rootPreferred = preferred.find((item) => item.goalId === "goal-root")!;
      const rootAttemptId = buildFamilyConcurrentAttemptId(rootPreferred);

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        attributesByAttemptId: {
          [rootAttemptId]: {
            lease: exclusiveLease(
              "lease-wrong-attempt",
              "not-the-candidate-attempt",
              ["src/**"],
              {
                familyId: family.familyId,
                goalId: "goal-root",
                workflowId: "workflow-root",
                revision: rootState.revision,
                nodeId: "work",
              },
            ),
          },
        },
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(
        decision.diagnostics.some((d) => d.code === "family_concurrent_lease_attempt_id_mismatch"),
      ).toBe(true);
    });

    it("rejects a lease with an incorrect goal or workflow identity", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
        "goal-child": childState,
      });
      const rootPreferred = preferred.find((item) => item.goalId === "goal-root")!;
      const rootAttemptId = buildFamilyConcurrentAttemptId(rootPreferred);

      const wrongGoal = exclusiveLease(
        "lease-wrong-goal",
        rootAttemptId,
        ["src/**"],
        {
          familyId: family.familyId,
          goalId: "goal-child",
          workflowId: "workflow-root",
          revision: rootState.revision,
          nodeId: "work",
        },
      );
      const holderCheck = validateLeaseHolderMatchesCandidate(wrongGoal, {
        attemptId: rootAttemptId,
        familyId: family.familyId,
        goalId: "goal-root",
        workflowId: "workflow-root",
        revision: rootState.revision,
        action: rootPreferred.action,
        nodeId: "work",
      });
      expect(holderCheck.some((d) => d.code === "family_concurrent_lease_goal_id_mismatch")).toBe(true);

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        attributesByAttemptId: {
          [rootAttemptId]: {
            lease: exclusiveLease(
              "lease-wrong-workflow",
              rootAttemptId,
              ["src/**"],
              {
                familyId: family.familyId,
                goalId: "goal-root",
                workflowId: "workflow-child",
                revision: rootState.revision,
                nodeId: "work",
              },
            ),
          },
        },
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(
        decision.diagnostics.some((d) => d.code === "family_concurrent_lease_workflow_id_mismatch"),
      ).toBe(true);
    });
  });

  describe("review fix: iterative selection after soft rejection", () => {
    it("fills the batch with a replacement when the fair pick fails a soft lease check", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
        "goal-child": childState,
      });
      const rootPreferred = preferred.find((item) => item.goalId === "goal-root")!;
      const childPreferred = preferred.find((item) => item.goalId === "goal-child")!;
      const rootAttemptId = buildFamilyConcurrentAttemptId(rootPreferred);
      const childAttemptId = buildFamilyConcurrentAttemptId(childPreferred);

      // Active exclusive lease on src/**. Fair pick may prefer goal-child or goal-root.
      // The candidate that wants src/** is soft-skipped; the other path still fills the batch.
      const activeLease = exclusiveLease(
        "lease-active",
        "active-holder",
        ["src/**"],
        {
          familyId: family.familyId,
          goalId: "goal-other",
          workflowId: "workflow-other",
          revision: 0,
          nodeId: "work",
        },
      );
      const leaseSet = createEmptyWorkspaceLeaseSet();
      leaseSet.leases.push(activeLease);

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        leaseSet,
        attributesByAttemptId: {
          [rootAttemptId]: {
            lease: exclusiveLease(
              "lease-root",
              rootAttemptId,
              ["src/**"],
              {
                familyId: family.familyId,
                goalId: "goal-root",
                workflowId: "workflow-root",
                revision: rootState.revision,
                nodeId: "work",
              },
            ),
          },
          [childAttemptId]: {
            lease: exclusiveLease(
              "lease-child",
              childAttemptId,
              ["docs/**"],
              {
                familyId: family.familyId,
                goalId: "goal-child",
                workflowId: "workflow-child",
                revision: childState.revision,
                nodeId: "work",
              },
            ),
          },
        },
      });

      expect(decision.kind).toBe("select-batch");
      if (decision.kind !== "select-batch") return;
      // Root conflicts with active src/** lease; child on docs/** is admitted.
      expect(decision.candidates).toHaveLength(1);
      expect(decision.candidates[0]?.goalId).toBe("goal-child");
    });
  });

  describe("review fix: hard concurrency state errors", () => {
    it("rejects an unsupported concurrency state schema instead of returning idle", () => {
      const { family } = createRootOnlyFamily("family-bad-concurrency-schema");
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: { "goal-root": rootState },
        concurrencyState: {
          schemaVersion: 99 as 1,
          attempts: [],
        },
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(
        decision.diagnostics.some((d) => d.code === "concurrency_state_unsupported_schema"),
      ).toBe(true);
    });

    it("rejects a malformed concurrency state", () => {
      const { family } = createRootOnlyFamily("family-bad-concurrency-shape");
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: { "goal-root": rootState },
        concurrencyState: {
          schemaVersion: 1,
          attempts: "not-an-array" as unknown as [],
        },
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(
        decision.diagnostics.some((d) => d.code === "concurrency_state_invalid_attempts"),
      ).toBe(true);
    });

    it("rejects an invalid executor kind on attributes as a hard input error", () => {
      const { family } = createRootOnlyFamily("family-bad-executor-kind");
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: { "goal-root": rootState },
        attributesByGoalId: {
          "goal-root": {
            executorKind: "not-a-kind" as "isolated-pi",
          },
        },
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(
        decision.diagnostics.some((d) => d.code === "family_concurrent_invalid_executor_kind"),
      ).toBe(true);
    });
  });

  describe("review fix: strict plain-object candidate parsing", () => {
    it("rejects class-instance candidates and accessor attributes", () => {
      const classCandidate = new (class {
        familyId = "family-x";
        goalId = "goal-root";
      })();

      const classResult = liftFamilyConcurrentCandidates([classCandidate as never]);
      expect(classResult.ok).toBe(false);
      if (classResult.ok) return;
      expect(
        classResult.diagnostics.some((d) => d.code === "family_concurrent_candidate_not_plain_object"),
      ).toBe(true);

      const accessorMap = {};
      Object.defineProperty(accessorMap, "goal-root", {
        enumerable: true,
        get() {
          return { groupIds: [] };
        },
      });
      const { family } = createRootOnlyFamily("family-accessor-attrs");
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
      });
      const accessorLift = liftFamilyConcurrentCandidates(preferred, {
        attributesByGoalId: accessorMap,
      });
      expect(accessorLift.ok).toBe(false);
      if (accessorLift.ok) return;
      expect(
        accessorLift.diagnostics.some((d) => d.code === "family_concurrent_invalid_accessor"),
      ).toBe(true);
    });

    it("rejects a malformed action and non-array groupIds with diagnostics", () => {
      const malformedAction = liftFamilyConcurrentCandidates([
        {
          familyId: "family-x",
          goalId: "goal-root",
          workflowId: "workflow-root",
          revision: 0,
          selectedSequence: 0,
          selectedSnapshotHash: "hash",
          memberContinuationOrdinal: 0,
          memberDepth: 0,
          action: { kind: "not-a-real-action" },
        },
      ]);
      expect(malformedAction.ok).toBe(false);
      if (malformedAction.ok) return;
      expect(
        malformedAction.diagnostics.some((d) => d.code === "family_concurrent_invalid_candidate_action"),
      ).toBe(true);

      const badGroups = liftFamilyConcurrentCandidates(
        [
          {
            familyId: "family-x",
            goalId: "goal-root",
            workflowId: "workflow-root",
            revision: 0,
            selectedSequence: 0,
            selectedSnapshotHash: "hash",
            memberContinuationOrdinal: 0,
            memberDepth: 0,
            action: { kind: "start-ready-task", nodeId: "work" },
          },
        ],
        {
          attributesByGoalId: {
            "goal-root": { groupIds: "not-an-array" as unknown as string[] },
          },
        },
      );
      expect(badGroups.ok).toBe(false);
      if (badGroups.ok) return;
      expect(
        badGroups.diagnostics.some((d) => d.code === "family_concurrent_invalid_group_ids"),
      ).toBe(true);
    });

    it("rejects a non-plain top-level selection input", () => {
      const decision = selectFamilyConcurrentBatchFromCandidates(
        new Date() as never,
      );
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(decision.diagnostics[0]?.code).toBe("family_concurrent_invalid_input");
    });
  });

  describe("review fix: unambiguous attempt id encoding", () => {
    it("distinguishes colon-containing identities and different snapshot hashes", () => {
      const withColonA = buildFamilyConcurrentAttemptId({
        familyId: "family:one",
        goalId: "goal:root",
        workflowId: "workflow:root",
        revision: 0,
        selectedSequence: 1,
        selectedSnapshotHash: "snap-a",
        memberContinuationOrdinal: 0,
        action: { kind: "start-ready-task", nodeId: "work" },
        nodeId: "work",
      });
      const withColonB = buildFamilyConcurrentAttemptId({
        familyId: "family",
        goalId: "one:goal",
        workflowId: "root:workflow:root",
        revision: 0,
        selectedSequence: 1,
        selectedSnapshotHash: "snap-a",
        memberContinuationOrdinal: 0,
        action: { kind: "start-ready-task", nodeId: "work" },
        nodeId: "work",
      });
      expect(withColonA).not.toBe(withColonB);
      expect(withColonA).toContain(encodeFamilyConcurrentIdField("family:one"));
      expect(withColonA).toContain(encodeFamilyConcurrentIdField("snap-a"));

      const hashA = buildFamilyConcurrentAttemptId({
        familyId: "family",
        goalId: "goal-root",
        workflowId: "workflow-root",
        revision: 0,
        selectedSequence: 1,
        selectedSnapshotHash: "hash-one",
        memberContinuationOrdinal: 0,
        action: { kind: "start-ready-task", nodeId: "work" },
        nodeId: "work",
      });
      const hashB = buildFamilyConcurrentAttemptId({
        familyId: "family",
        goalId: "goal-root",
        workflowId: "workflow-root",
        revision: 0,
        selectedSequence: 1,
        selectedSnapshotHash: "hash-two",
        memberContinuationOrdinal: 0,
        action: { kind: "start-ready-task", nodeId: "work" },
        nodeId: "work",
      });
      expect(hashA).not.toBe(hashB);
    });
  });

  describe("review fix: overlap predicate requires pending dispatch", () => {
    it("returns false when the family has no pending dispatch", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      // Concurrent work exists, but there is no pending dispatch to overlap with.
      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
      });
      expect(decision.kind).toBe("select-batch");
      expect(
        familyConcurrentSelectionAllowsOverlapWithPending(family, {
          "goal-root": rootState,
          "goal-child": childState,
        }),
      ).toBe(false);
    });

    it("returns true only when pending dispatch exists and other work remains selectable", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
      const pausedRoot: HypagraphState = structuredClone(rootState);
      pausedRoot.goal = {
        ...pausedRoot.goal!,
        status: "paused",
        stopReason: "Pause root while child is selected.",
      };
      pausedRoot.phase = "paused";

      const childOnlyCommit = commitFamilySelection({
        family,
        memberStates: {
          "goal-root": pausedRoot,
          "goal-child": childState,
        },
        at: later,
        dispatchId: "dispatch-overlap-predicate",
      });
      expect(childOnlyCommit.ok).toBe(true);
      if (!childOnlyCommit.ok) return;

      expect(
        familyConcurrentSelectionAllowsOverlapWithPending(childOnlyCommit.family, {
          "goal-root": rootState,
          "goal-child": childState,
        }),
      ).toBe(true);
    });
  });

  describe("re-review: pending lease full canonical match", () => {
    it("hard-rejects a reused lease id with different content", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      const pausedRoot: HypagraphState = structuredClone(rootState);
      pausedRoot.goal = {
        ...pausedRoot.goal!,
        status: "paused",
        stopReason: "Pause root while child is selected.",
      };
      pausedRoot.phase = "paused";

      const childOnlyCommit = commitFamilySelection({
        family,
        memberStates: {
          "goal-root": pausedRoot,
          "goal-child": childState,
        },
        at: later,
        dispatchId: "dispatch-pending-lease-id",
      });
      expect(childOnlyCommit.ok).toBe(true);
      if (!childOnlyCommit.ok) return;

      const pendingSelection = childOnlyCommit.family.pendingDispatches[Object.keys(childOnlyCommit.family.pendingDispatches)[0]!]!.selection;
      const pendingAttemptFields: Parameters<typeof buildFamilyConcurrentAttemptId>[0] = {
        familyId: pendingSelection.familyId,
        goalId: pendingSelection.goalId,
        workflowId: pendingSelection.workflowId,
        revision: pendingSelection.revision,
        selectedSequence: pendingSelection.selectedSequence,
        selectedSnapshotHash: pendingSelection.selectedSnapshotHash,
        memberContinuationOrdinal: pendingSelection.memberContinuationOrdinal,
        action: pendingSelection.action,
      };
      if (pendingSelection.nodeId !== undefined) {
        pendingAttemptFields.nodeId = pendingSelection.nodeId;
      }
      const pendingAttemptId = buildFamilyConcurrentAttemptId(pendingAttemptFields);

      const activeDifferentContent = exclusiveLease(
        "shared-lease-id",
        "other-attempt",
        ["docs/**"],
        {
          familyId: family.familyId,
          goalId: "goal-other",
          workflowId: "workflow-other",
          revision: 0,
          nodeId: "work",
        },
      );
      const leaseSet = createEmptyWorkspaceLeaseSet();
      leaseSet.leases.push(activeDifferentContent);

      const decision = selectFamilyConcurrentActions({
        family: childOnlyCommit.family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        leaseSet,
        attributesByAttemptId: {
          [pendingAttemptId]: {
            lease: exclusiveLease(
              "shared-lease-id",
              pendingAttemptId,
              ["src/**"],
              {
                familyId: childOnlyCommit.family.familyId,
                goalId: "goal-child",
                workflowId: "workflow-child",
                revision: pendingSelection.revision,
                nodeId: "work",
              },
            ),
          },
        },
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(
        decision.diagnostics.some((d) => d.code === "family_concurrent_pending_lease_id_conflict"),
      ).toBe(true);
    });

    it("hard-rejects a pending attempt that already holds a different lease", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      const pausedRoot: HypagraphState = structuredClone(rootState);
      pausedRoot.goal = {
        ...pausedRoot.goal!,
        status: "paused",
        stopReason: "Pause root while child is selected.",
      };
      pausedRoot.phase = "paused";

      const childOnlyCommit = commitFamilySelection({
        family,
        memberStates: {
          "goal-root": pausedRoot,
          "goal-child": childState,
        },
        at: later,
        dispatchId: "dispatch-pending-lease-attempt",
      });
      expect(childOnlyCommit.ok).toBe(true);
      if (!childOnlyCommit.ok) return;

      const pendingSelection = childOnlyCommit.family.pendingDispatches[Object.keys(childOnlyCommit.family.pendingDispatches)[0]!]!.selection;
      const pendingAttemptFields: Parameters<typeof buildFamilyConcurrentAttemptId>[0] = {
        familyId: pendingSelection.familyId,
        goalId: pendingSelection.goalId,
        workflowId: pendingSelection.workflowId,
        revision: pendingSelection.revision,
        selectedSequence: pendingSelection.selectedSequence,
        selectedSnapshotHash: pendingSelection.selectedSnapshotHash,
        memberContinuationOrdinal: pendingSelection.memberContinuationOrdinal,
        action: pendingSelection.action,
      };
      if (pendingSelection.nodeId !== undefined) {
        pendingAttemptFields.nodeId = pendingSelection.nodeId;
      }
      const pendingAttemptId = buildFamilyConcurrentAttemptId(pendingAttemptFields);

      const activeDifferentLease = exclusiveLease(
        "lease-already-held",
        pendingAttemptId,
        ["docs/**"],
        {
          familyId: childOnlyCommit.family.familyId,
          goalId: "goal-child",
          workflowId: "workflow-child",
          revision: pendingSelection.revision,
          nodeId: "work",
        },
      );
      const leaseSet = createEmptyWorkspaceLeaseSet();
      leaseSet.leases.push(activeDifferentLease);

      const attributeLease = exclusiveLease(
        "lease-pending-attr",
        pendingAttemptId,
        ["src/**"],
        {
          familyId: childOnlyCommit.family.familyId,
          goalId: "goal-child",
          workflowId: "workflow-child",
          revision: pendingSelection.revision,
          nodeId: "work",
        },
      );
      expect(workspaceLeasesCanonicallyEqual(activeDifferentLease, attributeLease)).toBe(false);

      const decision = selectFamilyConcurrentActions({
        family: childOnlyCommit.family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        leaseSet,
        attributesByAttemptId: {
          [pendingAttemptId]: { lease: attributeLease },
        },
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(
        decision.diagnostics.some((d) => d.code === "family_concurrent_pending_lease_attempt_conflict"),
      ).toBe(true);
    });
  });

  describe("re-review: early lease holder validation", () => {
    it("rejects a mismatched lease holder even when capacity would soft-skip first", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
        "goal-child": childState,
      });
      const rootPreferred = preferred.find((item) => item.goalId === "goal-root")!;
      const childPreferred = preferred.find((item) => item.goalId === "goal-child")!;
      const rootAttemptId = buildFamilyConcurrentAttemptId(rootPreferred);
      const childAttemptId = buildFamilyConcurrentAttemptId(childPreferred);

      // Per-executor capacity is 0 for isolated-pi so every candidate soft-skips on admit
      // if holder validation were deferred. Early validation must still hard-reject.
      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        concurrencyLimits: {
          globalConcurrency: 2,
          perExecutorKind: { "isolated-pi": 0 },
        },
        attributesByAttemptId: {
          [rootAttemptId]: {
            lease: exclusiveLease(
              "lease-wrong",
              "wrong-attempt",
              ["src/**"],
              {
                familyId: family.familyId,
                goalId: "goal-root",
                workflowId: "workflow-root",
                revision: rootState.revision,
                nodeId: "work",
              },
            ),
          },
          [childAttemptId]: {
            lease: exclusiveLease(
              "lease-child-ok",
              childAttemptId,
              ["docs/**"],
              {
                familyId: family.familyId,
                goalId: "goal-child",
                workflowId: "workflow-child",
                revision: childState.revision,
                nodeId: "work",
              },
            ),
          },
        },
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(
        decision.diagnostics.some((d) => d.code === "family_concurrent_lease_attempt_id_mismatch"),
      ).toBe(true);
    });
  });

  describe("re-review: own-data-property nested parsing", () => {
    it("rejects a throwing accessor on action.kind", () => {
      const action: Record<string, unknown> = {};
      Object.defineProperty(action, "kind", {
        enumerable: true,
        get() {
          throw new Error("action.kind getter must not run");
        },
      });
      const result = liftFamilyConcurrentCandidates([
        {
          familyId: "family-x",
          goalId: "goal-root",
          workflowId: "workflow-root",
          revision: 0,
          selectedSequence: 0,
          selectedSnapshotHash: "hash",
          memberContinuationOrdinal: 0,
          memberDepth: 0,
          action,
        },
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some((d) => d.code === "family_concurrent_invalid_accessor"),
      ).toBe(true);
    });

    it("rejects a throwing accessor on nested lease.holder.attemptId", () => {
      const holder: Record<string, unknown> = {
        familyId: "family-x",
        goalId: "goal-root",
        workflowId: "workflow-root",
        revision: 0,
        nodeId: "work",
      };
      Object.defineProperty(holder, "attemptId", {
        enumerable: true,
        get() {
          throw new Error("holder.attemptId getter must not run");
        },
      });
      const result = liftFamilyConcurrentCandidates(
        [
          {
            familyId: "family-x",
            goalId: "goal-root",
            workflowId: "workflow-root",
            revision: 0,
            selectedSequence: 0,
            selectedSnapshotHash: "hash",
            memberContinuationOrdinal: 0,
            memberDepth: 0,
            action: { kind: "start-ready-task", nodeId: "work" },
          },
        ],
        {
          attributesByGoalId: {
            "goal-root": {
              lease: {
                leaseId: "lease-x",
                mode: "exclusive",
                holder,
                paths: { readPaths: [], writePaths: ["src/**"] },
              },
            },
          },
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some((d) => d.code === "family_concurrent_invalid_accessor"),
      ).toBe(true);
    });

    it("rejects a throwing accessor on family.schemaVersion", () => {
      const { family } = createRootOnlyFamily("family-schema-accessor");
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
      });

      const hostileFamily: Record<string, unknown> = { ...family };
      Object.defineProperty(hostileFamily, "schemaVersion", {
        enumerable: true,
        get() {
          throw new Error("schemaVersion getter must not run");
        },
      });

      const decision = selectFamilyConcurrentBatchFromCandidates({
        family: hostileFamily as never,
        candidates: preferred,
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(
        decision.diagnostics.some((d) => d.code === "family_concurrent_invalid_accessor"),
      ).toBe(true);
    });
  });

  describe("re-review: full lease set parse", () => {
    it("rejects a malformed active lease in the lease set", () => {
      const { family } = createRootOnlyFamily("family-bad-lease-set");
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: { "goal-root": rootState },
        leaseSet: {
          schemaVersion: 1,
          leases: [
            {
              leaseId: "broken",
              mode: "exclusive",
              // Missing holder and paths.
            } as never,
          ],
        },
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(decision.diagnostics.length).toBeGreaterThan(0);
    });

    it("rejects duplicate lease ids and duplicate holder attempt ids", () => {
      const duplicateIds = parseFamilyConcurrentLeaseSet({
        schemaVersion: 1,
        leases: [
          exclusiveLease("lease-dup", "attempt-a", ["src/**"], {
            familyId: "family",
            goalId: "goal-a",
            workflowId: "wf-a",
            revision: 0,
            nodeId: "work",
          }),
          exclusiveLease("lease-dup", "attempt-b", ["docs/**"], {
            familyId: "family",
            goalId: "goal-b",
            workflowId: "wf-b",
            revision: 0,
            nodeId: "work",
          }),
        ],
      });
      expect(duplicateIds.ok).toBe(false);
      if (duplicateIds.ok) return;
      expect(
        duplicateIds.diagnostics.some((d) => d.code === "family_concurrent_lease_set_duplicate_lease_id"),
      ).toBe(true);

      const duplicateAttempts = parseFamilyConcurrentLeaseSet({
        schemaVersion: 1,
        leases: [
          exclusiveLease("lease-a", "attempt-shared", ["src/**"], {
            familyId: "family",
            goalId: "goal-a",
            workflowId: "wf-a",
            revision: 0,
            nodeId: "work",
          }),
          exclusiveLease("lease-b", "attempt-shared", ["docs/**"], {
            familyId: "family",
            goalId: "goal-b",
            workflowId: "wf-b",
            revision: 0,
            nodeId: "work",
          }),
        ],
      });
      expect(duplicateAttempts.ok).toBe(false);
      if (duplicateAttempts.ok) return;
      expect(
        duplicateAttempts.diagnostics.some(
          (d) => d.code === "family_concurrent_lease_set_duplicate_attempt_id",
        ),
      ).toBe(true);
    });
  });

  describe("re-review: node and loop identity alignment", () => {
    it("rejects a top-level nodeId that does not match the action", () => {
      const result = liftFamilyConcurrentCandidates([
        {
          familyId: "family-x",
          goalId: "goal-root",
          workflowId: "workflow-root",
          revision: 0,
          selectedSequence: 0,
          selectedSnapshotHash: "hash",
          memberContinuationOrdinal: 0,
          memberDepth: 0,
          action: { kind: "start-ready-task", nodeId: "work" },
          nodeId: "other-node",
        },
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some((d) => d.code === "family_concurrent_node_id_mismatch"),
      ).toBe(true);
    });

    it("rejects a top-level loopId that does not match the action", () => {
      const result = liftFamilyConcurrentCandidates([
        {
          familyId: "family-x",
          goalId: "goal-root",
          workflowId: "workflow-root",
          revision: 0,
          selectedSequence: 0,
          selectedSnapshotHash: "hash",
          memberContinuationOrdinal: 0,
          memberDepth: 0,
          action: { kind: "start-ready-task", nodeId: "work", loopId: "loop-a" },
          nodeId: "work",
          loopId: "loop-b",
        },
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(
        result.diagnostics.some((d) => d.code === "family_concurrent_loop_id_mismatch"),
      ).toBe(true);
    });

    it("rejects top-level nodeId or loopId on request-revision", () => {
      const withNode = liftFamilyConcurrentCandidates([
        {
          familyId: "family-x",
          goalId: "goal-root",
          workflowId: "workflow-root",
          revision: 0,
          selectedSequence: 0,
          selectedSnapshotHash: "hash",
          memberContinuationOrdinal: 0,
          memberDepth: 0,
          action: {
            kind: "request-revision",
            blocker: {
              kind: "blocked-node",
              id: "work",
              reason: "Blocked.",
              sourceRevision: 0,
              sourceSequence: 0,
              sourceSnapshotHash: "hash",
            },
          },
          nodeId: "work",
        },
      ]);
      expect(withNode.ok).toBe(false);
      if (withNode.ok) return;
      expect(
        withNode.diagnostics.some(
          (d) => d.code === "family_concurrent_node_id_not_allowed_for_revision",
        ),
      ).toBe(true);

      const withLoop = liftFamilyConcurrentCandidates([
        {
          familyId: "family-x",
          goalId: "goal-root",
          workflowId: "workflow-root",
          revision: 0,
          selectedSequence: 0,
          selectedSnapshotHash: "hash",
          memberContinuationOrdinal: 0,
          memberDepth: 0,
          action: {
            kind: "request-revision",
            blocker: {
              kind: "blocked-loop",
              id: "loop-a",
              reason: "Blocked.",
              sourceRevision: 0,
              sourceSequence: 0,
              sourceSnapshotHash: "hash",
            },
          },
          loopId: "loop-a",
        },
      ]);
      expect(withLoop.ok).toBe(false);
      if (withLoop.ok) return;
      expect(
        withLoop.diagnostics.some(
          (d) => d.code === "family_concurrent_loop_id_not_allowed_for_revision",
        ),
      ).toBe(true);
    });

    it("derives nodeId from the action when the top-level field is omitted", () => {
      const result = liftFamilyConcurrentCandidates([
        {
          familyId: "family-x",
          goalId: "goal-root",
          workflowId: "workflow-root",
          revision: 0,
          selectedSequence: 0,
          selectedSnapshotHash: "hash",
          memberContinuationOrdinal: 0,
          memberDepth: 0,
          action: { kind: "start-ready-task", nodeId: "work" },
        },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.candidates[0]?.nodeId).toBe("work");
    });
  });

  describe("re-review: pending concurrency and group content match", () => {
    it("hard-rejects a pending attempt with a different executor kind", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      const pausedRoot: HypagraphState = structuredClone(rootState);
      pausedRoot.goal = {
        ...pausedRoot.goal!,
        status: "paused",
        stopReason: "Pause root while child is selected.",
      };
      pausedRoot.phase = "paused";

      const childOnlyCommit = commitFamilySelection({
        family,
        memberStates: {
          "goal-root": pausedRoot,
          "goal-child": childState,
        },
        at: later,
        dispatchId: "dispatch-pending-executor",
      });
      expect(childOnlyCommit.ok).toBe(true);
      if (!childOnlyCommit.ok) return;

      const pendingSelection = childOnlyCommit.family.pendingDispatches[Object.keys(childOnlyCommit.family.pendingDispatches)[0]!]!.selection;
      const pendingAttemptFields: Parameters<typeof buildFamilyConcurrentAttemptId>[0] = {
        familyId: pendingSelection.familyId,
        goalId: pendingSelection.goalId,
        workflowId: pendingSelection.workflowId,
        revision: pendingSelection.revision,
        selectedSequence: pendingSelection.selectedSequence,
        selectedSnapshotHash: pendingSelection.selectedSnapshotHash,
        memberContinuationOrdinal: pendingSelection.memberContinuationOrdinal,
        action: pendingSelection.action,
      };
      if (pendingSelection.nodeId !== undefined) {
        pendingAttemptFields.nodeId = pendingSelection.nodeId;
      }
      const pendingAttemptId = buildFamilyConcurrentAttemptId(pendingAttemptFields);

      const decision = selectFamilyConcurrentActions({
        family: childOnlyCommit.family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        concurrencyState: {
          schemaVersion: CONCURRENCY_STATE_SCHEMA_VERSION,
          attempts: [
            { attemptId: pendingAttemptId, executorKind: "cli" },
          ],
        },
        attributesByAttemptId: {
          [pendingAttemptId]: { executorKind: "isolated-pi" },
        },
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(
        decision.diagnostics.some(
          (d) => d.code === "family_concurrent_pending_executor_kind_conflict",
        ),
      ).toBe(true);
    });

    it("hard-rejects a pending attempt with a different group membership", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      const pausedRoot: HypagraphState = structuredClone(rootState);
      pausedRoot.goal = {
        ...pausedRoot.goal!,
        status: "paused",
        stopReason: "Pause root while child is selected.",
      };
      pausedRoot.phase = "paused";

      const childOnlyCommit = commitFamilySelection({
        family,
        memberStates: {
          "goal-root": pausedRoot,
          "goal-child": childState,
        },
        at: later,
        dispatchId: "dispatch-pending-groups",
      });
      expect(childOnlyCommit.ok).toBe(true);
      if (!childOnlyCommit.ok) return;

      const pendingSelection = childOnlyCommit.family.pendingDispatches[Object.keys(childOnlyCommit.family.pendingDispatches)[0]!]!.selection;
      const pendingAttemptFields: Parameters<typeof buildFamilyConcurrentAttemptId>[0] = {
        familyId: pendingSelection.familyId,
        goalId: pendingSelection.goalId,
        workflowId: pendingSelection.workflowId,
        revision: pendingSelection.revision,
        selectedSequence: pendingSelection.selectedSequence,
        selectedSnapshotHash: pendingSelection.selectedSnapshotHash,
        memberContinuationOrdinal: pendingSelection.memberContinuationOrdinal,
        action: pendingSelection.action,
      };
      if (pendingSelection.nodeId !== undefined) {
        pendingAttemptFields.nodeId = pendingSelection.nodeId;
      }
      const pendingAttemptId = buildFamilyConcurrentAttemptId(pendingAttemptFields);

      const decision = selectFamilyConcurrentActions({
        family: childOnlyCommit.family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        groupRegistry: {
          groups: [
            { groupId: "group-a", maxConcurrent: 2 },
            { groupId: "group-b", maxConcurrent: 2 },
          ],
        },
        groupState: {
          schemaVersion: CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
          attempts: [
            { attemptId: pendingAttemptId, groupIds: ["group-a"] },
          ],
        },
        attributesByAttemptId: {
          [pendingAttemptId]: { groupIds: ["group-b"] },
        },
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(
        decision.diagnostics.some(
          (d) => d.code === "family_concurrent_pending_group_ids_conflict",
        ),
      ).toBe(true);
    });
  });

  describe("re-review: own-data pendingDispatch parse", () => {
    it("rejects a throwing accessor on family.pendingDispatches", () => {
      const { family } = createRootOnlyFamily("family-pending-accessor");
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
      });

      const hostileFamily: Record<string, unknown> = { ...family };
      Object.defineProperty(hostileFamily, "pendingDispatches", {
        enumerable: true,
        get() {
          throw new Error("pendingDispatches getter must not run");
        },
      });

      const decision = selectFamilyConcurrentBatchFromCandidates({
        family: hostileFamily as never,
        candidates: preferred,
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(
        decision.diagnostics.some((d) => d.code === "family_concurrent_invalid_accessor"),
      ).toBe(true);
    });

    it("rejects a throwing accessor on nested selection.goalId", () => {
      const { family } = createRootOnlyFamily("family-pending-selection-accessor");
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
      });
      const preferredRoot = preferred[0]!;

      const selection: Record<string, unknown> = {
        familyId: family.familyId,
        workflowId: "workflow-root",
        revision: rootState.revision,
        action: preferredRoot.action,
        reason: "Test.",
        selectedSequence: rootState.sequence,
        selectedSnapshotHash: rootState.snapshotHash,
        memberContinuationOrdinal: rootState.goal!.continuationOrdinal,
        nodeId: "work",
      };
      Object.defineProperty(selection, "goalId", {
        enumerable: true,
        get() {
          throw new Error("selection.goalId getter must not run");
        },
      });

      const pending: Record<string, unknown> = {
        dispatchId: "dispatch-hostile",
        status: "selected",
        selectedAt: later,
        schedulerOrdinal: 1,
        selection,
      };

      const hostileFamily: Record<string, unknown> = {
        ...family,
        pendingDispatches: { "dispatch-hostile": pending },
      };

      const decision = selectFamilyConcurrentBatchFromCandidates({
        family: hostileFamily as never,
        candidates: preferred,
      });
      expect(decision.kind).toBe("rejected");
      if (decision.kind !== "rejected") return;
      expect(
        decision.diagnostics.some((d) => d.code === "family_concurrent_invalid_accessor"),
      ).toBe(true);

      const direct = parseFamilyPendingDispatchOwnData(hostileFamily);
      expect(direct.ok).toBe(false);
      if (direct.ok) return;
      expect(
        direct.diagnostics.some((d) => d.code === "family_concurrent_invalid_accessor"),
      ).toBe(true);
    });
  });

  describe("re-review: clean parsed concurrency and group occupancy", () => {
    it("does not throw when concurrency state has an extra throwing getter", () => {
      const { family } = createRootOnlyFamily("family-concurrency-getter");
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");

      const hostileState: Record<string, unknown> = {
        schemaVersion: CONCURRENCY_STATE_SCHEMA_VERSION,
        attempts: [],
      };
      Object.defineProperty(hostileState, "extraHostile", {
        enumerable: true,
        get() {
          throw new Error("extraHostile getter must not run during selection");
        },
      });

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: { "goal-root": rootState },
        concurrencyState: hostileState as never,
      });
      // Own-data parse ignores unknown keys. Selection must not throw.
      expect(decision.kind).toBe("select-batch");
      if (decision.kind !== "select-batch") return;
      expect(decision.occupancy.concurrencyState.schemaVersion).toBe(
        CONCURRENCY_STATE_SCHEMA_VERSION,
      );
      expect(decision.occupancy.concurrencyState.attempts.length).toBeGreaterThanOrEqual(1);
      // Occupancy must be a clean record without the hostile property.
      expect(
        Object.prototype.hasOwnProperty.call(
          decision.occupancy.concurrencyState,
          "extraHostile",
        ),
      ).toBe(false);
    });

    it("uses clean group occupancy and ignores extra hostile properties", () => {
      const { family } = createRootOnlyFamily("family-group-getter");
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");

      const hostileGroup: Record<string, unknown> = {
        schemaVersion: CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
        attempts: [],
      };
      Object.defineProperty(hostileGroup, "extraHostile", {
        enumerable: true,
        get() {
          throw new Error("group extraHostile getter must not run");
        },
      });

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: { "goal-root": rootState },
        groupState: hostileGroup as never,
      });
      expect(decision.kind).toBe("select-batch");
      if (decision.kind !== "select-batch") return;
      expect(decision.occupancy.groupState.schemaVersion).toBe(
        CONCURRENCY_GROUP_STATE_SCHEMA_VERSION,
      );
      expect(
        Object.prototype.hasOwnProperty.call(decision.occupancy.groupState, "extraHostile"),
      ).toBe(false);
    });

    it("canonicalizes attempt order in clean concurrency occupancy", () => {
      const empty = createEmptyConcurrencyState();
      expect(empty.attempts).toEqual([]);
      const emptyGroup = createEmptyConcurrencyGroupState();
      expect(emptyGroup.attempts).toEqual([]);

      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");
      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
        "goal-child": childState,
      });
      const rootAttemptId = buildFamilyConcurrentAttemptId(
        preferred.find((item) => item.goalId === "goal-root")!,
      );
      const childAttemptId = buildFamilyConcurrentAttemptId(
        preferred.find((item) => item.goalId === "goal-child")!,
      );

      // Provide reverse order in the input; clean occupancy must sort by attemptId.
      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        concurrencyState: {
          schemaVersion: CONCURRENCY_STATE_SCHEMA_VERSION,
          attempts: [
            { attemptId: "z-preseed", executorKind: "cli" },
            { attemptId: "a-preseed", executorKind: "cli" },
          ],
        },
        concurrencyLimits: { globalConcurrency: 4 },
      });
      expect(decision.kind).toBe("select-batch");
      if (decision.kind !== "select-batch") return;
      const ids = decision.occupancy.concurrencyState.attempts.map((item) => item.attemptId);
      const sorted = [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      expect(ids).toEqual(sorted);
      // Preseed attempts remain and batch selections are also present.
      expect(ids).toContain("a-preseed");
      expect(ids).toContain("z-preseed");
      expect(ids).toContain(rootAttemptId);
      expect(ids).toContain(childAttemptId);
    });
  });

  describe("re-review: pending dispatch lifecycle invariants", () => {
    const baseSelection = (familyId: string, rootState: HypagraphState) => ({
      familyId,
      goalId: "goal-root",
      workflowId: "workflow-root",
      revision: rootState.revision,
      action: { kind: "start-ready-task" as const, nodeId: "work" },
      reason: "Test selection.",
      selectedSequence: rootState.sequence,
      selectedSnapshotHash: rootState.snapshotHash,
      memberContinuationOrdinal: rootState.goal!.continuationOrdinal,
      nodeId: "work",
    });

    it("rejects invalid selectedAt and selected status with dispatchedAt", () => {
      const { family } = createRootOnlyFamily("family-pending-lifecycle");
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
      });

      const badTimestamp = selectFamilyConcurrentBatchFromCandidates({
        family: {
          ...family,
          pendingDispatches: {
            "d1": {
            dispatchId: "d1",
            status: "selected",
            selectedAt: "not-a-date",
            schedulerOrdinal: 1,
            selection: baseSelection(family.familyId, rootState),
          },          },
        } as never,
        candidates: preferred,
      });
      expect(badTimestamp.kind).toBe("rejected");
      if (badTimestamp.kind !== "rejected") return;
      expect(
        badTimestamp.diagnostics.some(
          (d) => d.code === "family_concurrent_pending_invalid_timestamp",
        ),
      ).toBe(true);

      const selectedWithDispatchedAt = selectFamilyConcurrentBatchFromCandidates({
        family: {
          ...family,
          schedulerOrdinal: 1,
          pendingDispatches: {
            "d2": {
            dispatchId: "d2",
            status: "selected",
            selectedAt: later,
            dispatchedAt: doneAt,
            schedulerOrdinal: 1,
            selection: baseSelection(family.familyId, rootState),
          },          },
        } as never,
        candidates: preferred,
      });
      expect(selectedWithDispatchedAt.kind).toBe("rejected");
      if (selectedWithDispatchedAt.kind !== "rejected") return;
      expect(
        selectedWithDispatchedAt.diagnostics.some(
          (d) => d.code === "family_concurrent_pending_invalid_status_fields",
        ),
      ).toBe(true);
    });

    it("rejects ordinal ahead of family sequence and missing member selection", () => {
      const { family } = createRootOnlyFamily("family-pending-identity");
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
      });

      const aheadOrdinal = selectFamilyConcurrentBatchFromCandidates({
        family: {
          ...family,
          schedulerOrdinal: 1,
          pendingDispatches: {
            "d3": {
            dispatchId: "d3",
            status: "selected",
            selectedAt: later,
            schedulerOrdinal: 99,
            selection: baseSelection(family.familyId, rootState),
          },          },
        } as never,
        candidates: preferred,
      });
      expect(aheadOrdinal.kind).toBe("rejected");
      if (aheadOrdinal.kind !== "rejected") return;
      expect(
        aheadOrdinal.diagnostics.some(
          (d) => d.code === "family_concurrent_pending_invalid_scheduler_ordinal",
        ),
      ).toBe(true);

      const missingMember = selectFamilyConcurrentBatchFromCandidates({
        family: {
          ...family,
          schedulerOrdinal: 1,
          pendingDispatches: {
            "d4": {
            dispatchId: "d4",
            status: "selected",
            selectedAt: later,
            schedulerOrdinal: 1,
            selection: {
              ...baseSelection(family.familyId, rootState),
              goalId: "goal-missing",
            },
          },          },
        } as never,
        candidates: preferred,
      });
      expect(missingMember.kind).toBe("rejected");
      if (missingMember.kind !== "rejected") return;
      expect(
        missingMember.diagnostics.some(
          (d) => d.code === "family_concurrent_pending_selection_member_missing",
        ),
      ).toBe(true);
    });

    it("rejects dispatched status without dispatchedAt and timestamp order violations", () => {
      const { family } = createRootOnlyFamily("family-pending-dispatched");
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const preferred = enumerateFamilyPreferredDispatchables(family, {
        "goal-root": rootState,
      });

      const noDispatchedAt = selectFamilyConcurrentBatchFromCandidates({
        family: {
          ...family,
          schedulerOrdinal: 1,
          pendingDispatches: {
            "d5": {
            dispatchId: "d5",
            status: "dispatched",
            selectedAt: later,
            schedulerOrdinal: 1,
            selection: baseSelection(family.familyId, rootState),
          },          },
        } as never,
        candidates: preferred,
      });
      expect(noDispatchedAt.kind).toBe("rejected");
      if (noDispatchedAt.kind !== "rejected") return;
      expect(
        noDispatchedAt.diagnostics.some(
          (d) => d.code === "family_concurrent_pending_invalid_timestamp",
        ),
      ).toBe(true);

      const badOrder = selectFamilyConcurrentBatchFromCandidates({
        family: {
          ...family,
          schedulerOrdinal: 1,
          pendingDispatches: {
            "d6": {
            dispatchId: "d6",
            status: "dispatched",
            selectedAt: doneAt,
            dispatchedAt: later,
            schedulerOrdinal: 1,
            selection: baseSelection(family.familyId, rootState),
          },          },
        } as never,
        candidates: preferred,
      });
      expect(badOrder.kind).toBe("rejected");
      if (badOrder.kind !== "rejected") return;
      expect(
        badOrder.diagnostics.some(
          (d) => d.code === "family_concurrent_pending_timestamp_order",
        ),
      ).toBe(true);
    });
  });

  describe("re-review: locale-independent concurrency order after admit", () => {
    it("orders occupancy with code-unit identity when localeCompare would reverse case", () => {
      // Code-unit order: "B-preseed" (0x42) before "a-preseed" (0x61).
      // Default localeCompare often ranks "a" before "B" (case-insensitive primary).
      // admitAttempt uses localeCompare; concurrent selection must re-sort.
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      const decision = selectFamilyConcurrentActions({
        family,
        memberStates: {
          "goal-root": rootState,
          "goal-child": childState,
        },
        concurrencyState: {
          schemaVersion: CONCURRENCY_STATE_SCHEMA_VERSION,
          attempts: [
            { attemptId: "a-preseed", executorKind: "cli" },
            { attemptId: "B-preseed", executorKind: "cli" },
          ],
        },
        concurrencyLimits: { globalConcurrency: 4 },
      });
      expect(decision.kind).toBe("select-batch");
      if (decision.kind !== "select-batch") return;

      const ids = decision.occupancy.concurrencyState.attempts.map((item) => item.attemptId);
      const identityOrder = [...ids].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0
      );
      expect(ids).toEqual(identityOrder);

      // Locale-dependent order often puts "a-preseed" before "B-preseed".
      // Identity order requires "B-preseed" before "a-preseed".
      const localeOrder = ["a-preseed", "B-preseed"].sort((left, right) =>
        left.localeCompare(right)
      );
      const codeUnitOrder = ["a-preseed", "B-preseed"].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0
      );
      // Only assert the identity placement when locale and code-unit order differ.
      if (localeOrder[0] !== codeUnitOrder[0]) {
        const indexB = ids.indexOf("B-preseed");
        const indexA = ids.indexOf("a-preseed");
        expect(indexB).toBeGreaterThanOrEqual(0);
        expect(indexA).toBeGreaterThanOrEqual(0);
        expect(indexB).toBeLessThan(indexA);
      }
    });
  });

  describe("re-review: family-scheduler pending own-data access", () => {
    it("overlap predicate returns false when pendingDispatch is a throwing accessor", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      const hostileFamily: GoalFamilyRuntime = { ...family };
      Object.defineProperty(hostileFamily, "pendingDispatches", {
        enumerable: true,
        get() {
          throw new Error("pendingDispatches getter must not run");
        },
      });

      expect(
        familyConcurrentSelectionAllowsOverlapWithPending(hostileFamily, {
          "goal-root": rootState,
          "goal-child": childState,
        }),
      ).toBe(false);
    });

    it("enumeration returns diagnostics when pendingDispatches is a throwing accessor", () => {
      const { family } = createTwoMemberFamily();
      const rootState = createMemberWorkflow(singleTask("Root work"), "workflow-root", "goal-root");
      const childState = createMemberWorkflow(singleTask("Child work"), "workflow-child", "goal-child");

      const hostileFamily: GoalFamilyRuntime = { ...family };
      Object.defineProperty(hostileFamily, "pendingDispatches", {
        enumerable: true,
        get() {
          throw new Error("pendingDispatches getter must not run in enumerate");
        },
      });

      const result = enumerateFamilyConcurrentCandidates(hostileFamily, {
        "goal-root": rootState,
        "goal-child": childState,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect("diagnostics" in result).toBe(true);
      if (!("diagnostics" in result)) return;
      expect(
        result.diagnostics.some((d) => d.code === "family_concurrent_invalid_accessor"),
      ).toBe(true);
    });
  });
});
