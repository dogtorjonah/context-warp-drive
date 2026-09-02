import { describe, expect, it } from 'vitest';

import { FoldSession, type FoldConfig, type FoldMessage } from '../index.ts';
import {
  buildHardEpochSeedView,
  HARD_EPOCH_CONTINUITY_DIRECTIVE,
  HARD_EPOCH_LIVE_TURN_HEADER,
} from '../foldFreeze.ts';
import { buildFoldIndex } from '../foldRecall.ts';

const SEED = 'REBIRTH PACKAGE SEED BODY — compact continuity packet for the same-instance hard epoch';

const TEST_FOLD_CONFIG: FoldConfig = {
  activeWindowTurns: 0,
  softThresholdChars: 1_000_000,
  hardThresholdChars: 2_000_000,
  maxTurnsBeforeFold: 100,
  continuous: true,
  assistantTextBudget: { fullRetentionChars: 10, essenceRetentionChars: 0 },
  verbatimKeepChars: 0,
};

function bigHistory(): FoldMessage[] {
  return [
    { role: 'user', content: 'old question one' },
    { role: 'assistant', content: 'old answer one '.repeat(50) },
    { role: 'user', content: 'old question two' },
    { role: 'assistant', content: 'old answer two '.repeat(50) },
    { role: 'user', content: 'LIVE CURRENT QUESTION' },
  ];
}

describe('buildFoldIndex — hard-epoch seed recall reconciliation (seedFoldsEntireRaw)', () => {
  it('returns an EMPTY index for a markerless seed without the flag (the legacy gap)', () => {
    const raw = bigHistory();
    const seedView = buildHardEpochSeedView(raw, SEED);
    // The seed is a single user message with NO "[Conversation Context — N
    // turns folded]" marker, so the inter-turn gate stays 0 → empty page table.
    expect(seedView).toHaveLength(1);
    const index = buildFoldIndex(raw, seedView);
    expect(index.entries).toHaveLength(0);
    expect(index.rawCount).toBe(raw.length);
  });

  it('builds a turn entry for every pre-reset turn except the live turn when seedFoldsEntireRaw is set', () => {
    const raw = bigHistory(); // [u,a,u,a,u] → detectTurns → 3 turns
    const seedView = buildHardEpochSeedView(raw, SEED);
    const index = buildFoldIndex(raw, seedView, undefined, {}, { seedFoldsEntireRaw: true });
    // 3 detected turns clamped to all-but-the-live-turn → 2 recall-addressable
    // folded turns (the trailing live turn is never folded out).
    expect(index.entries).toHaveLength(2);
    expect(index.entries.every((e) => e.kind === 'turn')).toBe(true);
    expect(index.rawCount).toBe(raw.length);
  });
});

describe('buildHardEpochSeedView — provider-safe single-message merge', () => {
  it('returns exactly ONE user message (never two consecutive user turns — Anthropic rejects those)', () => {
    const view = buildHardEpochSeedView(bigHistory(), SEED);
    expect(view).toHaveLength(1);
    expect(view[0].role).toBe('user');
  });

  it('uses host authority exactly once when the retained trace has no user row', () => {
    const authorityText = 'LIVE AUTHORITY 771 finish the interrupted migration';
    const view = buildHardEpochSeedView(
      [
        { role: 'assistant', content: 'tool loop result one' },
        { role: 'assistant', content: 'tool loop result two' },
      ],
      SEED,
      {
        text: authorityText,
        sourceEventId: 'turn-live-authority-771',
        sourceAt: '2026-08-02T21:27:00.000Z',
      },
    );
    expect(view).toHaveLength(1);
    const content = view[0].content as string;
    expect(content).toContain(HARD_EPOCH_LIVE_TURN_HEADER);
    expect(content.match(/LIVE AUTHORITY 771 finish the interrupted migration/gu)).toHaveLength(1);
  });

  it('prefers the genuine traced user row over a host fallback', () => {
    const content = buildHardEpochSeedView(bigHistory(), SEED, {
      text: 'STALE HOST FALLBACK MUST NOT WIN',
    })[0].content as string;
    expect(content).toContain('LIVE CURRENT QUESTION');
    expect(content).not.toContain('STALE HOST FALLBACK MUST NOT WIN');
  });

  it('does not append a second copy when canonical v6 already bundles the exact request', () => {
    const authorityText = 'LIVE AUTHORITY 772 preserve this request once';
    const seedWithV6Request = [
      SEED,
      '[EXACT ACTIVE REQUEST · 45 chars · source=turn-live-authority-772 · source-time=unknown · status=known]',
      authorityText,
      '[/EXACT ACTIVE REQUEST]',
    ].join('\n');
    const content = buildHardEpochSeedView(
      [{ role: 'assistant', content: 'tool loop result' }],
      seedWithV6Request,
      { text: authorityText },
    )[0].content as string;

    expect(content.match(/LIVE AUTHORITY 772 preserve this request once/gu)).toHaveLength(1);
    expect(content).not.toContain(HARD_EPOCH_LIVE_TURN_HEADER);
  });

  it('prepends the continuity directive when the host seed omits it', () => {
    const content = buildHardEpochSeedView(bigHistory(), SEED)[0].content as string;
    expect(content.startsWith(`${HARD_EPOCH_CONTINUITY_DIRECTIVE}\n\n${SEED}`)).toBe(true);
    expect(content.split(HARD_EPOCH_CONTINUITY_DIRECTIVE)).toHaveLength(2);
  });

  it('does not duplicate the continuity directive when the seed already carries it', () => {
    const seeded = `${HARD_EPOCH_CONTINUITY_DIRECTIVE}\n\n${SEED}`;
    const content = buildHardEpochSeedView(bigHistory(), seeded)[0].content as string;
    expect(content.startsWith(seeded)).toBe(true);
    expect(content.split(HARD_EPOCH_CONTINUITY_DIRECTIVE)).toHaveLength(2);
  });

  it('still prepends when the host seed only quotes the continuity directive later', () => {
    const quoted = `Host body quotes the directive later:\n${HARD_EPOCH_CONTINUITY_DIRECTIVE}\n\n${SEED}`;
    const content = buildHardEpochSeedView(bigHistory(), quoted)[0].content as string;
    expect(content.startsWith(`${HARD_EPOCH_CONTINUITY_DIRECTIVE}\n\n${quoted}`)).toBe(true);
    expect(content.split(HARD_EPOCH_CONTINUITY_DIRECTIVE)).toHaveLength(3);
  });

  it('merges the live user turn text into the seed body so the current question is never dropped', () => {
    const view = buildHardEpochSeedView(bigHistory(), SEED);
    const content = view[0].content as string;
    expect(content).toContain(SEED);
    expect(content).toContain(HARD_EPOCH_LIVE_TURN_HEADER);
    expect(content).toContain('LIVE CURRENT QUESTION');
    // The old folded-away turns are NOT carried verbatim — they live in the seed's
    // own summary and the host's raw recall backing.
    expect(content).not.toContain('old answer one old answer one');
  });

  it('only merges the trailing CONTIGUOUS run of user turns, stopping at the last assistant', () => {
    const history: FoldMessage[] = [
      { role: 'user', content: 'BURIED USER TURN' },
      { role: 'assistant', content: 'an answer' },
      { role: 'user', content: 'TRAILING QUESTION' },
    ];
    const content = buildHardEpochSeedView(history, SEED)[0].content as string;
    expect(content).toContain('TRAILING QUESTION');
    expect(content).not.toContain('BURIED USER TURN');
  });

  it('omits non-string trailing content (attachments) but still returns the seed alone', () => {
    const history: FoldMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: [{ type: 'image' }] as unknown[] },
    ];
    const view = buildHardEpochSeedView(history, SEED);
    expect(view).toHaveLength(1);
    expect(view[0].content).toBe(`${HARD_EPOCH_CONTINUITY_DIRECTIVE}\n\n${SEED}`);
  });

  it('uses the seed alone when there is no trailing user turn', () => {
    const history: FoldMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ];
    expect(buildHardEpochSeedView(history, SEED)[0].content)
      .toBe(`${HARD_EPOCH_CONTINUITY_DIRECTIVE}\n\n${SEED}`);
  });
});

describe('FoldSession hard-epoch consume', () => {
  function ceilingSession(): FoldSession {
    return new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 150_000 },
      pressureCeiling: 80_000,
      now: () => 1_000,
    });
  }

  it('replaces the whole view with the seed when the ceiling is raw-triggered and a seed is supplied', () => {
    const out = ceilingSession().prepare(bigHistory(), {
      measuredInputTokens: 80_000,
      hardEpochSeed: SEED,
    });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe('user');
    expect(out.cacheHot).toBe(false);
    expect(out.stats.epochReason).toBe('hard-epoch');
    const content = out.messages[0].content as string;
    expect(content).toContain(SEED);
    expect(content).toContain('LIVE CURRENT QUESTION');
  });

  it('computes a local raw hard-epoch seed when no host seed is supplied', () => {
    const out = ceilingSession().prepare(bigHistory(), { measuredInputTokens: 80_000 });
    expect(out.stats.epochReason).toBe('hard-epoch');
    expect(out.messages).toHaveLength(1);
    const content = out.messages[0].content as string;
    expect(content).toContain(HARD_EPOCH_CONTINUITY_DIRECTIVE);
    expect(content).toContain('old question one');
    // v6 raw hard-epoch: the v4 `── Continuity Boundary (RECOVERY COORDINATES) ──`
    // header retired; assert the canonical v6 boundary frame marker exactly once.
    expect(content.match(/\[REBIRTH-V6-SECTION id=boundaryAndActiveTask order=1 chars=/gu)).toHaveLength(1);
    // The live question is carried only by the canonical exact-request block.
    // The provider merge must recognize it and avoid appending a second trailer.
    expect(content).toContain('LIVE CURRENT QUESTION');
    expect(content.match(/\[EXACT ACTIVE REQUEST ·/gu)).toHaveLength(1);
    expect(content).not.toContain(HARD_EPOCH_LIVE_TURN_HEADER);
    // The v4 `captured=...·frontier=...` provenance line migrated to the v6
    // Recovery Index's source/frontier semantics; assert that semantic actually
    // rendered rather than omitting it. For this 5-message fixture the raw tail
    // frontier is event#4 (each of the 5 folded rows is a canonical event and the
    // live turn is the trailing event), with unavailable recoverability because
    // the immutable capture/backing stores are absent here.
    expect(content).toContain('frontier=event#4');
    // The retired v4 `── Continuity Boundary (RECOVERY COORDINATES) ──` header is
    // gone; the v6 raw seed renders the live turn behind the (still-current)
    // HARD_EPOCH_LIVE_TURN_HEADER trailer, which is asserted above.
    expect(content).not.toContain('── Continuity Boundary (RECOVERY COORDINATES) ──');
  });

  it('freezes categorized tap_star waypoints into a local raw hard-epoch seed', () => {
    const messages = [
      { role: 'user', content: 'Choose the continuity seam.' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call_hard_epoch_star',
          name: 'tap_star',
          input: {
            category: 'decision',
            note: 'Freeze intentional waypoints into raw hard epochs.',
          },
        }],
        tsMs: Date.parse('2026-07-18T20:29:00.000Z'),
      },
      { role: 'user', content: 'LIVE STARRED QUESTION' },
    ] as unknown as FoldMessage[];

    const out = ceilingSession().prepare(messages, { measuredInputTokens: 80_000 });
    expect(out.stats.epochReason).toBe('hard-epoch');
    const content = out.messages[0].content as string;
    // v6 raw hard-epoch: the retired v4 `── Starred Moments ... ──` header is
    // gone; the starred waypoint content now lives in the v6 Cognitive Artifacts
    // frame. Assert the frame marker preserving the exact starred decision and
    // source-time/source-id provenance (assertions below), and that the retired
    // header is absent.
    expect(content).toContain('[REBIRTH-V6-SECTION id=cognitiveArtifacts order=5 dir=desc chars=');
    expect(content).toContain('⭐ [decision] Freeze intentional waypoints into raw hard epochs.');
    expect(content).toContain(
      'source-time=2026-07-18T20:29:00.000Z · source-id=call_hard_epoch_star',
    );
    expect(content).not.toContain('── Starred Moments (curated tap_star waypoints; separate from the thought trail) ──');
    expect(content).toContain('LIVE STARRED QUESTION');
  });

  it('does NOT hard-epoch below the ceiling even when a seed is present (seed waits)', () => {
    const out = ceilingSession().prepare(bigHistory(), {
      measuredInputTokens: 1_000,
      hardEpochSeed: SEED,
    });
    expect(out.stats.epochReason).not.toBe('hard-epoch');
    expect(JSON.stringify(out.messages)).not.toContain(SEED);
  });

  it('lets a later host seed replace the local fallback on another over-cap turn', () => {
    const session = ceilingSession();
    // First over-cap prepare with no seed uses the package-local raw fallback.
    const first = session.prepare(bigHistory(), { measuredInputTokens: 80_000 });
    expect(first.stats.epochReason).toBe('hard-epoch');
    expect(JSON.stringify(first.messages)).not.toContain(SEED);
    // Same over-cap level again, now WITH a host seed: the host seed wins.
    const second = session.prepare(bigHistory(), { measuredInputTokens: 80_000, hardEpochSeed: SEED });
    expect(second.messages).toHaveLength(1);
    expect(second.stats.epochReason).toBe('hard-epoch');
    expect(JSON.stringify(second.messages)).toContain(SEED);
  });
});
