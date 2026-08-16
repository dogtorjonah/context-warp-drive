import { describe, expect, it } from 'vitest';
import { renderEpochContinuityCapsule } from '../src/epochContinuityCapsule.ts';

describe('epoch continuity pending assistant action', () => {
  const source = {
    unit: 'message' as const,
    sourceStart: 10,
    sourceEndExclusive: 14,
    frameId: 'trace:tail-epoch#1:pre-fold',
    frameRowStart: 10,
    frameRowEndInclusive: 13,
  };

  it('keeps state honestly unknown instead of promoting trajectory prose', () => {
    const capsule = renderEpochContinuityCapsule({
      objective: { text: 'Are these cards good enough?', provenance: 'live', source: 'operator-message' },
      trajectory: 'Okay, let me check whether the QR code works.',
      liveState: 'rail:\nid: rail-old\nobjective: Resume the tri-fold',
      source,
    });

    // Without explicit continuity input the renderer must not manufacture
    // unresolved state from trajectory prose: a null-id/null-time action
    // serialized into pending_assistant_state would be re-ingested as trusted
    // carried state at the next fold. The prose survives as the low-authority
    // legacy trajectory line instead.
    expect(capsule).not.toContain('pending_assistant_action: ');
    expect(capsule).toContain('trajectory: Okay, let me check whether the QR code works.');
    expect(capsule).toContain('pending_assistant_state: {"version":1,"state":"unknown"}');
  });

  it('keeps settled assistant text as non-executable trajectory', () => {
    const capsule = renderEpochContinuityCapsule({
      trajectory: '🏁 I checked the QR code and verified the target.',
      source,
    });

    expect(capsule).toContain('trajectory: 🏁 I checked the QR code and verified the target.');
    expect(capsule).not.toContain('pending_assistant_action:');
  });

  it('renders supplied provenance instead of an inferred frame coordinate', () => {
    const capsule = renderEpochContinuityCapsule({
      pendingAssistantAction: {
        text: '▶ Running the QR target check.',
        status: 'unresolved',
        basis: 'assistant-register',
        source: {
          id: 'assistant-row-12',
          timestamp: '2026-08-10T00:52:45.000Z',
          unit: 'message',
          index: 12,
        },
      },
      source,
    });

    expect(capsule).toContain('source-id=assistant-row-12');
    expect(capsule).toContain('source-coordinate=message#12');
    expect(capsule).toContain('source-time=2026-08-10T00:52:45.000Z');
  });

  it('renders a visible settlement tombstone when a real settledBy exists', () => {
    const capsule = renderEpochContinuityCapsule({
      trajectory: 'Okay, let me check whether the QR code works.',
      pendingAssistantState: {
        version: 1,
        state: 'none',
        settledBy: {
          reason: 'operator-superseded',
          source: {
            id: 'operator-pivot',
            timestamp: '2026-08-14T17:36:55.276Z',
            unit: 'message',
            index: 30,
          },
        },
      },
      source,
    });

    expect(capsule).toContain(
      'pending_assistant_action: none [settled-by=operator-superseded source-id=operator-pivot source-coordinate=message#30 source-time=2026-08-14T17:36:55.276Z]',
    );
    expect(capsule).not.toContain('outranks=live-task-rail');
    expect(capsule).not.toContain('trajectory:');
    expect(capsule).toContain('"state":"none"');
  });

  it('treats explicit null as a tombstone and never reopens from trajectory', () => {
    const capsule = renderEpochContinuityCapsule({
      trajectory: 'Okay, let me check whether the QR code works.',
      pendingAssistantAction: null,
      source,
    });

    expect(capsule).not.toContain('pending_assistant_action:');
    expect(capsule).not.toContain('trajectory:');
    expect(capsule).toContain('pending_assistant_state: {"version":1,"state":"none"');
  });
});
