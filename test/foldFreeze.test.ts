/**
 * Tests for foldFreeze.ts — cache-aware gating for the rolling-fold pipeline.
 *
 * The contract under test: while the provider prompt cache is hot, the frozen
 * pipeline output is reused BYTE-IDENTICAL (element reference identity) with
 * new raw messages appended after it; the pipeline only re-runs at epochs
 * (cold TTL gap, raw-tail cap, context change, integrity divergence).
 */

import { describe, it, expect } from 'vitest';
import {
  createFoldFreezeState,
  evaluateFoldFreeze,
  commitFoldFreeze,
  appendFoldFreezeTailEpoch,
  touchFoldFreeze,
  resolveFoldFreezeConfig,
  DEFAULT_FOLD_FREEZE_CONFIG,
  type FoldFreezeConfig,
  type FoldFreezeContext,
  type FoldFreezeState,
} from '../src/foldFreeze.js';
import type { FoldMessage } from '../src/rollingFold.js';

const msg = (role: string, content: string): FoldMessage => ({ role, content });

/** Freeze context helper: thinning mode + current global claimed paths. */
const ctx = (thinningMode = 'off', claims: string[] = []): FoldFreezeContext => ({
  thinningMode,
  claimedPaths: new Set(claims),
});

const CFG: FoldFreezeConfig = { enabled: true, ttlMs: 300_000, maxTailChars: 1_000 };
const T0 = 1_000_000;

/** Build a state frozen at T0 over a 4-message history, returning all parts. */
function frozenFixture(): {
  state: FoldFreezeState;
  history: FoldMessage[];
  view: FoldMessage[];
} {
  const state = createFoldFreezeState();
  const history = [
    msg('user', 'first question'),
    msg('assistant', 'first answer'),
    msg('user', 'second question'),
    msg('assistant', 'second answer'),
  ];
  // Simulated pipeline output: a folded skeleton pair + the active window.
  const view = [
    msg('user', '[folded: 1 turn skeleton]'),
    msg('assistant', 'Continuing.'),
    history[2],
    history[3],
  ];
  commitFoldFreeze(state, history, view, ctx(), T0);
  return { state, history, view };
}

describe('evaluateFoldFreeze — decision branches', () => {
  it('recomputes on first call (no frozen view)', () => {
    const state = createFoldFreezeState();
    const decision = evaluateFoldFreeze(state, [msg('user', 'hi')], ctx(), T0, CFG);
    expect(decision).toMatchObject({ action: 'recompute', reason: 'first-call' });
  });

  it('reuses hot with an empty tail and exact element identity', () => {
    const { state, history, view } = frozenFixture();
    const decision = evaluateFoldFreeze(state, history, ctx(), T0 + 1_000, CFG);
    expect(decision.action).toBe('reuse');
    if (decision.action !== 'reuse') return;
    expect(decision.tailCount).toBe(0);
    expect(decision.tailChars).toBe(0);
    expect(decision.view).toHaveLength(view.length);
    for (let i = 0; i < view.length; i++) {
      expect(decision.view[i]).toBe(view[i]); // reference identity = byte identity
    }
  });

  it('reuses hot with appended raw tail (frozen prefix + tail refs)', () => {
    const { state, view } = frozenFixture();
    const tailA = msg('assistant', 'tool call round');
    const tailB = msg('user', 'tool result round');
    const grown = [
      msg('user', 'first question'),
      msg('assistant', 'first answer'),
      msg('user', 'second question'),
      msg('assistant', 'second answer'),
      tailA,
      tailB,
    ];
    const decision = evaluateFoldFreeze(state, grown, ctx(), T0 + 1_000, CFG);
    expect(decision.action).toBe('reuse');
    if (decision.action !== 'reuse') return;
    expect(decision.tailCount).toBe(2);
    expect(decision.tailChars).toBeGreaterThan(0);
    expect(decision.view).toHaveLength(view.length + 2);
    for (let i = 0; i < view.length; i++) expect(decision.view[i]).toBe(view[i]);
    expect(decision.view[view.length]).toBe(tailA);
    expect(decision.view[view.length + 1]).toBe(tailB);
  });

  it('evaluate does not mutate state (touch is explicit)', () => {
    const { state, history } = frozenFixture();
    const before = { ...state };
    evaluateFoldFreeze(state, history, ctx(), T0 + 1_000, CFG);
    expect(state.lastCallAt).toBe(before.lastCallAt);
    expect(state.hotReuses).toBe(before.hotReuses);
    expect(state.epochs).toBe(before.epochs);
  });

  it('treats a gap of exactly ttlMs as hot (strict >), beyond as cold', () => {
    const { state, history } = frozenFixture();
    const atTtl = evaluateFoldFreeze(state, history, ctx(), T0 + CFG.ttlMs, CFG);
    expect(atTtl.action).toBe('reuse');
    const pastTtl = evaluateFoldFreeze(state, history, ctx(), T0 + CFG.ttlMs + 1, CFG);
    expect(pastTtl).toMatchObject({ action: 'recompute', reason: 'cold-gap' });
    if (pastTtl.action === 'recompute') expect(pastTtl.gapMs).toBe(CFG.ttlMs + 1);
  });

  it('sliding TTL: touch keeps the window hot across a span longer than the TTL', () => {
    const { state, history } = frozenFixture();
    // Total elapsed will be 2x TTL, but each hop is under it.
    const hop = CFG.ttlMs - 10_000;
    const t1 = T0 + hop;
    const d1 = evaluateFoldFreeze(state, history, ctx(), t1, CFG);
    expect(d1.action).toBe('reuse');
    touchFoldFreeze(state, t1);
    const t2 = t1 + hop;
    const d2 = evaluateFoldFreeze(state, history, ctx(), t2, CFG);
    expect(d2.action).toBe('reuse');
  });

  it('recomputes when the thinning mode changes', () => {
    const { state, history } = frozenFixture();
    const decision = evaluateFoldFreeze(state, history, ctx('safe'), T0 + 1_000, CFG);
    expect(decision).toMatchObject({ action: 'recompute', reason: 'context-changed', detail: 'thinning-mode' });
  });

  it('recomputes when history rewinds below the frozen coverage', () => {
    const { state, history } = frozenFixture();
    const decision = evaluateFoldFreeze(state, history.slice(0, 2), ctx(), T0 + 1_000, CFG);
    expect(decision).toMatchObject({ action: 'recompute', reason: 'history-rewound' });
  });

  it('recomputes when the boundary message diverges (in-place rewrite)', () => {
    const { state, history } = frozenFixture();
    const diverged = [...history.slice(0, 3), msg('assistant', 'a completely different and longer second answer')];
    const decision = evaluateFoldFreeze(state, diverged, ctx(), T0 + 1_000, CFG);
    expect(decision).toMatchObject({ action: 'recompute', reason: 'boundary-mismatch' });
  });

  it('recomputes when the boundary role diverges', () => {
    const { state, history } = frozenFixture();
    const diverged = [...history.slice(0, 3), msg('user', 'second answer')];
    const decision = evaluateFoldFreeze(state, diverged, ctx(), T0 + 1_000, CFG);
    expect(decision).toMatchObject({ action: 'recompute', reason: 'boundary-mismatch' });
  });

  it('recomputes on same-length in-place content rewrite (boundary hash guard)', () => {
    // frozenFixture boundary is msg('assistant', 'second answer') — 13 chars.
    // Replace with same role + same char count but different content.
    // role+charCount match would pass the old check; the FNV-1a hash must catch it.
    const { state, history } = frozenFixture();
    const sameLength = 'second answer'.length; // 13
    const tampered = [...history.slice(0, 3), msg('assistant', 'x'.repeat(sameLength))];
    const decision = evaluateFoldFreeze(state, tampered, ctx(), T0 + 1_000, CFG);
    expect(decision).toMatchObject({ action: 'recompute', reason: 'boundary-mismatch', detail: 'boundary-hash' });
  });

  it('still reuses when history is byte-identical after commit stores boundaryHash', () => {
    // Regression guard: storing boundaryHash must not break the normal hot-reuse path.
    const { state, history } = frozenFixture();
    expect(state.boundaryHash).toBeDefined(); // commit stored a hash
    const decision = evaluateFoldFreeze(state, history, ctx(), T0 + 1_000, CFG);
    expect(decision.action).toBe('reuse');
  });

  it('recomputes on same-length reasoning_content rewrite (whole-message fingerprint)', () => {
    const state = createFoldFreezeState();
    const history: FoldMessage[] = [
      msg('user', 'question'),
      { role: 'assistant', content: 'stable answer', reasoning_content: 'abcdef' },
    ];
    commitFoldFreeze(state, history, history.slice(), ctx(), T0);
    const tampered: FoldMessage[] = [
      history[0],
      { role: 'assistant', content: 'stable answer', reasoning_content: 'uvwxyz' },
    ];
    // charCount identical (same-length reasoning_content), role identical —
    // only the whole-message hash can catch this rewrite.
    const decision = evaluateFoldFreeze(state, tampered, ctx(), T0 + 1_000, CFG);
    expect(decision).toMatchObject({ action: 'recompute', reason: 'boundary-mismatch', detail: 'boundary-hash' });
  });

  it('forces a tail-epoch when the raw overhang exceeds maxTailChars', () => {
    const { state, history } = frozenFixture();
    const whale = msg('user', 'x'.repeat(CFG.maxTailChars + 500));
    const decision = evaluateFoldFreeze(state, [...history, whale], ctx(), T0 + 1_000, CFG);
    expect(decision).toMatchObject({ action: 'recompute', reason: 'tail-epoch' });
  });
});

describe('commitFoldFreeze / touchFoldFreeze — state transitions', () => {
  it('commit captures coverage, boundary fingerprint, and telemetry', () => {
    const { state, history, view } = frozenFixture();
    expect(state.frozenRawCount).toBe(history.length);
    expect(state.frozenView).toHaveLength(view.length);
    expect(state.boundaryRole).toBe('assistant');
    expect(state.boundaryChars).toBeGreaterThan(0);
    expect(state.frozenViewChars).toBeGreaterThan(0);
    expect(state.epochs).toBe(1);
    expect(state.hotReuses).toBe(0);
    expect(state.lastCallAt).toBe(T0);
  });

  it('commit stores a shallow copy: later array mutation cannot corrupt the frozen view', () => {
    const { state, view } = frozenFixture();
    view.push(msg('user', 'late push by caller'));
    expect(state.frozenView).toHaveLength(view.length - 1);
  });

  it('append tail epoch preserves the old frozen view as a byte-identical prefix', () => {
    const { state, history, view } = frozenFixture();
    const tailRaw = [
      msg('user', 'new whale '.repeat(80)),
      msg('assistant', 'folded whale summary'),
    ];
    const tailFolded = [msg('user', '[folded tail band]'), tailRaw[1]];
    const grown = [...history, ...tailRaw];

    const appended = appendFoldFreezeTailEpoch(state, grown, tailFolded, ctx(), T0 + 4_000);

    expect(appended).not.toBeNull();
    expect(appended?.sealedPrefixMessageCount).toBe(view.length);
    expect(appended?.view).toHaveLength(view.length + tailFolded.length);
    for (let i = 0; i < view.length; i++) expect(appended?.view[i]).toBe(view[i]);
    expect(appended?.view[view.length]).toBe(tailFolded[0]);
    expect(state.frozenRawCount).toBe(grown.length);
    expect(state.frozenView?.slice(0, view.length)).toEqual(view);
    expect(state.lastAppendBoundaryViewCount).toBe(view.length);
    expect(state.epochs).toBe(2);
  });

  it('touch bumps hotReuses and slides lastCallAt; commit resets hotReuses and bumps epochs', () => {
    const { state, history } = frozenFixture();
    touchFoldFreeze(state, T0 + 1_000);
    touchFoldFreeze(state, T0 + 2_000);
    expect(state.hotReuses).toBe(2);
    expect(state.lastCallAt).toBe(T0 + 2_000);
    commitFoldFreeze(state, history, [msg('user', 'refolded')], ctx(), T0 + 3_000);
    expect(state.hotReuses).toBe(0);
    expect(state.epochs).toBe(2);
    expect(state.lastCallAt).toBe(T0 + 3_000);
  });

  it('empty-history commit is safe and reuse returns the pure tail', () => {
    const state = createFoldFreezeState();
    commitFoldFreeze(state, [], [], ctx(), T0);
    expect(state.frozenRawCount).toBe(0);
    expect(state.boundaryRole).toBe('');
    const tail = [msg('user', 'fresh start')];
    const decision = evaluateFoldFreeze(state, tail, ctx(), T0 + 1_000, CFG);
    expect(decision.action).toBe('reuse');
    if (decision.action !== 'reuse') return;
    expect(decision.view).toHaveLength(1);
    expect(decision.view[0]).toBe(tail[0]);
  });
});

describe('claims-relevance epoch gating', () => {
  const ABS = '/home/jonah/my-monorepo/relay/src/sessionHooks.ts';
  const REL = 'relay/src/sessionHooks.ts';

  /** History containing one Anthropic-style tool_use on sessionHooks.ts. */
  const toolHistory = (): FoldMessage[] => [
    msg('user', 'read the session hooks'),
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reading' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { file_path: ABS } },
      ],
    },
    msg('user', 'tool result payload'),
    msg('assistant', 'done reading'),
  ];

  function freezeWith(claims: string[]): { state: FoldFreezeState; history: FoldMessage[] } {
    const state = createFoldFreezeState();
    const history = toolHistory();
    commitFoldFreeze(state, history, history.slice(), ctx('off', claims), T0);
    return { state, history };
  }

  it('reuses when a claim lands on a path the session never touched (cross-agent thrash fix)', () => {
    const { state, history } = freezeWith([]);
    const decision = evaluateFoldFreeze(
      state, history, ctx('off', ['relay/src/somebodyElsesFile.ts', '/home/jonah/vet-soap/x.md']), T0 + 1_000, CFG,
    );
    expect(decision.action).toBe('reuse');
  });

  it('epochs when a claim lands on a tool path in the frozen coverage', () => {
    const { state, history } = freezeWith([]);
    const decision = evaluateFoldFreeze(state, history, ctx('off', [REL]), T0 + 1_000, CFG);
    expect(decision).toMatchObject({ action: 'recompute', reason: 'context-changed', detail: `claim ${REL}` });
  });

  it('normalizes absolute claim keys against tool paths (abs claim ↔ abs tool arg)', () => {
    const { state, history } = freezeWith([]);
    const decision = evaluateFoldFreeze(state, history, ctx('off', [ABS]), T0 + 1_000, CFG);
    expect(decision).toMatchObject({ action: 'recompute', reason: 'context-changed' });
  });

  it('reuses when a relevant-at-freeze claim is released (re-fold deferred to natural epoch)', () => {
    const { state, history } = freezeWith([REL]);
    const decision = evaluateFoldFreeze(state, history, ctx('off', []), T0 + 1_000, CFG);
    expect(decision.action).toBe('reuse');
  });

  it('reuses when a relevant-at-freeze claim persists or is re-claimed', () => {
    const { state, history } = freezeWith([REL]);
    const decision = evaluateFoldFreeze(state, history, ctx('off', [ABS]), T0 + 1_000, CFG);
    expect(decision.action).toBe('reuse');
  });

  it('reuses when a claim matches only a TAIL tool path (tail rides verbatim until next epoch)', () => {
    const { state, history } = freezeWith([]);
    const grown = [
      ...history,
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_tail', name: 'edit_file', input: { file_path: 'relay/src/tailOnly.ts' } }],
      },
      msg('user', 'tail tool result'),
    ];
    const decision = evaluateFoldFreeze(state, grown, ctx('off', ['relay/src/tailOnly.ts']), T0 + 1_000, CFG);
    expect(decision.action).toBe('reuse');
  });

  it('detects OpenAI-style tool_calls paths in the coverage', () => {
    const state = createFoldFreezeState();
    const history: FoldMessage[] = [
      msg('user', 'edit it'),
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tc_1', function: { name: 'edit_file', arguments: JSON.stringify({ file_path: 'relay/src/viaToolCalls.ts' }) } },
        ],
      },
      msg('assistant', 'edited'),
    ];
    commitFoldFreeze(state, history, history.slice(), ctx(), T0);
    const decision = evaluateFoldFreeze(state, history, ctx('off', ['relay/src/viaToolCalls.ts']), T0 + 1_000, CFG);
    expect(decision).toMatchObject({ action: 'recompute', reason: 'context-changed' });
  });

  it('claims-before-freeze on never-touched paths stay irrelevant across the whole streak', () => {
    // Freeze WITH an irrelevant claim held; later calls with it still held,
    // released, or joined by more irrelevant claims must all reuse.
    const { state, history } = freezeWith(['relay/src/neverTouched.ts']);
    expect(evaluateFoldFreeze(state, history, ctx('off', ['relay/src/neverTouched.ts']), T0 + 1_000, CFG).action).toBe('reuse');
    expect(evaluateFoldFreeze(state, history, ctx('off', []), T0 + 2_000, CFG).action).toBe('reuse');
    expect(evaluateFoldFreeze(state, history, ctx('off', ['relay/src/another.ts', 'app/components/x.tsx']), T0 + 3_000, CFG).action).toBe('reuse');
  });
});

describe('resolveFoldFreezeConfig — env parsing', () => {
  it('defaults to enabled with documented defaults', () => {
    const cfg = resolveFoldFreezeConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.ttlMs).toBe(DEFAULT_FOLD_FREEZE_CONFIG.ttlMs);
    expect(cfg.maxTailChars).toBe(DEFAULT_FOLD_FREEZE_CONFIG.maxTailChars);
  });

  it.each(['0', 'false', 'off', 'no', ' OFF ', 'False'])('disables on WARP_FOLD_FREEZE=%s', (raw) => {
    expect(resolveFoldFreezeConfig({ WARP_FOLD_FREEZE: raw }).enabled).toBe(false);
  });

  it.each(['1', 'true', 'on', ''])('stays enabled on WARP_FOLD_FREEZE=%s', (raw) => {
    expect(resolveFoldFreezeConfig({ WARP_FOLD_FREEZE: raw }).enabled).toBe(true);
  });

  it('honors numeric TTL and tail-cap overrides', () => {
    const cfg = resolveFoldFreezeConfig({
      WARP_FOLD_FREEZE_TTL_MS: '60000',
      WARP_FOLD_FREEZE_MAX_TAIL_CHARS: '50000',
    });
    expect(cfg.ttlMs).toBe(60_000);
    expect(cfg.maxTailChars).toBe(50_000);
  });

  it('uses caller defaults for TTL and tail cap when env is unset', () => {
    const cfg = resolveFoldFreezeConfig({}, { ttlMs: 3_600_000, maxTailChars: 100_000 });
    expect(cfg.ttlMs).toBe(3_600_000);
    expect(cfg.maxTailChars).toBe(100_000);
  });

  it('keeps explicit env overrides ahead of caller defaults', () => {
    const cfg = resolveFoldFreezeConfig(
      {
        WARP_FOLD_FREEZE_TTL_MS: '60000',
        WARP_FOLD_FREEZE_MAX_TAIL_CHARS: '50000',
      },
      { ttlMs: 3_600_000, maxTailChars: 100_000 },
    );
    expect(cfg.ttlMs).toBe(60_000);
    expect(cfg.maxTailChars).toBe(50_000);
  });

  it('ignores invalid numeric overrides (garbage, zero, negative)', () => {
    const cfg = resolveFoldFreezeConfig({
      WARP_FOLD_FREEZE_TTL_MS: 'abc',
      WARP_FOLD_FREEZE_MAX_TAIL_CHARS: '-5',
    });
    expect(cfg.ttlMs).toBe(DEFAULT_FOLD_FREEZE_CONFIG.ttlMs);
    expect(cfg.maxTailChars).toBe(DEFAULT_FOLD_FREEZE_CONFIG.maxTailChars);
  });
});
