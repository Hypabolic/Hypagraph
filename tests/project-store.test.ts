import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HypagraphProjectStore,
  ProjectStoreError,
  HYPAGRAPH_PROJECT_INDEX_SCHEMA_VERSION,
  HYPAGRAPH_PROJECT_SETTINGS_SCHEMA_VERSION,
  HYPAGRAPH_WORKFLOW_DEFINITION_SCHEMA_VERSION,
} from "../src/project-store/index.js";
import { createEmptyDraft, HYPAGRAPH_DRAFT_SCHEMA_VERSION } from "../src/domain/draft.js";
import {
  draftHistoryPath,
  draftRecordPath,
  projectStoreRoot,
  projectIndexPath,
  projectSettingsPath,
  projectReadmePath,
  workflowDefinitionPath,
} from "../src/project-store/paths.js";

const tempCwd = async (): Promise<string> => mkdtemp(join(tmpdir(), "hypagraph-store-"));

describe("S7.1 project store skeleton", () => {
  it("creates versioned index, settings, and README under .hypagraph", async () => {
    const cwd = await tempCwd();
    const store = new HypagraphProjectStore(cwd);
    await store.ensureInitialized();

    // ensureInitialized must write missing settings.json and index.json to disk.
    const settingsRaw = await readFile(projectSettingsPath(store.root), "utf8");
    expect(JSON.parse(settingsRaw).schemaVersion).toBe(HYPAGRAPH_PROJECT_SETTINGS_SCHEMA_VERSION);
    const indexRaw = await readFile(projectIndexPath(store.root), "utf8");
    expect(JSON.parse(indexRaw).schemaVersion).toBe(HYPAGRAPH_PROJECT_INDEX_SCHEMA_VERSION);

    const index = await store.readIndex();
    expect(index.schemaVersion).toBe(HYPAGRAPH_PROJECT_INDEX_SCHEMA_VERSION);
    expect(index.drafts).toEqual([]);
    expect(index.workflows).toEqual([]);

    const settings = await store.readSettings();
    expect(settings.schemaVersion).toBe(HYPAGRAPH_PROJECT_SETTINGS_SCHEMA_VERSION);

    const readme = await readFile(projectReadmePath(store.root), "utf8");
    expect(readme).toContain("Hypagraph project store");
    expect(store.root).toBe(projectStoreRoot(cwd));
  });

  it("rejects unsupported index schema version", async () => {
    const cwd = await tempCwd();
    const store = new HypagraphProjectStore(cwd);
    await mkdir(store.root, { recursive: true });
    await writeFile(
      projectIndexPath(store.root),
      `${JSON.stringify({ schemaVersion: 99, drafts: [], workflows: [] }, null, 2)}\n`,
      "utf8",
    );

    await expect(store.readIndex()).rejects.toBeInstanceOf(ProjectStoreError);
    await expect(store.readIndex()).rejects.toMatchObject({ code: "project_schema_unsupported" });
  });

  it("rejects unsupported settings schema version", async () => {
    const cwd = await tempCwd();
    const store = new HypagraphProjectStore(cwd);
    await mkdir(store.root, { recursive: true });
    await writeFile(
      projectSettingsPath(store.root),
      `${JSON.stringify({ schemaVersion: 7 }, null, 2)}\n`,
      "utf8",
    );

    await expect(store.readSettings()).rejects.toMatchObject({ code: "project_schema_unsupported" });
  });

  it("rejects unsupported draft schema version on read", async () => {
    const cwd = await tempCwd();
    const store = new HypagraphProjectStore(cwd);
    await store.ensureInitialized();
    const draft = createEmptyDraft({
      draftId: "draft-schema",
      objective: "test",
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    await store.writeDraft(draft);
    const written = await store.readDraft("draft-schema");
    expect(written?.schemaVersion).toBe(HYPAGRAPH_DRAFT_SCHEMA_VERSION);

    await writeFile(
      draftRecordPath(store.root, "draft-schema"),
      `${JSON.stringify({ ...draft, schemaVersion: 42 }, null, 2)}\n`,
      "utf8",
    );

    await expect(store.readDraft("draft-schema")).rejects.toMatchObject({
      code: "project_schema_unsupported",
    });
  });

  it("maps a missing draft schemaVersion to project_schema_unsupported", async () => {
    const cwd = await tempCwd();
    const store = new HypagraphProjectStore(cwd);
    await store.ensureInitialized();
    const draft = createEmptyDraft({
      draftId: "draft-missing-version",
      objective: "test",
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    await store.writeDraft(draft);
    const withoutVersion = { ...draft } as Record<string, unknown>;
    delete withoutVersion.schemaVersion;
    await writeFile(
      draftRecordPath(store.root, "draft-missing-version"),
      `${JSON.stringify(withoutVersion, null, 2)}\n`,
      "utf8",
    );

    await expect(store.readDraft("draft-missing-version")).rejects.toBeInstanceOf(ProjectStoreError);
    await expect(store.readDraft("draft-missing-version")).rejects.toMatchObject({
      code: "project_schema_unsupported",
    });
    await expect(store.readDraft("draft-missing-version")).rejects.toThrow(/schemaVersion/);
  });

  it("rebuilds index from draft directories", async () => {
    const cwd = await tempCwd();
    const store = new HypagraphProjectStore(cwd);
    await store.ensureInitialized();
    const draft = createEmptyDraft({
      draftId: "d1",
      objective: "Rebuild me",
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    await store.writeDraft(draft);
    await writeFile(
      projectIndexPath(store.root),
      `${JSON.stringify({ schemaVersion: 1, drafts: [], workflows: [] }, null, 2)}\n`,
      "utf8",
    );

    const rebuilt = await store.rebuildIndex();
    expect(rebuilt.drafts.some((item) => item.draftId === "d1")).toBe(true);
  });

  it("fails index rebuild when a draft has an unsupported schema and does not write a clean index", async () => {
    const cwd = await tempCwd();
    const store = new HypagraphProjectStore(cwd);
    await store.ensureInitialized();
    const good = createEmptyDraft({
      draftId: "good",
      objective: "good",
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    await store.writeDraft(good);

    await mkdir(join(store.root, "drafts", "bad-schema"), { recursive: true });
    await writeFile(
      join(store.root, "drafts", "bad-schema", "draft.json"),
      `${JSON.stringify({
        schemaVersion: 99,
        draftId: "bad",
        objective: "bad",
        status: "open",
        goal: "bad",
        nodes: [],
        edges: [],
        loops: [],
        createdAt: "2026-07-31T00:00:00.000Z",
        updatedAt: "2026-07-31T00:00:00.000Z",
      }, null, 2)}\n`,
      "utf8",
    );

    const indexBefore = await readFile(projectIndexPath(store.root), "utf8");
    await expect(store.rebuildIndex()).rejects.toMatchObject({
      code: "project_schema_unsupported",
    });
    const indexAfter = await readFile(projectIndexPath(store.root), "utf8");
    expect(indexAfter).toBe(indexBefore);
    expect(JSON.parse(indexAfter).drafts.some((item: { draftId: string }) => item.draftId === "bad")).toBe(false);
  });

  it("writes versioned definition envelope and history entries", async () => {
    const cwd = await tempCwd();
    const store = new HypagraphProjectStore(cwd);
    await store.ensureInitialized();
    const draft = createEmptyDraft({
      draftId: "hist",
      objective: "history",
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    await store.writeDraft(draft);
    await store.appendDraftHistory("hist", { code: "note", message: "hello" });
    const history = (await readFile(draftHistoryPath(store.root, "hist"), "utf8")).trim();
    const entry = JSON.parse(history) as { schemaVersion: number; code: string };
    expect(entry.schemaVersion).toBe(1);
    expect(entry.code).toBe("note");

    const definition = {
      title: "t",
      goal: "g",
      nodes: [{ id: "n", title: "N", requires: [], acceptance: [] }],
      loops: [],
      policy: { mode: "guided" as const, requireEvidence: false },
    };
    await store.writeCommittedWorkflow({
      workflowId: "wf-1",
      objective: "g",
      title: "t",
      definition,
      definitionRevision: 1,
      at: "2026-07-31T00:00:00.000Z",
    });
    const raw = await readFile(workflowDefinitionPath(store.root, "wf-1"), "utf8");
    const envelope = JSON.parse(raw) as { schemaVersion: number; definition: { title: string } };
    expect(envelope.schemaVersion).toBe(HYPAGRAPH_WORKFLOW_DEFINITION_SCHEMA_VERSION);
    expect(envelope.definition.title).toBe("t");
    const readBack = await store.readCommittedDefinition("wf-1");
    expect(readBack?.title).toBe("t");
  });

  it("rejects appendDraftHistory when existing history has unsupported schema", async () => {
    const cwd = await tempCwd();
    const store = new HypagraphProjectStore(cwd);
    await store.ensureInitialized();
    const draft = createEmptyDraft({
      draftId: "hist-bad",
      objective: "history",
      createdAt: "2026-07-31T00:00:00.000Z",
    });
    await store.writeDraft(draft);
    await writeFile(
      draftHistoryPath(store.root, "hist-bad"),
      `${JSON.stringify({ schemaVersion: 99, at: "2026-07-31T00:00:00.000Z", code: "old" })}\n`,
      "utf8",
    );

    await expect(store.appendDraftHistory("hist-bad", { code: "note", message: "nope" })).rejects.toMatchObject({
      code: "project_schema_unsupported",
    });
    const history = (await readFile(draftHistoryPath(store.root, "hist-bad"), "utf8")).trim();
    expect(history.split("\n")).toHaveLength(1);
    expect(history).toContain('"schemaVersion":99');
  });
});
