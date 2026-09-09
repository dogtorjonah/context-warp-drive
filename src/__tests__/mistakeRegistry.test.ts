import { describe, expect, it } from 'vitest';
import {
  buildRebirthPackageV6Model,
  renderRebirthPackageV6,
  renderRebirthPackageV6WithReport,
  type RebirthPackageV6Model,
} from '../rebirthPackageV6.ts';

/**
 * MISTAKE REGISTRY — executable form of docs/rebirth-package-archaeology-2026-09-09.md.
 *
 * Every entry here is something this package ALREADY had, already hurt someone,
 * and was already removed for a reason. The archaeology doc explains why; this
 * file makes reintroducing it fail. Each test names its changelog so a future
 * agent who trips one can read the original decision instead of guessing
 * whether the assertion is arbitrary.
 *
 * Adding an entry is cheap. Deleting one requires the same standard the
 * original removal met: evidence that the behaviour is wanted again.
 *
 * Four registry entries are pinned in their own suites rather than duplicated
 * here, because a second weaker copy of a strong test is worse than a pointer:
 *   - #43079 vs #41353 phase cap binds over water-fill → rebirthTimeline.test.ts
 *     'reserves 145k content and gives idle execution surplus to the timeline'
 *   - dialogue rows are not governed by the cognition per-row cap →
 *     rebirthTimeline.test.ts 'interleaves dialogue and durable units once'
 *   - ownership fuzz at the runtime vault/tail-epoch boundary →
 *     relay/src/__tests__/tailEpochOwnership.test.ts and userMessageVault.test.ts
 *   - telemetry field-by-field parity in the diagnostic render →
 *     telemetryOutOfPrompt.test.ts (this file pins only its absence from the prompt)
 */
const at = (minute: number) => `2026-09-09T04:${String(minute).padStart(2, '0')}:00.000Z`;

/**
 * A capture that PROVED zero attributable edits — distinct from a capture that
 * never ran. The renderer treats the two differently on purpose (#1127), so the
 * fixture has to state the complete shape rather than a convenient subset.
 */
const provenZeroEdits = () => ({
  state: 'none' as const,
  captureId: 'registry-edit-capture',
  capturedSourceAt: at(25),
  completedObservedAt: at(25),
  files: [],
  omittedFiles: 0,
  truncated: false,
  inheritedCaptureIds: [],
  reasons: [],
});

function model(
  overrides: Partial<Parameters<typeof buildRebirthPackageV6Model>[0]> = {},
): RebirthPackageV6Model {
  return buildRebirthPackageV6Model({
    boundaryAndActiveTask: {
      lifecycle: 'continuation',
      lifecycleMeaning: 'same instance identity; new session continuation',
      captureId: 'mistake-registry',
      capturedAt: at(30),
      sourceFrontier: 'event-9',
      instanceId: 'registry-self',
      instanceName: 'registry-self',
      predecessorInstanceId: null,
      predecessorName: 'registry-self',
      workspace: 'voxxo-swarm',
      cwd: '/workspace',
      runtimeChange: null,
      activeRequest: {
        text: 'REGISTRY ACTIVE REQUEST BODY',
        chars: 28,
        source: { provenanceId: 'message:user-1', sourceAt: at(1), status: 'exact' },
      },
      lastMaterialAssistant: {
        text: 'REGISTRY LAST ASSISTANT BODY',
        chars: 28,
        source: { provenanceId: 'message:assistant-1', sourceAt: at(2), status: 'exact' },
      },
    },
    executionState: {
      facts: [{
        provenanceId: 'rail:one',
        sourceAt: at(6),
        status: 'exact',
        kind: 'rail',
        text: 'rail-registry · active',
      }],
      unknownReasons: [],
    },
    recentConversation: [
      { provenanceId: 'message:user-1', sourceAt: at(1), role: 'user', text: 'REGISTRY ACTIVE REQUEST BODY', exchangeId: 'x1' },
      { provenanceId: 'message:assistant-1', sourceAt: at(2), role: 'assistant', text: 'REGISTRY LAST ASSISTANT BODY', exchangeId: 'x1' },
    ],
    cognitiveArtifacts: [{
      provenanceId: 'chat:own',
      sourceInstanceId: 'registry-self',
      sourceAt: at(3),
      kind: 'decision',
      authority: 'evidence',
      supersededBy: null,
      text: 'OWN DURABLE DECISION',
    }],
    ...overrides,
  });
}

/**
 * Rail state is a STRUCTURED now-card fact, never parsed out of a fact's prose.
 * The idle behaviours key on this, so a fixture that only writes 'complete'
 * into fact text is not exercising them.
 */
const terminalRailNowCard = () => ({
  forkPurpose: null,
  parentIdentity: null,
  parentStatus: null,
  currentRail: {
    railId: 'rail-registry',
    state: 'complete' as const,
    activeStepId: null,
    activeStepStatus: null,
    source: { provenanceId: 'rail-capture', sourceAt: at(20), status: 'exact' as const },
  },
  currentRailAvailability: null,
});

const rendered = (m: RebirthPackageV6Model = model()) => renderRebirthPackageV6(m);

describe('mistake registry (docs/rebirth-package-archaeology-2026-09-09.md)', () => {
  it('#934 — carries no advice prose: the package is evidence, not a reading guide', () => {
    const text = rendered();
    for (const retired of [
      'Reading Guide',
      'Signposts',
      'Warm Continuity',
      'Rebirth History',
      'How to use this package',
    ]) {
      expect(text, `${retired} was removed in #934 because the agent had to read it every life`)
        .not.toContain(retired);
    }
  });

  it('#1127 — a finished task never lingers as a contextless instruction', () => {
    const idle = model({
      boundaryAndActiveTask: { ...model().boundaryAndActiveTask, nowCard: terminalRailNowCard() },
      executionState: {
        facts: [{
          provenanceId: 'rail:done',
          sourceAt: at(6),
          status: 'exact',
          kind: 'rail',
          text: 'rail-registry · complete',
        }],
        unknownReasons: [],
      },
      activeEditDelta: provenZeroEdits(),
    });
    const text = rendered(idle);
    // "Active Obligations" carried completed work forward as if it were pending.
    expect(text).not.toContain('Active Obligations');
    // The quiet state is stated as a fact instead of an unexplained silence.
    expect(text).toMatch(/no active task|no active rail/u);
  });

  it('#212 — never nests a package inside a package', () => {
    const text = rendered();
    expect((text.match(/\[CONTEXT REBIRTH\]/gu) ?? []).length).toBeLessThanOrEqual(1);
    expect((text.match(/\[FACTUAL NOW CARD/gu) ?? []).length).toBeLessThanOrEqual(1);
    expect((text.match(/\[CONTINUATION RECORD/gu) ?? []).length).toBeLessThanOrEqual(1);
  });

  it('#42771 — recall is push; the package advertises no pull handle', () => {
    const text = rendered();
    expect(text).not.toContain('fold_recall');
    // The legend states the push contract explicitly rather than leaving the
    // agent to infer that nothing needs asking for.
    expect(text).toMatch(/touch|push/iu);
  });

  it('#37221/#37226 — unknown source time is quarantined, never ordered as chronology', () => {
    const withUnknown = model({
      executionState: {
        facts: [
          { provenanceId: 'rail:one', sourceAt: at(6), status: 'exact', kind: 'rail', text: 'rail-registry · active' },
          { provenanceId: 'fact:undated', sourceAt: null, status: 'partial', kind: 'blocker', text: 'UNDATED BLOCKER' },
        ],
        unknownReasons: [],
      },
    });
    const text = renderRebirthPackageV6(withUnknown, { diagnostic: true });
    expect(text).toContain('UNDATED BLOCKER');
    // Present, but explicitly outside the chronology — not silently sorted in.
    expect(text).toMatch(/[Uu]nknown source time|@unknown/u);
  });

  it('#37479 — the active request body renders exactly once', () => {
    const text = rendered();
    expect((text.match(/REGISTRY ACTIVE REQUEST BODY/gu) ?? []).length).toBe(1);
  });

  it('identity bleed — a foreign-authored row is never promoted as this instance\'s own', () => {
    const polluted = model({
      cognitiveArtifacts: [
        { provenanceId: 'chat:own', sourceInstanceId: 'registry-self', sourceAt: at(3), kind: 'decision', authority: 'evidence', supersededBy: null, text: 'OWN DURABLE DECISION' },
        { provenanceId: 'chat:foreign', sourceInstanceId: 'someone-else', sourceAt: at(20), kind: 'decision', authority: 'evidence', supersededBy: null, text: 'FOREIGN DECISION BODY' },
        { provenanceId: 'chat:anon', sourceAt: at(21), kind: 'decision', authority: 'evidence', supersededBy: null, text: 'UNKNOWN AUTHOR DECISION' },
      ] as never,
    });
    const text = rendered(polluted);
    // Newer foreign/unknown-author rows must not win the continuation record's
    // latest-decision slot just because they are newer.
    expect(text).not.toContain('Latest decision: FOREIGN DECISION BODY');
    expect(text).not.toContain('Latest decision: UNKNOWN AUTHOR DECISION');
    expect(text).toContain('Latest decision: OWN DURABLE DECISION');
    // The foreign rows still render as EVIDENCE in the timeline under their own
    // source ids — the defect was promoting them to this instance's authority,
    // never their presence as attributed history.
    expect(text).toContain('FOREIGN DECISION BODY');
    expect(text).toContain('⟨chat:foreign @');
  });

  it('telemetry — build instrumentation stays out of the delivered prompt', () => {
    const text = rendered();
    for (const token of ['built-by=', 'request-prep=', 'unaccounted=', 'capture-partial-lanes=']) {
      expect(text, `${token} belongs to the operator's audit surface, not the agent's attention`)
        .not.toContain(token);
    }
  });

  it('density — provenance metadata stays a minority of what the agent reads', () => {
    const text = rendered();
    const anchors = text.match(/⟨[^⟩\n]*⟩/gu) ?? [];
    const anchorChars = anchors.reduce((sum, anchor) => sum + anchor.length, 0);
    expect(anchorChars / Math.max(1, text.length)).toBeLessThanOrEqual(0.3);
  });

  it('whole units — a rendered unit is never a mid-word fragment', () => {
    const text = rendered();
    // Bodies are clipped at boundaries with an explicit marker, never severed
    // silently mid-identifier the way the audited specimen's endpoint row was.
    for (const line of text.split('\n')) {
      if (line.startsWith('[') || line.includes('…')) continue;
      expect(line).not.toMatch(/\b[a-z]+-$/u);
    }
  });
});

describe('docs match the renderer', () => {
  it('every section heading documented in context-folding.md is one the renderer emits', () => {
    // docs/context-folding.md → "Shipped package layout" lists these as the
    // exact renderer strings. Prose can read stale without anyone noticing;
    // a heading that stops matching fails here instead.
    const documented = [
      '── Boundary and Active Task ──',
      '── Execution State ──',
      '── Active Edit Delta ──',
      '── Timeline ──',
      '── Recovery Index ──',
    ];
    const text = rendered();
    for (const heading of documented) {
      expect(text, `${heading} is documented as a renderer string`).toContain(heading);
    }
  });

  it('the package advertises push recall and never a callable handle', () => {
    // Criterion for S18: no shipped surface may tell an agent to ask for recall.
    const text = rendered();
    expect(text).not.toContain('fold_recall');
    expect(text).toContain('Path touches push relevant source context automatically.');
  });
});

describe('mode goldens are byte-stable across two renders of the same model', () => {
  const modes: ReadonlyArray<readonly [string, () => RebirthPackageV6Model]> = [
    ['rail-active', () => model()],
    ['rail-complete/idle', () => model({
      boundaryAndActiveTask: { ...model().boundaryAndActiveTask, nowCard: terminalRailNowCard() },
      executionState: {
        facts: [{ provenanceId: 'rail:done', sourceAt: at(6), status: 'exact', kind: 'rail', text: 'rail-registry · complete' }],
        unknownReasons: [],
      },
      activeEditDelta: provenZeroEdits(),
    })],
    ['brain-merge', () => model({
      boundaryAndActiveTask: {
        ...model().boundaryAndActiveTask,
        lifecycle: 'brain_merge',
        lifecycleMeaning: 'absorbed donor lineage',
      },
    })],
  ];

  it.each(modes)('%s renders identically twice', (_mode, build) => {
    const first = renderRebirthPackageV6WithReport(build()).text;
    const second = renderRebirthPackageV6WithReport(build()).text;
    // A package that differs between two renders of the same model cannot be
    // diffed across lives, so no drift investigation can ever be conclusive.
    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(0);
  });
});
