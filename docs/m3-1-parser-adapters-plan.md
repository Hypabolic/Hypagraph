# M3.1 deterministic parser adapters

- Status: complete
- Release marker: implemented after v0.5
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Objective

Complete the deterministic check types that M3 deferred after command-check execution.

M3.1 converts bounded tool output and repository state into typed facts. The runtime does not ask a model to interpret a test report, lint report, coverage report, file assertion, or Git assertion.

## 2. Product result

A workflow can define command, report, file-assertion, and Git-assertion checks through the same node contract and durable lifecycle.

The runtime can:

- run a bounded producer command;
- read only the declared report or repository state;
- validate the declared parser or assertion version before execution;
- publish canonical typed facts;
- retain raw reports and assertion evaluations as evidence;
- distinguish an assertion failure from an invalid evaluator input;
- restore without repeating a completed external side effect;
- replay the same facts, results, and workflow state.

## 3. Mandatory rules

- A parser or assertion evaluator is deterministic and versioned.
- A parser reads only bounded declared input.
- An assertion resolves paths inside the configured workspace root.
- Git assertions use a fixed command allowlist.
- A parser or assertion evaluator does not use a model.
- Malformed input produces explicit diagnostics.
- Unsupported formats and incomplete fact contracts fail during graph validation.
- Parsed values must match declared fact types.
- Raw input remains untrusted evidence.
- Restore and replay do not repeat an external side effect.
- A parser or assertion result cannot change canonical state directly.

## 4. Completed vertical slices

### Slice 1: Test-report parser boundary

- Added a pure, versioned Vitest JSON parser.
- Normalized suite, test, pass, and optional duration values.
- Rejected malformed, incomplete, inconsistent, and invalid-time reports.

### Slice 2: Executable test-report checks

- Added the declarative `test-report` check kind.
- Validated parser identity, version, report path, namespace, size, and fact contract.
- Dispatched producer commands through the bounded command runner.
- Stored the raw report as evidence.
- Published parser facts through the durable event lifecycle.
- Added restore and replay coverage.

### Slice 3: Lint-report adapters

- Added the versioned ESLint JSON parser.
- Published success, file, error, warning, and fixable counts.
- Kept producer status separate from report validity.

### Slice 4: Coverage-report adapters

- Added the versioned Istanbul coverage-summary parser.
- Published line, statement, function, and branch totals, covered counts, skipped counts, and percentages.
- Rejected non-finite, out-of-range, and inconsistent values.

### Slice 5: File assertions

- Added first-class `file-assertion` checks.
- Supported existence, absence, exact size, SHA-256, and bounded text matching.
- Enforced workspace containment and bounded reads.
- Recorded the deterministic assertion evaluation as evidence.

### Slice 6: Git assertions

- Added first-class `git-assertion` checks.
- Supported clean state, branch, revision, and exact or containing changed-path sets.
- Used direct process invocation with a fixed Git command and argument allowlist.
- Rejected arbitrary Git arguments and escaping paths.

### Slice 7: Authoring and Pi surfaces

- Extended `hypagraph_define` schemas and normalization for every M3.1 check kind.
- Added retry-policy support to reports and assertions.
- Added Pi result formatting for parser identity, report path, assertion identity, facts, and diagnostics.
- Preserved the existing durable Pi check entry point while dispatching through the generic check runner.

### Slice 8: Dogfood and hardening

- Added one durable workflow that executes:
  1. a Vitest report check;
  2. an ESLint report check;
  3. an Istanbul coverage check;
  4. a bounded file assertion;
  5. a fixed-allowlist Git assertion.
- Verified canonical facts after each node.
- Verified workflow completion, persisted snapshot equality, and event replay equality.
- Added cross-platform CI coverage on Ubuntu, macOS, and Windows with Node.js 22 and 24.

## 5. Public fact naming

Parser-internal field names are not public workflow contracts.

Public facts:

- use the check namespace;
- use lowercase dotted paths;
- use kebab-case for multiword segments;
- do not collide after namespacing.

Examples:

- `tests.success`;
- `tests.suites.passed`;
- `tests.duration-ms`;
- `lint.files.with-errors`;
- `lint.fixable-warnings`;
- `coverage.lines.percent`;
- `artifact.size-bytes`;
- `repository.changed-paths`.

Required parser outputs must have required fact contracts. Optional parser outputs, such as Vitest duration, must have optional contracts.

## 6. Failure semantics

- A producer timeout, cancellation, interruption, or execution error does not parse a report.
- An invalid report or invalid assertion definition produces an `error` result and publishes no canonical facts.
- A valid assertion that evaluates to false produces a `failed` result with recorded diagnostic evidence.
- A successful parser or assertion publishes only declared facts with matching types.
- Duplicate public fact names produce an explicit executor error.

## 7. Acceptance evidence

M3.1 is complete because:

- all supported adapters and assertions are deterministic and versioned;
- invalid input cannot publish canonical facts;
- facts have stable names and types;
- raw reports and assertion evaluations remain available as evidence;
- Pi explains parser and assertion results;
- restore does not rerun completed commands or repeat external reads;
- replay reproduces the same normalized facts and workflow state;
- the complete five-check dogfood workflow passes;
- the hosted matrix passes on Windows, macOS, and Ubuntu with Node.js 22 and 24.
