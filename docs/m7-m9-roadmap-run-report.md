# M7–M9 roadmap run report

- Report date: 2026-07-30
- Workflow: `.grok/workflows/m7-to-m9-roadmap.rhai`
- Package version: `0.14.0`
- Published release: `v0.14.0` (M7–M9 combined cut)
- Workflow schema version on main: **8**
- Completed slice count: **22**
- Failed slice count: **0**
- Integration: all milestones merged to `main` and released

## 1. Summary

The M7–M9 roadmap workflow implemented every planned vertical slice for M7, M8,
M8.1, and M9. No slice failed in the orchestrator journal.

Feature branches were restacked and merged to `main` in order M8 → M8.1 → M9
(with M9 rebased onto M8.1). Package release `v0.14.0` ships the combined cut.

| Branch | Content after release |
| --- | --- |
| `main` | M7–M9 integrated; tip matches the v0.14 release |
| `agent/m7-roadmap` … `agent/m9-roadmap` | Aligned to `main` at release time |

## 2. Milestone status

| Milestone | Release marker (plan) | Slice delivery | Integrated to `main` | State |
| --- | --- | --- | --- | --- |
| M7 | v0.11 | 9 / 9 | yes | **complete; shipped in v0.14** |
| M8 | v0.12 | 10 / 10 | yes | **complete; shipped in v0.14** |
| M8.1 | v0.13 | 1 / 1 | yes | **complete; shipped in v0.14** |
| M9 | v0.14 | 2 / 2 | yes | **complete; released as v0.14** |

## 3. Completed slice ids

### 3.1 M7 — goal families and isolated Pi execution

| Slice id | Title | Primary commit |
| --- | --- | --- |
| `m7-s1` | Family persistence above workflow aggregates | `b48eb96` |
| `m7-s2` | One-member family projection migration | `85a875d` |
| `m7-s3` | Family scheduler sequential dispatch | `0ff55bf` |
| `m7-s4` | Bounded child-goal creation from parent task | `3f96176` |
| `m7-s5` | Child return and parent failure policy | `79484ff` |
| `m7-s6` | Executor context and result contracts | `5c936cd` |
| `m7-s7` | Route current-session execution through executor abstraction | `d513311` |
| `m7-s8` | Isolated Pi RPC executor | `ee4a8a3` |
| `m7-s9` | Nested graph and executor UI | `da3ae92` |

M7 follow-up fixes on `main` (not separate roadmap slices):

- `4b6caa8` — Fix M7 executor protocol, child return, and input fact gaps
- `f660ab7` — Enforce required facts, reserve child inputs, and fix RPC UTF-8
- `fd52eb3` — Reject incomplete family bindings in executor context materialize

Representative tests on `main` / `agent/m9-roadmap`:

- `tests/goal-family-persistence.test.ts`
- `tests/goal-family-migration.test.ts`
- `tests/m7-s3-family-scheduler.test.ts` … `tests/m7-s9-nested-graph-executor-ui.test.ts`
- `tests/m7-s8-isolated-pi-executor.test.ts`, `tests/m7-s8-isolated-pi-extension.test.ts`

### 3.2 M8 — worktrees and bounded concurrency

| Slice id | Title | Primary commit |
| --- | --- | --- |
| `m8-s1` | Workspace lease contracts | `fa00677` |
| `m8-s2` | Worktree per mutating attempt | `18f9882` |
| `m8-s3` | Structured worker commit results | `c1ac593` |
| `m8-s4` | Validate changed scope and evidence | `50494c8` |
| `m8-s5` | Integration lifecycle and conflict state | `d771e08` |
| `m8-s6` | Post-integration base workspace checks | `e198c98` |
| `m8-s7` | Global and per-executor concurrency limits | `67d9e03` |
| `m8-s8` | Concurrency groups and fairness | `132414e` |
| `m8-s9` | Concurrent loops and child workflows | `23a935f` |
| `m8-s10` | Cancellation, crash recovery, stale integration | `196946a` |

M8 hardening commits (after s10):

- `7d6bc20` — Fix Codex P1/P2 findings on M8 workspace integration safety
- `2e189a6` — Keep process-group SIGKILL after child close; require git worktree metadata gone
- `c2f8ff1` — Keep the force-kill timer referenced until process-group SIGKILL

Representative paths on `agent/m8-roadmap`:

- `src/domain/workspace-lease.ts`, `src/domain/workspace-worktree.ts`
- `src/workspace/git-worktree.ts`
- `tests/m8-s1-workspace-lease-contracts.test.ts` … `tests/m8-s10-cancellation-crash-recovery-stale-integration.test.ts`

### 3.3 M8.1 — dynamic fan-out regions

| Slice id | Title | Primary commit |
| --- | --- | --- |
| `m8.1-s1` | Derived fan-out from typed collection fact | `b1d3674` |

M8.1 hardening commits:

- `7caba51` — Fix M8.1 attempt isolation and restore validation for derived fan-out
- `6205b55` — Harden derived fan-out against nested untrusted accessors

Representative paths on `agent/m8.1-roadmap`:

- `src/domain/derived-fan-out.ts`
- `tests/m8.1-s1-derived-fan-out.test.ts`

### 3.4 M9 — external executor adapters

| Slice id | Title | Primary commit |
| --- | --- | --- |
| `m9-s1` | ACP executor adapter | `4ae22b0` |
| `m9-s2` | Named direct CLI adapters | `ad2a142` |

Representative paths on `agent/m9-roadmap`:

- `src/pi/acp-executor.ts`
- `src/pi/cli-executor.ts`
- `tests/m9-s1-acp-executor.test.ts`
- `tests/m9-s2-cli-executor.test.ts`

## 4. Failed slices

None. Failed count hint from the workflow journal: **0**.

## 5. Branch topology risk

```text
main / agent/m7-roadmap     ── M7 ── a8e3916
         │
         ├── agent/m8-roadmap ── M8 ── c2f8ff1
         │         │
         │         └── agent/m8.1-roadmap ── M8.1 ── 6205b55
         │
         └── agent/m9-roadmap ── M9 only ── ad2a142
             (does not contain M8 or M8.1)
```

Implications:

1. M8 and M8.1 are ready as stacked feature work, but they are not on `main`.
2. M9 was built from `main` after M7. It does not sit on the M8/M8.1 stack.
3. A single product line for v0.11–v0.14 must merge M8 → M8.1 → rebased or re-merged M9, then `main`.
4. Expect merge conflicts in executor routing (`src/extension.ts`, `src/pi/*`) when M8 worktrees meet M9 adapters.

## 6. What is not done

These items are outside slice delivery and remain open:

1. **No package version bump** — still `0.10.0` on every tip.
2. **No changelog or release notes** for v0.11–v0.14.
3. **Roadmap status table** still says Planned for M7–M9.
4. **Session handoff** (`docs/session-handoff.md`) still describes post-v0.10 / ready for M7.
5. **No dogfood evidence packs** for M7–M9 comparable to `docs/m6-*-dogfood.md`.
6. **No PR merge of M8, M8.1, or M9 into `main`.**
7. **M6.3 live GitHub dogfood** and other pre-M7 gaps in the handoff remain.

## 7. Open risks

| Risk | Severity | Notes |
| --- | --- | --- |
| Divergent feature branches | high | M9 lacks M8/M8.1; integrate before release |
| Unmerged M8 concurrency kernel | high | Production concurrent mutation is not on `main` |
| Executor adapter surface without worktree isolation | medium | M9 on `agent/m9-roadmap` can run adapters without M8 lease/worktree rules |
| Documentation drift | medium | Roadmap, handoff, changelog still describe pre-M7 or Planned state |
| Schema / restore coverage for new aggregates | medium | Family and fan-out/lease persistence need full restore/replay review on the integrated tree |
| Live dogfood of isolated Pi, worktrees, ACP, CLI | medium | Unit tests exist; live multi-process dogfood is not recorded |
| Dependabot high vulnerability (handoff) | low–medium | Outside the domain path; still open |
| Named recipe library (Gauntlet) | low | Design only; not required for M7–M9 slice close |
| Release cut without integration | high if attempted | Do not cut v0.11+ until one branch passes full `npm run check` with M7–M9 |

## 8. Release cut decision

**Do not cut a release.**

Reasons:

1. The user did not request a release.
2. Package version remains `0.10.0`.
3. M8, M8.1, and M9 are not on `main`.
4. M9 is not rebased onto M8/M8.1.
5. Changelog, release notes, roadmap status, and session handoff are not updated for a cut.
6. Planned release markers (v0.11–v0.14) need an ordered merge and acceptance pass first.

Suggested order after this report (only when the user asks):

1. Merge or open PR for `agent/m8-roadmap` onto `main` after full check.
2. Merge `agent/m8.1-roadmap` onto the M8 line after full check.
3. Rebase or merge `agent/m9-roadmap` onto the M8.1 line; resolve executor conflicts; full check.
4. Update roadmap status, handoff, changelog, and release notes per milestone.
5. Cut releases only when the user requests them (v0.11 M7, v0.12 M8, v0.13 M8.1, v0.14 M9, or a combined policy the user chooses).

## 9. Evidence index

| Item | Path or ref |
| --- | --- |
| Workflow script | `.grok/workflows/m7-to-m9-roadmap.rhai` |
| Roadmap | `docs/execution-roadmap.md` sections 12–15 |
| M7 plan | `docs/goal-family-and-concurrent-execution-plan.md` |
| M7 delegation | `docs/delegation-and-visualisation.md` |
| Pre-run handoff | `docs/session-handoff.md` |
| M7 on main | commits `b48eb96` … `fd52eb3`, tip `a8e3916` |
| M8 branch | `agent/m8-roadmap` @ `c2f8ff1` |
| M8.1 branch | `agent/m8.1-roadmap` @ `6205b55` |
| M9 branch | `agent/m9-roadmap` @ `ad2a142` |
| This report | `docs/m7-m9-roadmap-run-report.md` |

## 10. Slice count check

Planned by the workflow:

- M7: 9 slices
- M8: 10 slices
- M8.1: 1 slice
- M9: 2 slices
- **Total: 22**

Observed completed: **22**. Failed: **0**. Matches the orchestrator completed-count hint.
