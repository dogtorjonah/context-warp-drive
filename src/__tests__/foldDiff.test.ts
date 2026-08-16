import { describe, expect, it } from 'vitest';

import { buildFoldDiff, countBlockedRegisterMarkers, type FoldDiffInventory } from '../foldDiff.ts';

const inv = (overrides: Partial<FoldDiffInventory> = {}): FoldDiffInventory => ({
  epochs: 3,
  frozenViewChars: 12_000,
  frozenRawCount: 41,
  frozenBands: 3,
  sealedVaultRows: 14,
  residentZones: 9,
  evictedTurnLifetime: 5,
  newlyEvictedTurns: 0,
  turnsFolded: 0,
  turnsRetained: 0,
  ...overrides,
});

describe('buildFoldDiff', () => {
  it('renders a hard-epoch transition with deltas', () => {
    const pre = inv({ epochs: 3 });
    const post = inv({
      epochs: 1,
      frozenBands: 4,
      frozenRawCount: 0,
      turnsFolded: 41,
      turnsRetained: 6,
      openLoops: 2,
    });
    const diff = buildFoldDiff({ kind: 'hard-epoch', reason: 'pressure-ceiling', pre, post });
    expect(diff).toContain('[fold diff · hard-epoch · pressure-ceiling · epochs 3→1 (−2)]');
    expect(diff).toContain('retained resident: 9 zones · 14 sealed vault rows · 4 frozen bands');
    expect(diff).toContain('newly summarized: +41 turn(s) folded · raw 41→0 (−41) msgs → 4 frozen bands');
    expect(diff).toContain('open loops retained: 2');
  });

  it('reports evictions under moved-behind-recovery', () => {
    const pre = inv();
    const post = inv({ epochs: 4, newlyEvictedTurns: 2, evictedTurnLifetime: 7, turnsFolded: 3 });
    const diff = buildFoldDiff({ kind: 'rolling', pre, post });
    expect(diff).toContain('moved behind recovery: +2 turn(s) evicted this fold · 7 lifetime — raw history + episodic store');
    expect(diff).toContain('newly summarized: +3 turn(s) folded');
  });

  it('renders superseded statements only when a side supplies the count', () => {
    const diff = buildFoldDiff({
      kind: 'rolling',
      pre: inv(),
      post: inv({ epochs: 4, turnsFolded: 1, supersededStatements: 3 }),
    });
    expect(diff).toContain('superseded statements: 3');
    const without = buildFoldDiff({ kind: 'rolling', pre: inv(), post: inv({ epochs: 4, turnsFolded: 1 }) });
    expect(without).not.toContain('superseded statements');
  });

  it('returns null for baseline and for inventories where nothing moved', () => {
    expect(buildFoldDiff({ kind: 'baseline', pre: inv(), post: inv() })).toBeNull();
    expect(buildFoldDiff({ kind: 'rolling', pre: inv(), post: inv() })).toBeNull();
  });

  it('is byte-stable for identical input', () => {
    const pre = inv();
    const post = inv({ epochs: 4, turnsFolded: 2 });
    expect(buildFoldDiff({ kind: 'rolling', pre, post })).toBe(buildFoldDiff({ kind: 'rolling', pre, post }));
  });
});

describe('countBlockedRegisterMarkers', () => {
  it('counts ❓ register lines across bounded texts', () => {
    expect(countBlockedRegisterMarkers([
      '❓ blocked on auth\nnormal line',
      'no markers here',
      '❓ another blocker',
    ])).toBe(2);
    expect(countBlockedRegisterMarkers([])).toBe(0);
    expect(countBlockedRegisterMarkers(['not blocked'])).toBe(0);
  });
});
