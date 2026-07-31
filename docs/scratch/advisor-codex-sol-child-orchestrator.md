## Recommendation

The user’s model is correct, with one boundary: a child Hypagoal must be the local orchestrator for its workflow, but it must not become an independent family scheduler. The child decides how to plan, revise, and execute its graph within its contract. The family controller decides how all Hypagoals share budgets, resources, dependencies, and authority. This gives the child real autonomy without creating competing control planes.

## Layer model

| Layer | Decides |
|---|---|
| Family controller | Creates and registers Hypagoals. Allocates budgets. Enforces family policy. Coordinates dependencies between Hypagoals. Resolves resource conflicts. Handles cancellation, priority, and escalation. |
| Hypagoal orchestrator | Owns one objective and one graph. Builds or revises that graph. Selects ready nodes. Interprets results. Handles local retries. Requests more budget or child Hypagoals. Produces its return contract. |
| Node worker | Executes one bounded node attempt. Returns evidence and structured results. It does not schedule other nodes. It does not create Hypagoals. It can report that the current structure is insufficient. |

A child is therefore a local orchestrator and a family member. It is not a second family controller.

## When to use one graph vs child goal

Use one graph when:

- The structure is known at authoring time.
- The work has one lifecycle and one success condition.
- Nodes need the same context and permissions.
- The work does not need a separate budget.
- The parent can express the dependencies clearly.
- Independent cancellation or recovery has little value.

Create a child Hypagoal when:

- Execution discovers a substantial new objective.
- The objective needs its own graph or planning loop.
- The work needs a separate context boundary.
- The family must allocate a separate budget.
- The work has a clear return contract.
- The work can run, fail, pause, or recover independently.
- Local replanning would overload the parent graph.
- The parent needs the result, but does not need to control each implementation step.

Do not create a child only to obtain an isolated worker session. Session isolation and goal decomposition are separate choices.

## Create-child authority (who presses the button)

The family controller must perform the actual creation because it owns the family registry, budgets, and shared policy.

The request can come from:

- The main family conversation.
- A running parent Hypagoal.
- A current-session interaction node.
- An existing child that needs its own child.

The request must include an objective, scope, budget request, authority boundary, and return contract. The family controller must validate and admit the request.

A node worker must not create a child directly. It can return a structured child request. The owning Hypagoal then accepts, rejects, or revises that request before the family controller acts.

This avoids making the main chat a bottleneck while keeping one authority for family changes.

## UX surface (what the human sees)

Use one primary conversation by default. Treat it as the family desk.

The family desk must show:

- The family objective and current status.
- Each Hypagoal and its relationship to the family.
- The active local orchestrator for each Hypagoal.
- Budget allocation and consumption.
- Blocking dependencies and return contracts.
- Pending child requests and human approvals.
- Family-level risks and decisions.

Each child must have a drill-down project surface. It can show its graph, decisions, workers, evidence, budget, and local conversation. This surface does not need to become a separate top-level chat.

The user must be able to:

- Open a child and talk at that scope.
- Pause, resume, cancel, or reprioritize a child.
- Change its budget or authority.
- Approve sensitive expansion.
- Return to the family desk without losing context.
- See which decisions stay local and which decisions affect the family.

Important child results and escalations must flow back to the family desk. Routine worker output must remain inside the child surface.

## Risks of the wrong model

If each child becomes a full second orchestrator:

- Schedulers can compete for the same resources.
- Budget use can multiply without control.
- Children can create unbounded goal trees.
- Shared repository operations can conflict.
- Policy and permission decisions can diverge.
- Ownership of cancellation and recovery becomes unclear.
- The user cannot tell which controller is authoritative.

If one family desk drives every child node:

- The family controller becomes a planning bottleneck.
- Its context grows without limit.
- Local reasoning and recovery become slow.
- Child Hypagoals become labels instead of real execution boundaries.
- Parallel work still depends on one central reasoning loop.
- The main conversation fills with implementation detail.
- A child cannot adapt effectively after runtime discovery.

## Hypagraph-specific advice

1. Define a Hypagoal as an objective-scoped orchestration boundary.

2. Keep exactly one family controller. Give each Hypagoal one local control loop.

3. Separate logical orchestration from physical scheduling. A child can select local work while the family controller controls admission and shared resources.

4. Make the child contract explicit. It must contain the objective, scope, budget, permissions, inputs, success conditions, and return contract.

5. Use a request-and-admit protocol for child creation. Do not require the main chat to originate every request.

6. Prohibit direct child creation by node workers. Permit workers to return a structured recommendation.

7. Make runtime child creation an exception with clear reasons. Use authored graph nodes for work that is already known.

8. Keep session isolation independent from goal structure. A node can use an isolated worker without becoming a child Hypagoal.

9. Present one family desk with nested project views. Do not require the user to manage many unrelated chats.

10. Route local decisions to the child. Route budget, policy, shared resources, and cross-goal dependencies to the family controller.

11. Update the skill to say: “The parent defines the child contract. The child orchestrates its own workflow. The family controller coordinates the goal family. Workers execute one node attempt.”

12. Avoid the phrase “the child is not an orchestrator.” Say: “The child is not a competing family scheduler.”

## Dissent / open decisions

- Whether a child can revise its graph without approval, or only within stated limits.
- Which budget and permission thresholds require human approval.
- Whether child requests are admitted automatically under policy.
- Whether a child can request grandchildren by default.
- How much local reasoning appears in the family desk.
- Whether talking inside a child changes conversational scope or creates a separate durable chat.
- Whether the family controller only arbitrates resources or also chooses among ready nodes across all Hypagoals.
- How Hypagraph detects that a proposed child is only an oversized node or unnecessary decomposition.
