---
name: hypagraph
description: Define and execute multi-step coding work as a directed graph with explicit dependencies, typed facts, deterministic gates, evidence, and bounded loop declarations.
---

# Hypagraph

Use Hypagraph when a coding request has dependent steps, risky sequence requirements, typed outcomes, deterministic routing, multiple ready nodes, or an implement-test-repair cycle.

1. Examine enough of the repository to define correct nodes and dependencies.
2. Call `hypagraph_define`. Use stable lowercase IDs. Add explicit dependencies, acceptance criteria, fact contracts, gate conditions, and narrow writable scopes.
3. Call `hypagraph_transition` with `action: "start"` before you work on one ready task node. Use `action: "evaluate"` for a ready gate node.
4. Work only in the contract and scope of the active task node.
5. Use `action: "publish"` to publish declared facts while the attempt is running.
6. Use `action: "submit"` with concrete evidence when the task result is ready. Fact publication stops after submission.
7. Use a separate `action: "verify"` to pass or fail the submitted result. Do not combine submission and verification.
8. If work cannot continue, use `action: "block"` and give a specific reason. Use `action: "cancel"` for an active attempt that must stop.
9. Call `hypagraph_revise` when new information makes the plan incorrect. Preserve completed work and route selections when their contracts did not change.

Do not add an accidental cycle. A deliberate cycle must be a declared loop. The loop nodes must be the same as one strongly connected component. The loop must identify feedback edges. It must have a Boolean `successWhen` predicate and a hard `maxIterations` limit.

Hypagraph validates loop structure but does not execute loop iterations before M4. Do not state that loop execution or `successWhen` evaluation is active.
