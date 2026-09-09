/**
 * Golden format gate for the rendered fold-recall card.
 *
 * ORIGINAL CHARTER (DISCHARGED): this file was created to freeze renderCard
 * output BEFORE the Fold Recall Unification carriers (pathEpisodes,
 * pathAtlasMeta) were added, so that "step 11b" could prove empty new carriers
 * produced byte-identical output. That migration closed and the proof was
 * delivered; the file no longer has a pre-change baseline to compare against,
 * and it must not keep claiming that it does.
 *
 * CURRENT CHARTER: this is the only test that freezes the COMPLETE rendered
 * card text end to end through the real compaction pipeline
 * (intraTurnFold -> checkFoldTrigger -> foldContext -> buildFoldRecallContext).
 * The card is a model-visible surface: agents read it at tool boundaries and
 * downstream tooling parses its header and its Chronological Provenance line.
 * The gate therefore guards against ACCIDENTAL format churn — a header token
 * moving, a provenance clause silently changing shape, a marker disappearing.
 * It is not a correctness proof of recall selection; the foldRecall behavioural
 * suites own that.
 *
 * HOW TO CHANGE A SNAPSHOT HERE: a mismatch is a decision point, never a
 * rubber stamp. Re-freeze only with the intended delta named in the commit
 * record, the same shape S17's mistake registry uses. Silently accepting a diff
 * turns this gate into a rubber stamp that reports "green" while the surface
 * drifts.
 *
 * SNAPSHOTS RE-FROZEN 2026-09-09 (rail-72adf723 S22) for three intended
 * renderer changes, all pre-existing and all deliberate:
 *   1. Salient-turn omission marker: the header now reports partial inclusion
 *      as "M of N chars folded · salient turn" instead of a bare "N chars
 *      folded", so a card that carries only part of a turn says so.
 *   2. Chronological Provenance range end + seam marker: the range now renders
 *      "#0..#3 (inclusive)" where it previously rendered "#0..#4". The old text
 *      was arithmetically ambiguous against its own n=4 (0..4 inclusive is five
 *      messages, exclusive is four); the explicit inclusive seam resolves it.
 *      This one is a CORRECTNESS repair, not cosmetics.
 *   3. Raw-resume census: "raw-resumes=none" now carries its exact count as
 *      "raw-resumes=none (0 exact)".
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

describe('foldRecall rendered-card format gate', () => {
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
      "[Recalled from fold — research turn (relay/src/baseline-target.ts) | trigger: path-touch relay/src/baseline-target.ts | 3,100 of 3,260 chars folded · salient turn]
      [Chronological Provenance v1] artifact=fold-recall#turn:0 class=retrieved-history source=?:message#0..?:message#3 (inclusive) n=4 @ time unknown..time unknown created=?:message#8 @ time unknown authority=historical-background supersession=none-known origin=derived topology=raw-history>artifact>none host=dedicated-synthetic-message representation=canonical raw-resumes=none (0 exact)
      ↞ source episode: Read · relay/src/baseline-target.ts
        ↳ Atlas drill-down unavailable
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
    // A genuine partial edit (shared head/tail context) so the delta clears the
    // context floor; the path-touch trigger keeps the HISTORICAL body and the
    // notifier carries the drift hunk.
    const bigContent = ['BASELINE CTX HEAD', 'BASELINE OLD MIDDLE ' + 'x'.repeat(3_000), 'BASELINE CTX TAIL'].join('\n');
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
      liveSource: ['BASELINE CTX HEAD', 'BASELINE NEW MIDDLE', 'BASELINE CTX TAIL'].join('\n'),
    });

    const out = buildFoldRecallContext(
      state,
      raw,
      extractRecallSignals({ file_path: ABS(FILE) }, new Set()),
      'healthy',
      DEFAULT_FOLD_RECALL_CONFIG,
    );

    expect(out.text).toMatchInlineSnapshot(`
      "[Recalled from fold — research turn (relay/src/baseline-target.ts) | trigger: path-touch relay/src/baseline-target.ts | 3,134 of 3,296 chars folded · salient turn]
      [Chronological Provenance v1] artifact=fold-recall#turn:0 class=retrieved-history source=?:message#0..?:message#3 (inclusive) n=4 @ time unknown..time unknown created=?:message#8 @ time unknown authority=historical-background supersession=none-known origin=derived topology=raw-history>artifact>none host=dedicated-synthetic-message representation=canonical raw-resumes=none (0 exact)
      ↞ source episode: Read · relay/src/baseline-target.ts
        ↳ Atlas drill-down unavailable
      Δ Source changed since fold — body below is the HISTORICAL folded copy; fresh-read before relying on it; what changed:
      relay/src/baseline-target.ts (liveHash=new-hash)
      @@ ~line 2 @@
      − BASELINE OLD MIDDLE xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…
      + BASELINE NEW MIDDLE
      User asked: Read baseline-target.ts

      Reviewed baseline-target.ts for issues.

      BASELINE CTX HEAD
      BASELINE OLD MIDDLE xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
      BASELINE CTX TAIL
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
