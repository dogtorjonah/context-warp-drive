/**
 * Benchmark (LIVE) — Context Warp Drive vs Truncation vs LLM Summarization, measured
 * against a REAL Claude model with Anthropic's own prompt-cache telemetry.
 *
 * This is the "proper benchmark": no estimates, no stand-ins, on the engine's primary
 * target (Claude).
 *   • Real Claude calls every turn — input/cache economics come from the provider's
 *     usage.cache_read_input_tokens / cache_creation_input_tokens, not a proxy.
 *   • A REAL Claude summarizer for the summarization arm (explicitly told to preserve
 *     every identifier — a fair shot). Whether it keeps them is measured.
 *   • Real token counts and real dollar cost (incl. the cache-write premium) from usage.
 *
 * Requires ANTHROPIC_API_KEY. Spends real tokens. Default model claude-sonnet-4-6
 * (matches the production telemetry table); set WARP_BENCH_MODEL=claude-haiku-4-5
 * for a cheaper smoke run, or any other listed/custom model.
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/benchmark-live.ts
 *
 * Anthropic caching is EXPLICIT: a `cache_control: {type:'ephemeral'}` breakpoint marks
 * the end of the cacheable prefix. We mark (1) the static system block — the shared
 * baseline every strategy caches — and (2) the end of the stable conversation prefix.
 * CWD's frozen fold keeps that prefix byte-identical across turns, so it reads from
 * cache; truncation slides and summarization rewrites, so their prefix diverges and
 * the cache misses past the system block. The measured delta is the point. Default
 * cache TTL is 5 min (Anthropic, since Mar 2026), so sequential turns stay warm.
 *
 * NOTE ON SCALE: prompt caching needs a prefix ≥1024 tokens; this demo's LIVE_PROFILE
 * clears that, but the headline production numbers (real long sessions, 150K frozen
 * tail, hundreds of turns) live in the README — that is where CWD's ~90% cache-read
 * rate actually shows up. A 16-turn demo understates it.
 */

import Anthropic from '@anthropic-ai/sdk';
import { FoldSession, ALWAYS_ON_FOLD_CONFIG, type FoldMessage } from '../src/index.ts';
import {
  LIVE_PROFILE,
  SIMULATED_CONVERSATION,
  TURN_COUNT,
  ALL_FACTS,
  STATIC_SYSTEM_PROMPT,
  turnMessages,
  toolResultFor,
  countFactsPresent,
  resolvePricing,
  DEFAULT_MODEL,
  liveInputCostUSD,
  outputCostUSD,
  type SimulatedTurn,
} from './bench-lib.ts';

const PROFILE = LIVE_PROFILE;
const MODEL = DEFAULT_MODEL;
const PRICING = resolvePricing(MODEL);
const MEASURE_OUTPUT_TOKENS = 16; // tiny — we measure INPUT/cache economics, not generation

interface Usage {
  input: number; // fresh (uncached) input
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
const ZERO: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

function addUsage(acc: Usage, u: Anthropic.Usage | undefined): Usage {
  return {
    input: acc.input + (u?.input_tokens ?? 0),
    cacheRead: acc.cacheRead + (u?.cache_read_input_tokens ?? 0),
    cacheWrite: acc.cacheWrite + (u?.cache_creation_input_tokens ?? 0),
    output: acc.output + (u?.output_tokens ?? 0),
  };
}

/** Coalesce the fold view into strict user/assistant alternation (Anthropic requirement). */
function coalesce(view: FoldMessage[]): { role: 'user' | 'assistant'; text: string }[] {
  const out: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const m of view) {
    const role: 'user' | 'assistant' = m.role === 'assistant' || m.role === 'model' ? 'assistant' : 'user';
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const last = out[out.length - 1];
    if (last && last.role === role) last.text += '\n' + text;
    else out.push({ role, text });
  }
  if (out.length > 0 && out[0].role === 'assistant') out.unshift({ role: 'user', text: '(session start)' });
  return out;
}

/** Build the Anthropic request: cached static system + the prepared view, with a cache breakpoint at the end of the stable prefix (all but the final turn). */
function buildRequest(view: FoldMessage[]): { system: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] } {
  const turns = coalesce(view);
  const breakpointIdx = Math.max(0, turns.length - 2); // end of the stable prefix (exclude the newest exchange)
  const messages: Anthropic.MessageParam[] = turns.map((t, i) => {
    if (i === breakpointIdx && turns.length > 1) {
      return { role: t.role, content: [{ type: 'text', text: t.text, cache_control: { type: 'ephemeral' } }] };
    }
    return { role: t.role, content: t.text };
  });
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: STATIC_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];
  return { system, messages };
}

async function measureCall(client: Anthropic, view: FoldMessage[]): Promise<Anthropic.Usage> {
  const { system, messages } = buildRequest(view);
  const res = await client.messages.create({ model: MODEL, max_tokens: MEASURE_OUTPUT_TOKENS, system, messages });
  return res.usage;
}

interface LiveResult {
  strategyName: string;
  usage: Usage;
  extraLlmCalls: number;
  perTurnInputCostUSD: number;
  overheadCostUSD: number;
  factsRetained: number;
  factsTotal: number;
  notes: string;
}

function inputCostOf(u: Usage): number {
  return PRICING ? liveInputCostUSD(u.input, u.cacheRead, u.cacheWrite, PRICING) : 0;
}
function cachePct(u: Usage): number {
  const total = u.input + u.cacheRead + u.cacheWrite;
  return total > 0 ? (u.cacheRead / total) * 100 : 0;
}

async function runTruncationLive(client: Anthropic): Promise<LiveResult> {
  const raw: FoldMessage[] = [];
  let usage = ZERO;
  let lastView: FoldMessage[] = [];
  for (let i = 0; i < TURN_COUNT; i++) {
    raw.push(...turnMessages(i, SIMULATED_CONVERSATION[i], PROFILE));
    lastView = raw.slice(-PROFILE.truncKeepTurns * 3);
    usage = addUsage(usage, await measureCall(client, lastView));
    process.stdout.write('.');
  }
  const retained = countFactsPresent(lastView.map((m) => (typeof m.content === 'string' ? m.content : '')).join(''), ALL_FACTS);
  return { strategyName: 'Truncation (Rolling Window)', usage, extraLlmCalls: 0, perTurnInputCostUSD: inputCostOf(usage), overheadCostUSD: 0, factsRetained: retained, factsTotal: ALL_FACTS.length, notes: `keeps last ${PROFILE.truncKeepTurns} turns` };
}

/** Real Claude summarizer — given a fair shot (explicitly told to preserve every identifier). */
async function realSummarize(client: Anthropic, priorSummary: string, turns: { t: SimulatedTurn; idx: number }[]): Promise<{ summary: string; usage: Anthropic.Usage }> {
  const body = turns.map(({ t, idx }) => `Turn ${idx + 1}:\nUser: ${t.userPrompt}\nAction: ${t.assistantAction}\nTool result:\n${toolResultFor(idx, t, PROFILE)}`).join('\n\n');
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 700,
    system: 'You compress agent conversation history for a context window. Preserve EVERY identifier verbatim — file paths, order/trace ids, host:port pairs, query digests, image digests (sha256:...), PR numbers (#NNNN), URLs, ticket ids. Losing an identifier is a critical failure. Concise prose, no preamble.',
    messages: [{ role: 'user', content: `${priorSummary ? `Prior summary:\n${priorSummary}\n\n` : ''}New turns to fold into the summary:\n\n${body}` }],
  });
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
  return { summary: text, usage: res.usage };
}

async function runSummarizationLive(client: Anthropic): Promise<LiveResult> {
  const recent: { t: SimulatedTurn; idx: number }[] = [];
  const summarizedSoFar: { t: SimulatedTurn; idx: number }[] = [];
  let summary = '';
  let usage = ZERO;
  let summaryUsage = ZERO;
  let llmCalls = 0;
  let lastView: FoldMessage[] = [];

  for (let i = 0; i < TURN_COUNT; i++) {
    recent.push({ t: SIMULATED_CONVERSATION[i], idx: i });
    const build = (): FoldMessage[] => {
      const out: FoldMessage[] = [];
      if (summary) out.push({ role: 'user', content: `[Summary of earlier turns]\n${summary}` });
      for (const { t, idx } of recent) out.push(...turnMessages(idx, t, PROFILE));
      return out;
    };
    const approxChars = build().reduce((a, m) => a + (typeof m.content === 'string' ? m.content.length : 0), 0);
    if (approxChars > PROFILE.summTriggerChars && recent.length > PROFILE.summKeepTurns) {
      const toSummarize = recent.splice(0, recent.length - PROFILE.summKeepTurns);
      summarizedSoFar.push(...toSummarize);
      const { summary: s, usage: su } = await realSummarize(client, summary, summarizedSoFar);
      summary = s;
      summaryUsage = addUsage(summaryUsage, su);
      llmCalls++;
      process.stdout.write('S');
    }
    lastView = build();
    usage = addUsage(usage, await measureCall(client, lastView));
    process.stdout.write('.');
  }

  const overhead = PRICING ? liveInputCostUSD(summaryUsage.input, summaryUsage.cacheRead, summaryUsage.cacheWrite, PRICING) + outputCostUSD(summaryUsage.output, PRICING) : 0;
  const retained = countFactsPresent(lastView.map((m) => (typeof m.content === 'string' ? m.content : '')).join(''), ALL_FACTS);
  return { strategyName: 'LLM Summarization', usage, extraLlmCalls: llmCalls, perTurnInputCostUSD: inputCostOf(usage), overheadCostUSD: overhead, factsRetained: retained, factsTotal: ALL_FACTS.length, notes: `${llmCalls} real summary call(s); +${summaryUsage.input + summaryUsage.output} tokens overhead` };
}

async function runContextWarpLive(client: Anthropic): Promise<LiveResult> {
  let clock = 0;
  const session = new FoldSession({ foldConfig: ALWAYS_ON_FOLD_CONFIG, freeze: { enabled: true, ttlMs: 60 * 60_000, maxTailChars: PROFILE.cwdTailChars }, now: () => clock });
  const raw: FoldMessage[] = [];
  let usage = ZERO;
  let hotCount = 0;
  let lastView: FoldMessage[] = [];
  for (let i = 0; i < TURN_COUNT; i++) {
    raw.push(...turnMessages(i, SIMULATED_CONVERSATION[i], PROFILE));
    clock += 1000;
    const { messages, cacheHot } = session.prepare(raw);
    if (cacheHot) hotCount++;
    lastView = messages;
    usage = addUsage(usage, await measureCall(client, messages));
    process.stdout.write('.');
  }
  const retained = countFactsPresent(lastView.map((m) => (typeof m.content === 'string' ? m.content : '')).join(''), ALL_FACTS);
  return { strategyName: 'Context Warp Drive (Deterministic)', usage, extraLlmCalls: 0, perTurnInputCostUSD: inputCostOf(usage), overheadCostUSD: 0, factsRetained: retained, factsTotal: ALL_FACTS.length, notes: `${hotCount}/${TURN_COUNT} byte-identical freeze reuses · 0 model calls` };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('\n  benchmark-live.ts needs a real Claude key. Set ANTHROPIC_API_KEY and re-run:');
    console.error('    ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/benchmark-live.ts');
    console.error('  (The offline, key-free benchmark is: npx tsx examples/benchmark.ts)');
    console.error('  (Production-measured cache numbers on real Claude sessions are in the README.)\n');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  console.log('\n=================================================================================');
  console.log('   CONTEXT WARP DRIVE — LIVE BENCHMARK (real Claude calls + Anthropic cache telemetry)');
  console.log(`   model=${MODEL} · ${TURN_COUNT} turns × 3 strategies`);
  console.log(`   pricing: ${PRICING ? PRICING.source : 'UNKNOWN model — reporting tokens only (set WARP_BENCH_PRICE_*)'}`);
  console.log('   Spends real tokens. Cache % = cache_read / total input (provider usage).');
  console.log('   A 16-turn demo understates cache reuse — see the README production numbers.');
  console.log('=================================================================================\n');
  process.stdout.write('  running (. = measured turn, S = real summary call): ');

  let results: LiveResult[];
  try {
    const trunc = await runTruncationLive(client);
    const summ = await runSummarizationLive(client);
    const warp = await runContextWarpLive(client);
    results = [trunc, summ, warp];
  } catch (err) {
    console.error('\n\n  Live call failed:', err instanceof Error ? err.message : String(err));
    console.error('  If this is a model error, set a model your key serves: WARP_BENCH_MODEL=claude-sonnet-4-6\n');
    process.exit(1);
    return;
  }
  console.log('\n');

  console.log('| Strategy                          | Cache Hit | Input tok | Cache-rd tok | LLM Calls | Fact Retention |');
  console.log('|-----------------------------------|-----------|-----------|--------------|-----------|----------------|');
  for (const r of results) {
    console.log(
      `| ${pad(r.strategyName, 33)} | ${pad(`${cachePct(r.usage).toFixed(0)}%`, 9)} | ${pad(`${r.usage.input}`, 9)} | ${pad(`${r.usage.cacheRead}`, 12)} | ${pad(`${r.extraLlmCalls}`, 9)} | ${pad(`${((r.factsRetained / r.factsTotal) * 100).toFixed(0)}% (${r.factsRetained}/${r.factsTotal})`, 14)} |`,
    );
  }

  if (PRICING) {
    console.log('\n| Strategy                          | Per-turn input $ | Strategy overhead $ | Total $   |');
    console.log('|-----------------------------------|------------------|---------------------|-----------|');
    for (const r of results) {
      const total = r.perTurnInputCostUSD + r.overheadCostUSD;
      console.log(`| ${pad(r.strategyName, 33)} | ${pad(`$${r.perTurnInputCostUSD.toFixed(5)}`, 16)} | ${pad(`$${r.overheadCostUSD.toFixed(5)}`, 19)} | ${pad(`$${total.toFixed(5)}`, 9)} |`);
    }
  }

  console.log('\nNotes:');
  for (const r of results) console.log(`  • ${r.strategyName}: ${r.notes}`);
  console.log('\n  All arms share the cached static system prompt; the cache delta above that');
  console.log('  baseline is CWD\'s frozen-fold advantage. Live numbers vary run-to-run.');
  console.log('=================================================================================\n');
}

main();
