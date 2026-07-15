/**
 * Context window size lookup for known models.
 *
 * Used to provide accurate context window sizes when the engine/SDK
 * doesn't report them in usage data (Codex, Gemini CLI).
 * Values are in tokens.
 *
 * ⚠ These values MUST be each model's GUARANTEED context floor, not its
 * advertised maximum. The pressure ladder (CONTEXT_THRESHOLDS) computes
 * WARNING / CRITICAL / AUTO_COMPACT as fractions of this number, so an
 * optimistic value pushes those tripwires ABOVE the provider's real wall —
 * the gauge reads "healthy" right until the API hard-rejects the request.
 * Precedent: MiniMax-M3 was set to its advertised 1M and a long single-turn
 * run sailed past MiniMax's real ceiling into a 400 "context window exceeds
 * limit" (instance wEO2Ch8H, 2026-06-12). Corrected to the spec's guaranteed
 * 512K floor. Exceptions set above 200k are deliberate, not advertised-max
 * traps: claude-fable-5 at 1M is evidence-backed (≥351k live context was billed
 * on it, disproving the 200k floor); the modern Claude 4.x API family at 1M
 * (Opus 4-6/4-7/4-8 and Sonnet 4-6) is provider-documented and
 * operator-confirmed, so the 200k rollout entries were the real bug. Do NOT
 * revert these to 200k as a MiniMax-style correction; the 1M is intended.
 */
/**
 * Get the context window size for a given model.
 *
 * Resolution order:
 * 1. Engine+model overrides for surface-specific windows (e.g. Codex API vs CLI)
 * 2. Exact match in MODEL_CONTEXT_WINDOWS
 * 3. Prefix match (e.g., "claude-opus-4-20250514-beta" matches "claude-opus-4-20250514")
 * 4. Engine default
 * 5. Conservative fallback (200k)
 */
export declare function contextWindowForModel(model: string, engine?: string): number;
/**
 * Context utilization thresholds for proactive monitoring.
 */
export declare const CONTEXT_THRESHOLDS: {
    /** Below this, context usage is healthy — no action needed */
    readonly HEALTHY: 0.6;
    /** At this level, inject a gentle reminder about context usage */
    readonly WARNING: 0.75;
    /** At this level, inject an urgent warning and recommend compaction */
    readonly CRITICAL: 0.88;
    /** At this level, auto-trigger compaction if available */
    readonly AUTO_COMPACT: 0.93;
};
export type ContextUtilizationLevel = 'healthy' | 'warning' | 'critical' | 'auto_compact';
/**
 * Determine the utilization level given current tokens and context window.
 */
export declare function getUtilizationLevel(currentTokens: number, contextWindow: number): ContextUtilizationLevel;
/**
 * Estimate the number of turns remaining before context is full.
 */
export declare function estimateTurnsRemaining(currentTokens: number, contextWindow: number, avgTokensPerTurn: number): number;
