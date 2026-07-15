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
import { foldContext, detectTurns, checkFoldTrigger, planActiveTurnStepFold, computeEvictableThroughOrdinal, countChars, extractUserText, extractAssistantText, extractCoordinateConservationCorpus, DEFAULT_FOLD_EVICT_THRESHOLD_CHARS, DEFAULT_ASSISTANT_TEXT_BUDGET, resolveFoldConfigForBand, resolveColdFoldConfigForBand, } from '../rollingFold.ts';
import { extractCognitiveArtifacts, renderCognitiveBlock, mergeBlockIntoViewTail } from '../cognitiveArtifacts.ts';
import { appendDedicatedChronologicalMessage, foldMessageTimestampBounds, renderTailEpochProvenance, selectPairingSafeRawTailStart, } from '../chronologicalProvenance.ts';
// microRebirthSeed import removed — tail epochs now use vault + cognitive block only
import { computeOpenBurst } from '../foldEpisodeCapture.ts';
import { createFoldFreezeState, evaluateFoldFreeze, commitFoldFreeze, appendFoldFreezeTailEpoch, touchFoldFreeze, buildHardEpochSeedView, buildRawHardEpochSeed, shouldEscalateTailEpochForLowYield, DEFAULT_RAW_HARD_EPOCH_SEED_MAX_CHARS, DEFAULT_FOLD_FREEZE_CONFIG, } from '../foldFreeze.ts';
import { DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS, DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS, DEFAULT_CONTEXT_BUDGET_SYSTEM_TOOLS_RESERVE_TOKENS, DEFAULT_CONTEXT_BUDGET_TARGET_BAND_TOKENS, DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_MIN_RUNWAY_TOKENS, DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_RUNWAY_TOKENS, } from '../contextBudget.ts';
import { renderUserMessageVault, recordUserMessageVaultEntry, recordAssistantGlyphVaultEntry, appendUserMessageVaultToView, selectVaultRows, selectVaultDeltaRows, selectSealableVaultRows, renderVaultRowsBlock, vaultRowFingerprint, } from '../userMessageVault.ts';
const EMPTY_CLAIMED = new Set();
// Standalone Context Warp geometry signposts:
//   S = system/tools reserve before folded memory
//   M = folded memory band after a whole-view rebuild
//   A = expected appended folded-tail band
//   T = preferred/default next live-tail runway
//   F = hard minimum append runway
//   P = measured pressure ceiling
//
// Runtime invariant: when measured provider tokens are available, append a
// folded tail band only when P - measuredInputTokens >= F. The S/M/A projection
// is a telemetryless fallback, not the live runway gate.
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
function positiveFinite(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
/**
 * Stateful per-conversation fold orchestrator. Construct one per agent session;
 * call {@link prepare} every turn with the latest full history.
 */
export class FoldSession {
    foldConfig;
    freezeEnabled;
    freezeConfig;
    freezeState;
    evictionEnabled;
    evictionThresholdChars;
    pressureCeilingTokens;
    tailEpochSystemToolsReserveTokens;
    tailEpochTargetBandTokens;
    tailEpochAppendBandTargetTokens;
    tailEpochRunwayTokens;
    tailEpochMinRunwayTokens;
    /**
     * Resolved fold TRIGGER for the trigger-anchored tail-epoch floor gate (the
     * package mirror of budget.foldTriggerTokens / the claude-cli floor gate).
     * null when the host does not configure a trigger → the runway check keeps its
     * legacy ceiling-anchored basis. Resolved tokens only (GOD RULE 7).
     */
    tailEpochFoldTriggerTokens;
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
    tailEpochPostFoldFloorTokens = null;
    /** Armed on any epoch commit; the next measured reading resolves the floor. */
    pendingTailEpochPostFoldFloor = null;
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
    appendEpochsSinceHardReset = 0;
    rawHardEpochSeedMaxChars;
    readBurstGuardEnabled;
    valueFidelityInput;
    syntheticContext;
    clock;
    vaultEnabled;
    vaultTailWindow;
    userMessageVaultEntries = [];
    assistantGlyphVaultEntries = [];
    /**
     * True while the newest recorded operator message has no completed assistant
     * reply after it (record-call ordering). Drives the vault live/unanswered
     * marker: transient renders flag the row; bake paths defer it from sealing.
     */
    newestOperatorUnanswered = false;
    foldEpochs = 0;
    foldEvictedSpans = [];
    foldEpochFrontiers = [];
    lastPreparedRawCount = 0;
    activeFidelity = null;
    hardEpochCompactBaselineActive = false;
    constructor(options = {}) {
        const baseFoldConfig = options.foldConfig ?? resolveFoldConfigForBand(DEFAULT_FOLD_TARGET_BAND_TOKENS);
        this.foldConfig = options.foldBlockPreamble === undefined
            ? baseFoldConfig
            : { ...baseFoldConfig, foldBlockPreamble: options.foldBlockPreamble };
        this.activeFidelity = options.fidelity ?? null;
        this.readBurstGuardEnabled = options.readBurstGuard === true;
        this.valueFidelityInput = options.valueFidelity?.enabled === true
            ? { weights: options.valueFidelity.weights, recencyFloorTurns: options.valueFidelity.recencyFloorTurns }
            : undefined;
        this.syntheticContext = options.syntheticContext ?? {};
        this.rawHardEpochSeedMaxChars = positiveFinite(options.rawHardEpochSeedMaxChars, DEFAULT_RAW_HARD_EPOCH_SEED_MAX_CHARS);
        if (options.freeze === false) {
            this.freezeEnabled = false;
            this.freezeConfig = DEFAULT_FOLD_FREEZE_CONFIG;
        }
        else if (options.freeze && typeof options.freeze === 'object') {
            this.freezeEnabled = true;
            this.freezeConfig = options.freeze;
        }
        else {
            this.freezeEnabled = true;
            this.freezeConfig = DEFAULT_FOLD_FREEZE_CONFIG;
        }
        if (options.eviction === false) {
            this.evictionEnabled = false;
            this.evictionThresholdChars = DEFAULT_FOLD_EVICT_THRESHOLD_CHARS;
        }
        else {
            this.evictionEnabled = true;
            this.evictionThresholdChars = typeof options.eviction === 'object'
                ? options.eviction.thresholdChars ?? DEFAULT_FOLD_EVICT_THRESHOLD_CHARS
                : DEFAULT_FOLD_EVICT_THRESHOLD_CHARS;
        }
        if (options.pressureCeiling === false) {
            this.pressureCeilingTokens = null;
        }
        else {
            const configured = typeof options.pressureCeiling === 'number'
                ? options.pressureCeiling
                : options.pressureCeiling?.tokens ?? DEFAULT_FOLD_PRESSURE_CEILING_TOKENS;
            this.pressureCeilingTokens = Number.isFinite(configured) && configured > 0 ? configured : null;
        }
        if (options.tailEpochRunway === false) {
            this.tailEpochRunwayTokens = null;
            this.tailEpochMinRunwayTokens = null;
            this.tailEpochFoldTriggerTokens = null;
            this.tailEpochSystemToolsReserveTokens = DEFAULT_FOLD_SYSTEM_TOOLS_RESERVE_TOKENS;
            this.tailEpochTargetBandTokens = DEFAULT_FOLD_TARGET_BAND_TOKENS;
            this.tailEpochAppendBandTargetTokens = DEFAULT_FOLD_APPEND_BAND_TARGET_TOKENS;
        }
        else {
            const runway = options.tailEpochRunway ?? {};
            this.tailEpochRunwayTokens = positiveFinite(runway.runwayTokens, DEFAULT_FOLD_TAIL_EPOCH_RUNWAY_TOKENS);
            this.tailEpochMinRunwayTokens = positiveFinite(runway.minRunwayTokens, runway.runwayTokens === undefined
                ? Math.min(this.tailEpochRunwayTokens, DEFAULT_FOLD_TAIL_EPOCH_MIN_RUNWAY_TOKENS)
                : this.tailEpochRunwayTokens);
            this.tailEpochSystemToolsReserveTokens = positiveFinite(runway.systemToolsReserveTokens, DEFAULT_FOLD_SYSTEM_TOOLS_RESERVE_TOKENS);
            this.tailEpochTargetBandTokens = positiveFinite(runway.targetBandTokens, DEFAULT_FOLD_TARGET_BAND_TOKENS);
            this.tailEpochAppendBandTargetTokens = positiveFinite(runway.appendBandTargetTokens, DEFAULT_FOLD_APPEND_BAND_TARGET_TOKENS);
            // Nullable: no positiveFinite fallback — an absent trigger must stay null so
            // tailEpochRunwayCheck keeps its legacy ceiling-anchored basis (GOD RULE 7:
            // resolved tokens only, never derived from chars).
            this.tailEpochFoldTriggerTokens =
                typeof runway.foldTriggerTokens === 'number'
                    && Number.isFinite(runway.foldTriggerTokens)
                    && runway.foldTriggerTokens > 0
                    ? Math.floor(runway.foldTriggerTokens)
                    : null;
        }
        if (options.vault === true) {
            this.vaultEnabled = true;
            this.vaultTailWindow = undefined;
        }
        else if (options.vault && typeof options.vault === 'object') {
            this.vaultEnabled = true;
            this.vaultTailWindow = typeof options.vault.tailWindow === 'number' && Number.isFinite(options.vault.tailWindow)
                ? options.vault.tailWindow
                : undefined;
        }
        else {
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
    recordOperatorMessage(text, createdAt) {
        if (!this.vaultEnabled)
            return;
        recordUserMessageVaultEntry(this.userMessageVaultEntries, text, createdAt);
        this.newestOperatorUnanswered = true;
    }
    /**
     * Record a completed assistant message into the glyph vault buffer (its
     * opening register is classified for scarce-slot priority). No-op unless the
     * vault companion is enabled.
     */
    recordAssistantMessage(text, createdAt) {
        if (!this.vaultEnabled)
            return;
        recordAssistantGlyphVaultEntry(this.assistantGlyphVaultEntries, text, createdAt);
        this.newestOperatorUnanswered = false;
    }
    /**
     * Append the rendered Glyph Grammar Vault to the outgoing send view (never the
     * raw history). Passing the view as visibleUserMessages self-gates the vault:
     * any operator/assistant text still present verbatim in the view dedupes out,
     * so pre-fold (everything still visible) the vault renders empty.
     */
    applyVault(outcome) {
        if (!this.vaultEnabled)
            return outcome;
        const vault = renderUserMessageVault(this.userMessageVaultEntries, {
            visibleUserMessages: outcome.messages,
            assistantEntries: this.assistantGlyphVaultEntries,
            newestOperatorUnanswered: this.newestOperatorUnanswered,
        });
        if (!vault)
            return outcome;
        const messages = appendUserMessageVaultToView(outcome.messages, vault, this.vaultTailWindow);
        if (messages === outcome.messages)
            return { ...outcome, vault };
        return { ...outcome, messages, vault };
    }
    /**
     * Freeze-path transient overlay: render ONLY the deferred live
     * (unanswered-newest) rows onto the outgoing view. Sealed rows already ride
     * the cached frozen prefix — re-rendering the full vault here would duplicate
     * them (band text does not dedupe row-for-row) — so this appends nothing
     * unless a live row is currently deferred from sealing.
     * Cache-safe: touches only the uncached tail, never frozen bytes.
     */
    applyLiveVaultOverlay(outcome) {
        if (!this.vaultEnabled || !this.newestOperatorUnanswered)
            return outcome;
        const liveRows = selectVaultRows(this.userMessageVaultEntries, this.assistantGlyphVaultEntries, {
            visibleUserMessages: outcome.messages,
            newestOperatorUnanswered: true,
        }).filter((row) => row.live === true);
        if (liveRows.length === 0)
            return outcome;
        const block = renderVaultRowsBlock(liveRows, 'full');
        if (!block)
            return outcome;
        const messages = appendUserMessageVaultToView(outcome.messages, block, this.vaultTailWindow);
        if (messages === outcome.messages)
            return { ...outcome, vault: block };
        return { ...outcome, messages, vault: block };
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
    bakeVault(view, mode, additionallyVisible = []) {
        if (!this.vaultEnabled)
            return view;
        // Live (unanswered-newest) rows are deferred from sealing: they ride the
        // transient applyVault path with the LIVE marker until answered, then seal
        // normally under the unchanged fingerprint. Cache-safe by construction —
        // frozen bytes never contain the marker or the unanswered row.
        const rows = selectSealableVaultRows(selectVaultRows(this.userMessageVaultEntries, this.assistantGlyphVaultEntries, {
            visibleUserMessages: additionallyVisible.length > 0 ? view.concat(additionallyVisible) : view,
            newestOperatorUnanswered: this.newestOperatorUnanswered,
        }));
        if (mode === 'full')
            this.freezeState.sealedVaultFingerprints.clear();
        const bakeRows = mode === 'full' ? rows : selectVaultDeltaRows(rows, this.freezeState.sealedVaultFingerprints);
        if (bakeRows.length === 0)
            return view;
        const block = renderVaultRowsBlock(bakeRows, mode);
        if (!block)
            return view;
        for (const row of bakeRows)
            this.freezeState.sealedVaultFingerprints.add(vaultRowFingerprint(row));
        return appendUserMessageVaultToView(view, block);
    }
    /** Count conversational turns in a provider-shaped message array. */
    countTurns(messages) {
        return detectTurns(messages, this.syntheticContext).length;
    }
    resolveTurnsToFold(messages, explicit) {
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
    guardedTurnsToFold(messages, pressureCeilingTriggered) {
        const base = this.resolveTurnsToFold(messages);
        if (!this.readBurstGuardEnabled || pressureCeilingTriggered || base <= 0)
            return base;
        const { openBurstStartIndex } = computeOpenBurst(messages);
        if (openBurstStartIndex === null)
            return base;
        const turns = detectTurns(messages, this.syntheticContext);
        let floor = 0;
        for (const turn of turns) {
            if (turn.endIndex <= openBurstStartIndex)
                floor += 1;
            else
                break;
        }
        return Math.min(base, floor);
    }
    planMarathonStepFold(messages, measuredInputTokens, durableCursorIndex, foldConfig, keepLastSteps = 12, force = false) {
        if (durableCursorIndex < messages.length)
            return null;
        if (!force
            && (typeof measuredInputTokens !== 'number'
                || !Number.isFinite(measuredInputTokens)
                || measuredInputTokens <= this.tailEpochTargetBandTokens)) {
            return null;
        }
        const budget = foldConfig.assistantTextBudget;
        const budgetBasedActiveTurnChars = budget
            ? Math.max(1, budget.fullRetentionChars + budget.essenceRetentionChars)
            : 150_000;
        const activeTurnCharBudget = Math.min(budgetBasedActiveTurnChars, this.freezeConfig.maxTailChars);
        return planActiveTurnStepFold(messages, {
            activeTurnCharBudget,
            keepLastSteps,
        }, this.syntheticContext);
    }
    foldMarathonSteps(messages, measuredInputTokens, durableCursorIndex, foldConfig) {
        const plan = this.planMarathonStepFold(messages, measuredInputTokens, durableCursorIndex, foldConfig);
        if (!plan)
            return null;
        return foldContext(messages, plan.turnsToFold, foldConfig, undefined, undefined, plan.turns, this.syntheticContext);
    }
    planOrphanTailStepFold(fullHistory, tailStartIndex, foldConfig, keepLastSteps) {
        if (tailStartIndex <= 0 || tailStartIndex >= fullHistory.length)
            return undefined;
        const tail = fullHistory.slice(tailStartIndex);
        const tailTurns = detectTurns(tail, this.syntheticContext);
        if (tailTurns.length > 0)
            return undefined;
        const allTurns = detectTurns(fullHistory, this.syntheticContext);
        const activeTurn = allTurns[allTurns.length - 1];
        if (!activeTurn || activeTurn.startIndex >= tailStartIndex)
            return undefined;
        const stepPlan = this.planMarathonStepFold(fullHistory, undefined, fullHistory.length, foldConfig, keepLastSteps, true);
        const tailSegments = stepPlan?.turns
            .map((turn, index) => ({ turn, index }))
            .filter(({ turn }) => turn.startIndex >= tailStartIndex);
        if (!stepPlan || !tailSegments || tailSegments.length === 0)
            return undefined;
        const localTurns = tailSegments.map(({ turn }) => ({
            startIndex: turn.startIndex - tailStartIndex,
            endIndex: turn.endIndex - tailStartIndex,
            messages: turn.messages,
        }));
        const localTurnsToFold = tailSegments.filter(({ index }) => index < stepPlan.turnsToFold).length;
        if (localTurnsToFold <= 0)
            return undefined;
        return {
            turns: localTurns,
            turnsToFold: localTurnsToFold,
        };
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
    effectiveFoldConfig(fidelity) {
        if (!fidelity ||
            (fidelity.fullRetentionFraction === undefined && fidelity.essenceRetentionFraction === undefined)) {
            return this.foldConfig;
        }
        const base = this.foldConfig.assistantTextBudget ?? DEFAULT_ASSISTANT_TEXT_BUDGET;
        const fullRetentionChars = fidelity.fullRetentionFraction !== undefined
            ? Math.round(base.fullRetentionChars * (fidelity.fullRetentionFraction / DEFAULT_FULL_RETENTION_FRACTION))
            : base.fullRetentionChars;
        const essenceRetentionChars = fidelity.essenceRetentionFraction !== undefined
            ? Math.round(base.essenceRetentionChars * (fidelity.essenceRetentionFraction / DEFAULT_ESSENCE_RETENTION_FRACTION))
            : base.essenceRetentionChars;
        return { ...this.foldConfig, assistantTextBudget: { fullRetentionChars, essenceRetentionChars } };
    }
    effectiveAppendFoldConfig() {
        const cold = resolveColdFoldConfigForBand(this.tailEpochAppendBandTargetTokens);
        const base = this.foldConfig.foldBlockPreamble === undefined
            ? cold
            : { ...cold, foldBlockPreamble: this.foldConfig.foldBlockPreamble };
        const priorCoordinateCorpus = extractCoordinateConservationCorpus(this.freezeState.frozenView ?? []);
        return priorCoordinateCorpus ? { ...base, priorCoordinateCorpus } : base;
    }
    /**
     * Run the rolling fold once, WITHOUT the freeze cache layer. Use this for a
     * one-shot compaction or when you manage cache reuse yourself. For a live loop,
     * prefer {@link prepare}.
     */
    fold(messages, turnsToFold) {
        return foldContext(messages, this.resolveTurnsToFold(messages, turnsToFold), this.foldConfig, undefined, undefined, undefined, this.syntheticContext);
    }
    resetEvictionState() {
        this.foldEpochs = 0;
        this.foldEvictedSpans = [];
        this.foldEpochFrontiers = [];
    }
    buildFoldEvictionInput(messages, durableCursorIndex, upcomingEpoch, now, options = {}) {
        if (!this.evictionEnabled || this.evictionThresholdChars <= 0)
            return undefined;
        const hasSpans = this.foldEvictedSpans.length > 0;
        // Pressure-ceiling / forced whole-view-rebuild epochs: the entire raw history
        // is being recomputed through the fold pipeline, so ALL folded content is
        // eligible for eviction regardless of vault state. The raw history is the
        // durable backing — fold-recall pages evicted turns back from raw on touch,
        // and the episodic store is a recall performance optimization, not a
        // correctness prerequisite for tombstoning.
        const effectiveDurableCursorIndex = Math.max(durableCursorIndex, options.allowVaultBackedCoverage ? messages.length : 0);
        const evictableThroughOrdinal = computeEvictableThroughOrdinal(detectTurns(messages, this.syntheticContext), effectiveDurableCursorIndex, this.foldEpochFrontiers, upcomingEpoch);
        if (evictableThroughOrdinal <= 0 && !hasSpans)
            return undefined;
        return {
            evictedSpans: this.foldEvictedSpans,
            evictableThroughOrdinal,
            ...(options.targetSafeFrontier ? { targetEvictThroughOrdinal: evictableThroughOrdinal } : {}),
            thresholdChars: this.evictionThresholdChars,
            nowIso: new Date(now).toISOString(),
        };
    }
    commitEvictionEpoch(result, epoch) {
        this.foldEpochs = Math.max(this.foldEpochs, epoch);
        this.foldEpochFrontiers.push({ epoch, turnsFolded: result.turnsFolded });
        if (this.foldEpochFrontiers.length > 16) {
            this.foldEpochFrontiers.splice(0, this.foldEpochFrontiers.length - 16);
        }
        if (result.evictedSpans) {
            this.foldEvictedSpans = result.evictedSpans.map(span => ({ ...span }));
        }
    }
    isPressureCeilingTriggered(measuredInputTokens) {
        return this.pressureCeilingTokens !== null
            && typeof measuredInputTokens === 'number'
            && Number.isFinite(measuredInputTokens)
            && measuredInputTokens >= this.pressureCeilingTokens;
    }
    /**
     * Public pressure-ceiling probe. Lets hosts short-circuit expensive
     * hard-epoch seed preparation (glyph log scans, episode recall) when no
     * hard epoch is imminent this turn. Mirrors the private check used inside
     * {@link prepare}. Standalone parity: context-warp-drive FoldSession exposes
     * the same probe, so the published library and the relay engine stay in sync
     * even though the relay host builds hard-epoch seeds lazily and may not call it.
     */
    willTriggerPressureCeiling(measuredInputTokens) {
        return this.isPressureCeilingTriggered(measuredInputTokens);
    }
    pressureStats(pressureCeilingTriggered) {
        if (this.pressureCeilingTokens === null)
            return {};
        return {
            pressureCeilingTokens: this.pressureCeilingTokens,
            pressureCeilingTriggered,
        };
    }
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
    resolvePendingTailEpochPostFoldFloor(measuredInputTokens) {
        const pending = this.pendingTailEpochPostFoldFloor;
        if (!pending)
            return;
        if (typeof measuredInputTokens !== 'number' || !Number.isFinite(measuredInputTokens) || measuredInputTokens <= 0)
            return;
        this.pendingTailEpochPostFoldFloor = null;
        if (measuredInputTokens < pending.preFoldTokens) {
            this.tailEpochPostFoldFloorTokens = Math.floor(measuredInputTokens);
        }
        else if (this.tailEpochPostFoldFloorTokens === null) {
            // First no-drop epoch: seed the floor so the trigger-runway gate can catch churn.
            this.tailEpochPostFoldFloorTokens = Math.floor(measuredInputTokens);
        }
    }
    tailEpochRunwayCheck(measuredInputTokens) {
        const sealedAppendBandCount = this.freezeState.sealedBands.length;
        if (this.pressureCeilingTokens === null || this.tailEpochMinRunwayTokens === null) {
            return {
                ok: true,
                basis: 'disabled',
                measuredInputTokens: null,
                sealedAppendBandCount,
                postAppendModeledTokens: null,
                postAppendRunwayTokens: null,
                requiredRunwayTokens: this.tailEpochMinRunwayTokens,
            };
        }
        const measuredTokens = typeof measuredInputTokens === 'number' && Number.isFinite(measuredInputTokens) && measuredInputTokens > 0
            ? Math.floor(measuredInputTokens)
            : null;
        if (measuredTokens !== null) {
            const floorTokens = this.tailEpochPostFoldFloorTokens !== null
                && Number.isFinite(this.tailEpochPostFoldFloorTokens)
                && this.tailEpochPostFoldFloorTokens > 0
                ? Math.floor(this.tailEpochPostFoldFloorTokens)
                : null;
            const triggerTokens = this.tailEpochFoldTriggerTokens !== null
                && Number.isFinite(this.tailEpochFoldTriggerTokens)
                && this.tailEpochFoldTriggerTokens > 0
                ? Math.floor(this.tailEpochFoldTriggerTokens)
                : null;
            if (floorTokens !== null && triggerTokens !== null && this.appendEpochsSinceHardReset >= 1) {
                // Trigger-anchored post-fold-floor gate (CLI parity —
                // checkClaudeCliHardEpochFromFloor; the fcBaseSession/foldMeasuredPressure
                // mirror). Once ≥1 epoch has committed on this hard-epoch generation,
                // compare the IRREDUCIBLE frozen prefix (the measured post-fold floor)
                // directly to the fold TRIGGER. The minimum runway is already encoded by
                // the trigger sitting below the P180 ceiling; subtracting it a second
                // time from the floor hard-epochs healthy stair-step bands too early.
                // Escalate only when the captured floor itself reaches or exceeds the
                // trigger, because another append would leave no below-trigger raw-tail
                // budget to reclaim. Arming counts epochs since the last hard reset, NOT
                // sealed bands: an in-place recompute clears the bands without dropping
                // the floor, and band-count arming disarmed the gate exactly inside the
                // churn window. The ≥1-epoch requirement is the instant-loop guard: a
                // fresh post-reset floor can never gate itself into back-to-back hard
                // epochs. GOD RULE 7: floor + trigger are measured/resolved tokens.
                const postAppendRunwayTokens = triggerTokens - floorTokens;
                return {
                    ok: postAppendRunwayTokens > 0,
                    basis: 'floor',
                    measuredInputTokens: measuredTokens,
                    sealedAppendBandCount,
                    postAppendModeledTokens: null,
                    postAppendRunwayTokens,
                    requiredRunwayTokens: this.tailEpochMinRunwayTokens,
                };
            }
            // First tail epoch on the seed (floor not yet captured) or no configured
            // trigger: fall back to the legacy ceiling-anchored measured runway.
            const postAppendRunwayTokens = this.pressureCeilingTokens - measuredTokens;
            return {
                ok: postAppendRunwayTokens >= this.tailEpochMinRunwayTokens,
                basis: 'measured',
                measuredInputTokens: measuredTokens,
                sealedAppendBandCount,
                postAppendModeledTokens: null,
                postAppendRunwayTokens,
                requiredRunwayTokens: this.tailEpochMinRunwayTokens,
            };
        }
        const postAppendModeledTokens = this.tailEpochSystemToolsReserveTokens
            + this.tailEpochTargetBandTokens
            + ((sealedAppendBandCount + 1) * this.tailEpochAppendBandTargetTokens);
        const postAppendRunwayTokens = this.pressureCeilingTokens - postAppendModeledTokens;
        return {
            ok: postAppendRunwayTokens >= this.tailEpochMinRunwayTokens,
            basis: 'modeled',
            measuredInputTokens: null,
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
    prepare(messages, context = {}) {
        const now = this.clock();
        const totalTurns = detectTurns(messages, this.syntheticContext).length;
        const durableCursorIndex = context.durableCursorIndex ?? messages.length;
        const pressureCeilingTriggered = this.isPressureCeilingTriggered(context.measuredInputTokens);
        const hardEpochTriggered = context.hardEpoch === true || pressureCeilingTriggered;
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
        // ── HARD EPOCH (raw trace seed) ──
        // When the measured ceiling is RAW-triggered, replace the whole prepared view
        // with one compact seed message (live turn merged in) and re-anchor the freeze
        // boundary around it. A host-supplied seed wins; otherwise the standalone
        // engine computes a raw trace seed from `messages` itself. Fires independent
        // of recompute-suppression because the topology reset lowers the stuck floor.
        if (hardEpochTriggered) {
            this.activeFidelity = desiredFidelity;
            const seedPrompt = context.hardEpochSeed?.trim() || buildRawHardEpochSeed(messages, {
                maxChars: this.rawHardEpochSeedMaxChars,
            });
            return this.commitHardEpoch(messages, seedPrompt, context, now, totalTurns, pressureCeilingTriggered);
        }
        if (!this.freezeEnabled) {
            this.activeFidelity = desiredFidelity;
            const upcomingEpoch = this.foldEpochs + 1;
            const foldConfig = this.effectiveFoldConfig(desiredFidelity);
            const result = foldContext(messages, this.guardedTurnsToFold(messages, pressureCeilingTriggered), foldConfig, this.buildFoldEvictionInput(messages, durableCursorIndex, upcomingEpoch, now, {
                allowVaultBackedCoverage: pressureCeilingTriggered,
                targetSafeFrontier: pressureCeilingTriggered,
            }), undefined, undefined, this.syntheticContext, this.valueFidelityInput);
            const stepResult = this.foldMarathonSteps(result.messages, context.measuredInputTokens, durableCursorIndex, foldConfig);
            const bookkeepingResult = result.turnsFolded > 0 ? result : stepResult ?? result;
            const cognitiveBlock = bookkeepingResult.turnsFolded > 0
                ? renderCognitiveBlock(extractCognitiveArtifacts(messages))
                : '';
            const preparedMessages = stepResult?.messages ?? result.messages;
            // Merge (never append): a trailing assistant enrichment message breaks
            // providers that require the request to end with a user message when the
            // fold consumes the whole tail (Anthropic 400 assistant-prefill).
            const messagesWithCognitive = cognitiveBlock
                ? mergeBlockIntoViewTail(preparedMessages, cognitiveBlock)
                : preparedMessages;
            this.commitEvictionEpoch(bookkeepingResult, upcomingEpoch);
            return this.applyVault({
                messages: messagesWithCognitive,
                cacheHot: false,
                result: bookkeepingResult,
                appliedFidelity: this.activeFidelity,
                stats: {
                    ...this.statsFromResult(totalTurns, false, bookkeepingResult, pressureCeilingTriggered),
                    ...(pressureCeilingTriggered ? { epochReason: 'pressure-ceiling' } : {}),
                },
            });
        }
        const ctx = {
            thinningMode: context.thinningMode ?? '',
            claimedPaths: context.claimedPaths ?? EMPTY_CLAIMED,
            measuredInputTokens: context.measuredInputTokens,
        };
        const decision = evaluateFoldFreeze(this.freezeState, messages, ctx, now, this.freezeConfig);
        // Resolve any pending post-fold floor from THIS turn's measured reading before
        // the reuse/append branch, so a hot-reuse turn immediately after an append
        // still re-baselines the floor (CLI parity). Feeds tailEpochRunwayCheck below.
        this.resolvePendingTailEpochPostFoldFloor(context.measuredInputTokens);
        if (decision.action === 'reuse' && !pressureCeilingTriggered) {
            touchFoldFreeze(this.freezeState, now);
            // Sealed vault rows live in the cached frozen prefix (baked at the last
            // epoch) — hot reuse re-sends them for free. The transient overlay exists
            // for rows NOT in the prefix: the deferred live (unanswered-newest)
            // operator row renders with its LIVE marker on the uncached tail, so
            // liveness survives reuse sends without touching frozen bytes. NOT
            // applyVault: a full render would duplicate the
            // already-sealed band rows (dedupe is row-vs-visible-text, not band bytes).
            return this.applyLiveVaultOverlay({
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
            });
        }
        const recomputeReason = decision.action === 'recompute' ? decision.reason : undefined;
        if (recomputeReason === 'history-rewound' || recomputeReason === 'boundary-mismatch') {
            this.resetEvictionState();
        }
        const previousActiveFidelity = this.activeFidelity;
        this.activeFidelity = desiredFidelity;
        const runway = this.tailEpochRunwayCheck(context.measuredInputTokens);
        const hardEpochBaselineAppend = recomputeReason === 'tail-epoch'
            && !pressureCeilingTriggered
            && this.hardEpochCompactBaselineActive;
        const hardEpochBaselineRunwayBypass = hardEpochBaselineAppend
            && runway.basis === 'modeled'
            && !runway.ok;
        const upcomingEpoch = this.foldEpochs + 1;
        const appendOnlyTailEpoch = recomputeReason === 'tail-epoch'
            && !pressureCeilingTriggered
            && (runway.ok || hardEpochBaselineRunwayBypass);
        if (appendOnlyTailEpoch) {
            // ── Kept-raw working set ──
            // Keep a live working set of recent messages untouched by the fold
            // (~10K tokens ≈ 40K chars). Without this the entire raw tail folds
            // into the frozen prefix and the agent loses active investigation
            // context, user questions, and recent tool results. Mirrors the relay
            // FC path and Claude CLI's DEFAULT_CLAUDE_CLI_BAND_MAX_TAIL_CHARS.
            const KEPT_RAW_CHARS = 40_000;
            const frozenCount = this.freezeState.frozenRawCount;
            const fullTail = messages.slice(frozenCount);
            let keptRawSplitIndex = fullTail.length;
            {
                let accChars = 0;
                for (let i = fullTail.length - 1; i >= 0; i--) {
                    const c = typeof fullTail[i]?.content === 'string'
                        ? fullTail[i].content.length
                        : JSON.stringify(fullTail[i]?.content ?? '').length;
                    if (accChars + c > KEPT_RAW_CHARS && keptRawSplitIndex < fullTail.length)
                        break;
                    accChars += c;
                    keptRawSplitIndex = i;
                }
            }
            const budgetRequiresKeptRaw = keptRawSplitIndex > 0 && keptRawSplitIndex < fullTail.length;
            // Anchor the kept-raw window on live intent, shape-aware. A string-only
            // role check silently skips Anthropic content[] and Gemini parts[] user
            // turns, leaving those sessions with NO anchor: the window degrades to
            // the newest ~40K chars — often a single large tool result — and the
            // live directive plus the agent's plan narration fold into a cold band
            // that retains zero assistant prose ("lost the plot"). extractUserText
            // reads genuine user text across all three shapes and ignores
            // tool_result / functionResponse blocks.
            let lastUserIndex = -1;
            if (budgetRequiresKeptRaw) {
                for (let i = fullTail.length - 1; i >= 0; i -= 1) {
                    const candidate = fullTail[i];
                    if (candidate?.role !== 'user')
                        continue;
                    if (typeof candidate.content === 'string'
                        || extractUserText([candidate], this.syntheticContext).trim()) {
                        lastUserIndex = i;
                        break;
                    }
                }
            }
            // Assistant-narration fallback: an assistant-led tool loop can have no
            // genuine user text in the foldable tail at all. Anchor on the newest
            // substantive assistant text so the in-flight plan survives raw. Index 0
            // is excluded: clamping there would fold nothing and skip the epoch.
            let keptRawAnchorIndex = lastUserIndex;
            if (budgetRequiresKeptRaw && keptRawAnchorIndex < 0) {
                for (let i = fullTail.length - 1; i > 0; i -= 1) {
                    const candidate = fullTail[i];
                    if (candidate?.role !== 'assistant' && candidate?.role !== 'model')
                        continue;
                    if (extractAssistantText([candidate]).trim().length >= 40) {
                        keptRawAnchorIndex = i;
                        break;
                    }
                }
            }
            if (keptRawAnchorIndex >= 0)
                keptRawSplitIndex = Math.min(keptRawSplitIndex, keptRawAnchorIndex);
            // A zero split means the whole increment fits under the raw-window
            // budget, which historically means "fold all" rather than "keep all."
            // Probe from EOF in that case so an unresolved call can still create a
            // real raw barrier; completed pairs leave the fold-all sentinel intact.
            const pairingProbeStart = budgetRequiresKeptRaw ? keptRawSplitIndex : fullTail.length;
            keptRawSplitIndex = selectPairingSafeRawTailStart(fullTail, pairingProbeStart);
            const liveObjectiveSource = lastUserIndex >= 0
                ? (typeof fullTail[lastUserIndex]?.content === 'string'
                    ? fullTail[lastUserIndex].content
                    : extractUserText([fullTail[lastUserIndex]], this.syntheticContext))
                : '';
            const liveObjective = liveObjectiveSource.replace(/\s+/g, ' ').trim().slice(0, 280);
            const pendingCallBlocksEntireFold = pairingProbeStart === fullTail.length
                && keptRawSplitIndex === 0
                && fullTail.length > 0;
            if ((lastUserIndex === 0 || pendingCallBlocksEntireFold)
                && keptRawSplitIndex === 0
                && fullTail.length > 0) {
                const deferReason = pendingCallBlocksEntireFold ? 'pending-tool-call' : 'live-user-anchor';
                this.activeFidelity = previousActiveFidelity;
                touchFoldFreeze(this.freezeState, now);
                const anchoredView = this.freezeState.frozenView
                    ? this.freezeState.frozenView.concat(fullTail)
                    : messages.slice();
                return this.applyLiveVaultOverlay({
                    messages: anchoredView,
                    cacheHot: true,
                    sealedBoundary: this.freezeState.lastAppendBoundaryViewCount ?? null,
                    appliedFidelity: this.activeFidelity,
                    stats: {
                        totalTurns,
                        cacheHot: true,
                        hotReuses: this.freezeState.hotReuses,
                        epochs: this.freezeState.epochs,
                        deferReason,
                        ...this.pressureStats(false),
                    },
                });
            }
            const hasKeptRaw = keptRawSplitIndex > 0 && keptRawSplitIndex < fullTail.length;
            const tail = hasKeptRaw ? fullTail.slice(0, keptRawSplitIndex) : fullTail;
            const appendFoldConfig = this.effectiveAppendFoldConfig();
            const tailStepPlan = this.planOrphanTailStepFold(messages, this.freezeState.frozenRawCount, appendFoldConfig, 1);
            const appendTrigger = tailStepPlan
                ? null
                : checkFoldTrigger(tail, appendFoldConfig, this.syntheticContext);
            const tailResult = foldContext(tail, tailStepPlan?.turnsToFold ?? (appendTrigger?.shouldFold ? appendTrigger.turnsToFold : 0), appendFoldConfig, undefined, undefined, tailStepPlan?.turns, this.syntheticContext);
            // Per-fold yield gate — evaluated on the PURE fold output BEFORE bakeVault
            // (which seals vault fingerprints) and appendFoldFreezeTailEpoch (which
            // mutates freeze state on commit), so an escalation leaves NO half-baked
            // state behind. shrinkRatio = folded chars / raw-tail chars is the fold's
            // actual compression. When trigger-runway is thin (trigger − measured <
            // minRunway; at-pressure is the zero/negative subset), a low-yield fold
            // (retains >70%) barely drops the frozen floor, so the next turn tail-epochs
            // again (the "folds barely dropping the tail" livelock); a whole-view rebuild of
            // the same incompressible content would not help — only a topology-resetting
            // seed hard epoch does. Measured-only runway judgement (GOD RULE 7).
            const yieldRawTailChars = countChars(tail);
            const yieldShrinkRatio = yieldRawTailChars > 0 ? countChars(tailResult.messages) / yieldRawTailChars : null;
            if (shouldEscalateTailEpochForLowYield(yieldShrinkRatio, context.measuredInputTokens ?? null, this.tailEpochFoldTriggerTokens, this.tailEpochMinRunwayTokens)) {
                const seedPrompt = context.hardEpochSeed?.trim() || buildRawHardEpochSeed(messages, {
                    maxChars: this.rawHardEpochSeedMaxChars,
                });
                return this.commitHardEpoch(messages, seedPrompt, context, now, totalTurns, false, 'tail-yield-gate+hard-epoch');
            }
            // Seal only the per-band DELTA (rows not already sealed into an earlier
            // band) into this folded tail band before it joins the byte-frozen prefix.
            // The cognitive block (results/decisions/hazards) is merged into the sealed
            // tail BEFORE the commit so the shrink-ratio gate sees the true committed
            // band size — no post-commit inflation.
            const cognitiveBlock = renderCognitiveBlock(extractCognitiveArtifacts(tail));
            const survivingRawTail = hasKeptRaw ? fullTail.slice(keptRawSplitIndex) : [];
            const sealedTail = this.bakeVault(tailResult.messages, 'delta', survivingRawTail);
            // Pre-commit enrichment: merge cognitive block into the sealed tail's
            // final message so the gate measures the actual committed size.
            // Merging (not appending) preserves the terminal role and message count.
            const enrichedTail = cognitiveBlock
                ? mergeBlockIntoViewTail(sealedTail, cognitiveBlock)
                : sealedTail;
            const sourceTime = foldMessageTimestampBounds(tail);
            const provenance = renderTailEpochProvenance({
                epoch: upcomingEpoch,
                unit: 'message',
                sourceStart: frozenCount,
                sourceEndExclusive: frozenCount + tail.length,
                sourceFirstTimestamp: sourceTime.firstTimestamp,
                sourceLastTimestamp: sourceTime.lastTimestamp,
                committedAt: new Date(now).toISOString(),
                rawTailCount: survivingRawTail.length,
                rawResumeIndex: hasKeptRaw ? frozenCount + keptRawSplitIndex : undefined,
                host: 'dedicated-synthetic-message',
                previous: 'frozen-prefix',
                liveObjective,
            });
            const tailWithProvenance = appendDedicatedChronologicalMessage(enrichedTail, provenance);
            // When we kept a raw working set, pass truncated history so
            // frozenRawCount advances only to the fold boundary.
            const commitMessages = hasKeptRaw
                ? messages.slice(0, frozenCount + keptRawSplitIndex)
                : messages;
            const appendCommit = appendFoldFreezeTailEpoch(this.freezeState, commitMessages, tailWithProvenance, ctx, now);
            if (appendCommit.committed) {
                const appendView = hasKeptRaw
                    ? appendCommit.view.concat(fullTail.slice(keptRawSplitIndex))
                    : appendCommit.view;
                this.commitEvictionEpoch(tailResult, this.freezeState.epochs);
                this.appendEpochsSinceHardReset += 1;
                // Arm the post-fold floor capture: the next measured reading after this
                // append reflects the new frozen-prefix resting level, which the
                // trigger-anchored runway gate uses to escalate future low-yield appends
                // to a hard epoch (CLI parity). Provider-measured tokens only (GOD RULE 7).
                if (typeof context.measuredInputTokens === 'number'
                    && Number.isFinite(context.measuredInputTokens)
                    && context.measuredInputTokens > 0) {
                    this.pendingTailEpochPostFoldFloor = { preFoldTokens: Math.floor(context.measuredInputTokens) };
                }
                // Live overlay: deferred live row (excluded from the sealed band by
                // selectSealableVaultRows) still renders transiently.
                return this.applyLiveVaultOverlay({
                    messages: appendView,
                    cacheHot: false,
                    sealedBoundary: appendCommit.sealedPrefixMessageCount,
                    result: tailResult,
                    appliedFidelity: this.activeFidelity,
                    stats: {
                        ...this.statsFromResult(totalTurns, false, tailResult, false),
                        epochReason: hardEpochBaselineRunwayBypass ? 'tail-epoch-append+hard-epoch-baseline' : 'tail-epoch-append',
                        appendDecision: 'committed',
                        appendRawTailChars: appendCommit.rawTailChars,
                        appendBandChars: appendCommit.bandViewChars,
                        appendSavedChars: appendCommit.savedChars,
                        appendShrinkRatio: appendCommit.shrinkRatio,
                    },
                });
            }
            if (appendCommit.view) {
                this.activeFidelity = previousActiveFidelity;
                touchFoldFreeze(this.freezeState, now);
                // Live overlay: same live-row transient render on the skipped-append
                // (hot view) path.
                return this.applyLiveVaultOverlay({
                    messages: appendCommit.view,
                    cacheHot: true,
                    sealedBoundary: this.freezeState.lastAppendBoundaryViewCount ?? null,
                    appliedFidelity: this.activeFidelity,
                    stats: {
                        totalTurns,
                        cacheHot: true,
                        hotReuses: this.freezeState.hotReuses,
                        epochs: this.freezeState.epochs,
                        appendDecision: 'skipped',
                        appendSkipReason: appendCommit.skipReason,
                        appendRawTailChars: appendCommit.rawTailChars,
                        appendBandChars: appendCommit.bandViewChars,
                        appendSavedChars: appendCommit.savedChars,
                        ...(appendCommit.shrinkRatio === null ? {} : { appendShrinkRatio: appendCommit.shrinkRatio }),
                        ...this.pressureStats(false),
                    },
                });
            }
        }
        if (recomputeReason === 'tail-epoch' && !pressureCeilingTriggered && !appendOnlyTailEpoch) {
            // Runway-gate escalation (FC parity — resolveTailEpochRouting's
            // runwayGateForcesHardEpoch routes to the portable seed reset). A tail
            // epoch whose captured post-fold floor reaches the fold trigger buys no
            // below-trigger working runway, and an in-place recompute does not drop
            // the frozen floor either. Only a HARD epoch (seed reset) drops the floor
            // to the bottom of the sawtooth and regains runway — route there directly
            // instead of the legacy recompute.
            const seedPrompt = context.hardEpochSeed?.trim() || buildRawHardEpochSeed(messages, {
                maxChars: this.rawHardEpochSeedMaxChars,
            });
            return this.commitHardEpoch(messages, seedPrompt, context, now, totalTurns, false, 'tail-runway-gate+hard-epoch');
        }
        const foldConfig = this.effectiveFoldConfig(desiredFidelity);
        const result = foldContext(messages, this.guardedTurnsToFold(messages, pressureCeilingTriggered), foldConfig, this.buildFoldEvictionInput(messages, durableCursorIndex, upcomingEpoch, now, {
            allowVaultBackedCoverage: pressureCeilingTriggered,
            targetSafeFrontier: pressureCeilingTriggered,
        }), undefined, undefined, this.syntheticContext, this.valueFidelityInput);
        const stepResult = this.foldMarathonSteps(result.messages, context.measuredInputTokens, durableCursorIndex, foldConfig);
        const bookkeepingResult = result.turnsFolded > 0 ? result : stepResult ?? result;
        // Whole-view rebuild: render the whole vault and bake it into the frozen view
        // before sealing (resets the sealed set, mirroring commitFoldFreeze clearing
        // sealedBands). Subsequent append epochs seal only deltas on top of this.
        const recomputeCognitiveBlock = bookkeepingResult.turnsFolded > 0
            ? renderCognitiveBlock(extractCognitiveArtifacts(messages))
            : '';
        const sealedBaseView = this.bakeVault(stepResult?.messages ?? result.messages, 'full');
        // Merge (never append) — same terminal-role invariant as the tail-epoch
        // path: the sealed view may be the entire request body.
        const sealedView = recomputeCognitiveBlock
            ? mergeBlockIntoViewTail(sealedBaseView, recomputeCognitiveBlock)
            : sealedBaseView;
        commitFoldFreeze(this.freezeState, messages, sealedView, ctx, now);
        this.hardEpochCompactBaselineActive = false;
        // In-place recompute clears the sealed-band generation, but it does not
        // reset the hard-epoch generation. Keep the runway gate's arming counter:
        // the floor itself PERSISTS, so resetting the counter here would create a
        // one-epoch blind spot exactly when a cold whole-view rebuild leaves occupancy
        // high. Only a hard epoch clears both the floor and the counter. Arm
        // post-epoch floor capture so the next measured reading can re-baseline it
        // downward or seed a first floor (GOD RULE 7: provider-measured readings only).
        if (typeof context.measuredInputTokens === 'number'
            && Number.isFinite(context.measuredInputTokens)
            && context.measuredInputTokens > 0) {
            this.pendingTailEpochPostFoldFloor = { preFoldTokens: Math.floor(context.measuredInputTokens) };
        }
        this.commitEvictionEpoch(bookkeepingResult, this.freezeState.epochs);
        const epochReason = pressureCeilingTriggered
            ? recomputeReason ? `pressure-ceiling+${recomputeReason}` : 'pressure-ceiling'
            : recomputeReason === 'tail-epoch' && !runway.ok
                ? `tail-runway-gate+${recomputeReason}`
                : recomputeReason;
        // Live overlay: the full bake seals everything EXCEPT the deferred live
        // row; render it transiently on the outgoing view so the unanswered ask is
        // never dropped at an epoch boundary.
        return this.applyLiveVaultOverlay({
            messages: sealedView,
            cacheHot: false,
            sealedBoundary: this.freezeState.lastAppendBoundaryViewCount ?? null,
            result: bookkeepingResult,
            appliedFidelity: this.activeFidelity,
            stats: {
                ...this.statsFromResult(totalTurns, false, bookkeepingResult, pressureCeilingTriggered),
                ...(epochReason ? { epochReason } : {}),
            },
        });
    }
    /** Freeze-layer telemetry: hot reuses since last epoch, lifetime epochs, frozen size. */
    get telemetry() {
        return {
            hotReuses: this.freezeState.hotReuses,
            epochs: this.freezeState.epochs,
            frozenViewChars: this.freezeState.frozenViewChars,
            frozenRawCount: this.freezeState.frozenRawCount,
            evictedSpanCount: this.foldEvictedSpans.length,
            evictedTurnCount: this.foldEvictedSpans.reduce((sum, span) => sum + span.turnCount, 0),
        };
    }
    /**
     * Same-instance hard epoch: replace the prepared view with one compact seed
     * message (live turn merged in by buildHardEpochSeedView) and re-anchor the
     * freeze boundary around it. freezeState is readonly here, so we re-seal in
     * place via commitFoldFreeze (which clears sealedBands on a whole-view rebuild)
     * rather than reassigning a fresh state as the relay session does.
     */
    commitHardEpoch(messages, seedPrompt, context, now, totalTurns, pressureCeilingTriggered, epochReason = 'hard-epoch') {
        // Bake the FULL operator vault into the seed view: the raw hard-epoch seed
        // is char-bounded, so old operator wording can fall off its Current Thread
        // band — the vault companion exists precisely so user messages never fold
        // away, and hard epochs must honor that guarantee too (the recompute path
        // it replaced always did a full bake). Empty/disabled vault → no-op.
        const view = this.bakeVault(buildHardEpochSeedView(messages, seedPrompt), 'full');
        const originalChars = countChars(messages);
        const foldedChars = countChars(view);
        const result = {
            messages: view,
            originalChars,
            foldedChars,
            savingsPercent: originalChars > 0 ? ((originalChars - foldedChars) / originalChars) * 100 : 0,
            turnsFolded: totalTurns,
            turnsRetained: 0,
            foldSummaries: [],
        };
        if (this.freezeEnabled) {
            const ctx = {
                thinningMode: context.thinningMode ?? '',
                claimedPaths: context.claimedPaths ?? EMPTY_CLAIMED,
                measuredInputTokens: context.measuredInputTokens,
            };
            commitFoldFreeze(this.freezeState, messages, view, ctx, now, 'hard-epoch');
            this.freezeState.lastAppendBoundaryViewCount = view.length;
            this.hardEpochCompactBaselineActive = true;
        }
        // Hard reset: the seed reset is the one epoch kind that drops the frozen
        // floor. Clear the trigger-anchored gate state and re-arm floor capture so
        // the next measured reading re-baselines to the fresh seed resting level.
        // The arming counter restarts — the instant-loop guard: the gate cannot
        // fire again until ≥1 epoch commits on this new hard-epoch generation.
        // GOD RULE 7: floor lifecycle uses provider-measured readings only.
        this.appendEpochsSinceHardReset = 0;
        this.tailEpochPostFoldFloorTokens = null;
        this.pendingTailEpochPostFoldFloor = typeof context.measuredInputTokens === 'number'
            && Number.isFinite(context.measuredInputTokens)
            && context.measuredInputTokens > 0
            ? { preFoldTokens: Math.floor(context.measuredInputTokens) }
            : null;
        return {
            messages: view,
            cacheHot: false,
            sealedBoundary: this.freezeEnabled ? (this.freezeState.lastAppendBoundaryViewCount ?? null) : undefined,
            result,
            appliedFidelity: this.activeFidelity,
            stats: {
                ...this.statsFromResult(totalTurns, false, result, pressureCeilingTriggered),
                epochReason,
            },
        };
    }
    statsFromResult(totalTurns, cacheHot, result, pressureCeilingTriggered = false) {
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
            evictionOutcome: result.evictionOutcome,
            ...this.pressureStats(pressureCeilingTriggered),
        };
    }
}
//# sourceMappingURL=FoldSession.js.map