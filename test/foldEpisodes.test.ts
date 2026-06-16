import { describe, expect, it } from 'vitest';

import {
  activeEpisodicPathCards,
  collectResidentEpisodicHeaders,
  createEpisodicInjectionState,
  EPISODIC_BOOKKEEPING_TOOLS,
  episodicCardHeaderLine,
  episodicCompletedChainPaths,
  expireEpisodicZones,
  formatWalkPromotionCard,
  isEpisodicBookkeepingTool,
  noteEpisodicInjection,
  type Episode,
  type EpisodeAnnotation,
  type EpisodicRecallCardLike,
} from '../src/foldEpisodes.ts';

function annotation(ts: string, kind: EpisodeAnnotation['kind'], text: string): EpisodeAnnotation {
  return { ts, kind, text };
}

function makeEpisode(overrides: Partial<Episode> & { endedAt: string }): Episode {
  return {
    workspace: 'context-warp-drive',
    instanceId: 'inst-1',
    startedAt: overrides.endedAt,
    closedBy: 'epoch',
    summary: 'a summary',
    members: [
      { path: 'src/a.ts', touchKind: 'edit', touchCount: 3, firstSeen: 10, lastSeen: 40 },
      { path: 'src/b.ts', touchKind: 'read', touchCount: 1, firstSeen: 12, lastSeen: 12 },
    ],
    trace: 'Read(a.ts) -> Edit(a.ts) -> tsc ok',
    annotations: [],
    ...overrides,
  };
}

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

describe('walk breadcrumb rendering', () => {
  it('renders a compact origin anchor when supplied', () => {
    const chapter = makeEpisode({
      endedAt: '2026-06-10T14:30:22.123Z',
      summary: 'current walk chapter',
    });
    const origin = makeEpisode({
      endedAt: '2026-06-01T14:30:22.123Z',
      summary: 'origin decision that explains the invariant',
      members: [{ path: 'src/origin.ts', touchKind: 'edit', touchCount: 1, firstSeen: 1, lastSeen: 9 }],
    });
    const rendered = formatWalkPromotionCard(chapter, { index: 6, total: 12 }, [], {
      spines: [{ chapter: origin, kind: 'origin' }],
    });

    const lines = rendered.split('\n');
    expect(lines[0]).toBe('[Episode recall — walking back, chapter 6/12, 2026-06-10 14:30, "current walk chapter"]');
    expect(lines[1]).toBe(
      '  ↞ origin [T-9d] origin decision that explains the invariant | reopen: inst-1 events 1..9',
    );
    expect(lines[2]).toBe('  members: src/a.ts*, src/b.ts');
  });

  it('keeps the origin reopen pointer when the origin summary truncates', () => {
    const chapter = makeEpisode({
      endedAt: '2026-06-10T14:30:22.123Z',
      summary: 'current walk chapter',
    });
    const origin = makeEpisode({
      endedAt: '2026-06-01T14:30:22.123Z',
      summary: 'origin '.repeat(40),
      members: [{ path: 'src/origin.ts', touchKind: 'edit', touchCount: 1, firstSeen: 1, lastSeen: 9 }],
    });
    const rendered = formatWalkPromotionCard(chapter, { index: 6, total: 12 }, [], {
      spines: [{ chapter: origin, kind: 'origin' }],
    });
    const originLine = rendered.split('\n')[1];

    expect(originLine).toContain('origin origin origin');
    expect(originLine).toContain('…');
    expect(originLine).toHaveLength(180);
    expect(originLine).toMatch(/\| reopen: inst-1 events 1\.\.9$/);
  });

  it('uses annotation prose for degenerate path-list waypoint summaries', () => {
    const chapter = makeEpisode({
      endedAt: '2026-06-10T14:30:22.123Z',
      summary: 'current walk chapter',
    });
    const waypoint = makeEpisode({
      endedAt: '2026-06-09T14:30:22.123Z',
      summary: 'src/foldEpisodes.ts, test/foldEpisodes.test.ts (+5)',
      annotations: [
        annotation('2026-06-09T14:29:00.000Z', 'star:pivot', 'flipped the walk card from a sliding spine to a fixed origin trail'),
      ],
    });
    const rendered = formatWalkPromotionCard(chapter, { index: 6, total: 12 }, [], {
      spines: [{ chapter: waypoint, kind: 'waypoint', backDistance: 4 }],
    });

    expect(rendered).toContain(
      '  ↳ 4 back [T-1d] pivot: flipped the walk card from a sliding spine to a fixed origin trail',
    );
    expect(rendered).not.toContain('src/foldEpisodes.ts, test/foldEpisodes.test.ts');
  });
});

describe('episodic pin idempotency and bookkeeping helpers', () => {
  const PIN_CARD = [
    '[Episode recall src/a.ts — 2026-06-16, "hot summary"]',
    '  members: src/a.ts',
    '  ⌖ verbatim: abc events 1..2',
  ].join('\n');
  const PIN_HEADER = '[Episode recall src/a.ts — 2026-06-16, "hot summary"]';

  it('collects card headers but ignores episodic block wrappers', () => {
    const view = [
      '[Episodic recall — active path pin, 1 hot zone card(s) held while this path stays active]',
      PIN_HEADER,
      '  members: src/a.ts',
      '[Episode chain /repo/x.ts — 12 chapters, walk complete]',
      'ordinary prose mentioning [Episode recall] inline',
    ].join('\n');
    const headers = collectResidentEpisodicHeaders(view);

    expect(headers.has(PIN_HEADER)).toBe(true);
    expect(headers.has('[Episode chain /repo/x.ts — 12 chapters, walk complete]')).toBe(true);
    expect([...headers].some((h) => h.startsWith('[Episodic'))).toBe(false);
  });

  it('skips active pins whose header is already resident', () => {
    const st = createEpisodicInjectionState();
    noteEpisodicInjection(st, [card({ renderedCard: PIN_CARD, kind: 'chain' })]);

    expect(episodicCardHeaderLine(card({ renderedCard: PIN_CARD }))).toBe(PIN_HEADER);
    expect(activeEpisodicPathCards(st, ['src/a.ts'], { excludeHeaderLines: new Set([PIN_HEADER]) })).toEqual([]);
    expect(activeEpisodicPathCards(st, ['src/a.ts'], { excludeHeaderLines: new Set<string>() }).map((c) => c.renderedCard)).toEqual([PIN_CARD]);
  });

  it('classifies pure coordination tools as bookkeeping only', () => {
    for (const tool of EPISODIC_BOOKKEEPING_TOOLS) {
      expect(isEpisodicBookkeepingTool(tool)).toBe(true);
    }
    for (const tool of ['read_file', 'edit_file', 'grep_search', 'glob_files', 'atlas_query']) {
      expect(isEpisodicBookkeepingTool(tool)).toBe(false);
    }
  });
});
