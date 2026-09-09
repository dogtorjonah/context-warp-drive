import { describe, expect, it } from 'vitest';
import { buildRebirthPackageV6Model, renderRebirthPackageV6WithReport } from '../rebirthPackageV6.ts';

describe('compact conversation projection', () => {
  it('preserves the admitted assistant excerpt and its source without expanding the omitted middle', () => {
    const at = '2026-09-09T07:00:00.000Z';
    const reply = 'ANSWER HEAD ' + 'x'.repeat(2000) + 'OMITTED MIDDLE' + 'y'.repeat(2000) + ' ANSWER TAIL';
    const model = buildRebirthPackageV6Model({
      boundaryAndActiveTask: {
        lifecycle: 'continuation', lifecycleMeaning: 'same identity',
        captureId: 'compact-fixture', capturedAt: at, sourceFrontier: 'end',
        instanceId: 'self', instanceName: 'self', predecessorInstanceId: null,
        predecessorName: null, workspace: 'test', cwd: '/test', runtimeChange: null,
        activeRequest: null, lastMaterialAssistant: null,
      },
      recentConversation: [
        { provenanceId: 'question', sourceAt: at, role: 'user', text: 'KEEP QUESTION', exchangeId: 'question' },
        { provenanceId: 'reply', sourceAt: at, role: 'assistant', text: reply, exchangeId: 'question', segmentOffsets: [100] },
      ],
    });
    const { text } = renderRebirthPackageV6WithReport(model);
    expect(text).toContain('KEEP QUESTION');
    expect(text).toContain('ANSWER HEAD');
    expect(text).toContain('ANSWER TAIL');
    expect(text).toContain('⟨segment-1⟩');
    expect(text).toContain('reply');
    expect(text).toContain(at);
    expect(text).not.toContain('OMITTED MIDDLE');
    expect(text).toContain('[partial]');
    expect(model.recentConversation.find(row => row.provenanceId === 'reply')?.text).toBe(reply);
  });
});
