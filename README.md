# Context Warp Drive

[![npm version](https://img.shields.io/npm/v/context-warp-drive.svg)](https://www.npmjs.com/package/context-warp-drive) [![CI](https://github.com/dogtorjonah/context-warp-drive/actions/workflows/ci.yml/badge.svg)](https://github.com/dogtorjonah/context-warp-drive/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Stop summarizing your agent's memory.** Every compaction call burns a model round-trip, rewrites your prefix so the provider prompt cache goes cold, and quietly drops the exact identifiers your agent needs. Fold it deterministically instead.

**The Infinite Context Warp Engine.** Keep long function-calling agent sessions under the context window **without LLM summarization calls** and **without ending the session** — while keeping provider prompt caches **hot** — and page folded content back in the moment the agent touches it again.

Deterministic. Zero-LLM. Pure CPU, zero I/O, byte-identical output for identical inputs. Provider-agnostic: **Anthropic** content blocks, **OpenAI** `tool_calls`, and **Gemini** `parts`.

Extracted from a production multi-agent system (the Voxxo Swarm), where it folds context continuously across every model and thousands of session-rebirths.

- The core engine passes **277 deterministic tests** across rolling fold, recall, freeze, and integration.
- Every performance number below is **measured and reproducible** — run `npx tsx examples/benchmark.ts` yourself.

---

## Performance & Economics (The "God Chart")

A 16-turn agent session, priced with public **Claude Sonnet 4.6** list pricing. Each strategy is held to a **comparable final context size** (last column) so the comparison is fair — Warp Drive's wins are not "it just keeps more context." Every number is measured from the real prepared message views; reproduce it with `npx tsx examples/benchmark.ts`.

| Strategy | Input Cost | Cache Hit | Extra LLM Calls | Fact Retention | Context Size |
| :--- | :---: | :---: | :---: | :---: | :---: |
| Truncation (Rolling Window) | $0.0496 | 28% | 0 | 44% (7/16) | 4.9K |
| LLM Summarization | $0.0686 | 43% | 6 | 44% (7/16) | 4.3K |
| **Context Warp Drive** (Deterministic) | **$0.0203** | **60%** | **0** | **94% (15/16)** | 5.3K |

*   **Cost:** Warp Drive is the cheapest — **70% below LLM summarization** (zero model calls) and below truncation too, because the byte-identical frozen prefix keeps **60% of the context served from cache** ($0.30/MTok reads instead of $3.75/MTok writes).
*   **Zero model calls:** summarization made **6 extra model round-trips** here — each adds real cost, latency, and non-determinism. Warp Drive and truncation make none.
*   **Fact retention:** at the same context budget Warp Drive recalls **15 of 16** buried identifiers vs **7 of 16** for both baselines — and with no model call. The Coordinate Closet is budget-scored: it conserves the *most salient* identifiers from folded turns, not literally everything (the benchmark prints exactly which one it dropped).

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
