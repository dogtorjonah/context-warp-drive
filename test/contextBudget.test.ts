import { describe, expect, it } from 'vitest';

import { resolveContextBudget } from '../src/contextBudget.ts';

describe('resolveContextBudget', () => {
  it('keeps 1M-class providers on the absolute 160k band with cache-economic headroom', () => {
    const budget = resolveContextBudget({ engine: 'claude', model: 'claude-opus-4-8' });

    expect(budget.contextWindowTokens).toBe(1_000_000);
    expect(budget.budgetTier).toBe('large-1m');
    expect(budget.compressionProfile).toBe('cache-economic');
    expect(budget.bandTokens).toBe(160_000);
    expect(budget.pressureCeilingTokens).toBe(240_000);
    expect(budget.prefixSaturationTokens).toBe(900_000);
    expect(budget.tailEpochCapTokens).toBe(40_000);
    expect(budget.evictionPolicy).toBe('recompute-on-prefix-saturation');
  });

  it('puts 200k Claude models in survival mode with a window-clamped band', () => {
    const budget = resolveContextBudget({ engine: 'claude', model: 'claude-sonnet-4' });

    expect(budget.contextWindowTokens).toBe(200_000);
    expect(budget.budgetTier).toBe('small-200k');
    expect(budget.compressionProfile).toBe('survival');
    expect(budget.bandTokens).toBe(120_000);
    expect(budget.pressureCeilingTokens).toBe(160_000);
    expect(budget.messageCeilingTokens).toBe(176_000);
    expect(budget.prefixSaturationTokens).toBe(176_000);
    expect(budget.tailEpochCapTokens).toBe(30_000);
    expect(budget.evictionPolicy).toBe('full-recompute-only');
  });

  it('classifies 400k-family OpenAI models as balanced mid-tier budgets', () => {
    const exact = resolveContextBudget({ engine: 'openai', model: 'gpt-5.4-mini' });
    const prefixed = resolveContextBudget({ engine: 'openai', model: 'gpt-5.4-mini-2026-06-17' });
    const engineDefault = resolveContextBudget({ engine: 'openai' });

    expect(exact.contextWindowTokens).toBe(400_000);
    expect(exact.limitSource).toBe('model-or-engine-table');
    expect(exact.budgetTier).toBe('mid-400k');
    expect(exact.compressionProfile).toBe('balanced');
    expect(exact.outputReserveTokens).toBe(32_000);
    expect(exact.systemToolsReserveTokens).toBe(32_000);
    expect(exact.emergencyMarginTokens).toBe(12_000);
    expect(exact.messageCeilingTokens).toBe(356_000);
    expect(exact.prefixSaturationTokens).toBe(356_000);
    expect(exact.evictionPolicy).toBe('recompute-on-prefix-saturation');

    expect(prefixed.contextWindowTokens).toBe(exact.contextWindowTokens);
    expect(prefixed.budgetTier).toBe(exact.budgetTier);
    expect(engineDefault.contextWindowTokens).toBe(400_000);
    expect(engineDefault.limitSource).toBe('engine-default');
  });

  it('labels huge-window providers separately from 1M cache-economic profiles', () => {
    const budget = resolveContextBudget({ engine: 'grok', model: 'grok-4.20-0309-reasoning' });

    expect(budget.contextWindowTokens).toBe(2_000_000);
    expect(budget.budgetTier).toBe('huge-2m');
    expect(budget.compressionProfile).toBe('wide-cache-economic');
    expect(budget.evictionPolicy).toBe('recompute-on-prefix-saturation');
  });

  it('shrinks tiny-window models aggressively enough that the band cannot exceed the wall', () => {
    const budget = resolveContextBudget({ engine: 'glm', model: 'glm-5' });

    expect(budget.contextWindowTokens).toBe(80_000);
    expect(budget.budgetTier).toBe('tiny-window');
    expect(budget.bandTokens).toBe(48_000);
    expect(budget.pressureCeilingTokens).toBe(64_000);
    expect(budget.messageCeilingTokens).toBe(68_000);
    expect(budget.prefixSaturationTokens).toBe(68_000);
    expect(budget.toolResultWindowCapChars).toBeLessThanOrEqual(budget.bandChars);
    expect(
      budget.bandTokens
        + Math.ceil(budget.toolResultWindowCapChars / budget.charsPerToken)
        + budget.systemToolsReserveTokens,
    ).toBeLessThanOrEqual(budget.messageCeilingTokens);
  });

  it('separates Codex CLI effective input windows from Codex API large windows', () => {
    const cli = resolveContextBudget({ engine: 'codex', model: 'gpt-5.5' });
    const api = resolveContextBudget({ engine: 'codex-api', model: 'gpt-5.5' });

    expect(cli.contextWindowTokens).toBe(258_000);
    expect(cli.compressionProfile).toBe('survival');
    expect(cli.bandTokens).toBe(Math.round(258_000 * 0.6));
    expect(api.contextWindowTokens).toBe(1_048_576);
    expect(api.compressionProfile).toBe('cache-economic');
    expect(api.bandTokens).toBe(160_000);
  });

  it('treats GLM 5.2 as a 1M flagship window instead of the older GLM fallback', () => {
    const budget = resolveContextBudget({ engine: 'glm', model: 'glm-5.2' });

    expect(budget.contextWindowTokens).toBe(1_000_000);
    expect(budget.budgetTier).toBe('large-1m');
    expect(budget.compressionProfile).toBe('cache-economic');
    expect(budget.bandTokens).toBe(160_000);
    expect(budget.pressureCeilingTokens).toBe(240_000);
  });

  it('supports arbitrary new models through an explicit context window override', () => {
    const budget = resolveContextBudget({
      engine: 'future-provider',
      model: 'future-million-context-model',
      contextWindowTokens: 1_000_000,
      targetBandTokens: 150_000,
      pressureMaxWindowFraction: 0.75,
    });

    expect(budget.limitSource).toBe('explicit-override');
    expect(budget.conservativeFallback).toBe(false);
    expect(budget.contextWindowTokens).toBe(1_000_000);
    expect(budget.budgetTier).toBe('large-1m');
    expect(budget.bandTokens).toBe(150_000);
    expect(budget.pressureCeilingTokens).toBe(240_000);
  });

  it('clamps unsafe oversized overrides unless the unsafe dev escape hatch is explicit', () => {
    const safe = resolveContextBudget({
      engine: 'claude',
      model: 'claude-sonnet-4',
      env: {
        VOXXO_FOLD_TARGET_BAND_TOKENS: '999999',
        VOXXO_FOLD_PRESSURE_CEILING_TOKENS: '999999',
      },
    });
    const unsafe = resolveContextBudget({
      engine: 'claude',
      model: 'claude-sonnet-4',
      env: {
        VOXXO_FOLD_TARGET_BAND_TOKENS: '999999',
        VOXXO_FOLD_PRESSURE_CEILING_TOKENS: '999999',
        VOXXO_FOLD_UNSAFE_DEV_OVERRIDES: '1',
      },
    });

    expect(safe.bandTokens).toBe(120_000);
    expect(safe.pressureCeilingTokens).toBe(safe.messageCeilingTokens);
    expect(unsafe.bandTokens).toBe(999_999);
    expect(unsafe.pressureCeilingTokens).toBe(999_999);
    expect(unsafe.unsafeDevOverrides).toBe(true);
  });

  it('ignores negative, nonfinite, and malformed overrides', () => {
    const budget = resolveContextBudget({
      engine: 'claude',
      model: 'claude-sonnet-4',
      targetBandTokens: -1,
      pressureCeilingTokens: Number.POSITIVE_INFINITY,
      outputReserveTokens: Number.NaN,
      systemToolsReserveTokens: -5,
      emergencyMarginTokens: 0,
      charsPerToken: Number.NaN,
      env: {
        VOXXO_FOLD_TARGET_BAND_TOKENS: '-999',
        VOXXO_FOLD_PRESSURE_CEILING_TOKENS: 'not-a-number',
        VOXXO_FOLD_OUTPUT_RESERVE_TOKENS: 'Infinity',
        VOXXO_FOLD_SYSTEM_TOOLS_RESERVE_TOKENS: '0',
        VOXXO_FOLD_EMERGENCY_MARGIN_TOKENS: '-20',
      },
    });

    expect(budget.requestedBandTokens).toBe(160_000);
    expect(budget.bandTokens).toBe(120_000);
    expect(budget.pressureCeilingTokens).toBe(160_000);
    expect(budget.outputReserveTokens).toBe(16_000);
    expect(budget.systemToolsReserveTokens).toBe(16_000);
    expect(budget.emergencyMarginTokens).toBe(8_000);
    expect(budget.charsPerToken).toBe(4);
  });

  it('lets output reserve dominance clamp token ceilings without negative budgets', () => {
    const budget = resolveContextBudget({
      contextWindowTokens: 50_000,
      outputReserveTokens: 49_999,
      emergencyMarginTokens: 10_000,
      systemToolsReserveTokens: 99_999,
      targetBandTokens: 10_000,
      pressureCeilingTokens: 10_000,
      tailEpochCapTokens: 10_000,
    });

    expect(budget.limitSource).toBe('explicit-override');
    expect(budget.messageCeilingTokens).toBe(1);
    expect(budget.bandTokens).toBe(1);
    expect(budget.pressureCeilingTokens).toBe(1);
    expect(budget.prefixSaturationTokens).toBe(1);
    expect(budget.tailEpochCapTokens).toBe(1);
    expect(budget.toolResultWindowCapChars).toBeGreaterThanOrEqual(1);
  });

  it('does not derive token pressure ceilings from character ratios', () => {
    const defaultChars = resolveContextBudget({ engine: 'claude', model: 'claude-sonnet-4' });
    const unusualChars = resolveContextBudget({
      engine: 'claude',
      model: 'claude-sonnet-4',
      charsPerToken: 99,
    });

    expect(unusualChars.bandTokens).toBe(defaultChars.bandTokens);
    expect(unusualChars.pressureCeilingTokens).toBe(defaultChars.pressureCeilingTokens);
    expect(unusualChars.messageCeilingTokens).toBe(defaultChars.messageCeilingTokens);
    expect(unusualChars.prefixSaturationTokens).toBe(defaultChars.prefixSaturationTokens);
    expect(unusualChars.bandChars).toBe(unusualChars.bandTokens * 99);
    expect(unusualChars.tailEpochCapChars).toBe(unusualChars.tailEpochCapTokens * 99);
  });

  it('supports disabling measured pressure while keeping the rest of the budget deterministic', () => {
    const budget = resolveContextBudget({
      engine: 'deepseek',
      model: 'deepseek-v4-pro',
      env: { VOXXO_FOLD_PRESSURE_CEILING_TOKENS: 'off' },
    });

    expect(budget.contextWindowTokens).toBe(1_000_000);
    expect(budget.pressureCeilingTokens).toBeNull();
    expect(budget.bandTokens).toBe(160_000);
  });

  it('marks unknown providers as conservative 200k-style fallback instead of guessing upward', () => {
    const budget = resolveContextBudget({ engine: 'mystery-provider', model: 'mystery-model' });

    expect(budget.contextWindowTokens).toBe(200_000);
    expect(budget.limitSource).toBe('conservative-fallback');
    expect(budget.conservativeFallback).toBe(true);
    expect(budget.budgetTier).toBe('unknown-conservative');
    expect(budget.compressionProfile).toBe('survival');
    expect(budget.pressureCeilingTokens).toBe(160_000);
  });
});
