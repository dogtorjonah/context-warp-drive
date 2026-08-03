import { describe, expect, it } from 'vitest';
import { buildContinuityReceipt } from '../continuityReceipt.ts';
import { buildRawHardEpochSeed } from '../foldFreeze.ts';
import {
  REBIRTH_PACKAGE_V6_SECTION_IDS,
  adaptLegacyRebirthPackageToV6,
  adaptRebirthPackageV6SectionsToLegacyKeys,
  buildRebirthPackageV6Model,
  renderRebirthPackageV6,
  renderRebirthPackageV6Sections,
  type RebirthPackageV6ActiveEditDelta,
  type RebirthPackageV6Model,
} from '../rebirthPackageV6.ts';

function exactDelta(
  overrides: Partial<RebirthPackageV6ActiveEditDelta> = {},
): RebirthPackageV6ActiveEditDelta {
  return {
    captureId: 'atlas-edit-capture:v1:abc',
    state: 'exact',
    capturedSourceAt: '2026-08-02T18:00:00.000Z',
    completedObservedAt: '2026-08-02T18:00:00.100Z',
    inheritedCaptureIds: [],
    files: [{
      provenanceId: 'edit-file:one',
      sourceAt: '2026-08-02T17:59:00.000Z',
      filePath: 'src/example.ts',
      changeKind: 'modified',
      baselineQuality: 'exact',
      ownership: 'mine',
      state: 'open',
      insertions: 2,
      deletions: 1,
      validationState: 'pending',
      closureState: 'open',
      contributors: [{
        provenanceId: 'contributor:one',
        instanceId: 'instance-a',
        relation: 'owner',
        sourceAt: '2026-08-02T17:59:00.000Z',
      }],
      preview: {
        text: '@@ -1 +1 @@\n-old\n+new',
        complete: true,
        omittedHunks: 0,
        omittedLines: 0,
      },
      diffHandle: 'atlas_agent_diff instance_id="instance-a" capture_id="atlas-edit-capture:v1:abc" mode="unified"',
      snapshotHandle: 'atlas_snapshot file_path="src/example.ts" capture_id="atlas-edit-capture:v1:abc"',
      reason: null,
    }],
    omittedFiles: 0,
    truncated: false,
    reasons: [],
    ...overrides,
  };
}

function model(
  overrides: Partial<Parameters<typeof buildRebirthPackageV6Model>[0]> = {},
): RebirthPackageV6Model {
  return buildRebirthPackageV6Model({
    boundaryAndActiveTask: {
      lifecycle: 'continuation',
      lifecycleMeaning: 'same instance identity; new session continuation',
      captureId: 'capture-1',
      capturedAt: '2026-08-02T18:00:00.000Z',
      sourceFrontier: 'event-9',
      instanceId: 'instance-a',
      instanceName: 'worker-a',
      predecessorInstanceId: null,
      predecessorName: 'worker-a',
      workspace: 'voxxo-swarm',
      cwd: '/workspace',
      runtimeChange: null,
      activeRequest: {
        text: 'Implement the frozen v6 contract.',
        chars: 33,
        source: {
          provenanceId: 'message:user-1',
          sourceAt: '2026-08-02T17:58:00.000Z',
          status: 'exact',
        },
      },
      lastMaterialAssistant: {
        text: 'I will implement it now.',
        chars: 24,
        source: {
          provenanceId: 'message:assistant-1',
          sourceAt: '2026-08-02T17:58:30.000Z',
          status: 'exact',
        },
      },
    },
    executionState: {
      facts: [{
        provenanceId: 'rail:one',
        sourceAt: '2026-08-02T17:59:30.000Z',
        status: 'exact',
        kind: 'rail',
        text: 'rail-one · model step active',
      }],
      unknownReasons: [],
    },
    activeEditDelta: exactDelta(),
    cognitiveArtifacts: [{
      provenanceId: 'decision:one',
      sourceAt: '2026-08-02T17:59:40.000Z',
      kind: 'decision',
      text: 'Use one immutable model.',
      authority: 'current',
      supersededBy: null,
    }],
    recentConversation: [{
      provenanceId: 'message:user-1',
      sourceAt: '2026-08-02T17:58:00.000Z',
      role: 'user',
      text: 'Implement the frozen v6 contract.',
    }, {
      provenanceId: 'message:assistant-1',
      sourceAt: '2026-08-02T17:58:30.000Z',
      role: 'assistant',
      text: 'I will implement it now.',
    }, {
      provenanceId: 'message:user-older',
      sourceAt: '2026-08-02T17:57:00.000Z',
      role: 'user',
      text: 'Keep Atlas semantics stable.',
    }],
    recoveryIndex: [{
      id: 'transcript',
      label: 'transcript',
      handle: 'tap_instance_messages action="canonical" target_instance_id="instance-a"',
      status: 'available',
      count: null,
      frontier: 'event-9',
    }, {
      id: 'atlas-edit-capture',
      label: 'edit capture',
      handle: 'atlas_agent_diff instance_id="instance-a" capture_id="atlas-edit-capture:v1:abc" mode="unified"',
      status: 'available',
      count: 1,
      frontier: 'atlas-edit-capture:v1:abc',
    }, {
      id: 'rebirth-package',
      label: 'package',
      handle: 'tap_instance_messages action="rebirth" target_instance_id="instance-a" search="capture-1"',
      status: 'available',
      count: null,
      frontier: 'capture-1',
    }],
    ...overrides,
  });
}

describe('Rebirth Package v6', () => {
  it('renders the fixed six-section order and de-duplicates promoted dialogue', () => {
    const value = model();
    const sections = renderRebirthPackageV6Sections(value);
    expect(sections.map((section) => section.id)).toEqual(REBIRTH_PACKAGE_V6_SECTION_IDS);

    const rendered = renderRebirthPackageV6(value);
    expect(rendered.match(/Implement the frozen v6 contract\./gu)).toHaveLength(1);
    expect(rendered.match(/I will implement it now\./gu)).toHaveLength(1);
    expect(rendered).toContain('Keep Atlas semantics stable.');
    for (let index = 1; index < sections.length; index += 1) {
      expect(rendered.indexOf(sections[index - 1].text))
        .toBeLessThan(rendered.indexOf(sections[index].text));
    }
  });

  it('omits Recent Conversation when every row was promoted', () => {
    const value = model({
      recentConversation: [{
        provenanceId: 'message:user-1',
        sourceAt: null,
        role: 'user',
        text: 'Implement the frozen v6 contract.',
      }],
    });
    expect(renderRebirthPackageV6Sections(value).map((section) => section.id))
      .not.toContain('recentConversation');
  });

  it('de-duplicates promoted dialogue wrapped by the legacy transcript renderer', () => {
    const activeRequest = 'Finish the interrupted migration now.';
    const lastAssistant = 'role:assistant\ncontent:\nI am finishing the interrupted migration.';
    const value = adaptLegacyRebirthPackageToV6({
      lifecycleBoundary: 'same_instance_hard_epoch',
      triggeringUserMessage: activeRequest,
      lastUserAiMessages: `🤖 LAST AI MESSAGE:\n${lastAssistant}`,
      currentThread: [
        `[message 126] 👤 USER:\nrole:user\ncontent:\n[2026-08-02 21:59] ${activeRequest}`,
        `[message 127] 🤖 YOU:\n${lastAssistant}`,
        '[message 124] 👤 USER:\nrole:user\ncontent:\n[2026-08-02 21:57] Keep this older request.',
      ].join('\n\n'),
    });

    const rendered = renderRebirthPackageV6(value);
    expect(rendered.match(/Finish the interrupted migration now\./gu)).toHaveLength(1);
    expect(rendered.match(/I am finishing the interrupted migration\./gu)).toHaveLength(1);
    expect(rendered).toContain('Keep this older request.');
  });

  it('de-duplicates a promoted request wrapped only by the dialogue header envelope', () => {
    // Real raw-seed current-thread rows carry no inner role:/content: wrapper —
    // just `[message N] 👤 USER:` above the exact message bytes. Before this
    // case the provider received the live operator request twice.
    const activeRequest = 'Okay, finish on what needs finishing now.';
    const value = adaptLegacyRebirthPackageToV6({
      lifecycleBoundary: 'same_instance_hard_epoch',
      triggeringUserMessage: activeRequest,
      currentThread: [
        `[message 126] 👤 USER:\n${activeRequest}`,
        '[message 127] 🤖 YOU:\nWorking on it.',
        '[message 124] 👤 USER:\nKeep this older request.',
      ].join('\n\n'),
    });

    const rendered = renderRebirthPackageV6(value);
    expect(rendered.match(/Okay, finish on what needs finishing now\./gu)).toHaveLength(1);
    expect(rendered).toContain('Keep this older request.');
    expect(rendered).toContain('Working on it.');
  });

  it('keeps ordinary prose that merely precedes a blank line', () => {
    const value = adaptLegacyRebirthPackageToV6({
      lifecycleBoundary: 'continuation',
      triggeringUserMessage: 'Shared trailing sentence.',
      currentThread: 'Some heading:\nShared trailing sentence.',
    });
    // The row's header is not a dialogue envelope, so the row survives intact
    // alongside the promoted request rather than being erased by a loose match.
    expect(value.recentConversation).toHaveLength(1);
    expect(value.recentConversation[0].text).toContain('Some heading:');
  });

  it('never turns unavailable edit evidence into none', () => {
    const legacy = adaptLegacyRebirthPackageToV6({
      predecessorName: 'legacy',
      currentThread: '',
      activeEditDelta: '',
    });
    expect(legacy.activeEditDelta.state).toBe('unknown');
    expect(renderRebirthPackageV6(legacy)).toContain(
      'Active edit state is unknown; absence of evidence is not rendered as none.',
    );

    const none = model({
      activeEditDelta: exactDelta({
        state: 'none',
        files: [],
      }),
    });
    expect(renderRebirthPackageV6(none)).toContain(
      'Exact immutable capture proved zero open attributable diffs.',
    );
  });

  it('publishes only executable recovery commands and marks unexposed stores unavailable', () => {
    const continuityReceipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'worker-a',
      capturedAt: '2026-08-02T18:00:00.000Z',
      captureSourceId: 'capture-1',
      instance: {
        instanceId: 'instance-a',
        instanceName: 'worker-a',
        runtimeStatus: 'working',
      },
    });
    const value = adaptLegacyRebirthPackageToV6({
      predecessorName: 'worker-a',
      triggeringUserMessage: 'Recover the boundary.',
      continuityReceipt,
    }, {
      instanceId: 'instance-a',
      instanceName: 'worker-a',
      workspace: 'voxxo-swarm',
      activeEditDelta: exactDelta(),
    });
    const handles = new Map(value.recoveryIndex.map((entry) => [entry.id, entry]));

    expect(handles.get('transcript')?.handle)
      .toBe('tap_instance_messages action="canonical" target_instance_id="instance-a"');
    expect(handles.get('cognition')?.handle)
      .toBe('tap_star action="rolodex" instance="instance-a"');
    expect(handles.get('task-rail')?.handle)
      .toBe('task_rail mode="load" operation="detail" instance_id="instance-a"');
    expect(handles.get('atlas-edit-capture')?.handle)
      .toBe('atlas_agent_diff instance_id="instance-a" capture_id="atlas-edit-capture:v1:abc" mode="unified"');
    expect(handles.get('atlas-edit-post-frontier')?.handle)
      .toBe('atlas_agent_diff instance_id="instance-a" capture_id="atlas-edit-capture:v1:abc" include_post_frontier=true mode="unified"');
    expect(handles.get('rebirth-package')?.handle)
      .toBe('tap_instance_messages action="rebirth" target_instance_id="instance-a" search="capture-1"');
    expect(handles.get('context-warp-stores')).toMatchObject({
      status: 'unavailable',
      handle: '',
    });
  });

  it('adapts the canonical continuity receipt without stale field aliases', () => {
    const continuityReceipt = buildContinuityReceipt({
      boundary: 'continuation',
      predecessorName: 'worker-a',
      capturedAt: '2026-08-02T18:00:00.000Z',
      captureSourceId: 'capture-real',
      sourceStatus: 'working',
      instance: {
        instanceId: 'instance-a',
        instanceName: 'worker-a',
        runtimeStatus: 'working',
        parentInstanceId: 'instance-parent',
      },
      activeRequestText: 'Use the typed receipt as the only adapter contract.',
      activeRequestSourceId: 'message:user-real',
      activeRequestSourceTimestamp: '2026-08-02T17:59:50.000Z',
      rail: {
        railId: 'rail-real',
        title: 'Repair v6 continuity',
        state: 'review',
        updatedAt: '2026-08-02T17:59:40.000Z',
        activeStep: {
          id: 'step-real',
          title: 'Preserve receipt facts',
          status: 'needs_review',
          updatedAt: '2026-08-02T17:59:45.000Z',
          instruction: 'Run the canonical adapter regression.',
        },
        queuedStepTitle: 'Ship only after review',
      },
      claims: ['src/claim.ts'],
      editEvidenceFiles: ['src/edit.ts'],
      hasActiveEditDelta: true,
      validationFact: 'canonical adapter regression passed',
      hazards: ['receipt hazard survives'],
      canonicalRange: {
        traceId: 'instance-a',
        eventCount: 42,
        lastEventId: 'event-42',
        lastEventTimestamp: '2026-08-02T17:59:55.000Z',
      },
      rawTailFrontier: {
        traceId: 'instance-a',
        unit: 'event',
        id: 'event-42',
        exactCount: 0,
        sourceTimestamp: '2026-08-02T17:59:55.000Z',
      },
      extraDisagreements: ['typed disagreement survives'],
      chatroomMembership: '[CHATROOM MEMBERSHIP]\nfix-rebirth — worker-a\n[END CHATROOM MEMBERSHIP]',
      subscriptions: ['mention:worker-a'],
      subscriptionsKnown: true,
    });

    const value = adaptLegacyRebirthPackageToV6({ continuityReceipt });

    expect(value.boundaryAndActiveTask).toMatchObject({
      captureId: 'capture-real',
      sourceFrontier: 'event-42',
      instanceId: 'instance-a',
      instanceName: 'worker-a',
      predecessorInstanceId: 'instance-parent',
    });
    expect(value.boundaryAndActiveTask.activeRequest).toMatchObject({
      text: 'Use the typed receipt as the only adapter contract.',
      source: {
        provenanceId: 'message:user-real',
        sourceAt: '2026-08-02T17:59:50.000Z',
        status: 'exact',
      },
    });
    expect(value.executionState.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'runtime', text: 'working' }),
      expect.objectContaining({ kind: 'next_action', text: 'Run the canonical adapter regression.' }),
      expect.objectContaining({ kind: 'claim', text: 'src/claim.ts' }),
      expect.objectContaining({ kind: 'validation', text: 'canonical adapter regression passed' }),
      expect.objectContaining({ kind: 'blocker', text: 'receipt hazard survives' }),
      expect.objectContaining({ kind: 'review', text: 'needs_review' }),
      expect.objectContaining({ kind: 'coordination', text: 'room=fix-rebirth' }),
      expect.objectContaining({ kind: 'coordination', text: 'subscription=mention:worker-a' }),
    ]));
    expect(value.executionState.unknownReasons).toContain('typed disagreement survives');
    expect(value.activeEditDelta.files).toEqual([
      expect.objectContaining({ filePath: 'src/edit.ts', baselineQuality: 'baseline_unknown' }),
    ]);
  });

  it('preserves the newest known conversation rows when the section budget overflows', () => {
    const value = model({
      recentConversation: [{
        provenanceId: 'message:older-oversized',
        sourceAt: '2026-08-02T17:50:00.000Z',
        role: 'user',
        text: `OVERSIZED_OLDER_TURN ${'x'.repeat(15_000)}`,
      }, {
        provenanceId: 'message:second-newest-retained',
        sourceAt: '2026-08-02T17:58:00.000Z',
        role: 'user',
        text: 'SECOND_NEWEST_TURN_MUST_SURVIVE',
      }, {
        provenanceId: 'message:newest-retained',
        sourceAt: '2026-08-02T17:59:59.000Z',
        role: 'assistant',
        text: 'NEWEST_TURN_MUST_SURVIVE',
      }, {
        provenanceId: 'message:unknown-oversized',
        sourceAt: null,
        role: 'runtime',
        text: `UNKNOWN_TIME_MUST_NOT_DISPLACE_RECENCY ${'y'.repeat(15_000)}`,
      }],
    });

    const section = renderRebirthPackageV6Sections(value, {
      sectionMaxChars: { recentConversation: 700 },
    }).find((entry) => entry.id === 'recentConversation');

    expect(section?.complete).toBe(false);
    expect(section?.text).toContain('SECOND_NEWEST_TURN_MUST_SURVIVE');
    expect(section?.text).toContain('NEWEST_TURN_MUST_SURVIVE');
    expect(section?.text).not.toContain('OVERSIZED_OLDER_TURN');
    expect(section?.text).not.toContain('UNKNOWN_TIME_MUST_NOT_DISPLACE_RECENCY');
    expect(section?.text).toContain('1 earlier known-time row omitted');
    expect(section?.text).toContain('1 unknown-time quarantine row omitted');
    expect(section?.text).toContain('source-time-range=2026-08-02T17:50:00.000Z..2026-08-02T17:50:00.000Z');
    expect(section?.text).toContain('retained-from=2026-08-02T17:58:00.000Z');
  });

  it('keeps newest known content ahead of omission metadata under a tiny section cap', () => {
    const value = model({
      recentConversation: [{
        provenanceId: 'message:older-tiny-cap',
        sourceAt: '2026-08-02T17:58:00.000Z',
        role: 'assistant',
        text: `OLDER_TINY_CAP ${'x'.repeat(200)}`,
      }, {
        provenanceId: 'message:newest-tiny-cap',
        sourceAt: '2026-08-02T17:59:59.000Z',
        role: 'user',
        text: `NEWEST_CANARY ${'y'.repeat(200)}`,
      }],
    });

    const section = renderRebirthPackageV6Sections(value, {
      sectionMaxChars: { recentConversation: 128 },
    }).find((entry) => entry.id === 'recentConversation');

    expect(section?.complete).toBe(false);
    expect(section?.text).toContain('NEWEST_CANARY');
    expect(section?.text).not.toContain('OLDER_TINY_CAP');
    expect(section?.text).toContain('latest-tail=omitted');
  });

  it('renders sensitive files without preview bytes or content recovery handles', () => {
    const canary = 'SUPER_SECRET_CANARY';
    const value = model({
      activeEditDelta: exactDelta({
        files: [{
          provenanceId: 'edit-file:secret',
          sourceAt: null,
          filePath: '.env.production',
          changeKind: 'modified',
          baselineQuality: 'withheld_sensitive',
          ownership: 'mine',
          state: 'withheld_sensitive',
          insertions: null,
          deletions: null,
          validationState: 'unknown',
          closureState: 'open',
          contributors: [],
          preview: {
            text: canary,
            complete: true,
            omittedHunks: 0,
            omittedLines: 0,
          },
          diffHandle: 'atlas-agent-diff://must-not-render',
          snapshotHandle: 'atlas-snapshot://must-not-render',
          reason: 'secret-bearing file',
        }],
      }),
    });
    const rendered = renderRebirthPackageV6(value);
    expect(rendered).toContain('.env.production');
    expect(rendered).toContain('sensitive content withheld');
    expect(rendered).not.toContain(canary);
    expect(rendered).not.toContain('must-not-render');
  });

  it('preserves Atlas-landed closure evidence in the Active Edit Delta contract', () => {
    const value = model({
      activeEditDelta: exactDelta({
        files: [{
          ...exactDelta().files[0],
          closureState: 'atlas_landed',
        }],
      }),
    });

    expect(renderRebirthPackageV6(value)).toContain('closure=atlas_landed');
  });

  it('reports every preview and package truncation honestly with recovery', () => {
    const value = model({
      activeEditDelta: exactDelta({
        truncated: true,
        omittedFiles: 3,
        files: [{
          ...exactDelta().files[0],
          preview: {
            text: '@@ visible hunk',
            complete: false,
            omittedHunks: 2,
            omittedLines: 19,
          },
        }],
      }),
    });
    const rendered = renderRebirthPackageV6(value, {
      sectionMaxChars: { cognitiveArtifacts: 80 },
      packageBudget: 2_500,
    });
    expect(rendered).toContain('omitted-hunks=2 omitted-lines=19 recover=atlas_agent_diff instance_id="instance-a" capture_id="atlas-edit-capture:v1:abc" mode="unified"');
    expect(rendered).toContain('omitted-files=3');
    expect(rendered).toContain('REBIRTH-V6-PACKAGE-ELISION');
    expect(rendered).toContain('tap_instance_messages action="rebirth" target_instance_id="instance-a" search="capture-1"');
  });

  it('filters superseded cognition and quarantines unknown-time rows', () => {
    const value = model({
      cognitiveArtifacts: [{
        provenanceId: 'superseded',
        sourceAt: '2026-08-02T17:00:00.000Z',
        kind: 'decision',
        text: 'Old decision',
        authority: 'historical',
        supersededBy: 'current',
      }, {
        provenanceId: 'current',
        sourceAt: '2026-08-02T18:00:00.000Z',
        kind: 'decision',
        text: 'Current decision',
        authority: 'current',
        supersededBy: null,
      }, {
        provenanceId: 'unknown-time',
        sourceAt: null,
        kind: 'hazard',
        text: 'Timestamp unavailable',
        authority: 'current',
        supersededBy: null,
      }, {
        provenanceId: 'flow-old-known',
        sourceAt: '2026-08-02T16:00:00.000Z',
        kind: 'flow',
        text: 'Older known-time flow',
        authority: 'flow',
        supersededBy: null,
      }, {
        provenanceId: 'flow-new-known',
        sourceAt: '2026-08-02T18:00:00.000Z',
        kind: 'flow',
        text: 'Newest live flow item',
        authority: 'flow',
        supersededBy: null,
      }, {
        provenanceId: 'flow-unknown',
        sourceAt: null,
        kind: 'flow',
        text: 'Unknown-time flow not claimed as newest',
        authority: 'flow',
        supersededBy: null,
      }],
    });
    const rendered = renderRebirthPackageV6(value);
    expect(rendered).not.toContain('Old decision');
    expect(rendered).toContain('Current decision');
    // Newest-known-source-time flow wins; an older known-time flow is dropped.
    expect(rendered).not.toContain('Older known-time flow');
    expect(rendered).toContain('Newest live flow item');
    // God Rule 8: unknown-time cognition is quarantined, never surfaced as the
    // "newest" flow — it appears only under the unknown-time banner.
    expect(rendered).toContain('Unknown-time flow not claimed as newest');
    expect(rendered).toContain('Unknown source time (quarantined; not part of the chronology)');
  });

  it('keeps every recovery route alive under its own section cap', () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      id: `route:${index}`,
      label: `recovery route ${index}`,
      handle: 'tap_instance_messages action="canonical" target_instance_id="instance-a"',
      status: 'available' as const,
      count: null,
      frontier: 'event-9',
    }));
    const value = model({
      recoveryIndex: [...many, {
        id: 'rebirth-package',
        label: 'captured package artifact',
        handle: 'tap_instance_messages action="rebirth" target_instance_id="instance-a" search="capture-1"',
        status: 'available',
        count: null,
        frontier: 'capture-1',
      }],
    });
    const rendered = renderRebirthPackageV6(value, {
      sectionMaxChars: { recoveryIndex: 90 },
    });
    // The protected Recovery Index section never truncates into "exact recovery
    // unavailable": overflow elides whole entries and points at an exact
    // recovery handle that carries the complete index. When the overflowing
    // entry itself has an exact handle, that exact handle is preserved (the
    // entry's own recovery route is the most on-point one to keep alive), even
    // though the `rebirth-package` artifact handle is not the first to elide.
    expect(rendered).not.toContain('exact recovery unavailable');
    expect(rendered).toContain('elided for budget; recover the complete index');
    expect(rendered).toContain('tap_instance_messages action="canonical" target_instance_id="instance-a"');
    // A partial section must not report itself complete to manifests/consumers.
    const sections = renderRebirthPackageV6Sections(value, {
      sectionMaxChars: { recoveryIndex: 90 },
    });
    const recoverySection = sections.find((section) => section.id === 'recoveryIndex');
    expect(recoverySection?.complete).toBe(false);
  });

  it('preserves the exact inline-evidence handle on elision with no rebirth-package handle', () => {
    // A retained/adapted model can carry an atlas-handoff-card entry (with a
    // captured card body + exact Atlas handle) while having NO rebirth-package
    // artifact handle. Under a tiny section cap the card body elides, but the
    // overflow fallback must preserve the entry's EXACT Atlas handle rather
    // than degrading to `unavailable` just because there is no package handle.
    const value = model({
      recoveryIndex: [{
        id: 'atlas-handoff-card',
        label: 'captured Atlas handoff card (inline body below)',
        handle: 'atlas_query action="history" workspace="/tmp/parity" author_instance_id="instance-a"',
        status: 'available',
        count: null,
        frontier: null,
        inlineEvidence: '## 🧭 Rebirth Atlas Cards\nConcepts: Atlas Steering Layer\nHazards: src/a.ts:L1 keep stable.',
      }, {
        id: 'transcript',
        label: 'transcript',
        handle: 'tap_instance_messages action="canonical" target_instance_id="instance-a"',
        status: 'available',
        count: null,
        frontier: 'event-9',
      }],
    });
    const sections = renderRebirthPackageV6Sections(value, {
      sectionMaxChars: { recoveryIndex: 80 },
    });
    const recoverySection = sections.find((section) => section.id === 'recoveryIndex');
    const rendered = recoverySection?.text ?? '';
    // The exact Atlas handle — not a generic "unavailable" — must survive the
    // elision, even with no rebirth-package entry in the index.
    expect(rendered).toContain('atlas_query action="history" workspace="/tmp/parity" author_instance_id="instance-a"');
    expect(rendered).not.toContain('exact recovery handle unavailable');
    expect(rendered).not.toContain('exact package artifact unavailable');
    // A partial section must not report itself complete.
    expect(recoverySection?.complete).toBe(false);
  });

  it('separates inherited, local, and shared-contributor edit evidence on a fresh fork', () => {
    const value = model({
      boundaryAndActiveTask: {
        ...model().boundaryAndActiveTask,
        lifecycle: 'fresh_fork',
        lifecycleMeaning: 'new instance identity; predecessor evidence is inherited',
      },
      activeEditDelta: exactDelta({
        inheritedCaptureIds: ['atlas-edit-capture:v1:parent'],
        files: [{
          ...exactDelta().files[0],
          provenanceId: 'edit-file:predecessor',
          filePath: 'shared/module.ts',
          ownership: 'inherited',
          changeKind: 'modified',
          contributors: [{
            provenanceId: 'contributor:predecessor',
            instanceId: 'instance-parent',
            relation: 'owner',
            sourceAt: '2026-08-02T10:00:00.000Z',
          }, {
            provenanceId: 'contributor:post-frontier',
            instanceId: 'instance-a',
            relation: 'later_contributor',
            sourceAt: '2026-08-02T18:05:00.000Z',
          }],
        }, {
          ...exactDelta().files[0],
          provenanceId: 'edit-file:local',
          sourceAt: '2026-08-02T18:02:00.000Z',
          filePath: 'src/local.ts',
          ownership: 'mine',
          contributors: [{
            provenanceId: 'contributor:local',
            instanceId: 'instance-a',
            relation: 'owner',
            sourceAt: '2026-08-02T18:02:00.000Z',
          }],
        }],
      }),
      recoveryIndex: [{
        id: 'atlas-edit-post-frontier',
        label: 'explicit edits observed after the immutable capture frontier',
        handle: 'atlas_agent_diff instance_id="instance-a" capture_id="atlas-edit-capture:v1:abc" include_post_frontier=true mode="unified"',
        status: 'available',
        count: 1,
        frontier: 'atlas-edit-capture:v1:abc',
      }],
    });
    const rendered = renderRebirthPackageV6(value);
    // Fresh-fork lifecycle: inherited evidence is carried from the predecessor.
    expect(rendered).toContain('fresh_fork · new instance identity; predecessor evidence is inherited');
    expect(rendered).toContain('inherited-captures=atlas-edit-capture:v1:parent');
    // Inherited ownership is labeled; shared contributors render a chronology
    // with the later contributor distinct from the inherited owner.
    expect(rendered).toContain('shared/module.ts · inherited · baseline=exact');
    expect(rendered).toContain('instance-parent:owner@2026-08-02T10:00:00.000Z; instance-a:later_contributor@2026-08-02T18:05:00.000Z');
    // Local (post-frontier fork) edits are separated, owned by the new instance.
    expect(rendered).toContain('src/local.ts · mine · baseline=exact');
    expect(rendered).toContain('instance-a:owner@2026-08-02T18:02:00.000Z');
    // The post-frontier recovery route is advertised for edits made after the
    // immutable capture frontier.
    expect(rendered).toContain('atlas-edit-post-frontier');
  });

  it('renders shared contributors with an explicit unknown-time quarantine', () => {
    const value = model({
      activeEditDelta: exactDelta({
        files: [{
          ...exactDelta().files[0],
          provenanceId: 'edit-file:shared',
          filePath: 'src/shared.ts',
          ownership: 'shared',
          contributors: [{
            provenanceId: 'contributor:known',
            instanceId: 'instance-a',
            relation: 'owner',
            sourceAt: '2026-08-02T17:59:00.000Z',
          }, {
            provenanceId: 'contributor:unknown-time',
            instanceId: 'instance-b',
            relation: 'later_contributor',
            sourceAt: null,
          }],
        }],
      }),
    });
    const rendered = renderRebirthPackageV6(value);
    expect(rendered).toContain('src/shared.ts · shared · baseline=exact');
    expect(rendered).toContain('instance-a:owner@2026-08-02T17:59:00.000Z');
    // Unknown-time contributor is quarantined, never merged into the chronology.
    expect(rendered).toContain('unknown-time-quarantine=[instance-b:later_contributor:contributor:unknown-time]');
  });

  it('keeps one model stable across repeated tail-epoch and hard-epoch renders', () => {
    const value = model({
      boundaryAndActiveTask: {
        ...model().boundaryAndActiveTask,
        lifecycle: 'same_instance_hard_epoch',
        lifecycleMeaning: 'same instance identity; provider context reset',
      },
    });
    const baseline = renderRebirthPackageV6(value);
    let rendered = baseline;
    for (let epoch = 0; epoch < 15; epoch += 1) rendered = renderRebirthPackageV6(value);
    expect(rendered).toBe(baseline);
    expect(rendered).toContain('src/example.ts');
    expect(rendered).toContain('same_instance_hard_epoch');
  });

  it('uses the six-section contract for the host-unavailable hard-epoch fallback', () => {
    const rendered = buildRawHardEpochSeed([{
      role: 'user',
      content: 'Keep the Atlas snapshot semantics stable.',
      sourceIdentity: 'message:user-older',
      tsMs: Date.parse('2026-08-02T17:57:00.000Z'),
    }, {
      role: 'assistant',
      content: 'The baseline capture remains immutable.',
      sourceIdentity: 'message:assistant-1',
      tsMs: Date.parse('2026-08-02T17:58:30.000Z'),
    }, {
      role: 'user',
      content: 'Finish the canonical hard-epoch fallback.',
      sourceIdentity: 'message:user-active',
      tsMs: Date.parse('2026-08-02T18:00:00.000Z'),
    }], {
      predecessorName: 'worker-a',
      capturedAt: '2026-08-02T18:00:01.000Z',
    });

    const titles = [
      'Boundary and Active Task',
      'Execution State',
      'Active Edit Delta',
      'Cognitive Artifacts',
      'Recent Conversation',
      'Recovery Index',
    ];
    for (let index = 1; index < titles.length; index += 1) {
      expect(rendered.indexOf(`── ${titles[index - 1]} ──`))
        .toBeLessThan(rendered.indexOf(`── ${titles[index]} ──`));
    }
    // The raw hard-epoch v6 path must carry the same protected boundary
    // envelope the relay rich formatters emit: exactly one [CONTEXT REBIRTH]
    // lifecycle header with the silent directive, plus the chronological
    // provenance clock block, above the six framed sections.
    expect(rendered.match(/\[CONTEXT REBIRTH\]/gu)).toHaveLength(1);
    expect(rendered).toContain('Lifecycle boundary: same_instance_hard_epoch');
    expect(rendered).toContain('Continue silently; do not produce wake-up commentary.');
    expect(rendered).toContain('[Chronological Provenance v1]');
    expect(rendered).toContain('lifecycle=same_instance_hard_epoch');
    expect(rendered.match(/Finish the canonical hard-epoch fallback\./gu)).toHaveLength(1);
    expect(rendered).toContain('Active edit state is unknown; absence of evidence is not rendered as none.');
    expect(rendered).not.toContain('Coordinate Closet');
  });

  it('maps v6 into retained context-package keys without changing profile IDs', () => {
    const legacy = adaptRebirthPackageV6SectionsToLegacyKeys(model());
    expect(Object.keys(legacy).sort()).toEqual([
      'activeEditDelta',
      'atlasCrossRef',
      'currentThread',
      'lastUserAiMessages',
      'starredMoments',
      'taskRailContext',
    ]);
    expect(legacy.lastUserAiMessages).toContain('Boundary and Active Task');
    expect(legacy.activeEditDelta).toContain('Active Edit Delta');
    expect(legacy.atlasCrossRef).toContain('Recovery Index');
  });
});
