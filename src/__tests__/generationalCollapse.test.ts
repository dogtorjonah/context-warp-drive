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

  it('renders newest-first without changing oldest-first demotion', () => {
    const units = lineage(10);
    const full = collapseUnits({ units, maxChars: 100_000, renderOrder: 'newest_first' });
    expect(full.text.indexOf(units[9]!.verbatim)).toBeLessThan(full.text.indexOf(units[0]!.verbatim));

    const pressured = collapseUnits({ units, maxChars: 700, renderOrder: 'newest_first' });
    const placements = new Map(pressured.placements.map((placement) => [placement.id, placement.tier]));
    expect(placements.get('u000')).not.toBe('t0');
    expect(placements.get('u009')).toBe('t0');
  });

  it('is deterministic: same units and budget produce byte-identical output', () => {
    const units = lineage(24);
    const a = collapseUnits({ units, maxChars: 1_500 });
    const b = collapseUnits({ units: [...units].reverse(), maxChars: 1_500 });
    expect(a.text).toBe(b.text);
  });

  it('never mints a RECEIPT for an unverified unit (B7 mint-gate split: floor t2, may roll up to t4, never t3)', () => {
    const units = lineage(8).map((u) => ({ ...u, verified: false, sha256: null }));
    const result = collapseUnits({ units, maxChars: 200 });
    for (const placement of result.placements) {
      // Unverified units may demote to t2 (era) and then DIRECTLY to t4
      // (rollup — no per-unit hash minted) but must never land on a t3
      // receipt (which would mint a per-unit hash they cannot attest).
      expect(['t0', 't1', 't2', 't4']).toContain(placement.tier);
    }
    // No unit may mint a t3 receipt.
    expect(result.text).not.toContain('[RECEIPT');
    // The rollup is the sanctioned floor landing for unverified units.
    expect(result.text).toContain('[ROLLUP');
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
      /^\[RECEIPT kind=operator id=r1 span=\S+\.\.\S+ sha256=[0-9a-f]{12} verbatim-chars-total=\d+ claim="[^"]*" recover=.+\]$/u,
    );
    const rollup = formatCollapseRollup(lineage(3), 'tap_star action="harvest"');
    expect(rollup).toMatch(/^\[ROLLUP kind=operator n=3 span=\S+\.\.\S+ recover=tap_star action="harvest"\]$/u);
  });

  it('declares a projection with byte-faithful stored/source counts instead of claiming full proof', () => {
    // Non-ASCII body so chars and bytes diverge (é = 2 bytes UTF-8). The
    // receipt must report byte counts that attest the STORED prefix and name
    // the SOURCE dimensions, so no reader mistakes the stored hash for
    // full-artifact proof.
    const head = 'café ☕ '.repeat(3); // 6 chars, 8 bytes each in the 'é ☕ ' triplet
    const truncated = unit({
      id: 'p1',
      verbatim: head,
      projection: {
        mode: 'truncated',
        algorithm: 'head-clamp',
        version: 1,
        storedChars: head.length,
        storedBytes: Buffer.byteLength(head, 'utf8'),
        sourceChars: 900,
        sourceBytes: 1_400,
      },
    });
    const receipt = formatCollapseReceipt(truncated);
    // Projection marker names mode+version and all four dimensions.
    expect(receipt).toContain('projection=truncated/v1');
    expect(receipt).toContain(`stored-chars=${head.length}`);
    expect(receipt).toContain(`stored-bytes=${Buffer.byteLength(head, 'utf8')}`);
    expect(receipt).toContain('source-chars=900');
    expect(receipt).toContain('source-bytes=1400');
    // Byte count diverges from char count — proving non-ASCII bytes counted.
    expect(Buffer.byteLength(head, 'utf8')).not.toBe(head.length);
    // A projection is never allowed to look like a full-verbatim receipt: the
    // stored-char count must be smaller than the source-char count.
    expect(head.length).toBeLessThan(900);
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

  it('never emits a partial executable handle when the floor rollup exceeds a positive cap (audit-2 A14)', () => {
    // A recover command far longer than the floor cap: legacy `rollup.slice`
    // would cut it mid-token (`…action="fetch" owne…`), and the executed-handle
    // gate then harvests a corrupt command. The floor branch must ship a WHOLE
    // census line WITHOUT a recover= command rather than a partial handle, and
    // stay under the cap.
    const LONG_RECOVER = 'continuity_ledger action="fetch" owner="inst-a" capture_id="cap-1" section_id="operatorVault" omitted_only=true include_unknown_source_time=true limit=200';
    const units = lineage(40).map((unit, i) => ({
      ...unit,
      id: `op:${i}`,
      recover: `${LONG_RECOVER} unit=${i}`,
    }));
    for (const cap of [120, 150, 90]) {
      const result = collapseUnits({ units, maxChars: cap });
      expect(result.droppedToFloorRollup).toBe(units.length);
      expect(result.text.startsWith('[ROLLUP')).toBe(true);
      expect(result.chars).toBeLessThanOrEqual(cap);
      // No partial executable command: any recover=/ledger= token is whole, and
      // a reset census never carries a truncated `action=`.
      expect(result.text).not.toContain('action="fetch"');
    }
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

  it('releases the recency floor only after every unprotected unit hits its floor (audit-2 A14 gate)', () => {
    // audit-2 scramble DECISIVE 2: the terminal A14 repair lets protected
    // newest-K units demote BELOW their t1 digest floor when the section still
    // cannot fit after every unprotected unit reached its own floor. Without
    // the release gate the protected digests stay pinned at t1 forever and the
    // section falls through to the floor census even though demoting the
    // protected units would fit the cap. Phase 1 proves the section fits
    // WITHOUT the census only because the protected units demoted below t1;
    // phase 2 proves irreducible pressure still lands on a WHOLE handle-free
    // census inside the cap.
    const LONG_RECOVER = 'continuity_ledger action="fetch" owner="inst-a" capture_id="cap-1" section_id="episodeChapterIndex" omitted_only=true include_unknown_source_time=true limit=200';
    const makeEpisode = (minute: number): CollapseUnit => ({
      id: `ep:${String(minute).padStart(2, '0')}`,
      sourceAt: `2026-08-02T17:${String(minute).padStart(2, '0')}:00.000Z`,
      kind: 'episode',
      verbatim: `EPISODE ${minute} ${'V'.repeat(280)}`,
      digest: `EPISODE ${minute} ${'D'.repeat(220)}`,
      eraKey: '2026-08-02',
      claim: `episode ${minute}`,
      recover: `${LONG_RECOVER} unit=${minute}`,
      sha256: 'a'.repeat(64),
      verified: true,
    });
    const units = Array.from({ length: 40 }, (_, minute) => makeEpisode(minute));
    const newestIds = new Set(['ep:37', 'ep:38', 'ep:39']);
    const options = { recencyFloorK: 3, recencyFloorKind: 'episode' as const };
    // Phase 1 (cap 400): the three protected t1 digests (~223 chars each) plus
    // the 37-unit t4 rollup exceed the cap; only demoting the protected units
    // below t1 lets the whole run fuse into one t4 rollup that fits. Without
    // the release gate, droppedToFloorRollup would be 40 (floor census).
    const released = collapseUnits({ units, maxChars: 400, ...options });
    expect(released.chars).toBeLessThanOrEqual(400);
    expect(released.droppedToFloorRollup).toBe(0);
    const tiers = new Map(released.placements.map((placement) => [placement.id, placement.tier]));
    for (const id of newestIds) {
      // Protected newest episodes demoted BELOW their t1 digest floor — the
      // release-gate behavior (they end fused into the t4 run with everyone).
      expect(['t2', 't3', 't4']).toContain(tiers.get(id));
    }
    // Phase 2 (cap 100): even the fully fused all-t4 rollup cannot fit, so the
    // floor branch ships a WHOLE handle-free census inside the cap — no
    // recover= token, no truncated `action=`, honest n= count.
    const census = collapseUnits({ units, maxChars: 100, ...options });
    expect(census.droppedToFloorRollup).toBe(units.length);
    expect(census.text.startsWith('[ROLLUP')).toBe(true);
    expect(census.chars).toBeLessThanOrEqual(100);
    expect(census.text).not.toContain('recover=');
    expect(census.text).not.toContain('action="fetch"');
    expect(census.text).toContain('n=40');
  });
});
