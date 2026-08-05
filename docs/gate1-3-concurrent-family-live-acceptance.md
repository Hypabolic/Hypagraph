# Gate 1.3 — Concurrent family live acceptance

- Case ID: `CASE-G1-3-CONCURRENT-FAMILY`
- Date: 2026-08-05
- Gate: Gate 1.3 (live multi-child concurrent family)
- Status: **automated substitute passed; live Pi dogfood not run**
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

Prove multi-child concurrent family dispatch under the ordinary product path after S4 worker pool capacity.

**Definition — two-id concurrent batch notify:** a host notify (or equivalent surface) that names at least two member goal ids in one concurrent dispatch batch. That notify alone is not a Live pass.

The case must show:

1. a multi-member family with at least two concurrent-eligible members (prefer two sibling children under one root);
2. product selection that returns a concurrent dispatch batch with two model members when policy allows;
3. host commit of multiple pendings (Seam C);
4. two live model workers under policy in a real Pi session;
5. multi-pending occupancy of two while both workers are unsettled;
6. a mid-flight window where the operator can observe two workers in flight;
7. independent settle of each of those two pendings without clobber of the sibling;
8. after settle, status is not false-idle (`lastOutcome` honesty is enough).

Live is not earned by a two-id concurrent batch notify alone.

Live is not earned by an automated substitute alone.

## 2. Honesty statement

| Layer | Result for this slice |
| --- | --- |
| Domain | Proven earlier (Gate 1.1) |
| Host | Proven by S4 worker pool path and automated substitute (batch path + pool) |
| Ordinary | Still **Partial** (create-child UX, R4, density) |
| Live | Still **No** |

This environment did not run a real interactive Pi TUI session for this case.

No artifacts under `docs/dogfood-evidence/gate1-3-live/` record a live pass.

Ledger **Live** requires a real Pi session dogfood with recorded artifacts and this case ID against §5.1. The automated host and product substitute is the CI gate. That substitute does not earn **Live**.

See `docs/capability-ledger.md` row **Concurrent multi-pending family selection**.

## 3. Preconditions (live operator run)

1. Node.js 22 or later.
2. Package built and linked for local extension use.
3. Pi CLI available with a model that can run the local extension.
4. Local extension path: `./extensions/hypagraph.ts` (or the package extension entry in use).
5. Clean workspace or a dedicated dogfood directory under `docs/dogfood-evidence/gate1-3-live/`.
6. Operator can create a multi-member family with two concurrent-eligible sibling children.
7. Product concurrency policy allows capacity of at least two (`globalConcurrency` default 2).

## 4. Operator steps (live Pi)

When a live TUI or RPC Pi session is available, run:

1. Confirm executor status is healthy (`/hypagraph executor status`).
2. Create a root Hypagoal that can own children.
3. Run the root so the parent task is active.
4. Create two sibling child members with independent model work (isolated workers preferred).
5. Let the family controller select work with concurrent product policy enabled (default: concurrent on, `maxBatchSize` 2, `globalConcurrency` 2).
6. Observe the host concurrent batch notify (or equivalent). It must name at least two member goal ids in one concurrent batch.
7. Observe two model starts in that pass. Do not treat a single model start as a pass.
8. While both workers remain unsettled, observe multi-pending occupancy of two (status multi-pending x2, worker occupancy, or equivalent).
9. Confirm a mid-flight window where two workers are in flight at the same time.
10. Confirm each pending settles independently. One completion must not clear or clobber the sibling pending.
11. After both settle, run status. Confirm status is not false idle. `lastOutcome` honesty is enough when pendings are zero.
12. Record evidence under `docs/dogfood-evidence/gate1-3-live/` (see §6).

Record pass or fail against §5.1 after the live run. Do not use §5.2 alone for Live.

## 5. Pass criteria

### 5.1 Operator-observable Live checks

Use these checks for a real Pi run. Record artifacts for each observed check.

| Check | Must observe |
| --- | --- |
| Multi-pending batch | Product path selects and commits at least two concurrent-eligible model members in one batch when capacity allows |
| Concurrent selection notify | Host surfaces a concurrent batch notify (or equivalent) that names at least two member goal ids |
| Two model workers | Two live model workers start under policy in a real Pi session. One model start is not enough. Host-level proof belongs in §5.2 and does not satisfy this check |
| Multi-pending occupancy of two | Status or equivalent shows multi-pending occupancy of two while both remain unsettled |
| Mid-flight window | Operator can observe two workers in flight at the same time |
| Independent settle | Each of the two pendings settles without clobber of the sibling |
| Post-settle status honesty | After both settle, status is not false idle; `lastOutcome` honesty is enough |

Live pass needs §5.1 plus artifacts under §6.

Live pass for a pure model batch requires two concurrent model workers under S4 pool capacity. Pre-S4 one-seat language is not the product bar.

### 5.2 Automated substitute checks (CI only)

These checks prove product selection, Seam C host helpers, pool helpers, free-slot protocol behaviour (via S4 helpers), and source-level tripwires on `src/extension.ts`. They do not earn ledger **Live**.

Source greps assert identifiers and shape only. They do not prove runtime batch behaviour alone. Behavioural proof of free-slot concurrent await is in `tests/s4-worker-pool-concurrent-fanout.test.ts` and is reused here through `traceConcurrentIsolatedFreeSlotProtocol`.

| Check | Must prove in CI |
| --- | --- |
| Family shape | Root plus two sibling children; root not concurrent-ready so the batch is multi-child |
| Product selection | `selectFamilyProductControllerAction` returns `dispatch-batch` with two child model items when capacity allows |
| Host Seam C commit | `commitConcurrentFamilyBatchForHost` commits two pendings |
| Mark before settle | `markFamilyPendingDispatchedForHost` marks each startable with `memberState` before settle |
| Extension source tripwires | `src/extension.ts` still contains `Promise.all(modelWork)`, resolved global concurrency capacity, and no historical `modelSlots = 1` one-seat partition string |
| Free-seat admit double | Test-local free-seat arithmetic (documented double of host filter) admits two model members under empty pool and `globalConcurrency` 2, using real `isDeterministicFamilyMemberDecision` |
| Worker pool map occupancy | Host worker pool Map admits two concurrent entries under `globalConcurrency` 2 |
| Multi-pending occupancy of two | Projection and status report multi-pending count honesty while two pendings exist |
| Mid-flight free-slot protocol | `traceConcurrentIsolatedFreeSlotProtocol` proves two concurrent awaits with free slots unbound during await (real protocol helper; not Map-only) |
| Independent family settle | `settleFamilyPendingForHost` settles one pending and leaves the sibling |
| Interrupted independent settle | `settleFamilyPendingForHost` with outcome `interrupted` clears one pending and leaves the sibling; this is not pre-S4 one-seat capacity defer |
| Global concurrency binding | Three concurrent-eligible members with `globalConcurrency` 2 admit two; a free third member cannot admit while occupancy is full |

Related suite: `tests/s4-worker-pool-concurrent-fanout.test.ts`.

### 5.3 Host behaviour after S4

1. Host model pool capacity is N under resolved `globalConcurrency` (default 2).
2. The extension batch path starts admitted model members concurrently and settles each pending on that worker completion.
3. The host does not use `modelSlots = 1` as the product bar.
4. Free-slot protocol for isolated workers binds free slots only for start/register and settle. Process await does not hold free slots.
5. Concurrent settle merges member stream and pending under one lock so sibling bags are not clobbered.
6. Historical pre-S4 limits (one model worker per pass; deferred interrupt for one seat) are not the product bar.

Public claims must show these facts. These facts do not earn ledger Live. Live needs §5.1 artifacts.

## 6. Evidence location

Live artifacts belong in:

```text
docs/dogfood-evidence/gate1-3-live/
```

See `docs/dogfood-evidence/gate1-3-live/README.md` for the capture list.

This directory is a stub until a real Pi run records files. Do not mark ledger **Live** until those artifacts exist and an operator records a pass for `CASE-G1-3-CONCURRENT-FAMILY` against §5.1.

## 7. Automated substitute (CI)

### Purpose

Prove the multi-pending product path at host, pool, free-slot protocol, and extension source-tripwire level without a real Pi TUI.

### Test files

- `tests/gate1-3-concurrent-family-live-acceptance.test.ts` (Gate 1.3 substitute)
- `tests/s4-worker-pool-concurrent-fanout.test.ts` (S4 pool and concurrent fan-out regressions)

### Command

```bash
npx vitest run tests/gate1-3-concurrent-family-live-acceptance.test.ts tests/s4-worker-pool-concurrent-fanout.test.ts
```

Related regression suite:

```bash
npx vitest run \
  tests/gate1-1-multi-pending-family.test.ts \
  tests/gate1-2-concurrency-policy-surface.test.ts \
  tests/gate1-3-concurrent-family-live-acceptance.test.ts \
  tests/s4-worker-pool-concurrent-fanout.test.ts
```

### What the substitute covers

1. Root with two sibling children; root paused so two children are concurrent-eligible.
2. `selectFamilyProductControllerAction` returns `dispatch-batch` with two child model items under concurrent policy.
3. `commitConcurrentFamilyBatchForHost` commits two pendings.
4. `markFamilyPendingDispatchedForHost` marks each startable with `memberState` before settle.
5. Free-seat admit double with real `isDeterministicFamilyMemberDecision`.
6. Worker pool Map occupancy of two under capacity.
7. Free-slot protocol mid-flight concurrent awaits via `traceConcurrentIsolatedFreeSlotProtocol`.
8. Independent settle of each pending without clobber of the sibling (family helper).
9. Interrupted independent settle (not one-seat capacity defer).
10. Status and projection multi-pending count honesty while pendings exist.
11. Three concurrent-eligible members with `globalConcurrency` 2 make the global limit binding.
12. Extension source tripwires for S4 batch shape.

### What the substitute does not cover

1. Real Pi process spawn.
2. Real isolated-pi worker sessions under interactive TUI.
3. Interactive TUI docks and operator UX.
4. Live operator evidence for Gate 1.3 (§5.1).
5. Ledger **Live** acceptance.
6. Runtime proof that `Promise.all(modelWork)` always receives two model entries (source tripwire only).

Automated substitute does not earn Live.

## 8. Related documents

- Capability ledger: `docs/capability-ledger.md`
- Concurrency policy surface: `docs/concurrency-policy-surface.md`
- Family product dogfood honesty pattern: `docs/scratch/family-product-dogfood.md`
- Gate 1.1 tests: `tests/gate1-1-multi-pending-family.test.ts`
- Gate 1.2 tests: `tests/gate1-2-concurrency-policy-surface.test.ts`
- S4 worker pool tests: `tests/s4-worker-pool-concurrent-fanout.test.ts`
- Next steps: `docs/scratch/adversarial-review-2026-08-04/09-NEXT-STEPS.md`
