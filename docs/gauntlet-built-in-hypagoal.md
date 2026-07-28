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
- Pattern source: public “gauntlet loop” graphs (plain-language specialist build
  with two-level critics). Example diagram: `docs/gauntlet-loop-example.png`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

Ship one built-in Hypagoal that a user can start with a plain goal and a small
set of arguments. The recipe is fixed. The graph is not invented ad hoc on each
run. The controller owns orchestration after the recipe materialises.

The Gauntlet is that recipe. It turns one user goal into specialised implementer
pieces, verifies **each piece** with blind critics against confirmed references,
then verifies the **assembled whole** the same way before the goal can complete.

The graph **finds** candidate references when the user does not already pin a
complete set. The graph then **confirms** the reference set with the user
before any implementer or critic uses it as the quality bar.

Public gauntlet-loop diagrams state the product idea in plain language: goal,
rules, real examples, break into pieces, specialist build, user-perspective
check, separate flaw critic, separate reference reviewer, piece gate, assemble,
test, whole-result critics, and honest stop on budget. Hypagraph must encode
that idea as typed nodes, facts, loops, and budgets.

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
3. **Locks rules and limits** (scope, acceptance, budgets) as durable inputs
   that every piece must respect;
4. **Decomposes** the goal into connected specialised pieces (for example API,
   data model, UI, tests, docs), not one monolithic task;
5. **Implements** each piece with a specialist, then runs a **piece-level
   gauntlet** (user-perspective check, flaw critic, reference reviewer, piece
   gate) before the piece is kept;
6. **Assembles** all accepted pieces into one complete result;
7. **Tests** the complete result with deterministic checks;
8. **Runs a whole-result gauntlet** (flaw critic, reference reviewer, whole
   gate) on the assembled product;
9. **Stops with proof** on pass, or routes failure to the offending piece, a
   plan rework, or an honest budget stop — never a silent success.

### 2.3 Mapping from the public gauntlet-loop diagram

The example diagram is stored at `docs/gauntlet-loop-example.png`. Map its
plain labels to Hypagraph concepts as follows.

| Diagram label | Hypagraph role |
| --- | --- |
| What are we trying to make | Goal / objective fact |
| Real examples that set the bar | Seed references + discovery candidates |
| Figure out what great actually looks like | Reference discovery + quality-bar brief |
| Rules and limits we must respect | Scope, acceptance, budgets, policy facts |
| (User confirms the bar) | Interaction: confirm references (Hypagraph addition) |
| Break the job into connected pieces | Planner / specialisation decomposition |
| Give each piece to a specialist | Specialised implementer nodes (or child goals) |
| Build or improve that piece | Implementer attempt inside a piece loop |
| See it the way the user will | User-perspective review task (blind to implementer rationale) |
| Have a separate critic find the flaws | Flaw-critic model-executor branch |
| Have another reviewer compare it with the examples | Reference-reviewer model-executor branch |
| Is this piece truly good enough? | Piece gate / piece quorum on typed facts |
| Explain what falls short and try again | Synthesis brief + piece loop feedback edge |
| Keep the piece and save the evidence | Persist piece evidence; mark piece accepted |
| Put all the accepted pieces together | Assembler |
| Test the complete result | Deterministic checks (test, typecheck, scope) |
| Separate critic / reference reviewer on the whole | Whole-result critic region |
| Does the complete result truly hold up? | Whole gate / whole quorum |
| Finished with proof | Goal complete with evidence |
| One piece failed / find the piece or connection | Route back to piece loop or connection fix |
| The overall plan failed | Route back to re-plan specialisations (bounded) |
| Time or budget ran out | Budget / patience stop with explicit report |

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

## 4. Two-level gauntlet loops

The public diagram is **not** a single whole-product review after one build. It
has two closed loops.

### 4.1 Piece-level loop (per specialist piece)

For each connected piece:

1. Build or improve that piece (specialist implementer).
2. See it the way the user will (user-perspective review).
3. Have a separate flaw critic find defects.
4. Have a separate reference reviewer compare the piece to the confirmed examples.
5. Gate: is this piece truly good enough?
   - **No** → explain what falls short and try again (feedback to the same piece).
   - **Yes** → keep the piece and save the evidence.

A piece does not enter the assemble step until its piece gate passes.

### 4.2 Whole-result loop (after assemble)

After all accepted pieces are kept:

1. Put all accepted pieces together (assembler).
2. Test the complete result (deterministic checks).
3. Have a separate flaw critic look at the whole.
4. Have a separate reference reviewer compare the whole to the confirmed examples.
5. Gate: does the complete result truly hold up?
   - **Yes** → finished with proof.
   - **One piece failed** → find the piece or connection that failed; return to
     that piece loop (or a connection-fix task).
   - **Overall plan failed** → return to re-plan specialisations (bounded).
   - **Time or budget ran out** → stop honestly and report why.

### 4.3 Dual critic roles (both levels)

At piece level and whole level, keep at least two **distinct** critic roles:

| Role | Job |
| --- | --- |
| Flaw critic | Find defects, risks, and missing work without implementer rationale |
| Reference reviewer | Compare the candidate to the confirmed best-in-class / equivalent-code set |

Roles must not share drafts before they publish facts. Reduction of their facts
is deterministic (aggregate / gate). Optional extra critics can widen the
quorum; the dual-role split is the minimum product shape from the diagram.

## 5. Blind verification

Blind means:

1. A critic node receives the **candidate work product** (piece or whole) and
   the **confirmed reference set**.
2. A critic node does not receive implementer rationales, prompt transcripts, or
   “why this is correct” narrative from the implementer lane.
3. Flaw critic and reference reviewer run as independent branches. They do not
   see each other’s drafts before they publish review facts.
4. The aggregate or gate reduces critic facts deterministically. The reduction
   spends no model turn.
5. A synthesis node may collate defects for the next implementer attempt. The
   synthesis fact does not route the loop. The quorum or gate fact routes the
   loop. See `docs/deterministic-orchestration-plan.md` section 3.

Blind verification is the product difference from “ask another model to review
the same chat”. The graph enforces separation of roles and evidence.

Blind does **not** mean the user is blind to references. The user confirms the
bar before piece work starts.

## 6. Reference-grade gate

Critics do not only score style. They gate against **real work** using the
confirmed set:

| Gate input | Role |
| --- | --- |
| Confirmed references | Best-in-class examples and equivalent code the user accepted |
| Acceptance criteria | Typed or command-backed checks the candidate must satisfy |
| Rules and limits | Scope, budgets, and policy the piece and whole must respect |
| Deterministic checks | Compilers, tests, linters, scope, and contract checks already in Hypagraph |

A critic fact family must distinguish at least:

- `gauntlet.user_perspective_ok` — piece is acceptable from the user view;
- `gauntlet.flaws_clear` — flaw critic found no blocking defect (or inverted risk);
- `gauntlet.structure_match` — candidate structure is comparable to references;
- `gauntlet.quality_bar` — quality is at or above the reference bar for the goal;
- `gauntlet.ready` — critic would accept this piece or whole for the goal.

Exact fact names can change at authoring time. The recipe must keep them typed
and branch-scoped. Free-text prose is feedback for synthesis only. Free-text
prose must not select a route.

## 7. Graph topology (conceptual)

Fixed recipe shape. Piece count can be fixed after the planner step, or fixed
small until M8.1 derived fan-out exists. Each piece has its own bounded loop.

```
start
  → discover-references
  → confirm-references                 // interaction (mandatory)
       rediscover (bounded) | abort | confirm
  → lock-rules-and-limits              // acceptance, scope, budgets
  → plan-specialisations               // break into connected pieces
       ← overall plan failed (bounded re-plan)
  → for each piece (specialist region / child goal):
       loop:
         build-or-improve-piece
         user-perspective-review       // blind
         flaw-critic                   // blind
         reference-reviewer            // blind; confirmed examples only
         piece-gate
           no  → synthesis-brief → build-or-improve-piece
           yes → keep-piece-and-evidence
  → assemble-accepted-pieces
  → test-complete-result               // deterministic checks
  → whole-flaw-critic                  // blind
  → whole-reference-reviewer           // blind
  → whole-gate
       pass            → finished-with-proof (optional human ship gate)
       one piece failed → localise piece/connection → piece loop
       plan failed     → plan-specialisations (bounded)
       budget exhausted → stop-honestly-and-report
```

Rules that keep this Hypagraph-native:

1. Every step above is a **node** or a fixed region of nodes, not a script step.
2. Reference confirmation is an **interaction** node. Piece work depends on it.
3. Piece loops are **bounded iteration regions** with evaluation budgets.
4. Flaw critic and reference reviewer are independent **model-executor** nodes
   (M7). A code node is not enough for semantic critique.
5. Piece gate and whole gate read **typed facts** only. Synthesis does not route.
6. Assemble waits until each piece is accepted. Partial assemble is not success.
7. Deterministic whole tests fail closed without a model turn.
8. Budget stop is an explicit terminal path with a report. It is not a pass.
9. Final human ship gate, if any, runs only after whole-gate pass.

## 8. Role contracts

### 8.1 Reference discoverer

- Input: goal, scope, seed references, reference hints.
- Output: structured candidate reference list with locators and reasons.
- Must not mark candidates as confirmed.
- Must not start product implementation.

### 8.2 Reference confirmation (interaction)

- Input: candidate list (presentation report or structured dialog content).
- Output: typed confirmation facts and the durable confirmed set.
- User is the only authority that promotes candidates to the bar.
- Restore re-presents when the answer is not yet stored (M6.1).

### 8.3 Rules lock

- Input: acceptance, scope, budgets, policy.
- Output: durable rules facts every piece and whole gate can read.
- Does not invent references.

### 8.4 Planner

- Input: user goal, scope, **confirmed** references, rules.
- Output: connected specialisation list with titles, scopes, and acceptance per
  piece.
- May require a human interaction when the plan is high risk.
- Re-plan is a separate bounded entry from whole-gate “plan failed”.

### 8.5 Specialised implementer

- Input: piece contract, repository context, confirmed references as quality
  bar, prior piece failure brief if any.
- Output: scoped changes and declared evidence for **that piece only**.
- Must not self-certify the piece or the whole goal.
- Must not write critic facts.
- Must not invent a private reference set that critics never saw confirmed.

### 8.6 User-perspective reviewer

- Input: piece candidate, user-facing acceptance, confirmed references as needed.
- Output: typed user-perspective facts and optional defect notes for synthesis.
- Blind to implementer rationale.
- Distinct from the flaw critic and the reference reviewer.

### 8.7 Flaw critic

- Input: piece or whole candidate; rules and acceptance; no implementer transcript.
- Output: flaw / risk facts and structured defects for synthesis.
- Does not alone decide pass. The gate or quorum decides.

### 8.8 Reference reviewer

- Input: piece or whole candidate; **confirmed** references only.
- Output: structure and quality-bar facts against the examples.
- Does not alone decide pass. The gate or quorum decides.

### 8.9 Assembler

- Input: all accepted piece outputs and their evidence.
- Output: one complete candidate for whole tests and whole critics.
- Must not accept a piece that failed its piece gate.

### 8.10 Piece gate and whole gate

- Input: typed facts from the dual critics (and user-perspective at piece level),
  plus deterministic check facts at whole level when present.
- Output: pass / fail decision facts only.
- On fail, publish enough structure for synthesis or localisation (which piece,
  which connection) without free-text routing.

## 9. Mandatory rules

1. The recipe is named and versioned. A run always starts a Hypagoal.
2. The model does not invent completion for the goal. Only graph terminal state
   completes the goal. “Finished with proof” requires whole-gate pass and green
   deterministic tests.
3. The graph discovers candidate references when seeds are missing or incomplete.
4. The user confirms the reference set before piece implementers and critics run.
5. Unconfirmed candidates never reach critic context as the bar.
6. Every piece passes a piece-level gauntlet before assemble.
7. The assembled whole passes a whole-level gauntlet before complete.
8. Flaw critic and reference reviewer stay separate roles at both levels.
9. Critic context is sealed: no implementer rationale channel.
10. Confirmed references are durable. Replay uses the same confirmed set.
11. Free-text critic prose does not route. Typed facts route.
12. Deterministic checks fail closed without a model turn.
13. Piece fail defaults to the same piece loop with a synthesis brief.
14. Whole fail may localise to a piece, re-plan, or stop on budget — never silent
    success.
15. Evaluation budgets and attempt limits apply to discovery rediscover, piece
    loops, re-plan, and whole retries. Exhaustion stops honestly with a report.
16. When M7 child Hypagoals exist, a heavy piece can be a child goal. The family
    controller remains the only dispatch authority.

## 10. Launch surface (future product)

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

## 11. Dependency map

| Capability | Status | Gauntlet need |
| --- | --- | --- |
| Task / check / gate | Shipped | Core structure |
| Bounded iteration regions | Shipped (M4) | Piece loops and budgets |
| Interaction (confirm references) | Shipped (M6.1) | Mandatory reference confirmation |
| Interaction (optional ship gate) | Shipped (M6.1) | Optional final human gate |
| Code / deterministic checks | Shipped (M6.2) | Locator checks and whole-result tests |
| Effect / external publish | Shipped (M6.3) | Optional external reference fetch; optional PR after pass |
| Branch-scoped facts + aggregate quorum | Planned (orchestration slices 1–3) | Dual-critic reduction at piece and whole |
| Model-executor nodes | Planned (M7) | Discovery, implementers, all critic roles |
| Synthesis node | Planned (orchestration) | Piece failure brief; localisation brief |
| Named recipe library + launch args | Planned (product gap) | Built-in install and start |
| Concurrent piece or critic branches | Planned (M8) | Parallel pieces/critics; sequential first dogfood |
| Derived fan-out of specialisations | Planned (M8.1) | Dynamic piece width |

**Earliest useful dogfood:** orchestration slices 1–3 + M7 model-executor + one
fixed piece count, piece loop with dual critics, whole loop with dual critics,
discovery + reference confirmation.

**Full product shape:** recipe library launch + parallel pieces + parallel
critics + optional child Hypagoals per piece.

## 12. Difference from a plain review quorum

| Plain review quorum | The Gauntlet |
| --- | --- |
| One worker product | Specialised pieces with per-piece gates |
| One review stage | Piece gauntlet **and** whole gauntlet |
| One reviewer style | Flaw critic **and** reference reviewer |
| Reviewers may share full context | Blind critics; sealed implementer narrative |
| Review against abstract quality | Confirmed reference and equivalent-code bar |
| User must bring examples alone | Graph discovers candidates; user confirms |
| Optional checks | Deterministic whole tests are part of the gate |
| Vague failure | Localise piece, re-plan, or honest budget stop |
| Ad-hoc graph | Named built-in recipe with stable topology |

## 13. Out of scope for this note

- Implementation of the recipe library launcher;
- Choice of default model per role;
- Full web-scale search product;
- Live marketing copy;
- Replacing M7 family design — The Gauntlet consumes it;
- Claiming the recipe exists in the package before it is authored and tested;
- Treating the public diagram as a normative Hypagraph schema — it is the
  product pattern source; this note is the Hypagraph encoding.

## 14. Acceptance sketch (when built)

1. A user starts The Gauntlet with a goal. Seed references may be empty.
2. The run discovers candidate references and presents them for confirmation.
3. Piece implementers and piece critics do not run until references are confirmed.
4. Each piece passes user-perspective, flaw critic, and reference reviewer facts
   before assemble.
5. Critics never receive unconfirmed candidates or implementer rationale.
6. Whole-gate pass requires dual whole critics, green deterministic tests, and
   typed ready facts.
7. Piece fail returns a synthesis brief to the same piece inside budget.
8. Whole fail can localise a piece, re-plan, or stop on budget with a report.
9. “Finished with proof” is the only success terminal. Budget stop is not success.
10. Replay reproduces the confirmed references, piece decisions, whole decision,
    and terminal state without re-running completed external effects.

## 15. Next documentation steps

1. Keep this note linked from the session handoff and the Grok comparison.
2. When recipe-library work starts, add `gauntlet` as the first built-in recipe
   id and pin default piece count, discovery budget, and piece/whole loop budgets.
3. When aggregate ships, author a fixture graph that matches section 7 and add a
   dogfood doc under `docs/`.
4. Specify the interaction presentation kind for the confirmation step (report
   list plus closed approve / edit / rediscover / abort outcomes).
5. Keep `docs/gauntlet-loop-example.png` next to this note as the plain-language
   pattern reference.
