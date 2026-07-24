import { Type, type Static } from "typebox";
import type { HypagraphState } from "../domain/model.js";
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

const advisorySchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
});

export const hypagoalStartSchema = Type.Object({
  objective: Type.String({ minLength: 1 }),
  definition: definitionSchema,
  advisories: Type.Optional(Type.Array(advisorySchema)),
  replacementConfirmation: Type.Optional(replacementConfirmationSchema),
});

export type HypagoalStartInput = Static<typeof hypagoalStartSchema>;

export interface NormalizedHypagoalStartInput {
  objective: string;
  definition: ReturnType<typeof normalizeDefinition>;
  advisories: HypagoalAuthoringAdvisory[];
  replacementConfirmation?: RootReplacementConfirmation;
}

export function normalizeHypagoalStartInput(input: HypagoalStartInput): NormalizedHypagoalStartInput {
  return {
    objective: input.objective,
    definition: normalizeDefinition(input.definition),
    advisories: (input.advisories ?? []).map((advisory) => ({
      code: advisory.code.trim(),
      message: advisory.message.trim(),
    })).filter((advisory) => advisory.code.length > 0 && advisory.message.length > 0),
    ...(input.replacementConfirmation === undefined
      ? {}
      : { replacementConfirmation: structuredClone(input.replacementConfirmation) }),
  };
}

export interface HypagoalReadyWork {
  tasks: string[];
  checks: string[];
  gates: string[];
  loopEntries: string[];
}

export function hypagoalReadyWork(state: HypagraphState): HypagoalReadyWork {
  const ready = state.definition.nodes.filter((node) => state.runtime.nodes[node.id]?.status === "ready");
  const loopEntries = new Set(state.definition.loops.map((loop) => loop.entry));
  return {
    tasks: ready.filter((node) => (node.kind ?? "task") === "task").map((node) => node.id),
    checks: ready.filter((node) => node.kind === "check").map((node) => node.id),
    gates: ready.filter((node) => node.kind === "gate").map((node) => node.id),
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
    `Ready tasks: ${list(ready.tasks)}`,
    `Ready checks: ${list(ready.checks)}`,
    `Ready gates: ${list(ready.gates)}`,
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
    "Use typed tasks, checks, and gates only when the repository evidence justifies them.",
    "Use a generic bounded iteration region only when repetition is justified. Repair is one possible loop pattern and is not the default loop meaning.",
    "Keep independent top-level components independent when the work requires them.",
    "Add a progress metric only when a deterministic and defensible metric exists.",
    "Do not invent tests, acceptance criteria, commands, metrics, trust claims, or evaluation contracts.",
    "Return uncertain or useful authoring notes through the advisories field. Do not put advisories into canonical definition fields.",
    "Call hypagoal_start one time with the preserved objective and the complete validated definition.",
    confirmation,
    "Do not perform semantic implementation work after creation. The creation tool ends this authoring turn and does not start autonomous continuation.",
  ].join("\n\n");
}
