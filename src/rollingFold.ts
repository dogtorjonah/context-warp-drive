/**
 * Rolling Fold Compaction — deterministic heuristic compression of old
 * conversation turns into structural skeletons.
 *
 * Zero LLM calls. Character-count triggered. Session-agnostic.
 *
 * Pipeline position: raw transcript -> stepCompaction -> thinContext() -> foldContext() -> repair -> API.
 * Raw transcript is NEVER mutated. Folding produces a view.
 */

// ══════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════

export interface FoldMessage {
  role: string;
  content: string | null | unknown[];
  reasoning_content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
}

export type TurnCategory = 'research' | 'action' | 'decision' | 'navigation' | 'error' | 'coordination';

export type FoldMode = 'off' | 'dry-run' | 'on';

export interface AssistantTextBudget {
  /** Cumulative chars of assistant text to preserve at full fidelity (newest folded turns first). */
  fullRetentionChars: number;
  /** Cumulative chars to preserve via essence extraction (after full budget exhausted). */
  essenceRetentionChars: number;
}

export interface FoldConfig {
  /** Number of recent turns kept out of threshold-gated, non-continuous folds. */
  activeWindowTurns: number;
  /** Char-count soft threshold — fold oldest ~30% of foldable turns when exceeded. */
  softThresholdChars: number;
  /** Char-count hard threshold — fold oldest ~60% of foldable turns. */
  hardThresholdChars: number;
  /** Maximum turns before folding regardless of char count. */
  maxTurnsBeforeFold: number;
  /** Budget-based graduated compression for assistant text in folded turns.
   *  Replaces the old category-gated approach where nav/coord/error turns lost all text. */
  assistantTextBudget?: AssistantTextBudget;
  /** When true, fold every detected turn on every call, bypassing the soft/hard
   *  char and maxTurns thresholds (continuous always-on inter-turn fold).
   *  assistantTextBudget still governs graduated per-turn detail. Default config
   *  leaves this undefined -> existing threshold-gated behavior is unchanged. */
  continuous?: boolean;
  /**
   * Budget in chars for the Coordinate Closet appended to the fold block.
   * Set 0 to disable. Default: 4000.
   */
  verbatimKeepChars?: number;
}

export interface FoldedTurn {
  timestamp: string;
  category: TurnCategory;
  skeleton: string;
  retained?: string;
  charsSaved: number;
}

export interface FoldResult {
  messages: FoldMessage[];
  originalChars: number;
  foldedChars: number;
  savingsPercent: number;
  turnsFolded: number;
  turnsRetained: number;
  foldSummaries: FoldedTurn[];
  /** Updated eviction span state (present only when a FoldEvictionInput was provided). */
  evictedSpans?: FoldEvictionSpan[];
  /** Turns newly tombstoned this pass (present only when a FoldEvictionInput was provided). */
  newlyEvictedTurns?: number;
  /** Full-recompute eviction decision when a caller supplied a targeted eviction frontier. */
  evictionOutcome?: FoldEvictionOutcome;
}

export type FoldEvictionOutcome = 'evicted' | 'partial_frontier_limited' | 'nothing_eligible';

export interface FoldTrigger {
  shouldFold: boolean;
  turnsToFold: number;
  reason: string;
}

/**
 * A contiguous run of evicted fold ordinals rendered as ONE tombstone line
 * (E10 eviction). Ordinals are detectTurns positions over the folded
 * history — stable across epochs because raw history is append-only and
 * eviction is strictly oldest-first, so spans always tile a contiguous prefix
 * [0, toOrdinalExclusive) of the fold zone.
 */
export interface FoldEvictionSpan {
  /** First evicted turn ordinal (inclusive), in detectTurns order. */
  fromOrdinal: number;
  /** One past the last evicted turn ordinal. */
  toOrdinalExclusive: number;
  /** Turns evicted in this span (merged spans sum their counts). */
  turnCount: number;
  /** ISO timestamp of the oldest eviction event merged into this span. */
  firstEvictedIso: string;
  /** ISO timestamp of the newest eviction event merged into this span. */
  lastEvictedIso: string;
}

/**
 * Eviction input for one foldContext pass (E10). Provided ONLY by the freeze
 * EPOCH recompute path — the prefix is recomputing anyway, so tombstone
 * substitution is cache-safe by construction. Eligibility is computed by the
 * session (durable episodic-store coverage ∧ ≥2-epoch fold age); foldContext
 * applies geometry only.
 */
export interface FoldEvictionInput {
  /** Spans evicted at prior epochs, ascending and contiguous from ordinal 0. */
  evictedSpans: readonly FoldEvictionSpan[];
  /** Ordinals below this may be NEWLY evicted this pass. */
  evictableThroughOrdinal: number;
  /**
   * Optional full-recompute target: advance the tombstone frontier at least this
   * far, clamped by evictableThroughOrdinal and the current fold zone. When
   * absent, foldContext keeps the legacy threshold sawtooth behavior.
   */
  targetEvictThroughOrdinal?: number;
  /** Fold-block char threshold/enabled gate (VOXXO_FOLD_EVICT_THRESHOLD_CHARS). */
  thresholdChars: number;
  /** Wall-clock stamp for spans created this pass (injected for determinism). */
  nowIso: string;
}

// ══════════════════════════════════════════════════════════════════════
// Defaults
// ══════════════════════════════════════════════════════════════════════

export const DEFAULT_ASSISTANT_TEXT_BUDGET: AssistantTextBudget = {
  fullRetentionChars: 50_000,
  essenceRetentionChars: 100_000,
};

export const DEFAULT_FOLD_CONFIG: FoldConfig = {
  activeWindowTurns: 20,
  softThresholdChars: 800_000,
  hardThresholdChars: 1_500_000,
  maxTurnsBeforeFold: 60,
  assistantTextBudget: DEFAULT_ASSISTANT_TEXT_BUDGET,
  verbatimKeepChars: 4000,
};

/**
 * Always-on inter-turn fold config — compresses every turn past the active
 * window into a skeleton on every call, regardless of char/turn thresholds, so
 * historical context stays lean from the moment the conversation grows past
 * activeWindowTurns. Used when an instance's rollingFold mode is 'on' (or
 * 'dry-run' for preview). This is the inter-turn sibling of
 * ALWAYS_ON_INTRA_FOLD_CONFIG: intra-turn slims consumed tool results inside the
 * working set; this slims the narrative history behind it.
 *
 * "Cheaper but still adequate signal": the soft/hard char + maxTurns gates are
 * bypassed (continuous: true → checkFoldTrigger folds all foldable turns every
 * turn), but every signal-preservation rule that made threshold-gated folding
 * safe is unchanged:
 *   - continuous folding has no hidden newest-turn floor: when enabled it asks
 *     foldContext to fold every detected turn. Non-continuous threshold folding
 *     still uses activeWindowTurns as its trigger hysteresis.
 *   - assistantTextBudget (50K full / 100K essence, allocated newest-first)
 *     governs graduated per-turn detail: newest folded turns keep their full
 *     assistant text, older turns keep an essence summary, only the oldest
 *     collapse to a pure tool-call skeleton. Reasoning degrades
 *     gradually, never cliff-edged — the exact machinery added (5/14) to fix the
 *     two layers of reasoning loss that category-gated folding caused.
 *   - the fold is recoverable, not destructive — foldContext returns a new array
 *     and never mutates the raw JSONL, so any folded turn is one self-tap away.
 *
 * Continuous mode can fold even a single detected turn; when that folds the whole
 * view, the newest user text is retained inside the folded block and the output
 * ends on the folded user message.
 */
export const ALWAYS_ON_FOLD_CONFIG: FoldConfig = {
  ...DEFAULT_FOLD_CONFIG,
  continuous: true,
  // Rebirth-cadence sizing (overrides DEFAULT's 20). Agents in this swarm rebirth
  // every ~2-3 turns, so a 20-turn active window meant turnCount never exceeded it
  // → the continuous inter-turn fold NEVER engaged for this workflow (dead code).
  // Dropped to 1: only the CURRENT turn is the guaranteed-verbatim floor, and every
  // turn behind it folds on every call. Live working memory stays intact, the
  // assistantTextBudget (50K full / 100K essence, newest-first) carries recent
  // REASONING text past the floor, and raw tool results from prior turns skeletonize
  // (recoverable via self-tap). Inter-turn analog of intra-turn's tailBuffer.
  // Reel-back: raise to 2 to also keep the immediately-previous turn verbatim
  // (restores the "read last turn, act this turn" pattern at full tool-result fidelity).
  activeWindowTurns: 1,
};

// ══════════════════════════════════════════════════════════════════════
// Target-band budgeting (E10b)
//
// Today's base fold budgets are absolute char constants calibrated against a
// 100K-token band (400K chars at the fold's 4 chars/token estimate). The band
// resolver keeps that base reproducible while making the public default band
// explicit and tunable: 160K tokens by default, independent of model context
// window size. Every ratio below is calibrated so an explicit 100K-token band
// reproduces the existing constants EXACTLY (base-equivalence, locked by tests).
// The remainder of the band (~56.5%) is working-set + skeleton headroom.
// ══════════════════════════════════════════════════════════════════════

/**
 * Default chars-per-token assumption for converting a token-denominated band
 * target into a char budget. Claude-calibrated (~4). Denser-tokenizing engines
 * (code/JSON/path-heavy transcripts) can pass a lower ratio so the default
 * 160K-token band target yields a correspondingly smaller char budget — i.e.
 * the band stays pinned to real tokens, not chars. Passing 100K explicitly
 * reproduces every existing fold constant EXACTLY (base-equivalence, locked by
 * tests).
 */
export const BAND_CHARS_PER_TOKEN = 4;

/** Public steady-state fold-band default for omitted/undefined band targets. */
export const DEFAULT_FOLD_BAND_TOKENS = 100_000;

export interface FoldBandBudgets {
  bandTokens: number;
  /** bandTokens × charsPerToken (default 4). */
  bandChars: number;
  /** 12.5% of band chars → assistantTextBudget.fullRetentionChars (50K at the 100K base band). */
  fullRetentionChars: number;
  /** 25% of band chars → assistantTextBudget.essenceRetentionChars (100K at the 100K base band). */
  essenceRetentionChars: number;
  /** 5.5% of band chars → fold-block eviction threshold (22K at the 100K base band; see E10). */
  evictThresholdChars: number;
  /** 0.5% of band chars → episodic boundary char budget (2K at the 100K base band; see foldEpisodes.ts). */
  episodicBoundaryBudgetChars: number;
}

/**
 * Optional fidelity overrides — when provided by the governor, these replace
 * the default 0.125/0.25 multipliers. Allows quality-driven ratio adjustment
 * without changing band size.
 */
export interface FidelityOverrides {
  /** Fraction of bandChars for full retention. Overrides default 0.125. */
  fullRetentionFraction?: number;
  /** Fraction of bandChars for essence retention. Overrides default 0.25. */
  essenceRetentionFraction?: number;
}

/**
 * Cherry-picked graduated fidelity — intrinsic trace value weights.
 *
 * The default budget allocation is a pure recency ramp (newest folded turns win
 * full/essence, oldest collapse to skeleton) regardless of whether an old turn
 * is still relevant. FidelityOverrides only tunes the GLOBAL full/essence
 * fractions; it cannot promote a specific high-value old turn. These weights
 * drive that per-turn cherry-pick, scoring value INTRINSICALLY from the trace
 * (forward path re-reference + durable glyph) — never from the episodic store.
 */
export interface FidelityValueWeights {
  /** Downstream reference where a later turn READS the same path. */
  read: number;
  /** Downstream reference where a later turn CLAIMS the same path (commits to working there). */
  claim: number;
  /** Downstream reference where a later turn EDITS the same path. */
  edit: number;
  /** Multiplier when the downstream reference is in the live active window, not just a later folded turn. */
  activeWindowMultiplier: number;
  /** Additive bonus when the folded turn's assistant text opens with a durable register glyph (🏁 verdict / ⚠️ hazard). */
  glyphDurableBonus: number;
}

export const DEFAULT_FIDELITY_VALUE_WEIGHTS: FidelityValueWeights = {
  read: 1,
  claim: 3,
  edit: 4,
  activeWindowMultiplier: 2,
  glyphDurableBonus: 2,
};

/** Newest folded turns always allocated before value ranking — the working-set recency floor. */
export const DEFAULT_FIDELITY_VALUE_RECENCY_FLOOR_TURNS = 8;

/**
 * Per-call input enabling intrinsic value-aware graduated fidelity. Provided
 * ONLY by the freeze EPOCH full-recompute path (cache-safe by construction, the
 * same gate as FoldEvictionInput); append/hot-reuse must never pass it. Absent →
 * the newest-first recency ramp runs byte-identically.
 */
export interface FoldFidelityValueInput {
  /** Per-call weight overrides; omitted fields fall back to DEFAULT_FIDELITY_VALUE_WEIGHTS. */
  weights?: Partial<FidelityValueWeights>;
  /** Newest K folded turns kept on the recency floor (budget priority before value). Default 8. */
  recencyFloorTurns?: number;
}

/**
 * Pure arithmetic — derive the dependent fold budgets from a target
 * steady-state band. `charsPerToken` converts the token target into chars;
 * the default (4) preserves ratio math, while a lower per-engine ratio keeps
 * the band pinned to real tokens on denser tokenizers.
 *
 * When `fidelity` is provided, the retention fractions are overridden — this
 * is the quality-driven lever (band controls total size, fidelity controls
 * what proportion stays at each tier).
 */
export function resolveFoldBandBudgets(
  bandTokens: number,
  charsPerToken: number = BAND_CHARS_PER_TOKEN,
  fidelity?: FidelityOverrides,
): FoldBandBudgets {
  const bandChars = bandTokens * charsPerToken;
  return {
    bandTokens,
    bandChars,
    fullRetentionChars: Math.round(bandChars * (fidelity?.fullRetentionFraction ?? 0.125)),
    essenceRetentionChars: Math.round(bandChars * (fidelity?.essenceRetentionFraction ?? 0.25)),
    evictThresholdChars: Math.round(bandChars * 0.055),
    episodicBoundaryBudgetChars: Math.round(bandChars * 0.005),
  };
}

/**
 * Band-aware ALWAYS_ON fold config. `undefined` (env knob unset) uses the
 * public 160K default band. A band returns a copy with the assistant-text
 * budget scaled by the documented ratios; explicit 100K deep-equals the
 * unscaled base config.
 *
 * When `fidelity` is provided, the retention fractions are overridden —
 * enabling quality-driven ratio adjustment.
 */
export function resolveFoldConfigForBand(
  bandTokens: number | undefined = DEFAULT_FOLD_BAND_TOKENS,
  charsPerToken: number = BAND_CHARS_PER_TOKEN,
  fidelity?: FidelityOverrides,
): FoldConfig {
  const resolvedBandTokens = bandTokens ?? DEFAULT_FOLD_BAND_TOKENS;
  const band = resolveFoldBandBudgets(resolvedBandTokens, charsPerToken, fidelity);
  return {
    ...ALWAYS_ON_FOLD_CONFIG,
    assistantTextBudget: {
      fullRetentionChars: band.fullRetentionChars,
      essenceRetentionChars: band.essenceRetentionChars,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// Internal helpers
// ══════════════════════════════════════════════════════════════════════

export function countChars(messages: FoldMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'string') total += block.length;
        else if (typeof block === 'object' && block !== null) {
          total += JSON.stringify(block).length;
        }
      }
    } else if (Array.isArray((msg as any).parts)) {
      for (const part of (msg as any).parts as any[]) {
        if (typeof part?.text === 'string') {
          total += part.text.length;
        } else if (part !== null && typeof part === 'object') {
          total += JSON.stringify(part).length;
        }
      }
    }
    const rc = msg.reasoning_content;
    if (typeof rc === 'string') total += rc.length;
  }
  return total;
}

export interface Turn {
  startIndex: number;
  endIndex: number;
  messages: FoldMessage[];
}

const FOLD_MARKER = '[Conversation Context —';

/** Prefix of full-content fold-recall cards injected at tool boundaries (see foldRecall.ts). */
export const RECALL_CARD_PREFIX = '[Recalled from fold —';
/** Prefix of one-line fold-recall hints injected at tool boundaries (see foldRecall.ts). */
export const RECALL_HINT_PREFIX = '[Fold recall hint —';

/** Prefix of the one-line fold-epoch stamp emitted at the first tool boundary after a freeze epoch (see fcBaseSession.ts). */
export const FOLD_EPOCH_STAMP_PREFIX = '[Fold epoch #';

/**
 * Prefix of the episodic-recall block (durable blast-radius memory cards from
 * fold-episodes.sqlite) injected at tool boundaries (see fcBaseSession.ts /
 * foldEpisodes.ts). Synthetic like recall cards: excluded from real-turn
 * detection and from mention-signal extraction (self-excitation guard — the
 * matcher must never read paths out of its own injected cards), and aged out
 * by later fold epochs like any other tool-boundary payload.
 */
export const EPISODIC_RECALL_PREFIX = '[Episodic recall —';

/** Synthetic vault note appended to live user turns with bounded operator-message excerpts. */
export const USER_MESSAGE_VAULT_PREFIX = '[User Message Vault]';
export const USER_MESSAGE_VAULT_END = '[/User Message Vault]';

export type SyntheticContextStripMode =
  | 'line'
  | 'line-or-paragraph'
  | 'paragraph'
  | 'bracketed'
  | 'paired';

export interface LeadingSyntheticContextBlock {
  readonly prefix: string;
  readonly mode: SyntheticContextStripMode;
  readonly end?: string;
}

export type SyntheticContextMatcher = (text: string) => boolean;

/**
 * Host-supplied synthetic context markers.
 *
 * The standalone package owns only Context Warp's fold/recall/vault markers.
 * Hosts that prepend their own envelopes (for example a runtime resume wrapper,
 * chat digest, or lifecycle package) pass those markers here so turn detection,
 * fold-recall, and episode capture can ignore them without baking host strings
 * into the generic engine.
 */
export interface SyntheticContextOptions {
  /** Extra standalone prefixes that mark a whole text block as synthetic. */
  readonly prefixes?: readonly string[];
  /** Leading user-message blocks to strip before mining genuine operator text. */
  readonly leadingBlocks?: readonly LeadingSyntheticContextBlock[];
  /** Whole-text predicates for envelopes that should be consumed completely. */
  readonly wholeTextMatchers?: readonly SyntheticContextMatcher[];
}

const EMPTY_SYNTHETIC_CONTEXT_OPTIONS: SyntheticContextOptions = Object.freeze({});

/**
 * Prefix of tombstone lines inside the fold block marking spans whose detail
 * was evicted to the episodic store (E10). Lives INSIDE the block (never
 * standalone injected text), so it needs no isSyntheticContextText arm; it
 * must never collide with FOLD_MARKER (the block's first-line anchor that
 * foldRecall's buildFoldIndex parses).
 */
export const FOLD_TOMBSTONE_PREFIX = '[Paged to episodic store — ';

/** Default fold-block char ceiling that arms eviction (override: VOXXO_FOLD_EVICT_THRESHOLD_CHARS; '0' disables). */
export const DEFAULT_FOLD_EVICT_THRESHOLD_CHARS = 22_000;

/** Format the epoch stamp: `[Fold epoch #N — detail]`, detail capped at 120 chars. */
export function formatFoldEpochStamp(epoch: number, detail: string): string {
  const capped = detail.length > 120 ? detail.slice(0, 120) : detail;
  return `${FOLD_EPOCH_STAMP_PREFIX}${epoch} — ${capped}]`;
}

/**
 * Self-documenting preamble rendered inside every fold block immediately after
 * the header line. Single line by invariant: it must never start with '[' and
 * must never contain a line starting with FOLD_MARKER or a recall prefix —
 * the block's FIRST line stays the FOLD_MARKER header that foldRecall's
 * buildFoldIndex parses. Full mechanics: docs/context-folding.md.
 */
export const FOLD_BLOCK_PREAMBLE = '(Context note: older turns were auto-folded into the skeletons below. The ⌖ COORDINATE CLOSET block below conserves closet items — ids/paths/values from folded turns — trust it before re-reading files. Folded content that becomes relevant again is paged back in automatically as "[Recalled from fold —" cards at tool boundaries. Claiming a file you already touched triggers a re-fold that unfolds it — claim deliberately. Mechanics: docs/context-folding.md)';

function matchesHostSyntheticContext(text: string, options: SyntheticContextOptions): boolean {
  for (const prefix of options.prefixes ?? []) {
    if (text.startsWith(prefix)) return true;
  }
  for (const block of options.leadingBlocks ?? []) {
    if (text.startsWith(block.prefix)) return true;
  }
  for (const matcher of options.wholeTextMatchers ?? []) {
    if (matcher(text)) return true;
  }
  return false;
}

/**
 * Synthetic Context Warp text — fold blocks, fold-recall cards/hints,
 * fold-epoch stamps, and host-supplied markers — is never a real user turn
 * boundary. Recall payloads therefore
 * attach to the turn they follow, so they skeletonize away at later fold
 * epochs (page-out-again, fully cyclic) and never inflate turn-count
 * triggers. Exported so foldRecall.ts can apply the same exclusion when
 * extracting real user text.
 */
export function isSyntheticContextText(
  text: string,
  syntheticContext: SyntheticContextOptions = EMPTY_SYNTHETIC_CONTEXT_OPTIONS,
): boolean {
  return text.startsWith(FOLD_MARKER)
    || text.startsWith(RECALL_CARD_PREFIX)
    || text.startsWith(RECALL_HINT_PREFIX)
    || text.startsWith(FOLD_EPOCH_STAMP_PREFIX)
    || text.startsWith(USER_MESSAGE_VAULT_PREFIX)
    || text.startsWith(EPISODIC_RECALL_PREFIX)
    || matchesHostSyntheticContext(text, syntheticContext);
}

export function stripUserMessageVaultBlocks(text: string): string {
  let result = text;
  for (let guard = 0; guard < 20; guard += 1) {
    const start = result.indexOf(USER_MESSAGE_VAULT_PREFIX);
    if (start < 0) break;
    const end = result.indexOf(USER_MESSAGE_VAULT_END, start + USER_MESSAGE_VAULT_PREFIX.length);
    if (end < 0) break;
    const removeEnd = end + USER_MESSAGE_VAULT_END.length;
    const before = result.slice(0, start).replace(/[ \t]*\n{0,2}$/, '');
    const after = result.slice(removeEnd).replace(/^\n{0,2}[ \t]*/, '');
    result = before && after ? `${before}\n\n${after}` : `${before}${after}`;
  }
  return result;
}

function stripLeadingLine(body: string, leading: string): string {
  const lineEnd = body.indexOf('\n');
  const after = lineEnd < 0 ? '' : body.slice(lineEnd + 1).replace(/^(?:[ \t]*\r?\n)+/, '');
  return `${leading}${after}`;
}

function stripLeadingParagraph(body: string, leading: string): string {
  const paragraphEnd = body.search(/\r?\n[ \t]*\r?\n/);
  const after = paragraphEnd < 0 ? '' : body.slice(paragraphEnd).replace(/^(?:[ \t]*\r?\n)+/, '');
  return `${leading}${after}`;
}

function stripOneLeadingSyntheticUserContextBlock(
  text: string,
  syntheticContext: SyntheticContextOptions,
): string | null {
  const leadingMatch = /^[ \t]*(?:\r?\n)*/.exec(text);
  const leading = leadingMatch?.[0] ?? '';
  const body = text.slice(leading.length);

  for (const matcher of syntheticContext.wholeTextMatchers ?? []) {
    if (matcher(body)) return leading;
  }

  for (const prefix of syntheticContext.prefixes ?? []) {
    if (body.startsWith(prefix)) return leading;
  }

  for (const block of syntheticContext.leadingBlocks ?? []) {
    if (!body.startsWith(block.prefix)) continue;
    switch (block.mode) {
      case 'line':
        return stripLeadingLine(body, leading);
      case 'paragraph':
        return stripLeadingParagraph(body, leading);
      case 'line-or-paragraph': {
        const lineEnd = body.indexOf('\n');
        const firstLine = lineEnd < 0 ? body : body.slice(0, lineEnd).replace(/\r$/, '');
        return firstLine.trimEnd() === block.prefix
          ? stripLeadingParagraph(body, leading)
          : stripLeadingLine(body, leading);
      }
      case 'bracketed': {
        const end = body.indexOf(']', block.prefix.length);
        if (end < 0) return null;
        const after = body.slice(end + 1).replace(/^(?:[ \t]*\r?\n)+/, '');
        return `${leading}${after}`;
      }
      case 'paired': {
        if (!block.end) return null;
        const end = body.indexOf(block.end, block.prefix.length);
        if (end < 0) return null;
        const after = body.slice(end + block.end.length).replace(/^(?:[ \t]*\r?\n)+/, '');
        return `${leading}${after}`;
      }
    }
  }

  return null;
}

export function stripSyntheticUserContextBlocks(
  text: string,
  syntheticContext: SyntheticContextOptions = EMPTY_SYNTHETIC_CONTEXT_OPTIONS,
): string {
  let result = stripUserMessageVaultBlocks(text);
  for (let guard = 0; guard < 20; guard += 1) {
    const next = stripOneLeadingSyntheticUserContextBlock(result, syntheticContext);
    if (next === null || next === result) break;
    result = next;
  }
  return result;
}

function isUserTurnBoundary(msg: FoldMessage, syntheticContext: SyntheticContextOptions): boolean {
  if (msg.role !== 'user') return false;
  const content = msg.content;
  if (typeof content === 'string') {
    const cleaned = stripSyntheticUserContextBlocks(content, syntheticContext).trim();
    return cleaned.length > 0 && !isSyntheticContextText(cleaned, syntheticContext);
  }
  if (Array.isArray(content)) {
    return content.some((block: any) => {
      const text = block?.type === 'text' && typeof block.text === 'string'
        ? block.text
        : typeof block === 'string'
          ? block
          : '';
      const cleaned = stripSyntheticUserContextBlocks(text, syntheticContext).trim();
      return cleaned.length > 0 && !isSyntheticContextText(cleaned, syntheticContext);
    });
  }
  const parts = (msg as any).parts;
  if (Array.isArray(parts)) {
    return parts.some((part: any) => {
      const cleaned = typeof part?.text === 'string'
        ? stripSyntheticUserContextBlocks(part.text, syntheticContext).trim()
        : '';
      return cleaned.length > 0 && !isSyntheticContextText(cleaned, syntheticContext);
    });
  }
  return false;
}

export function detectTurns(
  messages: FoldMessage[],
  syntheticContext: SyntheticContextOptions = EMPTY_SYNTHETIC_CONTEXT_OPTIONS,
): Turn[] {
  const turns: Turn[] = [];
  let turnStart = -1;

  for (let i = 0; i < messages.length; i++) {
    if (isUserTurnBoundary(messages[i], syntheticContext)) {
      if (turnStart >= 0) {
        turns.push({ startIndex: turnStart, endIndex: i, messages: messages.slice(turnStart, i) });
      }
      turnStart = i;
    }
  }

  if (turnStart >= 0 && turnStart < messages.length) {
    turns.push({ startIndex: turnStart, endIndex: messages.length, messages: messages.slice(turnStart) });
  }

  return turns;
}

// ── Step-granular segmentation (marathon-turn fold) ──
//
// A "turn" only ends at real user TEXT (isUserTurnBoundary). A long agentic rail
// runs as ONE turn — one kickoff prompt, hundreds of tool steps, no boundary — so
// ordinary inter-turn fold can only compress it as one blob. Step segmentation
// cuts that one oversized turn at agentic-step boundaries (each assistant tool_use
// + its following tool_result span) so the EXISTING foldContext engine can
// skeletonize the OLD steps while the last N steps stay full-fidelity. It rides the
// same budget/retention/recall/episodic machinery via the precomputedTurns seam —
// nothing here re-implements folding; it only re-segments what foldContext folds.
// Durable memory is unaffected: episodic capture derives from RAW, and fold-recall
// maps raw↔view structurally, so the crush depth (keepLastSteps) is a free knob.

/** An assistant message that opens an agentic step (carries a tool call). */
function isStepBoundary(msg: FoldMessage): boolean {
  if (msg.role !== 'assistant' && msg.role !== 'model') return false;
  // Anthropic format: assistant content blocks with type tool_use.
  if (Array.isArray(msg.content) && (msg.content as any[]).some(b => b?.type === 'tool_use')) return true;
  // OpenAI / FC format: tool_calls array on the assistant message.
  const toolCalls = (msg as { tool_calls?: unknown[] }).tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return true;
  // Gemini API format: parts array containing functionCall.
  const parts = (msg as { parts?: unknown[] }).parts;
  if (Array.isArray(parts) && parts.some((p: any) => p?.functionCall)) return true;
  return false;
}

/**
 * Split one turn into pair-safe step segments tiling its GLOBAL index range
 * contiguously (so foldContext's startIndex-based partitioning stays valid). Each
 * segment after the first is a complete tool_use+tool_result span; the leading
 * segment is the turn's kickoff (user text + any pre-tool assistant text). Cuts
 * land only BEFORE an assistant tool_use, never between a tool_use and its result,
 * so the Anthropic tool_use/tool_result chain is never orphaned across the fold seam.
 */
function segmentTurnBySteps(turn: Turn): Turn[] {
  const msgs = turn.messages;
  const base = turn.startIndex;
  const segments: Turn[] = [];
  let segStart = 0;
  for (let i = 1; i < msgs.length; i++) {
    if (isStepBoundary(msgs[i])) {
      segments.push({ startIndex: base + segStart, endIndex: base + i, messages: msgs.slice(segStart, i) });
      segStart = i;
    }
  }
  segments.push({ startIndex: base + segStart, endIndex: base + msgs.length, messages: msgs.slice(segStart) });
  return segments;
}

/** Plan produced when a single oversized active turn is eligible for step-fold. */
export interface StepFoldPlan {
  /** Full contiguous turn tiling (prior real turns + step segments of the active turn). */
  turns: Turn[];
  /** Leading segments to fold; the trailing (turns.length − this) stay full-fidelity. */
  turnsToFold: number;
}

export interface StepFoldOptions {
  /** Engage only when the active (last) turn's char size meets/exceeds this. */
  activeTurnCharBudget: number;
  /** Keep this many trailing steps at full fidelity (the live working thread). */
  keepLastSteps: number;
}

/**
 * Detect the marathon pattern — the LAST detected turn is oversized — and produce a
 * step-segmented turn tiling consumable by foldContext(..., precomputedTurns). Returns
 * null when not applicable (active turn under budget, or too few steps to gain). The
 * caller passes plan.turns as precomputedTurns and plan.turnsToFold as turnsToFold, and
 * SHOULD pass eviction=undefined — fold ordinals here are step-granular, not turn-granular,
 * so turn-keyed eviction spans must not tombstone them (episodic capture still runs on raw).
 */
export function planActiveTurnStepFold(
  messages: FoldMessage[],
  opts: StepFoldOptions,
  syntheticContext: SyntheticContextOptions = EMPTY_SYNTHETIC_CONTEXT_OPTIONS,
): StepFoldPlan | null {
  const turns = detectTurns(messages, syntheticContext);
  if (turns.length === 0) return null;

  const active = turns[turns.length - 1];
  const activeChars = countChars(active.messages);
  if (activeChars < opts.activeTurnCharBudget) return null;

  const segments = segmentTurnBySteps(active);
  if (segments.length <= opts.keepLastSteps + 1) return null;

  const priorTurns = turns.slice(0, turns.length - 1);
  const allTurns = [...priorTurns, ...segments];
  const turnsToFold = allTurns.length - opts.keepLastSteps;
  if (turnsToFold <= priorTurns.length) return null;

  return { turns: allTurns, turnsToFold };
}

// ── Tool extraction ──

interface ExtractedToolCall {
  name: string;
  input: Record<string, unknown>;
  resultText: string;
  toolId: string;
}

function extractToolCalls(turnMessages: FoldMessage[]): ExtractedToolCall[] {
  const calls: ExtractedToolCall[] = [];
  const pending = new Map<string, { name: string; input: Record<string, unknown> }>();

  for (const msg of turnMessages) {
    // Anthropic format: assistant content blocks with type tool_use
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === 'tool_use' && block.name && block.id) {
          pending.set(block.id, { name: block.name, input: block.input ?? {} });
        }
      }
    }

    // OpenAI format: tool_calls array on assistant
    if (msg.role === 'assistant' && Array.isArray((msg as any).tool_calls)) {
      for (const tc of (msg as any).tool_calls) {
        const fn = tc?.function;
        if (fn?.name && tc.id) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(fn.arguments ?? '{}'); } catch { /* skip */ }
          pending.set(tc.id, { name: fn.name, input: args });
        }
      }
    }

    // Gemini API format: model role message with parts array containing functionCall
    if (msg.role === 'model' && Array.isArray((msg as any).parts)) {
      for (const part of (msg as any).parts) {
        if (part?.functionCall) {
          const fc = part.functionCall;
          if (fc.name) {
            const tcId = fc.id || '';
            pending.set(tcId, { name: fc.name, input: fc.args ?? {} });
          }
        }
      }
    }

    // Anthropic format: user content blocks with type tool_result
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === 'tool_result' && block.tool_use_id) {
          const p = pending.get(block.tool_use_id);
          if (p) {
            const rt = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((b: any) => typeof b === 'string' ? b : b?.text ?? JSON.stringify(b)).join('\n')
                : JSON.stringify(block.content ?? '');
            calls.push({ ...p, resultText: rt, toolId: block.tool_use_id });
            pending.delete(block.tool_use_id);
          }
        }
      }
    }

    // OpenAI format: role=tool messages
    if (msg.role === 'tool' && typeof (msg as any).tool_call_id === 'string') {
      const tcId = (msg as any).tool_call_id as string;
      const p = pending.get(tcId);
      if (p) {
        const rt = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        calls.push({ ...p, resultText: rt, toolId: tcId });
        pending.delete(tcId);
      }
    }

    // Gemini API format: user role message with parts array containing functionResponse
    if (msg.role === 'user' && Array.isArray((msg as any).parts)) {
      for (const part of (msg as any).parts) {
        if (part?.functionResponse) {
          const fr = part.functionResponse;
          const tcId = fr.id || '';
          const p = pending.get(tcId);
          if (p) {
            const respObj = fr.response ?? {};
            const rt = typeof respObj.result === 'string'
              ? respObj.result
              : JSON.stringify(respObj.result ?? respObj);
            calls.push({ ...p, resultText: rt, toolId: tcId });
            pending.delete(tcId);
          }
        }
      }
    }
  }

  return calls;
}

export function extractAssistantText(turnMessages: FoldMessage[]): string {
  const texts: string[] = [];
  for (const msg of turnMessages) {
    if (msg.role !== 'assistant' && msg.role !== 'model') continue;
    if (typeof msg.content === 'string' && msg.content.trim()) {
      texts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          texts.push(block.text);
        }
      }
    } else if (Array.isArray((msg as any).parts)) {
      for (const part of (msg as any).parts as any[]) {
        if (typeof part?.text === 'string' && part.text.trim()) {
          texts.push(part.text);
        }
      }
    }
  }
  return texts.join('\n');
}

/**
 * Extract GENUINE user-authored text from a turn's messages — the operator's
 * own words. Deliberately mirrors extractAssistantText across Anthropic
 * string/content[] and Gemini parts[] shapes, but reads the `user` role and
 * EXCLUDES tool-output blocks (Anthropic `tool_result`, Gemini
 * `functionResponse`): those are tool results already covered by the main
 * nomination lane (toolCalls[].resultText), so re-reading them here would be a
 * pointless double-carry. Used only to feed the capped user-verbatim closet
 * lane (P1b) so operator-pasted ids/paths/ports are conserved when a turn folds.
 */
export function extractUserText(
  turnMessages: FoldMessage[],
  syntheticContext: SyntheticContextOptions = EMPTY_SYNTHETIC_CONTEXT_OPTIONS,
): string {
  const texts: string[] = [];
  for (const msg of turnMessages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string' && msg.content.trim()) {
      const cleaned = stripSyntheticUserContextBlocks(msg.content, syntheticContext).trim();
      if (cleaned) texts.push(cleaned);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        // Only genuine text blocks — tool_result blocks are tool output.
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          const cleaned = stripSyntheticUserContextBlocks(block.text, syntheticContext).trim();
          if (cleaned) texts.push(cleaned);
        }
      }
    } else if (Array.isArray((msg as any).parts)) {
      for (const part of (msg as any).parts as any[]) {
        if (part?.functionResponse) continue; // tool output, not user text
        if (typeof part?.text === 'string' && part.text.trim()) {
          const cleaned = stripSyntheticUserContextBlocks(part.text, syntheticContext).trim();
          if (cleaned) texts.push(cleaned);
        }
      }
    }
  }
  return texts.join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Normalize an absolute `/home/<user>/<repo>/…` path to repo-relative form. The
 * canonical normalization used by claimed-path matching (`isClaimedPath`) and
 * tool-arg path extraction — exported so the fold freeze (foldFreeze.ts) can
 * test claim relevance with byte-identical semantics.
 *
 * Strips the leading `/home/<user>/<repo>/` segment (heuristic: repo one level
 * under home). foldPathCanon.ts handles arbitrary roots via injected context.
 */
export function normalizeToolPath(p: string): string {
  return p.replace(/^\/home\/[^/]+\/[^/]+\//, '');
}

/**
 * Extract the normalized file-path argument from a tool input object. The
 * canonical path-arg semantics shared by skeletons, claimed-path matching,
 * extractToolPathSet, and fold-recall trigger matching (foldRecall.ts).
 */
export function extractPath(input: Record<string, unknown>): string {
  const p = String(input.file_path ?? input.path ?? input.filePath ?? input.file ?? '');
  return normalizeToolPath(p);
}

// ══════════════════════════════════════════════════════════════════════
// Coordinate Closet — nomination + conservation helpers (P1 closet, P3 belt)
// ══════════════════════════════════════════════════════════════════════

/**
 * Anti-squat cap for the user-authored verbatim lane (P1b). The main closet
 * lane (tool results + assistant text — the agent's own working identifiers)
 * nominates FIRST at the full `verbatimKeepChars` budget; the user lane then
 * gets only leftover budget, hard-capped at this fraction of the total. This
 * conserves operator-pasted ids/paths/ports when a turn folds (honoring the
 * fold-block promise) WITHOUT letting a giant user log/dump squat the closet
 * and starve the agent's own working set. 0.25 → ≤1000 chars (~25 ids) at the
 * default 4000-char budget.
 */
const USER_VERBATIM_LANE_RATIO = 0.25;

const VERBATIM_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const VERBATIM_HEX_RE = /\b[0-9a-f]{12,64}\b/gi;
/** 8-11 hex requiring ≥1 letter AND ≥1 digit: admits this codebase's dominant id
 *  shapes (rail-1f6be5b4, short git SHAs like b602c1e8) while rejecting date-like
 *  digit runs (20260610) and hex-only English words (deadbeef). */
const VERBATIM_HEX_SHORT_RE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,11}\b/gi;
const VERBATIM_ABS_PATH_RE = /(?:^|[\s"'`(=])(\/(?:[\w.@-]+\/)+[\w.@-]+)/g;
/** Value must contain a digit, '/', or '@' — keeps ports/ids/urls/emails
 *  (port=3002, ref: abc1234), drops prose KVs ("result: this", "mode=continuous"). */
const VERBATIM_KV_RE = /\b([A-Za-z_][\w.-]{0,40}[=:][ ]?(?=[\w./:@-]*[\d/@])[\w./:@-]{4,80})/g;
const VERBATIM_REF_RE = /(?:^|\s)(#\d{2,8})\b/g;

/**
 * Nominate carry-worthy verbatim values from text (UUIDs, hex ids ≥12, short
 * mixed hex 8-11, absolute paths, key=value pairs with digit-bearing values,
 * issue refs #1234). Collects in PATTERN-PRIORITY order — all UUIDs, then hex,
 * then short hex, paths, KVs, refs — source order within each pattern. Under a
 * budget this priority order is the carry policy: id-shaped values win over
 * KV pairs. Truncates each value to 200 chars, dedupes exactly, stops at cap.
 *
 * @param cap Max ENTRY COUNT, not characters.
 */
export function nominateVerbatim(text: string, cap = 40): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  const addMatch = (raw: string) => {
    const truncated = raw.length > 200 ? raw.slice(0, 200) : raw;
    if (!seen.has(truncated)) {
      seen.add(truncated);
      result.push(truncated);
    }
  };

  const patterns: [RegExp, number][] = [
    [new RegExp(VERBATIM_UUID_RE.source, VERBATIM_UUID_RE.flags), 0],
    [new RegExp(VERBATIM_HEX_RE.source, VERBATIM_HEX_RE.flags), 0],
    [new RegExp(VERBATIM_HEX_SHORT_RE.source, VERBATIM_HEX_SHORT_RE.flags), 0],
    [new RegExp(VERBATIM_ABS_PATH_RE.source, VERBATIM_ABS_PATH_RE.flags), 1],
    [new RegExp(VERBATIM_KV_RE.source, VERBATIM_KV_RE.flags), 1],
    [new RegExp(VERBATIM_REF_RE.source, VERBATIM_REF_RE.flags), 1],
  ];

  for (const [re, group] of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      addMatch(m[group] ?? m[0]);
      if (result.length >= cap) return result;
    }
    if (result.length >= cap) return result;
  }

  return result;
}

/**
 * Normalize a numeric string for conservation matching.
 * Makes `1.0000` ≡ `1.0` ≡ `1` via Number() coercion.
 */
export function normalizeNumericForm(s: string): string {
  if (/^\d+(\.\d+)?$/.test(s)) return String(Number(s));
  return s;
}

/** Boundary-aware presence test: needle must not be embedded in a longer alnum run. */
function boundaryHit(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:[^A-Za-z0-9]|$)`).test(haystack);
}

/**
 * Test whether `value` is verbatim-present in `haystack` with boundary-aware
 * matching, value-part conservation, and numeric normalization (from Bro's port):
 * 1. `6787` is NOT conserved by `67870` — non-alphanumeric boundary required.
 * 2. `id: <uuid>` IS conserved by a haystack carrying the bare uuid — a KV pair
 *    adds nothing once its value survives (belt/closet double-carry guard).
 * 3. `1.0000` ≡ `1.0` ≡ `1` — normalizeNumericForm applied to the value part.
 */
export function isConservedIn(haystack: string, value: string): boolean {
  if (boundaryHit(haystack, value)) return true;
  const valuePart = /[=:][ ]?(.+)$/.exec(value)?.[1]?.trim() ?? value;
  if (valuePart !== value && boundaryHit(haystack, valuePart)) return true;
  const norm = normalizeNumericForm(valuePart);
  if (norm !== valuePart && boundaryHit(haystack, norm)) return true;
  return false;
}

/** Canonical comparison key for Coordinate Closet literals. */
export function canonicalizeClosetLiteral(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
}

function preferredClosetLiteral(left: string, right: string): string {
  if (left.startsWith('/') !== right.startsWith('/')) return left.startsWith('/') ? left : right;
  return left.length >= right.length ? left : right;
}

function pathSuffixContains(container: string, contained: string): boolean {
  if (container === contained) return true;
  return container.endsWith(`/${contained}`);
}

/**
 * Mutating admission helper for closet literal lists. It dedupes slash/no-slash
 * twins and replaces shorter path suffixes with fuller path spellings.
 */
export function admitClosetLiteral(admitted: string[], candidate: string): boolean {
  const literal = candidate.trim();
  if (!literal) return false;
  const key = canonicalizeClosetLiteral(literal);
  for (let i = 0; i < admitted.length; i += 1) {
    const existing = admitted[i];
    const existingKey = canonicalizeClosetLiteral(existing);
    if (existingKey === key) {
      const preferred = preferredClosetLiteral(existing, literal);
      if (preferred !== existing) {
        admitted[i] = preferred;
        return true;
      }
      return false;
    }
    if (pathSuffixContains(key, existingKey)) {
      admitted[i] = literal;
      return true;
    }
    if (pathSuffixContains(existingKey, key)) return false;
  }
  admitted.push(literal);
  return true;
}

/** Max chars for a Coordinate Closet context label (Tier-1 annotated keep). */
export const LABEL_MAX_CHARS = 24;

/**
 * Derive a deterministic, IO-free context label for an OPAQUE verbatim value
 * (bare UUID / hex id) from the text it was nominated from, so a folded id like
 * `7fd5835b` carries its meaning (`changelog_id`) into the Coordinate Closet instead
 * of going dark. This is the Tier-1 "annotated keep" page-out: the fold engine is
 * deterministic zero-LLM (byte-identical output is the provider-cache invariant),
 * so the label is a pure surrounding-context heuristic, never a model call.
 *
 * Returns '' for self-describing values (absolute paths, KV pairs
 * `key=value`/`key: value`, issue refs `#1234`) — they already carry meaning —
 * and when no meaningful preceding identifier exists. Heuristic: locate the
 * value's first boundary-aware occurrence and read the nearest preceding
 * identifier word (the JSON/KV key or prose subject), e.g. `"changelog_id":
 * "7fd5835b"`, `rail 7fd5835b`, `commit b602c1e8`. A label that is itself
 * pure-hex or letterless is rejected so one hash never labels another.
 * Pure: byte-identical for identical inputs.
 */
export function extractVerbatimContextLabel(sourceText: string, value: string): string {
  // Self-describing shapes carry their own meaning — no label needed.
  if (value.includes('/') || value.includes('=') || value.includes(':') || value.startsWith('#')) {
    return '';
  }
  // First boundary-aware occurrence (same boundary rule as isConservedIn's
  // boundaryHit) so a hash embedded inside a longer alnum run is ignored.
  let idx = -1;
  let from = 0;
  while (from <= sourceText.length) {
    const i = sourceText.indexOf(value, from);
    if (i < 0) break;
    const before = i === 0 ? '' : sourceText[i - 1];
    const afterPos = i + value.length;
    const after = afterPos >= sourceText.length ? '' : sourceText[afterPos];
    const beforeOk = before === '' || !/[A-Za-z0-9]/.test(before);
    const afterOk = after === '' || !/[A-Za-z0-9]/.test(after);
    if (beforeOk && afterOk) {
      idx = i;
      break;
    }
    from = i + 1;
  }
  if (idx <= 0) return '';
  // Strip the trailing key→value separators (quotes, colon, equals, whitespace,
  // dot, dash) then read the trailing identifier word — the nearest JSON/KV key
  // or prose subject.
  const trimmed = sourceText.slice(0, idx).replace(/["'\s:=.\-]+$/, '');
  const m = /([A-Za-z_][\w.\-]{1,40})$/.exec(trimmed);
  if (!m) return '';
  const label = m[1];
  // Reject letterless or pure-hex labels so one hash never labels another.
  if (!/[A-Za-z]/.test(label) || /^[0-9a-fA-F]+$/.test(label)) return '';
  return label.slice(0, LABEL_MAX_CHARS);
}

/** Reject opaque values only when no source-derived label or explicit key exists. */
export function isUnlabeledOpaqueClosetLiteral(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (/\s\([^)]+\)$/.test(v)) return false;
  if (/^[A-Za-z_][\w.-]{0,40}[=:]/.test(v)) return false;
  if (/^[0-9a-f]{6,}$/i.test(v)) return true;
  if (/^\d+$/.test(v)) return true;
  return false;
}

const CLOSET_CODE_ROOT_SEGMENTS = new Set([
  'src',
  'test',
  'tests',
  'dist',
  'lib',
  'app',
  'relay',
  'packages',
  'shared',
  'docs',
  'sop',
  'data',
  'logs',
  'scripts',
  'node_modules',
  'components',
  'stores',
  'routes',
  'crossinstancetools',
  '__tests__',
  'home',
  'tmp',
  'var',
  'usr',
  'etc',
  'mnt',
  'opt',
]);

function slashWordSegments(value: string): string[] {
  if (!value.includes('/')) return [];
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0)) return [];
  return segments;
}

function hasCodeRootSegment(segments: readonly string[]): boolean {
  return segments.some((segment) => CLOSET_CODE_ROOT_SEGMENTS.has(segment.toLowerCase()));
}

function isLowSignalSlashChain(value: string): boolean {
  const segments = slashWordSegments(value);
  if (segments.length < 2 || segments.length > 4) return false;
  if (hasCodeRootSegment(segments)) return false;
  if (segments.some((segment) => /[.\d]/.test(segment))) return false;
  return segments.every((segment) => /^[A-Za-z_-]+$/.test(segment));
}

function hasSingleCharNoiseSegment(value: string): boolean {
  const segments = slashWordSegments(value);
  if (segments.length < 2) return false;
  if (hasCodeRootSegment(segments)) return false;
  if (segments.some((segment) => /[.\d]/.test(segment))) return false;
  return segments.some((segment) => segment.length === 1);
}

/**
 * Reject Coordinate Closet candidates that are trace-EXHAUST artifacts rather
 * than durable coordinate ids/paths. Pure + deterministic (regex only), so it
 * preserves the fold engine's byte-identical-for-identical-input provider-cache
 * invariant. Shared by BOTH closet builders — this fold closet's admit() and the
 * relay rebirth-seed buildRawTraceCoordinateCloset — so one filter cleans both.
 *
 * Discriminates by artifact TYPE, not lineage: a tool-result spool / browser
 * artifact / temp path is noise no matter which instance produced it — and that
 * is precisely what removes the BULK of cross-lineage closet leakage, since the
 * foreign refs that leak in are overwhelmingly tool-artifact paths. Real
 * source-file paths, rail/instance ids, ports, and pids are intentionally KEPT
 * even when cross-lineage (a fork sibling's file claim is coordination signal).
 */
export function isClosetNoiseLiteral(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  // ── Tool / trace artifact paths (any engine, any lineage) — pure exhaust ──
  if (v.includes('tool-result-spool/')) return true;
  // Browser artifact captures (screenshots / DOM dumps).
  if (v.includes('browser-artifacts/')) return true;
  if (/(?:^|\/)scr_\d{6,}_[0-9a-f]{6,}/.test(v)) return true;
  // Scratch / temp paths.
  if (/(?:^|\/)tmp\//.test(v)) return true;
  // Wildcard route-manifest entries (hypermath/*, /api/*) — build-dump exhaust,
  // never a concrete coordinate. Concrete routes (/api/instances/<id>) survive.
  if (v.includes('/*')) return true;
  // ── Pure content hashes (sha1/sha256: 40+ hex run, no dashes) ──
  // Short hex refs / rail / instance ids (≤16) and dashed UUIDs are KEPT.
  if (/^[0-9a-f]{40,}$/i.test(v)) return true;
  // ── Numeric / counter / date exhaust ──
  // N/M progress counters (17/17, 8/17, 0/17), calendar dates (6/20/2026), and
  // leading-number code ratios (1/zoom, 2/scale).
  if (/^\d{1,4}\/\d{1,4}$/.test(v)) return true;
  if (/^[A-Za-z_][\w.-]{0,40}[=:][ ]?\d{1,4}\/\d{1,4}$/.test(v)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v)) return true;
  if (/^\d{1,4}\/[A-Za-z]{2,}$/.test(v)) return true;
  // Capitalized prose label fragments ("So: fable-5-specific") are summary
  // shards; lowercase operational keys like "model: codex-5.5" stay accepted.
  if (/^[A-Z][A-Za-z0-9_.-]{0,40}:[ ]?/.test(v)) return true;
  // ── Tailwind / CSS class fragments ──
  // Hyphenated utility token with a numeric opacity/size modifier
  // (ring-blue-400/30, bg-theme-surface/35, shadow-black/40, bg-brand/20).
  // Requires an interior hyphen AND a pure-digit right side, so real 2-segment
  // paths (relay/src, app-solid/foo) never match.
  if (/^[A-Za-z][\w-]*-[\w-]+\/\d{1,3}$/.test(v)) return true;
  // ── Decontextualized grep/read line fragments ──
  // Bare basename:line(:col) (PanesView.tsx:2832, foo.ts:84:12). Path-qualified
  // file:line (relay/src/foo.ts:84) carries a slash and survives; line RANGES
  // (foo.ts:20-45) survive (dash tail).
  if (/^[\w.-]+\.[A-Za-z]{1,5}:\d+(?::\d*)?$/.test(v)) return true;
  // Orphaned stack-frame extension fragment: a stack path like
  // `…/chunk-artifact.js:2323:10` nominates the path up to the dot, leaving the
  // bare `js:2323:10` tail as its own literal. Match a short alpha extension +
  // `:line:col` with BOTH numeric segments present (two colons), so single-colon
  // key:value coordinates (port:3002, host:8080) are never touched.
  if (/^[A-Za-z]{1,5}:\d+:\d+$/.test(v)) return true;
  // Read-output line headers ("Lines: 2417-2486", "Line: 84") — the file/symbol
  // they referenced sits in a sibling token, so the bare range is decontextualized.
  if (/^Lines?: ?\d+(?:-\d+)?$/.test(v)) return true;
  // ── Dictionary slash-bigrams with an interior capital (CPU/GPU, iOS/Android,
  // Figma/Miro, DOM/GPU, Read/Grep). The capital guard preserves all-lowercase
  // real 2-segment paths like relay/src or packages/shared. ──
  if (/^[A-Za-z]{2,}\/[A-Za-z]{2,}$/.test(v) && /[A-Z]/.test(v)) return true;
  if (isLowSignalSlashChain(v)) return true;
  if (hasSingleCharNoiseSegment(v)) return true;
  return false;
}

/**
 * Extract up to `max` carry-worthy verbatim values from a result text (receipts belt).
 * Value-deduped via isConservedIn so `deadbeefcafe` and `id: deadbeefcafe` never
 * spend two slots on one value (nominates a wider pool, then greedy-selects).
 */
function beltVerbatim(text: string, max = 2): string {
  const picked: string[] = [];
  for (const lit of nominateVerbatim(text, max * 4)) {
    if (picked.length >= max) break;
    // Same artifact-type reject as the Coordinate Closet so a tool-call
    // skeleton's receipts belt never carries trace exhaust: stack-frame
    // fragments (js:2323:10), read-output line headers (Lines: 2417-2486),
    // spool/tmp paths, content hashes, N/M counters. Real ids/paths/ports/pids
    // still survive — this is the same predicate the closet uses.
    if (isClosetNoiseLiteral(lit)) continue;
    if (picked.length > 0 && isConservedIn(picked.join(', '), lit)) continue;
    picked.push(lit);
  }
  return picked.join(', ');
}

// ══════════════════════════════════════════════════════════════════════
// Turn classifier
// ══════════════════════════════════════════════════════════════════════

const RESEARCH_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'ToolSearch',
  'mcp__voxxo-swarm-bridge__atlas_query', 'mcp__brain-mcp__atlas_query',
  'mcp__voxxo-swarm-bridge__atlas_graph', 'mcp__brain-mcp__atlas_graph',
  'mcp__voxxo-swarm-bridge__atlas_audit', 'mcp__brain-mcp__atlas_audit',
  'mcp__voxxo-swarm-bridge__search_docs', 'mcp__voxxo-swarm-bridge__devlog_query',
]);

const ACTION_TOOLS = new Set([
  'Edit', 'Write', 'NotebookEdit',
  'mcp__voxxo-swarm-bridge__atlas_commit', 'mcp__brain-mcp__atlas_commit',
  'mcp__voxxo-swarm-bridge__apply_migration', 'mcp__voxxo-swarm-bridge__execute_sql',
  'mcp__voxxo-swarm-bridge__deploy_edge_function',
]);

const COORDINATION_TOOLS = new Set([
  'mcp__voxxo-swarm-bridge__chatroom', 'mcp__voxxo-swarm-bridge__tap_instance_messages',
  'mcp__voxxo-swarm-bridge__tap_star', 'mcp__voxxo-swarm-bridge__spawn_instance',
  'mcp__voxxo-swarm-bridge__kill_instance',
  'mcp__voxxo-swarm-bridge__psychic_pov', 'mcp__voxxo-swarm-bridge__task_rail',
  'mcp__voxxo-swarm-bridge__signal_overseer', 'mcp__voxxo-swarm-bridge__self_rebirth',
  'mcp__brain-mcp__brain_rebirth', 'mcp__brain-mcp__brain_handoff', 'Agent',
]);

const MUTATING_BASH_RE = /\b(npm run build|npm install|git commit|git push|rm |mkdir |mv |cp |chmod|make |cargo build|pip install|docker )\b/;

function isMutatingBash(input: Record<string, unknown>): boolean {
  return MUTATING_BASH_RE.test(String(input.command ?? ''));
}

export function classifyTurn(turnMessages: FoldMessage[]): TurnCategory {
  const toolCalls = extractToolCalls(turnMessages);
  const toolNames = toolCalls.map(tc => tc.name);
  const assistantText = extractAssistantText(turnMessages);

  const hasErrorBlock = turnMessages.some(msg => {
    if (Array.isArray(msg.content)) {
      return (msg.content as any[]).some(b => b?.is_error === true);
    }
    return false;
  });
  if (hasErrorBlock) return 'error';

  // Only count tool-result text errors from Bash (actual command failures).
  // Research tools (Read, Grep, Atlas) return source code that naturally
  // contains "Error:", "TypeError", etc. — those aren't real failures.
  const hasCommandError = toolCalls.some(tc =>
    tc.name === 'Bash' && (tc.resultText.includes('Error:') || tc.resultText.includes('FAILED')),
  );
  if (hasCommandError && toolCalls.every(tc => tc.name === 'Bash')) return 'error';

  const actionCount = toolNames.filter(n => ACTION_TOOLS.has(n)).length;
  const bashMutations = toolCalls.filter(tc => tc.name === 'Bash' && isMutatingBash(tc.input)).length;
  if (actionCount > 0 || bashMutations > 0) return 'action';

  const researchCount = toolNames.filter(n => RESEARCH_TOOLS.has(n)).length;
  const bashReads = toolCalls.filter(tc => tc.name === 'Bash' && !isMutatingBash(tc.input)).length;
  const coordCount = toolNames.filter(n => COORDINATION_TOOLS.has(n)).length;

  if (coordCount > 0 && researchCount === 0 && bashReads === 0) return 'coordination';
  if (researchCount > 0 || bashReads > 0) return 'research';
  if (assistantText.length < 100 && toolNames.length === 0) return 'navigation';

  return 'decision';
}

// ══════════════════════════════════════════════════════════════════════
// Tool-call skeletonizer
// ══════════════════════════════════════════════════════════════════════

export function skeletonizeTool(call: ExtractedToolCall): string {
  const { name, input, resultText } = call;
  const shortName = name.replace(/^mcp__[^_]+__/, '');

  switch (name) {
    case 'Read': {
      const path = extractPath(input);
      const offset = input.offset ? ` @${input.offset}` : '';
      const limit = input.limit ? `+${input.limit}` : '';
      return `📖 ${path}${offset}${limit}`;
    }
    case 'Grep': {
      const pattern = truncate(String(input.pattern ?? ''), 30);
      const lines = resultText.trim().split('\n');
      const ct = resultText.trim() ? lines.length : 0;
      return `🔍 "${pattern}" → ${ct} hit(s)`;
    }
    case 'Glob': {
      const pattern = truncate(String(input.pattern ?? ''), 30);
      const ct = resultText.trim() ? resultText.trim().split('\n').length : 0;
      return `📂 ${pattern} → ${ct} file(s)`;
    }
    case 'Bash': {
      const cmd = truncate(String(input.command ?? ''), 60);
      const hasErr = resultText.includes('Error') || resultText.includes('error:');
      const belt = beltVerbatim(resultText);
      return belt ? `$ ${cmd} → ${hasErr ? 'err' : 'ok'} [${belt}]` : `$ ${cmd} → ${hasErr ? 'err' : 'ok'}`;
    }
    case 'Edit': {
      const path = extractPath(input);
      const oldFirst = truncate(String(input.old_string ?? '').split('\n')[0], 30);
      const newFirst = truncate(String(input.new_string ?? '').split('\n')[0], 30);
      return `✏️ ${path} — "${oldFirst}" → "${newFirst}"`;
    }
    case 'Write': {
      const path = extractPath(input);
      const len = String(input.content ?? '').length;
      return `📝 ${path} (${len} chars)`;
    }
    case 'Agent': {
      const desc = truncate(String(input.description ?? input.prompt ?? ''), 50);
      return `🤖 Agent: ${desc}`;
    }
    case 'ToolSearch': {
      const query = truncate(String(input.query ?? ''), 40);
      return `🔎 ToolSearch: ${query}`;
    }
    default: {
      if (shortName === 'atlas_query') {
        const action = String(input.action ?? '');
        const path = extractPath(input);
        const query = input.query ? truncate(String(input.query), 30) : '';
        if (action === 'lookup') return `🗺️ atlas lookup ${path}`;
        if (action === 'search') return `🗺️ atlas search "${query}"`;
        if (action === 'plan_context') return `🗺️ atlas plan "${query}"`;
        return `🗺️ atlas ${action} ${path || query}`.trim();
      }
      if (shortName === 'atlas_commit') return `📌 atlas_commit ${extractPath(input)}`;
      if (shortName === 'atlas_graph') return `🗺️ atlas_graph ${String(input.kind ?? '')} ${extractPath(input)}`.trim();
      if (shortName === 'chatroom') {
        const action = String(input.action ?? input.operation ?? 'send');
        const room = String(input.room ?? input.room_name ?? '');
        return `💬 chatroom ${action} ${room}`.trim();
      }
      if (shortName === 'tap_instance_messages') return `👂 tap ${String(input.target_instance ?? '')}`;
      if (shortName === 'task_rail') return `📋 task_rail ${String(input.mode ?? '')} ${String(input.operation ?? '')}`.trim();
      if (shortName === 'self_rebirth' || shortName === 'brain_rebirth') return `🔄 rebirth`;
      if (shortName === 'spawn_instance') {
        return `🌱 ${shortName} ${truncate(String(input.name ?? input.model ?? ''), 20)}`;
      }
      const preview = truncate(resultText.split('\n')[0], 60);
      const belt = beltVerbatim(resultText);
      return belt ? `🔧 ${shortName} → ${preview} [${belt}]` : `🔧 ${shortName} → ${preview}`;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// Assistant text extractor
// ══════════════════════════════════════════════════════════════════════

const FILLER_RE = [
  /^(Let me|I'll|I will|I need to|I should|I want to|Going to|I'm going to)\b/i,
  /^(Okay|OK|Sure|Got it|Understood|Alright|Great|Perfect|Right|Interesting|Good question)\b[.,!]?\s*$/i,
  /^(Looking at|Checking|Examining|Investigating|Searching|Now let|Let's see)\b/i,
  /^(As (you can see|mentioned|expected|we discussed))\b/i,
  /^(I (think|believe|suspect|notice|see) (that )?)/i,
];

const KEEP_RE = [
  /\bdecision\b/i,
  /\bbecause\b/i,
  /\bthe (fix|issue|problem|bug|solution|answer|reason|cause) (is|was)\b/i,
  /\bconclu(sion|de)\b/i,
  /\bfound (that|the)\b/i,
  /\bturns out\b/i,
  /→/,
  /\bmu(st|stn't)\b/i,
  /\bbreaking change\b/i,
  /\bhazard\b/i,
  // Reasoning markers — the "why" behind decisions. Without these, trade-off
  // analysis and alternative-consideration prose gets dropped by the 250-char
  // cutoff even when it's the most important reasoning in the turn.
  /\b(?:chose|selected|prefer(?:red)?|went with|opt(?:ed)?|decided)\b/i,
  /\btrade[- ]?off\b/i,
  /\balternative\b/i,
  /\binstead of\b/i,
  /\brather than\b/i,
  /\breject(?:ed|ing)?\b/i,
  /\bdue to\b/i,
  /^[-*•]\s/,
  /^\d+\.\s/,
  /^#+\s/,
  /^\|/,
];

export function extractAssistantEssence(text: string): string {
  if (!text || text.length < 50) return text;

  const lines = text.split('\n');
  const kept: string[] = [];
  let inCodeBlock = false;
  let keptFirstLine = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      kept.push(line);
      continue;
    }
    if (inCodeBlock) { kept.push(line); continue; }

    if (trimmed === '') {
      if (kept.length > 0 && kept[kept.length - 1].trim() !== '') kept.push('');
      continue;
    }

    if (!keptFirstLine) {
      kept.push(line);
      keptFirstLine = true;
      continue;
    }

    if (KEEP_RE.some(p => p.test(trimmed))) { kept.push(line); continue; }

    // Drop filler lines
    if (FILLER_RE.some(p => p.test(trimmed))) continue;

    // Drop verbose mid-paragraph prose without keep markers.
    // Lines without KEEP_RE hits are capped at 250 chars. Lines with
    // reasoning markers (chose, trade-off, instead of, etc.) are already
    // captured unconditionally by the KEEP_RE check above, so the widened
    // patterns are the real fix — this cutoff only governs generic prose.
    if (trimmed.length > 250) continue;

    // Line passed all filters — keep it.
    kept.push(line);
  }

  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();

  const result = kept.join('\n');
  if (result.length < text.length * 0.1 && text.length > 200) {
    return text.slice(0, Math.min(200, Math.floor(text.length * 0.2))) + '…';
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════════
// Sequence collapser
// ══════════════════════════════════════════════════════════════════════

const CATEGORY_META: Record<TurnCategory, { icon: string; verb: string }> = {
  research: { icon: '🔬', verb: 'Investigated' },
  navigation: { icon: '🧭', verb: 'Navigated' },
  coordination: { icon: '📡', verb: 'Coordination' },
  error: { icon: '⚠️', verb: 'Errors' },
  action: { icon: '✏️', verb: 'Edits' },
  decision: { icon: '💡', verb: 'Decisions' },
};

export function collapseSequences(foldedTurns: FoldedTurn[]): FoldedTurn[] {
  if (foldedTurns.length <= 1) return foldedTurns;

  const result: FoldedTurn[] = [];
  let i = 0;

  while (i < foldedTurns.length) {
    const current = foldedTurns[i];

    // Action and decision turns are never collapsed
    if (current.category === 'action' || current.category === 'decision') {
      result.push(current);
      i++;
      continue;
    }

    let seqEnd = i + 1;
    while (
      seqEnd < foldedTurns.length &&
      foldedTurns[seqEnd].category === current.category &&
      foldedTurns[seqEnd].category !== 'action' &&
      foldedTurns[seqEnd].category !== 'decision'
    ) {
      seqEnd++;
    }

    const seqLen = seqEnd - i;
    if (seqLen >= 2) {
      const seq = foldedTurns.slice(i, seqEnd);
      const totalSaved = seq.reduce((s, t) => s + t.charsSaved, 0);
      const allRetained = seq
        .filter(t => t.retained)
        .map(t => t.retained!)
        .join('\n---\n');
      const meta = CATEGORY_META[current.category];
      const skeletonList = seq.map(t => t.skeleton).join(' → ');

      result.push({
        timestamp: current.timestamp,
        category: current.category,
        skeleton: `${meta.icon} ${meta.verb} (${seqLen} turns): ${skeletonList}`,
        retained: allRetained || undefined,
        charsSaved: totalSaved,
      });
      i = seqEnd;
    } else {
      result.push(current);
      i++;
    }
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════════
// Trigger mechanism
// ══════════════════════════════════════════════════════════════════════

export function checkFoldTrigger(
  messages: FoldMessage[],
  config: FoldConfig = DEFAULT_FOLD_CONFIG,
  syntheticContext: SyntheticContextOptions = EMPTY_SYNTHETIC_CONTEXT_OPTIONS,
): FoldTrigger {
  const totalChars = countChars(messages);
  const turns = detectTurns(messages, syntheticContext);
  const turnCount = turns.length;

  if (turnCount === 0) {
    return { shouldFold: false, turnsToFold: 0, reason: 'no turns' };
  }

  if (!config.continuous && turnCount <= config.activeWindowTurns) {
    return { shouldFold: false, turnsToFold: 0, reason: `${turnCount} turns ≤ activeWindow(${config.activeWindowTurns})` };
  }

  const foldable = config.continuous ? turnCount : turnCount - config.activeWindowTurns;

  // Continuous always-on: fold every detected turn on every call, bypassing the
  // soft/hard char + maxTurns gates. foldContext's budget pre-pass keeps the
  // freshest folded turns at full/essence fidelity — so this stays "lean but
  // adequate" rather than cliff-edged. Default config leaves continuous
  // undefined, so the threshold-gated behavior below is unchanged for every
  // other caller.
  if (config.continuous) {
    return {
      shouldFold: true,
      turnsToFold: foldable,
      reason: `continuous: fold all ${foldable} detected turn(s)`,
    };
  }

  if (totalChars >= config.hardThresholdChars) {
    const toFold = Math.max(Math.ceil(foldable * 0.6), 1);
    return { shouldFold: true, turnsToFold: toFold, reason: `hard threshold: ${totalChars} chars ≥ ${config.hardThresholdChars}` };
  }

  if (totalChars >= config.softThresholdChars) {
    const toFold = Math.max(Math.ceil(foldable * 0.3), 1);
    return { shouldFold: true, turnsToFold: toFold, reason: `soft threshold: ${totalChars} chars ≥ ${config.softThresholdChars}` };
  }

  if (turnCount > config.maxTurnsBeforeFold) {
    const excess = turnCount - config.maxTurnsBeforeFold;
    const toFold = Math.max(Math.min(excess + config.activeWindowTurns, foldable), 1);
    return { shouldFold: true, turnsToFold: toFold, reason: `turn count: ${turnCount} > max(${config.maxTurnsBeforeFold})` };
  }

  return { shouldFold: false, turnsToFold: 0, reason: `below thresholds: ${totalChars} chars, ${turnCount} turns` };
}

// ══════════════════════════════════════════════════════════════════════
// Episodic eviction (E10) — bounded standing fold skeletons
//
// The continuous fold accretes one skeleton per folded turn for the life of a
// session, so the standing fold block grows monotonically. Eviction bounds it:
// at full-recompute freeze EPOCH commits only (the prefix is recomputing anyway
// — cache-safe by construction), the OLDEST folded spans collapse to tombstone
// lines. Relay/FoldSession callers pass a target frontier so every full
// recompute attempts eviction; direct foldContext callers without a target keep
// the legacy char-threshold sawtooth. Eligibility is the session's call
// (fcBaseSession.buildFoldEvictionInput): a turn is evictable only when its
// content is durably covered by the episodic store (the capture cursor advances
// past episode-bearing ranges only after the store CONFIRMS the write) AND it
// has been folded for ≥2 epochs. Evicted content is not gone: episodic recall
// serves it as cards on member-path touch, and fold-recall still pages the raw
// turns back transiently — the block header count includes evicted turns on
// purpose so buildFoldIndex keeps indexing them.
// ══════════════════════════════════════════════════════════════════════

/** Legacy direct-call mode: evict down to threshold × this ratio. */
const EVICTION_TARGET_RATIO = 0.7;

/** Max tombstone lines kept in the block; the oldest spans merge beyond this. */
const MAX_TOMBSTONE_SPANS = 6;

function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

/** Render one tombstone line: `[Paged to episodic store — <date-range>, N turns; recallable by touching member paths]`. */
export function formatFoldTombstoneLine(span: FoldEvictionSpan): string {
  const first = isoDay(span.firstEvictedIso);
  const last = isoDay(span.lastEvictedIso);
  const range = first === last ? first : `${first}→${last}`;
  return `${FOLD_TOMBSTONE_PREFIX}${range}, ${span.turnCount} turns; recallable by touching member paths]`;
}

/** Sort spans by ordinal and merge the oldest pairs until at most maxSpans remain (date ranges union, counts sum). */
export function mergeEvictionSpans(
  spans: readonly FoldEvictionSpan[],
  maxSpans = MAX_TOMBSTONE_SPANS,
): FoldEvictionSpan[] {
  const out = spans.map(s => ({ ...s }));
  out.sort((a, b) => a.fromOrdinal - b.fromOrdinal);
  while (out.length > maxSpans) {
    const a = out[0];
    const b = out[1];
    out.splice(0, 2, {
      fromOrdinal: Math.min(a.fromOrdinal, b.fromOrdinal),
      toOrdinalExclusive: Math.max(a.toOrdinalExclusive, b.toOrdinalExclusive),
      turnCount: a.turnCount + b.turnCount,
      firstEvictedIso: a.firstEvictedIso <= b.firstEvictedIso ? a.firstEvictedIso : b.firstEvictedIso,
      lastEvictedIso: a.lastEvictedIso >= b.lastEvictedIso ? a.lastEvictedIso : b.lastEvictedIso,
    });
  }
  return out;
}

/**
 * Session-side eligibility ceiling for NEW eviction (pure; exported for the
 * fcBaseSession glue and tests). A turn ordinal is evictable only when BOTH:
 *   - durable coverage: the turn ends at or below `durableCursorIndex` (the
 *     episodic capture cursor — advances past episode-bearing ranges only
 *     after the store CONFIRMS the write, and past episode-free ranges
 *     vacuously; turn endIndex is EXCLUSIVE, so coverage is endIndex ≤ cursor);
 *   - epoch age ≥2: the turn was already inside the fold frontier recorded at
 *     some epoch ≤ upcomingEpoch − 2.
 */
export function computeEvictableThroughOrdinal(
  turns: ReadonlyArray<{ startIndex: number; endIndex: number }>,
  durableCursorIndex: number,
  epochFoldFrontiers: ReadonlyArray<{ epoch: number; turnsFolded: number }>,
  upcomingEpoch: number,
): number {
  let cursorOrdinal = 0;
  for (const turn of turns) {
    if (turn.endIndex <= durableCursorIndex) cursorOrdinal++;
    else break;
  }
  let ageFrontier = 0;
  for (const frontier of epochFoldFrontiers) {
    if (frontier.epoch <= upcomingEpoch - 2 && frontier.turnsFolded > ageFrontier) {
      ageFrontier = frontier.turnsFolded;
    }
  }
  return Math.min(cursorOrdinal, ageFrontier);
}

// ══════════════════════════════════════════════════════════════════════
// Fold orchestrator
// ══════════════════════════════════════════════════════════════════════

function renderFoldedBlock(
  collapsed: FoldedTurn[],
  stats: { turnsFolded: number; origChars: number; blockChars: number },
  closetLine?: string,
  tombstoneLines?: readonly string[],
  counterStamp?: string,
): string {
  const lines: string[] = [
    `[Conversation Context — ${stats.turnsFolded} turns folded, ${Math.round(stats.origChars / 1000)}K → ${Math.round(stats.blockChars / 1000)}K chars${counterStamp ? ` · ${counterStamp}` : ''}]`,
    '',
    FOLD_BLOCK_PREAMBLE,
    '',
  ];

  // Tombstones lead the body (evicted spans are strictly the oldest prefix).
  if (tombstoneLines && tombstoneLines.length > 0) {
    lines.push(...tombstoneLines, '');
  }

  for (const ft of collapsed) {
    lines.push(ft.skeleton);
    if (ft.retained) {
      for (const rl of ft.retained.split('\n')) {
        lines.push(`   ${rl}`);
      }
    }
  }

  if (closetLine) lines.push('', closetLine);
  lines.push('', '[End Folded Context]');
  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════════════
// Cherry-picked graduated fidelity — intrinsic per-turn value (full-recompute)
// ══════════════════════════════════════════════════════════════════════

const DURABLE_GLYPH_PREFIXES = ['🏁', '⚠️', '⚠'] as const;
/**
 * 🏁 verdict / ⚠️ hazard are the durable narration registers (canonical
 * classifier: glyphs.ts classifyAssistantRegister). Inlined here as a leading-
 * glyph test to preserve this module's zero-import purity; this is a heuristic
 * fidelity-value signal, not the episodic narration trust parse.
 */
function turnOpensWithDurableGlyph(assistantText: string): boolean {
  return DURABLE_GLYPH_PREFIXES.some(g => assistantText.startsWith(g));
}

export function resolveFidelityValueWeights(
  overrides?: Partial<FidelityValueWeights>,
): FidelityValueWeights {
  return overrides ? { ...DEFAULT_FIDELITY_VALUE_WEIGHTS, ...overrides } : DEFAULT_FIDELITY_VALUE_WEIGHTS;
}

type FidelityRefKind = 'read' | 'claim' | 'edit';

/** Strip a trailing line-range suffix (":20-45" / ":20") so a claim/edit of a
 *  range matches a read of the whole file. */
function fidelityPathKey(rawPath: string): string {
  return rawPath.replace(/:\d+(?:-\d+)?$/, '');
}

function fidelityRefKind(toolName: string): FidelityRefKind {
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') return 'edit';
  if (toolName.includes('claim_file')) return 'claim';
  return 'read';
}

/**
 * Pure intrinsic per-folded-turn fidelity value (cherry-picked graduated
 * fidelity). Value = downstream relevance measured from the TRACE ITSELF (no
 * episodic store, no I/O, deterministic): for each folded turn, sum the
 * weighted downstream references — later folded turns + the live active window —
 * to the paths it touched (claim/edit weighted over read; active-window refs
 * multiplied), plus an additive bonus for a durable register glyph (🏁/⚠️).
 *
 * `turns` is the full detected turn list; the first `foldCount` are the folded
 * turns being scored. Returns one score per folded turn (aligned to
 * turns[0..foldCount)); active-window turns are turns[foldCount..].
 */
export function scoreTurnFidelityValue(
  turns: readonly Turn[],
  foldCount: number,
  weights: FidelityValueWeights = DEFAULT_FIDELITY_VALUE_WEIGHTS,
): number[] {
  const n = turns.length;
  const fold = Math.max(0, Math.min(Math.floor(foldCount), n));
  const turnPaths: { key: string; kind: FidelityRefKind }[][] = new Array(n);
  for (let g = 0; g < n; g++) {
    const refs: { key: string; kind: FidelityRefKind }[] = [];
    for (const tc of extractToolCalls(turns[g].messages)) {
      const path = extractPath(tc.input);
      if (!path) continue;
      refs.push({ key: fidelityPathKey(path), kind: fidelityRefKind(tc.name) });
    }
    turnPaths[g] = refs;
  }
  // Forward index: path key → ascending list of {turn index, ref kind}.
  const refsByKey = new Map<string, { g: number; kind: FidelityRefKind }[]>();
  for (let g = 0; g < n; g++) {
    for (const r of turnPaths[g]) {
      const arr = refsByKey.get(r.key);
      if (arr) arr.push({ g, kind: r.kind });
      else refsByKey.set(r.key, [{ g, kind: r.kind }]);
    }
  }
  const kindWeight = (kind: FidelityRefKind): number =>
    kind === 'edit' ? weights.edit : kind === 'claim' ? weights.claim : weights.read;
  const scores: number[] = new Array(fold).fill(0);
  for (let i = 0; i < fold; i++) {
    let score = 0;
    const seen = new Set<string>();
    for (const { key } of turnPaths[i]) {
      if (seen.has(key)) continue; // dedupe a turn's own repeated path
      seen.add(key);
      const refs = refsByKey.get(key);
      if (!refs) continue;
      for (const ref of refs) {
        if (ref.g <= i) continue; // downstream references only
        score += kindWeight(ref.kind) * (ref.g >= fold ? weights.activeWindowMultiplier : 1);
      }
    }
    if (turnOpensWithDurableGlyph(extractAssistantText(turns[i].messages))) {
      score += weights.glyphDurableBonus;
    }
    scores[i] = score;
  }
  return scores;
}

/**
 * Apply rolling fold compaction to a message array.
 * Returns a NEW array — never mutates input.
 */
export function foldContext(
  messages: FoldMessage[],
  turnsToFold: number,
  config: FoldConfig = DEFAULT_FOLD_CONFIG,
  eviction?: FoldEvictionInput,
  counterStamp?: string,
  precomputedTurns?: Turn[],
  syntheticContext: SyntheticContextOptions = EMPTY_SYNTHETIC_CONTEXT_OPTIONS,
  fidelityValue?: FoldFidelityValueInput,
): FoldResult {
  const originalChars = countChars(messages);

  if (turnsToFold <= 0 || messages.length === 0) {
    return {
      messages,
      originalChars,
      foldedChars: originalChars,
      savingsPercent: 0,
      turnsFolded: 0,
      turnsRetained: detectTurns(messages, syntheticContext).length,
      foldSummaries: [],
    };
  }

  // precomputedTurns lets callers inject a custom segmentation (e.g. step-granular
  // segments of one oversized marathon turn) while reusing the entire fold engine
  // below. When omitted, behaviour is byte-identical to detectTurns(messages).
  const turns = precomputedTurns ?? detectTurns(messages, syntheticContext);
  const actualFoldCount = Math.min(turnsToFold, turns.length);

  if (actualFoldCount <= 0) {
    return {
      messages,
      originalChars,
      foldedChars: originalChars,
      savingsPercent: 0,
      turnsFolded: 0,
      turnsRetained: turns.length,
      foldSummaries: [],
    };
  }

  // ── E10 eviction frame: previously evicted ordinals tombstone instead of
  // rendering detail. Spans tile a contiguous prefix [0, N) of the fold
  // ordinals (eviction is strictly oldest-first); clamp defensively to the
  // current fold zone — rewound histories reset eviction state session-side.
  const initialEvictedThrough = eviction
    ? Math.min(
        eviction.evictedSpans.reduce((max, s) => Math.max(max, s.toOrdinalExclusive), 0),
        actualFoldCount,
      )
    : 0;

  const foldBoundary = actualFoldCount < turns.length ? turns[actualFoldCount].startIndex : messages.length;

  // Messages before the first turn (system prompts, preamble) — preserved verbatim
  const prefixEnd = turns.length > 0 ? turns[0].startIndex : 0;
  const prefixMessages = messages.slice(0, prefixEnd);

  // Active window — everything from foldBoundary onward, untouched
  const activeWindow = messages.slice(foldBoundary);

  // System/developer messages in the fold zone — preserved verbatim
  const foldZone = messages.slice(prefixEnd, foldBoundary);
  const systemInFoldZone = foldZone.filter(m => m.role === 'system' || m.role === 'developer');

  // Fold each turn with budget-based assistant text retention.
  // Budget allocates retention levels newest-first — turns closest to the
  // active window get full fidelity, older turns get graduated compression.
  const turnsToCompress = turns.slice(0, actualFoldCount);
  const budget = config.assistantTextBudget ?? DEFAULT_ASSISTANT_TEXT_BUDGET;

  // Pre-pass: extract assistant text and allocate retention levels newest → oldest
  type RetentionLevel = 'full' | 'essence' | 'skeleton';
  const turnAssistantTexts = turnsToCompress.map(t => extractAssistantText(t.messages));
  const retentionLevels: RetentionLevel[] = new Array(turnsToCompress.length).fill('skeleton');
  let fullBudgetLeft = budget.fullRetentionChars;
  let essenceBudgetLeft = budget.essenceRetentionChars;

  if (!fidelityValue) {
    // Default: pure recency ramp — newest folded turns win full, then essence,
    // oldest collapse to skeleton. Byte-identical to the pre-value behavior.
    for (let j = turnsToCompress.length - 1; j >= 0; j--) {
      if (j < initialEvictedThrough) continue; // evicted ordinals never consume budget
      const len = turnAssistantTexts[j].length;
      if (len === 0) continue;
      if (fullBudgetLeft >= len) {
        retentionLevels[j] = 'full';
        fullBudgetLeft -= len;
      } else if (essenceBudgetLeft >= len) {
        retentionLevels[j] = 'essence';
        essenceBudgetLeft -= len;
      }
    }
  } else {
    // Cherry-picked graduated fidelity (full-recompute only): the newest K folded
    // turns keep budget priority (working-set recency floor), then the SAME
    // full/essence budget is spent on the remainder ranked by intrinsic trace
    // value (forward path re-reference + durable glyph) instead of pure age — so a
    // still-relevant OLD turn can hold fidelity over a never-revisited newer one.
    const valueWeights = resolveFidelityValueWeights(fidelityValue.weights);
    const recencyFloor = Math.max(
      0,
      Math.floor(fidelityValue.recencyFloorTurns ?? DEFAULT_FIDELITY_VALUE_RECENCY_FLOOR_TURNS),
    );
    const values = scoreTurnFidelityValue(turns, turnsToCompress.length, valueWeights);
    const floorStart = Math.max(initialEvictedThrough, turnsToCompress.length - recencyFloor);
    const order: number[] = [];
    for (let j = turnsToCompress.length - 1; j >= floorStart; j--) order.push(j); // recency floor, newest-first
    const rest: number[] = [];
    for (let j = initialEvictedThrough; j < floorStart; j++) rest.push(j);
    rest.sort((a, b) => (values[b] !== values[a] ? values[b] - values[a] : b - a)); // value desc, newer-first tie
    for (const j of rest) order.push(j);
    for (const j of order) {
      if (j < initialEvictedThrough) continue; // evicted ordinals never consume budget
      const len = turnAssistantTexts[j].length;
      if (len === 0) continue;
      if (fullBudgetLeft >= len) {
        retentionLevels[j] = 'full';
        fullBudgetLeft -= len;
      } else if (essenceBudgetLeft >= len) {
        retentionLevels[j] = 'essence';
        essenceBudgetLeft -= len;
      }
    }
  }

  // Per-ordinal fold artifacts for ordinals ≥ initialEvictedThrough. Evicted
  // ordinals are fully out — no skeleton, no retained text, no closet
  // nomination: their memory lives in the episodic store (the tombstone is the
  // only standing residue) and fold-recall can still page them back from raw
  // transiently. Nominating evicted turns would let evicted-era values
  // permanently squat the first-FIT closet and starve surviving turns.
  interface BuiltFoldTurn {
    ordinal: number;
    folded: FoldedTurn;
    nominationText: string;
    /** Genuine user-authored text for the capped user-verbatim lane (P1b). */
    userNominationText: string;
  }
  const builtTurns: BuiltFoldTurn[] = [];

  for (let turnIdx = 0; turnIdx < turnsToCompress.length; turnIdx++) {
    if (turnIdx < initialEvictedThrough) continue; // tombstoned at a prior epoch
    const turn = turnsToCompress[turnIdx];
    const category = classifyTurn(turn.messages);
    const toolCalls = extractToolCalls(turn.messages);
    const assistantText = turnAssistantTexts[turnIdx];
    const turnChars = countChars(turn.messages);

    const nominationText = toolCalls.map(tc => tc.resultText).join('\n') + '\n' + assistantText;
    const userNominationText = extractUserText(turn.messages, syntheticContext);
    const toolSkeletons = toolCalls.map(tc => skeletonizeTool(tc));

    let retained: string | undefined;
    const shouldRetainNewestUserText =
      actualFoldCount === turns.length &&
      turnIdx === turnsToCompress.length - 1 &&
      userNominationText.trim().length > 0;
    if (shouldRetainNewestUserText) {
      retained = `User request:\n${userNominationText.trim()}`;
    }

    if (category === 'action') {
      const editLines = toolCalls
        .filter(tc => tc.name === 'Edit' || tc.name === 'Write')
        .map(tc => skeletonizeTool(tc));
      if (editLines.length > 0) {
        retained = retained ? `${retained}\n${editLines.join('\n')}` : editLines.join('\n');
      }
    }

    // Budget-based assistant text retention — all categories now retain text.
    // The budget controls compression level, not the turn category.
    const retention = retentionLevels[turnIdx];
    if (assistantText.length > 0 && retention !== 'skeleton') {
      if (retention === 'full') {
        retained = retained ? `${retained}\n${assistantText}` : assistantText;
      } else {
        const essence = extractAssistantEssence(assistantText);
        if (essence.trim()) {
          retained = retained ? `${retained}\n${essence}` : essence;
        }
      }
    }

    // Cap skeleton at 6 tool calls to avoid walls of one-liners.
    // Show first 5 + count of remaining to keep it scannable.
    let skeleton: string;
    if (toolSkeletons.length > 6) {
      const shown = toolSkeletons.slice(0, 5).join(' | ');
      skeleton = `${shown} | … +${toolSkeletons.length - 5} more tool calls`;
    } else if (toolSkeletons.length > 0) {
      skeleton = toolSkeletons.join(' | ');
    } else if (assistantText.length > 0) {
      skeleton = truncate(assistantText.split('\n').find(l => l.trim()) ?? '', 100);
    } else {
      skeleton = '[empty turn]';
    }

    const retainedLen = (retained?.length ?? 0) + skeleton.length;
    const charsSaved = Math.max(0, turnChars - retainedLen);

    builtTurns.push({
      ordinal: turnIdx,
      folded: {
        timestamp: new Date().toISOString(),
        category,
        skeleton,
        retained,
        charsSaved,
      },
      nominationText,
      userNominationText,
    });
  }

  // Coordinate Closet (P1): per-turn nomination over tool results + assistant text
  // (skeleton-level turns keep their ids; fully-retained text self-filters via
  // conservation against the block body). Conservation runs against BOTH the body
  // the skeletons/retained lines will render AND the growing closet items list itself, so a
  // uuid fragment or `id: <uuid>` KV form adds nothing once the value is carried.
  // Admission is first-FIT in nomination order under the char budget (a later
  // short verbatim token can be admitted after an earlier long one was rejected).
  // Recompute-from-raw keeps it stateless across epochs; iteration order — turns
  // in raw order, pattern priority within a turn — IS the carry-policy seam.
  // Wrapped in assembleBlock so an eviction extension can rebuild collapse +
  // closet + char accounting against the surviving turns in one call.
  const closetBudget = config.verbatimKeepChars ?? 4000;
  const assembleBlock = (evictedThroughOrdinal: number, spans: readonly FoldEvictionSpan[]) => {
    const survivors = builtTurns.filter(b => b.ordinal >= evictedThroughOrdinal);
    const collapsed = collapseSequences(survivors.map(b => b.folded));
    const tombstoneLines = spans.map(formatFoldTombstoneLine);

    const bodyCorpus = collapsed
      .map(ft => (ft.retained ? `${ft.skeleton}\n${ft.retained}` : ft.skeleton))
      .join('\n');
    let closetItems = '';
    if (closetBudget > 0) {
      const closetSet = new Set<string>();
      // Admit a nominated literal under a char ceiling. De-dup is on the BARE
      // value (closetSet + isConservedIn), but the rendered entry carries a
      // deterministic context label (Tier-1 annotated keep) — `value ⟦label⟧`
      // — so an opaque hash keeps its meaning. Budget counts the LABELLED form;
      // under pressure the value is preferred (labelled → bare → skip) so a
      // tight budget never drops the value just to keep its annotation.
      const admit = (lit: string, sourceText: string, ceiling: number): void => {
        if (closetSet.has(lit)) return;
        // Reject trace-exhaust artifacts (spool/screenshot/tmp paths, N/M
        // counters, bare file:line fragments, dictionary slash-bigrams) before
        // they spend closet budget. Artifact-type gate, lineage-blind — see
        // isClosetNoiseLiteral. Real source paths/rail ids/ports/pids survive.
        if (isClosetNoiseLiteral(lit)) return;
        if (isConservedIn(bodyCorpus, lit)) return;
        if (closetItems && isConservedIn(closetItems, lit)) return;
        const sep = closetItems ? ' · ' : '';
        const label = extractVerbatimContextLabel(sourceText, lit);
        const labelled = label ? `${lit} ⟦${label}⟧` : lit;
        if (closetItems.length + sep.length + labelled.length <= ceiling) {
          closetItems += sep + labelled;
        } else if (closetItems.length + sep.length + lit.length <= ceiling) {
          closetItems += sep + lit;
        } else {
          return;
        }
        closetSet.add(lit);
      };
      for (const built of survivors) {
        for (const lit of nominateVerbatim(built.nominationText)) {
          admit(lit, built.nominationText, closetBudget);
        }
      }
      // P1b user-verbatim lane: AFTER the main lane has claimed its identifiers
      // at full budget, conserve operator-pasted ids/paths/ports too — but only
      // from leftover budget, hard-capped at USER_VERBATIM_LANE_RATIO of the
      // total so a giant user paste can't squat the closet (anti-squat: the
      // agent's working set always wins). Same conservation guards as the main
      // lane keep already-carried values out. Ceiling is frozen against the
      // post-main-lane length, so the cap is on the user lane's OWN growth.
      const userLaneCeiling = Math.min(
        closetBudget,
        closetItems.length + Math.floor(closetBudget * USER_VERBATIM_LANE_RATIO),
      );
      for (const built of survivors) {
        if (!built.userNominationText) continue;
        for (const lit of nominateVerbatim(built.userNominationText)) {
          admit(lit, built.userNominationText, userLaneCeiling);
        }
      }
    }
    const closetLine = closetItems
      ? `⌖⌖⌖ COORDINATE CLOSET ⌖⌖⌖ conserved verbatim ids/paths/values from folded turns — trust before re-reading files: ${closetItems}`
      : undefined;

    // Tombstones count into blockChars like other lines.
    const blockChars =
      collapsed.reduce((s, ft) => s + ft.skeleton.length + (ft.retained?.length ?? 0), 0) +
      (closetLine?.length ?? 0) +
      FOLD_BLOCK_PREAMBLE.length +
      tombstoneLines.reduce((s, line) => s + line.length, 0);
    return { collapsed, closetLine, blockChars, tombstoneLines };
  };

  // ── E10 eviction.
  // Targeted full-recompute callers pass targetEvictThroughOrdinal, making
  // eviction an epoch contract: advance oldest-first through the requested safe
  // frontier. Direct legacy callers without a target keep the old threshold
  // sawtooth behavior.
  let evictionSpans: FoldEvictionSpan[] = eviction ? eviction.evictedSpans.map(s => ({ ...s })) : [];
  let evictedThrough = initialEvictedThrough;
  let evictionOutcome: FoldEvictionOutcome | undefined;
  const spansFor = (through: number): FoldEvictionSpan[] => {
    if (through <= initialEvictedThrough) return mergeEvictionSpans(evictionSpans);
    const stamp = eviction?.nowIso ?? new Date().toISOString();
    return mergeEvictionSpans([
      ...evictionSpans,
      {
        fromOrdinal: initialEvictedThrough,
        toOrdinalExclusive: through,
        turnCount: through - initialEvictedThrough,
        firstEvictedIso: stamp,
        lastEvictedIso: stamp,
      },
    ]);
  };

  let block = assembleBlock(evictedThrough, spansFor(evictedThrough));
  if (eviction && eviction.thresholdChars > 0) {
    const evictCeil = Math.min(Math.max(eviction.evictableThroughOrdinal, 0), actualFoldCount);
    const requestedTarget = typeof eviction.targetEvictThroughOrdinal === 'number'
      ? Math.min(Math.max(Math.floor(eviction.targetEvictThroughOrdinal), 0), actualFoldCount)
      : undefined;
    if (requestedTarget !== undefined) {
      const next = Math.min(Math.max(requestedTarget, initialEvictedThrough), evictCeil);
      if (next > evictedThrough) {
        evictedThrough = next;
        block = assembleBlock(evictedThrough, spansFor(evictedThrough));
      }
      if (requestedTarget <= initialEvictedThrough || evictCeil <= initialEvictedThrough) {
        evictionOutcome = 'nothing_eligible';
      } else if (evictCeil < requestedTarget) {
        evictionOutcome = evictedThrough > initialEvictedThrough ? 'partial_frontier_limited' : 'nothing_eligible';
      } else {
        evictionOutcome = evictedThrough > initialEvictedThrough ? 'evicted' : 'nothing_eligible';
      }
    } else {
      const target = Math.floor(eviction.thresholdChars * EVICTION_TARGET_RATIO);
      let passes = 0;
      while (block.blockChars > eviction.thresholdChars && evictedThrough < evictCeil && passes < 3) {
        let projected = block.blockChars;
        let next = evictedThrough;
        while (projected > target && next < evictCeil) {
          const built = builtTurns[next - initialEvictedThrough];
          projected -= built.folded.skeleton.length + (built.folded.retained?.length ?? 0);
          next++;
        }
        if (next === evictedThrough) break;
        evictedThrough = next;
        block = assembleBlock(evictedThrough, spansFor(evictedThrough));
        passes++;
      }
      if (evictedThrough > initialEvictedThrough) evictionOutcome = 'evicted';
    }
  }
  const newlyEvictedTurns = Math.max(0, evictedThrough - initialEvictedThrough);
  if (newlyEvictedTurns > 0 || evictionSpans.length > 0) {
    evictionSpans = spansFor(evictedThrough);
  }

  const foldedBlockText = renderFoldedBlock(block.collapsed, {
    turnsFolded: actualFoldCount,
    origChars: countChars(foldZone) - countChars(systemInFoldZone),
    blockChars: block.blockChars,
  }, block.closetLine, block.tombstoneLines, counterStamp);

  const foldedMessage: FoldMessage = { role: 'user', content: foldedBlockText };
  const ackMessage: FoldMessage = {
    role: 'assistant',
    content: 'Acknowledged. Continuing with the folded context from prior turns.',
  };

  // Preserve user/assistant alternation at the splice. The synthetic block is
  // user(folded) → assistant(ack); normally the active window starts with a real
  // USER turn, so the ack correctly sits between them. But a step-segmented active
  // window (marathon fold via precomputedTurns) starts with an ASSISTANT tool_use
  // message — appending it right after the assistant ack would create two consecutive
  // assistant messages and violate the Anthropic/FC alternation invariant. When
  // folding every turn there is no active window after the synthetic block, so
  // drop the cosmetic ack and leave the provider-visible tail as user(folded).
  const activeLeadsWithAssistant = activeWindow.length > 0 && (activeWindow[0]?.role === 'assistant' || activeWindow[0]?.role === 'model');
  const includeAck = activeWindow.length > 0 && !activeLeadsWithAssistant;

  const finalMessages: FoldMessage[] = [
    ...prefixMessages,
    ...systemInFoldZone,
    foldedMessage,
    ...(includeAck ? [ackMessage] : []),
    ...activeWindow,
  ];

  const foldedChars = countChars(finalMessages);
  const savingsPercent = originalChars > 0
    ? Math.round((1 - foldedChars / originalChars) * 100)
    : 0;

  return {
    messages: finalMessages,
    originalChars,
    foldedChars,
    savingsPercent,
    turnsFolded: actualFoldCount,
    turnsRetained: turns.length - actualFoldCount,
    foldSummaries: block.collapsed,
    ...(eviction ? {
      evictedSpans: evictionSpans,
      newlyEvictedTurns,
      ...(evictionOutcome ? { evictionOutcome } : {}),
    } : {}),
  };
}

// ══════════════════════════════════════════════════════════════════════
// Intra-turn folding — compress tool results within individual turns
//
// Inter-turn folding replaces entire old turns with skeletons.
// Intra-turn folding keeps every turn but truncates consumed tool
// results in the middle of a turn, preserving the tail buffer
// (most recent N results per turn) at full fidelity.
//
// Recovery: raw transcript lives in JSONL on disk. An agent can
// self-tap to recover any folded result without re-investigating.
// ══════════════════════════════════════════════════════════════════════

export interface IntraTurnFoldConfig {
  /** Recent tool results per turn to keep at full fidelity. */
  tailBuffer: number;
  /** Don't truncate results smaller than this (chars). */
  minTruncateSize: number;
  /** Only apply when total char count exceeds this. */
  charThreshold: number;
  /** Higher threshold for atlas_query lookup results — they carry structured metadata worth preserving. */
  atlasLookupThreshold: number;
  /** File paths currently claimed via partner_claim_file — these are never folded (auto-unfold on claim). */
  claimedPaths?: ReadonlySet<string>;
}

export const DEFAULT_INTRA_FOLD_CONFIG: IntraTurnFoldConfig = {
  tailBuffer: 5,
  minTruncateSize: 500,
  charThreshold: 400_000,
  atlasLookupThreshold: 8_000,
};

/**
 * Always-on intra-turn fold config — fires every turn instead of only past a
 * char threshold, so context stays lean from turn 1. Used when an instance's
 * rollingFold mode is 'on' (or 'dry-run' for preview).
 *
 * "Cheaper but still adequate signal": the threshold gate is removed
 * (charThreshold: 0 → intraTurnFold never early-returns), but every per-result
 * preservation rule stays in force, so signal quality is unchanged:
 *   - tailBuffer keeps the most recent results per turn at full fidelity
 *     (your working set is always intact)
 *   - minTruncateSize is raised to 2_000 so only genuinely expensive results
 *     fold — fold the whales, keep the minnows. Small/medium results that are
 *     already cheap stay verbatim rather than churning into ~80-char markers.
 *   - atlas lookups < atlasLookupThreshold stay full; larger ones keep all
 *     metadata (Purpose/Hazards/Patterns) and fold only the raw source block
 *   - claimed paths and error results are never folded
 *   - every folded result keeps a `self-tap to recover` path (raw JSONL intact)
 *
 * Turns with <= tailBuffer substantial results still no-op naturally (the tail
 * buffer covers them), so short turns are unaffected — folding only bites once
 * consumed results accumulate, which is exactly when you want it.
 */
export const ALWAYS_ON_INTRA_FOLD_CONFIG: IntraTurnFoldConfig = {
  tailBuffer: 5,
  minTruncateSize: 2_000,
  charThreshold: 0,
  atlasLookupThreshold: 8_000,
};

export interface IntraTurnFoldResult {
  messages: FoldMessage[];
  originalChars: number;
  foldedChars: number;
  savingsPercent: number;
  toolResultsFolded: number;
  toolResultsKept: number;
}

// ── Per-turn tool result folding ──

interface ToolResultRef {
  msgIndex: number;
  blockIndex?: number;
  toolId: string;
  charCount: number;
  isError: boolean;
  /** Original content text — needed for atlas metadata preservation (feature #5). */
  contentText: string;
}

function geminiFunctionResponseText(response: unknown): string {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const result = (response as Record<string, unknown>).result;
    if (typeof result === 'string') return result;
    return JSON.stringify(result ?? response);
  }
  return JSON.stringify(response ?? {});
}

function withFoldedGeminiFunctionResponse(response: unknown, foldedText: string): Record<string, unknown> {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    return { ...(response as Record<string, unknown>), result: foldedText };
  }
  return { result: foldedText };
}

interface ToolInfo {
  name: string;
  path: string;
  /** For atlas_query tools, the action parameter (lookup, search, etc.) */
  atlasAction?: string;
}

function buildToolInfoMap(turnMessages: FoldMessage[]): Map<string, ToolInfo> {
  const map = new Map<string, ToolInfo>();

  for (const msg of turnMessages) {
    if (msg.role !== 'assistant' && msg.role !== 'model') continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === 'tool_use' && block.id) {
          const name = block.name ?? 'unknown';
          const input = block.input ?? {};
          const shortName = name.replace(/^mcp__[^_]+__/, '');
          const atlasAction = shortName === 'atlas_query' ? String(input.action ?? '') : undefined;
          map.set(block.id, { name, path: extractPath(input), atlasAction });
        }
      }
    }
    if (Array.isArray((msg as any).tool_calls)) {
      for (const tc of (msg as any).tool_calls) {
        if (tc?.id && tc?.function?.name) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments ?? '{}'); } catch { /* skip */ }
          const name = tc.function.name;
          const shortName = name.replace(/^mcp__[^_]+__/, '');
          const atlasAction = shortName === 'atlas_query' ? String(args.action ?? '') : undefined;
          map.set(tc.id, { name, path: extractPath(args), atlasAction });
        }
      }
    }
    if (Array.isArray((msg as any).parts)) {
      for (const part of (msg as any).parts) {
        if (part?.functionCall) {
          const fc = part.functionCall;
          if (fc.name) {
            const tcId = fc.id || '';
            const args = (fc.args ?? {}) as Record<string, unknown>;
            const shortName = fc.name.replace(/^mcp__[^_]+__/, '');
            const atlasAction = shortName === 'atlas_query' ? String(args.action ?? '') : undefined;
            map.set(tcId, { name: fc.name, path: extractPath(args), atlasAction });
          }
        }
      }
    }
  }

  return map;
}

/** Check if a tool name (possibly with mcp prefix) is an atlas_query tool. */
function isAtlasQueryTool(name: string): boolean {
  const short = name.replace(/^mcp__[^_]+__/, '');
  return short === 'atlas_query';
}

/** Check if a tool result path matches any claimed path (normalized comparison). */
function isClaimedPath(toolPath: string, claimedPaths: ReadonlySet<string> | undefined): boolean {
  if (!claimedPaths || claimedPaths.size === 0) return false;
  const normalized = normalizeToolPath(toolPath);
  for (const claimed of claimedPaths) {
    const normalizedClaimed = normalizeToolPath(claimed);
    if (normalized === normalizedClaimed || toolPath === claimed) return true;
  }
  return false;
}

/**
 * Extract the set of normalized tool-arg paths referenced by tool_use blocks
 * (Anthropic-style content arrays), tool_calls (OpenAI-style), or functionCall
 * parts (Gemini-style) in the given messages. Mirrors buildToolInfoMap's extraction exactly — the fold's
 * claimed-path unfold rule keys off these paths (`isClaimedPath(info.path)`),
 * so a file claim can only change the fold's output when its normalized path
 * is in this set. Used by the fold freeze (foldFreeze.ts) to skip epochs for
 * claims on paths a session never touched.
 */
export function extractToolPathSet(messages: readonly FoldMessage[]): Set<string> {
  const paths = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant' && msg.role !== 'model') continue;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.type === 'tool_use' && block.id) {
          const path = extractPath(block.input ?? {});
          if (path) paths.add(path);
        }
      }
    }
    if (Array.isArray((msg as any).tool_calls)) {
      for (const tc of (msg as any).tool_calls) {
        if (tc?.id && tc?.function?.name) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments ?? '{}'); } catch { /* skip */ }
          const path = extractPath(args);
          if (path) paths.add(path);
        }
      }
    }
    if (Array.isArray((msg as any).parts)) {
      for (const part of (msg as any).parts) {
        if (part?.functionCall) {
          const fc = part.functionCall;
          const args = (fc.args ?? {}) as Record<string, unknown>;
          const path = extractPath(args);
          if (path) paths.add(path);
        }
      }
    }
  }
  return paths;
}

/**
 * For atlas_query results, split content into metadata (everything before ## Source)
 * and source code. Return metadata + fold marker for source, or null if not an atlas result.
 */
function foldAtlasPreservingMetadata(
  content: string,
  info: ToolInfo | undefined,
  charCount: number,
): string | null {
  if (!info || !isAtlasQueryTool(info.name)) return null;

  // Find the source section boundary
  const sourceMarker = '\n## Source';
  const sourceIdx = content.indexOf(sourceMarker);
  if (sourceIdx === -1) {
    // No source section — might be a search/cluster/brief result, not a lookup.
    // Only apply metadata preservation for lookup results.
    if (info.atlasAction === 'lookup') {
      // Lookup without source section — keep the metadata intact, add fold note at end
      return content + '\n\n[Folded source section — no source block found in this result]';
    }
    return null;
  }

  const metadata = content.slice(0, sourceIdx);
  const metadataLen = metadata.length;
  const sourceLen = charCount - metadataLen;

  // If metadata alone is already huge (>20K), fold everything — the metadata is the bulk
  if (metadataLen > 20_000) return null;

  // Preserve metadata, fold the source
  const toolName = info.name.replace(/^mcp__[^_]+__/, '');
  const pathStr = info.path ? ` ${info.path}` : '';
  return metadata.trimEnd() + `\n\n## Source [Folded: ${toolName}${pathStr} — ${sourceLen.toLocaleString()} chars of source code | self-tap to recover]`;
}

function findToolResults(turnMessages: FoldMessage[]): ToolResultRef[] {
  const refs: ToolResultRef[] = [];

  for (let i = 0; i < turnMessages.length; i++) {
    const msg = turnMessages[i];

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (let j = 0; j < (msg.content as any[]).length; j++) {
        const block = (msg.content as any[])[j];
        if (block?.type === 'tool_result' && block.tool_use_id) {
          const contentStr = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? (block.content as any[]).map((b: any) => typeof b === 'string' ? b : b?.text ?? JSON.stringify(b)).join('\n')
              : JSON.stringify(block.content ?? '');
          refs.push({
            msgIndex: i,
            blockIndex: j,
            toolId: block.tool_use_id,
            charCount: contentStr.length,
            isError: block.is_error === true,
            contentText: contentStr,
          });
        }
      }
    }

    if (msg.role === 'tool' && typeof (msg as any).tool_call_id === 'string') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      refs.push({
        msgIndex: i,
        toolId: (msg as any).tool_call_id,
        charCount: content.length,
        isError: false,
        contentText: content,
      });
    }

    if (msg.role === 'user' && Array.isArray((msg as any).parts)) {
      for (let j = 0; j < (msg as any).parts.length; j++) {
        const part = (msg as any).parts[j];
        const fr = part?.functionResponse;
        if (fr?.id) {
          const contentStr = geminiFunctionResponseText(fr.response);
          refs.push({
            msgIndex: i,
            blockIndex: j,
            toolId: fr.id,
            charCount: contentStr.length,
            isError: false,
            contentText: contentStr,
          });
        }
      }
    }
  }

  return refs;
}

function foldSummaryText(info: ToolInfo | undefined, charCount: number, originalContent?: string): string {
  const toolName = info?.name?.replace(/^mcp__[^_]+__/, '') ?? 'tool';
  const pathStr = info?.path ? ` ${info.path}` : '';

  // Feature #5: For atlas_query results, try preserving metadata
  if (originalContent && info && isAtlasQueryTool(info.name)) {
    const preserved = foldAtlasPreservingMetadata(originalContent, info, charCount);
    if (preserved !== null) return preserved;
  }

  return `[Folded: ${toolName}${pathStr} — ${charCount.toLocaleString()} chars | self-tap to recover]`;
}

interface TurnFoldStats { folded: number; kept: number }

function foldTurnToolResults(
  turnMessages: FoldMessage[],
  config: IntraTurnFoldConfig,
): { foldedMessages: FoldMessage[] } & TurnFoldStats {
  const toolInfoMap = buildToolInfoMap(turnMessages);
  const toolResults = findToolResults(turnMessages);

  if (toolResults.length === 0) {
    return { foldedMessages: turnMessages, folded: 0, kept: 0 };
  }

  const keepSet = new Set<number>();

  // Keep tail buffer (most recent N results)
  for (let i = Math.max(0, toolResults.length - config.tailBuffer); i < toolResults.length; i++) {
    keepSet.add(i);
  }

  for (let i = 0; i < toolResults.length; i++) {
    const ref = toolResults[i];
    const info = toolInfoMap.get(ref.toolId);

    // Keep small results and error results
    if (ref.charCount < config.minTruncateSize || ref.isError) {
      keepSet.add(i);
      continue;
    }

    // Feature #1: Auto-unfold on claim — never fold results for claimed paths
    if (info && isClaimedPath(info.path, config.claimedPaths)) {
      keepSet.add(i);
      continue;
    }

    // Feature #2: Higher threshold for atlas_query lookup results
    if (info && isAtlasQueryTool(info.name) && info.atlasAction === 'lookup') {
      if (ref.charCount < config.atlasLookupThreshold) {
        keepSet.add(i);
      }
      // atlas lookups above threshold proceed to fold (with feature #5 metadata preservation)
    }
  }

  const foldTargets = new Map<string, ToolResultRef>();
  let folded = 0;
  let kept = 0;

  for (let i = 0; i < toolResults.length; i++) {
    if (keepSet.has(i)) {
      kept++;
    } else {
      const ref = toolResults[i];
      const key = ref.blockIndex !== undefined ? `${ref.msgIndex}:${ref.blockIndex}` : `${ref.msgIndex}`;
      foldTargets.set(key, ref);
      folded++;
    }
  }

  if (folded === 0) {
    return { foldedMessages: turnMessages, folded: 0, kept };
  }

  const foldedMessages: FoldMessage[] = [];

  for (let i = 0; i < turnMessages.length; i++) {
    const msg = turnMessages[i];

    // OpenAI tool message
    if (msg.role === 'tool' && foldTargets.has(`${i}`)) {
      const ref = foldTargets.get(`${i}`)!;
      const info = toolInfoMap.get(ref.toolId);
      foldedMessages.push({ ...msg, content: foldSummaryText(info, ref.charCount, ref.contentText) });
      continue;
    }

    // Anthropic user message with tool_result blocks
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      let changed = false;
      const newContent: unknown[] = [];

      for (let j = 0; j < (msg.content as any[]).length; j++) {
        const block = (msg.content as any[])[j];
        const key = `${i}:${j}`;

        if (block?.type === 'tool_result' && foldTargets.has(key)) {
          const ref = foldTargets.get(key)!;
          const info = toolInfoMap.get(ref.toolId);
          newContent.push({ ...block, content: foldSummaryText(info, ref.charCount, ref.contentText) });
          changed = true;
        } else {
          newContent.push(block);
        }
      }

      foldedMessages.push(changed ? { ...msg, content: newContent } : msg);
      continue;
    }

    // Gemini user message with functionResponse parts
    if (msg.role === 'user' && Array.isArray((msg as any).parts)) {
      let changed = false;
      const newParts: unknown[] = [];

      for (let j = 0; j < (msg as any).parts.length; j++) {
        const part = (msg as any).parts[j];
        const key = `${i}:${j}`;
        const fr = part?.functionResponse;

        if (fr && foldTargets.has(key)) {
          const ref = foldTargets.get(key)!;
          const info = toolInfoMap.get(ref.toolId);
          newParts.push({
            ...part,
            functionResponse: {
              ...fr,
              response: withFoldedGeminiFunctionResponse(fr.response, foldSummaryText(info, ref.charCount, ref.contentText)),
            },
          });
          changed = true;
        } else {
          newParts.push(part);
        }
      }

      foldedMessages.push(changed ? ({ ...msg, parts: newParts } as FoldMessage) : msg);
      continue;
    }

    foldedMessages.push(msg);
  }

  return { foldedMessages, folded, kept };
}

/**
 * Compress tool results within individual turns.
 *
 * Keeps the tail buffer (most recent N tool results per turn) at full
 * fidelity. Truncates older results to one-line summaries. Never
 * mutates input — returns a new array.
 *
 * Recovery path: raw transcript persists in JSONL on disk; agents can
 * self-tap to recover any folded result.
 */
export function intraTurnFold(
  messages: FoldMessage[],
  config: IntraTurnFoldConfig = DEFAULT_INTRA_FOLD_CONFIG,
  syntheticContext: SyntheticContextOptions = EMPTY_SYNTHETIC_CONTEXT_OPTIONS,
): IntraTurnFoldResult {
  const originalChars = countChars(messages);

  if (originalChars < config.charThreshold) {
    return { messages, originalChars, foldedChars: originalChars, savingsPercent: 0, toolResultsFolded: 0, toolResultsKept: 0 };
  }

  const turns = detectTurns(messages, syntheticContext);
  const prefixEnd = turns.length > 0 ? turns[0].startIndex : 0;

  let totalFolded = 0;
  let totalKept = 0;
  const result: FoldMessage[] = [...messages.slice(0, prefixEnd)];

  for (const turn of turns) {
    const { foldedMessages, folded, kept } = foldTurnToolResults(turn.messages, config);
    result.push(...foldedMessages);
    totalFolded += folded;
    totalKept += kept;
  }

  // Messages after last turn (shouldn't happen, but safety)
  const lastTurnEnd = turns.length > 0 ? turns[turns.length - 1].endIndex : 0;
  if (lastTurnEnd < messages.length) {
    result.push(...messages.slice(lastTurnEnd));
  }

  const foldedChars = countChars(result);

  return {
    messages: result,
    originalChars,
    foldedChars,
    savingsPercent: originalChars > 0 ? Math.round((1 - foldedChars / originalChars) * 100) : 0,
    toolResultsFolded: totalFolded,
    toolResultsKept: totalKept,
  };
}
