# Comparison with Grok Build workflows

- Status: reference
- Date: 2026-07-28
- Subject: Grok Build workflow system (`xai-workflow` + session host)
- Source: local tree `~/Development/reference-implementations/grok-build` at `SOURCE_REV` `1adcd1f4…`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

This note records how Grok Build workflows work, how they differ from
Hypagraph, and which ideas Hypagraph can take without losing its product model.

It is a source audit of the reference tree and the bundled
`create-workflow` skill. It is not a claim about a published product release.

## 2. Executive judgement

Grok Build workflows and Hypagraph solve different layers of the same problem.

| Layer | Grok Build workflow | Hypagraph |
| --- | --- | --- |
| What is authored | A Rhai orchestration script | A typed dependency graph |
| Who drives the run | The script, in process | The deterministic controller |
| Unit of semantic work | A cold subagent call | A task, check, gate, interaction, or future model-executor node |
| Concurrency | First-class `parallel()` barrier | Modelled; physical concurrency planned for M8 |
| Durable state | Host-call journal for same-process resume | Event stream with schema version, reload, and replay |
| Completion authority | `complete(value)` in the script | Workflow state only; the model has no completion tool |
| Human gate | `await_user` / `pause` | Interaction node and `hypagraph_ask` |
| Checks | Agent judgment, optional JSON Schema | Deterministic check executors and typed facts |
| Primary skill | `create-workflow` (author scripts) | `hypagraph` (author and run graphs from ordinary intent) |

Grok Build is a **breadth orchestrator for subagents**. Hypagraph is an
**execution-control graph** for durable, evidence-backed repository work.

Hypagraph must not adopt Rhai as its runtime model. It must reach the same
wide-work product results through graph primitives. That direction already
exists in `docs/deterministic-orchestration-plan.md`.

For session shape, Hypagraph must also match the Grok product rule that the
host drives the run and each unit of semantic agent work runs outside the main
chat. `docs/isolated-model-session-execution-plan.md` defines that routing work.

## 3. How Grok Build workflows work

### 3.1 Shape

A workflow is a Rhai script. The first statement must be a pure-literal meta
map:

```rhai
let meta = #{
    name: "deep-research",
    description: "…",
    phases: [ #{ title: "Plan" }, #{ title: "Research" } ],
};
```

The host then exposes orchestration functions only:

- `agent(prompt, opts?)` — spawn one subagent and wait;
- `parallel([opts…])` — spawn many subagents, barrier until all finish;
- `phase(title)`, `log(message)`;
- `complete(value)`, `await_user(kind, message)`, `pause(kind, message)`;
- `budget()`, scratch files, `git_diff_since`, `render_template`, `json_encode`,
  `fingerprint`.

Wall-clock time, sleep, exit, `eval`, and module import are disabled. The engine
enforces operation, depth, and size limits.

### 3.2 Host and budget

Each result-bearing host call is sequenced. `agent` and each `parallel` item
consume one slot of an absolute `agent_budget` (default 128, max 1024). A
parallel panel is admitted as one unit. If the panel would exceed the remaining
budget, none of its new children launch.

Agent options include label, model, capability mode (`read-only` through
`all`), worktree isolation, `resume_from`, phase, and `output_schema`. Schema
validation is host-side. One corrective retry can run when the schema fails.
Schema retries do not consume extra budget slots.

### 3.3 Journal resume

The journal records each host-call kind, a request hash, and the result. On
resume, the engine replays committed results and continues with live calls.

Important limits:

1. Resume is same-process only. A process exit marks the run `Interrupted`.
2. Resume is not exactly-once for external effects. An uncommitted call can run
   again.
3. Script edit mid-run causes hash divergence and fails.
4. Budget-limited resume requires a higher `agent_budget`.

### 3.4 Product surface

- Tool: `workflow` with `name` | `script` | `script_path`, `args`,
  `agent_budget`, `validate_only`, `resume_from_run_id`.
- Discovery: built-ins, project `.grok/workflows/`, user `~/.grok/workflows/`.
- UI: `/workflows` run dashboard, session-unique display names, phase rail.
- Smoke check: metadata + compile + one canned-host path. It is not full proof.
- Cap: four active workflow runs for each session.

### 3.5 Skill and patterns

The `create-workflow` skill is both procedure and language reference. It teaches
patterns that the shipped `deep-research` built-in also uses:

1. Build the work list deterministically; spend agents on judgment.
2. Re-filter agent output in the script; never trust prompt-only scope rules.
3. Adversarial verification with fail-closed evidence gates.
4. Vote panels by flat `parallel` and index arithmetic.
5. Loop until dry with fingerprints for stall detection.
6. Guard every optional result; log silent truncation.
7. Force tool use in cold-subagent prompts; empty answers need explicit rules.
8. JSON-encode untrusted data before prompt interpolation.

`deep-research.rhai` is a full example: plan → parallel research → sharded
verify with exact claim-ID membership checks → synthesis report with citation
packet discipline and partial status when coverage fails.

### 3.6 What Grok Build does not do

- No dependency graph of named durable nodes.
- No typed fact store with producer provenance.
- No deterministic check executors for tests, lint, coverage, or git state.
- No gate language over workflow metadata.
- No SCC loop regions with patience and evaluation contracts.
- No model-completion ban; the script decides completion.
- No cross-process durable goal lifecycle.
- No graph revision with invalidation of downstream work.
- No independent branch lifecycle while a human gate waits.

## 4. How Hypagraph works

### 4.1 Shape

A workflow is a versioned graph plus canonical runtime state. A Hypagoal owns
one workflow and supplies budget, continuation, pause, and resume.

Node kinds in product use or plan:

- task, check, gate (shipped);
- interaction (M6.1, in progress);
- code, effect (planned);
- model-executor, aggregate (planned for wide work).

Edges are requires, route, data, feedback, and future child-return.

### 4.2 Who drives the run

The controller:

1. validates the definition;
2. derives readiness;
3. selects the next continuation action;
4. dispatches deterministic work without a model turn when possible (M6A);
5. charges model turns only when a model must act;
6. derives terminal and blocked state from workflow state.

The model authors the graph, performs selected task work, and answers
controller prompts. The model cannot mark a goal complete.

### 4.3 Durable state

One durable event sequence defines one workflow aggregate. Schema versions,
snapshot hashes, restore, and M6B timeline or replay tools support inspection.
Outstanding interaction answers survive reload. Replay must not re-prompt for a
stored answer.

### 4.4 Skill

The `hypagraph` skill is automatic graph authoring for ordinary repository
requests. It does not wait for the user to say "workflow". It teaches:

- smallest useful graph;
- evidence-gated completion;
- deterministic checks and gates;
- bounded loops and evaluation contracts;
- continuation rules and budget honesty;
- protected evaluator redaction.

### 4.5 What Hypagraph does not yet do

- Physical concurrent subagent fan-out (M8).
- Worktree isolation per attempt (M8).
- Named reusable workflow library with slash-command launch.
- First-class adversarial multi-model review quorum (planned aggregate + M7).
- Script-style free orchestration over intermediate variables.
- Same-process edit-and-replay of a frozen orchestration script.

## 5. Direct comparison

### 5.1 Control model

Grok Build: control flow lives in script code. Intermediate results live in
script variables. Concurrency is explicit. Determinism means "same script +
same journal ⇒ same host calls".

Hypagraph: control flow lives in graph structure and the controller. Intermediate
results live in typed facts, evidence, and node status. Determinism means
"reducer and checks have no clock, randomness, or I/O; replay reconstructs
state".

### 5.2 Where the model spends turns

Grok Build spends a model turn on every leaf agent. Orchestration itself is not
a model turn once the script exists, but authoring or re-authoring a script is
model work, and many patterns still use planner or synthesizer agents.

Hypagraph spends a model turn on authoring, on selected tasks, and on future
model-executor leaves. Gates, checks, aggregates, readiness, and continuation
selection must stay outside the model lane.

### 5.3 Human interaction

Grok Build pauses the whole script with `await_user` or `pause`. Resume continues
past the gate in the same process.

Hypagraph waits on a node with `awaiting_response`. Independent runnable
components continue. That property is a design rule, not an accident.

### 5.4 Verification quality

Grok Build verification is multi-agent judgment with schema and script filters.
It is strong for design review and research claims. It is weak for "tests pass"
when a real command check exists.

Hypagraph verification is strongest when a deterministic instrument exists. It
is weaker today for multi-model review panels, because those need M7 and
aggregate reduction.

### 5.5 Durability and recovery

Grok Build journal resume is excellent for interactive multi-agent runs inside
one process. It is not a product goal lifecycle across reloads.

Hypagraph event durability is excellent for long-lived goals across reload and
branch change. It is not yet a concurrent multi-agent runner.

### 5.6 Authoring UX

Grok Build optimises for "write or pick a named workflow, pass args, watch
`/workflows`". The create-workflow skill is outstanding for that path.

Hypagraph optimises for "user states repository intent; the model compiles a
graph; the controller runs it". The user need not know graphs exist.

## 6. What Hypagraph can learn

### 6.1 Adopt as product behaviour

1. **Named reusable workflows.** Ship and discover graph definitions as named
   recipes (project and user libraries). Launch with args. Keep start as a
   Hypagoal creation, not a goalless run.

2. **Phase rail and run dashboard.** Present phases, agent or node progress,
   budget spent, and partial status the way `/workflows` does. Map phases to
   graph regions or declared presentation groups.

3. **Absolute agent-call budget for wide work.** When M7 and M8 land, charge
   model-executor leaves against a hard run cap. Admit a fan-out panel as one
   atomic unit, or reject the whole panel.

4. **Output schemas on model leaves.** Require JSON Schema (or fact contracts
   with the same force) on model-executor results. Fail closed. One corrective
   retry is enough; do not invent success.

5. **Fail-closed verification panels.** For review quorum and research claims,
   missing or failed verification is not approval. Script patterns in
   `deep-research` and `create-workflow` are the product standard.

6. **Capability modes and isolation on leaves.** Read-only reviewers must not
   write. Parallel writers need worktree isolation and an explicit merge step.

7. **Self-contained leaf prompts.** Cold executors must not depend on parent
   chat. Encode context through an explicit projection. Force tool use when the
   leaf must inspect the repository.

8. **Validate-only smoke path.** Before a live wide run, validate definition
   shape and one deterministic probe path. State the limits of the probe
   clearly, as Grok Build does for `validate_only`.

9. **Display names for runs.** Prefer human handles over internal IDs in the
   UI and slash commands.

### 6.2 Adopt as authoring skill content

Extend `skills/hypagraph/SKILL.md` (or a sibling skill for orchestration
recipes) with:

- work-list construction rules (deterministic list first);
- re-filter of untrusted model discovery output;
- adversarial verification template for design review;
- vote and quorum patterns expressed as future aggregate strategies;
- stall detection with fingerprints for search loops;
- prompt rules for cold subagents;
- partial-status reporting when coverage is incomplete.

### 6.3 Do not adopt

1. **Rhai (or any general script) as the canonical runtime.** It recreates the
   script-orchestration product and breaks the graph contract.

2. **Script-owned completion.** Keep completion derived from workflow state.

3. **Whole-run pause as the only human gate.** Keep node-local waits so
   independent work continues.

4. **Same-process-only durability for goals.** Hypagoals must survive reload.

5. **Unstructured intermediate variables as the fact store.** Facts need
   producers, types, and provenance.

6. **Model panels as a substitute for command checks.** When a test or lint
   exists, run it.

## 7. Mapping Grok primitives to Hypagraph

| Grok Build | Hypagraph form | State |
| --- | --- | --- |
| `agent` | Task or M7 model-executor node | Partial / planned |
| `parallel` | Independent ready nodes + M8 concurrency | Modelled, not physical |
| `phase` | Presentation group or region label | Missing as first-class UI |
| `complete` | Derived workflow terminal state | Shipped |
| `await_user` | Interaction node | M6.1 in progress |
| `pause` for missing args | Validation or start-time rejection | Partial |
| `output_schema` | Fact contracts + future executor validation | Partial |
| `agent_budget` | Goal budget + future agent-call cap | Partial |
| `isolation_worktree` | M8 workspace lease | Planned |
| `capability_mode` | Scope + executor policy | Partial |
| Journal resume | Event stream + M6B replay | Stronger for goals |
| Named `.rhai` library | Named graph recipe library | Missing |
| `validate_only` | Definition validation + probe run | Partial |
| Adversarial verify panel | Aggregate quorum over model-executor branches | Planned |
| Vote / ranked / collect | Aggregate strategies | Planned |
| Collate branch output into a brief | Synthesis node, a model leaf | Planned |
| Scratch report artifact | Artifact store + presentation | Partial |

## 8. Recommended Hypagraph work order

These items improve Hypagraph without copying the script model.

1. Finish M6.1 interaction presentation so human gates match Grok usability.
2. Keep the deterministic orchestration plan: branch-scoped facts, then
   aggregate, then M7 model-executor, then M8 concurrency and leases.
3. Add a named recipe library and launch-with-args path that always starts a
   Hypagoal.
4. Add a run dashboard and phase-style progress for multi-node goals.
5. Codify adversarial review and deep-research as graph recipes once M7 and
   aggregate exist. One product idea is **The Gauntlet**: specialised
   implementers, discover and user-confirm references, blind critique against
   real examples. Exact topology is open. See
   `docs/gauntlet-built-in-hypagoal.md`.
6. Expand the skill with cold-agent prompt rules, fail-closed verification, and
   work-list filtering now, even before full concurrency ships.

## 9. Product answer for deep research

A deep-research run is a Hypagoal. The objective is the research query. The
graph is the method: plan, parallel research leaves, verification aggregate,
report task, optional human review.

The Grok Build built-in proves the product shape. Hypagraph should deliver that
shape with:

- durable events across reload;
- typed facts and evidence;
- deterministic reduction of votes;
- interaction nodes that do not starve independent work;
- no model completion claim.

## 10. Sources in the reference tree

- `crates/codegen/xai-workflow/` — engine, journal, meta, validate, host API
- `crates/codegen/xai-grok-tools/.../workflow/` — `workflow` tool surface
- `crates/codegen/xai-grok-shell/src/session/workflow/` — manager, store,
  tracker, host service, registry
- `crates/codegen/xai-grok-shell/src/session/workflows/deep_research.rhai`
- Bundled skill: `~/.grok/bundled/skills/create-workflow/SKILL.md`

Related Hypagraph docs:

- `docs/product-spec.md`
- `docs/deterministic-orchestration-plan.md`
- `docs/trigger-and-command-surface-plan.md`
- `docs/m6-1-interaction-node-plan.md`
- `docs/research/pi-dynamic-workflows-comparison.md`
- `docs/research/pi-workflows-comparison.md`
- `skills/hypagraph/SKILL.md`
