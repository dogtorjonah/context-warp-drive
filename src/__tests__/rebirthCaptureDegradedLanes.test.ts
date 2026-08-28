import { describe, expect, it } from 'vitest';
import {
  REBIRTH_CAPTURE_GAP_REASON_RE,
  buildRebirthPackageV6Model,
  computeRebirthCaptureDegradedLanes,
  computeRebirthCaptureDegradedLanesFromPackage,
  renderRebirthPackageV6,
  type RebirthPackageV6ActiveEditDelta,
} from '../rebirthPackageV6.ts';

// 2026-08-28 remote-mirror outage: every box-2 build resolved zero lineage
// frontiers for ~18h. Each package rendered the omission only as a section
// banner — the capture-degraded header missed it (predicate gap) and the
// sidecar degradedResponses counter stayed 0 (never fed on success). These
// tests pin the shared predicate and the canonical lane census so a
// lineage-truncated build can never look clean again.

const OMISSION_REASON =
  '⚠ operator vault omitted 2 unfrontiered lineage id(s) (root, parent) — ancestor live tails were not read';
const RESOLUTION_FAILURE_REASON =
  '⚠ head manifest frontier resolution FAILED (ENOENT: mirror lacks trace-branches) — ancestor live tails were not read';
const STORE_UNREACHABLE_REASON =
  'episode chapter index not captured (store-unreachable-at-capture) — bounded retry remained unreadable';
const READ_INCOMPLETE_REASON =
  'operator vault capture-read-incomplete: bounded read stopped at the byte cap';
// Healthy frontier-bounded capture — the success-path reason that must NEVER
// trip the degraded predicate.
const HEALTHY_FRONTIER_REASON =
  'operator vault: ancestor byte caps applied (root≤100, parent≤200); 2 capturedAt horizon(s)';

describe('REBIRTH_CAPTURE_GAP_REASON_RE', () => {
  it('matches every capture-degradation reason family', () => {
    for (const reason of [
      OMISSION_REASON,
      RESOLUTION_FAILURE_REASON,
      STORE_UNREACHABLE_REASON,
      READ_INCOMPLETE_REASON,
    ]) {
      expect(REBIRTH_CAPTURE_GAP_REASON_RE.test(reason)).toBe(true);
    }
  });

  it('never matches healthy frontier-bounded capture reasons', () => {
    expect(REBIRTH_CAPTURE_GAP_REASON_RE.test(HEALTHY_FRONTIER_REASON)).toBe(false);
    expect(REBIRTH_CAPTURE_GAP_REASON_RE.test('')).toBe(false);
  });
});

describe('computeRebirthCaptureDegradedLanes', () => {
  it('flags the operator vault when lineage ancestors were omitted as unfrontiered', () => {
    expect(computeRebirthCaptureDegradedLanes({
      operatorVault: { partialReason: OMISSION_REASON },
    })).toEqual(['operator-vault']);
  });

  it('flags the operator vault when head-manifest frontier resolution fails', () => {
    expect(computeRebirthCaptureDegradedLanes({
      operatorVault: { partialReason: RESOLUTION_FAILURE_REASON },
    })).toEqual(['operator-vault']);
  });

  it('keeps a healthy frontier-bounded vault capture out of the degraded set', () => {
    expect(computeRebirthCaptureDegradedLanes({
      operatorVault: { partialReason: HEALTHY_FRONTIER_REASON },
    })).toEqual([]);
  });

  it('orders multiple degraded lanes deterministically', () => {
    expect(computeRebirthCaptureDegradedLanes({
      operatorVault: { partialReason: OMISSION_REASON },
      episodeChapterIndex: { partialReason: STORE_UNREACHABLE_REASON },
      cognitiveArtifactCapture: { status: 'partial' },
    })).toEqual(['operator-vault', 'episode-chapter-index', 'cognition']);
  });

  it('flags a degraded active-edit-delta capture', () => {
    expect(computeRebirthCaptureDegradedLanes({
      activeEditDelta: {
        state: 'partial',
        files: [{ filePath: 'src/a.ts' }],
        reasons: ['edit capture unavailable'],
      },
    })).toEqual(['active-edit-delta']);
  });

  it('requires a present non-exact state before an edit delta can degrade', () => {
    expect(computeRebirthCaptureDegradedLanes({
      activeEditDelta: { files: [{}], reasons: ['edit capture unavailable'] },
    })).toEqual([]);
    expect(computeRebirthCaptureDegradedLanes({
      activeEditDelta: { state: 'exact', files: [{}], reasons: ['edit capture unavailable'] },
    })).toEqual([]);
  });
});

describe('computeRebirthCaptureDegradedLanesFromPackage', () => {
  it('unwraps the rebirthV6 package member', () => {
    expect(computeRebirthCaptureDegradedLanesFromPackage({
      rebirthV6: { operatorVault: { partialReason: OMISSION_REASON } },
    })).toEqual(['operator-vault']);
  });

  it('accepts a bare v6 model record', () => {
    expect(computeRebirthCaptureDegradedLanesFromPackage({
      operatorVault: { partialReason: OMISSION_REASON },
    })).toEqual(['operator-vault']);
  });

  it('never throws and returns no lanes for garbage input', () => {
    for (const garbage of [null, undefined, 'x', 42, [], {}]) {
      expect(computeRebirthCaptureDegradedLanesFromPackage(garbage)).toEqual([]);
    }
  });

  it('drops non-string partial reasons instead of degrading', () => {
    expect(computeRebirthCaptureDegradedLanesFromPackage({
      rebirthV6: { operatorVault: { partialReason: 42 } },
    })).toEqual([]);
  });
});

function exactDelta(
  overrides: Partial<RebirthPackageV6ActiveEditDelta> = {},
): RebirthPackageV6ActiveEditDelta {
  return {
    captureId: 'atlas-edit-capture:v1:abc',
    state: 'exact',
    capturedSourceAt: '2026-08-02T18:00:00.000Z',
    completedObservedAt: '2026-08-02T18:00:00.100Z',
    inheritedCaptureIds: [],
    files: [{
      provenanceId: 'edit-file:one',
      sourceAt: '2026-08-02T17:59:00.000Z',
      filePath: 'src/example.ts',
      changeKind: 'modified',
      baselineQuality: 'exact',
      ownership: 'mine',
      state: 'open',
      insertions: 2,
      deletions: 1,
      validationState: 'pending',
      closureState: 'open',
      contributors: [{
        provenanceId: 'contributor:one',
        instanceId: 'instance-a',
        relation: 'owner',
        sourceAt: '2026-08-02T17:59:00.000Z',
      }],
      preview: {
        text: '@@ -1 +1 @@\n-old\n+new',
        complete: true,
        omittedHunks: 0,
        omittedLines: 0,
      },
      diffHandle: 'atlas_agent_diff instance_id="instance-a" capture_id="atlas-edit-capture:v1:abc" mode="unified"',
      snapshotHandle: 'atlas_snapshot file_path="src/example.ts" capture_id="atlas-edit-capture:v1:abc"',
      reason: null,
    }],
    omittedFiles: 0,
    truncated: false,
    reasons: [],
    ...overrides,
  };
}

function model(
  overrides: Partial<Parameters<typeof buildRebirthPackageV6Model>[0]> = {},
  boundaryExtras: Record<string, unknown> = {},
) {
  return buildRebirthPackageV6Model({
    boundaryAndActiveTask: {
      lifecycle: 'continuation',
      lifecycleMeaning: 'same instance identity; new session continuation',
      captureId: 'capture-1',
      capturedAt: '2026-08-02T18:00:00.000Z',
      sourceFrontier: 'event-9',
      instanceId: 'instance-a',
      instanceName: 'worker-a',
      predecessorInstanceId: null,
      predecessorName: 'worker-a',
      workspace: 'voxxo-swarm',
      cwd: '/workspace',
      runtimeChange: null,
      activeRequest: {
        text: 'Implement the frozen v6 contract.',
        chars: 33,
        source: {
          provenanceId: 'message:user-1',
          sourceAt: '2026-08-02T17:58:00.000Z',
          status: 'exact',
        },
      },
      lastMaterialAssistant: {
        text: 'I will implement it now.',
        chars: 24,
        source: {
          provenanceId: 'message:assistant-1',
          sourceAt: '2026-08-02T17:58:30.000Z',
          status: 'exact',
        },
      },
      ...boundaryExtras,
    },
    activeEditDelta: exactDelta(),
    ...overrides,
  });
}

describe('capture-degraded boundary header', () => {
  it('lists operator-vault when the lineage feed omitted unfrontiered ancestors', () => {
    const rendered = renderRebirthPackageV6(model({
      operatorVault: { units: [], rangeRecover: null, partialReason: OMISSION_REASON },
    }));
    const line = rendered.split('\n').find((row) => row.startsWith('capture-degraded='));
    expect(line).toBeDefined();
    expect(line).toContain('operator-vault');
  });

  it('lists operator-vault when head-manifest frontier resolution failed', () => {
    const rendered = renderRebirthPackageV6(model({
      operatorVault: { units: [], rangeRecover: null, partialReason: RESOLUTION_FAILURE_REASON },
    }));
    const line = rendered.split('\n').find((row) => row.startsWith('capture-degraded='));
    expect(line).toBeDefined();
    expect(line).toContain('operator-vault');
  });

  it('renders no capture-degraded line for a healthy frontier-bounded capture', () => {
    const rendered = renderRebirthPackageV6(model({
      operatorVault: { units: [], rangeRecover: null, partialReason: HEALTHY_FRONTIER_REASON },
    }));
    expect(rendered).not.toContain('capture-degraded=');
  });
});

// A1 (2026-08-28 package audit): the delivered package must declare which
// builder produced it. Absent identity renders an honest unknown — provenance
// silence is never acceptable on the boundary header.
describe('boundary builder-identity stamp', () => {
  it('renders a full built-by line when the builder identity is stamped', () => {
    const rendered = renderRebirthPackageV6(model({}, {
      builder: {
        path: 'sidecar-worker-pool',
        endpoint: '127.0.0.1:3201',
        treeSha256: 'a'.repeat(64),
        fileCount: 123,
        totalBytes: 4_500_000,
        builtMs: 8123,
      },
    }));
    const line = rendered.split('\n').find((row) => row.startsWith('built-by='));
    expect(line).toBe(
      'built-by=sidecar-worker-pool @ 127.0.0.1:3201 · src=aaaaaaaaaaaa… · files=123 · built=8123ms',
    );
  });

  it('renders honest unknown when the identity is absent, and never throws on malformed stamps', () => {
    const missing = renderRebirthPackageV6(model());
    expect(missing.split('\n').find((row) => row.startsWith('built-by=')))
      .toBe('built-by=unknown · builder identity was not stamped at capture');

    for (const malformed of [
      { path: '', treeSha256: 'not-a-digest', fileCount: -3, totalBytes: 0 },
      { treeSha256: 42 },
      'garbage',
      null,
    ]) {
      const rendered = renderRebirthPackageV6(model({}, { builder: malformed }));
      const line = rendered.split('\n').find((row) => row.startsWith('built-by='));
      expect(line).toContain('built-by=');
      expect(line).not.toContain('undefined');
      expect(line).not.toContain('NaN');
    }
  });
});

// Lane-equivalence invariant: the rendered boundary header and the exported
// census must always name the same lanes. (That renderBoundary calls the
// helper directly is proven by source inspection; this table pins the
// observable contract both surfaces share.)
describe('boundary header and lane census can never drift', () => {
  const LIFE_LEDGER_GAP_REASON =
    'life ledger capture-read-incomplete: bounded read stopped at the byte cap';
  const cases: Array<{
    name: string;
    overrides: Partial<Parameters<typeof buildRebirthPackageV6Model>[0]>;
    expectedLanes: string[];
  }> = [
    {
      name: 'operator vault gap',
      overrides: { operatorVault: { units: [], rangeRecover: null, partialReason: OMISSION_REASON } },
      expectedLanes: ['operator-vault'],
    },
    {
      name: 'episode store gap',
      overrides: { episodeChapterIndex: { units: [], rangeRecover: null, partialReason: STORE_UNREACHABLE_REASON } },
      expectedLanes: ['episode-chapter-index'],
    },
    {
      name: 'life ledger gap',
      overrides: { lifeLedger: { units: [], rangeRecover: null, partialReason: LIFE_LEDGER_GAP_REASON } },
      expectedLanes: ['life-ledger'],
    },
    {
      name: 'cognition partial',
      overrides: {
        cognitiveArtifactCapture: {
          status: 'partial',
          capturedAt: '2026-08-02T17:59:50.000Z',
          totalMatched: null,
          overlayCount: null,
          missingFamilies: [],
          warnings: ['indexed cognition worker timed out'],
        },
      },
      expectedLanes: ['cognition'],
    },
    {
      name: 'active edit delta degraded',
      overrides: {
        activeEditDelta: exactDelta({
          state: 'partial',
          reasons: ['edit capture unavailable'],
        }),
      },
      expectedLanes: ['active-edit-delta'],
    },
    {
      name: 'every family at once, canonical order',
      overrides: {
        operatorVault: { units: [], rangeRecover: null, partialReason: OMISSION_REASON },
        episodeChapterIndex: { units: [], rangeRecover: null, partialReason: STORE_UNREACHABLE_REASON },
        lifeLedger: { units: [], rangeRecover: null, partialReason: LIFE_LEDGER_GAP_REASON },
        cognitiveArtifactCapture: {
          status: 'unavailable',
          capturedAt: null,
          totalMatched: null,
          overlayCount: null,
          missingFamilies: [],
          warnings: ['store unreachable'],
        },
        activeEditDelta: exactDelta({
          state: 'unknown',
          reasons: ['without an immutable Atlas capture'],
        }),
      },
      expectedLanes: [
        'operator-vault',
        'episode-chapter-index',
        'life-ledger',
        'cognition',
        'active-edit-delta',
      ],
    },
    {
      name: 'clean capture',
      overrides: {
        operatorVault: { units: [], rangeRecover: null, partialReason: HEALTHY_FRONTIER_REASON },
      },
      expectedLanes: [],
    },
  ];

  for (const { name, overrides, expectedLanes } of cases) {
    it(`header matches helper output — ${name}`, () => {
      const built = model(overrides);
      const helperLanes = computeRebirthCaptureDegradedLanes(built);
      expect(helperLanes).toEqual(expectedLanes);
      const rendered = renderRebirthPackageV6(built);
      const line = rendered.split('\n').find((row) => row.startsWith('capture-degraded='));
      if (helperLanes.length === 0) {
        expect(line).toBeUndefined();
        return;
      }
      expect(line).toBeDefined();
      const headerLanes = (line as string)
        .slice('capture-degraded='.length)
        .split(' · ')[0]
        .split(',');
      expect(headerLanes).toEqual(helperLanes);
    });
  }
});
