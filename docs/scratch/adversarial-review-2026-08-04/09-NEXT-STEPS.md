# Next steps after adversarial review

- Status: active product direction
- Date: 2026-08-04
- Package: hypagraph 0.14.0
- Branch context: kernel on `main` (v0.14); demo and host work on `feature/in-pi-demo-tour`
- Writing standard: ASD-STE100 Simplified Technical English

This document records:

1. the full review pack index;
2. the consensus verdict;
3. a product decision on domain purity;
4. next steps in dependency order (no human calendar scales).

## 1. Full review pack

| File | Role | Status |
| --- | --- | --- |
| `ATTACK-BRIEF.md` | Shared attack brief | Complete |
| `00-SYNTHESIS.md` | Cross-panel synthesis | Complete |
| `01-codex-luna-xhigh.md` | Codex Luna full adversarial | Complete |
| `02-codex-sol-high.md` | Codex Sol competitive | Complete |
| `03-claude-opus.log` | Claude Opus | Failed (session limit) |
| `04-claude-sonnet-high.md` | Claude Sonnet code / architecture | Complete |
| `05-claude-sonnet-medium.md` | Claude Sonnet UX / first five minutes | Complete |
| `06-grok-product-vision.md` | Grok product principal | Complete |
| `07-grok-competitive-multiagent.md` | Grok competitive principal | Complete |
| `08-grok-code-architecture.md` | Grok code principal | Complete |
| `09-NEXT-STEPS.md` | This file: decisions and ordered next steps | Active |

Read `00-SYNTHESIS.md` for the merged verdict and risk list. Read individual panel files for evidence and assault detail.

## 2. Consensus verdict (short)

**Competitive as a durable execution-control kernel. Lagging as a multi-agent and workflows-in-workflows product.**

Kernel strengths: typed facts, checks, gates, loops, trusted evaluation, durable events, goal authority, no model completion tool.

Product gaps: concurrent multi-member family path, synthesis and aggregate fan-in, named recipes, live acceptance, host modularization.

**Company bet:** not yet. Re-evaluate only when concurrent family, synthesis, one ordinary recipe, and live acceptance are all **live** on the capability ledger.

## 3. Product decision: domain purity

### Decision

**Absolute purity of the domain reducer is not a product requirement.**

The earlier M0 rule that forbade random values and clock access in the domain was an over-constraint. The project **restates** the rule. The project does **not** enforce hard purity.

### What still matters

| Rule | Requirement |
| --- | --- |
| Canonical state path | State changes only through controller and domain reduction commands. |
| External effects | File system, network, process start, shell, and Pi session work belong to the host and executors. |
| Input mutation | Do not change input objects. Build new state. |
| Replay and tests | Prefer fixed timestamps and IDs when callers need stable replay. Callers may pass those values. |
| Defaults | The domain may create default identifiers (for example `randomUUID()`). |

### What is closed as a defect

- Treat `createWorkflow(..., workflowId = randomUUID())` as an allowed convenience, not a purity violation.
- Do not spend Gate 0 work on removing domain defaults for purity alone.
- Reviews must not score absolute purity as a release blocker.

### Where the rule is written

- `AGENTS.md` (M0 quality rules)
- `docs/session-handoff.md` (preserved invariants)
- `docs/capability-ledger.md` (host vs domain boundary)
- `docs/host-extraction-plan.md` (host owns side effects)

## 4. Capability ledger (four states)

Every capability claim must use one of four states:

| State | Meaning |
| --- | --- |
| **Domain** | Module and tests exist. |
| **Host** | Extension or host code calls it. |
| **Ordinary** | A normal user can reach it without fixtures or special branches. |
| **Live** | Accepted under real Pi session dogfood or an equivalent live acceptance case. |

Do not treat **Domain** as **Live**. Full rows live in [`docs/capability-ledger.md`](../../capability-ledger.md).

## 5. Next steps (dependency order)

No human calendar scales. Order is by dependency and exit gate only.

### Gate 0 — Honesty, purity restate, host plan, claim cleanup

**Why first:** Public claims and house rules must match product truth before more width ships.

| ID | Work | Scope | Exit gate |
| --- | --- | --- | --- |
| 0.1 | Capability ledger (domain / host / ordinary / live) in product docs | Doc | No “shipped” claim without a ledger row and state |
| 0.2 | Restate domain purity (decision in section 3) | Doc / house rules | AGENTS and handoff match the decision |
| 0.3 | Host extraction plan for `src/extension.ts` (boundary map, not full rewrite) | Design | Documented seams and extract order |
| 0.4 | Fix or demote README and product overclaim language | Doc | Public claims match the ledger |

**Gate 0 status after this document set:** executed (docs and house rules).

### Gate 1 — Make concurrency product-true

**Why next:** Width is the strategic bet. Sequential multi-pending family is the main credibility hole.

| ID | Work | Scope | Exit gate | Status |
| --- | --- | --- | --- | --- |
| 1.1 | Wire concurrent selection into the ordinary product path | Medium: host and domain glue | Multi-pending family starts concurrent children without checks-only special case | Done |
| 1.2 | Concurrency policy surface (limits, exclusive vs concurrent, failure modes) | Medium | Documented and tested policy (`docs/concurrency-policy-surface.md`) | Done |
| 1.3 | Live acceptance: multi-child concurrent run under real Pi | Integration | Ledger row is **Live** | Partial: case script + automated host substitute present (`docs/gate1-3-concurrent-family-live-acceptance.md`, `tests/gate1-3-concurrent-family-live-acceptance.test.ts`, evidence stub `docs/dogfood-evidence/gate1-3-live/`). Live Pi dogfood not run. Ledger **Live** still open. |

**Gate 1 exit status:** not complete. Exit requires ledger **Live** for concurrent multi-pending family selection (case `CASE-G1-3-CONCURRENT-FAMILY`).

**Depends on:** Gate 0 honesty for any concurrent public claim.

### Gate 2 — First closed multi-agent loop (synthesis)

**Why:** Width without join is half a product.

| ID | Work | Scope | Exit gate |
| --- | --- | --- | --- |
| 2.1 | Domain model: aggregate or synthesis of child outcomes into a parent decision | Medium–large | Schema, reducer, tests |
| 2.2 | Host path: plan owner consumes synthesis; graph transitions on result | Medium | Ordinary product path works |
| 2.3 | Live acceptance: parent fans out, joins, continues or fails on synthesis | Integration | Ledger row is **Live** |

**Depends on:** Gate 1 for concurrent fan-out. A sequential join may ship earlier as a thinner vertical slice if concurrent wiring is blocked.

### Gate 3 — Recipe productization

**Why:** Reviews treat recipes as the missing ordinary-use layer.

| ID | Work | Scope | Exit gate |
| --- | --- | --- | --- |
| 3.1 | One ordinary recipe end to end (for example plan → workers → synthesis → done) | Large vertical | User can run without custom graph authoring |
| 3.2 | Recipe catalog entry, validation, and docs | Small–medium | Discoverable in product, not only docs or demo |
| 3.3 | Second recipe only after 3.1 is live | — | Avoid catalog growth before one works |

**Depends on:** Gates 1–2 for a recipe that is not only a sequential demo toy.

### Gate 4 — Live acceptance harness

**Why:** Design-only Gauntlet does not count as shipped proof.

| ID | Work | Scope | Exit gate |
| --- | --- | --- | --- |
| 4.1 | Minimal live suite: restore, crash or restart, concurrent family, synthesis path | Large | CI or documented operator run |
| 4.2 | Map each suite case to capability ledger rows | Small | Every **Live** claim has a case ID |
| 4.3 | Expand only after 4.1 is green | — | No paper Gauntlet growth |

**Can run beside Gate 3** once 4.1 has first cases. Do not block Gates 1–2 on a full Gauntlet.

### Gate 5 — Host modularization

**Why:** `src/extension.ts` (~5.8k lines) blocks safe width work.

| ID | Work | Scope | Exit gate |
| --- | --- | --- | --- |
| 5.1 | Extract by seam from the host extraction plan | Large series of small changes | extension shrinks; behaviour unchanged |
| 5.2 | No new large features only in the monolith | Process | New work lands in extracted modules |

**Depends on:** Gate 0.3. Interleave with Gates 1–3 so product work does not wait on full extraction.

### Explicit non-goals until Gates 1–3 are live

- Aggregate research depth beyond one synthesis path
- Multi-recipe catalog polish
- Competitive marketing as primary work
- Further demo-tour chrome unless it unblocks live acceptance
- Company-bet framing until concurrent, synthesis, and one recipe are **Live**
- Absolute domain purity enforcement

### Critical path

```text
0.1 + 0.2 + 0.4 honesty and purity restate
    → 1.1 concurrent product path
        → 2.1–2.3 synthesis loop
            → 3.1 one ordinary recipe
                → company-bet re-evaluation
```

Gate 4 runs beside 1–3 as proof. Gate 5 runs beside product work so the host does not freeze.

### Done enough for a company bet

All of the following must be **Live** on the ledger:

1. Concurrent multi-child family under the ordinary product path
2. Parent synthesis that changes parent graph state
3. One recipe a non-author user can run
4. Live acceptance covering restore, concurrent family, and synthesis
5. Public docs match that ledger

Until then: strong kernel and partial multi-agent product. Not a full company bet.

## 6. Next implementable unit after Gate 0

1. **Gate 1.3 live Pi dogfood** — run `CASE-G1-3-CONCURRENT-FAMILY` under real Pi, record evidence under `docs/dogfood-evidence/gate1-3-live/`, then set ledger **Live** only if the pass criteria hold. Automated substitute already exists; do not claim Gate 1 complete until Live is earned.
2. Or start **Gate 2.1** synthesis domain if concurrent host path is enough for sequential join experiments (Gate 2 still depends on Gate 1 for concurrent fan-out claims).

## 7. Related durable docs

| Doc | Purpose |
| --- | --- |
| [`docs/capability-ledger.md`](../../capability-ledger.md) | Four-state capability rows |
| [`docs/host-extraction-plan.md`](../../host-extraction-plan.md) | extension.ts seams and extract order |
| [`docs/session-handoff.md`](../../session-handoff.md) | Invariants and handoff |
| [`docs/execution-roadmap.md`](../../execution-roadmap.md) | Longer roadmap baseline |
