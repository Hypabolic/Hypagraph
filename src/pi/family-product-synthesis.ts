/**
 * Product-path helpers for child-outcome synthesis fan-in (S6 / Gate 2.2).
 *
 * After child returns settle, the host evaluates an all-success join over a
 * declared binding set and applies the result to the parent workflow:
 * - publish join.passed on the auto path (host-default fact; produce optional);
 * - publish a custom result fact only when the parent declares that produce;
 * - block the parent node when the join fails and the parent is still running.
 *
 * Auto product path (no explicit policy):
 * - Join set is every binding for (parentGoalId, parentNodeId).
 * - Apply only when every binding is terminal, the parent node is running,
 *   the fact is not already on the current attempt, and either
 *   expectedBindingCount is met or the set has at least
 *   AUTO_JOIN_MIN_BINDING_COUNT (2) bindings.
 * - Default result fact join.passed does not require a parent produce.
 * - Custom resultFactName still requires a matching boolean produce.
 * - Multi-child wait set (ordinary path): the parent may create siblings while
 *   waiting_for_child. Intermediate completed returns keep the parent waiting
 *   while any sibling binding is active. The last clearing return resumes the
 *   parent to running. Auto join then sees a full terminal set without a hand
 *   expectedBindingCount. One-child joins still need an explicit policy or
 *   expectedBindingCount: 1 (AUTO_JOIN_MIN stays 2).
 * - Create tally (§4.2.2) is not required for J2: product create and return
 *   commits are single-threaded on one parent wait set, so natural wait-set
 *   safety is sufficient. A host tally remains optional if a later race appears.
 * - Explicit expectedBindingCount remains available for advanced callers and tests.
 *
 * Explicit policy path keeps declare-required for the result fact.
 * Explicit does not opt into host-default publish.
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
  mayPublishHostDefaultJoinFact,
  parentDeclaresJoinResultFact,
  parentJoinResultFactTypeConflict,
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
 * With the multi-child wait set, ordinary N≥2 joins are safe without a hand
 * count: the parent stays waiting until every sibling binding is terminal.
 * One-child auto join still requires an explicit policy or expectedBindingCount: 1.
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
 * Decide whether the product path may apply a terminal join.
 * Explicit policies skip the multi-binding minimum and only honour expectedBindingCount.
 * Explicit policies keep declare-required for the result fact.
 * Auto path allows DEFAULT_JOIN_RESULT_FACT_NAME without a parent produce.
 *
 * When eligible, allowHostDefaultJoinFact is the single resolved publish decision
 * for the apply path (true only when the parent has no boolean produce and the
 * auto host-default path is active).
 */
export function isAutoProductJoinEligible(input: {
  policy: ChildOutcomeSynthesisPolicy;
  explicit: boolean;
  parentState: HypagraphState;
  parentNodeId: string;
  parentAttemptId: string;
}):
  | { eligible: true; allowHostDefaultJoinFact: boolean }
  | { eligible: false; reason: string; pending: boolean } {
  const { policy, explicit, parentState, parentNodeId, parentAttemptId } = input;

  const factDeclared = parentDeclaresJoinResultFact(
    parentState,
    parentNodeId,
    policy.resultFactName,
  );
  if (parentJoinResultFactTypeConflict(parentState, parentNodeId, policy.resultFactName)) {
    return {
      eligible: false,
      pending: false,
      reason:
        `Parent task '${parentNodeId}' declares produce `
        + `'${policy.resultFactName}' with a non-boolean type. `
        + "Join requires a boolean produce, or no produce for the default fact name.",
    };
  }
  // Auto path may publish default join.passed without produce (host-only fact).
  // Explicit policies and custom result fact names still require the produce.
  const hostDefaultAllowed = mayPublishHostDefaultJoinFact({
    allowHostDefaultJoinFact: !explicit,
    resultFactName: policy.resultFactName,
    publishedFactName: policy.resultFactName,
  });
  if (!factDeclared && !hostDefaultAllowed) {
    return {
      eligible: false,
      pending: false,
      reason:
        `Parent task '${parentNodeId}' does not declare boolean produce `
        + `'${policy.resultFactName}'. Product join apply requires that produce `
        + "for explicit policies and custom result fact names.",
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

  // Single resolved decision: host-default only when produce is absent and allowed.
  const allowHostDefaultJoinFact = !factDeclared && hostDefaultAllowed;

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
    return { eligible: true, allowHostDefaultJoinFact };
  }

  // Auto path without expectedBindingCount: require at least two bindings so
  // a single-child return cannot auto-join. Multi-child wait set keeps the
  // parent waiting until every sibling for the parent node is terminal, so
  // ordinary N≥2 joins do not apply early without a hand expectedBindingCount.
  if (!explicit && policy.bindingIds.length < AUTO_JOIN_MIN_BINDING_COUNT) {
    return {
      eligible: false,
      pending: true,
      reason:
        `Auto join waits for at least ${AUTO_JOIN_MIN_BINDING_COUNT} terminal bindings `
        + `or an explicit policy with expectedBindingCount. `
        + `Current set has ${policy.bindingIds.length}.`,
    };
  }

  // Explicit one-child policy without expectedBindingCount is allowed.
  return { eligible: true, allowHostDefaultJoinFact };
}

/**
 * Evaluate and, when terminal and eligible, apply child-outcome synthesis.
 *
 * Returns pending when any join binding is still active or expected count is not met.
 * Returns skipped when the product path must not apply (already applied, or
 * produce required and missing for explicit or custom fact names).
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
      const { publishedFact: _omitPublishedFact, ...pendingBase } = evaluated.result;
      return {
        ok: true,
        status: "pending",
        result: {
          ...pendingBase,
          status: "pending",
          passed: false,
          reason: eligibility.reason,
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

  // Use the single eligibility decision for host-default publish.
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
    ...(eligibility.allowHostDefaultJoinFact
      ? { allowHostDefaultJoinFact: true }
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
