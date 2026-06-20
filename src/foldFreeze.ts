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

export type FoldFreezeFullRecomputeCause =
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
  // restored overcap through full recompute + eviction instead.
  | 'restored-overcap'
  | 'pressure-ceiling'
  | 'prefix-saturation';

export type FoldFreezeTransitionReason =
  | FoldFreezeFullRecomputeCause
  | 'hot-reuse'
  | 'append-tail-epoch';

export const FOLD_FREEZE_FULL_RECOMPUTE_CAUSES: readonly FoldFreezeFullRecomputeCause[] = [
  'first-call',
  'cold-gap',
  'context-changed',
  'history-rewound',
  'boundary-mismatch',
  'tail-epoch',
  'restored-overcap',
  'pressure-ceiling',
  'prefix-saturation',
];

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
  /** Lifetime epoch (recompute) count (telemetry). */
  epochs: number;
  /** Last state transition reason, including hot reuse and append-only growth. */
  lastTransitionReason?: FoldFreezeTransitionReason;
  /** Last full-recompute cause; append-only tail epochs do not overwrite it. */
  lastFullRecomputeReason?: FoldFreezeFullRecomputeCause;
  /**
   * One-shot bypass set by rebirth fold-state restoration: when true, the
   * next evaluateFoldFreeze call skips boundary/hash validation and trusts the
   * restored frozen view as-is (accepting the tail from current raw history).
   * It still honors maxTailChars: an oversized restored tail forces a
   * 'restored-overcap' full recompute + eviction (NOT an append-only tail
   * epoch, which would preserve the bloated rebirth/fork prefix). Cleared
   * after that single evaluation regardless of outcome — normal boundary
   * checking resumes immediately. This lets the reborn session reuse the
   * predecessor's cached prefix bytes without a cold-start epoch.
   */
  forceAcceptRestoredView?: boolean;
  /**
   * Vault row fingerprints already sealed into the frozen view (the full
   * render baked at the last full recompute + every per-band delta since).
   * Cleared on each full recompute, mirroring sealedBands resetting — so a
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
    lastFullRecomputeReason: undefined,
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
  lastFullRecomputeReason?: FoldFreezeFullRecomputeCause;
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
    lastFullRecomputeReason?: FoldFreezeFullRecomputeCause;
  };
  fullRecomputeCauses: readonly FoldFreezeFullRecomputeCause[];
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
    lastFullRecomputeReason: state.lastFullRecomputeReason,
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
    lastFullRecomputeReason: snapshot.lastFullRecomputeReason,
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
      lastFullRecomputeReason: state.lastFullRecomputeReason,
    },
    fullRecomputeCauses: FOLD_FREEZE_FULL_RECOMPUTE_CAUSES,
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

export type FoldFreezeRecomputeReason = FoldFreezeFullRecomputeCause;

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
        // routes both callers through full recompute + eviction so the bloated
        // rebirth/fork prefix is recomputed away instead of carried forward.
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
  recomputeReason: FoldFreezeFullRecomputeCause = 'first-call',
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
  state.lastTransitionReason = recomputeReason;
  state.lastFullRecomputeReason = recomputeReason;
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
): { view: FoldMessage[]; sealedPrefixMessageCount: number } | null {
  if (!state.frozenView) return null;
  if (history.length < state.frozenRawCount) return null;

  const sealedPrefixMessageCount = state.frozenView.length;
  const sealedPrefixChars = state.frozenViewChars;
  const rawStartIndex = state.frozenRawCount;
  const view = state.frozenView.concat(tailView);
  const boundary = history.length > 0 ? history[history.length - 1] : undefined;
  const boundaryHash = boundary ? fnv1a32(boundaryFingerprintInput(boundary)) : undefined;
  const band: FoldFreezeSealedBandMetadata = {
    sealedPrefixMessageCount,
    sealedPrefixChars,
    bandStartViewIndex: sealedPrefixMessageCount,
    bandEndViewIndex: view.length,
    bandViewCount: tailView.length,
    bandViewChars: countChars(tailView),
    rawStartIndex,
    rawEndIndex: history.length,
    rawCount: Math.max(0, history.length - rawStartIndex),
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

  return { view, sealedPrefixMessageCount };
}
