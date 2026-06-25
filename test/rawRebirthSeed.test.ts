import { describe, expect, test } from 'vitest';

import {
  buildRawRebirthSeedFromMessages,
  buildRawTraceCoordinateCloset,
  buildRawTraceCoordinateClosetFromMessages,
  DEFAULT_RAW_REBIRTH_SEED_PACKAGE_BUDGET_CHARS,
  DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS,
  findRawRebirthSeedTraceEnd,
  renderRawRebirthSeed,
} from '../src/rawRebirthSeed.js';
import type { FoldMessage } from '../src/fold.js';

describe('raw rebirth seed renderer', () => {
  test('renders relay-style raw sections in the default priority and display order', () => {
    const seed = renderRawRebirthSeed({
      predecessorName: 'source-agent',
      runtimeModel: {
        predecessor: { engine: 'codex', model: 'gpt-5.5', modelTier: 'codex-5.5' },
        successor: { engine: 'codex', model: 'gpt-5.5', modelTier: 'codex-5.5' },
        changed: false,
      },
      traceEventCount: 42,
      lastUserAiMessages: '[11:44 PM] user\nOk go',
      currentThread: '[11:44 PM] user\nOk go\n\n[11:48 PM] assistant\nWorking',
      rawTraceCoordinateCloset: 'Conserved high-value literals nominated newest-first from the predecessor trace.\n- rail-raw-seed-123456',
      activeEditDelta: 'Files claimed for editing: src/rawRebirthSeed.ts',
      taskRailContext: '[Task rail] Standalone Raw Rebirth Seed API',
      workspaceContext: {
        currentCwd: '/home/jonah/context-warp-drive',
        currentWorkspace: 'context-warp-drive',
      },
      thinkingTrail: 'Chronology: oldest -> newest',
    });

    expect(seed.startsWith('[CONTEXT REBIRTH] You are the continuation of "source-agent".')).toBe(true);
    expect(seed).toContain('── Runtime Model ──');
    expect(seed).toContain('Predecessor trace: 42 events');

    const lastIdx = seed.indexOf('── Last User + AI Messages (READ FIRST) ──');
    const threadIdx = seed.indexOf('── Current Thread ──');
    const closetIdx = seed.indexOf('── Raw Trace Coordinate Closet (ids/paths/values preserved from full trace) ──');
    const editIdx = seed.indexOf('── Active Edit Delta ──');
    const railIdx = seed.indexOf('── Task Rail Context (process truth) ──');
    const workspaceIdx = seed.indexOf('── Workspace Context ──');
    const activityIdx = seed.indexOf('── Activity Log (canonical events and thought bubbles) ──');
    const orientationIdx = seed.indexOf('── Orientation ──');

    expect(lastIdx).toBeGreaterThan(0);
    expect(threadIdx).toBeGreaterThan(lastIdx);
    expect(closetIdx).toBeGreaterThan(threadIdx);
    expect(editIdx).toBeGreaterThan(closetIdx);
    expect(railIdx).toBeGreaterThan(editIdx);
    expect(workspaceIdx).toBeGreaterThan(railIdx);
    expect(activityIdx).toBeGreaterThan(workspaceIdx);
    expect(orientationIdx).toBeGreaterThan(activityIdx);
  });

  test('exports the relay raw package defaults', () => {
    expect(DEFAULT_RAW_REBIRTH_SEED_PACKAGE_BUDGET_CHARS).toBe(200_000);
    expect(DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.lastUserAiMessages).toBe(50_000);
    expect(DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.currentThread).toBe(50_000);
    expect(DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.rawTraceCoordinateCloset).toBe(8_000);
    expect(DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.thinkingTrail).toBe(40_000);
  });

  test('allocates tight budgets with relay priority even when render order differs', () => {
    const baseLength = renderRawRebirthSeed({
      predecessorName: 'priority-agent',
    }).length;
    const seed = renderRawRebirthSeed({
      predecessorName: 'priority-agent',
      packageBudget: baseLength + 220,
      sectionMaxChars: {
        coordinationState: 90,
        squadThoughts: 90,
        delegatedWork: 90,
      },
      coordinationState: `COORDINATION_PRIORITY_MARKER ${'c'.repeat(200)}`,
      squadThoughts: `SQUAD_PRIORITY_MARKER ${'s'.repeat(200)}`,
      delegatedWork: `DELEGATED_PRIORITY_MARKER ${'d'.repeat(200)}`,
    });

    expect(seed).toContain('COORDINATION_PRIORITY_MARKER');
    expect(seed).toContain('SQUAD_PRIORITY_MARKER');
    expect(seed).not.toContain('DELEGATED_PRIORITY_MARKER');
  });

  test('keeps the final rendered seed within the configured package budget', () => {
    const seed = renderRawRebirthSeed({
      predecessorName: 'budget-agent',
      packageBudget: 700,
      currentThread: 'CURRENT_THREAD_MARKER '.repeat(500),
      thinkingTrail: 'ACTIVITY_TRAIL_MARKER '.repeat(500),
    });

    expect(seed.length).toBeLessThanOrEqual(700);
  });

  test('builds the raw trace Coordinate Closet newest-first from visible trace text', () => {
    const closet = buildRawTraceCoordinateCloset([
      { type: 'assistant_text', text: 'older path /repo/src/old.ts and rail-old-123456' },
      { type: 'tool_result', text: 'newer path /repo/src/new.ts and rail-new-abcdef' },
    ], 1_000);

    expect(closet).toContain('Conserved high-value literals nominated newest-first');
    expect(closet.indexOf('/repo/src/new.ts')).toBeLessThan(closet.indexOf('/repo/src/old.ts'));
    expect(closet.indexOf('rail-new-abcdef')).toBeLessThan(closet.indexOf('rail-old-123456'));
  });

  test('builds a complete raw seed from provider-shaped messages', () => {
    const messages: FoldMessage[] = [
      { role: 'user', content: 'Please inspect /repo/src/mod.ts' },
      {
        role: 'assistant',
        content: 'I found rail-provider-seed-123456 in /repo/src/mod.ts',
        tool_calls: [{ id: 'call_provider_seed_abcdef', function: { name: 'Read' } }],
      },
      { role: 'tool', tool_call_id: 'call_provider_seed_abcdef', content: 'tool output from /repo/src/mod.ts' },
      { role: 'user', content: 'LIVE_TRIGGER_MARKER current request' },
    ];

    const seed = buildRawRebirthSeedFromMessages(messages, {
      predecessorName: 'provider-loop',
      includeTrailingUserTurn: false,
      packageBudget: 30_000,
    });

    expect(seed).toContain('[CONTEXT REBIRTH] You are the continuation of "provider-loop".');
    expect(seed).toContain('── Last User + AI Messages (READ FIRST) ──');
    expect(seed).toContain('── Current Thread ──');
    expect(seed).toContain('── Raw Trace Coordinate Closet (ids/paths/values preserved from full trace) ──');
    expect(seed).toContain('/repo/src/mod.ts');
    expect(seed).toContain('rail-provider-seed-123456');
    expect(seed).not.toContain('LIVE_TRIGGER_MARKER current request');
  });

  test('compacts a long AI message to head+pointer in LAST AI MESSAGE, matching relay behavior', () => {
    const longAiMessage = 'A'.repeat(400);
    const messages: FoldMessage[] = [
      { role: 'user', content: 'Do the thing' },
      { role: 'assistant', content: longAiMessage },
      { role: 'user', content: 'LIVE_TRIGGER_MARKER current' },
    ];

    const seed = buildRawRebirthSeedFromMessages(messages, {
      predecessorName: 'compact-ai-agent',
      includeTrailingUserTurn: false,
      packageBudget: 30_000,
    });

    const lastAiStart = seed.indexOf('🤖 LAST AI MESSAGE:');
    const currentThreadStart = seed.indexOf('── Current Thread ──');
    // Isolate just the LAST AI MESSAGE section (before Current Thread)
    const lastAiSection = seed.slice(lastAiStart, currentThreadStart);
    // Should contain the pointer
    expect(lastAiSection).toContain('[Full text appears below in Current Thread.]');
    // Should not dump all 400 chars in the READ FIRST section
    expect(lastAiSection.indexOf('A'.repeat(400))).toBe(-1);
    // Full text should appear in Current Thread
    expect(seed.slice(currentThreadStart)).toContain('A'.repeat(400));
  });

  test('trace-end helper keeps non-string trailing user payloads inside the seed', () => {
    const messages: FoldMessage[] = [
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'non-string active payload' }] },
    ];

    expect(findRawRebirthSeedTraceEnd(messages, false)).toBe(messages.length);
    expect(buildRawTraceCoordinateClosetFromMessages(messages, { includeTrailingUserTurn: false })).toContain('toolu_1');
  });
});
