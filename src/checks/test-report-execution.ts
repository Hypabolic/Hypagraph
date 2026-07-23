import type {
  CheckExecutionRequest,
  CheckResult,
  Diagnostic,
  HypagraphCommand,
} from "../domain/model.js";
import { sha256 } from "../domain/hash.js";
import type { CheckArtifactStore } from "./artifacts.js";
import { adaptVitestJsonResult, type TestReportAdapterOptions } from "./test-report-adapter.js";

const DEFAULT_MAX_REPORT_BYTES = 1_048_576;

export type ExecutedTestReport =
  | { ok: true; result: CheckResult; publicationCommand: HypagraphCommand }
  | { ok: false; diagnostics: Diagnostic[] };

export interface ExecuteStoredVitestReportOptions extends TestReportAdapterOptions {
  maxReportBytes?: number;
}

export async function executeStoredVitestReport(
  request: CheckExecutionRequest,
  commandResult: CheckResult,
  artifactStore: CheckArtifactStore,
  reportRef: string,
  recordedAt: string,
  options: ExecuteStoredVitestReportOptions = {},
): Promise<ExecutedTestReport> {
  const diagnostics: Diagnostic[] = [];
  if (commandResult.attemptId !== request.attemptId) {
    diagnostics.push({
      code: "check_attempt_mismatch",
      message: "The test report command result attempt does not match the execution request.",
      location: "result.attemptId",
    });
  }
  if (request.definition.kind !== "command") {
    diagnostics.push({
      code: "invalid_test_report_request",
      message: "The test report producer must use a command check definition.",
      location: "request.definition.kind",
    });
  }
  if (!reportRef || !commandResult.evidence.some((item) => item.ref === reportRef)) {
    diagnostics.push({
      code: "undeclared_test_report_artifact",
      message: "The test report reference must be present in the recorded command evidence.",
      location: "reportRef",
    });
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const maxReportBytes = options.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
  let artifact;
  try {
    artifact = await artifactStore.read(reportRef, maxReportBytes);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: "test_report_artifact_read_failed",
        message: error instanceof Error ? error.message : String(error),
        location: "reportRef",
      }],
    };
  }
  if (!artifact) {
    return {
      ok: false,
      diagnostics: [{
        code: "test_report_artifact_missing",
        message: "The stored test report artifact does not exist.",
        location: "reportRef",
      }],
    };
  }
  if (!artifact.mediaType.includes("json")) {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_test_report_media_type",
        message: "The stored test report artifact must use a JSON media type.",
        location: "artifact.mediaType",
      }],
    };
  }

  let reportText: string;
  try {
    reportText = new TextDecoder("utf-8", { fatal: true }).decode(artifact.content);
  } catch {
    return {
      ok: false,
      diagnostics: [{
        code: "invalid_test_report_encoding",
        message: "The stored test report artifact must contain valid UTF-8.",
        location: "artifact.content",
      }],
    };
  }

  const adapted = adaptVitestJsonResult(commandResult, reportText, options);
  if (!adapted.ok) return adapted;

  const commandId = sha256({
    type: "publish-test-report-facts",
    workflowId: request.workflowId,
    revision: request.revision,
    nodeId: request.nodeId,
    attemptId: request.attemptId,
    reportRef,
    result: adapted.result,
  });
  return {
    ok: true,
    result: adapted.result,
    publicationCommand: {
      type: "publish-facts",
      nodeId: request.nodeId,
      attemptId: request.attemptId,
      facts: adapted.result.facts,
      commandId,
      correlationId: commandId,
      at: recordedAt,
    },
  };
}
