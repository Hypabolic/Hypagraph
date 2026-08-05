# Hypagraph capability ledger

- Status: active
- Updated: 2026-08-05
- Package baseline: 0.14.0
- Writing standard: ASD-STE100 Simplified Technical English
- Source of direction: `docs/scratch/adversarial-review-2026-08-04/09-NEXT-STEPS.md`

## 1. Purpose

This ledger states what Hypagraph can do and how far each capability reaches in the product.

Use this ledger for README claims, release notes, and review. Do not treat a domain module as a shipped product path.

## 2. Four states

| State | Meaning |
| --- | --- |
| **Domain** | Domain module and automated tests exist. |
| **Host** | Host or extension code calls the domain path. |
| **Ordinary** | A normal user can reach the path without fixtures, demo-only code, or special engineer steps. |
| **Live** | Accepted under a real Pi session dogfood or an equivalent live acceptance case recorded with a case ID. |

Rules:

1. A claim of “shipped” for a user feature requires at least **Ordinary**.
2. A claim of release-accepted multi-agent behaviour requires **Live**.
3. **Domain** alone is not a product claim.
4. Update this file when a path moves state.

## 3. Host versus domain boundary

| Layer | Owns |
| --- | --- |
| Domain (`src/domain/`) | Commands, events, projection, readiness, gates, family helpers, validation |
| Host (`src/extension.ts`, `src/pi/`, `src/ui/`, executors) | Pi session, UI, shell and process work, network, disk outside event append, worker spawn |

Domain reduction may use convenience defaults (for example default workflow IDs). Absolute purity is not required. See `AGENTS.md` and the purity decision in `docs/scratch/adversarial-review-2026-08-04/09-NEXT-STEPS.md`.

The domain must not open files for effect, call the network, or start processes as the way it advances graph state. Those effects stay on the host and executors.

## 4. Ledger rows

States below reflect the adversarial review of 2026-08-04 and the in-tree product path on the demo branch. Adjust when evidence changes.

| Capability | Domain | Host | Ordinary | Live | Notes |
| --- | --- | --- | --- | --- | --- |
| Root Hypagoal create (`/hypagoal`, `hypagoal_start`) | Yes | Yes | Yes | Partial | Ordinary path is real. Full live multi-session dogfood remains a release bar. |
| Post-create Run / Question / Cancel dock | Yes | Yes | Yes | Partial | Interactive TUI path exists. |
| Single-root task + check + gate execution | Yes | Yes | Yes | Yes | Core durable path; strongest product surface. |
| Deterministic checks (command, report, file, Git) | Yes | Yes | Yes | Yes | Host runners + durable lifecycle. |
| Bounded loops and trusted evaluation | Yes | Yes | Yes | Partial | Kernel strong; protected production isolation still planned for some eval modes. |
| Live graph bottom dock and full graph modal | Yes | Yes | Yes | Partial | Product UI on demo branch; demo tour uses it. |
| Goal family projection and child create domain | Yes | Yes | Partial | No | Domain and host tools exist. Create-child is allowed for isolated-pi or current-session parents from the family desk. Live root→child→return dogfood not release-accepted. |
| Sequential multi-member family dispatch | Yes | Yes | Partial | No | Product controller sequential path is wired. Ordinary UX still awkward (R4 non-root current-session ban; family authoring density). |
| Concurrent multi-pending family selection | Yes | Yes | Partial | No | Schema 3 multi-pending; product can commit multiple model pendings in a batch. Gate 1.1–1.2 host path enforces default global concurrency (2), independent-settle partial failure, and multi-pending status honesty (see `docs/concurrency-policy-surface.md`). Per-executor limits and concurrency groups are enforced when the caller supplies them on product helpers; the ordinary extension path currently passes default policy only. S4 worker pool: keyed map of active isolated attempts; capacity is resolved `globalConcurrency` (default 2); batch path starts admitted model members concurrently and settles each pending on that worker's completion (no `modelSlots = 1`, no deferred-interrupt for a single seat). Isolated workers hold free slots only for start/register and settle (protocol in `isolated-free-slot-protocol.ts`); process await does not hold free slots. Host commits only free-seat model members (no selected-without-start residual). Concurrent settle merges member stream and pending under one lock so sibling bags are not clobbered. Status reports multi-worker occupancy. Gate 1.3 case `CASE-G1-3-CONCURRENT-FAMILY`: live acceptance script and evidence stub in `docs/gate1-3-concurrent-family-live-acceptance.md` and `docs/dogfood-evidence/gate1-3-live/`; automated host substitutes `tests/gate1-3-concurrent-family-live-acceptance.test.ts` and `tests/s4-worker-pool-concurrent-fanout.test.ts`. Live Pi dogfood is not recorded; **Live** remains open. |
| Worktree leases / isolated checkout integration | Yes | Partial | No | No | Domain seams exist. Ordinary product wiring incomplete. |
| Derived fan-out from collection facts | Yes | No | No | No | Domain + tests. Not ordinary product surface. |
| Isolated model workers (`isolated-pi`) | Yes | Yes | Yes | Partial | Default for root model tasks when spawn works. |
| ACP / CLI external executors | Yes | Yes | No | No | Adapters exist; engineer surface, not first-run product. |
| Aggregate / quorum / synthesis nodes | Yes | Yes | No | No | S6 all-success child-outcome join: domain module `child-outcome-synthesis.ts` (schema v1 policy/result records; pure evaluate; parent apply publishes `join.passed` when the parent declares that boolean produce, and blocks parent on failed join). Host product helpers in `family-product-synthesis.ts`; extension `applyPendingChildReturns` runs ready join synthesis after child returns settle (ordinary family product path, not demo-only). Empty join set is vacuous success. Multi-child join set is all bindings for a parent goal+node when none remain active. Full aggregate node kinds (quorum/ranked/collect), model synthesis node, and recipe library are not shipped. Live acceptance not recorded. |
| Named recipe library (beyond one implement-verify tool) | Partial | Partial | No | No | One minimal recipe tool. Library and launch-with-args incomplete. |
| Gauntlet / blind multi-critic panel | Partial | No | No | No | Design docs only. |
| In-Pi showcase demo tour | N/A | Yes | Yes | Partial | Deterministic fixtures only. Not multi-agent proof. |
| Session restore and pause / resume | Yes | Yes | Yes | Partial | Kernel path strong; family live restore dogfood incomplete. |
| Event history, explain, replay surfaces | Yes | Yes | Yes | Partial | Commands exist; live dogfood depth varies. |
| Project store drafts and constructors | Yes | Yes | Partial | Partial | Task/check/require/loop constructors. Interaction, gate, code, effect free-form only. |

## 5. Public claim policy

| Allowed claim style | Example |
| --- | --- |
| Accurate | “Concurrent multi-pending family selection is on the host product path. Host model capacity is N under resolved globalConcurrency (default 2) after S4. Live multi-pending concurrent family acceptance under real Pi is not complete.” |
| Accurate | “Kernel supports goal families. Ordinary multi-child concurrent desks are not live.” |
| Forbidden | “Parallel nested graphs are shipped” when only domain concurrent selection exists. |
| Forbidden | “Production-ready multi-agent product” without Ordinary + Live rows for width and synthesis. |

## 6. Related documents

- Next steps and purity decision: `docs/scratch/adversarial-review-2026-08-04/09-NEXT-STEPS.md`
- Review synthesis: `docs/scratch/adversarial-review-2026-08-04/00-SYNTHESIS.md`
- Host extraction plan: `docs/host-extraction-plan.md`
- Session handoff: `docs/session-handoff.md`
- Concurrency policy surface (Gate 1.2): `docs/concurrency-policy-surface.md`
- Concurrent family live acceptance (Gate 1.3): `docs/gate1-3-concurrent-family-live-acceptance.md`
