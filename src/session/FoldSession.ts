/**
 * FoldSession — the reference orchestrator that wires the context-warp-drive engine
 * into any function-calling agent loop.
 *
 * It distills the production compaction seam into one provider-agnostic helper:
 * every turn you hand it your full provider-shaped
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
  DEFAULT_FOLD_CONFIG,
  type FoldMessage,
  type FoldConfig,
  type FoldResult,
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
  /** Clock injection for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number;
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
  private readonly clock: () => number;

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

  /**
   * Prepare the message array to send this turn. Reuses the byte-identical frozen
   * prefix while the provider cache is hot; recomputes the fold only at an epoch.
   *
   * @param messages the FULL provider-shaped history (raw, append-only).
   * @param context optional thinning mode + currently-claimed paths (paths whose
   *   tool results should never fold). Both default to empty.
   */
  prepare(messages: FoldMessage[], context: Partial<FoldFreezeContext> = {}): FoldOutcome {
    const now = this.clock();
    const totalTurns = detectTurns(messages).length;

    if (!this.freezeEnabled) {
      const result = foldContext(messages, this.resolveTurnsToFold(messages), this.foldConfig);
      return {
        messages: result.messages,
        cacheHot: false,
        result,
        stats: this.statsFromResult(totalTurns, false, result),
      };
    }

    const ctx: FoldFreezeContext = {
      thinningMode: context.thinningMode ?? '',
      claimedPaths: context.claimedPaths ?? EMPTY_CLAIMED,
    };
    const decision = evaluateFoldFreeze(this.freezeState, messages, ctx, now, this.freezeConfig);

    if (decision.action === 'reuse') {
      touchFoldFreeze(this.freezeState, now);
      return {
        messages: decision.view,
        cacheHot: true,
        stats: {
          totalTurns,
          cacheHot: true,
          hotReuses: this.freezeState.hotReuses,
          epochs: this.freezeState.epochs,
        },
      };
    }

    const result = foldContext(messages, this.resolveTurnsToFold(messages), this.foldConfig);
    commitFoldFreeze(this.freezeState, messages, result.messages, ctx, now);
    return {
      messages: result.messages,
      cacheHot: false,
      result,
      stats: { ...this.statsFromResult(totalTurns, false, result), epochReason: decision.reason },
    };
  }

  /** Freeze-layer telemetry: hot reuses since last epoch, lifetime epochs, frozen size. */
  get telemetry(): { hotReuses: number; epochs: number; frozenViewChars: number; frozenRawCount: number } {
    return {
      hotReuses: this.freezeState.hotReuses,
      epochs: this.freezeState.epochs,
      frozenViewChars: this.freezeState.frozenViewChars,
      frozenRawCount: this.freezeState.frozenRawCount,
    };
  }

  private statsFromResult(totalTurns: number, cacheHot: boolean, result: FoldResult): FoldStats {
    return {
      totalTurns,
      cacheHot,
      turnsFolded: result.turnsFolded,
      originalChars: result.originalChars,
      foldedChars: result.foldedChars,
      savingsPercent: result.savingsPercent,
      hotReuses: this.freezeState.hotReuses,
      epochs: this.freezeState.epochs,
    };
  }
}
