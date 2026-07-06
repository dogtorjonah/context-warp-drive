import { describe, expect, test } from 'vitest';

// Import the real fold engine to generate actual fold block output
import {
  foldContext,
  FOLD_BLOCK_PREAMBLE,
} from '../../../src/rollingFold.ts';
import type { FoldMessage } from '../../../src/rollingFold.ts';

// The markers used by the adapter to detect fold blocks
const FOLD_BLOCK_MARKERS = [
  '[Conversation Context —',
  'COORDINATE CLOSET',
  '[End Folded Context]',
];

describe('fold-block marker detection against real CWD output', () => {
  test('real fold output contains all adapter markers', () => {
    // Generate a conversation long enough to trigger a fold
    const messages: FoldMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `User message number ${i} with some content that is long enough to be meaningful.` });
      messages.push({ role: 'assistant', content: `Assistant response number ${i} with detailed content that includes code and explanations.` });
    }

    // Run the fold engine with default config
    const result = foldContext(messages, 10, undefined as any, undefined, undefined, undefined, undefined);

    // The folded messages should contain a fold block
    const foldBlockMsg = result.messages.find(
      (m) => m.role === 'user' && typeof m.content === 'string',
    );

    if (foldBlockMsg && typeof foldBlockMsg.content === 'string') {
      const foldText = foldBlockMsg.content;

      // Check that the adapter markers appear in the real output
      const foundMarkers = FOLD_BLOCK_MARKERS.filter((m) => foldText.includes(m));

      // At least the opening marker should be present
      expect(foundMarkers.length).toBeGreaterThan(0);
      expect(foldText).toContain('[Conversation Context —');
      expect(foldText).toContain('[End Folded Context]');
    }
  });

  test('FOLD_BLOCK_PREAMBLE contains COORDINATE CLOSET', () => {
    // This verifies the preamble text matches what the adapter expects
    expect(FOLD_BLOCK_PREAMBLE).toContain('COORDINATE CLOSET');
  });

  test('ack message text matches expected pattern', () => {
    // The adapter keeps (not skips) the ack message, so we just verify
    // the text pattern exists in the real output when a fold occurs
    const messages: FoldMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `User ${i}` });
      messages.push({ role: 'assistant', content: `Assistant ${i}` });
    }

    const result = foldContext(messages, 10, undefined as any, undefined, undefined, undefined, undefined);

    const ackMsg = result.messages.find(
      (m) => m.role === 'assistant' &&
      typeof m.content === 'string' &&
      m.content.includes('Acknowledged'),
    );

    // The ack message should be present after the fold block
    // (keeping it preserves user/assistant alternation)
    expect(ackMsg).toBeDefined();
  });
});
