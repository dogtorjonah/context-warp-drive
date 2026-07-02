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
    expect(content).toContain('LIVE CURRENT QUESTION');
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
