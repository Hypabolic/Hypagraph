import type { CodeNodeDefinition, Diagnostic, HypagraphDefinition } from "../domain/model.js";
import { pinnedSandboxRuntimeIdentity } from "../domain/sandbox-runtime-identity.js";
import { sha256 } from "../domain/hash.js";
import { checkSandboxProgramTypeScript } from "./typescript-check.js";

/**
 * Type-check a code program and attach compiled output plus host-pinned runtime identity.
 * Call this in the tool and authoring layer. Do not call this from the reducer.
 * Always recompiles from `program`. Client-supplied compiled JS and runtime identity are ignored.
 */
export function prepareCodeNodeDefinition(
  definition: CodeNodeDefinition,
): { ok: true; definition: CodeNodeDefinition } | { ok: false; diagnostics: Diagnostic[] } {
  const checked = checkSandboxProgramTypeScript(definition.execution.program, definition.execution.inputs);
  if (!checked.ok) return checked;
  const runtimeIdentity = pinnedSandboxRuntimeIdentity(definition.execution.inputs);
  const compiledHash = sha256(checked.compiledJavaScript);
  return {
    ok: true,
    definition: {
      kind: "code",
      execution: {
        version: 1,
        program: definition.execution.program,
        compiledJavaScript: checked.compiledJavaScript,
        compiledHash,
        inputs: [...definition.execution.inputs],
        capabilities: structuredClone(definition.execution.capabilities),
        timeoutMs: definition.execution.timeoutMs,
        maxMemoryBytes: definition.execution.maxMemoryBytes,
        maxBridgeCalls: definition.execution.maxBridgeCalls,
        maxResultBytes: definition.execution.maxResultBytes,
        runtimeIdentity,
      },
      ...(definition.retry === undefined ? {} : { retry: structuredClone(definition.retry) }),
    },
  };
}

/**
 * Prepare every code node in a definition.
 * Fail if any program fails the TypeScript check.
 */
export function prepareDefinitionCodeNodes(
  definition: HypagraphDefinition,
): { ok: true; definition: HypagraphDefinition } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const nodes = definition.nodes.map((node) => {
    if ((node.kind ?? "task") !== "code" || !node.code) return node;
    const prepared = prepareCodeNodeDefinition(node.code);
    if (!prepared.ok) {
      diagnostics.push(...prepared.diagnostics.map((item) => ({
        ...item,
        location: item.location?.startsWith("nodes.")
          ? item.location
          : `nodes.${node.id}.${item.location ?? "code.execution.program"}`,
      })));
      return node;
    }
    return { ...node, code: prepared.definition };
  });
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, definition: { ...definition, nodes } };
}

/**
 * Resolve JavaScript to execute.
 * Prefer verified stored compiled output so execution does not need the TypeScript compiler.
 * Recompile only when stored output is absent.
 * Reject stored bytes whose hash does not match `compiledHash`.
 */
export function resolveExecutableJavaScript(
  definition: CodeNodeDefinition,
): { ok: true; compiledJavaScript: string } | { ok: false; diagnostics: Diagnostic[] } {
  const stored = definition.execution.compiledJavaScript;
  const storedHash = definition.execution.compiledHash;
  if (stored !== undefined && storedHash !== undefined) {
    if (storedHash !== sha256(stored)) {
      return {
        ok: false,
        diagnostics: [{
          code: "code_compiled_hash_mismatch",
          message: "The stored compiledJavaScript does not match compiledHash.",
          location: "code.execution.compiledHash",
        }],
      };
    }
    return { ok: true, compiledJavaScript: stored };
  }
  const checked = checkSandboxProgramTypeScript(definition.execution.program, definition.execution.inputs);
  if (!checked.ok) return checked;
  return { ok: true, compiledJavaScript: checked.compiledJavaScript };
}
