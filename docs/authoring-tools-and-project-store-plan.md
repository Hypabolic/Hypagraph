# Authoring tools and project store plan

- Status: Wave 7 slices A–D (S7.1–S7.4) code complete; Slice E deferred; Slice F partial (import path via free-form definition only)
- Applies to: Hypagoal and Hypagraph authoring, project durability, repository layout
- Related: `docs/automatic-graph-authoring.md`, `docs/durable-lifecycle-storage.md`, `docs/trigger-and-command-surface-plan.md`, `docs/loop-region-product-model.md`
- Roadmap source: `docs/execution-roadmap.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

This plan defines two related product changes.

1. Replace free-form definition JSON as the primary model authoring interface with argument-driven construction tools and recipes.
2. Store Hypagraph project data under a durable repository directory named `.hypagraph`.

The two changes share one lifecycle. The model builds a draft through tools. The host stores the draft and the committed definition on disk. Canonical runtime state remains an append-only event stream.

## 2. Problem

### 2.1 Authoring interface

Today the model must emit one complete `HypagraphDefinition` tree into `hypagoal_start` or `hypagraph_define`.

That interface fails in practice for these reasons:

1. Many constraints are relational, not local. A feedback edge must also exist as a `requires` edge. Loop nodes must equal one cyclic component.
2. The schema is wide. Most fields are optional. Models invent shapes which the validator rejects.
3. Failure is late. The model learns structural errors only after it assembles the full tree.
4. Repair is a full rewrite. One edge fix often regenerates a large nested object.

A real authoring failure has this form:

```text
invalid_feedback_edge: Feedback edge 'quorum-review -> implement' must be a dependency
loop_scc_mismatch: The nodes in loop 'implement-review-loop' must be the same as one cyclic component
```

The model declared loop metadata without the cycle-closing dependency.

### 2.2 Project durability

Today durable runtime state lives mainly in the Pi session journal. The repository already uses `.hypagraph` for check artifacts and worktrees, but it does not store:

- authoring drafts;
- committed workflow definitions as repository artifacts;
- a project-level index of active and historical graphs;
- a clear boundary between session restore and project restore.

A graph which exists only inside one Pi session is hard to inspect, diff, review, resume after session loss, or share across tools.

## 3. Decision

### 3.1 Authoring decision

Keep JSON as the canonical definition format.

Do not keep free-form JSON as the primary LLM authoring interface.

The model must construct graphs through:

- low-level construction tools with small argument sets;
- high-level recipes for common patterns;
- validate and commit tools.

The runtime owns defaults and invariants during construction. Illegal states must be unrepresentable where practical, or rejected immediately with a repair suggestion.

### 3.2 Storage decision

Use `.hypagraph/` as the project store root inside the repository working tree.

Store:

- authoring drafts;
- committed definitions and identity metadata;
- check artifacts;
- worktree parents;
- project indexes.

Do not move the pure domain reducer onto the filesystem. Disk I/O stays in the host and storage adapters.

### 3.3 Source of truth rule

Keep these layers separate.

| Layer | Source of truth | Role |
| --- | --- | --- |
| Canonical runtime | Append-only domain event stream | Workflow and goal lifecycle, attempts, facts, loops, budgets |
| Project definition artifact | `.hypagraph/workflows/<id>/definition.json` and related metadata | Inspectable committed graph definition for the project |
| Authoring draft | `.hypagraph/drafts/<id>/` | Mutable pre-commit construction state |
| Session journal | Pi custom entries | Session restore and optimistic append for live execution |

A committed definition artifact is a project product. It is not an independent runtime authority. Runtime state rebuilds from events. Definition changes still enter the event stream through define, start, or revise commands.

## 4. Goals

1. The model can author a valid implement and verify loop without writing `feedbackEdges` by hand.
2. Structural validation can run before create.
3. A failed construction step can fix one node or edge without rewriting the whole graph.
4. A draft and a committed definition survive process exit and session reload when the project store is present.
5. A user or tool can open a committed definition on disk without reading Pi session internals.
6. Existing pure-domain invariants stay unchanged.
7. Full-definition import remains available for tests and advanced cases.

## 5. Non-goals

This plan does not:

1. replace the event stream with files as runtime authority;
2. adopt a JavaScript or Rhai orchestration script as the Hypagraph kernel;
3. require the user to design nodes or edges;
4. force every ordinary request through a multi-tool construction dialogue when a recipe can emit the draft in one call;
5. implement live trigger editor highlight (owned by `docs/trigger-editor-highlight-plan.md`);
6. migrate every historical Pi-only workflow into `.hypagraph` in the first slice;
7. add a network service or resident supervisor for drafts.

## 6. Product model

### 6.1 Authoring session

An authoring session binds:

- objective prose;
- creation request identity when `/hypagoal` started the turn;
- session and branch generations;
- draft identity;
- optional replacement confirmation for root replacement.

The authoring session is read-only for repository implementation work. It may inspect the repository. It must not write product code through edit tools while the draft is open, unless a later product rule explicitly changes this.

### 6.2 Draft

A draft is a mutable intermediate graph under construction.

A draft must:

- have a schema version;
- have a stable draft id;
- record the objective;
- record construction history enough for diagnosis;
- project a candidate `HypagraphDefinition` at any time;
- support partial validation;
- never become live runtime state before commit.

A draft is not a workflow. Only commit creates or revises canonical workflow state.

### 6.3 Commit

Commit validates the projected definition, then performs one of these actions:

- create a root Hypagoal through the existing atomic creation path;
- define a workflow without goal control only if that path still exists and the product still allows it;
- prepare a revision candidate for the controller revision path.

Commit must not leave a half-written project artifact and a live runtime that disagree. Write the project artifact and the runtime event batch under one host-level commit protocol. If either side fails, expose no partial active root.

### 6.4 Recipe

A recipe is a high-level constructor for a common pattern.

Recipes exist because low-level tools alone can cost too many turns for simple work.

Examples:

- linear task then check;
- implement and verify loop;
- gate split with two branches;
- evaluation-backed improvement loop when a metric exists.

A recipe returns a draft or mutates the current draft. It does not bypass validation.

## 7. Authoring tool surface

### 7.1 Design rule

Prefer constrained composition.

Tools encode defaults and invariants. They do not recreate the full free JSON surface under another name.

### 7.2 Draft lifecycle tools

| Tool | Purpose |
| --- | --- |
| `hypagraph_draft_begin` | Create a draft bound to objective and authoring identity |
| `hypagraph_draft_status` | Show draft id, node count, diagnostics, and projected summary |
| `hypagraph_draft_validate` | Run structural validation on the projected definition |
| `hypagraph_draft_discard` | Drop a draft and its project-store files |
| `hypagraph_draft_import` | Import a full definition into a draft for tests or advanced repair |
| `hypagraph_commit` / `hypagoal_start` | Validate and commit. Prefer commit of draft id over free-form definition |

### 7.3 Low-level construction tools

| Tool | Purpose |
| --- | --- |
| `hypagraph_add_task` | Add one task node with title, acceptance, scope, and optional produces |
| `hypagraph_add_check` | Add one check node with executor contract and produces |
| `hypagraph_add_gate` | Add one gate with typed condition and routes |
| `hypagraph_add_code` | Add one code node with program and capability allowlist |
| `hypagraph_add_effect` | Add one effect node with effect and reconcile programs |
| `hypagraph_add_interaction` | Add one interaction node |
| `hypagraph_require` | Add dependency `to` requires `from` |
| `hypagraph_set_produces` | Set or replace fact contracts on a node |
| `hypagraph_set_policy` | Set workflow policy fields |
| `hypagraph_loop` | Declare a bounded loop over an existing path |
| `hypagraph_remove_node` | Remove a node and incident draft edges |

### 7.4 Loop construction contract

The loop tool owns cycle-closing structure.

Required arguments:

- `loopId`
- `entry`
- `evaluateAfter`
- `successWhen`
- `maxIterations`

Optional arguments:

- `progress`
- `patience`
- `evaluation`
- `failurePolicy`
- `nodes` only when the author must name an SCC that is not auto-derived

Host behaviour:

1. Ensure a path from `entry` to `evaluateAfter` through current `requires` edges.
2. Add or keep the cycle-closing dependency: `entry.requires` includes `evaluateAfter`.
3. Set `feedbackEdges` to `[{ from: evaluateAfter, to: entry }]`.
4. Derive `nodes` as the cyclic component that contains that feedback, or validate a supplied node set against that component.
5. Reject immediately when the path or SCC cannot be formed.

The model must not hand-author `feedbackEdges` in the normal path.

### 7.5 Recipe tools

| Tool | Purpose |
| --- | --- |
| `hypagraph_recipe_linear` | One or more ordered tasks plus optional final check |
| `hypagraph_recipe_implement_verify_loop` | Two-node loop with typed success fact |
| `hypagraph_recipe_gate_split` | Gate with explicit true and false branch node sets |
| `hypagraph_recipe_evaluation_loop` | Improvement loop only when a metric contract is supplied |

Recipe names are product vocabulary. They must stay stable once released.

### 7.6 Hybrid escape hatch

Keep full-definition import for:

- unit and dogfood fixtures;
- advanced graphs which recipes cannot express yet;
- recovery when a draft was hand-edited on disk under an explicit advanced mode.

The default skill and `/hypagoal` authoring prompt must teach tools and recipes first. They must not teach free-form loop JSON as the normal path.

### 7.7 Tool result contract

Every construction tool returns:

- `ok` or rejection;
- draft id;
- short projected summary;
- diagnostics with code, message, location, and suggestion;
- advisories when useful.

Do not return only a Boolean. The model needs a repair path.

## 8. Project store under `.hypagraph`

### 8.1 Root layout

```text
.hypagraph/
  README.md
  settings.json
  index.json
  drafts/
    <draftId>/
      draft.json
      history.jsonl
  workflows/
    <workflowId>/
      meta.json
      definition.json
      latest-snapshot.json
      events/                 # optional export or mirror; see 8.5
  check-artifacts/            # existing
  worktrees/                  # existing
```

All persisted records must include a schema version.

### 8.2 Existing paths

Keep current uses:

- `.hypagraph/check-artifacts`
- `.hypagraph/worktrees`

Do not rename them in this plan. New stores must sit beside them.

### 8.3 Draft files

`drafts/<draftId>/draft.json` holds:

```ts
interface HypagraphDraftRecord {
  schemaVersion: 1;
  draftId: string;
  createdAt: string;
  updatedAt: string;
  objective: string;
  status: "open" | "validated" | "committed" | "discarded";
  creationRequest?: {
    operationId: string;
    sessionGeneration: number;
    branchGeneration: number;
  };
  replacementConfirmation?: unknown;
  title?: string;
  goal: string;
  nodes: unknown[];          // draft node records
  edges: Array<{ from: string; to: string }>;
  loops: unknown[];          // draft loop records
  policy?: unknown;
  evaluation?: unknown;
  constructionNotes?: Array<{ code: string; message: string }>;
}
```

`history.jsonl` is an append-only local construction log. It is for diagnosis. It is not the domain event stream.

### 8.4 Workflow files

After commit, write:

```text
workflows/<workflowId>/meta.json
workflows/<workflowId>/definition.json
```

`meta.json` holds:

```ts
interface HypagraphWorkflowMeta {
  schemaVersion: 1;
  workflowId: string;
  goalId?: string;
  objective: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  definitionRevision: number;
  sourceDraftId?: string;
  status: "active" | "superseded" | "archived";
}
```

`definition.json` holds the canonical `HypagraphDefinition` after normalization and validation.

`latest-snapshot.json` is optional. If written, it is a cache of the latest projected runtime snapshot for inspection. It is not authority over the event stream.

### 8.5 Event stream and project store

There are two acceptable designs for events. Choose one in implementation slice planning and keep it explicit.

**Option A. Session-first events**

- Pi journal remains the live event store.
- `.hypagraph` stores definitions, drafts, artifacts, and optional exported snapshots.
- Project resume may require the session journal or an export step.

**Option B. Project-first events**

- `.hypagraph/workflows/<id>/events/` is the durable event log for the workflow.
- Pi journal stores pointers and session-local delivery state.
- Restore can rebuild from the project store without the original Pi session.

This plan recommends **Option B for v1.0**, because graph durability is a product claim. Option A is acceptable as a transitional slice if the first delivery only adds drafts and committed definitions.

Rules for Option B:

1. The domain reducer stays pure.
2. The host appends event batches to project storage with the same optimistic sequence rules as `docs/durable-lifecycle-storage.md`.
3. Pi session entries may mirror batches or store references.
4. Restore prefers project storage when both exist and hashes agree.
5. Hash mismatch is a hard error.

### 8.6 Project index

`index.json` lists known drafts and workflows for status commands and UI.

```ts
interface HypagraphProjectIndex {
  schemaVersion: 1;
  drafts: Array<{ draftId: string; status: string; updatedAt: string; objective: string }>;
  workflows: Array<{ workflowId: string; goalId?: string; status: string; updatedAt: string; title: string }>;
}
```

The index is a cache. Rebuild it from directory contents when it is missing or corrupt.

### 8.7 Settings

`settings.json` may hold:

- default trigger word later;
- store options;
- retention limits for discarded drafts;
- whether project-first events are enabled.

All settings must be versioned.

### 8.8 Git policy

Recommend:

```gitignore
.hypagraph/check-artifacts/
.hypagraph/worktrees/
.hypagraph/drafts/
```

Committed definitions under `.hypagraph/workflows/` may be tracked when a team wants reviewable graphs. That choice is a product setting, not a hard requirement in the first slice.

Do not commit large check artifacts or worktrees.

### 8.9 README in store

Write `.hypagraph/README.md` once when the store is created. State:

- what the directory contains;
- what is safe to delete;
- that runtime authority is the event stream or project event log according to the chosen option;
- that users should not hand-edit draft files during a live authoring turn.

## 9. Host and domain boundaries

### 9.1 Domain

The domain owns:

- draft projection to `HypagraphDefinition`;
- validation;
- recipe expansion pure functions;
- loop structure derivation;
- create and revise command validation;
- event application.

The domain must not read the clock for reduction of runtime commands. Draft timestamps are host metadata and are not used as domain control inputs.

### 9.2 Host

The host owns:

- filesystem paths under `.hypagraph`;
- draft file create, update, and discard;
- project index maintenance;
- commit protocol across disk and event append;
- Pi tool registration and authoring-turn guards;
- UI status for drafts and workflows.

### 9.3 Purity

A pure function may accept a draft record and return a new draft record or diagnostics.

A pure function must not:

- read files;
- write files;
- access the network;
- create random identifiers without an injected id source.

Identifier creation for drafts may use host-supplied ids.

## 10. `/hypagoal` authoring flow after this plan

1. User runs `/hypagoal <objective>` or a later armed natural-language start.
2. Host creates authoring identity and opens a draft in `.hypagraph/drafts/`.
3. Model inspects the repository.
4. Model prefers a recipe when the work fits a common pattern.
5. Model uses low-level tools for remaining structure.
6. Model calls validate.
7. Model calls commit through `hypagoal_start` with draft id and creation request.
8. Host validates, writes workflow artifacts, appends the creation event batch, and marks the draft committed.

If validation fails, the draft remains open. The model repairs with tools and retries commit with the same creation request.

## 11. Revision flow

Construction tools are not graph authority during execution.

Planner nodes still produce work products and facts only.

Graph change remains controller revision:

1. Open a revision draft from the current definition.
2. Apply construction tools to the revision draft.
3. Validate non-weakening and other revision rules.
4. Commit through the revision command path.

Do not give ordinary task tools the right to mutate topology.

## 12. Skill and prompt changes

Update:

- `skills/hypagraph/SKILL.md`
- `buildHypagoalAuthoringPrompt`
- tool `promptGuidelines`

Teach this order:

1. inspect repository;
2. choose smallest useful shape;
3. call recipe or low-level tools;
4. validate;
5. commit draft;
6. stop implementation work.

Remove free-form loop JSON as the primary teaching example after the loop tool ships. Keep one advanced import example in developer docs only.

## 13. Error model

Use stable diagnostic codes.

Examples:

- `draft_not_found`
- `draft_not_open`
- `draft_stale_creation_request`
- `unknown_node`
- `duplicate_node`
- `missing_path_for_loop`
- `loop_scc_mismatch`
- `invalid_feedback_edge`
- `project_store_unavailable`
- `project_schema_unsupported`
- `commit_sequence_conflict`

Every rejection must include a suggestion when a repair is possible.

## 14. Implementation slices

### Slice A. Project store skeleton

Deliver:

- `.hypagraph` root creation;
- versioned `index.json` and `settings.json`;
- README;
- draft directory helpers;
- tests for create, read, rebuild index, unsupported schema rejection.

No model tool change required yet.

### Slice B. Draft model and validate tool

Deliver:

- pure draft record and projection;
- `hypagraph_draft_begin`
- `hypagraph_draft_status`
- `hypagraph_draft_validate`
- `hypagraph_draft_discard`
- disk persistence for open drafts.

### Slice C. Low-level constructors and loop tool

Deliver:

- add task, check, require;
- loop tool with owned feedback edges;
- tests for the historical implement and review failure mode;
- skill and authoring prompt update for constructors.

### Slice D. Recipes and commit-by-draft-id

Deliver:

- implement and verify recipe;
- linear recipe;
- `hypagoal_start` accepts `draftId` as the normal path;
- free-form definition remains optional import only;
- committed `workflows/<id>/definition.json` and `meta.json`.

### Slice E. Project-first event durability

Deliver:

- workflow event log under `.hypagraph/workflows/<id>/`;
- host append protocol aligned with durable lifecycle rules;
- restore from project store;
- dogfood for session loss with project store present.

### Slice F. Revision drafts and advanced import

Deliver:

- revision draft from current definition;
- construction tools on revision drafts;
- import path for fixtures;
- retention policy for discarded drafts.

## 15. Acceptance criteria

### Authoring

1. A model can create a valid two-node implement and verify loop through the loop tool or recipe without supplying `feedbackEdges`.
2. A draft that omits the cycle-closing dependency is repaired by the loop tool or rejected with a suggestion before commit.
3. `hypagraph_draft_validate` reports the same structural class of errors as definition validation.
4. Commit with a valid draft creates one root Hypagoal and does not require a free-form definition argument.
5. Commit with an invalid draft leaves canonical state unchanged and keeps the draft open.

### Project store

1. Every persisted record has a schema version.
2. Unsupported schema versions fail with a clear error.
3. Drafts survive process restart when files remain on disk.
4. Committed definitions are readable under `.hypagraph/workflows/<id>/definition.json`.
5. Check artifacts and worktrees remain under their current `.hypagraph` paths.
6. The pure reducer still does not touch the filesystem.

### Compatibility

1. Existing event-stream replay tests continue to pass.
2. Fixture-based full-definition define and start paths continue for tests.
3. No compatibility alias for an old product name is added.

## 16. Risks

1. Too many low-level tools can increase authoring turn count. Mitigate with recipes.
2. Dual storage can diverge. Mitigate with one commit protocol and hash checks.
3. Tracked workflow files can create noisy diffs. Mitigate with settings and clear git guidance.
4. Hand-edited draft files can corrupt construction. Mitigate with schema validation on load and a warning in README.
5. Project-first events are a large step. Do not block constructor authoring on Slice E.

## 17. Open decisions

Record the chosen answer before implementation of the affected slice.

1. Is free-form `definition` removed from the normal `hypagoal_start` path after Slice D, or only demoted in prompts?
2. Are committed workflow definitions git-tracked by default?
3. Does Slice E land before or after trigger arming?
4. What retention period applies to discarded drafts and superseded workflow artifacts?
5. Can more than one open draft exist per session, or only one authoring draft at a time?

Recommended defaults:

1. Demote free-form definition in product prompts. Keep the parameter for import and tests until a later cleanup.
2. Do not git-track workflow definitions by default. Allow an opt-in setting.
3. Deliver constructor authoring before trigger arming. Arming a weak authoring path multiplies bad graphs.
4. Retain discarded drafts for a short local period, for example seven days, then delete.
5. Allow one open `/hypagoal` draft per session generation by default. Additional drafts need an explicit advanced begin.

## 18. Relation to other plans

| Plan | Relation |
| --- | --- |
| `docs/automatic-graph-authoring.md` | Remains the product rule that users supply intent, not graph design. This plan changes the model interface used to compile intent. |
| `docs/durable-lifecycle-storage.md` | Remains the event-batch and sequence contract. Slice E places that contract on project storage. |
| `docs/trigger-and-command-surface-plan.md` | Arming and commands come after authoring quality improves. |
| `docs/loop-region-product-model.md` | Loop meaning is unchanged. The loop tool encodes the structural contract. |
| `docs/research/pi-dynamic-workflows-comparison.md` | Borrow constructor UX only. Do not adopt script orchestration as the kernel. |

## 19. Immediate next work

1. Accept or amend this plan.
2. Resolve the open decisions in section 17.
3. Implement Slice A and Slice B.
4. Implement Slice C with tests for the feedback-edge failure mode.
5. Implement Slice D and update the skill and authoring prompt.
6. Schedule Slice E as the durability milestone for project-first events.
7. Keep trigger arming behind authoring-tool quality.
