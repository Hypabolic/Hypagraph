# M6.1 interaction and approval nodes vertical-slice plan

- Status: in progress
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
| Deterministic presentation | Render an HTML or Markdown artifact from a canonical projection. Open a fixed user-interface surface, for example a plan annotation view. Run a bounded command which produces an artifact. | Direct Pi user-interface adapter, canonical report renderer, or bounded command executor | None |
| Semantic presentation | Run a skill which is a set of model instructions, for example summarise the change before the question. | M7 model executor | One |

A named Pi skill can belong to either class. The definition must declare the class. Validation must reject a deterministic declaration for a skill which needs model work.

Until M7 exists, M6.1 supports the deterministic class only. A definition which declares a semantic presentation must fail validation with a clear diagnostic which names M7.

M6.1 comes before M6.2, so the sandbox executor does not exist yet. M6.1 supports three deterministic presentation implementations:

1. a direct Pi user-interface adapter;
2. a canonical report renderer;
3. a bounded command executor.

Sandbox-backed presentation becomes available additively after M6.2. Do not make M6.1 depend on it.

### 3.4 Separate routing from feedback content

An interaction answer has two independent outputs. Keep them separate.

```ts
export interface InteractionAnswer {
  responseId: string;
  feedbackArtifact?: ArtifactReference;
  evidence?: EvidenceReference[];
}
```

`responseId` selects one declared response option, which publishes typed facts. Only those facts control routing.

`feedbackArtifact` carries structured content from the presentation surface. It must never select a route.

A response option and bounded free text are sufficient for approve, reject, and changes-requested. They are not sufficient for a plan annotation surface, which can return line annotations, several comments, selected regions, structured revision instructions, and artifact-level metadata.

The feedback artifact is bounded and stored by identity in the existing artifact store. The next semantic task receives it through its explicit context projection, which satisfies design rule 3.7. A model reads the artifact. A gate does not.

A feedback artifact changes work products only. It does not grant graph authority. A task which reads annotations can update a plan artifact and publish revised facts. It cannot add, remove, or alter nodes, dependencies, contracts, scopes, or loop structure. Roadmap design rule 3.3 keeps that authority in the controller, and only the bounded revision path can use it.

Free text remains evidence only, exactly as before.

### 3.5 Use the existing durable order

An interaction node uses the same durable order as a check: store the request, perform the presentation effect, store the observation, publish facts, then store verification.

Do not perform the presentation effect before the request event is stored.

### 3.6 Survive a reload

An unanswered interaction must survive a session reload and must be presented again.

The current policy pauses an active goal after a reload. That policy stays for autonomous continuation. It must not discard an outstanding question. After `/hypagoal resume`, an outstanding interaction is presented again without a repeated external effect if the artifact still exists.

### 3.7 Consume no budget while waiting

A waiting interaction consumes no turns and no tokens. Waiting is not work.

### 3.8 Use level-triggered timeout semantics

Hypagraph has no resident process. Roadmap design rule 3.9 rejects one. No timer runs while Pi is closed.

A timeout must therefore:

1. persist an absolute deadline when the interaction is requested;
2. be evaluated when the controller next wakes, resumes, or reloads;
3. promise no exact wall-clock notification while no Hypagraph process exists.

This is the same level-triggered recovery model which a check uses when it asks whether CI is green now. Do not describe a timeout as a scheduled action.

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
  timeout?: { deadline: InteractionDeadline; onTimeout: "block" | "select"; selectResponseId?: string };
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

An interaction attempt records the presentation observation, the presentation artifact reference, the selected response identifier, the published facts, the feedback artifact reference, and the free-text evidence reference.

### 4.4 Deadline

```ts
export interface InteractionDeadline {
  absolute: string;
  source: "requested-at-plus-duration" | "declared-absolute";
}
```

Store the absolute deadline when the request event is stored. Evaluate it on wake, resume, and reload. Never depend on a running timer.

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

### Slice 1.1 - Interactive presentation and the ask tool

Slice 1 makes an interaction node wait correctly, but no surface shows the question. A person cannot answer a question which they cannot read. This slice makes an interaction node usable from end to end.

Scope:

1. Add `hypagraph_ask`. This model tool presents one declared interaction node and accepts one typed answer.
2. Present an open question from the controller when the controller reaches the waiting-response stop.
3. Show the question, the response IDs, and the response labels in the waiting surfaces.
4. Add the `interaction` lane to the selectable history lanes.
5. Remove the `/hypagraph answer` command. Add `/hypagraph ask`, which presents an open question again. Add a `/hypagraph help` usage line.

Mandatory rules:

#### 1.1.1 Present only when no other action is runnable

A dialog stops the host turn. A host turn which stops also stops the scheduler. The tool and the controller must therefore open a dialog only when `enumerateGoalContinuationCandidates` returns no candidate. This rule keeps section 3.1.

#### 1.1.2 Store the request before the dialog opens

The controller must commit the request event before it opens a dialog. A host which reloads during a dialog must find a durable `awaiting_response` node.

#### 1.1.3 A dismissed dialog is not an answer

A dismissed dialog must leave the node in `awaiting_response`. Only a selected response can become an answer. The controller presents the question again on its next pass.

#### 1.1.4 A host without dialog capability keeps the durable wait

A host which reports no dialog capability must keep the durable wait and must not fail. An interaction node needs a person. A host with no dialog capability has no person, so the question stays open.

#### 1.1.5 A dialog is the only way to answer

Hypagraph must not accept a typed answer from a command. A command which accepts a node ID and a response ID makes the person do the work which the dialog does. Remove `/hypagraph answer`. Keep `/hypagraph ask`, because it presents the declared question and it consumes no model turn.

#### 1.1.6 Each dialog option must contain its response ID

Response labels are not unique. The dialog returns the option text. Each option must therefore start with its response ID, so the runtime can map the option text back to exactly one response.

Tests:

- the tool presents a ready interaction and stores the answer;
- the tool does not open a dialog while another action is runnable;
- a dismissed dialog leaves the node in `awaiting_response`;
- a host without dialog capability leaves the node in `awaiting_response`;
- the controller presents an open question when no other action is runnable;
- the waiting surface shows the question and every response ID;
- two responses with the same label map to different response IDs;
- the extension registers no command which accepts a typed answer.

Exit: a person answers a question through a dialog and never types a node ID or a response ID.

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

### Slice 3 - Routing, structured feedback, and deadlines

Scope:

1. Route on published facts through an existing gate with no new routing semantics.
2. Capture free text as evidence with a byte bound.
3. Capture a bounded structured feedback artifact and store it by identity.
4. Add the absolute deadline and level-triggered evaluation from rule 3.8.

Tests:

- free text never changes a route;
- a feedback artifact never changes a route;
- a feedback artifact reaches the next semantic task through its explicit context projection;
- a deadline which passed while Pi was closed is applied on the next wake;
- a deadline with `block` produces an explicit blocked node;
- a deadline with `select` publishes the declared default facts;
- a gate after an interaction behaves exactly as a gate after a check.

Acceptance case which must pass:

```text
plan annotation surface returns line annotations
    |
    v
responseId "changes_requested" publishes changes_requested = true
    |
    v
gate routes back to the worker task
    |
    v
worker receives the bounded annotation artifact in its context projection
```

Without this case, an interaction node can route to revision but cannot communicate canonically what the user requested.

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

## 5.1 Slice status

| Slice | Result | Evidence |
| --- | --- | --- |
| 1 | Node kind, wait state, and selector behaviour | `src/domain/validate.ts`, `src/domain/reducer.ts`, `tests/m6-1-interaction-slice-1.test.ts` |
| 2 | Deterministic presentation effects | Not started |
| 3 | Routing, structured feedback, and deadlines | Not started |
| 4 | Reload, restore, and product surface | Not started |
| 5 | Dogfood and release | Not started |

Slice 1 is complete in commit `45c26c9`. It adds the `interaction` node kind, the `awaiting_response` node status, the request and answer lifecycle, declared response facts, and a Pi command which accepts an answer. The wait stays node-local, so an independent branch and an independent loop stay runnable.

Two decisions were recorded during Slice 1.

1. Validation rejects a semantic presentation with a diagnostic which names the M7 model executor. Slice 2 lists this rule. Slice 1 needed the rule to accept a presentation class. `src/domain/validate.ts` holds it.
2. A node which waits for an answer is not a blocker. Blockage classification now excludes a wait-only state, so an outstanding question does not start automatic revision.

## 6. Acceptance criteria

- An interaction node performs its declared presentation effect through the durable lifecycle order.
- An unanswered interaction does not stop an independent runnable component.
- An unanswered interaction consumes no budget.
- A typed answer publishes declared facts and routes through an existing gate.
- Free text reaches evidence and never reaches a route.
- A structured feedback artifact reaches the next semantic task and never reaches a route.
- The plan-annotation acceptance case in Slice 3 passes.
- A definition which declares a semantic skill as deterministic fails validation.
- An unanswered interaction survives a reload and is presented again without a repeated effect.
- A deadline which passed while no Hypagraph process existed is applied on the next wake.
- The waiting state is derived and not stored.
- Replay reproduces the same answer, facts, route, and feedback artifact identity.

## 7. Out of scope

- semantic presentation, which needs the M7 executor;
- sandbox-backed presentation, which becomes available additively after M6.2;
- outbound delivery to an external service, for example Slack or email, which belongs to M6.3;
- external review systems, which belong to M6.3.

Displaying a result in Pi is not an external effect. It is a presentation action, and it belongs here.
