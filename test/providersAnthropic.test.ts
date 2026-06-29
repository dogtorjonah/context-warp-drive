import { describe, expect, test } from 'vitest';

import {
  EXTENDED_CACHE_TTL_BETA,
  applyCacheBreakpoints,
  buildCachedSystem,
  cacheTtlBetaHeader,
  prepareAnthropicCachedRequest,
  type Message,
  type SystemBlock,
  type ToolSpec,
} from '../src/providers/anthropic.js';

function message(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

describe('Anthropic cache adapter', () => {
  test('marks the sealed fold boundary and rolling tail without mutating input', () => {
    const messages = [
      message('user', 'hard epoch rebirth seed'),
      message('assistant', 'sealed folded band'),
      message('user', 'new live tail'),
    ];

    const cached = applyCacheBreakpoints(messages, { sealedBoundary: 2 });

    expect(cached).not.toBe(messages);
    expect(cached[1]?.content[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(cached[2]?.content[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(messages[1]?.content[0]?.cache_control).toBeUndefined();
    expect(messages[2]?.content[0]?.cache_control).toBeUndefined();
  });

  test('splits a stable system head from the volatile identity tail', () => {
    const system = [
      'Shared SOP and tool guidance.',
      '',
      '## Your Identity',
      'model: claude-opus-4-8',
    ].join('\n');

    const cached = buildCachedSystem(system);

    expect(Array.isArray(cached)).toBe(true);
    expect(cached).toHaveLength(2);
    const blocks = cached as Exclude<typeof cached, string>;
    expect(blocks[0]?.text).toContain('Shared SOP');
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1]?.text).toContain('## Your Identity');
    expect(blocks[1]?.cache_control).toBeUndefined();
  });

  test('keeps structured volatile system tails out of the cached head', () => {
    const system: SystemBlock[] = [
      { type: 'text', text: 'Shared SOP and tool guidance.\n\n' },
      { type: 'text', text: '## Your Identity\nmodel: claude-opus-4-8' },
    ];

    const prepared = prepareAnthropicCachedRequest({
      messages: [message('user', 'seed')],
      system,
    });

    const blocks = prepared.request.system as SystemBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1]?.cache_control).toBeUndefined();
    expect(system[0]?.cache_control).toBeUndefined();
  });

  test('prepares the relay-parity four-breakpoint Anthropic request', () => {
    const messages = [
      message('user', 'hard epoch rebirth seed'),
      message('assistant', 'sealed folded band'),
      message('user', 'new live tail'),
    ];
    const tools: ToolSpec[] = [
      { name: 'read_file', input_schema: { type: 'object', properties: {} } },
      { name: 'edit_file', input_schema: { type: 'object', properties: {} } },
    ];
    const system = 'Stable harness prompt\n\n## Your Identity\nclone model delta';

    const prepared = prepareAnthropicCachedRequest({
      messages,
      sealedBoundary: 2,
      system,
      tools,
      ttl: '1h',
    });

    expect(prepared.anthropicBeta).toBe(EXTENDED_CACHE_TTL_BETA);
    expect(prepared.requestOptions?.headers['anthropic-beta']).toBe(EXTENDED_CACHE_TTL_BETA);
    expect(prepared.request.tools?.[0]?.cache_control).toBeUndefined();
    expect(prepared.request.tools?.[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(Array.isArray(prepared.request.system)).toBe(true);
    const systemBlocks = prepared.request.system as Exclude<typeof prepared.request.system, string | undefined>;
    expect(systemBlocks[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(systemBlocks[1]?.cache_control).toBeUndefined();
    expect(prepared.request.messages[1]?.content[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(prepared.request.messages[2]?.content[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(tools[1]?.cache_control).toBeUndefined();
    expect(messages[2]?.content[0]?.cache_control).toBeUndefined();
  });

  test('keeps default 5m caching on the legacy no-beta shape', () => {
    expect(cacheTtlBetaHeader()).toBeNull();

    const tools: ToolSpec[] = [{ name: 'read_file' }];
    const prepared = prepareAnthropicCachedRequest({
      messages: [message('user', 'seed')],
      system: 'Stable harness prompt',
      tools,
    });

    expect(prepared.anthropicBeta).toBeNull();
    expect(prepared.requestOptions).toBeUndefined();
    expect(prepared.request.messages[0]?.content[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(prepared.request.tools?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('hybrid TTL: prefix gets 1h, tail gets 5m', () => {
    const messages = [
      message('user', 'hard epoch rebirth seed'),
      message('assistant', 'sealed folded band'),
      message('user', 'new live tail'),
    ];

    const cached = applyCacheBreakpoints(messages, {
      sealedBoundary: 2,
      prefixTtl: '1h',
      tailTtl: '5m',
    });

    // Sealed boundary (prefix) → 1h
    expect(cached[1]?.content[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    // Rolling tail → 5m (no ttl field)
    expect(cached[2]?.content[0]?.cache_control).toEqual({ type: 'ephemeral' });
    // Input unchanged
    expect(messages[1]?.content[0]?.cache_control).toBeUndefined();
  });

  test('hybrid TTL: prefixTtl/tailTtl override global ttl', () => {
    const messages = [
      message('user', 'seed'),
      message('assistant', 'sealed'),
      message('user', 'tail'),
    ];

    const cached = applyCacheBreakpoints(messages, {
      sealedBoundary: 2,
      ttl: '5m',         // global fallback
      prefixTtl: '1h',   // overrides for sealed boundary
      tailTtl: '5m',     // explicit tail (same as global, but distinct path)
    });

    expect(cached[1]?.content[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(cached[2]?.content[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('hybrid TTL: prepareAnthropicCachedRequest wires prefix/tail across all breakpoints', () => {
    const messages = [
      message('user', 'hard epoch rebirth seed'),
      message('assistant', 'sealed folded band'),
      message('user', 'new live tail'),
    ];
    const tools: ToolSpec[] = [
      { name: 'read_file', input_schema: { type: 'object', properties: {} } },
      { name: 'edit_file', input_schema: { type: 'object', properties: {} } },
    ];
    const system = 'Stable harness prompt\n\n## Your Identity\nclone model delta';

    const prepared = prepareAnthropicCachedRequest({
      messages,
      sealedBoundary: 2,
      system,
      tools,
      prefixTtl: '1h',
      tailTtl: '5m',
    });

    // Beta header required because prefixTtl is 1h
    expect(prepared.anthropicBeta).toBe(EXTENDED_CACHE_TTL_BETA);
    expect(prepared.requestOptions?.headers['anthropic-beta']).toBe(EXTENDED_CACHE_TTL_BETA);

    // Tools → prefixTtl (1h)
    expect(prepared.request.tools?.[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });

    // System stable head → prefixTtl (1h)
    const systemBlocks = prepared.request.system as Exclude<typeof prepared.request.system, string | undefined>;
    expect(systemBlocks[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(systemBlocks[1]?.cache_control).toBeUndefined();

    // Sealed boundary → prefixTtl (1h)
    expect(prepared.request.messages[1]?.content[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });

    // Rolling tail → tailTtl (5m, no ttl field)
    expect(prepared.request.messages[2]?.content[0]?.cache_control).toEqual({ type: 'ephemeral' });

    // Input arrays not mutated
    expect(tools[1]?.cache_control).toBeUndefined();
    expect(messages[2]?.content[0]?.cache_control).toBeUndefined();
  });

  test('hybrid TTL: beta header present when only prefixTtl is 1h', () => {
    const prepared = prepareAnthropicCachedRequest({
      messages: [message('user', 'seed')],
      prefixTtl: '1h',
      tailTtl: '5m',
    });
    expect(prepared.anthropicBeta).toBe(EXTENDED_CACHE_TTL_BETA);
  });

  test('hybrid TTL: no beta header when both TTLs are 5m', () => {
    const prepared = prepareAnthropicCachedRequest({
      messages: [message('user', 'seed')],
      prefixTtl: '5m',
      tailTtl: '5m',
    });
    expect(prepared.anthropicBeta).toBeNull();
    expect(prepared.requestOptions).toBeUndefined();
  });

  test('hybrid TTL: tailTtl falls back to ttl when not specified', () => {
    const messages = [
      message('user', 'seed'),
      message('assistant', 'sealed'),
      message('user', 'tail'),
    ];

    const cached = applyCacheBreakpoints(messages, {
      sealedBoundary: 2,
      ttl: '1h',
      prefixTtl: '1h',
      // tailTtl omitted → falls back to ttl ('1h')
    });

    expect(cached[1]?.content[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(cached[2]?.content[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});
