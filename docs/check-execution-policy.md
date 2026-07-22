# Check cancellation, retry, and environment policy

- Status: implemented
- Milestone: M3 Slice 9
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

This document defines the host policy for command-check execution.

The policy prevents these failures:

- a user cannot stop a running check;
- an executor returns success after cancellation;
- a retry reuses an attempt ID;
- an old attempt supplies facts to a new attempt;
- retries continue without a limit;
- a command inherits unrelated secret environment values;
- an old Pi session branch receives a late result.

## 2. Active execution registry

The Pi extension keeps a session-scoped registry outside the domain reducer.

Each active entry contains:

```ts
interface ActiveCheckExecutionInfo {
  workflowId: string;
  nodeId: string;
  attemptId: string;
  startedAt: string;
}
```

The registry also owns the `AbortController` for the running process.

The registry does not store workflow state. It does not write domain events. It only controls the live external execution.

## 3. Cancellation sources

The primary cancellation source is the Pi tool abort signal.

A user or agent can also request cancellation with:

```text
hypagraph_cancel_check
/hypagraph check cancel [node-id]
```

The transition tool uses the same registry when its action is `cancel` for an active check.

A cancellation request aborts the executor signal. The check lifecycle then stores a normal raw result with status `cancelled` and completes failed verification.

Cancellation is terminal for the current attempt.

## 4. Late-result rejection

An executor can ignore an abort signal or finish during cancellation.

Hypagraph checks the signal after the executor returns.

If the signal is aborted and the result is not already cancelled, Hypagraph replaces the result with a cancelled result before normalization.

The replacement result:

- uses the current attempt ID;
- keeps output and evidence references;
- clears executor-supplied facts;
- records that the later result was ignored;
- cannot publish a success fact.

The durable event stream stores only the cancelled result.

## 5. Pi session changes

A Pi session switch, tree change, or shutdown aborts active checks.

The extension increments a local session generation when it restores a branch. A check captures the generation that was active when it started.

A result from an older generation cannot replace state in the newly restored branch.

Restore then uses the normal interrupted-check recovery path when required.

## 6. Retry policy

Retries are explicit. Hypagraph does not retry automatically.

A command check can declare:

```ts
interface CheckRetryPolicy {
  maxAttempts: number;
  retryOn: Array<"failed" | "timed_out" | "error">;
  backoffMs?: number;
}
```

The limits are:

- `maxAttempts` is from 2 through 20;
- `retryOn` must contain at least one unique status;
- `backoffMs` is from 0 through 86,400,000 milliseconds.

Cancellation and interruption do not permit retry through this policy. A graph revision or an explicit product decision must handle those cases.

## 7. Retry eligibility

A retry can start only when all these rules are true:

- the node status is `failed`;
- the definition contains a retry policy;
- the prior raw result status is in `retryOn`;
- the attempt count is below `maxAttempts`;
- the backoff period is complete;
- the new attempt ID was not used before;
- no other attempt is active in the workflow.

The same pure domain function checks retry eligibility in the reducer and the Pi adapter.

## 8. Attempt and fact isolation

Each retry uses a new immutable attempt ID.

The prior attempt, result, evidence, and artifacts remain in history.

When a retry-start event is projected, Hypagraph removes all current facts produced by that node. The new attempt must publish new facts.

The fact publication rules still require the current node, attempt ID, and workflow revision. A late fact from an old attempt is rejected.

## 9. Retry event data

A retry start uses the normal `hypagraph.check.started` event.

Its data contains:

```ts
{
  checkKind: "command";
  retry: true;
  previousAttemptId: string;
}
```

An initial check start contains `retry: false` and no previous attempt ID.

This keeps replay deterministic without a second retry event type.

## 10. Environment policy

A command-check definition can contain environment-variable names:

```ts
environmentVariables?: string[];
```

The definition cannot contain environment values.

Each name must match:

```text
^[A-Za-z_][A-Za-z0-9_]*$
```

Names must be unique. Windows comparison is case-insensitive.

When the definition supplies names, the child process inherits only those variables that exist in the host environment.

When the definition does not supply names, Hypagraph uses a small safe launch environment.

On Unix-like systems, the default names are:

```text
PATH
HOME
TMPDIR
```

On Windows, the default names are:

```text
Path
PATHEXT
SystemRoot
COMSPEC
TEMP
TMP
```

The executor still uses `shell: false`.

## 11. Secret handling

Environment values stay in process memory for the child launch only.

Hypagraph does not put environment values in:

- workflow definitions;
- domain events;
- snapshots;
- check results;
- artifacts;
- user interface output;
- logs created by Hypagraph.

A command can still print a secret that it received. Output capture and artifact access must therefore remain controlled by the host and workspace policy.

## 12. Test requirements

The implementation verifies:

- Pi abort propagation;
- cancellation by node and attempt;
- duplicate active-attempt rejection;
- late success replacement with a cancelled result;
- no success-fact publication after cancellation;
- new attempt IDs for retries;
- retry backoff enforcement;
- maximum attempt enforcement;
- prior-status restrictions;
- prior-fact removal;
- declared environment inheritance;
- undeclared environment removal;
- public Pi definition normalization;
- invalid policy rejection;
- Pi tool registration.
