import { describe, expect, it } from "vitest";
import { createWorkflow } from "../src/domain/reducer.js";
import { normalizeDefinition, type HypagraphDefineInput } from "../src/pi/definition.js";

const at = "2026-07-23T12:00:00.000Z";

const fileFacts = [
  { name: "artifact.success", type: "boolean" as const, required: true },
  { name: "artifact.kind", type: "string" as const, required: true },
  { name: "artifact.path", type: "string" as const, required: true },
  { name: "artifact.exists", type: "boolean" as const },
  { name: "artifact.size-bytes", type: "integer" as const },
  { name: "artifact.text-contains", type: "boolean" as const },
];

const gitFacts = [
  { name: "repository.success", type: "boolean" as const, required: true },
  { name: "repository.kind", type: "string" as const, required: true },
  { name: "repository.changed-paths", type: "string-list" as const },
  { name: "repository.expected-changed-paths", type: "string-list" as const },
  { name: "repository.changed-path-mode", type: "string" as const },
];

describe("Pi assertion check definitions", () => {
  it("normalizes and validates a file assertion check", () => {
    const input: HypagraphDefineInput = {
      title: "Assert artifact",
      goal: "Verify the generated artifact",
      nodes: [{
        id: "artifact",
        title: "Check artifact",
        kind: "check",
        requires: [],
        acceptance: [],
        produces: fileFacts,
        check: {
          kind: "file-assertion",
          version: 1,
          namespace: "artifact",
          assertion: { kind: "text-contains", path: "output.txt", text: "complete", maxBytes: 1024 },
          retry: { maxAttempts: 2, retryOn: ["failed", "error"] },
        },
      }],
    };

    const normalized = normalizeDefinition(input);
    expect(normalized.nodes[0]?.check).toEqual(expect.objectContaining({
      kind: "file-assertion",
      version: 1,
      namespace: "artifact",
      assertion: { kind: "text-contains", path: "output.txt", text: "complete", maxBytes: 1024 },
    }));
    expect(createWorkflow(normalized, at, "workflow-file-assertion").ok).toBe(true);
  });

  it("normalizes and validates a fixed-allowlist Git assertion check", () => {
    const input: HypagraphDefineInput = {
      title: "Assert repository",
      goal: "Verify changed paths",
      nodes: [{
        id: "repository",
        title: "Check repository",
        kind: "check",
        requires: [],
        acceptance: [],
        produces: gitFacts,
        check: {
          kind: "git-assertion",
          version: 1,
          namespace: "repository",
          assertion: { kind: "changed-paths", paths: ["src/index.ts"], mode: "contains" },
        },
      }],
    };

    const normalized = normalizeDefinition(input);
    expect(normalized.nodes[0]?.check).toEqual(expect.objectContaining({
      kind: "git-assertion",
      version: 1,
      namespace: "repository",
      assertion: { kind: "changed-paths", paths: ["src/index.ts"], mode: "contains" },
    }));
    expect(createWorkflow(normalized, at, "workflow-git-assertion").ok).toBe(true);
  });

  it("deep clones assertion definitions and retry policies", () => {
    const input: HypagraphDefineInput = {
      title: "Clone assertions",
      goal: "Keep assertion definitions immutable",
      nodes: [{
        id: "repository",
        title: "Repository",
        kind: "check",
        requires: [],
        acceptance: [],
        produces: gitFacts,
        check: {
          kind: "git-assertion",
          version: 1,
          namespace: "repository",
          assertion: { kind: "changed-paths", paths: ["src/index.ts"] },
          retry: { maxAttempts: 2, retryOn: ["failed"] },
        },
      }],
    };

    const normalized = normalizeDefinition(input);
    const check = input.nodes[0]!.check!;
    if (check.kind !== "git-assertion" || check.assertion.kind !== "changed-paths") return;
    check.assertion.paths[0] = "changed.ts";
    check.retry!.retryOn[0] = "error";

    const normalizedCheck = normalized.nodes[0]!.check!;
    expect(normalizedCheck.kind).toBe("git-assertion");
    if (normalizedCheck.kind !== "git-assertion" || normalizedCheck.assertion.kind !== "changed-paths") return;
    expect(normalizedCheck.assertion.paths).toEqual(["src/index.ts"]);
    expect(normalizedCheck.retry?.retryOn).toEqual(["failed"]);
  });

  it("rejects incomplete assertion fact contracts", () => {
    const input: HypagraphDefineInput = {
      title: "Bad assertion contract",
      goal: "Reject phantom facts",
      nodes: [{
        id: "artifact",
        title: "Artifact",
        kind: "check",
        requires: [],
        acceptance: [],
        produces: [{ name: "artifact.success", type: "boolean", required: true }],
        check: {
          kind: "file-assertion",
          version: 1,
          namespace: "artifact",
          assertion: { kind: "exists", path: "output.txt" },
        },
      }],
    };

    const result = createWorkflow(normalizeDefinition(input), at, "workflow-invalid-assertion");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("assertion_fact_contract_missing");
  });
});
