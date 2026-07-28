import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { CodeScopeVerification } from "../domain/model.js";
import { codeNodeHasWorkspaceMutation } from "../domain/code-authoring.js";
import type { CodeCapability } from "../domain/model.js";
import { pathMatchesAllowlist } from "./paths.js";

export interface ScopeBaseline {
  /** Paths dirty before the program ran. */
  paths: string[];
  /** Content hash for each baseline path. Missing files use the sentinel `missing`. */
  contentHashes: Record<string, string>;
}

export interface ScopeVerificationInput {
  rootDirectory: string;
  scopePaths: readonly string[];
  capabilities: readonly CodeCapability[];
  /** Baseline captured before the program ran. */
  baseline?: ScopeBaseline;
  /**
   * @deprecated Prefer `baseline`. Paths already dirty before the program ran.
   * Kept for call sites that do not supply content hashes.
   */
  baselineChangedPaths?: readonly string[];
  signal?: AbortSignal;
}

/**
 * Verify a mutating code program against declared repository scope.
 * When the program has no workspace-mutation capability, verification passes without Git work.
 *
 * Baseline-dirty paths are not a permanent exemption. The verifier records content hashes
 * at baseline and compares them after the program. A further modification of a baseline path,
 * including a return to a clean tree state, is checked against `scope.paths`.
 */
export async function verifyCodeScope(input: ScopeVerificationInput): Promise<CodeScopeVerification> {
  if (!codeNodeHasWorkspaceMutation(input.capabilities)) {
    return { passed: true, changedPaths: [] };
  }
  if (input.scopePaths.length === 0) {
    return {
      passed: false,
      error: "A mutating code program requires declared scope.paths.",
    };
  }

  const baseline = normalizeBaseline(input);
  try {
    const after = await listChangedPaths(input.rootDirectory, input.signal);
    // Hash the union so a baseline path that returns to clean is still observed.
    const observed = [...new Set([...after, ...baseline.paths])];
    const afterHashes = await hashWorkspacePaths(input.rootDirectory, observed, input.signal);
    const baselineSet = new Set(baseline.paths);

    const introduced = after.filter((path) => !baselineSet.has(path));
    const furtherModified = baseline.paths.filter((path) => {
      const beforeHash = baseline.contentHashes[path];
      const afterHash = afterHashes[path];
      // Fail closed when either side cannot be hashed.
      if (beforeHash === undefined || afterHash === undefined) return true;
      return beforeHash !== afterHash;
    });

    const toCheck = [...new Set([...introduced, ...furtherModified])].sort((left, right) =>
      left.localeCompare(right));
    const violations = toCheck.filter((path) => !pathMatchesAllowlist(path, input.scopePaths));
    if (violations.length > 0) {
      return {
        passed: false,
        changedPaths: toCheck,
        baselinePaths: [...baseline.paths],
        error: `Changed paths outside scope: ${violations.join(", ")}.`,
      };
    }
    return {
      passed: true,
      changedPaths: toCheck,
      baselinePaths: [...baseline.paths],
    };
  } catch (error) {
    return {
      passed: false,
      ...(baseline.paths.length > 0 ? { baselinePaths: [...baseline.paths] } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Capture dirty paths and content hashes before a mutating program runs. */
export async function captureScopeBaseline(
  rootDirectory: string,
  signal?: AbortSignal,
): Promise<ScopeBaseline> {
  const paths = await listChangedPaths(rootDirectory, signal);
  const contentHashes = await hashWorkspacePaths(rootDirectory, paths, signal);
  return { paths, contentHashes };
}

const normalizeBaseline = (input: ScopeVerificationInput): ScopeBaseline => {
  if (input.baseline) {
    return {
      paths: [...input.baseline.paths],
      contentHashes: { ...input.baseline.contentHashes },
    };
  }
  const paths = [...(input.baselineChangedPaths ?? [])];
  // Without content hashes, further modification of a baseline path cannot be detected.
  // The path remains in evidence as an exemption limitation.
  return { paths, contentHashes: {} };
};

/**
 * Report whether `absolute` is under `root` using portable path helpers.
 * Matches the containment idiom used elsewhere in the repository.
 */
export function pathIsInsideRoot(root: string, absolute: string): boolean {
  const local = relative(root, absolute);
  if (local === "") return true;
  if (isAbsolute(local)) return false;
  const normalised = local.split(sep).join("/");
  return normalised !== ".." && !normalised.startsWith("../");
}

/**
 * Hash file contents for dirty paths.
 * - `missing`: path is under the root but unreadable or deleted.
 * - `outside-root`: path escapes the workspace root (fail closed; distinct from missing).
 */
export async function hashWorkspacePaths(
  rootDirectory: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const root = resolve(rootDirectory);
  const hashes: Record<string, string> = {};
  for (const relativePath of paths) {
    if (signal?.aborted) throw new Error("The code execution was cancelled.");
    const absolute = resolve(root, relativePath);
    if (!pathIsInsideRoot(root, absolute)) {
      hashes[relativePath] = "outside-root";
      continue;
    }
    try {
      const bytes = await readFile(absolute);
      hashes[relativePath] = createHash("sha256").update(bytes).digest("hex");
    } catch {
      hashes[relativePath] = "missing";
    }
  }
  return hashes;
}

const listChangedPaths = async (rootDirectory: string, signal?: AbortSignal): Promise<string[]> => {
  const root = resolve(rootDirectory);
  const args = ["status", "--porcelain", "-z", "--untracked-files=all"];
  const child = spawn("git", args, {
    cwd: root,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(signal ? { signal } : {}),
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? -1));
  });
  if (exitCode !== 0) {
    const errorText = Buffer.concat(stderr).toString("utf8").trim();
    throw new Error(errorText || `Git status exited with code ${exitCode}.`);
  }
  return parsePorcelainZ(Buffer.concat(stdout).toString("utf8"));
};

/**
 * Parse NUL-terminated porcelain status output (`git status --porcelain -z`).
 *
 * For rename and copy entries the `-z` field order is reversed from the human format:
 * the path in the same field as the `XY` code is the **new** path, and the next
 * NUL-terminated field is the **original** path. Both paths are changed paths.
 * A rename or copy entry is always followed by exactly one original-path field.
 */
export function parsePorcelainZ(output: string): string[] {
  const entries = output.split("\0").filter((item) => item.length > 0);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 3) continue;
    const code = entry.slice(0, 2);
    const pathPart = entry.slice(3).replaceAll("\\", "/");
    const isRenameOrCopy = code.includes("R") || code.includes("C");
    if (isRenameOrCopy) {
      // -z: pathPart is the new path; the next field is always the original path.
      paths.push(pathPart);
      const next = entries[index + 1];
      if (next !== undefined) {
        paths.push(next.replaceAll("\\", "/"));
        index += 1;
      }
      continue;
    }
    paths.push(pathPart);
  }
  return [...new Set(paths.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}
