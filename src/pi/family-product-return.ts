/**
 * Product-path helpers for child return after a member becomes terminal (Wave F3).
 *
 * Pure helpers select active bindings and map child goal status to return outcome.
 * Host commit uses returnChildGoalInFamily.
 */

import { goalIsTerminal } from "../domain/goal-policy.js";
import type {
  ChildGoalBinding,
  ChildReturnOutcomeKind,
  GoalFamilyRuntime,
} from "../domain/goal-family.js";
import type {
  EvidenceReference,
  FactInput,
  HypagraphState,
} from "../domain/model.js";
import type { PersistedGoalFamily } from "../persistence/family-store.js";

/**
 * Map a terminal child goal status to a child-return outcome.
 * Non-terminal statuses return undefined.
 */
export function childReturnOutcomeFromGoalStatus(
  status: string | undefined,
): ChildReturnOutcomeKind | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "budget_limited":
      return "budget_limited";
    default:
      return undefined;
  }
}

/**
 * Find active bindings whose child goal id matches.
 */
export function activeBindingsForChildGoal(
  family: GoalFamilyRuntime,
  childGoalId: string,
): ChildGoalBinding[] {
  return Object.values(family.bindings).filter(
    (binding) => binding.status === "active" && binding.childGoalId === childGoalId,
  );
}

/**
 * Collect declared output facts from the child workflow fact store.
 * Missing required facts are left out; pure return validates completeness for completed outcomes.
 */
export function collectChildReturnFacts(
  childState: HypagraphState,
  binding: ChildGoalBinding,
): FactInput[] {
  const facts: FactInput[] = [];
  for (const contract of binding.outputFacts) {
    const record = childState.runtime.facts[contract.name];
    if (!record) continue;
    facts.push({
      name: record.name,
      type: record.type,
      value: structuredClone(record.value),
      ...(record.evidence.length > 0
        ? { evidence: structuredClone(record.evidence) as EvidenceReference[] }
        : {}),
    });
  }
  return facts;
}

/**
 * Collect evidence from returned facts and optional binding-level notes.
 */
export function collectChildReturnEvidence(facts: readonly FactInput[]): EvidenceReference[] {
  const evidence: EvidenceReference[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    for (const item of fact.evidence ?? []) {
      const key = `${item.kind ?? ""}:${item.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push(structuredClone(item));
    }
  }
  return evidence;
}

export interface PendingChildReturn {
  bindingId: string;
  parentGoalId: string;
  childGoalId: string;
  childWorkflowId: string;
  outcome: ChildReturnOutcomeKind;
  facts: FactInput[];
  evidence: EvidenceReference[];
  reason: string;
}

/**
 * Detect whether a child member state is ready for product return.
 * Requires a terminal child goal and an active binding.
 */
export function detectPendingChildReturn(input: {
  family: PersistedGoalFamily;
  childState: HypagraphState;
}): PendingChildReturn | undefined {
  const childGoal = input.childState.goal;
  if (!goalIsTerminal(childGoal)) return undefined;
  const outcome = childReturnOutcomeFromGoalStatus(childGoal?.status);
  if (!outcome) return undefined;

  const childGoalId = childGoal!.goalId;
  const bindings = activeBindingsForChildGoal(input.family.familySnapshot, childGoalId);
  if (bindings.length === 0) return undefined;
  // One active binding per child is the product model.
  const binding = bindings[0]!;
  const facts = collectChildReturnFacts(input.childState, binding);
  const evidence = collectChildReturnEvidence(facts);
  const reason = childGoal?.stopReason?.trim()
    || (outcome === "completed"
      ? "The child goal completed."
      : outcome === "budget_limited"
        ? "The child goal stopped because its budget was exhausted."
        : outcome === "cancelled"
          ? "The child goal was cancelled."
          : "The child goal failed.");

  return {
    bindingId: binding.bindingId,
    parentGoalId: binding.parentGoalId,
    childGoalId,
    childWorkflowId: input.childState.workflowId,
    outcome,
    facts,
    evidence,
    reason,
  };
}

/**
 * Notify text after a successful product child return.
 */
export function renderChildReturnApplied(input: {
  outcome: ChildReturnOutcomeKind;
  bindingId: string;
  childGoalId: string;
  parentNodeId: string;
  parentNodeStatus: string;
  parentEffect: string;
}): string {
  if (input.outcome === "completed") {
    return (
      `The child completed. Integrate returned facts on the parent task '${input.parentNodeId}'. `
      + `Parent status is '${input.parentNodeStatus}'. Child success does not complete the parent task.`
    );
  }
  return (
    `Child '${input.childGoalId}' returned with outcome '${input.outcome}' `
    + `(binding '${input.bindingId}', parent effect '${input.parentEffect}'). `
    + `Parent node '${input.parentNodeId}' is '${input.parentNodeStatus}'.`
  );
}
