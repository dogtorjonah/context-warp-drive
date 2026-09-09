import { describe, expect, it } from 'vitest';
import { buildRebirthPackageV6Model, buildContinuityLedgerCaptureFromV6Render, renderRebirthPackageV6WithReport, resolveAdaptiveSectionCaps, DEFAULT_REBIRTH_PACKAGE_V6_SECTION_MAX_CHARS, RAIL_COMPLETE_SECTION_OVERRIDES } from '../rebirthPackageV6.ts';

const at = (minute: number) => `2026-09-09T04:${String(minute).padStart(2, '0')}:00.000Z`;

function specimen() {
  return buildRebirthPackageV6Model({
    boundaryAndActiveTask: {
      lifecycle: 'continuation', lifecycleMeaning: 'same identity',
      captureId: 'timeline-fixture', capturedAt: at(30), sourceFrontier: 'event-end',
      instanceId: 'self', instanceName: 'self', predecessorInstanceId: null,
      predecessorName: null, workspace: 'test', cwd: '/test', runtimeChange: null,
      activeRequest: null, lastMaterialAssistant: null,
    },
    recentConversation: [
      { provenanceId: 'u1', sourceAt: at(1), role: 'user', text: 'OPERATOR START', exchangeId: 'u1' },
      { provenanceId: 'a1', sourceAt: at(3), role: 'assistant', text: 'ANSWER START ' + 'x'.repeat(1800) + ' ANSWER SIGNPOST', exchangeId: 'u1', exchangeRecovery: 'must-not-render' },
      { provenanceId: 'u2', sourceAt: at(5), role: 'user', text: 'OPERATOR FOLLOWUP', exchangeId: 'u2' },
    ],
    cognitiveArtifacts: [
      { provenanceId: 'chat:own', sourceAt: at(2), kind: 'decision', authority: 'historical_observation', supersededBy: null, text: 'DURABLE DECISION' },
      { provenanceId: 'message:a1', sourceAt: at(3), kind: 'result', authority: 'historical_observation', supersededBy: null, text: 'DUPLICATE GLYPH BODY' },
      { provenanceId: 'atlas:own', sourceAt: at(4), kind: 'discovery', authority: 'evidence', supersededBy: null, text: 'COMMIT FINDING' },
      { provenanceId: 'unknown', sourceAt: null, kind: 'hazard', authority: 'historical_observation', supersededBy: null, text: 'UNDATED FINDING' },
    ],
  });
}

describe('unified rebirth timeline', () => {
  it('retains every hidden lineage source and hash across display budgets', () => {
    const unit = (id: string, kind: 'life' | 'operator' | 'episode') => ({
      id, kind, sourceAt: at(1), sourceEndAt: at(2), verbatim: `Exact source ${id}`,
      digest: id, claim: id, eraKey: '2026-09-09', recover: 'source-reader',
    });
    const value = buildRebirthPackageV6Model({ ...specimen(),
      lifeLedger: { units: [unit('life-one', 'life')] },
      operatorVault: { units: [unit('vault-one', 'operator')] },
      episodeChapterIndex: { units: [unit('episode-one', 'episode')] },
    });
    const hidden = renderRebirthPackageV6WithReport(value);
    const visible = renderRebirthPackageV6WithReport(value, { sectionMaxChars: {
      lifeLedger: 4000, operatorVault: 4000, episodeChapterIndex: 4000,
    } });
    const proofs = (result: typeof hidden) => buildContinuityLedgerCaptureFromV6Render(value, result.collapse)!.units
      .filter((row) => ['lifeLedger', 'operatorVault', 'episodeChapterIndex'].includes(row.sectionId))
      .map(({ unitId, sourceTime, verbatim, sha256 }) => ({ unitId, sourceTime, verbatim, sha256 }));
    expect(proofs(hidden)).toHaveLength(3);
    expect(proofs(hidden)).toEqual(proofs(visible));
    expect(hidden.text).not.toContain('Exact source life-one');
    expect(hidden.text).not.toContain('Exact source episode-one');
    expect(hidden.text).not.toContain('Exact source vault-one');
  });
  it('reserves 145k content and gives idle execution surplus to the timeline', () => {
    const defaults = DEFAULT_REBIRTH_PACKAGE_V6_SECTION_MAX_CHARS;
    expect(Object.entries(defaults).filter(([id]) => id !== 'brainMergeSynthesis').reduce((sum, [, cap]) => sum + cap, 0)).toBe(145_000);
    const base = specimen();
    const active = resolveAdaptiveSectionCaps(base);
    const idle = buildRebirthPackageV6Model({
      ...base,
      boundaryAndActiveTask: {
        ...base.boundaryAndActiveTask,
        nowCard: { forkPurpose: null, parentIdentity: null, parentStatus: null, currentRail: null, currentRailAvailability: { status: 'none', reason: 'no current rail', source: { provenanceId: 'rail-capture', sourceAt: at(30), status: 'exact' } } },
      },
    });
    const caps = resolveAdaptiveSectionCaps(idle);
    expect(caps.executionState + caps.activeEditDelta).toBe(1_000);
    expect(caps.recentConversation + caps.cognitiveArtifacts).toBe(129_000);
    expect(caps.cognitiveArtifacts - active.cognitiveArtifacts).toBe(14_000);
    expect(caps.boundaryAndActiveTask).toBe(5_000);
    expect(caps.recoveryIndex).toBe(10_000);
    expect(renderRebirthPackageV6WithReport(idle).text.length).toBeLessThanOrEqual(150_000);
    const complete = buildRebirthPackageV6Model({
      ...idle,
      boundaryAndActiveTask: { ...idle.boundaryAndActiveTask, nowCard: {
        ...idle.boundaryAndActiveTask.nowCard!,
        currentRail: { railId: 'completed', state: 'complete', activeStepId: null, activeStepStatus: null, source: { provenanceId: 'rail-end', sourceAt: at(30), status: 'exact' } },
      } },
    });
    expect(resolveAdaptiveSectionCaps(complete)).toEqual(caps);
    expect(resolveAdaptiveSectionCaps(complete, { packageBudget: 300_000 })).toEqual(caps);
  });

  it('renders the active request once across dialogue, cognition, and derived execution facts', () => {
    const base = specimen();
    const request = 'Carry the exact operator request through the complete package once.';
    const source = { provenanceId: 'request-now', sourceAt: at(20), status: 'exact' as const };
    const value = buildRebirthPackageV6Model({
      ...base,
      boundaryAndActiveTask: { ...base.boundaryAndActiveTask, activeRequest: { text: request, chars: request.length, source } },
      recentConversation: [...base.recentConversation, { ...source, role: 'user', text: request }],
      cognitiveArtifacts: [...base.cognitiveArtifacts, { ...source, kind: 'decision', authority: 'historical_observation', supersededBy: null, text: request }],
      executionState: { facts: [{ ...source, kind: 'next_action', text: request }], unknownReasons: [] },
    });
    const { text } = renderRebirthPackageV6WithReport(value);
    expect(text.split(request)).toHaveLength(2);
    const execution = text.slice(text.indexOf('── Execution State ──'), text.indexOf('── Active Edit Delta ──'));
    expect(execution).not.toContain(request);
    expect(execution).toContain('source=request-now');
    expect(value.executionState.facts[0].text).toBe(request);
  });

  it('interleaves dialogue and durable units once by source identity and quarantines unknown time', () => {
    const result = renderRebirthPackageV6WithReport(specimen());
    const timeline = result.text.slice(result.text.indexOf('── Timeline ──'));
    const labels = ['OPERATOR START', 'DURABLE DECISION', 'ANSWER START', 'COMMIT FINDING', 'OPERATOR FOLLOWUP'];
    const positions = labels.map((label) => timeline.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(result.text.match(/── Timeline ──/gu)).toHaveLength(1);
    expect(result.text).not.toContain('DUPLICATE GLYPH BODY');
    expect(result.text).not.toContain('must-not-render');
    expect(result.text).toContain('x'.repeat(1180));
    expect(result.text).toContain('ANSWER SIGNPOST');
    expect(result.text.indexOf('UNDATED FINDING')).toBeGreaterThan(result.text.indexOf('Unknown source time (quarantined'));
    expect(result.collapse.omissionSections.map((section) => section.sectionId)).toContain('cognitiveArtifacts');
    // D1/D2: the per-section `cognition: rendered=…` diagnostic block is gone;
    // the timeline states its omission accounting once and names the one
    // executable route back to the units it did not render whole.
    expect(result.text).toMatch(/Timeline census: \d+ dated, \d+ quarantined; \d+ of \d+ captured units not fully rendered/u);
    expect(result.text).toMatch(/Omitted units: continuity_ledger action="fetch"/u);
    expect(result.text).not.toContain('section_id=');
  });
});

/**
 * D1 density gate.
 *
 * Provenance never leaves the package (God Rule 8/11): every unit still names
 * its source id and source time. Two costs are measured separately, because
 * S10 *replaces* one with the other and a single blended ratio would score the
 * cure as the disease:
 *
 * 1. `metadataRatio` — what S10 removes: section frames, the labelled
 *    provenance clauses the audited specimen repeated on every row
 *    (`source=`/`source-time=`/`authority=`/`projection=`/`retention=`), and
 *    the accounting/census brackets. Bounded per section at 30%.
 * 2. `anchorRatio` — what S10 keeps: the single trailing ⟨source @time⟩ per
 *    unit. Bounded package-wide so the replacement cannot itself become the
 *    bloat, and paired with a strict one-anchor-per-line check.
 *
 * `recover=` is deliberately NOT metadata in the Recovery Index: the
 * executable route is that section's content.
 */
const METADATA_PATTERNS: readonly RegExp[] = [
  /\[\/?REBIRTH-V6-SECTION[^\]]*\]/gu,
  /(?:^|[·\s])(?:source|source-time|authority|projection|retention|kept-by|observed-at|capture|capture-id|capture-artifact|class-vocabulary|capture-partial-lanes|partial|verification|evidence-ids|declared|index-frontier|frontier)=[^\s·]+/gmu,
  /^\[(?:COLLAPSE|RENDER-INCOMPLETE|cognition:|…)[^\n]*\]$/gmu,
];

const ANCHOR_PATTERN = /⟨[^⟩\n]*@[^⟩\n]*⟩/gu;

function coveredRatio(section: string, patterns: readonly RegExp[]): number {
  if (section.length === 0) return 0;
  const covered = new Set<number>();
  for (const pattern of patterns) {
    for (const match of section.matchAll(pattern)) {
      const start = match.index ?? 0;
      for (let i = start; i < start + match[0].length; i += 1) covered.add(i);
    }
  }
  return covered.size / section.length;
}

const metadataRatio = (section: string): number => coveredRatio(section, METADATA_PATTERNS);

function sectionRatios(text: string, patterns: readonly RegExp[] = METADATA_PATTERNS): Record<string, number> {
  const sections = [...text.matchAll(/\[REBIRTH-V6-SECTION id=([a-zA-Z]+)[^\]]*\]\n([\s\S]*?)\n\[\/REBIRTH-V6-SECTION\]/gu)];
  expect(sections.length).toBeGreaterThan(0);
  return Object.fromEntries(sections.map((match) => [match[1]!, Number(coveredRatio(match[2]!, patterns).toFixed(3))]));
}

describe('D1 density', () => {
  const dense = () => {
    const unit = (id: string, kind: 'life' | 'operator' | 'episode') => ({
      id, kind, sourceAt: at(1), sourceEndAt: at(2), verbatim: `Exact source ${id}`,
      digest: id, claim: id, eraKey: '2026-09-09', recover: 'source-reader',
    });
    return buildRebirthPackageV6Model({
      ...specimen(),
      lifeLedger: { units: [unit('life-one', 'life')] },
      operatorVault: { units: [unit('vault-one', 'operator')] },
      episodeChapterIndex: { units: [unit('episode-one', 'episode')] },
      executionState: {
        facts: [
          { provenanceId: 'rail:one', sourceAt: at(6), status: 'exact', kind: 'rail', text: 'rail-72adf723 · active · step D1' },
          { provenanceId: 'validation:one', sourceAt: at(7), status: 'exact', kind: 'validation', text: 'vitest 123/123 passed' },
          { provenanceId: 'blocker:one', sourceAt: at(8), status: 'exact', kind: 'blocker', text: 'Standalone mirror not yet synced' },
          { provenanceId: 'claim:one', sourceAt: at(9), status: 'exact', kind: 'claim', text: 'packages/context-warp/src/continuityPresentation.ts:1-200' },
        ],
        unknownReasons: [],
      },
    });
  };

  it('keeps per-section metadata under 30% of what the agent reads', () => {
    const ratios = sectionRatios(renderRebirthPackageV6WithReport(dense()).text);
    const over = Object.entries(ratios).filter(([, ratio]) => ratio > 0.30);
    expect(over, `per-section metadata ratios: ${JSON.stringify(ratios)}`).toEqual([]);
  });

  it('spends at most one short anchor per unit and keeps anchors a minority of the package', () => {
    const { text } = renderRebirthPackageV6WithReport(dense());
    // One anchor per unit: a line carrying two anchors means provenance is
    // being restated, which is the density defect S10 exists to remove.
    const doubled = text.split('\n').filter((line) => (line.match(ANCHOR_PATTERN) ?? []).length > 1);
    expect(doubled, 'lines carrying more than one anchor').toEqual([]);
    const anchorChars = [...text.matchAll(ANCHOR_PATTERN)].reduce((sum, match) => sum + match[0].length, 0);
    expect(anchorChars / text.length, 'package-wide anchor share').toBeLessThanOrEqual(0.15);
  });

  it('measures a real reduction against the retired verbose rendering', () => {
    const value = dense();
    const compact = sectionRatios(renderRebirthPackageV6WithReport(value).text);
    const verbose = sectionRatios(renderRebirthPackageV6WithReport(value, { diagnostic: true }).text);
    const label = `compact ${JSON.stringify(compact)} vs verbose ${JSON.stringify(verbose)}`;
    // The metric must discriminate, or "under 30%" proves nothing about
    // density: no section may get denser, and at least one must get lighter.
    for (const [id, ratio] of Object.entries(compact)) {
      if (verbose[id] !== undefined) expect(ratio, `section ${id} · ${label}`).toBeLessThanOrEqual(verbose[id]!);
    }
    const improved = Object.entries(compact)
      .filter(([id, ratio]) => verbose[id] !== undefined && ratio < verbose[id]!);
    expect(improved.length, label).toBeGreaterThan(0);
  });
  // S29: the single-render invariant (S8/T2) promotes the newest operator message
  // out of the Timeline body. Dropping its ROW too made the chronology END at a
  // SUPERSEDED message: a blinded probe lane reading the 2026-09-09T09:21Z package
  // returned the operator's second-newest words as their latest instruction.
  // Precedent #27966 fixed this class in the thinking trail with one-line pointer
  // breadcrumbs; these assertions pin that behaviour for both promoted endpoints.
  const promoted = () => buildRebirthPackageV6Model({
    ...specimen(),
    boundaryAndActiveTask: {
      ...specimen().boundaryAndActiveTask,
      activeRequest: { text: 'NEWEST OPERATOR WORDS', chars: 21, source: {
        provenanceId: 'msg_newest_operator', sourceAt: at(9), status: 'exact', kind: 'message',
      } },
      lastMaterialAssistant: { text: 'NEWEST ASSISTANT WORDS', chars: 22, source: {
        provenanceId: 'msg_newest_assistant', sourceAt: at(11), status: 'exact', kind: 'message',
      } },
    },
  });

  it('anchors promoted endpoints in the timeline so the chronology never ends on a superseded row', () => {
    const text = renderRebirthPackageV6WithReport(promoted()).text;
    const timeline = text.split('\u2500\u2500 Timeline \u2500\u2500')[1] ?? '';

    // The promoted body still renders EXACTLY ONCE, in Boundary and Active Task.
    expect(text.match(/NEWEST OPERATOR WORDS/gu)).toHaveLength(1);
    expect(timeline).not.toContain('NEWEST OPERATOR WORDS');

    // ...but the chronology now names it, with its own identity and source time.
    expect(timeline).toContain('msg_newest_operator');
    expect(timeline).toContain('msg_newest_assistant');

    // The decisive assertion: a reader following the timeline tail cannot take the
    // superseded operator row (OPERATOR FOLLOWUP) for the newest operator message.
    expect(timeline.indexOf('msg_newest_operator'))
      .toBeGreaterThan(timeline.indexOf('OPERATOR FOLLOWUP'));
    expect(timeline.indexOf('msg_newest_assistant'))
      .toBeGreaterThan(timeline.indexOf('msg_newest_operator'));
  });

  it('yields the endpoint stubs rather than evicting a real exchange under a tight cap', () => {
    const model = promoted();
    const roomy = renderRebirthPackageV6WithReport(model).text;
    expect(roomy).toContain('msg_newest_operator');

    // A cap tight enough that the ~200 stub chars would cost dialogue: conversation
    // is the section the operator ranked highest, so the pointer is what gives way
    // and the compact relocation receipt carries the declaration instead.
    const tight = renderRebirthPackageV6WithReport(model, {
      sectionMaxChars: { recentConversation: 260 },
    }).text;
    // Scope to the dialogue body: the Boundary section legitimately anchors the
    // promoted endpoint by id, and that is the render this stub points at.
    const dialogue = tight.split('\u2500\u2500 Recent Conversation \u2500\u2500')[1]
      ?? tight.split('\u2500\u2500 Timeline \u2500\u2500')[1] ?? '';
    expect(dialogue).toContain('OPERATOR FOLLOWUP');
    expect(dialogue).not.toContain('msg_newest_operator');
    expect(dialogue).toContain('endpoint rows: rendered in Boundary');
  });
  // S28: the step alleged that budget freed by the ledger-relocated sections
  // evaporates instead of reaching the timeline. Measured against source that
  // premise is FALSE - D2 + S9 already folded that share into the timeline pool,
  // and the timeline's own leftovers already fund cognition. These assertions
  // pin the conservation the step feared was broken, so a future edit that
  // genuinely strands budget fails here instead of being rediscovered by audit.
  it('conserves the 145k content envelope in both phases and never strands freed budget', () => {
    const content = (table: Partial<Record<string, number>>) => Object.entries({
      ...DEFAULT_REBIRTH_PACKAGE_V6_SECTION_MAX_CHARS, ...table,
    }).filter(([id]) => id !== 'brainMergeSynthesis').reduce((sum, [, cap]) => sum + (cap ?? 0), 0);

    expect(content({})).toBe(145_000);                              // rail-active
    expect(content(RAIL_COMPLETE_SECTION_OVERRIDES)).toBe(145_000); // rail-complete / no-rail

    // The ledger-relocated sections hold NO budget: their share is already part
    // of the timeline pool, which is why relocating them cost the package nothing.
    for (const id of ['operatorVault', 'episodeChapterIndex', 'lifeLedger'] as const) {
      expect(DEFAULT_REBIRTH_PACKAGE_V6_SECTION_MAX_CHARS[id]).toBe(0);
      expect(RAIL_COMPLETE_SECTION_OVERRIDES[id]).toBeUndefined();
    }

    // And whatever the dialogue does not spend funds cognition rather than
    // evaporating: the two timeline citizens always add up to the whole pool.
    const caps = resolveAdaptiveSectionCaps(specimen());
    expect(caps.recentConversation + caps.cognitiveArtifacts).toBe(115_000);
  });
});
