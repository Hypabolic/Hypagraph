# Gate 1.3 live evidence directory

- Case ID: `CASE-G1-3-CONCURRENT-FAMILY`
- Status: **empty — live Pi dogfood not recorded**
- Acceptance doc: `docs/gate1-3-concurrent-family-live-acceptance.md`

## Purpose

Store artifacts from a real multi-child concurrent family run under Pi.

Do not mark the capability ledger **Live** for concurrent multi-pending family selection until this directory holds a recorded pass for the case ID above against operator-observable Live checks (§5.1 of the acceptance doc).

The Live bar after S4 requires two concurrent model workers in a real Pi session. It also requires multi-pending occupancy of two, a mid-flight window, and independent settle of both.

A two-id concurrent batch notify alone is not enough. See the definition in `docs/gate1-3-concurrent-family-live-acceptance.md` §1.

## Capture list (after a live run)

Record at least:

| File | Content |
| --- | --- |
| `summary.json` | Final phase, member goal ids, case ID, pass or fail against §5.1 |
| `operator-notes.md` | Operator steps taken, model id, extension path, pass or fail against §5.1 Live checks |
| `notify-snippets.txt` | Concurrent batch notify that names at least two member goal ids; model start evidence for two concurrent model workers in that pass |
| `status-snippets.txt` | Multi-pending occupancy of two while both are unsettled; mid-flight window notes; post-settle status honesty (`lastOutcome` if pendings are zero) |

Optional: session export or event history if the operator wants helper-level proof of independent settle.

## Expected pure-model observation (raised Live bar)

For two concurrent-eligible model children under default `globalConcurrency` 2, expect:

1. concurrent batch notify that names two member goal ids;
2. two model starts in that pass;
3. multi-pending occupancy of two while both remain unsettled;
4. a mid-flight window where two workers are in flight;
5. independent settle of each pending without clobber of the sibling;
6. after both settle, status is not false idle.

Do not treat as a Live pass:

1. a two-id concurrent batch notify with only one model start;
2. pre-S4 host behaviour that starts at most one model worker per pass;
3. automated substitute results alone;
4. host-level CI proof alone (§5.2).

## Current state

No live artifacts are present. The automated substitute for CI is:

```bash
npx vitest run tests/gate1-3-concurrent-family-live-acceptance.test.ts tests/s4-worker-pool-concurrent-fanout.test.ts
```

That test does not earn ledger **Live**. Live remains **No** until real Pi dogfood for `CASE-G1-3-CONCURRENT-FAMILY` is recorded here against §5.1.
