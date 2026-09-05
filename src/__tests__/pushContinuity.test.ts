import { describe, expect, it } from 'vitest';
import { deriveEpisodesFromMessages } from '../foldEpisodeCapture.ts';
import { createCognitiveArtifactEnvelope } from '../cognitiveArtifactEnvelope.ts';
import {
  deriveEpisodeSummary, renderEpisodeVoiceLines, selectVoiceInlays,
  type EpisodeAnnotation,
} from '../foldEpisodes.ts';
import type { FoldMessage } from '../rollingFold.ts';

const time = (second: number) => `2026-09-01T00:00:${String(second).padStart(2, '0')}.000Z`;
const voice = (second: number, text: string, kind: EpisodeAnnotation['kind'] = 'narration:verdict'): EpisodeAnnotation =>
  ({ ts: time(second), kind, text });

describe('push continuity evidence selection', () => {
  it('pushes the latest conclusion under a one-line budget without mutating history', () => {
    const before = voice(1, 'Confirmed the queue drained without waiting for publication.');
    const correction = voice(3, 'Confirmed publication must finish before the queue is drained.');
    const annotations = [before, correction];
    expect(selectVoiceInlays(annotations, 1)).toEqual([correction]);
    expect(selectVoiceInlays(annotations, 2)).toEqual([before, correction]);
    expect(deriveEpisodeSummary({ annotations, members: [] })).toBe(correction.text);
    expect(annotations).toEqual([before, correction]);
  });

  it('does not let a retired hazard displace its usable replacement', () => {
    const artifact = createCognitiveArtifactEnvelope({
      source: { family: 'glyph', messageId: 'old-hazard', sourceTime: time(1) },
      authorityClass: 'historical_observation',
    });
    expect(artifact).toBeTruthy();
    const old: EpisodeAnnotation = { ...voice(1, 'The publication worker loses pending records.', 'narration:hazard'),
      artifact: { ...artifact!, currentStatus: 'superseded', supersededBy: 'replacement' } };
    const replacement = voice(2, 'Confirmed the publication worker now preserves pending records.');
    expect(selectVoiceInlays([old, replacement], 1)).toEqual([replacement]);
    expect(deriveEpisodeSummary({ annotations: [old, replacement], members: [] })).toBe(replacement.text);
  });

  it('keeps unknown chronology unknown and preserves hazard priority', () => {
    const unknown = { kind: 'narration:verdict' as const, text: 'A conclusion without a source timestamp.' };
    const known = voice(1, 'Confirmed the current publication invariant.');
    const hazard = voice(0, 'Publication still has an unresolved safety constraint.', 'narration:hazard');
    expect(selectVoiceInlays([unknown, known], 1)).toEqual([known]);
    expect(selectVoiceInlays([known, hazard], 1)).toEqual([hazard]);
    expect(unknown).not.toHaveProperty('ts');
  });
});

describe('push continuity capture to rendering', () => {
  it('captures late corrections and multiple rationale lines but stops at the next operator request', () => {
    const messages: FoldMessage[] = [
      { role: 'user', content: 'Repair queue publication ordering.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'edit-queue', name: 'Edit', input: { file_path: 'queue.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit-queue', content: 'ok' }] },
      { role: 'assistant', content: 'Confirmed the queue drains before publication.' },
      { role: 'assistant', content: 'The evidence is being checked once more.' },
      { role: 'assistant', content: 'The worker response has arrived for inspection.' },
      { role: 'assistant', content: 'The final assertions are now available to inspect.' },
      { role: 'assistant', content: 'Confirmed publication must finish before the queue drains.' },
      { role: 'assistant', content: 'Chose explicit acknowledgements because queued work must survive retries.\nRejected fire-and-forget because completion must be observable.' },
      { role: 'user', content: 'Now investigate the unrelated parser.' },
      { role: 'assistant', content: '🏁 Confirmed the unrelated parser uses a different grammar.' },
      ...Array.from({ length: 30 }, (): FoldMessage => ({ role: 'assistant', content: 'working' })),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-parser', name: 'Read', input: { file_path: 'parser.ts' } }] },
    ];
    const result = deriveEpisodesFromMessages(messages, 0,
      { workspace: 'test', instanceId: 'capture-test', closedBy: 'epoch', nowIso: time(59) },
      { timestamps: messages.map((_, index) => time(index)) });
    expect(result.episodes).toHaveLength(1);
    const episode = result.episodes[0];
    const texts = episode.annotations.map((annotation) => annotation.text);
    expect(texts).toContain('Confirmed publication must finish before the queue drains.');
    expect(texts).toContain('Chose explicit acknowledgements because queued work must survive retries.');
    expect(texts).toContain('Rejected fire-and-forget because completion must be observable.');
    expect(texts.join('\n')).not.toContain('unrelated parser');
    const rendered = renderEpisodeVoiceLines(episode, {}, 1).voiceLines.join('\n');
    expect(rendered).toContain('publication must finish');
    expect(rendered).not.toContain('queue drains before');
    const paired = renderEpisodeVoiceLines(episode, {}, 2).voiceLines.join('\n');
    expect(paired).toContain('publication must finish');
    expect(paired).toContain('because');
  });
});
