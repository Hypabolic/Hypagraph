import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateGitAssertion } from "../src/checks/git-assertion.js";

const run = promisify(execFile);
const roots: string[] = [];

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hypagraph-git-assertion-"));
  roots.push(root);
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

describe("M3.1 fixed allowlist Git assertions", () => {
  it("asserts a clean repository", async () => {
    const root = await repository();
    const result = await evaluateGitAssertion(root, { kind: "clean" });
    expect(result.passed).toBe(true);
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "git.clean", value: true }));
  });

  it("reports changed and untracked paths for a dirty repository", async () => {
    const root = await repository();
    await writeFile(join(root, "tracked.txt"), "changed\n", "utf8");
    await writeFile(join(root, "untracked.txt"), "new\n", "utf8");
    const result = await evaluateGitAssertion(root, { kind: "clean" });
    expect(result.passed).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("git_worktree_dirty");
  });

  it("asserts the current branch", async () => {
    const root = await repository();
    expect((await evaluateGitAssertion(root, { kind: "branch", name: "main" })).passed).toBe(true);
    const failed = await evaluateGitAssertion(root, { kind: "branch", name: "feature" });
    expect(failed.passed).toBe(false);
    expect(failed.diagnostics.map((item) => item.code)).toContain("git_branch_mismatch");
  });

  it("asserts full or abbreviated revisions", async () => {
    const root = await repository();
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: root });
    const revision = stdout.trim();
    expect((await evaluateGitAssertion(root, { kind: "revision", sha: revision })).passed).toBe(true);
    expect((await evaluateGitAssertion(root, { kind: "revision", sha: revision.slice(0, 8) })).passed).toBe(true);
  });

  it("asserts exact and containing changed-path sets", async () => {
    const root = await repository();
    await writeFile(join(root, "tracked.txt"), "changed\n", "utf8");
    await writeFile(join(root, "other.txt"), "other\n", "utf8");
    await run("git", ["add", "other.txt"], { cwd: root });
    const exact = await evaluateGitAssertion(root, { kind: "changed-paths", paths: ["other.txt", "tracked.txt"] });
    expect(exact.passed).toBe(true);
    const contains = await evaluateGitAssertion(root, { kind: "changed-paths", paths: ["tracked.txt"], mode: "contains" });
    expect(contains.passed).toBe(true);
  });

  it("rejects arbitrary or escaping changed paths", async () => {
    const root = await repository();
    const result = await evaluateGitAssertion(root, { kind: "changed-paths", paths: ["../outside"] });
    expect(result.passed).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("invalid_git_changed_path");
  });

  it("fails cleanly outside a Git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "hypagraph-not-git-"));
    roots.push(root);
    const result = await evaluateGitAssertion(root, { kind: "clean" });
    expect(result.passed).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("git_assertion_failed");
  });

  it("is deterministic for unchanged repository state", async () => {
    const root = await repository();
    const first = await evaluateGitAssertion(root, { kind: "branch", name: "main" });
    const second = await evaluateGitAssertion(root, { kind: "branch", name: "main" });
    expect(second).toEqual(first);
  });
});
