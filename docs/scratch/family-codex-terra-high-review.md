## Summary

Overall risk is high. The multi-member path has unrecoverable child-worker and current-session routing failures, plus a family-record split-brain path. The code is not ready to ship, even with live dogfood excluded.

## Issues

### Issue 1 -- Severity: bug
- File: src/extension.ts:2227
- Description: A child with `executorProfile.kind: "current-session"` cannot complete its continuation. The controller creates the continuation while `state` is the child, then restores `state` to the root. Delivery validates the pending continuation against the root workflow and rejects it as stale. The task cannot use lifecycle tools after that.
- Suggestion: Keep a durable selected-member execution context through continuation delivery, and route lifecycle tools, validation, accounting, and persistence to that member workflow.
- Status: open

### Issue 2 -- Severity: bug
- File: src/extension.ts:907
- Description: Reload and branch-change recovery only cancels the live root workflow. If the active isolated worker belongs to a child, the host tears down its process but builds cancellation commands against the restored root state. The child attempt stays running in its family workflow, so its binding remains active and the parent can wait forever.
- Suggestion: Store goal and workflow identity in active isolated-attempt bookkeeping. On recovery, load the family record and cancel the matching member attempt before the root pause.
- Status: open

### Issue 3 -- Severity: bug
- File: src/extension.ts:2208
- Description: A non-root member update starts from `selection.family`, which can contain an older root snapshot. If an unrelated root component changes before child persistence, `replaceFamilyMemberWorkflow` appends a new family record with the stale root stream and overwrites the newer family projection. This creates split-brain between root events and the durable family record.
- Suggestion: Merge the current live root events and snapshot into the selected family record before replacing and appending a child workflow. Add a reload test that runs a root sibling between child create and child persistence.
- Status: open

### Issue 4 -- Severity: bug
- File: src/extension.ts:2871
- Description: The advertised create-child path is unavailable from a default isolated parent task. The worker contract forbids workers from defining child goals, while the host blocks `hypagoal_create_child` during the isolated attempt. The F5 test works only by explicitly setting the parent to `current-session`, but the skill does not require that opt-in for a delegate task.
- Suggestion: Add a controller-mediated child-create request protocol for isolated parents, or require and document a `current-session` parent task for child creation. Add an automated default-profile test for the chosen design.
- Status: open

### Issue 5 -- Severity: suggestion
- File: tests/family-product-f5-e2e-extension.test.ts:283
- Description: The e2e test accepts an active child binding instead of requiring child settlement and parent return. It therefore permits the main A12 path to fail. Focused tests also omit product-path budget-limit and `return-for-revision` cases, and do not test restore during an active child worker.
- Suggestion: Require `binding.status === "returned"` in F5. Add extension tests for failed, cancelled, and budget-limited child outcomes under all declared policies, plus reload and branch-change recovery with an active child worker.
- Status: open
