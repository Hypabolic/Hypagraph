# M5A trusted evaluation contract dogfood

- Status: complete
- Dogfood date: 2026-07-24
- Executable evidence: `tests/m5a-dogfood.test.ts`
- Product baseline: `9d529e2cc549c5d2508a190b267a07361f302659`
- Pull request: #60
- Tracking issue: #30
- CI run: #621
- Test result: 79 test files and 300 tests
- Matrix: Ubuntu, macOS, and Windows with Node.js 22 and 24

## 1. Purpose

This record proves the complete M5A trusted-evaluation path through executable product tests.

The dogfood uses normal Hypagraph definitions, reducer commands, durable check lifecycle, evaluator adapters, metric parsing, evaluator integrity, event-backed budgets, Pi presentation, restore, and replay.

It does not call private reducer helpers or manufacture loop decisions directly.

## 2. Product contract proved

M5A provides:

- scalar metric reports through deterministic versioned parsing;
- separate success, progress, evaluation validity, purpose, and trust;
- aggregate or bounded-diagnostic feedback;
- protected evaluator output;
- event-backed total and per-purpose evaluation budgets;
- transparent and protected evaluator trust;
- protected file and Git integrity instruments;
- cancellation and bounded integrity deadlines;
- transport-neutral evaluator adapters;
- automatic evaluation-contract authoring guidance;
- deterministic non-blocking authoring advisories;
- accurate Pi and loop evaluator presentation;
- restore and replay without repeated external effects.

## 3. Scenario A: successful optimization and probe

The first dogfood scenario represents this prose objective:

```text
Improve a deterministic parser quality score after the implementation passes an inner specification gate. Preserve correctness, improve the measured quality over bounded iterations, and run a generalization probe before completion.
```

The generated contract contains:

- an inner specification task and typed gate;
- a development evaluator;
- typed validity and acceptance facts;
- numeric progress in maximize mode;
- a hard iteration limit;
- patience;
- total, development, and probe budgets;
- a separate probe evaluator;
- transparent trust with declared evaluator identity;
- bounded diagnostic feedback for development evaluation;
- aggregate probe feedback.

The executable path proves:

1. `spec.green = true` selects the implementation route.
2. The false route is skipped.
3. Three valid development evaluations publish scores `10`, `20`, and `30`.
4. Each score replaces the prior best result.
5. The third evaluation satisfies typed acceptance.
6. A probe publishes score `28` and `evaluation.generalization-valid = true`.
7. Evaluation counters contain three development attempts and one probe attempt.
8. Pi labels the results as a development score and a probe score.
9. Pi shows the injected evaluator adapter identity.
10. Hidden report fields do not enter normal output.
11. Event replay equals the final snapshot.
12. Session restoration equals the final snapshot.

## 4. Scenario B: protected evaluator change and patience

The second scenario starts with a protected evaluator file whose SHA-256 matches the declared contract.

The path proves:

1. The first valid score `10` becomes the best metric at iteration 1.
2. A second valid score `10` increments the no-progress count.
3. The protected evaluator file changes before iteration 3.
4. The evaluator reports `accepted = true` and score `999`.
5. Integrity becomes invalid with `integrity_protected_file_hash_mismatch`.
6. The invalid score remains in iteration evidence but does not become accepted progress.
7. The invalid result cannot complete the loop.
8. The best metric remains `10` at iteration 1.
9. Patience remains unchanged by the invalid observation.
10. The invalid-evaluation count increments.
11. After the evaluator file is restored, another valid score `10` exhausts patience.
12. The region stops with `no_progress`.
13. Protected paths, expected hashes, and hidden report fields do not enter Pi output.
14. Restore and replay reproduce the same integrity, progress, and stop decisions.

## 5. Scenario C: evaluation budget and stale result

The third scenario gives a protected development evaluator one available evaluation attempt.

The path proves:

1. An invalid observation consumes the evaluation attempt when the evaluator starts.
2. The observation cannot become best progress.
3. The region cannot start another required evaluator.
4. The region stops with `evaluation_budget`.
5. Total and development counters both equal one.
6. Restore and replay reproduce the same budget stop.
7. A result from a different attempt ID is rejected with `stale_check_attempt`.

## 6. Information-control result

The dogfood verifies that normal product output does not contain:

- protected evaluator paths;
- expected SHA-256 values;
- raw reports;
- hidden test-case values;
- private evaluator output;
- protected command arguments.

Pi shows only the declared public facts and coarse evaluator state:

- purpose;
- result claim;
- feedback mode;
- adapter identity and version;
- trust level;
- evaluator version;
- compact fingerprint;
- integrity status;
- coarse diagnostic code;
- protected-evidence count.

## 7. Trust result

The dogfood uses transparent and protected local evaluators.

It does not claim trusted holdout acceptance.

The product distinguishes:

- development score;
- probe score;
- holdout purpose without isolated trust;
- trusted isolated holdout.

Only a future production isolated evaluator can produce the final claim.

## 8. CI evidence

CI #621 passed:

- Ubuntu with Node.js 22;
- Ubuntu with Node.js 24;
- macOS with Node.js 22;
- macOS with Node.js 24;
- Windows with Node.js 22;
- Windows with Node.js 24.

The complete suite passed:

```text
Test Files  79 passed (79)
Tests       300 passed (300)
```

## 9. M5A exit decision

M5A satisfies its exit criteria:

- deterministic scalar metric production;
- separate evaluation validity;
- best-result and patience protection;
- event-backed evaluation budgets;
- bounded feedback and protected output;
- evaluator integrity before score acceptance;
- transport-neutral evaluator acquisition;
- automatic evaluation-contract authoring;
- accurate evaluator trust presentation;
- complete restore and replay;
- executable dogfood across all supported targets.

M5A is complete.

The next milestone is M5B Hypagoal. It must build autonomous continuation over one canonical Hypagraph workflow and reuse the completed M5A contract rather than introducing a second goal or evaluation model.
