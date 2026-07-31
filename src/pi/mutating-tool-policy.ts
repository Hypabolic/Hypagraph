/**
 * Shared mutating-tool block policy for Hypagraph host gates.
 *
 * Authoring, post-create wait-for-Run, and active-worker orchestrator gates
 * must mean the same thing for repository mutation: no write, edit, or shell.
 */

/** Tools that mutate the repository or advance canonical work. */
export const HYPAGRAPH_WORK_MUTATING_TOOLS = [
  "write",
  "edit",
  "bash",
  "hypagoal_start",
  "hypagoal_create_child",
  "hypagraph_transition",
  "hypagraph_run_check",
  "hypagraph_cancel_check",
  "hypagraph_revise",
  "hypagoal_submit_revision",
] as const;

/**
 * During authoring the model must still call hypagoal_start to finish create.
 * Block repository mutation only.
 */
export const HYPAGRAPH_AUTHORING_BLOCKED_TOOLS = [
  "write",
  "edit",
  "bash",
] as const;

const workSet = new Set<string>(HYPAGRAPH_WORK_MUTATING_TOOLS);
const authoringSet = new Set<string>(HYPAGRAPH_AUTHORING_BLOCKED_TOOLS);

export function isHypagraphWorkMutatingTool(toolName: string): boolean {
  return workSet.has(toolName);
}

export function isHypagraphAuthoringBlockedTool(toolName: string): boolean {
  return authoringSet.has(toolName);
}

export const POST_CREATE_GATE_BLOCK_REASON =
  "The Hypagoal is waiting for the user to choose Run after create. "
  + "Do not start tasks, checks, revisions, or repository edits. "
  + "Answer questions with hypagraph_read. Work starts after Run from the "
  + "post-create review dock (or /hypagraph resume, which re-opens that dock "
  + "when no work has started yet).";

export const AUTHORING_GATE_BLOCK_REASON =
  "Hypagoal authoring is read-only. Do not modify the repository or run shell "
  + "commands. Inspect the repository, use construction tools, validate, then "
  + "call hypagoal_start.";

export function activeWorkerGateBlockReason(nodeId: string, attemptId: string): string {
  return (
    `An isolated model worker owns task '${nodeId}' (attempt '${attemptId}'). `
    + "The orchestrator session must not implement or mutate that work. "
    + "Use hypagraph_read for status. Cancel with /hypagraph executor cancel if needed."
  );
}

/**
 * Diagnostic when hypagoal_create_child is blocked because an isolated worker
 * owns the parent attempt (Option A: create-child parent must be current-session).
 */
export function createChildBlockedByIsolatedWorkerReason(
  nodeId: string,
  attemptId: string,
): string {
  return (
    `An isolated worker owns parent task '${nodeId}' (attempt '${attemptId}'). `
    + "Child create requires a current-session parent task. "
    + "Finish or cancel that worker, or author the parent with "
    + 'executorProfile.kind "current-session". '
    + "Workers never create child Hypagoals."
  );
}

/**
 * Diagnostic when current-session is refused on a non-root family member
 * (R4 fallback until member continuation delivery ships).
 */
export const NON_ROOT_CURRENT_SESSION_BAN_REASON =
  "Current-session is not supported on child member tasks until member "
  + "continuation delivery ships. Use isolated-pi (the default) for child "
  + "plan-owner tasks. The family desk coordinates the family.";
