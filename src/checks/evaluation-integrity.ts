import type {
  EvaluationIntegrityDefinition,
  EvaluationIntegrityEvidence,
  EvaluationIntegrityObservation,
  EvidenceReference,
  FactInput,
} from "../domain/model.js";
import { sha256 } from "../domain/hash.js";
import { canonicalProtectedPath } from "../domain/integrity-policy.js";
import { evaluateFileAssertion } from "./file-assertion.js";
import { evaluateGitAssertion } from "./git-assertion.js";

export interface EvaluationIntegrityResult {
  observation: EvaluationIntegrityObservation;
  evidence: EvidenceReference[];
  versionFact?: FactInput;
}

interface FingerprintRecord {
  kind: EvaluationIntegrityEvidence["kind"];
  status: EvaluationIntegrityEvidence["status"];
  observed: unknown;
}

const DEFAULT_INTEGRITY_TIMEOUT_MS = 30_000;

const protectedEvidence = (evidence: readonly EvidenceReference[]): EvidenceReference[] => evidence.map((item) => ({
  ...structuredClone(item),
  visibility: "protected" as const,
}));

const abortDiagnosticCode = (signal: AbortSignal): string => {
  const reason = signal.reason;
  const name = reason && typeof reason === "object" && "name" in reason ? String(reason.name) : "";
  return name === "TimeoutError" ? "integrity_evaluation_timed_out" : "integrity_evaluation_cancelled";
};

const fileDiagnosticCode = (codes: readonly string[], signal: AbortSignal): string => {
  if (signal.aborted || codes.includes("file_assertion_cancelled")) return abortDiagnosticCode(signal);
  if (codes.includes("file_hash_mismatch")) return "integrity_protected_file_hash_mismatch";
  if (codes.includes("file_assertion_missing") || codes.includes("file_assertion_not_file")) return "integrity_protected_file_missing";
  if (codes.includes("file_assertion_too_large") || codes.includes("invalid_file_assertion_limit")) return "integrity_protected_file_read_limit";
  if (codes.includes("file_assertion_outside_root")) return "integrity_protected_file_outside_workspace";
  if (codes.includes("file_assertion_symlink_not_allowed")) return "integrity_protected_file_symlink";
  return "integrity_protected_file_check_failed";
};

const gitDiagnosticCode = (
  kind: EvaluationIntegrityEvidence["kind"],
  codes: readonly string[],
  signal: AbortSignal,
): string => {
  if (signal.aborted || codes.includes("git_assertion_cancelled")) return abortDiagnosticCode(signal);
  if (kind === "git-exact-revision" && codes.includes("git_revision_mismatch")) return "integrity_git_revision_mismatch";
  if (kind === "git-clean-worktree" && codes.includes("git_worktree_dirty")) return "integrity_git_worktree_dirty";
  if (kind === "git-protected-paths-unchanged" && codes.includes("git_protected_paths_changed")) return "integrity_git_protected_paths_changed";
  if (kind === "git-protected-paths-unchanged" && codes.includes("git_protected_path_not_tracked")) return "integrity_git_protected_path_not_tracked";
  return "integrity_git_check_failed";
};

const mismatchFileCodes = new Set(["file_hash_mismatch", "file_assertion_missing", "file_assertion_not_file"]);
const mismatchGitCodes = new Set(["git_revision_mismatch", "git_worktree_dirty", "git_protected_paths_changed", "git_protected_path_not_tracked"]);

const evidenceStatus = (
  passed: boolean,
  codes: readonly string[],
  mismatchCodes: ReadonlySet<string>,
): EvaluationIntegrityEvidence["status"] => passed ? "verified" : codes.some((code) => mismatchCodes.has(code)) ? "mismatch" : "error";

const actualFact = (facts: readonly FactInput[], name: string): unknown => facts.find((fact) => fact.name === name)?.value ?? null;

export async function evaluateEvaluationIntegrity(
  rootDirectory: string,
  definition: EvaluationIntegrityDefinition,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_INTEGRITY_TIMEOUT_MS,
): Promise<EvaluationIntegrityResult> {
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
  const operationSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  const evidence: EvidenceReference[] = [];
  const observations: EvaluationIntegrityEvidence[] = [];
  const fingerprintRecords: FingerprintRecord[] = [];
  const diagnosticCodes: string[] = [];

  const appendAborted = (kind: EvaluationIntegrityEvidence["kind"]): void => {
    const code = abortDiagnosticCode(operationSignal);
    observations.push({ kind, status: "error" });
    diagnosticCodes.push(code);
    fingerprintRecords.push({ kind, status: "error", observed: { diagnosticCodes: [code] } });
  };

  const paths = [...(definition.protectedPaths ?? [])].sort((left, right) =>
    (canonicalProtectedPath(left.path) ?? left.path).localeCompare(canonicalProtectedPath(right.path) ?? right.path));
  for (const path of paths) {
    if (operationSignal.aborted) {
      appendAborted("protected-file-sha256");
      continue;
    }
    const result = await evaluateFileAssertion(rootDirectory, {
      kind: "sha256",
      path: canonicalProtectedPath(path.path) ?? path.path,
      hash: path.sha256,
      ...(path.maxBytes === undefined ? {} : { maxBytes: path.maxBytes }),
    }, operationSignal);
    const codes = result.diagnostics.map((item) => item.code);
    const status = evidenceStatus(result.passed, codes, mismatchFileCodes);
    observations.push({ kind: "protected-file-sha256", status });
    evidence.push(...protectedEvidence(result.evidence));
    if (!result.passed || operationSignal.aborted) diagnosticCodes.push(fileDiagnosticCode(codes, operationSignal));
    fingerprintRecords.push({
      kind: "protected-file-sha256",
      status,
      observed: {
        path: canonicalProtectedPath(path.path) ?? path.path,
        sha256: actualFact(result.facts, "file.sha256"),
        diagnosticCodes: [...codes].sort(),
      },
    });
  }

  const git = definition.git;
  if (git?.expectedRevision !== undefined) {
    if (operationSignal.aborted) appendAborted("git-exact-revision");
    else {
      const result = await evaluateGitAssertion(rootDirectory, { kind: "exact-revision", sha: git.expectedRevision }, operationSignal);
      const codes = result.diagnostics.map((item) => item.code);
      const status = evidenceStatus(result.passed, codes, mismatchGitCodes);
      observations.push({ kind: "git-exact-revision", status });
      evidence.push(...protectedEvidence(result.evidence));
      if (!result.passed || operationSignal.aborted) diagnosticCodes.push(gitDiagnosticCode("git-exact-revision", codes, operationSignal));
      fingerprintRecords.push({
        kind: "git-exact-revision",
        status,
        observed: { revision: actualFact(result.facts, "git.revision"), diagnosticCodes: [...codes].sort() },
      });
    }
  }

  if (git?.requireCleanWorktree === true) {
    if (operationSignal.aborted) appendAborted("git-clean-worktree");
    else {
      const result = await evaluateGitAssertion(rootDirectory, { kind: "clean" }, operationSignal);
      const codes = result.diagnostics.map((item) => item.code);
      const status = evidenceStatus(result.passed, codes, mismatchGitCodes);
      observations.push({ kind: "git-clean-worktree", status });
      evidence.push(...protectedEvidence(result.evidence));
      if (!result.passed || operationSignal.aborted) diagnosticCodes.push(gitDiagnosticCode("git-clean-worktree", codes, operationSignal));
      fingerprintRecords.push({
        kind: "git-clean-worktree",
        status,
        observed: { changedPaths: actualFact(result.facts, "git.changedPaths"), diagnosticCodes: [...codes].sort() },
      });
    }
  }

  if (git?.protectedPathsUnchangedFrom !== undefined) {
    if (operationSignal.aborted) appendAborted("git-protected-paths-unchanged");
    else {
      const result = await evaluateGitAssertion(rootDirectory, {
        kind: "unchanged-paths",
        paths: paths.map((item) => canonicalProtectedPath(item.path) ?? item.path),
        baseRevision: git.protectedPathsUnchangedFrom,
      }, operationSignal);
      const codes = result.diagnostics.map((item) => item.code);
      const status = evidenceStatus(result.passed, codes, mismatchGitCodes);
      observations.push({ kind: "git-protected-paths-unchanged", status });
      evidence.push(...protectedEvidence(result.evidence));
      if (!result.passed || operationSignal.aborted) diagnosticCodes.push(gitDiagnosticCode("git-protected-paths-unchanged", codes, operationSignal));
      fingerprintRecords.push({
        kind: "git-protected-paths-unchanged",
        status,
        observed: {
          changedPaths: actualFact(result.facts, "git.changedPaths"),
          baseRevision: actualFact(result.facts, "git.baseRevision"),
          diagnosticCodes: [...codes].sort(),
        },
      });
    }
  }

  const normalizedCodes = [...new Set(diagnosticCodes)].sort();
  const evaluatorFingerprint = sha256({
    version: 1,
    trustLevel: definition.trustLevel,
    evaluatorVersion: definition.evaluatorVersion?.value ?? null,
    observations: fingerprintRecords,
  });
  const observation: EvaluationIntegrityObservation = {
    version: 1,
    trustLevel: definition.trustLevel === "isolated" ? "protected" : definition.trustLevel,
    status: normalizedCodes.length === 0 ? "valid" : "invalid",
    ...(definition.evaluatorVersion === undefined ? {} : { evaluatorVersion: definition.evaluatorVersion.value }),
    evaluatorFingerprint,
    diagnosticCodes: normalizedCodes,
    protectedEvidence: observations,
  };
  const factName = definition.evaluatorVersion?.fact;
  return {
    observation,
    evidence,
    ...(factName === undefined ? {} : {
      versionFact: {
        name: factName,
        type: "string",
        value: definition.evaluatorVersion!.value,
        evidence: [{ ref: "integrity://declared-evaluator-version", kind: "note", summary: "Declared evaluator version." }],
      },
    }),
  };
}
