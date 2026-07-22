# M3 completion phase plan

- Status: planned
- Milestone: M3
- Release marker: v0.4
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

This phase makes the completed command-check runtime usable through the Pi product.

Slices 1 to 5 provide the domain model, execution boundary, command runner, result normalization, and automatic lifecycle. These functions are not yet available through the public Pi definition and tool surface.

Do not start M4 loop execution before this phase is complete.

## 2. Product result

At the end of this phase, a user can:

1. Define a command check in Pi.
2. Run the check from Pi.
3. See progress while the check runs.
4. Cancel the check through the Pi cancellation signal.
5. Restore the session without running the check again.
6. See the result, facts, evidence, and output references.
7. Use the published facts in a deterministic gate.
8. Retry an interrupted or failed check with a new attempt ID.

## 3. Scope decision

The v0.4 release must close the command-check vertical slice before it adds more parser types.

The following work is release-critical:

- Pi definition support;
- Pi execution support;
- durable state commits;
- cancellation and interrupted-run handling;
- user interface output;
- end-to-end gate routing;
- dogfood validation;
- documentation and release tasks.

The following adapters move to an M3.1 extension phase unless they reveal a missing core abstraction:

- JUnit XML;
- coverage reports;
- lint reports;
- file assertions;
- Git assertions.

This split prevents parser work from delaying the first usable check product.

## 4. Mandatory architecture rules

### 4.1 Keep the reducer pure

The reducer must not:

- start a process;
- write an artifact;
- read a report;
- use the clock;
- create an ID;
- write to Pi session state.

### 4.2 Commit the start before execution

The host must store the `hypagraph.check.started` event before it starts the executor.

The required order is:

```text
validate start
    |
    v
commit started event
    |
    v
start executor
    |
    v
commit facts and result
    |
    v
commit verification result
```

A process must not start when the start event cannot be stored.

### 4.3 Do not rerun during restore

Session restore must only rebuild state from stored events.

If restore finds a running check without a live executor handle, the host must mark the attempt as interrupted. It must not start the command again.

A retry must use a new attempt ID.

### 4.4 Use one canonical writer

Only one host coordinator can append events for one workflow sequence.

A store write must include the expected sequence number. A sequence conflict must stop the lifecycle.

### 4.5 Preserve late-result rejection

A cancelled, interrupted, stale, or replaced attempt must reject a late executor result.

The host can keep output artifacts, but the late result must not publish facts or change canonical node state.

## 5. Slice 6 - Pi check definition and execution tool

### Goal

Expose the existing command-check pipeline through Pi.

### Add

Update the public definition schema to support:

- `kind: check`;
- command;
- argument array;
- working directory;
- timeout;
- expected exit codes;
- fact mappings.

Add check normalization to `normalizeDefinition`.

Add a dedicated `hypagraph_run_check` tool.

The tool must:

1. Require a ready check node.
2. Create a new attempt ID.
3. Call the automatic lifecycle coordinator.
4. Pass the Pi `AbortSignal` to the executor.
5. send bounded progress updates;
6. return the final workflow projection.

Do not route a check through the task `start-node` command.

### User interface

Show:

- node ID;
- command and arguments;
- state;
- elapsed time;
- final status;
- exit code;
- published facts;
- stdout reference;
- stderr reference;
- error or failure reason.

### Tests

- Pi accepts a valid command-check definition.
- Pi rejects an invalid definition through the domain validator.
- A ready check runs through the check lifecycle.
- A task cannot use the check tool.
- A check cannot use the task start path.
- A Pi abort reaches the executor.
- The tool does not write domain state directly.

### Done when

A user can define and run one command check from Pi.

## 6. Slice 7 - Durable lifecycle store and recovery

### Goal

Store every accepted lifecycle step before the next external side effect.

### Add

Add a host storage port:

```ts
interface WorkflowEventStore {
  append(input: {
    workflowId: string;
    expectedSequence: number;
    events: DomainEvent[];
    snapshot: HypagraphState;
  }): Promise<void>;
}
```

Add a host coordinator that applies one command and commits its events before it continues.

The coordinator must commit at these boundaries:

1. check started;
2. facts published;
3. raw result recorded;
4. verification completed.

Use an adapter for Pi session persistence. If Pi cannot store an entry during a running tool call, use a local append-only journal and mirror the final state into Pi session details.

Add interrupted-run recovery:

- detect a projected running check with no live executor handle;
- record an explicit interrupted result or recovery event;
- fail the attempt without publishing success facts;
- require a new attempt for retry.

### Tests

- The start event is stored before executor invocation.
- A store failure prevents process execution.
- Facts are stored before result recording freezes the attempt.
- Restore does not call the executor.
- Restore closes an orphaned running attempt.
- A sequence conflict stops the coordinator.
- Replaying the stored events gives the stored snapshot.

### Done when

A host crash cannot silently lose a started check or rerun it during restore.

## 7. Slice 8 - Cancellation, retry, and execution policy

### Goal

Make operational failure explicit and bounded.

### Add

Add an active-execution registry outside the domain:

- workflow ID;
- node ID;
- attempt ID;
- abort controller;
- start time.

Use the Pi tool signal as the primary cancellation source.

Add explicit host cancellation for a registered execution.

Add retry policy to the check definition:

```ts
interface CheckRetryPolicy {
  maxAttempts: number;
  retryOn: Array<"error" | "timed_out" | "failed">;
  backoffMs?: number;
}
```

Automatic retry remains off by default.

Each retry must:

- use a new attempt ID;
- keep the old result and artifacts;
- reject old facts for the new attempt;
- enforce the maximum attempt count.

Complete the command environment policy. Inherit only declared environment variables. Do not store secret values in the workflow definition or event stream.

### Tests

- Cancellation terminates the process.
- Cancellation records a terminal result.
- A late result cannot change state.
- Retry uses a new attempt ID.
- Retry does not reuse old facts.
- The runtime enforces the attempt limit.
- The executor receives only the permitted environment.

### Done when

Every check execution has explicit time, output, cancellation, environment, and retry bounds.

## 8. Slice 9 - End-to-end closure and v0.4 release

### Goal

Close M3 against the real product path.

### Required dogfood graph

```text
run-tests
    |
    v
tests.passed == true
  | true       | false
  v             v
document       repair
```

The run must prove:

- Pi definition;
- command execution;
- start persistence;
- output artifacts;
- fact publication;
- gate routing;
- selected branch readiness;
- restore without rerun;
- replay equality;
- cancellation;
- failure handling.

### Documentation

Update:

- `README.md`;
- `docs/execution-roadmap.md`;
- `docs/m3-vertical-slice-plan.md`;
- Pi tool guidance;
- example workflow definitions;
- event and storage documentation.

### Release checks

- CI passes on Node.js 22 and Node.js 24.
- Platform tests cover Linux, macOS, and Windows process behavior.
- Output and artifact limits are documented.
- The artifact retention rule is documented.
- The command and environment policies are documented.
- One dogfood result is recorded.
- The package version is set to v0.4.
- The M3 release is tagged.

### Done when

A Pi user can run a deterministic command check that publishes facts and selects a gate route. Restore and replay do not run the command again.

## 9. M3.1 adapter extension phase

Start this phase only after v0.4.

Implement in this order:

1. JUnit XML parser.
2. ESLint JSON parser.
3. Cobertura XML or LCOV parser.
4. File assertions.
5. Git assertions.

Each adapter must use the same execution, artifact, normalization, publication, and lifecycle interfaces.

Do not add adapter-specific state transitions.

## 10. Exit criteria

M3 is complete when:

- [ ] Pi can define a command check.
- [ ] Pi can run a command check.
- [ ] The start event is durable before execution.
- [ ] Restore never reruns a check.
- [ ] An interrupted run closes explicitly.
- [ ] Cancellation reaches the executor.
- [ ] Late results are rejected.
- [ ] A check publishes typed facts.
- [ ] A gate routes from those facts.
- [ ] Output stays outside the event stream.
- [ ] The same events always rebuild the same state.
- [ ] The real Pi dogfood workflow passes.
- [ ] CI passes on Node.js 22 and Node.js 24.
- [ ] v0.4 documentation and release tasks are complete.
