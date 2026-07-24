import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import { evaluateEvaluationIntegrity } from "../src/checks/evaluation-integrity.js";
import { ReportCheckExecutor } from "../src/checks/report-check-executor.js";
import type { CheckExecutionRequest, CheckExecutor, CheckResult, HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow } from "../src/domain/reducer.js";
import { formatPiCheckResult } from "../src/pi/check-runner.js";

const exec = promisify(execFile);
const roots: string[] = [];
const at = "2026-07-24T01:10:00.000Z";
const fileHash = (value: string): string => createHash("sha256").update(value).digest("hex");

const workspace = async (name: string): Promise<string> => {
  const root = await mkdtemp(join(process.cwd(), `.hypagraph-${name}-`));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const producer = (): CheckExecutor => ({
  execute: vi.fn(async (request): Promise<CheckResult> => ({
    checkKind: "command",
    attemptId: request.attemptId,
    startedAt: request.requestedAt,
    completedAt: "2026-07-24T01:10:01.000Z",
    status: "passed",
    exitCode: 0,
    facts: [],
    evidence: [{ ref: "memory://private-command-output", kind: "file", summary: "Command output." }],
    stdoutRef: "memory://private-command-output",
  })),
});

const metricDefinition = (hash: string, secretPath = "private/evaluator.mjs"): HypagraphDefinition => ({
  title: "Protected evaluator",
  goal: "Accept an evaluator result with verified integrity",
  nodes: [{
    id: "evaluate",
    title: "Evaluate",
    kind: "check",
    requires: [],
    acceptance: [],
    produces: [
      { name: "evaluation.score", type: "number", required: true },
      { name: "evaluation.version", type: "string", required: true },
    ],
    check: {
      kind: "metric-report",
      command: "private-evaluator",
      arguments: ["--private-answer", "do-not-expose"],
      timeoutMs: 30_000,
      reportPath: "private/metric.json",
      parser: { name: "metric-json", version: 1 },
      mappings: [{ source: "score", fact: "evaluation.score", type: "number" }],
      evaluation: {
        kind: "development",
        feedback: { mode: "aggregate" },
        integrity: {
          trustLevel: "protected",
          protectedPaths: [{ path: secretPath, sha256: hash, maxBytes: 1_024 }],
          evaluatorVersion: { value: "evaluator-7", fact: "evaluation.version" },
        },
      },
    },
  }],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

describe("M5A evaluator integrity execution", () => {
  it("verifies protected SHA-256 state and fails safely for changed, missing, and oversized files", async () => {
    const root = await workspace("integrity-file");
    await mkdir(join(root, "private"));
    const path = join(root, "private", "evaluator.mjs");
    await writeFile(path, "export const score = 1;\n", "utf8");
    const expected = fileHash("export const score = 1;\n");
    const definition = {
      trustLevel: "protected" as const,
      protectedPaths: [{ path: "private/evaluator.mjs", sha256: expected, maxBytes: 64 }],
    };

    const matching = await evaluateEvaluationIntegrity(root, definition);
    expect(matching.observation).toMatchObject({
      version: 1,
      trustLevel: "protected",
      status: "valid",
      diagnosticCodes: [],
      protectedEvidence: [{ kind: "protected-file-sha256", status: "verified" }],
    });
    expect(matching.observation.evaluatorFingerprint).toMatch(/^[a-f0-9]{64}$/);

    await writeFile(path, "export const score = 2;\n", "utf8");
    const changed = await evaluateEvaluationIntegrity(root, definition);
    expect(changed.observation).toMatchObject({
      status: "invalid",
      diagnosticCodes: ["integrity_protected_file_hash_mismatch"],
      protectedEvidence: [{ status: "mismatch" }],
    });

    await rm(path);
    const missing = await evaluateEvaluationIntegrity(root, definition);
    expect(missing.observation).toMatchObject({
      status: "invalid",
      diagnosticCodes: ["integrity_protected_file_missing"],
    });

    await writeFile(path, "x".repeat(65), "utf8");
    const oversized = await evaluateEvaluationIntegrity(root, definition);
    expect(oversized.observation).toMatchObject({
      status: "invalid",
      diagnosticCodes: ["integrity_protected_file_read_limit"],
      protectedEvidence: [{ status: "error" }],
    });
  });

  it("uses exact Git revisions and proves only declared protected paths unchanged", async () => {
    const root = await workspace("integrity-git");
    await mkdir(join(root, "protected"));
    const evaluatorPath = join(root, "protected", "evaluator.mjs");
    await writeFile(evaluatorPath, "export const score = 1;\n", "utf8");
    await writeFile(join(root, "allowed.txt"), "initial\n", "utf8");
    await exec("git", ["init", "--quiet"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await exec("git", ["config", "user.name", "Hypagraph Test"], { cwd: root });
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["commit", "--quiet", "-m", "Create evaluator"], { cwd: root });
    const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const expected = fileHash("export const score = 1;\n");
    const definition = {
      trustLevel: "protected" as const,
      protectedPaths: [{ path: "protected\\evaluator.mjs", sha256: expected }],
      git: {
        expectedRevision: revision,
        protectedPathsUnchangedFrom: revision,
      },
    };

    const matching = await evaluateEvaluationIntegrity(root, definition);
    expect(matching.observation.status).toBe("valid");
    expect(matching.observation.protectedEvidence).toEqual([
      { kind: "protected-file-sha256", status: "verified" },
      { kind: "git-exact-revision", status: "verified" },
      { kind: "git-protected-paths-unchanged", status: "verified" },
    ]);

    await writeFile(join(root, "allowed.txt"), "permitted worktree change\n", "utf8");
    expect((await evaluateEvaluationIntegrity(root, definition)).observation.status).toBe("valid");

    await writeFile(evaluatorPath, "export const score = 9;\n", "utf8");
    const changed = await evaluateEvaluationIntegrity(root, definition);
    expect(changed.observation.diagnosticCodes).toEqual([
      "integrity_git_protected_paths_changed",
      "integrity_protected_file_hash_mismatch",
    ]);
    expect(JSON.stringify(changed.observation)).not.toContain("protected/evaluator.mjs");
    expect(JSON.stringify(changed.observation)).not.toContain("permitted worktree change");

    await writeFile(evaluatorPath, "export const score = 1;\n", "utf8");
    await exec("git", ["add", "allowed.txt"], { cwd: root });
    await exec("git", ["commit", "--quiet", "-m", "Change an unrelated path"], { cwd: root });
    const revisionMismatch = await evaluateEvaluationIntegrity(root, definition);
    expect(revisionMismatch.observation).toMatchObject({
      status: "invalid",
      diagnosticCodes: ["integrity_git_revision_mismatch"],
    });
    expect(revisionMismatch.observation.protectedEvidence[2]).toEqual({
      kind: "git-protected-paths-unchanged",
      status: "verified",
    });
  });

  it("persists normalized integrity without exposing protected evaluator data", async () => {
    const root = await workspace("integrity-report");
    await mkdir(join(root, "private"));
    const source = "export const privateAnswer = 42;\n";
    await writeFile(join(root, "private", "evaluator.mjs"), source, "utf8");
    await writeFile(join(root, "private", "metric.json"), JSON.stringify({ schemaVersion: 1, score: 0.9, privateAnswer: "do-not-expose" }), "utf8");
    const definition = metricDefinition(fileHash(source));
    const created = createWorkflow(definition, at, "workflow-integrity-report");
    if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
    const request: CheckExecutionRequest = {
      workflowId: created.state.workflowId,
      revision: 1,
      nodeId: "evaluate",
      attemptId: "evaluation-1",
      requestedAt: at,
      definition: definition.nodes[0]!.check!,
    };
    const result = await new ReportCheckExecutor({
      rootDirectory: root,
      artifactStore: new MemoryCheckArtifactStore(),
      producerExecutor: producer(),
      now: () => new Date("2026-07-24T01:10:02.000Z"),
    }).execute(request, new AbortController().signal);

    expect(result.evaluation?.integrity).toMatchObject({
      status: "valid",
      evaluatorVersion: "evaluator-7",
      diagnosticCodes: [],
    });
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "evaluation.version", value: "evaluator-7" }));
    expect(result.facts.find((item) => item.name === "evaluation.score")?.evidence).toEqual([]);
    expect(result.evidence.every((item) => item.visibility === "protected")).toBe(true);

    const integrityText = JSON.stringify(result.evaluation?.integrity);
    expect(integrityText).not.toContain("private/evaluator.mjs");
    expect(integrityText).not.toContain(fileHash(source));
    expect(integrityText).not.toContain("privateAnswer");

    const piText = formatPiCheckResult(created.state, "evaluate", result);
    expect(piText).toContain("Command: protected evaluator command");
    expect(piText).toContain("Evaluator trust: protected");
    expect(piText).toContain("Evaluator integrity: valid");
    expect(piText).not.toContain("--private-answer");
    expect(piText).not.toContain("do-not-expose");
    expect(piText).not.toContain("private/evaluator.mjs");
    expect(piText).not.toContain(fileHash(source));
  });
});
