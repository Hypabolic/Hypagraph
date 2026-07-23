import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { CheckRetryPolicy, HypagraphDefinition, ReportCheckDefinition } from "../domain/model.js";

const factTypeSchema = StringEnum(["boolean", "integer", "number", "string", "duration", "timestamp", "string-list"] as const);
const factValueSchema = Type.Union([Type.Boolean(), Type.Number(), Type.String(), Type.Array(Type.String())]);
const conditionSchema = Type.Any({ description: "A Hypagraph typed condition AST. The domain validator checks its recursive structure, fact references, types, and limits." });
const checkFactSourceSchema = StringEnum(["passed", "status", "exitCode", "durationMs", "timedOut", "cancelled"] as const);
const retryStatusSchema = StringEnum(["failed", "timed_out", "error"] as const);

const factContractSchema = Type.Object({ name: Type.String(), type: factTypeSchema, required: Type.Optional(Type.Boolean()) });
const gateSchema = Type.Object({ condition: conditionSchema, onTrue: Type.Array(Type.String(), { minItems: 1 }), onFalse: Type.Array(Type.String(), { minItems: 1 }) });
const factMappingSchema = Type.Object({ source: checkFactSourceSchema, fact: Type.String() });
const retrySchema = Type.Object({
  maxAttempts: Type.Integer({ minimum: 2, maximum: 20 }),
  retryOn: Type.Array(retryStatusSchema, { minItems: 1, uniqueItems: true }),
  backoffMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400_000 })),
});

const commandFields = {
  command: Type.String(),
  arguments: Type.Optional(Type.Array(Type.String())),
  workingDirectory: Type.Optional(Type.String()),
  timeoutMs: Type.Integer({ minimum: 1 }),
  expectedExitCodes: Type.Optional(Type.Array(Type.Integer())),
  environmentVariables: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), { uniqueItems: true })),
  retry: Type.Optional(retrySchema),
};

const commandCheckSchema = Type.Object({ kind: Type.Literal("command"), ...commandFields, publish: Type.Array(factMappingSchema) });
const reportCheckSchema = (kind: ReportCheckDefinition["kind"], parserName: ReportCheckDefinition["parser"]["name"]) => Type.Object({
  kind: Type.Literal(kind),
  ...commandFields,
  reportPath: Type.String(),
  parser: Type.Object({ name: Type.Literal(parserName), version: Type.Literal(1) }),
  namespace: Type.String({ pattern: "^[a-z][a-z0-9_-]*(?:\\.[a-z][a-z0-9_-]*)*$" }),
  maxReportBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_777_216 })),
});

const fileAssertionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("exists"), path: Type.String() }),
  Type.Object({ kind: Type.Literal("absent"), path: Type.String() }),
  Type.Object({ kind: Type.Literal("size"), path: Type.String(), bytes: Type.Integer({ minimum: 0 }) }),
  Type.Object({ kind: Type.Literal("sha256"), path: Type.String(), hash: Type.String({ pattern: "^[A-Fa-f0-9]{64}$" }), maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_777_216 })) }),
  Type.Object({ kind: Type.Literal("text-contains"), path: Type.String(), text: Type.String({ minLength: 1 }), maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_777_216 })) }),
]);

const gitAssertionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("clean") }),
  Type.Object({ kind: Type.Literal("branch"), name: Type.String({ minLength: 1 }) }),
  Type.Object({ kind: Type.Literal("revision"), sha: Type.String({ pattern: "^[A-Fa-f0-9]{7,64}$" }) }),
  Type.Object({
    kind: Type.Literal("changed-paths"),
    paths: Type.Array(Type.String(), { uniqueItems: true }),
    mode: Type.Optional(Type.Union([Type.Literal("exact"), Type.Literal("contains")])),
  }),
]);

const fileAssertionCheckSchema = Type.Object({
  kind: Type.Literal("file-assertion"),
  version: Type.Literal(1),
  assertion: fileAssertionSchema,
  namespace: Type.String({ pattern: "^[a-z][a-z0-9_-]*(?:\\.[a-z][a-z0-9_-]*)*$" }),
  retry: Type.Optional(retrySchema),
});
const gitAssertionCheckSchema = Type.Object({
  kind: Type.Literal("git-assertion"),
  version: Type.Literal(1),
  assertion: gitAssertionSchema,
  namespace: Type.String({ pattern: "^[a-z][a-z0-9_-]*(?:\\.[a-z][a-z0-9_-]*)*$" }),
  retry: Type.Optional(retrySchema),
});

const checkSchema = Type.Union([
  commandCheckSchema,
  reportCheckSchema("test-report", "vitest-json"),
  reportCheckSchema("lint-report", "eslint-json"),
  reportCheckSchema("coverage-report", "istanbul-coverage-summary"),
  fileAssertionCheckSchema,
  gitAssertionCheckSchema,
]);

const nodeSchema = Type.Object({
  id: Type.String({ description: "Stable lowercase node ID" }),
  title: Type.String(),
  description: Type.Optional(Type.String()),
  kind: Type.Optional(StringEnum(["task", "gate", "check"] as const)),
  requires: Type.Optional(Type.Array(Type.String())),
  acceptance: Type.Optional(Type.Array(Type.String())),
  produces: Type.Optional(Type.Array(factContractSchema)),
  gate: Type.Optional(gateSchema),
  check: Type.Optional(checkSchema),
  scope: Type.Optional(Type.Object({ paths: Type.Array(Type.String()) })),
});

const feedbackEdgeSchema = Type.Object({ from: Type.String(), to: Type.String() });
const loopProgressSchema = Type.Object({ fact: Type.String(), direction: StringEnum(["minimize", "maximize"] as const), minDelta: Type.Optional(Type.Number({ minimum: 0 })) });
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
  failurePolicy: Type.Optional(StringEnum(["fail-workflow", "block-dependants", "record-and-continue"] as const)),
});

export const definitionSchema = Type.Object({
  title: Type.String(),
  goal: Type.String(),
  nodes: Type.Array(nodeSchema, { minItems: 1 }),
  loops: Type.Optional(Type.Array(loopSchema)),
  policy: Type.Optional(Type.Object({ mode: Type.Optional(StringEnum(["guided", "strict"] as const)), requireEvidence: Type.Optional(Type.Boolean()) })),
});

export const evidenceSchema = Type.Object({
  ref: Type.String({ description: "Tool call, command, file, approval, or event reference" }),
  kind: Type.Optional(StringEnum(["tool", "command", "file", "approval", "note"] as const)),
  summary: Type.Optional(Type.String()),
});
export const factInputSchema = Type.Object({ name: Type.String(), type: factTypeSchema, value: factValueSchema, evidence: Type.Optional(Type.Array(evidenceSchema)) });
export type HypagraphDefineInput = Static<typeof definitionSchema>;

const normalizeRetry = (retry: CheckRetryPolicy | undefined) => retry === undefined ? {} : {
  retry: {
    maxAttempts: retry.maxAttempts,
    retryOn: [...retry.retryOn],
    ...(retry.backoffMs === undefined ? {} : { backoffMs: retry.backoffMs }),
  },
};

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
        check: node.check.kind === "command"
          ? {
            kind: "command" as const,
            command: node.check.command,
            ...(node.check.arguments === undefined ? {} : { arguments: [...node.check.arguments] }),
            ...(node.check.workingDirectory === undefined ? {} : { workingDirectory: node.check.workingDirectory }),
            timeoutMs: node.check.timeoutMs,
            ...(node.check.expectedExitCodes === undefined ? {} : { expectedExitCodes: [...node.check.expectedExitCodes] }),
            ...(node.check.environmentVariables === undefined ? {} : { environmentVariables: [...node.check.environmentVariables] }),
            ...normalizeRetry(node.check.retry),
            publish: node.check.publish.map((mapping) => ({ ...mapping })),
          }
          : node.check.kind === "file-assertion"
            ? {
              kind: "file-assertion" as const,
              version: 1 as const,
              assertion: structuredClone(node.check.assertion),
              namespace: node.check.namespace,
              ...normalizeRetry(node.check.retry),
            }
            : node.check.kind === "git-assertion"
              ? {
                kind: "git-assertion" as const,
                version: 1 as const,
                assertion: structuredClone(node.check.assertion),
                namespace: node.check.namespace,
                ...normalizeRetry(node.check.retry),
              }
              : {
                kind: node.check.kind,
                command: node.check.command,
                ...(node.check.arguments === undefined ? {} : { arguments: [...node.check.arguments] }),
                ...(node.check.workingDirectory === undefined ? {} : { workingDirectory: node.check.workingDirectory }),
                timeoutMs: node.check.timeoutMs,
                ...(node.check.expectedExitCodes === undefined ? {} : { expectedExitCodes: [...node.check.expectedExitCodes] }),
                ...(node.check.environmentVariables === undefined ? {} : { environmentVariables: [...node.check.environmentVariables] }),
                ...normalizeRetry(node.check.retry),
                reportPath: node.check.reportPath,
                parser: { ...node.check.parser },
                namespace: node.check.namespace,
                ...(node.check.maxReportBytes === undefined ? {} : { maxReportBytes: node.check.maxReportBytes }),
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
      ...(loop.failurePolicy === undefined ? {} : { failurePolicy: loop.failurePolicy }),
    })),
    policy: { mode: input.policy?.mode ?? "guided", requireEvidence: input.policy?.requireEvidence ?? true },
  };
}
