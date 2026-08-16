import { describe, expect, it } from 'vitest';

import {
  extractCognitiveArtifacts,
  renderCognitiveBlock,
  TRANSIENT_FLOW_NOTE_DISCLAIMER_MARKER,
} from '../src/cognitiveArtifacts.ts';
import type { CognitiveArtifact } from '../src/cognitiveArtifacts.ts';
import type { FoldMessage } from '../src/rollingFold.ts';

function assistant(text: string): FoldMessage {
  return { role: 'assistant', content: text };
}

function artifact(overrides: Partial<CognitiveArtifact>): CognitiveArtifact {
  const messageIndex = overrides.messageIndex ?? 0;
  return {
    register: 'verdict',
    glyph: '🏁',
    headline: 'settled',
    messageIndex,
    trust: 'durable',
    sourceIdentity: `fold-window:message:${messageIndex}`,
    authorityClass: 'historical_observation',
    completionSupport: 'insufficient_alone',
    currentStatus: 'unresolved',
    ...overrides,
    sourceIdentityAuthority: overrides.sourceIdentityAuthority ?? 'synthetic-position',
  };
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
    expect(artifacts[0]).toMatchObject({
      authorityClass: 'historical_observation',
      completionSupport: 'insufficient_alone',
      currentStatus: 'superseded',
      supersededByIdentity: 'fold-window:message:1',
    });
    expect(artifacts[1].trust).toBe('durable');
    expect(artifacts[1].supersededByMessageIndex).toBeUndefined();
    expect(artifacts[1].currentStatus).toBe('current');
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
      artifact({
        register: 'in_progress',
        glyph: '🔍',
        headline: 'Mapping the render path.',
        messageIndex: 3,
        trust: 'transient',
        supersededByMessageIndex: 7,
      }),
      artifact({
        register: 'verdict',
        glyph: '🏁',
        headline: 'Fixed.',
        messageIndex: 7,
        trust: 'durable',
      }),
    ]);
    expect(block).toContain(
      '↞ msg#3 · in_progress · authority=historical_observation · completion=insufficient_alone · source-time=unknown · source-id=fold-window:message:3 · source-identity=synthetic-position · superseded-by=fold-window:message:7 (msg#7)',
    );
    expect(block).toContain('⊘ Mapping the render path.');
    expect(block).toContain('🏁 Fixed.');
    expect(block).not.toContain('🔍 Mapping the render path.');
  });

  it('declares elder-band transient supersession only when a durable waypoint exists in the new window', () => {
    const durableArtifacts = [
      artifact({
        register: 'verdict' as const,
        glyph: '🏁',
        headline: 'Settled.',
        messageIndex: 12,
        trust: 'durable' as const,
      }),
    ];
    const withFlag = renderCognitiveBlock(durableArtifacts, {
      supersedesElderTransientNotes: true,
    });
    expect(withFlag).toContain('supersede transient flow notes frozen in elder band(s)');
    const withoutFlag = renderCognitiveBlock(durableArtifacts);
    expect(withoutFlag).not.toContain('supersede transient flow notes frozen in elder band(s)');

    const transientOnly = renderCognitiveBlock(
      [
        artifact({
          register: 'in_progress' as const,
          glyph: '🔍',
          headline: 'Still working.',
          messageIndex: 12,
          trust: 'transient' as const,
        }),
      ],
      { supersedesElderTransientNotes: true },
    );
    expect(transientOnly).not.toContain('supersede transient flow notes frozen in elder band(s)');
  });

  it('keeps the disclaimer marker byte-aligned with the rendered disclaimer line', () => {
    const block = renderCognitiveBlock([
      artifact({
        register: 'in_progress',
        glyph: '🔍',
        headline: 'Narrating.',
        messageIndex: 0,
        trust: 'transient',
      }),
    ]);
    expect(block).toContain(TRANSIENT_FLOW_NOTE_DISCLAIMER_MARKER);
  });
});

describe('conserved diagnosis lane', () => {
  const longDiagnosis =
    '🔍 I walked the ledger end to end and compared the observe path against the sidecar assembler while the grinder kept running in the background of this fold window, checking every persisted row twice. Ledger has the stars — observe is not the miss. Next I will chase the queryCurrent read and see whether the empty projection comes from the harvest drop instead of the persist path.';

  it('conserves the newest belief-changing sentence from a long gated narration', () => {
    expect(longDiagnosis.length).toBeGreaterThan(240);
    const artifacts = extractCognitiveArtifacts([assistant(longDiagnosis)]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      trust: 'diagnosis',
      glyph: 'Δ',
      register: 'in_progress',
      headline: 'Ledger has the stars — observe is not the miss.',
      authorityClass: 'historical_observation',
      completionSupport: 'insufficient_alone',
    });
  });

  it('keeps exactly one diagnosis per window — the newest candidate wins', () => {
    const older =
      '🔍 First pass over the selector and the ranking pipeline with every guard disabled so the raw ordering shows through, which took several reads of the same section to untangle properly before anything was clear. The stale entry id turns out to be harmless here. I will keep going and read the residency map next to see who pages this window back in.';
    expect(older.length).toBeGreaterThan(240);
    const artifacts = extractCognitiveArtifacts([assistant(older), assistant(longDiagnosis)]);
    const diagnoses = artifacts.filter((a) => a.trust === 'diagnosis');
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0].messageIndex).toBe(1);
    expect(diagnoses[0].headline).toBe('Ledger has the stars — observe is not the miss.');
  });

  it('leaves long chatter without belief-change cues fully gated', () => {
    const chatter =
      '🔍 Reading through the module again and taking notes on the structure while the checks run in the background, then I will look at the renderer and the provenance lines and the disclaimer stack before deciding anything, and after that I want to compare the two copies of the file for drift and check the imports one more time to be sure.';
    expect(chatter.length).toBeGreaterThan(240);
    expect(extractCognitiveArtifacts([assistant(chatter)])).toHaveLength(0);
  });

  it('short narrations still ride the transient lane, never the diagnosis lane', () => {
    const artifacts = extractCognitiveArtifacts([
      assistant('🔍 The cache is the culprit maybe — checking now.'),
    ]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].trust).toBe('transient');
  });

  it('a later durable verdict supersedes the conserved diagnosis', () => {
    const artifacts = extractCognitiveArtifacts([
      assistant(longDiagnosis),
      assistant('🏁 Confirmed: harvest drop reproduced and fixed.'),
    ]);
    const diagnosis = artifacts.find((a) => a.trust === 'diagnosis');
    expect(diagnosis?.currentStatus).toBe('superseded');
    expect(diagnosis?.supersededByMessageIndex).toBe(1);
  });

  it('renders the Δ disclaimer without granting durable authority', () => {
    const artifacts = extractCognitiveArtifacts([assistant(longDiagnosis)]);
    const block = renderCognitiveBlock(artifacts, { supersedesElderTransientNotes: true });
    expect(block).toContain('Δ lines are conserved diagnoses');
    expect(block).toContain('Δ Ledger has the stars — observe is not the miss.');
    // A diagnosis is not a durable waypoint: it cannot trigger elder-band
    // supersession, and a diagnosis-only block carries no transient disclaimer.
    expect(block).not.toContain('supersede transient flow notes frozen in elder band(s)');
    expect(block).not.toContain(TRANSIENT_FLOW_NOTE_DISCLAIMER_MARKER);
  });
});
