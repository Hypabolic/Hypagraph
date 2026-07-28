import type {
  CodeCapability,
  HypagraphDefinition,
  SandboxProgramDefinition,
  SandboxRuntimeIdentity,
} from "./model.js";
import {
  createSandboxRuntimeIdentity as createIdentity,
} from "./sandbox-runtime-identity.js";

export {
  pinnedSandboxRuntimeIdentity,
  runtimeIdentityMatches,
  SANDBOX_QUICKJS_VERSION,
  SANDBOX_TYPESCRIPT_VERSION,
} from "./sandbox-runtime-identity.js";

export type CodeAuthoringAdvisorySeverity = "warning" | "recommendation";

export type CodeAuthoringAdvisoryCode =
  | "code_program_probably_multiple_nodes"
  | "code_program_many_facts"
  | "code_program_large";

export interface CodeAuthoringAdvisory {
  code: CodeAuthoringAdvisoryCode;
  severity: CodeAuthoringAdvisorySeverity;
  message: string;
  location: string;
}

/** A program above this size is probably more than one node. */
export const CODE_PROGRAM_SIZE_ADVISORY_BYTES = 2_048;
/** A program which produces more facts than this is probably more than one node. */
export const CODE_PROGRAM_FACT_ADVISORY_COUNT = 5;

const advisory = (
  code: CodeAuthoringAdvisoryCode,
  severity: CodeAuthoringAdvisorySeverity,
  message: string,
  location: string,
): CodeAuthoringAdvisory => ({ code, severity, message, location });

export function assessCodeAuthoring(definition: HypagraphDefinition): CodeAuthoringAdvisory[] {
  const advisories: CodeAuthoringAdvisory[] = [];
  for (const node of definition.nodes) {
    if ((node.kind ?? "task") !== "code" || !node.code) continue;
    const location = `nodes.${node.id}.code.execution`;
    const program = node.code.execution.program;
    const programBytes = Buffer.byteLength(program, "utf8");
    const factCount = node.produces?.length ?? 0;
    if (programBytes > CODE_PROGRAM_SIZE_ADVISORY_BYTES) {
      advisories.push(advisory(
        "code_program_large",
        "warning",
        `Code node '${node.id}' program is ${programBytes} bytes. Prefer graph structure over a large program.`,
        `${location}.program`,
      ));
    }
    if (factCount > CODE_PROGRAM_FACT_ADVISORY_COUNT) {
      advisories.push(advisory(
        "code_program_many_facts",
        "warning",
        `Code node '${node.id}' produces ${factCount} facts. A program with many unrelated facts is usually more than one node.`,
        `nodes.${node.id}.produces`,
      ));
    }
    if (programBytes > CODE_PROGRAM_SIZE_ADVISORY_BYTES || factCount > CODE_PROGRAM_FACT_ADVISORY_COUNT) {
      advisories.push(advisory(
        "code_program_probably_multiple_nodes",
        "recommendation",
        `Code node '${node.id}' is probably more than one node. Prefer gates, loops, and separate nodes for control flow.`,
        location,
      ));
    }
  }
  return advisories.sort((left, right) =>
    left.location.localeCompare(right.location) || left.code.localeCompare(right.code));
}

export function formatCodeAuthoringAdvisories(advisories: readonly CodeAuthoringAdvisory[]): string {
  if (advisories.length === 0) return "";
  return [
    "Code authoring advisories:",
    ...advisories.map((item) => `- ${item.severity} ${item.code} at ${item.location}: ${item.message}`),
  ].join("\n");
}

export function createSandboxRuntimeIdentity(
  overrides: Pick<Partial<SandboxRuntimeIdentity>, "ambientTypesFingerprint"> = {},
): SandboxRuntimeIdentity {
  return createIdentity(overrides);
}

export function codeNodeHasWorkspaceMutation(capabilities: readonly CodeCapability[]): boolean {
  return capabilities.some((capability) => capability.effectClass === "workspace-mutation");
}

export function codeCapabilityIsPermittedForCodeNode(capability: CodeCapability): boolean {
  return capability.effectClass === "pure"
    || capability.effectClass === "observation"
    || capability.effectClass === "workspace-mutation";
}

/**
 * Report whether the next capability allowlist is not wider than the previous one.
 * Shrinking paths or methods is allowed. Adding grants or escalating effect class is not.
 */
export function revisionDoesNotWidenCodeCapabilities(
  previous: SandboxProgramDefinition | undefined,
  next: SandboxProgramDefinition | undefined,
): boolean {
  if (!previous) return true;
  if (!next) return false;
  const previousGrants = new Set(capabilityGrants(previous.capabilities));
  for (const grant of capabilityGrants(next.capabilities)) {
    if (!previousGrants.has(grant)) return false;
  }
  return true;
}

/**
 * Expand a capability into discrete grants so a narrower path/method set is not treated as a widen.
 * Effect class is part of each grant string, so escalation is a missing grant.
 */
const capabilityGrants = (capabilities: readonly CodeCapability[]): string[] => {
  const grants: string[] = [];
  for (const capability of capabilities) {
    switch (capability.kind) {
      case "pure":
        grants.push(`pure:${capability.effectClass}`);
        break;
      case "pi-tool":
        grants.push(`pi-tool:${capability.name}:${capability.effectClass}`);
        break;
      case "mcp":
        for (const method of capability.methods) {
          grants.push(`mcp:${capability.server}:${method}:${capability.effectClass}`);
        }
        break;
      case "workspace-read":
        for (const path of capability.paths) {
          grants.push(`workspace-read:${path}:${capability.effectClass}`);
        }
        break;
      case "workspace-write":
        for (const path of capability.paths) {
          grants.push(`workspace-write:${path}:${capability.effectClass}`);
        }
        break;
    }
  }
  return grants;
};
