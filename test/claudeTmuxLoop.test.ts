import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BirthFoldSourceRow } from '../src/foldBirthHydration.ts';
import { resolveClaudeCliSessionJsonlPath } from '../src/providers/claudeCli.ts';
import {
  ClaudeTmuxFoldLoop,
  buildClaudeTmuxAttachArgs,
  buildClaudeTmuxClaudeArgs,
  buildClaudeTmuxSessionArgs,
} from '../src/host/claudeTmuxLoop.ts';

const BASE_MS = 1_700_000_000_000;
const CWD = '/home/jonah/example.project_under';
const SESSION_ID = 'tmux-session-A';

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

class FakeTmuxProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly killSignals: string[] = [];

  constructor(private readonly exitCode = 0) {
    super();
    queueMicrotask(() => this.emit('exit', this.exitCode, null));
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(String(signal ?? 'SIGTERM'));
    queueMicrotask(() => this.emit('exit', 1, signal ?? null));
    return true;
  }
}

function asChild(proc: FakeTmuxProcess): ChildProcessWithoutNullStreams {
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

async function appendJsonl(filePath: string, lines: readonly unknown[]): Promise<void> {
  await fs.promises.appendFile(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
}

describe('Claude tmux arg builders', () => {
  it('builds interactive Claude args without --print and keeps attach args simple', () => {
    expect(buildClaudeTmuxClaudeArgs({
      model: 'claude-sonnet-4-6',
      sessionId: SESSION_ID,
      effort: 'max',
      permissionMode: 'acceptEdits',
      mcpConfigFile: 'mcp.json',
      allowedTools: ['Read', 'Edit'],
      disallowedTools: ['Bash'],
      settingsFile: 'settings.json',
      extraArgs: ['--dangerously-skip-permissions'],
    })).toEqual([
      '--verbose',
      '--model', 'claude-sonnet-4-6',
      '--effort', 'max',
      '--permission-mode', 'acceptEdits',
      '--mcp-config', 'mcp.json',
      '--allowedTools', 'Read,Edit',
      '--disallowedTools', 'Bash',
      '--settings', 'settings.json',
      '--dangerously-skip-permissions',
      '--resume', SESSION_ID,
    ]);
    expect(buildClaudeTmuxAttachArgs('cwd-demo')).toEqual(['attach-session', '-t', 'cwd-demo']);
  });

  it('builds a tmux new-session command with a quoted interactive Claude shell command', () => {
    const args = buildClaudeTmuxSessionArgs({
      cwd: CWD,
      tmuxSessionName: 'cwd-demo',
      claudePath: '/opt/Claude Code/claude',
      model: 'claude-sonnet-4-6',
      sessionId: SESSION_ID,
    });

    expect(args.slice(0, 6)).toEqual(['new-session', '-d', '-s', 'cwd-demo', '-c', CWD]);
    expect(args.at(-1)).toContain("'/opt/Claude Code/claude'");
    expect(args.at(-1)).toContain('--resume tmux-session-A');
    expect(args.at(-1)).not.toContain('--print');
  });
});

describe('ClaudeTmuxFoldLoop', () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.map((root) => fs.promises.rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it('uses Claude Code path encoding that matches dotted and underscored cwd segments', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-tmux-encode-'));
    roots.push(root);
    expect(resolveClaudeCliSessionJsonlPath(SESSION_ID, CWD, root)).toBe(
      path.join(root, '-home-jonah-example-project-under', `${SESSION_ID}.jsonl`),
    );
  });

  it('spawns tmux, discovers a new JSONL file, captures rows, and records measured usage', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-tmux-tail-'));
    roots.push(root);
    const filePath = resolveClaudeCliSessionJsonlPath(SESSION_ID, CWD, root);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const commands: string[][] = [];
    const usageSeen: number[] = [];
    const loop = new ClaudeTmuxFoldLoop({
      cwd: CWD,
      projectsRoot: root,
      tmuxSessionName: 'cwd-demo',
      pollIntervalMs: 20,
      discoveryTimeoutMs: 500,
      autoFold: false,
      now: () => BASE_MS,
      spawnProcess: (_command, args, _options: SpawnOptionsWithoutStdio) => {
        commands.push([...args]);
        return asChild(new FakeTmuxProcess());
      },
      onUsage: (usage) => usageSeen.push(usage.measuredInputTokens),
    });

    const info = await loop.start();
    expect(info.attachCommand).toBe('tmux attach-session -t cwd-demo');
    await appendJsonl(filePath, [
      { type: 'user', uuid: 'u1', sessionId: SESSION_ID, userType: 'external', message: { role: 'user', content: 'Inspect src/index.ts' } },
      {
        type: 'assistant',
        uuid: 'a1',
        sessionId: SESSION_ID,
        message: {
          role: 'assistant',
          usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 3 },
          content: [
            { type: 'text', text: 'I will inspect it.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/index.ts' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        sessionId: SESSION_ID,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        sessionId: SESSION_ID,
        message: {
          role: 'assistant',
          usage: { input_tokens: 12, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, output_tokens: 4 },
          content: [{ type: 'text', text: 'Done.' }],
        },
      },
    ]);
    await loop.waitForSessionJsonl(500);
    await loop.pollJsonlNow();

    expect(commands[0]?.slice(0, 4)).toEqual(['new-session', '-d', '-s', 'cwd-demo']);
    expect(loop.activeSessionId).toBe(SESSION_ID);
    expect(usageSeen).toEqual([16, 20]);
    expect(loop.getTranscriptRows().map((r) => [r.ty, r.tn, r.tx])).toEqual([
      ['user', null, 'Inspect src/index.ts'],
      ['assistant_text', null, 'I will inspect it.'],
      ['tool_use', 'Read', null],
      ['tool_result', 'Read', 'file contents'],
      ['assistant_text', null, 'Done.'],
    ]);

    await loop.sendKeys('next prompt');
    expect(commands.at(-1)).toEqual(['send-keys', '-t', 'cwd-demo', 'next prompt', 'Enter']);
    await loop.stop();
    expect(commands.at(-1)).toEqual(['kill-session', '-t', 'cwd-demo']);
  });

  it('computes a dry-run fold sidecar without touching the live JSONL file', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-tmux-dry-'));
    roots.push(root);
    const filePath = await makeSessionFile(root);
    const before = await fs.promises.readFile(filePath, 'utf8');
    const loop = new ClaudeTmuxFoldLoop({
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
    expect(await fs.promises.readFile(`${filePath}.dryrun`, 'utf8')).toContain('[CONTEXT REBIRTH]');
  });

  it('kills tmux, rewrites the session chain, and respawns interactive Claude with --resume', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claude-tmux-live-'));
    roots.push(root);
    const filePath = await makeSessionFile(root);
    const commands: string[][] = [];
    const loop = new ClaudeTmuxFoldLoop({
      cwd: CWD,
      sessionId: SESSION_ID,
      mode: 'on',
      projectsRoot: root,
      tmuxSessionName: 'cwd-demo',
      initialRows: transcript(),
      contextWindowTokens: 200_000,
      now: () => BASE_MS,
      makeUuid: seqUuid(),
      spawnProcess: (_command, args) => {
        commands.push([...args]);
        return asChild(new FakeTmuxProcess());
      },
    });

    await loop.start();
    const epoch = await loop.maybeFold(190_000);

    expect(epoch.folded).toBe(true);
    expect(commands.map((args) => args[0])).toEqual(['new-session', 'kill-session', 'new-session']);
    expect(commands[2]?.at(-1)).toContain('--resume tmux-session-A');
    const rewritten = await fs.promises.readFile(filePath, 'utf8');
    expect(rewritten).not.toContain('OLD RAW');
    expect(rewritten).toContain('[CONTEXT REBIRTH]');
    expect(JSON.parse(rewritten.trim().split('\n').at(-1)!).type).toBe('last-prompt');
  });
});
