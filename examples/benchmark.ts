/**
 * Benchmark (OFFLINE) — Context Warp Drive vs Truncation vs LLM Summarization.
 *
 * Deterministic, no API key, no network — this is the CI smoke run and the
 * "reproduce it anywhere" demo. Every number is MEASURED from the real prepared
 * message views; nothing is hardcoded. Read top to bottom and verify each claim.
 *
 *   ┌─ For REAL provider numbers (actual model calls, a real LLM summarizer, and the
 *   │  provider's own cache_read token telemetry), run the live benchmark:
 *   │      OPENAI_API_KEY=sk-... npx tsx examples/benchmark-live.ts
 *   └─ This offline run is a faithful prediction of that; the live run confirms it.
 *
 * WHAT IS MEASURED (identically for all three strategies — apples-to-apples):
 *   • Cache hit — provider prompt caches reuse the longest IDENTICAL request prefix.
 *     Each turn we serialize the prepared view and compare it byte-for-byte to the
 *     previous turn's; the matching fraction is the share served from cache. CWD also
 *     exposes a real `cacheHot` flag from its freeze layer, reported as corroboration.
 *   • Input cost — the measured cached/fresh split each turn, tokenized with the REAL
 *     o200k_base BPE tokenizer (not a chars/token estimate) and priced with sourced
 *     list pricing for the default model. The live benchmark reports exact provider
 *     usage; this offline run reports exact local BPE counts.
 *   • Extra LLM calls — counted. Summarization makes a model round-trip per
 *     compaction; CWD and truncation make zero.
 *   • Fact retention — we scan each strategy's ACTUAL final prepared view for every
 *     vital identifier and count real substring hits. CWD's number comes from the real
 *     Coordinate Closet, not a constant.
 *
 * HONEST CAVEAT — the offline summarizer (`summarize()`) is a deterministic,
 * transparent stand-in: it keeps the gist plus a short head of each tool result and
 * drops the rest, where buried identifiers live. Real LLM summarizers vary, but all
 * share the two structural costs CWD avoids (an extra model call + a rewritten prefix
 * that busts the cache). The LIVE benchmark replaces this stand-in with a REAL model
 * call so you can see how an actual summarizer behaves.
 *
 * Run: `npx tsx examples/benchmark.ts` — deterministic; identical output every run.
 */

import { FoldSession, ALWAYS_ON_FOLD_CONFIG, type FoldMessage } from '../src/index.ts';
import {
  DEMO_PROFILE,
  SIMULATED_CONVERSATION,
  TURN_COUNT,
  ALL_FACTS,
  turnMessages,
  toolResultFor,
  serializeForCache,
  commonPrefixChars,
  countFactsPresent,
  countTokens,
  resolvePricing,
  DEFAULT_MODEL,
  inputCostUSD,
  outputCostUSD,
  type SimulatedTurn,
} from './bench-lib.ts';

const PROFILE = DEMO_PROFILE;
const PRICING = resolvePricing(DEFAULT_MODEL); // null only if an unknown WARP_BENCH_MODEL is set with no price override

// ── Token-accurate cost from the measured char-prefix cache split ──
// Total tokens per turn are EXACT BPE; the fresh/cached split tokenizes the cached
// prefix slice and the fresh remainder separately (≤1-token boundary effect, disclosed).
function turnInputCostUSD(serialized: string, cachedChars: number): number {
  if (!PRICING) return 0;
  const cachedTokens = cachedChars > 0 ? countTokens(serialized.slice(0, cachedChars)) : 0;
  const freshTokens = countTokens(serialized.slice(cachedChars));
  return inputCostUSD(freshTokens, cachedTokens, PRICING);
}

interface StrategyResult {
  strategyName: string;
  inputCostUSD: number;
  cacheHitPercent: number;
  extraLlmCalls: number;
  factsRetainedPercent: number;
  factsRetained: number;
  factsTotal: number;
  finalContextChars: number;
  finalContextTokens: number;
  notes?: string;
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
    raw.push(...turnMessages(i, SIMULATED_CONVERSATION[i], PROFILE));
    const view = raw.slice(-PROFILE.truncKeepTurns * 3);
    lastView = view;
    const serialized = serializeForCache(view);
    const cached = prev ? commonPrefixChars(prev, serialized) : 0;
    cost += turnInputCostUSD(serialized, cached);
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
    finalContextTokens: countTokens(finalText),
    notes: `keeps last ${PROFILE.truncKeepTurns} turns`,
  };
}

/**
 * Deterministic, transparent stand-in for an LLM summarizer. Keeps the gist (intent +
 * action) and a short head of each tool result, compressing the rest — modelling how
 * real summaries lose identifiers buried in tool output. The failure mode CWD's
 * Coordinate Closet is built to avoid. (The LIVE benchmark uses a real model instead.)
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
  for (const { t, idx } of recent) out.push(...turnMessages(idx, t, PROFILE));
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

    if (serialized.length > PROFILE.summTriggerChars && recent.length > PROFILE.summKeepTurns) {
      const toSummarize = recent.splice(0, recent.length - PROFILE.summKeepTurns);
      summarizedSoFar.push(...toSummarize);
      const summarizeInputTokens =
        toSummarize.reduce(
          (a, { t, idx }) =>
            a + countTokens(t.userPrompt) + countTokens(t.assistantAction) + countTokens(toolResultFor(idx, t, PROFILE)),
          0,
        ) + countTokens(summary);
      summary = summarize(summarizedSoFar);
      llmCalls++;
      if (PRICING) {
        cost += inputCostUSD(summarizeInputTokens, 0, PRICING) + outputCostUSD(countTokens(summary), PRICING);
      }
      view = buildSummaryView(summary, recent);
      serialized = serializeForCache(view);
    }

    lastView = view;
    const cached = prev ? commonPrefixChars(prev, serialized) : 0;
    cost += turnInputCostUSD(serialized, cached);
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
    finalContextTokens: countTokens(finalText),
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
    freeze: { enabled: true, ttlMs: 5 * 60_000, maxTailChars: PROFILE.cwdTailChars },
    now: () => clock,
  });

  const raw: FoldMessage[] = [];
  let prev = '';
  let cost = 0;
  let cacheAccum = 0;
  let hotCount = 0;
  let lastView: FoldMessage[] = [];

  for (let i = 0; i < TURN_COUNT; i++) {
    raw.push(...turnMessages(i, SIMULATED_CONVERSATION[i], PROFILE));
    clock += 1000; // deterministic, well under the freeze TTL

    const { messages, cacheHot } = session.prepare(raw);
    if (cacheHot) hotCount++;

    lastView = messages;
    const serialized = serializeForCache(messages);
    const cached = prev ? commonPrefixChars(prev, serialized) : 0;
    cost += turnInputCostUSD(serialized, cached);
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
    finalContextTokens: countTokens(finalText),
    notes: `${hotCount}/${TURN_COUNT} byte-identical freeze reuses · 0 model calls`,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function renderBenchmarkResults(): void {
  const sessionChars = SIMULATED_CONVERSATION.reduce(
    (a, t, i) => a + t.userPrompt.length + t.assistantAction.length + toolResultFor(i, t, PROFILE).length,
    0,
  );
  const priceLabel = PRICING
    ? `${DEFAULT_MODEL} — ${PRICING.source}`
    : `${DEFAULT_MODEL} — no pricing (set WARP_BENCH_PRICE_* for a $ figure)`;

  console.log('\n=================================================================================');
  console.log('   CONTEXT WARP DRIVE — OFFLINE MEASURED BENCHMARK (deterministic, no API key)');
  console.log(`   ${TURN_COUNT}-turn agent session (~${(sessionChars / 1000).toFixed(1)}K chars raw)`);
  console.log(`   Token counts: real o200k_base BPE · Pricing: ${priceLabel}`);
  console.log('   Every column is measured from the real prepared views (see file header).');
  console.log('   For real provider telemetry: npx tsx examples/benchmark-live.ts');
  console.log('=================================================================================\n');

  const results = [runTruncation(), runSummarization(), runContextWarp()];

  console.log('| Strategy                          | Input Cost | Cache Hit | LLM Calls | Fact Retention | Ctx (tok) |');
  console.log('|-----------------------------------|------------|-----------|-----------|----------------|-----------|');
  for (const r of results) {
    const name = pad(r.strategyName, 33);
    const cost = pad(PRICING ? `$${r.inputCostUSD.toFixed(4)}` : 'n/a', 10);
    const hit = pad(`${r.cacheHitPercent.toFixed(0)}%`, 9);
    const calls = pad(`${r.extraLlmCalls}`, 9);
    const facts = pad(`${r.factsRetainedPercent.toFixed(0)}% (${r.factsRetained}/${r.factsTotal})`, 14);
    const ctx = pad(`${(r.finalContextTokens / 1000).toFixed(1)}K`, 9);
    console.log(`| ${name} | ${cost} | ${hit} | ${calls} | ${facts} | ${ctx} |`);
  }

  console.log('\nNotes:');
  for (const r of results) console.log(`  • ${r.strategyName}: ${r.notes}`);

  const warp = results[2];
  const sum = results[1];
  const trunc = results[0];

  console.log('\n---------------------------------------------------------------------------------');
  console.log('   VERDICT (final context sizes are comparable — see Ctx column)');
  console.log('---------------------------------------------------------------------------------');
  console.log(`  • Cache-hit (measured prefix reuse):  CWD ${warp.cacheHitPercent.toFixed(0)}%  vs  Summarization ${sum.cacheHitPercent.toFixed(0)}%  vs  Truncation ${trunc.cacheHitPercent.toFixed(0)}%`);
  console.log(`  • Extra model calls:  CWD ${warp.extraLlmCalls}  vs  Summarization ${sum.extraLlmCalls} (each adds real cost + latency + non-determinism)`);
  if (PRICING && sum.inputCostUSD > 0) {
    const costSavings = ((sum.inputCostUSD - warp.inputCostUSD) / sum.inputCostUSD) * 100;
    console.log(`  • Input-cost vs. Summarization: ${costSavings >= 0 ? '-' : '+'}${Math.abs(costSavings).toFixed(1)}%`);
  }
  console.log(`  • Fact retention (real scan):  CWD ${warp.factsRetained}/${warp.factsTotal}  vs  Summarization ${sum.factsRetained}/${sum.factsTotal}  vs  Truncation ${trunc.factsRetained}/${trunc.factsTotal}`);
  console.log('---------------------------------------------------------------------------------');
  console.log('  Token counts are exact o200k_base BPE; costs use the sourced list price above.');
  console.log('  Assistant generation (identical across strategies) is excluded from input cost.');
  console.log('  The offline summarizer is a transparent deterministic stand-in — run');
  console.log('  benchmark-live.ts for a real model summarizer + provider cache telemetry.');
  console.log('=================================================================================\n');

  printRetentionDetail();
}

/** Per-fact transparency for CWD: show exactly which identifiers the closet conserved. */
function printRetentionDetail(): void {
  let clock = 0;
  const session = new FoldSession({
    foldConfig: ALWAYS_ON_FOLD_CONFIG,
    freeze: { enabled: true, ttlMs: 5 * 60_000, maxTailChars: PROFILE.cwdTailChars },
    now: () => clock,
  });
  const raw: FoldMessage[] = [];
  let view: FoldMessage[] = [];
  for (let i = 0; i < TURN_COUNT; i++) {
    raw.push(...turnMessages(i, SIMULATED_CONVERSATION[i], PROFILE));
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
