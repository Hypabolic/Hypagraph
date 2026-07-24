import { createHypagoalWorkflow } from "../domain/hypagoal-creation.js";
import type {
  Diagnostic,
  DomainEvent,
  GoalBudgetDefinition,
  GoalStatus,
  HypagraphDefinition,
  HypagraphState,
} from "../domain/model.js";
import {
  WorkflowBranchChangedError,
  WorkflowSequenceConflictError,
  type WorkflowEventStore,
} from "../persistence/event-store.js";
import {
  validateRestoredGoalState,
  validateRestoredLoopState,
} from "../persistence/session-rebuild.js";

export interface RootGenerationIdentity {
  sessionGeneration: number;
  branchGeneration: number;
}

export interface RootCanonicalIdentity extends RootGenerationIdentity {
  workflowId: string;
  goalId: string | null;
  objective: string;
  workflowRevision: number;
  eventSequence: number;
  snapshotHash: string;
  workflowPhase: HypagraphState["phase"];
  goalStatus: GoalStatus | null;
}

export interface RootReplacementConfirmation extends RootGenerationIdentity {
  workflowId: string;
  goalId: string | null;
  workflowRevision: number;
  eventSequence: number;
  snapshotHash: string;
}

export interface HypagoalAuthoringAdvisory {
  code: string;
  message: string;
}

export interface RootHypagoalStartRequest extends RootGenerationIdentity {
  objective: string;
  definition: HypagraphDefinition;
  workflowId: string;
  goalId: string;
  goalWorkflowId: string;
  at: string;
  advisories?: readonly HypagoalAuthoringAdvisory[];
  replacementConfirmation?: RootReplacementConfirmation;
  budget?: GoalBudgetDefinition;
}

export type RootHypagoalStartResult =
  | {
    kind: "created";
    state: HypagraphState;
    events: DomainEvent[];
    advisories: HypagoalAuthoringAdvisory[];
    replaced?: RootCanonicalIdentity;
  }
  | {
    kind: "replacement-required";
    current: RootCanonicalIdentity;
    confirmation: RootReplacementConfirmation;
  }
  | {
    kind: "rejected";
    diagnostics: Diagnostic[];
  };

const rejected = (code: string, message: string, location?: string): RootHypagoalStartResult => ({
  kind: "rejected",
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

export function rootCanonicalIdentity(
  state: HypagraphState,
  generations: RootGenerationIdentity,
): RootCanonicalIdentity {
  return {
    workflowId: state.workflowId,
    goalId: state.goal?.goalId ?? null,
    objective: state.definition.goal,
    workflowRevision: state.revision,
    eventSequence: state.sequence,
    snapshotHash: state.snapshotHash,
    sessionGeneration: generations.sessionGeneration,
    branchGeneration: generations.branchGeneration,
    workflowPhase: state.phase,
    goalStatus: state.goal?.status ?? null,
  };
}

export function replacementConfirmationFor(
  state: HypagraphState,
  generations: RootGenerationIdentity,
): RootReplacementConfirmation {
  const identity = rootCanonicalIdentity(state, generations);
  return {
    workflowId: identity.workflowId,
    goalId: identity.goalId,
    workflowRevision: identity.workflowRevision,
    eventSequence: identity.eventSequence,
    snapshotHash: identity.snapshotHash,
    sessionGeneration: identity.sessionGeneration,
    branchGeneration: identity.branchGeneration,
  };
}

const confirmationDiagnostic = (
  current: RootReplacementConfirmation,
  supplied: RootReplacementConfirmation,
): Diagnostic | undefined => {
  const fields: Array<keyof RootReplacementConfirmation> = [
    "workflowId",
    "goalId",
    "workflowRevision",
    "eventSequence",
    "snapshotHash",
    "sessionGeneration",
    "branchGeneration",
  ];
  const stale = fields.find((field) => current[field] !== supplied[field]);
  return stale
    ? {
      code: "stale_replacement_confirmation",
      message: `The replacement confirmation does not match the current root field '${stale}'. Read the current root and confirm replacement again.`,
      location: `replacementConfirmation.${stale}`,
    }
    : undefined;
};

const appendDiagnostic = (error: unknown): Diagnostic => {
  if (error instanceof WorkflowSequenceConflictError) {
    return { code: "event_store_sequence_conflict", message: error.message };
  }
  if (error instanceof WorkflowBranchChangedError) {
    return { code: "event_store_branch_changed", message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("snapshot")) return { code: "event_store_snapshot_mismatch", message };
  if (lower.includes("restore") || lower.includes("replay")) return { code: "event_store_restore_mismatch", message };
  return { code: "event_store_append_failed", message };
};

export async function startRootHypagoal(
  store: WorkflowEventStore,
  currentState: HypagraphState | undefined,
  request: RootHypagoalStartRequest,
): Promise<RootHypagoalStartResult> {
  if (!request.objective.trim()) {
    return rejected("hypagoal_objective_required", "A Hypagoal requires a non-empty objective.", "objective");
  }

  const generations: RootGenerationIdentity = {
    sessionGeneration: request.sessionGeneration,
    branchGeneration: request.branchGeneration,
  };
  const current = currentState ? rootCanonicalIdentity(currentState, generations) : undefined;

  if (currentState) {
    const required = replacementConfirmationFor(currentState, generations);
    if (!request.replacementConfirmation) {
      return {
        kind: "replacement-required",
        current: rootCanonicalIdentity(currentState, generations),
        confirmation: required,
      };
    }
    const stale = confirmationDiagnostic(required, request.replacementConfirmation);
    if (stale) return { kind: "rejected", diagnostics: [stale] };
  } else if (request.replacementConfirmation) {
    return rejected(
      "replacement_confirmation_without_root",
      "The replacement confirmation cannot be used because the Pi session has no current root.",
      "replacementConfirmation",
    );
  }

  const definition = structuredClone(request.definition);
  definition.goal = request.objective;
  const candidate = createHypagoalWorkflow(definition, {
    workflowId: request.workflowId,
    goalId: request.goalId,
    goalWorkflowId: request.goalWorkflowId,
    at: request.at,
    ...(request.budget ? { budget: structuredClone(request.budget) } : {}),
  });
  if (!candidate.ok) return { kind: "rejected", diagnostics: candidate.diagnostics };

  try {
    validateRestoredLoopState(candidate.state);
    validateRestoredGoalState(candidate.state);
  } catch (error) {
    return rejected(
      "hypagoal_restore_validation_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    await store.append({
      workflowId: candidate.state.workflowId,
      expectedSequence: 0,
      events: candidate.events,
      snapshot: candidate.state,
    });
  } catch (error) {
    return { kind: "rejected", diagnostics: [appendDiagnostic(error)] };
  }

  return {
    kind: "created",
    state: candidate.state,
    events: candidate.events,
    advisories: (request.advisories ?? []).map((advisory) => structuredClone(advisory)),
    ...(current ? { replaced: current } : {}),
  };
}
