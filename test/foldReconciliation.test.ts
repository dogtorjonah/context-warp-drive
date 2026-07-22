import { describe, expect, it } from 'vitest';

import {
  reconcileUnknownFoldAction,
  renderFoldActionResolution,
  type FoldGroundTruthAdapter,
  type FoldGroundTruthObservation,
  type FoldUnknownActionRecord,
} from '../src/foldReconciliation.ts';
import type { FoldActionRecord, FoldClaimRecord } from '../src/foldReceipts.ts';

function unknownAction(): FoldUnknownActionRecord {
  const record: FoldActionRecord = {
    recordType: 'action',
    kind: 'edit',
    text: '✏️ src/state.ts',
    targetIdentity: 'src/state.ts',
    messageIndex: 7,
    sourceTimeMs: null,
    sourceIdentity: 'event:edit-call',
    superseded: false,
    actionId: 'event:edit-call',
    toolCallId: 'edit-call',
    outcome: 'unknown',
    reconciliationRequired: true,
  };
  return record as FoldUnknownActionRecord;
}

function unknownClaim(): FoldUnknownActionRecord {
  const record: FoldClaimRecord = {
    recordType: 'claim',
    kind: 'claim-op',
    text: 'claim src/state.ts:10-20',
    targetIdentity: 'src/state.ts:10-20',
    messageIndex: 9,
    sourceTimeMs: null,
    sourceIdentity: 'event:claim-call',
    superseded: false,
    claimId: 'event:claim-call',
    toolCallId: 'claim-call',
    operation: 'acquire',
    subject: 'src/state.ts',
    range: '10-20',
    holder: 'worker-a',
    outcome: 'unknown',
    reconciliationRequired: true,
    lifecycleState: 'unknown',
    terminalizedByIdentity: null,
  };
  return record as FoldUnknownActionRecord;
}

function adapter(
  source: FoldGroundTruthAdapter['source'],
  observation: FoldGroundTruthObservation | (() => Promise<FoldGroundTruthObservation>),
): FoldGroundTruthAdapter {
  return {
    source,
    readOnly: true,
    inspectAsync: async () => typeof observation === 'function'
      ? observation()
      : observation,
  };
}

describe('interrupted mutation reconciliation', () => {
  it('resolves from evidenced filesystem truth without mutating the source record', async () => {
    const record = Object.freeze(unknownAction());
    let receivedFrozen = false;
    const filesystem: FoldGroundTruthAdapter = {
      source: 'filesystem',
      readOnly: true,
      inspectAsync: async (candidate) => {
        receivedFrozen = Object.isFrozen(candidate);
        return {
          outcome: 'applied',
          evidence: 'sha256:abc123 matches the intended post-edit bytes',
          observedAt: '2026-07-21T22:10:00Z',
        };
      },
    };

    const resolution = await reconcileUnknownFoldAction(record, [filesystem]);

    expect(receivedFrozen).toBe(true);
    expect(resolution).toMatchObject({
      version: 'fold-action-resolution/v1',
      recordType: 'action',
      recordId: 'event:edit-call',
      targetIdentity: 'src/state.ts',
      originalOutcome: 'unknown',
      outcome: 'applied',
      reconciliationRequired: false,
      consultedSources: ['filesystem'],
      resolvedBy: ['filesystem'],
      reason: 'authoritative-ground-truth',
    });
    expect(resolution.consultations[0]).toEqual({
      source: 'filesystem',
      availability: 'available',
      outcome: 'applied',
      evidence: 'sha256:abc123 matches the intended post-edit bytes',
      observedAt: '2026-07-21T22:10:00.000Z',
    });
    expect(record.outcome).toBe('unknown');
    expect(record.reconciliationRequired).toBe(true);
  });

  it('accepts an independently evidenced claim resolution from the ledger', async () => {
    const resolution = await reconcileUnknownFoldAction(unknownClaim(), [adapter('ledger', {
      outcome: 'applied',
      evidence: 'claim ledger row claim-884 is active for worker-a',
      observedAt: null,
    })]);

    expect(resolution).toMatchObject({
      recordType: 'claim',
      recordId: 'event:claim-call',
      outcome: 'applied',
      resolvedBy: ['ledger'],
    });
  });

  it('fails closed when authoritative sources conflict', async () => {
    const resolution = await reconcileUnknownFoldAction(unknownAction(), [
      adapter('filesystem', {
        outcome: 'applied',
        evidence: 'target bytes match',
        observedAt: '2026-07-21T22:10:00Z',
      }),
      adapter('atlas-history', {
        outcome: 'failed',
        evidence: 'Atlas records a rejected edit outcome',
        observedAt: '2026-07-21T22:10:01Z',
      }),
      adapter('ledger', {
        outcome: 'unknown',
        evidence: 'no terminal ledger row',
        observedAt: null,
      }),
    ]);

    expect(resolution).toMatchObject({
      outcome: 'unknown',
      reconciliationRequired: true,
      reason: 'conflicting-ground-truth',
      consultedSources: ['filesystem', 'atlas-history', 'ledger'],
      resolvedBy: [],
    });
  });

  it('keeps absent, unevidenced, and unavailable truth unknown', async () => {
    const noEvidence = await reconcileUnknownFoldAction(unknownAction(), [adapter('atlas-history', {
      outcome: 'applied',
      evidence: '',
      observedAt: 'not-a-time',
    })]);
    expect(noEvidence).toMatchObject({
      outcome: 'unknown',
      reconciliationRequired: true,
      reason: 'no-authoritative-ground-truth',
    });
    expect(noEvidence.consultations[0]).toMatchObject({
      source: 'atlas-history',
      outcome: 'unknown',
      observedAt: null,
    });

    const unavailable = await reconcileUnknownFoldAction(unknownAction(), [adapter(
      'ledger',
      async () => { throw new Error('ledger worker unavailable'); },
    )]);
    expect(unavailable).toMatchObject({
      outcome: 'unknown',
      reconciliationRequired: true,
      reason: 'ground-truth-unavailable',
    });
    expect(unavailable.consultations[0]).toEqual({
      source: 'ledger',
      availability: 'unavailable',
      outcome: 'unknown',
      evidence: 'ledger worker unavailable',
      observedAt: null,
    });
  });

  it('starts every async source together instead of serializing live reads', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const deferred = (source: FoldGroundTruthAdapter['source']): FoldGroundTruthAdapter => adapter(
      source,
      () => new Promise<FoldGroundTruthObservation>((resolve) => {
        started.push(source);
        releases.push(() => resolve({
          outcome: 'unknown',
          evidence: `${source} has no decisive row`,
          observedAt: null,
        }));
      }),
    );

    const pending = reconcileUnknownFoldAction(unknownAction(), [
      deferred('filesystem'),
      deferred('atlas-history'),
      deferred('ledger'),
    ]);
    await Promise.resolve();
    expect(started).toEqual(['filesystem', 'atlas-history', 'ledger']);
    for (const release of releases) release();
    await expect(pending).resolves.toMatchObject({
      outcome: 'unknown',
      reconciliationRequired: true,
    });
  });

  it('rejects invalid adapter sets and already-final records', async () => {
    await expect(reconcileUnknownFoldAction(
      unknownAction(),
      [] as unknown as readonly [FoldGroundTruthAdapter, ...FoldGroundTruthAdapter[]],
    )).rejects.toThrow('At least one ground-truth adapter');
    await expect(reconcileUnknownFoldAction(unknownAction(), [
      adapter('filesystem', { outcome: 'unknown', evidence: 'none', observedAt: null }),
      adapter('filesystem', { outcome: 'unknown', evidence: 'none', observedAt: null }),
    ])).rejects.toThrow('Duplicate ground-truth adapter');

    const finalRecord = { ...unknownAction(), outcome: 'applied', reconciliationRequired: false };
    await expect(reconcileUnknownFoldAction(
      finalRecord as unknown as FoldUnknownActionRecord,
      [adapter('filesystem', { outcome: 'applied', evidence: 'match', observedAt: null })],
    )).rejects.toThrow('Only unknown reconciliation-required');
  });

  it('renders byte-stable typed source citations with explicit unknown time', async () => {
    const resolution = await reconcileUnknownFoldAction(unknownAction(), [adapter('ledger', {
      outcome: 'unknown',
      evidence: 'terminal row missing',
      observedAt: null,
    })]);
    const first = renderFoldActionResolution(resolution);
    const second = renderFoldActionResolution(resolution);

    expect(first).toBe(second);
    expect(first).toContain(
      'RECONCILIATION version=fold-action-resolution/v1 record-type=action '
      + 'record-id="event:edit-call" target="src/state.ts" outcome=unknown '
      + 'reconciliation-required=true reason=no-authoritative-ground-truth '
      + 'consulted="ledger" resolved-by="none"',
    );
    expect(first).toContain(
      '↞ ground-truth source=ledger availability=available outcome=unknown '
      + 'observed-at=unknown evidence="terminal row missing"',
    );
  });
});
