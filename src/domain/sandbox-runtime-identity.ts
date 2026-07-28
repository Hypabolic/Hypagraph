import { sha256, stableStringify } from "./hash.js";
import type { SandboxRuntimeIdentity } from "./model.js";

/** QuickJS package version used by the Hypagraph sandbox executor. */
export const SANDBOX_QUICKJS_VERSION = "0.32.0";

/**
 * TypeScript compiler version used by the sandbox type check.
 * Keep this equal to the `typescript` package version in package.json.
 * A test asserts the pin matches `ts.version` and the installed package.
 */
export const SANDBOX_TYPESCRIPT_VERSION = "5.8.3";

/** Fingerprint of the host bridge action schemas. */
export const SANDBOX_BRIDGE_SCHEMA_FINGERPRINT = sha256({
  version: 1,
  actions: {
    denyByDefault: true,
    registry: ["workspace.read", "workspace.write"],
  },
});

/**
 * Compiler options which the sandbox TypeScript check uses.
 * This object is the single source of truth. `src/code/typescript-check.ts`
 * derives `DEFAULT_SANDBOX_COMPILER_OPTIONS` from it.
 */
export const SANDBOX_COMPILER_OPTIONS_RECORD: Record<string, unknown> = {
  target: "ES2020",
  module: "ESNext",
  strict: true,
  lib: ["lib.es2020.d.ts"],
  skipLibCheck: true,
  removeComments: true,
};

/**
 * Build the host-pinned runtime identity.
 * Author-supplied identity fields are never accepted. Only the host may set
 * `ambientTypesFingerprint` after it hashes the declared inputs.
 *
 * The no-override default equals `pinnedSandboxRuntimeIdentity([])`, so a
 * hand-built definition with empty inputs is accepted by the executor.
 */
export function createSandboxRuntimeIdentity(
  overrides: Pick<Partial<SandboxRuntimeIdentity>, "ambientTypesFingerprint"> = {},
): SandboxRuntimeIdentity {
  const compilerOptions = { ...SANDBOX_COMPILER_OPTIONS_RECORD };
  return {
    typescriptVersion: SANDBOX_TYPESCRIPT_VERSION,
    compilerOptions,
    languageTarget: String(compilerOptions.target ?? "ES2020"),
    ambientTypesFingerprint: overrides.ambientTypesFingerprint
      ?? sha256({ ambient: "hypagraph-sandbox-bindings-v1", inputs: [] }),
    quickjsVersion: SANDBOX_QUICKJS_VERSION,
    bridgeSchemaFingerprint: SANDBOX_BRIDGE_SCHEMA_FINGERPRINT,
  };
}

/** Host-pinned identity for a code program with declared inputs. */
export function pinnedSandboxRuntimeIdentity(inputs: readonly string[] = []): SandboxRuntimeIdentity {
  return createSandboxRuntimeIdentity({
    ambientTypesFingerprint: sha256({
      ambient: "hypagraph-sandbox-bindings-v1",
      inputs: [...inputs],
    }),
  });
}

/** True when a recorded identity equals the live host pin. */
export function runtimeIdentityMatches(
  recorded: SandboxRuntimeIdentity,
  live: SandboxRuntimeIdentity,
): boolean {
  return stableStringify(recorded) === stableStringify(live);
}
