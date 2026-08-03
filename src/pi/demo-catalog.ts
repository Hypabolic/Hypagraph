/**
 * Built-in showcase graphs for /hypagraph demo.
 *
 * Fully deterministic: only check, gate, and interaction nodes.
 * No model tasks and no isolated workers. After Run, the controller advances
 * checks and gates without a remote model. Interaction still needs a human answer.
 *
 * Between deterministic steps the product host holds so the live graph is
 * readable. See demoDispatchHoldMs.
 */

import type { GoalBudgetDefinition, HypagraphDefinition } from "../domain/model.js";
import { validateDefinition } from "../domain/validate.js";

/**
 * Default hold between demo check/gate steps in interactive Pi (milliseconds).
 * Gives the live graph dock time to show each state change on video.
 */
export const DEFAULT_DEMO_DISPATCH_HOLD_MS = 2_000;

/** Longer hold when HYPA_DEMO_SLOW=1 (recording with narration). */
export const SLOW_DEMO_DISPATCH_HOLD_MS = 3_500;

/**
 * Resolve the hold between deterministic demo dispatches.
 *
 * - 0 when HYPA_DEMO_FAST=1 or under Vitest (automated tests stay fast)
 * - HYPA_DEMO_PACE_MS when set to a non-negative number (wins over slow)
 * - SLOW_DEMO_DISPATCH_HOLD_MS when HYPA_DEMO_SLOW=1
 * - DEFAULT_DEMO_DISPATCH_HOLD_MS otherwise
 */
export function demoDispatchHoldMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (env.HYPA_DEMO_FAST === "1") return 0;
  if (env.VITEST === "true" || env.VITEST === "1") return 0;
  const raw = env.HYPA_DEMO_PACE_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  if (env.HYPA_DEMO_SLOW === "1") return SLOW_DEMO_DISPATCH_HOLD_MS;
  return DEFAULT_DEMO_DISPATCH_HOLD_MS;
}

/** Sleep helper for demo pacing. No-op when ms <= 0. */
export function sleepDemoHold(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One named demo graph. */
export interface HypagraphDemoExample {
  /** Command id: /hypagraph demo <id> */
  id: string;
  /** Short label for list and notify. */
  title: string;
  /** One-line description. */
  summary: string;
  /** Features shown (for list chrome). */
  features: readonly string[];
  /** Durable objective (must match definition.goal). */
  objective: string;
  /** Build a fresh definition object. */
  definition: () => HypagraphDefinition;
  /**
   * Demo budget. Prefer turns only — never a tight token cap.
   * Chat/model usage must not stop a deterministic demo mid-graph.
   */
  budget: GoalBudgetDefinition;
}

/** Default demo budget: plenty of controller turns, no token ceiling. */
const DEMO_BUDGET: GoalBudgetDefinition = {
  maximumTurns: 80,
};

/** Shared command check that always passes (local `true`, no network). */
const passCheck = (
  fact: string,
): NonNullable<HypagraphDefinition["nodes"][0]["check"]> => ({
  kind: "command",
  command: "true",
  timeoutMs: 5_000,
  publish: [{ source: "passed", fact }],
});

const checkNode = (
  id: string,
  title: string,
  requires: string[],
  fact: string,
): HypagraphDefinition["nodes"][0] => ({
  id,
  title,
  kind: "check",
  requires,
  acceptance: [`${title} passes.`],
  check: passCheck(fact),
  produces: [{ name: fact, type: "boolean", required: true }],
});

/**
 * basic — check then interaction (fast product path).
 */
const basic = (): HypagraphDefinition => ({
  title: "Demo · basic",
  goal: "Demo basic: pass a smoke check, then get user approval.",
  nodes: [
    checkNode("smoke-check", "Smoke check", [], "demo.check_passed"),
    {
      id: "approve",
      title: "Approve result",
      kind: "interaction",
      requires: ["smoke-check"],
      acceptance: ["The user answers."],
      produces: [{ name: "demo.approved", type: "boolean", required: true }],
      interaction: {
        kind: "interaction",
        version: 1,
        presentation: { class: "deterministic", kind: "none" },
        question: "Approve the basic demo check?",
        responses: [
          {
            id: "approve",
            label: "Approve",
            publish: [{ name: "demo.approved", type: "boolean", value: true }],
          },
          {
            id: "reject",
            label: "Reject",
            publish: [{ name: "demo.approved", type: "boolean", value: false }],
          },
        ],
      },
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

/**
 * loop — multi-node repair loop (Mermaid subgraph). Both steps are checks.
 */
const loop = (): HypagraphDefinition => ({
  title: "Demo · implement-verify loop",
  goal: "Demo loop: repair until the verification check passes inside a bounded region.",
  nodes: [
    {
      id: "implement",
      title: "Implement fix",
      kind: "check",
      // Feedback edge verify -> implement is a real requires cycle (loop entry pattern).
      requires: ["verify"],
      acceptance: ["A candidate fix is ready."],
      check: passCheck("fix.ready"),
      produces: [{ name: "fix.ready", type: "boolean", required: true }],
    },
    {
      id: "verify",
      title: "Verify fix",
      kind: "check",
      requires: ["implement"],
      acceptance: ["Verification passes."],
      check: passCheck("fix.passed"),
      produces: [{ name: "fix.passed", type: "boolean", required: true }],
    },
    checkNode("ship", "Ship", ["verify"], "ship.done"),
  ],
  loops: [{
    id: "repair-loop",
    nodes: ["implement", "verify"],
    entry: "implement",
    evaluateAfter: "verify",
    feedbackEdges: [{ from: "verify", to: "implement" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "fix.passed" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 3,
    failurePolicy: "block-dependants",
  }],
  policy: { mode: "guided", requireEvidence: false },
});

/**
 * fanout — gate with true/false branches (route fan-out / skip).
 */
const fanout = (): HypagraphDefinition => ({
  title: "Demo · gate fan-out",
  goal: "Demo fan-out: a gate selects the fast path or the repair path, then integrates.",
  nodes: [
    checkNode("probe", "Probe health", [], "probe.ok"),
    {
      id: "route",
      title: "Route path",
      kind: "gate",
      requires: ["probe"],
      acceptance: ["A route is selected."],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "probe.ok" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["fast-path"],
        onFalse: ["repair-path"],
      },
    },
    checkNode("fast-path", "Fast path", ["route"], "fast.done"),
    checkNode("repair-path", "Repair path", ["route"], "repair.done"),
    checkNode("integrate", "Integrate", ["fast-path", "repair-path"], "integrate.done"),
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

/**
 * parallel — two independent top-level components (disconnected subgraphs).
 * Ready checks on separate components start together so both paths run concurrent.
 */
const parallel = (): HypagraphDefinition => ({
  title: "Demo · parallel components",
  goal: "Demo parallel: two independent components run at the same time, then merge.",
  nodes: [
    checkNode("alpha-build", "Alpha build", [], "alpha.ready"),
    checkNode("alpha-check", "Alpha check", ["alpha-build"], "alpha.ok"),
    checkNode("beta-build", "Beta build", [], "beta.ready"),
    checkNode("beta-check", "Beta check", ["beta-build"], "beta.ok"),
    checkNode("merge-report", "Merge report", ["alpha-check", "beta-check"], "merge.done"),
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

/**
 * pipeline — linear multi-stage with gate + human release.
 */
const pipeline = (): HypagraphDefinition => ({
  title: "Demo · multi-stage pipeline",
  goal: "Demo pipeline: prepare, implement, verify, gate release readiness, then human release approval.",
  nodes: [
    checkNode("prepare", "Prepare", [], "prep.done"),
    checkNode("implement", "Implement", ["prepare"], "impl.done"),
    checkNode("verify", "Verify", ["implement"], "verify.ok"),
    {
      id: "release-gate",
      title: "Release gate",
      kind: "gate",
      requires: ["verify"],
      acceptance: ["Release route is chosen."],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "verify.ok" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["release-approve"],
        onFalse: ["hold-back"],
      },
    },
    checkNode("hold-back", "Hold back", ["release-gate"], "hold.done"),
    {
      id: "release-approve",
      title: "Approve release",
      kind: "interaction",
      requires: ["release-gate"],
      acceptance: ["User approves or rejects release."],
      produces: [{ name: "release.ok", type: "boolean", required: true }],
      interaction: {
        kind: "interaction",
        version: 1,
        presentation: { class: "deterministic", kind: "none" },
        question: "Approve release for the pipeline demo?",
        responses: [
          {
            id: "ship",
            label: "Ship",
            publish: [{ name: "release.ok", type: "boolean", value: true }],
          },
          {
            id: "block",
            label: "Block",
            publish: [{ name: "release.ok", type: "boolean", value: false }],
          },
        ],
      },
    },
  ],
  loops: [],
  policy: { mode: "guided", requireEvidence: false },
});

/**
 * rich — one dense graph: parallel entry, gate fan-out, loop region, final interaction.
 * Featured last in the showcase tour. Run alone with /hypagraph demo rich.
 */
const rich = (): HypagraphDefinition => ({
  title: "Demo · rich combined",
  goal: "Demo rich: parallel intake, route fan-out, bounded polish loop, and final approval.",
  // Short titles keep Mermaid widget labels readable under Pi's 10-line widget cap.
  nodes: [
    checkNode("docs-scan", "Docs", [], "docs.ok"),
    checkNode("code-scan", "Code", [], "code.ok"),
    checkNode("merge-intake", "Merge", ["docs-scan", "code-scan"], "intake.ready"),
    {
      id: "risk-gate",
      title: "Risk",
      kind: "gate",
      requires: ["merge-intake"],
      acceptance: ["Risk path selected."],
      gate: {
        condition: {
          kind: "compare",
          left: { kind: "fact", name: "code.ok" },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
        onTrue: ["light-touch"],
        onFalse: ["deep-repair"],
      },
    },
    checkNode("light-touch", "Light", ["risk-gate"], "light.done"),
    checkNode("deep-repair", "Deep", ["risk-gate"], "deep.done"),
    {
      id: "polish",
      title: "Polish",
      kind: "check",
      // Cycle close: acceptance -> polish. Gate branches feed polish via requires.
      requires: ["acceptance", "light-touch", "deep-repair"],
      acceptance: ["Polish pass ready."],
      check: passCheck("polish.done"),
      produces: [{ name: "polish.done", type: "boolean", required: true }],
    },
    {
      id: "acceptance",
      title: "Accept",
      kind: "check",
      requires: ["polish"],
      acceptance: ["Acceptance passes."],
      check: passCheck("accept.ok"),
      produces: [{ name: "accept.ok", type: "boolean", required: true }],
    },
    {
      id: "final-approve",
      title: "Ship",
      kind: "interaction",
      requires: ["acceptance"],
      acceptance: ["User final decision recorded."],
      produces: [{ name: "final.ok", type: "boolean", required: true }],
      interaction: {
        kind: "interaction",
        version: 1,
        presentation: { class: "deterministic", kind: "none" },
        question: "Ship the rich demo result?",
        responses: [
          {
            id: "ship",
            label: "Ship",
            publish: [{ name: "final.ok", type: "boolean", value: true }],
          },
          {
            id: "rework",
            label: "Rework",
            publish: [{ name: "final.ok", type: "boolean", value: false }],
          },
        ],
      },
    },
  ],
  loops: [{
    id: "polish-loop",
    nodes: ["polish", "acceptance"],
    entry: "polish",
    evaluateAfter: "acceptance",
    feedbackEdges: [{ from: "acceptance", to: "polish" }],
    successWhen: {
      kind: "compare",
      left: { kind: "fact", name: "accept.ok" },
      operator: "eq",
      right: { kind: "literal", value: true },
    },
    maxIterations: 3,
    failurePolicy: "block-dependants",
  }],
  policy: { mode: "guided", requireEvidence: false },
});

/**
 * Ordered tour for `/hypagraph demo` / `showcase`.
 * Each id is a separate catalog graph shown in sequence after Run.
 */
export const SHOWCASE_TOUR_IDS = [
  "basic",
  "loop",
  "fanout",
  "parallel",
  "pipeline",
  "rich",
] as const;

export type ShowcaseTourDemoId = (typeof SHOWCASE_TOUR_IDS)[number];

/** Catalog order for /hypagraph demo list (single graphs + tour + rich). */
export const HYPAGRAPH_DEMO_EXAMPLES: readonly HypagraphDemoExample[] = [
  {
    id: "basic",
    title: "Basic check + approve",
    summary: "Fast path: smoke check then interaction. Fully deterministic.",
    features: ["check", "interaction", "no model"],
    objective: basic().goal,
    definition: basic,
    budget: DEMO_BUDGET,
  },
  {
    id: "loop",
    title: "Implement-verify loop",
    summary: "Bounded repair loop (check steps only). Mermaid loop subgraph.",
    features: ["loop", "feedback edge", "check", "no model"],
    objective: loop().goal,
    definition: loop,
    budget: DEMO_BUDGET,
  },
  {
    id: "fanout",
    title: "Gate fan-out",
    summary: "Gate selects fast path or repair path, then integrate. All checks.",
    features: ["gate", "fan-out", "skip route", "check", "no model"],
    objective: fanout().goal,
    definition: fanout,
    budget: DEMO_BUDGET,
  },
  {
    id: "parallel",
    title: "Parallel components",
    summary: "Two independent components run concurrently, then merge. All checks.",
    features: ["disconnected components", "concurrent checks", "check", "no model"],
    objective: parallel().goal,
    definition: parallel,
    budget: DEMO_BUDGET,
  },
  {
    id: "pipeline",
    title: "Multi-stage pipeline",
    summary: "Linear checks → release gate → human approve. No model tasks.",
    features: ["pipeline", "gate", "interaction", "check", "no model"],
    objective: pipeline().goal,
    definition: pipeline,
    budget: DEMO_BUDGET,
  },
  {
    id: "rich",
    title: "Rich combined graph",
    summary: "One dense graph: parallel, fan-out, loop, final approve.",
    features: ["parallel", "gate fan-out", "loop subgraph", "interaction", "no model"],
    objective: rich().goal,
    definition: rich,
    budget: DEMO_BUDGET,
  },
  {
    id: "showcase",
    title: "Showcase tour (all graphs)",
    summary: `Runs all ${SHOWCASE_TOUR_IDS.length} feature graphs in order: ${SHOWCASE_TOUR_IDS.join(" → ")}.`,
    features: ["tour", "all graphs", "no model"],
    // First tour member objective — tour starts with basic after Run.
    objective: basic().goal,
    definition: basic,
    budget: DEMO_BUDGET,
  },
];

/** Default when the user types /hypagraph demo with no id. */
export const DEFAULT_DEMO_ID = "showcase";

/** Aliases: readme → basic for older docs. */
const ALIASES: Record<string, string> = {
  readme: "basic",
  default: DEFAULT_DEMO_ID,
  full: "showcase",
  tour: "showcase",
  gates: "fanout",
  branch: "fanout",
  components: "parallel",
  // Older name for the dense combined graph.
  combined: "rich",
};

/** True when the id starts the multi-graph showcase tour. */
export function isShowcaseTourId(rawId: string | undefined): boolean {
  const key = (rawId ?? DEFAULT_DEMO_ID).trim().toLowerCase();
  const id = ALIASES[key] ?? key;
  return id === "showcase";
}

/** Ordered tour members (never includes the meta showcase id). */
export function showcaseTourIds(): readonly ShowcaseTourDemoId[] {
  return SHOWCASE_TOUR_IDS;
}

export function listDemoExamples(): readonly HypagraphDemoExample[] {
  return HYPAGRAPH_DEMO_EXAMPLES;
}

export function resolveDemoExample(rawId: string | undefined): HypagraphDemoExample | undefined {
  const key = (rawId ?? DEFAULT_DEMO_ID).trim().toLowerCase();
  if (key === "list" || key === "help" || key === "?") return undefined;
  const id = ALIASES[key] ?? key;
  return HYPAGRAPH_DEMO_EXAMPLES.find((example) => example.id === id);
}

export function formatDemoCatalog(): string {
  const tour = SHOWCASE_TOUR_IDS.join(" → ");
  const lines = [
    "Usage: /hypagraph demo [list | <id>]",
    `Default id: ${DEFAULT_DEMO_ID} (tour of all feature graphs)`,
    "",
    "All demos are fully deterministic (check / gate / interaction only).",
    "No remote model tasks. After Run, the controller advances without LLM work.",
    "You only answer interaction docks when they open.",
    `showcase runs every graph in order: ${tour}`,
    `Between check and gate steps the live graph holds ~${Math.round(DEFAULT_DEMO_DISPATCH_HOLD_MS / 1000)}s so each state is visible.`,
    "Override hold with HYPA_DEMO_PACE_MS (milliseconds). HYPA_DEMO_FAST=1 skips holds.",
    "",
    "Examples:",
  ];
  for (const example of HYPAGRAPH_DEMO_EXAMPLES) {
    lines.push(`  ${example.id.padEnd(10)} ${example.title}`);
    lines.push(`             ${example.summary}`);
    lines.push(`             features: ${example.features.join(", ")}`);
  }
  lines.push("");
  lines.push("Aliases: full|tour→showcase, combined→rich, readme→basic, gates→fanout, components→parallel");
  lines.push("Start Pi: pi -e ./extensions/hypagraph.ts --skill ./skills");
  return lines.join("\n");
}

/** Validate every catalog definition (tests and boot checks). */
export function validateDemoCatalog(): { id: string; diagnostics: ReturnType<typeof validateDefinition> }[] {
  return HYPAGRAPH_DEMO_EXAMPLES.map((example) => ({
    id: example.id,
    diagnostics: validateDefinition(example.definition()),
  }));
}

/** True when a definition has no model/task/code/effect nodes (demo invariant). */
export function definitionIsDeterministicDemo(definition: HypagraphDefinition): boolean {
  return definition.nodes.every((node) => {
    const kind = node.kind ?? "task";
    return kind === "check" || kind === "gate" || kind === "interaction";
  });
}

// Compatibility re-exports for older import sites.
export const README_DEMO_OBJECTIVE = basic().goal;
export function readmeDemoDefinition(): HypagraphDefinition {
  return basic();
}
