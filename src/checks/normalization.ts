import type {
  CheckExecutionRequest,
  CheckFactSource,
  CheckResult,
  Diagnostic,
  EvidenceReference,
  FactInput,
  HypagraphCommand,
} from "../domain/model.js";
import type { FactValue } from "../domain/facts.js";
import { sha256 } from "../domain/hash.js";

export interface NormalizedCheckResult {
  facts: FactInput[];
  evidence: EvidenceReference[];
}

export type CheckNormalizationResult =
  | { ok: true; value: NormalizedCheckResult }
  | { ok: false; diagnostics: Diagnostic[] };

const sourceValue = (source: CheckFactSource, result: CheckResult): FactValue | undefined => {
  switch (source) {
    case "passed": return result.status === "passed";
    case "status": return result.status;
    case "exitCode": return result.exitCode;
    case "durationMs": return new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime();
    case "timedOut": return result.status === "timed_out";
    case "cancelled": return result.status === "cancelled";
  }
};

const sourceType = (source: CheckFactSource): FactInput["type"] => {
  switch (source) {
    case "passed":
    case "timedOut":
    case "cancelled": return "boolean";
    case "status": return "string";
    case "exitCode": return "integer";
    case "durationMs": return "number";
  }
};

export function normalizeCheckResult(request: CheckExecutionRequest, result: CheckResult): CheckNormalizationResult {
  const diagnostics: Diagnostic[] = [];
  if (result.attemptId !== request.attemptId) diagnostics.push({ code: "check_attempt_mismatch", message: "The check result attempt does not match the execution request.", location: "result.attemptId" });
  if (result.checkKind !== request.definition.kind) diagnostics.push({ code: "check_kind_mismatch", message: "The check result kind does not match the execution request.", location: "result.checkKind" });

  const startedAt = new Date(result.startedAt).getTime();
  const completedAt = new Date(result.completedAt).getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    diagnostics.push({ code: "invalid_check_result_time", message: "The check result must contain valid ordered timestamps.", location: "result.completedAt" });
  }

  const facts: FactInput[] = [];
  for (const mapping of request.definition.publish) {
    const value = sourceValue(mapping.source, result);
    if (value === undefined) {
      diagnostics.push({ code: "check_source_unavailable", message: `Check source '${mapping.source}' is not available for this result.`, location: `check.publish.${mapping.fact}` });
      continue;
    }
    facts.push({
      name: mapping.fact,
      type: sourceType(mapping.source),
      value,
      evidence: structuredClone(result.evidence),
    });
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, value: { facts, evidence: structuredClone(result.evidence) } };
}

export function createCheckFactPublicationCommand(
  request: CheckExecutionRequest,
  result: CheckResult,
  at: string,
): { ok: true; command: HypagraphCommand } | { ok: false; diagnostics: Diagnostic[] } {
  const normalized = normalizeCheckResult(request, result);
  if (!normalized.ok) return normalized;
  const commandId = sha256({
    type: "publish-check-facts",
    workflowId: request.workflowId,
    revision: request.revision,
    nodeId: request.nodeId,
    attemptId: request.attemptId,
    result,
  });
  return {
    ok: true,
    command: {
      type: "publish-facts",
      nodeId: request.nodeId,
      attemptId: request.attemptId,
      facts: normalized.value.facts,
      commandId,
      correlationId: commandId,
      at,
    },
  };
}
