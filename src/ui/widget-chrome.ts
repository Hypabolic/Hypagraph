/**
 * Status widget chrome: phase badges, braille spinners, and gold running paint.
 *
 * Pure formatting only. The host drives animation by re-rendering with a new frame.
 */

/** Classic braille spinner frames (Unicode braille patterns). */
export const BRAILLE_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/** Alternate denser braille dots for blocked / waiting pulse. */
export const BRAILLE_PULSE_FRAMES = [
  "⠄",
  "⠆",
  "⠇",
  "⠋",
  "⠙",
  "⠸",
  "⠴",
  "⠤",
] as const;

/** Widget animation interval while the goal is live (~12 fps). */
export const WIDGET_ANIMATION_INTERVAL_MS = 80;

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";

/** Warm gold for active / running work. */
export const GOLD_RGB = [255, 196, 48] as const;
/** Soft green for success terminals. */
export const GREEN_RGB = [120, 200, 120] as const;
/** Amber for blocked / paused. */
export const AMBER_RGB = [240, 170, 60] as const;
/** Soft red for failed / cancelled. */
export const RED_RGB = [230, 100, 100] as const;
/** Muted grey for idle. */
export const MUTED_RGB = [150, 155, 165] as const;

export type WidgetRgb = readonly [number, number, number];

export function ansiFg(rgb: WidgetRgb, text: string, bold = true): string {
  const [r, g, b] = rgb;
  const weight = bold ? ANSI_BOLD : "";
  return `\x1b[38;2;${r};${g};${b}m${weight}${text}${ANSI_RESET}`;
}

export function brailleFrame(
  frames: readonly string[],
  frameIndex: number,
): string {
  if (frames.length === 0) return "";
  const i = ((frameIndex % frames.length) + frames.length) % frames.length;
  return frames[i]!;
}

/**
 * Whether this workflow phase should drive the widget animation loop.
 */
export function widgetPhaseAnimates(phase: string): boolean {
  return phase === "running" || phase === "blocked" || phase === "paused";
}

/**
 * Format the bracketed workflow phase badge for the hypagraph widget title line.
 *
 * Running uses gold + braille spinner. Other phases use static colour cues.
 */
export function formatPhaseBadge(phase: string, frameIndex = 0): string {
  if (phase === "running") {
    const spin = brailleFrame(BRAILLE_SPINNER_FRAMES, frameIndex);
    return ansiFg(GOLD_RGB, `[${spin} running]`);
  }
  if (phase === "blocked") {
    const pulse = brailleFrame(BRAILLE_PULSE_FRAMES, frameIndex);
    return ansiFg(AMBER_RGB, `[${pulse} blocked]`);
  }
  if (phase === "paused") {
    const pulse = brailleFrame(BRAILLE_PULSE_FRAMES, frameIndex);
    return ansiFg(AMBER_RGB, `[${pulse} paused]`);
  }
  if (phase === "completed") {
    return ansiFg(GREEN_RGB, "[completed]");
  }
  if (phase === "failed") {
    return ansiFg(RED_RGB, "[failed]");
  }
  if (phase === "cancelled") {
    return ansiFg(MUTED_RGB, "[cancelled]");
  }
  return `[${phase}]`;
}

/**
 * Format the goal status fragment after `| Goal …`.
 */
export function formatGoalStatusBadge(status: string, frameIndex = 0): string {
  if (status === "active") {
    const spin = brailleFrame(BRAILLE_SPINNER_FRAMES, frameIndex);
    return ansiFg(GOLD_RGB, `${spin} active`);
  }
  if (status === "blocked") {
    return ansiFg(AMBER_RGB, "blocked");
  }
  if (status === "paused") {
    return ansiFg(AMBER_RGB, "paused");
  }
  if (status === "completed") {
    return ansiFg(GREEN_RGB, "completed");
  }
  if (status === "failed") {
    return ansiFg(RED_RGB, "failed");
  }
  if (status === "cancelled") {
    return ansiFg(MUTED_RGB, "cancelled");
  }
  if (status === "budget_limited") {
    return ansiFg(AMBER_RGB, "budget_limited");
  }
  return status;
}

/**
 * Compact status-bar phase chip (footer), same gold spinner when running.
 */
export function formatStatusPhaseChip(phase: string, frameIndex = 0): string {
  if (phase === "running") {
    const spin = brailleFrame(BRAILLE_SPINNER_FRAMES, frameIndex);
    return ansiFg(GOLD_RGB, `${spin} ${phase}`);
  }
  if (phase === "blocked" || phase === "paused") {
    return ansiFg(AMBER_RGB, phase);
  }
  if (phase === "completed") {
    return ansiFg(GREEN_RGB, phase);
  }
  if (phase === "failed") {
    return ansiFg(RED_RGB, phase);
  }
  return phase;
}

/**
 * Host driver that re-paints the widget while the phase is live.
 */
export interface WidgetAnimationDriver {
  /** Provide the latest paint callback (captures state). */
  setPainter: (paint: (() => void) | undefined) => void;
  /** Start or stop the loop based on whether animation is needed. */
  sync: (shouldAnimate: boolean) => void;
  dispose: () => void;
}

export function createWidgetAnimationDriver(
  intervalMs: number = WIDGET_ANIMATION_INTERVAL_MS,
): WidgetAnimationDriver {
  let timer: ReturnType<typeof setInterval> | undefined;
  let painter: (() => void) | undefined;
  let animating = false;

  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const start = (): void => {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      if (!animating || !painter) {
        stop();
        return;
      }
      try {
        painter();
      } catch {
        stop();
      }
    }, intervalMs);
    const handle = timer as { unref?: () => void };
    if (typeof handle.unref === "function") handle.unref();
  };

  return {
    setPainter: (paint) => {
      painter = paint;
    },
    sync: (shouldAnimate) => {
      animating = shouldAnimate;
      if (shouldAnimate) start();
      else stop();
    },
    dispose: () => {
      animating = false;
      painter = undefined;
      stop();
    },
  };
}
