import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import { CommandCheckExecutor } from "../src/checks/command-executor.js";
import type { HypagraphDefinition } from "../src/domain/model.js";
import { createWorkflow, replayEvents } from "../src/domain/reducer.js";
import { InMemoryWorkflowEventStore } from "../src/persistence/event-store.js";
import { formatPiCheckResult, runPiCommandCheck } from "../src/pi/check-tool.js";

const run = promisify(execFile);
const roots: string[] = [];
const at = "2026-07-23T12:20:00.000Z";

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hypagraph-m3-1-dogfood-"));
  roots.push(root);
  await run("git", ["init", "-b", "dogfood"], { cwd: root });
  await run("git", ["config", "user.email", "hypagraph@example.invalid"], { cwd: root });
  await run("git", ["config", "user.name", "Hypagraph Dogfood"], { cwd: root });
  await writeFile(join(root, "vitest.json"), JSON.stringify({
    success: false,
    numTotalTestSuites: 1,
    numPassedTestSuites: 0,
    numFailedTestSuites: 1,
    numTotalTests: 2,
    numPassedTests: 0,
    numFailedTests: 2,
    numPendingTests: 0,
  }), "utf8");
  await run("git", ["add", "vitest.json"], { cwd: root });
  await run("git", ["commit", "-m", "Initial report"], { cwd: root });
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const reportFacts = [
  { name: "tests.success", type: "boolean" as const, required: true },
  { name: "tests.suites.total", type: "integer" as const, required: true },
  { name: "tests.suites.passed", type: "integer" as const, required: true },
  { name: "tests.suites.failed", type: "integer" as const, required: true },
  { name: "tests.total", type: "integer" as const, required: true },
  { name: "tests.passed", type: "integer" as const, required: true },
  { name: "tests.failed", type: "integer" as const, required: true },
  { name: "tests.skipped", type: "integer" as const, required: true },
  { name: "tests.duration-ms", type: "number" as const, required: false },
];

const definition = (): HypagraphDefinition => ({
  title: "M3.1 dogfood",
  goal: "Run deterministic report, file, and Git checks in one workflow",
  nodes: [
    {
      id: "tests",
      title: "Produce and parse tests",
      kind: "check",
      requires: [],
      acceptance: [],
      produces: reportFacts,
      check: {
        kind: "test-report",
        command: process.execPath,
        arguments: ["-e", `require("node:fs").writeFileSync("vitest.json", JSON.stringify({success:true,numTotalTestSuites:1,numPassedTestSuites:1,numFailedTestSuites:0,numTotalTests:2,numPassedTests:2,numFailedTests:0,numPendingTests:0}))`],
        timeoutMs: 30_000,
        reportPath: "vitest.json",
        parser: { name: "vitest-json", version: 1 },
        namespace: "tests",
      },
    },
    {
      id: "artifact",
      title: "Verify report artifact",
      kind: "check",
      requires: ["tests"],
      acceptance: [],
      produces: [
        { name: "artifact.success", type: "boolean", required: true },
        { name: "artifact.kind", type: "string", required: true },
        { name: "artifact.path", type: "string", required: true },
        { name: "artifact.exists", type: "boolean" },
        { name: "artifact.size-bytes", type: "integer" },
        { name: "artifact.text-contains", type: "boolean" },
      ],
      check: {
        kind: "file-assertion",
        version: 1,
        namespace: "artifact",
        assertion: { kind: "text-contains", path: "vitest.json", text: "\"success\":true" },
      },
    },
    {
      id: "repository",
      title: "Verify repository changes",
      kind: "check",
      requires: ["artifact"],
      acceptance: [],
      produces: [
        { name: "repository.success", type: "boolean", required: true },
        { name: "repository.kind", type: "string", required: true },
        { name: "repository.changed-paths", type: "string-list" },
        { name: "repository.expected-changed-paths", type: "string-list" },
        { name: "repository.changed-path-mode", type: "string" },
      ],
      check: {
        kind: "git-assertion",
        version: 1,
        namespace: "repository",
        assertion: { kind: "changed-paths", paths: ["vitest.json"] },
      },
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: true },
});

describe("M3.1 representative Pi dogfood", () => {
  it("runs report, file, and Git checks and replays the completed workflow", async () => {
    const root = await repository();
    const created = createWorkflow(definition(), at, "workflow-m3-1-dogfood");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: created.events, snapshot: created.state });
    const executor = new CommandCheckExecutor({
      rootDirectory: root,
      artifactStore: new MemoryCheckArtifactStore(),
    });

    const tests = await runPiCommandCheck({
      state: created.state,
      executor,
      store,
      nodeId: "tests",
      attemptId: "attempt-tests",
      requestedAt: at,
      signal: new AbortController().signal,
    });
    expect(tests.ok).toBe(true);
    if (!tests.ok) return;
    expect(tests.state.runtime.facts["tests.success"]?.value).toBe(true);
    expect(formatPiCheckResult(tests.state, "tests", tests.result)).toContain("Parser: vitest-json v1");

    const artifact = await runPiCommandCheck({
      state: tests.state,
      executor,
      store,
      nodeId: "artifact",
      attemptId: "attempt-artifact",
      requestedAt: "2026-07-23T12:20:01.000Z",
      signal: new AbortController().signal,
    });
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) return;
    expect(artifact.state.runtime.facts["artifact.text-contains"]?.value).toBe(true);
    expect(formatPiCheckResult(artifact.state, "artifact", artifact.result)).toContain("Assertion: text-contains");

    const repositoryResult = await runPiCommandCheck({
      state: artifact.state,
      executor,
      store,
      nodeId: "repository",
      attemptId: "attempt-repository",
      requestedAt: "2026-07-23T12:20:02.000Z",
      signal: new AbortController().signal,
    });
    expect(repositoryResult.ok).toBe(true);
    if (!repositoryResult.ok) return;
    expect(repositoryResult.state.phase).toBe("completed");
    expect(repositoryResult.state.runtime.facts["repository.changed-paths"]?.value).toEqual(["vitest.json"]);
    expect(formatPiCheckResult(repositoryResult.state, "repository", repositoryResult.result)).toContain("Assertion: changed-paths");

    const persisted = store.read(repositoryResult.state.workflowId);
    expect(persisted?.snapshot).toEqual(repositoryResult.state);
    expect(replayEvents(persisted?.events ?? [])).toEqual(repositoryResult.state);
  });
});
