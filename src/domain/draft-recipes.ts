/**
 * Pure high-level draft recipes.
 *
 * Recipes expand common patterns through low-level constructors.
 * They do not bypass validation.
 */

import type { FactContract } from "./facts.js";
import type { LoopSuccessPredicate } from "./model.js";
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
