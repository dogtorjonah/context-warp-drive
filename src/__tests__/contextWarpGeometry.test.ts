import { describe, it, expect } from 'vitest';
import { resolveContextBudget } from '../contextBudget.ts';
import {
  DEFAULT_CONTEXT_BUDGET_SYSTEM_TOOLS_RESERVE_TOKENS,
  DEFAULT_CONTEXT_BUDGET_TARGET_BAND_TOKENS,
  DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS,
  DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_RUNWAY_TOKENS,
  DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_MIN_RUNWAY_TOKENS,
  DEFAULT_CONTEXT_BUDGET_FOLD_TRIGGER_TOKENS,
  DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS,
  DEFAULT_CONTEXT_BUDGET_PRESSURE_MAX_WINDOW_FRACTION,
  DEFAULT_CONTEXT_BUDGET_BAND_MAX_WINDOW_FRACTION,
  DEFAULT_CONTEXT_BUDGET_CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_BUDGET_TOOLRESULT_HEADROOM_SAFETY,
  DEFAULT_CONTEXT_BUDGET_TOOLRESULT_MIN_WINDOW_FRACTION,
  DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_BAND_FRACTION,
  MIN_CONTEXT_BUDGET_TAIL_EPOCH_TOKENS,
  ENGINE_PRESSURE_CEILING_DEFAULTS,
  MODEL_PRESSURE_CEILING_DEFAULTS,
} from '../contextBudget.ts';
import { shouldEscalateTailEpochForLowYield, TAIL_EPOCH_YIELD_ESCALATE_SHRINK_RATIO } from '../foldFreeze.ts';
import { resolveFoldConfigForBand, ALWAYS_ON_FOLD_CONFIG } from '../rollingFold.ts';

/**
 * Geometry god-file parity test.
 *
 * Asserts that the resolved default geometry matches the numbers documented in
 * docs/context-warp-geometry.md. If any constant drifts from the documented
 * values, this test fails — making it a structural guard against accidental
 * regression of the P180 single-ceiling geometry.
 */
describe('context-warp-geometry god-file parity', () => {
  describe('constant defaults match the god file', () => {
    it('S (system+tools reserve) = 37K', () => {
      expect(DEFAULT_CONTEXT_BUDGET_SYSTEM_TOOLS_RESERVE_TOKENS).toBe(37_000);
    });

    it('M (steady-state band target) = 40K', () => {
      expect(DEFAULT_CONTEXT_BUDGET_TARGET_BAND_TOKENS).toBe(40_000);
    });

    it('A (append band target) = 5K', () => {
      expect(DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS).toBe(5_000);
    });

    it('T (preferred tail runway) = 10K', () => {
      expect(DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_RUNWAY_TOKENS).toBe(10_000);
    });

    it('F (minimum tail runway) = 30K', () => {
      expect(DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_MIN_RUNWAY_TOKENS).toBe(30_000);
    });

    it('P (pressure ceiling) = 180K', () => {
      expect(DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS).toBe(180_000);
    });

    it('legacy TRIG constant = 150K', () => {
      expect(DEFAULT_CONTEXT_BUDGET_FOLD_TRIGGER_TOKENS).toBe(150_000);
    });

    it('legacy TRIG constant < P', () => {
      expect(DEFAULT_CONTEXT_BUDGET_FOLD_TRIGGER_TOKENS).toBeLessThan(
        DEFAULT_CONTEXT_BUDGET_PRESSURE_CEILING_TOKENS,
      );
    });

    it('pressureMaxWindowFraction = 0.9', () => {
      expect(DEFAULT_CONTEXT_BUDGET_PRESSURE_MAX_WINDOW_FRACTION).toBe(0.9);
    });

    it('bandMaxWindowFraction = 0.6', () => {
      expect(DEFAULT_CONTEXT_BUDGET_BAND_MAX_WINDOW_FRACTION).toBe(0.6);
    });

    it('charsPerToken = 4', () => {
      expect(DEFAULT_CONTEXT_BUDGET_CHARS_PER_TOKEN).toBe(4);
    });

    it('MIN tail-epoch floor = 4K', () => {
      expect(MIN_CONTEXT_BUDGET_TAIL_EPOCH_TOKENS).toBe(4_000);
    });
  });

  describe('resolved geometry for standard 200K window', () => {
    const r = resolveContextBudget({
      model: 'claude-sonnet-4-20250514',
      engine: 'claude',
    });

    it('msgCeil = 180K (200K − 16K output − 4K emergency)', () => {
      expect(r.messageCeilingTokens).toBe(180_000);
    });

    it('band = 40K (clamp(40K, 0.6×200K=120K, 180K) = 40K)', () => {
      expect(r.bandTokens).toBe(40_000);
    });

    it('pressure ceiling P = 180K (clamp(180K, 0.9×200K=180K, msgCeil=180K))', () => {
      expect(r.pressureCeilingTokens).toBe(180_000);
    });

    it('trigger = P under default single-ceiling mode', () => {
      expect(r.foldTriggerTokens).toBe(180_000);
      expect(r.foldTriggerTokens).toBe(r.pressureCeilingTokens);
    });

    it('single-ceiling bypasses the legacy trigger runway clamp', () => {
      const legacyUpperBound = Math.min(
        r.pressureCeilingTokens ?? r.messageCeilingTokens,
        r.messageCeilingTokens,
      ) - r.tailEpochMinRunwayTokens;
      expect(r.tailEpochMinRunwayTokens).toBe(30_000);
      expect(legacyUpperBound).toBe(150_000);
      expect(r.foldTriggerTokens).toBeGreaterThan(legacyUpperBound);
    });

    it('tailCap is ceiling-sized, clamped below the message ceiling by the band', () => {
      const expectedTailCap = r.messageCeilingTokens - r.bandTokens;
      expect(r.tailEpochCapTokens).toBe(expectedTailCap);
      expect(expectedTailCap).toBe(140_000);
      expect(expectedTailCap).toBeGreaterThan(DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_RUNWAY_TOKENS);
    });

    it('trigger equals the pressure ceiling', () => {
      expect(r.foldTriggerTokens).toBe(r.pressureCeilingTokens);
    });

    it('band ≤ trigger and F is reserved by the floor rule, not a trigger clamp', () => {
      expect(r.bandTokens).toBeLessThanOrEqual(r.foldTriggerTokens);
      expect(r.pressureCeilingTokens! - r.tailEpochMinRunwayTokens).toBe(150_000);
      expect(r.foldTriggerTokens).toBe(180_000);
    });
  });

  describe('Codex/Gemini CLI single-ceiling trigger regression', () => {
    it('resolves Codex CLI trigger to P, not P-30K', () => {
      const r = resolveContextBudget({ model: 'gpt-5.5', engine: 'codex', env: {} });
      // Codex CLI's P is 220K via ENGINE_PRESSURE_CEILING_DEFAULTS; the invariant
      // under test is trigger === P (no P-30K runway clamp), not the base 180K.
      expect(r.pressureCeilingTokens).toBe(220_000);
      expect(r.foldTriggerTokens).toBe(220_000);
    });

    it('resolves Gemini CLI trigger to P, not P-30K', () => {
      const r = resolveContextBudget({ model: 'gemini-2.5-pro', engine: 'gemini', env: {} });
      expect(r.pressureCeilingTokens).toBe(180_000);
      expect(r.foldTriggerTokens).toBe(180_000);
    });
  });

  describe('per-model/engine pressure-ceiling tuning tables', () => {
    it('table constants: CLI surfaces 220K; bare FC engine keys deliberately absent', () => {
      expect(ENGINE_PRESSURE_CEILING_DEFAULTS['codex']).toBe(220_000);
      expect(ENGINE_PRESSURE_CEILING_DEFAULTS['claude-cli']).toBe(220_000);
      expect(ENGINE_PRESSURE_CEILING_DEFAULTS['claude-interactive']).toBe(220_000);
      // Bare 'claude' is shared with the FC API path, which stays on the 180K base.
      expect(ENGINE_PRESSURE_CEILING_DEFAULTS['claude']).toBeUndefined();
    });

    it('Codex CLI resolves the 220K engine default (258K window keeps both clamps above it)', () => {
      const r = resolveContextBudget({ model: 'codex-5.5', engine: 'codex', env: {} });
      expect(r.pressureCeilingTokens).toBe(220_000);
      expect(r.foldTriggerTokens).toBe(220_000);
    });

    it('Claude Code CLI resolves 220K on modern 1M-window models', () => {
      const r = resolveContextBudget({ model: 'claude-sonnet-5', engine: 'claude-cli', env: {} });
      expect(r.pressureCeilingTokens).toBe(220_000);
      expect(r.foldTriggerTokens).toBe(220_000);
    });

    it('interactive tmux surface resolves 220K on modern 1M-window models', () => {
      const r = resolveContextBudget({ model: 'claude-sonnet-5', engine: 'claude-interactive', env: {} });
      expect(r.pressureCeilingTokens).toBe(220_000);
    });

    it('engine-only CLI surfaces resolve 220K when no model is supplied', () => {
      for (const engine of ['codex', 'claude-cli', 'claude-interactive'] as const) {
        const r = resolveContextBudget({ engine, env: {} });
        expect(r.pressureCeilingTokens).toBe(220_000);
        expect(r.foldTriggerTokens).toBe(220_000);
      }
    });

    it('FC claude engine stays on the uniform 180K base even on 1M windows', () => {
      const r = resolveContextBudget({ model: 'claude-sonnet-5', engine: 'claude', env: {} });
      expect(r.pressureCeilingTokens).toBe(180_000);
      expect(resolveContextBudget({ engine: 'claude', env: {} }).pressureCeilingTokens).toBe(180_000);
    });

    it('legacy 200K-window Claude CLI self-clamps the 220K default to its 180K messageCeiling', () => {
      const r = resolveContextBudget({ model: 'claude-sonnet-4', engine: 'claude-cli', env: {} });
      expect(r.messageCeilingTokens).toBe(180_000);
      expect(r.pressureCeilingTokens).toBe(180_000);
      expect(r.foldTriggerTokens).toBe(180_000);
    });

    it('env VOXXO_FOLD_PRESSURE_CEILING_TOKENS still beats the table', () => {
      const r = resolveContextBudget({
        model: 'codex-5.5',
        engine: 'codex',
        env: { VOXXO_FOLD_PRESSURE_CEILING_TOKENS: '190000' },
      });
      expect(r.pressureCeilingTokens).toBe(190_000);
    });

    it('explicit input override beats both env and table', () => {
      const r = resolveContextBudget({
        model: 'codex-5.5',
        engine: 'codex',
        env: { VOXXO_FOLD_PRESSURE_CEILING_TOKENS: '190000' },
        pressureCeilingTokens: 205_000,
      });
      expect(r.pressureCeilingTokens).toBe(205_000);
    });

    it('MODEL_PRESSURE_CEILING_DEFAULTS exact and longest-prefix entries beat the engine table', () => {
      MODEL_PRESSURE_CEILING_DEFAULTS['codex-5.5-instant'] = 200_000;
      try {
        const exact = resolveContextBudget({
          model: 'codex-5.5-instant',
          engine: 'codex',
          env: {},
          contextWindowTokens: 258_000,
        });
        expect(exact.pressureCeilingTokens).toBe(200_000);
        const prefixed = resolveContextBudget({
          model: 'codex-5.5-instant-2099-01',
          engine: 'codex',
          env: {},
          contextWindowTokens: 258_000,
        });
        expect(prefixed.pressureCeilingTokens).toBe(200_000);
      } finally {
        delete MODEL_PRESSURE_CEILING_DEFAULTS['codex-5.5-instant'];
      }
    });
  });

  describe('resolved geometry for small 128K window', () => {
    const r = resolveContextBudget({
      model: 'claude-3-haiku',
      engine: 'claude',
      contextWindowTokens: 128_000,
    });

    it('P degrades proportionally (0.9 × 128K = 115.2K)', () => {
      expect(r.pressureCeilingTokens).toBe(115_200);
    });

    it('trigger degrades to P with no sub-ceiling runway clamp', () => {
      expect(r.foldTriggerTokens).toBe(r.pressureCeilingTokens);
      expect(r.tailEpochMinRunwayTokens).toBe(30_000);
    });

    it('trigger ≥ band (never fold before band is full)', () => {
      expect(r.foldTriggerTokens).toBeGreaterThanOrEqual(r.bandTokens);
    });
  });

  describe('yield gate (shouldEscalateTailEpochForLowYield)', () => {
    it('escalate threshold = 0.7', () => {
      expect(TAIL_EPOCH_YIELD_ESCALATE_SHRINK_RATIO).toBe(0.7);
    });

    it('does NOT escalate below trigger when no minimum runway is supplied', () => {
      // shrinkRatio > 0.7 (low yield) but measured 100K < 150K trigger
      // and callers that omit minRunwayTokens preserve the legacy trigger-only gate.
      expect(shouldEscalateTailEpochForLowYield(0.9, 100_000, 150_000)).toBe(false);
    });

    it('escalates below trigger when trigger-runway is thinner than the minimum', () => {
      // trigger − measured = 20K < 30K min runway, so a zero-yield fold would churn.
      expect(shouldEscalateTailEpochForLowYield(0.9, 130_000, 150_000, 30_000)).toBe(true);
      expect(shouldEscalateTailEpochForLowYield(0.9, 100_000, 150_000, 30_000)).toBe(false);
    });

    it('escalates when at pressure AND low yield', () => {
      // shrinkRatio > 0.7 AND measured 160K ≥ 150K trigger
      expect(shouldEscalateTailEpochForLowYield(0.9, 160_000, 150_000)).toBe(true);
    });

    it('does NOT escalate at boundary (shrinkRatio exactly 0.7)', () => {
      // > is strict: 0.7 does not escalate
      expect(shouldEscalateTailEpochForLowYield(0.7, 160_000, 150_000)).toBe(false);
    });

    it('does NOT escalate with null shrinkRatio', () => {
      expect(shouldEscalateTailEpochForLowYield(null, 160_000, 150_000)).toBe(false);
    });

    it('does NOT escalate when measured/trigger unavailable', () => {
      expect(shouldEscalateTailEpochForLowYield(0.9, null, null)).toBe(false);
      expect(shouldEscalateTailEpochForLowYield(0.9, undefined, undefined)).toBe(false);
    });
  });

  describe('band leanness (resolveFoldConfigForBand)', () => {
    it('default 100K band deep-equals ALWAYS_ON base config', () => {
      const resolved = resolveFoldConfigForBand(100_000);
      expect(resolved.assistantTextBudget!.fullRetentionChars)
        .toBe(ALWAYS_ON_FOLD_CONFIG.assistantTextBudget!.fullRetentionChars);
      expect(resolved.assistantTextBudget!.essenceRetentionChars)
        .toBe(ALWAYS_ON_FOLD_CONFIG.assistantTextBudget!.essenceRetentionChars);
    });

    it('scales retention proportionally for smaller bands', () => {
      // 50K band → half the retention of 100K
      const resolved50 = resolveFoldConfigForBand(50_000);
      const resolved100 = resolveFoldConfigForBand(100_000);
      expect(resolved50.assistantTextBudget!.fullRetentionChars)
        .toBe(Math.round(resolved100.assistantTextBudget!.fullRetentionChars / 2));
    });

    it('40K band (FC steady-state) produces lean retention', () => {
      const resolved = resolveFoldConfigForBand(40_000);
      // 40K tokens × 4 chars/token = 160K chars
      // fullRetention = 12.5% of 160K = 20K chars
      // essenceRetention = 25% of 160K = 40K chars
      expect(resolved.assistantTextBudget!.fullRetentionChars).toBe(20_000);
      expect(resolved.assistantTextBudget!.essenceRetentionChars).toBe(40_000);
    });
  });
});
