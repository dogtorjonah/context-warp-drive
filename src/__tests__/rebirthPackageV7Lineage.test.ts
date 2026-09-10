import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRAIN_MERGE_REBIRTH_PACKAGE_BUDGET_CHARS,
  DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS,
  DEFAULT_REBIRTH_PACKAGE_V6_SECTION_MAX_CHARS,
  REBIRTH_PACKAGE_V6_SECTION_IDS,
  REBIRTH_PACKAGE_V7_BACKFILL_PRIORITY,
  REBIRTH_PACKAGE_V7_FRAMING_RESERVE_CHARS,
  REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS,
  REBIRTH_PACKAGE_V7_VERSION,
  buildActiveEditCollapseUnits,
  buildContinuityLedgerCaptureFromV6Render,
  buildRebirthPackageV6Model,
  isRebirthPackageV6Model,
  renderRebirthPackageV6,
  renderRebirthPackageV6Sections,
  renderRebirthPackageV6WithReport,
  resolveAdaptiveSectionCaps,
  type RebirthPackageV6Model,
  type RebirthPackageV7LineageSection,
  type RebirthPackageV7LineageUnit,
  type RenderRebirthPackageV6Options,
} from '../rebirthPackageV6.ts';
import { renderRawRebirthSeed, renderRawRebirthSeedWithReport } from '../rawRebirthSeed.ts';

/**
 * A lineage unit whose verbatim body is large enough that a handful of them
 * overflow any realistic section cap, so tier demotion is actually exercised
 * rather than asserted against a section that always fits.
 */
function unit(
  index: number,
  overrides: Partial<RebirthPackageV7LineageUnit> = {},
): RebirthPackageV7LineageUnit {
  const minute = String(index % 60).padStart(2, '0');
  const hour = String(Math.floor(index / 60) % 24).padStart(2, '0');
  return {
    id: `operator-message:${index}`,
    sourceAt: `2026-07-${String((index % 28) + 1).padStart(2, '0')}T${hour}:${minute}:00.000Z`,
    kind: 'operator',
    verbatim: `[operator · source=message:${index}] ${'jonah said something durable. '.repeat(20)}`,
    digest: `[operator#${index}] durable operator instruction`,
    eraKey: `2026-W${String((index % 4) + 27).padStart(2, '0')}`,
    claim: `operator turn ${index} set a durable expectation`,
    recover: `tap_instance_messages action="canonical" target_instance_id="instance-a" search="message:${index}"`,
    sha256: `0`.repeat(63) + String(index % 10),
    verified: true,
    ...overrides,
  };
}

function lineage(
  count: number,
  overrides: Partial<RebirthPackageV7LineageSection> = {},
): RebirthPackageV7LineageSection {
  return {
    units: Array.from({ length: count }, (_, index) => unit(index)),
    rangeRecover: 'tap_instance_messages action="canonical" target_instance_id="instance-a"',
    partialReason: null,
    ...overrides,
  };
}

function model(
  overrides: Partial<Parameters<typeof buildRebirthPackageV6Model>[0]> = {},
): RebirthPackageV6Model {
  return buildRebirthPackageV6Model({
    boundaryAndActiveTask: {
      lifecycle: 'same_instance_hard_epoch',
      lifecycleMeaning: 'same instance identity; provider context reset',
      captureId: 'capture-v7',
      capturedAt: '2026-08-07T19:00:00.000Z',
      sourceFrontier: 'event-1222',
      instanceId: 'instance-a',
      instanceName: 'worker-a',
      predecessorInstanceId: null,
      predecessorName: 'worker-a',
      workspace: 'voxxo-swarm',
      cwd: '/workspace',
      runtimeChange: null,
      activeRequest: {
        text: 'Finish the generational package.',
        chars: 32,
        source: {
          provenanceId: 'message:user-1',
          sourceAt: '2026-08-07T18:58:00.000Z',
          status: 'exact',
        },
      },
      lastMaterialAssistant: null,
    },
    recoveryIndex: [{
      id: 'transcript',
      label: 'transcript',
      handle: 'tap_instance_messages action="canonical" target_instance_id="instance-a"',
      status: 'available',
      count: null,
      frontier: 'event-1222',
    }],
    ...overrides,
  });
}

/**
 * D2: the delivered package no longer funds the three lineage sections — their
 * units are relocated to the continuity ledger, and rebirthTimeline.test.ts
 * pins that default (hidden bodies, identical ledger counts and hashes).
 *
 * The tests below exercise the lineage SECTION RENDERERS themselves —
 * newest-first ordering, feeder partial reasons, eviction envelopes, ledger
 * reachability declarations, backfill. Those contracts still ship and are still
 * reachable through an explicit caller cap (audit renders, brain-merge, any
 * caller override), so these tests fund them explicitly rather than asserting a
 * delivery default that D2 deliberately changed.
 */
const LINEAGE_SECTION_CAPS = {
  operatorVault: 60_000,
  episodeChapterIndex: 20_000,
  lifeLedger: 20_000,
} as const;

function fundLineage(options: RenderRebirthPackageV6Options): RenderRebirthPackageV6Options {
  return {
    ...options,
    sectionMaxChars: { ...LINEAGE_SECTION_CAPS, ...(options.sectionMaxChars ?? {}) },
  };
}

function sectionText(
  value: RebirthPackageV6Model,
  id: string,
  options: RenderRebirthPackageV6Options = {},
): string | null {
  const found = renderRebirthPackageV6Sections(value, fundLineage(options)).find((s) => s.id === id);
  return found ? found.text : null;
}

describe('raw hard-epoch v7 report boundary', () => {
  it('returns the shipped text, canonical collapse report, and rebirth ledger rows in one render', () => {
    const value = model({ operatorVault: lineage(3) });
    const input = { predecessorName: 'worker-a', rebirthV6: value };
    const rendered = renderRawRebirthSeedWithReport(input);

    expect(rendered.text).toBe(renderRawRebirthSeed(input));
    expect(rendered.collapse?.sections.some((section) => section.sectionId === 'operatorVault')).toBe(true);
    expect(rendered.continuityLedger).toMatchObject({
      lifecycle: 'rebirth',
      ownerInstanceId: 'instance-a',
      captureId: 'capture-v7',
      sourceStartIndex: null,
      sourceEndIndexExclusive: null,
    });
    expect(rendered.continuityLedger?.units).toHaveLength(3);
    for (const unit of rendered.continuityLedger?.units ?? []) {
      expect(unit.sourceIdentityAuthority).toBe('exact');
      expect(unit.sha256).toBe(createHash('sha256').update(unit.verbatim, 'utf8').digest('hex'));
    }
  });
});

describe('Rebirth Package v7 — lineage sections', () => {
  it('declares the three lineage sections in the fixed order, after recentConversation', () => {
    expect(REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS).toEqual([
      'operatorVault',
      'episodeChapterIndex',
      'lifeLedger',
    ]);
    const order = [...REBIRTH_PACKAGE_V6_SECTION_IDS];
    expect(order.indexOf('operatorVault')).toBeGreaterThan(order.indexOf('recentConversation'));
    expect(order.indexOf('episodeChapterIndex')).toBe(order.indexOf('operatorVault') + 1);
    expect(order.indexOf('lifeLedger')).toBe(order.indexOf('episodeChapterIndex') + 1);
    // recoveryIndex stays last so recovery handles are never displaced by lineage.
    expect(order[order.length - 1]).toBe('recoveryIndex');
  });

  it('keeps the ordinary profile at budget and treats Brain Merge as a conditional protected cap', () => {
    const ordinaryCapSum = Object.entries(DEFAULT_REBIRTH_PACKAGE_V6_SECTION_MAX_CHARS)
      .filter(([id]) => id !== 'brainMergeSynthesis')
      .map(([, cap]) => cap)
      .reduce((total, cap) => total + cap, 0);
    // Split envelope (2026-09-09): the static ordinary caps + framing reserve
    // partition the 150k package BODY. The declared 200k total adds up to 50k
    // of dynamic headroom that resolveAdaptiveSectionCapsInternal routes to the
    // timeline pool — the one cap that scales with packageBudget above 150k
    // (`Math.min(200_000, packageBudgetChars) - 150_000` in the pool formula).
    const packageBodyEnvelopeChars = 150_000;
    expect(ordinaryCapSum + REBIRTH_PACKAGE_V7_FRAMING_RESERVE_CHARS).toBe(packageBodyEnvelopeChars);
    expect(DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS - packageBodyEnvelopeChars).toBe(50_000);
    // The headroom is demand-bound (a section cap collapses to the bytes the
    // section can actually fill), so observe it with a conversation that
    // out-demands both pools: the 200k budget's extra 50k must reach the
    // timeline pool, less at most one whole exchange of admission slack.
    const bigDialogue: ReadonlyArray<{
      provenanceId: string;
      sourceAt: string;
      role: 'user' | 'assistant';
      text: string;
    }> = Array.from({ length: 300 }, (_, index) => ({
      provenanceId: `message:big-${index}`,
      sourceAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: 'x'.repeat(1_200),
    }));
    const capsAt200k = resolveAdaptiveSectionCaps(model({ recentConversation: bigDialogue }), { packageBudget: 200_000 });
    const capsAt150k = resolveAdaptiveSectionCaps(model({ recentConversation: bigDialogue }), { packageBudget: 150_000 });
    const headroomChars = capsAt200k.recentConversation - capsAt150k.recentConversation;
    expect(headroomChars).toBeGreaterThanOrEqual(45_000);
    expect(headroomChars).toBeLessThanOrEqual(50_000);
    // S9 conversation-first partition: the synthesis base cap is the exact
    // amount the timeline pool yields when a synthesis is present, so an
    // ORDINARY rebirth carrying donor synthesis cannot raid the timeline. The
    // brain_merge lifecycle is funded by its larger envelope, not by this base.
    expect(DEFAULT_REBIRTH_PACKAGE_V6_SECTION_MAX_CHARS.brainMergeSynthesis).toBe(10_000);
    expect(DEFAULT_BRAIN_MERGE_REBIRTH_PACKAGE_BUDGET_CHARS).toBe(300_000);
  });

  it('water-fills Brain Merge to 300k without enlarging ordinary rebirths', () => {
    const baseline = model();
    const synthesis = `${'donor synthesis evidence '.repeat(9_000)}END_OF_MERGE_SYNTHESIS`;
    const ordinary = model({ brainMergeSynthesis: synthesis });
    const brainMerge = model({
      boundaryAndActiveTask: {
        ...baseline.boundaryAndActiveTask,
        lifecycle: 'brain_merge',
        lifecycleMeaning: 'same identity; donor lineages absorbed at this boundary',
      },
      brainMergeSynthesis: synthesis,
    });

    const ordinaryText = renderRebirthPackageV6(ordinary);
    const brainMergeText = renderRebirthPackageV6(brainMerge);

    expect(ordinaryText.length).toBeLessThanOrEqual(DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS);
    expect(ordinaryText).not.toContain('END_OF_MERGE_SYNTHESIS');
    expect(brainMergeText.length).toBeGreaterThan(DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS);
    expect(brainMergeText.length).toBeLessThanOrEqual(
      DEFAULT_BRAIN_MERGE_REBIRTH_PACKAGE_BUDGET_CHARS,
    );
    expect(brainMergeText).toContain('END_OF_MERGE_SYNTHESIS');

    const explicitLowerBudget = renderRebirthPackageV6(brainMerge, { packageBudget: 120_000 });
    expect(explicitLowerBudget.length).toBeLessThanOrEqual(120_000);
    expect(explicitLowerBudget).not.toContain('END_OF_MERGE_SYNTHESIS');
  });

  it('renders every populated lineage section with its framed title and units', () => {
    const value = model({
      operatorVault: lineage(3),
      episodeChapterIndex: lineage(2),
      lifeLedger: lineage(2),
    });
    expect(value.version).toBe(REBIRTH_PACKAGE_V7_VERSION);
    for (const id of REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS) {
      const text = sectionText(value, id);
      expect(text, `${id} must be admitted when populated`).toBeTruthy();
      expect(text).toContain(`id=${id}`);
      expect(text).not.toContain('No lineage units captured');
    }
    expect(sectionText(value, 'operatorVault')).toContain('jonah said something durable.');
  });

  it('protects one frame for every admitted section when normal bodies yield under pressure', () => {
    const value = model({
      brainMergeSynthesis: 'merge anchor',
      cognitiveArtifacts: Array.from({ length: 80 }, (_, index) => ({
        provenanceId: `pressure:cognition:${index}`,
        sourceAt: `2026-08-07T17:${String(index % 60).padStart(2, '0')}:00.000Z`,
        kind: 'decision' as const,
        text: `cognitive-${index}-${'C'.repeat(900)}`,
        authority: 'current',
        supersededBy: null,
      })),
      recentConversation: Array.from({ length: 40 }, (_, index) => ({
        provenanceId: `pressure:message:${index}`,
        sourceAt: `2026-08-07T18:${String(index % 60).padStart(2, '0')}:00.000Z`,
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        text: `dialogue-${index}-${'D'.repeat(500)}`,
      })),
      operatorVault: lineage(40),
      episodeChapterIndex: lineage(40),
      lifeLedger: lineage(40),
    });
    const budget = 20_000;
    const { text, collapse } = renderRebirthPackageV6WithReport(value, fundLineage({ packageBudget: budget }));

    expect(text.length).toBeLessThanOrEqual(budget);
    expect(collapse.omittedSectionIds.length).toBeGreaterThan(0);
    expect(text).toContain('elided-section-bodies=');
    expect(text).toContain('protected-overrun=false');
    expect(text).not.toContain('omitted-sections=');
    for (const id of REBIRTH_PACKAGE_V6_SECTION_IDS) {
      // Vault-only operator rows now join dialogue. Cognition shares that
      // chronology's frame rather than publishing a second section.
      if (id === 'cognitiveArtifacts' && text.includes('── Timeline ──')) continue;
      const order = REBIRTH_PACKAGE_V6_SECTION_IDS.indexOf(id) + 1;
      const frames = text.match(new RegExp(`\\[REBIRTH-V6-SECTION id=${id} order=${order}(?: dir=\\w+)? chars=`, 'gu')) ?? [];
      expect(frames, `${id} must retain exactly one protected frame`).toHaveLength(1);
    }
    for (const id of collapse.omittedSectionIds) {
      if (id !== 'cognitiveArtifacts') expect(text).toContain(`[REBIRTH-V6-SECTION id=${id}`);
      expect(text).toContain(`[EVICTED section=${id}`);
    }
  });

  it('renders standalone lineage units newest-first', () => {
    const value = model({ operatorVault: lineage(3) });
    const text = sectionText(value, 'operatorVault')!;
    expect(text.indexOf('source=message:2')).toBeLessThan(text.indexOf('source=message:0'));
  });

  it('renders byte-identical output for the same model and options', () => {
    const value = model({
      operatorVault: lineage(40),
      episodeChapterIndex: lineage(12),
      lifeLedger: lineage(8),
    });
    const first = renderRebirthPackageV6(value);
    const second = renderRebirthPackageV6(value);
    expect(second).toBe(first);

    // A structurally identical model built from the same inputs must also be
    // byte-identical: collapse tiering may not depend on object identity.
    const twin = model({
      operatorVault: lineage(40),
      episodeChapterIndex: lineage(12),
      lifeLedger: lineage(8),
    });
    expect(renderRebirthPackageV6(twin)).toBe(first);
  });

  it('never exceeds an explicit section cap, and emits a collapse receipt when it demotes', () => {
    const value = model({ operatorVault: lineage(200) });
    const text = sectionText(value, 'operatorVault', {
      adaptiveBackfill: false,
      sectionMaxChars: { operatorVault: 4_000 },
    });
    expect(text).toBeTruthy();
    // Framing adds the section envelope; the body itself must respect the cap.
    expect(text!.length).toBeLessThanOrEqual(4_000 + 400);
    expect(text).toContain('[COLLAPSE units=200');
    expect(text).toMatch(/recover=tap_instance_messages/);
  });

  it('ships all available thin-lifecycle truth without truncation or padding', () => {
    const cognitionBody = `${'full cognition body '.repeat(70)}END_OF_AVAILABLE_TRUTH`;
    const value = model({
      cognitiveArtifacts: [{
        provenanceId: 'star:thin',
        sourceAt: '2026-08-07T18:59:00.000Z',
        kind: 'result',
        text: cognitionBody,
        authority: 'current',
        supersededBy: null,
      }],
      operatorVault: lineage(2),
    });
    // D2: the lineage sections are not delivered, so "demand" is measured over
    // the delivered set. Abundance still means dynamic defaults project or omit
    // nothing the same renderer could supply inside the fixed envelope.
    // The unified timeline (S7) is assembled by the COMPOSER, so the sections
    // API and the composed package are deliberately different layouts and byte
    // equality between them is no longer the invariant. The abundance claim is
    // layout-independent and stronger stated this way: at abundance the fixed
    // envelope costs nothing, so a far larger budget yields identical bytes.
    const { text, collapse } = renderRebirthPackageV6WithReport(value);
    expect(text).toBe(renderRebirthPackageV6(value, { packageBudget: 1_000_000 }));
    expect(text).toContain(cognitionBody);
    expect(collapse.omittedSectionIds).toEqual([]);
    // The only demoted units are the operator-vault units D2 relocates to the
    // continuity ledger — a delivery decision, not budget pressure. Nothing in
    // a delivered section is demoted at abundance.
    expect(collapse.telemetry.unitsDemoted).toBe(value.operatorVault?.units.length ?? 0);
    expect(collapse.telemetry.sectionsElided).toBe(0);
    // No padding: a young lifecycle stops at its available truth rather than
    // manufacturing bytes merely to approach 150k.
    expect(text.length).toBeLessThan(20_000);
    expect(collapse.telemetry.finalTotalChars).toBe(text.length);
  });

  it('keeps the whole package inside the declared budget with a saturated vault', () => {
    const saturated = {
      operatorVault: lineage(600),
      episodeChapterIndex: lineage(300),
      lifeLedger: lineage(120),
    };
    const value = model(saturated);
    const baseline = model();
    const brainMerge = model({
      ...saturated,
      boundaryAndActiveTask: {
        ...baseline.boundaryAndActiveTask,
        lifecycle: 'brain_merge',
        lifecycleMeaning: 'same identity; donor lineages absorbed at this boundary',
      },
    });
    const rendered = renderRebirthPackageV6(value, {
      sectionMaxChars: { operatorVault: 50_000, episodeChapterIndex: 50_000, lifeLedger: 50_000 },
    });
    expect(rendered.length).toBeLessThanOrEqual(DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS);
    // The point of v7: a rich lineage must actually consume the headroom rather
    // than rendering a thin package beside an unspent budget. Whole-unit
    // admission at the margin is discrete, and honest additive header bytes
    // (builder-identity line, self-describing census labels, per-lane recovery
    // wording) legally shift whether the last marginal unit fits — measured
    // 2026-08-28: 144,842–144,861 with and without one ~19-char census label,
    // i.e. exactly one marginal whole-unit drop (~158 chars) under the exact
    // floor regardless of that label. Tolerate one such drop; a genuinely thin
    // render lands thousands of chars short, not ~150.
    const oneMarginalWholeUnitDrop = 200;
    // Split envelope: this fixture saturates the lineage (body) sections only,
    // so the fill floor is the 150k package BODY minus the framing reserve —
    // not the 200k total, whose extra headroom feeds the timeline pool and
    // stays available to the raw hot tail at assembly time.
    const packageBodyEnvelopeChars = 150_000;
    expect(rendered.length).toBeGreaterThan(
      packageBodyEnvelopeChars
        - REBIRTH_PACKAGE_V7_FRAMING_RESERVE_CHARS
        - oneMarginalWholeUnitDrop,
    );

    // The brain_merge envelope is funded by its own lifecycle budget, so the
    // same saturated lineage must consume the LARGER headroom when the caller
    // funds those sections against it. D2 zeroed their delivery defaults, so
    // the caps come from the caller here exactly as they do above.
    const merged = renderRebirthPackageV6(brainMerge, {
      sectionMaxChars: { operatorVault: 150_000, episodeChapterIndex: 100_000, lifeLedger: 60_000 },
    });
    expect(merged.length).toBeLessThanOrEqual(
      DEFAULT_BRAIN_MERGE_REBIRTH_PACKAGE_BUDGET_CHARS,
    );
    expect(merged.length).toBeGreaterThan(DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS);
  });

  it('reserves envelope chars from the section budget rather than overflowing', () => {
    const value = model({ operatorVault: lineage(600) });
    const envelopeChars = 20_000;
    const rendered = renderRebirthPackageV6(value, {
      packageBudget: DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS,
      envelopeChars,
    });
    expect(rendered.length)
      .toBeLessThanOrEqual(DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS - envelopeChars);
  });

  it('gracefully shrinks the measured 224k push to 200k without amputating a section', () => {
    const value = model({
      operatorVault: lineage(600),
      episodeChapterIndex: lineage(300),
      lifeLedger: lineage(120),
    });
    // Reproduce the observed shape exactly: a saturated, fixed-cap section
    // render plus its protected relay envelope totals 224k before push-shrink.
    const unpressured = renderRebirthPackageV6(value, fundLineage({
      adaptiveBackfill: false,
      packageBudget: 1_000_000,
    }));
    const envelopeChars = 224_000 - unpressured.length;
    expect(envelopeChars).toBeGreaterThan(0);

    const { text, collapse } = renderRebirthPackageV6WithReport(value, fundLineage({
      packageBudget: 200_000,
      envelopeChars,
      adaptiveBackfill: false,
    }));
    expect(collapse.telemetry.initialTotalChars).toBe(224_000);
    expect(collapse.telemetry.budgetChars).toBe(200_000);
    expect(collapse.telemetry.pushTargetChars).toBe(200_000);
    expect(collapse.telemetry.finalTotalChars).toBeLessThanOrEqual(200_000);
    expect(collapse.telemetry.oversubscribedChars).toBe(24_000);
    expect(collapse.telemetry.sectionsShrunk).toBeGreaterThan(0);
    expect(collapse.telemetry.unitsDemoted).toBeGreaterThan(0);
    expect(collapse.telemetry.sectionsElided).toBe(0);
    expect(collapse.omittedSectionIds).toEqual([]);
    expect(text).not.toContain('[EVICTED section=');
    for (const id of REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS) {
      expect(text).toContain(`[REBIRTH-V6-SECTION id=${id}`);
    }
  });

  it('treats a lower push target as a soft target while the 200k budget stays the hard ceiling', () => {
    const value = model({
      operatorVault: lineage(600),
      episodeChapterIndex: lineage(300),
      lifeLedger: lineage(120),
    });
    const { collapse } = renderRebirthPackageV6WithReport(value, {
      packageBudget: 200_000,
      pushTargetChars: 150_000,
    });
    expect(collapse.telemetry.budgetChars).toBe(200_000);
    expect(collapse.telemetry.pushTargetChars).toBe(150_000);
    // Split envelope: the push target is a soft delivery target — it bounds the
    // appended raw-tail allowance and is reported through targetMissChars —
    // while the declared budget is the hard ceiling a saturated render must
    // stay inside. (Pre-split this asserted the total <= pushTarget, which held
    // only while the whole envelope was the push target.)
    expect(collapse.telemetry.finalTotalChars).toBeLessThanOrEqual(200_000);
    expect(collapse.telemetry.targetMissChars).toBeGreaterThan(0);
    expect(collapse.telemetry.hardOverrunChars).toBe(0);
    expect(collapse.omittedSectionIds).toEqual([]);
  });

  it('surfaces a feeder partial reason instead of implying a whole store read', () => {
    const value = model({
      operatorVault: lineage(3, { partialReason: 'lineage transcript 2 of 5 unreadable' }),
    });
    const rendered = renderRebirthPackageV6Sections(value, fundLineage({}))
      .find((s) => s.id === 'operatorVault');
    expect(rendered!.text).toContain('partial=lineage transcript 2 of 5 unreadable');
    expect(rendered!.complete).toBe(false);
  });

  it('declares omitted lineage units ledger-addressable when the continuity ledger handle exists', () => {
    // C2 truth-label: a partial section whose units have a continuity-ledger
    // omission route must say so, not claim "unknown" — the body's own
    // collapse receipt carries the fetch handle, so the header only needs the
    // honest availability word, never a duplicated recover= clause.
    const value = model({
      operatorVault: lineage(3, { partialReason: 'lineage transcript 2 of 5 unreadable' }),
      recoveryIndex: [
        ...model().recoveryIndex,
        {
          id: 'continuity-ledger',
          label: 'continuity ledger: placement + eviction rows for every unit of this build',
          handle: 'continuity_ledger action="index" owner="instance-a"',
          status: 'available' as const,
          count: null,
          frontier: null,
        },
      ],
    });
    const rendered = renderRebirthPackageV6Sections(value, fundLineage({}))
      .find((s) => s.id === 'operatorVault');
    expect(rendered!.text).toContain('omitted units are ledger-addressable');
    expect(rendered!.text).not.toContain('omitted-units=unknown');
    expect(rendered!.text).not.toContain('ledger-unreachable');
  });

  it('declares omitted lineage units ledger-unreachable when no ledger handle exists', () => {
    // C2 truth-label inverse: without a continuity-ledger entry the omitted
    // units are genuinely unreachable, and the package must say so rather
    // than implying a fetch route that is not wired.
    const value = model({
      operatorVault: lineage(3, { partialReason: 'lineage transcript 2 of 5 unreadable' }),
    });
    const rendered = renderRebirthPackageV6Sections(value, fundLineage({}))
      .find((s) => s.id === 'operatorVault');
    expect(rendered!.text).toContain('omitted-units=unknown · omitted units are ledger-unreachable');
    expect(rendered!.text).not.toContain('ledger-addressable');
  });

  it('renders an empty lineage section as explicitly empty, never as absent evidence', () => {
    const value = model({
      operatorVault: { units: [], rangeRecover: null, partialReason: null },
    });
    const rendered = renderRebirthPackageV6Sections(value, fundLineage({}))
      .find((s) => s.id === 'operatorVault');
    // An empty section may be omitted from admission, but if admitted it must
    // say so in words rather than render as a blank body.
    if (rendered) expect(rendered.text).toContain('No lineage units captured');
  });

  it('renders a persisted v6 package with no lineage keys without throwing', () => {
    const legacy = model();
    const stripped = { ...legacy } as Record<string, unknown>;
    for (const id of REBIRTH_PACKAGE_V7_LINEAGE_SECTION_IDS) delete stripped[id];
    expect(isRebirthPackageV6Model(stripped)).toBe(true);
    expect(() => renderRebirthPackageV6(stripped as unknown as RebirthPackageV6Model)).not.toThrow();
  });

  it('extends adaptive backfill eligibility to every admitted section in the frozen drink order', () => {
    // Dynamic fill (operator directive 2026-08-26): every admitted,
    // non-explicit, incomplete section is backfill-eligible so the loop
    // converges to demand-first water-fill. The order preserves the
    // re-derivability ranking under scarcity — operator memory and cognition
    // first (they die with the context that held them), pure recovery handles
    // last (cheap to regenerate, expansion adds the least).
    expect([...REBIRTH_PACKAGE_V7_BACKFILL_PRIORITY]).toEqual([
      'operatorVault',
      'cognitiveArtifacts',
      'recentConversation',
      'episodeChapterIndex',
      'lifeLedger',
      'activeEditDelta',
      'boundaryAndActiveTask',
      'brainMergeSynthesis',
      'executionState',
      'recoveryIndex',
    ]);
  });

  it('honors explicit vault caps independently of the legacy backfill flag', () => {
    const value = model({ operatorVault: lineage(600) });
    const withBackfill = renderRebirthPackageV6(value, fundLineage({ adaptiveBackfill: true }));
    const withoutBackfill = renderRebirthPackageV6(value, fundLineage({ adaptiveBackfill: false }));
    expect(withoutBackfill.length).toBeLessThanOrEqual(DEFAULT_REBIRTH_PACKAGE_V6_BUDGET_CHARS);
    expect(withBackfill).toBe(withoutBackfill);
    const vault = renderRebirthPackageV6Sections(value, fundLineage({})).find((section) => section.id === 'operatorVault')!;
    const bodyChars = Number(vault.text.match(/ chars=(\d+)\]/u)?.[1]);
    expect(bodyChars).toBeGreaterThan(0);
    expect(bodyChars).toBeLessThanOrEqual(LINEAGE_SECTION_CAPS.operatorVault);
    expect(vault.complete).toBe(false);
  });
});

describe('Rebirth Package v7 — eviction envelopes and edit citizenship', () => {
  const CONTINUITY_LEDGER_HANDLE = 'continuity_ledger action="index" owner="instance-a"';

  function ledgerRecoveryIndex() {
    return [{
      id: 'transcript',
      label: 'transcript',
      handle: 'tap_instance_messages action="canonical" target_instance_id="instance-a"',
      status: 'available' as const,
      count: null,
      frontier: 'event-1222',
    }, {
      id: 'continuity-ledger',
      label: 'continuity ledger: placement + eviction rows for every unit of this build',
      handle: CONTINUITY_LEDGER_HANDLE,
      status: 'available' as const,
      count: null,
      frontier: null,
    }];
  }

  /** Budget that fits everything except the saturated vault section. */
  function evictionBudget(value: RebirthPackageV6Model): number {
    const withoutVault = buildRebirthPackageV6Model({
      ...value,
      operatorVault: { units: [], rangeRecover: null, partialReason: null },
    });
    return renderRebirthPackageV6(withoutVault, fundLineage({})).length + 1800;
  }

  it('renders a framed eviction body with era census and one ledger handle when content yields', () => {
    const value = model({ operatorVault: lineage(40), recoveryIndex: ledgerRecoveryIndex() });
    const { text, collapse } = renderRebirthPackageV6WithReport(value, fundLineage({
      packageBudget: evictionBudget(value),
    }));
    expect(text).toContain('[REBIRTH-V6-SECTION id=operatorVault');
    expect(text).toContain(`[EVICTED section=operatorVault units=40 span=2026-07-`);
    const recoveryRef = /\[EVICTED section=operatorVault units=40 span=[^\]]+ recover=(R\d+)\]/u
      .exec(text)?.[1];
    expect(recoveryRef).toBeTruthy();
    expect(text).toContain(
      `- ${recoveryRef} = continuity_ledger action="fetch" owner="instance-a" capture_id="capture-v7"`
      + ' section_id="operatorVault" omitted_only=true include_unknown_source_time=true limit=200',
    );
    expect(text).toContain('· era=');
    expect(text).not.toContain('ledger unreachable');
    expect(collapse.omittedSectionIds).toContain('operatorVault');
    const vaultReport = collapse.sections.find((section) => section.sectionId === 'operatorVault');
    expect(vaultReport?.sectionElided).toBe(true);
    expect(vaultReport?.placements).toHaveLength(40);
  });

  it('renders the declared degradation line when the ledger handle is unreachable', () => {
    const value = model({ operatorVault: lineage(40) });
    const { text } = renderRebirthPackageV6WithReport(value, fundLineage({
      packageBudget: evictionBudget(value),
    }));
    expect(text).toContain('[EVICTED section=operatorVault units=40 span=');
    expect(text).toContain('40 units evicted; ledger unreachable');
    expect(text).not.toContain(' ledger=continuity_ledger');
  });

  function editDelta(fileCount: number): NonNullable<Parameters<typeof buildRebirthPackageV6Model>[0]['activeEditDelta']> {
    return {
      captureId: 'atlas-edit-capture:v1:abc',
      state: 'exact',
      capturedSourceAt: '2026-08-07T18:00:00.000Z',
      completedObservedAt: '2026-08-07T18:00:00.100Z',
      inheritedCaptureIds: [],
      files: Array.from({ length: fileCount }, (_, index) => ({
        provenanceId: `edit-file:${index}`,
        sourceAt: `2026-08-0${(index % 6) + 1}T1${index % 10}:00:00.000Z`,
        filePath: `src/example-${index}.ts`,
        changeKind: 'modified' as const,
        baselineQuality: 'exact' as const,
        ownership: 'mine' as const,
        state: 'open' as const,
        insertions: index + 1,
        deletions: index,
        validationState: 'passed' as const,
        closureState: 'open' as const,
        contributors: [],
        preview: {
          text: `@@ -1 +1 @@\n-old-${index}\n+${'new content line. '.repeat(30)}`,
          complete: true,
          omittedHunks: 0,
          omittedLines: 0,
        },
        diffHandle: `atlas_agent_diff instance_id="instance-a" capture_id="atlas-edit-capture:v1:abc" file="src/example-${index}.ts"`,
        snapshotHandle: null,
        reason: null,
      })),
      omittedFiles: 0,
      truncated: false,
      reasons: [],
    };
  }

  it('gives the Active Edit Delta collapse citizenship: receipts inside the section and a report entry', () => {
    const value = model({ activeEditDelta: editDelta(6) });
    const { collapse } = renderRebirthPackageV6WithReport(value, {
      sectionMaxChars: { activeEditDelta: 900 },
    });
    const section = renderRebirthPackageV6Sections(value, { sectionMaxChars: { activeEditDelta: 900 } })
      .find((entry) => entry.id === 'activeEditDelta');
    expect(section?.text).toContain('[COLLAPSE units=6');
    expect(section?.text.length).toBeLessThanOrEqual(900 + section!.text.indexOf('\n') + 200);
    const aedReport = collapse.sections.find((entry) => entry.sectionId === 'activeEditDelta');
    expect(aedReport).toBeDefined();
    expect(aedReport!.demotions).toBeGreaterThan(0);
    expect(aedReport!.placements).toHaveLength(6);
    expect(aedReport!.placements.some((placement) => placement.tier !== 't0')).toBe(true);
  });

  it('floor-protects must-push Active Edit Delta under irreducible pressure', () => {
    const value = model({ activeEditDelta: editDelta(80) });
    const { text, collapse } = renderRebirthPackageV6WithReport(value, {
      packageBudget: 4_000,
      pushTargetChars: 4_000,
    });
    const aedReport = collapse.sections.find((entry) => entry.sectionId === 'activeEditDelta');
    expect(text).toContain('[REBIRTH-V6-SECTION id=activeEditDelta');
    expect(text).toContain('[COLLAPSE units=80');
    expect(collapse.omittedSectionIds).not.toContain('activeEditDelta');
    expect(aedReport?.sectionElided).toBe(false);
    expect(collapse.telemetry.sectionsShrunk).toBeGreaterThan(0);
  });

  it('persists edit-kind ledger rows whose sha256 proves the exact evicted block bytes', () => {
    const value = model({ activeEditDelta: editDelta(6) });
    const report = renderRebirthPackageV6WithReport(value, {
      sectionMaxChars: { activeEditDelta: 900 },
    }).collapse;
    const record = buildContinuityLedgerCaptureFromV6Render(value, report);
    expect(record).not.toBeNull();
    const editRows = record!.units.filter((row) => row.sectionId === 'activeEditDelta');
    expect(editRows).toHaveLength(6);
    const units = buildActiveEditCollapseUnits(value);
    for (const row of editRows) {
      expect(row.kind).toBe('edit');
      const unit = units.find((candidate) => candidate.id === row.unitId);
      expect(unit).toBeDefined();
      expect(row.sha256).toBe(createHash('sha256').update(unit!.verbatim, 'utf8').digest('hex'));
      expect(row.recover).toContain('atlas_agent_diff');
      expect(row.sourceTime).toBe(unit!.sourceAt);
    }
    expect(editRows.some((row) => row.tierBasis !== 'rendered')).toBe(true);
  });

  it('keeps legacy bounded-log AED (no capture id) outside the collapse engine', () => {
    const value = model({
      activeEditDelta: {
        captureId: null,
        state: 'unknown',
        capturedSourceAt: null,
        completedObservedAt: null,
        inheritedCaptureIds: [],
        files: [{
          provenanceId: 'legacy-edit-delta:one',
          sourceAt: null,
          filePath: 'unknown',
          changeKind: 'unknown',
          baselineQuality: 'baseline_unknown',
          ownership: 'baseline_unknown',
          state: 'unknown',
          insertions: null,
          deletions: null,
          validationState: 'unknown',
          closureState: 'unknown',
          contributors: [],
          preview: { text: '18:00 edited src/a.ts', complete: true, omittedHunks: 0, omittedLines: 0 },
          diffHandle: null,
          snapshotHandle: null,
          reason: null,
        }],
        omittedFiles: 0,
        truncated: false,
        reasons: ['immutable capture unavailable'],
      },
    });
    expect(buildActiveEditCollapseUnits(value)).toHaveLength(0);
    const { collapse } = renderRebirthPackageV6WithReport(value);
    expect(collapse.sections.some((entry) => entry.sectionId === 'activeEditDelta')).toBe(false);
  });
});

describe('Rebirth Package v7 — redaction lane at the render boundary', () => {
  // Runtime concatenation so static secret scanners never match this file.
  const SECRET = 'AKIA' + 'IOSFODNN7EXAMPLE';

  function dirtyUnit(): RebirthPackageV7LineageUnit {
    const dirtyVerbatim = `[operator · source=message:7] rotate the key ${SECRET} now. ${'pad '.repeat(30)}`;
    return unit(7, {
      verbatim: dirtyVerbatim,
      claim: `operator turn 7 pasted ${SECRET}`,
      sha256: createHash('sha256').update(dirtyVerbatim, 'utf8').digest('hex'),
    });
  }

  function dirtyModel(): RebirthPackageV6Model {
    return model({
      operatorVault: {
        units: [dirtyUnit(), unit(8)],
        rangeRecover: 'tap_instance_messages action="canonical" target_instance_id="instance-a"',
        partialReason: null,
      },
    });
  }

  it('redacts secrets at push with a declared banner and never ships the raw bytes', () => {
    const { text } = renderRebirthPackageV6WithReport(dirtyModel(), fundLineage({}));
    expect(text).not.toContain(SECRET);
    expect(text).toContain('[REDACTED:aws-access-key]');
    expect(text).toContain('[REDACTION-LANE spans=');
  });

  it('keeps ledger capture rows consistent with shipped bytes even from the pre-lane model reference', () => {
    const value = dirtyModel();
    const { text, collapse } = renderRebirthPackageV6WithReport(value);
    expect(text).not.toContain(SECRET);
    // The renderer hands the ORIGINAL model reference to the capture builder;
    // the lane must make that path converge on the same redacted bytes.
    const record = buildContinuityLedgerCaptureFromV6Render(value, collapse);
    const row = record?.units.find((entry) => entry.unitId === 'operator-message:7');
    expect(row).toBeDefined();
    expect(row!.verbatim).not.toContain(SECRET);
    expect(row!.claim).not.toContain(SECRET);
    // Worker mint gate acceptance: the row sha reproduces over the shipped
    // (redacted) bytes.
    expect(row!.sha256).toBe(createHash('sha256').update(row!.verbatim, 'utf8').digest('hex'));
  });

  it('keeps the aggregate declaration inside the declared package budget under vault elision', () => {
    const value = model({
      operatorVault: {
        units: [dirtyUnit(), ...Array.from({ length: 40 }, (_, index) => unit(index + 10))],
        rangeRecover: 'tap_instance_messages action="canonical" target_instance_id="instance-a"',
        partialReason: null,
      },
    });
    // Budget fits everything except the saturated vault, so compose elides the
    // vault section — the declaration must ride inside that budget, and the
    // secret must not leak through the eviction path either.
    const budget = renderRebirthPackageV6(model({})).length + 1500;
    const { text } = renderRebirthPackageV6WithReport(value, { packageBudget: budget });
    expect(text.length).toBeLessThanOrEqual(budget);
    expect(text).toContain('[REDACTION-LANE spans=');
    expect(text).not.toContain(SECRET);
  });
});
