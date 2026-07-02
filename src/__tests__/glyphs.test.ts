import { describe, expect, it } from 'vitest';

import {
  CARD_GLYPHS,
  REGISTER_GLYPHS,
  REGISTER_GLYPH_PROMPT_SNIPPET,
  buildRegisterGlyphPromptSnippet,
  classifyAssistantRegister,
  parseRegisterGlyph,
  stripRegisterGlyph,
} from '../glyphs.ts';

describe('register glyph grammar', () => {
  it('parses executing as a transient register and accepts the VS16 variant', () => {
    const bare = parseRegisterGlyph('▶ applying the patch');
    expect(bare).toMatchObject({
      ok: true,
      register: 'executing',
      glyph: '▶',
      rawPrefix: '▶',
      body: ' applying the patch',
      classification: {
        register: 'executing',
        trust: 'transient',
        durable: false,
        final: false,
      },
    });

    const emoji = parseRegisterGlyph('▶️ running tests');
    expect(emoji).toMatchObject({
      ok: true,
      register: 'executing',
      glyph: '▶',
      rawPrefix: '▶️',
      body: ' running tests',
    });
  });

  it('keeps executing ASCII aliases opt-in and strips only valid prefixes', () => {
    expect(parseRegisterGlyph('[executing] running').ok).toBe(false);

    const parsed = parseRegisterGlyph('[execute] running', { asciiAliases: true });
    expect(parsed).toMatchObject({
      ok: true,
      register: 'executing',
      glyph: '▶',
      source: 'ascii_alias',
      rawPrefix: '[execute]',
      body: ' running',
    });
    expect(stripRegisterGlyph('▶ running')).toBe(' running');
  });

  it('classifies executing alongside working as transient, not final memory', () => {
    expect(classifyAssistantRegister('executing')).toEqual({
      register: 'executing',
      trust: 'transient',
      durable: false,
      final: false,
    });
  });
});

describe('emit contract (REGISTER_GLYPH_PROMPT_SNIPPET)', () => {
  it('mentions every register glyph with the expected multiplicity', () => {
    // No register glyph is a substring of another, and card glyphs never
    // collide with register glyphs, so split-count is exact.
    const count = (glyph: string) => REGISTER_GLYPH_PROMPT_SNIPPET.split(glyph).length - 1;
    expect(count(REGISTER_GLYPHS.executing), 'executing ▶: list + self-exclude').toBe(2);
    expect(count(REGISTER_GLYPHS.verdict), 'verdict 🏁: list + harvest guidance').toBe(2);
    expect(count(REGISTER_GLYPHS.hazard), 'hazard ⚠️: list + harvest guidance').toBe(2);
    expect(count(REGISTER_GLYPHS.blocked), 'blocked ❓: list + self-exclude').toBe(2);
    expect(count(REGISTER_GLYPHS.in_progress), 'in_progress 🔍: list + fallback + self-exclude').toBe(3);
  });

  it('mentions every card glyph exactly once as forbidden openers', () => {
    for (const card of CARD_GLYPHS) {
      const occurrences = REGISTER_GLYPH_PROMPT_SNIPPET.split(card).length - 1;
      expect(occurrences, `card glyph ${card}`).toBe(1);
    }
  });

  it('derives from REGISTER_GLYPHS so a description-table swap keeps the glyph set', () => {
    const custom = buildRegisterGlyphPromptSnippet({
      in_progress: 'a',
      executing: 'b',
      verdict: 'c',
      hazard: 'd',
      blocked: 'e',
    });
    for (const glyph of Object.values(REGISTER_GLYPHS)) {
      expect(custom).toContain(glyph);
    }
    expect(custom).toContain('🔍 a');
    expect(custom).toContain('❓ e');
  });

  it('every register described in the snippet round-trips through the parser', () => {
    for (const glyph of Object.values(REGISTER_GLYPHS)) {
      const parsed = parseRegisterGlyph(`${glyph} sample body`);
      expect(parsed.ok, `parser accepts ${glyph}`).toBe(true);
    }
  });
});
