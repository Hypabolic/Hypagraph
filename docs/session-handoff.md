# Session handoff: M6.3 released as v0.10

- Handoff date: 2026-07-29
- Repository: `Hypabolic/Hypagraph`
- Working branch: `main` after the v0.10 release merge
- Published release: `v0.10`
- Completed milestones: M6A, M6B, M6.1, M6.2, M6.3 external effects and reconciliation
- Current milestone: M7 goal families and isolated Pi execution
- M6.3 plan: `docs/m6-3-external-effect-plan.md`
- M6.3 tests: `tests/m6-3-external-effects.test.ts`
- M6.3 dogfood: `docs/m6-3-dogfood.md` (simulated in-memory host)
- Schema version: 8
- Release notes: `docs/v0.10-release-notes.md`

## 1. Read first

Read these files in order:

1. `AGENTS.md`;
2. `docs/session-handoff.md`;
3. `docs/execution-roadmap.md`;
4. `docs/product-spec.md`;
5. `docs/m6-3-external-effect-plan.md`;
6. `docs/goal-family-and-concurrent-execution-plan.md`;
7. `docs/v0.10-release-notes.md`;
8. `docs/v0.9-release-notes.md`.

## 2. Released state

M5A and M5B remain available as published `v0.6`.

M6A and M6B are complete and published as `v0.7`.

M6.1 is complete and published as `v0.8`.

M6.2 is complete and published as `v0.9`.

M6.3 is complete and published as `v0.10`.

M6.3 provides:

- the `effect` node kind with durable states `requested`, `observed`, and `indeterminate`;
- request-before-start durable lifecycle and lost-knowledge rules;
- canonical-identity idempotency keys injected into sandbox programs;
- declared read-only reconciliation selected before new work;
- restore recovery for in-flight `requested` effects;
- separation of execution success from external success;
- status, graph, and history surfaces for effect state;
- schema version 8;
- simulated dogfood through an in-memory effect host.

## 3. Preserved invariants

Do not weaken these invariants during M7 and later work:

- canonical state changes only through the controller and reducers;
- the domain reducer stays pure;
- store `requested` before any external call starts;
- a lost result becomes `indeterminate`, never silent success;
- restore and replay do not repeat external effects;
- a revision cannot widen effect external authority;
- reconciliation queries remain read-only;
- workflow state remains authoritative for goal completion;
- the model has no workflow-completion or goal-completion tool.

## 4. Current target: M7 goal families and isolated Pi execution

### Objective

Add bounded recursive goal composition and transport-independent node execution.

### Plan

`docs/goal-family-and-concurrent-execution-plan.md` and `docs/execution-roadmap.md` section 12.

### Next work

Start M7 from the roadmap vertical slices. Optional: attach a live GitHub PR
dogfood for M6.3 when credentials and a safe repository are available.

## 5. Release evidence

- M6.3 suite: `tests/m6-3-external-effects.test.ts`
- M6.3 dogfood: `docs/m6-3-dogfood.md`
- M6.2 suite: `tests/m6-2-code-node-sandbox.test.ts`
- v0.10 notes: `docs/v0.10-release-notes.md`
- v0.9 notes: `docs/v0.9-release-notes.md`
