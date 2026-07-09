/**
 * Pure codex CLI rolling-fold parity core.
 *
 * WHY: FC API sessions (Claude/OpenAI Responses driven by the relay) get inline
 * rolling-fold compaction every turn — the relay rewrites the model-visible
 * history with skeletons + the Verbatim Keep before each request. Codex CLI
 * sessions cannot: codex owns its own server-side thread history and exposes no
 * inline compaction hook. The relay's only lever is `thread/inject_items`
 * ("Raw Responses API items to append to the thread's model-visible history").
 *
 * This module reconstructs the SAME folded context an FC session would have —
 * from the codex session's canonical relay transcript — and serializes it into
 * raw Responses API message items. The caller (codexSession wiring) reads the
 * transcript async (worker-backed) and, at a fold epoch, starts a blank thread
 * and injects these items so the codex model sees the relay's fold skeleton
 * instead of codex's own lossy auto-compaction summary.
 *
 * PURITY / RESIDENCY (mirrors foldBirthHydration.ts): no I/O, no engine
 * coupling, deterministic given `rows`. The async transcript read and the
 * inject_items transport live in the caller. Compute is bounded — the input is
 * pre-trimmed by `convertLocalMessagesToSeedHistory` (newest-first maxChars cap
 * with a 2.5x pre-pass), so this is safe to run on the relay event loop within
 * the same envelope as a live FC fold pass.
 *
 * Pipeline:
 *   rows (LocalMessage-shaped transcript)
 *     → convertLocalMessagesToSeedHistory   bounded, strictly-alternating, string seed
 *     → FoldMessage[]                        {role,content:string} passthrough (seed IS a FoldMessage)
 *     → checkFoldTrigger(ALWAYS_ON_FOLD_CONFIG) → turnsToFold (continuous, all turns)
 *     → foldContext(...)                     REAL skeletons + Verbatim Keep, stateless (no eviction/counterStamp)
 *     → serialize                            FoldMessage → raw Responses message item
 *
 * The serialization mapping is proven end-to-end against the live codex 0.133.0
 * binary (probe + rollout JSONL grep): user→input_text, assistant→output_text
 * message items are both accepted by thread/inject_items and land verbatim in
 * the model-visible rollout. See Atlas history for this file.
 */

import {
  convertLocalMessagesToSeedHistory,
  DEFAULT_BIRTH_FOLD_MAX_CHARS,
  resolveBirthFoldMaxChars,
  type BirthFoldSourceRow,
  type BirthFoldConversionStats,
} from '../foldBirthHydration.ts';
import {
  checkFoldTrigger,
  foldContext,
  planActiveTurnStepFold,
  ALWAYS_ON_FOLD_CONFIG,
  type FoldConfig,
  type FoldMessage,
  type SyntheticContextOptions,
  type Turn,
} from '../rollingFold.ts';
import { resolveContextBudget, type ContextBudgetEnv } from '../contextBudget.ts';

// ════════════════════════════════════════════════════════════════════════
// Responses API item types
//
// thread/inject_items takes `items: Array<JsonValue>` documented as "Raw
// Responses API items to append to the thread's model-visible history" — codex
// does NOT validate the shape, it forwards to the OpenAI Responses API, so the
// OpenAI Responses *input item* schema governs. Input-role content uses
// `input_text`; assistant history content uses `output_text`.
// ════════════════════════════════════════════════════════════════════════

export interface ResponsesInputTextPart {
  type: 'input_text';
  text: string;
}
export interface ResponsesOutputTextPart {
  type: 'output_text';
  text: string;
}
export interface ResponsesMessageItem {
  type: 'message';
  role: 'user' | 'assistant';
  content: Array<ResponsesInputTextPart | ResponsesOutputTextPart>;
}

// ════════════════════════════════════════════════════════════════════════
// Serialization
// ════════════════════════════════════════════════════════════════════════

/**
 * Flatten a FoldMessage `content` (typed `string | null | unknown[]`) to plain
 * text. In v1 the fold input is all string-content seed, so every folded
 * message is string-content — but FoldMessage.content is typed wider and the
 * fold engine could in principle surface array/structured content, so this is a
 * defensive safety net: array parts contribute their `.text` (or a compact JSON
 * preview), null/undefined → empty.
 */
export function flattenFoldContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        if (part) parts.push(part);
        continue;
      }
      if (part && typeof part === 'object') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') {
          if (text) parts.push(text);
          continue;
        }
        try {
          parts.push(JSON.stringify(part));
        } catch {
          /* skip unserializable part */
        }
      }
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Map one folded FoldMessage to a raw Responses message item. Proven mapping
 * (live codex 0.133.0): user → input_text, assistant/model → output_text. Any
 * non-assistant role coerces to a user input_text item (defensive — v1 seed is
 * user/assistant only, so this never fires in practice).
 */
export function foldMessageToResponsesItem(msg: FoldMessage): ResponsesMessageItem {
  const isAssistant = msg.role === 'assistant' || msg.role === 'model';
  const text = flattenFoldContent(msg.content);
  return {
    type: 'message',
    role: isAssistant ? 'assistant' : 'user',
    content: [isAssistant ? { type: 'output_text', text } : { type: 'input_text', text }],
  };
}

/**
 * Serialize folded FoldMessages → raw Responses items for thread/inject_items.
 * Empty-text items are dropped (they carry no signal; foldContext never emits
 * empty fold blocks and the converter drops empty rows, so this is a safety
 * net, not a structural transform — Responses tolerates non-strict alternation).
 */
export function serializeFoldedMessagesToResponsesItems(
  messages: readonly FoldMessage[],
): ResponsesMessageItem[] {
  const items: ResponsesMessageItem[] = [];
  for (const msg of messages) {
    const item = foldMessageToResponsesItem(msg);
    if (item.content[0].text.length > 0) items.push(item);
  }
  return items;
}

// ════════════════════════════════════════════════════════════════════════
// Epoch predicate
//
// The codex analog of the FC char-threshold fold trigger. FC folds on
// model-visible char count every turn; codex history lives server-side, so we
// trigger reconstruction off cumulative token usage vs the model context
// window. Hysteresis (reconstructIntervalTokens) prevents re-reading the full
// transcript every turn once usage sits inside the fold band.
// ════════════════════════════════════════════════════════════════════════

export interface CodexEpochConfig {
  /**
   * Absolute steady-state target, in provider-measured prompt tokens, at which
   * a fold-epoch reconstruction fires. Like FC sessions, this defaults to an
   * absolute band instead of scaling with the model context window: larger
   * windows are safety margin, not permission to carry proportionally larger
   * standing context.
   */
  targetTokensBeforeFold?: number;
  /**
   * Safety cap as a fraction of the model context window. The effective trigger
   * is min(targetTokensBeforeFold, contextWindowTokens * foldBandFraction), so
   * small-window models still fold before their warning band.
   */
  foldBandFraction?: number;
  /** Absolute token floor below which we never reconstruct (short sessions need no fold). */
  minTokensBeforeFold?: number;
  /** Cumulative-token mark of the last reconstruction, for hysteresis. Omit on first call. */
  lastReconstructedAtTokens?: number;
  /** Minimum token growth since the last reconstruction before firing again. */
  reconstructIntervalTokens?: number;
}

export const DEFAULT_CODEX_FOLD_BAND_FRACTION = 0.7;
// Pure-predicate fallback trigger. Live CodexSession does not use this default:
// it resolves a transport-aware trigger through resolveContextBudget so Codex CLI
// reconstruction uses the shared live trigger while remaining a whole-transcript-
// refold transport (no append-only cache economics).
// The post-fold crush stays aggressive via ALWAYS_ON_FOLD_CONFIG ("collapse all
// the way down"); do NOT add a token floor or soften that config to raise
// steady-state occupancy — see the aggressive-crush hazard in Atlas history.
export const DEFAULT_CODEX_FOLD_TARGET_TOKENS = 170_000;
export const DEFAULT_CODEX_MIN_TOKENS = 8_000;
export const DEFAULT_CODEX_RECONSTRUCT_INTERVAL = 20_000;

export interface CodexFoldTargetOptions {
  model?: string | null;
  contextWindowTokens?: number;
  env?: ContextBudgetEnv;
}

/**
 * Resolve the live Codex CLI fold trigger through the shared Context Warp
 * budget resolver. The pure epoch predicate below keeps its historical fallback
 * for standalone callers, while CodexSession calls this helper so CLI codex uses
 * the shared live trigger with explicit env/instance overrides and runway clamps.
 *
 * Returns foldTriggerTokens, NOT bandTokens: the band is the post-recompute
 * orbit the fold crushes toward, not the trigger. Returning the band here
 * latched the Codex epoch trigger to 100K and made it thrash (rail-851c8254 /
 * Jonah 2026-06-18).
 */
export function resolveCodexFoldTargetTokens(options: CodexFoldTargetOptions = {}): number {
  return resolveContextBudget({
    model: options.model ?? undefined,
    engine: 'codex',
    env: options.env,
    contextWindowTokens: options.contextWindowTokens,
  }).foldTriggerTokens;
}

/**
 * Decide whether a codex session has crossed into the fold band and should have
 * its model-visible history reconstructed (thread/start blank + inject_items)
 * at the next epoch boundary. Pure and cheap. The caller owns the actual
 * transcript read + inject; this only answers "are we due?".
 */
export function shouldReconstructCodexEpoch(
  cumulativeTokenUsage: number,
  contextWindowTokens: number,
  config: CodexEpochConfig = {},
): boolean {
  if (!Number.isFinite(cumulativeTokenUsage) || cumulativeTokenUsage <= 0) return false;
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return false;

  const minTokens = config.minTokensBeforeFold ?? DEFAULT_CODEX_MIN_TOKENS;
  if (cumulativeTokenUsage < minTokens) return false;

  const band = config.foldBandFraction ?? DEFAULT_CODEX_FOLD_BAND_FRACTION;
  const bandCapTokens = contextWindowTokens * band;
  const targetTokens = config.targetTokensBeforeFold ?? DEFAULT_CODEX_FOLD_TARGET_TOKENS;
  const effectiveTriggerTokens = Number.isFinite(targetTokens) && targetTokens > 0
    ? Math.min(targetTokens, bandCapTokens)
    : bandCapTokens;
  if (cumulativeTokenUsage < effectiveTriggerTokens) return false;

  // Hysteresis: once inside the band, don't reconstruct again until usage has
  // grown by at least one interval since the last reconstruction.
  const last = config.lastReconstructedAtTokens;
  if (last != null && Number.isFinite(last)) {
    const interval = config.reconstructIntervalTokens ?? DEFAULT_CODEX_RECONSTRUCT_INTERVAL;
    if (cumulativeTokenUsage - last < interval) return false;
  }

  return true;
}

// ════════════════════════════════════════════════════════════════════════
// Window-aware fold seed cap
//
// DEFAULT_BIRTH_FOLD_MAX_CHARS (600K chars ≈ 150K tokens) is the EVENT-LOOP
// residency ceiling — sized so the first fold pass stays in the measured clean
// band (foldBirthHydration history: 2M-char raw → ~34ms). On the ~1M-window
// world it was tuned for, 600K is ≈15% of the window, so reconstruction left
// ample headroom. Applied verbatim to a SMALL window it overflows: against
// codex-5.5's real 258K effective window (contextWindow.ts gpt-5.5), 600K chars
// ≈ 150K tokens is ≈58% of the window, so on incompressible content (fold
// saved≈0%) the reconstructed seed + the ~90K system/128-tool schema overhead
// lands at the wall — the Voxxo-codex (UChw0eb_) crash at 264,175 input tokens,
// "ran out of room in the model's context window" (2026-06-14).
//
// Fix: size the seed to ~15% of the REAL window, restoring the original headroom
// ratio on small windows; the min() with the event-loop ceiling keeps
// large-window behavior byte-identical. Dropped seed beyond the cap stays in the
// canonical transcript + recall, so this is continuity-safe.
// ════════════════════════════════════════════════════════════════════════

/**
 * Seed (raw, pre-fold) should not exceed ~15% of the window in tokens — the
 * implied fraction of the 600K default at the 1M window it was sized for.
 */
export const CODEX_FOLD_SEED_WINDOW_FRACTION = 0.15;
/**
 * Conservative chars→budget ratio for SIZING the char cap from a token window.
 * Sizing math only — NOT token telemetry (GOD RULE: token counts stay
 * provider-measured). Over-counting chars/token only shrinks the seed (safe).
 */
const CODEX_FOLD_SEED_CHARS_PER_TOKEN = 4;
/** Degenerate-input floor; never binds for real relay windows (≥200K → ≥120K chars). */
const CODEX_FOLD_SEED_MIN_CHARS = 40_000;

/**
 * Window-aware seed char cap for codex fold reconstruction. Returns the smaller
 * of (a) the event-loop-safe ceiling — DEFAULT_BIRTH_FOLD_MAX_CHARS, or the
 * VOXXO_FOLD_BIRTH_MAX_CHARS operator override when `envRawMaxChars` is passed —
 * and (b) ~15% of the real model window expressed in chars. Small windows shrink
 * to fit with headroom; large windows keep the unchanged ceiling. A non-finite or
 * non-positive window returns the ceiling (safe fallback). Pure + deterministic.
 */
export function resolveCodexFoldSeedMaxChars(
  contextWindowTokens: number,
  envRawMaxChars?: string,
): number {
  const ceiling = resolveBirthFoldMaxChars(envRawMaxChars);
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return ceiling;
  }
  const windowFitChars = Math.round(
    contextWindowTokens * CODEX_FOLD_SEED_WINDOW_FRACTION * CODEX_FOLD_SEED_CHARS_PER_TOKEN,
  );
  return Math.max(CODEX_FOLD_SEED_MIN_CHARS, Math.min(ceiling, windowFitChars));
}

// Codex transcripts are flattened through birth-fold hydration before epoch
// reconstruction. That keeps injection simple, but it erases the structured
// tool-call boundaries the shared marathon fold planner needs. Recreate just
// enough synthetic structure from the rendered trace markers to split a single
// giant active Codex turn into foldable steps.
const CODEX_TOOL_STEP_SPLIT_RE = /\n\n(?=⟨tool (?!result\b))/g;
const CODEX_TOOL_STEP_START_RE = /^⟨tool\s+(?!result\b)([^\s⟩]+)/;
const CODEX_STEP_FOLD_KEEP_LAST_STEPS = 12;
const CODEX_STEP_FOLD_MIN_ACTIVE_TURN_CHARS = 20_000;

function addSyntheticToolBoundary(msg: FoldMessage, segment: string, index: number): FoldMessage {
  const match = CODEX_TOOL_STEP_START_RE.exec(segment);
  if (!match) return { ...msg, content: segment };
  return {
    ...msg,
    content: segment,
    tool_calls: [
      {
        id: `codex-step-${index}`,
        type: 'function',
        function: {
          name: match[1] || 'tool',
          arguments: '{}',
        },
      },
    ],
  };
}

function splitCodexAssistantStepMessages(msg: FoldMessage): FoldMessage[] {
  if (msg.role !== 'assistant' && msg.role !== 'model') return [msg];
  if (typeof msg.content !== 'string') return [msg];
  if (!msg.content.includes('⟨tool ')) return [msg];

  const segments = msg.content
    .split(CODEX_TOOL_STEP_SPLIT_RE)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length <= 1) return [msg];

  return segments.map((segment, index) => addSyntheticToolBoundary(msg, segment, index));
}

function expandCodexStepBoundaries(messages: readonly FoldMessage[]): FoldMessage[] {
  const expanded: FoldMessage[] = [];
  for (const msg of messages) expanded.push(...splitCodexAssistantStepMessages(msg));
  return expanded;
}

function resolveCodexStepFoldActiveTurnBudget(maxChars: number, foldConfig: FoldConfig): number {
  const budget = foldConfig.assistantTextBudget;
  const budgetBasedActiveTurnChars = budget
    ? Math.max(1, budget.fullRetentionChars + budget.essenceRetentionChars)
    : 150_000;
  const capBasedActiveTurnChars = Math.floor(maxChars * 0.25);
  return Math.min(
    budgetBasedActiveTurnChars,
    Math.max(CODEX_STEP_FOLD_MIN_ACTIVE_TURN_CHARS, capBasedActiveTurnChars),
  );
}

// ════════════════════════════════════════════════════════════════════════
// Top-level pure pipeline
// ════════════════════════════════════════════════════════════════════════

export interface BuildCodexFoldItemsOptions {
  /** Newest-first retention cap for the birth-fold pre-trim. Default DEFAULT_BIRTH_FOLD_MAX_CHARS. */
  maxChars?: number;
  /**
   * Fold config. Default ALWAYS_ON_FOLD_CONFIG (continuous: true,
   * activeWindowTurns: 1) — byte-for-byte the config the live FC inter-turn
   * fold uses for rollingFold mode 'on', which is what gives true parity.
   */
  foldConfig?: FoldConfig;
  /** Host-supplied wrappers that the fold engine should ignore as synthetic. */
  syntheticContext?: SyntheticContextOptions;
}

export interface CodexFoldStats {
  conversion: BirthFoldConversionStats;
  seedMessages: number;
  shouldFold: boolean;
  turnsToFold: number;
  foldReason: string;
  foldedMessages: number;
  emittedItems: number;
  originalChars: number;
  foldedChars: number;
  savingsPercent: number;
}

export interface BuildCodexFoldItemsResult {
  items: ResponsesMessageItem[];
  stats: CodexFoldStats;
  /** Bounded raw fold input used to build the epoch skeleton. */
  rawMessages: FoldMessage[];
  /** Folded model-visible view serialized into Responses items. */
  foldedMessages: FoldMessage[];
  /**
   * Step-segment tiling used when a single oversized active Codex turn is
   * step-folded (the synthetic-boundary path below). Pass to buildFoldIndex as
   * precomputedTurns so each folded step becomes recall-addressable — without it
   * detectTurns collapses the flattened one-user-turn seed to a single turn and
   * the recall index comes back empty. Undefined on the normal multi-turn fold
   * path (detectTurns reproduces the segmentation there).
   */
  recallTurns?: Turn[];
}

/**
 * Pure, deterministic transform: canonical transcript rows → folded raw
 * Responses items ready for thread/inject_items. No I/O, no side effects,
 * bounded compute (input pre-trimmed by the birth-fold converter). Calling this
 * twice on identical rows yields identical items.
 */
export function buildCodexFoldItems(
  rows: readonly BirthFoldSourceRow[],
  options: BuildCodexFoldItemsOptions = {},
): BuildCodexFoldItemsResult {
  const foldConfig = options.foldConfig ?? ALWAYS_ON_FOLD_CONFIG;
  const maxChars = options.maxChars ?? DEFAULT_BIRTH_FOLD_MAX_CHARS;
  const syntheticContext = options.syntheticContext ?? {};

  // 1. Transcript rows → bounded, strictly-alternating, string-content seed.
  const { messages: seed, stats: conversion } = convertLocalMessagesToSeedHistory(rows, { maxChars });

  // 2. Seed is {role:'user'|'assistant', content:string} → FoldMessage[].
  //    Explicit {role,content} map (zero-divergence equivalent of
  //    seedToOpenAIChatMessage) keeps the FoldMessage shape unambiguous.
  const foldInput: FoldMessage[] = seed.map((m) => ({ role: m.role, content: m.content }));

  let rawMessages = foldInput;
  let shouldFold = false;
  let turnsToFold = 0;
  let foldReason = 'no fold';
  let fold: ReturnType<typeof foldContext> | null = null;
  let recallTurns: Turn[] | undefined;

  // 3. Prefer a synthetic step tiling for the Codex marathon shape before the
  //    normal continuous trigger sees "one detected turn" and folds it as an
  //    indivisible blob. That keeps old tool steps recall-addressable.
  const stepFoldInput = expandCodexStepBoundaries(foldInput);
  if (stepFoldInput.length > foldInput.length) {
    const stepPlan = planActiveTurnStepFold(stepFoldInput, {
      activeTurnCharBudget: resolveCodexStepFoldActiveTurnBudget(maxChars, foldConfig),
      keepLastSteps: CODEX_STEP_FOLD_KEEP_LAST_STEPS,
    }, syntheticContext);
    if (stepPlan) {
      rawMessages = stepFoldInput;
      recallTurns = stepPlan.turns;
      shouldFold = true;
      turnsToFold = stepPlan.turnsToFold;
      foldReason =
        `codex active-turn step fold: ${stepPlan.turnsToFold} old step(s), ` +
        `keeping ${CODEX_STEP_FOLD_KEEP_LAST_STEPS}`;
      fold = foldContext(
        stepFoldInput,
        stepPlan.turnsToFold,
        foldConfig,
        undefined,
        undefined,
        stepPlan.turns,
        syntheticContext,
      );
    }
  }

  // 4. Real rolling fold (skeletons + Verbatim Keep), stateless: no eviction
  //    input (no tombstones) and no counterStamp (deterministic).
  if (!fold) {
    const trigger = checkFoldTrigger(foldInput, foldConfig, syntheticContext);
    shouldFold = trigger.shouldFold;
    turnsToFold = trigger.turnsToFold;
    foldReason = trigger.reason;
    fold = trigger.shouldFold
      ? foldContext(foldInput, trigger.turnsToFold, foldConfig, undefined, undefined, undefined, syntheticContext)
      : null;
  }

  const foldedMessages: FoldMessage[] = fold ? fold.messages : rawMessages;

  // 5. Serialize folded messages → raw Responses items.
  const items = serializeFoldedMessagesToResponsesItems(foldedMessages);

  const stats: CodexFoldStats = {
    conversion,
    seedMessages: rawMessages.length,
    shouldFold,
    turnsToFold,
    foldReason,
    foldedMessages: foldedMessages.length,
    emittedItems: items.length,
    originalChars: fold ? fold.originalChars : conversion.totalChars,
    foldedChars: fold ? fold.foldedChars : conversion.totalChars,
    savingsPercent: fold ? fold.savingsPercent : 0,
  };

  return { items, stats, rawMessages, foldedMessages, recallTurns };
}
