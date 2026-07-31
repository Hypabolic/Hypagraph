# Wave 8 implementation summary — Integration dogfood and packaging

## Status

**S8.1 script complete; live acceptance pending. S8.2 complete. S8.3 skipped** (user did not request a release cut).

Codex review fixes applied (docs only).

## Goal

Record one coherent end-to-end product path. Reconcile plan status so documentation matches landed code. Do not cut a release.

## Slices

| Slice | Result |
| --- | --- |
| **S8.1** | **Script complete; live acceptance pending.** Written E2E path at `docs/scratch/product-surface-e2e-path.md` with interaction-capable fixture (`do-work` → `approve-work`). Live dogfood evidence not recorded. |
| **S8.2** | Status board, header, roadmap §18, and trigger plan reconciled. Wave 4 status aligned with Waves 2/5 (`code done; live dogfood pending`). Orchestrator prompt stops after **S8.2** unless the user requests S8.3. |
| **S8.3** | Skipped — no version, CHANGELOG, or release notes cut |

## Review fixes (this pass)

| # | Issue | Fix |
| --- | --- | --- |
| 1 | S8.1 marked complete without live evidence | Status: **script complete; live acceptance pending** (header, Wave 8 progress, status board, E2E note, roadmap) |
| 2 | E2E script did not guarantee an interaction node | Section 4 fixture + authoring sequence; `/hypagraph ask` is re-present only |
| 3 | Wave 4 said “done” while live open | Wave 4 → `code done; live dogfood pending` |
| 4 | Prompt stopped after 8.1 | Prompt: stop after **S8.2** unless user requests S8.3 |

## Files changed

| File | Change |
| --- | --- |
| `docs/scratch/product-surface-e2e-path.md` | Fixture, authoring sequence, honest S8.1 script status |
| `docs/product-surface-orchestration-plan.md` | S8.1/S8.2 wording, Wave 4 status, prompt seed, board |
| `docs/execution-roadmap.md` | Section 18 statuses aligned |
| `docs/trigger-and-command-surface-plan.md` | Earlier S8.2 reconciliation (unchanged this pass) |
| `docs/scratch/impl-summary-e127630b-w8.md` | This summary |

## Honest path matrix

| Step | Code | Live dogfood |
| --- | --- | --- |
| Arm + live highlight | complete | pending |
| Create (interaction fixture) | complete | pending |
| Post-create dock | complete | pending |
| Isolated task default | complete (S6.1–S6.3, S6.6–S6.7) | pending |
| Interaction dock | complete | pending |

## Deferred / not in Wave 8

- S8.1 live acceptance evidence
- S8.3 release packaging
- S6.4 affinity, S6.5 revision/loop workers
- S7.5 project-first events

## Tests

Documentation-only. No production code changes. No test run required for S8.1 script / S8.2.

## Next work

1. Live interactive Pi dogfood using section 6 of `docs/scratch/product-surface-e2e-path.md` and the section 4 fixture.
2. Store evidence under `docs/dogfood-evidence/` to close S8.1 acceptance.
3. Optional remainder: S6.4, S6.5, S7.5.
4. S8.3 only when the user requests a release.
