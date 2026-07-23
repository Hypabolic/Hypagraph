import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { HypagraphDefinition } from "../domain/model.js";

const factTypeSchema = StringEnum(["boolean", "integer", "number", "string", "duration", "timestamp", "string-list"] as const);
const factValueSchema = Type.Union([Type.Boolean(), Type.Number(), Type.String(), Type.Array(Type.String())]);
const conditionSchema = Type.Any({ description: "A Hypagraph typed condition AST. The domain validator checks its recursive structure, fact references, types, and limits." });
const checkFactSourceSchema = StringEnum(["passed", "status", "exitCode", "durationMs", "timedOut", "cancelled"] as const);
const retryStatusSchema = StringEnum(["failed", "timed_out", "error"] as const);

const factContractSchema = Type.Object({
  name: Type.String(),
  type: factTypeSchema,
  required: Type.Optional(Type.Boolean()),
});

const gateSchema = Type.Object({
  condition: conditionSchema,
  onTrue: Type.Array(Type.String(), { minItems: 1 }),
  onFalse: Type.Array(Type.String(), { minItems: 1 }),
});

const factMappingSchema = Type.Object({
  source: checkFactSourceSchema,
  fact: Type.String(),
});

const retrySchema = Type.Object({
  maxAttempts: Type.Integer({ minimum: 2, maximum: 20 }),
  retryOn: Type.Array(retryStatusSchema, { minItems: 1, uniqueItems: true }),
  backoffMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400_000 })),
});

const commandCheckSchema = Type.Object({
  kind: StringEnum(["command"] as const),
  command: Type.String(),
  arguments: Type.Optional(Type.Array(Type.String())),
  workingDirectory: Type.Optional(Type.String()),
  timeoutMs: Type.Integer({ minimum: 1 }),
  expectedExitCodes: Type.Optional(Type.Array(Type.Integer())),
  environmentVariables: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), { uniqueItems: true })),
  retry: Type.Optional(retrySchema),
  publish: Type.Array(factMappingSchema),
});

const nodeSchema = Type.Object({
  id: Type.String({ description: "Stable lowercase node ID" }),
  title: Type.String(),
  description: Type.Optional(Type.String()),
  kind: Type.Optional(StringEnum(["task", "gate", "check"] as const)),
  requires: Type.Optional(Type.Array(Type.String())),
  acceptance: Type.Optional(Type.Array(Type.String())),
  produces: Type.Optional(Type.Array(factContractSchema)),
  gate: Type.Optional(gateSchema),
  check: Type.Optional(commandCheckSchema),
  scope: Type.Optional(Type.Object({ paths: Type.Array(Type.String()) })),
});

const feedbackEdgeSchema = Type.Object({ from: Type.String(), to: Type.String() });
const loopProgressSchema = Type.Object({
  fact: Type.String(),
  direction: StringEnum(["minimize", "maximize"] as const),
  minDelta: Type.Optional(Type.Number({ minimum: 0 })),
});
const loopSchema = Type.Object({
  id: Type.String(),
  nodes: Type.Array(Type.String()),
  entry: Type.String(),
  evaluateAfter: Type.String(),
  feedbackEdges: Type.Array(feedbackEdgeSchema, { minItems: 1 }),
  successWhen: conditionSchema,
  maxIterations: Type.Integer({ minimum: 1 }),
  progress: Type.Optional(loopProgressSchema),
  patience: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const definitionSchema = Type.Object({
  title: Type.String(),
  goal: Type.String(),
  nodes: Type.Array(nodeSchema, { minItems: 1 }),
  loops: Type.Optional(Type.Array(loopSchema)),
  policy: Type.Optional(Type.Object({
    mode: Type.Optional(StringEnum(["guided", "strict"] as const)),
    requireEvidence: Type.Optional(Type.Boolean()),
  })),
});

export const evidenceSchema = Type.Object({
  ref: Type.String({ description: "Tool call, command, file, approval, or event reference" }),
  kind: Type.Optional(StringEnum(["tool", "command", "file", "approval", "note"] as const)),
  summary: Type.Optional(Type.String()),
});

export const factInputSchema = Type.Object({
  name: Type.String(),
  type: factTypeSchema,
  value: factValueSchema,
  evidence: Type.Optional(Type.Array(evidenceSchema)),
});

export type HypagraphDefineInput = Static<typeof definitionSchema>;

export function normalizeDefinition(input: HypagraphDefineInput): HypagraphDefinition {
  return {
    title: input.title.trim(),
    goal: input.goal.trim(),
    nodes: input.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      ...(node.description === undefined ? {} : { description: node.description }),
      ...(node.kind === undefined ? {} : { kind: node.kind }),
      requires: [...(node.requires ?? [])],
      acceptance: [...(node.acceptance ?? [])],
      ...(node.produces === undefined ? {} : { produces: node.produces.map((fact) => ({ ...fact })) }),
      ...(node.gate === undefined ? {} : { gate: structuredClone(node.gate) }),
      ...(node.check === undefined ? {} : {
        check: {
          kind: "command" as const,
          command: node.check.command,
          ...(node.check.arguments === undefined ? {} : { arguments: [...node.check.arguments] }),
          ...(node.check.workingDirectory === undefined ? {} : { workingDirectory: node.check.workingDirectory }),
          timeoutMs: node.check.timeoutMs,
          ...(node.check.expectedExitCodes === undefined ? {} : { expectedExitCodes: [...node.check.expectedExitCodes] }),
          ...(node.check.environmentVariables === undefined ? {} : { environmentVariables: [...node.check.environmentVariables] }),
          ...(node.check.retry === undefined ? {} : {
            retry: {
              maxAttempts: node.check.retry.maxAttempts,
              retryOn: [...node.check.retry.retryOn],
              ...(node.check.retry.backoffMs === undefined ? {} : { backoffMs: node.check.retry.backoffMs }),
            },
          }),
          publish: node.check.publish.map((mapping) => ({ ...mapping })),
        },
      }),
      ...(node.scope === undefined ? {} : { scope: { paths: [...node.scope.paths] } }),
    })),
    loops: (input.loops ?? []).map((loop) => ({
      id: loop.id,
      nodes: [...loop.nodes],
      entry: loop.entry,
      evaluateAfter: loop.evaluateAfter,
      feedbackEdges: loop.feedbackEdges.map((edge) => ({ ...edge })),
      successWhen: structuredClone(loop.successWhen),
      maxIterations: loop.maxIterations,
      ...(loop.progress === undefined ? {} : { progress: { ...loop.progress } }),
      ...(loop.patience === undefined ? {} : { patience: loop.patience }),
    })),
    policy: { mode: input.policy?.mode ?? "guided", requireEvidence: input.policy?.requireEvidence ?? true },
  };
}
