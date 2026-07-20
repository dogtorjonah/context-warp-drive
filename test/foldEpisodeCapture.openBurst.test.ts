import { describe, expect, test } from 'vitest';

import {
  computeOpenBurst,
  deriveEpisodesFromMessages,
  type EpisodeCaptureIdentity,
} from '../src/foldEpisodeCapture.ts';
import type { FoldMessage } from '../src/fold.ts';

function userMsg(text: string): FoldMessage {
  return { role: 'user', content: text };
}
function assistantMsg(text: string): FoldMessage {
  return { role: 'assistant', content: text };
}
function toolUse(name: string, input: Record<string, unknown>, id: string): FoldMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] };
}
function toolResult(id: string, content: string): FoldMessage {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] };
}
/** One read turn: prompt, Read tool_use (the touch), tool_result, assistant note. */
function readTurn(i: number, path: string): FoldMessage[] {
  const id = `toolu_${i}`;
  return [
    userMsg(`task ${i}`),
    toolUse('Read', { file_path: path }, id),
    toolResult(id, `body ${i}`),
    assistantMsg(`note ${i}`),
  ];
}

const ID: EpisodeCaptureIdentity = {
  workspace: 'w',
  instanceId: 'i',
  nowIso: '2026-06-18T00:00:00.000Z',
  closedBy: 'epoch',
};

describe('computeOpenBurst — read-burst fold-guard boundary', () => {
  test('returns the open trailing burst start + held paths when not settled', () => {
    const messages = [0, 1, 2].flatMap((i) => readTurn(i, `/repo/src/mod${i}.ts`));
    const r = computeOpenBurst(messages);
    // First Read tool_use is message index 1 (0 = user prompt).
    expect(r.openBurstStartIndex).toBe(1);
    expect(r.burstCount).toBe(1);
    expect([...r.heldPaths].sort()).toEqual([
      '/repo/src/mod0.ts',
      '/repo/src/mod1.ts',
      '/repo/src/mod2.ts',
    ]);
  });

  test('returns null when the trailing burst has SETTLED (>gapEvents past last touch)', () => {
    const burst = [0, 1, 2].flatMap((i) => readTurn(i, `/repo/src/mod${i}.ts`));
    // 26 non-touch messages after the burst -> trailingEventGap > gapEvents (25).
    const tail = Array.from({ length: 26 }, (_, k) => assistantMsg(`idle ${k}`));
    const r = computeOpenBurst([...burst, ...tail]);
    expect(r.openBurstStartIndex).toBeNull();
    expect(r.heldPaths).toEqual([]);
  });

  test('returns null when there are no touches', () => {
    const r = computeOpenBurst([userMsg('hi'), assistantMsg('hello')]);
    expect(r.openBurstStartIndex).toBeNull();
    expect(r.burstCount).toBe(0);
  });

  test('keeps a multi-directory burst whole — NO topic-shift seal', () => {
    // src + test + docs touched in one continuous burst: still ONE open burst.
    // This is the empirical decision (rail-f1b6c230): directory is not the unit
    // of topic, so the guard must not split coherent cross-dir work.
    const messages = [
      ...readTurn(0, '/repo/src/feature.ts'),
      ...readTurn(1, '/repo/test/feature.test.ts'),
      ...readTurn(2, '/repo/docs/feature.md'),
    ];
    const r = computeOpenBurst(messages);
    expect(r.burstCount).toBe(1);
    expect(r.openBurstStartIndex).toBe(1);
    expect(r.heldPaths.length).toBe(3);
  });

  test('PARITY: openBurstStartIndex equals deriveEpisodesFromMessages open burst when one exists', () => {
    const messages = [0, 1, 2, 3].flatMap((i) => readTurn(i, `/repo/src/mod${i}.ts`));
    const guard = computeOpenBurst(messages);
    const cap = deriveEpisodesFromMessages(messages, 0, ID, {});
    expect(guard.openBurstStartIndex).not.toBeNull();
    expect(guard.openBurstStartIndex).toBe(cap.openBurstStartIndex);
  });

  test('capture stamps authorName and uses railTitle as an in-window summary fallback', () => {
    const messages: FoldMessage[] = [
      userMsg('wire dormant capture metadata'),
      toolUse('Edit', { file_path: '/repo/src/card.ts' }, 't1'),
      toolResult('t1', 'ok'),
      toolUse('task_rail', {
        mode: 'shoot',
        acks: [{ step_id: 'metadata-step', ack_status: 'done' }],
      }, 't2'),
      toolResult('t2', 'ack'),
    ];
    const result = deriveEpisodesFromMessages(messages, 0, {
      ...ID,
      authorName: 'recall-cartographer',
      railId: 'rail-fixture',
      railStep: 'metadata-step',
      railObjective: 'Populate dormant metadata',
      railTitle: 'Episodic richness hardening',
    });

    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0].authorName).toBe('recall-cartographer');
    expect(result.episodes[0].railId).toBe('rail-fixture');
    expect(result.episodes[0].intent).toBe('Populate dormant metadata');
    expect(result.episodes[0].summary).toBe('Episodic richness hardening');
  });

  test('capture links verdict narration to decisive result evidence or explicit none', () => {
    const withEvidence = deriveEpisodesFromMessages([
      userMsg('debug the evidence gate'),
      toolUse('Read', { file_path: '/repo/src/evidence.ts' }, 't1'),
      {
        role: 'user',
        tsMs: Date.parse('2026-06-18T20:01:00.000Z'),
        content: [{
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'src/evidence.ts:12 failed because expected true but got false',
        }],
      },
      assistantMsg('🏁 Fixed the evidence gate by preserving support.'),
    ], 0, ID, { sealTrailing: true });
    const evidenceAnnotation = withEvidence.episodes[0].annotations[0];
    expect(evidenceAnnotation.evidence).toMatchObject({
      kind: 'tool-result',
      tool: 'Read',
      sourceId: 't1',
      eventIndex: 2,
      ts: '2026-06-18T20:01:00.000Z',
    });
    expect(withEvidence.episodes[0].trace).toContain('expected true but got false');

    const withoutEvidence = deriveEpisodesFromMessages([
      userMsg('debug the generic gate'),
      toolUse('Read', { file_path: '/repo/src/no-evidence.ts' }, 't1'),
      toolResult('t1', 'ok'),
      assistantMsg('🏁 Fixed the generic gate with no decisive result.'),
    ], 0, ID, { sealTrailing: true });
    expect(withoutEvidence.episodes[0].annotations[0]?.evidence).toEqual({ kind: 'none' });
  });

  test('associates each epistemic claim with relevant preceding support', () => {
    const result = deriveEpisodesFromMessages([
      userMsg('debug parser and renderer'),
      toolUse('Read', { file_path: '/repo/src/parser.ts' }, 'parser-call'),
      toolResult('parser-call', 'src/parser.ts:12 beta mismatch caused the regression'),
      assistantMsg('🏁 Fixed the parser beta mismatch.'),
      toolUse('Read', { file_path: '/repo/src/renderer.ts' }, 'renderer-call'),
      toolResult('renderer-call', 'src/renderer.ts:22 omega regression remains in layout'),
      assistantMsg('⚠️ Renderer omega regression remains blocked.'),
    ], 0, ID, { sealTrailing: true });
    const claims = result.episodes[0].annotations.filter((annotation) =>
      annotation.kind === 'narration:verdict' || annotation.kind === 'narration:hazard');
    expect(claims).toHaveLength(2);
    expect(claims[0]?.evidence).toMatchObject({ kind: 'tool-result', sourceId: 'parser-call', eventIndex: 2 });
    expect(claims[1]?.evidence).toMatchObject({ kind: 'tool-result', sourceId: 'renderer-call', eventIndex: 5 });
    expect((result.episodes[0].trace.match(/beta mismatch/g) ?? [])).toHaveLength(1);
    expect((result.episodes[0].trace.match(/omega regression/g) ?? [])).toHaveLength(1);
  });

  test('PARITY: settled trailing burst — guard null, capture resumes past the consumed window', () => {
    const burst = [0, 1, 2].flatMap((i) => readTurn(i, `/repo/src/mod${i}.ts`));
    const tail = Array.from({ length: 26 }, (_, k) => assistantMsg(`idle ${k}`));
    const messages = [...burst, ...tail];
    const guard = computeOpenBurst(messages);
    const cap = deriveEpisodesFromMessages(messages, 0, ID, {});
    // Semantic agreement: nothing is held open. The guard signals that as null;
    // capture resumes its cursor past the whole sealed window (messages.length).
    expect(guard.openBurstStartIndex).toBeNull();
    expect(cap.openBurstStartIndex).toBe(messages.length);
  });
});
