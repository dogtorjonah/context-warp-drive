// ─────────────────────────────────────────────────────────────────────────────
// Authoritative test-runner note (rail-ed4a7878 step-9)
//
// In the my-monorepo monorepo this file is NOT executed by the relay's vitest:
// that runner's `include` is scoped to relay/src/__tests__, and context-warp is
// not a monorepo npm workspace, so its devDeps (vitest ^2.1.0) are not installed
// in-tree and `vitest/config` does not resolve from here.
//
// The canonical fold engine IS covered in-tree by relay/src/__tests__/rollingFold.test.ts
// (currently 169 tests, green): relay/src/rollingFold.ts is a zero-logic
// `export *` re-export shim of THIS package's src/rollingFold.ts (enforced by the
// context-warp-parity check, drift=0), so every relay assertion executes this
// package's own source. There is no shim-only coverage illusion — the canonical
// copy, not just the shim, is what runs.
//
// To run THIS standalone copy directly (e.g. published-package CI), provision the
// package's own devDeps first:
//   cd packages/context-warp && npm install && npm test
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, test } from 'vitest';

import {
  classifyTurn,
  skeletonizeTool,
  extractAssistantEssence,
  extractAssistantText,
  extractUserText,
  extractToolPathSet,
  collapseSequences,
  checkFoldTrigger,
  foldContext,
  planActiveTurnStepFold,
  countChars,
  detectTurns,
  intraTurnFold,
  nominateVerbatim,
  normalizeNumericForm,
  isConservedIn,
  extractVerbatimContextLabel,
  LABEL_MAX_CHARS,
  isSyntheticContextText,
  stripSyntheticUserContextBlocks,
  stripUserMessageVaultBlocks,
  USER_MESSAGE_VAULT_END,
  USER_MESSAGE_VAULT_PREFIX,
  formatFoldEpochStamp,
  formatFoldTombstoneLine,
  mergeEvictionSpans,
  computeEvictableThroughOrdinal,
  resolveFoldBandBudgets,
  resolveFoldConfigForBand,
  FOLD_BLOCK_PREAMBLE,
  FOLD_TOMBSTONE_PREFIX,
  ALWAYS_ON_FOLD_CONFIG,
  DEFAULT_FOLD_BAND_TOKENS,
  DEFAULT_FOLD_EVICT_THRESHOLD_CHARS,
  DEFAULT_FOLD_CONFIG,
  DEFAULT_ASSISTANT_TEXT_BUDGET,
  DEFAULT_INTRA_FOLD_CONFIG,
  type FoldMessage,
  type FoldedTurn,
  type FoldConfig,
  type AssistantTextBudget,
  type IntraTurnFoldConfig,
  type FoldEvictionInput,
  type FoldEvictionSpan,
} from '../src/rollingFold.js';

// ── Helpers ──

function userMsg(text: string): FoldMessage {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): FoldMessage {
  return { role: 'assistant', content: text };
}

function anthropicToolUse(name: string, input: Record<string, unknown>, id = 'toolu_' + Math.random().toString(36).slice(2, 8)): FoldMessage {
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

function openaiToolCall(name: string, args: Record<string, unknown>, id = 'call_' + Math.random().toString(36).slice(2, 8)): FoldMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

function openaiToolResult(callId: string, content: string): FoldMessage {
  return { role: 'tool', content, tool_call_id: callId };
}

function buildResearchTurn(): FoldMessage[] {
  const id1 = 'toolu_read1';
  const id2 = 'toolu_grep1';
  return [
    userMsg('Look at the auth module'),
    anthropicToolUse('Read', { file_path: '/home/user/project/src/auth.ts' }, id1),
    anthropicToolResult(id1, 'export function authenticate(token: string) {\n  // ...\n}\n'.repeat(20)),
    anthropicToolUse('Grep', { pattern: 'authenticate', path: '/home/user/project/src' }, id2),
    anthropicToolResult(id2, 'src/auth.ts\nsrc/middleware.ts\nsrc/routes.ts'),
    assistantMsg('The auth module exports authenticate() which is used in middleware and routes.'),
  ];
}

function buildActionTurn(): FoldMessage[] {
  const id1 = 'toolu_edit1';
  return [
    userMsg('Fix the auth bug'),
    anthropicToolUse('Edit', { file_path: '/home/user/project/src/auth.ts', old_string: 'return false;', new_string: 'return true;' }, id1),
    anthropicToolResult(id1, 'File edited successfully'),
    assistantMsg('Fixed the auth bug — the return value was inverted. The fix changes `return false` to `return true` because the token validation was rejecting valid tokens.'),
  ];
}

function buildDecisionTurn(): FoldMessage[] {
  return [
    userMsg('What approach should we take?'),
    assistantMsg('After reviewing the codebase, I recommend the following approach:\n\n1. Refactor the auth module to use JWT tokens\n2. Add rate limiting middleware\n3. Update the database schema\n\nThe reason is that JWT provides stateless authentication which scales better. The current session-based approach requires server-side state that breaks under load.'),
  ];
}

function buildCoordinationTurn(): FoldMessage[] {
  const id1 = 'toolu_chat1';
  return [
    userMsg('Check in with the team'),
    anthropicToolUse('mcp__voxxo-swarm-bridge__chatroom', { action: 'send', room: 'dev-auth', message: 'Auth refactor complete' }, id1),
    anthropicToolResult(id1, 'Message sent to #dev-auth'),
    assistantMsg('Posted the update to the dev-auth chatroom.'),
  ];
}

function buildErrorTurn(): FoldMessage[] {
  const id1 = 'toolu_bash1';
  return [
    userMsg('Build the project'),
    anthropicToolUse('Bash', { command: 'npm run build' }, id1),
    anthropicToolResult(id1, 'Error: TypeScript compilation failed\nsrc/auth.ts(42): error TS2345'),
    assistantMsg('The build failed due to a type error in auth.ts line 42.'),
  ];
}

// ══════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════

describe('classifyTurn', () => {
  test('classifies research turns', () => {
    expect(classifyTurn(buildResearchTurn())).toBe('research');
  });

  test('classifies action turns', () => {
    expect(classifyTurn(buildActionTurn())).toBe('action');
  });

  test('classifies decision turns', () => {
    expect(classifyTurn(buildDecisionTurn())).toBe('decision');
  });

  test('classifies coordination turns', () => {
    expect(classifyTurn(buildCoordinationTurn())).toBe('coordination');
  });

  test('classifies error turns', () => {
    expect(classifyTurn(buildErrorTurn())).toBe('error');
  });

  test('classifies navigation turns (short assistant, no tools)', () => {
    const turn = [userMsg('hmm'), assistantMsg('Ok.')];
    expect(classifyTurn(turn)).toBe('navigation');
  });

  test('action takes priority over research (mixed turn)', () => {
    const id1 = 'toolu_r1';
    const id2 = 'toolu_e1';
    const mixed = [
      userMsg('Read and fix'),
      anthropicToolUse('Read', { file_path: 'src/auth.ts' }, id1),
      anthropicToolResult(id1, 'source code'),
      anthropicToolUse('Edit', { file_path: 'src/auth.ts', old_string: 'a', new_string: 'b' }, id2),
      anthropicToolResult(id2, 'edited'),
    ];
    expect(classifyTurn(mixed)).toBe('action');
  });

  test('empty turn classifies as navigation', () => {
    expect(classifyTurn([userMsg('')])).toBe('navigation');
  });

  test('source code containing "error:" does not misclassify as error', () => {
    const id1 = 'toolu_read_err';
    const turn = [
      userMsg('Read the error handler'),
      anthropicToolUse('Read', { file_path: 'src/errorHandler.ts' }, id1),
      anthropicToolResult(id1, 'export function handleError(error: unknown) {\n  if (error: Error) {\n    console.log("no error: succeeded");\n  }\n}'),
      assistantMsg('The error handler catches unknown errors and logs success.'),
    ];
    expect(classifyTurn(turn)).toBe('research');
  });
});

describe('skeletonizeTool', () => {
  test('Read tool', () => {
    const skeleton = skeletonizeTool({ name: 'Read', input: { file_path: '/home/user/my-monorepo/relay/src/auth.ts' }, resultText: 'source', toolId: 't1' });
    expect(skeleton).toContain('📖');
    expect(skeleton).toContain('relay/src/auth.ts');
  });

  test('Grep tool', () => {
    const skeleton = skeletonizeTool({ name: 'Grep', input: { pattern: 'authenticate' }, resultText: 'file1\nfile2\nfile3', toolId: 't2' });
    expect(skeleton).toContain('🔍');
    expect(skeleton).toContain('"authenticate"');
    expect(skeleton).toContain('3 hit(s)');
  });

  test('Bash tool', () => {
    const skeleton = skeletonizeTool({ name: 'Bash', input: { command: 'npm run build' }, resultText: 'Build complete', toolId: 't3' });
    expect(skeleton).toContain('$');
    expect(skeleton).toContain('npm run build');
    expect(skeleton).toContain('ok');
  });

  test('Bash tool with error', () => {
    const skeleton = skeletonizeTool({ name: 'Bash', input: { command: 'npm run build' }, resultText: 'Error: compilation failed', toolId: 't4' });
    expect(skeleton).toContain('err');
  });

  test('Edit tool preserves diff summary', () => {
    const skeleton = skeletonizeTool({
      name: 'Edit',
      input: { file_path: '/home/user/my-monorepo/relay/src/auth.ts', old_string: 'return false;', new_string: 'return true;' },
      resultText: 'edited',
      toolId: 't5',
    });
    expect(skeleton).toContain('✏️');
    expect(skeleton).toContain('relay/src/auth.ts');
    expect(skeleton).toContain('return false;');
    expect(skeleton).toContain('return true;');
  });

  test('atlas_query tool', () => {
    const skeleton = skeletonizeTool({
      name: 'mcp__voxxo-swarm-bridge__atlas_query',
      input: { action: 'search', query: 'context thinning' },
      resultText: 'results',
      toolId: 't6',
    });
    expect(skeleton).toContain('🗺️');
    expect(skeleton).toContain('atlas search');
  });

  test('chatroom tool', () => {
    const skeleton = skeletonizeTool({
      name: 'mcp__voxxo-swarm-bridge__chatroom',
      input: { action: 'send', room: 'dev-auth' },
      resultText: 'sent',
      toolId: 't7',
    });
    expect(skeleton).toContain('💬');
    expect(skeleton).toContain('chatroom');
  });

  test('Write tool', () => {
    const skeleton = skeletonizeTool({
      name: 'Write',
      input: { file_path: '/home/user/my-monorepo/relay/src/newFile.ts', content: 'x'.repeat(500) },
      resultText: 'written',
      toolId: 't8',
    });
    expect(skeleton).toContain('📝');
    expect(skeleton).toContain('500 chars');
  });
});

describe('extractAssistantEssence', () => {
  test('keeps first line', () => {
    const text = 'The auth module has a critical bug.\nLet me investigate further.\nLooking at the code now.';
    const result = extractAssistantEssence(text);
    expect(result).toContain('critical bug');
  });

  test('keeps decision markers', () => {
    const text = 'Some intro text.\nThe fix is to update the return value.\nMore verbose explanation here that goes on and on about various things.';
    const result = extractAssistantEssence(text);
    expect(result).toContain('The fix is');
  });

  test('keeps code blocks', () => {
    const text = 'Here is the code:\n```typescript\nconst x = 1;\n```\nAs you can see above.';
    const result = extractAssistantEssence(text);
    expect(result).toContain('```typescript');
    expect(result).toContain('const x = 1;');
  });

  test('keeps bullet points', () => {
    const text = 'Summary:\n- First action item\n- Second action item\nSome filler text.';
    const result = extractAssistantEssence(text);
    expect(result).toContain('- First action item');
    expect(result).toContain('- Second action item');
  });

  test('returns short text unchanged', () => {
    const text = 'Short text.';
    expect(extractAssistantEssence(text)).toBe('Short text.');
  });

  test('drops standalone filler lines', () => {
    const text = 'Topic sentence here.\nGot it.\nSure.\nLet me check something.\nThe issue was the return type.';
    const result = extractAssistantEssence(text);
    expect(result).not.toMatch(/^Got it\.$/m);
    expect(result).not.toMatch(/^Sure\.$/m);
    expect(result).toContain('The issue was');
  });
});

describe('collapseSequences', () => {
  test('collapses consecutive research turns', () => {
    const turns: FoldedTurn[] = [
      { timestamp: '', category: 'research', skeleton: '📖 auth.ts', charsSaved: 100 },
      { timestamp: '', category: 'research', skeleton: '🔍 "token"', charsSaved: 200 },
      { timestamp: '', category: 'research', skeleton: '📖 middleware.ts', charsSaved: 150 },
    ];
    const result = collapseSequences(turns);
    expect(result).toHaveLength(1);
    expect(result[0].skeleton).toContain('Investigated');
    expect(result[0].skeleton).toContain('3 turns');
    expect(result[0].charsSaved).toBe(450);
  });

  test('never collapses action turns', () => {
    const turns: FoldedTurn[] = [
      { timestamp: '', category: 'action', skeleton: '✏️ auth.ts', charsSaved: 100 },
      { timestamp: '', category: 'action', skeleton: '✏️ middleware.ts', charsSaved: 200 },
    ];
    const result = collapseSequences(turns);
    expect(result).toHaveLength(2);
  });

  test('never collapses decision turns', () => {
    const turns: FoldedTurn[] = [
      { timestamp: '', category: 'decision', skeleton: 'Use JWT', charsSaved: 100 },
      { timestamp: '', category: 'decision', skeleton: 'Add rate limiting', charsSaved: 200 },
    ];
    const result = collapseSequences(turns);
    expect(result).toHaveLength(2);
  });

  test('preserves ALL retained content in sequence (not just last)', () => {
    const turns: FoldedTurn[] = [
      { timestamp: '', category: 'research', skeleton: '📖 a.ts', retained: 'conclusion from a', charsSaved: 100 },
      { timestamp: '', category: 'research', skeleton: '📖 b.ts', retained: 'conclusion from b', charsSaved: 200 },
    ];
    const result = collapseSequences(turns);
    expect(result[0].retained).toContain('conclusion from a');
    expect(result[0].retained).toContain('conclusion from b');
  });

  test('handles mixed retained/unretained in sequence', () => {
    const turns: FoldedTurn[] = [
      { timestamp: '', category: 'research', skeleton: '📖 a.ts', charsSaved: 100 },
      { timestamp: '', category: 'research', skeleton: '📖 b.ts', retained: 'conclusion from b', charsSaved: 200 },
      { timestamp: '', category: 'research', skeleton: '📖 c.ts', charsSaved: 150 },
    ];
    const result = collapseSequences(turns);
    expect(result[0].retained).toBe('conclusion from b');
  });

  test('handles mixed sequences correctly', () => {
    const turns: FoldedTurn[] = [
      { timestamp: '', category: 'research', skeleton: 'r1', charsSaved: 10 },
      { timestamp: '', category: 'research', skeleton: 'r2', charsSaved: 10 },
      { timestamp: '', category: 'action', skeleton: 'a1', charsSaved: 10 },
      { timestamp: '', category: 'research', skeleton: 'r3', charsSaved: 10 },
      { timestamp: '', category: 'decision', skeleton: 'd1', charsSaved: 10 },
    ];
    const result = collapseSequences(turns);
    // r1+r2 collapsed, a1 alone, r3 alone (only 1), d1 alone
    expect(result).toHaveLength(4);
    expect(result[0].category).toBe('research');
    expect(result[0].skeleton).toContain('2 turns');
    expect(result[1].category).toBe('action');
    expect(result[2].category).toBe('research');
    expect(result[3].category).toBe('decision');
  });
});

describe('checkFoldTrigger', () => {
  test('returns false when below all thresholds', () => {
    const messages = [userMsg('hi'), assistantMsg('hello')];
    const result = checkFoldTrigger(messages);
    expect(result.shouldFold).toBe(false);
  });

  test('returns false when turn count <= activeWindowTurns', () => {
    const messages: FoldMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(userMsg(`turn ${i}`), assistantMsg(`response ${i}`));
    }
    const result = checkFoldTrigger(messages, { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 20 });
    expect(result.shouldFold).toBe(false);
  });

  test('triggers on turn count exceeding max', () => {
    const messages: FoldMessage[] = [];
    for (let i = 0; i < 70; i++) {
      messages.push(userMsg(`turn ${i}`), assistantMsg(`response ${i}`));
    }
    const config: FoldConfig = { ...DEFAULT_FOLD_CONFIG, maxTurnsBeforeFold: 60 };
    const result = checkFoldTrigger(messages, config);
    expect(result.shouldFold).toBe(true);
    expect(result.turnsToFold).toBeGreaterThan(0);
    expect(result.reason).toContain('turn count');
  });

  test('triggers on soft threshold', () => {
    const messages: FoldMessage[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(userMsg(`turn ${i}`), assistantMsg('x'.repeat(30_000)));
    }
    const config: FoldConfig = { ...DEFAULT_FOLD_CONFIG, softThresholdChars: 500_000, activeWindowTurns: 10 };
    const result = checkFoldTrigger(messages, config);
    expect(result.shouldFold).toBe(true);
    expect(result.reason).toContain('soft threshold');
  });
});

describe('foldContext end-to-end', () => {
  function buildConversation(turnCount: number): FoldMessage[] {
    const messages: FoldMessage[] = [];
    for (let i = 0; i < turnCount; i++) {
      if (i % 4 === 0) messages.push(...buildResearchTurn());
      else if (i % 4 === 1) messages.push(...buildActionTurn());
      else if (i % 4 === 2) messages.push(...buildDecisionTurn());
      else messages.push(...buildCoordinationTurn());
    }
    return messages;
  }

  test('no-op when turnsToFold is 0', () => {
    const messages = buildConversation(10);
    const result = foldContext(messages, 0);
    expect(result.messages).toBe(messages);
    expect(result.savingsPercent).toBe(0);
  });

  test('folds old turns and preserves active window', () => {
    const messages = buildConversation(20);
    const originalChars = countChars(messages);
    const result = foldContext(messages, 10);

    expect(result.turnsFolded).toBe(10);
    expect(result.turnsRetained).toBe(10);
    expect(result.foldedChars).toBeLessThan(originalChars);
    expect(result.savingsPercent).toBeGreaterThan(0);

    // Active window messages should be untouched at the end
    const turns = detectTurns(messages);
    const activeStart = turns[10].startIndex;
    const activeOriginal = messages.slice(activeStart);
    const resultActive = result.messages.slice(-activeOriginal.length);
    expect(resultActive).toEqual(activeOriginal);
  });

  test('folded message array starts with fold block', () => {
    const messages = buildConversation(10);
    const result = foldContext(messages, 5);

    // Should have: foldBlock(user) + ack(assistant) + active window
    const foldBlock = result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('[Conversation Context'),
    );
    expect(foldBlock).toBeDefined();
    expect(foldBlock!.role).toBe('user');

    const ackBlock = result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('Acknowledged'),
    );
    expect(ackBlock).toBeDefined();
    expect(ackBlock!.role).toBe('assistant');
  });

  test('fold block renders the self-documenting preamble after the header', () => {
    const messages = buildConversation(10);
    const result = foldContext(messages, 5);
    const foldBlock = result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('[Conversation Context'),
    );
    expect(foldBlock).toBeDefined();
    const content = foldBlock!.content as string;
    expect(content).toContain(FOLD_BLOCK_PREAMBLE);
    const blockLines = content.split('\n');
    // FOLD_MARKER anchor invariant: header stays the block's FIRST line
    expect(blockLines[0].startsWith('[Conversation Context —')).toBe(true);
    // Preamble sits after header + blank, before the skeletons
    expect(blockLines[2]).toBe(FOLD_BLOCK_PREAMBLE);
    expect(FOLD_BLOCK_PREAMBLE.startsWith('[')).toBe(false);
  });

  test('fold summaries contain category info', () => {
    const messages = buildConversation(12);
    const result = foldContext(messages, 8);
    expect(result.foldSummaries.length).toBeGreaterThan(0);
    const categories = result.foldSummaries.map(s => s.category);
    expect(categories.some(c => ['research', 'action', 'decision', 'coordination'].includes(c))).toBe(true);
  });

  test('does not fold beyond available turns', () => {
    const messages = buildConversation(5);
    const result = foldContext(messages, 100);
    // Should fold at most turns.length - 1 (keep at least 1)
    expect(result.turnsFolded).toBeLessThanOrEqual(4);
  });

  test('handles empty message array', () => {
    const result = foldContext([], 5);
    expect(result.messages).toEqual([]);
    expect(result.turnsFolded).toBe(0);
  });

  test('budget-based retention: full retention under budget', () => {
    // Build a conversation with coordination turns (previously lost ALL assistant text)
    const messages: FoldMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(...buildCoordinationTurn());
    }
    const tinyBudget: AssistantTextBudget = {
      fullRetentionChars: 100_000,
      essenceRetentionChars: 200_000,
    };
    const config: FoldConfig = { ...DEFAULT_FOLD_CONFIG, assistantTextBudget: tinyBudget };
    const result = foldContext(messages, 3, config);

    // The folded block should contain assistant text from coordination turns
    // (previously these were COMPLETELY DISCARDED)
    const foldBlock = result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('[Conversation Context'),
    );
    expect(foldBlock).toBeDefined();
    const content = foldBlock!.content as string;
    expect(content).toContain('Posted the update');
  });

  test('budget-based retention: skeleton when over budget', () => {
    const messages: FoldMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(...buildResearchTurn());
    }
    // Tiny budget: 0 chars full, 0 chars essence → everything goes to skeleton
    const zeroBudget: AssistantTextBudget = {
      fullRetentionChars: 0,
      essenceRetentionChars: 0,
    };
    const config: FoldConfig = { ...DEFAULT_FOLD_CONFIG, assistantTextBudget: zeroBudget };
    const result = foldContext(messages, 3, config);

    const foldBlock = result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('[Conversation Context'),
    );
    expect(foldBlock).toBeDefined();
    const content = foldBlock!.content as string;
    // With zero budget, no assistant text should be retained — only skeletons
    expect(content).not.toContain('The auth module exports');
  });

  test('budget-based retention: newest turns get priority', () => {
    // Build enough turns so budget can't cover all of them
    const messages: FoldMessage[] = [];
    // 4 research turns, each with ~80 chars of assistant text
    for (let i = 0; i < 8; i++) {
      messages.push(...buildResearchTurn());
    }
    // Budget only covers ~1 turn of full retention
    const tightBudget: AssistantTextBudget = {
      fullRetentionChars: 100,
      essenceRetentionChars: 200,
    };
    const config: FoldConfig = { ...DEFAULT_FOLD_CONFIG, assistantTextBudget: tightBudget };
    const result = foldContext(messages, 4, config);

    // Fold summaries should exist — the newest folded turns should have retained text
    expect(result.foldSummaries.length).toBeGreaterThan(0);
  });
});

describe('detectTurns', () => {
  test('detects simple turn boundaries', () => {
    const messages = [
      userMsg('turn 1'), assistantMsg('resp 1'),
      userMsg('turn 2'), assistantMsg('resp 2'),
    ];
    const turns = detectTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0].startIndex).toBe(0);
    expect(turns[0].endIndex).toBe(2);
    expect(turns[1].startIndex).toBe(2);
    expect(turns[1].endIndex).toBe(4);
  });

  test('tool result user messages do not create turn boundaries', () => {
    const messages = [
      userMsg('start'),
      anthropicToolUse('Read', { file_path: 'a.ts' }, 'toolu_1'),
      anthropicToolResult('toolu_1', 'content'),
      assistantMsg('done'),
    ];
    const turns = detectTurns(messages);
    expect(turns).toHaveLength(1);
  });

  test('skips fold marker messages as turn boundaries', () => {
    const foldBlock: FoldMessage = {
      role: 'user',
      content: '[Conversation Context — 5 turns folded]\nsome content\n[End Folded Context]',
    };
    const messages = [
      foldBlock,
      assistantMsg('Acknowledged.'),
      userMsg('Continue'),
      assistantMsg('Continuing'),
    ];
    const turns = detectTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].startIndex).toBe(2);
  });
});

describe('planActiveTurnStepFold — marathon step-fold (single oversized turn)', () => {
  // A marathon = one user kickoff + many [assistant tool_use, tool_result] steps:
  // ONE detected turn that inter-turn fold can never compress (the MiniMax-M3 400
  // failure mode). Step-fold segments it so foldContext can skeletonize old steps.
  function buildMarathon(steps: number, resultChars: number): FoldMessage[] {
    const msgs: FoldMessage[] = [userMsg('KICKOFF: sweep every file and atlas-commit each one')];
    for (let i = 0; i < steps; i++) {
      const id = `toolu_step_${i}`;
      msgs.push({
        role: 'assistant',
        content: [
          { type: 'text', text: `Step ${i}: reasoning about file_${i}.ts` },
          { type: 'tool_use', id, name: 'read_file', input: { path: `file_${i}.ts` } },
        ],
      });
      msgs.push(anthropicToolResult(id, 'X'.repeat(resultChars)));
    }
    return msgs;
  }

  test('a marathon burst is a single turn (inter-turn fold cannot touch it)', () => {
    expect(detectTurns(buildMarathon(30, 3000))).toHaveLength(1);
  });

  test('segments the oversized turn at step boundaries and folds the oldest steps', () => {
    const msgs = buildMarathon(40, 5000);
    const plan = planActiveTurnStepFold(msgs, { activeTurnCharBudget: 50_000, keepLastSteps: 8 });
    expect(plan).not.toBeNull();
    // 1 kickoff segment + 40 step segments
    expect(plan!.turns).toHaveLength(41);
    // fold all but the last 8 steps
    expect(plan!.turnsToFold).toBe(33);
    const result = foldContext(msgs, plan!.turnsToFold, DEFAULT_FOLD_CONFIG, undefined, undefined, plan!.turns);
    expect(result.turnsFolded).toBe(33);
    expect(result.foldedChars).toBeLessThan(result.originalChars);
  });

  test('step segments tile the turn contiguously (valid global indices for foldContext)', () => {
    const msgs = buildMarathon(15, 3000);
    const plan = planActiveTurnStepFold(msgs, { activeTurnCharBudget: 20_000, keepLastSteps: 4 });
    const turns = plan!.turns;
    expect(turns[0].startIndex).toBe(0);
    for (let i = 1; i < turns.length; i++) {
      expect(turns[i].startIndex).toBe(turns[i - 1].endIndex);
    }
    expect(turns[turns.length - 1].endIndex).toBe(msgs.length);
  });

  test('preserves tool_use/tool_result pair integrity across the fold seam', () => {
    const msgs = buildMarathon(20, 4000);
    const plan = planActiveTurnStepFold(msgs, { activeTurnCharBudget: 20_000, keepLastSteps: 5 });
    const result = foldContext(msgs, plan!.turnsToFold, DEFAULT_FOLD_CONFIG, undefined, undefined, plan!.turns);
    const useIds = new Set<string>();
    const resultIds: string[] = [];
    for (const m of result.messages) {
      if (Array.isArray(m.content)) {
        for (const b of m.content as any[]) {
          if (b?.type === 'tool_use') useIds.add(b.id);
          if (b?.type === 'tool_result') resultIds.push(b.tool_use_id);
        }
      }
    }
    // every surviving tool_result keeps its matching tool_use — no orphaned pair
    expect(resultIds.length).toBeGreaterThan(0);
    for (const rid of resultIds) expect(useIds.has(rid)).toBe(true);
  });

  test('returns null below the active-turn char budget (no churn on normal turns)', () => {
    expect(planActiveTurnStepFold(buildMarathon(3, 400), { activeTurnCharBudget: 100_000, keepLastSteps: 8 })).toBeNull();
  });

  test('returns null when too few steps to fold beyond the kept tail', () => {
    // 10 steps → 11 segments ≤ keepLastSteps(12)+1 → not worth a cache rewrite
    expect(planActiveTurnStepFold(buildMarathon(10, 8000), { activeTurnCharBudget: 20_000, keepLastSteps: 12 })).toBeNull();
  });

  test('segments an OpenAI/tool_calls marathon (MiniMax message format)', () => {
    const msgs: FoldMessage[] = [userMsg('KICKOFF')];
    for (let i = 0; i < 20; i++) {
      const id = `call_${i}`;
      msgs.push(openaiToolCall('read_file', { path: `f${i}.ts` }, id));
      msgs.push(openaiToolResult(id, 'Y'.repeat(4000)));
    }
    const plan = planActiveTurnStepFold(msgs, { activeTurnCharBudget: 20_000, keepLastSteps: 5 });
    expect(plan).not.toBeNull();
    expect(plan!.turns).toHaveLength(21); // 1 kickoff + 20 step segments
    expect(plan!.turnsToFold).toBe(16);
  });

  test('segments a Gemini/parts marathon (Gemini API format)', () => {
    const msgs: FoldMessage[] = [userMsg('KICKOFF')];
    for (let i = 0; i < 20; i++) {
      const id = `call_${i}`;
      msgs.push({
        role: 'model',
        parts: [
          { text: `thinking ${i}` },
          { functionCall: { name: 'read_file', args: { path: `f${i}.ts` }, id } },
        ],
      } as any);
      msgs.push({
        role: 'user',
        parts: [
          { functionResponse: { name: 'read_file', response: { result: 'Y'.repeat(4000) }, id } },
        ],
      } as any);
    }
    const plan = planActiveTurnStepFold(msgs, { activeTurnCharBudget: 20_000, keepLastSteps: 5 });
    expect(plan).not.toBeNull();
    expect(plan!.turns).toHaveLength(21); // 1 kickoff + 20 step segments
    expect(plan!.turnsToFold).toBe(16);
  });

  test('folds Gemini/parts marathon steps into tool skeletons and keeps active signatures', () => {
    const msgs: FoldMessage[] = [userMsg('KICKOFF')];
    for (let i = 0; i < 20; i++) {
      const id = `call_${i}`;
      msgs.push({
        role: 'model',
        parts: [
          { text: `thinking ${i}` },
          { functionCall: { name: 'read_file', args: { path: `f${i}.ts` }, id }, thoughtSignature: `SIG_${i}` },
        ],
      } as any);
      msgs.push({
        role: 'user',
        parts: [
          { functionResponse: { name: 'read_file', response: { result: `result ${i} ${'Y'.repeat(4000)}` }, id } },
        ],
      } as any);
    }

    const plan = planActiveTurnStepFold(msgs, { activeTurnCharBudget: 20_000, keepLastSteps: 5 });
    const result = foldContext(msgs, plan!.turnsToFold, DEFAULT_FOLD_CONFIG, undefined, undefined, plan!.turns);
    const block = result.messages[0].content as string;

    expect(block).toContain('read_file');
    expect(block).toContain('result 0');
    expect(result.messages[1].role).toBe('model'); // ack is dropped before a model-led active window
    expect((result.messages[1] as any).parts[1].thoughtSignature).toBe('SIG_15');
  });

  test('extracts Gemini assistant text and tool paths from parts', () => {
    const msgs = [
      userMsg('KICKOFF'),
      {
        role: 'model',
        parts: [
          { text: 'Gemini reasoning about relay/src/rollingFold.ts' },
          { functionCall: { name: 'read_file', args: { path: 'relay/src/rollingFold.ts' }, id: 'call_1' } },
        ],
      },
    ] as FoldMessage[];

    expect(extractAssistantText(msgs)).toContain('Gemini reasoning');
    expect(extractToolPathSet(msgs)).toEqual(new Set(['relay/src/rollingFold.ts']));
  });

  test('produces valid user/assistant alternation at the fold seam (ack dropped, no consecutive assistants)', () => {
    const msgs = buildMarathon(20, 4000);
    const plan = planActiveTurnStepFold(msgs, { activeTurnCharBudget: 20_000, keepLastSteps: 5 });
    const result = foldContext(msgs, plan!.turnsToFold, DEFAULT_FOLD_CONFIG, undefined, undefined, plan!.turns);
    // buildMarathon has no system preamble → the synthetic fold block is at index 0,
    // immediately followed by the (assistant-led) active window with the ack dropped.
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    // Seam invariant: never two consecutive assistant messages (API alternation).
    for (let i = 1; i < result.messages.length; i++) {
      expect(result.messages[i - 1].role === 'assistant' && result.messages[i].role === 'assistant').toBe(false);
    }
  });

  test('foldContext without precomputedTurns is byte-identical (seam is non-invasive)', () => {
    const msgs = [
      userMsg('q1'), assistantMsg('a1'),
      userMsg('q2'), assistantMsg('a2'),
      userMsg('q3'), assistantMsg('a3'),
    ];
    const withUndef = foldContext(msgs, 1, DEFAULT_FOLD_CONFIG, undefined, undefined, undefined);
    const without = foldContext(msgs, 1, DEFAULT_FOLD_CONFIG);
    expect(JSON.stringify(withUndef.messages)).toBe(JSON.stringify(without.messages));
  });

  test('intra-turn fold truncates Gemini functionResponse parts and preserves call metadata', () => {
    const msgs = [
      userMsg('KICKOFF'),
      {
        role: 'model',
        parts: [{ functionCall: { name: 'read_file', args: { path: 'relay/src/a.ts' }, id: 'call_1' }, thoughtSignature: 'SIG_1' }],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'read_file', response: { result: 'Y'.repeat(5000) }, id: 'call_1' } }],
      },
    ] as FoldMessage[];

    const result = intraTurnFold(msgs, {
      tailBuffer: 0,
      minTruncateSize: 100,
      charThreshold: 0,
      atlasLookupThreshold: 100,
    });

    expect(result.toolResultsFolded).toBe(1);
    const foldedResponse = (result.messages[2] as any).parts[0].functionResponse;
    expect(foldedResponse.id).toBe('call_1');
    expect(foldedResponse.name).toBe('read_file');
    expect(foldedResponse.response.result).toContain('[Folded: read_file relay/src/a.ts');
  });

  test('intra-turn fold keeps Gemini functionResponse parts for claimed paths', () => {
    const msgs = [
      userMsg('KICKOFF'),
      {
        role: 'model',
        parts: [{ functionCall: { name: 'read_file', args: { path: 'relay/src/a.ts' }, id: 'call_1' } }],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'read_file', response: { result: 'Y'.repeat(5000) }, id: 'call_1' } }],
      },
    ] as FoldMessage[];

    const result = intraTurnFold(msgs, {
      tailBuffer: 0,
      minTruncateSize: 100,
      charThreshold: 0,
      atlasLookupThreshold: 100,
      claimedPaths: new Set(['relay/src/a.ts']),
    });

    expect(result.toolResultsFolded).toBe(0);
    expect(result.toolResultsKept).toBe(1);
    expect((result.messages[2] as any).parts[0].functionResponse.response.result).toBe('Y'.repeat(5000));
  });
});

describe('countChars', () => {
  test('counts string content', () => {
    expect(countChars([{ role: 'user', content: 'hello' }])).toBe(5);
  });

  test('counts array content blocks', () => {
    const msg: FoldMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    };
    const chars = countChars([msg]);
    expect(chars).toBeGreaterThan(0);
  });

  test('counts reasoning_content', () => {
    const msg: FoldMessage = { role: 'assistant', content: 'hi', reasoning_content: 'thinking...' };
    expect(countChars([msg])).toBe(2 + 11);
  });
});

describe('OpenAI format support', () => {
  test('classifies OpenAI-format tool calls', () => {
    const callId = 'call_abc123';
    const turn = [
      userMsg('search for auth'),
      openaiToolCall('Grep', { pattern: 'auth' }, callId),
      openaiToolResult(callId, 'auth.ts\nmiddleware.ts'),
      assistantMsg('Found auth references.'),
    ];
    expect(classifyTurn(turn)).toBe('research');
  });

  test('skeletonizes OpenAI-format tool calls via foldContext', () => {
    const callId = 'call_abc123';
    const messages = [
      userMsg('first turn'),
      openaiToolCall('Read', { file_path: '/home/user/my-monorepo/relay/src/auth.ts' }, callId),
      openaiToolResult(callId, 'x'.repeat(5000)),
      assistantMsg('Read the file.'),
      userMsg('second turn'),
      assistantMsg('Continuing.'),
    ];
    const result = foldContext(messages, 1);
    expect(result.turnsFolded).toBe(1);
    const foldBlock = result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('[Conversation Context'),
    );
    expect(foldBlock).toBeDefined();
    expect(typeof foldBlock!.content === 'string' && foldBlock!.content).toContain('📖');
  });
});

// ══════════════════════════════════════════════════════════════════════
// Intra-turn folding
// ══════════════════════════════════════════════════════════════════════

describe('intraTurnFold', () => {
  const LOW_THRESHOLD: IntraTurnFoldConfig = {
    tailBuffer: 3,
    minTruncateSize: 100,
    charThreshold: 100,  // trigger on tiny conversations for testing
    atlasLookupThreshold: 8_000,
  };

  function buildHeavyTurn(toolCount: number, resultSize = 2000): FoldMessage[] {
    const msgs: FoldMessage[] = [userMsg('Do the analysis')];
    for (let i = 0; i < toolCount; i++) {
      const id = `toolu_heavy_${i}`;
      msgs.push(
        anthropicToolUse('Read', { file_path: `/home/user/my-monorepo/relay/src/file${i}.ts` }, id),
        anthropicToolResult(id, `// source code for file${i}\n` + 'x'.repeat(resultSize)),
      );
    }
    msgs.push(assistantMsg('Analysis complete. Found 3 issues across the codebase.'));
    return msgs;
  }

  test('no-op when below char threshold', () => {
    const messages = buildResearchTurn();
    const result = intraTurnFold(messages, { ...LOW_THRESHOLD, charThreshold: 999_999 });
    expect(result.messages).toBe(messages);
    expect(result.toolResultsFolded).toBe(0);
    expect(result.savingsPercent).toBe(0);
  });

  test('folds old tool results and keeps tail buffer', () => {
    const messages = [userMsg('start'), ...buildHeavyTurn(10).slice(1)];
    // Merge the user messages: buildHeavyTurn starts with userMsg too
    const turn = buildHeavyTurn(10);
    const result = intraTurnFold(turn, LOW_THRESHOLD);

    // 10 tool results total, tail buffer 3, minTruncateSize 100
    // All results are 2000+ chars, so 7 should be folded
    expect(result.toolResultsFolded).toBe(7);
    expect(result.toolResultsKept).toBe(3);
    expect(result.savingsPercent).toBeGreaterThan(0);
    expect(result.foldedChars).toBeLessThan(result.originalChars);
  });

  test('folded results contain recovery hint', () => {
    const turn = buildHeavyTurn(8);
    const result = intraTurnFold(turn, LOW_THRESHOLD);

    const foldedMsg = result.messages.find(m =>
      m.role === 'user' && Array.isArray(m.content)
      && (m.content as any[]).some((b: any) =>
        b?.type === 'tool_result' && typeof b.content === 'string' && b.content.includes('[Folded:'),
      ),
    );
    expect(foldedMsg).toBeDefined();

    const foldedBlock = (foldedMsg!.content as any[]).find(
      (b: any) => b?.type === 'tool_result' && typeof b.content === 'string' && b.content.includes('[Folded:'),
    );
    expect(foldedBlock.content).toContain('self-tap to recover');
    expect(foldedBlock.content).toContain('Read');
    expect(foldedBlock.content).toMatch(/file\d\.ts/);
  });

  test('preserves tool_use_id chain', () => {
    const turn = buildHeavyTurn(6);
    const result = intraTurnFold(turn, LOW_THRESHOLD);

    // Every tool_result block should still have its tool_use_id
    for (const msg of result.messages) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content as any[]) {
          if (block?.type === 'tool_result') {
            expect(block.tool_use_id).toBeDefined();
            expect(block.tool_use_id).toMatch(/^toolu_heavy_/);
          }
        }
      }
    }
  });

  test('never truncates small results', () => {
    const msgs: FoldMessage[] = [userMsg('check')];
    for (let i = 0; i < 10; i++) {
      const id = `toolu_small_${i}`;
      msgs.push(
        anthropicToolUse('Grep', { pattern: 'x' }, id),
        anthropicToolResult(id, 'one hit'),  // < minTruncateSize
      );
    }
    msgs.push(assistantMsg('done'));

    const result = intraTurnFold(msgs, LOW_THRESHOLD);
    // All results are < 100 chars (minTruncateSize), none should be folded
    expect(result.toolResultsFolded).toBe(0);
    expect(result.toolResultsKept).toBe(10);
  });

  test('never truncates error results', () => {
    const msgs: FoldMessage[] = [userMsg('run builds')];
    for (let i = 0; i < 8; i++) {
      const id = `toolu_err_${i}`;
      msgs.push(
        anthropicToolUse('Bash', { command: 'npm run build' }, id),
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: id,
            content: 'Error: build failed\n' + 'x'.repeat(2000),
            is_error: true,
          }],
        },
      );
    }
    msgs.push(assistantMsg('All builds failed'));

    const result = intraTurnFold(msgs, LOW_THRESHOLD);
    expect(result.toolResultsFolded).toBe(0);
    expect(result.toolResultsKept).toBe(8);
  });

  test('handles OpenAI format tool results', () => {
    const msgs: FoldMessage[] = [userMsg('analyze')];
    for (let i = 0; i < 8; i++) {
      const id = `call_oai_${i}`;
      msgs.push(
        openaiToolCall('Read', { file_path: `/home/user/my-monorepo/src/f${i}.ts` }, id),
        openaiToolResult(id, 'content '.repeat(300)),
      );
    }
    msgs.push(assistantMsg('Done analyzing'));

    const result = intraTurnFold(msgs, LOW_THRESHOLD);
    expect(result.toolResultsFolded).toBe(5);
    expect(result.toolResultsKept).toBe(3);

    const foldedToolMsg = result.messages.find(m =>
      m.role === 'tool' && typeof m.content === 'string' && m.content.includes('[Folded:'),
    );
    expect(foldedToolMsg).toBeDefined();
  });

  test('handles multiple turns independently', () => {
    const turn1 = buildHeavyTurn(6);
    const turn2Msgs: FoldMessage[] = [userMsg('second task')];
    for (let i = 0; i < 6; i++) {
      const id = `toolu_t2_${i}`;
      turn2Msgs.push(
        anthropicToolUse('Grep', { pattern: `pattern${i}` }, id),
        anthropicToolResult(id, 'results '.repeat(200)),
      );
    }
    turn2Msgs.push(assistantMsg('Both turns done'));

    const messages = [...turn1, ...turn2Msgs];
    const result = intraTurnFold(messages, LOW_THRESHOLD);

    // Each turn has 6 results, tail buffer 3 → 3 folded per turn = 6 total
    expect(result.toolResultsFolded).toBe(6);
    expect(result.toolResultsKept).toBe(6);
  });

  test('preserves assistant text blocks untouched', () => {
    const turn = buildHeavyTurn(6);
    const result = intraTurnFold(turn, LOW_THRESHOLD);

    const assistantMsgs = result.messages.filter(m => m.role === 'assistant');
    const originalAssistant = turn.filter(m => m.role === 'assistant');

    // Same number of assistant messages, same content
    expect(assistantMsgs.length).toBe(originalAssistant.length);
    for (let i = 0; i < assistantMsgs.length; i++) {
      expect(assistantMsgs[i].content).toEqual(originalAssistant[i].content);
    }
  });

  test('preserves user question at start of turn', () => {
    const turn = buildHeavyTurn(6);
    const result = intraTurnFold(turn, LOW_THRESHOLD);

    // First message should still be the user question
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toBe('Do the analysis');
  });

  test('never mutates input messages', () => {
    const turn = buildHeavyTurn(6);
    const originalJson = JSON.stringify(turn);
    intraTurnFold(turn, LOW_THRESHOLD);
    expect(JSON.stringify(turn)).toBe(originalJson);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Feature #2: Atlas lookup threshold
// ══════════════════════════════════════════════════════════════════════

describe('intraTurnFold — atlas lookup threshold (#2)', () => {
  const config: IntraTurnFoldConfig = {
    tailBuffer: 1,
    minTruncateSize: 100,
    charThreshold: 100,
    atlasLookupThreshold: 5_000,
  };

  function buildAtlasLookupTurn(lookupSize: number, extraTools = 0): FoldMessage[] {
    const msgs: FoldMessage[] = [userMsg('Investigate the codebase')];
    const atlasId = 'toolu_atlas1';
    const atlasContent = [
      '# relay/src/foo.ts',
      '## Purpose',
      'Does important things.',
      '## Patterns',
      'factory, singleton',
      '## Hazards',
      '- Must not be called after shutdown',
      '## Source',
      '```',
      'x'.repeat(lookupSize),
      '```',
    ].join('\n');
    msgs.push(
      anthropicToolUse('mcp__voxxo-swarm-bridge__atlas_query', { action: 'lookup', file_path: 'relay/src/foo.ts' }, atlasId),
      anthropicToolResult(atlasId, atlasContent),
    );
    // Add extra tools to exceed tail buffer
    for (let i = 0; i < extraTools; i++) {
      const id = `toolu_extra_${i}`;
      msgs.push(
        anthropicToolUse('Read', { file_path: `/home/user/my-monorepo/relay/src/file${i}.ts` }, id),
        anthropicToolResult(id, 'x'.repeat(2000)),
      );
    }
    msgs.push(assistantMsg('Investigation complete.'));
    return msgs;
  }

  test('keeps small atlas lookup results under threshold', () => {
    // 1000 chars < atlasLookupThreshold of 5000
    const turn = buildAtlasLookupTurn(500, 3);
    const result = intraTurnFold(turn, config);
    // The atlas result should be kept (not folded) even though it's outside the tail buffer
    const atlasResult = result.messages.find(m => {
      if (m.role !== 'user' || !Array.isArray(m.content)) return false;
      const blocks = m.content as any[];
      return blocks.some(b => b?.content?.includes('Does important things'));
    });
    expect(atlasResult).toBeDefined();
  });

  test('folds large atlas lookup results above threshold', () => {
    // 6000 chars > atlasLookupThreshold of 5000
    const turn = buildAtlasLookupTurn(5800, 3);
    const result = intraTurnFold(turn, config);
    // The atlas result should be folded
    const foldedContent = JSON.stringify(result.messages);
    expect(foldedContent).toContain('[Folded:');
  });

  test('other tool types are unaffected by atlas threshold', () => {
    // Regular Read tool with 1000 chars — should fold normally (above minTruncateSize of 100)
    const msgs: FoldMessage[] = [userMsg('Read stuff')];
    const id = 'toolu_read1';
    msgs.push(
      anthropicToolUse('Read', { file_path: '/home/user/my-monorepo/relay/src/foo.ts' }, id),
      anthropicToolResult(id, 'x'.repeat(1000)),
    );
    // Add a tail buffer entry so the Read is foldable
    const tailId = 'toolu_tail';
    msgs.push(
      anthropicToolUse('Read', { file_path: '/home/user/my-monorepo/relay/src/bar.ts' }, tailId),
      anthropicToolResult(tailId, 'tail content'),
    );
    msgs.push(assistantMsg('Done.'));
    const result = intraTurnFold(msgs, config);
    // The first Read should be folded (not protected by atlas threshold — it's a Read, not atlas)
    const foldedContent = JSON.stringify(result.messages);
    expect(foldedContent).toContain('[Folded:');
  });
});

// ══════════════════════════════════════════════════════════════════════
// Feature #5: Preserve atlas metadata when folding
// ══════════════════════════════════════════════════════════════════════

describe('intraTurnFold — preserve atlas metadata (#5)', () => {
  const config: IntraTurnFoldConfig = {
    tailBuffer: 1,
    minTruncateSize: 100,
    charThreshold: 100,
    atlasLookupThreshold: 100, // low so we trigger folding
  };

  test('preserves metadata section and folds source section', () => {
    const atlasId = 'toolu_atlas1';
    const metadata = [
      '# relay/src/foo.ts',
      '## Purpose',
      'Core authentication module handling JWT validation.',
      '## Patterns',
      'factory, singleton, middleware-chain',
      '## Hazards',
      '- Must not be called after shutdown',
      '- Token refresh race condition possible',
      '## Public API',
      '- authenticate(token: string): Promise<User>',
      '- validateRefresh(refreshToken: string): Promise<boolean>',
    ].join('\n');
    const sourceCode = [
      '',
      '## Source (234 lines)',
      '```',
      'export function authenticate(token: string) {',
      '  // lots of code here',
      '  return verify(token);',
      '}',
      '```',
    ].join('\n');
    const fullContent = metadata + sourceCode;

    const msgs: FoldMessage[] = [
      userMsg('Look at auth'),
      anthropicToolUse('mcp__voxxo-swarm-bridge__atlas_query', { action: 'lookup', file_path: 'relay/src/foo.ts' }, atlasId),
      anthropicToolResult(atlasId, fullContent),
      // tail buffer
      anthropicToolUse('Grep', { pattern: 'auth' }, 'toolu_tail'),
      anthropicToolResult('toolu_tail', 'tail'),
      assistantMsg('Done.'),
    ];

    const result = intraTurnFold(msgs, config);

    // Find the folded atlas result
    const foldedMsg = result.messages.find(m => {
      if (m.role !== 'user' || !Array.isArray(m.content)) return false;
      const blocks = m.content as any[];
      return blocks.some(b => b?.content?.includes('Core authentication module'));
    });

    expect(foldedMsg).toBeDefined();
    const foldedContent = JSON.stringify(foldedMsg);

    // Metadata sections preserved
    expect(foldedContent).toContain('## Purpose');
    expect(foldedContent).toContain('Core authentication module');
    expect(foldedContent).toContain('## Patterns');
    expect(foldedContent).toContain('## Hazards');
    expect(foldedContent).toContain('## Public API');

    // Source code should be folded (replaced with marker)
    expect(foldedContent).toContain('[Folded:');
    expect(foldedContent).toContain('self-tap to recover');
  });

  test('non-atlas results still fold normally (full replacement)', () => {
    const id = 'toolu_read1';
    const content = '## Purpose\nSomething\n## Source\n```\n' + 'x'.repeat(300) + '\n```';
    const msgs: FoldMessage[] = [
      userMsg('Read stuff'),
      anthropicToolUse('Read', { file_path: '/home/user/my-monorepo/relay/src/foo.ts' }, id),
      anthropicToolResult(id, content),
      // tail buffer
      anthropicToolUse('Read', { file_path: '/home/user/my-monorepo/relay/src/bar.ts' }, 'toolu_tail'),
      anthropicToolResult('toolu_tail', 'tail'),
      assistantMsg('Done.'),
    ];
    const result = intraTurnFold(msgs, config);
    const foldedContent = JSON.stringify(result.messages);
    // Regular Read should fold entirely — no metadata preservation
    expect(foldedContent).toContain('[Folded: Read');
    expect(foldedContent).not.toContain('[Folded: atlas_query');
  });
});

// ══════════════════════════════════════════════════════════════════════
// Feature #1: Auto-unfold on file claim
// ══════════════════════════════════════════════════════════════════════

describe('intraTurnFold — auto-unfold on claim (#1)', () => {
  const config: IntraTurnFoldConfig = {
    tailBuffer: 1,
    minTruncateSize: 100,
    charThreshold: 100,
    atlasLookupThreshold: 100,
  };

  test('keeps results for claimed files even outside tail buffer', () => {
    const claimedPath = 'relay/src/foo.ts';
    const claimedPaths = new Set([claimedPath]);

    const id = 'toolu_read1';
    const msgs: FoldMessage[] = [
      userMsg('Edit the file'),
      anthropicToolUse('Read', { file_path: `/home/user/my-monorepo/${claimedPath}` }, id),
      anthropicToolResult(id, 'x'.repeat(2000)),
      // tail buffer — different file
      anthropicToolUse('Read', { file_path: '/home/user/my-monorepo/relay/src/bar.ts' }, 'toolu_tail'),
      anthropicToolResult('toolu_tail', 'tail'),
      assistantMsg('Done.'),
    ];

    const result = intraTurnFold(msgs, { ...config, claimedPaths });

    // The claimed file's result should NOT be folded
    const unfoldedMsg = result.messages.find(m => {
      if (m.role !== 'user' || !Array.isArray(m.content)) return false;
      const blocks = m.content as any[];
      return blocks.some(b => b?.tool_use_id === id && typeof b?.content === 'string' && b.content.includes('x'.repeat(100)));
    });
    expect(unfoldedMsg).toBeDefined();
    expect(result.toolResultsFolded).toBe(0);
  });

  test('folds unclaimed files normally', () => {
    const claimedPaths = new Set(['relay/src/other.ts']);

    const id = 'toolu_read1';
    const msgs: FoldMessage[] = [
      userMsg('Edit the file'),
      anthropicToolUse('Read', { file_path: '/home/user/my-monorepo/relay/src/foo.ts' }, id),
      anthropicToolResult(id, 'x'.repeat(2000)),
      // tail buffer
      anthropicToolUse('Read', { file_path: '/home/user/my-monorepo/relay/src/bar.ts' }, 'toolu_tail'),
      anthropicToolResult('toolu_tail', 'tail'),
      assistantMsg('Done.'),
    ];

    const result = intraTurnFold(msgs, { ...config, claimedPaths });

    // foo.ts is not claimed, should be folded
    expect(result.toolResultsFolded).toBeGreaterThan(0);
    const foldedContent = JSON.stringify(result.messages);
    expect(foldedContent).toContain('[Folded:');
  });

  test('empty claimedPaths set has no effect', () => {
    const claimedPaths = new Set<string>();
    const id = 'toolu_read1';
    const msgs: FoldMessage[] = [
      userMsg('Edit'),
      anthropicToolUse('Read', { file_path: '/home/user/my-monorepo/relay/src/foo.ts' }, id),
      anthropicToolResult(id, 'x'.repeat(2000)),
      // tail buffer
      anthropicToolUse('Read', { file_path: '/home/user/my-monorepo/relay/src/bar.ts' }, 'toolu_tail'),
      anthropicToolResult('toolu_tail', 'tail'),
      assistantMsg('Done.'),
    ];

    const result = intraTurnFold(msgs, { ...config, claimedPaths });
    // Should fold normally — no protection from empty claim set
    expect(result.toolResultsFolded).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// P1 Coordinate Closet helpers — nominateVerbatim / normalizeNumericForm / isConservedIn (s5)
// ══════════════════════════════════════════════════════════════════════

describe('nominateVerbatim — pattern coverage (P1/s5)', () => {
  test('matches UUID', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(nominateVerbatim(`session ${uuid} created`)).toContain(uuid);
  });

  test('matches 40-char git SHA via hex rule (≥12 chars)', () => {
    const sha = 'a'.repeat(40);
    const lits = nominateVerbatim(`commit ${sha} msg`);
    expect(lits).toContain(sha);
  });

  test('matches absolute path', () => {
    const lits = nominateVerbatim('reading /home/jonah/my-monorepo/relay/src/foo.ts done');
    expect(lits.some(l => l.includes('/relay/src/foo.ts'))).toBe(true);
  });

  test('matches port=3002 key=value pair', () => {
    const lits = nominateVerbatim('server started port=3002 ok');
    expect(lits.some(l => l.includes('port=3002'))).toBe(true);
  });

  test('matches ref: abc1234 kv style', () => {
    const lits = nominateVerbatim('ref: abc1234 resolved');
    expect(lits.some(l => l.includes('ref:') || l === 'abc1234')).toBe(true);
  });

  test('matches issue ref #1234', () => {
    const lits = nominateVerbatim('fixes #1234 in relay');
    expect(lits.some(l => l === '#1234')).toBe(true);
  });

  test('cap=40 enforced — never returns more than cap entries', () => {
    // 50 unique UUIDs
    const uuids = Array.from({ length: 50 }, (_, i) =>
      `${i.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`,
    );
    const lits = nominateVerbatim(uuids.join(' '));
    expect(lits.length).toBeLessThanOrEqual(40);
  });

  test('verbatim value longer than 200 chars is truncated to 200 (deep absolute path)', () => {
    // Only the unbounded abs-path pattern can exceed 200 chars (KV values cap at
    // 80, hex at 64) — a vacuous KV fixture here would never exercise truncation.
    const deepPath = '/' + 'dir/'.repeat(60) + 'leaf.ts'; // 248 chars
    const lits = nominateVerbatim(`reading ${deepPath} done`);
    expect(lits.some(l => l.length === 200)).toBe(true);
    for (const l of lits) {
      expect(l.length).toBeLessThanOrEqual(200);
    }
  });

  test('short mixed hex (8-11, letters+digits) nominated — rail ids, short git SHAs', () => {
    const lits = nominateVerbatim('see rail-1f6be5b4 at commit b602c1e8');
    expect(lits).toContain('1f6be5b4');
    expect(lits).toContain('b602c1e8');
  });

  test('digit-only dates and letter-only hexy words are NOT nominated at 8-11 length', () => {
    const lits = nominateVerbatim('on 20260610 we saw deadbeef again');
    expect(lits).not.toContain('20260610');
    expect(lits).not.toContain('deadbeef');
  });

  test('KV with alpha-only value is NOT nominated (prose guard)', () => {
    const lits = nominateVerbatim('note: the result: this mode=continuous');
    expect(lits).toHaveLength(0);
  });

  test('deduplicates exact matches across pattern passes', () => {
    // A UUID also matches the hex pattern — should appear only once
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const lits = nominateVerbatim(`${uuid} ${uuid}`);
    expect(lits.filter(l => l === uuid)).toHaveLength(1);
  });
});

describe('normalizeNumericForm (P1/s5)', () => {
  test('1.0000 → 1', () => expect(normalizeNumericForm('1.0000')).toBe('1'));
  test('1.0 → 1', () => expect(normalizeNumericForm('1.0')).toBe('1'));
  test('42 → 42 (no-op for integer)', () => expect(normalizeNumericForm('42')).toBe('42'));
  test('non-numeric string passes through unchanged', () => expect(normalizeNumericForm('deadbeef')).toBe('deadbeef'));
});

describe('isConservedIn — boundary-aware (P1/s5)', () => {
  test('6787 is NOT conserved by 67870 (boundary required)', () => {
    expect(isConservedIn('value is 67870 here', '6787')).toBe(false);
  });

  test('6787 IS conserved when it appears with non-alnum boundary', () => {
    expect(isConservedIn('value is 6787 here', '6787')).toBe(true);
  });

  test('1.0000 ≡ 1.0 via numeric normalization', () => {
    expect(isConservedIn('value is 1.0', '1.0000')).toBe(true);
  });

  test('returns false for unknown literal', () => {
    expect(isConservedIn('plain text no ids', 'deadbeefdeadbeef')).toBe(false);
  });

  test('literal at start of string is conserved', () => {
    expect(isConservedIn('deadbeefcafe1234 is the hash', 'deadbeefcafe1234')).toBe(true);
  });

  test('KV pair is conserved when its bare value is already carried (double-carry guard)', () => {
    expect(isConservedIn('ok [a1b2c3d4e5f6]', 'id: a1b2c3d4e5f6')).toBe(true);
    expect(isConservedIn('ok [a1b2c3d4e5f6]', 'job_id=a1b2c3d4e5f6')).toBe(true);
  });

  test('KV pair is NOT conserved when its value is absent', () => {
    expect(isConservedIn('plain text, nothing carried', 'id: a1b2c3d4e5f6')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// P1 Closet items — foldContext e2e (s7)
// ══════════════════════════════════════════════════════════════════════

describe('foldContext — Coordinate Closet e2e (P1/s7)', () => {
  /** Build a minimal set of messages with n full turns then an active window. */
  function buildTurnsWithResult(resultTexts: string[], activeWindowTurns = 1): FoldMessage[] {
    const msgs: FoldMessage[] = [];
    for (let i = 0; i < resultTexts.length; i++) {
      const id = `toolu_${i}`;
      msgs.push(userMsg(`question ${i}`));
      msgs.push(anthropicToolUse('Bash', { command: `cmd${i}` }, id));
      msgs.push(anthropicToolResult(id, resultTexts[i]));
      msgs.push(assistantMsg(`answer ${i}`));
    }
    // Active window (not folded)
    msgs.push(userMsg('active question'));
    msgs.push(assistantMsg('active answer'));
    return msgs;
  }

  test('UUID from a non-belted tool result lands bare in the Coordinate Closet', () => {
    // Read has no receipts belt — the uuid appears nowhere in the skeleton, so
    // the closet is its only carry path.
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const msgs: FoldMessage[] = [
      userMsg('first'),
      anthropicToolUse('Read', { file_path: 'relay/src/a.ts' }, 'toolu_u1'),
      anthropicToolResult('toolu_u1', `content with ${uuid} inside`),
      assistantMsg('processed first'),
      userMsg('active'),
      assistantMsg('active turn'),
    ];
    const cfg: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 4000 };
    const result = foldContext(msgs, 1, cfg);
    const foldBlock = result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('[Conversation Context'),
    );
    expect(foldBlock).toBeDefined();
    const content = foldBlock!.content as string;
    expect(content).toContain('COORDINATE CLOSET');
    expect(content).toContain(uuid);
  });

  test('belted closet items do not duplicate into the closet (conservation incl. KV form)', () => {
    // Bash result carries `job id: <uuid>` — the belt puts the bare uuid into
    // the skeleton; conservation must keep BOTH the bare form and the
    // `id: <uuid>` KV form out of the closet.
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const msgs = buildTurnsWithResult([`job id: ${uuid}`, 'plain result']);
    const cfg: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 4000 };
    const result = foldContext(msgs, 2, cfg);
    const foldBlock = result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('[Conversation Context'),
    );
    expect(foldBlock).toBeDefined();
    const content = foldBlock!.content as string;
    expect(content).toContain(uuid); // belt carries it in the skeleton
    expect(content).not.toContain('⌖⌖⌖ COORDINATE CLOSET'); // closet stays empty
  });

  test('keep admits a value once across turns (KV form conserved by keep itself)', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const msgs: FoldMessage[] = [
      userMsg('first'),
      anthropicToolUse('Read', { file_path: 'relay/src/a.ts' }, 'toolu_s1'),
      anthropicToolResult('toolu_s1', `found ${uuid} in config`),
      assistantMsg('noted'),
      userMsg('second'),
      anthropicToolUse('Read', { file_path: 'relay/src/b.ts' }, 'toolu_s2'),
      anthropicToolResult('toolu_s2', `same value id: ${uuid} again`),
      assistantMsg('confirmed'),
      userMsg('active'),
      assistantMsg('active turn'),
    ];
    const cfg: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 4000 };
    const result = foldContext(msgs, 2, cfg);
    const foldBlock = result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('[Conversation Context'),
    );
    expect(foldBlock).toBeDefined();
    const closetLine = (foldBlock!.content as string).split('\n').find(l => l.startsWith('⌖⌖⌖ COORDINATE CLOSET'));
    expect(closetLine).toBeDefined();
    expect(closetLine!.split(uuid).length - 1).toBe(1); // exactly once
    expect(closetLine).not.toContain('id:');
  });

  test('fold block with a non-empty closet is byte-identical across runs', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const msgs: FoldMessage[] = [
      userMsg('first'),
      anthropicToolUse('Read', { file_path: 'relay/src/a.ts' }, 'toolu_d1'),
      anthropicToolResult('toolu_d1', `value ${uuid} here`),
      assistantMsg('seen'),
      userMsg('active'),
      assistantMsg('active turn'),
    ];
    const cfg: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 4000 };
    const block = (msgsIn: FoldMessage[]): string => {
      const r = foldContext(msgsIn, 1, cfg);
      const fb = r.messages.find(m =>
        typeof m.content === 'string' && (m.content as string).includes('[Conversation Context'),
      );
      return fb!.content as string;
    };
    const first = block(msgs);
    const second = block(msgs);
    expect(first).toContain('COORDINATE CLOSET');
    expect(first).toBe(second);
  });

  test('verbatimKeepChars: 0 → no Coordinate Closet line', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const msgs = buildTurnsWithResult([`job id: ${uuid}`, 'plain result']);
    const cfg: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 0 };
    const result = foldContext(msgs, 2, cfg);
    const foldBlock = result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('[Conversation Context'),
    );
    expect(foldBlock).toBeDefined();
    // Keep-line marker, not the bare word
    expect((foldBlock!.content as string)).not.toContain('⌖⌖⌖ COORDINATE CLOSET');
  });

  test('id-free transcript with verbatimKeepChars: 0 → output unchanged from pre-closet format', () => {
    // No closet items in source → no keep section regardless of budget
    const msgs = buildTurnsWithResult(['plain output here', 'also plain text only']);
    const cfg0: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 0 };
    const cfg4k: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 4000 };
    const r0 = foldContext(msgs, 2, cfg0);
    const r4k = foldContext(msgs, 2, cfg4k);
    const block0 = r0.messages.find(m => typeof m.content === 'string' && m.content.includes('[Conversation Context'));
    const block4k = r4k.messages.find(m => typeof m.content === 'string' && m.content.includes('[Conversation Context'));
    expect(block0).toBeDefined();
    expect(block4k).toBeDefined();
    // Neither should have a Coordinate Closet line; content must be byte-identical
    expect(block0!.content as string).not.toContain('⌖⌖⌖ COORDINATE CLOSET');
    expect(block4k!.content as string).not.toContain('⌖⌖⌖ COORDINATE CLOSET');
    expect(block0!.content).toBe(block4k!.content);
  });

  test('first-come wins: tiny budget admits earlier UUID, drops later one', () => {
    const uuid1 = '11111111-2222-3333-4444-555555555555'; // 36 chars
    const uuid2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // 36 chars
    // Use Read (no belt) so UUIDs in results don't leak into the skeleton.
    // The skeleton for Read is "📖 path" — no UUID appears there, so both are
    // unconserved keep candidates. Budget=36 fits uuid1 (36 chars) but the
    // second addition needs 3+36=39 extra → 36+39=75 > 36, so uuid2 is skipped.
    const msgs: FoldMessage[] = [
      userMsg('first'),
      anthropicToolUse('Read', { file_path: 'relay/src/a.ts' }, 'toolu_r1'),
      anthropicToolResult('toolu_r1', 'content with ' + uuid1 + ' inside'),
      assistantMsg('processed first'),
      userMsg('second'),
      anthropicToolUse('Read', { file_path: 'relay/src/b.ts' }, 'toolu_r2'),
      anthropicToolResult('toolu_r2', 'content with ' + uuid2 + ' inside'),
      assistantMsg('processed second'),
      userMsg('active'),
      assistantMsg('active turn'),
    ];
    const cfg: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 36 };
    const result = foldContext(msgs, 2, cfg);
    const foldBlock = result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('[Conversation Context'),
    );
    expect(foldBlock).toBeDefined();
    const content = foldBlock!.content as string;
    expect(content).toContain(uuid1);
    expect(content).not.toContain(uuid2);
  });

  // ── P1b user-verbatim lane ────────────────────────────────────────────
  // User-authored text is body-invisible (skeletons/retained render only tool
  // skeletons + assistant text), so an operator-pasted id's ONLY carry path is
  // the closet. The user lane closes that gap, capped so a paste can't squat.

  test('user-pasted UUID is conserved in the Coordinate Closet (P1b core fix)', () => {
    // The uuid lives ONLY in the user message — no tool result or assistant text
    // echoes it. Before the user lane it was silently dropped on fold.
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const msgs: FoldMessage[] = [
      userMsg(`please investigate job ${uuid} for me`),
      anthropicToolUse('Read', { file_path: 'relay/src/a.ts' }, 'toolu_up1'),
      anthropicToolResult('toolu_up1', 'file contents with no identifiers'),
      assistantMsg('looked, nothing relevant there'),
      userMsg('active'),
      assistantMsg('active turn'),
    ];
    const cfg: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 4000 };
    const result = foldContext(msgs, 1, cfg);
    const content = (result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('[Conversation Context'),
    )!.content) as string;
    expect(content).toContain('COORDINATE CLOSET');
    expect(content).toContain(uuid);
  });

  test('anti-squat: the user lane is capped so a paste dump cannot starve the agent id (P1b)', () => {
    const agentUuid = '99999999-0000-0000-0000-000000000000';
    // 40 distinct user-pasted uuids (~1.5k chars with separators) — these WOULD
    // all fit in a 4000-char budget if the user lane were uncapped. The 25%
    // sub-budget (≤1000 chars here) must bite and drop the overflow.
    const userUuids = Array.from({ length: 40 }, (_, i) =>
      `550e8400-e29b-41d4-a716-${i.toString(16).padStart(12, '0')}`,
    );
    const msgs: FoldMessage[] = [
      userMsg('here is a giant log dump: ' + userUuids.join(' ')),
      anthropicToolUse('Read', { file_path: 'relay/src/a.ts' }, 'toolu_sq1'),
      anthropicToolResult('toolu_sq1', `agent working id ${agentUuid}`),
      assistantMsg('done'),
      userMsg('active'),
      assistantMsg('active turn'),
    ];
    const cfg: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 4000 };
    const result = foldContext(msgs, 1, cfg);
    const content = (result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('[Conversation Context'),
    )!.content) as string;
    // Agent's working identifier always wins — main lane nominates first at full budget.
    expect(content).toContain(agentUuid);
    // The user lane is capped: NOT every pasted id survives despite ample raw
    // budget. That bounded loss is the anti-squat guarantee.
    const present = userUuids.filter(u => content.includes(u)).length;
    expect(present).toBeLessThan(userUuids.length); // cap bit — overflow dropped
    expect(present).toBeGreaterThan(0);             // lane still conserves some
  });

  test('user verbatim already carried by the agent is not double-added by the user lane (P1b)', () => {
    // uuid appears in BOTH the user paste and a tool result. The main lane
    // carries it once; the user lane must dedupe against the closet, not re-add.
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const msgs: FoldMessage[] = [
      userMsg(`debug ${uuid} please`),
      anthropicToolUse('Read', { file_path: 'relay/src/a.ts' }, 'toolu_dd1'),
      anthropicToolResult('toolu_dd1', `found ${uuid} in the file`),
      assistantMsg('confirmed'),
      userMsg('active'),
      assistantMsg('active turn'),
    ];
    const cfg: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 4000 };
    const result = foldContext(msgs, 1, cfg);
    const closetLine = ((result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('[Conversation Context'),
    )!.content) as string).split('\n').find(l => l.startsWith('⌖⌖⌖ COORDINATE CLOSET'));
    expect(closetLine).toBeDefined();
    expect(closetLine!.split(uuid).length - 1).toBe(1); // exactly once
  });

  test('verbatimKeepChars: 0 disables the user lane too (P1b)', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const msgs: FoldMessage[] = [
      userMsg(`pasted id ${uuid} here`),
      anthropicToolUse('Read', { file_path: 'relay/src/a.ts' }, 'toolu_z1'),
      anthropicToolResult('toolu_z1', 'no identifiers in result'),
      assistantMsg('ok'),
      userMsg('active'),
      assistantMsg('active turn'),
    ];
    const cfg: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 0 };
    const result = foldContext(msgs, 1, cfg);
    const content = (result.messages.find(m =>
      typeof m.content === 'string' && m.content.includes('[Conversation Context'),
    )!.content) as string;
    expect(content).not.toContain('⌖⌖⌖ COORDINATE CLOSET');
  });
});

// ══════════════════════════════════════════════════════════════════════
// P3 Receipts belt — skeletonizeTool belt attachment (s9)
// ══════════════════════════════════════════════════════════════════════

describe('skeletonizeTool — receipts belt (P3/s9)', () => {
  test('Bash skeleton appends [literal] when result contains a hex id', () => {
    const sha = 'a1b2c3d4e5f6'; // 12-char hex → matches LITERAL_HEX_RE
    const skeleton = skeletonizeTool({
      name: 'Bash',
      input: { command: 'git log --oneline' },
      resultText: `commit ${sha} add feature`,
      toolId: 'tu1',
    } as any);
    expect(skeleton).toContain(sha);
    expect(skeleton).toMatch(/\[.+\]$/); // trailing bracket section
  });

  test('Bash skeleton has no bracket when result has no closet items', () => {
    const skeleton = skeletonizeTool({
      name: 'Bash',
      input: { command: 'echo hello' },
      resultText: 'hello world nothing special',
      toolId: 'tu2',
    } as any);
    expect(skeleton).not.toContain('[');
  });

  test('default MCP arm appends [literal] when result contains a hex id', () => {
    const hexId = 'deadbeefcafe'; // 12-char hex
    const skeleton = skeletonizeTool({
      name: 'mcp__voxxo-swarm-bridge__some_tool',
      input: {},
      resultText: `id: ${hexId}`,
      toolId: 'tu3',
    } as any);
    expect(skeleton).toContain(hexId);
    expect(skeleton).toMatch(/\[.+\]$/);
  });

  test('default arm has no bracket when result has no closet items', () => {
    const skeleton = skeletonizeTool({
      name: 'mcp__voxxo-swarm-bridge__some_tool',
      input: {},
      resultText: 'plain text output nothing here',
      toolId: 'tu4',
    } as any);
    expect(skeleton).not.toContain('[');
  });

  test('belt does not spend two slots on one value (bare + KV forms collapse)', () => {
    const skeleton = skeletonizeTool({
      name: 'Bash',
      input: { command: 'show job' },
      resultText: 'job id=a1b2c3d4e5f6 done',
      toolId: 'tu_dedup',
    } as any);
    const bracket = /\[(.+)\]$/.exec(skeleton);
    expect(bracket).not.toBeNull();
    expect(bracket![1]).toBe('a1b2c3d4e5f6');
  });

  test('belt capped at 2 closet items (max=2 by default)', () => {
    // 3 distinct hex strings — belt should carry at most 2
    const h1 = 'aabbccddeeff'; // 12 hex
    const h2 = 'bbccddeeffaa'; // 12 hex
    const h3 = 'ccddeeffaabb'; // 12 hex
    const skeleton = skeletonizeTool({
      name: 'Bash',
      input: { command: 'list ids' },
      resultText: `${h1} ${h2} ${h3}`,
      toolId: 'tu5',
    } as any);
    // belt format: [hex1, hex2] — exactly two
    const bracketMatch = /\[(.+)\]$/.exec(skeleton);
    expect(bracketMatch).not.toBeNull();
    const beltParts = bracketMatch![1].split(', ');
    expect(beltParts.length).toBeLessThanOrEqual(2);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Fold-recall synthetic text exclusion (see foldRecall.ts)
// ══════════════════════════════════════════════════════════════════════

describe('recall-card turn boundary exclusion', () => {
  const CARD = '[Recalled from fold — Read relay/src/foo.ts | trigger: path-touch relay/src/foo.ts | 5,000 chars folded]\nrecalled body text here\n[End fold recall]';
  const HINT = '[Fold recall hint — Read relay/src/foo.ts folded earlier (5,000 chars) | trigger: claim relay/src/foo.ts | self-tap to recover]';

  test('recall cards and hints never start a new turn (all three content arms)', () => {
    const msgs: FoldMessage[] = [
      userMsg('real turn one'),
      assistantMsg('working on it with enough text to matter'),
      // String-content arm:
      { role: 'user', content: CARD },
      // Block text arm:
      { role: 'user', content: [{ type: 'text', text: HINT }] },
      // String-block arm:
      { role: 'user', content: [CARD] },
      assistantMsg('continuing'),
      userMsg('real turn two'),
      assistantMsg('done with the follow-up work'),
    ];
    const turns = detectTurns(msgs);
    expect(turns).toHaveLength(2);
    expect(turns[0].startIndex).toBe(0);
    expect(turns[1].startIndex).toBe(6);
  });

  test('histories without recall blocks fold byte-identically to before', () => {
    const msgs: FoldMessage[] = [];
    for (let t = 0; t < 4; t++) {
      msgs.push(userMsg(`turn ${t} question with some real content`));
      msgs.push(assistantMsg(`turn ${t} answer — the fix is in module ${t} because the guard was inverted.`));
    }
    const trigger = checkFoldTrigger(msgs, { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, maxTurnsBeforeFold: 2 });
    expect(trigger.shouldFold).toBe(true);
    const a = foldContext(msgs, trigger.turnsToFold, { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1 });
    const b = foldContext(msgs, trigger.turnsToFold, { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1 });
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
  });

  test('a recall card refolds away on the next epoch (page-out-again)', () => {
    const msgs: FoldMessage[] = [
      userMsg('investigate the widget'),
      assistantMsg('investigating the widget now with substantial reasoning text'),
      // Recall card injected into this turn (attaches to it — not a boundary):
      { role: 'user', content: CARD },
      assistantMsg('absorbed the recalled content'),
      userMsg('next task please'),
      assistantMsg('on it'),
    ];
    const turns = detectTurns(msgs);
    expect(turns).toHaveLength(2); // the card did not split turn 1

    // Continuous fold with window=1: turn 1 (carrying the card) skeletonizes.
    const result = foldContext(msgs, 1, { activeWindowTurns: 1, softThresholdChars: 800_000, hardThresholdChars: 1_500_000, maxTurnsBeforeFold: 60, assistantTextBudget: { fullRetentionChars: 0, essenceRetentionChars: 0 }, continuous: true });
    expect(result.turnsFolded).toBe(1);
    const serialized = JSON.stringify(result.messages);
    expect(serialized).not.toContain('recalled body text here');
  });
});

// ══════════════════════════════════════════════════════════════════════
// Fold-epoch stamp — formatFoldEpochStamp / synthetic-text classification
// ══════════════════════════════════════════════════════════════════════

describe('formatFoldEpochStamp', () => {
  test('formats epoch number and detail as one bracketed line', () => {
    const stamp = formatFoldEpochStamp(3, 'context-changed: claim relay/src/foo.ts, gap 46s');
    expect(stamp).toBe('[Fold epoch #3 — context-changed: claim relay/src/foo.ts, gap 46s]');
    expect(stamp.startsWith('[Fold epoch #')).toBe(true);
    expect(stamp.endsWith(']')).toBe(true);
  });

  test('truncates detail to 120 chars', () => {
    const stamp = formatFoldEpochStamp(12, 'x'.repeat(300));
    expect(stamp).toBe(`[Fold epoch #12 — ${'x'.repeat(120)}]`);
  });

  test('detail at exactly 120 chars is untouched', () => {
    const detail = 'y'.repeat(120);
    expect(formatFoldEpochStamp(1, detail)).toBe(`[Fold epoch #1 — ${detail}]`);
  });

  test('isSyntheticContextText recognizes the stamp — never a turn boundary', () => {
    expect(isSyntheticContextText(formatFoldEpochStamp(1, 'first-call'))).toBe(true);
  });

  test('stamp inside a turn does not split it', () => {
    const msgs: FoldMessage[] = [
      userMsg('do the thing'),
      assistantMsg('doing it'),
      { role: 'user', content: formatFoldEpochStamp(2, 'tail-cap') },
      assistantMsg('continuing after the stamp'),
      userMsg('next request'),
      assistantMsg('ok'),
    ];
    expect(detectTurns(msgs)).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════════════
// User Message Vault — synthetic host note inside user turns
// ══════════════════════════════════════════════════════════════════════

describe('User Message Vault synthetic filtering', () => {
  const vault = `${USER_MESSAGE_VAULT_PREFIX}\nold operator copy\n${USER_MESSAGE_VAULT_END}`;
  const hostSyntheticContext = {
    leadingBlocks: [
      { prefix: '[Host Time]', mode: 'line-or-paragraph' },
      { prefix: '[Host Memory]', end: '[END Host Memory]', mode: 'paired' },
      { prefix: '[Host Digest', end: '[END Host Digest]', mode: 'paired' },
      { prefix: '[Host Thread]', end: '[END Host Thread]', mode: 'paired' },
      { prefix: '[Host Signals]', end: '[END Host Signals]', mode: 'paired' },
      { prefix: '[Host Note:', mode: 'bracketed' },
    ],
    wholeTextMatchers: [
      (text: string) => text.startsWith('[Host Continuity]')
        || /^package_version:\s*\d+\n\[Host Continuity\]/.test(text),
    ],
  } as const;
  const hostResumeWrapper = `[Host Time] Session age: 4h 3m

[Host Note: Context pressure limits were reached during your execution.
Your context has been successfully folded for efficiency.
Please seamlessly continue your previous turn from where you were interrupted.
Do not repeat your prior output; simply resume your sentence, tool call, or task directly.]

${vault}`;
  const fullHostResumeWrapper = `[Host Time]
Session age: 4h 3m

[Host Memory]
Nearby codebase context from recent language:
- src/voiceRecording.ts - Voice recording capture pipeline (high; fts)
[END Host Memory]

[Host Digest seq 26-68]
  * peer-agent: touched src/foldSummary.ts
[END Host Digest]

[Host Thread]
  peer-agent in #fold-repair
[END Host Thread]

[Host Signals]
#result peer landed a related change
[END Host Signals]

[Host Note: Context pressure limits were reached during your execution.
Your context has been successfully folded for efficiency.
Please seamlessly continue your previous turn from where you were interrupted.
Do not repeat your prior output; simply resume your sentence, tool call, or task directly.]

${vault}`;

  test('standalone vault text is synthetic and never a turn boundary', () => {
    expect(isSyntheticContextText(vault)).toBe(true);

    const msgs: FoldMessage[] = [
      userMsg(vault),
      assistantMsg('continuing'),
      userMsg('real request'),
      assistantMsg('ok'),
    ];

    expect(detectTurns(msgs)).toHaveLength(1);
  });

  test('vault blocks are stripped before extracting genuine user text', () => {
    const mixed = `real request\n\n${vault}`;

    expect(stripUserMessageVaultBlocks(mixed)).toBe('real request');
    expect(extractUserText([userMsg(mixed)])).toBe('real request');
  });

  test('host resume wrappers are stripped before extracting genuine user text when supplied', () => {
    const mixed = `${hostResumeWrapper}\n\nreal request`;

    expect(stripSyntheticUserContextBlocks(mixed, hostSyntheticContext)).toBe('real request');
    expect(extractUserText([userMsg(mixed)], hostSyntheticContext)).toBe('real request');
  });

  test('full host resume envelopes are stripped before extracting genuine user text when supplied', () => {
    const mixed = `${fullHostResumeWrapper}\n\nreal request`;

    expect(stripSyntheticUserContextBlocks(mixed, hostSyntheticContext)).toBe('real request');
    expect(extractUserText([userMsg(mixed)], hostSyntheticContext)).toBe('real request');
    expect(detectTurns([userMsg(fullHostResumeWrapper), assistantMsg('continuing')], hostSyntheticContext)).toHaveLength(0);
  });

  test('wrapper-only resume notes do not become user text or turn boundaries', () => {
    expect(stripSyntheticUserContextBlocks(hostResumeWrapper, hostSyntheticContext)).toBe('');
    expect(extractUserText([userMsg(hostResumeWrapper)], hostSyntheticContext)).toBe('');
    expect(detectTurns([userMsg(hostResumeWrapper), assistantMsg('continuing')], hostSyntheticContext)).toHaveLength(0);
  });

  test('incomplete vault marker mentions stay user-authored text', () => {
    const text = `literal marker mention ${USER_MESSAGE_VAULT_PREFIX}`;

    expect(stripUserMessageVaultBlocks(text)).toBe(text);
    expect(extractUserText([userMsg(text)])).toBe(text);
  });

  const hostContinuityPackage = `[Host Time] Session age: 2h 6m

[Host Digest seq 514-529]
  * peer-agent: touched src/foldSummary.ts
[END Host Digest]

package_version: 5
[Host Continuity] You are the continuation of "agent". Read Last User + AI Messages first, then Current Thread.

── Current Thread ──
👤 USER (active request):
Make your fixes`;

  test('host continuity packages are inert by default and synthetic only when supplied', () => {
    const legacyPkg = `[Host Continuity] You are the continuation of "agent". Pick up where it left off.`;
    const versionedPkg = `package_version: 5\n[Host Continuity] You are the continuation of "agent".`;
    expect(isSyntheticContextText(legacyPkg)).toBe(false);
    expect(isSyntheticContextText(versionedPkg)).toBe(false);
    expect(isSyntheticContextText(legacyPkg, hostSyntheticContext)).toBe(true);
    expect(isSyntheticContextText(versionedPkg, hostSyntheticContext)).toBe(true);
    expect(detectTurns([userMsg(legacyPkg), assistantMsg('continuing')], hostSyntheticContext)).toHaveLength(0);
  });

  test('host continuity package with leading wrappers is consumed whole; a later real ask still anchors a turn', () => {
    expect(stripSyntheticUserContextBlocks(hostContinuityPackage, hostSyntheticContext)).toBe('');
    expect(extractUserText([userMsg(hostContinuityPackage)], hostSyntheticContext)).toBe('');
    expect(detectTurns([
      userMsg(hostContinuityPackage), assistantMsg('continuing'),
      userMsg('real follow-up'), assistantMsg('ok'),
    ], hostSyntheticContext)).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// E10 — episodic eviction (sawtooth bounded skeleton floor)
// ══════════════════════════════════════════════════════════════════════

const EVICTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Digit-free, non-prefix-overlapping per-turn body token (digit-free so no literal pattern nominates it into the closet). */
function evictionBodyToken(i: number): string {
  return `EVICTBODY${EVICTION_LETTERS[i]}Q`;
}

function evictionNoteToken(i: number): string {
  return `EVICTNOTE${EVICTION_LETTERS[i]}Q`;
}

/** One synthetic turn with distinctive body + note tokens (no colons — keeps KV nomination out of the picture). */
function evictionTurn(i: number): FoldMessage[] {
  const id = `toolu_evict_${i}`;
  return [
    userMsg(`Task ${i} — inspect module ${i}`),
    anthropicToolUse('Read', { file_path: `/home/user/project/src/mod${i}.ts` }, id),
    anthropicToolResult(id, `${evictionBodyToken(i)} ` + 'filler content line\n'.repeat(30)),
    assistantMsg(`Module ${i} analysed — ${evictionNoteToken(i)} — ` + 'reasoning filler. '.repeat(40)),
  ];
}

function evictionSpan(over: Partial<FoldEvictionSpan> = {}): FoldEvictionSpan {
  return {
    fromOrdinal: 0,
    toOrdinalExclusive: 1,
    turnCount: 1,
    firstEvictedIso: '2026-06-11T00:00:00.000Z',
    lastEvictedIso: '2026-06-11T00:00:00.000Z',
    ...over,
  };
}

function extractFoldBlock(messages: FoldMessage[]): string {
  const block = messages.find(
    m => typeof m.content === 'string' && (m.content as string).startsWith('[Conversation Context —'),
  );
  return (block?.content as string) ?? '';
}

interface EvictionSimResult {
  blockSizes: number[];
  blocks: string[];
  spans: FoldEvictionSpan[];
  maxSpanEndSeen: number;
  rawTurnCount: number;
}

/**
 * Drive N freeze epochs the way fcBaseSession does: per epoch, append turns,
 * compute the eligibility ceiling (durable cursor ∧ ≥2-epoch age over the
 * recorded fold frontiers), fold with the carried span state, then adopt the
 * updated spans and record the frontier. `cursorCapTurns` simulates a store
 * whose confirmed coverage stops at that turn ordinal (Infinity = everything
 * confirmed durable).
 */
function simulateEvictionEpochs(opts: {
  epochs: number;
  turnsPerEpoch: number;
  thresholdChars: number;
  cursorCapTurns?: number;
}): EvictionSimResult {
  const messages: FoldMessage[] = [];
  let spans: FoldEvictionSpan[] = [];
  const frontiers: Array<{ epoch: number; turnsFolded: number }> = [];
  const blockSizes: number[] = [];
  const blocks: string[] = [];
  let maxSpanEndSeen = 0;
  let turnIndex = 0;

  for (let epoch = 1; epoch <= opts.epochs; epoch++) {
    for (let t = 0; t < opts.turnsPerEpoch; t++) {
      messages.push(...evictionTurn(turnIndex++));
    }
    const turns = detectTurns(messages);
    const cursor = opts.cursorCapTurns !== undefined && opts.cursorCapTurns < turns.length
      ? turns[opts.cursorCapTurns].startIndex
      : messages.length;
    const evictable = computeEvictableThroughOrdinal(turns, cursor, frontiers, epoch);
    const input: FoldEvictionInput = {
      evictedSpans: spans,
      evictableThroughOrdinal: evictable,
      thresholdChars: opts.thresholdChars,
      nowIso: `2026-06-${String(10 + (epoch % 15)).padStart(2, '0')}T00:00:00.000Z`,
    };
    const result = foldContext(messages, turns.length - 1, ALWAYS_ON_FOLD_CONFIG, input);
    spans = result.evictedSpans ?? spans;
    for (const s of spans) maxSpanEndSeen = Math.max(maxSpanEndSeen, s.toOrdinalExclusive);
    frontiers.push({ epoch, turnsFolded: result.turnsFolded });
    const block = extractFoldBlock(result.messages);
    blocks.push(block);
    blockSizes.push(block.length);
  }
  return { blockSizes, blocks, spans, maxSpanEndSeen, rawTurnCount: turnIndex };
}

describe('computeEvictableThroughOrdinal (E10 eligibility)', () => {
  const turns = [
    { startIndex: 0, endIndex: 4 },
    { startIndex: 4, endIndex: 8 },
    { startIndex: 8, endIndex: 12 },
  ];

  test('cursor arm counts only turns fully at or below the durable cursor (endIndex exclusive)', () => {
    expect(computeEvictableThroughOrdinal(turns, 8, [{ epoch: 1, turnsFolded: 5 }], 3)).toBe(2);
    expect(computeEvictableThroughOrdinal(turns, 7, [{ epoch: 1, turnsFolded: 5 }], 3)).toBe(1);
    expect(computeEvictableThroughOrdinal(turns, 12, [{ epoch: 1, turnsFolded: 5 }], 3)).toBe(3);
  });

  test('age arm uses only frontiers from ≥2 epochs back', () => {
    const frontiers = [
      { epoch: 1, turnsFolded: 2 },
      { epoch: 2, turnsFolded: 9 },
    ];
    expect(computeEvictableThroughOrdinal(turns, 99, frontiers, 3)).toBe(2); // only epoch 1 qualifies
    expect(computeEvictableThroughOrdinal(turns, 99, frontiers, 4)).toBe(3); // epoch 2 qualifies, cursor caps at 3
  });

  test('no qualifying frontier → nothing evictable', () => {
    expect(computeEvictableThroughOrdinal(turns, 99, [], 5)).toBe(0);
    expect(computeEvictableThroughOrdinal(turns, 99, [{ epoch: 4, turnsFolded: 3 }], 5)).toBe(0);
  });
});

describe('formatFoldTombstoneLine + mergeEvictionSpans (E10)', () => {
  test('same-day span renders a single date; cross-day renders a range', () => {
    const sameDay = formatFoldTombstoneLine(evictionSpan({ turnCount: 7 }));
    expect(sameDay).toBe(`${FOLD_TOMBSTONE_PREFIX}2026-06-11, 7 turns; recallable by touching member paths]`);
    const crossDay = formatFoldTombstoneLine(evictionSpan({
      firstEvictedIso: '2026-06-09T05:00:00.000Z',
      lastEvictedIso: '2026-06-11T09:00:00.000Z',
      turnCount: 3,
    }));
    expect(crossDay).toContain('2026-06-09→2026-06-11');
    expect(crossDay.startsWith(FOLD_TOMBSTONE_PREFIX)).toBe(true);
  });

  test('mergeEvictionSpans keeps at most the cap, merging oldest pairs with date union + count sum', () => {
    const spans = Array.from({ length: 8 }, (_, i) => evictionSpan({
      fromOrdinal: i * 2,
      toOrdinalExclusive: i * 2 + 2,
      turnCount: 2,
      firstEvictedIso: `2026-06-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
      lastEvictedIso: `2026-06-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
    }));
    const merged = mergeEvictionSpans(spans, 6);
    expect(merged).toHaveLength(6);
    expect(merged[0].fromOrdinal).toBe(0);
    expect(merged[0].toOrdinalExclusive).toBe(6); // first three pairs collapsed
    expect(merged[0].turnCount).toBe(6);
    expect(merged[0].firstEvictedIso).toBe('2026-06-10T00:00:00.000Z');
    expect(merged[0].lastEvictedIso).toBe('2026-06-12T00:00:00.000Z');
    expect(merged.reduce((s, x) => s + x.turnCount, 0)).toBe(16);
    expect(merged.map(s => s.fromOrdinal)).toEqual([...merged.map(s => s.fromOrdinal)].sort((a, b) => a - b));
  });
});

describe('foldContext — episodic eviction (E10 sawtooth)', () => {
  test('no eviction input → output byte-identical to an input-free call, no eviction fields', () => {
    const messages: FoldMessage[] = [];
    for (let i = 0; i < 6; i++) messages.push(...evictionTurn(i));
    const plain = foldContext(messages, 5, ALWAYS_ON_FOLD_CONFIG);
    const explicit = foldContext(messages, 5, ALWAYS_ON_FOLD_CONFIG, undefined);
    expect(extractFoldBlock(explicit.messages)).toBe(extractFoldBlock(plain.messages));
    expect(plain.evictedSpans).toBeUndefined();
    expect(plain.newlyEvictedTurns).toBeUndefined();
  });

  test('inert eviction input (nothing evicted, nothing evictable) leaves the block byte-identical', () => {
    const messages: FoldMessage[] = [];
    for (let i = 0; i < 6; i++) messages.push(...evictionTurn(i));
    const plain = foldContext(messages, 5, ALWAYS_ON_FOLD_CONFIG);
    const withInput = foldContext(messages, 5, ALWAYS_ON_FOLD_CONFIG, {
      evictedSpans: [],
      evictableThroughOrdinal: 0,
      thresholdChars: 1_000_000,
      nowIso: '2026-06-11T00:00:00.000Z',
    });
    expect(extractFoldBlock(withInput.messages)).toBe(extractFoldBlock(plain.messages));
    expect(withInput.evictedSpans).toEqual([]);
    expect(withInput.newlyEvictedTurns).toBe(0);
  });

  test('previously evicted spans render as tombstones: detail absent, header still counts all folded turns', () => {
    const messages: FoldMessage[] = [];
    for (let i = 0; i < 5; i++) messages.push(...evictionTurn(i));
    const result = foldContext(messages, 4, ALWAYS_ON_FOLD_CONFIG, {
      evictedSpans: [evictionSpan({ toOrdinalExclusive: 2, turnCount: 2 })],
      evictableThroughOrdinal: 2,
      thresholdChars: 1_000_000,
      nowIso: '2026-06-11T00:00:00.000Z',
    });
    const block = extractFoldBlock(result.messages);
    const lines = block.split('\n');
    expect(lines[0].startsWith('[Conversation Context —')).toBe(true); // foldRecall anchor invariant
    expect(lines[0]).toContain('4 turns folded'); // evicted turns still counted — recall keeps indexing them
    const tombstoneLines = lines.filter(l => l.startsWith(FOLD_TOMBSTONE_PREFIX));
    expect(tombstoneLines).toHaveLength(1);
    expect(tombstoneLines[0]).toContain('2 turns');
    // Tombstone sits after the preamble and before the first surviving skeleton.
    const preambleIdx = lines.findIndex(l => l === FOLD_BLOCK_PREAMBLE);
    const tombstoneIdx = lines.findIndex(l => l.startsWith(FOLD_TOMBSTONE_PREFIX));
    const survivorIdx = lines.findIndex(l => l.includes(evictionBodyToken(2)) || l.includes('mod2.ts'));
    expect(preambleIdx).toBeGreaterThan(-1);
    expect(tombstoneIdx).toBeGreaterThan(preambleIdx);
    expect(survivorIdx).toBeGreaterThan(tombstoneIdx);
    // Evicted detail gone; survivors intact.
    expect(block).not.toContain(evictionBodyToken(0));
    expect(block).not.toContain(evictionNoteToken(0));
    expect(block).not.toContain(evictionBodyToken(1));
    expect(block).toContain(evictionNoteToken(2));
    expect(result.newlyEvictedTurns).toBe(0);
    expect(result.evictedSpans).toHaveLength(1);
  });

  test('sawtooth: ≥6 epochs with confirmed persistence → block plateaus in a band, never monotonic growth', () => {
    const threshold = 6000;
    const evicted = simulateEvictionEpochs({ epochs: 8, turnsPerEpoch: 3, thresholdChars: threshold });
    const unbounded = simulateEvictionEpochs({ epochs: 8, turnsPerEpoch: 3, thresholdChars: 1_000_000 });

    // Without eviction the block grows monotonically; with it, the tail is bounded.
    expect(unbounded.blockSizes[7]).toBeGreaterThan(unbounded.blockSizes[3]);
    expect(evicted.blockSizes[7]).toBeLessThan(unbounded.blockSizes[7] * 0.6);
    // Band: once eviction engages (epoch ≥ 4), the block stays within
    // threshold + one epoch of growth (the unevictable ≥2-epoch-young tail).
    const perEpochGrowth = unbounded.blockSizes[7] - unbounded.blockSizes[6];
    for (let e = 3; e < 8; e++) {
      expect(evicted.blockSizes[e]).toBeLessThan(threshold + perEpochGrowth * 2);
    }
    // Not monotonic growth: once eviction engages, the late-epoch growth rate
    // collapses versus the unbounded run (steady-state adds ≈ evicts, so the
    // band is near-flat rather than strictly shrinking).
    const evictedLateGrowth = evicted.blockSizes[7] - evicted.blockSizes[3];
    const unboundedLateGrowth = unbounded.blockSizes[7] - unbounded.blockSizes[3];
    expect(evictedLateGrowth).toBeLessThan(unboundedLateGrowth * 0.35);
    // Tombstones present and bounded by the merge cap.
    const lastBlock = evicted.blocks[7];
    const tombstones = lastBlock.split('\n').filter(l => l.startsWith(FOLD_TOMBSTONE_PREFIX));
    expect(tombstones.length).toBeGreaterThan(0);
    expect(tombstones.length).toBeLessThanOrEqual(6);
    // Oldest detail evicted; recent detail survives.
    expect(lastBlock).not.toContain(evictionBodyToken(0));
    expect(lastBlock).toContain(evictionNoteToken(evicted.rawTurnCount - 2));
  });

  test('unpersisted spans are NEVER evicted: eviction stops at the durable-coverage ceiling', () => {
    const sim = simulateEvictionEpochs({
      epochs: 8,
      turnsPerEpoch: 3,
      thresholdChars: 3000,
      cursorCapTurns: 6, // store confirmed coverage stops at turn ordinal 6
    });
    expect(sim.maxSpanEndSeen).toBeLessThanOrEqual(6);
    const lastBlock = sim.blocks[7];
    // Ordinals ≥ 6 keep their detail even under heavy threshold pressure.
    expect(lastBlock).toContain(evictionNoteToken(7));
    expect(lastBlock).toContain(evictionNoteToken(10));
    // Ordinals < 6 were eligible and the threshold forced them out.
    expect(lastBlock).not.toContain(evictionBodyToken(0));
  });

  test('evicted ordinals do not nominate into the closet', () => {
    const messages: FoldMessage[] = [];
    for (let i = 0; i < 5; i++) messages.push(...evictionTurn(i));
    const result = foldContext(messages, 4, ALWAYS_ON_FOLD_CONFIG, {
      evictedSpans: [evictionSpan({ toOrdinalExclusive: 2, turnCount: 2 })],
      evictableThroughOrdinal: 2,
      thresholdChars: 1_000_000,
      nowIso: '2026-06-11T00:00:00.000Z',
    });
    const block = extractFoldBlock(result.messages);
    const closetLine = block.split('\n').find(l => l.startsWith('⌖⌖⌖ COORDINATE CLOSET'));
    if (closetLine) {
      expect(closetLine).not.toContain('mod0.ts'); // evicted turn's path literal must not squat the closet
      expect(closetLine).not.toContain('mod1.ts');
    }
  });
});

describe('extractVerbatimContextLabel — Tier-1 annotated keep (page-out)', () => {
  test('JSON-key form → key name', () => {
    expect(extractVerbatimContextLabel('{"changelog_id":"7fd5835b00ab"}', '7fd5835b00ab')).toBe('changelog_id');
  });
  test('KV colon form → key name', () => {
    expect(extractVerbatimContextLabel('changelog_id: 7fd5835b00ab done', '7fd5835b00ab')).toBe('changelog_id');
  });
  test('rail-prefixed short hex → prose subject', () => {
    expect(extractVerbatimContextLabel('see rail-1f6be5b4 now', '1f6be5b4')).toBe('rail');
  });
  test('UUID with preceding subject → subject', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(extractVerbatimContextLabel(`session ${uuid} created`, uuid)).toBe('session');
  });
  test('absolute path value → no label (self-describing)', () => {
    expect(extractVerbatimContextLabel('reading /home/jonah/x.ts done', '/home/jonah/x.ts')).toBe('');
  });
  test('KV value → no label (self-describing)', () => {
    expect(extractVerbatimContextLabel('server port=3002 ok', 'port=3002')).toBe('');
  });
  test('value at string start → no label (no preceding context)', () => {
    expect(extractVerbatimContextLabel('7fd5835b00ab alone here', '7fd5835b00ab')).toBe('');
  });
  test('pure-hex preceding token → rejected (one hash never labels another)', () => {
    expect(extractVerbatimContextLabel('deadbeefcafe 7fd5835b00ee', '7fd5835b00ee')).toBe('');
  });
  test('value embedded in a longer alnum run → no boundary occurrence', () => {
    expect(extractVerbatimContextLabel('x7fd5835b00aby', '7fd5835b00ab')).toBe('');
  });
  test('label is capped at LABEL_MAX_CHARS', () => {
    const longKey = 'g'.repeat(60); // 'g' is not a hex digit → not rejected by the pure-hex guard
    const out = extractVerbatimContextLabel(`${longKey}: 7fd5835b00ab`, '7fd5835b00ab');
    expect(out.length).toBe(LABEL_MAX_CHARS);
    expect(out).toBe('g'.repeat(LABEL_MAX_CHARS));
  });
  test('pure function — identical inputs give identical output', () => {
    const a = extractVerbatimContextLabel('changelog_id: 7fd5835b00ab', '7fd5835b00ab');
    const b = extractVerbatimContextLabel('changelog_id: 7fd5835b00ab', '7fd5835b00ab');
    expect(a).toBe(b);
    expect(a).toBe('changelog_id');
  });
});

describe('annotated Coordinate Closet — labelled render in foldContext (Tier-1 integration)', () => {
  const hash = '7fd5835b00ab';
  const closetOf = (msgs: FoldMessage[], cfg: FoldConfig, foldCount: number): string | undefined => {
    const result = foldContext(msgs, foldCount, cfg);
    const fb = result.messages.find(
      m => typeof m.content === 'string' && (m.content as string).includes('[Conversation Context'),
    );
    return (fb?.content as string | undefined)?.split('\n').find(l => l.startsWith('⌖⌖⌖ COORDINATE CLOSET'));
  };

  test('opaque hash from a keyed tool result renders value ⟦label⟧', () => {
    const msgs: FoldMessage[] = [
      userMsg('first'),
      anthropicToolUse('Read', { file_path: 'relay/src/a.ts' }, 'toolu_l1'),
      anthropicToolResult('toolu_l1', `changelog_id: ${hash} landed`),
      assistantMsg('processed'),
      userMsg('active'),
      assistantMsg('active turn'),
    ];
    const cfg: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 4000 };
    const closetLine = closetOf(msgs, cfg, 1);
    expect(closetLine).toBeDefined();
    expect(closetLine).toContain(`${hash} ⟦changelog_id⟧`);
  });

  test('labelled closet line is byte-identical across runs (determinism)', () => {
    const msgs: FoldMessage[] = [
      userMsg('first'),
      anthropicToolUse('Read', { file_path: 'relay/src/a.ts' }, 'toolu_l2'),
      anthropicToolResult('toolu_l2', `changelog_id: ${hash} landed`),
      assistantMsg('processed'),
      userMsg('active'),
      assistantMsg('active turn'),
    ];
    const cfg: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 4000 };
    expect(closetOf(msgs, cfg, 1)).toBe(closetOf(msgs, cfg, 1));
  });

  test('under tight budget the value is preferred over its label (labelled→bare→skip)', () => {
    const msgs: FoldMessage[] = [
      userMsg('first'),
      anthropicToolUse('Read', { file_path: 'relay/src/a.ts' }, 'toolu_l3'),
      anthropicToolResult('toolu_l3', `changelog_id: ${hash} landed`),
      assistantMsg('processed'),
      userMsg('active'),
      assistantMsg('active turn'),
    ];
    // labelled form `7fd5835b00ab ⟦changelog_id⟧` is 27 chars; bare value is 12.
    const cfg: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 15 };
    const closetLine = closetOf(msgs, cfg, 1);
    expect(closetLine).toBeDefined();
    expect(closetLine).toContain(hash);
    expect(closetLine).not.toContain('⟦'); // label dropped, value kept
  });

  test('P1b user-lane value also carries a label', () => {
    const msgs: FoldMessage[] = [
      userMsg(`changelog_id: ${hash} from operator`),
      anthropicToolUse('Read', { file_path: 'relay/src/a.ts' }, 'toolu_l4'),
      anthropicToolResult('toolu_l4', 'plain content with no ids'),
      assistantMsg('ok'),
      userMsg('active'),
      assistantMsg('active turn'),
    ];
    const cfg: FoldConfig = { ...DEFAULT_FOLD_CONFIG, activeWindowTurns: 1, verbatimKeepChars: 4000 };
    const closetLine = closetOf(msgs, cfg, 1);
    expect(closetLine).toBeDefined();
    expect(closetLine).toContain(`${hash} ⟦changelog_id⟧`);
  });
});

describe('resolveFoldBandBudgets / resolveFoldConfigForBand (E10b target band)', () => {
  test('explicit 100K-token base band reproduces today\'s constants EXACTLY (base-equivalence proof)', () => {
    const band = resolveFoldBandBudgets(100_000);
    expect(band.bandChars).toBe(400_000);
    expect(band.fullRetentionChars).toBe(DEFAULT_ASSISTANT_TEXT_BUDGET.fullRetentionChars); // 50_000
    expect(band.essenceRetentionChars).toBe(DEFAULT_ASSISTANT_TEXT_BUDGET.essenceRetentionChars); // 100_000
    expect(band.fullRetentionChars).toBe(50_000);
    expect(band.essenceRetentionChars).toBe(100_000);
    expect(band.evictThresholdChars).toBe(DEFAULT_FOLD_EVICT_THRESHOLD_CHARS); // 22_000
    expect(band.episodicBoundaryBudgetChars).toBe(2_000);
  });

  test('default band is 100K tokens and scales the assistant-text budget', () => {
    expect(DEFAULT_FOLD_BAND_TOKENS).toBe(100_000);
    const band = resolveFoldBandBudgets(DEFAULT_FOLD_BAND_TOKENS);
    expect(band.bandChars).toBe(400_000);
    expect(band.fullRetentionChars).toBe(50_000);
    expect(band.essenceRetentionChars).toBe(100_000);

    const resolved = resolveFoldConfigForBand(undefined);
    expect(resolved).not.toBe(ALWAYS_ON_FOLD_CONFIG);
    expect(resolved.assistantTextBudget?.fullRetentionChars).toBe(50_000);
    expect(resolved.assistantTextBudget?.essenceRetentionChars).toBe(100_000);
  });

  test('explicit 100K base band → deep-equals ALWAYS_ON config', () => {
    const resolved = resolveFoldConfigForBand(100_000);
    expect(resolved).not.toBe(ALWAYS_ON_FOLD_CONFIG);
    expect(resolved).toEqual(ALWAYS_ON_FOLD_CONFIG);
  });

  test('budgets scale linearly with the band', () => {
    const half = resolveFoldBandBudgets(50_000);
    expect(half.fullRetentionChars).toBe(25_000);
    expect(half.essenceRetentionChars).toBe(50_000);
    expect(half.evictThresholdChars).toBe(11_000);
    expect(half.episodicBoundaryBudgetChars).toBe(1_000);
    const double = resolveFoldBandBudgets(200_000);
    expect(double.fullRetentionChars).toBe(100_000);
    expect(double.evictThresholdChars).toBe(44_000);
  });

  // ── B2: per-engine charsPerToken (token-pinned band on denser tokenizers) ──
  test('charsPerToken scales bandChars — denser tokenizer → tighter char band at the SAME token target', () => {
    // MiniMax-style denser ratio: same 100K-token steady state, fewer chars.
    const dense = resolveFoldBandBudgets(100_000, 3.4);
    expect(dense.bandTokens).toBe(100_000);
    expect(dense.bandChars).toBe(340_000); // 100_000 × 3.4
    expect(dense.fullRetentionChars).toBe(42_500); // 340_000 × 0.125
    expect(dense.essenceRetentionChars).toBe(85_000); // 340_000 × 0.25
    expect(dense.evictThresholdChars).toBe(18_700); // 340_000 × 0.055
    expect(dense.episodicBoundaryBudgetChars).toBe(1_700); // 340_000 × 0.005
  });

  test('charsPerToken defaults to 4 — omitted arg == passing 4, preserves the canonical band', () => {
    expect(resolveFoldBandBudgets(100_000)).toEqual(resolveFoldBandBudgets(100_000, 4));
    expect(resolveFoldBandBudgets(100_000, 4).bandChars).toBe(400_000);
  });

  test('resolveFoldConfigForBand threads charsPerToken into the scaled assistant-text budget', () => {
    const cfg = resolveFoldConfigForBand(100_000, 3.4);
    expect(cfg).not.toBe(ALWAYS_ON_FOLD_CONFIG);
    expect(cfg.assistantTextBudget?.fullRetentionChars).toBe(42_500);
    expect(cfg.assistantTextBudget?.essenceRetentionChars).toBe(85_000);
  });

  test('resolveFoldConfigForBand(undefined) uses the 100K default and threads charsPerToken', () => {
    const cfg = resolveFoldConfigForBand(undefined, 3.4);
    expect(cfg).not.toBe(ALWAYS_ON_FOLD_CONFIG);
    expect(cfg.assistantTextBudget?.fullRetentionChars).toBe(42_500);
    expect(cfg.assistantTextBudget?.essenceRetentionChars).toBe(85_000);
  });
});
