# Goal-family product surface plan

- Status: partial (F0–F5 product path wired; dual review found ship blockers — see remediation plan)
- Purpose: enable the full Hypagraph / Hypagoal vision on the ordinary Pi product path — a goal family as a graph of graphs, not only domain helpers and one-member roots
- Remediation program: `docs/goal-family-product-remediation-plan.md` (R1–R6 trust fixes + layer model)
- Baseline: Hypagraph package 0.14; M7–M8 domain and tests largely shipped; ordinary model path remains root one-member family plus same-graph revision
- Related architecture: `docs/goal-family-and-concurrent-execution-plan.md`, `docs/delegation-and-visualisation.md`, `docs/product-spec.md`
- Related product shell: `docs/product-surface-orchestration-plan.md`, `docs/isolated-model-session-execution-plan.md`, `docs/authoring-tools-and-project-store-plan.md`
- Roadmap source: `docs/execution-roadmap.md` (M7 objective and acceptance)
- Skill consumer: `skills/hypagraph/SKILL.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Program goal

Deliver a complete **family product path** so a user and a model can:

1. define a root goal contract and root graph;
2. choose **Run** on the post-create dock;
3. from an active parent **task**, create a **child Hypagoal** with its own workflow, budget, scope, and return contract;
4. keep unrelated root components runnable while the parent task waits for the child;
5. run child model tasks in isolated workers by default;
6. validate child return into the parent and continue parent integration without auto-completing the parent task;
7. inspect multi-member family state in status and the graph pane;
8. follow skill guidance that matches the live tools.

The architecture name for this composition is a **goal family**. Informally it is a hypergraph of Hypagoals: each Hypagoal owns one Hypagraph; the family holds the edges between goals.

This program is the **product shell** around existing M7/M8 domain. It must not re-implement pure child-creation or child-return reducers that already pass unit tests.

## 2. Goal contract for this program

Use this contract when a Hypagoal or implementer runs this plan.

### 2.1 Outcome

An interactive Pi session can create a root Hypagoal, spawn at least one child Hypagoal from an active parent task through the model tool surface, run child work under the family controller, return validated child outputs to the parent, and complete root integration with durable family state across reload.

### 2.2 Acceptance

All of the following must be true:

| ID | Criterion |
| --- | --- |
| A1 | Model tools include an explicit child-create path (name may be `hypagoal_create_child` or equivalent). The tool commits family membership and parent `waiting_for_child` through the existing family persistence helpers. |
| A2 | Child create is allowed only from an **active parent task** attempt. Checks and gates cannot create children. Scope cannot widen beyond the parent grant. Depth and child-count bounds apply. |
| A3 | After child create, the family has at least two members. The parent task is `waiting_for_child`. Unrelated ready root components remain eligible for the family scheduler. |
| A4 | The live extension controller selects and dispatches work across family members (not only the single root `HypagraphState` path used for one-member roots). |
| A5 | Child model tasks default to `isolated-pi` workers with the same settlement contract as root isolated tasks. |
| A6 | Child terminal success returns through declared output facts and evidence. The parent task leaves wait and becomes runnable for integration. Child success does **not** complete the parent task. |
| A7 | Child failure, budget limit, and cancel apply the declared failure policy (`fail-parent-node`, `block-parent-node`, or `return-for-revision`) on the product path. |
| A8 | `/hypagraph status` (and family status blocks) report members, active bindings, child-wait parent nodes, and family budget usage. |
| A9 | Graph pane can focus the root or a child member and show nested family chrome without requiring a test harness. |
| A10 | Session reload and branch change pause or recover family work without losing membership, bindings, or durable wait state. Workers for in-flight members abort and settle as for root workers. |
| A11 | `skills/hypagraph/SKILL.md` documents the live child-create tool, the goal-contract → encode → run path, and removes the “child not on tool surface” limitation when A1 ships. |
| A12 | Focused automated tests cover A1–A7 and A10 at extension or persistence level. A documented dogfood script covers A1–A9 live (live pass may remain pending; script and automated bar still required). |

### 2.3 Non-goals for this program

1. M8.1 derived fan-out regions — **already shipped** (`src/domain/derived-fan-out.ts`, `tests/m8.1-s1-derived-fan-out.test.ts`). Do not re-implement or expand fan-out in this program.
2. Detached execution that outlives the root goal.
3. Global rename of all `hypagoal_*` tools to `hypagraph_*`.
4. Full automatic revision on workers (S6.5) unless required for child path correctness.
5. New interaction, gate, code, or effect **constructors** (free-form remains valid for those node kinds).
6. Replacing the pure domain child-creation or child-return modules with a different model.
7. Release cut, version bump, or CHANGELOG publish (separate request).
8. Live TUI screenshots as a merge gate (dogfood script is enough; live pass may stay pending).

### 2.4 Verification for this program

1. `npm run typecheck` exits 0.
2. Focused vitest suites for family tools, extension child create/return, and family controller dispatch exit 0.
3. Existing pure domain suites for M7-s4, M7-s5, M7-s3, and M8-s9 still pass.
4. Dogfood script in this document §12 runs or is marked live-pending with automated substitutes listed.
5. Skill audit checklist in §11 passes.

## 3. Problem statement

### 3.1 What the domain already provides

These modules and tests exist and must be **reused**, not rewritten:

| Capability | Primary locations | Tests |
| --- | --- | --- |
| Family runtime and events | `src/domain/goal-family.ts` | `tests/goal-family-*.test.ts` |
| Family scheduler | `src/domain/family-scheduler.ts` | `tests/m7-s3-family-scheduler.test.ts` |
| Concurrent family selection | `src/domain/family-concurrent-dispatch.ts` | `tests/m8-s9-*.test.ts` |
| Bounded child create (pure) | `src/domain/child-goal-creation.ts` | `tests/m7-s4-bounded-child-goal-creation.test.ts` |
| Child return and failure policy | `src/domain/child-goal-return.ts` | `tests/m7-s5-child-return-failure-policy.test.ts` |
| Binding and scope checks | `src/domain/child-goal-binding.ts` | covered by M7-s4/s5 |
| Persisted family + child commit | `src/persistence/family-session.ts`, `family-store.ts` | family persistence tests |
| Nested graph UI fixtures | `src/graph/family-projection.ts`, pane | `tests/m7-s9-nested-graph-executor-ui.test.ts` |

`createBoundedChildGoalInFamily` documents that **Pi tool surface wiring waits for a later slice**. Controllers and tests already use the API.

### 3.2 What the ordinary product path does today

1. `hypagoal_start` creates one root workflow and goal.
2. Restore migrates a root into a **one-member** family when needed.
3. Root model tasks use isolated workers by default.
4. Mid-run plan change uses `hypagraph_revise` on the **same** root graph.
5. Registered model tools do **not** include child create (see `src/extension.ts` tool registration).
6. Extension dispatch is oriented around the live root `state` and one root isolated attempt bookkeeping path.

### 3.3 Gap

The **engine** can represent a graph of graphs. The **model and user surface** still behave as one graph of nodes. The skill must teach that honesty until this plan ships A1–A4.

## 4. Product decisions

### 4.1 One workflow per Hypagoal

Each Hypagoal owns exactly one `HypagraphDefinition` and workflow aggregate.

Do not embed a complete child definition inside a parent node body as nested graph JSON for execution.

Child definition is a separate workflow record bound by family membership and a parent-task binding.

### 4.2 Child create authority

Only:

1. an active parent **task** node;
2. with an open attempt in a state that domain rules allow;
3. while the parent goal is active and the parent workflow is running;
4. within family depth, child-count, scope, and budget bounds;

may create a child.

The model must not create a child by free-form mutation of family records outside the tool.

### 4.3 Encoding default

| Situation | Default encoding |
| --- | --- |
| Subgoal shares ownership, budget, and workspace | Same-graph nodes |
| Independent lifecycle inside one root | Disconnected components in the same root graph |
| Separate ownership, budget, scope, or return contract | Child Hypagoal |
| Work discovered mid-run and a child is not justified | `hypagraph_revise` on the same root |

Prefer same-graph. Use child Hypagoals when the subgoal needs true separation.

### 4.4 Scheduler authority

Only the family controller may select and dispatch work for the family.

Workers, child workflows, loops, and model tools must not enqueue autonomous family work outside that controller.

### 4.5 Completion rules

1. Child terminal success does not complete the parent task.
2. Parent integration and verification remain explicit parent-graph work.
3. Root goal completion remains workflow-derived for the root member.
4. Budget exhaustion on a child is not success.

### 4.6 Orchestrator versus worker

Unchanged product rule:

1. Main Pi session is the orchestrator.
2. Default model **node** attempts use isolated workers.
3. A child Hypagoal is more canonical work, not a subagent identity.
4. A worker still executes one selected node attempt for one member workflow.

### 4.7 Tool naming

Prefer these names on the model surface:

| Tool | Role |
| --- | --- |
| `hypagoal_create_child` | Create a bounded child from an active parent task |
| `hypagoal_start` | Root create only |
| `hypagraph_revise` | Same-root graph revision |
| `hypagraph_read` | Inspect root and family views |
| `hypagraph_draft_*` / constructors | Author definitions for root or child |

If a command is needed: `/hypagraph family status` (or fold into `/hypagraph status`).

Do not teach `hypagraph_define`.

### 4.8 Headless versus TUI

| Host | Child create | First root Run gate |
| --- | --- | --- |
| Interactive TUI | Allowed after root Run (parent task active) | Post-create dock unchanged |
| Headless / RPC | Allowed when parent task is active | Auto-continue after create remains host policy |

Child create does not replace the post-create Run gate for the root.

## 5. Target shape

### 5.1 Ordinary path (after this program)

```text
User intent
  → goal contract (outcome, acceptance, non-goals, verification)
  → encode subgoals (node | component | child | later revision)
  → author root definition
  → hypagoal_start
  → post-create dock: Run | Question | Cancel
  → family controller selects root work
  → active parent task may call hypagoal_create_child
  → child workflow runs under family controller
  → child return validates into parent binding
  → parent integrate / check / complete path
```

### 5.2 Minimal flagship graph family

Root objective: ship a small product slice that needs one delegated subsystem.

Root workflow (illustrative):

1. `plan` — task (optional)
2. `delegate-auth` — task that will create the child
3. `integrate` — task, requires `delegate-auth`
4. `release-check` — check, requires `integrate`

Child workflow (illustrative):

1. `implement-auth` — task
2. `auth-tests` — check, requires `implement-auth`

Binding:

- parent node: `delegate-auth`
- output facts: e.g. `auth.ready` boolean
- failure policy: `block-parent-node` or `return-for-revision`
- scope: narrower than or equal to parent

## 6. Baseline inventory

### 6.1 Treat as done (do not re-implement)

Confirm before Wave F0 closes. If missing on the branch, restore from main or implement as a Wave F0 fix only.

| ID | Capability |
| --- | --- |
| B1 | Pure `createBoundedChildGoal` |
| B2 | Pure child return and failure policies |
| B3 | Family scheduler and concurrent selection helpers |
| B4 | One-member family migration on restore |
| B5 | Family session append / restore helpers |
| B6 | `createBoundedChildGoalInFamily` persistence helper |
| B7 | Root isolated model dispatch and abort/timeout |
| B8 | Post-create Run / Question / Cancel dock |
| B9 | Skill wayfinder + goal-contract + hypergraph prose (honest about tool gap) |

### 6.2 Known product gaps (this program)

| ID | Gap |
| --- | --- |
| G1 | No model tool for child create |
| G2 | Extension controller does not family-dispatch multi-member work as the default loop |
| G3 | Child return not applied on live extension path after child workflow terminal |
| G4 | Status may show thin family chrome without create/return narrative |
| G5 | Graph focus for child members not guaranteed on product path |
| G6 | Project-store write for child committed definitions not on create-child path |
| G7 | Skill still says child may be unavailable on the tool surface |
| G8 | No extension-level dogfood test for root → child → return → integrate |

### 6.3 Explicitly out of inventory fix scope

| ID | Item |
| --- | --- |
| X1 | M8.1 derived fan-out (already shipped; not a product-surface gap for this program) |
| X2 | ACP as default executor |
| X3 | Interaction constructor tool |

## 7. Orchestrator rules (for Hypagoal / implement skill)

1. Execute **one wave at a time** unless a wave marks **parallel-safe**.
2. Prefer **wiring and host integration** over new domain algorithms.
3. Reuse pure domain functions. Add pure helpers only when the host would otherwise branch on policy.
4. Keep the domain reducer pure (no filesystem, network, or clock inside reduce).
5. Every new persisted record must include a schema version. Prefer existing family schema versions.
6. All graph definitions must validate before execution or child create.
7. Use the name Hypagraph. Do not add old product-name aliases.
8. Write ASD-STE100 prose for docs, skill, UI strings, errors, and test names.
9. After each wave: focused tests green; update this document status board; do not claim live dogfood without running the script or marking it pending.
10. Do not expand into non-goals in §2.3.

## 8. Dependency graph (waves)

```text
F0 inventory and seams
  → F1 hypagoal_create_child tool + persistence
  → F2 family-aware controller dispatch
  → F3 child return + parent integrate on product path
  → F4 status, graph focus, project-store child artifacts
  → F5 skill + dogfood script + automated extension path
  → F6 grandchild bounds + family budget visibility (optional hardening)
```

F4 can start pure UI status work in parallel with F3 only after F1 lands enough family state to display. Prefer F3 before F4 for a coherent demo.

## 9. Waves

### Wave F0 — Inventory and extension seams

**Goal.** Prove the baseline and mark host entry points for family multi-member work.

**Work**

1. Confirm B1–B9 in the working tree.
2. Document in a short inventory note (scratch or this board) where root dispatch, restore, and status attach.
3. List exact functions to call for child create commit (`createBoundedChildGoalInFamily` or current equivalent).
4. Confirm no production path already registers a child-create tool under another name.

**Done when**

- Inventory note exists under `docs/scratch/` or updates §6.
- No design changes beyond seam notes.
- Check: typecheck + existing M7-s4/s5 suites pass.

**Out of scope:** new tools.

---

### Wave F1 — Child create tool and host commit

**Goal.** The model can create a real child Hypagoal on the product path.

**Work**

1. Register `hypagoal_create_child` (name fixed in implementation; keep Hypagoal naming rules).
2. Parameters must include at least:
   - parent node id;
   - child objective;
   - child definition **or** `draftId`;
   - binding: output facts, optional input facts, scope paths, optional budget, failure policy;
   - optional explicit ids only when tests require determinism (prefer host-generated UUIDs in product).
3. Execute path:
   - ensure parent root/family is loaded;
   - ensure parent task is active with a valid attempt;
   - call persistence-backed create (`createBoundedChildGoalInFamily` or successor);
   - update extension live `state` for the parent workflow from the commit result;
   - refresh family projection and UI;
   - return a clear tool result (child goal id, workflow id, binding id, parent wait status).
4. Block create while post-create gate still awaits Run (no child before root Run).
5. Block create under authoring-only turns without an active parent attempt.
6. Write project-store artifacts for the child definition when store is available; notify on store failure (same honesty as root create).
7. Extension tests: successful create; reject non-task parent; reject before Run; reject scope widen; two-member family after success.

**Done when**

- A1 and A2 hold under automated extension tests.
- G1 closed.
- Focused tests pass.

**Out of scope:** full multi-member auto-dispatch of child tasks (Wave F2).

---

### Wave F2 — Family-aware controller dispatch

**Goal.** After children exist, the live controller selects and dispatches work for the correct family member.

**Work**

1. Replace or extend the root-only continuation loop so selection uses the family scheduler view of runnable work across members.
2. When the selected action belongs to a child workflow, load that workflow snapshot, dispatch deterministic or isolated-model paths with correct identity (familyId, goalId, workflowId, nodeId, attemptId).
3. Keep root isolated-attempt abort bookkeeping multi-safe (do not assume a single global root attempt only if multiple members can run — start with sequential family dispatch if concurrent multi-member is harder; sequential is acceptable for F2).
4. Ensure independent root components remain selectable while a parent task is `waiting_for_child` (domain already intends this; product path must not pause the whole root).
5. Extension or integration tests: after child create, child ready task starts without a fake test-only controller.

**Done when**

- A3, A4, A5 hold under automated tests (A5 may reuse existing isolated dispatch for the member workflow).
- G2 closed for sequential multi-member dispatch.

**Out of scope:** full M8 concurrent multi-pending family dispatch on product path if sequential family selection already unblocks the vision (record as follow-up).

---

### Wave F3 — Child return and parent integration on product path

**Goal.** Child terminal outcomes return into the parent binding and unblock integration.

**Work**

1. When a child goal reaches a terminal workflow-derived state, run the product return path (domain `child-goal-return` helpers + family commit).
2. On success: parent task leaves `waiting_for_child` and is ready for integration work declared in the root graph.
3. On failure / budget / cancel: apply declared failure policy; surface a clear notify message.
4. Do not mark the parent task complete solely because the child completed.
5. Tests: success return; fail-parent-node; block-parent-node; return-for-revision where domain supports it.

**Done when**

- A6 and A7 hold under automated tests.
- G3 closed.

---

### Wave F4 — Status, graph focus, artifacts

**Goal.** Users and models can see the family.

**Work**

1. `/hypagraph status` extras:
   - family id;
   - member list (goal id, workflow id, status);
   - active bindings (parent node, child goal, binding status);
   - child-wait callouts;
   - family budget consumed when available.
2. Graph pane: focus member; show nested chrome consistent with M7-s9 product wiring.
3. Confirm child project-store artifact path is visible in status (written / not written) analogous to root.
4. Tests for status strings and focus where UI is mockable.

**Done when**

- A8 and A9 hold (A9 automated where possible; otherwise extension mock + dogfood script).
- G4–G6 closed.

---

### Wave F5 — Skill, dogfood script, honesty flip

**Goal.** Skill and documentation match the live path.

**Work**

1. Update `skills/hypagraph/SKILL.md`:
   - tool name and parameters for child create;
   - when to choose child vs same-graph vs revise;
   - parent wait and return rules;
   - remove “child not on tool surface” once F1 is shipped;
   - flagship family recipe (root + one child) as free-form or draft examples.
2. Update README Current status family bullets if they still under-claim or over-claim.
3. Add `docs/scratch/family-product-e2e-path.md` (or §12 of this plan expanded) with exact dogfood steps.
4. Extension-level automated path test that drives create root → (simulate Run / headless) → start parent task → create child → settle child → return → parent ready for integrate (use fakes for workers as in Wave 6 isolation tests).
5. Skill guidance audit with excerpts to scratch.

**Done when**

- A11 and A12 hold.
- G7 and G8 closed.

---

### Wave F6 — Grandchild and budget hardening (optional if time)

**Goal.** Nested child and visible family budget bounds on the product path.

**Work**

1. Product path creates a grandchild within domain depth limits; reject beyond max depth with clear diagnostics.
2. Status shows descendant budget consumption against root family budget.
3. Tests for depth rejection and one successful grandchild.

**Done when**

- Nested create works under automated tests.
- Or wave cancelled with reason if F1–F5 already meet program acceptance without nested create (A1–A12 do not strictly require grandchild if depth bounds exist in domain and product rejects invalid depth).

## 10. Implementation notes

### 10.1 Prefer these call chains

**Child create (host)**

1. Resolve live family record for the branch.
2. Resolve parent goal id and parent workflow state.
3. Build `CreateBoundedChildGoalInFamilyInput` (or current API).
4. Commit; replace host family + parent `state` + events.
5. `paintUi` with family projection.

**Dispatch (host)**

1. Build family runnable view from family + member workflows.
2. Select next action with family scheduler policy.
3. Route deterministic vs isolated-model using existing adapters.
4. Settle into the **member** workflow stream; update family if required.

**Return (host)**

1. Detect child terminal condition after member settlement or goal status derivation.
2. Call pure return helper with binding.
3. Commit parent + family; notify; queue next family selection if appropriate.

### 10.2 Mutating tool policy

While a child is active:

1. Orchestrator must not implement the child’s task body.
2. Extend shared mutating-tool policy if the orchestrator must not revise away an active child binding unsafely.
3. Child create itself is a mutating family operation; allow it only when parent task ownership rules say so.

### 10.3 Schema and persistence

1. Prefer existing family schema versions.
2. If a new host-only flag is required, keep it out of the pure reducer unless product requires durability.
3. Child workflow events stay on the child aggregate; family events record membership and bindings.

### 10.4 Error messages

Use short active-voice diagnostics. Examples:

- “Only an active task can create a child Hypagoal.”
- “Child create is blocked until the user chooses Run after create.”
- “Child scope cannot widen beyond the parent scope.”
- “The child completed. Integrate returned facts on the parent task.”

## 11. Skill and authoring checklist (Wave F5)

After tools ship, the skill must include:

1. Goal contract before graph.
2. Encoding table: node / component / child / revise.
3. `hypagoal_create_child` when available.
4. Parent `waiting_for_child` behaviour.
5. Return does not complete parent.
6. Isolated workers for child tasks.
7. Status inspection for family members.
8. Flagship free-form root + child recipe.

Audit file: `docs/scratch/skill-guidance-audit-family.md` with excerpts.

## 12. Dogfood script (live or automated substitute)

### 12.1 Automated substitute (required)

Extension test with fake isolated transport:

1. `hypagoal_start` root definition with `delegate` task then `integrate` task.
2. Headless or Run-equivalent so continuation may start.
3. Start or allow `delegate` active attempt.
4. `hypagoal_create_child` with child definition that publishes required output facts.
5. Assert parent `waiting_for_child` and two family members.
6. Drive child task to submitted/verified terminal through fake worker.
7. Assert return applied and `integrate` becomes ready (or parent task leaves wait per domain).
8. Assert parent task not completed solely by child success.

### 12.2 Live interactive script (pending allowed)

1. Arm and create root with the flagship family-ready graph.
2. Post-create: inspect Mermaid; choose **Run**.
3. When `delegate` is active, model calls `hypagoal_create_child`.
4. `/hypagraph status` shows two members and child-wait.
5. Child worker runs; no implement follow-up in orchestrator for child body.
6. Child completes; status shows return; parent integrate proceeds.
7. Reload mid child-wait once; confirm membership and wait survive restore policy.

Record results under `docs/scratch/family-product-dogfood.md`.

## 13. Status board

| Wave | Status | Notes |
| --- | --- | --- |
| F0 Inventory and seams | complete | `docs/scratch/family-product-f0-inventory.md` |
| F1 Child create tool | complete | Closes G1; `hypagoal_create_child` + F1 tests |
| F2 Family controller dispatch | complete | Closes G2; sequential multi-member dispatch |
| F3 Child return + integrate | complete | Closes G3; product `returnChildGoalInFamily` path |
| F4 Status / graph / artifacts | complete | Closes G4–G6; status + graph member focus |
| F5 Skill + dogfood automation | complete | Closes G7–G8; A11–A12 automated; live dogfood pending |
| F6 Grandchild / budget harden | pending | Optional |

Update this table when a wave closes. Set top-of-doc Status to partial or complete when A1–A12 hold.

## 14. Risks and open decisions

| Risk | Mitigation |
| --- | --- |
| Multi-member concurrent dispatch is large | F2 ships sequential family selection first |
| Live root `state` variable is single-workflow | Host map of member states or re-load from family record each dispatch |
| Model creates too many children | Skill default same-graph; domain depth/count bounds; clear tool errors |
| Revise conflicts with active child | Reject or carefully define revise rules when bindings are active (document in F3/F5) |
| Store failure on child create | Same as root: create/family commit remains authority; notify on store failure |
| Naming split hypagoal vs hypagraph | Keep create-child under `hypagoal_*`; control under `/hypagraph` |
| Isolated-pi fails on first wave task; model burns the one automatic revision by changing `goal` text | Skill hard rules: never change objective on revision; set per-node `executorProfile` only if current-session is intentional; fix worker or cancel/recreate with user consent. See §14.1. |

### 14.1 Incident: objective-changing revision after isolated-pi failure

Observed on a live F0–F5 dogfood root (workflow `1ca347ab-6867-4d95-897a-50234550a143`):

1. Graph was six implement/verify loops (`f0-loop` … `f5-loop`). First task `f0-inventory` used default `isolated-pi`.
2. Isolated worker failed (`The isolated Pi executor reported failure.`).
3. Controller selected automatic revision (allowance **1**).
4. Model proposed a revision that rewrote the objective to “route implement tasks through current-session.”
5. Domain rejected with `automatic_revision_objective_changed` (goal must match byte-for-byte).
6. Rejection **consumed** the only automatic revision attempt.
7. Goal blocked: `revision-exhausted` / stop `automatic_revision_objective_changed`.

Prevention for implementers of this plan:

1. Before Run, ensure isolated Pi can spawn (`/hypagraph executor status`, `PI_BIN` if needed).
2. For pure inventory/meta waves, either keep isolated-pi and make the worker succeed, or set **node-level** `executorProfile.kind: "current-session"` at **create** time (not by rewriting `goal`).
3. On automatic revision: copy `definition.goal` exactly; never put routing strategy in the goal string.
4. After revision exhausted: `/hypagraph cancel` and a new root only with user consent; do not invent more automatic attempts.
5. Use `/hypagraph status`, not `/hypagraph show`.

### Open decisions (resolve in F1 design notes if needed)

1. Exact tool name: `hypagoal_create_child` vs `hypagraph_create_child` — **recommended:** `hypagoal_create_child`.
2. Whether child create requires an explicit user confirmation row when depth > 0 — **recommended:** no extra dock; status notify is enough for first slice.
3. Whether headless auto-starts child work immediately after create-child — **recommended:** yes, under family controller, same as headless root continue policy.

## 15. Relationship to other plans

| Plan | Relationship |
| --- | --- |
| `docs/goal-family-and-concurrent-execution-plan.md` | Architecture authority for domain rules; this plan is product surface execution |
| `docs/execution-roadmap.md` M7 | M7 domain acceptance largely met; this plan completes product path acceptance |
| `docs/product-surface-orchestration-plan.md` | Start-to-run shell for one root; this plan extends that shell to multi-member families |
| `docs/isolated-model-session-execution-plan.md` | Worker isolation remains default for member model tasks |
| `docs/authoring-tools-and-project-store-plan.md` | Drafts may supply child definitions via `draftId` |
| `docs/goal-family-product-remediation-plan.md` | R1–R6: create-child authority, e2e return bar, member cancel/delivery, family persist merge, dogfood, layer model |
| `skills/hypagraph/SKILL.md` | Consumer of F5 and R1 skill honesty |

## 16. Hypagoal-oriented summary (for automatic authoring)

**Objective.** Enable the full goal-family product path: model-visible child create, family-aware dispatch, child return into parent integration, multi-member status, and skill guidance that matches live tools.

**Smallest correct delivery.** Waves F1–F3 with automated tests. F4–F5 required for user-visible completion. F6 optional.

**Do not build.** New pure child-create algorithms, renames, or release packaging. Do not re-implement M8.1 fan-out (already shipped).

**Prefer.** Wire `createBoundedChildGoalInFamily` and child-return helpers into `src/extension.ts` tools and the continuation loop; reuse isolated worker dispatch per member; update skill last when tools are real.

**Success signal.** Automated root → child → return → parent integrate path passes; skill no longer claims child create is unavailable; status shows more than one family member after create-child.
