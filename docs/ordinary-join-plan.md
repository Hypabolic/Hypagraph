# Ordinary join plan

- Status: active plan (design only; no product code in this document)
- Date: 2026-08-05
- Package baseline: 0.14.0
- Branch context: `feature/in-pi-demo-tour`
- Writing standard: ASD-STE100 Simplified Technical English
- Ledger row: Aggregate / quorum / synthesis nodes (`docs/capability-ledger.md`)
- Gate source: Gate 2–3 in `docs/scratch/adversarial-review-2026-08-04/09-NEXT-STEPS.md`
- Related code:
  - `src/domain/child-outcome-synthesis.ts`
  - `src/pi/family-product-synthesis.ts`
  - `src/extension.ts` (join after child return and restore re-entry)
  - `tests/s6-synthesis-fan-in.test.ts`
  - `skills/hypagraph/SKILL.md`

## 1. Purpose

Close the **Ordinary** gap for multi-child fan-in.

Today the product has Domain and Host all-success join (S6). A normal multi-child family still does not join without author special steps. This plan defines Ordinary done, design choices, slices, non-goals, and risks.

This program does **not** require Live Pi dogfood. Keep ledger **Live=No** when no Pi evidence exists.

## 2. Current gap (Ordinary = No)

Ledger row **Aggregate / quorum / synthesis nodes** is Domain=Yes, Host=Yes, Ordinary=No, Live=No.

Three product gaps keep Ordinary at No.

### 2.1 Result produce is required

Auto product join refuses to apply when the parent task does not declare boolean produce `join.passed` (default result fact name).

Evidence:

- `isAutoProductJoinEligible` requires `parentDeclaresJoinResultFact`.
- Domain apply skips fact publish when the produce is absent.
- A failed join without produce and without a parent mutation is rejected (`child_outcome_synthesis_no_parent_effect`).
- Tests prove skip when the parent definition has no join produce.

A normal author who only creates children does not declare that produce. Join evaluation may run. Parent state does not change for a clean pass path.

### 2.2 N greater than 2 joins early without expectedBindingCount

Auto join without `expectedBindingCount` uses `AUTO_JOIN_MIN_BINDING_COUNT = 2`.

Rules today:

1. Join set is every binding for `(parentGoalId, parentNodeId)`.
2. Auto apply needs at least two bindings when `expectedBindingCount` is absent.
3. That rule is safe only for a planned join of exactly two children.
4. For three or more sequential children, the second return can make the set size two and complete the join early.
5. Callers must set `expectedBindingCount` to the planned size for N greater than 2.
6. One-child joins need an explicit policy or `expectedBindingCount: 1`.

Tests document early apply after two of three sequential returns.

A normal author does not set `expectedBindingCount`. Safe multi-child join for N greater than 2 is not ordinary.

### 2.3 Skill silence

`skills/hypagraph/SKILL.md` documents:

- create-child from an active parent task;
- parent wait and single-child return;
- flagship family recipe (root + one child);
- child completion does not complete the parent task.

The skill does **not** document:

- multi-child fan-out then join;
- produce `join.passed`;
- `expectedBindingCount`;
- parent continue or fail after join;
- when auto join applies after all children return.

A model that follows the skill can create children and return them. It does not reach a closed multi-child join as an ordinary path.

### 2.4 What already works (not the gap)

| Layer | Present behaviour |
| --- | --- |
| Domain | Schema v1 all-success policy and pure evaluation; optional `expectedBindingCount`; parent apply publish and block |
| Host helpers | Auto policy from parent bindings; eligibility; ready join after returns; persisted-family apply |
| Extension | Join after child returns; re-run on restore re-entry; quiet skip when parent is not running; idempotent when fact already on the attempt |
| Tests | S6 domain and host substitute in `tests/s6-synthesis-fan-in.test.ts` |
| Child failure policy | Owns parent fail or block when a non-completed return applies first; synthesis quiet-skips |

## 3. Ordinary definition of done

Ordinary is true when all of the following hold.

### 3.1 User-visible outcome

A parent task with **two or more** children joins when every child in that join set is terminal.

The author does **not**:

1. declare produce `join.passed` (or any join result produce) on the parent node;
2. set `expectedBindingCount` by hand;
3. pass an explicit synthesis policy from the tool surface.

The host applies the join. The parent then continues or fails from that join result.

### 3.2 Pass path

When every join member completes:

1. The product records a deterministic join pass (default fact `join.passed` = true, or an equivalent durable parent effect defined in §4).
2. The parent task stays **running** (or is otherwise ready for integration / next work).
3. Downstream work that depends on the join result can proceed when the graph requires that fact.
4. Re-entry does not publish the fact twice for the same attempt.

### 3.3 Fail path

When any join member is not completed (failed, cancelled, or budget-limited) and the join set is terminal:

1. The product records a deterministic join fail (default fact `join.passed` = false, or block only when policy already owns the parent).
2. When child failure policy has **not** already failed or blocked the parent, the host blocks the parent node (default) after the fail result.
3. When child failure policy already failed or blocked the parent, synthesis quiet-skips. That policy owns the parent effect.
4. Re-entry stays quiet (no repeated warning storm).

### 3.4 Safe N-child rule

For a planned multi-child fan-out of size N (N ≥ 2):

1. The join must not complete after only K terminal members when K < N.
2. The author must not supply N by hand.
3. The host or domain must obtain the planned size from product state (wait set, create tally, or closed fan-out marker — see §4).

### 3.5 Ledger exit for this program

| Field | Target after this program |
| --- | --- |
| Domain | Yes (already) |
| Host | Yes (already; extend for Ordinary rules) |
| Ordinary | **Yes** when §3.1–§3.4 and automated tests pass |
| Live | **No** (Live Pi dogfood is out of scope) |

Gate 2.3 Live acceptance remains a later program. Gate 3 recipe productization may use Ordinary join but is not required here.

### 3.6 Proof bar

Automated tests must prove:

1. two-child pass without author produce and without `expectedBindingCount`;
2. two-child fail blocks (or quiet-skips when failure policy already owns the parent);
3. three-or-more does not join early;
4. restore re-entry applies once and is idempotent;
5. skill text describes the ordinary multi-child join path.

Live Pi evidence is not required for Ordinary=Yes on this row for this program.

## 4. Design options and chosen approach

### 4.1 Default result fact

Problem: auto join requires author-declared boolean produce `join.passed`.

| Option | Description | Pros | Cons |
| --- | --- | --- | --- |
| **A. Inject produce** | At create-child or authoring time, host or draft tools add `produces: [{ name: "join.passed", type: "boolean" }]` when the parent may fan out. | Keeps domain rule “publish only declared facts”. | Author graph mutates; revision and validation surface changes; still an authoring-time special case. |
| **B. Host-only fact** | Product path publishes the default join fact even when the definition does not declare it. Domain gains a controlled host apply flag or a product-only apply helper. | Ordinary path needs no definition change; explicit policies can keep declare-required. | Slightly weakens “facts only when produced”; gates that require declared facts need care. |
| **C. Always publish when undeclared** | Domain always publishes `resultFactName` on terminal apply when undeclared. | Simplest apply path. | Broad behaviour change for all callers; harder to keep pure author contracts. |

**Chosen: Option B (host-only default fact), with a narrow default.**

Rules:

1. Auto product path only. Explicit policies may keep the current declare-required behaviour unless the policy opts into host publish.
2. Only the default name `join.passed` (`DEFAULT_JOIN_RESULT_FACT_NAME`) may publish without a parent produce declaration.
3. Custom `resultFactName` still requires a matching boolean produce on the parent node.
4. Domain pure evaluation still emits `publishedFact` on terminal results. Product eligibility no longer rejects auto join solely because the produce is absent.
5. Apply must publish `join.passed` true or false on the current parent attempt when eligible, or block on fail when publish is impossible, so a failed join always has a parent effect when the parent is still running.
6. If the author **does** declare `join.passed`, behaviour stays the same (declare path and host path agree).
7. Idempotence remains: if the fact is already on the current attempt, skip re-apply.

Rationale: Ordinary join must work for a parent task that only creates children. Option A forces graph mutation for every multi-child parent. Option C is wider than needed. Option B limits the exception to the product auto path and the default fact name.

### 4.2 Planned binding count / waiting_for_child set

Problem: auto join without `expectedBindingCount` can complete after two sequential returns while more children are still planned.

| Option | Description | Pros | Cons |
| --- | --- | --- | --- |
| **A. Author expectedBindingCount** | Keep today’s rule. Skill teaches the field. | Already implemented. | Fails Ordinary (hand configuration). |
| **B. Create tally as planned count** | Host increments planned count on each create-child for `(parentGoalId, parentNodeId, parentAttemptId)`. Auto policy sets `expectedBindingCount` from that tally. | No author field; works for sequential create after returns if join is delayed until tally is stable. | After two returns, tally is two and join still applies before a third create unless join is deferred another way. |
| **C. Multi-child wait set** | Parent may create additional children while `waiting_for_child`. Parent stays waiting while any binding under that parent node is active. Last terminal return resumes parent to running. Join set is all bindings for the parent node when the wait set is empty. | Planned size is the open wait set; N greater than 2 is safe without a hand count; matches concurrent sibling work. | Domain change to create-child and child-return; skill must teach fan-out while waiting. |
| **D. Explicit close-fan-out** | Author or model closes the fan-out before join. | Clear lifecycle. | Not ordinary; extra tool or fact. |

**Chosen: Option C (multi-child wait set) as the ordinary spine, with Option B as a host safety net.**

#### 4.2.1 Multi-child wait set (primary)

1. Create-child is allowed when the parent task is `running` **or** `waiting_for_child` for the same parent node and the same current attempt.
2. Create-child always records an active binding and sets parent status to `waiting_for_child` when it is not already waiting.
3. Child return for one binding:
   - **Completed:** if any other binding for the same parent goal and parent node is still active, parent stays `waiting_for_child`; if no active binding remains, parent becomes `running`.
   - **Non-completed:** apply the child failure policy on the parent immediately (see §7.2), even when sibling bindings are still active. Remaining active sibling bindings for that parent node are terminalised (cancelled in the family) so the family has no leftover actives against a non-waiting parent.
4. Auto join runs only when:
   - every binding for `(parentGoalId, parentNodeId)` is terminal;
   - parent node is running (success path after full wait clear);
   - binding count ≥ `AUTO_JOIN_MIN_BINDING_COUNT` (2) for auto multi-child;
   - join fact not already applied for the attempt.
5. No author `expectedBindingCount` is required for this path.
6. One-child families: auto multi-child minimum stays 2. One-child remains explicit policy or a later one-child ordinary rule (see risks). Ordinary multi-child definition requires 2+ children.

#### 4.2.2 Create tally safety net (secondary)

1. Host records create count per parent node attempt when create-child commits.
2. When join runs, if create count is greater than the terminal binding count, stay pending.
3. This catches races where a create is in flight outside the wait-set view.
4. Do not require the author to pass this count.

#### 4.2.3 Explicit expectedBindingCount

Keep the field for advanced callers and tests. Ordinary path must not need it.

### 4.3 Parent node transition on pass / fail

Problem: Ordinary done requires the parent to continue or fail from the join, not only evaluate.

| Option | Description | Pros | Cons |
| --- | --- | --- | --- |
| **A. Fact only** | Publish `join.passed` only. Leave parent running on pass and fail. | Simple. | Fail does not stop parent work; weak Ordinary fail path. |
| **B. Fact + block on fail** | Publish on pass and fail; block parent on fail when still running. | Matches current S6 host default (`blockParentOnFailure` default true). | Overlap with child failure policy (must stay quiet-skip). |
| **C. Complete parent task on pass** | Join pass completes the parent node. | Strong signal. | Violates product rule: child or join success must not auto-complete parent integration. |

**Chosen: Option B (fact + block on fail), aligned with existing S6 apply.**

Pass:

1. Publish `join.passed` = true (host-only default allowed per §4.1).
2. Leave parent task **running** for integration and later nodes.
3. Do not complete the parent task or the parent goal from join alone.
4. Notify once with existing `renderJoinSynthesisApplied` style text.

Fail:

1. Publish `join.passed` = false when the parent is still running and publish is allowed.
2. Block the parent node when `blockParentOnFailure` is true (product default) and the parent is still running.
3. If child failure policy already failed or blocked the parent, skip synthesis apply and stay quiet on re-entry.
4. Do not double-block or emit a diagnostic every controller pass.

Ready next work:

1. Pass does not by itself start a new node. Readiness and the family controller select next work as today.
2. Graphs that gate on `join.passed` can use an author-declared produce and a gate when they need typed routing. Ordinary multi-child without that gate still gets the durable fact and a running parent.

## 5. Slice map

Implement in order. Commit after each green slice. Do not cut a release in this program. Do not push unless the user asks.

### 5.1 Slice J1 — Default result fact without author produce

**Goal:** Auto product join applies for a parent that never declared `join.passed`.

**Scope:**

1. Product eligibility: auto path does not require produce for `DEFAULT_JOIN_RESULT_FACT_NAME`.
2. Product or domain apply: publish default join fact when undeclared on auto path.
3. Keep declare-required behaviour for non-default result fact names.
4. Keep idempotence and restore re-entry quiet second pass.
5. Failed join still has a parent effect when the parent is running (publish false and/or block).

**Acceptance:**

1. Two terminal completed children → `join.passed` true on parent attempt; parent running.
2. Parent definition has no `produces` entry for `join.passed`.
3. No `expectedBindingCount` in the policy.
4. Second apply on the same state does not append duplicate fact events.
5. Existing S6 tests that declare produce still pass.

**Primary test file:** `tests/s6-synthesis-fan-in.test.ts` (extend)

**Optional new file if the suite grows too large:** `tests/ordinary-join-default-fact.test.ts`

**Suggested commit theme:** ordinary join default fact without author produce

### 5.2 Slice J2 — Safe N-child join without hand expectedBindingCount

**Goal:** A planned join of three or more children does not complete early. Author does not set `expectedBindingCount`.

**Scope:**

1. Domain or host multi-child wait set (§4.2.1):
   - create-child allowed while `waiting_for_child` on the same parent attempt and node;
   - parent remains waiting while any sibling binding is active;
   - last clearing return resumes parent to running on the success path.
2. Auto join only after the wait set is empty and all bindings for that parent node are terminal.
3. Create tally safety net (§4.2.2) if needed for in-flight create races.
4. Extension continues to call ready join after returns and on restore re-entry.
5. Keep explicit `expectedBindingCount` for advanced and test policies.

**Acceptance:**

1. Three children created while parent is waiting (or equivalent multi-wait setup); after two returns, join has not applied; after third return, join applies once.
2. Two-child concurrent-style wait still joins after both terminal.
3. Sequential create-return-create that leaves an active sibling never joins early.
4. Auto path still has no author produce requirement (J1 holds).
5. Child failure policy interaction: non-completed return that fails or blocks the parent quiet-skips synthesis; completed siblings alone do not re-open a blocked parent through join.

**Primary test files:**

- `tests/s6-synthesis-fan-in.test.ts` (replace or extend the “second of three applies early” honesty test into a **does not apply early** product test)
- `tests/ordinary-join-n-child-wait.test.ts` (new focused suite for wait-set and N=3)

**Domain touch points (expected):**

- `src/domain/child-goal-creation.ts` (allow waiting parent for sibling create)
- `src/domain/child-goal-return.ts` and/or projection for multi-active wait clear
- `src/domain/child-outcome-synthesis.ts` only if family collection needs wait-set helpers
- `src/pi/family-product-synthesis.ts` eligibility and auto policy
- `src/extension.ts` only if create-child or return commit must pass new wait rules

**Suggested commit theme:** ordinary join safe N-child wait set

### 5.3 Slice J3 — Ordinary surface: skill, ledger, end-to-end host proof

**Goal:** A normal multi-child family is reachable without fixtures or engineer-only steps. Docs and skill match the code.

**Scope:**

1. Update `skills/hypagraph/SKILL.md`:
   - multi-child fan-out while parent waits;
   - auto join after all children terminal;
   - no need to declare `join.passed` or `expectedBindingCount` for the ordinary path;
   - pass leaves parent running; fail blocks unless failure policy already owns the parent;
   - one-child remains separate (no silent auto join of a single child under the multi minimum).
2. Update `docs/capability-ledger.md` Aggregate / synthesis row:
   - Ordinary → **Yes** when J1–J2 acceptance holds;
   - Live stays **No**;
   - notes state Ordinary multi-child all-success join without author produce or hand `expectedBindingCount`; Live dogfood still open.
3. Host-level test that drives create → multi return → join without produce and without expected count (product helpers or extension-level substitute).
4. Confirm Gate 2.2 exit language: plan owner consumes synthesis; graph transitions on result (fact publish / block). Gate 2.3 Live remains open.

**Acceptance:**

1. Skill audit checklist: multi-child join section present; no instruction to hand-set `expectedBindingCount` for the ordinary path; no instruction that produce `join.passed` is mandatory for ordinary join.
2. Ledger Ordinary=Yes, Live=No for Aggregate / synthesis.
3. Automated e2e-style host test green for 2-child pass and 3-child no-early-join.
4. No Live claim and no dogfood evidence requirement for this program.

**Primary test files:**

- `tests/ordinary-join-product-path.test.ts` (new host product path suite)
- skill review (manual checklist in commit or short note in this plan §8)

**Suggested commit theme:** ordinary join skill and ledger Ordinary=Yes

### 5.4 Dependency order

```text
J1 default fact (no author produce)
  → J2 safe N-child wait set (no hand expectedBindingCount)
    → J3 skill + ledger Ordinary=Yes + product e2e tests
```

Do not mark Ordinary=Yes before J1 and J2 are green.

## 6. Non-goals

This program must **not** include:

1. **Live Pi dogfood** for synthesis or concurrent family (Gate 1.3, Gate 2.3). Keep Live=No without Pi evidence.
2. **Full quorum, ranked, or model synthesis strategies.** Strategy remains all-success only.
3. **Gauntlet** or blind multi-critic panel productization.
4. **Second recipe catalog entry** or full Gate 3 recipe productization. One recipe may consume Ordinary join later; it is not in this slice map.
5. **Derived fan-out regions** redesign (M8.1 already exists as domain).
6. **Aggregate node kind** as a new graph node type in the authoring surface.
7. **Auto-complete parent task or parent goal** on join pass.
8. **Release cut**, version bump, push, or public marketing claim of multi-agent Live.
9. **Absolute domain purity** enforcement (project decision already closed).
10. **One-child ordinary auto join** unless a later change explicitly redefines AUTO_JOIN_MIN (see risks).

## 7. Risks

### 7.1 Double-apply

| Risk | Mitigation |
| --- | --- |
| Join runs after return and again on restore re-entry | Keep `joinResultFactAlreadyApplied` and skip when fact is on the current attempt |
| Concurrent controller passes append duplicate events | Apply under the same host lock used for free-slot / family bag updates; append only when new events exist |
| Failed join blocks twice | Block only while parent is running; quiet-skip when not running |

### 7.2 Child failure policy interaction

| Risk | Mitigation |
| --- | --- |
| Failure policy fails or blocks parent before synthesis | Synthesis must not re-apply; quiet skip; no warning spam (already host behaviour) |
| Failure policy is return-for-revision while join would block | Keep ownership rule: when parent is not running after return handling, failure policy owns the effect |
| Mixed outcomes: one child failed (policy block), siblings still active | **Decision for J2:** failure policy runs on the first non-completed return. Remaining active sibling bindings for that parent node are terminalised (cancelled in the family) without resuming the parent. Synthesis quiet-skips when the parent is not running. Document the matrix in J2 tests. |

### 7.3 One-child families

| Risk | Mitigation |
| --- | --- |
| AUTO_JOIN_MIN = 2 leaves one-child without auto join | Intentional for this program. Flagship recipe stays root + one child with integration nodes, not auto multi join |
| Authors expect one child to set `join.passed` | Skill states one-child does not auto-join under multi minimum; use explicit policy only if needed later |
| Accidental auto join on second unrelated child later | Join set is scoped by parent node id; unrelated nodes do not share the set |

### 7.4 Restore re-entry

| Risk | Mitigation |
| --- | --- |
| Returns committed, join not applied, session reloads | Extension already runs ready join when applied returns are zero; keep that path |
| Join applied, reload re-notifies | Notify only when parent mutated or fact newly published |
| Family bag stale vs live root sequence | Keep existing merge rules that avoid clobbering wait state |

### 7.5 Sequential create after full join

| Risk | Mitigation |
| --- | --- |
| Wave-1 join applies; author creates more children on the same attempt | Fact already applied → skip further join for that attempt. Skill teaches one fan-out wave then integrate. Optional later: new attempt or revise for a second wave |
| Model creates children one full cycle at a time (create → return → create) | Multi-wait alone does not help if each child fully returns before the next create. Skill must teach create siblings while waiting. J2 tests cover the ordinary fan-out shape. Sequential single-child cycles remain one-child integration, not multi join |

### 7.6 Host-only fact and gates

| Risk | Mitigation |
| --- | --- |
| Downstream gate requires declared produce | Author who needs a gate must declare `join.passed` (supported). Ordinary path still gets the runtime fact for status and notify |
| Validation rejects undeclared publish | Apply through the same command path used today; confirm validation allows host publish of default join fact or use an approved host seam |

### 7.7 Create-child while waiting_for_child

| Risk | Mitigation |
| --- | --- |
| Bounds (max children, depth, attempts) bypass | Keep existing family bounds checks on every create |
| Same-node unsettled worker guard | Keep create-child rejection when an unsettled isolated worker owns the parent node |
| Status and UI show wrong wait count | Status and graph must show multiple active child bindings under one waiting parent (J2/J3) |

## 8. Verification

### 8.1 Commands (after implementation slices)

1. `npm run typecheck` exits 0.
2. Focused vitest for S6 and ordinary join files exits 0.
3. Existing family create/return and concurrent host suites still pass.

### 8.2 Skill checklist (J3)

1. Multi-child fan-out while `waiting_for_child` is documented.
2. Auto join after all children terminal is documented.
3. No mandatory author `join.passed` produce for ordinary multi-child join.
4. No mandatory hand `expectedBindingCount` for ordinary multi-child join.
5. Pass and fail parent effects are documented.
6. Live dogfood is not claimed.

### 8.3 Ledger checklist (J3)

1. Aggregate / synthesis: Ordinary=Yes only after J1 and J2 acceptance.
2. Live remains No without case ID and evidence path.
3. Notes match shipped behaviour and limits (all-success only; no quorum library).

## 9. Relationship to Gate 2 and Gate 3

| Gate item | This program |
| --- | --- |
| 2.1 Domain synthesis | Already shipped (S6). J2 may extend wait-set domain rules. |
| 2.2 Host path ordinary product | **In scope** (J1–J3). Exit: Ordinary=Yes. |
| 2.3 Live acceptance | **Out of scope.** Live stays No. |
| 3.1 One ordinary recipe | **Out of scope.** May depend on this plan later. |
| 3.2–3.3 Catalog growth | **Out of scope.** |

## 10. Implementation notes for later agents

1. Read this plan and the files listed in the header before code changes.
2. Prefer small commits: J1, then J2, then J3.
3. Do not broaden into quorum strategies, Gauntlet, or Live dogfood.
4. Preserve quiet re-entry and child failure policy ownership.
5. Use ASD-STE100 for all new repository prose (skill, ledger notes, tests names, comments).
6. Product name remains Hypagraph only.
7. Do not cut a release. Do not push unless the user asks.

## 11. Summary

| Topic | Decision |
| --- | --- |
| Gap | Produce required; N>2 early join; skill silence |
| Ordinary done | 2+ children join without author produce or hand expectedBindingCount; parent continues or fails |
| Result fact | Host-only default `join.passed` on auto path |
| Planned size | Multi-child wait set (+ create tally safety net) |
| Parent transition | Pass: fact true, parent running; Fail: fact false + block when still running; quiet-skip if failure policy owns parent |
| Slices | J1 fact → J2 wait set → J3 skill and ledger |
| Live | Not required; keep Live=No |
