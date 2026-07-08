import { describe, expect, it } from 'vitest';

import {
  FoldSession,
  FOLD_TOMBSTONE_PREFIX,
  type FoldConfig,
  type FoldMessage,
} from '../index.ts';

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
  it('folds old real turns and the oversized active turn in one prepare epoch', () => {
    const session = new FoldSession({
      foldConfig: {
        ...TEST_FOLD_CONFIG,
        activeWindowTurns: 1,
        assistantTextBudget: { fullRetentionChars: 6_000, essenceRetentionChars: 0 },
      },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 150_000 },
      pressureCeiling: 80_000,
      rawHardEpochSeedMaxChars: 9_000,
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
    expect(preparedText.length).toBeLessThan(12_000);
    expect(preparedText).toContain('[CONTEXT REBIRTH] You are the continuation of "predecessor".');
    expect(preparedText).toContain('── Raw Trace Coordinate Closet (ids/paths/values preserved from full trace) ──');
    expect(preparedText).toContain('ACTIVE_STEP_27_FULL_PAYLOAD');
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
  it('appends a folded tail epoch when the fallback modeled runway satisfies the 10k default floor', () => {
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
    expect(appended.cacheHot).toBe(false);
    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.stats.appendDecision).toBe('committed');
    expect(appended.stats.appendSavedChars).toBeGreaterThan(0);
    expect(appended.sealedBoundary).toBe(epoch.messages.length);
    expect(session.telemetry.epochs).toBe(2);
  });

  it('adds cognitive artifacts to committed tail append views', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
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
    ]);

    const joined = vaultText(appended.messages);
    expect(appended.stats.appendDecision).toBe('committed');
    expect(joined).toContain('[cognitive]');
    expect(joined).toContain('🏁 tail verdict survives');
  });

  it('accumulates cognitive artifacts across three consecutive committed tail-append cycles without drift or duplication', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
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
    const cycle1 = session.prepare(history);
    expect(cycle1.stats.appendDecision).toBe('committed');
    expect(cycle1.sealedBoundary).toBe(baseline.messages.length);

    history = [
      ...history,
      { role: 'user', content: 'cycle two ask' },
      { role: 'assistant', content: `⚠️ cycle-two hazard ${profitableTail('cycle two detail')}` },
    ];
    const cycle2 = session.prepare(history);
    expect(cycle2.stats.appendDecision).toBe('committed');
    // No boundary drift: each cycle's seal point is exactly where the prior
    // cycle's view (prefix + its own baked [cognitive] block) left off.
    expect(cycle2.sealedBoundary).toBe(cycle1.messages.length);

    history = [
      ...history,
      { role: 'user', content: 'cycle three ask' },
      { role: 'assistant', content: `🏁 cycle-three verdict ${profitableTail('cycle three detail')}` },
    ];
    const cycle3 = session.prepare(history);
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
    // frozen prefix, never re-synthesized or duplicated.
    const cognitiveTexts = cycle3.messages
      .map((msg) => (typeof msg.content === 'string' ? msg.content : ''))
      .filter((text) => text.includes('[cognitive]'));
    const countInCognitiveMessages = (needle: string): number =>
      cognitiveTexts.reduce((count, text) => count + text.split(needle).length - 1, 0);
    expect(cognitiveTexts).toHaveLength(3);
    expect(countInCognitiveMessages('🏁 cycle-one verdict')).toBe(1);
    expect(countInCognitiveMessages('⚠️ cycle-two hazard')).toBe(1);
    expect(countInCognitiveMessages('🏁 cycle-three verdict')).toBe(1);

    expect(session.telemetry.epochs).toBe(4);
  });

  it('hot-reuses instead of committing an unprofitable append band', () => {
    const session = new FoldSession({
      foldConfig: { ...TEST_FOLD_CONFIG, continuous: false },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    const epoch = session.prepare(first);
    const skipped = session.prepare(appendTurn(first, 'tiny tail'));

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
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    session.prepare(first);
    const skipped = session.prepare([
      ...first,
      { role: 'user', content: 'next tiny tail' },
      { role: 'assistant', content: '🏁 tiny verdict stays raw only' },
    ]);

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

  it('accepts an append when measured runway lands exactly on the 10k floor', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
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

  it('hard-epochs a telemetryless tail epoch when fallback modeling leaves less than the 10k floor', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
      now: () => 1_000,
    });
    const first = twoTurnHistory();
    session.prepare(first);
    const recomputed = session.prepare(appendTurn(first, 'tail one'));

    expect(recomputed.cacheHot).toBe(false);
    expect(recomputed.stats.epochReason).toBe('tail-runway-gate+hard-epoch');
    expect(recomputed.messages).toHaveLength(1);
    expect(session.telemetry.epochs).toBe(2);
  });

  it('appends on the compact seed baseline after a hard epoch when measured runway holds', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
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

  it('keeps the hard-epoch baseline bypass only for telemetryless fallback routing', () => {
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
      now: () => 1_000,
    });
    const first = twoTurnHistory('RESET_BODY_TOKEN');
    // 1) Hard epoch arms the compact-baseline bypass.
    const hardEpoch = session.prepare(first, {
      measuredInputTokens: 111_000,
      hardEpochSeed: 'RESET_HARD_EPOCH_SEED',
    });
    expect(hardEpoch.stats.epochReason).toBe('hard-epoch');
    // 2) Without measured telemetry, the fallback modeled runway is pessimistic
    // after the tiny seed. The legacy baseline bypass remains scoped here only.
    const bypassHistory = appendProfitableTail(first, 'armed tail');
    const ceilingHistory = appendProfitableTail(bypassHistory, 'ceiling grow');
    const resumedHistory = appendProfitableTail(ceilingHistory, 'post reset tail');
    const bypassed = session.prepare(bypassHistory);
    expect(bypassed.stats.epochReason).toBe('tail-epoch-append+hard-epoch-baseline');
    // 3) A later pressure ceiling hard-epochs again and re-arms the compact baseline.
    const ceiling = session.prepare(ceilingHistory, {
      measuredInputTokens: 200_000,
    });
    expect(ceiling.stats.pressureCeilingTriggered).toBe(true);
    expect(ceiling.stats.epochReason).toBe('hard-epoch');
    // 4) The re-armed compact baseline can append through the fallback bypass.
    const resumed = session.prepare(resumedHistory);
    expect(resumed.stats.epochReason).toBe('tail-epoch-append+hard-epoch-baseline');
    expect(resumed.sealedBoundary).toBe(ceiling.messages.length);
  });

  it('escalates a tail epoch to a hard epoch when the trigger-anchored post-fold floor rises within min runway (CLI floor-gate parity)', () => {
    // Uniform geometry: 180K ceiling, 150K trigger, 30K min runway. The measured
    // ceiling basis alone (180K − measured) would keep appending forever (the
    // 22-tail-epochs-never-hard-epoch pathology); the trigger-anchored floor gate
    // (150K − post-fold floor) escalates once the frozen prefix rests too high.
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 180_000,
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
    // floor (125K < armed 140K). Now appendEpochsSinceHardReset ≥ 1, so floor gate engages:
    // 150K trigger − 125K floor = 25K < 30K min runway → escalate. The stale
    // ceiling basis (180K − 125K = 55K) would still have appended.
    const t3 = appendProfitableTail(t2, 'tail two');
    const escalated = session.prepare(t3, { measuredInputTokens: 125_000 });
    expect(escalated.cacheHot).toBe(false);
    expect(escalated.stats.epochReason).toBe('tail-runway-gate+hard-epoch');
    expect(escalated.messages).toHaveLength(1);
  });

  it('keeps the trigger floor gate armed across a cold full recompute that clears sealed bands', () => {
    let now = 1_000;
    const session = new FoldSession({
      foldConfig: TEST_FOLD_CONFIG,
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 180_000,
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
    // appends through a floor that is already inside minRunway of the trigger.
    now += 61_000;
    const coldRecompute = session.prepare(t2, { measuredInputTokens: 125_000 });
    expect(coldRecompute.cacheHot).toBe(false);
    expect(coldRecompute.stats.appendDecision).toBeUndefined();

    const t3 = appendProfitableTail(t2, 'tail two');
    const escalated = session.prepare(t3, { measuredInputTokens: 125_000 });
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
    const appended = session.prepare(appendProfitableTail(first, 'tail one'));

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

  it('re-renders the full vault on a cold full recompute (sealed set reset)', () => {
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
    expect(joined).toContain('OPERATOR-EPSILON one');
    expect(joined).toContain('OPERATOR-ZETA two');
    // One full block, not a stale prefix delta plus a full render.
    expect(joined.split('[User Message Vault]').length - 1).toBe(1);
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
    const live = session.prepare(second);
    expect(live.stats.epochReason).toBe('tail-epoch-append');
    const liveText = vaultText(live.messages);
    expect(liveText).toContain('OPERATOR-THETA live ask');
    expect(liveText).toContain('⌖ LIVE');

    // Once answered, the row seals into the NEXT band — proving it was never
    // sealed while live (a sealed fingerprint would have deduped it out) —
    // and the LIVE marker vanishes from the view (never baked into a band).
    session.recordAssistantMessage('🏁 resolved the theta ask', '2026-06-19T10:06:00Z');
    const answered = session.prepare(appendProfitableTail(second, 'tail two'));
    expect(answered.stats.epochReason).toBe('tail-epoch-append');
    const boundary = answered.sealedBoundary as number;
    const bandText = vaultText(answered.messages.slice(boundary));
    expect(bandText).toContain('OPERATOR-THETA live ask');
    expect(vaultText(answered.messages)).not.toContain('⌖ LIVE');
  });
});
