import { describe, expect, it } from 'vitest';
import {
  auditContinuityBandStack,
  auditContinuityBoundary,
  auditContinuityCompletion,
  type ContinuityAuditBand,
} from '../src/continuityAudit.ts';
import {
  LIVE_CONTINUITY_STATE_HEADER,
  buildContinuityReceipt,
  renderContinuityReceiptControl,
} from '../src/continuityReceipt.ts';
import { foldProvenanceDigest } from '../src/foldProvenance.ts';

const CAPTURED_AT = '2026-07-20T04:00:00.000Z';

function receipt() {
  return buildContinuityReceipt({
    boundary: 'same_instance_hard_epoch',
    predecessorName: 'continuity-fixer',
    capturedAt: CAPTURED_AT,
    captureSourceId: 'boundary:req-1',
    sourceStatus: 'working',
    instance: {
      instanceId: 'source-1',
      instanceName: 'continuity-fixer',
      runtimeStatus: 'working',
      creationCause: 'operator_fork',
      parentInstanceId: 'parent-1',
      originEventId: 'event:origin-1',
      originSourceTimestamp: '2026-07-20T02:00:00.000Z',
    },
    rail: {
      railId: 'rail-1',
      title: 'Continuity rail',
      state: 'active',
      revision: 4,
      updatedAt: '2026-07-20T03:55:00.000Z',
      activeStep: { id: 'audit', title: 'Audit', status: 'active', instruction: 'Run the audit' },
    },
    activeRequestText: 'finish the continuity audit',
    activeRequestSourceId: 'event:user-7',
    activeRequestSourceCoordinate: 'event:event:user-7',
    activeRequestSourceTimestamp: '2026-07-20T03:58:00.000Z',
    claims: ['src/a.ts:1-10'],
    claimsAreLive: true,
    editEvidenceFiles: ['src/a.ts'],
    canonicalRange: {
      traceId: 'source-1',
      eventCount: 40,
      lastEventId: 'event:39',
      lastEventTimestamp: '2026-07-20T03:59:00.000Z',
    },
    rawTailFrontier: {
      traceId: 'source-1',
      unit: 'event',
      index: 40,
      id: 'event:39',
      exactCount: 1,
      sourceTimestamp: '2026-07-20T03:59:00.000Z',
    },
    chatroomMembership: '[CHATROOM MEMBERSHIP]\ncontinuity — continuity-fixer\n[END CHATROOM MEMBERSHIP]',
    subscriptionsKnown: true,
    subscriptions: ['continuity'],
    validationFact: 'focused audit tests passed',
  });
}

function bands(): ContinuityAuditBand[] {
  return [
    {
      epoch: 1,
      traceId: 'source-1',
      sourceStart: 0,
      sourceEndExclusive: 20,
      sourceFirstTimestamp: '2026-07-20T03:00:00.000Z',
      sourceLastTimestamp: '2026-07-20T03:20:00.000Z',
      createdAt: '2026-07-20T03:21:00.000Z',
      provenanceId: 'source-1:tail-epoch#1',
    },
    {
      epoch: 2,
      traceId: 'source-1',
      sourceStart: 20,
      sourceEndExclusive: 40,
      sourceFirstTimestamp: '2026-07-20T03:20:00.000Z',
      sourceLastTimestamp: '2026-07-20T03:59:00.000Z',
      createdAt: CAPTURED_AT,
      provenanceId: 'source-1:tail-epoch#2',
    },
  ];
}

describe('continuity boundary audit', () => {
  it('accepts one source-stamped live block with contiguous bands and immutable frozen evidence', () => {
    const value = receipt();
    const frozen = { rows: ['event:1', 'event:2'] };
    const digest = foldProvenanceDigest(frozen);
    const audited = auditContinuityBoundary({
      receipt: value,
      renderedPrompt: renderContinuityReceiptControl(value),
      bands: bands(),
      frozenArtifacts: [{
        artifactId: 'hard-seed:source-1:40',
        sourceTimestamp: '2026-07-20T03:59:00.000Z',
        frozenDigest: digest,
        currentDigest: digest,
      }],
      completedStepIds: ['lineage', 'live-state'],
      postBoundaryActivatedStepIds: ['continuity-audit'],
    });

    expect(audited).toMatchObject({ valid: true, errors: [] });
  });

  it('detects gaps, overlaps, fabricated time, identity loss, duplicate live state, mutation, and replay separately', () => {
    const value = receipt();
    const brokenBands = bands();
    brokenBands[0] = { ...brokenBands[0]!, provenanceId: '' };
    brokenBands[1] = {
      ...brokenBands[1]!,
      sourceStart: 19,
      sourceLastTimestamp: '2026-07-20T04:10:00.000Z',
    };
    const overlap = auditContinuityBoundary({
      receipt: value,
      renderedPrompt: `${renderContinuityReceiptControl(value)}\n${LIVE_CONTINUITY_STATE_HEADER}`,
      bands: brokenBands,
      frozenArtifacts: [{
        artifactId: 'hard-seed:source-1:40',
        sourceTimestamp: '2026-07-20T03:59:00.000Z',
        frozenDigest: foldProvenanceDigest({ rows: [1] }),
        currentDigest: foldProvenanceDigest({ rows: [2] }),
      }],
      completedStepIds: ['lineage'],
      postBoundaryActivatedStepIds: ['lineage'],
    });
    expect(overlap.errors.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'identity-missing',
      'band-overlap',
      'source-time-after-capture',
      'live-state-block-duplicate',
      'frozen-artifact-mutated',
      'completed-step-replayed',
    ]));

    const gapBands = bands();
    gapBands[1] = { ...gapBands[1]!, sourceStart: 21 };
    expect(auditContinuityBandStack(gapBands).errors.map((entry) => entry.code)).toContain('band-gap');
  });
});

describe('active-only completion semantics', () => {
  it.each(['glyph', 'star', 'atlas_commit', 'step_ack'] as const)(
    'does not let %s independently mark work complete',
    (signal) => {
      const audited = auditContinuityCompletion({
        claimedComplete: true,
        railState: 'active',
        validation: { status: 'unknown' },
        signals: [signal],
      });
      expect(audited.authoritativeComplete).toBe(false);
      expect(audited.errors.map((entry) => entry.code)).toEqual(expect.arrayContaining([
        'completion-rail-not-complete',
        'completion-validation-missing',
      ]));
    },
  );

  it('requires terminal rail state and source-stamped verified evidence', () => {
    expect(auditContinuityCompletion({
      claimedComplete: true,
      railState: 'complete',
      validation: {
        status: 'verified',
        sourceId: 'forge:test:run-1',
        sourceTimestamp: CAPTURED_AT,
      },
      signals: ['glyph', 'star', 'atlas_commit', 'step_ack'],
    })).toMatchObject({ valid: true, authoritativeComplete: true });
  });

  it('warns rather than errors when no structured validation exists to confirm completion', () => {
    const audited = auditContinuityCompletion({ claimedComplete: true, railState: 'complete' });
    expect(audited.valid).toBe(true);
    expect(audited.authoritativeComplete).toBe(false);
    expect(audited.warnings.map((entry) => entry.code)).toContain('completion-validation-missing');
  });

  it('errors when a validation object is supplied but lacks source-stamped verification', () => {
    const audited = auditContinuityCompletion({
      claimedComplete: true,
      railState: 'complete',
      validation: { status: 'unknown' },
    });
    expect(audited.valid).toBe(false);
    expect(audited.errors.map((entry) => entry.code)).toContain('completion-validation-missing');
  });
});

describe('raw-tail frontier index invariant', () => {
  function withFrontierIndex(index: number) {
    const base = receipt();
    const liveState = base.liveState!;
    return {
      ...base,
      liveState: {
        ...liveState,
        rawTailFrontier: {
          ...liveState.rawTailFrontier,
          value: { ...liveState.rawTailFrontier.value!, index },
        },
      },
    };
  }

  it('accepts a frontier that leads the packaged canonical range', () => {
    // The frontier is captured at snapshot time while the canonical range is
    // counted later at package assembly, so a leading frontier is the normal
    // case whenever the tail advances after capture.
    const value = withFrontierIndex(316);
    const audited = auditContinuityBoundary({
      receipt: value,
      renderedPrompt: renderContinuityReceiptControl(value),
    });
    expect(audited.errors.map((entry) => entry.code)).not.toContain('frontier-index-behind');
  });

  it('rejects a frontier that trails the packaged canonical range', () => {
    const value = withFrontierIndex(12);
    const audited = auditContinuityBoundary({
      receipt: value,
      renderedPrompt: renderContinuityReceiptControl(value),
    });
    expect(audited.valid).toBe(false);
    expect(audited.errors.map((entry) => entry.code)).toContain('frontier-index-behind');
  });
});
