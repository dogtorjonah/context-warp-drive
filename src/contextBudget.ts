/**
 * Model-aware Context Warp budget resolver.
 *
 * Pure arithmetic over documented model windows plus explicit options/env
 * values. It never estimates live prompt tokens from text; callers feed provider
 * telemetry into pressure decisions separately.
 */

import { contextWindowForModel } from './contextWindow.ts';

export const DEFAULT_CONTEXT_BUDGET_TARGET_BAND_TOKENS = 100_000;
/**
 * Fold TRIGGER ceiling — peak measured prompt tokens before a fold/reconstruct
 * fires. Distinct from the steady-state band (~100K post-fold orbit) and the
 * pressure ceiling (240K hard relief). Engines that gate folding on a token
 * threshold (Codex/Gemini reconstruction) read foldTriggerTokens; FC folds
 * continuously and uses the band as its retention target instead. 170K per Jonah
 * (2026-06-18): fold at 170K, crush below the band, average ~100K, reserve 240K.
 */
export const DEFAULT_CONTEXT_BUDGET_FOLD_TRIGGER_TOKENS = 170_000;
export const DEFAULT_CONTEXT_BUDGET_CHARS_PER_TOKEN = 4;
export const DEFAULT_CONTEXT_BUDGET_BAND_MAX_WINDOW_FRACTION = 0.6;
export const DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS = 240_000;
export const DEFAULT_CONTEXT_BUDGET_PRESSURE_MAX_WINDOW_FRACTION = 0.8;
export const DEFAULT_CONTEXT_BUDGET_APPEND_ONLY_MAX_WINDOW_FRACTION = 0.9;
export const DEFAULT_CONTEXT_BUDGET_TOOLRESULT_HEADROOM_SAFETY = 0.8;
export const DEFAULT_CONTEXT_BUDGET_TOOLRESULT_MIN_WINDOW_FRACTION = 0.15;
export const DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_BAND_FRACTION = 0.25;
/**
 * Headroom (tokens) kept between the hot-tail epoch cap and the pressure ceiling
 * so a turn's growth folds into a fresh tail-epoch BEFORE S + band + tail trips
 * the ceiling (which forces an expensive full recompute). Used as the cap for the
 * window-scaled margin; see defaultTailEpochPressureMarginTokens.
 */
export const DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_PRESSURE_MARGIN_TOKENS = 16_000;
/** Absolute floor for the tail-epoch cap so a tight window never collapses to a ~0 tail (fold-every-turn pathology). */
export const MIN_CONTEXT_BUDGET_TAIL_EPOCH_TOKENS = 4_000;

export type ContextBudgetTier =
  | 'tiny-window'
  | 'small-200k'
  | 'mid-400k'
  | 'large-1m'
  | 'huge-2m'
  | 'unknown-conservative';

export type ContextLimitSource =
  | 'explicit-override'
  | 'model-or-engine-table'
  | 'engine-default'
  | 'conservative-fallback';

export type ContextBudgetCompressionProfile =
  | 'survival'
  | 'balanced'
  | 'cache-economic'
  | 'wide-cache-economic';

export type ContextBudgetEvictionPolicy =
  | 'full-recompute-only'
  | 'recompute-on-prefix-saturation'
  | 'recompute-on-cold-or-self-heal';

export interface ContextBudgetEnv {
  VOXXO_FOLD_TARGET_BAND_TOKENS?: string;
  VOXXO_FOLD_TRIGGER_TOKENS?: string;
  VOXXO_FOLD_BAND_MAX_WINDOW_FRACTION?: string;
  VOXXO_FOLD_PRESSURE_CEILING_TOKENS?: string;
  VOXXO_FOLD_PRESSURE_MAX_WINDOW_FRACTION?: string;
  VOXXO_FOLD_APPEND_ONLY_MAX_WINDOW_FRACTION?: string;
  VOXXO_FOLD_PREFIX_SATURATION_FRACTION?: string;
  VOXXO_FOLD_TOOLRESULT_HEADROOM_SAFETY?: string;
  VOXXO_FOLD_TOOLRESULT_MIN_WINDOW_FRACTION?: string;
  VOXXO_FOLD_TAIL_EPOCH_BAND_FRACTION?: string;
  VOXXO_FOLD_TAIL_EPOCH_PRESSURE_MARGIN_TOKENS?: string;
  VOXXO_FOLD_OUTPUT_RESERVE_TOKENS?: string;
  VOXXO_FOLD_SYSTEM_TOOLS_RESERVE_TOKENS?: string;
  VOXXO_FOLD_EMERGENCY_MARGIN_TOKENS?: string;
  VOXXO_FOLD_UNSAFE_DEV_OVERRIDES?: string;
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
  tailEpochBandFraction?: number;
  tailEpochCapTokens?: number;
  tailEpochPressureMarginTokens?: number;
  outputReserveTokens?: number;
  systemToolsReserveTokens?: number;
  emergencyMarginTokens?: number;
  unsafeDevOverrides?: boolean;
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
  tailEpochCapTokens: number;
  tailEpochCapChars: number;
  tailEpochBandFraction: number;
  tailEpochPressureMarginTokens: number;
  toolResultHeadroomSafety: number;
  toolResultMinWindowFraction: number;
  toolResultWindowCapChars: number;
  evictionPolicy: ContextBudgetEvictionPolicy;
  compressionProfile: ContextBudgetCompressionProfile;
  unsafeDevOverrides: boolean;
}

const KNOWN_ENGINE_DEFAULTS = new Set([
  'claude',
  'codex',
  'codex-api',
  'deepseek',
  'gemini',
  'gemini-api',
  'glm',
  'grok',
  'kimi',
  'minimax',
  'mistral',
  'openai',
  'qwen',
]);

const KNOWN_MODEL_PREFIXES = [
  'claude-',
  'codex-',
  'deepseek-',
  'gemini-',
  'glm-',
  'gpt-',
  'grok-',
  'kimi-',
  'minimax-',
  'mistral-',
  'o1',
  'o3',
  'o4',
  'qwen',
];

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  const n = positiveNumber(value);
  return n === undefined ? undefined : Math.round(n);
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseFraction(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : undefined;
}

function resolveFraction(option: number | undefined, envRaw: string | undefined, fallback: number): number {
  const numericOption = positiveNumber(option);
  return numericOption !== undefined && numericOption <= 1
    ? numericOption
    : parseFraction(envRaw) ?? fallback;
}

function isDisabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no';
}

function isEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

function clampPositiveTokensToWindow(tokens: number, windowTokens: number, fraction: number): number {
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return tokens;
  const ceiling = Math.round(windowTokens * fraction);
  return ceiling > 0 ? Math.min(tokens, ceiling) : tokens;
}

function clampToCeiling(tokens: number, ceilingTokens: number, unsafeDevOverrides: boolean): number {
  if (unsafeDevOverrides) return tokens;
  return ceilingTokens > 0 ? Math.min(tokens, ceilingTokens) : tokens;
}

function reserveFloor(windowTokens: number, fraction: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(windowTokens * fraction)));
}

function classifyLimitSource(model: string, engine: string, explicitWindow: boolean): ContextLimitSource {
  if (explicitWindow) return 'explicit-override';
  const engineLower = engine.toLowerCase();
  const modelLower = model.toLowerCase();
  const hasKnownEngine = KNOWN_ENGINE_DEFAULTS.has(engineLower);
  const hasKnownModelShape = KNOWN_MODEL_PREFIXES.some((prefix) => modelLower.startsWith(prefix));
  if (hasKnownModelShape) return 'model-or-engine-table';
  if (hasKnownEngine) return model ? 'model-or-engine-table' : 'engine-default';
  return 'conservative-fallback';
}

function classifyTier(windowTokens: number, source: ContextLimitSource): ContextBudgetTier {
  if (source === 'conservative-fallback') return 'unknown-conservative';
  if (windowTokens <= 128_000) return 'tiny-window';
  if (windowTokens <= 258_000) return 'small-200k';
  if (windowTokens <= 512_000) return 'mid-400k';
  if (windowTokens <= 1_048_576) return 'large-1m';
  return 'huge-2m';
}

function compressionProfileForTier(tier: ContextBudgetTier): ContextBudgetCompressionProfile {
  if (tier === 'tiny-window' || tier === 'small-200k' || tier === 'unknown-conservative') {
    return 'survival';
  }
  if (tier === 'mid-400k') return 'balanced';
  if (tier === 'large-1m') return 'cache-economic';
  return 'wide-cache-economic';
}

function defaultOutputReserveTokens(windowTokens: number): number {
  if (windowTokens <= 128_000) return 8_000;
  if (windowTokens <= 258_000) return 16_000;
  if (windowTokens <= 512_000) return 32_000;
  return 64_000;
}

function defaultSystemToolsReserveTokens(windowTokens: number): number {
  return reserveFloor(windowTokens, 0.08, 8_000, 80_000);
}

function defaultEmergencyMarginTokens(windowTokens: number): number {
  return reserveFloor(windowTokens, windowTokens <= 258_000 ? 0.04 : 0.03, 4_000, 48_000);
}

function defaultTailEpochPressureMarginTokens(windowTokens: number): number {
  return reserveFloor(windowTokens, 0.015, 4_000, DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_PRESSURE_MARGIN_TOKENS);
}

export function resolveContextBudget(input: ResolveContextBudgetInput = {}): ContextBudgetResolution {
  const env = input.env ?? {};
  const model = input.model?.trim() ?? '';
  const engine = input.engine?.trim() ?? '';
  const explicitWindowTokens = positiveInt(input.contextWindowTokens);
  const contextWindowTokens = explicitWindowTokens
    ?? contextWindowForModel(model, engine || undefined);
  const limitSource = classifyLimitSource(model, engine, explicitWindowTokens !== undefined);
  const budgetTier = classifyTier(contextWindowTokens, limitSource);
  const unsafeDevOverrides = input.unsafeDevOverrides === true
    || isEnabled(env.VOXXO_FOLD_UNSAFE_DEV_OVERRIDES);
  const hardWindowTokens = contextWindowTokens;
  const charsPerToken = positiveNumber(input.charsPerToken) ?? DEFAULT_CONTEXT_BUDGET_CHARS_PER_TOKEN;

  const outputReserveTokens = positiveInt(input.outputReserveTokens)
    ?? parsePositiveInt(env.VOXXO_FOLD_OUTPUT_RESERVE_TOKENS)
    ?? defaultOutputReserveTokens(hardWindowTokens);
  const systemToolsReserveTokens = positiveInt(input.systemToolsReserveTokens)
    ?? parsePositiveInt(env.VOXXO_FOLD_SYSTEM_TOOLS_RESERVE_TOKENS)
    ?? defaultSystemToolsReserveTokens(hardWindowTokens);
  const emergencyMarginTokens = positiveInt(input.emergencyMarginTokens)
    ?? parsePositiveInt(env.VOXXO_FOLD_EMERGENCY_MARGIN_TOKENS)
    ?? defaultEmergencyMarginTokens(hardWindowTokens);
  const messageCeilingTokens = Math.max(
    1,
    hardWindowTokens - outputReserveTokens - emergencyMarginTokens,
  );

  const requestedBandTokens = positiveInt(input.targetBandTokens)
    ?? parsePositiveInt(env.VOXXO_FOLD_TARGET_BAND_TOKENS)
    ?? DEFAULT_CONTEXT_BUDGET_TARGET_BAND_TOKENS;
  const bandMaxWindowFraction = resolveFraction(
    input.bandMaxWindowFraction,
    env.VOXXO_FOLD_BAND_MAX_WINDOW_FRACTION,
    DEFAULT_CONTEXT_BUDGET_BAND_MAX_WINDOW_FRACTION,
  );
  const bandWindowClamp = unsafeDevOverrides
    ? requestedBandTokens
    : clampPositiveTokensToWindow(
      requestedBandTokens,
      hardWindowTokens,
      bandMaxWindowFraction,
    );
  const bandTokens = clampToCeiling(bandWindowClamp, messageCeilingTokens, unsafeDevOverrides);

  const pressureMaxWindowFraction = resolveFraction(
    input.pressureMaxWindowFraction,
    env.VOXXO_FOLD_PRESSURE_MAX_WINDOW_FRACTION,
    DEFAULT_CONTEXT_BUDGET_PRESSURE_MAX_WINDOW_FRACTION,
  );
  let pressureCeilingTokens: number | null;
  if (input.pressureCeilingTokens === null || isDisabled(env.VOXXO_FOLD_PRESSURE_CEILING_TOKENS)) {
    pressureCeilingTokens = null;
  } else {
    const requestedPressure = positiveInt(input.pressureCeilingTokens)
      ?? parsePositiveInt(env.VOXXO_FOLD_PRESSURE_CEILING_TOKENS)
      ?? clampPositiveTokensToWindow(
        DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS,
        hardWindowTokens,
        pressureMaxWindowFraction,
      );
    pressureCeilingTokens = clampToCeiling(requestedPressure, messageCeilingTokens, unsafeDevOverrides);
  }

  // Fold trigger sits between the steady-state band and the pressure ceiling:
  // band ≤ trigger ≤ min(pressureCeiling, messageCeiling). Engines fold/reconstruct
  // when measured occupancy crosses this, then crush back toward the band — so 100K
  // is the orbit, NOT the trigger. Tiny windows clamp the trigger down to the ceiling.
  const requestedFoldTriggerTokens = positiveInt(input.foldTriggerTokens)
    ?? parsePositiveInt(env.VOXXO_FOLD_TRIGGER_TOKENS)
    ?? DEFAULT_CONTEXT_BUDGET_FOLD_TRIGGER_TOKENS;
  const foldTriggerUpperBound = Math.min(
    pressureCeilingTokens ?? messageCeilingTokens,
    messageCeilingTokens,
  );
  const foldTriggerTokens = unsafeDevOverrides
    ? requestedFoldTriggerTokens
    : Math.min(Math.max(requestedFoldTriggerTokens, bandTokens), foldTriggerUpperBound);

  const appendOnlyMaxWindowFraction = resolveFraction(
    input.appendOnlyMaxWindowFraction,
    env.VOXXO_FOLD_APPEND_ONLY_MAX_WINDOW_FRACTION ?? env.VOXXO_FOLD_PREFIX_SATURATION_FRACTION,
    DEFAULT_CONTEXT_BUDGET_APPEND_ONLY_MAX_WINDOW_FRACTION,
  );
  const rawPrefixSaturationTokens = Number.isFinite(hardWindowTokens) && hardWindowTokens > 0
    ? Math.round(hardWindowTokens * appendOnlyMaxWindowFraction)
    : null;
  const prefixSaturationTokens = rawPrefixSaturationTokens === null
    ? null
    : clampToCeiling(rawPrefixSaturationTokens, messageCeilingTokens, unsafeDevOverrides);
  const prefixSaturationChars = prefixSaturationTokens === null
    ? null
    : Math.round(prefixSaturationTokens * charsPerToken);

  // S-aware, pressure-geometry tail-epoch cap.
  // The append-only hot tail rides ON TOP of the system+tools prefix (S, modeled
  // as systemToolsReserveTokens) and the frozen band (B). The expensive event the
  // tail-epoch exists to avoid is tripping the pressure ceiling, which forces a
  // FULL recompute — so the tail should be as large as fits UNDER that ceiling:
  //   tail = pressureCeiling − S − band − margin
  // This shrinks automatically under heavy tool load (large S) and grows when there
  // is headroom, unlike the old pressure-blind band×fraction default that ignored S
  // and let S+band+tail breach the ceiling at high tool counts. The band fraction
  // survives only as the fallback when no pressure ceiling is configured; explicit
  // overrides and the messageCeiling−band clamp still bound the result.
  const tailEpochBandFraction = resolveFraction(
    input.tailEpochBandFraction,
    env.VOXXO_FOLD_TAIL_EPOCH_BAND_FRACTION,
    DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_BAND_FRACTION,
  );
  const tailEpochPressureMarginTokens = positiveInt(input.tailEpochPressureMarginTokens)
    ?? parsePositiveInt(env.VOXXO_FOLD_TAIL_EPOCH_PRESSURE_MARGIN_TOKENS)
    ?? defaultTailEpochPressureMarginTokens(hardWindowTokens);
  const bandFractionTailTokens = Math.max(1, Math.round(bandTokens * tailEpochBandFraction));
  const pressureGeometryTailTokens = pressureCeilingTokens === null
    ? null
    : pressureCeilingTokens - systemToolsReserveTokens - bandTokens - tailEpochPressureMarginTokens;
  const defaultTailEpochCapTokens = pressureGeometryTailTokens === null
    ? bandFractionTailTokens
    : Math.max(MIN_CONTEXT_BUDGET_TAIL_EPOCH_TOKENS, pressureGeometryTailTokens);
  const requestedTailEpochCapTokens = positiveInt(input.tailEpochCapTokens)
    ?? defaultTailEpochCapTokens;
  const tailEpochCeiling = Math.max(1, messageCeilingTokens - bandTokens);
  const tailEpochCapTokens = clampToCeiling(
    Math.max(1, requestedTailEpochCapTokens),
    tailEpochCeiling,
    unsafeDevOverrides,
  );

  const toolResultHeadroomSafety = resolveFraction(
    input.toolResultHeadroomSafety,
    env.VOXXO_FOLD_TOOLRESULT_HEADROOM_SAFETY,
    DEFAULT_CONTEXT_BUDGET_TOOLRESULT_HEADROOM_SAFETY,
  );
  const toolResultMinWindowFraction = resolveFraction(
    input.toolResultMinWindowFraction,
    env.VOXXO_FOLD_TOOLRESULT_MIN_WINDOW_FRACTION,
    DEFAULT_CONTEXT_BUDGET_TOOLRESULT_MIN_WINDOW_FRACTION,
  );

  const bandChars = Math.round(bandTokens * charsPerToken);
  const batchAvailableTokens = Math.max(1, messageCeilingTokens - bandTokens - systemToolsReserveTokens);
  const batchAvailableChars = Math.max(1, Math.round(batchAvailableTokens * charsPerToken));
  const headroomChars = Math.round(batchAvailableChars * toolResultHeadroomSafety);
  const floorChars = Math.min(
    Math.round(hardWindowTokens * charsPerToken * toolResultMinWindowFraction),
    batchAvailableChars,
  );
  const cap = Math.max(floorChars, headroomChars);
  const toolResultWindowCapChars = cap > 0 ? Math.min(bandChars, cap) : bandChars;
  const tailEpochCapChars = Math.max(1, Math.round(tailEpochCapTokens * charsPerToken));
  const compressionProfile = compressionProfileForTier(budgetTier);
  const evictionPolicy: ContextBudgetEvictionPolicy = compressionProfile === 'survival'
    ? 'full-recompute-only'
    : 'recompute-on-prefix-saturation';

  return {
    model,
    engine,
    budgetTier,
    limitSource,
    conservativeFallback: limitSource === 'conservative-fallback',
    contextWindowTokens,
    hardWindowTokens,
    outputReserveTokens,
    systemToolsReserveTokens,
    emergencyMarginTokens,
    messageCeilingTokens,
    requestedBandTokens,
    bandTokens,
    foldTriggerTokens,
    appendOnlyBandTargetTokens: bandTokens,
    bandChars,
    charsPerToken,
    bandMaxWindowFraction,
    pressureCeilingTokens,
    pressureMaxWindowFraction,
    appendOnlyMaxWindowFraction,
    appendOnlyPressureCeilingTokens: prefixSaturationTokens,
    prefixSaturationTokens,
    prefixSaturationChars,
    tailEpochCapTokens,
    tailEpochCapChars,
    tailEpochBandFraction,
    tailEpochPressureMarginTokens,
    toolResultHeadroomSafety,
    toolResultMinWindowFraction,
    toolResultWindowCapChars,
    evictionPolicy,
    compressionProfile,
    unsafeDevOverrides,
  };
}
