/**
 * Product-path helpers for child-outcome synthesis fan-in (S6 / Gate 2.2).
 *
 * After child returns settle, the host evaluates an all-success join over a
 * declared binding set and applies the result to the parent workflow:
 * - publish join.passed (or configured fact) when the parent declares it;
 * - block the parent node when the join fails.
 *
 * These helpers are pure of Pi I/O. Extension commits parent events and
 * family records after the helpers return.
 */

import {
  applyChildOutcomeSynthesisToParent,
  createAllSuccessJoinPolicy,
  DEFAULT_JOIN_RESULT_FACT_NAME,
  isJoinSetTerminal,
  listBindingsForParentJoin,
  synthesizeAndApplyChildOutcomes,
  synthesizeChildOutcomesFromFamily,
  validateChildOutcomeSynthesisPolicy,
  type ChildOutcomeSynthesisApplyResult,
  type ChildOutcomeSynthesisPolicy,
  type ChildOutcomeSynthesisResult,
} from "../domain/child-outcome-synthesis.js";
import type { GoalFamilyRuntime } from "../domain/goal-family.js";
import type { Diagnostic, DomainEvent, HypagraphState } from "../domain/model.js";
import type { PersistedGoalFamily } from "../persistence/family-store.js";

export {
  createAllSuccessJoinPolicy,
  DEFAULT_JOIN_RESULT_FACT_NAME,
  isJoinSetTerminal,
  listBindingsForParentJoin,
  synthesizeChildOutcomesFromFamily,
  validateChildOutcomeSynthesisPolicy,
};
export type { ChildOutcomeSynthesisPolicy, ChildOutcomeSynthesisResult };

export interface ProductJoinSynthesisInput {
  family: GoalFamilyRuntime;
  parentState: HypagraphState;
  /**
   * Explicit join policy. When omitted, the host builds an all-success policy
   * from all bindings for parentGoalId + parentNodeId.
   */
  policy?: ChildOutcomeSynthesisPolicy;
  parentGoalId: string;
  parentNodeId: string;
  parentAttemptId: string;
  at: string;
  commandId?: string;
  correlationId?: string;
  blockParentOnFailure?: boolean;
}

export type ProductJoinSynthesisResult =
  | { ok: true; status: "pending"; result: ChildOutcomeSynthesisResult; policy: ChildOutcomeSynthesisPolicy }
  | {
    ok: true;
    status: "applied";
    parentState: HypagraphState;
    parentEvents: DomainEvent[];
    result: ChildOutcomeSynthesisResult;
    policy: ChildOutcomeSynthesisPolicy;
    record: NonNullable<Extract<ChildOutcomeSynthesisApplyResult, { ok: true }>["record"]>;
  }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Resolve the join policy for a parent node group.
 * Explicit policy wins. Otherwise all bindings for the parent goal and node
 * form an all-success join set.
 */
export function resolveProductJoinPolicy(input: {
  family: GoalFamilyRuntime;
  parentGoalId: string;
  parentNodeId: string;
  policy?: ChildOutcomeSynthesisPolicy;
}): { ok: true; policy: ChildOutcomeSynthesisPolicy } | { ok: false; diagnostics: Diagnostic[] } {
  if (input.policy) {
    return validateChildOutcomeSynthesisPolicy(input.policy);
  }
  const bindingIds = listBindingsForParentJoin({
    family: input.family,
    parentGoalId: input.parentGoalId,
    parentNodeId: input.parentNodeId,
  });
  return createAllSuccessJoinPolicy({ bindingIds });
}

/**
 * Evaluate and, when terminal, apply child-outcome synthesis on the product path.
 *
 * Returns pending when any join binding is still active.
 * Does not mutate inputs.
 */
export function applyProductJoinSynthesis(
  input: ProductJoinSynthesisInput,
): ProductJoinSynthesisResult {
  const policyResult = resolveProductJoinPolicy({
    family: input.family,
    parentGoalId: input.parentGoalId,
    parentNodeId: input.parentNodeId,
    ...(input.policy ? { policy: input.policy } : {}),
  });
  if (!policyResult.ok) return policyResult;
  const policy = policyResult.policy;

  const applied = synthesizeAndApplyChildOutcomes({
    family: input.family,
    parentState: input.parentState,
    policy,
    parentNodeId: input.parentNodeId,
    parentAttemptId: input.parentAttemptId,
    at: input.at,
    ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.blockParentOnFailure !== undefined
      ? { blockParentOnFailure: input.blockParentOnFailure }
      : {}),
  });

  if (!applied.ok) return applied;
  if ("status" in applied && applied.status === "pending") {
    return {
      ok: true,
      status: "pending",
      result: applied.result,
      policy,
    };
  }

  // Terminal apply branch.
  if (!("parentState" in applied)) {
    return {
      ok: false,
      diagnostics: [{
        code: "child_outcome_synthesis_apply_incomplete",
        message: "Synthesis apply did not return parent state.",
      }],
    };
  }

  return {
    ok: true,
    status: "applied",
    parentState: applied.parentState,
    parentEvents: applied.parentEvents,
    result: applied.result,
    policy,
    record: applied.record,
  };
}

/**
 * After product child returns, try join synthesis for each parent node group
 * that has no remaining active bindings.
 *
 * Returns one applied synthesis at most per parent node group that is ready.
 * Parent state is chained when multiple groups apply in one pass.
 */
export function applyReadyJoinSynthesesAfterReturns(input: {
  family: GoalFamilyRuntime;
  parentState: HypagraphState;
  parentGoalId: string;
  at: string;
  /** Optional explicit policies keyed by parentNodeId. */
  policiesByParentNodeId?: Record<string, ChildOutcomeSynthesisPolicy>;
  blockParentOnFailure?: boolean;
}): {
  ok: true;
  parentState: HypagraphState;
  parentEvents: DomainEvent[];
  applied: Array<{
    parentNodeId: string;
    result: ChildOutcomeSynthesisResult;
    policy: ChildOutcomeSynthesisPolicy;
  }>;
  pending: Array<{ parentNodeId: string; result: ChildOutcomeSynthesisResult }>;
  diagnostics: Diagnostic[];
} {
  let parentState = input.parentState;
  const parentEvents: DomainEvent[] = [];
  const applied: Array<{
    parentNodeId: string;
    result: ChildOutcomeSynthesisResult;
    policy: ChildOutcomeSynthesisPolicy;
  }> = [];
  const pending: Array<{ parentNodeId: string; result: ChildOutcomeSynthesisResult }> = [];
  const diagnostics: Diagnostic[] = [];

  // Collect parent node ids that have at least one binding for this parent goal.
  const nodeIds = new Set<string>();
  for (const binding of Object.values(input.family.bindings)) {
    if (binding.parentGoalId === input.parentGoalId) {
      nodeIds.add(binding.parentNodeId);
    }
  }
  const orderedNodeIds = [...nodeIds].sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });

  for (const parentNodeId of orderedNodeIds) {
    const bindingIds = listBindingsForParentJoin({
      family: input.family,
      parentGoalId: input.parentGoalId,
      parentNodeId,
    });
    if (bindingIds.length === 0) continue;
    if (!isJoinSetTerminal(input.family, bindingIds)) {
      const policyResult = resolveProductJoinPolicy({
        family: input.family,
        parentGoalId: input.parentGoalId,
        parentNodeId,
        ...(input.policiesByParentNodeId?.[parentNodeId]
          ? { policy: input.policiesByParentNodeId[parentNodeId] }
          : {}),
      });
      if (!policyResult.ok) {
        diagnostics.push(...policyResult.diagnostics);
        continue;
      }
      const evaluated = synthesizeChildOutcomesFromFamily(input.family, policyResult.policy);
      if (evaluated.ok) {
        pending.push({ parentNodeId, result: evaluated.result });
      } else {
        diagnostics.push(...evaluated.diagnostics);
      }
      continue;
    }

    const parentNode = parentState.runtime.nodes[parentNodeId];
    if (!parentNode?.currentAttemptId || parentNode.status !== "running") {
      // Parent is not in a state that can accept synthesis apply (for example
      // already failed from a child failure policy). Record evaluation only.
      const policyResult = resolveProductJoinPolicy({
        family: input.family,
        parentGoalId: input.parentGoalId,
        parentNodeId,
        ...(input.policiesByParentNodeId?.[parentNodeId]
          ? { policy: input.policiesByParentNodeId[parentNodeId] }
          : {}),
      });
      if (!policyResult.ok) {
        diagnostics.push(...policyResult.diagnostics);
        continue;
      }
      const evaluated = synthesizeChildOutcomesFromFamily(input.family, policyResult.policy);
      if (evaluated.ok && evaluated.result.status !== "pending") {
        // Join is terminal but parent cannot accept apply. Surface as diagnostic
        // only when the join failed (parent may already be failed or blocked).
        if (evaluated.result.status === "failed") {
          diagnostics.push({
            code: "child_outcome_synthesis_parent_not_running",
            message:
              `Join for parent node '${parentNodeId}' failed but the parent is `
              + `'${parentNode?.status ?? "missing"}' and cannot accept synthesis apply.`,
            location: "parentNodeId",
          });
        }
      } else if (!evaluated.ok) {
        diagnostics.push(...evaluated.diagnostics);
      }
      continue;
    }

    const synthesis = applyProductJoinSynthesis({
      family: input.family,
      parentState,
      parentGoalId: input.parentGoalId,
      parentNodeId,
      parentAttemptId: parentNode.currentAttemptId,
      at: input.at,
      ...(input.policiesByParentNodeId?.[parentNodeId]
        ? { policy: input.policiesByParentNodeId[parentNodeId] }
        : {}),
      ...(input.blockParentOnFailure !== undefined
        ? { blockParentOnFailure: input.blockParentOnFailure }
        : {}),
    });

    if (!synthesis.ok) {
      diagnostics.push(...synthesis.diagnostics);
      continue;
    }
    if (synthesis.status === "pending") {
      pending.push({ parentNodeId, result: synthesis.result });
      continue;
    }
    parentState = synthesis.parentState;
    parentEvents.push(...synthesis.parentEvents);
    applied.push({
      parentNodeId,
      result: synthesis.result,
      policy: synthesis.policy,
    });
  }

  return {
    ok: true,
    parentState,
    parentEvents,
    applied,
    pending,
    diagnostics,
  };
}

/**
 * Notify text after product join synthesis applies.
 */
export function renderJoinSynthesisApplied(input: {
  parentNodeId: string;
  status: "passed" | "failed";
  completedCount: number;
  totalCount: number;
  resultFactName: string;
  parentNodeStatus: string;
}): string {
  if (input.status === "passed") {
    return (
      `Child join synthesis passed for parent task '${input.parentNodeId}' `
      + `(${input.completedCount}/${input.totalCount} completed). `
      + `Published '${input.resultFactName}'=true. Parent status is '${input.parentNodeStatus}'.`
    );
  }
  return (
    `Child join synthesis failed for parent task '${input.parentNodeId}' `
    + `(${input.completedCount}/${input.totalCount} completed). `
    + `Published '${input.resultFactName}'=false. Parent status is '${input.parentNodeStatus}'.`
  );
}

/**
 * Read family snapshot from a persisted family record.
 */
export function familySnapshotOf(family: PersistedGoalFamily | GoalFamilyRuntime): GoalFamilyRuntime {
  if ("familySnapshot" in family) {
    return family.familySnapshot;
  }
  return family;
}

/**
 * Apply ready join synthesis against a persisted family parent workflow.
 * Updates only the in-memory parent workflow snapshot and events.
 * Caller must persist the family and parent stream.
 */
export function applyReadyJoinSynthesesToPersistedFamily(input: {
  family: PersistedGoalFamily;
  parentGoalId: string;
  at: string;
  policiesByParentNodeId?: Record<string, ChildOutcomeSynthesisPolicy>;
  blockParentOnFailure?: boolean;
}): {
  ok: true;
  family: PersistedGoalFamily;
  applied: Array<{
    parentNodeId: string;
    result: ChildOutcomeSynthesisResult;
    policy: ChildOutcomeSynthesisPolicy;
  }>;
  pending: Array<{ parentNodeId: string; result: ChildOutcomeSynthesisResult }>;
  diagnostics: Diagnostic[];
} | { ok: false; diagnostics: Diagnostic[] } {
  const parentMember = input.family.familySnapshot.members[input.parentGoalId];
  if (!parentMember) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_parent_missing",
        message:
          `Goal family '${input.family.familySnapshot.familyId}' does not contain parent goal `
          + `'${input.parentGoalId}'.`,
        location: "parentGoalId",
      }],
    };
  }
  const parentWorkflow = input.family.workflows[parentMember.workflowId];
  if (!parentWorkflow) {
    return {
      ok: false,
      diagnostics: [{
        code: "goal_family_member_workflow_missing",
        message:
          `Goal family '${input.family.familySnapshot.familyId}' parent '${input.parentGoalId}' `
          + `references missing workflow '${parentMember.workflowId}'.`,
        location: "parentGoalId",
      }],
    };
  }

  const ready = applyReadyJoinSynthesesAfterReturns({
    family: input.family.familySnapshot,
    parentState: parentWorkflow.snapshot,
    parentGoalId: input.parentGoalId,
    at: input.at,
    ...(input.policiesByParentNodeId
      ? { policiesByParentNodeId: input.policiesByParentNodeId }
      : {}),
    ...(input.blockParentOnFailure !== undefined
      ? { blockParentOnFailure: input.blockParentOnFailure }
      : {}),
  });

  if (ready.parentEvents.length === 0) {
    return {
      ok: true,
      family: input.family,
      applied: ready.applied,
      pending: ready.pending,
      diagnostics: ready.diagnostics,
    };
  }

  const nextFamily: PersistedGoalFamily = {
    ...input.family,
    workflows: {
      ...input.family.workflows,
      [parentMember.workflowId]: {
        events: [...parentWorkflow.events, ...ready.parentEvents],
        snapshot: ready.parentState,
      },
    },
  };

  return {
    ok: true,
    family: nextFamily,
    applied: ready.applied,
    pending: ready.pending,
    diagnostics: ready.diagnostics,
  };
}
