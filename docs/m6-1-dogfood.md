# M6.1 dogfood evidence

- Date: 2026-07-28
- Milestone: M6.1 interaction and approval nodes
- Release marker: v0.8
- Prerequisite: M6A deterministic dispatch, M6B event history
- Plan: `docs/m6-1-interaction-node-plan.md`
- Live Pi model: `xai-auth/grok-4.5`
- Live extension: `./extensions/hypagraph.ts`
- Live evidence: `docs/dogfood-evidence/m6-1-live/`
- Live driver: `docs/dogfood-evidence/m6-1-live/driver.mjs`
- Automated product-path test: `tests/m6-1-dogfood.test.ts`
- Suite after this slice: 116 test files and 690 tests

## 1. Purpose

M6.1 lets a workflow ask the user a typed question and continue other work
while that question waits.

This dogfood has two layers:

1. a live Pi RPC path with plan approval and an independent loop;
2. an automated product-path test for regression.

The live session is the product proof. The automated test keeps the path stable
under CI.

## 2. Live Pi path: plan approval and independent loop

### Objective

Create a Hypagoal with two independent components and no edge between them.

1. Component A is a closed interaction that asks the user to approve writing
   `plan-approved.txt` with the exact text `m6-1-approved`, then writes and
   verifies that file.
2. Component B is an independent bounded loop that fails a command check once,
   then writes `loop-marker` and passes.

### Result

| Measurement | Value |
| --- | --- |
| Final phase | completed |
| Final goal status | completed |
| Sequence | 65 |
| Scheduled actions | 7 |
| Nodes | `approve-plan`, `write-plan`, `verify-plan`, `loop-work`, `loop-check` all succeeded |
| Facts | `plan.approved` true, `plan.verified` true, `loop.passed` true |
| Interaction events | requested, presented, answered |
| User select | `approve - Approve` |
| Workspace | `plan-approved.txt` = `m6-1-approved`; `loop-marker` = `m6-1-marker` |

### Proof that the loop continued while the question waited

The interaction request was stored early in the run. Before the interaction was
answered, the independent loop ran:

1. `loop-work` started and passed verification;
2. `loop-check` failed once and the loop continued;
3. a second iteration passed and the loop completed;
4. only then did the interaction present and answer.

Canonical event order is in `docs/dogfood-evidence/m6-1-live/canonical.json`.

### Product surfaces inspected

- `/hypagoal status` after completion;
- `/hypagraph history`;
- `/hypagraph history interaction` (three interaction events);
- `/hypagraph explain`.

### Live driver notes

Pi ran in RPC mode with the local extension:

```text
pi --mode rpc --model xai-auth/grok-4.5 --thinking off \
  --session-dir <session> --name m6-1-live-dogfood --approve \
  -e ./extensions/hypagraph.ts
```

The driver is `docs/dogfood-evidence/m6-1-live/driver.mjs`. The first authoring
attempt in an earlier session failed on loop feedback-edge validation. The
successful run used a stricter objective that required a valid SCC loop and a
feedback edge that matches a `requires` edge.

## 3. Automated product path

`tests/m6-1-dogfood.test.ts` recreates the independent interaction and loop
shape in the extension harness. It checks that:

1. an independent loop can complete while an interaction awaits a response;
2. a typed approve answer publishes `plan.approved`;
3. a waiting surface reports the open question before the answer.

## 4. Acceptance against the plan

| Plan requirement | Live result |
| --- | --- |
| Plan approval interaction | Yes. User selected approve through the host select path. |
| Independent loop while waiting | Yes. Loop iterations and checks ran after request and before answer. |
| Typed answer controls next work | Yes. `plan.approved` then `write-plan` and `verify-plan`. |
| Evidence recorded | Yes. `docs/m6-1-dogfood.md` and `docs/dogfood-evidence/m6-1-live/`. |

## 5. Known live observations

- Orphaned model-lane continuations were closed and recovered during the run.
  That recovery path already exists from M6B live dogfood.
- The host used the non-TUI select path for the closed question. The first
  option text was `approve - Approve`.
