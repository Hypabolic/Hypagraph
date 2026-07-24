# M5B Slice 6 dogfood evidence

- Date: 2026-07-24
- Slice: M5B Slice 6, blockage and bounded revision
- Implementation commit: `bfd9014d238938a193960977828f8fe9d9393741`
- Pull request: #73
- Verification run: CI #1012
- Test result: 93 test files and 441 tests passing

## 1. Scenario

The realistic Pi smoke starts one prose Hypagoal for a repository migration.

The graph first completes an independent repository-inventory task. The implementation task then discovers one missing bounded schema-normalization step and enters a typed `repository-work` blocked state.

No unrelated root action remains runnable. The controller classifies the blocker as revisable and stores one automatic revision request.

The smoke sends no manual continuation prompt after Hypagoal creation.

## 2. Deterministic blocker classification

Focused tests prove classification for:

- a typed blocked repository-work node;
- an unrepresentable external dependency;
- a safeguard blocker;
- an interrupted blocked loop;
- a recoverable `block-dependants` loop evaluation error;
- restored legacy loop predicates which require typed replacement;
- a malformed definition with no executable path;
- terminal loop limits, patience, invalid-evaluation exhaustion, and evaluation-budget exhaustion.

A recoverable failed loop is classified before its derived blocked dependant. A loop with `requires_revision`, blocked, failed, or completed runtime state cannot leak a ready internal node into the root work selector.

The controller does not request revision while an unrelated root component is runnable, while any active attempt or check remains unsafe, after workflow failure or cancellation, during a pause, or after goal turn or token budget exhaustion.

## 3. State-bound revision request

The request records:

- goal ID;
- workflow ID;
- workflow revision;
- workflow sequence;
- snapshot hash;
- blocker classification and identity;
- session generation;
- branch generation;
- operation ID;
- continuation ordinal;
- request sequence.

Any relevant change makes the proposal stale. A stale delivered proposal cannot mutate current workflow state and still exhausts the consumed automatic allowance.

The delivered revision turn exposes only `hypagraph_read` and `hypagoal_submit_revision` in addition to the existing tool set needed by Pi control.

The revision prompt states:

- the exact objective;
- the canonical blocker;
- the allowed bounded repository-work scope;
- the one-attempt rule;
- the safeguards which must remain unchanged;
- that the model cannot mark the goal complete;
- that the canonical reducer validates the replacement definition;
- that unchanged valid completed work should remain unchanged where possible.

Protected evaluator commands, paths, reports, hashes, stdout, stderr, and holdout details do not enter the revision guidance.

## 4. Accepted revision path

The replacement definition preserves the objective byte-for-byte. It adds `normalize-schema` before the blocked implementation task. It does not delete acceptance requirements, checks, evidence, gates, or completed work.

The controller applies the proposal through the existing `revise` command. The event order includes:

1. `hypagraph.goal.revision-requested`;
2. `hypagraph.goal.continuation-requested`;
3. `hypagraph.workflow.revised`;
4. existing loop and node invalidation events;
5. existing readiness events;
6. `hypagraph.goal.revision-applied`;
7. `hypagraph.goal.resumed`;
8. `hypagraph.goal.turn-recorded`.

The completed inventory task and its attempt history remain valid. The changed blocked path and its dependants invalidate through the existing reducer. Independent component state remains isolated.

A pre-revision result using old attempt identity is rejected and cannot mutate the revised graph.

The normal root selector resumes the revised graph automatically. The smoke completes only through canonical typed workflow state.

The accepted smoke records three substantive turns and 36 normalized tokens without duplicate charging.

## 5. One consumed automatic attempt

The automatic allowance is consumed when the durable revision turn is requested. It is separate from:

- substantive goal turns;
- goal token usage;
- loop iterations;
- patience;
- invalid-evaluation limits;
- evaluation-attempt budgets;
- check retries.

Focused domain and Pi tests prove that the single allowance is still consumed by:

- a malformed proposal;
- a rejected proposal;
- a stale proposal;
- an interrupted delivered turn;
- a no-op proposal;
- a proposal which leaves no runnable path;
- a proposal which changes the objective;
- a proposal which weakens safeguards.

An interrupted delivered revision turn records `revision_turn_interrupted` and is charged exactly once through the existing Slice 4 usage path. A queued but undelivered continuation which loses priority is abandoned without charging a model turn.

No rejected or abandoned path requests a second automatic revision.

## 6. Exact objective and non-weakening validation

The reducer compares `HypagraphDefinition.goal` before Pi definition normalization can trim or rewrite it. Whitespace-only mutation is rejected.

The policy rejects automatic changes which:

- remove or alter typed loop success;
- change loop failure policy;
- raise iteration, patience, invalid-evaluation, or evaluation-attempt limits;
- remove or alter progress or validity contracts;
- raise or remove evaluation budgets;
- remove or alter checks or evaluator trust and integrity;
- remove or alter gates;
- remove acceptance requirements;
- remove fact contracts;
- remove required dependencies;
- broaden repository scope;
- disable required evidence;
- weaken strict enforcement;
- delete existing nodes or loops;
- add model-owned goal budgets or outcome fields;
- add a new gate which makes existing required work optional;
- revise while retained active attempt history remains unsafe.

A safe additive bounded repository step remains valid.

The model has no command or proposal field which can mark a node, workflow, or goal complete.

## 7. Replay, restore, reload, and branch safety

Replay reproduces:

- consumed automatic-revision count;
- blocker identity;
- request identity;
- accepted, rejected, or abandoned outcome;
- revised workflow state;
- goal turn and token usage.

Restore queues no revision work, starts no check or evaluator, and consumes no turn.

A reload or branch change while a revision continuation is pending atomically:

1. abandons the pending revision continuation;
2. records revision exhaustion;
3. pauses the goal with `session_reload` or `branch_change` cause;
4. dispatches no model work.

Explicit review and resume are required after reload or branch change.

## 8. Architecture review

The implementation adds no:

- second workflow model;
- second graph-revision engine;
- second scheduler;
- prose-only replanning state machine;
- model-owned completion path;
- child Hypagoal or family state;
- executor or subagent;
- worktree;
- physical concurrency;
- restore-time semantic dispatch.

The existing workflow revision reducer remains authoritative for definition validation, revision events, node and loop invalidation, readiness, stale-result rejection, workflow outcome, and goal completion.

The Slice 3 selector remains the only root-work selector. Revision is one controller action selected only when no normal runnable root action remains.

## 9. Validation result

CI #1012 passes on:

- Ubuntu with Node.js 22 and 24;
- macOS with Node.js 22 and 24;
- Windows with Node.js 22 and 24.

The complete suite contains 93 test files and 441 tests.

The executable evidence proves one bounded blocked-to-revised-to-completed path and negative paths in which invalid, weakening, stale, interrupted, no-op, and still-blocked proposals consume the single allowance without another automatic revision.

No v0.6 tag or release was created during Slice 6.
