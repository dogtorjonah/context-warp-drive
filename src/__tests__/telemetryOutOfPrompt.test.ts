import { describe, expect, it } from 'vitest';
import {
  buildRebirthPackageV6Model,
  renderRebirthPackageV6,
} from '../rebirthPackageV6.ts';

/**
 * S1 — build telemetry belongs in the audit surface, not in the prompt.
 *
 * The delivered package is what an agent spends attention on; builder identity,
 * per-stage prep timings, suppression censuses and lane vocabularies are what
 * an OPERATOR spends attention on when a build looks wrong. They were rendered
 * inline, so every successor paid for them on every boundary. The diagnostic
 * render (what the persisted artifact and the ghost preview read) keeps them
 * verbatim; the agent-facing render keeps one health census line.
 */
const TELEMETRY_TOKENS = [
  'built-by=',
  'package-build=',
  'request-prep=',
  'unaccounted=',
  'sidecar-boot=',
  'relay-boot=',
  'capture-partial-lanes=',
  'class-vocabulary=',
  'capture-degraded=',
  'sections-omitted=',
  'budget-phase=',
  'versions=model:',
] as const;

const model = () => buildRebirthPackageV6Model({
  boundaryAndActiveTask: {
    lifecycle: 'continuation',
    lifecycleMeaning: 'same instance identity; new session continuation',
    captureId: 'telemetry-split',
    capturedAt: '2026-09-09T04:00:00.000Z',
    sourceFrontier: 'event-9',
    instanceId: 'telemetry-self',
    instanceName: 'telemetry-self',
    predecessorInstanceId: null,
    predecessorName: 'telemetry-self',
    workspace: 'voxxo-swarm',
    cwd: '/workspace',
    runtimeChange: null,
    activeRequest: null,
    lastMaterialAssistant: null,
    builder: {
      path: 'sidecar-worker-pool',
      endpoint: '127.0.0.1:3201',
      treeSha256: 'deadbeefdeadbeef00000000000000000000000000000000000000000000beef',
      fileCount: 102,
      totalBytes: 1_234_567,
      packageBuildMs: 817,
      gitSha7: '2d9e684',
      sidecarBootedAt: '2026-09-09T06:53:50.914Z',
      relayBootedAt: '2026-09-09T06:55:49.203Z',
      requestToCaptureMs: 9460,
      requestPrep: {
        totalMs: 4822,
        snapshotMs: 4822,
        frontierMs: 669,
        atlasLandedMs: 748,
      },
    },
  },
  executionState: {
    facts: [{
      provenanceId: 'rail:one',
      sourceAt: '2026-09-09T03:59:00.000Z',
      status: 'exact',
      kind: 'rail',
      text: 'rail-telemetry · active',
    }],
    unknownReasons: [],
  },
});

describe('S1 build telemetry stays out of the delivered prompt', () => {
  it('renders no builder/timing/lane telemetry in the agent-facing package', () => {
    const delivered = renderRebirthPackageV6(model());
    for (const token of TELEMETRY_TOKENS) {
      expect(delivered, `delivered package must not carry ${token}`).not.toContain(token);
    }
    // At most ONE health census line — never a per-lane census fan-out. Zero is
    // legitimate when nothing was captured to count; two would mean the header
    // and a section body drifted into competing censuses.
    expect((delivered.match(/History census:/gu) ?? []).length).toBeLessThanOrEqual(1);
  });

  it('keeps every telemetry field in the diagnostic render the audit surface reads', () => {
    const diagnostic = renderRebirthPackageV6(model(), { diagnostic: true });
    // Values, not just presence: an audit artifact that rounds or re-derives a
    // measurement is not the same evidence the operator was promised.
    expect(diagnostic).toContain('built-by=sidecar-worker-pool');
    expect(diagnostic).toContain('127.0.0.1:3201');
    expect(diagnostic).toContain('files=102');
    expect(diagnostic).toContain('package-build=817ms');
    expect(diagnostic).toContain('request-prep=[');
    expect(diagnostic).toContain('snapshot=4822ms');
    expect(diagnostic).toContain('frontier=669ms');
    expect(diagnostic).toContain('atlas=748ms');
    expect(diagnostic).toContain('versions=model:');
    expect(diagnostic).toContain('budget-phase=');
  });

  it('declares the unaccounted build span with what it excludes, never as a bare gap', () => {
    const diagnostic = renderRebirthPackageV6(model(), { diagnostic: true });
    const line = diagnostic.split('\n').find((row) => row.includes('unaccounted='));
    expect(line, 'a measured request→capture span must report its residual').toBeDefined();
    // God Rule 7: the residual is reported as measured, and its scope is named
    // so nobody reads it as end-to-end delivery latency.
    expect(line).toMatch(/unaccounted=\d+ms/u);
    expect(line).toContain('capture only, not delivery/readiness');
    // Names the uninstrumented stages that can live in the residual, so the
    // number points somewhere instead of reading as an unexplained gap.
    expect(line).toContain('uninstrumented: worker queue wait, request/response transport, capture persistence');
    // ...and attributes no share to any of them without a measurement.
    expect(line).not.toMatch(/worker queue wait=\d/u);
  });
});
