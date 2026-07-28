# Session handoff: M6.2 released as v0.9

- Handoff date: 2026-07-29
- Repository: `Hypabolic/Hypagraph`
- Working branch: `main` after the v0.9 release merge
- Published release: `v0.9`
- Completed milestones: M6A, M6B, M6.1, M6.2 code nodes and sandbox executor
- Current milestone: M6.3 external effects and reconciliation
- M6.2 plan: `docs/code-node-adapter-plan.md`
- M6.2 tests: `tests/m6-2-code-node-sandbox.test.ts`
- M6.3 plan: `docs/m6-3-external-effect-plan.md`
- Schema version: 7
- Release notes: `docs/v0.9-release-notes.md`

## 1. Read first

Read these files in order:

1. `AGENTS.md`;
2. `docs/session-handoff.md`;
3. `docs/execution-roadmap.md`;
4. `docs/product-spec.md`;
5. `docs/code-node-adapter-plan.md`;
6. `docs/m6-3-external-effect-plan.md`;
7. `docs/v0.9-release-notes.md`;
8. `docs/v0.8-release-notes.md`;
9. `docs/goal-family-and-concurrent-execution-plan.md`.

## 2. Released state

M5A and M5B remain available as published `v0.6`.

M6A and M6B are complete and published as `v0.7`.

M6.1 is complete and published as `v0.8`.

M6.2 is complete and published as `v0.9`.

M6.2 provides:

- the `code` node kind with a type-checked TypeScript program;
- definition-time TypeScript prepare and host-pinned runtime identity;
- a QuickJS sandbox executor and a deny-by-default bridge;
- deterministic controller dispatch for ready code nodes;
- durable code lifecycle events and schema version 7;
- capability allowlists with non-widening revision checks;
- scope verification with baseline content hashes for mutating programs;
- definition-time code authoring advisories.

M6.2 ships the full control path for `pure` programs. Non-pure host handlers
for workspace and external surfaces land with M6.3.

## 3. Preserved invariants

Do not weaken these invariants during M6.3 and later work:

- canonical state changes only through the controller and reducers;
- workflow state remains authoritative for goal completion;
- the model has no workflow-completion or goal-completion tool;
- one durable event sequence defines one workflow aggregate;
- snapshot hashes include canonical state;
- stale, cancelled, and pre-revision results cannot change current state;
- restore and replay do not repeat external effects;
- protected evaluator internals remain outside model-visible output;
- independent branches and bounded regions keep independent lifecycle state;
- the root can later become a one-member goal family without rewriting workflow events;
- the domain reducer stays pure; the sandbox and host bridge run outside the reducer;
- a revision cannot widen a code capability allowlist.

## 4. Current target: M6.3 external effects and reconciliation

### Objective

Let a node change external state safely, for example open a pull request, merge,
deploy, or notify, and reconcile a lost result with the external system.

### Plan

`docs/m6-3-external-effect-plan.md`

### Mandatory rules

- An external effect can complete after the host loses the result. The runtime
  must reconcile.
- Host handlers for non-pure code capabilities land with this milestone.
- Replay and restore must not re-run a completed external effect.

### Next work

Start M6.3 from `docs/m6-3-external-effect-plan.md` and the M6.2 host surface note
in `docs/execution-roadmap.md`.

## 5. Release evidence

- M6A dogfood: `docs/m6a-dogfood.md`
- M6B dogfood: `docs/m6b-dogfood.md`
- M6.1 dogfood: `docs/m6-1-dogfood.md`
- M6.2 suite: `tests/m6-2-code-node-sandbox.test.ts`
- v0.9 notes: `docs/v0.9-release-notes.md`
