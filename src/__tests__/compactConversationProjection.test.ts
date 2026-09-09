import { describe, expect, it } from 'vitest';
import { buildRebirthPackageV6Model, renderRebirthPackageV6WithReport } from '../rebirthPackageV6.ts';

// Conversation demand is real demand: a reply that fits its section renders
// whole, and contention is resolved by evicting whole exchanges oldest-first
// (never by cutting a reply body while capacity sits unused). The only
// within-row truncation is the newest row when even it cannot fit alone.
const at = '2026-09-09T07:00:00.000Z';
const boundary = {
  lifecycle: 'continuation', lifecycleMeaning: 'same identity',
  captureId: 'compact-fixture', capturedAt: at, sourceFrontier: 'end',
  instanceId: 'self', instanceName: 'self', predecessorInstanceId: null,
  predecessorName: null, workspace: 'test', cwd: '/test', runtimeChange: null,
  activeRequest: null, lastMaterialAssistant: null,
} as const;

describe('compact conversation projection', () => {
  it('renders a fitting long reply whole — seam marker kept, no clipped middle, no [partial]', () => {
    const reply = 'ANSWER HEAD ' + 'x'.repeat(2000) + 'FULL MIDDLE' + 'y'.repeat(2000) + ' ANSWER TAIL';
    const model = buildRebirthPackageV6Model({
      boundaryAndActiveTask: boundary,
      recentConversation: [
        { provenanceId: 'question', sourceAt: at, role: 'user', text: 'KEEP QUESTION', exchangeId: 'question' },
        { provenanceId: 'reply', sourceAt: at, role: 'assistant', text: reply, exchangeId: 'question', segmentOffsets: [100] },
      ],
    });
    const { text } = renderRebirthPackageV6WithReport(model);
    expect(text).toContain('KEEP QUESTION');
    expect(text).toContain('ANSWER HEAD');
    expect(text).toContain('FULL MIDDLE');
    expect(text).toContain('ANSWER TAIL');
    expect(text).toContain('⟨segment-1⟩');
    expect(text).toContain('⟨reply @09-09 07:00:00Z⟩');
    expect(text).not.toContain('[partial]');
    expect(text).toMatch(/Timeline census: 2 dated, 0 quarantined; 0 of 2 captured units not fully rendered/u);
    // Presentation never mutates the admitted source bytes.
    expect(model.recentConversation.find((row) => row.provenanceId === 'reply')?.text).toBe(reply);
  });

  it('evicts whole older exchanges under a tight cap instead of clipping the newest reply', () => {
    const replyOf = (label: string) => `ANSWER ${label} HEAD ` + 'x'.repeat(2500) + `${label} MIDDLE` + 'y'.repeat(200) + ` ANSWER ${label} TAIL`;
    const model = buildRebirthPackageV6Model({
      boundaryAndActiveTask: boundary,
      recentConversation: [
        { provenanceId: 'q0', sourceAt: '2026-09-09T06:00:00.000Z', role: 'user', text: 'QUESTION ZERO', exchangeId: 'q0' },
        { provenanceId: 'a0', sourceAt: '2026-09-09T06:00:05.000Z', role: 'assistant', text: replyOf('ZERO'), exchangeId: 'q0' },
        { provenanceId: 'q1', sourceAt: '2026-09-09T06:30:00.000Z', role: 'user', text: 'QUESTION ONE', exchangeId: 'q1' },
        { provenanceId: 'a1', sourceAt: '2026-09-09T06:30:05.000Z', role: 'assistant', text: replyOf('ONE'), exchangeId: 'q1' },
      ],
    });
    // Room for one whole exchange plus the census/omission receipts, not two.
    const { text } = renderRebirthPackageV6WithReport(model, { sectionMaxChars: { recentConversation: 4_000 } });
    expect(text).toContain('QUESTION ONE');
    expect(text).toContain('ANSWER ONE HEAD');
    expect(text).toContain('ONE MIDDLE');
    expect(text).toContain('ANSWER ONE TAIL');
    expect(text).not.toContain('QUESTION ZERO');
    expect(text).not.toContain('ANSWER ZERO');
    expect(text).not.toContain('[partial]');
    expect(text).toMatch(/Timeline census: 2 dated, 0 quarantined; 2 of 4 captured units not fully rendered/u);
    expect(text).toContain('Omitted units:');
    expect(model.recentConversation.find((row) => row.provenanceId === 'a1')?.text).toBe(replyOf('ONE'));
  });
});
