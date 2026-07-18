import { describe, expect, it } from 'vitest';

import {
  extractCognitiveArtifacts,
  renderCognitiveBlock,
  TRANSIENT_FLOW_NOTE_DISCLAIMER_MARKER,
} from '../src/cognitiveArtifacts.ts';
import type { FoldMessage } from '../src/rollingFold.ts';

function assistant(text: string): FoldMessage {
  return { role: 'assistant', content: text };
}

describe('cognitive artifact transient supersession', () => {
  it('marks a transient flow note superseded by the next durable waypoint in the same window', () => {
    const artifacts = extractCognitiveArtifacts([
      assistant('🔍 Mapping the render path before editing.'),
      assistant('🏁 Fixed: the seam now carries exact coordinates.'),
    ]);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].trust).toBe('transient');
    expect(artifacts[0].supersededByMessageIndex).toBe(1);
    expect(artifacts[1].trust).toBe('durable');
    expect(artifacts[1].supersededByMessageIndex).toBeUndefined();
  });

  it('leaves trailing transient notes unsuperseded when no durable waypoint follows them', () => {
    const artifacts = extractCognitiveArtifacts([
      assistant('🏁 Earlier verdict.'),
      assistant('🔍 Still investigating the next smell.'),
    ]);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].supersededByMessageIndex).toBeUndefined();
    expect(artifacts[1].supersededByMessageIndex).toBeUndefined();
  });

  it('renders superseded notes with the ⊘ glyph and a superseded-by provenance suffix', () => {
    const block = renderCognitiveBlock([
      {
        register: 'in_progress',
        glyph: '🔍',
        headline: 'Mapping the render path.',
        messageIndex: 3,
        trust: 'transient',
        supersededByMessageIndex: 7,
      },
      {
        register: 'verdict',
        glyph: '🏁',
        headline: 'Fixed.',
        messageIndex: 7,
        trust: 'durable',
      },
    ]);
    expect(block).toContain('↞ msg#3 · in_progress · superseded-by msg#7');
    expect(block).toContain('⊘ Mapping the render path.');
    expect(block).toContain('🏁 Fixed.');
    expect(block).not.toContain('🔍 Mapping the render path.');
  });

  it('declares elder-band transient supersession only when a durable waypoint exists in the new window', () => {
    const durableArtifacts = [
      {
        register: 'verdict' as const,
        glyph: '🏁',
        headline: 'Settled.',
        messageIndex: 12,
        trust: 'durable' as const,
      },
    ];
    const withFlag = renderCognitiveBlock(durableArtifacts, {
      supersedesElderTransientNotes: true,
    });
    expect(withFlag).toContain('supersede transient flow notes frozen in elder band(s)');
    const withoutFlag = renderCognitiveBlock(durableArtifacts);
    expect(withoutFlag).not.toContain('supersede transient flow notes frozen in elder band(s)');

    const transientOnly = renderCognitiveBlock(
      [
        {
          register: 'in_progress' as const,
          glyph: '🔍',
          headline: 'Still working.',
          messageIndex: 12,
          trust: 'transient' as const,
        },
      ],
      { supersedesElderTransientNotes: true },
    );
    expect(transientOnly).not.toContain('supersede transient flow notes frozen in elder band(s)');
  });

  it('keeps the disclaimer marker byte-aligned with the rendered disclaimer line', () => {
    const block = renderCognitiveBlock([
      {
        register: 'in_progress',
        glyph: '🔍',
        headline: 'Narrating.',
        messageIndex: 0,
        trust: 'transient',
      },
    ]);
    expect(block).toContain(TRANSIENT_FLOW_NOTE_DISCLAIMER_MARKER);
  });
});
