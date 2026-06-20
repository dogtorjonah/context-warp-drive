import { describe, expect, test } from 'vitest';

import {
  foldContext,
  detectTurns,
  scoreTurnFidelityValue,
  DEFAULT_FIDELITY_VALUE_WEIGHTS,
  ALWAYS_ON_FOLD_CONFIG,
  type FoldMessage,
  type FoldConfig,
} from '../src/rollingFold.ts';

function userMsg(text: string): FoldMessage {
  return { role: 'user', content: text };
}
function assistantMsg(text: string): FoldMessage {
  return { role: 'assistant', content: text };
}
/** One turn: a user prompt, a path-touching tool call, its result, and an assistant note. */
function toolTurn(i: number, toolName: string, path: string, note: string): FoldMessage[] {
  const id = `tool_${i}`;
  return [
    userMsg(`step ${i}`),
    { role: 'assistant', content: [{ type: 'tool_use', id, name: toolName, input: { file_path: path } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `body ${i} ` + 'filler '.repeat(20) }] },
    assistantMsg(note),
  ];
}

function foldBlock(messages: FoldMessage[]): string {
  const block = messages.find(
    (m) => typeof m.content === 'string' && (m.content as string).startsWith('[Conversation Context —'),
  );
  return (block?.content as string | undefined) ?? '';
}

describe('scoreTurnFidelityValue — intrinsic trace value', () => {
  test('ranks a downstream-referenced path above an abandoned one', () => {
    const messages = [
      ...toolTurn(0, 'Read', '/repo/hot.ts', 'note0'), // read hot.ts
      ...toolTurn(1, 'Read', '/repo/cold.ts', 'note1'), // read cold.ts, never revisited
      ...toolTurn(2, 'Edit', '/repo/hot.ts', 'note2'), // ACTIVE window edits hot.ts
    ];
    const turns = detectTurns(messages);
    const scores = scoreTurnFidelityValue(turns, 2); // fold turns 0,1; turn 2 = active window

    // turn 0 (hot.ts) is edited downstream in the active window; turn 1 (cold.ts) is abandoned.
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBe(0);
    // edit weight × active-window multiplier.
    expect(scores[0]).toBe(DEFAULT_FIDELITY_VALUE_WEIGHTS.edit * DEFAULT_FIDELITY_VALUE_WEIGHTS.activeWindowMultiplier);
  });

  test('a later CLAIM scores higher than a later READ of the same path', () => {
    const readDownstream = [
      ...toolTurn(0, 'Read', '/repo/x.ts', 'n0'),
      ...toolTurn(1, 'Read', '/repo/x.ts', 'n1'), // downstream READ (active window)
    ];
    const claimDownstream = [
      ...toolTurn(0, 'Read', '/repo/x.ts', 'n0'),
      ...toolTurn(1, 'partner_claim_file', '/repo/x.ts', 'n1'), // downstream CLAIM (active window)
    ];
    const readScore = scoreTurnFidelityValue(detectTurns(readDownstream), 1)[0];
    const claimScore = scoreTurnFidelityValue(detectTurns(claimDownstream), 1)[0];
    expect(claimScore).toBeGreaterThan(readScore);
  });

  test('a durable register glyph (🏁) adds the glyph bonus; transient glyphs do not', () => {
    const messages = [
      ...toolTurn(0, 'Read', '/repo/a.ts', '🏁 verified the result'), // durable
      ...toolTurn(1, 'Read', '/repo/b.ts', '🔍 still investigating'), // transient
    ];
    const scores = scoreTurnFidelityValue(detectTurns(messages), 2);
    // Neither path is re-referenced downstream, so the only signal is the glyph.
    expect(scores[0]).toBe(DEFAULT_FIDELITY_VALUE_WEIGHTS.glyphDurableBonus);
    expect(scores[1]).toBe(0);
  });
});

describe('foldContext — value-aware graduated fidelity (full-recompute only)', () => {
  const OLD = 'OLDHOT_REASONING_DISTINCTIVE_TOKEN'; // 34 chars
  const buildHistory = (): FoldMessage[] => [
    ...toolTurn(0, 'Read', '/repo/hot.ts', OLD), // OLD turn reads hot.ts
    ...toolTurn(1, 'Read', '/repo/c1.ts', 'newer-filler-one'), // 16
    ...toolTurn(2, 'Read', '/repo/c2.ts', 'newer-filler-two'), // 16
    ...toolTurn(3, 'Read', '/repo/c3.ts', 'newer-filler-three'), // 18
    ...toolTurn(4, 'Edit', '/repo/hot.ts', 'editing hot now'), // ACTIVE window edits hot.ts
  ];
  // Full-retention budget fits exactly one ~34-char note; no essence; no recency floor.
  const cfg: FoldConfig = {
    ...ALWAYS_ON_FOLD_CONFIG,
    activeWindowTurns: 1,
    assistantTextBudget: { fullRetentionChars: OLD.length + 5, essenceRetentionChars: 0 },
  };
  const TURNS_TO_FOLD = 4; // fold turns 0..3; turn 4 stays in the active window

  test('disabled (newest-first ramp) skeletonizes the abandoned OLD turn', () => {
    const off = foldContext(buildHistory(), TURNS_TO_FOLD, cfg);
    expect(foldBlock(off.messages)).not.toContain(OLD); // recency ramp spends the budget on the NEWEST folded turns
  });

  test('enabled promotes the still-relevant OLD turn over newer abandoned ones', () => {
    const on = foldContext(
      buildHistory(),
      TURNS_TO_FOLD,
      cfg,
      undefined,
      undefined,
      undefined,
      undefined,
      { recencyFloorTurns: 0 }, // pure value (no floor) to isolate the cherry-pick
    );
    // hot.ts is edited in the active window → turn 0 is the highest-value turn →
    // it wins the full-retention budget and its reasoning survives the fold.
    expect(foldBlock(on.messages)).toContain(OLD);
  });

  test('a recency floor covering all folded turns reproduces the newest-first ramp', () => {
    const off = foldContext(buildHistory(), TURNS_TO_FOLD, cfg);
    const floorAll = foldContext(
      buildHistory(),
      TURNS_TO_FOLD,
      cfg,
      undefined,
      undefined,
      undefined,
      undefined,
      { recencyFloorTurns: 99 }, // floor >= folded count → byte-identical to the ramp
    );
    expect(foldBlock(floorAll.messages)).toBe(foldBlock(off.messages));
  });
});
