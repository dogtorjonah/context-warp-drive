import { describe, expect, test } from 'vitest';

import {
  buildOpenQuestionsFromMessages,
  buildRawRebirthSeedFromMessages,
  buildRawTraceCoordinateCloset,
  buildRawTraceCoordinateClosetFromMessages,
  DEFAULT_RAW_REBIRTH_SEED_PACKAGE_BUDGET_CHARS,
  DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS,
  findRawRebirthSeedTraceEnd,
  renderRawRebirthSeed,
} from '../src/rawRebirthSeed.ts';
import type { FoldMessage } from '../src/fold.ts';

describe('raw rebirth seed renderer', () => {
  const closetEntries = (closet: string): string[] => closet
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2));

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

  test('collapses slash/no-slash duplicate path candidates and keeps the leading slash spelling', () => {
    const absolutePath = '/home/jonah/voxxo-swarm/relay/src/instanceManagerImpl.ts';
    const closet = buildRawTraceCoordinateCloset([
      { type: 'assistant_text', text: `The active file is ${absolutePath}.` },
    ], 1_000);

    expect(closetEntries(closet).filter((entry) => entry.includes('home/jonah/voxxo-swarm/relay/src/instanceManagerImpl.ts')))
      .toEqual([absolutePath]);
  });

  test('rejects closet noise fixtures while keeping durable coordinate fixtures', () => {
    const noise = [
      'n/g',
      'b/g',
      'word/word',
      'withheld/invisible',
      'check/kill',
      'create/refine',
      'live/contended',
      'coordination/presence',
      'digest-delta/coordination',
      'ids/paths/values',
      'paths/ids/hashes',
      'slash/no-slash',
      'absolute/repo-relative',
      'hex/numerics/counters',
      'recall/self-tap',
      'block/text/token/stop_reason',
      'manager/session/callback',
      'limit/i',
      'all=10/10',
      'all=4/10',
      'S-A/S-B',
      'I/O',
      'So: fable-5-specific',
    ];
    const gold = [
      'relay/logs/relay-out.log',
      'sop/system/fable-5.md',
      'relay/src/crossInstanceTools/rebirthPackageBuilder.ts',
      'packages/context-warp/src/rollingFold.ts',
      '/home/jonah/voxxo-swarm/relay/data/rebirth-spool/rebirth-SduJbsZv-1782943793927.txt',
      'supabase/migrations/20260701221500_clinical_soul_drain_observability.sql',
      'rail-49b60f62',
      '285cab02 (rail)',
      '51d936e4 (claude-SduJbsZv)',
      'unit=voxxo-per-agent-claude-SduJbsZv-51d936e4',
      'turn=turn-1782943730486-jqvT78',
      'contextInputTokens=64696',
      'model: codex-5.5',
      'restarted: 2026-07-01T19:27:07.234Z',
    ];
    const goldSource = [
      'relay/logs/relay-out.log',
      'sop/system/fable-5.md',
      'relay/src/crossInstanceTools/rebirthPackageBuilder.ts',
      'packages/context-warp/src/rollingFold.ts',
      '/home/jonah/voxxo-swarm/relay/data/rebirth-spool/rebirth-SduJbsZv-1782943793927.txt',
      'supabase/migrations/20260701221500_clinical_soul_drain_observability.sql',
      'rail-49b60f62',
      'rail 285cab02',
      'claude-SduJbsZv 51d936e4',
      'unit=voxxo-per-agent-claude-SduJbsZv-51d936e4',
      'turn=turn-1782943730486-jqvT78',
      'contextInputTokens=64696',
      'model: codex-5.5',
      'restarted: 2026-07-01T19:27:07.234Z',
    ];

    const closet = buildRawTraceCoordinateCloset([
      { type: 'assistant_text', text: [...noise, ...goldSource].join('\n') },
    ], 20_000);

    for (const literal of noise) expect(closet).not.toContain(literal);
    for (const literal of gold) expect(closet).toContain(literal);
  });

  test('drops unlabeled opaque hex and N/M counters while keeping labeled or self-describing values', () => {
    const closet = buildRawTraceCoordinateCloset([
      {
        type: 'assistant_text',
        text: [
          'bare d9678796',
          'rail 285cab02',
          'unit=voxxo-per-agent-claude-SduJbsZv-51d936e4',
          'turn=turn-1782943730486-jqvT78',
          'all=10/10',
        ].join('\n'),
      },
    ], 2_000);

    expect(closet).not.toContain('d9678796');
    expect(closet).toContain('285cab02 (rail)');
    expect(closet).toContain('unit=voxxo-per-agent-claude-SduJbsZv-51d936e4');
    expect(closet).toContain('turn=turn-1782943730486-jqvT78');
    expect(closet).not.toContain('all=10/10');
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

describe('open questions ledger (buildOpenQuestionsFromMessages)', () => {
  const messages: FoldMessage[] = [
    { role: 'user', content: 'please fix the relay' },
    { role: 'assistant', content: '🔍 investigating the relay handler' },
    { role: 'assistant', content: '❓ blocked: cannot reach the PC sidecar /health endpoint' },
    { role: 'assistant', content: '🏁 relay handler fixed and verified' },
    { role: 'assistant', content: '❓ blocked on missing GLM API quota' },
  ];

  test('collects only blocked-register entries chronologically', () => {
    const ledger = buildOpenQuestionsFromMessages(messages);
    expect(ledger).toContain('Open Questions');
    expect(ledger).toContain('PC sidecar /health');
    expect(ledger).toContain('GLM API quota');
    expect(ledger).not.toContain('relay handler fixed');
    expect(ledger).not.toContain('investigating the relay');
    expect(ledger.indexOf('PC sidecar')).toBeLessThan(ledger.indexOf('GLM API quota'));
  });

  test('returns empty string when no blocked entries exist', () => {
    expect(buildOpenQuestionsFromMessages([
      { role: 'assistant', content: '🏁 all done' },
    ])).toBe('');
  });

  test('keeps newest entries under a tight budget', () => {
    const ledger = buildOpenQuestionsFromMessages(messages, { maxChars: 80 });
    expect(ledger).toContain('GLM API quota');
    expect(ledger).not.toContain('PC sidecar');
  });

  test('seed auto-builds the openQuestions section from the trace', () => {
    const seed = buildRawRebirthSeedFromMessages(messages);
    expect(seed).toContain('── Open Questions');
    expect(seed).toContain('GLM API quota');
  });

  test('passing empty string suppresses the section', () => {
    const seed = buildRawRebirthSeedFromMessages(messages, { openQuestions: '' });
    expect(seed).not.toContain('── Open Questions');
  });
});
