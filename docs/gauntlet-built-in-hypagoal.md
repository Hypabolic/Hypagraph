# The Gauntlet — built-in Hypagoal recipe

- Status: design idea (not implemented)
- Kind: named built-in Hypagoal recipe (product idea)
- Product analogy: Grok Build named workflows (for example deep research)
- Writing standard: ASD-STE100 Simplified Technical English
- Related: `docs/deterministic-orchestration-plan.md`,
  `docs/research/grok-build-workflows-comparison.md`,
  `docs/goal-family-and-concurrent-execution-plan.md`,
  `docs/m6-1-interaction-node-plan.md`
- Example sketch only: `docs/gauntlet-loop-example.png` (public “gauntlet loop”
  style diagram). That figure is inspiration. It is not a required topology.

## 1. Purpose

Ship one built-in Hypagoal that a user can start with a plain goal and a small
set of arguments. The recipe name and launch path are fixed. The exact graph
inside the recipe can evolve. The controller owns orchestration after a run
starts.

The Gauntlet idea is:

1. break hard work into specialised implementer work;
2. find and **user-confirm** real best-in-class / equivalent-code references;
3. verify with **blind** critics against that bar (and against deterministic
   checks);
4. complete only with durable proof, or stop honestly when budget runs out.

This note captures the product intent. It does not fix the final node graph.

## 2. Core product intent

These points are the idea. Implementation can meet them in more than one graph
shape.

| Intent | Meaning |
| --- | --- |
| Named built-in | User launches a recipe id, not a hand-built graph |
| Ordinary goal | User states what to make in plain language |
| Reference bar | Quality is judged against real examples, not abstract “be good” |
| Discover + confirm | Graph can find candidate references; user confirms before use |
| Specialised work | Work is not one opaque mega-task when specialisation helps |
| Blind critique | Critics do not see implementer chain-of-thought or self-praise |
| Deterministic checks | Tests, typecheck, scope, and contracts fail closed without a model turn |
| No silent success | Pass needs evidence; budget stop reports failure honestly |
| Durable run | Events, facts, and confirmed references survive reload and replay |

## 3. What the user might supply

| Argument | Meaning |
| --- | --- |
| `goal` | The durable objective in ordinary language |
| `scope` | Optional path allowlist or package boundary |
| `seed_references` | Optional examples the user already trusts |
| `reference_hints` | Optional search hints (“like module Y”) |
| `acceptance` | Optional acceptance bullets or test commands |
| `critic_count` | Optional preferred critic width |
| `human_gate` | Optional final interaction before merge or ship |

`seed_references` can be empty. Discovery can still run. **No reference set
should be treated as final until the user confirms it** (interaction node).

## 4. Reference discovery and user confirmation

This is a core product behaviour, not a diagram detail.

1. The graph proposes candidates (seeds, in-repo search, hints, optional
   external locators).
2. An interaction presents the list for approve / edit / rediscover / abort.
3. Only the confirmed set is durable for the rest of the run and for replay.
4. Implementers and critics that use the quality bar wait until confirmation.

Discovery must not silently promote candidates to the bar.

## 5. Blind verification

Blind means:

1. Critics receive the work product and the confirmed references.
2. Critics do not receive implementer rationales or “why this is correct”
   narrative.
3. Independent critics do not share drafts before they publish facts when the
   recipe uses more than one critic.
4. Pass or fail reduction prefers typed facts and deterministic aggregate or
   gate logic. Free-text prose is feedback, not a route selector.

Blind does not mean the user is blind to references. The user confirms the bar.

## 6. Illustrative topology (not required)

Public gauntlet-loop diagrams show one possible story of the same idea. One
such sketch is stored at `docs/gauntlet-loop-example.png`.

That sketch is useful because it is easy to read. It is **not** a mandate to
implement piece loops, dual critics, or the exact edge set in the figure.

### 6.1 What the sketch shows (plain language)

- goal and real examples that set the bar;
- rules and limits;
- break the job into connected pieces;
- give each piece to a specialist and build;
- user-perspective check, separate flaw critic, separate reference compare;
- piece good enough? if no, explain and retry; if yes, keep evidence;
- assemble, test the whole, critic the whole, compare the whole to examples;
- whole good enough? finish with proof, localise a bad piece, re-plan, or stop
  on budget.

### 6.2 Optional Hypagraph encodings

A later implementation **can** map those labels to nodes if that shape is
chosen. Examples only:

| Sketch idea | Possible Hypagraph encoding |
| --- | --- |
| Goal / rules | Goal facts, scope, budgets |
| Real examples | Seed + discovery + confirm interaction |
| Specialist pieces | Tasks or child Hypagoals |
| Piece retry | Bounded loop region |
| Flaw vs reference critique | Separate model-executor nodes or one critic with two contracts |
| Piece / whole good enough? | Gates or aggregate quorum on typed facts |
| Assemble + test | Task or code node + deterministic checks |
| Budget stop | Evaluation budget / patience stop with report |

A simpler first recipe is also valid, for example:

1. confirm references;
2. one implementer wave (or fixed specialisations without per-piece loops);
3. deterministic checks;
4. one blind critic panel against confirmed references;
5. optional human gate;
6. complete or fail with report.

Prefer the simplest graph that still hits section 2. Add piece-level loops and
wider critic panels when dogfood shows they earn their cost.

## 7. Roles (conceptual)

These are roles in the idea, not a fixed node list.

| Role | Intent |
| --- | --- |
| Reference discoverer | Propose real examples |
| Reference confirmation | User seals the bar |
| Planner / decomposer | Split work when useful |
| Implementer | Produce scoped work and evidence |
| Critic | Blind judgement against product and references |
| Checker | Deterministic fail-closed verification |
| Assembler | Combine accepted work when the recipe is multi-piece |
| Gate / quorum | Deterministic pass or fail from typed facts |

One node can cover more than one role in a thin recipe. A rich recipe can split
roles further.

## 8. Likely building blocks (when productised)

Not a commitment to order or to full width:

| Building block | Why it helps |
| --- | --- |
| Interaction (M6.1) | Confirm references; optional ship gate |
| Checks / code (M6.2) | Deterministic bar |
| Effects (M6.3) | Optional external reference fetch or PR after pass |
| Aggregate / branch facts | Multi-critic reduction without a model turn |
| M7 model-executor | Semantic implementers and critics |
| Bounded loops (M4) | Retry with budget when the recipe uses loops |
| Named recipe library | Launch `gauntlet` like a Grok built-in workflow |
| M8 concurrency | Optional parallel critics or pieces |

## 9. Open design choices

Leave these open until implementation or dogfood forces a choice:

1. Per-piece critic loops vs one whole-product critic stage only.
2. Dual critic roles vs a single multi-aspect critic contract.
3. Fixed specialisation set vs planner-chosen width vs M8.1 derived fan-out.
4. Whether implementers may read confirmed references as style guides, or only
   critics may read them.
5. Default budgets for discovery rediscover and implementer retries.
6. Exact fact names for critic outcomes.

## 10. Out of scope for this note

- A committed graph definition or fixture;
- Implementation of the recipe library launcher;
- Choice of default models per role;
- Full web-scale search product;
- Claiming the recipe exists in the package today.

## 11. Acceptance sketch (when a first recipe ships)

Enough for a first built-in. Not a claim that every sketch edge exists.

1. User starts The Gauntlet with a goal. Seeds may be empty.
2. Run can discover references and must let the user confirm the set used.
3. Work is verified with at least one blind critic path against that set.
4. Deterministic checks can fail the run without a model turn.
5. Success needs durable proof. Budget stop is not success.
6. Replay restores confirmed references and terminal decision without replaying
   completed external effects as new work.

## 12. Next steps

1. Keep this as a product idea linked from the handoff and Grok comparison.
2. When a recipe library exists, add recipe id `gauntlet` with the smallest
   graph that still meets section 2.
3. Use `docs/gauntlet-loop-example.png` only as an optional UX / storytelling
   reference, not as a schema.
4. Expand topology after dogfood, not before.
