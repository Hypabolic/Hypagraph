# The Gauntlet — built-in Hypagoal recipe

- Status: design idea (not implemented)
- Kind: named built-in Hypagoal recipe
- Product analogy: Grok Build named workflows (for example deep research)
- Depends on: fixed-width review quorum (deterministic orchestration slices 1–3),
  M7 model-executor nodes, optional M8 concurrency for parallel critics
- Related: `docs/deterministic-orchestration-plan.md`,
  `docs/research/grok-build-workflows-comparison.md`,
  `docs/goal-family-and-concurrent-execution-plan.md`
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Purpose

Ship one built-in Hypagoal that a user can start with a plain goal and a small
set of arguments. The recipe is fixed. The graph is not invented ad hoc on each
run. The controller owns orchestration after the recipe materialises.

The Gauntlet is that recipe. It turns one user goal into specialised implementer
work, then forces **blind** critic verification against real work and
best-in-class reference examples before the goal can complete.

## 2. Product shape

### 2.1 What the user supplies

| Argument | Meaning |
| --- | --- |
| `goal` | The durable objective in ordinary language |
| `scope` | Optional path allowlist or package boundary |
| `references` | Paths, URLs, or pinned examples of best-in-class work of the same kind |
| `acceptance` | Optional typed acceptance bullets or test commands |
| `critic_count` | Fixed number of critic branches (default fixed in the recipe) |
| `human_gate` | Optional final interaction before merge or ship |

The user does not design the graph. The user does not name nodes. Launch is one
command or one Hypagoal start with those args, similar to a named Grok workflow.

### 2.2 What the recipe produces

A validated workflow that:

1. **Decomposes** the goal into specialised implementer nodes (for example API,
   data model, UI, tests, docs) according to the work, not one monolithic task;
2. **Implements** each specialisation as a bounded task (or child Hypagoal when
   M7 lands) with explicit produces and evidence;
3. **Assembles** a candidate result (working tree change, design artifact, or
   package surface);
4. **Blind-verifies** that candidate with independent critic nodes that do not
   see implementer chain-of-thought or self-justifying narrative;
5. **Gates** progress on critic facts and deterministic checks that compare the
   candidate to the declared references and acceptance criteria;
6. **Loops** only when the quorum fails, with a synthesis brief that carries
   fixable defects, not free-form chat.

## 3. Blind verification

Blind means:

1. A critic node receives the **candidate work product** and the **reference set**.
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

## 4. Reference-grade gate

Critics do not only score style. They gate against **real work**:

| Gate input | Role |
| --- | --- |
| User `references` | Best-in-class examples of the same kind of deliverable |
| Equivalent code | Prior modules, golden tests, public APIs, or sibling packages that define the bar |
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

## 5. Graph topology (conceptual)

Fixed recipe shape. Counts can be recipe defaults. Width of implementer
specialisations can be fixed after a planner step, or fixed small (for example
three specialisations) until M8.1 derived fan-out exists.

```
start
  → plan-specialisations (model task or interaction-approved plan)
  → [implementer-A, implementer-B, …]   // specialised implementer nodes
  → assemble-candidate                 // merge or package candidate
  → deterministic-checks               // tests, typecheck, scope
  → [critic-1 … critic-N]              // blind model-executor branches
  → critic-quorum                      // aggregate: quorum strategy
  → (optional) critic-synthesis        // model leaf for fix brief
  → gate on quorum.ready
       pass → (optional) human-gate → complete
       fail → loop back to implementers with synthesis brief
```

Rules that keep this Hypagraph-native:

1. Implementers and critics are **nodes**, not script steps.
2. Critic fan-out is a **fixed-width region** until M8.1. Default N in the recipe.
3. Quorum is an **aggregate** node. Counting is deterministic.
4. Synthesis is a **model leaf**. It does not decide pass or fail.
5. Deterministic checks stay on the check / code lanes. They do not consume
   model turns.
6. Human approval, if any, is an **interaction** node (M6.1). Independent work
   must not starve while it waits.

## 6. Role contracts

### 6.1 Planner (optional first step)

- Input: user goal, scope, references.
- Output: specialisation list with titles, scopes, and acceptance per implementer.
- May require a human interaction when the plan is high risk.

### 6.2 Specialised implementer

- Input: specialisation contract, repository context, prior failure brief if any.
- Output: scoped changes and declared evidence.
- Must not self-certify completion for the whole goal.
- Must not write critic facts.

### 6.3 Assembler

- Input: implementer outputs.
- Output: one candidate artifact set for critics and checks.
- Can be a task, a code node, or a deterministic merge check depending on medium.

### 6.4 Critic

- Input: candidate, references, acceptance, equivalent-code anchors.
- No implementer transcript.
- Output: only the declared critic fact set and optional structured defect list
  for synthesis.
- Runs under the M7 executor (semantic judgement). A code node is not enough.

### 6.5 Quorum aggregate

- Strategy: `quorum` (or `ranked` if the recipe uses scored quality).
- Publishes the only decision fact the gate or loop may read.

## 7. Mandatory rules

1. The recipe is named and versioned. A run always starts a Hypagoal.
2. The model does not invent completion for the goal. Only graph terminal state
   completes the goal.
3. Critic context is sealed: no implementer rationale channel.
4. References are durable inputs. Replay uses the same reference set.
5. Free-text critic prose does not route. Typed facts route.
6. Deterministic checks run before or beside critics and can fail closed without
   a model turn.
7. A failed quorum does not re-plan the whole goal by default. It returns a
   synthesis brief to implementers inside the bounded loop.
8. Evaluation budgets and attempt limits apply. The Gauntlet must not loop
   without a stop.
9. When M7 child Hypagoals exist, a heavy specialisation can be a child goal.
   The family controller remains the only dispatch authority.

## 8. Launch surface (future product)

Examples only. Exact command names wait for a recipe-library milestone.

- `/hypagoal gauntlet --goal "…"`  
- `/hypagraph recipe start gauntlet` with args  
- Skill or package built-in recipe id `gauntlet`

Discovery should match the Grok Build idea of built-ins plus project recipes:

- package built-ins (this recipe);
- project recipes under a repo path;
- user recipes under a user config path.

See gap “Named graph recipe library” in
`docs/research/grok-build-workflows-comparison.md`.

## 9. Dependency map

| Capability | Status | Gauntlet need |
| --- | --- | --- |
| Task / check / gate | Shipped | Core structure |
| Interaction human gate | Shipped (M6.1) | Optional ship gate |
| Code / deterministic checks | Shipped (M6.2) | Hard fail-closed bar |
| Effect / external publish | Shipped (M6.3) | Optional PR open after pass |
| Branch-scoped facts + aggregate quorum | Planned (orchestration slices 1–3) | Critic reduction |
| Model-executor nodes | Planned (M7) | Implementers and critics |
| Synthesis node | Planned (orchestration) | Failure brief to loop |
| Named recipe library + launch args | Planned (product gap) | Built-in install and start |
| Concurrent critic branches | Planned (M8) | Parallel critics; sequential is enough for first dogfood |
| Derived fan-out of specialisations | Planned (M8.1) | Dynamic implementer width |

**Earliest useful dogfood:** orchestration slices 1–3 + M7 model-executor + this
recipe with sequential critics and fixed specialisation width.

**Full product shape:** recipe library launch + parallel critics + optional
child Hypagoals per specialisation.

## 10. Difference from a plain review quorum

| Plain review quorum | The Gauntlet |
| --- | --- |
| One worker product | Specialised implementer decomposition |
| Reviewers may share full context | Blind critics; sealed implementer narrative |
| Review against abstract quality | Explicit reference and equivalent-code bar |
| Optional checks | Deterministic checks are part of the gate |
| Ad-hoc graph | Named built-in recipe with stable topology |

## 11. Out of scope for this note

- Implementation of the recipe library launcher;
- Choice of default model per role;
- Live marketing copy;
- Replacing M7 family design — The Gauntlet consumes it;
- Claiming the recipe exists in the package before it is authored and tested.

## 12. Acceptance sketch (when built)

1. A user starts The Gauntlet with a goal and at least one reference.
2. The run materialises specialised implementer nodes and N critic branches.
3. Critics never receive implementer rationale artifacts.
4. Quorum reduction is deterministic and uses no model turn.
5. A failed quorum returns a synthesis brief and retries inside budget.
6. A pass requires quorum ready and deterministic checks green.
7. Replay reproduces the same node set, facts, and terminal decision without
   re-running completed external effects.

## 13. Next documentation steps

1. Keep this note linked from the session handoff and the Grok comparison.
2. When recipe-library work starts, add `gauntlet` as the first built-in recipe
   id and pin default `critic_count` and specialisation policy.
3. When aggregate ships, author a fixture graph that matches section 5 and add a
   dogfood doc under `docs/`.
