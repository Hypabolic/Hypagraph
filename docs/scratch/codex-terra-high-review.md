## Summary

The uncommitted product-surface code has high lifecycle and isolation risk. It is not ready to ship as code: restart, shutdown, authoring isolation, and project-store commit paths can violate stated product guarantees.

## Issues

### Issue 1 -- Severity: bug
- File: src/extension.ts:1943
- Description: The ambient `HYPAGRAPH_LEGACY_CURRENT_SESSION=1` environment variable changes production default routing to `current-session`. This bypasses the required explicit node-level opt-in and can cause the orchestrator to execute task work.
- Suggestion: Remove the runtime environment override. Inject legacy routing only through test harness configuration.
- Status: open

### Issue 2 -- Severity: bug
- File: src/extension.ts:700
- Description: Session restore clears the post-create gate. A user can choose Question, restart or change branch, then trigger an agent turn; the active ready goal can auto-continue without Run or `/hypagraph resume`.
- Suggestion: Persist the deferred post-create decision with the goal, or restore a durable paused/deferred state. Add reload and branch-change tests after Question.
- Status: open

### Issue 3 -- Severity: bug
- File: src/extension.ts:2012
- Description: Session shutdown clears the in-memory isolated attempt and terminates processes without durable cancellation or a generation invalidation. The in-flight dispatch can append after shutdown, or a later restore can see a running attempt with no recorded worker ownership.
- Suggestion: Settle or cancel the tracked attempt before shutdown completes, and invalidate the dispatch generation before teardown. Test shutdown during an active root worker followed by restore.
- Status: open

### Issue 4 -- Severity: bug
- File: src/extension.ts:2350
- Description: During read-only authoring, only `write` and `edit` are blocked. `bash` remains available even though the authoring prompt and plan prohibit repository implementation work. The post-create and worker gates already recognize and block `bash`.
- Suggestion: Block `bash` and any other repository-mutating tool during authoring. Add a tool-call gate test.
- Status: open

### Issue 5 -- Severity: bug
- File: src/extension.ts:2509
- Description: Runtime creation commits before project-store artifacts, and all project-store failures are silently ignored. This directly permits a live root without its required committed definition artifact, contrary to the project-store commit protocol.
- Suggestion: Use a recoverable host-level commit protocol that stages the artifact before activation, or explicitly compensates on either failure. Return a visible failure when consistency cannot be established.
- Status: open

### Issue 6 -- Severity: bug
- File: src/project-store/store.ts:152
- Description: Current-version malformed index records are accepted and normalized to empty arrays. For example, `{ "schemaVersion": 1, "drafts": "bad" }` silently becomes an empty index and can later overwrite discoverability data.
- Suggestion: Validate full record shapes for index, settings, workflow metadata, history, and drafts. Reject malformed current-version records as `project_store_corrupt`; add restoration tests for them.
- Status: open