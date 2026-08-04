# Gate 1.3 live evidence directory

- Case ID: `CASE-G1-3-CONCURRENT-FAMILY`
- Status: **empty — live Pi dogfood not recorded**
- Acceptance doc: `docs/gate1-3-concurrent-family-live-acceptance.md`

## Purpose

Store artifacts from a real multi-child concurrent family run under Pi.

Do not mark the capability ledger **Live** for concurrent multi-pending family selection until this directory holds a recorded pass for the case ID above against operator-observable Live checks (§5.1 of the acceptance doc).

## Capture list (after a live run)

Record at least:

| File | Content |
| --- | --- |
| `summary.json` | Final phase, member goal ids, pass or fail against §5.1 |
| `operator-notes.md` | Operator steps taken, model id, extension path, pass or fail against §5.1 Live checks |
| `notify-snippets.txt` | Concurrent batch notify that names at least two member goal ids; model start notify for exactly one model in that pass |
| `status-snippets.txt` | After the pass: deferred not left pending (no stranded multi-pending); status not false idle; `lastOutcome` honesty if pendings are already zero |

Do **not** require:

- multi-pending count x2 status lines for a pure model batch;
- a deferred-interrupt notify or message;
- post-pass “startable remains pending” or mid-flight single-pending status (isolated await can settle the startable inside the pass).

Optional: session export or event history if the operator wants helper-level proof of interrupt settle. That is not required for Live.

## Expected pure-model observation

For two concurrent-eligible model children, expect:

1. concurrent batch notify that names two member goal ids;
2. exactly one model start notify (or equivalent) in that pass;
3. after the pass, deferred member is not left pending; occupancy is not stranded multi-pending;
4. after the pass (and after settle if it finished inside the pass), status is not false idle (`lastOutcome` honesty is enough).

Do not require:

- two simultaneous live model workers;
- `/hypagraph status` multi-pending count while two pure-model pendings remain;
- operator observation that family state settled the deferred pending as interrupted;
- mid-flight status while a startable pending remains after the pass returns.

Optional mixed path (deterministic + model): the operator can also capture simultaneous multi-pending status and dual startable settle.

## Current state

No live artifacts are present. The automated substitute for CI is:

```bash
npx vitest run tests/gate1-3-concurrent-family-live-acceptance.test.ts
```

That test does not earn ledger **Live**. Multi-pending status count, mid-flight single-pending status, and deferred settle as interrupted in family state are proven in the substitute, not as pure-model Live UI must-observes.
