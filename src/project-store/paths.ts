/**
 * Path helpers for the `.hypagraph` project store.
 * Host only. No domain reducer imports this for reduction.
 */

import { join, resolve } from "node:path";

export const HYPAGRAPH_STORE_DIR = ".hypagraph";

export function projectStoreRoot(cwd: string): string {
  return resolve(cwd, HYPAGRAPH_STORE_DIR);
}

export function projectIndexPath(root: string): string {
  return join(root, "index.json");
}

export function projectSettingsPath(root: string): string {
  return join(root, "settings.json");
}

export function projectReadmePath(root: string): string {
  return join(root, "README.md");
}

export function draftsDir(root: string): string {
  return join(root, "drafts");
}

export function draftDir(root: string, draftId: string): string {
  return join(draftsDir(root), safeSegment(draftId));
}

export function draftRecordPath(root: string, draftId: string): string {
  return join(draftDir(root, draftId), "draft.json");
}

export function draftHistoryPath(root: string, draftId: string): string {
  return join(draftDir(root, draftId), "history.jsonl");
}

export function workflowsDir(root: string): string {
  return join(root, "workflows");
}

export function workflowDir(root: string, workflowId: string): string {
  return join(workflowsDir(root), safeSegment(workflowId));
}

export function workflowMetaPath(root: string, workflowId: string): string {
  return join(workflowDir(root, workflowId), "meta.json");
}

export function workflowDefinitionPath(root: string, workflowId: string): string {
  return join(workflowDir(root, workflowId), "definition.json");
}

/** Encode path segments so draft and workflow ids cannot escape the store root. */
export function safeSegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}
