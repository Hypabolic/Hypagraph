import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AssertionCheckExecutor } from "../src/checks/assertion-check-executor.js";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import type { CheckExecutionRequest } from "../src/domain/model.js";

const run = promisify(execFile);
const roots: string[] = [];
const requestedAt = "2026-07-23T12:10:00.000Z";

const workspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hypagraph-assertion-executor-"));
  roots.push(root);
  return root;
};

const repository = async (): Promise<string> => {
  const root = await workspace();
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "hypagraph@example.invalid"], { cwd: root });
  await run("git", ["config", "user.name", "Hypagraph Test"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "initial\n", "utf8");
  await run("git", ["add", "tracked.txt"], { cwd: root });
  await run("git", ["commit", "-m", "Initial"], { cwd: root });
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const request = (definition: CheckExecutionRequest["definition"]): CheckExecutionRequest => ({
  workflowId: "workflow-assertion",
  revision: 1,
  nodeId: "assertion",
  attemptId: "attempt-1",
  requestedAt,
  definition,
});

describe("M3.1 assertion check executor", () => {
  it("publishes canonical file assertion facts and durable evidence", async () => {
    const root = await workspace();
    await writeFile(join(root, "output.txt"), "complete\n", "utf8");
    const store = new MemoryCheckArtifactStore();
    const executor = new AssertionCheckExecutor({
      rootDirectory: root,
      artifactStore: store,
      now: () => new Date("2026-07-23T12:10:01.000Z"),
    });

    const result = await executor.execute(request({
      kind: "file-assertion",
      version: 1,
      namespace: "artifact",
      assertion: { kind: "text-contains", path: "output.txt", text: "complete" },
    }), new AbortController().signal);

    expect(result.status).toBe("passed");
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "artifact.success", value: true }));
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "artifact.size-bytes", value: 9 }));
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "artifact.text-contains", value: true }));
    expect(result.evidence.at(-1)?.summary).toBe("Recorded file assertion evaluation.");
    expect(store.artifacts.size).toBe(1);
  });

  it("returns failed for a false assertion and error for invalid input", async () => {
    const root = await workspace();
    await writeFile(join(root, "output.txt"), "pending\n", "utf8");
    const executor = new AssertionCheckExecutor({
      rootDirectory: root,
      artifactStore: new MemoryCheckArtifactStore(),
    });

    const failed = await executor.execute(request({
      kind: "file-assertion",
      version: 1,
      namespace: "artifact",
      assertion: { kind: "text-contains", path: "output.txt", text: "complete" },
    }), new AbortController().signal);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("file_text_not_found");

    const errored = await executor.execute(request({
      kind: "file-assertion",
      version: 1,
      namespace: "artifact",
      assertion: { kind: "sha256", path: "output.txt", hash: "invalid" },
    }), new AbortController().signal);
    expect(errored.status).toBe("error");
    expect(errored.error).toContain("invalid_file_assertion_hash");
  });

  it("publishes fixed-allowlist Git assertion facts", async () => {
    const root = await repository();
    await writeFile(join(root, "tracked.txt"), "changed\n", "utf8");
    const executor = new AssertionCheckExecutor({
      rootDirectory: root,
      artifactStore: new MemoryCheckArtifactStore(),
    });

    const result = await executor.execute(request({
      kind: "git-assertion",
      version: 1,
      namespace: "repository",
      assertion: { kind: "changed-paths", paths: ["tracked.txt"] },
    }), new AbortController().signal);

    expect(result.status).toBe("passed");
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "repository.success", value: true }));
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "repository.changed-paths", value: ["tracked.txt"] }));
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "repository.changed-path-mode", value: "exact" }));
  });
});
