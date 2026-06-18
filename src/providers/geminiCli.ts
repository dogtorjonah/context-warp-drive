/**
 * Gemini CLI folding adapter for context-warp-drive.
 *
 * This mirrors the Voxxo relay's Gemini CLI fold seam without depending on the
 * relay runtime: measured-token trigger policy, FoldMessage -> gemini-cli JSONL
 * message conversion, User Message Vault append semantics, token high-water
 * scanning, and safe JSONL rewrite helpers.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  checkFoldTrigger,
  countChars,
  foldContext,
  resolveFoldConfigForBand,
  type FoldConfig,
  type FoldMessage,
  type FoldResult,
} from '../rollingFold.ts';

export const DEFAULT_GEMINI_CLI_FOLD_TARGET_TOKENS = 250_000;
export const DEFAULT_GEMINI_CLI_FOLD_BAND_TOKENS = 100_000;
export const DEFAULT_GEMINI_CLI_CONTEXT_WINDOW_TOKENS = 1_048_576;
export const GEMINI_CLI_FOLD_BAND_FRACTION = 0.7;
export const GEMINI_CLI_TOKEN_RECENT_WINDOW = 6;
export const GEMINI_CLI_TAIL_READ_BYTES = 512 * 1024;
export const GEMINI_CLI_HEADER_READ_BYTES = 8192;
export const GEMINI_CLI_CHATS_GLOB_ROOT = '.gemini/tmp';

export const GEMINI_CLI_FOLD_CONTINUATION_PROMPT = [
  '[System Note: Your context crossed the fold trigger and was compressed for efficiency.',
  'Your full history, intent, and continuity are preserved (rolling-fold skeleton + Verbatim Keep + recall).',
  'Seamlessly continue your work from exactly where you left off - do not repeat your prior output;',
  'resume your sentence, tool call, or task directly. If you have genuinely finished everything and there',
  'is nothing left to do, you may stop here - that is your real idle.]',
].join('\n');

export interface GeminiCliFoldMessage {
  id: string;
  timestamp: string;
  type: 'gemini' | 'user';
  content: Array<{ text: string }>;
}

export type GeminiCliRollingFoldMode = 'on' | 'off' | 'dry-run';

export type GeminiCliFoldEnv = Record<string, string | undefined>;

export interface GeminiCliMeasuredTokens {
  input: number;
  output: number;
  cached: number;
  total: number;
}

export interface GeminiCliFoldPolicy {
  mode: GeminiCliRollingFoldMode;
  targetTokens: number;
  bandTokens: number;
  contextWindowTokens: number;
  effectiveTriggerTokens: number;
  foldConfig: FoldConfig;
  measuredInputTokens: number | null;
  shouldFold: boolean;
}

export interface BuildGeminiCliFoldViewOptions {
  baseTime?: number | Date | string;
  bandTokens?: number;
  foldConfig?: FoldConfig;
  idFactory?: () => string;
}

export interface BuildGeminiCliFoldViewResult {
  geminiMessages: GeminiCliFoldMessage[];
  rawGeminiMessages: GeminiCliFoldMessage[];
  rawCount: number;
  foldedMessages: FoldMessage[];
  rawMessages: FoldMessage[];
  fold: FoldResult | null;
  stats: {
    shouldFold: boolean;
    turnsToFold: number;
    foldReason: string;
    originalChars: number;
    foldedChars: number;
    savingsPercent: number;
  };
}

export interface WriteFoldedGeminiCliJsonlOptions {
  dryRun?: boolean;
  root?: string;
  rawGeminiMessages?: readonly unknown[];
  now?: () => Date;
  tempIdFactory?: () => string;
}

export function resolveGeminiCliFoldTriggerTokens(targetTokens: number, contextWindow: number): number {
  return contextWindow > 0
    ? Math.min(targetTokens, Math.round(contextWindow * GEMINI_CLI_FOLD_BAND_FRACTION))
    : targetTokens;
}

export function resolveGeminiCliFoldMode(
  configured?: GeminiCliRollingFoldMode | null,
  env: GeminiCliFoldEnv = process.env,
): GeminiCliRollingFoldMode {
  if (configured === 'on' || configured === 'off' || configured === 'dry-run') {
    return configured;
  }
  const value = env.VOXXO_GEMINI_CLI_FOLD?.toLowerCase();
  if (value === 'off' || value === 'false') return 'off';
  if (value === 'dry-run') return 'dry-run';
  return 'on';
}

export function getPositiveIntEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
  const value = env[name];
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export function resolveGeminiCliFoldPolicy(options: {
  configuredMode?: GeminiCliRollingFoldMode | null;
  measuredInputTokens?: number | null;
  contextWindowTokens?: number;
  targetTokens?: number;
  bandTokens?: number;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
} = {}): GeminiCliFoldPolicy {
  const env = options.env ?? process.env;
  const mode = resolveGeminiCliFoldMode(options.configuredMode, env);
  const targetTokens = options.targetTokens
    ?? getPositiveIntEnv('VOXXO_GEMINI_CLI_FOLD_TARGET_TOKENS', DEFAULT_GEMINI_CLI_FOLD_TARGET_TOKENS, env);
  const bandTokens = options.bandTokens
    ?? getPositiveIntEnv('VOXXO_GEMINI_CLI_FOLD_BAND_TOKENS', DEFAULT_GEMINI_CLI_FOLD_BAND_TOKENS, env);
  const contextWindowTokens = options.contextWindowTokens ?? DEFAULT_GEMINI_CLI_CONTEXT_WINDOW_TOKENS;
  const effectiveTriggerTokens = resolveGeminiCliFoldTriggerTokens(targetTokens, contextWindowTokens);
  const measuredInputTokens = typeof options.measuredInputTokens === 'number'
    && Number.isFinite(options.measuredInputTokens)
    ? options.measuredInputTokens
    : null;

  return {
    mode,
    targetTokens,
    bandTokens,
    contextWindowTokens,
    effectiveTriggerTokens,
    foldConfig: resolveFoldConfigForBand(bandTokens),
    measuredInputTokens,
    shouldFold: mode !== 'off'
      && measuredInputTokens !== null
      && measuredInputTokens >= effectiveTriggerTokens,
  };
}

export function flattenFoldContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'text' in item) {
        const text = (item as { text?: unknown }).text;
        return typeof text === 'string' ? text : String(text ?? '');
      }
      return JSON.stringify(item) ?? String(item);
    }).join('\n');
  }
  if (content !== null && content !== undefined) return String(content);
  return '';
}

function defaultIdFactory(): string {
  return `msg-${randomBytes(8).toString('base64url').slice(0, 10)}`;
}

function normalizeBaseTime(baseTime: number | Date | string | undefined): number {
  if (baseTime instanceof Date) return baseTime.getTime();
  if (typeof baseTime === 'string') return new Date(baseTime).getTime();
  if (typeof baseTime === 'number') return baseTime;
  return Date.now();
}

export function foldedMessagesToGeminiCliMessages(
  foldedMessages: readonly FoldMessage[],
  baseTime: number | Date | string = Date.now(),
  options: { idFactory?: () => string } = {},
): GeminiCliFoldMessage[] {
  const startMs = normalizeBaseTime(baseTime);
  const idFactory = options.idFactory ?? defaultIdFactory;
  return foldedMessages.map((msg, index) => {
    const isAssistant = msg.role === 'assistant' || msg.role === 'model';
    return {
      id: idFactory(),
      timestamp: new Date(startMs + index * 1000).toISOString(),
      type: isAssistant ? 'gemini' : 'user',
      content: [{ text: flattenFoldContent(msg.content) }],
    };
  });
}

export function appendUserMessageVaultToGeminiCliView(
  messages: GeminiCliFoldMessage[],
  vault: string,
): GeminiCliFoldMessage[] {
  if (!vault) return messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.type !== 'user') continue;
    const hasText = message.content.some(
      (part) => typeof part?.text === 'string' && part.text.trim().length > 0,
    );
    if (!hasText) continue;
    const next = messages.slice();
    next[i] = { ...message, content: [...message.content, { text: vault }] };
    return next;
  }
  return messages;
}

export function buildGeminiCliFoldView(
  messages: readonly FoldMessage[],
  options: BuildGeminiCliFoldViewOptions = {},
): BuildGeminiCliFoldViewResult {
  const rawMessages = messages.slice();
  const foldConfig = options.foldConfig ?? resolveFoldConfigForBand(
    options.bandTokens ?? DEFAULT_GEMINI_CLI_FOLD_BAND_TOKENS,
  );
  const trigger = checkFoldTrigger(rawMessages, foldConfig);
  const fold = trigger.shouldFold
    ? foldContext(rawMessages, trigger.turnsToFold, foldConfig)
    : null;
  const foldedMessages = fold ? fold.messages : rawMessages;
  const rawChars = countChars(rawMessages);
  const baseTime = options.baseTime ?? Date.now();
  const idFactory = options.idFactory;

  return {
    geminiMessages: foldedMessagesToGeminiCliMessages(foldedMessages, baseTime, { idFactory }),
    rawGeminiMessages: foldedMessagesToGeminiCliMessages(rawMessages, baseTime, { idFactory }),
    rawCount: rawMessages.length,
    foldedMessages,
    rawMessages,
    fold,
    stats: {
      shouldFold: trigger.shouldFold,
      turnsToFold: trigger.turnsToFold,
      foldReason: trigger.reason,
      originalChars: fold ? fold.originalChars : rawChars,
      foldedChars: fold ? fold.foldedChars : rawChars,
      savingsPercent: fold ? fold.savingsPercent : 0,
    },
  };
}

export function serializeFoldedGeminiCliJsonl(
  metaLine: string,
  geminiMessages: readonly unknown[],
  options: { now?: () => Date } = {},
): string {
  const setMessagesLine = JSON.stringify({ $set: { messages: geminiMessages } });
  const setLastUpdatedLine = JSON.stringify({
    $set: { lastUpdated: (options.now ?? (() => new Date()))().toISOString() },
  });
  return [metaLine, setMessagesLine, setLastUpdatedLine, ''].join('\n');
}

export function scanLatestGeminiCliTokensFromJsonl(content: string): GeminiCliMeasuredTokens | null {
  const finite = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const lines = content.split('\n');
  let best: GeminiCliMeasuredTokens | null = null;
  let seen = 0;

  for (let i = lines.length - 1; i >= 0 && seen < GEMINI_CLI_TOKEN_RECENT_WINDOW; i -= 1) {
    const line = lines[i].trim();
    if (!line || !line.includes('"tokens"')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const tokens = (record as { tokens?: unknown } | null)?.tokens;
    if (!tokens || typeof tokens !== 'object') continue;
    const t = tokens as Record<string, unknown>;
    if (typeof t.input !== 'number' || !Number.isFinite(t.input)) continue;
    seen += 1;
    if (!best || t.input > best.input) {
      best = {
        input: t.input,
        output: finite(t.output),
        cached: finite(t.cached),
        total: finite(t.total),
      };
    }
  }

  return best;
}

export function defaultGeminiCliChatsRoot(homeDir: string = os.homedir()): string {
  return path.join(homeDir, GEMINI_CLI_CHATS_GLOB_ROOT);
}

async function readGeminiCliJsonlHeaderSessionId(filePath: string): Promise<string | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(GEMINI_CLI_HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return null;
    const chunk = buffer.subarray(0, bytesRead).toString('utf8');
    const newlineIdx = chunk.indexOf('\n');
    const headerLine = newlineIdx >= 0 ? chunk.slice(0, newlineIdx) : chunk;
    const parsed = JSON.parse(headerLine) as { sessionId?: unknown };
    return typeof parsed.sessionId === 'string' ? parsed.sessionId : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function resolveGeminiCliSessionJsonlPath(
  sessionId: string,
  root: string = defaultGeminiCliChatsRoot(),
): Promise<string | null> {
  const exactName = `session-${sessionId}.jsonl`;

  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(root);
  } catch {
    return null;
  }
  const orderedDirs = projectDirs.includes('voxxo-swarm')
    ? ['voxxo-swarm', ...projectDirs.filter((dir) => dir !== 'voxxo-swarm')]
    : projectDirs;

  for (const dir of orderedDirs) {
    const candidate = path.join(root, dir, 'chats', exactName);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Keep scanning.
    }
  }

  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];
  for (const dir of orderedDirs) {
    const chatsDir = path.join(root, dir, 'chats');
    let entries: string[];
    try {
      entries = await fs.readdir(chatsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith('session-') || !entry.endsWith('.jsonl')) continue;
      const filePath = path.join(chatsDir, entry);
      try {
        const stat = await fs.stat(filePath);
        candidates.push({ filePath, mtimeMs: stat.mtimeMs });
      } catch {
        // Skip unreadable entries.
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    const headerSessionId = await readGeminiCliJsonlHeaderSessionId(candidate.filePath);
    if (headerSessionId === sessionId) return candidate.filePath;
  }
  return null;
}

export async function readLatestGeminiCliMeasuredTokens(
  sessionId: string,
  options: { root?: string } = {},
): Promise<GeminiCliMeasuredTokens | null> {
  const filePath = await resolveGeminiCliSessionJsonlPath(sessionId, options.root);
  if (!filePath) return null;

  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    return null;
  }

  if (size <= GEMINI_CLI_TAIL_READ_BYTES) {
    try {
      return scanLatestGeminiCliTokensFromJsonl(await fs.readFile(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  let handle: fs.FileHandle | undefined;
  let tail: string;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(GEMINI_CLI_TAIL_READ_BYTES);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      size - GEMINI_CLI_TAIL_READ_BYTES,
    );
    tail = buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }

  const firstNewline = tail.indexOf('\n');
  const safeTail = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
  const fromTail = scanLatestGeminiCliTokensFromJsonl(safeTail);
  if (fromTail) return fromTail;

  try {
    return scanLatestGeminiCliTokensFromJsonl(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeFoldedGeminiCliJsonl(
  sessionId: string,
  geminiMessages: readonly unknown[],
  options: WriteFoldedGeminiCliJsonlOptions = {},
): Promise<string> {
  const filePath = await resolveGeminiCliSessionJsonlPath(sessionId, options.root);
  if (!filePath) {
    throw new Error(`Session JSONL file not found for rewrite (sessionId=${sessionId})`);
  }

  const fileContent = await fs.readFile(filePath, 'utf8');
  const lines = fileContent.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`Session JSONL file is empty: ${filePath}`);
  }

  const metaLine = lines[0];
  const outputJsonl = serializeFoldedGeminiCliJsonl(metaLine, geminiMessages, { now: options.now });
  const tempIdFactory = options.tempIdFactory ?? (() => randomBytes(4).toString('hex'));

  if (options.rawGeminiMessages) {
    const rawFilePath = filePath.replace(/\.jsonl$/, '.raw.jsonl');
    const rawOutputJsonl = serializeFoldedGeminiCliJsonl(metaLine, options.rawGeminiMessages, {
      now: options.now,
    });
    if (options.dryRun) {
      await fs.writeFile(`${rawFilePath}.dryrun`, rawOutputJsonl, 'utf8');
    } else {
      const tempRawPath = `${rawFilePath}.tmp-${tempIdFactory()}`;
      await fs.writeFile(tempRawPath, rawOutputJsonl, 'utf8');
      await fs.rename(tempRawPath, rawFilePath);
    }
  }

  if (options.dryRun) {
    const dryRunPath = `${filePath}.dryrun`;
    await fs.writeFile(dryRunPath, outputJsonl, 'utf8');
    return dryRunPath;
  }

  const tempPath = `${filePath}.tmp-${tempIdFactory()}`;
  await fs.writeFile(tempPath, outputJsonl, 'utf8');
  await fs.rename(tempPath, filePath);
  return filePath;
}
