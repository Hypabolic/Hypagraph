import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import hypagraphExtension from "../src/extension.js";
import {
  createEmptyDraft,
  draftMatchesCreationRequest,
  validateDraftCommitIdentity,
} from "../src/domain/draft.js";
import { applyImplementVerifyLoopRecipe } from "../src/domain/draft-recipes.js";
import { draftHistoryPath, workflowDefinitionPath, workflowMetaPath } from "../src/project-store/paths.js";
import { HypagraphProjectStore } from "../src/project-store/index.js";
import { withCurrentSessionTaskProfile } from "./helpers/current-session-task.js";

interface ToolDefinition {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<Record<string, unknown>>;
}

interface CommandDefinition {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const harness = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hypagraph-w7-"));
  tempDirs.push(cwd);
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const entries: unknown[] = [];
  const sendUserMessage = vi.fn();
  const pi = {
    on: vi.fn(),
    registerTool: vi.fn((tool: ToolDefinition) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: CommandDefinition) => commands.set(name, command)),
    appendEntry: vi.fn((customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    sendUserMessage,
    getActiveTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: false,
    mode: "rpc",
    ui: {
      confirm: vi.fn(),
      notify: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: { getBranch: () => entries },
  };
  hypagraphExtension(pi);
  const call = async (name: string, params: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.execute(`${name}-1`, params, undefined, undefined, ctx);
  };
  return { tools, commands, ctx, call, cwd, entries, sendUserMessage };
};

const textOf = (result: Record<string, unknown>): string =>
  String((result.content as Array<{ text: string }>)[0]?.text ?? "");

const creationRequestFromPrompt = (prompt: string): {
  operationId: string;
  sessionGeneration: number;
  branchGeneration: number;
} => {
  const match = prompt.match(/Use this exact creation request identity without changing any field:\n(\{[\s\S]*?\})\n\nCall hypagoal_start/);
  if (!match?.[1]) throw new Error("The authoring prompt did not contain a creation request identity.");
  return JSON.parse(match[1]) as {
    operationId: string;
    sessionGeneration: number;
    branchGeneration: number;
  };
};

describe("Wave 7 draft authoring tools", () => {
  it("registers draft lifecycle and constructor tools", async () => {
    const { tools } = await harness();
    for (const name of [
      "hypagraph_draft_begin",
      "hypagraph_draft_status",
      "hypagraph_draft_validate",
      "hypagraph_draft_discard",
      "hypagraph_add_task",
      "hypagraph_add_check",
      "hypagraph_require",
      "hypagraph_loop",
      "hypagraph_recipe_implement_verify_loop",
      "hypagraph_recipe_implement_parallel_review",
      "hypagoal_start",
      "hypagraph_validate",
    ]) {
      expect(tools.has(name)).toBe(true);
    }
  });

  it("applies implement/parallel-review flagship recipe via tool", async () => {
    const { call } = await harness();
    const begin = await call("hypagraph_draft_begin", {
      objective: "Implement and parallel-review a small change",
      title: "Flagship multi-agent",
    });
    const draftId = (begin.details as { hypagraphDraft: { draftId: string } }).hypagraphDraft.draftId;
    const recipe = await call("hypagraph_recipe_implement_parallel_review", { draftId });
    const text = textOf(recipe);
    expect(text).toMatch(/flagship recipe applied|parallel-review/i);
    expect(text).toMatch(/general/);
    expect(text).toMatch(/review\.general\.passed|role=general/);
    const details = recipe.details as {
      hypagraphDraft: { ok: boolean; recipe?: string; reviewRoles?: string[] };
    };
    expect(details.hypagraphDraft.ok).toBe(true);
    expect(details.hypagraphDraft.recipe).toBe("implement_parallel_review");
    expect(details.hypagraphDraft.reviewRoles).toEqual(["general", "tests", "security"]);
  });

  it("begin, recipe, validate, and commit-by-draft-id without free-form definition", async () => {
    const { call, cwd } = await harness();

    const begin = await call("hypagraph_draft_begin", {
      objective: "Implement and verify a small change",
      title: "Implement verify",
    });
    const beginText = textOf(begin);
    expect(beginText).toContain("Draft created");
    expect(beginText).toContain("Canonical runtime state is unchanged");
    const draftId = (begin.details as { hypagraphDraft: { draftId: string } }).hypagraphDraft.draftId;
    expect(draftId).toMatch(/^[0-9a-f-]{36}$/i);

    const recipe = await call("hypagraph_recipe_implement_verify_loop", {
      draftId,
      maxIterations: 5,
    });
    expect(textOf(recipe)).toContain("Feedback edges are tool-owned");
    expect(textOf(recipe)).not.toMatch(/invalid_feedback_edge/);

    const validate = await call("hypagraph_draft_validate", { draftId });
    expect(textOf(validate)).toContain("Draft is valid");
    expect(textOf(validate)).toContain("Canonical runtime state is unchanged");

    const historyRaw = await readFile(draftHistoryPath(new HypagraphProjectStore(cwd).root, draftId), "utf8");
    const historyLines = historyRaw.trim().split("\n").map((line) => JSON.parse(line) as { schemaVersion: number });
    expect(historyLines.length).toBeGreaterThan(0);
    expect(historyLines.every((line) => line.schemaVersion === 1)).toBe(true);

    const start = await call("hypagoal_start", {
      objective: "Implement and verify a small change",
      draftId,
    });
    expect(textOf(start)).toContain("Hypagoal created");
    const details = start.details as {
      hypagoal: { kind: string; workflowId: string; sourceDraftId?: string };
      hypagraph: { snapshot: { definition: { loops: Array<{ feedbackEdges: unknown }> } } };
    };
    expect(details.hypagoal.kind).toBe("created");
    expect(details.hypagoal.sourceDraftId).toBe(draftId);
    expect(details.hypagraph.snapshot.definition.loops[0]?.feedbackEdges).toEqual([
      { from: "verify", to: "implement" },
    ]);

    const store = new HypagraphProjectStore(cwd);
    const workflowId = details.hypagoal.workflowId;
    const metaRaw = await readFile(workflowMetaPath(store.root, workflowId), "utf8");
    const meta = JSON.parse(metaRaw) as { schemaVersion: number; sourceDraftId?: string };
    expect(meta.schemaVersion).toBe(1);
    expect(meta.sourceDraftId).toBe(draftId);
    const definitionRaw = await readFile(workflowDefinitionPath(store.root, workflowId), "utf8");
    const envelope = JSON.parse(definitionRaw) as {
      schemaVersion: number;
      definition: { loops: Array<{ feedbackEdges: unknown }> };
    };
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.definition.loops[0]?.feedbackEdges).toEqual([{ from: "verify", to: "implement" }]);

    const committedDraft = await store.readDraft(draftId);
    expect(committedDraft?.status).toBe("committed");
  });

  it("rejects draft create when draft creationRequest does not match the active authoring turn", async () => {
    const { call, commands, ctx, sendUserMessage } = await harness();
    const command = commands.get("hypagoal");
    expect(command).toBeDefined();

    await command!.handler("Ship a verified change", ctx);
    const prompt = String(sendUserMessage.mock.calls[0]?.[0]);
    const creationRequest = creationRequestFromPrompt(prompt);

    // Foreign draft: different operationId.
    const foreign = await call("hypagraph_draft_begin", {
      objective: "Ship a verified change",
      creationRequest: {
        operationId: "foreign-operation",
        sessionGeneration: creationRequest.sessionGeneration,
        branchGeneration: creationRequest.branchGeneration,
      },
    });
    const foreignId = (foreign.details as { hypagraphDraft: { draftId: string } }).hypagraphDraft.draftId;
    await call("hypagraph_recipe_implement_verify_loop", { draftId: foreignId, maxIterations: 3 });
    const rejectedForeign = await call("hypagoal_start", {
      objective: "Ship a verified change",
      draftId: foreignId,
      creationRequest,
    });
    expect(textOf(rejectedForeign)).toContain("draft_stale_creation_request");
    expect(textOf(rejectedForeign)).toContain("Canonical state is unchanged");

    // Draft with no creationRequest binding.
    const unbound = await call("hypagraph_draft_begin", {
      objective: "Ship a verified change",
    });
    const unboundId = (unbound.details as { hypagraphDraft: { draftId: string } }).hypagraphDraft.draftId;
    await call("hypagraph_recipe_implement_verify_loop", { draftId: unboundId, maxIterations: 3 });
    const rejectedUnbound = await call("hypagoal_start", {
      objective: "Ship a verified change",
      draftId: unboundId,
      creationRequest,
    });
    expect(textOf(rejectedUnbound)).toContain("draft_stale_creation_request");

    // Matching draft succeeds.
    const bound = await call("hypagraph_draft_begin", {
      objective: "Ship a verified change",
      creationRequest,
    });
    const boundId = (bound.details as { hypagraphDraft: { draftId: string } }).hypagraphDraft.draftId;
    await call("hypagraph_recipe_implement_verify_loop", { draftId: boundId, maxIterations: 3 });
    const accepted = await call("hypagoal_start", {
      objective: "Ship a verified change",
      draftId: boundId,
      creationRequest,
    });
    expect(textOf(accepted)).toContain("Hypagoal created");
  });

  it("binds draftMatchesCreationRequest as a pure check", () => {
    const draft = createEmptyDraft({
      draftId: "d1",
      objective: "x",
      createdAt: "2026-07-31T00:00:00.000Z",
      creationRequest: {
        operationId: "op-1",
        sessionGeneration: 1,
        branchGeneration: 2,
      },
    });
    expect(draftMatchesCreationRequest(draft, {
      operationId: "op-1",
      sessionGeneration: 1,
      branchGeneration: 2,
    })).toBeUndefined();
    expect(draftMatchesCreationRequest(draft, {
      operationId: "op-2",
      sessionGeneration: 1,
      branchGeneration: 2,
    })?.code).toBe("draft_stale_creation_request");

    const unbound = createEmptyDraft({
      draftId: "d2",
      objective: "x",
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    expect(draftMatchesCreationRequest(unbound, {
      operationId: "op-1",
      sessionGeneration: 0,
      branchGeneration: 0,
    })?.code).toBe("draft_stale_creation_request");
  });

  it("requires creationRequest when the draft is bound even without active authoring", async () => {
    const { call } = await harness();
    const creationRequest = {
      operationId: "op-bound-only",
      sessionGeneration: 0,
      branchGeneration: 0,
    };
    const begin = await call("hypagraph_draft_begin", {
      objective: "Bound without active turn",
      creationRequest,
    });
    const draftId = (begin.details as { hypagraphDraft: { draftId: string } }).hypagraphDraft.draftId;
    await call("hypagraph_recipe_implement_verify_loop", { draftId, maxIterations: 3 });

    const omitted = await call("hypagoal_start", {
      objective: "Bound without active turn",
      draftId,
    });
    expect(textOf(omitted)).toContain("draft_stale_creation_request");
    expect(textOf(omitted)).toContain("Canonical state is unchanged");

    const mismatched = await call("hypagoal_start", {
      objective: "Bound without active turn",
      draftId,
      creationRequest: {
        operationId: "other-op",
        sessionGeneration: 0,
        branchGeneration: 0,
      },
    });
    expect(textOf(mismatched)).toContain("draft_stale_creation_request");

    const matched = await call("hypagoal_start", {
      objective: "Bound without active turn",
      draftId,
      creationRequest,
    });
    expect(textOf(matched)).toContain("Hypagoal created");
  });

  it("validateDraftCommitIdentity covers bound and active rules", () => {
    const bound = createEmptyDraft({
      draftId: "b",
      objective: "x",
      createdAt: "2026-07-31T00:00:00.000Z",
      creationRequest: {
        operationId: "op-1",
        sessionGeneration: 1,
        branchGeneration: 0,
      },
    });
    expect(validateDraftCommitIdentity(bound, {})?.code).toBe("draft_stale_creation_request");
    expect(validateDraftCommitIdentity(bound, {
      suppliedCreationRequest: {
        operationId: "op-1",
        sessionGeneration: 1,
        branchGeneration: 0,
      },
    })).toBeUndefined();
    expect(validateDraftCommitIdentity(bound, {
      suppliedCreationRequest: {
        operationId: "op-1",
        sessionGeneration: 1,
        branchGeneration: 0,
      },
      activeCreationRequest: {
        operationId: "op-other",
        sessionGeneration: 1,
        branchGeneration: 0,
      },
    })?.code).toBe("stale_hypagoal_creation_request");

    const unbound = createEmptyDraft({
      draftId: "u",
      objective: "x",
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    expect(validateDraftCommitIdentity(unbound, {})).toBeUndefined();
    expect(validateDraftCommitIdentity(unbound, {
      activeCreationRequest: {
        operationId: "op-1",
        sessionGeneration: 0,
        branchGeneration: 0,
      },
      suppliedCreationRequest: {
        operationId: "op-1",
        sessionGeneration: 0,
        branchGeneration: 0,
      },
    })?.code).toBe("draft_stale_creation_request");
  });

  it("discard removes draft files and does not create a goal", async () => {
    const { call, cwd, entries } = await harness();
    const begin = await call("hypagraph_draft_begin", { objective: "Throwaway" });
    const draftId = (begin.details as { hypagraphDraft: { draftId: string } }).hypagraphDraft.draftId;
    const discarded = await call("hypagraph_draft_discard", { draftId });
    expect(textOf(discarded)).toContain("discarded");
    const store = new HypagraphProjectStore(cwd);
    expect(await store.readDraft(draftId)).toBeUndefined();
    expect(entries.filter((entry) => {
      const item = entry as { customType?: string };
      return item.customType?.includes("event");
    })).toEqual([]);
  });

  it("still accepts free-form definition for tests and import", async () => {
    const { call } = await harness();
    const start = await call("hypagoal_start", {
      objective: "Import path",
      definition: {
        title: "Import",
        goal: "Import path",
        nodes: [
          withCurrentSessionTaskProfile({
            id: "only",
            title: "Only",
            requires: [],
            acceptance: ["done"],
          }),
        ],
        policy: { mode: "guided", requireEvidence: false },
      },
    });
    expect(textOf(start)).toContain("Hypagoal created");
  });

  it("loop tool path cannot produce invalid_feedback_edge on happy path", async () => {
    const { call } = await harness();
    const begin = await call("hypagraph_draft_begin", { objective: "Manual constructors" });
    const draftId = (begin.details as { hypagraphDraft: { draftId: string } }).hypagraphDraft.draftId;

    await call("hypagraph_add_task", {
      draftId,
      id: "implement",
      title: "Implement",
      acceptance: ["done"],
    });
    await call("hypagraph_add_task", {
      draftId,
      id: "verify",
      title: "Verify",
      acceptance: ["ok"],
      produces: [{ name: "tests.passed", type: "boolean", required: true }],
      requires: ["implement"],
    });
    const loop = await call("hypagraph_loop", {
      draftId,
      loopId: "manual-loop",
      entry: "implement",
      evaluateAfter: "verify",
      successWhen: {
        kind: "compare",
        left: { kind: "fact", name: "tests.passed" },
        operator: "eq",
        right: { kind: "literal", value: true },
      },
      maxIterations: 3,
    });
    const loopText = textOf(loop);
    expect(loopText).toContain("Feedback edges are tool-owned");
    expect(loopText).not.toContain("invalid_feedback_edge");

    const validate = await call("hypagraph_draft_validate", { draftId });
    expect(textOf(validate)).toContain("Draft is valid");
    expect(textOf(validate)).not.toContain("invalid_feedback_edge");
  });

  it("recipe projection remains pure for implement/verify", () => {
    const draft = createEmptyDraft({
      draftId: "pure-recipe",
      objective: "pure",
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    const result = applyImplementVerifyLoopRecipe(draft, { maxIterations: 2 }, "2026-07-31T00:00:00.000Z");
    expect(result.ok).toBe(true);
  });
});
