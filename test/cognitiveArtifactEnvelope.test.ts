import { describe, expect, it } from 'vitest';

import {
  COGNITIVE_ARTIFACT_ENVELOPE_VERSION,
  createCognitiveArtifactEnvelope,
  normalizeCognitiveSourceTime,
} from '../src/cognitiveArtifactEnvelope.ts';

describe('CognitiveArtifactEnvelope/v1', () => {
  it('normalizes supported source clocks and fails closed on invalid time', () => {
    expect(COGNITIVE_ARTIFACT_ENVELOPE_VERSION).toBe('cognitive-artifact-envelope/v1');
    expect(normalizeCognitiveSourceTime('2026-07-22 18:00:00')).toBe('2026-07-22T18:00:00.000Z');
    expect(normalizeCognitiveSourceTime('2026-07-22 18:00:00.125')).toBe('2026-07-22T18:00:00.125Z');
    expect(normalizeCognitiveSourceTime('2026-07-22T18:00Z')).toBe('2026-07-22T18:00:00.000Z');
    expect(normalizeCognitiveSourceTime('2026-07-22T18:00:00.125+02:30')).toBe('2026-07-22T15:30:00.125Z');
    expect(normalizeCognitiveSourceTime(Date.parse('2026-07-22T18:00:00Z'))).toBe('2026-07-22T18:00:00.000Z');
    for (const ambiguous of [
      'not-a-clock',
      '1',
      '07/22/2026',
      '2026-07-22',
      '2026-07-22T18:00:00',
      '2026-02-31T18:00:00Z',
      '2026-07-22 18:00:00Z',
    ]) {
      expect(normalizeCognitiveSourceTime(ambiguous)).toBeNull();
    }
    expect(normalizeCognitiveSourceTime(Number.NaN)).toBeNull();
    expect(normalizeCognitiveSourceTime(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('preserves root identity rules for all durable source families', () => {
    const inputs = [
      { source: { family: 'star' as const, instanceId: 'i1', category: 'decision', note: 'keep this', sourceTime: '2026-07-22T18:00:00Z' }, expected: 'instance:i1/star:2026-07-22T18:00:00.000Z/decision/keep this' },
      { source: { family: 'rail-state' as const, railId: 'r1', state: 'complete', sourceTime: '2026-07-22T18:00:00Z' }, expected: 'rail:r1/state:complete' },
      { source: { family: 'rail-step' as const, railId: 'r1', stepId: 's1', sourceTime: '2026-07-22T18:00:00Z' }, expected: 'rail:r1/step:s1' },
      { source: { family: 'atlas' as const, workspace: 'voxxo', instanceId: 'i1', changelogId: 42, sourceTime: '2026-07-22T18:00:00Z' }, expected: 'workspace:voxxo/changelog:42' },
      { source: { family: 'chat' as const, roomId: 'room-1', messageId: 'm1', sourceTime: '2026-07-22T18:00:00Z' }, expected: 'room:room-1/message:m1' },
      { source: { family: 'glyph' as const, messageId: 'm1', sourceTime: '2026-07-22T18:00:00Z' }, expected: 'message:m1' },
    ];
    for (const { source, expected } of inputs) {
      expect(createCognitiveArtifactEnvelope({ source, authorityClass: 'historical_observation' })?.sourceIdentity)
        .toBe(expected);
    }
  });

  it('keeps re-acked rail steps and fork-copied glyphs on one stable root identity', () => {
    const railA = createCognitiveArtifactEnvelope({
      source: { family: 'rail-step', railId: 'r1', stepId: 's1', sourceTime: '2026-07-22T18:00:00Z' },
      authorityClass: 'evidence',
    });
    const railB = createCognitiveArtifactEnvelope({
      source: { family: 'rail-step', railId: 'r1', stepId: 's1', sourceTime: '2026-07-22T19:00:00Z' },
      authorityClass: 'evidence',
    });
    const glyphA = createCognitiveArtifactEnvelope({
      source: { family: 'glyph', messageId: 'copied-message', sourceTime: '2026-07-22T18:00:00Z' },
      authorityClass: 'historical_observation',
    });
    const glyphB = createCognitiveArtifactEnvelope({
      source: { family: 'glyph', messageId: 'copied-message', sourceTime: '2026-07-22T18:00:00Z' },
      authorityClass: 'historical_observation',
    });

    expect(railA?.artifactId).toBe(railB?.artifactId);
    expect(railA?.sourceTime).not.toBe(railB?.sourceTime);
    expect(glyphA?.artifactId).toBe(glyphB?.artifactId);
    expect(createCognitiveArtifactEnvelope({
      source: { family: 'glyph', messageId: 'm1', sourceTime: 'invalid' },
      authorityClass: 'historical_observation',
    })).toBeNull();
  });
});
