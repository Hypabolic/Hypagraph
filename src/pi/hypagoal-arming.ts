/**
 * Hypagoal arming for one user turn.
 *
 * Arming records that the model may create a Hypagoal. It does not create
 * canonical state and it does not force goal creation.
 */

export const DEFAULT_HYPAGOAL_TRIGGER_WORD = "hypagoal";
export const HYPAGOAL_TRIGGER_SETTINGS_SCHEMA_VERSION = 1 as const;
export const HYPAGOAL_ARMED_STATUS_KEY = "hypagoal-arm";
export const HYPAGOAL_ARMED_STATUS_TEXT = "Hypagoal armed";

export interface HypagoalTriggerSettings {
  schemaVersion: typeof HYPAGOAL_TRIGGER_SETTINGS_SCHEMA_VERSION;
  /**
   * Configured trigger word.
   * Null means arming is off.
   */
  word: string | null;
}

export const defaultHypagoalTriggerSettings = (): HypagoalTriggerSettings => ({
  schemaVersion: HYPAGOAL_TRIGGER_SETTINGS_SCHEMA_VERSION,
  word: DEFAULT_HYPAGOAL_TRIGGER_WORD,
});

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Remove fenced code blocks so a trigger word in a fence does not arm.
 * Uses non-greedy fences. An unclosed fence removes the rest of the text.
 */
export const stripFencedCodeBlocks = (text: string): string =>
  text.replace(/```[\s\S]*?(?:```|$)/g, " ");

/**
 * Remove inline code spans so a trigger word in backticks does not arm.
 */
export const stripInlineCodeSpans = (text: string): string =>
  text.replace(/`[^`\n]*`/g, " ");

const PATH_CHARS = /[\\/]/;
const LEADING_PUNCT = /^[("'[{<]+/;
const TRAILING_PUNCT = /[)"'\]}>.,;:!?]+$/;

/**
 * True when a whitespace token is a file path or path-like reference.
 */
export const tokenLooksLikePath = (token: string): boolean => {
  if (PATH_CHARS.test(token)) return true;
  if (token.startsWith("./") || token.startsWith("../")) return true;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  return false;
};

/**
 * Normalize one token for trigger comparison.
 * Strips common leading and trailing punctuation. Keeps internal hyphens.
 */
export const normalizeTriggerToken = (token: string): string =>
  token.replace(LEADING_PUNCT, "").replace(TRAILING_PUNCT, "");

/**
 * One highlightable trigger match in the editor buffer.
 *
 * Indices are UTF-16 code units in the JavaScript string (same system as
 * `Editor.getText()` and `String.prototype.slice`).
 */
export interface TriggerMatchSpan {
  /** Inclusive start index in the original buffer. */
  start: number;
  /** Exclusive end index in the original buffer. */
  end: number;
  /** Exact buffer substring for this match (core token without surrounding punctuation). */
  text: string;
}

/**
 * Mask fenced and inline code so those regions cannot arm or highlight.
 * Replaces each excluded region with spaces of the same length so indices stay aligned.
 */
export const maskExcludedCodeRegions = (text: string): string => {
  const maskFences = text.replace(/```[\s\S]*?(?:```|$)/g, (match) => " ".repeat(match.length));
  return maskFences.replace(/`[^`\n]*`/g, (match) => " ".repeat(match.length));
};

/**
 * Return every highlightable trigger span for the draft text and settings.
 *
 * A non-empty list is returned if and only if `messageArmsHypagoal` is true.
 * Indices use UTF-16 code units so they match the Pi editor buffer.
 *
 * Rules match submit arming:
 * - arming is off when settings.word is null or empty;
 * - a match inside a fenced or inline code span is excluded;
 * - a match inside a path-like token is excluded;
 * - a match uses whole-token equality after punctuation normalize, case-insensitive.
 */
export const findHypagoalTriggerSpans = (
  text: string,
  settings: HypagoalTriggerSettings,
): TriggerMatchSpan[] => {
  const word = settings.word?.trim() ?? "";
  if (word.length === 0) return [];

  const masked = maskExcludedCodeRegions(text);
  const needle = word.toLowerCase();
  const spans: TriggerMatchSpan[] = [];
  const tokenPattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(masked)) !== null) {
    const tokenStart = match.index;
    const tokenEnd = tokenStart + match[0].length;
    const token = text.slice(tokenStart, tokenEnd);
    if (tokenLooksLikePath(token)) continue;

    const leading = token.match(LEADING_PUNCT)?.[0] ?? "";
    const withoutLeading = token.slice(leading.length);
    const trailing = withoutLeading.match(TRAILING_PUNCT)?.[0] ?? "";
    const core = withoutLeading.slice(0, withoutLeading.length - trailing.length);
    if (core.length === 0) continue;
    if (core.toLowerCase() !== needle) continue;

    const start = tokenStart + leading.length;
    const end = start + core.length;
    spans.push({ start, end, text: text.slice(start, end) });
  }
  return spans;
};

/**
 * Decide whether the user message arms Hypagoal creation for this turn.
 *
 * Uses the same span finder as live editor highlight so the two signals never diverge.
 */
export const messageArmsHypagoal = (
  text: string,
  settings: HypagoalTriggerSettings,
): boolean => findHypagoalTriggerSpans(text, settings).length > 0;

/**
 * Parse trigger settings from stored JSON.
 * Returns the default settings when the value is missing or invalid.
 */
export const parseHypagoalTriggerSettings = (value: unknown): HypagoalTriggerSettings => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return defaultHypagoalTriggerSettings();
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== HYPAGOAL_TRIGGER_SETTINGS_SCHEMA_VERSION) {
    return defaultHypagoalTriggerSettings();
  }
  if (record.word === null) {
    return { schemaVersion: HYPAGOAL_TRIGGER_SETTINGS_SCHEMA_VERSION, word: null };
  }
  if (typeof record.word === "string") {
    const word = record.word.trim();
    if (word.length === 0) {
      return { schemaVersion: HYPAGOAL_TRIGGER_SETTINGS_SCHEMA_VERSION, word: null };
    }
    return { schemaVersion: HYPAGOAL_TRIGGER_SETTINGS_SCHEMA_VERSION, word };
  }
  return defaultHypagoalTriggerSettings();
};

/**
 * Build settings for `/hypagraph trigger set <word>`.
 * Rejects empty words.
 */
export const setHypagoalTriggerWord = (word: string): { ok: true; settings: HypagoalTriggerSettings } | { ok: false; message: string } => {
  const trimmed = word.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "The trigger word must not be empty." };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, message: "The trigger word must be one word without spaces." };
  }
  return {
    ok: true,
    settings: { schemaVersion: HYPAGOAL_TRIGGER_SETTINGS_SCHEMA_VERSION, word: trimmed },
  };
};

export const disableHypagoalTrigger = (): HypagoalTriggerSettings => ({
  schemaVersion: HYPAGOAL_TRIGGER_SETTINGS_SCHEMA_VERSION,
  word: null,
});

/**
 * System-prompt block when arming is active for the current turn.
 * The block does not force goal creation.
 */
export const hypagoalArmedPromptBlock = (triggerWord: string): string => [
  "HYPAGOAL ARMING:",
  `Hypagoal creation is armed for this turn because the user message contains the trigger word '${triggerWord}'.`,
  "Arming is not a command to create a goal.",
  "Create a Hypagoal only when the request is real repository work that needs a graph.",
  "If the request does not need a graph, continue without calling hypagoal_start.",
  "Arming creates no canonical state. Only hypagoal_start creates a goal.",
].join("\n");

/**
 * Validate a candidate trigger word for path-safe matching.
 * Used only for authoring diagnostics in tests and commands.
 */
export const triggerWordPattern = (word: string): RegExp =>
  new RegExp(`(?:^|\\s)${escapeRegExp(word)}(?:$|\\s|[.,;:!?)]|")`, "i");
