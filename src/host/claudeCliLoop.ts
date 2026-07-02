/**
 * Standalone Claude Code CLI fold loop.
 *
 * This is the "set it up" layer for `providers/claude-cli`: it owns the live
 * `claude --print --input-format stream-json --output-format stream-json`
 * subprocess, tracks provider-measured context usage from stream-json events,
 * decides when a tail or hard epoch is due, builds the folded JSONL chain before
 * teardown, rewrites the session file atomically, and respawns with `--resume`.
 */
import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import type { BirthFoldSourceRow } from '../foldBirthHydration.ts';
import type { SyntheticContextOptions } from '../rollingFold.ts';
import {
  buildClaudeCliFold,
  buildClaudeCliHardEpochChain,
  resolveClaudeCliFoldSeedMaxChars,
  resolveClaudeCliFoldTargetTokens,
  resolveClaudeCliHardEpochCeilingTokens,
  shouldReconstructClaudeCliEpoch,
  writeFoldedClaudeCliJsonl,
  type BuildClaudeCliFoldResult,
  type ClaudeCliHardEpochResult,
  type WriteFoldedClaudeCliJsonlResult,
} from '../providers/claudeCli.ts';

export type ClaudeCliFoldLoopMode = 'on' | 'dry-run' | 'off';
export type ClaudeCliFoldEpochKind = 'tail' | 'hard';
export type ClaudeCliAuthMode = 'inherit' | 'oauth' | 'api-key';

export interface ClaudeCliFoldLoopUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  /** Provider-measured prompt occupancy used for fold decisions. */
  readonly measuredInputTokens: number;
}

export interface ClaudeCliFoldLoopEvent {
  readonly type: string;
  readonly raw: unknown;
  readonly line: string;
}

export interface ClaudeCliFoldLoopSpawnInfo {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly sessionId: string | null;
}

export interface ClaudeCliFoldLoopEpoch {
  readonly attempted: boolean;
  readonly folded: boolean;
  readonly mode: ClaudeCliFoldLoopMode;
  readonly kind: ClaudeCliFoldEpochKind | null;
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

export interface ClaudeCliFoldLoopOptions {
  /** Project cwd Claude Code runs in and stamps into JSONL lines. */
  readonly cwd: string;
  /** Existing Claude Code session id; learned from stream-json `system` events when omitted. */
  readonly sessionId?: string | null;
  /** Claude executable. Default `claude`. */
  readonly claudePath?: string;
  /** Claude model id passed to `--model` and stamped into folded assistant rows. */
  readonly model?: string | null;
  /** Context window for measured-token trigger math. Default 200k. */
  readonly contextWindowTokens?: number;
  /** Folding mode. `dry-run` computes and optionally writes `<session>.jsonl.dryrun`. */
  readonly mode?: ClaudeCliFoldLoopMode;
  /** Raw transcript rows. If omitted, the loop captures rows from stream-json events. */
  readonly transcript?: () => Promise<readonly BirthFoldSourceRow[]> | readonly BirthFoldSourceRow[];
  /** Initial raw rows for the built-in capture buffer. */
  readonly initialRows?: readonly BirthFoldSourceRow[];
  /** Disable built-in transcript capture when an external transcript source owns raw rows. */
  readonly captureTranscript?: boolean;
  /** Claude projects root override for tests. Default `~/.claude/projects`. */
  readonly projectsRoot?: string;
  /** Pass extra args after the standard stream-json args and before `--resume`. */
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
  /** Spawn env override. See authMode for OAuth/API-key sanitization. */
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly authMode?: ClaudeCliAuthMode;
  readonly oauthToken?: string | null;
  readonly apiKey?: string | null;
  /** Default true: strips bundled skills catalog from Claude Code's prompt. */
  readonly disableBundledSkills?: boolean;
  /** Auto-fold after a `result` event using measured stream-json usage. Default true. */
  readonly autoFold?: boolean;
  /** In dry-run mode, write `<session>.jsonl.dryrun` for inspection. Default true. */
  readonly dryRunWritesSidecar?: boolean;
  /** Respawn original session if rewrite fails after teardown. Default true. */
  readonly recoverByRespawn?: boolean;
  readonly killSignal?: NodeJS.Signals;
  readonly killTimeoutMs?: number;
  readonly spawnTimeoutMs?: number;
  readonly now?: () => number;
  readonly makeUuid?: () => string;
  readonly syntheticContext?: SyntheticContextOptions;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  readonly onEvent?: (event: ClaudeCliFoldLoopEvent) => void;
  readonly onUsage?: (usage: ClaudeCliFoldLoopUsage) => void;
  readonly onSpawn?: (info: ClaudeCliFoldLoopSpawnInfo) => void;
  readonly onEpoch?: (epoch: ClaudeCliFoldLoopEpoch) => void;
  readonly onError?: (error: Error) => void;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const DEFAULT_SPAWN_TIMEOUT_MS = 20_000;
const DEFAULT_KILL_TIMEOUT_MS = 2_500;

interface UsageLike {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
}

interface EventObject {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly session_id?: unknown;
  readonly sessionId?: unknown;
  readonly message?: {
    readonly content?: unknown;
    readonly usage?: UsageLike;
  };
  readonly usage?: UsageLike;
}

interface ToolUseBlock {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly tool_use_id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly text?: unknown;
  readonly content?: unknown;
}

export function buildClaudeCliFoldLoopEnv(
  base: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  options: Pick<
    ClaudeCliFoldLoopOptions,
    'authMode' | 'oauthToken' | 'apiKey' | 'disableBundledSkills'
  > = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const authMode = options.authMode ?? 'inherit';
  if (authMode === 'oauth') {
    if (options.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = options.oauthToken;
    delete env.ANTHROPIC_API_KEY;
  } else if (authMode === 'api-key') {
    if (options.apiKey) env.ANTHROPIC_API_KEY = options.apiKey;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (options.disableBundledSkills !== false) {
    env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = '1';
  }
  return env;
}

export function buildClaudeCliFoldLoopArgs(options: {
  readonly model?: string | null;
  readonly sessionId?: string | null;
  readonly systemPromptFile?: string;
  readonly mcpConfigFile?: string;
  readonly settingsFile?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly effort?: string | null;
  readonly extraArgs?: readonly string[];
} = {}): string[] {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
  ];
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
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

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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

function asEventObject(value: unknown): EventObject | null {
  return value && typeof value === 'object' ? value as EventObject : null;
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const block = item as ToolUseBlock;
        if (typeof block.text === 'string') return block.text;
        if (typeof block.content === 'string') return block.content;
      }
      return JSON.stringify(item);
    }).filter((part): part is string => Boolean(part)).join('\n');
  }
  if (value == null) return '';
  return JSON.stringify(value) ?? String(value);
}

function countMessageChars(messages: readonly { content: unknown }[]): number {
  return messages.reduce((sum, message) => sum + stringifyContent(message.content).length, 0);
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

export class ClaudeCliFoldLoop {
  private readonly options: ClaudeCliFoldLoopOptions;
  private readonly rows: BirthFoldSourceRow[];
  private readonly toolNamesById = new Map<string, string>();
  private process: ChildProcessWithoutNullStreams | null = null;
  private lineBuffer = '';
  private sessionId: string | null;
  private lastMeasuredInputTokens = 0;
  private lastFoldAtTokens = 0;
  private foldInFlight: Promise<ClaudeCliFoldLoopEpoch> | null = null;
  private starting: Promise<void> | null = null;

  constructor(options: ClaudeCliFoldLoopOptions) {
    this.options = options;
    this.rows = [...(options.initialRows ?? [])];
    this.sessionId = options.sessionId ?? null;
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  get measuredInputTokens(): number {
    return this.lastMeasuredInputTokens;
  }

  getTranscriptRows(): readonly BirthFoldSourceRow[] {
    return this.rows.slice();
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.spawnProcess();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async stop(): Promise<void> {
    await this.stopProcess();
  }

  async sendUserText(text: string): Promise<void> {
    if (this.foldInFlight) await this.foldInFlight.catch(() => undefined);
    if (!this.process) await this.start();
    this.captureRow(createRow('user', text, this.isoNow()));
    await this.writeJsonLine({ type: 'user', message: { role: 'user', content: text } });
  }

  async sendJsonLine(payload: unknown): Promise<void> {
    if (this.foldInFlight) await this.foldInFlight.catch(() => undefined);
    if (!this.process) await this.start();
    await this.writeJsonLine(payload);
  }

  async maybeFold(measuredInputTokens = this.lastMeasuredInputTokens): Promise<ClaudeCliFoldLoopEpoch> {
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
    } satisfies Omit<ClaudeCliFoldLoopEpoch, 'reason'>;

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
  ): Promise<ClaudeCliFoldLoopEpoch> {
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
      await this.stopProcess();
      const write = await writeFoldedClaudeCliJsonl(built.foldedMessages, chainOptions, {
        root: this.options.projectsRoot,
      });
      if (write.written) this.lastFoldAtTokens = measuredInputTokens;
      await this.spawnProcess();
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
        await this.spawnProcess().catch((recoverErr) => {
          const recoverError = recoverErr instanceof Error ? recoverErr : new Error(String(recoverErr));
          this.options.onError?.(recoverError);
        });
      }
      this.options.onError?.(error);
      throw error;
    }
  }

  private async spawnProcess(): Promise<void> {
    await this.stopProcess();
    const command = this.options.claudePath ?? 'claude';
    const args = buildClaudeCliFoldLoopArgs({
      model: this.options.model,
      sessionId: this.sessionId,
      systemPromptFile: this.options.systemPromptFile,
      mcpConfigFile: this.options.mcpConfigFile,
      settingsFile: this.options.settingsFile,
      allowedTools: this.options.allowedTools,
      disallowedTools: this.options.disallowedTools,
      effort: this.options.effort,
      extraArgs: this.options.extraArgs,
    });
    const env = buildClaudeCliFoldLoopEnv(this.options.env, this.options);
    const spawner = this.options.spawnProcess ?? nodeSpawn;
    const proc = spawner(command, args, {
      cwd: this.options.cwd,
      env,
      stdio: 'pipe',
    });
    this.process = proc;
    this.lineBuffer = '';
    this.options.onSpawn?.({ command, args, cwd: this.options.cwd, sessionId: this.sessionId });

    proc.stdout.on('data', (chunk: Buffer | string) => this.handleStdoutChunk(chunk));
    proc.stderr.on('data', (chunk: Buffer | string) => {
      const line = chunk.toString();
      if (line.trim()) this.options.onEvent?.({ type: 'stderr', raw: line, line });
    });
    proc.once('exit', () => {
      if (this.process === proc) this.process = null;
    });
    proc.once('error', (err) => {
      this.options.onError?.(err);
    });

    await this.waitForSessionReady(proc);
  }

  private async stopProcess(): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    this.process = null;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        finish();
      }, this.options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS);
      proc.once('exit', finish);
      try {
        proc.kill(this.options.killSignal ?? 'SIGINT');
      } catch {
        finish();
      }
    });
  }

  private waitForSessionReady(proc: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.sessionId) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let poll: ReturnType<typeof setInterval> | null = null;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (poll) clearInterval(poll);
        proc.off('exit', onExit);
        if (err) reject(err);
        else resolve();
      };
      const onExit = () => finish(new Error('Claude Code CLI exited before reporting a session id'));
      const timer = setTimeout(
        () => finish(new Error('Timed out waiting for Claude Code CLI system session_id')),
        this.options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS,
      );
      proc.once('exit', onExit);
      poll = setInterval(() => {
        if (this.sessionId) {
          finish();
        }
      }, 10);
      timer.unref?.();
      poll.unref?.();
    });
  }

  private handleStdoutChunk(chunk: Buffer | string): void {
    this.lineBuffer += chunk.toString();
    if (!this.lineBuffer.includes('\n')) return;
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleLine(trimmed);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const event = asEventObject(parsed);
    const type = typeof event?.type === 'string' ? event.type : 'unknown';
    this.options.onEvent?.({ type, raw: parsed, line });

    if (event && (type === 'system')) {
      const sessionId = typeof event.session_id === 'string'
        ? event.session_id
        : (typeof event.sessionId === 'string' ? event.sessionId : null);
      if (sessionId) this.sessionId = sessionId;
      return;
    }

    if (event && type === 'assistant') {
      this.captureAssistantEvent(event);
      const usage = usageFrom(event.message?.usage);
      if (usage) this.recordUsage(usage);
      return;
    }

    if (event && type === 'user') {
      this.captureUserEvent(event);
      return;
    }

    if (event && type === 'result') {
      const usage = usageFrom(event.usage);
      if (usage) this.recordUsage(usage);
      if (this.options.autoFold !== false) {
        void this.maybeFold(this.lastMeasuredInputTokens).catch((err) => {
          this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
        });
      }
    }
  }

  private recordUsage(usage: ClaudeCliFoldLoopUsage): void {
    this.lastMeasuredInputTokens = usage.measuredInputTokens;
    this.options.onUsage?.(usage);
  }

  private captureAssistantEvent(event: EventObject): void {
    if (this.options.captureTranscript === false) return;
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const block = item as ToolUseBlock;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        this.captureRow(createRow('assistant_text', block.text, this.isoNow()));
      } else if (block.type === 'tool_use') {
        const id = typeof block.id === 'string' ? block.id : '';
        const name = typeof block.name === 'string' ? block.name : 'tool';
        if (id) this.toolNamesById.set(id, name);
        this.captureRow(createRow('tool_use', null, this.isoNow(), { tn: name, ti: block.input }));
      }
    }
  }

  private captureUserEvent(event: EventObject): void {
    if (this.options.captureTranscript === false) return;
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const block = item as ToolUseBlock;
      if (block.type !== 'tool_result') continue;
      const id = typeof block.tool_use_id === 'string'
        ? block.tool_use_id
        : (typeof block.id === 'string' ? block.id : '');
      const name = id ? this.toolNamesById.get(id) ?? 'tool_result' : 'tool_result';
      this.captureRow(createRow('tool_result', stringifyContent(block.content), this.isoNow(), { tn: name }));
    }
  }

  private captureRow(row: BirthFoldSourceRow): void {
    if (this.options.captureTranscript === false) return;
    this.rows.push(row);
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

  private async writeJsonLine(payload: unknown): Promise<void> {
    const proc = this.process;
    if (!proc?.stdin.writable) throw new Error('Claude Code CLI stdin is not writable');
    await new Promise<void>((resolve, reject) => {
      proc.stdin.write(`${JSON.stringify(payload)}\n`, (err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private isoNow(): string {
    return new Date(this.nowMs()).toISOString();
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }

  private emitEpoch(epoch: ClaudeCliFoldLoopEpoch): ClaudeCliFoldLoopEpoch {
    this.options.onEpoch?.(epoch);
    return epoch;
  }
}
