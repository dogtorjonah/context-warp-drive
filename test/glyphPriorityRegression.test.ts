import { describe, expect, test } from 'vitest';

import {
  classifyAssistantRegister,
  type AssistantRegister,
} from '../src/glyphs.ts';
import {
  ASSISTANT_GLYPH_VAULT_MAX_MESSAGES,
  assistantGlyphPriority,
  selectVaultRows,
  type AssistantGlyphVaultEntry,
  type UserMessageVaultEntry,
} from '../src/userMessageVault.ts';
import {
  selectVoiceInlays,
  type EpisodeAnnotation,
} from '../src/foldEpisodes.ts';
import {
  DEFAULT_FIDELITY_VALUE_WEIGHTS,
  detectTurns,
  scoreTurnFidelityValue,
  type FoldMessage,
} from '../src/rollingFold.ts';

function toolTurn(index: number, assistantText: string, path = `/repo/glyph-priority-${index}.ts`): FoldMessage[] {
  const id = `glyph-priority-${index}`;
  return [
    { role: 'user', content: `inspect ${path}` },
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `body ${index}` }] },
    { role: 'assistant', content: assistantText },
  ];
}

function annotation(
  kind: EpisodeAnnotation['kind'],
  text: string,
  ts: string,
): EpisodeAnnotation {
  return { kind, text, ts };
}

describe('glyph priority remains executable across every memory consumer', () => {
  test('waypoint persistence uses the exact register trust matrix', () => {
    const classifications = (['verdict', 'hazard', 'blocked', 'in_progress', 'executing'] as AssistantRegister[])
      .map((register) => classifyAssistantRegister(register));

    expect(classifications).toEqual([
      { register: 'verdict', trust: 'durable', durable: true, final: true },
      { register: 'hazard', trust: 'durable', durable: true, final: true },
      { register: 'blocked', trust: 'blocked', durable: false, final: true },
      { register: 'in_progress', trust: 'transient', durable: false, final: false },
      { register: 'executing', trust: 'transient', durable: false, final: false },
    ]);
    expect(classifyAssistantRegister(null)).toEqual({
      register: null,
      trust: 'low_trust',
      durable: false,
      final: false,
    });
  });

  test('vault arithmetic and the independent assistant retention ceiling stay exact', () => {
    expect({
      verdict: assistantGlyphPriority('verdict'),
      hazard: assistantGlyphPriority('hazard'),
      blocked: assistantGlyphPriority('blocked'),
      untagged: assistantGlyphPriority(undefined),
      inProgress: assistantGlyphPriority('working'),
      executing: assistantGlyphPriority('executing'),
    }).toEqual({ verdict: 4, hazard: 4, blocked: 3, untagged: 2, inProgress: 1, executing: 1 });
    expect(ASSISTANT_GLYPH_VAULT_MAX_MESSAGES).toBe(4);

    const userEntries: UserMessageVaultEntry[] = [
      { text: 'OPERATOR_FLOOR_ONE', createdAt: '2026-07-22T01:00:00.000Z' },
      { text: 'OPERATOR_FLOOR_TWO', createdAt: '2026-07-22T01:01:00.000Z' },
    ];
    const assistantEntries: AssistantGlyphVaultEntry[] = [
      { text: '🏁 VERDICT_KEEP', createdAt: '2026-07-22T01:02:00.000Z', glyph: 'verdict' },
      { text: '⚠️ HAZARD_KEEP', createdAt: '2026-07-22T01:03:00.000Z', glyph: 'hazard' },
      { text: '❓ BLOCKED_KEEP', createdAt: '2026-07-22T01:04:00.000Z', glyph: 'blocked' },
      { text: 'UNTAGGED_KEEP', createdAt: '2026-07-22T01:05:00.000Z' },
      { text: '🔍 WORKING_DROP', createdAt: '2026-07-22T01:06:00.000Z', glyph: 'working' },
      { text: '▶ EXECUTING_DROP', createdAt: '2026-07-22T01:07:00.000Z', glyph: 'executing' },
    ];
    const rows = selectVaultRows(userEntries, assistantEntries, undefined, {
      WARP_USER_VAULT_MAX_MESSAGES: '8',
      WARP_ASSISTANT_VAULT_MAX_MESSAGES: String(ASSISTANT_GLYPH_VAULT_MAX_MESSAGES),
      WARP_USER_VAULT_MAX_CHARS: '8000',
    });

    expect(rows.filter((row) => row.role === 'user').map((row) => row.text)).toEqual([
      'OPERATOR_FLOOR_ONE',
      'OPERATOR_FLOOR_TWO',
    ]);
    expect(rows.filter((row) => row.role === 'assistant').map((row) => row.text)).toEqual([
      '🏁 VERDICT_KEEP',
      '⚠️ HAZARD_KEEP',
      '❓ BLOCKED_KEEP',
      'UNTAGGED_KEEP',
    ]);
  });

  test('declared conclusions outrank untagged narration in episode voice trust', () => {
    const untagged = annotation('narration', 'Poked at the recall path.', '2026-07-22T01:00:00.000Z');
    const verdict = annotation('narration:verdict', 'Fixed the recall path.', '2026-07-22T01:01:00.000Z');
    const hazard = annotation('narration:hazard', 'The stale cursor is hazardous.', '2026-07-22T01:02:00.000Z');

    expect(selectVoiceInlays([untagged, verdict, hazard], 2)).toEqual([verdict, hazard]);
  });

  test('fold-recall value weighting rewards only durable declared conclusions', () => {
    expect(DEFAULT_FIDELITY_VALUE_WEIGHTS).toMatchObject({
      glyphDurableBonus: 2,
      glyphTransientDiscount: 1,
    });
    const messages = [
      ...toolTurn(0, '🏁 verified conclusion'),
      ...toolTurn(1, '⚠️ durable hazard'),
      ...toolTurn(2, '❓ blocked pending input'),
      ...toolTurn(3, 'plain untagged narration'),
      ...toolTurn(4, '🔍 still investigating'),
      ...toolTurn(5, '▶ running the validation'),
    ];

    expect(scoreTurnFidelityValue(detectTurns(messages), 6)).toEqual([2, 2, 0, 0, 0, 0]);

    const supersessionMessages = [
      ...toolTurn(6, '🔍 investigating the shared path', '/repo/shared-path.ts'),
      ...toolTurn(7, '🏁 verified the shared path', '/repo/shared-path.ts'),
    ];
    expect(scoreTurnFidelityValue(detectTurns(supersessionMessages), 2, {
      ...DEFAULT_FIDELITY_VALUE_WEIGHTS,
      read: 0,
      claim: 0,
      edit: 0,
      userNamed: 0,
      activeWindowMultiplier: 0,
    })).toEqual([-1, 2]);
  });
});
