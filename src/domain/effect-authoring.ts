import type {
  CapabilityEffectClass,
  CodeCapability,
  EffectNodeDefinition,
  SandboxProgramDefinition,
} from "./model.js";
import { revisionDoesNotWidenCodeCapabilities } from "./code-authoring.js";

export type EffectProgramRole = "effect" | "reconcile" | "code";

/** Host-injected binding names available to effect and reconcile sandbox programs. */
export const EFFECT_HOST_BINDING_IDEMPOTENCY_KEY = "effect.idempotency_key";
export const EFFECT_HOST_BINDING_PHASE = "effect.phase";

/** Reserved host binding names. Not fact contracts. Authors must not declare them as program inputs. */
export const EFFECT_HOST_BINDING_NAMES = [
  EFFECT_HOST_BINDING_IDEMPOTENCY_KEY,
  EFFECT_HOST_BINDING_PHASE,
] as const;

export function isEffectHostBindingName(name: string): boolean {
  return (EFFECT_HOST_BINDING_NAMES as readonly string[]).includes(name);
}

/**
 * Author fact inputs plus reserved host bindings, in a stable order for ambient types and identity pin.
 */
export function effectAmbientInputs(authorInputs: readonly string[]): string[] {
  const ambient = authorInputs.filter((name) => !isEffectHostBindingName(name));
  for (const name of EFFECT_HOST_BINDING_NAMES) {
    if (!ambient.includes(name)) ambient.push(name);
  }
  return ambient;
}

const permittedClasses: Record<EffectProgramRole, ReadonlySet<CapabilityEffectClass>> = {
  code: new Set(["pure", "observation", "workspace-mutation"]),
  effect: new Set(["pure", "observation", "workspace-mutation", "external-effect"]),
  reconcile: new Set(["observation"]),
};

export function capabilityIsPermittedForRole(
  capability: CodeCapability,
  role: EffectProgramRole,
): boolean {
  return permittedClasses[role].has(capability.effectClass);
}

export function effectCapabilityIsPermittedForEffectProgram(capability: CodeCapability): boolean {
  return capabilityIsPermittedForRole(capability, "effect");
}

export function effectCapabilityIsPermittedForReconcileProgram(capability: CodeCapability): boolean {
  return capabilityIsPermittedForRole(capability, "reconcile");
}

/**
 * Report whether the next effect definition does not widen external authority.
 * A revision cannot add effect capabilities, widen reconcile capabilities, or change onIndeterminate to a weaker policy.
 */
export function revisionDoesNotWidenEffectAuthority(
  previous: EffectNodeDefinition | undefined,
  next: EffectNodeDefinition | undefined,
): boolean {
  if (!previous) return true;
  if (!next) return false;
  if (!revisionDoesNotWidenCodeCapabilities(previous.effect, next.effect)) return false;
  if (!revisionDoesNotWidenCodeCapabilities(previous.reconcile, next.reconcile)) return false;
  if (previous.onIndeterminate === "fail-workflow" && next.onIndeterminate !== "fail-workflow") {
    return false;
  }
  // externalIdentity contracts must not shrink below previous required set (non-weakening).
  for (const contract of previous.externalIdentity) {
    if (!next.externalIdentity.some((item) => item.name === contract.name && item.type === contract.type)) {
      return false;
    }
  }
  return true;
}

export function sandboxProgramHasExternalEffect(program: SandboxProgramDefinition): boolean {
  return program.capabilities.some((capability) => capability.effectClass === "external-effect");
}

export function sandboxProgramHasMutation(program: SandboxProgramDefinition): boolean {
  return program.capabilities.some((capability) =>
    capability.effectClass === "workspace-mutation" || capability.effectClass === "external-effect");
}
