# Automatic graph authoring product model

- Status: accepted product direction
- Applies to: all Hypagraph and Hypagoal entry points
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Decision

The user describes the work. Hypagraph builds the graph.

A user can provide:

- an ordinary coding request;
- a bug report;
- an issue or ticket;
- a checklist;
- an implementation plan;
- a durable objective.

The user does not have to mention Hypagraph, graphs, nodes, edges, gates, facts, checks, or loops.

The graph is an inspectable executable representation of user intent. It is not an input format that the user must design.

## 2. Default skill behavior

The bundled skill must activate for actionable repository work and supplied implementation plans.

It must:

1. Inspect the repository.
2. Identify the requested result and constraints.
3. Find relevant files, checks, and repository conventions.
4. Compile the request into the smallest correct Hypagraph workflow.
5. Define the graph before it starts work.
6. Execute only ready work through the Hypagraph runtime.
7. Revise the graph when new evidence makes the plan incorrect.

The skill must not wait for graph-specific words in the user request.

## 3. Smallest useful graph

Automatic authoring must not create complexity for its own sake.

Use:

- one task when one bounded contract is sufficient;
- a check when deterministic verification exists;
- multiple tasks when dependencies or scopes are materially different;
- a gate when typed facts select a real alternative;
- a loop when work must repeat until a typed stop condition or hard bound applies;
- disconnected regions when work has independent bounded lifecycles.

Do not convert every sentence or checklist item into a node mechanically.

## 4. Intent preservation

The generated graph must preserve:

- the requested outcome;
- explicit constraints;
- acceptance intent;
- required ordering;
- declared safety limits;
- writable scope;
- user-selected trade-offs.

The authoring model must not invent new product scope or silently widen file access.

An existing plan is semantic input. The skill can merge, split, reorder, or add validation nodes when repository evidence requires it, but it must preserve the plan's intent and explain material changes.

## 5. Questions

Ask a user question only when a safe graph cannot be inferred because of:

- ambiguous product intent;
- a destructive choice;
- conflicting explicit requirements;
- missing external authority;
- a material trade-off that the repository cannot resolve.

Do not ask:

- how many nodes the graph should contain;
- which node kind to use;
- which edge kind to use;
- whether a condition should be a gate;
- whether repeated work should be a loop;
- how the graph should be laid out.

Those are Hypagraph authoring decisions.

## 6. Inspection and revision

The graph remains user-inspectable through the Pi graph pane and text summaries.

A user can revise the work in normal language. The model translates the change into `hypagraph_revise` operations and preserves unaffected completed work when safe.

The user can discuss the work model without learning the graph schema.

## 7. Architecture boundary

Model reasoning performs graph authoring.

Deterministic code performs:

- graph validation;
- readiness calculation;
- state transitions;
- check execution;
- gate evaluation;
- loop decisions;
- evidence enforcement;
- persistence;
- replay.

Automatic authoring must not move deterministic runtime authority into the prompt.

## 8. Acceptance criteria

This product direction is met when:

- a normal coding request activates Hypagraph without graph terminology;
- a supplied plan becomes an executable graph automatically;
- a small task produces a small graph;
- complex work receives only the dependencies, checks, gates, and loops it needs;
- the skill asks about user intent rather than graph design;
- graph generation preserves explicit scope and constraints;
- the user can inspect and revise the graph in normal language;
- the runtime validates every generated graph before execution.
