import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeCliFoldLoop,
  buildClaudeCliFoldLoopArgs,
  buildClaudeCliFoldLoopEnv,
} from '../src/host/claudeCliLoop.ts';
import type { BirthFoldSourceRow } from '../src/foldBirthHydration.ts';
import { resolveClaudeCliSessionJsonlPath } from '../src/providers/claudeCli.ts';

const BASE_MS = 1_700_000_000_000;
const CWD = '/home/jonah/example-project';
const SESSION_ID = 'claude-loop-session-A';

function seqUuid(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`;
}

function row(partial: Partial<BirthFoldSourceRow> & { ty: string }): BirthFoldSourceRow {
  return { tx: null, tn: null, ti: undefined, ts: '2026-07-01T14:00:00.000Z', ...partial };
}

function transcript(turns = 24): BirthFoldSourceRow[] {
  const rows: BirthFoldSourceRow[] = [];
  for (let i = 0; i < turns; i++) {
    rows.push(row({ ty: 'user', tx: `task ${i} inspect src/mod${i}.ts ${'detail '.repeat(20)}` }));
    rows.push(row({ ty: 'tool_use', tn: 'Read', ti: { file_path: `src/mod${i}.ts` } }));
    rows.push(row({ ty: 'tool_result', tn: 'Read', tx: `module ${i} contents ${'x'.repeat(80)}` }));
    rows.push(row({ ty: 'assistant_text', tx: `finished ${i} ${'analysis '.repeat(20)}` }));
  }
  return rows;
}

class FakeClaudeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly stdinLines: string[] = [];
  readonly killSignals: string[] = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.stdinLines.push(chunk.toString());
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(String(signal ?? 'SIGTERM'));
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
}

function asChild(proc: FakeClaudeProcess): ChildProcessWithoutNullStreams {
  return proc as unknown as ChildProcessWithoutNullStreams;
}

async function makeSessionFile(root: string): Promise<string> {
  const filePath = resolveClaudeCliSessionJsonlPath(SESSION_ID, CWD, root);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const lines = [
    { type: 'queue-operation', op: 'init', sessionId: SESSION_ID },
    { parentUuid: null, isSidechain: false, type: 'user', uuid: 'old-1', sessionId: SESSION_ID, message: { role: 'user', content: 'OLD RAW' } },
    { type: 'last-prompt', lastPrompt: 'OLD RAW', leafUuid: 'old-1', sessionId: SESSION_ID },
  ];
  await fs.promises.writeFile(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return filePath;
}

describe('buildClaudeCliFoldLoopArgs/env', () => {
  it('builds a stream-json Claude Code invocation with resume and standard files', () => {
    expect(buildClaudeCliFoldLoopArgs({
      model: 'claude-sonnet-4-6',
      effort: 'max',
      sessionId: SESSION_ID,
      systemPromptFile: 'system.md',
      mcpConfigFile: 'mcp.json',
      settingsFile: 'settings.json',
      allowedTools: ['Read', 'Edit'],
      disallowedTools: ['Bash'],
      extraArgs: ['--permission-mode', 'acceptEdits'],
    })).toEqual([
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--model', 'claude-sonnet-4-6',
      '--effort', 'max',
      '--system-prompt-file', 'system.md',
      '--mcp-config', 'mcp.json',
      '--allowedTools', 'Read,Edit',
      '--disallowedTools', 'Bash',
      '--settings', 'settings.json',
      '--permission-mode', 'acceptEdits',
      '--resume', SESSION_ID,
    ]);
  });

  it('separates OAuth and API-key env modes and disables bundled skills by default', () => {
    const oauth = buildClaudeCliFoldLoopEnv(
      { ANTHROPIC_API_KEY: 'sk-ant', CLAUDE_CODE_OAUTH_TOKEN: 'old' },
      { authMode: 'oauth', oauthToken: 'oauth-token' },
    );
    expect(oauth.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
    expect(oauth.ANTHROPIC_API_KEY).toBeUndefined();
    expect(oauth.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS).toBe('1');

    const apiKey = buildClaudeCliFoldLoopEnv(
      { ANTHROPIC_API_KEY: 'old-key', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
      { authMode: 'api-key', apiKey: 'new-key', disableBundledSkills: false },
    );
    expect(apiKey.ANTHROPIC_API_KEY).toBe('new-key');
    expect(apiKey.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(apiKey.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS).toBeUndefined();
  });
});

describe('ClaudeCliFoldLoop — live stream harness', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.map((root) => fs.promises.rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it('learns session_id from stream-json, records measured usage, and captures tool rows', async () => {
    const spawned: FakeClaudeProcess[] = [];
    const usageSeen: number[] = [];
    const loop = new ClaudeCliFoldLoop({
      cwd: CWD,
      autoFold: false,
      now: () => BASE_MS,
      spawnTimeoutMs: 250,
      spawnProcess: (
        _command: string,
        _args: readonly string[],
        _options: SpawnOptionsWithoutStdio,
      ) => {
        const proc = new FakeClaudeProcess();
        spawned.push(proc);
        return asChild(proc);
      },
      onUsage: (usage) => usageSeen.push(usage.measuredInputTokens),
    });

    const started = loop.start();
    await Promise.resolve();
    spawned[0].stdout.write(`${JSON.stringify({ type: 'system', session_id: SESSION_ID })}\n`);
    await started;
    expect(loop.activeSessionId).toBe(SESSION_ID);

    spawned[0].stdout.write(`${JSON.stringify({
      type: 'assistant',
      message: {
        usage: { input_tokens: 11, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 5 },
        content: [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/index.ts' } },
        ],
      },
    })}\n`);
    spawned[0].stdout.write(`${JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' },
        ],
      },
    })}\n`);

    expect(usageSeen).toEqual([21]);
    expect(loop.measuredInputTokens).toBe(21);
    expect(loop.getTranscriptRows().map((r) => [r.ty, r.tn, r.tx])).toEqual([
      ['assistant_text', null, 'I will inspect it.'],
      ['tool_use', 'Read', null],
      ['tool_result', 'Read', 'file contents'],
    ]);

    await loop.sendUserText('next prompt');
    expect(spawned[0].stdinLines.join('')).toContain('"content":"next prompt"');
    await loop.stop();
    expect(spawned[0].killSignals).toEqual(['SIGINT']);
  });

  it('computes a dry-run fold sidecar without touching the live Claude JSONL file', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-loop-dry-'));
    roots.push(root);
    const filePath = await makeSessionFile(root);
    const before = await fs.promises.readFile(filePath, 'utf8');
    const loop = new ClaudeCliFoldLoop({
      cwd: CWD,
      sessionId: SESSION_ID,
      mode: 'dry-run',
      projectsRoot: root,
      initialRows: transcript(),
      contextWindowTokens: 200_000,
      now: () => BASE_MS,
      makeUuid: seqUuid(),
    });

    const epoch = await loop.maybeFold(190_000);
    expect(epoch.attempted).toBe(true);
    expect(epoch.folded).toBe(true);
    expect(epoch.dryRun).toBe(true);
    expect(epoch.write?.path).toBe(`${filePath}.dryrun`);
    expect(await fs.promises.readFile(filePath, 'utf8')).toBe(before);
    expect(await fs.promises.readFile(`${filePath}.dryrun`, 'utf8')).toContain('hard-compacted for continuity');
  });

  it('stops the live process, rewrites the session chain, and respawns with --resume', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-loop-live-'));
    roots.push(root);
    const filePath = await makeSessionFile(root);
    const spawned: FakeClaudeProcess[] = [];
    const spawnArgs: string[][] = [];
    const loop = new ClaudeCliFoldLoop({
      cwd: CWD,
      sessionId: SESSION_ID,
      mode: 'on',
      projectsRoot: root,
      initialRows: transcript(),
      contextWindowTokens: 200_000,
      now: () => BASE_MS,
      makeUuid: seqUuid(),
      spawnProcess: (_command, args) => {
        const proc = new FakeClaudeProcess();
        spawned.push(proc);
        spawnArgs.push([...args]);
        return asChild(proc);
      },
    });

    await loop.start();
    const epoch = await loop.maybeFold(190_000);

    expect(epoch.folded).toBe(true);
    expect(spawned).toHaveLength(2);
    expect(spawned[0].killSignals).toEqual(['SIGINT']);
    expect(spawnArgs[1]).toContain('--resume');
    expect(spawnArgs[1]).toContain(SESSION_ID);
    const rewritten = await fs.promises.readFile(filePath, 'utf8');
    expect(rewritten).not.toContain('OLD RAW');
    expect(rewritten).toContain('hard-compacted for continuity');
    expect(JSON.parse(rewritten.trim().split('\n').at(-1)!).type).toBe('last-prompt');
  });
});
