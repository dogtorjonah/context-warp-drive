/**
 * Benchmark — Context Warp Drive vs Truncation vs LLM Summarization.
 *
 * Every number below is MEASURED from the real prepared message views. Nothing is
 * hardcoded; read the file top to bottom and verify each claim.
 *
 * THE SCENARIO. A long agent session under a fixed context budget. Tool results are
 * realistically large (a file read, a test run, a log tail) with one vital identifier
 * BURIED in the noise — the kind of value an agent must still recall many turns later.
 * All three strategies are given a COMPARABLE working-context budget (we print each
 * one's final context size so you can see the comparison is fair); they differ only
 * in how they handle older history:
 *   • Truncation   — drop the oldest turns entirely.
 *   • Summarization — replace older turns with a model-written summary (a real model
 *     call each time; rewrites the prefix → busts the provider cache).
 *   • Warp Drive   — fold older turns to a skeleton, conserve salient identifiers in
 *     the Coordinate Closet, and freeze the prefix byte-identical (cache stays hot).
 *
 * WHAT IS MEASURED
 *   • Cache hit — provider prompt caches reuse the longest IDENTICAL request prefix.
 *     Each turn we serialize the prepared view and compare it byte-for-byte to the
 *     previous turn's; the matching fraction is the share served from cache. The same
 *     measurement is applied to all three (apples-to-apples). CWD also exposes a real
 *     `cacheHot` flag from its freeze layer, reported as corroboration.
 *   • Input cost — derived from the measured cached/fresh character split each turn,
 *     priced with public Claude Sonnet 4.6 list pricing (sourced below). Token counts
 *     are a documented chars/token ESTIMATE — for exact accounting use your provider's
 *     usage API. We report INPUT/context cost (what compaction controls); assistant
 *     generation is identical across strategies and excluded.
 *   • Extra LLM calls — counted. Summarization makes a real model round-trip per
 *     compaction; CWD and truncation make zero.
 *   • Fact retention — we scan each strategy's ACTUAL final prepared view for every
 *     vital identifier from the whole session and count real substring hits. CWD's
 *     number comes from inspecting the real Coordinate Closet, not a constant.
 *
 * HONEST CAVEATS
 *   • The summarizer (see `summarize()`) is a deterministic, transparent stand-in: it
 *     keeps the conversational gist plus a short head of each tool result and drops
 *     the rest — where buried identifiers live. Real LLM summarizers vary, but all
 *     share the two structural costs CWD avoids (an extra model call + a rewritten
 *     prefix). Swap in a real model call to measure your own.
 *   • The Coordinate Closet is BUDGET-SCORED: it conserves the most salient
 *     identifiers from folded turns within a char budget, not literally everything.
 *     Retention here reflects that real behavior.
 *   • Sizes are scaled down for a fast, deterministic demo. The fold/freeze/closet
 *     logic is size-independent — bump TOOL_RESULT_CHARS / the conversation length and
 *     use the shipping 150K tail default for production-scale numbers.
 *
 * Pricing — Claude Sonnet 4.6 public list price (2026):
 *   input (base) $3.00/MTok · output $15.00/MTok
 *   cache read $0.30/MTok (10% of base) · 5-min cache write $3.75/MTok (1.25x base)
 *   Sources: https://platform.claude.com/docs/en/about-claude/pricing
 *            https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *
 * Run: `npx tsx examples/benchmark.ts` — deterministic; identical output every run.
 */

import { FoldSession, ALWAYS_ON_FOLD_CONFIG, type FoldMessage } from '../src/index.ts';

// ── Pricing (Claude Sonnet 4.6 list price, $/MTok — see header sources) ──
const PRICE_INPUT_BASE = 3.0;
const PRICE_OUTPUT = 15.0;
const PRICE_CACHE_READ = 0.3; // cache hit — 10% of base
const PRICE_CACHE_WRITE = 3.75; // 5-min cache write — 1.25x base

// Token estimate. APPROXIMATION used only to turn measured character counts into a
// dollar figure; NOT a substitute for your provider's usage API. ~3.8 chars/token is
// typical for dense agent traces (code, paths, ids).
const CHARS_PER_TOKEN = 3.8;
const estTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

// ── Tunables (scaled for a fast deterministic demo — see header) ──
// Budgets are tuned so all three strategies hold a COMPARABLE final context size
// (~5K chars — see the Ctx Size column), isolating the strategy difference: CWD's
// wins are not "it just keeps more context."
const TOOL_RESULT_CHARS = 700; // realistic-ish tool output size; the vital fact is buried inside
const TRUNC_KEEP_TURNS = 7; // truncation window (sized to ~match CWD's context size)
const SUMM_TRIGGER_CHARS = 4800; // summarize when the view exceeds this
const SUMM_KEEP_TURNS = 4; // turns kept verbatim after a summary
const CWD_TAIL_CHARS = 2400; // freeze raw-tail cap (prod default is 150_000)

interface SimulatedTurn {
  userPrompt: string;
  assistantAction: string;
  /** Short realistic core line of the tool output (the vital fact is embedded, then buried in noise). */
  toolCore: string;
  /** The one identifier from this turn the agent must still be able to recall later. */
  vitalFact: string;
}

/**
 * A realistic agent session: debugging a production checkout outage. Each turn's
 * tool result buries one vital identifier (path, UUID, host:port, hash, ref, URL) in
 * realistic log noise. Deliberately generic — no internal/proprietary references.
 */
const SIMULATED_CONVERSATION: SimulatedTurn[] = [
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

const TURN_COUNT = SIMULATED_CONVERSATION.length;
const ALL_FACTS: readonly string[] = SIMULATED_CONVERSATION.map((t) => t.vitalFact);

/** Build a realistic, deterministic tool result: log noise with the vital fact buried in the middle. */
function toolResultFor(turnIdx: number, t: SimulatedTurn): string {
  const noise = (tag: string, count: number): string => {
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      lines.push(`  [t${turnIdx}.${tag}${i}] processed record ${turnIdx * 1000 + i} status=ok latency=${(i % 9) + 1}ms`);
    }
    return lines.join('\n');
  };
  const half = Math.max(1, Math.floor(TOOL_RESULT_CHARS / 2 / 60));
  return `${noise('a', half)}\n  >>> ${t.toolCore}\n${noise('b', half)}`;
}

function turnMessages(turnIdx: number, t: SimulatedTurn): FoldMessage[] {
  return [
    { role: 'user', content: t.userPrompt },
    { role: 'assistant', content: t.assistantAction },
    { role: 'user', content: toolResultFor(turnIdx, t) },
  ];
}

interface StrategyResult {
  strategyName: string;
  inputCostUSD: number;
  cacheHitPercent: number; // avg per-turn share of prefix served from cache (measured)
  extraLlmCalls: number;
  factsRetainedPercent: number;
  factsRetained: number;
  factsTotal: number;
  finalContextChars: number; // final prepared-view size — printed so the budgets are visibly comparable
  notes?: string;
}

// ── Measurement helpers (shared, identical for every strategy) ──

function serializeForCache(messages: FoldMessage[]): string {
  return messages
    .map((m) => `${m.role}${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('');
}

function commonPrefixChars(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function countFactsPresent(text: string, facts: readonly string[]): number {
  let n = 0;
  for (const f of facts) if (text.includes(f)) n++;
  return n;
}

function inputCostUSD(freshChars: number, cachedChars: number): number {
  return (
    (estTokens(freshChars) / 1_000_000) * PRICE_CACHE_WRITE +
    (estTokens(cachedChars) / 1_000_000) * PRICE_CACHE_READ
  );
}

/**
 * 1. TRUNCATION (rolling window) — keep only the last N turns; older turns (and their
 * facts) are gone. Once the window slides, the leading message changes every turn, so
 * the cacheable prefix is destroyed (measured).
 */
function runTruncation(): StrategyResult {
  const raw: FoldMessage[] = [];
  let prev = '';
  let cost = 0;
  let cacheAccum = 0;
  let lastView: FoldMessage[] = [];

  for (let i = 0; i < TURN_COUNT; i++) {
    raw.push(...turnMessages(i, SIMULATED_CONVERSATION[i]));
    const view = raw.slice(-TRUNC_KEEP_TURNS * 3);
    lastView = view;
    const serialized = serializeForCache(view);
    const cached = prev ? commonPrefixChars(prev, serialized) : 0;
    cost += inputCostUSD(serialized.length - cached, cached);
    cacheAccum += serialized.length > 0 ? cached / serialized.length : 0;
    prev = serialized;
  }

  const finalText = serializeForCache(lastView);
  const retained = countFactsPresent(finalText, ALL_FACTS);
  return {
    strategyName: 'Truncation (Rolling Window)',
    inputCostUSD: cost,
    cacheHitPercent: (cacheAccum / TURN_COUNT) * 100,
    extraLlmCalls: 0,
    factsRetainedPercent: (retained / ALL_FACTS.length) * 100,
    factsRetained: retained,
    factsTotal: ALL_FACTS.length,
    finalContextChars: finalText.length,
    notes: `keeps last ${TRUNC_KEEP_TURNS} turns`,
  };
}

/**
 * Deterministic, transparent stand-in for an LLM summarizer. Keeps the conversational
 * gist (intent + action) and a short head of each tool result, compressing the rest —
 * modelling how real summaries lose identifiers buried in tool output. The failure
 * mode CWD's Coordinate Closet is built to avoid.
 */
function summarize(turns: { t: SimulatedTurn; idx: number }[]): string {
  const lines = turns.map(
    ({ t, idx }) => `${idx + 1}. ${t.userPrompt} -> ${t.assistantAction} (${t.toolCore.slice(0, 32)}...)`,
  );
  return `[Summary of the first ${turns.length} turns]\n${lines.join('\n')}`;
}

function buildSummaryView(summary: string, recent: { t: SimulatedTurn; idx: number }[]): FoldMessage[] {
  const out: FoldMessage[] = [];
  if (summary) out.push({ role: 'user', content: summary });
  for (const { t, idx } of recent) out.push(...turnMessages(idx, t));
  return out;
}

/**
 * 2. LLM SUMMARIZATION ("compaction") — when the view exceeds a threshold, fold older
 * turns into a model-written summary. Each summary is a real model call (counted) and
 * REWRITES the leading block, busting the provider cache on summary turns (measured).
 * Identifiers buried in tool output are compressed away (measured retention).
 */
function runSummarization(): StrategyResult {
  const recent: { t: SimulatedTurn; idx: number }[] = [];
  let summary = '';
  const summarizedSoFar: { t: SimulatedTurn; idx: number }[] = [];
  let prev = '';
  let cost = 0;
  let cacheAccum = 0;
  let llmCalls = 0;
  let lastView: FoldMessage[] = [];

  for (let i = 0; i < TURN_COUNT; i++) {
    recent.push({ t: SIMULATED_CONVERSATION[i], idx: i });
    let view = buildSummaryView(summary, recent);
    let serialized = serializeForCache(view);

    if (serialized.length > SUMM_TRIGGER_CHARS && recent.length > SUMM_KEEP_TURNS) {
      const toSummarize = recent.splice(0, recent.length - SUMM_KEEP_TURNS);
      summarizedSoFar.push(...toSummarize);
      const summarizeInputChars =
        toSummarize.reduce(
          (a, { t, idx }) => a + t.userPrompt.length + t.assistantAction.length + toolResultFor(idx, t).length,
          0,
        ) + summary.length;
      summary = summarize(summarizedSoFar);
      llmCalls++;
      cost +=
        (estTokens(summarizeInputChars) / 1_000_000) * PRICE_INPUT_BASE +
        (estTokens(summary.length) / 1_000_000) * PRICE_OUTPUT;
      view = buildSummaryView(summary, recent);
      serialized = serializeForCache(view);
    }

    lastView = view;
    const cached = prev ? commonPrefixChars(prev, serialized) : 0;
    cost += inputCostUSD(serialized.length - cached, cached);
    cacheAccum += serialized.length > 0 ? cached / serialized.length : 0;
    prev = serialized;
  }

  const finalText = serializeForCache(lastView);
  const retained = countFactsPresent(finalText, ALL_FACTS);
  return {
    strategyName: 'LLM Summarization',
    inputCostUSD: cost,
    cacheHitPercent: (cacheAccum / TURN_COUNT) * 100,
    extraLlmCalls: llmCalls,
    factsRetainedPercent: (retained / ALL_FACTS.length) * 100,
    factsRetained: retained,
    factsTotal: ALL_FACTS.length,
    finalContextChars: finalText.length,
    notes: `${llmCalls} summary model call(s)`,
  };
}

/**
 * 3. CONTEXT WARP DRIVE — deterministic rolling fold + Coordinate Closet + frozen
 * cache-hot prefix. We feed the REAL engine the full history every turn and measure
 * its real output: zero model calls, the closet conserves salient identifiers from
 * folded turns, and the frozen prefix keeps the provider cache hot.
 */
function runContextWarp(): StrategyResult {
  let clock = 0;
  const session = new FoldSession({
    foldConfig: ALWAYS_ON_FOLD_CONFIG,
    freeze: { enabled: true, ttlMs: 5 * 60_000, maxTailChars: CWD_TAIL_CHARS },
    now: () => clock,
  });

  const raw: FoldMessage[] = [];
  let prev = '';
  let cost = 0;
  let cacheAccum = 0;
  let hotCount = 0;
  let foldCpuMs = 0;
  let lastView: FoldMessage[] = [];

  for (let i = 0; i < TURN_COUNT; i++) {
    raw.push(...turnMessages(i, SIMULATED_CONVERSATION[i]));
    clock += 1000; // deterministic, well under the freeze TTL

    const t0 = performance.now();
    const { messages, cacheHot } = session.prepare(raw);
    foldCpuMs += performance.now() - t0;
    if (cacheHot) hotCount++;

    lastView = messages;
    const serialized = serializeForCache(messages);
    const cached = prev ? commonPrefixChars(prev, serialized) : 0;
    cost += inputCostUSD(serialized.length - cached, cached);
    cacheAccum += serialized.length > 0 ? cached / serialized.length : 0;
    prev = serialized;
  }

  const finalText = serializeForCache(lastView);
  const retained = countFactsPresent(finalText, ALL_FACTS);
  return {
    strategyName: 'Context Warp Drive (Deterministic)',
    inputCostUSD: cost,
    cacheHitPercent: (cacheAccum / TURN_COUNT) * 100,
    extraLlmCalls: 0,
    factsRetainedPercent: (retained / ALL_FACTS.length) * 100,
    factsRetained: retained,
    factsTotal: ALL_FACTS.length,
    finalContextChars: finalText.length,
    notes: `${hotCount}/${TURN_COUNT} byte-identical freeze reuses · fold cost ${foldCpuMs.toFixed(1)}ms total · 0 model calls`,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function renderBenchmarkResults(): void {
  const sessionChars = SIMULATED_CONVERSATION.reduce(
    (a, t, i) => a + t.userPrompt.length + t.assistantAction.length + toolResultFor(i, t).length,
    0,
  );

  console.log('\n=================================================================================');
  console.log('   CONTEXT WARP DRIVE — MEASURED CONTEXT-STRATEGY BENCHMARK');
  console.log(`   ${TURN_COUNT}-turn agent session (~${(sessionChars / 1000).toFixed(1)}K chars raw) · Claude Sonnet 4.6 pricing`);
  console.log('   Every column is measured from the real prepared views (see file header).');
  console.log('=================================================================================\n');

  const results = [runTruncation(), runSummarization(), runContextWarp()];

  console.log('| Strategy                          | Input Cost | Cache Hit | LLM Calls | Fact Retention | Ctx Size |');
  console.log('|-----------------------------------|------------|-----------|-----------|----------------|----------|');
  for (const r of results) {
    const name = pad(r.strategyName, 33);
    const cost = pad(`$${r.inputCostUSD.toFixed(4)}`, 10);
    const hit = pad(`${r.cacheHitPercent.toFixed(0)}%`, 9);
    const calls = pad(`${r.extraLlmCalls}`, 9);
    const facts = pad(`${r.factsRetainedPercent.toFixed(0)}% (${r.factsRetained}/${r.factsTotal})`, 14);
    const ctx = pad(`${(r.finalContextChars / 1000).toFixed(1)}K`, 8);
    console.log(`| ${name} | ${cost} | ${hit} | ${calls} | ${facts} | ${ctx} |`);
  }

  console.log('\nNotes:');
  for (const r of results) console.log(`  • ${r.strategyName}: ${r.notes}`);

  const warp = results[2];
  const sum = results[1];
  const trunc = results[0];
  const costSavings = sum.inputCostUSD > 0 ? ((sum.inputCostUSD - warp.inputCostUSD) / sum.inputCostUSD) * 100 : 0;

  console.log('\n---------------------------------------------------------------------------------');
  console.log('   VERDICT (final context sizes are comparable — see Ctx Size column)');
  console.log('---------------------------------------------------------------------------------');
  console.log(`  • Cache-hit (measured prefix reuse):  CWD ${warp.cacheHitPercent.toFixed(0)}%  vs  Summarization ${sum.cacheHitPercent.toFixed(0)}%  vs  Truncation ${trunc.cacheHitPercent.toFixed(0)}%`);
  console.log(`  • Extra model calls:  CWD ${warp.extraLlmCalls}  vs  Summarization ${sum.extraLlmCalls} (each adds real cost + latency + non-determinism)`);
  console.log(`  • Input-cost reduction vs. Summarization: ${costSavings >= 0 ? '-' : '+'}${Math.abs(costSavings).toFixed(1)}%`);
  console.log(`  • Fact retention (real scan):  CWD ${warp.factsRetained}/${warp.factsTotal}  vs  Summarization ${sum.factsRetained}/${sum.factsTotal}  vs  Truncation ${trunc.factsRetained}/${trunc.factsTotal}`);
  console.log('---------------------------------------------------------------------------------');
  console.log('  Token counts are a chars/token estimate; costs use public Sonnet 4.6 list');
  console.log('  pricing. Assistant generation (identical across strategies) is excluded.');
  console.log('=================================================================================\n');

  printRetentionDetail();
}

/** Per-fact transparency for CWD: show exactly which identifiers the closet conserved. */
function printRetentionDetail(): void {
  let clock = 0;
  const session = new FoldSession({
    foldConfig: ALWAYS_ON_FOLD_CONFIG,
    freeze: { enabled: true, ttlMs: 5 * 60_000, maxTailChars: CWD_TAIL_CHARS },
    now: () => clock,
  });
  const raw: FoldMessage[] = [];
  let view: FoldMessage[] = [];
  for (let i = 0; i < TURN_COUNT; i++) {
    raw.push(...turnMessages(i, SIMULATED_CONVERSATION[i]));
    clock += 1000;
    view = session.prepare(raw).messages;
  }
  const text = serializeForCache(view);
  console.log('Per-fact retention in CWD final view (vital identifiers, oldest first):');
  SIMULATED_CONVERSATION.forEach((t, i) => {
    console.log(`  ${text.includes(t.vitalFact) ? '[kept]' : '[lost]'} turn ${String(i + 1).padStart(2)}: ${t.vitalFact}`);
  });
  console.log('');
}

renderBenchmarkResults();
