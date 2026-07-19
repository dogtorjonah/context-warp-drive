import { describe, expect, it } from 'vitest';

import {
  activeEpisodicPathCards,
  buildBranchTrace,
  collectResidentEpisodicHeaders,
  createEpisodicInjectionState,
  EPISODIC_BOOKKEEPING_TOOLS,
  episodicCardHeaderLine,
  episodicCompletedChainPaths,
  episodicServedTermKeys,
  expireEpisodicZones,
  formatChainCard,
  formatWalkPromotionCard,
  isEpisodicBookkeepingTool,
  noteEpisodicInjection,
  reconcileVisibleEpisodicHeaders,
  UNKNOWN_EPISODE_TIME,
  type Episode,
  type EpisodeAnnotation,
  type EpisodicRecallCardLike,
  type TraceStep,
} from '../src/foldEpisodes.ts';
import { deriveEpisodesFromMessages, type EpisodeCaptureIdentity } from '../src/foldEpisodeCapture.ts';
import type { FoldMessage } from '../src/rollingFold.ts';

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
    reconcileVisibleEpisodicHeaders(st, new Set());
    expect(episodicCompletedChainPaths(st)).toEqual([]);
  });
});

describe('episodic served term keys', () => {
  it('exposes only live term-cluster zones, sorted; path zones excluded', () => {
    const st = createEpisodicInjectionState();
    noteEpisodicInjection(st, [
      card({ targetPath: 'term:zeta+alpha', kind: 'term' }),
      card({ targetPath: 'term:beta+gamma', kind: 'term' }),
      card(), // path-keyed chain zone must not leak into term keys
    ]);
    expect(episodicServedTermKeys(st)).toEqual(['term:beta+gamma', 'term:zeta+alpha']);
    expect(episodicServedTermKeys(st)).not.toContain('src/a.ts');
  });

  it('keeps a term key past TTL while its card remains visible, then releases it at POV exit', () => {
    const st = createEpisodicInjectionState();
    noteEpisodicInjection(st, [card({ targetPath: 'term:alpha+beta', kind: 'term' })], 2);
    expect(episodicServedTermKeys(st)).toEqual(['term:alpha+beta']);
    st.boundarySeq = 2;
    expireEpisodicZones(st);
    expect(episodicServedTermKeys(st)).toEqual(['term:alpha+beta']);
    reconcileVisibleEpisodicHeaders(st, new Set());
    expect(episodicServedTermKeys(st)).toEqual([]);
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
    expect(lines[2]).toBe('  members: src/a.ts*×3, src/b.ts');
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

describe('formatChainCard lineage filtering', () => {
  it('can suppress peer-lineage chapters while preserving own-lineage memory', () => {
    const own = makeEpisode({
      endedAt: '2026-06-11T13:00:00.000Z',
      summary: 'mine',
      instanceId: 'me',
    });
    const peer = makeEpisode({
      endedAt: '2026-06-11T14:00:00.000Z',
      summary: 'theirs',
      instanceId: 'other-lineage',
    });
    const opts = { ownLineage: new Set(['me']), fullPreviousCount: 1, charBudget: 4_000 };

    const defaultCard = formatChainCard([own, peer], 'src/shared.ts', [], opts);
    expect(defaultCard).toContain('theirs');
    expect(defaultCard).toContain('peer lineage');

    const ownOnlyCard = formatChainCard([own, peer], 'src/shared.ts', [], { ...opts, selfLineageOnly: true });
    expect(ownOnlyCard).toContain('mine');
    expect(ownOnlyCard).not.toContain('theirs');
    expect(ownOnlyCard).not.toContain('peer lineage');
    expect(formatChainCard([peer], 'src/shared.ts', [], { ...opts, selfLineageOnly: true })).toBe('');
  });
});

describe('episodic card richness', () => {
  it('keeps decisive middle evidence while bounding the trace', () => {
    const steps: TraceStep[] = Array.from({ length: 18 }, (_, index) => ({
      tool: 'Read',
      target: `long-investigation-file-${String(index).padStart(2, '0')}.ts`,
      ...(index === 9
        ? { result: 'foldRecall.ts:417 root cause: resident headers matched unrelated card bodies' }
        : {}),
    }));
    const trace = buildBranchTrace(steps, 240);

    expect(trace.length).toBeLessThanOrEqual(240);
    expect(trace).toContain('long-investigation-file-00.ts');
    expect(trace).toContain('long-investigation-file-17.ts');
    expect(trace).toContain('root cause: resident headers matched unrelated card bodies');
  });

  it('counts omitted actions rather than collapsed trace tokens', () => {
    const trace = buildBranchTrace([
      { tool: 'Read', target: 'first.ts' },
      ...Array.from({ length: 10 }, () => ({ tool: 'Read', target: 'noise.ts' })),
      { tool: 'Read', target: 'middle.ts', result: 'root cause: decisive finding' },
      { tool: 'Edit', target: 'last.ts' },
    ], 120);

    expect(trace.length).toBeLessThanOrEqual(120);
    expect(trace).toContain('⟨10 steps⟩');
    expect(trace).toContain('first.ts');
    expect(trace).toContain('root cause: decisive finding');
    expect(trace).toContain('last.ts');
  });

  it('honors zero and tiny trace caps', () => {
    const step = [{ tool: 'Read', target: 'long-file-name.ts', result: 'root cause: decisive finding' }];
    expect(buildBranchTrace(step, 0)).toBe('');
    expect(buildBranchTrace(step, 6).length).toBeLessThanOrEqual(6);
  });

  it('renders a bounded hot-first member list with touch counts', () => {
    const episode = makeEpisode({
      endedAt: '2026-06-11T13:00:00.000Z',
      members: [
        { path: 'src/cold-a.ts', touchKind: 'read', touchCount: 1, firstSeen: 1, lastSeen: 1 },
        { path: 'src/hot.ts', touchKind: 'edit', touchCount: 9, firstSeen: 2, lastSeen: 20 },
        { path: 'src/warm.ts', touchKind: 'read', touchCount: 4, firstSeen: 3, lastSeen: 18 },
        { path: 'src/cold-b.ts', touchKind: 'read', touchCount: 1, firstSeen: 4, lastSeen: 4 },
        { path: 'src/cold-c.ts', touchKind: 'read', touchCount: 1, firstSeen: 5, lastSeen: 5 },
        { path: 'src/cold-d.ts', touchKind: 'read', touchCount: 1, firstSeen: 6, lastSeen: 6 },
      ],
    });
    const members = formatChainCard([episode], 'src/hot.ts', []).split('\n')[1];

    expect(members).toBe(
      '  members: src/hot.ts*×9, src/warm.ts×4, src/cold-a.ts, src/cold-b.ts, src/cold-c.ts (+1)',
    );
  });

  it('hard-bounds rich chain and walk cards while retaining evidence and the pointer', () => {
    const longPath = (letter: string): string => `src/${letter.repeat(260)}.ts`;
    const episode = makeEpisode({
      endedAt: '2026-06-11T13:00:00.000Z',
      summary: 's'.repeat(120),
      intent: 'i'.repeat(200),
      members: ['a', 'b', 'c', 'd', 'e'].map((letter, index) => ({
        path: longPath(letter),
        touchKind: index === 0 ? 'edit' as const : 'read' as const,
        touchCount: 9 - index,
        firstSeen: index,
        lastSeen: 10 - index,
      })),
      trace: `Read(a.ts) ⇢ "${'e'.repeat(96)}"`,
      annotations: [
        annotation('2026-06-11T12:30:00.000Z', 'star:gotcha', 'g'.repeat(200)),
        annotation('2026-06-11T12:31:00.000Z', 'star:decision', 'd'.repeat(200)),
      ],
    });

    const chain = formatChainCard([episode], longPath('a'), []);
    expect(chain.length).toBeLessThanOrEqual(1_600);
    expect(chain).toContain('⇢');
    expect(chain.split('\n').at(-1)).toMatch(/^  ⌖ verbatim:/);

    const walk = formatWalkPromotionCard(episode, { index: 1, total: 1 }, [], { charBudget: 500 });
    expect(walk.length).toBeLessThanOrEqual(500);
    expect(walk).toContain('⇢');
    expect(walk.split('\n').at(-1)).toMatch(/^  ⌖ verbatim:/);
  });
});

describe('operator intent (Episode.intent)', () => {
  const identity: EpisodeCaptureIdentity = {
    workspace: 'context-warp-drive',
    instanceId: 'inst-1',
    closedBy: 'epoch',
    nowIso: '2026-06-18T20:00:00.000Z',
  };
  const userAsk = (text: string): FoldMessage => ({ role: 'user', content: text });
  const editCall = (id: string, file: string): FoldMessage =>
    ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file } }] });
  const readCall = (id: string, file: string): FoldMessage =>
    ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] });
  const toolResult = (id: string, content: unknown = 'ok'): FoldMessage =>
    ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] });
  const hostSyntheticContext = {
    leadingBlocks: [
      { prefix: '[Host Time]', mode: 'line-or-paragraph' },
      { prefix: '[Host Memory]', end: '[END Host Memory]', mode: 'paired' },
      { prefix: '[Host Digest', end: '[END Host Digest]', mode: 'paired' },
      { prefix: '[Host Thread]', end: '[END Host Thread]', mode: 'paired' },
      { prefix: '[Host Signals]', end: '[END Host Signals]', mode: 'paired' },
      { prefix: '[Host Note:', mode: 'bracketed' },
    ],
    wholeTextMatchers: [
      (text: string) => text.startsWith('[Host Continuity]')
        || /^package_version:\s*\d+\n\[Host Continuity\]/.test(text),
    ],
  } as const;
  const hostResumeWrapper = `[Host Time] Session age: 4h 3m

[Host Note: Context pressure limits were reached during your execution.
Your context has been successfully folded for efficiency.
Please seamlessly continue your previous turn from where you were interrupted.
Do not repeat your prior output; simply resume your sentence, tool call, or task directly.]

[User Message Vault]
Synthetic host continuity note.

[operator message @ 2026-06-18 20:00]
Ok do that for both standalone repo and the host app please
[/User Message Vault]`;
  const fullHostResumeWrapper = `[Host Time] Session age: 4h 3m

[Host Memory]
Nearby codebase context from recent language:
- src/voiceRecording.ts - Voice recording capture pipeline (high; fts)
[END Host Memory]

[Host Digest seq 26-68]
  * peer-agent: touched src/foldSummary.ts
[END Host Digest]

[Host Thread]
  peer-agent in #fold-repair
[END Host Thread]

[Host Signals]
#result peer landed a related change
[END Host Signals]

[Host Note: Context pressure limits were reached during your execution.
Your context has been successfully folded for efficiency.
Please seamlessly continue your previous turn from where you were interrupted.
Do not repeat your prior output; simply resume your sentence, tool call, or task directly.]

[User Message Vault]
Synthetic host continuity note.

[operator message @ 2026-06-18 20:00]
Ok do that for both standalone repo and the host app please
[/User Message Vault]`;
  const hostContinuityPackage = `[Host Time] Session age: 2h 6m

[Host Digest seq 514-529]
  * peer-agent: touched src/foldSummary.ts
[END Host Digest]

package_version: 5
[Host Continuity] You are the continuation of "agent". Read Last User + AI Messages first, then Current Thread.

── Current Thread ──
👤 USER (active request):
Make your fixes`;

  it('mines the nearest genuine operator ask onto the burst it drove', () => {
    const ask = 'Fix the recall ranker so cold zones keep directory proximity';
    const messages: FoldMessage[] = [
      userAsk(ask),
      editCall('t1', 'src/foldRecall.ts'),
      toolResult('t1'),
      readCall('t2', 'src/foldRecall.test.ts'),
      toolResult('t2'),
    ];
    const { episodes } = deriveEpisodesFromMessages(messages, 0, identity, { sealTrailing: true });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].intent).toBe(ask);
  });

  it('skips tool_result carriers (role:user, no genuine text) and finds the real ask behind them', () => {
    const ask = 'Refactor the episode store to denormalize at write';
    const messages: FoldMessage[] = [
      userAsk(ask),
      toolResult('stale'), // role:user but tool_result-only → not an operator ask
      editCall('t1', 'src/store.ts'),
      toolResult('t1'),
    ];
    const { episodes } = deriveEpisodesFromMessages(messages, 0, identity, { sealTrailing: true });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].intent).toBe(ask);
  });

  it('leaves intent undefined for an agent-initiated burst with no preceding operator message', () => {
    const messages: FoldMessage[] = [
      editCall('t1', 'src/x.ts'),
      toolResult('t1'),
    ];
    const { episodes } = deriveEpisodesFromMessages(messages, 0, identity, { sealTrailing: true });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].intent).toBeUndefined();
  });

  it('uses FoldMessage.tsMs as source time without aligned timestamp options', () => {
    const sourceTime = '2026-06-18T19:30:00.000Z';
    const messages: FoldMessage[] = [
      { ...editCall('t1', 'src/source-time.ts'), tsMs: Date.parse(sourceTime) },
      toolResult('t1'),
    ];
    const { episodes } = deriveEpisodesFromMessages(messages, 0, identity, { sealTrailing: true });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].startedAt).toBe(sourceTime);
    expect(episodes[0].endedAt).toBe(sourceTime);
    expect(episodes[0].endedAt).not.toBe(identity.nowIso);
  });

  it('renders missing source time explicitly instead of substituting nowIso', () => {
    const messages: FoldMessage[] = [editCall('t1', 'src/timeless.ts'), toolResult('t1')];
    const { episodes } = deriveEpisodesFromMessages(messages, 0, identity, { sealTrailing: true });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].startedAt).toBe(UNKNOWN_EPISODE_TIME);
    expect(episodes[0].endedAt).toBe(UNKNOWN_EPISODE_TIME);
    const rendered = formatChainCard(episodes, 'src/timeless.ts', []);
    expect(rendered).toContain('time unknown');
    expect(rendered).not.toContain(identity.nowIso);
  });

  it('does not copy a known start timestamp into an unknown burst endpoint', () => {
    const sourceTime = '2026-06-18T19:30:00.000Z';
    const messages: FoldMessage[] = [
      { ...editCall('t1', 'src/partial.ts'), tsMs: Date.parse(sourceTime) },
      toolResult('t1'),
      editCall('t2', 'src/partial.ts'),
      toolResult('t2'),
    ];
    const { episodes } = deriveEpisodesFromMessages(messages, 0, identity, { sealTrailing: true });
    expect(episodes[0].startedAt).toBe(sourceTime);
    expect(episodes[0].endedAt).toBe(UNKNOWN_EPISODE_TIME);
  });

  it('strips host resume wrappers before choosing the operator intent when supplied', () => {
    const ask = 'Patch the intent miner so wrappers do not become the ask';
    const messages: FoldMessage[] = [
      userAsk(`${hostResumeWrapper}\n\n${ask}`),
      editCall('t1', 'src/foldEpisodeCapture.ts'),
      toolResult('t1'),
    ];
    const { episodes } = deriveEpisodesFromMessages(messages, 0, identity, { sealTrailing: true, syntheticContext: hostSyntheticContext });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].intent).toBe(ask);
  });

  it('strips the full resumed-turn envelope before choosing the operator intent', () => {
    const ask = 'Patch the intent miner so wrapper stacks do not become the ask';
    const messages: FoldMessage[] = [
      userAsk(`${fullHostResumeWrapper}\n\n${ask}`),
      editCall('t1', 'src/foldEpisodeCapture.ts'),
      toolResult('t1'),
    ];
    const { episodes } = deriveEpisodesFromMessages(messages, 0, identity, { sealTrailing: true, syntheticContext: hostSyntheticContext });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].intent).toBe(ask);
  });

  it('leaves intent undefined when only host resume wrappers precede a burst', () => {
    const messages: FoldMessage[] = [
      userAsk(hostResumeWrapper),
      editCall('t1', 'src/foldEpisodeCapture.ts'),
      toolResult('t1'),
    ];
    const { episodes } = deriveEpisodesFromMessages(messages, 0, identity, { sealTrailing: true, syntheticContext: hostSyntheticContext });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].intent).toBeUndefined();
  });

  it('leaves intent undefined at a host continuity boundary when supplied', () => {
    const messages: FoldMessage[] = [
      userAsk(hostContinuityPackage),
      editCall('t1', 'src/rollingFold.ts'),
      toolResult('t1'),
    ];
    const { episodes } = deriveEpisodesFromMessages(messages, 0, identity, { sealTrailing: true, syntheticContext: hostSyntheticContext });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].intent).toBeUndefined();
  });

  it('anchors a genuine post-continuity ask, not the preceding host package', () => {
    const ask = 'Now add the host-continuity regression tests';
    const messages: FoldMessage[] = [
      userAsk(hostContinuityPackage),
      userAsk(ask),
      editCall('t1', 'test/foldEpisodes.test.ts'),
      toolResult('t1'),
    ];
    const { episodes } = deriveEpisodesFromMessages(messages, 0, identity, { sealTrailing: true, syntheticContext: hostSyntheticContext });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].intent).toBe(ask);
  });

  it('captures bounded process voice from substantive investigation bursts', () => {
    const combined = (id: string, file: string, text: string): FoldMessage => ({
      role: 'assistant',
      content: [
        { type: 'text', text },
        { type: 'tool_use', id, name: 'Read', input: { file_path: file } },
      ],
    });
    const messages: FoldMessage[] = [
      combined('p1', 'src/foldEpisodeCapture.ts', '🔍 The audit found the key seam between capture and recall dispatch.'),
      toolResult('p1'),
      combined('p2', 'src/foldEpisodes.ts', '▶ I am choosing typed process memory rather than promoting hypotheses to verdicts.'),
      toolResult('p2'),
      combined('p3', 'src/foldRecall.ts', '🔍 I am tracing the recall path through the whole boundary.'),
      toolResult('p3'),
    ];
    const { episodes } = deriveEpisodesFromMessages(messages, 0, identity, { sealTrailing: true });
    const process = episodes[0].annotations.filter((annotation) => annotation.kind.startsWith('process:'));
    expect(process.map((annotation) => annotation.kind)).toEqual(['process:discovery', 'process:decision']);
    expect(process).toHaveLength(2);
  });

  it('carries one decisive tool result into the rendered episode card', () => {
    const messages: FoldMessage[] = [
      readCall('r1', 'src/foldRecall.ts'),
      toolResult('r1', [
        { type: 'text', text: 'ordinary scan prelude' },
        {
          type: 'text',
          text: [
            'src/foldRecall.ts:417 root cause: resident headers matched unrelated card bodies',
            'ordinary scan trailer',
          ].join('\n'),
        },
      ]),
      editCall('e1', 'src/foldRecall.ts'),
      toolResult('e1', 'Done'),
      readCall('r2', 'src/foldEpisodes.ts'),
      toolResult('r2'),
      editCall('e2', 'src/foldRecall.ts'),
      toolResult('e2', 'updated'),
    ];
    const { episodes } = deriveEpisodesFromMessages(messages, 0, identity, { sealTrailing: true });
    const card = formatChainCard(episodes, 'src/foldRecall.ts', [], { charBudget: 600 });

    expect(episodes[0].trace.match(/⇢/g)).toHaveLength(1);
    expect(card).toContain('  members: src/foldRecall.ts*×3, src/foldEpisodes.ts');
    expect(card).toContain('root cause: resident headers matched unrelated card bodies');
    expect(card.length).toBeLessThanOrEqual(600);
  });

  it('rejects synthetic completion reminders as decisive tool evidence', () => {
    const messages: FoldMessage[] = [
      readCall('meta1', 'src/foldEpisodes.ts'),
      toolResult(
        'meta1',
        '[Completion reminder: Post a #result about src/foldEpisodes.ts after validation.]',
      ),
    ];
    const { episodes } = deriveEpisodesFromMessages(messages, 0, identity, { sealTrailing: true });

    expect(episodes).toHaveLength(1);
    expect(episodes[0].trace).toBe('Read(foldEpisodes.ts)');
    expect(episodes[0].trace).not.toContain('⇢');
  });

  it('renders the ask anchor first in the hot chapter when present, byte-identical when absent', () => {
    const base = { endedAt: '2026-06-11T13:00:00.000Z', summary: 'did the work' } as const;
    const withIntent = makeEpisode({ ...base, intent: 'Fix the cold-zone proximity fallback' });
    const withLines = formatChainCard([withIntent], 'src/a.ts', []).split('\n');
    expect(withLines[0]).toBe('[Episode recall src/a.ts — 2026-06-11 13:00, "did the work"]');
    expect(withLines[1]).toBe('  ↳ ask:"Fix the cold-zone proximity fallback"');
    expect(withLines[2]).toBe('  members: src/a.ts*×3, src/b.ts');

    const cardWithout = formatChainCard([makeEpisode(base)], 'src/a.ts', []);
    expect(cardWithout.split('\n')[1]).toBe('  members: src/a.ts*×3, src/b.ts');
    expect(cardWithout).not.toContain('↳ ask');
  });
});
