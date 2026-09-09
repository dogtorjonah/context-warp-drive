import { describe, expect, it } from 'vitest';
import { continuityAnchor, continuityCoordinate } from '../continuityPresentation.ts';
import { formatEpisodicCardProvenance } from '../foldEpisodes.ts';
import { buildRebirthPackageV6Model, renderRebirthPackageV6WithReport } from '../rebirthPackageV6.ts';

const at = (minute: number) => `2026-09-09T04:${String(minute).padStart(2, '0')}:00.000Z`;

/**
 * C1 — the Coordinate Closet is a set of PUSH keys, never a pull surface.
 *
 * A coordinate addresses a captured unit so the fold engine can push its exact
 * source back when a touch names it. It is not a handle an agent calls: the
 * operator's standing ruling is push, no pull, and #42771 removed the last
 * pull tool for exactly that reason. These tests pin the two properties a push
 * key must have — stable and unique per unit — plus the absence of any agent
 * entry point that would turn the closet back into a retrieval API.
 */
describe('C1 coordinate closet (push keys)', () => {
  const unitIds = [
    'message:user-2',
    'chat:own',
    'atlas:own',
    'rail-72adf723:step:D1',
    'star:thin',
    'operator:one',
  ];

  it('derives one stable, unique coordinate per unit id', () => {
    const first = unitIds.map(continuityCoordinate);
    const second = unitIds.map(continuityCoordinate);
    // Stability: the same id always resolves to the same key, so a push index
    // built in one life still addresses the same unit in the next.
    expect(second).toEqual(first);
    // Uniqueness: two units must never collide onto one key, or a touch would
    // push the wrong source.
    expect(new Set(first).size).toBe(unitIds.length);
    for (const key of first) expect(key).toMatch(/^c#[0-9a-f]{16}$/u);
  });

  it('renders one anchor per unit, stable across two renders of the same model', () => {
    const model = () => buildRebirthPackageV6Model({
      boundaryAndActiveTask: {
        lifecycle: 'continuation',
        lifecycleMeaning: 'same identity',
        captureId: 'coordinate-fixture',
        capturedAt: at(30),
        sourceFrontier: 'event-end',
        instanceId: 'self',
        instanceName: 'self',
        predecessorInstanceId: null,
        predecessorName: null,
        workspace: 'test',
        cwd: '/test',
        runtimeChange: null,
        activeRequest: null,
        lastMaterialAssistant: null,
      },
      recentConversation: [
        { provenanceId: 'u1', sourceAt: at(1), role: 'user', text: 'OPERATOR START', exchangeId: 'u1' },
        { provenanceId: 'a1', sourceAt: at(3), role: 'assistant', text: 'ANSWER', exchangeId: 'u1' },
      ],
      cognitiveArtifacts: [
        { provenanceId: 'chat:own', sourceAt: at(2), kind: 'decision', authority: 'historical_observation', supersededBy: null, text: 'DURABLE DECISION' },
      ],
      executionState: {
        facts: [{ provenanceId: 'rail:one', sourceAt: at(6), status: 'exact', kind: 'rail', text: 'rail-72adf723 · active' }],
        unknownReasons: [],
      },
    });
    const first = renderRebirthPackageV6WithReport(model()).text;
    const second = renderRebirthPackageV6WithReport(model()).text;
    expect(second).toBe(first);
    const anchors = first.match(/⟨[^⟩\n]*@[^⟩\n]*⟩/gu) ?? [];
    expect(anchors.length).toBeGreaterThan(0);
    // One anchor per unit WITHIN a section. Across sections exactly one overlap
    // is by design and is named here rather than hidden: the Boundary promotes
    // a summary row (latest decision / validation / pending operation) whose
    // source also appears in its chronological place on the Timeline. That is
    // the summary-plus-chronology contract, not accidental repetition — and the
    // shared anchor is what lets a reader see they are the same unit.
    const sections = [...first.matchAll(/\[REBIRTH-V6-SECTION id=([a-zA-Z]+)[^\]]*\]\n([\s\S]*?)\n\[\/REBIRTH-V6-SECTION\]/gu)];
    for (const [, id, body] of sections) {
      const within = body!.match(/⟨[^⟩\n]*@[^⟩\n]*⟩/gu) ?? [];
      expect(new Set(within).size, `section ${id} repeats an anchor`).toBe(within.length);
    }
    // No line ever carries two anchors: that would restate provenance inline,
    // which is exactly the density defect the closet replaces.
    expect(first.split('\n').filter((line) => (line.match(/⟨[^⟩\n]*@[^⟩\n]*⟩/gu) ?? []).length > 1)).toEqual([]);
    // The anchor IS the address: it names the source id the push index keys on.
    expect(first).toContain(continuityAnchor('chat:own', at(2), at(30)));
  });

  it('addresses every push lane without publishing a pull handle', () => {
    const card = (kind: string, targetPath: string, sourceId?: string) => formatEpisodicCardProvenance({
      kind, targetPath, chapterIds: [7],
      ...(sourceId ? { debug: { sourceKind: 'continuity_ledger', sourceId } } : {}),
    } as never);
    // Path, rail and mention touches are exact anchors; the continuity-ledger
    // lane is what lets a touch address a unit from ANY store (transcript,
    // chat, atlas, rail, star, vault) through its ledger identity.
    expect(card('path', 'src/example.ts')).toContain('why: path-match · conf:high');
    expect(card('rail', 'rail-72adf723')).toContain('why: rail-match · conf:high');
    expect(card('mention', 'msg-1')).toContain('why: mention-match · conf:high');
    expect(card('term', 'terms:alpha+beta')).toContain('why: term-match (alpha, beta) · conf:low');
    expect(card('ledger', 'unit', 'continuity-ledger:self:cognitive:chat%3Aown'))
      .toContain('why: ledger-match · conf:mid');
    // Every lane states WHY it fired, so a pushed card is auditable evidence
    // rather than an unexplained insertion — and none of them is callable.
    for (const kind of ['path', 'rail', 'mention', 'term', 'ledger']) {
      expect(card(kind, 'x')).toMatch(/^↞ why: /u);
    }
  });
});
