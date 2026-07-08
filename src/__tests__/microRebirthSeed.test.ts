import { describe, expect, it } from 'vitest';

import { buildMicroSeedBlock } from '../microRebirthSeed.ts';
import {
  buildMicroSeedFromMessages,
  BAND_MICRO_SEED_RENDER_SAFETY_MAX_CHARS,
  BAND_MICRO_SEED_TARGET_TOKENS,
} from '../rawRebirthSeed.ts';
import { DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS } from '../contextBudget.ts';
import type { FoldMessage } from '../rollingFold.ts';

const user = (content: string): FoldMessage => ({ role: 'user', content });
const assistant = (content: string): FoldMessage => ({ role: 'assistant', content });

describe('buildMicroSeedBlock (v2 — rebirth machinery delegation)', () => {
  it('returns empty string for an empty window', () => {
    expect(buildMicroSeedBlock([])).toBe('');
  });

  it('produces non-empty output for a window with genuine operator turns', () => {
    const messages = [
      user('fix the churning before the tool-loss work'),
      assistant('▶ Checking the counter mutation context before the next edit:'),
    ];
    const block = buildMicroSeedBlock(messages);
    expect(block.length).toBeGreaterThan(0);
    // Must use band-level framing, NOT the full rebirth header
    expect(block).not.toContain('[CONTEXT REBIRTH]');
    // Must carry the [micro-seed] band header
    expect(block).toContain('[micro-seed]');
  });

  it('includes the operator ask in the output', () => {
    const messages = [user('build the micro seed v2 please')];
    const block = buildMicroSeedBlock(messages);
    expect(block).toContain('build the micro seed v2');
  });

  it('includes assistant in-flight content in the output', () => {
    const messages = [
      user('continue the work'),
      assistant('▶ editing FoldSession.ts to add the gate'),
    ];
    const block = buildMicroSeedBlock(messages);
    expect(block).toContain('editing FoldSession');
  });

  it('exposes the append-band target in tokens without treating it as a character cap', () => {
    expect(BAND_MICRO_SEED_TARGET_TOKENS).toBe(DEFAULT_CONTEXT_BUDGET_APPEND_BAND_TARGET_TOKENS);
    expect(BAND_MICRO_SEED_TARGET_TOKENS).toBe(5_000);
    expect(BAND_MICRO_SEED_RENDER_SAFETY_MAX_CHARS).toBeGreaterThan(BAND_MICRO_SEED_TARGET_TOKENS);
  });

  it('is bounded by the character-only render safety cap', () => {
    // Build a large window to test the deterministic renderer cap. This cap is
    // deliberately not a token budget; token pressure is measured by callers.
    const messages: FoldMessage[] = [];
    for (let i = 0; i < 250; i++) {
      messages.push(user(`task number ${i} with ${'long operator context '.repeat(20)} to fill the window and test bounding`));
      messages.push(assistant(`▶ working on task ${i} with ${'detailed implementation notes '.repeat(20)} for the fold window`));
    }
    const block = buildMicroSeedBlock(messages);
    expect(block.length).toBeLessThanOrEqual(BAND_MICRO_SEED_RENDER_SAFETY_MAX_CHARS);
    expect(BAND_MICRO_SEED_RENDER_SAFETY_MAX_CHARS).toBeGreaterThan(BAND_MICRO_SEED_TARGET_TOKENS);
  });

  it('is byte-stable for identical input (no timestamps or counters)', () => {
    const messages = [user('same ask'), assistant('▶ same work')];
    expect(buildMicroSeedBlock(messages)).toBe(buildMicroSeedBlock(messages));
  });

  it('skips ephemeral coordination frames (digest deltas) from the ask', () => {
    const messages = [
      user('[DIGEST DELTA seq 1-4]\n  peer: some activity\n[END DIGEST DELTA]'),
      user('actual genuine operator message here'),
    ];
    const block = buildMicroSeedBlock(messages);
    expect(block).toContain('actual genuine operator message');
  });

  it('does not include external-state sections (rail, chatroom, squad, workspace)', () => {
    const messages = [
      user('do the thing'),
      assistant('🏁 doing the thing'),
    ];
    const block = buildMicroSeedBlock(messages);
    expect(block).not.toContain('── Task Rail');
    expect(block).not.toContain('── Chatroom');
    expect(block).not.toContain('── Squad');
    expect(block).not.toContain('── Workspace');
    expect(block).not.toContain('── Coordination');
  });
});

describe('buildMicroSeedFromMessages (direct API)', () => {
  it('returns empty for empty input', () => {
    expect(buildMicroSeedFromMessages([]).trim()).toBe('');
  });

  it('returns empty for windows with only ephemeral coordination frames', () => {
    const block = buildMicroSeedFromMessages([
      user('[DIGEST DELTA seq 1-4]\n  peer: some activity\n[END DIGEST DELTA]'),
    ]);
    expect(block.trim()).toBe('');
  });

  it('respects custom headerOverride', () => {
    const block = buildMicroSeedFromMessages(
      [user('test task')],
      { headerOverride: '[custom-band-header] Test override' },
    );
    expect(block).toContain('[custom-band-header]');
    expect(block).not.toContain('[CONTEXT REBIRTH]');
  });

  it('includes Gemini model-role parts in the output', () => {
    const block = buildMicroSeedFromMessages([
      {
        role: 'model',
        content: null,
        parts: [{ text: '🔍 tracing the floor lifecycle' }],
      } as unknown as FoldMessage,
    ]);
    expect(block).toContain('tracing the floor lifecycle');
  });

  it('omits the footer when footerOverride is empty string', () => {
    const block = buildMicroSeedFromMessages([user('test task')]);
    expect(block).not.toContain('── Orientation ──');
  });
});
