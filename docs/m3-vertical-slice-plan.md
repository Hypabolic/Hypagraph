# M3 deterministic check execution plan

- Status: planned
- Milestone: M3
- Release marker: v0.4
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Objective

Make deterministic checks first-class workflow nodes.

A check must:

- run outside the reducer;
- return a structured result;
- publish typed facts;
- publish evidence references;
- never change canonical state directly;
- support timeout and cancellation;
- rebuild from events without running again.

The first useful end-to-end result is complete after Slice 5. Slices 6 to 11 add more check types and harden the runtime.

## 2. Mandatory design rules

### 2.1 Keep process execution outside the reducer

The reducer validates commands and returns events. It must not start a process, read a report file, or call an executor.

### 2.2 Treat all check output as untrusted

The runtime must validate:

- exit data;
- parsed reports;
- file paths;
- fact values;
- evidence references;
- output sizes.

### 2.3 Keep large output out of events

Store stdout, stderr, and reports through an artifact interface. Events contain references only.

### 2.4 Use explicit bounded execution

Each executable check must have:

- a hard timeout;
- a cancellation signal;
- an output-size limit;
- a report-size limit when applicable;
- an explicit environment policy;
- an explicit working directory.

### 2.5 Preserve replay

Replay must use stored events and artifacts. Replay must not run a command or parse a source report again.

## 3. Slice 1 - Check contracts and result model

### Goal

Define the M3 domain model without command execution.

### Add

Add a check node kind:

```ts
type NodeKind = "task" | "gate" | "check";
```

Add initial check kinds:

```ts
type CheckKind =
  | "command"
  | "test-report"
  | "lint-report"
  | "coverage-report"
  | "file-assertion"
  | "git-assertion";
```

Only `command` is executable in this slice. The other values reserve the public model for later slices.

Add a command check definition:

```ts
interface CommandCheckDefinition {
  kind: "command";
  command: string;
  arguments?: string[];
  workingDirectory?: string;
  timeoutMs: number;
  expectedExitCodes?: number[];
  publish: FactMapping[];
}
```

Add a normalized check result:

```ts
interface CheckResult {
  checkKind: CheckKind;
  attemptId: string;
  startedAt: string;
  completedAt: string;
  status: "passed" | "failed" | "timed_out" | "cancelled" | "error";
  exitCode?: number;
  facts: FactInput[];
  evidence: EvidenceReference[];
  stdoutRef?: string;
  stderrRef?: string;
  error?: string;
}
```

### Validation

Reject:

- a check definition on a non-check node;
- a check node without a check definition;
- a timeout that is not positive;
- an undeclared output fact;
- a duplicate fact mapping;
- an unsupported check kind;
- gate fields on a check node.

### Tests

- Accept a valid command check definition.
- Reject an invalid timeout.
- Reject an invalid output mapping.
- Reject gate configuration on a check node.
- Reject check configuration on a task node.

### Done when

A valid check graph can be defined and persisted, but it cannot run.

## 4. Slice 2 - Check execution boundary

### Goal

Create an execution interface that keeps process execution outside the domain reducer.

### Add

```ts
interface CheckExecutionRequest {
  workflowId: string;
  revision: number;
  nodeId: string;
  attemptId: string;
  definition: CommandCheckDefinition;
}

interface CheckExecutor {
  execute(
    request: CheckExecutionRequest,
    signal: AbortSignal,
  ): Promise<CheckExecutionResult>;
}
```

The executor returns raw data:

```ts
interface CheckExecutionResult {
  startedAt: string;
  completedAt: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  timedOut: boolean;
  cancelled: boolean;
  error?: string;
}
```

Add a fake executor for tests. Do not add `node:child_process` in this slice.

### Runtime flow

```text
start-check command
        |
        v
hypagraph.check.started
        |
        v
adapter calls CheckExecutor
        |
        v
submit-check-result command
        |
        v
domain validates result
```

### Events

```text
hypagraph.check.started
hypagraph.check.result-submitted
```

### Tests

- The reducer emits a check start event.
- The reducer does not call the executor.
- The runtime rejects a stale attempt.
- Result submission requires the active attempt.
- Replay does not execute the check.

### Done when

The runtime can represent check execution from start to result with a fake executor.

## 5. Slice 3 - Command check runner

### Goal

Run a bounded local command.

### Add

Add a Node.js command executor that uses `node:child_process` and `spawn`.

Required controls:

- no shell by default;
- an explicit command and argument array;
- a bounded output size;
- an explicit working directory;
- a timeout;
- a cancellation signal;
- process-tree termination;
- captured stdout and stderr;
- deterministic result normalization.

Do not use `shell: true`.

Add an explicit environment policy:

```ts
interface EnvironmentPolicy {
  inherit: string[];
  set?: Record<string, string>;
}
```

A check definition must not contain secrets.

Add an output store:

```ts
interface CheckOutputStore {
  write(
    workflowId: string,
    attemptId: string,
    stream: "stdout" | "stderr",
    content: Uint8Array,
  ): Promise<EvidenceReference>;
}
```

### Tests

- Run a successful command.
- Return a non-zero exit code.
- Stop on timeout.
- Stop on cancellation.
- Report command-not-found.
- Truncate excessive output.
- Return stdout and stderr references.
- Do not interpret shell metacharacters.

### Done when

Hypagraph can run one bounded local command check.

## 6. Slice 4 - Deterministic result normalization

### Goal

Convert raw process output into a stable domain result.

### Add

Use an exit-code policy:

```ts
expectedExitCodes: number[];
```

Use these result rules:

```text
cancelled      -> cancelled
timed out      -> timed_out
executor error -> error
expected code  -> passed
other code     -> failed
```

Publish standard result fields through declared fact mappings:

```text
passed
status
exitCode
durationMs
timedOut
cancelled
```

Example:

```yaml
publish:
  - source: exitCode
    fact: tests.exit_code
  - source: passed
    fact: tests.passed
```

The completed event must include:

- normalized status;
- exit code;
- start and end time;
- fact values;
- evidence references;
- output references.

### Tests

- The same raw result gives the same normalized result.
- Expected exit codes pass.
- Other exit codes fail.
- A timeout never reports passed.
- Facts match declared contracts.
- Replay restores the same facts.

### Done when

A command check produces typed facts that a gate can use.

## 7. Slice 5 - Automatic check lifecycle

### Goal

Remove manual verification commands from deterministic check nodes.

### Lifecycle

```text
ready
  |
  v
starting
  |
  v
running
  |
  +-> succeeded
  +-> failed
  +-> timed_out
  +-> cancelled
  +-> error
```

A check node must not require:

- `submit-result`;
- `begin-verification`;
- `complete-verification`.

### Commands

```text
start-check
complete-check
cancel-check
```

`complete-check` accepts only structured executor output.

A validated result must produce:

- fact publication events;
- evidence references;
- node success or failure;
- downstream readiness;
- gate readiness.

### Tests

- A successful check completes the node.
- A failed check marks the node failed.
- A timeout has an explicit state.
- Cancellation has an explicit state.
- A downstream node becomes ready only after success.
- A failed check does not satisfy dependencies.

### Done when

A check node has a complete deterministic lifecycle.

This slice gives the first M3 end-to-end product result:

```text
command check
      |
      v
typed facts
      |
      v
    gate
      |
      v
selected route
```

## 8. Slice 6 - JUnit test report parser

### Goal

Support structured test results instead of exit-code data only.

Start with JUnit XML.

### Add

```ts
interface TestReportCheckDefinition {
  kind: "test-report";
  command: string;
  arguments?: string[];
  reportPath: string;
  timeoutMs: number;
}
```

Publish:

```text
tests.total
tests.passed
tests.failed
tests.skipped
tests.duration_ms
tests.report_valid
```

### Security and validation

Treat report files as untrusted. Reject or fail safely on:

- a missing file;
- invalid XML;
- external entity use;
- excessive file size;
- invalid numeric values;
- inconsistent totals.

### Tests

- Parse a valid JUnit report.
- Report failed tests.
- Report skipped tests.
- Reject malformed XML.
- Reject a missing report.
- Reject an oversized report.
- Fail when the command succeeds but the report is invalid.
- Preserve the report when the command fails but the report exists.

### Done when

A test check can route from structured test facts.

## 9. Slice 7 - Coverage and lint adapters

### Goal

Prove that the check pipeline supports multiple deterministic parsers.

### Coverage

Start with Cobertura XML or LCOV.

Publish:

```text
coverage.line_percent
coverage.branch_percent
coverage.lines_covered
coverage.lines_total
coverage.report_valid
```

### Lint

Start with ESLint JSON.

Publish:

```text
lint.errors
lint.warnings
lint.files
lint.clean
lint.report_valid
```

### Parser interface

```ts
interface CheckResultParser<TDefinition> {
  parse(
    definition: TDefinition,
    execution: CheckExecutionResult,
    artifacts: CheckArtifacts,
  ): ParsedCheckResult;
}
```

### Tests

- Parse a valid report.
- Reject a malformed report.
- Reject a missing report.
- Enforce report-size limits.
- Produce type-correct facts.
- Produce deterministic parser output.

### Done when

The same execution and event pipeline supports command, test report, and coverage or lint checks.

## 10. Slice 8 - File and Git assertions

### Goal

Add deterministic checks that do not require a child process.

### File assertions

Initial assertions:

- exists;
- does not exist;
- contains text;
- matches SHA-256;
- size less than;
- size greater than.

Example:

```yaml
check:
  kind: file-assertion
  path: docs/architecture.md
  assertion: exists
```

### Git assertions

Initial assertions:

- worktree clean;
- no untracked files;
- branch name equals;
- file changed;
- file not changed;
- paths changed only in an allowed scope.

Use a Git adapter. Do not depend on user-facing Git output when a structured interface is available.

### Facts

```text
file.exists
file.sha256
git.clean
git.untracked_count
git.changed_paths
git.scope_valid
```

### Tests

- Check file existence and absence.
- Check a matching and non-matching hash.
- Check a clean and dirty worktree.
- Check untracked files.
- Check allowed and disallowed paths.
- Use deterministic changed-path ordering.

### Done when

Hypagraph can verify repository state without model judgement.

## 11. Slice 9 - Retry, timeout, and cancellation policy

### Goal

Make operational failure explicit and bounded.

### Add

```ts
interface CheckRetryPolicy {
  maxAttempts: number;
  retryOn: Array<"error" | "timed_out" | "failed">;
  backoffMs?: number;
}
```

Automatic retry is off by default.

Each retry must use a new attempt ID.

Cancellation must:

- signal the executor;
- terminate the process;
- reject a late result;
- emit a cancellation event;
- keep partial output references when available.

### Tests

- Timeout terminates execution.
- Cancellation terminates execution.
- A late completion is rejected.
- A retry creates a new attempt ID.
- Facts from an old attempt do not leak into a new attempt.
- The runtime enforces the maximum attempt count.

### Done when

A check cannot run without a hard bound.

## 12. Slice 10 - Pi adapter and user-facing tools

### Goal

Expose checks through Pi without putting execution logic in the extension adapter.

### Flow

```text
Pi tool
  |
  v
domain start-check command
  |
  v
persist started event
  |
  v
executor runs
  |
  v
domain complete-check command
  |
  v
persist result events
```

Keep one domain command surface. Add a runtime coordinator in the Pi adapter.

The user interface must show:

- command;
- current check state;
- elapsed time;
- exit code;
- timeout state;
- published facts;
- evidence links;
- stdout and stderr references.

### Tests

- Persist the start event before execution.
- Persist the result after execution.
- Handle cancellation.
- Do not write domain state directly.
- Do not rerun a command during session restore.

### Done when

A user can run a deterministic check from Pi.

## 13. Slice 11 - Hardening and milestone closure

### Goal

Close M3 against its acceptance criteria.

### Confirm

- output-size limits;
- report-size limits;
- timeout limits;
- command policy;
- environment policy;
- path normalization;
- working-directory scope checks;
- artifact retention policy;
- Windows, Linux, and macOS behavior;
- event replay tests;
- failure injection tests;
- documentation;
- example workflows.

### Required end-to-end examples

#### Tests route to documentation

```text
run-tests
    |
    v
tests.failed == 0
  | true       | false
  v            v
document      repair
```

#### Coverage gate

```text
run-coverage
      |
      v
coverage.line_percent >= 90
  | true       | false
  v            v
release       add-tests
```

#### Repository scope gate

```text
git-scope-check
      |
      v
git.scope_valid == true
  | true       | false
  v            v
continue      block
```

## 14. M3 acceptance criteria

- [ ] A command check runs with no shell by default.
- [ ] Every executable check has a hard timeout.
- [ ] Cancellation terminates active execution.
- [ ] Large output does not enter the event stream.
- [ ] Check output is treated as untrusted input.
- [ ] A check publishes typed facts.
- [ ] A gate can route from those facts.
- [ ] A timeout is an explicit result.
- [ ] A failed check is different from an executor error.
- [ ] A stale check result cannot change current state.
- [ ] Replay does not rerun a check.
- [ ] The same structured result always produces the same facts.
- [ ] CI passes on Node.js 22 and Node.js 24.
- [ ] One full Pi dogfood workflow is recorded.

## 15. Implementation order

Implement the slices in this order:

1. Check contracts and result model.
2. Check execution boundary.
3. Command check runner.
4. Deterministic result normalization.
5. Automatic check lifecycle.
6. JUnit test report parser.
7. Coverage and lint adapters.
8. File and Git assertions.
9. Retry, timeout, and cancellation policy.
10. Pi adapter and user-facing tools.
11. Hardening and milestone closure.

Do not start parser expansion before the command-check pipeline can publish facts and drive a gate.