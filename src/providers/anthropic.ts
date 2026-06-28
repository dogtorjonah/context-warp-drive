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
 * import { prepareAnthropicCachedRequest } from 'context-warp-drive/providers/anthropic';
 *
 * const session = new FoldSession({ freeze: { ttlMs: 3_600_000 } });
 *
 * // Each turn:
 * const outcome = session.prepare(history, { measuredInputTokens });
 * const cached = prepareAnthropicCachedRequest({
 *   messages: outcome.messages,
 *   sealedBoundary: outcome.sealedBoundary,  // from fold-freeze / hard epoch
 *   system: SYSTEM_PROMPT,
 *   tools: TOOLS,
 * });
 * const res = await anthropic.messages.create({
 *   ...cached.request,
 *   model,
 *   max_tokens,
 * }, cached.requestOptions);
 * ```
 *
 * ## What it does
 *
 * Anthropic matches the longest byte-identical prefix across breakpoints.
 * We place breakpoints strategically:
 *
 *   1. Tool definitions (optional) — caches stable tool schemas.
 *   2. Stable system head (optional) — caches shared instructions while leaving
 *      a volatile identity/model tail outside that early breakpoint.
 *   3. Sealed fold/rebirth boundary (optional) — caches the frozen prefix up to and
 *      including the last message of the sealed band. Only present when the
 *      fold-freeze has established a stable boundary.
 *   4. Last message — rolling breakpoint that caches the full append-only
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
 * Max 4 breakpoints per Anthropic request. The `prepareAnthropicCachedRequest`
 * helper spends them in the same order as the request (`tools` → `system` →
 * `messages`) and only uses a separate sealed-boundary message breakpoint when
 * `FoldSession.prepare()` exposes one before the rolling tail.
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

/**
 * Default marker for splitting the stable system head from a volatile
 * identity/model tail. This mirrors the Voxxo relay's hotswap-safe convention:
 * cache the shared prompt before the identity section, then let the per-clone
 * or per-model delta ride later breakpoints.
 */
export const DEFAULT_VOLATILE_SYSTEM_TAIL_MARKER = '## Your Identity';

export type CacheTtl = '5m' | '1h';

export interface BuildCachedSystemOptions {
  /**
   * Marker that starts a volatile system tail. When found, the breakpoint lands
   * on the text before the marker and the tail remains unmarked. Pass `null` to
   * cache the whole system string as one block.
   */
  readonly stablePrefixMarker?: string | null;
}

export interface PreparedAnthropicCachedRequest<T extends ToolSpec = ToolSpec> {
  /** Body fields to spread into `client.messages.create(...)`. */
  readonly request: {
    readonly messages: Message[];
    readonly system?: string | SystemBlock[];
    readonly tools?: T[];
  };
  /**
   * Extra request options for the Anthropic TypeScript SDK. Spread or merge
   * these into the second argument to `client.messages.create(...)`.
   */
  readonly requestOptions?: {
    readonly headers: {
      readonly 'anthropic-beta': string;
    };
  };
  /**
   * Raw beta flag string for callers that use a custom fetch client instead of
   * the SDK options object.
   */
  readonly anthropicBeta: string | null;
}

type MutablePreparedAnthropicRequest<T extends ToolSpec> = {
  messages: Message[];
  system?: string | SystemBlock[];
  tools?: T[];
};

// ─── Helpers ──────────────────────────────────────────────────────────

function ephemeralCacheControl(ttl: CacheTtl = '5m'): CacheControl {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

/** The beta header value required for this TTL, or null for default 5m. */
export function cacheTtlBetaHeader(ttl: CacheTtl = '5m'): string | null {
  return ttl === '1h' ? EXTENDED_CACHE_TTL_BETA : null;
}

function withCacheControl(block: SystemBlock, ttl: CacheTtl): SystemBlock {
  return { ...block, cache_control: ephemeralCacheControl(ttl) };
}

function withoutCacheControl(block: SystemBlock): SystemBlock {
  const out = { ...block };
  delete out.cache_control;
  return out;
}

// ─── Breakpoint functions ─────────────────────────────────────────────

/**
 * Attach `cache_control` breakpoints to the messages array for an Anthropic
 * request. Places a sealed-boundary breakpoint (if provided and separate from
 * the rolling tail) and a rolling breakpoint on the last message. Returns a new
 * array; input is untouched.
 *
 * @param messages The provider-shaped messages to send (from FoldSession.prepare).
 * @param options.sealedBoundary Message index from FoldOutcome.sealedBoundary.
 *   When present before the final message, a breakpoint is placed on the last
 *   content block of the message at `sealedBoundary - 1`, caching the frozen
 *   prefix. When the sealed boundary is also the final message, the rolling
 *   breakpoint covers the same prefix.
 * @param options.ttl Cache TTL — `'5m'` (default) or `'1h'`.
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
  options: BuildCachedSystemOptions = {},
): string | SystemBlock[] {
  if (!systemPrompt) return systemPrompt;
  const marker = options.stablePrefixMarker === undefined
    ? DEFAULT_VOLATILE_SYSTEM_TAIL_MARKER
    : options.stablePrefixMarker;
  if (marker) {
    const volatileTailStart = systemPrompt.indexOf(marker);
    if (volatileTailStart > 0) {
      const stableHead = systemPrompt.slice(0, volatileTailStart);
      const volatileTail = systemPrompt.slice(volatileTailStart);
      if (stableHead.trim() && volatileTail.trim()) {
        return [
          { type: 'text', text: stableHead, cache_control: ephemeralCacheControl(ttl) },
          { type: 'text', text: volatileTail },
        ];
      }
    }
  }
  return [{ type: 'text', text: systemPrompt, cache_control: ephemeralCacheControl(ttl) }];
}

function applySystemCacheBreakpoint(
  system: string | SystemBlock[] | undefined,
  ttl: CacheTtl,
  options: BuildCachedSystemOptions,
): string | SystemBlock[] | undefined {
  if (typeof system === 'string') return buildCachedSystem(system, ttl, options);
  if (!system || system.length === 0) return system;
  const marker = options.stablePrefixMarker === undefined
    ? DEFAULT_VOLATILE_SYSTEM_TAIL_MARKER
    : options.stablePrefixMarker;
  if (marker) {
    for (let i = 0; i < system.length; i++) {
      const block = system[i];
      const markerStart = block?.text.indexOf(marker) ?? -1;
      if (markerStart < 0) continue;

      if (block && markerStart > 0) {
        const stableHead = block.text.slice(0, markerStart);
        const volatileTail = block.text.slice(markerStart);
        if (stableHead.trim() && volatileTail.trim()) {
          const out = system.slice();
          out.splice(
            i,
            1,
            withCacheControl({ ...block, text: stableHead }, ttl),
            withoutCacheControl({ ...block, text: volatileTail }),
          );
          return out;
        }
      }

      for (let j = i - 1; j >= 0; j--) {
        const stableBlock = system[j];
        if (stableBlock?.text.trim()) {
          const out = system.slice();
          out[j] = withCacheControl(stableBlock, ttl);
          return out;
        }
      }
      return system;
    }
  }
  const out = system.slice();
  const lastIdx = out.length - 1;
  out[lastIdx] = withCacheControl(out[lastIdx] as SystemBlock, ttl);
  return out;
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

/**
 * Build the Anthropic request pieces that preserve standalone hard-epoch parity:
 * cache stable tools/system, mark the sealed fold/rebirth boundary returned by
 * `FoldSession.prepare()`, and keep a rolling breakpoint on the newest message.
 *
 * The returned `request` is safe to spread into the SDK body. `requestOptions`
 * is present only for `ttl: '1h'`, because the default 5-minute cache shape
 * requires no beta header.
 */
export function prepareAnthropicCachedRequest<T extends ToolSpec = ToolSpec>(input: {
  readonly messages: Message[];
  readonly sealedBoundary?: number | null;
  readonly system?: string | SystemBlock[];
  readonly tools?: T[];
  readonly ttl?: CacheTtl;
  readonly cacheSystem?: boolean;
  readonly cacheTools?: boolean;
  readonly stableSystemPrefixMarker?: string | null;
}): PreparedAnthropicCachedRequest<T> {
  const ttl = input.ttl ?? '5m';
  const request: MutablePreparedAnthropicRequest<T> = {
    messages: applyCacheBreakpoints(input.messages, {
      sealedBoundary: input.sealedBoundary,
      ttl,
    }),
  };
  if (input.system !== undefined) {
    request.system = input.cacheSystem === false
      ? input.system
      : applySystemCacheBreakpoint(input.system, ttl, {
        stablePrefixMarker: input.stableSystemPrefixMarker,
      });
  }
  if (input.tools !== undefined) {
    request.tools = input.cacheTools === false ? input.tools : applyToolsCacheBreakpoint(input.tools, ttl);
  }
  const anthropicBeta = cacheTtlBetaHeader(ttl);
  return {
    request,
    anthropicBeta,
    ...(anthropicBeta
      ? { requestOptions: { headers: { 'anthropic-beta': anthropicBeta } } }
      : {}),
  };
}
