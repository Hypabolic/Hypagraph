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

This document does not cover live multi-worker Pi acceptance. That work is Gate 1.3.

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
- Live multi-worker acceptance of mixed executor kinds remains Gate 1.3.

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
3. The host must not claim idle when pendings exist.
4. Status can report multi-member in-flight state.

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

## 9. Non-goals

This slice does not include:

1. Gate 1.3 live multi-worker Pi acceptance;
2. Gate 2 synthesis or aggregate fan-in;
3. persisted separate concurrency occupancy documents beyond family pendings;
4. partial-failure modes other than `independent-settle`;
5. automatic sibling fail-on-first failure as a product default.

## 10. Related files and tests

### 10.1 Source

- `src/pi/family-product-dispatch.ts`
- `src/pi/family-controller-host.ts`
- `src/domain/concurrency-limits.ts`
- `src/domain/concurrency-groups.ts`
- `src/domain/family-concurrent-dispatch.ts`
- `src/domain/family-scheduler.ts`
- `src/graph/family-projection.ts`
- `src/ui/family-surface.ts`

### 10.2 Tests

- `tests/gate1-2-concurrency-policy-surface.test.ts`
- `tests/gate1-1-multi-pending-family.test.ts`
- `tests/m8-s7-global-and-per-executor-concurrency-limits.test.ts`
- `tests/m8-s8-concurrency-groups-and-fairness.test.ts`

### 10.3 Related docs

- `docs/session-handoff.md`
- `docs/capability-ledger.md`
- `docs/goal-family-and-concurrent-execution-plan.md`
- `docs/scratch/adversarial-review-2026-08-04/09-NEXT-STEPS.md`
