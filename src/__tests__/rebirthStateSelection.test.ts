import { describe, expect, it } from 'vitest';
import { absorbedLineageLabel, extractDeclaredOpenItems } from '../continuityPresentation.ts';
import { buildRebirthPackageV6Model, renderRebirthPackageV6Sections, type RebirthPackageV6NowCard } from '../rebirthPackageV6.ts';

describe('continuation state selection', () => {
  it.each(['Open items', 'Residuals (owned, not claimed resolved)', 'Follow-ups'])('keeps the complete %s list ahead of a closing signpost', (heading: string) => {
    const [item] = extractDeclaredOpenItems([{ role: 'assistant', provenanceId: 'message:report', sourceAt: '2026-09-14T00:00:00Z',
      text: `## ${heading}\n\n1. Repair fixtures.\n\n2. Verify activation.\n\nSignpost: read status.` }]);
    expect(item?.text).toBe('Repair fixtures.; Verify activation.');
    expect(item?.provenanceId).toBe('message:report');
  });

  it('uses stable ancestry identity to correct a blanket donor name without losing merge participation', () => {
    const now = { absorbedLineage: [{ instanceId: 'ancestor', instanceName: 'wrong donor name' }],
      lineageChain: [{ instanceId: 'ancestor', instanceName: 'original name' }] } as unknown as RebirthPackageV6NowCard;
    expect(absorbedLineageLabel(now)).toBe('original name (ancestor) [also fork ancestor]');
  });

  it('admits newest execution facts first', () => {
    const model = buildRebirthPackageV6Model({
      boundaryAndActiveTask: { lifecycle: 'continuation', lifecycleMeaning: 'same identity', captureId: 'capture',
        capturedAt: '2026-09-14T01:00:00Z', sourceFrontier: null, instanceId: 'self', instanceName: 'self',
        predecessorInstanceId: null, predecessorName: null, workspace: 'test', cwd: '/test', runtimeChange: null,
        activeRequest: null, lastMaterialAssistant: null },
      executionState: { facts: Array.from({ length: 19 }, (_, index) => ({ kind: 'rail' as const, status: 'exact' as const,
        provenanceId: `rail:${index}`, sourceAt: `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
        text: `TASK ${index} ${'details '.repeat(15)}` })), unknownReasons: [] },
    });
    const section = renderRebirthPackageV6Sections(model, { sectionMaxChars: { executionState: 500 } }).find(s => s.id === 'executionState')!;
    expect(section.text).toContain('TASK 18');
    expect(section.text).not.toContain('TASK 0 ');
    expect(section.text).toContain('operation="list_mine"');
    expect(section.text).toContain('dir=desc');
    const withUnknown = { ...model, executionState: { ...model.executionState, facts: [...model.executionState.facts,
      { kind: 'rail' as const, status: 'exact' as const, provenanceId: 'rail:bad', sourceAt: 'invalid-clock', text: 'UNDATED' }] } };
    const full = renderRebirthPackageV6Sections(withUnknown, { sectionMaxChars: { executionState: 6000 } }).find(s => s.id === 'executionState')!.text;
    expect(full).toContain('UNDATED [unknown source time; quarantined]');
    expect(full).not.toContain('invalid-clock');
  });
});
