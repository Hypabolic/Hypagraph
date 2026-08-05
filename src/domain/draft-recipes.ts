/**
 * Pure high-level draft recipes.
 *
 * Recipes expand common patterns through low-level constructors.
 * They do not bypass validation.
 */

import type { FactContract } from "./facts.js";
import type { HypagraphDefinition, LoopSuccessPredicate } from "./model.js";
import {
  addCheckToDraft,
  addTaskToDraft,
  declareLoopOnDraft,
  requireOnDraft,
} from "./draft-constructors.js";
import type { DraftMutationResult, HypagraphDraftRecord } from "./draft.js";

export interface ImplementVerifyLoopRecipeInput {
  /** Task node id. Default: implement */
  implementId?: string;
  /** Verify node id. Default: verify */
  verifyId?: string;
  implementTitle?: string;
  verifyTitle?: string;
  implementAcceptance?: string[];
  verifyAcceptance?: string[];
  /** Fact produced by verify. Default: tests.passed boolean */
  successFact?: FactContract;
  successWhen?: LoopSuccessPredicate;
  maxIterations?: number;
  loopId?: string;
  /** Optional command check on the verify node. When omitted, verify is a task that produces the fact. */
  verifyCheck?: Parameters<typeof addCheckToDraft>[1]["check"];
}

/**
 * Build a two-node implement and verify loop on an open draft.
 *
 * Shape:
 * - implement (task) requires verify (feedback, owned by loop tool)
 * - verify requires implement (forward work)
 * - loop feedbackEdges owned by hypagraph_loop / declareLoopOnDraft
 */
export function applyImplementVerifyLoopRecipe(
  draft: HypagraphDraftRecord,
  input: ImplementVerifyLoopRecipeInput,
  updatedAt: string,
): DraftMutationResult {
  const implementId = (input.implementId ?? "implement").trim();
  const verifyId = (input.verifyId ?? "verify").trim();
  const loopId = (input.loopId ?? `${implementId}-${verifyId}-loop`).trim();
  const successFact: FactContract = input.successFact ?? {
    name: "tests.passed",
    type: "boolean",
    required: true,
  };
  const successWhen: LoopSuccessPredicate = input.successWhen ?? {
    kind: "compare",
    left: { kind: "fact", name: successFact.name },
    operator: "eq",
    right: { kind: "literal", value: true },
  };
  const maxIterations = input.maxIterations ?? 8;

  let current = draft;

  const taskResult = addTaskToDraft(current, {
    id: implementId,
    title: input.implementTitle ?? "Implement",
    acceptance: input.implementAcceptance ?? ["Implementation matches the objective."],
  }, updatedAt);
  if (!taskResult.ok) return taskResult;
  current = taskResult.draft;

  if (input.verifyCheck) {
    const checkResult = addCheckToDraft(current, {
      id: verifyId,
      title: input.verifyTitle ?? "Verify",
      check: input.verifyCheck,
      acceptance: input.verifyAcceptance ?? ["Verification passes."],
      produces: [successFact],
      requires: [implementId],
    }, updatedAt);
    if (!checkResult.ok) return checkResult;
    current = checkResult.draft;
  } else {
    const verifyTask = addTaskToDraft(current, {
      id: verifyId,
      title: input.verifyTitle ?? "Verify",
      acceptance: input.verifyAcceptance ?? ["Verification passes."],
      produces: [successFact],
      requires: [implementId],
    }, updatedAt);
    if (!verifyTask.ok) return verifyTask;
    current = verifyTask.draft;
  }

  // Forward edge may already exist from requires above; require is idempotent.
  const requireResult = requireOnDraft(current, { from: implementId, to: verifyId }, updatedAt);
  if (!requireResult.ok) return requireResult;
  current = requireResult.draft;

  const loopResult = declareLoopOnDraft(current, {
    loopId,
    entry: implementId,
    evaluateAfter: verifyId,
    successWhen,
    maxIterations,
  }, updatedAt);
  if (!loopResult.ok) return loopResult;

  return {
    ok: true,
    draft: loopResult.draft,
    notes: [
      ...taskResult.notes,
      ...(input.verifyCheck ? [] : []),
      ...requireResult.notes,
      ...loopResult.notes,
      {
        code: "recipe_implement_verify_loop",
        message: `Applied implement/verify recipe. Loop '${loopId}' owns feedback edges.`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Flagship: implement → parallel review children → ordinary join → integrate
// Inspired by the implement skill (implementer, then multi-reviewer quorum).
// ---------------------------------------------------------------------------

/** Default parallel review roles (implement-skill style specializations). */
export const DEFAULT_PARALLEL_REVIEW_ROLES = [
  "general",
  "tests",
  "security",
] as const;

export type ParallelReviewRole =
  | (typeof DEFAULT_PARALLEL_REVIEW_ROLES)[number]
  | "plan";

export interface ImplementParallelReviewRecipeInput {
  /** Same-graph implement task id. Default: implement */
  implementId?: string;
  /** Parent task that fans out review children. Default: review-panel */
  reviewPanelId?: string;
  /** Integration task after ordinary join. Default: integrate */
  integrateId?: string;
  /** Optional final verify check id. When set, a check node is added. */
  verifyId?: string;
  implementTitle?: string;
  reviewPanelTitle?: string;
  integrateTitle?: string;
  verifyTitle?: string;
  implementAcceptance?: string[];
  reviewPanelAcceptance?: string[];
  integrateAcceptance?: string[];
  verifyAcceptance?: string[];
  /** Roles for parallel review children. Default: general, tests, security. */
  reviewRoles?: ParallelReviewRole[];
  /** Optional command check on verify. When omit verifyId, no verify node. */
  verifyCheck?: Parameters<typeof addCheckToDraft>[1]["check"];
  /**
   * When true (default), add verify as a task that produces tests.passed.
   * Ignored when verifyId is omitted. When verifyCheck is set, verify is a check.
   */
  includeVerifyTask?: boolean;
  /** Success fact for optional verify. Default: tests.passed boolean */
  successFact?: FactContract;
  /** Writable scope for implement and review panel. Optional. */
  scopePaths?: string[];
}

export interface ParallelReviewChildTemplate {
  role: ParallelReviewRole;
  /** Suggested child node id for the child draft implement/review task. */
  taskId: string;
  /** Suggested output fact name for this reviewer. */
  outputFactName: string;
  title: string;
  objectiveHint: string;
  acceptance: string[];
}

/**
 * Build acceptance lines for the review-panel parent task.
 * The model must create one child per role and rely on ordinary multi-child join.
 */
export function buildReviewPanelAcceptance(
  roles: readonly ParallelReviewRole[],
  reviewPanelId: string,
): string[] {
  const roleList = roles.join(", ");
  return [
    `Create exactly ${roles.length} child Hypagoals from parent node '${reviewPanelId}' (one per review role: ${roleList}).`,
    "Call hypagoal_create_child for every role while this parent task is active or already waiting_for_child. Do not wait for one child to finish before creating the next when you need multi-child join.",
    "Each child graph is a focused reviewer (not an implementer). Prefer draft tools for the child graph, then create-child with draftId.",
    "Each child must return a boolean output fact review.<role>.passed (for example review.general.passed).",
    "Do not declare produce join.passed on this parent. Ordinary multi-child join publishes default join.passed when every sibling is terminal.",
    "Do not set expectedBindingCount. The multi-child wait set tracks sibling count.",
    "After ordinary join pass, leave this task for integration. Do not mark the root complete.",
    "On join failure or a non-completed child, follow the declared child failure policy and status diagnostics.",
  ];
}

/**
 * Suggested child templates for parallel reviewers (implement-skill inspired).
 */
export function buildParallelReviewChildTemplates(
  roles: readonly ParallelReviewRole[] = DEFAULT_PARALLEL_REVIEW_ROLES,
): ParallelReviewChildTemplate[] {
  return roles.map((role) => {
    const outputFactName = `review.${role}.passed`;
    const base = {
      role,
      taskId: `review-${role}`,
      outputFactName,
    };
    if (role === "general") {
      return {
        ...base,
        title: "General review",
        objectiveHint:
          "Review the implementation for correctness, bugs, naming, and design quality. Do not re-implement unless a fix is required for a clear defect.",
        acceptance: [
          "Findings are specific and actionable.",
          `Publish ${outputFactName}=true only when no blocking defects remain.`,
        ],
      };
    }
    if (role === "tests") {
      return {
        ...base,
        title: "Tests review",
        objectiveHint:
          "Review test coverage and quality: edge cases, error paths, assertion strength. Do not review general style.",
        acceptance: [
          "Missing tests for new logic are listed.",
          `Publish ${outputFactName}=true only when test coverage is adequate for the change.`,
        ],
      };
    }
    if (role === "security") {
      return {
        ...base,
        title: "Security review",
        objectiveHint:
          "Review for exploitable security issues: injection, secrets, authz, unsafe paths. Map high severity to fail.",
        acceptance: [
          "Only real, exploitable issues block pass.",
          `Publish ${outputFactName}=true only when no blocking security defects remain.`,
        ],
      };
    }
    // plan
    return {
      ...base,
      title: "Plan alignment review",
      objectiveHint:
        "Review whether the implementation matches the stated objective and acceptance. Flag scope drift and missing requirements.",
      acceptance: [
        "Plan mismatches are listed.",
        `Publish ${outputFactName}=true only when the implementation matches the objective.`,
      ],
    };
  });
}

/**
 * Build a minimal child Hypagraph definition for one parallel reviewer.
 * Used at create-child time (draftId or free-form definition).
 */
export function buildParallelReviewChildDefinition(input: {
  role: ParallelReviewRole;
  /** Child workflow goal / objective prose. */
  objective: string;
  title?: string;
  taskId?: string;
  scopePaths?: string[];
}): HypagraphDefinition {
  const templates = buildParallelReviewChildTemplates([input.role]);
  const template = templates[0]!;
  const taskId = (input.taskId ?? template.taskId).trim() || template.taskId;
  const scopePaths = input.scopePaths?.filter((p) => p.trim()) ?? [];
  return {
    title: (input.title ?? template.title).trim() || template.title,
    goal: input.objective.trim() || template.objectiveHint,
    nodes: [
      {
        id: taskId,
        title: template.title,
        kind: "task",
        requires: [],
        acceptance: [...template.acceptance, template.objectiveHint],
        produces: [
          {
            name: template.outputFactName,
            type: "boolean",
            required: true,
          },
        ],
        ...(scopePaths.length > 0 ? { scope: { paths: [...scopePaths] } } : {}),
      },
    ],
    loops: [],
    policy: { mode: "guided", requireEvidence: false },
  };
}

/**
 * Build a minimal child definition for an isolated implementer (optional fan-out).
 */
export function buildImplementChildDefinition(input: {
  objective: string;
  title?: string;
  taskId?: string;
  scopePaths?: string[];
  successFactName?: string;
}): HypagraphDefinition {
  const taskId = (input.taskId ?? "implement").trim() || "implement";
  const factName = (input.successFactName ?? "implement.done").trim() || "implement.done";
  const scopePaths = input.scopePaths?.filter((p) => p.trim()) ?? [];
  return {
    title: (input.title ?? "Implement").trim() || "Implement",
    goal: input.objective.trim(),
    nodes: [
      {
        id: taskId,
        title: "Implement",
        kind: "task",
        requires: [],
        acceptance: [
          "Implementation matches the child objective.",
          `Publish ${factName}=true when the work is done with evidence.`,
        ],
        produces: [{ name: factName, type: "boolean", required: true }],
        ...(scopePaths.length > 0 ? { scope: { paths: [...scopePaths] } } : {}),
      },
    ],
    loops: [],
    policy: { mode: "guided", requireEvidence: false },
  };
}

/**
 * Expand the flagship implement → parallel review → integrate recipe onto an open draft.
 *
 * Root shape (same graph):
 * 1. implement — isolated task does the change (or plans the work)
 * 2. review-panel — parent task that creates N review children; ordinary multi-child join
 * 3. integrate — after join, address findings and finalize (does not auto-complete the goal)
 * 4. optional verify — task or check after integrate
 *
 * Runtime (not encoded as edges): while review-panel is active, the model calls
 * hypagoal_create_child once per review role. Ordinary join publishes join.passed.
 */
export function applyImplementParallelReviewRecipe(
  draft: HypagraphDraftRecord,
  input: ImplementParallelReviewRecipeInput,
  updatedAt: string,
): DraftMutationResult {
  const implementId = (input.implementId ?? "implement").trim() || "implement";
  const reviewPanelId = (input.reviewPanelId ?? "review-panel").trim() || "review-panel";
  const integrateId = (input.integrateId ?? "integrate").trim() || "integrate";
  const roles: ParallelReviewRole[] =
    input.reviewRoles && input.reviewRoles.length > 0
      ? [...input.reviewRoles]
      : [...DEFAULT_PARALLEL_REVIEW_ROLES];
  const successFact: FactContract = input.successFact ?? {
    name: "tests.passed",
    type: "boolean",
    required: true,
  };
  const includeVerify =
    input.verifyId !== undefined
    || input.verifyCheck !== undefined
    || input.includeVerifyTask === true;
  const verifyId = (input.verifyId ?? "verify").trim() || "verify";
  const scopePaths = input.scopePaths?.filter((p) => p.trim());

  if (roles.length < 2) {
    return {
      ok: false,
      diagnostics: [{
        code: "recipe_parallel_review_roles_min",
        message: "Implement/parallel-review recipe needs at least two review roles for ordinary multi-child join.",
        suggestion: "Use the default roles general, tests, and security, or pass two or more roles.",
      }],
    };
  }

  let current = draft;
  const notes = [];

  const implementResult = addTaskToDraft(current, {
    id: implementId,
    title: input.implementTitle ?? "Implement",
    acceptance: input.implementAcceptance ?? [
      "Implementation matches the objective.",
      "Evidence is ready for parallel review.",
    ],
    ...(scopePaths === undefined ? {} : { scopePaths: [...scopePaths] }),
  }, updatedAt);
  if (!implementResult.ok) return implementResult;
  current = implementResult.draft;
  notes.push(...implementResult.notes);

  const panelAcceptance =
    input.reviewPanelAcceptance
    ?? buildReviewPanelAcceptance(roles, reviewPanelId);

  const panelResult = addTaskToDraft(current, {
    id: reviewPanelId,
    title: input.reviewPanelTitle ?? "Parallel review panel",
    acceptance: panelAcceptance,
    requires: [implementId],
    ...(scopePaths === undefined ? {} : { scopePaths: [...scopePaths] }),
  }, updatedAt);
  if (!panelResult.ok) return panelResult;
  current = panelResult.draft;
  notes.push(...panelResult.notes);

  const integrateResult = addTaskToDraft(current, {
    id: integrateId,
    title: input.integrateTitle ?? "Integrate review results",
    acceptance: input.integrateAcceptance ?? [
      "Address blocking findings from parallel review children when join failed or facts show fail.",
      "When join.passed is true and reviews passed, finalize integration without inventing new scope.",
      "Do not mark the Hypagoal complete. Terminal state stays workflow-derived.",
    ],
    requires: [reviewPanelId],
  }, updatedAt);
  if (!integrateResult.ok) return integrateResult;
  current = integrateResult.draft;
  notes.push(...integrateResult.notes);

  if (includeVerify) {
    if (input.verifyCheck) {
      const checkResult = addCheckToDraft(current, {
        id: verifyId,
        title: input.verifyTitle ?? "Verify",
        check: input.verifyCheck,
        acceptance: input.verifyAcceptance ?? ["Verification passes."],
        produces: [successFact],
        requires: [integrateId],
      }, updatedAt);
      if (!checkResult.ok) return checkResult;
      current = checkResult.draft;
      notes.push(...checkResult.notes);
    } else {
      const verifyTask = addTaskToDraft(current, {
        id: verifyId,
        title: input.verifyTitle ?? "Verify",
        acceptance: input.verifyAcceptance ?? [
          "Final verification passes.",
          `Publish ${successFact.name}=true when checks succeed.`,
        ],
        produces: [successFact],
        requires: [integrateId],
      }, updatedAt);
      if (!verifyTask.ok) return verifyTask;
      current = verifyTask.draft;
      notes.push(...verifyTask.notes);
    }
  }

  const templates = buildParallelReviewChildTemplates(roles);
  const roleSummary = templates
    .map((t) => `${t.role}→${t.outputFactName}`)
    .join("; ");

  notes.push({
    code: "recipe_implement_parallel_review",
    message:
      `Applied implement/parallel-review flagship recipe. `
      + `Root: ${implementId} → ${reviewPanelId} → ${integrateId}`
      + (includeVerify ? ` → ${verifyId}` : "")
      + `. Review roles: ${roleSummary}. `
      + "At runtime on review-panel, create one child per role; ordinary multi-child join applies.",
  });

  for (const template of templates) {
    notes.push({
      code: "recipe_parallel_review_child_template",
      message:
        `Child template role=${template.role} taskId=${template.taskId} `
        + `outputFact=${template.outputFactName}: ${template.objectiveHint}`,
    });
  }

  return {
    ok: true,
    draft: current,
    notes,
  };
}
