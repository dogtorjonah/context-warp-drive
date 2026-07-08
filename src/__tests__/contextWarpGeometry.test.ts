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
} from '../contextBudget.ts';
import { shouldEscalateTailEpochForLowYield, TAIL_EPOCH_YIELD_ESCALATE_SHRINK_RATIO } from '../foldFreeze.ts';
import { resolveFoldConfigForBand, ALWAYS_ON_FOLD_CONFIG } from '../rollingFold.ts';

/**
 * Geometry god-file parity test.
 *
 * Asserts that the resolved default geometry matches the numbers documented in
 * docs/context-warp-geometry.md. If any constant drifts from the documented
 * values, this test fails — making it a structural guard against accidental
 * regression of the P180/TRIG150 geometry.
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

    it('TRIG (fold trigger) = 150K', () => {
      expect(DEFAULT_CONTEXT_BUDGET_FOLD_TRIGGER_TOKENS).toBe(150_000);
    });

    it('TRIG < P (trigger strictly below ceiling)', () => {
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

    it('trigger = 150K (clamp(150K, band=40K, min(P,msgCeil)−F=150K))', () => {
      expect(r.foldTriggerTokens).toBe(150_000);
    });

    it('trigger upper bound = min(P, msgCeil) − minRunway, and trigger ≤ upper bound', () => {
      // minRunway resolves to min(T=10K, F_const=30K) = 10K when no explicit
      // tailEpochRunwayTokens is provided. So upperBound = 180K − 10K = 170K.
      // The invariant is trigger ≤ upper bound (150K ≤ 170K), not equality.
      const upperBound = Math.min(
        r.pressureCeilingTokens ?? r.messageCeilingTokens,
        r.messageCeilingTokens,
      ) - r.tailEpochMinRunwayTokens;
      expect(r.foldTriggerTokens).toBeLessThanOrEqual(upperBound);
      // Document the actual resolved values
      expect(r.tailEpochMinRunwayTokens).toBe(10_000);
      expect(upperBound).toBe(170_000);
    });

    it('tailCap = T = 10K (margin-cancellation tautology)', () => {
      // margin = P − S − band − T
      const expectedMargin = r.pressureCeilingTokens! - r.systemToolsReserveTokens - r.bandTokens - DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_RUNWAY_TOKENS;
      // tailCap = P − S − band − margin = P − S − band − (P − S − band − T) = T
      const expectedTailCap = Math.max(
        MIN_CONTEXT_BUDGET_TAIL_EPOCH_TOKENS,
        r.pressureCeilingTokens! - r.systemToolsReserveTokens - r.bandTokens - expectedMargin,
      );
      expect(r.tailEpochCapTokens).toBe(expectedTailCap);
      // The tautology: tailCap should equal T
      expect(expectedTailCap).toBe(DEFAULT_CONTEXT_BUDGET_TAIL_EPOCH_RUNWAY_TOKENS);
    });

    it('trigger < ceiling (INV-1: never collide)', () => {
      expect(r.foldTriggerTokens).toBeLessThan(r.pressureCeilingTokens!);
    });

    it('band ≤ trigger ≤ ceiling − F', () => {
      expect(r.bandTokens).toBeLessThanOrEqual(r.foldTriggerTokens);
      expect(r.foldTriggerTokens).toBeLessThanOrEqual(
        (r.pressureCeilingTokens ?? r.messageCeilingTokens) - r.tailEpochMinRunwayTokens,
      );
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

    it('trigger degrades below P with F runway', () => {
      expect(r.foldTriggerTokens).toBeLessThan(r.pressureCeilingTokens!);
      expect(r.foldTriggerTokens).toBeLessThanOrEqual(
        r.pressureCeilingTokens! - r.tailEpochMinRunwayTokens,
      );
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
