# Goal-family product remediation plan (R1–R6)

- Status: implemented (R1–R6 code and automated gate; live TUI dogfood deferred in dogfood note)
- Purpose: close the ship blockers from the F0–F5 dual review and bake in the product layer model (family desk / Hypagoal plan owner / worker)
- Depends on: `docs/goal-family-product-surface-plan.md` (F0–F5 path exists; not release-trust ready)
- Review sources:
  - `docs/scratch/family-codex-terra-high-review.md` (Codex Terra high)
  - `docs/scratch/family-claude-opus-product-review.md` (product journey)
  - `docs/scratch/advisor-codex-sol-child-orchestrator.md` (Codex Sol product advisor)
  - `docs/scratch/advisor-claude-opus-child-orchestrator.md` (Claude Opus product advisor)
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Program goal

Make the multi-member Hypagoal path **correct, honest, and dogfoodable** for ordinary product use.

After this program:

1. The skill and tools teach one clear create-child authority rule that works on the default journey.
2. Automated e2e **requires** child return and parent leave-wait (not only create).
3. Reload and cancel settle **member** workers, not only the live root.
4. Continuations target the **selected member** through delivery (or current-session is refused on non-root members until that works).
5. Family persistence never overwrites a newer root stream with a stale family snapshot.
6. One live TUI dogfood pass is recorded for root → child → return → integrate.

This program does **not** re-implement pure child-create or child-return domain logic. It fixes host wiring, tests, skill honesty, and the product vocabulary for “orchestrator.”

## 2. Product layer model (bake into every wave)

Advisors agree. Implementers must use these three layers consistently in code, skill, status, and tests.

| Layer | Name in product language | Decides | Must not do |
| --- | --- | --- | --- |
| **L0 Family desk** | Family controller / main product control path | Create and register Hypagoals; allocate budgets; enforce family policy; select next family action; cancel and escalate; commit family and member events through host paths | Let workers or member tools bypass family create/return |
| **L1 Hypagoal plan owner** | Root or child goal as owner of **one** graph | Own objective, node set, local revise, acceptance, return contract; for a child: own its subgraph plan | Act as a second family scheduler; draw family budget without the desk |
| **L2 Worker** | Isolated (or current-session) node attempt | Execute one selected node attempt; return structured results | Create children; schedule siblings; mutate family membership |

### 2.1 User-facing wording

Use this in skill and UI copy:

1. **Family desk** — the control surface that coordinates the whole family (main session status, graph family chrome, create-child host path).
2. **Goal plan owner** — each Hypagoal owns its map; the child is plan owner for **its** graph.
3. **Worker** — hands that run one task; not a planner.

Do **not** say “child is a second main orchestrator for the product.”  
Do say “child is plan owner for its Hypagraph; family desk still coordinates the family.”

### 2.2 Create-child product rule (chosen for R1)

**Decision for this remediation program (Option A — ship first):**

1. A parent task that may call `hypagoal_create_child` **must** use `executorProfile.kind: "current-session"`.
2. That step runs on the family desk session so create-child is legal.
3. The **child’s** implement tasks default to `isolated-pi` (child plan owner’s work, not main-chat implement).
4. Workers never call create-child.
5. Option B (isolated parent emits a structured create-child **request**; family desk admits it) is an explicit **follow-up**, not R1–R6 scope unless R1 is blocked.

Document Option A in skill, tool guidelines, and flagship recipe. Reject or warn when create-child is attempted against a parent node whose profile is isolated-pi and an isolated attempt owns the node (clear diagnostic).

## 3. Goal contract for this program

### 3.1 Outcome

An ordinary model that follows the skill can create a root, Run, start a **current-session** parent delegate task, call `hypagoal_create_child`, see multi-member status, run the child’s default isolated task, complete return, leave parent wait, and integrate — with automated proof that requires return, and with restore that does not leave child attempts stuck.

### 3.2 Acceptance

| ID | Criterion | Review source |
| --- | --- | --- |
| R-A1 | Skill + tool guidelines require current-session on create-child parent tasks; flagship recipe includes that profile; diagnostic when create-child is blocked by active isolated parent ownership | Terra #4, Opus Gap 1, advisors |
| R-A2 | F5 (or successor) e2e **requires** `binding.status === "returned"`, parent task not auto-succeeded, return outcome completed for the success path | Terra #5, Opus Gap 2 |
| R-A3 | Active isolated attempt bookkeeping stores member goalId + workflowId; restore/branch/cancel cancel the **member** attempt and persist member stream | Terra #2, Opus Gap 3 |
| R-A4 | Model continuations for non-root members validate and deliver against the **member** workflow, or product rejects current-session on non-root members with a clear error until delivery works | Terra #1, Opus Gap 4 |
| R-A5 | Before child workflow replace/append, host merges **current live root** events/snapshot into the family record | Terra #3, Opus Gap 5 |
| R-A6 | Live dogfood script run recorded under `docs/scratch/family-product-dogfood.md` (pass or dated fail with blockers) | Opus Gap 8, original #6 |
| R-A7 | Layer model (§2) appears in skill and status copy (family desk / plan owner / worker); no “worker creates children” guidance | Advisors |
| R-A8 | Focused tests cover R-A1–R-A5; typecheck green | This plan |

### 3.3 Non-goals

1. Second family scheduler inside the child.
2. Full concurrent multi-pending family dispatch productization (sequential remains OK if documented).
3. Option B controller-mediated create-child from isolated parents (follow-up).
4. Grandchild / F6 depth dogfood (optional after R1–R6).
5. Global tool rename.
6. Release cut unless requested separately.

## 4. Baseline (already true)

Confirm before R1:

| ID | Capability |
| --- | --- |
| B1 | `hypagoal_create_child` registered and commits via `createBoundedChildGoalInFamily` |
| B2 | Family selection in `queueGoalContinuation` via `selectFamilyProductControllerAction` |
| B3 | Product return via `applyPendingChildReturns` / `returnChildGoalInFamily` |
| B4 | Status and graph member focus exist (F4) |
| B5 | Pure domain child create/return and family scheduler suites pass |
| B6 | F1–F5 extension tests exist and pass under **current-session parent** convention |

## 5. Orchestrator rules

1. Execute **R1 → R6 in order** unless a wave marks parallel-safe.
2. Reuse domain helpers; fix host wiring first.
3. Domain reducer stays pure.
4. Prefer clear diagnostics over silent fallbacks.
5. Update skill and plan status when behaviour changes.
6. ASD-STE100 for all new prose.
7. After each wave: focused tests green; update status board in §10.

## 6. Dependency graph

```text
R1 Create-child authority + skill honesty + layer vocabulary
  → R2 Harden automated e2e (require return)
  → R3 Member-aware worker cancel / restore
  → R4 Member-aware continuation delivery (or ban CS on non-root)
  → R5 Live-root merge before family child persist
  → R6 Live TUI dogfood record
```

R3 and R4 both need member identity on in-flight work; R3 can land first with bookkeeping fields, R4 reuses them for delivery.

R5 can start after R1 if needed in parallel with R3 **only** when no shared conflict on `persistNonRootMemberUpdate`; prefer after R3 for safer tests.

## 7. Waves R1–R6

### R1 — Create-child authority and product honesty

**Maps to:** Terra #4, Opus Gap 1 + Gap 6, advisors (create-child authority + layer model).

**Goal.** The advertised path works without lying. Family desk performs create-child; parent plan-owner step runs current-session; child plan-owner work stays isolated by default.

**Work**

1. **Product rule (Option A)** encoded in:
   - `skills/hypagraph/SKILL.md` (layer model §2; create-child parent must be current-session; workers never create-child; child owns its graph plan).
   - `hypagoal_create_child` promptGuidelines and description.
   - Flagship family recipe: parent `delegate` with `executorProfile.kind: "current-session"`; child implement task without profile (isolated-pi default).
2. Host diagnostic when create-child is blocked because an isolated worker owns the parent attempt (message must name current-session requirement or “wait until worker finishes / use current-session parent”).
3. Optional validation advisory at create-time if a node is documented as create-child parent without current-session (advisory only if cheap; hard reject not required at define-time).
4. Test: default-profile parent with active isolated attempt cannot create-child; current-session parent can (extend F1).
5. README / plan honesty: “multi-member path requires current-session create-child parent until Option B.”

**Done when**

- R-A1 and R-A7 hold.
- No skill text implies default isolated parent can call create-child mid-attempt.

**Out of scope:** Option B request protocol.

---

### R2 — Harden automated e2e (require return)

**Maps to:** Terra #5, Opus Gap 2.

**Goal.** A12 is not green unless product return ran.

**Work**

1. Change `tests/family-product-f5-e2e-extension.test.ts` (or add `family-product-r2-e2e-extension.test.ts`) so success path **requires**:
   - `binding.status === "returned"`;
   - return outcome `completed`;
   - parent create-child node status `running` (integration), not `succeeded`;
   - root goal still `active` after child return.
2. Remove or isolate soft branches that accept still-`active` bindings as pass.
3. Keep create-only coverage in F1.
4. Add at least one extension test for a **failed** child under `fail-parent-node` or `block-parent-node` if not already hard-required in F3 (F3 has some; ensure R2 e2e success path is strict).
5. Update `docs/scratch/family-product-e2e-path.md` acceptance map.

**Done when**

- R-A2 holds.
- F5 cannot pass without return.

---

### R3 — Member-aware isolated attempt cancel and restore

**Maps to:** Terra #2, Opus Gap 3.

**Goal.** Family desk teardown settles the **member** that owns the worker.

**Work**

1. Extend active isolated attempt bookkeeping (root path type in `isolated-root-dispatch` / extension host memory) with:
   - `goalId`;
   - `workflowId`;
   - keep `nodeId`, `attemptId`, abort controller, generations.
2. On restore, branch change, shutdown, and `/hypagraph executor cancel`:
   - abort process as today;
   - build cancel-attempt against the **member** workflow state from the family record when `workflowId` is not the live root;
   - persist member stream update into the family record;
   - then pause root / clear host bookkeeping as appropriate.
3. Ensure parent binding does not remain active forever with a ghost running child attempt after reload.
4. Tests: extension or persistence-level test with fake child worker active through restore/branch; assert child attempt cancelled or settled and binding policy applied or wait state consistent.

**Done when**

- R-A3 holds.
- No “parent waits forever after reload while child attempt still running in family record” for the tested path.

---

### R4 — Member-aware continuation delivery

**Maps to:** Terra #1, Opus Gap 4.

**Goal.** Child plan-owner current-session work (if allowed) is deliverable; otherwise product refuses it clearly.

**Preferred implementation**

1. Introduce durable **selected member execution context** on the host while a non-root continuation is pending:
   - member goalId, workflowId, continuation operation identity;
   - delivery, tool validation, turn accounting, and persist target that member.
2. After `dispatchSelectedMemberAction` queues a model follow-up for a child, do **not** restore root as the only validation identity until the continuation is delivered or abandoned.
3. On settle/abandon, clear member context and restore family desk root view.
4. Tests: child node with current-session receives a non-stale continuation; lifecycle tool on that turn targets child workflow.

**Fallback if too large for one wave**

1. Reject `executorProfile.kind: "current-session"` on non-root member tasks at prepare/dispatch with a clear diagnostic.
2. Skill states: child tasks use isolated-pi until member delivery exists.
3. Tests: reject path; isolated child path still works (R2).

**Done when**

- R-A4 holds via full delivery **or** explicit ban + tests + skill.
- Record which path landed in §10 Deviations.

---

### R5 — Live root merge before family child persist

**Maps to:** Terra #3, Opus Gap 5.

**Goal.** No family-record split-brain when root siblings advance during child work.

**Work**

1. In `persistNonRootMemberUpdate` (and any replace-child-workflow path), **merge** current live root `events` + `snapshot` into the family record’s root workflow entry before appending the updated child workflow and family record.
2. Same merge on create-child path if not already live-synced at commit time (create-child already syncs parent; verify no other write paths skip it).
3. Test: root has an independent ready component; after child create, advance root sibling; then persist child update; restore family; root sequence/snapshot match live root, child membership intact.

**Done when**

- R-A5 holds.
- Test proves sibling root work is not overwritten by stale `selection.family`.

---

### R6 — Live TUI dogfood and status attribution

**Maps to:** original fix #6, Opus Gap 8, advisors (UX attribution).

**Goal.** Human-visible proof and clearer “who owns this work.”

**Work**

1. Run live script (below); write `docs/scratch/family-product-dogfood.md` with pass/fail, terminal size notes, and executor status notes.
2. Status / widget attribution (minimum):
   - when a root or child worker is active, show **member goal id** (short) + node + attempt;
   - child-wait line names parent node and child goal;
   - optional: after create-child, graph focus defaults to child member (if cheap; else document manual `/hypagraph graph member`).
3. Confirm skill layer language matches live UI labels where possible (“Family desk” / member lines).
4. If live pass blocked by environment (PI_BIN), record that; automated R2 remains the code gate.

**Live script (required attempt)**

1. Executor status OK.
2. Create root: `delegate` (current-session) + `integrate` (requires delegate).
3. Run on post-create dock.
4. On active delegate, `hypagoal_create_child` with isolated child implement task + required output facts.
5. Status: two members, active binding, child-wait.
6. Child worker runs; main chat does not implement child body.
7. After child complete: binding returned; delegate running for integrate; not auto-succeeded.
8. Finish integrate; observe root terminal rules.
9. Optional: reload mid wait; confirm no ghost child attempt.

**Done when**

- R-A6 holds (file exists with dated result).
- Attribution lines present or explicitly deferred with reason in dogfood note.

## 8. Mapping: old “1–6” list → this plan

| Earlier priority | This wave | Review issues |
| --- | --- | --- |
| 1 Create-child authority + skill | **R1** | Terra #4, Opus G1/G6, advisors |
| 2 Harden F5 require return | **R2** | Terra #5, Opus G2 |
| 3 Member-aware abort/restore | **R3** | Terra #2, Opus G3 |
| 4 Member-aware continuation delivery | **R4** | Terra #1, Opus G4 |
| 5 Live root merge on family persist | **R5** | Terra #3, Opus G5 |
| 6 Live TUI dogfood | **R6** | Opus G8, advisors UX |

Layer model and vocabulary are required in **R1** and reinforced in **R6**, not a separate wave.

## 9. Implementation notes

### 9.1 Files likely to change

| Area | Paths |
| --- | --- |
| Create-child tool / gates | `src/extension.ts`, `src/pi/hypagoal-create-child.ts`, `src/pi/mutating-tool-policy.ts` |
| Member dispatch / persist | `src/extension.ts`, `src/pi/family-product-dispatch.ts`, `src/persistence/family-session.ts` |
| Isolated attempt identity | `src/pi/isolated-root-dispatch.ts`, extension bookkeeping |
| Skill / README | `skills/hypagraph/SKILL.md`, `README.md` |
| Tests | `tests/family-product-*.test.ts`, new r-series if cleaner |
| Dogfood | `docs/scratch/family-product-dogfood.md`, e2e path note |

### 9.2 Call-chain requirements

**Create-child (family desk)**

1. Parent task current-session and active (R1).
2. Live parent stream synced into family.
3. `createBoundedChildGoalInFamily`.
4. Append parent wait events to root store.
5. Append family record.
6. Child plan owner’s first ready task may dispatch isolated (L2).

**Child work**

1. Family desk selects child member action (L0).
2. Child plan owner’s node runs via isolated worker by default (L1 content, L2 hands).
3. Persist child stream with **live root merge** (R5).
4. On terminal child: product return (L0); parent leaves wait (L1 parent integration).

**Restore**

1. Abort worker.
2. Cancel **member** attempt (R3).
3. Pause family desk root as today.
4. Re-arm gates only when never-dispatched rules still apply.

### 9.3 Diagnostics (examples)

- “Child create requires a current-session parent task. Default isolated workers cannot create child Hypagoals.”
- “An isolated worker owns parent task 'delegate'. Finish or cancel that worker, or author the parent with current-session.”
- “Current-session is not supported on child member tasks until member continuation delivery ships.” (if R4 fallback)
- “Child return applied. Integrate returned facts on the parent task. The parent task is not complete.”

## 10. Status board

| Wave | Status | Notes |
| --- | --- | --- |
| R1 Create-child authority + skill + layers | done | Option A in skill, tool guidelines, diagnostics, F1 tests |
| R2 E2e requires return | done | F5 soft still-active pass removed |
| R3 Member-aware cancel/restore | done | goalId/workflowId; cancelSnapshot mid-flight; latestFamilyRecord on shutdown; restore/cancel tests |
| R4 Member continuation delivery or ban | done | **Ban fallback** (see Deviations) |
| R5 Live root merge on child persist | done | mergeLiveRootIntoFamily + skip double-append after member swap |
| R6 Live dogfood + attribution | done | dogfood note + Worker member attribution; live TUI deferred |

### Deviations

- **R4 ban fallback:** product rejects `executorProfile.kind: "current-session"` on non-root member dispatch with `NON_ROOT_CURRENT_SESSION_BAN_REASON`. Full member continuation delivery is deferred. Skill and tests record the ban. Child tasks remain default isolated-pi.

## 11. Verification plan

1. `npm run typecheck` exits 0.
2. Focused vitest: family-product F1–F5 plus new R-wave tests exit 0.
3. Grep skill for forbidden claims: isolated parent create-child mid-worker; worker creates child.
4. R2 e2e fails if return is skipped (negative check once).
5. R6 dogfood file present under `docs/scratch/family-product-dogfood.md`.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Option A feels like a downgrade | Document that child work stays isolated; only create-child parent step is current-session |
| R4 full delivery is large | Fallback ban on non-root current-session |
| Live dogfood blocked by PI_BIN | Record environment limit; R2 remains code gate |
| Vocabulary churn (“orchestrator”) | Standardize on family desk / plan owner / worker in skill |

## 13. Relationship to other plans

| Document | Role |
| --- | --- |
| `docs/goal-family-product-surface-plan.md` | Original F0–F5 build; this plan remediates trust gaps |
| `docs/goal-family-and-concurrent-execution-plan.md` | Domain architecture; one family controller preserved |
| Advisor notes under `docs/scratch/advisor-*-child-orchestrator.md` | Product layer model source |
| Dual review under `docs/scratch/family-*-review.md` | Bug list source |

## 14. Hypagoal-oriented summary

**Objective.** Remediate multi-member product trust: honest create-child authority, e2e that requires return, member-aware cancel and continuation, family persist without root split-brain, live dogfood, and a three-layer vocabulary (family desk / goal plan owner / worker).

**Order.** R1 → R2 → R3 → R4 → R5 → R6.

**Do not build.** Second family scheduler; worker-created children; Option B unless R1 cannot ship.

**Success signal.** Skill-default journey works with current-session parent + isolated child; F5 requires returned binding; reload does not ghost-run child attempts; dogfood note exists.
