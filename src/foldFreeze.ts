/**
 * Fold Freeze — cache-aware gating for the rolling-fold compaction pipeline.
 *
 * THE PROBLEM: provider prompt caches (Anthropic explicit `cache_control`
 * breakpoints, OpenAI/Gemini automatic prefix caching) bill cached prefix
 * reads at ~0.1x input price and cache writes at ~1.25x. They match on
 * BYTE-IDENTICAL prefixes. The always-on rolling fold recomputes the folded
 * view on every API call: each new turn entering the fold shifts the
 * newest-first assistant-text budget, re-collapses sequences, and re-renders
 * the synthetic fold block at the head of the messages array — so the message
 * region's bytes change on every call and the provider cache dies at the
 * start of history. Under a hot cache, continuous folding *costs more than it
 * saves*: you re-write the folded region at 1.25x every turn instead of
 * reading stable history at 0.1x. (Break-even needs >92% compression — past
 * the practical fold floor once the assistant-text budget is full.)
 *
 * THE FIX: freeze the compaction pipeline's output and reuse it byte-identical
 * while the provider cache is plausibly alive; append new raw messages after
 * it. Pure append = pure prefix-cache hits (the previous call's rolling
 * breakpoint covers the entire frozen view). Recompute (an "epoch") only when
 * mutation is free or necessary:
 *
 *   - `cold-gap`: time since the last call exceeded the provider cache TTL —
 *     the cache entry already expired, so a full refold costs nothing extra.
 *     Anthropic's ephemeral cache TTL is a sliding 5 minutes (refreshed on
 *     every hit); OpenAI's automatic cache evicts after ~5-10 idle minutes.
 *     Human-paced turn gaps are very often cold, which is where the fold's
 *     full savings land for free.
 *   - `tail-epoch`: the raw overhang appended since the freeze exceeded
 *     `maxTailChars` — pay one bounded cache rewrite (at folded size) to
 *     reclaim fold savings before the context bloats. This is the context
 *     guard for marathon hot streaks.
 *   - `context-changed`: the thinning mode changed, or a file claim appeared
 *     on a path that is actually RELEVANT to the frozen coverage. Claimed
 *     paths must unfold promptly (the fold's claimed-path auto-unfold rule) —
 *     but that rule keys off tool-arg paths (`isClaimedPath(info.path)`), so
 *     a claim can only change the fold's output when its normalized path
 *     matches a tool path present in the covered raw history. Claims on paths
 *     this session never touched — the dominant cross-agent case under the
 *     GLOBAL claims set, where every claim by any agent used to epoch every
 *     fold-on session fleet-wide — reuse safely. Releases of relevant claims
 *     also reuse: the affected content stays unfolded (correct, just briefly
 *     unoptimized) until the next natural epoch re-folds it.
 *   - `history-rewound` / `boundary-mismatch`: the raw history no longer
 *     extends the frozen coverage (rebirth artifacts, truncation, in-place
 *     rewrites). Self-healing: recompute from current raw truth.
 *
 * ── THE TWO-EPOCH LAW ──────────────────────────────────────────────────
 * A live fold has exactly TWO epoch types — never a third:
 *   1. TAIL EPOCH — append-only band commit (`appendFoldFreezeTailEpoch`):
 *      the frozen prefix stays byte-identical; only the freshly folded tail
 *      band is appended behind it.
 *   2. HARD EPOCH — whole-view rebuild (`commitFoldFreeze`), paired by the
 *      session layer with a rebirth-grade continuity seed (portable reset).
 *      `FoldFreezeHardEpochCause` enumerates WHY a hard epoch fired
 *      (first-call bootstrap, cold-gap, boundary healing, pressure, …).
 * The legacy bandless middle tier — a seedless re-fold of
 * the whole history — is retired vocabulary and a banned code path. Do not
 * reintroduce it: any fold that cannot band-append escalates to the seeded
 * hard epoch, full stop.
 *
 * Net effect: the fold's quality machinery (graduated assistant-text budget,
 * sequence collapsing, claimed-path unfolds, atlas-metadata preservation) is
 * untouched — it simply fires in PULSES at epoch boundaries instead of on
 * every call. Between pulses the request stream is append-only and the
 * provider cache stays hot. A pleasant side effect: recent turns stay
 * verbatim throughout a hot streak (the fold boundary doesn't advance), which
 * softens the activeWindowTurns=1 "big result last turn" trade-off most of
 * the time.
 *
 * Engine-agnostic: lives at the `applyCompaction` seam in FcBaseSession, so
 * claude-api, OpenAI, Gemini, GLM, Grok, Mistral, and MiniMax all inherit it.
 * Pure CPU, zero I/O, no timers — event-loop safe by construction. State
 * lives on the session object and resets naturally on rebirth.
 *
 * Kill switch: VOXXO_FOLD_FREEZE=0 reverts to per-call recompute (the
 * pre-freeze always-on behavior). TTL and tail cap are env-tunable; callers may
 * also provide model-aware defaults so the hot-tail sawtooth tracks the fold
 * target band unless explicitly overridden.
 */

import {
  countChars,
  extractToolPathSet,
  normalizeToolPath,
  type FoldMessage,
} from './rollingFold.ts';
import {
  buildRawRebirthSeedFromMessages,
  DEFAULT_RAW_REBIRTH_SEED_PACKAGE_BUDGET_CHARS,
  DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS,
  findRawRebirthSeedTraceEnd,
} from './rawRebirthSeed.ts';
import { LIVE_CONTINUITY_STATE_HEADER } from './continuityReceipt.ts';

// ══════════════════════════════════════════════════════════════════════
// Config
// ══════════════════════════════════════════════════════════════════════

export interface FoldFreezeConfig {
  /** Master switch. When false, applyCompaction recomputes per call (legacy behavior). */
  enabled: boolean;
  /**
   * Provider prompt-cache TTL in ms. A gap between calls larger than this
   * means the cache entry has expired and recomputing the fold is free.
   * Anthropic ephemeral: sliding 5m, or 1h with extended-TTL breakpoints
   * (claude-api sessions inject the larger default via
   * resolveFoldFreezeConfig defaults). OpenAI automatic: ~5-10m idle eviction.
   */
  ttlMs: number;
  /**
   * Raw overhang cap (chars) accumulated after the frozen view before a
   * forced epoch refold. Keeps marathon hot streaks from bloating context.
   * ~150K chars ≈ ~37K tokens carried at 0.1x cache-read between epochs.
   */
  maxTailChars: number;
}

export const DEFAULT_FOLD_FREEZE_CONFIG: FoldFreezeConfig = {
  enabled: true,
  ttlMs: 5 * 60_000,
  maxTailChars: 150_000,
};

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve config from environment. Default ON.
 *   VOXXO_FOLD_FREEZE=0|false|off|no      → disable (legacy per-call recompute)
 *   WARP_FOLD_FREEZE=0|false|off|no        → disable (standalone alias)
 *   VOXXO_FOLD_FREEZE_TTL_MS=<ms>          → override cache TTL
 *   WARP_FOLD_FREEZE_TTL_MS=<ms>           → override cache TTL (standalone alias)
 *   VOXXO_FOLD_FREEZE_MAX_TAIL_CHARS=<n>   → override raw overhang cap
 *   WARP_FOLD_FREEZE_MAX_TAIL_CHARS=<n>    → override raw overhang cap (standalone alias)
 *
 * Both VOXXO_ and WARP_ prefixes are accepted so the canonical source stays
 * byte-identical across the relay (packages/context-warp) and standalone
 * (context-warp-drive) repos. VOXXO_ takes precedence (relay-native).
 *
 * `defaults.ttlMs` lets a session inject its PROVIDER's actual cache TTL
 * (e.g. claude-api with 1h extended-TTL breakpoints passes 3_600_000) so the
 * cold-gap epoch doesn't refold against a still-warm cache: with a 1h
 * provider cache, a 20-minute gap is NOT free to refold — the old 5m
 * assumption would bust the very cache entries the 1h TTL paid 2× to keep.
 * Precedence: explicit env override > session default > builtin.
 */
export function resolveFoldFreezeConfig(
  env: Record<string, string | undefined> = process.env,
  defaults?: { ttlMs?: number; maxTailChars?: number },
): FoldFreezeConfig {
  const raw = (env.VOXXO_FOLD_FREEZE ?? env.WARP_FOLD_FREEZE ?? '').trim().toLowerCase();
  const enabled = raw === '' || (raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no');
  return {
    enabled,
    ttlMs:
      parsePositiveInt(env.VOXXO_FOLD_FREEZE_TTL_MS)
      ?? parsePositiveInt(env.WARP_FOLD_FREEZE_TTL_MS)
      ?? defaults?.ttlMs
      ?? DEFAULT_FOLD_FREEZE_CONFIG.ttlMs,
    maxTailChars:
      parsePositiveInt(env.VOXXO_FOLD_FREEZE_MAX_TAIL_CHARS)
      ?? parsePositiveInt(env.WARP_FOLD_FREEZE_MAX_TAIL_CHARS)
      ?? defaults?.maxTailChars
      ?? DEFAULT_FOLD_FREEZE_CONFIG.maxTailChars,
  };
}

/** Pure FNV-1a 32-bit hash of a string. No imports, no I/O — event-loop safe. */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/**
 * Deterministic fingerprint input covering every mutable field of the boundary
 * message — role, content, reasoning_content, tool_calls. charCount alone misses
 * same-length content rewrites; a content-only hash missed same-length
 * reasoning_content/tool_calls rewrites (tool_calls isn't char-counted at all).
 * Symmetric between commit and evaluate; state is in-memory only (resets on
 * rebirth/restart), so changing this input shape needs no migration — the
 * undefined back-compat arm in evaluate covers empty-history freezes.
 */
function boundaryFingerprintInput(msg: FoldMessage): string {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
  const rc = msg.reasoning_content === undefined
    ? ''
    : typeof msg.reasoning_content === 'string'
      ? msg.reasoning_content
      : JSON.stringify(msg.reasoning_content);
  const tc = msg.tool_calls === undefined ? '' : JSON.stringify(msg.tool_calls);
  // \u0000 separators: field-shift immunity, and never appear in transcript text.
  return msg.role + '\u0000' + content + '\u0000' + rc + '\u0000' + tc;
}

// ══════════════════════════════════════════════════════════════════════
// State
// ══════════════════════════════════════════════════════════════════════

/**
 * Cause attached to a whole-view rebuild (`commitFoldFreeze`). Two-epoch
 * law: a committed whole-view rebuild IS the hard epoch — the only non-tail
 * epoch type; there is no separate bandless re-fold epoch. Note 'tail-epoch'
 * here means "raw tail overflow made a fold due": callers attempt the
 * append-only band first and reach commitFoldFreeze with this cause only by
 * escalating to the seeded hard epoch.
 */
export type FoldFreezeHardEpochCause =
  | 'first-call'
  | 'cold-gap'
  | 'context-changed'
  | 'history-rewound'
  | 'boundary-mismatch'
  | 'tail-epoch'
  // A restored (rebirth/fork) frozen prefix whose CURRENT raw tail exceeds
  // maxTailChars. Deliberately distinct from 'tail-epoch': the append-only
  // tail-epoch path seals the existing frozen view byte-identically and
  // appends only a folded tail — which would PRESERVE the oversized restored
  // prefix the rebirth was supposed to recompute away. Both the relay
  // (FcBaseSession) and standalone (FoldSession) callers gate append-only on
  // `reason === 'tail-epoch'` exactly, so this distinct cause routes the
  // restored overcap through a whole-view hard epoch + eviction instead.
  | 'restored-overcap'
  | 'pressure-ceiling'
  | 'prefix-saturation'
  // Same-instance rebirth-package hard epoch: provider-visible history was
  // replaced with a compact continuity seed. Distinct from pressure-ceiling
  // because the topology reset is the primary action, not just a view rebuild.
  | 'hard-epoch';

export type FoldFreezeTransitionReason =
  | FoldFreezeHardEpochCause
  | 'hot-reuse'
  | 'append-tail-epoch';

export type FoldFreezeAppendCommitReason = 'material-shrink';

export type FoldFreezeAppendSkipReason =
  | 'missing-frozen-view'
  | 'history-rewound'
  | 'empty-tail'
  | 'not-smaller';

export interface FoldFreezeAppendCommit {
  committed: true;
  view: FoldMessage[];
  sealedPrefixMessageCount: number;
  rawTailChars: number;
  rawTailMessages: number;
  bandViewChars: number;
  savedChars: number;
  shrinkRatio: number;
  commitReason: FoldFreezeAppendCommitReason;
}

export interface FoldFreezeAppendSkip {
  committed: false;
  view: FoldMessage[] | null;
  sealedPrefixMessageCount: number | null;
  rawTailChars: number;
  rawTailMessages: number;
  bandViewChars: number;
  savedChars: number;
  shrinkRatio: number | null;
  skipReason: FoldFreezeAppendSkipReason;
}

export type FoldFreezeAppendResult = FoldFreezeAppendCommit | FoldFreezeAppendSkip;

const APPEND_TAIL_MIN_SHRINK_RATIO = 0.9;

/**
 * Tail-epoch efficiency ALARM threshold (rail-c63e326e s4). A tail-epoch
 * attempt can pass the `APPEND_TAIL_MIN_SHRINK_RATIO` commit gate (shrinkRatio
 * <= 0.9, i.e. "saved at least something") yet still land far outside the
 * ~5K append-band target the runway model assumes — e.g. dense tool-result /
 * code / JSON content that resists turn-based compaction. This SEPARATE,
 * stricter threshold flags that "barely helped" case for operator visibility:
 * 0.9 asks "did folding help AT ALL"; 0.6 asks "did it help ENOUGH to matter"
 * (>=40% saved). A shrink ratio worse than this escalates the emitted
 * epoch/skip log line from console.log to console.warn and appends an
 * ` ⚠ ALARM: …` suffix into the epochCause string — visible through the
 * EXISTING aa-ledger fold_events `epoch_cause` field with no schema change,
 * since EPOCH_RE captures the full cause text lazily up to `) — frozen`.
 *
 * Live case that validates this threshold (2026-07-01, stealth-dragon/glm,
 * epoch #2, ts 1782921627686): a single append-only tail-epoch attempt folded
 * 123 raw tail messages (287,211 raw chars -> 258,454 folded chars) for only
 * 10% savings — shrinkRatio ≈ 0.8999, i.e. it JUST barely squeaked under the
 * 0.9 commit gate. Root cause: this tail accumulated across many tool calls
 * inside one long turn before any tail-epoch trigger fired (only 1 prior
 * cached msg was sealed, so essentially the whole early session landed in one
 * shot), and the bulk of those 123 messages were large tool-result payloads
 * (dense code/JSON/log dumps) that are already low-redundancy prose-wise —
 * turn-based fold summarization has little to compress out of structured,
 * already-terse content. This threshold exists so that class of "technically
 * committed, functionally useless" tail epoch is surfaced instead of silently
 * passing as a normal EPOCH line.
 */
export const TAIL_EPOCH_EFFICIENCY_ALARM_SHRINK_RATIO = 0.6;

/**
 * Pure check: does this tail-epoch attempt's shrink ratio breach the
 * efficiency alarm threshold? `null` (no raw tail chars to measure) never
 * alarms — there is nothing to judge efficiency against.
 */
export function isTailEpochEfficiencyAlarm(shrinkRatio: number | null): boolean {
  return shrinkRatio !== null && shrinkRatio > TAIL_EPOCH_EFFICIENCY_ALARM_SHRINK_RATIO;
}

/**
 * Tail-epoch YIELD-ESCALATION threshold (rail P180/TRIG150 — the per-fold yield
 * gate). Distinct from the 0.6 efficiency ALARM above: the alarm only SURFACES a
 * weak fold in the epoch/skip log line and changes NO behavior. This stricter-
 * action threshold makes a genuinely useless fold ACTIONABLE. When a would-be
 * tail-epoch band retains more than 70% of the raw it folds (saved < 30%),
 * appending it buys almost nothing — the frozen floor barely drops and the very
 * next turn tail-epochs again (the "folds barely dropping the tail" livelock,
 * complement to the floor gate's "not enough raw tail to fold" livelock). AT
 * PRESSURE (measured occupancy at/above the fold trigger) that class of fold
 * escalates to a hard epoch (topology-resetting seed) instead: re-folding the
 * SAME incompressible content (dense tool-result / code / JSON) seedlessly would
 * not drop the tail either — only the seed reset does. 0.7 (not the 0.6 alarm) tracks
 * the operator's stated "retain >~70%" bar and keeps escalation conservative, so
 * only the truly-stuck folds hard-epoch. Escalation ⊂ alarm: every fold that
 * escalates (>0.7) also alarms (>0.6), but not vice-versa.
 */
export const TAIL_EPOCH_YIELD_ESCALATE_SHRINK_RATIO = 0.7;

/**
 * Whole-gate decision for the per-fold yield escalation: should THIS would-be
 * tail-epoch band be abandoned for a hard epoch instead of appended? True only
 * when BOTH (a) the band retains > 70% of raw (shrinkRatio > the escalate
 * threshold — a low-yield fold) AND (b) the measured trigger-runway is thin:
 * trigger − measured < tailEpochMinRunwayTokens. At/above the trigger the
 * runway is ≤ 0, so the legacy at-pressure condition (measured ≥ trigger) is a
 * strict subset of the runway condition. The widening exists because gap-timer
 * folds fire BELOW the token trigger: a zero-yield band committed there barely
 * drops the frozen floor and the session re-folds seconds later (measured
 * churn: 100%-retention tail epochs 17-25s apart under the trigger). When no
 * min-runway is supplied, falls back to the legacy at-pressure check. Far from
 * the trigger a weak fold is harmless (ample runway) and still appends/hot-
 * reuses, so the gate never fires early on a cold session. shrinkRatio is a
 * text-compression ratio (folded chars / raw chars) — NOT a token count — so
 * this is GOD-RULE-7-safe; runway is judged only from provider-measured tokens
 * vs the resolved trigger, never synthesized from chars. Returns false whenever
 * shrinkRatio is null (no raw tail to judge) or the measured/trigger pair is
 * unavailable (cannot assess runway → legacy append).
 */
export function shouldEscalateTailEpochForLowYield(
  shrinkRatio: number | null,
  measuredInputTokens: number | null | undefined,
  foldTriggerTokens: number | null | undefined,
  tailEpochMinRunwayTokens?: number | null,
): boolean {
  if (shrinkRatio === null || !Number.isFinite(shrinkRatio) || shrinkRatio <= TAIL_EPOCH_YIELD_ESCALATE_SHRINK_RATIO) {
    return false;
  }
  const measured = typeof measuredInputTokens === 'number' && Number.isFinite(measuredInputTokens) && measuredInputTokens > 0
    ? measuredInputTokens
    : null;
  const trigger = typeof foldTriggerTokens === 'number' && Number.isFinite(foldTriggerTokens) && foldTriggerTokens > 0
    ? foldTriggerTokens
    : null;
  if (measured === null || trigger === null) return false;
  const minRunway = typeof tailEpochMinRunwayTokens === 'number' && Number.isFinite(tailEpochMinRunwayTokens) && tailEpochMinRunwayTokens > 0
    ? tailEpochMinRunwayTokens
    : null;
  if (minRunway === null) return measured >= trigger;
  return trigger - measured < minRunway;
}

export const FOLD_FREEZE_HARD_EPOCH_CAUSES: readonly FoldFreezeHardEpochCause[] = [
  'first-call',
  'cold-gap',
  'context-changed',
  'history-rewound',
  'boundary-mismatch',
  'tail-epoch',
  'restored-overcap',
  'pressure-ceiling',
  'prefix-saturation',
  'hard-epoch',
];

/** Header that separates the rebirth-package seed body from the merged live turn. */
export const HARD_EPOCH_LIVE_TURN_HEADER =
  '--- LIVE TURN (the user message that triggered this completed hard epoch; do not treat it as a fresh unstarted request) ---';
export const HARD_EPOCH_CONTINUITY_DIRECTIVE =
  'Continuity refresh: a same-instance hard epoch (context reset) just completed. Treat the seed and merged live turn as already-triggered continuity context, re-evaluate the next action, and do not re-execute work whose boundary/epoch condition is now satisfied. Do not announce, narrate, or apologize for the reset unless the user explicitly asks about the mechanism.';

export const DEFAULT_RAW_HARD_EPOCH_SEED_MAX_CHARS = DEFAULT_RAW_REBIRTH_SEED_PACKAGE_BUDGET_CHARS;
export const DEFAULT_RAW_HARD_EPOCH_CLOSET_CHARS =
  DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.rawTraceCoordinateCloset;

export interface RawHardEpochSeedOptions {
  /**
   * Bound the raw trace seed by characters. This is a package budget, not token
   * telemetry; it keeps the hard epoch from re-sending the full over-cap floor.
   */
  readonly maxChars?: number;
  /**
   * Budget for the Coordinate Closet band prepended to the raw seed. This is a
   * character budget for conserved ids/paths/values, not token telemetry.
   */
  readonly closetChars?: number;
  /** Name rendered in the raw rebirth header. */
  readonly predecessorName?: string;
  /** Boundary capture time; omitted remains explicitly unknown in live-state provenance. */
  readonly capturedAt?: string;
  /**
   * Helper-level API for direct buildRawHardEpochSeed callers that need a complete
   * raw trace seed without calling buildHardEpochSeedView afterward. FoldSession
   * leaves this unset because buildHardEpochSeedView appends the live trailing
   * user turn separately; including it in both places would duplicate the request.
   */
  readonly includeTrailingUserTurn?: boolean;
  /** Trace-derived episodic recall text (portable-mode memory section). */
  readonly episodicCrossRef?: string;
  /** Lineage glyph log — chronological verdict/hazard register trail (portable-mode memory section). */
  readonly lineageGlyphLog?: string;
}

/**
 * Compute the default raw same-instance hard-epoch seed directly from the local
 * provider trace. This is the standalone fallback for callers that do not have a
 * richer host rebirth renderer: no Atlas, no episodic memory, no LLM summary.
 * Direct helper callers may set includeTrailingUserTurn when they will not later
 * call buildHardEpochSeedView; FoldSession intentionally keeps it false and uses
 * buildHardEpochSeedView for the provider-safe single-message live-turn merge.
 */
export function buildRawHardEpochSeed(
  messages: readonly FoldMessage[],
  options: RawHardEpochSeedOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_RAW_HARD_EPOCH_SEED_MAX_CHARS;
  const isCompact = maxChars < DEFAULT_RAW_HARD_EPOCH_SEED_MAX_CHARS;
  // The closet's build-stage budget (used to decide which lines fit) and the
  // render-stage section budget (used by allocateSectionBlocks' final char-cap)
  // must be the SAME number. Otherwise the content gets assembled to a larger
  // budget than it is later truncated to, and the final truncate() cuts the
  // block mid-line/mid-literal instead of at a clean line boundary.
  const closetBudget = isCompact
    ? Math.min(
        options.closetChars ?? DEFAULT_RAW_HARD_EPOCH_CLOSET_CHARS,
        Math.max(700, Math.floor(maxChars * 0.18)),
      )
    : (options.closetChars ?? DEFAULT_RAW_HARD_EPOCH_CLOSET_CHARS);
  const compactSectionMaxChars = {
    lastUserAiMessages: Math.max(1_000, Math.min(12_000, Math.floor(maxChars * 0.22))),
    currentThread: Math.max(1_500, Math.min(24_000, Math.floor(maxChars * 0.35))),
    rawTraceCoordinateCloset: Math.min(closetBudget, 4_000),
    thinkingTrail: Math.max(1_000, Math.min(8_000, Math.floor(maxChars * 0.18))),
  };
  return buildRawRebirthSeedFromMessages(messages, {
    predecessorName: options.predecessorName ?? 'predecessor',
    packageBudget: maxChars,
    sectionMaxChars: compactSectionMaxChars,
    rawTraceCoordinateClosetChars: closetBudget,
    includeTrailingUserTurn: options.includeTrailingUserTurn === true,
    episodicCrossRef: options.episodicCrossRef,
    lineageGlyphLog: options.lineageGlyphLog,
    capturedAt: options.capturedAt,
    lifecycleBoundary: 'same_instance_hard_epoch',
  });
}

/**
 * Build the provider-visible view for a same-instance hard epoch: a SINGLE
 * `role:'user'` message that is the compact continuity seed with the live user
 * turn's text merged into its body.
 *
 * Returning ONE user message (never `[seed, currentUserMessage]`) is deliberate
 * and load-bearing — two consecutive `user` turns are rejected by strict
 * providers (e.g. the Anthropic API). The current question is never dropped:
 * the trailing user turn's text is appended to the seed body. Non-string
 * trailing content (e.g. image/attachment parts) cannot be merged into the
 * string seed and is intentionally omitted here; the seed's own recent-messages
 * section carries that continuity. The old raw transcript remains as recall
 * backing, so omitted detail is recoverable.
 */
export function buildHardEpochSeedView(
  messages: readonly FoldMessage[],
  seedPrompt: string,
): FoldMessage[] {
  const traceEnd = findRawHardEpochTraceEnd(messages);
  const liveTurnText = extractTrailingUserTurnText(messages, traceEnd);
  const seedBody = ensureHardEpochContinuityDirective(seedPrompt);
  const liveRequestAlreadyBundled = seedBody.includes(LIVE_CONTINUITY_STATE_HEADER)
    && seedBody.includes('active request (');
  const content = liveTurnText && !liveRequestAlreadyBundled
    ? `${seedBody}\n\n${HARD_EPOCH_LIVE_TURN_HEADER}\n${liveTurnText}`
    : seedBody;
  return [{ role: 'user', content }];
}

function ensureHardEpochContinuityDirective(seedPrompt: string): string {
  return seedPrompt.trimStart().startsWith(HARD_EPOCH_CONTINUITY_DIRECTIVE)
    ? seedPrompt
    : `${HARD_EPOCH_CONTINUITY_DIRECTIVE}\n\n${seedPrompt}`;
}

/**
 * Collect the text of the trailing contiguous run of `user` messages (the live
 * turn). At the compaction seam — before the provider call — this is normally
 * just the single just-pushed user message. Stops at the first non-user message
 * scanning from the end; skips non-string content parts.
 */
function extractTrailingUserTurnText(messages: readonly FoldMessage[], traceEnd: number): string {
  const parts: string[] = [];
  const lowerBound = traceEnd < messages.length ? traceEnd : findTrailingUserRunStart(messages);
  for (let i = messages.length - 1; i >= lowerBound; i--) {
    const message = messages[i];
    if (message.role !== 'user') break;
    if (typeof message.content === 'string' && message.content.trim()) {
      parts.unshift(message.content);
    }
  }
  return parts.join('\n\n').trim();
}

function findTrailingUserRunStart(messages: readonly FoldMessage[]): number {
  let i = messages.length;
  while (i > 0 && messages[i - 1]?.role === 'user') i -= 1;
  return i;
}

function findRawHardEpochTraceEnd(messages: readonly FoldMessage[]): number {
  return findRawRebirthSeedTraceEnd(messages, false);
}

export interface FoldFreezeSealedBandMetadata {
  /** View index where the stable prefix ends and this folded tail band begins. */
  sealedPrefixMessageCount: number;
  /** Char count of the stable prefix before the tail band was appended. */
  sealedPrefixChars: number;
  /** Inclusive start / exclusive end indices in the current frozen view. */
  bandStartViewIndex: number;
  bandEndViewIndex: number;
  /** Folded message count and char size for the appended band. */
  bandViewCount: number;
  bandViewChars: number;
  /** Raw tail size before folding, and realized append-band reduction. */
  rawTailChars?: number;
  savedChars?: number;
  shrinkRatio?: number;
  commitReason?: FoldFreezeAppendCommitReason;
  /** Inclusive start / exclusive end raw-history indices covered by the band. */
  rawStartIndex: number;
  rawEndIndex: number;
  rawCount: number;
  /** Boundary identity after the append transition. */
  boundaryRole: string;
  boundaryChars: number;
  boundaryHash?: string;
  /** Caller-supplied epoch ms for diagnostics only; identity comes from bytes. */
  createdAt: number;
}

export interface FoldFreezeState {
  /** Frozen pipeline output covering raw history [0..frozenRawCount). Null until first epoch. */
  frozenView: FoldMessage[] | null;
  /** Char size of frozenView (telemetry). */
  frozenViewChars: number;
  /** Message count at the last append-only sealed-boundary split, if this epoch appended a tail band. */
  lastAppendBoundaryViewCount?: number;
  /** Deterministic metadata for append-only sealed bands in this freeze epoch. */
  sealedBands: readonly FoldFreezeSealedBandMetadata[];
  /** Number of raw history messages the frozen view was computed from. */
  frozenRawCount: number;
  /** Role of raw[frozenRawCount-1] at freeze time (integrity fingerprint). */
  boundaryRole: string;
  /** Char count of raw[frozenRawCount-1] at freeze time (integrity fingerprint). */
  boundaryChars: number;
  /** FNV-1a 32-bit whole-message hash of the boundary at freeze time (role + content + reasoning_content + tool_calls). Catches same-length in-place rewrites that role+charCount miss. Undefined (empty-history freeze) = skip hash check. */
  boundaryHash?: string;
  /** Thinning mode at freeze time — any change forces an epoch (rare, user-driven). */
  thinningMode: string;
  /**
   * Normalized tool-arg paths present in the covered raw history at freeze
   * time. A file claim is RELEVANT to this freeze iff its normalized path is
   * in this set — only relevant claims can change the fold's output.
   */
  frozenToolPaths: ReadonlySet<string>;
  /** Normalized claimed paths that were relevant (∩ frozenToolPaths) at freeze time. */
  frozenRelevantClaims: ReadonlySet<string>;
  /** Epoch ms of the most recent applyCompaction call while folding was on. */
  lastCallAt: number;
  /** Consecutive hot reuses since the last epoch (telemetry). */
  hotReuses: number;
  /** Lifetime epoch count — hard epochs AND tail epochs (telemetry). */
  epochs: number;
  /** Last state transition reason, including hot reuse and append-only growth. */
  lastTransitionReason?: FoldFreezeTransitionReason;
  /** Last hard-epoch (whole-view rebuild) cause; append-only tail epochs do not overwrite it. */
  lastHardEpochReason?: FoldFreezeHardEpochCause;
  /**
   * One-shot bypass set by rebirth fold-state restoration: when true, the
   * next evaluateFoldFreeze call skips boundary/hash validation and trusts the
   * restored frozen view as-is (accepting the tail from current raw history).
   * It still honors maxTailChars: an oversized restored tail forces a
   * 'restored-overcap' hard epoch + eviction (NOT an append-only tail
   * epoch, which would preserve the bloated rebirth/fork prefix). Cleared
   * after that single evaluation regardless of outcome — normal boundary
   * checking resumes immediately. This lets the reborn session reuse the
   * predecessor's cached prefix bytes without a cold-start epoch.
   */
  forceAcceptRestoredView?: boolean;
  /**
   * Vault row fingerprints already sealed into the frozen view (the full
   * render baked at the last hard epoch + every per-band delta since).
   * Cleared on each hard epoch, mirroring sealedBands resetting — so a
   * row seals into exactly one band per freeze generation. Serialized so it
   * survives rebirth: without it, a reborn session would see an empty set
   * and re-bake rows already in the restored frozen prefix → duplication.
   */
  sealedVaultFingerprints: Set<string>;
}

export function createFoldFreezeState(): FoldFreezeState {
  return {
    frozenView: null,
    frozenViewChars: 0,
    lastAppendBoundaryViewCount: undefined,
    sealedBands: [],
    frozenRawCount: 0,
    boundaryRole: '',
    boundaryChars: 0,
    thinningMode: '',
    frozenToolPaths: new Set(),
    frozenRelevantClaims: new Set(),
    lastCallAt: 0,
    hotReuses: 0,
    epochs: 0,
    lastTransitionReason: undefined,
    lastHardEpochReason: undefined,
    sealedVaultFingerprints: new Set(),
  };
}

export interface SerializedFoldFreezeState {
  version: 1;
  frozenView: FoldMessage[] | null;
  frozenViewChars: number;
  lastAppendBoundaryViewCount?: number;
  sealedBands: FoldFreezeSealedBandMetadata[];
  frozenRawCount: number;
  boundaryRole: string;
  boundaryChars: number;
  boundaryHash?: string;
  thinningMode: string;
  frozenToolPaths: string[];
  frozenRelevantClaims: string[];
  lastCallAt: number;
  hotReuses: number;
  epochs: number;
  lastTransitionReason?: FoldFreezeTransitionReason;
  lastHardEpochReason?: FoldFreezeHardEpochCause;
  /**
   * Legacy pre-two-epoch-law field name for lastHardEpochReason. Read-compat
   * only: restoreFoldFreezeState accepts it when lastHardEpochReason is
   * absent; serializeFoldFreezeState never writes it.
   */
  lastFullRecomputeReason?: FoldFreezeHardEpochCause;
  forceAcceptRestoredView?: boolean;
  /** Serialized form of sealedVaultFingerprints; defaults to [] for back-compat. */
  sealedVaultFingerprints?: string[];
}

export interface FoldFreezeBoundaryMetadata {
  rawIndex: number | null;
  role: string;
  chars: number;
  hash?: string;
}

export interface FoldFreezeStateMetadata {
  hasFrozenView: boolean;
  frozenViewChars: number;
  frozenRawCount: number;
  rawFrontierIndex: number;
  sealedBoundaryViewCount: number | null;
  sealedBands: readonly FoldFreezeSealedBandMetadata[];
  boundary: FoldFreezeBoundaryMetadata;
  cache: {
    lastCallAt: number;
    hotReuses: number;
    epochs: number;
    lastTransitionReason?: FoldFreezeTransitionReason;
    lastHardEpochReason?: FoldFreezeHardEpochCause;
  };
  hardEpochCauses: readonly FoldFreezeHardEpochCause[];
}

export function serializeFoldFreezeState(state: FoldFreezeState): SerializedFoldFreezeState {
  return {
    version: 1,
    frozenView: state.frozenView ? state.frozenView.slice() : null,
    frozenViewChars: state.frozenViewChars,
    lastAppendBoundaryViewCount: state.lastAppendBoundaryViewCount,
    sealedBands: state.sealedBands.map((band) => ({ ...band })),
    frozenRawCount: state.frozenRawCount,
    boundaryRole: state.boundaryRole,
    boundaryChars: state.boundaryChars,
    boundaryHash: state.boundaryHash,
    thinningMode: state.thinningMode,
    frozenToolPaths: Array.from(state.frozenToolPaths).sort(),
    frozenRelevantClaims: Array.from(state.frozenRelevantClaims).sort(),
    lastCallAt: state.lastCallAt,
    hotReuses: state.hotReuses,
    epochs: state.epochs,
    lastTransitionReason: state.lastTransitionReason,
    lastHardEpochReason: state.lastHardEpochReason,
    forceAcceptRestoredView: state.forceAcceptRestoredView,
    sealedVaultFingerprints: Array.from(state.sealedVaultFingerprints).sort(),
  };
}

export function restoreFoldFreezeState(snapshot: SerializedFoldFreezeState): FoldFreezeState {
  return {
    frozenView: snapshot.frozenView ? snapshot.frozenView.slice() : null,
    frozenViewChars: snapshot.frozenViewChars,
    lastAppendBoundaryViewCount: snapshot.lastAppendBoundaryViewCount,
    sealedBands: snapshot.sealedBands.map((band) => ({ ...band })),
    frozenRawCount: snapshot.frozenRawCount,
    boundaryRole: snapshot.boundaryRole,
    boundaryChars: snapshot.boundaryChars,
    boundaryHash: snapshot.boundaryHash,
    thinningMode: snapshot.thinningMode,
    frozenToolPaths: new Set(snapshot.frozenToolPaths),
    frozenRelevantClaims: new Set(snapshot.frozenRelevantClaims),
    lastCallAt: snapshot.lastCallAt,
    hotReuses: snapshot.hotReuses,
    epochs: snapshot.epochs,
    lastTransitionReason: snapshot.lastTransitionReason,
    // Legacy read compat: pre-rename snapshots carry lastFullRecomputeReason.
    lastHardEpochReason: snapshot.lastHardEpochReason ?? snapshot.lastFullRecomputeReason,
    forceAcceptRestoredView: snapshot.forceAcceptRestoredView,
    sealedVaultFingerprints: new Set(snapshot.sealedVaultFingerprints ?? []),
  };
}

export function getFoldFreezeMetadata(state: FoldFreezeState): FoldFreezeStateMetadata {
  return {
    hasFrozenView: state.frozenView !== null,
    frozenViewChars: state.frozenViewChars,
    frozenRawCount: state.frozenRawCount,
    rawFrontierIndex: state.frozenRawCount,
    sealedBoundaryViewCount: state.lastAppendBoundaryViewCount ?? null,
    sealedBands: state.sealedBands.map((band) => ({ ...band })),
    boundary: {
      rawIndex: state.frozenRawCount > 0 ? state.frozenRawCount - 1 : null,
      role: state.boundaryRole,
      chars: state.boundaryChars,
      hash: state.boundaryHash,
    },
    cache: {
      lastCallAt: state.lastCallAt,
      hotReuses: state.hotReuses,
      epochs: state.epochs,
      lastTransitionReason: state.lastTransitionReason,
      lastHardEpochReason: state.lastHardEpochReason,
    },
    hardEpochCauses: FOLD_FREEZE_HARD_EPOCH_CAUSES,
  };
}

/** Per-band char summary for one sealed append-only tail-epoch band. */
export interface FoldFreezeBandCharSummary {
  /** 0-based band position, oldest first. */
  bandIndex: number;
  /** Folded chars this band contributes to the frozen view. */
  viewChars: number;
  /** Raw tail chars before folding produced this band, when known. */
  rawTailChars?: number;
  /** Chars saved by folding (rawTailChars - viewChars), when known. */
  savedChars?: number;
  /** viewChars / rawTailChars, when known. */
  shrinkRatio?: number;
}

/** Seed-base + per-band char decomposition of a frozen view (see summarizeFrozenBands). */
export interface FrozenBandsSummary {
  /**
   * Chars of the hard-epoch seed prefix that predates any append-only
   * tail-epoch bands. Equal to the full frozenViewChars when no bands have
   * been sealed yet (the whole frozen view IS the seed base).
   */
  seedBaseChars: number;
  /** Per-band char breakdown, oldest first. */
  bands: FoldFreezeBandCharSummary[];
}

/**
 * Decompose a fold-freeze state's frozen view into its hard-epoch seed base
 * and each append-only tail-epoch band's own char contribution. Pure, no I/O.
 * Invariant: seedBaseChars + sum(bands[].viewChars) === state.frozenViewChars.
 */
export function summarizeFrozenBands(state: FoldFreezeState): FrozenBandsSummary {
  const bands: FoldFreezeBandCharSummary[] = state.sealedBands.map((band, index) => ({
    bandIndex: index,
    viewChars: band.bandViewChars,
    rawTailChars: band.rawTailChars,
    savedChars: band.savedChars,
    shrinkRatio: band.shrinkRatio,
  }));
  const seedBaseChars =
    state.sealedBands.length > 0 ? state.sealedBands[0].sealedPrefixChars : state.frozenViewChars;
  return { seedBaseChars, bands };
}

/**
 * Session context the freeze decision depends on: the thinning mode (hard
 * epoch trigger on change) and the CURRENT global claimed-paths set (raw
 * claim keys; relevance-filtered against the frozen coverage internally).
 */
export interface FoldFreezeContext {
  thinningMode: string;
  claimedPaths: ReadonlySet<string>;
  /** Real provider/relay input-token telemetry only. Omit when unknown. */
  measuredInputTokens?: number;
}

// ══════════════════════════════════════════════════════════════════════
// Decision
// ══════════════════════════════════════════════════════════════════════

/**
 * Reason attached to an `action: 'recompute'` decision — the freeze cache
 * saying "the whole view must be rebuilt". Under the two-epoch law every
 * committed whole-view rebuild is a (seeded) HARD epoch, hence the alias.
 * Callers that can still band-append do so instead of committing this.
 */
export type FoldFreezeRecomputeReason = FoldFreezeHardEpochCause;

export type FoldFreezeDecision =
  | { action: 'reuse'; view: FoldMessage[]; tailChars: number; tailCount: number }
  | { action: 'recompute'; reason: FoldFreezeRecomputeReason; gapMs: number; detail?: string };

/**
 * Decide whether the frozen view can be reused byte-identical (hot path) or
 * the compaction pipeline must run (epoch). Pure function — mutates nothing;
 * the caller applies `touchFoldFreeze` on reuse or `commitFoldFreeze` after
 * recomputing.
 */
export function evaluateFoldFreeze(
  state: FoldFreezeState,
  history: FoldMessage[],
  context: FoldFreezeContext,
  now: number,
  config: FoldFreezeConfig,
): FoldFreezeDecision {
  const gapMs = state.lastCallAt > 0 ? Math.max(0, now - state.lastCallAt) : 0;

  if (!state.frozenView) {
    return { action: 'recompute', reason: 'first-call', gapMs };
  }

  // ── Rebirth fold-state restoration bypass ────────────────────────────
  // When a session rebirths with a restored fold-freeze state (same engine +
  // model, fold on), the seed messages that birth-fold hydration pours in have
  // different byte-level formatting than the predecessor's live raw history.
  // The boundary checks below would reject them (boundary-mismatch), forcing a
  // cold-start first-call epoch and burning the provider cache. Instead, trust
  // the restored frozen view for exactly one evaluation: accept the tail from
  // current raw history and reuse the predecessor's frozen prefix bytes. This
  // is the mechanism that lets the cache survive the rebirth boundary.
  //
  // Safety: one-shot — the flag is cleared regardless of outcome. If raw
  // history doesn't even cover the frozen range, fall through to the normal
  // first-call path (the session must build a fresh epoch).
  if (state.forceAcceptRestoredView) {
    state.forceAcceptRestoredView = false;
    if (state.frozenView && history.length >= state.frozenRawCount) {
      const tail = history.slice(state.frozenRawCount);
      const tailChars = tail.length > 0 ? countChars(tail) : 0;
      if (tailChars > config.maxTailChars) {
        // Distinct cause (NOT 'tail-epoch'): the append-only tail-epoch path
        // would seal and keep the oversized restored prefix. 'restored-overcap'
        // routes both callers through the whole-view hard epoch + eviction so
        // the bloated rebirth/fork prefix is rebuilt away instead of carried
        // forward.
        return { action: 'recompute', reason: 'restored-overcap', gapMs, detail: 'restored-tail-overcap' };
      }
      return {
        action: 'reuse',
        view: state.frozenView.concat(tail),
        tailChars,
        tailCount: tail.length,
      };
    }
    // Conditions not met — fall through to normal evaluation (will be
    // first-call since the boundary won't match the seed messages).
  }

  // Cache already expired → mutation is free. Strict >: a gap of exactly the
  // TTL is treated as hot (sliding TTLs persist "at least" their window).
  if (gapMs > config.ttlMs) {
    return { action: 'recompute', reason: 'cold-gap', gapMs };
  }
  if (context.thinningMode !== state.thinningMode) {
    return { action: 'recompute', reason: 'context-changed', gapMs, detail: 'thinning-mode' };
  }
  // Claims-relevance gate: only a NEWLY-relevant claim (normalized path is in
  // the frozen coverage's tool-path set, and was not already claimed at freeze
  // time) can change the fold's output — it must unfold promptly, so epoch.
  // Irrelevant claims (paths this session never touched) and releases of
  // relevant claims reuse safely; releases re-fold at the next natural epoch.
  // A claim matching only TAIL tool paths also reuses: the tail rides verbatim
  // (unfolded), and the next epoch folds it with the claim applied.
  for (const claimed of context.claimedPaths) {
    const normalized = normalizeToolPath(claimed);
    if (state.frozenToolPaths.has(normalized) && !state.frozenRelevantClaims.has(normalized)) {
      return { action: 'recompute', reason: 'context-changed', gapMs, detail: `claim ${normalized}` };
    }
  }
  if (history.length < state.frozenRawCount) {
    return { action: 'recompute', reason: 'history-rewound', gapMs };
  }
  if (state.frozenRawCount > 0) {
    const boundary = history[state.frozenRawCount - 1];
    if (
      !boundary ||
      boundary.role !== state.boundaryRole ||
      countChars([boundary]) !== state.boundaryChars
    ) {
      return { action: 'recompute', reason: 'boundary-mismatch', gapMs };
    }
    // Hash guard: catches same-length in-place rewrites (content, reasoning_content,
    // or tool_calls) that role+charCount miss. Back-compat: skip when
    // state.boundaryHash is undefined (empty-history freeze).
    if (state.boundaryHash !== undefined) {
      if (fnv1a32(boundaryFingerprintInput(boundary)) !== state.boundaryHash) {
        return { action: 'recompute', reason: 'boundary-mismatch', gapMs, detail: 'boundary-hash' };
      }
    }
  }

  const tail = history.slice(state.frozenRawCount);
  const tailChars = tail.length > 0 ? countChars(tail) : 0;
  // INVARIANT: the raw-tail char cap must ALWAYS fire — no measured-token floor,
  // no suppression. Append-only tail-epoch routing preserves the frozen prefix
  // byte-identical (cache-safe), so gating this protects nothing; a measured
  // floor here created a blind zone where a bursty tool result rode hot-reuse
  // from sub-floor measured input straight past the pressure ceiling with zero
  // tail epochs (nova-cobra, 2026-07-05). It must stay structurally impossible
  // to reach the hard-epoch ceiling with an over-cap raw tail still unfolded.
  if (tailChars > config.maxTailChars) {
    return { action: 'recompute', reason: 'tail-epoch', gapMs };
  }

  return {
    action: 'reuse',
    view: state.frozenView.concat(tail),
    tailChars,
    tailCount: tail.length,
  };
}

// ══════════════════════════════════════════════════════════════════════
// State transitions
// ══════════════════════════════════════════════════════════════════════

/** Record a hot reuse: refresh the sliding TTL window and bump telemetry. */
export function touchFoldFreeze(state: FoldFreezeState, now: number): void {
  state.lastCallAt = now;
  state.hotReuses += 1;
  state.lastTransitionReason = 'hot-reuse';
}

/**
 * Install a provider-visible frozen base without recording an epoch. This is
 * for a newborn/reborn session whose initial continuity package is already
 * compact: no history was folded and no tail band or hard reset occurred.
 */
export function initializeFoldFreezeBase(
  state: FoldFreezeState,
  history: FoldMessage[],
  view: FoldMessage[],
  context: FoldFreezeContext,
  now: number,
): void {
  const boundary = history.length > 0 ? history[history.length - 1] : undefined;
  state.frozenView = view.slice();
  state.frozenViewChars = countChars(view);
  state.lastAppendBoundaryViewCount = undefined;
  state.sealedBands = [];
  state.frozenRawCount = history.length;
  state.boundaryRole = boundary?.role ?? '';
  state.boundaryChars = boundary ? countChars([boundary]) : 0;
  state.boundaryHash = boundary ? fnv1a32(boundaryFingerprintInput(boundary)) : undefined;
  state.thinningMode = context.thinningMode;
  const toolPaths = extractToolPathSet(history);
  const relevant = new Set<string>();
  for (const claimed of context.claimedPaths) {
    const normalized = normalizeToolPath(claimed);
    if (toolPaths.has(normalized)) relevant.add(normalized);
  }
  state.frozenToolPaths = toolPaths;
  state.frozenRelevantClaims = relevant;
  state.lastCallAt = now;
  state.hotReuses = 0;
}

/**
 * Commit the HARD-epoch transition: capture a freshly rebuilt whole-view
 * pipeline output as the new frozen view (two-epoch law: the only non-tail
 * epoch type — session callers pair this rebuild with the rebirth seed).
 * Stores a shallow copy of the view array so later caller-side array
 * mutations (push/splice) can never corrupt the frozen bytes; element
 * references are shared, which is what makes hot-path prefix identity exact.
 */
export function commitFoldFreeze(
  state: FoldFreezeState,
  history: FoldMessage[],
  view: FoldMessage[],
  context: FoldFreezeContext,
  now: number,
  hardEpochCause: FoldFreezeHardEpochCause = 'first-call',
): void {
  initializeFoldFreezeBase(state, history, view, context, now);
  state.epochs += 1;
  state.lastTransitionReason = hardEpochCause;
  state.lastHardEpochReason = hardEpochCause;
}

/**
 * Append a freshly folded tail band without re-rendering the existing frozen
 * view. This is the cache-preserving tail-epoch transition: the old frozen
 * message objects remain the byte-identical prefix, and only the newly folded
 * tail band is concatenated behind them.
 */
export function appendFoldFreezeTailEpoch(
  state: FoldFreezeState,
  history: FoldMessage[],
  tailView: FoldMessage[],
  context: FoldFreezeContext,
  now: number,
): FoldFreezeAppendResult {
  if (!state.frozenView) {
    return {
      committed: false,
      view: null,
      sealedPrefixMessageCount: null,
      rawTailChars: 0,
      rawTailMessages: 0,
      bandViewChars: countChars(tailView),
      savedChars: 0,
      shrinkRatio: null,
      skipReason: 'missing-frozen-view',
    };
  }
  if (history.length < state.frozenRawCount) {
    return {
      committed: false,
      view: null,
      sealedPrefixMessageCount: state.frozenView.length,
      rawTailChars: 0,
      rawTailMessages: 0,
      bandViewChars: countChars(tailView),
      savedChars: 0,
      shrinkRatio: null,
      skipReason: 'history-rewound',
    };
  }

  const sealedPrefixMessageCount = state.frozenView.length;
  const sealedPrefixChars = state.frozenViewChars;
  const rawStartIndex = state.frozenRawCount;
  const rawTail = history.slice(rawStartIndex);
  const rawTailChars = rawTail.length > 0 ? countChars(rawTail) : 0;
  const rawTailMessages = rawTail.length;
  const bandViewChars = countChars(tailView);
  const savedChars = rawTailChars - bandViewChars;
  const shrinkRatio = rawTailChars > 0 ? bandViewChars / rawTailChars : null;
  if (rawTailChars <= 0) {
    return {
      committed: false,
      view: state.frozenView.concat(rawTail),
      sealedPrefixMessageCount,
      rawTailChars,
      rawTailMessages,
      bandViewChars,
      savedChars,
      shrinkRatio,
      skipReason: 'empty-tail',
    };
  }
  if (savedChars <= 0 || shrinkRatio === null || shrinkRatio > APPEND_TAIL_MIN_SHRINK_RATIO) {
    return {
      committed: false,
      view: state.frozenView.concat(rawTail),
      sealedPrefixMessageCount,
      rawTailChars,
      rawTailMessages,
      bandViewChars,
      savedChars,
      shrinkRatio,
      skipReason: 'not-smaller',
    };
  }

  const view = state.frozenView.concat(tailView);
  const boundary = history.length > 0 ? history[history.length - 1] : undefined;
  const boundaryHash = boundary ? fnv1a32(boundaryFingerprintInput(boundary)) : undefined;
  const band: FoldFreezeSealedBandMetadata = {
    sealedPrefixMessageCount,
    sealedPrefixChars,
    bandStartViewIndex: sealedPrefixMessageCount,
    bandEndViewIndex: view.length,
    bandViewCount: tailView.length,
    bandViewChars,
    rawTailChars,
    savedChars,
    shrinkRatio,
    commitReason: 'material-shrink',
    rawStartIndex,
    rawEndIndex: history.length,
    rawCount: rawTailMessages,
    boundaryRole: boundary?.role ?? '',
    boundaryChars: boundary ? countChars([boundary]) : 0,
    boundaryHash,
    createdAt: now,
  };

  state.frozenView = view.slice();
  state.frozenViewChars = countChars(view);
  state.lastAppendBoundaryViewCount = sealedPrefixMessageCount;
  state.sealedBands = state.sealedBands.concat(band);
  state.frozenRawCount = history.length;
  state.boundaryRole = boundary?.role ?? '';
  state.boundaryChars = boundary ? countChars([boundary]) : 0;
  state.boundaryHash = boundaryHash;
  state.thinningMode = context.thinningMode;

  const toolPaths = extractToolPathSet(history);
  const relevant = new Set<string>();
  for (const claimed of context.claimedPaths) {
    const normalized = normalizeToolPath(claimed);
    if (toolPaths.has(normalized)) relevant.add(normalized);
  }
  state.frozenToolPaths = toolPaths;
  state.frozenRelevantClaims = relevant;
  state.lastCallAt = now;
  state.hotReuses = 0;
  state.epochs += 1;
  state.lastTransitionReason = 'append-tail-epoch';

  return {
    committed: true,
    view,
    sealedPrefixMessageCount,
    rawTailChars,
    rawTailMessages,
    bandViewChars,
    savedChars,
    shrinkRatio,
    commitReason: 'material-shrink',
  };
}
