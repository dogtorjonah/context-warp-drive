import { describe, expect, test } from 'vitest';

import {
  ALWAYS_ON_FOLD_CONFIG,
  appendUserMessageVaultToView,
  assistantGlyphPriority,
  DEFAULT_USER_MESSAGE_VAULT_MIN_UTILIZATION,
  FoldSession,
  recordAssistantGlyphVaultEntry,
  recordUserMessageVaultEntry,
  renderUserMessageVault,
  resolveUserMessageVaultMaxChars,
  resolveUserMessageVaultMaxMessages,
  resolveUserMessageVaultMinUtilization,
  seedUserMessageVaultFromMessages,
  stripUserMessageVaultBlocks,
  USER_MESSAGE_VAULT_END,
  USER_MESSAGE_VAULT_MAX_CHARS,
  USER_MESSAGE_VAULT_MAX_MESSAGES,
  USER_MESSAGE_VAULT_PREFIX,
  type AssistantGlyphVaultEntry,
  type FoldMessage,
  type UserMessageVaultEntry,
} from '../src/fold.js';

const VAULT = `${USER_MESSAGE_VAULT_PREFIX}\nbounded operator excerpts\n${USER_MESSAGE_VAULT_END}`;

function messageText(message: unknown): string {
  const msg = message as { content?: unknown; parts?: unknown };
  if (typeof msg.content === 'string') return msg.content;
  const arr = Array.isArray(msg.content) ? msg.content : Array.isArray(msg.parts) ? msg.parts : [];
  return arr
    .map((block) => (block && typeof block === 'object' ? String((block as { text?: unknown }).text ?? '') : ''))
    .join('\n');
}

function countVaultBlocks(view: unknown[]): number {
  return view.filter((m) => messageText(m).includes(USER_MESSAGE_VAULT_PREFIX)).length;
}

function userMsg(text: string): FoldMessage {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): FoldMessage {
  return { role: 'assistant', content: text };
}

describe('userMessageVault', () => {
  test('retains only the last six operator messages within the hard block cap', () => {
    const entries: UserMessageVaultEntry[] = [];
    for (let i = 1; i <= 7; i += 1) {
      recordUserMessageVaultEntry(entries, `operator payload ${i}`, `2026-06-16T07:3${i}:00.000Z`);
    }

    const vault = renderUserMessageVault(entries);

    expect(entries).toHaveLength(6);
    expect(vault.startsWith(USER_MESSAGE_VAULT_PREFIX)).toBe(true);
    expect(vault.endsWith(USER_MESSAGE_VAULT_END)).toBe(true);
    expect(vault).toContain('Sealed Exchange Vault');
    expect(vault).toContain('not a transcript archive');
    expect(vault).toContain('artifact=glyph-vault#operator-only class=exact-excerpt');
    expect(vault).toContain('source=vault-buffer:row#0..vault-buffer:row#6 n=6');
    expect(vault).toContain('authority=historical-background');
    expect(vault).toContain('host=embedded-message-suffix representation=alias');
    expect(vault.length).toBeLessThanOrEqual(USER_MESSAGE_VAULT_MAX_CHARS);
    expect(vault).not.toContain('operator payload 1');
    expect(vault).toContain('operator payload 7');
  });

  test('uses head-tail excerpts for oversized newest and older messages', () => {
    const entries: UserMessageVaultEntry[] = [];
    recordUserMessageVaultEntry(entries, `older-start ${'a'.repeat(2_000)} older-end`);
    recordUserMessageVaultEntry(entries, `newest-start ${'b'.repeat(3_000)} newest-end`);

    const vault = renderUserMessageVault(entries);

    expect(vault).toContain('chars omitted');
    expect(vault).toContain('older-start');
    expect(vault).toContain('older-end');
    expect(vault).toContain('newest-start');
    expect(vault).toContain('newest-end');
    expect(vault.length).toBeLessThanOrEqual(USER_MESSAGE_VAULT_MAX_CHARS);
  });

  test('omits entries whose operator text is already visible in context', () => {
    const entries: UserMessageVaultEntry[] = [];
    recordUserMessageVaultEntry(entries, 'origin instruction that paged out');
    recordUserMessageVaultEntry(entries, 'current request still visible');

    const vault = renderUserMessageVault(entries, {
      visibleUserTexts: ['[Host Context]\nSession age: 2m\n\ncurrent request still visible'],
    });

    expect(vault).toContain('origin instruction that paged out');
    expect(vault).not.toContain('[operator message 2/2');
    expect(vault).not.toContain('current request still visible');
  });

  test('does not omit short entries from partial-word visible text collisions', () => {
    const entries: UserMessageVaultEntry[] = [];
    recordUserMessageVaultEntry(entries, 'on');
    recordUserMessageVaultEntry(entries, 'go');
    recordUserMessageVaultEntry(entries, 'it');

    const vault = renderUserMessageVault(entries, {
      visibleUserTexts: ['Session continues while the monitor is doing normal work.'],
    });

    expect(vault).toContain('[operator message 1/3]\non\n');
    expect(vault).toContain('[operator message 2/3]\ngo\n');
    expect(vault).toContain('[operator message 3/3]\nit\n');
  });

  test('omits visible entries with case-insensitive word-boundary matches', () => {
    const entries: UserMessageVaultEntry[] = [];
    recordUserMessageVaultEntry(entries, 'Go');
    recordUserMessageVaultEntry(entries, 'Fix the pane');
    recordUserMessageVaultEntry(entries, 'origin instruction that paged out');

    const vault = renderUserMessageVault(entries, {
      visibleUserTexts: ['please go now\n\nwe should fix the pane before restart'],
    });

    expect(vault).toContain('origin instruction that paged out');
    expect(vault).not.toContain('Go');
    expect(vault).not.toContain('Fix the pane');
  });

  test('returns empty when every retained entry is already visible', () => {
    const entries: UserMessageVaultEntry[] = [];
    recordUserMessageVaultEntry(entries, 'first visible request');
    recordUserMessageVaultEntry(entries, 'second visible request');

    expect(
      renderUserMessageVault(entries, {
        visibleUserMessages: [
          { role: 'user', content: 'first visible request' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: [{ type: 'text', text: `second visible request\n\n${VAULT}` }] },
        ],
      }),
    ).toBe('');
  });

  test('strips vault blocks from mixed text', () => {
    const mixed = `real request\n\n${USER_MESSAGE_VAULT_PREFIX}\nold copy\n${USER_MESSAGE_VAULT_END}\n\nfollow-up`;

    expect(stripUserMessageVaultBlocks(mixed)).toBe('real request\n\nfollow-up');
  });

  test('leaves incomplete marker mentions alone', () => {
    const text = `please inspect this literal marker: ${USER_MESSAGE_VAULT_PREFIX}`;

    expect(stripUserMessageVaultBlocks(text)).toBe(text);
  });
});

describe('appendUserMessageVaultToView', () => {
  test('appends exactly one vault block to the newest user turn across many turns', () => {
    const view = [
      { role: 'user', content: 'first operator turn' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'second operator turn' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'third operator turn' },
    ];

    const out = appendUserMessageVaultToView(view, VAULT);

    expect(countVaultBlocks(out)).toBe(1);
    expect(messageText(out[4])).toContain(USER_MESSAGE_VAULT_PREFIX);
    expect(messageText(out[0])).not.toContain(USER_MESSAGE_VAULT_PREFIX);
    expect(messageText(out[2])).not.toContain(USER_MESSAGE_VAULT_PREFIX);
  });

  test('does not mutate the input view or its messages', () => {
    const newest = { role: 'user', content: 'newest' };
    const view = [{ role: 'user', content: 'older' }, newest];

    const out = appendUserMessageVaultToView(view, VAULT);

    expect(out).not.toBe(view);
    expect(newest.content).toBe('newest');
    expect(out[1]).not.toBe(newest);
    expect(messageText(out[1])).toBe(`newest\n\n${VAULT}`);
  });

  test('appends a trailing text block to array (content-block) user turns', () => {
    const view = [
      { role: 'user', content: [{ type: 'text', text: 'array turn' }] },
    ];

    const out = appendUserMessageVaultToView(view, VAULT);
    const content = (out[0] as { content: Array<{ type: string; text: string }> }).content;

    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({ type: 'text', text: VAULT });
  });

  test('appends a trailing text part to Gemini-style parts user turns', () => {
    const view = [
      { role: 'user', parts: [{ text: 'gemini turn' }] },
    ];

    const out = appendUserMessageVaultToView(view, VAULT);
    const parts = (out[0] as { parts: Array<{ text: string }> }).parts;

    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({ text: VAULT });
  });

  test('skips tool-result user turns (no top-level text) and lands on the operator turn', () => {
    const view = [
      { role: 'user', content: 'operator text turn' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ];

    const out = appendUserMessageVaultToView(view, VAULT);

    expect(countVaultBlocks(out)).toBe(1);
    expect(messageText(out[0])).toContain(USER_MESSAGE_VAULT_PREFIX);
    expect(countVaultBlocks([out[2]])).toBe(0);
  });

  test('tailWindow bounds the append to the raw tail (never the frozen prefix)', () => {
    const view = [
      { role: 'user', content: 'frozen operator turn' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ];

    // Only the last 2 messages are in the raw tail; the lone text turn is frozen.
    const out = appendUserMessageVaultToView(view, VAULT, 2);

    expect(out).toBe(view);
    expect(countVaultBlocks(out)).toBe(0);
  });

  test('returns the same reference when the vault is empty or there is no target', () => {
    const view = [{ role: 'assistant', content: 'no user turns here' }];

    expect(appendUserMessageVaultToView(view, '')).toBe(view);
    expect(appendUserMessageVaultToView(view, VAULT)).toBe(view);
  });
});

describe('seedUserMessageVaultFromMessages', () => {
  const sanitize = (text: string) =>
    text.startsWith('[synthetic]') ? '' : text.replace(/^\[prefix\]\s*/, '');

  test('keeps only genuine user prose, applying the sanitizer and skipping non-string content', () => {
    const messages = [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'a reply' },
      { role: 'user', content: '[synthetic] relay note' },
      { role: 'user', content: '[prefix] real follow-up' },
      { role: 'user', content: 42 },
      { role: 'tool', content: 'tool output' },
    ];

    const entries = seedUserMessageVaultFromMessages(messages as never, sanitize);

    expect(entries.map((e) => e.text)).toEqual(['first request', 'real follow-up']);
  });

  test('caps at the six newest user messages', () => {
    const messages = Array.from({ length: 9 }, (_, i) => ({ role: 'user', content: `msg ${i + 1}` }));

    const entries = seedUserMessageVaultFromMessages(messages, (t) => t);

    expect(entries).toHaveLength(6);
    expect(entries[0].text).toBe('msg 4');
    expect(entries[5].text).toBe('msg 9');
  });

  test('returns an empty list when there is no genuine user prose', () => {
    expect(seedUserMessageVaultFromMessages([{ role: 'assistant', content: 'x' }], (t) => t)).toEqual([]);
  });

  test('lifts createdAt when the sanitizer returns a {text, createdAt} pair', () => {
    const messages = [
      { role: 'user', content: 'STAMP first request' },
      { role: 'user', content: 'plain second request' },
    ];
    const parse = (text: string) =>
      text.startsWith('STAMP ')
        ? { text: text.slice('STAMP '.length), createdAt: '2026-06-16 14:08' }
        : { text };

    const entries = seedUserMessageVaultFromMessages(messages as never, parse);

    expect(entries).toEqual([
      { text: 'first request', createdAt: '2026-06-16 14:08' },
      { text: 'plain second request', createdAt: undefined },
    ]);
  });
});

describe('resolveUserMessageVaultMinUtilization', () => {
  test('defaults when unset, empty, or invalid', () => {
    expect(resolveUserMessageVaultMinUtilization({})).toBe(DEFAULT_USER_MESSAGE_VAULT_MIN_UTILIZATION);
    expect(resolveUserMessageVaultMinUtilization({ WARP_USER_VAULT_MIN_UTILIZATION: '' })).toBe(
      DEFAULT_USER_MESSAGE_VAULT_MIN_UTILIZATION,
    );
    expect(resolveUserMessageVaultMinUtilization({ WARP_USER_VAULT_MIN_UTILIZATION: 'nope' })).toBe(
      DEFAULT_USER_MESSAGE_VAULT_MIN_UTILIZATION,
    );
    expect(resolveUserMessageVaultMinUtilization({ WARP_USER_VAULT_MIN_UTILIZATION: '-0.2' })).toBe(
      DEFAULT_USER_MESSAGE_VAULT_MIN_UTILIZATION,
    );
  });

  test('parses and clamps a configured fraction to [0, 1]', () => {
    expect(resolveUserMessageVaultMinUtilization({ WARP_USER_VAULT_MIN_UTILIZATION: '0.8' })).toBe(0.8);
    expect(resolveUserMessageVaultMinUtilization({ WARP_USER_VAULT_MIN_UTILIZATION: '0' })).toBe(0);
    expect(resolveUserMessageVaultMinUtilization({ WARP_USER_VAULT_MIN_UTILIZATION: '2' })).toBe(1);
  });
});

describe('vault bound env tunables', () => {
  test('resolveUserMessageVaultMaxMessages: default unless a positive int override is set', () => {
    expect(resolveUserMessageVaultMaxMessages({})).toBe(USER_MESSAGE_VAULT_MAX_MESSAGES);
    expect(resolveUserMessageVaultMaxMessages({ WARP_USER_VAULT_MAX_MESSAGES: '3' })).toBe(3);
    expect(resolveUserMessageVaultMaxMessages({ WARP_USER_VAULT_MAX_MESSAGES: '0' })).toBe(USER_MESSAGE_VAULT_MAX_MESSAGES);
    expect(resolveUserMessageVaultMaxMessages({ WARP_USER_VAULT_MAX_MESSAGES: 'nope' })).toBe(USER_MESSAGE_VAULT_MAX_MESSAGES);
  });

  test('resolveUserMessageVaultMaxChars: default unless a positive int override is set', () => {
    expect(resolveUserMessageVaultMaxChars({})).toBe(USER_MESSAGE_VAULT_MAX_CHARS);
    expect(resolveUserMessageVaultMaxChars({ WARP_USER_VAULT_MAX_CHARS: '500' })).toBe(500);
    expect(resolveUserMessageVaultMaxChars({ WARP_USER_VAULT_MAX_CHARS: '-5' })).toBe(USER_MESSAGE_VAULT_MAX_CHARS);
  });

  test('recordUserMessageVaultEntry honors WARP_USER_VAULT_MAX_MESSAGES at runtime', () => {
    const prev = process.env.WARP_USER_VAULT_MAX_MESSAGES;
    process.env.WARP_USER_VAULT_MAX_MESSAGES = '2';
    try {
      const entries: UserMessageVaultEntry[] = [];
      for (let i = 1; i <= 5; i += 1) recordUserMessageVaultEntry(entries, `op ${i}`);
      expect(entries.map((e) => e.text)).toEqual(['op 4', 'op 5']);
    } finally {
      if (prev === undefined) delete process.env.WARP_USER_VAULT_MAX_MESSAGES;
      else process.env.WARP_USER_VAULT_MAX_MESSAGES = prev;
    }
  });

  test('fold-vault surfaces honor WARP_USER_VAULT_OLDER_CHARS (smaller cap → shorter excerpt)', () => {
    const entries: UserMessageVaultEntry[] = [
      { text: 'older-start ' + 'z'.repeat(5_000) + ' older-end', createdAt: '2026-06-16T10:00:00.000Z' },
      { text: 'newest stays on its own surface', createdAt: '2026-06-16T10:01:00.000Z' },
    ];
    const withDefault = renderUserMessageVault(entries);
    const prev = process.env.WARP_USER_VAULT_OLDER_CHARS;
    process.env.WARP_USER_VAULT_OLDER_CHARS = '300';
    try {
      const tuned = renderUserMessageVault(entries);
      expect(tuned.length).toBeLessThan(withDefault.length);
      expect(tuned).toContain('chars omitted');
      expect(tuned).toContain('newest stays on its own surface');
    } finally {
      if (prev === undefined) delete process.env.WARP_USER_VAULT_OLDER_CHARS;
      else process.env.WARP_USER_VAULT_OLDER_CHARS = prev;
    }
  });
});

describe('glyph grammar vault (assistant interleave)', () => {
  test('no assistant entries renders byte-identically to the operator-only vault', () => {
    const entries: UserMessageVaultEntry[] = [];
    for (let i = 1; i <= 3; i += 1) {
      recordUserMessageVaultEntry(entries, `operator payload ${i}`, `2026-06-16T07:3${i}:00.000Z`);
    }
    const operatorOnly = renderUserMessageVault(entries);
    const emptyAssistant = renderUserMessageVault(entries, { assistantEntries: [] });
    expect(emptyAssistant).toBe(operatorOnly);
  });

  test('recordAssistantGlyphVaultEntry classifies the opening register', () => {
    const entries: AssistantGlyphVaultEntry[] = [];
    recordAssistantGlyphVaultEntry(entries, '🏁 Verdict: done', '2026-06-16T10:00:00.000Z');
    recordAssistantGlyphVaultEntry(entries, '🔍 still digging', '2026-06-16T10:01:00.000Z');
    recordAssistantGlyphVaultEntry(entries, 'plain untagged note', '2026-06-16T10:02:00.000Z');
    recordAssistantGlyphVaultEntry(entries, '   ', '2026-06-16T10:03:00.000Z');
    expect(entries).toHaveLength(3);
    expect(entries[0].glyph).toBe('verdict');
    expect(entries[1].glyph).toBe('working');
    expect(entries[2].glyph).toBeUndefined();
  });

  test('assistantGlyphPriority ranks durable registers above transient ones', () => {
    expect(assistantGlyphPriority('verdict')).toBe(4);
    expect(assistantGlyphPriority('hazard')).toBe(4);
    expect(assistantGlyphPriority('blocked')).toBe(3);
    expect(assistantGlyphPriority(undefined)).toBe(2);
    expect(assistantGlyphPriority('working')).toBe(1);
    expect(assistantGlyphPriority('executing')).toBe(1);
    expect(assistantGlyphPriority(undefined)).toBeGreaterThan(assistantGlyphPriority('working'));
  });

  test('interleaves operator and assistant rows in chronological order', () => {
    const userEntries: UserMessageVaultEntry[] = [
      { text: 'OP_EARLY', createdAt: '2026-06-16T10:00:00.000Z' },
      { text: 'OP_LATE', createdAt: '2026-06-16T10:02:00.000Z' },
    ];
    const assistantEntries: AssistantGlyphVaultEntry[] = [
      { text: '🏁 ASST_MIDDLE verdict', createdAt: '2026-06-16T10:01:00.000Z', glyph: 'verdict' },
    ];
    const vault = renderUserMessageVault(userEntries, { assistantEntries });
    const early = vault.indexOf('OP_EARLY');
    const middle = vault.indexOf('ASST_MIDDLE');
    const late = vault.indexOf('OP_LATE');
    expect(early).toBeGreaterThanOrEqual(0);
    expect(middle).toBeGreaterThan(early);
    expect(late).toBeGreaterThan(middle);
    expect(vault).toContain('your 🏁 message');
  });

  test('selects durable glyph entries over transient ones within the assistant slice', () => {
    const userEntries: UserMessageVaultEntry[] = [{ text: 'OP', createdAt: '2026-06-16T10:00:00.000Z' }];
    const assistantEntries: AssistantGlyphVaultEntry[] = [
      { text: '🏁 VERDICT_A', createdAt: '2026-06-16T10:01:00.000Z', glyph: 'verdict' },
      { text: '🏁 VERDICT_B', createdAt: '2026-06-16T10:02:00.000Z', glyph: 'verdict' },
      { text: '⚠️ HAZARD_C', createdAt: '2026-06-16T10:03:00.000Z', glyph: 'hazard' },
      { text: '❓ BLOCKED_D', createdAt: '2026-06-16T10:04:00.000Z', glyph: 'blocked' },
      { text: '🔍 WORKING_E', createdAt: '2026-06-16T10:05:00.000Z', glyph: 'working' },
      { text: '🔍 WORKING_F', createdAt: '2026-06-16T10:06:00.000Z', glyph: 'working' },
    ];
    const vault = renderUserMessageVault(userEntries, { assistantEntries });
    expect(vault).toContain('VERDICT_A');
    expect(vault).toContain('VERDICT_B');
    expect(vault).toContain('HAZARD_C');
    expect(vault).toContain('BLOCKED_D');
    expect(vault).not.toContain('WORKING_E');
    expect(vault).not.toContain('WORKING_F');
  });

  test('vaults untagged assistant messages as the fallback path', () => {
    const userEntries: UserMessageVaultEntry[] = [{ text: 'OP', createdAt: '2026-06-16T10:00:00.000Z' }];
    const assistantEntries: AssistantGlyphVaultEntry[] = [
      { text: 'UNTAGGED_NOTE keeps the dialogue shape', createdAt: '2026-06-16T10:01:00.000Z', glyph: undefined },
    ];
    const vault = renderUserMessageVault(userEntries, { assistantEntries });
    expect(vault).toContain('UNTAGGED_NOTE');
    expect(vault).toContain('your message');
  });

  test('protects operator wording under the char cap by evicting assistant rows first', () => {
    const prev = process.env.WARP_USER_VAULT_MAX_CHARS;
    process.env.WARP_USER_VAULT_MAX_CHARS = '700';
    try {
      const userEntries: UserMessageVaultEntry[] = [
        { text: 'OPERATOR_FLOOR_KEEP', createdAt: '2026-06-16T10:00:00.000Z' },
      ];
      const assistantEntries: AssistantGlyphVaultEntry[] = [
        { text: `VERDICT_KEEP ${'v'.repeat(200)}`, createdAt: '2026-06-16T10:01:00.000Z', glyph: 'verdict' },
        { text: `WORKING_DROP ${'w'.repeat(200)}`, createdAt: '2026-06-16T10:02:00.000Z', glyph: 'working' },
      ];
      const vault = renderUserMessageVault(userEntries, { assistantEntries });
      expect(vault.length).toBeLessThanOrEqual(700);
      expect(vault).toContain('OPERATOR_FLOOR_KEEP');
      expect(vault).toContain('VERDICT_KEEP');
      expect(vault).not.toContain('WORKING_DROP');
    } finally {
      if (prev === undefined) delete process.env.WARP_USER_VAULT_MAX_CHARS;
      else process.env.WARP_USER_VAULT_MAX_CHARS = prev;
    }
  });

  test('drops assistant rows entirely before shrinking the operator floor', () => {
    const prev = process.env.WARP_USER_VAULT_MAX_CHARS;
    process.env.WARP_USER_VAULT_MAX_CHARS = '520';
    try {
      const userEntries: UserMessageVaultEntry[] = [
        { text: 'ONLY_OPERATOR_SURVIVES', createdAt: '2026-06-16T10:00:00.000Z' },
      ];
      const assistantEntries: AssistantGlyphVaultEntry[] = [
        { text: `🏁 ${'x'.repeat(400)}`, createdAt: '2026-06-16T10:01:00.000Z', glyph: 'verdict' },
      ];
      const vault = renderUserMessageVault(userEntries, { assistantEntries });
      expect(vault).toContain('ONLY_OPERATOR_SURVIVES');
      expect(vault.length).toBeLessThanOrEqual(520);
    } finally {
      if (prev === undefined) delete process.env.WARP_USER_VAULT_MAX_CHARS;
      else process.env.WARP_USER_VAULT_MAX_CHARS = prev;
    }
  });
});

describe('FoldSession vault opt-in', () => {
  test('default FoldSession leaves the send view untouched by the vault companion', () => {
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: false,
    });
    session.recordOperatorMessage('FOLDED_OPERATOR_REQUEST', '2026-06-16T10:00:00.000Z');
    session.recordAssistantMessage('🏁 FOLDED_ASSISTANT_VERDICT', '2026-06-16T10:01:00.000Z');

    const out = session.prepare([
      userMsg('FOLDED_OPERATOR_REQUEST'),
      assistantMsg('🏁 FOLDED_ASSISTANT_VERDICT'),
      userMsg('current raw-tail request'),
      assistantMsg('current raw-tail answer'),
    ]);

    expect(out.vault).toBeUndefined();
    expect(out.messages.some((message) => messageText(message).includes(USER_MESSAGE_VAULT_PREFIX))).toBe(false);
  });

  test('enabled FoldSession appends an interleaved glyph vault after older recorded turns fold', () => {
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 1 },
      freeze: false,
      vault: true,
    });
    session.recordOperatorMessage('FOLDED_OPERATOR_REQUEST', '2026-06-16T10:00:00.000Z');
    session.recordAssistantMessage('🏁 FOLDED_ASSISTANT_VERDICT', '2026-06-16T10:01:00.000Z');

    const out = session.prepare([
      userMsg('FOLDED_OPERATOR_REQUEST'),
      assistantMsg('🏁 FOLDED_ASSISTANT_VERDICT'),
      userMsg('current raw-tail request'),
      assistantMsg('current raw-tail answer'),
    ]);

    expect(out.vault).toContain(USER_MESSAGE_VAULT_PREFIX);
    expect(out.vault).toContain('FOLDED_OPERATOR_REQUEST');
    // The assistant verdict is no longer vaulted: durable-glyph skeleton
    // retention and the [cognitive] waypoint block both keep it visible in
    // the send view, so the vault's visible-text dedupe drops what would be a
    // third copy. The interleave engages only for glyph rows the view LOST —
    // the continuity guarantee is that the verdict survives somewhere visible.
    expect(out.vault).not.toContain('FOLDED_ASSISTANT_VERDICT');
    const viewText = out.messages.map(messageText).join('\n');
    expect(viewText).toContain('🏁 FOLDED_ASSISTANT_VERDICT');
    expect(viewText).toContain('[cognitive');
    expect(countVaultBlocks(out.messages)).toBe(1);
    expect(messageText(out.messages[out.messages.length - 2])).toContain(USER_MESSAGE_VAULT_PREFIX);
  });

  test('enabled FoldSession self-gates to empty when recorded messages remain visible in the raw view', () => {
    const session = new FoldSession({
      foldConfig: { ...ALWAYS_ON_FOLD_CONFIG, activeWindowTurns: 10 },
      freeze: false,
      vault: true,
    });
    session.recordOperatorMessage('STILL_VISIBLE_OPERATOR', '2026-06-16T10:00:00.000Z');
    session.recordAssistantMessage('🏁 STILL_VISIBLE_ASSISTANT', '2026-06-16T10:01:00.000Z');

    const out = session.prepare([
      userMsg('STILL_VISIBLE_OPERATOR'),
      assistantMsg('🏁 STILL_VISIBLE_ASSISTANT'),
    ]);

    expect(out.vault).toBeUndefined();
    expect(out.messages.some((message) => messageText(message).includes(USER_MESSAGE_VAULT_PREFIX))).toBe(false);
  });
});
