# The Gauntlet — built-in Hypagoal recipe

- Status: design idea (not implemented)
- Kind: named built-in Hypagoal recipe
- Product analogy: Grok Build named workflows (for example deep research)
- Depends on: fixed-width review quorum (deterministic orchestration slices 1–3),
  M7 model-executor nodes, M6.1 interaction for reference confirmation,
  optional M8 concurrency for parallel critics
- Related: `docs/deterministic-orchestration-plan.md`,
  `docs/research/grok-build-workflows-comparison.md`,
  `docs/goal-family-and-concurrent-execution-plan.md`,
  `docs/m6-1-interaction-node-plan.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

Ship one built-in Hypagoal that a user can start with a plain goal and a small
set of arguments. The recipe is fixed. The graph is not invented ad hoc on each
run. The controller owns orchestration after the recipe materialises.

The Gauntlet is that recipe. It turns one user goal into specialised implementer
work, then forces **blind** critic verification against real work and
best-in-class reference examples before the goal can complete.

The graph **finds** candidate references when the user does not already pin a
complete set. The graph then **confirms** the reference set with the user
before any implementer or critic uses it as the quality bar.

## 2. Product shape

### 2.1 What the user supplies

| Argument | Meaning |
| --- | --- |
| `goal` | The durable objective in ordinary language |
| `scope` | Optional path allowlist or package boundary |
| `seed_references` | Optional paths, URLs, or pinned examples the user already trusts |
| `reference_hints` | Optional search hints (repos, packages, patterns, “like X”) |
| `acceptance` | Optional typed acceptance bullets or test commands |
| `critic_count` | Fixed number of critic branches (default fixed in the recipe) |
| `human_gate` | Optional final interaction before merge or ship |

The user does not design the graph. The user does not name nodes. Launch is one
command or one Hypagoal start with those args, similar to a named Grok workflow.

`seed_references` is optional. When it is empty or incomplete, the recipe runs
reference discovery. When it is non-empty, discovery may still propose additions.
**No reference set is final until the user confirms it.**

### 2.2 What the recipe produces

A validated workflow that:

1. **Discovers** candidate best-in-class examples and equivalent code for the goal
   (from seed inputs, repository search, and declared hints);
2. **Confirms** the proposed reference set with the user through an interaction
   node before implementers or critics consume it;
3. **Decomposes** the goal into specialised implementer nodes (for example API,
   data model, UI, tests, docs) according to the work, not one monolithic task;
4. **Implements** each specialisation as a bounded task (or child Hypagoal when
   M7 lands) with explicit produces and evidence;
5. **Assembles** a candidate result (working tree change, design artifact, or
   package surface);
6. **Blind-verifies** that candidate with independent critic nodes that do not
   see implementer chain-of-thought or self-justifying narrative;
7. **Gates** progress on critic facts and deterministic checks that compare the
   candidate to the **confirmed** references and acceptance criteria;
8. **Loops** only when the quorum fails, with a synthesis brief that carries
   fixable defects, not free-form chat.

## 3. Reference discovery and user confirmation

This phase runs **before** specialised implementation and **before** critics.

### 3.1 Why discovery is in the graph

A quality bar that only the model invents is weak. A quality bar that only the
user must type by hand is heavy. The Gauntlet does both:

1. the graph proposes references from real code and known examples;
2. the user accepts, rejects, or edits the set;
3. only the confirmed set is durable for the rest of the run and for replay.

### 3.2 Discovery inputs

| Input | Role |
| --- | --- |
| `goal` | What kind of deliverable to match |
| `scope` | Where in the tree discovery may search |
| `seed_references` | User-trusted starting examples (may be empty) |
| `reference_hints` | Search hints, package names, “like module Y” |

### 3.3 Discovery outputs (candidate set)

Discovery publishes a structured candidate list, not free prose only. Each
candidate records at least:

| Field | Meaning |
| --- | --- |
| `id` | Stable identity for the run |
| `kind` | `in-repo` \| `sibling-package` \| `external-url` \| `fixture` \| other fixed kinds |
| `locator` | Path, package id, or URL |
| `why` | Short reason this is a bar for the goal (model text; not a route fact) |
| `seed` | Whether the user supplied it in `seed_references` |
| `selected_default` | Whether discovery recommends it on by default |

Deterministic checks may validate that in-repo locators exist and that URLs are
well-formed. They do not accept the quality bar for the user.

### 3.4 Confirmation interaction (mandatory)

After discovery, an **interaction** node (M6.1) presents the candidate set and
asks the user to confirm what will be used.

Presentation should show, for each candidate:

- locator and kind;
- why it was proposed;
- whether it was a seed or a discovery hit;
- the default selected state.

The user can:

1. **approve** the recommended set;
2. **edit** the set (drop items, keep seeds only, add a path or URL);
3. **reject** and request another discovery pass with a note (bounded retries);
4. **abort** the Gauntlet when no acceptable bar exists.

Closed outcomes publish typed facts, for example:

- `gauntlet.references_confirmed` (boolean);
- `gauntlet.confirmed_reference_ids` (structured list / ids the graph stores);
- optional `gauntlet.rediscover` when the user requests another discovery pass.

Open free-text notes may explain edits. Free text does not route. Only confirmed
ids and the boolean route the next nodes.

### 3.5 Sealed confirmed set

When `gauntlet.references_confirmed` is true:

1. the controller stores the confirmed reference set as durable workflow facts
   or artifacts for the run;
2. implementers may read the confirmed set as the quality bar for the kind of
   work (not as critic secrets);
3. critics receive the confirmed set as the only reference input;
4. replay restores the same confirmed set and does not re-prompt unless the
   interaction answer is absent (normal M6.1 restore rules).

When confirmation fails or the user aborts, dependants that need references do
not run. The goal does not pretend to have a bar.

### 3.6 Rules for this phase

1. Implementer nodes must not start until references are confirmed, unless the
   recipe explicitly allows a pure research pre-step that cannot change the
   candidate product (default: block).
2. Critic nodes must not start until references are confirmed.
3. Discovery must not silently promote candidates to the confirmed set.
4. Seed references still appear in the confirmation UI. The user can drop a seed.
5. A second discovery pass uses the prior candidates and the user note. It does
   not loop without a budget.
6. External URL fetch, if any, is an effect or bounded check with clear evidence.
   Lost knowledge follows M6.3 rules. Confirmation still requires the user.

## 4. Blind verification

Blind means:

1. A critic node receives the **candidate work product** and the **confirmed
   reference set**.
2. A critic node does not receive implementer rationales, prompt transcripts, or
   “why this is correct” narrative from the implementer lane.
3. Critics run as independent branches. They do not see each other’s drafts
   before they publish review facts.
4. The aggregate quorum reduces critic facts deterministically. The reduction
   spends no model turn.
5. A synthesis node may collate defects for the next implementer attempt. The
   synthesis fact does not route the loop. The quorum fact routes the loop.
   See `docs/deterministic-orchestration-plan.md` section 3.

Blind verification is the product difference from “ask another model to review
the same chat”. The graph enforces separation of roles and evidence.

Blind does **not** mean the user is blind to references. The user confirms the
bar before critics run.

## 5. Reference-grade gate

Critics do not only score style. They gate against **real work** using the
confirmed set:

| Gate input | Role |
| --- | --- |
| Confirmed references | Best-in-class examples and equivalent code the user accepted |
| Acceptance criteria | Typed or command-backed checks the candidate must satisfy |
| Deterministic checks | Compilers, tests, linters, scope, and contract checks already in Hypagraph |

A critic fact family must distinguish at least:

- `gauntlet.structure_match` — candidate structure is comparable to references;
- `gauntlet.quality_bar` — quality is at or above the reference bar for the stated goal;
- `gauntlet.regression_risk` — critic flags a real defect (boolean inverted for quorum);
- `gauntlet.ready` — critic would accept the candidate for the goal.

Exact fact names can change at authoring time. The recipe must keep them typed
and branch-scoped. Free-text prose is feedback for synthesis only. Free-text
prose must not select a route.

## 6. Graph topology (conceptual)

Fixed recipe shape. Counts can be recipe defaults. Width of implementer
specialisations can be fixed after a planner step, or fixed small (for example
three specialisations) until M8.1 derived fan-out exists.

```
start
  → discover-references            // model task + optional deterministic search
  → confirm-references             // interaction: user approves / edits / rejects
       reject+rediscover → discover-references (bounded)
       abort → stop
       confirm → continue
  → plan-specialisations           // model task or interaction-approved plan
  → [implementer-A, implementer-B, …]
  → assemble-candidate
  → deterministic-checks
  → [critic-1 … critic-N]          // blind; confirmed references only
  → critic-quorum
  → (optional) critic-synthesis
  → gate on quorum.ready
       pass → (optional) human-gate → complete
       fail → loop back to implementers with synthesis brief
```

Rules that keep this Hypagraph-native:

1. Discovery, confirmation, implementers, and critics are **nodes**, not script
   steps.
2. Confirmation is an **interaction** node. Independent work must not starve
   while it waits (M6.1). In The Gauntlet, implementers and critics depend on
   confirmation by design, so they stay blocked until the user answers.
3. Critic fan-out is a **fixed-width region** until M8.1. Default N in the recipe.
4. Quorum is an **aggregate** node. Counting is deterministic.
5. Synthesis is a **model leaf**. It does not decide pass or fail.
6. Deterministic checks stay on the check / code lanes. They do not consume
   model turns.
7. Final human approval, if any, is a separate interaction after a pass.

## 7. Role contracts

### 7.1 Reference discoverer

- Input: goal, scope, seed references, reference hints.
- Output: structured candidate reference list with locators and reasons.
- Must not mark candidates as confirmed.
- Must not start product implementation.

### 7.2 Reference confirmation (interaction)

- Input: candidate list (presentation report or structured dialog content).
- Output: typed confirmation facts and the durable confirmed set.
- User is the only authority that promotes candidates to the bar.
- Restore re-presents when the answer is not yet stored (M6.1).

### 7.3 Planner

- Input: user goal, scope, **confirmed** references.
- Output: specialisation list with titles, scopes, and acceptance per implementer.
- May require a human interaction when the plan is high risk.

### 7.4 Specialised implementer

- Input: specialisation contract, repository context, confirmed references as
  quality bar, prior failure brief if any.
- Output: scoped changes and declared evidence.
- Must not self-certify completion for the whole goal.
- Must not write critic facts.
- Must not invent a private reference set that critics never saw confirmed.

### 7.5 Assembler

- Input: implementer outputs.
- Output: one candidate artifact set for critics and checks.
- Can be a task, a code node, or a deterministic merge check depending on medium.

### 7.6 Critic

- Input: candidate, **confirmed** references, acceptance.
- No implementer transcript.
- No unconfirmed discovery candidates.
- Output: only the declared critic fact set and optional structured defect list
  for synthesis.
- Runs under the M7 executor (semantic judgement). A code node is not enough.

### 7.7 Quorum aggregate

- Strategy: `quorum` (or `ranked` if the recipe uses scored quality).
- Publishes the only decision fact the gate or loop may read.

## 8. Mandatory rules

1. The recipe is named and versioned. A run always starts a Hypagoal.
2. The model does not invent completion for the goal. Only graph terminal state
   completes the goal.
3. The graph discovers candidate references when seeds are missing or incomplete.
4. The user confirms the reference set before implementers and critics use it.
5. Unconfirmed candidates never reach critic context as the bar.
6. Critic context is sealed: no implementer rationale channel.
7. Confirmed references are durable. Replay uses the same confirmed set.
8. Free-text critic prose does not route. Typed facts route.
9. Deterministic checks run before or beside critics and can fail closed without
   a model turn.
10. A failed quorum does not re-plan the whole goal by default. It returns a
    synthesis brief to implementers inside the bounded loop.
11. Evaluation budgets and attempt limits apply. Discovery rediscover and
    implementer loops both stop.
12. When M7 child Hypagoals exist, a heavy specialisation can be a child goal.
    The family controller remains the only dispatch authority.

## 9. Launch surface (future product)

Examples only. Exact command names wait for a recipe-library milestone.

- `/hypagoal gauntlet --goal "…"`  
- `/hypagoal gauntlet --goal "…" --seed-references src/foo`  
- `/hypagraph recipe start gauntlet` with args  
- Skill or package built-in recipe id `gauntlet`

Discovery should match the Grok Build idea of built-ins plus project recipes:

- package built-ins (this recipe);
- project recipes under a repo path;
- user recipes under a user config path.

See gap “Named graph recipe library” in
`docs/research/grok-build-workflows-comparison.md`.

## 10. Dependency map

| Capability | Status | Gauntlet need |
| --- | --- | --- |
| Task / check / gate | Shipped | Core structure |
| Interaction (confirm references) | Shipped (M6.1) | Mandatory reference confirmation |
| Interaction (optional ship gate) | Shipped (M6.1) | Optional final human gate |
| Code / deterministic checks | Shipped (M6.2) | Locator checks and hard fail-closed bar |
| Effect / external publish | Shipped (M6.3) | Optional external reference fetch; optional PR after pass |
| Branch-scoped facts + aggregate quorum | Planned (orchestration slices 1–3) | Critic reduction |
| Model-executor nodes | Planned (M7) | Discovery, implementers, critics |
| Synthesis node | Planned (orchestration) | Failure brief to loop |
| Named recipe library + launch args | Planned (product gap) | Built-in install and start |
| Concurrent critic branches | Planned (M8) | Parallel critics; sequential is enough for first dogfood |
| Derived fan-out of specialisations | Planned (M8.1) | Dynamic implementer width |

**Earliest useful dogfood:** orchestration slices 1–3 + M7 model-executor + this
recipe with sequential critics, fixed specialisation width, discovery task, and
reference confirmation interaction.

**Full product shape:** recipe library launch + parallel critics + optional
child Hypagoals per specialisation.

## 11. Difference from a plain review quorum

| Plain review quorum | The Gauntlet |
| --- | --- |
| One worker product | Specialised implementer decomposition |
| Reviewers may share full context | Blind critics; sealed implementer narrative |
| Review against abstract quality | Confirmed reference and equivalent-code bar |
| User must bring examples alone | Graph discovers candidates; user confirms |
| Optional checks | Deterministic checks are part of the gate |
| Ad-hoc graph | Named built-in recipe with stable topology |

## 12. Out of scope for this note

- Implementation of the recipe library launcher;
- Choice of default model per role;
- Full web-scale search product;
- Live marketing copy;
- Replacing M7 family design — The Gauntlet consumes it;
- Claiming the recipe exists in the package before it is authored and tested.

## 13. Acceptance sketch (when built)

1. A user starts The Gauntlet with a goal. Seed references may be empty.
2. The run discovers candidate references and presents them for confirmation.
3. Implementers and critics do not run until `gauntlet.references_confirmed`.
4. Critics receive only the confirmed reference set, never unconfirmed candidates
   and never implementer rationale artifacts.
5. Quorum reduction is deterministic and uses no model turn.
6. A failed quorum returns a synthesis brief and retries inside budget.
7. A pass requires quorum ready and deterministic checks green.
8. Replay reproduces the same confirmed references, node set, facts, and
   terminal decision without re-running completed external effects.

## 14. Next documentation steps

1. Keep this note linked from the session handoff and the Grok comparison.
2. When recipe-library work starts, add `gauntlet` as the first built-in recipe
   id and pin default `critic_count`, discovery budget, and specialisation policy.
3. When aggregate ships, author a fixture graph that matches section 6 and add a
   dogfood doc under `docs/`.
4. Specify the interaction presentation kind for the confirmation step (report
   list plus closed approve / edit / rediscover / abort outcomes).
