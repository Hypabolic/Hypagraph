import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Diagnostic, EvidenceReference, FactInput, FileAssertionDefinition } from "../domain/model.js";

export const FILE_ASSERTION_VERSION = 1 as const;
export type { FileAssertionDefinition } from "../domain/model.js";

export interface FileAssertionResult {
  assertionVersion: typeof FILE_ASSERTION_VERSION;
  passed: boolean;
  facts: FactInput[];
  evidence: EvidenceReference[];
  diagnostics: Diagnostic[];
}

const DEFAULT_MAX_TEXT_BYTES = 1_048_576;
const DEFAULT_MAX_HASH_BYTES = 16_777_216;

const insideRoot = (rootDirectory: string, path: string): string => {
  const root = resolve(rootDirectory);
  const target = resolve(root, path);
  const local = relative(root, target);
  if (local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("The asserted file path is outside the configured workspace root.");
  }
  return target;
};

const realPathInsideRoot = async (rootDirectory: string, target: string): Promise<string> => {
  const root = await realpath(resolve(rootDirectory));
  const actual = await realpath(target);
  const local = relative(root, actual);
  if (local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("The asserted file resolves outside the configured workspace root.");
  }
  return actual;
};

const abortError = (): Error => {
  const error = new Error("The file assertion was cancelled.");
  error.name = "AbortError";
  return error;
};

const readBounded = async (
  rootDirectory: string,
  target: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer | undefined> => {
  if (signal?.aborted) throw abortError();
  const initialLink = await lstat(target);
  if (initialLink.isSymbolicLink()) {
    const error = new Error("The asserted file must not be a symbolic link.") as NodeJS.ErrnoException;
    error.code = "ELOOP";
    throw error;
  }

  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(target, constants.O_RDONLY | noFollow);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    if (signal?.aborted) throw abortError();
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("The asserted path is not a regular file.");
    if (opened.size > maxBytes) return undefined;

    const actual = await realPathInsideRoot(rootDirectory, target);
    const current = await stat(actual);
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error("The asserted file changed while it was being opened.");
    }

    while (total <= maxBytes) {
      if (signal?.aborted) throw abortError();
      const buffer = Buffer.allocUnsafe(Math.min(65_536, maxBytes - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return Buffer.concat(chunks, total);
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    return undefined;
  } finally {
    await handle.close();
  }
};

const fileEvidence = (path: string, summary: string): EvidenceReference[] => [{ ref: path, kind: "file", summary }];

const failure = (definition: FileAssertionDefinition, code: string, message: string): FileAssertionResult => ({
  assertionVersion: FILE_ASSERTION_VERSION,
  passed: false,
  facts: [
    { name: "fileAssertion.passed", type: "boolean", value: false },
    { name: "fileAssertion.kind", type: "string", value: definition.kind },
    { name: "fileAssertion.path", type: "string", value: definition.path },
  ],
  evidence: [],
  diagnostics: [{ code, message, location: "assertion.path" }],
});

const readFailure = (definition: FileAssertionDefinition, error: unknown): FileAssertionResult => {
  const cancelled = error instanceof Error && error.name === "AbortError";
  const symlink = error instanceof Error && "code" in error && error.code === "ELOOP";
  return failure(
    definition,
    cancelled ? "file_assertion_cancelled" : symlink ? "file_assertion_symlink_not_allowed" : "file_assertion_read_failed",
    cancelled
      ? "The file assertion was cancelled."
      : symlink
        ? "The asserted file must not be a symbolic link."
        : `The asserted file could not be read: ${error instanceof Error ? error.message : String(error)}`,
  );
};

export async function evaluateFileAssertion(
  rootDirectory: string,
  definition: FileAssertionDefinition,
  signal?: AbortSignal,
): Promise<FileAssertionResult> {
  if (signal?.aborted) return failure(definition, "file_assertion_cancelled", "The file assertion was cancelled.");

  let target: string;
  try {
    target = insideRoot(rootDirectory, definition.path);
  } catch (error) {
    return failure(definition, "file_assertion_outside_root", error instanceof Error ? error.message : String(error));
  }

  let metadata;
  try {
    metadata = await stat(target);
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (definition.kind === "absent" && missing) {
      return {
        assertionVersion: FILE_ASSERTION_VERSION,
        passed: true,
        facts: [
          { name: "fileAssertion.passed", type: "boolean", value: true },
          { name: "fileAssertion.kind", type: "string", value: definition.kind },
          { name: "fileAssertion.path", type: "string", value: definition.path },
          { name: "file.exists", type: "boolean", value: false },
        ],
        evidence: [],
        diagnostics: [],
      };
    }
    return failure(
      definition,
      missing ? "file_assertion_missing" : "file_assertion_stat_failed",
      missing ? `The asserted file '${definition.path}' does not exist.` : `The asserted file could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!metadata.isFile()) return failure(definition, "file_assertion_not_file", `The asserted path '${definition.path}' is not a regular file.`);
  try {
    await realPathInsideRoot(rootDirectory, target);
  } catch (error) {
    return failure(definition, "file_assertion_outside_root", error instanceof Error ? error.message : String(error));
  }
  if (definition.kind === "absent") return failure(definition, "file_assertion_present", `The asserted file '${definition.path}' exists.`);

  const evidence = fileEvidence(target, "File assertion input.");
  const baseFacts: FactInput[] = [
    { name: "fileAssertion.kind", type: "string", value: definition.kind, evidence },
    { name: "fileAssertion.path", type: "string", value: definition.path, evidence },
    { name: "file.exists", type: "boolean", value: true, evidence },
    { name: "file.sizeBytes", type: "integer", value: metadata.size, evidence },
  ];

  let passed = true;
  const diagnostics: Diagnostic[] = [];
  if (definition.kind === "size") {
    if (!Number.isInteger(definition.bytes) || definition.bytes < 0) {
      return failure(definition, "invalid_file_assertion_size", "The expected file size must be a non-negative integer.");
    }
    passed = metadata.size === definition.bytes;
    baseFacts.push({ name: "file.expectedSizeBytes", type: "integer", value: definition.bytes, evidence });
    if (!passed) diagnostics.push({ code: "file_size_mismatch", message: `Expected ${definition.bytes} bytes but found ${metadata.size}.`, location: "assertion.bytes" });
  } else if (definition.kind === "sha256") {
    if (!/^[a-f0-9]{64}$/i.test(definition.hash)) return failure(definition, "invalid_file_assertion_hash", "The expected SHA-256 value must contain 64 hexadecimal characters.");
    const maxBytes = definition.maxBytes ?? DEFAULT_MAX_HASH_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes < 1) return failure(definition, "invalid_file_assertion_limit", "The maximum hash input size must be a positive integer.");
    if (metadata.size > maxBytes) return failure(definition, "file_assertion_too_large", `The file is ${metadata.size} bytes and exceeds the ${maxBytes} byte hash assertion limit.`);
    let content: Buffer | undefined;
    try {
      content = await readBounded(rootDirectory, target, maxBytes, signal);
    } catch (error) {
      return readFailure(definition, error);
    }
    if (content === undefined) return failure(definition, "file_assertion_too_large", `The file exceeds the ${maxBytes} byte hash assertion limit.`);
    const actual = createHash("sha256").update(content).digest("hex");
    passed = actual.toLowerCase() === definition.hash.toLowerCase();
    baseFacts.push({ name: "file.sha256", type: "string", value: actual, evidence });
    if (!passed) diagnostics.push({ code: "file_hash_mismatch", message: "The file SHA-256 value does not match the expected value.", location: "assertion.hash" });
  } else if (definition.kind === "text-contains") {
    const maxBytes = definition.maxBytes ?? DEFAULT_MAX_TEXT_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes < 1) return failure(definition, "invalid_file_assertion_limit", "The maximum text size must be a positive integer.");
    if (metadata.size > maxBytes) return failure(definition, "file_assertion_too_large", `The file is ${metadata.size} bytes and exceeds the ${maxBytes} byte text assertion limit.`);
    let content: Buffer | undefined;
    try {
      content = await readBounded(rootDirectory, target, maxBytes, signal);
    } catch (error) {
      return readFailure(definition, error);
    }
    if (content === undefined) return failure(definition, "file_assertion_too_large", `The file exceeds the ${maxBytes} byte text assertion limit.`);
    passed = content.toString("utf8").includes(definition.text);
    baseFacts.push({ name: "file.textContains", type: "boolean", value: passed, evidence });
    if (!passed) diagnostics.push({ code: "file_text_not_found", message: "The expected text was not found in the file.", location: "assertion.text" });
  }

  baseFacts.unshift({ name: "fileAssertion.passed", type: "boolean", value: passed, evidence });
  return { assertionVersion: FILE_ASSERTION_VERSION, passed, facts: baseFacts, evidence, diagnostics };
}
