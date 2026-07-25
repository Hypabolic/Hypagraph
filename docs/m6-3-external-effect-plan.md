# M6.3 external effects and reconciliation vertical-slice plan

- Status: planned
- Milestone: M6.3
- Release marker: v0.10
- Prerequisite: M6.2 code nodes and the sandbox executor adapter
- Analysis source: `docs/graph-capability-review.md` section 8, gap N5
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

M6.3 lets a node change external state safely.

Reference workflow A needs this for "open a pull request", "merge", and "promote to production". Reference workflow B needs it for "send to user".

## 2. Problem

A sandbox and an idempotency key give the execution mechanism. They do not give the state model.

An external effect can complete in the external system after the host loses the result. A network failure after the request reached the server is not a failure of the effect. It is a loss of knowledge about the effect.

Every existing check status describes local execution. The nearest concept is `interrupted`, which records that the host could not store a result. It does not reconcile. A retry of an `interrupted` external effect can merge twice or deploy twice.

An earlier version of the analysis described an effect node as "a code node with an idempotency key". That description is incomplete. It gives the mechanism and omits the state model.

## 3. Canonical model

### 3.1 Three durable effect states

| State | Meaning | Permitted next action |
| --- | --- | --- |
| `requested` | The controller stored the intent before the effect started. | Run the effect. Observe the outcome. |
| `observed` | The controller confirmed the outcome from the external system. | Publish facts. Continue. |
| `indeterminate` | The controller cannot decide the outcome. | Reconcile. Never retry blindly. |

`observed` carries the outcome, which can be success or failure. An observed failure is a normal failure. It is not an indeterminate state.

### 3.2 Reconciliation

Each external effect declares a reconciliation query. The query is a read-only operation which answers one question: did this effect happen?

The query uses the idempotency key or a declared external identity, for example a branch name, a pull-request number, or a deployment identifier.

Restart runs the reconciliation query for every `indeterminate` effect before the controller selects any new action.

A reconciliation query which cannot decide leaves the effect `indeterminate`. An unresolved indeterminate effect blocks its dependants explicitly. It must not silently continue and it must not silently retry.

### 3.3 Idempotency

Each effect declares an idempotency key which is derived from canonical identity: the workflow identity, the revision, the node identity, and the attempt identity.

A key must not depend on the clock or on a random value, so that a repeated attempt after a restart produces the same key.

An external system which supports an idempotency key must receive it. An external system which does not support one must be reconciled through a declared query instead.

### 3.4 Separate execution success from external success

This mirrors the existing rule which separates execution success from integration success in M8.

A program which exits zero has not proved that the pull request exists. Only an observation proves it.

## 4. Definition shape

```ts
export interface EffectNodeDefinition {
  kind: "effect";
  version: 1;
  effect: CodeNodeDefinition;
  reconcile: CodeNodeDefinition;
  idempotency: { from: "canonical-identity" };
  externalIdentity: FactContract[];
  onIndeterminate: "block-dependants" | "fail-workflow";
}
```

The effect and the reconciliation query both use the M6.2 code node and the sandbox adapter. The reconciliation query must declare a read-only capability grant. Validation must reject a reconciliation query which declares a mutating capability.

## 5. Mandatory rules

1. Store `requested` before the external call starts. Do not start an external effect when the host cannot first store the request event.
2. Never treat a lost result as a failure. Store `indeterminate`.
3. Never retry an `indeterminate` effect without a reconciliation result.
4. Keep the reconciliation query read-only, and enforce it through the capability allowlist.
5. Derive the idempotency key from canonical identity only.
6. Block dependants explicitly when reconciliation cannot decide.
7. Replay must reproduce the effect state without repeating the external call.
8. An effect node must declare its scope of external authority, so that a revision cannot widen it.

## 6. Vertical slices

### Slice 1 - Effect state model

Scope:

1. Add the `effect` node kind and the three durable states.
2. Add events for requested, observed, and indeterminate.
3. Add the explicit blocked-dependant path for an unresolved indeterminate effect.

Tests:

- a request event is stored before the effect starts;
- a lost result produces `indeterminate` and never success;
- an unresolved indeterminate effect blocks its dependants;
- replay reproduces every effect state.

### Slice 2 - Idempotency and the effect executor

Scope:

1. Derive the idempotency key from canonical identity.
2. Run the effect through the M6.2 sandbox adapter with a declared external capability.
3. Publish the declared external identity facts from the observation.

Tests:

- the same attempt after a restart derives the same key;
- a key does not depend on the clock or on a random value;
- an effect cannot run outside its declared capability grant.

### Slice 3 - Reconciliation

Scope:

1. Add the declared reconciliation query.
2. Run reconciliation at restart for every indeterminate effect, before any new action.
3. Resolve to observed, or keep indeterminate and block.
4. Reject a mutating reconciliation query at validation time.

Tests:

- a completed external effect with a lost result reconciles to `observed`;
- an effect which never reached the external system reconciles to an observed failure;
- an undecidable query keeps `indeterminate` and blocks;
- a mutating reconciliation query fails validation;
- reconciliation runs before the controller selects new work.

### Slice 4 - Product surface and dogfood

Scope:

1. Show effect state, external identity, and reconciliation state in `/hypagoal status` and the graph pane.
2. Run one objective which opens a pull request, loses the result, restarts, and reconciles.
3. Record evidence in `docs/m6-3-dogfood.md`.

## 7. Acceptance criteria

- An effect stores `requested` before it starts the external call.
- A lost result produces `indeterminate` and never a silent success.
- Restart reconciles an indeterminate effect through a declared read-only query.
- An unresolved indeterminate effect blocks its dependants explicitly.
- A repeated attempt with the same idempotency key does not duplicate the external effect.
- Execution success and external success remain separate states.
- A mutating reconciliation query fails validation.
- Replay reproduces the effect state without repeating the external call.

## 8. Out of scope

- worktree integration and merge conflict handling, which belong to M8;
- triggers which start work from an external event, which belong to M10;
- a general external-service adapter library. Each effect declares its own bounded capability grant.
