# Gate 1.3 — Concurrent family live acceptance

- Case ID: `CASE-G1-3-CONCURRENT-FAMILY`
- Date: 2026-08-04
- Gate: Gate 1.3 (live multi-child concurrent family)
- Status: **automated substitute passed; live Pi dogfood not run**
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

Prove multi-child concurrent family dispatch under the ordinary product path.

The case must show:

1. a multi-member family with at least two concurrent-eligible members (prefer two sibling children under one root);
2. product selection that returns a concurrent dispatch batch when policy allows;
3. host commit of multiple pendings (Seam C);
4. operator-visible batch selection of two member ids (notify or equivalent);
5. honest handling of host model capacity (exactly one model start in that pass);
6. after the pass, no stranded multi-pending occupancy (deferred member not left pending);
7. after settle, status is not false-idle (`lastOutcome` honesty is enough).

On the default isolated model path, the host awaits the startable worker and can settle the startable pending before the controller pass returns. The operator may see zero family pendings after the pass. Mid-flight “startable remains pending” status is not a pure-model Live must-observe. That window is a §5.2 substitute check. See §5.1 and §5.3.

Simultaneous multi-pending **status count** is not a pure-model Live requirement. It is a §5.2 substitute check, or an optional mixed-path Live observation.

Silent deferred settle as interrupted in family state is not a pure-model Live must-observe. That settle is a §5.2 substitute check.

Independent settle of two **simultaneous live model workers** is not a Live requirement for a pure model batch. The current host does not start two model workers in one pass.

## 2. Honesty statement

| Layer | Result for this slice |
| --- | --- |
| Domain | Proven earlier (Gate 1.1) |
| Host | Proven earlier and by automated substitute (Seam C helpers) |
| Ordinary | Still **Partial** (Option A create-child, R4, UX awkwardness) |
| Live | Still **No** |

This environment did not run a real interactive Pi TUI session for this case.

Ledger **Live** requires a real Pi session dogfood (or an equivalent live acceptance run) with recorded artifacts and this case ID. The automated host and product substitute is the CI gate. That substitute does **not** earn **Live** by itself.

See `docs/capability-ledger.md` row **Concurrent multi-pending family selection**.

## 3. Preconditions (live operator run)

1. Node.js 22 or later.
2. Package built and linked for local extension use.
3. Pi CLI available with a model that can run the local extension.
4. Local extension path: `./extensions/hypagraph.ts` (or the package extension entry in use).
5. Clean workspace or a dedicated dogfood directory under `docs/dogfood-evidence/gate1-3-live/`.
6. Operator can create a multi-member family with two concurrent-eligible sibling children (Option A current-session parent for create-child).

## 4. Operator steps (live Pi)

When a live TUI or RPC Pi session is available, run:

1. Confirm executor status is healthy (`/hypagraph executor status`).
2. Create a root Hypagoal that can own children (current-session parent for Option A create-child).
3. Run the root so the parent task is active.
4. Create **two sibling child** members with independent model work (isolated workers preferred).
5. Let the family controller select work with concurrent product policy enabled (default: concurrent on, `maxBatchSize` 2, global concurrency 2).
6. Observe the host batch notify (or equivalent). It must name at least two member goal ids in one concurrent batch.
7. Do **not** require `/hypagraph status` to show multi-pending count x2 for a pure model batch.
8. Observe host model capacity: exactly one model start notify (or equivalent start signal) for that pass.
9. Do **not** require a deferred-interrupt notify. The host can settle deferred models without a user-visible interrupt message.
10. After the pass returns, run status. Confirm occupancy is not stranded multi-pending for the deferred member (deferred not left pending). Confirm status is not false idle. On the default isolated path, the startable may already be settled inside the pass; `lastOutcome` honesty is enough. Do not require a mid-flight single-pending window.
11. Record evidence under `docs/dogfood-evidence/gate1-3-live/` (see §6).

Optional mixed batch (not required for pure-model Live if §5.1 is met):

- If the family has a deterministic action and a model action ready together, the host can start both in one pass.
- Then the operator can observe simultaneous multi-pending status and independent settle of those two live startable items.

Record pass or fail against §5.1 after the live run. Do not use §5.2 alone for Live.

## 5. Pass criteria

### 5.1 Operator-observable Live checks

Use these checks for a real Pi run. Record artifacts for each observed check.

| Check | Must observe |
| --- | --- |
| Multi-pending batch | Product path selects and commits at least two concurrent-eligible members in one batch when capacity allows |
| Concurrent selection notify | Host surfaces a concurrent batch notify (or equivalent) that names at least two member goal ids |
| Model capacity | Exactly one model start notify (or equivalent) in that pass |
| No stranded deferred occupancy | After the pass, the deferred member is not left pending; occupancy is not stranded multi-pending |
| Post-pass status honesty | After the pass (and after settle if settle finished inside the pass), status is not false idle; `lastOutcome` honesty is enough |

Live pass needs §5.1 plus artifacts under §6.

Live pass for a pure model batch does **not** require:

1. two simultaneous live model workers;
2. `/hypagraph status` multi-pending count x2;
3. a deferred-interrupt notify or operator observation that family state settled the deferred pending as interrupted;
4. post-pass “startable remains pending” or mid-flight status while a startable pending remains (isolated await can settle the startable before the pass returns).

Multi-pending status count and mid-flight single-pending status are §5.2 substitute checks. Simultaneous multi-pending status is optional for Live only on the mixed deterministic + model path.

### 5.2 Automated substitute checks (CI only)

These checks prove Seam C host and product helpers. An operator cannot observe them from the TUI alone. They do **not** earn ledger **Live**.

| Check | Must prove in CI |
| --- | --- |
| Family shape | Root plus two sibling children; root not concurrent-ready so the batch is multi-child |
| Product selection | `selectFamilyProductControllerAction` returns `dispatch-batch` with two child model items |
| Host Seam C commit | `commitConcurrentFamilyBatchForHost` commits two pendings |
| Mark before settle | `markFamilyPendingDispatchedForHost` marks each startable with `memberState` before settle |
| Deferred settle as interrupted | `settleFamilyPendingForHost` with outcome `interrupted` clears one pending and leaves an unrelated pending |
| Independent settle (helpers) | `settleFamilyPendingForHost` settles one pending and leaves the other under `independent-settle` |
| Multi-pending status count | Projection and status report multi-pending count honesty (not idle) while two pendings exist (helper timing; not pure-model Live) |
| Mid-flight single-pending status | After one of two pendings settles, status is not false idle while the sibling remains (helper timing; not pure-model Live on isolated await) |
| Global concurrency binding | Three concurrent-eligible members with `globalConcurrency` 2 admit two; a free third member cannot admit while occupancy is full |

### 5.3 Known host limits (not automatic fail criteria)

1. The host starts at most one model worker per pass.
2. The host settles deferred model pendings as interrupted in the same pass when model capacity is full. That settle is silent (no dedicated interrupt notify).
3. Commit, batch notify, partition, and deferred settle run in one synchronous stretch. The operator cannot run status while two pure-model pendings remain.
4. On the default isolated model path, the host awaits the startable worker to completion and settles the startable family pending before the controller pass returns. After the pass the operator can see zero family pendings.
5. The host await is serial on the shared session.
6. Independent settle of two simultaneous **live model workers** is not available on the current host for a pure model batch.

These limits must stay visible in public claims. They do not cancel concurrent batch selection or the capacity signals in §5.1.

## 6. Evidence location

Live artifacts belong in:

```text
docs/dogfood-evidence/gate1-3-live/
```

See `docs/dogfood-evidence/gate1-3-live/README.md` for the capture list.

This directory is a stub until a real Pi run records files. Do not mark ledger **Live** until those artifacts exist and an operator records a pass for `CASE-G1-3-CONCURRENT-FAMILY` against §5.1.

## 7. Automated substitute (CI)

### Purpose

Prove the multi-pending **product** path end to end at host and product-helper level without a real Pi TUI.

### Test file

`tests/gate1-3-concurrent-family-live-acceptance.test.ts`

### Command

```bash
npx vitest run tests/gate1-3-concurrent-family-live-acceptance.test.ts
```

Related regression suite:

```bash
npx vitest run \
  tests/gate1-1-multi-pending-family.test.ts \
  tests/gate1-2-concurrency-policy-surface.test.ts \
  tests/gate1-3-concurrent-family-live-acceptance.test.ts
```

### What the substitute covers

1. Root with two sibling children; root paused so two children are concurrent-eligible.
2. `selectFamilyProductControllerAction` returns `dispatch-batch` with two child items under concurrent policy.
3. `commitConcurrentFamilyBatchForHost` commits two pendings.
4. `markFamilyPendingDispatchedForHost` marks each startable with `memberState` before settle.
5. `settleFamilyPendingForHost` settles each pending independently at the helper layer (including `interrupted`).
6. Status and projection surfaces report multi-pending count honesty (not idle) while pendings exist.
7. Three concurrent-eligible members with `globalConcurrency` 2 make the global limit binding (admit two; block third while occupancy is full).

### What the substitute does not cover

1. Real Pi process spawn.
2. Real isolated-pi worker sessions.
3. Interactive TUI docks and operator UX.
4. Live operator evidence for Gate 1.3 (§5.1).
5. Ledger **Live** acceptance.

Note: deferred settle as interrupted in family state is covered at the helper layer in §5.2 and in the gate1-3 interrupted test case. The host path in `src/extension.ts` applies that settle without a dedicated UI notify.

## 8. Related documents

- Capability ledger: `docs/capability-ledger.md`
- Concurrency policy surface: `docs/concurrency-policy-surface.md`
- Family product dogfood honesty pattern: `docs/scratch/family-product-dogfood.md`
- Gate 1.1 tests: `tests/gate1-1-multi-pending-family.test.ts`
- Gate 1.2 tests: `tests/gate1-2-concurrency-policy-surface.test.ts`
- Next steps: `docs/scratch/adversarial-review-2026-08-04/09-NEXT-STEPS.md`
