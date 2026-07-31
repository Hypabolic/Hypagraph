# Wave 7 implementation summary — Authoring constructors and project store

## Status

**Wave 7 code complete for S7.1–S7.4**, including Codex review fixes (creationRequest binding, schema envelopes, rebuild, history validation, ensureInitialized file writes).

S7.5 (project-first events) deferred. S7.6 skill partially updated.

## Review fixes

| # | Issue | Fix |
| --- | --- | --- |
| 1 | Draft not bound to creationRequest (active turn) | Active turn requires matching draft binding |
| 1b | Bound draft without active turn could omit creationRequest | **`validateDraftCommitIdentity`**: if draft has `creationRequest`, caller must supply a full match; omit rejects |
| 2 | Bare definition.json / unversioned history | Envelope `{ schemaVersion, definition }`; history lines versioned |
| 3 | rebuildIndex hides unsupported schemas | Rebuild fails; does not rewrite a clean hiding index |
| 4 | Missing draft schemaVersion wrong code | `UnsupportedDraftSchemaError` → `project_schema_unsupported` |
| 5 | ensureInitialized did not persist settings/index | Writes `settings.json` and `index.json` when missing; tests assert file existence |
| 6 | appendDraftHistory ignored existing line schemas | Validates every existing history line before append; rejects unsupported |

## Goal

Argument-driven construction tools plus durable `.hypagraph` drafts and committed definition artifacts. Models can build a valid implement/verify loop without hand-authoring `feedbackEdges`.

## Binding rules (commit by draftId)

1. Bound draft → require supplied `creationRequest` matching draft binding.
2. Active `/hypagoal` turn → also match active identity (and session/branch generations).
3. Unbound draft + no active turn → free commit without `creationRequest` (tests/import convenience).
4. Free-form definition + `creationRequest` without active turn → still rejected as stale.

## Key modules

| File | Role |
| --- | --- |
| `src/domain/draft.ts` | Pure draft, `validateDraftCommitIdentity`, schema errors |
| `src/domain/draft-constructors.ts` | Pure constructors |
| `src/domain/draft-recipes.ts` | implement/verify recipe |
| `src/project-store/*` | Host I/O; versioned definition/history; strict rebuild; ensureInitialized writes |
| `src/pi/draft-tools.ts` | Tool schemas |
| `src/pi/hypagoal.ts` | draftId on start |
| `src/extension.ts` | Tools + identity checks on commit |
| `tests/project-store.test.ts` | Schema, rebuild, history, ensureInitialized files |
| `tests/wave7-draft-authoring.test.ts` | Vertical slice + binding |

## Tests run

```text
npx tsc --noEmit
npx vitest run tests/project-store.test.ts tests/draft-constructors.test.ts tests/wave7-draft-authoring.test.ts tests/hypagoal-pi.test.ts tests/post-create-dock.test.ts tests/wave6-isolated-root-extension.test.ts tests/hypagraph-validate.test.ts
```

62/62 passed. Typecheck clean.

## Not done

- S7.5 project-first events
- Linear/gate/code/effect constructors
- Revision drafts
- Live multi-tool dogfood
