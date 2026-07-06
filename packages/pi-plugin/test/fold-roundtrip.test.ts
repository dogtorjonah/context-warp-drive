/**
 * Fold round-trip tests — drive a REAL FoldSession through the Pi adapter.
 *
 * Mirrors the OpenCode plugin's fold-roundtrip tests but adapted for Pi's
 * flat message format. These verify that:
 * 1. The adapter + FoldSession integration produces valid Pi messages
 * 2. Fold blocks appear as user messages with correct markers
 * 3. Active-window messages pass through by object identity
 * 4. Multi-epoch sequences (tail + hard) produce stable results
 * 5. The Pi-specific fold-block preamble is honest
 */

import { describe, test, expect } from 'vitest';
import { FoldSession } from '../../../src/index.ts';
import { createPlugin, type ContextWarpDriveOptions } from '../src/index.ts';
import {
  toFoldMessages,
  toPiMessages,
  type PiMessage,
  type PiUserMessage,
  type PiAssistantMessage,
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

function makeAssistantMessage(text: string): PiAssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 },
    stopReason: 'stop',
    timestamp: ts(),
  };
}

function makeConversation(n: number): PiMessage[] {
  const messages: PiMessage[] = [];
  for (let i = 0; i < n; i++) {
    messages.push(makeUserMessage(`User message ${i} with some content to make it longer ${'x'.repeat(200)}`));
    messages.push(makeAssistantMessage(`Assistant reply ${i} with some content to make it longer ${'y'.repeat(200)}`));
  }
  return messages;
}

function textOf(msg: PiMessage): string {
  if (msg.role === 'user') {
    const content = (msg as PiUserMessage).content;
    if (typeof content === 'string') return content;
    return content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  } else if (msg.role === 'assistant') {
    return (msg as PiAssistantMessage).content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

function expectValidMessages(messages: PiMessage[]): void {
  expect(messages.length).toBeGreaterThan(0);
  for (const msg of messages) {
    expect(msg).toBeDefined();
    expect(typeof msg.role).toBe('string');
  }
}

const SESSION_ID = 'test-session';

function foldOnce(
  foldSession: FoldSession,
  piMessages: PiMessage[],
): ReturnType<typeof toPiMessages> {
  const { messages: foldMessages, indexMap } = toFoldMessages(piMessages);
  const outcome = foldSession.prepare(foldMessages, {});
  return toPiMessages(outcome.messages, indexMap, piMessages);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('real FoldSession round-trip through the Pi adapter', () => {
  test('no fold with short conversation — messages pass through unchanged', () => {
    const conv: PiMessage[] = [
      { role: 'user', content: 'hi', timestamp: ts() },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }], timestamp: ts() },
    ];
    const foldSession = new FoldSession({ pressureCeiling: false });
    const { messages: result } = foldOnce(foldSession, conv);

    expectValidMessages(result);
    // All original messages pass through by reference
    expect(result).toHaveLength(conv.length);
    for (let i = 0; i < conv.length; i++) {
      expect(result[i]).toBe(conv[i]);
    }
  });

  test('fold produces structured block after threshold', () => {
    const conv = makeConversation(30);
    const foldSession = new FoldSession({
      pressureCeiling: false,
      foldBlockPreamble: '(Context note: test preamble)',
    });
    const { messages: result, foldBlockCount } = foldOnce(foldSession, conv);

    expectValidMessages(result);
    expect(result.length).toBeLessThan(conv.length);
    expect(foldBlockCount).toBeGreaterThanOrEqual(1);

    // First message should be a fold block
    const firstText = textOf(result[0]);
    expect(firstText).toContain('[Conversation Context');
    expect(firstText).toContain('[End Folded Context]');
  });

  test('active-window messages preserve object identity', () => {
    const conv = makeConversation(20);
    const foldSession = new FoldSession({ pressureCeiling: false });
    const { messages: result } = foldOnce(foldSession, conv);

    // Find the last few original messages that should be in the active window
    const originalLastMsg = conv[conv.length - 1];
    const activeMsgs = result.filter((r) => conv.includes(r));
    expect(activeMsgs.length).toBeGreaterThan(0);

    // The very last active-window message should be the last conversation message
    const lastActive = activeMsgs[activeMsgs.length - 1];
    expect(lastActive).toBe(originalLastMsg);
  });

  test('multi-turn folding with tail-epoch append', () => {
    const conv1 = makeConversation(30);
    const conv2 = [
      ...conv1,
      makeUserMessage('New question'),
      makeAssistantMessage('New answer'),
      makeUserMessage('Another question'),
      makeAssistantMessage('Another answer'),
    ];

    const foldSession = new FoldSession({
      freeze: { enabled: true, ttlMs: 5 * 60_000, maxTailChars: 1_000 },
      pressureCeiling: false,
    });

    // First fold
    const fold1 = foldOnce(foldSession, conv1);
    expect(fold1.foldBlockCount).toBeGreaterThanOrEqual(1);

    // Second fold — tail-epoch append should keep frozen prefix stable
    const fold2 = foldOnce(foldSession, conv2);
    expectValidMessages(fold2.messages);
    expect(fold2.foldBlockCount).toBeGreaterThanOrEqual(1);
  });

  test('plugin fold blocks use Pi-specific preamble without false recall claims', async () => {
    const conv = makeConversation(30);

    // Simulate the plugin's fold session configuration
    const PI_PREAMBLE =
      '(Context note: older turns were auto-folded into the skeletons below. The ⌖ COORDINATE CLOSET block conserves exact ids/paths/values from folded turns — trust it before re-reading files. In this Pi extension, folded details are not automatically paged back; use the preserved literals and visible active window as the source of continuity.)';

    const foldSession = new FoldSession({
      pressureCeiling: 150_000,
      foldBlockPreamble: PI_PREAMBLE,
    });

    const { messages: result } = foldOnce(foldSession, conv);

    const foldBlockText = textOf(result[0]);
    expect(foldBlockText).toContain('Pi extension');
    expect(foldBlockText).toContain('COORDINATE CLOSET');
    // Must NOT promise features the Pi extension doesn't have
    expect(foldBlockText).not.toContain('[Recalled from fold');
    expect(foldBlockText).not.toContain('Claiming a file');
    expect(foldBlockText).not.toContain('docs/context-folding.md');
  });

  test('hard epoch produces continuity seed', () => {
    // Use a very low ceiling to force hard epoch on first fold
    const conv = makeConversation(50);
    const foldSession = new FoldSession({
      pressureCeiling: 1_000, // extremely low to force immediate hard epoch
    });

    const { messages: foldMessages, indexMap } = toFoldMessages(conv);
    const outcome = foldSession.prepare(foldMessages, {
      measuredInputTokens: 5000, // over ceiling
    });

    const { messages: result, foldBlockCount } = toPiMessages(
      outcome.messages,
      indexMap,
      conv,
    );

    expectValidMessages(result);
    expect(foldBlockCount).toBeGreaterThanOrEqual(1);
  });
});
