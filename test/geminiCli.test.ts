import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  appendUserMessageVaultToGeminiCliView,
  DEFAULT_GEMINI_CLI_FOLD_BAND_TOKENS,
  DEFAULT_GEMINI_CLI_FOLD_TARGET_TOKENS,
  foldedMessagesToGeminiCliMessages,
  flattenFoldContent,
  getPositiveIntEnv,
  readLatestGeminiCliMeasuredTokens,
  resolveGeminiCliFoldMode,
  resolveGeminiCliFoldPolicy,
  resolveGeminiCliFoldTriggerTokens,
  resolveGeminiCliSessionJsonlPath,
  scanLatestGeminiCliTokensFromJsonl,
  serializeFoldedGeminiCliJsonl,
  writeFoldedGeminiCliJsonl,
  type GeminiCliFoldMessage,
} from '../src/providers/geminiCli.js';
import type { FoldMessage } from '../src/fold.js';

describe('Gemini CLI fold policy', () => {
  test('defaults match the relay Gemini CLI folding constants', () => {
    expect(DEFAULT_GEMINI_CLI_FOLD_TARGET_TOKENS).toBe(250_000);
    expect(DEFAULT_GEMINI_CLI_FOLD_BAND_TOKENS).toBe(100_000);

    const policy = resolveGeminiCliFoldPolicy({ measuredInputTokens: 250_000 });
    expect(policy.mode).toBe('on');
    expect(policy.targetTokens).toBe(250_000);
    expect(policy.bandTokens).toBe(100_000);
    expect(policy.effectiveTriggerTokens).toBe(250_000);
    expect(policy.foldConfig.assistantTextBudget?.essenceRetentionChars).toBe(100_000);
    expect(policy.shouldFold).toBe(true);
  });

  test('trigger keeps the 250k target on large windows and caps tiny windows', () => {
    expect(resolveGeminiCliFoldTriggerTokens(250_000, 1_000_000)).toBe(250_000);
    expect(resolveGeminiCliFoldTriggerTokens(250_000, 128_000)).toBe(89_600);
    expect(resolveGeminiCliFoldTriggerTokens(250_000, 0)).toBe(250_000);
  });

  test('mode and integer env helpers match the relay behavior', () => {
    expect(resolveGeminiCliFoldMode(undefined, {})).toBe('on');
    expect(resolveGeminiCliFoldMode(undefined, { VOXXO_GEMINI_CLI_FOLD: 'off' })).toBe('off');
    expect(resolveGeminiCliFoldMode(undefined, { VOXXO_GEMINI_CLI_FOLD: 'false' })).toBe('off');
    expect(resolveGeminiCliFoldMode(undefined, { VOXXO_GEMINI_CLI_FOLD: 'dry-run' })).toBe('dry-run');
    expect(resolveGeminiCliFoldMode(undefined, { WARP_GEMINI_CLI_FOLD: 'off' })).toBe('off');
    expect(resolveGeminiCliFoldMode(undefined, { VOXXO_GEMINI_CLI_FOLD: 'dry-run', WARP_GEMINI_CLI_FOLD: 'off' })).toBe('dry-run');
    expect(resolveGeminiCliFoldMode('on', { VOXXO_GEMINI_CLI_FOLD: 'off' })).toBe('on');

    expect(getPositiveIntEnv('K', 42, {})).toBe(42);
    expect(getPositiveIntEnv('K', 42, { K: '0' })).toBe(42);
    expect(getPositiveIntEnv('K', 42, { K: '-5' })).toBe(42);
    expect(getPositiveIntEnv('K', 42, { K: 'oops' })).toBe(42);
    expect(getPositiveIntEnv('K', 42, { K: '100000' })).toBe(100_000);
    expect(getPositiveIntEnv(['OLD', 'NEW'], 42, { NEW: '100000' })).toBe(100_000);
    expect(getPositiveIntEnv(['OLD', 'NEW'], 42, { OLD: '90000', NEW: '100000' })).toBe(90_000);

    const warpPolicy = resolveGeminiCliFoldPolicy({
      env: {
        WARP_GEMINI_CLI_FOLD_TARGET_TOKENS: '260000',
        WARP_GEMINI_CLI_FOLD_BAND_TOKENS: '110000',
      },
    });
    expect(warpPolicy.targetTokens).toBe(260_000);
    expect(warpPolicy.bandTokens).toBe(110_000);
  });
});

describe('Gemini CLI message rendering', () => {
  test('foldedMessagesToGeminiCliMessages maps roles to the real on-disk schema', () => {
    let nextId = 0;
    const folded: FoldMessage[] = [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
      { role: 'model', content: 'm' },
    ];

    const out = foldedMessagesToGeminiCliMessages(folded, 1000, {
      idFactory: () => `msg-test-${nextId += 1}`,
    });

    expect(out.map((message) => message.type)).toEqual(['user', 'gemini', 'gemini']);
    expect(out.map((message) => message.content[0].text)).toEqual(['u', 'a', 'm']);
    expect(out.map((message) => message.id)).toEqual(['msg-test-1', 'msg-test-2', 'msg-test-3']);
    expect(new Date(out[1].timestamp).getTime()).toBeGreaterThan(new Date(out[0].timestamp).getTime());
  });

  test('flattenFoldContent handles strings, text parts, mixed arrays, and empty values', () => {
    expect(flattenFoldContent('plain')).toBe('plain');
    expect(flattenFoldContent([{ text: 'a' }, { text: 'b' }])).toBe('a\nb');
    expect(flattenFoldContent(['x', { text: 'y' }])).toBe('x\ny');
    expect(flattenFoldContent(null)).toBe('');
    expect(flattenFoldContent(undefined)).toBe('');
  });

  test('appends a vault to the newest text-bearing user message without mutation', () => {
    const mk = (type: 'gemini' | 'user', text: string): GeminiCliFoldMessage => ({
      id: `m-${type}-${text}`,
      timestamp: '2026-06-18T00:00:00.000Z',
      type,
      content: [{ text }],
    });
    const target = mk('user', 'latest');
    const view = [mk('user', 'older'), mk('gemini', 'reply'), target];
    const vault = '[User Message Vault]\nkeep this\n[/User Message Vault]';

    const out = appendUserMessageVaultToGeminiCliView(view, vault);

    expect(out).not.toBe(view);
    expect(out[2]).not.toBe(target);
    expect(target.content).toEqual([{ text: 'latest' }]);
    expect(out.map((message) => message.content)).toEqual([
      [{ text: 'older' }],
      [{ text: 'reply' }],
      [{ text: 'latest' }, { text: vault }],
    ]);
  });
});

describe('Gemini CLI measured-token scanning', () => {
  test('returns the recent high-water input and keeps the winning record coherent', () => {
    const lines = [
      JSON.stringify({ id: 'g-main', tokens: { input: 160_336, output: 87, cached: 159_953, total: 160_423 } }),
      JSON.stringify({ id: 'g-aux', tokens: { input: 102_158, output: 26, cached: 92_744, total: 102_258 } }),
      '',
    ].join('\n');

    expect(scanLatestGeminiCliTokensFromJsonl(lines)).toEqual({
      input: 160_336,
      output: 87,
      cached: 159_953,
      total: 160_423,
    });
  });

  test('ignores high token lines older than the bounded recent window', () => {
    const tok = (input: number) =>
      JSON.stringify({ id: `g${input}`, tokens: { input, output: 1, cached: 0, total: input + 1 } });
    const lines = [
      tok(250_000),
      tok(40_000),
      tok(41_000),
      tok(42_000),
      tok(43_000),
      tok(44_000),
      tok(45_000),
      tok(46_000),
      tok(47_000),
      '',
    ].join('\n');

    expect(scanLatestGeminiCliTokensFromJsonl(lines)?.input).toBe(47_000);
  });
});

describe('Gemini CLI JSONL helpers', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-gemini-cli-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('resolves real gemini-cli filenames by header sessionId and reads measured tokens', async () => {
    const dir = path.join(root, 'some-worktree', 'chats');
    await fs.mkdir(dir, { recursive: true });
    const sessionId = '834c99da-eb29-4ba9-a8fd-3decee9a7a6a';
    const filePath = path.join(dir, 'session-2026-06-14T20-53-834c99da.jsonl');
    const header = JSON.stringify({ sessionId, kind: 'main' });
    const tokenLine = JSON.stringify({
      id: 'g1',
      type: 'gemini',
      tokens: { input: 160_336, output: 87, cached: 159_953, total: 160_423 },
    });
    await fs.writeFile(filePath, `${header}\n${tokenLine}\n`, 'utf8');

    expect(await resolveGeminiCliSessionJsonlPath(sessionId, root)).toBe(filePath);
    expect(await readLatestGeminiCliMeasuredTokens(sessionId, { root })).toEqual({
      input: 160_336,
      output: 87,
      cached: 159_953,
      total: 160_423,
    });
  });

  test('serializeFoldedGeminiCliJsonl emits meta plus messages and lastUpdated set ops', () => {
    const out = serializeFoldedGeminiCliJsonl('META', [
      { id: 'a', timestamp: 't', type: 'user', content: [{ text: 'hi' }] },
    ], {
      now: () => new Date('2026-06-18T00:00:00.000Z'),
    });
    const parts = out.split('\n');

    expect(parts[0]).toBe('META');
    expect(JSON.parse(parts[1])).toHaveProperty('$set.messages');
    expect(JSON.parse(parts[2])).toEqual({ $set: { lastUpdated: '2026-06-18T00:00:00.000Z' } });
    expect(parts[3]).toBe('');
  });

  test('dry-run rewrite writes sidecars and leaves the live file untouched', async () => {
    const sessionId = 'test-fold-session-123';
    const dir = path.join(root, 'voxxo-swarm', 'chats');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `session-${sessionId}.jsonl`);
    const metaLine = JSON.stringify({ sessionId, kind: 'main' });
    const original = `${metaLine}\n{"$set":{"messages":[{"id":"x","type":"user","content":[{"text":"orig"}]}]}}\n`;
    await fs.writeFile(filePath, original, 'utf8');

    const messages = [{ id: 'm', timestamp: 't', type: 'user', content: [{ text: 'preview' }] }];
    const rawMessages = [{ id: 'r', timestamp: 't', type: 'user', content: [{ text: 'raw preview' }] }];
    const out = await writeFoldedGeminiCliJsonl(sessionId, messages, {
      root,
      dryRun: true,
      rawGeminiMessages: rawMessages,
      now: () => new Date('2026-06-18T00:00:00.000Z'),
    });

    expect(out).toBe(`${filePath}.dryrun`);
    expect(await fs.readFile(filePath, 'utf8')).toBe(original);

    const folded = (await fs.readFile(`${filePath}.dryrun`, 'utf8')).split('\n').filter(Boolean);
    expect(JSON.parse(folded[1])).toEqual({ $set: { messages } });

    const rawPath = filePath.replace(/\.jsonl$/, '.raw.jsonl');
    await expect(fs.access(rawPath)).rejects.toThrow();
    const raw = (await fs.readFile(`${rawPath}.dryrun`, 'utf8')).split('\n').filter(Boolean);
    expect(JSON.parse(raw[1])).toEqual({ $set: { messages: rawMessages } });
  });
});
