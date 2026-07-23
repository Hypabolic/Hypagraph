# M3.1 deterministic parser adapters

- Status: active
- Release marker: deferred after v0.5
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Objective

Complete the check types that M3 deferred after command-check execution.

M3.1 converts bounded tool output and repository state into typed facts. The runtime must not ask a model to interpret a test report, lint report, coverage report, file assertion, or Git assertion.

## 2. Product result

A workflow can define a supported parser adapter, run or read its declared input, publish normalized facts, preserve the raw input as evidence, restore without a second external read, and replay the same facts and check result.

## 3. Mandatory rules

- A parser is deterministic and versioned.
- A parser reads only bounded declared input.
- A parser does not execute a shell command.
- A parser does not use a model.
- Malformed input produces explicit diagnostics.
- Unsupported formats fail during graph validation.
- Parsed values must match declared fact types.
- Raw input remains untrusted evidence.
- Restore and replay do not repeat an external side effect.
- A parser result cannot change canonical state directly.

## 4. Vertical slices

### Slice 1: Add the test-report parser boundary

- Define the parser result contract.
- Add a versioned Vitest JSON parser.
- Normalize suite and test counts into typed facts.
- Reject malformed, incomplete, and inconsistent reports.
- Add deterministic parser tests.

This slice is pure. It does not yet run a command or publish facts into a workflow.

### Slice 2: Integrate test-report checks

- Add the `test-report` check definition.
- Run the declared command through the existing bounded command runner.
- Parse the declared report artifact after command completion.
- Publish pass state, suite counts, test counts, and duration.
- Preserve command output and the raw report as evidence.

### Slice 3: Add lint-report adapters

- Add one versioned ESLint JSON adapter.
- Publish error, warning, fixable, and file counts.
- Keep lint process failure separate from report validity.

### Slice 4: Add coverage-report adapters

- Add one versioned Istanbul summary adapter.
- Publish line, branch, function, and statement percentages.
- Reject non-finite or out-of-range values.

### Slice 5: Add file assertions

- Support existence, absence, content hash, size, and bounded text matching.
- Resolve all paths inside the configured workspace root.
- Store assertion evidence before verification completes.

### Slice 6: Add Git assertions

- Support clean state, changed-path sets, branch name, and revision assertions.
- Use direct process invocation with a fixed Git command allowlist.
- Do not accept arbitrary Git arguments from a workflow definition.

### Slice 7: Complete authoring and Pi surfaces

- Extend `hypagraph_define` schemas and guidance.
- Show parser identity, format version, diagnostics, and published facts.
- Explain report-invalid and assertion-failed states separately.

### Slice 8: Dogfood and harden

- Run test, lint, coverage, file, and Git checks in one workflow.
- Cover malformed reports, timeouts, cancellation, restore, replay, stale results, and branch changes.
- Add cross-platform CI fixtures.

## 5. Slice 1 fact contract

The first parser publishes these values:

- `passed`: Boolean;
- `testSuites.total`: integer;
- `testSuites.passed`: integer;
- `testSuites.failed`: integer;
- `tests.total`: integer;
- `tests.passed`: integer;
- `tests.failed`: integer;
- `tests.skipped`: integer;
- `durationMs`: number when the report supplies a valid duration.

A report is inconsistent when a subtotal is negative, a subtotal exceeds its total, or passed, failed, and skipped test counts do not equal the total.

## 6. Acceptance criteria

M3.1 is complete when:

- each supported adapter has a versioned deterministic parser;
- invalid input cannot publish facts;
- facts have stable names and types;
- raw inputs remain available as evidence;
- Pi explains parser and assertion failures;
- restore does not rerun commands or repeat external reads;
- replay reproduces the same normalized facts and state hash;
- Windows, macOS, and Ubuntu CI pass.