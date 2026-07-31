# Codex technical review — goal-family product surface (F0–F5)

You are reviewing the **goal-family product surface** implementation in the Hypagraph repository (workspace root). Focus on waves F0–F5 from `docs/goal-family-product-surface-plan.md`.

## Scope (priority files)

- Plan: `docs/goal-family-product-surface-plan.md`
- Dogfood/e2e notes: `docs/scratch/family-product-e2e-path.md`, `docs/scratch/family-product-f0-inventory.md`, `docs/scratch/skill-guidance-audit-family.md`
- Product path modules:
  - `src/pi/hypagoal-create-child.ts`
  - `src/pi/family-product-dispatch.ts`
  - `src/pi/family-product-return.ts`
  - `src/extension.ts` (hypagoal_create_child tool, applyPendingChildReturns, queueGoalContinuation family loop)
  - `src/persistence/family-session.ts` (createBoundedChildGoalInFamily, returnChildGoalInFamily)
  - `src/ui/family-surface.ts` / family status extras
- Tests:
  - `tests/family-product-f1-create-child-extension.test.ts`
  - `tests/family-product-f2-dispatch-extension.test.ts`
  - `tests/family-product-f3-child-return-extension.test.ts`
  - `tests/family-product-f4-status-surface.test.ts`
  - `tests/family-product-f5-e2e-extension.test.ts`
- Skill: `skills/hypagraph/SKILL.md` (child create, family path honesty)

Also use `git status` / read uncommitted files. Prefer source over summaries.

Domain pure modules (`child-goal-creation.ts`, `child-goal-return.ts`, family-scheduler) are baseline — review **product wiring**, not re-litigate pure domain unless the host breaks domain invariants.

## Acceptance criteria to stress (plan A1–A12)

1. Model tool `hypagoal_create_child` commits family + parent waiting_for_child
2. Only active parent task; no create before Run; no scope widen
3. Multi-member family after create; unrelated root components remain eligible
4. Family controller selects across members (not root-only)
5. Child model tasks default isolated-pi
6. Child terminal return → parent leaves wait; parent not auto-complete
7. Failure policies on product path
8. Status / family surface members, bindings, child-wait, budget
9. Graph pane / focus multi-member (as shipped)
10. Restore/reload durability for membership and wait
11. Skill matches live tools
12. Automated tests for create → child → return → integrate

## Review criteria

Correctness first. Flag:

1. Lifecycle / race bugs (create-child during gate, return before settle, double return, orphaned members)
2. Persistence split-brain (family record vs live root events vs child workflow stream)
3. Isolation / tool-policy holes (orchestrator implements child body; mutating tools during wait)
4. Domain purity violations in host path
5. Scheduler idle/blocked incorrect stop when root or child still has work
6. Test gaps on failure policies, restore with active child, concurrent root component while waiting_for_child
7. Skill/README contradictions

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

Reason at high effort (Terra / high). Do not fix code. Do not run destructive commands. Read-only review.
