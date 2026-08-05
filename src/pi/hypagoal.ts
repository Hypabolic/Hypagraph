import { Type, type Static } from "typebox";
import type { GoalBudgetDefinition, HypagraphState } from "../domain/model.js";
import type {
  HypagoalAuthoringAdvisory,
  RootCanonicalIdentity,
  RootHypagoalStartResult,
  RootReplacementConfirmation,
} from "../hypagoal/root-creation.js";
import { definitionSchema, normalizeDefinition } from "./definition.js";

const replacementConfirmationSchema = Type.Object({
  workflowId: Type.String(),
  goalId: Type.Union([Type.String(), Type.Null()]),
  workflowRevision: Type.Integer({ minimum: 1 }),
  eventSequence: Type.Integer({ minimum: 1 }),
  snapshotHash: Type.String(),
  sessionGeneration: Type.Integer({ minimum: 0 }),
  branchGeneration: Type.Integer({ minimum: 0 }),
});

const creationRequestSchema = Type.Object({
  operationId: Type.String({ minLength: 1 }),
  sessionGeneration: Type.Integer({ minimum: 0 }),
  branchGeneration: Type.Integer({ minimum: 0 }),
});

const goalBudgetSchema = Type.Object({
  maximumTurns: Type.Optional(Type.Integer({ minimum: 1 })),
  maximumTokens: Type.Optional(Type.Integer({ minimum: 1 })),
});

const advisorySchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
});

export const hypagoalStartSchema = Type.Object({
  objective: Type.String({ minLength: 1 }),
  /**
   * Preferred create path after Wave 7: commit a project draft by id.
   * Supply draftId or definition. Prefer draftId for model authoring.
   */
  draftId: Type.Optional(Type.String({ minLength: 1 })),
  /**
   * Free-form definition remains for tests, import, and advanced cases.
   * Prefer draftId for normal authoring.
   */
  definition: Type.Optional(definitionSchema),
  advisories: Type.Optional(Type.Array(advisorySchema)),
  budget: Type.Optional(goalBudgetSchema),
  creationRequest: Type.Optional(creationRequestSchema),
  replacementConfirmation: Type.Optional(replacementConfirmationSchema),
});

export type HypagoalStartInput = Static<typeof hypagoalStartSchema>;
export type HypagoalCreationRequest = Static<typeof creationRequestSchema>;

export interface NormalizedHypagoalStartInput {
  objective: string;
  /** Present when the caller supplied a free-form definition. */
  definition?: ReturnType<typeof normalizeDefinition>;
  /** Present when the caller commits a project draft. */
  draftId?: string;
  advisories: HypagoalAuthoringAdvisory[];
  budget?: GoalBudgetDefinition;
  creationRequest?: HypagoalCreationRequest;
  replacementConfirmation?: RootReplacementConfirmation;
}

/**
 * Normalize hypagoal_start params.
 * Requires draftId or definition. Does not load drafts from disk.
 * Accepts unknown tool params so TypeBox Static optional fields do not fight exactOptionalPropertyTypes.
 */
export function normalizeHypagoalStartInput(input: HypagoalStartInput | Record<string, unknown>): NormalizedHypagoalStartInput {
  const record = input as HypagoalStartInput;
  const draftId = typeof record.draftId === "string" && record.draftId.trim().length > 0
    ? record.draftId.trim()
    : undefined;
  const hasDefinition = record.definition !== undefined && record.definition !== null;
  if (!draftId && !hasDefinition) {
    throw new Error(
      "hypagoal_start requires draftId or definition. Prefer draftId after authoring with construction tools.",
    );
  }
  return {
    objective: String(record.objective ?? ""),
    ...(draftId === undefined ? {} : { draftId }),
    ...(hasDefinition ? { definition: normalizeDefinition(record.definition as HypagoalStartInput["definition"] & object) } : {}),
    advisories: (record.advisories ?? []).map((advisory) => ({
      code: advisory.code.trim(),
      message: advisory.message.trim(),
    })).filter((advisory) => advisory.code.length > 0 && advisory.message.length > 0),
    ...(record.budget === undefined ? {} : { budget: structuredClone(record.budget) }),
    ...(record.creationRequest === undefined
      ? {}
      : { creationRequest: structuredClone(record.creationRequest) }),
    ...(record.replacementConfirmation === undefined
      ? {}
      : { replacementConfirmation: structuredClone(record.replacementConfirmation) }),
  };
}

export interface HypagoalReadyWork {
  tasks: string[];
  checks: string[];
  codes: string[];
  effects: string[];
  gates: string[];
  interactions: string[];
  loopEntries: string[];
}

export function hypagoalReadyWork(state: HypagraphState): HypagoalReadyWork {
  const ready = state.definition.nodes.filter((node) => state.runtime.nodes[node.id]?.status === "ready");
  const loopEntries = new Set(state.definition.loops.map((loop) => loop.entry));
  return {
    tasks: ready.filter((node) => (node.kind ?? "task") === "task").map((node) => node.id),
    checks: ready.filter((node) => node.kind === "check").map((node) => node.id),
    codes: ready.filter((node) => node.kind === "code").map((node) => node.id),
    effects: ready.filter((node) => node.kind === "effect").map((node) => node.id),
    gates: ready.filter((node) => node.kind === "gate").map((node) => node.id),
    interactions: ready.filter((node) => node.kind === "interaction").map((node) => node.id),
    loopEntries: ready.filter((node) => loopEntries.has(node.id)).map((node) => node.id),
  };
}

const list = (values: readonly string[]): string => values.length > 0 ? values.join(", ") : "none";

export function renderHypagoalCreated(
  result: Extract<RootHypagoalStartResult, { kind: "created" }>,
): string {
  const state = result.state;
  const ready = hypagoalReadyWork(state);
  const advisories = result.advisories.length === 0
    ? "none"
    : result.advisories.map((item) => `${item.code}: ${item.message}`).join("\n  - ");
  return [
    "Hypagoal created.",
    `Objective: ${state.definition.goal}`,
    `Workflow ID: ${state.workflowId}`,
    `Goal ID: ${state.goal?.goalId ?? "none"}`,
    `Workflow revision: ${state.revision}`,
    `Goal control: ${state.goal?.status ?? "none"}`,
    `Turn budget: ${state.goal?.budget.limits.maximumTurns ?? "none"}; used ${state.goal?.budget.consumedTurns ?? 0}`,
    `Token budget: ${state.goal?.budget.limits.maximumTokens ?? "none"}; used ${state.goal?.budget.consumedTokens.totalTokens ?? 0}`,
    `Ready tasks: ${list(ready.tasks)}`,
    `Ready checks: ${list(ready.checks)}`,
    `Ready code nodes: ${list(ready.codes)}`,
    `Ready effect nodes: ${list(ready.effects)}`,
    `Ready gates: ${list(ready.gates)}`,
    `Ready interactions: ${list(ready.interactions)}`,
    `Ready loop entries: ${list(ready.loopEntries)}`,
    `Authoring advisories: ${advisories === "none" ? advisories : `\n  - ${advisories}`}`,
    "The graph-backed goal is durable. Autonomous continuation has not started.",
  ].join("\n");
}

export function renderReplacementRequired(current: RootCanonicalIdentity): string {
  return [
    "Root replacement requires explicit confirmation.",
    `Current objective: ${current.objective}`,
    `Current workflow ID: ${current.workflowId}`,
    `Current goal ID: ${current.goalId ?? "none"}`,
    `Current workflow revision: ${current.workflowRevision}`,
    `Current event sequence: ${current.eventSequence}`,
    `Current workflow phase: ${current.workflowPhase}`,
    `Current goal control: ${current.goalStatus ?? "none"}`,
    "Read the current root and submit the exact typed replacement confirmation.",
  ].join("\n");
}

export function buildHypagoalAuthoringPrompt(
  objective: string,
  creationRequest: HypagoalCreationRequest,
  replacementConfirmation?: RootReplacementConfirmation,
): string {
  const confirmation = replacementConfirmation === undefined
    ? "No replacement confirmation is present."
    : `Use this exact replacement confirmation without changing any field:\n${JSON.stringify(replacementConfirmation, null, 2)}`;
  return [
    "Create one root Hypagoal from the following ordinary prose objective.",
    `Preserve this objective exactly in HypagraphDefinition.goal: ${JSON.stringify(objective)}`,
    "Inspect the relevant repository files, documentation, package scripts, and current implementation before you author the graph.",
    "Compile the smallest useful canonical Hypagraph workflow for this objective.",
    "Prefer construction tools and recipes. Do not hand-author feedbackEdges.",
    [
      "AUTHORING ORDER:",
      "1. Call hypagraph_draft_begin with this objective and the exact creationRequest when present.",
      "2. Prefer hypagraph_recipe_implement_parallel_review when the work needs implement then parallel multi-agent review with ordinary multi-child join.",
      "3. Prefer hypagraph_recipe_implement_verify_loop when the work is single-agent implement then verify in a loop.",
      "4. Otherwise use hypagraph_add_task, hypagraph_add_check, hypagraph_require, and hypagraph_loop.",
      "5. hypagraph_loop owns feedback edges. It adds entry.requires including evaluateAfter.",
      "6. Call hypagraph_draft_validate.",
      "7. Call hypagoal_start with draftId (preferred) and the exact creationRequest.",
      "8. Free-form definition is only for advanced import or tests.",
    ].join("\n"),
    "Use typed tasks, checks, and gates only when the repository evidence justifies them.",
    "Use a bounded iteration region only when repetition is justified.",
    "Keep independent top-level components independent when the work requires them.",
    "Add a progress metric only when a deterministic and defensible metric exists.",
    "Set a Hypagoal token or turn budget only when the user objective explicitly supplies one. Do not invent a budget.",
    "Do not invent tests, acceptance criteria, commands, metrics, trust claims, or evaluation contracts.",
    "Return uncertain or useful authoring notes through the advisories field. Do not put advisories into canonical definition fields.",
    `Use this exact creation request identity without changing any field:\n${JSON.stringify(creationRequest, null, 2)}`,
    "Call hypagoal_start one time with the preserved objective, draftId from the open draft, and exact creationRequest.",
    "If hypagoal_start returns diagnostics, repair the draft with tools, validate, and call hypagoal_start again with the same creationRequest and draftId.",
    confirmation,
    "Do not perform semantic implementation work after creation. The creation tool ends this authoring turn and does not start autonomous continuation.",
  ].join("\n\n");
}
