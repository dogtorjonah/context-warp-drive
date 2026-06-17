import { describe, expect, it } from 'vitest';

import {
  BlockedSprintError,
  DraftRailError,
  ackStep,
  appendSteps,
  computeProgress,
  createTaskRailStep,
  lockRail,
  restoreTaskRail,
  serializeTaskRail,
  shoot,
  sprint,
  startTaskRail,
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

    ackStep(rail, 's1', 'done', {
      now: '2026-06-17T22:02:00.000Z',
      evidence: 'unit test evidence',
    });
    ackStep(rail, 's2', 'done', { now: '2026-06-17T22:03:00.000Z' });

    const next = shoot(rail, {}, { now: '2026-06-17T22:04:00.000Z' });
    expect(next.step?.id).toBe('s3');
    expect(next.step?.status).toBe('active');

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
});
