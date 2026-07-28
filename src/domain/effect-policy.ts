import type {
  Diagnostic,
  EffectNodeDefinition,
  EffectObservation,
  NodeRuntime,
} from "./model.js";

export type EffectStartEligibility =
  | { ok: true }
  | { ok: false; diagnostic: Diagnostic };

const reject = (code: string, message: string, suggestion?: string): EffectStartEligibility => ({
  ok: false,
  diagnostic: { code, message, ...(suggestion ? { suggestion } : {}) },
});

/**
 * An effect may start only from ready.
 * Indeterminate effects must reconcile. They must not retry blindly.
 */
export function effectCanStartWithoutWaiting(
  runtime: NodeRuntime,
  _definition: EffectNodeDefinition,
): boolean {
  return runtime.status === "ready";
}

export function evaluateEffectStart(
  runtime: NodeRuntime,
  _definition: EffectNodeDefinition,
  attemptId: string,
): EffectStartEligibility {
  if (runtime.attempts[attemptId]) {
    return reject("attempt_id_reused", `Attempt ID '${attemptId}' was already used.`, "Use a new attempt ID.");
  }
  if (runtime.status !== "ready") {
    return reject(
      "effect_not_ready",
      `The effect node is not ready. It cannot start from '${runtime.status}'.`,
      "Reconcile an indeterminate effect before a new attempt.",
    );
  }
  return { ok: true };
}

/**
 * Find attempts that still need reconciliation.
 * Only durable indeterminate state is selected for reconcile.
 * Durable requested without a later observation is recovered on restore first
 * (see recoverInterruptedEffects). Do not treat live in-flight requested as reconcile work.
 */
export function indeterminateEffectAttempts(
  runtime: NodeRuntime,
): Array<{ attemptId: string; observation: EffectObservation }> {
  const results: Array<{ attemptId: string; observation: EffectObservation }> = [];
  for (const attempt of Object.values(runtime.attempts)) {
    const observation = attempt.effectObservation;
    if (!observation) continue;
    if (observation.durableState === "indeterminate") {
      results.push({ attemptId: attempt.attemptId, observation });
    }
  }
  return results.sort((left, right) => left.attemptId.localeCompare(right.attemptId));
}

/**
 * Find open effect attempts that stored requested and never observed an outcome.
 * Restore must convert these to indeterminate before new work or blind retry.
 */
export function requestedEffectAttempts(
  runtime: NodeRuntime,
): Array<{ attemptId: string; observation: EffectObservation }> {
  const results: Array<{ attemptId: string; observation: EffectObservation }> = [];
  for (const attempt of Object.values(runtime.attempts)) {
    const observation = attempt.effectObservation;
    if (!observation) continue;
    if (observation.durableState === "requested") {
      results.push({ attemptId: attempt.attemptId, observation });
    }
  }
  return results.sort((left, right) => left.attemptId.localeCompare(right.attemptId));
}

export function effectObservationBlocksDependants(
  observation: EffectObservation | undefined,
): boolean {
  return observation?.durableState === "indeterminate" || observation?.durableState === "requested";
}
