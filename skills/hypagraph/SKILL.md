---
name: hypagraph
description: Define and execute multi-step coding work as a directed graph with explicit dependencies, typed facts, deterministic gates, evidence, checks, and bounded loops.
---

# Hypagraph

Use Hypagraph when a coding request has dependent steps, risky sequence requirements, typed outcomes, deterministic routing, multiple ready nodes, or an implement-test-repair cycle.

1. Examine enough of the repository to define correct nodes and dependencies.
2. Call `hypagraph_define`. Use stable lowercase IDs. Add explicit dependencies, acceptance criteria, fact contracts, typed gate and loop conditions, and narrow writable scopes.
3. Call `hypagraph_transition` with `action: "start"` before you work on one ready task node. Use `action: "evaluate"` for a ready gate node.
4. Work only in the contract and scope of the active task node.
5. Use `action: "publish"` to publish declared facts while the attempt is running.
6. Use `action: "submit"` with concrete evidence when the task result is ready. Fact publication stops after submission.
7. Use a separate `action: "verify"` to pass or fail the submitted result. Do not combine submission and verification.
8. Use `hypagraph_run_check` for a ready command-check node. Do not start a check with `hypagraph_transition`.
9. If work cannot continue, use `action: "block"` and give a specific reason. Use `action: "cancel"` for an active attempt that must stop.
10. Call `hypagraph_revise` when new information makes the plan incorrect. Preserve completed work and route selections when their contracts did not change.

Do not add an accidental cycle. A deliberate cycle must be a declared loop. For v0.5, the loop must be a structured single-entry and single-exit region. Its nodes must be the same as one cyclic strongly connected component. Feedback must go from the evaluation node to the entry node. `successWhen` must use the typed condition structure. The loop must have a hard `maxIterations` limit.

M4 Slices 1 to 4 execute bounded task-based and command-check repair loops across isolated iterations. A failed evaluation check can continue the loop only when the raw result status is `failed`, normalization succeeded, and all required facts were published. Cancellation, interruption, timeout, executor error, or a failed non-evaluation check does not continue automatically. A check retry stays in the current iteration. A loop continuation creates a new iteration and a new attempt ID. Do not select a feedback route manually. The final unsuccessful iteration records `max_iterations`, fails the loop, and fails the workflow. Patience is not active yet.
