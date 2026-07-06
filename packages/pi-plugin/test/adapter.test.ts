/**
 * Adapter tests — bidirectional Pi AgentMessage ↔ CWD FoldMessage mapping.
 *
 * Mirrors the OpenCode plugin test structure but adapted for Pi's simpler
 * flat { role, content, timestamp } message format.
 */

import { describe, it, expect } from 'vitest';
import {
  toFoldMessages,
  toPiMessages,
  extractInputTokens,
  type PiMessage,
  type PiUserMessage,
  type PiAssistantMessage,
  type PiToolResultMessage,
} from '../src/adapter.ts';

// ── Helpers ────────────────────────────────────────────────────────────

let counter = 0;
function ts(): number {
  return 1_000_000 + counter++;
}

function makeUserMessage(text: string): PiUserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: ts(),
  };
}

function makeAssistantMessage(text: string, usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): PiAssistantMessage {
  const content: any[] = [{ type: 'text', text }];
  return {
    role: 'assistant',
    content,
    usage: usage
      ? {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
          totalTokens: usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
        }
      : undefined,
    stopReason: 'stop',
    timestamp: ts(),
  };
}

function makeToolCallAssistantMessage(toolName: string, args: Record<string, unknown>): PiAssistantMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: `Calling ${toolName}` },
      { type: 'toolCall', id: `call_${counter++}`, name: toolName, arguments: args },
    ],
    usage: undefined,
    stopReason: 'toolUse',
    timestamp: ts(),
  };
}

function makeToolResultMessage(toolCallId: string, toolName: string, output: string, isError = false): PiToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text: output }],
    isError,
    timestamp: ts(),
  };
}

function makeConversation(n: number): PiMessage[] {
  const messages: PiMessage[] = [];
  for (let i = 0; i < n; i++) {
    messages.push(makeUserMessage(`User message ${i}`));
    messages.push(
      makeAssistantMessage(`Assistant reply ${i}`, { input: 1000 + i * 100, output: 500 + i * 50 }),
    );
  }
  return messages;
}

function textOf(msg: PiMessage): string {
  if (msg.role === 'user') {
    const content = (msg as PiUserMessage).content;
    if (typeof content === 'string') return content;
    return content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { type: 'text'; text: string }).text)
      .join('\n');
  } else if (msg.role === 'assistant') {
    return (msg as PiAssistantMessage).content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { type: 'text'; text: string }).text)
      .join('\n');
  }
  return '';
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('toFoldMessages — Pi → CWD', () => {
  it('converts user messages', () => {
    const result = toFoldMessages([makeUserMessage('Hello world')]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toBe('Hello world');
  });

  it('converts assistant messages with text', () => {
    const result = toFoldMessages([makeAssistantMessage('Hi there')]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].content).toBe('Hi there');
  });

  it('converts assistant messages with tool calls', () => {
    const result = toFoldMessages([
      makeToolCallAssistantMessage('bash', { command: 'ls -la' }),
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].tool_calls).toBeDefined();
    const toolCalls = result.messages[0].tool_calls as unknown[];
    expect(toolCalls).toHaveLength(1);
    const tc = toolCalls[0] as { function: { name: string; arguments: string } };
    expect(tc.function.name).toBe('bash');
    expect(JSON.parse(tc.function.arguments)).toEqual({ command: 'ls -la' });
  });

  it('converts tool result messages', () => {
    const result = toFoldMessages([
      makeToolResultMessage('call_1', 'bash', 'file1.txt\nfile2.txt'),
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('tool');
    expect(result.messages[0].content).toContain('file1.txt');
    expect(result.messages[0].tool_call_id).toBe('call_1');
    expect(result.messages[0].name).toBe('bash');
  });

  it('marks tool errors in content', () => {
    const result = toFoldMessages([
      makeToolResultMessage('call_1', 'bash', 'Command not found', true),
    ]);
    expect(result.messages[0].content).toContain('[Tool Error]');
    expect(result.messages[0].content).toContain('Command not found');
  });

  it('handles string user content (not array)', () => {
    const result = toFoldMessages([
      { role: 'user', content: 'plain string', timestamp: ts() },
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('plain string');
  });

  it('preserves thinking content as reasoning_content', () => {
    const result = toFoldMessages([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me consider...' },
          { type: 'text', text: 'Result' },
        ],
        usage: undefined,
        stopReason: 'stop',
        timestamp: ts(),
      },
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].reasoning_content).toBe('Let me consider...');
  });

  it('handles full conversation round-trip identity', () => {
    const conv = makeConversation(10);
    const result = toFoldMessages(conv);
    expect(result.messages).toHaveLength(20); // 10 user + 10 assistant

    // Every fold message must map back to a source index
    for (const [fm, idx] of result.indexMap.sourceByFoldMessage) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(conv.length);
    }
  });

  it('skips bashExecution and custom messages', () => {
    const result = toFoldMessages([
      { role: 'user', content: 'hi', timestamp: ts() } as PiMessage,
      { role: 'bashExecution', command: 'ls', output: '', exitCode: 0, cancelled: false, truncated: false, timestamp: ts() } as unknown as PiMessage,
      { role: 'custom', customType: 'test', content: 'test', display: true, timestamp: ts() } as unknown as PiMessage,
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('hi');
  });
});

describe('toPiMessages — CWD → Pi', () => {
  it('passes through active window messages by identity', () => {
    const conv = makeConversation(5);
    const { messages: foldMessages, indexMap } = toFoldMessages(conv);
    const { messages: result } = toPiMessages(foldMessages, indexMap, conv);

    // When no folding happens, we get back all original messages
    expect(result.length).toBeGreaterThan(0);
    // Original objects preserved by reference for active window
    expect(result[0]).toBe(conv[0]);
  });

  it('deduplicates source indices (multi-fold-message per source)', () => {
    const conv: PiMessage[] = [
      makeUserMessage('test'),
      makeToolCallAssistantMessage('bash', { command: 'ls' }),
      makeToolResultMessage('call_0', 'bash', 'output'),
    ];
    const { messages: foldMessages, indexMap } = toFoldMessages(conv);
    const { messages: result } = toPiMessages(foldMessages, indexMap, conv);

    // Each source message appears at most once
    const resultSet = new Set(result);
    for (const msg of result) {
      expect(resultSet.has(msg)).toBe(true);
    }
    // No duplicate source objects
    const refs = result.filter((r) => conv.includes(r));
    expect(new Set(refs).size).toBe(refs.length);
  });
});

describe('extractInputTokens', () => {
  it('extracts totalTokens from assistant messages', () => {
    const msg = makeAssistantMessage('test', { input: 100, output: 50 });
    expect(extractInputTokens(msg)).toBe(150);
  });

  it('includes cache reads in fallback sum', () => {
    const msg: PiAssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'test' }],
      usage: {
        input: 100,
        output: 50,
        cacheRead: 200,
        cacheWrite: 0,
        totalTokens: 0, // zero totalTokens forces fallback
      },
      stopReason: 'stop',
      timestamp: ts(),
    };
    expect(extractInputTokens(msg)).toBe(350); // 100 + 50 + 200 + 0
  });

  it('returns undefined for non-assistant messages', () => {
    expect(extractInputTokens(makeUserMessage('test'))).toBeUndefined();
  });

  it('returns undefined when usage is missing', () => {
    const msg: PiAssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'test' }],
      timestamp: ts(),
    };
    expect(extractInputTokens(msg)).toBeUndefined();
  });
});
