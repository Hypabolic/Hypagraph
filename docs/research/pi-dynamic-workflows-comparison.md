# Comparison with script orchestration products

- Status: reference
- Date: 2026-07-28
- Subject: `pi-dynamic-workflows` (github.com/QuintinShaw/pi-dynamic-workflows)
- Source: the published README and its design notes, not a source audit
- Writing standard: ASD-STE100 Simplified Technical English

## 1. What the other product does

The product decomposes one large request into concurrent subagent work. A model
writes a JavaScript orchestration script. The script spawns up to 16 concurrent
subagents, and up to 1000 for each run. Intermediate results stay in script
variables, so they do not fill the chat context.

The runtime provides `agent`, `parallel`, `pipeline`, and `phase`. It adds
quality patterns for cross-checking, bounded repeat, and human approval. It runs
the script in a sandbox which removes the clock, randomness, the file system,
and the network, so a run replays exactly.

The same runtime shape exists in the Claude Code `Workflow` tool. The pattern is
settled, and it is not novel ground.

## 2. What it does not provide

- no dependency graph between named units of work. It provides sequence and
  concurrency only;
- no typed fact contract. A step passes a JavaScript variable, with optional
  JSON Schema validation on a result;
- no validation before execution;
- no rule which stops a model from declaring that work is complete;
- no durable workflow which a later session continues. It stores a run journal
  for replay, and it removes old runs at 300 for each project.

## 3. Where it is ahead of Hypagraph

- concurrent execution with worktree isolation. Hypagraph v0.7 is root-only and
  sequential in one session;
- cost accounting for each agent, each phase, and each run;
- edit-and-resume, which replays unchanged calls from a cache.

## 4. Where Hypagraph is ahead

- typed fact contracts with producer, attempt, and revision provenance;
- validation before execution;
- checks which run real executors and publish typed facts, instead of a vote
  between models;
- the rule that the model has no completion tool;
- trusted evaluation contracts with integrity, fingerprints, and protected
  feedback;
- durable state which a later session continues.

## 5. The decision which follows

Hypagraph must reach the same wide-work results. It must not adopt the script
model to do so.

A script orchestrator spends one model turn to write the orchestration, and it
repeats that cost on each run. Hypagraph spends the model turn one time, at
authoring, and the controller then performs every orchestration step in the
deterministic lane.

`docs/deterministic-orchestration-plan.md` gives the plan.

## 6. Where a model panel belongs

A check which runs a command is better than a panel of models when an executable
answer exists. A test result cannot be argued with.

Use a model panel only for a question which has no executable answer. Design
coherence and missed cases are such questions.

The reduction must stay deterministic in both cases. A model which summarises
votes is one more opinion, not a check.
