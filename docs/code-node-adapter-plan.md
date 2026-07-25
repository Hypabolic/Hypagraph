# Code node and sandbox executor adapter plan

- Status: accepted decision, implementation not started
- Milestone: M6.2
- Release marker: v0.9
- Prerequisite: M6A deterministic dispatch
- Updated: 2026-07-25
- Depends on: `docs/graph-capability-review.md`, `docs/execution-roadmap.md`
- Consumed by: `docs/m6-3-external-effect-plan.md`
- Pattern source: https://github.com/monotykamary/pi-fabric (MIT)
- Writing standard: ASD-STE100 Simplified Technical English

## 1. Decision

Hypagraph adds a `code` node kind. A code node runs one type-checked program in a sandbox behind a Hypagraph-owned executor adapter.

Hypagraph adopts the execution pattern of `pi-fabric`. Hypagraph does not depend on the `pi-fabric` package.

## 2. Reason for a Hypagraph-owned adapter

### 2.1 A package dependency would give the model an orchestrator

`pi-fabric` is a Pi extension. It registers `fabric_exec` as a model-visible tool. It also bundles workflow, council, and swarm skills.

`docs/graph-capability-review.md` section 5 rejects the orchestrator placement. A model-visible `fabric_exec` tool would restore that placement through the tool surface. The model could write one program which contains the branching, the loops, and the fan-out for the whole workflow, and the graph would not see any of it.

Hypagraph narrows the active tool set for each delivered continuation with `pi.setActiveTools`. That control only works when no other extension offers a general execution tool.

An adapter keeps the sandbox available to the controller. It does not give the sandbox to the model.

### 2.2 A package dependency would add a second toolchain

At version 0.25.10 the dependency sets conflict:

| Dependency | Hypagraph | pi-fabric |
| --- | --- | --- |
| `typescript` | `5.8.3` | `^6.0.3` |
| `typebox` | `1.3.6` | `1.1.38` |
| `@earendil-works/pi-ai` | `0.80.10` | `0.80.6`, exact |

A dependency would also add `shiki`, `mcporter`, `cross-spawn`, and `diff` to the tree.

### 2.3 A package dependency would work against the version 1.0 exit criteria

The roadmap requires that the domain package has no Pi dependency. It also requires that reusable external code sits behind a Hypagraph-owned executor adapter. Section 3.3 makes the controller the only canonical writer.

## 3. What Hypagraph adopts

Hypagraph adopts these properties of the pattern:

1. one type-checked program for each execution;
2. a QuickJS sandbox which denies `process`, `require`, the file system, the network, and subprocess globals;
3. a JSON-only host bridge for every side effect;
4. an action registry which applies schemas, timeouts, cancellation, and audit records;
5. a fresh sandbox context for each execution;
6. declared bindings which throw on an undeclared key instead of returning `undefined`;
7. a TypeScript check which reports a line-numbered error before execution;
8. one returned value as the result.

Hypagraph can depend directly on the sandbox libraries, because they are independent of `pi-fabric`:

- `quickjs-emscripten-core`;
- `@jitl/quickjs-singlefile-mjs-release-sync`.

## 4. What Hypagraph does not adopt

1. the `fabric_exec` model-visible tool;
2. the workflow, council, and swarm skills;
3. the Node-process executor. Its own documentation states that it is not a security boundary. A non-isolated executor does not satisfy the Hypagraph isolation rules;
4. the interactive approval, certification, and mesh layers. Hypagraph has its own lifecycle, evidence, and interaction model;
5. model-authored programs at call time. See section 7.

## 5. Adapter contract

Mirror the existing `CheckExecutor` and `EvaluatorAdapter` seams in `src/checks/`.

```ts
export interface CodeExecutionRequest {
  workflowId: string;
  revision: number;
  nodeId: string;
  attemptId: string;
  requestedAt: string;
  definition: CodeNodeDefinition;
  bindings: Record<string, FactValue>;
}

export interface CodeExecutor {
  readonly id: string;
  readonly version: number;
  execute(request: CodeExecutionRequest, signal: AbortSignal): Promise<CodeResult>;
}
```

`CodeResult` mirrors `CheckResult`. It contains the status, the returned value, the declared facts, the evidence, the artifact references, and an optional error. It also contains the audited list of bridge calls, which becomes evidence.

Use the same terminal status set as a check: `passed`, `failed`, `timed_out`, `cancelled`, `interrupted`, and `error`. Use a discriminated response with an explicit adapter-error outcome, as `EvaluatorAdapter` does.

## 6. Definition shape

Separate the executable body from the node semantics. A node definition must not contain another node definition.

```ts
export interface SandboxProgramDefinition {
  version: 1;
  program: string;
  inputs: string[];
  capabilities: CodeCapability[];
  timeoutMs: number;
  maxMemoryBytes: number;
  maxBridgeCalls: number;
  maxResultBytes: number;
}

export interface CodeNodeDefinition {
  kind: "code";
  execution: SandboxProgramDefinition;
  retry?: CheckRetryPolicy;
}
```

`SandboxProgramDefinition` is the reusable executable body. M6.3 reuses it for an effect program and for a reconciliation program. M6.1 can reuse it for a presentation program after M6.2.

The node reuses the existing `produces` fact contract and the existing `scope.paths`.

`capabilities` is an allowlist. The bridge must deny by default. A capability declares one surface, for example a named Pi tool, a named MCP server with named methods, or bounded read access to declared paths.

A declarative allowlist is a Hypagraph addition. The pattern source applies approvals at run time. Hypagraph must decide the permitted surface at definition time, so that validation and the non-weakening revision rules can inspect it.

### 6.1 Capability effect classes

Every capability in the bridge registry must declare an effect class:

```ts
export type CapabilityEffectClass =
  | "pure"
  | "observation"
  | "workspace-mutation"
  | "external-effect";
```

Validation must enforce which node kind may use which class:

| Node kind | Permitted classes |
| --- | --- |
| Code node | `pure`, `observation`, and declared `workspace-mutation` |
| Effect node, effect program | `external-effect`, plus the classes above |
| Effect node, reconciliation program | `observation` only |
| Interaction presentation program | `pure`, `observation`, and a bounded presentation capability |

Without this rule an ordinary code node could call a mutating MCP method. It would then perform an external effect and bypass every M6.3 guarantee about requested, observed, and indeterminate state.

The bridge must reject a call whose capability class the node kind does not permit. Validation must reject the definition before execution, and the bridge must reject it again at run time.

### 6.2 "Deterministic" describes the control path, not the observation

A code node is deterministic in its control path. The program text is fixed at definition time, the bindings come from canonical facts, and the sandbox denies ambient input.

An observation is not deterministic. A query to CI, to Linear, or to any external system can return a different answer at a different time.

The result becomes deterministic for replay only after the controller records the observation. Replay then replays the recorded value.

Use the word "deterministic" for the dispatch lane and for the control path. Do not use it to claim that an observation returns a stable value.

## 7. Constraints which Hypagraph adds

1. Author the program during the authoring turn or the bounded revision turn. Store it in `HypagraphDefinition`. Include it in the snapshot hash.
2. Run the TypeScript check in the tool and authoring layer, not in the reducer. The reducer must stay pure, as `AGENTS.md` requires. The reducer validates structure only.
3. Keep the sandbox on the executor side.
4. Validate the returned value against the node `produces` contract in the controller. Do not trust the bridge validation. The pattern source states that its own directive output stays untrusted.
5. Verify a mutating program with the existing Git assertion instrument and `changed-paths`.
6. Record the result as an event. Use the existing durable order: store start, run the effect, store the raw result, publish the declared facts, then store verification. Replay must replay the recorded result. Replay must never run the program again.
7. Route a program which the runtime discovers later through `hypagraph_revise` or the bounded-revision path.
8. Treat the capability allowlist as a safeguard for the non-weakening revision rules. A revision must not widen it.

## 8. Compilation and runtime pinning contract

A program which type-checks under one toolchain must not execute differently after an upgrade. The executor already carries an identity and a version. The compiler configuration and the bridge schemas need durable identity too.

### 8.1 Pinned values

Record every value below in a durable `SandboxRuntimeIdentity`, and include it in the snapshot hash:

| Value | Reason |
| --- | --- |
| TypeScript compiler version | A new compiler can accept or reject different source. |
| TypeScript compiler options, as an exact object | Target, lib, strictness, and module settings change the emitted code. |
| Allowed language target | A newer target emits syntax which the sandbox may not support. |
| Ambient type definitions, as a fingerprint | The program must see only the declared bridge surface, and no Node or DOM globals. |
| QuickJS runtime version | The engine decides which syntax and which built-ins exist. |
| Bridge action schema fingerprint | A changed argument or result schema changes program behaviour. |

### 8.2 Bounds

Every program declares, and the executor enforces:

- a maximum execution time;
- a maximum memory size;
- a maximum bridge-call count;
- a maximum result size.

These are mandatory, not optional. `SandboxProgramDefinition` in section 6 makes `maxMemoryBytes`, `maxBridgeCalls`, and `maxResultBytes` required for this reason.

### 8.3 Transpilation

Transpilation must be deterministic. The same source and the same pinned configuration must produce the same JavaScript, byte for byte.

Decide and record whether compiled output is persisted or regenerated:

- persist the compiled output when replay must not depend on the compiler being installed;
- regenerate the output when the definition must stay small, and accept that replay then needs the exact pinned compiler.

The recommendation is to persist the compiled output and its hash. Replay then needs the QuickJS runtime only, and it does not need the TypeScript compiler. This keeps replay closer to the rule that replay must not recompute an external result.

### 8.4 Upgrade path

A change to any pinned value is a runtime-identity change. Treat it as a schema change:

1. record the new identity;
2. keep the old identity readable for replay of an old event stream;
3. do not silently re-execute an old program under a new runtime identity.

An existing workflow keeps its recorded identity until an explicit revision changes it. A revision which changes the runtime identity must be visible, because it can change behaviour.

## 9. Authoring rules which hold the node-body placement

The decision in section 1 is a boundary, not only a position. Without an authoring rule the boundary moves. An author can write a larger program at each revision until the graph becomes decorative and the control flow is again invisible.

Apply these rules when a workflow declares a code node:

1. Prefer graph structure over program size. If work can be two nodes and one gate, do not make it one program with an `if` statement.
2. Keep a branch in the graph when the branch changes what runs next. A condition inside a program may select a value. It must not select downstream work.
3. Keep repetition in a loop region when each pass needs an attempt, evidence, a check, or an evaluation. Use a program loop only for bounded deterministic data work inside one node.
4. Use parallel calls inside a program only for deterministic input and output. Use graph fan-out when each branch needs its own attempt, evidence, retry, or visibility.
5. Keep one result contract for each code node. A program which returns a large object with many unrelated facts is usually more than one node.
6. Do not put semantic work in a program. A program cannot reason. Model work belongs in a task node.

Add a definition-time advisory when a program exceeds a declared size, or when it declares many produced facts. Report the advisory through the existing authoring advisory surface. Do not reject the definition. The advisory identifies a probable modelling error, not an invalid graph.

Add these rules to the bundled skill when the slices in section 10 start.

## 10. Implementation slices

1. Add the `code` node kind, the definition schema, and structural validation.
2. Add the `CodeExecutor` seam and one in-memory test executor.
3. Add the QuickJS sandbox executor and the JSON host bridge with a deny-by-default registry.
4. Add binding injection from declared inputs and result validation against `produces`.
5. Add the TypeScript check at definition time with line-numbered diagnostics, the pinned compiler configuration, and the durable `SandboxRuntimeIdentity` from section 8.
6. Add the durable lifecycle, the new event types, cancellation, retry, and artifacts.
7. Add capability allowlists for Pi tools and MCP servers, with the effect classes from section 6.1 enforced at validation time and again at the bridge.
8. Add scope verification for a mutating program.
9. Add graph-pane and model-visible surfaces.
10. Add replay, restore, and non-weakening revision tests.

Use new event types which mirror the check events. Do not reuse the check event types. Separate types let the M6 history and replay views show a code node correctly.

## 11. Relation to other gaps

- N2 deterministic dispatch must land first. A code node needs no model turn, so it belongs in the same deterministic lane as a check and a gate.
- N5 effect nodes use a code node with a capability grant for one external surface. The sandbox and an idempotency key give the execution mechanism only. An external effect still needs durable `requested`, `observed`, and `indeterminate` states and a reconciliation step after a restart. Do not treat a code node as sufficient for a merge, a deployment, or a pull-request creation.
- N1 presentation effects can use the same adapter with a capability grant for a skill or a report renderer. The typed response contract and the non-fault wait state remain separate work.
- M7 keeps its scope. The sandbox executor is a second executor kind behind the same seam, next to the planned isolated Pi executor.
- A code node cannot perform semantic work. Parallel calls inside one program are not graph fan-out. See `docs/graph-capability-review.md` section 5.
