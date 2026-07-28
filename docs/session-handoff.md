# Session handoff: post v0.10, ready for M7

- Handoff date: 2026-07-29
- Repository: `Hypabolic/Hypagraph`
- Working branch: `main` (matches `origin/main`)
- Package version: `0.10.0`
- Published release: `v0.10.0` (tag and GitHub release)
- Schema version: **8**
- Completed milestones: M0–M5, M6A, M6B, M6.1, M6.2, M6.3
- Current milestone: **M7** — goal families, recursive Hypagoals, executor abstraction, isolated Pi execution
- Release marker for M7: **v0.11**

## 1. Read first

Read these files in order before you change code:

1. `AGENTS.md` — product name, ASD-STE100 house style, M0 quality rules;
2. `docs/session-handoff.md` — this file;
3. `docs/execution-roadmap.md` — ordered milestones and M7 slices;
4. `docs/product-spec.md` — product contracts;
5. `docs/goal-family-and-concurrent-execution-plan.md` — M7 architecture;
6. `docs/delegation-and-visualisation.md` — executor and UI context for M7;
7. `docs/v0.10-release-notes.md` — what just shipped;
8. `docs/m6-3-external-effect-plan.md` — effect and reconciliation rules still in force;
9. `docs/code-node-adapter-plan.md` — sandbox program body shared by code and effect nodes;
10. `docs/gauntlet-built-in-hypagoal.md` — design for a built-in Gauntlet Hypagoal recipe.

## 2. Released state

| Release | Milestone | Tag |
| --- | --- | --- |
| v0.6 | M5A / M5B | `v0.6` |
| v0.7 | M6A / M6B | `v0.7` / `v0.7.0` |
| v0.8 | M6.1 interaction nodes | `v0.8.0` |
| v0.9 | M6.2 code nodes and sandbox | `v0.9.0` |
| v0.10 | M6.3 external effects and reconciliation | `v0.10.0` |

GitHub release for the latest cut:

https://github.com/Hypabolic/Hypagraph/releases/tag/v0.10.0

### 2.1 M6A / M6B (v0.7)

- Deterministic, model, and executor action lanes;
- direct gate evaluation and check dispatch without a model turn;
- typed history, replay, and explain surfaces.

### 2.2 M6.1 (v0.8)

- `interaction` nodes with node-local `awaiting_response`;
- deterministic presentation kinds `none`, `report`, and `command`;
- independent work continues while a question waits.

### 2.3 M6.2 (v0.9)

- `code` node kind with type-checked TypeScript programs;
- QuickJS sandbox and deny-by-default bridge;
- define-time prepare and host-pinned runtime identity;
- deterministic controller dispatch for ready code;
- schema version 7 introduced code attempt results (superseded storage now at 8).

Primary paths:

- `src/code/*`
- `src/domain/code-authoring.ts`, `code-policy.ts`, `deterministic-code-dispatch.ts`
- `src/pi/deterministic-code-runner.ts`
- `tests/m6-2-code-node-sandbox.test.ts`

### 2.4 M6.3 (v0.10)

- `effect` node kind with durable states `requested`, `observed`, and `indeterminate`;
- store `requested` before any external call;
- lost knowledge after request becomes `indeterminate`, never silent success;
- canonical-identity idempotency keys injected as host bindings;
- read-only reconciliation programs selected **before** new work;
- restore recovers in-flight `requested` effects and cancels effect/code registries;
- execution success and external success stay separate fields;
- schema version **8**;
- simulated dogfood via in-memory host (`docs/m6-3-dogfood.md`).

Primary paths:

- `src/effect/*`
- `src/domain/effect-authoring.ts`, `effect-idempotency.ts`, `effect-policy.ts`
- `src/domain/deterministic-effect-dispatch.ts`
- `src/pi/deterministic-effect-runner.ts`
- `src/effect/recovery.ts` and restore hooks in `src/extension.ts`
- `tests/m6-3-external-effects.test.ts` (24 tests)
- `docs/m6-3-dogfood.md`

## 3. How to verify the tree

From the repository root:

```
npm run typecheck
npm test
# or
npm run check
```

Focused suites:

```
npx vitest run tests/m6-2-code-node-sandbox.test.ts
npx vitest run tests/m6-3-external-effects.test.ts
```

Last full suite at the v0.10 cut: **118 files, 753 tests**.

## 4. Preserved invariants

Do not weaken these invariants in M7 or later:

1. Canonical state changes only through the controller and reducers.
2. The domain reducer stays pure: no clock, random, files, network, or input mutation.
3. Workflow state remains authoritative for goal completion.
4. The model has no workflow-completion or goal-completion tool.
5. One durable event sequence defines one workflow aggregate.
6. Snapshot hashes include canonical state.
7. Stale, cancelled, and pre-revision results cannot change current state.
8. Restore and replay do not repeat external effects or re-run completed sandbox programs.
9. Protected evaluator internals stay outside model-visible output.
10. Independent branches and bounded regions keep independent lifecycle state.
11. Store `requested` before any external effect call starts.
12. A lost external result becomes `indeterminate`, never silent success.
13. Reconciliation queries remain read-only (`observation` only).
14. A revision cannot widen code or effect capability / external authority.
15. All persisted state includes a schema version. Reject unsupported versions with a clear error.

House style: ASD-STE100 Simplified Technical English for repository prose. Product name is **Hypagraph** only.

## 5. Current target: M7

### Objective

Add bounded recursive goal composition and transport-independent node execution.

Release marker: **v0.11**.

### Plans

- `docs/goal-family-and-concurrent-execution-plan.md`
- `docs/delegation-and-visualisation.md`
- `docs/execution-roadmap.md` section 12

### Vertical slices (roadmap order)

1. Add family persistence above existing workflow aggregates.
2. Migrate one v0.6 root into a one-member family projection.
3. Add one family scheduler with sequential dispatch.
4. Add bounded child-goal creation from an active parent task.
5. Add validated child return and parent failure policy.
6. Add explicit executor context and result contracts.
7. Route current-session execution through the executor abstraction.
8. Add an isolated Pi RPC executor.
9. Add nested graph and executor UI.

### Goal-family rules

- Each goal owns one canonical workflow.
- One family controller owns scheduling and canonical writes.
- A child goal waits only its invoking parent task.
- Unrelated branches and independent loops remain runnable.
- Child creation and return are family-level atomic operations.
- Recursive creation has depth, count, scope, and budget bounds.
- Descendant usage is charged to the root family budget.
- Child completion does not complete the parent task automatically.

### Executor rules

- A child Hypagoal is not a subagent.
- A subagent executes one selected node attempt.
- The executor receives explicit reproducible context.
- The executor returns a structured untrusted result.
- Only the controller commits state changes.
- A persisted child Pi session is optional continuity, not canonical context.

### Isolated Pi source note

Process lifecycle can adapt MIT-licensed Pi RPC patterns from:

https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-subagents

Reuse bootstrap, RPC framing, ownership checks, cancellation, child sessions, streaming, and orphan reconciliation.

Do not adopt raw final text as the canonical result, model-owned spawning, same-checkout mutation, or uncontrolled completion-triggered turns.

### M7 acceptance criteria (roadmap)

- A root goal can create one child and one bounded grandchild.
- The root workflow event history remains unchanged during one-member family migration.
- An independent loop remains runnable while a child executes.
- The family scheduler is the only dispatch authority.
- Child output returns through declared fact and evidence contracts.
- Child failure policies have deterministic parent effects.
- The current Pi session and isolated Pi executor use the same result contract.
- Loss of an executor session does not lose canonical context.
- Restore and replay reproduce family membership, bindings, scheduler selections, and child outcomes.

M7 can dispatch sequentially or with limited isolated capacity. Production concurrent mutation waits for **M8** worktree isolation.

## 6. Known gaps and follow-ups

These are not blockers for starting M7:

1. **M6.3 live GitHub dogfood** — the suite and `docs/m6-3-dogfood.md` use an in-memory host. A live pull-request dogfood can wait until credentials and a safe repository exist.
2. **M6.2 non-pure workspace handlers** — pure code programs ship end to end. Broader workspace host handlers remain available to grow with effect and M8 surfaces as needed.
3. **Named recipe library** — Grok-style built-in Hypagoals are not shipped yet. The first product idea is **The Gauntlet** (`docs/gauntlet-built-in-hypagoal.md`; optional sketch `docs/gauntlet-loop-example.png`): specialised implementers, discover and user-confirm references, blind critique against real examples, honest budget stop. Exact topology is open.
4. **Dependabot** — GitHub reports one high vulnerability on the default branch. Review and fix when convenient; it is outside the M7 domain path.

## 7. Suggested first M7 steps

1. Open a branch such as `agent/m7-family-persistence` from current `main`.
2. Read the goal-family plan in full and map slice 1 onto existing persistence (`src/persistence/*`, schema versioning).
3. Keep family records **above** existing workflow aggregates so one-member migration does not rewrite workflow event history.
4. Add tests for family membership and restore before any child-goal creation.
5. Bump schema only when persisted family state requires it. Reject unsupported versions with a clear error.

## 8. Evidence index

| Item | Path |
| --- | --- |
| Roadmap | `docs/execution-roadmap.md` |
| Changelog | `CHANGELOG.md` |
| v0.10 notes | `docs/v0.10-release-notes.md` |
| v0.9 notes | `docs/v0.9-release-notes.md` |
| v0.8 notes | `docs/v0.8-release-notes.md` |
| M6.3 plan | `docs/m6-3-external-effect-plan.md` |
| M6.3 dogfood | `docs/m6-3-dogfood.md` |
| M6.3 tests | `tests/m6-3-external-effects.test.ts` |
| M6.2 plan | `docs/code-node-adapter-plan.md` |
| M6.2 tests | `tests/m6-2-code-node-sandbox.test.ts` |
| M6.1 dogfood | `docs/m6-1-dogfood.md` |
| M7 family plan | `docs/goal-family-and-concurrent-execution-plan.md` |
| M7 delegation | `docs/delegation-and-visualisation.md` |
| Gauntlet built-in recipe (design) | `docs/gauntlet-built-in-hypagoal.md` |
| Grok workflow comparison | `docs/research/grok-build-workflows-comparison.md` |
| Skill | `skills/hypagraph/SKILL.md` |

## 9. Working tree expectation

At handoff time the working tree on `main` is clean and aligned with `origin/main` at the v0.10 release commit. Start new work on a feature branch. Do not cut a release until the user asks.
