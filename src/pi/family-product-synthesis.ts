/**
 * Product-path helpers for child-outcome synthesis fan-in (S6 / Gate 2.2).
 *
 * After child returns settle, the host evaluates an all-success join over a
 * declared binding set and applies the result to the parent workflow:
 * - publish join.passed when the parent declares that boolean produce;
 * - block the parent node when the join fails and the parent is still running.
 *
 * Auto product path (no explicit policy):
 * - Join set is every binding for (parentGoalId, parentNodeId).
 * - Apply only when every binding is terminal, the parent node is running,
 *   the parent declares the result fact produce, the fact is not already on
 *   the current attempt, and either expectedBindingCount is met or the set
 *   has at least AUTO_JOIN_MIN_BINDING_COUNT (2) bindings.
 * - Without expectedBindingCount, auto multi-child is only safe for a planned
 *   join of exactly two children. After two sequential returns the set size is
 *   two and the join can apply. For three or more sequential children, set
 *   expectedBindingCount to the planned size, or the second return can complete
 *   the join early. One-child joins need an explicit policy or expectedBindingCount: 1.
 *
 * Failed-join host publish and block run only while the parent is still
 * running. When a child failure policy already failed or blocked the parent,
 * synthesis does not re-apply. That case is a quiet skip on re-entry (no
 * repeated diagnostic). Child failure policy owns that path.
 *
 * These helpers are pure of Pi I/O. Extension commits parent events and
 * family records after the helpers return.
 */

import {
  applyChildOutcomeSynthesisToParent,
  createAllSuccessJoinPolicy,
  DEFAULT_JOIN_RESULT_FACT_NAME,
  isJoinSetTerminal,
  joinResultFactAlreadyApplied,
  listBindingsForParentJoin,
  parentDeclaresJoinResultFact,
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

/**
 * Minimum binding count for auto product join without expectedBindingCount.
 * Auto without that field is only safe for a planned join of exactly two
 * children. For N greater than 2, set expectedBindingCount to N.
 */
export const AUTO_JOIN_MIN_BINDING_COUNT = 2 as const;

export interface ProductJoinSynthesisInput {
  family: GoalFamilyRuntime;
  parentState: HypagraphState;
  /**
   * Explicit join policy. When omitted, the host builds an all-success policy
   * from all bindings for parentGoalId + parentNodeId (auto product path).
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
    factPublished: boolean;
    parentMutated: boolean;
  }
  | {
    ok: true;
    status: "skipped";
    result: ChildOutcomeSynthesisResult;
    policy: ChildOutcomeSynthesisPolicy;
    reason: string;
  }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Resolve the join policy for a parent node group.
 * Explicit policy takes priority. Otherwise all bindings for the parent goal
 * and node form an all-success join set.
 */
export function resolveProductJoinPolicy(input: {
  family: GoalFamilyRuntime;
  parentGoalId: string;
  parentNodeId: string;
  policy?: ChildOutcomeSynthesisPolicy;
}): { ok: true; policy: ChildOutcomeSynthesisPolicy; explicit: boolean } | { ok: false; diagnostics: Diagnostic[] } {
  if (input.policy) {
    const validated = validateChildOutcomeSynthesisPolicy(input.policy);
    if (!validated.ok) return validated;
    return { ok: true, policy: validated.policy, explicit: true };
  }
  const bindingIds = listBindingsForParentJoin({
    family: input.family,
    parentGoalId: input.parentGoalId,
    parentNodeId: input.parentNodeId,
  });
  const created = createAllSuccessJoinPolicy({ bindingIds });
  if (!created.ok) return created;
  return { ok: true, policy: created.policy, explicit: false };
}

/**
 * Decide whether the auto product path may apply a terminal join.
 * Explicit policies skip the multi-binding minimum and only honour expectedBindingCount.
 */
export function isAutoProductJoinEligible(input: {
  policy: ChildOutcomeSynthesisPolicy;
  explicit: boolean;
  parentState: HypagraphState;
  parentNodeId: string;
  parentAttemptId: string;
}): { eligible: true } | { eligible: false; reason: string; pending: boolean } {
  const { policy, explicit, parentState, parentNodeId, parentAttemptId } = input;

  if (!parentDeclaresJoinResultFact(parentState, parentNodeId, policy.resultFactName)) {
    return {
      eligible: false,
      pending: false,
      reason:
        `Parent task '${parentNodeId}' does not declare boolean produce `
        + `'${policy.resultFactName}'. Product join apply requires that produce.`,
    };
  }

  if (joinResultFactAlreadyApplied(parentState, policy.resultFactName, parentAttemptId)) {
    return {
      eligible: false,
      pending: false,
      reason:
        `Join result fact '${policy.resultFactName}' is already present on attempt `
        + `'${parentAttemptId}'.`,
    };
  }

  if (policy.expectedBindingCount !== undefined) {
    if (policy.bindingIds.length < policy.expectedBindingCount) {
      const remaining = policy.expectedBindingCount - policy.bindingIds.length;
      const word = remaining === 1 ? "binding" : "bindings";
      return {
        eligible: false,
        pending: true,
        reason:
          `Join waits for ${remaining} more ${word} `
          + `(${policy.bindingIds.length} of ${policy.expectedBindingCount} present).`,
      };
    }
    return { eligible: true };
  }

  // Auto path without expectedBindingCount: require at least two bindings so
  // the first sequential child return cannot complete a multi-child join.
  // This rule is only safe for a planned join of exactly two children.
  // For three or more, set expectedBindingCount (second of three can otherwise
  // complete the join early when the set size reaches two).
  if (!explicit && policy.bindingIds.length < AUTO_JOIN_MIN_BINDING_COUNT) {
    return {
      eligible: false,
      pending: true,
      reason:
        `Auto join waits for at least ${AUTO_JOIN_MIN_BINDING_COUNT} terminal bindings `
        + `or an explicit policy with expectedBindingCount. `
        + `Current set has ${policy.bindingIds.length}. `
        + `For more than two planned children, set expectedBindingCount.`,
    };
  }

  // Explicit one-child policy without expectedBindingCount is allowed.
  return { eligible: true };
}

/**
 * Evaluate and, when terminal and eligible, apply child-outcome synthesis.
 *
 * Returns pending when any join binding is still active or expected count is not met.
 * Returns skipped when the product path must not apply (no produce, already applied).
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
  const { policy, explicit } = policyResult;

  const evaluated = synthesizeChildOutcomesFromFamily(input.family, policy);
  if (!evaluated.ok) return evaluated;

  if (evaluated.result.status === "pending") {
    return {
      ok: true,
      status: "pending",
      result: evaluated.result,
      policy,
    };
  }

  const eligibility = isAutoProductJoinEligible({
    policy,
    explicit,
    parentState: input.parentState,
    parentNodeId: input.parentNodeId,
    parentAttemptId: input.parentAttemptId,
  });
  if (!eligibility.eligible) {
    if (eligibility.pending) {
      return {
        ok: true,
        status: "pending",
        result: {
          ...evaluated.result,
          status: "pending",
          passed: false,
          reason: eligibility.reason,
          publishedFact: undefined,
        },
        policy,
      };
    }
    return {
      ok: true,
      status: "skipped",
      result: evaluated.result,
      policy,
      reason: eligibility.reason,
    };
  }

  const applied = applyChildOutcomeSynthesisToParent({
    parentState: input.parentState,
    policy,
    result: evaluated.result,
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

  return {
    ok: true,
    status: "applied",
    parentState: applied.parentState,
    parentEvents: applied.parentEvents,
    result: applied.result,
    policy,
    record: applied.record,
    factPublished: applied.factPublished,
    parentMutated: applied.parentMutated,
  };
}

export interface AppliedJoinSynthesis {
  parentNodeId: string;
  result: ChildOutcomeSynthesisResult;
  policy: ChildOutcomeSynthesisPolicy;
  factPublished: boolean;
  parentMutated: boolean;
}

/**
 * After product child returns, try join synthesis for each parent node group
 * that has no remaining active bindings and meets auto or explicit readiness.
 *
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
  applied: AppliedJoinSynthesis[];
  pending: Array<{ parentNodeId: string; result: ChildOutcomeSynthesisResult }>;
  skipped: Array<{ parentNodeId: string; reason: string }>;
  diagnostics: Diagnostic[];
} {
  let parentState = input.parentState;
  const parentEvents: DomainEvent[] = [];
  const applied: AppliedJoinSynthesis[] = [];
  const pending: Array<{ parentNodeId: string; result: ChildOutcomeSynthesisResult }> = [];
  const skipped: Array<{ parentNodeId: string; reason: string }> = [];
  const diagnostics: Diagnostic[] = [];

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

    const explicitPolicy = input.policiesByParentNodeId?.[parentNodeId];
    const policyResult = resolveProductJoinPolicy({
      family: input.family,
      parentGoalId: input.parentGoalId,
      parentNodeId,
      ...(explicitPolicy ? { policy: explicitPolicy } : {}),
    });
    if (!policyResult.ok) {
      diagnostics.push(...policyResult.diagnostics);
      continue;
    }

    if (!isJoinSetTerminal(input.family, policyResult.policy.bindingIds)) {
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
      // Parent cannot accept synthesis apply (for example child failure policy
      // already failed or blocked the parent). Child failure policy owns that
      // path. Quiet skip on re-entry: do not emit a diagnostic every pass.
      const evaluated = synthesizeChildOutcomesFromFamily(input.family, policyResult.policy);
      if (!evaluated.ok) {
        diagnostics.push(...evaluated.diagnostics);
        continue;
      }
      skipped.push({
        parentNodeId,
        reason:
          `Join for parent node '${parentNodeId}' is terminal but the parent is `
          + `'${parentNode?.status ?? "missing"}'. `
          + "Synthesis apply is skipped. Child failure policy owns the parent effect.",
      });
      continue;
    }

    const synthesis = applyProductJoinSynthesis({
      family: input.family,
      parentState,
      parentGoalId: input.parentGoalId,
      parentNodeId,
      parentAttemptId: parentNode.currentAttemptId,
      at: input.at,
      ...(explicitPolicy ? { policy: explicitPolicy } : {}),
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
    if (synthesis.status === "skipped") {
      skipped.push({ parentNodeId, reason: synthesis.reason });
      continue;
    }
    parentState = synthesis.parentState;
    parentEvents.push(...synthesis.parentEvents);
    applied.push({
      parentNodeId,
      result: synthesis.result,
      policy: synthesis.policy,
      factPublished: synthesis.factPublished,
      parentMutated: synthesis.parentMutated,
    });
  }

  return {
    ok: true,
    parentState,
    parentEvents,
    applied,
    pending,
    skipped,
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
  factPublished: boolean;
  parentMutated: boolean;
}): string {
  const counts = `${input.completedCount}/${input.totalCount} completed`;
  if (input.status === "passed") {
    if (input.factPublished) {
      return (
        `Child join synthesis passed for parent task '${input.parentNodeId}' `
        + `(${counts}). Published '${input.resultFactName}'=true. `
        + `Parent status is '${input.parentNodeStatus}'.`
      );
    }
    return (
      `Child join synthesis passed for parent task '${input.parentNodeId}' `
      + `(${counts}). Evaluation only; '${input.resultFactName}' was not published. `
      + `Parent status is '${input.parentNodeStatus}'.`
    );
  }
  if (input.factPublished) {
    return (
      `Child join synthesis failed for parent task '${input.parentNodeId}' `
      + `(${counts}). Published '${input.resultFactName}'=false. `
      + `Parent status is '${input.parentNodeStatus}'.`
    );
  }
  if (input.parentMutated) {
    return (
      `Child join synthesis failed for parent task '${input.parentNodeId}' `
      + `(${counts}). Parent was blocked. `
      + `Parent status is '${input.parentNodeStatus}'.`
    );
  }
  return (
    `Child join synthesis failed for parent task '${input.parentNodeId}' `
    + `(${counts}). No parent mutation was applied. `
    + `Parent status is '${input.parentNodeStatus}'.`
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
  applied: AppliedJoinSynthesis[];
  pending: Array<{ parentNodeId: string; result: ChildOutcomeSynthesisResult }>;
  skipped: Array<{ parentNodeId: string; reason: string }>;
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
      skipped: ready.skipped,
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
    skipped: ready.skipped,
    diagnostics: ready.diagnostics,
  };
}

// Re-export synthesizeAndApply for tests that need the pure domain path.
export { synthesizeAndApplyChildOutcomes };
