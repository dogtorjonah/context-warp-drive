import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  encodeCwdForClaudeCode,
  writeFoldedClaudeCliJsonl,
  resolveClaudeCliSessionJsonlPath,
  type BuildClaudeCliFoldChainOptions,
} from '../src/providers/claudeCli.ts';
import type { FoldMessage } from '../src/rollingFold.ts';

const SESSION_ID = 'test-claude-fold-001';
const CWD = '/home/jonah/voxxo-swarm';

// Deterministic uuid stamps so the rewritten chain is byte-stable in assertions.
function seqUuid(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`;
}
function chainOptions(): BuildClaudeCliFoldChainOptions {
  return { sessionId: SESSION_ID, cwd: CWD, makeUuid: seqUuid(), baseTimeMs: 1_700_000_000_000 };
}

const FOLDED: FoldMessage[] = [
  { role: 'user', content: 'folded conversation context' },
  { role: 'assistant', content: 'folded reply' },
];

describe('resolveClaudeCliSessionJsonlPath', () => {
  it('encodes the cwd (/ → -) under the projects root', () => {
    expect(resolveClaudeCliSessionJsonlPath('sid', '/a/b/c', '/tmp/r')).toBe(
      path.join('/tmp/r', encodeCwdForClaudeCode('/a/b/c'), 'sid.jsonl'),
    );
  });

  it('defaults to ~/.claude/projects when no root override is given', () => {
    expect(resolveClaudeCliSessionJsonlPath('sid', '/x')).toBe(
      path.join(os.homedir(), '.claude', 'projects', encodeCwdForClaudeCode('/x'), 'sid.jsonl'),
    );
  });
});

describe('writeFoldedClaudeCliJsonl', () => {
  let root: string;
  let filePath: string;
  let dir: string;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claudefold-write-'));
    filePath = resolveClaudeCliSessionJsonlPath(SESSION_ID, CWD, root);
    dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  /** Seed a realistic session file: a leading aux line, an old message chain, a stale last-prompt. */
  async function seedSession(): Promise<void> {
    const lines = [
      { type: 'queue-operation', op: 'init', sessionId: SESSION_ID },
      { parentUuid: null, isSidechain: false, type: 'user', uuid: 'old-1', sessionId: SESSION_ID, message: { role: 'user', content: 'OLD-RAW-USER' } },
      { parentUuid: 'old-1', isSidechain: false, type: 'assistant', uuid: 'old-2', sessionId: SESSION_ID, message: { role: 'assistant', content: [{ type: 'text', text: 'OLD-RAW-ASSISTANT' }] } },
      { type: 'last-prompt', lastPrompt: 'OLD', leafUuid: 'old-2', sessionId: SESSION_ID },
    ];
    await fs.promises.writeFile(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  }

  it('preserves leading aux head lines and replaces the message chain atomically', async () => {
    await seedSession();
    const result = await writeFoldedClaudeCliJsonl(FOLDED, chainOptions(), { root });

    expect(result.written).toBe(true);
    expect(result.path).toBe(filePath);
    expect(result.leafUuid).not.toBeNull();
    // 1 preserved head (queue-operation) + 2 folded messages + 1 last-prompt.
    expect(result.lineCount).toBe(4);

    const lines = (await fs.promises.readFile(filePath, 'utf8')).split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(4);
    // Head preserved verbatim.
    expect(JSON.parse(lines[0])).toEqual({ type: 'queue-operation', op: 'init', sessionId: SESSION_ID });
    // Old raw chain is gone, replaced by the folded chain.
    const body = lines.join('\n');
    expect(body).not.toContain('OLD-RAW-USER');
    expect(body).not.toContain('OLD-RAW-ASSISTANT');
    expect(body).toContain('folded conversation context');
    // Trailing line is a fresh last-prompt whose leaf matches the result.
    const lastLine = JSON.parse(lines[3]);
    expect(lastLine.type).toBe('last-prompt');
    expect(lastLine.leafUuid).toBe(result.leafUuid);
    // No temp sibling left behind after the atomic rename.
    const leftovers = (await fs.promises.readdir(dir)).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('leaves the live file untouched and returns written:false for an empty fold', async () => {
    await seedSession();
    const before = await fs.promises.readFile(filePath, 'utf8');
    const result = await writeFoldedClaudeCliJsonl([], chainOptions(), { root });

    expect(result.written).toBe(false);
    expect(result.leafUuid).toBeNull();
    expect(result.lineCount).toBe(0);
    expect(await fs.promises.readFile(filePath, 'utf8')).toBe(before);
  });

  it('throws when the session file is missing (caller falls back to fresh reseed)', async () => {
    await expect(writeFoldedClaudeCliJsonl(FOLDED, chainOptions(), { root })).rejects.toThrow(/not readable/);
  });

  it('writes a .dryrun sidecar and never touches the live file', async () => {
    await seedSession();
    const before = await fs.promises.readFile(filePath, 'utf8');
    const result = await writeFoldedClaudeCliJsonl(FOLDED, chainOptions(), { root, dryRun: true });

    expect(result.written).toBe(true);
    expect(result.path).toBe(`${filePath}.dryrun`);
    // Live file is byte-identical; the fold landed only in the sidecar.
    expect(await fs.promises.readFile(filePath, 'utf8')).toBe(before);
    const sidecar = (await fs.promises.readFile(result.path, 'utf8')).split('\n').filter((l) => l.trim().length > 0);
    expect(sidecar).toHaveLength(4);
    expect(JSON.parse(sidecar[sidecar.length - 1]).type).toBe('last-prompt');
  });
});
