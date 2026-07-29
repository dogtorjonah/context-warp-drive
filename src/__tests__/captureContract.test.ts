import { describe, expect, it } from 'vitest';
import {
  CAPTURE_CONTRACT_VERSION,
  CAPTURE_OUTCOME_STATUSES,
  CAPTURE_SEAL_REASONS,
  isCaptureOutcomeStatus,
  isCaptureSealReason,
  isGenuineIdleTransition,
  isSyntheticInterruptMarker,
  isCaptureBoundaryArtifact,
  SYNTHETIC_USER_INTERRUPT_MARKERS,
  type EpisodeCaptureAttribution,
  type EpisodeCaptureOutcome,
} from '../captureContract.ts';

describe('capture-contract/v3 freeze identity', () => {
  it('exposes the durable freeze version', () => {
    expect(CAPTURE_CONTRACT_VERSION).toBe('capture-contract/v3');
  });
});

describe('CAPTURE_SEAL_REASONS production vocabulary', () => {
  it('contains exactly the five production seal reasons', () => {
    expect([...CAPTURE_SEAL_REASONS]).toEqual(['epoch', 'rebirth', 'release', 'idle', 'backfill']);
  });

  it('stays distinct from the portable glyph-burst store vocabulary', () => {
    const portableGlyphBurst = ['verdict', 'hazard', 'blocked', 'window_end'];
    for (const reason of portableGlyphBurst) {
      expect(isCaptureSealReason(reason)).toBe(false);
    }
  });

  it('isCaptureSealReason accepts members and rejects non-members/non-strings', () => {
    for (const reason of CAPTURE_SEAL_REASONS) {
      expect(isCaptureSealReason(reason)).toBe(true);
    }
    expect(isCaptureSealReason('idle ')).toBe(false);
    expect(isCaptureSealReason('IDLE')).toBe(false);
    expect(isCaptureSealReason('')).toBe(false);
    expect(isCaptureSealReason(undefined)).toBe(false);
    expect(isCaptureSealReason(null)).toBe(false);
    expect(isCaptureSealReason(42)).toBe(false);
  });
});

describe('CAPTURE_OUTCOME_STATUSES terminal vocabulary', () => {
  it('contains exactly the five canonical terminal outcomes', () => {
    expect([...CAPTURE_OUTCOME_STATUSES]).toEqual([
      'done',
      'blocked',
      'needs_review',
      'skipped',
      'incomplete',
    ]);
  });

  it('accepts members and rejects aliases, seal reasons, and non-strings', () => {
    for (const status of CAPTURE_OUTCOME_STATUSES) {
      expect(isCaptureOutcomeStatus(status)).toBe(true);
    }
    for (const invalid of ['complete', 'needs-review', 'idle', '', undefined, null, 1]) {
      expect(isCaptureOutcomeStatus(invalid)).toBe(false);
    }
  });
});

describe('plural episode transport DTOs', () => {
  it('preserves attribution source identity, source time, and batch ordinal', () => {
    const attribution: EpisodeCaptureAttribution = {
      railId: 'rail-1',
      stepId: 'step-2',
      intentionId: 'intent-3',
      sourceEventId: 'tool-call-4',
      sourceAt: '2026-07-29T05:30:00.000Z',
      ordinal: 1,
    };
    expect(attribution).toEqual({
      railId: 'rail-1',
      stepId: 'step-2',
      intentionId: 'intent-3',
      sourceEventId: 'tool-call-4',
      sourceAt: '2026-07-29T05:30:00.000Z',
      ordinal: 1,
    });
  });

  it('keeps an unknown outcome source time explicitly null', () => {
    const outcome: EpisodeCaptureOutcome = {
      status: 'blocked',
      sealedBySourceEventId: 'tool-call-5',
      sealedByReason: 'release',
      sourceAt: null,
      ordinal: 0,
      stepId: 'step-2',
      verdict: 'blocked',
      evidenceRef: 'evidence-6',
    };
    expect(outcome.sourceAt).toBeNull();
    expect(isCaptureOutcomeStatus(outcome.status)).toBe(true);
    expect(isCaptureSealReason(outcome.sealedByReason)).toBe(true);
  });
});

describe('isGenuineIdleTransition', () => {
  it('is genuine only when entering idle with no queue and no deferral', () => {
    expect(isGenuineIdleTransition({ toStatus: 'idle', inputQueueDepth: 0, idleCleanupDeferred: false })).toBe(true);
  });

  it('rejects deferred idle (queued input keeps cleanup deferred)', () => {
    expect(isGenuineIdleTransition({ toStatus: 'idle', inputQueueDepth: 2, idleCleanupDeferred: true })).toBe(false);
  });

  it('rejects idle with queued input even if the deferral flag was not set', () => {
    expect(isGenuineIdleTransition({ toStatus: 'idle', inputQueueDepth: 1, idleCleanupDeferred: false })).toBe(false);
  });

  it('rejects non-idle targets', () => {
    for (const toStatus of ['working', 'compacting', 'stopped', 'error', 'hibernated']) {
      expect(isGenuineIdleTransition({ toStatus, inputQueueDepth: 0, idleCleanupDeferred: false })).toBe(false);
    }
  });
});

describe('isSyntheticInterruptMarker', () => {
  it('matches the known relay-interrupt synthetic rows', () => {
    for (const marker of SYNTHETIC_USER_INTERRUPT_MARKERS) {
      expect(isSyntheticInterruptMarker(marker)).toBe(true);
      expect(isSyntheticInterruptMarker(`  ${marker}  `)).toBe(true);
    }
  });

  it('matches markers with trailing relay-appended context', () => {
    expect(isSyntheticInterruptMarker('[Request interrupted by user] (relay fold epoch)')).toBe(true);
  });

  it('rejects near-misses and ordinary user text', () => {
    expect(isSyntheticInterruptMarker('[Request interrupted by user')).toBe(false);
    expect(isSyntheticInterruptMarker('Request interrupted by user')).toBe(false);
    expect(isSyntheticInterruptMarker('please interrupt the request')).toBe(false);
    expect(isSyntheticInterruptMarker('')).toBe(false);
  });
});

describe('isCaptureBoundaryArtifact quarantine', () => {
  it('quarantines fold/rebirth/provider initiators regardless of marker text', () => {
    for (const initiator of ['fold', 'rebirth', 'provider'] as const) {
      expect(isCaptureBoundaryArtifact({ initiator })).toBe(true);
      expect(isCaptureBoundaryArtifact({ initiator, markerText: '[Request interrupted by user]' })).toBe(true);
      expect(isCaptureBoundaryArtifact({ initiator, markerText: 'unrelated text' })).toBe(true);
    }
  });

  it('fails closed on unknown initiator carrying a synthetic marker', () => {
    expect(isCaptureBoundaryArtifact({ initiator: 'unknown', markerText: '[Request interrupted by user]' })).toBe(true);
    expect(isCaptureBoundaryArtifact({ initiator: 'unknown', markerText: '[Request interrupted by user for tool use]' })).toBe(true);
  });

  it('does not quarantine unknown initiator without a synthetic marker', () => {
    expect(isCaptureBoundaryArtifact({ initiator: 'unknown' })).toBe(false);
    expect(isCaptureBoundaryArtifact({ initiator: 'unknown', markerText: 'genuine user words' })).toBe(false);
  });

  it('never quarantines genuine user interrupts, even with the same marker text', () => {
    expect(isCaptureBoundaryArtifact({ initiator: 'user', markerText: '[Request interrupted by user]' })).toBe(false);
    expect(isCaptureBoundaryArtifact({ initiator: 'user' })).toBe(false);
  });
});
