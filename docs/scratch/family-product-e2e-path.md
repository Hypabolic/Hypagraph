# Family product e2e path (F5 dogfood)

- Status: automated substitute required; live TUI pass may stay pending
- Source: `docs/goal-family-product-surface-plan.md` §12
- Automated test: `tests/family-product-f5-e2e-extension.test.ts`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Automated substitute (required)

Extension harness with fake isolated transport (same pattern as Wave 6 isolation tests).

Steps:

1. `hypagoal_start` root definition with `delegate` task then `integrate` task.
2. Headless host (no post-create dock) so continuation may run after create.
3. Start `delegate` with `hypagraph_transition` action `start`.
4. `hypagoal_create_child` with child definition that can publish required output facts.
5. Assert parent `waiting_for_child` and two family members.
6. Drive child task to terminal completed (fake worker or command path) so product return runs.
7. Assert return applied and parent leaves wait (`running` for integration).
8. Assert parent task is not completed solely by child success.
9. Assert `integrate` becomes ready when parent succeeds later (or remains pending while parent runs).

Commands:

```bash
npx vitest run tests/family-product-f5-e2e-extension.test.ts
npm run typecheck
```

## 2. Live interactive script (pending allowed)

1. Arm and create root with the flagship family-ready graph (delegate + integrate).
2. Post-create: inspect Mermaid; choose **Run**.
3. When `delegate` is active, model calls `hypagoal_create_child`.
4. `/hypagraph status` shows two members and child-wait.
5. Child worker runs; no implement follow-up in orchestrator for child body.
6. Child completes; status shows return; parent integrate proceeds.
7. Optional: reload mid child-wait once; confirm membership and wait survive restore policy.
8. Optional: `/hypagraph graph member <childGoalId>` focuses the child graph.

Record live results under `docs/scratch/family-product-dogfood.md` when a live pass runs.

## 3. Automated coverage map

| Acceptance | Automated evidence |
| --- | --- |
| A1–A2 child create tool | `tests/family-product-f1-create-child-extension.test.ts` |
| A3–A5 family dispatch | `tests/family-product-f2-dispatch-extension.test.ts` |
| A6–A7 child return | `tests/family-product-f3-child-return-extension.test.ts` |
| A8–A9 status / graph | `tests/family-product-f4-status-surface.test.ts` |
| A10 reload family | domain + family persistence suites; product restore path |
| A11 skill honesty | `skills/hypagraph/SKILL.md`; Option A + family desk / plan owner / worker |
| A12 e2e path | `tests/family-product-f5-e2e-extension.test.ts` (**requires** returned binding; soft still-active pass removed) |
| R1 create-child authority | F1 Option A tests; isolated-worker block names current-session |
| R2 strict return | F5 success path requires `binding.status === "returned"` |
| R3–R5 remediation | `tests/family-product-r-waves.test.ts` |
| R6 dogfood note | `docs/scratch/family-product-dogfood.md` |

## 4. Live status

Live interactive dogfood: see `docs/scratch/family-product-dogfood.md` (automated gate passed; live TUI deferred with environment note).
