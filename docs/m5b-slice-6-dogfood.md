# M5B Slice 6 dogfood evidence

- Date: 2026-07-24
- Slice: M5B Slice 6, blockage and bounded revision
- Pull request: pending
- Verification run: pending
- Test result: pending

## 1. Scenario

The realistic Pi smoke starts one prose Hypagoal for a repository migration.

The graph first completes an independent inventory task. The implementation task then discovers one missing bounded schema-normalization step and enters a typed `repository-work` blocked state.

No unrelated root action remains runnable. The controller classifies the blocker as revisable and stores one automatic revision request.

## 2. State-bound revision

The request records:

- goal and workflow identity;
- workflow revision and sequence;
- snapshot hash;
- blocker kind and identity;
- session and branch generation;
- operation ID;
- request sequence.

The delivered turn exposes only `hypagraph_read` and `hypagoal_submit_revision`.

The prompt states the exact objective, the canonical blocker, the permitted scope, the one-attempt rule, and the immutable safeguards.

## 3. Accepted proposal

The replacement definition preserves the exact objective. It adds `normalize-schema` before the blocked implementation task. It does not delete acceptance requirements or completed work.

The controller applies the proposal through the existing `revise` command. The event order includes:

1. `hypagraph.goal.revision-requested`;
2. `hypagraph.goal.continuation-requested`;
3. `hypagraph.workflow.revised`;
4. existing node invalidation and readiness events;
5. `hypagraph.goal.revision-applied`;
6. `hypagraph.goal.resumed`;
7. `hypagraph.goal.turn-recorded`.

The completed inventory task and its attempt history remain valid. The changed blocked path is invalidated through the existing reducer. Execution resumes through the normal root selector and completes through canonical workflow state.

## 4. Negative proposal

A second smoke changes the exact objective.

The reducer rejects the proposal with `automatic_revision_objective_changed`. The request already consumed the single allowance. The workflow remains blocked. The controller does not request another automatic revision.

Malformed, interrupted, stale, no-op, unsafe, and still-blocked proposals use the same consumed allowance.

## 5. Safety coverage

Focused tests cover:

- deterministic blocker classification;
- typed repository, external, safeguard, loop, legacy, and no-path outcomes;
- no revision while unrelated work is runnable;
- no revision for pause, budget, failure, cancellation, or terminal bounded policies;
- one durable automatic allowance;
- exact objective preservation;
- acceptance, evidence, enforcement, check, gate, evaluator, loop, and budget non-weakening;
- active-attempt rejection;
- stale proposal rejection;
- existing revision, invalidation, readiness, and stale-result semantics;
- independent completed-state retention;
- exactly-once turn and token accounting;
- replay and restore without dispatch.

## 6. Architecture review

The implementation adds no second workflow, revision engine, scheduler, completion path, executor, subagent, worktree, child goal, family state, or physical concurrency.

The existing workflow revision reducer remains authoritative for definition validation, revision events, invalidation, readiness, stale-result rejection, and workflow outcome.

## 7. Result

The executable smoke proves one bounded blocked-to-revised-to-completed path and one weakening-proposal exhaustion path. Final CI identifiers and exact test counts are recorded during the Slice 6 planning closeout.
