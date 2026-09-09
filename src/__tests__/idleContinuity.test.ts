import { describe, expect, it } from 'vitest';
import { buildRebirthPackageV6Model, renderRebirthPackageV6WithReport } from '../rebirthPackageV6.ts';

const at = (minute: number) => `2026-09-09T04:${String(minute).padStart(2, '0')}:00.000Z`;

/**
 * E1 idle continuity.
 *
 * A completed rail with no attributable edits is a real state, not a missing
 * one. The audited specimen rendered a finished task as if it were still in
 * flight, promoted a configuration string into the validation slot, and
 * promoted an ancestor's ruling into the latest-decision slot — three ways of
 * telling a successor something that was never true of it.
 */
const CONFIG_ROW = 'remote type-check: disabled (one-box mode)';
const EVIDENCE_ROW = 'suite 156/156 passed';

function idleModel(overrides: Record<string, unknown> = {}) {
  return buildRebirthPackageV6Model({
    boundaryAndActiveTask: {
      lifecycle: 'continuation',
      lifecycleMeaning: 'same identity',
      captureId: 'idle-fixture',
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
      nowCard: {
        forkPurpose: null,
        parentIdentity: null,
        parentStatus: null,
        currentRail: {
          railId: 'rail-finished',
          state: 'complete',
          activeStepId: null,
          activeStepStatus: null,
          source: { provenanceId: 'rail-capture', sourceAt: at(20), status: 'exact' as const },
        },
        currentRailAvailability: null,
      },
    },
    executionState: {
      facts: [
        // A setting, not an executed check: it must never reach the slot.
        { provenanceId: 'validation:config', sourceAt: at(21), status: 'exact' as const, kind: 'validation' as const, text: CONFIG_ROW },
        { provenanceId: 'validation:real', sourceAt: at(19), status: 'exact' as const, kind: 'validation' as const, text: EVIDENCE_ROW },
        { provenanceId: 'runtime:boot', sourceAt: at(22), status: 'exact' as const, kind: 'runtime' as const, text: 'relay boot=2026-09-09T06:55:49.203Z · newest source commit predates boot · activation=unknown (loaded-source proof unavailable)' },
        { provenanceId: 'pending:assistant', sourceAt: at(18), status: 'exact' as const, kind: 'pending_assistant_action' as const, text: 'Settle the batch and report readiness.' },
      ],
      unknownReasons: [],
    },
    ...overrides,
  });
}

const boundaryOf = (text: string): string => text.slice(
  text.indexOf('[REBIRTH-V6-SECTION id=boundaryAndActiveTask'),
  text.indexOf('[/REBIRTH-V6-SECTION]'),
);

describe('E1 idle continuity', () => {
  it('states no active task, names the finished one, and reports activation', () => {
    const proven = idleModel({
      activeEditDelta: {
        state: 'none' as const,
        captureId: 'edit-capture-1',
        capturedSourceAt: at(23),
        completedObservedAt: at(23),
        files: [],
        omittedFiles: 0,
        truncated: false,
        inheritedCaptureIds: [],
        reasons: [],
      },
    });
    expect(boundaryOf(renderRebirthPackageV6WithReport(proven).text))
      .toContain('Task state: no active task; latest operator request governs.');
    // Absence of evidence is not evidence of absence: an UNKNOWN edit capture
    // keeps the quiet-rail behaviours but must not claim nothing is in flight.
    const head = boundaryOf(renderRebirthPackageV6WithReport(idleModel()).text);
    expect(head).toContain('Task state: no active rail; attributable edit state unknown.');
    expect(head).not.toContain('no active task');
    expect(head).toContain('Last task: rail-finished · complete');
    // The pending-assistant state machine supplies the operation when no tool
    // call is in flight; the runtime fact supplies restart/activation status.
    expect(head).toContain('Pending operation: Settle the batch and report readiness.');
    expect(head).toMatch(/Activation: relay boot=[^\n]*activation=unknown/u);
  });

  it('never promotes a configuration string into the validation slot', () => {
    const head = boundaryOf(renderRebirthPackageV6WithReport(idleModel()).text);
    expect(head).toContain(`Last validation: ${EVIDENCE_ROW}`);
    expect(head).not.toContain(CONFIG_ROW);
    // With config-only evidence the slot is honestly absent, never a promoted
    // setting dressed as a result.
    const configOnly = idleModel({
      executionState: {
        facts: [{ provenanceId: 'validation:config', sourceAt: at(21), status: 'exact' as const, kind: 'validation' as const, text: CONFIG_ROW }],
        unknownReasons: [],
      },
    });
    expect(boundaryOf(renderRebirthPackageV6WithReport(configOnly).text)).not.toContain('Last validation:');
  });

  it('takes latest-decision from this instance, never an ancestor lineage-floor row', () => {
    const value = buildRebirthPackageV6Model({
      ...idleModel(),
      cognitiveArtifacts: [
        { provenanceId: 'chat:self', sourceInstanceId: 'self', sourceAt: at(10), kind: 'decision' as const, authority: 'historical_observation', supersededBy: null, text: 'SELF RULING' },
        // Newer, but kept only by the per-lineage recency floor: ancestor
        // material, exactly the shape that polluted the 09-09 specimen.
        { provenanceId: 'chat:ancestor', sourceAt: at(25), kind: 'decision' as const, authority: 'historical_observation', supersededBy: null, retention: 'lineage-floor' as const, text: 'ANCESTOR RULING' },
      ],
    });
    const head = boundaryOf(renderRebirthPackageV6WithReport(value).text);
    // Ownership alone does not make a closed task's decision current.
    expect(head).not.toContain('Latest decision:');
    expect(renderRebirthPackageV6WithReport(value).text).toContain('SELF RULING');
    expect(head).not.toContain('Latest decision: ANCESTOR RULING');
  });

  it('picks the newest validation by source time, not producer array order', () => {
    // The capture hands facts over in whatever order its producer emitted them.
    // Reading recency off array position is the God Rule 8 failure mode, so the
    // newer row is deliberately placed FIRST here.
    const value = idleModel({
      executionState: {
        facts: [
          { provenanceId: 'validation:new', sourceAt: at(25), status: 'exact' as const, kind: 'validation' as const, text: 'typecheck clean' },
          { provenanceId: 'validation:old', sourceAt: at(19), status: 'exact' as const, kind: 'validation' as const, text: 'suite 12/12 passed' },
        ],
        unknownReasons: [],
      },
    });
    const head = boundaryOf(renderRebirthPackageV6WithReport(value).text);
    expect(head).toContain('Last validation: typecheck clean');
    expect(head).not.toContain('12/12');
  });

  it('collapses the active edit delta to one line when nothing is attributable', () => {
    const { text } = renderRebirthPackageV6WithReport(idleModel());
    const section = text.slice(text.indexOf('[REBIRTH-V6-SECTION id=activeEditDelta'));
    const body = section.slice(section.indexOf('\n') + 1, section.indexOf('[/REBIRTH-V6-SECTION]')).trim();
    expect(body.split('\n').filter((line) => !line.startsWith('reason='))).toHaveLength(1);
    expect(body).toContain('state=');
    expect(body).toMatch(/Exact immutable capture proved zero|Active edit state is unknown/u);
  });
});
