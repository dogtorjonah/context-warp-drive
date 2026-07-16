import { describe, expect, test } from 'vitest';

import {
  buildOpenQuestionsFromMessages,
  buildLiteralTraceNeighborhoods,
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
      traceNeighborhoods: '⌖ literal: rail-raw-seed-123456\n[trace messages 1–2 of 4]',
      activeEditDelta: 'Files claimed for editing: src/rawRebirthSeed.ts',
      taskRailContext: '[Task rail] Standalone Raw Rebirth Seed API',
      workspaceContext: {
        currentCwd: '/home/jonah/context-warp-drive',
        currentWorkspace: 'context-warp-drive',
      },
      thinkingTrail: 'Chronology: oldest -> newest',
    });

    expect(seed.startsWith('[CONTEXT REBIRTH] Lifecycle boundary: continuation for "source-agent"')).toBe(true);
    expect(seed).toContain('artifact=rebirth-package#continuation class=reconstructed-state authority=current-as-of-frontier');
    expect(seed).toContain('source=source-agent:event#0..source-agent:event#42 n=42');
    expect(seed).toContain('topology=raw-history>artifact>seam>none host=continuity-package');
    expect(seed).toContain('raw-resumes=none (0 exact)');
    expect(seed).toContain('── Rebirth Control (AUTHORITATIVE) ──');
    expect(seed).toContain('── Runtime Model ──');
    expect(seed).toContain('Predecessor trace: 42 events');

    const lastIdx = seed.indexOf('── Last User + AI Messages (READ FIRST) ──');
    const threadIdx = seed.indexOf('── Current Thread ──');
    const closetIdx = seed.indexOf('── Raw Trace Coordinate Closet (ids/paths/values preserved from full trace) ──');
    const neighborhoodsIdx = seed.indexOf('── Trace Neighborhoods (deterministic literal cross-reference; source excerpts, not LLM summaries) ──');
    const editIdx = seed.indexOf('── Active Edit Delta ──');
    const railIdx = seed.indexOf('── Task Rail Context (process truth) ──');
    const workspaceIdx = seed.indexOf('── Workspace Context ──');
    const activityIdx = seed.indexOf('── Activity Log (canonical events and thought bubbles) ──');
    const orientationIdx = seed.indexOf('── Orientation ──');

    expect(lastIdx).toBeGreaterThan(0);
    expect(threadIdx).toBeGreaterThan(lastIdx);
    expect(closetIdx).toBeGreaterThan(threadIdx);
    expect(neighborhoodsIdx).toBeGreaterThan(closetIdx);
    expect(editIdx).toBeGreaterThan(neighborhoodsIdx);
    expect(railIdx).toBeGreaterThan(editIdx);
    expect(workspaceIdx).toBeGreaterThan(railIdx);
    expect(activityIdx).toBeGreaterThan(workspaceIdx);
    expect(orientationIdx).toBeGreaterThan(activityIdx);
  });

  test('renders the current Resume Point next action and preserves legacy fallback', () => {
    const current = renderRawRebirthSeed({
      predecessorName: 'source-agent',
      resumePoint: [
        '📋 Task queue (continuity-state) — active — 3/5 (60%)',
        '▶ Active: reconcile [active] — Reconcile authoritative state',
        '⏭ Next action: Apply the exact active instruction',
        '↪ After active step: queued [pending] — Run parity',
      ].join('\n'),
    });
    expect(current).toContain('immediate next action: ⏭ Next action: Apply the exact active instruction');
    expect(current).not.toContain('immediate next action: unknown');

    const legacy = renderRawRebirthSeed({
      predecessorName: 'source-agent',
      resumePoint: '⏭ Next: Continue from the legacy package',
    });
    expect(legacy).toContain('immediate next action: ⏭ Next: Continue from the legacy package');
  });

  test('renders one authoritative active request body and suppresses lower-tier duplicates', () => {
    const activeRequest = 'Ship the rebirth package redesign now';
    const seed = renderRawRebirthSeed({
      predecessorName: 'source-agent',
      triggeringUserMessage: activeRequest,
      lastUserAiMessages: `👤 LAST USER MESSAGE:\n${activeRequest}`,
      currentThread: '🤖 ASSISTANT: prior response',
      userMessageTriggered: true,
    });

    expect(seed.match(new RegExp(activeRequest, 'g'))).toHaveLength(1);
    expect(seed).toContain('topology=raw-history>artifact>seam>raw-tail host=continuity-package');
    expect(seed).toContain('raw-resumes=source-agent:event#live-frontier (1 exact)');
    expect(seed).toContain('active request (verbatim; sole authoritative body):');
    expect(seed).not.toContain('── Last User + AI Messages (READ FIRST) ──');
  });

  test('keeps a mid-length active request byte-complete under the verbatim label', () => {
    // 2000+ chars: the old 1500-char cap silently excerpted this while the
    // label still claimed 'verbatim'; the 6000-char cap carries it whole.
    const midRequest = `MID_HEAD_${'B'.repeat(2_000)}_MID_TAIL`;
    const seed = renderRawRebirthSeed({
      predecessorName: 'source-agent',
      triggeringUserMessage: midRequest,
      userMessageTriggered: true,
    });

    expect(seed).toContain(`active request (verbatim; sole authoritative body):\n${midRequest}`);
    expect(seed).not.toContain('active request (EXCERPT');
  });

  test('labels an over-cap active request as an honest excerpt, never verbatim', () => {
    const hugeRequest = `HEAD_${'C'.repeat(7_000)}_TAIL`;
    const seed = renderRawRebirthSeed({
      predecessorName: 'source-agent',
      triggeringUserMessage: hugeRequest,
      userMessageTriggered: true,
    });

    expect(seed).not.toContain('active request (verbatim');
    expect(seed).toContain(
      `active request (EXCERPT — ${hugeRequest.length} chars total, middle elided; full text via tap_instance_messages; sole authoritative body):`,
    );
    expect(seed).toContain('chars omitted');
    expect(seed).toContain('HEAD_');
    expect(seed).toContain('_TAIL');
  });

  test('preserves boundary whitespace before calling an active request verbatim', () => {
    const whitespaceRequest = '\n  preserve this indentation\n  and trailing spaces  \n';
    const seed = renderRawRebirthSeed({
      predecessorName: 'source-agent',
      triggeringUserMessage: whitespaceRequest,
      userMessageTriggered: true,
    });

    expect(seed).toContain(
      `active request (verbatim; sole authoritative body):\n${whitespaceRequest}`,
    );
  });

  test('uses the final AI header when the active request quotes an AI marker', () => {
    const trigger = 'Inspect this quoted block:\n🤖 LAST AI MESSAGE:\nnot the assistant boundary';
    const seed = renderRawRebirthSeed({
      predecessorName: 'source-agent',
      triggeringUserMessage: trigger,
      userMessageTriggered: true,
      lastUserAiMessages: `👤 LAST USER MESSAGE (active request):\n${trigger}\n\n🤖 LAST AI MESSAGE:\nActual predecessor state.`,
    });

    const aiSection = seed.split('── Last AI Message (READ FIRST) ──')[1] ?? '';
    expect(aiSection).toContain('🤖 LAST AI MESSAGE:\nActual predecessor state.');
    expect(aiSection).not.toContain('not the assistant boundary');
  });

  test('preserves the last AI message when a bundled trigger suppresses the user half', () => {
    // The user half duplicates the control capsule's authoritative active
    // request, so it is stripped — but the AI half must survive: with no
    // current thread it is the only copy of the predecessor's last words.
    const trigger = 'TRIGGER_TOKEN_ZK41 please fix the flaky retry test';
    const seed = renderRawRebirthSeed({
      predecessorName: 'source-agent',
      triggeringUserMessage: trigger,
      userMessageTriggered: true,
      lastUserAiMessages: `👤 LAST USER MESSAGE:\n${trigger}\n\n🤖 LAST AI MESSAGE:\nPatched the retry backoff; validating now.`,
    });

    expect(seed).toContain('── Last AI Message (READ FIRST) ──');
    expect(seed).toContain('Patched the retry backoff; validating now.');
    expect(seed).not.toContain('👤 LAST USER MESSAGE');
    // The active request body appears exactly once — in the control capsule.
    expect(seed.split('TRIGGER_TOKEN_ZK41').length - 1).toBe(1);
  });

  test('uses mutually exclusive hard-epoch and fresh-fork identity contracts', () => {
    const hardEpoch = renderRawRebirthSeed({
      predecessorName: 'same-agent',
      lifecycleBoundary: 'same_instance_hard_epoch',
    });
    const fork = renderRawRebirthSeed({
      predecessorName: 'source-agent',
      forkContext: { groupId: 'fork_group', isFreshFork: true },
    });

    expect(hardEpoch).toContain('boundary: same_instance_hard_epoch');
    expect(hardEpoch).toContain('same running instance');
    expect(hardEpoch.split('\n').slice(0, 12).join('\n')).not.toContain('predecessor/successor');
    expect(fork).toContain('boundary: fresh_fork');
    expect(fork).toContain('new independent fork');
    expect(fork).not.toContain('Same durable identity');
    expect(fork).not.toContain('YOU ARE A FORK');
  });

  test('exports the relay raw package defaults', () => {
    expect(DEFAULT_RAW_REBIRTH_SEED_PACKAGE_BUDGET_CHARS).toBe(200_000);
    expect(DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.lastUserAiMessages).toBe(50_000);
    expect(DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.currentThread).toBe(50_000);
    expect(DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.rawTraceCoordinateCloset).toBe(8_000);
    expect(DEFAULT_RAW_REBIRTH_SEED_SECTION_MAX_CHARS.traceNeighborhoods).toBe(12_000);
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
    expect(closet).toContain('/repo/src/new.ts @ source=tool_result message 2');
    expect(closet).toContain('/repo/src/old.ts @ source=assistant message 1');
    expect(closet).not.toContain('source=undefined');
    expect(closet.indexOf('/repo/src/new.ts')).toBeLessThan(closet.indexOf('/repo/src/old.ts'));
    expect(closet.indexOf('rail-new-abcdef')).toBeLessThan(closet.indexOf('rail-old-123456'));
  });

  test('builds deterministic exact-match neighborhoods with adjacent source messages', () => {
    const neighborhoods = buildLiteralTraceNeighborhoods([
      { type: 'user', text: 'Investigate why rail-neighborhood-123456 is failing.' },
      { type: 'assistant_text', text: 'I will inspect /repo/src/neighborhood.ts now.' },
      { type: 'tool_result', text: 'The failure is termAnchorIdfFloor=0.2 in /repo/src/neighborhood.ts.' },
      { type: 'assistant_text', text: 'Conclusion: repair the anchor gate before release.' },
    ], { maxChars: 4_000, maxNeighborhoods: 1, contextRadius: 1 });

    expect(neighborhoods).toContain('never LLM-summarized');
    expect(neighborhoods).toContain('⌖ literal: rail-neighborhood-123456');
    expect(neighborhoods).toContain('exact operational id');
    expect(neighborhoods).toContain('[trace messages 1–4 of 4]');
    expect(neighborhoods).toContain('[1] user: Investigate why rail-neighborhood-123456 is failing.');
    expect(neighborhoods).toContain('[2] assistant: I will inspect /repo/src/neighborhood.ts now.');
    expect(neighborhoods).toContain('[4] assistant: Conclusion: repair the anchor gate before release.');
  });

  test('ranks rare operational ids above paths and merges overlapping windows', () => {
    const neighborhoods = buildLiteralTraceNeighborhoods([
      { type: 'user', text: 'Open /repo/src/shared.ts for rail-rare-abcdef.' },
      { type: 'assistant_text', text: 'Checked /repo/src/shared.ts and rail-rare-abcdef.' },
      { type: 'tool_result', text: 'A second /repo/src/shared.ts occurrence.' },
    ], { maxChars: 4_000, maxNeighborhoods: 6, contextRadius: 1 });

    expect(neighborhoods).toContain('⌖ literal: rail-rare-abcdef');
    expect(neighborhoods.match(/^⌖ literal:/gmu)).toHaveLength(1);
  });

  test('selects the strongest causal occurrence instead of a newer incidental mention', () => {
    const neighborhoods = buildLiteralTraceNeighborhoods([
      { type: 'user', text: 'Investigate rail-repeated-causal-123456 before release.' },
      { type: 'assistant_text', text: 'I will inspect the failing workflow.' },
      { type: 'tool_result', text: 'rail-repeated-causal-123456 failed because retryLimit=7.' },
      { type: 'assistant_text', text: 'Conclusion: preserve the retry invariant.' },
      { type: 'user', text: 'Later incidental note: rail-repeated-causal-123456 appeared in a summary.' },
      { type: 'assistant_text', text: 'Acknowledged the incidental note.' },
    ], { maxChars: 4_000, maxNeighborhoods: 1, contextRadius: 1 });

    expect(neighborhoods).toContain('causal=message 3; chain-score=150');
    expect(neighborhoods).toContain('Conclusion: preserve the retry invariant.');
    expect(neighborhoods).not.toContain('Later incidental note');
  });

  test('suppresses conserved coordinates and prior rebirth seed recursion', () => {
    const neighborhoods = buildLiteralTraceNeighborhoods([
      { type: 'assistant_text', text: 'Older evidence for rail-old-evidence-123456.' },
      { type: 'user', text: '[CONTEXT REBIRTH]\n- rail-recursive-junk-abcdef' },
      { type: 'user', text: '[INSTANCE RESURRECTED]\n- rail-resurrection-junk-fedcba' },
      { type: 'user', text: '[Chronological Provenance v1] artifact=tail-epoch#7\n- rail-chronology-alias-junk-123456' },
      { type: 'tool_result', text: 'Independent evidence at /repo/src/keep.ts.' },
    ], {
      maxChars: 4_000,
      excludeTexts: ['Current Thread already carries rail-old-evidence-123456.'],
      contextRadius: 0,
    });

    expect(neighborhoods).not.toContain('rail-old-evidence-123456');
    expect(neighborhoods).not.toContain('rail-recursive-junk-abcdef');
    expect(neighborhoods).not.toContain('rail-resurrection-junk-fedcba');
    expect(neighborhoods).not.toContain('rail-chronology-alias-junk-123456');
    expect(neighborhoods).toContain('/repo/src/keep.ts');
  });

  test('honors neighborhood count and character caps without partial blocks', () => {
    const neighborhoods = buildLiteralTraceNeighborhoods([
      { type: 'assistant_text', text: `rail-budget-one-123456 ${'first '.repeat(40)}` },
      { type: 'assistant_text', text: `rail-budget-two-abcdef ${'second '.repeat(40)}` },
    ], { maxChars: 700, maxNeighborhoods: 1, contextRadius: 0, perMessageChars: 180 });

    expect(neighborhoods.length).toBeLessThanOrEqual(700);
    expect(neighborhoods.match(/^⌖ literal:/gmu)).toHaveLength(1);
    expect(neighborhoods).toMatch(/\[trace messages \d+–\d+ of 2\]/u);
    expect(buildLiteralTraceNeighborhoods([
      { type: 'assistant_text', text: 'rail-budget-disabled-123456' },
    ], { maxNeighborhoods: 0 })).toBe('');
  });

  test('keeps active edit and task rail process truth ahead of trace neighborhoods under budget pressure', () => {
    const seed = renderRawRebirthSeed({
      predecessorName: 'priority-agent',
      packageBudget: 10_000,
      headerOverride: 'HEADER',
      footerOverride: '',
      traceNeighborhoods: 'TRACE_NEIGHBORHOOD '.repeat(900),
      activeEditDelta: 'ACTIVE_PROCESS_TRUTH '.repeat(180),
      taskRailContext: 'TASK_RAIL_PROCESS_TRUTH '.repeat(120),
    });

    expect(seed).toContain('ACTIVE_PROCESS_TRUTH');
    expect(seed).toContain('TASK_RAIL_PROCESS_TRUTH');
    expect(seed).toContain('artifact=continuity-package#custom class=reconstructed-state');
    expect(seed.length).toBeLessThanOrEqual(10_000);
  });

  test('auto-builds neighborhoods only for coordinates absent from the recent thread', () => {
    const messages: FoldMessage[] = [
      { role: 'user', content: 'Investigate rail-buried-context-123456.' },
      { role: 'assistant', content: 'The relevant implementation is /repo/src/buried.ts.' },
      { role: 'tool', content: 'The failure came from retryLimit=7.' },
      { role: 'assistant', content: 'Old conclusion: preserve the retry invariant.' },
      { role: 'user', content: 'A newer question with no exact coordinates.' },
      { role: 'assistant', content: 'A newer answer with ordinary prose.' },
      { role: 'user', content: 'LIVE_TRIGGER_MARKER current request' },
    ];

    const seed = buildRawRebirthSeedFromMessages(messages, {
      predecessorName: 'neighborhood-agent',
      includeTrailingUserTurn: false,
      currentThreadMessageLimit: 2,
      packageBudget: 30_000,
    });

    expect(seed).toContain('── Trace Neighborhoods (deterministic literal cross-reference; source excerpts, not LLM summaries) ──');
    expect(seed).toContain('rail-buried-context-123456');
    expect(seed).toContain('preserve the retry invariant');

    const suppressed = buildRawRebirthSeedFromMessages(messages, {
      predecessorName: 'neighborhood-agent',
      includeTrailingUserTurn: false,
      currentThreadMessageLimit: 2,
      traceNeighborhoods: '',
      packageBudget: 30_000,
    });
    expect(suppressed).not.toContain('── Trace Neighborhoods');
  });

  test('collapses slash/no-slash duplicate path candidates and keeps the leading slash spelling', () => {
    const absolutePath = '/home/jonah/voxxo-swarm/relay/src/instanceManagerImpl.ts';
    const closet = buildRawTraceCoordinateCloset([
      { type: 'assistant_text', text: `The active file is ${absolutePath}.` },
    ], 1_000);

    expect(closetEntries(closet).filter((entry) => entry.includes('home/jonah/voxxo-swarm/relay/src/instanceManagerImpl.ts')))
      .toEqual([`${absolutePath} @ source=assistant message 1`]);
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
      '/home/jonah/voxxo-swarm/relay/data/rebirth-spool/rebirth-SduJbsZv-1782943793927.txt',
    ];
    const gold = [
      'relay/logs/relay-out.log',
      'sop/system/fable-5.md',
      'relay/src/crossInstanceTools/rebirthPackageBuilder.ts',
      'packages/context-warp/src/rollingFold.ts',
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

    expect(seed).toContain('[CONTEXT REBIRTH] Lifecycle boundary: continuation for "provider-loop"');
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

    const lastAiStart = seed.indexOf('🤖 LAST AI MESSAGE');
    expect(lastAiStart).toBeGreaterThan(-1);
    const currentThreadStart = seed.indexOf('── Current Thread ──');
    // Isolate just the LAST AI MESSAGE section (before Current Thread)
    const lastAiSection = seed.slice(lastAiStart, currentThreadStart);
    // Should contain the pointer (with or without a [message N] coordinate)
    expect(lastAiSection).toContain('[Full text appears below in Current Thread');
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

// ── Cross-section containment dedupe tests ──────────────────────────────
describe('cross-section containment dedupe', () => {
  const LONG_THREAD = `[05:04 PM] 👤 USER: Hi there
[05:05 PM] 🤖 ASSISTANT: 🔍 Let me investigate the issue with the rebirth package.
I've read through rollingFold.ts, foldFreeze.ts, foldRecall.ts and found several issues.
The freeze layer is the best idea — cache writes at 1.25x vs reads at 0.1x means recomputing
the fold every call costs more than the compression saves. The Coordinate Closet preserving
exact identifiers is critical for continuity across rebirth boundaries.
[05:10 PM] 🤖 ASSISTANT: 🏁 Ghost preview read in full — 2,885 persisted rows, ~2h autonomous
session, 16-step rail completed, judged as an outside observer. The task-state gap is a no-rail
gap, not a package gap. The closet extractor is tuned for tool-call traces and degrades on
prose-heavy ones. Five near-identical polling messages consume the section budget.`;

  test('young fixture: episodic cards verbatim in thread are suppressed', () => {
    const episodicContent = `## 🧠 Episodic Recall (pushed at wake)
↞ why: path-match packages/context-warp/src/rollingFold.ts
🗣 agent-name:
    "Let me investigate the issue with the rebirth package.
I've read through rollingFold.ts, foldFreeze.ts, foldRecall.ts and found several issues.
The freeze layer is the best idea — cache writes at 1.25x vs reads at 0.1x means recomputing
the fold every call costs more than the compression saves."`;

    const seed = renderRawRebirthSeed({
      predecessorName: 'young-agent',
      runtimeModel: {
        predecessor: { engine: 'claude', model: 'claude-sonnet-5', modelTier: 'sonnet-5' },
        successor: { engine: 'claude', model: 'claude-sonnet-5', modelTier: 'sonnet-5' },
        changed: false,
      },
      traceEventCount: 10,
      currentThread: LONG_THREAD,
      episodicCrossRef: episodicContent,
    });

    // The card body is verbatim in LONG_THREAD → should be suppressed
    expect(seed).toContain('redundant episodic card(s) suppressed');
  });

  test('mature fixture: episodic cards with unique content are retained', () => {
    const uniqueEpisodic = `## 🧠 Episodic Recall (pushed at wake)
↞ why: path-match relay/src/taskRail.ts
🗣 old-agent:
    "Earlier session: implemented the task rail persistence layer with SQLite storage,
    added sprint/shoot execution modes, and verified the rail state survives relay restarts.
    The acceptance criteria were met for all 16 steps in the implementation rail."`;

    const seed = renderRawRebirthSeed({
      predecessorName: 'mature-agent',
      runtimeModel: {
        predecessor: { engine: 'claude', model: 'claude-sonnet-5', modelTier: 'sonnet-5' },
        successor: { engine: 'claude', model: 'claude-sonnet-5', modelTier: 'sonnet-5' },
        changed: false,
      },
      traceEventCount: 2885,
      currentThread: LONG_THREAD,
      episodicCrossRef: uniqueEpisodic,
    });

    // Unique content NOT in thread → should be retained
    expect(seed).toContain('task rail persistence layer');
    expect(seed).not.toContain('redundant episodic card(s) suppressed');
  });

  test('glyph log entries verbatim in thread are collapsed', () => {
    const glyphLog = `## 🗒️ Lineage Glyph Log — 3 entries
[05:05 PM] 🔍 Let me investigate the issue with the rebirth package.
I've read through rollingFold.ts, foldFreeze.ts, foldRecall.ts and found several issues.
[05:10 PM] 🏁 Ghost preview read in full — 2,885 persisted rows, ~2h autonomous
session, 16-step rail completed.
[05:15 PM] ⚠️ Unique hazard: the relay event loop must not be blocked`;

    const seed = renderRawRebirthSeed({
      predecessorName: 'glyph-agent',
      runtimeModel: {
        predecessor: { engine: 'claude', model: 'claude-sonnet-5', modelTier: 'sonnet-5' },
        successor: { engine: 'claude', model: 'claude-sonnet-5', modelTier: 'sonnet-5' },
        changed: false,
      },
      traceEventCount: 50,
      currentThread: LONG_THREAD,
      lineageGlyphLog: glyphLog,
    });

    // First two entries have probes verbatim in thread → collapsed
    expect(seed).toContain('(verbatim in thread)');
    // Third entry has unique content → retained
    expect(seed).toContain('Unique hazard: the relay event loop must not be blocked');
  });

  test('VOXXO_REBIRTH_SEED_DEDUPE=0 disables cross-section dedupe', () => {
    const original = process.env.VOXXO_REBIRTH_SEED_DEDUPE;
    process.env.VOXXO_REBIRTH_SEED_DEDUPE = '0';
    try {
      const episodicContent = `## 🧠 Episodic Recall
↞ why: path-match
🗣 agent:
    "Let me investigate the issue with the rebirth package.
I've read through rollingFold.ts, foldFreeze.ts, foldRecall.ts and found several issues.
The freeze layer is the best idea — cache writes at 1.25x vs reads at 0.1x means recomputing
the fold every call costs more than the compression saves."`;

      const seed = renderRawRebirthSeed({
        predecessorName: 'flagged-agent',
        runtimeModel: {
          predecessor: { engine: 'claude', model: 'claude-sonnet-5', modelTier: 'sonnet-5' },
          successor: { engine: 'claude', model: 'claude-sonnet-5', modelTier: 'sonnet-5' },
          changed: false,
        },
        traceEventCount: 10,
        currentThread: LONG_THREAD,
        episodicCrossRef: episodicContent,
      });

      // Flag=0 → dedupe disabled → card should be retained
      expect(seed).not.toContain('redundant episodic card(s) suppressed');
      expect(seed).toContain('freeze layer is the best idea');
    } finally {
      if (original === undefined) {
        delete process.env.VOXXO_REBIRTH_SEED_DEDUPE;
      } else {
        process.env.VOXXO_REBIRTH_SEED_DEDUPE = original;
      }
    }
  });

  test('short thread (< 100 chars) skips dedupe entirely', () => {
    const shortThread = '[05:04 PM] 👤 USER: Hi\n[05:04 PM] 🤖 ASSISTANT: Hello!';
    const episodicContent = `## 🧠 Episodic Recall
↞ why: path-match
🗣 agent:
    "Some content that is definitely longer than the minimum threshold and would normally
    be checked against the thread for containment deduplication."`;

    const seed = renderRawRebirthSeed({
      predecessorName: 'short-thread-agent',
      runtimeModel: {
        predecessor: { engine: 'claude', model: 'claude-sonnet-5', modelTier: 'sonnet-5' },
        successor: { engine: 'claude', model: 'claude-sonnet-5', modelTier: 'sonnet-5' },
        changed: false,
      },
      traceEventCount: 2,
      currentThread: shortThread,
      episodicCrossRef: episodicContent,
    });

    // Short thread → dedupe skipped → card retained
    expect(seed).not.toContain('redundant episodic card(s) suppressed');
    expect(seed).toContain('containment deduplication');
  });
});

describe('portable citation markers ([message N] refs)', () => {
  const MARKER_MESSAGES: FoldMessage[] = [
    { role: 'user', content: 'Please inspect /repo/src/mod.ts and report your findings.' },
    {
      role: 'assistant',
      content: '🏁 Verified /repo/src/mod.ts — the exported helpers are sound and covered by tests.',
    },
    { role: 'user', content: 'LIVE_TRIGGER_MARKER current request' },
  ];

  test('last-user/AI headers carry [message N] refs matching thread rows', () => {
    const seed = buildRawRebirthSeedFromMessages(MARKER_MESSAGES, {
      predecessorName: 'marker-agent',
      includeTrailingUserTurn: false,
      packageBudget: 30_000,
    });

    expect(seed).toContain('👤 LAST USER MESSAGE [message 0]:');
    expect(seed).toContain('🤖 LAST AI MESSAGE [message 1]:');
    // The refs reuse the thread's existing coordinate space — the same
    // [message N] labels must exist as real rendered thread rows.
    expect(seed).toContain('[message 0] 👤 USER:');
    expect(seed).toContain('[message 1] 🤖 YOU:');
  });

  test('truncated AI body pointer carries the [message N] coordinate', () => {
    const longBody = `🏁 Verified the fold engine end to end. ${'The rolling fold preserves continuity across epochs and the freeze layer caches rendered bands. '.repeat(6)}`;
    const messages: FoldMessage[] = [
      { role: 'user', content: 'Run the full fold verification pass.' },
      { role: 'assistant', content: longBody },
      { role: 'user', content: 'LIVE_TRIGGER_MARKER current request' },
    ];

    const seed = buildRawRebirthSeedFromMessages(messages, {
      predecessorName: 'pointer-agent',
      includeTrailingUserTurn: false,
      packageBudget: 30_000,
    });

    expect(seed).toContain('🤖 LAST AI MESSAGE [message 1]:');
    expect(seed).toContain('[Full text appears below in Current Thread at [message 1].]');
  });

  test('VOXXO_REBIRTH_SEED_MSG_MARKERS=0 renders marker-free headers', () => {
    const original = process.env.VOXXO_REBIRTH_SEED_MSG_MARKERS;
    process.env.VOXXO_REBIRTH_SEED_MSG_MARKERS = '0';
    try {
      const seed = buildRawRebirthSeedFromMessages(MARKER_MESSAGES, {
        predecessorName: 'flag-off-agent',
        includeTrailingUserTurn: false,
        packageBudget: 30_000,
      });

      expect(seed).toContain('👤 LAST USER MESSAGE:\n');
      expect(seed).toContain('🤖 LAST AI MESSAGE:\n');
      expect(seed).not.toContain('LAST USER MESSAGE [message');
      expect(seed).not.toContain('LAST AI MESSAGE [message');
      // Thread rows keep their pre-existing [message N] labels — only the
      // header refs are flag-gated.
      expect(seed).toContain('[message 0] 👤 USER:');
    } finally {
      if (original === undefined) {
        delete process.env.VOXXO_REBIRTH_SEED_MSG_MARKERS;
      } else {
        process.env.VOXXO_REBIRTH_SEED_MSG_MARKERS = original;
      }
    }
  });
});
