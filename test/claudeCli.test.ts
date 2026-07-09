import { describe, expect, it } from 'vitest';
import {
  buildClaudeCliFold,
  buildClaudeCliFoldChain,
  buildClaudeCliHardEpochChain,
  resolveClaudeCliFoldTargetTokens,
  resolveClaudeCliPressureCeilingTokens,
  resolveClaudeCliHardEpochCeilingTokens,
  resolveClaudeCliFoldSeedMaxChars,
  shouldReconstructClaudeCliEpoch,
  DEFAULT_CLAUDE_CLI_RECONSTRUCT_RUNWAY_TOKENS,
  DEFAULT_CLAUDE_CLI_RECONSTRUCT_INTERVAL,
  CLAUDE_CLI_MODEL_FALLBACK,
  CLAUDE_CLI_JSONL_VERSION_FALLBACK,
  type ClaudeCliJsonlLine,
  type ClaudeCliMessageLine,
  type ClaudeCliLastPromptLine,
} from '../src/providers/claudeCli.ts';
import { resolveContextBudget } from '../src/contextBudget.ts';
import { DEFAULT_CODEX_FOLD_BAND_FRACTION } from '../src/providers/codexCli.ts';
import { DEFAULT_BIRTH_FOLD_MAX_CHARS, type BirthFoldSourceRow } from '../src/foldBirthHydration.ts';
import { HARD_EPOCH_LIVE_TURN_HEADER, HARD_EPOCH_CONTINUITY_DIRECTIVE } from '../src/foldFreeze.ts';
import type { FoldMessage } from '../src/rollingFold.ts';

// ── Determinism harness ──
// uuids + timestamps are decoration; injecting a counter UUID + fixed base
// makes the serialized chain byte-deterministic so determinism is provable.
const BASE_MS = 1_700_000_000_000;
function seqUuid(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`;
}
const CWD = '/home/jonah/voxxo-swarm';
const SESSION_ID = 'claude-fold-sess-A';

// Mirror codexFold.test.ts row construction so synthetic transcripts are
// byte-identical to how the shared fold brain is exercised elsewhere.
function row(partial: Partial<BirthFoldSourceRow> & { ty: string }): BirthFoldSourceRow {
  return { tx: null, tn: null, ti: undefined, ts: '2026-06-13T22:41:02.123Z', ...partial };
}
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

function isMessage(l: ClaudeCliJsonlLine): l is ClaudeCliMessageLine {
  return l.type === 'user' || l.type === 'assistant';
}
function chainText(lines: readonly ClaudeCliJsonlLine[]): string {
  return lines
    .filter(isMessage)
    .map((l) => (l.type === 'user' ? l.message.content : l.message.content.map((c) => c.text).join('')))
    .join('\n');
}
/** Assert a chain is a valid Claude Code resume DAG: linear parentUuid chain + leaf pointer. */
function assertValidChain(lines: readonly ClaudeCliJsonlLine[], sessionId: string) {
  expect(lines.length).toBeGreaterThanOrEqual(2);
  const last = lines[lines.length - 1] as ClaudeCliLastPromptLine;
  expect(last.type).toBe('last-prompt');
  const messages = lines.slice(0, -1) as ClaudeCliMessageLine[];
  expect(messages.length).toBeGreaterThan(0);
  let prev: string | null = null;
  for (const m of messages) {
    expect(isMessage(m)).toBe(true);
    expect(m.parentUuid).toBe(prev); // first is null, each links to its predecessor
    expect(m.sessionId).toBe(sessionId);
    expect(m.isSidechain).toBe(false);
    prev = m.uuid;
  }
  expect(last.leafUuid).toBe(messages[messages.length - 1].uuid);
  expect(last.sessionId).toBe(sessionId);
  return { messages, last };
}

describe('buildClaudeCliFold — transcript → Claude Code JSONL fold chain', () => {
  it('folds a long transcript into a valid uuid-linked chain with a last-prompt leaf', () => {
    const { chain, stats } = buildClaudeCliFold(bigTranscript(30), {
      sessionId: SESSION_ID,
      cwd: CWD,
      makeUuid: seqUuid(),
      baseTimeMs: BASE_MS,
    });
    expect(stats.shouldFold).toBe(true);
    const { messages } = assertValidChain(chain.lines, SESSION_ID);
    // First folded message is the synthetic conversation-context block.
    expect(messages[0].type).toBe('user');
    const text = chainText(chain.lines);
    expect(text).toContain('[Conversation Context —');
    // The newest turn is represented INSIDE the folded skeleton, not a raw tail.
    expect(text).toContain('finished task 29');
    // Envelope fields are stamped for resume reconstruction.
    expect(messages[0].cwd).toBe(CWD);
    expect(messages[0].version).toBe(CLAUDE_CLI_JSONL_VERSION_FALLBACK);
    expect(messages[0].userType).toBe('external');
  });

  it('is deterministic for identical input + injected generators', () => {
    const opts = () => ({ sessionId: SESSION_ID, cwd: CWD, makeUuid: seqUuid(), baseTimeMs: BASE_MS });
    const first = buildClaudeCliFold(bigTranscript(18), opts());
    const second = buildClaudeCliFold(bigTranscript(18), opts());
    expect(second.chain.lines).toEqual(first.chain.lines);
    expect(second.stats).toEqual(first.stats);
  });

  it('conserves fragile verbatim tokens (uuid + path) from a folded older turn', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const secretPath = '/home/jonah/unique-marker-dir/secret-config.ts';
    const rows = bigTranscript(20);
    rows[0] = row({ ty: 'user', tx: `task 0 critical id ${uuid} at ${secretPath} ${'detail '.repeat(30)}` });
    const { chain, stats } = buildClaudeCliFold(rows, { sessionId: SESSION_ID, cwd: CWD, makeUuid: seqUuid(), baseTimeMs: BASE_MS });
    expect(stats.shouldFold).toBe(true);
    const text = chainText(chain.lines);
    expect(text).toContain(uuid);
    expect(text).toContain(secretPath);
  });

  it('returns an empty chain (leafUuid null) for empty rows — caller must not rewrite', () => {
    const { chain, stats } = buildClaudeCliFold([], { sessionId: SESSION_ID, cwd: CWD, makeUuid: seqUuid(), baseTimeMs: BASE_MS });
    expect(chain.lines).toEqual([]);
    expect(chain.leafUuid).toBeNull();
    expect(stats.shouldFold).toBe(false);
  });
});

describe('buildClaudeCliFoldChain — serialization', () => {
  const opts = () => ({ sessionId: SESSION_ID, cwd: CWD, makeUuid: seqUuid(), baseTimeMs: BASE_MS });

  it('serializes user → string content and assistant → TEXT-only blocks (never thinking)', () => {
    const folded: FoldMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ];
    const chain = buildClaudeCliFoldChain(folded, opts());
    assertValidChain(chain.lines, SESSION_ID);
    const u = chain.lines[0];
    expect(u.type).toBe('user');
    if (u.type === 'user') expect(u.message.content).toBe('q1');
    const a = chain.lines[1];
    expect(a.type).toBe('assistant');
    if (a.type === 'assistant') {
      expect(a.message.content).toEqual([{ type: 'text', text: 'a1' }]);
      expect(a.message.model).toBe(CLAUDE_CLI_MODEL_FALLBACK);
      expect(a.message.stop_reason).toBe('end_turn');
    }
  });

  it('drops empty-text messages and returns leafUuid null when every message is empty', () => {
    const allEmpty = buildClaudeCliFoldChain([{ role: 'user', content: '' }, { role: 'assistant', content: null }], opts());
    expect(allEmpty.lines).toEqual([]);
    expect(allEmpty.leafUuid).toBeNull();

    const mixed = buildClaudeCliFoldChain([{ role: 'user', content: '' }, { role: 'assistant', content: 'kept' }], opts());
    const { messages, last } = assertValidChain(mixed.lines, SESSION_ID);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('assistant');
    expect(last.leafUuid).toBe(mixed.leafUuid);
  });

  it('derives the last-prompt preview from the leaf text and honors an override', () => {
    const long = 'Z'.repeat(500);
    const derived = buildClaudeCliFoldChain([{ role: 'user', content: long }], opts());
    expect((derived.lines[derived.lines.length - 1] as ClaudeCliLastPromptLine).lastPrompt).toBe(long.slice(0, 200));

    const override = buildClaudeCliFoldChain([{ role: 'user', content: long }], { ...opts(), lastPromptPreview: 'PREVIEW' });
    expect((override.lines[override.lines.length - 1] as ClaudeCliLastPromptLine).lastPrompt).toBe('PREVIEW');
  });

  it('uses deterministic UUIDs and a Unix-epoch clock when replay metadata is omitted', () => {
    const folded: FoldMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const first = buildClaudeCliFoldChain(folded, { sessionId: SESSION_ID, cwd: CWD });
    const second = buildClaudeCliFoldChain(folded, { sessionId: SESSION_ID, cwd: CWD });

    expect(first).toEqual(second);
    const { messages } = assertValidChain(first.lines, SESSION_ID);
    expect(messages.map((m) => m.uuid)).toEqual([
      '00000000-0000-4000-8000-000000000000',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(messages[0].timestamp).toBe('1970-01-01T00:00:00.000Z');
    expect(messages[1].timestamp).toBe('1970-01-01T00:00:01.000Z');
  });
});

describe('epoch predicate + budget resolution', () => {
  it('shouldReconstructClaudeCliEpoch: false for non-positive, true above the fold band', () => {
    const window = 100_000;
    expect(shouldReconstructClaudeCliEpoch(0, window)).toBe(false);
    expect(shouldReconstructClaudeCliEpoch(-5, window)).toBe(false);
    expect(shouldReconstructClaudeCliEpoch(Number.NaN, window)).toBe(false);
    expect(shouldReconstructClaudeCliEpoch(Math.floor(window * DEFAULT_CODEX_FOLD_BAND_FRACTION) - 1, window)).toBe(false);
    expect(shouldReconstructClaudeCliEpoch(Math.ceil(window * DEFAULT_CODEX_FOLD_BAND_FRACTION) + 1, window)).toBe(true);
  });

  it('applies the claude-cli reconstruct interval as hysteresis between folds', () => {
    const window = 100_000;
    const opts = { foldBandFraction: 0.7, lastReconstructedAtTokens: 75_000 };
    expect(shouldReconstructClaudeCliEpoch(75_000 + 5_000, window, opts)).toBe(false); // < one interval since last fold
    expect(shouldReconstructClaudeCliEpoch(75_000 + DEFAULT_CLAUDE_CLI_RECONSTRUCT_INTERVAL, window, opts)).toBe(true);
  });

  it('resolveClaudeCliFoldTargetTokens caps the shared claude trigger by the reconstruct runway', () => {
    const budget = resolveContextBudget({ engine: 'claude', contextWindowTokens: 200_000, env: {} });
    expect(resolveClaudeCliFoldTargetTokens({ contextWindowTokens: 200_000, env: {} })).toBe(
      Math.min(budget.foldTriggerTokens, Math.max(1, budget.messageCeilingTokens - DEFAULT_CLAUDE_CLI_RECONSTRUCT_RUNWAY_TOKENS)),
    );
    // A larger runway lowers (never raises) the trigger.
    expect(resolveClaudeCliFoldTargetTokens({ contextWindowTokens: 200_000, env: {}, reconstructRunwayTokens: 60_000 })).toBe(
      Math.min(budget.foldTriggerTokens, Math.max(1, budget.messageCeilingTokens - 60_000)),
    );
  });

  it('resolveClaudeCliPressureCeilingTokens mirrors the shared budget pressure ceiling', () => {
    const budget = resolveContextBudget({ engine: 'claude', contextWindowTokens: 200_000, env: {} });
    expect(resolveClaudeCliPressureCeilingTokens({ contextWindowTokens: 200_000, env: {} })).toBe(budget.pressureCeilingTokens);
  });

  it('resolveClaudeCliHardEpochCeilingTokens opens a real tail band above the pressure ceiling on big windows', () => {
    // The dogfood bug: on a 1M window, foldTrigger==pressureCeiling==180K, so a CLI
    // session hard-reset the instant it crossed 180K (~18% utilization) with no
    // intervening tail epoch. The hard-epoch ceiling must instead ride at prefix
    // saturation so there is a real [pressureCeiling, hardEpochCeiling) tail band.
    const big = resolveContextBudget({ engine: 'claude', contextWindowTokens: 1_000_000, env: {} });
    expect(big.evictionPolicy).toBe('hard-epoch-on-prefix-saturation');
    const hard = resolveClaudeCliHardEpochCeilingTokens({ contextWindowTokens: 1_000_000, env: {} });
    expect(hard).toBe(Math.max(big.prefixSaturationTokens!, big.pressureCeilingTokens!));
    // The fix: the hard-epoch ceiling is strictly above the pressure ceiling, so a
    // 285K-style spike tail-folds instead of jumping straight to a portable reset.
    expect(hard!).toBeGreaterThan(big.pressureCeilingTokens!);
  });

  it('resolveClaudeCliHardEpochCeilingTokens never fires before the pressure ceiling and keeps survival-tier hard-only', () => {
    for (const window of [200_000, 256_000, 1_000_000]) {
      const budget = resolveContextBudget({ engine: 'claude', contextWindowTokens: window, env: {} });
      const hard = resolveClaudeCliHardEpochCeilingTokens({ contextWindowTokens: window, env: {} });
      if (budget.evictionPolicy === 'hard-epoch-only') {
        // Survival tier: every fold is hard, so the ceiling collapses back to the
        // pressure ceiling (no tail band — deliberate hard-only behavior preserved).
        expect(hard).toBe(budget.pressureCeilingTokens);
      } else {
        expect(hard).toBe(Math.max(budget.prefixSaturationTokens!, budget.pressureCeilingTokens!));
      }
      if (budget.pressureCeilingTokens != null) {
        // A hard epoch must never fire before the session is even under pressure.
        expect(hard!).toBeGreaterThanOrEqual(budget.pressureCeilingTokens);
      }
    }
  });

  it('resolveClaudeCliFoldSeedMaxChars is the shared window-aware seed cap', () => {
    expect(resolveClaudeCliFoldSeedMaxChars(258_000)).toBeLessThan(DEFAULT_BIRTH_FOLD_MAX_CHARS);
    expect(resolveClaudeCliFoldSeedMaxChars(1_000_000)).toBe(DEFAULT_BIRTH_FOLD_MAX_CHARS);
  });
});

describe('buildClaudeCliHardEpochChain — pressure-ceiling live-turn preservation', () => {
  const liveRows = () => [...bigTranscript(8), row({ ty: 'user', tx: 'LIVE-MARKER-9931 please continue the migration' })];

  it('collapses to a single user seed that MERGES the live user turn under the header', () => {
    const { chain, foldedMessages } = buildClaudeCliHardEpochChain(liveRows(), {
      sessionId: SESSION_ID,
      cwd: CWD,
      makeUuid: seqUuid(),
      baseTimeMs: BASE_MS,
    });
    // Hard epoch = exactly one user message + the last-prompt leaf.
    expect(foldedMessages).toHaveLength(1);
    expect(foldedMessages[0].role).toBe('user');
    const { messages } = assertValidChain(chain.lines, SESSION_ID);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('user');
    const seed = messages[0].type === 'user' ? messages[0].message.content : '';
    expect(seed).toContain(HARD_EPOCH_CONTINUITY_DIRECTIVE);
    // The default seed now uses buildRawHardEpochSeed (rich rebirth package),
    // not the old static DEFAULT_CLAUDE_CLI_HARD_EPOCH_SEED_PROMPT.
    expect(seed).toContain('[CONTEXT REBIRTH]');
    expect(seed).toContain(HARD_EPOCH_LIVE_TURN_HEADER);
    expect(seed).toContain('LIVE-MARKER-9931'); // live turn never silently trimmed
  });

  it('uses a custom seed prompt when provided', () => {
    const { chain } = buildClaudeCliHardEpochChain(liveRows(), {
      sessionId: SESSION_ID,
      cwd: CWD,
      seedPrompt: 'CUSTOM-SEED-PROMPT-7',
      makeUuid: seqUuid(),
      baseTimeMs: BASE_MS,
    });
    expect(chainText(chain.lines)).toContain('CUSTOM-SEED-PROMPT-7');
  });

  it('is deterministic given injected generators', () => {
    const opts = () => ({ sessionId: SESSION_ID, cwd: CWD, makeUuid: seqUuid(), baseTimeMs: BASE_MS });
    const first = buildClaudeCliHardEpochChain(liveRows(), opts());
    const second = buildClaudeCliHardEpochChain(liveRows(), opts());
    expect(second.chain.lines).toEqual(first.chain.lines);
    expect(second.foldedMessages).toEqual(first.foldedMessages);
  });

  // ── Head-pinning regression (rail-2dcc0c4f) ──
  // A tool-only transcript (no real user rows — the common autonomous-agent
  // shape) used to collapse into ONE merged assistant mega-block, and the seed
  // builder's front-truncating sections pinned every hard-epoch seed to the
  // block's immutable HEAD: byte-identical seeds across epochs showing
  // birth-era content while new work accumulated invisibly in the tail.
  describe('head-pinning regression (rail-2dcc0c4f)', () => {
    const opts = () => ({ sessionId: SESSION_ID, cwd: CWD, makeUuid: seqUuid(), baseTimeMs: BASE_MS });
    const toolRows = (n: number, offset = 0): BirthFoldSourceRow[] =>
      Array.from({ length: n }, (_, i) => row({
        ty: 'tool_result',
        tn: 'Read',
        tx: `file chunk ${offset + i} content UNIQUE-${offset + i} ${'y'.repeat(80)}`,
      }));

    it('seed advances with the trace: newest activity present, growth changes the seed', () => {
      const base = toolRows(60);
      const first = buildClaudeCliHardEpochChain(base, opts());
      const grown = [
        ...base,
        ...toolRows(20, 100),
        row({ ty: 'tool_result', tn: 'Read', tx: 'NEWEST-MARKER-777 latest work product' }),
      ];
      const second = buildClaudeCliHardEpochChain(grown, opts());
      // The newest tool activity must be visible in the seed body...
      expect(second.seedBodyText).toContain('NEWEST-MARKER-777');
      // ...and appending rows must change the seed (no byte-identical pinning).
      expect(second.seedBodyText).not.toBe(first.seedBodyText);
    });

    it('tool-only transcript keeps per-message granularity (not one merged mega-block)', () => {
      const built = buildClaudeCliHardEpochChain(toolRows(40), opts());
      // Per-row conversion: many raw messages, not 1-2 merged blocks.
      expect(built.rawMessages.length).toBeGreaterThan(10);
      // Newest row content reaches the seed even with zero user rows.
      expect(built.seedBodyText).toContain('UNIQUE-39');
    });
  });
});
