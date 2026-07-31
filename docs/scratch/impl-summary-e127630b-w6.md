# Wave 6 implementation summary — Isolated model sessions

## Status

**Wave 6 code complete for S6.1–S6.3 and S6.6–S6.7.** S6.4 (affinity) and S6.5 (revision/loop workers) deferred. Live interactive dogfood of a real Pi worker process is pending.

## Goal

Main Pi session is orchestrator only. Default model-node task attempts use isolated-pi worker sessions, not same-session implement follow-ups.

## Slices

| Slice | Result |
| --- | --- |
| **S6.1** | Pure `resolveModelNodeExecutorProfile`: default `isolated-pi`; `current-session` only when explicit (node or test legacy flag) |
| **S6.2** | Root `queueGoalContinuation` routes `start-ready-task` / `continue-active-task` through `dispatchIsolatedPiAttempt`; no `sendUserMessage` follow-up on default path |
| **S6.3** | Host tracks `activeIsolatedRootAttempt`; restore/branch teardown + cancel-attempt; `/hypagraph executor cancel` cancels task; double-settle rejected |
| **S6.4** | Deferred (cold default only) |
| **S6.5** | Deferred (revision still orchestrator follow-up) |
| **S6.6** | Tool block on mutating tools while root worker is active |
| **S6.7** | Executor status shows default routing + root worker line; skill orchestrator/worker section |

## Key modules

| File | Role |
| --- | --- |
| `src/domain/model-executor-profile.ts` | Pure profile resolution policy |
| `src/pi/isolated-root-dispatch.ts` | Routing, prepare, settle guards, orphan cancel helpers |
| `src/extension.ts` | Root isolated dispatch loop, tool block, restore/cancel |
| `tests/model-executor-profile.test.ts` | S6.1 pure tests |
| `tests/isolated-root-dispatch.test.ts` | S6.2–S6.3 pure/host-helper tests |
| `tests/wave6-isolated-root-extension.test.ts` | Extension path: no follow-up, opt-in follow-up, tool block |
| `tests/setup-legacy-session.ts` + `vitest.config.ts` | Suite flag for legacy follow-up fixtures |

## Design decisions

1. Default profile is `isolated-pi-default` / `isolated-pi`.
2. Optional `node.executorProfile` is the product opt-in surface for `current-session`.
3. Root isolated path starts the node, dispatches the worker, settles, then auto-verifies after submit so the controller can select the next action without an orchestrator implement turn.
4. In-flight root attempt is host memory (not domain schema). Restore teardowns the process and cancels the tracked task attempt.
5. `HYPAGRAPH_LEGACY_CURRENT_SESSION=1` is test-suite only (setup file). Product runtime leaves it unset so default is isolated-pi.
6. Wave 4 post-create gate is unchanged: interactive create still waits for Run before any dispatch.

## Tests run

```text
npx tsc --noEmit
npx vitest run tests/model-executor-profile.test.ts tests/isolated-root-dispatch.test.ts tests/wave6-isolated-root-extension.test.ts tests/post-create-dock.test.ts tests/hypagoal-continuation-pi.test.ts tests/hypagoal-revision-pi.test.ts tests/m6a-turn-accounting.test.ts
```

73/73 passed in the focused set above. Typecheck clean.

## Not done

- Live Pi dogfood with a real worker process after create → Run
- S6.4 session affinity / fork
- S6.5 automatic revision and loop bodies fully on workers
- Release notes packaging for the behaviour break
- Full `npm test` suite (partially validated; suite uses legacy flag for old follow-up fixtures)

## Behaviour break

Default task work no longer appears as an implement follow-up in the orchestrator chat. Users who need same-session implement turns must set `executorProfile.kind: "current-session"` on the task node.
