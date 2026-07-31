# Family product live dogfood (R6)

- Date: 2026-07-31
- Status: **automated gate passed; live TUI pass deferred**
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Environment

- Host: developer workstation (macOS)
- Live interactive TUI: not run in this remediation turn
- Reason: no interactive PI_BIN / full TUI session attached to the automated implementer harness
- Code gate for return and multi-member path: `tests/family-product-f5-e2e-extension.test.ts` (R2 strict return)

## 2. Automated substitute (passed)

Commands:

```bash
npx vitest run tests/family-product-f1-create-child-extension.test.ts \
  tests/family-product-f2-dispatch-extension.test.ts \
  tests/family-product-f3-child-return-extension.test.ts \
  tests/family-product-f4-status-surface.test.ts \
  tests/family-product-f5-e2e-extension.test.ts \
  tests/family-product-r-waves.test.ts
npm run typecheck
```

Observed:

1. Option A create-child authority tests pass (current-session parent allowed; isolated worker block names current-session).
2. F5 requires `binding.status === "returned"` and non-auto-succeeded parent.
3. R3 member goalId/workflowId on isolated attempts; cancel path attributes worker member.
4. R4 bans current-session on non-root members with clear diagnostic and skill text.
5. R5 live-root merge keeps sibling root progress when child stream updates.

## 3. Live script (required attempt — deferred)

When a live TUI session is available, run:

1. Executor status OK (`/hypagraph executor status`).
2. Create root: `delegate` (current-session) + `integrate`.
3. Run on post-create dock.
4. On active delegate, `hypagoal_create_child` with isolated child implement task + required output facts.
5. Status: two members, active binding, child-wait; **Worker** line names member goal id + node + attempt.
6. Child worker runs; main chat does not implement child body.
7. After child complete: binding returned; delegate running for integrate; not auto-succeeded.
8. Finish integrate; observe root terminal rules.
9. Optional: reload mid wait; confirm no ghost child attempt.

Record pass/fail here on the next live run.

## 4. Status attribution (R6 minimum)

Shipped in this remediation:

- `/hypagraph status` worker line: `Worker: member '<goalId>' node '…' attempt '…'`
- Multi-member status adds family desk line
- Child-wait lines already name parent node and child goal
- `/hypagraph executor status` uses the same Worker member attribution

Live label polish beyond this minimum is deferred until a live TUI pass.

## 5. Product vocabulary

- Family desk — main control path
- Goal plan owner — each Hypagoal owns one graph
- Worker — one node attempt (never creates children)
