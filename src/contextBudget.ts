/**
 * Model-aware Context Warp budget resolver.
 *
 * Pure arithmetic over documented model windows plus explicit options/env
 * values. It never estimates live prompt tokens from text; callers feed provider
 * telemetry into pressure decisions separately.
 */

import { contextWindowForModel } from './contextWindow.ts';

// Context Warp geometry signposts — SINGLE-CEILING GEOMETRY (Jonah 2026-07-08:
// "one ceiling, more simple" — supersedes the two-trigger P180/TRIG150 layout):
//   S = 37K static system/tools prefix reserve (provider-measured floor model)
//   M = 40K folded memory after a hard epoch
//   P = THE ceiling — the only fold trigger. Uniform 180K base default; the
//       per-engine/model tuning tables below (ENGINE/MODEL_PRESSURE_CEILING_
//       DEFAULTS, Jonah 2026-07-10) raise the CLI surfaces: Codex CLI and the
//       Claude Code CLI/tmux surfaces run P=220K. Below P nothing folds: no
//       tail-size char gate, no calm-seal/warning override, no sub-ceiling
//       deterministic trigger. Sessions hot-reuse the frozen prefix and ride a
//       raw, full-fidelity live tail all the way up to P.
//   At P: fold the ENTIRE accumulated live tail into ONE append band (frozen
//       prefix stays byte-identical/cache-safe; measured occupancy saws back
//       down to the floor). Real batches by design — never char-cap slices.
//   FLOOR RULE (the only escalation): each append raises the post-fold floor
//       (S + frozen prefix + sealed bands). A ceiling hit escalates to a HARD
//       epoch (seeded whole-view rebuild back to ~S+M) instead of appending when the
//       PROJECTED post-append floor would exceed P − F, i.e. when
//       (measured floor + projected band) > P − F. The projection uses
//       measured tokens only: projected band ≈ clamp(~18% of (measured −
//       floor), A_min 5K, A_cap 25K) — no char/byte estimation. Stateless per
//       ceiling hit; may only escalate once ≥1 append has committed since the
//       last hard epoch (instant-loop guard for degenerate giant-S sessions).
//   F = 30K minimum runway that must remain under P after an append for the
//       append to be worth taking. Under single-ceiling mode F resolves to the
//       full 30K constant (no min(T, F) collapse — T is inert here).
//   A = append band target: scales proportionally with the folded tail under
//       single-ceiling mode (~15-20% of tail tokens, min 5K, cap ~25K); the
//       fixed 5K default survives as the lower bound and legacy value.
//   T = 10K legacy live-tail runway — INERT under single-ceiling mode (no
//       sub-ceiling tail cap derives from it). Meaningful only under the kill
//       switch (VOXXO_FOLD_SINGLE_CEILING=0 → legacy hybrid geometry).
//   TRIG = 150K legacy sub-ceiling trigger — likewise inert under
//       single-ceiling mode. HISTORY NOTE superseding the 2026-07-07 warning
//       "never set trigger equal to the ceiling": that warning described the
//       OLD architecture, where the ceiling path was hard-epoch-only, so
//       trigger==ceiling starved the append path entirely (measured: Claude
//       CLI got 0 tail epochs). Under single-ceiling mode the ceiling ITSELF
//       takes the append path (floor rule permitting), so tail epochs happen
//       AT P by design and no sub-ceiling staging trigger exists at all.
//   CLI reconstruction transports: Codex CLI ('codex') and Gemini CLI
//       ('gemini') use the same P trigger in single-ceiling mode. Their normal
//       fold/rewrite path gets first chance at P; portable-reset hard epochs
//       are a follow-up escalation when the append path cannot
//       relieve pressure. Legacy mode keeps the historical msgCeiling −
//       minRunway Codex clamp.
//
// Emergency margin / messageCeiling clamps are unchanged in both modes: they
// are overshoot crash protection ABOVE P (a mid-turn tool burst can pass P
// before the next boundary), not a second trigger.
//
// Runtime invariant (single-ceiling): at a boundary with measured tokens ≥ P,
// append the whole live tail as one band iff the projected post-append floor
// still leaves the minimum runway (post-append floor ≤ P − F, or no floor
// captured yet / no append since the last hard epoch); otherwise hard-epoch.
// The first fold of a fresh session is a first-call hard epoch that builds M
// (append requires an existing frozen prefix). Below P: hot-reuse, always.
// Decision precedence: reuse (< P) → append (≥ P, post-append floor rule
// holds) → hard epoch (≥ P, post-append floor rule violated).
// Legacy invariant (kill switch only): append a folded tail band only if the
// post-append prompt still guarantees F runway before P, with the T=10K tail
// cap skeletonizing the unfrozen tail; otherwise hard epoch.
export const DEFAULT_CONTEXT_BUDGET_SYSTEM_TOOLS_RESERVE_TOKENS = 37_000;
export const DEFAULT_CONTEXT_BUDGET_TARGET_BAND_TOKENS = 40_000;
export const DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS = 5_000;
export const DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_RUNWAY_TOKENS = 10_000;
export const DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_MIN_RUNWAY_TOKENS = 30_000;
export const DEFAULT_CONTEXT_BUDGET_CODEX_CLI_RECONSTRUCT_RUNWAY_TOKENS =
  DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_MIN_RUNWAY_TOKENS;
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
export const DEFAULT_CONTEXT_BUDGET_FOLD_TRIGGER_TOKENS = 150_000;
export const DEFAULT_CONTEXT_BUDGET_CHARS_PER_TOKEN = 4;
export const DEFAULT_CONTEXT_BUDGET_BAND_MAX_WINDOW_FRACTION = 0.6;
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
export const DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS = 180_000;
/**
 * Back-compat alias for callers that used the old Opus max-context name.
 * It intentionally equals the universal default: no hidden model-specific carve-out.
 */
export const DEFAULT_CONTEXT_BUDGET_OPUS_MAX_PRESSURE_CEILING_TOKENS =
  DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS;
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
export const ENGINE_PRESSURE_CEILING_DEFAULTS: Record<string, number> = {
  // Codex CLI: 258K effective window → messageCeiling ≈236.8K keeps ~17K of
  // overshoot margin above the 220K ceiling.
  codex: 220_000,
  // Claude Code CLI + interactive tmux surfaces. Modern Claude models carry
  // 1M windows so 220K resolves as-is; legacy 200K-window models self-clamp
  // to their 180K messageCeiling. NOTE: bare engine 'claude' is deliberately
  // ABSENT from this table — that string is shared with the FC API path,
  // which stays on the uniform 180K base; ceiling-relevant CLI call sites
  // pass the surface-specific 'claude-cli' / 'claude-interactive' strings.
  'claude-cli': 220_000,
  'claude-interactive': 220_000,
};
/**
 * Exact/prefix model-level ceiling overrides, consulted BEFORE the engine
 * table. Keys must be lowercase. Add an entry here when a single model needs
 * a different ceiling than its engine default, e.g.
 * 'codex-5.5-instant': 200_000.
 */
export const MODEL_PRESSURE_CEILING_DEFAULTS: Record<string, number> = {};
// Claude Code CLI hard-epoch fallback ceiling. The Claude CLI surfaces
// (claude / claude-cli / claude-interactive) own their own transcript file and
// fold via out-of-process band-append tail epochs (FC/Codex parity), NOT inline.
// When a tail epoch declines (ledger drift, or nothing safely foldable within
// the tail char budget), the relay falls back to an in-place session-swap
// rebirth ("hard epoch") once provider-MEASURED context tokens cross this
// ceiling. Kept distinct from the standard pressure ceiling — since 2026-07-10
// the resolved Claude CLI ceiling (220K via ENGINE_PRESSURE_CEILING_DEFAULTS)
// normally sits ABOVE this constant, which survives strictly as the final
// fallback when budget resolution cannot produce a ceiling — because fold
// pressure and out-of-process session-swap saturation can diverge independently.
// Consumed by relay handleResultEvent (instanceManager/eventHandlers.ts).
export const DEFAULT_CONTEXT_BUDGET_CLAUDE_CLI_HARD_EPOCH_TOKENS = 180_000;
// 0.9 (not 0.8) so a 200K window admits the uniform P=180K default via the
// default-resolution path (0.8 would silently clamp it to 160K); smaller
// windows still degrade proportionally (128K → 115.2K).
export const DEFAULT_CONTEXT_BUDGET_PRESSURE_MAX_WINDOW_FRACTION = 0.9;
export const DEFAULT_CONTEXT_BUDGET_APPEND_ONLY_MAX_WINDOW_FRACTION = 0.9;
export const DEFAULT_CONTEXT_BUDGET_TOOLRESULT_HEADROOM_SAFETY = 0.8;
export const DEFAULT_CONTEXT_BUDGET_TOOLRESULT_MIN_WINDOW_FRACTION = 0.15;
export const DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_BAND_FRACTION = 0.25;
/**
 * Fallback headroom (tokens) kept between S + M + T and the pressure ceiling
 * when no pressure ceiling is configured. For the standard P180 geometry this
 * is P180 − S37 − M40 − T10 = 93K. (Only consumed when the pressure ceiling is
 * explicitly disabled; with a ceiling present the margin re-derives live as
 * P − S − M − T, which algebraically pins the default tail-epoch cap to T.)
 */
export const DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_PRESSURE_MARGIN_TOKENS = 93_000;
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

/**
 * When the whole frozen view is rebuilt (evicted). Two-epoch law: every
 * whole-view rebuild is a seeded HARD epoch — these values say WHEN the hard
 * epoch fires; none of them is a bandless middle tier.
 */
export type ContextBudgetEvictionPolicy =
  | 'hard-epoch-only'
  | 'hard-epoch-on-prefix-saturation'
  | 'hard-epoch-on-cold-or-self-heal';

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
  // The ≤258K tier uses 0.02 (200K window → 4K) so messageCeiling =
  // window − output(16K) − emergency reaches the uniform P=180K ceiling; the
  // old 0.04 left msgCeil at 176K and silently clamped P180 to 176K even under
  // an explicit env pin. Wider windows keep the roomier 0.03 margin.
  // Runtime consumers: messageCeiling here + status display only (verified).
  return reserveFloor(windowTokens, windowTokens <= 258_000 ? 0.02 : 0.03, 4_000, 48_000);
}

function defaultTailEpochPressureMarginTokens(windowTokens: number): number {
  return reserveFloor(windowTokens, 0.027, 4_000, DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_PRESSURE_MARGIN_TOKENS);
}

function isCodexCliEngine(engine: string): boolean {
  return engine.trim().toLowerCase() === 'codex';
}

// Gemini CLI transport only ('gemini'), never the FC API path ('gemini-api').
function isGeminiCliEngine(engine: string): boolean {
  return engine.trim().toLowerCase() === 'gemini';
}

/**
 * Default pressure ceiling for a given model/engine pair. Resolution order:
 * model exact match → longest model-prefix match → engine match → uniform
 * base (see the tuning-table doc above ENGINE_PRESSURE_CEILING_DEFAULTS).
 * Explicit input.pressureCeilingTokens and the
 * VOXXO_/WARP_FOLD_PRESSURE_CEILING_TOKENS env override this default, and the
 * caller window-clamps then messageCeiling-clamps whatever this returns.
 */
function defaultPressureCeilingTokensForModelEngine(model: string, engine: string): number {
  const modelLower = model.trim().toLowerCase();
  if (modelLower) {
    const exact = MODEL_PRESSURE_CEILING_DEFAULTS[modelLower];
    if (exact !== undefined) return exact;
    let bestKeyLength = 0;
    let bestValue: number | undefined;
    for (const [key, value] of Object.entries(MODEL_PRESSURE_CEILING_DEFAULTS)) {
      if (key.length > bestKeyLength && modelLower.startsWith(key)) {
        bestKeyLength = key.length;
        bestValue = value;
      }
    }
    if (bestValue !== undefined) return bestValue;
  }
  const engineDefault = ENGINE_PRESSURE_CEILING_DEFAULTS[engine.trim().toLowerCase()];
  if (engineDefault !== undefined) return engineDefault;
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
  const codexCliHardEpochOnly = isCodexCliEngine(engine);
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
  const codexCliDefaultReconstructTriggerTokens = codexCliHardEpochOnly
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

  // Single-ceiling mode (default ON): P is the only fold trigger — the
  // sub-ceiling tail-size gate and warning trigger are inert, tail epochs fire
  // AT the ceiling as one whole-tail append, and the projected-floor rule is
  // the only hard-epoch escalation (see geometry signposts at the top of this
  // file). VOXXO_FOLD_SINGLE_CEILING=0 is the kill switch restoring the legacy
  // hybrid two-trigger geometry.
  const singleCeilingMode = input.singleCeilingMode
    ?? (envAlias(env, 'VOXXO_FOLD_SINGLE_CEILING', 'WARP_FOLD_SINGLE_CEILING') !== '0');

  // Tail-epoch runway floor, hoisted above the fold trigger because the trigger
  // clamp reserves this much room below the ceiling (see foldTriggerUpperBound).
  const explicitTailEpochRunwayTokens = positiveInt(input.tailEpochRunwayTokens)
    ?? parsePositiveInt(envAlias(env, 'VOXXO_FOLD_TAIL_EPOCH_RUNWAY_TOKENS', 'WARP_FOLD_TAIL_EPOCH_RUNWAY_TOKENS'));
  const tailEpochRunwayTokens = explicitTailEpochRunwayTokens
    ?? DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_RUNWAY_TOKENS;
  const tailEpochMinRunwayTokens = positiveInt(input.tailEpochMinRunwayTokens)
    ?? parsePositiveInt(envAlias(env, 'VOXXO_FOLD_TAIL_EPOCH_MIN_RUNWAY_TOKENS', 'WARP_FOLD_TAIL_EPOCH_MIN_RUNWAY_TOKENS'))
    // Single-ceiling: F resolves to the full 30K constant — the floor rule's
    // one knob — with no min(T, F) collapse, because T (the legacy sub-ceiling
    // tail runway) is inert in this geometry.
    ?? (singleCeilingMode
      ? DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_MIN_RUNWAY_TOKENS
      : explicitTailEpochRunwayTokens === undefined
        ? Math.min(tailEpochRunwayTokens, DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_MIN_RUNWAY_TOKENS)
        : tailEpochRunwayTokens);

  // Legacy hybrid fold trigger sits between the steady-state band and the
  // pressure ceiling: band ≤ trigger ≤ min(pressureCeiling, messageCeiling) −
  // minRunway. Single-ceiling mode bypasses this legacy clamp below and returns
  // P itself as the only active fold boundary.
  const requestedFoldTriggerTokens = positiveInt(input.foldTriggerTokens)
    ?? parsePositiveInt(envAlias(env, 'VOXXO_FOLD_TRIGGER_TOKENS', 'WARP_FOLD_TRIGGER_TOKENS'))
    ?? codexCliDefaultReconstructTriggerTokens
    ?? DEFAULT_CONTEXT_BUDGET_FOLD_TRIGGER_TOKENS;
  // Single-ceiling means exactly one trigger: P. Engine-specific runway clamps
  // are legacy-mode safety rails only; in single-ceiling mode Codex/Gemini CLI
  // must not grow a hidden P-30K trigger.
  const singleCeilingFoldTriggerTokens = Math.max(
    1,
    pressureCeilingTokens ?? messageCeilingTokens,
  );
  const foldTriggerUpperBound = Math.max(
    1,
    Math.min(
      pressureCeilingTokens ?? messageCeilingTokens,
      messageCeilingTokens,
    ) - tailEpochMinRunwayTokens,
  );
  const legacyFoldTriggerTokens = unsafeDevOverrides
    ? requestedFoldTriggerTokens
    : Math.min(Math.max(requestedFoldTriggerTokens, bandTokens), foldTriggerUpperBound);
  const foldTriggerTokens = singleCeilingMode
    ? singleCeilingFoldTriggerTokens
    : legacyFoldTriggerTokens;

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

  // Legacy hybrid S-aware, pressure-geometry tail-epoch cap.
  // The append-only hot tail rides ON TOP of the system+tools prefix (S, modeled
  // as systemToolsReserveTokens) and the frozen band (B). The expensive event the
  // tail-epoch exists to avoid is tripping the pressure ceiling, which forces a
  // HARD epoch — so the tail should be as large as fits UNDER that ceiling:
  //   tail = pressureCeiling − S − band − margin
  // By default, margin is derived from the preferred next-runway target:
  //   margin = pressureCeiling − S − band − T
  // so the raw tail crosses the char cap at T=10K. At the fold boundary, live
  // runtimes still gate ordinary tail epochs on measured provider tokens when
  // available, suppressing cap-only folds until the measured floor is reached.
  // Append eligibility also checks the stacked append bands: if appending the next
  // A=5K band would leave less than F runway before P, runtimes hard-epoch
  // instead of extending the staircase.
  // This shrinks automatically under heavy tool load (large S) and grows when there
  // is headroom, unlike the old pressure-blind band×fraction default that ignored S
  // and let S+band+tail breach the ceiling at high tool counts. The band fraction
  // survives only as the fallback when no pressure ceiling is configured; explicit
  // legacy overrides and the messageCeiling−band clamp still bound the result.
  // Single-ceiling mode bypasses this pressure-geometry cap below and uses a
  // ceiling-sized cap so no tail-size gate can fire before P.
  const tailEpochBandFraction = resolveFraction(
    input.tailEpochBandFraction,
    envAlias(env, 'VOXXO_FOLD_TAIL_EPOCH_BAND_FRACTION', 'WARP_FOLD_TAIL_EPOCH_BAND_FRACTION'),
    DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_BAND_FRACTION,
  );
  const appendBandTargetTokens = positiveInt(input.appendBandTargetTokens)
    ?? parsePositiveInt(envAlias(env, 'VOXXO_FOLD_APPEND_BAND_TARGET_TOKENS', 'WARP_FOLD_APPEND_BAND_TARGET_TOKENS'))
    ?? DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS;
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
  // Single-ceiling: the whole live tail folds in one batch AT the ceiling, so
  // the default cap is ceiling-sized (still clamped to messageCeiling − band
  // just below). The sub-ceiling char-cap scheduler gate then cannot fire
  // before measured pressure reaches P — real batches by construction.
  const defaultTailEpochCapTokens = singleCeilingMode && pressureCeilingTokens !== null
    ? pressureCeilingTokens
    : pressureGeometryTailTokens === null
      ? bandFractionTailTokens
      : Math.max(MIN_CONTEXT_BUDGET_TAIL_EPOCH_TOKENS, pressureGeometryTailTokens);
  const requestedTailEpochCapTokens = singleCeilingMode
    ? defaultTailEpochCapTokens
    : positiveInt(input.tailEpochCapTokens)
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
    ? 'hard-epoch-only'
    : 'hard-epoch-on-prefix-saturation';

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
    singleCeilingMode,
  };
}
