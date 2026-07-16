import { describe, expect, it } from 'vitest';

import {
  classifyOperatorAuthoredObjective,
  renderTailEpochProvenance,
} from '../src/chronologicalProvenance.ts';

describe('classifyOperatorAuthoredObjective', () => {
  it('keeps plain operator prose at high confidence', () => {
    expect(classifyOperatorAuthoredObjective('Make the resume manifest authoritative.')).toEqual({
      text: 'Make the resume manifest authoritative.',
      confidence: 'high',
      source: 'operator-message',
    });
  });

  it('rejects environment-only and synthetic epoch artifacts', () => {
    expect(classifyOperatorAuthoredObjective(
      '<environment_context><cwd>/tmp/not-intent</cwd></environment_context>',
    )).toEqual({ text: null, confidence: 'unknown', source: 'none' });
    expect(classifyOperatorAuthoredObjective(
      '[Chronological Provenance v1] artifact=tail-epoch#2\n[Context band 2 — tail-epoch fold]',
    )).toEqual({ text: null, confidence: 'unknown', source: 'none' });
  });

  it('preserves mixed operator prose after stripping known transport envelopes', () => {
    expect(classifyOperatorAuthoredObjective([
      '<recommended_plugins><plugin>synthetic</plugin></recommended_plugins>',
      'Fix the objective extraction.',
      '<environment_context><cwd>/tmp/context</cwd></environment_context>',
    ].join('\n'))).toEqual({
      text: 'Fix the objective extraction.',
      confidence: 'medium',
      source: 'mixed-transport-envelope',
    });
  });

  it('rejects whole-row CLI interrupt and relay fold-note artifacts', () => {
    for (const artifact of [
      '[Request interrupted by user]',
      '[Request interrupted by user for tool use]',
      '[Relay note: this turn was interrupted by a Context Warp fold — resume the interrupted work, re-running the interrupted tool call if it is still needed.]',
      '[System Note: Context pressure limits were reached during your execution.]',
    ]) {
      expect(classifyOperatorAuthoredObjective(artifact)).toEqual({
        text: null,
        confidence: 'unknown',
        source: 'none',
      });
    }
  });
});

describe('tail-epoch objective provenance', () => {
  it('renders explicit objective confidence and source', () => {
    const rendered = renderTailEpochProvenance({
      traceId: 'thread-objective',
      sourceFrameId: 'thread-objective:tail-epoch#2:band#2:pre-fold',
      epoch: 2,
      unit: 'row',
      sourceStart: 10,
      sourceEndExclusive: 20,
      committedAt: '2026-07-16T01:00:00.000Z',
      rawTailCount: 2,
      rawResumeIndex: 20,
      host: 'dedicated-band-message',
      liveObjective: 'Fix objective extraction',
      liveObjectiveConfidence: 'high',
      liveObjectiveSource: 'operator-message',
    });
    expect(rendered).toContain('objective-confidence=high objective-source=operator-message');
    expect(rendered).toContain('live-objective="Fix objective extraction"');
    expect(rendered).toContain(
      'source=thread-objective:tail-epoch#2:band#2:pre-fold:row#10..thread-objective:tail-epoch#2:band#2:pre-fold:row#20 n=10',
    );
    expect(rendered).toContain(
      'coordinate-frame=thread-objective:tail-epoch#2:band#2:pre-fold scope=pre-fold-snapshot comparable-within-frame-only',
    );
  });

  it('renders a bounded pending-intent seam line', () => {
    const rendered = renderTailEpochProvenance({
      traceId: 'thread-pending',
      epoch: 3,
      unit: 'row',
      sourceStart: 4,
      sourceEndExclusive: 9,
      committedAt: '2026-07-16T02:00:00.000Z',
      rawTailCount: 1,
      rawResumeIndex: 9,
      host: 'dedicated-band-message',
      pendingIntent: `Edit (fold-interrupted) {"file_path":"/tmp/x.ts"} ${'x'.repeat(400)}`,
    });
    expect(rendered).toContain('pending-intent="Edit (fold-interrupted)');
    // Bounded at 220 chars + ellipsis; the 400-char runway must not survive.
    expect(rendered).not.toContain('x'.repeat(221));
    expect(rendered).toContain('…');
  });

  it('omits the pending-intent line when nothing was pending', () => {
    const rendered = renderTailEpochProvenance({
      traceId: 'thread-quiet',
      epoch: 1,
      unit: 'row',
      sourceStart: 0,
      sourceEndExclusive: 2,
      committedAt: '2026-07-16T02:00:00.000Z',
      rawTailCount: 0,
      host: 'dedicated-band-message',
    });
    expect(rendered).not.toBeNull();
    expect(rendered).not.toContain('pending-intent=');
  });
});
