# Context Warp Drive

[![npm version](https://img.shields.io/npm/v/context-warp-drive.svg)](https://www.npmjs.com/package/context-warp-drive) [![CI](https://github.com/dogtorjonah/context-warp-drive/actions/workflows/ci.yml/badge.svg)](https://github.com/dogtorjonah/context-warp-drive/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Stop summarizing your agent's memory.** Every compaction call burns a model round-trip, rewrites your prefix so the provider prompt cache goes cold, and quietly drops the exact identifiers your agent needs. Fold it deterministically instead.

**The Infinite Context Warp Engine.** Keep long function-calling agent sessions under the context window **without LLM summarization calls** and **without ending the session** — while keeping provider prompt caches **hot** — and page folded content back in the moment the agent touches it again.

Deterministic. Zero-LLM. Pure CPU, zero I/O, byte-identical output for identical inputs. Provider-agnostic: **Anthropic** content blocks, **OpenAI** `tool_calls`, and **Gemini** `parts`.

Extracted from a production multi-agent system, where it folds context continuously across every model and long-running agent workloads.

- The core engine passes **380+ deterministic tests** across rolling fold, recall, freeze, and integration.
- Every number below is **measured, not estimated** — production cache rates from the Claude provider usage ledger, reproducible live against Claude (`ANTHROPIC_API_KEY=… npx tsx examples/benchmark-live.ts`, real model + real summarizer) and offline with exact `o200k_base` BPE token counts (`npx tsx examples/benchmark.ts`, deterministic, no key).

**Provenance note:** this public package is production-derived. It is the portable distribution of an engine that runs live inside a private multi-agent system, so it deliberately uses generic `WARP_*` environment names, package-neutral examples, raw-history recovery wording, and tool-agnostic voice mining. The byte-identical invariant is local to this package — identical inputs produce identical folded views — and is not a claim of bit-for-bit parity with any private integration layer.

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

<details>
<summary>Building from source (git clone)</summary>

`dist/` is gitignored — it ships only in the npm tarball. After cloning:

```bash
git clone https://github.com/dogtorjonah/context-warp-drive.git
cd context-warp-drive
npm install        # runs `prepare` → builds dist/ automatically
# or if prepare was skipped (e.g. --ignore-scripts):
npm run build      # explicit fallback
```

</details>

---

## If you ask an AI to wire it in

Paste this:

> Install `context-warp-drive` and wrap our function-calling message history with `FoldSession.prepare()` before each model call. Preserve raw history separately; send only the prepared `messages` view to the provider. Use `cacheHot` and `stats` for logging.

Then add the provider cache knob:

| Provider | What to do |
|---|---|
| Claude / Anthropic | Use `prepareAnthropicCachedRequest()` from `context-warp-drive/providers/anthropic` with `messages`, `sealedBoundary`, `system`, and `tools`. It marks the relay-style breakpoints: tools, stable system head, sealed fold/rebirth boundary, and rolling tail. Default TTL is Anthropic's 5-minute cache shape; pass `ttl: '1h'` only when you want the paid 1-hour cache and merge the returned `requestOptions`/`anthropicBeta` into your SDK or fetch call. Log `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens`. |
| OpenAI | No cache marker is required. Keep static tools/system/context first, pass the prepared `messages`, optionally reuse a stable `prompt_cache_key`, and log `usage.prompt_tokens_details.cached_tokens`. |
| Gemini | Implicit caching is automatic on Gemini 2.5+ when prefixes match. For a large static document/corpus, create an explicit Gemini cache separately and pass it as `cachedContent`; keep the folded conversation after that stable prefix. Log `usage_metadata`. |
| Gemini CLI | Use `context-warp-drive/providers/gemini-cli` to fold the CLI-owned JSONL view, preserving the metadata header and rewriting with `$set.messages` + `$set.lastUpdated`. |

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
const { messages, cacheHot, stats } = session.prepare(history, {
  // Optional but recommended: pass real provider/relay input-token telemetry
  // from the previous turn. At 240k by default, FoldSession forces a fresh
  // fold epoch instead of hot-reusing into an oversized prompt.
  measuredInputTokens: previousUsage?.input_tokens,
});

// `messages` is the compacted view to send. When `cacheHot` is true the prefix is
// byte-identical to last turn, so the provider prompt cache is reused.
await callYourModel(messages); // Anthropic / OpenAI / Gemini — the message shapes pass through unchanged
console.log(`sent ${messages.length} msgs · cacheHot=${cacheHot} · savings=${stats.savingsPercent ?? 0}%`);
```

That's the whole headline. For continuous always-lean folding, pass `ALWAYS_ON_FOLD_CONFIG`; to match your provider's real cache TTL, set `freeze: { enabled: true, ttlMs: 3_600_000, maxTailChars: 150_000 }`. The measured-token pressure guard defaults to `DEFAULT_FOLD_PRESSURE_CEILING_TOKENS` (240,000); pass `pressureCeiling: false` to disable it or `pressureCeiling: 120_000` to tune it.

See [`examples/anthropic-loop.ts`](./examples/anthropic-loop.ts) and [`examples/openai-loop.ts`](./examples/openai-loop.ts) for full tool loops.

---

### Hard-epoch rebirth seed parity

`FoldSession.prepare()` includes the portable hard-epoch path used by the Voxxo relay: it replaces the provider-visible view with one deterministic rebirth seed message, merges the triggering live user turn exactly once, and reseals that compact seed as the next frozen prefix. It fires automatically when real measured input tokens reach `pressureCeiling`; a harness can also force the same path directly:

```ts
const outcome = session.prepare(history, {
  hardEpoch: true,
  hardEpochSeed: renderMyHostRebirthPackage(), // optional; omitted = raw trace seed
  measuredInputTokens: previousUsage?.input_tokens,
});
```

For Anthropic, feed `outcome.sealedBoundary` to the provider helper every turn:

```ts
import { prepareAnthropicCachedRequest } from 'context-warp-drive/providers/anthropic';

const cached = prepareAnthropicCachedRequest({
  messages: outcome.messages as AnthropicMessage[],
  sealedBoundary: outcome.sealedBoundary,
  system: SYSTEM_PROMPT,
  tools: TOOLS,
});

await client.messages.create(
  { model, max_tokens: 8192, ...cached.request },
  cached.requestOptions,
);
```

Parity checklist for a custom harness:

- Keep raw history append-only and pass the full raw trace to `prepare()`.
- Use measured provider token telemetry for `measuredInputTokens`; do not estimate pressure from characters.
- For intentional same-instance rebirth/reset, pass `hardEpoch: true` plus your rendered host seed, or let the package compute the raw seed from `history`.
- Persist host-only context such as task rails, file claims, workspace state, chat, and episode cards yourself, then pass those sections into `renderRawRebirthSeed()` when you need relay-like wake text.
- Keep clone/model-specific identity deltas out of the stable cached prefix. The Anthropic helper splits the system prompt before `## Your Identity` by default; for cheaper clone fanout, put shared seed text before that marker and append per-model deltas after the cached baseline.

---

## Model-aware budgets — `context-warp-drive/budget`

Use the budget resolver when you want Warp Drive tuned to the real model window instead of a one-size-fits-all fold line. It knows common provider/model families (Claude, OpenAI/Codex API, Codex CLI, Gemini, GLM, Grok, Mistral, MiniMax, DeepSeek, Kimi, Qwen) and lets new/unknown models opt in with an explicit measured/configured window.

```ts
import { resolveContextBudget } from 'context-warp-drive/budget';

const sonnet = resolveContextBudget({ engine: 'claude', model: 'claude-sonnet-4' });
// 200k survival profile: tighter pressure ceiling, full-recompute-only eviction.

const codexCli = resolveContextBudget({ engine: 'codex', model: 'gpt-5.5' });
// Codex CLI/OAuth path uses its effective 258k input cap, not the Codex API 1M window.

const arbitraryModel = resolveContextBudget({
  engine: 'my-provider',
  model: 'new-million-context-model',
  contextWindowTokens: 1_000_000,
  targetBandTokens: 150_000,
});
```

Budget outputs are mechanical ceilings and knobs: `contextWindowTokens`, `messageCeilingTokens`, `pressureCeilingTokens`, `prefixSaturationTokens`, `bandTokens`, `tailEpochCapTokens`, compression profile, and eviction policy. Token pressure uses supplied/measured token telemetry or explicit model windows — it does **not** infer live token pressure from character counts.

---

## Portable Task Rail — `context-warp-drive/task-rail`

Long-horizon agents need more than memory compression: they need an execution spine that survives folding, rebirth, process restarts, or a custom UI. The Task Rail export is a pure state machine for plan steps, sprint/shoot execution, ACKs, progress, and JSON serialization.

It is deliberately **not** a tool server. No MCP wrapper, no relay persistence, no squad permissions, no chat/Atlas coupling. You own the wrapper: CLI, MCP, browser UI, local JSON, SQLite, or your own agent runtime.

```ts
import {
  startTaskRail,
  sprint,
  ackStep,
  shoot,
  serializeTaskRail,
  restoreTaskRail,
} from 'context-warp-drive/task-rail';

const rail = startTaskRail({
  title: 'Ship the feature',
  objective: 'Keep execution state outside the prompt.',
  locked: true,
  steps: [
    { instruction: 'Inspect the failing path.' },
    { instruction: 'Patch the smallest correct surface.' },
    { instruction: 'Validate and write the handoff.' },
  ],
});

const batch = sprint(rail, { sprintCount: 2 });
ackStep(rail, batch.steps![0].id, 'done', { evidence: 'source read' });
const next = shoot(rail);

const saved = JSON.stringify(serializeTaskRail(rail));
const restored = restoreTaskRail(JSON.parse(saved));
```

Pair it with FoldSession like this: raw transcript stays in your storage, folded prompt view stays lean, and task rail tracks what the agent is supposed to do next.

> **Draft operations** (`TASK_RAIL_DRAFT_OPERATIONS`, `TaskRailDraft`, conflict/merge types) are exported for parity with the full-featured relay wrapper. The draft *types* are here; the merge *engine* lives in the relay-side wrapper. If you need collaborative draft merging, build it on the exported types — the pure state machine only handles locked-rail execution.

See [`examples/task-rail.ts`](./examples/task-rail.ts) for a full runnable walkthrough (start → sprint → ack → shoot → serialize → restore, zero dependencies).

## Raw rebirth seed — `context-warp-drive/raw-rebirth-seed`

When a long-running agent chooses a hard epoch, it needs a deterministic wake seed that is computed from the trace, not summarized by a model. The raw rebirth seed renderer exposes that package shape directly: Last User + AI Messages, Current Thread, Raw Trace Coordinate Closet, Active Edit Delta, Task Rail, Activity Log, workspace context, and the orientation footer, with the same default section budgets and allocation priority used by the relay-style hard epoch.

```ts
import { buildRawRebirthSeedFromMessages } from 'context-warp-drive/raw-rebirth-seed';

const seed = buildRawRebirthSeedFromMessages(history, {
  predecessorName: 'agent-before-reset',
  includeTrailingUserTurn: false,
  workspaceContext: {
    currentCwd: process.cwd(),
    currentWorkspace: 'my-agent-runtime',
  },
});
```

`FoldSession` uses this renderer automatically when a pressure hard epoch fires and you do not pass `hardEpochSeed`. If your host has richer trace sections, call `renderRawRebirthSeed()` and pass those strings explicitly. See [`docs/raw-rebirth-seed.md`](./docs/raw-rebirth-seed.md) for exact parity boundaries and copy-paste examples.

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
Every agent message opens with one register glyph — 🔍 in-progress · ▶ executing · 🏁 verdict · ⚠️ hazard · ❓ blocked. `parseRegisterGlyph` classifies it; episodic recall uses it as a trust signal so only **settled** conclusions (🏁/⚠️) get harvested into durable memory while transient work (🔍/▶/❓) self-excludes. See [`docs/glyph-grammar.md`](./docs/glyph-grammar.md).

### 7. Overwatch (trace-driven governor) — `context-warp-drive/overwatch`
Overwatch is the pure, standalone context-geometry governor. Feed it a recent trace of register-glyph messages and tool ticks plus measured pressure/cache telemetry, and it returns auditable recommendations for retained band size, recall aperture, episodic capture, and cache-safe fold timing. It is deliberately adapter-free: your runtime maps its own message/tool history into `TraceToken[]`.

### 8. Context budget (model-aware mechanical limits) — `context-warp-drive/budget`
The budget resolver turns model/engine/window choices into deterministic fold knobs: active band, message ceiling, pressure ceiling, prefix saturation, tail epoch cap, and compression/eviction profile. Known model tables cover common providers, while explicit `contextWindowTokens` lets any new model opt in without waiting for a package release.

### 9. Task Rail (portable execution state) — `context-warp-drive/task-rail`
Task Rail is the dependency-free long-horizon execution state machine. It tracks steps, sprint/shoot reservations, ACK status, progress, and JSON serialization so your own tool/UI/storage can preserve “what next?” outside the provider prompt.

---

## Provider-agnostic by design

The engine reads three message shapes natively — pass your history through unchanged:

| Provider | Shape |
|---|---|
| Anthropic | `{ role, content: string \| ContentBlock[] }` with `tool_use` / `tool_result` blocks |
| OpenAI (+ DeepSeek, Kimi, GLM, Mistral, Grok, MiniMax) | `{ role, content, tool_calls }` + `{ role: 'tool', tool_call_id }` |
| Gemini | `{ role: 'model', parts: [...] }` with `functionCall` / `functionResponse` |

> **FC (function-calling) APIs only.** Context Warp Drive folds the *conversational message array* you control. CLI/agent runtimes that own their own context (and don't expose the message array) can't be folded this way.

Gemini CLI is the special case: `context-warp-drive/providers/gemini-cli` mirrors
the Voxxo relay's JSONL fold seam for CLI-owned history, including the 250k
measured-token trigger, 100k band fold config, recent token high-water scan, and
dry-run/atomic rewrite helpers.

---

## API surface

```ts
// Core fold engine (zero deps) — also at "context-warp-drive/fold"
import {
  FoldSession,           // the orchestrator (fold + freeze)
  DEFAULT_FOLD_PRESSURE_CEILING_TOKENS,
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

// Overwatch governor — also at "context-warp-drive/overwatch"
import { governByTrace, classifyToolClass, glyphFromMessage } from 'context-warp-drive';

// Model-aware fold/pressure knobs — also at "context-warp-drive/budget"
import { resolveContextBudget } from 'context-warp-drive';

// Portable execution state — also at "context-warp-drive/task-rail"
import { startTaskRail, sprint, shoot, ackStep, serializeTaskRail } from 'context-warp-drive';

// Gemini CLI JSONL folding adapter
import {
  buildGeminiCliFoldView,
  readLatestGeminiCliMeasuredTokens,
  writeFoldedGeminiCliJsonl,
} from 'context-warp-drive/providers/gemini-cli';
```

---

## Environment switches

All optional; sensible defaults. `WARP_FOLD_FREEZE` (freeze on/off) · `WARP_FOLD_FREEZE_TTL_MS` · `WARP_FOLD_FREEZE_MAX_TAIL_CHARS` · `WARP_FOLD_RECALL` · `WARP_FOLD_RECALL_MAX_CARDS` · `WARP_FOLD_RECALL_VERBATIM` · `WARP_FOLD_TARGET_BAND_TOKENS` · `WARP_FOLD_TRIGGER_TOKENS` · `WARP_FOLD_EPISODES_*`. Full table in [`docs/context-folding.md`](./docs/context-folding.md) §8.

---

## Documentation

- [`docs/context-folding.md`](./docs/context-folding.md) — the authoritative engine reference (what folds, Coordinate Closet, freeze epochs, recall, episodic, env switches, source map).
- [`docs/architecture.md`](./docs/architecture.md) — how the layers compose and how to wire them into any FC loop.
- [`docs/glyph-grammar.md`](./docs/glyph-grammar.md) — the register-glyph contract and why it powers episodic narration.

## Tests

```bash
npm test   # runs the 380+ test deterministic suite (rolling fold, freeze, recall, task rail)
```

## License

MIT © Jonah
