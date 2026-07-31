# Codex technical review — product surface work (uncommitted)

You are reviewing **all uncommitted work** in the Hypagraph repository at the workspace root.

## Scope

Product surface orchestration (Waves 0–8 code, except live Pi dogfood and optional remainders):

- Trigger arming, validate, `/hypagraph` command merge
- Bottom-dock interaction UI + viewport
- Post-create Mermaid dock (grok-mermaid) with Run / Question / Cancel + auto-continue gate
- Live trigger-word highlight in the Pi editor
- Default isolated-pi for model tasks (orchestrator ≠ runner)
- Draft authoring tools + `.hypagraph` project store
- Goal completed/failed clears pendingContinuation

Read:

- `docs/product-surface-orchestration-plan.md`
- `docs/scratch/product-surface-e2e-path.md`
- `docs/scratch/impl-summary-e127630b-w*.md` (wave summaries)
- Key modules: `src/extension.ts`, `src/ui/bottom-dock-overlay.ts`, `src/pi/post-create-dock.ts`, `src/pi/interaction-dialog.ts`, `src/pi/hypagoal-trigger-editor.ts`, `src/pi/isolated-root-dispatch.ts`, `src/domain/model-executor-profile.ts`, `src/domain/draft*.ts`, `src/project-store/`, `src/graph/mermaid-projection.ts`, `src/ui/mermaid-art.ts`

Use `git status` and `git diff` (read-only) to see the full change set. Prefer reading source over trusting summaries.

## Review criteria

Correctness first. Flag:

1. Security / isolation regressions (worker vs orchestrator tool blocks, draft binding)
2. Race conditions and lifecycle bugs (gates, pendingContinuation, cancel-after-success)
3. Domain purity violations
4. Schema version / persistence correctness
5. Test gaps for load-bearing paths
6. Behaviour that contradicts the plans

## Output format (only this)

## Summary
2–4 sentences. Overall risk. Ship readiness for code (not live dogfood).

## Issues

### Issue N -- Severity: bug|suggestion|nit
- File: path:line
- Description: ...
- Suggestion: ...
- Status: open

If none: empty Issues section.

Reason at high effort. Do not fix code. Do not run destructive commands.
