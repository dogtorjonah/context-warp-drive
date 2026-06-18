/**
 * Overwatch — a standalone, trace-driven context-warp governor.
 *
 * WHY THIS EXISTS
 * ---------------
 * The relay's `contextWarpGovernor.ts` infers a "phase" from the single last
 * tool name and pulls signals out of relay internals (touchedPaths, claimedPaths,
 * thrashEvents, wave/rail state). That has two structural problems:
 *
 *   1. Phase flapping. Phase is a *slow* variable (an agent reviews for many
 *      boundaries) sampled from a *high-frequency noisy proxy* (last tool). A
 *      reviewer running `task_rail` acks gets mislabeled `handoff`; holding a file
 *      claim gets mislabeled `implementation`. The label oscillates and the knobs
 *      (band width, recall aperture) jitter with it — busting the prefix cache.
 *
 *   2. Relay coupling. Reading wave/rail/claim subsystem state on the tool
 *      boundary risks sync I/O on the event loop (GOD RULE 2) and makes the
 *      governor impossible to port to another runtime.
 *
 * THE FIX (this module)
 * ---------------------
 * Overwatch is a PURE FUNCTION over a trace window. Its only inputs are:
 *   - a window of {@link TraceToken}s (tool classes + lifted path args + register
 *     glyphs the agent already emits), windowed in TOOL-TICK space (never turns),
 *   - one measured-pressure scalar (provider tokens only — GOD RULE 7),
 *   - the prior band, for continuity.
 *
 * The governor fires once per tool boundary, so the *tool tick* — not the turn —
 * is the clock. Glyphs fire ~once per turn (sparse), so in a 150-tool single-turn
 * marathon rail the agent emits one 🔍 at tick 0 and grinds 150 ticks. Glyphs are
 * therefore DEMOTED to decaying checkpoints, not the heartbeat:
 *
 *   - Tool histogram + measured pressure = the dense clock (always available).
 *   - Glyphs = declared impulses that DECAY over ticks (A·λ^ticksSince). By the
 *     middle of a marathon the front glyph's impulse ≈ 0 and the histogram owns
 *     the decision — automatic, correct degradation.
 *   - task_rail ack_status = a MICRO pseudo-glyph emitter: dense, declared in the
 *     trace itself (no subsystem call), it keeps the grammar fed precisely where
 *     macro glyphs go dark.
 *
 * Two layers, strictly separated: GRAMMAR PROPOSES, ECONOMICS DISPOSES.
 *   - Intent layer (flavor + glyph impulses) proposes a knob direction.
 *   - Cost layer ({@link breakevenAllowsShrink}) vetoes any band shrink that does
 *     not clear the cache-rewrite breakeven. A cache bust that doesn't materially
 *     shrink carried tokens is pure loss.
 *
 * Every decision carries a human-readable {@link OverwatchDecision.derivation} so
 * "is the governor tuning correctly?" is a dashboard, not a feeling.
 *
 * This module imports ONLY from ./glyphs.ts (same portable package). It has zero
 * relay coupling and is trivially unit-testable. The relay (or any runtime) writes
 * a thin adapter that maps its trace → TraceToken[] and calls {@link governByTrace}.
 */

import { parseRegisterGlyph, type AssistantRegister } from './glyphs.ts';

// ── Alphabet ────────────────────────────────────────────────────────────────

/** Macro tier: the register glyphs an agent declares per message. */
export type OverwatchGlyph = 'working' | 'executing' | 'verdict' | 'hazard' | 'blocked';

/** Normalized tool families. Ambient classes (rail/chat/wave/meta) are excluded
 *  from flavor classification but rail acks still feed the micro tier. */
export type OverwatchToolClass =
  | 'read'
  | 'search'
  | 'edit'
  | 'write'
  | 'bash'
  | 'test'
  | 'git'
  | 'logs'
  | 'recall'
  | 'rail'
  | 'chat'
  | 'wave'
  | 'meta'
  | 'other';

/** Micro tier: declared rail step transitions, present in `task_rail` tool args. */
export type RailAck = 'needs_review' | 'done' | 'blocked' | 'in_progress' | null;

/**
 * One observable event in the trace window. `msg` tokens carry a register glyph;
 * `tool` tokens carry a tool class, optionally lifted path args, and (for rail
 * tools) the declared ack status. The caller produces these from whatever trace
 * it holds — see {@link classifyToolClass} / {@link glyphFromMessage} adapters.
 */
export interface TraceToken {
  readonly kind: 'msg' | 'tool';
  /** msg only — parsed register glyph (undefined when the message was non-compliant). */
  readonly glyph?: OverwatchGlyph;
  /** tool only — normalized family. */
  readonly toolClass?: OverwatchToolClass;
  /** tool only — file paths lifted from tool args (for thrash/churn, pure-trace). */
  readonly pathArgs?: readonly string[];
  /** tool only, when toolClass==='rail' — declared step transition. */
  readonly railAck?: RailAck;
}

/** Measured cache evidence from a host runtime, when available. */
export interface OverwatchCacheTelemetry {
  /** Hot prefix-cache reuses observed in the current frozen epoch. */
  readonly hotReuses: number;
  /** Fold-freeze epoch counter observed by the host runtime. */
  readonly epochs: number;
}

/** The one irreducible scalar that cannot come from the trace (GOD RULE 7). */
export interface OverwatchPressure {
  /** Provider-measured input tokens. <=0 means unknown. */
  readonly measuredTokens: number;
  /** Configured context window size. <=0 means unknown. */
  readonly windowTokens: number;
  /** Optional measured cache-hit evidence for the breakeven gate. */
  readonly cache?: OverwatchCacheTelemetry;
  /** Provider/request message ceiling from the host budget resolver, if tighter than the window. */
  readonly messageCeilingTokens?: number | null;
  /** Pressure ceiling from contextBudget/relay telemetry, if configured. */
  readonly pressureCeilingTokens?: number | null;
  /** Prefix-saturation backstop, measured/configured by the host; never derived from chars. */
  readonly prefixSaturationTokens?: number | null;
  /** Measured rolling next-call burst reserve, or a configured host fallback. */
  readonly burstReserveTokens?: number | null;
  /** Host-configured safety runway below the burst reserve. */
  readonly safetyMarginTokens?: number | null;
  /** Optional measured frozen-prefix tokens; unknown stays null/undefined. */
  readonly frozenPrefixTokens?: number | null;
  /** Optional measured raw-tail tokens; unknown stays null/undefined. */
  readonly rawTailTokens?: number | null;
}

export type OverwatchPressureLevel =
  | 'unknown'
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'auto_compact';

export type OverwatchPressureAction =
  | 'hold'
  | 'normal_append'
  | 'pressure_tail_append'
  | 'suffix_compact'
  | 'full_recompute_evict';

export interface OverwatchPressureActionRec {
  readonly action: OverwatchPressureAction;
  readonly reason: string;
  readonly noProviderCallWithoutRelief: boolean;
  readonly ceilingTokens: number | null;
  readonly warnAtTokens: number | null;
  readonly hardAtTokens: number | null;
  readonly burstReserveTokens: number | null;
  readonly safetyMarginTokens: number | null;
}

/**
 * Work flavor — what KIND of work the window shows. This is the histogram-derived
 * baseline (the dense floor), distinct from the glyph impulses that modulate it.
 * `planning` is the GENEROUS default (asymmetry fix): an unclassifiable window is
 * NOT aggressively starved — it holds the prior band.
 */
export type OverwatchFlavor =
  | 'investigation'
  | 'implementation'
  | 'debugging'
  | 'review'
  | 'marathon'
  | 'recovery'
  | 'planning';

export interface OverwatchRecallRec {
  readonly maxCards: number;
  readonly maxTotalChars: number;
  readonly ttlPasses: number;
  readonly enableTerms: boolean;
}

export interface OverwatchEpisodicRec {
  readonly inject: boolean;
  readonly fire: boolean;
  /** Bias episodic capture up when a hazard was just declared. */
  readonly captureBias: number;
}

export interface OverwatchFreezeRec {
  /** epoch = rebuild the prefix cache; reuse = preserve the hot prefix. */
  readonly action: 'reuse' | 'epoch' | 'defer';
  readonly reason: string;
}

/**
 * Fidelity ratios — what percentage of the fold band stays at each retention
 * tier. These are the quality-driven levers (as opposed to the cost-driven
 * band-size lever). The governor adjusts them based on glyph grammar
 * transitions: when the agent is thriving (rapid verdicts), it can afford
 * less verbatim history; when struggling (blocked, thrash), it needs more.
 *
 * null = no recommendation (hold prior). Same pattern as {@link OverwatchDecision.bandTokens}.
 */
export interface FidelityRatios {
  /** Fraction of bandChars for full-fidelity assistant text. Default 0.125 (12.5%). */
  readonly fullRetentionFraction: number;
  /** Fraction of bandChars for essence-extracted text. Default 0.25 (25%). */
  readonly essenceRetentionFraction: number;
}

/** Default fidelity ratios matching the hardcoded fold-budget constants. */
export const DEFAULT_FIDELITY_RATIOS: FidelityRatios = {
  fullRetentionFraction: 0.125,
  essenceRetentionFraction: 0.25,
};

/** Breakdown of the decaying impulses at the current tick — the trust artifact. */
export interface OverwatchImpulses {
  readonly tighten: number;
  readonly widenRecall: number;
  readonly hold: number;
  readonly captureHazard: number;
}

export interface OverwatchDecision {
  readonly flavor: OverwatchFlavor;
  readonly pressure: {
    readonly level: OverwatchPressureLevel;
    readonly utilization: number | null;
    readonly measuredTokens: number | null;
    readonly windowTokens: number | null;
    readonly ceilingTokens: number | null;
    readonly warnAtTokens: number | null;
    readonly hardAtTokens: number | null;
  };
  readonly pressureAction: OverwatchPressureActionRec;
  /** Recommended retained-history band. null = no change (hold prior). */
  readonly bandTokens: number | null;
  /** Recommended fidelity ratios (quality-driven). null = no change (hold prior). */
  readonly fidelity: FidelityRatios | null;
  readonly recall: OverwatchRecallRec;
  readonly episodic: OverwatchEpisodicRec;
  readonly freeze: OverwatchFreezeRec;
  /** True when the window carried at least one macro register glyph. */
  readonly glyphsPresent: boolean;
  /** True when glyphs are stale (a long tool run since the last glyph). */
  readonly marathon: boolean;
  readonly impulses: OverwatchImpulses;
  /** Pure-trace behavioral signals. */
  readonly signals: {
    readonly thrash: number;
    readonly pathChurn: number;
    readonly ticksSinceLastGlyph: number | null;
    readonly toolTicks: number;
  };
  /** Human-readable, line-by-line derivation — verifiable against the trace. */
  readonly derivation: string[];
}

// ── Tunable constants (exported so tests and operators can argue with them) ───

export interface OverwatchConfig {
  /** Per-glyph impulse amplitudes (in knob-bias units). */
  readonly amplitude: Record<OverwatchGlyph, number>;
  /** Per-glyph geometric decay per tool tick (0..1). */
  readonly decay: Record<OverwatchGlyph, number>;
  /** Cadence-density damping coefficient (V→V streak self-damps). */
  readonly densityDamp: number;
  /** Micro-tier (rail-ack) amplitude as a fraction of macro amplitude. */
  readonly microFraction: number;
  /** Tool ticks since last glyph beyond which glyphs are treated as stale. */
  readonly marathonTicks: number;
  /** Intervening ticks a path must be absent before a re-read counts as thrash. */
  readonly thrashGapTicks: number;
  /** Max fractional band shrink a single full-amplitude verdict can propose. */
  readonly maxTightenFraction: number;
  /** Fidelity ratio bounds — the governor clamps recommendations to these. */
  readonly fidelity: {
    /** Min full-retention fraction when tightening (agent thriving). */
    readonly minFullRetention: number;
    /** Max full-retention fraction when widening (agent struggling). */
    readonly maxFullRetention: number;
    /** Min essence-retention fraction when tightening. */
    readonly minEssenceRetention: number;
    /** Max essence-retention fraction when widening. */
    readonly maxEssenceRetention: number;
  };
  /** Cache economics — base-input-price multiples. */
  readonly cache: {
    /** Cache read/hit multiplier (Anthropic: 0.1×). */
    readonly readMultiplier: number;
    /** Cache write multiplier (5-min TTL: 1.25×; 1-hour TTL: 2.0×). */
    readonly writeMultiplier: number;
  };
  /** Default knob values when no positive signal moves them. */
  readonly defaults: {
    readonly recallCards: number;
    readonly recallChars: number;
    readonly ttlPasses: number;
    /** Pressure-driven floor band under hard pressure. */
    readonly pressureBandTokens: number;
  };
}

export const DEFAULT_OVERWATCH_CONFIG: OverwatchConfig = {
  amplitude: { working: 0, executing: 0.7, verdict: 1.0, hazard: 0.8, blocked: 1.0 },
  // verdict fades over ~3-4 ticks of glyph-staleness; blocked resolves fast;
  // hazard stays relevant longer. NOTE: decay is per TOOL TICK, so in a marathon
  // these reach ≈0 within a handful of tool calls — by design.
  decay: { working: 1.0, executing: 0.85, verdict: 0.6, hazard: 0.8, blocked: 0.4 },
  densityDamp: 1.5,
  microFraction: 0.25,
  marathonTicks: 12,
  thrashGapTicks: 3,
  maxTightenFraction: 0.5,
  fidelity: {
    minFullRetention: 0.10,
    maxFullRetention: 0.20,
    minEssenceRetention: 0.20,
    maxEssenceRetention: 0.35,
  },
  cache: { readMultiplier: 0.1, writeMultiplier: 1.25 },
  defaults: {
    recallCards: 2,
    recallChars: 12_000,
    ttlPasses: 3,
    pressureBandTokens: 80_000,
  },
};

// ── Adapters (relay/runtime writes the trace → token mapping with these) ──────

const REGISTER_TO_GLYPH: Record<AssistantRegister, OverwatchGlyph> = {
  in_progress: 'working',
  executing: 'executing',
  verdict: 'verdict',
  hazard: 'hazard',
  blocked: 'blocked',
};

/**
 * Map a raw assistant message to an Overwatch glyph using the SAME parser the
 * relay/fold engine trusts (glyphs.ts). Returns undefined for non-compliant
 * messages — the engine then degrades to the histogram floor (fail-open).
 */
export function glyphFromMessage(
  message: string,
  options?: Parameters<typeof parseRegisterGlyph>[1],
): OverwatchGlyph | undefined {
  const parsed = parseRegisterGlyph(message, options);
  return parsed.ok ? REGISTER_TO_GLYPH[parsed.register] : undefined;
}

const TOOL_CLASS_RULES: ReadonlyArray<readonly [OverwatchToolClass, RegExp]> = [
  // Order matters: more specific patterns first.
  ['git', /\bgit[_-]?(diff|status|log|stage|commit|branch|stash)\b|safe[_-]?git/],
  ['test', /\b(vitest|scoped[_-]?vitest|test|typecheck|focused[_-]?typecheck)\b/],
  ['logs', /\b(logs?|pm2(?:[_-]?logs?)?|process[_-]?health|host[_-]?health|relay[_-]?debug|build[_-]?status)\b/],
  ['recall', /\b(tap_instance(?:_messages)?|tap_star|fold_recall|fold_events|psychic|harvest)\b/],
  ['rail', /\btask_rail\b/],
  ['chat', /\b(chatroom|raw_signal|inbox_send)\b/],
  ['wave', /\b(wave_advance|wave_complete|self_rebirth|spawn_instance|fork_sidequest)\b/],
  ['write', /\bwrite_file\b|\bwrite\b/],
  ['edit', /\b(edit_file|apply_diff|str_replace|patch|edit)\b/],
  ['search', /\b(grep|glob|rg|ripgrep|search|atlas_query|atlas_graph|knowledge|web_search)\b/],
  ['read', /\b(read_file|read|atlas_snapshot|atlas_diff|cat|get_)\b/],
  ['bash', /\b(run_bash|bash|run_code|shell|exec)\b/],
  ['meta', /\b(rename_self|set_thought|list_instances|partner_)\b/],
];

/**
 * Normalize a raw tool name to an {@link OverwatchToolClass}. Pure and
 * deterministic; the relay adapter calls this when building tool tokens.
 */
export function classifyToolClass(toolName: string | null | undefined): OverwatchToolClass {
  const raw = (toolName ?? '').toLowerCase();
  if (!raw) return 'other';
  // Real relay tools are namespaced — `mcp_forge_<server>__<tool>` — so keywords
  // end up buried between underscores where the \b anchors in TOOL_CLASS_RULES
  // cannot see them (underscore is a word char, so `_pm2` has no boundary before
  // `pm2`). Test BOTH the raw name (so underscore-bearing patterns like edit_file /
  // task_rail / pm2_logs still match) AND a segmented form where every run of
  // non-alphanumerics becomes a single space, restoring word boundaries around a
  // buried token (pm2 / process / git / typecheck …). First matching rule still wins.
  const segmented = raw.replace(/[^a-z0-9]+/g, ' ').trim();
  const candidate = segmented && segmented !== raw ? `${raw} ${segmented}` : raw;
  for (const [cls, re] of TOOL_CLASS_RULES) {
    if (re.test(candidate)) return cls;
  }
  return 'other';
}

/** Tool classes that contribute to WORK FLAVOR. Ambient classes are transparent. */
const FLAVOR_RELEVANT: ReadonlySet<OverwatchToolClass> = new Set<OverwatchToolClass>([
  'read',
  'search',
  'edit',
  'write',
  'bash',
  'test',
  'git',
  'logs',
  'recall',
]);

// ── Pure helpers ──────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

function finitePositive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function defaultBurstReserveTokens(windowTokens: number): number {
  if (windowTokens <= 213_000) return 37_000;
  if (windowTokens >= 900_000) return 50_000;
  return 45_000;
}

function defaultSafetyMarginTokens(windowTokens: number): number {
  if (windowTokens <= 213_000) return 10_000;
  if (windowTokens >= 900_000) return 50_000;
  return 25_000;
}

interface PressureMath {
  readonly level: OverwatchPressureLevel;
  readonly utilization: number | null;
  readonly measured: number | null;
  readonly window: number | null;
  readonly ceiling: number | null;
  readonly warnAt: number | null;
  readonly hardAt: number | null;
  readonly burstReserve: number | null;
  readonly safetyMargin: number | null;
}

function pressureLevel(p: OverwatchPressure): PressureMath {
  const { measuredTokens, windowTokens } = p;
  if (
    !Number.isFinite(measuredTokens) ||
    measuredTokens <= 0 ||
    !Number.isFinite(windowTokens) ||
    windowTokens <= 0
  ) {
    return {
      level: 'unknown',
      utilization: null,
      measured: null,
      window: null,
      ceiling: null,
      warnAt: null,
      hardAt: null,
      burstReserve: null,
      safetyMargin: null,
    };
  }

  const configuredCeiling = finitePositive(p.pressureCeilingTokens)
    ?? finitePositive(p.messageCeilingTokens)
    ?? windowTokens;
  const ceiling = Math.min(windowTokens, configuredCeiling);
  const burstReserve = finitePositive(p.burstReserveTokens) ?? defaultBurstReserveTokens(windowTokens);
  const safetyMargin = finitePositive(p.safetyMarginTokens) ?? defaultSafetyMarginTokens(windowTokens);
  const hardAt = Math.max(1, ceiling - burstReserve);
  const warnAt = Math.max(1, hardAt - safetyMargin);
  const u = measuredTokens / windowTokens;

  if (measuredTokens >= ceiling) {
    return { level: 'auto_compact', utilization: u, measured: measuredTokens, window: windowTokens, ceiling, warnAt, hardAt, burstReserve, safetyMargin };
  }
  if (measuredTokens >= hardAt) {
    return { level: 'critical', utilization: u, measured: measuredTokens, window: windowTokens, ceiling, warnAt, hardAt, burstReserve, safetyMargin };
  }
  if (measuredTokens >= warnAt) {
    return { level: 'warning', utilization: u, measured: measuredTokens, window: windowTokens, ceiling, warnAt, hardAt, burstReserve, safetyMargin };
  }
  return { level: 'healthy', utilization: u, measured: measuredTokens, window: windowTokens, ceiling, warnAt, hardAt, burstReserve, safetyMargin };
}

function pressureAction(pressure: OverwatchPressure, press: PressureMath): OverwatchPressureActionRec {
  const base = {
    ceilingTokens: press.ceiling,
    warnAtTokens: press.warnAt,
    hardAtTokens: press.hardAt,
    burstReserveTokens: press.burstReserve,
    safetyMarginTokens: press.safetyMargin,
  };
  if (press.measured === null || press.warnAt === null || press.hardAt === null) {
    return { action: 'hold', reason: 'measured pressure unavailable', noProviderCallWithoutRelief: false, ...base };
  }

  const noProviderCallWithoutRelief = press.measured >= press.hardAt;
  const prefixSaturation = finitePositive(pressure.prefixSaturationTokens);
  const frozenPrefix = finitePositive(pressure.frozenPrefixTokens);
  if (prefixSaturation !== null && frozenPrefix !== null && frozenPrefix >= prefixSaturation) {
    return {
      action: 'full_recompute_evict',
      reason: `frozen prefix ${frozenPrefix} >= saturation ${prefixSaturation}`,
      noProviderCallWithoutRelief,
      ...base,
    };
  }

  if (press.measured < press.warnAt) {
    return {
      action: 'normal_append',
      reason: `measured ${press.measured} < warnAt ${press.warnAt}`,
      noProviderCallWithoutRelief: false,
      ...base,
    };
  }

  const rawTail = finitePositive(pressure.rawTailTokens);
  if (rawTail === null || rawTail > 0) {
    return {
      action: 'pressure_tail_append',
      reason: rawTail === null
        ? `measured ${press.measured} >= warnAt ${press.warnAt}; tail token split unknown, host must verify append boundary`
        : `measured ${press.measured} >= warnAt ${press.warnAt}; raw tail ${rawTail} can be relieved first`,
      noProviderCallWithoutRelief,
      ...base,
    };
  }

  return {
    action: 'suffix_compact',
    reason: `measured ${press.measured} >= warnAt ${press.warnAt}; raw tail measured empty, compact suffix before provider call`,
    noProviderCallWithoutRelief,
    ...base,
  };
}

/** Tool tokens, in order. */
function toolTokens(window: readonly TraceToken[]): TraceToken[] {
  return window.filter((t) => t.kind === 'tool');
}

/** Index (in the FULL window) of the most recent macro glyph token, or -1. */
function lastGlyphIndex(window: readonly TraceToken[]): number {
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].kind === 'msg' && window[i].glyph) return i;
  }
  return -1;
}

/** Tool ticks elapsed between a window index and the end of the window. */
function toolTicksSince(window: readonly TraceToken[], fromIndex: number): number {
  let ticks = 0;
  for (let i = fromIndex + 1; i < window.length; i++) {
    if (window[i].kind === 'tool') ticks++;
  }
  return ticks;
}

interface ImpulseAccumulator {
  sum: number;
  count: number;
}

const EXECUTION_HOLD_MIN_IMPULSE = 0.1;

/**
 * Compute decaying glyph impulses at the current tick. Each macro glyph
 * contributes A·λ^(toolTicksSince) to its type's accumulator; the per-type sum is
 * then CADENCE-DAMPED by the number of contributing glyphs of that type:
 *
 *   impulse_type = Σ(A·λ^ticks) / (1 + densityDamp·(count − 1))
 *
 * So a lone fresh verdict hits full force, but a verdict STREAK (mechanical
 * rail-step acks firing one-per-turn) self-damps instead of stacking — exactly
 * the V→V damping the grammar calls for. Without this, three close verdicts would
 * sum to MORE tighten than one, which is backwards. Micro rail-acks contribute at
 * `microFraction` amplitude and count toward their type's cadence.
 */
function computeImpulses(
  window: readonly TraceToken[],
  cfg: OverwatchConfig,
): { impulses: OverwatchImpulses; glyphsPresent: boolean; notes: string[]; executionHold: number } {
  const notes: string[] = [];
  let glyphsPresent = false;

  const acc: Record<'verdict' | 'blocked' | 'hazard' | 'executing', ImpulseAccumulator> = {
    verdict: { sum: 0, count: 0 },
    blocked: { sum: 0, count: 0 },
    hazard: { sum: 0, count: 0 },
    executing: { sum: 0, count: 0 },
  };

  const addImpulse = (
    kind: 'verdict' | 'blocked' | 'hazard' | 'executing',
    ticksSince: number,
    scale: number,
  ): void => {
    const value = cfg.amplitude[kind] * scale * Math.pow(cfg.decay[kind], ticksSince);
    if (value <= 0) return;
    acc[kind].sum += value;
    acc[kind].count += 1;
  };

  for (let i = 0; i < window.length; i++) {
    const tok = window[i];
    if (tok.kind === 'msg' && tok.glyph) {
      glyphsPresent = true;
      // 'working' is the carrier: it resets the decay clock but emits no impulse.
      if (tok.glyph !== 'working') addImpulse(tok.glyph, toolTicksSince(window, i), 1);
    } else if (tok.kind === 'tool' && tok.toolClass === 'rail' && tok.railAck) {
      // Micro tier: rail acks act as low-amplitude, dense pseudo-glyphs — they
      // keep the grammar fed during a marathon where macro glyphs go dark.
      const ticksSince = toolTicksSince(window, i);
      if (tok.railAck === 'needs_review') addImpulse('verdict', ticksSince, cfg.microFraction);
      else if (tok.railAck === 'blocked') addImpulse('blocked', ticksSince, cfg.microFraction);
      else if (tok.railAck === 'in_progress') addImpulse('executing', ticksSince, cfg.microFraction);
      // 'done' = work continues/resolves; no tighten/widen impulse.
    }
  }

  const damp = (a: ImpulseAccumulator): number =>
    a.count > 0 ? a.sum / (1 + cfg.densityDamp * (a.count - 1)) : 0;

  const tighten = damp(acc.verdict);
  const widenRecall = damp(acc.blocked);
  const holdHazard = damp(acc.hazard);
  const executionHold = damp(acc.executing);
  const executionHoldActive = executionHold >= EXECUTION_HOLD_MIN_IMPULSE;
  const hold = Math.max(holdHazard, executionHoldActive ? executionHold : 0);

  if (tighten > 0) notes.push(`tighten-impulse=${tighten.toFixed(3)} (verdict×${acc.verdict.count})`);
  if (widenRecall > 0) notes.push(`widen-recall-impulse=${widenRecall.toFixed(3)} (blocked×${acc.blocked.count})`);
  if (holdHazard > 0) notes.push(`hold-impulse=${holdHazard.toFixed(3)} (hazard×${acc.hazard.count})`);
  if (executionHold > 0) {
    notes.push(
      `execution-hold-impulse=${executionHold.toFixed(3)} (executing×${acc.executing.count}` +
        `${executionHoldActive ? ')' : `, below ${EXECUTION_HOLD_MIN_IMPULSE} threshold)`}`,
    );
  }

  return {
    impulses: { tighten, widenRecall, hold, captureHazard: holdHazard },
    glyphsPresent,
    notes,
    executionHold,
  };
}

/**
 * Pure-trace thrash + path churn. A path read, gone from the window for
 * >= thrashGapTicks tool ticks, then re-read, is thrash (the agent lost context
 * that was folded away). pathChurn = distinct paths touched by edit/write tokens.
 */
function computePathSignals(
  window: readonly TraceToken[],
  cfg: OverwatchConfig,
): { thrash: number; pathChurn: number } {
  const churn = new Set<string>();
  // tick index of each path appearance, in tool-tick space
  const appearances = new Map<string, number[]>();
  let tick = 0;
  for (const tok of window) {
    if (tok.kind !== 'tool') continue;
    tick++;
    if (tok.pathArgs) {
      if (tok.toolClass === 'edit' || tok.toolClass === 'write') {
        for (const p of tok.pathArgs) churn.add(p);
      }
      for (const p of tok.pathArgs) {
        const arr = appearances.get(p);
        if (arr) arr.push(tick);
        else appearances.set(p, [tick]);
      }
    }
  }
  let thrash = 0;
  for (const ticks of appearances.values()) {
    for (let i = 1; i < ticks.length; i++) {
      if (ticks[i] - ticks[i - 1] >= cfg.thrashGapTicks) {
        thrash++;
        break; // count each path at most once
      }
    }
  }
  return { thrash, pathChurn: churn.size };
}

/**
 * Histogram-driven work flavor — the dense floor. Ambient tools are transparent;
 * classification is over the DISTRIBUTION of flavor-relevant tools in the window,
 * not the single last tool (this is what kills the original flapping). Rail acks
 * supply a review bias. `planning` is the generous fallback, never a starvation
 * default.
 */
function classifyFlavor(
  window: readonly TraceToken[],
  marathon: boolean,
  pressure: OverwatchPressureLevel,
): { flavor: OverwatchFlavor; note: string } {
  if (marathon) return { flavor: 'marathon', note: 'flavor=marathon (glyphs stale, long tool run)' };

  const tools = toolTokens(window);
  const hist: Record<OverwatchToolClass, number> = {
    read: 0, search: 0, edit: 0, write: 0, bash: 0, test: 0, git: 0,
    logs: 0, recall: 0, rail: 0, chat: 0, wave: 0, meta: 0, other: 0,
  };
  let railReview = 0;
  let recovery = 0;
  for (const t of tools) {
    const c = t.toolClass ?? 'other';
    hist[c]++;
    if (c === 'rail' && t.railAck === 'needs_review') railReview++;
    if (c === 'recall' || c === 'wave') recovery++;
  }

  const relevant = ([] as OverwatchToolClass[]).concat(
    ...(Object.keys(hist) as OverwatchToolClass[]).map((c) =>
      FLAVOR_RELEVANT.has(c) ? Array<OverwatchToolClass>(hist[c]).fill(c) : [],
    ),
  );

  if (relevant.length === 0) {
    // No substantive work in the window — generous default, NOT a clamp.
    if (recovery > 0 && tools.length > 0 && recovery === tools.length) {
      return { flavor: 'recovery', note: 'flavor=recovery (recall/rebirth only)' };
    }
    return { flavor: 'planning', note: 'flavor=planning (no substantive tools — generous default)' };
  }

  const impl = hist.edit + hist.write + hist.bash;
  const reviewish = hist.test + hist.git + railReview;
  const debug = hist.logs;
  const investigate = hist.read + hist.search + hist.recall;

  // Priority reflects asymmetric cost: review/debug get the wider aperture and
  // must win when their evidence is present anywhere in the window.
  let flavor: OverwatchFlavor;
  if (reviewish > 0 && reviewish >= impl) flavor = 'review';
  else if (impl > 0 && impl >= debug && impl >= investigate) flavor = 'implementation';
  else if (debug > 0 && debug >= investigate) flavor = 'debugging';
  else if (reviewish > 0) flavor = 'review';
  else flavor = 'investigation';

  return {
    flavor,
    note: `flavor=${flavor} (impl=${impl} review=${reviewish} debug=${debug} invest=${investigate})`,
  };
}

/**
 * Cache-rewrite breakeven gate. A band shrink ΔN busts the prefix cache: you pay
 * to re-WRITE the smaller band now (vs the cheap re-READ of the old cached band),
 * and earn it back 0.1×ΔN per subsequent hit. Returns true only when the expected
 * remaining hits clear the breakeven:
 *
 *   expectedHits · readMult · ΔN  ≥  writeMult·(N − ΔN) − readMult·N
 *
 * A shrink with ΔN→0 (cosmetic re-fold) has infinite breakeven → always vetoed.
 */
export function breakevenAllowsShrink(
  currentBand: number,
  proposedBand: number,
  expectedHits: number,
  cfg: OverwatchConfig = DEFAULT_OVERWATCH_CONFIG,
): boolean {
  const deltaN = currentBand - proposedBand;
  if (deltaN <= 0) return false; // not a shrink
  const { readMultiplier: r, writeMultiplier: w } = cfg.cache;
  const writePremium = w * (currentBand - deltaN) - r * currentBand;
  if (writePremium <= 0) return true; // rewrite is already cheaper than the read
  const savings = expectedHits * r * deltaN;
  return savings >= writePremium;
}

interface ExpectedCacheHits {
  readonly hits: number;
  readonly source: string;
}

function measuredHotReuses(cache: OverwatchCacheTelemetry | undefined): number | null {
  if (!cache) return null;
  if (!Number.isFinite(cache.hotReuses)) return 0;
  return Math.max(0, Math.floor(cache.hotReuses));
}

/**
 * Expected cache hits for the breakeven gate. Host runtimes should pass measured
 * hot-reuse telemetry; the trace-only fallback is only for standalone callers
 * that do not yet observe provider cache behavior.
 */
function expectedCacheHits(
  window: readonly TraceToken[],
  marathon: boolean,
  cache: OverwatchCacheTelemetry | undefined,
): ExpectedCacheHits {
  const measured = measuredHotReuses(cache);
  if (measured !== null) {
    return {
      hits: measured,
      source: `measured hotReuses=${measured} epochs=${cache?.epochs ?? 0}`,
    };
  }
  const ticks = toolTokens(window).length;
  const hits = marathon ? Math.max(ticks, 50) : Math.max(ticks, 1);
  return { hits, source: `trace fallback ticks=${ticks}${marathon ? ' marathon-floor=50' : ''}` };
}

// ── The governor ──────────────────────────────────────────────────────────────

/**
 * Decide context geometry from a pure trace window + measured pressure.
 *
 * @param window   Trace tokens in order, windowed in tool-tick space. The caller
 *                 owns the slice (e.g. "since the 2nd-most-recent verdict").
 * @param pressure Measured provider tokens + window size (GOD RULE 7).
 * @param priorBand The live band, for continuity. null = unknown (hold/derive).
 * @param config   Tunable constants. Defaults to {@link DEFAULT_OVERWATCH_CONFIG}.
 */
export function governByTrace(
  window: readonly TraceToken[],
  pressure: OverwatchPressure,
  priorBand: number | null = null,
  config: OverwatchConfig = DEFAULT_OVERWATCH_CONFIG,
): OverwatchDecision {
  const cfg = config;
  const derivation: string[] = [];

  // 1. Pressure (the irreducible scalar).
  const press = pressureLevel(pressure);
  derivation.push(
    `pressure=${press.level}` +
      (press.utilization !== null ? ` utilization=${press.utilization.toFixed(3)}` : ' (unknown — measured tokens absent)'),
  );

  // 2. Marathon / glyph staleness — from the tool-tick distance to the last glyph.
  const glyphIdx = lastGlyphIndex(window);
  const ticksSinceLastGlyph = glyphIdx === -1 ? null : toolTicksSince(window, glyphIdx);
  const marathon = ticksSinceLastGlyph !== null && ticksSinceLastGlyph >= cfg.marathonTicks;
  if (ticksSinceLastGlyph !== null) {
    derivation.push(
      `ticks-since-last-glyph=${ticksSinceLastGlyph}${marathon ? ` ≥ ${cfg.marathonTicks} → marathon (glyphs stale)` : ''}`,
    );
  } else {
    derivation.push('no macro glyph in window → histogram floor owns the decision');
  }

  // 3. Flavor (dense histogram floor).
  const { flavor, note: flavorNote } = classifyFlavor(window, marathon, press.level);
  derivation.push(flavorNote);

  // 4. Glyph impulses (decaying derivatives that modulate the floor).
  const { impulses, glyphsPresent, notes: impulseNotes, executionHold } = computeImpulses(window, cfg);
  derivation.push(...impulseNotes);

  // 5. Path signals (pure trace).
  const { thrash, pathChurn } = computePathSignals(window, cfg);
  if (thrash > 0) derivation.push(`thrash=${thrash} (re-read folded paths)`);
  if (pathChurn > 0) derivation.push(`path-churn=${pathChurn}`);

  const pressureAct = pressureAction(pressure, press);
  derivation.push(
    `pressure-action: ${pressureAct.action} (${pressureAct.reason}; ` +
      `warnAt=${pressureAct.warnAtTokens ?? 'null'} hardAt=${pressureAct.hardAtTokens ?? 'null'} ` +
      `no-call=${pressureAct.noProviderCallWithoutRelief})`,
  );

  // ── Band ──────────────────────────────────────────────────────────────────
  // GENEROUS DEFAULT: hold the prior band. Only positive, corroborated signals
  // move it — the asymmetry fix (wrongly tightening a reviewer is expensive;
  // wrongly widening a planner is cheap).
  let bandTokens: number | null = priorBand;
  if (press.level === 'auto_compact' || press.level === 'critical') {
    // Hard pressure: shrink toward the pressure floor regardless of glyphs.
    const target =
      priorBand !== null ? Math.min(priorBand, cfg.defaults.pressureBandTokens) : cfg.defaults.pressureBandTokens;
    bandTokens = target;
    derivation.push(`band: hard pressure → ${target} (pressure floor)`);
  } else if (executionHold >= EXECUTION_HOLD_MIN_IMPULSE) {
    derivation.push(`band: executing hold → no shrink (impulse=${executionHold.toFixed(3)})`);
  } else if (priorBand !== null && impulses.tighten > 0 && impulses.hold <= impulses.tighten) {
    // A verdict armed a tighten. ECONOMICS DISPOSES: only commit if breakeven clears.
    const tightenFrac = Math.min(cfg.maxTightenFraction, cfg.maxTightenFraction * impulses.tighten);
    const proposed = Math.max(1, Math.round(priorBand * (1 - tightenFrac)));
    const expected = expectedCacheHits(window, marathon, pressure.cache);
    if (breakevenAllowsShrink(priorBand, proposed, expected.hits, cfg)) {
      bandTokens = proposed;
      derivation.push(
        `band: verdict tighten ${priorBand}→${proposed} (Δ=${priorBand - proposed}, ` +
          `expHits=${expected.hits}; ${expected.source}) — breakeven CLEARED`,
      );
    } else {
      derivation.push(
        `band: verdict tighten ${priorBand}→${proposed} VETOED by breakeven ` +
          `(Δ=${priorBand - proposed}, expHits=${expected.hits} insufficient; ${expected.source}) → hold ${priorBand}`,
      );
    }
  } else if (impulses.hold > 0) {
    derivation.push(`band: hazard hold → no shrink (impulse=${impulses.hold.toFixed(3)})`);
  } else {
    derivation.push(`band: hold prior (${priorBand ?? 'null'}) — no corroborated tighten signal`);
  }

  // ── Fidelity ratios (quality-driven) ───────────────────────────────────────
  // Unlike the band (cost-driven, shrink-only), fidelity ratios are bidirectional:
  // they WIDEN when the agent is struggling (blocked, thrash) and TIGHTEN when
  // thriving (verdicts clearing breakeven). Default = null (hold prior).
  let fidelity: FidelityRatios | null = null;
  const fcfg = cfg.fidelity;
  if (press.level === 'auto_compact' || press.level === 'critical') {
    // Under hard pressure, tighten fidelity aggressively — skeletonize more to
    // survive the pressure event. The agent will get recall cards instead.
    fidelity = {
      fullRetentionFraction: fcfg.minFullRetention,
      essenceRetentionFraction: fcfg.minEssenceRetention,
    };
    derivation.push(
      `fidelity: hard pressure → tighten to ${fcfg.minFullRetention}/${fcfg.minEssenceRetention}`,
    );
  } else if (impulses.widenRecall > 0 || thrash > 0) {
    // Blocked glyph or thrash → agent lost context, WIDEN fidelity so more
    // turns survive at full/essence retention.
    const widenStrength = Math.min(1, impulses.widenRecall + thrash * 0.3);
    fidelity = {
      fullRetentionFraction: lerp(DEFAULT_FIDELITY_RATIOS.fullRetentionFraction, fcfg.maxFullRetention, widenStrength),
      essenceRetentionFraction: lerp(DEFAULT_FIDELITY_RATIOS.essenceRetentionFraction, fcfg.maxEssenceRetention, widenStrength),
    };
    derivation.push(
      `fidelity: WIDEN → ${fidelity.fullRetentionFraction.toFixed(3)}/${fidelity.essenceRetentionFraction.toFixed(3)} ` +
        `(${impulses.widenRecall > 0 ? 'blocked' : ''}${impulses.widenRecall > 0 && thrash > 0 ? '+' : ''}${thrash > 0 ? 'thrash' : ''}, strength=${widenStrength.toFixed(2)})`,
    );
  } else if (executionHold >= EXECUTION_HOLD_MIN_IMPULSE) {
    // Mid-execution: hold — don't change ratios while the agent is actively working.
    derivation.push('fidelity: executing hold → hold prior');
  } else if (impulses.tighten > 0 && impulses.hold <= impulses.tighten && bandTokens !== null && priorBand !== null && bandTokens < priorBand) {
    // Verdict armed a band tighten that cleared breakeven — also tighten fidelity.
    // The agent is coping well, so it can afford less verbatim history.
    const tightenStrength = Math.min(1, impulses.tighten);
    fidelity = {
      fullRetentionFraction: lerp(DEFAULT_FIDELITY_RATIOS.fullRetentionFraction, fcfg.minFullRetention, tightenStrength),
      essenceRetentionFraction: lerp(DEFAULT_FIDELITY_RATIOS.essenceRetentionFraction, fcfg.minEssenceRetention, tightenStrength),
    };
    derivation.push(
      `fidelity: tighten → ${fidelity.fullRetentionFraction.toFixed(3)}/${fidelity.essenceRetentionFraction.toFixed(3)} ` +
        `(verdict, strength=${tightenStrength.toFixed(2)})`,
    );
  } else {
    derivation.push('fidelity: hold prior — no corroborated signal');
  }

  // ── Recall ──────────────────────────────────────────────────────────────────
  let recall: OverwatchRecallRec;
  if (press.level === 'auto_compact' || press.level === 'critical') {
    recall = { maxCards: 1, maxTotalChars: 3_000, ttlPasses: 1, enableTerms: false };
    derivation.push('recall: hard pressure → 1 card / 3k');
  } else if (impulses.widenRecall > 0 || thrash > 0) {
    // Blocked glyph OR observed thrash → widen the aperture (it lost context).
    recall = { maxCards: 4, maxTotalChars: 24_000, ttlPasses: cfg.defaults.ttlPasses, enableTerms: true };
    derivation.push(
      `recall: WIDEN → 4 cards / 24k (${impulses.widenRecall > 0 ? 'blocked glyph' : ''}${
        impulses.widenRecall > 0 && thrash > 0 ? '+' : ''
      }${thrash > 0 ? 'thrash' : ''})`,
    );
  } else if (executionHold >= EXECUTION_HOLD_MIN_IMPULSE) {
    recall = { maxCards: 3, maxTotalChars: 16_000, ttlPasses: cfg.defaults.ttlPasses, enableTerms: true };
    derivation.push('recall: executing → 3 cards / 16k');
  } else if (flavor === 'review' || flavor === 'debugging') {
    recall = { maxCards: 3, maxTotalChars: 16_000, ttlPasses: cfg.defaults.ttlPasses, enableTerms: true };
    derivation.push(`recall: ${flavor} → 3 cards / 16k`);
  } else {
    recall = {
      maxCards: cfg.defaults.recallCards,
      maxTotalChars: cfg.defaults.recallChars,
      ttlPasses: cfg.defaults.ttlPasses,
      enableTerms: true,
    };
    derivation.push(`recall: default → ${recall.maxCards} cards / ${recall.maxTotalChars}`);
  }

  // ── Episodic ──────────────────────────────────────────────────────────────
  const underHardPressure = press.level === 'auto_compact' || press.level === 'critical';
  const episodic: OverwatchEpisodicRec = {
    inject: !underHardPressure,
    fire: !underHardPressure,
    captureBias: impulses.captureHazard,
  };
  if (impulses.captureHazard > 0) {
    derivation.push(`episodic: hazard capture bias=${impulses.captureHazard.toFixed(3)}`);
  }

  // ── Freeze ──────────────────────────────────────────────────────────────────
  let freeze: OverwatchFreezeRec;
  if (underHardPressure) {
    freeze = { action: 'epoch', reason: `measured pressure is ${press.level}` };
  } else if (marathon) {
    freeze = { action: 'epoch', reason: 'hot tail filling — marathon detected' };
  } else if (impulses.tighten > 0 && bandTokens !== null && priorBand !== null && bandTokens < priorBand) {
    freeze = { action: 'epoch', reason: 'committing a verdict-armed band shrink' };
  } else {
    freeze = { action: 'defer', reason: 'no shadow-only condition beats cache preservation' };
  }
  derivation.push(`freeze: ${freeze.action} (${freeze.reason})`);

  return {
    flavor,
    pressure: {
      level: press.level,
      utilization: press.utilization,
      measuredTokens: press.measured,
      windowTokens: press.window,
      ceilingTokens: press.ceiling,
      warnAtTokens: press.warnAt,
      hardAtTokens: press.hardAt,
    },
    pressureAction: pressureAct,
    bandTokens,
    fidelity,
    recall,
    episodic,
    freeze,
    glyphsPresent,
    marathon,
    impulses,
    signals: {
      thrash,
      pathChurn,
      ticksSinceLastGlyph,
      toolTicks: toolTokens(window).length,
    },
    derivation,
  };
}

// ─── Prefix trace caching ──────────────────────────────────────────────────
//
// On hot-reuse calls the frozen prefix is byte-identical, yet
// buildOverwatchTrace scans the last N messages on every call. For sessions
// with long frozen prefixes, most of those N messages are frozen content
// being re-scanned redundantly. This utility lets callers cache the prefix
// portion's trace at epoch boundaries and only scan the raw tail on
// subsequent calls.

/**
 * Cached prefix-trace window. Populated at epoch boundaries (when the frozen
 * view changes) and reused on hot-reuse calls where the prefix is byte-stable.
 */
export interface CachedTraceWindow {
  /** Trace tokens for the frozen prefix, in chronological order. */
  readonly tokens: TraceToken[];
  /** Raw message count covered by the cached prefix (exclusive upper bound). */
  readonly rawCount: number;
}

/**
 * Build a trace window with prefix caching. If `cache` covers `rawCount`
 * messages and the current history is longer, only the tail beyond the cached
 * prefix is scanned. Otherwise a full scan is performed.
 *
 * The `scanFn` parameter is the message→trace function (typically
 * `buildOverwatchTrace` bound to a maxMessages cap). It is called with only
 * the uncached tail slice.
 *
 * Pure function, no side effects, safe on any thread.
 */
export function buildTraceWithCache(
  messages: readonly unknown[],
  cache: CachedTraceWindow | null,
  scanFn: (msgs: readonly unknown[]) => TraceToken[],
): TraceToken[] {
  if (!cache || cache.rawCount <= 0 || messages.length <= cache.rawCount) {
    return scanFn(messages);
  }
  // Scan only the tail beyond the cached prefix.
  const tail = messages.slice(cache.rawCount);
  const tailTokens = scanFn(tail);
  return [...cache.tokens, ...tailTokens];
}
