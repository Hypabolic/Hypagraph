import { readFile, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type {
  CheckExecutionRequest,
  CheckExecutor,
  CheckResult,
  EvaluationDiagnostic,
  EvidenceReference,
  FactInput,
  MetricReportCheckDefinition,
  ReportCheckDefinition,
} from "../domain/model.js";
import type { CheckArtifactStore } from "./artifacts.js";
import { CommandCheckExecutor } from "./command-executor.js";
import { evaluateEvaluationIntegrity } from "./evaluation-integrity.js";
import { parseReport } from "./report-parser-registry.js";

const DEFAULT_MAX_REPORT_BYTES = 1_048_576;
const validNamespace = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$/;

type ExecutableReportCheckDefinition = ReportCheckDefinition | MetricReportCheckDefinition;

export interface ReportCheckExecutorOptions {
  rootDirectory: string;
  artifactStore: CheckArtifactStore;
  producerExecutor?: CheckExecutor;
  now?: () => Date;
}

const publicSegment = (segment: string): string => segment
  .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
  .replace(/_/g, "-")
  .toLowerCase();

const publicPath = (path: string): string => path.split(".").map(publicSegment).join(".");

const reportFactName = (fact: FactInput, definition: ExecutableReportCheckDefinition): string => {
  if (definition.kind === "metric-report") return fact.name;
  const namespace = definition.namespace;
  if (fact.name === "passed") return `${namespace}.success`;
  if (definition.kind === "test-report" && fact.name.startsWith("tests.")) {
    return `${namespace}.${publicPath(fact.name.slice("tests.".length))}`;
  }
  if (definition.kind === "test-report" && fact.name.startsWith("testSuites.")) {
    return `${namespace}.suites.${publicPath(fact.name.slice("testSuites.".length))}`;
  }
  if (fact.name.startsWith(`${namespace}.`)) {
    return `${namespace}.${publicPath(fact.name.slice(namespace.length + 1))}`;
  }
  return `${namespace}.${publicPath(fact.name)}`;
};

const resolveReportPath = (rootDirectory: string, definition: ExecutableReportCheckDefinition): string => {
  const root = resolve(rootDirectory);
  const workingDirectory = resolve(root, definition.workingDirectory ?? ".");
  const target = resolve(workingDirectory, definition.reportPath);
  const local = relative(root, target);
  if (local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("The report path is outside the configured workspace root.");
  }
  return target;
};

const protectsOutput = (definition: ExecutableReportCheckDefinition): boolean => (
  definition.kind === "metric-report"
  && definition.evaluation !== undefined
  && definition.evaluation.feedback.exposeRawReport !== true
);

const evaluationSummary = (
  definition: ExecutableReportCheckDefinition,
  diagnostics: readonly EvaluationDiagnostic[] = [],
  diagnosticsTruncated = false,
): CheckResult["evaluation"] => definition.kind === "metric-report" && definition.evaluation
  ? {
      kind: definition.evaluation.kind,
      feedbackMode: definition.evaluation.feedback.mode,
      diagnostics: diagnostics.map((item) => ({ ...item })),
      diagnosticsTruncated,
    }
  : undefined;

const protectEvidence = (evidence: readonly EvidenceReference[], protectedOutput: boolean): EvidenceReference[] => evidence.map((item) => ({
  ...structuredClone(item),
  ...(protectedOutput ? { visibility: "protected" as const } : {}),
}));

const filteredSource = (
  source: CheckResult,
  definition: ExecutableReportCheckDefinition,
): CheckResult => {
  const protectedOutput = protectsOutput(definition);
  const result: CheckResult = {
    ...structuredClone(source),
    checkKind: definition.kind,
    facts: [],
    evidence: protectEvidence(source.evidence, protectedOutput),
    ...(evaluationSummary(definition) === undefined ? {} : { evaluation: evaluationSummary(definition)! }),
  };
  if (protectedOutput) {
    delete result.stdoutRef;
    delete result.stderrRef;
  }
  return result;
};

const errorResult = (
  definition: ExecutableReportCheckDefinition,
  request: CheckExecutionRequest,
  source: CheckResult,
  completedAt: string,
  message: string,
): CheckResult => ({
  ...filteredSource(source, definition),
  attemptId: request.attemptId,
  startedAt: source.startedAt,
  completedAt,
  status: "error",
  error: message,
});

export class ReportCheckExecutor implements CheckExecutor {
  private readonly rootDirectory: string;
  private readonly artifactStore: CheckArtifactStore;
  private readonly producerExecutor: CheckExecutor;
  private readonly now: () => Date;

  constructor(options: ReportCheckExecutorOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.artifactStore = options.artifactStore;
    this.producerExecutor = options.producerExecutor ?? new CommandCheckExecutor({
      rootDirectory: this.rootDirectory,
      artifactStore: this.artifactStore,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.now = options.now ?? (() => new Date());
  }

  private async applyEvaluationIntegrity(
    definition: ExecutableReportCheckDefinition,
    result: CheckResult,
    publishVersionFact = false,
  ): Promise<CheckResult> {
    const integrity = definition.kind === "metric-report" ? definition.evaluation?.integrity : undefined;
    if (!integrity) return result;
    const evaluated = await evaluateEvaluationIntegrity(this.rootDirectory, integrity);
    const next = structuredClone(result);
    next.evaluation ??= evaluationSummary(definition)!;
    next.evaluation.integrity = structuredClone(evaluated.observation);
    next.evidence.push(...structuredClone(evaluated.evidence));
    if (publishVersionFact && evaluated.versionFact) next.facts.push(structuredClone(evaluated.versionFact));
    return next;
  }

  async execute(request: CheckExecutionRequest, signal: AbortSignal): Promise<CheckResult> {
    if (request.definition.kind === "command") {
      return this.producerExecutor.execute(request, signal);
    }
    if (request.definition.kind !== "test-report"
      && request.definition.kind !== "lint-report"
      && request.definition.kind !== "coverage-report"
      && request.definition.kind !== "metric-report") {
      throw new Error(`The report executor cannot run check kind '${request.definition.kind}'.`);
    }

    const definition = request.definition;
    if (definition.kind !== "metric-report" && !validNamespace.test(definition.namespace)) {
      return {
        checkKind: definition.kind,
        attemptId: request.attemptId,
        startedAt: request.requestedAt,
        completedAt: this.now().toISOString(),
        status: "error",
        facts: [],
        evidence: [],
        error: "The report fact namespace is invalid.",
      };
    }

    const producerRequest: CheckExecutionRequest = {
      ...structuredClone(request),
      definition: {
        kind: "command",
        command: definition.command,
        ...(definition.arguments === undefined ? {} : { arguments: [...definition.arguments] }),
        ...(definition.workingDirectory === undefined ? {} : { workingDirectory: definition.workingDirectory }),
        timeoutMs: definition.timeoutMs,
        ...(definition.expectedExitCodes === undefined ? {} : { expectedExitCodes: [...definition.expectedExitCodes] }),
        ...(definition.environmentVariables === undefined ? {} : { environmentVariables: [...definition.environmentVariables] }),
        ...(definition.retry === undefined ? {} : { retry: structuredClone(definition.retry) }),
        publish: [],
      },
    };

    const producer = await this.producerExecutor.execute(producerRequest, signal);
    if (producer.status === "timed_out" || producer.status === "cancelled" || producer.status === "interrupted" || producer.status === "error") {
      return this.applyEvaluationIntegrity(definition, filteredSource(producer, definition));
    }

    let reportPath: string;
    try {
      reportPath = resolveReportPath(this.rootDirectory, definition);
    } catch (error) {
      return this.applyEvaluationIntegrity(definition, errorResult(definition, request, producer, this.now().toISOString(), error instanceof Error ? error.message : String(error)));
    }

    const maxReportBytes = definition.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
    try {
      const metadata = await stat(reportPath);
      if (!metadata.isFile()) throw new Error("The declared report path is not a file.");
      if (metadata.size > maxReportBytes) throw new Error("The report exceeds the maximum read size.");
    } catch (error) {
      return this.applyEvaluationIntegrity(definition, errorResult(definition, request, producer, this.now().toISOString(), error instanceof Error ? error.message : String(error)));
    }

    let reportBytes: Uint8Array;
    let reportText: string;
    try {
      reportBytes = new Uint8Array(await readFile(reportPath));
      reportText = new TextDecoder("utf-8", { fatal: true }).decode(reportBytes);
    } catch (error) {
      return this.applyEvaluationIntegrity(definition, errorResult(definition, request, producer, this.now().toISOString(), error instanceof Error ? error.message : String(error)));
    }

    const protectedOutput = protectsOutput(definition);
    const reportRef = await this.artifactStore.write({
      workflowId: request.workflowId,
      nodeId: request.nodeId,
      attemptId: request.attemptId,
      name: basename(reportPath),
      mediaType: "application/json; charset=utf-8",
      content: reportBytes,
    });
    const evidence: EvidenceReference[] = [
      ...protectEvidence(producer.evidence, protectedOutput),
      {
        ref: reportRef,
        kind: "file",
        summary: `${definition.parser.name} report.`,
        ...(protectedOutput ? { visibility: "protected" as const } : {}),
      },
    ];

    const parsed = parseReport(
      definition.parser.name,
      definition.parser.version,
      reportText,
      definition.kind === "metric-report"
        ? { metricMappings: definition.mappings, ...(definition.evaluation === undefined ? {} : { metricFeedback: definition.evaluation.feedback }) }
        : {},
    );
    if (!parsed.ok) {
      return this.applyEvaluationIntegrity(definition, errorResult(
        definition,
        request,
        { ...producer, evidence },
        this.now().toISOString(),
        parsed.diagnostics.map((diagnostic) => diagnostic.message).join(" "),
      ));
    }

    const publicEvidence = evidence.filter((item) => item.visibility !== "protected");
    const facts = parsed.value.facts.map((fact) => ({
      ...structuredClone(fact),
      name: reportFactName(fact, definition),
      evidence: structuredClone(publicEvidence),
    }));
    const names = facts.map((fact) => fact.name);
    if (new Set(names).size !== names.length) {
      return errorResult(definition, request, { ...producer, evidence }, this.now().toISOString(), "The report parser produced duplicate public fact names.");
    }

    const result: CheckResult = {
      ...structuredClone(producer),
      checkKind: definition.kind,
      facts,
      evidence,
      ...(evaluationSummary(definition, parsed.value.diagnostics, parsed.value.diagnosticsTruncated) === undefined
        ? {}
        : { evaluation: evaluationSummary(definition, parsed.value.diagnostics, parsed.value.diagnosticsTruncated)! }),
    };
    if (protectedOutput) {
      delete result.stdoutRef;
      delete result.stderrRef;
    }
    return this.applyEvaluationIntegrity(definition, result, true);
  }
}
