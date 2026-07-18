import { beforeEach, describe, expect, test, vi } from 'vitest';

const recallEpisodeCards = vi.hoisted(() => vi.fn());

vi.mock('../src/episodes/episodeStore.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/episodes/episodeStore.ts')>()),
  recallEpisodeCards,
}));

import { EpisodeRuntime } from '../src/episodes/runtime.ts';
import type { EpisodeDatabase, EpisodeRecallCard } from '../src/episodes/episodeStore.ts';

function card(
  episodeId: string,
  matchedPaths: readonly string[],
  text: string,
): EpisodeRecallCard {
  return { episodeId, matchedPaths, text };
}

describe('EpisodeRuntime lifetime candidate ranking', () => {
  beforeEach(() => {
    recallEpisodeCards.mockReset();
  });

  test('ranks the complete candidate population before applying a one-card render limit', () => {
    const oldSpecific = card('old-specific', ['src/a.ts', 'src/b.ts'], 'old but exact two-path match');
    const newerPartial = Array.from(
      { length: 10 },
      (_, index) => card(`newer-${index}`, ['src/a.ts'], `newer partial match ${index}`),
    );
    recallEpisodeCards.mockReturnValue([...newerPartial, oldSpecific]);

    const runtime = new EpisodeRuntime({} as EpisodeDatabase, { maxCoalescedChapters: 1 });
    const result = runtime.recallCards(['src/a.ts', 'src/b.ts']);

    expect(recallEpisodeCards).toHaveBeenCalledWith(expect.anything(), {
      paths: ['src/a.ts', 'src/b.ts'],
      excludeEpisodeIds: [],
    });
    expect(result.cards).toEqual([oldSpecific]);
    expect(result.state.servedEpisodeIds).toEqual(['old-specific']);
  });
});
