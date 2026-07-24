import type {
  CheckResult,
  Diagnostic,
  EvaluationIntegrityDefinition,
  EvaluationIntegrityEvidenceKind,
  EvaluationIntegrityObservation,
  MetricReportCheckDefinition,
} from "./model.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DIAGNOSTIC_CODE_PATTERN = /^integrity_[a-z0-9_]+$/;

export function canonicalProtectedPath(value: string): string | undefined {
  if (!value.trim() || /^(?:[A-Za-z]:|[\\/])/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.includes("..")) return undefined;
  const canonical = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  return canonical || undefined;
}

export function expectedIntegrityEvidenceKinds(
  definition: EvaluationIntegrityDefinition,
): EvaluationIntegrityEvidenceKind[] {
  const kinds: EvaluationIntegrityEvidenceKind[] = [];
  for (const _path of [...(definition.protectedPaths ?? [])]
    .sort((left, right) => (canonicalProtectedPath(left.path) ?? left.path).localeCompare(canonicalProtectedPath(right.path) ?? right.path))) {
    kinds.push("protected-file-sha256");
  }
  if (definition.git?.expectedRevision !== undefined) kinds.push("git-exact-revision");
  if (definition.git?.requireCleanWorktree === true) kinds.push("git-clean-worktree");
  if (definition.git?.protectedPathsUnchangedFrom !== undefined) kinds.push("git-protected-paths-unchanged");
  return kinds;
}

export function validateEvaluationIntegrityResult(
  definition: MetricReportCheckDefinition,
  result: CheckResult,
): Diagnostic[] {
  const declared = definition.evaluation?.integrity;
  const observed = result.evaluation?.integrity;
  if (!declared) {
    return observed === undefined
      ? []
      : [{ code: "unexpected_evaluation_integrity", message: "The check result contains evaluator integrity data without an integrity declaration.", location: "result.evaluation.integrity" }];
  }
  if (!result.evaluation) {
    return [{ code: "evaluation_integrity_required", message: "The metric result must contain an evaluator integrity observation.", location: "result.evaluation.integrity" }];
  }

  const diagnostics: Diagnostic[] = [];
  if (result.evaluation.kind !== definition.evaluation?.kind) diagnostics.push({ code: "evaluation_kind_mismatch", message: "The metric result evaluation purpose does not match the definition.", location: "result.evaluation.kind" });
  if (result.evaluation.feedbackMode !== definition.evaluation?.feedback.mode) diagnostics.push({ code: "evaluation_feedback_mismatch", message: "The metric result feedback mode does not match the definition.", location: "result.evaluation.feedbackMode" });
  if (!observed || typeof observed !== "object") {
    diagnostics.push({ code: "evaluation_integrity_required", message: "The metric result must contain an evaluator integrity observation.", location: "result.evaluation.integrity" });
    return diagnostics;
  }

  if (observed.version !== 1) diagnostics.push({ code: "unsupported_evaluation_integrity_version", message: "The evaluator integrity observation must use version 1.", location: "result.evaluation.integrity.version" });
  if (observed.trustLevel !== declared.trustLevel || (observed.trustLevel !== "transparent" && observed.trustLevel !== "protected")) diagnostics.push({ code: "evaluation_trust_mismatch", message: "The evaluator integrity trust level does not match the definition.", location: "result.evaluation.integrity.trustLevel" });
  if (observed.status !== "valid" && observed.status !== "invalid") diagnostics.push({ code: "invalid_evaluation_integrity_status", message: "The evaluator integrity status is invalid.", location: "result.evaluation.integrity.status" });
  if (!SHA256_PATTERN.test(observed.evaluatorFingerprint)) diagnostics.push({ code: "invalid_evaluator_fingerprint", message: "The evaluator fingerprint must contain 64 lower-case hexadecimal characters.", location: "result.evaluation.integrity.evaluatorFingerprint" });

  const declaredVersion = declared.evaluatorVersion?.value;
  if (declaredVersion === undefined ? observed.evaluatorVersion !== undefined : observed.evaluatorVersion !== declaredVersion) {
    diagnostics.push({ code: "evaluator_version_mismatch", message: "The observed evaluator version does not match the declared version.", location: "result.evaluation.integrity.evaluatorVersion" });
  }

  const observedCodes = Array.isArray(observed.diagnosticCodes) ? observed.diagnosticCodes : [];
  if (!Array.isArray(observed.diagnosticCodes)
    || observed.diagnosticCodes.some((code) => typeof code !== "string" || !DIAGNOSTIC_CODE_PATTERN.test(code))
    || new Set(observed.diagnosticCodes).size !== observed.diagnosticCodes.length
    || [...observed.diagnosticCodes].sort().some((code, index) => code !== observed.diagnosticCodes[index])) {
    diagnostics.push({ code: "invalid_evaluation_integrity_diagnostics", message: "Evaluator integrity diagnostic codes must be unique, sorted, and stable.", location: "result.evaluation.integrity.diagnosticCodes" });
  }

  const expectedKinds = expectedIntegrityEvidenceKinds(declared);
  const observedEvidence = Array.isArray(observed.protectedEvidence) ? observed.protectedEvidence : [];
  if (!Array.isArray(observed.protectedEvidence)
    || observed.protectedEvidence.length !== expectedKinds.length
    || observed.protectedEvidence.some((evidence, index) => evidence?.kind !== expectedKinds[index]
      || (evidence.status !== "verified" && evidence.status !== "mismatch" && evidence.status !== "error"))) {
    diagnostics.push({ code: "invalid_evaluation_integrity_evidence", message: "The evaluator integrity evidence does not match the declared instruments.", location: "result.evaluation.integrity.protectedEvidence" });
  }

  const hasInvalidEvidence = observedEvidence.some((evidence) => evidence?.status !== "verified");
  if (observed.status === "valid" && (observedCodes.length > 0 || hasInvalidEvidence)) diagnostics.push({ code: "inconsistent_evaluation_integrity_status", message: "A valid evaluator integrity observation must not contain failed evidence or diagnostics.", location: "result.evaluation.integrity.status" });
  if (observed.status === "invalid" && observedCodes.length === 0) diagnostics.push({ code: "evaluation_integrity_diagnostic_required", message: "An invalid evaluator integrity observation requires a diagnostic code.", location: "result.evaluation.integrity.diagnosticCodes" });
  return diagnostics;
}

export function invalidEvaluatorIntegrity(result: CheckResult | undefined): EvaluationIntegrityObservation | undefined {
  const observation = result?.evaluation?.integrity;
  return observation?.status === "invalid" ? observation : undefined;
}
