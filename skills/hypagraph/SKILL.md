---
name: hypagraph
description: Define and execute multi-step coding work as an enforced directed graph with explicit dependencies, evidence, and bounded loop declarations.
---

# Hypagraph

Use Hypagraph when a coding request has multiple dependent steps, risky sequencing, parallel-ready work, or an implement/check/repair cycle.

1. Inspect enough of the repository to define truthful nodes and dependencies.
2. Call `workgraph_define` with stable lowercase IDs, explicit `requires`, acceptance criteria, and narrow writable scopes.
3. Call `workgraph_transition` with `action: "start"` before working on exactly one ready node.
4. Work only within the active node's contract and scope.
5. Call `workgraph_transition` with `action: "complete"` and concrete evidence references, or `action: "block"` with a specific reason.
6. Use `workgraph_revise` when discoveries invalidate the plan. Preserve completed work where its contract is unchanged.

Never encode an accidental cycle. A deliberate cycle must be declared as a loop whose node set exactly matches its strongly connected component, has identified feedback edges, a Boolean `successWhen` predicate, and a hard `maxIterations` limit.

The first implementation validates loop structure but does not yet execute loop iterations or evaluate `successWhen`. Do not imply that those controls are active until the extension reports them as implemented.
