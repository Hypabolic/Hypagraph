import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import { CommandCheckExecutor } from "../src/checks/command-executor.js";
import type { HypagraphDefinition, HypagraphState } from "../src/domain/model.js";
import { createWorkflow, replayEvents } from "../src/domain/reducer.js";
import { InMemoryWorkflowEventStore } from "../src/persistence/event-store.js";
import { formatPiCheckResult, runPiCommandCheck } from "../src/pi/check-tool.js";

const run = promisify(execFile);
const roots: string[] = [];
const at = "2026-07-23T12:20:00.000Z";

const metric = (covered: number) => ({ total: 10, covered, skipped: 0, pct: covered * 10 });
const initialVitest = {
  success: false,
  numTotalTestSuites: 1,
  numPassedTestSuites: 0,
  numFailedTestSuites: 1,
  numTotalTests: 2,
  numPassedTests: 0,
  numFailedTests: 2,
  numPendingTests: 0,
};
const passingVitest = { ...initialVitest, success: true, numPassedTestSuites: 1, numFailedTestSuites: 0, numPassedTests: 2, numFailedTests: 0 };
const initialLint = [{ filePath: "src/example.ts", errorCount: 1, warningCount: 0, fixableErrorCount: 0, fixableWarningCount: 0, messages: [{ severity: 2, ruleId: "semi" }] }];
const passingLint = [{ filePath: "src/example.ts", errorCount: 0, warningCount: 0, fixableErrorCount: 0, fixableWarningCount: 0, messages: [] }];
const coverage = (covered: number) => ({ total: { lines: metric(covered), statements: metric(covered), functions: metric(covered), branches: metric(covered) } });

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hypagraph-m3-1-dogfood-"));
  roots.push(root);
  await run("git", ["init", "-b", "dogfood"], { cwd: root });
  await run("git", ["config", "user.email", "hypagraph@example.invalid"], { cwd: root });
  await run("git", ["config", "user.name", "Hypagraph Dogfood"], { cwd: root });
  await writeFile(join(root, "vitest.json"), JSON.stringify(initialVitest), "utf8");
  await writeFile(join(root, "eslint.json"), JSON.stringify(initialLint), "utf8");
  await writeFile(join(root, "coverage-summary.json"), JSON.stringify(coverage(8)), "utf8");
  await run("git", ["add", "vitest.json", "eslint.json", "coverage-summary.json"], { cwd: root });
  await run("git", ["commit", "-m", "Initial reports"], { cwd: root });
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const testFacts = [
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

const lintFacts = [
  { name: "lint.success", type: "boolean" as const, required: true },
  { name: "lint.files.total", type: "integer" as const, required: true },
  { name: "lint.files.with-errors", type: "integer" as const, required: true },
  { name: "lint.files.with-warnings", type: "integer" as const, required: true },
  { name: "lint.errors", type: "integer" as const, required: true },
  { name: "lint.warnings", type: "integer" as const, required: true },
  { name: "lint.fixable-errors", type: "integer" as const, required: true },
  { name: "lint.fixable-warnings", type: "integer" as const, required: true },
];

const coverageFacts = [
  { name: "coverage.complete", type: "boolean" as const, required: true },
  ...["lines", "statements", "functions", "branches"].flatMap((name) => [
    { name: `coverage.${name}.total`, type: "integer" as const, required: true },
    { name: `coverage.${name}.covered`, type: "integer" as const, required: true },
    { name: `coverage.${name}.skipped`, type: "integer" as const, required: true },
    { name: `coverage.${name}.percent`, type: "number" as const, required: true },
  ]),
];

const writeCommand = (path: string, value: unknown): string =>
  `require("node:fs").writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(JSON.stringify(value))})`;

const definition = (): HypagraphDefinition => ({
  title: "M3.1 dogfood",
  goal: "Run test, lint, coverage, file, and Git checks in one deterministic workflow",
  nodes: [
    {
      id: "tests",
      title: "Produce and parse tests",
      kind: "check",
      requires: [],
      acceptance: [],
      produces: testFacts,
      check: {
        kind: "test-report",
        command: process.execPath,
        arguments: ["-e", writeCommand("vitest.json", passingVitest)],
        timeoutMs: 30_000,
        reportPath: "vitest.json",
        parser: { name: "vitest-json", version: 1 },
        namespace: "tests",
      },
    },
    {
      id: "lint",
      title: "Produce and parse lint",
      kind: "check",
      requires: ["tests"],
      acceptance: [],
      produces: lintFacts,
      check: {
        kind: "lint-report",
        command: process.execPath,
        arguments: ["-e", writeCommand("eslint.json", passingLint)],
        timeoutMs: 30_000,
        reportPath: "eslint.json",
        parser: { name: "eslint-json", version: 1 },
        namespace: "lint",
      },
    },
    {
      id: "coverage",
      title: "Produce and parse coverage",
      kind: "check",
      requires: ["lint"],
      acceptance: [],
      produces: coverageFacts,
      check: {
        kind: "coverage-report",
        command: process.execPath,
        arguments: ["-e", writeCommand("coverage-summary.json", coverage(10))],
        timeoutMs: 30_000,
        reportPath: "coverage-summary.json",
        parser: { name: "istanbul-coverage-summary", version: 1 },
        namespace: "coverage",
      },
    },
    {
      id: "artifact",
      title: "Verify report artifact",
      kind: "check",
      requires: ["coverage"],
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
        assertion: { kind: "text-contains", path: "coverage-summary.json", text: "\"pct\":100" },
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
        assertion: { kind: "changed-paths", paths: ["coverage-summary.json", "eslint.json", "vitest.json"] },
      },
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: true },
});

const execute = async (
  state: HypagraphState,
  store: InMemoryWorkflowEventStore,
  executor: CommandCheckExecutor,
  nodeId: string,
  attemptId: string,
  requestedAt: string,
) => runPiCommandCheck({ state, executor, store, nodeId, attemptId, requestedAt, signal: new AbortController().signal });

describe("M3.1 complete Pi dogfood", () => {
  it("runs every M3.1 check kind and replays the completed workflow", async () => {
    const root = await repository();
    const created = createWorkflow(definition(), at, "workflow-m3-1-dogfood");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const store = new InMemoryWorkflowEventStore();
    store.seed({ events: created.events, snapshot: created.state });
    const executor = new CommandCheckExecutor({ rootDirectory: root, artifactStore: new MemoryCheckArtifactStore() });

    const tests = await execute(created.state, store, executor, "tests", "attempt-tests", at);
    expect(tests.ok).toBe(true);
    if (!tests.ok) return;
    expect(tests.state.runtime.facts["tests.success"]?.value).toBe(true);
    expect(formatPiCheckResult(tests.state, "tests", tests.result)).toContain("Parser: vitest-json v1");

    const lint = await execute(tests.state, store, executor, "lint", "attempt-lint", "2026-07-23T12:20:01.000Z");
    expect(lint.ok).toBe(true);
    if (!lint.ok) return;
    expect(lint.state.runtime.facts["lint.success"]?.value).toBe(true);
    expect(formatPiCheckResult(lint.state, "lint", lint.result)).toContain("Parser: eslint-json v1");

    const coverageResult = await execute(lint.state, store, executor, "coverage", "attempt-coverage", "2026-07-23T12:20:02.000Z");
    expect(coverageResult.ok).toBe(true);
    if (!coverageResult.ok) return;
    expect(coverageResult.state.runtime.facts["coverage.complete"]?.value).toBe(true);
    expect(formatPiCheckResult(coverageResult.state, "coverage", coverageResult.result)).toContain("Parser: istanbul-coverage-summary v1");

    const artifact = await execute(coverageResult.state, store, executor, "artifact", "attempt-artifact", "2026-07-23T12:20:03.000Z");
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) return;
    expect(artifact.state.runtime.facts["artifact.text-contains"]?.value).toBe(true);
    expect(formatPiCheckResult(artifact.state, "artifact", artifact.result)).toContain("Assertion: text-contains");

    const repositoryResult = await execute(artifact.state, store, executor, "repository", "attempt-repository", "2026-07-23T12:20:04.000Z");
    expect(repositoryResult.ok).toBe(true);
    if (!repositoryResult.ok) return;
    expect(repositoryResult.state.phase).toBe("completed");
    expect(repositoryResult.state.runtime.facts["repository.changed-paths"]?.value).toEqual(["coverage-summary.json", "eslint.json", "vitest.json"]);
    expect(formatPiCheckResult(repositoryResult.state, "repository", repositoryResult.result)).toContain("Assertion: changed-paths");

    const persisted = store.read(repositoryResult.state.workflowId);
    expect(persisted?.snapshot).toEqual(repositoryResult.state);
    expect(replayEvents(persisted?.events ?? [])).toEqual(repositoryResult.state);
  });
});
