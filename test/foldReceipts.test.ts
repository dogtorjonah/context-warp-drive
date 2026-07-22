import { describe, expect, it } from 'vitest';

import {
  compileFoldReceipts,
  buildArtifactModeBody,
  FOLD_ACTION_OUTCOMES,
  FOLD_CLAIM_LIFECYCLE_STATES,
  FOLD_DECISION_LIFECYCLE_STATES,
  FOLD_VALIDATION_FRESHNESS,
  renderFoldReceipts,
  type FoldActionOutcome,
  type FoldActionRecord,
  type FoldClaimRecord,
  type FoldDecisionRecord,
  type FoldReceiptCounts,
  type FoldValidationReceipt,
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

function toolResult(
  id: string,
  text: string,
  opts: { isError?: boolean; tsMs?: number; sourceIdentity?: string } = {},
): FoldMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(opts.isError ? { is_error: true } : {}) }],
    ...(opts.tsMs !== undefined ? { tsMs: opts.tsMs } : {}),
    ...(opts.sourceIdentity ? { sourceIdentity: opts.sourceIdentity } : {}),
  };
}

function assistantText(text: string): FoldMessage {
  return { role: 'assistant', content: text };
}

type TotalityCountKey = Exclude<
  keyof FoldReceiptCounts,
  'claimBursts' | 'otherToolCounts' | 'proseTurns' | 'totalToolCalls'
>;

// Record<> makes a newly added per-class count fail this test's typecheck until
// it is explicitly included in the totality sum (or classified as metadata).
const TOTALITY_COUNT_KEYS = Object.keys({
  edits: true,
  writes: true,
  bashMutations: true,
  testRuns: true,
  typechecks: true,
  gitOps: true,
  toolErrors: true,
  railOps: true,
  atlasCommits: true,
  spawns: true,
  lifecycleOps: true,
  chatroomPosts: true,
  actuators: true,
  claimEvents: true,
  decisionEvents: true,
  readEvents: true,
  searchEvents: true,
  navigationEvents: true,
  orchestrationEvents: true,
  otherEvents: true,
} satisfies Record<TotalityCountKey, true>) as TotalityCountKey[];

function totalitySum(c: FoldReceiptCounts): number {
  return TOTALITY_COUNT_KEYS.reduce((sum, key) => sum + c[key], 0);
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

  it('does not let an earlier applied edit supersede a later unresolved edit', () => {
    const path = '/home/jonah/repo/src/a.ts';
    const laterPending = compileFoldReceipts([
      toolUse('e1', 'Edit', { file_path: path, old_string: 'a', new_string: 'b' }),
      toolResult('e1', 'ok'),
      toolUse('e2', 'Edit', { file_path: path, old_string: 'b', new_string: 'c' }),
    ]).receipts;
    const applied = laterPending.find(r => r.recordType === 'action' && r.toolCallId === 'e1');
    const unresolved = laterPending.find(r => r.recordType === 'action' && r.toolCallId === 'e2');
    expect(applied).toMatchObject({ outcome: 'applied', superseded: false });
    expect(unresolved).toMatchObject({ outcome: 'unknown', reconciliationRequired: true, superseded: false });

    const earlierPending = compileFoldReceipts([
      toolUse('e1', 'Edit', { file_path: path, old_string: 'a', new_string: 'b' }),
      toolUse('e2', 'Edit', { file_path: path, old_string: 'b', new_string: 'c' }),
      toolResult('e2', 'ok'),
    ]).receipts;
    expect(earlierPending.find(r => r.recordType === 'action' && r.toolCallId === 'e1'))
      .toMatchObject({ outcome: 'unknown', superseded: true });
  });

  it('promotes writes and splits read-only shell reads from searches', () => {
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
    expect(c.counts.readEvents).toBe(1);
    expect(c.counts.searchEvents).toBe(1);
    expect(c.aggregates).toHaveLength(2);
    expect(c.aggregates.map(a => a.lane)).toEqual(['search', 'read']);
    expect(c.aggregates.every(a => a.eventCount === 1)).toBe(true);
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

  it('binds a validation result to stable artifact hashes and renders fresh only on an explicit current match', () => {
    const hash = `sha256:${'a'.repeat(64)}`;
    const path = '/repo/src/a.test.ts';
    const window: FoldMessage[] = [
      // Real Forge results attest canonical absolute paths even when the call
      // used a relative file argument; this must remain one artifact, not two.
      toolUse('v1', 'run_tests', { files: ['src/a.test.ts'] }, T1),
      toolResult('v1', JSON.stringify({
        ok: true,
        status: 'tests_passed',
        scope: 'test-files',
        artifact_hashes: [{
          path,
          algorithm: 'sha256',
          content_hash: hash,
          stable_during_validation: true,
        }],
      }), { tsMs: T2, sourceIdentity: 'validation-result-v1' }),
    ];

    const compiled = compileFoldReceipts(window, { currentArtifactHashes: { [path]: hash } });
    expect(FOLD_VALIDATION_FRESHNESS).toEqual(['fresh', 'stale', 'unknown']);
    const receipt = compiled.receipts[0] as FoldValidationReceipt;
    expect(receipt).toMatchObject({
      recordType: 'validation',
      kind: 'test-run',
      scope: 'test-files',
      freshness: 'fresh',
      freshnessReason: null,
      artifacts: [{
        path,
        validatedContentHash: hash,
        currentContentHash: hash,
        freshness: 'fresh',
        freshnessReason: null,
      }],
    });
    const rendered = renderFoldReceipts(compiled).join('\n');
    expect(rendered).toContain('✅ VALIDATION freshness=fresh scope="test-files"');
    expect(rendered).toContain(`"${path}"@${hash}[current-match]`);
  });

  it('marks a hash mismatch stale with an exact reason and both byte identities', () => {
    const validatedHash = `sha256:${'a'.repeat(64)}`;
    const currentHash = `sha256:${'b'.repeat(64)}`;
    const path = '/repo/src/a.ts';
    const window: FoldMessage[] = [
      toolUse('v2', 'typecheck', { files: [path] }, T1),
      toolResult('v2', JSON.stringify({
        ok: true,
        status: 'clean',
        scope: 'files+imports',
        artifact_hashes: [{ path, content_hash: validatedHash, stable_during_validation: true }],
      }), { tsMs: T2 }),
    ];

    const compiled = compileFoldReceipts(window, { currentArtifactHashes: { [path]: currentHash } });
    const receipt = compiled.receipts[0] as FoldValidationReceipt;
    expect(receipt.freshness).toBe('stale');
    expect(receipt.freshnessReason).toBe('content-hash-mismatch');
    expect(receipt.artifacts[0]).toMatchObject({
      path,
      validatedContentHash: validatedHash,
      currentContentHash: currentHash,
      freshness: 'stale',
      freshnessReason: 'content-hash-mismatch',
    });
    const rendered = renderFoldReceipts(compiled).join('\n');
    expect(rendered).toContain('⚠️ VALIDATION freshness=stale reason=content-hash-mismatch');
    expect(rendered).toContain(`${validatedHash}[current=${currentHash}]`);
  });

  it('does not drop validated files omitted from a partial attestation list', () => {
    const hash = `sha256:${'d'.repeat(64)}`;
    const paths = ['/repo/src/a.ts', '/repo/src/b.ts'];
    const compiled = compileFoldReceipts([
      toolUse('partial-validation', 'typecheck', { files: paths }, T1),
      toolResult('partial-validation', JSON.stringify({
        ok: true,
        status: 'clean',
        scope: 'files+imports',
        files_checked: paths,
        artifact_hashes: [{
          path: paths[0],
          content_hash: hash,
          stable_during_validation: true,
        }],
      }), { tsMs: T2 }),
    ], { currentArtifactHashes: { [paths[0]]: hash, [paths[1]]: hash } });

    const receipt = compiled.receipts[0] as FoldValidationReceipt;
    expect(receipt).toMatchObject({
      freshness: 'unknown',
      freshnessReason: 'validation-hash-missing',
    });
    expect(receipt.artifacts).toHaveLength(2);
    expect(receipt.artifacts[1]).toMatchObject({
      path: paths[1],
      validatedContentHash: null,
      freshness: 'unknown',
      freshnessReason: 'validation-hash-missing',
    });
  });

  it('never claims freshness when any path, validation hash, current hash, or stable-run attestation is missing', () => {
    const hash = `sha256:${'c'.repeat(64)}`;
    const cases: Array<{
      name: string;
      result: Record<string, unknown>;
      currentArtifactHashes?: Record<string, string>;
      reason: FoldValidationReceipt['freshnessReason'];
    }> = [
      {
        name: 'no artifact path',
        result: { ok: true, status: 'clean', scope: 'files+imports' },
        reason: 'validated-artifact-path-missing',
      },
      {
        name: 'no validation hash',
        result: { ok: true, status: 'clean', artifact_hashes: [{ path: '/repo/a.ts', stable_during_validation: true }] },
        currentArtifactHashes: { '/repo/a.ts': hash },
        reason: 'validation-hash-missing',
      },
      {
        name: 'no current hash',
        result: { ok: true, status: 'clean', artifact_hashes: [{ path: '/repo/a.ts', content_hash: hash, stable_during_validation: true }] },
        reason: 'current-hash-missing',
      },
      {
        name: 'bytes changed during validation',
        result: { ok: true, status: 'clean', artifact_hashes: [{ path: '/repo/a.ts', content_hash: hash, stable_during_validation: false }] },
        currentArtifactHashes: { '/repo/a.ts': hash },
        reason: 'content-changed-during-validation',
      },
      {
        name: 'no stability attestation',
        result: { ok: true, status: 'clean', artifact_hashes: [{ path: '/repo/a.ts', content_hash: hash }] },
        currentArtifactHashes: { '/repo/a.ts': hash },
        reason: 'validation-hash-missing',
      },
      {
        name: 'contradictory unavailable attestation',
        result: { ok: true, status: 'clean', artifact_hashes: [{ path: '/repo/a.ts', content_hash: hash, stable_during_validation: true, reason: 'content-unavailable' }] },
        currentArtifactHashes: { '/repo/a.ts': hash },
        reason: 'validation-hash-missing',
      },
    ];

    for (const testCase of cases) {
      const compiled = compileFoldReceipts([
        toolUse(`call-${testCase.name}`, 'typecheck', {}, T1),
        toolResult(`call-${testCase.name}`, JSON.stringify(testCase.result), { tsMs: T2 }),
      ], { currentArtifactHashes: testCase.currentArtifactHashes });
      const receipt = compiled.receipts[0] as FoldValidationReceipt;
      expect(receipt.freshness, testCase.name).toBe('unknown');
      expect(receipt.freshnessReason, testCase.name).toBe(testCase.reason);
      const rendered = renderFoldReceipts(compiled).join('\n');
      expect(rendered, testCase.name).toContain(`VALIDATION freshness=unknown reason=${testCase.reason}`);
      expect(rendered, testCase.name).not.toContain('VALIDATION freshness=fresh');
    }
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
    expect(c.counts.searchEvents).toBe(1);
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
      toolUse('r1', 'task_rail', { mode: 'shoot', acks: [{ step_id: 'step-1', ack_status: 'done' }] }, T1),
      toolResult('r1', 'acknowledged', { tsMs: T2, sourceIdentity: 'rail-ack-result-1' }),
      toolUse('r2', 'task_rail', { mode: 'load', operation: 'update', step_id: 'step-2' }),
      toolResult('r2', 'updated'),
      toolUse('r3', 'task_rail', { mode: 'load', operation: 'status' }),
      toolResult('r3', 'status text'),
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.railOps).toBe(2);
    expect(c.counts.navigationEvents).toBe(1);
    expect(c.receipts[0].text).toContain('task_rail shoot');
    expect(c.receipts[0].sourceTimeMs).toBe(T2);
    expect(c.receipts[0].sourceIdentity).toBe('rail-ack-result-1');
    expect(renderFoldReceipts(c).join('\n')).toContain('📋 task_rail shoot');
    expect(renderFoldReceipts(c).join('\n')).toContain('↞ source=rail-ack-result-1');
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

  it('classifies orchestration and names every otherwise unknown tool', () => {
    const window: FoldMessage[] = [
      toolUse('o1', 'functions.exec', { source: 'await tools.forge_call()' }),
      toolResult('o1', 'ok'),
      toolUse('u1', 'mystery_probe', { query: 'first' }),
      toolResult('u1', 'one'),
      toolUse('u2', 'mystery_probe', { query: 'second' }),
      toolResult('u2', 'two'),
      toolUse('u3', 'second_probe', {}),
      toolResult('u3', 'three'),
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.orchestrationEvents).toBe(1);
    expect(c.counts.otherEvents).toBe(3);
    expect(c.counts.otherToolCounts).toEqual([
      { name: 'mystery_probe', count: 2 },
      { name: 'second_probe', count: 1 },
    ]);
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
    const rendered = renderFoldReceipts(c).join('\n');
    expect(rendered).toContain('1 orchestration');
    expect(rendered).toContain('3 named tool call(s) (mystery_probe ×2 · second_probe ×1)');
    expect(rendered).toContain('🔧 tools: mystery_probe ×2 · second_probe ×1');
    expect(rendered).not.toContain(' other');
  });

  it('unwraps forge_call targets before semantic classification', () => {
    const window: FoldMessage[] = [
      toolUse('f1', 'forge_call', {
        full_name: 'mcp_forge_scoped-vitest__run_tests',
        args: { files: ['src/a.test.ts'] },
      }),
      toolResult('f1', 'Test Files  1 passed (1)\nTests  4 passed (4)'),
      toolUse('f2', 'forge_call', {
        server: 'focused-typecheck',
        tool: 'typecheck',
        args: { files: ['src/a.ts'] },
      }),
      toolResult('f2', '{"ok":true,"status":"clean","error_count":0}'),
      toolUse('f3', 'forge_call', {
        full_name: 'safe-git/git_commit',
        args: { message: 'fix: preserve semantics' },
      }),
      toolResult('f3', 'committed abc123'),
      toolUse('f4', 'forge_call', { args: { query: 'transport only' } }),
      toolResult('f4', 'ok'),
      toolUse('f5', 'forge_call', {
        full_name: 'mcp_forge_custom-tools__mystery_probe',
        args: { query: 'exact identity' },
      }),
      toolResult('f5', 'ok'),
    ];

    const c = compileFoldReceipts(window);
    expect(c.counts.testRuns).toBe(1);
    expect(c.counts.typechecks).toBe(1);
    expect(c.counts.gitOps).toBe(1);
    expect(c.counts.orchestrationEvents).toBe(1);
    expect(c.counts.otherEvents).toBe(1);
    expect(c.counts.otherToolCounts).toEqual([
      { name: 'mcp_forge_custom-tools__mystery_probe', count: 1 },
    ]);
    expect(c.receipts.map((receipt) => receipt.kind)).toEqual(['test-run', 'typecheck', 'git-op']);
    expect(renderFoldReceipts(c).join('\n')).toContain('mcp_forge_custom-tools__mystery_probe ×1');
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('counts special unknown names with prototype-safe first-seen ordering', () => {
    const names = ['__proto__', 'constructor', '2', '10', '__proto__'];
    const window: FoldMessage[] = names.flatMap((name, index) => [
      toolUse(`special-${index}`, name, {}),
      toolResult(`special-${index}`, 'ok'),
    ]);
    const c = compileFoldReceipts(window);

    const expected = [
      { name: '__proto__', count: 2 },
      { name: 'constructor', count: 1 },
      { name: '2', count: 1 },
      { name: '10', count: 1 },
    ];
    expect(c.counts.otherToolCounts).toEqual(expected);
    expect(c.aggregates[0]?.toolCounts).toEqual(expected);
    const rendered = renderFoldReceipts(c).join('\n');
    expect(rendered).toContain('__proto__ ×2 · constructor ×1 · 2 ×1 · 10 ×1');
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('normalizes MCP providers containing underscores before classification', () => {
    const window: FoldMessage[] = [
      toolUse('f1', 'mcp__voxxo_swarm_bridge__forge_list', {}),
      toolResult('f1', 'servers'),
      toolUse('r1', 'mcp__voxxo_swarm_bridge__read_file', { file_path: 'src/a.ts' }),
      toolResult('r1', 'contents'),
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.searchEvents).toBe(1);
    expect(c.counts.readEvents).toBe(1);
    expect(c.counts.otherEvents).toBe(0);
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });
});

describe('compileFoldReceipts — typed durable action records', () => {
  it('has exactly applied, failed, and unknown outcome states', () => {
    const exhaustive = {
      applied: true,
      failed: true,
      unknown: true,
    } satisfies Record<FoldActionOutcome, true>;
    expect(FOLD_ACTION_OUTCOMES).toEqual(Object.keys(exhaustive));
    expect(FOLD_CLAIM_LIFECYCLE_STATES).toEqual([
      'active', 'released', 'superseded', 'failed', 'unknown',
    ]);
    expect(FOLD_DECISION_LIFECYCLE_STATES).toEqual([
      'current', 'superseded', 'failed', 'unknown',
    ]);
  });

  it('classifies applied, failed, interrupted, and pending mutations without guessing', () => {
    const window: FoldMessage[] = [
      toolUse('applied-edit', 'Edit', { file_path: '/repo/src/applied.ts', old_string: 'a', new_string: 'b' }, T1),
      toolResult('applied-edit', 'modified: /repo/src/applied.ts', { tsMs: T2 }),
      toolUse('failed-edit', 'Edit', { file_path: '/repo/src/failed.ts', old_string: 'x', new_string: 'y' }, T1),
      toolResult('failed-edit', 'Error: old_string was not found', { isError: true, tsMs: T2 }),
      toolUse('interrupted-edit', 'Edit', { file_path: '/repo/src/interrupted.ts', old_string: 'p', new_string: 'q' }, T1),
      toolResult('interrupted-edit', '[Request interrupted by user for tool use]', { tsMs: T2 }),
      toolUse('pending-edit', 'Edit', { file_path: '/home/jonah/repo/src/pending.ts', old_string: 'm', new_string: 'n' }, T1),
    ];

    const compiled = compileFoldReceipts(window);
    const actions = compiled.receipts.filter(
      (receipt): receipt is FoldActionRecord => receipt.recordType === 'action',
    );
    expect(actions.map(({ outcome }) => outcome)).toEqual([
      'applied', 'failed', 'unknown', 'unknown',
    ]);
    expect(actions.map(({ reconciliationRequired }) => reconciliationRequired)).toEqual([
      false, false, true, true,
    ]);
    expect(actions.find(({ toolCallId }) => toolCallId === 'interrupted-edit')?.outcome).toBe('unknown');
    expect(actions.find(({ toolCallId }) => toolCallId === 'pending-edit')?.sourceTimeMs).toBeNull();
    expect(compiled.counts.edits).toBe(4);
    expect(compiled.counts.toolErrors).toBe(0);
    expect(totalitySum(compiled.counts)).toBe(compiled.counts.totalToolCalls);
  });

  it('promotes acquire/release attempts into typed action outcomes', () => {
    const compiled = compileFoldReceipts([
      toolUse('claim-applied', 'partner_claim_file', {
        claims: [
          { path: 'src/a.ts:1-20', claim_intent: 'edit' },
          { path: 'src/b.ts:4-9', claim_intent: 'edit' },
        ],
      }, T1),
      toolResult(
        'claim-applied',
        'Claim batch: 2/2 granted.\n\n[granted] src/a.ts:1-20\n\n[granted] src/b.ts:4-9',
        { tsMs: T2 },
      ),
      toolUse('release-failed', 'partner_release_file', { path: 'src/b.ts' }, T1),
      toolResult('release-failed', 'Error: claim is not held', { isError: true, tsMs: T2 }),
      toolUse('claim-pending', 'partner_claim_file', { path: 'src/c.ts:4-9' }, T1),
    ]);
    const claims = compiled.receipts.filter(
      (receipt): receipt is FoldClaimRecord => receipt.recordType === 'claim',
    );
    expect(claims.map(({ lifecycleState, outcome, reconciliationRequired }) => ({
      lifecycleState, outcome, reconciliationRequired,
    }))).toEqual([
      { lifecycleState: 'active', outcome: 'applied', reconciliationRequired: false },
      { lifecycleState: 'active', outcome: 'applied', reconciliationRequired: false },
      { lifecycleState: 'failed', outcome: 'failed', reconciliationRequired: false },
      { lifecycleState: 'unknown', outcome: 'unknown', reconciliationRequired: true },
    ]);
    expect(compiled.counts.claimEvents).toBe(3);
    expect(compiled.counts.claimBursts).toBe(1);
    expect(claims.map(({ subject, range }) => ({ subject, range }))).toEqual([
      { subject: 'src/a.ts', range: '1-20' },
      { subject: 'src/b.ts', range: '4-9' },
      { subject: 'src/b.ts', range: null },
      { subject: 'src/c.ts', range: '4-9' },
    ]);
    const rendered = renderFoldReceipts(compiled).join('\n');
    expect(rendered).toContain('CLAIM operation=acquire state=active outcome=applied');
    expect(rendered).toContain('subject="src/a.ts" range="1-20" holder="unknown"');
    expect(rendered).toContain('RECONCILIATION REQUIRED · CLAIM operation=acquire state=unknown');
    expect(totalitySum(compiled.counts)).toBe(compiled.counts.totalToolCalls);
  });

  it('keeps partial claim batches and string-only claim failures honest', () => {
    const compiled = compileFoldReceipts([
      toolUse('claim-partial', 'partner_claim_file', {
        claims: [
          { path: 'src/a.ts', range: '1-20' },
          { path: 'src/b.ts', range: '4-9' },
        ],
      }),
      toolResult(
        'claim-partial',
        'Claim batch: 1/2 granted.\n\n[granted] src/a.ts:1-20\nClaimed\n\n[not granted] src/b.ts:4-9\nCONFLICT',
      ),
      toolUse('claim-conflict', 'partner_claim_file', { path: 'src/c.ts:1-9' }),
      toolResult('claim-conflict', 'CONFLICT: another agent already claimed src/c.ts:1-9'),
      toolUse('release-noop', 'partner_release_file', { path: 'src/d.ts' }),
      toolResult('release-noop', 'No claim on src/d.ts'),
    ]);

    const claims = compiled.receipts.filter(
      (receipt): receipt is FoldClaimRecord => receipt.recordType === 'claim',
    );
    expect(claims.map(({ targetIdentity, outcome, reconciliationRequired }) => ({
      targetIdentity, outcome, reconciliationRequired,
    }))).toEqual([
      { targetIdentity: 'src/a.ts:1-20', outcome: 'applied', reconciliationRequired: false },
      { targetIdentity: 'src/b.ts:4-9', outcome: 'failed', reconciliationRequired: false },
      { targetIdentity: 'src/c.ts:1-9', outcome: 'failed', reconciliationRequired: false },
      { targetIdentity: 'src/d.ts', outcome: 'failed', reconciliationRequired: false },
    ]);
  });

  it('normalizes claim ranges once and ignores malformed range metadata', () => {
    const compiled = compileFoldReceipts([
      toolUse('claim-ranges', 'partner_claim_file', {
        claims: [
          { path: 'src/a.ts:1-20', range: '1-20' },
          { path: 'src/b.ts', range: ':30-40' },
          { path: 'src/c.ts', range: 'not-a-range' },
        ],
      }),
      toolResult('claim-ranges', 'Claim batch: 3/3 granted.'),
    ]);
    expect(compiled.receipts).toMatchObject([
      { targetIdentity: 'src/a.ts:1-20', recordType: 'claim', outcome: 'applied' },
      { targetIdentity: 'src/b.ts:30-40', recordType: 'claim', outcome: 'applied' },
      { targetIdentity: 'src/c.ts', recordType: 'claim', outcome: 'applied' },
    ]);
  });

  it('terminalizes only applied claim evidence and never aliases malformed subjects', () => {
    const compiled = compileFoldReceipts([
      toolUse('claim-first', 'partner_claim_file', { path: 'src/a.ts:1-20', holder: 'agent-a' }),
      toolResult('claim-first', 'Claimed src/a.ts:1-20'),
      toolUse('claim-second', 'partner_claim_file', { path: 'src/a.ts:1-20', holder: 'agent-b' }),
      toolResult('claim-second', 'Claimed src/a.ts:1-20'),
      toolUse('release', 'partner_release_file', { path: 'src/a.ts' }),
      toolResult('release', 'Released src/a.ts'),
      toolUse('unknown-a', 'partner_claim_file', {}),
      toolResult('unknown-a', 'Claimed'),
      toolUse('unknown-b', 'partner_claim_file', {}),
      toolResult('unknown-b', 'Claimed'),
    ]);
    const claims = compiled.receipts.filter(
      (receipt): receipt is FoldClaimRecord => receipt.recordType === 'claim',
    );
    expect(claims.map(({ lifecycleState, terminalizedByIdentity }) => ({
      lifecycleState, terminalizedByIdentity,
    }))).toEqual([
      { lifecycleState: 'superseded', terminalizedByIdentity: 'tool-call:claim-second' },
      { lifecycleState: 'released', terminalizedByIdentity: 'tool-call:release' },
      { lifecycleState: 'released', terminalizedByIdentity: null },
      { lifecycleState: 'active', terminalizedByIdentity: null },
      { lifecycleState: 'active', terminalizedByIdentity: null },
    ]);
  });

  it('uses target detail instead of over-claiming an all-granted batch summary', () => {
    const compiled = compileFoldReceipts([
      toolUse('claim-contradiction', 'partner_claim_file', {
        claims: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      }),
      toolResult(
        'claim-contradiction',
        'Claim batch: 2/2 granted.\n[granted] src/a.ts\n[not granted] src/b.ts CONFLICT',
      ),
    ]);
    const claims = compiled.receipts.filter(
      (receipt): receipt is FoldClaimRecord => receipt.recordType === 'claim',
    );
    expect(claims.map(({ targetIdentity, outcome }) => ({ targetIdentity, outcome }))).toEqual([
      { targetIdentity: 'src/a.ts', outcome: 'applied' },
      { targetIdentity: 'src/b.ts', outcome: 'failed' },
    ]);
  });

  it('does not smear outcomes across path-prefix sibling claims', () => {
    const compiled = compileFoldReceipts([
      toolUse('claim-prefixes', 'partner_claim_file', {
        claims: [{ path: 'src/a.ts' }, { path: 'src/a.tsx' }],
      }),
      toolResult(
        'claim-prefixes',
        'Claim batch: 1/2 granted.\n[not granted] src/a.ts CONFLICT\n[granted] src/a.tsx',
      ),
    ]);
    const claims = compiled.receipts.filter(
      (receipt): receipt is FoldClaimRecord => receipt.recordType === 'claim',
    );
    expect(claims.map(({ targetIdentity, outcome }) => ({ targetIdentity, outcome }))).toEqual([
      { targetIdentity: 'src/a.ts', outcome: 'failed' },
      { targetIdentity: 'src/a.tsx', outcome: 'applied' },
    ]);
  });

  it('emits decision pointers once, derives lifecycle, and rejects non-pin actions', () => {
    const window: FoldMessage[] = [
      toolUse('decision-1', 'tap_star', {
        category: 'decision', note: 'Subject: storage\nUse SQLite', holder: 'agent-a',
      }),
      toolResult('decision-1', 'Pinned', { sourceIdentity: 'decision-row-1' }),
      toolUse('decision-2', 'tap_star', {
        category: 'decision', note: 'Subject: storage\nUse Postgres', supersedes: 'decision-row-1',
      }),
      toolResult('decision-2', 'Pinned', { sourceIdentity: 'decision-row-2' }),
      toolUse('decision-pending', 'tap_star', {
        category: 'decision', note: 'Subject: caching\nUse Redis',
      }),
      toolUse('decision-harvest', 'tap_star', {
        action: 'harvest', category: 'decision', note: 'Not a new pointer',
      }),
      toolResult('decision-harvest', '[]'),
    ];
    const compiled = compileFoldReceipts(window);
    const decisions = compiled.receipts.filter(
      (receipt): receipt is FoldDecisionRecord => receipt.recordType === 'decision',
    );
    expect(decisions.map(({ decisionId, lifecycleState, supersededByIdentity }) => ({
      decisionId, lifecycleState, supersededByIdentity,
    }))).toEqual([
      { decisionId: 'decision-row-1', lifecycleState: 'superseded', supersededByIdentity: 'decision-row-2' },
      { decisionId: 'decision-row-2', lifecycleState: 'current', supersededByIdentity: null },
      { decisionId: 'tool-call:decision-pending', lifecycleState: 'unknown', supersededByIdentity: null },
    ]);
    expect(compiled.counts.decisionEvents).toBe(3);
    expect(compiled.counts.navigationEvents).toBe(1);
    expect(totalitySum(compiled.counts)).toBe(compiled.counts.totalToolCalls);
    const rendered = renderFoldReceipts(compiled).join('\n');
    expect(rendered).toContain('DECISION state=current outcome=applied');
    expect(rendered).toContain('subject="storage" subject-explicit=true');
    expect(rendered).toContain('authority=recorded-pointer');
    expect(buildArtifactModeBody(window).bodyLines.join('\n').match(/Use Postgres/g)).toHaveLength(1);
  });

  it('counts pending and completed claims in raw-order bursts', () => {
    const compiled = compileFoldReceipts([
      toolUse('claim-pending', 'partner_claim_file', { path: 'src/a.ts:1-20' }),
      toolUse('claim-applied', 'partner_claim_file', { path: 'src/b.ts:1-20' }),
      toolResult('claim-applied', 'Claimed src/b.ts:1-20'),
      toolUse('edit-applied', 'Edit', { file_path: '/home/jonah/repo/src/a.ts', old_string: 'a', new_string: 'b' }),
      toolResult('edit-applied', 'modified'),
    ]);
    expect(compiled.counts.claimEvents).toBe(2);
    expect(compiled.counts.claimBursts).toBe(1);
    expect(compiled.receipts.map((receipt) => receipt.kind)).toEqual(['claim-op', 'claim-op', 'edit']);
  });

  it('derives released and superseded claim terminals only from applied evidence', () => {
    const compiled = compileFoldReceipts([
      toolUse('claim-old', 'partner_claim_file', {
        path: 'src/owned.ts:10-30', holder: 'worker-a',
      }, T1),
      toolResult('claim-old', '[granted] src/owned.ts:10-30', { tsMs: T2, sourceIdentity: 'claim-row-old' }),
      toolUse('claim-new', 'partner_claim_file', {
        path: 'src/owned.ts:10-30', holder: 'worker-b',
      }, T2),
      toolResult('claim-new', '[granted] src/owned.ts:10-30', { tsMs: T2, sourceIdentity: 'claim-row-new' }),
      toolUse('claim-release', 'partner_release_file', { path: 'src/owned.ts' }, T2),
      toolResult('claim-release', 'Released 1 claim(s) on src/owned.ts', {
        tsMs: T3, sourceIdentity: 'claim-row-release',
      }),
    ]);
    const claims = compiled.receipts.filter(
      (receipt): receipt is FoldClaimRecord => receipt.recordType === 'claim',
    );
    expect(claims.map(({ claimId, lifecycleState, terminalizedByIdentity }) => ({
      claimId, lifecycleState, terminalizedByIdentity,
    }))).toEqual([
      {
        claimId: 'claim-row-old',
        lifecycleState: 'superseded',
        terminalizedByIdentity: 'claim-row-new',
      },
      {
        claimId: 'claim-row-new',
        lifecycleState: 'released',
        terminalizedByIdentity: 'claim-row-release',
      },
      {
        claimId: 'claim-row-release',
        lifecycleState: 'released',
        terminalizedByIdentity: null,
      },
    ]);
    const rendered = renderFoldReceipts(compiled).join('\n');
    expect(rendered).toContain('state=superseded outcome=applied');
    expect(rendered).toContain('holder="worker-a" claim-id="claim-row-old" terminalized-by="claim-row-new"');
    expect(rendered).toContain('state=released outcome=applied');
  });

  it('records decisions with explicit identity and refuses unknown supersession', () => {
    const firstAndUnknown: FoldMessage[] = [
      toolUse('decision-old', 'tap_star', {
        action: 'pin', category: 'decision',
        note: 'subject: fold-policy\nKeep typed rows in overlay artifacts.',
        range: '20-40', holder: 'architect-a',
      }, T1),
      toolResult('decision-old', 'Pinned', { tsMs: T2, sourceIdentity: 'decision-row-old' }),
      toolUse('decision-pending', 'tap_star', {
        action: 'pin', category: 'decision',
        note: 'subject: fold-policy\nMaybe replace typed rows.',
      }, T2),
    ];
    const beforeAppliedSuccessor = compileFoldReceipts(firstAndUnknown).receipts.filter(
      (receipt): receipt is FoldDecisionRecord => receipt.recordType === 'decision',
    );
    expect(beforeAppliedSuccessor.map(({ lifecycleState }) => lifecycleState)).toEqual([
      'current', 'unknown',
    ]);

    const compiled = compileFoldReceipts([
      ...firstAndUnknown,
      toolUse('decision-new', 'tap_star', {
        action: 'pin', category: 'decision',
        note: 'subject: fold-policy\nUse typed overlay rows.\nsupersedes: decision-row-old',
      }, T2),
      toolResult('decision-new', 'Pinned', { tsMs: T3, sourceIdentity: 'decision-row-new' }),
    ]);
    const decisions = compiled.receipts.filter(
      (receipt): receipt is FoldDecisionRecord => receipt.recordType === 'decision',
    );
    expect(decisions.map(({ decisionId, lifecycleState, supersededByIdentity }) => ({
      decisionId, lifecycleState, supersededByIdentity,
    }))).toEqual([
      {
        decisionId: 'decision-row-old',
        lifecycleState: 'superseded',
        supersededByIdentity: 'decision-row-new',
      },
      {
        decisionId: 'tool-call:decision-pending',
        lifecycleState: 'unknown',
        supersededByIdentity: null,
      },
      {
        decisionId: 'decision-row-new',
        lifecycleState: 'current',
        supersededByIdentity: null,
      },
    ]);
    expect(decisions[0]).toMatchObject({
      subject: 'fold-policy', range: '20-40', holder: 'architect-a', authority: 'recorded-pointer',
    });
    const rendered = renderFoldReceipts(compiled).join('\n');
    expect(rendered).toContain('DECISION state=superseded outcome=applied');
    expect(rendered).toContain('decision-id="decision-row-old" superseded-by="decision-row-new"');
    expect(rendered).toContain('RECONCILIATION REQUIRED · DECISION state=unknown outcome=unknown');
    expect(rendered).toContain('DECISION state=current outcome=applied');
    expect(compiled.counts.decisionEvents).toBe(3);
    expect(totalitySum(compiled.counts)).toBe(compiled.counts.totalToolCalls);
  });

  it('renders a categorized decision once in a fold artifact with identity intact', () => {
    const statement = 'Bind rebirth decisions to stable source identity.';
    const { bodyLines } = buildArtifactModeBody([
      toolUse('decision-fold', 'tap_star', {
        action: 'pin', category: 'decision', note: `subject: rebirth-policy\n${statement}`,
      }, T1),
      toolResult('decision-fold', 'Pinned', { tsMs: T2, sourceIdentity: 'decision-fold-row' }),
    ]);
    const body = bodyLines.join('\n');
    expect(body).toContain('DECISION state=current outcome=applied');
    expect(body).toContain('decision-id="decision-fold-row"');
    expect(body.split(statement).length - 1).toBe(1);
  });

  it('renders reconciliation-required actions above ordinary receipts byte-stably', () => {
    const window: FoldMessage[] = [
      toolUse('applied-edit', 'Edit', { file_path: '/repo/src/applied.ts', old_string: 'a', new_string: 'b' }, T1),
      toolResult('applied-edit', 'modified: /repo/src/applied.ts', { tsMs: T2 }),
      toolUse('read-1', 'read_file', { file_path: '/repo/src/read.ts' }, T1),
      toolResult('read-1', 'contents', { tsMs: T2 }),
      toolUse('pending-edit', 'Edit', { file_path: '/home/jonah/repo/src/pending.ts', old_string: 'm', new_string: 'n' }, T1),
    ];
    const first = renderFoldReceipts(compileFoldReceipts(window));
    const second = renderFoldReceipts(compileFoldReceipts(window));
    expect(first).toEqual(second);

    const reconcileIndex = first.findIndex((line) => line.includes('RECONCILIATION REQUIRED'));
    const appliedIndex = first.findIndex((line) => line.includes('outcome=applied'));
    const aggregateIndex = first.findIndex((line) => line.includes('reads ×1'));
    expect(reconcileIndex).toBeGreaterThan(0);
    expect(reconcileIndex).toBeLessThan(appliedIndex);
    expect(reconcileIndex).toBeLessThan(aggregateIndex);
    expect(first[reconcileIndex]).toContain(
      'ACTION kind=edit outcome=unknown reconciliation-required=true target="src/pending.ts"',
    );
    expect(first[reconcileIndex]).not.toContain('outcome=applied');
  });
});

describe('typed claim and decision vocabularies', () => {
  it('stay closed and explicit', () => {
    expect(FOLD_CLAIM_LIFECYCLE_STATES).toEqual([
      'active', 'released', 'superseded', 'failed', 'unknown',
    ]);
    expect(FOLD_DECISION_LIFECYCLE_STATES).toEqual([
      'current', 'superseded', 'failed', 'unknown',
    ]);
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
    // No timestamp anywhere in the window → every receipt carries the explicit
    // unknown-time marker (never silently rendered as ordinary chronology).
    expect(renderFoldReceipts(first).join('\n')).toContain('[time unknown] ACTION kind=edit');
    expect(renderFoldReceipts(first).join('\n')).toContain('— ✏️ src/a.ts');
  });

  it('mixed windows render [time unknown] only on timestampless receipts', () => {
    const window: FoldMessage[] = [
      toolUse('e1', 'Edit', { file_path: '/home/jonah/repo/src/a.ts', old_string: 'a', new_string: 'b' }, T1),
      toolResult('e1', 'ok', { tsMs: T1 }),
      toolUse('e2', 'Edit', { file_path: '/home/jonah/repo/src/b.ts', old_string: 'x', new_string: 'y' }),
      toolResult('e2', 'ok'),
    ];
    const lines = renderFoldReceipts(compileFoldReceipts(window));
    expect(lines.some(l => l.startsWith('[8:00 AM] ACTION kind=edit') && l.includes('src/a.ts'))).toBe(true);
    expect(lines.some(l => l.startsWith('[time unknown] ACTION kind=edit') && l.includes('src/b.ts'))).toBe(true);
  });

  it('never substitutes call-start time for a result with unknown source time', () => {
    const window: FoldMessage[] = [
      toolUse('e1', 'Edit', { file_path: '/home/jonah/repo/src/a.ts', old_string: 'a', new_string: 'b' }, T1),
      toolResult('e1', 'ok'),
    ];
    const compiled = compileFoldReceipts(window);
    expect(compiled.receipts[0].sourceTimeMs).toBeNull();
    expect(renderFoldReceipts(compiled).join('\n')).toContain('[time unknown] ACTION kind=edit');
    expect(renderFoldReceipts(compiled).join('\n')).toContain('— ✏️ src/a.ts');
  });

  it('renders a deterministic, stable order for timestamp-less windows', () => {
    const window: FoldMessage[] = [
      toolUse('b1', 'Bash', { command: 'grep foo' }),
      toolResult('b1', 'hit'),
      toolUse('e1', 'Edit', { file_path: '/home/jonah/repo/src/a.ts', old_string: 'a', new_string: 'b' }),
      toolResult('e1', 'ok'),
      toolUse('b2', 'Bash', { command: 'grep bar' }),
      toolResult('b2', 'hit2'),
    ];
    // No source times anywhere → chronology cannot be inferred from message
    // position. Items still render in one deterministic, stable order.
    const first = renderFoldReceipts(compileFoldReceipts(window));
    const second = renderFoldReceipts(compileFoldReceipts(window));
    expect(first).toEqual(second);
    expect(first.some(l => l.includes('searches ×1'))).toBe(true);
    expect(first.some(l => l.includes('✏️ src/a.ts'))).toBe(true);
    expect(first.some(l => l.includes('queries: "grep bar"'))).toBe(true);
  });

  it('gives every aggregate an authoritative source-time span and stable identity', () => {
    const window: FoldMessage[] = [
      toolUse('s1', 'grep_search', { pattern: 'later' }, T2),
      toolResult('s1', 'later hit', { tsMs: T2 }),
      toolUse('s2', 'grep_search', { pattern: 'earlier' }, T1),
      toolResult('s2', 'earlier hit', { tsMs: T1 }),
    ];
    const aggregate = compileFoldReceipts(window).aggregates[0]!;
    expect(aggregate.sourceStartTimeMs).toBe(T1);
    expect(aggregate.sourceEndTimeMs).toBe(T2);
    expect(aggregate.unknownSourceTimeCount).toBe(0);
    expect(aggregate.sourceIdentity).toBe('tool-call:s2..tool-call:s1');
    const rendered = renderFoldReceipts(compileFoldReceipts(window)).join('\n');
    expect(rendered).toContain('[8:00 AM..8:05 AM] 🔍 searches ×2');
    expect(rendered).toContain('↞ source=tool-call:s2..tool-call:s1');
  });

  it('sorts receipts and aggregates by source event time with stable ties', () => {
    const window: FoldMessage[] = [
      toolUse('s1', 'grep_search', { pattern: 'latest search' }, T3),
      toolResult('s1', 'hit', { tsMs: T3 }),
      toolUse('e1', 'Edit', { file_path: '/home/jonah/repo/src/earliest.ts', old_string: 'a', new_string: 'b' }, T1),
      toolResult('e1', 'ok', { tsMs: T1 }),
      toolUse('r1', 'read_file', { file_path: '/home/jonah/repo/src/middle.ts' }, T2),
      toolResult('r1', 'contents', { tsMs: T2 }),
      toolUse('e2', 'Edit', { file_path: '/home/jonah/repo/src/tied.ts', old_string: 'a', new_string: 'b' }, T2),
      toolResult('e2', 'ok', { tsMs: T2 }),
    ];
    const first = renderFoldReceipts(compileFoldReceipts(window));
    const second = renderFoldReceipts(compileFoldReceipts(window));
    const earliest = first.findIndex((line) => line.includes('earliest.ts'));
    const middleRead = first.findIndex((line) => line.includes('middle.ts'));
    const tiedEdit = first.findIndex((line) => line.includes('tied.ts'));
    const latest = first.findIndex((line) => line.includes('latest search'));
    // Source-time chronology governs: T1 (earliest) before T2 pair before T3;
    // equal-time rows break by stable identity (e2 before r1), never position.
    expect(earliest).toBeLessThan(tiedEdit);
    expect(earliest).toBeLessThan(middleRead);
    expect(tiedEdit).toBeLessThan(middleRead);
    expect(middleRead).toBeLessThan(latest);
    expect(tiedEdit).toBeLessThan(latest);
    expect(first).toEqual(second);
  });

  it('marks aggregate source time explicitly unknown when none is available', () => {
    const window: FoldMessage[] = [
      toolUse('r1', 'read_file', { file_path: '/repo/src/a.ts' }),
      toolResult('r1', 'contents'),
    ];
    const rendered = renderFoldReceipts(compileFoldReceipts(window)).join('\n');
    expect(rendered).toContain('[time unknown] 📖 reads ×1');
    expect(rendered).toContain('↞ source=tool-call:r1');
  });

  it('keeps provenance byte-stable when the same source outcome is rewindowed or copied', () => {
    const firstWindow: FoldMessage[] = [
      toolUse('copy-a', 'Edit', { file_path: '/repo/src/stable.ts', old_string: 'a', new_string: 'b' }, T1),
      toolResult('copy-a', 'ok', { tsMs: T2, sourceIdentity: 'canonical-result-row-42' }),
    ];
    const copiedWindow: FoldMessage[] = [
      assistantText('new window prefix'),
      toolUse('copy-b', 'Edit', { file_path: '/repo/src/stable.ts', old_string: 'a', new_string: 'b' }, T1),
      toolResult('copy-b', 'ok', { tsMs: T2, sourceIdentity: 'canonical-result-row-42' }),
    ];

    const first = compileFoldReceipts(firstWindow);
    const copied = compileFoldReceipts(copiedWindow);
    expect(first.receipts[0].sourceIdentity).toBe('canonical-result-row-42');
    expect(copied.receipts[0].sourceIdentity).toBe('canonical-result-row-42');
    // Receipt rows key off source identity, so shifting the same outcome to a
    // later window position must not move a byte.
    expect(renderFoldReceipts(first).slice(1)).toEqual(renderFoldReceipts(copied).slice(1));
    // The leading header is a census of *this* window rather than of the source
    // row, and it stays honest about the prose each window replaced: the copied
    // window really does bury one more narrated turn than the first.
    expect(first.counts.proseTurns).toBe(0);
    expect(copied.counts.proseTurns).toBe(1);
    expect(renderFoldReceipts(first)[0]).toContain('0 narrated turn(s) folded');
    expect(renderFoldReceipts(copied)[0]).toContain('1 narrated turn(s) folded');
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
    expect(lines[0]).toContain('aggregated: 1 search');
  });

  it('audits several heterogeneous windows and detects a deliberately dropped class', () => {
    const cases: Array<{
      window: FoldMessage[];
      droppedKey: TotalityCountKey;
      droppedHeaderFragment: string;
      headerFragments: string[];
    }> = [
      {
        window: [
          toolUse('e1', 'Edit', { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }),
          toolResult('e1', 'ok'),
          toolUse('t1', 'Bash', { command: 'npx vitest run' }),
          toolResult('t1', 'Tests  5 passed (5)'),
          toolUse('s1', 'grep_search', { pattern: 'needle' }),
          toolResult('s1', 'src/a.ts:1:needle'),
        ],
        droppedKey: 'edits',
        droppedHeaderFragment: '1 edit(s)',
        headerFragments: ['3 tool call(s)', '1 edit(s)', '1 test run(s)', 'aggregated: 1 search'],
      },
      {
        window: [
          toolUse('c1', 'partner_claim_file', { path: 'src/a.ts:1-20' }),
          toolResult('c1', 'granted'),
          toolUse('p1', 'chatroom', { action: 'send', room: 'fold-lab', message: 'proof' }),
          toolResult('p1', 'sent'),
          toolUse('a1', 'atlas_commit', { file_path: 'src/a.ts', changelog_entry: 'proof' }),
          toolResult('a1', 'committed'),
        ],
        droppedKey: 'claimEvents',
        droppedHeaderFragment: '1 claim event(s)',
        headerFragments: ['3 tool call(s)', '1 atlas', '1 chat', '1 claim event(s) in 1 burst(s)'],
      },
      {
        window: [
          toolUse('r1', 'read_file', { file_path: '/repo/src/a.ts' }),
          toolResult('r1', 'contents'),
          toolUse('u1', 'mystery_tool', { value: 1 }),
          toolResult('u1', 'ok'),
          toolUse('tc1', 'mcp_forge_focused-typecheck__typecheck', { files: ['src/a.ts'] }),
          toolResult('tc1', '{"ok":true,"status":"clean","clean":true}'),
        ],
        droppedKey: 'otherEvents',
        droppedHeaderFragment: '1 named tool call(s)',
        headerFragments: ['3 tool call(s)', '1 typecheck(s)', '1 read', '1 named tool call(s)'],
      },
    ];

    for (const testCase of cases) {
      const compiled = compileFoldReceipts(testCase.window);
      expect(totalitySum(compiled.counts)).toBe(compiled.counts.totalToolCalls);
      const header = renderFoldReceipts(compiled)[0];
      for (const fragment of testCase.headerFragments) expect(header).toContain(fragment);

      const brokenCounts: FoldReceiptCounts = {
        ...compiled.counts,
        [testCase.droppedKey]: compiled.counts[testCase.droppedKey] - 1,
      };
      expect(totalitySum(brokenCounts)).not.toBe(brokenCounts.totalToolCalls);
      const brokenHeader = renderFoldReceipts({ ...compiled, counts: brokenCounts })[0];
      expect(brokenHeader).toContain(`${brokenCounts.totalToolCalls} tool call(s)`);
      expect(brokenHeader).not.toContain(testCase.droppedHeaderFragment);
    }
  });

  it('empty window compiles to a totality header with zero calls', () => {
    const c = compileFoldReceipts([]);
    expect(c.counts.totalToolCalls).toBe(0);
    expect(totalitySum(c.counts)).toBe(0);
    const lines = renderFoldReceipts(c);
    expect(lines[0]).toContain('0 tool call(s): none');
  });

  it('conserved literals are deduped and capped', () => {
    const window: FoldMessage[] = Array.from({ length: 50 }, (_, i) => [
      toolUse(`e${i}`, 'Edit', { file_path: `/home/jonah/repo/src/file${i}.ts`, old_string: 'a', new_string: 'b' }),
      toolResult(`e${i}`, `ok sha256: ${String(i).padStart(64, '0')}abcdef done`),
    ]).flat();
    const c = compileFoldReceipts(window, { literalCap: 5 });
    expect(c.conservedLiterals.length).toBeLessThanOrEqual(5);
    expect(new Set(c.conservedLiterals).size).toBe(c.conservedLiterals.length);
    const expandedDefault = compileFoldReceipts(window);
    expect(expandedDefault.conservedLiterals).toHaveLength(36);
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

// ── Regressions for the six classification/honesty defects ──
// Each case below fails against the pre-fix compiler: a folded band that
// misclassifies, drops, or over-claims is worse than one that omits, because a
// successor cannot tell a confident wrong receipt from a correct one.

describe('fold receipt fidelity regressions', () => {
  function bashWindow(commands: string[]): FoldMessage[] {
    return commands.flatMap((command, i) => [
      toolUse(`b${i}`, 'Bash', { command }, T1),
      toolResult(`b${i}`, 'ok', { tsMs: T2 }),
    ]);
  }

  it('F1: real shell mutations promote to receipts instead of collapsing into the read lane', () => {
    // Every one of these fell through to the read aggregate before the fix: the
    // old alternatives ended in a trailing space followed by \b, which requires
    // a word character after the space, so any flag or absolute path escaped.
    const mutations = [
      'rm -rf /tmp/build',
      'cp -r src dist',
      'mv /a/b.ts /a/c.ts',
      'sed -i s/a/b/ f.ts',
      'echo x > relay/.env',
      'pm2 restart relay',
      'kill -9 123',
      'find . -name "*.tmp" -exec rm {} \\;',
      'ls | xargs rm -f',
      'sudo systemctl restart nginx',
      'chmod +x scripts/run.sh',
      'apt-get install -y jq',
    ];
    const c = compileFoldReceipts(bashWindow(mutations));
    expect(c.counts.bashMutations).toBe(mutations.length);
    expect(c.counts.readEvents + c.counts.searchEvents).toBe(0);
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('F1: quoted search patterns and read-only subcommands stay investigation, not mutation', () => {
    // Quote masking is what keeps a *pattern* from faking shell structure — the
    // `|` inside these strings previously read as a pipeline into a mutation.
    const reads = [
      'grep -rn "rm -rf" .',
      'rg "npm install|docker build" -n',
      'git status --short',
      'git log --oneline -20',
      'git diff HEAD~1',
      'docker ps -a',
      'kubectl get pods',
      'node --version 2>&1',
      'cat relay/package.json > /dev/null',
    ];
    const c = compileFoldReceipts(bashWindow(reads));
    expect(c.counts.bashMutations).toBe(0);
    expect(c.counts.readEvents + c.counts.searchEvents).toBe(reads.length);
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('F1: test and typecheck shape outranks mutation shape, which is what protects redirects', () => {
    // Deliberate precedence, pinned rather than "fixed". Checking test/typecheck
    // before isMutatingBash is what keeps a redirect-bearing invocation in its
    // own lane: `npm test > /tmp/out.log` is a test run whose redirect is
    // incidental, and mutation-first would refile it as a filesystem write.
    const c = compileFoldReceipts(bashWindow([
      'npm test > /tmp/out.log 2>&1',
      'npx tsc --noEmit > /tmp/tsc.log',
      // Cost of the same precedence: an install that names a test runner is
      // filed as a test run. Cosmetic — the receipt still carries the command.
      'npm install --save-dev vitest',
    ]));
    expect(c.counts.testRuns).toBe(2);
    expect(c.counts.typechecks).toBe(1);
    expect(c.counts.bashMutations).toBe(0);
    expect(renderFoldReceipts(c).join('\n')).toContain('npm install --save-dev vitest');
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('F1: `make test` is a mutation because the test pattern does not cover it', () => {
    // Not a defect to paper over: TEST_COMMAND_RE has no `make` alternative, so
    // `make` classifies on its own mutation verb. Pinned so the behavior is a
    // recorded decision rather than a surprise for the next reader.
    const c = compileFoldReceipts(bashWindow(['make test']));
    expect(c.counts.bashMutations).toBe(1);
    expect(c.counts.testRuns).toBe(0);
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('F2: external side effects promote to actuator receipts, not the anonymous other bucket', () => {
    const window: FoldMessage[] = [
      toolUse('a1', 'gmail_send', { to: 'ops@example.com', subject: 'launch' }, T1),
      toolResult('a1', 'sent', { tsMs: T2 }),
      toolUse('a2', 'mcp__voxxo-swarm-bridge__execute_sql', { sql: 'DELETE FROM runs WHERE id = 7' }, T1),
      toolResult('a2', 'ok', { tsMs: T2 }),
      toolUse('a3', 'apply_migration', { name: 'add_runs_index' }, T1),
      toolResult('a3', 'ok', { tsMs: T2 }),
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.actuators).toBe(3);
    expect(c.counts.otherEvents).toBe(0);
    const rendered = renderFoldReceipts(c).join('\n');
    expect(rendered).toContain('📡');
    // The target is what makes an external effect auditable.
    expect(rendered).toContain('ops@example.com');
    expect(rendered).toContain('DELETE FROM runs WHERE id = 7');
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('F3: typecheck and test receipts require positive evidence before claiming success', () => {
    const window: FoldMessage[] = [
      // Truncated/compacted output: zero found errors is not evidence of a pass.
      toolUse('t1', 'typecheck', { files: ['a.ts'] }, T1),
      toolResult('t1', '', { tsMs: T2 }),
      toolUse('t2', 'typecheck', { files: ['b.ts'] }, T1),
      toolResult('t2', '{"ok":true,"status":"clean","error_count":0}', { tsMs: T2 }),
      toolUse('t3', 'typecheck', { files: ['c.ts'] }, T1),
      toolResult('t3', '{"ok":false,"status":"infra_timeout","retryable":true}', { tsMs: T2 }),
      toolUse('t4', 'run_tests', { files: ['x.test.ts'] }, T1),
      toolResult('t4', '{"ok":false,"status":"launch_error"}', { tsMs: T2 }),
    ];
    const lines = renderFoldReceipts(compileFoldReceipts(window));
    expect(lines.some((l) => l.includes('result unknown'))).toBe(true);
    expect(lines.some((l) => l.includes('clean'))).toBe(true);
    expect(lines.some((l) => l.includes('did not run (infra_timeout)'))).toBe(true);
    expect(lines.some((l) => l.includes('did not run (launch_error)'))).toBe(true);
    const c = compileFoldReceipts(window);
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('F5: truncated aggregate paths declare how many were dropped', () => {
    const window: FoldMessage[] = [];
    for (let i = 0; i < 10; i += 1) {
      window.push(toolUse(`r${i}`, 'Read', { file_path: `/repo/src/f${i}.ts` }, T1));
      window.push(toolResult(`r${i}`, 'contents', { tsMs: T2 }));
    }
    const c = compileFoldReceipts(window);
    const line = renderFoldReceipts(c).find((l) => l.includes('reads ×10'));
    expect(line).toBeDefined();
    expect(line).toContain('/repo/src/f0.ts');
    // Six render, four are declared — silent truncation reads as completeness.
    expect(line).toContain('(+4 more)');
    expect(c.aggregates[0].omittedPathCount).toBe(4);
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('F5: non-search runs keep their argument digest instead of a contentless count', () => {
    const window: FoldMessage[] = bashWindow(['git status --short', 'git log --oneline -5']);
    const c = compileFoldReceipts(window);
    const rendered = renderFoldReceipts(c).join('\n');
    expect(rendered).toContain('args:');
    expect(rendered).toContain('git status --short');
    expect(c.aggregates[0].queries.length).toBe(2);
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });

  it('F6b: content-block and Gemini prose turns count and surface in the header', () => {
    const window: FoldMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'Here is what I found.' }] } as unknown as FoldMessage,
      // Reasoning is not delivered prose and must not inflate the census.
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'internal only' }] } as unknown as FoldMessage,
      toolUse('p1', 'Edit', { file_path: '/repo/src/p.ts', old_string: 'a', new_string: 'b' }, T1),
      toolResult('p1', 'ok', { tsMs: T2 }),
      { role: 'model', content: null, parts: [{ text: 'gemini narration' }] } as unknown as FoldMessage,
    ];
    const c = compileFoldReceipts(window);
    expect(c.counts.proseTurns).toBe(2);
    expect(renderFoldReceipts(c)[0]).toContain('2 narrated turn(s) folded');
    expect(totalitySum(c.counts)).toBe(c.counts.totalToolCalls);
  });
});
