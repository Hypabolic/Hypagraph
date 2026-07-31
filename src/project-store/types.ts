/**
 * Project store record types for `.hypagraph`.
 * All persisted records include a schema version.
 */

import type { HypagraphDefinition } from "../domain/model.js";

export const HYPAGRAPH_PROJECT_INDEX_SCHEMA_VERSION = 1 as const;
export const HYPAGRAPH_PROJECT_SETTINGS_SCHEMA_VERSION = 1 as const;
export const HYPAGRAPH_WORKFLOW_META_SCHEMA_VERSION = 1 as const;
export const HYPAGRAPH_WORKFLOW_DEFINITION_SCHEMA_VERSION = 1 as const;
export const HYPAGRAPH_DRAFT_HISTORY_SCHEMA_VERSION = 1 as const;

export interface HypagraphProjectIndexDraftEntry {
  draftId: string;
  status: string;
  updatedAt: string;
  objective: string;
}

export interface HypagraphProjectIndexWorkflowEntry {
  workflowId: string;
  goalId?: string;
  status: string;
  updatedAt: string;
  title: string;
}

export interface HypagraphProjectIndex {
  schemaVersion: typeof HYPAGRAPH_PROJECT_INDEX_SCHEMA_VERSION;
  drafts: HypagraphProjectIndexDraftEntry[];
  workflows: HypagraphProjectIndexWorkflowEntry[];
}

export interface HypagraphProjectSettings {
  schemaVersion: typeof HYPAGRAPH_PROJECT_SETTINGS_SCHEMA_VERSION;
  /** When true, committed workflow definitions may be git-tracked. Default false. */
  trackWorkflowDefinitions?: boolean;
  /** Days to retain discarded drafts. Default 7. */
  discardedDraftRetentionDays?: number;
  /** Project-first events are not enabled in Wave 7 skeleton. */
  projectFirstEvents?: boolean;
}

export interface HypagraphWorkflowMeta {
  schemaVersion: typeof HYPAGRAPH_WORKFLOW_META_SCHEMA_VERSION;
  workflowId: string;
  goalId?: string;
  objective: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  definitionRevision: number;
  sourceDraftId?: string;
  status: "active" | "superseded" | "archived";
}

/**
 * Versioned envelope for committed definition.json.
 * HypagraphDefinition itself has no schemaVersion field.
 */
export interface HypagraphWorkflowDefinitionRecord {
  schemaVersion: typeof HYPAGRAPH_WORKFLOW_DEFINITION_SCHEMA_VERSION;
  definition: HypagraphDefinition;
}

/**
 * Versioned draft construction history line (history.jsonl).
 */
export interface HypagraphDraftHistoryEntry {
  schemaVersion: typeof HYPAGRAPH_DRAFT_HISTORY_SCHEMA_VERSION;
  at: string;
  code: string;
  message?: string;
  [key: string]: unknown;
}

export function assertWorkflowDefinitionRecordSchema(
  value: unknown,
): asserts value is HypagraphWorkflowDefinitionRecord {
  if (value === null || typeof value !== "object") {
    throw new ProjectStoreError(
      "project_schema_unsupported",
      "The workflow definition record must be an object with a schemaVersion field.",
    );
  }
  const record = value as { schemaVersion?: unknown; definition?: unknown };
  if (typeof record.schemaVersion !== "number") {
    throw new ProjectStoreError(
      "project_schema_unsupported",
      "The workflow definition record must include a numeric schemaVersion.",
    );
  }
  if (record.schemaVersion !== HYPAGRAPH_WORKFLOW_DEFINITION_SCHEMA_VERSION) {
    throw new ProjectStoreError(
      "project_schema_unsupported",
      `Unsupported workflow definition schema version '${String(record.schemaVersion)}'. Expected ${HYPAGRAPH_WORKFLOW_DEFINITION_SCHEMA_VERSION}.`,
    );
  }
  if (record.definition === null || typeof record.definition !== "object") {
    throw new ProjectStoreError(
      "project_schema_unsupported",
      "The workflow definition record must include a definition object.",
    );
  }
}

export function assertDraftHistoryEntrySchema(
  value: unknown,
): asserts value is HypagraphDraftHistoryEntry {
  if (value === null || typeof value !== "object") {
    throw new ProjectStoreError(
      "project_schema_unsupported",
      "The draft history entry must be an object with a schemaVersion field.",
    );
  }
  const record = value as { schemaVersion?: unknown };
  if (typeof record.schemaVersion !== "number") {
    throw new ProjectStoreError(
      "project_schema_unsupported",
      "The draft history entry must include a numeric schemaVersion.",
    );
  }
  if (record.schemaVersion !== HYPAGRAPH_DRAFT_HISTORY_SCHEMA_VERSION) {
    throw new ProjectStoreError(
      "project_schema_unsupported",
      `Unsupported draft history schema version '${String(record.schemaVersion)}'. Expected ${HYPAGRAPH_DRAFT_HISTORY_SCHEMA_VERSION}.`,
    );
  }
}

export class ProjectStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectStoreError";
    this.code = code;
  }
}

export function assertProjectIndexSchema(value: unknown): asserts value is HypagraphProjectIndex {
  if (value === null || typeof value !== "object") {
    throw new ProjectStoreError("project_schema_unsupported", "The project index must be an object.");
  }
  const record = value as { schemaVersion?: unknown };
  if (typeof record.schemaVersion !== "number") {
    throw new ProjectStoreError(
      "project_schema_unsupported",
      "The project index must include a numeric schemaVersion.",
    );
  }
  if (record.schemaVersion !== HYPAGRAPH_PROJECT_INDEX_SCHEMA_VERSION) {
    throw new ProjectStoreError(
      "project_schema_unsupported",
      `Unsupported project index schema version '${String(record.schemaVersion)}'. Expected ${HYPAGRAPH_PROJECT_INDEX_SCHEMA_VERSION}.`,
    );
  }
}

export function assertProjectSettingsSchema(value: unknown): asserts value is HypagraphProjectSettings {
  if (value === null || typeof value !== "object") {
    throw new ProjectStoreError("project_schema_unsupported", "The project settings must be an object.");
  }
  const record = value as { schemaVersion?: unknown };
  if (typeof record.schemaVersion !== "number") {
    throw new ProjectStoreError(
      "project_schema_unsupported",
      "The project settings must include a numeric schemaVersion.",
    );
  }
  if (record.schemaVersion !== HYPAGRAPH_PROJECT_SETTINGS_SCHEMA_VERSION) {
    throw new ProjectStoreError(
      "project_schema_unsupported",
      `Unsupported project settings schema version '${String(record.schemaVersion)}'. Expected ${HYPAGRAPH_PROJECT_SETTINGS_SCHEMA_VERSION}.`,
    );
  }
}

export function assertWorkflowMetaSchema(value: unknown): asserts value is HypagraphWorkflowMeta {
  if (value === null || typeof value !== "object") {
    throw new ProjectStoreError("project_schema_unsupported", "The workflow meta record must be an object.");
  }
  const record = value as { schemaVersion?: unknown };
  if (typeof record.schemaVersion !== "number") {
    throw new ProjectStoreError(
      "project_schema_unsupported",
      "The workflow meta record must include a numeric schemaVersion.",
    );
  }
  if (record.schemaVersion !== HYPAGRAPH_WORKFLOW_META_SCHEMA_VERSION) {
    throw new ProjectStoreError(
      "project_schema_unsupported",
      `Unsupported workflow meta schema version '${String(record.schemaVersion)}'. Expected ${HYPAGRAPH_WORKFLOW_META_SCHEMA_VERSION}.`,
    );
  }
}

export function defaultProjectIndex(): HypagraphProjectIndex {
  return {
    schemaVersion: HYPAGRAPH_PROJECT_INDEX_SCHEMA_VERSION,
    drafts: [],
    workflows: [],
  };
}

export function defaultProjectSettings(): HypagraphProjectSettings {
  return {
    schemaVersion: HYPAGRAPH_PROJECT_SETTINGS_SCHEMA_VERSION,
    trackWorkflowDefinitions: false,
    discardedDraftRetentionDays: 7,
    projectFirstEvents: false,
  };
}
