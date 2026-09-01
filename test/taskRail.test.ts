import { describe, expect, it } from 'vitest';

import {
  BlockedSprintError,
  DraftRailError,
  MissingAcceptanceEvidenceError,
  TASK_RAIL_ROLES,
  TASK_RAIL_ROLE_STATUSES,
  TASK_RAIL_TEMPLATE_VERSION,
  abandonDraft,
  ackStep,
  appendSteps,
  attemptMerge,
  computeProgress,
  createDraft,
  createTaskRailStep,
  dedupeModelTargets,
  isDraftEditable,
  isSameModelTarget,
  lockRail,
  parseStepsFileText,
  planStepModelTransition,
  railToTemplate,
  resolveReviewWindow,
  resolveStepModelRoute,
  restoreTaskRail,
  serializeTaskRail,
  shoot,
  sprint,
  startTaskRail,
  templateIndexEntry,
  templateToStepSeeds,
  updateDraftStep,
} from '../src/taskRail.ts';
import type {
  TaskRailMode,
  TaskRailRoleRegistration,
  TaskRailStep,
} from '../src/taskRail.ts';

describe('portable task rail', () => {
  it('supports start → sprint → ack → serialize/restore without relay dependencies', () => {
    const rail = startTaskRail({
      id: 'rail-demo',
      ownerId: 'local-agent',
      title: 'Standalone rail',
      objective: 'Demonstrate portable execution state.',
      locked: true,
      now: '2026-06-17T22:00:00.000Z',
      steps: [
        { id: 's1', instruction: 'Inspect the input.', acceptanceCriteria: ['Input understood'] },
        { id: 's2', instruction: 'Apply the patch.', acceptanceCriteria: ['Patch applied'] },
        { id: 's3', instruction: 'Validate the result.', acceptanceCriteria: ['Validation clean'] },
      ],
    });

    const reservation = sprint(rail, { sprintCount: 2, note: 'local CLI reservation' }, {
      now: '2026-06-17T22:01:00.000Z',
      actorId: 'local-agent',
      actorName: 'Local Agent',
    });

    expect(reservation.steps?.map((step) => [step.id, step.status])).toEqual([
      ['s1', 'active'],
      ['s2', 'in_progress'],
    ]);
    expect(reservation.steps?.map((step) => [step.startedAt, step.updatedAt])).toEqual([
      ['2026-06-17T22:01:00.000Z', '2026-06-17T22:01:00.000Z'],
      ['2026-06-17T22:01:00.000Z', '2026-06-17T22:01:00.000Z'],
    ]);
    expect(reservation.steps?.map((step) => [step.reservedById, step.reservedByName, step.reservedAt])).toEqual([
      ['local-agent', 'Local Agent', '2026-06-17T22:01:00.000Z'],
      ['local-agent', 'Local Agent', '2026-06-17T22:01:00.000Z'],
    ]);
    expect(rail.history.at(-1)?.ts).toBe('2026-06-17T22:01:00.000Z');

    ackStep(rail, 's1', 'done', {
      now: '2026-06-17T22:02:00.000Z',
      evidence: 'unit test evidence',
    });
    ackStep(rail, 's2', 'done', { now: '2026-06-17T22:03:00.000Z' });

    const next = shoot(rail, {}, { now: '2026-06-17T22:04:00.000Z' });
    expect(next.step?.id).toBe('s3');
    expect(next.step?.status).toBe('active');
    expect(next.step?.startedAt).toBe('2026-06-17T22:04:00.000Z');
    expect(next.step?.updatedAt).toBe('2026-06-17T22:04:00.000Z');

    const serialized = serializeTaskRail(rail);
    const restored = restoreTaskRail(JSON.parse(JSON.stringify(serialized)));

    expect(restored.id).toBe('rail-demo');
    expect(restored.steps.map((step) => step.status)).toEqual(['done', 'done', 'active']);
    expect(computeProgress(restored.steps)).toMatchObject({ total: 3, done: 2, active: 1, percent: 67 });
  });

  it('keeps pure callers in control of approval by requiring lock before execution', () => {
    const rail = startTaskRail({
      steps: [{ instruction: 'Draft-only step' }],
    });

    expect(() => shoot(rail)).toThrow(DraftRailError);

    lockRail(rail);
    expect(shoot(rail).step?.status).toBe('active');
  });

  it('lets consumers build their own authoring UI by appending portable steps', () => {
    const rail = startTaskRail({ id: 'rail-authoring', ownerId: 'browser-ui' });
    appendSteps(rail, [createTaskRailStep({ id: 'ui-step', instruction: 'Render this in any UI.' })]);
    lockRail(rail);

    expect(rail.steps[0]).toMatchObject({
      id: 'ui-step',
      title: 'Render this in any UI.',
      status: 'pending',
      attempts: 0,
    });
    expect(shoot(rail).step?.id).toBe('ui-step');
  });

  it('keeps ordinary blockers local while unrelated pending work advances', () => {
    const rail = startTaskRail({
      locked: true,
      steps: [
        { id: 'blocked', instruction: 'Wait for external input.', status: 'blocked' },
        { id: 'later', instruction: 'Continue later.' },
      ],
    });

    expect(sprint(rail).steps?.map((step) => step.id)).toEqual(['later']);
    expect(shoot(rail)).toMatchObject({ step: { id: 'later', status: 'active' } });
    expect(rail.steps[0].status).toBe('blocked');
  });

  it('keeps needs_review as a rail-wide gate', () => {
    const rail = startTaskRail({
      locked: true,
      steps: [
        { id: 'review', instruction: 'Wait for review.', status: 'needs_review' },
        { id: 'later', instruction: 'Do not advance yet.' },
      ],
    });

    expect(() => sprint(rail)).toThrow(BlockedSprintError);
    expect(shoot(rail)).toMatchObject({ paused: true, step: { id: 'review' } });
  });

  it('supports draft create and clean merge semantics', () => {
    const draft = createDraft(
      {
        id: 'draft-clean',
        ownerInstanceId: 'owner-agent',
        baseRailId: 'rail-demo',
        baseRevision: 7,
        authorId: 'author-agent',
        title: 'Draft patch',
        objective: 'Try a small rail update.',
        steps: [createTaskRailStep({ id: 'draft-step', instruction: 'Try it.' }, '2026-06-17T22:05:00.000Z')],
      },
      '2026-06-17T22:06:00.000Z',
    );

    expect(draft.state).toBe('open');
    expect(draft.revision).toBe(1);
    expect(draft.history[0]).toMatchObject({ operation: 'create', ts: '2026-06-17T22:06:00.000Z' });

    const result = attemptMerge(
      {
        draft,
        actorId: 'owner-agent',
        liveRevision: 7,
        liveRailId: 'rail-demo',
        force: false,
      },
      { now: '2026-06-17T22:07:00.000Z' },
    );

    expect(result).toEqual({ success: true });
    expect(draft.state).toBe('merged');
    expect(draft.mergedAt).toBe('2026-06-17T22:07:00.000Z');
    expect(draft.history.at(-1)).toMatchObject({ operation: 'merge', ts: '2026-06-17T22:07:00.000Z' });
  });

  it('records stale-base conflicts and reopens conflicted drafts on edit', () => {
    const draft = createDraft(
      {
        id: 'draft-conflict',
        ownerInstanceId: 'owner-agent',
        baseRailId: 'rail-demo',
        baseRevision: 7,
        authorId: 'author-agent',
        title: 'Conflicting draft',
        steps: [createTaskRailStep({ id: 'draft-step', instruction: 'Resolve me.' }, '2026-06-17T22:08:00.000Z')],
      },
      '2026-06-17T22:09:00.000Z',
    );

    const result = attemptMerge(
      {
        draft,
        actorId: 'owner-agent',
        liveRevision: 8,
        liveRailId: 'rail-demo',
        force: false,
      },
      { now: '2026-06-17T22:10:00.000Z' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Live rail revision moved from 7 to 8.');
    expect(draft.state).toBe('conflicted');
    expect(draft.conflict).toMatchObject({ liveRevision: 8 });

    updateDraftStep(
      draft,
      'draft-step',
      { title: 'Resolved draft step' },
      { now: '2026-06-17T22:11:00.000Z' },
    );

    expect(draft.state).toBe('open');
    expect(draft.conflict).toBeUndefined();
    expect(draft.steps[0].title).toBe('Resolved draft step');
    expect(draft.history.at(-1)).toMatchObject({ operation: 'update', ts: '2026-06-17T22:11:00.000Z' });
  });

  it('abandons drafts and prevents later edits or merges', () => {
    const draft = createDraft(
      {
        id: 'draft-abandon',
        ownerInstanceId: 'owner-agent',
        baseRevision: 1,
        authorId: 'author-agent',
        title: 'Abandon me',
        steps: [createTaskRailStep({ id: 'draft-step', instruction: 'No longer needed.' }, '2026-06-17T22:12:00.000Z')],
      },
      '2026-06-17T22:13:00.000Z',
    );

    expect(abandonDraft(draft, { now: '2026-06-17T22:14:00.000Z' })).toBeNull();
    expect(draft.state).toBe('abandoned');
    expect(draft.abandonedAt).toBe('2026-06-17T22:14:00.000Z');
    expect(isDraftEditable(draft)).toBe(false);
    expect(() => updateDraftStep(draft, 'draft-step', { title: 'Too late' })).toThrow(/cannot be edited/);

    const result = attemptMerge({
      draft,
      actorId: 'owner-agent',
      liveRevision: 1,
      force: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('abandoned and cannot be merged');
  });

  it('matches the full portable mode and collaboration-role contracts', () => {
    const modes: TaskRailMode[] = ['load', 'shoot', 'sprint', 'draft', 'template', 'audit', 'role'];
    const registration: TaskRailRoleRegistration = {
      role: 'reviewer',
      instanceId: 'reviewer-1',
      status: 'approved',
      requestedAt: '2026-07-22T05:00:00.000Z',
      decidedAt: '2026-07-22T05:01:00.000Z',
    };

    const rail = startTaskRail({
      id: 'rail-roles',
      locked: true,
      steps: [{ instruction: 'Review the implementation.' }],
    });
    rail.crewRoomId = 'room-1';
    rail.reviewerNotifiedAt = '2026-07-22T05:02:00.000Z';
    rail.roleRegistrations = [registration];

    const restored = restoreTaskRail(JSON.parse(JSON.stringify(serializeTaskRail(rail))));
    expect(modes).toHaveLength(7);
    expect(TASK_RAIL_ROLES).toEqual(['co_executor', 'reviewer']);
    expect(TASK_RAIL_ROLE_STATUSES).toEqual(['requested', 'approved', 'denied', 'revoked']);
    expect(restored).toMatchObject({
      crewRoomId: 'room-1',
      reviewerNotifiedAt: '2026-07-22T05:02:00.000Z',
      roleRegistrations: [registration],
    });
  });

  it('ACKs an entire sprint batch while retaining ordinary blockers locally', () => {
    const rail = startTaskRail({
      id: 'rail-batch-ack',
      locked: true,
      now: '2026-07-22T05:10:00.000Z',
      steps: [
        { id: 's1', instruction: 'First.' },
        { id: 's2', instruction: 'Second.' },
        { id: 's3', instruction: 'Third.' },
        { id: 's4', instruction: 'Fourth.' },
      ],
    });
    sprint(rail, { sprintCount: 4 }, { now: '2026-07-22T05:11:00.000Z' });

    const result = shoot(rail, {
      acks: [
        { ackStepId: 's1', ackStatus: 'done', evidence: 'one' },
        { ackStepId: 's2', ackStatus: 'done', evidence: 'two' },
        { ackStepId: 's3', ackStatus: 'blocked', note: 'waiting' },
        { ackStepId: 's4', ackStatus: 'done' },
      ],
    }, { now: '2026-07-22T05:12:00.000Z' });

    expect(result.ackedSteps?.map((step) => step.id)).toEqual(['s1', 's2', 's3', 's4']);
    expect(result).toMatchObject({ paused: true, step: { id: 's3', status: 'blocked' } });
    expect(rail.steps.map((step) => step.status)).toEqual(['done', 'done', 'blocked', 'done']);
  });

  it('captures reusable plan-only templates without leaking execution state', () => {
    const rail = startTaskRail({
      id: 'rail-template',
      title: 'Source rail',
      objective: 'Reuse the authored plan.',
      locked: true,
      steps: [{
        id: 'executed-step',
        title: 'Portable step',
        instruction: 'Do the portable work.',
        acceptanceCriteria: ['It passes'],
        notes: 'Keep this note',
        scope: 'src/taskRail.ts',
        modelPreference: {
          target: { engine: 'claude', model: 'opus-4.8' },
          fallbacks: [{ engine: 'codex', model: 'codex-5.6-sol' }],
        },
        reviewCheckpoint: { scope: 'since_last_review', mode: 'review_and_fix' },
        status: 'done',
      }],
    });
    rail.steps[0].attempts = 3;
    rail.steps[0].evidence = 'tests passed';

    const template = railToTemplate(rail, {
      id: 'tpl-1',
      name: 'Portable template',
      description: 'Reusable plan',
      createdBy: 'standalone-agent',
      now: '2026-07-22T05:20:00.000Z',
    });

    expect(template.version).toBe(TASK_RAIL_TEMPLATE_VERSION);
    expect(template.steps[0]).toEqual({
      title: 'Portable step',
      instruction: 'Do the portable work.',
      acceptanceCriteria: ['It passes'],
      notes: 'Keep this note',
      scope: 'src/taskRail.ts',
      modelPreference: {
        target: { engine: 'claude', model: 'opus-4.8' },
        fallbacks: [{ engine: 'codex', model: 'codex-5.6-sol' }],
      },
      reviewCheckpoint: { scope: 'since_last_review', mode: 'review_and_fix' },
    });
    expect(templateIndexEntry(template)).toMatchObject({ id: 'tpl-1', stepCount: 1 });
    expect(templateToStepSeeds(template)).toEqual([{
      title: 'Portable step',
      instruction: 'Do the portable work.',
      acceptance_criteria: ['It passes'],
      notes: 'Keep this note',
      scope: 'src/taskRail.ts',
      model_preference: {
        target: { engine: 'claude', model: 'opus-4.8' },
        fallbacks: [{ engine: 'codex', model: 'codex-5.6-sol' }],
      },
      review_checkpoint: { scope: 'since_last_review', mode: 'review_and_fix' },
    }]);

    template.steps[0].acceptanceCriteria.push('template-only mutation');
    template.steps[0].modelPreference?.fallbacks?.push({ engine: 'glm', model: 'glm-5.2' });
    expect(rail.steps[0].acceptanceCriteria).toEqual(['It passes']);
    expect(rail.steps[0].modelPreference?.fallbacks).toEqual([
      { engine: 'codex', model: 'codex-5.6-sol' },
    ]);
  });

  it('resolves operator model overrides ahead of AI preferences and deduplicates fallbacks', () => {
    const step = createTaskRailStep({
      id: 'routed',
      instruction: 'Run on the selected model.',
      modelPreference: {
        target: { engine: 'glm', model: 'glm-5.2' },
      },
    });
    step.operatorModelOverride = {
      target: { engine: 'claude', model: 'opus-4.8' },
      fallbacks: [
        { engine: 'claude', model: 'opus-4.8' },
        { engine: 'codex', model: 'codex-5.6-sol' },
      ],
      scope: 'step',
      sourceTimestamp: '2026-07-22T22:20:00.000Z',
      setById: 'operator-1',
      provenanceId: 'override:1',
    };

    expect(resolveStepModelRoute(step)).toEqual({
      source: 'operator',
      candidates: [
        { engine: 'claude', model: 'opus-4.8' },
        { engine: 'codex', model: 'codex-5.6-sol' },
      ],
      operatorOverrideProvenanceId: 'override:1',
    });
    expect(planStepModelTransition(step, { engine: 'claude', model: 'opus-4.8' })).toBeUndefined();
    expect(dedupeModelTargets([
      { engine: 'a', model: 'one' },
      { engine: 'a', model: 'one' },
      { engine: 'b', model: 'two' },
    ])).toEqual([
      { engine: 'a', model: 'one' },
      { engine: 'b', model: 'two' },
    ]);
    expect(isSameModelTarget(
      { engine: 'codex', model: 'codex-5.6-sol', thinkingLevel: 'medium' },
      { engine: 'codex', model: 'codex-5.6-sol', thinkingLevel: 'high' },
    )).toBe(false);
  });

  it('captures a stable review window since the prior checkpoint', () => {
    const now = '2026-07-22T22:20:00.000Z';
    const makeStep = (id: string, status: TaskRailStep['status'], checkpoint = false): TaskRailStep => ({
      id,
      title: id,
      instruction: `Execute ${id}`,
      acceptanceCriteria: [],
      status,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      ...(checkpoint
        ? { reviewCheckpoint: { scope: 'since_last_review' as const, mode: 'review_and_fix' as const } }
        : {}),
    });
    const steps = [
      makeStep('old', 'done'),
      makeStep('checkpoint-1', 'done', true),
      makeStep('included-1', 'done'),
      makeStep('skipped', 'skipped'),
      makeStep('included-2', 'done'),
      makeStep('checkpoint-2', 'active', true),
    ];

    expect(resolveReviewWindow(steps, {
      checkpointStepId: 'checkpoint-2',
      capturedAt: now,
      provenanceId: 'review-window:2',
    })).toEqual({
      stepIds: ['included-1', 'included-2'],
      previousCheckpointStepId: 'checkpoint-1',
      capturedAt: now,
      provenanceId: 'review-window:2',
    });
  });

  it('parses JSON arrays, JSONL, and plain-line bulk step sources', () => {
    expect(parseStepsFileText('["one", {"title":"Two"}, 3]')).toEqual([
      'one',
      { title: 'Two' },
      '3',
    ]);
    expect(parseStepsFileText('{"title":"One"}\n"two"\nplain')).toEqual([
      { title: 'One' },
      'two',
      'plain',
    ]);
    expect(parseStepsFileText('first\n\n second ')).toEqual(['first', 'second']);
    expect(() => parseStepsFileText('[{"title":"unterminated"}')).toThrow(
      /steps_file starts with "\[" but is not valid JSON/,
    );
  });

  it('fails a governed done-ACK closed until every criterion has a verdict', () => {
    const rail = startTaskRail({
      id: 'rail-governed',
      ownerId: 'local-agent',
      title: 'Governed rail',
      objective: 'Fail closed on missing verdicts.',
      locked: true,
      now: '2026-06-17T22:00:00.000Z',
      steps: [{
        id: 'g1',
        instruction: 'Governed work',
        acceptanceCriteria: ['criterion-a', 'criterion-b'],
        governance: 'governed',
      }],
    });
    sprint(rail, { sprintCount: 1 }, { now: '2026-06-17T22:01:00.000Z', actorId: 'local-agent' });

    // Incomplete verdicts throw MissingAcceptanceEvidenceError and do not mutate
    // to done (the step stays at its pre-ACK reservation status, no verdicts).
    expect(() => shoot(rail, {
      ackStepId: 'g1',
      ackStatus: 'done',
      criterionVerdicts: [{ criterion: 'criterion-a', verdict: 'pass', evidence: 'ea' }],
    }, { now: '2026-06-17T22:02:00.000Z', actorId: 'local-agent' }))
      .toThrow(MissingAcceptanceEvidenceError);
    const step = rail.steps.find((s) => s.id === 'g1');
    expect(step?.status).not.toBe('done');
    expect(step?.criterionVerdicts).toBeUndefined();

    // A fail verdict is also rejected for a done ACK.
    expect(() => shoot(rail, {
      ackStepId: 'g1',
      ackStatus: 'done',
      criterionVerdicts: [
        { criterion: 'criterion-a', verdict: 'pass', evidence: 'ea' },
        { criterion: 'criterion-b', verdict: 'fail', evidence: 'eb' },
      ],
    }, { now: '2026-06-17T22:03:00.000Z', actorId: 'local-agent' }))
      .toThrow(/report fail/);
    expect(rail.steps.find((s) => s.id === 'g1')?.status).not.toBe('done');

    // Complete pass coverage accepts and records criterionVerdicts atomically.
    shoot(rail, {
      ackStepId: 'g1',
      ackStatus: 'done',
      criterionVerdicts: [
        { criterion: 'criterion-a', verdict: 'pass', evidence: 'ea' },
        { criterion: 'criterion-b', verdict: 'pass', evidence: 'eb' },
      ],
    }, { now: '2026-06-17T22:04:00.000Z', actorId: 'local-agent' });
    const done = rail.steps.find((s) => s.id === 'g1');
    expect(done?.status).toBe('done');
    expect(done?.criterionVerdicts).toEqual([
      { criterion: 'criterion-a', verdict: 'pass', evidence: 'ea' },
      { criterion: 'criterion-b', verdict: 'pass', evidence: 'eb' },
    ]);
  });
});
