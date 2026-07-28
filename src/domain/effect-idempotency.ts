import { sha256 } from "./hash.js";

export interface EffectIdempotencyIdentity {
  workflowId: string;
  revision: number;
  nodeId: string;
  attemptId: string;
}

/**
 * Derive the effect idempotency key from canonical identity only.
 * The key must not depend on the clock or on a random value.
 * A repeated attempt after restart with the same identity produces the same key.
 */
export function effectIdempotencyKey(identity: EffectIdempotencyIdentity): string {
  return sha256({
    kind: "effect-idempotency",
    from: "canonical-identity",
    workflowId: identity.workflowId,
    revision: identity.revision,
    nodeId: identity.nodeId,
    attemptId: identity.attemptId,
  });
}
