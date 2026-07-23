import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { Diagnostic, EvidenceReference, FactInput } from "../domain/model.js";

export const FILE_ASSERTION_VERSION = 1 as const;

export type FileAssertionDefinition =
  | { kind: "exists"; path: string }
  | { kind: "absent"; path: string }
  | { kind: "size"; path: string; bytes: number }
  | { kind: "sha256"; path: string; hash: string }
  | { kind: "text-contains"; path: string; text: string; maxBytes?: number };

export interface FileAssertionResult {
  assertionVersion: typeof FILE_ASSERTION_VERSION;
  passed: boolean;
  facts: FactInput[];
  evidence: EvidenceReference[];
  diagnostics: Diagnostic[];
}

const DEFAULT_MAX_TEXT_BYTES = 1_048_576;

const insideRoot = (rootDirectory: string, path: string): string => {
  const root = resolve(rootDirectory);
  const target = resolve(root, path);
  const local = relative(root, target);
  if (local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("The asserted file path is outside the configured workspace root.");
  }
  return target;
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

export async function evaluateFileAssertion(
  rootDirectory: string,
  definition: FileAssertionDefinition,
): Promise<FileAssertionResult> {
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
    const content = await readFile(target);
    const actual = createHash("sha256").update(content).digest("hex");
    passed = actual.toLowerCase() === definition.hash.toLowerCase();
    baseFacts.push({ name: "file.sha256", type: "string", value: actual, evidence });
    if (!passed) diagnostics.push({ code: "file_hash_mismatch", message: "The file SHA-256 value does not match the expected value.", location: "assertion.hash" });
  } else if (definition.kind === "text-contains") {
    const maxBytes = definition.maxBytes ?? DEFAULT_MAX_TEXT_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes < 1) return failure(definition, "invalid_file_assertion_limit", "The maximum text size must be a positive integer.");
    if (metadata.size > maxBytes) return failure(definition, "file_assertion_too_large", `The file is ${metadata.size} bytes and exceeds the ${maxBytes} byte text assertion limit.`);
    const content = await readFile(target, "utf8");
    passed = content.includes(definition.text);
    baseFacts.push({ name: "file.textContains", type: "boolean", value: passed, evidence });
    if (!passed) diagnostics.push({ code: "file_text_not_found", message: "The expected text was not found in the file.", location: "assertion.text" });
  }

  baseFacts.unshift({ name: "fileAssertion.passed", type: "boolean", value: passed, evidence });
  return { assertionVersion: FILE_ASSERTION_VERSION, passed, facts: baseFacts, evidence, diagnostics };
}
