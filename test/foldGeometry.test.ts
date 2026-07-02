import { describe, expect, test, vi } from 'vitest';

import {
  DEFAULT_FOLD_RECALL_CONFIG,
  MAX_TTL_DEADZONE_BUFFER_PASSES,
  MIN_USEFUL_CARD_CHARS,
  RECALL_BODY_RESERVED_GAP_CHARS,
  resolveFoldRecallConfig,
  validateFoldGeometry,
  type FoldGeometryInputs,
} from '../src/foldRecall.ts';
import { ALWAYS_ON_FOLD_CONFIG, DEFAULT_FIDELITY_VALUE_RECENCY_FLOOR_TURNS } from '../src/rollingFold.ts';

/** The live shipped defaults, assembled the same way the module-load self-check does. */
function liveDefaults(): FoldGeometryInputs {
  return {
    ttlPasses: DEFAULT_FOLD_RECALL_CONFIG.ttlPasses,
    activeWindowTurns: ALWAYS_ON_FOLD_CONFIG.activeWindowTurns,
    recencyFloorTurns: DEFAULT_FIDELITY_VALUE_RECENCY_FLOOR_TURNS,
    maxTotalChars: DEFAULT_FOLD_RECALL_CONFIG.maxTotalChars,
    maxCardChars: DEFAULT_FOLD_RECALL_CONFIG.maxCardChars,
  };
}

describe('validateFoldGeometry', () => {
  test('the live shipped defaults pass clean (no violations)', () => {
    expect(validateFoldGeometry(liveDefaults())).toEqual([]);
  });

  test('reproduces the historical rail-ed5588b5 dead zone: ttlPasses=8, activeWindowTurns=1', () => {
    const buggyInputs: FoldGeometryInputs = {
      ...liveDefaults(),
      ttlPasses: 8,
      activeWindowTurns: 1,
    };
    const violations = validateFoldGeometry(buggyInputs);
    const ttlViolation = violations.find((v) => v.rule === 'ttl-deadzone');
    expect(ttlViolation).toBeDefined();
    expect(ttlViolation?.message).toContain('7 passes');
    expect(ttlViolation?.message).toContain('rail-ed5588b5');
  });

  test('does NOT flag the current fixed shape: ttlPasses=4, activeWindowTurns=1 (buffer=3)', () => {
    const fixedInputs: FoldGeometryInputs = {
      ...liveDefaults(),
      ttlPasses: 4,
      activeWindowTurns: 1,
    };
    const violations = validateFoldGeometry(fixedInputs);
    expect(violations.find((v) => v.rule === 'ttl-deadzone')).toBeUndefined();
  });

  test('flags exactly at the ceiling boundary: buffer > MAX_TTL_DEADZONE_BUFFER_PASSES fails, buffer === ceiling passes', () => {
    const atCeiling = validateFoldGeometry({
      ...liveDefaults(),
      activeWindowTurns: 1,
      ttlPasses: 1 + MAX_TTL_DEADZONE_BUFFER_PASSES,
    });
    expect(atCeiling.find((v) => v.rule === 'ttl-deadzone')).toBeUndefined();

    const overCeiling = validateFoldGeometry({
      ...liveDefaults(),
      activeWindowTurns: 1,
      ttlPasses: 2 + MAX_TTL_DEADZONE_BUFFER_PASSES,
    });
    expect(overCeiling.find((v) => v.rule === 'ttl-deadzone')).toBeDefined();
  });

  test('flags recencyFloorTurns dropping below activeWindowTurns', () => {
    const violations = validateFoldGeometry({
      ...liveDefaults(),
      activeWindowTurns: 5,
      recencyFloorTurns: 2,
    });
    const violation = violations.find((v) => v.rule === 'recency-floor-below-window');
    expect(violation).toBeDefined();
    expect(violation?.message).toContain('recencyFloorTurns (2)');
    expect(violation?.message).toContain('activeWindowTurns (5)');
  });

  test('does not flag recencyFloorTurns equal to or above activeWindowTurns', () => {
    expect(
      validateFoldGeometry({ ...liveDefaults(), activeWindowTurns: 1, recencyFloorTurns: 1 }).find(
        (v) => v.rule === 'recency-floor-below-window',
      ),
    ).toBeUndefined();
    expect(
      validateFoldGeometry({ ...liveDefaults(), activeWindowTurns: 1, recencyFloorTurns: 8 }).find(
        (v) => v.rule === 'recency-floor-below-window',
      ),
    ).toBeUndefined();
  });

  test('flags an auto_compact per-card budget that would degrade below MIN_USEFUL_CARD_CHARS', () => {
    // autoCompactCharBudget = min(800, maxTotalChars); effective body = min(maxCardChars, that - gap).
    // Force it under MIN_USEFUL_CARD_CHARS by shrinking maxTotalChars well below 800.
    const violations = validateFoldGeometry({
      ...liveDefaults(),
      maxTotalChars: 500, // autoCompactCharBudget = 500; 500 - 200 = 300 < MIN_USEFUL_CARD_CHARS(400)
      maxCardChars: 6_000,
    });
    const violation = violations.find((v) => v.rule === 'auto-compact-card-too-small');
    expect(violation).toBeDefined();
    expect(violation?.message).toContain('MIN_USEFUL_CARD_CHARS');
  });

  test('does not flag the live default auto_compact geometry (maxTotalChars=12000, maxCardChars=6000)', () => {
    // autoCompactCharBudget = min(800, 12000) = 800; effective body = min(6000, 800-200) = 600 >= 400.
    expect(
      validateFoldGeometry(liveDefaults()).find((v) => v.rule === 'auto-compact-card-too-small'),
    ).toBeUndefined();
  });

  test('exported constants match the values the render path actually uses', () => {
    expect(MIN_USEFUL_CARD_CHARS).toBe(400);
    expect(RECALL_BODY_RESERVED_GAP_CHARS).toBe(200);
  });

  test('is pure: identical inputs produce byte-identical (deep-equal) output across repeated calls', () => {
    const inputs = liveDefaults();
    const first = validateFoldGeometry(inputs);
    const second = validateFoldGeometry({ ...inputs });
    expect(second).toEqual(first);
  });

  test('resolveFoldRecallConfig checks env-resolved geometry in dev/test without throwing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => resolveFoldRecallConfig({ NODE_ENV: 'test', WARP_FOLD_RECALL_TTL_PASSES: '8' })).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[fold-geometry:resolveFoldRecallConfig] ttl-deadzone'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('7 passes'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
