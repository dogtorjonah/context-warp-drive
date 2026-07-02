import { describe, expect, test } from 'vitest';

import {
  ALWAYS_ON_FOLD_CONFIG,
  DEFAULT_FOLD_PRESSURE_CEILING_TOKENS,
  FoldSession,
  type FoldMessage,
} from '../src/fold.ts';

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

/** One read turn touching a distinct file, with bulky filler so folding bites. */
function readTurn(i: number, path: string): FoldMessage[] {
  const id = `toolu_${i}`;
  return [
    userMsg(`task ${i} inspect ${path}`),
    toolUse('Read', { file_path: path }, id),
    toolResult(id, `body ${i} ` + 'filler content line\n'.repeat(20)),
    assistantMsg(`note ${i} ` + 'reasoning filler. '.repeat(20)),
  ];
}

/** The fold summary block, if one was emitted (empty string when nothing folded). */
function extractFoldBlock(messages: FoldMessage[]): string {
  const block = messages.find(
    (msg) => typeof msg.content === 'string' && msg.content.startsWith('[Conversation Context —'),
  );
  return (block?.content as string | undefined) ?? '';
}

// Folded reads are skeletonized to their PATH reference (the tool_result body is
// dropped), so the path is the durable marker for "this turn was folded".
const FIRST_PATH = '/repo/src/mod0.ts';

function makeSession(readBurstGuard: boolean): FoldSession {
  let now = Date.parse('2026-06-16T00:00:00.000Z');
  return new FoldSession({
    foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
    freeze: { enabled: true, ttlMs: 0, maxTailChars: 1_000_000 },
    eviction: false,
    readBurstGuard,
    now: () => {
      now += 1_000;
      return now;
    },
  });
}

describe('FoldSession read-burst guard', () => {
  // One continuous, still-open read-burst of 6 turns (no >gapEvents pause).
  const burst = Array.from({ length: 6 }, (_, i) => readTurn(i, `/repo/src/mod${i}.ts`)).flat();

  test('guard OFF (default behavior): folds the leading turns of the burst', () => {
    const off = makeSession(false).prepare(burst);
    expect(off.stats.turnsFolded ?? 0).toBeGreaterThan(0);
    expect(extractFoldBlock(off.messages)).toContain(FIRST_PATH);
  });

  test('guard ON: defers the whole open burst — nothing folds, earliest read stays verbatim', () => {
    const off = makeSession(false).prepare(burst);
    const on = makeSession(true).prepare(burst);
    // The entire history is one open burst whose first touch is in turn 0, so the
    // floor is 0 turns: the guard caps turnsToFold to 0.
    expect(on.stats.turnsFolded ?? 0).toBe(0);
    expect(on.stats.turnsFolded ?? 0).toBeLessThan(off.stats.turnsFolded ?? 0);
    // Nothing folded => no fold block => the earliest read was not skeletonized.
    expect(extractFoldBlock(on.messages)).not.toContain(FIRST_PATH);
  });

  test('pressure ceiling OVERRIDES the guard floor (measured tokens only)', () => {
    const off = makeSession(false).prepare(burst);
    const onPressure = makeSession(true).prepare(burst, {
      measuredInputTokens: DEFAULT_FOLD_PRESSURE_CEILING_TOKENS + 1,
    });
    expect(onPressure.stats.pressureCeilingTriggered).toBe(true);
    // Measured pressure bypasses the open-burst floor; it may fold deeper than
    // the steady-state guard-off run under the continuous-fold pressure path.
    expect(onPressure.stats.turnsFolded ?? 0).toBeGreaterThanOrEqual(off.stats.turnsFolded ?? 0);
    expect(onPressure.stats.turnsFolded ?? 0).toBeGreaterThan(0);
    expect(onPressure.stats.epochReason).toBe('hard-epoch');
    expect(JSON.stringify(onPressure.messages)).toContain(FIRST_PATH);
  });

  test('release: once the burst SETTLES, the previously held turns fold normally', () => {
    const settled = [
      ...burst,
      // >gapEvents non-touch messages -> the open burst settles -> guard yields.
      ...Array.from({ length: 26 }, (_, k) => assistantMsg(`idle ${k}`)),
    ];
    const on = makeSession(true).prepare(settled);
    expect(on.stats.turnsFolded ?? 0).toBeGreaterThan(0);
    expect(extractFoldBlock(on.messages)).toContain(FIRST_PATH);
  });
});
