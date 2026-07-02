/**
 * Golden baseline test: freezes the EXACT renderCard output for known inputs
 * BEFORE the Fold Recall Unification carriers (pathEpisodes, pathAtlasMeta)
 * are added. After the carriers are implemented, step 11b re-runs this test
 * to prove empty new carriers = byte-identical output.
 *
 * This is the only honest way to prove byte-identical safety: compare the
 * changed code's output to a PRE-CHANGE frozen string, not to itself.
 */
import { describe, expect, test } from 'vitest';

import {
  buildFoldRecallContext,
  buildFoldIndex,
  createFoldRecallState,
  DEFAULT_FOLD_RECALL_CONFIG,
  extractRecallSignals,
  type FoldRecallConfig,
} from '../src/foldRecall.ts';
import {
  ALWAYS_ON_FOLD_CONFIG,
  ALWAYS_ON_INTRA_FOLD_CONFIG,
  RECALL_CARD_PREFIX,
  checkFoldTrigger,
  foldContext,
  intraTurnFold,
  type FoldMessage,
} from '../src/rollingFold.ts';

function userMsg(text: string): FoldMessage {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): FoldMessage {
  return { role: 'assistant', content: text };
}

function anthropicToolUse(id: string, name: string, input: Record<string, unknown>): FoldMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] };
}

function anthropicToolResult(toolUseId: string, content: string): FoldMessage {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] };
}

const ABS = (rel: string) => `/home/jonah/voxxo-swarm/${rel}`;
const FILE = 'relay/src/baseline-target.ts';

/** The real compaction pipeline as fcBaseSession runs it (fold mode 'on'). */
function runPipeline(raw: FoldMessage[]): FoldMessage[] {
  const intra = intraTurnFold(raw, ALWAYS_ON_INTRA_FOLD_CONFIG);
  const trigger = checkFoldTrigger(intra.messages, ALWAYS_ON_FOLD_CONFIG);
  if (!trigger.shouldFold) return intra.messages;
  return foldContext(intra.messages, trigger.turnsToFold, ALWAYS_ON_FOLD_CONFIG).messages;
}

/** Build a proper FoldRecallIndex using the real builder, like existing tests. */
function indexFor(raw: FoldMessage[]) {
  return buildFoldIndex(raw, runPipeline(raw));
}

describe('foldRecall golden baseline (pre-unification)', () => {
  /**
   * CASE 1: A single path-touch trigger with one folded turn. No radar, no
   * deltas, no episodes — the simplest case. The full output text is frozen.
   */
  test('CASE 1: no-enrichment path-touch card output is frozen', () => {
    // Build a history that the real pipeline will actually fold: needs enough
    // content to trigger inter-turn folding.
    const bigContent = 'BASELINE FILE CONTENT ' + 'x'.repeat(3_000);
    const raw: FoldMessage[] = [
      userMsg('Read baseline-target.ts'),
      anthropicToolUse('tu1', 'Read', { file_path: ABS(FILE) }),
      anthropicToolResult('tu1', bigContent),
      assistantMsg('Reviewed baseline-target.ts for issues.'),
      userMsg('Now do something else'),
      anthropicToolUse('tu2', 'Read', { file_path: ABS('relay/src/other.ts') }),
      anthropicToolResult('tu2', 'OTHER CONTENT ' + 'y'.repeat(3_000)),
      assistantMsg('Done with other.'),
    ];

    const state = createFoldRecallState();
    state.index = indexFor(raw);

    const out = buildFoldRecallContext(
      state,
      raw,
      extractRecallSignals({ file_path: ABS(FILE) }, new Set()),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );

    // Guard: this test is only meaningful if the pipeline actually folded
    // and produced a recall card. If not, the seed history needs adjustment.
    if (out.cards === 0) {
      // Skip gracefully if the pipeline didn't fold (can happen with small inputs).
      // Still snapshot the empty output so the baseline is captured.
    }
    expect(out.text).toMatchInlineSnapshot(`
      "[Recalled from fold — research turn (relay/src/baseline-target.ts) | trigger: path-touch relay/src/baseline-target.ts | 3,260 chars folded]
      User asked: Read baseline-target.ts

      Reviewed baseline-target.ts for issues.

      BASELINE FILE CONTENT xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
      [End fold recall]"
    `);
    if (out.cards > 0) {
      expect(out.text!).toContain(RECALL_CARD_PREFIX);
      expect(out.text!).toContain('trigger: path-touch');
      expect(out.text!).toContain('[End fold recall]');
    }
  });

  /**
   * CASE 2: A path-touch card with source deltas (liveSource set on state).
   * Exercises the radar prepend block.
   */
  test('CASE 2: source-delta card output is frozen', () => {
    const bigContent = 'BASELINE OLD CONTENT ' + 'x'.repeat(3_000);
    const raw: FoldMessage[] = [
      userMsg('Read baseline-target.ts'),
      anthropicToolUse('tu1', 'Read', { file_path: ABS(FILE) }),
      anthropicToolResult('tu1', bigContent),
      assistantMsg('Reviewed baseline-target.ts for issues.'),
      userMsg('Now do something else'),
      anthropicToolUse('tu2', 'Read', { file_path: ABS('relay/src/other.ts') }),
      anthropicToolResult('tu2', 'OTHER CONTENT ' + 'y'.repeat(3_000)),
      assistantMsg('Done with other.'),
    ];

    const state = createFoldRecallState();
    state.index = indexFor(raw);
    state.pathSourceDeltas.set(FILE, {
      path: FILE,
      liveHash: 'new-hash',
      liveSource: 'BASELINE NEW CONTENT',
    });

    const out = buildFoldRecallContext(
      state,
      raw,
      extractRecallSignals({ file_path: ABS(FILE) }, new Set()),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );

    expect(out.text).toMatchInlineSnapshot(`
      "[Recalled from fold — research turn (relay/src/baseline-target.ts) | trigger: path-touch relay/src/baseline-target.ts | 3,259 chars folded]
      Δ Source changed since fold — body below is CURRENT box source; what changed:
      relay/src/baseline-target.ts (liveHash=new-hash)
      @@ ~line 1 @@
      − BASELINE OLD CONTENT xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…
      + BASELINE NEW CONTENT
      User asked: Read baseline-target.ts

      Reviewed baseline-target.ts for issues.

      ↻ CURRENT box source — relay/src/baseline-target.ts:
      BASELINE NEW CONTENT
      [End fold recall]"
    `);
    if (out.cards > 0) {
      expect(out.text!).toContain('trigger: path-touch');
    }
  });

  /**
   * CASE 3: Budget boundary — maxCardChars truncated card output is frozen.
   * Uses a tight config so the card body is truncated.
   */
  test('CASE 3: budget-boundary truncated card output is frozen', () => {
    const bigContent = 'X'.repeat(5000);
    const raw: FoldMessage[] = [
      userMsg('Read baseline-target.ts'),
      anthropicToolUse('tu1', 'Read', { file_path: ABS(FILE) }),
      anthropicToolResult('tu1', bigContent),
      assistantMsg('Big file content reviewed in detail.'),
      userMsg('Now do something else'),
      anthropicToolUse('tu2', 'Read', { file_path: ABS('relay/src/other.ts') }),
      anthropicToolResult('tu2', 'OTHER ' + 'y'.repeat(3_000)),
      assistantMsg('Done.'),
    ];

    const state = createFoldRecallState();
    state.index = indexFor(raw);

    const tightConfig: FoldRecallConfig = {
      ...DEFAULT_FOLD_RECALL_CONFIG,
      maxCardChars: 200,
    };

    const out = buildFoldRecallContext(
      state,
      raw,
      extractRecallSignals({ file_path: ABS(FILE) }, new Set()),
      'healthy',
      tightConfig,
    );

    expect(out.text).toMatchInlineSnapshot(`"[Fold recall hint — research turn (relay/src/baseline-target.ts) folded earlier (5,235 chars) | trigger: path-touch relay/src/baseline-target.ts | self-tap to recover]"`);
    // Truncated output should be bounded.
    if (out.cards > 0) {
      expect(out.chars).toBeLessThanOrEqual(500);
    }
  });
});
