import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ActiveCheckExecutionRegistry } from "./checks/active-executions.js";
import { ActiveCodeExecutionRegistry } from "./code/active-executions.js";
import { QuickJSSandboxExecutor } from "./code/sandbox-executor.js";
import { ActiveEffectExecutionRegistry } from "./effect/active-executions.js";
import { SandboxEffectExecutor } from "./effect/execution.js";
import { capabilityIsPermittedForRole } from "./domain/effect-authoring.js";
import { MemoryEffectHost } from "./effect/memory-effect-host.js";
import { CommandCheckExecutor } from "./checks/command-executor.js";
import { FileCheckArtifactStore } from "./checks/file-artifact-store.js";
import { DefaultPresentationExecutor } from "./checks/presentation-executor.js";
import { recoverInterruptedChecks, recoverOrphanedLoopAttempts } from "./checks/recovery.js";
import { recoverInterruptedEffects } from "./effect/recovery.js";
import { evaluateCheckStart } from "./domain/check-policy.js";
import type { GoalFamilyRuntime } from "./domain/goal-family.js";
import type {
  DomainEvent,
  EvidenceReference,
  FactInput,
  HypagraphCommand,
  HypagraphState,
  InteractionDefinition,
  PersistedHypagraph,
} from "./domain/model.js";
import { InteractionDialogComponent, type InteractionDialogResult } from "./pi/interaction-dialog.js";
import { createWorkflow } from "./domain/reducer.js";
import { isReadyGateDecision } from "./domain/deterministic-gate-dispatch.js";
import { isReadyCheckDecision, type ReadyCheckDecision } from "./domain/deterministic-check-dispatch.js";
import { isReadyCodeDecision, type ReadyCodeDecision } from "./domain/deterministic-code-dispatch.js";
import {
  isDeterministicEffectDecision,
  type DeterministicEffectDecision,
} from "./domain/deterministic-effect-dispatch.js";
import { readyNodeIds } from "./domain/readiness.js";
import {
  awaitingInteractions,
  interactionOptions,
  interactionPresentationIsAllowed,
  interactionPresentationNeedsEffect,
  interactionPresentationObservation,
  responseForOptionText,
  type AwaitingInteraction,
} from "./domain/interaction-presentation.js";
import { expiredInteractionCandidates } from "./domain/task-context.js";
import { projectGraphView } from "./graph/projection.js";
import {
  replacementConfirmationFor,
  startRootHypagoal,
} from "./hypagoal/root-creation.js";
import {
  continuationActionIsRunnable,
  isDispatchableGoalContinuation,
  selectGoalContinuation,
} from "./domain/goal-continuation.js";
import {
  applyCommandsAndCommit,
  commitCreatedWorkflow,
  dispatchReadyGateAndCommit,
  interruptPendingActionDispatchAndCommit,
} from "./persistence/coordinator.js";
import {
  appendOneMemberFamilyRecord,
  restoreOrMigrateOneMemberFamilySession,
} from "./persistence/family-session.js";
import { PiSessionWorkflowEventStore } from "./persistence/pi-session-store.js";
import { restoreLatestSession } from "./persistence/session-rebuild.js";
import { formatPiCheckResult, requireRunnableCommandCheck, runPiCommandCheck } from "./pi/check-tool.js";
import {
  routeLiveTaskCompletion,
} from "./pi/current-session-executor.js";
import { normalizePiGoalUsage, PI_ASSISTANT_USAGE_SOURCE } from "./pi/hypagoal-budget.js";
import { CodeDefinitionError, definitionSchema, evidenceSchema, factInputSchema, normalizeDefinition } from "./pi/definition.js";
import { GraphPaneController } from "./pi/graph-pane.js";
import {
  projectModelVisibleGraphView,
  projectModelVisibleTaskContext,
  projectModelVisibleWorkflowSummary,
} from "./pi/model-visible-state.js";
import { formatPiCheckCommand } from "./pi/check-runner.js";
import { runDeterministicCheckDispatch } from "./pi/deterministic-check-runner.js";
import { runDeterministicCodeDispatch } from "./pi/deterministic-code-runner.js";
import { runDeterministicEffectDispatch } from "./pi/deterministic-effect-runner.js";
import {
  continuationSystemPrompt,
  createPendingGoalContinuation,
  requiredContinuationTools,
  validatePendingGoalContinuation,
  type PendingGoalContinuation,
} from "./pi/hypagoal-continuation.js";
import {
  buildHypagoalAuthoringPrompt,
  hypagoalReadyWork,
  hypagoalStartSchema,
  normalizeHypagoalStartInput,
  renderHypagoalCreated,
  renderReplacementRequired,
  type HypagoalCreationRequest,
} from "./pi/hypagoal.js";
import { formatDiagnostics, renderWidget, renderWorkflow, workflowSummary } from "./ui/format.js";
import { renderHypagoalLifecycleMessage, renderHypagoalStatus } from "./ui/hypagoal-surface.js";
import {
  waitingLifecycleNote,
  waitingStatusLabel,
  waitingUnavailableNote,
} from "./ui/interaction-surface.js";
import {
  isTimelineLane,
  TIMELINE_LANES,
  projectModelVisibleHistory,
  renderEventTimeline,
  renderExplanation,
  renderReplayAtSequence,
} from "./ui/history-surface.js";
import { renderRevisionHistory } from "./history/revisions.js";

export const MAX_CONSECUTIVE_DETERMINISTIC_DISPATCHES = 64;

interface InteractionAnswer {
  responseId?: string;
  openText?: string;
  freeText?: string;
  /** Optional structured feedback body. The host stores it before answer. */
  feedbackContent?: string;
}

/** Present the rich dialog. TUI mode supports a custom overlay component. */
const presentInteractionDialog = async (
  ctx: ExtensionContext,
  interaction: InteractionDefinition,
): Promise<InteractionAnswer | undefined> => {
  const result = await ctx.ui.custom<InteractionDialogResult>(
    (tui, theme, _keybindings, done) => new InteractionDialogComponent(tui, theme, interaction, done),
    { overlay: true, overlayOptions: { width: "80%", minWidth: 48, maxHeight: "70%" } },
  );
  if (result.kind === "response") {
    const answer: InteractionAnswer = { responseId: result.responseId };
    // Closed dialog has no freeText or feedback row yet. Capture optional host
    // notes and structured feedback through plain input after the dialog.
    if (interaction.freeText) {
      const notes = await ctx.ui.input(interaction.freeText.prompt);
      if (notes !== undefined && notes.trim().length > 0) answer.freeText = notes;
    }
    if (interaction.feedback) {
      const feedback = await ctx.ui.input(
        "Optional structured feedback. Leave empty to skip. Use JSON when the interaction expects annotations.",
      );
      if (feedback !== undefined && feedback.trim().length > 0) answer.feedbackContent = feedback;
    }
    return answer;
  }
  if (result.kind === "open") return { openText: result.openText };
  return undefined;
};

/**
 * Present the question through the plain selector.
 *
 * A host such as RPC reports dialog capability but supports no custom
 * component. Each option starts with its response ID, so the runtime maps the
 * returned text back to exactly one response.
 */
const presentInteractionSelect = async (
  ctx: ExtensionContext,
  interaction: InteractionDefinition,
): Promise<InteractionAnswer | undefined> => {
  if (interaction.openAnswer) {
    const typed = (await ctx.ui.input(interaction.openAnswer.prompt))?.trim();
    return typed ? { openText: typed } : undefined;
  }
  const selected = await ctx.ui.select(interaction.question, interactionOptions(interaction));
  if (selected === undefined) return undefined;
  const response = responseForOptionText(interaction, selected);
  if (!response) return undefined;
  const answer: InteractionAnswer = { responseId: response.id };
  if (interaction.freeText) {
    const notes = await ctx.ui.input(interaction.freeText.prompt);
    if (notes !== undefined && notes.trim().length > 0) answer.freeText = notes;
  }
  if (interaction.feedback) {
    const feedback = await ctx.ui.input(
      "Optional structured feedback. Leave empty to skip. Use JSON when the interaction expects annotations.",
    );
    if (feedback !== undefined && feedback.trim().length > 0) answer.feedbackContent = feedback;
  }
  return answer;
};

/** The `/hypagraph` usage text. Help and the unknown-subcommand error share it. */
const hypagraphUsage = (): string => [
  "Usage: /hypagraph [help | ask | history | explain | loop | check | graph]",
  "  ask [<nodeId>]                             Present an open question again.",
  `  history [<sequence> | revisions | <lane>]  Read the event timeline.`,
  `                                             A lane is ${TIMELINE_LANES.join(", ")}.`,
  "  explain [<nodeId>]                         Explain why work is not runnable.",
  "  loop                                       Show bounded iteration regions.",
  "  check active | check cancel [<nodeId>]     Inspect or stop a running check.",
  "  graph [open | close | toggle | focus]      Control the graph pane.",
  "  (no argument)                              Show the workflow.",
].join("\n");

const throwDiagnostics = (diagnostics: readonly { code: string; message: string; location?: string }[]): never => {
  throw new Error(`Hypagraph rejected the operation:\n${formatDiagnostics(diagnostics)}`);
};

const patternToRegExp = (pattern: string): RegExp => {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*" && normalized[index + 1] === "*") { source += ".*"; index += 1; }
    else if (char === "*") source += "[^/]*";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}(?:/.*)?$`);
};

const scopeAllows = (cwd: string, candidatePath: string, patterns: readonly string[]): boolean => {
  const absolute = resolve(cwd, candidatePath.replace(/^@/, ""));
  const root = resolve(cwd);
  const local = relative(root, absolute).split(sep).join("/");
  if (local === ".." || local.startsWith("../")) return false;
  return patterns.some((pattern) => patternToRegExp(pattern).test(local));
};

const activeNode = (state: HypagraphState) => state.definition.nodes.find((node) => {
  const status = state.runtime.nodes[node.id]?.status;
  return status === "starting" || status === "running" || status === "awaiting_evidence" || status === "verifying";
});

const renderLoopCommand = (state: HypagraphState): string => {
  const loops = workflowSummary(state).loops as Array<{
    id: string;
    status: string;
    iteration: { current: number; limit: number };
    evaluationNodeId: string;
    feedbackEdges: Array<{ source: string; target: string; selected: boolean }>;
    failurePolicy: string;
    workflowEffect: string;
    exitReason?: string;
    warning?: { code: string; message: string };
    progress?: {
      currentMetric?: number;
      bestMetric?: number;
      bestIteration?: number;
      noProgressCount: number;
      patience?: number;
      remainingPatience?: number;
    };
  }>;
  if (loops.length === 0) return "This Hypagraph has no bounded iteration regions.";
  return loops.map((loop) => {
    const feedback = loop.feedbackEdges
      .map((edge) => `${edge.source}->${edge.target}${edge.selected ? " (selected)" : ""}`)
      .join(", ") || "none";
    const metric = loop.progress === undefined
      ? ""
      : ` | metric ${loop.progress.currentMetric ?? "none"}, best ${loop.progress.bestMetric ?? "none"}${loop.progress.bestIteration === undefined ? "" : ` at ${loop.progress.bestIteration}`}, no-progress ${loop.progress.noProgressCount}${loop.progress.patience === undefined ? "" : `, patience ${loop.progress.remainingPatience}/${loop.progress.patience}`}`;
    const warning = loop.warning ? `\n  warning ${loop.warning.code}: ${loop.warning.message}` : "";
    return `${loop.id}: ${loop.status} | iteration ${loop.iteration.current}/${loop.iteration.limit} | evaluate ${loop.evaluationNodeId} | feedback ${feedback} | policy ${loop.failurePolicy} | workflow ${loop.workflowEffect}${loop.exitReason ? ` | exit ${loop.exitReason}` : ""}${metric}${warning}`;
  }).join("\n");
};

function updateUi(
  state: HypagraphState | undefined,
  ctx: ExtensionContext,
  graphPane: GraphPaneController,
): void {
  graphPane.update(state);
  if (!state) {
    ctx.ui.setStatus("hypagraph", undefined);
    ctx.ui.setWidget("hypagraph", undefined);
    return;
  }
  const active = activeNode(state);
  const waiting = waitingStatusLabel(state);
  const readyCount = readyNodeIds(state).length;
  const work = active?.id ?? `${readyCount} ready`;
  // Keep the wait visible in the status bar. Independent ready work stays named
  // beside it, so a human gate never looks like a full goal stop.
  const status = waiting === undefined
    ? `HG ${state.phase}: ${work}`
    : `HG ${state.phase}: ${waiting}${readyCount > 0 || active ? ` | ${work}` : ""}`;
  ctx.ui.setStatus("hypagraph", status);
  ctx.ui.setWidget("hypagraph", renderWidget(state));
}

interface PendingHypagoalAuthoring {
  objective: string;
  creationRequest: HypagoalCreationRequest;
  replacementConfirmation?: ReturnType<typeof replacementConfirmationFor>;
}

export default function hypagraphExtension(pi: ExtensionAPI): void {
  let state: HypagraphState | undefined;
  let events: DomainEvent[] = [];
  let sessionGeneration = 0;
  let branchGeneration = 0;
  let hypagoalAuthoring: PendingHypagoalAuthoring | undefined;
  let pendingContinuation: PendingGoalContinuation | undefined;
  let deliveredContinuation: PendingGoalContinuation | undefined;
  let suppressContinuationAtNextAgentEnd = false;
  let staleContinuationTurn = false;
  let continuationToolsBeforeDelivery: string[] | undefined;
  let revisionProposalHandled = false;
  const graphPane = new GraphPaneController(() => events);
  const eventStore = new PiSessionWorkflowEventStore(pi);
  const activeExecutions = new ActiveCheckExecutionRegistry();
  const activeCodeExecutions = new ActiveCodeExecutionRegistry();
  const activeEffectExecutions = new ActiveEffectExecutionRegistry();
  const memoryEffectHost = new MemoryEffectHost();
  /** In-flight presentation effects keyed by workflow, node, and attempt. */
  const activePresentations = new Map<string, Promise<"ready" | "failed" | "unavailable">>();

  const presentationExecutionKey = (workflowId: string, nodeId: string, attemptId: string): string =>
    `${workflowId}\u0000${nodeId}\u0000${attemptId}`;

  const persisted = (): PersistedHypagraph => ({ events: structuredClone(events), snapshot: structuredClone(state!) });
  const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: { hypagraph: persisted() } });

  const ensureNoActiveExecution = (): void => {
    if (activeExecutions.hasActive()) throw new Error("A check is active. Cancel it or let it finish before another workflow change.");
    if (activeCodeExecutions.hasActive()) throw new Error("A code node is active. Cancel it or let it finish before another workflow change.");
    if (activeEffectExecutions.hasActive()) throw new Error("An effect node is active. Cancel it or let it finish before another workflow change.");
    if (activePresentations.size > 0) {
      throw new Error("An interaction presentation is active. Wait for it to finish before another workflow change.");
    }
  };

  const restoreContinuationTools = (): void => {
    if (!continuationToolsBeforeDelivery) return;
    pi.setActiveTools(continuationToolsBeforeDelivery);
    continuationToolsBeforeDelivery = undefined;
  };

  const restore = async (ctx: ExtensionContext, branchChanged: boolean): Promise<void> => {
    sessionGeneration += 1;
    if (branchChanged) branchGeneration += 1;
    hypagoalAuthoring = undefined;
    pendingContinuation = undefined;
    deliveredContinuation = undefined;
    suppressContinuationAtNextAgentEnd = false;
    staleContinuationTurn = false;
    revisionProposalHandled = false;
    restoreContinuationTools();
    activeExecutions.cancelAll("The Pi session branch changed.");
    activeCodeExecutions.cancelAll("The Pi session branch changed.");
    activeEffectExecutions.cancelAll("The Pi session branch changed.");
    const branch = ctx.sessionManager.getBranch();
    const session = restoreLatestSession(branch);
    eventStore.synchronize(session);
    state = session?.snapshot;
    events = session?.events ?? [];
    // Migrate a restored v0.6 root into a one-member family when no family record exists.
    // Append is additive. Prior workflow event batches are not rewritten.
    const familyProjection = restoreOrMigrateOneMemberFamilySession(branch);
    if (familyProjection?.migrated) {
      appendOneMemberFamilyRecord(pi, familyProjection.family);
    }
    if (state) {
      const recoveryStore = eventStore.lease();
      const recovery = await recoverInterruptedChecks({
        state,
        store: recoveryStore,
        at: new Date().toISOString(),
        onCommit: (next) => graphPane.update(next),
      });
      state = recovery.state;
      events.push(...recovery.events);
      // Promote requested effects to indeterminate before loop cancel recovery.
      // Effect nodes must not be cancelled; that would drop external knowledge.
      const effectRecovery = await recoverInterruptedEffects({
        state,
        store: recoveryStore,
        at: new Date().toISOString(),
        onCommit: (next) => graphPane.update(next),
      });
      state = effectRecovery.state;
      events.push(...effectRecovery.events);
      const orphaned = await recoverOrphanedLoopAttempts({
        state,
        store: recoveryStore,
        at: new Date().toISOString(),
        onCommit: (next) => graphPane.update(next),
      });
      state = orphaned.state;
      events.push(...orphaned.events);
      const recovered = [
        ...recovery.recoveredAttemptIds,
        ...effectRecovery.recoveredAttemptIds,
        ...orphaned.recoveredAttemptIds,
      ];
      if (recovered.length > 0) {
        ctx.ui.notify(`Hypagraph closed interrupted attempts: ${recovered.join(", ")}.`, "warning");
      }
      // A deterministic dispatch has no delivered model turn to close it. Close it here,
      // so a lost dispatch cannot block every later selection.
      const closed = await interruptPendingActionDispatchAndCommit(recoveryStore, state, {
        commandId: `interrupt-action-dispatch:${branchChanged ? "branch_change" : "session_reload"}:${randomUUID()}`,
        reason: branchChanged
          ? "The Pi branch changed before the action dispatch completed."
          : "The Pi session reloaded before the action dispatch completed.",
        at: new Date().toISOString(),
      });
      if (closed.ok && closed.interrupted) {
        state = closed.state;
        events.push(...closed.events);
        ctx.ui.notify(`Hypagraph closed the interrupted action dispatch '${closed.dispatchId}'.`, "warning");
      } else if (!closed.ok) {
        ctx.ui.notify(`Hypagraph could not close the interrupted action dispatch.
${formatDiagnostics(closed.diagnostics)}`, "warning");
      }
    }
    const pendingRevision = state?.goal?.pendingContinuation?.action.kind === "request-revision"
      ? state.goal.pendingContinuation
      : undefined;
    if (state?.goal && (state.goal.status === "active" || (state.goal.status === "blocked" && pendingRevision))) {
      const cause = branchChanged ? "branch_change" : "session_reload";
      const reason = branchChanged
        ? "The Pi branch changed. Resume the Hypagoal explicitly after reviewing canonical state."
        : "The Pi session reloaded. Resume the Hypagoal explicitly after reviewing canonical state.";
      const at = new Date().toISOString();
      const commands: HypagraphCommand[] = [];
      if (pendingRevision) {
        commands.push({
          type: "abandon-goal-continuation",
          goalId: state.goal.goalId,
          workflowId: state.workflowId,
          expectedRevision: state.revision,
          expectedSequence: state.sequence,
          expectedSnapshotHash: state.snapshotHash,
          continuationOperationId: pendingRevision.operationId,
          continuationOrdinal: pendingRevision.ordinal,
          requestSequence: pendingRevision.requestSequence,
          sessionGeneration: pendingRevision.sessionGeneration,
          branchGeneration: pendingRevision.branchGeneration,
          reason: branchChanged
            ? "The Pi branch changed before the automatic revision turn completed."
            : "The Pi session reloaded before the automatic revision turn completed.",
          commandId: `abandon-goal-continuation:${cause}:${randomUUID()}`,
          at,
        });
      }
      commands.push({
        type: "pause-goal",
        cause,
        reason,
        commandId: `pause-goal:${cause}:${randomUUID()}`,
        at,
      });
      const paused = await applyCommandsAndCommit(eventStore.lease(), state, commands);
      if (paused.ok) {
        state = paused.value.state;
        events.push(...paused.value.events);
        ctx.ui.notify(renderHypagoalLifecycleMessage(state), "warning");
      } else {
        ctx.ui.notify(`Hypagoal reload pause failed.
${formatDiagnostics(paused.diagnostics)}`, "warning");
      }
    }
    updateUi(state, ctx, graphPane);
  };

  const runCommands = async (commands: readonly HypagraphCommand[]): Promise<void> => {
    if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
    const result = await applyCommandsAndCommit(eventStore.lease(), state, commands);
    if (!result.ok) return throwDiagnostics(result.diagnostics);
    state = result.value.state;
    events.push(...result.value.events);
  };

  /**
   * Settle task completion through the shared executor produce+settle path.
   *
   * Uses routeLiveTaskCompletion (same produce builder as NodeExecutor sources).
   * Returns null when no family/goal path applies so the caller can use the
   * legacy direct command path. Invalid structured results do not commit state.
   */
  const settleLiveTaskCompletion = (input: {
    ctx: ExtensionContext;
    state: HypagraphState;
    nodeId: string;
    attemptId: string;
    outcome: "submitted" | "cancelled" | "failed";
    facts?: FactInput[];
    evidence?: EvidenceReference[];
    reason?: string;
    at: string;
    correlationId: string;
  }): HypagraphCommand[] | null => {
    let family: GoalFamilyRuntime | undefined;
    if (input.state.goal) {
      const familyProjection = restoreOrMigrateOneMemberFamilySession(input.ctx.sessionManager.getBranch());
      if (familyProjection) {
        if (familyProjection.migrated) {
          appendOneMemberFamilyRecord(pi, familyProjection.family);
        }
        family = familyProjection.family.familySnapshot;
      }
    }

    const routing = routeLiveTaskCompletion({
      family,
      state: input.state,
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      outcome: input.outcome,
      ...(input.facts !== undefined ? { facts: input.facts } : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      meta: {
        at: input.at,
        correlationId: input.correlationId,
        commandIdForStep: () => randomUUID(),
      },
    });

    if (routing.kind === "legacy") return null;
    if (routing.kind === "rejected") return throwDiagnostics(routing.diagnostics);
    return routing.settlement.commands;
  };

  /**
   * Report whether a stored presentation artifact still resolves on disk.
   *
   * Plan 3.6 skips a repeated external effect only when the artifact still
   * exists. Kind `none` has no artifact. Failed observations stay terminal.
   * The domain reducer stays pure; this host check alone reads the store.
   */
  const presentationArtifactStillExists = async (
    ctx: ExtensionContext,
    artifactRef: string | undefined,
  ): Promise<boolean> => {
    if (!artifactRef?.trim()) return true;
    const store = new FileCheckArtifactStore(resolve(ctx.cwd, ".hypagraph", "check-artifacts"));
    // Bound the existence probe. Content is not used after the probe.
    const maxBytes = 1_048_576;
    try {
      const artifact = await store.read(artifactRef, maxBytes);
      return artifact !== undefined;
    } catch {
      // Oversized or unreadable refs are treated as missing so the host can
      // regenerate the presentation file without a second durable observation.
      return false;
    }
  };

  /**
   * Run the presentation effect after the request event is stored.
   *
   * Durable order:
   * 1. request-interaction is already committed;
   * 2. run the presentation effect outside the reducer;
   * 3. store present-interaction with the observation;
   * 4. open the dialog only after a successful observation.
   *
   * A successful observation must not re-run the external effect on reload when
   * the presentation artifact still exists. If the observation exists but the
   * artifact is gone, the host re-runs the effect to regenerate the file and
   * does not store a second present-interaction event. If regenerate fails, the
   * durable successful observation still allows the dialog to open.
   * Concurrent callers for the same attempt share one in-flight promise so the
   * external effect runs at most one time per concurrent window.
   */
  const ensureInteractionPresentation = async (
    _ctx: ExtensionContext,
    awaiting: AwaitingInteraction,
  ): Promise<"ready" | "failed" | "unavailable"> => {
    if (!state) return "unavailable";

    // Fast path: successful observation and a resolvable artifact (or no artifact).
    if (!interactionPresentationNeedsEffect(state, awaiting.nodeId, awaiting.attemptId)) {
      const observation = interactionPresentationObservation(state, awaiting.nodeId, awaiting.attemptId);
      if (observation?.status !== "succeeded") return "failed";
      if (await presentationArtifactStillExists(_ctx, observation.artifactRef)) return "ready";
      // Fall through to the coalesced runner so a missing artifact regenerates once.
    }

    const key = presentationExecutionKey(state.workflowId, awaiting.nodeId, awaiting.attemptId);
    const inFlight = activePresentations.get(key);
    if (inFlight) return inFlight;

    const run = (async (): Promise<"ready" | "failed" | "unavailable"> => {
      if (!state) return "unavailable";

      // Re-check after scheduling. Another caller may have finished first.
      if (!interactionPresentationNeedsEffect(state, awaiting.nodeId, awaiting.attemptId)) {
        const observation = interactionPresentationObservation(state, awaiting.nodeId, awaiting.attemptId);
        if (observation?.status !== "succeeded") return "failed";
        if (await presentationArtifactStillExists(_ctx, observation.artifactRef)) return "ready";
        // Observation is durable. Regenerate the artifact file only.
      }

      const alreadyObserved = !interactionPresentationNeedsEffect(state, awaiting.nodeId, awaiting.attemptId);
      const presentation = awaiting.interaction.presentation;
      const executor = new DefaultPresentationExecutor({
        rootDirectory: _ctx.cwd,
        artifactStore: new FileCheckArtifactStore(resolve(_ctx.cwd, ".hypagraph", "check-artifacts")),
      });
      const controller = new AbortController();
      let result;
      try {
        result = await executor.execute({
          state,
          nodeId: awaiting.nodeId,
          attemptId: awaiting.attemptId,
          presentation,
          requestedAt: new Date().toISOString(),
        }, controller.signal);
      } catch (error) {
        result = {
          status: "error" as const,
          kind: presentation.kind,
          presentedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
      }

      // A concurrent commit may already hold the observation, or this run is a
      // regenerate after a missing artifact. Do not store a second observation.
      // A durable successful observation keeps the answer path open even when
      // regenerate fails. Only a durable failed observation is terminal.
      if (alreadyObserved || !interactionPresentationNeedsEffect(state, awaiting.nodeId, awaiting.attemptId)) {
        const observation = interactionPresentationObservation(state, awaiting.nodeId, awaiting.attemptId);
        if (observation?.status === "succeeded") {
          if (result.status !== "succeeded") {
            const detail = "error" in result && result.error
              ? result.error
              : result.status;
            _ctx.ui.notify(
              `Interaction '${awaiting.nodeId}' presentation artifact could not be regenerated (${detail}). `
              + "The stored presentation observation remains successful. The question is still open.",
              "warning",
            );
          }
          return "ready";
        }
        return "failed";
      }

      try {
        await runCommands([{
          type: "present-interaction",
          nodeId: awaiting.nodeId,
          attemptId: awaiting.attemptId,
          result,
          commandId: randomUUID(),
          at: new Date().toISOString(),
        }]);
      } catch (error) {
        // Race: another host stored the observation first. Prefer the stored state.
        if (!state) return "unavailable";
        const observation = interactionPresentationObservation(state, awaiting.nodeId, awaiting.attemptId);
        if (observation?.status === "succeeded") return "ready";
        if (observation) return "failed";
        throw error;
      }

      if (result.status !== "succeeded") return "failed";
      return "ready";
    })();

    activePresentations.set(key, run);
    try {
      return await run;
    } finally {
      if (activePresentations.get(key) === run) activePresentations.delete(key);
    }
  };

  /**
   * Present one waiting interaction and store the selected answer.
   *
   * The caller must commit the request event first. Rule 1.1.2 requires a
   * durable `awaiting_response` node before a dialog opens, so a reload during
   * the dialog keeps the question.
   *
   * Slice 2 also requires a presentation observation before the dialog.
   */
  /**
   * Store interaction note or feedback bytes by identity.
   * The reducer never reads the artifact store. It only records the measured ref.
   */
  const storeInteractionArtifact = async (
    ctx: ExtensionContext,
    awaiting: AwaitingInteraction,
    name: "feedback" | "free-text",
    content: string,
    maxBytes: number,
    mediaType: string,
  ): Promise<{ ref: string; mediaType: string; byteLength: number }> => {
    if (!state) throw new Error("There is no active Hypagraph.");
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > maxBytes) {
      throw new Error(
        name === "feedback"
          ? `The feedback artifact exceeds the maximum of ${maxBytes} bytes.`
          : `The free-text notes exceed the maximum of ${maxBytes} bytes.`,
      );
    }
    const store = new FileCheckArtifactStore(resolve(ctx.cwd, ".hypagraph", "check-artifacts"));
    const ref = await store.write({
      workflowId: state.workflowId,
      nodeId: awaiting.nodeId,
      attemptId: awaiting.attemptId,
      name,
      mediaType,
      content: bytes,
    });
    return { ref, mediaType, byteLength: bytes.byteLength };
  };

  const presentAwaitingInteraction = async (
    ctx: ExtensionContext,
    awaiting: AwaitingInteraction,
  ): Promise<"answered" | "dismissed" | "unavailable" | "presentation-failed"> => {
    const presentationOutcome = await ensureInteractionPresentation(ctx, awaiting);
    if (presentationOutcome === "failed") return "presentation-failed";
    if (presentationOutcome === "unavailable") return "unavailable";
    if (!ctx.hasUI) return "unavailable";
    const { interaction } = awaiting;
    const answer = ctx.mode === "tui"
      ? await presentInteractionDialog(ctx, interaction)
      : await presentInteractionSelect(ctx, interaction);
    if (answer === undefined) return "dismissed";

    // Pre-check byte bounds before any store write so a failed answer does not
    // leave an orphan artifact from a later oversized field.
    if (answer.freeText !== undefined && interaction.freeText) {
      const freeBytes = Buffer.byteLength(answer.freeText, "utf8");
      if (freeBytes > interaction.freeText.maxBytes) {
        throw new Error(
          `The free-text notes exceed the maximum of ${interaction.freeText.maxBytes} bytes.`,
        );
      }
    }
    if (answer.feedbackContent !== undefined && interaction.feedback) {
      const feedbackBytes = Buffer.byteLength(answer.feedbackContent, "utf8");
      if (feedbackBytes > interaction.feedback.maxBytes) {
        throw new Error(
          `The feedback artifact exceeds the maximum of ${interaction.feedback.maxBytes} bytes.`,
        );
      }
    }

    let freeTextArtifact: { ref: string; mediaType: string; byteLength: number } | undefined;
    if (
      answer.freeText !== undefined
      && answer.freeText.trim().length > 0
      && interaction.freeText
    ) {
      freeTextArtifact = await storeInteractionArtifact(
        ctx,
        awaiting,
        "free-text",
        answer.freeText,
        interaction.freeText.maxBytes,
        "text/plain; charset=utf-8",
      );
    }

    let feedbackArtifact: { ref: string; mediaType: string; byteLength: number } | undefined;
    if (
      answer.feedbackContent !== undefined
      && answer.feedbackContent.trim().length > 0
      && interaction.feedback
    ) {
      feedbackArtifact = await storeInteractionArtifact(
        ctx,
        awaiting,
        "feedback",
        answer.feedbackContent,
        interaction.feedback.maxBytes,
        interaction.feedback.mediaType ?? "application/json; charset=utf-8",
      );
    }

    await runCommands([{
      type: "answer-interaction",
      nodeId: awaiting.nodeId,
      attemptId: awaiting.attemptId,
      ...(answer.responseId ? { responseId: answer.responseId } : {}),
      ...(answer.openText ? { openText: answer.openText } : {}),
      ...(answer.freeText !== undefined ? { freeText: answer.freeText } : {}),
      ...(freeTextArtifact === undefined ? {} : { freeTextArtifact }),
      ...(feedbackArtifact === undefined ? {} : { feedbackArtifact }),
      commandId: randomUUID(),
      at: new Date().toISOString(),
    }]);
    return "answered";
  };

  const abandonPendingContinuation = async (reason: string): Promise<void> => {
    const canonical = state?.goal?.pendingContinuation;
    if (!state?.goal || !canonical) return;
    const result = await applyCommandsAndCommit(eventStore.lease(), state, [{
      type: "abandon-goal-continuation",
      goalId: state.goal.goalId,
      workflowId: state.workflowId,
      expectedRevision: state.revision,
      expectedSequence: state.sequence,
      expectedSnapshotHash: state.snapshotHash,
      continuationOperationId: canonical.operationId,
      continuationOrdinal: canonical.ordinal,
      requestSequence: canonical.requestSequence,
      sessionGeneration: canonical.sessionGeneration,
      branchGeneration: canonical.branchGeneration,
      reason,
      commandId: `abandon-goal-continuation:${randomUUID()}`,
      at: new Date().toISOString(),
    }]);
    if (result.ok) {
      state = result.value.state;
      events.push(...result.value.events);
      return;
    }
    // Keep the durable request visible. A later recovery path must clear it.
  };

  /**
   * Close a durable model-lane continuation whose selected action is no longer runnable.
   *
   * Live Pi can complete the selected task while the model-lane turn is never closed.
   * The durable request then remains and blocks every later selection, including
   * deterministic checks and gates. Recover only when the selected action is no longer
   * runnable, so an undelivered but still-valid queue is not closed early.
   */
  const recoverOrphanedModelContinuation = async (
    ctx: ExtensionContext,
    reason: string,
  ): Promise<boolean> => {
    const canonical = state?.goal?.pendingContinuation;
    if (!state?.goal || !canonical) return false;
    if (deliveredContinuation) return false;
    if (continuationActionIsRunnable(state, canonical.action)) return false;
    // Drop undelivered in-memory bookkeeping. The durable request is closed next.
    pendingContinuation = undefined;
    await abandonPendingContinuation(reason);
    if (state.goal?.pendingContinuation) {
      ctx.ui.notify(
        `Hypagoal could not close the orphaned model-lane continuation '${canonical.operationId}'.`,
        "warning",
      );
      return false;
    }
    ctx.ui.notify(
      `Hypagoal closed an orphaned model-lane continuation and will select the next action.`,
      "warning",
    );
    return true;
  };

  const dispatchDeterministicCheck = async (
    ctx: ExtensionContext,
    decision: ReadyCheckDecision,
  ): Promise<boolean> => {
    const runGeneration = sessionGeneration;
    const runBranch = branchGeneration;
    ctx.ui.setStatus("hypagraph-check", `Check ${decision.nodeId}: running`);
    try {
      const dispatch = await runDeterministicCheckDispatch({
        state: state!,
        decision,
        dispatchId: `hypagoal-dispatch:${randomUUID()}`,
        attemptId: randomUUID(),
        at: new Date().toISOString(),
        store: eventStore.lease(),
        executor: new CommandCheckExecutor({
          rootDirectory: ctx.cwd,
          artifactStore: new FileCheckArtifactStore(resolve(ctx.cwd, ".hypagraph", "check-artifacts")),
        }),
        registry: activeExecutions,
        stale: () => sessionGeneration !== runGeneration || branchGeneration !== runBranch,
        onCommit: (next, committed) => {
          if (sessionGeneration !== runGeneration || branchGeneration !== runBranch) return;
          state = next;
          events.push(...committed);
          updateUi(state, ctx, graphPane);
        },
      });
      if (!dispatch.ok) {
        ctx.ui.notify(dispatch.dispatched
          ? `Hypagoal ran deterministic check '${decision.nodeId}', but it could not store the dispatch outcome '${dispatch.outcome}'.
The check lifecycle is durable. Restore closes the interrupted dispatch.
${formatDiagnostics(dispatch.diagnostics)}`
          : `Hypagoal deterministic check '${decision.nodeId}' was not dispatched.
${formatDiagnostics(dispatch.diagnostics)}`, "warning");
        return false;
      }
      if (dispatch.stale) return false;
      if (dispatch.outcome !== "completed") {
        ctx.ui.notify(`Hypagoal deterministic check '${decision.nodeId}' ${dispatch.outcome}.
${dispatch.reason ?? "The check dispatch did not complete."}`, "warning");
        return false;
      }
      return true;
    } finally {
      ctx.ui.setStatus("hypagraph-check", undefined);
    }
  };

  const dispatchDeterministicCode = async (
    ctx: ExtensionContext,
    decision: ReadyCodeDecision,
  ): Promise<boolean> => {
    const runGeneration = sessionGeneration;
    const runBranch = branchGeneration;
    ctx.ui.setStatus("hypagraph-code", `Code ${decision.nodeId}: running`);
    try {
      const dispatch = await runDeterministicCodeDispatch({
        state: state!,
        decision,
        dispatchId: `hypagoal-dispatch:${randomUUID()}`,
        attemptId: randomUUID(),
        at: new Date().toISOString(),
        store: eventStore.lease(),
        executor: new QuickJSSandboxExecutor(),
        registry: activeCodeExecutions,
        rootDirectory: ctx.cwd,
        stale: () => sessionGeneration !== runGeneration || branchGeneration !== runBranch,
        onCommit: (next, committed) => {
          if (sessionGeneration !== runGeneration || branchGeneration !== runBranch) return;
          state = next;
          events.push(...committed);
          updateUi(state, ctx, graphPane);
        },
      });
      if (!dispatch.ok) {
        ctx.ui.notify(dispatch.dispatched
          ? `Hypagoal ran deterministic code '${decision.nodeId}', but it could not store the dispatch outcome '${dispatch.outcome}'.
The code lifecycle is durable. Restore closes the interrupted dispatch.
${formatDiagnostics(dispatch.diagnostics)}`
          : `Hypagoal deterministic code '${decision.nodeId}' was not dispatched.
${formatDiagnostics(dispatch.diagnostics)}`, "warning");
        return false;
      }
      if (dispatch.stale) return false;
      if (dispatch.outcome !== "completed") {
        ctx.ui.notify(`Hypagoal deterministic code '${decision.nodeId}' ${dispatch.outcome}.
${dispatch.reason ?? "The code dispatch did not complete."}`, "warning");
        return false;
      }
      return true;
    } finally {
      ctx.ui.setStatus("hypagraph-code", undefined);
    }
  };

  const dispatchDeterministicEffect = async (
    ctx: ExtensionContext,
    decision: DeterministicEffectDecision,
  ): Promise<boolean> => {
    const runGeneration = sessionGeneration;
    const runBranch = branchGeneration;
    const label = decision.kind === "reconcile-indeterminate-effect" ? "Reconcile" : "Effect";
    ctx.ui.setStatus("hypagraph-effect", `${label} ${decision.nodeId}: running`);
    try {
      // Run the authored sandbox program. Host handlers use an in-memory effect host
      // as the simulated external system until a real adapter is registered.
      const host = memoryEffectHost;
      const effectHandlers = {
        "mcp.effect.apply": (args: unknown) => {
          const key = typeof (args as { idempotencyKey?: unknown })?.idempotencyKey === "string"
            ? (args as { idempotencyKey: string }).idempotencyKey
            : "";
          const applied = host.apply({ idempotencyKey: key, payload: args });
          if (applied.status === "lost") {
            throw new Error("LOST_RESULT: The host lost the effect result after the external call.");
          }
          return applied;
        },
        "mcp.effect.query": (args: unknown) => {
          const key = typeof (args as { idempotencyKey?: unknown })?.idempotencyKey === "string"
            ? (args as { idempotencyKey: string }).idempotencyKey
            : "";
          return host.query({ idempotencyKey: key });
        },
      };
      const executor = new SandboxEffectExecutor({
        codeExecutor: new QuickJSSandboxExecutor({
          handlers: effectHandlers,
          capabilityPermit: (capability) => capabilityIsPermittedForRole(capability, "effect"),
        }),
        createCodeExecutor: (role) => new QuickJSSandboxExecutor({
          handlers: effectHandlers,
          capabilityPermit: (capability) => capabilityIsPermittedForRole(capability, role),
        }),
      });
      const dispatch = await runDeterministicEffectDispatch({
        state: state!,
        decision,
        dispatchId: `hypagoal-dispatch:${randomUUID()}`,
        attemptId: randomUUID(),
        at: new Date().toISOString(),
        store: eventStore.lease(),
        executor,
        registry: activeEffectExecutions,
        stale: () => sessionGeneration !== runGeneration || branchGeneration !== runBranch,
        onCommit: (next, committed) => {
          if (sessionGeneration !== runGeneration || branchGeneration !== runBranch) return;
          state = next;
          events.push(...committed);
          updateUi(state, ctx, graphPane);
        },
      });
      if (!dispatch.ok) {
        ctx.ui.notify(dispatch.dispatched
          ? `Hypagoal ran deterministic effect '${decision.nodeId}', but it could not store the dispatch outcome '${dispatch.outcome}'.
The effect lifecycle is durable. Restore reconciles indeterminate effects.
${formatDiagnostics(dispatch.diagnostics)}`
          : `Hypagoal deterministic effect '${decision.nodeId}' was not dispatched.
${formatDiagnostics(dispatch.diagnostics)}`, "warning");
        return false;
      }
      if (dispatch.stale) return false;
      if (dispatch.outcome === "failed") {
        ctx.ui.notify(`Hypagoal deterministic effect '${decision.nodeId}' failed.
${dispatch.reason ?? "The effect dispatch did not complete."}`, "warning");
        return false;
      }
      return true;
    } finally {
      ctx.ui.setStatus("hypagraph-effect", undefined);
    }
  };

  /**
   * Evaluate outstanding interaction deadlines with the supplied evaluation time.
   *
   * The domain reducer stays clock-free. This host path alone supplies now.
   * Concurrent callers coalesce onto the latest evaluation time. After an
   * in-flight run finishes, a waiter re-enters so a later evaluationAt is not
   * dropped. One failed expire does not stop the remaining candidates.
   *
   * When an interaction presentation is in flight, queueGoalContinuation defers
   * this evaluation until the next controller entry after the presentation ends.
   */
  let activeDeadlineEvaluation: Promise<void> | undefined;
  let latestDeadlineEvaluationAt: string | undefined;
  const evaluateInteractionDeadlines = async (
    ctx: ExtensionContext,
    evaluationAt = new Date().toISOString(),
  ): Promise<void> => {
    if (!state) return;
    const evaluationMs = Date.parse(evaluationAt);
    if (!Number.isFinite(evaluationMs)) return;
    if (
      latestDeadlineEvaluationAt === undefined
      || evaluationMs > Date.parse(latestDeadlineEvaluationAt)
    ) {
      latestDeadlineEvaluationAt = evaluationAt;
    }
    if (activeDeadlineEvaluation) {
      await activeDeadlineEvaluation;
      // Re-enter with the latest requested time so a later waiter is not dropped.
      if (!state || latestDeadlineEvaluationAt === undefined) return;
      return evaluateInteractionDeadlines(ctx, latestDeadlineEvaluationAt);
    }
    const at = latestDeadlineEvaluationAt;
    if (!at) return;
    const run = (async () => {
      const failed = new Set<string>();
      while (state) {
        const candidates = expiredInteractionCandidates(state, at)
          .filter((item) => !failed.has(`${item.nodeId}\u0000${item.attemptId}`));
        if (candidates.length === 0) return;
        const candidate = candidates[0]!;
        const key = `${candidate.nodeId}\u0000${candidate.attemptId}`;
        try {
          await runCommands([{
            type: "expire-interaction",
            nodeId: candidate.nodeId,
            attemptId: candidate.attemptId,
            commandId: randomUUID(),
            at,
          }]);
        } catch (error) {
          // A concurrent answer can win the race and make the node no longer
          // awaiting. Skip this candidate and continue the remaining list.
          failed.add(key);
          const detail = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(
            `Hypagraph could not expire interaction '${candidate.nodeId}': ${detail}`,
            "warning",
          );
        }
      }
    })();
    activeDeadlineEvaluation = run;
    try {
      await run;
    } finally {
      if (activeDeadlineEvaluation === run) activeDeadlineEvaluation = undefined;
    }
  };

  const queueGoalContinuation = async (ctx: ExtensionContext): Promise<void> => {
    // An open presentation defers deadline evaluation to the next controller
    // entry after the presentation ends. Level-triggered recovery still applies.
    if (pendingContinuation || deliveredContinuation || !state || activeExecutions.hasActive() || activePresentations.size > 0) return;
    let deterministicDispatches = 0;

    // Level-triggered deadlines: evaluate before selecting the next action.
    await evaluateInteractionDeadlines(ctx, new Date().toISOString());
    if (!state) return;

    while (true) {
      const decision = selectGoalContinuation(state);
      if (!isDispatchableGoalContinuation(decision)) {
        // The waiting stop happens only when no other action is runnable, so a
        // dialog here cannot stop an independent branch. Rule 1.1.1 holds.
        if (decision.kind === "stop-waiting-response") {
          const awaiting = awaitingInteractions(state)[0];
          if (awaiting) {
            const outcome = await presentAwaitingInteraction(ctx, awaiting);
            if (outcome === "answered") {
              updateUi(state, ctx, graphPane);
              continue;
            }
            updateUi(state, ctx, graphPane);
            // Keep the wait durable on dismiss or missing dialog. A failed
            // presentation leaves an explicit failed node instead of a wait.
            if (outcome === "presentation-failed") {
              const observation = interactionPresentationObservation(state, awaiting.nodeId, awaiting.attemptId);
              const detail = observation?.error
                ? `${observation.status}: ${observation.error}`
                : (observation?.status ?? "failed");
              ctx.ui.notify(
                `Interaction '${awaiting.nodeId}' presentation ${detail}. The node is failed and does not wait for an answer.`,
                "warning",
              );
              return;
            }
            if (outcome === "unavailable") {
              ctx.ui.notify(
                waitingUnavailableNote(state)
                  ?? `This host has no dialog capability. Interaction '${awaiting.nodeId}' still waits for an answer.`,
                "warning",
              );
            } else {
              ctx.ui.notify(
                waitingLifecycleNote(state)
                  ?? `Waiting for a user response on node '${awaiting.nodeId}'. Use /hypagraph ask to present the dialog again.`,
                "info",
              );
            }
            return;
          }
        }
        if (decision.kind === "invariant-error") {
          if (state.goal?.status === "active") ctx.ui.notify(`Hypagoal cannot continue: ${decision.reason}`, "warning");
        } else {
          ctx.ui.notify(renderHypagoalLifecycleMessage(state), decision.kind === "stop-completed" ? "info" : "warning");
        }
        return;
      }

      const deterministic = isReadyGateDecision(decision)
        || isReadyCheckDecision(decision)
        || isReadyCodeDecision(decision)
        || isDeterministicEffectDecision(decision);
      if (deterministic && deterministicDispatches >= MAX_CONSECUTIVE_DETERMINISTIC_DISPATCHES) {
        ctx.ui.notify(
          `Hypagoal stopped automatic deterministic dispatch after ${MAX_CONSECUTIVE_DETERMINISTIC_DISPATCHES} consecutive actions in one controller pass. Review the graph before continuing.`,
          "warning",
        );
        return;
      }

      if (isReadyCheckDecision(decision)) {
        const continued = await dispatchDeterministicCheck(ctx, decision);
        deterministicDispatches += 1;
        if (!continued) return;
        continue;
      }

      if (isReadyCodeDecision(decision)) {
        const continued = await dispatchDeterministicCode(ctx, decision);
        deterministicDispatches += 1;
        if (!continued) return;
        continue;
      }

      if (isDeterministicEffectDecision(decision)) {
        const continued = await dispatchDeterministicEffect(ctx, decision);
        deterministicDispatches += 1;
        if (!continued) return;
        continue;
      }

      if (isReadyGateDecision(decision)) {
        const dispatchId = `hypagoal-dispatch:${randomUUID()}`;
        const dispatched = await dispatchReadyGateAndCommit(eventStore.lease(), state, {
          dispatchId,
          decision,
          at: new Date().toISOString(),
        });
        if (!dispatched.ok) {
          ctx.ui.notify(`Hypagoal deterministic gate was not dispatched.
${formatDiagnostics(dispatched.diagnostics)}`, "warning");
          return;
        }
        state = dispatched.state;
        events.push(...dispatched.events);
        deterministicDispatches += 1;
        updateUi(state, ctx, graphPane);
        if (dispatched.outcome === "failed") {
          ctx.ui.notify(`Hypagoal deterministic gate '${decision.nodeId}' failed.
${formatDiagnostics(dispatched.diagnostics)}`, "warning");
          return;
        }
        continue;
      }

      const operationId = `hypagoal-continuation:${randomUUID()}`;
      const request = await applyCommandsAndCommit(eventStore.lease(), state, [{
        type: "request-goal-continuation",
        goalId: decision.goalId,
        workflowId: decision.workflowId,
        expectedRevision: decision.revision,
        expectedSequence: decision.sequence,
        expectedSnapshotHash: decision.snapshotHash,
        expectedContinuationOrdinal: decision.continuationOrdinal,
        sessionGeneration,
        branchGeneration,
        action: decision.kind === "request-revision"
          ? { kind: "request-revision", blocker: structuredClone(decision.blocker) }
          : { kind: decision.kind, nodeId: decision.nodeId, ...(decision.loopId ? { loopId: decision.loopId } : {}) },
        commandId: operationId,
        correlationId: operationId,
        at: new Date().toISOString(),
      }]);
      if (!request.ok) {
        ctx.ui.notify(`Hypagoal continuation was not queued.
${formatDiagnostics(request.diagnostics)}`, "warning");
        return;
      }
      state = request.value.state;
      events.push(...request.value.events);
      updateUi(state, ctx, graphPane);
      if (state.goal?.status === "budget_limited") {
        ctx.ui.notify(renderHypagoalLifecycleMessage(state), "warning");
        return;
      }
      pendingContinuation = createPendingGoalContinuation(decision, state, { sessionGeneration, branchGeneration }, operationId);
      pi.sendUserMessage(pendingContinuation.prompt, { deliverAs: "followUp" });
      return;
    }
  };

  const nodeIdRequired = (nodeId: string | undefined): string => {
    if (!nodeId) throw new Error("This action requires a node ID.");
    return nodeId;
  };

  const cancelActiveChecks = (nodeId: string | undefined, reason: string): string[] => {
    if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
    return activeExecutions.cancel({
      workflowId: state.workflowId,
      ...(nodeId ? { nodeId } : {}),
      reason,
    }).map((entry) => entry.nodeId);
  };

  pi.on("session_start", async (_event, ctx) => restore(ctx, false));
  pi.on("session_tree", async (_event, ctx) => restore(ctx, true));
  pi.on("session_shutdown", async () => {
    pendingContinuation = undefined;
    deliveredContinuation = undefined;
    staleContinuationTurn = false;
    revisionProposalHandled = false;
    restoreContinuationTools();
    activeExecutions.cancelAll();
    activeCodeExecutions.cancelAll("session_shutdown");
    activeEffectExecutions.cancelAll("session_shutdown");
    graphPane.dispose();
  });

  pi.on("input", (event) => {
    if (event.source !== "extension" && event.streamingBehavior !== undefined) {
      suppressContinuationAtNextAgentEnd = true;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    hypagoalAuthoring = undefined;
    staleContinuationTurn = false;
    revisionProposalHandled = false;
    restoreContinuationTools();
    if (suppressContinuationAtNextAgentEnd) {
      suppressContinuationAtNextAgentEnd = false;
      const interruptedRevision = deliveredContinuation?.action.kind === "request-revision"
        ? deliveredContinuation
        : undefined;
      if (!interruptedRevision) {
        await abandonPendingContinuation("Interactive input interrupted the automatic continuation.");
        pendingContinuation = undefined;
        deliveredContinuation = undefined;
        updateUi(state, ctx, graphPane);
        return;
      }
      const goal = state?.goal;
      const revisionRequest = goal?.pendingContinuation;
      if (state && goal && revisionRequest?.action.kind === "request-revision" && goal.automaticRevision.lastAttempt?.outcome === "pending") {
        const interrupted = await applyCommandsAndCommit(eventStore.lease(), state, [{
          type: "abandon-goal-revision",
          goalId: goal.goalId,
          workflowId: state.workflowId,
          expectedRevision: state.revision,
          expectedSequence: state.sequence,
          expectedSnapshotHash: state.snapshotHash,
          revisionOperationId: interruptedRevision.operationId,
          continuationOperationId: revisionRequest.operationId,
          continuationOrdinal: revisionRequest.ordinal,
          requestSequence: revisionRequest.requestSequence,
          sessionGeneration: revisionRequest.sessionGeneration,
          branchGeneration: revisionRequest.branchGeneration,
          outcomeCode: "revision_turn_interrupted",
          reason: "Interactive input interrupted the delivered automatic revision turn.",
          commandId: `abandon-goal-revision:interrupted:${randomUUID()}`,
          correlationId: interruptedRevision.operationId,
          at: new Date().toISOString(),
        }]);
        if (interrupted.ok) {
          state = interrupted.value.state;
          events.push(...interrupted.value.events);
          ctx.ui.notify(renderHypagoalLifecycleMessage(state), "warning");
        }
      }
      updateUi(state, ctx, graphPane);
    }
    if (deliveredContinuation) {
      const delivered = deliveredContinuation;
      deliveredContinuation = undefined;
      const goal = state?.goal;
      const revisionRequest = goal?.pendingContinuation;
      if (!state || !goal || !revisionRequest) return;
      if (delivered.action.kind === "request-revision" && !revisionProposalHandled && goal.automaticRevision.lastAttempt?.outcome === "pending") {
        const abandoned = await applyCommandsAndCommit(eventStore.lease(), state, [{
          type: "abandon-goal-revision",
          goalId: goal.goalId,
          workflowId: state.workflowId,
          expectedRevision: state.revision,
          expectedSequence: state.sequence,
          expectedSnapshotHash: state.snapshotHash,
          revisionOperationId: delivered.operationId,
          continuationOperationId: revisionRequest.operationId,
          continuationOrdinal: revisionRequest.ordinal,
          requestSequence: revisionRequest.requestSequence,
          sessionGeneration: revisionRequest.sessionGeneration,
          branchGeneration: revisionRequest.branchGeneration,
          outcomeCode: "revision_turn_no_proposal",
          reason: "The automatic revision turn ended without one valid replacement definition.",
          commandId: `abandon-goal-revision:${randomUUID()}`,
          correlationId: delivered.operationId,
          at: new Date().toISOString(),
        }]);
        if (abandoned.ok) {
          state = abandoned.value.state;
          events.push(...abandoned.value.events);
        }
      }
      const semanticSequenceBeforeAccounting = state.sequence;
      const normalized = normalizePiGoalUsage(_event.messages);
      if (!normalized.ok) {
        await runCommands([{
          type: "pause-goal",
          cause: "usage_invalid",
          reason: `${normalized.code}: ${normalized.message}`,
          commandId: `pause-goal:usage-invalid:${randomUUID()}`,
          at: new Date().toISOString(),
        }]);
        updateUi(state, ctx, graphPane);
        ctx.ui.notify(`Hypagoal paused because usage could not be accounted. ${normalized.message}`, "warning");
        ctx.ui.notify(renderHypagoalLifecycleMessage(state!), "warning");
        return;
      }
      const canonical = revisionRequest;
      const recorded = await applyCommandsAndCommit(eventStore.lease(), state, [{
        type: "record-goal-turn-usage",
        goalId: goal.goalId,
        workflowId: state.workflowId,
        expectedRevision: state.revision,
        expectedSequence: state.sequence,
        expectedSnapshotHash: state.snapshotHash,
        continuationOperationId: canonical.operationId,
        continuationOrdinal: canonical.ordinal,
        requestSequence: canonical.requestSequence,
        selectedSequence: canonical.selectedSequence,
        selectedSnapshotHash: canonical.selectedSnapshotHash,
        sessionGeneration: canonical.sessionGeneration,
        branchGeneration: canonical.branchGeneration,
        turnId: delivered.turnId,
        source: PI_ASSISTANT_USAGE_SOURCE,
        usage: normalized.usage,
        commandId: `record-goal-turn:${delivered.turnId}`,
        correlationId: delivered.operationId,
        at: new Date().toISOString(),
      }]);
      if (!recorded.ok) {
        ctx.ui.notify(`Hypagoal usage was not recorded.
${formatDiagnostics(recorded.diagnostics)}`, "warning");
        return;
      }
      state = recorded.value.state;
      events.push(...recorded.value.events);
      updateUi(state, ctx, graphPane);
      if (state.goal?.status === "budget_limited") {
        ctx.ui.notify(renderHypagoalLifecycleMessage(state), "warning");
        return;
      }
      if (semanticSequenceBeforeAccounting === delivered.committedSequence) {
        ctx.ui.notify(`Hypagoal continuation '${delivered.operationId}' made no canonical progress. Automatic continuation stopped.`, "warning");
        return;
      }
    } else {
      // A durable request without delivery bookkeeping blocks later selection.
      await recoverOrphanedModelContinuation(
        ctx,
        "The model-lane continuation had no delivered turn bookkeeping. The controller closed it and selected the next action.",
      );
    }
    await queueGoalContinuation(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (hypagoalAuthoring !== undefined) {
      return {
        systemPrompt: `${event.systemPrompt}\n\nHYPAGOAL AUTHORING CONTROL:\nInspect repository context and author one complete canonical workflow. The user supplied an objective, not a graph. Do not modify repository files, run workflow nodes, start checks, invoke executors, or continue implementation. Call hypagoal_start once as the final action.`,
      };
    }

    if (pendingContinuation) {
      const pending = pendingContinuation;
      const validation = validatePendingGoalContinuation(
        pending,
        state,
        { sessionGeneration, branchGeneration },
      );
      pendingContinuation = undefined;
      if (event.prompt !== pending.prompt) {
        await abandonPendingContinuation("A user or tool message took priority over the queued continuation.");
        suppressContinuationAtNextAgentEnd = true;
      } else if (!validation.ok || !state) {
        await abandonPendingContinuation(validation.message ?? "The queued continuation became stale.");
        suppressContinuationAtNextAgentEnd = true;
        staleContinuationTurn = true;
        ctx.ui.notify(`Hypagoal continuation stopped: ${validation.code ?? "stale_continuation"} — ${validation.message ?? "The continuation is stale."}`, "warning");
        return {
          systemPrompt: `${event.systemPrompt}\n\nSTALE HYPAGOAL CONTINUATION:\n${validation.code ?? "stale_continuation"}: ${validation.message ?? "The continuation is stale."} Do not change repository files or canonical workflow state during this turn.`,
        };
      } else {
        deliveredContinuation = pending;
        revisionProposalHandled = false;
        continuationToolsBeforeDelivery = [...pi.getActiveTools()];
        if (pending.action.kind === "request-revision") {
          pi.setActiveTools(requiredContinuationTools(pending.action));
        } else {
          const tools = new Set(continuationToolsBeforeDelivery);
          for (const tool of requiredContinuationTools(pending.action)) tools.add(tool);
          pi.setActiveTools([...tools]);
        }
        return {
          systemPrompt: `${event.systemPrompt}\n\n${continuationSystemPrompt(pending, state)}\n\n${renderWorkflow(state)}`,
        };
      }
    }

    if (!state || ["completed", "cancelled", "failed", "blocked"].includes(state.phase) || state.goal?.status === "budget_limited" || state.goal?.status === "blocked") return;
    const ready = readyNodeIds(state);
    const at = new Date().toISOString();
    const runnableChecks = state.definition.nodes
      .filter((node) => (node.kind ?? "task") === "check" && node.check)
      .filter((node) => {
        const runtime = state!.runtime.nodes[node.id];
        if (!runtime || !node.check) return false;
        return evaluateCheckStart(runtime, node.check, `preview-${state!.sequence}-${node.id}`, at).ok;
      })
      .map((node) => node.id);
    const active = activeNode(state);
    return {
      systemPrompt: `${event.systemPrompt}\n\nHYPAGRAPH CONTROL:\n${renderWorkflow(state)}\nUse hypagraph_transition before and after task work. Use hypagraph_run_check for a ready or retryable check node. Use hypagraph_cancel_check to stop an active check. Work only on the active task node. Publish declared task facts before result submission. Submit task evidence before a separate verification action. Evaluate ready gates with the evaluate action. Ready nodes are [${ready.join(", ")}]. Runnable checks are [${runnableChecks.join(", ")}].${active ? ` The active node is '${active.id}'.` : " Start one ready task, run one runnable check, or evaluate one ready gate before you change the repository."}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (staleContinuationTurn && [
      "write",
      "edit",
      "hypagoal_start",
      "hypagraph_define",
      "hypagraph_transition",
      "hypagraph_run_check",
      "hypagraph_cancel_check",
      "hypagraph_revise",
       "hypagoal_submit_revision",
    ].includes(event.toolName)) {
      return { block: true, reason: "The queued Hypagoal continuation is stale. Read current state before another canonical change." };
    }
    if (hypagoalAuthoring !== undefined && (event.toolName === "write" || event.toolName === "edit")) {
      return { block: true, reason: "Hypagoal authoring is read-only. Create the workflow before semantic repository work starts." };
    }
    if (!state || state.definition.policy.mode !== "strict") return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const active = activeNode(state);
    if (!active) return { block: true, reason: "Hypagraph strict mode: Start a ready node before you change files." };
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return { block: true, reason: "Hypagraph strict mode: The file operation has no path." };
    const paths = active.scope?.paths ?? [];
    if (paths.length === 0) return { block: true, reason: `Hypagraph strict mode: Active node '${active.id}' has no writable scope.` };
    if (!scopeAllows(ctx.cwd, input.path, paths)) return { block: true, reason: `Hypagraph strict mode: '${input.path}' is outside the scope of node '${active.id}' [${paths.join(", ")}].` };
  });

  pi.registerTool({
    name: "hypagoal_start",
    label: "Start Hypagoal",
    description: "Atomically create and persist one root graph-backed goal from an ordinary prose objective and a repository-aware Hypagraph definition.",
    promptSnippet: "Create a root Hypagoal from a prose objective",
    promptGuidelines: [
      "Use hypagoal_start only after inspecting relevant repository context and compiling the smallest valid workflow for the user's exact objective.",
      "hypagoal_start accepts authoring advisories separately from canonical workflow fields and never accepts terminal goal state.",
      "Call hypagoal_start as the final action of a Hypagoal authoring turn. It creates durable state but does not continue execution.",
    ],
    parameters: hypagoalStartSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureNoActiveExecution();
      const input = normalizeHypagoalStartInput(params);
      const pending = hypagoalAuthoring;
      const suppliedCreation = input.creationRequest;
      const rejectCreationRequest = (code: string, message: string) => ({
        content: [{ type: "text" as const, text: `Hypagoal was not created. Canonical state is unchanged.\n${code}: ${message}` }],
        details: { hypagoal: { kind: "rejected", diagnostics: [{ code, message }] } },
        terminate: true,
      });

      if (pending) {
        if (!suppliedCreation) {
          hypagoalAuthoring = undefined;
          return rejectCreationRequest(
            "hypagoal_creation_request_required",
            "The active /hypagoal authoring turn requires its exact creationRequest identity.",
          );
        }
        const matches = suppliedCreation.operationId === pending.creationRequest.operationId
          && suppliedCreation.sessionGeneration === pending.creationRequest.sessionGeneration
          && suppliedCreation.branchGeneration === pending.creationRequest.branchGeneration
          && sessionGeneration === pending.creationRequest.sessionGeneration
          && branchGeneration === pending.creationRequest.branchGeneration;
        if (!matches) {
          hypagoalAuthoring = undefined;
          return rejectCreationRequest(
            "stale_hypagoal_creation_request",
            "The creationRequest does not match the active Pi session and branch generation.",
          );
        }
      } else if (suppliedCreation) {
        return rejectCreationRequest(
          "stale_hypagoal_creation_request",
          "The creationRequest no longer belongs to an active /hypagoal authoring turn.",
        );
      }

      const creationOperationId = pending?.creationRequest.operationId ?? `hypagoal-start:${randomUUID()}`;
      const objective = pending?.objective ?? input.objective;
      const replacementConfirmation = pending?.replacementConfirmation ?? input.replacementConfirmation;
      const workflowId = randomUUID();
      const goalId = `goal-${randomUUID()}`;
      const result = await startRootHypagoal(eventStore.lease(), state, {
        objective,
        definition: input.definition,
        workflowId,
        goalId,
        goalWorkflowId: workflowId,
        at: new Date().toISOString(),
        sessionGeneration,
        branchGeneration,
        advisories: input.advisories,
        ...(input.budget ? { budget: input.budget } : {}),
        ...(replacementConfirmation === undefined
          ? {}
          : { replacementConfirmation }),
      });
      hypagoalAuthoring = undefined;

      if (result.kind === "created") {
        state = result.state;
        events = [...result.events];
        updateUi(state, ctx, graphPane);
        return {
          content: [{ type: "text" as const, text: renderHypagoalCreated(result) }],
          details: {
            hypagraph: persisted(),
            graph: projectGraphView(state),
            hypagoal: {
              kind: result.kind,
              objective: state.definition.goal,
              workflowId: state.workflowId,
              goalId: state.goal?.goalId,
              workflowRevision: state.revision,
              goalControl: structuredClone(state.goal),
              ready: hypagoalReadyWork(state),
              advisories: structuredClone(result.advisories),
              creation: {
                operationId: creationOperationId,
                correlationId: result.events[0]?.correlationId,
                sessionGeneration,
                branchGeneration,
              },
              ...(result.replaced === undefined ? {} : { replaced: structuredClone(result.replaced) }),
              autonomousContinuationStarted: false,
            },
          },
          terminate: true,
        };
      }

      if (result.kind === "replacement-required") {
        return {
          content: [{ type: "text" as const, text: renderReplacementRequired(result.current) }],
          details: {
            hypagoal: {
              kind: result.kind,
              current: structuredClone(result.current),
              replacementConfirmation: structuredClone(result.confirmation),
              creation: { operationId: creationOperationId, sessionGeneration, branchGeneration },
            },
          },
          terminate: true,
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: `Hypagoal was not created. Canonical state is unchanged.\n${formatDiagnostics(result.diagnostics)}`,
        }],
        details: {
          hypagoal: {
            kind: result.kind,
            diagnostics: structuredClone(result.diagnostics),
          },
        },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "hypagraph_define",
    label: "Define Hypagraph",
    description: "Define and validate a directed coding workflow with task, gate, and command-check nodes.",
    promptSnippet: "Define a validated workflow before multi-step coding work",
    promptGuidelines: ["Use hypagraph_define for work that needs explicit dependencies, typed facts, deterministic gates, checks, and evidence."],
    parameters: definitionSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureNoActiveExecution();
      if (state) {
        throw new Error("An active Hypagraph already exists. Use hypagraph_revise for the current workflow or /hypagoal for explicit root replacement.");
      }
      const result = await commitCreatedWorkflow(
        eventStore.lease(),
        createWorkflow(normalizeDefinition(params), new Date().toISOString(), randomUUID()),
      );
      if (!result.ok) return throwDiagnostics(result.diagnostics);
      state = result.state;
      events = [...result.events];
      updateUi(state, ctx, graphPane);
      return textResult(`${renderWorkflow(state)}\n\nHypagraph accepted the definition.`);
    },
  });

  pi.registerTool({
    name: "hypagraph_read",
    label: "Read Hypagraph",
    description: "Read the workflow, graph projection, event history, decision explanations, active node, ready nodes, attempts, facts, routes, checks, and node states.",
    promptSnippet: "Read the current Hypagraph state",
    promptGuidelines: [
      "Use the history view to read the recent event timeline. Use the explain view to read why a node or the goal is not runnable.",
    ],
    parameters: Type.Object({
      view: Type.Optional(StringEnum(["summary", "full", "graph", "history", "explain"] as const)),
      nodeId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
      if (params.view === "full") {
        const contexts = projectModelVisibleTaskContext(state, params.nodeId);
        const contextBlock = JSON.stringify(contexts, null, 2);
        return textResult(`${renderWorkflow(state)}\n\nTask context:\n${contextBlock}`);
      }
      if (params.view === "graph") {
        return textResult(JSON.stringify(projectModelVisibleGraphView(state), null, 2));
      }
      if (params.view === "history") {
        return textResult(JSON.stringify(projectModelVisibleHistory(events), null, 2));
      }
      if (params.view === "explain") {
        return textResult(renderExplanation(state, params.nodeId));
      }
      // summary (default): include taskContexts for every bound task, or one node.
      if (params.nodeId) {
        const summary = projectModelVisibleWorkflowSummary(state);
        summary.taskContext = projectModelVisibleTaskContext(state, params.nodeId);
        return textResult(JSON.stringify(summary, null, 2));
      }
      return textResult(JSON.stringify(projectModelVisibleWorkflowSummary(state), null, 2));
    },
  });

  pi.registerTool({
    name: "hypagraph_run_check",
    label: "Run Hypagraph Check",
    description: "Run one ready or retryable command-check node with durable lifecycle commits, timeout, cancellation, bounded output, typed facts, and artifact references.",
    promptSnippet: "Run a deterministic command check",
    promptGuidelines: ["Use hypagraph_run_check only for a ready or retryable check node. Each retry uses a new attempt ID. Do not start a check with hypagraph_transition."],
    parameters: Type.Object({ nodeId: Type.String() }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
      if (activeExecutions.hasActive()) throw new Error("Another check tool call is active.");

      const runState = state;
      const nodeId = params.nodeId;
      const attemptId = randomUUID();
      const requestedAt = new Date().toISOString();
      const runnable = requireRunnableCommandCheck(runState, nodeId, attemptId, requestedAt);
      const commandText = formatPiCheckCommand(runnable.definition);
      const executor = new CommandCheckExecutor({
        rootDirectory: ctx.cwd,
        artifactStore: new FileCheckArtifactStore(resolve(ctx.cwd, ".hypagraph", "check-artifacts")),
      });
      const runGeneration = sessionGeneration;
      const execution = activeExecutions.register({
        workflowId: runState.workflowId,
        nodeId,
        attemptId,
        startedAt: requestedAt,
        ...(signal ? { upstreamSignal: signal } : {}),
      });

      let elapsedSeconds = 0;
      const action = runnable.retry ? "Retrying" : "Starting";
      onUpdate?.({
        content: [{ type: "text", text: `${action} check '${nodeId}': ${commandText}` }],
        details: { nodeId, attemptId, state: "starting", retry: runnable.retry, elapsedSeconds },
      });
      ctx.ui.setStatus("hypagraph-check", `Check ${nodeId}: starting`);
      const timer = setInterval(() => {
        elapsedSeconds += 1;
        onUpdate?.({
          content: [{ type: "text", text: `Check '${nodeId}' is running (${elapsedSeconds} s).` }],
          details: { nodeId, attemptId, state: "running", retry: runnable.retry, elapsedSeconds },
        });
        ctx.ui.setStatus("hypagraph-check", `Check ${nodeId}: ${elapsedSeconds}s`);
      }, 1_000);
      timer.unref();

      try {
        const lifecycle = await runPiCommandCheck({
          state: runState,
          executor,
          store: eventStore.lease(),
          nodeId,
          attemptId,
          requestedAt,
          signal: execution.signal,
          onTransition: (transition) => {
            if (sessionGeneration !== runGeneration) return;
            state = transition.state;
            events.push(...transition.events);
            updateUi(state, ctx, graphPane);
          },
        });
        if (sessionGeneration !== runGeneration) throw new Error("The Pi session changed while the check was active.");
        state = lifecycle.state;
        updateUi(state, ctx, graphPane);
        if (!lifecycle.ok) return throwDiagnostics(lifecycle.diagnostics);
        const text = `${formatPiCheckResult(state, nodeId, lifecycle.result)}\n\n${renderWorkflow(state)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: {
            hypagraph: persisted(),
            graph: projectGraphView(state),
            check: {
              nodeId,
              attemptId,
              retry: runnable.retry,
              result: structuredClone(lifecycle.result),
              commands: structuredClone(lifecycle.commands),
            },
          },
        };
      } finally {
        clearInterval(timer);
        execution.release();
        ctx.ui.setStatus("hypagraph-check", undefined);
      }
    },
  });

  pi.registerTool({
    name: "hypagraph_cancel_check",
    label: "Cancel Hypagraph Check",
    description: "Request cancellation of the active command check.",
    promptSnippet: "Cancel an active Hypagraph check",
    promptGuidelines: ["Use this tool only when a running check must stop. Cancellation is terminal for the current attempt."],
    parameters: Type.Object({
      nodeId: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const cancelled = cancelActiveChecks(params.nodeId, params.reason?.trim() || "The check was cancelled through Pi.");
      if (cancelled.length === 0) throw new Error(params.nodeId ? `Check '${params.nodeId}' is not active.` : "There is no active check.");
      return textResult(`Cancellation requested for: ${cancelled.join(", ")}.`);
    },
  });

  pi.registerTool({
    name: "hypagraph_transition",
    label: "Transition Hypagraph",
    description: "Start, publish, submit, verify, evaluate, block, cancel, pause, or resume through the durable event-driven lifecycle.",
    promptSnippet: "Move Hypagraph through its deterministic lifecycle",
    promptGuidelines: ["Use hypagraph_transition for task and gate lifecycle actions. Use hypagraph_run_check and hypagraph_cancel_check for checks."],
    parameters: Type.Object({
      nodeId: Type.Optional(Type.String()),
      action: StringEnum(["start", "publish", "submit", "verify", "evaluate", "block", "unblock", "cancel", "pause", "resume"] as const),
      facts: Type.Optional(Type.Array(factInputSchema)),
      evidence: Type.Optional(Type.Array(evidenceSchema)),
      passed: Type.Optional(Type.Boolean()),
      reason: Type.Optional(Type.String()),
      blockerKind: Type.Optional(StringEnum(["repository-work", "external-dependency", "safeguard", "unknown"] as const)),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
      const at = new Date().toISOString();
      const correlationId = randomUUID();
      const commands: HypagraphCommand[] = [];
      if (params.action === "pause") {
        ensureNoActiveExecution();
        commands.push({ type: "pause-workflow", commandId: randomUUID(), correlationId, at });
      } else if (params.action === "resume") {
        ensureNoActiveExecution();
        commands.push({ type: "resume-workflow", commandId: randomUUID(), correlationId, at });
      } else {
        const nodeId = nodeIdRequired(params.nodeId);
        if (params.action === "cancel") {
          const cancelled = cancelActiveChecks(nodeId, params.reason?.trim() || "The check was cancelled through Hypagraph transition.");
          if (cancelled.length > 0) return textResult(`Cancellation requested for check '${nodeId}'.`);
        }
        ensureNoActiveExecution();
        if (params.action === "start") {
          const node = state.definition.nodes.find((item) => item.id === nodeId);
          if ((node?.kind ?? "task") === "check") throw new Error(`Use hypagraph_run_check for check node '${nodeId}'.`);
          if ((node?.kind ?? "task") === "interaction") {
            commands.push({ type: "request-interaction", nodeId, attemptId: randomUUID(), commandId: randomUUID(), correlationId, at });
          } else {
            commands.push({ type: "start-node", nodeId, attemptId: randomUUID(), commandId: randomUUID(), correlationId, at });
          }
        } else if (params.action === "evaluate") commands.push({ type: "evaluate-gate", nodeId, commandId: randomUUID(), correlationId, at });
        else if (params.action === "publish") {
          const attemptId = state.runtime.nodes[nodeId]?.currentAttemptId;
          if (!attemptId) throw new Error(`Node '${nodeId}' has no current attempt.`);
          // Intermediate fact publication during an attempt. Task completion
          // (submit and cancel) settles through the shared executor result path.
          commands.push({ type: "publish-facts", nodeId, attemptId, facts: structuredClone(params.facts ?? []), commandId: randomUUID(), correlationId, at });
        } else if (params.action === "submit") {
          const attemptId = state.runtime.nodes[nodeId]?.currentAttemptId;
          if (!attemptId) throw new Error(`Node '${nodeId}' has no current attempt.`);
          const settledCommands = settleLiveTaskCompletion({
            ctx,
            state,
            nodeId,
            attemptId,
            outcome: "submitted",
            ...(params.facts !== undefined ? { facts: params.facts as FactInput[] } : {}),
            ...(params.evidence !== undefined ? { evidence: params.evidence as EvidenceReference[] } : {}),
            at,
            correlationId,
          });
          if (settledCommands) {
            commands.push(...settledCommands);
          } else {
            commands.push({ type: "submit-result", nodeId, attemptId, evidence: params.evidence ?? [], commandId: randomUUID(), correlationId, at });
          }
        } else if (params.action === "verify") {
          const attemptId = state.runtime.nodes[nodeId]?.currentAttemptId;
          if (!attemptId) throw new Error(`Node '${nodeId}' has no current attempt.`);
          if (state.runtime.nodes[nodeId]?.status === "awaiting_evidence") {
            commands.push({ type: "begin-verification", nodeId, attemptId, commandId: randomUUID(), correlationId, at });
          }
          commands.push({ type: "complete-verification", nodeId, attemptId, passed: params.passed ?? true, ...(params.reason ? { reason: params.reason } : {}), commandId: randomUUID(), correlationId, at });
        } else if (params.action === "block") commands.push({ type: "block-node", nodeId, reason: params.reason ?? "", ...(params.blockerKind ? { blockerKind: params.blockerKind } : {}), commandId: randomUUID(), correlationId, at });
        else if (params.action === "unblock") commands.push({ type: "unblock-node", nodeId, commandId: randomUUID(), correlationId, at });
        else {
          const attemptId = state.runtime.nodes[nodeId]?.currentAttemptId;
          if (!attemptId) throw new Error(`Node '${nodeId}' has no current attempt.`);
          const settledCommands = settleLiveTaskCompletion({
            ctx,
            state,
            nodeId,
            attemptId,
            outcome: "cancelled",
            ...(params.reason !== undefined ? { reason: params.reason } : {}),
            at,
            correlationId,
          });
          if (settledCommands) {
            commands.push(...settledCommands);
          } else {
            commands.push({ type: "cancel-attempt", nodeId, attemptId, ...(params.reason ? { reason: params.reason } : {}), commandId: randomUUID(), correlationId, at });
          }
        }
      }
      await runCommands(commands);
      updateUi(state, ctx, graphPane);
      return textResult(renderWorkflow(state));
    },
  });

  pi.registerTool({
    name: "hypagraph_ask",
    label: "Ask the user",
    description: "Present the declared question of one interaction node to the user and store the typed answer which the user selects.",
    promptSnippet: "Ask the user one declared question",
    promptGuidelines: [
      "Use hypagraph_ask only for an interaction node which is ready or which waits for an answer.",
      "hypagraph_ask presents the declared question and the declared response options. Do not invent a question, a response, or an answer.",
      "hypagraph_ask opens a dialog only when the graph has no other runnable action. Complete the other runnable work first.",
    ],
    parameters: Type.Object({
      nodeId: Type.String({ description: "The interaction node which holds the declared question" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state) throw new Error("There is no active Hypagraph. Call hypagraph_define first.");
      const nodeId = params.nodeId;
      const node = state.definition.nodes.find((item) => item.id === nodeId);
      if ((node?.kind ?? "task") !== "interaction" || !node?.interaction) {
        throw new Error(`Node '${nodeId}' is not an interaction.`);
      }
      const runtime = state.runtime.nodes[nodeId];
      if (runtime?.status !== "ready" && runtime?.status !== "awaiting_response") {
        throw new Error(`Interaction '${nodeId}' is '${runtime?.status ?? "pending"}'. Only a ready or awaiting interaction can be asked.`);
      }
      // Rule 1.1.1. A dialog stops the host turn, so it must not open while the
      // graph has other runnable work.
      if (!interactionPresentationIsAllowed(state, nodeId)) {
        return textResult(`Interaction '${nodeId}' was not presented. The graph has other runnable work. Complete that work, then ask again.`);
      }

      ensureNoActiveExecution();
      // Rule 1.1.2. Store the request before the dialog opens.
      if (runtime.status === "ready") {
        await runCommands([{ type: "request-interaction", nodeId, attemptId: randomUUID(), commandId: randomUUID(), correlationId: randomUUID(), at: new Date().toISOString() }]);
      }
      const awaiting = awaitingInteractions(state!).find((item) => item.nodeId === nodeId);
      if (!awaiting) throw new Error(`Interaction '${nodeId}' is not awaiting a response.`);

      const outcome = await presentAwaitingInteraction(ctx, awaiting);
      updateUi(state!, ctx, graphPane);
      if (outcome === "answered") {
        return textResult(`${renderWorkflow(state!)}\n\nHypagraph stored the answer for interaction '${nodeId}'.`);
      }
      if (outcome === "presentation-failed") {
        const observation = interactionPresentationObservation(state!, nodeId, awaiting.attemptId);
        const detail = observation?.error
          ? `${observation.status}: ${observation.error}`
          : (observation?.status ?? "failed");
        return textResult(
          `${renderWorkflow(state!)}\n\nInteraction '${nodeId}' presentation ${detail}. `
          + `The node is failed and does not wait for an answer.`,
        );
      }
      // Rules 1.1.3 and 1.1.4. The question stays open and durable.
      if (outcome === "unavailable") {
        return textResult(
          `Interaction '${nodeId}' waits for an answer. This host has no dialog capability. `
          + `The question stays open and durable. A host with dialog capability can present it later.`,
        );
      }
      return textResult(
        `Interaction '${nodeId}' waits for an answer. The user dismissed the dialog. `
        + `Stop and wait for the user. Use /hypagraph ask to present the dialog again, `
        + `or let the controller present it when no other work is runnable.`,
      );
    },
  });

  pi.registerTool({
    name: "hypagoal_submit_revision",
    label: "Submit bounded Hypagoal revision",
    description: "Submit the one state-bound replacement definition for deterministic automatic-revision validation.",
    promptSnippet: "Submit one bounded replacement definition",
    promptGuidelines: ["Use this tool only during a delivered bounded-revision turn. Preserve the exact objective and every existing safeguard."],
    parameters: definitionSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureNoActiveExecution();
      const canonical = state?.goal?.pendingContinuation;
      const delivered = deliveredContinuation;
      // Live Pi can lose in-memory delivery bookkeeping while the durable
      // request-revision continuation remains. Accept that durable request so the
      // one automatic revision turn can still complete.
      const revisionRequest = delivered?.action.kind === "request-revision"
        ? delivered.action
        : canonical?.action.kind === "request-revision"
          ? canonical.action
          : undefined;
      if (!state?.goal || !canonical || !revisionRequest || revisionRequest.kind !== "request-revision") {
        throw new Error("There is no delivered automatic revision request.");
      }
      if (delivered && delivered.operationId !== canonical.operationId) {
        throw new Error("There is no delivered automatic revision request.");
      }
      const revisionOperationId = delivered?.operationId ?? canonical.operationId;
      revisionProposalHandled = true;
      let revisedDefinition;
      try {
        revisedDefinition = { ...normalizeDefinition(params), goal: params.goal };
      } catch (error) {
        if (error instanceof CodeDefinitionError) {
          return {
            content: [{ type: "text" as const, text: `The automatic revision proposal is stale or unsafe. Canonical workflow state is unchanged.
${formatDiagnostics(error.diagnostics)}` }],
            details: {
              hypagraph: persisted(),
              revision: { kind: "rejected", diagnostics: structuredClone(error.diagnostics) },
            },
            terminate: true,
          };
        }
        throw error;
      }
      const result = await applyCommandsAndCommit(eventStore.lease(), state, [{
        type: "apply-goal-revision",
        goalId: state.goal.goalId,
        workflowId: state.workflowId,
        expectedRevision: state.revision,
        expectedSequence: state.sequence,
        expectedSnapshotHash: state.snapshotHash,
        revisionOperationId,
        continuationOperationId: canonical.operationId,
        continuationOrdinal: canonical.ordinal,
        requestSequence: canonical.requestSequence,
        sessionGeneration: canonical.sessionGeneration,
        branchGeneration: canonical.branchGeneration,
        blocker: structuredClone(revisionRequest.blocker),
        definition: revisedDefinition,
        commandId: `apply-goal-revision:${randomUUID()}`,
        correlationId: revisionOperationId,
        at: new Date().toISOString(),
      }]);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `The automatic revision proposal is stale or unsafe. Canonical workflow state is unchanged.
${formatDiagnostics(result.diagnostics)}` }],
          details: { hypagraph: persisted(), revision: { kind: "rejected", diagnostics: structuredClone(result.diagnostics) } },
          terminate: true,
        };
      }
      state = result.value.state;
      events.push(...result.value.events);
      updateUi(state, ctx, graphPane);
      const attempt = state.goal?.automaticRevision.lastAttempt;
      const accepted = attempt?.outcome === "applied";
      return {
        content: [{ type: "text" as const, text: accepted
          ? `${renderWorkflow(state)}

Hypagraph accepted the bounded automatic revision through the canonical revision reducer.`
          : `Hypagraph rejected the bounded automatic revision. ${attempt?.reason ?? "The proposal did not preserve the required contracts or did not restore a runnable path."}` }],
        details: { hypagraph: persisted(), revision: structuredClone(attempt) },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "hypagraph_revise",
    label: "Revise Hypagraph",
    description: "Replace the graph and invalidate changed work.",
    promptSnippet: "Revise a Hypagraph",
    parameters: definitionSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureNoActiveExecution();
      if (state?.goal?.pendingContinuation?.action.kind === "request-revision"
        || state?.goal?.automaticRevision.lastAttempt?.outcome === "pending") {
        throw new Error("An automatic bounded revision is pending. Use hypagoal_submit_revision for that turn.");
      }
      await runCommands([{ type: "revise", definition: normalizeDefinition(params), commandId: randomUUID(), at: new Date().toISOString() }]);
      updateUi(state, ctx, graphPane);
      return textResult(`${renderWorkflow(state!)}\n\nHypagraph accepted the revision.`);
    },
  });

  pi.registerCommand("hypagoal", {
    description: "Create or inspect one root graph-backed goal; status, pause, resume, cancel, and graph are supported",
    handler: async (args, ctx) => {
      const raw = args.trim();
      const words = raw.split(/\s+/).filter(Boolean);
      const action = words[0]?.toLowerCase();

      if (!raw || action === "help") {
        ctx.ui.notify("Usage: /hypagoal <objective> | status | pause [reason] | resume | cancel [reason] | graph", "info");
        return;
      }
      if (action === "status") {
        if (!state?.goal) throw new Error("There is no active Hypagoal to inspect.");
        ctx.ui.notify(renderHypagoalStatus(state), "info");
        return;
      }
      if (action === "graph") {
        graphPane.open(ctx);
        return;
      }
      if (action === "pause") {
        ensureNoActiveExecution();
        if (!state?.goal) throw new Error("There is no active Hypagoal to pause.");
        await abandonPendingContinuation("The user paused the Hypagoal from Pi.");
        pendingContinuation = undefined;
        deliveredContinuation = undefined;
        revisionProposalHandled = false;
        restoreContinuationTools();
        const reason = words.slice(1).join(" ").trim() || "The user paused the Hypagoal from Pi.";
        await runCommands([{
          type: "pause-goal",
          cause: "explicit",
          reason,
          commandId: `pause-goal:explicit:${randomUUID()}`,
          at: new Date().toISOString(),
        }]);
        updateUi(state, ctx, graphPane);
        ctx.ui.notify(renderHypagoalLifecycleMessage(state!), "info");
        return;
      }
      if (action === "resume") {
        ensureNoActiveExecution();
        if (!state?.goal) throw new Error("There is no active Hypagoal to resume.");
        await runCommands([{ type: "resume-goal", commandId: `resume-goal:${randomUUID()}`, at: new Date().toISOString() }]);
        updateUi(state, ctx, graphPane);
        if (state?.goal?.status === "active") {
          ctx.ui.notify(renderHypagoalLifecycleMessage(state), "info");
          await queueGoalContinuation(ctx);
        } else ctx.ui.notify(state?.goal?.stopReason ?? "The Hypagoal did not resume.", "warning");
        return;
      }
      if (action === "cancel") {
        ensureNoActiveExecution();
        if (!state?.goal) throw new Error("There is no active Hypagoal to cancel.");
        await abandonPendingContinuation("The user cancelled the Hypagoal from Pi.");
        pendingContinuation = undefined;
        deliveredContinuation = undefined;
        revisionProposalHandled = false;
        restoreContinuationTools();
        const reason = words.slice(1).join(" ").trim() || "The user cancelled the Hypagoal from Pi.";
        await runCommands([{
          type: "cancel-goal",
          reason,
          commandId: `cancel-goal:${randomUUID()}`,
          at: new Date().toISOString(),
        }]);
        updateUi(state, ctx, graphPane);
        ctx.ui.notify(renderHypagoalLifecycleMessage(state!), "warning");
        return;
      }

      const objective = args;
      ensureNoActiveExecution();

      const generations = { sessionGeneration, branchGeneration };
      const replacementConfirmation = state
        ? replacementConfirmationFor(state, generations)
        : undefined;
      if (state) {
        if (!ctx.hasUI) {
          throw new Error("Replacing the current root requires an interactive confirmation bound to the current canonical state.");
        }
        const confirmed = await ctx.ui.confirm(
          "Replace current root Hypagoal?",
          [
            `Objective: ${state.definition.goal}`,
            `Workflow: ${state.workflowId} revision ${state.revision}`,
            `Goal control: ${state.goal?.status ?? "none"}`,
            `Sequence: ${state.sequence}`,
            "The current root remains in session history, but the new root becomes active only after one successful atomic append.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const creationRequest: HypagoalCreationRequest = {
        operationId: `hypagoal-create:${randomUUID()}`,
        sessionGeneration,
        branchGeneration,
      };
      hypagoalAuthoring = {
        objective,
        creationRequest,
        ...(replacementConfirmation === undefined ? {} : { replacementConfirmation }),
      };
      pi.sendUserMessage(buildHypagoalAuthoringPrompt(objective, creationRequest, replacementConfirmation));
    },
  });

  const renderHistoryCommand = (words: readonly string[]): string => {
    if (!state) return "There is no active Hypagraph.";
    const first = words[0]?.toLowerCase();
    if (first !== undefined && /^\d+$/.test(first)) {
      try {
        return renderReplayAtSequence(events, state, Number(first));
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
    if (first === "revisions") return renderRevisionHistory(events, state);
    if (first !== undefined && !isTimelineLane(first)) {
      return `Usage: /hypagraph history [<sequence> | revisions | <lane>] where a lane is ${TIMELINE_LANES.join(", ")}.`;
    }
    return renderEventTimeline(events, first === undefined ? {} : { lane: first });
  };

  pi.registerCommand("hypagraph", {
    description: "Show Hypagraph status, present an open question, read event history, replay, explanations, loop status, cancel a check, or control the graph pane",
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const action = words.map((word) => word.toLowerCase()).join(" ");
      if (action === "help") ctx.ui.notify(hypagraphUsage(), "info");
      else if (action === "graph" || action === "graph open") graphPane.open(ctx);
      else if (action === "graph close") graphPane.close();
      else if (action === "graph toggle") graphPane.toggle(ctx);
      else if (action === "graph focus") graphPane.focus();
      else if (action === "loop") ctx.ui.notify(state ? renderLoopCommand(state) : "There is no active Hypagraph.", "info");
      else if (words[0]?.toLowerCase() === "history") ctx.ui.notify(renderHistoryCommand(words.slice(1)), "info");
      else if (words[0]?.toLowerCase() === "explain") {
        if (!state) ctx.ui.notify("There is no active Hypagraph.", "info");
        else ctx.ui.notify(renderExplanation(state, words[1]), "info");
      }
      else if (words[0]?.toLowerCase() === "check" && words[1]?.toLowerCase() === "cancel") {
        const cancelled = cancelActiveChecks(words[2], "The user cancelled the check from Pi.");
        ctx.ui.notify(cancelled.length > 0 ? `Cancellation requested for: ${cancelled.join(", ")}.` : "There is no matching active check.", cancelled.length > 0 ? "warning" : "info");
      } else if (words[0]?.toLowerCase() === "check" && words[1]?.toLowerCase() === "active") {
        const active = state ? activeExecutions.list(state.workflowId) : [];
        ctx.ui.notify(active.length > 0 ? active.map((entry) => `${entry.nodeId} (${entry.attemptId})`).join("\n") : "There is no active check.", "info");
      } else if (words[0]?.toLowerCase() === "ask") {
        if (!state) {
          ctx.ui.notify("There is no active Hypagraph.", "info");
          return;
        }
        const awaiting = words[1]
          ? awaitingInteractions(state).find((item) => item.nodeId === words[1])
          : awaitingInteractions(state)[0];
        if (!awaiting) {
          ctx.ui.notify(words[1] ? `Interaction '${words[1]}' is not awaiting a response.` : "No question is waiting for an answer.", "info");
          return;
        }
        ensureNoActiveExecution();
        const outcome = await presentAwaitingInteraction(ctx, awaiting);
        updateUi(state!, ctx, graphPane);
        if (outcome === "answered") {
          ctx.ui.notify(renderWorkflow(state!), "info");
          // The person often recovers with /hypagraph ask after a dismiss. Resume
          // the controller so ready follow-on work does not stall until a later turn.
          await queueGoalContinuation(ctx);
        } else if (outcome === "presentation-failed") {
          const observation = interactionPresentationObservation(state!, awaiting.nodeId, awaiting.attemptId);
          const detail = observation?.error
            ? `${observation.status}: ${observation.error}`
            : (observation?.status ?? "failed");
          ctx.ui.notify(
            `Interaction '${awaiting.nodeId}' presentation ${detail}. The node is failed and does not wait for an answer.`,
            "warning",
          );
        } else if (outcome === "unavailable") {
          ctx.ui.notify(
            waitingUnavailableNote(state!)
              ?? `This host has no dialog capability. Interaction '${awaiting.nodeId}' still waits for an answer.`,
            "warning",
          );
        } else {
          ctx.ui.notify(
            waitingLifecycleNote(state!)
              ?? `Waiting for a user response on node '${awaiting.nodeId}'. Use /hypagraph ask to present the dialog again.`,
            "info",
          );
        }
      } else if (words.length === 0) {
        ctx.ui.notify(state ? renderWorkflow(state) : "There is no active Hypagraph.", "info");
      } else {
        // A command must not accept an unknown subcommand in silence. A silent
        // workflow render hides a typing mistake.
        ctx.ui.notify(`/hypagraph has no '${words.join(" ")}' subcommand.\n${hypagraphUsage()}`, "warning");
      }
    },
  });
}
