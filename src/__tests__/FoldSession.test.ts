import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FoldSession,
  FOLD_TOMBSTONE_PREFIX,
  USER_MESSAGE_VAULT_LIVE_MARKER,
  dedupeCoordinateClosetText,
  extractCoordinateConservationCorpus,
  type FoldConfig,
  type FoldMessage,
} from '../index.ts';

// This suite pins FoldSession's legacy skeleton/freeze contracts. Artifact-mode
// rendering has its own dedicated battery; opt into it only in tests that are
// specifically about the artifact/vault interaction.
beforeEach(() => vi.stubEnv('VOXXO_FOLD_ARTIFACT_ONLY', '0'));
afterEach(() => vi.unstubAllEnvs());

const TEST_FOLD_CONFIG: FoldConfig = {
  activeWindowTurns: 0,
  softThresholdChars: 1_000_000,
  hardThresholdChars: 2_000_000,
  maxTurnsBeforeFold: 100,
  continuous: true,
  assistantTextBudget: {
    fullRetentionChars: 10,
    essenceRetentionChars: 0,
  },
  verbatimKeepChars: 0,
};

function twoTurnHistory(firstAssistantText = 'alpha beta gamma'): FoldMessage[] {
  return [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: firstAssistantText },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'second answer stays active' },
  ];
}

function appendTurn(history: FoldMessage[], text: string): FoldMessage[] {
  return [
    ...history,
    { role: 'user', content: `next ${text}` },
    { role: 'assistant', content: `answer ${text}` },
  ];
}

function profitableTail(label: string): string {
  return `${label} ${'compressible tail detail '.repeat(300)}`;
}

function appendProfitableTail(history: FoldMessage[], label: string): FoldMessage[] {
  let next = history;
  for (let index = 0; index < 3; index += 1) {
    next = appendTurn(next, profitableTail(`${label} ${index}`));
  }
  return next;
}

function multiTurnHistory(count: number): FoldMessage[] {
  const messages: FoldMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    messages.push(
      { role: 'user', content: `inspect package module ${i}` },
      { role: 'assistant', content: `module ${i} detail survives until evicted STANDALONE_NOTE_${i}` },
    );
  }
  return messages;
}

function anthropicToolUse(id: string, path: string): FoldMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: `reading ${path}` },
      { type: 'tool_use', id, name: 'Read', input: { file_path: path } },
    ],
  };
}

function anthropicToolResult(id: string, content: string): FoldMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }],
  };
}

function hybridMarathonHistory(): FoldMessage[] {
  const messages: FoldMessage[] = [
    { role: 'user', content: 'old turn 0' },
    { role: 'assistant', content: `old analysis 0 ${'A'.repeat(20_000)}` },
    { role: 'user', content: 'old turn 1' },
    { role: 'assistant', content: `old analysis 1 ${'B'.repeat(20_000)}` },
    { role: 'user', content: 'active kickoff: keep grinding through the package rail' },
  ];

  for (let i = 0; i < 28; i += 1) {
    const id = `toolu_package_active_${i}`;
    messages.push(
      anthropicToolUse(id, `/home/jonah/context-warp-drive/src/file_${i}.ts`),
      anthropicToolResult(id, `ACTIVE_STEP_${i}_FULL_PAYLOAD\n${'X'.repeat(5_000)}`),
    );
  }

  return messages;
}

function appendAssistantLedToolTail(history: FoldMessage[], count: number): FoldMessage[] {
  const messages = [...history];
  for (let i = 0; i < count; i += 1) {
    const id = `toolu_orphan_tail_${i}`;
    messages.push(
      anthropicToolUse(id, `/home/jonah/context-warp-drive/src/orphan_${i}.ts`),
      anthropicToolResult(id, `${'x'.repeat(5_000)}\nORPHAN_DEEP_TOKEN_${i}`),
    );
  }
  return messages;
}

describe('FoldSession fidelity overrides', () => {
  it('applies per-turn fidelity to the epoch fold config', () => {
    const withoutOverride = new FoldSession({ foldConfig: TEST_FOLD_CONFIG, freeze: false });
    const defaultOutcome = withoutOverride.prepare(twoTurnHistory());
    expect(defaultOutcome.appliedFidelity).toBeNull();
    expect(defaultOutcome.result?.foldSummaries[0]?.retained ?? '').not.toContain('alpha beta gamma');

    const withOverride = new FoldSession({ foldConfig: TEST_FOLD_CONFIG, freeze: false });
    const widenedOutcome = withOverride.prepare(twoTurnHistory(), {
      fidelity: {
        fullRetentionFraction: 0.25,
        essenceRetentionFraction: 0,
      },
    });

    expect(widenedOutcome.appliedFidelity).toEqual({
      fullRetentionFraction: 0.25,
      essenceRetentionFraction: 0,
    });
    expect(widenedOutcome.result?.foldSummaries[0]?.retained).toContain('alpha beta gamma');
  });

  it('reports the already-applied fidelity during hot reuse without mutating the frozen view', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 150_000 },
      now: () => 1_000,
    });
    const history = twoTurnHistory();

    const epoch = session.prepare(history, {
      fidelity: {
        fullRetentionFraction: 0.25,
        essenceRetentionFraction: 0,
      },
    });
    const hot = session.prepare(history, {
      fidelity: {
        fullRetentionFraction: 0.125,
        essenceRetentionFraction: 0,
      },
    });

    expect(epoch.cacheHot).toBe(false);
    expect(hot.cacheHot).toBe(true);
    expect(hot.messages).toEqual(epoch.messages);
    expect(hot.appliedFidelity).toEqual({
      fullRetentionFraction: 0.25,
      essenceRetentionFraction: 0,
    });
  });
});

describe('FoldSession marathon pressure folding', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it('folds old real turns and the oversized active turn in one prepare epoch', () => {
    // Asserts the LEGACY flat-closet seed section — restored via the
    // VOXXO_REBIRTH_FLAT_CLOSET kill-switch (default off = inline placement).
    vi.stubEnv('VOXXO_REBIRTH_FLAT_CLOSET', '1');
    const session = new FoldSession({
      foldConfig: {
        ...TEST_FOLD_CONFIG,
        activeWindowTurns: 1,
        assistantTextBudget: { fullRetentionChars: 6_000, essenceRetentionChars: 0 },
      },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 150_000 },
      pressureCeiling: 80_000,
      // Leave enough package room for both the expanded authoritative live-state
      // receipt and the legacy flat closet this test explicitly opts into.
      rawHardEpochSeedMaxChars: 16_000,
      now: () => 1_000,
    });
    const raw = hybridMarathonHistory();

    const prepared = session.prepare(raw, { measuredInputTokens: 80_000 });

    expect(prepared.cacheHot).toBe(false);
    expect(prepared.stats.epochReason).toBe('hard-epoch');
    expect(prepared.messages).toHaveLength(1);
    const rawText = vaultText(raw);
    const preparedText = vaultText(prepared.messages);
    expect(preparedText.length).toBeLessThan(rawText.length);
    expect(preparedText.length).toBeLessThan(20_000);
    expect(preparedText).toContain('Continuity refresh: a same-instance hard epoch (context reset) just completed.');
    expect(preparedText).toContain('[CONTEXT REBIRTH] Lifecycle boundary: same_instance_hard_epoch for "predecessor".');
    expect(preparedText).toContain('── Raw Trace Coordinate Closet (ids/paths/values preserved from full trace) ──');
    expect(preparedText).toContain('/home/jonah/context-warp-drive/src/file_27.ts');
    expect(preparedText).not.toContain('ACTIVE_STEP_27_FULL_PAYLOAD');
  });

  it('full-recomputes repeated over-ceiling calls instead of suppressing pressure epochs', () => {
    const session = new FoldSession({
      foldConfig: {
        ...TEST_FOLD_CONFIG,
        activeWindowTurns: 1,
        assistantTextBudget: { fullRetentionChars: 6_000, essenceRetentionChars: 0 },
      },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 150_000 },
      pressureCeiling: 80_000,
      now: () => 1_000,
    });
    const raw = hybridMarathonHistory();

    const pressureEpoch = session.prepare(raw, { measuredInputTokens: 80_000 });
    const repeatedPressureEpoch = session.prepare(raw, { measuredInputTokens: 80_200 });

    expect(pressureEpoch.cacheHot).toBe(false);
    expect(pressureEpoch.stats.pressureCeilingTriggered).toBe(true);
    expect(repeatedPressureEpoch.cacheHot).toBe(false);
    expect(repeatedPressureEpoch.stats.pressureCeilingTriggered).toBe(true);
    expect(session.telemetry.epochs).toBe(2);
  });

  it('keeps pressure recomputing when measured growth indicates fresh evictable tail', () => {
    const session = new FoldSession({
      foldConfig: {
        ...TEST_FOLD_CONFIG,
        activeWindowTurns: 1,
        assistantTextBudget: { fullRetentionChars: 6_000, essenceRetentionChars: 0 },
      },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 150_000 },
      pressureCeiling: 80_000,
      now: () => 1_000,
    });
    const raw = hybridMarathonHistory();

    const pressureEpoch = session.prepare(raw, { measuredInputTokens: 80_000 });
    const nearUnchanged = session.prepare(raw, { measuredInputTokens: 80_200 });
    const grown = session.prepare(appendTurn(raw, 'fresh pressure tail'), { measuredInputTokens: 88_500 });

    expect(pressureEpoch.stats.pressureCeilingTriggered).toBe(true);
    expect(nearUnchanged.cacheHot).toBe(false);
    expect(nearUnchanged.stats.pressureCeilingTriggered).toBe(true);
    expect(grown.cacheHot).toBe(false);
    expect(grown.stats.pressureCeilingTriggered).toBe(true);
    expect(session.telemetry.epochs).toBe(3);
  });
});

describe('FoldSession tail-epoch runway gate', () => {
  it('extracts coordinate literals from rolling-fold and rebirth closet forms', () => {
    const corpus = extractCoordinateConservationCorpus([{
      role: 'user',
      content: `⌖⌖⌖ COORDINATE CLOSET ⌖⌖⌖ conserved: record-existing-1234 · /repo/existing.ts

── Raw Trace Coordinate Closet (ids/paths/values preserved from full trace) ──
Conserved high-value literals newest-first.
- 00000000-0000-4000-8000-000000000111
- /repo/from-rebirth.ts

── Next Section ──
- not-part-of-the-closet`,
    }]);

    expect(corpus).toContain('record-existing-1234');
    expect(corpus).toContain('/repo/existing.ts');
    expect(corpus).toContain('00000000-0000-4000-8000-000000000111');
    expect(corpus).toContain('/repo/from-rebirth.ts');
    expect(corpus).not.toContain('not-part-of-the-closet');
  });

  it('deduplicates closet items without stripping unrelated blank lines', () => {
    const marker = '⌖⌖⌖ COORDINATE CLOSET ⌖⌖⌖ conserved: ';
    const text = `intro\n\n${marker}/repo/existing.ts · /repo/new.ts\n\nending`;

    expect(dedupeCoordinateClosetText(text, '/repo/existing.ts')).toBe(
      `intro\n\n${marker}/repo/new.ts\n\nending`,
    );
  });

  it('hot-reuses instead of appending when measured telemetry is absent', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    const epoch = session.prepare(first);
    const appended = session.prepare(appendProfitableTail(first, 'tail one'));

    expect(epoch.cacheHot).toBe(false);
    expect(appended.cacheHot).toBe(true);
    expect(appended.stats.epochReason).toBeUndefined();
    expect(appended.stats.appendDecision).toBeUndefined();
    expect(appended.messages.slice(0, epoch.messages.length)).toEqual(epoch.messages);
    expect(session.telemetry.epochs).toBe(1);
  });

  it('routes a default single-ceiling P hit through the measured append predicate', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 150_000 },
      pressureCeiling: 125_000,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    const baseline = session.prepare(first);
    const appended = session.prepare(appendProfitableTail(first, 'at P'), {
      measuredInputTokens: 125_000,
    });

    expect(appended.stats.pressureCeilingTriggered).toBe(true);
    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.stats.appendDecision).toBe('committed');
    expect(appended.messages.slice(0, baseline.messages.length)).toEqual(baseline.messages);
  });

  it('does not repeat frozen-prefix coordinates in a later appended closet', () => {
    const residentId = '00000000-0000-4000-8000-000000000321';
    const newId = '00000000-0000-4000-8000-000000000654';
    const session = new FoldSession({
      foldConfig: { ...TEST_FOLD_CONFIG, verbatimKeepChars: 4_000 },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first: FoldMessage[] = [
      { role: 'user', content: 'establish the first coordinate band' },
      { role: 'assistant', content: `${'baseline detail '.repeat(80)}\nresident coordinate ${residentId}` },
      { role: 'user', content: 'finish the first band' },
      { role: 'assistant', content: 'baseline complete' },
    ];
    const baseline = session.prepare(first);
    expect(vaultText(baseline.messages)).toContain(residentId);

    const history = [...first];
    for (let index = 0; index < 3; index += 1) {
      history.push(
        { role: 'user', content: `append coordinate pass ${index}` },
        {
          role: 'assistant',
          content: `${'compressible appended detail '.repeat(300)}\nresident ${residentId}\nnew ${newId}`,
        },
      );
    }
    const appended = session.prepare(history, { measuredInputTokens: 70_000 });
    expect(appended.stats.appendDecision).toBe('committed');
    const fullText = vaultText(appended.messages);
    const appendedBandText = vaultText(appended.messages.slice(baseline.messages.length));
    expect(fullText.split(residentId)).toHaveLength(2);
    expect(appendedBandText).not.toContain(residentId);
    expect(appendedBandText).toContain(newId);
  });

  it('adds cognitive artifacts to committed tail append views', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    session.prepare(first);
    const appended = session.prepare([
      ...first,
      { role: 'user', content: 'next cognitive tail' },
      { role: 'assistant', content: `🏁 tail verdict survives ${'compressible detail '.repeat(300)}` },
      { role: 'user', content: 'next more tail' },
      { role: 'assistant', content: profitableTail('more tail') },
    ], { measuredInputTokens: 70_000 });

    const joined = vaultText(appended.messages);
    expect(appended.stats.appendDecision).toBe('committed');
    expect(joined).toContain('[cognitive');
    expect(joined).toContain('🏁 tail verdict survives');
  });

  it('accumulates cognitive artifacts across three consecutive committed tail-append cycles without drift or duplication', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    const baseline = session.prepare(first);
    expect(baseline.cacheHot).toBe(false);

    let history = first;

    history = [
      ...history,
      { role: 'user', content: 'cycle one ask' },
      { role: 'assistant', content: `🏁 cycle-one verdict ${profitableTail('cycle one detail')}` },
    ];
    const cycle1 = session.prepare(history, { measuredInputTokens: 70_000 });
    expect(cycle1.stats.appendDecision).toBe('committed');
    expect(cycle1.sealedBoundary).toBe(baseline.messages.length);

    history = [
      ...history,
      { role: 'user', content: 'cycle two ask' },
      { role: 'assistant', content: `⚠️ cycle-two hazard ${profitableTail('cycle two detail')}` },
    ];
    const cycle2 = session.prepare(history, { measuredInputTokens: 70_000 });
    expect(cycle2.stats.appendDecision).toBe('committed');
    // No boundary drift: each cycle's seal point is exactly where the prior
    // cycle's view (prefix + its own baked [cognitive] block) left off.
    expect(cycle2.sealedBoundary).toBe(cycle1.messages.length);

    history = [
      ...history,
      { role: 'user', content: 'cycle three ask' },
      { role: 'assistant', content: `🏁 cycle-three verdict ${profitableTail('cycle three detail')}` },
    ];
    const cycle3 = session.prepare(history, { measuredInputTokens: 70_000 });
    expect(cycle3.stats.appendDecision).toBe('committed');
    expect(cycle3.sealedBoundary).toBe(cycle2.messages.length);

    const joined = vaultText(cycle3.messages);
    const firstIndex = joined.indexOf('🏁 cycle-one verdict');
    const secondIndex = joined.indexOf('⚠️ cycle-two hazard');
    const thirdIndex = joined.indexOf('🏁 cycle-three verdict');
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(thirdIndex).toBeGreaterThan(secondIndex);

    // Each committed cycle bakes exactly one [cognitive] block for its own
    // delta; earlier cycles' blocks are carried forward verbatim in the
    // frozen prefix, never re-synthesized or duplicated. The block is MERGED
    // into each band's final message (never appended as a separate assistant
    // message — a trailing assistant message 400s providers that require the
    // request to end with a user message), so count needles within the
    // [cognitive] block portion of each message, not the whole message text
    // (the folded band content legitimately carries the raw headline too).
    const extractCognitiveBlock = (text: string): string => {
      const start = text.indexOf('[cognitive');
      if (start < 0) return '';
      return text.slice(start);
    };
    const cognitiveBlocks = cycle3.messages
      .map((msg) => (typeof msg.content === 'string' ? msg.content : ''))
      .map(extractCognitiveBlock)
      .filter((text) => text.length > 0);
    const cycleCognitiveBlocks = cognitiveBlocks.filter((text) =>
      text.includes('🏁 cycle-one verdict')
      || text.includes('⚠️ cycle-two hazard')
      || text.includes('🏁 cycle-three verdict'));
    const countInCognitiveBlocks = (needle: string): number =>
      cognitiveBlocks.reduce((count, text) => count + text.split(needle).length - 1, 0);
    expect(cycleCognitiveBlocks).toHaveLength(3);
    expect(countInCognitiveBlocks('🏁 cycle-one verdict')).toBe(1);
    expect(countInCognitiveBlocks('⚠️ cycle-two hazard')).toBe(1);
    expect(countInCognitiveBlocks('🏁 cycle-three verdict')).toBe(1);

    // Terminal-role invariant: the enrichment must never leave the folded view
    // ending on an appended assistant block message. The view's last message is
    // the band's final folded raw message (with the block merged INTO it), so
    // its text is never just the [cognitive] block.
    const lastMessage = cycle3.messages[cycle3.messages.length - 1];
    const lastText = typeof lastMessage.content === 'string' ? lastMessage.content : '';
    expect(lastText.startsWith('[cognitive]')).toBe(false);

    expect(session.telemetry.epochs).toBe(4);
  });

  it('hot-reuses instead of committing an unprofitable append band', () => {
    const session = new FoldSession({
      foldConfig: { ...TEST_FOLD_CONFIG, continuous: false },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    const epoch = session.prepare(first);
    const skipped = session.prepare(appendTurn(first, 'tiny tail'), { measuredInputTokens: 70_000 });

    expect(epoch.cacheHot).toBe(false);
    expect(skipped.cacheHot).toBe(true);
    expect(skipped.stats.appendDecision).toBe('skipped');
    expect(skipped.stats.appendSkipReason).toBe('not-smaller');
    expect(skipped.stats.appendRawTailChars).toBeGreaterThan(0);
    expect(skipped.stats.appendBandChars).toBeGreaterThanOrEqual(skipped.stats.appendRawTailChars ?? 0);
    expect(session.telemetry.epochs).toBe(1);
  });

  it('does not synthesize cognitive artifacts when an append is skipped by the gate', () => {
    const session = new FoldSession({
      foldConfig: { ...TEST_FOLD_CONFIG, continuous: false },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    session.prepare(first);
    const skipped = session.prepare([
      ...first,
      { role: 'user', content: 'next tiny tail' },
      { role: 'assistant', content: '🏁 tiny verdict stays raw only' },
    ], { measuredInputTokens: 70_000 });

    const joined = vaultText(skipped.messages);
    expect(skipped.stats.appendDecision).toBe('skipped');
    expect(skipped.stats.appendSkipReason).toBe('not-smaller');
    expect(joined).toContain('🏁 tiny verdict stays raw only');
    expect(joined).not.toContain('[cognitive]');
  });

  it('appends a folded tail epoch when measured runway holds even if fallback modeling would fail', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    session.prepare(first);
    const appended = session.prepare(appendProfitableTail(first, 'tail one'), {
      measuredInputTokens: 70_000,
    });

    expect(appended.cacheHot).toBe(false);
    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.stats.appendDecision).toBe('committed');
    expect(session.telemetry.epochs).toBe(2);
  });

  it('appends a folded tail epoch even when measured input is low (no blind zone)', () => {
    // Regression: a measured-token floor (default 100K) suppressed the char-cap
    // tail epoch below the floor, so a session could ride hot-reuse from
    // sub-floor measured input straight past the pressure ceiling with zero
    // tail epochs (nova-cobra, 2026-07-05). The exact scenario the floor kept
    // hot — over-cap tail at 70K measured — must now seal an append band.
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 150_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    session.prepare(first);
    const appended = session.prepare(appendProfitableTail(first, 'tail one'), {
      measuredInputTokens: 70_000,
    });

    expect(appended.cacheHot).toBe(false);
    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.stats.appendDecision).toBe('committed');
    expect(appended.sealedBoundary).not.toBeNull();
    expect(session.telemetry.epochs).toBe(2);
  });

  it('cold-folds assistant-led orphan tool tails before append commit', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 150_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first: FoldMessage[] = [
      { role: 'user', content: 'active kickoff: keep processing tool steps' },
    ];
    session.prepare(first);
    const appended = session.prepare(appendAssistantLedToolTail(first, 4), {
      measuredInputTokens: 70_000,
    });
    const joined = vaultText(appended.messages);

    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.stats.appendDecision).toBe('committed');
    expect(joined).not.toContain('ORPHAN_DEEP_TOKEN_0');
    expect(joined).not.toContain('ORPHAN_DEEP_TOKEN_1');
    expect(joined).not.toContain('ORPHAN_DEEP_TOKEN_2');
    expect(joined).toContain('ORPHAN_DEEP_TOKEN_3');
  });

  it('keeps an unresolved tool call raw when a newer operator message crosses the fold seam', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 150_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first: FoldMessage[] = [{ role: 'user', content: 'foundation request' }];
    session.prepare(first);
    const withHistory = appendProfitableTail(first, 'older foldable work');
    const appended = session.prepare([
      ...withHistory,
      anthropicToolUse('toolu_open_across_seam', '/tmp/open-across-seam.ts'),
      { role: 'user', content: 'steer the live operation while its tool call is still pending' },
    ], { measuredInputTokens: 70_000 });
    const joined = vaultText(appended.messages);

    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.stats.appendDecision).toBe('committed');
    expect(joined).toContain('toolu_open_across_seam');
    expect(joined).toContain('steer the live operation while its tool call is still pending');
    expect(joined).toContain('stack=frozen-prefix>tail-epoch#2');
  });

  it('defers the epoch when an unresolved tool call is the entire foldable increment', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 150_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first: FoldMessage[] = [{ role: 'user', content: 'foundation request' }];
    session.prepare(first);
    const deferred = session.prepare([
      ...first,
      anthropicToolUse('toolu_only_pending_increment', '/tmp/pending-only.ts'),
    ], { measuredInputTokens: 70_000 });

    expect(deferred.cacheHot).toBe(true);
    expect(session.telemetry.epochs).toBe(1);
    expect(vaultText(deferred.messages)).toContain('toolu_only_pending_increment');
  });

  it('defers when a live user anchor collapses the split ahead of a pending call', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 150_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first: FoldMessage[] = [{ role: 'user', content: 'foundation request' }];
    session.prepare(first);
    const openId = 'toolu_mid_tail_behind_live_anchor';
    const deferred = session.prepare([
      ...first,
      { role: 'user', content: 'keep this live request authoritative while the call is pending' },
      anthropicToolUse(openId, '/tmp/live-anchor.ts'),
      { role: 'assistant', content: `later bulky narration ${'x'.repeat(45_000)}` },
    ], { measuredInputTokens: 70_000 });

    expect(deferred.cacheHot).toBe(true);
    expect(deferred.stats.deferReason).toBe('live-user-anchor');
    expect(session.telemetry.epochs).toBe(1);
    expect(vaultText(deferred.messages)).toContain(openId);
  });

  it('lets measured pressure override a permanently pending-call defer', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 150_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first: FoldMessage[] = [{ role: 'user', content: 'foundation request' }];
    const pending = [...first, anthropicToolUse('toolu_pressure_escape', '/tmp/pressure.ts')];
    session.prepare(first);
    const deferred = session.prepare(pending, { measuredInputTokens: 70_000 });
    const escaped = session.prepare(pending, {
      measuredInputTokens: 200_000,
      hardEpochSeed: 'PRESSURE_ESCAPE_SEED',
    });

    expect(deferred.stats.deferReason).toBe('pending-tool-call');
    expect(escaped.stats.pressureCeilingTriggered).toBe(true);
    expect(escaped.stats.epochReason).toBe('hard-epoch');
    expect(session.telemetry.epochs).toBe(2);
  });

  it('keeps a Gemini-parts operator directive in the raw suffix behind a giant tool result', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 150_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first: FoldMessage[] = [{ role: 'user', content: 'foundation request' }];
    session.prepare(first);
    const directive = 'GEMINI_PARTS_DIRECTIVE keep diagnosing the live tail without changing objectives';
    const appended = session.prepare([
      ...first,
      { role: 'user', content: profitableTail('older foldable request') },
      { role: 'assistant', content: profitableTail('older foldable answer') },
      { role: 'user', content: null, parts: [{ text: directive }] } as FoldMessage,
      anthropicToolUse('toolu_parts_anchor', '/tmp/parts-anchor.ts'),
      anthropicToolResult('toolu_parts_anchor', `GIANT_PARTS_RESULT\n${'x'.repeat(45_000)}`),
    ], { measuredInputTokens: 70_000 });

    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.stats.appendDecision).toBe('committed');
    expect(appended.sealedBoundary).not.toBeNull();
    const provenanceMessages = appended.messages.filter(
      (message) => typeof message.content === 'string'
        && message.content.startsWith('[Chronological Provenance v1]'),
    );
    expect(provenanceMessages).toHaveLength(1);
    expect(provenanceMessages[0].role).toBe('user');
    expect(provenanceMessages[0].content).toContain('host=dedicated-synthetic-message');
    expect(provenanceMessages[0].content).toContain('raw-resumes=?:message#');
    expect(vaultText(appended.messages.slice(appended.sealedBoundary as number))).toContain(directive);
  });

  it('keeps the latest assistant plan in the raw suffix when the foldable tail has no genuine user text', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 150_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first: FoldMessage[] = [{ role: 'user', content: 'foundation request' }];
    session.prepare(first);
    const plan = 'ASSISTANT_RAW_PLAN inspect the newest tool result, preserve the current diagnosis, then report';
    const appended = session.prepare([
      ...first,
      anthropicToolUse('toolu_old_orphan', '/tmp/old-orphan.ts'),
      anthropicToolResult('toolu_old_orphan', profitableTail('older orphan result')),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: plan },
          { type: 'tool_use', id: 'toolu_plan_anchor', name: 'Read', input: { file_path: '/tmp/plan-anchor.ts' } },
        ],
      },
      anthropicToolResult('toolu_plan_anchor', `GIANT_PLAN_RESULT\n${'y'.repeat(45_000)}`),
    ], { measuredInputTokens: 70_000 });

    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.stats.appendDecision).toBe('committed');
    expect(appended.sealedBoundary).not.toBeNull();
    expect(vaultText(appended.messages.slice(appended.sealedBoundary as number))).toContain(plan);
  });

  it('accepts an append when measured runway lands exactly on the 10k floor', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    session.prepare(first);
    const appended = session.prepare(appendProfitableTail(first, 'tail one'), {
      measuredInputTokens: 81_000,
    });

    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.stats.appendDecision).toBe('committed');
  });

  it('never hard-epochs a telemetryless tail from modeled geometry', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    const epoch = session.prepare(first);
    const reused = session.prepare(appendTurn(first, 'tail one'));

    expect(reused.cacheHot).toBe(true);
    expect(reused.stats.epochReason).toBeUndefined();
    expect(reused.messages.slice(0, epoch.messages.length)).toEqual(epoch.messages);
    expect(vaultText(reused.messages)).toContain('tail one');
    expect(session.telemetry.epochs).toBe(1);
  });

  it('appends on the compact seed baseline after a hard epoch when measured runway holds', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first = twoTurnHistory('PRESEED_BODY_TOKEN_ALPHA');
    // A hard epoch replaces provider history with a single compact seed. With
    // measured telemetry, the live runway is enough and no modeled-baseline
    // bypass should be involved.
    const hardEpoch = session.prepare(first, {
      measuredInputTokens: 111_000,
      hardEpochSeed: 'PACKAGE_HARD_EPOCH_SEED',
    });
    const appended = session.prepare(appendProfitableTail(first, 'post seed tail'), { measuredInputTokens: 70_000 });

    expect(hardEpoch.stats.epochReason).toBe('hard-epoch');
    expect(hardEpoch.messages).toHaveLength(1);
    expect(appended.cacheHot).toBe(false);
    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.sealedBoundary).toBe(hardEpoch.messages.length);
    expect(appended.messages[0]).toEqual(hardEpoch.messages[0]);
    // The old raw body the seed replaced must not be reintroduced into the frozen prefix.
    expect(JSON.stringify(appended.messages)).not.toContain('PRESEED_BODY_TOKEN_ALPHA');
    expect(session.telemetry.epochs).toBe(2);
  });

  it('does not let a compact hard-epoch baseline bypass unknown telemetry', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
      singleCeilingMode: false,
      now: () => 1_000,
    });
    const first = twoTurnHistory('RESET_BODY_TOKEN');
    // 1) Establish a compact hard-epoch baseline.
    const hardEpoch = session.prepare(first, {
      measuredInputTokens: 111_000,
      hardEpochSeed: 'RESET_HARD_EPOCH_SEED',
    });
    expect(hardEpoch.stats.epochReason).toBe('hard-epoch');
    // 2) Without measured telemetry, eligibility is unknown and the compact
    // prefix is reused rather than authorizing either append or hard epoch.
    const bypassHistory = appendProfitableTail(first, 'armed tail');
    const ceilingHistory = appendProfitableTail(bypassHistory, 'ceiling grow');
    const resumedHistory = appendProfitableTail(ceilingHistory, 'post reset tail');
    const reused = session.prepare(bypassHistory);
    expect(reused.cacheHot).toBe(true);
    expect(reused.stats.epochReason).toBeUndefined();
    // 3) A later measured pressure ceiling may still hard-epoch.
    const ceiling = session.prepare(ceilingHistory, {
      measuredInputTokens: 200_000,
    });
    expect(ceiling.stats.pressureCeilingTriggered).toBe(true);
    expect(ceiling.stats.epochReason).toBe('hard-epoch');
    // 4) Telemetry absence remains unknown after that reset too.
    const resumed = session.prepare(resumedHistory);
    expect(resumed.cacheHot).toBe(true);
    expect(resumed.stats.epochReason).toBeUndefined();
    expect(resumed.messages.slice(0, ceiling.messages.length)).toEqual(ceiling.messages);
  });

  it('keeps appending while the trigger-anchored post-fold floor remains below trigger (CLI floor-gate parity)', () => {
    // Uniform geometry: 180K ceiling, 150K trigger, 30K min runway. The runway is
    // already encoded by the trigger sitting 30K below the ceiling; the floor gate
    // must not subtract it a second time from healthy staircase bands. A floor at
    // 125K under TRIG150 still has below-trigger raw-tail budget to reclaim.
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 180_000,
      singleCeilingMode: false,
      tailEpochRunway: { foldTriggerTokens: 150_000, minRunwayTokens: 30_000 },
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    session.prepare(first);
    // First tail epoch: no epoch has committed since the seed yet, so the ≥1-epoch
    // instant-loop guard keeps the floor gate OFF; the ceiling basis appends
    // and ARMS the post-fold floor with this pre-fold reading (140K).
    const t2 = appendProfitableTail(first, 'tail one');
    const firstAppend = session.prepare(t2, { measuredInputTokens: 140_000 });
    expect(firstAppend.stats.epochReason).toBe('tail-epoch-append');
    expect(firstAppend.stats.appendDecision).toBe('committed');
    // Next tail epoch: the append dropped occupancy to 125K, RE-BASELINING the
    // floor (125K < armed 140K). Now appendEpochsSinceHardReset ≥ 1, but the
    // floor is still below the 150K trigger, so the append remains viable. The
    // old trigger-minus-minRunway gate would have hard-epoched here.
    const t3 = appendProfitableTail(t2, 'tail two');
    const secondAppend = session.prepare(t3, { measuredInputTokens: 125_000 });
    expect(secondAppend.stats.epochReason).toBe('tail-epoch-append');
    expect(secondAppend.stats.appendDecision).toBe('committed');
    expect(secondAppend.messages.length).toBeGreaterThan(1);
  });

  it('hard-epochs when an armed trigger floor reaches the trigger after a cold full recompute clears sealed bands', () => {
    let now = 1_000;
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 180_000,
      singleCeilingMode: false,
      tailEpochRunway: { foldTriggerTokens: 150_000, minRunwayTokens: 30_000 },
      now: () => now,
    });
    const first = twoTurnHistory();
    session.prepare(first);
    const t2 = appendProfitableTail(first, 'tail one');
    const firstAppend = session.prepare(t2, { measuredInputTokens: 140_000 });
    expect(firstAppend.stats.epochReason).toBe('tail-epoch-append');
    expect(firstAppend.stats.appendDecision).toBe('committed');

    // A cold-gap full recompute clears the sealed band set, but not the
    // provider-measured floor. The arming counter must survive that recompute,
    // otherwise the next tail epoch falls back to the stale ceiling basis and
    // appends through a floor that has reached the trigger.
    now += 61_000;
    const coldRecompute = session.prepare(t2, { measuredInputTokens: 150_000 });
    expect(coldRecompute.cacheHot).toBe(false);
    expect(coldRecompute.stats.appendDecision).toBeUndefined();

    const t3 = appendProfitableTail(t2, 'tail two');
    const escalated = session.prepare(t3, { measuredInputTokens: 150_000 });
    expect(escalated.cacheHot).toBe(false);
    expect(escalated.stats.epochReason).toBe('tail-runway-gate+hard-epoch');
    expect(escalated.messages).toHaveLength(1);
  });

  it('keeps appending on the same occupancy when no trigger is configured (legacy ceiling basis, no floor gate)', () => {
    // Identical occupancy trace as the floor-gate escalation above, but WITHOUT a
    // configured foldTriggerTokens: the runway check stays on the ceiling-anchored
    // measured basis (180K − 125K = 55K ≥ 30K), so the second tail epoch appends.
    // Isolates the trigger as the sole cause of the escalation.
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 180_000,
      singleCeilingMode: false,
      tailEpochRunway: { minRunwayTokens: 30_000 },
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    session.prepare(first);
    const t2 = appendProfitableTail(first, 'tail one');
    const firstAppend = session.prepare(t2, { measuredInputTokens: 140_000 });
    expect(firstAppend.stats.epochReason).toBe('tail-epoch-append');
    const t3 = appendProfitableTail(t2, 'tail two');
    const secondAppend = session.prepare(t3, { measuredInputTokens: 125_000 });
    expect(secondAppend.stats.epochReason).toBe('tail-epoch-append');
    expect(secondAppend.stats.appendDecision).toBe('committed');
    expect(secondAppend.sealedBoundary).not.toBeNull();
  });
});

describe('FoldSession per-fold yield gate', () => {
  // Trigger sits well below ceiling−minRunway (100K vs 180K−30K=150K) so there is
  // a clean at-pressure window where the runway gate still permits the append —
  // isolating the yield gate as the sole cause of the escalation.
  const YIELD_RUNWAY = { foldTriggerTokens: 100_000, minRunwayTokens: 30_000 } as const;

  it('escalates a low-yield fold to a hard epoch when measured occupancy is at/above the trigger', () => {
    const session = new FoldSession({
      // continuous:false → a tiny tail folds to a band no smaller than the raw
      // (shrinkRatio > 0.9, the same 'not-smaller' fold the hot-reuse test uses).
      foldConfig: { ...TEST_FOLD_CONFIG, continuous: false },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 180_000,
      singleCeilingMode: false,
      tailEpochRunway: YIELD_RUNWAY,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    session.prepare(first);
    // Measured 120K ≥ 100K trigger (at pressure) and 180K−120K=60K ≥ 30K (runway
    // still holds, so the append is NOT floor/runway-gated) — the useless band is
    // abandoned for a topology-resetting seed hard epoch instead of hot-reused.
    const escalated = session.prepare(appendTurn(first, 'tiny tail'), { measuredInputTokens: 120_000 });
    expect(escalated.cacheHot).toBe(false);
    expect(escalated.stats.epochReason).toBe('tail-yield-gate+hard-epoch');
    expect(escalated.messages).toHaveLength(1);
  });

  it('does NOT escalate the same low-yield fold below the trigger when trigger-runway is ample', () => {
    const session = new FoldSession({
      foldConfig: { ...TEST_FOLD_CONFIG, continuous: false },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 180_000,
      singleCeilingMode: false,
      tailEpochRunway: YIELD_RUNWAY,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    session.prepare(first);
    // Measured 60K < 100K trigger with 40K trigger-runway >= 30K min runway:
    // the gate stays off and the unprofitable fold hot-reuses.
    const reused = session.prepare(appendTurn(first, 'tiny tail'), { measuredInputTokens: 60_000 });
    expect(reused.cacheHot).toBe(true);
    expect(reused.stats.appendDecision).toBe('skipped');
    expect(reused.stats.appendSkipReason).toBe('not-smaller');
  });

  it('escalates a low-yield fold below the trigger when trigger-runway is thin', () => {
    const session = new FoldSession({
      foldConfig: { ...TEST_FOLD_CONFIG, continuous: false },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 180_000,
      singleCeilingMode: false,
      tailEpochRunway: YIELD_RUNWAY,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    session.prepare(first);
    // Measured 90K < 100K trigger, but trigger-runway is only 10K < 30K:
    // appending a zero-yield band would churn, so escalate to the hard seed.
    const escalated = session.prepare(appendTurn(first, 'tiny tail'), { measuredInputTokens: 90_000 });
    expect(escalated.cacheHot).toBe(false);
    expect(escalated.stats.epochReason).toBe('tail-yield-gate+hard-epoch');
    expect(escalated.messages).toHaveLength(1);
  });

  it('appends a HIGH-yield fold at pressure (gate is yield-specific, not a blanket at-pressure hard epoch)', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 180_000,
      singleCeilingMode: false,
      tailEpochRunway: YIELD_RUNWAY,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    session.prepare(first);
    // Same at-pressure occupancy (120K ≥ 100K trigger) but a highly compressible
    // tail folds well under the 0.7 escalate bar → the band appends normally.
    const appended = session.prepare(appendProfitableTail(first, 'tail one'), { measuredInputTokens: 120_000 });
    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.stats.appendDecision).toBe('committed');
  });
});

describe('FoldSession restored-overcap full recompute', () => {
  it('full-recomputes (never appends) when a restored prefix carries an oversized tail', () => {
    // Same config as the runway-gate APPEND control above (pressureCeiling
    // 125k → runway holds): a normal tail-epoch appends there. With the
    // rebirth-restore one-shot set, the oversized restored tail must instead
    // force a full recompute so the bloated restored prefix is recomputed away
    // rather than sealed and carried forward by an append-only band.
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    const epoch = session.prepare(first);
    expect(epoch.cacheHot).toBe(false);

    // Simulate the relay's Level 3 rebirth fold-state restore: trust the
    // predecessor's frozen prefix for exactly one evaluation.
    (session as unknown as { freezeState: { forceAcceptRestoredView: boolean } })
      .freezeState.forceAcceptRestoredView = true;

    const restored = session.prepare(appendTurn(first, 'restored tail'));

    // restored-overcap is impossible under the pre-fix behavior (which returned
    // generic 'tail-epoch' and would have appended → 'tail-epoch-append').
    expect(restored.cacheHot).toBe(false);
    expect(restored.stats.epochReason).toBe('restored-overcap');
    expect(restored.sealedBoundary).toBeNull();
    expect(session.telemetry.epochs).toBe(2);
  });

  it('still hot-reuses a restored prefix when the tail is within the cap', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 150_000 },
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    session.prepare(first);

    (session as unknown as { freezeState: { forceAcceptRestoredView: boolean } })
      .freezeState.forceAcceptRestoredView = true;

    const reused = session.prepare(appendTurn(first, 'small tail'));

    expect(reused.cacheHot).toBe(true);
    expect(session.telemetry.epochs).toBe(1);
  });
});

describe('FoldSession full-recompute eviction invariant', () => {
  it('does not emit eviction telemetry until a safe frontier is available', () => {
    const history = multiTurnHistory(6);
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: false,
      eviction: { thresholdChars: 1_000_000 },
      now: () => 1_000,
    });

    session.prepare(history);
    session.prepare(history);
    const third = session.prepare(history);

    expect(third.cacheHot).toBe(false);
    expect(third.stats.evictionOutcome).toBeUndefined();
    expect(third.stats.newlyEvictedTurns).toBe(0);
    expect(vaultText(third.messages)).not.toContain(FOLD_TOMBSTONE_PREFIX);
    expect(session.telemetry.evictedTurnCount).toBe(0);
  });
});

function vaultText(messages: FoldMessage[]): string {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

function vaultSession(overrides: Record<string, unknown> = {}): FoldSession {
  return new FoldSession({
    foldConfig: TEST_FOLD_CONFIG,
    freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 150_000 },
    vault: true,
    singleCeilingMode: false,
    now: () => 1_000,
    ...overrides,
  });
}

describe('FoldSession per-band vault sealing', () => {
  it('bakes the full vault into the frozen view at a full recompute', () => {
    const session = vaultSession();
    session.recordOperatorMessage('OPERATOR-ALPHA wants the build green', '2026-06-19T10:00:00Z');
    // Answer the ask — an unanswered newest row is deferred from sealing
    // (liveness) and would ride the transient view instead of the frozen bake.
    session.recordAssistantMessage('🏁 build made green', '2026-06-19T10:01:00Z');
    const epoch = session.prepare(twoTurnHistory());

    expect(epoch.cacheHot).toBe(false);
    const joined = vaultText(epoch.messages);
    expect(joined).toContain('[User Message Vault]');
    expect(joined).toContain('OPERATOR-ALPHA wants the build green');
  });

  it('keeps the vault byte-identical across hot reuses (cached prefix, no per-send re-append)', () => {
    const session = vaultSession();
    session.recordOperatorMessage('OPERATOR-BETA pivoted to the parser', '2026-06-19T10:00:00Z');
    session.recordAssistantMessage('🏁 parser pivot done', '2026-06-19T10:01:00Z');
    const epoch = session.prepare(twoTurnHistory());
    const hot = session.prepare(twoTurnHistory());

    expect(hot.cacheHot).toBe(true);
    // Identical bytes — the vault rides the cached frozen prefix and is NOT
    // re-rendered/re-appended to a growing tail each send.
    expect(hot.messages).toEqual(epoch.messages);
    expect(vaultText(hot.messages).split('[User Message Vault]').length - 1).toBe(1);
  });

  it('keeps a deferred opening request visible after it is answered but before the next epoch', () => {
    vi.stubEnv('VOXXO_FOLD_ARTIFACT_ONLY', '1');
    const session = vaultSession();
    const question = 'OPERATOR-BETA-LIVE keep the repository question visible';
    session.recordOperatorMessage(question, '2026-06-19T10:00:00Z');
    const history = twoTurnHistory();

    const live = session.prepare(history);
    expect(vaultText(live.messages)).toContain(question);
    expect(vaultText(live.messages)).toContain(USER_MESSAGE_VAULT_LIVE_MARKER);

    session.recordAssistantMessage('I am investigating now.', '2026-06-19T10:01:00Z');
    const answeredHotReuse = session.prepare(history);

    expect(answeredHotReuse.cacheHot).toBe(true);
    expect(vaultText(answeredHotReuse.messages)).toContain(question);
    expect(vaultText(answeredHotReuse.messages)).not.toContain(USER_MESSAGE_VAULT_LIVE_MARKER);
  });

  it('seals only the delta into an appended band, never re-sealing prior rows', () => {
    const session = vaultSession({
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
    });
    session.recordOperatorMessage('OPERATOR-GAMMA first directive', '2026-06-19T10:00:00Z');
    session.recordAssistantMessage('🏁 first directive handled', '2026-06-19T10:01:00Z');
    const first = twoTurnHistory();
    const epoch = session.prepare(first);
    session.recordOperatorMessage('OPERATOR-DELTA second directive', '2026-06-19T10:05:00Z');
    session.recordAssistantMessage('🏁 second directive handled', '2026-06-19T10:06:00Z');
    const appended = session.prepare(appendProfitableTail(first, 'tail one'), {
      measuredInputTokens: 70_000,
    });

    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    const boundary = appended.sealedBoundary as number;
    const bandText = vaultText(appended.messages.slice(boundary));
    const prefixText = vaultText(appended.messages.slice(0, boundary));
    // The new directive seals into the appended band ...
    expect(bandText).toContain('OPERATOR-DELTA second directive');
    // ... the already-sealed first directive is NOT re-sealed into the band ...
    expect(bandText).not.toContain('OPERATOR-GAMMA first directive');
    // ... and remains in the prefix, whose bytes are identical to epoch 1.
    expect(prefixText).toContain('OPERATOR-GAMMA first directive');
    expect(appended.messages.slice(0, boundary)).toEqual(epoch.messages);
  });

  it('does not seal a vault alias for an operator message that survives in the exact raw tail', () => {
    const session = vaultSession({
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 150_000,
    });
    const first: FoldMessage[] = [{ role: 'user', content: 'foundation request' }];
    session.prepare(first);
    const directive = 'RAW-ONLY-DIRECTIVE remain on the chronology implementation';
    session.recordOperatorMessage(directive, '2026-07-11T04:10:00Z');
    session.recordAssistantMessage('🏁 directive acknowledged', '2026-07-11T04:11:00Z');
    const appended = session.prepare([
      ...first,
      { role: 'user', content: profitableTail('older foldable request') },
      { role: 'assistant', content: profitableTail('older foldable answer') },
      { role: 'user', content: directive },
      anthropicToolUse('toolu_raw_vault', '/tmp/raw-vault.ts'),
      anthropicToolResult('toolu_raw_vault', `RAW VAULT RESULT\n${'v'.repeat(45_000)}`),
    ], { measuredInputTokens: 70_000 });

    expect(appended.stats.appendDecision).toBe('committed');
    const joined = vaultText(appended.messages);
    const vaultBlocks = joined.match(/\[User Message Vault\][\s\S]*?\[\/User Message Vault\]/g) ?? [];
    expect(vaultBlocks.join('\n')).not.toContain(directive);
    expect(joined).toContain(directive);
  });

  it('re-renders the current-task vault on a cold full recompute (sealed set reset)', () => {
    let now = 1_000;
    const session = vaultSession({ now: () => now });
    session.recordOperatorMessage('OPERATOR-EPSILON one', '2026-06-19T10:00:00Z');
    session.recordAssistantMessage('🏁 epsilon handled', '2026-06-19T10:01:00Z');
    const first = twoTurnHistory();
    session.prepare(first);
    session.recordOperatorMessage('OPERATOR-ZETA two', '2026-06-19T10:05:00Z');
    session.recordAssistantMessage('🏁 zeta handled', '2026-06-19T10:06:00Z');
    now += 61_000;
    const recomputed = session.prepare(first);

    expect(recomputed.cacheHot).toBe(false);
    const joined = vaultText(recomputed.messages);
    // Recording ZETA advances the explicit task frontier, so a full render
    // preserves the complete current task without resurrecting Epsilon's
    // superseded task wording.
    expect(joined).not.toContain('OPERATOR-EPSILON one');
    expect(joined).toContain('OPERATOR-ZETA two');
    // One full block, not a stale prefix delta plus a full render.
    expect(joined.split('[User Message Vault]').length - 1).toBe(1);
  });

  it('bakes answered vault rows into a runway-gated hard epoch', () => {
    const session = vaultSession({
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 180_000,
      tailEpochRunway: { foldTriggerTokens: 150_000, minRunwayTokens: 30_000 },
    });
    session.recordOperatorMessage('OPERATOR-IOTA hard epoch ask', '2026-06-19T10:00:00Z');
    session.recordAssistantMessage('🏁 hard epoch ask handled', '2026-06-19T10:01:00Z');
    const first = twoTurnHistory();
    session.prepare(first);

    const second = appendProfitableTail(first, 'vault tail one');
    const appended = session.prepare(second, { measuredInputTokens: 140_000 });
    expect(appended.stats.epochReason).toBe('tail-epoch-append');

    const third = appendProfitableTail(second, 'vault tail two');
    const hardEpoch = session.prepare(third, { measuredInputTokens: 150_000 });
    expect(hardEpoch.stats.epochReason).toBe('tail-runway-gate+hard-epoch');
    expect(hardEpoch.messages).toHaveLength(1);
    const joined = vaultText(hardEpoch.messages);
    expect(joined).toContain('OPERATOR-IOTA hard epoch ask');
    expect(joined.split('[User Message Vault]').length - 1).toBe(1);
    expect(joined).not.toContain('⌖ LIVE');
  });

  it('defers the unanswered newest operator row from band sealing and re-seals it once answered', () => {
    const session = vaultSession({
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
    });
    session.recordOperatorMessage('OPERATOR-ETA settled ask', '2026-06-19T10:00:00Z');
    session.recordAssistantMessage('🏁 settled the eta ask', '2026-06-19T10:01:00Z');
    const first = twoTurnHistory();
    session.prepare(first);

    // Live, unanswered ask at the next band epoch: rides the transient view
    // with the LIVE marker instead of sealing into the cached band.
    session.recordOperatorMessage('OPERATOR-THETA live ask', '2026-06-19T10:05:00Z');
    const second = appendProfitableTail(first, 'tail one');
    const live = session.prepare(second, { measuredInputTokens: 70_000 });
    expect(live.stats.epochReason).toBe('tail-epoch-append');
    const liveText = vaultText(live.messages);
    expect(liveText).toContain('OPERATOR-THETA live ask');
    expect(liveText).toContain(USER_MESSAGE_VAULT_LIVE_MARKER);

    // Once answered, the row seals into the NEXT band — proving it was never
    // sealed while live (a sealed fingerprint would have deduped it out) —
    // and the LIVE marker vanishes from the view (never baked into a band).
    session.recordAssistantMessage('🏁 resolved the theta ask', '2026-06-19T10:06:00Z');
    const answered = session.prepare(appendProfitableTail(second, 'tail two'), {
      measuredInputTokens: 70_000,
    });
    expect(answered.stats.epochReason).toBe('tail-epoch-append');
    const boundary = answered.sealedBoundary as number;
    const bandText = vaultText(answered.messages.slice(boundary));
    expect(bandText).toContain('OPERATOR-THETA live ask');
    expect(vaultText(answered.messages)).not.toContain(USER_MESSAGE_VAULT_LIVE_MARKER);
  });
});
