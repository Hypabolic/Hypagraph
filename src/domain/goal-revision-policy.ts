import { sha256 } from "./hash.js";
import type { Diagnostic, EvaluationBudgetDefinition, HypagraphDefinition, LoopDefinition, NodeDefinition } from "./model.js";
import { loopFailurePolicy } from "./workflow-outcome.js";

const diagnostic = (code: string, message: string, location?: string): Diagnostic => ({ code, message, ...(location ? { location } : {}) });
const exact = (left: unknown, right: unknown): boolean => sha256(left) === sha256(right);
const containsAll = (next: readonly string[], previous: readonly string[]): boolean => previous.every((item) => next.includes(item));

const limitDoesNotIncrease = (previous: number | undefined, next: number | undefined): boolean => {
  if (previous === undefined) return true;
  return next !== undefined && next <= previous;
};

const validateNode = (previous: NodeDefinition, next: NodeDefinition): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const location = `nodes.${previous.id}`;
  if ((previous.kind ?? "task") !== (next.kind ?? "task")) diagnostics.push(diagnostic("automatic_revision_node_kind_changed", `Node '${previous.id}' cannot change kind automatically.`, location));
  if (!containsAll(next.requires, previous.requires)) diagnostics.push(diagnostic("automatic_revision_required_dependency_removed", `Node '${previous.id}' cannot remove a required dependency automatically.`, `${location}.requires`));
  if (!containsAll(next.acceptance, previous.acceptance)) diagnostics.push(diagnostic("automatic_revision_acceptance_removed", `Node '${previous.id}' cannot remove an acceptance requirement automatically.`, `${location}.acceptance`));
  for (const contract of previous.produces ?? []) {
    if (!(next.produces ?? []).some((candidate) => exact(candidate, contract))) diagnostics.push(diagnostic("automatic_revision_fact_contract_removed", `Node '${previous.id}' cannot remove or change fact contract '${contract.name}'.`, `${location}.produces`));
  }
  if (!exact(previous.gate ?? null, next.gate ?? null)) diagnostics.push(diagnostic("automatic_revision_gate_changed", `Node '${previous.id}' cannot remove or change a gate automatically.`, `${location}.gate`));
  if (!exact(previous.check ?? null, next.check ?? null)) diagnostics.push(diagnostic("automatic_revision_check_changed", `Node '${previous.id}' cannot remove or change a required check or evaluator automatically.`, `${location}.check`));
  if (previous.scope) {
    if (!next.scope || !next.scope.paths.every((path) => previous.scope!.paths.includes(path))) diagnostics.push(diagnostic("automatic_revision_scope_weakened", `Node '${previous.id}' cannot broaden or remove its repository scope automatically.`, `${location}.scope`));
  }
  return diagnostics;
};

const legacyPredicate = (value: unknown): boolean => typeof value === "string"
  || (!!value && typeof value === "object" && (value as { kind?: unknown }).kind === "legacy-text");

const validateLoop = (previous: LoopDefinition, next: LoopDefinition): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const location = `loops.${previous.id}`;
  if (!containsAll(next.nodes, previous.nodes)) diagnostics.push(diagnostic("automatic_revision_loop_node_removed", `Loop '${previous.id}' cannot remove existing work automatically.`, `${location}.nodes`));
  if (next.entry !== previous.entry || next.evaluateAfter !== previous.evaluateAfter || !exact(next.feedbackEdges, previous.feedbackEdges)) diagnostics.push(diagnostic("automatic_revision_loop_structure_changed", `Loop '${previous.id}' cannot change its entry, evaluation boundary, or feedback edges automatically.`, location));
  if (!legacyPredicate(previous.successWhen) && !exact(next.successWhen, previous.successWhen)) diagnostics.push(diagnostic("automatic_revision_typed_success_changed", `Loop '${previous.id}' cannot remove or change typed success automatically.`, `${location}.successWhen`));
  if (legacyPredicate(previous.successWhen) && legacyPredicate(next.successWhen)) diagnostics.push(diagnostic("automatic_revision_legacy_success_not_replaced", `Loop '${previous.id}' must replace its legacy success predicate with a typed condition.`, `${location}.successWhen`));
  if (loopFailurePolicy(previous) !== loopFailurePolicy(next)) diagnostics.push(diagnostic("automatic_revision_failure_policy_changed", `Loop '${previous.id}' cannot change its failure policy automatically.`, `${location}.failurePolicy`));
  if (!limitDoesNotIncrease(previous.maxIterations, next.maxIterations)) diagnostics.push(diagnostic("automatic_revision_iteration_limit_raised", `Loop '${previous.id}' cannot raise its iteration limit automatically.`, `${location}.maxIterations`));
  if (!limitDoesNotIncrease(previous.patience, next.patience)) diagnostics.push(diagnostic("automatic_revision_patience_limit_raised", `Loop '${previous.id}' cannot remove or raise its patience limit automatically.`, `${location}.patience`));
  if (!limitDoesNotIncrease(previous.evaluation?.maximumInvalidEvaluations, next.evaluation?.maximumInvalidEvaluations)) diagnostics.push(diagnostic("automatic_revision_invalid_limit_raised", `Loop '${previous.id}' cannot remove or raise its invalid-evaluation limit automatically.`, `${location}.evaluation.maximumInvalidEvaluations`));
  if (previous.progress && !exact(previous.progress, next.progress)) diagnostics.push(diagnostic("automatic_revision_progress_changed", `Loop '${previous.id}' cannot remove or change its progress contract automatically.`, `${location}.progress`));
  if (previous.evaluation?.validWhen && !exact(previous.evaluation.validWhen, next.evaluation?.validWhen)) diagnostics.push(diagnostic("automatic_revision_validity_changed", `Loop '${previous.id}' cannot remove or change evaluation validity automatically.`, `${location}.evaluation.validWhen`));
  return diagnostics;
};

const budgetKeys: Array<keyof EvaluationBudgetDefinition> = [
  "maximumEvaluations",
  "maximumDevelopmentEvaluations",
  "maximumProbeEvaluations",
  "maximumHoldoutEvaluations",
];

export function validateAutomaticRevision(previous: HypagraphDefinition, next: HypagraphDefinition): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const proposed = next as unknown as Record<string, unknown>;
  for (const key of ["budget", "goalBudget", "maximumTurns", "maximumTokens"] as const) {
    if (Object.prototype.hasOwnProperty.call(proposed, key)) diagnostics.push(diagnostic("automatic_revision_goal_budget_changed", `Automatic revision cannot reset, add, or raise goal budget field '${key}'.`, key));
  }
  for (const key of ["status", "completed", "outcome"] as const) {
    if (Object.prototype.hasOwnProperty.call(proposed, key)) diagnostics.push(diagnostic("automatic_revision_control_claim", `Automatic revision cannot claim control-plane outcome field '${key}'.`, key));
  }
  if (next.goal !== previous.goal) diagnostics.push(diagnostic("automatic_revision_objective_changed", "An automatic revision must preserve the exact objective byte-for-byte.", "goal"));
  if (exact(previous, next)) diagnostics.push(diagnostic("automatic_revision_no_op", "The proposed definition does not change the workflow."));
  if (previous.policy.requireEvidence && !next.policy.requireEvidence) diagnostics.push(diagnostic("automatic_revision_evidence_weakened", "An automatic revision cannot remove required evidence.", "policy.requireEvidence"));
  if (previous.policy.mode === "strict" && next.policy.mode !== "strict") diagnostics.push(diagnostic("automatic_revision_enforcement_weakened", "An automatic revision cannot weaken strict enforcement.", "policy.mode"));

  const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
  for (const node of previous.nodes) {
    const replacement = nextNodes.get(node.id);
    if (!replacement) diagnostics.push(diagnostic("automatic_revision_node_removed", `Automatic revision cannot delete existing node '${node.id}'.`, `nodes.${node.id}`));
    else diagnostics.push(...validateNode(node, replacement));
  }

  const nextLoops = new Map(next.loops.map((loop) => [loop.id, loop]));
  for (const loop of previous.loops) {
    const replacement = nextLoops.get(loop.id);
    if (!replacement) diagnostics.push(diagnostic("automatic_revision_loop_removed", `Automatic revision cannot delete existing loop '${loop.id}'.`, `loops.${loop.id}`));
    else diagnostics.push(...validateLoop(loop, replacement));
  }

  for (const key of budgetKeys) {
    const previousLimit = previous.evaluation?.budget[key];
    const nextLimit = next.evaluation?.budget[key];
    if (!limitDoesNotIncrease(previousLimit, nextLimit)) diagnostics.push(diagnostic("automatic_revision_evaluation_budget_raised", `Automatic revision cannot remove or raise evaluation budget '${key}'.`, `evaluation.budget.${key}`));
  }
  return diagnostics;
}
