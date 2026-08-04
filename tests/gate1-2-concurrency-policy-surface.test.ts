/**
 * Gate 1.2: product concurrency policy surface.
 *
 * Covers resolve defaults and overrides, product-path limit and group
 * enforcement, partial-failure settle, multi-pending restore, and honest status.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_CONCURRENCY } from "../src/domain/concurrency-limits.js";
import {
  GOAL_FAMILY_SCHEMA_VERSION,
  addFamilyMember,
  createRootFamily,
  listPendingDispatches,
  pendingDispatchCount,
  rebuildFamilyMembershipFromSnapshot,
  type GoalFamilyRuntime,
} from "../src/domain/goal-family.js";
import { createHypagoalWorkflow } from "../src/domain/hypagoal-creation.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import {
  parseFamilyPendingDispatchOwnData,
} from "../src/domain/family-concurrent-dispatch.js";
import { projectFamilyGraphView } from "../src/graph/family-projection.js";
import {
  FAMILY_PRODUCT_PARTIAL_FAILURE_MODE,
  deriveExecutorKindFromContinuation,
  enrichProductAttributesWithDerivedExecutorKinds,
  resolveFamilyProductConcurrencyPolicy,
  selectFamilyProductControllerAction,
} from "../src/pi/family-product-dispatch.js";
import {
  commitConcurrentFamilyBatchForHost,
  markFamilyPendingDispatchedForHost,
  prepareFamilyControllerPass,
  settleFamilyPendingForHost,
} from "../src/pi/family-controller-host.js";
import type { PersistedGoalFamily } from "../src/persistence/family-store.js";
import {
  familyDispatchOccupancySummary,
  familyGraphSummaryLines,
  familyWidgetLines,
  listFamilyPendingViews,
  renderFamilyStatus,
} from "../src/ui/family-surface.js";

const at = "2026-08-04T14:00:00.000Z";
const later = "2026-08-04T14:05:00.000Z";
const doneAt = "2026-08-04T14:10:00.000Z";

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

const createTwoMemberFamily = (familyId = "family-policy"): {
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
  familySnapshot: family,
  workflows: Object.fromEntries(
    Object.entries(memberStates).map(([, snapshot]) => [
      snapshot.workflowId,
      { events: [], snapshot },
    ]),
  ),
});

describe("gate1-2 product policy resolve", () => {
  it("resolves defaults for global, per-executor, groups, batch, and partial failure", () => {
    const policy = resolveFamilyProductConcurrencyPolicy(undefined);
    expect(policy.concurrent).toBe(true);
    expect(policy.maxBatchSize).toBe(2);
    expect(policy.globalConcurrency).toBe(DEFAULT_GLOBAL_CONCURRENCY);
    expect(policy.globalConcurrency).toBe(2);
    expect(policy.perExecutorKind).toEqual({});
    expect(policy.groups).toEqual([]);
    expect(policy.groupRegistry).toEqual({ groups: [] });
    expect(policy.attributesByGoalId).toEqual({});
    expect(policy.partialFailureMode).toBe(FAMILY_PRODUCT_PARTIAL_FAILURE_MODE);
    expect(policy.partialFailureMode).toBe("independent-settle");
    expect(policy.policyDiagnostics).toEqual([]);
    expect(policy.concurrencyLimits.globalConcurrency).toBe(2);
  });

  it("resolves overrides for global, per-executor, groups, and maxBatchSize", () => {
    const policy = resolveFamilyProductConcurrencyPolicy({
      concurrent: true,
      maxBatchSize: 3,
      globalConcurrency: 4,
      perExecutorKind: { "isolated-pi": 1, cli: 2 },
      groups: [
        { groupId: "mutex", maxConcurrent: 1 },
        { groupId: "shared", maxConcurrent: 3 },
      ],
      attributesByGoalId: {
        "goal-root": { groupIds: ["mutex"], executorKind: "isolated-pi" },
      },
      partialFailureMode: "independent-settle",
    });
    expect(policy.concurrent).toBe(true);
    expect(policy.maxBatchSize).toBe(3);
    expect(policy.globalConcurrency).toBe(4);
    expect(policy.perExecutorKind["isolated-pi"]).toBe(1);
    expect(policy.perExecutorKind.cli).toBe(2);
    expect(policy.groups.map((g) => g.groupId).sort()).toEqual(["mutex", "shared"]);
    expect(policy.groups.find((g) => g.groupId === "mutex")?.maxConcurrent).toBe(1);
    expect(policy.attributesByGoalId["goal-root"]?.groupIds).toEqual(["mutex"]);
    expect(policy.policyDiagnostics).toEqual([]);
  });

  it("turns concurrent off when concurrent is false or maxBatchSize is 1", () => {
    expect(resolveFamilyProductConcurrencyPolicy({ concurrent: false }).concurrent).toBe(false);
    expect(resolveFamilyProductConcurrencyPolicy({ maxBatchSize: 1 }).concurrent).toBe(false);
  });

  it("records diagnostics for invalid limits and unsupported partial-failure mode", () => {
    const badLimits = resolveFamilyProductConcurrencyPolicy({
      globalConcurrency: -1,
    });
    expect(badLimits.policyDiagnostics.length).toBeGreaterThan(0);
    expect(badLimits.policyDiagnostics.some((d) => d.code === "concurrency_invalid_bound")).toBe(
      true,
    );

    const badMode = resolveFamilyProductConcurrencyPolicy({
      // @ts-expect-error intentional unsupported mode for product surface
      partialFailureMode: "fail-all-siblings",
    });
    expect(badMode.policyDiagnostics.some(
      (d) => d.code === "family_product_partial_failure_unsupported",
    )).toBe(true);
  });

  it("records a diagnostic for maxBatchSize less than 1 (no silent clamp)", () => {
    const bad = resolveFamilyProductConcurrencyPolicy({
      concurrent: true,
      maxBatchSize: 0,
    });
    expect(bad.policyDiagnostics.some(
      (d) => d.code === "family_product_invalid_max_batch_size",
    )).toBe(true);
    // Shape falls back to 1 only after diagnostic; concurrent product selection rejects.
    expect(bad.maxBatchSize).toBe(1);
  });
});

describe("gate1-2 product selection enforces limits and groups", () => {
  it("enforces global limit so occupancy at capacity blocks further selection", () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-global-limit");
    const familyRecord = toPersisted(family, memberStates);

    const first = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord,
      concurrencyPolicy: {
        concurrent: true,
        maxBatchSize: 2,
        globalConcurrency: 2,
      },
    });
    expect(first.kind).toBe("dispatch-batch");
    if (first.kind !== "dispatch-batch") return;
    expect(first.items).toHaveLength(2);
    expect(first.concurrencyPolicy.globalConcurrency).toBe(2);
    expect(first.concurrencyPolicy.maxBatchSize).toBe(2);

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: first.items,
      at: later,
      // Prefer resolved policy from the selection decision (shared object path).
      resolvedConcurrencyPolicy: first.concurrencyPolicy,
      createDispatchId: (index, item) => `global-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(pendingDispatchCount(committed.family)).toBe(2);

    const blocked = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(committed.family, memberStates),
      concurrencyPolicy: {
        concurrent: true,
        maxBatchSize: 2,
        globalConcurrency: 2,
      },
    });
    expect(blocked.kind).toBe("family-blocked");
    if (blocked.kind !== "family-blocked") return;
    expect(blocked.reason).toMatch(/pending/i);
    expect(blocked.reason).not.toMatch(/idle/i);
  });

  it("selects at most one candidate under globalConcurrency 1", () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-global-one");
    const decision = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: {
        concurrent: true,
        maxBatchSize: 2,
        globalConcurrency: 1,
      },
    });
    expect(decision.kind).toBe("dispatch-batch");
    if (decision.kind !== "dispatch-batch") return;
    expect(decision.items).toHaveLength(1);
  });

  it("exclusive group admits at most one of two candidates in the same group", () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-exclusive");
    const decision = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: {
        concurrent: true,
        maxBatchSize: 2,
        globalConcurrency: 2,
        groups: [{ groupId: "exclusive-work", maxConcurrent: 1 }],
        attributesByGoalId: {
          "goal-root": { groupIds: ["exclusive-work"] },
          "goal-child": { groupIds: ["exclusive-work"] },
        },
      },
    });
    expect(decision.kind).toBe("dispatch-batch");
    if (decision.kind !== "dispatch-batch") return;
    expect(decision.items).toHaveLength(1);
  });

  it("concurrent group with capacity greater than 1 allows multiple when global allows", () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-concurrent-group");
    const decision = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: {
        concurrent: true,
        maxBatchSize: 2,
        globalConcurrency: 2,
        groups: [{ groupId: "shared-work", maxConcurrent: 2 }],
        attributesByGoalId: {
          "goal-root": { groupIds: ["shared-work"] },
          "goal-child": { groupIds: ["shared-work"] },
        },
      },
    });
    expect(decision.kind).toBe("dispatch-batch");
    if (decision.kind !== "dispatch-batch") return;
    expect(decision.items).toHaveLength(2);
    const goals = decision.items.map((item) => item.memberGoalId).sort();
    expect(goals).toEqual(["goal-child", "goal-root"]);
  });

  it("rejects product selection when policy diagnostics are present", () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-bad-policy");
    const decision = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: {
        concurrent: true,
        maxBatchSize: 2,
        globalConcurrency: -5,
      },
    });
    expect(decision.kind).toBe("family-rejected");
    if (decision.kind !== "family-rejected") return;
    expect(decision.diagnostics.some((d) => d.code === "concurrency_invalid_bound")).toBe(true);
  });

  it("prepareFamilyControllerPass returns full resolved policy and pending count", () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-prepare");
    const prepared = prepareFamilyControllerPass({
      familyRecord: toPersisted(family, memberStates),
      liveState: rootState,
      concurrencyPolicy: {
        globalConcurrency: 3,
        groups: [{ groupId: "g1", maxConcurrent: 1 }],
      },
    });
    expect(prepared.policy.globalConcurrency).toBe(3);
    expect(prepared.policy.groups).toEqual([{ groupId: "g1", maxConcurrent: 1 }]);
    expect(prepared.pendingCount).toBe(0);
    expect(Object.keys(prepared.memberStates).sort()).toEqual(["goal-child", "goal-root"]);
  });

  it("enforces per-executor limits with attributesByGoalId executor kinds", () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-per-executor");
    // Both members are start-ready-task (model) when attributes force isolated-pi.
    // Per-executor isolated-pi limit 1 admits only one of two candidates.
    const decision = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: {
        concurrent: true,
        maxBatchSize: 2,
        globalConcurrency: 2,
        perExecutorKind: { "isolated-pi": 1 },
        attributesByGoalId: {
          "goal-root": { executorKind: "isolated-pi" },
          "goal-child": { executorKind: "isolated-pi" },
        },
      },
    });
    expect(decision.kind).toBe("dispatch-batch");
    if (decision.kind !== "dispatch-batch") return;
    expect(decision.items).toHaveLength(1);
    expect(decision.concurrencyPolicy.perExecutorKind["isolated-pi"]).toBe(1);
  });

  it("derives deterministic and request-revision kinds without member state", () => {
    expect(deriveExecutorKindFromContinuation({ kind: "run-ready-check" })).toBe("deterministic");
    expect(deriveExecutorKindFromContinuation({ kind: "request-revision" })).toBe("current-session");
    // Model task without node profile defaults to isolated-pi.
    expect(deriveExecutorKindFromContinuation({ kind: "start-ready-task", nodeId: "work" }))
      .toBe("isolated-pi");
  });

  it("derives current-session from node.executorProfile without explicit attributes", () => {
    const root = createRootFamily({
      familyId: "family-derive-cs",
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

    const currentSessionTask = (title: string): HypagraphDefinition => ({
      title,
      goal: title,
      nodes: [{
        id: "work",
        title: "Work",
        requires: [],
        acceptance: [],
        executorProfile: {
          profileId: "current-session-default",
          kind: "current-session",
        },
      }],
      loops: [],
      policy: { mode: "guided", requireEvidence: false },
    });
    const rootState = createMemberWorkflow(
      currentSessionTask("Root work"),
      "workflow-root",
      "goal-root",
    );
    const childState = createMemberWorkflow(
      currentSessionTask("Child work"),
      "workflow-child",
      "goal-child",
    );
    const memberStates = {
      "goal-root": rootState,
      "goal-child": childState,
    };

    // Unit: derivation from continuation + member state uses node profile.
    expect(deriveExecutorKindFromContinuation(
      { kind: "start-ready-task", nodeId: "work" },
      rootState,
    )).toBe("current-session");

    const derived = enrichProductAttributesWithDerivedExecutorKinds(
      child.family,
      memberStates,
      {},
    );
    expect(derived["goal-root"]?.executorKind).toBe("current-session");
    expect(derived["goal-child"]?.executorKind).toBe("current-session");

    // Product selection: both members are current-session; per-executor limit 1 admits one.
    // No attributesByGoalId.executorKind — derivation must supply the kind.
    const decision = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(child.family, memberStates),
      concurrencyPolicy: {
        concurrent: true,
        maxBatchSize: 2,
        globalConcurrency: 2,
        perExecutorKind: { "current-session": 1 },
      },
    });
    expect(decision.kind).toBe("dispatch-batch");
    if (decision.kind !== "dispatch-batch") return;
    expect(decision.items).toHaveLength(1);
  });
});

describe("gate1-2 partial-failure product path", () => {
  it("settles one failed pending and leaves the other pending", () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-one-of-n-fail");
    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2 },
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      createDispatchId: (index, item) => `fail-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const firstId = committed.items[0]!.dispatchId;
    const secondId = committed.items[1]!.dispatchId;

    const marked = markFamilyPendingDispatchedForHost({
      family: committed.family,
      dispatchId: firstId,
      at: later,
    });
    expect(marked.ok).toBe(true);
    if (!marked.ok) return;

    const failed = settleFamilyPendingForHost({
      family: marked.family,
      dispatchId: firstId,
      at: doneAt,
      outcome: "failed",
      reason: "One of N failed on purpose.",
      partialFailureMode: "independent-settle",
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.family.pendingDispatches[firstId]).toBeUndefined();
    expect(failed.family.pendingDispatches[secondId]).toBeDefined();
    expect(failed.family.lastDispatchOutcome?.status).toBe("failed");
    expect(pendingDispatchCount(failed.family)).toBe(1);
  });

  it("interrupts one of N and leaves the other pending", () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-interrupt-n");
    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2 },
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      resolvedConcurrencyPolicy: selection.concurrencyPolicy,
      createDispatchId: (index, item) => `int-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const firstId = committed.items[0]!.dispatchId;
    const secondId = committed.items[1]!.dispatchId;

    const interrupted = settleFamilyPendingForHost({
      family: committed.family,
      dispatchId: firstId,
      at: doneAt,
      outcome: "interrupted",
      reason: "Interrupt first only.",
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.family.pendingDispatches[firstId]).toBeUndefined();
    expect(interrupted.family.pendingDispatches[secondId]?.status).toBe("selected");
    expect(interrupted.family.lastDispatchOutcome?.status).toBe("interrupted");
    expect(pendingDispatchCount(interrupted.family)).toBe(1);
  });

  it("rejects unsupported partial-failure settle mode without clearing siblings", () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-bad-settle-mode");
    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2 },
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      resolvedConcurrencyPolicy: selection.concurrencyPolicy,
      createDispatchId: (index, item) => `mode-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(pendingDispatchCount(committed.family)).toBe(2);

    const firstId = committed.items[0]!.dispatchId;
    const secondId = committed.items[1]!.dispatchId;
    const rejected = settleFamilyPendingForHost({
      family: committed.family,
      dispatchId: firstId,
      at: doneAt,
      outcome: "failed",
      reason: "Unsupported mode must not settle.",
      // @ts-expect-error intentional unsupported settle mode
      partialFailureMode: "fail-all-siblings",
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.diagnostics[0]?.code).toBe("family_product_partial_failure_unsupported");
    // Sibling and target pendings remain untouched when mode is rejected.
    expect(committed.family.pendingDispatches[firstId]).toBeDefined();
    expect(committed.family.pendingDispatches[secondId]).toBeDefined();
    expect(pendingDispatchCount(committed.family)).toBe(2);
  });
});

describe("gate1-2 restore multi-pending", () => {
  it("round-trips multi-pending through rebuild and pending parse", () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-restore-multi");
    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2 },
    });
    expect(selection.kind).toBe("dispatch-batch");
    if (selection.kind !== "dispatch-batch") return;

    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      createDispatchId: (index, item) => `restore-${item.memberGoalId}-${index}`,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(pendingDispatchCount(committed.family)).toBe(2);

    const rebuilt = rebuildFamilyMembershipFromSnapshot(structuredClone(committed.family));
    expect(rebuilt.schemaVersion).toBe(GOAL_FAMILY_SCHEMA_VERSION);
    expect(pendingDispatchCount(rebuilt)).toBe(2);
    expect(listPendingDispatches(rebuilt)).toHaveLength(2);

    const parsed = parseFamilyPendingDispatchOwnData(
      rebuilt as object,
      "family.pendingDispatches",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(2);

    // Host must not claim idle while multi-pending exists after restore.
    const afterRestore = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(rebuilt, memberStates),
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2, globalConcurrency: 2 },
    });
    expect(afterRestore.kind).toBe("family-blocked");
  });

  it("rejects unsupported goal-family schema versions clearly", () => {
    const { family } = createTwoMemberFamily("family-bad-schema-restore");
    const bad = {
      ...family,
      schemaVersion: 2 as typeof GOAL_FAMILY_SCHEMA_VERSION,
    };
    expect(() => rebuildFamilyMembershipFromSnapshot(bad)).toThrow(
      /Unsupported goal-family schema/,
    );
  });
});

describe("gate1-2 status honesty for multi-pending", () => {
  const multiPendingView = () => {
    const { family, rootState, memberStates } = createTwoMemberFamily("family-status-multi");
    const selection = selectFamilyProductControllerAction({
      liveState: rootState,
      familyRecord: toPersisted(family, memberStates),
      concurrencyPolicy: { concurrent: true, maxBatchSize: 2 },
    });
    if (selection.kind !== "dispatch-batch") {
      throw new Error(`expected dispatch-batch, got ${selection.kind}`);
    }
    const committed = commitConcurrentFamilyBatchForHost({
      family,
      memberStates,
      items: selection.items,
      at: later,
      createDispatchId: (index, item) => `status-${item.memberGoalId}-${index}`,
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.diagnostics));

    const view = projectFamilyGraphView({
      family: committed.family,
      memberStates,
      focusedGoalId: "goal-root",
    });
    return { view, family: committed.family };
  };

  it("projection includes all pendings and status does not report idle", () => {
    const { view } = multiPendingView();
    expect(view.scheduler.pendings).toBeDefined();
    expect(view.scheduler.pendings).toHaveLength(2);
    expect(view.scheduler.pending).toBeDefined();

    const pendings = listFamilyPendingViews(view.scheduler);
    expect(pendings).toHaveLength(2);

    const occupancy = familyDispatchOccupancySummary(view.scheduler);
    expect(occupancy).toBe("dispatch multi-pending x2");
    expect(occupancy).not.toContain("idle");

    const widget = familyWidgetLines(view).join("\n");
    expect(widget).toContain("dispatch multi-pending x2");
    expect(widget).not.toContain("dispatch idle");

    const status = renderFamilyStatus(view, 120);
    expect(status).toContain("multi-pending x2");
    expect(status).toContain("goal-root");
    expect(status).toContain("goal-child");
    expect(status).not.toMatch(/Family dispatch: idle/);

    const chrome = familyGraphSummaryLines(view, 100).join("\n");
    expect(chrome).toContain("dispatch multi-pending x2");
    expect(chrome).not.toContain("dispatch idle");
  });

  it("reports idle only when no pendings exist", () => {
    const { family, memberStates } = createTwoMemberFamily("family-status-idle");
    const view = projectFamilyGraphView({
      family,
      memberStates,
      focusedGoalId: "goal-root",
    });
    expect(listFamilyPendingViews(view.scheduler)).toHaveLength(0);
    expect(familyDispatchOccupancySummary(view.scheduler)).toBe("dispatch idle");
    expect(renderFamilyStatus(view, 100)).toContain("Family dispatch: idle");
  });
});
