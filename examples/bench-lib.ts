/**
 * Shared benchmark library — the SINGLE source of truth for both benchmarks:
 *   • examples/benchmark.ts       — offline, deterministic, no key, CI-safe.
 *   • examples/benchmark-live.ts  — live, real provider calls + real usage telemetry.
 *
 * Keeping the scenario, tokenizer, and pricing here (rather than duplicated in each
 * file) means the offline demo and the live run measure the EXACT same conversation
 * with the EXACT same token accounting — so the offline numbers are a faithful
 * prediction that the live run validates, not a second hand-tuned story.
 *
 * Token counts offline use the o200k_base BPE tokenizer (js-tiktoken, pure-JS,
 * offline) — a real tokenizer, not a chars/token estimate. Claude's tokenizer is not
 * public, so o200k is used as a portable, deterministic proxy for the offline demo;
 * the LIVE benchmark and the production telemetry report the provider's own `usage`
 * token counts, which are the ground truth for Claude.
 */

import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { FoldMessage } from '../src/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Real tokenizer (replaces the old chars/3.8 estimate)
// ─────────────────────────────────────────────────────────────────────────────

let _enc: Tiktoken | null = null;
/** o200k_base is the BPE encoding used by the gpt-4o / gpt-4.1 / gpt-5.x families. */
function encoder(): Tiktoken {
  if (!_enc) _enc = getEncoding('o200k_base');
  return _enc;
}

/** Exact BPE token count for a string (offline, deterministic). */
export function countTokens(text: string): number {
  return encoder().encode(text).length;
}

/** Token count for a prepared message view (role tags add a few tokens; we count the content bytes that actually drive cost). */
export function countMessageTokens(messages: FoldMessage[]): number {
  return countTokens(serializeForCache(messages));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing — sourced, dated, override-able. NEVER fabricated.
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelPricing {
  /** USD per 1M fresh (uncached) input tokens. */
  inputPerM: number;
  /** USD per 1M cached input tokens (prompt-cache READ). */
  cachedPerM: number;
  /** USD per 1M cache-WRITE input tokens (Anthropic charges 1.25x input; OpenAI = input). */
  cacheWritePerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
  source: string;
}

/**
 * Per-1M-token USD pricing from published 2026 rates. Claude is the PRIMARY target —
 * the engine and its production deployment are Claude-first — so the benchmark defaults
 * to Claude; OpenAI entries remain because the engine is provider-agnostic.
 *   Anthropic: cache READ = 90% off input; cache WRITE = 1.25x input.
 *   OpenAI:    cache READ = 50-75% off input; no cache-write premium.
 * Sources:
 *   https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *   https://www.cloudzero.com/blog/claude-api-pricing/ (Claude 2026 rates)
 *   https://developers.openai.com/api/docs/pricing (OpenAI 2026 rates)
 * Unknown model + no WARP_BENCH_PRICE_* override ⇒ cost reported as tokens-only, never invented.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude (primary target)
  'claude-haiku-4-5': { inputPerM: 1.0, cachedPerM: 0.1, cacheWritePerM: 1.25, outputPerM: 5.0, source: 'Anthropic list price, 2026' },
  'claude-sonnet-4-6': { inputPerM: 3.0, cachedPerM: 0.3, cacheWritePerM: 3.75, outputPerM: 15.0, source: 'Anthropic list price, 2026' },
  'claude-opus-4-8': { inputPerM: 5.0, cachedPerM: 0.5, cacheWritePerM: 6.25, outputPerM: 25.0, source: 'Anthropic list price, 2026' },
  // OpenAI (provider-agnostic cross-check; the engine reads OpenAI shapes too)
  'gpt-4o-mini': { inputPerM: 0.15, cachedPerM: 0.075, cacheWritePerM: 0.15, outputPerM: 0.6, source: 'OpenAI list price, 2026' },
  'gpt-4.1-mini': { inputPerM: 0.4, cachedPerM: 0.1, cacheWritePerM: 0.4, outputPerM: 1.6, source: 'OpenAI list price, 2026 (cached = 75% off)' },
  'gpt-4.1-nano': { inputPerM: 0.1, cachedPerM: 0.025, cacheWritePerM: 0.1, outputPerM: 0.4, source: 'OpenAI list price, 2026 (cached = 75% off)' },
};

/** Default benchmark model: Claude (the engine's primary target). */
export const DEFAULT_MODEL = process.env.WARP_BENCH_MODEL ?? 'claude-haiku-4-5';

/** Resolve pricing for a model: env override > table > null (unknown). */
export function resolvePricing(model: string): ModelPricing | null {
  const i = process.env.WARP_BENCH_PRICE_INPUT;
  const c = process.env.WARP_BENCH_PRICE_CACHED;
  const o = process.env.WARP_BENCH_PRICE_OUTPUT;
  if (i && c && o) {
    const inputPerM = Number(i);
    return {
      inputPerM,
      cachedPerM: Number(c),
      cacheWritePerM: process.env.WARP_BENCH_PRICE_CACHE_WRITE ? Number(process.env.WARP_BENCH_PRICE_CACHE_WRITE) : inputPerM,
      outputPerM: Number(o),
      source: 'WARP_BENCH_PRICE_* env override',
    };
  }
  return MODEL_PRICING[model] ?? null;
}

/** Input-side cost given the fresh/cached-read token split (offline demo; no cache-write notion). */
export function inputCostUSD(freshTokens: number, cachedTokens: number, p: ModelPricing): number {
  return (freshTokens / 1_000_000) * p.inputPerM + (cachedTokens / 1_000_000) * p.cachedPerM;
}

/** Full input-side cost including cache WRITES — used by the live benchmark with real provider usage. */
export function liveInputCostUSD(freshTokens: number, cacheReadTokens: number, cacheWriteTokens: number, p: ModelPricing): number {
  return (
    (freshTokens / 1_000_000) * p.inputPerM +
    (cacheReadTokens / 1_000_000) * p.cachedPerM +
    (cacheWriteTokens / 1_000_000) * p.cacheWritePerM
  );
}

/** Output-side cost (used for the real cost of an LLM summarization call). */
export function outputCostUSD(outputTokens: number, p: ModelPricing): number {
  return (outputTokens / 1_000_000) * p.outputPerM;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache-measurement helpers (identical for every strategy — apples-to-apples)
// ─────────────────────────────────────────────────────────────────────────────

export function serializeForCache(messages: FoldMessage[]): string {
  return messages
    .map((m) => `${m.role}${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('');
}

export function commonPrefixChars(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

export function countFactsPresent(text: string, facts: readonly string[]): number {
  let n = 0;
  for (const f of facts) if (text.includes(f)) n++;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Size profiles
// ─────────────────────────────────────────────────────────────────────────────

export interface SizeProfile {
  /** Approx chars of realistic noise per tool result (the vital fact is buried inside). */
  toolResultChars: number;
  /** Truncation window (turns kept). */
  truncKeepTurns: number;
  /** Summarize when the prepared view exceeds this many chars. */
  summTriggerChars: number;
  /** Turns kept verbatim after a summary. */
  summKeepTurns: number;
  /** CWD freeze raw-tail cap (chars). Prod default is 150_000. */
  cwdTailChars: number;
}

/**
 * DEMO — scaled down for a fast, fully deterministic offline run. Small enough to be
 * instant and reproducible; the fold/freeze/closet logic is size-independent.
 */
export const DEMO_PROFILE: SizeProfile = {
  toolResultChars: 700,
  truncKeepTurns: 7,
  summTriggerChars: 4800,
  summKeepTurns: 4,
  cwdTailChars: 2400,
};

/**
 * LIVE — sized so the stable prefix clears OpenAI's 1024-token caching threshold
 * (caching only activates ≥1024 tokens, then in 128-token increments). With the
 * large static system prompt below, the CWD frozen prefix is reliably cacheable;
 * a smaller profile would measure zero cache hits for everyone and prove nothing.
 */
export const LIVE_PROFILE: SizeProfile = {
  toolResultChars: 2600,
  truncKeepTurns: 6,
  summTriggerChars: 16000,
  summKeepTurns: 4,
  cwdTailChars: 9000,
};

// ─────────────────────────────────────────────────────────────────────────────
// The scenario — a realistic agent session (generic; no proprietary references)
// ─────────────────────────────────────────────────────────────────────────────

export interface SimulatedTurn {
  userPrompt: string;
  assistantAction: string;
  /** Core line of the tool output; the vital fact is embedded, then buried in noise. */
  toolCore: string;
  /** The one identifier from this turn the agent must still recall many turns later. */
  vitalFact: string;
}

/** Debugging a production checkout outage. Each turn buries one vital identifier. */
export const SIMULATED_CONVERSATION: SimulatedTurn[] = [
  { userPrompt: 'Checkout is returning 500s in production. Find the handler.', assistantAction: 'Searching the codebase for the checkout route handler.', toolCore: 'the POST /checkout handler is defined in /srv/checkout/src/api/checkout.ts', vitalFact: '/srv/checkout/src/api/checkout.ts' },
  { userPrompt: 'Reproduce it with a seeded order.', assistantAction: 'Running the checkout integration test with a known order id.', toolCore: 'FAIL: order 7f3e9a21-4c8b-4f6e-9d2a-1b5c6e8f0a3d timed out after 30s', vitalFact: '7f3e9a21-4c8b-4f6e-9d2a-1b5c6e8f0a3d' },
  { userPrompt: 'Where does the DB pool connect?', assistantAction: 'Inspecting the datasource configuration.', toolCore: 'Postgres pool host resolved to db.internal:5432 (pool max 20)', vitalFact: 'db.internal:5432' },
  { userPrompt: 'Is there a slow query behind this?', assistantAction: 'Querying pg_stat_statements for the worst offenders.', toolCore: 'top query digest a3f97c21d8 averaging 8420ms over 142 calls', vitalFact: 'a3f97c21d8' },
  { userPrompt: 'Which downstream does it call?', assistantAction: 'Tracing the outbound charge request.', toolCore: 'charge POSTed to https://payments.acme.io/v2/charge (p99 5.1s)', vitalFact: 'https://payments.acme.io/v2/charge' },
  { userPrompt: 'Pull the exact error from the pool layer.', assistantAction: 'Tailing the structured error logs.', toolCore: 'ERROR acquire exceeded 30000ms at /srv/checkout/src/db/pool.ts', vitalFact: '/srv/checkout/src/db/pool.ts' },
  { userPrompt: 'Get the trace id for one failed request.', assistantAction: 'Looking up a failed request in the tracer.', toolCore: 'failed request carried trace 4b2c1d8e-9a0f-4c3b-8e7d-6f5a4b3c2d1e', vitalFact: '4b2c1d8e-9a0f-4c3b-8e7d-6f5a4b3c2d1e' },
  { userPrompt: 'Is the cache layer healthy?', assistantAction: 'Checking the Redis connection used for idempotency.', toolCore: 'redis.internal:6379 reachable, 0.4ms ping, 12k keys', vitalFact: 'redis.internal:6379' },
  { userPrompt: 'What sets the pool size in config?', assistantAction: 'Reading the service environment file.', toolCore: 'config shows DB_POOL_MAX set in /srv/checkout/config/prod.env', vitalFact: '/srv/checkout/config/prod.env' },
  { userPrompt: 'Write a migration adding the composite index.', assistantAction: 'Generating a new SQL migration for the index.', toolCore: 'created /srv/checkout/migrations/20260616_add_orders_idx.sql', vitalFact: '/srv/checkout/migrations/20260616_add_orders_idx.sql' },
  { userPrompt: 'Open the PR for review.', assistantAction: 'Pushing the branch and opening a pull request.', toolCore: 'opened pull request #4827 against main', vitalFact: '#4827' },
  { userPrompt: 'Build the service image.', assistantAction: 'Building the production container image.', toolCore: 'build OK: checkout-api image sha256:9f2d1ae7c4b0', vitalFact: 'sha256:9f2d1ae7c4b0' },
  { userPrompt: 'Where do we watch the rollout?', assistantAction: 'Grabbing the dashboard link.', toolCore: 'rollout dashboard at https://grafana.acme.io/d/checkout-rollout', vitalFact: 'https://grafana.acme.io/d/checkout-rollout' },
  { userPrompt: 'Deploy to staging.', assistantAction: 'Triggering the staging deploy pipeline.', toolCore: 'deploy job dispatched to worker-3.internal:8080', vitalFact: 'worker-3.internal:8080' },
  { userPrompt: 'Confirm the seeded order now passes.', assistantAction: 'Re-running the failing integration test.', toolCore: 'PASS: order 7f3e9a21 resolved in 41ms; 312/312 green', vitalFact: '7f3e9a21' },
  { userPrompt: 'File the incident ticket.', assistantAction: 'Writing the incident summary and filing it.', toolCore: 'incident filed as ticket a1b2c3d4-incident-2291', vitalFact: 'a1b2c3d4-incident-2291' },
];

export const TURN_COUNT = SIMULATED_CONVERSATION.length;
export const ALL_FACTS: readonly string[] = SIMULATED_CONVERSATION.map((t) => t.vitalFact);

/** Realistic, deterministic tool result: log noise with the vital fact buried in the middle. */
export function toolResultFor(turnIdx: number, t: SimulatedTurn, profile: SizeProfile): string {
  const noise = (tag: string, count: number): string => {
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      lines.push(`  [t${turnIdx}.${tag}${i}] processed record ${turnIdx * 1000 + i} status=ok latency=${(i % 9) + 1}ms`);
    }
    return lines.join('\n');
  };
  const half = Math.max(1, Math.floor(profile.toolResultChars / 2 / 60));
  return `${noise('a', half)}\n  >>> ${t.toolCore}\n${noise('b', half)}`;
}

export function turnMessages(turnIdx: number, t: SimulatedTurn, profile: SizeProfile): FoldMessage[] {
  return [
    { role: 'user', content: t.userPrompt },
    { role: 'assistant', content: t.assistantAction },
    { role: 'user', content: toolResultFor(turnIdx, t, profile) },
  ];
}

/**
 * Large, static, generic system prompt. Used by the LIVE benchmark as the stable
 * cacheable prefix (identical across all turns and all strategies) so the prompt
 * clears OpenAI's ≥1024-token caching threshold. It is intentionally verbose and
 * boring — its only job is to be a big, byte-identical block the provider can cache.
 */
export const STATIC_SYSTEM_PROMPT = [
  'You are a senior site-reliability engineer embedded in an incident channel.',
  'You operate a function-calling toolchain (code search, test runner, log tailer,',
  'metrics query, deploy pipeline) and your job is to drive a production incident to',
  'resolution while keeping a precise, auditable record of every identifier you touch.',
  '',
  'Operating procedure:',
  '1. Always restate the current hypothesis before acting.',
  '2. Prefer the smallest reversible change that tests the hypothesis.',
  '3. Never lose an identifier: file paths, order ids, host:port pairs, query digests,',
  '   trace ids, image digests, PR numbers, dashboard URLs, and ticket ids must remain',
  '   recoverable for the duration of the incident, because the post-incident review',
  '   will demand the exact values, not a paraphrase.',
  '4. When you read a large tool result, extract the one load-bearing fact and keep it.',
  '5. Distinguish a symptom (a 500, a timeout) from a cause (pool exhaustion, a slow',
  '   downstream) and from a fix (an index, a config change, a rollout).',
  '6. Treat every deploy as gated: staging first, confirm the seeded reproduction',
  '   passes, then production, then file the incident ticket with the full identifier',
  '   trail so the next on-call engineer can reconstruct the timeline.',
  '',
  'Style: terse, factual, no filler. Cite the exact identifier whenever you reference a',
  'prior finding. If you are uncertain, say so and propose the cheapest probe that would',
  'resolve the uncertainty. Do not speculate about systems you have not inspected.',
  'This system prompt is deliberately verbose and held byte-identical across every turn',
  'so that it forms a stable, cacheable prefix; the conversation that follows is what',
  'varies, and how each context strategy manages that variation is exactly what this',
  'benchmark measures.',
].join('\n');
