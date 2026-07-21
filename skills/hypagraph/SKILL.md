---
name: hypagraph
description: Define and execute multi-step coding work as a directed graph with explicit dependencies, evidence, and bounded loop declarations.
---

# Hypagraph

Use Hypagraph when a coding request has dependent steps, risky sequence requirements, multiple ready nodes, or an implement-test-repair cycle.

1. Examine enough of the repository to define correct nodes and dependencies.
2. Call `hypagraph_define`. Use stable lowercase IDs. Add explicit dependencies, acceptance criteria, and narrow writable scopes.
3. Call `hypagraph_transition` with `action: "start"` before you work on one ready node.
4. Work only in the contract and scope of the active node.
5. Call `hypagraph_transition` with `action: "complete"` and concrete evidence. If work cannot continue, use `action: "block"` and give a specific reason.
6. Call `hypagraph_revise` when new information makes the plan incorrect. Preserve completed work when its contract did not change.

Do not add an accidental cycle. A deliberate cycle must be a declared loop. The loop nodes must be the same as one strongly connected component. The loop must identify feedback edges. It must have a Boolean `successWhen` predicate and a hard `maxIterations` limit.

M0 validates loop structure. M0 does not execute loop iterations and does not evaluate `successWhen`. Do not state that these controls are active.
