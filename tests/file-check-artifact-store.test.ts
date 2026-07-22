import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FileCheckArtifactStore } from "../src/checks/file-artifact-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file check artifact store", () => {
  it("writes output below the configured root and returns a file reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-artifacts-"));
    roots.push(root);
    const store = new FileCheckArtifactStore(root);
    const ref = await store.write({
      workflowId: "workflow/one",
      nodeId: "tests",
      attemptId: "attempt-1",
      name: "stdout.txt",
      mediaType: "text/plain; charset=utf-8",
      content: new TextEncoder().encode("hello"),
    });

    expect(ref.startsWith("file://")).toBe(true);
    expect(await readFile(fileURLToPath(ref), "utf8")).toBe("hello");
    expect(fileURLToPath(ref).startsWith(root)).toBe(true);
  });
});
