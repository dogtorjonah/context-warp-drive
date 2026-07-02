import { describe, it, expect } from 'vitest';

import {
  createEpisodicInjectionState,
  noteEpisodicInjection,
  refreshEpisodicZones,
  expireEpisodicZones,
  activeEpisodicPathCards,
  selectActiveEpisodicPathCards,
  scoreEpisodicZoneValue,
  episodicValueTtlMultiplier,
  effectiveEpisodicZoneTtl,
  anchorKindScore,
  strongerEpisodicKind,
  DEFAULT_EPISODIC_VALUE_LEDGER_CONFIG,
  DEFAULT_EPISODIC_VALUE_WEIGHTS,
  EPISODIC_ZONE_TTL_BOUNDARIES,
  type EpisodicRecallCardLike,
  type EpisodicInjectionState,
  type EpisodicValueLedgerConfig,
  type EpisodicZoneResidency,
} from '../foldEpisodes.ts';

// ── Builders ───────────────────────────────────────────────────────────────

function card(
  targetPath: string,
  kind: EpisodicRecallCardLike['kind'] = 'chain',
  chapterIds: number[] = [1],
): EpisodicRecallCardLike {
  return {
    targetPath,
    renderedCard: `[Episode recall ${targetPath} — 2026-06-19, "burst"]\n  members: ${targetPath}`,
    chapterIds,
    memberPaths: [targetPath],
    kind,
  };
}

function zone(partial: Partial<EpisodicZoneResidency> = {}): EpisodicZoneResidency {
  return {
    expiresAtBoundary: 0,
    chapterIds: [1],
    firstSeenBoundary: 0,
    lastEngagedBoundary: 0,
    engagementCount: 1,
    kind: 'chain',
    ...partial,
  };
}

function stateWithZones(
  entries: Array<[string, EpisodicZoneResidency]>,
  boundarySeq = 0,
): EpisodicInjectionState {
  const st = createEpisodicInjectionState();
  st.boundarySeq = boundarySeq;
  for (const [path, z] of entries) st.zones.set(path, z);
  return st;
}

const ENABLED: EpisodicValueLedgerConfig = { ...DEFAULT_EPISODIC_VALUE_LEDGER_CONFIG };
const DISABLED: EpisodicValueLedgerConfig = { ...DEFAULT_EPISODIC_VALUE_LEDGER_CONFIG, enabled: false };
const BASE_TTL = EPISODIC_ZONE_TTL_BOUNDARIES;

// ── anchorKindScore / strongerEpisodicKind ──────────────────────────────────

describe('anchorKindScore + strongerEpisodicKind', () => {
  it('ranks real work chains and rail targets strongest, pointers/terms weakest', () => {
    expect(anchorKindScore('chain')).toBe(1);
    expect(anchorKindScore('rail')).toBe(1);
    expect(anchorKindScore('mention')).toBe(0.6);
    expect(anchorKindScore('walk')).toBe(0.5);
    expect(anchorKindScore('pointer')).toBe(0.3);
    expect(anchorKindScore('term')).toBe(0.3);
    expect(anchorKindScore(undefined)).toBe(0.5);
  });

  it('keeps the strongest-seen kind and treats undefined as no prior', () => {
    expect(strongerEpisodicKind(undefined, 'pointer')).toBe('pointer');
    expect(strongerEpisodicKind('chain', 'pointer')).toBe('chain'); // does not degrade on completion
    expect(strongerEpisodicKind('pointer', 'chain')).toBe('chain'); // upgrades on a real touch
  });
});

// ── scoreEpisodicZoneValue ──────────────────────────────────────────────────

describe('scoreEpisodicZoneValue', () => {
  it('is bounded to [0,1] and deterministic (pure)', () => {
    const z = zone({ engagementCount: 5, chapterIds: [1, 2, 3, 4], lastEngagedBoundary: 0, kind: 'chain' });
    const a = scoreEpisodicZoneValue('p', z, {}, 0);
    const b = scoreEpisodicZoneValue('p', z, {}, 0);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(1);
  });

  it('ranks a deeply-engaged fresh chain above an incidental shallow pointer', () => {
    const hot = zone({ engagementCount: 5, chapterIds: [1, 2, 3, 4], lastEngagedBoundary: 10, kind: 'chain' });
    const cold = zone({ engagementCount: 1, chapterIds: [1], lastEngagedBoundary: 10, kind: 'pointer' });
    expect(scoreEpisodicZoneValue('hot', hot, {}, 10)).toBeGreaterThan(
      scoreEpisodicZoneValue('cold', cold, {}, 10),
    );
  });

  it('decays with engagement distance (recency)', () => {
    const z = zone({ lastEngagedBoundary: 0, engagementCount: 2, chapterIds: [1, 2], kind: 'chain' });
    const fresh = scoreEpisodicZoneValue('p', z, {}, 0);
    const stale = scoreEpisodicZoneValue('p', z, {}, 24);
    expect(fresh).toBeGreaterThan(stale);
  });

  it('adds claimed/rail bonuses ON TOP of the engagement base (not a deflating average)', () => {
    const z = zone({ engagementCount: 2, chapterIds: [1, 2], lastEngagedBoundary: 0, kind: 'mention' });
    const base = scoreEpisodicZoneValue('p', z, {}, 0);
    const claimed = scoreEpisodicZoneValue('p', z, { claimedPaths: new Set(['p']) }, 0);
    const claimedRail = scoreEpisodicZoneValue(
      'p',
      z,
      { claimedPaths: new Set(['p']), railTargetPaths: new Set(['p']) },
      0,
    );
    expect(claimed).toBeGreaterThan(base);
    expect(claimedRail).toBeGreaterThan(claimed);
    // Bonus is additive by the configured weight (unless clamped at 1).
    expect(claimed).toBeCloseTo(Math.min(1, base + DEFAULT_EPISODIC_VALUE_WEIGHTS.claimed), 6);
  });

  it('keeps the unwired host (no claims/rail) at the full base range, not deflated', () => {
    // Max engagement with no host signals should approach 1, proving claimed/rail
    // weights are NOT in the denominator.
    const maxed = zone({ engagementCount: 99, chapterIds: [1, 2, 3, 4, 5, 6], lastEngagedBoundary: 0, kind: 'chain' });
    expect(scoreEpisodicZoneValue('p', maxed, {}, 0)).toBeCloseTo(1, 6);
  });
});

// ── multiplier + effective TTL ──────────────────────────────────────────────

describe('episodicValueTtlMultiplier + effectiveEpisodicZoneTtl', () => {
  it('anchors neutral value 0.5 → ×1.0, with min/max at the extremes', () => {
    expect(episodicValueTtlMultiplier(0.5, ENABLED)).toBeCloseTo(1, 6);
    expect(episodicValueTtlMultiplier(0, ENABLED)).toBeCloseTo(ENABLED.minTtlMultiplier, 6);
    expect(episodicValueTtlMultiplier(1, ENABLED)).toBeCloseTo(ENABLED.maxTtlMultiplier, 6);
    // monotonic
    expect(episodicValueTtlMultiplier(0.25, ENABLED)).toBeLessThan(episodicValueTtlMultiplier(0.75, ENABLED));
  });

  it('preserves high value longer and drops low value sooner; floors at 1', () => {
    expect(effectiveEpisodicZoneTtl(8, 1, ENABLED)).toBe(16); // ×2
    expect(effectiveEpisodicZoneTtl(8, 0.5, ENABLED)).toBe(8); // ×1 neutral
    expect(effectiveEpisodicZoneTtl(8, 0.2, ENABLED)).toBeLessThan(8); // drop sooner
    expect(effectiveEpisodicZoneTtl(1, 0, ENABLED)).toBeGreaterThanOrEqual(1); // never 0
  });

  it('disabled config returns the flat base TTL unchanged', () => {
    expect(effectiveEpisodicZoneTtl(8, 1, DISABLED)).toBe(8);
    expect(effectiveEpisodicZoneTtl(8, 0, DISABLED)).toBe(8);
  });
});

// ── noteEpisodicInjection ───────────────────────────────────────────────────

describe('noteEpisodicInjection', () => {
  it('disabled / no-options is byte-identical flat TTL and still records engagement data', () => {
    const st = createEpisodicInjectionState();
    st.boundarySeq = 5;
    noteEpisodicInjection(st, [card('a', 'chain', [1, 2])], BASE_TTL); // no value options
    const z = st.zones.get('a')!;
    expect(z.expiresAtBoundary).toBe(5 + BASE_TTL); // flat — unchanged from legacy
    // Engagement fields are populated regardless (pure additive bookkeeping).
    expect(z.firstSeenBoundary).toBe(5);
    expect(z.lastEngagedBoundary).toBe(5);
    expect(z.engagementCount).toBe(1);
    expect(z.kind).toBe('chain');
  });

  it('enabled preserves a high-value zone longer than the flat TTL', () => {
    const st = createEpisodicInjectionState();
    st.boundarySeq = 5;
    noteEpisodicInjection(st, [card('a', 'chain', [1, 2, 3, 4, 5])], BASE_TTL, { config: ENABLED });
    const z = st.zones.get('a')!;
    expect(z.expiresAtBoundary).toBeGreaterThan(5 + BASE_TTL);
  });

  it('merges engagement across re-injection (firstSeen sticks, count climbs)', () => {
    const st = createEpisodicInjectionState();
    st.boundarySeq = 2;
    noteEpisodicInjection(st, [card('a', 'chain')], BASE_TTL);
    st.boundarySeq = 6;
    noteEpisodicInjection(st, [card('a', 'pointer')], BASE_TTL);
    const z = st.zones.get('a')!;
    expect(z.firstSeenBoundary).toBe(2); // first sighting sticks
    expect(z.engagementCount).toBe(2);
    expect(z.kind).toBe('chain'); // strongest-seen anchor retained over the pointer
  });
});

// ── refreshEpisodicZones ────────────────────────────────────────────────────

describe('refreshEpisodicZones', () => {
  it('bumps engagement on an exact-path touch and extends a high-value zone past the flat slide', () => {
    const st = stateWithZones(
      [['a', zone({ engagementCount: 3, chapterIds: [1, 2, 3, 4], lastEngagedBoundary: 0, kind: 'chain', expiresAtBoundary: 8 })]],
      4,
    );
    refreshEpisodicZones(st, ['a'], BASE_TTL, { config: ENABLED });
    const z = st.zones.get('a')!;
    expect(z.lastEngagedBoundary).toBe(4);
    expect(z.engagementCount).toBe(4);
    expect(z.expiresAtBoundary).toBeGreaterThan(4 + BASE_TTL); // value-extended
  });

  it('disabled refresh is flat (boundarySeq + ttl) but still records engagement', () => {
    const st = stateWithZones([['a', zone({ engagementCount: 1, expiresAtBoundary: 8 })]], 4);
    refreshEpisodicZones(st, ['a'], BASE_TTL); // no options
    const z = st.zones.get('a')!;
    expect(z.expiresAtBoundary).toBe(4 + BASE_TTL); // flat — unchanged from legacy
    expect(z.lastEngagedBoundary).toBe(4);
    expect(z.engagementCount).toBe(2);
  });

  it('low-value zones expire sooner than high-value ones under the ledger', () => {
    // Inject one high-value (deep chain) and one low-value (shallow pointer) zone,
    // then advance boundaries: the low-value zone expires first.
    const st = createEpisodicInjectionState();
    st.boundarySeq = 0;
    noteEpisodicInjection(st, [card('hi', 'chain', [1, 2, 3, 4, 5])], BASE_TTL, { config: ENABLED });
    noteEpisodicInjection(st, [card('lo', 'pointer', [1])], BASE_TTL, { config: ENABLED });
    const hi = st.zones.get('hi')!.expiresAtBoundary;
    const lo = st.zones.get('lo')!.expiresAtBoundary;
    expect(hi).toBeGreaterThan(lo);
    // Advance to a boundary that expires the low-value zone but not the high-value one.
    st.boundarySeq = lo;
    expireEpisodicZones(st);
    expect(st.zones.has('lo')).toBe(false);
    expect(st.zones.has('hi')).toBe(true);
  });
});

// ── activeEpisodicPathCards: selection, byte-identity, hot-reuse invariant ──

describe('activeEpisodicPathCards', () => {
  function activeZone(path: string, partial: Partial<EpisodicZoneResidency> = {}): EpisodicZoneResidency {
    return zone({ activeCard: card(path, 'chain'), ...partial });
  }

  it('disabled mode is byte-identical: path-sorted, touch-only, first maxCards', () => {
    const st = stateWithZones([
      ['b', activeZone('b')],
      ['a', activeZone('a')],
      ['c', activeZone('c')],
    ]);
    const out = activeEpisodicPathCards(st, ['a', 'b', 'c'], { maxCards: 2 });
    expect(out.map((c) => c.targetPath)).toEqual(['a', 'b']); // path-sorted
  });

  it('no touch + no inactive re-pin yields nothing — the hot-reuse invariant (no tail mutation)', () => {
    const st = stateWithZones([['a', activeZone('a')]]);
    expect(activeEpisodicPathCards(st, [], { maxCards: 2 })).toEqual([]);
    expect(activeEpisodicPathCards(st, [], { maxCards: 2, valueConfig: ENABLED })).toEqual([]);
  });

  it('respects excludeHeaderLines even in value mode — a resident copy is never re-pasted', () => {
    const z = activeZone('a');
    const st = stateWithZones([['a', z]]);
    const header = z.activeCard!.renderedCard.split('\n')[0];
    const out = activeEpisodicPathCards(st, ['a'], {
      maxCards: 2,
      valueConfig: ENABLED,
      excludeHeaderLines: new Set([header]),
    });
    expect(out).toEqual([]); // live copy resident → skip → byte-stable send view
  });

  it('value mode ranks the most valuable touched zone first under a tight budget', () => {
    const st = stateWithZones(
      [
        ['a', activeZone('a', { engagementCount: 1, chapterIds: [1], lastEngagedBoundary: 0 })],
        ['z', activeZone('z', { engagementCount: 6, chapterIds: [1, 2, 3, 4], lastEngagedBoundary: 10 })],
      ],
      10,
    );
    // Disabled → path order picks 'a'. Enabled → value picks 'z' (deeper, fresher).
    expect(activeEpisodicPathCards(st, ['a', 'z'], { maxCards: 1 }).map((c) => c.targetPath)).toEqual(['a']);
    expect(
      activeEpisodicPathCards(st, ['a', 'z'], { maxCards: 1, valueConfig: ENABLED }).map((c) => c.targetPath),
    ).toEqual(['z']);
  });

  it('repinInactive re-pins a high-value untouched zone above the floor; off by default it does not', () => {
    const st = stateWithZones(
      [['x', activeZone('x', { engagementCount: 8, chapterIds: [1, 2, 3, 4, 5], lastEngagedBoundary: 0 })]],
      0,
    );
    // 'x' is NOT in touchPaths.
    expect(activeEpisodicPathCards(st, ['other'], { maxCards: 2, valueConfig: ENABLED })).toEqual([]);
    const repin = activeEpisodicPathCards(st, ['other'], {
      maxCards: 2,
      valueConfig: { ...ENABLED, repinInactive: true },
    });
    expect(repin.map((c) => c.targetPath)).toEqual(['x']);
  });

  it('selectActiveEpisodicPathCards reports selected touched vs inactive value decisions', () => {
    const st = stateWithZones(
      [
        ['touch', activeZone('touch', { engagementCount: 3, chapterIds: [1, 2], lastEngagedBoundary: 10 })],
        ['idle', activeZone('idle', { engagementCount: 8, chapterIds: [1, 2, 3, 4, 5], lastEngagedBoundary: 10 })],
      ],
      10,
    );
    const selection = selectActiveEpisodicPathCards(st, ['touch'], {
      maxCards: 2,
      valueConfig: { ...ENABLED, repinInactive: true },
    });

    expect(selection.cards.map((c) => c.targetPath)).toEqual(['idle', 'touch']);
    expect(selection.decisions.filter((d) => d.selected).map((d) => [d.targetPath, d.reason])).toEqual([
      ['idle', 'inactive'],
      ['touch', 'touched'],
    ]);
    expect(selection.decisions.every((d) => d.value >= 0 && d.value <= 1)).toBe(true);
  });

  it('selection metadata distinguishes resident-header skips and budget skips', () => {
    const resident = activeZone('resident', { engagementCount: 9, chapterIds: [1, 2, 3, 4, 5], lastEngagedBoundary: 10 });
    const chosen = activeZone('chosen', { engagementCount: 8, chapterIds: [1, 2, 3, 4], lastEngagedBoundary: 10 });
    const budgeted = activeZone('budgeted', { engagementCount: 7, chapterIds: [1, 2, 3], lastEngagedBoundary: 10 });
    const st = stateWithZones(
      [
        ['resident', resident],
        ['chosen', chosen],
        ['budgeted', budgeted],
      ],
      10,
    );
    const selection = selectActiveEpisodicPathCards(st, ['resident', 'chosen', 'budgeted'], {
      maxCards: 1,
      valueConfig: ENABLED,
      excludeHeaderLines: new Set([resident.activeCard!.renderedCard.split('\n')[0]]),
    });

    expect(selection.cards.map((c) => c.targetPath)).toEqual(['chosen']);
    expect(selection.decisions.find((d) => d.targetPath === 'resident')).toMatchObject({
      selected: false,
      skipped: 'resident_header',
    });
    expect(selection.decisions.find((d) => d.targetPath === 'budgeted')).toMatchObject({
      selected: false,
      skipped: 'budget',
    });
  });

  // rail-031677b6 step test-repin-denoiser — the pathless re-pin is gated to rail
  // targets only: a no-touch boundary may re-pin an inactive zone ONLY when it is a
  // current rail target. This is the load-bearing mitigation for re-enabling
  // repinInactive without the relay-wide pin churn that forced its earlier rollback.
  it('rail-target de-noiser: a pathless boundary re-pins ONLY a matching rail target', () => {
    const REPIN: EpisodicValueLedgerConfig = { ...ENABLED, repinInactive: true };
    const hot = (path: string) => stateWithZones(
      [[path, activeZone(path, { engagementCount: 8, chapterIds: [1, 2, 3, 4, 5], lastEngagedBoundary: 0 })]],
      0,
    );

    // MATCHING rail target → the inactive zone is re-pinned. FAILS if the rail-target branch is removed.
    const match = selectActiveEpisodicPathCards(hot('x'), [], {
      maxCards: 2, valueConfig: REPIN, valueContext: { railTargetPaths: new Set(['x']) },
    });
    expect(match.cards.map((c) => c.targetPath)).toEqual(['x']);
    expect(match.decisions.find((d) => d.targetPath === 'x')).toMatchObject({ selected: true, reason: 'inactive' });

    // NON-matching rail target → the same high-value zone stays suppressed on a pathless boundary.
    const miss = selectActiveEpisodicPathCards(hot('x'), [], {
      maxCards: 2, valueConfig: REPIN, valueContext: { railTargetPaths: new Set(['unrelated.ts']) },
    });
    expect(miss.cards).toEqual([]);

    // NO rail target on a pathless boundary → empty early-return (the legacy quiet boundary).
    const none = selectActiveEpisodicPathCards(hot('x'), [], { maxCards: 2, valueConfig: REPIN });
    expect(none.cards).toEqual([]);
  });
});
