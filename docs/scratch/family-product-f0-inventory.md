# Goal-family product surface — Wave F0 inventory

- Status: complete for Wave F0
- Date: 2026-07-31
- Source plan: `docs/goal-family-product-surface-plan.md` §6 and §9 Wave F0
- Related architecture: `docs/goal-family-and-concurrent-execution-plan.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

Prove the domain baseline (B1–B9). Mark host entry points for multi-member family work. List exact commit helpers for child create and child return. Confirm that no production tool already registers child create under another name.

This note does not change product design beyond seam documentation.

## 2. Baseline B1–B9

| ID | Capability | Status | Primary locations | Tests |
| --- | --- | --- | --- | --- |
| B1 | Pure `createBoundedChildGoal` | Present | `src/domain/child-goal-creation.ts` (`createBoundedChildGoal`) | `tests/m7-s4-bounded-child-goal-creation.test.ts` |
| B2 | Pure child return and failure policies | Present | `src/domain/child-goal-return.ts` (`returnChildGoal`) | `tests/m7-s5-child-return-failure-policy.test.ts` |
| B3 | Family scheduler and concurrent selection | Present | `src/domain/family-scheduler.ts`, `src/domain/family-concurrent-dispatch.ts` | `tests/m7-s3-family-scheduler.test.ts`, `tests/m8-s9-concurrent-loops-and-child-workflows.test.ts` |
| B4 | One-member family migration on restore | Present | `src/persistence/family-session.ts` (`restoreOrMigrateOneMemberFamilySession`, `migrateRestoredRootToOneMemberFamily`), `src/persistence/family-store.ts` (`migrateRootWorkflowToOneMemberFamily`) | `tests/goal-family-migration.test.ts` |
| B5 | Family session append / restore helpers | Present | `src/persistence/family-session.ts` (`restoreLatestFamilySession`, `appendOneMemberFamilyRecord`, `familyMatchesRoot`) | `tests/goal-family-persistence.test.ts` |
| B6 | `createBoundedChildGoalInFamily` persistence helper | Present | `src/persistence/family-session.ts` (`createBoundedChildGoalInFamily`, `returnChildGoalInFamily`); commit in `src/persistence/family-store.ts` | Covered by M7-s4/s5 and family persistence tests |
| B7 | Root isolated model dispatch and abort/timeout | Present | `src/pi/isolated-root-dispatch.ts`, `src/pi/isolated-pi-executor.ts`, `src/extension.ts` (`dispatchIsolatedRootModelTask`) | `tests/wave6-isolated-root-extension.test.ts`, `tests/m7-s8-isolated-pi-extension.test.ts` |
| B8 | Post-create Run / Question / Cancel dock | Present | `src/pi/post-create-dock.ts`, `src/pi/post-create-gate-policy.ts`, `src/extension.ts` (`presentPostCreateDockIfNeeded`, `postCreateAwaitingUserChoice`) | product-surface and extension tests |
| B9 | Skill wayfinder + goal-contract + hypergraph prose | Present with honest tool gap | `skills/hypagraph/SKILL.md` (goal contract, encoding table, child shape; states child create may be unavailable on tool surface) | skill audit docs under `docs/scratch/` |

No baseline gap requires a new pure domain algorithm in this program.

## 3. Child create and return call chain (host must reuse)

### 3.1 Child create commit

1. Load live family: `restoreLatestFamilySession(branch)` or `restoreOrMigrateOneMemberFamilySession(branch)`.
2. Ensure parent goal id and parent workflow state from the family record.
3. Build `CreateBoundedChildGoalInFamilyInput`:
   - `family: PersistedGoalFamily`
   - `parentGoalId: string`
   - plus pure fields from `CreateBoundedChildGoalInput` except `family` and `parentState`:
     - `parentNodeId`, `childDefinition`, `childGoalId`, `childWorkflowId`, `bindingId`, `at`, `scopePaths`
     - optional: `budget`, `failurePolicy`, `inputFacts`, `outputFacts`, correlation/causation/event ids
4. Call `createBoundedChildGoalInFamily(input)` in `src/persistence/family-session.ts`.
5. Internally that function:
   - loads parent workflow from the family record;
   - calls pure `createBoundedChildGoal` in `src/domain/child-goal-creation.ts`;
   - commits with `commitBoundedChildGoalToPersistedFamily` in `src/persistence/family-store.ts`.
6. Host must replace live family + parent `state` + events from the commit result, append the family record to the session, then `paintUi` with family projection.

### 3.2 Child return commit

1. Detect child terminal condition after member settlement or goal status derivation.
2. Call `returnChildGoalInFamily` in `src/persistence/family-session.ts` with `family`, `parentGoalId`, and pure return fields.
3. Internally that function calls pure `returnChildGoal` and `commitChildReturnToPersistedFamily`.
4. Host updates parent state, family record, notifies, and queues next family selection when appropriate.

### 3.3 Comment already on product helpers

`createBoundedChildGoalInFamily` and `returnChildGoalInFamily` document that **Pi tool surface wiring waits for a later slice**. Controllers and tests already use the APIs. Wave F1 and F3 close that gap.

## 4. Extension seams (host entry points)

| Seam | Role | Location (approx.) |
| --- | --- | --- |
| Tool registration | Model tools; **no** child-create tool today | `src/extension.ts` `pi.registerTool` block (`hypagoal_start` ~2479, `hypagraph_revise` ~3685, drafts, lifecycle tools) |
| Live root state | Single-workflow `state` variable for the active root | `src/extension.ts` extension closure |
| Family restore / one-member migrate | On session restore and before isolated dispatch | `restore` (~726), `restoreOrMigrateOneMemberFamilySession`, `appendOneMemberFamilyRecord` |
| Family projection for UI | Optional chrome when live goal is a family member | `resolveFamilyView` (~657), `projectProductFamilyView` (`src/ui/family-product.ts`), `projectFamilyGraphView` (`src/graph/family-projection.ts`) |
| Status bar / widget | Root + thin family chrome | `updateUi` / `paintUi` (~438, ~674); `appendFamilyStatusBlock` (`src/ui/family-surface.ts`) |
| Post-create gate | Blocks auto-continue until Run | `postCreateAwaitingUserChoice` (~505), `queueGoalContinuation` early return (~1918), `presentPostCreateDockIfNeeded` (~1578) |
| Continuation loop | **Root-only** selection today | `queueGoalContinuation` (~1916): `selectGoalContinuation(state)` from `src/domain/goal-continuation.js` — **not** `selectFamilySchedulerAction` |
| Isolated model dispatch | Root member path with family snapshot for context | `dispatchIsolatedRootModelTask` (~1671), `routeRootModelLaneAction` (`src/pi/isolated-root-dispatch.ts`) |
| Isolated attempt bookkeeping | Single `activeIsolatedRootAttempt` in host memory | extension closure (~514); F2 must make multi-member safe (sequential OK first) |
| Family scheduler (domain, unused as product default loop) | Multi-member selection helpers | `selectFamilySchedulerAction`, `enumerateFamilyRunnableCandidates`, `commitFamilySelection` in `src/domain/family-scheduler.ts` |
| Concurrent family batch (domain) | M8 concurrent selection | `selectFamilyConcurrentActions` / `selectFamilyConcurrentBatch` — out of F2 minimum (sequential first) |

### 4.1 Gap mapping (plan G1–G8)

| Gap | Confirmed | Seam to wire |
| --- | --- | --- |
| G1 No model tool for child create | Yes — registered tools listed below; no `hypagoal_create_child` | New `pi.registerTool` + host commit using `createBoundedChildGoalInFamily` |
| G2 Extension controller not family-dispatch | Yes — `queueGoalContinuation` uses `selectGoalContinuation(state)` only | Replace/extend selection with family scheduler view; dispatch into member workflow |
| G3 Child return not on live path | Yes — `returnChildGoalInFamily` not called from extension product loop | After child terminal, call return helper and refresh parent |
| G4 Thin family status | Partial — `appendFamilyStatusBlock` / widget exist; create/return narrative incomplete | Status extras in F4 |
| G5 Graph focus for child members | Partial — `projectFamilyGraphView`, pane family update exist; product path not guaranteed | F4 graph focus |
| G6 Project-store child definition write | Not on create-child path (path does not exist yet) | F1 store write + F4 visibility |
| G7 Skill says child may be unavailable | Yes — `skills/hypagraph/SKILL.md` product honesty paragraph | F5 flip after F1 ships |
| G8 No extension dogfood root→child→return | Yes — no extension e2e for that path | F5 automated test |

### 4.2 Registered model tools (no child create)

- `hypagoal_start`
- `hypagraph_validate`
- `hypagraph_draft_begin` / `status` / `validate` / `discard`
- `hypagraph_add_task` / `add_check` / `require` / `loop` / `recipe_implement_verify_loop`
- `hypagraph_read` / `run_check` / `cancel_check` / `transition` / `ask`
- `hypagoal_submit_revision`
- `hypagraph_revise`

No production registration of `hypagoal_create_child`, `hypagraph_create_child`, or equivalent.

`createChildProcess*` names in the tree are isolated worker transports, not child Hypagoal create.

## 5. Product gaps vs domain (summary)

The engine can represent a graph of graphs. The ordinary product path still:

1. creates one root via `hypagoal_start`;
2. migrates restore to a one-member family when needed;
3. dispatches with root-only `selectGoalContinuation`;
4. runs root model tasks as isolated workers by default;
5. revises the same root graph with `hypagraph_revise`;
6. does not expose child create on the model tool surface.

Waves F1–F5 close G1–G8 without re-implementing pure child-create or child-return reducers.

## 6. Recommended host call targets for later waves

| Wave | Prefer these functions |
| --- | --- |
| F1 | `createBoundedChildGoalInFamily` → `commitBoundedChildGoalToPersistedFamily` (via session helper); block on `postCreateAwaitingUserChoice`; require active task attempt |
| F2 | `selectFamilySchedulerAction` / `enumerateFamilyPreferredDispatchables` + existing `dispatchIsolatedRootModelTask` generalized to member identity; keep sequential if concurrent is large |
| F3 | `returnChildGoalInFamily` → `commitChildReturnToPersistedFamily`; never auto-complete parent task on child success |
| F4 | `appendFamilyStatusBlock`, `projectFamilyGraphView`, `projectProductFamilyView`, graph pane member focus |
| F5 | `skills/hypagraph/SKILL.md`, dogfood under `docs/scratch/`, extension test patterned on `tests/wave6-isolated-root-extension.test.ts` |

## 7. Out of scope for F0

- New tools
- Multi-member auto-dispatch
- Child return on product path
- Skill honesty flip
- M8.1 fan-out changes
- F6 grandchild hardening

## 8. Verification for F0 close

1. This inventory note exists under `docs/scratch/`.
2. B1–B9 confirmed present in the working tree.
3. No child-create tool under another name on the production registration path.
4. Typecheck and existing M7-s4 / M7-s5 suites remain the F0 verify bar (run in `f0-verify`).

## 9. Next wave

Wave F1: register `hypagoal_create_child` and commit through `createBoundedChildGoalInFamily`.
