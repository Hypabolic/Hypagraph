import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
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
  Diagnostic,
  DomainEvent,
  EvidenceReference,
  FactInput,
  HypagraphCommand,
  HypagraphState,
  InteractionDefinition,
  PersistedHypagraph,
} from "./domain/model.js";
import type { ExecutorContextEnvelope } from "./domain/executor-contract.js";
import { InteractionDialogComponent, type InteractionDialogResult } from "./pi/interaction-dialog.js";
import {
  hostSupportsPostCreateDock,
  PostCreateDockComponent,
  type PostCreateDockResult,
} from "./pi/post-create-dock.js";
import { projectMermaidFlowchart } from "./graph/mermaid-projection.js";

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
import type { FamilyExecutorHostSnapshot, FamilyGraphViewModel } from "./graph/family-projection.js";
import { projectGraphView } from "./graph/projection.js";
import {
  projectProductFamilyView,
} from "./ui/family-product.js";
import {
  replacementConfirmationFor,
  startRootHypagoal,
} from "./hypagoal/root-creation.js";
import {
  DEFAULT_DEMO_ID,
  demoDispatchHoldMs,
  formatDemoCatalog,
  isShowcaseTourId,
  resolveDemoExample,
  showcaseTourIds,
  sleepDemoHold,
  type HypagraphDemoExample,
} from "./pi/demo-catalog.js";
import {
  continuationActionIsRunnable,
  enumerateGoalContinuationCandidates,
  isDispatchableGoalContinuation,
  selectGoalContinuation,
  type GoalDispatchableContinuation,
} from "./domain/goal-continuation.js";
import {
  applyCommandsAndCommit,
  dispatchReadyGateAndCommit,
  interruptPendingActionDispatchAndCommit,
} from "./persistence/coordinator.js";
import {
  appendOneMemberFamilyRecord,
  createBoundedChildGoalInFamily,
  restoreLatestFamilySession,
  restoreOrMigrateOneMemberFamilySession,
  returnChildGoalInFamily,
} from "./persistence/family-session.js";
import type { PersistedGoalFamily } from "./persistence/family-store.js";
import { PiSessionWorkflowEventStore } from "./persistence/pi-session-store.js";
import {
  buildFamilyControllerMemberStates,
  mergeLiveRootIntoFamily,
  replaceFamilyMemberWorkflow,
  type FamilyProductConcurrencyPolicy,
} from "./pi/family-product-dispatch.js";
import {
  commitConcurrentFamilyBatchForHost,
  commitSequentialFamilySelectionForHost,
  familySettleOutcomeFromHostDispatch,
  interruptAllFamilyPendingsForHost,
  isDeterministicFamilyMemberDecision,
  markFamilyPendingDispatchedWithRefreshedMemberState,
  refreshFamilyProductMemberState,
  validateMemberStateAgainstFamilyPending,
  resolveFamilyRecordForPendingSweep,
  resolveFamilyRecordForPostOrphanPendingSweep,
  selectFamilyControllerAction,
  settleFamilyPendingForHost,
} from "./pi/family-controller-host.js";
import {
  attachMember,
  attachRootMember,
  bumpSessionGenerations,
  createSessionContext,
  liveSlotsFromMember,
  resolveLiveSlotRelease,
  setSessionFamilyRecord,
  setSessionRootWorkflowId,
  shouldPersistNonRootMemberAfterBind,
  syncMemberFromLiveSlots,
  type MemberContext,
  type SessionContext,
} from "./pi/session-context.js";
import {
  detectPendingChildReturn,
  renderChildReturnApplied,
} from "./pi/family-product-return.js";
import {
  applyReadyJoinSynthesesToPersistedFamily,
  renderJoinSynthesisApplied,
} from "./pi/family-product-synthesis.js";
import { restoreLatestSession } from "./persistence/session-rebuild.js";
import { formatPiCheckResult, requireRunnableCommandCheck, runPiCommandCheck } from "./pi/check-tool.js";
import {
  createCurrentSessionExecutor,
  routeLiveTaskCompletion,
} from "./pi/current-session-executor.js";
import {
  createChildProcessAcpTransport,
  DEFAULT_ACP_PROMPT_TIMEOUT_MS,
  materializeAcpContext,
} from "./pi/acp-executor.js";
import {
  CLI_PROFILE,
  createChildProcessCliTransport,
  DEFAULT_CLI_TIMEOUT_MS,
  materializeCliContext,
} from "./pi/cli-executor.js";
import {
  bindActiveIsolatedPiHost,
  createChildProcessIsolatedPiTransport,
  createIsolatedPiHost,
  dispatchIsolatedPiAttempt,
  ISOLATED_PI_PROFILE,
  materializeIsolatedPiContext,
  type IsolatedPiHost,
} from "./pi/isolated-pi-executor.js";
import { DEFAULT_GLOBAL_CONCURRENCY } from "./domain/concurrency-limits.js";
import { applyMemberStreamAndPendingSettle } from "./pi/family-concurrent-bag.js";
import { runIsolatedWithFreeSlotProtocol } from "./pi/isolated-free-slot-protocol.js";
import {
  abortAllUnsettledIsolatedWorkers,
  acceptIsolatedRootSettlement,
  buildOrphanedTaskCancelCommands,
  buildPostSubmitVerificationCommands,
  canAdmitIsolatedWorker,
  clearIsolatedWorkerPool,
  cloneActiveIsolatedForTeardown,
  countUnsettledIsolatedWorkers,
  DEFAULT_ISOLATED_ROOT_TIMEOUT_MS,
  deleteIsolatedWorkerForAttempt,
  findIsolatedWorkerByAttemptId,
  findIsolatedWorkerByNodeId,
  formatIsolatedWorkerStatusLine,
  isolatedRootSettleMeta,
  listUnsettledIsolatedWorkers,
  prepareIsolatedRootAttempt,
  registerIsolatedWorker,
  routeRootModelLaneAction,
  withHostTimestamp,
  type ActiveIsolatedRootAttempt,
} from "./pi/isolated-root-dispatch.js";
import { getHostRoutingOptions } from "./pi/host-routing-options.js";
import {
  activeWorkerGateBlockReason,
  AUTHORING_GATE_BLOCK_REASON,
  isHypagraphFamilyControlToolDuringWorker,
  isHypagraphAuthoringBlockedTool,
  isHypagraphWorkMutatingTool,
  NON_ROOT_CURRENT_SESSION_BAN_REASON,
  POST_CREATE_GATE_BLOCK_REASON,
} from "./pi/mutating-tool-policy.js";
import { shouldReopenPostCreateGate } from "./pi/post-create-gate-policy.js";
import { normalizePiGoalUsage, PI_ASSISTANT_USAGE_SOURCE } from "./pi/hypagoal-budget.js";
import { CodeDefinitionError, definitionSchema, evidenceSchema, factInputSchema, normalizeDefinition } from "./pi/definition.js";
import { GraphPaneController } from "./pi/graph-pane.js";
import {
  projectModelVisibleGraphView,
  projectModelVisibleTaskContext,
  projectModelVisibleWorkflowSummary,
} from "./pi/model-visible-state.js";
import { formatPiCheckCommand } from "./pi/check-runner.js";
import {
  runDeterministicCheckDispatch,
  runParallelDeterministicCheckDispatch,
} from "./pi/deterministic-check-runner.js";
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
  renderHypagraphValidation,
  validateHypagraphDefinition,
} from "./pi/validate-definition.js";
import {
  buildHypagoalAuthoringPrompt,
  hypagoalReadyWork,
  hypagoalStartSchema,
  normalizeHypagoalStartInput,
  renderHypagoalCreated,
  renderReplacementRequired,
  type HypagoalCreationRequest,
} from "./pi/hypagoal.js";
import {
  applyChildObjectiveToDefinition,
  hypagoalCreateChildSchema,
  normalizeHypagoalCreateChildInput,
  renderHypagoalChildCreated,
} from "./pi/hypagoal-create-child.js";
import {
  addCheckSchema,
  addTaskSchema,
  draftBeginSchema,
  draftIdSchema,
  implementParallelReviewRecipeSchema,
  implementVerifyRecipeSchema,
  loopSchema as draftLoopToolSchema,
  renderDraftSummary,
  renderDraftToolResult,
  requireSchema,
  validateDraftProjection,
} from "./pi/draft-tools.js";
import {
  createEmptyDraft,
  projectDraftDefinition,
  summarizeDraft,
  validateDraftCommitIdentity,
  type HypagraphDraftRecord,
} from "./domain/draft.js";
import {
  addCheckToDraft,
  addTaskToDraft,
  declareLoopOnDraft,
  requireOnDraft,
} from "./domain/draft-constructors.js";
import {
  applyImplementParallelReviewRecipe,
  applyImplementVerifyLoopRecipe,
  buildParallelReviewChildTemplates,
  DEFAULT_PARALLEL_REVIEW_ROLES,
} from "./domain/draft-recipes.js";
import { HypagraphProjectStore, ProjectStoreError } from "./project-store/index.js";
import {
  HYPAGOAL_ARMED_STATUS_KEY,
  HYPAGOAL_ARMED_STATUS_TEXT,
  defaultHypagoalTriggerSettings,
  disableHypagoalTrigger,
  hypagoalArmedPromptBlock,
  messageArmsHypagoal,
  setHypagoalTriggerWord,
  type HypagoalTriggerSettings,
} from "./pi/hypagoal-arming.js";
import {
  registerHypagoalTriggerEditor,
  type HypagoalTriggerEditorHandle,
} from "./pi/hypagoal-trigger-editor.js";

import {
  formatDiagnostics,
  renderStatusPhaseLabel,
  renderWidget,
  renderWorkflow,
  workflowSummary,
} from "./ui/format.js";
import {
  appendFamilyStatusBlock,
  familyDispatchOccupancySummary,
  formatFamilyDispatchSurfaceLine,
  listFamilyPendingViews,
} from "./ui/family-surface.js";
import { renderHypagoalLifecycleMessage, renderHypagoalStatus } from "./ui/hypagoal-surface.js";
import {
  waitingLifecycleNote,
  waitingStatusLabel,
  waitingUnavailableNote,
} from "./ui/interaction-surface.js";
import {
  createWidgetAnimationDriver,
  widgetPhaseAnimates,
} from "./ui/widget-chrome.js";
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

/**
 * Present the post-create graph review in the composer / editor zone.
 *
 * Do not use a terminal bottom-center overlay. Bottom-anchored overlays sit at
 * the physical bottom of the screen, so a short chat history leaves a large
 * empty gap under the prompt. Replacing the editor places the dock where the
 * user already looks to type (just above the footer, at the prompt).
 */
const presentPostCreateDock = async (
  ctx: ExtensionContext,
  graphState: HypagraphState,
): Promise<PostCreateDockResult> => {
  try {
    return await ctx.ui.custom<PostCreateDockResult>(
      (tui, theme, _keybindings, done) => {
        const rows = tui.terminal?.rows;
        // Fit the dock to the editor stack: leave room for header/footer chrome.
        const maxContentLines = typeof rows === "number" && rows > 0
          ? Math.max(12, Math.min(28, rows - 6))
          : 20;
        const artMaxWidth = typeof tui.terminal?.columns === "number"
          ? Math.max(20, tui.terminal.columns - 4)
          : undefined;
        return new PostCreateDockComponent(
          tui,
          theme,
          graphState,
          done,
          {
            maxContentLines,
            ...(artMaxWidth === undefined ? {} : { artMaxWidth }),
          },
        );
      },
      // Editor zone (not floating overlay): sits at the prompt, not terminal bottom.
      { overlay: false },
    );
  } catch {
    // A failed custom UI must not destroy the goal. Safe default is Question.
    return { kind: "question" };
  }
};

/**
 * Present the rich interaction dialog in the editor / composer zone.
 *
 * Use editor replacement (overlay: false), not a bottom-anchored overlay.
 * Bottom overlays float over the chat area and leave a large empty gap when
 * chat history is short. Editor replacement places the ask under the live
 * graph widget, the same zone as the normal composer (see post-create dock).
 */
const presentInteractionDialog = async (
  ctx: ExtensionContext,
  interaction: InteractionDefinition,
): Promise<InteractionAnswer | undefined> => {
  const result = await ctx.ui.custom<InteractionDialogResult>(
    (tui, theme, _keybindings, done) => {
      const rows = tui.terminal?.rows;
      // Fit the editor stack: leave room for header, widget, and footer chrome.
      const maxContentLines = typeof rows === "number" && rows > 0
        ? Math.max(8, Math.min(20, rows - 8))
        : 12;
      return new InteractionDialogComponent(
        tui,
        theme,
        interaction,
        done,
        { maxContentLines },
      );
    },
    // Editor zone (not floating overlay): sits under the graph widget at the prompt.
    { overlay: false },
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
  "Usage: /hypagraph [help | status | pause | resume | cancel | ask | history | explain | loop | check | graph | executor | trigger | demo | reclaim-pending]",
  "  status                                     Show the goal status.",
  "  pause [reason] | resume | cancel [reason]  Control the active goal.",
  "  ask [<nodeId>]                             Present an open question again.",
  `  history [<sequence> | revisions | <lane>]  Read the event timeline.`,
  `                                             A lane is ${TIMELINE_LANES.join(", ")}.`,
  "  explain [<nodeId>]                         Explain why work is not runnable.",
  "  loop                                       Show bounded iteration regions.",
  "  check active | check cancel [<nodeId>]     Inspect or stop a running check.",
  "  graph [open | close | toggle | full | focus | member <goalId>]",
  "                                             Live graph: widget (compact), dock (open), full modal (ctrl+shift+g).",
  "  executor [status | probe | cancel]         Isolated Pi host status, probe, or cancel.",
  "  reclaim-pending [<dispatchId>...]          Interrupt stranded family pendings (all or named).",
  "  trigger set <word> | trigger off | trigger Show or change Hypagoal arming.",
  "                                             The trigger word highlights in the composer while you type.",
  "  demo [list | <id>]                         Start a built-in graph (or showcase tour of all graphs).",
  "                                             Ids: showcase (tour), basic, loop, fanout, parallel, pipeline, rich.",
  "  (no argument)                              Show the workflow.",
  "Create a goal with /hypagoal <objective> or the configured trigger word.",
  "Load this extension with: pi -e ./extensions/hypagraph.ts --skill ./skills",
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
  family?: FamilyGraphViewModel,
  options: {
    frameIndex?: number;
    skipGraph?: boolean;
    diagramLines?: readonly string[];
    /** When false, title only — used while the post-create dock already shows a graph. */
    includeDiagram?: boolean;
  } = {},
): void {
  // Optional interactive overlay dock (opened only via /hypagraph graph).
  // Product live graph sits in the above-composer widget, not below the input.
  if (!options.skipGraph) {
    if (family === undefined) {
      graphPane.updateFamily(undefined);
    }
    graphPane.update(state);
    if (family !== undefined) {
      graphPane.updateFamily(family);
    }
  }
  if (!state) {
    ctx.ui.setStatus("hypagraph", undefined);
    ctx.ui.setWidget("hypagraph", undefined);
    return;
  }
  const frameIndex = options.frameIndex ?? 0;
  const active = activeNode(state);
  const waiting = waitingStatusLabel(state);
  const readyCount = readyNodeIds(state).length;
  const work = active?.id ?? `${readyCount} ready`;
  // Keep the wait visible in the status bar. Independent ready work stays named
  // beside it, so a human gate never looks like a full goal stop.
  const childWait = family && family.bindings.some((binding) => binding.status === "active")
    ? " | child wait"
    : "";
  const phaseChip = renderStatusPhaseLabel(state.phase, frameIndex);
  const status = waiting === undefined
    ? `HG ${phaseChip}: ${work}${childWait}`
    : `HG ${phaseChip}: ${waiting}${readyCount > 0 || active ? ` | ${work}` : ""}${childWait}`;
  ctx.ui.setStatus("hypagraph", status);
  // Widget = compact title + live horizontal graph above the composer.
  // Suppress diagram while post-create (or another graph dock) already paints one.
  const terminalColumns = (ctx as { ui?: { terminal?: { columns?: number } } }).ui?.terminal?.columns
    ?? (ctx as { terminal?: { columns?: number } }).terminal?.columns;
  const maxWidth = typeof terminalColumns === "number" && terminalColumns > 0
    ? Math.max(40, terminalColumns - 2)
    : 100;
  const includeDiagram = options.includeDiagram !== false;
  // Component factory receives Theme so compact art can colour active / done nodes.
  ctx.ui.setWidget("hypagraph", (_tui, theme) => {
    const lines = renderWidget(state, family, {
      frameIndex,
      maxWidth,
      includeDiagram,
      theme,
      ...(options.diagramLines === undefined ? {} : { diagramLines: options.diagramLines }),
    });
    return {
      render: () => lines,
      invalidate: () => {},
    };
  });
}

interface PendingHypagoalAuthoring {
  objective: string;
  creationRequest: HypagoalCreationRequest;
  replacementConfirmation?: ReturnType<typeof replacementConfirmationFor>;
}

export default function hypagraphExtension(pi: ExtensionAPI): void {
  /**
   * Live desk root workflow authority for session persistence.
   * Non-root member dispatch uses MemberContext and must not swap these
   * globals as the only working set (Seam A / S3).
   */
  let state: HypagraphState | undefined;
  let events: DomainEvent[] = [];
  let sessionGeneration = 0;
  let branchGeneration = 0;
  /** One session bag per extension instance (Seam A). */
  let sessionContext: SessionContext = createSessionContext({
    sessionGeneration: 0,
    branchGeneration: 0,
  });
  let hypagoalAuthoring: PendingHypagoalAuthoring | undefined;
  let pendingContinuation: PendingGoalContinuation | undefined;
  let deliveredContinuation: PendingGoalContinuation | undefined;
  let suppressContinuationAtNextAgentEnd = false;
  let staleContinuationTurn = false;
  let continuationToolsBeforeDelivery: string[] | undefined;
  let revisionProposalHandled = false;
  /** Trigger-word arming for the current user turn only. Not canonical state. */
  let hypagoalArmedForTurn = false;
  /** In-session trigger settings. Slice 1 keeps settings in memory. */
  let hypagoalTriggerSettings: HypagoalTriggerSettings = defaultHypagoalTriggerSettings();
  /** Live composer highlight handle. Interactive TUI only. Paint only. */
  let hypagoalTriggerEditor: HypagoalTriggerEditorHandle | undefined;
  /** Braille / gold phase animation for the above-editor hypagraph widget. */
  let widgetFrameIndex = 0;
  const widgetAnimation = createWidgetAnimationDriver();
  /** Latest UI context for animation ticks (set on each paintUi). */
  let widgetPaintCtx: ExtensionContext | undefined;
  /**
   * Interactive post-create Run gate (host-only; not canonical domain state).
   *
   * When true, queueGoalContinuation no-ops until Run.
   * Set after a successful interactive TUI create, and re-armed on restore when
   * the goal has never dispatched a node.
   */
  let postCreateAwaitingUserChoice = false;
  /**
   * True after the post-create dock was presented for the current gate.
   *
   * Prevents re-opening the dock on every agent_end after Question.
   * Resume re-opens the dock when no work has started yet.
   */
  let postCreateDockPresented = false;
  /**
   * Workflow id for which the live graph dock was already auto-opened.
   * Prevents re-open after the user closes the dock (q or /hypagraph graph close).
   */
  let liveGraphOpenedForWorkflowId: string | undefined;
  /**
   * Workflow id for which the user closed the live graph dock on purpose.
   * Cleared on explicit /hypagraph graph open or a new workflow.
   */
  let liveGraphSuppressedWorkflowId: string | undefined;
  /**
   * When true, hold between deterministic check/gate steps so the live graph
   * is readable. Set only by `/hypagraph demo`. Cleared on ordinary create.
   */
  let demoPacingEnabled = false;
  /**
   * Multi-graph showcase tour. When set, after each tour member finishes the
   * host starts the next catalog graph (auto-run, no second post-create dock).
   */
  let demoTour: { ids: readonly string[]; index: number } | undefined;
  /**
   * Multi-worker pool of in-flight isolated model attempts (S4).
   * Lives on SessionContext.workerPool. Capacity is resolved globalConcurrency.
   */
  const isolatedWorkerPool = (): Map<string, ActiveIsolatedRootAttempt> =>
    sessionContext.workerPool;
  /**
   * Serializes free-slot start and settle critical sections so concurrent
   * isolated workers do not clobber free host state (S4 free-slot remnant).
   */
  let isolatedFreeSlotChain: Promise<void> = Promise.resolve();
  const withIsolatedFreeSlotLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = isolatedFreeSlotChain;
    isolatedFreeSlotChain = previous.then(() => gate);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
  /**
   * Latest family record known to the host (create, controller load, persist, return).
   * session_shutdown has no branch ctx; cancel uses this for non-root settle (R3).
   */
  let latestFamilyRecord: PersistedGoalFamily | undefined;
  /**
   * Whether the last successful create wrote project-store definition artifacts.
   * Undefined when no create has occurred in this session generation.
   */
  let projectStoreArtifactWritten: boolean | undefined;
  /** Latest child project-store write result from hypagoal_create_child (host memory). */
  let childProjectStoreArtifactWritten: boolean | undefined;
  let childProjectStoreWorkflowId: string | undefined;
  /**
   * Depth of open free-slot binds (root or non-root).
   * Temporary single-seat bridge for nested helpers (S3).
   */
  let liveSlotBindDepth = 0;
  /**
   * Depth of open non-root free-slot binds.
   * While greater than zero, free slots hold a child working set.
   * queueGoalContinuation and rootMemberContext must not treat free slots as desk root.
   */
  let nonRootLiveSlotBindDepth = 0;
  /**
   * Workflow ids whose member stream was already written to the family bag under
   * the free-slot lock by the isolated settle path (S4 Issue 6).
   * Post-dispatch persistNonRootMemberUpdate must skip these to avoid clobber.
   */
  const isolatedFamilyPersistedWorkflowIds = new Set<string>();

  /**
   * Keep mid-flight cancel mirrors on unsettled isolated attempts (R3 / S4).
   * Updates every pool entry whose workflow matches free host state.
   */
  const mirrorActiveIsolatedCancelState = (): void => {
    if (!state) return;
    for (const active of listUnsettledIsolatedWorkers(isolatedWorkerPool())) {
      if (state.workflowId !== active.workflowId) continue;
      active.cancelSnapshot = structuredClone(state);
      active.cancelEvents = structuredClone(events);
    }
  };

  /** Clear free host family cache and session bag family slot together. */
  const clearFamilyRecord = (): void => {
    latestFamilyRecord = undefined;
    setSessionFamilyRecord(sessionContext, undefined);
  };

  const rememberFamilyRecord = (family: PersistedGoalFamily | undefined): void => {
    if (!family) {
      clearFamilyRecord();
      return;
    }
    latestFamilyRecord = family;
    setSessionFamilyRecord(sessionContext, family);
  };

  /**
   * Build a MemberContext for the live desk root.
   * Returns undefined when no root goal is live, when a non-root free-slot
   * bind is active, or when free state is not the recorded desk root.
   */
  const rootMemberContext = (): MemberContext | undefined => {
    if (!state?.goal) return undefined;
    if (nonRootLiveSlotBindDepth > 0) return undefined;
    const rootId = sessionContext.rootWorkflowId;
    if (rootId !== undefined && state.workflowId !== rootId) return undefined;
    const member = attachRootMember(sessionContext, {
      workflowId: state.workflowId,
      goalId: state.goal.goalId,
      state,
      events,
    });
    if (!member.isLiveRoot) return undefined;
    return member;
  };

  /**
   * Install a MemberContext into free host slots for nested helpers that still
   * close over state/events. MemberContext remains the dispatch authority.
   * Non-root install saves the live root and restores it on release only when
   * session generations still match the bind capture (restore-safe).
   */
  const bindMemberLiveSlots = (member: MemberContext): { release: () => void } => {
    if (member.isLiveRoot) {
      const slots = liveSlotsFromMember(member);
      state = slots.state;
      events = slots.events;
      liveSlotBindDepth += 1;
      return {
        release: () => {
          syncMemberFromLiveSlots(member, { state, events });
          // Live root free slots remain the session root authority.
          state = member.state;
          events = member.events;
          liveSlotBindDepth = Math.max(0, liveSlotBindDepth - 1);
        },
      };
    }
    const savedRootState = state;
    const savedRootEvents = events;
    const bindSessionGeneration = sessionGeneration;
    const bindBranchGeneration = branchGeneration;
    const slots = liveSlotsFromMember(member);
    state = slots.state;
    events = slots.events;
    liveSlotBindDepth += 1;
    nonRootLiveSlotBindDepth += 1;
    return {
      release: () => {
        const resolved = resolveLiveSlotRelease({
          memberWorkflowId: member.workflowId,
          memberState: member.state,
          memberEvents: member.events,
          freeState: state,
          freeEvents: events,
          savedRootState,
          savedRootEvents,
          bindSessionGeneration,
          bindBranchGeneration,
          currentSessionGeneration: sessionGeneration,
          currentBranchGeneration: branchGeneration,
        });
        member.state = resolved.nextMemberState;
        member.events = resolved.nextMemberEvents;
        state = resolved.nextFreeState;
        events = resolved.nextFreeEvents;
        liveSlotBindDepth = Math.max(0, liveSlotBindDepth - 1);
        nonRootLiveSlotBindDepth = Math.max(0, nonRootLiveSlotBindDepth - 1);
      },
    };
  };

  const clearPostCreateGate = (): void => {
    postCreateAwaitingUserChoice = false;
    postCreateDockPresented = false;
  };

  const rearmPostCreateGateIfNeeded = (): void => {
    if (shouldReopenPostCreateGate(state)) {
      postCreateAwaitingUserChoice = true;
      postCreateDockPresented = false;
      return;
    }
    clearPostCreateGate();
  };

  /** Abort every unsettled isolated worker in the pool (S4). */
  const abortActiveIsolatedRootAttempt = (reason: string): void => {
    abortAllUnsettledIsolatedWorkers(isolatedWorkerPool(), reason);
  };

  /**
   * Cancel a tracked isolated attempt on the member workflow that owns it.
   * Prefer mid-flight cancelSnapshot (family may lag until after dispatch finally).
   * Always persist non-root cancels into the family record when a family is available.
   */
  const settleTrackedIsolatedAttempt = async (input: {
    tracked: ActiveIsolatedRootAttempt;
    reason: string;
    correlationId: string;
    store?: ReturnType<typeof eventStore.lease>;
    family?: PersistedGoalFamily;
    notify?: (message: string, level: "info" | "warning") => void;
  }): Promise<boolean> => {
    const { tracked, reason, correlationId } = input;
    const store = input.store ?? eventStore.lease();
    const notify = input.notify;
    const family = input.family ?? latestFamilyRecord;
    const memberStream = family?.workflows[tracked.workflowId];

    // Prefer host cancel mirrors, then live host when it still owns the member, then family.
    let cancelState: HypagraphState | undefined = tracked.cancelSnapshot;
    let cancelEvents: DomainEvent[] | undefined = tracked.cancelEvents
      ? structuredClone(tracked.cancelEvents)
      : undefined;
    if (!cancelState && state && state.workflowId === tracked.workflowId) {
      cancelState = state;
      cancelEvents = structuredClone(events);
    }
    if (!cancelState && memberStream) {
      cancelState = memberStream.snapshot;
      cancelEvents = structuredClone(memberStream.events);
    }
    if (!cancelState) {
      notify?.(
        `Hypagraph could not cancel member worker '${tracked.nodeId}' on goal '${tracked.goalId}': member stream is unavailable.`,
        "warning",
      );
      return false;
    }

    const cancelCommands = buildOrphanedTaskCancelCommands({
      state: cancelState,
      at: new Date().toISOString(),
      reason,
      correlationId,
      only: { nodeId: tracked.nodeId, attemptId: tracked.attemptId },
    });
    // When mirrors lag, still emit cancel-attempt from tracked identity if runtime shows active.
    // If the snapshot has no matching attempt, try a direct cancel command once.
    const commands = cancelCommands.length > 0
      ? cancelCommands
      : [{
        type: "cancel-attempt" as const,
        nodeId: tracked.nodeId,
        attemptId: tracked.attemptId,
        reason,
        commandId: `${correlationId}:cancel:${tracked.nodeId}:${tracked.attemptId}`,
        correlationId,
        at: new Date().toISOString(),
      }];

    eventStore.noteWorkflowSequence(tracked.workflowId, cancelState.sequence);
    const cancelled = await applyCommandsAndCommit(store, cancelState, commands);
    if (!cancelled.ok) {
      notify?.(
        `Hypagraph could not cancel isolated task '${tracked.nodeId}' on member '${tracked.goalId}'.\n${formatDiagnostics(cancelled.diagnostics)}`,
        "warning",
      );
      return false;
    }

    const nextEvents = [
      ...(cancelEvents ?? []),
      ...cancelled.value.events,
    ];
    const nextMemberState = cancelled.value.state;

    // Update live host when it still holds this member workflow (mid-swap or live root).
    if (state && state.workflowId === tracked.workflowId) {
      state = nextMemberState;
      events = nextEvents;
    }

    // Persist into family whenever the member is part of a known family record.
    if (family && family.workflows[tracked.workflowId]) {
      let nextFamily = replaceFamilyMemberWorkflow(family, tracked.workflowId, {
        events: nextEvents,
        snapshot: nextMemberState,
      });
      // Merge live root so sibling progress is not overwritten (R5).
      if (state && state.workflowId !== tracked.workflowId) {
        nextFamily = mergeLiveRootIntoFamily(nextFamily, {
          workflowId: state.workflowId,
          events,
          snapshot: state,
        });
      }
      appendOneMemberFamilyRecord(pi, nextFamily);
      rememberFamilyRecord(nextFamily);
    } else if (family) {
      // Family exists but member stream missing: still write member after cancel.
      let nextFamily: PersistedGoalFamily = {
        ...family,
        workflows: {
          ...family.workflows,
          [tracked.workflowId]: {
            events: nextEvents,
            snapshot: nextMemberState,
          },
        },
      };
      if (state && state.workflowId !== tracked.workflowId) {
        nextFamily = mergeLiveRootIntoFamily(nextFamily, {
          workflowId: state.workflowId,
          events,
          snapshot: state,
        });
      }
      appendOneMemberFamilyRecord(pi, nextFamily);
      rememberFamilyRecord(nextFamily);
    }

    // Mark the tracked attempt settled so an in-flight dispatchIsolatedRootModelTask
    // does not apply a second settlement after user cancel or restore (R3).
    tracked.settled = true;
    const poolEntry = findIsolatedWorkerByAttemptId(isolatedWorkerPool(), tracked.attemptId);
    if (poolEntry) {
      poolEntry.settled = true;
    }

    // Clear the matching family pending so orphan cancel frees occupancy (S2).
    if (tracked.familyDispatchId) {
      settleFamilyDispatchById(tracked.familyDispatchId, "interrupted", reason);
    }

    notify?.(
      `Hypagraph cancelled isolated task '${tracked.nodeId}' on member '${tracked.goalId}'.`,
      "warning",
    );
    return true;
  };

  const clearHypagoalArming = (ctx?: ExtensionContext): void => {
    hypagoalArmedForTurn = false;
    ctx?.ui.setStatus(HYPAGOAL_ARMED_STATUS_KEY, undefined);
  };

  const paintHypagoalArmingStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      HYPAGOAL_ARMED_STATUS_KEY,
      hypagoalArmedForTurn ? HYPAGOAL_ARMED_STATUS_TEXT : undefined,
    );
  };

  const describeTriggerSettings = (): string => {
    if (hypagoalTriggerSettings.word === null) {
      return "Hypagoal arming is off.";
    }
    return `Hypagoal trigger word: ${hypagoalTriggerSettings.word}`;
  };
  const graphPane = new GraphPaneController(() => events);
  const eventStore = new PiSessionWorkflowEventStore(pi);
  const activeExecutions = new ActiveCheckExecutionRegistry();
  const activeCodeExecutions = new ActiveCodeExecutionRegistry();
  const activeEffectExecutions = new ActiveEffectExecutionRegistry();
  const memoryEffectHost = new MemoryEffectHost();
  /** In-flight presentation effects keyed by workflow, node, and attempt. */
  const activePresentations = new Map<string, Promise<"ready" | "failed" | "unavailable">>();

  /**
   * Isolated Pi, ACP, and CLI host controller (m7-s8 / m9-s1 / m9-s2).
   * Owns the process registry, default executor, dispatch seam, and restore teardown.
   * Until M8 worktrees, checkout key and cwd both use process.cwd() so concurrent
   * same-checkout mutation is blocked.
   * Nested graph UI for profile selection is m7-s9.
   *
   * ACP options bind a shared AcpSessionRegistry so /hypagraph executor cancel and
   * session restore can close in-flight ACP sessions. Product ACP dispatch requires
   * profile.kind === "acp" and a configured agent binary (ACP_AGENT_BIN).
   * Default promptTimeoutMs is finite (DEFAULT_ACP_PROMPT_TIMEOUT_MS) so hung turns
   * do not run without a wall-clock bound.
   *
   * CLI options bind a shared CliProcessRegistry for named direct CLI adapters.
   * Product CLI dispatch requires profile.kind === "cli" and a configured named
   * adapter binary (for example HYPAGRAPH_CLI_JSON_BIN). Arbitrary shell commands
   * are not strict mutating executors. Default timeout is finite (DEFAULT_CLI_TIMEOUT_MS).
   */
  const isolatedPiCheckoutCwd = (): string => process.cwd();
  const hostStartedAt = (): string => new Date().toISOString();
  const isolatedPiHost: IsolatedPiHost = createIsolatedPiHost({
    transport: createChildProcessIsolatedPiTransport(),
    resolveCwd: () => isolatedPiCheckoutCwd(),
    resolveCheckoutKey: () => isolatedPiCheckoutCwd(),
    startedAt: hostStartedAt,
    createCurrentSession: () => createCurrentSessionExecutor(async () => {
      throw new Error(
        "Current-session NodeExecutor requires a result source. "
        + "Use routeLiveTaskCompletion for live session completion.",
      );
    }),
    // M9-s1: ACP client adapter seam. Registry is host-owned for cancel/teardown.
    acp: {
      transport: createChildProcessAcpTransport({
        // Missing ACP_AGENT_BIN fails openSession with a clear diagnostic when used.
        requireBinary: true,
        promptTimeoutMs: DEFAULT_ACP_PROMPT_TIMEOUT_MS,
      }),
      resolveCwd: () => isolatedPiCheckoutCwd(),
      startedAt: hostStartedAt,
      promptTimeoutMs: DEFAULT_ACP_PROMPT_TIMEOUT_MS,
    },
    // M9-s2: named direct CLI adapter seam. Registry is host-owned for cancel/teardown.
    cli: {
      transport: createChildProcessCliTransport({
        // Missing HYPAGRAPH_CLI_JSON_BIN fails with a clear diagnostic when used.
        requireBinary: true,
      }),
      resolveCwd: () => isolatedPiCheckoutCwd(),
      startedAt: hostStartedAt,
      timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
    },
  });
  // Bind the product session host so dispatchIsolatedPiAttempt reaches this instance.
  bindActiveIsolatedPiHost(isolatedPiHost);

  /**
   * Product controller surface for isolated Pi (same host restore uses).
   * Controllers call dispatch when profile.kind is isolated-pi.
   */
  const isolatedPiController = {
    host: isolatedPiHost,
    dispatchAttempt: dispatchIsolatedPiAttempt,
    hasActiveProcesses: () => isolatedPiHost.hasActiveProcesses(),
    activeProcessCount: () => isolatedPiHost.activeProcessCount(),
    teardownOnRestore: (input: { reason: string; kind: "restore" | "branch" | "user" | "other" }) =>
      isolatedPiHost.teardownOnRestore(input),
  };

  /** Pure host snapshot for family executor UI. Does not spawn processes. */
  const executorHostSnapshot = (): FamilyExecutorHostSnapshot => ({
    kind: ISOLATED_PI_PROFILE.kind,
    executorId: isolatedPiController.host.executor.id,
    profileKind: ISOLATED_PI_PROFILE.kind,
    activeProcessCount: isolatedPiController.activeProcessCount(),
  });

  /**
   * Resolve family projection for product UI from an existing family record.
   * Does not migrate or append on paint paths. Session restore still migrates
   * one-member roots. Requires the live goal to be a family member; a replaced
   * root with a previous family record yields no family chrome.
   */
  const resolveFamilyView = (ctx: ExtensionContext): FamilyGraphViewModel | undefined => {
    if (!state?.goal) return undefined;
    try {
      const familyRecord = restoreLatestFamilySession(ctx.sessionManager.getBranch());
      if (!familyRecord) return undefined;
      // Match check lives in projectProductFamilyView; mismatched roots return undefined.
      return projectProductFamilyView(
        familyRecord,
        state,
        executorHostSnapshot(),
      );
    } catch {
      return undefined;
    }
  };

  /**
   * Whether the above-composer widget should include Mermaid art.
   *
   * Hide the widget diagram while post-create already shows a graph, and while
   * the optional expanded graph dock is open, so the user never sees two graphs.
   */
  const widgetShouldIncludeDiagram = (): boolean => {
    if (postCreateAwaitingUserChoice) return false;
    if (graphPane.isOpen) return false;
    return true;
  };

  /** Update status and the above-composer widget (title + live graph). */
  const paintUi = (ctx: ExtensionContext): void => {
    widgetPaintCtx = ctx;
    const family = resolveFamilyView(ctx);
    const includeDiagram = widgetShouldIncludeDiagram();
    updateUi(state, ctx, graphPane, family, {
      frameIndex: widgetFrameIndex,
      includeDiagram,
    });
    widgetAnimation.setPainter(() => {
      if (!widgetPaintCtx || !state) {
        widgetAnimation.sync(false);
        return;
      }
      widgetFrameIndex += 1;
      // Animation ticks only repaint badges; Mermaid art is cached by sequence.
      updateUi(
        state,
        widgetPaintCtx,
        graphPane,
        resolveFamilyView(widgetPaintCtx),
        {
          frameIndex: widgetFrameIndex,
          skipGraph: true,
          includeDiagram: widgetShouldIncludeDiagram(),
        },
      );
    });
    widgetAnimation.sync(state ? widgetPhaseAnimates(state.phase) : false);
  };

  const presentationExecutionKey = (workflowId: string, nodeId: string, attemptId: string): string =>
    `${workflowId}\u0000${nodeId}\u0000${attemptId}`;

  const persisted = (): PersistedHypagraph => ({ events: structuredClone(events), snapshot: structuredClone(state!) });
  const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: { hypagraph: persisted() } });

  /**
   * Host executions that block create-child and general workflow mutation.
   * Checks, code, effects, and interaction presentations only.
   * Does not include isolated model workers (create-child uses a same-node guard instead).
   */
  const activeHostExecutionBlockReason = (purpose: "child create" | "another workflow change"): string | undefined => {
    if (activeExecutions.hasActive()) {
      return `A check is active. Cancel it or let it finish before ${purpose}.`;
    }
    if (activeCodeExecutions.hasActive()) {
      return `A code node is active. Cancel it or let it finish before ${purpose}.`;
    }
    if (activeEffectExecutions.hasActive()) {
      return `An effect node is active. Cancel it or let it finish before ${purpose}.`;
    }
    if (activePresentations.size > 0) {
      return `An interaction presentation is active. Wait for it to finish before ${purpose}.`;
    }
    return undefined;
  };

  const ensureNoActiveExecution = (): void => {
    const hostBlock = activeHostExecutionBlockReason("another workflow change");
    if (hostBlock) throw new Error(hostBlock);
    const unsettledWorkers = listUnsettledIsolatedWorkers(isolatedWorkerPool());
    if (unsettledWorkers.length > 0) {
      const first = unsettledWorkers[0]!;
      const countLabel = unsettledWorkers.length === 1
        ? "An isolated model worker"
        : `${unsettledWorkers.length} isolated model workers`;
      throw new Error(
        `${countLabel} in flight (example: node '${first.nodeId}', `
        + `attempt '${first.attemptId}'). `
        + "Use /hypagraph executor cancel to stop them, or let them finish before another workflow change.",
      );
    }
    if (isolatedPiController.hasActiveProcesses()) {
      const piCount = isolatedPiController.host.registry.activeCount();
      const acpCount = isolatedPiController.host.acpRegistry?.activeCount() ?? 0;
      const cliCount = isolatedPiController.host.cliRegistry?.activeCount() ?? 0;
      const parts: string[] = [];
      if (piCount > 0) {
        parts.push(`${piCount} isolated Pi attempt(s)`);
      }
      if (acpCount > 0) {
        parts.push(`${acpCount} ACP session(s)`);
      }
      if (cliCount > 0) {
        parts.push(`${cliCount} CLI process(es)`);
      }
      const label = parts.length > 0 ? parts.join(" and ") : "executor attempt(s)";
      throw new Error(
        `An active executor is running (${label}). `
        + "Use /hypagraph executor cancel to stop it, or let it finish before another workflow change.",
      );
    }
  };

  const restoreContinuationTools = (): void => {
    if (!continuationToolsBeforeDelivery) return;
    pi.setActiveTools(continuationToolsBeforeDelivery);
    continuationToolsBeforeDelivery = undefined;
  };

  const restore = async (ctx: ExtensionContext, branchChanged: boolean): Promise<void> => {
    // Session bag owns generation bumps; free counters stay aligned (Seam A).
    bumpSessionGenerations(sessionContext, { branchChanged });
    sessionGeneration = sessionContext.sessionGeneration;
    branchGeneration = sessionContext.branchGeneration;
    if (branchChanged) {
      clearFamilyRecord();
    }
    hypagoalAuthoring = undefined;
    pendingContinuation = undefined;
    deliveredContinuation = undefined;
    suppressContinuationAtNextAgentEnd = false;
    staleContinuationTurn = false;
    revisionProposalHandled = false;
    restoreContinuationTools();
    // Drop in-flight worker pool bookkeeping. Abort, teardown, and cancel follow.
    // Deep-clone cancel mirrors before clearing so mid-flight child settle still works (R3 / S4).
    const orphanedRootAttempts = listUnsettledIsolatedWorkers(isolatedWorkerPool())
      .map((entry) => cloneActiveIsolatedForTeardown(entry));
    abortActiveIsolatedRootAttempt(
      branchChanged
        ? "The Pi session branch changed before the isolated worker completed."
        : "The Pi session reloaded before the isolated worker completed.",
    );
    clearIsolatedWorkerPool(isolatedWorkerPool());
    activeExecutions.cancelAll("The Pi session branch changed.");
    activeCodeExecutions.cancelAll("The Pi session branch changed.");
    activeEffectExecutions.cancelAll("The Pi session branch changed.");
    // Reclaim owned isolated Pi processes after host restart or branch change.
    // Child session files are optional continuity only. Canonical context remains
    // on the domain side. The product dispatch seam (dispatchIsolatedPiAttempt)
    // uses this same host registry and controller.
    bindActiveIsolatedPiHost(isolatedPiHost);
    const isolatedTeardown = await isolatedPiController.teardownOnRestore(
      branchChanged
        ? {
          kind: "branch",
          reason: "The Pi session branch changed before the executor attempt completed.",
        }
        : {
          kind: "restore",
          reason: "The Pi session reloaded before the executor attempt completed.",
        },
    );
    const piClosed = isolatedTeardown.terminatedCount;
    const acpClosed = isolatedTeardown.acpClosedCount ?? 0;
    const cliClosed = isolatedTeardown.cliClosedCount ?? 0;
    if (piClosed > 0 || acpClosed > 0 || cliClosed > 0) {
      const parts: string[] = [];
      if (piClosed > 0) {
        parts.push(`${piClosed} isolated Pi process(es)`);
      }
      if (acpClosed > 0) {
        parts.push(`${acpClosed} ACP session(s)`);
      }
      if (cliClosed > 0) {
        parts.push(`${cliClosed} CLI process(es)`);
      }
      const when = branchChanged ? "branch change" : "session restore";
      ctx.ui.notify(
        `Hypagraph terminated ${parts.join(" and ")} on ${when}.`,
        "warning",
      );
    }
    const branch = ctx.sessionManager.getBranch();
    const session = restoreLatestSession(branch);
    eventStore.synchronize(session);
    state = session?.snapshot;
    events = session?.events ?? [];
    setSessionRootWorkflowId(sessionContext, state?.workflowId);
    // Migrate a restored v0.6 root into a one-member family when no family record exists.
    // Append is additive. Prior workflow event batches are not rewritten.
    const familyProjection = restoreOrMigrateOneMemberFamilySession(branch);
    if (familyProjection?.migrated) {
      appendOneMemberFamilyRecord(pi, familyProjection.family);
    }
    // Prefer branch-local family for restore and branch-change settle/sweep (S2).
    // Branch change already cleared host family memory above.
    const branchSessionFamily = familyProjection?.family
      ?? restoreLatestFamilySession(branch);
    if (branchSessionFamily) {
      rememberFamilyRecord(branchSessionFamily);
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
      // Cancel each tracked member attempt when isolated workers were torn down (S4 pool).
      // Uses goalId/workflowId so child workers settle into the family record (R3).
      // familyDispatchId on the attempt also clears the matching family pending (S2).
      if (orphanedRootAttempts.length > 0) {
        const orphanReason = branchChanged
          ? "The Pi branch changed before the isolated model worker completed."
          : "The Pi session reloaded before the isolated model worker completed.";
        // Same branch-local precedence as pending sweep (S2 Issue 1).
        const familyForCancel = resolveFamilyRecordForPendingSweep({
          ...(familyProjection?.family === undefined
            ? {}
            : { familyProjection: familyProjection.family }),
          ...(branchSessionFamily === undefined
            ? {}
            : { branchSessionFamily }),
          ...(latestFamilyRecord === undefined
            ? {}
            : { hostLatestFamily: latestFamilyRecord }),
        });
        if (familyForCancel) rememberFamilyRecord(familyForCancel);
        for (const orphanedRootAttempt of orphanedRootAttempts) {
          const orphanCorrelation =
            `isolated-root-orphan:${branchChanged ? "branch" : "restore"}:${randomUUID()}`;
          await settleTrackedIsolatedAttempt({
            tracked: orphanedRootAttempt,
            reason: orphanReason,
            correlationId: orphanCorrelation,
            store: recoveryStore,
            ...(familyForCancel === undefined ? {} : { family: familyForCancel }),
            notify: (message, level) => ctx.ui.notify(message, level),
          });
        }
      }
      // Sweep stranded family pendings on reload and branch change (S2).
      // Mirrors interruptPendingActionDispatchAndCommit for multi-pending occupancy.
      // After orphan settle, prefer post-orphan host/session family. Do not reuse
      // pre-orphan familyProjection / branchSessionFamily captures: orphan settle
      // may have updated workflows and cleared familyDispatchId (S2 Issue 9).
      const reloadedBranchFamilyAfterOrphan = restoreLatestFamilySession(branch);
      const familyForPendingSweep = resolveFamilyRecordForPostOrphanPendingSweep({
        ...(latestFamilyRecord === undefined
          ? {}
          : { postOrphanHostFamily: latestFamilyRecord }),
        ...(reloadedBranchFamilyAfterOrphan === undefined
          ? {}
          : { reloadedBranchFamily: reloadedBranchFamilyAfterOrphan }),
      });
      if (familyForPendingSweep) {
        const pendingSweepReason = branchChanged
          ? "The Pi branch changed before family pending dispatches completed."
          : "The Pi session reloaded before family pending dispatches completed.";
        const swept = interruptAllFamilyPendingsForHost({
          family: familyForPendingSweep.familySnapshot,
          at: new Date().toISOString(),
          reason: pendingSweepReason,
        });
        if (swept.ok && swept.interruptedDispatchIds.length > 0) {
          persistFamilySnapshotUpdate(
            familyForPendingSweep,
            swept.family,
            swept.events,
          );
          const closedCount = swept.interruptedDispatchIds.length;
          const closedLabel = closedCount === 1
            ? "1 interrupted family pending dispatch"
            : `${closedCount} interrupted family pending dispatches`;
          ctx.ui.notify(
            `Hypagraph closed ${closedLabel}: `
            + `${swept.interruptedDispatchIds.join(", ")}.`,
            "warning",
          );
        } else if (!swept.ok) {
          ctx.ui.notify(
            `Hypagraph could not close interrupted family pending dispatches.\n`
            + formatDiagnostics(swept.diagnostics),
            "warning",
          );
        }
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
    // Re-arm the post-create gate when the goal has never dispatched a node.
    // This keeps Question + reload from silently becoming free auto-run after resume.
    rearmPostCreateGateIfNeeded();
    if (postCreateAwaitingUserChoice) {
      ctx.ui.notify(
        "Hypagoal is waiting for a first Run decision. After resume, the graph review dock opens again. Choose Run to start work.",
        "info",
      );
    }
    paintUi(ctx);
  };

  const runCommands = async (commands: readonly HypagraphCommand[]): Promise<void> => {
    if (!state) throw new Error("There is no active Hypagraph. Call hypagoal_start first.");
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
    // Full graph modal covers the composer. Close it so the ask dock is usable.
    // Demo re-opens the modal after the answer when pacing is still on.
    const reopenDemoGraph = demoPacingEnabled
      && graphPane.isOpen
      && graphPane.presentationForTest === "modal";
    if (graphPane.isOpen && graphPane.presentationForTest === "modal") {
      graphPane.close();
    }
    const { interaction } = awaiting;
    let answer: InteractionAnswer | undefined;
    try {
      answer = ctx.mode === "tui"
        ? await presentInteractionDialog(ctx, interaction)
        : await presentInteractionSelect(ctx, interaction);
    } finally {
      if (reopenDemoGraph && demoPacingEnabled && state?.goal?.status === "active" && ctx.mode === "tui") {
        liveGraphSuppressedWorkflowId = undefined;
        if (state) liveGraphOpenedForWorkflowId = state.workflowId;
        graphPane.openFull(ctx);
      }
    }
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

  /**
   * Family multi-pending settle bound after persistFamilySnapshotUpdate exists.
   * Callers pass optional ctx so the latest session family can be reloaded.
   */
  let settleFamilyDispatchById: (
    dispatchId: string | undefined,
    outcome: "completed" | "failed" | "interrupted",
    reason?: string,
    ctx?: ExtensionContext,
  ) => void = () => {};

  const abandonPendingContinuation = async (
    reason: string,
    options?: { familyDispatchId?: string; ctx?: ExtensionContext },
  ): Promise<void> => {
    // Callers that clear pendingContinuation first must pass familyDispatchId.
    const familyDispatchId = options?.familyDispatchId
      ?? pendingContinuation?.familyDispatchId
      ?? deliveredContinuation?.familyDispatchId;
    const canonical = state?.goal?.pendingContinuation;
    if (!state?.goal || !canonical) {
      settleFamilyDispatchById(familyDispatchId, "interrupted", reason, options?.ctx);
      return;
    }
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
      settleFamilyDispatchById(familyDispatchId, "interrupted", reason, options?.ctx);
      return;
    }
    // Keep the durable request visible. A later recovery path must clear it.
    // Still interrupt the family pending so multi-pending capacity is not stranded.
    settleFamilyDispatchById(familyDispatchId, "interrupted", reason, options?.ctx);
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
    // Capture family dispatch id before clearing in-memory bookkeeping.
    const familyDispatchId = pendingContinuation?.familyDispatchId;
    pendingContinuation = undefined;
    await abandonPendingContinuation(reason, {
      ctx,
      ...(familyDispatchId !== undefined ? { familyDispatchId } : {}),
    });
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
    // When several checks are ready (independent components), start them together
    // so the live graph shows parallel paths instead of one-after-another.
    // Primary must be the controller-selected decision: beginReadyCheckDispatch
    // validates against selectGoalContinuation (round-robin), not definition order.
    const readyChecks = enumerateGoalContinuationCandidates(state!)
      .filter((candidate): candidate is ReadyCheckDecision => isReadyCheckDecision(candidate));
    const peers = readyChecks.filter((item) => item.nodeId !== decision.nodeId);
    const batch: ReadyCheckDecision[] = readyChecks.some((item) => item.nodeId === decision.nodeId)
      ? [decision, ...peers]
      : [decision];
    const parallel = batch.length > 1;
    ctx.ui.setStatus(
      "hypagraph-check",
      parallel
        ? `Checks ${batch.map((item) => item.nodeId).join(", ")}: running in parallel`
        : `Check ${decision.nodeId}: running`,
    );
    try {
      const executor = new CommandCheckExecutor({
        rootDirectory: ctx.cwd,
        artifactStore: new FileCheckArtifactStore(resolve(ctx.cwd, ".hypagraph", "check-artifacts")),
      });
      const onCommit = (next: HypagraphState, committed: readonly import("./domain/model.js").DomainEvent[]) => {
        if (sessionGeneration !== runGeneration || branchGeneration !== runBranch) return;
        state = next;
        events.push(...committed);
        paintUi(ctx);
      };
      const stale = () => sessionGeneration !== runGeneration || branchGeneration !== runBranch;
      const dispatch = parallel
        ? await runParallelDeterministicCheckDispatch({
          state: state!,
          decisions: batch,
          at: new Date().toISOString(),
          store: eventStore.lease(),
          executor,
          registry: activeExecutions,
          stale,
          onCommit,
          onAllStarted: async (started) => {
            if (sessionGeneration !== runGeneration || branchGeneration !== runBranch) return;
            state = started;
            paintUi(ctx);
            // Hold while every parallel path shows as running.
            if (demoPacingEnabled && ctx.hasUI) {
              await sleepDemoHold(demoDispatchHoldMs());
            }
          },
        })
        : await runDeterministicCheckDispatch({
          state: state!,
          decision,
          dispatchId: `hypagoal-dispatch:${randomUUID()}`,
          attemptId: randomUUID(),
          at: new Date().toISOString(),
          store: eventStore.lease(),
          executor,
          registry: activeExecutions,
          stale,
          onCommit,
        });
      if (!dispatch.ok) {
        const label = parallel
          ? `parallel checks (${batch.map((item) => item.nodeId).join(", ")})`
          : `deterministic check '${decision.nodeId}'`;
        ctx.ui.notify(dispatch.dispatched
          ? `Hypagoal ran ${label}, but it could not store the dispatch outcome '${dispatch.outcome}'.
The check lifecycle is durable. Restore closes the interrupted dispatch.
${formatDiagnostics(dispatch.diagnostics)}`
          : `Hypagoal ${label} was not dispatched.
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
          paintUi(ctx);
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
          paintUi(ctx);
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

  /**
   * Present the post-create Run / Question / Cancel dock when the gate is open.
   *
   * Returns true when the caller may queue continuation (Run or gate not open).
   * Returns false when the user deferred (Question) or cancelled the goal.
   */
  const resolvePostCreateGate = async (ctx: ExtensionContext): Promise<boolean> => {
    if (!postCreateAwaitingUserChoice || !state?.goal) return true;
    if (postCreateDockPresented) return false;
    if (!hostSupportsPostCreateDock(ctx)) {
      // Headless / non-TUI hosts never set the gate. Clear any stale flag.
      clearPostCreateGate();
      return true;
    }

    postCreateDockPresented = true;
    let choice: PostCreateDockResult;
    try {
      choice = await presentPostCreateDock(ctx, state);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Post-create graph dock failed (${detail}). The goal stays active without auto-run. Use /hypagraph resume to start, or /hypagraph cancel.`,
        "warning",
      );
      // Leave the gate set so auto-continue does not race past a failed dock.
      return false;
    }

    if (choice.kind === "run") {
      clearPostCreateGate();
      ctx.ui.notify("Hypagoal run started.", "info");
      return true;
    }

    if (choice.kind === "cancel") {
      // Keep the gate until cancel-goal commits. A failed cancel must not open auto-run.
      await abandonPendingContinuation("The user cancelled the Hypagoal from the post-create dock.");
      pendingContinuation = undefined;
      deliveredContinuation = undefined;
      revisionProposalHandled = false;
      restoreContinuationTools();
      try {
        if (!state) {
          ctx.ui.notify(
            "Hypagoal was not cancelled. Canonical state is missing. The post-create gate remains.",
            "warning",
          );
          return false;
        }
        const cancelled = await applyCommandsAndCommit(eventStore.lease(), state, [{
          type: "cancel-goal",
          reason: "The user cancelled the Hypagoal from the post-create dock.",
          commandId: `cancel-goal:post-create:${randomUUID()}`,
          at: new Date().toISOString(),
        }]);
        if (!cancelled.ok) {
          ctx.ui.notify(
            `Hypagoal was not cancelled. The post-create gate remains.\n${formatDiagnostics(cancelled.diagnostics)}`,
            "warning",
          );
          return false;
        }
        state = cancelled.value.state;
        events.push(...cancelled.value.events);
        clearPostCreateGate();
        paintUi(ctx);
        ctx.ui.notify(renderHypagoalLifecycleMessage(state), "warning");
        return false;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `Hypagoal was not cancelled. The post-create gate remains. ${detail}`,
          "warning",
        );
        return false;
      }
    }

    // Question: keep the gate set, keep the goal active, no auto-continue.
    ctx.ui.notify(
      "Hypagoal is ready. Ask a question in the composer. "
      + "Use /hypagraph resume to re-open the graph review dock and choose Run, or /hypagraph cancel to cancel.",
      "info",
    );
    paintUi(ctx);
    return false;
  };

  /**
   * Dispatch one default model task through an isolated worker.
   * Returns true when the controller may select the next action.
   * Returns false when the controller must stop this pass.
   *
   * Free-slot protocol (S4): bind under withIsolatedFreeSlotLock for
   * start/register only; release before the process await; re-bind under
   * lock for settlement. MemberContext is authority during unlocked await.
   * Callers must not hold an outer free-slot bind across this function.
   */
  const dispatchIsolatedRootModelTask = async (
    ctx: ExtensionContext,
    decision: Extract<
      ReturnType<typeof routeRootModelLaneAction>,
      { kind: "isolated-worker" }
    >,
    options?: {
      familyDispatchId?: string;
      /** Resolved product globalConcurrency for pool admit. Default DEFAULT_GLOBAL_CONCURRENCY. */
      globalConcurrency?: number;
      /**
       * Member working set for this worker. Required for free-slot re-bind
       * during start and settle. Authority during unlocked await.
       */
      member: MemberContext;
    },
  ): Promise<boolean> => {
    const member = options?.member;
    if (!member?.state?.goal) return false;
    const globalConcurrency = options?.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY;
    if (!canAdmitIsolatedWorker(isolatedWorkerPool(), globalConcurrency)) {
      const unsettled = countUnsettledIsolatedWorkers(isolatedWorkerPool());
      ctx.ui.notify(
        `Hypagoal isolated worker pool is at capacity `
        + `(${unsettled}/${globalConcurrency} unsettled). `
        + `Cannot start node '${decision.action.nodeId}'.`,
        "warning",
      );
      return false;
    }

    const familyProjection = restoreOrMigrateOneMemberFamilySession(
      ctx.sessionManager.getBranch(),
    );
    if (!familyProjection) {
      ctx.ui.notify(
        "Hypagoal isolated model dispatch requires a goal family projection.",
        "warning",
      );
      return false;
    }
    if (familyProjection.migrated) {
      appendOneMemberFamilyRecord(pi, familyProjection.family);
    }
    const family = familyProjection.family.familySnapshot;
    const operationId = `hypagoal-isolated:${randomUUID()}`;
    const attemptId = randomUUID();
    const at = new Date().toISOString();
    const runGeneration = sessionGeneration;
    const runBranch = branchGeneration;

    type StartedOk = {
      ok: true;
      active: ActiveIsolatedRootAttempt;
      context: ExecutorContextEnvelope;
    };
    type StartedFail = {
      ok: false;
      reason: "no-state" | "capacity" | "prepare" | "start" | "materialize";
      diagnostics?: Diagnostic[];
    };

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let lastActive: ActiveIsolatedRootAttempt | undefined;

    try {
      return await runIsolatedWithFreeSlotProtocol<StartedOk, Awaited<ReturnType<typeof dispatchIsolatedPiAttempt>>>({
        withLock: withIsolatedFreeSlotLock,
        bindFreeSlots: () => bindMemberLiveSlots(member),
        runStart: async (): Promise<StartedOk> => {
          // Member is bound into free slots for this critical section only.
          if (!state?.goal || !member.state) {
            const fail: StartedFail = { ok: false, reason: "no-state" };
            throw Object.assign(new Error("isolated-start-fail"), { startedFail: fail });
          }
          if (!canAdmitIsolatedWorker(isolatedWorkerPool(), globalConcurrency)) {
            const fail: StartedFail = { ok: false, reason: "capacity" };
            throw Object.assign(new Error("isolated-start-fail"), { startedFail: fail });
          }
          // Prefer free slots (bound member) for prepare so start-node matches commit target.
          const prepared = prepareIsolatedRootAttempt({
            state,
            family,
            action: decision.action,
            profile: decision.resolved.profile,
            attemptId,
            operationId,
            sessionGeneration: runGeneration,
            branchGeneration: runBranch,
            rootObjective: state.definition.goal,
            startedAt: at,
            timeoutMs: DEFAULT_ISOLATED_ROOT_TIMEOUT_MS,
            ...(options?.familyDispatchId !== undefined
              ? { familyDispatchId: options.familyDispatchId }
              : {}),
          });
          if (!prepared.ok) {
            const fail: StartedFail = {
              ok: false,
              reason: "prepare",
              diagnostics: prepared.diagnostics,
            };
            throw Object.assign(new Error("isolated-start-fail"), { startedFail: fail });
          }

          if (prepared.startCommands.length > 0) {
            const startCommit = await applyCommandsAndCommit(
              eventStore.lease(),
              state,
              withHostTimestamp(prepared.startCommands, at),
            );
            if (!startCommit.ok) {
              const fail: StartedFail = {
                ok: false,
                reason: "start",
                diagnostics: startCommit.diagnostics,
              };
              throw Object.assign(new Error("isolated-start-fail"), { startedFail: fail });
            }
            state = startCommit.value.state;
            events.push(...startCommit.value.events);
            // MemberContext is authority: sync mutations back before release.
            syncMemberFromLiveSlots(member, { state, events });
            paintUi(ctx);
          }

          const rematerialized = materializeIsolatedPiContext({
            family,
            state,
            nodeId: prepared.active.nodeId,
            attemptId: prepared.active.attemptId,
            profile: decision.resolved.profile,
            rootObjective: state.definition.goal,
          });
          if (!rematerialized.ok) {
            const fail: StartedFail = {
              ok: false,
              reason: "materialize",
              diagnostics: rematerialized.diagnostics,
            };
            throw Object.assign(new Error("isolated-start-fail"), { startedFail: fail });
          }

          // Cancel mirrors on the attempt: use member stream (authority), not free root.
          prepared.active.cancelSnapshot = structuredClone(member.state ?? state);
          prepared.active.cancelEvents = structuredClone(member.events.length > 0
            ? member.events
            : events);
          registerIsolatedWorker(isolatedWorkerPool(), prepared.active);
          lastActive = prepared.active;
          return {
            ok: true as const,
            active: prepared.active,
            context: rematerialized.value,
          };
        },
        awaitWorker: async (started) => {
          lastActive = started.active;
          const timeoutMs = started.active.timeoutMs ?? DEFAULT_ISOLATED_ROOT_TIMEOUT_MS;
          timeoutHandle = setTimeout(() => {
            started.active.abortController.abort(
              `Isolated model worker timed out after ${timeoutMs}ms.`,
            );
          }, timeoutMs);
          ctx.ui.notify(
            `Hypagoal started isolated worker for task '${started.active.nodeId}' `
            + `(profile ${decision.resolved.profile.kind}, attempt '${started.active.attemptId}', `
            + `timeout ${Math.round(timeoutMs / 1000)}s).`,
            "info",
          );
          paintUi(ctx);
          // Free slots are released. MemberContext and cancel mirrors are authority.
          return dispatchIsolatedPiAttempt(
            started.context,
            started.active.abortController.signal,
            isolatedRootSettleMeta(operationId, new Date().toISOString()),
          );
        },
        runSettle: async (started, settlement) => {
          const preparedActive = started.active;
          if (sessionGeneration !== runGeneration || branchGeneration !== runBranch) {
            return false;
          }
          if (preparedActive.settled
            || !findIsolatedWorkerByAttemptId(isolatedWorkerPool(), preparedActive.attemptId)
            || findIsolatedWorkerByAttemptId(isolatedWorkerPool(), preparedActive.attemptId)?.settled) {
            deleteIsolatedWorkerForAttempt(isolatedWorkerPool(), preparedActive);
            return true;
          }

          const accepted = acceptIsolatedRootSettlement({
            active: preparedActive,
            settlement,
            sessionGeneration,
            branchGeneration,
          });
          if (!accepted.ok) {
            deleteIsolatedWorkerForAttempt(isolatedWorkerPool(), preparedActive);
            ctx.ui.notify(
              `Hypagoal isolated settlement was not accepted for task '${preparedActive.nodeId}'. ${accepted.reason}`
              + (accepted.diagnostics ? `\n${formatDiagnostics(accepted.diagnostics)}` : ""),
              "warning",
            );
            return false;
          }

          // Free slots hold this member after re-bind. Prefer free slots, then mirrors.
          let settleState = state && state.workflowId === preparedActive.workflowId
            ? state
            : (member.state && member.state.workflowId === preparedActive.workflowId
              ? member.state
              : preparedActive.cancelSnapshot);
          let settleEvents = state && state.workflowId === preparedActive.workflowId
            ? events
            : (member.state && member.state.workflowId === preparedActive.workflowId
              ? structuredClone(member.events)
              : (preparedActive.cancelEvents
                ? structuredClone(preparedActive.cancelEvents)
                : undefined));
          if (!settleState) {
            const memberStream = latestFamilyRecord?.workflows[preparedActive.workflowId];
            settleState = memberStream?.snapshot;
            settleEvents = memberStream ? structuredClone(memberStream.events) : undefined;
          }
          if (!settleState) {
            deleteIsolatedWorkerForAttempt(isolatedWorkerPool(), preparedActive);
            ctx.ui.notify(
              `Hypagoal isolated settlement lost member stream for task '${preparedActive.nodeId}'.`,
              "warning",
            );
            return false;
          }

          const settleAt = new Date().toISOString();
          eventStore.noteWorkflowSequence(preparedActive.workflowId, settleState.sequence);
          const committed = await applyCommandsAndCommit(
            eventStore.lease(),
            settleState,
            accepted.commands.map((command) => ({ ...command, at: settleAt })),
          );
          if (!committed.ok) {
            deleteIsolatedWorkerForAttempt(isolatedWorkerPool(), preparedActive);
            ctx.ui.notify(
              `Hypagoal isolated settlement commands failed for task '${preparedActive.nodeId}'.\n${formatDiagnostics(committed.diagnostics)}`,
              "warning",
            );
            return false;
          }
          let nextMemberState = committed.value.state;
          let nextMemberEvents = [
            ...(settleEvents ?? []),
            ...committed.value.events,
          ];

          if (accepted.result.outcome === "submitted") {
            const verifyCommands = buildPostSubmitVerificationCommands({
              state: nextMemberState,
              nodeId: preparedActive.nodeId,
              attemptId: preparedActive.attemptId,
              operationId,
              at: new Date().toISOString(),
            });
            if (verifyCommands) {
              const verified = await applyCommandsAndCommit(
                eventStore.lease(),
                nextMemberState,
                verifyCommands,
              );
              if (!verified.ok) {
                deleteIsolatedWorkerForAttempt(isolatedWorkerPool(), preparedActive);
                paintUi(ctx);
                ctx.ui.notify(
                  `Hypagoal isolated task '${preparedActive.nodeId}' submitted but verification failed.\n${formatDiagnostics(verified.diagnostics)}`,
                  "warning",
                );
                return false;
              }
              nextMemberState = verified.value.state;
              nextMemberEvents = [...nextMemberEvents, ...verified.value.events];
            }
          }

          // Write settled stream into free slots (bound member) and MemberContext.
          if (state && state.workflowId === preparedActive.workflowId) {
            state = nextMemberState;
            events = nextMemberEvents;
          }
          syncMemberFromLiveSlots(member, {
            state: nextMemberState,
            events: nextMemberEvents,
          });

          // Re-read family bag under the free-slot lock after all awaits so sibling
          // settles that finished earlier are not lost (S4 Issue 6 / 7).
          // Member stream replace + pending settle use the same merge helper as tests.
          const familyForMember = latestFamilyRecord;
          if (familyForMember && familyForMember.workflows[preparedActive.workflowId]) {
            let baseForMerge = familyForMember;
            // After release, free slots will restore desk root; merge live root when free is still root.
            if (state && state.workflowId !== preparedActive.workflowId) {
              baseForMerge = mergeLiveRootIntoFamily(baseForMerge, {
                workflowId: state.workflowId,
                events,
                snapshot: state,
              });
            }
            const applied = applyMemberStreamAndPendingSettle({
              family: baseForMerge,
              workflowId: preparedActive.workflowId,
              nextEvents: nextMemberEvents,
              nextSnapshot: nextMemberState,
              at: new Date().toISOString(),
              ...(options?.familyDispatchId !== undefined
                ? { dispatchId: options.familyDispatchId, settleOutcome: "completed" as const }
                : {}),
            });
            if (applied.ok) {
              appendOneMemberFamilyRecord(pi, applied.family);
              rememberFamilyRecord(applied.family);
              // Skip post-dispatch persistNonRootMemberUpdate for this workflow (Issue 6).
              isolatedFamilyPersistedWorkflowIds.add(preparedActive.workflowId);
            } else {
              ctx.ui.notify(
                `Hypagoal could not merge isolated settle into the family bag for `
                + `'${preparedActive.workflowId}'. ${applied.reason}`,
                "warning",
              );
            }
          }

          deleteIsolatedWorkerForAttempt(isolatedWorkerPool(), preparedActive);
          paintUi(ctx);
          ctx.ui.notify(
            `Hypagoal isolated worker finished task '${preparedActive.nodeId}' `
            + `(outcome ${accepted.result.outcome}). ${accepted.summary}`.trim(),
            accepted.result.outcome === "submitted" ? "info" : "warning",
          );
          return true;
        },
        runErrorCancel: async (started, error) => {
          const detail = error instanceof Error ? error.message : String(error);
          // Structured start failures use startedFail; do not cancel a non-started attempt.
          const startedFail = (error as { startedFail?: StartedFail })?.startedFail;
          if (startedFail) return;

          const preparedActive = started?.active ?? lastActive;
          if (!preparedActive) return;
          try {
            preparedActive.abortController.abort(
              `Isolated model worker threw before settlement: ${detail}`,
            );
          } catch {
            // Abort must not throw into the catch path.
          }
          if (sessionGeneration !== runGeneration || branchGeneration !== runBranch) {
            deleteIsolatedWorkerForAttempt(isolatedWorkerPool(), preparedActive);
            return;
          }
          // Free slots hold this member after re-bind. Prefer free, then mirrors, then member.
          let cancelState = state && state.workflowId === preparedActive.workflowId
            ? state
            : (member.state && member.state.workflowId === preparedActive.workflowId
              ? member.state
              : preparedActive.cancelSnapshot);
          if (!cancelState) {
            cancelState = latestFamilyRecord?.workflows[preparedActive.workflowId]?.snapshot;
          }
          if (cancelState) {
            const cancelCommands = buildOrphanedTaskCancelCommands({
              state: cancelState,
              at: new Date().toISOString(),
              reason: `Isolated model worker threw before settlement: ${detail}`,
              correlationId: `isolated-root-throw:${randomUUID()}`,
              only: {
                nodeId: preparedActive.nodeId,
                attemptId: preparedActive.attemptId,
              },
            });
            if (cancelCommands.length > 0) {
              try {
                const cancelled = await applyCommandsAndCommit(
                  eventStore.lease(),
                  cancelState,
                  cancelCommands,
                );
                if (cancelled.ok) {
                  if (state && state.workflowId === preparedActive.workflowId) {
                    state = cancelled.value.state;
                    events = [...(preparedActive.cancelEvents ?? events), ...cancelled.value.events];
                  }
                  syncMemberFromLiveSlots(member, {
                    state: cancelled.value.state,
                    events: [
                      ...(member.events),
                      ...cancelled.value.events,
                    ],
                  });
                  paintUi(ctx);
                } else {
                  ctx.ui.notify(
                    `Hypagoal could not cancel the orphaned task after an isolated worker throw.\n${formatDiagnostics(cancelled.diagnostics)}`,
                    "warning",
                  );
                }
              } catch {
                // Still clear host bookkeeping below.
              }
            }
          }
          deleteIsolatedWorkerForAttempt(isolatedWorkerPool(), preparedActive);
          ctx.ui.notify(
            `Hypagoal isolated worker threw for task '${preparedActive.nodeId}'. ${detail}`,
            "warning",
          );
        },
      }, { rethrowOnWorkerError: false, onWorkerErrorResult: false });
    } catch (error) {
      const startedFail = (error as { startedFail?: StartedFail })?.startedFail;
      if (startedFail) {
        if (startedFail.reason === "capacity") {
          ctx.ui.notify(
            `Hypagoal isolated worker pool is at capacity. Cannot start node '${decision.action.nodeId}'.`,
            "warning",
          );
        } else if (
          startedFail.reason === "prepare"
          || startedFail.reason === "start"
          || startedFail.reason === "materialize"
        ) {
          const label = startedFail.reason === "prepare"
            ? "was not prepared"
            : startedFail.reason === "start"
              ? `could not start task '${decision.action.nodeId}' for isolated dispatch`
              : "context was not materialized";
          ctx.ui.notify(
            `Hypagoal isolated model dispatch ${label}.\n${formatDiagnostics(startedFail.diagnostics ?? [])}`,
            "warning",
          );
        }
        return false;
      }
      throw error;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  };

  /**
   * Load the latest family record for controller selection.
   * Migrates a one-member root when needed. Seeds event-store sequences for
   * every family workflow so child appends do not start at sequence 0.
   */
  const loadFamilyRecordForController = (ctx: ExtensionContext): PersistedGoalFamily | undefined => {
    if (!state?.goal) return undefined;
    try {
      const projection = restoreOrMigrateOneMemberFamilySession(
        ctx.sessionManager.getBranch(),
      );
      if (!projection) return undefined;
      if (projection.migrated) {
        appendOneMemberFamilyRecord(pi, projection.family);
      }
      // Live root remains authoritative. Family child streams keep their sequences.
      eventStore.noteFamilyWorkflowSequences(projection.family.workflows);
      if (state) {
        eventStore.noteWorkflowSequence(state.workflowId, state.sequence);
      }
      rememberFamilyRecord(projection.family);
      return projection.family;
    } catch {
      return latestFamilyRecord;
    }
  };

  /**
   * Persist member workflow mutations after a non-root family dispatch.
   * Merges current live root events/snapshot into the family record first (R5).
   * Appends new child events to the event store and updates the family custom entry.
   */
  const persistNonRootMemberUpdate = async (input: {
    family: PersistedGoalFamily;
    workflowId: string;
    previousEvents: DomainEvent[];
    nextState: HypagraphState;
    nextEvents: DomainEvent[];
    previousSequence: number;
    /** Live root stream at persist time (must not be the child swap). */
    liveRoot?: { workflowId: string; events: DomainEvent[]; snapshot: HypagraphState };
  }): Promise<{ ok: true; family: PersistedGoalFamily } | { ok: false; message: string }> => {
    const appended = input.nextEvents.slice(input.previousEvents.length);
    const storeSequence = eventStore.knownSequence(input.workflowId) ?? 0;
    // Member swap paths already commit through applyCommandsAndCommit while the
    // host state is the child. Skip re-append when the store already matches next.
    if (appended.length > 0 && storeSequence === input.nextState.sequence) {
      eventStore.noteWorkflowSequence(input.workflowId, input.nextState.sequence);
    } else if (appended.length > 0) {
      try {
        await eventStore.lease().append({
          workflowId: input.workflowId,
          expectedSequence: input.previousSequence,
          events: appended,
          snapshot: input.nextState,
        });
      } catch (error) {
        // If store advanced during swap to the next sequence, treat as already durable.
        const afterConflict = eventStore.knownSequence(input.workflowId) ?? 0;
        if (afterConflict === input.nextState.sequence) {
          eventStore.noteWorkflowSequence(input.workflowId, input.nextState.sequence);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, message };
        }
      }
    } else {
      eventStore.noteWorkflowSequence(input.workflowId, input.nextState.sequence);
    }

    // Start from the family record, then merge live root so sibling progress is kept (R5).
    let baseFamily = input.family;
    const liveRoot = input.liveRoot;
    if (liveRoot && liveRoot.workflowId !== input.workflowId) {
      baseFamily = mergeLiveRootIntoFamily(baseFamily, liveRoot);
    }

    const nextFamily = replaceFamilyMemberWorkflow(baseFamily, input.workflowId, {
      events: input.nextEvents,
      snapshot: input.nextState,
    });
    appendOneMemberFamilyRecord(pi, nextFamily);
    rememberFamilyRecord(nextFamily);
    return { ok: true, family: nextFamily };
  };

  /**
   * Apply product child return for every active binding whose child is terminal.
   * Syncs the live parent stream into the family, commits returnChildGoalInFamily,
   * appends parent leave-wait events to the root event stream, and updates live state.
   * Child success does not complete the parent task.
   *
   * Each return mutation reloads latestFamilyRecord and holds withIsolatedFreeSlotLock
   * for the full merge + append + remember so concurrent model settles cannot clobber
   * the bag (S4 Issue 9).
   */
  const applyPendingChildReturns = async (
    ctx: ExtensionContext,
    familyRecord: PersistedGoalFamily,
  ): Promise<{ applied: number; family: PersistedGoalFamily }> => {
    if (!state?.goal) return { applied: 0, family: familyRecord };

    let family = familyRecord;
    let applied = 0;
    // Re-scan after each return so multiple terminal children can settle in one pass.
    let progress = true;
    while (progress) {
      progress = false;

      type ReturnStep =
        | { did: false; family: PersistedGoalFamily }
        | {
          did: true;
          family: PersistedGoalFamily;
          notify: {
            outcome: string;
            bindingId: string;
            childGoalId: string;
            parentNodeId: string;
            parentNodeStatus: string;
            parentEffect: string;
            level: "info" | "warning";
          };
        };

      const step: ReturnStep = await withIsolatedFreeSlotLock(async (): Promise<ReturnStep> => {
        const live = state;
        if (!live?.goal) return { did: false, family };

        // Always reload under the free-slot / family lock (Issue 9).
        let bag = latestFamilyRecord ?? family;
        const parentWorkflowId = live.workflowId;
        let parentState: HypagraphState = live;
        let parentEvents: DomainEvent[] = events;
        bag = {
          ...bag,
          workflows: {
            ...bag.workflows,
            [parentWorkflowId]: {
              events: structuredClone(parentEvents),
              snapshot: structuredClone(parentState),
            },
          },
        };

        for (const binding of Object.values(bag.familySnapshot.bindings)) {
          if (binding.status !== "active") continue;
          const childMember = bag.familySnapshot.members[binding.childGoalId];
          if (!childMember) continue;
          const childWorkflow = bag.workflows[childMember.workflowId];
          if (!childWorkflow) continue;

          const pending = detectPendingChildReturn({
            family: bag,
            childState: childWorkflow.snapshot,
          });
          if (!pending || pending.bindingId !== binding.bindingId) continue;

          const previousParentSequence = parentState.sequence;
          const returned = returnChildGoalInFamily({
            family: bag,
            parentGoalId: pending.parentGoalId,
            bindingId: pending.bindingId,
            at: new Date().toISOString(),
            outcome: pending.outcome,
            ...(pending.facts.length > 0 ? { facts: pending.facts } : {}),
            ...(pending.evidence.length > 0 ? { evidence: pending.evidence } : {}),
            reason: pending.reason,
          });

          if (!returned.ok) {
            ctx.ui.notify(
              `Child return was not applied for binding '${pending.bindingId}'.\n${formatDiagnostics(returned.diagnostics)}`,
              "warning",
            );
            continue;
          }

          const nextParentWorkflow = returned.family.workflows[parentWorkflowId];
          if (!nextParentWorkflow) {
            ctx.ui.notify(
              `Child return committed without parent workflow '${parentWorkflowId}'.`,
              "warning",
            );
            continue;
          }

          const appendedParentEvents = nextParentWorkflow.events.slice(parentEvents.length);
          if (appendedParentEvents.length > 0) {
            try {
              // Hold the free-slot lock across append so concurrent settle cannot
              // write the bag between return commit and remember.
              await eventStore.lease().append({
                workflowId: parentWorkflowId,
                expectedSequence: previousParentSequence,
                events: appendedParentEvents,
                snapshot: nextParentWorkflow.snapshot,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              ctx.ui.notify(
                `Child return committed to the family, but parent event append failed. ${message}`,
                "warning",
              );
              continue;
            }
          }

          appendOneMemberFamilyRecord(pi, returned.family);
          rememberFamilyRecord(returned.family);
          parentState = nextParentWorkflow.snapshot;
          parentEvents = structuredClone(nextParentWorkflow.events);
          state = parentState;
          events = parentEvents;
          eventStore.noteWorkflowSequence(parentWorkflowId, parentState.sequence);

          const parentNodeStatus =
            parentState.runtime.nodes[binding.parentNodeId]?.status ?? "unknown";
          const returnRecord =
            returned.family.familySnapshot.bindings[binding.bindingId]?.returnRecord;
          return {
            did: true,
            family: returned.family,
            notify: {
              outcome: pending.outcome,
              bindingId: pending.bindingId,
              childGoalId: pending.childGoalId,
              parentNodeId: binding.parentNodeId,
              parentNodeStatus,
              parentEffect: returnRecord?.parentEffect ?? "unknown",
              level: pending.outcome === "completed" ? "info" : "warning",
            },
          };
        }
        return { did: false, family: bag };
      });

      family = step.family;
      if (step.did) {
        paintUi(ctx);
        ctx.ui.notify(
          renderChildReturnApplied({
            outcome: step.notify.outcome as import("./domain/goal-family.js").ChildReturnOutcomeKind,
            bindingId: step.notify.bindingId,
            childGoalId: step.notify.childGoalId,
            parentNodeId: step.notify.parentNodeId,
            parentNodeStatus: step.notify.parentNodeStatus,
            parentEffect: step.notify.parentEffect,
          }),
          step.notify.level,
        );
        applied += 1;
        progress = true;
      }
    }

    // S6: when every child in a parent-node join set is terminal and auto/explicit
    // readiness rules pass, run all-success synthesis and transition the parent.
    // Run even when this pass applied zero returns (restore / re-entry after
    // return commit without synthesis). Quiet when no parent mutation occurs.
    if (state?.goal) {
      const parentGoalId = state.goal.goalId;
      const synthesisPass = await withIsolatedFreeSlotLock(async () => {
        const live = state;
        if (!live?.goal) {
          return {
            family,
            notified: [] as Array<{ text: string; level: "info" | "warning" }>,
            parentMutated: false,
          };
        }
        let bag = latestFamilyRecord ?? family;
        const parentWorkflowId = live.workflowId;
        bag = {
          ...bag,
          workflows: {
            ...bag.workflows,
            [parentWorkflowId]: {
              events: structuredClone(events),
              snapshot: structuredClone(live),
            },
          },
        };
        const synthesisAt = new Date().toISOString();
        const synthesized = applyReadyJoinSynthesesToPersistedFamily({
          family: bag,
          parentGoalId,
          at: synthesisAt,
        });
        if (!synthesized.ok) {
          return {
            family: bag,
            notified: synthesized.diagnostics.map((item) => ({
              text: `Child join synthesis was not applied. ${item.code}: ${item.message}`,
              level: "warning" as const,
            })),
            parentMutated: false,
          };
        }

        const nextParentWorkflow = synthesized.family.workflows[parentWorkflowId];
        if (!nextParentWorkflow) {
          return {
            family: synthesized.family,
            notified: synthesized.applied.length > 0
              ? [{
                text: `Child join synthesis committed without parent workflow '${parentWorkflowId}'.`,
                level: "warning" as const,
              }]
              : [],
            parentMutated: false,
          };
        }

        const previousParentSequence = live.sequence;
        const priorEventCount = bag.workflows[parentWorkflowId]?.events.length ?? events.length;
        const appendedParentEvents = nextParentWorkflow.events.slice(priorEventCount);
        const parentMutated = appendedParentEvents.length > 0
          || synthesized.applied.some((item) => item.parentMutated);

        if (appendedParentEvents.length > 0) {
          try {
            await eventStore.lease().append({
              workflowId: parentWorkflowId,
              expectedSequence: previousParentSequence,
              events: appendedParentEvents,
              snapshot: nextParentWorkflow.snapshot,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              family: bag,
              notified: [{
                text: `Child join synthesis could not append parent events. ${message}`,
                level: "warning" as const,
              }],
              parentMutated: false,
            };
          }
          appendOneMemberFamilyRecord(pi, synthesized.family);
          rememberFamilyRecord(synthesized.family);
          state = nextParentWorkflow.snapshot;
          events = structuredClone(nextParentWorkflow.events);
          eventStore.noteWorkflowSequence(parentWorkflowId, state.sequence);
        }

        const notified: Array<{ text: string; level: "info" | "warning" }> = [];
        for (const item of synthesized.applied) {
          if (!item.parentMutated && !item.factPublished) continue;
          const parentNodeStatus =
            nextParentWorkflow.snapshot.runtime.nodes[item.parentNodeId]?.status ?? "unknown";
          notified.push({
            text: renderJoinSynthesisApplied({
              parentNodeId: item.parentNodeId,
              status: item.result.status === "passed" ? "passed" : "failed",
              completedCount: item.result.completedCount,
              totalCount: item.result.totalCount,
              resultFactName: item.policy.resultFactName,
              parentNodeStatus,
              factPublished: item.factPublished,
              parentMutated: item.parentMutated,
            }),
            level: item.result.status === "passed" ? "info" : "warning",
          });
        }
        // Notify diagnostics only when this pass mutated parent state.
        // Quiet re-entry: skipped parent-not-running and other non-mutating
        // outcomes must not warn on every free-slot controller iteration.
        if (parentMutated) {
          for (const item of synthesized.diagnostics) {
            notified.push({
              text: `Child join synthesis note: ${item.code}: ${item.message}`,
              level: "warning",
            });
          }
        }
        return {
          family: appendedParentEvents.length > 0 ? synthesized.family : bag,
          notified,
          parentMutated,
        };
      });

      family = synthesisPass.family;
      for (const note of synthesisPass.notified) {
        ctx.ui.notify(note.text, note.level);
      }
      if (synthesisPass.parentMutated) {
        paintUi(ctx);
      }
    }

    return { applied, family };
  };

  /**
   * Run one dispatchable action against a selected family member.
   * For the live root, uses the existing root state/events path.
   * For a child member, temporarily swaps host state, dispatches, then persists.
   */
  /**
   * Persist family snapshot and events after multi-pending commit or settle.
   * Keeps the caller family workflows by default. Merges the live root stream only
   * when the live sequence is strictly ahead of the stored root stream (R5).
   * Avoids overwriting a durable parent waiting_for_child snapshot with a stale
   * root clone restored after a non-root member swap. Does not mutate inputs.
   */
  const persistFamilySnapshotUpdate = (
    family: PersistedGoalFamily,
    nextSnapshot: import("./domain/goal-family.js").GoalFamilyRuntime,
    extraEvents: import("./domain/goal-family.js").GoalFamilyEvent[],
  ): PersistedGoalFamily => {
    let baseFamily = family;
    if (state && events) {
      const storedRoot = family.workflows[state.workflowId];
      const storedSequence = storedRoot?.snapshot.sequence ?? -1;
      if (state.sequence > storedSequence) {
        baseFamily = mergeLiveRootIntoFamily(baseFamily, {
          workflowId: state.workflowId,
          events,
          snapshot: state,
        });
      }
    }
    const nextFamily: PersistedGoalFamily = {
      schemaVersion: baseFamily.schemaVersion,
      familyEvents: [...structuredClone(baseFamily.familyEvents), ...structuredClone(extraEvents)],
      familySnapshot: structuredClone(nextSnapshot),
      workflows: structuredClone(baseFamily.workflows),
    };
    appendOneMemberFamilyRecord(pi, nextFamily);
    rememberFamilyRecord(nextFamily);
    return nextFamily;
  };

  /**
   * Settle one family pending against the current family bag.
   * Fully synchronous load-modify-write so sequential callers stay atomic on
   * the JS event loop. Concurrent isolated settle must call this only while
   * holding withIsolatedFreeSlotLock (folded into runSettle) so it cannot
   * interleave with member stream family writes (S4 Issue 7).
   */
  settleFamilyDispatchById = (
    dispatchId: string | undefined,
    outcome: "completed" | "failed" | "interrupted",
    reason?: string,
    ctx?: ExtensionContext,
  ): void => {
    if (!dispatchId) return;
    let family = ctx ? loadFamilyRecordForController(ctx) : undefined;
    if (!family) family = latestFamilyRecord;
    if (!family) return;
    if (!family.familySnapshot.pendingDispatches[dispatchId]) return;
    const settled = settleFamilyPendingForHost({
      family: family.familySnapshot,
      dispatchId,
      at: new Date().toISOString(),
      outcome,
      ...(reason !== undefined ? { reason } : {}),
    });
    if (!settled.ok) return;
    persistFamilySnapshotUpdate(family, settled.family, settled.events);
  };

  const dispatchSelectedMemberAction = async (
    ctx: ExtensionContext,
    selection: Extract<
      ReturnType<typeof selectFamilyControllerAction>,
      { kind: "dispatch" }
    >,
    options?: {
      familyDispatchId?: string;
      globalConcurrency?: number;
      /**
       * When true, skip per-member applyPendingChildReturns.
       * Concurrent batch path runs one controller-level return pass after
       * Promise.all so sibling returns cannot race (S4 Issue 9).
       */
      deferChildReturn?: boolean;
    },
  ): Promise<"continue" | "stop" | "model-follow-up"> => {
    const decision = selection.decision;

    if (selection.isLiveRoot) {
      const rootMember = rootMemberContext();
      if (!rootMember) return "stop";
      return dispatchDecisionOnLiveState(ctx, rootMember, decision, options);
    }

    // Non-root member: work on an explicit MemberContext. Do not reassign free
    // root state/events as the only working set (Seam A).
    const liveRoot = state;
    if (!liveRoot) return "stop";
    // Capture desk-root stream and generations once before any free-slot bind.
    // Member working set is MemberContext. Free slots may bind temporarily
    // for nested helpers; persist uses this pre-bind root capture only when
    // generations still match (restore mid-dispatch skips family write).
    const entrySessionGeneration = sessionGeneration;
    const entryBranchGeneration = branchGeneration;
    const liveRootCapture = {
      workflowId: liveRoot.workflowId,
      snapshot: liveRoot,
      events,
    };
    const memberStream = selection.family.workflows[selection.memberWorkflowId];
    if (!memberStream) {
      ctx.ui.notify(
        `Hypagoal family member workflow '${selection.memberWorkflowId}' is missing from the family record.`,
        "warning",
      );
      return "stop";
    }

    // R4 fallback: refuse current-session on non-root members until delivery ships.
    const memberRouting = routeRootModelLaneAction(decision, selection.memberState, {
      legacyCurrentSessionDefault: getHostRoutingOptions().legacyCurrentSessionDefault,
    });
    if (memberRouting.kind === "current-session-follow-up") {
      ctx.ui.notify(NON_ROOT_CURRENT_SESSION_BAN_REASON, "warning");
      return "stop";
    }

    const previousSequence = memberStream.snapshot.sequence;
    const previousEvents = structuredClone(memberStream.events);
    // attachMember clones state and events at the API boundary.
    const member = attachMember(sessionContext, {
      workflowId: selection.memberWorkflowId,
      goalId: selection.memberGoalId,
      state: selection.memberState,
      events: memberStream.events,
    });
    eventStore.noteWorkflowSequence(selection.memberWorkflowId, previousSequence);

    let outcome: "continue" | "stop" | "model-follow-up" = "stop";
    let familyAfterChild = selection.family;
    try {
      outcome = await dispatchDecisionOnLiveState(ctx, member, decision, options);
    } finally {
      // Isolated settle already wrote this member under the free-slot lock and
      // marked the workflow id. Do not re-merge from selection.family (stale batch
      // snapshot) or concurrent sibling streams are clobbered (S4 Issue 6).
      if (isolatedFamilyPersistedWorkflowIds.has(selection.memberWorkflowId)) {
        isolatedFamilyPersistedWorkflowIds.delete(selection.memberWorkflowId);
        familyAfterChild = latestFamilyRecord ?? selection.family;
      } else {
        // Persist child mutations only when generations still match entry.
        // After restore mid-dispatch, skip R5 merge and family write so the
        // restored family bag is not rewritten from pre-bind captures.
        const mayPersist = shouldPersistNonRootMemberAfterBind({
          bindSessionGeneration: entrySessionGeneration,
          bindBranchGeneration: entryBranchGeneration,
          currentSessionGeneration: sessionGeneration,
          currentBranchGeneration: branchGeneration,
          memberWorkflowId: selection.memberWorkflowId,
          memberState: member.state,
        });
        if (mayPersist && member.state) {
          // Full residual merge + append + remember under free-slot lock (Issue 10).
          // Reload latestFamilyRecord at the start of the critical section.
          const memberStateForPersist = member.state;
          const memberEventsForPersist = member.events;
          const persisted = await withIsolatedFreeSlotLock(async () => {
            const baseFamilyForPersist = latestFamilyRecord ?? selection.family;
            return persistNonRootMemberUpdate({
              family: baseFamilyForPersist,
              workflowId: selection.memberWorkflowId,
              previousEvents,
              nextState: memberStateForPersist,
              nextEvents: memberEventsForPersist,
              previousSequence,
              liveRoot: {
                workflowId: liveRootCapture.workflowId,
                events: liveRootCapture.events,
                snapshot: liveRootCapture.snapshot,
              },
            });
          });
          if (!persisted.ok) {
            ctx.ui.notify(
              `Hypagoal could not persist child workflow '${selection.memberWorkflowId}'. ${persisted.message}`,
              "warning",
            );
            outcome = "stop";
          } else {
            familyAfterChild = persisted.family;
          }
        } else if (!mayPersist) {
          // Session restore (or branch change) invalidated this member pass.
          outcome = "stop";
        }
      }
      if (state) {
        eventStore.noteWorkflowSequence(state.workflowId, state.sequence);
      }
      paintUi(ctx);
    }

    // When the child became terminal, return into the parent binding on the product path.
    // Concurrent batch model path defers this to one controller-level pass (Issue 9).
    if (outcome !== "stop" && !options?.deferChildReturn) {
      const returnResult = await applyPendingChildReturns(ctx, familyAfterChild);
      if (returnResult.applied > 0 && outcome === "model-follow-up") {
        // Parent state changed; drop a stale model follow-up that targeted the child.
        pendingContinuation = undefined;
        return "continue";
      }
      if (returnResult.applied > 0) return "continue";
    }
    return outcome;
  };

  /**
   * Dispatch one already-selected action against an explicit MemberContext.
   * Nested helpers that still close over free state/events use a temporary
   * live-slot bind. MemberContext remains the authority for the outcome.
   * Shared by root and non-root member paths.
   *
   * Isolated model workers do not hold free slots across the process await
   * (S4 free-slot protocol). Deterministic and current-session paths bind for
   * their full duration and must hold the free-slot lock for that whole bind,
   * including awaits. Without the lock, a concurrent isolated start can rebind
   * free slots during applyCommandsAndCommit and push root events onto a child
   * event stream.
   */
  const dispatchDecisionOnLiveState = async (
    ctx: ExtensionContext,
    member: MemberContext,
    decision: GoalDispatchableContinuation,
    options?: { familyDispatchId?: string; globalConcurrency?: number },
  ): Promise<"continue" | "stop" | "model-follow-up"> => {
    if (!member.state) return "stop";

    // Isolated worker path: route against MemberContext without an outer free-slot
    // bind that would span the long process await. Start/settle re-bind under lock.
    const isolatedRouting = routeRootModelLaneAction(decision, member.state, {
      legacyCurrentSessionDefault: getHostRoutingOptions().legacyCurrentSessionDefault,
    });
    if (isolatedRouting.kind === "isolated-worker") {
      const continued = await dispatchIsolatedRootModelTask(ctx, isolatedRouting, {
        member,
        ...(options?.familyDispatchId !== undefined
          ? { familyDispatchId: options.familyDispatchId }
          : {}),
        ...(options?.globalConcurrency !== undefined
          ? { globalConcurrency: options.globalConcurrency }
          : {}),
      });
      return continued ? "continue" : "stop";
    }

    // Hold free-slot lock for the entire non-isolated bind (S4 ownership).
    // Concurrent isolated start/settle must wait until this bind releases.
    return await withIsolatedFreeSlotLock(async () => {
      const liveBinding = bindMemberLiveSlots(member);
      try {
        if (isReadyCheckDecision(decision)) {
          const continued = await dispatchDeterministicCheck(ctx, decision);
          return continued ? "continue" : "stop";
        }
        if (isReadyCodeDecision(decision)) {
          const continued = await dispatchDeterministicCode(ctx, decision);
          return continued ? "continue" : "stop";
        }
        if (isDeterministicEffectDecision(decision)) {
          const continued = await dispatchDeterministicEffect(ctx, decision);
          return continued ? "continue" : "stop";
        }
        if (isReadyGateDecision(decision)) {
          const dispatchId = `hypagoal-dispatch:${randomUUID()}`;
          const dispatched = await dispatchReadyGateAndCommit(eventStore.lease(), state!, {
            dispatchId,
            decision,
            at: new Date().toISOString(),
          });
          if (!dispatched.ok) {
            ctx.ui.notify(`Hypagoal deterministic gate was not dispatched.
${formatDiagnostics(dispatched.diagnostics)}`, "warning");
            return "stop";
          }
          state = dispatched.state;
          events.push(...dispatched.events);
          paintUi(ctx);
          if (dispatched.outcome === "failed") {
            ctx.ui.notify(`Hypagoal deterministic gate '${decision.nodeId}' failed.
${formatDiagnostics(dispatched.diagnostics)}`, "warning");
            return "stop";
          }
          return "continue";
        }

        // Ready interaction: request and present without a model turn.
        // Demos and product graphs must not charge token budget to open a dock.
        if (decision.kind === "request-ready-interaction") {
          const nodeId = decision.nodeId;
          const runtime = state!.runtime.nodes[nodeId];
          if (!runtime || runtime.status !== "ready") {
            ctx.ui.notify(
              `Hypagoal interaction '${nodeId}' is not ready for presentation.`,
              "warning",
            );
            return "stop";
          }
          if (!interactionPresentationIsAllowed(state!, nodeId)) {
            ctx.ui.notify(
              `Interaction '${nodeId}' was not presented. The graph has other runnable work.`,
              "warning",
            );
            return "stop";
          }
          try {
            await runCommands([{
              type: "request-interaction",
              nodeId,
              attemptId: randomUUID(),
              commandId: randomUUID(),
              correlationId: randomUUID(),
              at: new Date().toISOString(),
            }]);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(
              `Hypagoal could not request interaction '${nodeId}'. ${detail}`,
              "warning",
            );
            return "stop";
          }
          const awaiting = awaitingInteractions(state!).find((item) => item.nodeId === nodeId);
          if (!awaiting) {
            ctx.ui.notify(
              `Hypagoal requested interaction '${nodeId}', but it is not awaiting a response.`,
              "warning",
            );
            return "stop";
          }
          const outcome = await presentAwaitingInteraction(ctx, awaiting);
          paintUi(ctx);
          if (outcome === "answered") return "continue";
          if (outcome === "presentation-failed") {
            const observation = interactionPresentationObservation(state!, nodeId, awaiting.attemptId);
            const detail = observation?.error
              ? `${observation.status}: ${observation.error}`
              : (observation?.status ?? "failed");
            ctx.ui.notify(
              `Interaction '${nodeId}' presentation ${detail}. The node is failed and does not wait for an answer.`,
              "warning",
            );
            return "stop";
          }
          if (outcome === "unavailable") {
            ctx.ui.notify(
              waitingUnavailableNote(state!)
                ?? `This host has no dialog capability. Interaction '${nodeId}' still waits for an answer.`,
              "warning",
            );
            return "stop";
          }
          ctx.ui.notify(
            waitingLifecycleNote(state!)
              ?? `Waiting for a user response on node '${nodeId}'. Use /hypagraph ask to present the dialog again.`,
            "info",
          );
          return "stop";
        }

        // Current-session / orchestrator follow-up (not isolated-worker).
        // Free slots are bound for this path only under the free-slot lock.
        const routing = routeRootModelLaneAction(decision, state!, {
          legacyCurrentSessionDefault: getHostRoutingOptions().legacyCurrentSessionDefault,
        });
        // isolated-worker was handled above without outer bind.
        if (routing.kind === "isolated-worker") {
          // Should not reach: already routed on member.state. Fail closed.
          return "stop";
        }

        const operationId = `hypagoal-continuation:${randomUUID()}`;
        const request = await applyCommandsAndCommit(eventStore.lease(), state!, [{
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
          return "stop";
        }
        // Free-slot identity guard: after await, free slots must still be this member.
        if (!state || state.workflowId !== member.workflowId) {
          ctx.ui.notify(
            `Hypagoal free-slot ownership was lost during current-session dispatch for `
            + `'${member.workflowId}'. Continuation was not applied to free slots.`,
            "warning",
          );
          return "stop";
        }
        state = request.value.state;
        events.push(...request.value.events);
        syncMemberFromLiveSlots(member, { state, events });
        paintUi(ctx);
        if (state.goal?.status === "budget_limited") {
          ctx.ui.notify(renderHypagoalLifecycleMessage(state), "warning");
          return "stop";
        }
        pendingContinuation = createPendingGoalContinuation(
          decision,
          state,
          { sessionGeneration, branchGeneration },
          operationId,
          options?.familyDispatchId,
        );
        pi.sendUserMessage(pendingContinuation.prompt, { deliverAs: "followUp" });
        return "model-follow-up";
      } finally {
        liveBinding.release();
      }
    });
  };

  const handleNonDispatchableDecision = async (
    ctx: ExtensionContext,
    decision: ReturnType<typeof selectGoalContinuation>,
  ): Promise<"continue" | "stop"> => {
    if (!state) return "stop";
    // The waiting stop happens only when no other action is runnable, so a
    // dialog here cannot stop an independent branch. Rule 1.1.1 holds.
    if (decision.kind === "stop-waiting-response") {
      const awaiting = awaitingInteractions(state)[0];
      if (awaiting) {
        const outcome = await presentAwaitingInteraction(ctx, awaiting);
        if (outcome === "answered") {
          paintUi(ctx);
          return "continue";
        }
        paintUi(ctx);
        if (outcome === "presentation-failed") {
          const observation = interactionPresentationObservation(state, awaiting.nodeId, awaiting.attemptId);
          const detail = observation?.error
            ? `${observation.status}: ${observation.error}`
            : (observation?.status ?? "failed");
          ctx.ui.notify(
            `Interaction '${awaiting.nodeId}' presentation ${detail}. The node is failed and does not wait for an answer.`,
            "warning",
          );
          return "stop";
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
        return "stop";
      }
    }
    if (decision.kind === "invariant-error") {
      if (state.goal?.status === "active") ctx.ui.notify(`Hypagoal cannot continue: ${decision.reason}`, "warning");
    } else {
      ctx.ui.notify(renderHypagoalLifecycleMessage(state), decision.kind === "stop-completed" ? "info" : "warning");
    }
    return "stop";
  };

  const queueGoalContinuation = async (ctx: ExtensionContext): Promise<void> => {
    // Post-create gate: interactive TUI must not auto-run until the user chooses Run.
    if (postCreateAwaitingUserChoice) return;
    // An open presentation defers deadline evaluation to the next controller
    // entry after the presentation ends. Level-triggered recovery still applies.
    // Non-root free-slot bind holds child state in free slots; do not re-enter
    // as if free slots were the desk root (Seam A).
    if (
      pendingContinuation
      || deliveredContinuation
      || !state
      || activeExecutions.hasActive()
      || activePresentations.size > 0
      || countUnsettledIsolatedWorkers(isolatedWorkerPool()) > 0
      || nonRootLiveSlotBindDepth > 0
    ) return;
    let deterministicDispatches = 0;

    // Level-triggered deadlines: evaluate before selecting the next action.
    await evaluateInteractionDeadlines(ctx, new Date().toISOString());
    if (!state) return;

    while (true) {
      let familyRecord = loadFamilyRecordForController(ctx);
      // Product child return: settle terminal children into parent bindings before selection.
      if (familyRecord) {
        const returnPass = await applyPendingChildReturns(ctx, familyRecord);
        familyRecord = returnPass.family;
        if (returnPass.applied > 0) {
          // Parent left wait or failed; re-load and select with updated membership.
          familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord;
        }
      }
      if (!state) return;
      // Ordinary product path: one shared policy object for select and commit.
      // Defaults only until ordinary config surface lands; Gate 1.2 enforces defaults.
      const ordinaryFamilyConcurrencyPolicy: FamilyProductConcurrencyPolicy = {};
      const controller = selectFamilyControllerAction({
        liveState: state,
        familyRecord,
        concurrencyPolicy: ordinaryFamilyConcurrencyPolicy,
      });

      if (controller.kind === "family-idle") {
        // Fall back to root lifecycle messaging when the family has no work.
        const rootDecision = selectGoalContinuation(state);
        if (!isDispatchableGoalContinuation(rootDecision)) {
          const handled = await handleNonDispatchableDecision(ctx, rootDecision);
          if (handled === "continue") continue;
          return;
        }
        // Family idle but root still has work should not happen for multi-member
        // complete input. Treat as stop with family reason.
        ctx.ui.notify(`Hypagoal family is idle: ${controller.reason}`, "info");
        return;
      }

      if (controller.kind === "family-blocked") {
        ctx.ui.notify(`Hypagoal family dispatch is blocked: ${controller.reason}`, "warning");
        return;
      }

      if (controller.kind === "family-incomplete") {
        ctx.ui.notify(
          `Hypagoal family member states are incomplete: ${controller.reason}`
          + (controller.missingGoalIds.length > 0
            ? ` Missing: ${controller.missingGoalIds.join(", ")}.`
            : "")
          + (controller.mismatchedGoalIds.length > 0
            ? ` Mismatched: ${controller.mismatchedGoalIds.join(", ")}.`
            : ""),
          "warning",
        );
        return;
      }

      if (controller.kind === "family-rejected") {
        ctx.ui.notify(
          `Hypagoal family concurrent selection was rejected: ${controller.reason}`,
          "warning",
        );
        return;
      }

      let decision: GoalDispatchableContinuation;
      let dispatchOutcome: "continue" | "stop" | "model-follow-up";

      if (controller.kind === "root-only") {
        if (!isDispatchableGoalContinuation(controller.decision)) {
          const handled = await handleNonDispatchableDecision(ctx, controller.decision);
          if (handled === "continue") continue;
          return;
        }
        decision = controller.decision;
        const deterministic = isReadyGateDecision(decision)
          || isReadyCheckDecision(decision)
          || isReadyCodeDecision(decision)
          || isDeterministicEffectDecision(decision)
          || decision.kind === "request-ready-interaction";
        if (deterministic && deterministicDispatches >= MAX_CONSECUTIVE_DETERMINISTIC_DISPATCHES) {
          ctx.ui.notify(
            `Hypagoal stopped automatic deterministic dispatch after ${MAX_CONSECUTIVE_DETERMINISTIC_DISPATCHES} consecutive actions in one controller pass. Review the graph before continuing.`,
            "warning",
          );
          return;
        }
        const rootMember = rootMemberContext();
        if (!rootMember) return;
        dispatchOutcome = await dispatchDecisionOnLiveState(ctx, rootMember, decision);
        if (deterministic) deterministicDispatches += 1;
      } else if (controller.kind === "dispatch-batch") {
        // S4 concurrent product path:
        // 1) Filter selection to free-seat model members plus deterministic members
        //    (itemsToCommit). Domain already bound pending occupancy.
        // 2) Commit only itemsToCommit (do not commit beyond free isolated seats).
        // 3) Mark every committed member dispatched before any host start.
        // 4) Start deterministic items serially; start model items concurrently
        //    without awaiting sibling completion before the next start.
        // 5) Settle each model pending under the free-slot lock on completion
        //    (independent-settle; member stream + pending in one critical section).
        // 6) Run one controller-level applyPendingChildReturns pass after model
        //    Promise.all (not per concurrent member).
        // Do not use modelSlots = 1 or deferred-interrupt for one isolated seat.
        const at = new Date().toISOString();
        const memberStates = buildFamilyControllerMemberStates(controller.family, state);
        const resolvedGlobalConcurrency = controller.concurrencyPolicy.globalConcurrency
          ?? DEFAULT_GLOBAL_CONCURRENCY;

        // Commit only free pool seats for model members (S4 Issue 8).
        // Domain selection already bounds pending occupancy. Align commit size with
        // free isolated seats so no committed pending is left selected without a
        // mark/start path. Interrupt remains only on mark failure.
        let modelSeatsFree = Math.max(
          0,
          resolvedGlobalConcurrency - countUnsettledIsolatedWorkers(isolatedWorkerPool()),
        );
        const itemsToCommit = controller.items.filter((item) => {
          if (isDeterministicFamilyMemberDecision(item.decision)) return true;
          if (modelSeatsFree > 0) {
            modelSeatsFree -= 1;
            return true;
          }
          return false;
        });
        if (itemsToCommit.length === 0) {
          ctx.ui.notify(
            `Hypagoal concurrent batch had no free isolated seats under globalConcurrency `
            + `${resolvedGlobalConcurrency}. No members were committed.`,
            "info",
          );
          return;
        }
        if (itemsToCommit.length < controller.items.length) {
          ctx.ui.notify(
            `Hypagoal concurrent batch committed ${itemsToCommit.length} of `
            + `${controller.items.length} selected members (pool free seats). `
            + "Uncommitted members can be selected again when seats free.",
            "info",
          );
        }

        const committed = commitConcurrentFamilyBatchForHost({
          family: controller.family.familySnapshot,
          memberStates,
          items: itemsToCommit,
          at,
          maxBatchSize: controller.maxBatchSize,
          // Same raw object as selection; prefer resolved policy from the decision.
          concurrencyPolicy: ordinaryFamilyConcurrencyPolicy,
          resolvedConcurrencyPolicy: controller.concurrencyPolicy,
          createDispatchId: (index, item) =>
            `family-concurrent:${controller.family.familySnapshot.familyId}:${item.memberGoalId}:${index}:${randomUUID()}`,
        });
        if (!committed.ok) {
          ctx.ui.notify(
            `Hypagoal could not commit concurrent family batch. `
            + committed.diagnostics.map((d) => d.message).join("; "),
            "warning",
          );
          return;
        }
        familyRecord = persistFamilySnapshotUpdate(
          controller.family,
          committed.family,
          committed.events,
        );

        ctx.ui.notify(
          `Hypagoal family concurrent batch selected ${committed.items.length} members: `
          + committed.items.map((item) => item.memberGoalId).join(", ") + ".",
          "info",
        );

        type BatchStartItem = (typeof committed.items)[number];
        // All committed items are startable (commit already aligned to free seats).
        const startableItems: BatchStartItem[] = [...committed.items];
        familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord;

        // Mark every startable pending as dispatched before any member host start.
        // S5: refresh memberState from the family bag at mark time. Do not pass
        // the selection-time clone. A selection-time clone can make mark accept
        // a member stream that advanced after select.
        const markedItems: BatchStartItem[] = [];
        for (const item of startableItems) {
          familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord;
          const marked = markFamilyPendingDispatchedWithRefreshedMemberState({
            familyRecord,
            dispatchId: item.dispatchId,
            at: new Date().toISOString(),
            memberGoalId: item.memberGoalId,
            memberWorkflowId: item.memberWorkflowId,
            liveState: state,
          });
          if (!marked.ok) {
            ctx.ui.notify(
              `Hypagoal could not mark family dispatch '${item.dispatchId}' as dispatched. `
              + `Member '${item.memberGoalId}' was not started. `
              + marked.diagnostics.map((d) => d.message).join("; "),
              "warning",
            );
            settleFamilyDispatchById(
              item.dispatchId,
              "interrupted",
              `Could not mark family dispatch '${item.dispatchId}' as dispatched.`,
              ctx,
            );
            familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord;
            continue;
          }
          familyRecord = persistFamilySnapshotUpdate(
            familyRecord,
            marked.family,
            marked.events,
          );
          // Keep mark-time isLiveRoot (stable family root identity) for start routing.
          markedItems.push({
            ...item,
            memberState: marked.memberState,
            isLiveRoot: marked.isLiveRoot,
          });
        }

        type BatchStartOutcome = {
          item: BatchStartItem;
          itemOutcome: "continue" | "stop" | "model-follow-up";
        };
        const deterministicMarked = markedItems.filter((item) =>
          isDeterministicFamilyMemberDecision(item.decision)
        );
        const modelMarked = markedItems.filter((item) =>
          !isDeterministicFamilyMemberDecision(item.decision)
        );

        // Deterministic items share host resources; run serially and settle each.
        // S5: refresh memberState again at start (family bag may have advanced
        // after intermediate marks or sibling settles within this pass).
        // Keep mark-time item.isLiveRoot for routing; do not reclassify from free slots.
        // Re-validate hash/action against the pending after refresh.
        const startOutcomes: BatchStartOutcome[] = [];
        for (const item of deterministicMarked) {
          familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord;
          const refreshed = refreshFamilyProductMemberState({
            familyRecord,
            memberGoalId: item.memberGoalId,
            memberWorkflowId: item.memberWorkflowId,
            liveState: state,
          });
          if (!refreshed.ok) {
            ctx.ui.notify(
              `Hypagoal could not refresh member '${item.memberGoalId}' for start. `
              + refreshed.diagnostics.map((d) => d.message).join("; "),
              "warning",
            );
            startOutcomes.push({ item, itemOutcome: "stop" });
            settleFamilyDispatchById(
              item.dispatchId,
              "interrupted",
              `Could not refresh member '${item.memberGoalId}' at start time.`,
              ctx,
            );
            familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord;
            continue;
          }
          const pendingMatch = validateMemberStateAgainstFamilyPending({
            family: familyRecord.familySnapshot,
            dispatchId: item.dispatchId,
            memberState: refreshed.memberState,
          });
          if (!pendingMatch.ok) {
            ctx.ui.notify(
              `Hypagoal start validation failed for member '${item.memberGoalId}'. `
              + pendingMatch.diagnostics.map((d) => d.message).join("; "),
              "warning",
            );
            startOutcomes.push({ item, itemOutcome: "stop" });
            settleFamilyDispatchById(
              item.dispatchId,
              "interrupted",
              `Start validation failed for member '${item.memberGoalId}'.`,
              ctx,
            );
            familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord;
            continue;
          }
          const itemOutcome = await dispatchSelectedMemberAction(
            ctx,
            {
              kind: "dispatch",
              memberGoalId: item.memberGoalId,
              memberWorkflowId: item.memberWorkflowId,
              memberState: refreshed.memberState,
              // Mark-time stable family root identity; not free-slot occupancy.
              isLiveRoot: item.isLiveRoot,
              decision: item.decision,
              family: familyRecord,
              selectionReason: item.selectionReason,
              concurrencyPolicy: controller.concurrencyPolicy,
            },
            {
              familyDispatchId: item.dispatchId,
              globalConcurrency: resolvedGlobalConcurrency,
            },
          );
          startOutcomes.push({ item, itemOutcome });
          deterministicDispatches += 1;
          const settleOutcome = familySettleOutcomeFromHostDispatch(itemOutcome);
          if (settleOutcome) {
            familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord;
            settleFamilyDispatchById(
              item.dispatchId,
              settleOutcome,
              itemOutcome === "stop"
                ? `Member '${item.memberGoalId}' host dispatch stopped.`
                : undefined,
              ctx,
            );
            familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord;
          }
        }

        // Model items: start concurrently. Do not await sibling completion before
        // the next start. Settle each pending when that worker completes (S4).
        // S5: refresh memberState content from the family bag at start. Keep
        // mark-time item.isLiveRoot for routing (stable family root identity).
        // Free slots may hold a sibling during concurrent start; do not reclassify.
        const modelWork = modelMarked.map(async (item) => {
          const recordForStart = loadFamilyRecordForController(ctx) ?? familyRecord;
          if (!recordForStart) {
            return {
              item,
              itemOutcome: "stop" as const,
            } satisfies BatchStartOutcome;
          }
          familyRecord = recordForStart;
          const refreshed = refreshFamilyProductMemberState({
            familyRecord: recordForStart,
            memberGoalId: item.memberGoalId,
            memberWorkflowId: item.memberWorkflowId,
            liveState: state,
          });
          if (!refreshed.ok) {
            ctx.ui.notify(
              `Hypagoal could not refresh member '${item.memberGoalId}' for start. `
              + refreshed.diagnostics.map((d) => d.message).join("; "),
              "warning",
            );
            await withIsolatedFreeSlotLock(async () => {
              familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord ?? latestFamilyRecord;
              if (familyRecord?.familySnapshot.pendingDispatches[item.dispatchId]) {
                settleFamilyDispatchById(
                  item.dispatchId,
                  "interrupted",
                  `Could not refresh member '${item.memberGoalId}' at start time.`,
                  ctx,
                );
              }
              familyRecord = latestFamilyRecord ?? familyRecord;
            });
            return { item, itemOutcome: "stop" as const } satisfies BatchStartOutcome;
          }
          const pendingMatch = validateMemberStateAgainstFamilyPending({
            family: recordForStart.familySnapshot,
            dispatchId: item.dispatchId,
            memberState: refreshed.memberState,
          });
          if (!pendingMatch.ok) {
            ctx.ui.notify(
              `Hypagoal start validation failed for member '${item.memberGoalId}'. `
              + pendingMatch.diagnostics.map((d) => d.message).join("; "),
              "warning",
            );
            await withIsolatedFreeSlotLock(async () => {
              familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord ?? latestFamilyRecord;
              if (familyRecord?.familySnapshot.pendingDispatches[item.dispatchId]) {
                settleFamilyDispatchById(
                  item.dispatchId,
                  "interrupted",
                  `Start validation failed for member '${item.memberGoalId}'.`,
                  ctx,
                );
              }
              familyRecord = latestFamilyRecord ?? familyRecord;
            });
            return { item, itemOutcome: "stop" as const } satisfies BatchStartOutcome;
          }
          const itemOutcome = await dispatchSelectedMemberAction(
            ctx,
            {
              kind: "dispatch",
              memberGoalId: item.memberGoalId,
              memberWorkflowId: item.memberWorkflowId,
              memberState: refreshed.memberState,
              // Mark-time stable family root identity; not free-slot occupancy.
              isLiveRoot: item.isLiveRoot,
              decision: item.decision,
              family: recordForStart,
              selectionReason: item.selectionReason,
              concurrencyPolicy: controller.concurrencyPolicy,
            },
            {
              familyDispatchId: item.dispatchId,
              globalConcurrency: resolvedGlobalConcurrency,
              // One controller-level child-return pass after Promise.all (Issue 9).
              deferChildReturn: true,
            },
          );
          // Isolated path settles the family pending under the free-slot lock in
          // runSettle (Issue 7). Only settle here when the pending is still open
          // (deterministic residual, start failure, or non-isolated path).
          const settleOutcome = familySettleOutcomeFromHostDispatch(itemOutcome);
          if (settleOutcome) {
            await withIsolatedFreeSlotLock(async () => {
              familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord ?? latestFamilyRecord;
              if (familyRecord?.familySnapshot.pendingDispatches[item.dispatchId]) {
                settleFamilyDispatchById(
                  item.dispatchId,
                  settleOutcome,
                  itemOutcome === "stop"
                    ? `Member '${item.memberGoalId}' host dispatch stopped.`
                    : undefined,
                  ctx,
                );
              }
              familyRecord = latestFamilyRecord ?? familyRecord;
            });
          }
          return { item, itemOutcome } satisfies BatchStartOutcome;
        });
        // Fire all model starts together; workers run concurrently under the pool.
        const modelOutcomes = await Promise.all(modelWork);
        startOutcomes.push(...modelOutcomes);

        // One child-return pass after all concurrent model workers finish (Issue 9).
        // applyPendingChildReturns reloads under free-slot lock per return.
        let childReturnsApplied = 0;
        familyRecord = loadFamilyRecordForController(ctx) ?? latestFamilyRecord ?? familyRecord;
        if (familyRecord) {
          const returnPass = await applyPendingChildReturns(ctx, familyRecord);
          familyRecord = returnPass.family;
          childReturnsApplied = returnPass.applied;
          if (childReturnsApplied > 0) {
            // Parent may have left wait; drop stale model follow-up and continue.
            pendingContinuation = undefined;
          }
        }

        let batchContinue = false;
        let batchModelFollowUp = false;
        for (const { itemOutcome } of startOutcomes) {
          if (itemOutcome === "continue") batchContinue = true;
          if (itemOutcome === "model-follow-up") batchModelFollowUp = true;
        }
        if (childReturnsApplied > 0) {
          batchContinue = true;
        }
        // Pool still has unsettled workers only when a path left them registered
        // without settling (should not happen for isolated await). Keep honesty.
        if (countUnsettledIsolatedWorkers(isolatedWorkerPool()) > 0) {
          batchModelFollowUp = true;
        }

        if (batchModelFollowUp) {
          dispatchOutcome = "model-follow-up";
        } else if (batchContinue) {
          dispatchOutcome = "continue";
        } else {
          dispatchOutcome = "stop";
        }
      } else {
        // Multi-member sequential family selection (concurrent off or maxBatchSize 1).
        decision = controller.decision;
        const deterministic = isReadyGateDecision(decision)
          || isReadyCheckDecision(decision)
          || isReadyCodeDecision(decision)
          || isDeterministicEffectDecision(decision)
          || decision.kind === "request-ready-interaction";
        if (deterministic && deterministicDispatches >= MAX_CONSECUTIVE_DETERMINISTIC_DISPATCHES) {
          ctx.ui.notify(
            `Hypagoal stopped automatic deterministic dispatch after ${MAX_CONSECUTIVE_DETERMINISTIC_DISPATCHES} consecutive actions in one controller pass. Review the graph before continuing.`,
            "warning",
          );
          return;
        }
        if (!controller.isLiveRoot) {
          ctx.ui.notify(
            `Hypagoal family selected member '${controller.memberGoalId}' `
            + `(${decision.kind}${decision.kind !== "request-revision" ? ` '${decision.nodeId}'` : ""}).`,
            "info",
          );
        }
        // Commit sequential pending so settle targets a durable dispatchId.
        const sequentialAt = new Date().toISOString();
        const sequentialStates = buildFamilyControllerMemberStates(controller.family, state);
        const sequentialDispatchId =
          `family-sequential:${controller.family.familySnapshot.familyId}:${controller.memberGoalId}:${randomUUID()}`;
        const sequentialCommit = commitSequentialFamilySelectionForHost({
          family: controller.family.familySnapshot,
          memberStates: sequentialStates,
          at: sequentialAt,
          dispatchId: sequentialDispatchId,
        });
        if (!sequentialCommit.ok) {
          ctx.ui.notify(
            `Hypagoal could not commit sequential family selection. `
            + sequentialCommit.diagnostics.map((d) => d.message).join("; "),
            "warning",
          );
          return;
        }
        if (sequentialCommit.events.length === 0) {
          // Idle commit: no durable pending. Do not start member work.
          ctx.ui.notify("Hypagoal sequential family selection was idle.", "info");
          return;
        }
        familyRecord = persistFamilySnapshotUpdate(
          controller.family,
          sequentialCommit.family,
          sequentialCommit.events,
        );
        // S5: refresh memberState at mark from the live family bag (not selection-time).
        const sequentialMarked = markFamilyPendingDispatchedWithRefreshedMemberState({
          familyRecord,
          dispatchId: sequentialDispatchId,
          at: new Date().toISOString(),
          memberGoalId: controller.memberGoalId,
          memberWorkflowId: controller.memberWorkflowId,
          liveState: state,
        });
        if (!sequentialMarked.ok) {
          ctx.ui.notify(
            `Hypagoal could not mark family dispatch '${sequentialDispatchId}' as dispatched. `
            + `Member '${controller.memberGoalId}' was not started. `
            + sequentialMarked.diagnostics.map((d) => d.message).join("; "),
            "warning",
          );
          // Interrupt the committed selected pending so sequential selection is not blocked.
          settleFamilyDispatchById(
            sequentialDispatchId,
            "interrupted",
            `Could not mark family dispatch '${sequentialDispatchId}' as dispatched.`,
            ctx,
          );
          return;
        }
        familyRecord = persistFamilySnapshotUpdate(
          familyRecord,
          sequentialMarked.family,
          sequentialMarked.events,
        );
        // S5: refresh again at start in case the family bag advanced after mark.
        // Keep mark-time isLiveRoot for routing. Re-validate hash/action vs pending.
        familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord;
        const sequentialStart = refreshFamilyProductMemberState({
          familyRecord,
          memberGoalId: controller.memberGoalId,
          memberWorkflowId: controller.memberWorkflowId,
          liveState: state,
        });
        if (!sequentialStart.ok) {
          ctx.ui.notify(
            `Hypagoal could not refresh member '${controller.memberGoalId}' for start. `
            + sequentialStart.diagnostics.map((d) => d.message).join("; "),
            "warning",
          );
          settleFamilyDispatchById(
            sequentialDispatchId,
            "interrupted",
            `Could not refresh member '${controller.memberGoalId}' at start time.`,
            ctx,
          );
          return;
        }
        const sequentialPendingMatch = validateMemberStateAgainstFamilyPending({
          family: familyRecord.familySnapshot,
          dispatchId: sequentialDispatchId,
          memberState: sequentialStart.memberState,
        });
        if (!sequentialPendingMatch.ok) {
          ctx.ui.notify(
            `Hypagoal start validation failed for member '${controller.memberGoalId}'. `
            + sequentialPendingMatch.diagnostics.map((d) => d.message).join("; "),
            "warning",
          );
          settleFamilyDispatchById(
            sequentialDispatchId,
            "interrupted",
            `Start validation failed for member '${controller.memberGoalId}'.`,
            ctx,
          );
          return;
        }
        dispatchOutcome = await dispatchSelectedMemberAction(
          ctx,
          {
            ...controller,
            memberState: sequentialStart.memberState,
            // Mark-time stable family root identity; not free-slot occupancy.
            isLiveRoot: sequentialMarked.isLiveRoot,
            family: familyRecord,
          },
          { familyDispatchId: sequentialDispatchId },
        );
        // Reload after member host work so child workflow progress is not overwritten.
        familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord;
        const settleOutcome = familySettleOutcomeFromHostDispatch(dispatchOutcome);
        if (settleOutcome) {
          settleFamilyDispatchById(
            sequentialDispatchId,
            settleOutcome,
            dispatchOutcome === "stop"
              ? `Member '${controller.memberGoalId}' host dispatch stopped.`
              : undefined,
            ctx,
          );
          familyRecord = loadFamilyRecordForController(ctx) ?? familyRecord;
        }
        if (deterministic) deterministicDispatches += 1;
      }

      // Demo: hold after each deterministic step so the live graph is readable.
      // Skip hold before interaction presentation and when the controller stops.
      if (
        demoPacingEnabled
        && dispatchOutcome === "continue"
        && ctx.hasUI
      ) {
        const holdMs = demoDispatchHoldMs();
        if (holdMs > 0) {
          paintUi(ctx);
          await sleepDemoHold(holdMs);
        }
      }

      if (dispatchOutcome === "continue") continue;
      return;
    }
  };

  const nodeIdRequired = (nodeId: string | undefined): string => {
    if (!nodeId) throw new Error("This action requires a node ID.");
    return nodeId;
  };

  const cancelActiveChecks = (nodeId: string | undefined, reason: string): string[] => {
    if (!state) throw new Error("There is no active Hypagraph. Call hypagoal_start first.");
    return activeExecutions.cancel({
      workflowId: state.workflowId,
      ...(nodeId ? { nodeId } : {}),
      reason,
    }).map((entry) => entry.nodeId);
  };

  pi.on("session_start", async (_event, ctx) => {
    await restore(ctx, false);
    // Register live trigger highlight only for interactive TUI. Headless is a no-op.
    hypagoalTriggerEditor?.dispose();
    hypagoalTriggerEditor = registerHypagoalTriggerEditor(
      ctx,
      () => hypagoalTriggerSettings,
    );
  });
  pi.on("session_tree", async (_event, ctx) => restore(ctx, true));
  pi.on("session_shutdown", async () => {
    pendingContinuation = undefined;
    deliveredContinuation = undefined;
    hypagoalArmedForTurn = false;
    staleContinuationTurn = false;
    revisionProposalHandled = false;
    restoreContinuationTools();
    activeExecutions.cancelAll();
    activeCodeExecutions.cancelAll("session_shutdown");
    activeEffectExecutions.cancelAll("session_shutdown");
    // Abort and cancel every in-flight member worker before process teardown (R3 / S4).
    // Deep-clone cancel mirrors; session_shutdown has no branch ctx — use latestFamilyRecord.
    const shutdownRoots = listUnsettledIsolatedWorkers(isolatedWorkerPool())
      .map((entry) => cloneActiveIsolatedForTeardown(entry));
    abortActiveIsolatedRootAttempt("The Pi session shut down before the isolated worker completed.");
    for (const shutdownRoot of shutdownRoots) {
      try {
        await settleTrackedIsolatedAttempt({
          tracked: shutdownRoot,
          reason: "The Pi session shut down before the isolated model worker completed.",
          correlationId: `isolated-root-shutdown:${randomUUID()}`,
          ...(latestFamilyRecord === undefined ? {} : { family: latestFamilyRecord }),
        });
      } catch {
        // Shutdown must still tear down processes.
      }
    }
    clearIsolatedWorkerPool(isolatedWorkerPool());
    // Reclaim owned isolated Pi children so they do not orphan after session end.
    await isolatedPiController.teardownOnRestore({
      kind: "other",
      reason: "The Pi session shut down before the isolated Pi attempt completed.",
    });
    bindActiveIsolatedPiHost(undefined);
    graphPane.dispose();
    hypagoalTriggerEditor?.dispose();
    widgetAnimation.dispose();
    widgetPaintCtx = undefined;
    hypagoalTriggerEditor = undefined;
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "extension" && event.streamingBehavior !== undefined) {
      suppressContinuationAtNextAgentEnd = true;
    }
    // Arming lasts for one user turn. Clear any previous arm before re-evaluate.
    // Extension-sourced messages do not arm; they are controller or tool text.
    if (event.source === "extension") {
      return { action: "continue" as const };
    }
    const armed = messageArmsHypagoal(event.text, hypagoalTriggerSettings);
    hypagoalArmedForTurn = armed;
    paintHypagoalArmingStatus(ctx);
    // Return continue so the message is unchanged. Arming creates no state.
    return { action: "continue" as const };
  });

  pi.on("agent_end", async (_event, ctx) => {
    hypagoalAuthoring = undefined;
    // Arming is one-turn only. Clear after the agent run ends.
    clearHypagoalArming(ctx);
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
        paintUi(ctx);
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
      paintUi(ctx);
    }
    if (deliveredContinuation) {
      const delivered = deliveredContinuation;
      const familyDispatchId = delivered.familyDispatchId;
      deliveredContinuation = undefined;
      const goal = state?.goal;
      const revisionRequest = goal?.pendingContinuation;
      if (!state || !goal) {
        settleFamilyDispatchById(
          familyDispatchId,
          "interrupted",
          "Family model follow-up ended without active goal state.",
          ctx,
        );
        return;
      }
      // Terminal goals clear pendingContinuation on complete/fail/cancel. The
      // host still holds delivery bookkeeping. Do not treat this as a missing
      // goal: notify the terminal lifecycle and stop without usage accounting.
      if (!revisionRequest) {
        paintUi(ctx);
        if (["completed", "cancelled", "failed"].includes(goal.status)) {
          ctx.ui.notify(
            renderHypagoalLifecycleMessage(state),
            goal.status === "completed" ? "info" : "warning",
          );
          settleFamilyDispatchById(
            familyDispatchId,
            goal.status === "completed" ? "completed" : "failed",
            `Goal reached terminal status '${goal.status}' after model follow-up.`,
            ctx,
          );
        } else {
          settleFamilyDispatchById(
            familyDispatchId,
            "interrupted",
            "Model follow-up ended without a durable continuation request.",
            ctx,
          );
        }
        return;
      }
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
        paintUi(ctx);
        ctx.ui.notify(`Hypagoal paused because usage could not be accounted. ${normalized.message}`, "warning");
        ctx.ui.notify(renderHypagoalLifecycleMessage(state!), "warning");
        settleFamilyDispatchById(
          familyDispatchId,
          "failed",
          `Usage could not be accounted: ${normalized.message}`,
          ctx,
        );
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
        settleFamilyDispatchById(
          familyDispatchId,
          "failed",
          "Goal turn usage was not recorded.",
          ctx,
        );
        return;
      }
      state = recorded.value.state;
      events.push(...recorded.value.events);
      paintUi(ctx);
      if (state.goal?.status === "budget_limited") {
        ctx.ui.notify(renderHypagoalLifecycleMessage(state), "warning");
        settleFamilyDispatchById(
          familyDispatchId,
          "failed",
          "Goal reached budget_limited after model follow-up.",
          ctx,
        );
        return;
      }
      if (semanticSequenceBeforeAccounting === delivered.committedSequence) {
        ctx.ui.notify(`Hypagoal continuation '${delivered.operationId}' made no canonical progress. Automatic continuation stopped.`, "warning");
        settleFamilyDispatchById(
          familyDispatchId,
          "failed",
          "Model follow-up made no canonical progress.",
          ctx,
        );
        return;
      }
      // Accepted model-lane progress. Clear the family multi-pending dispatch.
      settleFamilyDispatchById(familyDispatchId, "completed", undefined, ctx);
    } else {
      // A durable request without delivery bookkeeping blocks later selection.
      await recoverOrphanedModelContinuation(
        ctx,
        "The model-lane continuation had no delivered turn bookkeeping. The controller closed it and selected the next action.",
      );
    }
    // After create, present Run / Question / Cancel before any auto-continue.
    const mayContinue = await resolvePostCreateGate(ctx);
    if (!mayContinue) return;
    await queueGoalContinuation(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const armingBlock = hypagoalArmedForTurn && hypagoalTriggerSettings.word
      ? `\n\n${hypagoalArmedPromptBlock(hypagoalTriggerSettings.word)}`
      : "";

    if (hypagoalAuthoring !== undefined) {
      return {
        systemPrompt: `${event.systemPrompt}\n\nHYPAGOAL AUTHORING CONTROL:\nInspect repository context and author one complete canonical workflow. The user supplied an objective, not a graph. Do not modify repository files, run workflow nodes, start checks, invoke executors, or continue implementation. Call hypagoal_start once as the final action.${armingBlock}`,
      };
    }

    // After create, until the user chooses Run, answer questions only. Do not start work.
    if (postCreateAwaitingUserChoice && state?.goal) {
      return {
        systemPrompt: [
          event.systemPrompt,
          "",
          "POST-CREATE HYPAGOAL GATE:",
          "The Hypagoal graph is created and waits for the user to choose Run.",
          "Do not start tasks, run checks, revise the graph, or change repository files.",
          "Answer questions about the graph. Use hypagraph_read to inspect state.",
          "Use hypagraph_validate only for pure definition checks with no create side effect.",
          "Autonomous work starts only after the user chooses Run or /hypagraph resume.",
          "",
          renderWorkflow(state),
          armingBlock,
        ].filter((line) => line !== undefined).join("\n"),
      };
    }

    if (pendingContinuation) {
      const pending = pendingContinuation;
      const familyDispatchId = pending.familyDispatchId;
      const validation = validatePendingGoalContinuation(
        pending,
        state,
        { sessionGeneration, branchGeneration },
      );
      pendingContinuation = undefined;
      const abandonOpts = {
        ctx,
        ...(familyDispatchId !== undefined ? { familyDispatchId } : {}),
      };
      if (event.prompt !== pending.prompt) {
        await abandonPendingContinuation(
          "A user or tool message took priority over the queued continuation.",
          abandonOpts,
        );
        suppressContinuationAtNextAgentEnd = true;
      } else if (!validation.ok || !state) {
        await abandonPendingContinuation(
          validation.message ?? "The queued continuation became stale.",
          abandonOpts,
        );
        suppressContinuationAtNextAgentEnd = true;
        staleContinuationTurn = true;
        ctx.ui.notify(`Hypagoal continuation stopped: ${validation.code ?? "stale_continuation"} — ${validation.message ?? "The continuation is stale."}`, "warning");
        return {
          systemPrompt: `${event.systemPrompt}\n\nSTALE HYPAGOAL CONTINUATION:\n${validation.code ?? "stale_continuation"}: ${validation.message ?? "The continuation is stale."} Do not change repository files or canonical workflow state during this turn.${armingBlock}`,
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
          systemPrompt: `${event.systemPrompt}\n\n${continuationSystemPrompt(pending, state)}\n\n${renderWorkflow(state)}${armingBlock}`,
        };
      }
    }

    if (!state || ["completed", "cancelled", "failed", "blocked"].includes(state.phase) || state.goal?.status === "budget_limited" || state.goal?.status === "blocked") {
      // Arming is the product path when no controller is active yet.
      if (armingBlock.length > 0) return { systemPrompt: `${event.systemPrompt}${armingBlock}` };
      return;
    }
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
      systemPrompt: `${event.systemPrompt}\n\nHYPAGRAPH CONTROL:\n${renderWorkflow(state)}\nUse hypagraph_transition before and after task work. Use hypagraph_run_check for a ready or retryable check node. Use hypagraph_cancel_check to stop an active check. Work only on the active task node. Publish declared task facts before result submission. Submit task evidence before a separate verification action. Evaluate ready gates with the evaluate action. Ready nodes are [${ready.join(", ")}]. Runnable checks are [${runnableChecks.join(", ")}].${active ? ` The active node is '${active.id}'.` : " Start one ready task, run one runnable check, or evaluate one ready gate before you change the repository."}${armingBlock}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    // Pure hypagraph_validate stays available on a stale-continuation turn.
    if (staleContinuationTurn && [
      "write",
      "edit",
      "hypagoal_start",
      "hypagoal_create_child",
      "hypagraph_transition",
      "hypagraph_run_check",
      "hypagraph_cancel_check",
      "hypagraph_revise",
      "hypagoal_submit_revision",
    ].includes(event.toolName)) {
      return { block: true, reason: "The queued Hypagoal continuation is stale. Read current state before another canonical change." };
    }
    // Post-create gate: block work tools until the user chooses Run.
    // Allow pure read and validate tools so Question turns can inspect the graph.
    if (postCreateAwaitingUserChoice && isHypagraphWorkMutatingTool(event.toolName)) {
      return {
        block: true,
        reason: POST_CREATE_GATE_BLOCK_REASON,
      };
    }
    // While any isolated worker owns mutating task work, block the family desk
    // from acting as a second writer on repository tools. Create-child is family
    // control: allowed for any active parent task (isolated or current-session).
    const unsettledForGate = listUnsettledIsolatedWorkers(isolatedWorkerPool());
    if (
      unsettledForGate.length > 0
      && isHypagraphWorkMutatingTool(event.toolName)
      && !isHypagraphFamilyControlToolDuringWorker(event.toolName)
    ) {
      const firstWorker = unsettledForGate[0]!;
      return {
        block: true,
        reason: activeWorkerGateBlockReason(
          firstWorker.nodeId,
          firstWorker.attemptId,
        ),
      };
    }
    if (hypagoalAuthoring !== undefined && isHypagraphAuthoringBlockedTool(event.toolName)) {
      return { block: true, reason: AUTHORING_GATE_BLOCK_REASON };
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
    description: "Atomically create and persist one root graph-backed goal from an ordinary prose objective. Prefer draftId when construction tools cover the graph. Use free-form definition for interaction, gate, code, and effect nodes (constructors do not yet build those kinds), and for tests or import.",
    promptSnippet: "Create a root Hypagoal from a prose objective",
    promptGuidelines: [
      "Prefer hypagoal_start with draftId after hypagraph_draft_validate when constructors cover the graph.",
      "Use free-form definition for interaction, gate, code, and effect nodes, and for tests or import.",
      "hypagoal_start accepts authoring advisories separately from canonical workflow fields and never accepts terminal goal state.",
      "Do not hand-author feedbackEdges. Use hypagraph_loop, hypagraph_recipe_implement_verify_loop, or hypagraph_recipe_implement_parallel_review.",
      "If hypagoal_start rejects the draft or definition, repair with tools and call hypagoal_start again with the same creationRequest.",
      "Call hypagoal_start as the final action of a Hypagoal authoring turn. It creates durable state but does not continue execution.",
    ],
    parameters: hypagoalStartSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      ensureNoActiveExecution();
      let input: ReturnType<typeof normalizeHypagoalStartInput>;
      try {
        input = normalizeHypagoalStartInput(params);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Hypagoal was not created. Canonical state is unchanged.\nhypagoal_start_invalid: ${message}` }],
          details: { hypagoal: { kind: "rejected", diagnostics: [{ code: "hypagoal_start_invalid", message }] } },
          terminate: true,
        };
      }
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
      } else if (suppliedCreation && !input.draftId) {
        // Free-form definition cannot carry a creationRequest without an active authoring turn.
        return rejectCreationRequest(
          "stale_hypagoal_creation_request",
          "The creationRequest no longer belongs to an active /hypagoal authoring turn.",
        );
      }

      // Prefer draftId when constructors cover the graph. Free-form definition is
      // the supported path for interaction, gate, code, and effect nodes.
      let definition = input.definition;
      let sourceDraftId: string | undefined;
      let sourceDraft: HypagraphDraftRecord | undefined;
      if (input.draftId) {
        sourceDraftId = input.draftId;
        const store = new HypagraphProjectStore(ctx.cwd);
        let draft: HypagraphDraftRecord | undefined;
        try {
          await store.ensureInitialized();
          draft = await store.readDraft(input.draftId);
        } catch (error) {
          const message = error instanceof ProjectStoreError
            ? error.message
            : error instanceof Error ? error.message : String(error);
          const code = error instanceof ProjectStoreError ? error.code : "project_store_unavailable";
          return rejectCreationRequest(code, message);
        }
        if (!draft) {
          return rejectCreationRequest(
            "draft_not_found",
            `Draft '${input.draftId}' was not found under .hypagraph/drafts.`,
          );
        }
        if (draft.status === "discarded" || draft.status === "committed") {
          return rejectCreationRequest(
            "draft_not_open",
            `Draft '${input.draftId}' has status '${draft.status}' and cannot be committed.`,
          );
        }
        // Bound drafts require a matching creationRequest. Active authoring must also match.
        const identityError = validateDraftCommitIdentity(draft, {
          ...(suppliedCreation === undefined ? {} : { suppliedCreationRequest: suppliedCreation }),
          ...(pending === undefined ? {} : { activeCreationRequest: pending.creationRequest }),
        });
        if (identityError) {
          return rejectCreationRequest(
            identityError.code,
            `${identityError.message}${identityError.suggestion ? ` ${identityError.suggestion}` : ""}`,
          );
        }
        // Supplied creationRequest without active authoring is allowed only when it matches a bound draft.
        if (!pending && suppliedCreation && draft.creationRequest === undefined) {
          return rejectCreationRequest(
            "stale_hypagoal_creation_request",
            "The creationRequest no longer belongs to an active /hypagoal authoring turn.",
          );
        }
        const projected = projectDraftDefinition(draft);
        if (!projected.ok) {
          return {
            content: [{
              type: "text" as const,
              text: `Hypagoal was not created. Canonical state is unchanged.\n${formatDiagnostics(projected.diagnostics)}`,
            }],
            details: {
              hypagoal: {
                kind: "rejected",
                diagnostics: structuredClone(projected.diagnostics),
                draftId: input.draftId,
              },
            },
            terminate: true,
          };
        }
        definition = projected.definition;
        sourceDraft = draft;
      }

      if (!definition) {
        return rejectCreationRequest(
          "hypagoal_start_invalid",
          "hypagoal_start requires draftId or definition. Prefer draftId after authoring with construction tools.",
        );
      }

      const creationOperationId = pending?.creationRequest.operationId ?? `hypagoal-start:${randomUUID()}`;
      const objective = pending?.objective ?? input.objective;
      const replacementConfirmation = pending?.replacementConfirmation ?? input.replacementConfirmation;
      const workflowId = randomUUID();
      const goalId = `goal-${randomUUID()}`;
      const createdAt = new Date().toISOString();
      // Ordinary create is not a paced demo tour.
      demoPacingEnabled = false;
      demoTour = undefined;
      const result = await startRootHypagoal(eventStore.lease(), state, {
        objective,
        definition,
        workflowId,
        goalId,
        goalWorkflowId: workflowId,
        at: createdAt,
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
        setSessionRootWorkflowId(sessionContext, state.workflowId);
        // Project store artifacts. Runtime authority remains the event stream.
        // Failure is visible to the user and on status; create still succeeds.
        projectStoreArtifactWritten = false;
        childProjectStoreArtifactWritten = undefined;
        childProjectStoreWorkflowId = undefined;
        try {
          const store = new HypagraphProjectStore(ctx.cwd);
          await store.ensureInitialized();
          await store.writeCommittedWorkflow({
            workflowId: state.workflowId,
            ...(state.goal?.goalId === undefined ? {} : { goalId: state.goal.goalId }),
            objective: state.definition.goal,
            title: state.definition.title,
            definition: state.definition,
            definitionRevision: state.revision,
            ...(sourceDraftId === undefined ? {} : { sourceDraftId }),
            at: createdAt,
          });
          if (sourceDraft && sourceDraftId) {
            const committed: HypagraphDraftRecord = {
              ...sourceDraft,
              status: "committed",
              updatedAt: createdAt,
              goal: state.definition.goal,
              title: state.definition.title,
            };
            await store.writeDraft(committed);
            await store.appendDraftHistory(sourceDraftId, {
              code: "draft_committed",
              message: `Committed as workflow '${state.workflowId}'.`,
              workflowId: state.workflowId,
            });
          }
          projectStoreArtifactWritten = true;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          projectStoreArtifactWritten = false;
          ctx.ui.notify(
            `Hypagoal created, but project-store definition artifacts were not written (${detail}). `
            + "Runtime state is active. Check /hypagraph status for artifact state.",
            "warning",
          );
        }
        // Interactive TUI: gate auto-continue until the user chooses Run.
        // Headless and non-TUI hosts keep auto-continue after agent_end.
        if (hostSupportsPostCreateDock(ctx)) {
          postCreateAwaitingUserChoice = true;
          postCreateDockPresented = false;
        } else {
          clearPostCreateGate();
        }
        paintUi(ctx);
        const mermaidSource = projectMermaidFlowchart(projectGraphView(state)).source;
        return {
          content: [{ type: "text" as const, text: renderHypagoalCreated(result) }],
          details: {
            hypagraph: persisted(),
            graph: projectGraphView(state),
            mermaid: mermaidSource,
            hypagoal: {
              kind: result.kind,
              objective: state.definition.goal,
              workflowId: state.workflowId,
              goalId: state.goal?.goalId,
              workflowRevision: state.revision,
              goalControl: structuredClone(state.goal),
              ready: hypagoalReadyWork(state),
              advisories: structuredClone(result.advisories),
              ...(sourceDraftId === undefined ? {} : { sourceDraftId }),
              creation: {
                operationId: creationOperationId,
                correlationId: result.events[0]?.correlationId,
                sessionGeneration,
                branchGeneration,
              },
              ...(result.replaced === undefined ? {} : { replaced: structuredClone(result.replaced) }),
              autonomousContinuationStarted: false,
              postCreateAwaitingUserChoice,
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
            ...(sourceDraftId === undefined ? {} : { draftId: sourceDraftId }),
          },
        },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "hypagoal_create_child",
    label: "Create child Hypagoal",
    description: "Create a bounded child Hypagoal from an active parent task on the family desk. The parent task may use current-session or isolated-pi. Reject create-child when parentNodeId equals the node an unsettled isolated worker owns. Child plan-owner tasks default to isolated-pi. Commits family membership and parent waiting_for_child through createBoundedChildGoalInFamily.",
    promptSnippet: "Create a child Hypagoal from an active parent task on the family desk",
    promptGuidelines: [
      "Call hypagoal_create_child only from an active parent task attempt after the user chose Run.",
      "The parent task may use the default isolated-pi profile or current-session. Create-child does not require current-session.",
      "Do not call hypagoal_create_child with parentNodeId equal to the node an unsettled isolated worker owns. Choose another parent node, or cancel the worker and then create the child.",
      "The same-node guard is the only worker-related create-child block. Create-child still requires an active parent task attempt. One exclusive active task per workflow means a second parent is not active while a worker runs on another node in that workflow.",
      "Child plan-owner implement tasks default to isolated-pi. Do not set current-session on child member tasks until member delivery ships.",
      "Prefer same-graph nodes when the subgoal shares ownership, budget, and workspace.",
      "Use a child Hypagoal when the subgoal needs separate ownership, budget, scope, or return contract.",
      "Supply draftId or definition for the child graph. Prefer draftId after construction tools.",
      "Child success does not complete the parent task. Integrate returned facts on the parent after return.",
    ],
    parameters: hypagoalCreateChildSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rejectChild = (code: string, message: string, diagnostics?: Array<{ code: string; message: string; location?: string }>) => ({
        content: [{
          type: "text" as const,
          text: `Child Hypagoal was not created. Canonical state is unchanged.\n${code}: ${message}`,
        }],
        details: {
          hypagoalChild: {
            kind: "rejected" as const,
            diagnostics: diagnostics ?? [{ code, message }],
          },
        },
      });

      // Create-child is family control. Refuse checks, code, effects, and presentations.
      // Isolated workers use the same-node guard below, not a blanket block.
      const hostBlock = activeHostExecutionBlockReason("child create");
      if (hostBlock) {
        return rejectChild("child_create_blocked_active_execution", hostBlock);
      }

      if (postCreateAwaitingUserChoice) {
        return rejectChild(
          "child_create_blocked_post_create_gate",
          "Child create is blocked until the user chooses Run after create.",
        );
      }

      if (!state?.goal) {
        return rejectChild(
          "child_create_no_active_goal",
          "There is no active Hypagraph. Call hypagoal_start first.",
        );
      }

      if (state.goal.status !== "active") {
        return rejectChild(
          "child_create_goal_not_active",
          `The parent goal is '${state.goal.status}'. A child can be created only while the parent goal is active.`,
        );
      }

      let input: ReturnType<typeof normalizeHypagoalCreateChildInput>;
      try {
        input = normalizeHypagoalCreateChildInput(params);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return rejectChild("hypagoal_create_child_invalid", message);
      }

      // Same-node guard: check ALL unsettled pool entries (S4).
      // Create-child on that node moves it to waiting_for_child and makes submit-result stale.
      // An unsettled worker on another node does not by itself reject create-child.
      // The parent task must still be active (domain exclusive ownership usually prevents
      // a second active parent in the same workflow while a worker runs).
      const blockingWorker = findIsolatedWorkerByNodeId(
        isolatedWorkerPool(),
        input.parentNodeId,
        state.workflowId,
      );
      if (blockingWorker && !blockingWorker.settled) {
        const nodeId = blockingWorker.nodeId;
        return rejectChild(
          "child_create_blocked_active_worker_node",
          `An unsettled isolated worker owns parent node '${nodeId}'. `
          + "Create-child on that node would move it to waiting_for_child and discard worker evidence. "
          + "Choose another parent node, or cancel the worker with /hypagraph executor cancel and then create the child.",
        );
      }

      // Resolve child definition from draftId or free-form definition.
      let childDefinition = input.definition;
      let sourceDraftId: string | undefined;
      let sourceDraft: HypagraphDraftRecord | undefined;
      if (input.draftId) {
        sourceDraftId = input.draftId;
        const store = new HypagraphProjectStore(ctx.cwd);
        let draft: HypagraphDraftRecord | undefined;
        try {
          await store.ensureInitialized();
          draft = await store.readDraft(input.draftId);
        } catch (error) {
          const message = error instanceof ProjectStoreError
            ? error.message
            : error instanceof Error ? error.message : String(error);
          const code = error instanceof ProjectStoreError ? error.code : "project_store_unavailable";
          return rejectChild(code, message);
        }
        if (!draft) {
          return rejectChild(
            "draft_not_found",
            `Draft '${input.draftId}' was not found under .hypagraph/drafts.`,
          );
        }
        if (draft.status === "discarded" || draft.status === "committed") {
          return rejectChild(
            "draft_not_open",
            `Draft '${input.draftId}' has status '${draft.status}' and cannot be committed as a child.`,
          );
        }
        const projected = projectDraftDefinition(draft);
        if (!projected.ok) {
          return rejectChild(
            "child_definition_invalid",
            formatDiagnostics(projected.diagnostics),
            structuredClone(projected.diagnostics),
          );
        }
        childDefinition = projected.definition;
        sourceDraft = draft;
      }

      if (!childDefinition) {
        return rejectChild(
          "hypagoal_create_child_invalid",
          "hypagoal_create_child requires draftId or definition.",
        );
      }

      // Align free-form goal text with the tool objective. Drafts keep authored goal.
      if (!input.draftId) {
        childDefinition = applyChildObjectiveToDefinition(childDefinition, input.childObjective);
      }

      // Ensure a family record exists and the parent workflow stream matches live state.
      const branch = ctx.sessionManager.getBranch();
      let familyProjection = restoreOrMigrateOneMemberFamilySession(branch);
      if (!familyProjection) {
        return rejectChild(
          "child_create_family_unavailable",
          "A goal family projection is required before child create. Restore or create a root Hypagoal first.",
        );
      }
      if (familyProjection.migrated) {
        appendOneMemberFamilyRecord(pi, familyProjection.family);
      }

      const parentGoalId = state.goal.goalId;
      const parentWorkflowId = state.workflowId;
      const parentMember = familyProjection.family.familySnapshot.members[parentGoalId];
      if (!parentMember) {
        return rejectChild(
          "goal_family_parent_missing",
          `Goal family does not contain parent goal '${parentGoalId}'.`,
        );
      }
      if (parentMember.workflowId !== parentWorkflowId) {
        return rejectChild(
          "child_create_parent_workflow_mismatch",
          `Live parent workflow '${parentWorkflowId}' does not match family member workflow '${parentMember.workflowId}'.`,
        );
      }

      // Sync live parent events and snapshot into the family record before pure create.
      const familyWithLiveParent: PersistedGoalFamily = {
        ...familyProjection.family,
        workflows: {
          ...familyProjection.family.workflows,
          [parentWorkflowId]: {
            events: structuredClone(events),
            snapshot: structuredClone(state),
          },
        },
      };

      const childGoalId = input.childGoalId ?? `goal-${randomUUID()}`;
      const childWorkflowId = input.childWorkflowId ?? randomUUID();
      const bindingId = input.bindingId ?? `binding-${randomUUID()}`;
      const at = new Date().toISOString();
      const previousSequence = state.sequence;

      const created = createBoundedChildGoalInFamily({
        family: familyWithLiveParent,
        parentGoalId,
        parentNodeId: input.parentNodeId,
        childDefinition,
        childGoalId,
        childWorkflowId,
        bindingId,
        at,
        scopePaths: input.scopePaths,
        ...(input.budget === undefined ? {} : { budget: input.budget }),
        ...(input.failurePolicy === undefined ? {} : { failurePolicy: input.failurePolicy }),
        ...(input.inputFacts === undefined ? {} : { inputFacts: input.inputFacts }),
        ...(input.outputFacts === undefined ? {} : { outputFacts: input.outputFacts }),
      });

      if (!created.ok) {
        return rejectChild(
          created.diagnostics[0]?.code ?? "child_create_failed",
          formatDiagnostics(created.diagnostics),
          structuredClone(created.diagnostics),
        );
      }

      const parentWorkflow = created.family.workflows[parentWorkflowId];
      if (!parentWorkflow) {
        return rejectChild(
          "goal_family_member_workflow_missing",
          `Child create committed without parent workflow '${parentWorkflowId}'.`,
        );
      }

      // Append only the new parent wait events to the root workflow event stream.
      const parentEvents = parentWorkflow.events.slice(events.length);
      if (parentEvents.length === 0) {
        return rejectChild(
          "child_create_parent_events_missing",
          "Child create did not produce parent wait events.",
        );
      }

      try {
        await eventStore.lease().append({
          workflowId: parentWorkflowId,
          expectedSequence: previousSequence,
          events: parentEvents,
          snapshot: parentWorkflow.snapshot,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return rejectChild("event_store_append_failed", message);
      }

      // Persist family membership and child workflow streams.
      appendOneMemberFamilyRecord(pi, created.family);
      rememberFamilyRecord(created.family);

      state = parentWorkflow.snapshot;
      events = structuredClone(parentWorkflow.events);
      eventStore.synchronize({ events, snapshot: state });
      // If an unsettled worker owns a different node in this workflow, refresh the
      // cancel mirror so cancel/reload does not rewind past create-child.
      mirrorActiveIsolatedCancelState();

      // Project-store artifacts for the child definition. Failure is notify-only.
      let childProjectStoreWritten = false;
      try {
        const store = new HypagraphProjectStore(ctx.cwd);
        await store.ensureInitialized();
        await store.writeCommittedWorkflow({
          workflowId: childWorkflowId,
          goalId: childGoalId,
          objective: childDefinition.goal,
          title: childDefinition.title,
          definition: childDefinition,
          definitionRevision: 1,
          ...(sourceDraftId === undefined ? {} : { sourceDraftId }),
          at,
        });
        if (sourceDraft && sourceDraftId) {
          const committed: HypagraphDraftRecord = {
            ...sourceDraft,
            status: "committed",
            updatedAt: at,
            goal: childDefinition.goal,
            title: childDefinition.title,
          };
          await store.writeDraft(committed);
          await store.appendDraftHistory(sourceDraftId, {
            code: "draft_committed",
            message: `Committed as child workflow '${childWorkflowId}'.`,
            workflowId: childWorkflowId,
          });
        }
        childProjectStoreWritten = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `Child Hypagoal created, but project-store definition artifacts were not written (${detail}). `
          + "Runtime family state is active. Check /hypagraph status for artifact state.",
          "warning",
        );
      }
      childProjectStoreArtifactWritten = childProjectStoreWritten;
      childProjectStoreWorkflowId = childWorkflowId;

      paintUi(ctx);

      const parentNodeStatus = state.runtime.nodes[input.parentNodeId]?.status ?? "unknown";
      const memberCount = Object.keys(created.family.familySnapshot.members).length;
      const text = renderHypagoalChildCreated({
        childGoalId,
        childWorkflowId,
        bindingId,
        parentNodeId: input.parentNodeId,
        parentGoalId,
        familyId: created.family.familySnapshot.familyId,
        memberCount,
        parentWaitStatus: parentNodeStatus,
      });

      return {
        content: [{ type: "text" as const, text }],
        details: {
          hypagraph: persisted(),
          hypagoalChild: {
            kind: "created" as const,
            childGoalId,
            childWorkflowId,
            bindingId,
            parentNodeId: input.parentNodeId,
            parentGoalId,
            parentWaitStatus: parentNodeStatus,
            familyId: created.family.familySnapshot.familyId,
            memberCount,
            projectStoreArtifactWritten: childProjectStoreWritten,
            ...(sourceDraftId === undefined ? {} : { sourceDraftId }),
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "hypagraph_validate",
    label: "Validate Hypagraph",
    description: "Validate a Hypagraph definition and return diagnostics without creating canonical state.",
    promptSnippet: "Validate a workflow definition before hypagoal_start",
    promptGuidelines: [
      "Use hypagraph_validate to test a definition before you commit one with hypagoal_start.",
      "Prefer hypagraph_draft_validate when you build through construction tools.",
      "hypagraph_validate creates no workflow and no goal.",
      "hypagoal_start creates a root Hypagoal. hypagoal_create_child creates a child from an active parent task.",
    ],
    parameters: definitionSchema,
    async execute(_toolCallId, params: unknown) {
      // Validation is pure. It does not touch session state or the event store.
      const result = validateHypagraphDefinition(params as Parameters<typeof validateHypagraphDefinition>[0]);
      return {
        content: [{ type: "text" as const, text: renderHypagraphValidation(result) }],
        details: {
          hypagraphValidation: {
            ok: result.ok,
            diagnostics: structuredClone(result.diagnostics),
            ...(result.definition === undefined
              ? {}
              : {
                nodeCount: result.definition.nodes.length,
                loopCount: result.definition.loops.length,
              }),
          },
        },
      };
    },
  });

  const loadOpenDraft = async (cwd: string, draftId: string): Promise<
    | { ok: true; store: HypagraphProjectStore; draft: HypagraphDraftRecord }
    | { ok: false; code: string; message: string }
  > => {
    const store = new HypagraphProjectStore(cwd);
    try {
      await store.ensureInitialized();
      const draft = await store.readDraft(draftId);
      if (!draft) {
        return {
          ok: false,
          code: "draft_not_found",
          message: `Draft '${draftId}' was not found under .hypagraph/drafts.`,
        };
      }
      if (draft.status === "discarded" || draft.status === "committed") {
        return {
          ok: false,
          code: "draft_not_open",
          message: `Draft '${draftId}' has status '${draft.status}'.`,
        };
      }
      return { ok: true, store, draft };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof ProjectStoreError ? error.code : "project_store_unavailable";
      return { ok: false, code, message };
    }
  };

  pi.registerTool({
    name: "hypagraph_draft_begin",
    label: "Begin Hypagraph draft",
    description: "Create an open authoring draft under .hypagraph/drafts. Does not create a live workflow.",
    promptSnippet: "Start a draft before construction tools",
    promptGuidelines: [
      "Call hypagraph_draft_begin first when authoring a Hypagoal with tools.",
      "Pass the exact creationRequest from the /hypagoal authoring turn when present.",
      "This tool creates no canonical runtime state.",
    ],
    parameters: draftBeginSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new HypagraphProjectStore(ctx.cwd);
      try {
        await store.ensureInitialized();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Draft was not created.\nproject_store_unavailable: ${message}` }],
          details: { hypagraphDraft: { ok: false, diagnostics: [{ code: "project_store_unavailable", message }] } },
        };
      }
      const createdAt = new Date().toISOString();
      const draft = createEmptyDraft({
        draftId: randomUUID(),
        objective: params.objective,
        createdAt,
        ...(params.title === undefined ? {} : { title: params.title }),
        ...(params.goal === undefined ? {} : { goal: params.goal }),
        ...(params.creationRequest === undefined ? {} : { creationRequest: params.creationRequest }),
      });
      await store.writeDraft(draft);
      await store.appendDraftHistory(draft.draftId, {
        code: "draft_begin",
        message: "Draft created.",
      });
      const summary = summarizeDraft(draft);
      return {
        content: [{
          type: "text" as const,
          text: [
            "Draft created. Canonical runtime state is unchanged.",
            renderDraftSummary(summary),
            "Next: recipe or low-level constructors, then hypagraph_draft_validate, then hypagoal_start with draftId.",
          ].join("\n"),
        }],
        details: {
          hypagraphDraft: {
            ok: true,
            draftId: draft.draftId,
            status: draft.status,
            summary,
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "hypagraph_draft_status",
    label: "Draft status",
    description: "Show draft id, node count, loops, and projected summary without creating a workflow.",
    promptSnippet: "Inspect an open Hypagraph draft",
    parameters: draftIdSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const loaded = await loadOpenDraft(ctx.cwd, params.draftId);
      if (!loaded.ok) {
        // Status may also report committed or discarded drafts for diagnosis.
        const store = new HypagraphProjectStore(ctx.cwd);
        try {
          await store.ensureInitialized();
          const anyDraft = await store.readDraft(params.draftId);
          if (anyDraft) {
            const summary = summarizeDraft(anyDraft);
            return {
              content: [{ type: "text" as const, text: renderDraftSummary(summary) }],
              details: { hypagraphDraft: { ok: true, draftId: anyDraft.draftId, status: anyDraft.status, summary } },
            };
          }
        } catch {
          // fall through
        }
        return {
          content: [{ type: "text" as const, text: `Draft status failed.\n${loaded.code}: ${loaded.message}` }],
          details: { hypagraphDraft: { ok: false, diagnostics: [{ code: loaded.code, message: loaded.message }] } },
        };
      }
      const summary = summarizeDraft(loaded.draft);
      const projected = projectDraftDefinition(loaded.draft);
      const extra = projected.ok
        ? [`Projection: ${projected.definition.nodes.length} nodes, ${projected.definition.loops.length} loops.`]
        : [`Projection incomplete: ${projected.diagnostics.map((item) => item.code).join(", ")}`];
      return {
        content: [{ type: "text" as const, text: renderDraftSummary(summary, extra) }],
        details: {
          hypagraphDraft: {
            ok: true,
            draftId: loaded.draft.draftId,
            status: loaded.draft.status,
            summary,
            projectionOk: projected.ok,
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "hypagraph_draft_validate",
    label: "Validate draft",
    description: "Project the draft to a definition and run the same structural validation as hypagraph_validate. Creates no workflow.",
    promptSnippet: "Validate a draft before hypagoal_start",
    promptGuidelines: [
      "Call hypagraph_draft_validate before hypagoal_start with draftId.",
      "This tool creates no canonical state.",
    ],
    parameters: draftIdSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const loaded = await loadOpenDraft(ctx.cwd, params.draftId);
      if (!loaded.ok) {
        return {
          content: [{ type: "text" as const, text: `Draft validate failed.\n${loaded.code}: ${loaded.message}` }],
          details: { hypagraphDraft: { ok: false, diagnostics: [{ code: loaded.code, message: loaded.message }] } },
        };
      }
      const validation = validateDraftProjection(loaded.draft);
      const updatedAt = new Date().toISOString();
      const next: HypagraphDraftRecord = {
        ...loaded.draft,
        status: validation.ok ? "validated" : "open",
        updatedAt,
      };
      await loaded.store.writeDraft(next);
      await loaded.store.appendDraftHistory(params.draftId, {
        code: validation.ok ? "draft_validated" : "draft_validate_failed",
        message: validation.ok ? "Draft projected definition is valid." : "Draft validation failed.",
        diagnostics: validation.diagnostics,
      });
      const rendered = renderDraftToolResult({
        ok: true,
        draft: next,
        validation,
        headline: validation.ok
          ? "Draft is valid. Canonical runtime state is unchanged."
          : "Draft is invalid. Canonical runtime state is unchanged.",
      });
      return {
        content: [{ type: "text" as const, text: rendered.text }],
        details: {
          hypagraphDraft: {
            ok: validation.ok,
            draftId: next.draftId,
            status: next.status,
            summary: rendered.summary,
            diagnostics: structuredClone(validation.diagnostics),
            ...(validation.definition === undefined
              ? {}
              : {
                nodeCount: validation.definition.nodes.length,
                loopCount: validation.definition.loops.length,
              }),
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "hypagraph_draft_discard",
    label: "Discard draft",
    description: "Mark a draft discarded and remove its project-store files. Creates no workflow.",
    promptSnippet: "Discard an open Hypagraph draft",
    parameters: draftIdSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = new HypagraphProjectStore(ctx.cwd);
      try {
        await store.ensureInitialized();
        const draft = await store.readDraft(params.draftId);
        if (!draft) {
          return {
            content: [{ type: "text" as const, text: `Draft discard failed.\ndraft_not_found: Draft '${params.draftId}' was not found.` }],
            details: { hypagraphDraft: { ok: false, diagnostics: [{ code: "draft_not_found", message: `Draft '${params.draftId}' was not found.` }] } },
          };
        }
        await store.discardDraft(params.draftId);
        await store.removeDraftFiles(params.draftId);
        return {
          content: [{ type: "text" as const, text: `Draft '${params.draftId}' discarded. Canonical runtime state is unchanged.` }],
          details: { hypagraphDraft: { ok: true, draftId: params.draftId, status: "discarded" } },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Draft discard failed.\nproject_store_unavailable: ${message}` }],
          details: { hypagraphDraft: { ok: false, diagnostics: [{ code: "project_store_unavailable", message }] } },
        };
      }
    },
  });

  pi.registerTool({
    name: "hypagraph_add_task",
    label: "Add task to draft",
    description: "Add one task node to an open draft.",
    promptSnippet: "Add a task node to a draft",
    parameters: addTaskSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const loaded = await loadOpenDraft(ctx.cwd, params.draftId);
      if (!loaded.ok) {
        return {
          content: [{ type: "text" as const, text: renderDraftToolResult({ ok: false, diagnostics: [{ code: loaded.code, message: loaded.message }] }).text }],
          details: { hypagraphDraft: { ok: false, diagnostics: [{ code: loaded.code, message: loaded.message }] } },
        };
      }
      const updatedAt = new Date().toISOString();
      const result = addTaskToDraft(loaded.draft, {
        id: params.id,
        title: params.title,
        ...(params.acceptance === undefined ? {} : { acceptance: params.acceptance }),
        ...(params.description === undefined ? {} : { description: params.description }),
        ...(params.produces === undefined ? {} : { produces: params.produces }),
        ...(params.scopePaths === undefined ? {} : { scopePaths: params.scopePaths }),
        ...(params.requires === undefined ? {} : { requires: params.requires }),
      }, updatedAt);
      if (!result.ok) {
        const rendered = renderDraftToolResult({ ok: false, diagnostics: result.diagnostics });
        return {
          content: [{ type: "text" as const, text: rendered.text }],
          details: { hypagraphDraft: { ok: false, draftId: params.draftId, diagnostics: structuredClone(result.diagnostics) } },
        };
      }
      await loaded.store.writeDraft(result.draft);
      await loaded.store.appendDraftHistory(params.draftId, { code: "task_added", message: `Added task '${params.id}'.` });
      const rendered = renderDraftToolResult({ ok: true, draft: result.draft, notes: result.notes, headline: `Task '${params.id}' added.` });
      return {
        content: [{ type: "text" as const, text: rendered.text }],
        details: { hypagraphDraft: { ok: true, draftId: params.draftId, status: result.draft.status, summary: rendered.summary } },
      };
    },
  });

  pi.registerTool({
    name: "hypagraph_add_check",
    label: "Add check to draft",
    description: "Add one command check node to an open draft.",
    promptSnippet: "Add a check node to a draft",
    parameters: addCheckSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const loaded = await loadOpenDraft(ctx.cwd, params.draftId);
      if (!loaded.ok) {
        return {
          content: [{ type: "text" as const, text: renderDraftToolResult({ ok: false, diagnostics: [{ code: loaded.code, message: loaded.message }] }).text }],
          details: { hypagraphDraft: { ok: false, diagnostics: [{ code: loaded.code, message: loaded.message }] } },
        };
      }
      const updatedAt = new Date().toISOString();
      const result = addCheckToDraft(loaded.draft, {
        id: params.id,
        title: params.title,
        check: params.check,
        ...(params.acceptance === undefined ? {} : { acceptance: params.acceptance }),
        ...(params.description === undefined ? {} : { description: params.description }),
        ...(params.produces === undefined ? {} : { produces: params.produces }),
        ...(params.requires === undefined ? {} : { requires: params.requires }),
      }, updatedAt);
      if (!result.ok) {
        const rendered = renderDraftToolResult({ ok: false, diagnostics: result.diagnostics });
        return {
          content: [{ type: "text" as const, text: rendered.text }],
          details: { hypagraphDraft: { ok: false, draftId: params.draftId, diagnostics: structuredClone(result.diagnostics) } },
        };
      }
      await loaded.store.writeDraft(result.draft);
      await loaded.store.appendDraftHistory(params.draftId, { code: "check_added", message: `Added check '${params.id}'.` });
      const rendered = renderDraftToolResult({ ok: true, draft: result.draft, notes: result.notes, headline: `Check '${params.id}' added.` });
      return {
        content: [{ type: "text" as const, text: rendered.text }],
        details: { hypagraphDraft: { ok: true, draftId: params.draftId, status: result.draft.status, summary: rendered.summary } },
      };
    },
  });

  pi.registerTool({
    name: "hypagraph_require",
    label: "Add draft dependency",
    description: "Add dependency to.requires includes from on an open draft.",
    promptSnippet: "Add a requires edge to a draft",
    parameters: requireSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const loaded = await loadOpenDraft(ctx.cwd, params.draftId);
      if (!loaded.ok) {
        return {
          content: [{ type: "text" as const, text: renderDraftToolResult({ ok: false, diagnostics: [{ code: loaded.code, message: loaded.message }] }).text }],
          details: { hypagraphDraft: { ok: false, diagnostics: [{ code: loaded.code, message: loaded.message }] } },
        };
      }
      const updatedAt = new Date().toISOString();
      const result = requireOnDraft(loaded.draft, { from: params.from, to: params.to }, updatedAt);
      if (!result.ok) {
        const rendered = renderDraftToolResult({ ok: false, diagnostics: result.diagnostics });
        return {
          content: [{ type: "text" as const, text: rendered.text }],
          details: { hypagraphDraft: { ok: false, draftId: params.draftId, diagnostics: structuredClone(result.diagnostics) } },
        };
      }
      await loaded.store.writeDraft(result.draft);
      await loaded.store.appendDraftHistory(params.draftId, {
        code: "require_added",
        message: `Node '${params.to}' requires '${params.from}'.`,
      });
      const rendered = renderDraftToolResult({
        ok: true,
        draft: result.draft,
        notes: result.notes,
        headline: `Dependency added: ${params.to} requires ${params.from}.`,
      });
      return {
        content: [{ type: "text" as const, text: rendered.text }],
        details: { hypagraphDraft: { ok: true, draftId: params.draftId, status: result.draft.status, summary: rendered.summary } },
      };
    },
  });

  pi.registerTool({
    name: "hypagraph_loop",
    label: "Declare draft loop",
    description: "Declare a bounded loop on an open draft. Owns feedback edges and the cycle-closing requires edge.",
    promptSnippet: "Add a loop that owns feedback edges",
    promptGuidelines: [
      "Use hypagraph_loop instead of hand-authoring feedbackEdges.",
      "Provide entry, evaluateAfter, successWhen, and maxIterations.",
      "The tool sets entry.requires to include evaluateAfter and projects feedbackEdges.",
    ],
    parameters: draftLoopToolSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const loaded = await loadOpenDraft(ctx.cwd, params.draftId);
      if (!loaded.ok) {
        return {
          content: [{ type: "text" as const, text: renderDraftToolResult({ ok: false, diagnostics: [{ code: loaded.code, message: loaded.message }] }).text }],
          details: { hypagraphDraft: { ok: false, diagnostics: [{ code: loaded.code, message: loaded.message }] } },
        };
      }
      const updatedAt = new Date().toISOString();
      const result = declareLoopOnDraft(loaded.draft, {
        loopId: params.loopId,
        entry: params.entry,
        evaluateAfter: params.evaluateAfter,
        successWhen: params.successWhen,
        maxIterations: params.maxIterations,
        ...(params.nodes === undefined ? {} : { nodes: params.nodes }),
        ...(params.progress === undefined ? {} : { progress: params.progress }),
        ...(params.patience === undefined ? {} : { patience: params.patience }),
        ...(params.failurePolicy === undefined ? {} : { failurePolicy: params.failurePolicy }),
      }, updatedAt);
      if (!result.ok) {
        const rendered = renderDraftToolResult({ ok: false, diagnostics: result.diagnostics });
        return {
          content: [{ type: "text" as const, text: rendered.text }],
          details: { hypagraphDraft: { ok: false, draftId: params.draftId, diagnostics: structuredClone(result.diagnostics) } },
        };
      }
      await loaded.store.writeDraft(result.draft);
      await loaded.store.appendDraftHistory(params.draftId, {
        code: "loop_declared",
        message: `Declared loop '${params.loopId}'.`,
      });
      const validation = validateDraftProjection(result.draft);
      const rendered = renderDraftToolResult({
        ok: true,
        draft: result.draft,
        notes: result.notes,
        validation,
        headline: `Loop '${params.loopId}' declared. Feedback edges are tool-owned.`,
      });
      return {
        content: [{ type: "text" as const, text: rendered.text }],
        details: {
          hypagraphDraft: {
            ok: true,
            draftId: params.draftId,
            status: result.draft.status,
            summary: rendered.summary,
            loopId: params.loopId,
            validationOk: validation.ok,
            diagnostics: structuredClone(validation.diagnostics),
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "hypagraph_recipe_implement_verify_loop",
    label: "Implement/verify loop recipe",
    description: "Expand an implement and verify loop onto an open draft. The recipe uses the loop tool so feedback edges are never hand-authored.",
    promptSnippet: "Apply implement/verify loop recipe to a draft",
    promptGuidelines: [
      "Prefer this recipe for single-agent implement then verify loops.",
      "For multi-agent parallel review after implement, prefer hypagraph_recipe_implement_parallel_review.",
      "Do not supply feedbackEdges. The recipe owns them through hypagraph_loop.",
    ],
    parameters: implementVerifyRecipeSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const loaded = await loadOpenDraft(ctx.cwd, params.draftId);
      if (!loaded.ok) {
        return {
          content: [{ type: "text" as const, text: renderDraftToolResult({ ok: false, diagnostics: [{ code: loaded.code, message: loaded.message }] }).text }],
          details: { hypagraphDraft: { ok: false, diagnostics: [{ code: loaded.code, message: loaded.message }] } },
        };
      }
      const updatedAt = new Date().toISOString();
      const result = applyImplementVerifyLoopRecipe(loaded.draft, {
        ...(params.implementId === undefined ? {} : { implementId: params.implementId }),
        ...(params.verifyId === undefined ? {} : { verifyId: params.verifyId }),
        ...(params.implementTitle === undefined ? {} : { implementTitle: params.implementTitle }),
        ...(params.verifyTitle === undefined ? {} : { verifyTitle: params.verifyTitle }),
        ...(params.implementAcceptance === undefined ? {} : { implementAcceptance: params.implementAcceptance }),
        ...(params.verifyAcceptance === undefined ? {} : { verifyAcceptance: params.verifyAcceptance }),
        ...(params.successFactName === undefined
          ? {}
          : { successFact: { name: params.successFactName, type: "boolean" as const, required: true } }),
        ...(params.maxIterations === undefined ? {} : { maxIterations: params.maxIterations }),
        ...(params.loopId === undefined ? {} : { loopId: params.loopId }),
      }, updatedAt);
      if (!result.ok) {
        const rendered = renderDraftToolResult({ ok: false, diagnostics: result.diagnostics });
        return {
          content: [{ type: "text" as const, text: rendered.text }],
          details: { hypagraphDraft: { ok: false, draftId: params.draftId, diagnostics: structuredClone(result.diagnostics) } },
        };
      }
      await loaded.store.writeDraft(result.draft);
      await loaded.store.appendDraftHistory(params.draftId, {
        code: "recipe_implement_verify_loop",
        message: "Applied implement/verify loop recipe.",
      });
      const validation = validateDraftProjection(result.draft);
      const rendered = renderDraftToolResult({
        ok: true,
        draft: result.draft,
        notes: result.notes,
        validation,
        headline: "Implement/verify loop recipe applied. Feedback edges are tool-owned.",
      });
      return {
        content: [{ type: "text" as const, text: rendered.text }],
        details: {
          hypagraphDraft: {
            ok: true,
            draftId: params.draftId,
            status: result.draft.status,
            summary: rendered.summary,
            validationOk: validation.ok,
            diagnostics: structuredClone(validation.diagnostics),
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "hypagraph_recipe_implement_parallel_review",
    label: "Implement/parallel-review flagship recipe",
    description:
      "Expand the flagship multi-agent recipe onto an open draft: implement → review-panel (N parallel review children + ordinary join) → integrate → optional verify. "
      + "Inspired by implement-skill implementer then multi-reviewer quorum. Runtime create-child fan-out is documented on review-panel acceptance.",
    promptSnippet: "Apply implement/parallel-review flagship recipe to a draft",
    promptGuidelines: [
      "Prefer this recipe when work needs implement then parallel multi-agent review with ordinary multi-child join.",
      "After Run, implement runs as a task (default isolated-pi). When review-panel is active, create one child Hypagoal per review role (default: general, tests, security).",
      "Create all review children before waiting for full single-child cycles when you need multi-child join. Ordinary join publishes default join.passed.",
      "Do not declare produce join.passed or expectedBindingCount on the ordinary path.",
      "Use buildParallelReviewChildTemplates guidance in the tool result notes for child objectives and output facts.",
      "For single-agent implement/verify loops without multi-child review, prefer hypagraph_recipe_implement_verify_loop.",
    ],
    parameters: implementParallelReviewRecipeSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const loaded = await loadOpenDraft(ctx.cwd, params.draftId);
      if (!loaded.ok) {
        return {
          content: [{ type: "text" as const, text: renderDraftToolResult({ ok: false, diagnostics: [{ code: loaded.code, message: loaded.message }] }).text }],
          details: { hypagraphDraft: { ok: false, diagnostics: [{ code: loaded.code, message: loaded.message }] } },
        };
      }
      const updatedAt = new Date().toISOString();
      const roles = params.reviewRoles && params.reviewRoles.length > 0
        ? params.reviewRoles
        : [...DEFAULT_PARALLEL_REVIEW_ROLES];
      const result = applyImplementParallelReviewRecipe(loaded.draft, {
        ...(params.implementId === undefined ? {} : { implementId: params.implementId }),
        ...(params.reviewPanelId === undefined ? {} : { reviewPanelId: params.reviewPanelId }),
        ...(params.integrateId === undefined ? {} : { integrateId: params.integrateId }),
        ...(params.verifyId === undefined ? {} : { verifyId: params.verifyId }),
        ...(params.implementTitle === undefined ? {} : { implementTitle: params.implementTitle }),
        ...(params.reviewPanelTitle === undefined ? {} : { reviewPanelTitle: params.reviewPanelTitle }),
        ...(params.integrateTitle === undefined ? {} : { integrateTitle: params.integrateTitle }),
        ...(params.verifyTitle === undefined ? {} : { verifyTitle: params.verifyTitle }),
        ...(params.implementAcceptance === undefined ? {} : { implementAcceptance: params.implementAcceptance }),
        ...(params.reviewPanelAcceptance === undefined ? {} : { reviewPanelAcceptance: params.reviewPanelAcceptance }),
        ...(params.integrateAcceptance === undefined ? {} : { integrateAcceptance: params.integrateAcceptance }),
        ...(params.verifyAcceptance === undefined ? {} : { verifyAcceptance: params.verifyAcceptance }),
        reviewRoles: roles,
        ...(params.includeVerifyTask === undefined ? {} : { includeVerifyTask: params.includeVerifyTask }),
        ...(params.successFactName === undefined
          ? {}
          : { successFact: { name: params.successFactName, type: "boolean" as const, required: true } }),
        ...(params.scopePaths === undefined ? {} : { scopePaths: params.scopePaths }),
        ...(params.verifyId !== undefined || params.includeVerifyTask === true
          ? { includeVerifyTask: true }
          : {}),
      }, updatedAt);
      if (!result.ok) {
        const rendered = renderDraftToolResult({ ok: false, diagnostics: result.diagnostics });
        return {
          content: [{ type: "text" as const, text: rendered.text }],
          details: { hypagraphDraft: { ok: false, draftId: params.draftId, diagnostics: structuredClone(result.diagnostics) } },
        };
      }
      await loaded.store.writeDraft(result.draft);
      await loaded.store.appendDraftHistory(params.draftId, {
        code: "recipe_implement_parallel_review",
        message: "Applied implement/parallel-review flagship recipe.",
      });
      const validation = validateDraftProjection(result.draft);
      const templates = buildParallelReviewChildTemplates(roles);
      const templateLines = templates.map(
        (t) =>
          `- role=${t.role} taskId=${t.taskId} fact=${t.outputFactName}: ${t.objectiveHint}`,
      );
      const rendered = renderDraftToolResult({
        ok: true,
        draft: result.draft,
        notes: result.notes,
        validation,
        headline:
          "Implement/parallel-review flagship recipe applied. "
          + "On review-panel, create one child per role; ordinary multi-child join applies.",
      });
      const text =
        rendered.text
        + "\n\nParallel review child templates (use at create-child):\n"
        + templateLines.join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: {
          hypagraphDraft: {
            ok: true,
            draftId: params.draftId,
            status: result.draft.status,
            summary: rendered.summary,
            validationOk: validation.ok,
            diagnostics: structuredClone(validation.diagnostics),
            recipe: "implement_parallel_review",
            reviewRoles: [...roles],
            childTemplates: templates,
          },
        },
      };
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
      if (!state) throw new Error("There is no active Hypagraph. Call hypagoal_start first.");
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
      if (!state) throw new Error("There is no active Hypagraph. Call hypagoal_start first.");
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
            paintUi(ctx);
          },
        });
        if (sessionGeneration !== runGeneration) throw new Error("The Pi session changed while the check was active.");
        state = lifecycle.state;
        paintUi(ctx);
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
      if (!state) throw new Error("There is no active Hypagraph. Call hypagoal_start first.");
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
      paintUi(ctx);
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
      if (!state) throw new Error("There is no active Hypagraph. Call hypagoal_start first.");
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
      paintUi(ctx);
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
        const revisionParams = params as Parameters<typeof normalizeDefinition>[0] & { goal: string };
        revisedDefinition = { ...normalizeDefinition(revisionParams), goal: revisionParams.goal };
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
      paintUi(ctx);
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
      await runCommands([{
        type: "revise",
        definition: normalizeDefinition(params as Parameters<typeof normalizeDefinition>[0]),
        commandId: randomUUID(),
        at: new Date().toISOString(),
      }]);
      paintUi(ctx);
      return textResult(`${renderWorkflow(state!)}\n\nHypagraph accepted the revision.`);
    },
  });

  pi.registerCommand("hypagoal", {
    description: "Create one root graph-backed goal; status, pause, resume, cancel, and graph remain available for compatibility",
    handler: async (args, ctx) => {
      const raw = args.trim();
      const words = raw.split(/\s+/).filter(Boolean);
      const action = words[0]?.toLowerCase();

      if (!raw || action === "help") {
        ctx.ui.notify(
          [
            "Usage: /hypagoal <objective> | status | pause [reason] | resume | cancel [reason] | graph",
            "Create one root graph-backed goal from ordinary prose.",
            "Preferred control surface: /hypagraph status | pause | resume | cancel | graph.",
            "Arm creation without the command by including the configured trigger word in a message.",
          ].join("\n"),
          "info",
        );
        return;
      }
      // Compatibility control path. The preferred surface is /hypagraph.
      if (action === "status") {
        if (!state?.goal) throw new Error("There is no active Hypagoal to inspect.");
        const familyView = resolveFamilyView(ctx);
        const rootStatus = renderHypagoalStatus(state);
        ctx.ui.notify(
          appendFamilyStatusBlock(rootStatus, familyView, 100, { showOneMember: true }),
          "info",
        );
        return;
      }
      if (action === "graph") {
        liveGraphSuppressedWorkflowId = undefined;
        if (state) liveGraphOpenedForWorkflowId = state.workflowId;
        paintUi(ctx);
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
        paintUi(ctx);
        ctx.ui.notify(renderHypagoalLifecycleMessage(state!), "info");
        return;
      }
      if (action === "resume") {
        ensureNoActiveExecution();
        if (!state?.goal) throw new Error("There is no active Hypagoal to resume.");
        // When no node has ever run, re-open the post-create review dock.
        // Do not auto-start work. The user must choose Run on the dock again.
        if (shouldReopenPostCreateGate(state)) {
          if (state.goal.status === "paused") {
            await runCommands([{ type: "resume-goal", commandId: `resume-goal:${randomUUID()}`, at: new Date().toISOString() }]);
            paintUi(ctx);
          }
          postCreateAwaitingUserChoice = true;
          postCreateDockPresented = false;
          const mayContinue = await resolvePostCreateGate(ctx);
          if (mayContinue) {
            paintUi(ctx);
            await queueGoalContinuation(ctx);
          }
          return;
        }
        clearPostCreateGate();
        await runCommands([{ type: "resume-goal", commandId: `resume-goal:${randomUUID()}`, at: new Date().toISOString() }]);
        paintUi(ctx);
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
        // Clear the post-create gate only after cancel-goal succeeds.
        await runCommands([{
          type: "cancel-goal",
          reason,
          commandId: `cancel-goal:${randomUUID()}`,
          at: new Date().toISOString(),
        }]);
        clearPostCreateGate();
        paintUi(ctx);
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
    description: "Control and inspect the active Hypagraph goal, checks, history, graph pane, and arming",
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const action = words.map((word) => word.toLowerCase()).join(" ");
      if (action === "help") ctx.ui.notify(hypagraphUsage(), "info");
      else if (action === "status") {
        if (!state?.goal) {
          ctx.ui.notify("There is no active Hypagoal to inspect.", "info");
        } else {
          const familyView = resolveFamilyView(ctx);
          const rootStatus = renderHypagoalStatus(state);
          const extras: string[] = [];
          if (postCreateAwaitingUserChoice) {
            extras.push(
              "Post-create gate: waiting for Run (dock). Resume re-opens the review when no node has started.",
            );
          }
          if (projectStoreArtifactWritten === true) {
            extras.push("Definition artifact: written under .hypagraph/workflows/");
          } else if (projectStoreArtifactWritten === false) {
            extras.push("Definition artifact: not written (project-store failure on create)");
          }
          if (childProjectStoreArtifactWritten === true && childProjectStoreWorkflowId) {
            extras.push(
              `Child definition artifact: written under .hypagraph/workflows/${childProjectStoreWorkflowId}/`,
            );
          } else if (childProjectStoreArtifactWritten === false && childProjectStoreWorkflowId) {
            extras.push(
              `Child definition artifact: not written for workflow '${childProjectStoreWorkflowId}' `
              + "(project-store failure on child create)",
            );
          }
          if (familyView) {
            const activeWaits = familyView.bindings.filter((binding) => binding.status === "active");
            for (const binding of activeWaits) {
              extras.push(
                `Child wait: parent node '${binding.parentNodeId}' waits for child '${binding.childGoalId}' `
                + `(binding '${binding.bindingId}')`,
              );
            }
            if (familyView.memberCount > 1) {
              extras.push(
                `Family focus: ${familyView.focusedGoalId} `
                + `(members ${familyView.memberCount}; use /hypagraph graph member <goalId>)`,
              );
            }
          }
          const unsettledWorkers = listUnsettledIsolatedWorkers(isolatedWorkerPool());
          for (const worker of unsettledWorkers) {
            extras.push(formatIsolatedWorkerStatusLine(worker));
          }
          if (unsettledWorkers.length > 1) {
            extras.push(
              `Workers in flight: ${unsettledWorkers.length} under isolated worker pool`,
            );
          }
          if (familyView && familyView.memberCount > 1) {
            extras.push(
              `Family desk: ${familyView.familyId} coordinates members; each Hypagoal is plan owner of its graph`,
            );
          }
          if (familyView) {
            const strandedPendings = listFamilyPendingViews(familyView.scheduler);
            const hasUnsettledIsolatedWorker = unsettledWorkers.length > 0;
            // Suppress reclaim hint while any host-tracked model work is in flight
            // (isolated worker or current-session / delivered continuation).
            const hasHostTrackedModelWork = hasUnsettledIsolatedWorker
              || pendingContinuation !== undefined
              || deliveredContinuation !== undefined;
            if (strandedPendings.length > 0 && !hasHostTrackedModelWork) {
              const pendingLabel = strandedPendings.length === 1
                ? "1 pending dispatch occupies capacity"
                : `${strandedPendings.length} pending dispatches occupy capacity`;
              extras.push(
                `Family pending reclaim: ${pendingLabel}. `
                + "Use /hypagraph reclaim-pending to interrupt them.",
              );
            }
          }
          const body = extras.length === 0
            ? rootStatus
            : `${rootStatus}\n${extras.join("\n")}`;
          ctx.ui.notify(
            appendFamilyStatusBlock(body, familyView, 100, { showOneMember: true }),
            "info",
          );
        }
      } else if (words[0]?.toLowerCase() === "reclaim-pending") {
        // Operator path to free stranded family pendings that block occupancy (S2).
        if (!state?.goal) {
          ctx.ui.notify("There is no active Hypagoal to reclaim family pendings for.", "warning");
        } else {
          const familyRecord = loadFamilyRecordForController(ctx) ?? latestFamilyRecord;
          if (!familyRecord) {
            ctx.ui.notify(
              "There is no family record to reclaim pending dispatches from.",
              "warning",
            );
          } else {
            const namedIds = words.slice(1).filter((id) => id.length > 0);
            const reclaimed = interruptAllFamilyPendingsForHost({
              family: familyRecord.familySnapshot,
              at: new Date().toISOString(),
              reason: namedIds.length > 0
                ? "The operator reclaimed named family pending dispatches."
                : "The operator reclaimed stranded family pending dispatches.",
              ...(namedIds.length > 0 ? { dispatchIds: namedIds } : {}),
            });
            if (!reclaimed.ok) {
              ctx.ui.notify(
                `Hypagraph could not reclaim family pending dispatches.\n`
                + formatDiagnostics(reclaimed.diagnostics),
                "warning",
              );
            } else if (reclaimed.interruptedDispatchIds.length === 0) {
              ctx.ui.notify(
                namedIds.length > 0
                  ? "No matching family pending dispatches were found to reclaim."
                  : "There are no family pending dispatches to reclaim.",
                "info",
              );
            } else {
              persistFamilySnapshotUpdate(
                familyRecord,
                reclaimed.family,
                reclaimed.events,
              );
              paintUi(ctx);
              const reclaimedCount = reclaimed.interruptedDispatchIds.length;
              const reclaimedLabel = reclaimedCount === 1
                ? "1 family pending dispatch"
                : `${reclaimedCount} family pending dispatches`;
              const reclaimedList = reclaimed.interruptedDispatchIds.join(", ");
              let reclaimMessage =
                `Hypagraph reclaimed ${reclaimedLabel}: ${reclaimedList}.`;
              if (namedIds.length > 0) {
                const reclaimedSet = new Set(reclaimed.interruptedDispatchIds);
                const unknownIds = namedIds.filter((id) => !reclaimedSet.has(id));
                if (unknownIds.length > 0) {
                  reclaimMessage += ` Unknown dispatch ids: ${unknownIds.join(", ")}.`;
                }
              }
              ctx.ui.notify(reclaimMessage, "warning");
            }
          }
        }
      } else if (words[0]?.toLowerCase() === "pause") {
        ensureNoActiveExecution();
        if (!state?.goal) {
          ctx.ui.notify("There is no active Hypagoal to pause.", "warning");
        } else {
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
          paintUi(ctx);
          ctx.ui.notify(renderHypagoalLifecycleMessage(state!), "info");
        }
      } else if (action === "resume") {
        ensureNoActiveExecution();
        if (!state?.goal) {
          ctx.ui.notify("There is no active Hypagoal to resume.", "warning");
        } else if (shouldReopenPostCreateGate(state)) {
          // Never-started goals re-open the review dock. Run on the dock starts work.
          if (state.goal.status === "paused") {
            await runCommands([{ type: "resume-goal", commandId: `resume-goal:${randomUUID()}`, at: new Date().toISOString() }]);
            paintUi(ctx);
          }
          postCreateAwaitingUserChoice = true;
          postCreateDockPresented = false;
          const mayContinue = await resolvePostCreateGate(ctx);
          if (mayContinue) {
            paintUi(ctx);
            await queueGoalContinuation(ctx);
          }
        } else {
          clearPostCreateGate();
          await runCommands([{ type: "resume-goal", commandId: `resume-goal:${randomUUID()}`, at: new Date().toISOString() }]);
          paintUi(ctx);
          if (state?.goal?.status === "active") {
            ctx.ui.notify(renderHypagoalLifecycleMessage(state), "info");
            await queueGoalContinuation(ctx);
          } else ctx.ui.notify(state?.goal?.stopReason ?? "The Hypagoal did not resume.", "warning");
        }
      } else if (words[0]?.toLowerCase() === "cancel" || action.startsWith("cancel ")) {
        ensureNoActiveExecution();
        if (!state?.goal) {
          ctx.ui.notify("There is no active Hypagoal to cancel.", "warning");
        } else {
          await abandonPendingContinuation("The user cancelled the Hypagoal from Pi.");
          pendingContinuation = undefined;
          deliveredContinuation = undefined;
          revisionProposalHandled = false;
          restoreContinuationTools();
          const reason = words.slice(1).join(" ").trim() || "The user cancelled the Hypagoal from Pi.";
          // Clear the post-create gate only after cancel-goal succeeds.
          await runCommands([{
            type: "cancel-goal",
            reason,
            commandId: `cancel-goal:${randomUUID()}`,
            at: new Date().toISOString(),
          }]);
          clearPostCreateGate();
          paintUi(ctx);
          ctx.ui.notify(renderHypagoalLifecycleMessage(state!), "warning");
        }
      }
      else if (action === "graph" || action === "graph open") {
        liveGraphSuppressedWorkflowId = undefined;
        if (state) liveGraphOpenedForWorkflowId = state.workflowId;
        paintUi(ctx);
        graphPane.open(ctx);
      }
      else if (action === "graph full" || action === "graph modal") {
        liveGraphSuppressedWorkflowId = undefined;
        if (state) liveGraphOpenedForWorkflowId = state.workflowId;
        paintUi(ctx);
        graphPane.openFull(ctx);
      }
      else if (action === "graph close") {
        if (state) liveGraphSuppressedWorkflowId = state.workflowId;
        graphPane.close();
      }
      else if (action === "graph toggle") {
        if (graphPane.isOpen) {
          if (state) liveGraphSuppressedWorkflowId = state.workflowId;
          graphPane.close();
        } else {
          liveGraphSuppressedWorkflowId = undefined;
          if (state) liveGraphOpenedForWorkflowId = state.workflowId;
          paintUi(ctx);
          graphPane.open(ctx);
        }
      }
      else if (action === "graph focus") graphPane.focus();
      else if (words[0]?.toLowerCase() === "graph" && words[1]?.toLowerCase() === "member") {
        const goalId = words.slice(2).join(" ").trim();
        if (!goalId) {
          ctx.ui.notify(
            "Usage: /hypagraph graph member <goalId>. Focus the graph pane on a family member.",
            "warning",
          );
        } else {
          liveGraphSuppressedWorkflowId = undefined;
          if (state) liveGraphOpenedForWorkflowId = state.workflowId;
          paintUi(ctx);
          graphPane.open(ctx);
          const focused = graphPane.focusFamilyMemberByGoalId(goalId);
          if (!focused.ok) {
            ctx.ui.notify(focused.reason, "warning");
          } else {
            ctx.ui.notify(
              `Graph pane focuses family member '${focused.goalId}'.`,
              "info",
            );
          }
        }
      }
      else if (action === "loop") ctx.ui.notify(state ? renderLoopCommand(state) : "There is no active Hypagraph.", "info");
      else if (words[0]?.toLowerCase() === "trigger") {
        const sub = (words[1] ?? "").toLowerCase();
        if (sub === "" || sub === "status") {
          ctx.ui.notify(describeTriggerSettings(), "info");
        } else if (sub === "off") {
          hypagoalTriggerSettings = disableHypagoalTrigger();
          clearHypagoalArming(ctx);
          // Refresh live highlight without session reload when the editor is registered.
          hypagoalTriggerEditor?.refresh();
          ctx.ui.notify("Hypagoal arming is off.", "info");
        } else if (sub === "set") {
          const word = words.slice(2).join(" ").trim();
          const result = setHypagoalTriggerWord(word);
          if (!result.ok) {
            ctx.ui.notify(result.message, "warning");
          } else {
            hypagoalTriggerSettings = result.settings;
            // Refresh live highlight without session reload when the editor is registered.
            hypagoalTriggerEditor?.refresh();
            ctx.ui.notify(`Hypagoal trigger word set to '${result.settings.word}'.`, "info");
          }
        } else {
          ctx.ui.notify(
            `/hypagraph trigger has no '${words.slice(1).join(" ")}' subcommand.\n`
            + "Use: /hypagraph trigger set <word> | trigger off | trigger",
            "warning",
          );
        }
      }
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
      } else if (words[0]?.toLowerCase() === "executor") {
        // Product surface for the isolated Pi / ACP / CLI host (m7-s8 / m9-s1 / m9-s2).
        // status: report active process count and executor identity.
        // probe [acp|cli]: call dispatchIsolatedPiAttempt with an aborted signal so no
        // child is spawned; proves the product dispatch seam is live for
        // isolated-pi, acp, or cli.
        // cancel: user-initiated host teardown of in-flight executor sessions.
        const sub = (words[1] ?? "status").toLowerCase();
        if (sub === "status") {
          const familyView = resolveFamilyView(ctx);
          const host = executorHostSnapshot();
          const acpBound = isolatedPiController.host.acpRegistry !== undefined;
          const cliBound = isolatedPiController.host.cliRegistry !== undefined;
          const lines = [
            `Isolated Pi host: ${host.executorId ?? isolatedPiController.host.executor.id}`,
            `Profile kind: ${host.profileKind ?? ISOLATED_PI_PROFILE.kind}`,
            `Default model task routing: isolated-pi (orchestrator is not the worker)`,
            `ACP host bound: ${acpBound ? "yes" : "no"}`,
            `CLI host bound: ${cliBound ? "yes" : "no"}`,
            `CLI default profile: ${CLI_PROFILE.profileId}`,
            `Active processes: ${host.activeProcessCount ?? 0}`,
            `Worker pool unsettled: ${countUnsettledIsolatedWorkers(isolatedWorkerPool())}`,
            ...(() => {
              const workers = listUnsettledIsolatedWorkers(isolatedWorkerPool());
              if (workers.length === 0) return ["Worker: none"];
              return workers.map((worker) =>
                formatIsolatedWorkerStatusLine(worker, { includeElapsed: false })
              );
            })(),
            "Dispatch seam: dispatchIsolatedPiAttempt (profile kinds isolated-pi, acp, cli)",
            "Cancel: /hypagraph executor cancel",
            "Probe: /hypagraph executor probe [acp|cli]",
          ];
          if (familyView) {
            const familyPendings = listFamilyPendingViews(familyView.scheduler);
            if (familyPendings.length > 1) {
              lines.push(
                `Family: ${familyView.familyId}; ${familyDispatchOccupancySummary(familyView.scheduler)}`,
              );
              for (const pending of familyPendings) {
                lines.push(formatFamilyDispatchSurfaceLine("pending", pending));
              }
            } else if (familyPendings.length === 1) {
              lines.push(formatFamilyDispatchSurfaceLine("pending", familyPendings[0]!));
            } else if (familyView.scheduler.lastOutcome) {
              lines.push(formatFamilyDispatchSurfaceLine("last", familyView.scheduler.lastOutcome));
            } else {
              lines.push(`Family: ${familyView.familyId}; dispatch idle`);
            }
          }
          if (familyView?.executor) {
            lines.push(`Executor projection: ${familyView.executor.summary}`);
          }
          ctx.ui.notify(lines.join("\n"), "info");
        } else if (sub === "cancel") {
          const trackedRoots = listUnsettledIsolatedWorkers(isolatedWorkerPool())
            .map((entry) => cloneActiveIsolatedForTeardown(entry));
          abortActiveIsolatedRootAttempt(
            "The user cancelled executor attempts from /hypagraph executor cancel.",
          );
          const before = isolatedPiController.activeProcessCount();
          const teardown = await isolatedPiController.teardownOnRestore({
            kind: "user",
            reason: "The user cancelled executor attempts from /hypagraph executor cancel.",
          });
          const acpClosed = teardown.acpClosedCount ?? 0;
          const cliClosed = teardown.cliClosedCount ?? 0;
          const piClosed = teardown.terminatedCount;
          const totalClosed = piClosed + acpClosed + cliClosed;
          // Cancel each tracked member task attempt after process teardown (R3 / S4).
          if (trackedRoots.length > 0) {
            const familyForCancel = loadFamilyRecordForController(ctx);
            for (const trackedRoot of trackedRoots) {
              await settleTrackedIsolatedAttempt({
                tracked: trackedRoot,
                reason: "The user cancelled the isolated model worker from /hypagraph executor cancel.",
                correlationId: `isolated-root-user-cancel:${randomUUID()}`,
                ...(familyForCancel === undefined ? {} : { family: familyForCancel }),
                notify: (message, level) => ctx.ui.notify(message, level),
              });
            }
            paintUi(ctx);
            clearIsolatedWorkerPool(isolatedWorkerPool());
          }
          let message: string;
          // Prefer closed counts over the pre-teardown snapshot. An attempt can
          // settle between activeProcessCount and teardownOnRestore.
          if (totalClosed === 0 && trackedRoots.length === 0) {
            message = before === 0
              ? "There is no active executor attempt."
              : "No executor attempt needed cancellation.";
          } else {
            const parts: string[] = [];
            if (piClosed > 0) {
              parts.push(`${piClosed} isolated Pi process(es)`);
            }
            if (acpClosed > 0) {
              parts.push(`${acpClosed} ACP session(s)`);
            }
            if (cliClosed > 0) {
              parts.push(`${cliClosed} CLI process(es)`);
            }
            if (trackedRoots.length > 0) {
              parts.push(
                trackedRoots.length === 1
                  ? `member task '${trackedRoots[0]!.nodeId}' (goal '${trackedRoots[0]!.goalId}')`
                  : `${trackedRoots.length} member isolated tasks`,
              );
            }
            message = parts.length > 0
              ? `Cancelled ${parts.join(" and ")}.`
              : `Cancelled ${totalClosed} executor attempt(s).`;
          }
          ctx.ui.notify(
            message,
            totalClosed === 0 && trackedRoots.length === 0 ? "info" : "warning",
          );
        } else if (sub === "probe") {
          const probeTarget = (words[2] ?? "").toLowerCase();
          const wantAcp = probeTarget === "acp";
          const wantCli = probeTarget === "cli";
          const probeLabel = wantAcp ? "ACP" : wantCli ? "CLI" : "Isolated Pi";
          if (!state?.goal) {
            ctx.ui.notify(
              `${probeLabel} dispatch probe requires an active goal workflow.`,
              "info",
            );
          } else if (wantAcp && isolatedPiController.host.acpRegistry === undefined) {
            ctx.ui.notify(
              "ACP dispatch probe requires a host with createIsolatedPiHost options.acp.",
              "info",
            );
          } else if (wantCli && isolatedPiController.host.cliRegistry === undefined) {
            ctx.ui.notify(
              "CLI dispatch probe requires a host with createIsolatedPiHost options.cli.",
              "info",
            );
          } else {
            const familyProjection = restoreOrMigrateOneMemberFamilySession(
              ctx.sessionManager.getBranch(),
            );
            const family = familyProjection?.family.familySnapshot;
            if (!family) {
              ctx.ui.notify(
                `${probeLabel} dispatch probe requires a goal family projection.`,
                "info",
              );
            } else {
              const nodeId = state.definition.nodes[0]?.id;
              if (!nodeId) {
                ctx.ui.notify(`${probeLabel} dispatch probe requires a workflow node.`, "info");
              } else {
                const attemptId = state.runtime.nodes[nodeId]?.currentAttemptId
                  ?? `probe-${nodeId}`;
                const materialized = wantAcp
                  ? materializeAcpContext({
                    family,
                    state,
                    nodeId,
                    attemptId,
                  })
                  : wantCli
                    ? materializeCliContext({
                      family,
                      state,
                      nodeId,
                      attemptId,
                    })
                    : materializeIsolatedPiContext({
                      family,
                      state,
                      nodeId,
                      attemptId,
                    });
                if (!materialized.ok) {
                  ctx.ui.notify(
                    `${probeLabel} dispatch probe could not materialize context.\n${formatDiagnostics(materialized.diagnostics)}`,
                    "warning",
                  );
                } else {
                  // Aborted signal: execute returns cancelled before process start.
                  // Settlement commands are not applied; this only proves the product call site.
                  // For ACP/CLI, this path reaches host.dispatchAttempt → executeAndSettle*.
                  const probePrefix = wantAcp
                    ? "acp-probe"
                    : wantCli
                      ? "cli-probe"
                      : "isolated-pi-probe";
                  const settlement = await isolatedPiController.dispatchAttempt(
                    materialized.value,
                    AbortSignal.abort(),
                    {
                      at: new Date().toISOString(),
                      correlationId: `${probePrefix}:${randomUUID()}`,
                      commandIdForStep: (stepIndex) => `${probePrefix}:${stepIndex}`,
                    },
                  );
                  if (!settlement.ok) {
                    ctx.ui.notify(
                      `${probeLabel} dispatch probe rejected.\n${formatDiagnostics(settlement.diagnostics)}`,
                      "warning",
                    );
                  } else {
                    ctx.ui.notify(
                      `${probeLabel} dispatch probe: outcome=${settlement.result.outcome} `
                      + `(commands not applied; active=${isolatedPiController.activeProcessCount()}).`,
                      "info",
                    );
                  }
                }
              }
            }
          }
        } else {
          ctx.ui.notify(
            `/hypagraph executor has no '${words.slice(1).join(" ")}' subcommand.\n`
            + "Use: /hypagraph executor [status | probe | cancel]",
            "warning",
          );
        }
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
        paintUi(ctx);
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
      } else if (words[0]?.toLowerCase() === "demo") {
        // Built-in graphs from inside Pi (no model authoring).
        // showcase = tour of every feature graph in order.
        // Start Pi with: pi -e ./extensions/hypagraph.ts --skill ./skills
        const sub = (words[1] ?? DEFAULT_DEMO_ID).toLowerCase();
        if (sub === "list" || sub === "help" || sub === "?") {
          ctx.ui.notify(formatDemoCatalog(), "info");
          return;
        }
        if (!resolveDemoExample(sub) && !isShowcaseTourId(sub)) {
          ctx.ui.notify(
            `Unknown demo '${sub}'.\n${formatDemoCatalog()}`,
            "warning",
          );
          return;
        }
        try {
          ensureNoActiveExecution();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Demo was not started. ${message}`, "warning");
          return;
        }

        /**
         * Create one catalog graph and optionally wait for Run.
         * Returns true when the controller may advance work for this member.
         */
        const startDemoMember = async (
          example: HypagraphDemoExample,
          options: {
            /** Ask for Run on the post-create dock (first tour member / single demo). */
            askRun: boolean;
            /** Optional "Tour 2/6 · loop" line. */
            tourLabel?: string;
          },
        ): Promise<boolean> => {
          hypagoalAuthoring = undefined;
          clearPostCreateGate();
          demoPacingEnabled = true;
          const definition = example.definition();
          const workflowId = randomUUID();
          const goalId = `goal-demo-${example.id}-${randomUUID()}`;
          const createdAt = new Date().toISOString();
          const replacement = state?.goal
            ? replacementConfirmationFor(state, { sessionGeneration, branchGeneration })
            : undefined;
          const budget = example.budget;
          const advisory = {
            code: "hypagraph_demo",
            message: options.tourLabel
              ? `${options.tourLabel}: ${example.summary} (deterministic; no model tasks).`
              : `Started from /hypagraph demo ${example.id}: ${example.summary} (deterministic; no model tasks).`,
          };
          const startInput = {
            objective: example.objective,
            definition,
            workflowId,
            goalId,
            goalWorkflowId: workflowId,
            sessionGeneration,
            branchGeneration,
            advisories: [advisory],
            budget,
          };
          let result = await startRootHypagoal(eventStore.lease(), state, {
            ...startInput,
            at: createdAt,
            ...(replacement === undefined ? {} : { replacementConfirmation: replacement }),
          });
          if (result.kind === "replacement-required") {
            result = await startRootHypagoal(eventStore.lease(), state, {
              ...startInput,
              at: new Date().toISOString(),
              replacementConfirmation: result.confirmation,
            });
          }
          if (result.kind !== "created") {
            demoPacingEnabled = false;
            demoTour = undefined;
            ctx.ui.notify(
              `Demo '${example.id}' was not created.\n${
                result.kind === "rejected"
                  ? formatDiagnostics(result.diagnostics)
                  : "Replacement was not accepted."
              }`,
              "warning",
            );
            return false;
          }
          state = result.state;
          events = [...result.events];
          setSessionRootWorkflowId(sessionContext, state.workflowId);
          projectStoreArtifactWritten = undefined;
          childProjectStoreArtifactWritten = undefined;
          childProjectStoreWorkflowId = undefined;
          eventStore.synchronize({ events, snapshot: state });
          paintUi(ctx);
          const header = options.tourLabel
            ? `${options.tourLabel}\nDemo '${example.id}' · ${example.title}`
            : `Demo '${example.id}' · ${example.title}`;
          if (options.askRun && hostSupportsPostCreateDock(ctx)) {
            postCreateAwaitingUserChoice = true;
            postCreateDockPresented = false;
            ctx.ui.notify(
              `${header}\n`
              + `${example.summary}\n`
              + `Features: ${example.features.join(", ")}\n`
              + `Goal ${state.goal?.goalId}. Post-create dock: choose Run. `
              + (demoTour
                ? `Showcase tour: ${demoTour.ids.length} graphs (${demoTour.ids.join(" → ")}). `
                : "")
              + "After Run, the full colour graph modal opens and each step holds briefly.",
              "info",
            );
            const mayContinue = await resolvePostCreateGate(ctx);
            if (!mayContinue) return false;
          } else {
            clearPostCreateGate();
            ctx.ui.notify(
              `${header}\n`
              + `${example.summary}\n`
              + `Features: ${example.features.join(", ")}`,
              "info",
            );
          }
          paintUi(ctx);
          if (demoPacingEnabled && ctx.hasUI && ctx.mode === "tui") {
            liveGraphSuppressedWorkflowId = undefined;
            liveGraphOpenedForWorkflowId = state.workflowId;
            // Keep the full modal open across tour members (pipeline → rich).
            // openFull refreshes art in place when the modal is already open.
            graphPane.openFull(ctx);
          }
          await queueGoalContinuation(ctx);
          return true;
        };

        /** After one tour member finishes, start the next graph (or end the tour). */
        const advanceDemoTour = async (): Promise<void> => {
          if (!demoTour) return;
          const finishedId = demoTour.ids[demoTour.index] ?? "?";
          // Brief hold on the completed graph so the user can see the final state.
          await sleepDemoHold(demoDispatchHoldMs() || 400);
          demoTour = { ids: demoTour.ids, index: demoTour.index + 1 };
          if (demoTour.index >= demoTour.ids.length) {
            const total = demoTour.ids.length;
            demoTour = undefined;
            demoPacingEnabled = false;
            graphPane.close();
            ctx.ui.notify(
              `Showcase tour complete (${total} graphs, last: ${finishedId}). `
              + "Run /hypagraph demo list for individual graphs.",
              "info",
            );
            paintUi(ctx);
            return;
          }
          const nextId = demoTour.ids[demoTour.index]!;
          const next = resolveDemoExample(nextId);
          if (!next) {
            demoTour = undefined;
            demoPacingEnabled = false;
            ctx.ui.notify(`Showcase tour stopped: unknown demo '${nextId}'.`, "warning");
            return;
          }
          try {
            ensureNoActiveExecution();
          } catch {
            // Previous goal is terminal; replacement create is still allowed.
          }
          const label = `Tour ${demoTour.index + 1}/${demoTour.ids.length} · ${next.id}`;
          const ok = await startDemoMember(next, { askRun: false, tourLabel: label });
          if (!ok) {
            demoTour = undefined;
            demoPacingEnabled = false;
            return;
          }
          // Recurse for remaining members when this graph also finished.
          if (state?.goal?.status === "completed") {
            await advanceDemoTour();
          }
        };

        // showcase / full / tour → multi-graph tour. Other ids → one graph.
        if (isShowcaseTourId(sub)) {
          const ids = showcaseTourIds();
          demoTour = { ids, index: 0 };
          const first = resolveDemoExample(ids[0]!);
          if (!first) {
            demoTour = undefined;
            ctx.ui.notify("Showcase tour has no first graph.", "warning");
            return;
          }
          const ok = await startDemoMember(first, {
            askRun: true,
            tourLabel: `Tour 1/${ids.length} · ${first.id}`,
          });
          if (!ok) {
            demoTour = undefined;
            demoPacingEnabled = false;
            return;
          }
          if (state?.goal?.status === "completed") {
            await advanceDemoTour();
          }
        } else {
          demoTour = undefined;
          const example = resolveDemoExample(sub)!;
          const ok = await startDemoMember(example, { askRun: true });
          if (!ok) demoPacingEnabled = false;
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

  /**
   * Full-view colour-coded graph modal.
   * ctrl+g is Pi external editor; use ctrl+shift+g for Hypagraph.
   * Same path as /hypagraph graph full.
   * Guard the call: older test harnesses and hosts may omit registerShortcut.
   */
  if (typeof pi.registerShortcut === "function") {
    pi.registerShortcut("ctrl+shift+g", {
      description: "Open Hypagraph full graph modal (colour-coded live Mermaid)",
      handler: async (ctx) => {
        if (!state) {
          ctx.ui.notify("There is no active Hypagraph to show.", "info");
          return;
        }
        liveGraphSuppressedWorkflowId = undefined;
        liveGraphOpenedForWorkflowId = state.workflowId;
        paintUi(ctx);
        graphPane.toggleFull(ctx);
      },
    });
  }
}
