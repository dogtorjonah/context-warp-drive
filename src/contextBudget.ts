/**
 * Model-aware Context Warp budget resolver.
 *
 * Pure arithmetic over documented model windows plus explicit options/env
 * values. It never estimates live prompt tokens from text; callers feed provider
 * telemetry into pressure decisions separately.
 */

import { contextWindowForModel } from './contextWindow.ts';

// Context Warp geometry signposts (Jonah, 2026-06-19; P standard set to 150K
// 2026-07-04 after temporary 120K/180K experiments):
//   S = 37K static system/tools prefix reserve (provider-measured floor model)
//   M = 40K folded memory after full recompute
//   A = 5K expected appended folded-tail band
//   T = 10K preferred/default live-tail runway
//   F = 10K default append runway floor (explicit overrides can keep a larger floor)
//   P = 150K universal pressure ceiling default (fraction clamp protects small
//       windows). No model/engine gets a hidden wider default; explicit overrides
//       can still opt sessions into a different ceiling.
//   CLI codex = full-recompute-only transport, using the shared trigger by
//               default while still clamping to message ceiling − F runway
//
// Runtime invariant: at a boundary, append a folded tail band only if the
// post-append prompt can still guarantee F runway before P. The default tail
// cap now aims for T=10K so tail epochs skeletonize nearly the whole unfrozen
// tail instead of carrying a 45K raw runway immune to folding.
// Otherwise do a full recompute and saw the prompt back down to the floor.
export const DEFAULT_CONTEXT_BUDGET_SYSTEM_TOOLS_RESERVE_TOKENS = 37_000;
export const DEFAULT_CONTEXT_BUDGET_TARGET_BAND_TOKENS = 40_000;
export const DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS = 5_000;
export const DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_RUNWAY_TOKENS = 10_000;
export const DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_MIN_RUNWAY_TOKENS = 30_000;
export const DEFAULT_CONTEXT_BUDGET_CODEX_CLI_RECONSTRUCT_RUNWAY_TOKENS =
  DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_MIN_RUNWAY_TOKENS;
/**
 * Fold TRIGGER default — the SINGLE uniform measured-prompt-token threshold at
 * which every engine folds/reconstructs (FC API, Codex CLI, Claude CLI, and
 * Gemini CLI all resolve to this). Deliberately 120K = 30K BELOW the P=150K
 * pressure ceiling (Jonah, 2026-07-04: "all fold triggers for all engines need to
 * be the same"). 120K is the LARGEST value that still sits under every engine's
 * runway clamp (Claude CLI: ceiling−20K=130K; Codex CLI: msgCeiling−30K), so all
 * engines collapse to exactly 120K instead of diverging (previously FC/Codex 150K
 * vs Claude CLI 130K) or colliding with the ceiling (trigger==ceiling ⇒ 0 tail
 * epochs, measured live 2026-07-04).
 *
 * NOTE: this is the TRIGGER — a DISTINCT knob from the P=150K pressure ceiling
 * (DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS below). Do not conflate them
 * (recurring regression) and do not "restore" this to 150K. Gemini CLI reads this
 * constant directly as its own default; FC/Codex/Claude CLI honor the same value
 * via VOXXO_/WARP_FOLD_TRIGGER_TOKENS — keep the env pin and this constant in
 * agreement. Distinct from the steady-state band (M=40K folded memory): FC folds
 * continuously toward this target; CLI engines clamp it under the pressure ceiling.
 */
export const DEFAULT_CONTEXT_BUDGET_FOLD_TRIGGER_TOKENS = 120_000;
export const DEFAULT_CONTEXT_BUDGET_CHARS_PER_TOKEN = 4;
export const DEFAULT_CONTEXT_BUDGET_BAND_MAX_WINDOW_FRACTION = 0.6;
/**
 * Universal pressure ceiling default. Applies to every model/engine unless an
 * explicit per-session/env override supplies another ceiling.
 */
export const DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS = 150_000;
/**
 * Back-compat alias for callers that used the old Opus max-context name.
 * It intentionally equals the universal default: no hidden model-specific carve-out.
 */
export const DEFAULT_CONTEXT_BUDGET_OPUS_MAX_PRESSURE_CEILING_TOKENS =
  DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS;
// Claude Code CLI hard-epoch fallback ceiling. The Claude CLI surfaces (claude /
// claude-cli / claude-interactive) cannot fold in-process
// (engineSupportsRollingFold=false), so instead of mid-stream folding the relay
// can fire an in-place session-swap rebirth ("hard epoch") once provider-MEASURED
// context tokens cross a hard ceiling. Kept distinct from the standard 150K
// pressure ceiling because fold pressure and out-of-process session-swap
// saturation can diverge independently. Consumed by relay handleResultEvent
// (instanceManager/eventHandlers.ts).
export const DEFAULT_CONTEXT_BUDGET_CLAUDE_CLI_HARD_EPOCH_TOKENS = 180_000;
export const DEFAULT_CONTEXT_BUDGET_PRESSURE_MAX_WINDOW_FRACTION = 0.8;
export const DEFAULT_CONTEXT_BUDGET_APPEND_ONLY_MAX_WINDOW_FRACTION = 0.9;
export const DEFAULT_CONTEXT_BUDGET_TOOLRESULT_HEADROOM_SAFETY = 0.8;
export const DEFAULT_CONTEXT_BUDGET_TOOLRESULT_MIN_WINDOW_FRACTION = 0.15;
export const DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_BAND_FRACTION = 0.25;
/**
 * Fallback headroom (tokens) kept between S + M + T and the pressure ceiling
 * when no pressure ceiling is configured. For the standard P150 geometry this
 * is P150 − S37 − M40 − T10 = 63K.
 */
export const DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_PRESSURE_MARGIN_TOKENS = 63_000;
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

function envAlias(env: ContextBudgetEnv, voxxoKey: string, warpKey: string): string | undefined {
  return env[voxxoKey] ?? env[warpKey];
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
  return reserveFloor(windowTokens, 0.08, 8_000, DEFAULT_CONTEXT_BUDGET_SYSTEM_TOOLS_RESERVE_TOKENS);
}

function defaultEmergencyMarginTokens(windowTokens: number): number {
  return reserveFloor(windowTokens, windowTokens <= 258_000 ? 0.04 : 0.03, 4_000, 48_000);
}

function defaultTailEpochPressureMarginTokens(windowTokens: number): number {
  return reserveFloor(windowTokens, 0.027, 4_000, DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_PRESSURE_MARGIN_TOKENS);
}

function isCodexCliEngine(engine: string): boolean {
  return engine.trim().toLowerCase() === 'codex';
}

/**
 * Default pressure ceiling for a given model/engine pair. Kept as a function so
 * old call sites stay model-aware in shape, but the default is now deliberately
 * uniform. Explicit input.pressureCeilingTokens and the
 * VOXXO_/WARP_FOLD_PRESSURE_CEILING_TOKENS env override this default.
 */
function defaultPressureCeilingTokensForModelEngine(_model: string, _engine: string): number {
  return DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS;
}

function defaultCodexCliReconstructTriggerTokens(
  messageCeilingTokens: number,
  hardWindowTokens: number,
  pressureMaxWindowFraction: number,
): number {
  const runwayCappedTarget = Math.max(
    1,
    messageCeilingTokens - DEFAULT_CONTEXT_BUDGET_CODEX_CLI_RECONSTRUCT_RUNWAY_TOKENS,
  );
  return clampPositiveTokensToWindow(
    Math.min(DEFAULT_CONTEXT_BUDGET_FOLD_TRIGGER_TOKENS, runwayCappedTarget),
    hardWindowTokens,
    pressureMaxWindowFraction,
  );
}

export function resolveContextBudget(input: ResolveContextBudgetInput = {}): ContextBudgetResolution {
  const env = input.env ?? {};
  const model = input.model?.trim() ?? '';
  const engine = input.engine?.trim() ?? '';
  const codexCliFullRecomputeOnly = isCodexCliEngine(engine);
  const explicitWindowTokens = positiveInt(input.contextWindowTokens);
  const contextWindowTokens = explicitWindowTokens
    ?? contextWindowForModel(model, engine || undefined);
  const limitSource = classifyLimitSource(model, engine, explicitWindowTokens !== undefined);
  const budgetTier = classifyTier(contextWindowTokens, limitSource);
  const unsafeDevOverrides = input.unsafeDevOverrides === true
    || isEnabled(envAlias(env, 'VOXXO_FOLD_UNSAFE_DEV_OVERRIDES', 'WARP_FOLD_UNSAFE_DEV_OVERRIDES'));
  const hardWindowTokens = contextWindowTokens;
  const charsPerToken = positiveNumber(input.charsPerToken) ?? DEFAULT_CONTEXT_BUDGET_CHARS_PER_TOKEN;

  const outputReserveTokens = positiveInt(input.outputReserveTokens)
    ?? parsePositiveInt(envAlias(env, 'VOXXO_FOLD_OUTPUT_RESERVE_TOKENS', 'WARP_FOLD_OUTPUT_RESERVE_TOKENS'))
    ?? defaultOutputReserveTokens(hardWindowTokens);
  const systemToolsReserveTokens = positiveInt(input.systemToolsReserveTokens)
    ?? parsePositiveInt(envAlias(env, 'VOXXO_FOLD_SYSTEM_TOOLS_RESERVE_TOKENS', 'WARP_FOLD_SYSTEM_TOOLS_RESERVE_TOKENS'))
    ?? defaultSystemToolsReserveTokens(hardWindowTokens);
  const emergencyMarginTokens = positiveInt(input.emergencyMarginTokens)
    ?? parsePositiveInt(envAlias(env, 'VOXXO_FOLD_EMERGENCY_MARGIN_TOKENS', 'WARP_FOLD_EMERGENCY_MARGIN_TOKENS'))
    ?? defaultEmergencyMarginTokens(hardWindowTokens);
  const messageCeilingTokens = Math.max(
    1,
    hardWindowTokens - outputReserveTokens - emergencyMarginTokens,
  );

  const requestedBandTokens = positiveInt(input.targetBandTokens)
    ?? parsePositiveInt(envAlias(env, 'VOXXO_FOLD_TARGET_BAND_TOKENS', 'WARP_FOLD_TARGET_BAND_TOKENS'))
    ?? DEFAULT_CONTEXT_BUDGET_TARGET_BAND_TOKENS;
  const bandMaxWindowFraction = resolveFraction(
    input.bandMaxWindowFraction,
    envAlias(env, 'VOXXO_FOLD_BAND_MAX_WINDOW_FRACTION', 'WARP_FOLD_BAND_MAX_WINDOW_FRACTION'),
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
    envAlias(env, 'VOXXO_FOLD_PRESSURE_MAX_WINDOW_FRACTION', 'WARP_FOLD_PRESSURE_MAX_WINDOW_FRACTION'),
    DEFAULT_CONTEXT_BUDGET_PRESSURE_MAX_WINDOW_FRACTION,
  );
  const codexCliDefaultReconstructTriggerTokens = codexCliFullRecomputeOnly
    ? defaultCodexCliReconstructTriggerTokens(
      messageCeilingTokens,
      hardWindowTokens,
      pressureMaxWindowFraction,
    )
    : null;
  let pressureCeilingTokens: number | null;
  const pressureCeilingEnv = envAlias(env, 'VOXXO_FOLD_PRESSURE_CEILING_TOKENS', 'WARP_FOLD_PRESSURE_CEILING_TOKENS');
  if (input.pressureCeilingTokens === null || isDisabled(pressureCeilingEnv)) {
    pressureCeilingTokens = null;
  } else {
    const requestedPressure = positiveInt(input.pressureCeilingTokens)
      ?? parsePositiveInt(pressureCeilingEnv)
      ?? clampPositiveTokensToWindow(
        defaultPressureCeilingTokensForModelEngine(model, engine),
        hardWindowTokens,
        pressureMaxWindowFraction,
      );
    pressureCeilingTokens = clampToCeiling(requestedPressure, messageCeilingTokens, unsafeDevOverrides);
  }

  // Fold trigger sits between the steady-state band and the pressure ceiling:
  // band ≤ trigger ≤ min(pressureCeiling, messageCeiling). Engines fold/reconstruct
  // when measured occupancy crosses this, then crush back toward the band — so M40
  // is the orbit, NOT the trigger. Tiny windows clamp the trigger down to the ceiling.
  const requestedFoldTriggerTokens = positiveInt(input.foldTriggerTokens)
    ?? parsePositiveInt(envAlias(env, 'VOXXO_FOLD_TRIGGER_TOKENS', 'WARP_FOLD_TRIGGER_TOKENS'))
    ?? codexCliDefaultReconstructTriggerTokens
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
    envAlias(env, 'VOXXO_FOLD_APPEND_ONLY_MAX_WINDOW_FRACTION', 'WARP_FOLD_APPEND_ONLY_MAX_WINDOW_FRACTION')
      ?? envAlias(env, 'VOXXO_FOLD_PREFIX_SATURATION_FRACTION', 'WARP_FOLD_PREFIX_SATURATION_FRACTION'),
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
  // By default, margin is derived from the preferred next-runway target:
  //   margin = pressureCeiling − S − band − T
  // so the raw tail crosses the char cap at T=10K. At the fold boundary, live
  // runtimes still gate ordinary tail epochs on measured provider tokens when
  // available, suppressing cap-only folds until the measured floor is reached.
  // Append eligibility also checks the stacked append bands: if appending the next
  // A=5K band would leave less than F runway before P, runtimes full-recompute
  // instead of extending the staircase.
  // This shrinks automatically under heavy tool load (large S) and grows when there
  // is headroom, unlike the old pressure-blind band×fraction default that ignored S
  // and let S+band+tail breach the ceiling at high tool counts. The band fraction
  // survives only as the fallback when no pressure ceiling is configured; explicit
  // overrides and the messageCeiling−band clamp still bound the result.
  const tailEpochBandFraction = resolveFraction(
    input.tailEpochBandFraction,
    envAlias(env, 'VOXXO_FOLD_TAIL_EPOCH_BAND_FRACTION', 'WARP_FOLD_TAIL_EPOCH_BAND_FRACTION'),
    DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_BAND_FRACTION,
  );
  const appendBandTargetTokens = positiveInt(input.appendBandTargetTokens)
    ?? parsePositiveInt(envAlias(env, 'VOXXO_FOLD_APPEND_BAND_TARGET_TOKENS', 'WARP_FOLD_APPEND_BAND_TARGET_TOKENS'))
    ?? DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS;
  const explicitTailEpochRunwayTokens = positiveInt(input.tailEpochRunwayTokens)
    ?? parsePositiveInt(envAlias(env, 'VOXXO_FOLD_TAIL_EPOCH_RUNWAY_TOKENS', 'WARP_FOLD_TAIL_EPOCH_RUNWAY_TOKENS'));
  const tailEpochRunwayTokens = explicitTailEpochRunwayTokens
    ?? DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_RUNWAY_TOKENS;
  const tailEpochMinRunwayTokens = positiveInt(input.tailEpochMinRunwayTokens)
    ?? parsePositiveInt(envAlias(env, 'VOXXO_FOLD_TAIL_EPOCH_MIN_RUNWAY_TOKENS', 'WARP_FOLD_TAIL_EPOCH_MIN_RUNWAY_TOKENS'))
    ?? (explicitTailEpochRunwayTokens === undefined
      ? Math.min(tailEpochRunwayTokens, DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_MIN_RUNWAY_TOKENS)
      : tailEpochRunwayTokens);
  const defaultPressureMarginTokens = pressureCeilingTokens === null
    ? defaultTailEpochPressureMarginTokens(hardWindowTokens)
    : Math.max(0, pressureCeilingTokens - systemToolsReserveTokens - bandTokens - tailEpochRunwayTokens);
  const tailEpochPressureMarginTokens = positiveInt(input.tailEpochPressureMarginTokens)
    ?? parsePositiveInt(envAlias(env, 'VOXXO_FOLD_TAIL_EPOCH_PRESSURE_MARGIN_TOKENS', 'WARP_FOLD_TAIL_EPOCH_PRESSURE_MARGIN_TOKENS'))
    ?? defaultPressureMarginTokens;
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
    envAlias(env, 'VOXXO_FOLD_TOOLRESULT_HEADROOM_SAFETY', 'WARP_FOLD_TOOLRESULT_HEADROOM_SAFETY'),
    DEFAULT_CONTEXT_BUDGET_TOOLRESULT_HEADROOM_SAFETY,
  );
  const toolResultMinWindowFraction = resolveFraction(
    input.toolResultMinWindowFraction,
    envAlias(env, 'VOXXO_FOLD_TOOLRESULT_MIN_WINDOW_FRACTION', 'WARP_FOLD_TOOLRESULT_MIN_WINDOW_FRACTION'),
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
    appendBandTargetTokens,
    tailEpochCapTokens,
    tailEpochCapChars,
    tailEpochBandFraction,
    tailEpochRunwayTokens,
    tailEpochMinRunwayTokens,
    tailEpochPressureMarginTokens,
    toolResultHeadroomSafety,
    toolResultMinWindowFraction,
    toolResultWindowCapChars,
    evictionPolicy,
    compressionProfile,
    unsafeDevOverrides,
  };
}
