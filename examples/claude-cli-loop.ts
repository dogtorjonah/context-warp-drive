/**
 * Runnable Claude Code CLI folding loop.
 *
 * Prereqs:
 *   1. Install and log in to Claude Code (`claude` on PATH).
 *   2. Run from the project you want Claude to operate on, or pass that cwd.
 *
 * Usage:
 *   npx tsx examples/claude-cli-loop.ts /path/to/project
 *   printf 'Inspect src/index.ts\n' | npx tsx examples/claude-cli-loop.ts
 *
 * Optional env:
 *   CLAUDE_SESSION_ID=<existing-id>          resume an existing Claude Code session
 *   CLAUDE_MODEL=claude-sonnet-4-6          pass --model
 *   WARP_CLAUDE_CLI_FOLD=dry-run|on|off     inspect folds without rewriting live JSONL
 *   WARP_CONTEXT_WINDOW_TOKENS=200000       override trigger math window
 */
import { createInterface } from 'node:readline/promises';
import {
  ClaudeCliFoldLoop,
  type ClaudeCliFoldLoopMode,
} from '../src/host/claudeCliLoop.ts';

function parseMode(value: string | undefined): ClaudeCliFoldLoopMode {
  if (value === 'dry-run' || value === 'off') return value;
  return 'on';
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const cwd = process.argv[2] ?? process.cwd();
const mode = parseMode(process.env.WARP_CLAUDE_CLI_FOLD);
const loop = new ClaudeCliFoldLoop({
  cwd,
  sessionId: process.env.CLAUDE_SESSION_ID,
  model: process.env.CLAUDE_MODEL,
  mode,
  contextWindowTokens: optionalNumber(process.env.WARP_CONTEXT_WINDOW_TOKENS),
  authMode: process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? 'oauth'
    : (process.env.ANTHROPIC_API_KEY ? 'api-key' : 'inherit'),
  onSpawn: ({ command, args, sessionId }) => {
    console.error(`[cwd] spawn: ${command} ${args.join(' ')}${sessionId ? '' : ' (awaiting session_id)'}`);
  },
  onUsage: (usage) => {
    console.error(`[cwd] measured input tokens: ${usage.measuredInputTokens}`);
  },
  onEpoch: (epoch) => {
    if (!epoch.attempted) {
      console.error(`[cwd] fold skipped: ${epoch.reason}`);
      return;
    }
    console.error(
      `[cwd] ${epoch.kind} fold ${epoch.folded ? 'ready' : 'skipped'}: ${epoch.reason}`
      + ` (${epoch.frozenViewChars ?? 0} chars, ${epoch.frozenRawCount ?? 0} raw rows)`,
    );
  },
  onError: (error) => {
    console.error(`[cwd] ${error.message}`);
  },
});

await loop.start();

if (process.stdin.isTTY) {
  console.error('[cwd] Type prompts for Claude Code. Ctrl-D exits.');
}

const input = createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
for await (const line of input) {
  const text = line.trim();
  if (!text) continue;
  if (text === '/fold') {
    await loop.maybeFold();
    continue;
  }
  await loop.sendUserText(text);
}

await loop.stop();
