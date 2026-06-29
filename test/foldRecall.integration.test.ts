/**
 * Fold Recall ⇄ Fold Freeze integration — the full page-out/page-in cycle
 * against the REAL compaction pipeline (intra-turn + inter-turn fold) and the
 * REAL freeze gate, mirroring fcBaseSession.applyCompaction's wiring:
 *
 *   epoch (pipeline + commit + index build)
 *     → tool re-touch of a folded path
 *     → recall card injected at the tool boundary (append-only, rides the tail)
 *     → freeze still evaluates HOT reuse (cache survives recall)
 *     → next epoch refolds the card body away (page-out-again)
 *     → tier-0 path-touch can page the path back in again; claim residency
 *       remains the suppression path
 *     → claims interplay: frozen+folded claim epochs AND recalls; tail-only
 *       claim neither epochs nor recalls.
 */
import { describe, expect, test } from 'vitest';

import {
  buildFoldIndex,
  buildFoldRecallContext,
  createFoldRecallState,
  DEFAULT_FOLD_RECALL_CONFIG,
  extractRecallSignals,
  type FoldRecallState,
} from '../src/foldRecall.js';
import {
  commitFoldFreeze,
  createFoldFreezeState,
  evaluateFoldFreeze,
  type FoldFreezeConfig,
  type FoldFreezeContext,
  type FoldFreezeState,
} from '../src/foldFreeze.js';
import {
  ALWAYS_ON_FOLD_CONFIG,
  ALWAYS_ON_INTRA_FOLD_CONFIG,
  checkFoldTrigger,
  foldContext,
  intraTurnFold,
  RECALL_CARD_PREFIX,
  type FoldMessage,
} from '../src/rollingFold.js';

// ── Session-shaped harness (mirrors fcBaseSession.applyCompaction, fold 'on') ──

const FREEZE_CONFIG: FoldFreezeConfig = { enabled: true, ttlMs: 5 * 60_000, maxTailChars: 150_000 };

function ctx(claimedPaths: string[] = []): FoldFreezeContext {
  return { thinningMode: 'off', claimedPaths: new Set(claimedPaths) };
}

function runPipeline(raw: FoldMessage[]): FoldMessage[] {
  let result = raw;
  const intra = intraTurnFold(result, ALWAYS_ON_INTRA_FOLD_CONFIG);
  if (intra.toolResultsFolded > 0) result = intra.messages;
  const trigger = checkFoldTrigger(result, ALWAYS_ON_FOLD_CONFIG);
  if (trigger.shouldFold) {
    const folded = foldContext(result, trigger.turnsToFold, ALWAYS_ON_FOLD_CONFIG);
    result = folded.messages;
  }
  return result;
}

/** One applyCompaction call: evaluate freeze; on epoch run pipeline, commit, rebuild index. */
function applyCompaction(
  freeze: FoldFreezeState,
  recall: FoldRecallState,
  raw: FoldMessage[],
  context: FoldFreezeContext,
  now: number,
): { view: FoldMessage[]; action: 'reuse' | 'recompute'; reason?: string } {
  const decision = evaluateFoldFreeze(freeze, raw, context, now, FREEZE_CONFIG);
  if (decision.action === 'reuse') {
    freeze.lastCallAt = now;
    return { view: decision.view, action: 'reuse' };
  }
  const view = runPipeline(raw);
  commitFoldFreeze(freeze, raw, view, context, now);
  recall.index = buildFoldIndex(raw, view);
  return { view, action: 'recompute', reason: decision.reason };
}

const ABS = (rel: string) => `/home/jonah/my-monorepo/${rel}`;
const BIGFILE = 'relay/src/bigfile.ts';
const BIGFILE_BODY = 'BIGFILE UNIQUE PAYLOAD ' + 'x'.repeat(3_000);

function userMsg(text: string): FoldMessage {
  return { role: 'user', content: text };
}
function assistantMsg(text: string): FoldMessage {
  return { role: 'assistant', content: text };
}
function toolUse(id: string, name: string, input: Record<string, unknown>): FoldMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] };
}
function toolResult(id: string, content: string): FoldMessage {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] };
}

function buildHistory(): FoldMessage[] {
  return [
    userMsg('Investigate bigfile.ts and report the root cause'),
    toolUse('tu_big', 'Read', { file_path: ABS(BIGFILE) }),
    toolResult('tu_big', BIGFILE_BODY),
    assistantMsg('The root cause in bigfile.ts is the inverted null guard at the top of the handler.'),
    userMsg('Thanks — now move on to the next module'),
    assistantMsg('Moving on to the next module now.'),
  ];
}

// ══════════════════════════════════════════════════════════════════════

describe('fold recall ⇄ fold freeze lifecycle', () => {
  test('epoch → index → re-touch → card rides tail HOT → next epoch pages it back out → tier-0 can page it again', () => {
    const freeze = createFoldFreezeState();
    const recall = createFoldRecallState();
    const raw = buildHistory();
    const t0 = 1_000_000;

    // ── Call 1: first-call epoch builds the frozen view AND the recall index ──
    const first = applyCompaction(freeze, recall, raw, ctx(), t0);
    expect(first.action).toBe('recompute');
    expect(first.reason).toBe('first-call');
    expect(recall.index).not.toBeNull();
    const turnEntries = recall.index!.entries.filter(e => e.kind === 'turn');
    expect(turnEntries.length).toBeGreaterThan(0);
    expect(turnEntries[0].kind === 'turn' && turnEntries[0].paths).toContain(BIGFILE);
    // The folded view no longer carries the original payload.
    expect(JSON.stringify(first.view)).not.toContain('BIGFILE UNIQUE PAYLOAD');

    // ── Tool boundary: agent re-touches the folded path → recall card ──
    const signals = extractRecallSignals({ file_path: ABS(BIGFILE) }, new Set());
    const out = buildFoldRecallContext(recall, raw, signals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(out.cards).toBe(1);
    expect(out.text!).toContain(RECALL_CARD_PREFIX);
    expect(out.text!).toContain('BIGFILE UNIQUE PAYLOAD');

    // The dispatcher appends the card to the tool result OUTPUT → raw history
    // grows append-only (frozen prefix untouched).
    raw.push(toolUse('tu_touch', 'Read', { file_path: ABS(BIGFILE) }));
    raw.push(toolResult('tu_touch', `fresh read output\n\n${out.text}`));

    // ── Call 2 (30s later): freeze must evaluate HOT reuse — recall did not kill the cache ──
    const second = applyCompaction(freeze, recall, raw, ctx(), t0 + 30_000);
    expect(second.action).toBe('reuse');
    // The reused view = frozen prefix + verbatim tail (card present at the tail).
    expect(JSON.stringify(second.view)).toContain('BIGFILE UNIQUE PAYLOAD');
    expect(freeze.epochs).toBe(1);

    // ── A new real turn arrives; cold gap forces the next epoch ──
    raw.push(userMsg('Continue with the follow-up work'));
    raw.push(assistantMsg('Continuing.'));
    const third = applyCompaction(freeze, recall, raw, ctx(), t0 + FREEZE_CONFIG.ttlMs + 60_000);
    expect(third.action).toBe('recompute');
    expect(third.reason).toBe('cold-gap');
    // Page-out-again: the refolded view dropped the recalled body; raw retains it.
    expect(JSON.stringify(third.view)).not.toContain('BIGFILE UNIQUE PAYLOAD');
    expect(JSON.stringify(raw)).toContain('BIGFILE UNIQUE PAYLOAD');

    // ── Tier-0 bypass: immediate re-touch after the refold can page it in again ──
    const again = buildFoldRecallContext(recall, raw, signals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(again.cards).toBeGreaterThan(0);
    expect(again.text!).toContain('BIGFILE UNIQUE PAYLOAD');
  });

  test('claims interplay: frozen+folded claim epochs AND recalls; tail-only claim does neither', () => {
    const freeze = createFoldFreezeState();
    const recall = createFoldRecallState();
    const raw = buildHistory();
    const t0 = 2_000_000;

    applyCompaction(freeze, recall, raw, ctx(), t0);
    expect(freeze.epochs).toBe(1);

    // Tail-only activity on a path the frozen coverage never saw:
    raw.push(toolUse('tu_tail', 'Read', { file_path: ABS('relay/src/tailonly.ts') }));
    raw.push(toolResult('tu_tail', 'tail only content'));

    // (a) Claim on the tail-only path: freeze relevance gating reuses (no
    // epoch) and recall has no folded entry for it (tail is not folded).
    const tailClaim = ctx([ABS('relay/src/tailonly.ts')]);
    const reuse = applyCompaction(freeze, recall, raw, tailClaim, t0 + 10_000);
    expect(reuse.action).toBe('reuse');
    const tailSignals = extractRecallSignals(null, new Set([ABS('relay/src/tailonly.ts')]));
    const noRecall = buildFoldRecallContext(recall, raw, tailSignals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(noRecall.text).toBeNull();

    // (b) Claim on the frozen+folded path: the freeze epochs (claimed paths
    // must unfold promptly — existing behavior) AND tier-1 recall pages the
    // inter-folded turn content back in.
    const bigClaim = ctx([ABS(BIGFILE)]);
    const epoch = applyCompaction(freeze, recall, raw, bigClaim, t0 + 20_000);
    expect(epoch.action).toBe('recompute');
    expect(epoch.reason).toBe('context-changed');
    expect(freeze.epochs).toBe(2);

    const claimSignals = extractRecallSignals(null, new Set([ABS(BIGFILE)]));
    const recalled = buildFoldRecallContext(recall, raw, claimSignals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(recalled.cards).toBe(1);
    expect(recalled.text!).toContain('trigger: claim relay/src/bigfile.ts');
    expect(recalled.text!).toContain('BIGFILE UNIQUE PAYLOAD');
  });

  test('kill switch and fold-off leave the boundary silent', () => {
    const recall = createFoldRecallState();
    const raw = buildHistory();
    recall.index = buildFoldIndex(raw, runPipeline(raw));
    const signals = extractRecallSignals({ file_path: ABS(BIGFILE) }, new Set());

    const disabled = buildFoldRecallContext(recall, raw, signals, 'healthy', { ...DEFAULT_FOLD_RECALL_CONFIG, enabled: false });
    expect(disabled.text).toBeNull();

    // Cleared index (fcBaseSession clears it whenever the freeze-gated fold
    // path is not active) → no recall.
    recall.index = null;
    const cleared = buildFoldRecallContext(recall, raw, signals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(cleared.text).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// Bash-only session lifecycle
// ══════════════════════════════════════════════════════════════════════

describe('fold recall ⇄ fold freeze lifecycle — bash-only session', () => {
  test('bash-only session: epoch → bash-path index → bash re-touch → card → refold cleans → tier-0 can page it again', () => {
    const freeze = createFoldFreezeState();
    const recall = createFoldRecallState();
    const t0 = 3_000_000;

    // History: bash-only turn that will fold behind a second turn
    const raw: FoldMessage[] = [
      userMsg('Read the source file via bash'),
      toolUse('tu_bash', 'Bash', { command: `cat ${ABS(BIGFILE)}` }),
      toolResult('tu_bash', BIGFILE_BODY),
      assistantMsg('Read bigfile.ts via bash — found the root cause.'),
      userMsg('Move on to next task'),
      assistantMsg('Moving on.'),
    ];

    // ── Epoch 1: first-call pipeline + index built with bash-extracted paths ──
    const first = applyCompaction(freeze, recall, raw, ctx(), t0);
    expect(first.action).toBe('recompute');
    expect(first.reason).toBe('first-call');
    expect(recall.index).not.toBeNull();

    const turnEntries = recall.index!.entries.filter(e => e.kind === 'turn');
    expect(turnEntries.length).toBeGreaterThan(0);
    // The inter-folded bash turn must have BIGFILE in its paths
    const bashTurn = turnEntries[0];
    expect(bashTurn.kind === 'turn' && bashTurn.paths).toContain(BIGFILE);
    // Folded view no longer carries the payload
    expect(JSON.stringify(first.view)).not.toContain('BIGFILE UNIQUE PAYLOAD');

    // ── Tool boundary: agent re-touches the folded path via bash → recall card ──
    const signals = extractRecallSignals({ command: `cat ${ABS(BIGFILE)}` }, new Set());
    expect(signals.touchedPaths).toContain(BIGFILE);
    const out = buildFoldRecallContext(recall, raw, signals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(out.cards).toBe(1);
    expect(out.text!).toContain(RECALL_CARD_PREFIX);
    expect(out.text!).toContain('BIGFILE UNIQUE PAYLOAD');

    // Card appended append-only; frozen prefix untouched
    raw.push(toolUse('tu_retouch', 'Bash', { command: `cat ${ABS(BIGFILE)}` }));
    raw.push(toolResult('tu_retouch', `fresh bash output\n\n${out.text}`));

    // ── Freeze evaluates HOT shortly after epoch ──
    const second = applyCompaction(freeze, recall, raw, ctx(), t0 + 30_000);
    expect(second.action).toBe('reuse');
    expect(JSON.stringify(second.view)).toContain('BIGFILE UNIQUE PAYLOAD');
    expect(freeze.epochs).toBe(1);

    // ── Cold gap forces next epoch; card body folds away again ──
    raw.push(userMsg('Continue with follow-up work'));
    raw.push(assistantMsg('Continuing.'));
    const third = applyCompaction(freeze, recall, raw, ctx(), t0 + FREEZE_CONFIG.ttlMs + 60_000);
    expect(third.action).toBe('recompute');
    expect(JSON.stringify(third.view)).not.toContain('BIGFILE UNIQUE PAYLOAD');
    expect(JSON.stringify(raw)).toContain('BIGFILE UNIQUE PAYLOAD');

    // ── Tier-0 bypass: immediate bash re-touch can page it in again ──
    const again = buildFoldRecallContext(recall, raw, signals, 'healthy', DEFAULT_FOLD_RECALL_CONFIG);
    expect(again.cards).toBeGreaterThan(0);
    expect(again.text!).toContain('BIGFILE UNIQUE PAYLOAD');
  });
});
