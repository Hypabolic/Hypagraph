import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateEvaluationIntegrity } from "../src/checks/evaluation-integrity.js";

const roots: string[] = [];
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const workspace = async (name: string): Promise<string> => {
  const root = await mkdtemp(join(process.cwd(), `.hypagraph-${name}-`));
  roots.push(root);
  await mkdir(join(root, "protected"));
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("M5A evaluator integrity hardening", () => {
  it("records cancellation without reading protected resources", async () => {
    const root = await workspace("integrity-cancelled");
    const source = "export const evaluator = 1;\n";
    await writeFile(join(root, "protected", "evaluator.mjs"), source, "utf8");
    const controller = new AbortController();
    controller.abort();

    const result = await evaluateEvaluationIntegrity(root, {
      trustLevel: "protected",
      protectedPaths: [{ path: "protected/evaluator.mjs", sha256: hash(source) }],
      git: { requireCleanWorktree: true },
    }, controller.signal);

    expect(result.observation).toMatchObject({
      status: "invalid",
      diagnosticCodes: ["integrity_evaluation_cancelled"],
      protectedEvidence: [
        { kind: "protected-file-sha256", status: "error" },
        { kind: "git-clean-worktree", status: "error" },
      ],
    });
    expect(result.evidence).toEqual([]);
  });

  it("distinguishes an expired integrity deadline from user cancellation", async () => {
    const root = await workspace("integrity-timeout");
    const source = "export const evaluator = 2;\n";
    await writeFile(join(root, "protected", "evaluator.mjs"), source, "utf8");
    const reason = new Error("The integrity deadline expired.");
    reason.name = "TimeoutError";

    const result = await evaluateEvaluationIntegrity(root, {
      trustLevel: "protected",
      protectedPaths: [{ path: "protected/evaluator.mjs", sha256: hash(source) }],
    }, AbortSignal.abort(reason));

    expect(result.observation).toMatchObject({
      status: "invalid",
      diagnosticCodes: ["integrity_evaluation_timed_out"],
      protectedEvidence: [{ kind: "protected-file-sha256", status: "error" }],
    });
  });

  it("rejects symbolic links as protected evaluator instruments", async () => {
    if (process.platform === "win32") return;
    const root = await workspace("integrity-symlink");
    const source = "export const evaluator = 3;\n";
    await writeFile(join(root, "protected", "source.mjs"), source, "utf8");
    await symlink("source.mjs", join(root, "protected", "evaluator.mjs"));

    const result = await evaluateEvaluationIntegrity(root, {
      trustLevel: "protected",
      protectedPaths: [{ path: "protected/evaluator.mjs", sha256: hash(source) }],
    });

    expect(result.observation).toMatchObject({
      status: "invalid",
      diagnosticCodes: ["integrity_protected_file_symlink"],
      protectedEvidence: [{ kind: "protected-file-sha256", status: "error" }],
    });
  });
});
