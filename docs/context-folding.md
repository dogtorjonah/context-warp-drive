# Context Folding — Reference

How Context Warp Drive keeps long agent sessions inside the context window without LLM
calls: a deterministic rolling fold (page-out), a cache-aware freeze layer, and
an ambient recall layer (page-in). Pure CPU, zero I/O, byte-identical output
for identical inputs. Sources: `src/rollingFold.ts`, `src/foldFreeze.ts`,
`src/foldRecall.ts`; wire them into your function-calling loop at the two seams in
`docs/architecture.md` (`FoldSession` packages seam 1 for you).

## 1. What folds

- **Inter-turn fold** (`ALWAYS_ON_FOLD_CONFIG`, `activeWindowTurns: 1`): from
  turn 2 onward every prior turn skeletonizes on every call — one line per tool
  call (`$ cmd → ok [receipts]`, `📖 src/auth.ts`, …) plus retained text.
  Only the current turn is the guaranteed-verbatim floor.
- **Intra-turn fold** (`ALWAYS_ON_INTRA_FOLD_CONFIG`, `tailBuffer: 5`): within
  one long turn, older tool results page out; the newest 5 stay raw.
- **Assistant-essence budgets** (50K full / 100K essence, newest-first) carry
  recent reasoning text past the fold floor.
- The fold block is a synthetic user+assistant pair. Its FIRST line is the
  anchor `[Conversation Context — N turns folded, XK → YK chars]`; it ends with
  `[End Folded Context]`. A self-documenting preamble (`FOLD_BLOCK_PREAMBLE`)
  renders immediately after the header.

## 2. Coordinate Closet

Verbatim ids/paths/values from folded turns are conserved, not paraphrased:

- `nominateVerbatim` patterns (priority order): UUID, hex ≥12, short-hex 8–11
  (needs ≥1 letter AND ≥1 digit — admits `1f6be5b4`, rejects `20260610` and
  `deadbeef`), absolute path, digit-bearing KV (`port=3002`), issue ref `#1234`.
- `isConservedIn` filters nominations against the rendered block body AND the
  growing keep itself (boundary-aware match, KV value-part conservation,
  numeric normalization) so each value is carried exactly once.
- Budget `FoldConfig.verbatimKeepChars` (default 4000), first-fit admission in
  nomination order. Rendered inside the fold block as a salient
  `⌖⌖⌖ COORDINATE CLOSET ⌖⌖⌖` banner line followed by the conserved items (`a · b · c`).
- **Annotated keep (Tier-1 page-out):** opaque ids carry a deterministic context
  label so a folded hash survives as `7fd5835b ⟦changelog_id⟧` instead of going
  dark. `extractVerbatimContextLabel(sourceText, value)` is a pure surrounding-
  context heuristic (nearest JSON/KV key or prose subject, cap 24 chars) — NOT an
  LLM call (the engine is zero-LLM; byte-identical output is the cache invariant).
  Self-describing values (abs paths, KV pairs, `#refs`) and letterless/pure-hex
  labels get no annotation. De-dup stays on the bare value; the label rides the
  same `verbatimKeepChars`/P1b budget and is dropped before the value under
  pressure (labelled → bare → skip), so the value always wins.
- Bash/default-arm skeletons also carry up to 2 inline receipts (`beltVerbatim`).

## 3. Fold freeze (provider-cache awareness)

`foldFreeze.ts` decides per API call whether the frozen folded view is reused
**byte-identical** (provider prompt cache stays hot; new turns append to the
raw tail) or recomputed at an **epoch**. Epoch causes:

- first call — no frozen state yet
- cold gap — time since last call exceeded the TTL; precedence
  `WARP_FOLD_FREEZE_TTL_MS` > caller/session default > builtin 5m
  (premise: cache already dead, so the refold is free)
- raw-tail cap — appended raw tail exceeded 150K chars
- thinning-mode change
- newly-relevant claim — a file claim whose normalized path ∈ `frozenToolPaths`
  (paths the frozen view actually covers); claims on never-touched paths reuse
- boundary mismatch — whole-message FNV-1a fingerprint of the boundary message
  (role + content + reasoning_content + tool_calls) diverged; catches
  same-length in-place rewrites

### Provider cache knobs

Context Warp Drive owns the deterministic prefix: when `cacheHot` is true, the
old folded prefix is byte-identical and new raw turns append after it. Provider
cache controls still live in your provider SDK call:

- **Claude / Anthropic:** use `prepareAnthropicCachedRequest()` from
  `context-warp-drive/providers/anthropic`. Pass `messages`,
  `sealedBoundary`, stable `system`, and stable `tools`; the adapter marks up
  to four breakpoints in Anthropic's prefix order (`tools` → `system` →
  `messages`): last tool definition, stable system head, sealed fold/rebirth
  boundary, and rolling tail. Anthropic's default ephemeral cache is 5 minutes;
  pass `ttl: '1h'` only when you want the paid 1-hour cache and merge the
  returned beta header into your SDK/fetch call. Track
  `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens`.
- **OpenAI:** prompt caching is automatic for eligible prompts. Keep shared
  tools/system/static context at the beginning, put variable user/tool content
  at the end, optionally reuse a stable `prompt_cache_key`, and track
  `usage.prompt_tokens_details.cached_tokens`.
- **Gemini:** implicit caching is automatic on Gemini 2.5+ when prefixes match.
  For a large static corpus where you need guaranteed savings, create an
  explicit Gemini cache and pass it as `cachedContent`; keep the folded
  conversation after that stable cached prefix. Track `usage_metadata`.

Simple rule: Context Warp Drive gives the provider the same prefix bytes. Your
request object tells the provider how to cache those bytes.

## 4. Fold recall (ambient page-in)

`foldRecall.ts` pages folded content back in when activity proves relevance:

- Page table (`buildFoldIndex`) rebuilt ONLY at freeze epoch commits: inter-turn
  entries from replayed turn detection + the fold block's "N turns folded"
  count; intra-turn entries from anchored fold-marker scans keyed by tool id.
- Triggers at tool boundaries (`extractRecallSignals`): touched paths (tool
  args, `paths[]`, bash command tokens) = tier 0; claimed paths = tier 1.
- **Exact verbatim-token tier (Tier-2 page-in, default OFF):** turn entries index
  the verbatim ids they paged out (`InterTurnIndexEntry.verbatimTokens`, sorted
  `nominateVerbatim` over the turn text). When a kept id re-surfaces in the active
  window, its source turn pages back in — the page-in counterpart to the annotated
  page-out. A SINGLE exact match suffices (vs the ≥2 fuzzy distinctive-term gate);
  it ranks within tier 2, evaluated before term-overlap but AFTER path-touch(0)
  and claim(1). **Default ON** (operator-blessed); set `WARP_FOLD_RECALL_VERBATIM=0`
  for byte-identical legacy behavior (no active-window derivation, no token signal).
  Applies to FC engines AND Codex CLI (codexSession uses the same
  resolveFoldRecallConfig + deriveBoundaryRecallSignals + buildFoldRecallContext
  seam). Bounded to each turn's own nomination — no dense search/embeddings.
- Cards start `[Recalled from fold —`; hints start `[Fold recall hint —`. Both
  inject append-only into tool results, ride the freeze tail (cache stays HOT),
  and re-fold away at the next epoch — fully cyclic.
- Residency TTL 8 passes, tracked at entry-id AND content-path level; resident
  cards suppress re-injection, resident hints escalate on a fresh hard trigger.
- Pressure ladder: healthy (full budget) / warning (chars÷2) / critical (1
  card, chars÷4) / auto_compact (hints only).
- `stripRecallBlocks` strips embedded cards from any body sourced from raw
  history — the anti-nesting guard.

## 5. Episodic recall (durable blast-radius memory)

Beyond the in-session fold, `foldEpisodes.ts` + `foldEpisodeCapture.ts` keep a
durable store (the `EpisodeDatabase` handle; a `better-sqlite3` reference
implementation ships in `src/episodes/`) of sealed work episodes: zone members
(files touched), a structural branch trace, the operator intent (the verbatim
ask that drove the burst, mined from the raw capture window — not the recency-capped
transient user-message vault — and denormalized at write; rendered as the card's
`↳ ask` anchor), and verbatim voice annotations —
tier-A: glyph-grammar-tagged tool inputs (changelogs, stars, typed lines);
tier-B: narration (below). Capture runs at freeze
epochs behind a durable-coverage cursor; recall fires at tool boundaries —
touching or mentioning ANY member path summons that zone's chapter chain
(walk promotion on re-engagement, bookends, since-then Δ-lines), staggered one
boundary so the frozen prefix stays byte-identical.

**Canonical path identity:** member paths are stored as canonical ABSOLUTE
paths. `foldPathCanon.ts` resolves raw tool paths against the session cwd, a
bridged `workspace` argument, or — backfill only — unique disk existence across
known roots (seeded once at startup; empty cache fails open to legacy forms).
Recall matches canonical + alias forms (raw + workspace-relative) so legacy
rows stay reachable, and chain lookups carry NO workspace filter: episodes are
keyed by the files they touched, never by the capturing agent's home workspace
— repo-respecting AND cross-boundary ("not repo constrained, but can't be repo
confined"). Δ-lines route to each member's own repo. The store is rebuildable
from the full transcript archive with per-instance cwd provenance.

**Narration (tier-B voice):** burst-final assistant prose is mined into
`narration` annotations behind a double deterministic gate — POSITION
(only gap-resident messages after a sealed burst's last touch; mid-burst
thinking-out-loud is never eligible because mid-work hypotheses are
confidently wrong) AND SHAPE (`extractNarrationLines`: verdict-verb
whitelist, length bounds, question/code-fence/quoted-card-glyph rejection,
synthetic-line guard via `isSyntheticContextText`). Forward scan of ≤3
assistant texts per gap (the closing user-facing reply is the densest curated
prose agents produce). Narration is provenance-marked (`🗣` in cards/traces).
**Trust-tiered by declared register (all-in commentary):** the annotation kind
of each harvested line is set by the message's opening glyph
(`narrationKindForGlyph`) — 🏁 → `narration:verdict`, ⚠️ → `narration:hazard`,
untagged → plain `narration` — and the tier drives ranking AND harvest budget,
symmetric with the deliberate star tiers:
- `narration:hazard` / `narration:verdict` are PROMOTED into the deliberate
  tier (priority just under star:gotcha / star:result, ABOVE changelog and
  chat), so a declared conclusion can win an inlay slot over a routine
  changelog. A declared hazard additionally feeds the chainScore GOTCHA_BOOST
  (`annotationsImplyGotcha`) exactly like a pinned gotcha star, and
  `deriveEpisodeSummary` prefers a declared line for the episode headline.
  Tagged messages earn the higher cap (`NARRATION_MAX_LINES_TAGGED` = 3).
- untagged `narration` stays the priority-LAST backstop (`NARRATION_MAX_LINES`
  = 2): fills voice vacuum, never displaces curated voice, no chainScore effect
  — byte-identical to the pre-promotion engine at 0% glyph compliance.

This trust-tier promotion is what lets the high-frequency commentary channel be
a PRIMARY voice source rather than a fallback to the sparse commit/star
channels. Narration still slots into the summary fallback chain after task
titles, before the structural member list — voicing otherwise-mute episodes. Zero LLM: extraction is
byte-identical for identical inputs, so rebuild idempotence holds; historical
episodes are untouched until the operator-gated rebuild swap regenerates them
(at which point narration applies retroactively for free).

**Message glyph grammar (register tags):** the SOP mandates every agent
message open with exactly one register glyph — 🔍 in progress · ▶ executing ·
🏁 verified verdict · ⚠️ hazard/gotcha · ❓ blocked (`classifyMessageGlyph`,
VS16-tolerant first-glyph parse; deploy the prompt/runtime convention wherever
agents produce commentary). Narration consults it as a COARSE gate ahead of the shape
filter: 🔍/▶/❓ messages self-exclude — declared transient work can no longer
masquerade as a verdict, the false-positive class shape filters cannot catch
— while 🏁/⚠️ and untagged messages stay eligible with the shape gate still
deciding (glyphs tighten the AND-gate, never bypass it). Excluded messages
still consume the ≤3-message scan window. Untagged = legacy shape-only
behavior: harvest is byte-identical at 0% compliance and strictly less noisy
above it. Line-level mirrors: 🔍/▶/❓-opened lines reject, 🏁/⚠️ openers strip
as decoration. The declared register no longer only gates capture — it also
sets the harvested line's TRUST TIER (`narrationKindForGlyph`): 🏁 verdict and
⚠️ hazard are promoted into the deliberate ranking tier and a declared hazard
feeds the chainScore boost (see the narration section above). The ranking
unlock the glyph grammar was built to enable is now live; untagged prose stays
the priority-last backstop, so 0%-compliance behavior is unchanged.

## 6. Epoch stamp

At the first tool boundary after a freeze epoch the session appends one line:
`[Fold epoch #N — <cause detail>]` (prefix `FOLD_EPOCH_STAMP_PREFIX`, detail
truncated to 120 chars). Emitted at most once per epoch, as the last boundary
context part. It is synthetic context (attaches to the preceding turn, never
starts one) — your visible signal that the frozen view just recomputed and why.

## 7. Claims interplay

- Claimed paths never fold: tool results for paths you hold claims on stay
  verbatim in the folded view (`isClaimedPath` unfold rule).
- Claiming a path your session already touched (∈ `frozenToolPaths`) forces a
  context-changed epoch so the claimed content unfolds. Claim deliberately:
  claims pin context but bust your provider cache.

## 8. Env switches

- `WARP_FOLD_FREEZE` — freeze layer on/off. `WARP_FOLD_FREEZE_TTL_MS` —
  cold-gap threshold override (wins over session/provider default and 5m).
- `WARP_FOLD_RECALL` — recall layer on/off. `WARP_FOLD_RECALL_MAX_CARDS`
  (default 2), `WARP_FOLD_RECALL_MAX_TOTAL_CHARS` (12000),
  `WARP_FOLD_RECALL_MAX_CARD_CHARS` (6000), `WARP_FOLD_RECALL_TTL_PASSES` (8).
  `WARP_FOLD_RECALL_TERMS` (default off) — tier-2 distinctive-term page-in.
  `WARP_FOLD_RECALL_VERBATIM` (default **ON**; `=0` disables) — tier-2 exact
  verbatim-token page-in (FC engines + Codex CLI).
- `WARP_FOLD_EPISODES_INJECT=0` — episodic boundary injection kill switch.
  `WARP_FOLD_EPISODES_NARRATION=0` — tier-B narration mining kill switch
  (capture-side; stops new narration annotations, existing rows unaffected).
  `WARP_FOLD_NARRATION_REMINDER=0` — disables the self-bootstrapping recall-card
  reminder (the 🗣 value-demo footer) for A/B; promotion and capture untouched.
  `WARP_FOLD_EPISODES_TTL_BOUNDARIES`, `WARP_FOLD_EPISODES_MAX_CHAINS`
  (default 2), `WARP_FOLD_EPISODES_BUDGET_CHARS` (default 2000),
  `WARP_FOLD_EVICT_THRESHOLD_CHARS` (`0` disables sawtooth eviction).
- Active-path pins (FC + Codex CLI): the hot/recent episode card stays resident
  as a separate synthetic block appended after the normal episodic recall block,
  so walking down older chapters never drops the most-recent chapter from
  context. The pin re-pages while the agent keeps touching the zone and folds
  away once the zone TTL lapses (the agent leaves the path; touch extends TTL,
  mention only re-surfaces). `WARP_FOLD_EPISODES_PIN_MAX_CARDS` (default 2) caps
  how many hot zone cards re-pin per boundary; `WARP_FOLD_EPISODES_PIN_BUDGET_CHARS`
  (default 1200) bounds the pin block. Pins are observable via an implementation
  log line such as `PIN N card(s), M chars` and are excluded
 from the served-set counters (tracked separately as episodicPinChars).

## 9. Source map

- `src/rollingFold.ts` — fold engine: skeletons, Coordinate Closet, belt,
  `FOLD_BLOCK_PREAMBLE`, epoch-stamp formatter, synthetic-text classification.
- `src/foldFreeze.ts` — freeze/epoch decision layer (evaluate/commit).
- `src/foldRecall.ts` — page table, triggers, cards/hints, residency.
- `src/foldTerms.ts` — distinctive-term extraction + IDF scoring for recall ranking.
- `src/foldEpisodes.ts` — episodic pure core: types, burst grouping,
  branch traces, chain cards, boundary-injection state machine.
- `src/foldEpisodeCapture.ts` — epoch-seam episode derivation (dual
  message shapes, open-burst cursor, canonical member paths).
- `src/foldPathCanon.ts` — canonical path identity + alias expansion
  (pure; fs only via injected `fileExists`).
- `src/episodes/episodeStore.ts` — storage-agnostic episodic store over the
  `EpisodeDatabase` handle; `src/episodes/sqliteStore.ts` — reference
  `better-sqlite3` implementation (optional peer).
- `src/session/FoldSession.ts` — seam-1 convenience wrapper
  (`prepare(history)` = evaluate-freeze + fold + commit).
- `src/index.ts`, `src/fold.ts`, `src/episodes.ts`, `src/glyphs.ts` — public
  entry points (see the `package.json` exports map).
- Tests: `test/rollingFold.test.ts`, `test/foldFreeze.test.ts`,
  `test/foldRecall.test.ts`, `test/foldRecall.integration.test.ts`.
