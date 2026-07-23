import type {
  CheckExecutionRequest,
  CheckExecutor,
  CheckResult,
  Diagnostic,
  FactInput,
  FileAssertionCheckDefinition,
  GitAssertionCheckDefinition,
} from "../domain/model.js";
import type { CheckArtifactStore } from "./artifacts.js";
import { evaluateFileAssertion } from "./file-assertion.js";
import { evaluateGitAssertion } from "./git-assertion.js";

export interface AssertionCheckExecutorOptions {
  rootDirectory: string;
  artifactStore: CheckArtifactStore;
  now?: () => Date;
}

const kebab = (value: string): string => value
  .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
  .toLowerCase();

const publicFactName = (
  fact: FactInput,
  definition: FileAssertionCheckDefinition | GitAssertionCheckDefinition,
): string => {
  const namespace = definition.namespace;
  const name = fact.name
    .replace(/^fileAssertion\./, "")
    .replace(/^gitAssertion\./, "")
    .replace(/^file\./, "")
    .replace(/^git\./, "");
  if (name === "passed") return `${namespace}.success`;
  return `${namespace}.${name.split(".").map(kebab).join(".")}`;
};

const diagnosticText = (diagnostics: readonly Diagnostic[]): string | undefined => diagnostics.length === 0
  ? undefined
  : diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join(" ");

const isEvaluatorError = (diagnostics: readonly Diagnostic[]): boolean => diagnostics.some((diagnostic) =>
  diagnostic.code.startsWith("invalid_")
  || diagnostic.code === "file_assertion_outside_root"
  || diagnostic.code === "file_assertion_stat_failed"
  || diagnostic.code === "file_assertion_too_large"
  || diagnostic.code === "git_assertion_failed");

export class AssertionCheckExecutor implements CheckExecutor {
  private readonly rootDirectory: string;
  private readonly artifactStore: CheckArtifactStore;
  private readonly now: () => Date;

  constructor(options: AssertionCheckExecutorOptions) {
    this.rootDirectory = options.rootDirectory;
    this.artifactStore = options.artifactStore;
    this.now = options.now ?? (() => new Date());
  }

  async execute(request: CheckExecutionRequest, signal: AbortSignal): Promise<CheckResult> {
    if (request.definition.kind !== "file-assertion" && request.definition.kind !== "git-assertion") {
      throw new Error(`The assertion executor cannot run check kind '${request.definition.kind}'.`);
    }

    const startedAt = this.now().toISOString();
    if (signal.aborted) {
      return {
        checkKind: request.definition.kind,
        attemptId: request.attemptId,
        startedAt,
        completedAt: this.now().toISOString(),
        status: "cancelled",
        facts: [],
        evidence: [],
        error: "The assertion check was cancelled before evaluation.",
      };
    }

    const evaluation = request.definition.kind === "file-assertion"
      ? await evaluateFileAssertion(this.rootDirectory, request.definition.assertion)
      : await evaluateGitAssertion(this.rootDirectory, request.definition.assertion);

    if (signal.aborted) {
      return {
        checkKind: request.definition.kind,
        attemptId: request.attemptId,
        startedAt,
        completedAt: this.now().toISOString(),
        status: "cancelled",
        facts: [],
        evidence: [],
        error: "The assertion check was cancelled.",
      };
    }

    const record = new TextEncoder().encode(JSON.stringify({
      checkKind: request.definition.kind,
      version: request.definition.version,
      assertion: request.definition.assertion,
      evaluation,
    }, null, 2));
    const recordRef = await this.artifactStore.write({
      workflowId: request.workflowId,
      nodeId: request.nodeId,
      attemptId: request.attemptId,
      name: `${request.definition.kind}.json`,
      mediaType: "application/json; charset=utf-8",
      content: record,
    });
    const evidence = [
      ...evaluation.evidence,
      {
        ref: recordRef,
        kind: "file" as const,
        summary: request.definition.kind === "file-assertion"
          ? "Recorded file assertion evaluation."
          : "Recorded fixed-allowlist Git assertion evaluation.",
      },
    ];
    const facts = evaluation.facts.map((fact) => ({
      ...structuredClone(fact),
      name: publicFactName(fact, request.definition),
      evidence: structuredClone(evidence),
    }));
    const names = facts.map((fact) => fact.name);
    if (new Set(names).size !== names.length) {
      return {
        checkKind: request.definition.kind,
        attemptId: request.attemptId,
        startedAt,
        completedAt: this.now().toISOString(),
        status: "error",
        facts: [],
        evidence,
        error: "The assertion evaluator produced duplicate public fact names.",
      };
    }

    const error = diagnosticText(evaluation.diagnostics);
    return {
      checkKind: request.definition.kind,
      attemptId: request.attemptId,
      startedAt,
      completedAt: this.now().toISOString(),
      status: evaluation.passed ? "passed" : isEvaluatorError(evaluation.diagnostics) ? "error" : "failed",
      facts,
      evidence,
      ...(error === undefined ? {} : { error }),
    };
  }
}
