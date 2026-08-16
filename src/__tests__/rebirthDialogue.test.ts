import { describe, expect, it } from 'vitest';

import {
  isGenuineRebirthOperatorMessage,
  isRelayGeneratedReviewWaveMessage,
  selectRoleAwareRebirthDialogueWindow,
} from '../rebirthDialogue.ts';

const legacyWavePrompt = [
  'Review your predecessor and continue the work.',
  '',
  'Current wave launch',
  'Mode: predecessor-review',
  '',
  'Phase marker',
  'Current phase: review',
  '',
  'Wave room',
  '#rebirth-loop',
  '',
  'Wave completion escape hatch',
  'Stop once the rail is complete.',
].join('\n');

describe('rebirth dialogue control-message classification', () => {
  it('recognizes marked and legacy relay-authored review directives', () => {
    const marked = `[RELAY WAVE DIRECTIVE mode=predecessor-review phase=review]\n${legacyWavePrompt}`;
    const legacyUiReview = 'Predecessor Review Protocol\n\n## Solo review protocol\n\nReview the predecessor.';
    const legacyUiWave = 'Load-Rail Wave Protocol\n\nPlanning and synthesis only.';
    expect(isRelayGeneratedReviewWaveMessage(marked)).toBe(true);
    expect(isRelayGeneratedReviewWaveMessage(legacyWavePrompt)).toBe(true);
    expect(isRelayGeneratedReviewWaveMessage(legacyUiReview)).toBe(true);
    expect(isRelayGeneratedReviewWaveMessage(legacyUiWave)).toBe(true);
    expect(isGenuineRebirthOperatorMessage(marked)).toBe(false);
    expect(isGenuineRebirthOperatorMessage(legacyWavePrompt)).toBe(false);
    expect(isGenuineRebirthOperatorMessage(legacyUiReview)).toBe(false);
    expect(isGenuineRebirthOperatorMessage(legacyUiWave)).toBe(false);
  });

  it('does not reject operator prose that merely discusses review waves', () => {
    const operator = 'Please explain why the Current wave launch section can hide my last real request.';
    expect(isRelayGeneratedReviewWaveMessage(operator)).toBe(false);
    expect(isGenuineRebirthOperatorMessage(operator)).toBe(true);
  });

  it('keeps retired sidequest-cleanup rows synthetic in historical transcripts', () => {
    expect(isGenuineRebirthOperatorMessage(
      '[sidequest-cleanup] reviewer-1 completed; parent may collect the result.',
    )).toBe(false);
    expect(isGenuineRebirthOperatorMessage(
      'Why did [sidequest-cleanup] appear as a genuine operator message?',
    )).toBe(true);
  });

  it('keeps the fork-point genuine user in quota when a later wave directive has user role', () => {
    const messages = [
      { id: 'u1', type: 'user', text: 'The genuine fork-point request.', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'a1', type: 'assistant_text', text: 'Working on it.', created_at: '2026-01-01T00:00:01.000Z' },
      { id: 'relay', type: 'user', text: legacyWavePrompt, created_at: '2026-01-01T00:00:02.000Z' },
    ];

    const selected = selectRoleAwareRebirthDialogueWindow(messages, {
      recentUserMessages: 1,
      recentAssistantMessages: 1,
      recentAmbientMessages: 0,
    });

    expect(selected.messages.map((message) => message.id)).toEqual(['u1', 'a1']);
    expect(selected.coverage).toMatchObject({
      persistedGenuineUsers: 1,
      selectedGenuineUsers: 1,
    });
  });

  it('rejects relay-authored atlas-debt nudges persisted with a user role', () => {
    const currentWording = [
      '[atlas-debt] You went idle with 2 edited file(s) that have no Atlas writeback.',
      'Settle every path below now with one real atlas_commit_batch per workspace (a cross-workspace set needs one batch in each workspace).',
      'Every file needs changelog_entry. source_highlights is required only when that Atlas file record does not already have highlights; use validate_only preflight if you are unsure. If a file was reverted or should not be recorded, say so and move on.',
      '',
      '- /repo/src/a.ts (2 edits, last edit 1m ago)',
    ].join('\n');
    const legacyWording = [
      '[atlas-debt] You went idle with 5 edited file(s) that have no Atlas writeback.',
      'Settle them now with one real atlas_commit_batch covering every path below, then release any claims you still hold.',
      'Include changelog_entry + source_highlights per file. If a file was reverted or should not be recorded, say so and move on.',
      '',
      '- /repo/src/b.ts (1 edit, last edit 7m ago)',
    ].join('\n');
    expect(isGenuineRebirthOperatorMessage(currentWording)).toBe(false);
    expect(isGenuineRebirthOperatorMessage(legacyWording)).toBe(false);
  });

  it('does not reject operator prose that merely discusses atlas debt', () => {
    const operator = 'Why did [atlas-debt] nudges land in my rebirth package user slots? That leak cannot stay.';
    expect(isGenuineRebirthOperatorMessage(operator)).toBe(true);
  });

  it('keeps a newer atlas-debt nudge from evicting the genuine user quota', () => {
    const messages = [
      { id: 'u1', type: 'user', text: 'The genuine fork-point request.', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'a1', type: 'assistant_text', text: 'Working on it.', created_at: '2026-01-01T00:00:01.000Z' },
      { id: 'debt', type: 'user', text: '[atlas-debt] You went idle with 1 edited file(s) that have no Atlas writeback.\nSettle them now with one real atlas_commit_batch covering every path below.', created_at: '2026-01-01T00:00:02.000Z' },
    ];

    const selected = selectRoleAwareRebirthDialogueWindow(messages, {
      recentUserMessages: 1,
      recentAssistantMessages: 1,
      recentAmbientMessages: 0,
    });

    expect(selected.messages.map((message) => message.id)).toEqual(['u1', 'a1']);
    expect(selected.coverage).toMatchObject({
      persistedGenuineUsers: 1,
      selectedGenuineUsers: 1,
    });
  });
});
