/**
 * Content for `.hypagraph/README.md` written when the store is created.
 */

export const PROJECT_STORE_README = `# Hypagraph project store

This directory holds Hypagraph project data for this repository.

## Contents

- \`settings.json\` — versioned project settings
- \`index.json\` — cache of drafts and workflows (rebuild from directories if corrupt)
- \`drafts/\` — mutable authoring drafts before commit
- \`workflows/\` — committed definition artifacts and metadata
- \`check-artifacts/\` — check execution artifacts
- \`worktrees/\` — worker worktrees

## Authority

Canonical runtime state is the append-only domain event stream (session journal or project event log when enabled).

Files under \`workflows/\` are inspectable project products. They are not an independent runtime authority over live execution.

## Safe to delete

- Discarded drafts under \`drafts/\` after retention
- Check artifacts and worktrees when not needed for recovery
- \`index.json\` (the host rebuilds it)

Do not delete an open draft while an authoring turn uses it.

## Editing rules

Do not hand-edit draft files during a live authoring turn.

Do not invent feedback edges by hand. Use Hypagraph construction tools and recipes.

## Schema versions

Every persisted record includes a \`schemaVersion\` field. The runtime rejects unsupported versions with a clear error.
`;
