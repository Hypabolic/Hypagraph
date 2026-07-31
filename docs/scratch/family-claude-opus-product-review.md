Execution errorary

F0–F5 deliver real product wiring: `hypagoal_create_child` exists, multi-member selection runs in the controller, child return helpers commit into the parent, and status/graph surfaces can show a family. That is more than domain-only M7 helpers. I would not dogfood this as the ordinary default path yet. A model that follows the skill’s flagship recipe authors a default `isolated-pi` parent task, then cannot call create-child from the orchestrator while the worker owns that attempt, and the worker contract forbids defining children. Automated F1–F4 cover the happy path only after tests force `current-session` on the parent. F5 softens the return assertion. Live TUI dogfood remains pending. Treat the program as code-complete for a narrow opt-in parent path, not as a live-verified multi-member product surface.

## Strengths

- **Tool and host commit path are real.** `hypagoal_create_child` is registered, normalizes draft or free-form definition, calls `createBoundedChildGoalInFamily`, syncs live parent events into the family, and returns child id, binding id, and parent wait status.
- **Authority gates match the plan.** Create is blocked before Run, for non-task parents, idle parents, and widened scope. Tool and F1 tests exercise those rejects with clear diagnostics.
- **Completion rule is encoded, not only documented.** Product return leaves the parent task `running` for integration. Child success does not mark the parent succeeded. F3 asserts this.
- **Failure policies on the product path exist for cancel.** F3 drives fail-parent-node and block-parent-node through `agent_end` after a terminal child appears in the family record.
- **Family-aware selection is the default multi-member loop.** `queueGoalContinuation` uses `selectFamilyProductControllerAction`, applies pending returns before selection, and dispatches non-root members via temporary state swap.
- **Status and graph focus are legible.** `/hypagraph status` shows members, bindings, child-wait, budget, focus, and child definition-artifact lines. `/hypagraph graph member <goalId>` focuses a child without merging graphs. F4 covers this.
- **Skill flipped the “unavailable tool” honesty.** Child create is taught as live. Goal contract, encoding table, parent wait rules, and isolated child default are present. README Current status matches the shipped claim set for sequential multi-member work.
- **Program status is mostly honest about live work.** Plan, e2e note, and README mark live TUI dogfood pending and list sequential-only dispatch and F6 as follow-ups.

## Product gaps and risks

### Gap 1 -- Severity: high
- Area: Advertised create-child path vs default isolated parent tasks
- Why it matters for the user: Default model tasks use `isolated-pi`. While an isolated attempt is active, the host blocks `hypagoal_create_child` as a work-mutating tool. The executor contract also states an executor does not define a child goal. The skill flagship recipe tells the model to put `hypagoal_create_child` on a `delegate` task without requiring `executorProfile.kind: "current-session"`. Every F2–F5 extension test that creates a child sets current-session on the parent. A model that follows the skill will start an isolated delegate, then find create-child blocked or unavailable where it was told to call it. The core user story “active parent task creates a child” fails on the default profile.
- Recommendation: Pick one product rule and encode it. Preferred for product clarity: require and document that a parent that may create a child must opt into `current-session`, and put that profile on the flagship recipe and tool guidelines. Alternative: add a controller-mediated create-child protocol that isolated parents can request without a second writer. Add an automated default-profile test that fails until the chosen design works.

### Gap 2 -- Severity: high
- Area: F5 automated dogfood softens the return bar (A12)
- Why it matters for the user: The program acceptance path is root → child → return → parent integrate. The F5 test accepts an active binding or partial wait state when settlement does not complete. That means the suite can pass without proving product return on the extension path that F5 claims to cover. Users and release notes will treat A12 as green while the only automated full-path substitute may stop at create + multi-member.
- Recommendation: Require `binding.status === "returned"`, parent node `running` (not succeeded), and a completed return outcome in F5. Keep create-only coverage in F1. Do not mark A12 complete until the e2e test forces settlement and return.

### Gap 3 -- Severity: high
- Area: Reload and branch change leave child workers uncancelled in family state (A10)
- Why it matters for the user: Recovery aborts processes and cancels orphaned attempts against the live root state only. If the in-flight isolated worker belongs to a child member, the host can tear down the process while the child attempt stays running in the family workflow. The binding remains active. The parent can wait forever after reload. A10 claims membership and wait survive reload; it also requires workers for in-flight members to abort and settle. Today product recovery is root-shaped.
- Recommendation: Store goal and workflow identity on active isolated-attempt bookkeeping. On restore and branch change, cancel the matching member attempt, persist that member stream, then pause. Add an extension test with an active child worker through reload.

### Gap 4 -- Severity: high
- Area: Current-session child continuations become stale after member dispatch
- Why it matters for the user: Non-root dispatch swaps host state to the child, queues a model follow-up while state is the child, then restores the live root in `finally`. Delivery validates the pending continuation against the restored root workflow and rejects it as stale. A child task that opts into `current-session` cannot complete lifecycle tools. Default children use isolated-pi, so the common path may avoid this. Any skill guidance, revise, or test that puts current-session on a child is a hard dead end.
- Recommendation: Keep a durable selected-member execution context through continuation delivery, validation, accounting, and persistence. Or reject current-session on non-root members with a clear product error until that context exists. Do not teach current-session child tasks until delivery works.

### Gap 5 -- Severity: medium
- Area: Family record split-brain when a non-root update uses a stale family snapshot
- Why it matters for the user: Child persistence starts from `selection.family`, which can lag the live root after sibling root work. `replaceFamilyMemberWorkflow` can append a family record that rewrites the parent stream with an older root snapshot. Membership still looks multi-member, but root events and durable family projection disagree. Status and later returns become untrustworthy after ordinary multi-component family runs.
- Recommendation: Merge current live root events and snapshot into the family record before replacing a child workflow. Add a test that advances a root sibling between child create and child persistence, then reloads.

### Gap 6 -- Severity: medium
- Area: Skill honesty is incomplete after the “tool is live” flip
- Why it matters for the user: The skill correctly removed “child create unavailable.” It still presents create-child as the ordinary active-parent-task action after Run. It does not state the parent profile requirement, the worker/orchestrator split that blocks default parents, or that F5 live dogfood is pending. Models will invent illegal revisions (current-session by rewriting `goal`) when the blocked path looks like a product bug. The plan already records one objective-changing revision incident on a family dogfood root.
- Recommendation: Update the skill and tool prompt guidelines with: (1) parent tasks that create children must use current-session until a mediated protocol exists; (2) workers never call create-child; (3) never rewrite the objective for routing; (4) inspect `/hypagraph status` for child-wait and members. Keep free-form flagship recipe in sync with the required profiles.

### Gap 7 -- Severity: medium
- Area: Incomplete product-path failure matrix for A7
- Why it matters for the user: Domain supports `fail-parent-node`, `block-parent-node`, and `return-for-revision`, plus budget limit as a return outcome. F3 covers success resume and cancel under fail and block. It does not cover budget limit or return-for-revision on the extension path. Users who choose those policies have skill guidance without product-path proof.
- Recommendation: Add extension tests for budget-limited and return-for-revision outcomes through `applyPendingChildReturns`. Surface the parent effect in the notify string so operators can see policy application.

### Gap 8 -- Severity: medium
- Area: Live interactive dogfood is still the missing trust bar
- Why it matters for the user: Plan status says F0–F5 product path shipped. Live TUI is explicitly allowed to stay pending. Automated harnesses use headless hosts, forced current-session parents, and fake isolated transport. That is necessary engineering evidence, not user evidence. The product claim “ordinary Pi path is a goal family” is not live-proven.
- Recommendation: Run the script in § Recommended dogfood script below. Record results in `docs/scratch/family-product-dogfood.md`. Do not treat family product surface as release-ready until one live pass covers create, status, child worker, return, and optional reload.

### Gap 9 -- Severity: low
- Area: Sequential multi-member dispatch only
- Why it matters for the user: Independent root components can still be selected while a parent waits, but the controller dispatches one member action at a time. README and plan already disclose this. Users who expect concurrent child and sibling workers will wait longer than the architecture story suggests.
- Recommendation: Keep sequential as the shipped product rule. Show active member and wait state clearly in status. Treat concurrent multi-pending dispatch as a later program, not a silent expectation.

### Gap 10 -- Severity: low
- Area: Flagship recipe still under-specifies child verification and fact publish
- Why it matters for the user: The skill child shape is “implement task plus optional check.” Return requires declared output facts in the child fact store. If the child task does not publish required facts before terminal success, return fails after work looked done. Models may mark child tasks complete without binding contracts.
- Recommendation: Make the flagship child recipe require a check or explicit publish/verify that produces the binding’s output facts. Teach “no required fact means no successful return.”

## Recommended dogfood script

1. Before any create, confirm isolated Pi can spawn (`/hypagraph executor status`, `PI_BIN` if needed).
2. Author a root with two tasks: `delegate` with `executorProfile.kind: "current-session"` and scope `src/**`, plus `integrate` that requires `delegate`. Do not use default isolated-pi on the parent that will create the child until Gap 1 is fixed.
3. Create with `hypagoal_start`. On the post-create dock, inspect Mermaid, then choose **Run**.
4. When `delegate` is active in the orchestrator, call `hypagoal_create_child` with a child definition whose first task is default `isolated-pi`, narrower scope, and required `outputFacts`.
5. Run `/hypagraph status`. Confirm two members, active binding, child-wait on `delegate`, and child definition-artifact line.
6. Confirm the orchestrator does not implement the child body. Confirm a child worker start notify or executor status for the child task.
7. When the child completes, confirm status shows returned binding, parent `delegate` is `running` (not succeeded), and `integrate` remains blocked until parent integration work finishes.
8. Complete parent integration and any release check. Confirm root terminal state is workflow-derived.
9. Optional stress: mid child-wait, reload the session. Confirm membership and wait survive, and that no child attempt is stuck running without a worker. Resume only after review.
10. Optional: `/hypagraph graph member <childGoalId>` focuses the child graph without merging nodes into the root.
11. Negative checks in a second session: create-child before Run must fail; create-child from a check must fail; widened scope must fail.
12. Record pass or fail under `docs/scratch/family-product-dogfood.md`.

## Relation to technical review

I agree with the Codex Terra high-severity ship blockers on product trust grounds.

- Unreachable default create-child path (isolated parent vs tool/worker rules) is a product honesty failure, not only an implementation bug.
- Soft F5 return assertion weakens the only automated substitute for live dogfood.
- Child-worker recovery that cancels against root state breaks A10 for real multi-member sessions.
- Stale current-session child continuations make an advertised opt-in profile unusable on children.
- Family split-brain is a durability trust issue once siblings run under family dispatch.

I do not treat sequential-only dispatch as a ship blocker. The docs already disclose it. I do treat “F0–F5 product path shipped” as overstated for ordinary model use until Gap 1 is fixed in product design and skill text, and until F5 requires a real return. Domain and host wiring for the narrow current-session-parent path look real; the default journey the skill teaches does not yet deserve user trust.
