# Incident: automatic_revision_objective_changed after isolated-pi failure

- Date: 2026-07-31
- Workflow: `1ca347ab-6867-4d95-897a-50234550a143`
- Goal: `goal-42358cf6-7495-491f-ad59-99b8b855ee8f`
- Plan under test: `docs/goal-family-product-surface-plan.md` F0–F5

## What the user saw

1. Isolated-pi failed on `f0-inventory`.
2. Model announced a revision to force current-session routing.
3. `hypagoal_submit_revision` rejected: objective must be preserved byte-for-byte.
4. Orphaned continuation closed; goal blocked; automatic revision 1/1 exhausted.
5. `/hypagraph show` is not a command (use `status`).

## Causal chain

```text
f0-inventory (default isolated-pi)
  → isolated executor outcome failed
  → f0-loop / root blocked (revision-eligible)
  → automatic revision selected (maximumAttempts = 1)
  → model changed definition.goal (strategy text / routing)
  → validateAutomaticRevision: automatic_revision_objective_changed
  → revision-rejected still increments consumedAttempts
  → classifyGoalBlockage: revision-exhausted
  → goal blocked; waves F1–F5 never ran
```

## Why the revision was illegal

`src/domain/goal-revision-policy.ts`:

```ts
if (next.goal !== previous.goal)
  // automatic_revision_objective_changed
```

The durable objective is identity. Strategy (current-session vs isolated-pi) is **not** the objective. Per-node `executorProfile` is the correct place for routing opt-in.

## Why the goal could not recover

`GoalAutomaticRevisionRuntime.maximumAttempts` is fixed to **1**. Rejected proposals count. There is no second automatic attempt after a bad revision.

## Graph notes (contributing complexity)

Authoring produced six implement/verify loops. Entry tasks use `requires: [verify]` feedback (valid loop pattern). First failure on F0 burned global revision for the whole multi-wave root.

## Prevention

| Layer | Action |
| --- | --- |
| Operator | Confirm `/hypagraph executor status` before Run; set `PI_BIN` if spawn fails |
| Authoring | Prefer smaller roots per wave (F0 alone) so F0 failure does not block F1–F5 |
| Authoring | If current-session is required, set `executorProfile` at create time |
| Skill | Hard rules: never change `goal` on automatic revision (updated in `skills/hypagraph/SKILL.md`) |
| Plan | §14.1 incident + mitigations in `docs/goal-family-product-surface-plan.md` |
| Product (future) | Optional: do not consume allowance on pure objective-mismatch; or surface clearer pre-submit checks; improve isolated failure diagnostics |

## Recovery for this session

1. `/hypagraph cancel` with an explicit reason (user-driven).
2. Create a new Hypagoal (smaller: F0 only, or F0–F5 with valid revision discipline).
3. If workers remain broken, set implement tasks to `executorProfile.kind: "current-session"` **in the create definition**, with the same objective string as the user request.
4. Do not expect `/hypagraph resume` to unlock revision-exhausted goals without a new create.
