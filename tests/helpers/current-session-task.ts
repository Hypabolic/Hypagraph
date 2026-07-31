/**
 * Explicit current-session opt-in for Pi extension tests that still exercise
 * same-session implement follow-ups.
 *
 * Product default after Wave 6 is isolated-pi. Tests that assert follow-up
 * prompts must set this profile on task nodes.
 */
export const CURRENT_SESSION_TASK_PROFILE = {
  profileId: "current-session-default",
  kind: "current-session" as const,
};

/** Spread into a task node definition for current-session follow-up tests. */
export const withCurrentSessionTaskProfile = <T extends Record<string, unknown>>(
  node: T,
): T & { executorProfile: typeof CURRENT_SESSION_TASK_PROFILE } => ({
  ...node,
  executorProfile: CURRENT_SESSION_TASK_PROFILE,
});
