# M6.3 dogfood evidence

- Status: simulated
- Date: 2026-07-29
- Suite: `tests/m6-3-external-effects.test.ts`
- Schema version: 8

## Scope

This dogfood uses an in-memory external effect host. It does not call a live GitHub API.

The host models:

1. apply with an idempotency key;
2. lost result after the external side effect completes;
3. read-only reconcile query by idempotency key;
4. never-reached outcome when no record exists.

## Scenario

1. Define a workflow with seed task, effect node `open-pr`, and dependant task `after-pr`.
2. Seed facts and make the effect ready.
3. Store `requested` before the external call.
4. Simulate a lost result after the host records the external identity.
5. Confirm the node is `indeterminate` and `blocked`, and the dependant stays `pending`.
6. Confirm the controller selects `reconcile-indeterminate-effect` before new work.
7. Run the declared reconcile query.
8. Resolve to `observed` success and publish external identity facts.
9. Confirm the external host has one record only for the idempotency key.
10. Replay the event stream and confirm the effect state without a second host call.

## Product controller path

The extension runs authored effect and reconcile programs through `SandboxEffectExecutor` over QuickJS. Host handlers for `mcp.effect.apply` and `mcp.effect.query` use the in-memory host as a simulated external system. Programs receive host-injected bindings:

- `inputs["effect.idempotency_key"]`
- `inputs["effect.phase"]` (`effect` or `reconcile`)

Do not declare these names in `program.inputs`. Prepare includes them in ambient types and the runtime identity pin. Execution injects values and re-pins identity so QuickJS accepts the program.

A real GitHub or deploy adapter can replace the in-memory handlers without changing the durable state model.

## Result

All acceptance criteria pass in the automated suite. Live GitHub dogfood is not required for the M6.3 implementation gate. A later release cut can attach a live PR scenario when credentials and a safe repository are available.
