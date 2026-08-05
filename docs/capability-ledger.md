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

**Live transport policy:** A recorded Pi RPC-driver dogfood and a recorded interactive Pi TUI dogfood both satisfy **Live** when both a case ID and an evidence path exist. Automated CI substitutes do not satisfy **Live**.

Rules:

1. A claim of “shipped” for a user feature requires at least **Ordinary**.
2. A claim of release-accepted multi-agent behaviour requires **Live**.
3. **Domain** alone is not a product claim.
4. Update this file when a path moves state.
5. The **Live** column is binary: **Yes** or **No** only. Ordinary may still be Partial.
6. Every **Live=Yes** row must name a case ID and an evidence path. If either is missing, set **Live=No**.

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
| Root Hypagoal create (`/hypagoal`, `hypagoal_start`) | Yes | Yes | Yes | No | Ordinary path is real. Create appears inside broader dogfood runs, but no dedicated case ID for create as Live. Full multi-session create dogfood remains a release bar. |
| Post-create Run / Question / Cancel dock | Yes | Yes | Yes | No | Interactive TUI path exists. No dedicated live case ID for the dock alone. |
| Single-root task + command check execution | Yes | Yes | Yes | Yes | Core durable path for one task and one command check. Case ID `CASE-M6B-RESULT-TXT`. Evidence: `docs/dogfood-evidence/m6b-live/`. This case has no gate node. |
| Single-root gate execution | Yes | Yes | Yes | Yes | Gate nodes `route` and `publish-gate` under recorded Pi RPC dogfood. Case ID `CASE-M6B-LOOP-REVISION`. Evidence: `docs/dogfood-evidence/m6b-live-loop-revision/`. |
| Deterministic command checks | Yes | Yes | Yes | Yes | Command check path only. Case ID `CASE-M6B-RESULT-TXT`. Evidence: `docs/dogfood-evidence/m6b-live/`. Report, file, and Git checks remain Domain/Host/Ordinary without Live case IDs. |
| Deterministic checks (report, file, Git) | Yes | Yes | Yes | No | Host runners exist. No Live case ID for report, file, or Git check kinds. |
| Bounded loops | Yes | Yes | Yes | Yes | Loop `lint-repair` under recorded Pi RPC dogfood. Case ID `CASE-M6B-LOOP-REVISION`. Evidence: `docs/dogfood-evidence/m6b-live-loop-revision/`. |
| Trusted evaluation contracts (protected evaluator, trust modes, integrity) | Yes | Yes | Yes | No | Domain and host path exist. Product tests and M5A dogfood write-up cover contracts (`docs/m5a-dogfood.md`). No Live case ID for protected evaluator isolation. Protected production isolation still planned for some eval modes. |
| Live graph bottom dock and full graph modal | Yes | Yes | Yes | No | Product UI on demo branch; demo tour uses it. No dedicated live case ID for the dock alone. |
| Goal family projection and child create domain | Yes | Yes | Partial | No | Domain and host tools exist. Create-child is allowed for isolated-pi or current-session parents from the family desk. Live root→child→return dogfood not release-accepted. |
| Sequential multi-member family dispatch | Yes | Yes | Partial | No | Product controller sequential path is wired. Ordinary UX still awkward (R4 non-root current-session ban; family authoring density). |
| Concurrent multi-pending family selection | Yes | Yes | Partial | No | Schema 3 multi-pending; product can commit multiple model pendings in a batch. Gate 1.1–1.2 host path enforces default global concurrency (2), independent-settle partial failure, and multi-pending status honesty (see `docs/concurrency-policy-surface.md`). Per-executor limits and concurrency groups are enforced when the caller supplies them on product helpers; the ordinary extension path currently passes default policy only. S4 worker pool: keyed map of active isolated attempts; capacity is resolved `globalConcurrency` (default 2); batch path starts admitted model members concurrently and settles each pending on that worker's completion (no `modelSlots = 1`, no deferred-interrupt for a single seat). Isolated workers hold free slots only for start/register and settle (protocol in `isolated-free-slot-protocol.ts`); process await does not hold free slots. Host commits only free-seat model members (no selected-without-start residual). Concurrent settle merges member stream and pending under one lock so sibling bags are not clobbered. Status reports multi-worker occupancy. Gate 1.3 case `CASE-G1-3-CONCURRENT-FAMILY`: raised Live bar requires two live model workers in a real Pi session, multi-pending occupancy of two, mid-flight window, and independent settle of both. A two-id concurrent batch notify alone is not enough (see acceptance §1). Acceptance: `docs/gate1-3-concurrent-family-live-acceptance.md`; evidence stub `docs/dogfood-evidence/gate1-3-live/` (empty). Automated substitutes `tests/gate1-3-concurrent-family-live-acceptance.test.ts` and `tests/s4-worker-pool-concurrent-fanout.test.ts` do not earn Live. Live Pi dogfood is not recorded; **Live** remains **No**. |
| Optional grandchild / family depth | Yes | Partial | No | No | Domain depth bounds exist. Product create-child may create nested members within depth limits. Full ordinary grandchild desk and live dogfood not accepted. See F6 in `docs/goal-family-product-surface-plan.md`. |
| Worktree leases / isolated checkout integration | Yes | Partial | No | No | Domain seams exist. Ordinary product wiring incomplete. |
| Derived fan-out from collection facts | Yes | No | No | No | Domain + tests. Not ordinary product surface. |
| Isolated model workers (`isolated-pi`) | Yes | Yes | Yes | No | Default for root model tasks when spawn works. No dedicated live case ID for isolated multi-worker proof. |
| ACP / CLI external executors | Yes | Yes | No | No | Adapters exist; engineer surface, not first-run product. |
| Aggregate / quorum / synthesis nodes | Yes | Yes | Yes | No | Ordinary multi-child all-success join is on the product path. Domain: `child-outcome-synthesis.ts` (schema v1 all-success policy/result; pure evaluate; host-default or declared `join.passed`). Host: `family-product-synthesis.ts`; extension applies ready join after child returns and on restore re-entry. Wait set: parent may create siblings while `waiting_for_child`; parent stays waiting while any sibling for that parent node is active; host evaluates join when every sibling is terminal. Host publishes default fact `join.passed`=true without author produce when every member completed. Ordinary path does not use hand `expectedBindingCount` (multi-child wait set; minimum two bindings, `AUTO_JOIN_MIN_BINDING_COUNT`=2). Pass leaves parent running for integration. On non-completed child return, failure policy owns the parent first and synthesis quiet-skips; residual join-fail may publish `join.passed`=false and block only while the parent is still running at join evaluation. One-child does not auto multi-join under the two-binding minimum. Optional advanced: declare boolean produce `join.passed` for gates; `expectedBindingCount` is host/test policy only, not a create-child or parent-definition author field. Full quorum, ranked, and model synthesis strategies, named multi-agent recipes, and aggregate node kinds are not shipped. Live dogfood still open (no case ID). |
| Named recipe library (beyond one implement-verify tool) | Partial | Partial | No | No | One minimal recipe tool. Library and launch-with-args incomplete. |
| Gauntlet / blind multi-critic panel | Partial | No | No | No | Design docs only. |
| In-Pi showcase demo tour | N/A | Yes | Yes | No | Deterministic fixtures only. Not multi-agent proof. No live multi-agent case ID. |
| Session restore and pause / resume | Yes | Yes | Yes | No | Kernel path strong; family live restore dogfood incomplete. No dedicated restore case ID as Live. |
| Event history, explain, replay surfaces | Yes | Yes | Yes | No | Commands exist; live dogfood depth varies. No dedicated case ID for full surface Live. |
| Project store drafts and constructors | Yes | Yes | Partial | No | Task/check/require/loop constructors. Interaction, gate, code, effect free-form only. No dedicated live case ID. |

## 5. Public claim policy

| Allowed claim style | Example |
| --- | --- |
| Accurate | “Concurrent multi-pending family selection is on the host product path. Host model capacity is N under resolved globalConcurrency (default 2) after S4. Live multi-pending concurrent family acceptance under real Pi is not complete.” |
| Accurate | “Kernel supports goal families. Ordinary multi-child concurrent desks are not live.” |
| Forbidden | “Parallel nested graphs are shipped” when only domain concurrent selection exists. |
| Forbidden | “Production-ready multi-agent product” without Ordinary + Live rows for width and synthesis. |
| Forbidden | Mark ledger **Live=Yes** for concurrent family without real Pi dogfood under `docs/dogfood-evidence/gate1-3-live/` against the raised §5.1 bar. |

## 6. Related documents

- Next steps and purity decision: `docs/scratch/adversarial-review-2026-08-04/09-NEXT-STEPS.md`
- Review synthesis: `docs/scratch/adversarial-review-2026-08-04/00-SYNTHESIS.md`
- Host extraction plan: `docs/host-extraction-plan.md`
- Session handoff: `docs/session-handoff.md`
- Concurrency policy surface (Gate 1.2): `docs/concurrency-policy-surface.md`
- Concurrent family live acceptance (Gate 1.3): `docs/gate1-3-concurrent-family-live-acceptance.md`
