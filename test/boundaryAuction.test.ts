import { describe, expect, test, vi } from 'vitest';

import {
  boundaryAuctionPressureBudget,
  rankBoundaryAuctionNominations,
  resolveBoundaryAuctionEnabled,
  runBoundaryAuction,
  selectBoundaryAuctionNominations,
  type BoundaryAuctionNomination,
} from '../src/boundaryAuction.ts';

function block(id: string, chars: number): string {
  const prefix = `${id}:`;
  if (prefix.length >= chars) return prefix.slice(0, Math.max(0, chars));
  return prefix + '.'.repeat(Math.max(0, chars - prefix.length));
}

function nomination(
  id: string,
  source: string,
  tier: number,
  value: number,
  chars: number,
): BoundaryAuctionNomination {
  return { id, source, tier, value, chars, render: block(id, chars) };
}

describe('boundary auction pure core', () => {
  test('fills one shared budget across channels after skipping too-large ranked items', () => {
    const nominations = [
      nomination('fold-large', 'fold-recall', 0, 10, 30),
      nomination('aa-mid', 'ambient-atlas', 0, 9, 10),
      nomination('active-small', 'active-pin', 1, 99, 5),
    ];

    const selected = selectBoundaryAuctionNominations(nominations, {
      charBudget: 36,
      separator: '\n',
    });

    expect(selected.selected.map((decision) => decision.id)).toEqual(['fold-large', 'active-small']);
    expect(selected.omitted.map((decision) => [decision.id, decision.skipped])).toEqual([['aa-mid', 'budget']]);
    expect(selected.chars).toBe(36);
  });

  test('uses one coherent pressure ladder for the shared char budget', () => {
    expect(boundaryAuctionPressureBudget(4000, 'healthy').charBudget).toBe(4000);
    expect(boundaryAuctionPressureBudget(4000, 'warning').charBudget).toBe(2000);
    expect(boundaryAuctionPressureBudget(4000, 'critical').charBudget).toBe(1000);
    expect(boundaryAuctionPressureBudget(4000, 'auto_compact').charBudget).toBe(800);
    expect(boundaryAuctionPressureBudget(1000, 'auto_compact').charBudget)
      .toBeLessThanOrEqual(boundaryAuctionPressureBudget(1000, 'critical').charBudget);

    const nominations = [
      nomination('a', 'fold-recall', 0, 4, 700),
      nomination('b', 'episodic-chain', 0, 3, 700),
      nomination('c', 'active-pin', 0, 2, 700),
      nomination('d', 'ambient-atlas', 0, 1, 700),
    ];

    const counts = (['healthy', 'warning', 'critical', 'auto_compact'] as const)
      .map((pressure) => selectBoundaryAuctionNominations(nominations, {
        charBudget: 4000,
        pressure,
        separator: '',
      }).selected.length);

    expect(counts).toEqual([4, 2, 1, 1]);
  });

  test('is deterministic by tier, value, source order, then input order', () => {
    const nominations = [
      nomination('active-one', 'active-pin', 1, 5, 1),
      nomination('aa-one', 'ambient-atlas', 1, 5, 1),
      nomination('fold-low-value', 'fold-recall', 0, 1, 1),
      nomination('episodic-one', 'episodic-chain', 1, 5, 1),
      nomination('fold-one', 'fold-recall', 1, 5, 1),
      nomination('active-two', 'active-pin', 1, 5, 1),
    ];

    const first = rankBoundaryAuctionNominations(nominations).map((item) => item.id);
    const second = rankBoundaryAuctionNominations(nominations).map((item) => item.id);

    expect(first).toEqual([
      'fold-low-value',
      'fold-one',
      'episodic-one',
      'active-one',
      'active-two',
      'aa-one',
    ]);
    expect(second).toEqual(first);
  });

  test('defaults off and returns legacy text byte-identically without rendering nominations', () => {
    const render = vi.fn(() => 'auction text');
    const legacyText = 'legacy fold recall\n\nlegacy episode block';

    expect(resolveBoundaryAuctionEnabled({})).toBe(false);
    expect(resolveBoundaryAuctionEnabled({ VOXXO_BOUNDARY_AUCTION: '1' })).toBe(true);

    const result = runBoundaryAuction(
      [{ id: 'new', source: 'fold-recall', tier: 0, value: 1, chars: 12, render }],
      { charBudget: 100, legacyText },
    );

    expect(result.enabled).toBe(false);
    expect(result.text).toBe(legacyText);
    expect(result.chars).toBe(legacyText.length);
    expect(render).not.toHaveBeenCalled();
  });

  test('enabled run renders selected nominations in auction order', () => {
    const result = runBoundaryAuction(
      [
        nomination('aa', 'ambient-atlas', 0, 10, 6),
        nomination('fold', 'fold-recall', 0, 10, 8),
        nomination('episode', 'episodic-chain', 1, 20, 7),
      ],
      { enabled: true, charBudget: 30, separator: '\n' },
    );

    expect(result.enabled).toBe(true);
    expect(result.selected.map((decision) => decision.id)).toEqual(['fold', 'aa', 'episode']);
    expect(result.text).toBe([block('fold', 8), block('aa', 6), block('episode', 7)].join('\n'));
  });

  test('commits visibility hooks only for nominations that actually render', () => {
    const selected = vi.fn();
    const omitted = vi.fn();
    const result = runBoundaryAuction([
      { ...nomination('winner', 'fold-recall', 0, 2, 8), onSelected: selected },
      { ...nomination('omitted', 'episodic-chain', 1, 1, 8), onSelected: omitted },
    ], { enabled: true, charBudget: 8, separator: '' });

    expect(result.text).toBe(block('winner', 8));
    expect(selected).toHaveBeenCalledTimes(1);
    expect(omitted).not.toHaveBeenCalled();

    const empty = vi.fn();
    expect(runBoundaryAuction([
      { id: 'empty', source: 'fold-recall', tier: 0, value: 1, chars: 0, render: '', onSelected: empty },
    ], { enabled: true, charBudget: 8 }).text).toBe('');
    expect(empty).not.toHaveBeenCalled();
  });
});
