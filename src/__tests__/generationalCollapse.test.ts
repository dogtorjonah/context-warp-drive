import { describe, expect, it } from 'vitest';

import {
  adaptiveBackfill,
  collapseUnits,
  formatCollapseReceipt,
  formatCollapseRollup,
  type CollapseUnit,
} from '../generationalCollapse.ts';

function unit(overrides: Partial<CollapseUnit> & { id: string }): CollapseUnit {
  return {
    sourceAt: '2026-07-13T00:00:00.000Z',
    kind: 'operator',
    verbatim: `[operator ${overrides.id}] ${'body '.repeat(20)}`.trim(),
    digest: `- ${overrides.id} digest line`,
    eraKey: '2026-07-13',
    claim: `claim for ${overrides.id}`,
    recover: `tap_instance_messages action="canonical" target_instance_id="x" search="${overrides.id}"`,
    sha256: 'a'.repeat(64),
    verified: true,
    ...overrides,
  };
}

function lineage(count: number): CollapseUnit[] {
  return Array.from({ length: count }, (_, index) => unit({
    id: `u${String(index).padStart(3, '0')}`,
    sourceAt: new Date(Date.UTC(2026, 6, 1 + index)).toISOString(),
    eraKey: `2026-W${Math.floor(index / 7)}`,
  }));
}

describe('generational collapse', () => {
  it('keeps every unit verbatim when the budget allows', () => {
    const units = lineage(5);
    const result = collapseUnits({ units, maxChars: 100_000 });
    expect(result.complete).toBe(true);
    expect(result.tierCounts.t0).toBe(5);
    for (const u of units) expect(result.text).toContain(u.verbatim);
  });

  it('demotes the oldest unit first and preserves the newest verbatim', () => {
    const units = lineage(10);
    const result = collapseUnits({ units, maxChars: 700 });
    const placements = new Map(result.placements.map((p) => [p.id, p.tier]));
    expect(placements.get('u000')).not.toBe('t0');
    expect(placements.get('u009')).toBe('t0');
    expect(result.chars).toBeLessThanOrEqual(700);
    expect(result.complete).toBe(false);
  });

  it('is deterministic: same units and budget produce byte-identical output', () => {
    const units = lineage(24);
    const a = collapseUnits({ units, maxChars: 1_500 });
    const b = collapseUnits({ units: [...units].reverse(), maxChars: 1_500 });
    expect(a.text).toBe(b.text);
  });

  it('never mints a receipt for an unverified unit (mint gate: floor is t2)', () => {
    const units = lineage(8).map((u) => ({ ...u, verified: false, sha256: null }));
    const result = collapseUnits({ units, maxChars: 200 });
    for (const placement of result.placements) {
      expect(['t0', 't1', 't2']).toContain(placement.tier);
    }
    expect(result.text).not.toContain('[RECEIPT');
  });

  it('quarantines unknown-time units and demotes them before known-time units', () => {
    const units = [
      ...lineage(4),
      unit({ id: 'z-unknown', sourceAt: null, eraKey: null }),
    ];
    const result = collapseUnits({ units, maxChars: 600 });
    const placements = new Map(result.placements.map((p) => [p.id, p.tier]));
    expect(placements.get('z-unknown')).not.toBe('t0');
    expect(result.text).toContain('Unknown source time (quarantined');
  });

  it('emits exact receipt and rollup formats', () => {
    const single = unit({ id: 'r1' });
    const receipt = formatCollapseReceipt(single);
    expect(receipt).toMatch(
      /^\[RECEIPT kind=operator id=r1 span=\S+\.\.\S+ sha256=[0-9a-f]{12} chars=\d+ claim="[^"]*" recover=.+\]$/u,
    );
    const rollup = formatCollapseRollup(lineage(3), 'tap_star action="harvest"');
    expect(rollup).toMatch(/^\[ROLLUP kind=operator n=3 span=\S+\.\.\S+ recover=tap_star action="harvest"\]$/u);
  });

  it('degrades to a single honest rollup under floor pressure', () => {
    const result = collapseUnits({
      units: lineage(12),
      maxChars: 120,
      floorRecover: 'tap_instance_messages action="canonical" target_instance_id="x"',
    });
    expect(result.droppedToFloorRollup).toBe(12);
    expect(result.text.startsWith('[ROLLUP')).toBe(true);
    expect(result.chars).toBeLessThanOrEqual(120);
  });

  it('always respects the cap across a wide budget sweep', () => {
    const units = lineage(40);
    for (const cap of [150, 400, 900, 2_000, 5_000, 20_000]) {
      const result = collapseUnits({ units, maxChars: cap });
      expect(result.chars).toBeLessThanOrEqual(cap);
    }
  });

  it('adaptive backfill spends spare budget on the highest-priority section first', () => {
    const heavy = lineage(20);
    const light = lineage(20).map((u) => ({ ...u, id: `l-${u.id}` }));
    const outcome = adaptiveBackfill(
      [
        { id: 'operatorVault', units: heavy, baseCap: 500 },
        { id: 'episodeChapterIndex', units: light, baseCap: 500 },
      ],
      40_000,
      { minChunk: 100 },
    );
    const vault = outcome.grants.find((g) => g.id === 'operatorVault')!;
    const episodes = outcome.grants.find((g) => g.id === 'episodeChapterIndex')!;
    expect(vault.granted).toBeGreaterThan(0);
    expect(vault.cap).toBeGreaterThan(500);
    expect(vault.result.chars).toBeLessThanOrEqual(vault.cap);
    expect(episodes.result.chars).toBeLessThanOrEqual(episodes.cap);
    expect(outcome.spareRemaining).toBeLessThanOrEqual(40_000);
  });

  it('adaptive backfill leaves complete sections untouched', () => {
    const outcome = adaptiveBackfill(
      [{ id: 'lifeLedger', units: lineage(3), baseCap: 100_000 }],
      50_000,
      { minChunk: 100 },
    );
    expect(outcome.grants[0].granted).toBe(0);
    expect(outcome.grants[0].result.complete).toBe(true);
  });
});
