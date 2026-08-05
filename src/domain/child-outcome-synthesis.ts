/**
 * Pure child-outcome synthesis for parent fan-in (S6 / Gate 2.1).
 *
 * Joins a declared set of terminal child-goal binding outcomes into one
 * deterministic parent decision. Strategy v1 is all-success: the join passes
 * only when every member of the join set completed.
 *
 * Rules:
 * - Inputs are pure. No clock, files, network, or process access.
 * - Do not mutate input objects.
 * - Prefer caller-supplied timestamps and IDs for replay-stable tests.
 * - Every persisted synthesis record carries schemaVersion.
 * - Unsupported schema versions are rejected with a clear diagnostic.
 * - Binding id order in results is deterministic (locale-independent sort).
 *
 * Empty join set: the join passes under all-success (no live child failed).
 * Partial terminal set: result status is pending. Callers must wait.
 * Optional expectedBindingCount: the join stays pending until that many
 * bindings are present in the policy set and every member is terminal.
 */

import type { ChildReturnOutcomeKind, GoalFamilyRuntime } from "./goal-family.js";
import type { Diagnostic, DomainEvent, HypagraphState } from "./model.js";
import { handleCommand } from "./reducer.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema version for synthesis policy and result records. */
export const CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION = 1 as const;

/** Supported join strategies. v1 implements all-success only. */
export const CHILD_OUTCOME_SYNTHESIS_STRATEGIES = ["all-success"] as const;

export type ChildOutcomeSynthesisStrategy =
  (typeof CHILD_OUTCOME_SYNTHESIS_STRATEGIES)[number];

const STRATEGY_SET = new Set<string>(CHILD_OUTCOME_SYNTHESIS_STRATEGIES);

/** Default parent fact name published when a join evaluates to terminal. */
export const DEFAULT_JOIN_RESULT_FACT_NAME = "join.passed";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Declared join policy for one parent fan-in.
 * bindingIds is the join set. Order is not significant; evaluation sorts ids.
 */
export interface ChildOutcomeSynthesisPolicy {
  schemaVersion: typeof CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION;
  strategy: ChildOutcomeSynthesisStrategy;
  /** Binding ids that must be terminal before the join evaluates. */
  bindingIds: string[];
  /** Boolean fact published on the parent when the join is terminal. */
  resultFactName: string;
  /**
   * When set, the join stays pending until bindingIds.length reaches this count
   * and every member is terminal. Use this for sequential multi-child fan-out
   * so the first return does not complete the join early.
   * Must be a positive safe integer when present.
   */
  expectedBindingCount?: number;
}

/**
 * One member of a join set for pure evaluation.
 * When terminal is false, outcome is ignored.
 */
export interface ChildOutcomeMember {
  bindingId: string;
  terminal: boolean;
  outcome?: ChildReturnOutcomeKind;
}

/**
 * Deterministic join evaluation result.
 * publishedFact is set only when status is passed or failed.
 */
export interface ChildOutcomeSynthesisResult {
  schemaVersion: typeof CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION;
  strategy: ChildOutcomeSynthesisStrategy;
  status: "pending" | "passed" | "failed";
  /** True only when status is passed. */
  passed: boolean;
  completedCount: number;
  terminalCount: number;
  totalCount: number;
  pendingBindingIds: string[];
  completedBindingIds: string[];
  failedBindingIds: string[];
  reason: string;
  publishedFact?: {
    name: string;
    type: "boolean";
    value: boolean;
  };
}

/**
 * Schema-versioned synthesis application record returned to callers.
 * This record is not a durable workflow event. Durability comes from
 * publish-facts and block-node events when those commands run.
 */
export interface ChildOutcomeSynthesisRecord {
  schemaVersion: typeof CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION;
  strategy: ChildOutcomeSynthesisStrategy;
  status: "passed" | "failed";
  passed: boolean;
  bindingIds: string[];
  resultFactName: string;
  completedCount: number;
  totalCount: number;
  evaluatedAt: string;
  reason: string;
}

export type ChildOutcomeSynthesisPolicyResult =
  | { ok: true; policy: ChildOutcomeSynthesisPolicy }
  | { ok: false; diagnostics: Diagnostic[] };

export type ChildOutcomeSynthesisEvaluateResult =
  | { ok: true; result: ChildOutcomeSynthesisResult }
  | { ok: false; diagnostics: Diagnostic[] };

export type ChildOutcomeSynthesisApplyResult =
  | {
    ok: true;
    parentState: HypagraphState;
    parentEvents: DomainEvent[];
    result: ChildOutcomeSynthesisResult;
    record: ChildOutcomeSynthesisRecord;
    /** True when a publish-facts event was emitted for the join fact. */
    factPublished: boolean;
    /** True when parent state changed (fact publish and/or block). */
    parentMutated: boolean;
  }
  | { ok: false; diagnostics: Diagnostic[] };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Accept Object.prototype and null-prototype objects only.
 * Reject arrays, Date, Map, Set, RegExp, and other class instances.
 */
const isStrictPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Locale-independent ascending sort for binding ids.
 * Uses code-unit order so replay does not depend on host locale.
 */
export function compareBindingId(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

const reject = (code: string, message: string, location?: string): Diagnostic => ({
  code,
  message,
  ...(location !== undefined ? { location } : {}),
});

function formatUntrustedDiagnosticValue(value: unknown): string {
  if (value === null) return "null";
  const valueType = typeof value;
  if (
    valueType === "string"
    || valueType === "number"
    || valueType === "boolean"
    || valueType === "bigint"
    || valueType === "symbol"
    || valueType === "undefined"
  ) {
    return String(value);
  }
  return "[object]";
}

// ---------------------------------------------------------------------------
// Policy validation and parse
// ---------------------------------------------------------------------------

/**
 * Validate a child-outcome synthesis policy.
 * Rejects unsupported schema versions and invalid strategy or binding lists.
 */
export function validateChildOutcomeSynthesisPolicy(
  policy: unknown,
): ChildOutcomeSynthesisPolicyResult {
  if (!isStrictPlainObject(policy)) {
    return {
      ok: false,
      diagnostics: [reject(
        "child_outcome_synthesis_invalid_policy",
        "Child outcome synthesis policy must be a plain object.",
        "policy",
      )],
    };
  }

  if (policy.schemaVersion !== CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION) {
    return {
      ok: false,
      diagnostics: [reject(
        "unsupported_child_outcome_synthesis_schema",
        `Unsupported child-outcome synthesis schema version `
        + `'${formatUntrustedDiagnosticValue(policy.schemaVersion)}'. `
        + `Expected schema version ${CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION}.`,
        "policy.schemaVersion",
      )],
    };
  }

  if (typeof policy.strategy !== "string" || !STRATEGY_SET.has(policy.strategy)) {
    return {
      ok: false,
      diagnostics: [reject(
        "child_outcome_synthesis_invalid_strategy",
        `Unsupported synthesis strategy `
        + `'${formatUntrustedDiagnosticValue(policy.strategy)}'. `
        + `Supported strategies: ${CHILD_OUTCOME_SYNTHESIS_STRATEGIES.join(", ")}.`,
        "policy.strategy",
      )],
    };
  }

  if (!Array.isArray(policy.bindingIds)) {
    return {
      ok: false,
      diagnostics: [reject(
        "child_outcome_synthesis_invalid_binding_ids",
        "Policy bindingIds must be an array of non-empty strings.",
        "policy.bindingIds",
      )],
    };
  }

  const bindingIds: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < policy.bindingIds.length; index += 1) {
    const item = policy.bindingIds[index];
    if (!isNonEmptyString(item)) {
      return {
        ok: false,
        diagnostics: [reject(
          "child_outcome_synthesis_invalid_binding_id",
          `Policy bindingIds[${index}] must be a non-empty string.`,
          `policy.bindingIds[${index}]`,
        )],
      };
    }
    const trimmed = item.trim();
    if (seen.has(trimmed)) {
      return {
        ok: false,
        diagnostics: [reject(
          "child_outcome_synthesis_duplicate_binding_id",
          `Policy bindingIds contains duplicate id '${trimmed}'.`,
          `policy.bindingIds[${index}]`,
        )],
      };
    }
    seen.add(trimmed);
    bindingIds.push(trimmed);
  }

  let resultFactName = DEFAULT_JOIN_RESULT_FACT_NAME;
  if (policy.resultFactName !== undefined) {
    if (!isNonEmptyString(policy.resultFactName)) {
      return {
        ok: false,
        diagnostics: [reject(
          "child_outcome_synthesis_invalid_result_fact_name",
          "Policy resultFactName must be a non-empty string when provided.",
          "policy.resultFactName",
        )],
      };
    }
    resultFactName = policy.resultFactName.trim();
  }

  let expectedBindingCount: number | undefined;
  if (policy.expectedBindingCount !== undefined) {
    if (
      typeof policy.expectedBindingCount !== "number"
      || !Number.isSafeInteger(policy.expectedBindingCount)
      || policy.expectedBindingCount < 1
    ) {
      return {
        ok: false,
        diagnostics: [reject(
          "child_outcome_synthesis_invalid_expected_binding_count",
          "Policy expectedBindingCount must be a positive safe integer when provided.",
          "policy.expectedBindingCount",
        )],
      };
    }
    expectedBindingCount = policy.expectedBindingCount;
  }

  return {
    ok: true,
    policy: {
      schemaVersion: CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION,
      strategy: policy.strategy as ChildOutcomeSynthesisStrategy,
      bindingIds,
      resultFactName,
      ...(expectedBindingCount !== undefined ? { expectedBindingCount } : {}),
    },
  };
}

/**
 * Parse an untrusted value into a validated synthesis policy.
 */
export function parseChildOutcomeSynthesisPolicy(
  value: unknown,
): ChildOutcomeSynthesisPolicyResult {
  return validateChildOutcomeSynthesisPolicy(value);
}

/**
 * Build a validated all-success policy from binding ids.
 */
export function createAllSuccessJoinPolicy(input: {
  bindingIds: readonly string[];
  resultFactName?: string;
  expectedBindingCount?: number;
}): ChildOutcomeSynthesisPolicyResult {
  return validateChildOutcomeSynthesisPolicy({
    schemaVersion: CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION,
    strategy: "all-success",
    bindingIds: [...input.bindingIds],
    ...(input.resultFactName !== undefined
      ? { resultFactName: input.resultFactName }
      : {}),
    ...(input.expectedBindingCount !== undefined
      ? { expectedBindingCount: input.expectedBindingCount }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Pure evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate all-success join over pure member outcomes.
 * Does not read the family or parent workflow. Does not mutate inputs.
 */
export function evaluateChildOutcomeSynthesis(
  policyInput: unknown,
  membersInput: readonly ChildOutcomeMember[],
): ChildOutcomeSynthesisEvaluateResult {
  const policyResult = validateChildOutcomeSynthesisPolicy(policyInput);
  if (!policyResult.ok) return policyResult;
  const policy = policyResult.policy;

  if (!Array.isArray(membersInput)) {
    return {
      ok: false,
      diagnostics: [reject(
        "child_outcome_synthesis_invalid_members",
        "Synthesis members must be an array.",
        "members",
      )],
    };
  }

  const memberById = new Map<string, ChildOutcomeMember>();
  for (let index = 0; index < membersInput.length; index += 1) {
    const member = membersInput[index];
    if (!isStrictPlainObject(member)) {
      return {
        ok: false,
        diagnostics: [reject(
          "child_outcome_synthesis_invalid_member",
          `Synthesis members[${index}] must be a plain object.`,
          `members[${index}]`,
        )],
      };
    }
    const raw = member as unknown as ChildOutcomeMember;
    if (!isNonEmptyString(raw.bindingId)) {
      return {
        ok: false,
        diagnostics: [reject(
          "child_outcome_synthesis_invalid_member_binding_id",
          `Synthesis members[${index}].bindingId must be a non-empty string.`,
          `members[${index}].bindingId`,
        )],
      };
    }
    const bindingId = raw.bindingId.trim();
    if (typeof raw.terminal !== "boolean") {
      return {
        ok: false,
        diagnostics: [reject(
          "child_outcome_synthesis_invalid_member_terminal",
          `Synthesis members[${index}].terminal must be a boolean.`,
          `members[${index}].terminal`,
        )],
      };
    }
    if (raw.terminal) {
      const allowed = new Set(["completed", "failed", "cancelled", "budget_limited"]);
      if (raw.outcome === undefined || !allowed.has(raw.outcome)) {
        return {
          ok: false,
          diagnostics: [reject(
            "child_outcome_synthesis_invalid_member_outcome",
            `Synthesis members[${index}] is terminal and requires a supported outcome.`,
            `members[${index}].outcome`,
          )],
        };
      }
    }
    if (memberById.has(bindingId)) {
      return {
        ok: false,
        diagnostics: [reject(
          "child_outcome_synthesis_duplicate_member",
          `Synthesis members contains duplicate binding id '${bindingId}'.`,
          `members[${index}].bindingId`,
        )],
      };
    }
    memberById.set(bindingId, {
      bindingId,
      terminal: raw.terminal,
      ...(raw.outcome !== undefined ? { outcome: raw.outcome } : {}),
    });
  }

  // Every policy binding must have a member row.
  for (const bindingId of policy.bindingIds) {
    if (!memberById.has(bindingId)) {
      return {
        ok: false,
        diagnostics: [reject(
          "child_outcome_synthesis_member_missing",
          `Join set binding '${bindingId}' has no member outcome row.`,
          "members",
        )],
      };
    }
  }

  const pendingBindingIds: string[] = [];
  const completedBindingIds: string[] = [];
  const failedBindingIds: string[] = [];

  // Walk policy binding ids in deterministic order.
  const orderedIds = [...policy.bindingIds].sort(compareBindingId);
  for (const bindingId of orderedIds) {
    const member = memberById.get(bindingId)!;
    if (!member.terminal) {
      pendingBindingIds.push(bindingId);
      continue;
    }
    if (member.outcome === "completed") {
      completedBindingIds.push(bindingId);
    } else {
      failedBindingIds.push(bindingId);
    }
  }

  const totalCount = orderedIds.length;
  const terminalCount = completedBindingIds.length + failedBindingIds.length;
  const completedCount = completedBindingIds.length;

  // Wait for the planned fan-out size when expectedBindingCount is set.
  if (
    policy.expectedBindingCount !== undefined
    && totalCount < policy.expectedBindingCount
  ) {
    const remaining = policy.expectedBindingCount - totalCount;
    const word = remaining === 1 ? "binding" : "bindings";
    return {
      ok: true,
      result: {
        schemaVersion: CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION,
        strategy: policy.strategy,
        status: "pending",
        passed: false,
        completedCount,
        terminalCount,
        totalCount,
        pendingBindingIds: [...pendingBindingIds],
        completedBindingIds,
        failedBindingIds,
        reason:
          `Join waits for ${remaining} more ${word} `
          + `(${totalCount} of ${policy.expectedBindingCount} present).`,
      },
    };
  }

  if (pendingBindingIds.length > 0) {
    const count = pendingBindingIds.length;
    const word = count === 1 ? "binding" : "bindings";
    const beVerb = count === 1 ? "is" : "are";
    return {
      ok: true,
      result: {
        schemaVersion: CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION,
        strategy: policy.strategy,
        status: "pending",
        passed: false,
        completedCount,
        terminalCount,
        totalCount,
        pendingBindingIds,
        completedBindingIds,
        failedBindingIds,
        reason: `Join waits for ${count} ${word} that ${beVerb} not terminal.`,
      },
    };
  }

  // Empty join set: the join passes under all-success.
  if (totalCount === 0) {
    return {
      ok: true,
      result: {
        schemaVersion: CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION,
        strategy: policy.strategy,
        status: "passed",
        passed: true,
        completedCount: 0,
        terminalCount: 0,
        totalCount: 0,
        pendingBindingIds: [],
        completedBindingIds: [],
        failedBindingIds: [],
        reason: "Empty join set. All-success passes with no live children.",
        publishedFact: {
          name: policy.resultFactName,
          type: "boolean",
          value: true,
        },
      },
    };
  }

  if (policy.strategy === "all-success") {
    if (completedCount === totalCount) {
      return {
        ok: true,
        result: {
          schemaVersion: CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION,
          strategy: policy.strategy,
          status: "passed",
          passed: true,
          completedCount,
          terminalCount,
          totalCount,
          pendingBindingIds: [],
          completedBindingIds,
          failedBindingIds,
          reason: "Policy all-success: every child in the join set completed.",
          publishedFact: {
            name: policy.resultFactName,
            type: "boolean",
            value: true,
          },
        },
      };
    }
    return {
      ok: true,
      result: {
        schemaVersion: CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION,
        strategy: policy.strategy,
        status: "failed",
        passed: false,
        completedCount,
        terminalCount,
        totalCount,
        pendingBindingIds: [],
        completedBindingIds,
        failedBindingIds,
        reason:
          `Policy all-success: ${completedCount} of ${totalCount} `
          + `${totalCount === 1 ? "child" : "children"} completed.`,
        publishedFact: {
          name: policy.resultFactName,
          type: "boolean",
          value: false,
        },
      },
    };
  }

  return {
    ok: false,
    diagnostics: [reject(
      "child_outcome_synthesis_invalid_strategy",
      `Unsupported synthesis strategy '${formatUntrustedDiagnosticValue(policy.strategy)}'.`,
      "policy.strategy",
    )],
  };
}

// ---------------------------------------------------------------------------
// Family collection
// ---------------------------------------------------------------------------

/**
 * Collect join-set members from family bindings.
 * Missing bindings yield a diagnostic. Active bindings are non-terminal.
 */
export function collectChildOutcomeMembersFromFamily(
  family: GoalFamilyRuntime,
  bindingIds: readonly string[],
): { ok: true; members: ChildOutcomeMember[] } | { ok: false; diagnostics: Diagnostic[] } {
  const members: ChildOutcomeMember[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const bindingId of bindingIds) {
    const binding = family.bindings[bindingId];
    if (!binding) {
      diagnostics.push(reject(
        "child_outcome_synthesis_binding_missing",
        `Goal family '${family.familyId}' has no binding '${bindingId}'.`,
        "bindingIds",
      ));
      continue;
    }
    if (binding.status === "active") {
      members.push({ bindingId, terminal: false });
      continue;
    }
    const outcome = binding.returnRecord?.outcome;
    if (!outcome) {
      diagnostics.push(reject(
        "child_outcome_synthesis_return_record_missing",
        `Terminal binding '${bindingId}' has no return record outcome.`,
        `bindings.${bindingId}`,
      ));
      continue;
    }
    members.push({ bindingId, terminal: true, outcome });
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return { ok: true, members };
}

/**
 * Evaluate synthesis from family binding state and a declared policy.
 */
export function synthesizeChildOutcomesFromFamily(
  family: GoalFamilyRuntime,
  policyInput: unknown,
): ChildOutcomeSynthesisEvaluateResult {
  const policyResult = validateChildOutcomeSynthesisPolicy(policyInput);
  if (!policyResult.ok) return policyResult;
  const collected = collectChildOutcomeMembersFromFamily(family, policyResult.policy.bindingIds);
  if (!collected.ok) return collected;
  return evaluateChildOutcomeSynthesis(policyResult.policy, collected.members);
}

/**
 * List binding ids for one parent goal and optional parent node.
 * Order is deterministic by binding id.
 */
export function listBindingsForParentJoin(input: {
  family: GoalFamilyRuntime;
  parentGoalId: string;
  parentNodeId?: string;
}): string[] {
  const ids = Object.values(input.family.bindings)
    .filter((binding) => {
      if (binding.parentGoalId !== input.parentGoalId) return false;
      if (input.parentNodeId !== undefined && binding.parentNodeId !== input.parentNodeId) {
        return false;
      }
      return true;
    })
    .map((binding) => binding.bindingId)
    .sort(compareBindingId);
  return ids;
}

/**
 * True when every binding in the id list is terminal on the family.
 */
export function isJoinSetTerminal(
  family: GoalFamilyRuntime,
  bindingIds: readonly string[],
): boolean {
  if (bindingIds.length === 0) return true;
  for (const bindingId of bindingIds) {
    const binding = family.bindings[bindingId];
    if (!binding || binding.status === "active") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Parent apply (domain reduction via existing commands)
// ---------------------------------------------------------------------------

export interface ApplyChildOutcomeSynthesisInput {
  parentState: HypagraphState;
  policy: ChildOutcomeSynthesisPolicy;
  result: ChildOutcomeSynthesisResult;
  parentNodeId: string;
  parentAttemptId: string;
  at: string;
  commandId?: string;
  correlationId?: string;
  /**
   * When true (default), a failed join blocks the parent node after the fact
   * is published. Passed joins leave the parent running.
   */
  blockParentOnFailure?: boolean;
  /**
   * Product auto path only. When true, allow publish of DEFAULT_JOIN_RESULT_FACT_NAME
   * even when the parent node does not declare that boolean produce.
   * Uses a temporary produce for publish-facts validation. The parent definition
   * after apply does not keep that produce.
   * Custom resultFactName values never use this path.
   */
  allowHostDefaultJoinFact?: boolean;
}

/**
 * True when the parent node declares a boolean produce for the result fact.
 */
export function parentDeclaresJoinResultFact(
  parentState: HypagraphState,
  parentNodeId: string,
  resultFactName: string,
): boolean {
  const definitionNode = parentState.definition.nodes.find((node) => node.id === parentNodeId);
  return (definitionNode?.produces ?? []).some(
    (contract) => contract.name === resultFactName && contract.type === "boolean",
  );
}

/**
 * True when host-default publish is allowed for this apply.
 * Only the default join fact name may publish without a produce declaration.
 */
export function mayPublishHostDefaultJoinFact(input: {
  allowHostDefaultJoinFact?: boolean;
  resultFactName: string;
  publishedFactName: string;
}): boolean {
  if (input.allowHostDefaultJoinFact !== true) return false;
  if (input.resultFactName !== DEFAULT_JOIN_RESULT_FACT_NAME) return false;
  if (input.publishedFactName !== DEFAULT_JOIN_RESULT_FACT_NAME) return false;
  return true;
}

/**
 * Clone parent state with a temporary boolean produce for join fact publish.
 * Does not mutate the input state. Callers must restore the original definition
 * after publish so the synthetic produce does not remain.
 */
function parentStateWithTemporaryJoinProduce(
  state: HypagraphState,
  parentNodeId: string,
  resultFactName: string,
): HypagraphState {
  if (parentDeclaresJoinResultFact(state, parentNodeId, resultFactName)) {
    return state;
  }
  return {
    ...state,
    definition: {
      ...state.definition,
      nodes: state.definition.nodes.map((node) => {
        if (node.id !== parentNodeId) return node;
        return {
          ...node,
          produces: [
            ...(node.produces ?? []),
            { name: resultFactName, type: "boolean" as const },
          ],
        };
      }),
    },
  };
}

/**
 * True when the join result fact is already present for the current attempt.
 */
export function joinResultFactAlreadyApplied(
  parentState: HypagraphState,
  resultFactName: string,
  parentAttemptId: string,
): boolean {
  const existing = parentState.runtime.facts[resultFactName];
  return Boolean(
    existing
    && existing.type === "boolean"
    && existing.attemptId === parentAttemptId,
  );
}

/**
 * Apply a terminal synthesis result to the parent workflow.
 *
 * Requires parent node status running and a matching current attempt
 * (after child return has resumed the parent).
 *
 * Publishes the boolean result fact when the parent node declares that fact
 * in produces. When allowHostDefaultJoinFact is true, also publishes the
 * default join.passed fact without a permanent produce declaration.
 * Custom result fact names still require a matching boolean produce.
 *
 * When the join failed and blockParentOnFailure is true, blocks the parent node.
 * Timestamps and command ids are pure inputs.
 */
export function applyChildOutcomeSynthesisToParent(
  input: ApplyChildOutcomeSynthesisInput,
): ChildOutcomeSynthesisApplyResult {
  const policyResult = validateChildOutcomeSynthesisPolicy(input.policy);
  if (!policyResult.ok) return policyResult;
  const policy = policyResult.policy;

  if (
    input.result.schemaVersion !== CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION
    || (input.result.status !== "passed" && input.result.status !== "failed")
  ) {
    return {
      ok: false,
      diagnostics: [reject(
        "child_outcome_synthesis_not_terminal",
        "Parent apply requires a terminal synthesis result with status passed or failed.",
        "result.status",
      )],
    };
  }

  if (!isNonEmptyString(input.parentNodeId)) {
    return {
      ok: false,
      diagnostics: [reject(
        "child_outcome_synthesis_invalid_parent_node",
        "Parent node id must be a non-empty string.",
        "parentNodeId",
      )],
    };
  }
  if (!isNonEmptyString(input.parentAttemptId)) {
    return {
      ok: false,
      diagnostics: [reject(
        "child_outcome_synthesis_invalid_parent_attempt",
        "Parent attempt id must be a non-empty string.",
        "parentAttemptId",
      )],
    };
  }
  if (!isNonEmptyString(input.at)) {
    return {
      ok: false,
      diagnostics: [reject(
        "child_outcome_synthesis_invalid_timestamp",
        "Synthesis apply requires a non-empty timestamp.",
        "at",
      )],
    };
  }

  const parentNode = input.parentState.runtime.nodes[input.parentNodeId];
  if (!parentNode) {
    return {
      ok: false,
      diagnostics: [reject(
        "unknown_parent_node",
        `Parent workflow '${input.parentState.workflowId}' has no runtime for node `
        + `'${input.parentNodeId}'.`,
        "parentNodeId",
      )],
    };
  }
  if (parentNode.status !== "running") {
    return {
      ok: false,
      diagnostics: [reject(
        "child_outcome_synthesis_parent_not_running",
        `Parent task '${input.parentNodeId}' is '${parentNode.status}'. `
        + "Synthesis apply requires running status after child return.",
        "parentNodeId",
      )],
    };
  }
  if (!parentNode.currentAttemptId || parentNode.currentAttemptId !== input.parentAttemptId) {
    return {
      ok: false,
      diagnostics: [reject(
        "child_outcome_synthesis_stale_attempt",
        `Parent attempt '${parentNode.currentAttemptId ?? "none"}' does not match `
        + `synthesis attempt '${input.parentAttemptId}'.`,
        "parentAttemptId",
      )],
    };
  }

  const fact = input.result.publishedFact;
  if (!fact) {
    return {
      ok: false,
      diagnostics: [reject(
        "child_outcome_synthesis_fact_missing",
        "Terminal synthesis result must include a publishedFact payload.",
        "result.publishedFact",
      )],
    };
  }

  const correlationId = input.correlationId
    ?? `child-outcome-synthesis:${input.parentState.workflowId}:${input.parentNodeId}`;
  const baseCommandId = input.commandId
    ?? `record-child-outcome-synthesis:${input.parentNodeId}:${policy.bindingIds.slice().sort(compareBindingId).join(",")}`;

  const factDeclared = parentDeclaresJoinResultFact(
    input.parentState,
    input.parentNodeId,
    fact.name,
  );
  const hostDefaultPublish = mayPublishHostDefaultJoinFact({
    ...(input.allowHostDefaultJoinFact !== undefined
      ? { allowHostDefaultJoinFact: input.allowHostDefaultJoinFact }
      : {}),
    resultFactName: policy.resultFactName,
    publishedFactName: fact.name,
  });
  const mayPublishFact = factDeclared || hostDefaultPublish;

  // Idempotent when the join fact is already present for this attempt.
  const alreadyApplied = joinResultFactAlreadyApplied(
    input.parentState,
    fact.name,
    input.parentAttemptId,
  );

  let nextState = input.parentState;
  const parentEvents: DomainEvent[] = [];
  let factPublished = false;

  if (mayPublishFact && !alreadyApplied) {
    // Host-default path: temporary produce for publish-facts validation only.
    // Restore the original definition after apply so it is not mutated.
    const definitionBeforePublish = nextState.definition;
    const stateForPublish = factDeclared
      ? nextState
      : parentStateWithTemporaryJoinProduce(nextState, input.parentNodeId, fact.name);
    const published = handleCommand(stateForPublish, {
      type: "publish-facts",
      nodeId: input.parentNodeId,
      attemptId: input.parentAttemptId,
      facts: [{
        name: fact.name,
        type: "boolean",
        value: fact.value,
      }],
      commandId: `${baseCommandId}:fact`,
      correlationId,
      at: input.at,
    });
    if (!published.ok) {
      return { ok: false, diagnostics: published.diagnostics };
    }
    nextState = factDeclared
      ? published.state
      : { ...published.state, definition: definitionBeforePublish };
    parentEvents.push(...published.events);
    factPublished = published.events.some((event) => event.type === "hypagraph.fact.published");
  }

  const blockOnFailure = input.blockParentOnFailure !== false;
  const parentStillRunning =
    nextState.runtime.nodes[input.parentNodeId]?.status === "running";
  if (input.result.status === "failed" && blockOnFailure && parentStillRunning) {
    const blocked = handleCommand(nextState, {
      type: "block-node",
      nodeId: input.parentNodeId,
      reason: input.result.reason,
      commandId: `${baseCommandId}:block`,
      correlationId,
      at: input.at,
    });
    if (!blocked.ok) {
      return { ok: false, diagnostics: blocked.diagnostics };
    }
    nextState = blocked.state;
    parentEvents.push(...blocked.events);
  }

  // Failed join must either publish false or block; otherwise reject.
  if (
    input.result.status === "failed"
    && parentEvents.length === 0
    && nextState.runtime.nodes[input.parentNodeId]?.status === "running"
  ) {
    return {
      ok: false,
      diagnostics: [reject(
        "child_outcome_synthesis_no_parent_effect",
        `Failed join for '${input.parentNodeId}' did not change parent state. `
        + `Declare produces fact '${fact.name}' (boolean), enable host default `
        + "join fact publish, or enable blockParentOnFailure.",
        "parentNodeId",
      )],
    };
  }

  const record: ChildOutcomeSynthesisRecord = {
    schemaVersion: CHILD_OUTCOME_SYNTHESIS_SCHEMA_VERSION,
    strategy: policy.strategy,
    status: input.result.status,
    passed: input.result.passed,
    bindingIds: [...policy.bindingIds].sort(compareBindingId),
    resultFactName: policy.resultFactName,
    completedCount: input.result.completedCount,
    totalCount: input.result.totalCount,
    evaluatedAt: input.at,
    reason: input.result.reason,
  };

  return {
    ok: true,
    parentState: nextState,
    parentEvents,
    result: structuredClone(input.result),
    record: structuredClone(record),
    factPublished: factPublished || (
      alreadyApplied
      && mayPublishFact
      && input.parentState.runtime.facts[fact.name]?.value === fact.value
    ),
    parentMutated: parentEvents.length > 0,
  };
}

/**
 * Evaluate family join and apply terminal result to the parent in one step.
 * Returns pending without mutating parent when the join set is not terminal.
 */
export function synthesizeAndApplyChildOutcomes(input: {
  family: GoalFamilyRuntime;
  parentState: HypagraphState;
  policy: unknown;
  parentNodeId: string;
  parentAttemptId: string;
  at: string;
  commandId?: string;
  correlationId?: string;
  blockParentOnFailure?: boolean;
}):
  | { ok: true; status: "pending"; result: ChildOutcomeSynthesisResult }
  | ChildOutcomeSynthesisApplyResult {
  const evaluated = synthesizeChildOutcomesFromFamily(input.family, input.policy);
  if (!evaluated.ok) return evaluated;
  if (evaluated.result.status === "pending") {
    return { ok: true, status: "pending", result: evaluated.result };
  }
  const policyResult = validateChildOutcomeSynthesisPolicy(input.policy);
  if (!policyResult.ok) return policyResult;
  return applyChildOutcomeSynthesisToParent({
    parentState: input.parentState,
    policy: policyResult.policy,
    result: evaluated.result,
    parentNodeId: input.parentNodeId,
    parentAttemptId: input.parentAttemptId,
    at: input.at,
    ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.blockParentOnFailure !== undefined
      ? { blockParentOnFailure: input.blockParentOnFailure }
      : {}),
  });
}
