# M5B Slice 4 dogfood evidence

- Date: 2026-07-24
- Slice: M5B Slice 4, budgets and reload safety
- Implementation commit: `46473fa21bb66f303aba89931b33001c25f8c934`
- Pull request: #69
- Verification run: CI #871
- Test result: 87 test files and 374 tests passing

## 1. Matrix result

CI #871 passed the complete supported matrix:

- Ubuntu with Node.js 22;
- Ubuntu with Node.js 24;
- macOS with Node.js 22;
- macOS with Node.js 24;
- Windows with Node.js 22;
- Windows with Node.js 24.

Each job installed the locked dependency graph and ran the repository type checks and complete Vitest suite.

## 2. Durable budget state

Slice 4 adds workflow-local Hypagoal budget state with:

- optional maximum substantive turns;
- optional maximum normalized tokens;
- consumed substantive turns;
- consumed input, output, cache-read, cache-write, and total tokens;
- last-accounted turn identity;
- an event-backed budget stop with reason, limit, consumed value, and timestamp;
- a canonical pending continuation identity.

The pending identity binds goal, workflow, revision, selected sequence and snapshot, request sequence, continuation ordinal and operation, selected action, session generation, branch generation, and request time.

## 3. Exactly-once accounting

The domain records a delivered continuation through `hypagraph.goal.turn-recorded`.

Tests prove that:

- one delivered continuation increments the substantive-turn count once;
- normalized token fields are accumulated once;
- cache-read and cache-write tokens participate in the total;
- duplicate turn identity is rejected without double charging;
- stale continuation identity is rejected;
- malformed or inconsistent usage is rejected;
- the pending continuation is retained when accounting is rejected;
- replay and restore reproduce the same consumed values and last-accounted identity.

The Pi boundary uses the explicit `pi-assistant-usage-v1` normalization contract. It does not let the reducer read Pi messages or model metadata directly.

## 4. Deterministic budget stops

Tests cover both hard budget types:

- a substantive-turn limit produces `budget_limited` with `turn_limit`;
- a token limit produces `budget_limited` with `token_limit`;
- the turn limit wins deterministically when both limits are exhausted by the same accounting event;
- the final permitted turn is charged before the stop is evaluated;
- a turn which completes the workflow is still charged;
- workflow completion remains completed and is not replaced by a budget stop;
- budget exhaustion does not complete a ready task or change independent component state.

Budget exhaustion is separate from workflow success, cancellation, loop limits, patience, invalid-evaluation limits, and evaluator budgets.

## 5. Reload and branch safety

The Pi adapter now invalidates pending automatic continuation after a session reload or branch change.

Tests prove that:

- restore does not queue or dispatch semantic work;
- a non-terminal active goal receives an event-backed pause cause for session reload or branch change;
- the canonical pending continuation is cleared by the pause event;
- session and branch generation identity prevent stale delivery;
- explicit `/hypagoal resume` retains consumed budget state;
- resume rechecks the current budget and graph state before another continuation can be requested;
- invalid or missing usage pauses the goal instead of silently continuing with unaccounted work.

## 6. Architecture review

The Slice 4 review checked that the implementation adds none of the following:

- a second workflow model;
- a second task or loop model;
- model-owned goal completion;
- family or child-goal persistence;
- an executor, subagent, or worktree abstraction;
- physical concurrency;
- a hidden adapter-only budget counter;
- restore-time semantic dispatch;
- an implicit success state for budget exhaustion.

The usage and continuation identities remain additive. A later family controller can aggregate child-goal and executor usage without replacing workflow-local event history.

## 7. Result

M5B Slice 4 satisfies its completion criteria:

- token and turn limits produce deterministic replayable stops;
- every permitted continuation turn is accounted exactly once;
- reload and branch changes pause active work without dispatch;
- explicit resume preserves usage and revalidates state;
- the complete six-target matrix passes.
