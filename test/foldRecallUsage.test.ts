import { describe, expect, test } from 'vitest';

import {
  addInjectedFoldRecallUsageCards,
  advanceFoldRecallUsageWatches,
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

    expect(result.events).toEqual([{ episodeId: 101, kind: 'injected', tsMs: 10, cardKind: 'chain' }]);
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
      { touchedPaths: ['/repo/test/memoryLoop.test.ts'] },
      { nowMs: 20 },
    );

    expect(advanced.events).toEqual([{
      episodeId: 101,
      kind: 'path_edited',
      tsMs: 20,
      cardKind: 'chain',
      matchedPath: '/repo/test/memoryLoop.test.ts',
    }]);
    expect(advanced.watches).toEqual([]);
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
    expect(expired.watches).toEqual([]);
  });

  test('serializes undefined recall text as empty bounded text', () => {
    expect(serializeRecallUsageText(undefined)).toBe('');
  });
});
