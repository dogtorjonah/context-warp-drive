import { describe, expect, it } from 'vitest';
import {
  buildCodexFoldItems,
  resolveCodexFoldSeedMaxChars,
  resolveCodexFoldTargetTokens,
  shouldReconstructCodexEpoch,
  serializeFoldedMessagesToResponsesItems,
  foldMessageToResponsesItem,
  flattenFoldContent,
  DEFAULT_CODEX_FOLD_BAND_FRACTION,
  DEFAULT_CODEX_FOLD_TARGET_TOKENS,
  DEFAULT_CODEX_MIN_TOKENS,
  DEFAULT_CODEX_RECONSTRUCT_INTERVAL,
  type ResponsesMessageItem,
} from '../src/providers/codexCli.ts';
import { DEFAULT_BIRTH_FOLD_MAX_CHARS, type BirthFoldSourceRow } from '../src/foldBirthHydration.ts';
import { buildFoldIndex } from '../src/foldRecall.ts';

// Mirror the construction helper from foldBirthHydration.test.ts so the
// synthetic transcript rows are byte-identical to how the live converter is
// exercised elsewhere.
function row(partial: Partial<BirthFoldSourceRow> & { ty: string }): BirthFoldSourceRow {
  return { tx: null, tn: null, ti: undefined, ts: '2026-06-13T22:41:02.123Z', ...partial };
}

/** N turns of user → tool_use → tool_result → assistant_text, each with bulk. */
function bigTranscript(turns: number): BirthFoldSourceRow[] {
  const rows: BirthFoldSourceRow[] = [];
  for (let i = 0; i < turns; i++) {
    rows.push(row({ ty: 'user', tx: `task ${i}: investigate module ${i} ${'detail '.repeat(30)}` }));
    rows.push(row({ ty: 'tool_use', tn: 'Read', ti: { file_path: `src/mod${i}.ts` } }));
    rows.push(row({ ty: 'tool_result', tn: 'Read', tx: `contents of module ${i} ${'x'.repeat(120)}` }));
    rows.push(row({ ty: 'assistant_text', tx: `finished task ${i}: ${'analysis '.repeat(40)}` }));
  }
  return rows;
}

/** One user turn with many Codex tool steps — the live seed-cap regression shape. */
function codexMarathonTurn(steps: number): BirthFoldSourceRow[] {
  const rows: BirthFoldSourceRow[] = [
    row({ ty: 'user', tx: `start one long autonomous task ${'scope '.repeat(40)}` }),
  ];
  for (let i = 0; i < steps; i++) {
    rows.push(row({ ty: 'tool_use', tn: 'Bash', ti: { command: `sed -n '${i},${i + 20}p' relay/src/file${i}.ts` } }));
    rows.push(row({ ty: 'tool_result', tn: 'Bash', tx: `tool result ${i}: ${'x'.repeat(900)}` }));
    rows.push(row({ ty: 'assistant_text', tx: `step ${i} finding ${'analysis '.repeat(80)}` }));
  }
  return rows;
}

function everyItemText(items: readonly ResponsesMessageItem[]): string {
  return items.map((i) => i.content.map((p) => p.text).join('')).join('\n');
}

describe('buildCodexFoldItems — fold pipeline', () => {
  it('folds a long transcript into a skeleton block including the newest turn', () => {
    const { items, stats, rawMessages, foldedMessages } = buildCodexFoldItems(bigTranscript(30));

    // Continuous folding no longer keeps a hidden newest-turn floor.
    expect(stats.shouldFold).toBe(true);
    expect(stats.turnsToFold).toBe(30);
    expect(stats.foldedChars).toBeLessThan(stats.originalChars);
    expect(stats.savingsPercent).toBeGreaterThan(0);
    expect(stats.emittedItems).toBe(items.length);
    expect(items.length).toBeGreaterThan(0);
    expect(rawMessages.length).toBe(stats.seedMessages);
    expect(foldedMessages.length).toBe(stats.foldedMessages);
    expect(serializeFoldedMessagesToResponsesItems(foldedMessages)).toEqual(items);

    // First item is the synthetic fold block (user / input_text).
    expect(items[0].role).toBe('user');
    expect(items[0].content[0].type).toBe('input_text');
    expect(items[0].content[0].text).toContain('[Conversation Context —');

    // The newest turn is represented inside the folded block, not preserved as a raw tail.
    expect(everyItemText(items)).toContain('finished task 29');
  });

  it('folds a cap-exceeding transcript within a bounded compute budget', () => {
    // 1000 turns ≈ 740k chars > the 600k newest-first cap, so the converter
    // pre-trims before folding: this is the worst-case SYNCHRONOUS compute the
    // relay event loop sees per codex fold epoch (same pipeline + cap as the
    // birth-fold resume pass). Bounded by the cap, not the transcript size.
    const rows = bigTranscript(1000);
    const start = performance.now();
    const { items, stats } = buildCodexFoldItems(rows);
    const elapsedMs = performance.now() - start;
    // eslint-disable-next-line no-console
    console.log(
      `[bounded-compute] buildCodexFoldItems(1000 turns): ${elapsedMs.toFixed(1)}ms, ` +
        `original=${stats.originalChars} folded=${stats.foldedChars} items=${items.length}`,
    );
    expect(stats.shouldFold).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    // Generous ceiling: proves bounded / non-pathological (not a microbench).
    // The birth-fold path runs the identical pipeline on resume in the
    // measured clean/warn band; this guards against a future O(n^2) regression
    // or removal of the newest-first pre-trim cap.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('emits only valid Responses message items with role-correct content parts', () => {
    const { items } = buildCodexFoldItems(bigTranscript(24));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.type).toBe('message');
      expect(['user', 'assistant']).toContain(item.role);
      expect(item.content).toHaveLength(1);
      const part = item.content[0];
      expect(typeof part.text).toBe('string');
      expect(part.text.length).toBeGreaterThan(0); // empty-text items are dropped
      if (item.role === 'user') {
        expect(part.type).toBe('input_text');
      } else {
        expect(part.type).toBe('output_text');
      }
    }
  });

  it('conserves fragile verbatim tokens (uuid + path) from a folded (older) turn', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const path = '/home/jonah/unique-marker-dir/secret-config.ts';
    const rows = bigTranscript(20);
    // Inject the fragile tokens into the OLDEST turn's user message so they are
    // inside the fold zone (not the raw active-window tail).
    rows[0] = row({ ty: 'user', tx: `task 0 with critical id ${uuid} at ${path} ${'detail '.repeat(30)}` });

    const { items, stats } = buildCodexFoldItems(rows);
    expect(stats.shouldFold).toBe(true);
    const allText = everyItemText(items);
    // Coordinate Closet should resurface these in the fold block even though the
    // surrounding prose was skeletonized.
    expect(allText).toContain(uuid);
    expect(allText).toContain(path);
  });

  it('is deterministic for identical input', () => {
    const fixture = bigTranscript(18);
    const first = buildCodexFoldItems(fixture);
    const second = buildCodexFoldItems(fixture);
    expect(second.items).toEqual(first.items);
    expect(second.stats).toEqual(first.stats);
  });

  it('folds a short transcript when explicit epoch reconstruction is requested', () => {
    const { items, stats } = buildCodexFoldItems([
      row({ ty: 'user', tx: 'just one question' }),
      row({ ty: 'assistant_text', tx: 'just one answer' }),
    ]);
    expect(stats.shouldFold).toBe(true);
    const allText = everyItemText(items);
    expect(allText).toContain('[Conversation Context —');
    expect(allText).toContain('just one question');
    expect(allText).toContain('just one answer');
  });

  it('returns no items for empty rows', () => {
    const { items, stats } = buildCodexFoldItems([]);
    expect(items).toEqual([]);
    expect(stats.shouldFold).toBe(false);
    expect(stats.emittedItems).toBe(0);
  });

  it('step-folds a single capped Codex active turn instead of no-oping at one detected turn', () => {
    const { items, stats, rawMessages } = buildCodexFoldItems(codexMarathonTurn(200), {
      maxChars: resolveCodexFoldSeedMaxChars(258_000),
    });

    expect(stats.shouldFold).toBe(true);
    expect(stats.foldReason).toContain('codex active-turn step fold');
    expect(stats.turnsToFold).toBeGreaterThan(0);
    expect(stats.seedMessages).toBe(rawMessages.length);
    expect(rawMessages.length).toBeGreaterThan(2);
    expect(stats.foldedChars).toBeLessThan(stats.originalChars);
    const allText = everyItemText(items);
    expect(allText).toContain('[Conversation Context —');
    expect(allText).toContain('step 199 finding');
  });

  it('makes step-folded Codex steps recall-addressable via recallTurns (no empty index)', () => {
    const { rawMessages, foldedMessages, recallTurns, stats } = buildCodexFoldItems(codexMarathonTurn(200), {
      maxChars: resolveCodexFoldSeedMaxChars(258_000),
    });
    expect(stats.foldReason).toContain('codex active-turn step fold');
    expect(stats.turnsToFold).toBeGreaterThan(1);
    expect(recallTurns).toBeDefined();

    // Fallback: the flattened Codex seed collapses to ONE user turn, so the
    // 2-arg index can only address the whole folded marathon coarsely.
    const naive = buildFoldIndex(rawMessages, foldedMessages);
    expect(naive.entries.length).toBeGreaterThan(0);
    expect(naive.entries.length).toBeLessThan(stats.turnsToFold);

    // FIX: passing the SAME step tiling foldContext used yields exactly one
    // recall entry per folded step, each kind 'turn', within raw bounds.
    const repaired = buildFoldIndex(rawMessages, foldedMessages, recallTurns);
    expect(repaired.entries.length).toBe(stats.turnsToFold);
    expect(repaired.entries.every((e) => e.kind === 'turn')).toBe(true);
    for (const entry of repaired.entries) {
      expect(entry.recency).toBeGreaterThanOrEqual(0);
      expect(entry.recency).toBeLessThan(rawMessages.length);
    }
  });
});

describe('serialization helpers', () => {
  it('flattenFoldContent handles string, null, and array content', () => {
    expect(flattenFoldContent('plain')).toBe('plain');
    expect(flattenFoldContent(null)).toBe('');
    expect(flattenFoldContent(undefined)).toBe('');
    expect(flattenFoldContent(['a', { text: 'b' }, { other: 1 }])).toContain('a');
    expect(flattenFoldContent([{ text: 'hello' }])).toBe('hello');
  });

  it('foldMessageToResponsesItem maps role to the correct content part type', () => {
    expect(foldMessageToResponsesItem({ role: 'user', content: 'q' })).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'q' }],
    });
    expect(foldMessageToResponsesItem({ role: 'assistant', content: 'a' })).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'a' }],
    });
    // Defensive: non-assistant/model roles coerce to user input_text.
    expect(foldMessageToResponsesItem({ role: 'model', content: 'm' }).role).toBe('assistant');
  });

  it('serializeFoldedMessagesToResponsesItems drops empty-text items', () => {
    const items = serializeFoldedMessagesToResponsesItems([
      { role: 'user', content: 'keep me' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'also keep' },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].content[0].text).toBe('keep me');
    expect(items[1].content[0].text).toBe('also keep');
  });
});

describe('shouldReconstructCodexEpoch — epoch predicate', () => {
  it('returns false for non-positive or non-finite usage / window', () => {
    expect(shouldReconstructCodexEpoch(0, 100_000)).toBe(false);
    expect(shouldReconstructCodexEpoch(-5, 100_000)).toBe(false);
    expect(shouldReconstructCodexEpoch(50_000, 0)).toBe(false);
    expect(shouldReconstructCodexEpoch(50_000, -1)).toBe(false);
    expect(shouldReconstructCodexEpoch(Number.NaN, 100_000)).toBe(false);
    expect(shouldReconstructCodexEpoch(50_000, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('returns false below the minimum token floor', () => {
    expect(DEFAULT_CODEX_MIN_TOKENS).toBeGreaterThan(0);
    // Below the floor even though it would clear the band fraction.
    expect(shouldReconstructCodexEpoch(DEFAULT_CODEX_MIN_TOKENS - 1, DEFAULT_CODEX_MIN_TOKENS)).toBe(false);
  });

  it('returns false below the fold band and true at/above it', () => {
    const window = 100_000;
    const band = DEFAULT_CODEX_FOLD_BAND_FRACTION;
    expect(shouldReconstructCodexEpoch(Math.floor(window * band) - 1, window)).toBe(false);
    expect(shouldReconstructCodexEpoch(Math.ceil(window * band) + 1, window)).toBe(true);
  });

  it('uses an absolute fold target on large Codex context windows', () => {
    const window = 1_050_000;
    expect(DEFAULT_CODEX_FOLD_TARGET_TOKENS).toBe(170_000);
    expect(shouldReconstructCodexEpoch(DEFAULT_CODEX_FOLD_TARGET_TOKENS - 1, window)).toBe(false);
    expect(shouldReconstructCodexEpoch(DEFAULT_CODEX_FOLD_TARGET_TOKENS, window)).toBe(true);
    // Regression for the live failure: 232k is far below 75% of 1.05M, but it
    // is above the FC-like steady-state target and must epoch.
    expect(shouldReconstructCodexEpoch(232_469, window, { foldBandFraction: 0.75 })).toBe(true);
  });

  it('keeps the pure predicate default at the historical Codex target', () => {
    const window = 1_050_000;
    expect(DEFAULT_CODEX_FOLD_TARGET_TOKENS).toBe(170_000);
    expect(shouldReconstructCodexEpoch(169_999, window)).toBe(false);
    expect(shouldReconstructCodexEpoch(170_000, window)).toBe(true);
  });

  it('resolves CodexSession fold TRIGGERS through the shared CLI budget below the 200k danger line', () => {
    // The live helper returns foldTriggerTokens, NOT bandTokens. Distinct from
    // the pure-predicate default test above: this path applies message-ceiling
    // runway and pressure clamps around the shared live trigger.
    // 200k window: message ceiling 176k minus 30k runway.
    expect(resolveCodexFoldTargetTokens({
      model: 'codex-5.5',
      contextWindowTokens: 200_000,
      env: {},
    })).toBe(146_000);
    // 258k (real codex-5.5): shared 180K trigger stays below the 200k danger line.
    expect(resolveCodexFoldTargetTokens({
      model: 'codex-5.5',
      contextWindowTokens: 258_000,
      env: {},
    })).toBe(180_000);
    expect(resolveCodexFoldTargetTokens({
      model: 'codex-5.5',
      contextWindowTokens: 1_050_000,
      env: {},
    })).toBe(180_000);
    // Setting the BAND must not move the TRIGGER — guards the thrash regression where
    // wiring the helper to bandTokens collapsed the Codex trigger to 100k.
    expect(resolveCodexFoldTargetTokens({
      model: 'codex-5.5',
      contextWindowTokens: 1_050_000,
      env: { VOXXO_FOLD_TARGET_BAND_TOKENS: '100000' },
    })).toBe(180_000);
  });

  it('honors a custom fold band fraction', () => {
    // 30k of 100k window is below 0.7 default but above an explicit 0.25.
    expect(shouldReconstructCodexEpoch(30_000, 100_000)).toBe(false);
    expect(shouldReconstructCodexEpoch(30_000, 100_000, { foldBandFraction: 0.25 })).toBe(true);
  });

  it('honors a custom minimum token floor', () => {
    expect(shouldReconstructCodexEpoch(5_000, 100_000, { minTokensBeforeFold: 1_000, foldBandFraction: 0.01 })).toBe(true);
  });

  it('applies hysteresis: blocks re-fire until usage grows by one interval', () => {
    const window = 100_000;
    const opts = {
      foldBandFraction: 0.7,
      lastReconstructedAtTokens: 75_000,
      reconstructIntervalTokens: DEFAULT_CODEX_RECONSTRUCT_INTERVAL,
    };
    // In the band (80k ≥ 70k) but only +5k since last reconstruction → blocked.
    expect(shouldReconstructCodexEpoch(75_000 + 5_000, window, opts)).toBe(false);
    // Grown past the interval → allowed again.
    expect(shouldReconstructCodexEpoch(75_000 + DEFAULT_CODEX_RECONSTRUCT_INTERVAL, window, opts)).toBe(true);
  });
});

describe('resolveCodexFoldSeedMaxChars — window-aware seed cap', () => {
  it('shrinks the seed to ~15% of a small (codex-5.5 258K) window', () => {
    // 258_000 * 0.15 * 4 = 154_800 chars ≈ 38.7K tokens. Plus the ~90K
    // system/128-tool overhead, worst-case (saved≈0%) post-fold occupancy is
    // ~129K — half the 258K window, below the 150K fold trigger and far
    // below the wall. Fix for the Voxxo-codex UChw0eb_ crash (264,175 tokens
    // straight through the 258K effective wall).
    expect(resolveCodexFoldSeedMaxChars(258_000)).toBe(154_800);
    expect(resolveCodexFoldSeedMaxChars(258_000)).toBeLessThan(DEFAULT_BIRTH_FOLD_MAX_CHARS);
  });

  it('keeps the event-loop ceiling unchanged on large (≥1M) windows', () => {
    // 1M * 0.15 * 4 = 600K = DEFAULT_BIRTH_FOLD_MAX_CHARS → min() picks the
    // ceiling, so large-window codex behavior is byte-identical to before.
    expect(resolveCodexFoldSeedMaxChars(1_000_000)).toBe(DEFAULT_BIRTH_FOLD_MAX_CHARS);
    // The pre-restart gpt-5.5 window value (1.05M) also pins to the ceiling.
    expect(resolveCodexFoldSeedMaxChars(1_050_000)).toBe(DEFAULT_BIRTH_FOLD_MAX_CHARS);
  });

  it('never raises the event-loop cap across the relay window range', () => {
    for (const window of [200_000, 258_000, 400_000, 1_000_000, 2_000_000]) {
      expect(resolveCodexFoldSeedMaxChars(window)).toBeLessThanOrEqual(DEFAULT_BIRTH_FOLD_MAX_CHARS);
    }
  });

  it('falls back to the ceiling for a non-finite or non-positive window', () => {
    expect(resolveCodexFoldSeedMaxChars(0)).toBe(DEFAULT_BIRTH_FOLD_MAX_CHARS);
    expect(resolveCodexFoldSeedMaxChars(-1)).toBe(DEFAULT_BIRTH_FOLD_MAX_CHARS);
    expect(resolveCodexFoldSeedMaxChars(Number.NaN)).toBe(DEFAULT_BIRTH_FOLD_MAX_CHARS);
    expect(resolveCodexFoldSeedMaxChars(Number.POSITIVE_INFINITY)).toBe(DEFAULT_BIRTH_FOLD_MAX_CHARS);
  });

  it('honors the VOXXO_FOLD_BIRTH_MAX_CHARS operator override as the ceiling', () => {
    // A lower operator ceiling further caps a large window…
    expect(resolveCodexFoldSeedMaxChars(1_000_000, '300000')).toBe(300_000);
    // …but the window-fit value still binds below the override on a small window.
    expect(resolveCodexFoldSeedMaxChars(258_000, '5000000')).toBe(154_800);
    // An invalid override parses to the default ceiling (resolveBirthFoldMaxChars).
    expect(resolveCodexFoldSeedMaxChars(1_000_000, 'not-a-number')).toBe(DEFAULT_BIRTH_FOLD_MAX_CHARS);
  });

  it('applies the degenerate-input floor only on sub-relay windows', () => {
    // 50K window → 50_000*0.6 = 30_000 < 40_000 floor → floor binds. No real
    // relay window is this small (smallest is ~200K → 120K chars, above the floor).
    expect(resolveCodexFoldSeedMaxChars(50_000)).toBe(40_000);
    // 200K (the conservative `claude` engine default) is above the floor.
    expect(resolveCodexFoldSeedMaxChars(200_000)).toBe(120_000);
  });
});
