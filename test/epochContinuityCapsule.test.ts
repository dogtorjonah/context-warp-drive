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

  it('promotes a commitment trajectory into unresolved executable state', () => {
    const capsule = renderEpochContinuityCapsule({
      objective: { text: 'Are these cards good enough?', provenance: 'live', source: 'operator-message' },
      trajectory: 'Okay, let me check whether the QR code works.',
      liveState: 'rail:\nid: rail-old\nobjective: Resume the tri-fold',
      source,
    });

    expect(capsule).toContain(
      'pending_assistant_action: Okay, let me check whether the QR code works.',
    );
    expect(capsule).toContain('status=unresolved');
    expect(capsule).toContain('outranks=live-task-rail');
    expect(capsule).not.toContain('trajectory: Okay, let me check');
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
