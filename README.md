# Context Warp Drive

[![CI](https://github.com/dogtorjonah/context-warp-drive/actions/workflows/ci.yml/badge.svg)](https://github.com/dogtorjonah/context-warp-drive/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE) [![GitHub stars](https://img.shields.io/github/stars/dogtorjonah/context-warp-drive?style=social)](https://github.com/dogtorjonah/context-warp-drive)

**Stop summarizing your agent's memory.** LLM-written compaction burns a model round-trip, rewrites the conversation prefix, and can quietly drop the exact identifiers your agent needs. Fold it deterministically instead.

> **92.6% cache-read hit rate** across 954 tool calls in a 1h49m agent marathon, measured from the provider usage ledger. In the included offline benchmark: **−63% cost vs truncation, −72% vs summarization**, with zero extra LLM calls and exact local BPE counts.

**The Infinite Context Warp Engine.** Keep long function-calling agent sessions under the context window **without LLM summarization calls** and **without ending the session** — preserve reusable prompt prefixes across ordinary turns and hard Rebirth boundaries, then page folded content back in when the recall layer sees it become relevant again.

The core fold path is deterministic, zero-LLM, pure CPU, and zero I/O: identical inputs produce byte-identical output. Provider-agnostic message support includes **Anthropic** content blocks, **OpenAI** `tool_calls`, and **Gemini** `parts`. Optional host loops and the SQLite episode adapter perform I/O outside that core.

Extracted from a production multi-agent system, where it folds context continuously across heterogeneous models and long-running agent workloads.

- The repository contains **900+ deterministic test cases** across rolling fold, recall, freeze, providers, task rail, and integration.
- Production cache rates come from the Claude provider usage ledger. The live benchmark uses provider-reported usage (`ANTHROPIC_API_KEY=… npx tsx examples/benchmark-live.ts`); the offline benchmark uses exact `o200k_base` BPE counts plus published pricing (`npx tsx examples/benchmark.ts`, deterministic, no key). Those are different evidence sources and are labeled separately below.

<details>
<summary><strong>Provenance note</strong> (click to expand)</summary>

This public package is production-derived. It is the portable distribution of an engine that runs live inside a private multi-agent system, so it deliberately uses generic `WARP_*` environment names, package-neutral examples, raw-history recovery wording, and tool-agnostic voice mining. The byte-identical invariant is local to this package — identical inputs produce identical folded views — and is not a claim of bit-for-bit parity with any private integration layer.
</details>

---

## Performance & Economics

### Measured in production — real Claude workloads, provider cache telemetry

The numbers that matter are from the production multi-agent system this engine powers — real Claude workloads running the fold/freeze engine continuously across **hundreds of turns**, measured from the provider's own usage ledger (cache-read tokens ÷ total input tokens):

| Production Claude workload | Measured turns | Cache-read hit | Fresh input | Cache-read input |
| :--- | :---: | :---: | :---: | :---: |
| Opus 4.8 agent | 691 | **89.6%** | 32.9M tok | 292.6M tok |
| Opus agent | 510 | **93.2%** | 32.6M tok | 602.5M tok |

**~90% of all input tokens are served from cache** across these high-turn Claude workloads — that is the byte-identical frozen-fold prefix doing its job, turn after turn, at $0.30/MTok cache reads instead of $3.00/MTok fresh input (Sonnet rates). Re-summarization rewrites the conversation segment when it compacts, while a sliding truncation window changes its earliest retained message; either can reduce reuse beyond any static system/tools prefix. The production rates above measure the behavior of this deployment, not a universal rate for every integration.

**Note on scope:** the table above is live single-deployment production telemetry, not a controlled A/B study — there is no held-out arm running truncation or summarization against the same real workload for a head-to-head comparison. The offline/live benchmarks below fill that gap deterministically on a small session; a larger-scale controlled long-horizon comparison across strategies is future work, gated on compute budget, not on the mechanism being unproven.

### Reproduce it yourself — live, against Claude

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/benchmark-live.ts   # default claude-sonnet-4-6
```

Real Claude calls every turn with Anthropic `cache_control` breakpoints, a **real Claude summarizer** (told to preserve every identifier — a fair fight), and the provider's own `cache_read_input_tokens` / `cache_creation_input_tokens`. A short 16-turn demo *understates* the production cache rate (caching needs a ≥1024-token prefix and CWD's advantage compounds over long sessions) — but it shows the mechanism on real telemetry, with CWD reading from cache while truncation and summarization rebuild their prefix.

### Offline deterministic demo (no API key, byte-identical every run)

`npx tsx examples/benchmark.ts` — a 16-turn outage-debugging session, exact `o200k_base` BPE token counts (a portable proxy; Claude's tokenizer isn't public), `claude-sonnet-4-6` list pricing — the same workhorse tier as the production table above, not a cheap demo tier. This is the CI smoke test; the summarizer is a transparent deterministic stand-in (it drops ids buried past its head cutoff — the failure mode the Coordinate Closet exists to avoid).

| Strategy | Input Cost | Extra LLM Calls | Fact Retention |
| :--- | :---: | :---: | :---: |
| Truncation (rolling window) | $0.0516 | 0 | 44% (7/16) |
| LLM Summarization (stand-in) | $0.0685 | 6 | 44% (7/16) |
| **Context Warp Drive** | **$0.0190** | 0 | **94% (15/16)** |

CWD is cheapest (**−72% vs summarization, −63% vs truncation** at the default Claude Sonnet rates), makes zero extra model calls, and beats truncation decisively on retention in this scenario. (A well-prompted *real* summarizer can match retention at higher cost — CWD's durable edge is cost + zero calls + determinism + byte-stable cache segments.) The engine is provider-agnostic: set `WARP_BENCH_MODEL` (and `WARP_BENCH_PRICE_*` for an unlisted model) to benchmark against any model, including OpenAI or a cheaper Claude tier.

### How it compares to LLM-based memory tools

| | **Context Warp Drive** | **Mem0** | **Letta** | **Zep / Graphiti** |
|---|---|---|---|---|
| **Primary job** | Deterministic in-session compaction + recall | Extracted long-term memory | Persistent agent memory + context management | Temporal knowledge-graph memory |
| **Typical memory path** | Pure CPU fold/recall core | Extraction model + configured stores | Agent/model-managed blocks and retrieval | Entity/edge extraction + graph retrieval |
| **Prompt-cache effect** | Byte-stable sealed prefix between epochs; hard Rebirth preserves the static prefix and seals a new conversation baseline | Integration-dependent | Integration-dependent | Integration-dependent |
| **Runtime footprint** | **Zero dependencies** for the fold core | SDK plus configured model/store backends | Agent runtime/service plus memory backends | Graph/storage plus model and embedding providers |
| **License** | MIT | Apache 2.0 | Apache 2.0 | Apache 2.0 |

These systems solve broader long-term-memory problems and can be complementary. Context Warp Drive's narrower design point is deterministic in-session compaction: zero model calls in the fold/recall core, no model-call latency, and explicit byte-stable cache segments rather than an opaque rewritten summary.

---

## Try it in 5 minutes

```bash
git clone https://github.com/dogtorjonah/context-warp-drive.git
cd context-warp-drive && npm install
npx tsx examples/benchmark.ts    # no API key needed — deterministic, byte-identical every run
```

For the live benchmark with real Claude calls and provider cache telemetry:

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/benchmark-live.ts
```

---

## Why

Every long agent session hits the same wall: the context window fills up. The usual answers are bad:

- **Truncation** drops older history — the agent can lose what it was doing and the exact evidence behind it.
- **LLM summarization ("compaction")** costs a model call, adds latency, is non-deterministic, and rewrites the summarized conversation segment, reducing cache reuse beyond any unchanged static prefix.

Context Warp Drive instead **deterministically folds** old turns into compact structural skeletons (one line per tool call + retained reasoning), **conserves salient exact identifiers** (UUIDs, SHAs, paths, ports) in a budget-scored Coordinate Closet, and **freezes** sealed prefix segments for byte-identical reuse. With the recall layer wired in, touching a path can page its folded evidence back into the prepared view. No model calls in the fold/recall core; raw history stays intact.

---

## Install

Not published on npm yet. Install from source today:

```bash
git clone https://github.com/dogtorjonah/context-warp-drive.git
cd context-warp-drive
npm install        # runs `prepare` -> builds dist/ automatically
# optional — only for the reference SQLite episode store:
npm install better-sqlite3
```

The core (`context-warp-drive/fold`) has **zero runtime dependencies**. `better-sqlite3` is an optional peer needed only by the reference episodic store.

<details>
<summary>Local tarball / future npm install</summary>

`dist/` is gitignored, so build before consuming the package from another project. For a local package install:

```bash
npm run build      # explicit fallback
npm pack
# from your consuming project:
npm install /path/to/context-warp-drive/context-warp-drive-*.tgz
```

After the first npm publish, installation becomes:

```bash
npm install context-warp-drive
```

</details>

---

## If you ask an AI to wire it in

Paste this:

> Add `context-warp-drive` from the source checkout or local tarball, then wrap our function-calling message history with `FoldSession.prepare()` before each model call. Preserve raw history separately; send only the prepared `messages` view to the provider. Use `cacheHot` and `stats` for logging.

Then add the provider cache knob:

| Provider | What to do |
|---|---|
| Claude / Anthropic | Use `prepareAnthropicCachedRequest()` from `context-warp-drive/providers/anthropic` with `messages`, `sealedBoundary`, `system`, and `tools`. It marks the relay-style breakpoints: tools, stable system head, sealed fold/rebirth boundary, and rolling tail. Default TTL is Anthropic's 5-minute cache shape; pass `ttl: '1h'` only when you want the paid 1-hour cache and merge the returned `requestOptions`/`anthropicBeta` into your SDK or fetch call. Log `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens`. |
| OpenAI | Eligible exact prefixes cache automatically. Keep static tools/system/context first and pass the prepared `messages`. For GPT-5.6+ use a stable `prompt_cache_key` for the more reliable matching path and optionally place explicit breakpoints; log cache reads/writes from the response usage fields (`cached_tokens`, and `cache_write_tokens` where supported). |
| Gemini | Implicit caching is automatic on Gemini 2.5+ when prefixes match. For a large static document/corpus, create an explicit Gemini cache separately and pass it as `cachedContent`; keep the folded conversation after that stable prefix. Log `usage_metadata`. |
| Gemini CLI | Use `context-warp-drive/providers/gemini-cli` to fold the CLI-owned JSONL view, preserving the metadata header and rewriting with `$set.messages` + `$set.lastUpdated`. |
| Codex CLI | Use `context-warp-drive/providers/codex-cli` to rebuild a folded Responses item seed for `thread/inject_items` from canonical transcript rows. |
| Claude Code CLI | Use `context-warp-drive/providers/claude-cli` to build a folded Claude Code JSONL chain and atomically rewrite `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` before `claude --resume`. |

Context Warp Drive keeps each sealed prefix byte-identical between epochs and preserves the static prefix across hard Rebirth boundaries. The provider SDK call still owns provider-specific cache settings.

---

## Quickstart

```ts
import { FoldSession } from 'context-warp-drive';

// One per conversation. Folds past the active window + preserves cacheable prefixes between epochs.
const session = new FoldSession();

// Your full provider-shaped history (Anthropic / OpenAI / Gemini message objects).
const history = [
  { role: 'user', content: 'Investigate the failing test in src/parser.ts' },
  // ... grows every turn ...
];

// Every turn, before you call the model:
const { messages, cacheHot, stats } = session.prepare(history, {
  // Optional but recommended: pass real provider/relay input-token telemetry
  // from the previous turn. At 180k by default, FoldSession forces a fresh
  // fold epoch instead of hot-reusing into an oversized prompt.
  measuredInputTokens: previousUsage?.input_tokens,
});

// `messages` is the compacted view to send. When `cacheHot` is true the prefix is
// byte-identical to last turn, so the provider prompt cache is reused.
await callYourModel(messages); // Anthropic / OpenAI / Gemini — the message shapes pass through unchanged
console.log(`sent ${messages.length} msgs · cacheHot=${cacheHot} · savings=${stats.savingsPercent ?? 0}%`);
```

That's the whole headline. For continuous always-lean folding, pass `ALWAYS_ON_FOLD_CONFIG`; to match your provider's real cache TTL, set `freeze: { enabled: true, ttlMs: 3_600_000, maxTailChars: 150_000 }`. The measured-token pressure guard defaults to `DEFAULT_FOLD_PRESSURE_CEILING_TOKENS` (180,000); pass `pressureCeiling: false` to disable it or `pressureCeiling: 120_000` to tune it.

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

### Choose an epoch policy

There are two fully supported ways to run epoch transitions:

| Policy | What happens | Best fit | Cache behavior |
|---|---|---|---|
| **Hard Rebirth epochs** | Replace the provider-visible conversation with one deterministic continuity seed, then seal that seed as the new baseline. | Any long-running session; especially hosts that want the cleanest bounded reset policy, explicit same-instance resets, or process/model handoffs. | The large static system/tools prefix remains reusable across the boundary. The regenerated continuity package is created once, then its sealed seed becomes the byte-stable baseline for following turns. |
| **Tail epochs plus hard Rebirth epochs** | During a hot streak, fold only the new tail and append that band behind the frozen prefix. Escalate to a hard Rebirth at the measured ceiling, when runway or fold yield is exhausted, or when the host explicitly requests it. | Hosts that want to minimize conversation-baseline rewrites between hard resets while an active streak remains healthy. | Tail bands extend the existing frozen conversation baseline; the eventual hard Rebirth retains the static cacheable prefix and immediately establishes the next sealed baseline. |

**Hard Rebirth is not a degraded mode or a continuity compromise.** The bundled [rebirth-continuity paper](./docs/research/rebirth-continuity-paper/) reports first-action non-inferiority against a fair full-context compaction summary, depth-stable behavior through a 684th consecutive rebirth, and 92.8% cache-read on first boundary rows versus 94.5% on ordinary warm rows. The honest mechanism is a dominant static prefix plus a bounded, partly recreated continuity package—not reuse of the old conversation package. Those results come from one deployed system, and the controlled comparison covers first actions rather than full task outcomes.

Tail epochs are therefore a cache-efficiency optimization between hard Rebirths, not a remedy for a weakness in Rebirth. With measured token telemetry, `FoldSession` uses the combined policy automatically: it appends productive tail bands while runway remains, then performs a hard Rebirth at the safety boundary. A host that prefers hard-only behavior can call `prepare(..., { hardEpoch: true })` at each chosen boundary.

**Bounded is what makes it boundless.** A hard epoch collapses the *provider-visible* view to one compact seed message — it does not discard anything from the host-owned raw trace. With recall wired in, the raw transcript remains backing for paging folded/pre-epoch content in when the agent re-touches a path, a claim, or a prior identifier, exactly as after an ordinary rolling fold. With measured pressure telemetry supplied before provider calls, the visible view stays below its safety ceiling while forward momentum — what the agent was doing, what it touched, what it decided — survives because recall and episodic memory read from the untouched raw trace, not from the collapsed view. The engine is deliberately bounded; that boundedness is what lets a session run indefinitely instead of eventually blowing the context window.

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
// 200k survival profile: tighter pressure ceiling, hard-epoch-only eviction.

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

**"Turn" is looser than it sounds — long agentic work folds per step, not per user message.** A conversational turn only ends at real user text (`isUserTurnBoundary`); a long single-prompt agentic rail — one kickoff, hundreds of tool-call steps, no further user text — is structurally ONE turn. `planActiveTurnStepFold` detects that marathon pattern and re-segments the oversized active turn at agentic-step boundaries (each assistant tool-call + its result), so `foldContext` can skeletonize the OLD steps of a still-open turn while the newest N steps stay full-fidelity. This is what keeps a long-horizon single-turn agent session bounded without waiting for a user message that may never come.

### 2. Coordinate Closet — exact-value conservation
Folded turns are skeletonized, but the identifiers selected within the bounded conservation budget are kept verbatim rather than paraphrased. `nominateVerbatim` extracts UUIDs, long hashes, absolute paths, digit-bearing key/values (`port=3002`), and issue refs, and conserves them in a `Coordinate Closet (conserved from folded turns): …` block. Opaque ids carry a deterministic context label (`7fd5835b ⟦changelog_id⟧`). A separate capped lane conserves identifiers from operator-pasted user text too.

### 3. Fold freeze (cache-hot reuse) — `evaluateFoldFreeze`
The folded prefix is **frozen** and reused **byte-identical** between epochs, so new turns just append to the raw tail and the provider can reuse the matching prefix. It recomputes at an epoch: first call, cold TTL gap, raw-tail cap exceeded, a thinning/claim change, or a boundary rewrite. **Maximizing this hot-reuse ratio is the point of deterministic folding**; an LLM-written summary cannot guarantee byte-identical regeneration of the same conversation segment.

### 4. Fold recall (ambient page-in) — `buildFoldRecallContext`
A page table (`buildFoldIndex`) tracks everything the fold paged out. When host-supplied activity proves relevance — you touch a path again, or claim a file — `buildFoldRecallContext` can page the evidence back in as a budgeted recall card, appended after the sealed prefix and re-folded at the next epoch. `FoldSession` itself handles fold/freeze; use `MemoryLoop` or call the recall APIs to wire automatic signal detection and injection. Residency TTLs prevent card thrash.

### 5. Episodic recall (durable cross-session memory) — `context-warp-drive/episodes`
Beyond the in-session fold, sealed work **episodes** (the files touched + the agent's verbatim conclusions) can persist to a local store and be recalled by path when a later session touches a member file. The host owns capture and recall orchestration; `MemoryLoop` provides the bundled wiring. A portable SQLite store is included (`createEpisodeStore`), while the advanced chain-card/narration engine ships namespaced as `richEpisodes`.

### 6. Glyph grammar (register tags) — `context-warp-drive/glyphs`
Integrations can require every agent message to open with one register glyph — 🔍 in-progress · ▶ executing · 🏁 verdict · ⚠️ hazard · ❓ blocked. `parseRegisterGlyph` classifies it; the episodic narration path can use that as a trust signal so **settled** conclusions (🏁/⚠️) are eligible for durable memory while transient work (🔍/▶/❓) self-excludes. The package parses this contract; your host enforces it. See [`docs/glyph-grammar.md`](./docs/glyph-grammar.md).

### 7. Context budget (model-aware mechanical limits) — `context-warp-drive/budget`
The budget resolver turns model/engine/window choices into deterministic fold knobs: active band, message ceiling, pressure ceiling, prefix saturation, tail epoch cap, and compression/eviction profile. Known model tables cover common providers, while explicit `contextWindowTokens` lets any new model opt in without waiting for a package release.

### 8. Task Rail (portable execution state) — `context-warp-drive/task-rail`
Task Rail is the dependency-free long-horizon execution state machine. It tracks steps, sprint/shoot reservations, ACK status, progress, and JSON serialization so your own tool/UI/storage can preserve “what next?” outside the provider prompt.

---

## Provider-agnostic by design

The engine reads three message shapes natively — pass your history through unchanged:

| Provider | Shape |
|---|---|
| Anthropic | `{ role, content: string \| ContentBlock[] }` with `tool_use` / `tool_result` blocks |
| OpenAI (+ DeepSeek, Kimi, GLM, Mistral, Grok, MiniMax) | `{ role, content, tool_calls }` + `{ role: 'tool', tool_call_id }` |
| Gemini | `{ role: 'model', parts: [...] }` with `functionCall` / `functionResponse` |

> **FC APIs and supported CLI transports.** Context Warp Drive folds the
> *conversational message array* you control directly. For CLI/agent runtimes
> that own their own context, use the dedicated provider packs below.

CLI fold packs mirror the Voxxo relay seams for owned-history runtimes:
`context-warp-drive/providers/gemini-cli` rewrites Gemini CLI JSONL `$set.messages`,
`context-warp-drive/providers/codex-cli` emits folded Responses items for
`thread/inject_items`, and `context-warp-drive/providers/claude-cli` builds and
writes a uuid-linked Claude Code JSONL chain for `claude --resume`.

For Claude Code, the runnable setup layer is
`context-warp-drive/host/claude-cli-loop`. It spawns
`claude --print --input-format stream-json --output-format stream-json`, learns
the session id from the stream, tracks Anthropic-reported usage tokens, computes
tail vs hard-epoch folds, atomically rewrites the Claude Code project JSONL, and
respawns with `--resume <session-id>`. Use `mode: 'dry-run'` to write a
`<session>.jsonl.dryrun` sidecar before letting it touch the live file.

```bash
npx tsx examples/claude-cli-loop.ts /path/to/project
WARP_CLAUDE_CLI_FOLD=dry-run npx tsx examples/claude-cli-loop.ts
```

If you want the normal Claude Code terminal UI instead of `--print`, use
`context-warp-drive/host/claude-tmux-loop`. It starts plain interactive
`claude` inside tmux, gives you an attach command, tails
`~/.claude/projects/.../<session>.jsonl`, folds from provider-measured usage,
rewrites the JSONL, and restarts the tmux session with `--resume`.

```bash
npx tsx examples/claude-tmux-loop.ts /path/to/project
WARP_CLAUDE_TMUX_FOLD=dry-run npx tsx examples/claude-tmux-loop.ts
```

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

// Model-aware fold/pressure knobs — also at "context-warp-drive/budget"
import { resolveContextBudget } from 'context-warp-drive';

// Fold provenance receipts — digest-only trust boundary for prepared views
import { buildPrepareReceipt, verifyPrepareReceipt } from 'context-warp-drive';

// Portable execution state — also at "context-warp-drive/task-rail"
import { startTaskRail, sprint, shoot, ackStep, serializeTaskRail } from 'context-warp-drive';

// Gemini CLI JSONL folding adapter
import {
  buildGeminiCliFoldView,
  readLatestGeminiCliMeasuredTokens,
  writeFoldedGeminiCliJsonl,
} from 'context-warp-drive/providers/gemini-cli';

// Codex CLI fold seed for thread/inject_items
import { buildCodexFoldItems } from 'context-warp-drive/providers/codex-cli';

// Claude Code CLI JSONL folding adapter
import {
  buildClaudeCliFold,
  writeFoldedClaudeCliJsonl,
} from 'context-warp-drive/providers/claude-cli';

// Claude Code CLI setup loop: spawn, monitor measured usage, fold, rewrite, resume
import { ClaudeCliFoldLoop } from 'context-warp-drive/host/claude-cli-loop';

// Claude Code interactive tmux loop: normal terminal UI, JSONL tail, fold, resume
import { ClaudeTmuxFoldLoop } from 'context-warp-drive/host/claude-tmux-loop';
```

### Claude Code CLI setup loop

```ts
import { ClaudeCliFoldLoop } from 'context-warp-drive/host/claude-cli-loop';

const loop = new ClaudeCliFoldLoop({
  cwd: process.cwd(),
  sessionId: process.env.CLAUDE_SESSION_ID, // optional; learned from stream-json when omitted
  model: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
  mode: process.env.WARP_CLAUDE_CLI_FOLD === 'dry-run' ? 'dry-run' : 'on',
  authMode: process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'oauth' : 'inherit',
  onEpoch: (epoch) => console.error(epoch.reason),
});

await loop.start();
await loop.sendUserText('Continue the current task.');
```

The loop only folds from provider-measured usage telemetry. If you already keep
your own canonical transcript, pass `transcript: async () => rows` and
`captureTranscript: false`; otherwise the loop captures user text, assistant text,
tool calls, and tool results from Claude Code's stream-json events.

### Claude Code interactive tmux loop

```ts
import { ClaudeTmuxFoldLoop } from 'context-warp-drive/host/claude-tmux-loop';

const loop = new ClaudeTmuxFoldLoop({
  cwd: process.cwd(),
  sessionId: process.env.CLAUDE_SESSION_ID, // optional; otherwise discovered from JSONL
  model: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
  mode: process.env.WARP_CLAUDE_TMUX_FOLD === 'dry-run' ? 'dry-run' : 'on',
  authMode: process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'oauth' : 'inherit',
  onSpawn: (info) => console.error(info.attachCommand),
});

await loop.start();
```

This loop does not pass `--print`; the user attaches to tmux and uses Claude Code
normally. Context Warp observes the on-disk JSONL transcript, so an unwrapped
Claude process can still be observed by your own code, but automatic kill/rewrite
resume requires the wrapper to own the tmux session.

---

## Environment switches

All optional; sensible defaults. `WARP_FOLD_FREEZE` (freeze on/off) · `WARP_FOLD_FREEZE_TTL_MS` · `WARP_FOLD_FREEZE_MAX_TAIL_CHARS` · `WARP_FOLD_RECALL` · `WARP_FOLD_RECALL_MAX_CARDS` · `WARP_FOLD_RECALL_VERBATIM` · `WARP_FOLD_TARGET_BAND_TOKENS` · `WARP_FOLD_TRIGGER_TOKENS` · `WARP_FOLD_EPISODES_*`. Full table in [`docs/context-folding.md`](./docs/context-folding.md) §8.

---

## Documentation

- [`docs/context-folding.md`](./docs/context-folding.md) — the authoritative engine reference (what folds, Coordinate Closet, freeze epochs, recall, episodic, env switches, source map).
- [`docs/architecture.md`](./docs/architecture.md) — how the layers compose and how to wire them into any FC loop.
- [`docs/glyph-grammar.md`](./docs/glyph-grammar.md) — the register-glyph contract and why it powers episodic narration.
- [`docs/fold-provenance.md`](./docs/fold-provenance.md) — prepare receipts: sha256 provenance artifacts that make the deterministic fold/freeze invariant externally attestable and give downstream agents a `safe_to_resume`/`stale` verdict without replaying private raw history.
- [`docs/raw-rebirth-seed.md`](./docs/raw-rebirth-seed.md) — hard-epoch seed construction, default budgets, host overrides, and cache-boundary wiring.
- [`docs/research/rebirth-continuity-paper/`](./docs/research/rebirth-continuity-paper/) — the working paper, hard-number provenance, controlled A/B design, and explicit threats to validity for same-identity Rebirth continuity.

## Tests

```bash
npm test   # runs the 900+ case deterministic suite (fold, freeze, recall, providers, task rail)
```

## JonahT © Jonah Tarashansky
