# M5B Slice 2 atomic Hypagoal creation dogfood

- Status: complete
- Dogfood date: 2026-07-24
- Executable evidence: `tests/hypagoal-pi.test.ts` and `tests/hypagoal-creation.test.ts`
- Implementation pull request: #65
- Tracking issue: #25
- CI run: #722
- Test result: 83 test files and 333 tests
- Matrix: Ubuntu, macOS, and Windows with Node.js 22 and 24

## 1. Purpose

This record proves the M5B Slice 2 root-creation path through the real Pi extension command and tool registrations, the canonical reducer and projection, the Pi session event store, replay, and restore.

The smoke scenario starts from an ordinary prose objective. It exercises `/hypagoal`, the repository-aware authoring contract, `hypagoal_start`, one atomic event append, Pi output, and restore. It does not start workflow execution after creation.

## 2. Prose objective

The Pi-level smoke uses this objective:

```text
Add an inspect command that reports the current workflow without starting execution.
```

The user does not describe nodes, edges, checks, gates, loops, metrics, or lifecycle state.

## 3. Authoring contract proved

The `/hypagoal` command starts a read-only authoring turn that requires the model to:

1. preserve the exact prose objective;
2. inspect relevant repository files, documentation, package scripts, and implementation;
3. compile the smallest useful canonical workflow;
4. add typed tasks, checks, gates, or bounded iteration only when repository evidence justifies them;
5. keep independent top-level components independent;
6. omit numeric progress when no defensible deterministic metric exists;
7. keep authoring advisories separate from canonical definition fields;
8. call `hypagoal_start` once as the final action.

The extension blocks semantic file writes during this authoring turn. It also binds the authoring turn to an explicit creation-operation identity plus the current session and branch generations. A stale authoring request is rejected without persistence.

## 4. Atomic creation path proved

The smoke submits a repository-compatible task and command-check workflow through `hypagoal_start`.

The persisted batch contains, in order:

```text
hypagraph.workflow.defined
hypagraph.node.ready
hypagraph.goal.started
```

The path proves:

1. the exact prose objective replaces any model-supplied `definition.goal` text;
2. the workflow and workflow-local goal use explicit IDs;
3. the creation operation and event correlation are exposed explicitly;
4. the initial ready task is included in the same event batch;
5. one Pi session append stores the full creation result;
6. the goal-control state is `active`;
7. the command check remains pending and does not run;
8. the tool result terminates the authoring turn;
9. no continuation, executor, subagent, or model follow-up is queued;
10. replay reproduces the same workflow, goal lifecycle, event sequence, and snapshot hash;
11. restore rebuilds the same canonical state without starting work.

## 5. Replacement path proved

The tests prove that an existing root returns a typed replacement-required result containing the current:

- objective;
- workflow ID;
- goal ID;
- workflow revision;
- event sequence;
- snapshot hash;
- session generation;
- branch generation.

Replacement succeeds only when confirmation matches the exact current root. Confirmation bound to an older sequence, hash, revision, session generation, or branch generation is rejected. A failed append leaves the original root unchanged.

The legacy `hypagraph_define` surface cannot silently replace an active root. Explicit root replacement remains on `/hypagoal` and `hypagoal_start`.

The one-root restriction remains in the Pi product boundary. The workflow event-store test persists two independent workflow-local goals to prove that the domain does not encode a permanent one-workflow-per-session invariant.

## 6. Failure and information-exposure result

The tests prove that invalid graph output, invalid goal identity, workflow mismatch, sequence conflict, branch conflict, stale creation identity, snapshot mismatch, and restore mismatch expose no candidate state.

The model-facing schema contains no field that can set the goal to completed, failed, cancelled, blocked, or paused. Goal completion and failure remain derived from canonical workflow state.

Successful Pi output separates:

- the human-readable objective;
- workflow identity and revision;
- goal identity;
- `goalControl` lifecycle state;
- ready tasks, checks, gates, and loop entries;
- authoring advisories;
- creation operation and event correlation identity;
- the explicit statement that autonomous continuation has not started.

## 7. CI evidence

CI #722 passed:

- Ubuntu with Node.js 22;
- Ubuntu with Node.js 24;
- macOS with Node.js 22;
- macOS with Node.js 24;
- Windows with Node.js 22;
- Windows with Node.js 24.

The complete suite passed:

```text
Test Files  83 passed (83)
Tests       333 passed (333)
```

## 8. Slice decision

The implementation satisfies the Slice 2 creation boundary:

- one root goal owns one canonical workflow;
- creation is atomic and replayable;
- the Slice 1 goal lifecycle remains canonical;
- replacement is explicit and stale-safe;
- the authoring operation is bound to the exact objective and active Pi session/branch generation;
- restore is side-effect free;
- creation does not continue execution;
- no goal-family, child-goal, scheduler, executor, subagent, worktree, or concurrency implementation was added.

M5B Slice 3 can now add graph-aware continuation over the existing root goal and workflow identities.
