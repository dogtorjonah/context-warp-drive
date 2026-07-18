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

  it('rejects AGENTS instruction envelopes even when the tag follows a blank line', () => {
    expect(classifyOperatorAuthoredObjective([
      '# AGENTS.md instructions for /home/jonah/project',
      '',
      '<INSTRUCTIONS>',
      'Synthetic repository instructions are not the live task.',
      '</INSTRUCTIONS>',
    ].join('\n'))).toEqual({ text: null, confidence: 'unknown', source: 'none' });
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
      activeRailId: 'rail-objective',
      activeRailObjective: 'Ship the continuity repair',
      activeRailStep: 'verify-band',
    });
    expect(rendered).toContain('objective-confidence=high objective-source=operator-message');
    expect(rendered).toContain('live-objective="Fix objective extraction"');
    expect(rendered).toContain(
      'active-rail="rail-objective" active-step="verify-band" rail-objective="Ship the continuity repair"',
    );
    expect(rendered).toContain(
      'source=thread-objective:tail-epoch#2:band#2:pre-fold:row#10..thread-objective:tail-epoch#2:band#2:pre-fold:row#20 n=10',
    );
    expect(rendered).toContain(
      'coordinate-frame=thread-objective:tail-epoch#2:band#2:pre-fold scope=pre-fold-snapshot comparable-within-frame-only',
    );
  });

  it('renders a validated full stack of tiled absolute event ranges', () => {
    const rendered = renderTailEpochProvenance({
      traceId: 'thread-stack',
      epoch: 3,
      unit: 'event',
      sourceStart: 12,
      sourceEndExclusive: 19,
      committedAt: '2026-07-16T01:30:00.000Z',
      rawTailCount: 4,
      rawResumeIndex: 19,
      host: 'dedicated-band-message',
      bandStack: [
        { epoch: 1, sourceStart: 0, sourceEndExclusive: 5 },
        { epoch: 2, sourceStart: 5, sourceEndExclusive: 12 },
        { epoch: 3, sourceStart: 12, sourceEndExclusive: 19 },
      ],
    });
    expect(rendered).toContain(
      'source=thread-stack:event#12..thread-stack:event#19 n=7',
    );
    expect(rendered).toContain(
      'stack=frozen-prefix>tail-epoch#1[event:0..5)>tail-epoch#2[event:5..12)>tail-epoch#3[event:12..19)>seam@2026-07-16T01:30:00.000Z>raw-tail@event#19(+4)',
    );
    expect(rendered).toContain(
      'authority-order-on-conflict=later-unanswered-operator>current-live-task-rail>newer-tail-band>tail-epoch#3>tail-epoch#2>tail-epoch#1>frozen-rebirth-control-if-present',
    );

    expect(renderTailEpochProvenance({
      traceId: 'thread-gap',
      epoch: 2,
      unit: 'event',
      sourceStart: 7,
      sourceEndExclusive: 9,
      committedAt: '2026-07-16T01:30:00.000Z',
      rawTailCount: 0,
      host: 'dedicated-band-message',
      bandStack: [
        { epoch: 1, sourceStart: 0, sourceEndExclusive: 5 },
        { epoch: 2, sourceStart: 7, sourceEndExclusive: 9 },
      ],
    })).toBeNull();

    expect(renderTailEpochProvenance({
      traceId: 'thread-reordered',
      epoch: 2,
      unit: 'event',
      sourceStart: 5,
      sourceEndExclusive: 9,
      committedAt: '2026-07-16T01:30:00.000Z',
      rawTailCount: 0,
      host: 'dedicated-band-message',
      bandStack: [
        { epoch: 3, sourceStart: 0, sourceEndExclusive: 5 },
        { epoch: 2, sourceStart: 5, sourceEndExclusive: 9 },
      ],
    })).toBeNull();
  });

  it('bounds stack and authority scaffolding for deep epoch stacks', () => {
    // Twelve tiled bands, 5 events each — a deep session where an unbounded
    // renderer would repeat twelve stack clauses and eleven authority entries
    // inside every new immutable band.
    const bandStack = Array.from({ length: 12 }, (_, i) => ({
      epoch: i + 1,
      sourceStart: i * 5,
      sourceEndExclusive: (i + 1) * 5,
    }));
    const rendered = renderTailEpochProvenance({
      traceId: 'thread-deep',
      epoch: 12,
      unit: 'event',
      sourceStart: 55,
      sourceEndExclusive: 60,
      committedAt: '2026-07-16T01:30:00.000Z',
      rawTailCount: 2,
      rawResumeIndex: 60,
      host: 'dedicated-band-message',
      bandStack,
    });
    expect(rendered).not.toBeNull();
    // Elders collapse into ONE cumulative span that preserves the 0-tiling;
    // per-band elder ranges stay byte-pinned in the immutable ledger.
    expect(rendered).toContain('tail-epoch#1..#9[event:0..45)');
    // The newest three bands stay explicit and exact.
    expect(rendered).toContain('tail-epoch#10[event:45..50)');
    expect(rendered).toContain('tail-epoch#11[event:50..55)');
    expect(rendered).toContain('tail-epoch#12[event:55..60)');
    // No mid-stack elder is repeated as its own clause.
    expect(rendered).not.toContain('tail-epoch#4[');
    expect(rendered).not.toContain('tail-epoch#7[');
    expect(rendered).toContain(
      'stack=frozen-prefix>tail-epoch#1..#9[event:0..45)>tail-epoch#10[event:45..50)>tail-epoch#11[event:50..55)>tail-epoch#12[event:55..60)>seam@2026-07-16T01:30:00.000Z>raw-tail@event#60(+2)',
    );
    // Authority chain: newest band + two newest elders explicit, then one
    // rollup token for the remaining elders — still newest-to-oldest.
    expect(rendered).toContain(
      'authority-order-on-conflict=later-unanswered-operator>current-live-task-rail>newer-tail-band>tail-epoch#12>tail-epoch#11>tail-epoch#10>tail-epoch#1..#9(older)>frozen-rebirth-control-if-present',
    );
    expect(rendered).not.toContain('tail-epoch#5>');
  });

  it('renders the exact creation coordinate when committedIndex is preallocated', () => {
    const base = {
      traceId: 'thread-created',
      epoch: 1,
      unit: 'event' as const,
      sourceStart: 0,
      sourceEndExclusive: 6,
      committedAt: '2026-07-16T01:30:00.000Z',
      rawTailCount: 2,
      rawResumeIndex: 6,
      host: 'dedicated-band-message' as const,
    };
    // Without a preallocated coordinate the seam stays visibly unknown.
    expect(renderTailEpochProvenance(base)).toContain(
      'created=thread-created:event#? @ 2026-07-16T01:30:00.000Z',
    );
    // With one, the artifact's own landing coordinate is exact.
    expect(renderTailEpochProvenance({ ...base, committedIndex: 6 })).toContain(
      'created=thread-created:event#6 @ 2026-07-16T01:30:00.000Z',
    );
    // A non-integer or negative coordinate is rejected to the unknown marker.
    expect(renderTailEpochProvenance({ ...base, committedIndex: -1 })).toContain(
      'created=thread-created:event#? @ 2026-07-16T01:30:00.000Z',
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
