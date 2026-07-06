import { describe, expect, test } from 'vitest';

import { FoldSession } from '../../../src/index.ts';
import ContextWarpDrivePlugin from '../src/index.ts';
import {
  toFoldMessages,
  toOpenCodeMessages,
  type OCMessage,
} from '../src/adapter.ts';

const SESSION_ID = 's1';

function pad(turn: number): string {
  return `This is filler content for turn ${turn}. ${'x'.repeat(3800)}`;
}

function makeUserMessage(turn: number): OCMessage {
  const id = `msg_u${turn}`;
  return {
    info: {
      role: 'user',
      id,
      sessionID: SESSION_ID,
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
    },
    parts: [
      {
        id: `part_${id}`,
        sessionID: SESSION_ID,
        messageID: id,
        type: 'text',
        text: `USER TURN ${turn}: ${pad(turn)}`,
      },
    ],
  };
}

function makeAssistantMessage(turn: number): OCMessage {
  const id = `msg_a${turn}`;
  return {
    info: {
      role: 'assistant',
      id,
      sessionID: SESSION_ID,
      agent: 'build',
      modelID: 'claude-sonnet-4-20250514',
      providerID: 'anthropic',
      cost: 0,
      finish: 'stop',
    },
    parts: [
      {
        id: `part_${id}`,
        sessionID: SESSION_ID,
        messageID: id,
        type: 'text',
        text: `ASSISTANT TURN ${turn}: ${pad(turn)}`,
      },
    ],
  };
}

function makeConversation(turns: number): OCMessage[] {
  const messages: OCMessage[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(makeUserMessage(i), makeAssistantMessage(i));
  }
  return messages;
}

function makeSession(): FoldSession {
  return new FoldSession({
    freeze: true,
    pressureCeiling: 150_000,
    tailEpochRunway: {
      runwayTokens: 45_000,
      minRunwayTokens: 30_000,
    },
    now: () => 1_000_000,
  });
}

function makeAppendEpochSession(): FoldSession {
  return new FoldSession({
    freeze: {
      enabled: true,
      ttlMs: 5 * 60_000,
      maxTailChars: 1_000,
    },
    pressureCeiling: false,
    now: () => 1_000_000,
  });
}

function pluginInput(): Parameters<typeof ContextWarpDrivePlugin>[0] {
  return {
    client: {},
    project: {},
    directory: '/tmp/project',
    worktree: '/tmp/project',
    experimental_workspace: {},
    serverUrl: new URL('http://localhost'),
    $: {},
  };
}

function textOf(message: OCMessage): string {
  const textPart = message.parts.find((part) => part.type === 'text');
  return textPart && 'text' in textPart ? String(textPart.text) : '';
}

function expectValidMessages(messages: OCMessage[]): void {
  for (const message of messages) {
    expect(message).toBeDefined();
    expect(message.info).toBeDefined();
    expect(Array.isArray(message.parts)).toBe(true);
  }
}

function syntheticTexts(messages: OCMessage[]): string[] {
  return messages
    .filter((message) => {
      const textPart = message.parts.find((part) => part.type === 'text');
      return Boolean(textPart && 'synthetic' in textPart && textPart.synthetic);
    })
    .map(textOf);
}

describe('real FoldSession round-trip through the OpenCode adapter', () => {
  test('normal fold preserves the newest live tail by reference', () => {
    const ocMessages = makeConversation(30);
    const session = makeSession();
    const { messages: foldMessages, indexMap } = toFoldMessages(ocMessages);

    const outcome = session.prepare(foldMessages, {});
    expect(outcome.messages.length).toBeLessThan(foldMessages.length);

    const { messages: result, foldBlockCount } = toOpenCodeMessages(
      outcome.messages,
      indexMap,
      ocMessages,
      SESSION_ID,
    );

    expectValidMessages(result);
    expect(foldBlockCount).toBeGreaterThan(0);
    expect(result[0]).not.toBe(ocMessages[0]);
    expect(textOf(result[0])).toContain('[Conversation Context');
    expect(result).toContain(ocMessages[58]);
    expect(result).toContain(ocMessages[59]);
    expect(result[result.length - 1]).toBe(ocMessages[59]);

    const passedThroughIndices = result
      .map((message) => ocMessages.indexOf(message))
      .filter((idx) => idx >= 0);
    expect(passedThroughIndices.every((idx) => idx >= 58)).toBe(true);
  });

  test('pressure hard epoch preserves the synthesized continuity seed', () => {
    const ocMessages = makeConversation(30);
    const session = makeSession();
    const { messages: foldMessages, indexMap } = toFoldMessages(ocMessages);

    const outcome = session.prepare(foldMessages, { measuredInputTokens: 200_000 });
    expect(outcome.messages.length).toBe(1);

    const seedText = String(outcome.messages[0].content ?? '');
    expect(seedText).toContain('Continuity refresh:');

    const { messages: result, foldBlockCount } = toOpenCodeMessages(
      outcome.messages,
      indexMap,
      ocMessages,
      SESSION_ID,
    );

    expectValidMessages(result);
    expect(foldBlockCount).toBeGreaterThan(0);
    expect(result).toHaveLength(1);
    expect(result[0]).not.toBe(ocMessages[0]);
    expect(textOf(result[0])).toBe(seedText);
  });

  test('cache-hot reuse keeps frozen text stable and live tail by reference', () => {
    const firstMessages = makeConversation(30);
    const secondMessages = [...firstMessages, makeUserMessage(30), makeAssistantMessage(30)];
    const session = makeSession();

    const firstFold = toFoldMessages(firstMessages);
    const firstOutcome = session.prepare(firstFold.messages, {});
    const firstResult = toOpenCodeMessages(
      firstOutcome.messages,
      firstFold.indexMap,
      firstMessages,
      SESSION_ID,
    );

    const secondFold = toFoldMessages(secondMessages);
    const secondOutcome = session.prepare(secondFold.messages, {});
    const secondResult = toOpenCodeMessages(
      secondOutcome.messages,
      secondFold.indexMap,
      secondMessages,
      SESSION_ID,
    );

    expect(secondOutcome.cacheHot).toBe(true);
    expectValidMessages(secondResult.messages);
    expect(secondResult.messages).toContain(secondMessages[60]);
    expect(secondResult.messages).toContain(secondMessages[61]);
    expect(secondResult.messages[0]).not.toBe(firstMessages[0]);
    expect(textOf(secondResult.messages[0])).toBe(textOf(firstResult.messages[0]));
  });

  test('plugin fold blocks use OpenCode-specific preamble without false recall claims', async () => {
    const ocMessages = makeConversation(30);
    const hooks = await ContextWarpDrivePlugin(pluginInput(), { pressureCeiling: 150_000, freeze: true });
    const transform = hooks['experimental.chat.messages.transform'];
    expect(transform).toBeDefined();

    await transform!({}, { messages: ocMessages });

    const foldBlockText = textOf(ocMessages[0]);
    expect(foldBlockText).toContain('OpenCode plugin');
    expect(foldBlockText).toContain('COORDINATE CLOSET');
    expect(foldBlockText).not.toContain('[Recalled from fold');
    expect(foldBlockText).not.toContain('Claiming a file');
    expect(foldBlockText).not.toContain('docs/context-folding.md');
  });

  test('tail-epoch append keeps frozen synthetic text stable and next live tail by reference', () => {
    const firstMessages = makeConversation(30);
    const secondMessages = [
      ...firstMessages,
      makeUserMessage(30),
      makeAssistantMessage(30),
      makeUserMessage(31),
      makeAssistantMessage(31),
    ];
    const thirdMessages = [
      ...secondMessages,
      makeUserMessage(32),
      makeAssistantMessage(32),
    ];
    const session = makeAppendEpochSession();

    const firstFold = toFoldMessages(firstMessages);
    session.prepare(firstFold.messages, {});

    const secondFold = toFoldMessages(secondMessages);
    const secondOutcome = session.prepare(secondFold.messages, {});
    expect(secondOutcome.stats.appendDecision).toBe('committed');

    const secondResult = toOpenCodeMessages(
      secondOutcome.messages,
      secondFold.indexMap,
      secondMessages,
      SESSION_ID,
    );
    expectValidMessages(secondResult.messages);
    expect(secondResult.foldBlockCount).toBeGreaterThanOrEqual(2);

    const secondFrozenTexts = syntheticTexts(secondResult.messages);
    expect(secondFrozenTexts.filter((text) => text.includes('[Conversation Context')).length).toBeGreaterThanOrEqual(2);

    const thirdFold = toFoldMessages(thirdMessages);
    const thirdOutcome = session.prepare(thirdFold.messages, {});
    expect(thirdOutcome.cacheHot).toBe(true);

    const thirdResult = toOpenCodeMessages(
      thirdOutcome.messages,
      thirdFold.indexMap,
      thirdMessages,
      SESSION_ID,
    );

    expectValidMessages(thirdResult.messages);
    expect(thirdResult.messages).toContain(thirdMessages[64]);
    expect(thirdResult.messages).toContain(thirdMessages[65]);
    expect(syntheticTexts(thirdResult.messages).slice(0, secondFrozenTexts.length)).toEqual(secondFrozenTexts);
  });
});
