/**
 * FoldSession — the reference orchestrator that wires the context-warp engine
 * into any function-calling agent loop.
 *
 * It distills the relay's production seam (`fcBaseSession.applyCompaction`) into
 * one provider-agnostic helper: every turn you hand it your full provider-shaped
 * message history; it returns the compacted view to send AND keeps the provider
 * prompt cache hot by reusing a byte-identical frozen prefix between epochs.
 *
 *   - Rolling fold (`foldContext`): turns past the active window skeletonize into
 *     a synthetic fold block; the Coordinate Closet conserves ids/paths/values.
 *   - Fold freeze (`evaluateFoldFreeze`/`commitFoldFreeze`): the frozen fold is
 *     reused byte-identical while the provider cache is warm; it only recomputes
 *     at an epoch (first call, cold TTL gap, raw-tail cap, claim/thinning change,
 *     or boundary rewrite).
 *
 * Ambient page-in recall (`foldRecall`) and durable episodic recall
 * (`episodes/`) compose ON TOP of this — see the examples/ and the README.
 * They are intentionally left as explicit building blocks rather than hidden
 * inside FoldSession, because their triggers (touched paths, file claims) are
 * harness-specific.
 *
 * Pure CPU, zero I/O, zero LLM calls, deterministic for identical inputs.
 */
import {
  foldContext,
  detectTurns,
  computeEvictableThroughOrdinal,
  DEFAULT_FOLD_CONFIG,
  DEFAULT_FOLD_EVICT_THRESHOLD_CHARS,
  type FoldMessage,
  type FoldConfig,
  type FoldResult,
  type FoldEvictionInput,
  type FoldEvictionSpan,
} from '../rollingFold.ts';
import {
  createFoldFreezeState,
  evaluateFoldFreeze,
  commitFoldFreeze,
  touchFoldFreeze,
  DEFAULT_FOLD_FREEZE_CONFIG,
  type FoldFreezeState,
  type FoldFreezeConfig,
  type FoldFreezeContext,
} from '../foldFreeze.ts';

const EMPTY_CLAIMED: ReadonlySet<string> = new Set<string>();
export const DEFAULT_FOLD_PRESSURE_CEILING_TOKENS = 240_000;

export interface FoldPressureCeilingConfig {
  /**
   * Absolute measured input-token ceiling. FoldSession never estimates tokens:
   * hosts pass measured provider/relay input tokens via prepare().
   */
  readonly tokens?: number;
}

export interface FoldSessionOptions {
  /**
   * Rolling-fold config. Defaults to DEFAULT_FOLD_CONFIG (folds past char/turn
   * thresholds, 20-turn full-fidelity window). For always-lean continuous
   * folding pass `{ ...DEFAULT_FOLD_CONFIG, continuous: true }` (or import
   * ALWAYS_ON_FOLD_CONFIG and tune `activeWindowTurns` up if you do not rebirth).
   */
  readonly foldConfig?: FoldConfig;
  /**
   * Provider-cache freeze layer. `true` (default) uses DEFAULT_FOLD_FREEZE_CONFIG
   * (5m TTL, 150K raw-tail cap). Pass a FoldFreezeConfig to tune TTL to your
   * provider's real cache window (e.g. ttlMs: 3_600_000 for a 1h cache). `false`
   * recomputes the fold every call (no cache reuse).
   */
  readonly freeze?: boolean | FoldFreezeConfig;
  /**
   * E10 sawtooth eviction for the standing fold block. Enabled by default for
   * prepare(), because FoldSession's contract is full raw append-only history:
   * hosts can compose foldRecall with that raw history to page tombstoned
   * detail back in. Pass false to keep the fold block monotonic, or tune the
   * threshold.
   */
  readonly eviction?: boolean | { readonly thresholdChars?: number };
  /**
   * Absolute pressure guard for large-window models. Enabled by default at
   * 240k measured input tokens; pass false to disable or a number/config to
   * tune. The host must pass measuredInputTokens to prepare() for it to fire.
   */
  readonly pressureCeiling?: false | number | FoldPressureCeilingConfig;
  /** Clock injection for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number;
}

export interface FoldPrepareContext extends Partial<FoldFreezeContext> {
  /**
   * Highest raw message index whose content is durable enough to tombstone.
   * Defaults to messages.length (all supplied raw history). Hosts with async
   * episodic persistence can pass a lower cursor until their store confirms.
   */
  readonly durableCursorIndex?: number;
  /**
   * Measured provider/relay input tokens for the prompt about to be sent. This
   * must be real telemetry, not an estimate; when it reaches the pressure
   * ceiling, FoldSession forces a fresh fold epoch instead of hot-reusing.
   */
  readonly measuredInputTokens?: number;
}

export interface FoldStats {
  /** Total conversational turns detected in the history. */
  readonly totalTurns: number;
  /** True when the frozen prefix was reused byte-identical (provider cache stays hot). */
  readonly cacheHot: boolean;
  /** Recompute reason when this call was an epoch (not a hot reuse). */
  readonly epochReason?: string;
  /** Leading turns folded this epoch (only on a fresh fold). */
  readonly turnsFolded?: number;
  /** Original vs folded char counts and savings (only on a fresh fold). */
  readonly originalChars?: number;
  readonly foldedChars?: number;
  readonly savingsPercent?: number;
  /** Lifetime hot reuses since the last epoch, and total epochs (freeze telemetry). */
  readonly hotReuses: number;
  readonly epochs: number;
  /** E10 sawtooth telemetry, present on fresh folds when eviction is enabled. */
  readonly newlyEvictedTurns?: number;
  readonly evictedSpanCount?: number;
  /** Absolute measured-token ceiling telemetry when the pressure guard is enabled. */
  readonly pressureCeilingTokens?: number;
  readonly pressureCeilingTriggered?: boolean;
}

export interface FoldOutcome {
  /** The provider-shaped message array to send this turn. */
  readonly messages: FoldMessage[];
  /** True when the byte-identical frozen prefix was reused (cache hot). */
  readonly cacheHot: boolean;
  /** The full fold result, present only on an epoch (fresh fold). */
  readonly result?: FoldResult;
  readonly stats: FoldStats;
}

/**
 * Stateful per-conversation fold orchestrator. Construct one per agent session;
 * call {@link prepare} every turn with the latest full history.
 */
export class FoldSession {
  private readonly foldConfig: FoldConfig;
  private readonly freezeEnabled: boolean;
  private readonly freezeConfig: FoldFreezeConfig;
  private readonly freezeState: FoldFreezeState;
  private readonly evictionEnabled: boolean;
  private readonly evictionThresholdChars: number;
  private readonly pressureCeilingTokens: number | null;
  private readonly clock: () => number;
  private foldEpochs = 0;
  private foldEvictedSpans: FoldEvictionSpan[] = [];
  private foldEpochFrontiers: Array<{ epoch: number; turnsFolded: number }> = [];
  private lastPreparedRawCount = 0;

  constructor(options: FoldSessionOptions = {}) {
    this.foldConfig = options.foldConfig ?? DEFAULT_FOLD_CONFIG;
    if (options.freeze === false) {
      this.freezeEnabled = false;
      this.freezeConfig = DEFAULT_FOLD_FREEZE_CONFIG;
    } else if (options.freeze && typeof options.freeze === 'object') {
      this.freezeEnabled = true;
      this.freezeConfig = options.freeze;
    } else {
      this.freezeEnabled = true;
      this.freezeConfig = DEFAULT_FOLD_FREEZE_CONFIG;
    }
    if (options.eviction === false) {
      this.evictionEnabled = false;
      this.evictionThresholdChars = DEFAULT_FOLD_EVICT_THRESHOLD_CHARS;
    } else {
      this.evictionEnabled = true;
      this.evictionThresholdChars = typeof options.eviction === 'object'
        ? options.eviction.thresholdChars ?? DEFAULT_FOLD_EVICT_THRESHOLD_CHARS
        : DEFAULT_FOLD_EVICT_THRESHOLD_CHARS;
    }
    if (options.pressureCeiling === false) {
      this.pressureCeilingTokens = null;
    } else {
      const configured = typeof options.pressureCeiling === 'number'
        ? options.pressureCeiling
        : options.pressureCeiling?.tokens ?? DEFAULT_FOLD_PRESSURE_CEILING_TOKENS;
      this.pressureCeilingTokens = Number.isFinite(configured) && configured > 0 ? configured : null;
    }
    this.freezeState = createFoldFreezeState();
    this.clock = options.now ?? Date.now;
  }

  /** Count conversational turns in a provider-shaped message array. */
  countTurns(messages: FoldMessage[]): number {
    return detectTurns(messages).length;
  }

  private resolveTurnsToFold(messages: FoldMessage[], explicit?: number): number {
    const total = detectTurns(messages).length;
    return typeof explicit === 'number'
      ? Math.max(0, Math.min(explicit, total))
      : Math.max(0, total - this.foldConfig.activeWindowTurns);
  }

  /**
   * Run the rolling fold once, WITHOUT the freeze cache layer. Use this for a
   * one-shot compaction or when you manage cache reuse yourself. For a live loop,
   * prefer {@link prepare}.
   */
  fold(messages: FoldMessage[], turnsToFold?: number): FoldResult {
    return foldContext(messages, this.resolveTurnsToFold(messages, turnsToFold), this.foldConfig);
  }

  private resetEvictionState(): void {
    this.foldEpochs = 0;
    this.foldEvictedSpans = [];
    this.foldEpochFrontiers = [];
  }

  private buildFoldEvictionInput(
    messages: FoldMessage[],
    durableCursorIndex: number,
    upcomingEpoch: number,
    now: number,
  ): FoldEvictionInput | undefined {
    if (!this.evictionEnabled || this.evictionThresholdChars <= 0) return undefined;
    const hasSpans = this.foldEvictedSpans.length > 0;
    const evictableThroughOrdinal = computeEvictableThroughOrdinal(
      detectTurns(messages),
      durableCursorIndex,
      this.foldEpochFrontiers,
      upcomingEpoch,
    );
    if (evictableThroughOrdinal <= 0 && !hasSpans) return undefined;
    return {
      evictedSpans: this.foldEvictedSpans,
      evictableThroughOrdinal,
      thresholdChars: this.evictionThresholdChars,
      nowIso: new Date(now).toISOString(),
    };
  }

  private commitEvictionEpoch(result: FoldResult, epoch: number): void {
    this.foldEpochs = Math.max(this.foldEpochs, epoch);
    this.foldEpochFrontiers.push({ epoch, turnsFolded: result.turnsFolded });
    if (this.foldEpochFrontiers.length > 16) {
      this.foldEpochFrontiers.splice(0, this.foldEpochFrontiers.length - 16);
    }
    if (result.evictedSpans) {
      this.foldEvictedSpans = result.evictedSpans.map(span => ({ ...span }));
    }
  }

  private isPressureCeilingTriggered(measuredInputTokens: number | undefined): boolean {
    return this.pressureCeilingTokens !== null
      && typeof measuredInputTokens === 'number'
      && Number.isFinite(measuredInputTokens)
      && measuredInputTokens >= this.pressureCeilingTokens;
  }

  private pressureStats(
    pressureCeilingTriggered: boolean,
  ): Partial<Pick<FoldStats, 'pressureCeilingTokens' | 'pressureCeilingTriggered'>> {
    if (this.pressureCeilingTokens === null) return {};
    return {
      pressureCeilingTokens: this.pressureCeilingTokens,
      pressureCeilingTriggered,
    };
  }

  /**
   * Prepare the message array to send this turn. Reuses the byte-identical frozen
   * prefix while the provider cache is hot; recomputes the fold only at an epoch.
   *
   * @param messages the FULL provider-shaped history (raw, append-only).
   * @param context optional thinning mode + currently-claimed paths (paths whose
   *   tool results should never fold). Both default to empty.
   */
  prepare(messages: FoldMessage[], context: FoldPrepareContext = {}): FoldOutcome {
    const now = this.clock();
    const totalTurns = detectTurns(messages).length;
    const durableCursorIndex = context.durableCursorIndex ?? messages.length;
    const pressureCeilingTriggered = this.isPressureCeilingTriggered(context.measuredInputTokens);
    // Rewind self-heal. A SHRINK in raw count (turns removed) drops now-stale
    // eviction ordinals before they can mis-tombstone the wrong turns. EDGE
    // (no-freeze path only): this length check cannot see a SAME-LENGTH in-place
    // history replacement — only the freeze path's evaluateFoldFreeze boundary
    // role/char/hash guard detects that and forces a recompute (which resets the
    // eviction frame). With freeze:false, a same-length rewrite would leave
    // tombstone ordinals aligned to the OLD turns; this is safe only because
    // FoldSession's contract is append-only raw history. Hosts that mutate history
    // in place must keep freeze enabled (the default) to stay eviction-correct.
    if (messages.length < this.lastPreparedRawCount) {
      this.resetEvictionState();
    }
    this.lastPreparedRawCount = messages.length;

    if (!this.freezeEnabled) {
      const upcomingEpoch = this.foldEpochs + 1;
      const result = foldContext(
        messages,
        this.resolveTurnsToFold(messages),
        this.foldConfig,
        this.buildFoldEvictionInput(messages, durableCursorIndex, upcomingEpoch, now),
      );
      this.commitEvictionEpoch(result, upcomingEpoch);
      return {
        messages: result.messages,
        cacheHot: false,
        result,
        stats: {
          ...this.statsFromResult(totalTurns, false, result, pressureCeilingTriggered),
          ...(pressureCeilingTriggered ? { epochReason: 'pressure-ceiling' } : {}),
        },
      };
    }

    const ctx: FoldFreezeContext = {
      thinningMode: context.thinningMode ?? '',
      claimedPaths: context.claimedPaths ?? EMPTY_CLAIMED,
    };
    const decision = evaluateFoldFreeze(this.freezeState, messages, ctx, now, this.freezeConfig);

    if (decision.action === 'reuse' && !pressureCeilingTriggered) {
      touchFoldFreeze(this.freezeState, now);
      return {
        messages: decision.view,
        cacheHot: true,
        stats: {
          totalTurns,
          cacheHot: true,
          hotReuses: this.freezeState.hotReuses,
          epochs: this.freezeState.epochs,
          ...this.pressureStats(false),
        },
      };
    }

    const recomputeReason = decision.action === 'recompute' ? decision.reason : undefined;
    if (recomputeReason === 'history-rewound' || recomputeReason === 'boundary-mismatch') {
      this.resetEvictionState();
    }
    const upcomingEpoch = this.foldEpochs + 1;
    const result = foldContext(
      messages,
      this.resolveTurnsToFold(messages),
      this.foldConfig,
      this.buildFoldEvictionInput(messages, durableCursorIndex, upcomingEpoch, now),
    );
    commitFoldFreeze(this.freezeState, messages, result.messages, ctx, now);
    this.commitEvictionEpoch(result, this.freezeState.epochs);
    const epochReason = pressureCeilingTriggered
      ? recomputeReason ? `pressure-ceiling+${recomputeReason}` : 'pressure-ceiling'
      : recomputeReason;
    return {
      messages: result.messages,
      cacheHot: false,
      result,
      stats: {
        ...this.statsFromResult(totalTurns, false, result, pressureCeilingTriggered),
        ...(epochReason ? { epochReason } : {}),
      },
    };
  }

  /** Freeze-layer telemetry: hot reuses since last epoch, lifetime epochs, frozen size. */
  get telemetry(): {
    hotReuses: number;
    epochs: number;
    frozenViewChars: number;
    frozenRawCount: number;
    evictedSpanCount: number;
    evictedTurnCount: number;
  } {
    return {
      hotReuses: this.freezeState.hotReuses,
      epochs: this.freezeState.epochs,
      frozenViewChars: this.freezeState.frozenViewChars,
      frozenRawCount: this.freezeState.frozenRawCount,
      evictedSpanCount: this.foldEvictedSpans.length,
      evictedTurnCount: this.foldEvictedSpans.reduce((sum, span) => sum + span.turnCount, 0),
    };
  }

  private statsFromResult(
    totalTurns: number,
    cacheHot: boolean,
    result: FoldResult,
    pressureCeilingTriggered = false,
  ): FoldStats {
    return {
      totalTurns,
      cacheHot,
      turnsFolded: result.turnsFolded,
      originalChars: result.originalChars,
      foldedChars: result.foldedChars,
      savingsPercent: result.savingsPercent,
      hotReuses: this.freezeState.hotReuses,
      epochs: this.freezeState.epochs,
      newlyEvictedTurns: result.newlyEvictedTurns,
      evictedSpanCount: result.evictedSpans?.length,
      ...this.pressureStats(pressureCeilingTriggered),
    };
  }
}
