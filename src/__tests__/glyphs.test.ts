import { describe, expect, it } from 'vitest';

import { classifyAssistantRegister, parseRegisterGlyph, stripRegisterGlyph } from '../glyphs.ts';

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
