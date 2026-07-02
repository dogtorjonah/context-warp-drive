/**
 * Standalone interactive Claude Code tmux fold loop.
 *
 * This is the human-normal sibling of `ClaudeCliFoldLoop`: it launches plain
 * interactive `claude` inside tmux (no `--print`), tails Claude Code's on-disk
 * JSONL transcript, tracks provider-measured usage from assistant message
 * records, and folds by killing/restarting the tmux session around an atomic
 * JSONL rewrite.
 */
import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BirthFoldSourceRow } from '../foldBirthHydration.ts';
import type { SyntheticContextOptions } from '../rollingFold.ts';
import {
  buildClaudeCliFold,
  buildClaudeCliHardEpochChain,
  encodeCwdForClaudeCode,
  resolveClaudeCliFoldSeedMaxChars,
  resolveClaudeCliFoldTargetTokens,
  resolveClaudeCliHardEpochCeilingTokens,
  resolveClaudeCliSessionJsonlPath,
  shouldReconstructClaudeCliEpoch,
  writeFoldedClaudeCliJsonl,
  type BuildClaudeCliFoldResult,
  type ClaudeCliHardEpochResult,
  type WriteFoldedClaudeCliJsonlResult,
} from '../providers/claudeCli.ts';
import {
  buildClaudeCliFoldLoopEnv,
  type ClaudeCliAuthMode,
  type ClaudeCliFoldLoopMode,
  type ClaudeCliFoldLoopUsage,
} from './claudeCliLoop.ts';

export type ClaudeTmuxFoldLoopMode = ClaudeCliFoldLoopMode;
export type ClaudeTmuxFoldEpochKind = 'tail' | 'hard';

export interface ClaudeTmuxFoldLoopSpawnInfo {
  readonly tmuxPath: string;
  readonly tmuxArgs: readonly string[];
  readonly tmuxSessionName: string;
  readonly attachCommand: string;
  readonly attachArgs: readonly string[];
  readonly cwd: string;
  readonly sessionId: string | null;
}

export interface ClaudeTmuxJsonlInfo {
  readonly path: string;
  readonly sessionId: string;
  readonly startOffset: number;
}

export interface ClaudeTmuxFoldLoopLineEvent {
  readonly path: string;
  readonly line: string;
  readonly raw: unknown;
  readonly type: string;
}

export interface ClaudeTmuxFoldLoopEpoch {
  readonly attempted: boolean;
  readonly folded: boolean;
  readonly mode: ClaudeTmuxFoldLoopMode;
  readonly kind: ClaudeTmuxFoldEpochKind | null;
  readonly measuredInputTokens: number;
  readonly contextWindowTokens: number;
  readonly triggerTokens: number;
  readonly hardEpochCeilingTokens: number | null;
  readonly sessionId: string | null;
  readonly dryRun: boolean;
  readonly reason: string;
  readonly frozenViewChars?: number;
  readonly frozenRawCount?: number;
  readonly write?: WriteFoldedClaudeCliJsonlResult;
}

export interface ClaudeTmuxFoldLoopOptions {
  /** Project cwd Claude Code runs in and stamps into JSONL lines. */
  readonly cwd: string;
  /** Existing Claude Code session id. When omitted, the loop discovers a new JSONL file. */
  readonly sessionId?: string | null;
  /** tmux executable. Default `tmux`. */
  readonly tmuxPath?: string;
  /** Claude executable. Default `claude`. */
  readonly claudePath?: string;
  /** tmux session name. Default derived from cwd/session. */
  readonly tmuxSessionName?: string;
  /** Claude model id passed to `--model` and stamped into folded assistant rows. */
  readonly model?: string | null;
  /** Context window for measured-token trigger math. Default 200k. */
  readonly contextWindowTokens?: number;
  readonly mode?: ClaudeTmuxFoldLoopMode;
  readonly transcript?: () => Promise<readonly BirthFoldSourceRow[]> | readonly BirthFoldSourceRow[];
  readonly initialRows?: readonly BirthFoldSourceRow[];
  readonly captureTranscript?: boolean;
  readonly projectsRoot?: string;
  readonly extraArgs?: readonly string[];
  /**
   * Path to a `--system-prompt-file` for the spawned Claude process. CACHE
   * CONTRACT: the file's BYTES must stay stable for the lifetime of this loop —
   * fold/crash respawns pass the same path, and Claude re-reads it at spawn, so
   * rewriting the contents between respawns changes the rendered system prompt
   * and misses the provider prompt cache at the tools/system boundary (~178K
   * wasted cache-write tokens per fold, measured on the voxxo relay before it
   * froze its per-session render — rail-9cf61211). Re-render only when
   * constructing a NEW loop (true rebirth/fork), never mid-session.
   */
  readonly systemPromptFile?: string;
  readonly mcpConfigFile?: string;
  readonly settingsFile?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly effort?: 'low' | 'medium' | 'high' | 'max' | string | null;
  /** Optional `--permission-mode`; omitted by default so human Claude behaves normally. */
  readonly permissionMode?: string | null;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly authMode?: ClaudeCliAuthMode;
  readonly oauthToken?: string | null;
  readonly apiKey?: string | null;
  readonly disableBundledSkills?: boolean;
  /** Auto-fold after a safe assistant/result JSONL boundary using measured usage. Default true. */
  readonly autoFold?: boolean;
  readonly dryRunWritesSidecar?: boolean;
  readonly recoverByRespawn?: boolean;
  readonly pollIntervalMs?: number;
  readonly discoveryTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly now?: () => number;
  readonly makeUuid?: () => string;
  readonly syntheticContext?: SyntheticContextOptions;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  readonly onSpawn?: (info: ClaudeTmuxFoldLoopSpawnInfo) => void;
  readonly onJsonl?: (info: ClaudeTmuxJsonlInfo) => void;
  readonly onLine?: (event: ClaudeTmuxFoldLoopLineEvent) => void;
  readonly onUsage?: (usage: ClaudeCliFoldLoopUsage) => void;
  readonly onEpoch?: (epoch: ClaudeTmuxFoldLoopEpoch) => void;
  readonly onError?: (error: Error) => void;
}

interface UsageLike {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
}

interface JsonlContentBlock {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly tool_use_id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly text?: unknown;
  readonly content?: unknown;
}

interface JsonlMessage {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly usage?: UsageLike;
  readonly model?: unknown;
}

interface JsonlObject {
  readonly type?: unknown;
  readonly uuid?: unknown;
  readonly sessionId?: unknown;
  readonly session_id?: unknown;
  readonly message?: JsonlMessage;
  readonly usage?: UsageLike;
  readonly isSidechain?: unknown;
  readonly isMeta?: unknown;
  readonly isCompactSummary?: unknown;
  readonly userType?: unknown;
}

interface JsonlSnapshotEntry {
  readonly size: number;
  readonly mtimeMs: number;
}

interface CommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const SYNTHETIC_MODEL = '<synthetic>';
const NO_RESPONSE_SENTINEL = 'No response requested.';

function finiteNumber(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function usageFrom(value: UsageLike | undefined): ClaudeCliFoldLoopUsage | null {
  if (!value) return null;
  const inputTokens = finiteNumber(value.input_tokens);
  const outputTokens = finiteNumber(value.output_tokens);
  const cacheReadInputTokens = finiteNumber(value.cache_read_input_tokens);
  const cacheCreationInputTokens = finiteNumber(value.cache_creation_input_tokens);
  const measuredInputTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  if (measuredInputTokens <= 0 && outputTokens <= 0) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    measuredInputTokens,
  };
}

function asJsonlObject(value: unknown): JsonlObject | null {
  return value && typeof value === 'object' ? value as JsonlObject : null;
}

function contentBlocks(message: JsonlMessage | undefined): JsonlContentBlock[] {
  const content = message?.content;
  if (Array.isArray(content)) return content.filter((item): item is JsonlContentBlock => Boolean(item) && typeof item === 'object');
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const block = item as JsonlContentBlock;
        if (typeof block.text === 'string') return block.text;
        if (typeof block.content === 'string') return block.content;
      }
      return JSON.stringify(item);
    }).filter((part): part is string => Boolean(part)).join('\n');
  }
  if (value == null) return '';
  return JSON.stringify(value) ?? String(value);
}

function createRow(
  ty: string,
  tx: string | null,
  ts: string,
  options: { tn?: string | null; ti?: unknown } = {},
): BirthFoldSourceRow {
  return {
    ty,
    tx,
    tn: options.tn ?? null,
    ti: options.ti,
    ts,
  };
}

function countMessageChars(messages: readonly { content: unknown }[]): number {
  return messages.reduce((sum, message) => sum + stringifyContent(message.content).length, 0);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function projectDirFor(cwd: string, root?: string): string {
  const base = root ?? join(homedir(), '.claude', 'projects');
  return join(base, encodeCwdForClaudeCode(cwd));
}

function sessionNameSeed(cwd: string, sessionId: string | null | undefined): string {
  const source = sessionId ?? cwd.split('/').filter(Boolean).at(-1) ?? 'claude';
  const cleaned = source.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48);
  return cleaned || 'claude';
}

export function buildClaudeTmuxClaudeArgs(options: {
  readonly model?: string | null;
  readonly sessionId?: string | null;
  readonly systemPromptFile?: string;
  readonly mcpConfigFile?: string;
  readonly settingsFile?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly effort?: string | null;
  readonly permissionMode?: string | null;
  readonly extraArgs?: readonly string[];
} = {}): string[] {
  const args: string[] = ['--verbose'];
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.systemPromptFile) args.push('--system-prompt-file', options.systemPromptFile);
  if (options.mcpConfigFile) {
    args.push('--mcp-config', options.mcpConfigFile);
    if (options.allowedTools && options.allowedTools.length > 0) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }
  }
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    args.push('--disallowedTools', options.disallowedTools.join(','));
  }
  if (options.settingsFile) args.push('--settings', options.settingsFile);
  args.push(...(options.extraArgs ?? []));
  if (options.sessionId) args.push('--resume', options.sessionId);
  return args;
}

export function buildClaudeTmuxSessionArgs(options: {
  readonly cwd: string;
  readonly tmuxSessionName: string;
  readonly claudePath?: string;
  readonly model?: string | null;
  readonly sessionId?: string | null;
  readonly systemPromptFile?: string;
  readonly mcpConfigFile?: string;
  readonly settingsFile?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly effort?: string | null;
  readonly permissionMode?: string | null;
  readonly extraArgs?: readonly string[];
}): string[] {
  const claude = options.claudePath ?? 'claude';
  const claudeArgs = buildClaudeTmuxClaudeArgs(options);
  const shellCommand = [claude, ...claudeArgs].map(shellQuote).join(' ');
  return ['new-session', '-d', '-s', options.tmuxSessionName, '-c', options.cwd, shellCommand];
}

export function buildClaudeTmuxAttachArgs(tmuxSessionName: string): string[] {
  return ['attach-session', '-t', tmuxSessionName];
}

export class ClaudeTmuxFoldLoop {
  private readonly options: ClaudeTmuxFoldLoopOptions;
  private readonly rows: BirthFoldSourceRow[];
  private readonly toolNamesById = new Map<string, string>();
  private readonly pendingToolIds = new Set<string>();
  private readonly seenUuids = new Set<string>();
  private processName: string;
  private sessionId: string | null;
  private jsonlPath: string | null = null;
  private jsonlOffset = 0;
  private jsonlBuffer = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryDeadline: ReturnType<typeof setTimeout> | null = null;
  private pollPromise: Promise<void> | null = null;
  private started = false;
  private lastMeasuredInputTokens = 0;
  private lastFoldAtTokens = 0;
  private foldInFlight: Promise<ClaudeTmuxFoldLoopEpoch> | null = null;
  private sessionWaiters: Array<{
    resolve: (info: ClaudeTmuxJsonlInfo) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }> = [];

  constructor(options: ClaudeTmuxFoldLoopOptions) {
    this.options = options;
    this.rows = [...(options.initialRows ?? [])];
    this.sessionId = options.sessionId ?? null;
    this.processName = options.tmuxSessionName ?? `cwd-${sessionNameSeed(options.cwd, options.sessionId)}`;
  }

  get tmuxSessionName(): string {
    return this.processName;
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  get sessionJsonlPath(): string | null {
    return this.jsonlPath;
  }

  get measuredInputTokens(): number {
    return this.lastMeasuredInputTokens;
  }

  getTranscriptRows(): readonly BirthFoldSourceRow[] {
    return this.rows.slice();
  }

  attachArgs(): string[] {
    return buildClaudeTmuxAttachArgs(this.processName);
  }

  attachCommand(): string {
    return [this.options.tmuxPath ?? 'tmux', ...this.attachArgs()].map(shellQuote).join(' ');
  }

  async start(): Promise<ClaudeTmuxFoldLoopSpawnInfo> {
    if (this.started) {
      return this.spawnInfo([]);
    }
    this.started = true;
    try {
      const snapshot = await this.snapshotProjectDir();
      const spawnInfo = await this.spawnTmuxSession(this.sessionId);
      this.beginJsonlDiscovery(snapshot);
      return spawnInfo;
    } catch (err) {
      this.started = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.stopPolling();
    this.rejectSessionWaiters(new Error('Claude tmux loop stopped before JSONL discovery completed'));
    if (!this.started) return;
    this.started = false;
    await this.killTmuxSession().catch((err) => {
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
  }

  async sendKeys(text: string, options: { enter?: boolean } = {}): Promise<void> {
    const args = ['send-keys', '-t', this.processName, text];
    if (options.enter !== false) args.push('Enter');
    await this.runTmux(args);
  }

  async waitForSessionJsonl(timeoutMs = this.options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS): Promise<ClaudeTmuxJsonlInfo> {
    if (this.jsonlPath && this.sessionId) {
      return { path: this.jsonlPath, sessionId: this.sessionId, startOffset: this.jsonlOffset };
    }
    return new Promise<ClaudeTmuxJsonlInfo>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: null as ReturnType<typeof setTimeout> | null,
      };
      waiter.timer = setTimeout(() => {
        this.sessionWaiters = this.sessionWaiters.filter((item) => item !== waiter);
        reject(new Error('Timed out waiting for Claude Code JSONL discovery'));
      }, timeoutMs);
      waiter.timer.unref?.();
      this.sessionWaiters.push(waiter);
    });
  }

  async pollJsonlNow(): Promise<void> {
    await this.pollJsonl();
  }

  async maybeFold(measuredInputTokens = this.lastMeasuredInputTokens): Promise<ClaudeTmuxFoldLoopEpoch> {
    const mode = this.options.mode ?? 'on';
    const contextWindowTokens = this.options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const triggerTokens = resolveClaudeCliFoldTargetTokens({
      model: this.options.model,
      contextWindowTokens,
      env: this.options.env,
    });
    const hardEpochCeilingTokens = resolveClaudeCliHardEpochCeilingTokens({
      model: this.options.model,
      contextWindowTokens,
      env: this.options.env,
    });
    const base = {
      attempted: false,
      folded: false,
      mode,
      kind: null,
      measuredInputTokens,
      contextWindowTokens,
      triggerTokens,
      hardEpochCeilingTokens,
      sessionId: this.sessionId,
      dryRun: mode === 'dry-run',
    } satisfies Omit<ClaudeTmuxFoldLoopEpoch, 'reason'>;

    if (mode === 'off') return this.emitEpoch({ ...base, reason: 'fold mode is off' });
    if (!this.sessionId) return this.emitEpoch({ ...base, reason: 'no Claude Code session id yet' });
    if (!Number.isFinite(measuredInputTokens) || measuredInputTokens <= 0) {
      return this.emitEpoch({ ...base, reason: 'no provider-measured input tokens' });
    }
    const due = shouldReconstructClaudeCliEpoch(measuredInputTokens, contextWindowTokens, {
      targetTokensBeforeFold: triggerTokens,
      lastReconstructedAtTokens: this.lastFoldAtTokens > 0 ? this.lastFoldAtTokens : undefined,
    });
    if (!due) return this.emitEpoch({ ...base, reason: 'below fold trigger or hysteresis interval' });

    if (!this.foldInFlight) {
      this.foldInFlight = this.performFold(measuredInputTokens, contextWindowTokens, triggerTokens, hardEpochCeilingTokens)
        .finally(() => {
          this.foldInFlight = null;
        });
    }
    return this.foldInFlight;
  }

  private async performFold(
    measuredInputTokens: number,
    contextWindowTokens: number,
    triggerTokens: number,
    hardEpochCeilingTokens: number | null,
  ): Promise<ClaudeTmuxFoldLoopEpoch> {
    const sessionId = this.sessionId;
    if (!sessionId) {
      return this.emitEpoch({
        attempted: false,
        folded: false,
        mode: this.options.mode ?? 'on',
        kind: null,
        measuredInputTokens,
        contextWindowTokens,
        triggerTokens,
        hardEpochCeilingTokens,
        sessionId: null,
        dryRun: this.options.mode === 'dry-run',
        reason: 'no Claude Code session id yet',
      });
    }

    const isHard = hardEpochCeilingTokens != null && measuredInputTokens >= hardEpochCeilingTokens;
    const rows = await this.resolveRows();
    const chainOptions = {
      sessionId,
      cwd: this.options.cwd,
      model: this.options.model,
      baseTimeMs: this.nowMs(),
      makeUuid: this.options.makeUuid,
    };
    const built: BuildClaudeCliFoldResult | ClaudeCliHardEpochResult = isHard
      ? buildClaudeCliHardEpochChain(rows, chainOptions)
      : buildClaudeCliFold(rows, {
          ...chainOptions,
          maxChars: resolveClaudeCliFoldSeedMaxChars(contextWindowTokens),
          syntheticContext: this.options.syntheticContext,
        });
    const frozenViewChars = countMessageChars(built.foldedMessages);
    const frozenRawCount = built.rawMessages.length;

    if (!built.chain.leafUuid) {
      return this.emitEpoch({
        attempted: true,
        folded: false,
        mode: this.options.mode ?? 'on',
        kind: isHard ? 'hard' : 'tail',
        measuredInputTokens,
        contextWindowTokens,
        triggerTokens,
        hardEpochCeilingTokens,
        sessionId,
        dryRun: this.options.mode === 'dry-run',
        reason: 'fold produced no non-empty Claude Code messages',
        frozenViewChars,
        frozenRawCount,
      });
    }

    const mode = this.options.mode ?? 'on';
    if (mode === 'dry-run') {
      const write = this.options.dryRunWritesSidecar === false
        ? undefined
        : await writeFoldedClaudeCliJsonl(built.foldedMessages, chainOptions, {
            root: this.options.projectsRoot,
            dryRun: true,
          });
      return this.emitEpoch({
        attempted: true,
        folded: true,
        mode,
        kind: isHard ? 'hard' : 'tail',
        measuredInputTokens,
        contextWindowTokens,
        triggerTokens,
        hardEpochCeilingTokens,
        sessionId,
        dryRun: true,
        reason: isHard ? 'dry-run hard epoch computed' : 'dry-run tail epoch computed',
        frozenViewChars,
        frozenRawCount,
        write,
      });
    }

    try {
      this.stopPolling();
      await this.killTmuxSession();
      const write = await writeFoldedClaudeCliJsonl(built.foldedMessages, chainOptions, {
        root: this.options.projectsRoot,
      });
      if (write.written) this.lastFoldAtTokens = measuredInputTokens;
      const stat = await fs.stat(write.path).catch(() => null);
      await this.spawnTmuxSession(sessionId);
      if (stat) this.attachJsonl({ path: write.path, sessionId, startOffset: stat.size });
      return this.emitEpoch({
        attempted: true,
        folded: write.written,
        mode,
        kind: isHard ? 'hard' : 'tail',
        measuredInputTokens,
        contextWindowTokens,
        triggerTokens,
        hardEpochCeilingTokens,
        sessionId,
        dryRun: false,
        reason: write.written
          ? (isHard ? 'hard epoch rewritten and resumed' : 'tail epoch rewritten and resumed')
          : 'writer left session untouched',
        frozenViewChars,
        frozenRawCount,
        write,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.options.recoverByRespawn !== false) {
        await this.spawnTmuxSession(sessionId).catch((recoverErr) => {
          const recoverError = recoverErr instanceof Error ? recoverErr : new Error(String(recoverErr));
          this.options.onError?.(recoverError);
        });
      }
      this.options.onError?.(error);
      throw error;
    }
  }

  private async spawnTmuxSession(sessionId: string | null): Promise<ClaudeTmuxFoldLoopSpawnInfo> {
    const args = buildClaudeTmuxSessionArgs({
      cwd: this.options.cwd,
      tmuxSessionName: this.processName,
      claudePath: this.options.claudePath,
      model: this.options.model,
      sessionId,
      systemPromptFile: this.options.systemPromptFile,
      mcpConfigFile: this.options.mcpConfigFile,
      settingsFile: this.options.settingsFile,
      allowedTools: this.options.allowedTools,
      disallowedTools: this.options.disallowedTools,
      effort: this.options.effort,
      permissionMode: this.options.permissionMode,
      extraArgs: this.options.extraArgs,
    });
    await this.runTmux(args);
    const info = this.spawnInfo(args);
    this.options.onSpawn?.(info);
    return info;
  }

  private spawnInfo(args: readonly string[]): ClaudeTmuxFoldLoopSpawnInfo {
    return {
      tmuxPath: this.options.tmuxPath ?? 'tmux',
      tmuxArgs: args,
      tmuxSessionName: this.processName,
      attachCommand: this.attachCommand(),
      attachArgs: this.attachArgs(),
      cwd: this.options.cwd,
      sessionId: this.sessionId,
    };
  }

  private async killTmuxSession(): Promise<void> {
    await this.runTmux(['kill-session', '-t', this.processName], { ignoreFailure: true });
  }

  private async runTmux(args: readonly string[], options: { ignoreFailure?: boolean } = {}): Promise<CommandResult> {
    const command = this.options.tmuxPath ?? 'tmux';
    const env = buildClaudeCliFoldLoopEnv(this.options.env, this.options);
    const spawner = this.options.spawnProcess ?? nodeSpawn;
    const proc = spawner(command, args, {
      cwd: this.options.cwd,
      env,
      stdio: 'pipe',
    });
    const result = await this.collectProcess(proc, this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    if (!options.ignoreFailure && result.code !== 0) {
      throw new Error(
        `tmux command failed (${command} ${args.join(' ')}): ` +
          `${result.stderr.trim() || `exit ${String(result.code)} signal ${String(result.signal)}`}`,
      );
    }
    return result;
  }

  private collectProcess(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        finish(() => reject(new Error('tmux command timed out')));
      }, timeoutMs);
      timer.unref?.();
      proc.stdout.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
      proc.once('error', (err) => finish(() => reject(err)));
      proc.once('exit', (code, signal) => {
        finish(() => resolve({ code, signal, stdout, stderr }));
      });
    });
  }

  private async snapshotProjectDir(): Promise<Map<string, JsonlSnapshotEntry>> {
    const projectDir = projectDirFor(this.options.cwd, this.options.projectsRoot);
    const snapshot = new Map<string, JsonlSnapshotEntry>();
    try {
      const entries = await fs.readdir(projectDir);
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const fullPath = join(projectDir, entry);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat) snapshot.set(entry, { size: stat.size, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // The project dir often does not exist until Claude writes its first line.
    }
    return snapshot;
  }

  private beginJsonlDiscovery(snapshot: ReadonlyMap<string, JsonlSnapshotEntry>): void {
    this.stopDiscoveryOnly();
    void this.tryDiscoverJsonl(snapshot).catch((err) => this.options.onError?.(err instanceof Error ? err : new Error(String(err))));
    this.discoveryTimer = setInterval(() => {
      void this.tryDiscoverJsonl(snapshot).catch((err) => this.options.onError?.(err instanceof Error ? err : new Error(String(err))));
    }, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.discoveryTimer.unref?.();
    this.discoveryDeadline = setTimeout(() => {
      this.stopDiscoveryOnly();
      this.rejectSessionWaiters(new Error('Timed out waiting for Claude Code JSONL discovery'));
    }, this.options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
    this.discoveryDeadline.unref?.();
  }

  private async tryDiscoverJsonl(snapshot: ReadonlyMap<string, JsonlSnapshotEntry>): Promise<void> {
    if (this.jsonlPath) {
      this.stopDiscoveryOnly();
      return;
    }
    if (this.sessionId) {
      const directPath = resolveClaudeCliSessionJsonlPath(this.sessionId, this.options.cwd, this.options.projectsRoot);
      const stat = await fs.stat(directPath).catch(() => null);
      if (stat) {
        this.attachJsonl({ path: directPath, sessionId: this.sessionId, startOffset: this.shouldReplayExistingJsonl() ? 0 : stat.size });
        return;
      }
    }

    const projectDir = projectDirFor(this.options.cwd, this.options.projectsRoot);
    let best: { path: string; sessionId: string; statMtime: number } | null = null;
    const entries = await fs.readdir(projectDir).catch(() => []);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const fullPath = join(projectDir, entry);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) continue;
      const previous = snapshot.get(entry);
      if (previous && stat.size <= previous.size) continue;
      if (!best || stat.mtimeMs > best.statMtime) {
        best = {
          path: fullPath,
          sessionId: entry.slice(0, -'.jsonl'.length),
          statMtime: stat.mtimeMs,
        };
      }
    }
    if (best) {
      this.sessionId = best.sessionId;
      this.attachJsonl({ path: best.path, sessionId: best.sessionId, startOffset: 0 });
    }
  }

  private attachJsonl(info: ClaudeTmuxJsonlInfo): void {
    this.stopDiscoveryOnly();
    this.jsonlPath = info.path;
    this.sessionId = info.sessionId;
    this.jsonlOffset = info.startOffset;
    this.jsonlBuffer = '';
    this.options.onJsonl?.(info);
    this.resolveSessionWaiters(info);
    this.startPolling();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollJsonl().catch((err) => this.options.onError?.(err instanceof Error ? err : new Error(String(err))));
    }, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
    void this.pollJsonl().catch((err) => this.options.onError?.(err instanceof Error ? err : new Error(String(err))));
  }

  private stopPolling(): void {
    this.stopDiscoveryOnly();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private stopDiscoveryOnly(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.discoveryDeadline) {
      clearTimeout(this.discoveryDeadline);
      this.discoveryDeadline = null;
    }
  }

  private async pollJsonl(): Promise<void> {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.pollJsonlInner().finally(() => {
      this.pollPromise = null;
    });
    return this.pollPromise;
  }

  private async pollJsonlInner(): Promise<void> {
    if (!this.jsonlPath) return;
    const stat = await fs.stat(this.jsonlPath).catch(() => null);
    if (!stat) return;
    if (stat.size < this.jsonlOffset) {
      this.jsonlOffset = 0;
      this.jsonlBuffer = '';
    }
    if (stat.size === this.jsonlOffset) return;
    const text = await this.readRange(this.jsonlPath, this.jsonlOffset, stat.size);
    this.jsonlOffset = stat.size;
    this.consumeJsonlText(text);
  }

  private async readRange(filePath: string, start: number, end: number): Promise<string> {
    const length = end - start;
    if (length <= 0) return '';
    const handle = await fs.open(filePath, 'r');
    try {
      const chunks: Buffer[] = [];
      let remaining = length;
      let offset = start;
      while (remaining > 0) {
        const size = Math.min(remaining, 64 * 1024);
        const buffer = Buffer.allocUnsafe(size);
        const { bytesRead } = await handle.read(buffer, 0, size, offset);
        if (bytesRead <= 0) break;
        chunks.push(buffer.subarray(0, bytesRead));
        remaining -= bytesRead;
        offset += bytesRead;
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  private consumeJsonlText(text: string): void {
    this.jsonlBuffer += text;
    if (!this.jsonlBuffer.includes('\n')) return;
    const lines = this.jsonlBuffer.split('\n');
    this.jsonlBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleJsonlLine(trimmed);
    }
  }

  private handleJsonlLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const event = asJsonlObject(parsed);
    const type = typeof event?.type === 'string'
      ? event.type
      : (typeof event?.message?.role === 'string' ? event.message.role : 'unknown');
    if (event?.uuid && typeof event.uuid === 'string') {
      if (this.seenUuids.has(event.uuid)) return;
      this.seenUuids.add(event.uuid);
      if (this.seenUuids.size > 5000) {
        const kept = [...this.seenUuids].slice(-2500);
        this.seenUuids.clear();
        for (const uuid of kept) this.seenUuids.add(uuid);
      }
    }
    if (event) {
      const lineSessionId = typeof event.sessionId === 'string'
        ? event.sessionId
        : (typeof event.session_id === 'string' ? event.session_id : null);
      if (lineSessionId) this.sessionId = lineSessionId;
    }
    if (this.jsonlPath) this.options.onLine?.({ path: this.jsonlPath, line, raw: parsed, type });

    if (!event) return;
    if (type === 'assistant' || event.message?.role === 'assistant') {
      this.captureAssistantLine(event);
      return;
    }
    if (type === 'user' || event.message?.role === 'user') {
      this.captureUserLine(event);
      return;
    }
    if (type === 'result') {
      const usage = usageFrom(event.usage);
      if (usage) this.recordUsage(usage);
      if (this.options.autoFold !== false) {
        void this.maybeFold(this.lastMeasuredInputTokens).catch((err) => {
          this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
        });
      }
    }
  }

  private captureAssistantLine(event: JsonlObject): void {
    if (event.isSidechain === true) return;
    const blocks = contentBlocks(event.message);
    if (
      event.message?.model === SYNTHETIC_MODEL
      && blocks.length === 1
      && blocks[0]?.type === 'text'
      && typeof blocks[0].text === 'string'
      && blocks[0].text.trim() === NO_RESPONSE_SENTINEL
    ) {
      return;
    }

    let hasToolUse = false;
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        this.captureRow(createRow('assistant_text', block.text, this.isoNow()));
      } else if (block.type === 'tool_use') {
        hasToolUse = true;
        const id = typeof block.id === 'string' ? block.id : '';
        const name = typeof block.name === 'string' ? block.name : 'tool';
        if (id) {
          this.toolNamesById.set(id, name);
          this.pendingToolIds.add(id);
        }
        this.captureRow(createRow('tool_use', null, this.isoNow(), { tn: name, ti: block.input }));
      }
    }

    const usage = usageFrom(event.message?.usage);
    if (usage) this.recordUsage(usage);
    if (usage && !hasToolUse && this.pendingToolIds.size === 0 && this.options.autoFold !== false) {
      void this.maybeFold(usage.measuredInputTokens).catch((err) => {
        this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }
  }

  private captureUserLine(event: JsonlObject): void {
    if (event.isMeta === true || event.isSidechain === true || event.isCompactSummary === true) return;
    const userType = typeof event.userType === 'string' ? event.userType : undefined;
    if (userType && userType !== 'external') return;
    const blocks = contentBlocks(event.message);
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const id = typeof block.tool_use_id === 'string'
          ? block.tool_use_id
          : (typeof block.id === 'string' ? block.id : '');
        const name = id ? this.toolNamesById.get(id) ?? 'tool_result' : 'tool_result';
        if (id) this.pendingToolIds.delete(id);
        this.captureRow(createRow('tool_result', stringifyContent(block.content), this.isoNow(), { tn: name }));
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        this.captureRow(createRow('user', block.text, this.isoNow()));
      }
    }
  }

  private captureRow(row: BirthFoldSourceRow): void {
    if (this.options.captureTranscript === false) return;
    this.rows.push(row);
  }

  private recordUsage(usage: ClaudeCliFoldLoopUsage): void {
    this.lastMeasuredInputTokens = usage.measuredInputTokens;
    this.options.onUsage?.(usage);
  }

  private async resolveRows(): Promise<readonly BirthFoldSourceRow[]> {
    if (typeof this.options.transcript === 'function') {
      return this.options.transcript();
    }
    if (Array.isArray(this.options.transcript)) {
      return this.options.transcript;
    }
    return this.rows.slice();
  }

  private shouldReplayExistingJsonl(): boolean {
    if (this.options.captureTranscript === false) return false;
    if (this.options.transcript) return false;
    return (this.options.initialRows?.length ?? 0) === 0;
  }

  private resolveSessionWaiters(info: ClaudeTmuxJsonlInfo): void {
    const waiters = this.sessionWaiters;
    this.sessionWaiters = [];
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(info);
    }
  }

  private rejectSessionWaiters(err: Error): void {
    const waiters = this.sessionWaiters;
    this.sessionWaiters = [];
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  private emitEpoch(epoch: ClaudeTmuxFoldLoopEpoch): ClaudeTmuxFoldLoopEpoch {
    this.options.onEpoch?.(epoch);
    return epoch;
  }

  private isoNow(): string {
    return new Date(this.nowMs()).toISOString();
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export async function ensureClaudeTmuxProjectDir(cwd: string, root?: string): Promise<string> {
  const dir = projectDirFor(cwd, root);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
