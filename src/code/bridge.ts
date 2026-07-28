import type {
  CodeBridgeCallAudit,
  CodeCapability,
  CodeNodeDefinition,
} from "../domain/model.js";
import type { FactValue } from "../domain/facts.js";
import { sha256 } from "../domain/hash.js";
import { codeCapabilityIsPermittedForCodeNode } from "../domain/code-authoring.js";
import { pathMatchesAllowlist } from "./paths.js";

export interface BridgeCallRequest {
  action: string;
  args?: unknown;
}

export type BridgeHandler = (args: unknown) => unknown | Promise<unknown>;

export interface CodeBridgeOptions {
  definition: CodeNodeDefinition;
  handlers?: Record<string, BridgeHandler>;
  maxBridgeCalls: number;
  /**
   * Optional capability permit. Defaults to the code-node permit.
   * Effect and reconcile programs supply a role-specific permit.
   */
  capabilityPermit?: (capability: CodeCapability) => boolean;
}

export class CodeHostBridge {
  private readonly allowlist: readonly CodeCapability[];
  private readonly handlers: Record<string, BridgeHandler>;
  private readonly maxBridgeCalls: number;
  private readonly capabilityPermit: (capability: CodeCapability) => boolean;
  private callCount = 0;
  readonly audit: CodeBridgeCallAudit[] = [];

  constructor(options: CodeBridgeOptions) {
    this.allowlist = options.definition.execution.capabilities;
    this.handlers = options.handlers ?? {};
    this.maxBridgeCalls = options.maxBridgeCalls;
    this.capabilityPermit = options.capabilityPermit ?? codeCapabilityIsPermittedForCodeNode;
  }

  /**
   * Synchronous bridge call for the QuickJS host surface.
   * Reject handlers that return a Promise.
   */
  callSync(action: string, args?: unknown): unknown {
    this.prepareCall(action, args);
    const handler = this.handlers[action];
    if (!handler) {
      return this.fail(action, args, "error", `Capability '${action}' is allowed but has no host handler.`);
    }
    try {
      const result = handler(args);
      if (result && typeof (result as Promise<unknown>).then === "function") {
        return this.fail(action, args, "error", `Bridge action '${action}' must complete synchronously in the sandbox.`);
      }
      this.audit.push({
        action,
        argsHash: sha256(args ?? null),
        resultHash: sha256(result ?? null),
        status: "ok",
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.push({
        action,
        argsHash: sha256(args ?? null),
        status: "error",
        error: message,
      });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  async call(action: string, args?: unknown): Promise<unknown> {
    this.prepareCall(action, args);
    const handler = this.handlers[action];
    if (!handler) {
      return this.fail(action, args, "error", `Capability '${action}' is allowed but has no host handler.`);
    }
    try {
      const result = await handler(args);
      this.audit.push({
        action,
        argsHash: sha256(args ?? null),
        resultHash: sha256(result ?? null),
        status: "ok",
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.push({
        action,
        argsHash: sha256(args ?? null),
        status: "error",
        error: message,
      });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  private prepareCall(action: string, args: unknown): void {
    if (this.callCount >= this.maxBridgeCalls) {
      this.fail(action, args, "error", `The program exceeded its bridge-call limit of ${this.maxBridgeCalls}.`);
    }
    this.callCount += 1;
    const capability = this.findCapability(action, args);
    if (!capability) {
      this.fail(action, args, "denied", `Capability '${action}' is denied by the allowlist.`);
    }
    if (capability && !this.capabilityPermit(capability)) {
      this.fail(
        action,
        args,
        "denied",
        `Capability '${action}' effect class '${capability.effectClass}' is not permitted for this program.`,
      );
    }
  }

  private fail(
    action: string,
    args: unknown,
    status: "denied" | "error",
    error: string,
  ): never {
    this.audit.push({
      action,
      argsHash: sha256(args ?? null),
      status,
      error,
    });
    throw new Error(error);
  }

  private findCapability(action: string, args: unknown): CodeCapability | undefined {
    for (const capability of this.allowlist) {
      if (capability.kind === "pure") continue;
      if (capability.kind === "pi-tool" && action === `pi-tool.${capability.name}`) return capability;
      if (capability.kind === "mcp") {
        // Server names cannot contain '.'. Match mcp.<server>.<method> exactly.
        const prefix = `mcp.${capability.server}.`;
        if (!action.startsWith(prefix)) continue;
        const method = action.slice(prefix.length);
        if (method.length > 0 && !method.includes(".") && capability.methods.includes(method)) {
          return capability;
        }
      }
      if (capability.kind === "workspace-read" && action === "workspace.read") {
        const path = pathArg(args);
        if (path && pathMatchesAllowlist(path, capability.paths)) return capability;
      }
      if (capability.kind === "workspace-write" && action === "workspace.write") {
        const path = pathArg(args);
        if (path && pathMatchesAllowlist(path, capability.paths)) return capability;
      }
    }
    return undefined;
  }
}

const pathArg = (args: unknown): string | undefined => {
  if (!args || typeof args !== "object") return undefined;
  const path = (args as { path?: unknown }).path;
  return typeof path === "string" ? path : undefined;
};

/**
 * Build bindings from declared inputs. An undeclared key throws instead of returning undefined.
 */
export function createStrictBindings(
  declaredInputs: readonly string[],
  values: Record<string, FactValue>,
): Record<string, FactValue> {
  const bindings: Record<string, FactValue> = {};
  for (const name of declaredInputs) {
    if (!(name in values)) {
      throw new Error(`Binding '${name}' is declared but missing from available facts.`);
    }
    bindings[name] = values[name]!;
  }
  return new Proxy(bindings, {
    get(target, property) {
      if (typeof property !== "string") return Reflect.get(target, property);
      if (Object.prototype.hasOwnProperty.call(target, property)) return target[property];
      // Permit object protocol access used by JSON and host dumps.
      if (property in Object.prototype || property === "toJSON") {
        const value = Reflect.get(Object.prototype, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      throw new Error(`Binding '${property}' is not declared on this code node.`);
    },
    has(target, property) {
      return typeof property === "string" && Object.prototype.hasOwnProperty.call(target, property);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, property) {
      if (typeof property === "string" && Object.prototype.hasOwnProperty.call(target, property)) {
        return { configurable: true, enumerable: true, value: target[property] };
      }
      return undefined;
    },
  });
}
