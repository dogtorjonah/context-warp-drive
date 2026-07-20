import { describe, expect, it } from 'vitest';
import {
  auditCloneTakeover,
  auditContinuityBandStack,
  auditContinuityBoundary,
  auditContinuityCompletion,
  selectActiveContinuityDelta,
  type CloneTakeoverAuditInput,
  type ContinuityAuditBand,
  type ContinuityTakeoverRecord,
  type ContinuityTakeoverSnapshot,
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

  it('dedupes by stable provenance and drops completed or superseded rows from the active delta', () => {
    const delta = selectActiveContinuityDelta([
      { provenanceId: 'step:a', sourceSequence: 1, sourceTimestamp: '2026-07-20T01:00:00Z', status: 'active' as const },
      { provenanceId: 'step:b', sourceSequence: 2, sourceTimestamp: '2026-07-20T01:01:00Z', status: 'blocked' as const },
      { provenanceId: 'step:a', sourceSequence: 3, sourceTimestamp: '2026-07-20T01:02:00Z', status: 'complete' as const },
      { provenanceId: 'step:b', sourceSequence: 4, sourceTimestamp: '2026-07-20T01:03:00Z', status: 'active' as const },
      { provenanceId: 'step:c', sourceSequence: 5, sourceTimestamp: '2026-07-20T01:04:00Z', status: 'superseded' as const },
    ]);
    expect(delta).toEqual([
      expect.objectContaining({ provenanceId: 'step:b', sourceSequence: 4, status: 'active' }),
    ]);
  });
});

function record(provenanceId: string): ContinuityTakeoverRecord {
  return {
    provenanceId,
    sourceTimestamp: '2026-07-20T03:50:00.000Z',
    digest: foldProvenanceDigest({ provenanceId }),
  };
}

function takeover(): CloneTakeoverAuditInput {
  const source: ContinuityTakeoverSnapshot = {
    instance: {
      instanceId: 'source-1',
      originEventId: 'event:source-origin',
      originSourceTimestamp: '2026-07-20T01:00:00.000Z',
      createdBy: { kind: 'operator', id: 'jonah' },
    },
    rail: {
      railId: 'rail-1',
      ownerInstanceId: 'source-1',
      creatorInstanceId: 'source-1',
      contentDigest: foldProvenanceDigest({ steps: ['a', 'b'], state: 'active' }),
    },
    claims: [{ ...record('claim:src/a.ts:1-10'), path: 'src/a.ts:1-10', ownerInstanceId: 'source-1' }],
    blockers: [record('blocker:waiting-on-fixture')],
    validation: [record('validation:run-1')],
    provenance: [record('event:source-origin')],
  };
  const replacement: ContinuityTakeoverSnapshot = {
    ...source,
    instance: {
      instanceId: 'replacement-1',
      parentInstanceId: 'source-1',
      replacesInstanceId: 'source-1',
      originEventId: 'event:replacement-origin',
      originSourceTimestamp: CAPTURED_AT,
      createdBy: { kind: 'operator', id: 'jonah' },
    },
    rail: source.rail ? { ...source.rail, ownerInstanceId: 'replacement-1' } : undefined,
    claims: source.claims.map((claim) => ({ ...claim, ownerInstanceId: 'replacement-1' })),
  };
  return { source, replacement, expectedCreator: { kind: 'operator', id: 'jonah' } };
}

describe('clone takeover audit', () => {
  it('preserves rail, claims, blockers, validation, and provenance while moving only ownership', () => {
    expect(auditCloneTakeover(takeover())).toMatchObject({ valid: true, errors: [] });
  });

  it('detects creator confusion, ownership loss, and mutated boundary evidence', () => {
    const input = takeover();
    const replacement = {
      ...input.replacement,
      instance: { ...input.replacement.instance, createdBy: { kind: 'agent' as const, id: 'source-1' } },
      rail: input.replacement.rail
        ? { ...input.replacement.rail, ownerInstanceId: 'source-1', contentDigest: 'sha256:mutated' }
        : undefined,
      claims: input.replacement.claims.map((claim) => ({ ...claim, ownerInstanceId: 'source-1' })),
      blockers: [],
    };
    const audited = auditCloneTakeover({ ...input, replacement });
    expect(audited.errors.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'takeover-creator-mismatch',
      'takeover-rail-owner-mismatch',
      'takeover-rail-content-changed',
      'takeover-claim-owner-mismatch',
      'takeover-record-missing',
    ]));
  });
});
