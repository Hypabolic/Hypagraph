# M6.1 interaction and approval nodes vertical-slice plan

- Status: planned
- Milestone: M6.1
- Release marker: v0.8
- Prerequisite: M6A deterministic dispatch, M6B event history
- Analysis source: `docs/graph-capability-review.md` section 6
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

M6.1 lets the graph return to the user for a decision, and lets a typed answer control the next work.

Both reference workflows need this. Reference workflow A needs a "needs human" state and a review-and-merge gate. Reference workflow B needs plan approval and a final result which reaches the user.

Nothing in v0.6 provides it. `EvidenceReference` accepts `kind: "approval"`, but that is only a label on a reference. The nearest runtime state is a blocked node with a blocked goal, which is a fault state, and which needs the user to type `/hypagoal resume`.

## 2. Product result

A workflow can:

1. perform one bounded presentation action, for example render a report artifact or open a plan annotation view;
2. ask the user one declared question;
3. record a typed answer as facts and evidence;
4. route on those facts through an ordinary gate.

An unanswered question does not stop the goal. Independent branches and loops continue.

## 3. Mandatory rules

### 3.1 Keep the wait node-local

Add node status `awaiting_response`.

Do not add a goal status which stops the goal.

An earlier proposal added a stored goal status `awaiting_user`. That proposal is wrong. It breaks design rule 3.5 in the roadmap, which requires that independent components stay independent. It would starve an independent branch or loop which remains runnable, and it would remove an M5B acceptance property.

Model the wait as node-local only. An `awaiting_response` node is not runnable, exactly as a pending node is not runnable. The continuation selector then keeps every other component eligible, and existing round-robin fairness continues to work with no change.

### 3.2 Derive the waiting presentation state

Report "waiting for a user response" as a derived value. Derive it when the runnable action list is empty and at least one interaction is outstanding.

Do not store it. This follows the existing rule that terminal and blocked state stay derived from the workflow.

### 3.3 Separate deterministic and semantic presentation

A skill is not automatically deterministic.

| Class | Examples | Executor | Model turn |
| --- | --- | --- | --- |
| Deterministic presentation | Render an HTML or Markdown artifact from a canonical projection. Open a fixed user-interface surface, for example a plan annotation view. Run a bounded command which produces an artifact. | Command or sandbox executor | None |
| Semantic presentation | Run a skill which is a set of model instructions, for example summarise the change before the question. | M7 model executor | One |

A named Pi skill can belong to either class. The definition must declare the class. Validation must reject a deterministic declaration for a skill which needs model work.

Until M7 exists, M6.1 supports the deterministic class only. A definition which declares a semantic presentation must fail validation with a clear diagnostic which names M7.

### 3.4 Keep free text out of routing

A declared response option maps to typed facts. Free text is captured as evidence.

Free text must never select a route. A route must come from a typed fact through an ordinary gate condition. This keeps the existing rule that a gate does not use model or human prose judgement.

### 3.5 Use the existing durable order

An interaction node uses the same durable order as a check: store the request, perform the presentation effect, store the observation, publish facts, then store verification.

Do not perform the presentation effect before the request event is stored.

### 3.6 Survive a reload

An unanswered interaction must survive a session reload and must be presented again.

The current policy pauses an active goal after a reload. That policy stays for autonomous continuation. It must not discard an outstanding question. After `/hypagoal resume`, an outstanding interaction is presented again without a repeated external effect if the artifact still exists.

### 3.7 Consume no budget while waiting

A waiting interaction consumes no turns and no tokens. Waiting is not work.

## 4. Canonical model

### 4.1 Definition

```ts
export interface InteractionNodeDefinition {
  kind: "interaction";
  version: 1;
  presentation: InteractionPresentation;
  question: string;
  responses: InteractionResponseOption[];
  freeText?: { prompt: string; maxBytes: number };
  timeout?: { afterMs: number; onTimeout: "block" | "select"; selectResponseId?: string };
}

export interface InteractionResponseOption {
  id: string;
  label: string;
  publish: FactInput[];
}
```

`presentation` declares the class from rule 3.3 and the effect definition.

Each response option publishes declared typed facts. A gate then routes on those facts.

### 4.2 Events

Add:

- `hypagraph.interaction.requested`;
- `hypagraph.interaction.presented`;
- `hypagraph.interaction.answered`;
- `hypagraph.interaction.expired`.

Use new event types. Do not reuse check event types. M6B history views must distinguish a question from a check.

### 4.3 Runtime

An interaction attempt records the presentation observation, the artifact reference, the selected response identifier, the published facts, and the free-text evidence reference.

## 5. Vertical slices

### Slice 1 - Node kind, wait state, and selector behaviour

Scope:

1. Add the `interaction` node kind and structural validation.
2. Add node status `awaiting_response`.
3. Make an awaiting node not runnable in `enumerateRootWorkActions`.
4. Add the request and answered events.
5. Accept an answer through a new Pi command and publish declared facts.

Tests:

- an awaiting interaction does not stop an independent runnable branch;
- an awaiting interaction does not stop an independent runnable loop;
- an awaiting interaction consumes no budget;
- an answer publishes exactly the declared facts;
- replay reproduces the answer and the facts.

Exit: a graph with one interaction node and one independent loop continues the loop while the question waits.

### Slice 2 - Deterministic presentation effects

Scope:

1. Add the presentation executor behind the existing `CheckExecutor` seam.
2. Support a rendered artifact from a canonical projection.
3. Support a bounded command which produces an artifact.
4. Store artifacts under the existing check-artifact store.
5. Reject a semantic presentation with a diagnostic which names M7.

Tests:

- the effect runs after the request event and never before;
- an artifact is bounded and stored by identity;
- a failed effect produces an explicit state and not a silent question;
- a semantic declaration fails validation.

### Slice 3 - Routing, free text, and timeouts

Scope:

1. Route on published facts through an existing gate with no new routing semantics.
2. Capture free text as evidence with a byte bound.
3. Add the optional timeout policy.

Tests:

- free text never changes a route;
- a timeout with `block` produces an explicit blocked node;
- a timeout with `select` publishes the declared default facts;
- a gate after an interaction behaves exactly as a gate after a check.

### Slice 4 - Reload, restore, and product surface

Scope:

1. Present an outstanding question again after a reload and an explicit resume.
2. Do not repeat a completed external presentation effect.
3. Add the derived waiting state to `/hypagoal status` and the graph pane.

Tests:

- restore does not repeat the presentation effect;
- an outstanding question is visible after restore;
- the derived waiting state appears only when no runnable action exists.

### Slice 5 - Dogfood and release

Scope:

1. Run one objective which contains a plan approval and one independent loop.
2. Prove that the loop continues while the approval waits.
3. Record evidence in `docs/m6-1-dogfood.md`.

## 6. Acceptance criteria

- An interaction node performs its declared presentation effect through the durable lifecycle order.
- An unanswered interaction does not stop an independent runnable component.
- An unanswered interaction consumes no budget.
- A typed answer publishes declared facts and routes through an existing gate.
- Free text reaches evidence and never reaches a route.
- A definition which declares a semantic skill as deterministic fails validation.
- An unanswered interaction survives a reload and is presented again without a repeated effect.
- The waiting state is derived and not stored.
- Replay reproduces the same answer, facts, and route.

## 7. Out of scope

- semantic presentation, which needs the M7 executor;
- a general notification channel, which belongs to M6.3 external effects;
- external review systems, which belong to M6.3.
