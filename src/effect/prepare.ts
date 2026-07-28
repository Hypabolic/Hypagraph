import type { EffectNodeDefinition, Diagnostic, HypagraphDefinition, SandboxProgramDefinition } from "../domain/model.js";
import { effectAmbientInputs, isEffectHostBindingName } from "../domain/effect-authoring.js";
import { pinnedSandboxRuntimeIdentity } from "../domain/sandbox-runtime-identity.js";
import { sha256 } from "../domain/hash.js";
import { checkSandboxProgramTypeScript } from "../code/typescript-check.js";

const prepareProgram = (
  program: SandboxProgramDefinition,
  location: string,
): { ok: true; program: SandboxProgramDefinition } | { ok: false; diagnostics: Diagnostic[] } => {
  // Reserved host bindings are ambient for type-check and identity pin only.
  // They are not fact contracts and are not stored as author inputs.
  const authorInputs = program.inputs.filter((name) => !isEffectHostBindingName(name));
  const ambientInputs = effectAmbientInputs(authorInputs);
  const checked = checkSandboxProgramTypeScript(program.program, ambientInputs);
  if (!checked.ok) {
    return {
      ok: false,
      diagnostics: checked.diagnostics.map((item) => ({
        ...item,
        location: item.location ?? location,
      })),
    };
  }
  const runtimeIdentity = pinnedSandboxRuntimeIdentity(ambientInputs);
  const compiledHash = sha256(checked.compiledJavaScript);
  return {
    ok: true,
    program: {
      version: 1,
      program: program.program,
      compiledJavaScript: checked.compiledJavaScript,
      compiledHash,
      inputs: [...authorInputs],
      capabilities: structuredClone(program.capabilities),
      timeoutMs: program.timeoutMs,
      maxMemoryBytes: program.maxMemoryBytes,
      maxBridgeCalls: program.maxBridgeCalls,
      maxResultBytes: program.maxResultBytes,
      runtimeIdentity,
    },
  };
};

/**
 * Type-check effect and reconcile programs and attach host-pinned runtime identity.
 * Call this in the tool and authoring layer. Do not call this from the reducer.
 */
export function prepareEffectNodeDefinition(
  definition: EffectNodeDefinition,
): { ok: true; definition: EffectNodeDefinition } | { ok: false; diagnostics: Diagnostic[] } {
  const effect = prepareProgram(definition.effect, "effect.effect.program");
  if (!effect.ok) return effect;
  const reconcile = prepareProgram(definition.reconcile, "effect.reconcile.program");
  if (!reconcile.ok) return reconcile;
  return {
    ok: true,
    definition: {
      kind: "effect",
      version: 1,
      effect: effect.program,
      reconcile: reconcile.program,
      idempotency: { from: "canonical-identity" },
      externalIdentity: structuredClone(definition.externalIdentity),
      onIndeterminate: definition.onIndeterminate,
    },
  };
}

/**
 * Prepare every effect node in a definition.
 * Fail if any program fails the TypeScript check.
 */
export function prepareDefinitionEffectNodes(
  definition: HypagraphDefinition,
): { ok: true; definition: HypagraphDefinition } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const nodes = definition.nodes.map((node) => {
    if ((node.kind ?? "task") !== "effect" || !node.effect) return node;
    const prepared = prepareEffectNodeDefinition(node.effect);
    if (!prepared.ok) {
      diagnostics.push(...prepared.diagnostics.map((item) => ({
        ...item,
        location: item.location?.startsWith("nodes.")
          ? item.location
          : `nodes.${node.id}.${item.location ?? "effect"}`,
      })));
      return node;
    }
    return { ...node, effect: prepared.definition };
  });
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, definition: { ...definition, nodes } };
}
