import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import { CommandCheckExecutor } from "../src/checks/command-executor.js";
import type { CheckExecutionRequest, CommandCheckDefinition } from "../src/domain/model.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const root = async (): Promise<string> => {
  const value = await mkdtemp(join(tmpdir(), "hypagraph-check-"));
  roots.push(value);
  return value;
};

const request = (definition: CommandCheckDefinition): CheckExecutionRequest => ({
  workflowId: "workflow-command-runner",
  revision: 1,
  nodeId: "run-command",
  attemptId: "attempt-1",
  requestedAt: "2026-07-22T09:00:00.000Z",
  definition,
});

const command = (script: string, overrides: Partial<CommandCheckDefinition> = {}): CommandCheckDefinition => ({
  kind: "command",
  command: process.execPath,
  arguments: ["-e", script],
  timeoutMs: 2_000,
  publish: [],
  ...overrides,
});

describe("M3 command check executor", () => {
  it("spawns a command without a shell and stores stdout and stderr", async () => {
    const workspace = await root();
    const artifacts = new MemoryCheckArtifactStore();
    const executor = new CommandCheckExecutor({ rootDirectory: workspace, artifactStore: artifacts });

    const result = await executor.execute(request(command("process.stdout.write('out'); process.stderr.write('err')")), new AbortController().signal);

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.stdoutRef).toBeDefined();
    expect(result.stderrRef).toBeDefined();
    expect(new TextDecoder().decode(artifacts.artifacts.get(result.stdoutRef!)?.content)).toBe("out");
    expect(new TextDecoder().decode(artifacts.artifacts.get(result.stderrRef!)?.content)).toBe("err");
  });

  it("uses the declared expected exit codes", async () => {
    const workspace = await root();
    const executor = new CommandCheckExecutor({ rootDirectory: workspace, artifactStore: new MemoryCheckArtifactStore() });

    const passed = await executor.execute(request(command("process.exit(3)", { expectedExitCodes: [3] })), new AbortController().signal);
    const failed = await executor.execute(request(command("process.exit(3)", { expectedExitCodes: [0] })), new AbortController().signal);

    expect(passed.status).toBe("passed");
    expect(failed.status).toBe("failed");
    expect(failed.exitCode).toBe(3);
  });

  it("terminates a command after its timeout", async () => {
    const workspace = await root();
    const executor = new CommandCheckExecutor({ rootDirectory: workspace, artifactStore: new MemoryCheckArtifactStore(), killGraceMs: 10 });

    const result = await executor.execute(request(command("setTimeout(() => {}, 10_000)", { timeoutMs: 20 })), new AbortController().signal);

    expect(result.status).toBe("timed_out");
    expect(result.error).toContain("timeout");
  });

  it("terminates a command when the caller cancels", async () => {
    const workspace = await root();
    const executor = new CommandCheckExecutor({ rootDirectory: workspace, artifactStore: new MemoryCheckArtifactStore(), killGraceMs: 10 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const result = await executor.execute(request(command("setTimeout(() => {}, 10_000)")), controller.signal);

    expect(result.status).toBe("cancelled");
  });

  it("bounds captured output and marks truncated evidence", async () => {
    const workspace = await root();
    const artifacts = new MemoryCheckArtifactStore();
    const executor = new CommandCheckExecutor({ rootDirectory: workspace, artifactStore: artifacts, maxOutputBytes: 8 });

    const result = await executor.execute(request(command("process.stdout.write('abcdefghijklmnop')")), new AbortController().signal);

    const stored = artifacts.artifacts.get(result.stdoutRef!);
    expect(stored?.content.byteLength).toBe(8);
    expect(result.evidence[0]?.summary).toContain("truncated");
  });

  it("rejects a working directory outside the configured root", async () => {
    const workspace = await root();
    const executor = new CommandCheckExecutor({ rootDirectory: workspace, artifactStore: new MemoryCheckArtifactStore() });

    const result = await executor.execute(request(command("process.exit(0)", { workingDirectory: "../outside" })), new AbortController().signal);

    expect(result.status).toBe("error");
    expect(result.error).toContain("outside");
  });
});
