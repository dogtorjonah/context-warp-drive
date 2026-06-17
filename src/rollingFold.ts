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
  /** Number of recent turns to keep at full fidelity. */
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
  /** When true, fold every turn past the active window on every call, bypassing
   *  the soft/hard char and maxTurns thresholds (continuous always-on inter-turn
   *  fold). The active window stays the structural floor (full fidelity) and
   *  assistantTextBudget still governs graduated per-turn detail. Default config
   *  leaves this undefined → existing threshold-gated behavior is unchanged. */
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
}

export interface FoldTrigger {
  shouldFold: boolean;
  turnsToFold: number;
  reason: string;
}

/**
 * A contiguous run of evicted fold ordinals rendered as ONE tombstone line
 * (E10 sawtooth eviction). Ordinals are detectTurns positions over the folded
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
  /** Fold-block char threshold that arms eviction (WARP_FOLD_EVICT_THRESHOLD_CHARS). */
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
 *   - activeWindowTurns (1, rebirth-cadence sized — see the config below) is the
 *     structural floor — the newest turn is NEVER folded and stays at full fidelity
 *     (live working memory is intact). This is the inter-turn analog of the
 *     intra-turn tail buffer. Sized to 1 because swarm agents rebirth every ~2-3
 *     turns; a larger window meant inter-turn fold never engaged at all.
 *   - assistantTextBudget (50K full / 100K essence, allocated newest-first)
 *     governs graduated per-turn detail: turns just past the active window keep
 *     their full assistant text, older turns keep an essence summary, only the
 *     oldest collapse to a pure tool-call skeleton. Reasoning degrades
 *     gradually, never cliff-edged — the exact machinery added (5/14) to fix the
 *     two layers of reasoning loss that category-gated folding caused.
 *   - the fold is recoverable, not destructive — foldContext returns a new array
 *     and never mutates the raw JSONL, so any folded turn is one self-tap away.
 *
 * Conversations with <= activeWindowTurns still no-op naturally (the active
 * window covers them) — at window=1 that means a brand-new single-turn session.
 * From the second turn onward, inter-turn folding bites every turn, which for a
 * rebirth-heavy cadence is exactly when the prior turn has stopped earning its
 * full-fidelity cost (the rebirth that follows will recompress it anyway).
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
export const DEFAULT_FOLD_BAND_TOKENS = 160_000;

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
 * Pure arithmetic — derive the dependent fold budgets from a target
 * steady-state band. `charsPerToken` converts the token target into chars;
 * the default (4) preserves ratio math, while a lower per-engine ratio keeps
 * the band pinned to real tokens on denser tokenizers.
 */
export function resolveFoldBandBudgets(
  bandTokens: number,
  charsPerToken: number = BAND_CHARS_PER_TOKEN,
): FoldBandBudgets {
  const bandChars = bandTokens * charsPerToken;
  return {
    bandTokens,
    bandChars,
    fullRetentionChars: Math.round(bandChars * 0.125),
    essenceRetentionChars: Math.round(bandChars * 0.25),
    evictThresholdChars: Math.round(bandChars * 0.055),
    episodicBoundaryBudgetChars: Math.round(bandChars * 0.005),
  };
}

/**
 * Band-aware ALWAYS_ON fold config. `undefined` (env knob unset) uses the
 * public 160K default band. A band returns a copy with the assistant-text
 * budget scaled by the documented ratios; explicit 100K deep-equals the
 * unscaled base config.
 */
export function resolveFoldConfigForBand(
  bandTokens: number | undefined = DEFAULT_FOLD_BAND_TOKENS,
  charsPerToken: number = BAND_CHARS_PER_TOKEN,
): FoldConfig {
  const resolvedBandTokens = bandTokens ?? DEFAULT_FOLD_BAND_TOKENS;
  const band = resolveFoldBandBudgets(resolvedBandTokens, charsPerToken);
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

/** Synthetic relay note appended to live user turns with bounded operator-message excerpts. */
export const USER_MESSAGE_VAULT_PREFIX = '[User Message Vault]';
export const USER_MESSAGE_VAULT_END = '[/User Message Vault]';

/**
 * Prefix of tombstone lines inside the fold block marking spans whose detail
 * was evicted to the episodic store (E10). Lives INSIDE the block (never
 * standalone injected text), so it needs no isSyntheticContextText arm; it
 * must never collide with FOLD_MARKER (the block's first-line anchor that
 * foldRecall's buildFoldIndex parses).
 */
export const FOLD_TOMBSTONE_PREFIX = '[Paged to episodic store — ';

/** Default fold-block char ceiling that arms eviction (override: WARP_FOLD_EVICT_THRESHOLD_CHARS; '0' disables). */
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

/**
 * Synthetic relay-injected context text — fold blocks, fold-recall
 * cards/hints, and fold-epoch stamps — is never a real user turn boundary.
 * Recall payloads therefore
 * attach to the turn they follow, so they skeletonize away at later fold
 * epochs (page-out-again, fully cyclic) and never inflate turn-count
 * triggers. Exported so foldRecall.ts can apply the same exclusion when
 * extracting real user text.
 */
export function isSyntheticContextText(text: string): boolean {
  return text.startsWith(FOLD_MARKER)
    || text.startsWith(RECALL_CARD_PREFIX)
    || text.startsWith(RECALL_HINT_PREFIX)
    || text.startsWith(FOLD_EPOCH_STAMP_PREFIX)
    || text.startsWith(USER_MESSAGE_VAULT_PREFIX)
    || text.startsWith(EPISODIC_RECALL_PREFIX);
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

function isUserTurnBoundary(msg: FoldMessage): boolean {
  if (msg.role !== 'user') return false;
  const content = msg.content;
  if (typeof content === 'string') {
    return content.length > 0 && !isSyntheticContextText(content);
  }
  if (Array.isArray(content)) {
    return content.some((block: any) =>
      (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0 && !isSyntheticContextText(block.text))
      || (typeof block === 'string' && block.length > 0 && !isSyntheticContextText(block)),
    );
  }
  const parts = (msg as any).parts;
  if (Array.isArray(parts)) {
    return parts.some((part: any) =>
      typeof part?.text === 'string' && part.text.length > 0 && !isSyntheticContextText(part.text)
    );
  }
  return false;
}

export function detectTurns(messages: FoldMessage[]): Turn[] {
  const turns: Turn[] = [];
  let turnStart = -1;

  for (let i = 0; i < messages.length; i++) {
    if (isUserTurnBoundary(messages[i])) {
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
// inter-turn fold (which only compresses turns BEHIND the 1-turn active window)
// never engages on it (checkFoldTrigger: turnCount ≤ activeWindowTurns → no-fold),
// and the single active turn balloons until it hits the provider's hard context
// ceiling (the MiniMax-M3 400 "context window exceeds limit"). Step segmentation
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
): StepFoldPlan | null {
  const turns = detectTurns(messages);
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
export function extractUserText(turnMessages: FoldMessage[]): string {
  const texts: string[] = [];
  for (const msg of turnMessages) {
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string' && msg.content.trim()) {
      const cleaned = stripUserMessageVaultBlocks(msg.content).trim();
      if (cleaned) texts.push(cleaned);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        // Only genuine text blocks — tool_result blocks are tool output.
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          const cleaned = stripUserMessageVaultBlocks(block.text).trim();
          if (cleaned) texts.push(cleaned);
        }
      }
    } else if (Array.isArray((msg as any).parts)) {
      for (const part of (msg as any).parts as any[]) {
        if (part?.functionResponse) continue; // tool output, not user text
        if (typeof part?.text === 'string' && part.text.trim()) {
          const cleaned = stripUserMessageVaultBlocks(part.text).trim();
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
 * Normalize an absolute monorepo path to repo-relative form by stripping a
 * leading `/home/<user>/<repo>/` prefix. This is the canonical normalization
 * used by claimed-path matching (`isClaimedPath`) and tool-arg path extraction
 * — exported so the fold freeze (foldFreeze.ts) can test claim relevance with
 * byte-identical semantics.
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

/**
 * Extract up to `max` carry-worthy verbatim values from a result text (receipts belt).
 * Value-deduped via isConservedIn so `deadbeefcafe` and `id: deadbeefcafe` never
 * spend two slots on one value (nominates a wider pool, then greedy-selects).
 */
function beltVerbatim(text: string, max = 2): string {
  const picked: string[] = [];
  for (const lit of nominateVerbatim(text, max * 4)) {
    if (picked.length >= max) break;
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
  'mcp__agent-bridge__atlas_query', 'mcp__brain-mcp__atlas_query',
  'mcp__agent-bridge__atlas_graph', 'mcp__brain-mcp__atlas_graph',
  'mcp__agent-bridge__atlas_audit', 'mcp__brain-mcp__atlas_audit',
  'mcp__agent-bridge__search_docs', 'mcp__agent-bridge__devlog_query',
]);

const ACTION_TOOLS = new Set([
  'Edit', 'Write', 'NotebookEdit',
  'mcp__agent-bridge__atlas_commit', 'mcp__brain-mcp__atlas_commit',
  'mcp__agent-bridge__apply_migration', 'mcp__agent-bridge__execute_sql',
  'mcp__agent-bridge__deploy_edge_function',
]);

const COORDINATION_TOOLS = new Set([
  'mcp__agent-bridge__chatroom', 'mcp__agent-bridge__tap_instance_messages',
  'mcp__agent-bridge__tap_star', 'mcp__agent-bridge__spawn_instance',
  'mcp__agent-bridge__kill_instance',
  'mcp__agent-bridge__psychic_pov', 'mcp__agent-bridge__task_rail',
  'mcp__agent-bridge__signal_overseer', 'mcp__agent-bridge__self_rebirth',
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
    // 250 chars preserves most constraint statements and cross-file reasoning
    // that the old 120-char cutoff was killing.
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
): FoldTrigger {
  const totalChars = countChars(messages);
  const turns = detectTurns(messages);
  const turnCount = turns.length;

  if (turnCount <= config.activeWindowTurns) {
    return { shouldFold: false, turnsToFold: 0, reason: `${turnCount} turns ≤ activeWindow(${config.activeWindowTurns})` };
  }

  const foldable = turnCount - config.activeWindowTurns;

  // Continuous always-on: fold every turn past the active window on every call,
  // bypassing the soft/hard char + maxTurns gates. The active-window early-return
  // above already protects short conversations (turnCount <= activeWindowTurns
  // never reaches here), and foldContext's budget pre-pass keeps the freshest
  // folded turns at full/essence fidelity — so this stays "lean but adequate"
  // rather than cliff-edged. Default config leaves continuous undefined, so the
  // threshold-gated behavior below is unchanged for every other caller.
  if (config.continuous) {
    return {
      shouldFold: true,
      turnsToFold: foldable,
      reason: `continuous: fold ${foldable} turn(s) past activeWindow(${config.activeWindowTurns})`,
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
// Episodic eviction (E10) — bounded skeleton floor (sawtooth)
//
// The continuous fold accretes one skeleton per folded turn for the life of a
// session, so the standing fold block grows monotonically. Eviction bounds
// it: at freeze EPOCH commits only (the prefix is recomputing anyway —
// cache-safe by construction), when the block exceeds the char threshold, the
// OLDEST folded spans collapse to one tombstone line each. Eligibility is the
// session's call (fcBaseSession.buildFoldEvictionInput): a turn is evictable
// only when its content is durably covered by the episodic store (the capture
// cursor advances past episode-bearing ranges only after the store CONFIRMS
// the write) AND it has been folded for ≥2 epochs. Evicted content is not
// gone: episodic recall serves it as cards on member-path touch, and
// fold-recall still pages the raw turns back transiently — the block header
// count includes evicted turns on purpose so buildFoldIndex keeps indexing
// them.
// ══════════════════════════════════════════════════════════════════════

/** Evict down to threshold × this ratio — real sawtooth teeth instead of a one-turn eviction every epoch. */
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
): FoldResult {
  const originalChars = countChars(messages);

  if (turnsToFold <= 0 || messages.length === 0) {
    return {
      messages,
      originalChars,
      foldedChars: originalChars,
      savingsPercent: 0,
      turnsFolded: 0,
      turnsRetained: detectTurns(messages).length,
      foldSummaries: [],
    };
  }

  // precomputedTurns lets callers inject a custom segmentation (e.g. step-granular
  // segments of one oversized marathon turn) while reusing the entire fold engine
  // below. When omitted, behaviour is byte-identical to detectTurns(messages).
  const turns = precomputedTurns ?? detectTurns(messages);
  const actualFoldCount = Math.min(turnsToFold, Math.max(0, turns.length - 1));

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

  const foldBoundary = turns[actualFoldCount].startIndex;

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
    const userNominationText = extractUserText(turn.messages);
    const toolSkeletons = toolCalls.map(tc => skeletonizeTool(tc));

    let retained: string | undefined;
    if (category === 'action') {
      const editLines = toolCalls
        .filter(tc => tc.name === 'Edit' || tc.name === 'Write')
        .map(tc => skeletonizeTool(tc));
      if (editLines.length > 0) retained = editLines.join('\n');
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

  // ── E10 eviction: when the assembled block exceeds the threshold, advance
  // the tombstone frontier over eligible ordinals down to threshold × ratio.
  // Pre-collapse sizes overstate the body (collapse only shrinks), so one
  // pass can under-evict; bounded re-passes converge. Runs only when the
  // freeze EPOCH recompute path provides an eviction input — never on the
  // legacy/dry-run paths.
  let evictionSpans: FoldEvictionSpan[] = eviction ? eviction.evictedSpans.map(s => ({ ...s })) : [];
  let evictedThrough = initialEvictedThrough;
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
  // assistant messages and violate the Anthropic/FC alternation invariant. When the
  // active window leads with assistant, drop the cosmetic ack so the splice is
  // user(folded) → assistant(active). Byte-identical for normal fold: detectTurns
  // turns always start at a user boundary, so this branch is never taken there.
  const activeLeadsWithAssistant = activeWindow.length > 0 && (activeWindow[0]?.role === 'assistant' || activeWindow[0]?.role === 'model');

  const finalMessages: FoldMessage[] = [
    ...prefixMessages,
    ...systemInFoldZone,
    foldedMessage,
    ...(activeLeadsWithAssistant ? [] : [ackMessage]),
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
    ...(eviction ? { evictedSpans: evictionSpans, newlyEvictedTurns } : {}),
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
): IntraTurnFoldResult {
  const originalChars = countChars(messages);

  if (originalChars < config.charThreshold) {
    return { messages, originalChars, foldedChars: originalChars, savingsPercent: 0, toolResultsFolded: 0, toolResultsKept: 0 };
  }

  const turns = detectTurns(messages);
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
