import { describe, expect, test } from 'vitest';

import {
  ALWAYS_ON_FOLD_CONFIG,
  FOLD_TOMBSTONE_PREFIX,
  FoldSession,
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
});
