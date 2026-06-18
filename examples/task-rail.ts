/**
 * examples/task-rail.ts — minimal, dependency-free Task Rail walkthrough.
 *
 * Run it:  npx tsx examples/task-rail.ts
 *
 * This example uses ONLY the pure state machine. No relay, no MCP, no
 * persistence — just start, sprint, ack, shoot, serialize, restore.
 */

import {
  startTaskRail,
  sprint,
  shoot,
  ackStep,
  computeProgress,
  serializeTaskRail,
  restoreTaskRail,
} from '../src/index.ts';

// ─────────────────────────────────────────────────────────────────────
//  1. Start a rail — load a plan and lock it for execution.
// ─────────────────────────────────────────────────────────────────────

const rail = startTaskRail({
  title: 'Fix the flaky CI build',
  objective: 'Make CI green again with minimal, correct changes.',
  locked: true,
  steps: [
    {
      instruction: 'Reproduce the failure locally.',
      acceptanceCriteria: ['Failing test exits non-zero'],
    },
    {
      instruction: 'Identify the root cause in src/queue.ts.',
      acceptanceCriteria: ['Root cause documented'],
    },
    {
      instruction: 'Patch the minimal correct surface.',
      acceptanceCriteria: ['Patch committed', 'Tests pass'],
    },
    {
      instruction: 'Validate and write the handoff.',
      acceptanceCriteria: ['CI green on push'],
    },
  ],
});

console.log(`✓ Rail started: "${rail.title}" — ${rail.steps.length} steps, state=${rail.state}`);

// ─────────────────────────────────────────────────────────────────────
//  2. Sprint — reserve a batch of steps for execution.
// ─────────────────────────────────────────────────────────────────────

const batch = sprint(rail, { sprintCount: 2 });
console.log(`✓ Sprint reserved ${batch.steps!.length} step(s):`);
for (const step of batch.steps!) {
  console.log(`    [${step.status}] ${step.id} — ${step.instruction}`);
}

// ─────────────────────────────────────────────────────────────────────
//  3. ACK the first step as done, then shoot to advance.
// ─────────────────────────────────────────────────────────────────────

const firstStep = batch.steps![0];
ackStep(rail, firstStep.id, 'done', { evidence: 'Reproduced on node 22.22' });
console.log(`✓ ACKed "${firstStep.instruction}" → done`);

const next = shoot(rail);
if (next.step) {
  console.log(`✓ Shoot advanced to: [${next.step.status}] ${next.step.instruction}`);
}

// ─────────────────────────────────────────────────────────────────────
//  4. Progress check — see where the rail stands.
// ─────────────────────────────────────────────────────────────────────

const progress = computeProgress(rail.steps);
console.log(
  `✓ Progress: ${progress.done}/${progress.total} done` +
    (progress.skipped ? `, ${progress.skipped} skipped` : ''),
);

// ─────────────────────────────────────────────────────────────────────
//  5. Serialize → JSON → restore (survives restart / persistence).
// ─────────────────────────────────────────────────────────────────────

const json = JSON.stringify(serializeTaskRail(rail));
const restored = restoreTaskRail(JSON.parse(json));

console.log(`✓ Serialized ${json.length} bytes, restored rail="${restored.title}"`);
console.log(`✓ Restored state=${restored.state}, ${restored.steps.length} steps preserved`);

// Continue execution on the restored rail as if nothing happened:
const batch2 = sprint(restored, { sprintCount: 1 });
if (batch2.steps) {
  console.log(`✓ Post-restore sprint: [${batch2.steps[0].status}] ${batch2.steps[0].instruction}`);
}

console.log('\nDone. Zero dependencies, no relay, no MCP — just a pure state machine.');
