/**
 * Model-aware Context Warp budget resolver.
 *
 * Pure arithmetic over documented model windows plus explicit options/env
 * values. It never estimates live prompt tokens from text; callers feed provider
 * telemetry into pressure decisions separately.
 */
export declare const DEFAULT_CONTEXT_BUDGET_SYSTEM_TOOLS_RESERVE_TOKENS = 37000;
export declare const DEFAULT_CONTEXT_BUDGET_TARGET_BAND_TOKENS = 40000;
export declare const DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS = 5000;
export declare const DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_RUNWAY_TOKENS = 10000;
export declare const DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_MIN_RUNWAY_TOKENS = 30000;
export declare const DEFAULT_CONTEXT_BUDGET_CODEX_CLI_RECONSTRUCT_RUNWAY_TOKENS = 30000;
/**
 * Legacy hybrid fold TRIGGER default. Under single-ceiling mode this is an
 * inert compatibility/kill-switch value; P is the only active fold boundary.
 * In legacy hybrid mode, 150K remains the uniform measured-prompt-token
 * threshold at which every engine folds/reconstructs (FC API, Codex CLI,
 * Claude CLI, and Gemini CLI all resolve to this). Deliberately 150K = 30K
 * BELOW the P=180K pressure ceiling (Jonah, 2026-07-07: "I wanna give everyone
 * the same ceiling of 180k" — raising the 2026-07-04 uniform 120K/150K
 * geometry; that raise is intentional, do not "restore" the old values). 150K
 * is the LARGEST value that still sits under every engine's runway clamp
 * (Claude CLI:
 * min(msgCeiling, ceiling)−20K = 160K on 200K windows; Codex CLI:
 * msgCeiling−30K), so all engines collapse to exactly 150K instead of diverging
 * or colliding with the ceiling (trigger==ceiling ⇒ 0 tail epochs, measured
 * live 2026-07-04 — never set trigger equal to the ceiling).
 *
 * LEGACY NOTE: this is the hybrid TRIGGER — a DISTINCT knob from the P=180K
 * pressure ceiling (DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS below). Do
 * not conflate them (recurring regression). Gemini CLI reads this constant
 * directly as its own default; FC/Codex/Claude CLI honor the same value via
 * VOXXO_/WARP_FOLD_TRIGGER_TOKENS — keep the env pin (ecosystem.config.cjs) and
 * this constant in agreement. Distinct from the steady-state band (M=40K folded
 * memory): FC folds continuously toward this target; CLI engines clamp it under
 * the pressure ceiling.
 */
export declare const DEFAULT_CONTEXT_BUDGET_FOLD_TRIGGER_TOKENS = 150000;
export declare const DEFAULT_CONTEXT_BUDGET_CHARS_PER_TOKEN = 4;
export declare const DEFAULT_CONTEXT_BUDGET_BAND_MAX_WINDOW_FRACTION = 0.6;
/**
 * BASE pressure ceiling default — the uniform fallback when neither the
 * per-model nor the per-engine tuning table below matches. P=180K base
 * (Jonah, 2026-07-07: "I wanna give everyone the same ceiling of 180k" —
 * deliberately raised from the 2026-07-04 uniform 150K; do not "fix" this
 * back to 150K). Since 2026-07-10 (Jonah) the CLI surfaces carry per-engine
 * defaults ABOVE this base — Codex CLI and the Claude Code CLI/tmux surfaces
 * run 220K via ENGINE_PRESSURE_CEILING_DEFAULTS — while FC engines stay on
 * this uniform base. Explicit per-session overrides and the
 * VOXXO_/WARP_FOLD_PRESSURE_CEILING_TOKENS env still win over every table
 * entry. On 200K windows the resolved default rides at messageCeiling
 * (window − output 16K − emergency 4K = 180K), which always bounds it.
 */
export declare const DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS = 180000;
/**
 * Back-compat alias for callers that used the old Opus max-context name.
 * It intentionally equals the universal default: no hidden model-specific carve-out.
 */
export declare const DEFAULT_CONTEXT_BUDGET_OPUS_MAX_PRESSURE_CEILING_TOKENS = 180000;
/**
 * ── Per-model / per-engine pressure-ceiling tuning tables ───────────────────
 * THE easy knob for tuning the fold pressure ceiling of every spawnable model
 * (Jonah, 2026-07-10). defaultPressureCeilingTokensForModelEngine resolves:
 *   1. MODEL_PRESSURE_CEILING_DEFAULTS — exact model match (lowercase keys)
 *   2. MODEL_PRESSURE_CEILING_DEFAULTS — longest model-prefix match
 *   3. ENGINE_PRESSURE_CEILING_DEFAULTS — engine match (lowercase keys)
 *   4. DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS — uniform 180K base
 * These are DEFAULTS, not caps: an explicit input.pressureCeilingTokens
 * (spawn param / live per-instance override) or the
 * VOXXO_/WARP_FOLD_PRESSURE_CEILING_TOKENS env var still wins, and every
 * resolved default is window-clamped (pressureMaxWindowFraction) then
 * messageCeiling-clamped — so a 220K entry on a legacy 200K-window model
 * degrades safely to its 180K messageCeiling instead of breaching the
 * provider wall.
 */
export declare const ENGINE_PRESSURE_CEILING_DEFAULTS: Record<string, number>;
/**
 * Exact/prefix model-level ceiling overrides, consulted BEFORE the engine
 * table. Keys must be lowercase. Add an entry here when a single model needs
 * a different ceiling than its engine default, e.g.
 * 'codex-5.5-instant': 200_000.
 */
export declare const MODEL_PRESSURE_CEILING_DEFAULTS: Record<string, number>;
export declare const DEFAULT_CONTEXT_BUDGET_CLAUDE_CLI_HARD_EPOCH_TOKENS = 180000;
export declare const DEFAULT_CONTEXT_BUDGET_PRESSURE_MAX_WINDOW_FRACTION = 0.9;
export declare const DEFAULT_CONTEXT_BUDGET_APPEND_ONLY_MAX_WINDOW_FRACTION = 0.9;
export declare const DEFAULT_CONTEXT_BUDGET_TOOLRESULT_HEADROOM_SAFETY = 0.8;
export declare const DEFAULT_CONTEXT_BUDGET_TOOLRESULT_MIN_WINDOW_FRACTION = 0.15;
export declare const DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_BAND_FRACTION = 0.25;
/**
 * Fallback headroom (tokens) kept between S + M + T and the pressure ceiling
 * when no pressure ceiling is configured. For the standard P180 geometry this
 * is P180 − S37 − M40 − T10 = 93K. (Only consumed when the pressure ceiling is
 * explicitly disabled; with a ceiling present the margin re-derives live as
 * P − S − M − T, which algebraically pins the default tail-epoch cap to T.)
 */
export declare const DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_PRESSURE_MARGIN_TOKENS = 93000;
/** Absolute floor for the tail-epoch cap so a tight window never collapses to a ~0 tail (fold-every-turn pathology). */
export declare const MIN_CONTEXT_BUDGET_TAIL_EPOCH_TOKENS = 4000;
export type ContextBudgetTier = 'tiny-window' | 'small-200k' | 'mid-400k' | 'large-1m' | 'huge-2m' | 'unknown-conservative';
export type ContextLimitSource = 'explicit-override' | 'model-or-engine-table' | 'engine-default' | 'conservative-fallback';
export type ContextBudgetCompressionProfile = 'survival' | 'balanced' | 'cache-economic' | 'wide-cache-economic';
/**
 * When the whole frozen view is rebuilt (evicted). Two-epoch law: every
 * whole-view rebuild is a seeded HARD epoch — these values say WHEN the hard
 * epoch fires; none of them is a bandless middle tier.
 */
export type ContextBudgetEvictionPolicy = 'hard-epoch-only' | 'hard-epoch-on-prefix-saturation' | 'hard-epoch-on-cold-or-self-heal';
export interface ContextBudgetEnv {
    VOXXO_FOLD_TARGET_BAND_TOKENS?: string;
    WARP_FOLD_TARGET_BAND_TOKENS?: string;
    VOXXO_FOLD_TRIGGER_TOKENS?: string;
    WARP_FOLD_TRIGGER_TOKENS?: string;
    VOXXO_FOLD_BAND_MAX_WINDOW_FRACTION?: string;
    WARP_FOLD_BAND_MAX_WINDOW_FRACTION?: string;
    VOXXO_FOLD_PRESSURE_CEILING_TOKENS?: string;
    WARP_FOLD_PRESSURE_CEILING_TOKENS?: string;
    VOXXO_FOLD_PRESSURE_MAX_WINDOW_FRACTION?: string;
    WARP_FOLD_PRESSURE_MAX_WINDOW_FRACTION?: string;
    VOXXO_FOLD_APPEND_ONLY_MAX_WINDOW_FRACTION?: string;
    WARP_FOLD_APPEND_ONLY_MAX_WINDOW_FRACTION?: string;
    VOXXO_FOLD_PREFIX_SATURATION_FRACTION?: string;
    WARP_FOLD_PREFIX_SATURATION_FRACTION?: string;
    VOXXO_FOLD_TOOLRESULT_HEADROOM_SAFETY?: string;
    WARP_FOLD_TOOLRESULT_HEADROOM_SAFETY?: string;
    VOXXO_FOLD_TOOLRESULT_MIN_WINDOW_FRACTION?: string;
    WARP_FOLD_TOOLRESULT_MIN_WINDOW_FRACTION?: string;
    VOXXO_FOLD_APPEND_BAND_TARGET_TOKENS?: string;
    WARP_FOLD_APPEND_BAND_TARGET_TOKENS?: string;
    VOXXO_FOLD_TAIL_EPOCH_BAND_FRACTION?: string;
    WARP_FOLD_TAIL_EPOCH_BAND_FRACTION?: string;
    VOXXO_FOLD_TAIL_EPOCH_RUNWAY_TOKENS?: string;
    WARP_FOLD_TAIL_EPOCH_RUNWAY_TOKENS?: string;
    VOXXO_FOLD_TAIL_EPOCH_MIN_RUNWAY_TOKENS?: string;
    WARP_FOLD_TAIL_EPOCH_MIN_RUNWAY_TOKENS?: string;
    VOXXO_FOLD_TAIL_EPOCH_PRESSURE_MARGIN_TOKENS?: string;
    WARP_FOLD_TAIL_EPOCH_PRESSURE_MARGIN_TOKENS?: string;
    VOXXO_FOLD_OUTPUT_RESERVE_TOKENS?: string;
    WARP_FOLD_OUTPUT_RESERVE_TOKENS?: string;
    VOXXO_FOLD_SYSTEM_TOOLS_RESERVE_TOKENS?: string;
    WARP_FOLD_SYSTEM_TOOLS_RESERVE_TOKENS?: string;
    VOXXO_FOLD_EMERGENCY_MARGIN_TOKENS?: string;
    WARP_FOLD_EMERGENCY_MARGIN_TOKENS?: string;
    VOXXO_FOLD_UNSAFE_DEV_OVERRIDES?: string;
    WARP_FOLD_UNSAFE_DEV_OVERRIDES?: string;
    VOXXO_FOLD_SINGLE_CEILING?: string;
    WARP_FOLD_SINGLE_CEILING?: string;
    [key: string]: string | undefined;
}
export interface ResolveContextBudgetInput {
    model?: string | null;
    engine?: string | null;
    env?: ContextBudgetEnv;
    contextWindowTokens?: number;
    targetBandTokens?: number;
    foldTriggerTokens?: number;
    charsPerToken?: number;
    bandMaxWindowFraction?: number;
    pressureCeilingTokens?: number | null;
    pressureMaxWindowFraction?: number;
    appendOnlyMaxWindowFraction?: number;
    toolResultHeadroomSafety?: number;
    toolResultMinWindowFraction?: number;
    appendBandTargetTokens?: number;
    tailEpochBandFraction?: number;
    tailEpochRunwayTokens?: number;
    tailEpochMinRunwayTokens?: number;
    tailEpochCapTokens?: number;
    tailEpochPressureMarginTokens?: number;
    outputReserveTokens?: number;
    systemToolsReserveTokens?: number;
    emergencyMarginTokens?: number;
    unsafeDevOverrides?: boolean;
    /** Single-ceiling geometry: P is the only fold trigger (see signposts). Default on; env kill switch VOXXO_FOLD_SINGLE_CEILING=0. */
    singleCeilingMode?: boolean;
}
export interface ContextBudgetResolution {
    model: string;
    engine: string;
    budgetTier: ContextBudgetTier;
    limitSource: ContextLimitSource;
    conservativeFallback: boolean;
    contextWindowTokens: number;
    hardWindowTokens: number;
    outputReserveTokens: number;
    systemToolsReserveTokens: number;
    emergencyMarginTokens: number;
    messageCeilingTokens: number;
    requestedBandTokens: number;
    bandTokens: number;
    foldTriggerTokens: number;
    appendOnlyBandTargetTokens: number;
    bandChars: number;
    charsPerToken: number;
    bandMaxWindowFraction: number;
    pressureCeilingTokens: number | null;
    pressureMaxWindowFraction: number;
    appendOnlyMaxWindowFraction: number;
    appendOnlyPressureCeilingTokens: number | null;
    prefixSaturationTokens: number | null;
    prefixSaturationChars: number | null;
    appendBandTargetTokens: number;
    tailEpochCapTokens: number;
    tailEpochCapChars: number;
    tailEpochBandFraction: number;
    tailEpochRunwayTokens: number;
    tailEpochMinRunwayTokens: number;
    tailEpochPressureMarginTokens: number;
    toolResultHeadroomSafety: number;
    toolResultMinWindowFraction: number;
    toolResultWindowCapChars: number;
    evictionPolicy: ContextBudgetEvictionPolicy;
    compressionProfile: ContextBudgetCompressionProfile;
    unsafeDevOverrides: boolean;
    /** True when single-ceiling geometry is active for this budget resolution. */
    singleCeilingMode: boolean;
}
export declare function resolveContextBudget(input?: ResolveContextBudgetInput): ContextBudgetResolution;
