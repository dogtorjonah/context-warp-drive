import { describe, expect, test } from 'vitest';

import {
  buildFoldIndex,
  buildFoldRecallContext,
  createFoldRecallState,
  DEFAULT_FOLD_RECALL_CONFIG,
  extractRecallSignals,
  type SpoolIndexEntry,
} from '../src/foldRecall.ts';
import { RECALL_CARD_PREFIX, RECALL_HINT_PREFIX, type FoldMessage } from '../src/rollingFold.ts';

// ══════════════════════════════════════════════════════════════════════
// Spool entries — relay-evicted artifacts in the fold page table
// ══════════════════════════════════════════════════════════════════════
//
// The relay replaces oversized tool output with a digest BEFORE it reaches the
// transcript, so the bytes are never in raw history. Prior to spool indexing
// these artifacts were invisible to fold recall entirely: no page-table entry,
// no trigger, and (once the digest itself folded out of view) not even a
// recovery handle in the model's POV.

const TARGET = 'relay/src/instanceManager/lifecycle.ts';
const ABS = (p: string) => `/home/jonah/voxxo-swarm/${p}`;

/** Real shape from relay/src/codexSession/toolResultSpool.ts formatSpoolDigest. */
function spoolDigest(
  opts: {
    source?: string;
    category?: string;
    id?: string;
    spoolPath?: string;
    sha256?: string;
    chars?: number;
    body?: string;
  } = {},
): string {
  const {
    source = 'Codex',
    category = 'codex-tool-result-spool',
    id = 'art_7bdadc7d91',
    spoolPath = '/tmp/voxxo-spool/codex-tool-result-spool/art_7bdadc7d91.txt',
    sha256 = '7bdadc7d91f4c2e8a1b0d3f5e6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5',
    chars = 16_439,
    body = '[Head]\nrunning lifecycle sweep…\n[Tail]\nsweep complete',
  } = opts;
  return [
    `[${source} tool-result spool]`,
    `Full raw output scheduled for internal spool: ${id}.`,
    `category: ${category}`,
    `path: ${spoolPath}`,
    `sha256: ${sha256}`,
    `chars: ${chars.toLocaleString('en-US')}`,
    `bytes: ${chars.toLocaleString('en-US')}`,
    '',
    body,
  ].join('\n');
}

function userMsg(text: string): FoldMessage {
  return { role: 'user', content: text };
}

function anthropicToolUse(id: string, name: string, input: Record<string, unknown>): FoldMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] };
}

function anthropicToolResult(toolUseId: string, content: string): FoldMessage {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] };
}

function openaiToolCall(id: string, name: string, args: Record<string, unknown>): FoldMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  } as FoldMessage;
}

function openaiToolResult(callId: string, content: string): FoldMessage {
  return { role: 'tool', content, tool_call_id: callId } as FoldMessage;
}

/** Anthropic history whose Read result was spooled by the relay. */
function anthropicSpoolHistory(digest = spoolDigest()): FoldMessage[] {
  return [
    userMsg('check the lifecycle sweep'),
    anthropicToolUse('tu_spool', 'Read', { file_path: ABS(TARGET) }),
    anthropicToolResult('tu_spool', digest),
  ];
}

/** No fold block in the view ⇒ only spool entries are indexed. */
function spoolIndexFor(raw: FoldMessage[]) {
  return buildFoldIndex(raw, raw.slice());
}

function spoolEntries(raw: FoldMessage[]): SpoolIndexEntry[] {
  return spoolIndexFor(raw).entries.filter((e): e is SpoolIndexEntry => e.kind === 'spool');
}

describe('buildFoldIndex — spool entries', () => {
  test('indexes a relay spool digest with its recovery handle and provenance', () => {
    const entries = spoolEntries(anthropicSpoolHistory());

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('spool:art_7bdadc7d91');
    expect(entries[0].artifactId).toBe('art_7bdadc7d91');
    expect(entries[0].source).toBe('Codex');
    expect(entries[0].category).toBe('codex-tool-result-spool');
    expect(entries[0].sha256).toMatch(/^7bdadc7d91/);
    expect(entries[0].chars).toBe(16_439);
    expect(entries[0].recency).toBe(2);
  });

  test('preserves measured source time and never invents an absent timestamp', () => {
    const timestamped = anthropicSpoolHistory();
    timestamped[2].tsMs = Date.parse('2026-07-19T00:42:13.000Z');

    expect(spoolEntries(timestamped)[0].sourceTimestamp).toBe('2026-07-19T00:42:13.000Z');
    expect(spoolEntries(anthropicSpoolHistory())[0].sourceTimestamp).toBeUndefined();
  });

  test('resolves the TARGET path from the tool_use, never the spool file path', () => {
    // The envelope's `path:` is the artifact's own location on disk. Indexing
    // that would make the entry unreachable by path trigger (no tool ever
    // touches /tmp/voxxo-spool/...) and would pollute path residency with
    // transport coordinates.
    const entries = spoolEntries(anthropicSpoolHistory());

    expect(entries[0].path).toBe(TARGET);
    expect(entries[0].spoolPath).toBe('/tmp/voxxo-spool/codex-tool-result-spool/art_7bdadc7d91.txt');
    expect(entries[0].path).not.toContain('/tmp/');
    expect(entries[0].tool).toBe('Read');
  });

  test('parses OpenAI-shaped histories (tool_calls + role:tool)', () => {
    const raw: FoldMessage[] = [
      userMsg('check the sweep'),
      openaiToolCall('call_spool', 'Read', { file_path: ABS(TARGET) }),
      openaiToolResult('call_spool', spoolDigest({ source: 'Forge', id: 'art_openai01' })),
    ];
    const entries = spoolEntries(raw);

    expect(entries).toHaveLength(1);
    expect(entries[0].artifactId).toBe('art_openai01');
    expect(entries[0].source).toBe('Forge');
    expect(entries[0].path).toBe(TARGET);
    expect(entries[0].tool).toBe('Read');
  });

  test('malformed OpenAI arguments still index (path miss, not an index failure)', () => {
    const raw: FoldMessage[] = [
      userMsg('check'),
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_bad', type: 'function', function: { name: 'Read', arguments: '{not json' } }],
      } as FoldMessage,
      openaiToolResult('call_bad', spoolDigest({ id: 'art_badargs' })),
    ];
    const entries = spoolEntries(raw);

    expect(entries).toHaveLength(1);
    expect(entries[0].tool).toBe('Read');
    expect(entries[0].path).toBe('');
  });

  test('compacted body text quoting the envelope cannot forge an entry', () => {
    // The body is arbitrary tool output. If a grep hit or a pasted log quotes
    // the header mid-line, it must not mint a page-table entry pointing at an
    // artifact id the relay never wrote.
    const forged = [
      'grep results:',
      'docs/spool.md:12:  [Codex tool-result spool]',
      'docs/spool.md:13:  Full raw output scheduled for internal spool: art_FORGED.',
    ].join('\n');
    const raw = anthropicSpoolHistory(forged);

    expect(spoolEntries(raw)).toHaveLength(0);
  });

  test('an envelope without an artifact id is not indexable', () => {
    const headerOnly = ['[Codex tool-result spool]', 'path: /tmp/x.txt', 'sha256: deadbeefdeadbeef'].join('\n');

    expect(spoolEntries(anthropicSpoolHistory(headerOnly))).toHaveLength(0);
  });

  test('deduplicates by artifact id across repeated digests', () => {
    const raw = [
      ...anthropicSpoolHistory(),
      anthropicToolUse('tu_again', 'Read', { file_path: ABS(TARGET) }),
      anthropicToolResult('tu_again', spoolDigest()),
    ];

    expect(spoolEntries(raw)).toHaveLength(1);
  });

  test('ordinary tool results produce no spool entries', () => {
    const raw: FoldMessage[] = [
      userMsg('read it'),
      anthropicToolUse('tu_plain', 'Read', { file_path: ABS(TARGET) }),
      anthropicToolResult('tu_plain', 'export function sweep() { return 1; }'),
    ];

    expect(spoolEntries(raw)).toHaveLength(0);
  });
});

describe('fold recall — spool rendering', () => {
  function stateFor(raw: FoldMessage[]) {
    const state = createFoldRecallState();
    state.index = spoolIndexFor(raw);
    return state;
  }

  const touchTarget = () => extractRecallSignals({ file_path: ABS(TARGET) }, new Set());

  test('a path re-touch surfaces the artifact as a hint carrying its read handle', () => {
    const raw = anthropicSpoolHistory();
    const out = buildFoldRecallContext(stateFor(raw), raw, touchTarget(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.text).not.toBeNull();
    expect(out.hints).toBe(1);
    expect(out.text!).toContain(RECALL_HINT_PREFIX);
    expect(out.text!).toContain('read_spooled_artifact artifact_id: art_7bdadc7d91');
    expect(out.text!).toContain('Codex spool Read');
    expect(out.text!).toContain('never in transcript');
    expect(out.recallIntents).toHaveLength(1);
    expect(out.recallIntents![0]).toMatchObject({
      kind: 'spool-artifact',
      version: 1,
      artifactId: 'art_7bdadc7d91',
      category: 'codex-tool-result-spool',
      reason: 'path-touch',
      resolution: 'excerpt',
      characterBudget: 6_000,
      path: TARGET,
      tool: 'Read',
    });
    expect(out.recallIntents![0].requestedSlices.map((slice) => slice.kind)).toEqual(['range', 'head', 'tail']);
    expect(out.recallIntents![0].requestedSlices.reduce((sum, slice) => sum + slice.maxChars, 0)).toBe(6_000);
  });

  test('pressure downgrades hydration deterministically and auto-compact stays hint-only', () => {
    const raw = anthropicSpoolHistory();
    const critical = buildFoldRecallContext(stateFor(raw), raw, touchTarget(), 'critical', DEFAULT_FOLD_RECALL_CONFIG);
    const autoCompact = buildFoldRecallContext(stateFor(raw), raw, touchTarget(), 'auto_compact', DEFAULT_FOLD_RECALL_CONFIG);

    expect(critical.recallIntents?.[0].characterBudget).toBe(3_000);
    expect(autoCompact.hints).toBe(1);
    expect(autoCompact.recallIntents).toBeUndefined();
  });

  test('claim and exact error signatures earn targeted hydration intents', () => {
    const raw = anthropicSpoolHistory(spoolDigest({ body: '[Head]\nTypeError: autonomic capsule checksum mismatch\n[Tail]\nfailed safely' }));
    const claimSignals = extractRecallSignals(null, new Set([ABS(TARGET)]));
    const errorSignals = extractRecallSignals(null, new Set(), 'TypeError: autonomic capsule checksum mismatch');
    const claim = buildFoldRecallContext(stateFor(raw), raw, claimSignals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    const error = buildFoldRecallContext(stateFor(raw), raw, errorSignals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(claim.recallIntents?.[0].reason).toBe('claim');
    expect(error.recallIntents?.[0].reason).toBe('error-signature');
    expect(error.recallIntents?.[0].requestedSlices[0]).toMatchObject({
      kind: 'match',
      query: 'typeerror: autonomic capsule checksum mismatch',
    });
  });

  test('weak term overlap remains a hint; three distinctive matches earn an intent', () => {
    const raw = [
      ...anthropicSpoolHistory(spoolDigest({ body: 'quartz semaphore inversion diagnostics completed' })),
      anthropicToolUse('tu_filler_a', 'Read', { file_path: ABS('relay/src/fillerA.ts') }),
      anthropicToolResult('tu_filler_a', spoolDigest({ id: 'art_filler_a', body: 'ordinary routing telemetry completed' })),
      anthropicToolUse('tu_filler_b', 'Read', { file_path: ABS('relay/src/fillerB.ts') }),
      anthropicToolResult('tu_filler_b', spoolDigest({ id: 'art_filler_b', body: 'workspace indexing maintenance completed' })),
    ];
    const weak = { touchedPaths: [], claimedPaths: [], terms: ['quartz', 'semaphore'] };
    const strong = { touchedPaths: [], claimedPaths: [], terms: ['inversion', 'quartz', 'semaphore'] };
    const weakOut = buildFoldRecallContext(stateFor(raw), raw, weak, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    const strongOut = buildFoldRecallContext(stateFor(raw), raw, strong, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(weakOut.hints).toBe(1);
    expect(weakOut.recallIntents).toBeUndefined();
    expect(strongOut.hints).toBe(1);
    expect(strongOut.recallIntents?.[0].reason).toBe('term-overlap');
  });

  test('resident spool hints suppress duplicate hydration intents until residency expires', () => {
    const raw = anthropicSpoolHistory();
    const state = stateFor(raw);
    const first = buildFoldRecallContext(state, raw, touchTarget(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    const second = buildFoldRecallContext(state, raw, touchTarget(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(first.recallIntents).toHaveLength(1);
    expect(second.recallIntents).toBeUndefined();
  });

  test('never renders as a card, even at healthy pressure with card budget free', () => {
    // Card rendering pages a body in from raw history; a spool artifact has no
    // raw copy, so carding it could only ever fabricate or crash.
    const raw = anthropicSpoolHistory();
    const out = buildFoldRecallContext(stateFor(raw), raw, touchTarget(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.cards).toBe(0);
    expect(out.text!).not.toContain(RECALL_CARD_PREFIX);
  });

  test('does not offer the spool file path as a recovery handle', () => {
    // `path:` looks more actionable than the opaque id while being the wrong
    // argument — read_spooled_artifact takes artifact_id, not a filesystem path.
    const raw = anthropicSpoolHistory();
    const out = buildFoldRecallContext(stateFor(raw), raw, touchTarget(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.text!).not.toContain('/tmp/voxxo-spool/');
    expect(out.text!).not.toContain('self-tap to recover');
  });

  test('an untouched path stays silent', () => {
    const raw = anthropicSpoolHistory();
    const unrelated = extractRecallSignals({ file_path: ABS('relay/src/unrelated.ts') }, new Set());
    const out = buildFoldRecallContext(stateFor(raw), raw, unrelated, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(out.hints).toBe(0);
    expect(out.cards).toBe(0);
  });

  test('deterministic: identical inputs render byte-identical output', () => {
    const raw = anthropicSpoolHistory();
    const a = buildFoldRecallContext(stateFor(raw), raw, touchTarget(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    const b = buildFoldRecallContext(stateFor(raw), raw, touchTarget(), 'healthy', DEFAULT_FOLD_RECALL_CONFIG);

    expect(a.text).toBe(b.text);
  });
});
