/**
 * Anthropic prompt-cache adapter for context-warp-drive.
 *
 * Drop these helpers into your `@anthropic-ai/sdk` call site to get
 * provider-native `cache_control` breakpoints that stay hot across the
 * fold-freeze's sealed boundary — the same mechanism the Voxxo relay uses.
 *
 * ## Quick start
 *
 * ```ts
 * import { FoldSession } from 'context-warp-drive';
 * import { applyCacheBreakpoints } from 'context-warp-drive/providers/anthropic';
 *
 * const session = new FoldSession({ freeze: { ttlMs: 3_600_000 } });
 *
 * // Each turn:
 * const outcome = session.prepare(history, { measuredInputTokens });
 * const messages = applyCacheBreakpoints(outcome.messages, {
 *   sealedBoundary: outcome.sealedBoundary,  // from fold-freeze
 * });
 * const res = await anthropic.messages.create({ messages, ... });
 * ```
 *
 * ## What it does
 *
 * Anthropic matches the longest byte-identical prefix across breakpoints.
 * We place breakpoints strategically:
 *
 *   1. Sealed fold boundary (optional) — caches the frozen prefix up to and
 *      including the last message of the sealed band. Only present when the
 *      fold-freeze has established a stable boundary.
 *   2. Last message — rolling breakpoint that caches the full append-only
 *      prefix up to the current turn. Each new turn writes only its delta;
 *      the rest is a cache hit at 0.1× input price.
 *
 * Clones only the touched messages — the input array stays pristine, so your
 * persisted history never accumulates stale breakpoints.
 *
 * ## TTL
 *
 * All breakpoints carry the same TTL. `'5m'` (default) uses the legacy
 * sliding window (1.25× input write). Since agent loops hit every few
 * seconds the cache never expires during continuous work — reads refresh
 * the TTL. `'1h'` uses the extended cache TTL (2× input write, but survives
 * >5-minute turn gaps). Pass `ttl: '1h'` to opt into the extended behavior.
 * The `'1h'` TTL requires the `anthropic-beta: extended-cache-ttl-2025-04-11`
 * header on the request — see {@link EXTENDED_CACHE_TTL_BETA}.
 *
 * Max 4 breakpoints per Anthropic request. We use at most 2 on messages here.
 * If you also cache tools and system prompt (recommended), that's 4 total.
 */

// ─── Types ────────────────────────────────────────────────────────────

/**
 * Prompt-cache breakpoint marker. Attach to a content block, tool spec, or
 * system block to tell Anthropic to cache the request prefix up to and
 * including that element. Breakpoints below the per-model minimum
 * (~1024 tokens for Opus/Sonnet) are silently treated as uncached.
 */
export type CacheControl = { type: 'ephemeral'; ttl?: '5m' | '1h' };

/** A message content block that can carry an optional cache_control marker. */
export type ContentBlock = { type: string; cache_control?: CacheControl; [key: string]: unknown };

/** A message in the Anthropic messages array. */
export type Message =
  | { role: 'user'; content: ContentBlock[] }
  | { role: 'assistant'; content: ContentBlock[] };

/** A `system` field element when sent as structured blocks. */
export type SystemBlock = { type: 'text'; text: string; cache_control?: CacheControl };

/** A tool definition that can carry a cache_control breakpoint. */
export type ToolSpec = { name: string; [key: string]: unknown; cache_control?: CacheControl };

// ─── Constants ────────────────────────────────────────────────────────

/** Anthropic beta flag for the extended (1h) cache TTL. */
export const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11';

export type CacheTtl = '5m' | '1h';

// ─── Helpers ──────────────────────────────────────────────────────────

function ephemeralCacheControl(ttl: CacheTtl = '5m'): CacheControl {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

// ─── Breakpoint functions ─────────────────────────────────────────────

/**
 * Attach `cache_control` breakpoints to the messages array for an Anthropic
 * request. Places a sealed-boundary breakpoint (if provided) and a rolling
 * breakpoint on the last message. Returns a new array; input is untouched.
 *
 * @param messages The provider-shaped messages to send (from FoldSession.prepare).
 * @param options.sealedBoundary Message index from FoldOutcome.sealedBoundary.
 *   When present, a breakpoint is placed on the last content block of the
 *   message at `sealedBoundary - 1`, caching the frozen prefix.
 * @param options.ttl Cache TTL — `'1h'` (default) or `'5m'`.
 */
export function applyCacheBreakpoints(
  messages: Message[],
  options?: {
    sealedBoundary?: number | null;
    ttl?: CacheTtl;
  },
): Message[] {
  if (messages.length === 0) return messages;
  const ttl = options?.ttl ?? '5m';
  let out: Message[] | null = null;

  const markLastBlock = (messageIndex: number): void => {
    const target = (out ?? messages)[messageIndex];
    if (!target || !Array.isArray(target.content) || target.content.length === 0) return;
    const blocks = target.content.slice();
    const blockIdx = blocks.length - 1;
    blocks[blockIdx] = { ...blocks[blockIdx], cache_control: ephemeralCacheControl(ttl) } as ContentBlock;
    if (!out) out = messages.slice();
    out[messageIndex] = { ...target, content: blocks } as Message;
  };

  // Sealed-boundary breakpoint (caches the frozen prefix)
  const sealedBoundary = options?.sealedBoundary;
  if (
    typeof sealedBoundary === 'number'
    && Number.isInteger(sealedBoundary)
    && sealedBoundary > 0
    && sealedBoundary < messages.length
  ) {
    markLastBlock(sealedBoundary - 1);
  }

  // Rolling breakpoint (caches the full append-only prefix up to now)
  markLastBlock(messages.length - 1);
  return out ?? messages;
}

/**
 * Convert a plain system string into a single cacheable text block so a
 * breakpoint can ride on it (caches the tools + system prefix). Returns the
 * original string when the prompt is empty.
 */
export function buildCachedSystem(
  systemPrompt: string,
  ttl: CacheTtl = '5m',
): string | SystemBlock[] {
  if (!systemPrompt) return systemPrompt;
  return [{ type: 'text', text: systemPrompt, cache_control: ephemeralCacheControl(ttl) }];
}

/**
 * Attach a breakpoint to the LAST tool definition (caches the entire tool
 * array — large and stable within a session). Returns a new array with a
 * cloned last element so the caller's tool list is never mutated.
 */
export function applyToolsCacheBreakpoint<T extends ToolSpec>(
  tools: T[],
  ttl: CacheTtl = '5m',
): T[] {
  if (tools.length === 0) return tools;
  const out = tools.slice();
  const lastIdx = out.length - 1;
  out[lastIdx] = { ...out[lastIdx], cache_control: ephemeralCacheControl(ttl) };
  return out;
}
