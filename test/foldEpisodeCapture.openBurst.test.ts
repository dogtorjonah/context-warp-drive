import { describe, expect, test } from 'vitest';

import {
  computeOpenBurst,
  deriveEpisodesFromMessages,
  type EpisodeCaptureIdentity,
} from '../src/foldEpisodeCapture.js';
import type { FoldMessage } from '../src/fold.js';

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
