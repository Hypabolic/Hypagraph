import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import type { Diagnostic, EvidenceReference, FactInput, GitAssertionDefinition } from "../domain/model.js";

export const GIT_ASSERTION_VERSION = 1 as const;
export type { GitAssertionDefinition } from "../domain/model.js";

export interface GitAssertionResult {
  assertionVersion: typeof GIT_ASSERTION_VERSION;
  passed: boolean;
  facts: FactInput[];
  evidence: EvidenceReference[];
  diagnostics: Diagnostic[];
}

const MAX_GIT_OUTPUT_BYTES = 1_048_576;

const workspaceRoot = (rootDirectory: string): string => {
  const root = resolve(rootDirectory);
  const local = relative(root, root);
  if (local !== "") throw new Error("The Git assertion workspace root is invalid.");
  return root;
};

const runGit = async (rootDirectory: string, args: readonly string[]): Promise<string> => {
  const root = workspaceRoot(rootDirectory);
  const child = spawn("git", args, {
    cwd: root,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const append = (target: Buffer[], chunk: Buffer, current: number): number => {
    if (current >= MAX_GIT_OUTPUT_BYTES) return current;
    const accepted = chunk.subarray(0, MAX_GIT_OUTPUT_BYTES - current);
    target.push(Buffer.from(accepted));
    return current + accepted.length;
  };
  child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = append(stdout, chunk, stdoutBytes); });
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes = append(stderr, chunk, stderrBytes); });

  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? -1));
  });
  const errorText = Buffer.concat(stderr).toString("utf8").trim();
  if (exitCode !== 0) throw new Error(errorText || `Git exited with code ${exitCode}.`);
  return Buffer.concat(stdout).toString("utf8").replace(/\r\n/g, "\n").trim();
};

const normalizedPaths = (value: string): string[] => value
  .split("\n")
  .map((path) => path.trim().replaceAll("\\", "/"))
  .filter(Boolean)
  .sort((left, right) => left.localeCompare(right));

const result = (
  definition: GitAssertionDefinition,
  passed: boolean,
  facts: FactInput[],
  diagnostics: Diagnostic[] = [],
): GitAssertionResult => {
  const evidence: EvidenceReference[] = [{ ref: "git://workspace", kind: "command", summary: "Fixed-allowlist Git assertion." }];
  return {
    assertionVersion: GIT_ASSERTION_VERSION,
    passed,
    facts: [
      { name: "gitAssertion.passed", type: "boolean", value: passed, evidence },
      { name: "gitAssertion.kind", type: "string", value: definition.kind, evidence },
      ...facts.map((fact) => ({ ...fact, evidence })),
    ],
    evidence,
    diagnostics,
  };
};

export async function evaluateGitAssertion(
  rootDirectory: string,
  definition: GitAssertionDefinition,
): Promise<GitAssertionResult> {
  try {
    if (definition.kind === "clean") {
      const paths = normalizedPaths(await runGit(rootDirectory, ["status", "--porcelain=v1", "--untracked-files=all"]));
      const passed = paths.length === 0;
      return result(definition, passed, [
        { name: "git.clean", type: "boolean", value: passed },
        { name: "git.changedPaths", type: "string-list", value: paths },
      ], passed ? [] : [{ code: "git_worktree_dirty", message: "The Git worktree contains changed or untracked paths.", location: "assertion.kind" }]);
    }

    if (definition.kind === "branch") {
      const branch = await runGit(rootDirectory, ["branch", "--show-current"]);
      const passed = branch === definition.name;
      return result(definition, passed, [
        { name: "git.branch", type: "string", value: branch },
        { name: "git.expectedBranch", type: "string", value: definition.name },
      ], passed ? [] : [{ code: "git_branch_mismatch", message: `Expected branch '${definition.name}' but found '${branch || "detached HEAD"}'.`, location: "assertion.name" }]);
    }

    if (definition.kind === "revision") {
      if (!/^[a-f0-9]{7,64}$/i.test(definition.sha)) {
        return result(definition, false, [], [{ code: "invalid_git_revision", message: "The expected revision must be a hexadecimal Git object ID.", location: "assertion.sha" }]);
      }
      const revision = await runGit(rootDirectory, ["rev-parse", "HEAD"]);
      const passed = revision.toLowerCase().startsWith(definition.sha.toLowerCase());
      return result(definition, passed, [
        { name: "git.revision", type: "string", value: revision },
        { name: "git.expectedRevision", type: "string", value: definition.sha },
      ], passed ? [] : [{ code: "git_revision_mismatch", message: "The current Git revision does not match the expected revision.", location: "assertion.sha" }]);
    }

    const expected = [...new Set(definition.paths.map((path) => path.replaceAll("\\", "/")))].sort((left, right) => left.localeCompare(right));
    if (expected.some((path) => path.length === 0 || path === ".." || path.startsWith("../") || path.startsWith("/"))) {
      return result(definition, false, [], [{ code: "invalid_git_changed_path", message: "Expected changed paths must be non-empty workspace-relative paths.", location: "assertion.paths" }]);
    }
    const actual = normalizedPaths(await runGit(rootDirectory, ["diff", "--name-only", "HEAD", "--"]));
    const mode = definition.mode ?? "exact";
    const passed = mode === "exact"
      ? actual.length === expected.length && actual.every((path, index) => path === expected[index])
      : expected.every((path) => actual.includes(path));
    return result(definition, passed, [
      { name: "git.changedPaths", type: "string-list", value: actual },
      { name: "git.expectedChangedPaths", type: "string-list", value: expected },
      { name: "git.changedPathMode", type: "string", value: mode },
    ], passed ? [] : [{ code: "git_changed_paths_mismatch", message: "The changed path set does not satisfy the assertion.", location: "assertion.paths" }]);
  } catch (error) {
    return result(definition, false, [], [{
      code: "git_assertion_failed",
      message: `The fixed Git assertion command failed: ${error instanceof Error ? error.message : String(error)}`,
      location: "assertion",
    }]);
  }
}
