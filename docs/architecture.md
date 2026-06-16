# Architecture

Context Warp Drive is a pipeline of pure, deterministic stages. Raw conversation history is never mutated — each stage produces a *view*.

```
raw history ──► rolling fold (page-out) ──► fold freeze (cache gate) ──► send to provider
                      │                              ▲
                      ▼                              │
                 page table  ◄── tool boundary ──► fold recall (page-in)
                      │
                      ▼
                 episodic capture (epoch seams) ──► episodic store ──► episodic recall
```

## The two integration seams

The production system this engine was extracted from wires the layers through two seams in its function-calling session base class. Context Warp Drive distills both:

### 1. `applyCompaction` — once per provider call (before send)
- `evaluateFoldFreeze(state, history, ctx, now, cfg)` decides **reuse** (frozen prefix is byte-identical, cache hot — append the raw tail) or **recompute** (an epoch boundary).
- On recompute: `foldContext(history, turnsToFold, foldCfg)` produces the folded view; `commitFoldFreeze(state, history, view, ctx, now)` freezes it.
- `FoldSession.prepare(history, context)` is exactly this seam.

### 2. `buildToolBoundaryContext` — once per tool result (after a tool runs)
- `extractRecallSignals(toolInput)` derives touched paths; `planRecall` + `buildFoldRecallContext` render budgeted recall cards for folded content that just became relevant.
- Episodic recall fires here too: touching a stored episode's member path summons its chapter.
- Both inject **append-only** onto the freeze tail, so the frozen prefix — and the provider cache — stay intact.

These are left as explicit building blocks (not hidden inside `FoldSession`) because the recall trigger (which tool args count as a "touched path", what a "claim" means) is harness-specific. Wire them at your tool-execution boundary; see `examples/`.

## Wiring into any FC loop

```
per turn:
  outcome = foldSession.prepare(history)      // seam 1
  assistant = await model(outcome.messages)
  history.push(assistant)
  for each tool_call:
    result = runTool(call)
    history.push(toolMessage(result))
    // seam 2 (optional): recall cards from extractRecallSignals(call.input)
```

The message objects pass through unchanged — Context Warp Drive reads Anthropic content blocks, OpenAI `tool_calls`, and Gemini `parts` natively.

Provider cache setup stays in your SDK call:

- Claude / Anthropic: add top-level `cache_control: { type: 'ephemeral' }`; use
  `ttl: '1h'` only for Anthropic's paid 1-hour cache.
- OpenAI: no cache marker is required; optionally pass a stable
  `prompt_cache_key` for requests that share the same long prefix.
- Gemini: implicit caching is automatic on Gemini 2.5+; for explicit caching,
  create a cached content object for the large static prefix and pass
  `cachedContent` beside the prepared conversation.

Context Warp Drive's job is to keep the prefix byte-identical. The provider
knob is deliberately visible at the call site so an integrator can verify cache
hits in the provider usage fields.

## Episodic storage adapter

The portable episode store (`episodes/episodeStore.ts`) is storage-agnostic: it operates on an `EpisodeDatabase` — a minimal structural handle (`prepare`, `transaction`). The reference `createEpisodeStore()` implements it with `better-sqlite3` (optional peer) over a three-table spine (`sessions`, `episodes`, `episode_members`). Implement `EpisodeDatabase` against any SQLite binding to bring your own store. The advanced episodic engine additionally layers lineage scoping, silo quarantine, chapter coalescing, and chainScore ranking — documented in `docs/context-folding.md` §5 and shipped here as the namespaced `richEpisodes` engine (bring your own store).

## Determinism invariant

Every stage is **zero-LLM, zero-I/O, byte-identical for identical inputs** (the episodic SQLite store is the only stateful piece). This is not incidental — byte-identical fold output is precisely what lets the provider prompt cache be reused across turns. Never introduce a model call, a clock read, or nondeterminism into the fold/freeze/recall path; it would silently destroy the cache-reuse economics that are the engine's reason to exist.

## Provenance

Context Warp Drive was extracted from the production multi-agent system it was built
for, where the fold/freeze/recall architecture runs live on long-horizon agent
sessions. This repository is the portable public package derived from that engine,
not a byte-for-byte copy of Voxxo Swarm's private integration layer.

The byte-identical invariant in this package is local: identical package inputs
produce identical folded views, and a hot frozen prefix is reused byte-for-byte
between epochs so provider prompt caches can hit. It is not a claim that every
public source file renders the same output as the production monorepo for
Voxxo-specific workloads.

The standalone dialect deliberately neutralizes private integration seams:
`VOXXO_*` environment names become `WARP_*`, package examples avoid Voxxo paths,
recovery text says "raw history" instead of "self-tap", and voice mining is keyed
on generic glyph-grammar input shapes rather than named Voxxo tools. Known
production-only non-parity areas include Atlas lookup metadata-preserving fold
markers, Atlas/chatroom/tap_star/task_rail skeleton labels, rail episode fields,
and walk-spine/rail recall cards. Treat those as integration features to port
explicitly, not as hidden guarantees of the public package.
