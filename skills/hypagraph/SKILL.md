---
name: hypagraph
description: Automatically turn any actionable coding request or existing implementation plan into an executable Hypagraph workflow, then run it with explicit dependencies, typed facts, deterministic gates, evidence, checks, and bounded iteration regions. The user does not need to mention graphs or Hypagraph.
---

# Hypagraph

Use Hypagraph whenever the user asks Pi to perform repository work or supplies a coding plan to execute. Do not wait for the user to ask for a graph, workflow, DAG, gate, loop, or Hypagraph by name.

Treat the user's prose, issue, checklist, or plan as the source intent. Compile it into the smallest correct Hypagraph workflow automatically.

1. Examine enough of the repository to understand the requested result, relevant files, existing checks, and material risks.
2. Infer tasks, dependencies, acceptance criteria, evidence, checks, facts, gates, loop regions, failure policies, and writable scopes from the request and repository.
3. Keep simple work simple. A small request can be one task with one check. Do not add nodes, gates, facts, or loops that the work does not need.
4. Preserve explicit user constraints and plan semantics. Do not invent extra product scope or silently widen writable paths.
5. Ask a question only when product intent, safety, or a destructive choice is materially ambiguous. Do not ask the user to design the graph or select node kinds and edge kinds.
6. Call `hypagraph_define` before execution. Use stable lowercase IDs and explicit contracts. Give the user a short work summary when useful, but do not require graph terminology from them.
7. Call `hypagraph_transition` with `action: "start"` before you work on one ready task node. Use `action: "evaluate"` for a ready gate node.
8. Work only in the contract and scope of the active task node.
9. Use `action: "publish"` to publish declared facts while the attempt is running.
10. Use `action: "submit"` with concrete evidence when the task result is ready. Fact publication stops after submission.
11. Use a separate `action: "verify"` to pass or fail the submitted result. Do not combine submission and verification.
12. Use `hypagraph_run_check` for a ready command-check node. Do not start a check with `hypagraph_transition`.
13. If work cannot continue, use `action: "block"` and give a specific reason. Use `action: "cancel"` for an active attempt that must stop.
14. Call `hypagraph_revise` when new information makes the compiled plan incorrect. Preserve completed work and route selections when their contracts did not change.

Do not add an accidental cycle. A deliberate cycle must be a declared bounded iteration region. For v0.5, the region must have one entry and one evaluation boundary. Its nodes must be the same as one cyclic strongly connected component. Feedback must go from the evaluation node to the entry node. `successWhen` must use the typed condition structure. The loop must have a hard `maxIterations` limit.

Do not assume that a loop is for repair. Use node contracts and facts to define refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, or repair. A loop can be a disconnected graph component. Keep its facts, routes, progress, attempts, and iteration state independent from other regions. Define how loop failure affects the workflow.

Optional progress uses one numeric fact with a minimize or maximize direction. Improvement must exceed `minDelta`; equal values do not improve. Hypagraph records the best metric, best iteration, and no-progress count. Patience can fail the loop with `no_progress`, but a successful evaluator completes first and the hard iteration limit has priority over patience. Missing or invalid progress data fails with `evaluation_error`. Failure policy is `fail-workflow`, `block-dependants`, or `record-and-continue`; omission means `fail-workflow`. A local failure never releases a dependant that requires region success. Unrelated ready work can continue when policy permits.

A failed evaluation check is one valid loop observation. It can continue only when the raw result status is `failed`, normalization succeeded, and all required facts were published. Cancellation, interruption, timeout, executor error, or a failed non-evaluation check does not continue automatically. A check retry stays in the current iteration. A loop continuation creates a new iteration and a new attempt ID. Do not select loop decisions manually.
