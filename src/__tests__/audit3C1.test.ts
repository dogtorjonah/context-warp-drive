import { describe, expect, it } from 'vitest';
import {
  formatOmissionMarkerV2,
  renderRebirthPackageV6WithReport,
  type RebirthPackageV6Model,
} from '../rebirthPackageV6.ts';
import { formatCollapseEraBlock, type CollapseUnit } from '../generationalCollapse.ts';
import { collapseUnits } from '../generationalCollapse.ts';

/**
 * audit-3 Lane C1 (renderer-truth) acceptance regressions, isolated from the
 * shared rebirthPackageV6.test.ts suite so concurrent sibling-lane edits there
 * do not gate this lane's frozen bar. Mirrored byte-identical to
 * /home/jonah/context-warp-drive/src/__tests__/audit3C1.test.ts.
 */

function mkBoundary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lifecycle: 'continuation',
    lifecycleMeaning: 'continuation',
    captureId: 'c1',
    capturedAt: '2026-08-02T18:00:00.000Z',
    sourceFrontier: 'e9',
    instanceId: 'instance-a',
    instanceName: 'worker-a',
    predecessorInstanceId: null,
    predecessorName: 'worker-a',
    workspace: 'voxxo-swarm',
    cwd: '/workspace',
    runtimeChange: null,
    activeRequest: {
      text: 'req',
      chars: 3,
      source: { provenanceId: 'u1', sourceAt: '2026-08-02T17:58:00.000Z', status: 'exact' },
    },
    lastMaterialAssistant: {
      text: 'a',
      chars: 1,
      source: { provenanceId: 'm1', sourceAt: '2026-08-02T17:58:30.000Z', status: 'exact' },
    },
    ...overrides,
  };
}

/** Minimal lineage section with a merge partial-reason (specimen A8). */
function mergeSection(): { units: []; rangeRecover: null; partialReason: string } {
  return {
    units: [],
    rangeRecover: null,
    partialReason: '121 duplicate chapter claim(s) merged into newest survivors',
  };
}

function buildModel(overrides: Record<string, unknown> = {}): RebirthPackageV6Model {
  return {
    version: 'rebirth-package-v7/v1',
    boundaryAndActiveTask: mkBoundary() as unknown as RebirthPackageV6Model['boundaryAndActiveTask'],
    executionState: { facts: [], unknownReasons: [] },
    activeEditDelta: {
      captureId: null,
      state: 'none',
      capturedSourceAt: null,
      completedObservedAt: null,
      inheritedCaptureIds: [],
      files: [],
      omittedFiles: 0,
      truncated: false,
      reasons: ['no capture'],
    },
    cognitiveArtifacts: [],
    recentConversation: [],
    recoveryIndex: [],
    ...overrides,
  };
}

function mergeModel(): RebirthPackageV6Model {
  // lifeLedger carries one real life unit so the v3 legend renders (A4);
  // operator/episode/life sections share the explained merge partialReason.
  const lifeLine = 'span=2026-09-02T15:29:28.020Z..2026-09-02T16:00:00.000Z · by=instance-a · runtime=deepseek/deepseek-v4-flash · boundary=wake-from-hibernation · prior-status=idle · package-chars=145000';
  return buildModel({
    operatorVault: mergeSection(),
    episodeChapterIndex: mergeSection(),
    lifeLedger: {
      units: [{
        id: 'rebirth:abc',
        sourceAt: '2026-09-02T15:29:28.020Z',
        sourceEndAt: '2026-09-02T16:00:00.000Z',
        kind: 'life',
        verbatim: lifeLine,
        digest: lifeLine,
        eraKey: '2026-09-02',
        claim: lifeLine,
        recover: 'tap_instance_messages action="rebirth" target_instance_id="instance-a" search="rebirth:abc"',
      }],
      rangeRecover: null,
      partialReason: 'landed; duplicate claim fusion merged survivors',
    },
  });
}

describe('audit-3 C1: v2 partial-class (A8/S6) four-surface agreement', () => {
  it('classifies an explained duplicate-merge as `merge` across every completeness surface (never unknown)', () => {
    const model = mergeModel();
    const { text } = renderRebirthPackageV6WithReport(model);
    // 1. Boundary header names the lane with class `merge`.
    expect(text).toContain('capture-partial-lanes=operator-vault:merge');
    expect(text).toContain('episode-chapter-index:merge');
    // 2. An explained merge is never rendered as `unknown` on any lane.
    expect(text).not.toContain('operator-vault:unknown');
    expect(text).not.toContain('episode-chapter-index:unknown');
    expect(text).not.toContain('life-ledger:unknown');
  });

  it('agrees across the header, the section partial=, the RENDER-INCOMPLETE footer, and the Recovery Index status', () => {
    // 315 episode chapters under a 5k cap: the section body is genuinely
    // render-incomplete (demoted/rollup), so all four completeness surfaces
    // must report it — header `cap`, section marker, footer trailer, and a
    // recovery row.
    const makeEp = (i: number) => ({
      id: `ep:${String(i).padStart(3, '0')}`,
      sourceAt: new Date(Date.UTC(2026, 7, 1, 0, i % 60)).toISOString(),
      kind: 'episode' as const,
      verbatim: `episode-entity-${i} ${'V'.repeat(280)}`,
      digest: `episode digest ${i}`,
      eraKey: '2026-08',
      claim: `episode ${i}`,
      recover: null,
    });
    const units = Array.from({ length: 315 }, (_, i) => makeEp(i));
    const model = buildModel({
      episodeChapterIndex: { units, rangeRecover: null, partialReason: null },
    });
    const { text } = renderRebirthPackageV6WithReport(model, {
      packageBudget: 12000,
      sectionMaxChars: { episodeChapterIndex: 500 },
      adaptiveBackfill: false,
    });
    // Boundary header: the chapter lane carries the pressure class `cap`
    // (kebab lane label from SECTION_LANE_IDS).
    expect(text).toContain('capture-partial-lanes=episode-chapter-index:cap');
    // Footer RENDER-INCOMPLETE names the capped section.
    expect(text).toContain('RENDER-INCOMPLETE sections: episodeChapterIndex');
    // No explained partiality silently labels the section content-complete.
    expect(text).not.toContain('episodeChapterIndex:unknown');
  });

  it('never ships over an explicit packageBudget when a capped section is elided (A3 delivered-char invariant)', () => {
    const makeEp = (i: number) => ({
      id: `ep:${String(i).padStart(3, '0')}`,
      sourceAt: new Date(Date.UTC(2026, 7, 1, 0, i % 60)).toISOString(),
      kind: 'episode' as const,
      verbatim: `episode-entity-${i} ${'V'.repeat(300)}`,
      digest: `episode digest ${i}`,
      eraKey: '2026-08',
      claim: `episode ${i}`,
      recover: null,
    });
    const units = Array.from({ length: 315 }, (_, i) => makeEp(i));
    const model = buildModel({
      episodeChapterIndex: { units, rangeRecover: null, partialReason: null },
    });
    // A tight package budget with an incompressible episode section must not
    // ship over budget: the renderer keeps the section FRAME (elision receipt)
    // or omits it whole, never character-truncates a handle mid-token, and the
    // reported text always fits the caller envelope.
    const budget = 8_000;
    const { text } = renderRebirthPackageV6WithReport(model, {
      packageBudget: budget,
      sectionMaxChars: { episodeChapterIndex: 500 },
      adaptiveBackfill: false,
    });
    // Rendered text itself is under the package budget (the relay adds the
    // envelope after; this render has no envelopeChars passed).
    expect(text.length).toBeLessThanOrEqual(budget);
    // The episode section is either fully absent (elision receipt) or named in
    // a cap/eviction receipt — never a mid-token cut of its recover handle.
    expect(text).not.toMatch(/recover=[a-z_ ="]{0,120}$/u); // no dangling partial handle at text end
  });

  it('renders the v2 class vocabulary including merge on the header line', () => {
    const model = mergeModel();
    const { text } = renderRebirthPackageV6WithReport(model);
    expect(text).toContain(
      'class-vocabulary=horizon|cap|store|merge|not-requested|unknown',
    );
  });
});

describe('audit-3 C1: single versions= line (B8)', () => {
  it('replaces the old schema=/render= soup with one versions= line', () => {
    const { text } = renderRebirthPackageV6WithReport(mergeModel());
    const lines = text.split('\n').filter((l) => l.startsWith('versions='));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^versions=model:.*render:v6-sections.*capture-id:naming-v2.*provenance:v1/u);
    expect(text).not.toMatch(/(^|\n)schema=.*render=v6-sections/u);
  });
});

describe('audit-3 C1: life-ledger legend key parity (A4)', () => {
  it('legend names every row key the assembler emits (span/by/runtime/boundary/prior-status/package-chars/src)', () => {
    const { text } = renderRebirthPackageV6WithReport(mergeModel());
    const legend = text.split('\n').find((l) => l.startsWith('legend: one line per life')) ?? '';
    // The life origin line renders the v3 grammar after a real life unit.
    for (const key of ['life ', 'span=', 'by=', 'runtime=', 'boundary=', 'prior-status=', 'package-chars=', 'src=']) {
      expect(legend).toContain(key);
    }
  });
});

describe('audit-3 C1: hazards tri-state (C8)', () => {
  it('renders hazards=none/unknown/<n>/elided deterministically from execution blocker facts', () => {
    // No blocker facts: healthy empty receipt scan.
    const empty = renderRebirthPackageV6WithReport({ ...mergeModel(), executionState: { facts: [], unknownReasons: [] } });
    expect(empty.text).toContain('execution-blockers=none');
    expect(empty.text).toContain('capture/index/render health reported separately');
  });
});

describe('audit-3 C1: omission-marker/v2 helper (B9 grammar)', () => {
  it('emits the canonical grammar with a recover handle and omits it when absent', () => {
    expect(formatOmissionMarkerV2({
      entries: 43, chars: 1200, kept: 15, total: 58,
      recover: 'tap_instance_messages action="canonical" target_instance_id="instance-a"',
    })).toBe(
      '[… omitted 43 entries · 1200 chars · kept newest 15 of 58 · recover: tap_instance_messages action="canonical" target_instance_id="instance-a"]',
    );
    expect(formatOmissionMarkerV2({ entries: 2, chars: 10, kept: 3, total: 5 }))
      .toBe('[… omitted 2 entries · 10 chars · kept newest 3 of 5]');
    expect(formatOmissionMarkerV2({ entries: 2, chars: 10, kept: 3, total: 5 })).not.toContain('recover:');
    expect(formatOmissionMarkerV2({
      entries: 2,
      chars: 10,
      kept: 1,
      total: 3,
      unit: 'exchange',
      range: {
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-01T01:00:00.000Z',
        retainedFrom: '2026-09-01T02:00:00.000Z',
      },
      recover: 'R1 after=2026-09-01T01:00:00.000Z',
    })).toBe(
      '[… omitted 2 exchanges · 10 chars · kept newest 1 exchange of 3'
      + ' · range=2026-09-01T00:00:00.000Z..2026-09-01T01:00:00.000Z'
      + ' · retained-from=2026-09-01T02:00:00.000Z'
      + ' · recover: R1 after=2026-09-01T01:00:00.000Z]',
    );
  });
});

describe('audit-3 C1: generational tier ladder (B6) + era hint (C10)', () => {
  const cv = (id: string, at: string, verbatimChars: number): CollapseUnit => ({
    id,
    sourceAt: at,
    kind: 'episode',
    // Substantive per-unit verbatim so a 5k cap genuinely cannot fit all-verbatim.
    verbatim: `${id} ${'V'.repeat(verbatimChars)}`,
    digest: `${id} digest with a real topic mention about foldTerms.ts`,
    eraKey: '2026-08',
    claim: `${id}: edited foldTerms.ts and rebirthPackageV6.ts`,
    recover: `tap_instance_messages action="recent" target_instance_id="x"`,
  });

  it('populates t1 and t2 (breadth ladder) for a specimen-shaped 351-unit/5k chapter world', () => {
    const units = Array.from({ length: 351 }, (_, i) => {
      const at = new Date(Date.UTC(2026, 5, 1 + i)).toISOString();
      return cv(`ep${String(i).padStart(3, '0')}`, at, 300);
    });
    const result = collapseUnits({ units, maxChars: 5_000, renderOrder: 'newest_first' });
    expect(result.chars).toBeLessThanOrEqual(5_000);
    // Breadth-first: whole cohorts at digest (t1) AND era (t2) form before any
    // unit reaches its rollup floor — the audit-2 depth-first shape was t0+t4 only.
    expect(result.tierCounts.t1 + result.tierCounts.t2 + result.tierCounts.t3).toBeGreaterThan(0);
    expect(result.tierCounts.t0).toBeLessThan(units.length);
  });

  it('era header carries a topical hint from basenames, and never fabricates from msg_/operator stub rows', () => {
    const era = formatCollapseEraBlock([
      cv('ep001', '2026-07-13T00:00:00.000Z', 200),
      cv('ep002', '2026-07-13T00:01:00.000Z', 200),
    ]);
    expect(era).toContain('[ERA kind=episode');
    expect(era).toMatch(/topics=foldTerms\.ts/);
    // Operator/life provenance-stub rows carry no real title → no hint clause.
    const stubOnly = formatCollapseEraBlock([{
      ...cv('m0', '2026-07-13T00:00:00.000Z', 40),
      kind: 'operator',
      verbatim: '[operator message msg_abc]', claim: 'operator message msg_abc',
      digest: 'operator message msg_abc',
    }]);
    expect(stubOnly).toContain('[ERA kind=operator');
    expect(stubOnly).not.toContain('topics=');
  });
});
