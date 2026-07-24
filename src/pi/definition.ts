import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { CheckRetryPolicy, HypagraphDefinition, ReportCheckDefinition } from "../domain/model.js";
import { canonicalProtectedPath } from "../domain/integrity-policy.js";

const factTypeSchema = Type.Union([
  Type.Literal("boolean"),
  Type.Literal("integer"),
  Type.Literal("number"),
  Type.Literal("string"),
  Type.Literal("duration"),
  Type.Literal("timestamp"),
  Type.Literal("string-list"),
]);
const factValueSchema = Type.Union([Type.Boolean(), Type.Number(), Type.String(), Type.Array(Type.String())]);
const conditionSchema = Type.Any({ description: "A Hypagraph typed condition AST. The domain validator checks its recursive structure, fact references, types, and limits." });
const checkFactSourceSchema = Type.Union([Type.Literal("passed"), Type.Literal("status"), Type.Literal("exitCode"), Type.Literal("durationMs"), Type.Literal("timedOut"), Type.Literal("cancelled")]);
const retryStatusSchema = Type.Union([Type.Literal("failed"), Type.Literal("timed_out"), Type.Literal("error")]);
const metricScalarTypeSchema = Type.Union([
  Type.Literal("boolean"),
  Type.Literal("integer"),
  Type.Literal("number"),
  Type.Literal("string"),
]);

const factContractSchema = Type.Object({ name: Type.String(), type: factTypeSchema, required: Type.Optional(Type.Boolean()) });
const gateSchema = Type.Object({ condition: conditionSchema, onTrue: Type.Array(Type.String(), { minItems: 1 }), onFalse: Type.Array(Type.String(), { minItems: 1 }) });
const factMappingSchema = Type.Object({ source: checkFactSourceSchema, fact: Type.String() });
const metricMappingSchema = Type.Object({
  source: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]*(?:\\.[A-Za-z][A-Za-z0-9_-]*)*$" }),
  fact: Type.String(),
  type: metricScalarTypeSchema,
  required: Type.Optional(Type.Boolean()),
});
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
const evaluationFeedbackSchema = Type.Union([
  Type.Object({ mode: Type.Literal("aggregate"), exposeRawReport: Type.Optional(Type.Boolean()) }),
  Type.Object({ mode: Type.Literal("bounded-diagnostics"), maximumDiagnosticItems: Type.Integer({ minimum: 1, maximum: 100 }), exposeRawReport: Type.Optional(Type.Boolean()) }),
]);
const evaluatorTrustLevelSchema = Type.Union([
  Type.Literal("transparent"),
  Type.Literal("protected"),
  Type.Literal("isolated"),
]);
const evaluationIntegritySchema = Type.Object({
  trustLevel: evaluatorTrustLevelSchema,
  protectedPaths: Type.Optional(Type.Array(Type.Object({
    path: Type.String(),
    sha256: Type.String(),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_777_216 })),
  }), { uniqueItems: true })),
  git: Type.Optional(Type.Object({
    expectedRevision: Type.Optional(Type.String()),
    requireCleanWorktree: Type.Optional(Type.Literal(true)),
    protectedPathsUnchangedFrom: Type.Optional(Type.String()),
  })),
  evaluatorVersion: Type.Optional(Type.Object({
    value: Type.String({ minLength: 1, maxLength: 128 }),
    fact: Type.Optional(Type.String()),
  })),
});
const metricEvaluationSchema = Type.Object({
  kind: Type.Union([Type.Literal("development"), Type.Literal("probe"), Type.Literal("holdout")]),
  feedback: evaluationFeedbackSchema,
  integrity: Type.Optional(evaluationIntegritySchema),
});
const metricReportCheckSchema = Type.Object({
  kind: Type.Literal("metric-report"),
  ...commandFields,
  reportPath: Type.String(),
  parser: Type.Object({ name: Type.Literal("metric-json"), version: Type.Literal(1) }),
  mappings: Type.Array(metricMappingSchema, { minItems: 1 }),
  maxReportBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_777_216 })),
  evaluation: Type.Optional(metricEvaluationSchema),
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
  Type.Object({ kind: Type.Literal("exact-revision"), sha: Type.String({ pattern: "^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$" }) }),
  Type.Object({
    kind: Type.Literal("unchanged-paths"),
    paths: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
    baseRevision: Type.String({ pattern: "^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$" }),
  }),
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
  metricReportCheckSchema,
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
const loopEvaluationSchema = Type.Object({
  validWhen: conditionSchema,
  maximumInvalidEvaluations: Type.Integer({ minimum: 1, maximum: 1000 }),
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
  evaluation: Type.Optional(loopEvaluationSchema),
  failurePolicy: Type.Optional(StringEnum(["fail-workflow", "block-dependants", "record-and-continue"] as const)),
});

const evaluationBudgetSchema = Type.Object({
  maximumEvaluations: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  maximumDevelopmentEvaluations: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  maximumProbeEvaluations: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  maximumHoldoutEvaluations: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
});
const workflowEvaluationSchema = Type.Object({ budget: evaluationBudgetSchema });

export const definitionSchema = Type.Object({
  title: Type.String(),
  goal: Type.String(),
  nodes: Type.Array(nodeSchema, { minItems: 1 }),
  loops: Type.Optional(Type.Array(loopSchema)),
  evaluation: Type.Optional(workflowEvaluationSchema),
  policy: Type.Optional(Type.Object({ mode: Type.Optional(StringEnum(["guided", "strict"] as const)), requireEvidence: Type.Optional(Type.Boolean()) })),
});

export const evidenceSchema = Type.Object({
  ref: Type.String({ description: "Tool call, command, file, approval, or event reference" }),
  kind: Type.Optional(Type.Union([Type.Literal("tool"), Type.Literal("command"), Type.Literal("file"), Type.Literal("approval"), Type.Literal("note")])),
  summary: Type.Optional(Type.String()),
  visibility: Type.Optional(Type.Union([Type.Literal("public"), Type.Literal("protected")])),
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
              : node.check.kind === "metric-report"
                ? {
                  kind: "metric-report" as const,
                  command: node.check.command,
                  ...(node.check.arguments === undefined ? {} : { arguments: [...node.check.arguments] }),
                  ...(node.check.workingDirectory === undefined ? {} : { workingDirectory: node.check.workingDirectory }),
                  timeoutMs: node.check.timeoutMs,
                  ...(node.check.expectedExitCodes === undefined ? {} : { expectedExitCodes: [...node.check.expectedExitCodes] }),
                  ...(node.check.environmentVariables === undefined ? {} : { environmentVariables: [...node.check.environmentVariables] }),
                  ...normalizeRetry(node.check.retry),
                  reportPath: node.check.reportPath,
                  parser: { name: "metric-json" as const, version: 1 as const },
                  mappings: node.check.mappings.map((mapping) => ({ ...mapping })),
                  ...(node.check.maxReportBytes === undefined ? {} : { maxReportBytes: node.check.maxReportBytes }),
                  ...(node.check.evaluation === undefined ? {} : {
                    evaluation: {
                      kind: node.check.evaluation.kind,
                      feedback: structuredClone(node.check.evaluation.feedback),
                      ...(node.check.evaluation.integrity === undefined ? {} : {
                        integrity: {
                          trustLevel: node.check.evaluation.integrity.trustLevel,
                          ...(node.check.evaluation.integrity.protectedPaths === undefined ? {} : {
                            protectedPaths: node.check.evaluation.integrity.protectedPaths.map((item) => ({
                              path: canonicalProtectedPath(item.path) ?? item.path,
                              sha256: item.sha256.toLowerCase(),
                              ...(item.maxBytes === undefined ? {} : { maxBytes: item.maxBytes }),
                            })),
                          }),
                          ...(node.check.evaluation.integrity.git === undefined ? {} : {
                            git: {
                              ...(node.check.evaluation.integrity.git.expectedRevision === undefined ? {} : { expectedRevision: node.check.evaluation.integrity.git.expectedRevision.toLowerCase() }),
                              ...(node.check.evaluation.integrity.git.requireCleanWorktree === undefined ? {} : { requireCleanWorktree: node.check.evaluation.integrity.git.requireCleanWorktree }),
                              ...(node.check.evaluation.integrity.git.protectedPathsUnchangedFrom === undefined ? {} : { protectedPathsUnchangedFrom: node.check.evaluation.integrity.git.protectedPathsUnchangedFrom.toLowerCase() }),
                            },
                          }),
                          ...(node.check.evaluation.integrity.evaluatorVersion === undefined ? {} : {
                            evaluatorVersion: {
                              value: node.check.evaluation.integrity.evaluatorVersion.value.trim(),
                              ...(node.check.evaluation.integrity.evaluatorVersion.fact === undefined ? {} : { fact: node.check.evaluation.integrity.evaluatorVersion.fact }),
                            },
                          }),
                        },
                      }),
                    },
                  }),
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
      ...(loop.evaluation === undefined ? {} : { evaluation: { validWhen: structuredClone(loop.evaluation.validWhen), maximumInvalidEvaluations: loop.evaluation.maximumInvalidEvaluations } }),
      ...(loop.failurePolicy === undefined ? {} : { failurePolicy: loop.failurePolicy }),
    })),
    ...(input.evaluation === undefined ? {} : { evaluation: { budget: { ...input.evaluation.budget } } }),
    policy: { mode: input.policy?.mode ?? "guided", requireEvidence: input.policy?.requireEvidence ?? true },
  };
}
