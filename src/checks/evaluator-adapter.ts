import { readFile, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type {
  CheckExecutionRequest,
  CheckExecutor,
  CheckResult,
  EvaluatorTrustLevel,
  MetricReportCheckDefinition,
} from "../domain/model.js";

export const LOCAL_COMMAND_REPORT_EVALUATOR_ADAPTER = "local-command-report" as const;
export const LOCAL_COMMAND_REPORT_EVALUATOR_ADAPTER_VERSION = 1 as const;

export interface EvaluatorAdapterRequest {
  profile: string;
  workflowId: string;
  revision: number;
  nodeId: string;
  attemptId: string;
  requestedAt: string;
  definition: MetricReportCheckDefinition;
}

export interface EvaluatorAdapterTrustEvidence {
  adapterId: string;
  adapterVersion: number;
  profile: string;
  boundary: "local-workspace" | "isolated";
  trustLevel: EvaluatorTrustLevel;
  isolated: boolean;
}

export interface EvaluatorAdapterReport {
  name: string;
  mediaType: "application/json; charset=utf-8";
  content: Uint8Array;
}

export type EvaluatorAdapterResponse =
  | {
      outcome: "report";
      producer: CheckResult;
      report: EvaluatorAdapterReport;
      trust: EvaluatorAdapterTrustEvidence;
    }
  | {
      outcome: "producer-terminal";
      producer: CheckResult;
      trust: EvaluatorAdapterTrustEvidence;
    }
  | {
      outcome: "adapter-error";
      producer: CheckResult;
      code: string;
      message: string;
      trust: EvaluatorAdapterTrustEvidence;
    };

export interface EvaluatorAdapter {
  readonly id: string;
  readonly version: number;
  evaluate(request: EvaluatorAdapterRequest, signal: AbortSignal): Promise<EvaluatorAdapterResponse>;
}

export interface LocalCommandReportEvaluatorAdapterOptions {
  rootDirectory: string;
  producerExecutor: CheckExecutor;
}

const DEFAULT_MAX_REPORT_BYTES = 1_048_576;

const localTrustEvidence = (
  definition: MetricReportCheckDefinition,
): EvaluatorAdapterTrustEvidence => ({
  adapterId: LOCAL_COMMAND_REPORT_EVALUATOR_ADAPTER,
  adapterVersion: LOCAL_COMMAND_REPORT_EVALUATOR_ADAPTER_VERSION,
  profile: LOCAL_COMMAND_REPORT_EVALUATOR_ADAPTER,
  boundary: "local-workspace",
  trustLevel: definition.evaluation?.integrity?.trustLevel ?? "transparent",
  isolated: false,
});

const resolveReportPath = (rootDirectory: string, definition: MetricReportCheckDefinition): string => {
  const root = resolve(rootDirectory);
  const workingDirectory = resolve(root, definition.workingDirectory ?? ".");
  const target = resolve(workingDirectory, definition.reportPath);
  const local = relative(root, target);
  if (local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("The evaluator report path is outside the configured workspace root.");
  }
  return target;
};

const producerRequest = (
  request: EvaluatorAdapterRequest,
): CheckExecutionRequest => ({
  workflowId: request.workflowId,
  revision: request.revision,
  nodeId: request.nodeId,
  attemptId: request.attemptId,
  requestedAt: request.requestedAt,
  definition: {
    kind: "command",
    command: request.definition.command,
    ...(request.definition.arguments === undefined ? {} : { arguments: [...request.definition.arguments] }),
    ...(request.definition.workingDirectory === undefined ? {} : { workingDirectory: request.definition.workingDirectory }),
    timeoutMs: request.definition.timeoutMs,
    ...(request.definition.expectedExitCodes === undefined ? {} : { expectedExitCodes: [...request.definition.expectedExitCodes] }),
    ...(request.definition.environmentVariables === undefined ? {} : { environmentVariables: [...request.definition.environmentVariables] }),
    ...(request.definition.retry === undefined ? {} : { retry: structuredClone(request.definition.retry) }),
    publish: [],
  },
});

const terminalProducer = (result: CheckResult): boolean => (
  result.status === "timed_out"
  || result.status === "cancelled"
  || result.status === "interrupted"
  || result.status === "error"
);

export class LocalCommandReportEvaluatorAdapter implements EvaluatorAdapter {
  readonly id = LOCAL_COMMAND_REPORT_EVALUATOR_ADAPTER;
  readonly version = LOCAL_COMMAND_REPORT_EVALUATOR_ADAPTER_VERSION;
  private readonly rootDirectory: string;
  private readonly producerExecutor: CheckExecutor;

  constructor(options: LocalCommandReportEvaluatorAdapterOptions) {
    this.rootDirectory = resolve(options.rootDirectory);
    this.producerExecutor = options.producerExecutor;
  }

  async evaluate(request: EvaluatorAdapterRequest, signal: AbortSignal): Promise<EvaluatorAdapterResponse> {
    const trust = localTrustEvidence(request.definition);
    if (trust.trustLevel === "isolated") {
      const producer: CheckResult = {
        checkKind: "command",
        attemptId: request.attemptId,
        startedAt: request.requestedAt,
        completedAt: request.requestedAt,
        status: "error",
        facts: [],
        evidence: [],
        error: "The local evaluator adapter cannot provide isolated trust.",
      };
      return {
        outcome: "adapter-error",
        producer,
        code: "local_adapter_cannot_isolate",
        message: "The selected evaluator adapter cannot provide isolated trust.",
        trust,
      };
    }

    const producer = await this.producerExecutor.execute(producerRequest(request), signal);
    if (terminalProducer(producer)) return { outcome: "producer-terminal", producer, trust };

    let reportPath: string;
    try {
      reportPath = resolveReportPath(this.rootDirectory, request.definition);
      const metadata = await stat(reportPath);
      if (!metadata.isFile()) throw new Error("The evaluator report path is not a file.");
      const maximum = request.definition.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
      if (metadata.size > maximum) throw new Error("The evaluator report exceeds the maximum read size.");
      if (signal.aborted) {
        return {
          outcome: "adapter-error",
          producer,
          code: "evaluator_adapter_cancelled",
          message: "The evaluator adapter was cancelled before it read the report.",
          trust,
        };
      }
      const content = new Uint8Array(await readFile(reportPath));
      if (content.byteLength > maximum) throw new Error("The evaluator report exceeds the maximum read size.");
      return {
        outcome: "report",
        producer,
        report: {
          name: basename(reportPath),
          mediaType: "application/json; charset=utf-8",
          content,
        },
        trust,
      };
    } catch (error) {
      return {
        outcome: "adapter-error",
        producer,
        code: "evaluator_report_unavailable",
        message: error instanceof Error ? error.message : String(error),
        trust,
      };
    }
  }
}
