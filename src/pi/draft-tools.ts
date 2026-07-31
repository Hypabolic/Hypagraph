/**
 * Pi tool schemas and render helpers for draft authoring (Wave 7).
 */

import { Type, type Static } from "typebox";
import type { Diagnostic } from "../domain/model.js";
import type { DraftSummary, HypagraphDraftRecord } from "../domain/draft.js";
import { projectDraftDefinition, summarizeDraft } from "../domain/draft.js";
import {
  renderHypagraphValidation,
  validateHypagraphDefinition,
  type HypagraphValidationResult,
} from "./validate-definition.js";
import type { HypagraphDefineInput } from "./definition.js";

const factContractSchema = Type.Object({
  name: Type.String(),
  type: Type.Union([
    Type.Literal("boolean"),
    Type.Literal("integer"),
    Type.Literal("number"),
    Type.Literal("string"),
    Type.Literal("duration"),
    Type.Literal("timestamp"),
    Type.Literal("string-list"),
  ]),
  required: Type.Optional(Type.Boolean()),
});

const creationRequestSchema = Type.Object({
  operationId: Type.String({ minLength: 1 }),
  sessionGeneration: Type.Integer({ minimum: 0 }),
  branchGeneration: Type.Integer({ minimum: 0 }),
});

export const draftBeginSchema = Type.Object({
  objective: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String()),
  goal: Type.Optional(Type.String()),
  creationRequest: Type.Optional(creationRequestSchema),
});
export type DraftBeginInput = Static<typeof draftBeginSchema>;

export const draftIdSchema = Type.Object({
  draftId: Type.String({ minLength: 1 }),
});
export type DraftIdInput = Static<typeof draftIdSchema>;

export const addTaskSchema = Type.Object({
  draftId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  acceptance: Type.Optional(Type.Array(Type.String())),
  description: Type.Optional(Type.String()),
  produces: Type.Optional(Type.Array(factContractSchema)),
  scopePaths: Type.Optional(Type.Array(Type.String())),
  requires: Type.Optional(Type.Array(Type.String())),
});
export type AddTaskInput = Static<typeof addTaskSchema>;

const commandCheckSchema = Type.Object({
  kind: Type.Literal("command"),
  command: Type.String(),
  arguments: Type.Optional(Type.Array(Type.String())),
  workingDirectory: Type.Optional(Type.String()),
  timeoutMs: Type.Integer({ minimum: 1 }),
  expectedExitCodes: Type.Optional(Type.Array(Type.Integer())),
  publish: Type.Array(Type.Object({
    source: Type.Union([
      Type.Literal("passed"),
      Type.Literal("status"),
      Type.Literal("exitCode"),
      Type.Literal("durationMs"),
      Type.Literal("timedOut"),
      Type.Literal("cancelled"),
    ]),
    fact: Type.String(),
  })),
});

export const addCheckSchema = Type.Object({
  draftId: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  check: commandCheckSchema,
  acceptance: Type.Optional(Type.Array(Type.String())),
  description: Type.Optional(Type.String()),
  produces: Type.Optional(Type.Array(factContractSchema)),
  requires: Type.Optional(Type.Array(Type.String())),
});
export type AddCheckInput = Static<typeof addCheckSchema>;

export const requireSchema = Type.Object({
  draftId: Type.String({ minLength: 1 }),
  from: Type.String({ minLength: 1, description: "Prerequisite node id" }),
  to: Type.String({ minLength: 1, description: "Dependent node id. to.requires will include from." }),
});
export type RequireInput = Static<typeof requireSchema>;

export const loopSchema = Type.Object({
  draftId: Type.String({ minLength: 1 }),
  loopId: Type.String({ minLength: 1 }),
  entry: Type.String({ minLength: 1 }),
  evaluateAfter: Type.String({ minLength: 1 }),
  successWhen: Type.Any({ description: "Typed condition AST for loop success." }),
  maxIterations: Type.Integer({ minimum: 1 }),
  nodes: Type.Optional(Type.Array(Type.String())),
  progress: Type.Optional(Type.Object({
    fact: Type.String(),
    direction: Type.Union([Type.Literal("minimize"), Type.Literal("maximize")]),
    minDelta: Type.Optional(Type.Number({ minimum: 0 })),
  })),
  patience: Type.Optional(Type.Integer({ minimum: 1 })),
  failurePolicy: Type.Optional(Type.Union([
    Type.Literal("fail-workflow"),
    Type.Literal("block-dependants"),
    Type.Literal("record-and-continue"),
  ])),
});
export type LoopToolInput = Static<typeof loopSchema>;

export const implementVerifyRecipeSchema = Type.Object({
  draftId: Type.String({ minLength: 1 }),
  implementId: Type.Optional(Type.String()),
  verifyId: Type.Optional(Type.String()),
  implementTitle: Type.Optional(Type.String()),
  verifyTitle: Type.Optional(Type.String()),
  implementAcceptance: Type.Optional(Type.Array(Type.String())),
  verifyAcceptance: Type.Optional(Type.Array(Type.String())),
  successFactName: Type.Optional(Type.String()),
  maxIterations: Type.Optional(Type.Integer({ minimum: 1 })),
  loopId: Type.Optional(Type.String()),
});
export type ImplementVerifyRecipeInput = Static<typeof implementVerifyRecipeSchema>;

export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map((item) => {
    const location = item.location ? ` at ${item.location}` : "";
    const suggestion = item.suggestion ? ` ${item.suggestion}` : "";
    return `- ${item.code}${location}: ${item.message}${suggestion}`;
  }).join("\n");
}

export function renderDraftSummary(summary: DraftSummary, extraLines: string[] = []): string {
  return [
    `Draft: ${summary.draftId}`,
    `Status: ${summary.status}`,
    `Objective: ${summary.objective}`,
    `Goal: ${summary.goal}`,
    `Nodes (${summary.nodeCount}): ${summary.nodeIds.length > 0 ? summary.nodeIds.join(", ") : "none"}`,
    `Edges: ${summary.edgeCount}`,
    `Loops (${summary.loopCount}): ${summary.loopIds.length > 0 ? summary.loopIds.join(", ") : "none"}`,
    ...extraLines,
  ].join("\n");
}

export function validateDraftProjection(draft: HypagraphDraftRecord): HypagraphValidationResult {
  const projected = projectDraftDefinition(draft);
  if (!projected.ok) {
    return { ok: false, diagnostics: projected.diagnostics };
  }
  // Reuse structural validation. Projected definitions are already domain-shaped.
  // Cast through unknown so TypeBox Static tool input is not required here.
  return validateHypagraphDefinition(projected.definition as unknown as HypagraphDefineInput);
}

export function renderDraftToolResult(input: {
  ok: boolean;
  draft?: HypagraphDraftRecord;
  diagnostics?: readonly Diagnostic[];
  notes?: Array<{ code: string; message: string }>;
  validation?: HypagraphValidationResult;
  headline?: string;
}): { text: string; summary?: DraftSummary } {
  if (!input.ok || !input.draft) {
    const lines = [
      input.headline ?? "Draft tool rejected the change.",
      "Canonical runtime state is unchanged.",
      formatDiagnostics(input.diagnostics ?? []),
    ];
    return { text: lines.filter(Boolean).join("\n") };
  }
  const summary = summarizeDraft(input.draft);
  const noteLines = (input.notes ?? []).map((item) => `- ${item.code}: ${item.message}`);
  const validationLines = input.validation
    ? ["", renderHypagraphValidation(input.validation)]
    : [];
  return {
    text: [
      input.headline ?? "Draft updated.",
      renderDraftSummary(summary),
      ...(noteLines.length > 0 ? ["Notes:", ...noteLines] : []),
      ...validationLines,
    ].join("\n"),
    summary,
  };
}
