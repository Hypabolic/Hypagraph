---
name: hypagraph
description: Automatically turn any actionable coding request or implementation plan into a goal contract, a graph of subgoals, and an executable Hypagraph workflow (or goal family of graphs), then run it with explicit dependencies, typed facts, deterministic checks and gates, evidence, bounded iteration regions, and trusted evaluation contracts when a defensible metric exists. The user does not need to mention graphs or Hypagraph.
---

# Hypagraph

Use Hypagraph whenever the user asks Pi to perform repository work or supplies a coding plan to execute. Do not wait for graph, workflow, DAG, gate, loop, metric, or Hypagraph terminology.

Treat the user's prose, issue, checklist, or plan as source intent. First define what success is. Then compile that intent into the smallest correct executable structure: one workflow graph, or a family of goals each with its own graph.

## Mental model: goals, graphs, and the hypergraph

Hypagraph is the executable work graph. A **Hypagoal** is one durable objective that owns **exactly one** workflow (one graph of nodes).

A **goal family** is the composition of several Hypagoals. That composition is the product hypergraph: edges between goals, not only edges between nodes.

| Layer | What it is | What owns it |
| --- | --- | --- |
| Node | Bounded work contract (task, check, gate, interaction, code, effect) | One workflow |
| Workflow / Hypagraph | Versioned node graph + runtime | One Hypagoal |
| Hypagoal | Objective + lifecycle + budget for that workflow | One family member |
| Goal family | Parent and child Hypagoals with bindings and one family controller | Root objective |

### Product control layers (family desk / plan owner / worker)

Use these three layers in every multi-member plan:

| Layer | Product name | Decides | Must not do |
| --- | --- | --- | --- |
| **L0** | **Family desk** | Create and register Hypagoals; allocate budgets; enforce family policy; select the next family action; cancel and escalate; commit family and member events through host paths | Let workers or member tools bypass family create/return |
| **L1** | **Goal plan owner** | Own objective, node set, local revise, acceptance, and return contract for **one** Hypagraph | Act as a second family scheduler; draw family budget without the desk |
| **L2** | **Worker** | Execute one selected node attempt; return structured results | Create children; schedule siblings; mutate family membership |

The child is **plan owner** for its own graph. The child is **not** a second main product orchestrator. The family desk still coordinates the family.

Rules you must keep:

1. Do **not** embed a complete child `HypagraphDefinition` inside a parent node.
2. Do **not** merge child nodes into the parent workflow after execution starts.
3. Each child Hypagoal owns its own workflow aggregate and its own goal lifecycle.
4. One family controller (family desk) schedules family work. A child is not a competing scheduler and not a free-form subagent loop.
5. Child completion does **not** complete the parent task automatically. The parent must integrate and verify returned facts.
6. **Create-child runs on the family desk** from an active parent task. The parent may use isolated-pi (default) or current-session.

The ordinary create path starts a **one-member family** (the root). Deeper family membership is additive.

## Define the goal before you build the graph

Before you call draft tools or `hypagoal_start`, form a short **goal contract** for the root objective. Keep it in working memory. Put durable pieces into the definition; put uncertain notes in `advisories`.

### Goal contract (root and every subgoal)

For the root, and for each subgoal you intend to encode:

1. **Outcome** — what is true when this goal is done (maps to `HypagraphDefinition.goal` and node titles).
2. **Acceptance** — observable criteria a human or check can confirm (maps to node `acceptance`, checks, gates, evaluation `successWhen`).
3. **Non-goals** — what this goal must not do. Do not invent product scope. Record material non-goals in `advisories` when useful.
4. **Verification** — how success is proven (checks, tests, facts, evidence, user interaction). Prefer deterministic instruments when they exist.
5. **Constraints** — safety, writable paths, budgets, external authority, ordering.
6. **Inputs and outputs** — facts or artifacts this goal consumes and produces (maps to `requires` / `produces` and future child bindings).

Do not start repository implementation during this step. Authoring remains read-only (`write`, `edit`, and `bash` stay blocked until after create and **Run**).

### Decompose into subgoals

Break the root outcome into the smallest set of subgoals that preserve intent.

For each subgoal, decide its **encoding**:

| Encoding | Use when | How you author it now |
| --- | --- | --- |
| **Same-graph node** | Same ownership, budget, and workspace; depends only on other nodes in this workflow | Task, check, gate, interaction, loop, and so on in the root definition |
| **Same-graph disconnected component** | Independent lifecycle inside the same root (for example a separate repair loop) | Separate node set without false `requires` edges |
| **Child Hypagoal** | Separate ownership, budget, scope, or return contract; recursive decomposition | Parent **task** binds a child goal; child owns its own workflow (family path) |
| **Later revision** | Work discovered only after evidence arrives, and a child is not appropriate yet | `hypagraph_revise` on the same root; preserve unaffected completed work |

Default bias: **same-graph nodes**. Prefer one clear root workflow over a deep family when one graph is enough.

Use a **child Hypagoal** only when at least one of these is true:

1. the subgoal needs its own token or turn budget;
2. the subgoal needs a narrower repository scope or a separate worktree-backed attempt;
3. the subgoal needs a typed return contract into the parent (output facts and evidence);
4. the subgoal is large enough that a separate inspectable graph is clearer than more parent nodes;
5. failure must apply a declared child policy without failing the whole parent graph.

Never invent a child for every sentence. Never flatten a true child need into silent prose implementation outside the graph.

### Same-graph subgoal shape

When subgoals stay in one workflow:

1. Map each subgoal to one or more nodes with explicit `acceptance`.
2. Put dependency order in `requires` (and gates when typed facts select a route).
3. Put proof in checks, evidence, interaction answers, or evaluation contracts.
4. Keep independent work as independent components.
5. Use a bounded loop only when repetition is justified.

### Child Hypagoal shape (family / hypergraph)

When a subgoal is a child Hypagoal:

1. Create the child only from an **active parent task** attempt on the **family desk**. A check or gate cannot create a child.
2. The parent task may use the default `isolated-pi` profile or `current-session`. Create-child does not require current-session.
3. Call **`hypagoal_create_child`** on the model tool surface (not free-form family mutation). Do not use the same parent node an unsettled isolated worker owns. An unsettled worker on another node does not by itself reject create-child; the parent task must still be active.
4. The child receives a **bounded binding**: objective, input facts, output fact contracts, scope paths, budget, and failure policy (`fail-parent-node`, `block-parent-node`, or `return-for-revision`).
5. Atomic child creation validates parent and child, records the binding, sets the parent task to `waiting_for_child`, starts the child workflow-local goal, and leaves unrelated parent components runnable.
6. The child graph is authored like any other Hypagoal: goal contract first, then smallest workflow, then create (child `draftId` or free-form `definition`). The child is **plan owner** of that graph.
7. On child terminal success, the family desk validates returned facts and evidence against the binding. The parent task becomes runnable for **integration**, not auto-complete.
8. On child failure, budget limit, or cancel, apply the declared failure policy. Budget exhaustion is never success.
9. Do not transfer family-desk ownership to the child. Do not enqueue family work from a worker, loop, or model tool outside the family scheduler.
10. Child model tasks default to **`isolated-pi`** workers. Do **not** set `executorProfile.kind: "current-session"` on non-root member tasks until member continuation delivery ships. The product rejects that path with a clear diagnostic.

### `hypagoal_create_child` (live tool)

Use this tool when a child Hypagoal is justified and a parent **task** attempt is active (after the user chose **Run** on the root). The parent may be isolated-pi or current-session.

Required parameters:

- `parentNodeId` — active parent task node id;
- `childObjective` — child outcome prose;
- `draftId` **or** `definition` — child graph (prefer `draftId` after construction tools);
- `scopePaths` — child repository scope; must equal or narrow the parent grant.

Optional parameters:

- `outputFacts` — fact contracts the child must return on success;
- `inputFacts` — parent fact names captured into the binding;
- `budget` — child turn/token limits reserved from the family budget;
- `failurePolicy` — `fail-parent-node` (default), `block-parent-node`, or `return-for-revision`;
- `childGoalId`, `childWorkflowId`, `bindingId` — only for deterministic tests; prefer host UUIDs in product.

Rules:

1. Blocked until the user chooses **Run** after root create (post-create gate).
2. Rejected for non-task parents, idle parents, and widened scope.
3. Rejected when `parentNodeId` equals the node an **unsettled isolated worker** owns (same-node guard). The message names that node. Options: choose another parent node, or cancel the worker then create the child.
4. The same-node guard is the only worker-related create-child block. Isolated parents are allowed when that parent is active and no unsettled worker owns that node. One exclusive active task per workflow means a second parent is not active while a worker runs on another node in that workflow.
5. On success: family has at least two members; parent is `waiting_for_child`; tool result includes child goal id, workflow id, binding id, and parent wait status.
6. Prefer same-graph nodes when the subgoal shares ownership, budget, and workspace. Prefer `hypagraph_revise` for mid-run plan change that is not a true child.
7. Multi-member path uses `hypagoal_create_child` from an active parent task on the family desk.

### Parent wait and return

1. While the parent waits, unrelated ready root components stay eligible for the family scheduler (family desk).
2. Child terminal success returns declared output facts and evidence into the binding.
3. The parent task leaves wait and becomes **running** for integration work. It is **not** completed by child success.
4. Inspect members, bindings, child-wait, budget, and focus with `/hypagraph status` and `hypagraph_read`. Status names the active **worker** member goal id, node, and attempt when a worker is live.
5. Focus a member graph with `/hypagraph graph member <goalId>`.

### Multi-child fan-out and ordinary join

Use this path when one parent task must wait for two or more child Hypagoals on the same parent node.

1. Call `hypagoal_create_child` more than once while the parent task is active or already `waiting_for_child` for the same parent node. Create siblings while the parent waits. Do not wait for a full single-child cycle before each create when you need multi-child join.
2. The parent stays `waiting_for_child` while any sibling binding for that parent node is active.
3. When every sibling for that parent node is terminal and all completed, the host auto-joins (all-success). The host publishes the default fact `join.passed` = true. Authors do not need a produce declaration for that default fact on the ordinary path.
4. Do not set `expectedBindingCount` for the ordinary path. Do not declare produce `join.passed` on the parent for ordinary multi-child join. Those steps are not required for the default path.
5. After join pass, the parent task is **running** for integration. Child success or join success does not complete the parent task.
6. If any join member is not completed, and child failure policy has not already failed or blocked the parent, join fail publishes `join.passed` = false and blocks the parent (product default). When failure policy already owns the parent, synthesis quiet-skips.
7. One child alone does not trigger multi-child auto join. The multi-child minimum is two (`AUTO_JOIN_MIN` = 2).
8. Optional advanced path: if you need a gate or typed consume on the join result, you may declare boolean produce `join.passed` on the parent. You may also set `expectedBindingCount` for advanced callers. These steps are optional. They are not mandatory for ordinary multi-child join.

Ordinary multi-child all-success join is a product path. Live Pi dogfood for multi-child join is not claimed here. Full quorum, ranked, and model synthesis strategies are not shipped.

### Flagship family recipe (root + one child)

Root free-form shape:

1. `delegate` — task that will call `hypagoal_create_child`. Default isolated-pi is fine. Optional `executorProfile` for current-session if you want that work in main chat. Declare `produces` for returned facts; optional narrow `scope`.
2. `integrate` — task, `requires: ["delegate"]`, consumes returned facts and finishes parent work. May also use current-session when integration runs on the family desk.
3. Optional `release-check` — check after integrate.

Child free-form shape:

1. `implement-auth` — task with **default** `isolated-pi` (omit `executorProfile`, or set isolated-pi explicitly). Do not use current-session on the child.
2. Optional check that publishes required output facts.

Binding example fields: `parentNodeId: "delegate"`, `outputFacts: [{ name: "auth.ready", type: "boolean", required: true }]`, `failurePolicy: "block-parent-node"`, `scopePaths` equal or narrower than the parent task scope.

### Goal → graph → run checklist

1. Write the root goal contract (outcome, acceptance, non-goals, verification, constraints).
2. List subgoals and choose encoding for each (node vs component vs child vs later revision).
3. Inspect the repository enough to ground paths, checks, and risks.
4. Build the root workflow (constructors and/or free-form) from that decomposition.
5. Validate, then `hypagoal_start`. Wait for **Run** in interactive TUI.
6. During execution, when new bounded work appears: revise the root graph with `hypagraph_revise`, or call `hypagoal_create_child` from an active parent task when a child is justified.
7. Never mark the root complete yourself. Terminal goal state is derived from the workflow lifecycle after evidence and verification.

## Wayfinder (start-to-run)

| Situation | Action |
| --- | --- |
| User asks for repository work | Goal contract → decompose subgoals → inspect → author → create → wait for **Run** |
| Subgoals share ownership and budget | Same-graph nodes (and independent components when needed) |
| Subgoal needs separate ownership, budget, scope, or return contract | Child Hypagoal via `hypagoal_create_child` from an active parent task on the family desk |
| Graph is only task/check/loop | Draft tools + `draftId` on `hypagoal_start` |
| Graph needs interaction, gate, code, or effect | Free-form `definition` on `hypagoal_start` (see interaction recipe below) |
| After create in TUI | Wait for post-create dock: **Run** / **Question** / **Cancel** |
| After Question, never started | `/hypagraph resume` re-opens the dock; user must choose **Run** |
| Default model task after Run | Isolated worker (`isolated-pi`); do not implement in orchestrator |
| User must answer a question | Interaction node on the orchestrator (bottom dock) |
| New work discovered mid-run | Prefer `hypagraph_revise` with **exact same** `goal` string; use `hypagoal_create_child` only when a true child is justified |
| Isolated worker fails | Fix the work or revise **node** contracts / `executorProfile`; never change `definition.goal` |
| Automatic revision turn | Copy `definition.goal` byte-for-byte; one attempt only; invalid proposals exhaust the allowance |
| Stuck worker | `/hypagraph executor cancel` |
| Inspect state | `/hypagraph status`, `hypagraph_read` (there is no `/hypagraph show`); family members and child-wait appear on status |

Ordered path: **goal contract → subgoal encoding → inspect → construct or free-form → validate → create → Run/Question/Cancel → isolated workers → interaction on orchestrator → revise or child when new goals appear**.

## Default authoring sequence

1. Form the root **goal contract** (outcome, acceptance, non-goals, verification, constraints). Do not implement yet.
2. Decompose into subgoals and choose encoding (same-graph node, independent component, child Hypagoal, or later revision).
3. Inspect enough repository state to understand the requested result, relevant files, existing checks, conventions, and material risks.
4. Prefer construction tools and recipes. Do not hand-author `feedbackEdges`.
5. Call `hypagraph_draft_begin` with the objective and exact `creationRequest` when present.
6. Prefer `hypagraph_recipe_implement_verify_loop` when the work is implement then verify in a loop.
7. Otherwise use `hypagraph_add_task`, `hypagraph_add_check`, `hypagraph_require`, and `hypagraph_loop`.
8. `hypagraph_loop` owns feedback edges. It sets `entry.requires` to include `evaluateAfter`.
9. Call `hypagraph_draft_validate`.
10. Call `hypagoal_start` with `draftId` when constructors cover the graph. Use free-form `definition` when the graph needs node kinds constructors do not yet build.
11. Keep simple work simple. One bounded task and one check can be sufficient.
12. Preserve explicit intent. Do not invent product scope, silently widen writable paths, or convert every sentence into a node.
13. Ask a question only when product intent, safety, destructive choice, external authority, or a material trade-off cannot be inferred safely. Do not ask the user to design nodes or edges.
14. After create succeeds in interactive TUI, wait for the user decision. Do not start repository work until the user chooses **Run** on the post-create dock.

### Construction tools versus free-form definition

Construction tools currently cover:

- task nodes (`hypagraph_add_task`);
- check nodes (`hypagraph_add_check`);
- dependencies (`hypagraph_require`);
- bounded loops (`hypagraph_loop`);
- the implement-then-verify recipe (`hypagraph_recipe_implement_verify_loop`).

Construction tools do **not** yet cover interaction, gate, code, or effect nodes.

When the workflow needs an interaction question, a gate, a code program, or an external effect, author those nodes with free-form `definition` on `hypagoal_start` (or mix a validated draft for the covered part and free-form for the rest only when you rebuild the full definition). Free-form remains a supported product path for those node kinds, not only a test or import escape hatch.

During authoring:

1. Do not call `write`, `edit`, or `bash`. Authoring is read-only for the repository.
2. Use construction tools, `hypagraph_read`, `hypagraph_draft_validate`, and `hypagraph_validate`.
3. Call `hypagoal_start` as the final action of the authoring turn.

### Free-form interaction recipe (demo product path)

There is no `hypagraph_add_interaction` constructor yet. When the user must approve, choose, or answer before later work, author an interaction node with free-form `definition` on `hypagoal_start`.

Use this linear shape for the standard product path (isolated task, then user approval):

1. Task node with no `requires` (ready first; default `isolated-pi` worker).
2. Interaction node with `requires` set to the task id.
3. Interaction `produces` facts that match each response `publish` entry.
4. `presentation.class: "deterministic"` and `presentation.kind: "none"` for the default bottom dock (no extra presentation effect).
5. At least one response with an `id`, `label`, and `publish` list.

Call `hypagraph_validate` on the definition when useful, then `hypagoal_start` with matching `objective` and `definition`.

```json
{
  "title": "Product surface E2E",
  "goal": "Run one isolated task, then ask the user to approve",
  "nodes": [
    {
      "id": "do-work",
      "title": "Do the work",
      "kind": "task",
      "requires": [],
      "acceptance": ["The work is done."]
    },
    {
      "id": "approve-work",
      "title": "Approve the work",
      "kind": "interaction",
      "requires": ["do-work"],
      "acceptance": ["The user answers the approval question."],
      "produces": [
        { "name": "work.approved", "type": "boolean", "required": true }
      ],
      "interaction": {
        "kind": "interaction",
        "version": 1,
        "presentation": { "class": "deterministic", "kind": "none" },
        "question": "Approve the completed work?",
        "responses": [
          {
            "id": "approve",
            "label": "Approve",
            "publish": [
              { "name": "work.approved", "type": "boolean", "value": true }
            ]
          },
          {
            "id": "reject",
            "label": "Reject",
            "publish": [
              { "name": "work.approved", "type": "boolean", "value": false }
            ]
          }
        ]
      }
    }
  ],
  "loops": [],
  "policy": { "mode": "guided", "requireEvidence": false }
}
```

After create and **Run**:

1. `do-work` runs in an isolated worker (not in the orchestrator chat).
2. When `approve-work` is ready, the controller presents the question in the **bottom** interaction dock on the orchestrator session.
3. Do not use `/hypagraph ask` as a substitute for an interaction node. Use `/hypagraph ask` only to re-present an already-open interaction after dismiss.
4. Do not answer the interaction from a worker session. Workers that open ask-user tools stall or fail; only the orchestrator presents interaction.

Gate nodes, code nodes, and effect nodes also require free-form `definition` until constructors exist. Follow the Code node authoring and Effect node authoring sections below for those kinds.

## Hypagoal creation

`/hypagoal <objective>` creates one root graph-backed goal for the current Pi session. That root is the first member of a one-member goal family.

During the authoring turn:

1. form the goal contract, then preserve the objective exactly in `HypagraphDefinition.goal`;
2. inspect relevant repository state before compiling the graph;
3. encode subgoals as same-graph nodes (default), independent components, or planned child bindings when the family path applies;
4. build the smallest useful workflow with drafts and construction tools when they cover the graph;
5. keep independent top-level components independent;
6. use a bounded iteration region only when repetition is justified;
7. add a metric only when a deterministic and defensible instrument exists;
8. set a token or substantive-turn budget only when the user explicitly supplies one; do not invent a budget;
9. put uncertain or useful authoring notes and material non-goals in `advisories`, not in canonical definition fields;
10. call `hypagoal_start` with `draftId` when constructors cover the graph, or with free-form `definition` when the graph needs interaction, gate, code, or effect nodes.

The creation tool validates the complete projected result and persists the workflow definition, initial readiness, and workflow-local goal start in one event batch. It does not start a task, run a check, or invoke an executor.

### After create (interactive TUI)

In interactive TUI, Hypagraph presents a bottom dock with a Mermaid graph diagram and three actions:

1. **Run** — start autonomous controller execution for the created goal;
2. **Question** — keep the goal active without starting work so the user can ask about the graph;
3. **Cancel** — cancel the created goal.

Esc dismisses like Question (safe dismiss). Cancel requires the Cancel row.

Until the user chooses **Run** on the post-create dock, do not start repository work, call task tools for this goal, or assume continuation is active.

After **Question** (or Esc):

1. answer the user's questions with `hypagraph_read` and status surfaces;
2. do not start tasks, checks, revisions, or repository edits while the gate is open;
3. when no node has ever started, `/hypagraph resume` **re-opens the post-create dock**; it does not auto-start work;
4. after reload or branch change, a never-started goal re-arms the same gate and notifies the user; resume again opens the dock.

Headless hosts do not show the dock. They may auto-continue after create.

Do not supply goal lifecycle state. The model cannot set a Hypagoal to completed, failed, cancelled, blocked, or paused. Terminal goal state remains derived from the canonical workflow lifecycle.

When a root already exists, replacement requires the exact typed confirmation supplied by Hypagraph. Do not construct, alter, or reuse a replacement confirmation from an older root state.

## Family desk, plan owner, and worker

The main Pi session is the **family desk** (and the plan owner for the live root Hypagoal). It is not the default runner for model task work.

1. Default task nodes run in isolated **worker** sessions (`isolated-pi`).
2. Deterministic checks, gates, code, and effects stay in the host. They do not use a worker session.
3. Interaction questions stay on the family desk session so the user can answer them.
4. Automatic revision turns may still use a desk follow-up in this release when selected.
5. A **root** node may set `executorProfile.kind: "current-session"` only as an explicit opt-in. Prefer the default for implement work.
6. A parent task that calls `hypagoal_create_child` may use isolated-pi or current-session. Child member tasks must stay isolated-pi until member continuation delivery ships.

While an isolated worker owns a mutating task attempt:

1. Do not call task lifecycle tools or edit repository files as if you were the worker.
2. Create-child is family-desk control. You may call `hypagoal_create_child` for an active parent task that uses isolated-pi or current-session when no unsettled worker owns that parent node.
3. Do not call `hypagoal_create_child` with `parentNodeId` equal to the node that worker owns. Choose another parent node, or cancel the worker and then create the child.
4. Use `hypagraph_read` and `/hypagraph status` or `/hypagraph executor status` for progress. Status reports the worker **member goal id**, node, attempt, profile, and elapsed time when one is active.
5. Cancel a stuck worker with `/hypagraph executor cancel`. Cancel aborts the worker signal and cancels the tracked **member** attempt.
6. Reload, branch change, and session shutdown also abort the in-flight worker and cancel the tracked member attempt.

Default root model attempts use a hard host timeout (15 minutes). A timed-out worker settles as failed rather than running forever.

After create and Run, the first ready task must not implement in the orchestrator chat under default policy. The controller starts a worker and settles the structured result. There is no production environment variable that switches the default to current-session. Only an explicit `executorProfile.kind: "current-session"` on the node opts in.

### When isolated-pi fails

Do **not** rewrite the root objective to “route work through current-session.” That is not a valid automatic revision and it burns the single revision attempt.

Allowed responses:

1. Retry the same task after you understand the worker failure (`/hypagraph executor status`, diagnostics, `PI_BIN`, spawn errors).
2. On an automatic revision turn, keep `definition.goal` **identical** to the live definition (byte-for-byte, including punctuation and spacing). Change only graph structure that the automatic revision policy allows.
3. To run a **specific** implement node in the orchestrator session, set that node’s `executorProfile` to `{ "profileId": "current-session-default", "kind": "current-session" }` in a **valid** revision that preserves the goal string. Prefer fixing isolated-pi for product paths that must stay isolated.
4. If revision is exhausted, stop. Tell the user the goal is blocked. Use `/hypagraph cancel` and create a new goal only when the user asks. Do not invent more automatic revisions.

## Automatic revision rules (hard)

The product allows **one** automatic revision attempt per root Hypagoal (`maximumAttempts: 1`). A rejected proposal **consumes** that attempt.

When the controller selects `request-revision` or you call `hypagoal_submit_revision` / `hypagraph_revise` for an automatic path:

1. Set `goal` to the **exact** current `definition.goal` string. Do not rephrase, trim, expand, or add routing notes into the goal text.
2. Do not change the objective to describe an implementation strategy (for example “use current-session”). Strategy belongs in node titles, acceptance, or `executorProfile`.
3. Do not remove nodes, weaken acceptance, widen scope, widen code/effect authority, or raise loop limits.
4. Prefer the smallest change that restores a runnable path for the blocked work.
5. If you cannot propose a legal revision, do not submit a known-invalid one. Report the blockage to the user instead of burning the attempt.

Whitespace-only objective changes also fail (`automatic_revision_objective_changed`).

## Hypagoal continuation

When Hypagraph supplies an automatic continuation prompt (current-session opt-in, revision, or interaction), perform only the selected canonical action.

1. Check the goal ID, workflow ID, revision, node ID, and loop ID when present.
2. Use `hypagraph_transition` for task and gate actions on a current-session opt-in path.
3. Use `hypagraph_run_check` for a selected check only when a continuation selects that check for the orchestrator.
4. Continue an active task before starting another node when the continuation names that task.
5. Do not revise the graph, replace the root, or mark the goal complete during the selected action.
6. Let canonical workflow state determine the next continuation or stop decision.

Default task work does not use this follow-up path. Prefer status tools over inventing implement turns.

The controller selects across all runnable root components. Do not assume that the component which produced the latest event owns the next turn. Disconnected branches and independent loops remain eligible.

A continuation prompt is valid only for the exact state which requested it. If Hypagraph reports that the continuation is stale, do not change files or canonical workflow state. Read the current graph before another action.

A user message has priority over a queued continuation. Do not recreate or resend a skipped continuation.

Each delivered continuation is charged once against the root Hypagoal budget. Do not fabricate or edit Pi usage values. Budget exhaustion is a controller stop, not workflow success. When Hypagraph reports `budget_limited`, do not continue work through another prompt.

A reload or branch change pauses an active Hypagoal, tears down in-flight workers, and dispatches no work. Continue only after the user explicitly runs `/hypagraph resume` (compatibility: `/hypagoal resume`). Resume does not reset consumed turns or tokens. When the goal has never dispatched a node, resume re-opens the post-create review dock instead of auto-starting work.

Prefer `/hypagraph` for control and inspection (`status`, `pause`, `resume`, `cancel`, `ask`, `history`, `explain`, `loop`, `check`, `graph`, `trigger`, `executor`). Use `/hypagoal <objective>` for explicit root create. Prefer draft tools and `hypagraph_draft_validate` before create when constructors cover the graph. `hypagoal_start` creates a **root** Hypagoal. `hypagoal_create_child` creates a **child** from an active parent task. Prefer `draftId` when constructors suffice; use free-form `definition` for interaction, gate, code, and effect nodes. Do not use or teach `hypagraph_define`.

After a successful create, Hypagraph also tries to write project-store artifacts under `.hypagraph/`. Runtime authority remains the event stream. If the store write fails, create still succeeds and the host notifies the user. `/hypagraph status` reports whether the definition artifact was written.

### Hypagoal arming and live highlight

The configured trigger word (default `hypagoal`) arms creation for one user turn when it appears as a whole token in the user message. Arming does not create a goal. Only `hypagoal_start` creates a goal.

In interactive TUI, the same matcher paints the trigger word in the composer **while the user types**, before submit. Fenced code, inline code, and path-like tokens do not highlight and do not arm. `/hypagraph trigger set <word>` and `/hypagraph trigger off` update live highlight without a session reload when the editor is registered. Headless hosts keep submit-time arming only.

When the selected action belongs to a loop, use only the loop and evaluation context that Hypagraph supplies. Keep these values separate:

- evaluation validity;
- current accepted metric;
- best accepted metric;
- typed success;
- patience or no-progress count;
- invalid-evaluation count;
- evaluation-attempt budget;
- goal turn and token budgets.

An invalid evaluation cannot update current or best progress. It cannot reset patience or satisfy typed success. Do not infer success from a score alone.

Do not reveal protected evaluator commands, paths, hashes, raw reports, standard output, standard error, hidden assertions, or holdout details. Use only the declared feedback mode and the public evaluator identity that Hypagraph supplies.

The reducer applies the declared loop failure policy. Do not replace a hard limit, patience stop, invalid-evaluation limit, evaluation-budget stop, evaluator failure, or goal-budget stop with a success claim.

Independent runnable components remain eligible after each loop turn. Do not continue the same loop only because it produced the latest metric or evaluation event.

## Code node authoring

Use a `code` node for one type-checked pure or observation program that publishes declared facts without a model turn.

1. Prefer graph structure over program size. If work can be two nodes and one gate, do not put an `if` branch that selects downstream work inside the program.
2. Keep a branch in the graph when the branch changes what runs next. A condition inside a program may select a value. It must not select downstream work.
3. Keep repetition in a loop region when each pass needs an attempt, evidence, a check, or an evaluation.
4. Declare `inputs` as fact bindings. Declare `capabilities` as a deny-by-default allowlist. Do not use `external-effect` on a code node.
5. Declare `scope.paths` when a program has a workspace-mutation capability.
6. Keep one result contract per code node. A large program with many unrelated facts is usually more than one node.
7. Author the program at definition time. `hypagraph_validate` and `hypagoal_start` type-check the program and report line-numbered TypeScript errors before the definition is accepted.
8. Review code authoring advisories on define and status surfaces. Do not reject the definition for an advisory alone.

The controller runs a ready code node in the deterministic lane without a model turn. Replay replays the recorded result and never runs the program again.

## Effect node authoring

Use an `effect` node when work must change external state, for example open a pull request, merge, deploy, or notify an external system.

1. Declare `effect` and `reconcile` as separate `SandboxProgramDefinition` bodies. Do not nest one node definition inside another.
2. Declare `idempotency.from` as `canonical-identity`. The runtime derives the key from workflow, revision, node, and attempt identity only.
3. Declare `externalIdentity` fact contracts. They must also appear in `produces`.
4. Set `onIndeterminate` to `block-dependants` or `fail-workflow`.
5. The effect program may declare `external-effect` capabilities. The reconciliation program may declare `observation` capabilities only. A mutating reconciliation program fails validation.
6. Do not use an effect node for display in Pi. Presentation belongs to interaction nodes.

The controller stores `requested` before the external call starts. A lost result becomes `indeterminate`. Restart recovers requested-only attempts to indeterminate, then reconciles every indeterminate effect before it selects new work. Replay reproduces the recorded effect state and does not repeat the external call.

Host-injected program bindings (not fact contracts):

- `inputs["effect.idempotency_key"]` — the canonical-identity key for this attempt;
- `inputs["effect.phase"]` — `effect` or `reconcile`.

Do not list these names in `program.inputs`. The host injects them at prepare ambient type-check and at execution. They are not published facts. Pass the idempotency key to external systems that support one. Read-only reconciliation must use observation capabilities only.

## Evaluation-contract authoring

Use an evaluation contract only when the objective has a defensible deterministic measurement.

Do not invent a metric because a loop exists. A loop can use typed success, deterministic checks, evidence, hard limits, explicit outcome policy, and user review without numeric progress.

When a defensible metric exists, use this sequence.

### 1. Separate target, success, progress, and validity

Define separately:

- **target:** the capability or property to improve;
- **success:** the typed condition that permits completion;
- **progress:** the numeric fact and minimize or maximize direction;
- **validity:** the typed condition that makes an observation usable.

A threshold fact can participate in success. It must not replace validity.

### 2. Convert constraints into instruments

For each material constraint, define:

- an instrument that can measure or assert it;
- a declared typed fact;
- a validity or gate condition;
- an explicit failure route or stop rule.

A textual warning without a deterministic instrument is not an enforceable constraint.

Use existing test, lint, coverage, file, Git, command, or metric-report checks where possible.

### 3. Select evaluation purpose

Use:

- `development` for frequent optimization feedback;
- `probe` for changed inputs or conditions that test generalization and metric gaming;
- `holdout` only for final-purpose evaluation.

Purpose does not establish trust.

### 4. Select evaluator trust

Declare `evaluation.integrity.trustLevel` explicitly:

- `transparent`: evaluator logic and data can be visible;
- `protected`: declared evaluator artifacts are integrity-checked but remain locally readable;
- `isolated`: evaluator logic or expected results are outside the model workspace.

The current local runtime supports transparent and protected execution. Do not author isolated trust until an isolated adapter is available.

A local protected evaluator is not a secret holdout. Do not describe a transparent or protected result as trusted holdout acceptance.

For protected trust, declare exact SHA-256 paths or exact Git constraints. Declare an evaluator version or derive identity from protected instruments.

### 5. Define bounded feedback

Use aggregate feedback by default.

Use bounded diagnostics only when actionable diagnostic codes are necessary. Declare `maximumDiagnosticItems`.

Do not expose raw reports when they contain protected cases, expected answers, membership identifiers, hidden constraints, or other shortcut information.

Holdout-purpose evaluation must use aggregate feedback.

### 6. Define budgets

Declare workflow evaluation budgets whenever external metric evaluators can run.

Use a total limit and relevant per-purpose limits. Include enough budget for expected retries, invalid observations, probes, and final evaluation, but keep the contract bounded.

Evaluation attempts consume budget when the external evaluator starts, including failed, invalid, timed-out, cancelled, interrupted, errored, and retried attempts.

### 7. Define loop controls

An evaluation-backed loop should declare:

- typed `successWhen`;
- hard `maxIterations`;
- typed `evaluation.validWhen`;
- `maximumInvalidEvaluations`;
- optional numeric `progress`;
- `patience` when marginal improvement should stop the region;
- explicit `failurePolicy`.

Improvement must exceed `minDelta`. Equal values do not improve.

### 8. Analyze shortcuts and probes

Identify obvious ways the implementation could improve the score without improving the target.

For each material shortcut, add a constraint instrument or probe. Useful probe facts include generalization score, probe gap, capacity validity, and strategy-change requirements.

Do not ask a model to judge structural strategy difference unless a deterministic task-specific instrument exists.

## Execution rules

1. Call `hypagraph_transition` with `action: "start"` before task work. Use `action: "evaluate"` for a ready gate.
2. Work only in the active task contract and writable scope.
3. Use `action: "publish"` for declared task facts while the attempt is running.
4. Use `action: "submit"` with concrete evidence, then a separate `action: "verify"`.
5. Use `hypagraph_run_check` for ready or retryable check nodes. Do not start checks through `hypagraph_transition`.
6. A ready code node runs in the deterministic lane. Do not start a code node through `hypagraph_transition`.
7. A ready effect node runs in the deterministic lane. Do not start an effect node through `hypagraph_transition`. The controller reconciles indeterminate effects before new work.
8. Use `action: "block"` when work cannot continue and `action: "cancel"` when an active attempt must stop.
9. Call `hypagraph_revise` when new evidence makes the graph incorrect. Preserve the exact `goal` string and unaffected completed work and routes. A revision must not widen a code capability allowlist or effect external authority. See Automatic revision rules.

## Loop rules

A deliberate cycle must be a declared bounded iteration region. Prefer `hypagraph_loop` or `hypagraph_recipe_implement_verify_loop`. Do not hand-author `feedbackEdges` on the normal path.

The loop tool owns:

1. the cycle-closing dependency (`entry.requires` includes `evaluateAfter`);
2. projected `feedbackEdges: [{ from: evaluateAfter, to: entry }]`;
3. derivation of `loops[].nodes` as the cyclic SCC when possible.

Typed success and a hard iteration limit remain mandatory.

Do not assume a loop is for repair. Use node contracts and facts to define refinement, optimization, search, batch processing, repeated evaluation, reconciliation, polling, migration, or repair.

A loop can be an independent graph component. Keep its facts, routes, progress, validity, attempts, and reset state independent from unrelated regions.

A failed evaluator check is a usable loop observation only when normalization succeeded and all required facts were published. Cancellation or interruption blocks the affected loop until an explicit revision resets it.

Do not revise a loop while an attempt is active. A relevant revision restarts the region from iteration 1. Check retries stay in the current iteration. Loop continuation creates a new iteration and attempt ID. Do not select loop decisions manually.
