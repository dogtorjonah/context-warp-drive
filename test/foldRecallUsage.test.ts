import { describe, expect, test } from 'vitest';

import {
  addInjectedFoldRecallUsageCards,
  advanceFoldRecallUsageWatches,
  rankFoldRecallUtility,
  serializeRecallUsageText,
  type FoldRecallUsageCardInput,
} from '../src/foldRecallUsage.ts';

function card(overrides: Partial<FoldRecallUsageCardInput> = {}): FoldRecallUsageCardInput {
  return {
    targetPath: '/repo/src/memoryLoop.ts',
    renderedCard: [
      '[Episode recall /repo/src/memoryLoop.ts — 2026-07-01, "utility detector"]',
      '  members: /repo/src/memoryLoop.ts, /repo/test/memoryLoop.test.ts',
      '  trace: Edit(memoryLoop.ts) → vitest(memoryLoop.test.ts)',
      '  🗣 agent:"boundary auction keeps recall utility capture deterministic"',
      '  ⌖ verbatim: agent-1 events 12..18',
    ].join('\n'),
    chapterIds: [101],
    memberPaths: ['/repo/src/memoryLoop.ts', '/repo/test/memoryLoop.test.ts'],
    kind: 'chain',
    ...overrides,
  };
}

describe('fold recall usage detector', () => {
  test('adds exposure events and bounded watches for injected cards', () => {
    const result = addInjectedFoldRecallUsageCards([], [card()], 3, { nowMs: 10 });

    expect(result.events).toEqual([expect.objectContaining({
      episodeId: 101,
      kind: 'injected',
      outcome: 'exposed',
      boundarySeq: 3,
      tsMs: 10,
      cardKind: 'chain',
    })]);
    expect(result.events[0].correlationId).toBe(result.watches[0].correlationId);
    expect(result.watches).toHaveLength(1);
    expect(result.watches[0].expiresAtBoundary).toBe(9);
    expect(result.watches[0].verbatimKeys).toContain('agent-1 events 12..18');
    expect(result.watches[0].verbatimKeys).toContain('events 12..18');
    expect(result.watches[0].terms).toContain('boundary');
  });

  test('detects member-path reuse on a later boundary and removes the watch', () => {
    const added = addInjectedFoldRecallUsageCards([], [card()], 3, { nowMs: 10 });
    const advanced = advanceFoldRecallUsageWatches(
      added.watches,
      4,
      {
        touchedPaths: ['/repo/test/memoryLoop.test.ts'],
        editedPaths: ['/repo/test/memoryLoop.test.ts'],
      },
      { nowMs: 20 },
    );

    expect(advanced.events).toEqual([{
      correlationId: added.watches[0].correlationId,
      episodeId: 101,
      kind: 'path_edited',
      outcome: 'useful',
      boundarySeq: 4,
      tsMs: 20,
      cardKind: 'chain',
      targetPath: '/repo/src/memoryLoop.ts',
      matchedPath: '/repo/test/memoryLoop.test.ts',
    }]);
    expect(advanced.watches).toEqual([]);
  });

  test('treats a utility read as activity but not as a successful path edit', () => {
    const added = addInjectedFoldRecallUsageCards([], [card()], 3, { nowMs: 10 });
    const read = advanceFoldRecallUsageWatches(
      added.watches,
      4,
      { touchedPaths: ['/repo/src/memoryLoop.ts'], editedPaths: [] },
      { nowMs: 20 },
    );

    expect(read.events).toEqual([]);
    expect(read.watches).toHaveLength(1);
    expect(read.watches[0].unmatchedActivityBoundaries).toBe(1);
  });

  test('detects verbatim pointer reuse in later tool args or assistant text', () => {
    const added = addInjectedFoldRecallUsageCards([], [card()], 3, { nowMs: 10 });
    const advanced = advanceFoldRecallUsageWatches(
      added.watches,
      5,
      { toolArgsText: serializeRecallUsageText({ note: 'please inspect events 12..18 next' }) },
      { nowMs: 30 },
    );

    expect(advanced.events.map((event) => event.kind)).toEqual(['verbatim_reused']);
    expect(advanced.watches).toEqual([]);
  });

  test('requires at least two distinctive echoed card terms in assistant text', () => {
    const added = addInjectedFoldRecallUsageCards([], [card()], 3, { nowMs: 10 });
    const oneTerm = advanceFoldRecallUsageWatches(
      added.watches,
      4,
      { assistantText: 'The boundary looks good.' },
      { nowMs: 20 },
    );
    expect(oneTerm.events).toEqual([]);
    expect(oneTerm.watches).toHaveLength(1);

    const twoTerms = advanceFoldRecallUsageWatches(
      oneTerm.watches,
      5,
      { assistantText: 'The boundary auction capture stays deterministic.' },
      { nowMs: 30 },
    );
    expect(twoTerms.events.map((event) => event.kind)).toEqual(['term_echo']);
    expect(twoTerms.watches).toEqual([]);
  });

  test('expires watches after the six-boundary terminal window', () => {
    const added = addInjectedFoldRecallUsageCards([], [card()], 3, { nowMs: 10 });
    const stillOpen = advanceFoldRecallUsageWatches(added.watches, 9, {}, { nowMs: 20 });
    expect(stillOpen.events).toEqual([]);
    expect(stillOpen.watches).toHaveLength(1);

    const expired = advanceFoldRecallUsageWatches(stillOpen.watches, 10, {}, { nowMs: 30 });
    expect(expired.events.map((event) => event.kind)).toEqual(['expired']);
    expect(expired.events[0]).toMatchObject({ outcome: 'ignored', boundarySeq: 10 });
    expect(expired.events[0].falsePositiveProxy).toBeUndefined();
    expect(expired.watches).toEqual([]);
  });

  test('deduplicates one exposure while preserving a fresh later-boundary exposure', () => {
    const duplicate = card({ chapterIds: [101, 101] });
    const first = addInjectedFoldRecallUsageCards([], [duplicate, duplicate], 3, { nowMs: 10 });
    expect(first.events).toHaveLength(1);
    expect(first.watches).toHaveLength(1);

    const repeatedSameBoundary = addInjectedFoldRecallUsageCards(first.watches, [duplicate], 3, { nowMs: 20 });
    expect(repeatedSameBoundary.events).toEqual([]);
    expect(repeatedSameBoundary.watches).toHaveLength(1);

    const laterExposure = addInjectedFoldRecallUsageCards(first.watches, [duplicate], 4, { nowMs: 30 });
    expect(laterExposure.events).toHaveLength(1);
    expect(laterExposure.watches).toHaveLength(2);
    expect(laterExposure.events[0].correlationId).not.toBe(first.events[0].correlationId);
  });

  test('marks expiry after unrelated activity as a false-positive proxy and labels ranks observational', () => {
    const irrelevant = card({
      targetPath: '/repo/src/irrelevant.ts',
      memberPaths: ['/repo/src/irrelevant.ts'],
      chapterIds: [202],
    });
    const added = addInjectedFoldRecallUsageCards([], [card(), irrelevant], 3, { nowMs: 10 });
    const used = advanceFoldRecallUsageWatches(
      added.watches,
      4,
      {
        touchedPaths: ['/repo/src/memoryLoop.ts'],
        editedPaths: ['/repo/src/memoryLoop.ts'],
      },
      { nowMs: 20 },
    );
    const expired = advanceFoldRecallUsageWatches(used.watches, 10, {}, { nowMs: 30 });
    expect(expired.events[0]).toMatchObject({
      episodeId: 202,
      kind: 'expired',
      outcome: 'ignored',
      falsePositiveProxy: true,
    });

    const allEvents = [...added.events, ...used.events, ...expired.events];
    const ranked = rankFoldRecallUtility([...allEvents, ...allEvents]);
    expect(ranked).toEqual([
      {
        evidence: 'observational_proxy',
        episodeId: 101,
        exposures: 1,
        usefulOutcomes: 1,
        ignoredOutcomes: 0,
        falsePositiveProxies: 0,
        observationalProxy: 1,
      },
      {
        evidence: 'observational_proxy',
        episodeId: 202,
        exposures: 1,
        usefulOutcomes: 0,
        ignoredOutcomes: 1,
        falsePositiveProxies: 1,
        observationalProxy: null,
      },
    ]);
  });

  test('serializes undefined recall text as empty bounded text', () => {
    expect(serializeRecallUsageText(undefined)).toBe('');
  });
});
