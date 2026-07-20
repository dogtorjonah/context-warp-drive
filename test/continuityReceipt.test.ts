import { describe, expect, test } from 'vitest';

import {
  buildContinuityReceipt,
  CONTINUITY_RECEIPT_VERSION,
  continuityReceiptFromProse,
  detectContinuityHazards,
  findLatestValidationFact,
  isContinuityReceipt,
  normalizeContinuityReceiptRail,
  renderContinuityReceiptControl,
  resolveContinuityBoundary,
  type ContinuityReceipt,
  type ContinuityReceiptRail,
} from '../src/continuityReceipt.ts';

const TYPED_RAIL: ContinuityReceiptRail = {
  railId: 'rail-9e2b1075',
  title: 'Continue fold-continuity repair implementation',
  state: 'active',
  revision: 31,
  locked: true,
  doneSteps: 14,
  totalSteps: 23,
  percentComplete: 61,
  activeStep: {
    id: 'continuity-receipt',
    title: 'Make boundary state typed and singular',
    status: 'active',
    position: 15,
    totalSteps: 23,
    instruction: 'Introduce a versioned typed continuity receipt as the authoritative boundary snapshot.',
  },
  queuedStepTitle: 'Finalize creation and transaction coordinates',
  updatedAt: '2026-07-17T20:56:55.631Z',
};

function typedReceipt(overrides: Partial<ContinuityReceipt> = {}): ContinuityReceipt {
  return {
    version: CONTINUITY_RECEIPT_VERSION,
    boundary: 'continuation',
    predecessorName: 'rebirth-rail-snapshot',
    capturedAt: '2026-07-17T21:00:00.000Z',
    sourceStatus: 'working',
    rail: TYPED_RAIL,
    nextAction: TYPED_RAIL.activeStep?.instruction,
    activeRequest: { text: 'Fix the fold boundary.', totalChars: 23 },
    editClaim: { supplied: true, claims: [], editEvidenceFiles: ['packages/context-warp/src/continuityReceipt.ts'] },
    validation: { fact: '192/192 tests in both canonical trees' },
    hazards: [],
    canonicalRange: { traceId: 'rebirth-rail-snapshot', eventCount: 336 },
    disagreements: [],
    ...overrides,
  };
}

describe('resolveContinuityBoundary', () => {
  test('lifecycle boundary wins over every other signal', () => {
    expect(resolveContinuityBoundary({
      lifecycleBoundary: 'same_instance_hard_epoch',
      isFreshFork: true,
      mergedLineageCount: 2,
    })).toBe('same_instance_hard_epoch');
  });

  test('fresh fork beats brain merge; brain merge beats continuation', () => {
    expect(resolveContinuityBoundary({ isFreshFork: true, mergedLineageCount: 3 })).toBe('fresh_fork');
    expect(resolveContinuityBoundary({ isFreshFork: false, mergedLineageCount: 1 })).toBe('brain_merge');
    expect(resolveContinuityBoundary({ mergedLineageCount: 2 })).toBe('brain_merge');
  });

  test('defaults to continuation when no signal exists', () => {
    expect(resolveContinuityBoundary({})).toBe('continuation');
    expect(resolveContinuityBoundary({ isFreshFork: false, mergedLineageCount: 0 })).toBe('continuation');
  });
});

describe('buildContinuityReceipt (typed assembly)', () => {
  test('next action defaults to the active step instruction', () => {
    const receipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'agent',
      rail: TYPED_RAIL,
    });
    expect(receipt.nextAction).toBe(TYPED_RAIL.activeStep?.instruction);
    expect(receipt.rail?.activeStep?.id).toBe('continuity-receipt');
  });

  test('explicit next action overrides the rail instruction', () => {
    const receipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'agent',
      rail: TYPED_RAIL,
      nextAction: 'Run the parity gate.',
    });
    expect(receipt.nextAction).toBe('Run the parity gate.');
  });

  test('captures active request text with true totalChars', () => {
    const receipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'agent',
      capturedAt: '2026-07-20T03:00:00.000Z',
      captureSourceId: 'capture-1',
      activeRequestText: '  Do the thing.  ',
      activeRequestSourceId: 'message-42',
      activeRequestSourceCoordinate: 'event:message-42',
      activeRequestSourceTimestamp: '2026-07-20T02:59:59.000Z',
      claimsAreLive: false,
      claims: ['src/a.ts'],
      hasActiveEditDelta: true,
    });
    expect(receipt.activeRequest).toEqual({ text: '  Do the thing.  ', totalChars: 17 });
    expect(receipt.liveState?.request.source).toEqual({
      kind: 'operator-message',
      id: 'message-42',
      coordinate: 'event:message-42',
      sourceTimestamp: '2026-07-20T02:59:59.000Z',
      capturedAt: '2026-07-20T03:00:00.000Z',
    });
    expect(receipt.liveState?.claims.source).toMatchObject({
      kind: 'bundled-active-edit-delta',
      id: 'capture-1',
    });
    expect(receipt.liveState?.edits.status).toBe('current');
  });

  test('edit/claim supplied defaults from claims and edits, or explicit flag', () => {
    const withClaims = buildContinuityReceipt({
      boundary: 'continuation', predecessorName: 'agent', claims: ['src/a.ts'],
    });
    expect(withClaims.editClaim.supplied).toBe(true);
    const empty = buildContinuityReceipt({ boundary: 'continuation', predecessorName: 'agent' });
    expect(empty.editClaim.supplied).toBe(false);
    const forced = buildContinuityReceipt({
      boundary: 'continuation', predecessorName: 'agent', hasActiveEditDelta: true,
    });
    expect(forced.editClaim.supplied).toBe(true);
  });

  test('explicit validation fact wins over scanned sources; latest scanned line wins otherwise', () => {
    const explicit = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'agent',
      validationFact: 'shipped',
      validationSources: ['validation state: stale'],
    });
    expect(explicit.validation.fact).toBe('shipped');

    const scanned = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'agent',
      validationSources: [
        'validation state: first fact\nnoise',
        'some line\nVerification: second fact wins',
      ],
    });
    expect(scanned.validation.fact).toBe('second fact wins');
  });

  test('hazards combine marker detection with explicit extras', () => {
    const receipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'agent',
      hazardSources: ['tail text ⚠️ UNRESOLVED PROVIDER/RUNTIME ERROR: boom'],
      hazards: ['disk snapshot stale'],
    });
    expect(receipt.hazards).toHaveLength(2);
    expect(receipt.hazards[0]).toContain('unresolved provider/runtime error');
    expect(receipt.hazards[1]).toBe('disk snapshot stale');
  });

  test('idle runtime status against an executable rail records a disagreement', () => {
    const receipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'agent',
      sourceStatus: 'idle',
      rail: TYPED_RAIL,
    });
    expect(receipt.disagreements).toHaveLength(1);
    expect(receipt.disagreements[0]).toContain('status=idle');
    expect(receipt.disagreements[0]).toContain('rail state wins');
  });

  test('idle runtime status with no executable rail records no disagreement', () => {
    const receipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'agent',
      sourceStatus: 'idle',
    });
    expect(receipt.disagreements).toHaveLength(0);
  });
});

describe('continuityReceiptFromProse (legacy fallback)', () => {
  const PROSE_RAIL = [
    '[Task rail] Continue fold-continuity repair implementation (rail-9e2b1075)',
    'instance=UpnkMK_F state=active rev=31 locked=yes',
    'progress: total=23 done=14 skipped=0 pending=8 active=1 blocked=0 needs_review=0 in_progress=0 percent=61%',
    '',
    'Active/blocking step: 15/23 continuity-receipt [active] Make boundary state typed and singular',
    'Introduce a versioned typed continuity receipt as the authoritative boundary snapshot.',
    'Loaded steps:',
    '  14. evidence-guidance [done] Make quantitative validation fold-proof',
    '> 15. continuity-receipt [active] Make boundary state typed and singular',
    '  16. provenance-finalize [pending] Finalize creation and transaction coordinates',
  ].join('\n');

  test('parses a typed Task Rail Context block into rail facts', () => {
    const receipt = continuityReceiptFromProse({
      boundary: 'continuation',
      predecessorName: 'agent',
      taskRailContext: PROSE_RAIL,
    });
    expect(receipt.rail?.railId).toBe('rail-9e2b1075');
    expect(receipt.rail?.title).toBe('Continue fold-continuity repair implementation');
    expect(receipt.rail?.state).toBe('active');
    expect(receipt.rail?.doneSteps).toBe(14);
    expect(receipt.rail?.totalSteps).toBe(23);
    expect(receipt.rail?.percentComplete).toBe(61);
    expect(receipt.rail?.activeStep).toMatchObject({
      id: 'continuity-receipt',
      status: 'active',
      position: 15,
      totalSteps: 23,
      instruction: 'Introduce a versioned typed continuity receipt as the authoritative boundary snapshot.',
    });
    expect(receipt.rail?.queuedStepTitle).toBe('Finalize creation and transaction coordinates');
    expect(receipt.nextAction).toBe('Introduce a versioned typed continuity receipt as the authoritative boundary snapshot.');
  });

  test('falls back to Resume Point raw lines when the rail header is absent', () => {
    const receipt = continuityReceiptFromProse({
      boundary: 'continuation',
      predecessorName: 'agent',
      resumePoint: [
        '📋 Legacy rail (rail-318d2c86) — active — 3/5 (60%)',
        '▶ Active: step-2 [in_progress] — Do the thing',
        '⏭ Next action: keep going',
      ].join('\n'),
    });
    expect(receipt.rail?.rawLine).toBe('📋 Legacy rail (rail-318d2c86) — active — 3/5 (60%)');
    expect(receipt.rail?.activeStepRawLine).toContain('▶ Active: step-2');
    expect(receipt.nextAction).toBe('⏭ Next action: keep going');
  });

  test('detects Resume Point vs Task Rail Context state disagreement', () => {
    const receipt = continuityReceiptFromProse({
      boundary: 'continuation',
      predecessorName: 'agent',
      taskRailContext: PROSE_RAIL,
      resumePoint: '📋 Continue fold-continuity repair implementation (rail-9e2b1075) — complete — 23/23 (100%)',
    });
    expect(receipt.disagreements.some((d) => d.includes('state=complete') && d.includes('state=active'))).toBe(true);
  });

  test('parses claims and edit evidence from the Active Edit Delta', () => {
    const receipt = continuityReceiptFromProse({
      boundary: 'continuation',
      predecessorName: 'agent',
      activeEditDelta: [
        'Files claimed for editing: src/a.ts, src/b.ts',
        '[02:32 PM] Edit → src/c.ts',
        '[02:33 PM] Edit → src/c.ts',
      ].join('\n'),
    });
    expect(receipt.editClaim.supplied).toBe(true);
    expect(receipt.editClaim.claims).toEqual(['src/a.ts', 'src/b.ts']);
    expect(receipt.editClaim.editEvidenceFiles).toEqual(['src/c.ts']);
  });

  test('no Active Edit Delta means not supplied', () => {
    const receipt = continuityReceiptFromProse({ boundary: 'continuation', predecessorName: 'agent' });
    expect(receipt.editClaim.supplied).toBe(false);
  });
});

describe('transport validation', () => {
  test('isContinuityReceipt accepts a valid receipt and rejects wrong versions', () => {
    expect(isContinuityReceipt(typedReceipt())).toBe(true);
    expect(isContinuityReceipt({ ...typedReceipt(), version: 2 })).toBe(false);
    expect(isContinuityReceipt({ ...typedReceipt(), predecessorName: '' })).toBe(false);
    expect(isContinuityReceipt(null)).toBe(false);
    expect(isContinuityReceipt('receipt')).toBe(false);
  });

  test('receipt survives a JSON round trip', () => {
    const receipt = typedReceipt();
    expect(isContinuityReceipt(JSON.parse(JSON.stringify(receipt)))).toBe(true);
  });

  test('normalizeContinuityReceiptRail keeps typed fields and drops malformed input', () => {
    expect(normalizeContinuityReceiptRail(TYPED_RAIL)).toEqual(TYPED_RAIL);
    expect(normalizeContinuityReceiptRail({ railId: 'r', title: 5, state: 'active' })).toBeUndefined();
    expect(normalizeContinuityReceiptRail(undefined)).toBeUndefined();
    expect(normalizeContinuityReceiptRail('rail')).toBeUndefined();
  });
});

describe('renderContinuityReceiptControl (canonical renderer)', () => {
  test('renders every authoritative line from typed state', () => {
    const block = renderContinuityReceiptControl(typedReceipt());
    expect(block).toContain('── Rebirth Control (AUTHORITATIVE) ──');
    expect(block).toContain('boundary: continuation');
    expect(block).toContain('identity: same durable instance "rebirth-rail-snapshot" across a session or model boundary');
    expect(block).toContain('source status: working');
    expect(block).toContain('rail: 📋 Continue fold-continuity repair implementation (rail-9e2b1075) — active — 14/23 (61%)');
    expect(block).toContain('active rail step: ▶ Active: continuity-receipt [active] — Make boundary state typed and singular');
    expect(block).toContain('immediate next action: Introduce a versioned typed continuity receipt as the authoritative boundary snapshot.');
    expect(block).toContain('queued after current: Finalize creation and transaction coordinates');
    expect(block).toContain('edit/claim state: no active claims declared; recent edit evidence covers 1 file(s); recent edits are evidence, not ownership');
    expect(block).toContain('validation state (explicit): 192/192 tests in both canonical trees');
    expect(block).toContain('source disagreement: none detected among bundled explicit sources');
    expect(block).toContain('active request (verbatim; sole authoritative body):\nFix the fold boundary.');
  });

  test('renders honest unknowns and not-supplied lines when state is sparse', () => {
    const block = renderContinuityReceiptControl(typedReceipt({
      rail: undefined,
      nextAction: undefined,
      activeRequest: undefined,
      editClaim: { supplied: false, claims: [], editEvidenceFiles: [] },
      validation: {},
    }));
    expect(block).toContain('rail: unknown');
    expect(block).toContain('active rail step: unknown');
    expect(block).toContain('immediate next action: unknown');
    expect(block).not.toContain('queued after current:');
    expect(block).toContain('edit/claim state: not supplied');
    expect(block).toContain('validation state: no explicit validation fact bundled; step status alone is not proof');
    expect(block).toContain('active request: none bundled');
  });

  test('renders disagreements and hazards as visible lines', () => {
    const block = renderContinuityReceiptControl(typedReceipt({
      disagreements: ['runtime status=idle conflicts with executable rail state=active; rail state wins for task continuity'],
      hazards: ['unresolved provider/runtime error captured after the last genuine assistant message'],
    }));
    expect(block).toContain('source disagreement: runtime status=idle conflicts');
    expect(block).toContain('unresolved hazards: unresolved provider/runtime error captured');
  });

  test('renders claims with the ownership caveat', () => {
    const block = renderContinuityReceiptControl(typedReceipt({
      editClaim: { supplied: true, claims: ['src/a.ts', 'src/b.ts'], editEvidenceFiles: [] },
    }));
    expect(block).toContain('edit/claim state: 2 active claim(s): src/a.ts, src/b.ts; Active Edit Delta below governs ownership');
  });
});

describe('cross-surface consistency (one receipt, many surfaces)', () => {
  test('two surfaces rendering the same receipt agree on every line except their capsule policy', () => {
    const receipt = typedReceipt({
      activeRequest: { text: 'x'.repeat(9_000), totalChars: 9_000 },
    });
    const surfaceA = renderContinuityReceiptControl(receipt);
    const surfaceB = renderContinuityReceiptControl(receipt, {
      formatActiveRequest: (text) => `active request (custom surface capsule, ${text.length} chars)`,
    });
    const linesA = surfaceA.split('\n');
    const linesB = surfaceB.split('\n');
    // The capsule may span several lines (default elision); compare the
    // authoritative head — every line BEFORE the active-request capsule —
    // which is where cross-surface agreement must hold.
    const headUntilCapsule = (lines: string[]) => {
      const index = lines.findIndex((line) => line.startsWith('active request'));
      return index === -1 ? lines : lines.slice(0, index);
    };
    expect(headUntilCapsule(linesA)).toEqual(headUntilCapsule(linesB));
    expect(surfaceB).toContain('active request (custom surface capsule, 9000 chars)');
  });

  test('typed receipt outranks stale prose-shaped fields on the same receipt object', () => {
    // The renderer never consults prose when the typed fields exist: rail and
    // nextAction come straight from the receipt even if the caller also had
    // legacy prose at hand.
    const receipt = typedReceipt({
      rail: { ...TYPED_RAIL, state: 'complete', doneSteps: 23, percentComplete: 100 },
    });
    const block = renderContinuityReceiptControl(receipt);
    expect(block).toContain('— complete — 23/23 (100%)');
    expect(block).not.toContain('— active — 14/23');
  });
});

describe('standalone scanners', () => {
  test('detectContinuityHazards only fires on the unresolved marker', () => {
    expect(detectContinuityHazards(['all clear'])).toEqual([]);
    expect(detectContinuityHazards(['⚠️ UNRESOLVED PROVIDER/RUNTIME ERROR: ECONNRESET'])).toHaveLength(1);
  });

  test('findLatestValidationFact strips the label and prefers the latest line', () => {
    expect(findLatestValidationFact(['validation state: first', 'Verification: last one'])).toBe('last one');
    expect(findLatestValidationFact(['nothing here'])).toBeUndefined();
  });
});
