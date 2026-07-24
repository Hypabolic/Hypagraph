import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCheckArtifactStore } from "../src/checks/artifacts.js";
import {
  LOCAL_COMMAND_REPORT_EVALUATOR_ADAPTER,
  LocalCommandReportEvaluatorAdapter,
  type EvaluatorAdapter,
} from "../src/checks/evaluator-adapter.js";
import { ReportCheckExecutor } from "../src/checks/report-check-executor.js";
import type {
  CheckExecutionRequest,
  CheckExecutor,
  CheckResult,
  MetricReportCheckDefinition,
} from "../src/domain/model.js";

const roots: string[] = [];
const at = "2026-07-24T05:30:00.000Z";

const workspace = async (): Promise<string> => {
  const root = await mkdtemp(join(process.cwd(), ".hypagraph-evaluator-adapter-"));
  roots.push(root);
  await mkdir(join(root, "reports"));
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const definition = (): MetricReportCheckDefinition => ({
  kind: "metric-report",
  command: "private-evaluator",
  arguments: ["--hidden-answer", "do-not-expose"],
  timeoutMs: 30_000,
  reportPath: "reports/metric.json",
  parser: { name: "metric-json", version: 1 },
  mappings: [{ source: "score", fact: "evaluation.score", type: "number" }],
  evaluation: {
    kind: "development",
    feedback: { mode: "aggregate" },
    integrity: {
      trustLevel: "transparent",
      evaluatorVersion: { value: "adapter-test-1" },
    },
  },
});

const request = (check: MetricReportCheckDefinition): CheckExecutionRequest => ({
  workflowId: "workflow-adapter",
  revision: 1,
  nodeId: "evaluate",
  attemptId: "evaluation-1",
  requestedAt: at,
  definition: check,
});

const passedProducer = (): CheckResult => ({
  checkKind: "command",
  attemptId: "evaluation-1",
  startedAt: at,
  completedAt: "2026-07-24T05:30:01.000Z",
  status: "passed",
  exitCode: 0,
  facts: [],
  evidence: [{ ref: "memory://private-output", kind: "file", summary: "Private evaluator output." }],
  stdoutRef: "memory://private-output",
});

describe("M5A evaluator adapter contract", () => {
  it("uses the local command-report adapter as the source-compatible reference transport", async () => {
    const root = await workspace();
    await writeFile(join(root, "reports", "metric.json"), JSON.stringify({ schemaVersion: 1, score: 0.75 }), "utf8");
    const producer: CheckExecutor = { execute: vi.fn(async () => passedProducer()) };
    const adapter = new LocalCommandReportEvaluatorAdapter({ rootDirectory: root, producerExecutor: producer });

    const response = await adapter.evaluate({
      profile: LOCAL_COMMAND_REPORT_EVALUATOR_ADAPTER,
      workflowId: "workflow-adapter",
      revision: 1,
      nodeId: "evaluate",
      attemptId: "evaluation-1",
      requestedAt: at,
      definition: definition(),
    }, new AbortController().signal);

    expect(response.outcome).toBe("report");
    if (response.outcome !== "report") throw new Error("The local adapter did not return a report.");
    expect(new TextDecoder().decode(response.report.content)).toContain('"score":0.75');
    expect(response.trust).toEqual({
      adapterId: "local-command-report",
      adapterVersion: 1,
      profile: "local-command-report",
      boundary: "local-workspace",
      trustLevel: "transparent",
      isolated: false,
    });
    const trustText = JSON.stringify(response.trust);
    expect(trustText).not.toContain("do-not-expose");
    expect(trustText).not.toContain("reports/metric.json");
  });

  it("keeps parsing and canonical result production independent from evaluator transport", async () => {
    const root = await workspace();
    const evaluate = vi.fn(async () => ({
      outcome: "report" as const,
      producer: passedProducer(),
      report: {
        name: "isolated-result.json",
        mediaType: "application/json; charset=utf-8" as const,
        content: new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, score: 0.91, hiddenCase: "secret-case-7" })),
      },
      trust: {
        adapterId: "fake-isolated",
        adapterVersion: 7,
        profile: "test-isolated",
        boundary: "isolated" as const,
        trustLevel: "isolated" as const,
        isolated: true,
      },
    }));
    const adapter: EvaluatorAdapter = { id: "fake-isolated", version: 7, evaluate };
    const result = await new ReportCheckExecutor({
      rootDirectory: root,
      artifactStore: new MemoryCheckArtifactStore(),
      evaluatorAdapter: adapter,
      producerExecutor: { execute: vi.fn(async () => { throw new Error("The injected adapter must own evaluator transport."); }) },
      now: () => new Date("2026-07-24T05:30:02.000Z"),
    }).execute(request(definition()), new AbortController().signal);

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("passed");
    expect(result.facts).toContainEqual(expect.objectContaining({ name: "evaluation.score", value: 0.91 }));
    expect(result.evidence).toContainEqual(expect.objectContaining({
      ref: "evaluator-adapter://fake-isolated/7",
      visibility: "protected",
    }));
    expect(JSON.stringify(result.evaluation)).not.toContain("secret-case-7");
    expect(JSON.stringify(result.facts)).not.toContain("secret-case-7");
  });

  it("propagates cancellation through the adapter boundary", async () => {
    const root = await workspace();
    const execute = vi.fn(async (input: CheckExecutionRequest, signal: AbortSignal): Promise<CheckResult> => ({
      checkKind: "command",
      attemptId: input.attemptId,
      startedAt: input.requestedAt,
      completedAt: input.requestedAt,
      status: signal.aborted ? "cancelled" : "passed",
      facts: [],
      evidence: [],
    }));
    const adapter = new LocalCommandReportEvaluatorAdapter({ rootDirectory: root, producerExecutor: { execute } });
    const controller = new AbortController();
    controller.abort();

    const response = await adapter.evaluate({
      profile: LOCAL_COMMAND_REPORT_EVALUATOR_ADAPTER,
      workflowId: "workflow-adapter",
      revision: 1,
      nodeId: "evaluate",
      attemptId: "evaluation-1",
      requestedAt: at,
      definition: definition(),
    }, controller.signal);

    expect(response.outcome).toBe("producer-terminal");
    expect(response.producer.status).toBe("cancelled");
    expect(execute).toHaveBeenCalledWith(expect.anything(), controller.signal);
  });
});
