import { describe, expect, test } from 'vitest';

import {
  toFoldMessages,
  toOpenCodeMessages,
  extractInputTokens,
  extractSessionId,
  type OCMessage,
  type FoldMessage,
} from '../src/adapter.ts';

// ── Fixtures ────────────────────────────────────────────────────────────

function makeUserMessage(sessionID: string, text: string): OCMessage {
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  return {
    info: {
      role: 'user',
      id,
      sessionID,
      agent: 'build',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
    },
    parts: [
      {
        id: `part_${id}`,
        sessionID,
        messageID: id,
        type: 'text',
        text,
      },
    ],
  };
}

function makeAssistantMessage(
  sessionID: string,
  text: string,
  tokens?: { input: number; output: number; cache?: { read: number; write: number }; total?: number },
): OCMessage {
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  return {
    info: {
      role: 'assistant',
      id,
      sessionID,
      agent: 'build',
      modelID: 'claude-sonnet-4-20250514',
      providerID: 'anthropic',
      cost: 0,
      ...(tokens ? { tokens: { input: tokens.input, output: tokens.output, reasoning: 0, cache: tokens.cache ?? { read: 0, write: 0 }, total: tokens.total } } : {}),
      finish: 'stop',
    },
    parts: [
      {
        id: `part_${id}`,
        sessionID,
        messageID: id,
        type: 'text',
        text,
      },
    ],
  };
}

function makeAssistantWithToolMessage(
  sessionID: string,
  text: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
): OCMessage {
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const callID = `call_${id}`;
  return {
    info: {
      role: 'assistant',
      id,
      sessionID,
      agent: 'build',
      modelID: 'claude-sonnet-4-20250514',
      providerID: 'anthropic',
      cost: 0,
      finish: 'tool_calls',
    },
    parts: [
      {
        id: `part_${id}`,
        sessionID,
        messageID: id,
        type: 'text',
        text,
      },
      {
        id: `part_tool_${id}`,
        sessionID,
        messageID: id,
        type: 'tool',
        callID,
        tool: toolName,
        state: {
          status: 'completed',
          input: toolInput,
          output: toolOutput,
        },
      },
    ],
  };
}

// ── toFoldMessages ──────────────────────────────────────────────────────

describe('toFoldMessages', () => {
  test('converts user + assistant text messages', () => {
    const ocMessages: OCMessage[] = [
      makeUserMessage('s1', 'Hello'),
      makeAssistantMessage('s1', 'Hi there'),
    ];
    const { messages, indexMap } = toFoldMessages(ocMessages);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('Hi there');
    // Identity map should point each FoldMessage object back to its source.
    expect(indexMap.sourceByFoldMessage.get(messages[0])).toBe(0);
    expect(indexMap.sourceByFoldMessage.get(messages[1])).toBe(1);
  });

  test('extracts tool calls and tool results', () => {
    const ocMessages: OCMessage[] = [
      makeUserMessage('s1', 'Read the file'),
      makeAssistantWithToolMessage('s1', 'Reading file...', 'read_file', { path: '/tmp/test.ts' }, 'file contents here'),
    ];
    const { messages } = toFoldMessages(ocMessages);
    // Should produce: user msg, assistant msg with tool_calls, tool result msg
    expect(messages.length).toBeGreaterThanOrEqual(3);
    const assistantMsg = messages.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.tool_calls).toHaveLength(1);

    const toolResultMsg = messages.find((m) => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg!.content).toBe('file contents here');
    expect(toolResultMsg!.tool_call_id).toBeDefined();
  });

  test('skips non-user/assistant roles', () => {
    const ocMessages: OCMessage[] = [
      {
        info: {
          role: 'user',
          id: 'u1',
          sessionID: 's1',
          agent: 'build',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
        },
        parts: [{ id: 'p1', sessionID: 's1', messageID: 'u1', type: 'text', text: 'hi' }],
      },
      {
        info: {
          role: 'system' as any,
          id: 'sys1',
          sessionID: 's1',
          agent: 'build',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
        },
        parts: [{ id: 'p2', sessionID: 's1', messageID: 'sys1', type: 'text', text: 'system msg' }],
      },
    ];
    const { messages } = toFoldMessages(ocMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('hi');
  });

  test('extracts compaction summary text instead of skipping', () => {
    const id = 'comp1';
    const ocMessages: OCMessage[] = [
      {
        info: {
          role: 'user',
          id,
          sessionID: 's1',
          agent: 'build',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
        },
        parts: [
          { id: 'p1', sessionID: 's1', messageID: id, type: 'compaction', auto: true, overflow: true },
          { id: 'p2', sessionID: 's1', messageID: id, type: 'text', text: 'Summary of previous conversation...' },
        ],
      },
    ];
    const { messages } = toFoldMessages(ocMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('Summary of previous conversation');
  });

  test('handles empty input', () => {
    const { messages, indexMap } = toFoldMessages([]);
    expect(messages).toHaveLength(0);
    expect(indexMap.sourceByFoldMessage.size).toBe(0);
  });
});

// ── toOpenCodeMessages ──────────────────────────────────────────────────

describe('toOpenCodeMessages', () => {
  test('passes through original OCMessage objects for unfolded messages', () => {
    const userMsg = makeUserMessage('s1', 'Hello');
    const assistantMsg = makeAssistantMessage('s1', 'Hi');
    const ocMessages = [userMsg, assistantMsg];

    const { messages: foldMessages, indexMap } = toFoldMessages(ocMessages);
    const { messages: result } = toOpenCodeMessages(foldMessages, indexMap, ocMessages, 's1');

    // Should pass through the EXACT same object references
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(userMsg); // same reference!
    expect(result[1]).toBe(assistantMsg); // same reference!
  });

  test('synthesizes fold block as text with correct messageID', () => {
    const userMsg = makeUserMessage('s1', 'Hello');
    const ocMessages = [userMsg];

    // Simulate a CWD fold block message
    const foldMessages: FoldMessage[] = [
      {
        role: 'user',
        content: '[Conversation Context — 3 turns folded, 5K → 2K chars]\n\n(Context note: older turns were auto-folded...\n⌖ COORDINATE CLOSET...\n[End Folded Context]',
      },
      {
        role: 'assistant',
        content: 'Acknowledged. Continuing with the folded context from prior turns.',
      },
    ];
    const indexMap = { sourceByFoldMessage: new Map<FoldMessage, number>() }; // no source mapping

    const { messages: result, foldBlockCount } = toOpenCodeMessages(foldMessages, indexMap, ocMessages, 's1');

    expect(foldBlockCount).toBe(1);
    expect(result).toHaveLength(2);
    expect(result.every((message) => message?.info && Array.isArray(message.parts))).toBe(true);

    // Fold block is a user message
    const foldBlock = result[0];
    expect(foldBlock.info.role).toBe('user');
    expect(foldBlock.parts[0].type).toBe('text');
    expect((foldBlock.parts[0] as any).synthetic).toBe(true);

    // L1 fix: messageID === containing info.id
    expect(foldBlock.parts[0].messageID).toBe(foldBlock.info.id);
  });

  test('preserves tool-call assistant messages in active window', () => {
    const toolMsg = makeAssistantWithToolMessage('s1', 'Using tool', 'bash', { cmd: 'ls' }, 'output');
    const ocMessages = [
      makeUserMessage('s1', 'Run ls'),
      toolMsg,
    ];

    const { messages: foldMessages, indexMap } = toFoldMessages(ocMessages);
    const { messages: result } = toOpenCodeMessages(foldMessages, indexMap, ocMessages, 's1');

    // The assistant message with tool parts should be passed through by reference
    // (not flattened to text)
    expect(result).toHaveLength(2);
    const passedThrough = result.find((m) => m === toolMsg);
    expect(passedThrough).toBe(toolMsg);
    // Verify tool parts are intact
    expect(passedThrough!.parts.some((p) => p.type === 'tool')).toBe(true);
  });
});

// ── extractInputTokens ──────────────────────────────────────────────────

describe('extractInputTokens', () => {
  test('returns undefined for non-message.updated events', () => {
    expect(extractInputTokens({ type: 'session.started' })).toBeUndefined();
  });

  test('returns undefined when no tokens present', () => {
    expect(
      extractInputTokens({ type: 'message.updated', properties: { info: { role: 'assistant' } } }),
    ).toBeUndefined();
  });

  test('uses total when available', () => {
    expect(
      extractInputTokens({
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 2000, write: 100 }, total: 5000 },
          },
        },
      }),
    ).toBe(5000);
  });

  test('computes total from components when total is absent (H2 fix)', () => {
    const result = extractInputTokens({
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 2000, write: 100 } },
        },
      },
    });
    // Should be input + output + cache.read + cache.write = 1000 + 500 + 2000 + 100 = 3600
    expect(result).toBe(3600);
  });

  test('handles partial cache fields', () => {
    const result = extractInputTokens({
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          tokens: { input: 5000, output: 0, reasoning: 0, cache: {} },
        },
      },
    });
    expect(result).toBe(5000);
  });

  test('returns undefined when all values are 0', () => {
    expect(
      extractInputTokens({
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      }),
    ).toBeUndefined();
  });
});

// ── extractSessionId ────────────────────────────────────────────────────

describe('extractSessionId', () => {
  test('extracts session ID from event properties', () => {
    expect(
      extractSessionId({
        type: 'message.updated',
        properties: { info: { sessionID: 'session_abc' } },
      }),
    ).toBe('session_abc');
  });

  test('returns undefined when sessionID is absent', () => {
    expect(
      extractSessionId({
        type: 'message.updated',
        properties: { info: {} },
      }),
    ).toBeUndefined();
  });
});
