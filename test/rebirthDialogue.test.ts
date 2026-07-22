import { describe, expect, test } from 'vitest';
import {
  isGenuineRebirthOperatorMessage,
  selectRoleAwareRebirthDialogueWindow,
} from '../src/rebirthDialogue.ts';

describe('rebirth dialogue window', () => {
  test('retains the latest 15 genuine users and 15 assistants across 5,000 tool-heavy rows', () => {
    const messages: Array<{
      id: string;
      type: string;
      text: string;
      created_at: string;
    }> = [];
    let sequence = 0;
    const push = (type: string, text: string): void => {
      messages.push({
        id: `m-${sequence}`,
        type,
        text,
        created_at: new Date(Date.UTC(2026, 6, 20, 0, 0, sequence++)).toISOString(),
      });
    };

    for (let i = 1; i <= 20; i += 1) {
      push('user', `operator-${String(i).padStart(2, '0')}`);
      push('assistant_text', `assistant-${String(i).padStart(2, '0')}`);
      for (let j = 0; j < 200; j += 1) {
        push(j % 2 === 0 ? 'tool_use' : 'tool_result', `noise-${i}-${j}`);
      }
    }
    push('user', '[CONTEXT REBIRTH] internal seed');
    push('user', 'My report quotes [CONTEXT REBIRTH] but is a real operator request.');
    push('assistant_text', 'assistant-21');
    while (messages.length < 5_000) push('tool_result', `tail-noise-${messages.length}`);

    const selected = selectRoleAwareRebirthDialogueWindow(messages, {
      recentUserMessages: 15,
      recentAssistantMessages: 15,
      recentAmbientMessages: 0,
    });
    const userTexts = selected.messages
      .filter((message) => message.type === 'user')
      .map((message) => message.text);
    const assistantTexts = selected.messages
      .filter((message) => message.type === 'assistant_text')
      .map((message) => message.text);

    expect(selected.messages).toHaveLength(30);
    expect(userTexts).toHaveLength(15);
    expect(userTexts[0]).toBe('operator-07');
    expect(userTexts.at(-1)).toContain('My report quotes [CONTEXT REBIRTH]');
    expect(userTexts).not.toContain('[CONTEXT REBIRTH] internal seed');
    expect(assistantTexts).toHaveLength(15);
    expect(assistantTexts[0]).toBe('assistant-07');
    expect(assistantTexts.at(-1)).toBe('assistant-21');
    expect(selected.coverage.persistedGenuineUsers).toBe(21);
    expect(selected.coverage.persistedAssistants).toBe(21);
  });

  test('uses strict whole-message exclusions without suppressing quoted markers', () => {
    expect(isGenuineRebirthOperatorMessage('[CONTEXT REBIRTH] internal seed')).toBe(false);
    expect(isGenuineRebirthOperatorMessage('[Chronological Provenance v1] internal band')).toBe(false);
    expect(isGenuineRebirthOperatorMessage('@agent ping')).toBe(false);
    expect(isGenuineRebirthOperatorMessage('Please inspect this quote: [CONTEXT REBIRTH]')).toBe(true);
    expect(isGenuineRebirthOperatorMessage('Why did [Chronological Provenance v1] hide my turn?')).toBe(true);
  });

  test('keeps chronological order after independently applying role quotas', () => {
    const selected = selectRoleAwareRebirthDialogueWindow([
      { id: 'u1', type: 'user', text: 'u1' },
      { id: 't1', type: 'tool_result', text: 't1' },
      { id: 'a1', type: 'assistant_text', text: 'a1' },
      { id: 'u2', type: 'user', text: 'u2' },
      { id: 't2', type: 'tool_result', text: 't2' },
      { id: 'a2', type: 'assistant_text', text: 'a2' },
    ], {
      recentUserMessages: 1,
      recentAssistantMessages: 2,
      recentAmbientMessages: 1,
    });

    expect(selected.messages.map((message) => message.id)).toEqual(['a1', 'u2', 't2', 'a2']);
  });
});
