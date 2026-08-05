# Session handoff: post v0.14, M7–M9 on main

- Handoff date: 2026-07-30
- Repository: `Hypabolic/Hypagraph`
- Working branch: `main` (matches `origin/main` after the v0.14 release)
- Package version: `0.14.0`
- Published release: `v0.14.0` (tag and GitHub release)
- Schema version: **8** (no schema bump was required for M7–M9 storage contracts in this cut)
- Completed milestones: M0–M5, M6A, M6B, M6.1, M6.2, M6.3, **M7, M8, M8.1, M9**
- Current milestone: **v1.0 exit hardening** and product surfaces (recipe library, aggregate/orchestration gaps, Gauntlet)
- Roadmap run report: `docs/m7-m9-roadmap-run-report.md`
- Workflow used: `.grok/workflows/m7-to-m9-roadmap.rhai`

## 1. Read first

1. `AGENTS.md` — product name, ASD-STE100 house style, M0 quality rules;
2. `docs/session-handoff.md` — this file;
3. `docs/execution-roadmap.md` — ordered milestones;
4. `docs/v0.14-release-notes.md` — what this release ships;
5. `docs/m7-m9-roadmap-run-report.md` — slice map and branch history notes;
6. `docs/goal-family-and-concurrent-execution-plan.md` — family and executor architecture;
7. `docs/concurrency-policy-surface.md` — product concurrency limits, groups, and partial-failure (Gate 1.2);
8. `docs/delegation-and-visualisation.md` — executor transports and UI;
9. `docs/deterministic-orchestration-plan.md` — aggregate, synthesis, fan-out (partially still open as product recipes);
10. `docs/gauntlet-built-in-hypagoal.md` — built-in recipe idea (not implemented).

## 2. Released state

| Release | Content | Tag |
| --- | --- | --- |
| v0.6 | M5A / M5B | `v0.6` |
| v0.7 | M6A / M6B | `v0.7` / `v0.7.0` |
| v0.8 | M6.1 interaction nodes | `v0.8.0` |
| v0.9 | M6.2 code nodes and sandbox | `v0.9.0` |
| v0.10 | M6.3 external effects | `v0.10.0` |
| **v0.14** | **M7 + M8 + M8.1 + M9** | **`v0.14.0`** |

GitHub: https://github.com/Hypabolic/Hypagraph/releases/tag/v0.14.0

Plan markers v0.11–v0.13 are absorbed into this single cut. Intermediate tags were not published.

### 2.1 M7 — goal families and isolated Pi (roadmap v0.11)

- Goal-family persistence above workflow aggregates;
- one-member family projection for existing roots;
- sequential family scheduler;
- bounded child-goal create / return / failure policy;
- executor context and structured result contracts;
- current-session and isolated Pi RPC executors;
- nested family graph and executor UI surfaces.

Primary paths: `src/domain/goal-family.ts`, `child-goal-*.ts`, `executor-contract.ts`, `family-scheduler.ts`, `src/persistence/family-*`, `src/pi/isolated-pi-executor.ts`, `src/pi/current-session-executor.ts`, `src/graph/family-projection.ts`, `src/ui/family-*.ts`, `tests/m7-*`, `tests/goal-family-*`.

### 2.2 M8 — worktrees and concurrency (roadmap v0.12)

- Workspace leases;
- git worktree prepare/release for mutating attempts;
- structured worker commits;
- pre-integration scope and evidence validation;
- integration lifecycle and conflict state;
- post-integration base checks (process-group kill, clean worktree);
- concurrency limits and groups with fairness;
- concurrent loop/child selection;
- crash recovery and stale integration rejection.

Primary paths: `src/domain/workspace-*.ts`, `concurrency-*.ts`, `family-concurrent-dispatch.ts`, `src/workspace/*`, `tests/m8-*`.

### 2.3 M8.1 — derived fan-out (roadmap v0.13)

- Pure derived fan-out from a typed collection fact with max bound;
- per-branch attempt lifecycle, evidence, fan-in policy;
- restore validation, attempt isolation, untrusted-input diagnostics.

Primary paths: `src/domain/derived-fan-out.ts`, `tests/m8.1-s1-derived-fan-out.test.ts`.

### 2.4 M9 — external executors (roadmap v0.14)

- ACP executor adapter (JSON-RPC child process);
- named direct CLI executor adapters;
- shared child-process JSON-RPC helper;
- same structured result contract as Pi executors.

Primary paths: `src/pi/acp-executor.ts`, `src/pi/cli-executor.ts`, `src/pi/child-process-jsonrpc.ts`, `tests/m9-*`.

## 3. How to verify

```
npm run typecheck
npm test
# or
npm run check
```

Focused suites by milestone:

```
npx vitest run tests/goal-family-*.test.ts tests/m7-*.test.ts
npx vitest run tests/m8-*.test.ts
npx vitest run tests/m8.1-s1-derived-fan-out.test.ts
npx vitest run tests/m9-*.test.ts
```

## 4. Preserved invariants

Do not weaken these in later work:

1. Canonical state changes only through the controller and reducers.
2. External effects (files, network, process start) belong to the host and executors. Absolute domain purity is not required. Prefer fixed timestamps and IDs when callers need stable replay. See the purity decision in `docs/scratch/adversarial-review-2026-08-04/09-NEXT-STEPS.md`.
3. Workflow state remains authoritative for goal completion.
4. The model has no workflow-completion tool.
5. One durable event sequence defines one workflow aggregate.
6. Snapshot hashes include canonical state.
7. Stale, cancelled, and pre-revision results cannot change current state.
8. Restore and replay do not repeat external effects or re-run completed sandbox/executor effects as new work.
9. Protected evaluator internals stay outside model-visible output.
10. Independent branches and bounded regions keep independent lifecycle state.
11. Store `requested` before external effect calls; lost knowledge is indeterminate.
12. Reconciliation queries remain read-only.
13. Revisions cannot widen code or effect capability / external authority.
14. Executor results are untrusted until validated and settled by the controller.
15. Child Hypagoals are workflows, not free-form subagent spawns; the family controller owns dispatch.
16. All persisted state includes a schema version; reject unsupported versions clearly.

House style: ASD-STE100. Product name: **Hypagraph** only.

Capability honesty: use `docs/capability-ledger.md` for domain / host / ordinary / live claims.

Host modularization: use `docs/host-extraction-plan.md` for `src/extension.ts` seams.

Post-review next steps: `docs/scratch/adversarial-review-2026-08-04/09-NEXT-STEPS.md`.

Create-child authority (2026-08-05): create-child does **not** require a current-session parent. The family desk may call `hypagoal_create_child` for an active parent task with isolated-pi or current-session. The old Option A rule is removed.

Concurrency policy surface (Gate 1.2): `docs/concurrency-policy-surface.md`.

## 5. Current target after v0.14

### 5.1 Exit path to v1.0

Roadmap exit: hardened agent-independent execution kernel. Use section 2 of `docs/execution-roadmap.md` as the capability checklist. Focus on integration dogfood, production hardening, and closing gaps below.

### 5.2 Open product gaps (not blocking this release)

1. **Named recipe library** — Grok-style built-in Hypagoals and launch-with-args.
2. **The Gauntlet** — design only (`docs/gauntlet-built-in-hypagoal.md`).
3. **Deterministic orchestration slices** still incomplete as product: branch-scoped facts, aggregate node (`quorum` / `ranked` / `union`), synthesis node (`docs/deterministic-orchestration-plan.md`).
4. **Live dogfood** — M6.3/M8/M9 live external systems as needed.
5. **Dependabot** — one high vulnerability report on the default branch (hygiene).
6. **Schema migrations** — still pre-external-adoption style rejects; prepare migration policy before first external adoption if not already decided.

### 5.3 Suggested first next steps

1. Update product docs and skill text for family, worktree, and external executors if gaps remain.
2. Dogfood one multi-executor or concurrent worktree path end to end.
3. Implement orchestration aggregate if review-quorum recipes are next.
4. Author the recipe library and a minimal Gauntlet recipe when aggregate + executors are ready.

## 6. Evidence index

| Item | Path |
| --- | --- |
| Release notes | `docs/v0.14-release-notes.md` |
| Changelog | `CHANGELOG.md` |
| Roadmap | `docs/execution-roadmap.md` |
| M7–M9 run report | `docs/m7-m9-roadmap-run-report.md` |
| Roadmap workflow | `.grok/workflows/m7-to-m9-roadmap.rhai` |
| Gauntlet idea | `docs/gauntlet-built-in-hypagoal.md` |
| M6.3 notes | `docs/v0.10-release-notes.md` |

## 7. Working tree expectation

After the v0.14 release commit, `main` is clean and published. Start new work on a feature branch. Do not amend the release tag.
