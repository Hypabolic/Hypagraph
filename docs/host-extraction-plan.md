# Host extraction plan (`src/extension.ts`)

- Status: active design
- Updated: 2026-08-05
- Baseline: `src/extension.ts` ~5,780 lines; package 0.14.0
- Writing standard: ASD-STE100 Simplified Technical English
- Gate: adversarial review Gate 0.3

## 1. Purpose

This plan maps module seams for the Pi host. It does not rewrite the host in one step.

Goal: move product logic out of the single extension closure so concurrent family work, family persistence, and UI can change without one file owning every path.

## 2. Problem

`src/extension.ts` is the session god-object. It holds:

- session restore and persistence;
- UI paint and docks;
- deterministic dispatch;
- family controller and member dispatch;
- isolated root workers;
- interaction presentation;
- post-create gate;
- tools and `/hypagraph` commands;
- demo tour;
- draft and project-store load paths.

Some helpers already live under `src/pi/`, `src/ui/`, `src/domain/`, and related trees. The remaining glue and state still close over one large function.

## 3. Design rules

1. Behaviour stays the same on each extract. Prefer move then thin wrapper.
2. Domain stays free of Pi types. Host modules may import domain.
3. New product features land in extracted modules when a seam exists.
4. Absolute domain purity is not a goal. Host still owns file, network, and process effects.
5. Prefer small pull requests: one seam per change when possible.

## 4. Current layout (already extracted)

| Area | Location |
| --- | --- |
| Domain reduction and family helpers | `src/domain/` |
| Family product dispatch helpers | `src/pi/family-product-dispatch.ts`, `family-product-return.ts` |
| Isolated Pi / ACP / CLI executors | `src/pi/*-executor.ts` |
| Deterministic runners | `src/pi/deterministic-*-runner.ts` |
| Graph pane and live dock pieces | `src/pi/graph-pane.ts`, `live-graph-dock.ts` |
| Post-create dock | `src/pi/post-create-dock.ts` |
| UI surfaces and format | `src/ui/` |
| Project store paths and draft tools | `src/project-store/`, `src/pi/draft-tools.ts` |
| Demo catalog | `src/pi/demo-catalog.ts` |
| Hypagoal arming and budget helpers | `src/pi/hypagoal-*.ts` |

## 5. Target seams (extract order)

Extract in this order. Early seams reduce risk for Gates 1–2.

### Seam A — Session state bag

**Status:** done (S3, 2026-08-05)

**What:** Active workflow state, event list, family record cache, continuation queue, generation counters, paint flags.

**Why first:** Every other module needs a typed session context instead of free variables in the extension closure.

**Target:** `src/pi/session-context.ts` with create, attach-root, attach-member, and snapshot helpers.

**Exit:** extension constructs one context object and passes it.

**Done note:**
- `SessionContext` is one bag per extension session (generations, root workflow id, family cache slot, worker-pool placeholder).
- `MemberContext` holds working `state` / `events` for one member action.
- Pure `MemberContext` values are independent (attachMember clones). Two pure contexts do not clobber each other.
- Product dispatch still uses a temporary single-seat free-slot bind for nested helpers that close over free `state` / `events`. Overlapping concurrent dispatch is not safe until S4 removes that bridge.
- `dispatchDecisionOnLiveState` and `dispatchSelectedMemberAction` take an explicit `MemberContext`.
- Non-root dispatch no longer assigns free root `state` / `events` as the only working set.
- Non-root release restores the pre-bind root only when session generations still match the bind capture.
- While a non-root bind is open, `queueGoalContinuation` does not re-enter, and `rootMemberContext` refuses free child state as desk root.
- Live root free slots remain authoritative for desk-root session persistence.
- Sequential single-member behaviour is preserved. Worker pool and concurrency=N start are S4.

### Seam B — Persistence and restore

**What:** Load/store Pi session details, branch change, interrupted dispatch recovery, pause on reload.

**Depends on:** Seam A.

**Target:** `src/pi/session-restore.ts`.

**Exit:** `restore(ctx)` and related helpers live outside the main export body.

### Seam C — Family controller host

**What:** `loadFamilyRecordForController`, `persistNonRootMemberUpdate`, `applyPendingChildReturns`, `dispatchSelectedMemberAction`, member focus, family status text.

**Why:** Gate 1 concurrent wiring must not grow only inside the monolith.

**Depends on:** A, B.

**Target:** `src/pi/family-controller-host.ts` (name may vary). Reuse `family-product-dispatch.ts` and domain concurrent helpers.

**Exit:** multi-member selection and dispatch call into this module.

### Seam D — Deterministic dispatch host

**What:** `dispatchDeterministicCheck`, `dispatchDeterministicCode`, `dispatchDeterministicEffect`, parallel check batch glue, consecutive deterministic bound.

**Depends on:** A.

**Target:** `src/pi/deterministic-dispatch-host.ts`.

**Exit:** controller selects lane; this module runs deterministic work.

### Seam E — Model and isolated root dispatch host

**What:** `dispatchIsolatedRootModelTask`, abort and settle tracked attempts, timeout, cancel on restore.

**Depends on:** A, B.

**Target:** extend or wrap `src/pi/isolated-root-dispatch.ts`.

**Exit:** root model tasks do not require new large blocks in extension.ts.

### Seam F — UI paint and docks

**What:** `paintUi`, `updateUi`, post-create presentation, interaction presentation orchestration, live graph open/refresh, graph modal identity-safe refresh.

**Depends on:** A.

**Target:** `src/pi/host-ui.ts` plus existing `src/ui/` and dock modules.

**Exit:** extension registers hooks; paint logic is imported.

### Seam G — Command and tool surface

**What:** `/hypagraph` command router, tool handlers that only thin-wrap domain and host modules.

**Depends on:** A–F as needed per command.

**Target:** `src/pi/commands/` or split by area (status, history, graph, demo).

**Exit:** command registration stays small in extension.ts.

### Seam H — Demo tour host

**What:** showcase tour advance, demo member start, auto-open graph modal for demos.

**Depends on:** F, G.

**Target:** `src/pi/demo-tour-host.ts` with `demo-catalog.ts`.

**Exit:** demo code does not interleave with production controller paths.

## 6. Non-goals for this plan

- Full rewrite of the host in one change
- Moving domain logic into the host
- Extracting for purity metrics alone
- New features that only exist as comments in extension.ts

## 7. How to use this plan during Gates 1–5

| Gate work | Prefer seam |
| --- | --- |
| Concurrent family product path (1.1) | C, then A if missing |
| Synthesis host path (2.2) | C + D or new small module next to C |
| Recipe productization (3.x) | G + project-store modules |
| Live acceptance harness (4.x) | Keep harness outside extension; call host APIs |
| Host modularization (5.x) | Follow seams A→H |

## 8. Exit criteria for Gate 0.3

Gate 0.3 is complete when:

1. This document lists seams and extract order.
2. README or session handoff links this plan.
3. Implementers can open Gate 1 without inventing a new host map.

Gate 0.3 does **not** require the extracts themselves. Extracts are Gate 5 (and interleaved product work).

## 9. Related documents

- Capability ledger: `docs/capability-ledger.md`
- Next steps: `docs/scratch/adversarial-review-2026-08-04/09-NEXT-STEPS.md`
- Goal-family product plans: `docs/goal-family-product-surface-plan.md`, `docs/goal-family-product-remediation-plan.md`
