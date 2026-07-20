import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildArtifactModeBody,
  foldArtifactOnlyEnabled,
  foldContext,
  FoldSession,
  FOLD_BLOCK_PREAMBLE_ARTIFACT,
  FOLD_BLOCK_PREAMBLE_SIGNATURE,
  FOLD_TOMBSTONE_PREFIX,
  type FoldConfig,
  type FoldMessage,
} from '../src/index.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

const TEST_FOLD_CONFIG: FoldConfig = {
  activeWindowTurns: 0,
  softThresholdChars: 1_000_000,
  hardThresholdChars: 2_000_000,
  maxTurnsBeforeFold: 100,
  continuous: true,
  assistantTextBudget: { fullRetentionChars: 10, essenceRetentionChars: 0 },
  verbatimKeepChars: 4000,
};

function toolUse(id: string, name: string, input: Record<string, unknown>, tsMs?: number): FoldMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
    ...(tsMs !== undefined ? { tsMs } : {}),
  };
}

function toolResult(id: string, text: string, tsMs?: number): FoldMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: text }],
    ...(tsMs !== undefined ? { tsMs } : {}),
  };
}

const T1 = Date.UTC(2026, 6, 20, 8, 0, 0);
const T2 = Date.UTC(2026, 6, 20, 8, 5, 0);
const T3 = Date.UTC(2026, 6, 20, 8, 10, 0);

/** Representative fold fixture: user question → read → edit → test → decision prose. */
function representativeFixture(): FoldMessage[] {
  return [
    { role: 'user', content: 'fix the classifier in src/a.ts', tsMs: T1 },
    toolUse('r1', 'Read', { file_path: '/home/jonah/repo/src/a.ts' }, T1),
    toolResult('r1', 'classifier source contents', T1),
    toolUse('e1', 'Edit', { file_path: '/home/jonah/repo/src/a.ts', old_string: 'oldFn', new_string: 'newFn' }, T2),
    toolResult('e1', 'ok applied a1b2c3d4e5f6', T2),
    toolUse('t1', 'Bash', { command: 'npx vitest run src/a.test.ts' }, T3),
    toolResult('t1', ' Test Files  1 passed (1)\n      Tests  9 passed (9)\n', T3),
    { role: 'assistant', content: '🏁 The fix is the classifier ordering because errors must win over the default lane. Tests: 9 passed.', tsMs: T3 },
    { role: 'user', content: 'active question stays raw', tsMs: T3 },
    { role: 'assistant', content: 'active answer stays raw', tsMs: T3 },
  ];
}

function foldBlockText(messages: FoldMessage[], config: FoldConfig, turnsToFold = 3): string {
  const result = foldContext(messages, turnsToFold, config);
  const block = result.messages.find(m =>
    typeof m.content === 'string' && m.content.includes(FOLD_BLOCK_PREAMBLE_SIGNATURE));
  expect(block, 'fold block present').toBeDefined();
  return block!.content as string;
}

describe('foldArtifactOnlyEnabled — env flag accessor', () => {
  it('defaults to false when unset or unrecognized', () => {
    vi.stubEnv('VOXXO_FOLD_ARTIFACT_ONLY', '');
    expect(foldArtifactOnlyEnabled()).toBe(false);
    vi.stubEnv('VOXXO_FOLD_ARTIFACT_ONLY', '0');
    expect(foldArtifactOnlyEnabled()).toBe(false);
    vi.stubEnv('VOXXO_FOLD_ARTIFACT_ONLY', 'sometimes');
    expect(foldArtifactOnlyEnabled()).toBe(false);
  });

  it('accepts 1/true/on/yes case-insensitively', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'yes']) {
      vi.stubEnv('VOXXO_FOLD_ARTIFACT_ONLY', v);
      expect(foldArtifactOnlyEnabled(), v).toBe(true);
    }
  });
});

describe('artifact-mode band body — flag off byte identity', () => {
  it('foldContext without a builder is unchanged by the env flag (injection is the switch)', () => {
    const unset = foldBlockText(representativeFixture(), TEST_FOLD_CONFIG);
    vi.stubEnv('VOXXO_FOLD_ARTIFACT_ONLY', '1');
    const set = foldBlockText(representativeFixture(), TEST_FOLD_CONFIG);
    expect(set).toBe(unset);
    expect(set).not.toContain('[Fold receipts');
    expect(set).not.toContain('ARTIFACT MODE');
  });

  it('skeleton mode is deterministic across runs (golden compare)', () => {
    const first = foldBlockText(representativeFixture(), TEST_FOLD_CONFIG);
    const second = foldBlockText(representativeFixture(), TEST_FOLD_CONFIG);
    expect(second).toBe(first);
    // Skeleton grammar present: capped tool one-liners or retained text.
    expect(first).toContain('📖 src/a.ts');
  });
});

describe('artifact-mode band body — flag on', () => {
  const artifactConfig: FoldConfig = { ...TEST_FOLD_CONFIG, artifactModeBody: buildArtifactModeBody };

  it('replaces skeleton rows with receipts, provenance header, artifacts, and literals', () => {
    const skeletonBlock = foldBlockText(representativeFixture(), TEST_FOLD_CONFIG);
    const artifactBlock = foldBlockText(representativeFixture(), artifactConfig);

    // Receipts + totality header.
    expect(artifactBlock).toContain('[Fold receipts — 3 tool call(s): 1 edit(s) · 1 test run(s)');
    expect(artifactBlock).toContain('aggregated: 1 read/search');
    // Chronological Provenance header.
    expect(artifactBlock).toContain('fold-artifact-band');
    expect(artifactBlock).toContain('synthesized-history');
    // Receipt lines carry source-time prefixes.
    expect(artifactBlock).toContain('[8:05 AM] ✏️ src/a.ts');
    expect(artifactBlock).toContain('[8:10 AM] 🧪 npx vitest run src/a.test.ts → Test Files  1 passed (1) · Tests  9 passed (9)');
    // Cognitive artifact from the 🏁 decision prose.
    expect(artifactBlock).toContain('cognitive-waypoints');
    // Conserved literal pool line.
    expect(artifactBlock).toContain('⌖ literals:');
    expect(artifactBlock).toContain('a1b2c3d4e5f6');
    // The skeleton-mode rows are gone.
    const skeletonOnlyLine = '📖 src/a.ts';
    expect(skeletonBlock).toContain(skeletonOnlyLine);
    expect(artifactBlock).not.toContain(skeletonOnlyLine);
    expect(artifactBlock).not.toContain(' more tool calls');
    // Preamble keeps the carrier-detection signature.
    expect(artifactBlock).toContain(FOLD_BLOCK_PREAMBLE_SIGNATURE);
    expect(artifactBlock).toContain('ARTIFACT MODE');
  });

  it('artifact mode is deterministic across runs', () => {
    const first = foldBlockText(representativeFixture(), artifactConfig);
    const second = foldBlockText(representativeFixture(), artifactConfig);
    expect(second).toBe(first);
  });

  it('eviction re-compiles receipts over survivors and tombstones the evicted', () => {
    const config: FoldConfig = { ...artifactConfig, verbatimKeepChars: 0 };
    const result = foldContext(representativeFixture(), 3, config, {
      evictedSpans: [{ fromOrdinal: 0, toOrdinalExclusive: 1, turnCount: 1, firstEvictedIso: '2026-07-20T08:00:00.000Z', lastEvictedIso: '2026-07-20T08:00:00.000Z' }],
      evictableThroughOrdinal: 1,
      thresholdChars: 0,
      nowIso: '2026-07-20T08:00:00.000Z',
    });
    const block = result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes(FOLD_BLOCK_PREAMBLE_SIGNATURE));
    const text = block!.content as string;
    expect(text).toContain(FOLD_TOMBSTONE_PREFIX);
    // Receipts re-compiled over survivors: the evicted turn carried every
    // tool call, so the header must shrink to zero — a stale compile would
    // still show the edit receipt.
    expect(text).toContain('[Fold receipts — 0 tool call(s): none');
    expect(text).not.toContain('✏️');
    expect(text).not.toContain('📖 src/a.ts');
  });
});

describe('FoldSession env integration', () => {
  const fixtureHistory = (): FoldMessage[] => [
    { role: 'user', content: 'question one', tsMs: T1 },
    toolUse('e1', 'Edit', { file_path: '/home/jonah/repo/src/a.ts', old_string: 'a', new_string: 'b' }, T1),
    toolResult('e1', 'ok', T1),
    { role: 'user', content: 'question two', tsMs: T2 },
    { role: 'assistant', content: 'answer two', tsMs: T2 },
    { role: 'user', content: 'active question', tsMs: T3 },
    { role: 'assistant', content: 'active answer', tsMs: T3 },
  ];

  it('flag off: session fold renders skeleton block (byte-identical to pre-feature)', () => {
    vi.stubEnv('VOXXO_FOLD_ARTIFACT_ONLY', '0');
    const session = new FoldSession({ foldConfig: TEST_FOLD_CONFIG, freeze: false });
    const outcome = session.prepare(fixtureHistory());
    const block = outcome.result?.messages.find(m =>
      typeof m.content === 'string' && m.content.includes(FOLD_BLOCK_PREAMBLE_SIGNATURE));
    expect(block).toBeDefined();
    expect(block!.content as string).not.toContain('[Fold receipts');
    expect(block!.content as string).toContain('✏️ src/a.ts');
  });

  it('flag on: session fold renders artifact block, and flipping the flag back re-renders skeletons without restart', () => {
    vi.stubEnv('VOXXO_FOLD_ARTIFACT_ONLY', '1');
    const session = new FoldSession({ foldConfig: TEST_FOLD_CONFIG, freeze: false });
    const artifactOutcome = session.prepare(fixtureHistory());
    const artifactBlock = artifactOutcome.result?.messages.find(m =>
      typeof m.content === 'string' && m.content.includes(FOLD_BLOCK_PREAMBLE_SIGNATURE));
    expect(artifactBlock).toBeDefined();
    const artifactText = artifactBlock!.content as string;
    expect(artifactText).toContain('[Fold receipts — 1 tool call(s): 1 edit(s)');
    expect(artifactText).toContain('fold-artifact-band');
    expect(artifactText).toContain(FOLD_BLOCK_PREAMBLE_ARTIFACT);

    // Same session, env flipped off: next fold render is byte-identical to the
    // never-enabled skeleton render — the restart-free toggle contract.
    vi.stubEnv('VOXXO_FOLD_ARTIFACT_ONLY', '0');
    const skeletonOutcome = session.prepare(fixtureHistory());
    const skeletonBlock = skeletonOutcome.result?.messages.find(m =>
      typeof m.content === 'string' && m.content.includes(FOLD_BLOCK_PREAMBLE_SIGNATURE));
    const pristine = new FoldSession({ foldConfig: TEST_FOLD_CONFIG, freeze: false });
    const pristineOutcome = pristine.prepare(fixtureHistory());
    const pristineBlock = pristineOutcome.result?.messages.find(m =>
      typeof m.content === 'string' && m.content.includes(FOLD_BLOCK_PREAMBLE_SIGNATURE));
    expect(skeletonBlock!.content).toBe(pristineBlock!.content);
  });
});
