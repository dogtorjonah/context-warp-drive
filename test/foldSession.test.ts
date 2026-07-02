import { describe, expect, test } from 'vitest';

import {
  ALWAYS_ON_FOLD_CONFIG,
  DEFAULT_FOLD_PRESSURE_CEILING_TOKENS,
  FOLD_TOMBSTONE_PREFIX,
  FoldSession,
  HARD_EPOCH_CONTINUITY_DIRECTIVE,
  HARD_EPOCH_LIVE_TURN_HEADER,
  type FoldConfig,
  type FoldMessage,
} from '../src/fold.js';

function userMsg(text: string): FoldMessage {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): FoldMessage {
  return { role: 'assistant', content: text };
}

function anthropicToolUse(name: string, input: Record<string, unknown>, id: string): FoldMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
  };
}

function anthropicToolResult(toolUseId: string, content: string): FoldMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
  };
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function bodyToken(i: number): string {
  return `SESSIONBODY${LETTERS[i]}Q`;
}

function noteToken(i: number): string {
  return `SESSIONNOTE${LETTERS[i]}Q`;
}

function turn(i: number): FoldMessage[] {
  const id = `toolu_session_${i}`;
  return [
    userMsg(`Task ${i} inspect module ${i}`),
    anthropicToolUse('Read', { file_path: `/repo/src/mod${i}.ts` }, id),
    anthropicToolResult(id, `${bodyToken(i)} ` + 'filler content line\n'.repeat(30)),
    assistantMsg(`Module ${i} analysed ${noteToken(i)} ` + 'reasoning filler. '.repeat(40)),
  ];
}

function appendProfitableTurns(history: FoldMessage[], start: number, count = 3): FoldMessage[] {
  const messages = [...history];
  for (let index = 0; index < count; index += 1) {
    messages.push(...turn(start + index));
  }
  return messages;
}

function hybridMarathonHistory(): FoldMessage[] {
  const messages: FoldMessage[] = [
    userMsg('old turn 0'),
    assistantMsg(`old analysis 0 ${'A'.repeat(20_000)}`),
    userMsg('old turn 1'),
    assistantMsg(`old analysis 1 ${'B'.repeat(20_000)}`),
    userMsg('active kickoff: keep grinding through the standalone package rail'),
  ];

  for (let i = 0; i < 28; i += 1) {
    const id = `toolu_standalone_active_${i}`;
    messages.push(
      anthropicToolUse('Read', { file_path: `/home/jonah/context-warp-drive/src/file_${i}.ts` }, id),
      anthropicToolResult(id, `ACTIVE_STEP_${i}_FULL_PAYLOAD\n${'X'.repeat(5_000)}`),
    );
  }

  return messages;
}

function extractFoldBlock(messages: FoldMessage[]): string {
  const block = messages.find(
    msg => typeof msg.content === 'string' && msg.content.startsWith('[Conversation Context —'),
  );
  return (block?.content as string | undefined) ?? '';
}

function makeSession(options: { thresholdChars: number; eviction?: boolean } = { thresholdChars: 6_000 }): FoldSession {
  let now = Date.parse('2026-06-16T00:00:00.000Z');
  return new FoldSession({
    foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
    freeze: { enabled: true, ttlMs: 0, maxTailChars: 1_000_000 },
    eviction: options.eviction === false ? false : { thresholdChars: options.thresholdChars },
    now: () => {
      now += 1_000;
      return now;
    },
  });
}

describe('FoldSession E10 sawtooth eviction', () => {
  test('default prepare() wiring tombstones old folded turns once the age gate opens', () => {
    const session = makeSession({ thresholdChars: 6_000 });
    const messages: FoldMessage[] = [];
    let prepared: FoldMessage[] = [];

    for (let epoch = 0; epoch < 8; epoch++) {
      for (let i = 0; i < 3; i++) {
        messages.push(...turn(epoch * 3 + i));
      }
      prepared = session.prepare(messages).messages;
    }

    const block = extractFoldBlock(prepared);
    const tombstones = block.split('\n').filter(line => line.startsWith(FOLD_TOMBSTONE_PREFIX));
    expect(tombstones.length).toBeGreaterThan(0);
    expect(block).not.toContain(bodyToken(0));
    expect(block).toContain(noteToken(22));
    expect(session.telemetry.evictedTurnCount).toBeGreaterThan(0);
  });

  test('durableCursorIndex lets hosts block eviction until their own persistence catches up', () => {
    const session = makeSession({ thresholdChars: 3_000 });
    const messages: FoldMessage[] = [];
    let prepared: FoldMessage[] = [];

    for (let epoch = 0; epoch < 8; epoch++) {
      for (let i = 0; i < 3; i++) {
        messages.push(...turn(epoch * 3 + i));
      }
      prepared = session.prepare(messages, { durableCursorIndex: 0 }).messages;
    }

    const block = extractFoldBlock(prepared);
    expect(block).not.toContain(FOLD_TOMBSTONE_PREFIX);
    expect(session.telemetry.evictedTurnCount).toBe(0);
  });

  test('pressure ceiling hard-epochs instead of recomputing the over-cap raw floor', () => {
    const makePressureSession = (): FoldSession => {
      let now = Date.parse('2026-06-16T00:00:00.000Z');
      return new FoldSession({
        foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
        freeze: { enabled: true, ttlMs: 3_600_000, maxTailChars: 1_000_000 },
        eviction: { thresholdChars: 1_000_000 },
        pressureCeiling: 10,
        vault: true,
        now: () => {
          now += 1_000;
          return now;
        },
      });
    };
    const messages: FoldMessage[] = [];
    for (let i = 0; i < 6; i++) messages.push(...turn(i));

    const session = makePressureSession();
    session.recordOperatorMessage('OPERATOR-VAULT-COVERS pressure eviction continuity');
    const hardEpoch = session.prepare(messages, { durableCursorIndex: 0, measuredInputTokens: 10 });

    expect(hardEpoch.stats.epochReason).toBe('hard-epoch');
    expect(hardEpoch.messages).toHaveLength(1);
    const body = vaultJoin(hardEpoch.messages);
    expect(body).toContain('[CONTEXT REBIRTH] You are the continuation of "predecessor".');
    expect(body).toContain(noteToken(5));
    expect(body).not.toContain(FOLD_TOMBSTONE_PREFIX);
    expect(session.telemetry.evictedTurnCount).toBe(0);
  });

  test('pressure hard epoch clamps old raw trace while keeping a non-string active turn in the seed', () => {
    const session = new FoldSession({
      foldConfig: {
        ...ALWAYS_ON_FOLD_CONFIG,
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
    const rawText = vaultJoin(raw);
    const preparedText = vaultJoin(prepared.messages);
    expect(preparedText.length).toBeLessThan(rawText.length);
    // The configured raw seed clamp applies before buildHardEpochSeedView appends
    // the live non-string user payload, so allow a small wrapper margin.
    expect(preparedText.length).toBeLessThan(12_000);
    expect(preparedText).toContain('[CONTEXT REBIRTH] You are the continuation of "predecessor".');
    expect(preparedText).toContain('── Raw Trace Coordinate Closet (ids/paths/values preserved from full trace) ──');
    expect(preparedText).toContain('/home/jonah/context-warp-drive/src/file_12.ts');
    expect(preparedText).toContain('ACTIVE_STEP_27_FULL_PAYLOAD');
  });

  test('eviction:false preserves the pre-E10 monotonic fold block behavior', () => {
    const session = makeSession({ thresholdChars: 1, eviction: false });
    const messages: FoldMessage[] = [];
    let prepared: FoldMessage[] = [];

    for (let epoch = 0; epoch < 6; epoch++) {
      for (let i = 0; i < 3; i++) {
        messages.push(...turn(epoch * 3 + i));
      }
      prepared = session.prepare(messages).messages;
    }

    const block = extractFoldBlock(prepared);
    expect(block).not.toContain(FOLD_TOMBSTONE_PREFIX);
    expect(session.telemetry.evictedTurnCount).toBe(0);
  });

  test('measuredInputTokens at the pressure ceiling forces an epoch during hot reuse', () => {
    let now = Date.parse('2026-06-16T00:00:00.000Z');
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: { enabled: true, ttlMs: 3_600_000, maxTailChars: 1_000_000 },
      pressureCeiling: 10,
      now: () => {
        now += 1_000;
        return now;
      },
    });
    const messages = turn(0);

    const first = session.prepare(messages);
    expect(first.cacheHot).toBe(false);
    expect(first.stats.pressureCeilingTokens).toBe(10);
    expect(first.stats.pressureCeilingTriggered).toBe(false);

    const hot = session.prepare(messages, { measuredInputTokens: 9 });
    expect(hot.cacheHot).toBe(true);
    expect(hot.stats.pressureCeilingTokens).toBe(10);
    expect(hot.stats.pressureCeilingTriggered).toBe(false);

    const forced = session.prepare(messages, { measuredInputTokens: 10 });
    expect(forced.cacheHot).toBe(false);
    expect(forced.stats.epochReason).toBe('hard-epoch');
    expect(forced.stats.pressureCeilingTokens).toBe(10);
    expect(forced.stats.pressureCeilingTriggered).toBe(true);
    expect(session.telemetry.epochs).toBe(2);
  });

  test('the default pressure ceiling is the 240k measured-token guard', () => {
    const session = new FoldSession();
    const messages = turn(0);
    const prepared = session.prepare(messages, { measuredInputTokens: DEFAULT_FOLD_PRESSURE_CEILING_TOKENS - 1 });

    expect(prepared.stats.pressureCeilingTokens).toBe(DEFAULT_FOLD_PRESSURE_CEILING_TOKENS);
    expect(prepared.stats.pressureCeilingTriggered).toBe(false);
  });
});

describe('FoldSession tail-epoch runway gate', () => {
  test('appends a folded tail epoch when the fallback modeled runway satisfies the 10k default floor', () => {
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
      now: () => 1_000,
    });
    const first = turn(0);
    const epoch = session.prepare(first);
    const appended = session.prepare(appendProfitableTurns(first, 1));

    expect(epoch.cacheHot).toBe(false);
    expect(appended.cacheHot).toBe(false);
    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.stats.appendDecision).toBe('committed');
    expect(appended.stats.appendSavedChars).toBeGreaterThan(0);
    expect(appended.sealedBoundary).toBe(epoch.messages.length);
    expect(session.telemetry.epochs).toBe(2);
  });

  test('hot-reuses instead of committing an unprofitable append band', () => {
    const session = new FoldSession({
      foldConfig: {
        ...ALWAYS_ON_FOLD_CONFIG,
        activeWindowTurns: 99,
        continuous: false,
        softThresholdChars: 1_000_000,
        hardThresholdChars: 2_000_000,
        maxTurnsBeforeFold: 1_000,
      },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
      now: () => 1_000,
    });
    const first = turn(0);
    const epoch = session.prepare(first);
    const skipped = session.prepare([...first, ...turn(1)]);

    expect(epoch.cacheHot).toBe(false);
    expect(skipped.cacheHot).toBe(true);
    expect(skipped.stats.appendDecision).toBe('skipped');
    expect(skipped.stats.appendSkipReason).toBe('not-smaller');
    expect(skipped.stats.appendRawTailChars).toBeGreaterThan(0);
    expect(skipped.stats.appendBandChars).toBeGreaterThanOrEqual(skipped.stats.appendRawTailChars ?? 0);
    expect(session.telemetry.epochs).toBe(1);
  });

  test('appends a folded tail epoch when measured runway holds even if fallback modeling would fail', () => {
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
      now: () => 1_000,
    });
    const first = turn(0);
    session.prepare(first);
    const appended = session.prepare(appendProfitableTurns(first, 1), { measuredInputTokens: 70_000 });

    expect(appended.cacheHot).toBe(false);
    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.stats.appendDecision).toBe('committed');
    expect(session.telemetry.epochs).toBe(2);
  });

  test('accepts an append when measured runway lands exactly on the 10k floor', () => {
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
      now: () => 1_000,
    });
    const first = turn(0);
    session.prepare(first);
    const appended = session.prepare(appendProfitableTurns(first, 1), { measuredInputTokens: 81_000 });

    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.stats.appendDecision).toBe('committed');
  });

  test('full-recomputes a telemetryless tail epoch when fallback modeling leaves less than the 10k floor', () => {
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
      now: () => 1_000,
    });
    const first = turn(0);
    session.prepare(first);
    const recomputed = session.prepare([...first, ...turn(1)]);

    expect(recomputed.cacheHot).toBe(false);
    expect(recomputed.stats.epochReason).toBe('tail-runway-gate+tail-epoch');
    expect(recomputed.sealedBoundary).toBeNull();
    expect(session.telemetry.epochs).toBe(2);
  });

  test('computes a raw hard-epoch seed from local trace when no host seed is supplied', () => {
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 111_000,
      now: () => 1_000,
    });
    const raw: FoldMessage[] = [
      userMsg('old standalone question'),
      assistantMsg('RAW_PRIOR_TRACE_MARKER standalone answer'),
      userMsg('LIVE_TRIGGER_MARKER current request'),
    ];

    const hardEpoch = session.prepare(raw, { measuredInputTokens: 111_000 });

    expect(hardEpoch.stats.epochReason).toBe('hard-epoch');
    expect(hardEpoch.messages).toHaveLength(1);
    const content = hardEpoch.messages[0]?.content;
    expect(typeof content).toBe('string');
    const body = content as string;
    expect(body).toContain('[CONTEXT REBIRTH] You are the continuation of "predecessor".');
    expect(body).toContain(HARD_EPOCH_CONTINUITY_DIRECTIVE);
    expect(body.split(HARD_EPOCH_CONTINUITY_DIRECTIVE)).toHaveLength(2);
    expect(body).toContain('RAW_PRIOR_TRACE_MARKER');
    expect(body).toContain(HARD_EPOCH_LIVE_TURN_HEADER);
    expect(body).toContain('LIVE_TRIGGER_MARKER current request');
    expect(body.match(/LIVE_TRIGGER_MARKER/g)).toHaveLength(1);
  });

  test('lets a host explicitly force the hard-epoch rebirth seed path', () => {
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 111_000,
      now: () => 1_000,
    });
    const raw: FoldMessage[] = [
      userMsg('old standalone question'),
      assistantMsg('RAW_PRIOR_TRACE_MARKER standalone answer'),
      userMsg('LIVE_TRIGGER_MARKER manual reset request'),
    ];

    const hardEpoch = session.prepare(raw, {
      hardEpoch: true,
      hardEpochSeed: 'HOST_SUPPLIED_STANDALONE_REBIRTH_SEED',
      measuredInputTokens: 10,
    });

    expect(hardEpoch.stats.epochReason).toBe('hard-epoch');
    expect(hardEpoch.stats.pressureCeilingTriggered).toBe(false);
    expect(hardEpoch.messages).toHaveLength(1);
    expect(hardEpoch.sealedBoundary).toBe(1);
    const body = vaultJoin(hardEpoch.messages);
    expect(body).toContain(HARD_EPOCH_CONTINUITY_DIRECTIVE);
    expect(body).toContain('HOST_SUPPLIED_STANDALONE_REBIRTH_SEED');
    expect(body).toContain(HARD_EPOCH_LIVE_TURN_HEADER);
    expect(body).toContain('LIVE_TRIGGER_MARKER manual reset request');

    const appended = session.prepare(appendProfitableTurns(raw, 3), { measuredInputTokens: 10 });
    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.sealedBoundary).toBe(1);
    expect(appended.messages[0]).toEqual(hardEpoch.messages[0]);
  });

  test('does not duplicate a trailing string user turn when followed by tool-result user content', () => {
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 111_000,
      now: () => 1_000,
    });
    const toolId = 'toolu_mixed_trailing_user';
    const raw: FoldMessage[] = [
      userMsg('old standalone question'),
      assistantMsg('RAW_PRIOR_TRACE_MARKER standalone answer'),
      userMsg('LIVE_TRIGGER_MARKER current request'),
      anthropicToolResult(toolId, 'TOOL_RESULT_MARKER non-string trailing user payload'),
    ];

    const hardEpoch = session.prepare(raw, { measuredInputTokens: 111_000 });

    expect(hardEpoch.stats.epochReason).toBe('hard-epoch');
    expect(hardEpoch.messages).toHaveLength(1);
    const body = vaultJoin(hardEpoch.messages);
    expect(body).toContain(HARD_EPOCH_CONTINUITY_DIRECTIVE);
    expect(body.split(HARD_EPOCH_CONTINUITY_DIRECTIVE)).toHaveLength(2);
    expect(body).toContain('RAW_PRIOR_TRACE_MARKER');
    expect(body).toContain('TOOL_RESULT_MARKER non-string trailing user payload');
    expect(body.match(/LIVE_TRIGGER_MARKER/g)).toHaveLength(1);
  });

  test('prepends the continuity directive when a host seed only quotes it later', () => {
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 111_000,
      now: () => 1_000,
    });
    const raw: FoldMessage[] = [
      userMsg('old standalone question'),
      assistantMsg('old standalone answer'),
      userMsg('LIVE_TRIGGER_MARKER current request'),
    ];
    const hostSeed = `Host seed quotes this later:\n${HARD_EPOCH_CONTINUITY_DIRECTIVE}\n\nHOST_SEED_BODY`;

    const hardEpoch = session.prepare(raw, {
      measuredInputTokens: 111_000,
      hardEpochSeed: hostSeed,
    });

    expect(hardEpoch.stats.epochReason).toBe('hard-epoch');
    expect(hardEpoch.messages).toHaveLength(1);
    const body = vaultJoin(hardEpoch.messages);
    expect(body.startsWith(`${HARD_EPOCH_CONTINUITY_DIRECTIVE}\n\n${hostSeed}`)).toBe(true);
    expect(body.split(HARD_EPOCH_CONTINUITY_DIRECTIVE)).toHaveLength(3);
    expect(body).toContain(HARD_EPOCH_LIVE_TURN_HEADER);
    expect(body).toContain('LIVE_TRIGGER_MARKER current request');
  });

  test('appends on the compact seed baseline after a hard epoch when measured runway holds', () => {
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
      now: () => 1_000,
    });
    const raw = [...turn(0), ...turn(1), ...turn(2)];
    const hardEpoch = session.prepare(raw, {
      measuredInputTokens: 111_000,
      hardEpochSeed: 'STANDALONE_HARD_EPOCH_SEED',
    });
    const appended = session.prepare(appendProfitableTurns(raw, 3), { measuredInputTokens: 70_000 });

    expect(hardEpoch.stats.epochReason).toBe('hard-epoch');
    expect(hardEpoch.messages).toHaveLength(1);
    expect(appended.cacheHot).toBe(false);
    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    expect(appended.sealedBoundary).toBe(hardEpoch.messages.length);
    expect(appended.messages[0]).toEqual(hardEpoch.messages[0]);
    expect(JSON.stringify(appended.messages)).not.toContain(bodyToken(0));
    expect(session.telemetry.epochs).toBe(2);
  });

  test('keeps the hard-epoch baseline bypass only for telemetryless fallback routing', () => {
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
      now: () => 1_000,
    });
    const raw = [...turn(0), ...turn(1), ...turn(2)];
    // 1) Hard epoch arms the compact-baseline bypass.
    const hardEpoch = session.prepare(raw, {
      measuredInputTokens: 111_000,
      hardEpochSeed: 'STANDALONE_RESET_HARD_EPOCH_SEED',
    });
    expect(hardEpoch.stats.epochReason).toBe('hard-epoch');
    // 2) Without measured telemetry, the fallback modeled runway is pessimistic
    // after the tiny seed. The legacy baseline bypass remains scoped here only.
    const bypassHistory = appendProfitableTurns(raw, 3);
    const ceilingHistory = appendProfitableTurns(bypassHistory, 6);
    const resumedHistory = appendProfitableTurns(ceilingHistory, 9);
    const bypassed = session.prepare(bypassHistory);
    expect(bypassed.stats.epochReason).toBe('tail-epoch-append+hard-epoch-baseline');
    // 3) A later pressure ceiling hard-epochs again and re-arms the compact baseline.
    const ceiling = session.prepare(ceilingHistory, { measuredInputTokens: 200_000 });
    expect(ceiling.stats.pressureCeilingTriggered).toBe(true);
    expect(ceiling.stats.epochReason).toBe('hard-epoch');
    // 4) The re-armed compact baseline can append through the fallback bypass.
    const resumed = session.prepare(resumedHistory);
    expect(resumed.stats.epochReason).toBe('tail-epoch-append+hard-epoch-baseline');
    expect(resumed.sealedBoundary).toBe(ceiling.messages.length);
  });
});

const VAULT_FOLD_CONFIG: FoldConfig = {
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

function vaultTwoTurns(): FoldMessage[] {
  return [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'alpha beta gamma' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'second answer stays active' },
  ];
}

function vaultGrow(history: FoldMessage[], text: string): FoldMessage[] {
  return [
    ...history,
    { role: 'user', content: `next ${text}` },
    { role: 'assistant', content: `answer ${text}` },
  ];
}

function vaultProfitableTail(label: string): string {
  return `${label} ${'compressible tail detail '.repeat(300)}`;
}

function vaultGrowProfitable(history: FoldMessage[], label: string): FoldMessage[] {
  let next = history;
  for (let index = 0; index < 3; index += 1) {
    next = vaultGrow(next, vaultProfitableTail(`${label} ${index}`));
  }
  return next;
}

function vaultJoin(messages: FoldMessage[]): string {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

function makeVaultSession(overrides: Record<string, unknown> = {}): FoldSession {
  return new FoldSession({
    foldConfig: VAULT_FOLD_CONFIG,
    freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 150_000 },
    vault: true,
    now: () => 1_000,
    ...overrides,
  });
}

describe('FoldSession per-band vault sealing', () => {
  test('bakes the full vault into the frozen view at a full recompute', () => {
    const session = makeVaultSession();
    session.recordOperatorMessage('OPERATOR-ALPHA wants the build green', '2026-06-19T10:00:00Z');
    const epoch = session.prepare(vaultTwoTurns());

    expect(epoch.cacheHot).toBe(false);
    const joined = vaultJoin(epoch.messages);
    expect(joined).toContain('[User Message Vault]');
    expect(joined).toContain('OPERATOR-ALPHA wants the build green');
  });

  test('keeps the vault byte-identical across hot reuses (cached prefix, no per-send re-append)', () => {
    const session = makeVaultSession();
    session.recordOperatorMessage('OPERATOR-BETA pivoted to the parser', '2026-06-19T10:00:00Z');
    const epoch = session.prepare(vaultTwoTurns());
    const hot = session.prepare(vaultTwoTurns());

    expect(hot.cacheHot).toBe(true);
    expect(hot.messages).toEqual(epoch.messages);
    expect(vaultJoin(hot.messages).split('[User Message Vault]').length - 1).toBe(1);
  });

  test('seals only the delta into an appended band, never re-sealing prior rows', () => {
    const session = makeVaultSession({
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 125_000,
    });
    session.recordOperatorMessage('OPERATOR-GAMMA first directive', '2026-06-19T10:00:00Z');
    const first = vaultTwoTurns();
    const epoch = session.prepare(first);
    session.recordOperatorMessage('OPERATOR-DELTA second directive', '2026-06-19T10:05:00Z');
    const appended = session.prepare(vaultGrowProfitable(first, 'tail one'));

    expect(appended.stats.epochReason).toBe('tail-epoch-append');
    const boundary = appended.sealedBoundary as number;
    const bandText = vaultJoin(appended.messages.slice(boundary));
    expect(bandText).toContain('OPERATOR-DELTA second directive');
    expect(bandText).not.toContain('OPERATOR-GAMMA first directive');
    expect(vaultJoin(appended.messages.slice(0, boundary))).toContain('OPERATOR-GAMMA first directive');
    expect(appended.messages.slice(0, boundary)).toEqual(epoch.messages);
  });

  test('re-renders the full vault on a full recompute (sealed set reset)', () => {
    const session = makeVaultSession({
      freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
      pressureCeiling: 91_000,
    });
    session.recordOperatorMessage('OPERATOR-EPSILON one', '2026-06-19T10:00:00Z');
    const first = vaultTwoTurns();
    session.prepare(first);
    session.recordOperatorMessage('OPERATOR-ZETA two', '2026-06-19T10:05:00Z');
    const recomputed = session.prepare(vaultGrow(first, 'tail one'));

    expect(recomputed.stats.epochReason).toBe('tail-runway-gate+tail-epoch');
    const joined = vaultJoin(recomputed.messages);
    expect(joined).toContain('OPERATOR-EPSILON one');
    expect(joined).toContain('OPERATOR-ZETA two');
    expect(joined.split('[User Message Vault]').length - 1).toBe(1);
  });
});
