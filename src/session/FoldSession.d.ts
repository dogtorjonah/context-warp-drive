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
import { type FoldMessage, type FoldConfig, type FoldResult, type FoldEvictionOutcome, type FidelityOverrides, type FidelityValueWeights, type SyntheticContextOptions } from '../rollingFold.ts';
import { type FoldFreezeConfig, type FoldFreezeContext, type FoldFreezeAppendSkipReason } from '../foldFreeze.ts';
export declare const DEFAULT_FOLD_PRESSURE_CEILING_TOKENS = 180000;
export declare const DEFAULT_FOLD_SYSTEM_TOOLS_RESERVE_TOKENS = 37000;
export declare const DEFAULT_FOLD_TARGET_BAND_TOKENS = 40000;
export declare const DEFAULT_FOLD_APPEND_BAND_TARGET_TOKENS = 5000;
export declare const DEFAULT_FOLD_TAIL_EPOCH_RUNWAY_TOKENS = 10000;
export declare const DEFAULT_FOLD_TAIL_EPOCH_MIN_RUNWAY_TOKENS = 30000;
export interface FoldPressureCeilingConfig {
    /**
     * Absolute measured input-token ceiling. FoldSession never estimates tokens:
     * hosts pass measured provider/relay input tokens via prepare().
     */
    readonly tokens?: number;
}
export interface FoldTailEpochRunwayConfig {
    /** S: fallback modeled system/tools prefix reserve tokens. */
    readonly systemToolsReserveTokens?: number;
    /** M: fallback modeled folded memory band after a whole-view rebuild. */
    readonly targetBandTokens?: number;
    /** A: fallback modeled size of one appended folded-tail band. */
    readonly appendBandTargetTokens?: number;
    /** T: preferred/default next raw-tail runway used for geometry signposts. */
    readonly runwayTokens?: number;
    /** F: hard minimum next raw-tail runway that must remain after an append. */
    readonly minRunwayTokens?: number;
    /**
     * The resolved fold TRIGGER (not the hard ceiling) — the anchor for the
     * trigger-anchored post-fold-floor gate. When set alongside a captured
     * post-fold floor and ≥1 sealed band, the runway that matters becomes
     * TRIGGER − floor (CLI parity) instead of ceiling − current occupancy.
     * Omitted → the gate keeps its legacy ceiling-anchored measured/modeled
     * runway (no behavior change for hosts that do not configure it).
     */
    readonly foldTriggerTokens?: number;
}
export interface FoldSessionOptions {
    /**
     * Rolling-fold config. Defaults to the standalone tuned M40 always-on fold
     * config. Pass an explicit config when you need legacy threshold-gated folding
     * or a wider active window.
     */
    readonly foldConfig?: FoldConfig;
    /**
     * Host-specific fold-block preamble. Defaults to the package preamble; override
     * when the host cannot provide the package's default recall-card mechanics.
     */
    readonly foldBlockPreamble?: string;
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
     * detail back in. Whole-view rebuild epochs can target the oldest safe frontier
     * when the pressure ceiling reopens all raw history for tombstoning; pass
     * false to keep the fold block monotonic, or tune the threshold.
     */
    readonly eviction?: boolean | {
        readonly thresholdChars?: number;
    };
    /**
     * Absolute pressure guard for large-window models. Enabled by default at
     * 150k measured input tokens (the shared
     * DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS); pass false to disable or
     * a number/config to tune. The host must pass measuredInputTokens to
     * prepare() for it to fire.
     */
    readonly pressureCeiling?: false | number | FoldPressureCeilingConfig;
    /**
     * Standalone S/M/A/T/F fallback runway geometry for append-only tail epochs
     * when measuredInputTokens is absent. Defaults to effective S37/M40/A5/T10/F10;
     * pass false to disable the runway gate while keeping ordinary pressure-ceiling
     * recomputes.
     */
    readonly tailEpochRunway?: false | FoldTailEpochRunwayConfig;
    /**
     * Character budget for the standalone-computed raw hard-epoch seed used when
     * the host does not pass FoldPrepareContext.hardEpochSeed. This is a clamp for
     * local string size, not token telemetry. Defaults to the helper's 200K-char
     * budget.
     */
    readonly rawHardEpochSeedMaxChars?: number;
    /**
     * Read-burst fold guard. When `true`, an epoch-time fold keeps
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
     * Intrinsic value-aware graduated fidelity (cherry-picked, whole-view
     * rebuilds only). When `enabled`, a freeze EPOCH whole-view rebuild spends the same
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
     * Force the same raw hard-epoch path that measured pressure would trigger.
     * Use this when a host harness intentionally resets provider-visible context
     * (same-instance rebirth, manual compact/reset button, process handoff) and
     * wants the resulting seed sealed as the next provider-cache baseline without
     * pretending it has measured pressure telemetry.
     */
    readonly hardEpoch?: boolean;
    /**
     * Quality-driven fidelity override for THIS turn — typically the governor's
     * `decision.fidelity` from {@link governByTrace}. Scales the full/essence
     * retention budget without changing band size. Applied only when this turn
     * triggers a fold epoch (never mid hot-reuse), mirroring the relay's
     * epoch-gated band/fidelity application. `undefined` keeps the last value;
     * `null` clears any override back to the base config.
     */
    readonly fidelity?: FidelityOverrides | null;
    /**
     * Optional same-instance hard-epoch seed override. When measured pressure or
     * `hardEpoch: true` triggers a hard epoch, FoldSession replaces the entire
     * prepared view with a SINGLE compact continuity message and re-anchors the
     * freeze boundary around it. If this override is omitted, FoldSession computes
     * the raw seed synchronously from the supplied provider trace; richer hosts can
     * pass their own already-rendered raw package string here. The old raw
     * transcript remains recall backing.
     */
    readonly hardEpochSeed?: string | null;
}
export interface FoldStats {
    /** Total conversational turns detected in the history. */
    readonly totalTurns: number;
    /** True when the frozen prefix was reused byte-identical (provider cache stays hot). */
    readonly cacheHot: boolean;
    /** Recompute reason when this call was an epoch (not a hot reuse). */
    readonly epochReason?: string;
    /** Why an otherwise-due tail epoch deliberately stayed cache-hot. */
    readonly deferReason?: 'pending-tool-call' | 'live-user-anchor';
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
    readonly evictionOutcome?: FoldEvictionOutcome;
    /** Absolute measured-token ceiling telemetry when the pressure guard is enabled. */
    readonly pressureCeilingTokens?: number;
    readonly pressureCeilingTriggered?: boolean;
    /** Append-only tail epoch ROI decision for this call, when a tail epoch was considered. */
    readonly appendDecision?: 'committed' | 'skipped';
    readonly appendSkipReason?: FoldFreezeAppendSkipReason;
    readonly appendRawTailChars?: number;
    readonly appendBandChars?: number;
    readonly appendSavedChars?: number;
    readonly appendShrinkRatio?: number;
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
     * `null` when no cacheable boundary has been established yet (for example a
     * regular first fold epoch); a hard epoch exposes its single rebirth seed as
     * boundary `1` immediately when freeze is enabled.
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
export declare class FoldSession {
    private readonly foldConfig;
    private readonly freezeEnabled;
    private readonly freezeConfig;
    private readonly freezeState;
    private readonly evictionEnabled;
    private readonly evictionThresholdChars;
    private readonly pressureCeilingTokens;
    private readonly tailEpochSystemToolsReserveTokens;
    private readonly tailEpochTargetBandTokens;
    private readonly tailEpochAppendBandTargetTokens;
    private readonly tailEpochRunwayTokens;
    private readonly tailEpochMinRunwayTokens;
    /**
     * Resolved fold TRIGGER for the trigger-anchored tail-epoch floor gate (the
     * package mirror of budget.foldTriggerTokens / the claude-cli floor gate).
     * null when the host does not configure a trigger → the runway check keeps its
     * legacy ceiling-anchored basis. Resolved tokens only (GOD RULE 7).
     */
    private readonly tailEpochFoldTriggerTokens;
    /**
     * Provider-measured post-fold floor (frozen-prefix resting occupancy) for the
     * trigger-anchored tail-epoch runway gate. null until the first epoch on the
     * current hard-epoch generation captures it. The floor PERSISTS across
     * in-place whole-view rebuilds (they clear the sealed bands but do NOT drop the
     * frozen-prefix resting level) and is cleared only by a hard epoch (seed
     * reset — commitHardEpoch), which then re-arms capture so the next reading
     * re-baselines to the fresh seed resting level. Comparison of two provider
     * readings only — never char-derived (GOD RULE 7). Mutable per-turn state.
     */
    private tailEpochPostFoldFloorTokens;
    /** Armed on any epoch commit; the next measured reading resolves the floor. */
    private pendingTailEpochPostFoldFloor;
    /**
     * Epochs committed since the last HARD epoch (seed reset) — the runway gate's
     * arming counter (mirrors fcBaseSession appendEpochCount semantics). The gate
     * may escalate only once ≥1 epoch has committed on the current hard-epoch
     * generation, so a fresh post-reset floor can never instant-loop the gate
     * into back-to-back hard epochs. The sealed-band COUNT is the wrong guard:
     * an in-place recompute clears the bands while leaving the frozen-prefix
     * resting level high, silently disarming the gate exactly inside the churn
     * window it exists to stop (measured: zero-yield tail epochs 17-25s apart).
     */
    private appendEpochsSinceHardReset;
    private readonly rawHardEpochSeedMaxChars;
    private readonly readBurstGuardEnabled;
    private readonly valueFidelityInput;
    private readonly syntheticContext;
    private readonly clock;
    private readonly vaultEnabled;
    private readonly vaultTailWindow;
    private readonly userMessageVaultEntries;
    private readonly assistantGlyphVaultEntries;
    /**
     * True while the newest recorded operator message has no completed assistant
     * reply after it (record-call ordering). Drives the vault live/unanswered
     * marker: transient renders flag the row; bake paths defer it from sealing.
     */
    private newestOperatorUnanswered;
    private foldEpochs;
    private foldEvictedSpans;
    private foldEpochFrontiers;
    private lastPreparedRawCount;
    private activeFidelity;
    private hardEpochCompactBaselineActive;
    constructor(options?: FoldSessionOptions);
    /**
     * Record a genuine operator/user message into the vault buffer. No-op unless
     * the vault companion is enabled. Bounded + deduped at render.
     */
    recordOperatorMessage(text: string, createdAt?: string): void;
    /**
     * Record a completed assistant message into the glyph vault buffer (its
     * opening register is classified for scarce-slot priority). No-op unless the
     * vault companion is enabled.
     */
    recordAssistantMessage(text: string, createdAt?: string): void;
    /**
     * Append the rendered Glyph Grammar Vault to the outgoing send view (never the
     * raw history). Passing the view as visibleUserMessages self-gates the vault:
     * any operator/assistant text still present verbatim in the view dedupes out,
     * so pre-fold (everything still visible) the vault renders empty.
     */
    private applyVault;
    /**
     * Freeze-path transient overlay: render ONLY the deferred live
     * (unanswered-newest) rows onto the outgoing view. Sealed rows already ride
     * the cached frozen prefix — re-rendering the full vault here would duplicate
     * them (band text does not dedupe row-for-row) — so this appends nothing
     * unless a live row is currently deferred from sealing.
     * Cache-safe: touches only the uncached tail, never frozen bytes.
     */
    private applyLiveVaultOverlay;
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
    private bakeVault;
    /** Count conversational turns in a provider-shaped message array. */
    countTurns(messages: FoldMessage[]): number;
    private resolveTurnsToFold;
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
    private guardedTurnsToFold;
    private planMarathonStepFold;
    private foldMarathonSteps;
    private planOrphanTailStepFold;
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
    private effectiveFoldConfig;
    private effectiveAppendFoldConfig;
    /**
     * Run the rolling fold once, WITHOUT the freeze cache layer. Use this for a
     * one-shot compaction or when you manage cache reuse yourself. For a live loop,
     * prefer {@link prepare}.
     */
    fold(messages: FoldMessage[], turnsToFold?: number): FoldResult;
    private resetEvictionState;
    private buildFoldEvictionInput;
    private commitEvictionEpoch;
    private isPressureCeilingTriggered;
    /**
     * Public pressure-ceiling probe. Lets hosts short-circuit expensive
     * hard-epoch seed preparation (glyph log scans, episode recall) when no
     * hard epoch is imminent this turn. Mirrors the private check used inside
     * {@link prepare}. Standalone parity: context-warp-drive FoldSession exposes
     * the same probe, so the published library and the relay engine stay in sync
     * even though the relay host builds hard-epoch seeds lazily and may not call it.
     */
    willTriggerPressureCeiling(measuredInputTokens: number | undefined): boolean;
    private pressureStats;
    /**
     * Resolve a pending post-fold floor against the next measured occupancy reading
     * (CLI parity — resolvePendingPostFoldBaseline / the fcBaseSession mirror). An
     * effective append epoch drops measured occupancy → re-baseline the floor to
     * that post-fold reading so the trigger-anchored runway gate tracks the true
     * frozen-prefix resting level. A no-drop reading means the epoch reclaimed
     * nothing; keep the prior floor — but when NO floor exists yet, seed it from
     * the no-drop reading so the trigger-runway gate can catch churn on the very
     * first ineffective epoch (previously a no-drop reading never seeded a first
     * floor and the gate stayed blind). Deliberately does NOT clear on an empty
     * sealed set: an in-place recompute empties the bands while leaving the
     * frozen floor high — clearing there disarmed the gate exactly inside the
     * churn window it exists to stop. Hard resets clear and re-arm the floor
     * explicitly in commitHardEpoch; gate ARMING is handled separately by the
     * appendEpochsSinceHardReset counter (instant-loop guard). Two provider
     * readings only, no char-derivation (GOD RULE 7).
     */
    private resolvePendingTailEpochPostFoldFloor;
    private tailEpochRunwayCheck;
    /**
     * Prepare the message array to send this turn. Reuses the byte-identical frozen
     * prefix while the provider cache is hot; recomputes the fold only at an epoch.
     *
     * @param messages the FULL provider-shaped history (raw, append-only).
     * @param context optional thinning mode + currently-claimed paths (paths whose
     *   tool results should never fold). Both default to empty.
     */
    prepare(messages: FoldMessage[], context?: FoldPrepareContext): FoldOutcome;
    /** Freeze-layer telemetry: hot reuses since last epoch, lifetime epochs, frozen size. */
    get telemetry(): {
        hotReuses: number;
        epochs: number;
        frozenViewChars: number;
        frozenRawCount: number;
        evictedSpanCount: number;
        evictedTurnCount: number;
    };
    /**
     * Same-instance hard epoch: replace the prepared view with one compact seed
     * message (live turn merged in by buildHardEpochSeedView) and re-anchor the
     * freeze boundary around it. freezeState is readonly here, so we re-seal in
     * place via commitFoldFreeze (which clears sealedBands on a whole-view rebuild)
     * rather than reassigning a fresh state as the relay session does.
     */
    private commitHardEpoch;
    private statsFromResult;
}
