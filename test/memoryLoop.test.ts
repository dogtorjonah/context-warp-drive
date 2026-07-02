import { describe, expect, it, vi } from 'vitest';

import { MemoryLoop } from '../src/host/MemoryLoop.ts';
import { FoldSession } from '../src/session/FoldSession.ts';
import { ALWAYS_ON_FOLD_CONFIG, type FoldMessage } from '../src/rollingFold.ts';

// Regression coverage for MemoryLoop.prepare() forwarding into FoldSession
// (rail-4257dfe5 step-6): hardEpoch/thinningMode/claimedPaths must reach
// session.prepare(), and a hard epoch must rebuild the fold recall index
// with seedFoldsEntireRaw so pre-reset raw turns stay recall-addressable
// against the markerless portable-reset seed. Before that fix these fields
// were silently dropped at the MemoryLoop seam, so host-forced hard epochs
// never reached FoldSession and fold recall went dormant across the reset.

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

function turn(i: number): FoldMessage[] {
  const id = `toolu_memloop_${i}`;
  return [
    userMsg(`Task ${i} inspect module ${i}`),
    anthropicToolUse('Read', { file_path: `/repo/src/mod${i}.ts` }, id),
    anthropicToolResult(id, `body ${i} ` + 'filler content line\n'.repeat(20)),
    assistantMsg(`Module ${i} analysed ` + 'reasoning filler. '.repeat(20)),
  ];
}

function history(): FoldMessage[] {
  return [...turn(0), ...turn(1), userMsg('LIVE QUESTION INSIDE LONG TURN')];
}

function createLoop(): { loop: MemoryLoop; session: FoldSession } {
  const session = new FoldSession({
    foldConfig: ALWAYS_ON_FOLD_CONFIG,
    freeze: { enabled: true, ttlMs: 60_000, maxTailChars: 1 },
  });
  const loop = new MemoryLoop({ session });
  return { loop, session };
}

describe('MemoryLoop.prepare host-forced hard epoch forwarding', () => {
  it('forwards hardEpoch/thinningMode/claimedPaths from context into FoldSession.prepare', async () => {
    const { loop, session } = createLoop();
    const prepareSpy = vi.spyOn(session, 'prepare');
    const raw = history();
    const claimedPaths = new Set(['/repo/src/mod0.ts']);

    const outcome = await loop.prepare(raw, {
      hardEpoch: true,
      thinningMode: 'aggressive',
      claimedPaths,
    });

    expect(prepareSpy).toHaveBeenCalledTimes(1);
    const [, forwardedContext] = prepareSpy.mock.calls[0];
    expect(forwardedContext?.hardEpoch).toBe(true);
    expect(forwardedContext?.thinningMode).toBe('aggressive');
    expect(forwardedContext?.claimedPaths).toBe(claimedPaths);

    // Host-forced hard epoch actually fires FoldSession's hard-epoch path.
    expect(outcome.epochTriggered).toBe(true);
    expect(outcome.fold.stats.epochReason).toBe('hard-epoch');
    expect(outcome.messages.length).toBeGreaterThan(0);
  });

  it('rebuilds the recall index with seedFoldsEntireRaw so pre-reset turns stay recall-addressable', async () => {
    const { loop } = createLoop();
    const raw = history();

    await loop.prepare(raw, { hardEpoch: true });

    const recallState = loop.getRecallState();
    expect(recallState.index).not.toBeNull();
    const index = recallState.index!;

    // Markerless hard-epoch seeds carry no "[Conversation Context — N turns
    // folded]" block, so without seedFoldsEntireRaw the index would come back
    // empty (interFoldedCount === 0) and fold recall would go dormant across
    // the reset. rawCount must track the FULL raw history, and both pre-reset
    // turns (the trailing live turn is intentionally left unfolded) must be
    // indexed as recall-addressable 'turn' entries.
    expect(index.rawCount).toBe(raw.length);
    const turnEntries = index.entries.filter((e) => e.kind === 'turn');
    expect(turnEntries.length).toBe(2);
    expect(turnEntries.every((e) => e.kind === 'turn')).toBe(true);
  });

  it('does not force a hard epoch when hardEpoch is omitted and no pressure ceiling is configured', async () => {
    const { loop, session } = createLoop();
    const prepareSpy = vi.spyOn(session, 'prepare');
    const raw = history();

    const outcome = await loop.prepare(raw, {});

    expect(prepareSpy).toHaveBeenCalledTimes(1);
    const [, forwardedContext] = prepareSpy.mock.calls[0];
    expect(forwardedContext?.hardEpoch).toBeUndefined();
    expect(outcome.fold.stats.epochReason).not.toBe('hard-epoch');
  });
});
