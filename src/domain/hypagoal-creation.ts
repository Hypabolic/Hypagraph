import type { Diagnostic, HypagraphDefinition, ReducerResult } from "./model.js";
import { replayEvents } from "./projection.js";
import { createWorkflow, handleCommand } from "./reducer.js";

export interface HypagoalCreationIdentity {
  workflowId: string;
  goalId: string;
  goalWorkflowId: string;
  at: string;
}

const reject = (code: string, message: string, location?: string): ReducerResult => ({
  ok: false,
  diagnostics: [{ code, message, ...(location ? { location } : {}) }],
});

export function hypagoalCreationCorrelationId(workflowId: string): string {
  return `define:${workflowId}`;
}

export function createHypagoalWorkflow(
  definition: HypagraphDefinition,
  identity: HypagoalCreationIdentity,
): ReducerResult {
  if (identity.goalWorkflowId !== identity.workflowId) {
    return reject(
      "goal_workflow_mismatch",
      `Goal '${identity.goalId}' targets workflow '${identity.goalWorkflowId}', but the creation operation defines workflow '${identity.workflowId}'.`,
      "goalWorkflowId",
    );
  }

  const created = createWorkflow(definition, identity.at, identity.workflowId);
  if (!created.ok) return created;

  const correlationId = hypagoalCreationCorrelationId(identity.workflowId);
  const started = handleCommand(created.state, {
    type: "start-goal",
    goalId: identity.goalId,
    commandId: `start-goal:${identity.goalId}`,
    correlationId,
    at: identity.at,
  });
  if (!started.ok) return started;

  const events = [...created.events, ...started.events];
  const replayed = replayEvents(events);
  const diagnostics: Diagnostic[] = [];
  if (replayed.snapshotHash !== started.state.snapshotHash) {
    diagnostics.push({
      code: "hypagoal_creation_projection_mismatch",
      message: "The atomic Hypagoal creation projection does not match its event stream.",
    });
  }
  if (replayed.definition.goal !== definition.goal) {
    diagnostics.push({
      code: "hypagoal_objective_mismatch",
      message: "The atomic Hypagoal creation projection did not preserve the workflow objective.",
      location: "goal",
    });
  }
  if (!replayed.goal || replayed.goal.goalId !== identity.goalId || replayed.goal.workflowId !== identity.workflowId) {
    diagnostics.push({
      code: "hypagoal_identity_mismatch",
      message: "The atomic Hypagoal creation projection does not contain the requested goal and workflow identity.",
    });
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return { ok: true, state: replayed, events };
}
