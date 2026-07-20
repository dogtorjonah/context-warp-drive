import { describe, expect, it } from 'vitest';

import {
  compileFoldReceipts,
  renderFoldReceipts,
  type FoldReceiptCounts,
} from '../src/foldReceipts.ts';
import type { FoldMessage } from '../src/rollingFold.ts';

// ── Window builders (Anthropic content-block format) ──

function toolUse(id: string, name: string, input: Record<string, unknown>, tsMs?: number): FoldMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
    ...(tsMs !== undefined ? { tsMs } : {}),
  };
}

function toolResult(id: string, text: string, opts: { isError?: boolean; tsMs?: number } = {}): FoldMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(opts.isError ? { is_error: true } : {}) }],
    ...(opts.tsMs !== undefined ? { tsMs: opts.tsMs } : {}),
  };
}

function assistantText(text: string): FoldMessage {
  return { role: 'assistant', content: text };
}

function totalitySum(c: FoldReceiptCounts): number {
  return c.edits + c.writes + c.bashMutations + c.testRuns + c.typechecks
    + c.gitOps + c.toolErrors + c.railOps + c.atlasCommits + c.spawns
    + c.lifecycleOps + c.chatroomPosts + c.claimEvents
    + c.readSearchEvents + c.navigationEvents + c.otherEvents;
}

const T1 = Date.UTC(2026, 6, 20, 8, 0, 0);
const T2 = Date.UTC(2026, 6, 20, 8, 5, 0);
const T3 = Date.UTC(2026, 6, 20, 8, 10, 0);

describe('compileFoldReceipts — receipt classes', () => {
  it('promotes edits with path identity and supersession', () => {
    const window: FoldMessage[] = [
      toolUse('e1', 'Edit', { file_path: '/home/jonah/repo/src/a.ts', old_string: 'foo\nbar', new_string: 'baz\nbar' }, T1),
      toolResult('e1', 'ok', { tsMs: T1 }),
      toolUse('e2', 'Edit', { file_path: '/home/jonah/repo/src/a.ts', old_string: 'x', new_string: 'y' }, T2),
      toolResult('e2', 'ok', { tsMs: T2 }),
      toolUse('e3', 'Edit', { file_path: '/home/jonah/repo/src/b.ts', old_string: 'p', new_string: 'q' }, T3),
      toolResult('e3', 'ok', { tsMs: T3 }),
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.edits).toBe(3);
    expect(c.receipts).toHaveLength(3);
    expect(c.receipts[0].superseded).toBe(true);
    expect(c.receipts[1].superseded).toBe(false);
    expect(c.receipts[2].superseded).toBe(false);
    expect(c.receipts[0].targetIdentity).toBe('src/a.ts');
    expect(c.receipts[0].text).toContain('✏️ src/a.ts');
    expect(c.receipts[0].sourceTimeMs).toBe(T1);
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('promotes writes and read-only bash aggregates separately', () => {
    const window: FoldMessage[] = [
      toolUse('w1', 'Write', { file_path: '/home/jonah/repo/src/new.ts', content: 'hello' }),
      toolResult('w1', 'ok'),
      toolUse('b1', 'Bash', { command: 'grep -rn foo src/' }),
      toolResult('b1', 'src/a.ts:1:foo'),
      toolUse('b2', 'Bash', { command: 'ls -la' }),
      toolResult('b2', 'total 4'),
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.writes).toBe(1);
    expect(c.counts.readSearchEvents).toBe(2);
    expect(c.aggregates).toHaveLength(1);
    expect(c.aggregates[0].lane).toBe('investigation');
    expect(c.aggregates[0].eventCount).toBe(2);
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('promotes mutating bash and detects test runs with counts', () => {
    const window: FoldMessage[] = [
      toolUse('m1', 'Bash', { command: 'npm install leftpad' }),
      toolResult('m1', 'added 1 package'),
      toolUse('t1', 'Bash', { command: 'npx vitest run src/foo.test.ts' }),
      toolResult('t1', ' Test Files  1 passed (1)\n      Tests  12 passed (12)\n'),
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.bashMutations).toBe(1);
    expect(c.counts.testRuns).toBe(1);
    const testReceipt = c.receipts.find(r => r.kind === 'test-run');
    expect(testReceipt?.text).toContain('🧪');
    expect(testReceipt?.text).toContain('Test Files  1 passed');
    expect(testReceipt?.text).toContain('Tests  12 passed');
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('detects failing test runs and failing names', () => {
    const window: FoldMessage[] = [
      toolUse('t1', 'run_bash', { command: 'npx vitest run a.test.ts' }),
      toolResult('t1', ' Test Files  1 failed (1)\n      Tests  2 failed | 3 passed (5)\n ✗ does the thing\n ✗ other case'),
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.testRuns).toBe(1);
    expect(c.receipts[0].text).toContain('failing: does the thing; other case');
  });

  it('detects typechecks via tsc command and forge tool', () => {
    const window: FoldMessage[] = [
      toolUse('c1', 'Bash', { command: 'npx tsc -p tsconfig.json --noEmit' }),
      toolResult('c1', 'src/a.ts(1,1): error TS2322: nope\nsrc/b.ts(2,3): error TS2345: nope'),
      toolUse('c2', 'mcp_forge_focused-typecheck__typecheck', { files: ['src/a.ts'] }),
      toolResult('c2', '{"ok":true,"status":"type_errors_found","error_count":3}'),
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.typechecks).toBe(2);
    expect(c.receipts[0].text).toContain('2 error(s)');
    expect(c.receipts[1].text).toContain('3 error(s)');
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('promotes tool errors via is_error blocks and error-opened text', () => {
    const window: FoldMessage[] = [
      toolUse('x1', 'grep_search', { pattern: 'foo' }),
      toolResult('x1', 'some error: mention in body is not an error'),
      toolUse('x2', 'read_file', { file_path: '/home/jonah/repo/src/nope.ts' }),
      toolResult('x2', 'Error: file not found', { isError: true }),
      toolUse('x3', 'Bash', { command: 'false' }),
      toolResult('x3', 'Error: Command failed with exit code 1'),
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.toolErrors).toBe(2);
    expect(c.counts.readSearchEvents).toBe(1);
    const errReceipts = c.receipts.filter(r => r.kind === 'tool-error');
    expect(errReceipts[0].text).toContain('⚠️ read_file');
    expect(errReceipts[0].text).toContain('Error: file not found');
    expect(errReceipts[1].text).toContain('⚠️ Bash');
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('aggregates claim bursts and counts events within them', () => {
    const window: FoldMessage[] = [
      toolUse('k1', 'partner_claim_file', { path: 'src/a.ts:1-20' }),
      toolResult('k1', 'granted'),
      toolUse('k2', 'partner_claim_file', { path: 'src/b.ts:5-9' }),
      toolResult('k2', 'granted'),
      toolUse('k3', 'partner_release_file', { path: 'src/a.ts' }),
      toolResult('k3', 'released'),
      toolUse('e1', 'Edit', { file_path: '/home/jonah/repo/src/a.ts', old_string: 'a', new_string: 'b' }),
      toolResult('e1', 'ok'),
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.claimEvents).toBe(3);
    expect(c.counts.claimBursts).toBe(1);
    expect(c.counts.edits).toBe(1);
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('promotes rail mutations, demotes rail reads to navigation', () => {
    const window: FoldMessage[] = [
      toolUse('r1', 'task_rail', { mode: 'shoot', acks: [{ step_id: 'step-1', ack_status: 'done' }] }),
      toolResult('r1', 'acknowledged'),
      toolUse('r2', 'task_rail', { mode: 'load', operation: 'update', step_id: 'step-2' }),
      toolResult('r2', 'updated'),
      toolUse('r3', 'task_rail', { mode: 'load', operation: 'status' }),
      toolResult('r3', 'status text'),
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.railOps).toBe(2);
    expect(c.counts.navigationEvents).toBe(1);
    expect(c.receipts[0].text).toContain('task_rail shoot');
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('promotes atlas commits, spawns, chatroom posts, git ops, lifecycle', () => {
    const window: FoldMessage[] = [
      toolUse('a1', 'atlas_commit', { file_path: 'src/a.ts', changelog_entry: 'did thing' }),
      toolResult('a1', 'committed'),
      toolUse('s1', 'spawn', { target: 'twin', fork_name: 'reviewer-1', engine: 'codex' }),
      toolResult('s1', 'spawned'),
      toolUse('l1', 'kill_instance', { target: 'reviewer-1' }),
      toolResult('l1', 'killed'),
      toolUse('c1', 'chatroom', { action: 'send', room: 'fold-lab', message: 'decision: ship it' }),
      toolResult('c1', 'sent'),
      toolUse('c2', 'chatroom', { action: 'read', room: 'fold-lab' }),
      toolResult('c2', 'messages...'),
      toolUse('g1', 'mcp_forge_safe-git__git_commit', { message: 'feat: thing', files: ['a.ts'] }),
      toolResult('g1', 'committed abc123'),
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.atlasCommits).toBe(1);
    expect(c.counts.spawns).toBe(1);
    expect(c.counts.lifecycleOps).toBe(1);
    expect(c.counts.chatroomPosts).toBe(1);
    expect(c.counts.gitOps).toBe(1);
    expect(c.counts.navigationEvents).toBe(1);
    expect(c.receipts.find(r => r.kind === 'spawn')?.text).toContain('🌱 spawn twin reviewer-1 (codex)');
    expect(c.receipts.find(r => r.kind === 'chatroom-post')?.text).toContain('💬 chatroom send fold-lab — "decision: ship it"');
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('counts prose turns separately from tool-call totality', () => {
    const window: FoldMessage[] = [
      assistantText('The fix is the classifier ordering because errors must win.'),
      toolUse('e1', 'Edit', { file_path: '/home/jonah/repo/src/a.ts', old_string: 'a', new_string: 'b' }),
      toolResult('e1', 'ok'),
      assistantText('Done.'),
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.proseTurns).toBe(2);
    expect(c.counts.totalToolCalls).toBe(1);
    expect(totalitySum(c.counts)).toBe(1);
  });
});

describe('compileFoldReceipts — provenance and determinism', () => {
  it('timestamp-less windows stay explicitly unknown and deterministic', () => {
    const window: FoldMessage[] = [
      toolUse('e1', 'Edit', { file_path: '/home/jonah/repo/src/a.ts', old_string: 'a', new_string: 'b' }),
      toolResult('e1', 'ok'),
    ];
    const first = compileFoldReceipts(window);
    const second = compileFoldReceipts(window);
    expect(first.receipts[0].sourceTimeMs).toBeNull();
    expect(renderFoldReceipts(first)).toEqual(renderFoldReceipts(second));
    // No timestamp anywhere in the window → no prefix spray.
    expect(renderFoldReceipts(first).join('\n')).not.toContain('[time unknown]');
  });

  it('mixed windows render [time unknown] only on timestampless receipts', () => {
    const window: FoldMessage[] = [
      toolUse('e1', 'Edit', { file_path: '/home/jonah/repo/src/a.ts', old_string: 'a', new_string: 'b' }, T1),
      toolResult('e1', 'ok', { tsMs: T1 }),
      toolUse('e2', 'Edit', { file_path: '/home/jonah/repo/src/b.ts', old_string: 'x', new_string: 'y' }),
      toolResult('e2', 'ok'),
    ];
    const lines = renderFoldReceipts(compileFoldReceipts(window));
    expect(lines.some(l => l.startsWith('[8:00 AM] ✏️ src/a.ts'))).toBe(true);
    expect(lines.some(l => l.startsWith('[time unknown] ✏️ src/b.ts'))).toBe(true);
  });

  it('receipts render chronologically by outcome message index', () => {
    const window: FoldMessage[] = [
      toolUse('b1', 'Bash', { command: 'grep foo' }),
      toolResult('b1', 'hit'),
      toolUse('e1', 'Edit', { file_path: '/home/jonah/repo/src/a.ts', old_string: 'a', new_string: 'b' }),
      toolResult('e1', 'ok'),
      toolUse('b2', 'Bash', { command: 'grep bar' }),
      toolResult('b2', 'hit2'),
    ];
    const lines = renderFoldReceipts(compileFoldReceipts(window));
    const invIdx = lines.findIndex(l => l.includes('investigation ×1'));
    const editIdx = lines.findIndex(l => l.includes('✏️ src/a.ts'));
    const inv2Idx = lines.findIndex(l => l.includes('queries: "grep bar"'));
    expect(invIdx).toBeGreaterThan(-1);
    expect(editIdx).toBeGreaterThan(invIdx);
    expect(inv2Idx).toBeGreaterThan(editIdx);
  });

  it('header exposes totality arithmetic', () => {
    const window: FoldMessage[] = [
      toolUse('e1', 'Edit', { file_path: '/home/jonah/repo/src/a.ts', old_string: 'a', new_string: 'b' }),
      toolResult('e1', 'ok'),
      toolUse('t1', 'Bash', { command: 'npx vitest run' }),
      toolResult('t1', 'Tests  5 passed (5)'),
      toolUse('x1', 'Bash', { command: 'false' }),
      toolResult('x3nevermatched', ''), // no matching call — ignored
      toolUse('g1', 'grep_search', { pattern: 'needle' }),
      toolResult('g1', 'src/a.ts:1:needle'),
    ];
    const lines = renderFoldReceipts(compileFoldReceipts(window));
    expect(lines[0]).toContain('[Fold receipts — 3 tool call(s): 1 edit(s) · 1 test run(s)');
    expect(lines[0]).toContain('aggregated: 1 read/search');
  });

  it('empty window compiles to a totality header with zero calls', () => {
    const c = compileFoldReceipts([]);
    expect(c.counts.totalToolCalls).toBe(0);
    expect(totalitySum(c.counts)).toBe(0);
    const lines = renderFoldReceipts(c);
    expect(lines[0]).toContain('0 tool call(s): none');
  });

  it('conserved literals are deduped and capped', () => {
    const window: FoldMessage[] = Array.from({ length: 30 }, (_, i) => [
      toolUse(`e${i}`, 'Edit', { file_path: `/home/jonah/repo/src/file${i}.ts`, old_string: 'a', new_string: 'b' }),
      toolResult(`e${i}`, `ok sha256: ${String(i).padStart(64, '0')}abcdef done`),
    ]).flat();
    const c = compileFoldReceipts(window, { literalCap: 5 });
    expect(c.conservedLiterals.length).toBeLessThanOrEqual(5);
    expect(new Set(c.conservedLiterals).size).toBe(c.conservedLiterals.length);
  });
});

describe('compileFoldReceipts — engine formats', () => {
  it('extracts OpenAI tool_calls format', () => {
    const window: FoldMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'o1', function: { name: 'Edit', arguments: JSON.stringify({ file_path: '/home/jonah/repo/src/a.ts', old_string: 'a', new_string: 'b' }) } }],
        tsMs: T1,
      },
      { role: 'tool', tool_call_id: 'o1', content: 'ok', tsMs: T2 },
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.edits).toBe(1);
    expect(c.receipts[0].messageIndex).toBe(1);
    expect(c.receipts[0].sourceTimeMs).toBe(T2);
  });

  it('extracts Gemini functionCall/functionResponse format', () => {
    const window: FoldMessage[] = [
      { role: 'model', content: null, parts: [{ functionCall: { id: 'g1', name: 'Write', args: { file_path: '/home/jonah/repo/src/g.ts', content: 'x' } } }] } as unknown as FoldMessage,
      { role: 'user', content: null, parts: [{ functionResponse: { id: 'g1', response: { result: 'ok' } } }], tsMs: T3 } as unknown as FoldMessage,
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.writes).toBe(1);
    expect(c.receipts[0].sourceTimeMs).toBe(T3);
  });
});
