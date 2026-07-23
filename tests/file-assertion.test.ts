import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateFileAssertion } from "../src/checks/file-assertion.js";

const roots: string[] = [];

const workspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hypagraph-file-assertion-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("M3.1 bounded file assertions", () => {
  it("asserts file existence and publishes typed evidence facts", async () => {
    const root = await workspace();
    await writeFile(join(root, "result.txt"), "hello", "utf8");
    const result = await evaluateFileAssertion(root, { kind: "exists", path: "result.txt" });
    expect(result.passed).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "file.exists", type: "boolean", value: true }));
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "file.sizeBytes", type: "integer", value: 5 }));
  });

  it("asserts absence without reading an external file", async () => {
    const root = await workspace();
    const result = await evaluateFileAssertion(root, { kind: "absent", path: "missing.txt" });
    expect(result.passed).toBe(true);
    expect(result.evidence).toEqual([]);
    expect(result.facts).toContainEqual({ name: "file.exists", type: "boolean", value: false });
  });

  it("fails an absence assertion when the file exists", async () => {
    const root = await workspace();
    await writeFile(join(root, "present.txt"), "x", "utf8");
    const result = await evaluateFileAssertion(root, { kind: "absent", path: "present.txt" });
    expect(result.passed).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("file_assertion_present");
  });

  it("asserts exact size", async () => {
    const root = await workspace();
    await writeFile(join(root, "size.bin"), Buffer.from([1, 2, 3]));
    expect((await evaluateFileAssertion(root, { kind: "size", path: "size.bin", bytes: 3 })).passed).toBe(true);
    const failed = await evaluateFileAssertion(root, { kind: "size", path: "size.bin", bytes: 4 });
    expect(failed.passed).toBe(false);
    expect(failed.diagnostics.map((item) => item.code)).toContain("file_size_mismatch");
  });

  it("asserts SHA-256 content hashes", async () => {
    const root = await workspace();
    const content = Buffer.from("deterministic");
    await writeFile(join(root, "hash.txt"), content);
    const hash = createHash("sha256").update(content).digest("hex");
    const result = await evaluateFileAssertion(root, { kind: "sha256", path: "hash.txt", hash });
    expect(result.passed).toBe(true);
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "file.sha256", value: hash }));
  });

  it("performs bounded UTF-8 text matching", async () => {
    const root = await workspace();
    await writeFile(join(root, "notes.md"), "alpha beta gamma", "utf8");
    expect((await evaluateFileAssertion(root, { kind: "text-contains", path: "notes.md", text: "beta" })).passed).toBe(true);
    const failed = await evaluateFileAssertion(root, { kind: "text-contains", path: "notes.md", text: "delta" });
    expect(failed.passed).toBe(false);
    expect(failed.diagnostics.map((item) => item.code)).toContain("file_text_not_found");
  });

  it("rejects text reads above the declared byte limit", async () => {
    const root = await workspace();
    await writeFile(join(root, "large.txt"), "12345", "utf8");
    const result = await evaluateFileAssertion(root, { kind: "text-contains", path: "large.txt", text: "1", maxBytes: 4 });
    expect(result.passed).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("file_assertion_too_large");
  });

  it("rejects paths outside the workspace root", async () => {
    const root = await workspace();
    const result = await evaluateFileAssertion(root, { kind: "exists", path: "../outside.txt" });
    expect(result.passed).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("file_assertion_outside_root");
  });

  it("is deterministic for unchanged repository state", async () => {
    const root = await workspace();
    await writeFile(join(root, "stable.txt"), "stable", "utf8");
    const first = await evaluateFileAssertion(root, { kind: "size", path: "stable.txt", bytes: 6 });
    const second = await evaluateFileAssertion(root, { kind: "size", path: "stable.txt", bytes: 6 });
    expect(second).toEqual(first);
  });
});
