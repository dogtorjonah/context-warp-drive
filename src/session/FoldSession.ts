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
  DEFAULT_FOLD_EVICT_THRESHOLD_CHARS,
  DEFAULT_ASSISTANT_TEXT_BUDGET,
  resolveFoldConfigForBand,
  type FoldMessage,
  type FoldConfig,
  type FoldResult,
  type FoldEvictionInput,
  type FoldEvictionSpan,
  type FidelityOverrides,
  type FidelityValueWeights,
  type FoldFidelityValueInput,
  type SyntheticContextOptions,
} from '../rollingFold.ts';
import { computeOpenBurst } from '../foldEpisodeCapture.ts';
import {
  createFoldFreezeState,
  evaluateFoldFreeze,
  commitFoldFreeze,
  appendFoldFreezeTailEpoch,
  touchFoldFreeze,
  DEFAULT_FOLD_FREEZE_CONFIG,
  type FoldFreezeState,
  type FoldFreezeConfig,
  type FoldFreezeContext,
} from '../foldFreeze.ts';
import {
  DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS,
  DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS,
  DEFAULT_CONTEXT_BUDGET_SYSTEM_TOOLS_RESERVE_TOKENS,
  DEFAULT_CONTEXT_BUDGET_TARGET_BAND_TOKENS,
  DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_MIN_RUNWAY_TOKENS,
  DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_RUNWAY_TOKENS,
} from '../contextBudget.ts';
import {
  renderUserMessageVault,
  recordUserMessageVaultEntry,
  recordAssistantGlyphVaultEntry,
  appendUserMessageVaultToView,
  selectVaultRows,
  selectVaultDeltaRows,
  renderVaultRowsBlock,
  vaultRowFingerprint,
  type UserMessageVaultEntry,
  type AssistantGlyphVaultEntry,
} from '../userMessageVault.ts';

const EMPTY_CLAIMED: ReadonlySet<string> = new Set<string>();
// Standalone Context Warp geometry signposts:
//   S = system/tools reserve before folded memory
//   M = full-recompute folded memory band
//   A = expected appended folded-tail band
//   T = preferred/default next live-tail runway
//   F = hard minimum append runway
//   P = measured pressure ceiling
//
// Runtime invariant: append a folded tail band only when
//   P - (S + M + stacked A bands) >= F.
// Otherwise the tail-epoch boundary becomes a full recompute and saws back down.
export const DEFAULT_FOLD_PRESSURE_CEILING_TOKENS = DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS;
export const DEFAULT_FOLD_SYSTEM_TOOLS_RESERVE_TOKENS = DEFAULT_CONTEXT_BUDGET_SYSTEM_TOOLS_RESERVE_TOKENS;
export const DEFAULT_FOLD_TARGET_BAND_TOKENS = DEFAULT_CONTEXT_BUDGET_TARGET_BAND_TOKENS;
export const DEFAULT_FOLD_APPEND_BAND_TARGET_TOKENS = DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS;
export const DEFAULT_FOLD_TAIL_EPOCH_RUNWAY_TOKENS = DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_RUNWAY_TOKENS;
export const DEFAULT_FOLD_TAIL_EPOCH_MIN_RUNWAY_TOKENS = DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_MIN_RUNWAY_TOKENS;

/**
 * Default retention fractions of the fold band (mirrors rollingFold's
 * resolveFoldBandBudgets defaults). A governor fidelity override is expressed
 * relative to these, so FoldSession can scale a fully-resolved base config
 * without knowing the original band size.
 */
const DEFAULT_FULL_RETENTION_FRACTION = 0.125;
const DEFAULT_ESSENCE_RETENTION_FRACTION = 0.25;

function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface FoldPressureCeilingConfig {
  /**
   * Absolute measured input-token ceiling. FoldSession never estimates tokens:
   * hosts pass measured provider/relay input tokens via prepare().
   */
  readonly tokens?: number;
}

export interface FoldTailEpochRunwayConfig {
  /** S: modeled system/tools prefix reserve tokens. */
  readonly systemToolsReserveTokens?: number;
  /** M: modeled folded memory band after a full recompute. */
  readonly targetBandTokens?: number;
  /** A: modeled size of one appended folded-tail band. */
  readonly appendBandTargetTokens?: number;
  /** T: preferred/default next raw-tail runway used for geometry signposts. */
  readonly runwayTokens?: number;
  /** F: hard minimum next raw-tail runway that must remain after an append. */
  readonly minRunwayTokens?: number;
}

export interface FoldSessionOptions {
  /**
   * Rolling-fold config. Defaults to the standalone tuned M40 always-on fold
   * config. Pass an explicit config when you need legacy threshold-gated folding
   * or a wider active window.
   */
  readonly foldConfig?: FoldConfig;
  /**
   * Quality-driven fidelity override (session default). Sets what fraction of
   * the band stays at full / essence retention, independent of band size. The
   * governor (governByTrace) can also supply this per-turn via
   * {@link FoldPrepareContext.fidelity}; a per-turn value takes precedence.
   * Applied only at epoch boundaries (cache-safe).
   */
  readonly fidelity?: FidelityOverrides | null;
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
   * 150k measured input tokens; pass false to disable or a number/config to
   * tune. The host must pass measuredInputTokens to prepare() for it to fire.
   */
  readonly pressureCeiling?: false | number | FoldPressureCeilingConfig;
  /**
   * Standalone S/M/A/T/F runway geometry for append-only tail epochs. Defaults
   * to S37/M40/A5/T45/F30; pass false to disable the runway gate while keeping
   * ordinary pressure-ceiling recomputes.
   */
  readonly tailEpochRunway?: false | FoldTailEpochRunwayConfig;

  /**
   * Read-burst fold guard (rail-f1b6c230). When `true`, an epoch-time fold keeps
   * the still-open read-burst — the trailing window of co-activated file touches
   * the episode segmenter would defer — inside the active (unfolded) window, so a
   * multi-file read is not skeletonized mid-burst (the moment that costs the most
   * cross-reference fidelity). Reuses {@link computeOpenBurst} UNCHANGED: no
   * topic-shift seal, because empirically agent bursts are inherently multi-dir
   * (79-84%) and a directory/cluster seal over-fragments them 9-13x. Growth is
   * bounded by the segmenter's maxBurst caps and the guard is always vetoed by the
   * measured pressure ceiling — a deferral, not an absolute pin. Default `false`.
   */
  readonly readBurstGuard?: boolean;
  /**
   * Intrinsic value-aware graduated fidelity (cherry-picked, full-recompute
   * only). When `enabled`, a freeze EPOCH full-recompute spends the same
   * full/essence budget by intrinsic trace value (forward path re-reference +
   * durable glyph) past a recency floor, instead of the pure newest-first ramp.
   * Append/hot-reuse never apply it. Default OFF (byte-identical fold).
   */
  readonly valueFidelity?: {
    readonly enabled?: boolean;
    readonly weights?: Partial<FidelityValueWeights>;
    readonly recencyFloorTurns?: number;
  };
  /**
   * Host-supplied synthetic user-context markers to exclude from turn detection
   * and fold text mining. Defaults empty so the package remains host-neutral.
   */
  readonly syntheticContext?: SyntheticContextOptions;
  /**
   * Glyph Grammar Vault companion. Off by default. When enabled, FoldSession
   * keeps a bounded buffer of recent operator messages and the agent's own
   * recent glyph-tagged turns (fed via {@link FoldSession.recordOperatorMessage}
   * / {@link FoldSession.recordAssistantMessage}) and appends a rendered vault
   * block to the OUTGOING send view each turn — never the raw history. The block
   * lands on the newest text-bearing user turn (structurally in the cache-miss
   * raw tail), so a hot frozen prefix stays byte-identical. It self-gates:
   * messages still visible verbatim in the view dedupe out, so pre-fold the
   * vault renders empty.
   */
  readonly vault?: boolean | FoldVaultConfig;
  /** Clock injection for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number;
}

export interface FoldVaultConfig {
  /**
   * Bound the vault append to the newest `tailWindow` messages of the send view
   * for extra cache-tail safety. Optional — the newest user turn is already
   * structurally in the raw tail, so the default (unbounded scan from newest)
   * is cache-safe on append-only history.
   */
  readonly tailWindow?: number;
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
  /**
   * Quality-driven fidelity override for THIS turn — typically the governor's
   * `decision.fidelity` from {@link governByTrace}. Scales the full/essence
   * retention budget without changing band size. Applied only when this turn
   * triggers a fold epoch (never mid hot-reuse), mirroring the relay's
   * epoch-gated band/fidelity application. `undefined` keeps the last value;
   * `null` clears any override back to the base config.
   */
  readonly fidelity?: FidelityOverrides | null;
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
  /**
   * Message index of the sealed freeze boundary — the last message of the frozen
   * prefix band. Pass this to your provider's cache-breakpoint helper (e.g.
   * `applyCacheBreakpoints` from `providers/anthropic`) so the frozen prefix is
   * cached by the provider and reads back at 0.1× on subsequent hot reuses.
   * `null` when no append-only boundary has been established yet (first epoch
   * or freeze disabled).
   */
  readonly sealedBoundary?: number | null;
  /**
   * The fidelity ratios actually baked into the CURRENT view (the override in
   * effect since the last fold epoch). Echoes the governor's applied
   * recommendation for observability; `null` when no override is active (base
   * config). Updated only at epoch boundaries — on a hot reuse it reflects the
   * value from the last fold.
   */
  readonly appliedFidelity?: FidelityOverrides | null;
  /**
   * The rendered Glyph Grammar Vault block appended to `messages` this turn, when
   * the vault companion is enabled and produced a non-empty block. Omitted when
   * the vault is off or self-gated to empty.
   */
  readonly vault?: string;
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
  private readonly tailEpochSystemToolsReserveTokens: number;
  private readonly tailEpochTargetBandTokens: number;
  private readonly tailEpochAppendBandTargetTokens: number;
  private readonly tailEpochRunwayTokens: number | null;
  private readonly tailEpochMinRunwayTokens: number | null;
  private readonly readBurstGuardEnabled: boolean;
  private readonly valueFidelityInput: FoldFidelityValueInput | undefined;
  private readonly syntheticContext: SyntheticContextOptions;
  private readonly clock: () => number;
  private readonly vaultEnabled: boolean;
  private readonly vaultTailWindow: number | undefined;
  private readonly userMessageVaultEntries: UserMessageVaultEntry[] = [];
  private readonly assistantGlyphVaultEntries: AssistantGlyphVaultEntry[] = [];
  private foldEpochs = 0;
  private foldEvictedSpans: FoldEvictionSpan[] = [];
  private foldEpochFrontiers: Array<{ epoch: number; turnsFolded: number }> = [];
  private lastPreparedRawCount = 0;
  private activeFidelity: FidelityOverrides | null = null;

  constructor(options: FoldSessionOptions = {}) {
    this.foldConfig = options.foldConfig ?? resolveFoldConfigForBand(DEFAULT_FOLD_TARGET_BAND_TOKENS);
    this.activeFidelity = options.fidelity ?? null;
    this.readBurstGuardEnabled = options.readBurstGuard === true;
    this.valueFidelityInput = options.valueFidelity?.enabled === true
      ? { weights: options.valueFidelity.weights, recencyFloorTurns: options.valueFidelity.recencyFloorTurns }
      : undefined;
    this.syntheticContext = options.syntheticContext ?? {};
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
    if (options.tailEpochRunway === false) {
      this.tailEpochRunwayTokens = null;
      this.tailEpochMinRunwayTokens = null;
      this.tailEpochSystemToolsReserveTokens = DEFAULT_FOLD_SYSTEM_TOOLS_RESERVE_TOKENS;
      this.tailEpochTargetBandTokens = DEFAULT_FOLD_TARGET_BAND_TOKENS;
      this.tailEpochAppendBandTargetTokens = DEFAULT_FOLD_APPEND_BAND_TARGET_TOKENS;
    } else {
      const runway = options.tailEpochRunway ?? {};
      this.tailEpochRunwayTokens = positiveFinite(runway.runwayTokens, DEFAULT_FOLD_TAIL_EPOCH_RUNWAY_TOKENS);
      this.tailEpochMinRunwayTokens = positiveFinite(
        runway.minRunwayTokens,
        runway.runwayTokens === undefined
          ? Math.min(this.tailEpochRunwayTokens, DEFAULT_FOLD_TAIL_EPOCH_MIN_RUNWAY_TOKENS)
          : this.tailEpochRunwayTokens,
      );
      this.tailEpochSystemToolsReserveTokens = positiveFinite(
        runway.systemToolsReserveTokens,
        DEFAULT_FOLD_SYSTEM_TOOLS_RESERVE_TOKENS,
      );
      this.tailEpochTargetBandTokens = positiveFinite(runway.targetBandTokens, DEFAULT_FOLD_TARGET_BAND_TOKENS);
      this.tailEpochAppendBandTargetTokens = positiveFinite(
        runway.appendBandTargetTokens,
        DEFAULT_FOLD_APPEND_BAND_TARGET_TOKENS,
      );
    }
    if (options.vault === true) {
      this.vaultEnabled = true;
      this.vaultTailWindow = undefined;
    } else if (options.vault && typeof options.vault === 'object') {
      this.vaultEnabled = true;
      this.vaultTailWindow = typeof options.vault.tailWindow === 'number' && Number.isFinite(options.vault.tailWindow)
        ? options.vault.tailWindow
        : undefined;
    } else {
      this.vaultEnabled = false;
      this.vaultTailWindow = undefined;
    }
    this.freezeState = createFoldFreezeState();
    this.clock = options.now ?? Date.now;
  }

  /**
   * Record a genuine operator/user message into the vault buffer. No-op unless
   * the vault companion is enabled. Bounded + deduped at render.
   */
  recordOperatorMessage(text: string, createdAt?: string): void {
    if (!this.vaultEnabled) return;
    recordUserMessageVaultEntry(this.userMessageVaultEntries, text, createdAt);
  }

  /**
   * Record a completed assistant message into the glyph vault buffer (its
   * opening register is classified for scarce-slot priority). No-op unless the
   * vault companion is enabled.
   */
  recordAssistantMessage(text: string, createdAt?: string): void {
    if (!this.vaultEnabled) return;
    recordAssistantGlyphVaultEntry(this.assistantGlyphVaultEntries, text, createdAt);
  }

  /**
   * Append the rendered Glyph Grammar Vault to the outgoing send view (never the
   * raw history). Passing the view as visibleUserMessages self-gates the vault:
   * any operator/assistant text still present verbatim in the view dedupes out,
   * so pre-fold (everything still visible) the vault renders empty.
   */
  private applyVault(outcome: FoldOutcome): FoldOutcome {
    if (!this.vaultEnabled) return outcome;
    const vault = renderUserMessageVault(this.userMessageVaultEntries, {
      visibleUserMessages: outcome.messages,
      assistantEntries: this.assistantGlyphVaultEntries,
    });
    if (!vault) return outcome;
    const messages = appendUserMessageVaultToView(outcome.messages, vault, this.vaultTailWindow);
    if (messages === outcome.messages) return { ...outcome, vault };
    return { ...outcome, messages, vault };
  }

  /**
   * Bake the vault INTO a folded view before it is sealed into the frozen prefix,
   * so the vault rides the cached prefix at no per-send cost (vs. the legacy
   * per-send tail append). mode='full' renders the whole selection and resets the
   * sealed set (matches commitFoldFreeze clearing sealedBands); mode='delta'
   * renders only the rows not yet sealed into an earlier band this freeze
   * generation. The block is appended to the newest text-bearing message of
   * `view` (alternation-safe, like applyVault) and opens with
   * USER_MESSAGE_VAULT_PREFIX so the fold pipeline treats it as synthetic context
   * (skipped by turn detection / eviction / recall). Never mutates raw history.
   */
  private bakeVault(view: FoldMessage[], mode: 'full' | 'delta'): FoldMessage[] {
    if (!this.vaultEnabled) return view;
    const rows = selectVaultRows(this.userMessageVaultEntries, this.assistantGlyphVaultEntries, {
      visibleUserMessages: view,
    });
    if (mode === 'full') this.freezeState.sealedVaultFingerprints.clear();
    const bakeRows = mode === 'full' ? rows : selectVaultDeltaRows(rows, this.freezeState.sealedVaultFingerprints);
    if (bakeRows.length === 0) return view;
    const block = renderVaultRowsBlock(bakeRows, mode);
    if (!block) return view;
    for (const row of bakeRows) this.freezeState.sealedVaultFingerprints.add(vaultRowFingerprint(row));
    return appendUserMessageVaultToView(view, block);
  }

  /** Count conversational turns in a provider-shaped message array. */
  countTurns(messages: FoldMessage[]): number {
    return detectTurns(messages, this.syntheticContext).length;
  }

  private resolveTurnsToFold(messages: FoldMessage[], explicit?: number): number {
    const total = detectTurns(messages, this.syntheticContext).length;
    return typeof explicit === 'number'
      ? Math.max(0, Math.min(explicit, total))
      : Math.max(0, total - this.foldConfig.activeWindowTurns);
  }

  /**
   * Read-burst guard: cap turnsToFold so the still-open read-burst stays in the
   * active (unfolded) window. Called only at the two epoch sites (never on the hot
   * reuse path), so computeOpenBurst runs only when a fold actually happens.
   *
   * No-op unless readBurstGuard is enabled, when the pressure ceiling is triggered
   * (GOD-RULE-7: measured tokens only — the ceiling overrides the guard so a runaway
   * burst can never breach the token wall), or when there is nothing to fold. The
   * open burst is the episode co-activation zone, UNCHANGED (no topic-shift seal).
   * Release is emergent and free: when a following burst forms the open burst
   * advances and turnsToFold climbs back (one clean epoch); a settled/abandoned
   * burst yields via computeOpenBurst returning null; growth is bounded by the
   * segmenter's maxBurst caps. floor <= base always, so this can only DEFER a fold.
   */
  private guardedTurnsToFold(messages: FoldMessage[], pressureCeilingTriggered: boolean): number {
    const base = this.resolveTurnsToFold(messages);
    if (!this.readBurstGuardEnabled || pressureCeilingTriggered || base <= 0) return base;
    const { openBurstStartIndex } = computeOpenBurst(messages);
    if (openBurstStartIndex === null) return base;
    const turns = detectTurns(messages, this.syntheticContext);
    let floor = 0;
    for (const turn of turns) {
      if (turn.endIndex <= openBurstStartIndex) floor += 1;
      else break;
    }
    return Math.min(base, floor);
  }

  /**
   * Apply a governor fidelity override to the base fold config. The override is
   * expressed as a FRACTION of the band; FoldSession owns a fully-resolved config
   * (not a band), so it scales the base assistant-text budget by the override
   * fraction relative to the default fraction. When the base config was built via
   * resolveFoldConfigForBand (the standard path), this reproduces bandChars ×
   * fraction exactly; for any other base it scales proportionally. A null/empty
   * override returns the base config unchanged.
   *
   * Cache-safe: only ever called on an epoch (fresh fold), never on a hot reuse,
   * so the frozen prefix never changes mid-cache — mirroring the relay's
   * epoch-gated band/fidelity application in fcBaseSession.
   */
  private effectiveFoldConfig(fidelity: FidelityOverrides | null): FoldConfig {
    if (
      !fidelity ||
      (fidelity.fullRetentionFraction === undefined && fidelity.essenceRetentionFraction === undefined)
    ) {
      return this.foldConfig;
    }
    const base = this.foldConfig.assistantTextBudget ?? DEFAULT_ASSISTANT_TEXT_BUDGET;
    const fullRetentionChars =
      fidelity.fullRetentionFraction !== undefined
        ? Math.round(base.fullRetentionChars * (fidelity.fullRetentionFraction / DEFAULT_FULL_RETENTION_FRACTION))
        : base.fullRetentionChars;
    const essenceRetentionChars =
      fidelity.essenceRetentionFraction !== undefined
        ? Math.round(base.essenceRetentionChars * (fidelity.essenceRetentionFraction / DEFAULT_ESSENCE_RETENTION_FRACTION))
        : base.essenceRetentionChars;
    return { ...this.foldConfig, assistantTextBudget: { fullRetentionChars, essenceRetentionChars } };
  }

  /**
   * Run the rolling fold once, WITHOUT the freeze cache layer. Use this for a
   * one-shot compaction or when you manage cache reuse yourself. For a live loop,
   * prefer {@link prepare}.
   */
  fold(messages: FoldMessage[], turnsToFold?: number): FoldResult {
    return foldContext(
      messages,
      this.resolveTurnsToFold(messages, turnsToFold),
      this.foldConfig,
      undefined,
      undefined,
      undefined,
      this.syntheticContext,
    );
  }

  private resetEvictionState(): void {
    this.foldEpochs = 0;
    this.foldEvictedSpans = [];
    this.foldEpochFrontiers = [];
  }

  private hasVaultBackedEvictionCoverage(): boolean {
    return this.vaultEnabled
      && (this.userMessageVaultEntries.length > 0 || this.assistantGlyphVaultEntries.length > 0);
  }

  private buildFoldEvictionInput(
    messages: FoldMessage[],
    durableCursorIndex: number,
    upcomingEpoch: number,
    now: number,
    options: {
      readonly allowVaultBackedCoverage?: boolean;
      readonly targetSafeFrontier?: boolean;
    } = {},
  ): FoldEvictionInput | undefined {
    if (!this.evictionEnabled || this.evictionThresholdChars <= 0) return undefined;
    const hasSpans = this.foldEvictedSpans.length > 0;
    const effectiveDurableCursorIndex = Math.max(
      durableCursorIndex,
      options.allowVaultBackedCoverage && this.hasVaultBackedEvictionCoverage() ? messages.length : 0,
    );
    const evictableThroughOrdinal = computeEvictableThroughOrdinal(
      detectTurns(messages, this.syntheticContext),
      effectiveDurableCursorIndex,
      this.foldEpochFrontiers,
      upcomingEpoch,
    );
    if (evictableThroughOrdinal <= 0 && !hasSpans) return undefined;
    return {
      evictedSpans: this.foldEvictedSpans,
      evictableThroughOrdinal,
      ...(options.targetSafeFrontier ? { targetEvictThroughOrdinal: evictableThroughOrdinal } : {}),
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

  private tailEpochRunwayCheck(): {
    readonly ok: boolean;
    readonly sealedAppendBandCount: number;
    readonly postAppendModeledTokens: number | null;
    readonly postAppendRunwayTokens: number | null;
    readonly requiredRunwayTokens: number | null;
  } {
    const sealedAppendBandCount = this.freezeState.sealedBands.length;
    if (this.pressureCeilingTokens === null || this.tailEpochMinRunwayTokens === null) {
      return {
        ok: true,
        sealedAppendBandCount,
        postAppendModeledTokens: null,
        postAppendRunwayTokens: null,
        requiredRunwayTokens: this.tailEpochMinRunwayTokens,
      };
    }
    const postAppendModeledTokens =
      this.tailEpochSystemToolsReserveTokens
      + this.tailEpochTargetBandTokens
      + ((sealedAppendBandCount + 1) * this.tailEpochAppendBandTargetTokens);
    const postAppendRunwayTokens = this.pressureCeilingTokens - postAppendModeledTokens;
    return {
      ok: postAppendRunwayTokens >= this.tailEpochMinRunwayTokens,
      sealedAppendBandCount,
      postAppendModeledTokens,
      postAppendRunwayTokens,
      requiredRunwayTokens: this.tailEpochMinRunwayTokens,
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
    const totalTurns = detectTurns(messages, this.syntheticContext).length;
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

    // Quality-driven fidelity override. Resolved once per turn but APPLIED only
    // at an epoch (fresh fold) — a hot reuse keeps the frozen prefix byte-identical
    // (cache-safe), so a mid-reuse fidelity change waits for the next epoch.
    // undefined = keep last applied; null/value = set. Mirrors the relay's
    // epoch-gated band/fidelity application.
    const desiredFidelity = context.fidelity === undefined ? this.activeFidelity : context.fidelity;

    if (!this.freezeEnabled) {
      this.activeFidelity = desiredFidelity;
      const upcomingEpoch = this.foldEpochs + 1;
      const result = foldContext(
        messages,
        this.guardedTurnsToFold(messages, pressureCeilingTriggered),
        this.effectiveFoldConfig(desiredFidelity),
        this.buildFoldEvictionInput(messages, durableCursorIndex, upcomingEpoch, now, {
          allowVaultBackedCoverage: pressureCeilingTriggered,
          targetSafeFrontier: pressureCeilingTriggered,
        }),
        undefined,
        undefined,
        this.syntheticContext,
        this.valueFidelityInput,
      );
      this.commitEvictionEpoch(result, upcomingEpoch);
      return this.applyVault({
        messages: result.messages,
        cacheHot: false,
        result,
        appliedFidelity: this.activeFidelity,
        stats: {
          ...this.statsFromResult(totalTurns, false, result, pressureCeilingTriggered),
          ...(pressureCeilingTriggered ? { epochReason: 'pressure-ceiling' } : {}),
        },
      });
    }

    const ctx: FoldFreezeContext = {
      thinningMode: context.thinningMode ?? '',
      claimedPaths: context.claimedPaths ?? EMPTY_CLAIMED,
    };
    const decision = evaluateFoldFreeze(this.freezeState, messages, ctx, now, this.freezeConfig);

    if (decision.action === 'reuse' && !pressureCeilingTriggered) {
      touchFoldFreeze(this.freezeState, now);
      // Vault already lives in the cached frozen prefix (baked at the last
      // epoch) — hot reuse re-sends it for free, with no per-send re-render or
      // tail append. The byte-frozen prefix stays identical across reuses.
      return {
        messages: decision.view,
        cacheHot: true,
        sealedBoundary: this.freezeState.lastAppendBoundaryViewCount ?? null,
        appliedFidelity: this.activeFidelity,
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
    this.activeFidelity = desiredFidelity;
    const runway = this.tailEpochRunwayCheck();
    const upcomingEpoch = this.foldEpochs + 1;
    const appendOnlyTailEpoch = recomputeReason === 'tail-epoch'
      && !pressureCeilingTriggered
      && runway.ok;
    if (appendOnlyTailEpoch) {
      const tail = messages.slice(this.freezeState.frozenRawCount);
      const tailResult = foldContext(
        tail,
        this.guardedTurnsToFold(tail, false),
        this.effectiveFoldConfig(desiredFidelity),
        undefined,
        undefined,
        undefined,
        this.syntheticContext,
      );
      // Seal only the per-band DELTA (rows not already sealed into an earlier
      // band) into this folded tail band before it joins the byte-frozen prefix.
      const sealedTail = this.bakeVault(tailResult.messages, 'delta');
      const appendCommit = appendFoldFreezeTailEpoch(this.freezeState, messages, sealedTail, ctx, now);
      if (appendCommit) {
        this.commitEvictionEpoch(tailResult, this.freezeState.epochs);
        return {
          messages: appendCommit.view,
          cacheHot: false,
          sealedBoundary: appendCommit.sealedPrefixMessageCount,
          result: tailResult,
          appliedFidelity: this.activeFidelity,
          stats: {
            ...this.statsFromResult(totalTurns, false, tailResult, false),
            epochReason: 'tail-epoch-append',
          },
        };
      }
    }
    const result = foldContext(
      messages,
      this.guardedTurnsToFold(messages, pressureCeilingTriggered),
      this.effectiveFoldConfig(desiredFidelity),
      this.buildFoldEvictionInput(messages, durableCursorIndex, upcomingEpoch, now, {
        allowVaultBackedCoverage: pressureCeilingTriggered,
        targetSafeFrontier: pressureCeilingTriggered,
      }),
      undefined,
      undefined,
      this.syntheticContext,
      this.valueFidelityInput,
    );
    // Full recompute: render the whole vault and bake it into the frozen view
    // before sealing (resets the sealed set, mirroring commitFoldFreeze clearing
    // sealedBands). Subsequent append epochs seal only deltas on top of this.
    const sealedView = this.bakeVault(result.messages, 'full');
    commitFoldFreeze(this.freezeState, messages, sealedView, ctx, now);
    this.commitEvictionEpoch(result, this.freezeState.epochs);
    const epochReason = pressureCeilingTriggered
      ? recomputeReason ? `pressure-ceiling+${recomputeReason}` : 'pressure-ceiling'
      : recomputeReason === 'tail-epoch' && !runway.ok
        ? `tail-runway-gate+${recomputeReason}`
        : recomputeReason;
    return {
      messages: sealedView,
      cacheHot: false,
      sealedBoundary: this.freezeState.lastAppendBoundaryViewCount ?? null,
      result,
      appliedFidelity: this.activeFidelity,
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
