import { describe, expect, test } from 'vitest';

import {
  recordAssistantGlyphVaultEntry,
  recordUserMessageVaultEntry,
  renderVaultRowsBlock,
  selectSealableVaultRows,
  selectVaultDeltaRows,
  selectVaultRows,
  vaultRowFingerprint,
  type AssistantGlyphVaultEntry,
  type EditProvenanceVaultEntry,
  type UserMessageVaultEntry,
} from '../src/userMessageVault.ts';

describe('package-canonical user-message vault core', () => {
  test('the portable adapter routes operator, assistant, and edit evidence through one selector', () => {
    const users: UserMessageVaultEntry[] = [];
    const assistants: AssistantGlyphVaultEntry[] = [];
    recordUserMessageVaultEntry(
      users,
      'operator continuity',
      '2026-07-25T04:00:00.000Z',
      { taskFrontier: true },
    );
    recordAssistantGlyphVaultEntry(
      assistants,
      '🏁 assistant continuity',
      '2026-07-25T04:01:00.000Z',
    );
    const edits: EditProvenanceVaultEntry[] = [{
      instanceId: 'canonical-core-test',
      toolName: 'Edit',
      filePath: 'src/canonical-core.ts',
      diffHash: '0123456789abcdef0123456789abcdef',
      newString: 'export const canonical = true;',
      createdAt: '2026-07-25T04:02:00.000Z',
    }];

    const rows = selectVaultRows(users, assistants, { editEntries: edits });

    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant', 'edit']);
    const rendered = renderVaultRowsBlock(rows);
    expect(rendered).toContain('operator continuity');
    expect(rendered).toContain('assistant continuity');
    expect(rendered).toContain('src/canonical-core.ts');
    expect(rendered).toContain('authority=historical-background');
  });

  test('seal selection and delta dedupe share the canonical row fingerprint', () => {
    const users: UserMessageVaultEntry[] = [];
    recordUserMessageVaultEntry(users, 'seal once', '2026-07-25T04:03:00.000Z');
    const rows = selectSealableVaultRows(selectVaultRows(users, []));
    const sealed = new Set(rows.map(vaultRowFingerprint));

    expect(selectVaultDeltaRows(rows, new Set())).toEqual(rows);
    expect(selectVaultDeltaRows(rows, sealed)).toEqual([]);
  });

  test('unknown source time sorts after dated evidence with stable ties', () => {
    const assistants: AssistantGlyphVaultEntry[] = [
      { text: 'UNDATED_A', glyph: 'verdict' },
      { text: 'UNDATED_B', glyph: 'hazard' },
    ];
    const rows = selectVaultRows(
      [{ text: 'DATED', createdAt: '2026-07-25T04:04:00.000Z' }],
      assistants,
    );
    const repeated = selectVaultRows(
      [{ text: 'DATED', createdAt: '2026-07-25T04:04:00.000Z' }],
      assistants,
    );

    expect(rows[0].text).toBe('DATED');
    expect(repeated.map((row) => row.text)).toEqual(rows.map((row) => row.text));
  });

  test('demotes old operator rows while preserving assistant and edit evidence across the frontier', () => {
    const users: UserMessageVaultEntry[] = [
      {
        text: 'STALE_APPROVAL_DO_NOT_EXECUTE',
        createdAt: '2026-07-25T03:58:00.000Z',
        taskFrontier: true,
      },
      {
        text: 'CURRENT_OPERATOR_REQUEST',
        createdAt: '2026-07-25T04:00:00.000Z',
        taskFrontier: true,
      },
      {
        text: 'UNKNOWN_TIME_OPERATOR',
      },
    ];
    const assistants: AssistantGlyphVaultEntry[] = [{
      text: '🏁 PRIOR_TASK_VERDICT',
      createdAt: '2026-07-25T03:59:00.000Z',
      glyph: 'verdict',
    }];
    const edits: EditProvenanceVaultEntry[] = [{
      instanceId: 'canonical-core-test',
      toolName: 'Edit',
      filePath: 'src/prior-task-edit.ts',
      diffHash: 'fedcba9876543210fedcba9876543210',
      createdAt: '2026-07-25T03:59:30.000Z',
    }];

    const rows = selectVaultRows(users, assistants, { editEntries: edits });
    const operatorRows = rows.filter((row) => row.role === 'user');

    expect(operatorRows.map((row) => [row.text, row.taskScope])).toEqual([
      ['STALE_APPROVAL_DO_NOT_EXECUTE', 'historical'],
      ['CURRENT_OPERATOR_REQUEST', 'current-task'],
      ['UNKNOWN_TIME_OPERATOR', 'historical'],
    ]);
    expect(rows.map((row) => row.text)).toContain('🏁 PRIOR_TASK_VERDICT');
    expect(rows.some((row) => row.role === 'edit' && row.text.includes('src/prior-task-edit.ts')))
      .toBe(true);

    const rendered = renderVaultRowsBlock(rows);
    expect(rendered).toContain(
      'task-scope=historical authority=historical-background',
    );
    expect(rendered).toContain('task-scope=current-task');
    expect(rendered).toContain('authorization=expired');
    expect(rendered).not.toContain('authorization=live');
  });

  test('dedupes assistant evidence already carried by a synthetic user message', () => {
    const rows = selectVaultRows(
      [{ text: 'operator continuity', createdAt: '2026-07-25T04:00:00.000Z' }],
      [{
        text: '🏁 assistant continuity',
        createdAt: '2026-07-25T04:01:00.000Z',
        glyph: 'verdict',
      }],
      {
        visibleUserMessages: [{
          role: 'user',
          content: '[cognitive]\\n🏁 assistant continuity\\n[Fold receipts]',
        }],
      },
    );

    expect(rows.map((row) => row.text)).toEqual(['operator continuity']);
  });
});
