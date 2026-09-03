import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildRebirthPackageV6Model,
  lintPackageSelfChecks,
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

describe('rebirth package golden fixture (synthetic renderer model)', () => {
  it('renders deterministically; full-render SHA-256 is frozen', () => {
    const model = benchmarkModel();
    // Determinism: identical input must produce identical output.
    const first = renderRebirthPackageV6WithReport(model, { packageBudget: 150_000 });
    const second = renderRebirthPackageV6WithReport(model, { packageBudget: 150_000 });
    expect(second.text).toBe(first.text);

    const hash = createHash('sha256').update(first.text, 'utf8').digest('hex');
    // Frozen byte-exact hash of the full render. Update deliberately only when
    // the renderer's formatting/honesty output intentionally changes.
    expect(hash).toBe('325abe57801362414be50d9c485fbc02408f5b9fc06b3ebe3e08f08cf26215f3');
  });

  it('renders every section into the framed output', () => {
    const { text } = renderRebirthPackageV6WithReport(benchmarkModel(), { packageBudget: 150_000 });
    for (const marker of [
      '── Boundary and Active Task ──',
      '── Execution State ──',
      '── Active Edit Delta ──',
      '── Cognitive Artifacts ──',
      '── Recent Conversation ──',
      '── Operator Vault ──',
      '── Episode Chapter Index ──',
      '── Life Ledger ──',
      '── Recovery Index ──',
    ]) {
      expect(text, `section ${marker}`).toContain(marker);
    }
    expect([...text.matchAll(/\[REBIRTH-V6-SECTION id=([A-Za-z]+) order=(\d+)(?: dir=\w+)? chars=\d+\]/gu)]
      .map((match) => `${match[1]}:${match[2]}`)).toEqual([
      'boundaryAndActiveTask:1',
      'executionState:3',
      'activeEditDelta:4',
      'cognitiveArtifacts:5',
      'recentConversation:6',
      'operatorVault:7',
      'episodeChapterIndex:8',
      'lifeLedger:9',
      'recoveryIndex:10',
    ]);
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
    const { text } = renderRebirthPackageV6WithReport(withReviewDemand, { packageBudget: 150_000 });
    expect(text).toContain('versions=model:rebirth-package-v7/v1 · render:v6-sections · capture-id:naming-v2 · provenance:v1 · frame:rebirth-v6-section');
    expect(text).toContain('capture-partial-lanes=active-edit-delta:not-requested · class-vocabulary=horizon|cap|store|merge|not-requested|unknown');
    expect(text).toContain('vault-newest=2026-09-01T20:47:52.476Z · active-request=2026-09-01T20:47:52.476Z');
    expect(text).toContain('- rail-review-state=independent correction review pending · source=review:bench');
    expect(text).toContain('[EXACT ACTIVE REQUEST · 48 chars · source=msg_active · source-time=2026-09-01T20:47:52.476Z · status=exact]');
    expect(text).toContain('[LAST MATERIAL ASSISTANT · 24 chars · source=msg_last · source-time=2026-09-01T20:48:13.307Z · status=exact]');
  });

  it('renders honest not-requested recovery lanes with their reason (S4/S6 contract)', () => {
    const { text } = renderRebirthPackageV6WithReport(benchmarkModel(), { packageBudget: 150_000 });
    expect(text).toContain('status=not-requested');
    expect(text).toContain('reason=sidecar build path did not request an immutable Atlas edit capture');
    // Empty-handle not-requested lane renders recover=not-requested, never a
    // contradictory recover=unavailable fake handle.
    expect(text).toContain('status=not-requested');
    expect(text).toContain('recover=not-requested');
    // A not-requested capture must not read as an attempted failure.
    expect(text).not.toContain('capture-degraded=active-edit-delta');
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
    const { text } = renderRebirthPackageV6WithReport(chained, { packageBudget: 150_000 });
    expect(text).toContain('lineage-chain=root (inst-root) · 2026-08-24→2026-08-31 · archived');
    expect(text).toContain('worker-a (inst-a) · 2026-09-01→now · live-at-capture');
    expect(text).toContain('ops=git:unknown:worker-git-status-not-captured');
    expect(text).toContain('owned-live-children=continuity-scout(child-1)');
    expect(text).toContain('squad=squad-rebirth · rooms=rebirth-package-levelup');
  });

  it('renders the legacy Runtime Model parity block when runtime-model context is supplied (integration gate)', () => {
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
    const { text } = renderRebirthPackageV6WithReport(withRuntime, { packageBudget: 150_000 });
    // Even an unchanged transition must render the block (parity with legacy).
    expect(text).toContain('── Runtime Model ──');
    expect(text).toContain('Predecessor: codex/gpt-5.5');
    expect(text).toContain('Current/successor: codex/gpt-5.5');
    expect(text).toContain('Changed: no');
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

  it('flags unknown-time rows rendered without a quarantine banner (rule 5)', () => {
    const { model } = lintModel({
      operatorVault: lineage([unit({ id: 'op:unknown', sourceAt: null, kind: 'operator' })]),
    });
    const checks = lintPackageSelfChecks(model, 'no quarantine banner in this text');
    expect(checks.some((c) => c.includes('unknown source time') && c.includes('no quarantine banner'))).toBe(true);
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
