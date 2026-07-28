import type {
  CodeExecutionRequest,
  CodeResult,
  Diagnostic,
  FactInput,
  HypagraphCommand,
} from "../domain/model.js";
import { sha256 } from "../domain/hash.js";
import { validateCodeReturnValue } from "./result-validation.js";

export type CodeNormalizationResult =
  | { ok: true; facts: FactInput[] }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Normalise a code result for fact publication.
 * Prefer facts already validated by the executor. Re-validate the return value as a safeguard.
 */
export function normalizeCodeResult(
  request: CodeExecutionRequest,
  result: CodeResult,
): CodeNormalizationResult {
  const diagnostics: Diagnostic[] = [];
  if (result.attemptId !== request.attemptId) {
    diagnostics.push({
      code: "code_attempt_mismatch",
      message: "The code result attempt does not match the execution request.",
      location: "result.attemptId",
    });
  }
  const startedAt = Date.parse(result.startedAt);
  const completedAt = Date.parse(result.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    diagnostics.push({
      code: "invalid_code_result_time",
      message: "The code result must contain valid ordered timestamps.",
      location: "result.completedAt",
    });
  }

  if (result.status !== "passed") {
    if (diagnostics.length > 0) return { ok: false, diagnostics };
    return { ok: true, facts: [] };
  }

  if (result.facts.length > 0) {
    // Re-validate declared names and types against produces.
    for (const fact of result.facts) {
      const contract = request.produces.find((item) => item.name === fact.name);
      if (!contract) {
        diagnostics.push({
          code: "code_fact_not_declared",
          message: `Code result fact '${fact.name}' is not declared by the node.`,
          location: `result.facts.${fact.name}`,
        });
      } else if (contract.type !== fact.type) {
        diagnostics.push({
          code: "code_fact_type_mismatch",
          message: `Code result fact '${fact.name}' must have type '${contract.type}'.`,
          location: `result.facts.${fact.name}`,
        });
      }
    }
    if (diagnostics.length > 0) return { ok: false, diagnostics };
    return { ok: true, facts: structuredClone(result.facts) };
  }

  const validated = validateCodeReturnValue(result.value, request.produces, result.evidence);
  if (!validated.ok) return validated;
  return { ok: true, facts: validated.facts };
}

export function createCodeFactPublicationCommand(
  request: CodeExecutionRequest,
  result: CodeResult,
  at: string,
): { ok: true; command: HypagraphCommand } | { ok: false; diagnostics: Diagnostic[] } {
  const normalized = normalizeCodeResult(request, result);
  if (!normalized.ok) return normalized;
  if (normalized.facts.length === 0) {
    return {
      ok: true,
      command: {
        type: "publish-facts",
        nodeId: request.nodeId,
        attemptId: request.attemptId,
        facts: [],
        commandId: sha256({
          type: "publish-code-facts",
          workflowId: request.workflowId,
          revision: request.revision,
          nodeId: request.nodeId,
          attemptId: request.attemptId,
          result,
        }),
        correlationId: sha256({ type: "publish-code-facts", attemptId: request.attemptId }),
        at,
      },
    };
  }
  const commandId = sha256({
    type: "publish-code-facts",
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
      facts: normalized.facts,
      commandId,
      correlationId: commandId,
      at,
    },
  };
}
