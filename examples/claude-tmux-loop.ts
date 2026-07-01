/**
 * Runnable interactive Claude Code tmux folding loop.
 *
 * Prereqs:
 *   1. Install tmux.
 *   2. Install and log in to Claude Code (`claude` on PATH).
 *   3. Run from the project you want Claude to operate on, or pass that cwd.
 *
 * Usage:
 *   npx tsx examples/claude-tmux-loop.ts /path/to/project
 *   tmux attach-session -t <printed-session-name>
 *
 * Optional env:
 *   CLAUDE_SESSION_ID=<existing-id>          resume an existing Claude Code session
 *   CLAUDE_MODEL=claude-sonnet-4-6          pass --model
 *   WARP_CLAUDE_TMUX_FOLD=dry-run|on|off    inspect folds without rewriting live JSONL
 *   WARP_CONTEXT_WINDOW_TOKENS=200000       override trigger math window
 */
import {
  ClaudeTmuxFoldLoop,
  type ClaudeTmuxFoldLoopMode,
} from '../src/host/claudeTmuxLoop.ts';

function parseMode(value: string | undefined): ClaudeTmuxFoldLoopMode {
  if (value === 'dry-run' || value === 'off') return value;
  return 'on';
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const cwd = process.argv[2] ?? process.cwd();
const loop = new ClaudeTmuxFoldLoop({
  cwd,
  sessionId: process.env.CLAUDE_SESSION_ID,
  model: process.env.CLAUDE_MODEL,
  mode: parseMode(process.env.WARP_CLAUDE_TMUX_FOLD),
  contextWindowTokens: optionalNumber(process.env.WARP_CONTEXT_WINDOW_TOKENS),
  authMode: process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? 'oauth'
    : (process.env.ANTHROPIC_API_KEY ? 'api-key' : 'inherit'),
  onSpawn: (info) => {
    console.error(`[cwd] tmux session: ${info.tmuxSessionName}`);
    console.error(`[cwd] attach: ${info.attachCommand}`);
  },
  onJsonl: (info) => {
    console.error(`[cwd] jsonl: ${info.path} (session=${info.sessionId})`);
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
      `[cwd] ${epoch.kind ?? 'unknown'} fold ${epoch.folded ? 'ok' : 'not written'}: ${epoch.reason}`,
    );
    if (epoch.write) console.error(`[cwd] wrote ${epoch.write.path}`);
  },
  onError: (err) => console.error(`[cwd] error: ${err.message}`),
});

const info = await loop.start();
console.error(`[cwd] Claude Code is running in tmux. Attach with: ${info.attachCommand}`);

process.once('SIGINT', () => {
  void loop.stop().finally(() => process.exit(130));
});
process.once('SIGTERM', () => {
  void loop.stop().finally(() => process.exit(143));
});
