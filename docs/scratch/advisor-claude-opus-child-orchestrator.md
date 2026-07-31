## Recommendation

Your model is correct. A child Hypagoal should own its subgraph — its node set, node contracts, acceptance criteria, internal ordering, context envelopes, local retry, and revision of its own workflow. What the child must not get is a second **dispatcher**. The confusion comes from the word "orchestrator" doing double duty in the current vocabulary: it means both the main Pi **session** (a process/UI surface) and the family **controller** (the scheduler that commits events and draws budgets). Your intuition is about ownership of graph content. The architecture rule is about dispatch authority. Split them and the conflict disappears.

## Layer model

| Layer | Who decides what | Who must NOT decide |
|---|---|---|
| **Family controller** | Selects the next runnable action across all members. Commits events. Draws budget. Grants workspace leases. Serialises integration. Enforces replay ordering. | No member, worker, or model tool may bypass it. |
| **Hypagoal (child or root)** | Owns one workflow: its node set, intra-graph ordering, acceptance criteria, context envelopes for its workers, revision of its own graph, scope, local evidence contracts. The child is the **authority on what its work is and what good looks like**. | Does not dispatch its own work. Does not draw budget without the family controller. Does not grant its own workspace lease. |
| **Worker (node executor)** | Executes one selected attempt. Returns a structured result. Makes local implementation decisions within the node contract and scope. | Must not create children, dispatch siblings, mutate canonical state, or define new goals. |

The discriminating test: anything **shared, finite, or globally ordered** needs exactly one owner — budget, leases, integration order, event commit sequence, replay. Anything **local to one workflow** has no such constraint and belongs to the goal that owns it.

## When to use one graph vs child goal

Use a child Hypagoal when at least one of these is true:

1. The subgoal needs **its own failure boundary** — failure applies a declared policy rather than failing the whole parent graph.
2. The subgoal needs **its own budget envelope** — a reservation from the family pool.
3. The subgoal needs a **narrower scope** or a separate worktree-backed attempt.
4. The subgoal needs a **typed return contract** — output facts and evidence validated at the boundary.

Do not use a child merely because the work is large. Size alone produces family sprawl and coordination overhead. A large subgoal with shared ownership and budget is better as same-graph nodes or an independent component. If the only reason is "it would be clearer as a separate graph," that is a weak signal and usually wrong.

Default bias stays: same-graph nodes. Disconnected components for independent lifecycles. `hypagraph_revise` for mid-run discovery. Child Hypagoal only when one of the four triggers above fires.

## Create-child authority

Only an **active parent task** may create a child. Not a check. Not a gate. Not a loop evaluation. Not a worker.

The reason is structural, not policy: the thing that creates the work must be the thing that can **wait for it and integrate the result**. A task can enter `waiting_for_child` and later resume for integration. A check cannot wait. A gate cannot integrate. A worker creating children is model-as-scheduler — which is the exact Grok Build property your architecture explicitly refuses to borrow.

Workers must not create children because that would let the model decide family membership at execution time without controller validation of bounds, budget, scope, and depth. Child creation is a family-level atomic operation. It belongs to the controller path, triggered by the model tool surface from an active parent task.

## UX surface

The most likely reason your intuition fires — "main is orchestrating every implement turn in the child" — is not scheduling authority. It is **attribution**. Architecturally, the child's model tasks already run in isolated workers, not in the main session. But everything surfaces in one chat, so the work looks unattributed. The fix is surface, not architecture.

What the user should see:

1. **Family desk** — the root-level view. Shows all members, their status, active bindings, who is waiting for whom, family budget draw. This is `/hypagraph status` today.
2. **Member focus** — drill into any Hypagoal's own graph. Shows that member's nodes, attempts, workers, loop progress, and evidence. Each attempt attributed to member + node + executor kind. This is the graph pane member focus (A9 in the product surface plan).
3. **Worker attribution** — when a worker runs for a child node, status and graph pane must show that the worker belongs to the child, not to the root. If everything shows as "root attempt," the user cannot tell who owns what.
4. **Interaction routing** — see open decision below. The current rule is that interaction questions present on the orchestrator session. Whether child-raised interactions should route to the same orchestrator dock or to a child-scoped surface is a genuine product call.

The existing product surface plan already specifies member focus (A9) and multi-member status (A8). The gap is likely attribution fidelity and default focus, not missing capability.

## Risks of the wrong model

### Two schedulers (child is a full second orchestrator)

- **Budget double-spend.** Two dispatchers drawing from the same family pool without coordination.
- **Lease deadlock.** Two schedulers granting workspace leases that conflict.
- **Priority inversion.** Child work starves the root's ready checks or gates because the child scheduler does not see family-wide priorities.
- **Unreplayable selection.** Two independent schedulers produce non-deterministic interleaving. Replay cannot reproduce the same historical choice.
- **Orphaned children on parent cancel.** If the child owns its own dispatch, parent cancellation must reach into an independent scheduler to tear it down, creating a coordination protocol that does not exist today.

### One desk always drives (too centralised)

- **Child starvation.** If the family controller must actively choose every child action, a busy root can delay child work even when child nodes are ready and independent.
- **Thin context envelopes.** If the controller builds all context, it may lack child-local understanding and produce weaker envelopes for child workers.
- **Parent as latency bottleneck.** Sequential family dispatch means child work waits for the root's current action to settle before the scheduler looks at the child again.
- **Attribution problem.** All work appears driven by the root, making the family structure invisible to the user (the problem you observed).

The first set of risks is structural and hard to fix. The second set is mitigable: concurrent family dispatch (already in M8), richer context envelopes, and better surface attribution.

## Hypagraph-specific advice

1. **Keep one controller per family.** The child owns its graph content. The controller owns dispatch, budget, leases, and event commit. Do not split the controller.
2. **Attribute work to the member, not the root.** Every status line, graph node, and worker record should show which Hypagoal owns it. This is the primary fix for the user's intuition.
3. **Default member focus after child create.** When a child is created and starts work, the graph pane should focus the child's graph by default. The user can navigate up to root or family view.
4. **Do not demote "child is a workflow aggregate" to "child is just more nodes."** The child's graph content, acceptance criteria, and revision authority belong to the child. The skill and UI should present the child as a first-class goal with its own contract, not as a sub-region of the parent graph.
5. **Keep the four triggers for child creation explicit.** Do not let "large enough" become a trigger. Failure boundary, budget envelope, scope narrowing, and typed return contract are the reasons. Document them as the decision test.
6. **Do not let workers create children.** Model-as-scheduler through worker-initiated family mutation is the single most dangerous relaxation. It breaks budget, replay, and cancellation guarantees simultaneously.
7. **Surface child budget draw against the family pool.** If the user cannot see how much of the root budget the child has consumed, they cannot make informed decisions about continuation or cancellation.

## Dissent / open decisions

1. **Interaction routing.** The architecture says interaction questions present on the orchestrator session. The user's model says the child should handle its own interactions. Both have merit. Orchestrator-routed interaction keeps the user in one place and prevents workers from stalling on ask-user tools. Child-scoped interaction respects the child's authority over its own workflow and avoids cluttering the root session with child-internal questions. This is a real product call that should not be resolved silently in either direction. It probably needs a concrete UX prototype to decide.

2. **Child budget: hard reservation or soft draw?** Current docs say "child allocation reserves or consumes part of [the root family] budget." Whether that reservation is hard (child gets exactly N tokens, no more, even if the root has surplus) or soft (child draws from the shared pool with a cap) changes failure modes. Hard reservation wastes budget on early-finishing children. Soft draw risks child exhaustion when siblings compete. The default should probably be soft draw with a cap, but the product should decide explicitly.

3. **Child revision authority.** Can a child revise its own graph, or must the parent (or orchestrator) revise it? If the child owns its graph content, it should be able to revise within its scope and budget. But automatic revision from a child worker means the model is changing graph structure during execution, which the current architecture allows only through the controller path. This needs a clear rule before the child product path is complete.
eturn + parent integration or a new binding.
6. **Parent wait ≠ family pause.** UI and skill must say unrelated runnable work continues.
7. **Child success never auto-completes the parent task.** Integration is an explicit parent step. This is both domain truth and good UX.
8. **Prefer child goals for new objectives; prefer workers for one step; prefer same-graph structure when the plan is still one map.** Put this decision tree in the skill.
9. **Status and graph focus are the primary UX,** not a second chat product. Nested session is optional continuity, not canonical state.
10. **Skill guidance for the model:** when you create a child, hand off detail work to that child’s plan and workers; stay on family-level decisions, parent integration, and human communication. Do not re-plan the child’s internals from the root unless the return failed or the human refocused the desk.

## Dissent / open decisions

1. **May an isolated worker on a parent task call create-child directly, or only propose for main/controller confirmation?** Domain can allow either; product policy for trust vs speed is still a call (recommend: allow under bounds for autonomous dogfood; optional confirm mode for high-stakes).
2. **Does each child get a durable “plan owner” session, or only per-node workers plus family desk?** Continuity vs cost vs recovery. Recommend: workers by default; optional goal-scoped session when depth of planning is high—not required for v1 product path.
3. **How much child activity streams into the main chat by default?** Full stream (noisy), summaries only (calm), or on-focus only. Recommend: compact family events always; full stream when the user focuses that member.
4. **Human-only create-child vs model-initiated.** Recommend model-initiated from parent task with human visibility and cancel; human-only is a policy toggle, not the default for agent coding.
5. **Whether “goal plan owner” is a distinct role agent or just the sum of goal-scoped tools + workers.** Product can ship without a named second agent if tools and focus UX make goal-local planning clear. Naming a role helps skill clarity; it is optional in runtime.
6. **Depth of nested UX chrome** (one level vs deep tree). Recommend first-class parent/child; deeper descendants as tree in status, focus one at a time.

---

**Bottom line:** The user is right about product and UX. A child Hypagoal must own the plan and work surface of its subgraph. Main owns the family, not every implement turn inside the child. The product must still keep a single family control plane. Agency is nested; authority to schedule and commit is not.
