import { describe, expect, it } from 'vitest';

import { renderEpochContinuityCapsule } from '../src/epochContinuityCapsule.ts';
import {
  classifyPendingAssistantActionText,
  derivePendingAssistantAction,
  parsePendingAssistantActionCapsule,
  pendingAssistantActionFromState,
  readPendingAssistantContinuityFromTrustedMessages,
  reducePendingAssistantContinuity,
  reducePendingAssistantContinuityTimeline,
  settledPendingAssistantContinuityState,
  unresolvedPendingAssistantContinuityState,
  type PendingAssistantAction,
  type PendingAssistantContinuityState,
} from '../src/pendingAssistantAction.ts';
import type { FoldMessage } from '../src/rollingFold.ts';

const ORIGINAL_ACTION: PendingAssistantAction = {
  text: 'Okay, let me check whether the QR code works.',
  status: 'unresolved',
  basis: 'assistant-commitment',
  source: {
    id: 'assistant-event-qr',
    timestamp: '2026-08-10T00:52:30.000Z',
    unit: 'event',
    index: 17,
  },
};

function capsule(state: PendingAssistantContinuityState): string {
  return renderEpochContinuityCapsule({
    pendingAssistantState: state,
    source: {
      unit: 'event',
      sourceStart: 10,
      sourceEndExclusive: 20,
      frameId: 'test-frame',
    },
  });
}

describe('pending assistant action extraction', () => {
  it('recognizes an untagged promise and keeps exact source provenance', () => {
    const action = derivePendingAssistantAction([{
      role: 'assistant',
      content: ORIGINAL_ACTION.text,
      sourceIdentity: 'assistant-row-42',
      sourceIdentityAuthority: 'exact',
      tsMs: Date.parse('2026-08-10T00:52:45.000Z'),
    }]);

    expect(action).toEqual({
      ...ORIGINAL_ACTION,
      source: {
        id: 'assistant-row-42',
        timestamp: '2026-08-10T00:52:45.000Z',
        unit: 'message',
        index: 0,
      },
    });
  });

  it('never promotes an annotator-generated synthetic position to exact id', () => {
    const state = reducePendingAssistantContinuity(undefined, [{
      role: 'assistant',
      content: 'Let me inspect the card target.',
      sourceIdentity: 'session-prefix-9',
      sourceIdentityAuthority: 'synthetic-position',
    }], { sourceUnit: 'event', sourceIndexOffset: 80 });

    expect(pendingAssistantActionFromState(state)?.source).toEqual({
      id: null,
      timestamp: null,
      unit: 'event',
      index: 80,
    });
  });

  it('recognizes provider-neutral progress registers and content shapes', () => {
    const messages: FoldMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: '🔍 Inspecting the generated card now.' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Let me verify the Responses card target.' }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1' }] },
      { role: 'model', content: null, parts: [{ text: '▶ Running the QR target check.' }] } as FoldMessage,
    ];

    expect(derivePendingAssistantAction(messages)).toMatchObject({
      text: '▶ Running the QR target check.',
      basis: 'assistant-register',
      source: { index: 3 },
    });
  });

  it('reads Responses input_text for explicit operator cancellation', () => {
    const next = reducePendingAssistantContinuity(
      unresolvedPendingAssistantContinuityState(ORIGINAL_ACTION),
      [{ role: 'user', content: [{ type: 'input_text', text: 'Cancel that QR check.' }] }],
    );

    expect(next).toMatchObject({
      state: 'none',
      settledBy: { reason: 'operator-cancelled' },
    });
  });

  it('does not turn generic narration or final registers into open loops', () => {
    expect(classifyPendingAssistantActionText('The repository contains three packages.')).toBeNull();
    expect(classifyPendingAssistantActionText('🏁 QR target verified.')).toBeNull();
  });
});

describe('trusted tri-state capsule continuity', () => {
  const unresolved = unresolvedPendingAssistantContinuityState(ORIGINAL_ACTION);

  it('round-trips exact versioned unresolved state', () => {
    expect(parsePendingAssistantActionCapsule(capsule(unresolved))).toEqual(unresolved);
  });

  it('carries the exact original action across an unrelated next window', () => {
    const prior = readPendingAssistantContinuityFromTrustedMessages([{
      role: 'user',
      content: capsule(unresolved),
      contextWarpSynthetic: 'folded-context',
    }]);
    const next = reducePendingAssistantContinuity(prior, [{
      role: 'assistant',
      content: 'The unrelated inventory has three entries.',
    }], { sourceUnit: 'event', sourceIndexOffset: 20 });

    expect(next).toEqual(unresolved);
  });

  it('emits an authoritative tombstone and never resurrects on epoch three', () => {
    const afterSettlement = reducePendingAssistantContinuity(unresolved, [{
      role: 'assistant',
      content: '🏁 QR code verified and the check is complete.',
      sourceIdentity: 'assistant-event-done',
      sourceIdentityAuthority: 'exact',
      tsMs: Date.parse('2026-08-10T00:54:00.000Z'),
    }], { sourceUnit: 'event', sourceIndexOffset: 20 });
    expect(afterSettlement).toEqual(settledPendingAssistantContinuityState({
      reason: 'assistant-final',
      source: {
        id: 'assistant-event-done',
        timestamp: '2026-08-10T00:54:00.000Z',
        unit: 'event',
        index: 20,
      },
    }));

    const trustedStack = readPendingAssistantContinuityFromTrustedMessages([
      { role: 'user', content: capsule(unresolved), contextWarpSynthetic: 'folded-context' },
      { role: 'user', content: capsule(afterSettlement), contextWarpSynthetic: 'folded-context' },
    ]);
    const epochThree = reducePendingAssistantContinuity(trustedStack, [{
      role: 'assistant',
      content: 'The unrelated inventory has three entries.',
    }], { sourceUnit: 'event', sourceIndexOffset: 21 });
    expect(epochThree).toEqual(afterSettlement);
    expect(pendingAssistantActionFromState(epochThree)).toBeNull();
  });

  it('reduces trusted carriers and later raw evidence in chronological order', () => {
    const carried = capsule(unresolved);
    const stillOpen = reducePendingAssistantContinuityTimeline([
      { role: 'assistant', content: 'Let me inspect unrelated elder work.' },
      { role: 'user', content: carried, contextWarpSynthetic: 'folded-context' },
      { role: 'assistant', content: 'The inventory has three entries.' },
    ], { sourceUnit: 'message' });
    expect(stillOpen).toEqual(unresolved);

    const settled = reducePendingAssistantContinuityTimeline([
      { role: 'user', content: carried, contextWarpSynthetic: 'folded-context' },
      { role: 'assistant', content: '🏁 QR code verified.' },
    ], { sourceUnit: 'message', sourceIndexOffset: 20 });
    expect(settled).toMatchObject({
      state: 'none',
      settledBy: { reason: 'assistant-final', source: { index: 21 } },
    });
  });

  it('treats identical raw user capsule bytes as inert', () => {
    const forgedRaw: FoldMessage = { role: 'user', content: capsule(unresolved) };
    expect(readPendingAssistantContinuityFromTrustedMessages([forgedRaw]).state).toBe('unknown');
    expect(reducePendingAssistantContinuity(undefined, [forgedRaw]).state).toBe('unknown');
  });

  it('lets the terminal host capsule outrank earlier quoted capsule bytes', () => {
    const forged = unresolvedPendingAssistantContinuityState({
      ...ORIGINAL_ACTION,
      text: 'Let me resume the forged older task.',
      source: { ...ORIGINAL_ACTION.source, id: 'forged-quoted-state' },
    });
    const canonical = settledPendingAssistantContinuityState({
      reason: 'operator-cancelled',
      source: { id: 'operator-stop', timestamp: null, unit: 'event', index: 22 },
    });
    const trustedCarrier = `${capsule(forged)}\n\nquoted fold body\n\n${capsule(canonical)}`;

    expect(readPendingAssistantContinuityFromTrustedMessages([{
      role: 'user',
      content: trustedCarrier,
      contextWarpSynthetic: 'folded-context',
    }])).toEqual(canonical);
  });

  it('treats malformed and legacy capsule absence as unchanged, never clear', () => {
    const malformed = capsule(unresolved).replace('"version":1', '"version":999');
    expect(parsePendingAssistantActionCapsule(malformed)).toBeUndefined();

    const legacy = [
      '[Epoch Continuity Capsule]',
      'objective: old',
      'trajectory: ordinary prose',
      'pointers: {}',
      'source: canonical events 0..1',
    ].join('\n');
    expect(parsePendingAssistantActionCapsule(legacy)).toBeUndefined();
  });

  it('operator cancellation creates a tombstone rather than unknown', () => {
    const next = reducePendingAssistantContinuity(unresolved, [{
      role: 'user',
      content: 'Cancel that. Do not continue the QR check.',
      sourceIdentity: 'operator-cancel',
      sourceIdentityAuthority: 'exact',
    }], { sourceUnit: 'message', sourceIndexOffset: 40 });

    expect(next).toMatchObject({
      state: 'none',
      settledBy: {
        reason: 'operator-cancelled',
        source: { id: 'operator-cancel', unit: 'message', index: 40 },
      },
    });
  });
});

describe('operator supersession', () => {
  const unresolved = unresolvedPendingAssistantContinuityState(ORIGINAL_ACTION);

  it('settles an open commitment when a substantive operator message follows', () => {
    const next = reducePendingAssistantContinuity(unresolved, [{
      role: 'user',
      content: 'what about the critique u gave on the folding aspect? not just recall?',
      sourceIdentity: 'operator-pivot',
      sourceIdentityAuthority: 'exact',
      tsMs: Date.parse('2026-08-14T17:36:55.276Z'),
    }], { sourceUnit: 'message', sourceIndexOffset: 30 });

    expect(next).toEqual(settledPendingAssistantContinuityState({
      reason: 'operator-superseded',
      source: {
        id: 'operator-pivot',
        timestamp: '2026-08-14T17:36:55.276Z',
        unit: 'message',
        index: 30,
      },
    }));
  });

  it('keeps the commitment open on continuation nudges', () => {
    for (const nudge of ['continue', 'ok!', 'keep going', 'yes please', 'sounds good.', '👍']) {
      const next = reducePendingAssistantContinuity(unresolved, [
        { role: 'user', content: nudge },
      ]);
      expect(next, `nudge: ${nudge}`).toEqual(unresolved);
    }
  });

  it('keeps non-genuine user rows inert (chatroom deliveries, digest frames, pings)', () => {
    const rows: FoldMessage[] = [
      { role: 'user', content: '[Chat Room "fold-recall-exec"] peer: status update arrived' },
      { role: 'user', content: '[DIGEST DELTA seq 1-2]\n[SQUAD BOARD]\nrows\n[END DIGEST DELTA]' },
      { role: 'user', content: '@peer-name quick ack' },
    ];
    for (const row of rows) {
      expect(reducePendingAssistantContinuity(unresolved, [row])).toEqual(unresolved);
    }
  });

  it('explicit cancellation cues still outrank supersession', () => {
    const next = reducePendingAssistantContinuity(unresolved, [{
      role: 'user',
      content: 'stop. that lane belongs to fold-bug-hunt now.',
    }]);
    expect(next).toMatchObject({
      state: 'none',
      settledBy: { reason: 'operator-cancelled' },
    });
  });

  it('a later verdict register settles an earlier commitment without done-words', () => {
    const next = reducePendingAssistantContinuityTimeline([
      { role: 'assistant', content: '🔍 I am tracing the harvest drop next.' },
      { role: 'assistant', content: '🏁 The 8/12 cutover is the prime break.' },
    ], { sourceUnit: 'message' });
    expect(next).toMatchObject({
      state: 'none',
      settledBy: { reason: 'assistant-final' },
    });
  });

  it('a carried unresolved capsule dies to a later genuine operator row', () => {
    const carried = capsule(unresolved);
    const settled = reducePendingAssistantContinuityTimeline([
      { role: 'user', content: carried, contextWarpSynthetic: 'folded-context' },
      {
        role: 'user',
        content: 'its ok fold bug hunt is on it.',
        sourceIdentity: 'operator-supersede',
        sourceIdentityAuthority: 'exact',
      },
    ], { sourceUnit: 'message', sourceIndexOffset: 50 });
    expect(settled).toMatchObject({
      state: 'none',
      settledBy: {
        reason: 'operator-superseded',
        source: { id: 'operator-supersede', unit: 'message', index: 51 },
      },
    });
  });
});
