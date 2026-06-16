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
 *     this session never touched — the dominant multi-agent case under a
 *     shared claims set, where unrelated claims used to epoch every fold-on
 *     session — reuse safely. Releases of relevant claims also reuse: the
 *     affected content stays unfolded (correct, just briefly unoptimized) until
 *     the next natural epoch re-folds it.
 *   - `history-rewound` / `boundary-mismatch`: the raw history no longer
 *     extends the frozen coverage (resume artifacts, truncation, in-place
 *     rewrites). Self-healing: recompute from current raw truth.
 *
 * Net effect: the fold's quality machinery (graduated assistant-text budget,
 * sequence collapsing, and claimed-path unfolds) is
 * untouched — it simply fires in PULSES at epoch boundaries instead of on
 * every call. Between pulses the request stream is append-only and the
 * provider cache stays hot. A pleasant side effect: recent turns stay
 * verbatim throughout a hot streak (the fold boundary doesn't advance), which
 * softens the activeWindowTurns=1 "big result last turn" trade-off most of
 * the time.
 *
 * Engine-agnostic: lives at the "prepare the messages before the provider call"
 * seam, so any function-calling loop can reuse it. Pure CPU, zero I/O, no
 * timers — event-loop safe by construction. State lives on the session object
 * and resets naturally with a new session.
 *
 * Kill switch: WARP_FOLD_FREEZE=0 reverts to per-call recompute (the
 * pre-freeze always-on behavior). TTL and tail cap are env-tunable; callers may
 * also provide model-aware defaults so the hot-tail sawtooth tracks the fold
 * target band unless explicitly overridden.
 */

import { countChars, extractToolPathSet, normalizeToolPath, type FoldMessage } from './rollingFold.ts';

// ══════════════════════════════════════════════════════════════════════
// Config
// ══════════════════════════════════════════════════════════════════════

export interface FoldFreezeConfig {
  /** Master switch. When false, applyCompaction recomputes per call (legacy behavior). */
  enabled: boolean;
  /**
   * Provider prompt-cache TTL in ms. A gap between calls larger than this
   * means the cache entry has expired and recomputing the fold is free.
   * Anthropic ephemeral: sliding 5m, or 1h when the caller explicitly uses
   * extended-TTL cache controls. OpenAI automatic: ~5-10m idle eviction.
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
 *   WARP_FOLD_FREEZE=0|false|off|no      → disable (legacy per-call recompute)
 *   WARP_FOLD_FREEZE_TTL_MS=<ms>          → override cache TTL
 *   WARP_FOLD_FREEZE_MAX_TAIL_CHARS=<n>   → override raw overhang cap
 *
 * `defaults.ttlMs` lets a session inject its PROVIDER's actual cache TTL
 * (e.g. a caller using 1h Anthropic cache controls passes 3_600_000) so the
 * cold-gap epoch doesn't refold against a still-warm cache: with a 1h
 * provider cache, a 20-minute gap is NOT free to refold — a 5m assumption
 * would bust the very cache entries the 1h TTL paid extra to keep.
 * Precedence: explicit env override > session default > builtin.
 */
export function resolveFoldFreezeConfig(
  env: Record<string, string | undefined> = process.env,
  defaults?: { ttlMs?: number; maxTailChars?: number },
): FoldFreezeConfig {
  const raw = (env.WARP_FOLD_FREEZE ?? '').trim().toLowerCase();
  const enabled = raw === '' || (raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no');
  return {
    enabled,
    ttlMs: parsePositiveInt(env.WARP_FOLD_FREEZE_TTL_MS) ?? defaults?.ttlMs ?? DEFAULT_FOLD_FREEZE_CONFIG.ttlMs,
    maxTailChars:
      parsePositiveInt(env.WARP_FOLD_FREEZE_MAX_TAIL_CHARS)
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

export interface FoldFreezeState {
  /** Frozen pipeline output covering raw history [0..frozenRawCount). Null until first epoch. */
  frozenView: FoldMessage[] | null;
  /** Char size of frozenView (telemetry). */
  frozenViewChars: number;
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
  /** Lifetime epoch (recompute) count (telemetry). */
  epochs: number;
}

export function createFoldFreezeState(): FoldFreezeState {
  return {
    frozenView: null,
    frozenViewChars: 0,
    frozenRawCount: 0,
    boundaryRole: '',
    boundaryChars: 0,
    thinningMode: '',
    frozenToolPaths: new Set(),
    frozenRelevantClaims: new Set(),
    lastCallAt: 0,
    hotReuses: 0,
    epochs: 0,
  };
}

/**
 * Session context the freeze decision depends on: the thinning mode (hard
 * epoch trigger on change) and the CURRENT global claimed-paths set (raw
 * claim keys; relevance-filtered against the frozen coverage internally).
 */
export interface FoldFreezeContext {
  thinningMode: string;
  claimedPaths: ReadonlySet<string>;
}

// ══════════════════════════════════════════════════════════════════════
// Decision
// ══════════════════════════════════════════════════════════════════════

export type FoldFreezeRecomputeReason =
  | 'first-call'
  | 'cold-gap'
  | 'context-changed'
  | 'history-rewound'
  | 'boundary-mismatch'
  | 'tail-epoch';

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
}

/**
 * Capture a freshly recomputed pipeline output as the new frozen view.
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
): void {
  const boundary = history.length > 0 ? history[history.length - 1] : undefined;
  state.frozenView = view.slice();
  state.frozenViewChars = countChars(view);
  state.frozenRawCount = history.length;
  state.boundaryRole = boundary?.role ?? '';
  state.boundaryChars = boundary ? countChars([boundary]) : 0;
  state.boundaryHash = boundary ? fnv1a32(boundaryFingerprintInput(boundary)) : undefined;
  state.thinningMode = context.thinningMode;
  // Index the covered history's tool-arg paths and the subset of current
  // claims that are relevant to them. Pure CPU over tool_use input args
  // (no content scans); runs only at epochs.
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
}
