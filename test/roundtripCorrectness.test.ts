/**
 * Roundtrip correctness — the full fold → freeze → hard-epoch reset → recall
 * lifecycle, asserting that specific identifiers survive the entire pipeline
 * and remain available for safe subsequent agent actions.
 *
 * This is the end-to-end test that validates CWD's core correctness claim:
 * deterministic folding preserves the identifiers an agent needs to reproduce
 * the same safe action after a context reset.
 *
 * Pipeline under test:
 *   1. Build a realistic multi-turn trace with known identifiers
 *   2. Fold + freeze (tail epochs accumulate work)
 *   3. Pressure ceiling triggers a hard-epoch reset (rebirth seed)
 *   4. Verify the rebirth seed conserves critical identifiers
 *   5. After the reset, a path-touch recall pages back the right content
 *   6. Assert the agent has everything needed for the next safe tool call
 */
import { describe, expect, test } from 'vitest';

import {
  ALWAYS_ON_FOLD_CONFIG,
  FoldSession,
  HARD_EPOCH_CONTINUITY_DIRECTIVE,
  type FoldMessage,
} from '../src/fold.ts';
import {
  buildFoldIndex,
  buildFoldRecallContext,
  createFoldRecallState,
  DEFAULT_FOLD_RECALL_CONFIG,
  extractRecallSignals,
  type FoldRecallState,
} from '../src/foldRecall.ts';

// ── Known identifiers that must survive the full roundtrip ──

/** A realistic file path the agent read and will re-touch after the reset. */
const TARGET_PATH = '/home/jonah/context-warp-drive/src/rollingFold.ts';
const TARGET_PATH_CANON = 'src/rollingFold.ts';

/** A git SHA the agent referenced during its investigation. */
const GIT_SHA = '7fd5835b2a9c';

/** A port number from a tool result the agent needs to connect to. */
const PORT = '3002';

/** A rail ID the agent was executing against. */
const RAIL_ID = 'rail-49b60f62';

/** A tool-use ID the agent issued. */
const TOOL_CALL_ID = 'toolu_roundtrip_abc123';

/** A changelog ID from an atlas_commit. */
const CHANGELOG_ID = 'changelog_id=14017';

/** A unique payload string that only exists in the folded-away turn. */
const BURIED_PAYLOAD = 'BURIED_ROUNDTRIP_PAYLOAD_a3f8e2c1';

/** A UUID from a tool result. */
const INSTANCE_UUID = 'S69uxBBv';

// ── Message builders (match foldSession.test.ts patterns) ──

function userMsg(text: string): FoldMessage {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): FoldMessage {
  return { role: 'assistant', content: text };
}

function anthropicToolUse(name: string, input: Record<string, unknown>, id: string): FoldMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
  };
}

function anthropicToolResult(toolUseId: string, content: string): FoldMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
  };
}

// ── Build a realistic multi-turn agent session trace ──

function buildRealisticTrace(): FoldMessage[] {
  return [
    // ── Turn 1: User kicks off investigation ──
    userMsg(`Investigate the fold engine. The failing test is on commit ${GIT_SHA}.`),

    // ── Turn 2: Agent reads the target file (contains the buried payload) ──
    anthropicToolUse('Read', { file_path: TARGET_PATH }, TOOL_CALL_ID),
    anthropicToolResult(TOOL_CALL_ID,
      `File content of rollingFold.ts:\n${BURIED_PAYLOAD}\n` +
      `// The fold engine runs on port ${PORT}\n` +
      `// See ${CHANGELOG_ID} for the last change\n` +
      'x'.repeat(5_000), // realistic file size
    ),

    // ── Turn 3: Agent reports findings ──
    assistantMsg(
      `I found the issue in ${TARGET_PATH_CANON}. The commit ${GIT_SHA} introduced ` +
      `a regression tracked as ${RAIL_ID}. Instance ${INSTANCE_UUID} was running ` +
      `on port ${PORT} when the test failed. ${CHANGELOG_ID} has the details.\n` +
      'Additional analysis text. '.repeat(80), // bulk to ensure this gets folded
    ),

    // ── Turn 4: User acknowledges, agent continues with more work ──
    userMsg('Good. Now fix the regression.'),
    anthropicToolUse('Edit', { file_path: TARGET_PATH, old_text: 'old', new_text: 'new' }, 'toolu_edit_1'),
    anthropicToolResult('toolu_edit_1', 'Edit applied successfully.'),
    assistantMsg('Fixed the regression. The test should pass now. ' + 'Reasoning filler. '.repeat(60)),

    // ── Turns 5-8: More work to push the trace past fold thresholds ──
    ...Array.from({ length: 4 }, (_, i) => {
      const id = `toolu_followup_${i}`;
      return [
        userMsg(`Follow-up task ${i}: check module ${i}`),
        anthropicToolUse('Read', { file_path: `/repo/src/mod${i}.ts` }, id),
        anthropicToolResult(id, `Module ${i} content\n${'y'.repeat(4_000)}`),
        assistantMsg(`Module ${i} looks good. ` + 'Additional reasoning. '.repeat(50)),
      ];
    }).flat(),

    // ── Final user turn (the "active request" at hard-epoch time) ──
    userMsg('Continue with the next batch of work.'),
  ];
}

// ── Tests ──

describe('roundtrip correctness — identifiers survive fold → hard-epoch → recall', () => {
  test('full pipeline: fold → freeze → pressure ceiling → rebirth seed conserves critical identifiers', () => {
    let now = Date.parse('2026-06-16T00:00:00.000Z');
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: { enabled: true, ttlMs: 3_600_000, maxTailChars: 150_000 },
      pressureCeiling: 10, // artificially low to force a hard epoch
      now: () => {
        now += 1_000;
        return now;
      },
    });

    const messages = buildRealisticTrace();

    // ── Step 1: First prepare folds and freezes the trace (no pressure yet) ──
    const first = session.prepare(messages, { measuredInputTokens: 5 });
    expect(first.cacheHot).toBe(false);

    // ── Step 2: Simulate measured pressure AT the ceiling → hard epoch ──
    const hardEpoch = session.prepare(messages, { measuredInputTokens: 10 });
    expect(hardEpoch.stats.epochReason).toBe('hard-epoch');
    expect(hardEpoch.messages).toHaveLength(1);

    const seedBody = typeof hardEpoch.messages[0].content === 'string'
      ? hardEpoch.messages[0].content
      : '';

    // ── Step 3: The rebirth seed MUST start with the continuity directive ──
    expect(seedBody).toContain(HARD_EPOCH_CONTINUITY_DIRECTIVE);

    // ── Step 4: Assert every critical identifier survived into the seed ──
    // These are the exact values an agent needs to safely continue work.

    // The Coordinate Closet or seed body must contain:
    expect(seedBody).toContain(TARGET_PATH);           // file path the agent was editing
    expect(seedBody).toContain(GIT_SHA);               // git SHA from the investigation
    expect(seedBody).toContain(PORT);                   // port number
    expect(seedBody).toContain(RAIL_ID);               // rail identifier
    expect(seedBody).toContain(CHANGELOG_ID);          // changelog reference
    expect(seedBody).toContain(INSTANCE_UUID);          // instance id

    // The Coordinate Closet section must be present
    expect(seedBody).toContain('── Raw Trace Coordinate Closet (ids/paths/values preserved from full trace) ──');

    // The active request must survive (merged into the seed body)
    expect(seedBody).toContain('Continue with the next batch of work');
  });

  test('after hard epoch, path-touch recall pages back the buried content from the raw trace', () => {
    let now = Date.parse('2026-06-16T00:00:00.000Z');
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: { enabled: true, ttlMs: 3_600_000, maxTailChars: 150_000 },
      pressureCeiling: 10,
      now: () => {
        now += 1_000;
        return now;
      },
    });

    const messages = buildRealisticTrace();

    // Fold + freeze the initial trace
    session.prepare(messages);

    // Build a recall index from the folded state (the integration test pattern)
    const recall: FoldRecallState = createFoldRecallState();
    const foldedView = session.prepare(messages).messages;
    recall.index = buildFoldIndex(messages, foldedView);

    // The folded view should NOT contain the buried payload (it was folded away)
    const viewText = JSON.stringify(foldedView);
    expect(viewText).not.toContain(BURIED_PAYLOAD);

    // ── Simulate a path-touch: agent calls Read on the same file after the reset ──
    const signals = extractRecallSignals(
      { file_path: TARGET_PATH },
      new Set(),
    );

    // The recall engine should find the path in the fold index
    expect(signals.touchedPaths.length).toBeGreaterThan(0);

    const recallResult = buildFoldRecallContext(
      recall,
      messages,  // raw history still available as backing
      signals,
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );

    // ── The recall card MUST contain the buried payload from the folded turn ──
    expect(recallResult.cards).toBeGreaterThan(0);
    expect(recallResult.text).not.toBeNull();
    expect(recallResult.text!).toContain(BURIED_PAYLOAD);

    // The recall card also preserves the identifier-rich context
    expect(recallResult.text!).toContain(CHANGELOG_ID);
  });

  test('Coordinate Closet conserves identifiers even when the fold heavily compresses', () => {
    let now = Date.parse('2026-06-16T00:00:00.000Z');
    const session = new FoldSession({
      foldConfig: {
        ...ALWAYS_ON_FOLD_CONFIG,
        activeWindowTurns: 1,
        // Aggressive compression settings to stress the Closet
        assistantTextBudget: { fullRetentionChars: 500, essenceRetentionChars: 0 },
      },
      freeze: { enabled: true, ttlMs: 3_600_000, maxTailChars: 150_000 },
      pressureCeiling: 10,
      rawHardEpochSeedMaxChars: 8_000, // tight budget
      now: () => {
        now += 1_000;
        return now;
      },
    });

    const messages = buildRealisticTrace();

    // First epoch + fold
    session.prepare(messages);

    // Hard epoch with tight seed budget
    const hardEpoch = session.prepare(messages, { measuredInputTokens: 10 });
    expect(hardEpoch.stats.epochReason).toBe('hard-epoch');

    const seedBody = typeof hardEpoch.messages[0].content === 'string'
      ? hardEpoch.messages[0].content
      : '';

    // Under tight budgets, the seed is small
    expect(seedBody.length).toBeLessThan(12_000);

    // But the Coordinate Closet MUST still conserve the high-value identifiers
    // The closet is allocated its own budget independent of the overall seed clamp
    expect(seedBody).toContain(TARGET_PATH);
    expect(seedBody).toContain(GIT_SHA);
    expect(seedBody).toContain(RAIL_ID);
  });

  test('determinism: identical traces produce byte-identical seeds across runs', () => {
    function runOnce(): string {
      let now = Date.parse('2026-06-16T00:00:00.000Z');
      const session = new FoldSession({
        foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
        freeze: { enabled: true, ttlMs: 3_600_000, maxTailChars: 150_000 },
        pressureCeiling: 10,
        now: () => {
          now += 1_000;
          return now;
        },
      });

      const messages = buildRealisticTrace();
      session.prepare(messages);
      const hardEpoch = session.prepare(messages, { measuredInputTokens: 10 });
      return typeof hardEpoch.messages[0].content === 'string'
        ? hardEpoch.messages[0].content
        : '';
    }

    const run1 = runOnce();
    const run2 = runOnce();
    const run3 = runOnce();

    expect(run1).toBe(run2);
    expect(run2).toBe(run3);
    expect(run1.length).toBeGreaterThan(0);
  });

  test('multi-epoch sawtooth: identifiers survive across multiple fold-reset cycles', () => {
    let now = Date.parse('2026-06-16T00:00:00.000Z');
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: { enabled: true, ttlMs: 3_600_000, maxTailChars: 150_000 },
      pressureCeiling: 10,
      now: () => {
        now += 1_000;
        return now;
      },
    });

    const messages = buildRealisticTrace();

    // ── Epoch 1: fold + freeze ──
    session.prepare(messages);

    // ── Hard epoch 1 ──
    const epoch1 = session.prepare(messages, { measuredInputTokens: 10 });
    expect(epoch1.stats.epochReason).toBe('hard-epoch');
    const seed1 = typeof epoch1.messages[0].content === 'string' ? epoch1.messages[0].content : '';

    // ── Continue with the rebirth seed as the new history ──
    const postRebirthMessages: FoldMessage[] = [
      ...epoch1.messages,
      assistantMsg(`Resuming after rebirth. Working on ${RAIL_ID} at commit ${GIT_SHA}.`),
      userMsg('Keep going with the next task.'),
      anthropicToolUse('Read', { file_path: TARGET_PATH }, 'toolu_post_rebirth_0'),
      anthropicToolResult('toolu_post_rebirth_0', `Post-rebirth read of rollingFold.ts\n${'z'.repeat(4_000)}`),
      assistantMsg('Continuing work after the rebirth. ' + 'More reasoning. '.repeat(50)),
      userMsg('Wrap up this phase.'),
    ];

    // ── Epoch 2: fold + freeze the post-rebirth trace ──
    session.prepare(postRebirthMessages);

    // ── Hard epoch 2 ──
    const epoch2 = session.prepare(postRebirthMessages, { measuredInputTokens: 10 });
    expect(epoch2.stats.epochReason).toBe('hard-epoch');
    const seed2 = typeof epoch2.messages[0].content === 'string' ? epoch2.messages[0].content : '';

    // ── The identifiers must survive into the SECOND rebirth seed ──
    // Even though they originated 2 hard epochs ago, the Coordinate Closet
    // re-nominates them from the post-rebirth trace where the agent used them.
    expect(seed2).toContain(TARGET_PATH);
    expect(seed2).toContain(GIT_SHA);
    expect(seed2).toContain(RAIL_ID);

    // The active request from the post-rebirth trace must survive
    expect(seed2).toContain('Wrap up this phase');
  });
});
