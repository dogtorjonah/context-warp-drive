import { describe, expect, it } from 'vitest';
import { extractNarrationLines } from '../foldEpisodes.ts';

const neverSynthetic = (_line: string): boolean => false;

describe('audit-4 F1: narration decoration strips ordinals only', () => {
  it('keeps the numerator of "28/28 tests pass" (never eats a bare leading number)', () => {
    // The audited specimen stored "/28 tests pass" — the numerator was
    // swallowed by a bare `\d` in the decoration class. Isolate the
    // decoration strip from the verdict-shape gate with the flag off.
    const lines = extractNarrationLines(
      '28/28 tests pass on the touched suite.',
      neverSynthetic,
      undefined,
      { requireVerdictShape: false },
    );
    expect(lines).toEqual(['28/28 tests pass on the touched suite.']);
  });

  it('keeps "66/66 assertions" and "9/9 gates" numerators', () => {
    const opts = { requireVerdictShape: false } as const;
    expect(extractNarrationLines('66/66 assertions green in the relay suite.', neverSynthetic, undefined, opts))
      .toEqual(['66/66 assertions green in the relay suite.']);
    expect(extractNarrationLines('9/9 gates pass on the standalone tree.', neverSynthetic, undefined, opts))
      .toEqual(['9/9 gates pass on the standalone tree.']);
  });

  it('still strips ordinal list markers ("1. Fixed ...", "2) verified ...")', () => {
    const lines = extractNarrationLines('1. Fixed the frontier probe timeout.', neverSynthetic);
    expect(lines).toEqual(['Fixed the frontier probe timeout.']);
    const paren = extractNarrationLines('2) verified the parity gate.', neverSynthetic);
    expect(paren).toEqual(['verified the parity gate.']);
  });

  it('keeps glyph/heading decoration stripping intact', () => {
    const lines = extractNarrationLines('🏁 Found the frontier draw is the long pole at 7.6 seconds.', neverSynthetic);
    expect(lines).toEqual(['Found the frontier draw is the long pole at 7.6 seconds.']);
  });
});
