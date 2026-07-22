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

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // ── Claude models ──
  'claude-fable-5': 1_000_000, // Fable 5: 1M — ≥351k live context observed+billed on gHMKZbT6 (2026-06-10) disproved the 200k floor; matches provider-reported window
  'claude-opus-4-20250514': 200_000,
  'claude-opus-4': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-sonnet-4-6': 1_000_000, // Sonnet 4.6 ships a 1M Claude API window; /200k gauges were stale rollout metadata
  'claude-sonnet-5': 1_000_000, // Sonnet 5 (2026-06-30 launch): 1M Claude API window, provider-documented (platform.claude.com); same modern Claude family exception as Sonnet 4.6
  'claude-opus-4-8': 1_000_000, // Opus 4.x ships a 1M window — operator-directed (Jonah, 2026-06-13); mirrors the fable-5 exception (see invariant doc above)
  'claude-opus-4-7': 1_000_000, // same Opus 4.x family window
  'claude-opus-4-6': 1_000_000, // same Opus 4.x family window
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus-20240229': 200_000,
  'claude-3-haiku-20240307': 200_000,

  // ── OpenAI / Codex models ──
  // Codex CLI GPT-5.x product limit = 400K total = 272K input + 128K reserved
  // output, with ~95% effective input (~258K). The API path is different:
  // `engine: codex-api` gets a 1M budget and is handled by an engine+model
  // override before this generic model table. Do not collapse the two surfaces.
  // Anchoring the CLI path to the advertised/API 1M was the MiniMax-M3 trap (see
  // invariant doc above): instance UChw0eb_ (codex-5.5-instant, "fast" tier)
  // read "25% healthy" at 264,175 input tokens and Codex hard-errored "ran out
  // of room in the model's context window" (2026-06-14). 258K = guaranteed
  // effective input floor so CONTEXT_THRESHOLDS trip below the real wall
  // (AUTO_COMPACT 0.93 → ~240K). GPT-5.x CLI flagship tiers share the catalog.
  'codex-5.6': 258_000,
  'codex-5.6-sol': 258_000,
  'codex-5.6-terra': 258_000,
  'codex-5.6-luna': 258_000,
  'codex-5.5': 258_000,
  'codex-5.5-instant': 258_000,
  'codex-5.4': 258_000,
  'gpt-5.6': 258_000,
  'gpt-5.6-sol': 258_000,
  'gpt-5.6-terra': 258_000,
  'gpt-5.6-luna': 258_000,
  'gpt-5.5': 258_000,
  'gpt-5.4': 258_000,
  'gpt-5.4-pro': 258_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5.3-codex-spark': 400_000,
  'gpt-4.1': 1_048_576,
  'gpt-4.1-mini': 1_048_576,
  'gpt-4.1-nano': 1_048_576,
  'codex-mini-latest': 1_048_576,
  'codex-mini': 1_048_576,
  'o4-mini': 200_000,
  'o3-pro': 200_000,
  'o3-pro-2025-06-10': 200_000,
  'o3': 200_000,
  'o3-mini': 200_000,
  'o1': 200_000,
  'o1-mini': 128_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,

  // ── Gemini models ──
  'gemini-3.1-pro-preview': 1_048_576,
  'gemini-3.1-pro-preview-customtools': 1_048_576,
  'gemini-3.1-flash-lite-preview': 1_048_576,
  'gemini-3-pro-preview': 1_048_576,
  'gemini-3-flash-preview': 1_048_576,
  'gemini-3-pro-image-preview': 65_536,
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-pro-preview-05-06': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-preview-04-17': 1_048_576,
  'gemini-2.0-flash': 1_048_576,
  'gemini-2.0-flash-lite': 1_048_576,
  'gemini-1.5-pro': 2_097_152,
  'gemini-1.5-flash': 1_048_576,

  // ── MiniMax models ──
  // 512K = the spec's GUARANTEED minimum ("up to 1M context window, with a
  // guaranteed minimum of 512K"). The 1M is a ceiling the endpoint can enforce
  // lower; anchoring the safety ladder to the floor lets AUTO_COMPACT (0.93)
  // trip at ~476k — below MiniMax's real wall — instead of a phantom 930k.
  'MiniMax-M3': 512_000,
  'MiniMax-M2.7': 204_800,
  'MiniMax-M2.7-highspeed': 204_800,

  // ── Mistral models ──
  'mistral-medium-3.5': 256_000,
  'mistral-large-2512': 256_000,
  'mistral-large-latest': 256_000,
  'mistral-small-2506': 128_000,
  'mistral-small-latest': 128_000,

  // ── Grok (xAI) models ──
  'grok-4.3': 1_000_000,
  'grok-4-1-fast-reasoning': 2_000_000,
  'grok-4-1-fast-non-reasoning': 2_000_000,
  'grok-4.20-0309-reasoning': 2_000_000,
  'grok-4.20-0309-non-reasoning': 2_000_000,
  'grok-4.20-multi-agent-0309': 2_000_000,

  // ── GLM (Z.ai) models ──
  'glm-5.2': 1_000_000,
  'glm-5.1': 200_000,
  'glm-5-turbo': 200_000,
  'glm-5': 80_000,
  'glm-4.7': 200_000,
  // GLM Vision models
  'glm-5v-turbo': 200_000,
  'glm-4.6v': 128_000,
  'glm-4.6v-flashx': 128_000,
  'glm-4.6v-flash': 128_000,

  // ── DeepSeek models ──
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash': 1_000_000,

  // ── Moonshot / Kimi models ──
  'kimi-k3': 1_000_000,
  'kimi-k2.7-code': 256_000,
  'kimi-k2.7-code-highspeed': 256_000,
  'kimi-k2.6': 256_000,
  'kimi-k2.5': 256_000,

  // ── Qwen / DashScope models ──
  'qwen3.7-plus': 1_000_000,
  'qwen3.7-max': 1_000_000,
  'qwen3.6-flash': 1_000_000,
  'qwen3-coder-next': 1_000_000,
  'qwen3.6-max': 1_000_000,
  'qwen3.6-plus': 1_000_000,
  'qwen3.5-max': 1_000_000,
  'qwen3.5-plus': 1_000_000,
  'qwen-3.7-plus': 1_000_000,
  'qwen-3.7-max': 1_000_000,
  'qwen-3.6-flash': 1_000_000,
  'qwen-3.6-max': 1_000_000,
  'qwen-3.6-plus': 1_000_000,
  'qwen-3.5-max': 1_000_000,
  'qwen-3.5-plus': 1_000_000,

  // ── Thinking Machines Inkling (OpenRouter, provider-qualified ids) ──
  // Advertised ~1.05M; pinned to a conservative guaranteed floor (see MiniMax precedent in ENGINE_DEFAULTS).
  'thinkingmachines/inkling': 512_000,
  'thinkingmachines/inkling-small': 512_000,
  'inkling': 512_000,
  'inkling-small': 512_000,

  // ── OpenAI direct models (non-Codex) ──
  'gpt-5.4-mini': 400_000,
  'gpt-5.4-nano': 400_000,
};

// Engine-level defaults when model is unknown
const ENGINE_DEFAULTS: Record<string, number> = {
  claude: 200_000,
  'claude-cli': 1_000_000, // Claude Code CLI default spawn surface; exact legacy model rows still self-clamp.
  'claude-interactive': 1_000_000,
  codex: 258_000, // CLI/OAuth-backed Codex fallback; codex-api remains the 1M API surface below
  gemini: 1_048_576,
  minimax: 512_000, // guaranteed floor, not the advertised 1M ceiling (see MiniMax-M3 above)
  mistral: 128_000,
  grok: 1_000_000,
  openai: 400_000,
  glm: 200_000,
  deepseek: 1_000_000,
  kimi: 256_000,
  qwen: 1_000_000,
  inkling: 512_000, // guaranteed floor, not advertised ~1.05M ceiling (Thinking Machines Inkling via OpenRouter)
  'codex-api': 1_048_576,
  'gemini-api': 1_048_576,
};

function isCodexApiLargeContextModel(modelLower: string): boolean {
  if (!modelLower) return false;
  if (modelLower === 'codex-5.6' || modelLower.startsWith('codex-5.6-') || modelLower === 'codex-5.5' || modelLower === 'codex-5.5-instant' || modelLower === 'codex-5.4') {
    return true;
  }
  if (modelLower === 'gpt-5.6' || modelLower.startsWith('gpt-5.6-')) {
    return true;
  }
  if (modelLower === 'gpt-5.5' || modelLower.startsWith('gpt-5.5-')) {
    return true;
  }
  if (modelLower === 'gpt-5.4' || modelLower === 'gpt-5.4-pro') {
    return true;
  }
  return modelLower.startsWith('gpt-5.4-') && !modelLower.includes('mini') && !modelLower.includes('nano');
}

function contextWindowOverrideForEngineModel(modelLower: string, engineLower: string): number | undefined {
  // Codex API and Codex CLI can report the same tier/provider model strings but
  // have different effective windows. Resolve the API surface before the generic
  // model table so gpt-5.5/codex-5.5 can be 1M on API and 258K on CLI.
  if (engineLower === 'codex-api' && isCodexApiLargeContextModel(modelLower)) {
    return 1_048_576;
  }
  if (engineLower === 'openai' && (modelLower === 'gpt-5.6' || modelLower.startsWith('gpt-5.6-'))) {
    return 1_048_576;
  }
  return undefined;
}

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
export function contextWindowForModel(
  model: string,
  engine?: string,
): number {
  const normalizedModel = model.trim();
  const modelLower = normalizedModel.toLowerCase();
  const engineLower = engine?.trim().toLowerCase() ?? '';

  // 1. Surface-specific override
  const engineModelOverride = contextWindowOverrideForEngineModel(modelLower, engineLower);
  if (engineModelOverride !== undefined) return engineModelOverride;

  // 2. Exact match
  const exact = MODEL_CONTEXT_WINDOWS[normalizedModel];
  if (exact) return exact;

  // 3. Prefix match — try longest matching prefix
  let bestMatch = '';
  let bestValue = 0;
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (modelLower.startsWith(key.toLowerCase()) && key.length > bestMatch.length) {
      bestMatch = key;
      bestValue = value;
    }
  }
  if (bestValue) return bestValue;

  // 4. Engine default
  if (engineLower) {
    const engineDefault = ENGINE_DEFAULTS[engineLower];
    if (engineDefault) return engineDefault;
  }

  // 5. Conservative fallback
  return 200_000;
}


/**
 * Context utilization thresholds for proactive monitoring.
 */
export const CONTEXT_THRESHOLDS = {
  /** Below this, context usage is healthy — no action needed */
  HEALTHY: 0.60,
  /** At this level, inject a gentle reminder about context usage */
  WARNING: 0.75,
  /** At this level, inject an urgent warning and recommend compaction */
  CRITICAL: 0.88,
  /** At this level, auto-trigger compaction if available */
  AUTO_COMPACT: 0.93,
} as const;

export type ContextUtilizationLevel = 'healthy' | 'warning' | 'critical' | 'auto_compact';

/**
 * Determine the utilization level given current tokens and context window.
 */
export function getUtilizationLevel(
  currentTokens: number,
  contextWindow: number,
): ContextUtilizationLevel {
  if (contextWindow <= 0) return 'healthy';
  const pct = currentTokens / contextWindow;
  if (pct >= CONTEXT_THRESHOLDS.AUTO_COMPACT) return 'auto_compact';
  if (pct >= CONTEXT_THRESHOLDS.CRITICAL) return 'critical';
  if (pct >= CONTEXT_THRESHOLDS.WARNING) return 'warning';
  return 'healthy';
}

/**
 * Estimate the number of turns remaining before context is full.
 */
export function estimateTurnsRemaining(
  currentTokens: number,
  contextWindow: number,
  avgTokensPerTurn: number,
): number {
  if (contextWindow <= 0 || avgTokensPerTurn <= 0) return Infinity;
  const remaining = contextWindow - currentTokens;
  if (remaining <= 0) return 0;
  return Math.floor(remaining / avgTokensPerTurn);
}
