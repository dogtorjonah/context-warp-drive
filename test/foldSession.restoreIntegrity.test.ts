import { describe, expect, it } from 'vitest';
import {
  commitFoldFreeze,
  createFoldFreezeState,
  serializeFoldFreezeState,
  verifySerializedFoldFreezeState,
  type FoldFreezeContext,
} from '../src/foldFreeze.ts';
import type { FoldMessage } from '../src/rollingFold.ts';
import { FoldSession } from '../src/session/FoldSession.ts';

const T0 = 2_000_000;
const context: FoldFreezeContext = { thinningMode: '', claimedPaths: new Set() };
const message = (role: string, content: string): FoldMessage => ({ role, content });

function predecessorSnapshot() {
  const history = [
    message('user', 'question one'),
    message('assistant', 'answer one'),
    message('user', 'question two'),
    message('assistant', 'answer two'),
  ];
  const view = [message('user', '[folded first turn]'), history[2]!, history[3]!];
  const state = createFoldFreezeState();
  commitFoldFreeze(state, history, view, context, T0);
  return { history, view, snapshot: serializeFoldFreezeState(state) };
}

describe('FoldSession restored freeze integrity', () => {
  it('admits a verified v2 snapshot and reuses its exact frozen prefix', () => {
    const { history, view, snapshot } = predecessorSnapshot();
    const session = new FoldSession({
      restoredFoldFreezeState: snapshot,
      freeze: { enabled: true, ttlMs: 300_000, maxTailChars: 10_000 },
      now: () => T0 + 1_000,
    });

    const outcome = session.prepare([...history, message('user', 'new tail')]);

    expect(outcome.cacheHot).toBe(true);
    expect(outcome.messages.slice(0, view.length)).toEqual(view);
    expect(session.snapshotFoldFreezeState()?.version).toBe(2);
  });

  it('quarantines a corrupted snapshot and heals it with a fresh verified epoch', () => {
    const { history, snapshot } = predecessorSnapshot();
    const corrupted = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    const content = corrupted.frozenView![0]!.content as string;
    corrupted.frozenView![0] = {
      ...corrupted.frozenView![0]!,
      content: `${content.startsWith('X') ? 'Y' : 'X'}${content.slice(1)}`,
    };
    const session = new FoldSession({
      restoredFoldFreezeState: corrupted,
      freeze: { enabled: true, ttlMs: 300_000, maxTailChars: 10_000 },
      now: () => T0 + 1_000,
    });

    const outcome = session.prepare(history);

    expect(outcome.cacheHot).toBe(false);
    expect(outcome.stats.epochReason).toBe('restore-integrity-failed');
    const healed = session.snapshotFoldFreezeState();
    expect(healed).not.toBeNull();
    expect(verifySerializedFoldFreezeState(healed!)).toEqual({ valid: true });
  });
});
