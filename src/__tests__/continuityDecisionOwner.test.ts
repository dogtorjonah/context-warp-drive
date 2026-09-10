import { expect, it } from 'vitest';
import { buildRebirthPackageV6Model, renderRebirthPackageV6WithReport } from '../rebirthPackageV6.ts';
import { compactBoundary } from '../continuityPresentation.ts';

it('uses source authorship instead of admission priority or latest lineage life', () => {
  const at = '2026-09-09T04:00:00.000Z';
  const model = buildRebirthPackageV6Model({
    boundaryAndActiveTask: {
      lifecycle: 'continuation', lifecycleMeaning: 'same identity',
      captureId: 'owner-fixture', capturedAt: at, sourceFrontier: 'end',
      instanceId: 'self', instanceName: 'self', predecessorInstanceId: null,
      predecessorName: null, workspace: 'test', cwd: '/test', runtimeChange: null,
      activeRequest: null, lastMaterialAssistant: null,
    },
    cognitiveArtifacts: [
      { provenanceId: 'self-row', sourceInstanceId: 'self', sourceAt: '2026-09-08T00:00:00Z', kind: 'decision', authority: 'evidence', supersededBy: null, retention: 'lineage-floor', text: 'OWNER DECISION' },
      { provenanceId: 'foreign-row', sourceInstanceId: 'ancestor', sourceAt: at, kind: 'decision', authority: 'evidence', supersededBy: null, text: 'FOREIGN DECISION' },
      { provenanceId: 'unknown-row', sourceAt: at, kind: 'decision', authority: 'evidence', supersededBy: null, text: 'UNKNOWN AUTHOR' },
    ],
    lifeLedger: { units: [{ id: 'later-life', sourceAt: at, sourceEndAt: at, kind: 'life', verbatim: 'life', digest: 'life', claim: 'life', eraKey: '2026-09-09', recover: 'source' }], rangeRecover: 'source' },
  });
  const head = compactBoundary(model, null, []);
  expect(head).toContain('Latest decision: OWNER DECISION');
  expect(head).not.toContain('FOREIGN DECISION');
  expect(head).not.toContain('UNKNOWN AUTHOR');
  expect(model.cognitiveArtifacts).toHaveLength(3);
  const diagnostic = renderRebirthPackageV6WithReport(model, { diagnostic: true }).text;
  expect(diagnostic).toContain('latest-decision=OWNER DECISION');
  expect(diagnostic).not.toContain('latest-decision=FOREIGN DECISION');
  expect(diagnostic).not.toContain('latest-decision=UNKNOWN AUTHOR');
});
