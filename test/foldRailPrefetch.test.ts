import { describe, expect, test } from 'vitest';

import {
  consumeRailPrefetchCache,
  createRailPrefetchCache,
  extractRailPrefetchPaths,
  type RailPrefetchCache,
} from '../src/foldRailPrefetch.ts';
import type { EpisodicRecallCardLike } from '../src/foldEpisodes.ts';

const roots = [
  { name: 'voxxo-swarm', root: '/repo' },
  { name: 'vet-soap', root: '/work/vet-soap' },
];

function card(targetPath = '/repo/src/memoryLoop.ts'): EpisodicRecallCardLike {
  return {
    targetPath,
    renderedCard: `[Episode recall ${targetPath}]\n  members: ${targetPath}\n  trace: task rail prefetch`,
    chapterIds: [101],
    memberPaths: [targetPath],
    kind: 'chain',
  };
}

function cache(overrides: Partial<RailPrefetchCache> = {}): RailPrefetchCache {
  return {
    paths: ['/repo/src/memoryLoop.ts'],
    aliases: { '/repo/src/memoryLoop.ts': ['src/memoryLoop.ts'] },
    cards: [card()],
    createdAtMs: 100,
    ttlMs: 1000,
    ...overrides,
  };
}

describe('fold rail prefetch pure helpers', () => {
  test('extracts step scope before instruction, dedupes, and canonicalizes path tokens', () => {
    const result = extractRailPrefetchPaths(
      {
        scope: './relay/src/fcBaseSession.ts:1120-1520, packages/context-warp/src/foldRailPrefetch.ts',
        instruction: 'Touch relay/src/fcBaseSession.ts again, then update docs/context-folding.md.',
      },
      undefined,
      { cwd: '/repo', roots },
    );

    expect(result.rawPaths).toEqual([
      'relay/src/fcBaseSession.ts',
      'packages/context-warp/src/foldRailPrefetch.ts',
      'docs/context-folding.md',
    ]);
    expect(result.paths).toEqual([
      '/repo/relay/src/fcBaseSession.ts',
      '/repo/packages/context-warp/src/foldRailPrefetch.ts',
      '/repo/docs/context-folding.md',
    ]);
    expect(result.aliases['/repo/relay/src/fcBaseSession.ts']).toContain('relay/src/fcBaseSession.ts');
  });

  test('roots relative predictions in an explicit workspace when provided', () => {
    const result = extractRailPrefetchPaths(
      { instruction: 'Patch src/lib/x.ts and test/src/lib/x.test.ts.' },
      'vet-soap',
      { cwd: '/repo', roots },
    );

    expect(result.paths).toEqual([
      '/work/vet-soap/src/lib/x.ts',
      '/work/vet-soap/test/src/lib/x.test.ts',
    ]);
    expect(result.aliases['/work/vet-soap/src/lib/x.ts']).toContain('src/lib/x.ts');
  });

  test('promotes a pending cache once, only when a later real touch confirms a path before TTL', () => {
    const pending = createRailPrefetchCache({
      paths: ['/repo/src/memoryLoop.ts'],
      aliases: { '/repo/src/memoryLoop.ts': ['src/memoryLoop.ts'] },
      cards: [card()],
      createdAtMs: 100,
      ttlMs: 1000,
    });
    expect(pending).not.toBeNull();

    const miss = consumeRailPrefetchCache(pending, ['/repo/src/other.ts'], 200);
    expect(miss.cards).toEqual([]);
    expect(miss.cache).toBe(pending);

    const hit = consumeRailPrefetchCache(miss.cache, ['src/memoryLoop.ts'], 300);
    expect(hit.cards).toHaveLength(1);
    expect(hit.matchedPath).toBe('src/memoryLoop.ts');
    expect(hit.cache).toBeNull();

    const second = consumeRailPrefetchCache(hit.cache, ['/repo/src/memoryLoop.ts'], 400);
    expect(second.cards).toEqual([]);
  });

  test('discards unconfirmed staged cards after TTL', () => {
    const expired = consumeRailPrefetchCache(cache(), ['/repo/src/memoryLoop.ts'], 1200);

    expect(expired.expired).toBe(true);
    expect(expired.cards).toEqual([]);
    expect(expired.cache).toBeNull();
  });
});
