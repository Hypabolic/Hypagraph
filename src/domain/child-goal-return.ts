import {
  validateChildReturnFacts,
  validateEvidenceReferences,
} from "./child-goal-binding.js";
import {
  GOAL_FAMILY_EVENT_VERSION,
  GOAL_FAMILY_SCHEMA_VERSION,
  applyFamilyEvent,
  childBindingStatusForOutcome,
  durableParentEffect,
  parentEffectForFailurePolicy,
  requireGoalFamilyNonEmpty,
  requireGoalFamilyTimestamp,
  type ChildGoalBinding,
  type ChildGoalFailurePolicy,
  type ChildReturnCommandParentEffect,
  type ChildReturnOutcomeKind,
  type ChildReturnParentEffect,
  type ChildReturnPublishedFact,
  type ChildReturnRecord,
  type GoalFamilyEvent,
  type GoalFamilyRuntime,
} from "./goal-family.js";
import type {
  Diagnostic,
  DomainEvent,
  EvidenceReference,
  FactInput,
  HypagraphState,
} from "./model.js";
import { handleCommand } from "./reducer.js";

export type { ChildReturnCommandParentEffect };
export {
  durableParentEffect,
  parentEffectForFailurePolicy,
  validateChildReturnFacts,
  validateEvidenceReferences,
};

export type ChildReturnParentCommandEffect = ChildReturnCommandParentEffect;

export interface ReturnChildGoalInput {
  family: GoalFamilyRuntime;
  /** Parent workflow state that owns the waiting task. */
  parentState: HypagraphState;
  bindingId: string;
  at: string;
  /**
   * Terminal child outcome.
   * Budget exhaustion and cancellation are not success.
   */
  outcome: ChildReturnOutcomeKind;
  /** Facts declared by the binding output contracts. Required facts must be present for completed outcome. */
  facts?: FactInput[];
  /** Optional evidence returned with the child outcome. */
  evidence?: EvidenceReference[];
  /** Human-readable stop or failure reason. Pure input. */
  reason?: string;
  correlationId?: string;
  causationId?: string;
  familyEventId?: string;
  parentCommandId?: string;
}

export type ReturnChildGoalResult =
  | {
    ok: true;
    family: GoalFamilyRuntime;
    familyEvents: GoalFamilyEvent[];
    parentState: HypagraphState;
    parentEvents: DomainEvent[];
    binding: ChildGoalBinding;
    returnRecord: ChildReturnRecord;
  }
  | { ok: false; diagnostics: Diagnostic[] };

const reject = (code: string, message: string, location?: string): ReturnChildGoalResult => ({
  ok: false,
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

/**
 * Record a child terminal result against its parent binding as one family-level atomic operation.
 *
 * On success the result includes:
 * - family binding terminal status and return record;
 * - parent workflow leave-wait and parent-effect events;
 * - validated published facts when the child completed.
 *
 * On failure the result includes diagnostics only.
 * Inputs are not mutated. Partial parent or family state is not returned.
 * Timestamps and IDs are pure inputs. This helper does not read the clock.
 */
export function returnChildGoal(input: ReturnChildGoalInput): ReturnChildGoalResult {
  if (input.family.schemaVersion !== GOAL_FAMILY_SCHEMA_VERSION) {
    return reject(
      "unsupported_goal_family_schema",
      `Unsupported goal-family schema version '${String(input.family.schemaVersion)}'. `
      + `Expected schema version ${GOAL_FAMILY_SCHEMA_VERSION}.`,
      "family.schemaVersion",
    );
  }

  const bindingIdError = requireGoalFamilyNonEmpty(input.bindingId, "binding ID");
  if (bindingIdError) return reject("invalid_child_binding_id", bindingIdError, "bindingId");

  const atError = requireGoalFamilyTimestamp(input.at);
  if (atError) return reject("invalid_goal_family_timestamp", atError, "at");

  const allowedOutcomes = new Set<ChildReturnOutcomeKind>([
    "completed",
    "failed",
    "cancelled",
    "budget_limited",
  ]);
  if (!allowedOutcomes.has(input.outcome)) {
    return reject(
      "invalid_child_return_outcome",
      `Unsupported child return outcome '${String(input.outcome)}'.`,
      "outcome",
    );
  }

  const binding = input.family.bindings[input.bindingId];
  if (!binding) {
    return reject(
      "goal_family_binding_missing",
      `Goal family '${input.family.familyId}' has no binding '${input.bindingId}'.`,
      "bindingId",
    );
  }
  if (binding.status !== "active") {
    return reject(
      "stale_child_return",
      `Binding '${input.bindingId}' is already '${binding.status}'. `
      + "A terminal binding cannot accept another return.",
      "bindingId",
    );
  }

  const parentGoalId = input.parentState.goal?.goalId;
  if (!parentGoalId) {
    return reject(
      "child_goal_parent_goal_missing",
      `Parent workflow '${input.parentState.workflowId}' has no goal runtime.`,
      "parentState.goal",
    );
  }
  if (parentGoalId !== binding.parentGoalId) {
    return reject(
      "stale_child_return",
      `Parent goal '${parentGoalId}' does not match binding parent '${binding.parentGoalId}'.`,
      "parentState.goal.goalId",
    );
  }
  if (input.parentState.workflowId !== binding.parentWorkflowId) {
    return reject(
      "stale_child_return",
      `Parent workflow '${input.parentState.workflowId}' does not match binding parent workflow `
      + `'${binding.parentWorkflowId}'.`,
      "parentState.workflowId",
    );
  }

  const parentMember = input.family.members[parentGoalId];
  if (!parentMember) {
    return reject(
      "goal_family_parent_missing",
      `Goal family '${input.family.familyId}' does not contain parent goal '${parentGoalId}'.`,
      "parentState.goal.goalId",
    );
  }
  if (parentMember.workflowId !== input.parentState.workflowId) {
    return reject(
      "goal_family_parent_workflow_mismatch",
      `Parent goal '${parentGoalId}' belongs to workflow '${parentMember.workflowId}', `
      + `not '${input.parentState.workflowId}'.`,
      "parentState.workflowId",
    );
  }

  if (!input.family.members[binding.childGoalId]) {
    return reject(
      "goal_family_binding_child_missing",
      `Binding '${binding.bindingId}' references missing child member '${binding.childGoalId}'.`,
      "bindingId",
    );
  }

  const parentNode = input.parentState.runtime.nodes[binding.parentNodeId];
  if (!parentNode) {
    return reject(
      "unknown_parent_node",
      `Parent workflow '${input.parentState.workflowId}' has no runtime for node `
      + `'${binding.parentNodeId}'.`,
      "binding.parentNodeId",
    );
  }
  if (parentNode.status !== "waiting_for_child") {
    return reject(
      "child_return_parent_not_waiting",
      `Parent task '${binding.parentNodeId}' is '${parentNode.status}'. `
      + "A child return requires waiting_for_child status.",
      "binding.parentNodeId",
    );
  }
  if (!parentNode.currentAttemptId || parentNode.currentAttemptId !== binding.parentAttemptId) {
    return reject(
      "stale_child_return",
      `Parent attempt '${parentNode.currentAttemptId ?? "none"}' does not match binding attempt `
      + `'${binding.parentAttemptId}'.`,
      "binding.parentAttemptId",
    );
  }

  const effectiveOutcome: ChildReturnOutcomeKind = input.outcome;

  let parentCommandEffect: ChildReturnCommandParentEffect;
  if (effectiveOutcome === "completed") {
    parentCommandEffect = "resume";
  } else {
    parentCommandEffect = parentEffectForFailurePolicy(binding.failurePolicy);
  }

  // Reject return-for-revision when automatic revision allowance is exhausted.
  // The durable effect must not claim revision-requested without emitting revision events.
  if (parentCommandEffect === "return-for-revision") {
    const goal = input.parentState.goal;
    const revision = goal?.automaticRevision;
    if (!goal || !revision || revision.consumedAttempts >= revision.maximumAttempts) {
      return reject(
        "child_return_revision_exhausted",
        `Child return cannot apply failure policy 'return-for-revision' because the parent goal `
        + "automatic revision allowance is exhausted.",
        "parentState.goal.automaticRevision",
      );
    }
  }

  const factsValidated = validateChildReturnFacts(
    binding.outputFacts,
    input.facts,
    { requireRequired: effectiveOutcome === "completed" },
  );
  if (!factsValidated.ok) return { ok: false, diagnostics: factsValidated.diagnostics };

  const evidenceValidated = validateEvidenceReferences(input.evidence, "evidence");
  if (!evidenceValidated.ok) return { ok: false, diagnostics: evidenceValidated.diagnostics };

  const stopReason = input.reason?.trim()
    || (effectiveOutcome === "completed"
      ? "The child goal returned successfully."
      : effectiveOutcome === "budget_limited"
        ? "The child goal stopped because its budget was exhausted."
        : effectiveOutcome === "cancelled"
          ? "The child goal was cancelled."
          : "The child goal failed.");

  const durableEffect = durableParentEffect(parentCommandEffect);
  const returnRecord: ChildReturnRecord = {
    outcome: effectiveOutcome,
    parentEffect: durableEffect,
    returnedAt: input.at,
    stopReason,
    ...(factsValidated.published.length > 0
      ? { publishedFacts: structuredClone(factsValidated.published) as ChildReturnPublishedFact[] }
      : {}),
    ...(evidenceValidated.evidence.length > 0
      ? { evidence: structuredClone(evidenceValidated.evidence) }
      : {}),
  };

  const correlationId = input.correlationId
    ?? `family-child-return:${input.family.familyId}:${binding.bindingId}`;
  const causationId = input.causationId ?? correlationId;

  // Apply parent effects first so definition/wait failures produce diagnostics with no family commit.
  const parentReturn = handleCommand(input.parentState, {
    type: "record-child-return",
    nodeId: binding.parentNodeId,
    attemptId: binding.parentAttemptId,
    childGoalId: binding.childGoalId,
    bindingId: binding.bindingId,
    outcome: effectiveOutcome,
    parentEffect: parentCommandEffect,
    commandId: input.parentCommandId
      ?? `record-child-return:${binding.parentNodeId}:${binding.bindingId}`,
    correlationId,
    at: input.at,
    reason: stopReason,
    ...(effectiveOutcome === "completed" && input.facts
      ? { facts: structuredClone(input.facts) }
      : {}),
    ...(evidenceValidated.evidence.length > 0
      ? { evidence: structuredClone(evidenceValidated.evidence) }
      : {}),
  });
  if (!parentReturn.ok) return { ok: false, diagnostics: parentReturn.diagnostics };

  // Child completion must not complete the parent task or parent goal automatically.
  if (effectiveOutcome === "completed") {
    const parentNodeAfter = parentReturn.state.runtime.nodes[binding.parentNodeId];
    if (parentNodeAfter?.status === "succeeded") {
      return reject(
        "child_return_parent_completed",
        "Child completion must not complete the parent task automatically.",
        "parentState",
      );
    }
    if (parentReturn.state.goal?.status === "completed" || parentReturn.state.phase === "completed") {
      return reject(
        "child_return_parent_completed",
        "Child completion must not complete the parent goal or workflow automatically.",
        "parentState",
      );
    }
  }

  const familySequence = input.family.schedulerOrdinal + 1;
  const familyEvent: GoalFamilyEvent = {
    eventId: input.familyEventId
      ?? `family-child-return:${input.family.familyId}:${binding.bindingId}`,
    familyId: input.family.familyId,
    sequence: familySequence,
    type: "hypagraph.family.child-return-recorded",
    version: GOAL_FAMILY_EVENT_VERSION,
    timestamp: input.at,
    causationId,
    correlationId,
    data: {
      bindingId: binding.bindingId,
      childGoalId: binding.childGoalId,
      parentGoalId: binding.parentGoalId,
      parentWorkflowId: binding.parentWorkflowId,
      parentNodeId: binding.parentNodeId,
      parentAttemptId: binding.parentAttemptId,
      outcome: effectiveOutcome,
      parentEffect: durableEffect,
      returnRecord: structuredClone(returnRecord),
    },
  };

  let nextFamily: GoalFamilyRuntime;
  try {
    nextFamily = applyFamilyEvent(input.family, familyEvent);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "goal_family_child_return_failed";
    return reject(code, message);
  }

  const nextBinding = nextFamily.bindings[binding.bindingId];
  if (!nextBinding || nextBinding.status !== childBindingStatusForOutcome(effectiveOutcome)) {
    return reject(
      "goal_family_child_return_failed",
      `Family binding '${binding.bindingId}' did not reach the expected terminal status.`,
    );
  }

  return {
    ok: true,
    family: nextFamily,
    familyEvents: [familyEvent],
    parentState: parentReturn.state,
    parentEvents: parentReturn.events,
    binding: structuredClone(nextBinding),
    returnRecord: structuredClone(returnRecord),
  };
}

// Re-export policy type for callers that type against failure policies.
export type { ChildGoalFailurePolicy, ChildReturnParentEffect };
