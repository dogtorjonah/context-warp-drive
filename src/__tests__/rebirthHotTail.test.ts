import { describe, expect, it } from 'vitest';
import { selectRebirthHotTail, type RebirthHotTailRow } from '../rebirthHotTail.ts';
import { buildRebirthPackageV6Model, renderRebirthPackageV6WithReport, buildContinuityLedgerCaptureFromV6Render } from '../rebirthPackageV6.ts';

const at = (n: number) => new Date(Date.UTC(2026, 8, 9, 12, n)).toISOString();
const row = (n: number, text = `payload ${n}`): RebirthHotTailRow => ({
  id: `source-${n}`, sourceAt: at(n), sourceInstanceId: 'self', kind: 'assistant', text, recover: `read-source-${n}`,
});
function model(rawHotTail: readonly RebirthHotTailRow[]) {
  return buildRebirthPackageV6Model({ rawHotTail,
    boundaryAndActiveTask: {
      lifecycle: 'continuation', lifecycleMeaning: 'same identity', captureId: 'tail-fixture',
      capturedAt: at(59), sourceFrontier: 'source-59', instanceId: 'self', instanceName: 'self',
      predecessorInstanceId: null, predecessorName: null, workspace: 'test', cwd: '/test',
      runtimeChange: null, activeRequest: null, lastMaterialAssistant: null,
    },
    recentConversation: [{ provenanceId: 'source-2', sourceAt: at(2), role: 'assistant', text: 'EXACT DIALOGUE BODY' }],
    cognitiveArtifacts: [{ provenanceId: 'message:source-2', sourceAt: at(2), kind: 'result',
      authority: 'historical_observation', supersededBy: null, text: 'EXACT DIALOGUE BODY' }],
  });
}

describe('raw rebirth hot tail', () => {
  it('fits the raw suffix inside the delivery target including its outer envelope', () => {
    const value = model([row(1, 'x'.repeat(30_000)), row(2, 'EXACT DIALOGUE BODY')]);
    const output = renderRebirthPackageV6WithReport(value, {
      packageBudget: 200_000, pushTargetChars: 15_000, envelopeChars: 1_000,
    });
    expect(output.text.length + 1_000).toBeLessThanOrEqual(15_000);
    expect(output.text).toContain('EXACT DIALOGUE BODY');
    const receipt = buildContinuityLedgerCaptureFromV6Render(value, output.collapse)!;
    expect(receipt.units.find((u) => u.unitId === 'raw-tail:source-1')?.placement).toBe('elided');
  });
  it('retains multiline tool output and inputs whole, newest-first under 50k', () => {
    const source = Array.from({ length: 20 }, (_, n) => ({ ...row(n, `begin-${n}\n  ${'x'.repeat(4_000)}\nend-${n}`), kind: 'tool_result' as const }));
    const selected = selectRebirthHotTail(source);
    expect(selected.text.length).toBeLessThanOrEqual(50_000);
    expect(selected.rows.length).toBeGreaterThan(10);
    expect(selected.rows.at(-1)?.id).toBe('source-19');
    for (const retained of selected.rows) expect(selected.text).toContain(retained.text);
    for (const omitted of selected.omitted) expect(selected.text).not.toContain(omitted.text);
  });
  it('does not backfill across an oversized row or tear its body', () => {
    const source = [row(1), row(2, 'x'.repeat(60_000)), row(3)];
    const selected = selectRebirthHotTail(source);
    expect(selected.rows.map((r) => r.id)).toEqual(['source-3']);
    expect(selected.omitted.map((r) => r.id)).toEqual(['source-1', 'source-2']);
    expect(selectRebirthHotTail(source.slice(0, 2)).rows).toHaveLength(0);
  });
  it('renders compressed history before raw present and dialogue-derived cognition once', () => {
    const value = model([row(1), row(2, 'EXACT DIALOGUE BODY')]);
    const output = renderRebirthPackageV6WithReport(value);
    expect(output.text.match(/EXACT DIALOGUE BODY/g)).toHaveLength(1);
    expect(output.text).toContain('Exact source appears in Raw hot tail');
    expect(output.text.indexOf('── Timeline')).toBeLessThan(output.text.indexOf('[RAW-HOT-TAIL]'));
    expect(output.text.endsWith('[/RAW-HOT-TAIL]')).toBe(true);
    expect(output.text.length).toBeLessThanOrEqual(200_000);
    const receipt = buildContinuityLedgerCaptureFromV6Render(value, output.collapse)!;
    expect(receipt.units.filter((u) => u.sectionId === 'rawHotTail')).toHaveLength(2);
    expect(receipt.units.find((u) => u.unitId === 'raw-tail:source-2')?.placement).toBe('rendered');
  });
  it('receipts every captured row that cannot fit and respects a caller budget', () => {
    const value = model([row(1, 'x'.repeat(60_000)), row(2, 'EXACT DIALOGUE BODY')]);
    const output = renderRebirthPackageV6WithReport(value, { packageBudget: 12_000 });
    expect(output.text.length).toBeLessThanOrEqual(12_000);
    const receipt = buildContinuityLedgerCaptureFromV6Render(value, output.collapse)!;
    expect(receipt.units.find((u) => u.unitId === 'raw-tail:source-1')).toMatchObject({ placement: 'elided', recover: 'read-source-1' });
  });
  it('applies declared credential redaction before exact-tail selection and ledger hashes', () => {
    const token = 'sk-' + 'a'.repeat(40);
    const value = model([row(1, token)]);
    const output = renderRebirthPackageV6WithReport(value);
    expect(output.text).not.toContain(token);
    expect(output.text).toContain('[REDACTED:sk-token]');
    expect(output.text).toContain('[REDACTION-LANE spans=1 kinds=sk-token×1]');
    const receipt = buildContinuityLedgerCaptureFromV6Render(value, output.collapse)!;
    expect(receipt.units.find((u) => u.sectionId === 'rawHotTail')?.verbatim).toBe('[REDACTED:sk-token]');
  });
});
