import { describe, expect, it } from 'vitest';

import {
  createEpisodicInjectionState,
  episodicCompletedChainPaths,
  expireEpisodicZones,
  noteEpisodicInjection,
  type EpisodicRecallCardLike,
} from '../src/foldEpisodes.ts';

function card(overrides: Partial<EpisodicRecallCardLike> = {}): EpisodicRecallCardLike {
  return {
    targetPath: 'src/a.ts',
    renderedCard: 'HOT CHAPTER',
    chapterIds: [10],
    memberPaths: ['src/a.ts'],
    kind: 'chain',
    ...overrides,
  };
}

describe('episodic completed-chain path ledger', () => {
  it('remembers a completed-chain pointer until the live zone expires or a real card reopens it', () => {
    const st = createEpisodicInjectionState();

    st.boundarySeq = 1;
    noteEpisodicInjection(st, [card()], 2);
    noteEpisodicInjection(st, [card({
      renderedCard: 'COMPLETE POINTER',
      chapterIds: [],
      memberPaths: [],
      kind: 'pointer',
    })], 2);
    expect(episodicCompletedChainPaths(st)).toEqual(['src/a.ts']);
    expect(st.zones.get('src/a.ts')?.activeCard?.renderedCard).toBe('HOT CHAPTER');

    st.boundarySeq = 2;
    expireEpisodicZones(st);
    expect(episodicCompletedChainPaths(st)).toEqual(['src/a.ts']);

    noteEpisodicInjection(st, [card({
      renderedCard: 'NEW WALK CHAPTER',
      chapterIds: [11],
      kind: 'walk',
    })], 2);
    expect(episodicCompletedChainPaths(st)).toEqual([]);

    noteEpisodicInjection(st, [card({
      renderedCard: 'COMPLETE POINTER',
      chapterIds: [],
      memberPaths: [],
      kind: 'pointer',
    })], 2);
    st.boundarySeq = 4;
    expireEpisodicZones(st);
    expect(episodicCompletedChainPaths(st)).toEqual([]);
  });
});
