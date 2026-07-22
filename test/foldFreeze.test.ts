/**
 * Tests for foldFreeze.ts — cache-aware gating for the rolling-fold pipeline.
 *
 * The contract under test: while the provider prompt cache is hot, the frozen
 * pipeline output is reused BYTE-IDENTICAL (element reference identity) with
 * new raw messages appended after it; the pipeline only re-runs at epochs
 * (cold TTL gap, raw-tail cap, context change, integrity divergence).
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import {
  createFoldFreezeState,
  evaluateFoldFreeze,
  consumeFoldFreezeEvaluationState,
  commitFoldFreeze,
  initializeFoldFreezeBase,
  appendFoldFreezeTailEpoch,
  prepareFoldFreezeTailEpochSeal,
  commitFoldFreezeTailEpochSeal,
  touchFoldFreeze,
  serializeFoldFreezeState,
  restoreFoldFreezeState,
  verifySerializedFoldFreezeState,
  getFoldFreezeMetadata,
  resolveFoldFreezeConfig,
  DEFAULT_FOLD_FREEZE_CONFIG,
  APPEND_TAIL_MIN_SHRINK_RATIO,
  isTailEpochEfficiencyAlarm,
  TAIL_EPOCH_EFFICIENCY_ALARM_SHRINK_RATIO,
  summarizeFrozenBands,
  classifyFoldWriteTarget,
  isFoldWriteAllowed,
  assertFoldWriteAllowed,
  FoldFrozenStratumViolation,
  FoldFreezeTailEpochSealConflict,
  NO_FOLD_WRITE_AUTHORITY,
  HARD_EPOCH_MATERIALIZATION,
  MAX_FOLD_FREEZE_RESTORE_VIEW_CHARS,
  type FoldWriteTarget,
  type FoldFreezeConfig,
  type FoldFreezeContext,
  type FoldFreezeState,
  type FoldFreezeSealedBandMetadata,
} from '../src/foldFreeze.ts';
import type { FoldMessage } from '../src/rollingFold.ts';
import {
  renderVaultRowsBlock,
  selectVaultDeltaRows,
  vaultRowFingerprint,
  type VaultRenderRow,
} from '../src/userMessageVault.ts';

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

  it('selects a cold-gap ahead of an over-cap tail only after the cache is strictly cold', () => {
    const { state, history } = frozenFixture();
    const whale = msg('user', 'x'.repeat(CFG.maxTailChars + 500));
    const grown = [...history, whale];

    expect(evaluateFoldFreeze(state, grown, ctx(), T0 + CFG.ttlMs, CFG)).toMatchObject({
      action: 'recompute',
      reason: 'tail-epoch',
    });
    expect(evaluateFoldFreeze(state, grown, ctx(), T0 + CFG.ttlMs + 1, CFG)).toMatchObject({
      action: 'recompute',
      reason: 'cold-gap',
    });
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
    const sealedPrefixBytes = JSON.stringify(view);
    const tailRaw = [
      msg('user', 'new whale '.repeat(80)),
      msg('assistant', 'folded whale summary'),
    ];
    const tailFolded = [msg('user', '[folded tail band]'), tailRaw[1]];
    const grown = [...history, ...tailRaw];

    const appended = appendFoldFreezeTailEpoch(state, grown, tailFolded, ctx(), T0 + 4_000);

    expect(appended.committed).toBe(true);
    if (!appended.committed) return;
    expect(appended.sealedPrefixMessageCount).toBe(view.length);
    expect(appended.view).toHaveLength(view.length + tailFolded.length);
    for (let i = 0; i < view.length; i++) expect(appended.view[i]).toBe(view[i]);
    expect(JSON.stringify(appended.view.slice(0, view.length))).toBe(sealedPrefixBytes);
    expect(appended.view[view.length]).toEqual(tailFolded[0]);
    expect(state.frozenRawCount).toBe(grown.length);
    expect(state.frozenView?.slice(0, view.length)).toEqual(view);
    expect(JSON.stringify(state.frozenView?.slice(0, view.length))).toBe(sealedPrefixBytes);
    expect(state.lastAppendBoundaryViewCount).toBe(view.length);
    expect(state.epochs).toBe(2);
  });

  it('keeps a prepared band, manifest row, and vault fingerprints invisible until publication', () => {
    const { state, history } = frozenFixture();
    state.sealedVaultFingerprints.add('user:already-sealed');
    const before = JSON.stringify(serializeFoldFreezeState(state));
    const tailRaw = [
      msg('user', 'transactional raw tail '.repeat(80)),
      msg('assistant', 'transactional answer'),
    ];
    const tailFolded = [msg('user', '[transactional band]'), tailRaw[1]!];
    const prepared = prepareFoldFreezeTailEpochSeal(
      state,
      [...history, ...tailRaw],
      tailFolded,
      ctx(),
      T0 + 4_000,
      { sealedVaultFingerprints: ['user:pending-band-row'] },
    );

    expect(prepared.prepared).toBe(true);
    expect(JSON.stringify(serializeFoldFreezeState(state))).toBe(before);
    expect(state.sealedBands).toHaveLength(0);
    expect(state.sealedVaultFingerprints.has('user:pending-band-row')).toBe(false);

    // A killed process loses the process-local plan. The successor can only
    // restore the last durable pre-seal snapshot, byte-for-byte.
    const restarted = restoreFoldFreezeState(JSON.parse(before));
    expect(JSON.stringify(serializeFoldFreezeState(restarted))).toBe(before);
    expect(restarted.sealedBands).toHaveLength(0);
    expect(Array.from(restarted.sealedVaultFingerprints)).toEqual(['user:already-sealed']);
  });

  it('a process killed between preparation and publication restarts from the durable pre-seal state', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'fold-freeze-killed-writer-'));
    const snapshotPath = join(tempDir, 'freeze-state.json');
    const childSource = `
      import { writeFile } from 'node:fs/promises';
      import {
        commitFoldFreeze,
        createFoldFreezeState,
        prepareFoldFreezeTailEpochSeal,
        serializeFoldFreezeState,
      } from './src/foldFreeze.ts';

      const state = createFoldFreezeState();
      const history = [
        { role: 'user', content: 'durable question' },
        { role: 'assistant', content: 'durable answer' },
      ];
      commitFoldFreeze(
        state,
        history,
        history.slice(),
        { thinningMode: 'off', claimedPaths: new Set() },
        1_000_000,
      );
      state.sealedVaultFingerprints.add('user:durable-before-seal');
      await writeFile(
        process.env.SEAL_SNAPSHOT_PATH,
        JSON.stringify(serializeFoldFreezeState(state)),
        'utf8',
      );
      const tail = [
        { role: 'user', content: 'kill-window raw tail '.repeat(80) },
        { role: 'assistant', content: 'kill-window answer' },
      ];
      const prepared = prepareFoldFreezeTailEpochSeal(
        state,
        history.concat(tail),
        [{ role: 'user', content: '[prepared kill-window band]' }, tail[1]],
        { thinningMode: 'off', claimedPaths: new Set() },
        1_004_000,
        { sealedVaultFingerprints: ['user:must-not-survive-kill'] },
      );
      if (!prepared.prepared) throw new Error('fixture did not prepare a seal');
      process.stdout.write('PREPARED\\n');
      setInterval(() => undefined, 60_000);
    `;
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '--eval', childSource],
      {
        cwd: process.cwd(),
        env: { ...process.env, SEAL_SNAPSHOT_PATH: snapshotPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    try {
      await new Promise<void>((resolvePrepared, rejectPrepared) => {
        let stdout = '';
        const timeout = setTimeout(
          () => rejectPrepared(new Error(`child preparation timed out: ${stderr}`)),
          5_000,
        );
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
          if (stdout.includes('PREPARED\n')) {
            clearTimeout(timeout);
            resolvePrepared();
          }
        });
        child.once('error', (error) => {
          clearTimeout(timeout);
          rejectPrepared(error);
        });
        child.once('exit', (code, signal) => {
          if (!stdout.includes('PREPARED\n')) {
            clearTimeout(timeout);
            rejectPrepared(new Error(
              `child exited before preparation (code=${code}, signal=${signal}): ${stderr}`,
            ));
          }
        });
      });

      expect(child.kill('SIGKILL')).toBe(true);
      await once(child, 'exit');
      const durable = JSON.parse(await readFile(snapshotPath, 'utf8'));
      const restarted = restoreFoldFreezeState(durable);
      expect(restarted.sealedBands).toHaveLength(0);
      expect(Array.from(restarted.sealedVaultFingerprints))
        .toEqual(['user:durable-before-seal']);
      expect(restarted.sealedVaultFingerprints.has('user:must-not-survive-kill')).toBe(false);
      expect(JSON.stringify(serializeFoldFreezeState(restarted))).toBe(JSON.stringify(durable));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('keeps the caller-visible prepared preview detached from both seal generations', () => {
    const { state, history } = frozenFixture();
    const before = JSON.stringify(serializeFoldFreezeState(state));
    const tailRaw = [
      msg('user', 'detached preview raw tail '.repeat(80)),
      msg('assistant', 'detached preview answer'),
    ];
    const prepared = prepareFoldFreezeTailEpochSeal(
      state,
      [...history, ...tailRaw],
      [msg('user', '[detached preview band]'), tailRaw[1]!],
      ctx(),
      T0 + 4_000,
      { sealedVaultFingerprints: ['user:detached-preview-row'] },
    );
    expect(prepared.prepared).toBe(true);
    if (!prepared.prepared) return;

    prepared.result.view[0]!.content = 'caller rewrote the detached preview';
    expect(JSON.stringify(serializeFoldFreezeState(state))).toBe(before);

    const published = commitFoldFreezeTailEpochSeal(state, prepared);
    expect(published.view[0]!.content).not.toBe('caller rewrote the detached preview');
    expect(state.frozenView?.[0]?.content).not.toBe('caller rewrote the detached preview');
    expect(state.sealedVaultFingerprints.has('user:detached-preview-row')).toBe(true);
  });

  it('detaches the prepared band from caller-owned tail messages', () => {
    const { state, history } = frozenFixture();
    const tailRaw = [
      msg('user', 'caller-owned raw tail '.repeat(80)),
      msg('assistant', 'caller-owned answer'),
    ];
    const callerTailView = [msg('user', '[original prepared band]'), tailRaw[1]!];
    const prepared = prepareFoldFreezeTailEpochSeal(
      state,
      [...history, ...tailRaw],
      callerTailView,
      ctx(),
      T0 + 4_000,
    );
    expect(prepared.prepared).toBe(true);
    if (!prepared.prepared) return;

    callerTailView[0]!.content = '[caller mutated the band after preparation]';
    const committed = commitFoldFreezeTailEpochSeal(state, prepared);
    expect(committed.view.some((entry) => entry.content === callerTailView[0]!.content)).toBe(false);
    expect(verifySerializedFoldFreezeState(serializeFoldFreezeState(state)).valid).toBe(true);
    const publishedBytes = JSON.stringify(serializeFoldFreezeState(state));
    committed.view[0]!.content = 'caller mutated the committed result';
    expect(JSON.stringify(serializeFoldFreezeState(state))).toBe(publishedBytes);
  });

  it('does not publish when detaching the committed result throws', () => {
    const state = createFoldFreezeState();
    const history = [msg('user', 'base question'), msg('assistant', 'base answer')];
    let armFailure = false;
    let armedReads = 0;
    const statefulBase = {
      role: 'user',
      get content() {
        if (armFailure && ++armedReads > 1) throw new Error('result detachment failed');
        return '[stateful frozen base]';
      },
    } as FoldMessage;
    commitFoldFreeze(
      state,
      history,
      [statefulBase, msg('assistant', 'base folded answer')],
      ctx(),
      T0,
    );
    const tailRaw = [
      msg('user', 'fallible return raw tail '.repeat(80)),
      msg('assistant', 'tail answer'),
    ];
    const prepared = prepareFoldFreezeTailEpochSeal(
      state,
      [...history, ...tailRaw],
      [msg('user', '[small prepared band]'), tailRaw[1]!],
      ctx(),
      T0 + 4_000,
      { sealedVaultFingerprints: ['user:must-wait-for-publication'] },
    );
    expect(prepared.prepared).toBe(true);
    if (!prepared.prepared) return;
    const before = JSON.stringify(serializeFoldFreezeState(state));

    armFailure = true;
    expect(() => commitFoldFreezeTailEpochSeal(state, prepared))
      .toThrow('result detachment failed');
    armFailure = false;

    expect(JSON.stringify(serializeFoldFreezeState(state))).toBe(before);
    expect(state.sealedBands).toHaveLength(0);
    expect(state.sealedVaultFingerprints.has('user:must-wait-for-publication')).toBe(false);
    expect(commitFoldFreezeTailEpochSeal(state, prepared).committed).toBe(true);
  });

  it('derives the shrink gate and manifest geometry from the detached band', () => {
    const { state, history } = frozenFixture();
    const tailRaw = [
      msg('user', 'detached geometry raw tail '.repeat(80)),
      msg('assistant', 'detached geometry answer'),
    ];
    let contentReads = 0;
    const statefulMessage = {
      role: 'user',
      get content() {
        contentReads += 1;
        return contentReads === 1 ? '[stable detached band]' : 'x'.repeat(10_000);
      },
    } as FoldMessage;
    const prepared = prepareFoldFreezeTailEpochSeal(
      state,
      [...history, ...tailRaw],
      [statefulMessage, tailRaw[1]!],
      ctx(),
      T0 + 4_000,
    );
    expect(prepared.prepared).toBe(true);
    if (!prepared.prepared) return;

    commitFoldFreezeTailEpochSeal(state, prepared);
    expect(contentReads).toBe(1);
    expect(verifySerializedFoldFreezeState(serializeFoldFreezeState(state))).toEqual({
      valid: true,
    });
  });

  it('rejects same-length in-place frozen-prefix mutation after preparation', () => {
    const { state, history } = frozenFixture();
    const tailRaw = [msg('user', 'base mutation tail '.repeat(80)), msg('assistant', 'done')];
    const prepared = prepareFoldFreezeTailEpochSeal(
      state,
      [...history, ...tailRaw],
      [msg('user', '[base mutation band]'), tailRaw[1]!],
      ctx(),
      T0 + 4_000,
      { sealedVaultFingerprints: ['user:must-not-publish'] },
    );
    expect(prepared.prepared).toBe(true);
    if (!prepared.prepared || !state.frozenView) return;
    const original = String(state.frozenView[0]!.content);
    state.frozenView[0]!.content = 'x'.repeat(original.length);

    expect(() => commitFoldFreezeTailEpochSeal(state, prepared))
      .toThrow(FoldFreezeTailEpochSealConflict);
    expect(state.sealedBands).toHaveLength(0);
    expect(state.sealedVaultFingerprints.has('user:must-not-publish')).toBe(false);
  });

  it('publishes the band manifest and fingerprints together and preserves wrapper bytes', () => {
    const first = frozenFixture();
    const second = frozenFixture();
    const tailRaw = [
      msg('user', 'successful transaction tail '.repeat(80)),
      msg('assistant', 'successful answer'),
    ];
    const tailFolded = [msg('user', '[successful atomic band]'), tailRaw[1]!];
    const fingerprints = ['user:band-row'];
    const prepared = prepareFoldFreezeTailEpochSeal(
      first.state,
      [...first.history, ...tailRaw],
      tailFolded,
      ctx(),
      T0 + 4_000,
      { sealedVaultFingerprints: fingerprints },
    );
    expect(prepared.prepared).toBe(true);
    if (!prepared.prepared) return;
    const published = commitFoldFreezeTailEpochSeal(first.state, prepared);
    const wrapped = appendFoldFreezeTailEpoch(
      second.state,
      [...second.history, ...tailRaw],
      tailFolded,
      ctx(),
      T0 + 4_000,
      { sealedVaultFingerprints: fingerprints },
    );

    expect(JSON.stringify(published.view)).toBe(JSON.stringify(wrapped.view));
    expect(JSON.stringify(serializeFoldFreezeState(first.state)))
      .toBe(JSON.stringify(serializeFoldFreezeState(second.state)));
    expect(first.state.sealedBands).toHaveLength(1);
    expect(first.state.sealedVaultFingerprints.has('user:band-row')).toBe(true);
  });

  it('rejects a stale prepared seal without leaking its manifest or fingerprints', () => {
    const { state, history } = frozenFixture();
    const tailRaw = [msg('user', 'stale plan tail '.repeat(80)), msg('assistant', 'done')];
    const prepared = prepareFoldFreezeTailEpochSeal(
      state,
      [...history, ...tailRaw],
      [msg('user', '[stale band]'), tailRaw[1]!],
      ctx(),
      T0 + 4_000,
      { sealedVaultFingerprints: ['user:must-not-leak'] },
    );
    expect(prepared.prepared).toBe(true);
    if (!prepared.prepared) return;
    touchFoldFreeze(state, T0 + 4_001);
    const afterConcurrentTransition = JSON.stringify(serializeFoldFreezeState(state));

    expect(() => commitFoldFreezeTailEpochSeal(state, prepared))
      .toThrow(FoldFreezeTailEpochSealConflict);
    expect(JSON.stringify(serializeFoldFreezeState(state))).toBe(afterConcurrentTransition);
    expect(state.sealedBands).toHaveLength(0);
    expect(state.sealedVaultFingerprints.has('user:must-not-leak')).toBe(false);
  });

  it('rejects publication after the restored-view one-shot is consumed', () => {
    const { state, history } = frozenFixture();
    state.forceAcceptRestoredView = true;
    const tailRaw = [
      msg('user', 'restored-view race tail '.repeat(80)),
      msg('assistant', 'done'),
    ];
    const prepared = prepareFoldFreezeTailEpochSeal(
      state,
      [...history, ...tailRaw],
      [msg('user', '[restored-view race band]'), tailRaw[1]!],
      ctx(),
      T0 + 4_000,
      { sealedVaultFingerprints: ['user:restore-race-row'] },
    );
    expect(prepared.prepared).toBe(true);
    if (!prepared.prepared) return;

    expect(consumeFoldFreezeEvaluationState(state)).toBe(true);
    const afterConsume = JSON.stringify(serializeFoldFreezeState(state));
    expect(() => commitFoldFreezeTailEpochSeal(state, prepared))
      .toThrow(FoldFreezeTailEpochSealConflict);
    expect(JSON.stringify(serializeFoldFreezeState(state))).toBe(afterConsume);
    expect(state.forceAcceptRestoredView).toBe(false);
    expect(state.sealedVaultFingerprints.has('user:restore-race-row')).toBe(false);
  });

  it('does not consume supplied fingerprints when a seal is declined', () => {
    const { state, history } = frozenFixture();
    const rawTail = [msg('user', 'short raw'), msg('assistant', 'short answer')];
    const notSmaller = rawTail.map((message) => ({ ...message }));
    const result = appendFoldFreezeTailEpoch(
      state,
      [...history, ...rawTail],
      notSmaller,
      ctx(),
      T0 + 4_000,
      { sealedVaultFingerprints: ['user:declined-row'] },
    );

    expect(result).toMatchObject({ committed: false, skipReason: 'not-smaller' });
    expect(state.sealedBands).toHaveLength(0);
    expect(state.sealedVaultFingerprints.has('user:declined-row')).toBe(false);
  });

  it('serializes append-only sealed-band metadata and restores byte-stable reuse', () => {
    const { state, history, view } = frozenFixture();
    const sealedPrefixChars = state.frozenViewChars;
    const tailRaw = [
      msg('user', 'new whale '.repeat(80)),
      msg('assistant', 'folded whale summary'),
    ];
    const tailFolded = [msg('user', '[folded tail band]'), tailRaw[1]];
    const grown = [...history, ...tailRaw];

    appendFoldFreezeTailEpoch(state, grown, tailFolded, ctx(), T0 + 4_000);

    const metadata = getFoldFreezeMetadata(state);
    expect(metadata.sealedBoundaryViewCount).toBe(view.length);
    expect(metadata.rawFrontierIndex).toBe(grown.length);
    expect(metadata.cache.lastTransitionReason).toBe('append-tail-epoch');
    expect(metadata.cache.lastHardEpochReason).toBe('first-call');
    expect(metadata.hardEpochCauses).toContain('cold-gap');
    expect(metadata.hardEpochCauses).toContain('restore-integrity-failed');
    expect(metadata.hardEpochCauses).toContain('boundary-mismatch');
    expect(metadata.hardEpochCauses).toContain('restored-overcap');
    expect(metadata.hardEpochCauses).toContain('prefix-saturation');
    expect(metadata.sealedBands).toHaveLength(1);
    expect(metadata.sealedBands[0]).toMatchObject({
      sealedPrefixMessageCount: view.length,
      sealedPrefixChars,
      bandStartViewIndex: view.length,
      bandEndViewIndex: view.length + tailFolded.length,
      bandViewCount: tailFolded.length,
      rawStartIndex: history.length,
      rawEndIndex: grown.length,
      rawCount: tailRaw.length,
      boundaryRole: 'assistant',
      createdAt: T0 + 4_000,
    });
    expect(metadata.sealedBands[0]?.bandViewChars).toBeGreaterThan(0);
    expect(metadata.sealedBands[0]?.bandViewDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(metadata.sealedBands[0]?.boundaryHash).toBeDefined();

    const snapshot = serializeFoldFreezeState(state);
    expect(snapshot.version).toBe(2);
    expect(snapshot.seedBaseDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(snapshot.integrityManifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(snapshot.frozenView).toHaveLength(view.length + tailFolded.length);
    expect(snapshot.sealedBands).toEqual(metadata.sealedBands);
    expect(snapshot.frozenRawCount).toBe(metadata.rawFrontierIndex);
    expect(snapshot.frozenToolPaths).toEqual([]);
    expect(snapshot.frozenRelevantClaims).toEqual([]);
    expect(verifySerializedFoldFreezeState(snapshot)).toEqual({ valid: true });

    const restored = restoreFoldFreezeState(JSON.parse(JSON.stringify(snapshot)) as typeof snapshot);
    expect(restored.sealedBands).toEqual(snapshot.sealedBands);
    expect(restored.lastAppendBoundaryViewCount).toBe(view.length);

    const hot = evaluateFoldFreeze(restored, grown, ctx(), T0 + 5_000, CFG);
    expect(hot.action).toBe('reuse');
    if (hot.action !== 'reuse') return;
    expect(restored.frozenView).not.toBeNull();
    for (let i = 0; i < restored.frozenView!.length; i++) {
      expect(hot.view[i]).toBe(restored.frozenView![i]);
      expect(hot.view[i]).toEqual(state.frozenView![i]);
    }

    const cold = evaluateFoldFreeze(restored, grown, ctx(), T0 + 4_000 + CFG.ttlMs + 1, CFG);
    expect(cold).toMatchObject({ action: 'recompute', reason: 'cold-gap' });
  });

  it('quarantines a same-length seed/base rewrite before the rebirth trust bypass', () => {
    const { state, history, view } = frozenFixture();
    const snapshot = JSON.parse(JSON.stringify(serializeFoldFreezeState(state))) as ReturnType<
      typeof serializeFoldFreezeState
    >;
    const original = snapshot.frozenView?.[0]?.content;
    expect(typeof original).toBe('string');
    snapshot.frozenView![0] = {
      ...snapshot.frozenView![0]!,
      content: `${(original as string).startsWith('X') ? 'Y' : 'X'}${(original as string).slice(1)}`,
    };

    expect(verifySerializedFoldFreezeState(snapshot)).toEqual({
      valid: false,
      failure: { reason: 'seed-base-digest-mismatch' },
    });
    const rejected = restoreFoldFreezeState({ ...snapshot, forceAcceptRestoredView: true });
    expect(rejected.frozenView).toBeNull();
    expect(rejected.forceAcceptRestoredView).toBeUndefined();
    expect(evaluateFoldFreeze(rejected, history, ctx(), T0 + 1_000, CFG)).toMatchObject({
      action: 'recompute',
      reason: 'restore-integrity-failed',
      detail: 'seed-base-digest-mismatch',
    });

    commitFoldFreeze(rejected, history, view, ctx(), T0 + 2_000, 'restore-integrity-failed');
    expect(rejected.restoreIntegrityFailure).toBeUndefined();
    expect(rejected.frozenView).toEqual(view);
  });

  it('verifies every sealed band and identifies the exact corrupted band', () => {
    const { state, history } = frozenFixture();
    const firstRaw = [msg('user', 'first band raw '.repeat(90)), msg('assistant', 'first done')];
    const afterFirst = [...history, ...firstRaw];
    appendFoldFreezeTailEpoch(
      state,
      afterFirst,
      [msg('user', '[first sealed band]'), firstRaw[1]!],
      ctx(),
      T0 + 1_000,
    );
    const secondRaw = [msg('user', 'second band raw '.repeat(90)), msg('assistant', 'second done')];
    const afterSecond = [...afterFirst, ...secondRaw];
    appendFoldFreezeTailEpoch(
      state,
      afterSecond,
      [msg('user', '[second sealed band]'), secondRaw[1]!],
      ctx(),
      T0 + 2_000,
    );
    const snapshot = JSON.parse(JSON.stringify(serializeFoldFreezeState(state))) as ReturnType<
      typeof serializeFoldFreezeState
    >;
    expect(snapshot.sealedBands).toHaveLength(2);
    expect(verifySerializedFoldFreezeState(snapshot)).toEqual({ valid: true });

    const secondBand = snapshot.sealedBands[1]!;
    const message = snapshot.frozenView![secondBand.bandStartViewIndex]!;
    const content = message.content as string;
    snapshot.frozenView![secondBand.bandStartViewIndex] = {
      ...message,
      content: `${content.slice(0, -1)}${content.endsWith('X') ? 'Y' : 'X'}`,
    };
    expect(verifySerializedFoldFreezeState(snapshot)).toEqual({
      valid: false,
      failure: { reason: 'sealed-band-digest-mismatch', detail: 'band=1' },
    });
    const rejected = restoreFoldFreezeState(snapshot);
    expect(rejected.frozenView).toBeNull();
    expect(rejected.restoreIntegrityFailure).toEqual({
      reason: 'sealed-band-digest-mismatch',
      detail: 'band=1',
    });
  });

  it('rejects corrupted band geometry and unverifiable v1 frozen snapshots', () => {
    const { state, history } = frozenFixture();
    const tailRaw = [msg('user', 'geometry raw '.repeat(90)), msg('assistant', 'done')];
    appendFoldFreezeTailEpoch(
      state,
      [...history, ...tailRaw],
      [msg('user', '[geometry band]'), tailRaw[1]!],
      ctx(),
      T0 + 1_000,
    );
    const snapshot = JSON.parse(JSON.stringify(serializeFoldFreezeState(state))) as ReturnType<
      typeof serializeFoldFreezeState
    >;
    snapshot.sealedBands[0]!.bandEndViewIndex += 1;
    expect(verifySerializedFoldFreezeState(snapshot)).toEqual({
      valid: false,
      failure: { reason: 'sealed-band-layout-invalid', detail: 'band=0' },
    });

    const legacy = serializeFoldFreezeState(state);
    legacy.version = 1;
    const rejectedLegacy = restoreFoldFreezeState(legacy);
    expect(rejectedLegacy.frozenView).toBeNull();
    expect(rejectedLegacy.restoreIntegrityFailure?.reason).toBe('missing-integrity-metadata');
  });

  it('authenticates routing metadata and fails closed on malformed runtime JSON', () => {
    const { state } = frozenFixture();
    const metadataRewrite = serializeFoldFreezeState(state);
    metadataRewrite.frozenRawCount -= 1;
    expect(verifySerializedFoldFreezeState(metadataRewrite)).toEqual({
      valid: false,
      failure: { reason: 'integrity-manifest-digest-mismatch' },
    });

    const malformed = {
      ...serializeFoldFreezeState(state),
      sealedBands: undefined,
    } as unknown as ReturnType<typeof serializeFoldFreezeState>;
    expect(verifySerializedFoldFreezeState(malformed)).toEqual({
      valid: false,
      failure: {
        reason: 'snapshot-malformed',
        detail: 'required snapshot fields have invalid runtime shapes',
      },
    });
    expect(restoreFoldFreezeState(malformed).restoreIntegrityFailure?.reason).toBe('snapshot-malformed');

    const overBudget = serializeFoldFreezeState(state);
    overBudget.frozenViewChars = MAX_FOLD_FREEZE_RESTORE_VIEW_CHARS + 1;
    expect(verifySerializedFoldFreezeState(overBudget)).toEqual({
      valid: false,
      failure: { reason: 'verification-budget-exceeded' },
    });
  });

  it('detaches both sides of the snapshot handoff after sealing and verification', () => {
    const { state } = frozenFixture();
    const liveContent = state.frozenView![0]!.content;
    const exported = serializeFoldFreezeState(state);
    exported.frozenView![0] = { ...exported.frozenView![0]!, content: 'transport mutation' };
    expect(state.frozenView![0]!.content).toEqual(liveContent);

    const transport = serializeFoldFreezeState(state);
    const restored = restoreFoldFreezeState(transport);
    const restoredContent = restored.frozenView![0]!.content;
    transport.frozenView![0] = { ...transport.frozenView![0]!, content: 'post-verify mutation' };
    expect(restored.frozenView![0]!.content).toEqual(restoredContent);
  });

  it('restored one-shot reuse still honors the raw tail cap', () => {
    const { state, history } = frozenFixture();
    const snapshot = serializeFoldFreezeState(state);
    const restored = restoreFoldFreezeState({
      ...snapshot,
      forceAcceptRestoredView: true,
    });
    const whale = msg('user', 'x'.repeat(CFG.maxTailChars + 500));
    const beforeEvaluation = serializeFoldFreezeState(restored);

    const decision = evaluateFoldFreeze(restored, [...history, whale], ctx(), T0 + 5_000, CFG);

    // Distinct from generic 'tail-epoch' so both the relay and standalone
    // callers force the whole-view hard epoch + eviction instead of appending
    // a folded tail band onto the oversized restored prefix.
    expect(decision).toMatchObject({
      action: 'recompute',
      reason: 'restored-overcap',
      detail: 'restored-tail-overcap',
    });
    expect(serializeFoldFreezeState(restored)).toEqual(beforeEvaluation);
    expect(restored.forceAcceptRestoredView).toBe(true);
    expect(consumeFoldFreezeEvaluationState(restored)).toBe(true);
    expect(restored.forceAcceptRestoredView).toBe(false);
    expect(consumeFoldFreezeEvaluationState(restored)).toBe(false);
  });

  it('touch bumps hotReuses and slides lastCallAt; commit resets hotReuses and bumps epochs', () => {
    const { state, history } = frozenFixture();
    touchFoldFreeze(state, T0 + 1_000);
    touchFoldFreeze(state, T0 + 2_000);
    expect(state.hotReuses).toBe(2);
    expect(state.lastCallAt).toBe(T0 + 2_000);
    commitFoldFreeze(state, history, [msg('user', 'refolded')], ctx(), T0 + 3_000, 'cold-gap');
    expect(state.hotReuses).toBe(0);
    expect(state.epochs).toBe(2);
    expect(state.lastCallAt).toBe(T0 + 3_000);
    expect(state.lastTransitionReason).toBe('cold-gap');
    expect(state.lastHardEpochReason).toBe('cold-gap');
  });

  it('records prefix saturation as a caller-supplied hard-epoch cause', () => {
    const { state, history } = frozenFixture();
    commitFoldFreeze(state, history, [msg('user', 'prefix refreshed')], ctx(), T0 + 3_000, 'prefix-saturation');

    expect(state.lastTransitionReason).toBe('prefix-saturation');
    expect(state.lastHardEpochReason).toBe('prefix-saturation');
    expect(getFoldFreezeMetadata(state).cache.lastHardEpochReason).toBe('prefix-saturation');
    expect(serializeFoldFreezeState(state).lastHardEpochReason).toBe('prefix-saturation');
  });

  it('restores legacy snapshots that stored lastFullRecomputeReason (pre two-epoch-law)', () => {
    const { state } = frozenFixture();
    const snapshot = serializeFoldFreezeState(state);
    expect(snapshot.lastHardEpochReason).toBe('first-call');
    // New snapshots never write the legacy key.
    expect(snapshot.lastFullRecomputeReason).toBeUndefined();

    // Simulate a pre-rename snapshot: legacy key only, new key absent.
    const legacy = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    legacy.lastFullRecomputeReason = 'pressure-ceiling';
    delete legacy.lastHardEpochReason;
    expect(restoreFoldFreezeState(legacy).lastHardEpochReason).toBe('pressure-ceiling');

    // The new field wins when both are present.
    const both = { ...legacy, lastHardEpochReason: 'cold-gap' as const };
    expect(restoreFoldFreezeState(both).lastHardEpochReason).toBe('cold-gap');
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

  it.each([
    ['VOXXO_FOLD_FREEZE', '0'],
    ['VOXXO_FOLD_FREEZE', 'false'],
    ['VOXXO_FOLD_FREEZE', 'off'],
    ['VOXXO_FOLD_FREEZE', 'no'],
    ['VOXXO_FOLD_FREEZE', ' OFF '],
    ['VOXXO_FOLD_FREEZE', 'False'],
    ['WARP_FOLD_FREEZE', '0'],
    ['WARP_FOLD_FREEZE', 'false'],
    ['WARP_FOLD_FREEZE', 'off'],
    ['WARP_FOLD_FREEZE', 'no'],
    ['WARP_FOLD_FREEZE', ' OFF '],
    ['WARP_FOLD_FREEZE', 'False'],
  ])('disables on %s=%s', (key: string, raw: string) => {
    expect(resolveFoldFreezeConfig({ [key]: raw }).enabled).toBe(false);
  });

  it.each([
    ['VOXXO_FOLD_FREEZE', '1'],
    ['VOXXO_FOLD_FREEZE', 'true'],
    ['VOXXO_FOLD_FREEZE', 'on'],
    ['VOXXO_FOLD_FREEZE', ''],
    ['WARP_FOLD_FREEZE', '1'],
    ['WARP_FOLD_FREEZE', 'true'],
    ['WARP_FOLD_FREEZE', 'on'],
    ['WARP_FOLD_FREEZE', ''],
  ])('stays enabled on %s=%s', (key: string, raw: string) => {
    expect(resolveFoldFreezeConfig({ [key]: raw }).enabled).toBe(true);
  });

  it.each(['VOXXO', 'WARP'])('honors numeric TTL and tail-cap overrides for %s_', (prefix: string) => {
    const cfg = resolveFoldFreezeConfig({
      [`${prefix}_FOLD_FREEZE_TTL_MS`]: '60000',
      [`${prefix}_FOLD_FREEZE_MAX_TAIL_CHARS`]: '50000',
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
        WARP_FOLD_FREEZE_TTL_MS: '70000',
        WARP_FOLD_FREEZE_MAX_TAIL_CHARS: '60000',
        VOXXO_FOLD_FREEZE_TTL_MS: '60000',
        VOXXO_FOLD_FREEZE_MAX_TAIL_CHARS: '50000',
      },
      { ttlMs: 3_600_000, maxTailChars: 100_000 },
    );
    expect(cfg.ttlMs).toBe(60_000);
    expect(cfg.maxTailChars).toBe(50_000);
  });

  it('ignores invalid numeric overrides (garbage, zero, negative)', () => {
    const cfg = resolveFoldFreezeConfig({
      VOXXO_FOLD_FREEZE_TTL_MS: 'abc',
      WARP_FOLD_FREEZE_MAX_TAIL_CHARS: '-5',
    });
    expect(cfg.ttlMs).toBe(DEFAULT_FOLD_FREEZE_CONFIG.ttlMs);
    expect(cfg.maxTailChars).toBe(DEFAULT_FOLD_FREEZE_CONFIG.maxTailChars);
  });

  it('prefers VOXXO_ flags over WARP_ aliases', () => {
    const cfg = resolveFoldFreezeConfig({
      VOXXO_FOLD_FREEZE: 'true',
      WARP_FOLD_FREEZE: 'false',
      VOXXO_FOLD_FREEZE_TTL_MS: '60000',
      WARP_FOLD_FREEZE_TTL_MS: '70000',
      VOXXO_FOLD_FREEZE_MAX_TAIL_CHARS: '50000',
      WARP_FOLD_FREEZE_MAX_TAIL_CHARS: '60000',
    });

    expect(cfg.enabled).toBe(true);
    expect(cfg.ttlMs).toBe(60_000);
    expect(cfg.maxTailChars).toBe(50_000);
  });
});

describe('isTailEpochEfficiencyAlarm — tail-epoch efficiency ALARM threshold (rail-c63e326e s4)', () => {
  it('never alarms when there is no raw tail to measure (null shrinkRatio)', () => {
    expect(isTailEpochEfficiencyAlarm(null)).toBe(false);
  });

  it('does not alarm at or below the documented threshold (>= 40% saved)', () => {
    expect(APPEND_TAIL_MIN_SHRINK_RATIO).toBe(0.9);
    expect(TAIL_EPOCH_EFFICIENCY_ALARM_SHRINK_RATIO).toBe(0.6);
    expect(isTailEpochEfficiencyAlarm(0.6)).toBe(false);
    expect(isTailEpochEfficiencyAlarm(0.1)).toBe(false);
    expect(isTailEpochEfficiencyAlarm(0)).toBe(false);
  });

  it('alarms once shrinkRatio breaches the threshold (< 40% saved)', () => {
    expect(isTailEpochEfficiencyAlarm(0.6001)).toBe(true);
    // Live stealth-dragon regression case (2026-07-01): 287,211 -> 258,454 chars.
    expect(isTailEpochEfficiencyAlarm(258_454 / 287_211)).toBe(true);
  });

  it('surfaces the same shrinkRatio the append-only commit path reports', () => {
    const { state, history, view } = frozenFixture();
    // A tail that shrinks enough to pass the 0.9 commit gate but not enough
    // to clear the stricter 0.6 ALARM threshold (shrinkRatio 1400/2000 = 0.7).
    const rawTail = [msg('user', 'x'.repeat(1000)), msg('assistant', 'y'.repeat(1000))];
    const tailFolded = [msg('user', 'x'.repeat(1000)), msg('assistant', 'y'.repeat(400))];
    const grown = [...history, ...rawTail];
    const result = appendFoldFreezeTailEpoch(state, grown, tailFolded, ctx(), T0 + 4_000);
    expect(result.committed).toBe(true);
    if (result.committed) {
      expect(result.shrinkRatio).toBeCloseTo(0.7, 5);
      expect(isTailEpochEfficiencyAlarm(result.shrinkRatio)).toBe(true);
      expect(result.shrinkDiagnostics).toEqual([
        {
          kind: 'shrink-ratio',
          code: 'efficiency-alarm',
          question: 'did-folding-help-enough-to-matter',
          failed: true,
          shrinkRatio: result.shrinkRatio,
          threshold: 0.6,
        },
      ]);
    }
  });

  it('carries both failed shrink questions on a rejected append result', () => {
    const { state, history } = frozenFixture();
    const rawTail = [msg('user', 'dense input'), msg('assistant', 'dense output')];
    const result = appendFoldFreezeTailEpoch(
      state,
      [...history, ...rawTail],
      rawTail,
      ctx(),
      T0 + 4_000,
    );

    expect(result.committed).toBe(false);
    expect(result.shrinkRatio).toBe(1);
    expect(result.shrinkDiagnostics).toEqual([
      {
        kind: 'shrink-ratio',
        code: 'minimum-shrink-not-met',
        question: 'did-folding-help-at-all',
        failed: true,
        shrinkRatio: 1,
        threshold: 0.9,
      },
      {
        kind: 'shrink-ratio',
        code: 'efficiency-alarm',
        question: 'did-folding-help-enough-to-matter',
        failed: true,
        shrinkRatio: 1,
        threshold: 0.6,
      },
    ]);
  });

  it('keeps both shrink questions strict at their exact 0.9 and 0.6 boundaries', () => {
    const atMinimum = frozenFixture();
    const rawMinimum = [msg('user', 'x'.repeat(10))];
    const minimumResult = appendFoldFreezeTailEpoch(
      atMinimum.state,
      [...atMinimum.history, ...rawMinimum],
      [msg('user', 'x'.repeat(9))],
      ctx(),
      T0 + 4_000,
    );
    expect(minimumResult.committed).toBe(true);
    expect(minimumResult.shrinkRatio).toBe(0.9);
    expect(minimumResult.shrinkDiagnostics.map((diagnostic) => diagnostic.code))
      .toEqual(['efficiency-alarm']);

    const atEfficiency = frozenFixture();
    const rawEfficiency = [msg('user', 'x'.repeat(10))];
    const efficiencyResult = appendFoldFreezeTailEpoch(
      atEfficiency.state,
      [...atEfficiency.history, ...rawEfficiency],
      [msg('user', 'x'.repeat(6))],
      ctx(),
      T0 + 4_000,
    );
    expect(efficiencyResult.committed).toBe(true);
    expect(efficiencyResult.shrinkRatio).toBe(0.6);
    expect(efficiencyResult.shrinkDiagnostics).toEqual([]);
  });
});

describe('summarizeFrozenBands — seed base + per-band char decomposition', () => {
  it('reports zero bands for a fresh (never-frozen) state', () => {
    const state = createFoldFreezeState();
    const summary = summarizeFrozenBands(state);
    expect(summary.bands).toEqual([]);
    expect(summary.seedBaseChars).toBe(0);
    expect(summary.seedBaseChars).toBe(state.frozenViewChars);
  });

  it('reports the whole frozen view as the seed base when no bands are sealed yet', () => {
    const { state } = frozenFixture();
    const summary = summarizeFrozenBands(state);
    expect(summary.bands).toEqual([]);
    expect(summary.seedBaseChars).toBeGreaterThan(0);
    expect(summary.seedBaseChars).toBe(state.frozenViewChars);
  });

  it('decomposes seed base + one appended tail-epoch band after a committed append', () => {
    const { state, history } = frozenFixture();
    const seedBaseCharsBeforeAppend = state.frozenViewChars;
    const rawTail = [msg('user', 'x'.repeat(1000)), msg('assistant', 'y'.repeat(1000))];
    const tailFolded = [msg('user', 'x'.repeat(1000)), msg('assistant', 'y'.repeat(100))];
    const grown = [...history, ...rawTail];
    const result = appendFoldFreezeTailEpoch(state, grown, tailFolded, ctx(), T0 + 4_000);
    expect(result.committed).toBe(true);

    const summary = summarizeFrozenBands(state);
    expect(summary.bands).toHaveLength(1);
    // Seed base stays fixed at the pre-append frozen view size — the append
    // only grows the tail-epoch band, never the sealed prefix.
    expect(summary.seedBaseChars).toBe(seedBaseCharsBeforeAppend);
    expect(summary.bands[0]).toMatchObject({
      bandIndex: 0,
      viewChars: 1100,
      rawTailChars: 2000,
      savedChars: 900,
      shrinkRatio: 0.55,
    });
    // Invariant documented on summarizeFrozenBands: seedBaseChars + sum(bands[].viewChars) === frozenViewChars.
    const bandsTotal = summary.bands.reduce((sum, b) => sum + b.viewChars, 0);
    expect(summary.seedBaseChars + bandsTotal).toBe(state.frozenViewChars);
  });

  it('accumulates multiple sealed bands in append order with the invariant holding', () => {
    const { state, history } = frozenFixture();
    const seedBaseCharsBeforeAppends = state.frozenViewChars;

    const rawTail1 = [msg('user', 'a'.repeat(1000)), msg('assistant', 'b'.repeat(1000))];
    const tailFolded1 = [msg('user', 'a'.repeat(1000)), msg('assistant', 'b'.repeat(100))];
    const grown1 = [...history, ...rawTail1];
    const result1 = appendFoldFreezeTailEpoch(state, grown1, tailFolded1, ctx(), T0 + 4_000);
    expect(result1.committed).toBe(true);

    const rawTail2 = [msg('user', 'c'.repeat(1000)), msg('assistant', 'd'.repeat(1000))];
    const tailFolded2 = [msg('user', 'c'.repeat(1000)), msg('assistant', 'd'.repeat(200))];
    const grown2 = [...grown1, ...rawTail2];
    const result2 = appendFoldFreezeTailEpoch(state, grown2, tailFolded2, ctx(), T0 + 8_000);
    expect(result2.committed).toBe(true);

    const summary = summarizeFrozenBands(state);
    expect(summary.bands).toHaveLength(2);
    expect(summary.bands[0].bandIndex).toBe(0);
    expect(summary.bands[1].bandIndex).toBe(1);
    expect(summary.bands[0].viewChars).toBe(1100);
    expect(summary.bands[1].viewChars).toBe(1200);
    // Seed base is still the ORIGINAL frozen prefix — multiple append-only
    // epochs never touch it, only the per-band list grows.
    expect(summary.seedBaseChars).toBe(seedBaseCharsBeforeAppends);
    const bandsTotal = summary.bands.reduce((sum, b) => sum + b.viewChars, 0);
    expect(summary.seedBaseChars + bandsTotal).toBe(state.frozenViewChars);
  });
});

describe('frozen-stratum write law predicate', () => {
  it('classifies frozen prefix and sealed bands as frozen stratum', () => {
    expect(classifyFoldWriteTarget('frozen-prefix')).toBe('frozen-stratum');
    expect(classifyFoldWriteTarget('sealed-band')).toBe('frozen-stratum');
  });

  it('classifies band appends, raw appends, recall injection, and renders as overlay', () => {
    const overlayTargets: FoldWriteTarget[] = [
      'band-append',
      'raw-tail-append',
      'recall-card-injection',
      'transient-render',
    ];
    for (const target of overlayTargets) {
      expect(classifyFoldWriteTarget(target)).toBe('overlay');
    }
  });

  it('allows frozen-stratum writes only during hard-epoch materialization', () => {
    expect(isFoldWriteAllowed('frozen-prefix', NO_FOLD_WRITE_AUTHORITY)).toBe(false);
    expect(isFoldWriteAllowed('sealed-band', NO_FOLD_WRITE_AUTHORITY)).toBe(false);
    expect(isFoldWriteAllowed('frozen-prefix', HARD_EPOCH_MATERIALIZATION)).toBe(true);
    expect(isFoldWriteAllowed('sealed-band', HARD_EPOCH_MATERIALIZATION)).toBe(true);
    expect(isFoldWriteAllowed('band-append', NO_FOLD_WRITE_AUTHORITY)).toBe(true);
    expect(isFoldWriteAllowed('recall-card-injection', NO_FOLD_WRITE_AUTHORITY)).toBe(true);
  });

  it('assertFoldWriteAllowed throws a typed violation naming the target', () => {
    expect(() => assertFoldWriteAllowed('sealed-band', NO_FOLD_WRITE_AUTHORITY)).toThrow(
      FoldFrozenStratumViolation,
    );
    try {
      assertFoldWriteAllowed('frozen-prefix', NO_FOLD_WRITE_AUTHORITY);
      expect.unreachable('frozen-prefix write must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(FoldFrozenStratumViolation);
      expect((error as FoldFrozenStratumViolation).target).toBe('frozen-prefix');
    }
    expect(() => assertFoldWriteAllowed('frozen-prefix', HARD_EPOCH_MATERIALIZATION)).not.toThrow();
  });

  it('fails closed for an unrecognized runtime target', () => {
    const versionSkewedTarget = 'future-write-target' as FoldWriteTarget;
    expect(classifyFoldWriteTarget(versionSkewedTarget)).toBe('frozen-stratum');
    expect(isFoldWriteAllowed(versionSkewedTarget, NO_FOLD_WRITE_AUTHORITY)).toBe(false);
  });

  it('permits initial base installation but gates replacement through hard-epoch commit', () => {
    const state = createFoldFreezeState();
    const history = [msg('user', 'initial')];
    initializeFoldFreezeBase(state, history, history.slice(), ctx(), T0);
    expect(() => initializeFoldFreezeBase(
      state,
      history,
      [msg('user', 'unauthorized replacement')],
      ctx(),
      T0 + 1,
    )).toThrow(FoldFrozenStratumViolation);
    expect(() => commitFoldFreeze(
      state,
      history,
      [msg('user', 'authorized hard-epoch replacement')],
      ctx(),
      T0 + 2,
      'hard-epoch',
    )).not.toThrow();
  });
});

describe('artifact-mode flip cannot mutate sealed bytes', () => {
  it('keeps the frozen view byte-identical across a mid-flight VOXXO_FOLD_ARTIFACT_ONLY flip', () => {
    const previousArtifactMode = process.env.VOXXO_FOLD_ARTIFACT_ONLY;
    process.env.VOXXO_FOLD_ARTIFACT_ONLY = '1';
    try {
      const { state, history } = frozenFixture();
      const sealedRef = state.frozenView;
      const sealedBytes = JSON.stringify(state.frozenView);
      process.env.VOXXO_FOLD_ARTIFACT_ONLY = '0';
      // The env flag is read lazily at render time for NEWLY folded windows;
      // sealed strata must keep their bytes regardless of the current mode.
      const evaluation = evaluateFoldFreeze(state, history, ctx(), T0 + 1_000, CFG);
      expect(evaluation.action).toBe('reuse');
      expect(state.frozenView).toBe(sealedRef);
      expect(JSON.stringify(state.frozenView)).toBe(sealedBytes);
    } finally {
      if (previousArtifactMode === undefined) delete process.env.VOXXO_FOLD_ARTIFACT_ONLY;
      else process.env.VOXXO_FOLD_ARTIFACT_ONLY = previousArtifactMode;
    }
  });

  it('sealed band bytes survive a mode flip across a later hot reuse', () => {
    const previousArtifactMode = process.env.VOXXO_FOLD_ARTIFACT_ONLY;
    process.env.VOXXO_FOLD_ARTIFACT_ONLY = '1';
    try {
      const { state, history } = frozenFixture();
      const rawTail = [msg('user', 'a'.repeat(1000)), msg('assistant', 'b'.repeat(1000))];
      const tailFolded = [msg('user', 'a'.repeat(1000)), msg('assistant', 'b'.repeat(100))];
      const grown = [...history, ...rawTail];
      const result = appendFoldFreezeTailEpoch(state, grown, tailFolded, ctx(), T0 + 4_000);
      expect(result.committed).toBe(true);
      const sealedAfterBand = JSON.stringify(state.frozenView);
      process.env.VOXXO_FOLD_ARTIFACT_ONLY = '0';
      const evaluation = evaluateFoldFreeze(state, grown, ctx(), T0 + 5_000, CFG);
      expect(evaluation.action).toBe('reuse');
      expect(JSON.stringify(state.frozenView)).toBe(sealedAfterBand);
    } finally {
      if (previousArtifactMode === undefined) delete process.env.VOXXO_FOLD_ARTIFACT_ONLY;
      else process.env.VOXXO_FOLD_ARTIFACT_ONLY = previousArtifactMode;
    }
  });
});

describe('vault seal-once across a freeze generation', () => {
  const vaultRow = (role: 'user' | 'assistant', text: string): VaultRenderRow => ({
    role,
    text,
    priority: role === 'user' ? Number.POSITIVE_INFINITY : 0,
  });

  it('a reborn session cannot re-seal a row already present in the restored prefix', () => {
    const { state: predecessor, history } = frozenFixture();
    const sealedRow = vaultRow('user', 'operator directive already baked');
    const freshRow = vaultRow('assistant', 'verdict rendered after rebirth');
    const firstRows = selectVaultDeltaRows([sealedRow], predecessor.sealedVaultFingerprints);
    const firstRawTail = [msg('user', 'a'.repeat(1000)), msg('assistant', 'b'.repeat(1000))];
    const firstHistory = [...history, ...firstRawTail];
    const first = appendFoldFreezeTailEpoch(
      predecessor,
      firstHistory,
      [msg('assistant', renderVaultRowsBlock(firstRows, 'delta'))],
      ctx(),
      T0 + 4_000,
      { sealedVaultFingerprints: firstRows.map(vaultRowFingerprint) },
    );
    expect(first.committed).toBe(true);
    expect(predecessor.sealedVaultFingerprints.has(vaultRowFingerprint(sealedRow))).toBe(true);

    // Cross the real rebirth ownership boundary after the row joined band one.
    const restored = restoreFoldFreezeState(serializeFoldFreezeState(predecessor));
    const restoredFirstBand = restored.sealedBands[0]!;
    const restoredFirstBandText = JSON.stringify(
      restored.frozenView?.slice(
        restoredFirstBand.bandStartViewIndex,
        restoredFirstBand.bandEndViewIndex,
      ),
    );
    expect(restoredFirstBandText).toContain(sealedRow.text);
    const delta = selectVaultDeltaRows([sealedRow, freshRow], restored.sealedVaultFingerprints);
    expect(delta.map((row) => row.text)).toEqual([freshRow.text]);

    const secondRawTail = [msg('user', 'c'.repeat(1000)), msg('assistant', 'd'.repeat(1000))];
    const second = appendFoldFreezeTailEpoch(
      restored,
      [...firstHistory, ...secondRawTail],
      [msg('assistant', renderVaultRowsBlock(delta, 'delta'))],
      ctx(),
      T0 + 8_000,
      { sealedVaultFingerprints: delta.map(vaultRowFingerprint) },
    );
    expect(second.committed).toBe(true);
    const secondBand = restored.sealedBands[1]!;
    const secondBandText = JSON.stringify(
      restored.frozenView?.slice(secondBand.bandStartViewIndex, secondBand.bandEndViewIndex),
    );
    expect(secondBandText).toContain(freshRow.text);
    expect(secondBandText).not.toContain(sealedRow.text);
  });

  it('two bands in one generation never contain the same vault row', () => {
    const { state, history } = frozenFixture();
    const repeated = vaultRow('user', 'seal me exactly once');
    const firstOnly = vaultRow('assistant', 'first-band verdict');
    const secondOnly = vaultRow('assistant', 'second-band verdict');
    const firstRows = selectVaultDeltaRows([repeated, firstOnly], state.sealedVaultFingerprints);
    const firstRawTail = [msg('user', 'a'.repeat(1000)), msg('assistant', 'b'.repeat(1000))];
    const firstHistory = [...history, ...firstRawTail];
    const first = appendFoldFreezeTailEpoch(
      state,
      firstHistory,
      [msg('assistant', renderVaultRowsBlock(firstRows, 'delta'))],
      ctx(),
      T0 + 4_000,
      { sealedVaultFingerprints: firstRows.map(vaultRowFingerprint) },
    );
    expect(first.committed).toBe(true);

    const secondRows = selectVaultDeltaRows(
      [repeated, secondOnly],
      state.sealedVaultFingerprints,
    );
    expect(secondRows.map((row) => row.text)).toEqual([secondOnly.text]);
    const secondRawTail = [msg('user', 'c'.repeat(1000)), msg('assistant', 'd'.repeat(1000))];
    const second = appendFoldFreezeTailEpoch(
      state,
      [...firstHistory, ...secondRawTail],
      [msg('assistant', renderVaultRowsBlock(secondRows, 'delta'))],
      ctx(),
      T0 + 8_000,
      { sealedVaultFingerprints: secondRows.map(vaultRowFingerprint) },
    );
    expect(second.committed).toBe(true);

    const firstBand = state.sealedBands[0]!;
    const secondBand = state.sealedBands[1]!;
    const firstBandText = JSON.stringify(
      state.frozenView?.slice(firstBand.bandStartViewIndex, firstBand.bandEndViewIndex),
    );
    const secondBandText = JSON.stringify(
      state.frozenView?.slice(secondBand.bandStartViewIndex, secondBand.bandEndViewIndex),
    );
    expect(firstBandText).toContain(repeated.text);
    expect(secondBandText).toContain(secondOnly.text);
    expect(secondBandText).not.toContain(repeated.text);
  });

  it('fingerprint serialization round-trips exactly', () => {
    const state = createFoldFreezeState();
    state.sealedVaultFingerprints.add('user:abc');
    state.sealedVaultFingerprints.add('assistant:def');
    const snapshot = serializeFoldFreezeState(state);
    const restored = restoreFoldFreezeState(snapshot);
    expect(Array.from(restored.sealedVaultFingerprints).sort()).toEqual([
      'assistant:def',
      'user:abc',
    ]);
    expect(serializeFoldFreezeState(restored)).toEqual(snapshot);
  });
});
