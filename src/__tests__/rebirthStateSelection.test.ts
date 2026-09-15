import { describe, expect, it } from 'vitest';
import { absorbedLineageLabel, extractDeclaredOpenItems } from '../continuityPresentation.ts';
import { buildRebirthPackageV6Model, renderRebirthPackageV6Sections, type RebirthPackageV6NowCard } from '../rebirthPackageV6.ts';

describe('continuation state selection', () => {
  const declaration = (id: string, hour: number, text: string) => ({ role: 'assistant' as const,
    provenanceId: `message:${id}`, sourceAt: `2026-09-14T${String(hour).padStart(2, '0')}:00:00.123Z`, text });

  it('retains independent explicit residuals across newer reports and unrelated ship ACKs', () => {
    const older = declaration('older', 1, 'Residuals:\n- Mixed-owner labeling remains unverified.');
    const newer = declaration('newer', 3, 'Open items:\n- Interruption-role investigation.');
    const items = extractDeclaredOpenItems([newer, older], { shipAcksAt: ['2026-09-14T02:00:00Z'] });
    expect(items.map(item => item.provenanceId)).toEqual(['message:newer', 'message:older']);
    expect(items[1]?.sourceAt).toBe(older.sourceAt);
  });

  it('retires only an exact older source declaration and preserves unrelated residuals', () => {
    const rows = [declaration('one', 1, 'Follow-ups: First obligation.'),
      declaration('two', 2, 'Open items: Second obligation.'),
      declaration('close', 3, 'Resolved open items: message:one')];
    expect(extractDeclaredOpenItems(rows).map(item => item.provenanceId)).toEqual(['message:two']);
    expect(extractDeclaredOpenItems([rows[0]!, { ...rows[2]!, sourceAt: rows[0]!.sourceAt }])).toHaveLength(1);
    expect(extractDeclaredOpenItems([rows[0]!, { ...rows[2]!, sourceAt: null }])).toHaveLength(1);
    expect(extractDeclaredOpenItems([rows[0]!, { ...rows[2]!, role: 'user' }])).toHaveLength(1);
  });

  it('does not treat a scoped none or generic completion as closure of older explicit work', () => {
    const old = declaration('old', 1, 'Open items: Still investigate source ordering.');
    expect(extractDeclaredOpenItems([old, declaration('new', 2, 'Open items: none.')])).toHaveLength(1);
    expect(extractDeclaredOpenItems([old, declaration('new', 2, 'All done.')])).toHaveLength(1);
  });

  it('shares the display budget with older obligations and discloses overflow', () => {
    const old = declaration('old', 1, 'Residuals: An independent old obligation.');
    const long = declaration('new', 2, `Signpost: ${'long pending operation '.repeat(100)}`);
    expect(extractDeclaredOpenItems([old, long]).map(item => item.provenanceId))
      .toEqual(['message:new', 'message:old']);
    const many = Array.from({ length: 8 }, (_, i) => declaration(String(i), i, `Open items: task ${i}`));
    const items = extractDeclaredOpenItems(many);
    expect(items).toHaveLength(6);
    expect(items.at(-1)?.omittedDeclarations).toBe(2);
  });

  it('keeps separate explicit sections within the same report', () => {
    const [item] = extractDeclaredOpenItems([declaration('report', 1,
      'Residuals: First obligation.\n\nFollow-ups: Second obligation.\n\nSignpost: next action.')]);
    expect(item?.text).toBe('First obligation.; Second obligation.');
  });

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
