import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildRebirthPackageV6Model,
  lintPackageSelfChecks,
  measureRebirthPackageMetadataDensity,
  REBIRTH_PACKAGE_METADATA_RATIO_BARS,
  REBIRTH_PACKAGE_PROSE_SECTION_IDS,
  renderRebirthPackageV6,
  renderRebirthPackageV6WithReport,
  sha256ContinuityLedgerVerbatim,
  type RebirthPackageV6Model,
  type RebirthPackageV7LineageSection,
} from '../rebirthPackageV6.ts';
import { type CollapseUnit } from '../generationalCollapse.ts';

/**
 * Synthetic golden-package fixture (plan feature 12, W0).
 *
 * Freezes a deterministic, hand-authored v6 model with all sections populated,
 * provenance-shaped prose, and the full recovery-index status/reason contract.
 * It is a renderer benchmark, not a captured lifecycle artifact. The FULL
 * render is snapshot-tested by SHA-256, so formatting, ordering, or honesty-
 * label regressions fail byte-exactly without embedding ~145k literal chars in
 * source. The same model feeds the S2 self-lint scaffold checks.
 */

function unit(overrides: Partial<CollapseUnit> = {}): CollapseUnit {
  return {
    id: 'unit:one',
    sourceAt: '2026-09-01T18:00:00.000Z',
    kind: 'operator',
    verbatim: '[operator · source=msg_1 · source-time=2026-09-01T18:00:00.000Z]\nVerbatim operator row body.',
    digest: '[operator] msg_1 · 2026-09-01T18:00:00.000Z · Verbatim operator row body.',
    claim: 'operator msg_1',
    recover: 'tap_instance_messages action="recent" target_instance_id="inst-a"',
    sha256: sha256ContinuityLedgerVerbatim('Verbatim operator row body.'),
    verified: true,
    origin: 'declared',
    sourceInstanceId: 'inst-a',
    ...overrides,
  };
}

function lineage(units: readonly CollapseUnit[], partialReason: string | null = null): RebirthPackageV7LineageSection {
  return { units, rangeRecover: 'continuity_ledger action="fetch" owner="bxuaLHT0"', partialReason };
}

/** Deterministic, fully-populated synthetic v6 renderer model. */
function benchmarkModel(): RebirthPackageV6Model {
  return buildRebirthPackageV6Model({
    boundaryAndActiveTask: {
      lifecycle: 'continuation',
      lifecycleMeaning: 'same instance identity; new session continuation',
      captureId: 'rebirth-v2-31366e584b627269-1788294508233',
      capturedAt: '2026-09-01T21:19:42.460Z',
      sourceFrontier: 'canonical-model-1788297575919-EBWex2',
      instanceId: 'inst-a',
      instanceName: 'worker-a',
      predecessorInstanceId: 'inst-prev',
      predecessorName: 'worker-a',
      workspace: 'voxxo-swarm',
      cwd: '/home/jonah/voxxo-swarm',
      runtimeChange: null,
      activeRequest: {
        text: 'Implement rail-ce32a922 S1, S2, renderer portions.',
        chars: 48,
        source: { provenanceId: 'msg_active', sourceAt: '2026-09-01T20:47:52.476Z', status: 'exact' },
      },
      lastMaterialAssistant: {
        text: 'I will implement it now.',
        chars: 24,
        source: { provenanceId: 'msg_last', sourceAt: '2026-09-01T20:48:13.307Z', status: 'exact' },
      },
    },
    executionState: {
      facts: [
        {
          provenanceId: 'rail:ce32a922:a-s1',
          sourceAt: '2026-09-01T21:18:46.069Z',
          status: 'exact',
          kind: 'rail',
          text: 'rail-ce32a922 · Rebirth package level-up implementation · ready',
        },
        {
          provenanceId: 'receipt-next_action:bench',
          sourceAt: '2026-09-01T21:19:35.875Z',
          status: 'exact',
          kind: 'next_action',
          text: 'Validate focused package tests; Atlas-settle owned paths.',
        },
      ],
      unknownReasons: [],
    },
    activeEditDelta: {
      captureId: null,
      state: 'unknown',
      capturedSourceAt: null,
      completedObservedAt: null,
      inheritedCaptureIds: [],
      files: [
        {
          provenanceId: 'legacy-edit-delta:bench',
          sourceAt: null,
          filePath: 'packages/context-warp/src/rebirthPackageV6.ts',
          changeKind: 'modified',
          baselineQuality: 'baseline_unknown',
          ownership: 'mine',
          state: 'unknown',
          insertions: 3,
          deletions: 1,
          validationState: 'pending',
          closureState: 'open',
          contributors: [],
          preview: {
            text: '@@ -349 +349 @@\n-  readonly status: \'available\' | \'partial\' | \'unavailable\';\n+  readonly status: \'available\' | \'partial\' | \'unavailable\' | \'not-requested\';',
            complete: true,
            omittedHunks: 0,
            omittedLines: 0,
          },
          diffHandle: null,
          snapshotHandle: null,
          reason: 'no immutable Atlas edit capture was supplied',
        },
      ],
      omittedFiles: 0,
      truncated: false,
      reasons: ['no immutable Atlas edit capture was supplied'],
    },
    cognitiveArtifacts: [
      {
        provenanceId: 'decision:one',
        sourceAt: '2026-09-01T17:45:53.355Z',
        kind: 'decision',
        text: 'Use one immutable model.',
        authority: 'current',
        supersededBy: null,
      },
      {
        provenanceId: 'hazard:one',
        sourceAt: '2026-09-01T20:38:19.147Z',
        kind: 'hazard',
        text: '⚠️ capture-degraded=cognition is a false positive now.',
        authority: 'current',
        supersededBy: null,
      },
      {
        provenanceId: 'result:one',
        sourceAt: '2026-09-01T21:09:07.179Z',
        kind: 'result',
        text: '🏁 #result Rebirth package level-up verification complete.',
        authority: 'current',
        supersededBy: null,
      },
    ],
    recentConversation: [
      {
        provenanceId: 'msg_assistant_recent',
        sourceAt: '2026-09-01T21:18:41.221Z',
        role: 'assistant',
        text: '[assistant]\n▶ The planning rail is fully resolved.',
      },
      {
        provenanceId: 'msg_operator_recent',
        sourceAt: '2026-09-01T20:47:52.476Z',
        role: 'user',
        text: '[operator]\nYes go verify and then make a fix plan.',
      },
    ],
    operatorVault: lineage([
      unit({ id: 'op:1', kind: 'operator', verbatim: '[operator · source=msg_1 · source-time=2026-09-01T20:47:52.476Z]\nYes go verify.', sourceAt: '2026-09-01T20:47:52.476Z' }),
      unit({ id: 'op:2', kind: 'operator', sourceAt: '2026-09-01T18:43:26.605Z' }),
    ]),
    episodeChapterIndex: lineage([
      unit({ id: 'ep:1', kind: 'episode', sourceAt: '2026-09-01T21:10:01.765Z' }),
      unit({ id: 'ep:2', kind: 'episode', sourceAt: '2026-09-01T17:45:53.355Z' }),
    ]),
    lifeLedger: lineage([
      unit({ id: 'life:1', kind: 'life', sourceAt: '2026-09-01T21:17:27.184Z', sourceEndAt: '2026-09-01T21:19:42.460Z' }),
      unit({ id: 'life:2', kind: 'life', sourceAt: '2026-09-01T17:37:55.860Z', sourceEndAt: '2026-09-01T20:06:10.862Z' }),
    ]),
    recoveryIndex: [
      {
        id: 'transcript',
        label: 'complete transcript and raw canonical tail',
        handle: 'tap_instance_messages action="canonical" target_instance_id="inst-a"',
        status: 'available',
        count: 969,
        frontier: 'canonical-model-1788297575919-EBWex2',
      },
      {
        id: 'atlas-edit-capture',
        label: 'immutable Atlas edit capture',
        handle: '',
        status: 'not-requested',
        count: null,
        frontier: null,
        reason: 'sidecar build path did not request an immutable Atlas edit capture',
      },
      {
        id: 'atlas-edit-post-frontier',
        label: 'explicit edits observed after the immutable capture frontier',
        handle: '',
        status: 'not-requested',
        count: null,
        frontier: null,
        reason: 'sidecar build path did not request an immutable Atlas edit capture',
      },
    ],
  });
}

/**
 * Two rendered modes, two goldens (rail-72adf723 S17).
 *
 * DELIVERY is what an agent actually wakes up reading: one interleaved
 * Timeline, compact `⟨source @time⟩` anchors, life/episode/vault detail
 * relocated to the continuity ledger. DIAGNOSTIC is the explicit operator
 * audit view that still carries the long `key=value` provenance rows.
 *
 * Both are frozen. The delivery golden is the contract a successor reads; the
 * diagnostic golden is what keeps the compaction honest, because every fact
 * the compact view shortens must still be provable in full somewhere. A fact
 * that vanishes from BOTH is a regression, not a density win.
 */
const DELIVERY = { packageBudget: 150_000 } as const;
const AUDIT = { packageBudget: 150_000, diagnostic: true } as const;

describe('rebirth package golden fixture (synthetic renderer model)', () => {
  it('renders deterministically; full-render SHA-256 is frozen in both modes', () => {
    const model = benchmarkModel();
    // Determinism: identical input must produce identical output.
    const first = renderRebirthPackageV6WithReport(model, DELIVERY);
    const second = renderRebirthPackageV6WithReport(model, DELIVERY);
    expect(second.text).toBe(first.text);

    const audit = renderRebirthPackageV6WithReport(model, AUDIT);
    expect(renderRebirthPackageV6WithReport(model, AUDIT).text).toBe(audit.text);
    // The two modes must not silently converge: a diagnostic view identical to
    // the delivered one would mean the compaction never happened.
    expect(audit.text).not.toBe(first.text);

    const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
    // Frozen byte-exact hashes. Update deliberately only when the renderer's
    // formatting/honesty output intentionally changes.
    // The newest exchange now precedes historical context; endpoint pointers
    // declare source length without falsely promising an untruncated body.
    // Vault-only operator rows join the timeline, with source identity dedupe.
    // Declared open items render in the delivered boundary and the diagnostic
    // record (declaration trace, newest-first, dated rows only — undated
    // declarations stay quarantined per God Rule 8).
    // The semantic cases below and rebirthTimeline cover these intended deltas.
    // 2026-09-10 (L3 S6): the Recovery Index now precedes the Timeline. The only
    // deltas are section order and `order=` frame numbers (recoveryIndex 10→5;
    // the merged Timeline frame 6→7, now registry-derived instead of a literal);
    // every section body is byte-identical, pinned by the section-order case
    // below. One assertion so a deliberate re-freeze reads both digests at once.
    expect({ delivery: sha(first.text), audit: sha(audit.text) }).toEqual({
      // Length-framed compact request, historical-report qualification, and
      // explicit recovery/population semantics intentionally change both views.
      delivery: 'db53e89509ada0ec577298bea66622f8a5a440ac8ff09f04319a4b6aaac7a74f',
      audit: '9d9b0bfa32a2cbaf98a26b019c9947785aaf1958c50b5ec125b369e5bddf0f5e',
    });
  });

  const sectionIds = (text: string): string[] => [
    ...text.matchAll(/\[REBIRTH-V6-SECTION id=([A-Za-z]+) order=(\d+)(?: dir=\w+)? chars=\d+\]/gu),
  ].map((match) => `${match[1]}:${match[2]}`);

  const SHARED_SECTIONS = [
    '── Boundary and Active Task ──',
    '── Execution State ──',
    '── Active Edit Delta ──',
    '── Timeline ──',
    '── Recovery Index ──',
  ] as const;

  // Cognition and conversation are ONE chronological section now; splitting
  // them is what let a single artifact render twice under two authorities. The
  // vault/episode/life sections are relocated to the continuity ledger. This is
  // structure, not presentation, so BOTH modes share it — `diagnostic` is a
  // verbosity flag, never a legacy-layout escape hatch.
  const RETIRED_SECTIONS = [
    '── Cognitive Artifacts ──',
    '── Recent Conversation ──',
    '── Operator Vault ──',
    '── Episode Chapter Index ──',
    '── Life Ledger ──',
  ] as const;

  it.each([['delivery', DELIVERY], ['diagnostic', AUDIT]] as const)(
    'renders one interleaved Timeline and no retired sections (%s)',
    (_mode, options) => {
      const { text } = renderRebirthPackageV6WithReport(benchmarkModel(), options);
      for (const marker of SHARED_SECTIONS) expect(text, `section ${marker}`).toContain(marker);
      for (const retired of RETIRED_SECTIONS) expect(text, `retired ${retired}`).not.toContain(retired);
      expect(sectionIds(text)).toEqual([
        'boundaryAndActiveTask:1',
        'executionState:3',
        'activeEditDelta:4',
        'recoveryIndex:5',
        'recentConversation:7',
      ]);
    },
  );

  it('states the relocated life/episode/vault census rather than dropping it', () => {
    const { text } = renderRebirthPackageV6WithReport(benchmarkModel(), DELIVERY);
    // Retired sections' units are relocated, not deleted: the delivered package
    // still says how many exist and that the stores retain them.
    expect(text).toMatch(/History census: \d+ lives;/u);
    expect(text).toMatch(/\d+ episodes/u);
    expect(text).toMatch(/\d+ vault units retained in stores/u);
  });

  it('renders literal boundary, partial-lane, vault, review-demand, and endpoint truth rows', () => {
    const base = benchmarkModel();
    const withReviewDemand = buildRebirthPackageV6Model({
      boundaryAndActiveTask: base.boundaryAndActiveTask,
      executionState: {
        facts: [
          ...base.executionState.facts,
          {
            provenanceId: 'review:bench',
            sourceAt: '2026-09-01T21:19:40.000Z',
            status: 'exact',
            kind: 'review',
            text: 'independent correction review pending',
          },
        ],
        unknownReasons: base.executionState.unknownReasons,
      },
      activeEditDelta: base.activeEditDelta,
      cognitiveArtifacts: base.cognitiveArtifacts,
      recentConversation: base.recentConversation,
      recoveryIndex: base.recoveryIndex,
      operatorVault: base.operatorVault,
      episodeChapterIndex: base.episodeChapterIndex,
      lifeLedger: base.lifeLedger,
    });
    const { text } = renderRebirthPackageV6WithReport(withReviewDemand, AUDIT);
    expect(text).toContain('versions=model:rebirth-package-v7/v1 · render:v6-sections · capture-id:naming-v2 · provenance:v1 · frame:rebirth-v6-section');
    // A lane nobody requested is not a partially-captured lane, so it no
    // longer inflates the partial-lane census; its own row still says so.
    // A lane nobody requested is not a partially-captured one, and a section
    // D2 relocated to the ledger is not a truncated one. Both distinctions live
    // in this single header; collapsing either into `cap` sends a successor
    // hunting for bytes that were never lost.
    expect(text).toContain('capture-partial-lanes=active-edit-delta:not-requested,operator-vault:relocated,episode-chapter-index:relocated,life-ledger:relocated · class-vocabulary=horizon|cap|store|merge|relocated|not-requested|unknown');
    expect(text).toContain('status=not-requested');
    expect(text).toContain('vault-newest=2026-09-01T20:47:52.476Z · active-request=2026-09-01T20:47:52.476Z');
    // Execution-state rows carry the shared ⟨source @time⟩ anchor in both
    // modes; the diagnostic view is verbose in the Boundary, not everywhere.
    expect(text).toContain('- rail-review-state=independent correction review pending ⟨review:bench @09-01 21:19:40Z⟩');
    expect(text).toContain('[EXACT ACTIVE REQUEST · 48 chars · source=msg_active · source-time=2026-09-01T20:47:52.476Z · status=exact]');
    expect(text).toContain('[LAST MATERIAL ASSISTANT · 24 chars · source=msg_last · source-time=2026-09-01T20:48:13.307Z · status=exact]');

    // Delivery keeps both endpoints and both source identities; only the
    // five-clause provenance uniform collapses to one anchor. The bodies stay
    // verbatim, and each still renders exactly once (#37479).
    const delivered = renderRebirthPackageV6WithReport(withReviewDemand, DELIVERY).text;
    expect(delivered).toContain('[EXACT ACTIVE REQUEST ⟨msg_active @09-01 20:47:52Z⟩ · chars=50]');
    expect(delivered).toContain('[LAST MATERIAL ASSISTANT ⟨msg_last @09-01 20:48:13Z⟩]');
    expect(delivered.match(/\[EXACT ACTIVE REQUEST /gu)).toHaveLength(1);
    expect(delivered.match(/\[LAST MATERIAL ASSISTANT /gu)).toHaveLength(1);
    // The review demand is execution state a successor must not lose.
    expect(delivered).toContain('independent correction review pending');
  });

  it('renders honest not-requested recovery lanes with their reason (S4/S6 contract)', () => {
    const { text } = renderRebirthPackageV6WithReport(benchmarkModel(), AUDIT);
    expect(text).toContain('status=not-requested');
    expect(text).toContain('reason=sidecar build path did not request an immutable Atlas edit capture');
    // Empty-handle not-requested lane renders recover=not-requested, never a
    // contradictory recover=unavailable fake handle.
    expect(text).toContain('recover=not-requested');
    // A not-requested capture must not read as an attempted failure.
    expect(text).not.toContain('capture-degraded=active-edit-delta');

    // Delivery drops the `status=` key, never the distinction it carries: a
    // lane nobody asked for must still not read as a lane that failed.
    const delivered = renderRebirthPackageV6WithReport(benchmarkModel(), DELIVERY).text;
    expect(delivered).toContain('- atlas-edit-capture · not-requested · recover=not-requested · reason=sidecar build path did not request an immutable Atlas edit capture');
    expect(delivered).not.toContain('capture-degraded=active-edit-delta');
    // A lane nobody asked for must never advertise a fake handle.
    expect(delivered).not.toContain('recover=unavailable');
  });

  it('renders the producer-fed lineage-chain and honest ops Now-card lines when supplied', () => {
    const base = benchmarkModel();
    const chained = buildRebirthPackageV6Model({
      boundaryAndActiveTask: {
        ...base.boundaryAndActiveTask,
        nowCard: {
          forkPurpose: null,
          parentIdentity: null,
          parentStatus: null,
          currentRail: null,
          lineageChain: [
            { instanceId: 'inst-root', instanceName: 'root', sourceAt: '2026-08-24T04:44:23.040Z', sourceEndAt: '2026-08-31T23:59:00.000Z', archived: true },
            { instanceId: 'inst-a', instanceName: 'worker-a', sourceAt: '2026-09-01T21:17:27.184Z', sourceEndAt: null, archived: false },
          ],
          ops: {
            repositoryState: 'unknown',
            repositoryReason: 'worker git status not captured',
            ownedLiveChildren: [{ id: 'child-1', name: 'continuity-scout' }],
            squad: 'squad-rebirth',
            rooms: ['rebirth-package-levelup'],
            source: { provenanceId: 'rebirth-capture:ops', sourceAt: '2026-09-01T19:19:53.996Z', status: 'exact' as const },
          },
        },
      },
      executionState: base.executionState,
      activeEditDelta: base.activeEditDelta,
      cognitiveArtifacts: base.cognitiveArtifacts,
      recentConversation: base.recentConversation,
      recoveryIndex: base.recoveryIndex,
      operatorVault: base.operatorVault,
      episodeChapterIndex: base.episodeChapterIndex,
      lifeLedger: base.lifeLedger,
    });
    const { text } = renderRebirthPackageV6WithReport(chained, AUDIT);
    expect(text).toContain('lineage-chain=root (inst-root) · 2026-08-24→2026-08-31 · archived');
    expect(text).toContain('worker-a (inst-a) · 2026-09-01→now · live-at-capture');
    expect(text).toContain('ops=git:unknown:worker-git-status-not-captured');
    expect(text).toContain('owned-live-children=continuity-scout(child-1)');
    expect(text).toContain('squad=squad-rebirth · rooms=rebirth-package-levelup');

    // Delivery carries each of those facts in one prose line apiece. The
    // 2026-09-09 cross-agent pollution was caught because the chain named who
    // this instance descends from, so the chain is load-bearing, not decor.
    const delivered = renderRebirthPackageV6WithReport(chained, DELIVERY).text;
    expect(delivered).toContain('Lineage: root (inst-root) 2026-08-24→2026-08-31 archived → worker-a (inst-a) 2026-09-01→now live-at-capture');
    // A failed repository probe still answers "what is the tree at?" — it must
    // report unknown with its reason, never fall silent.
    expect(delivered).toContain('Checkpoint: unknown · worker git status not captured');
    // Principle 15: a live agent-created child is an inherited teardown debt.
    expect(delivered).toContain('Owned children (teardown owed): continuity-scout(child-1)');
    // Principle 14 scopes review eligibility to the executor's own squad.
    expect(delivered).toContain('Squad: squad-rebirth');
  });

  it('renders the runtime-model transition in both modes, including unchanged (integration gate)', () => {
    const base = benchmarkModel();
    const withRuntime = buildRebirthPackageV6Model({
      boundaryAndActiveTask: {
        ...base.boundaryAndActiveTask,
        runtimeChange: null,
        runtimeModelContext: {
          predecessor: { engine: 'codex', model: 'gpt-5.5' },
          successor: { engine: 'codex', model: 'gpt-5.5' },
          changed: false,
        },
      },
      executionState: base.executionState,
      activeEditDelta: base.activeEditDelta,
      cognitiveArtifacts: base.cognitiveArtifacts,
      recentConversation: base.recentConversation,
      recoveryIndex: base.recoveryIndex,
      operatorVault: base.operatorVault,
      episodeChapterIndex: base.episodeChapterIndex,
      lifeLedger: base.lifeLedger,
    });
    const { text } = renderRebirthPackageV6WithReport(withRuntime, AUDIT);
    // The four-line `── Runtime Model ──` block is retired; the transition it
    // carried is not, and an UNCHANGED transition still has to render — a
    // successor that cannot see it does not know whether the model reasoning
    // now is the one that produced the work it inherited.
    expect(text).not.toContain('── Runtime Model ──');
    expect(text).toContain('runtime-model=codex/gpt-5.5 -> codex/gpt-5.5 · changed=no');

    // Delivery states the same transition on one line, including the unchanged
    // case: a successor that cannot see it would not know whether the model it
    // is reasoning with is the one that produced the work it inherited.
    const delivered = renderRebirthPackageV6WithReport(withRuntime, DELIVERY).text;
    // Same vocabulary in both modes: one fact, one grammar.
    expect(delivered).toContain('Runtime codex/gpt-5.5 → codex/gpt-5.5; changed=no');
  });

  it('renders a nonempty handle verbatim even on a not-requested lane (recover= contract)', () => {
    const model = benchmarkModel();
    const withHandle = buildRebirthPackageV6Model({
      boundaryAndActiveTask: benchmarkModel().boundaryAndActiveTask,
      executionState: benchmarkModel().executionState,
      activeEditDelta: benchmarkModel().activeEditDelta,
      cognitiveArtifacts: benchmarkModel().cognitiveArtifacts,
      recentConversation: benchmarkModel().recentConversation,
      recoveryIndex: [
        {
          id: 'atlas-edit-capture',
          label: 'immutable Atlas edit capture',
          handle: 'atlas_agent_diff instance_id="inst-a" capture_id="c1" mode="unified"',
          status: 'not-requested',
          count: null,
          frontier: 'c1',
          reason: 'sidecar build path did not request an immutable Atlas edit capture',
        },
      ],
      operatorVault: benchmarkModel().operatorVault,
      episodeChapterIndex: benchmarkModel().episodeChapterIndex,
      lifeLedger: benchmarkModel().lifeLedger,
    });
    const { text } = renderRebirthPackageV6WithReport(withHandle, { packageBudget: 150_000 });
    expect(text).toContain('capture_id="c1" mode="unified"');
    expect(text).toContain('- R1 = atlas_agent_diff instance_id="inst-a" capture_id="c1" mode="unified"');
    expect(text).toContain('recover=R1');
  });

  it('keeps final text + envelope within the declared budget even with lint findings', () => {
    // Saturate several self-check rules at once and pin the hard-cap invariant:
    // the rendered package plus its self-check diagnostics must never exceed
    // the declared budget (audit edge: lint must be admitted inside budget, and
    // even when it fits in headroom the final total stays under the cap).
    const over = buildRebirthPackageV6Model({
      boundaryAndActiveTask: benchmarkModel().boundaryAndActiveTask,
      executionState: benchmarkModel().executionState,
      activeEditDelta: benchmarkModel().activeEditDelta,
      cognitiveArtifacts: benchmarkModel().cognitiveArtifacts,
      recentConversation: benchmarkModel().recentConversation,
      recoveryIndex: [
        ...benchmarkModel().recoveryIndex,
        { id: 'dangling', label: 'handoff card (inline body below)', handle: '', status: 'partial' as const, count: 1, frontier: null, reason: 'capture read failed' },
      ],
      cognitiveArtifactCapture: {
        status: 'complete',
        capturedAt: '2026-09-01T21:00:00.000Z',
        totalMatched: 5000,
        overlayCount: 0,
        missingFamilies: ['glyph', 'atlas'],
        warnings: [],
      },
      operatorVault: benchmarkModel().operatorVault,
      episodeChapterIndex: benchmarkModel().episodeChapterIndex,
      lifeLedger: benchmarkModel().lifeLedger,
    });
    // The over model genuinely triggers self-checks (rule 1: families missing
    // while matched; rule 2: dangling inline-body-below label).
    expect(lintPackageSelfChecks(over, 'probe').length).toBeGreaterThan(0);
    const budget = 230_000;
    const { text, collapse } = renderRebirthPackageV6WithReport(over, { packageBudget: budget });
    // The adversarial renderer fixture emits the two expected diagnostics from
    // the real final render, not only from a direct lint helper invocation.
    expect(text).toContain('self-check: cognition lists missing families glyph,atlas while matched=5000');
    expect(text).toContain('self-check: recovery lane dangling labels "inline body below" but carries no inline evidence');
    // ...and final text + envelope never exceed the declared budget.
    expect(text.length).toBeLessThanOrEqual(budget);
    expect(collapse.telemetry.hardOverrunChars).toBe(0);
  });
});

describe('rebirth package self-lint (S2)', () => {
  /** Minimal valid build input; override per-rule to trigger (or not) checks. */
  function lintModel(overrides: Omit<Parameters<typeof buildRebirthPackageV6Model>[0], 'boundaryAndActiveTask' | 'executionState' | 'activeEditDelta' | 'cognitiveArtifacts' | 'recentConversation' | 'recoveryIndex'> & Partial<Pick<Parameters<typeof buildRebirthPackageV6Model>[0], 'boundaryAndActiveTask' | 'executionState' | 'activeEditDelta' | 'cognitiveArtifacts' | 'recentConversation' | 'recoveryIndex' | 'cognitiveArtifactCapture' | 'operatorVault' | 'lifeLedger'>> = {}): { model: RebirthPackageV6Model; render: string } {
    const base = benchmarkModel();
    const input = {
      boundaryAndActiveTask: overrides.boundaryAndActiveTask ?? base.boundaryAndActiveTask,
      executionState: overrides.executionState ?? base.executionState,
      activeEditDelta: overrides.activeEditDelta ?? base.activeEditDelta,
      cognitiveArtifacts: overrides.cognitiveArtifacts ?? base.cognitiveArtifacts,
      recentConversation: overrides.recentConversation ?? base.recentConversation,
      recoveryIndex: overrides.recoveryIndex ?? base.recoveryIndex,
      ...(overrides.cognitiveArtifactCapture
        ? { cognitiveArtifactCapture: overrides.cognitiveArtifactCapture }
        : base.cognitiveArtifactCapture
          ? { cognitiveArtifactCapture: base.cognitiveArtifactCapture }
          : {}),
      ...(overrides.operatorVault ? { operatorVault: overrides.operatorVault } : base.operatorVault ? { operatorVault: base.operatorVault } : {}),
      ...(overrides.lifeLedger ? { lifeLedger: overrides.lifeLedger } : base.lifeLedger ? { lifeLedger: base.lifeLedger } : {}),
    } as Parameters<typeof buildRebirthPackageV6Model>[0];
    const model = buildRebirthPackageV6Model(input);
    const render = renderRebirthPackageV6(model, { packageBudget: 150_000 });
    return { model, render };
  }

  it('healthy model emits no self-check lines (negative for every rule)', () => {
    const { model, render } = lintModel();
    expect(lintPackageSelfChecks(model, render)).toEqual([]);
    expect(render).not.toContain('⚠ self-check:');
  });

  it('flags families listed missing while matched>0 (rule 1)', () => {
    const { model, render } = lintModel({
      cognitiveArtifactCapture: {
        status: 'complete',
        capturedAt: '2026-09-01T21:00:00.000Z',
        totalMatched: 1043,
        overlayCount: 0,
        missingFamilies: ['glyph'],
        warnings: [],
      },
    });
    const checks = lintPackageSelfChecks(model, render);
    expect(checks.some((c) => c.includes('missing families glyph') && c.includes('matched=1043'))).toBe(true);
  });

  it('flags an inline-body-below label with no body (rule 2)', () => {
    const { model, render } = lintModel({
      recoveryIndex: [
        ...benchmarkModel().recoveryIndex,
        { id: 'atlas-handoff-card-test', label: 'captured Atlas handoff card (inline body below)', handle: 'atlas_query action="history"', status: 'available' as const, count: 1, frontier: null },
      ],
    });
    const checks = lintPackageSelfChecks(model, render);
    expect(checks.some((c) => c.includes('inline body below') && c.includes('no inline evidence'))).toBe(true);
  });

  it('flags a life rollup containing the head life (rule 3)', () => {
    const { model } = lintModel({
      lifeLedger: lineage([
        unit({ id: 'life:head', kind: 'life', sourceAt: '2026-09-01T21:17:27.184Z', sourceEndAt: '2026-09-01T21:19:42.460Z' }),
      ]),
    });
    // Rule 3 inspects the RENDERED text's rollup line; pass a synthetic broken render.
    const checks = lintPackageSelfChecks(model, '[ROLLUP kind=life n=1 span=2026-09-01T20:00:00.000Z..2026-09-01T21:30:00.000Z]');
    expect(checks.some((c) => c.includes('life rollup') && c.includes('contains the head life'))).toBe(true);
  });

  it('flags a next_action predating the active request it derives from (rule 4)', () => {
    const { model, render } = lintModel({
      executionState: {
        facts: [
          {
            provenanceId: 'receipt-next_action:bad',
            sourceAt: '2026-09-01T20:47:51.900Z',
            status: 'exact',
            kind: 'next_action',
            text: 'Implement rail-ce32a922 S1, S2, renderer portions.',
          },
        ],
        unknownReasons: [],
      },
    });
    const checks = lintPackageSelfChecks(model, render);
    expect(checks.some((c) => c.includes('derived row predates its source'))).toBe(true);
  });

  // Rule 5 scopes to what the delivered text actually renders as chronology.
  // The risk is positional: an undated row inside a rendered stream implies an
  // order it cannot support. A unit that is addressed but never ordered carries
  // no such risk, so the rule must fire on the first and stay silent on the
  // second — otherwise a permanent false positive teaches successors to read a
  // real banner as noise.
  const RULE_5 = (c: string): boolean => c.includes('unknown source time') && c.includes('no quarantine banner');
  const SECTION = (id: string): string => `[REBIRTH-V6-SECTION id=${id} order=1 chars=10]`;

  it('flags undated units inside a RENDERED lineage section with no quarantine banner (rule 5)', () => {
    const { model } = lintModel({
      operatorVault: lineage([unit({ id: 'op:unknown', sourceAt: null, kind: 'operator' })]),
    });
    expect(lintPackageSelfChecks(model, SECTION('operatorVault')).some(RULE_5)).toBe(true);
  });

  it('flags an undated TIMELINE row with no quarantine banner (rule 5)', () => {
    // The section unification made the Timeline the chronology. Before it, this
    // rule watched only the lineage sections, so the one section that can
    // genuinely mis-order an undated row was the one it never looked at.
    const { model } = lintModel({
      recentConversation: [
        {
          provenanceId: 'raw-trace-conversation:undated',
          sourceAt: null,
          role: 'user' as const,
          text: 'undated turn',
        },
      ],
    });
    expect(lintPackageSelfChecks(model, SECTION('recentConversation')).some(RULE_5)).toBe(true);
  });

  it('stays silent for undated units in a section relocated to the ledger (rule 5 negative)', () => {
    // D2 relocates operatorVault/episodeChapterIndex/lifeLedger: their units are
    // ledger-addressable, never rendered in order. No body, no chronology risk.
    const { model } = lintModel({
      operatorVault: lineage([unit({ id: 'op:unknown', sourceAt: null, kind: 'operator' })]),
    });
    const relocated = `${SECTION('boundaryAndActiveTask')}\n${SECTION('recoveryIndex')}`;
    expect(lintPackageSelfChecks(model, relocated).some(RULE_5)).toBe(false);
  });

  it('stays silent when the quarantine banner is present (rule 5 negative)', () => {
    const { model } = lintModel({
      operatorVault: lineage([unit({ id: 'op:unknown', sourceAt: null, kind: 'operator' })]),
    });
    const banner = `${SECTION('operatorVault')}\nUnknown source time (quarantined; not part of the chronology):`;
    expect(lintPackageSelfChecks(model, banner).some(RULE_5)).toBe(false);
  });

  it('never exceeds the hard cap when zero lint headroom is available (withSelfLint zero-boundary)', () => {
    // A self-lint-triggering model (rule 1 + rule 2 fire together).
    const over = buildRebirthPackageV6Model({
      boundaryAndActiveTask: benchmarkModel().boundaryAndActiveTask,
      executionState: benchmarkModel().executionState,
      activeEditDelta: benchmarkModel().activeEditDelta,
      cognitiveArtifacts: benchmarkModel().cognitiveArtifacts,
      recentConversation: benchmarkModel().recentConversation,
      recoveryIndex: [
        ...benchmarkModel().recoveryIndex,
        { id: 'dangling', label: 'handoff card (inline body below)', handle: '', status: 'partial' as const, count: 1, frontier: null, reason: 'capture read failed' },
      ],
      cognitiveArtifactCapture: {
        status: 'complete',
        capturedAt: '2026-09-01T21:00:00.000Z',
        totalMatched: 5000,
        overlayCount: 0,
        missingFamilies: ['glyph', 'atlas'],
        warnings: [],
      },
      operatorVault: benchmarkModel().operatorVault,
      episodeChapterIndex: benchmarkModel().episodeChapterIndex,
      lifeLedger: benchmarkModel().lifeLedger,
    });
    expect(lintPackageSelfChecks(over, 'probe').length).toBeGreaterThan(0);
    // Budget = exact base render length ⇒ zero headroom for the lint header.
    // withSelfLint must append NOTHING (return the original text unchanged),
    // so final text stays exactly at budget — never exceeding the cap.
    const baseLen = renderRebirthPackageV6(over, { packageBudget: 230_000 }).length;
    const zeroHeadroom = renderRebirthPackageV6WithReport(over, { packageBudget: baseLen });
    // The zero-headroom render's text is exactly the base length (lint added
    // nothing because even the header couldn't fit).
    expect(zeroHeadroom.text.length).toBeLessThanOrEqual(baseLen);
    expect(zeroHeadroom.text.length).toBe(baseLen);
    expect(zeroHeadroom.collapse.telemetry.hardOverrunChars).toBe(0);
  });

  it('stays within budget at the spare boundary where the header fits but a check line does not (withSelfLint spare-boundary)', () => {
    const over = (() => {
      // Same self-lint-triggering model as the zero-boundary test for identical input.
      return buildRebirthPackageV6Model({
        boundaryAndActiveTask: benchmarkModel().boundaryAndActiveTask,
        executionState: benchmarkModel().executionState,
        activeEditDelta: benchmarkModel().activeEditDelta,
        cognitiveArtifacts: benchmarkModel().cognitiveArtifacts,
        recentConversation: benchmarkModel().recentConversation,
        recoveryIndex: [
          ...benchmarkModel().recoveryIndex,
          { id: 'dangling', label: 'handoff card (inline body below)', handle: '', status: 'partial' as const, count: 1, frontier: null, reason: 'capture read failed' },
        ],
        cognitiveArtifactCapture: {
          status: 'complete',
          capturedAt: '2026-09-01T21:00:00.000Z',
          totalMatched: 5000,
          overlayCount: 0,
          missingFamilies: ['glyph', 'atlas'],
          warnings: [],
        },
        operatorVault: benchmarkModel().operatorVault,
        episodeChapterIndex: benchmarkModel().episodeChapterIndex,
        lifeLedger: benchmarkModel().lifeLedger,
      });
    })();
    const baseLen = renderRebirthPackageV6(over, { packageBudget: 230_000 }).length;
    // Allocate enough budget for the header plus a fraction, but not a full check
    // line: verify every appended byte stays admission-checked and final <= cap.
    for (const slack of [10, 30, 80]) {
      const budget = baseLen + slack;
      const { text, collapse } = renderRebirthPackageV6WithReport(over, { packageBudget: budget });
      expect(text.length).toBeLessThanOrEqual(budget);
      expect(collapse.telemetry.hardOverrunChars).toBe(0);
      // Whatever self-check text was admitted, no byte escaped the cap.
      const matches = text.match(/self-check/g);
      if (matches) expect(text.length).toBeLessThanOrEqual(budget);
    }
  });
});

describe('metadata density metric (rail-72adf723 S27)', () => {
  it('separates decoration from a fact row\'s own content on a REAL render', () => {
    // Measured against a real render of the benchmark model, never a synthetic
    // string: the whole point of the metric is how the renderer's own grammar
    // distributes decoration, which a hand-written fixture cannot exercise.
    const rendered = renderRebirthPackageV6(benchmarkModel());
    const density = measureRebirthPackageMetadataDensity(rendered);

    expect(density.sections.length).toBeGreaterThan(0);
    for (const section of density.sections) {
      expect(section.ratio).toBeGreaterThanOrEqual(0);
      expect(section.ratio).toBeLessThanOrEqual(1);
      expect(section.decorationChars).toBeLessThanOrEqual(section.totalChars);
      expect(section.sectionClass).toBe(
        REBIRTH_PACKAGE_PROSE_SECTION_IDS.has(section.sectionId) ? 'prose' : 'structured',
      );
      expect(section.bar).toBe(REBIRTH_PACKAGE_METADATA_RATIO_BARS[section.sectionClass]);
      expect(section.withinBar).toBe(section.ratio <= section.bar);
    }

    // Every prose-bearing section must clear the 0.30 bar the criterion was
    // written for: prose diluted by decoration is the harm.
    for (const section of density.sections.filter((entry) => entry.sectionClass === 'prose')) {
      expect(section.withinBar).toBe(true);
    }
  });

  it('counts an addressing anchor as decoration and a truth label as content', () => {
    // The distinction the old keyed-line heuristic could not make. Both rows
    // carry `key=value`; only one of them is telling you where to look.
    const addressing = measureRebirthPackageMetadataDensity(
      'shipped the allocator fix ⟨rail-72adf723:step-9 @09-09 07:05:32Z⟩',
    ).overall;
    const truthLabel = measureRebirthPackageMetadataDensity(
      '- validation · scoped-vitest: call=completed · outcome=unknown · current-source=unverified',
    ).overall;

    expect(addressing.decorationChars).toBeGreaterThan(0);
    expect(truthLabel.decorationChars).toBe(0);
    expect(truthLabel.ratio).toBe(0);
  });

  it('never double-counts an addressing key that sits inside an anchor', () => {
    const withKeyInsideAnchor = measureRebirthPackageMetadataDensity(
      'row text ⟨source=abc @09-09 10:00:00Z⟩',
    ).overall;
    expect(withKeyInsideAnchor.decorationChars).toBe('⟨source=abc @09-09 10:00:00Z⟩'.length);
  });

  it('is total: an unframed string measures as one package span', () => {
    const plain = measureRebirthPackageMetadataDensity('no section frames here');
    expect(plain.sections).toHaveLength(0);
    expect(plain.overall.sectionId).toBe('package');
    expect(plain.overall.ratio).toBe(0);
    expect(measureRebirthPackageMetadataDensity('').overall.ratio).toBe(0);
  });
});
