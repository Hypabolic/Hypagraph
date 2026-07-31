Write permission wasn't granted, so the review is here in full rather than saved to `docs/scratch/claude-opus-product-review.md` (that file exists but is 0 bytes — a prior run failed).

## Product summary

This is a coherent product slice. All five promises in the program goal have real code behind them, and the seams are in sensible places: a pure Mermaid projection, a shared bottom-dock helper, a pure executor-profile policy, and a host-only gate that keeps the domain reducer pure. The journey reads correctly on paper — arm → author → review graph → Run → workers execute → ask at the bottom — and it matches the "arm, don't force" mental model the Grok/pi-dynamic-workflows comparison work targets. I would dogfood it, but I would not call it verified: all five steps are marked live-pending, and the two claims carrying the most user trust (isolated workers, no auto-run) are the two with the least live evidence. The largest product hole is that the flagship demo graph cannot be built via the authoring path the skill tells the model to prefer.

## Strengths

- **The post-create gate is layered, not a flag.** `postCreateAwaitingUserChoice` suppresses `queueGoalContinuation`, injects a "do not start work" system prompt, *and* blocks `write`/`edit`/`bash`/transitions/checks/revisions/second create. Three independent mechanisms for one promise — correct for a claim users will lean on.
- **Cancel is transactional.** The gate clears only after `cancel-goal` commits; a failed cancel leaves the goal gated rather than half-cancelled.
- **Esc → Question, not Cancel.** Right default for a dock that appears unrequested.
- **Dock failure fails closed** (`extension.ts:1546`): a thrown dock leaves the gate set and notifies with both recovery commands. No silent auto-run on broken UI.
- **Highlight and arming share one matcher.** `findHypagoalTriggerSpans` backs both paint and submit; the review round removed the second regex from the paint path. You can't see a highlight that doesn't arm — the property that makes an arming affordance believable.
- **Isolated-by-default is pure policy**, not host branching (`resolveModelNodeExecutorProfile`), with `current-session` as explicit node opt-in.
- **Honest status discipline.** Plan and E2E note both say "code complete, live acceptance pending," and Wave 8's summary records the review that forced that wording. Keep this.
- **Free-text follow-ups weren't faked.** Wave 2 concluded `ui.input` already lands in the composer slot and declined to invent an overlay.

## Product gaps and risks

### Gap 1 -- Severity: high
- Area: Authoring path vs. the demo graph (Wave 7 vs. Wave 8)
- Why it matters for the user: `SKILL.md` step 9 says use `draftId` and demotes free-form `definition` to "tests, import, or advanced recovery." But constructors are only `hypagraph_add_task`, `hypagraph_add_check`, `hypagraph_require`, `hypagraph_loop`, plus the implement/verify recipe — no interaction, gate, code, or effect constructor. So the product's own E2E fixture (`do-work` → `approve-work`) must be hand-authored free-form, and `docs/scratch/product-surface-e2e-path.md` §3.2/§4.1 say so outright. The recommended path cannot produce the flagship demo; a model reading the skill will either skip the interaction node or use a path it was told is for tests.
- Recommendation: Add `hypagraph_add_interaction` (then `hypagraph_add_gate`). Until it lands, replace the skill's "tests, import, or advanced recovery" with the precise truth: constructors cover task/check/dependency/loop; free-form remains the supported path for interaction, gate, code, effect. Ahead of S6.4/S6.5/S7.5.

### Gap 2 -- Severity: high
- Area: Isolated worker execution — unbounded and invisible (Wave 6)
- Why it matters for the user: `dispatchIsolatedRootModelTask` calls `dispatchIsolatedPiAttempt(…, new AbortController().signal, …)` — a fresh signal that is never aborted. There is no timeout anywhere in `src/pi/isolated-pi-executor.ts` (the only deadline is the SIGKILL grace window). That await sits inside `queueGoalContinuation`, awaited from `agent_end`, inside a `while` loop that continues into the next node. Between "started isolated worker" and "finished" the user gets nothing — no progress, elapsed time, or tokens. The promise is "the orchestrator is free"; the observable may be a session that appears to sit still. A worker stuck on auth has no automatic escape.
- Recommendation: (1) Give the dispatch a real `AbortController` that `/hypagraph executor cancel` and `restore` abort. (2) Add a per-attempt timeout with a settle-as-failed path. (3) Emit a periodic worker line (node, attempt, elapsed) to the normal status surface. Make "can I type, and can I cancel, while a worker runs" the *first* live check.

### Gap 3 -- Severity: medium
- Area: Trust in the isolated-by-default claim
- Why it matters for the user: `src/extension.ts:1944` reads `process.env.HYPAGRAPH_LEGACY_CURRENT_SESSION === "1"` in the **production** routing call. The headline behaviour break of this release can be flipped by an ambient env var no surface documents or displays. Someone with it set from an old shell profile sees task work implement in the orchestrator chat while README and skill say it doesn't.
- Recommendation: Remove the env read from the runtime path; inject `legacyCurrentSessionDefault` from the test setup via extension options. If an escape hatch must remain, show it in `/hypagraph executor status`.

### Gap 4 -- Severity: medium
- Area: Durability of the post-create decision
- Why it matters for the user: The gate is host memory and `restore()` clears it. The earlier Codex framing ("auto-run after reload") does not hold — `restore()` also commits `pause-goal` for any active goal (`extension.ts:848`), so nothing dispatches. The real residue is different: after Question + reload, "I haven't decided" and "I paused mid-run" are the same state, and `/hypagraph resume` maps to Run. A user who deferred to think comes back, types resume out of habit, and work starts with no second look at the diagram.
- Recommendation: Persist the deferred decision with the goal, or have `resume` re-present the post-create dock when the goal has never dispatched a node. The second is cheap and needs no schema change.

### Gap 5 -- Severity: medium
- Area: Two enforcements of one "read-only" promise
- Why it matters for the user: The authoring turn blocks only `write` and `edit` (`extension.ts:2350`); the post-create gate blocks `write`, `edit`, and `bash`. Both surfaces tell the user "Hypagraph isn't touching your repo yet," but during authoring the model can still shell out. A user who watched the dock behave correctly will assume authoring does too.
- Recommendation: Block `bash` during authoring, from one shared blocked-tool list used by both gates so they can't drift again.

### Gap 6 -- Severity: medium
- Area: Silent project-store failure (Wave 7)
- Why it matters for the user: The `.hypagraph` write after create is `try { … } catch {}` with no notify (`extension.ts:2528–2557`). On a read-only dir or corrupt index, the runtime goal is live, the committed definition artifact is missing, and the source draft stays `status: "draft"` forever — with the user told nothing. The point of the durable draft story is that the artifact exists.
- Recommendation: Keep create succeeding, but notify once on failure and report artifact state in `/hypagraph status` ("definition artifact: written / not written").

### Gap 7 -- Severity: medium
- Area: README narrative vs. shipped product
- Why it matters for the user: The front section describes the dock and highlight well. "Current status" then lists under **Next**: isolated executors, worktree integration, bounded concurrency, ACP and named CLI adapters, and interaction presentation/deadlines — all shipped at v0.14. **Implemented** never mentions the post-create dock, the bottom interaction dock, `.hypagraph` drafts, or constructor tools. The body still says "the current v0.6 product surface" while `package.json` reads 0.14.0. An evaluator sees a product two releases behind reality.
- Recommendation: Rewrite "Current status" as the v1.0 narrative before any release cut. Cheapest credibility win available.

### Gap 8 -- Severity: medium
- Area: Naming and surface consistency
- Why it matters for the user: Create is `/hypagoal`, control is `/hypagraph`, compat subcommands persist on `/hypagoal`, and tools split prefixes — `hypagoal_start`, `hypagoal_submit_revision` vs. `hypagraph_draft_begin`, `hypagraph_add_task`, `hypagraph_validate`. The skill spends a paragraph teaching the split; the model guesses a prefix each time.
- Recommendation: Decide before v1.0. Cleaner: `/hypagraph new <objective>` for create, `/hypagoal` as compat alias, `hypagoal_start` → `hypagraph_start` with the old name aliased one release. If the split is intentional ("hypagoal is the thing, hypagraph is the tool"), state it in one sentence in README and skill and make prefixes follow it exactly.

### Gap 9 -- Severity: low
- Area: Status legibility while a worker runs
- Why it matters for the user: `renderWorkflow` (`src/ui/format.ts:62`) shows `Active:`, `Goal next:`, budgets, loops — but neither it nor `hypagoal-surface.ts` knows about `activeIsolatedRootAttempt`; that appears only in `/hypagraph executor status`. During a worker run, `/hypagraph status` shows an active node and a "Goal next" line with nothing indicating a separate process owns the work or how long it's been running. This is the "Goal next" confusion in your brief, and it compounds Gap 2.
- Recommendation: Add one worker line to the main status render (node, attempt, profile, elapsed).

### Gap 10 -- Severity: low
- Area: Re-entry and replacement friction
- Why it matters for the user: The dock shows once per gate (`postCreateDockPresented`); after Question there's no command to reopen it — the user falls back to `/hypagraph graph` or `resume`. Replacement create *does* reach the dock (the second `hypagoal_start` returns `created`), but only after a typed confirmation produced inside a model turn. Neither is broken; both are stall points for a first-time user.
- Recommendation: Add `/hypagraph dock` (or extend `/hypagraph graph`) to re-present while the gate is open. During dogfood, confirm the replacement confirmation text reads as a user instruction, not a model artifact.

## Recommended dogfood script

1. **Worker containment first.** Create a single-task goal, choose **Run**, and while the worker runs: type into the composer, run `/hypagraph status`, `/hypagraph executor status`, then `/hypagraph executor cancel`. Record whether input is accepted and whether cancel actually stops the worker. (Gap 2 — highest-value unknown.)
2. **Isolation proof.** Same run: confirm no implement follow-up in the orchestrator chat, and that a real worker process existed.
3. **Question → reload → resume.** Create, choose **Question**, ask about the graph, reload, then `/hypagraph resume`. Confirm the pause message and note whether resuming feels informed or surprising. (Gap 4.)
4. **Authoring block.** During an authoring turn, confirm whether `bash` runs. (Gap 5 — one turn.)
5. **Full E2E path.** Run §6 of `product-surface-e2e-path.md` with the §4 interaction fixture: arm + watch highlight → submit → create → dock → Run → isolated task → bottom interaction dock → answer. Record terminal size (dock budget is 55% of rows).
6. **Dock edge cases.** L3 and L5 from `wave2-dogfood-note.md`: 80×24 terminal; a question with 8+ responses.
7. **Cancel path.** Another create → **Cancel**; confirm the gate clears only after success.
8. **Store artifact.** Inspect `.hypagraph/` for the committed definition and draft history; then repeat one create with the directory read-only and see what the user is told. (Gap 6.)

Steps 1–4 alone close or escalate the three highest gaps.

## Priority order for next product work

1. **Interaction constructor** (`hypagraph_add_interaction`) — or an honest skill correction if it slips. Closes Gap 1.
2. **Worker abort wiring + per-attempt timeout.** Cancel that can't cancel is worse than no cancel.
3. **Live dogfood steps 1–5** — S8.1 acceptance. Nothing else should be called done first.
4. **Remove the env override from production routing** (Gap 3). One line; protects the release's headline claim.
5. **Worker progress line in the main status surface** (Gaps 2, 9).
6. **Align authoring and post-create blocked-tool lists** (Gap 5).
7. **Project-store failure notify + status line** (Gap 6).
8. **README "Current status" rewrite** (Gap 7) — before, not during, a release cut.
9. **Naming decision and alias plan** (Gap 8) — only gets more expensive.
10. **Then** S6.5 (revision/loop bodies on workers), S6.4 affinity, S7.5 events. S6.5 first of the three: revision turns are the last common path still landing in the orchestrator chat, which contradicts the isolation story.

Want me to save this to `docs/scratch/claude-opus-product-review.md`? You'll need to approve the write.
