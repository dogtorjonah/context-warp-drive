import { describe, expect, it } from 'vitest';

import {
  BlockedSprintError,
  DraftRailError,
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
  isDraftEditable,
  lockRail,
  parseStepsFileText,
  railToTemplate,
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

    const reservation = sprint(rail, { sprintCount: 2, note: 'local CLI reservation' }, { now: '2026-06-17T22:01:00.000Z' });

    expect(reservation.steps?.map((step) => [step.id, step.status])).toEqual([
      ['s1', 'active'],
      ['s2', 'in_progress'],
    ]);
    expect(reservation.steps?.map((step) => [step.startedAt, step.updatedAt])).toEqual([
      ['2026-06-17T22:01:00.000Z', '2026-06-17T22:01:00.000Z'],
      ['2026-06-17T22:01:00.000Z', '2026-06-17T22:01:00.000Z'],
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

  it('preserves blocked-step semantics for custom wrappers', () => {
    const rail = startTaskRail({
      locked: true,
      steps: [
        { id: 'blocked', instruction: 'Wait for external input.', status: 'blocked' },
        { id: 'later', instruction: 'Continue later.' },
      ],
    });

    expect(() => sprint(rail)).toThrow(BlockedSprintError);
    expect(shoot(rail)).toMatchObject({ paused: true, step: { id: 'blocked' } });
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

  it('ACKs a sprint batch and stops at the first blocking result', () => {
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

    expect(result.ackedSteps?.map((step) => step.id)).toEqual(['s1', 's2', 's3']);
    expect(result).toMatchObject({ paused: true, step: { id: 's3', status: 'blocked' } });
    expect(rail.steps.map((step) => step.status)).toEqual(['done', 'done', 'blocked', 'in_progress']);
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
    });
    expect(templateIndexEntry(template)).toMatchObject({ id: 'tpl-1', stepCount: 1 });
    expect(templateToStepSeeds(template)).toEqual([{
      title: 'Portable step',
      instruction: 'Do the portable work.',
      acceptance_criteria: ['It passes'],
      notes: 'Keep this note',
      scope: 'src/taskRail.ts',
    }]);

    template.steps[0].acceptanceCriteria.push('template-only mutation');
    expect(rail.steps[0].acceptanceCriteria).toEqual(['It passes']);
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
});
