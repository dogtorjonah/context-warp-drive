# Context Warp Drive

[![npm version](https://img.shields.io/npm/v/context-warp-drive.svg)](https://www.npmjs.com/package/context-warp-drive) [![CI](https://github.com/dogtorjonah/context-warp-drive/actions/workflows/ci.yml/badge.svg)](https://github.com/dogtorjonah/context-warp-drive/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Stop summarizing your agent's memory.** Every compaction call burns a model round-trip, rewrites your prefix so the provider prompt cache goes cold, and quietly drops the exact identifiers your agent needs. Fold it deterministically instead.

**The Infinite Context Warp Engine.** Keep long function-calling agent sessions under the context window **without LLM summarization calls** and **without ending the session** — while keeping provider prompt caches **hot** — and page folded content back in the moment the agent touches it again.

Deterministic. Zero-LLM. Pure CPU, zero I/O, byte-identical output for identical inputs. Provider-agnostic: **Anthropic** content blocks, **OpenAI** `tool_calls`, and **Gemini** `parts`.

Extracted from a production multi-agent system (the Voxxo Swarm), where it folds context continuously across every model and long-running agent workloads.

- The core engine passes **277 deterministic tests** across rolling fold, recall, freeze, and integration.
- Every number below is **measured, not estimated** — production cache rates from the Claude provider usage ledger, reproducible live against Claude (`ANTHROPIC_API_KEY=… npx tsx examples/benchmark-live.ts`, real model + real summarizer) and offline with exact `o200k_base` BPE token counts (`npx tsx examples/benchmark.ts`, deterministic, no key).

---

## Performance & Economics

### Measured in production — real Claude workloads, provider cache telemetry

The numbers that matter are from the production multi-agent system this engine powers — real Claude workloads running the fold/freeze engine continuously across **hundreds of turns**, measured from the provider's own usage ledger (cache-read tokens ÷ total input tokens):

| Production Claude workload | Measured turns | Cache-read hit | Fresh input | Cache-read input |
| :--- | :---: | :---: | :---: | :---: |
| Opus 4.8 agent | 691 | **89.6%** | 32.9M tok | 292.6M tok |
| Opus agent | 510 | **93.2%** | 32.6M tok | 602.5M tok |

**~90% of all input tokens are served from cache** across these high-turn Claude workloads — that is the byte-identical frozen-fold prefix doing its job, turn after turn, at $0.30/MTok cache reads instead of $3.00/MTok fresh input (Sonnet rates). A re-summarizing compactor rewrites the prefix and can never sustain this; truncation slides the window and breaks it. This is the entire economic argument, measured live.

### Reproduce it yourself — live, against Claude

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/benchmark-live.ts   # default claude-haiku-4-5
```

Real Claude calls every turn with Anthropic `cache_control` breakpoints, a **real Claude summarizer** (told to preserve every identifier — a fair fight), and the provider's own `cache_read_input_tokens` / `cache_creation_input_tokens`. A short 16-turn demo *understates* the production cache rate (caching needs a ≥1024-token prefix and CWD's advantage compounds over long sessions) — but it shows the mechanism on real telemetry, with CWD reading from cache while truncation and summarization rebuild their prefix.

### Offline deterministic demo (no API key, byte-identical every run)

`npx tsx examples/benchmark.ts` — a 16-turn outage-debugging session, exact `o200k_base` BPE token counts (a portable proxy; Claude's tokenizer isn't public), `claude-haiku-4-5` list pricing. This is the CI smoke test; the cache column is a turn-over-turn byte-prefix proxy and the summarizer is a transparent deterministic stand-in (it drops ids buried past its head cutoff — the failure mode the Coordinate Closet exists to avoid).

| Strategy | Input Cost | Cache Hit (prefix proxy) | Extra LLM Calls | Fact Retention |
| :--- | :---: | :---: | :---: | :---: |
| Truncation (rolling window) | $0.0172 | 28% | 0 | 44% (7/16) |
| LLM Summarization (stand-in) | $0.0228 | 43% | 6 | 44% (7/16) |
| **Context Warp Drive** | **$0.0066** | 60% | 0 | **94% (15/16)** |

CWD is cheapest (**−71% vs summarization, −62% vs truncation** at Claude-haiku rates), makes zero extra model calls, and beats truncation decisively on retention. (A well-prompted *real* summarizer can match retention at higher cost — CWD's durable edge is cost + zero calls + determinism + a hot cache.) The engine is provider-agnostic: set `WARP_BENCH_MODEL` (and `WARP_BENCH_PRICE_*` for an unlisted model) to benchmark against any model, including OpenAI.

---

## Why

Every long agent session hits the same wall: the context window fills up. The usual answers are bad:

- **Truncation** drops the middle of your history — the agent forgets what it was doing.
- **LLM summarization ("compaction")** costs a model call, adds latency, is non-deterministic, and **busts your provider prompt cache** every time it rewrites the prefix.

Context Warp Drive does neither. It **deterministically folds** old turns into compact structural skeletons (one line per tool call + retained reasoning), **conserves the salient exact identifiers** (UUIDs, SHAs, paths, ports) in a budget-scored Coordinate Closet, **freezes** the folded prefix so it's reused byte-identical while the provider cache is warm, and **pages folded content back in** automatically when the agent re-touches a path. No model calls. No truncation. Cache stays hot.

---

## Install

```bash
npm install context-warp-drive
# optional — only for the reference SQLite episode store:
npm install better-sqlite3
```

The core (`context-warp-drive/fold`) has **zero runtime dependencies**. `better-sqlite3` is an optional peer needed only by the reference episodic store.

---

## If you ask an AI to wire it in

Paste this:

> Install `context-warp-drive` and wrap our function-calling message history with `FoldSession.prepare()` before each model call. Preserve raw history separately; send only the prepared `messages` view to the provider. Use `cacheHot` and `stats` for logging.

Then add the provider cache knob:

| Provider | What to do |
|---|---|
| Claude / Anthropic | Add top-level `cache_control: { type: 'ephemeral' }` to the request. Use `ttl: '1h'` only when you actually want Anthropic's paid 1-hour cache. Log `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens`. |
| OpenAI | No cache marker is required. Keep static tools/system/context first, pass the prepared `messages`, optionally reuse a stable `prompt_cache_key`, and log `usage.prompt_tokens_details.cached_tokens`. |
| Gemini | Implicit caching is automatic on Gemini 2.5+ when prefixes match. For a large static document/corpus, create an explicit Gemini cache separately and pass it as `cachedContent`; keep the folded conversation after that stable prefix. Log `usage_metadata`. |

Context Warp Drive keeps the prefix byte-identical. The provider SDK call still owns provider-specific cache settings.

---

## Quickstart

```ts
import { FoldSession } from 'context-warp-drive';

// One per conversation. Folds past the active window + keeps the provider cache hot.
const session = new FoldSession();

// Your full provider-shaped history (Anthropic / OpenAI / Gemini message objects).
const history = [
  { role: 'user', content: 'Investigate the failing test in src/parser.ts' },
  // ... grows every turn ...
];

// Every turn, before you call the model:
const { messages, cacheHot, stats } = session.prepare(history);

// `messages` is the compacted view to send. When `cacheHot` is true the prefix is
// byte-identical to last turn, so the provider prompt cache is reused.
await callYourModel(messages); // Anthropic / OpenAI / Gemini — the message shapes pass through unchanged
console.log(`sent ${messages.length} msgs · cacheHot=${cacheHot} · savings=${stats.savingsPercent ?? 0}%`);
```

That's the whole headline. For continuous always-lean folding, pass `ALWAYS_ON_FOLD_CONFIG`; to match your provider's real cache TTL, set `freeze: { enabled: true, ttlMs: 3_600_000, maxTailChars: 150_000 }`.

See [`examples/anthropic-loop.ts`](./examples/anthropic-loop.ts) and [`examples/openai-loop.ts`](./examples/openai-loop.ts) for full tool loops.

---

## How it works

### 1. Rolling fold (page-out) — `foldContext`
From the active window backward, every prior turn skeletonizes into one line per tool call (`$ cmd → ok`, `read path`, …) plus budgeted retained reasoning. Only the newest turns stay at full fidelity. The fold is a synthetic user+assistant pair with a self-documenting preamble; it never mutates your raw history (it returns a *view*).

### 2. Coordinate Closet — exact-value conservation
Folded turns are skeletonized, **but their exact identifiers are not paraphrased**. `nominateVerbatim` extracts UUIDs, long hashes, absolute paths, digit-bearing key/values (`port=3002`), and issue refs, and conserves them in a `Coordinate Closet (conserved from folded turns): …` block. Opaque ids carry a deterministic context label (`7fd5835b ⟦changelog_id⟧`). A separate capped lane conserves identifiers from operator-pasted user text too.

### 3. Fold freeze (cache-hot reuse) — `evaluateFoldFreeze`
The folded prefix is **frozen** and reused **byte-identical** between epochs, so new turns just append to the raw tail and the provider prompt cache stays warm. It only recomputes at an epoch: first call, cold TTL gap, raw-tail cap exceeded, a thinning/claim change, or a boundary rewrite. **Maximizing the hot-reuse ratio is the entire point of deterministic folding** — a re-summarizing compactor can never do this.

### 4. Fold recall (ambient page-in) — `buildFoldRecallContext`
A page table (`buildFoldIndex`) tracks everything the fold paged out. When activity proves relevance — you touch a path again, or claim a file — the folded content **pages back in** as a budgeted recall card, appended append-only onto the freeze tail (cache stays hot) and re-folded at the next epoch. Fully cyclic, with residency TTLs so cards don't thrash.

### 5. Episodic recall (durable cross-session memory) — `context-warp-drive/episodes`
Beyond the in-session fold, sealed work **episodes** (the files touched + the agent's verbatim conclusions) persist to a local store and are recalled by path the next time any session touches a member file. Turnkey portable store included (`createEpisodeStore`, SQLite); the advanced chain-card/narration engine ships namespaced as `richEpisodes`.

### 6. Glyph grammar (register tags) — `context-warp-drive/glyphs`
Every agent message opens with one register glyph — 🔍 in-progress · 🏁 verdict · ⚠️ hazard · ❓ blocked. `parseRegisterGlyph` classifies it; episodic recall uses it as a trust signal so only **settled** conclusions (🏁/⚠️) get harvested into durable memory and in-progress hypotheses (🔍) self-exclude. See [`docs/glyph-grammar.md`](./docs/glyph-grammar.md).

---

## Provider-agnostic by design

The engine reads three message shapes natively — pass your history through unchanged:

| Provider | Shape |
|---|---|
| Anthropic | `{ role, content: string \| ContentBlock[] }` with `tool_use` / `tool_result` blocks |
| OpenAI (+ DeepSeek, Kimi, GLM, Mistral, Grok, MiniMax) | `{ role, content, tool_calls }` + `{ role: 'tool', tool_call_id }` |
| Gemini | `{ role: 'model', parts: [...] }` with `functionCall` / `functionResponse` |

> **FC (function-calling) APIs only.** Context Warp Drive folds the *conversational message array* you control. CLI/agent runtimes that own their own context (and don't expose the message array) can't be folded this way.

---

## API surface

```ts
// Core fold engine (zero deps) — also at "context-warp-drive/fold"
import {
  FoldSession,           // the orchestrator (fold + freeze)
  foldContext,           // rolling fold (page-out)
  ALWAYS_ON_FOLD_CONFIG, DEFAULT_FOLD_CONFIG, type FoldConfig, type FoldMessage, type FoldResult,
  evaluateFoldFreeze, commitFoldFreeze, createFoldFreezeState, // freeze layer
  buildFoldIndex, extractRecallSignals, buildFoldRecallContext, // recall layer
  nominateVerbatim, detectTurns,
} from 'context-warp-drive';

// Episodic recall — also at "context-warp-drive/episodes"
import {
  deriveEpisodesFromMessages, recordEpisodes, recallEpisodeCards, // portable store
  createEpisodeStore,                                              // SQLite reference (needs better-sqlite3)
  richEpisodes,                                                    // advanced chain-card engine (namespaced)
} from 'context-warp-drive';

// Glyph grammar — also at "context-warp-drive/glyphs"
import { parseRegisterGlyph, REGISTER_GLYPHS, classifyAssistantRegister } from 'context-warp-drive';
```

---

## Environment switches

All optional; sensible defaults. `WARP_FOLD_FREEZE` (freeze on/off) · `WARP_FOLD_FREEZE_TTL_MS` · `WARP_FOLD_FREEZE_MAX_TAIL_CHARS` · `WARP_FOLD_RECALL` · `WARP_FOLD_RECALL_MAX_CARDS` · `WARP_FOLD_RECALL_VERBATIM` · `WARP_FOLD_EPISODES_*`. Full table in [`docs/context-folding.md`](./docs/context-folding.md) §8.

---

## Documentation

- [`docs/context-folding.md`](./docs/context-folding.md) — the authoritative engine reference (what folds, Coordinate Closet, freeze epochs, recall, episodic, env switches, source map).
- [`docs/architecture.md`](./docs/architecture.md) — how the layers compose and how to wire them into any FC loop.
- [`docs/glyph-grammar.md`](./docs/glyph-grammar.md) — the register-glyph contract and why it powers episodic narration.

## Tests

```bash
npm test   # runs the 277-test deterministic suite (rolling fold, freeze, recall)
```

## License

MIT © Jonah (Voxxo Swarm)
