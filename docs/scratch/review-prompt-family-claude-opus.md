# Claude Opus product review — goal-family product surface (F0–F5)

You are reviewing the **product journey** for multi-member Hypagoal families (graph of graphs), not only unit tests.

## Program intent

Ordinary Pi path:

1. Create root → Run dock
2. Active parent task → `hypagoal_create_child`
3. Parent `waiting_for_child`; other root work can still be selected
4. Child runs (default isolated-pi)
5. Child terminal → validated return → parent integrates (not auto-complete)
6. Status/graph/skill make the path legible

Plan: `docs/goal-family-product-surface-plan.md` (status claims F0–F5 product path shipped).

## Read

- Plan acceptance A1–A12
- `docs/scratch/family-product-e2e-path.md`
- `docs/scratch/skill-guidance-audit-family.md`
- Skill sections on goal contract, child Hypagoal, create-child
- Extension tool `hypagoal_create_child` and family controller loop in `src/extension.ts`
- F1–F5 tests under `tests/family-product-*.test.ts`

## Product review criteria

1. Can a model following the skill complete root → child → return without inventing tools?
2. Failure modes: post-create gate, non-task parent, scope widen, store failure — are they user-visible and safe?
3. Status honesty: multi-member, bindings, child-wait, artifact written
4. Gaps vs vision: sequential-only dispatch, concurrent multi-member, live dogfood, F6 grandchild
5. UX risk: silent incomplete family members, revision exhaustion while parent waits, wrong mental model (child as subagent)

## Output format (only this)

## Product summary
2–5 sentences. Would you dogfood this? What is code-complete vs live-pending?

## Strengths
Bullet list.

## Product gaps and risks

### Gap N -- Severity: high|medium|low
- Area: ...
- Why it matters for the user: ...
- Recommendation: ...

## Recommended dogfood script
Numbered steps for live verification of the family path.

Do not implement fixes. Read-only. Do not use --bare if it skips auth.
