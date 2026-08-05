# Concurrency policy surface

- Status: active product contract (Gate 1.2)
- Package baseline: 0.14.0
- Writing standard: ASD-STE100 Simplified Technical English
- Related plan: `docs/goal-family-and-concurrent-execution-plan.md` §7.2

## 1. Purpose and scope

This document defines the product concurrency policy for multi-member goal families.

The product path must enforce:

1. a global concurrency limit;
2. per-executor limits;
3. concurrency groups (exclusive and concurrent);
4. batch size and concurrent mode;
5. partial-failure behaviour for multi-pending work.

Domain helpers for limits and groups already exist. This surface wires those helpers into ordinary product selection, commit, settle, and status text.

This document does not cover live multi-pending concurrent family acceptance under real Pi. That work is Gate 1.3. After S4, the host model worker pool capacity is the resolved product `globalConcurrency` (default 2). The raised Live bar requires two concurrent model workers in a real Pi session. A two-id concurrent batch notify alone is not enough (see Gate 1.3 acceptance §1). Live multi-worker evidence under real Pi remains open.

## 2. Global limit and per-executor limit

### 2.1 Global limit

- Default global concurrency is two attempts (`DEFAULT_GLOBAL_CONCURRENCY = 2`).
- The product policy field is `globalConcurrency`.
- When the global active count is at the limit, selection must not admit more work.

### 2.2 Per-executor limit

- The product policy field is `perExecutorKind`.
- When a kind has no explicit limit, that kind inherits the resolved global limit.
- An executor at capacity must not block a different executor when global capacity remains.
- When the global limit is exhausted, no executor admits new work.

### 2.3 Defaults

| Field | Default |
| --- | --- |
| `globalConcurrency` | 2 |
| `perExecutorKind` | empty map (inherit global) |
| `maxBatchSize` | 2 |
| `concurrent` | true when `maxBatchSize` > 1 |
| `partialFailureMode` | `independent-settle` |

### 2.4 Executor kind attribution

Priority when the product path assigns an executor kind for concurrent occupancy:

1. Explicit `attributesByGoalId[goalId].executorKind` always wins.
2. For model task kinds (`start-ready-task`, `continue-active-task`), resolve the selected node with `resolveModelNodeExecutorProfile` (same rules as product model routing):
   - valid `node.executorProfile.kind` when present (includes `current-session`, `isolated-pi`, `acp`, `cli`);
   - else default `isolated-pi`.
3. Deterministic host paths (`run-ready-check`, `run-ready-code`, `run-ready-effect`, `evaluate-ready-gate`, `request-ready-interaction`, `reconcile-indeterminate-effect`) map to `deterministic`.
4. `request-revision` (orchestrator revision follow-up) maps to `current-session`.
5. Other unknown kinds default to `isolated-pi`.

Residual gaps:

- Host-only route overrides that never appear on the node definition or policy attributes are not derived.
- Invalid `node.executorProfile` shapes are ignored by domain profile resolution (same as model routing).
- Live multi-pending concurrent family acceptance under real Pi remains Gate 1.3. Host capacity after S4 is N under resolved `globalConcurrency` with concurrent model start and settle-on-complete. Raised Live bar is in `docs/gate1-3-concurrent-family-live-acceptance.md` §5.1. Ledger **Live** stays **No** until real Pi dogfood is recorded under `docs/dogfood-evidence/gate1-3-live/`.

## 3. Exclusive and concurrent groups

Concurrency groups constrain which attempts may run together.

- Each group has a `groupId` and a `maxConcurrent` bound.
- `maxConcurrent` 1 means exclusive (mutex) within the group.
- `maxConcurrent` greater than 1 allows multiple members in the group when global capacity allows.
- `maxConcurrent` 0 admits no members of the group.
- Membership is supplied per member goal through `attributesByGoalId[goalId].groupIds`.
- Empty membership does not constrain other attempts through groups.
- Unknown group ids in membership are invalid and reject selection.

Product policy fields:

- `groups`: registry of group definitions;
- `attributesByGoalId`: optional per-member executor kind, group ids, and lease.

## 4. maxBatchSize and concurrent flag

- `maxBatchSize` is the maximum members selected and committed in one batch.
- Default `maxBatchSize` is 2.
- When `maxBatchSize` is present, it must be a positive safe integer. Values less than 1 produce diagnostic `family_product_invalid_max_batch_size` and reject product selection.
- When `concurrent` is false, the product path uses sequential selection.
- When `maxBatchSize` is 1, the product path uses sequential selection.
- Concurrent mode remains on for length-1 batches when another pending already occupies capacity. Sequential commit would block in that case.

## 4.1 Shared policy on select and commit

- The ordinary host path resolves one policy object per controller pass.
- Concurrent `dispatch-batch` decisions carry the resolved policy.
- Host commit prefers `resolvedConcurrencyPolicy` from that decision so select and commit share one resolved object.
- Ordinary path currently uses default policy fields only. Custom group and per-executor maps are enforced when a caller supplies them on the product helpers.

## 5. Partial-failure behaviour

Product mode is `independent-settle` only.

### 5.1 One of N fails

1. The host settles only the failed pending by dispatch id.
2. Other pendings stay running.
3. The family must not auto-fail siblings solely because one member failed.
4. Child-return and binding failure policy still apply when a binding requires it.

### 5.2 Interrupt

1. The host can interrupt one pending or each pending it requests.
2. Remaining pendings stay valid.
3. Capacity frees for the interrupted dispatch after settle.
4. Status must not claim idle while other pendings exist.

### 5.3 Restore with multi-pending

1. After restore, multi-pending state is valid under schema version 3.
2. Unsupported schema versions must reject with a clear error.
3. On session reload and branch change, the host sweeps every family pending (`selected` or `dispatched`) as `interrupted`. This mirrors workflow-level `interruptPendingActionDispatch` so stranded pendings do not consume occupancy forever.
4. Each active isolated attempt may carry `familyDispatchId`. Orphan cancel of that attempt also settles the matching family pending as `interrupted`.
5. Operator reclaim: `/hypagraph reclaim-pending` interrupts all stranded family pendings. `/hypagraph reclaim-pending <dispatchId>...` interrupts only the named ids. Status reports a reclaim hint when pendings exist and no host-tracked model work is active: no unsettled isolated worker, and no `pendingContinuation` or `deliveredContinuation`.
6. The host must not claim idle when pendings exist.
7. Status can report multi-member in-flight state.
8. After a successful restore sweep or reclaim, multi-pending occupancy is free for a new selection.

## 6. Occupancy model

Active occupancy for product concurrent selection includes:

1. every entry in `family.pendingDispatches` with status `selected` or `dispatched`;
2. optional host-supplied concurrency state and group state when present.

Product default:

- `treatPendingAsOccupancy` is true;
- the product path does not require a separate persisted concurrency occupancy store;
- pending dispatches seed limit and group occupancy during selection and commit.

What counts as active:

- a pending with status `selected` or `dispatched` occupies capacity;
- a terminal outcome does not occupy capacity;
- settle of one dispatch frees only that dispatch’s occupancy.

## 7. Product path enforcement points

| Stage | Module | Behaviour |
| --- | --- | --- |
| Resolve policy | `src/pi/family-product-dispatch.ts` | `resolveFamilyProductConcurrencyPolicy` |
| Select | `src/pi/family-product-dispatch.ts` | `selectFamilyProductControllerAction` passes limits, groups, attributes |
| Domain select | `src/domain/family-scheduler.ts` | `selectFamilyConcurrentActions` |
| Domain limits | `src/domain/concurrency-limits.ts` | global and per-executor admit rules |
| Domain groups | `src/domain/concurrency-groups.ts` | group capacity and fairness |
| Commit | `src/pi/family-product-dispatch.ts`, `src/pi/family-controller-host.ts` | same policy fields as selection |
| Settle | `src/pi/family-controller-host.ts` | `settleFamilyPendingForHost` (one dispatch) |
| Restore / reclaim | `src/pi/family-controller-host.ts`, `src/extension.ts` | `interruptAllFamilyPendingsForHost`; restore sweep; `/hypagraph reclaim-pending` |
| Status | `src/ui/family-surface.ts`, `src/graph/family-projection.ts` | multi-pending honesty |

Host controller entry: `src/extension.ts` uses Seam C helpers for batch commit, mark, and settle.

## 8. Failure diagnostics and honest status rules

### 8.1 Diagnostics

- Invalid limits produce concurrency limit diagnostics from the domain resolver.
- Invalid groups produce concurrency group diagnostics from the domain resolver.
- Unsupported partial-failure modes use `family_product_partial_failure_unsupported`.
- Unsupported family schema versions use `unsupported_goal_family_schema`.
- Distinct failure modes must keep distinct diagnostic codes.

### 8.2 Honest status rules

1. Do not report `dispatch idle` when any pending exists.
2. When more than one pending exists, status must show multi-pending count.
3. Full status may list each pending (selected or dispatched).
4. Compact widget lines may use a multi-pending count.
5. First-pending compact fields may remain for single-item surfaces; multi-pending lists are authoritative when present.

## 9. Host worker pool (S4)

After S4 the host no longer uses a single isolated attempt seat.

| Rule | Behaviour |
| --- | --- |
| Pool | `SessionContext.workerPool` is a `Map` of `ActiveIsolatedRootAttempt` |
| Key | `familyDispatchId` when present; else `attemptId` |
| Capacity | Resolved product `globalConcurrency` (default 2) |
| Admit | Start a model worker only when unsettled pool count is less than that limit |
| Batch start | Mark admitted members, start model members concurrently, settle each on completion |
| Partial failure | `independent-settle` only: settle one pending by dispatch id; siblings stay running |
| Status | Report every unsettled worker; do not claim idle while pool or family pendings exist |

Historical host limits (before S4):

1. `modelSlots = 1` partitioned model capacity to one isolated attempt per pass.
2. Deferred model pendings settled as `interrupted` solely for that one seat.
3. Serial await of one model worker before the next start.

Those limits are not the product bar after S4.

Free-slot lifetime after S4 (protocol in `src/pi/isolated-free-slot-protocol.ts`):

1. Bind free slots under the free-slot lock for start-node and pool register only.
2. Release free slots before the long isolated process await.
3. Re-bind under the free-slot lock for settlement only.
4. MemberContext and cancel mirrors are authority during unlocked await.

Deterministic and current-session paths may still bind free slots for their full duration. Only the isolated model worker path uses the short-bind protocol.

Host commit aligns with free isolated seats (S4 Issue 8):

1. Before concurrent commit, the host keeps only free-seat model members plus deterministic members from the selection.
2. The host does not commit model pendings it cannot mark and start in this pass.
3. Uncommitted selected members can be selected again when seats free (controller re-enters after the current pass).
4. Interrupt remains only on mark failure, not on capacity.
5. Domain selection with `treatPendingAsOccupancy` remains the primary capacity gate for pending occupancy.

Family bag writes for concurrent isolated settle (S4 Issues 6–7, 9–10):

1. Member stream replace and family pending settle run under the free-slot lock in one critical section.
2. The bag is reloaded under that lock after settlement awaits.
3. Post-dispatch `persistNonRootMemberUpdate` is skipped when isolated settle already wrote the member (avoids stale batch-start base clobber).
4. Residual member persist (when not skipped) reloads and writes entirely under the free-slot lock.
5. Concurrent model batch defers child return to one controller-level `applyPendingChildReturns` pass after `Promise.all`; each return reloads the bag under the free-slot lock.

## 10. Non-goals

This Gate 1.2 surface document does not close:

1. Gate 1.3 live multi-pending concurrent family acceptance under real Pi (case script and automated substitute: `docs/gate1-3-concurrent-family-live-acceptance.md`; host pool capacity is N under policy after S4; ledger **Live** still **No** until real Pi dogfood);
2. Gate 2 synthesis or aggregate fan-in;
3. persisted separate concurrency occupancy documents beyond family pendings;
4. partial-failure modes other than `independent-settle`;
5. automatic sibling fail-on-first failure as a product default;
6. full removal of free-slot bind for deterministic and current-session nested helpers.

## 11. Related files and tests

### 11.1 Source

- `src/pi/family-product-dispatch.ts`
- `src/pi/family-controller-host.ts` (`interruptAllFamilyPendingsForHost`)
- `src/pi/isolated-root-dispatch.ts` (pool helpers; `ActiveIsolatedRootAttempt.familyDispatchId`)
- `src/pi/isolated-free-slot-protocol.ts` (short free-slot hold protocol for isolated workers)
- `src/pi/session-context.ts` (`workerPool` Map)
- `src/extension.ts` (batch concurrent start; restore sweep; `/hypagraph reclaim-pending`)
- `src/domain/concurrency-limits.ts`
- `src/domain/concurrency-groups.ts`
- `src/domain/family-concurrent-dispatch.ts`
- `src/domain/family-scheduler.ts`
- `src/graph/family-projection.ts`
- `src/ui/family-surface.ts`
- `tests/s2-family-pending-restore-sweep.test.ts`

### 11.2 Tests

- `tests/gate1-2-concurrency-policy-surface.test.ts`
- `tests/gate1-1-multi-pending-family.test.ts`
- `tests/gate1-3-concurrent-family-live-acceptance.test.ts` (Gate 1.3 automated substitute; not Live evidence)
- `tests/s4-worker-pool-concurrent-fanout.test.ts` (S4 pool, free-slot protocol, concurrent fan-out)
- `tests/isolated-root-dispatch.test.ts` (pool helpers)
- `tests/m8-s7-global-and-per-executor-concurrency-limits.test.ts`
- `tests/m8-s8-concurrency-groups-and-fairness.test.ts`

### 11.3 Related docs

- `docs/session-handoff.md`
- `docs/gate1-3-concurrent-family-live-acceptance.md`
- `docs/capability-ledger.md`
- `docs/goal-family-and-concurrent-execution-plan.md`
- `docs/scratch/adversarial-review-2026-08-04/09-NEXT-STEPS.md`
