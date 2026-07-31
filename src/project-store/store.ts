/**
 * Host filesystem adapter for the `.hypagraph` project store.
 *
 * Domain modules stay pure. All disk I/O lives here.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HYPAGRAPH_DRAFT_SCHEMA_VERSION,
  parseDraftRecord,
  UnsupportedDraftSchemaError,
  type HypagraphDraftRecord,
} from "../domain/draft.js";
import type { HypagraphDefinition } from "../domain/model.js";
import {
  draftDir,
  draftHistoryPath,
  draftRecordPath,
  draftsDir,
  projectIndexPath,
  projectReadmePath,
  projectSettingsPath,
  projectStoreRoot,
  workflowDefinitionPath,
  workflowDir,
  workflowMetaPath,
  workflowsDir,
} from "./paths.js";
import { PROJECT_STORE_README } from "./readme.js";
import {
  assertDraftHistoryEntrySchema,
  assertProjectIndexSchema,
  assertProjectSettingsSchema,
  assertWorkflowDefinitionRecordSchema,
  assertWorkflowMetaSchema,
  defaultProjectIndex,
  defaultProjectSettings,
  HYPAGRAPH_DRAFT_HISTORY_SCHEMA_VERSION,
  HYPAGRAPH_PROJECT_INDEX_SCHEMA_VERSION,
  HYPAGRAPH_WORKFLOW_DEFINITION_SCHEMA_VERSION,
  HYPAGRAPH_WORKFLOW_META_SCHEMA_VERSION,
  ProjectStoreError,
  type HypagraphDraftHistoryEntry,
  type HypagraphProjectIndex,
  type HypagraphProjectSettings,
  type HypagraphWorkflowDefinitionRecord,
  type HypagraphWorkflowMeta,
} from "./types.js";

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const readJson = async (path: string): Promise<unknown> => {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as unknown;
};

const mapDraftParseError = (error: unknown, location: string): never => {
  if (error instanceof UnsupportedDraftSchemaError) {
    throw new ProjectStoreError(
      "project_schema_unsupported",
      `${location}: ${error.message}`,
    );
  }
  if (error instanceof ProjectStoreError) throw error;
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new ProjectStoreError(
    "project_store_corrupt",
    `${location}: ${message}`,
  );
};

export class HypagraphProjectStore {
  readonly root: string;

  constructor(cwd: string) {
    this.root = projectStoreRoot(cwd);
  }

  /**
   * Ensure the store root, settings, index, README, and base directories exist.
   * Missing settings.json and index.json are written with schema-versioned defaults.
   */
  async ensureInitialized(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(draftsDir(this.root), { recursive: true });
    await mkdir(workflowsDir(this.root), { recursive: true });

    const readmePath = projectReadmePath(this.root);
    try {
      await readFile(readmePath, "utf8");
    } catch {
      await writeFile(readmePath, PROJECT_STORE_README, "utf8");
    }

    const settingsPath = projectSettingsPath(this.root);
    try {
      await readFile(settingsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.writeSettings(defaultProjectSettings());
      } else {
        throw error;
      }
    }
    // Validate existing settings (rejects unsupported schema versions).
    await this.readSettings();

    const indexPath = projectIndexPath(this.root);
    try {
      await readFile(indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.writeIndex(defaultProjectIndex());
      } else {
        throw error;
      }
    }
    // Validate existing index (rejects unsupported schema versions).
    await this.readIndex();
  }

  async readSettings(): Promise<HypagraphProjectSettings> {
    try {
      const value = await readJson(projectSettingsPath(this.root));
      assertProjectSettingsSchema(value);
      return {
        ...defaultProjectSettings(),
        ...value,
        schemaVersion: value.schemaVersion,
      };
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultProjectSettings();
      }
      throw error;
    }
  }

  async writeSettings(settings: HypagraphProjectSettings): Promise<void> {
    assertProjectSettingsSchema(settings);
    await mkdir(this.root, { recursive: true });
    await writeJson(projectSettingsPath(this.root), settings);
  }

  async readIndex(): Promise<HypagraphProjectIndex> {
    try {
      const value = await readJson(projectIndexPath(this.root));
      assertProjectIndexSchema(value);
      return {
        schemaVersion: HYPAGRAPH_PROJECT_INDEX_SCHEMA_VERSION,
        drafts: Array.isArray(value.drafts) ? value.drafts : [],
        workflows: Array.isArray(value.workflows) ? value.workflows : [],
      };
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultProjectIndex();
      }
      throw error;
    }
  }

  async writeIndex(index: HypagraphProjectIndex): Promise<void> {
    assertProjectIndexSchema(index);
    await mkdir(this.root, { recursive: true });
    await writeJson(projectIndexPath(this.root), {
      schemaVersion: HYPAGRAPH_PROJECT_INDEX_SCHEMA_VERSION,
      drafts: index.drafts,
      workflows: index.workflows,
    });
  }

  /**
   * Rebuild index.json from draft and workflow directories.
   * Unsupported schema versions fail with a clear error.
   * The rebuild does not write a clean index that hides those records.
   */
  async rebuildIndex(): Promise<HypagraphProjectIndex> {
    await mkdir(draftsDir(this.root), { recursive: true });
    await mkdir(workflowsDir(this.root), { recursive: true });

    const diagnostics: string[] = [];
    const draftEntries: HypagraphProjectIndex["drafts"] = [];
    let draftNames: string[] = [];
    try {
      draftNames = await readdir(draftsDir(this.root));
    } catch {
      draftNames = [];
    }
    for (const name of draftNames) {
      try {
        const draft = await this.readDraftByDirName(name);
        if (!draft) continue;
        draftEntries.push({
          draftId: draft.draftId,
          status: draft.status,
          updatedAt: draft.updatedAt,
          objective: draft.objective,
        });
      } catch (error) {
        if (error instanceof ProjectStoreError) {
          diagnostics.push(error.message);
          continue;
        }
        diagnostics.push(
          `drafts/${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const workflowEntries: HypagraphProjectIndex["workflows"] = [];
    let workflowNames: string[] = [];
    try {
      workflowNames = await readdir(workflowsDir(this.root));
    } catch {
      workflowNames = [];
    }
    for (const name of workflowNames) {
      try {
        const metaPath = join(workflowsDir(this.root), name, "meta.json");
        let value: unknown;
        try {
          value = await readJson(metaPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        assertWorkflowMetaSchema(value);
        workflowEntries.push({
          workflowId: value.workflowId,
          ...(value.goalId === undefined ? {} : { goalId: value.goalId }),
          status: value.status,
          updatedAt: value.updatedAt,
          title: value.title,
        });
      } catch (error) {
        if (error instanceof ProjectStoreError) {
          diagnostics.push(`workflows/${name}: ${error.message}`);
          continue;
        }
        diagnostics.push(
          `workflows/${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (diagnostics.length > 0) {
      const schemaRelated = diagnostics.some((item) =>
        item.includes("schemaVersion")
        || item.includes("schema version")
        || item.includes("Unsupported")
      );
      throw new ProjectStoreError(
        schemaRelated ? "project_schema_unsupported" : "project_store_corrupt",
        [
          "Project index rebuild failed. Unsupported or corrupt store records must be fixed or removed.",
          ...diagnostics.map((item) => `- ${item}`),
        ].join("\n"),
      );
    }

    const index: HypagraphProjectIndex = {
      schemaVersion: HYPAGRAPH_PROJECT_INDEX_SCHEMA_VERSION,
      drafts: draftEntries,
      workflows: workflowEntries,
    };
    await this.writeIndex(index);
    return index;
  }

  async writeDraft(draft: HypagraphDraftRecord): Promise<void> {
    if (draft.schemaVersion !== HYPAGRAPH_DRAFT_SCHEMA_VERSION) {
      throw new ProjectStoreError(
        "project_schema_unsupported",
        `Unsupported draft schema version '${String(draft.schemaVersion)}'. Expected ${HYPAGRAPH_DRAFT_SCHEMA_VERSION}.`,
      );
    }
    await this.ensureInitialized();
    const dir = draftDir(this.root, draft.draftId);
    await mkdir(dir, { recursive: true });
    await writeJson(draftRecordPath(this.root, draft.draftId), draft);
    await this.touchDraftInIndex(draft);
  }

  async appendDraftHistory(
    draftId: string,
    entry: Omit<HypagraphDraftHistoryEntry, "schemaVersion" | "at"> & {
      at?: string;
      code: string;
    },
  ): Promise<void> {
    await this.ensureInitialized();
    await mkdir(draftDir(this.root, draftId), { recursive: true });
    const record: HypagraphDraftHistoryEntry = {
      ...entry,
      schemaVersion: HYPAGRAPH_DRAFT_HISTORY_SCHEMA_VERSION,
      at: entry.at ?? new Date().toISOString(),
      code: entry.code,
    };
    assertDraftHistoryEntrySchema(record);
    const line = `${JSON.stringify(record)}\n`;
    const path = draftHistoryPath(this.root, draftId);
    try {
      const existing = await readFile(path, "utf8");
      this.assertExistingDraftHistory(existing, draftId);
      await writeFile(path, `${existing.endsWith("\n") || existing.length === 0 ? existing : `${existing}\n`}${line}`, "utf8");
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await writeFile(path, line, "utf8");
        return;
      }
      throw error;
    }
  }

  /**
   * Reject append when existing history.jsonl contains unsupported schema lines.
   */
  private assertExistingDraftHistory(text: string, draftId: string): void {
    const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new ProjectStoreError(
          "project_store_corrupt",
          `Draft '${draftId}' history line ${index + 1} is not valid JSON.`,
        );
      }
      try {
        assertDraftHistoryEntrySchema(parsed);
      } catch (error) {
        if (error instanceof ProjectStoreError) {
          throw new ProjectStoreError(
            error.code,
            `Draft '${draftId}' history line ${index + 1}: ${error.message}`,
          );
        }
        throw error;
      }
    }
  }

  async readDraft(draftId: string): Promise<HypagraphDraftRecord | undefined> {
    try {
      const value = await readJson(draftRecordPath(this.root, draftId));
      return parseDraftRecord(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      mapDraftParseError(error, `draft '${draftId}'`);
    }
  }

  private async readDraftByDirName(dirName: string): Promise<HypagraphDraftRecord | undefined> {
    try {
      const value = await readJson(join(draftsDir(this.root), dirName, "draft.json"));
      return parseDraftRecord(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      mapDraftParseError(error, `drafts/${dirName}`);
    }
  }

  async discardDraft(draftId: string): Promise<HypagraphDraftRecord | undefined> {
    const draft = await this.readDraft(draftId);
    if (!draft) return undefined;
    const discarded: HypagraphDraftRecord = {
      ...draft,
      status: "discarded",
      updatedAt: new Date().toISOString(),
    };
    await this.writeDraft(discarded);
    await this.appendDraftHistory(draftId, { code: "draft_discarded", message: "Draft discarded." });
    return discarded;
  }

  async removeDraftFiles(draftId: string): Promise<void> {
    await rm(draftDir(this.root, draftId), { recursive: true, force: true });
    const index = await this.readIndex();
    index.drafts = index.drafts.filter((item) => item.draftId !== draftId);
    await this.writeIndex(index);
  }

  async writeCommittedWorkflow(input: {
    workflowId: string;
    goalId?: string;
    objective: string;
    title: string;
    definition: HypagraphDefinition;
    definitionRevision: number;
    sourceDraftId?: string;
    at: string;
    status?: HypagraphWorkflowMeta["status"];
  }): Promise<HypagraphWorkflowMeta> {
    await this.ensureInitialized();
    const meta: HypagraphWorkflowMeta = {
      schemaVersion: HYPAGRAPH_WORKFLOW_META_SCHEMA_VERSION,
      workflowId: input.workflowId,
      ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
      objective: input.objective,
      title: input.title,
      createdAt: input.at,
      updatedAt: input.at,
      definitionRevision: input.definitionRevision,
      ...(input.sourceDraftId === undefined ? {} : { sourceDraftId: input.sourceDraftId }),
      status: input.status ?? "active",
    };
    const definitionRecord: HypagraphWorkflowDefinitionRecord = {
      schemaVersion: HYPAGRAPH_WORKFLOW_DEFINITION_SCHEMA_VERSION,
      definition: structuredClone(input.definition),
    };
    assertWorkflowDefinitionRecordSchema(definitionRecord);
    await mkdir(workflowDir(this.root, input.workflowId), { recursive: true });
    await writeJson(workflowMetaPath(this.root, input.workflowId), meta);
    await writeJson(workflowDefinitionPath(this.root, input.workflowId), definitionRecord);

    const index = await this.readIndex();
    const entry = {
      workflowId: meta.workflowId,
      ...(meta.goalId === undefined ? {} : { goalId: meta.goalId }),
      status: meta.status,
      updatedAt: meta.updatedAt,
      title: meta.title,
    };
    const existing = index.workflows.findIndex((item) => item.workflowId === meta.workflowId);
    if (existing >= 0) index.workflows[existing] = entry;
    else index.workflows.push(entry);
    await this.writeIndex(index);
    return meta;
  }

  /**
   * Read a committed workflow definition envelope and return the definition body.
   */
  async readCommittedDefinition(workflowId: string): Promise<HypagraphDefinition | undefined> {
    try {
      const value = await readJson(workflowDefinitionPath(this.root, workflowId));
      assertWorkflowDefinitionRecordSchema(value);
      return structuredClone(value.definition);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof ProjectStoreError) throw error;
      throw error;
    }
  }

  private async touchDraftInIndex(draft: HypagraphDraftRecord): Promise<void> {
    const index = await this.readIndex();
    const entry = {
      draftId: draft.draftId,
      status: draft.status,
      updatedAt: draft.updatedAt,
      objective: draft.objective,
    };
    const existing = index.drafts.findIndex((item) => item.draftId === draft.draftId);
    if (existing >= 0) index.drafts[existing] = entry;
    else index.drafts.push(entry);
    await this.writeIndex(index);
  }
}
