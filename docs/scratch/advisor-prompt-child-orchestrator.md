# Advisor brief: Should a child Hypagoal be its own orchestrator?

You are an **advisor**, not an implementer. Do not write code. Do not re-litigate today's Hypagraph wiring bugs unless they illuminate product choice.

## Product context (Hypagraph)

- **Hypagraph** = executable work graph (nodes: task, check, gate, interaction, …).
- **Hypagoal** = one objective that owns **exactly one** workflow/graph.
- **Goal family** = composition of Hypagoals (hypergraph of goals): root can create **child** Hypagoals at runtime with separate workflow, budget slice, scope, return contract.
- Alternative to children: put everything as **nodes in one root graph** at authoring time (no create-child).
- Isolation: model task attempts can run in **isolated worker sessions** (robots) vs **current-session** (main chat does the work).
- Today’s architecture docs say: **one family controller** schedules across members; a child is a workflow aggregate, **not** a competing subagent scheduler; workers execute one node attempt and must not define child goals.

## User’s product intuition

The parent (main) designs structure when it should; but once a **child Hypagoal** exists and is building **its** graph/work, **that child should be the orchestrator for that subgraph**, not the main thread. Main remains orchestrator of the **family**, not of every implement turn inside the child.

They are asking for **best practice for product and UX**, not “what the code does today.”

## Questions to answer

1. In a best-practice multi-agent / graph-of-goals product, is the user’s model correct?
2. What should “orchestrator” mean at three layers: family, single Hypagoal, node worker?
3. When should structure be fixed at authoring time (one graph) vs spawn a child mid-run?
4. Who should call “create child”: main only, current-session parent node, child-request protocol, or workers?
5. For UX: what should the user see and control (one chat, nested chats, status of family desk vs child project)?
6. Failure modes of “child is full second orchestrator” vs “one family desk always drives”?
7. Concrete recommendation for Hypagraph product direction (principles + preferred default path + what to document in the skill).

## Output format only

## Recommendation (one paragraph)

## Layer model
Table or bullets: family / hypagoal / worker — who decides what.

## When to use one graph vs child goal

## Create-child authority (who presses the button)

## UX surface (what the human sees)

## Risks of the wrong model

## Hypagraph-specific advice
Numbered principles the product should adopt.

## Dissent / open decisions
What still needs a product call.

Be direct. Prefer simple language. No code patches.
