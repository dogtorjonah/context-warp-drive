## 6. Results — Cost & Cache Efficiency

A skeptic's first objection to rebirth is economic, and it has two parts. The first: *isn't carrying a
package every few thousand turns expensive?* The second, sharper one, is about the prompt cache —
*rebirth changes the conversation prefix, so doesn't every rebirth throw away the KV cache and force an
expensive cold re-read?* This section answers both from the relay's turn-aggregated cost telemetry
(`relay/data/costs/`; fields: input tokens `inp`, cache-read `cacheR`, cache-creation `cacheC`, model
`tier`; total input per cost row = `inp + cacheR + cacheC`). The short answers: the package is small and
bounded, and **rebirth does not break the prefix cache.**

### 6.1 The package is bounded, so context is a sawtooth, not a ramp

**The successor's starting context is bounded — a ~13K-token median regardless of how long the predecessor ran — so per-turn cost traces a sawtooth, not an ever-rising ramp.**

The defining cost property of rebirth is structural. Because the successor inherits a *curated* package
rather than the full transcript, its starting context is bounded: the package runs a **~13K-token
median with a soft cap near ~38K**, independent of how long the predecessor ran. That the median sits low
is the cost win; that it cannot be driven toward zero is the constraint the package-design literature
imposes — under-specified prompts regress roughly twice as often, and disproportionately *across model or
prompt changes* (arXiv:2505.13360), which is the lower wall of the lean-package floor (§8.5) and the reason
the curated package carries the irrecoverable intent in full rather than a bare pointer to it. This is what makes the
per-turn context a **sawtooth** (§1): context climbs within a life, resets to the bounded package at the
rebirth boundary, and climbs again — rather than marching monotonically toward the window ceiling the
way an un-reset session does. The re-establishment token cost of the *recovery turn itself* (§5.4,
~30–35K) is a different and larger quantity: it includes the package *plus* the successor's first turn
of real work. The package is the floor the agent resets to; the recovery turn is what it then spends to
get moving.

*(Honesty note: the costs log is turn-aggregated — a turn's tool-loop round-trips are summed into one
row — so we cannot honestly extract a clean per-turn sawtooth amplitude from it, and we do not plot a
manufactured one. The bounded-package statistic and the cache-stability result below carry the cost
story instead.)*

### 6.2 Rebirth does not break the prompt cache

**The prompt cache survives the handoff: cache-read sits at 94.3%, only ~1.7 points below ordinary warm turns.**

If rebirth destroyed the reusable prefix, the cost rows immediately after a rebirth (or session)
boundary would show a cache-read rate far below the session average. They do not. On Anthropic models
the cache-read rate is **94.3% across all cost rows**, **94.5% on warm (non-boundary) rows**, and
**92.8% on the first row after a boundary**. The boundary rate sits only ~1.7 points below warm —
**the prefix survives the handoff.** This is consistent with where the cacheable
mass actually sits. The reliably-cached region is the large *static* prefix — system prompt, SOP battery
packs, tool schemas — byte-identical across every turn *and* every rebirth, so it stays cached regardless
of the boundary. This is exactly the reuse that prompt-caching systems are built to exploit: precomputing
and reusing the attention states of recurring segments such as system messages and prompt templates
(**Prompt Cache**, Gim et al., arXiv:2311.04934), so a prefix that does not change is not re-prefilled. The structured rebirth package is **not** part of that static region: it is regenerated
with fresh state at each rebirth (Active Edit Delta, rail cursor, recent messages), so at least part of it
is re-created rather than read. The boundary still reads 92.8% from cache because the static prefix
dominates the input volume — *not* because the package persists across resets; if the regenerated package
dominated, the boundary row would crater rather than dip 1.7 points. The honest mechanism is **a dominant
static prefix plus a bounded, partly-recreated package**. The architecture that makes the static region
cacheable lives in the relay's prompt-caching layer (`promptCaching.ts`); the measurement confirms it holds
in production, not just in design.

The stakes this result carries are independently established. **Don't Break the Cache** (Lumer et al., arXiv:2601.06007) — the first systematic evaluation of prompt caching for multi-turn agentic workloads — measures 41–80% API-cost and 13–31% TTFT savings across three providers, and shows the benefit is fragile: strategies that perturb cache blocks can erase or even invert it. Its guidance is to structure prompts so the static prefix survives every turn. Rebirth extends that principle across the most disruptive event a session contains — the reset itself (94.3% Anthropic cache-read on arrival turns, above). The caching literature evaluates cache-preservation strategies within a continuous session and stops short of context-management events; connecting the continuity mechanism to the cache-economics axis the literature establishes is the contribution of this section and §9.

The cost consequence is large. At documented cache pricing — reads at ~0.1× the normal input price *and*
cache writes at their 1.25× premium, both applied — a 94.3% read rate yields a measured **83.6% reduction
in input-token cost** versus an uncached baseline —
i.e. rebirth runs ride almost entirely on cached input, and crossing the boundary does not forfeit
that. The by-provider read rates and the resulting input-cost reduction are reported in §6.3 and
regenerate byte-stably from the frozen corpus (Appendix A.4).

### 6.3 Cache behavior by provider (and why the blended number is not the headline)

**Anthropic's 94.3% is the honest headline because it is the provider that actually reports cache telemetry; the lower blended number is diluted by silent providers, not by bad caching.**

Cache economics are provider-specific, and honesty requires separating "caches poorly" from "reports no
cache telemetry." Anthropic reports the 94.3% above. Among the others that emit cache fields,
OpenAI/Codex reads **57.6%** and GPT **48.5%** — real cross-provider caching, lower than Anthropic. The
remaining engines in our corpus — DeepSeek, GLM, Gemini, MiniMax — report **0%, because they emit no
cache telemetry at all**, which is an *absence of data*, not evidence of bad caching. Consequently the
naïve all-engine blend (**53.8%**) is diluted by providers that simply do not report, and we
deliberately do **not** headline it; we report only the providers that emit cache telemetry and label
the rest as no-telemetry. The defensible claims are the per-provider ones: Anthropic ~94%,
OpenAI-family ~50–58%, others unmeasured.

### 6.4 Per-turn cost is flat at depth — the sawtooth has bounded amplitude

**Per-turn cost stays flat no matter how deep the chain runs — the hundredth turn costs no more than the fifth.**

§6.1 establishes the package floor but notes the cost log is turn-aggregated, so it cannot show whether
per-turn cost *ramps* across a long chain — the signature that would betray a leaking, unbounded context.
The turn index (§4) answers where the cost log cannot: per-turn `token_count` does not climb with chain
depth. On this paper's own authoring chain (492 turns), per-turn throughput averages **13.9K in the first
third and 14.9K in the last third** — flat, not ramping; across the long worker chains the pattern holds
(early-vs-late thirds stay in a bounded band, several *declining*), and none show the monotonic climb an
un-reset session would. This is the macro shadow of the §6.1 sawtooth: each rebirth returns the agent to a
bounded floor, so the hundredth turn of a chain costs no more than the fifth — whereas an unbounded
session's late turns would each re-process the entire accumulated transcript.

The boundary turns themselves are bounded and skewed. Rebirth-triggered turns run a **~15–20K median**
token throughput — but a **~43K mean**, dragged up by a heavy tail: 38% are under 5K (light or
cached-package resets, including the degenerate organic spins of §5.7), while ~12% exceed 100K when a large
package is cold-loaded — at a median wall-clock of **~5.4 minutes**, about 50% longer than an ordinary turn
(≈3.6 min) — the ~1.8-minute excess reflecting the bounded package read *plus* the heavier first increment of work
on arrival, **not** a multi-minute reorientation stall (re-grounding itself is near-instant, §5.4). The figure to
quote is the **median**, not the mean: the heavy tail makes the mean overstate the typical rebirth tax. This nests cleanly with §6.1's ~13K
package floor (a typical rebirth ≈ package + light first work) and §5.4's ~30–35K recovery cost (the
recovery turns are the heavier draws of this same distribution).

### 6.5 A live row-level reproduction on the instance revising this section

**The §6.2 result reproduces at row level on the agent revising this section: its own rebirth boundary
read 89.2% of its prompt warm and paid creation only on the package — and the same night's fleet scan
yields a measured warmth hierarchy across boundary types.**

The cache results above are corpus aggregates. On 2026-06-09 — after a same-day pricing-seam fix made
per-row receipts trustworthy — the agent revising this section was itself rebirthed mid-task and read its
own cost rows, turning §6.2's claim into a row-level, self-applied reproduction. Define a row's **warm
share** as `cacheR / (inp + cacheR + cacheC)` — the per-row form of §6.2's cache-read rate. The instance's
three-row life (`relay/data/costs/<instanceId>.jsonl`):

| Turn | Session | `inp` | `cacheR` | `cacheC` | Warm share |
|---|---|---|---|---|---|
| Fork birth, turn 0 | original | 2 | 41,090 | 39,923 | 50.7% |
| Pre-boundary steady state | original | 2 | 81,013 | 3,446 | 95.9% |
| **First post-rebirth turn** | **new** | **6** | **235,891** | **28,458** | **89.2%** |

The boundary row reads exactly as §6.2 predicts. The post-rebirth turn ran three tool-loop round trips, so
its per-round-trip warm read is ≈78.6K — almost token-for-token the ~81K prompt the instance carried
*before* the boundary: the successor woke up reading its predecessor's prefix hot. Creation was 28,458 —
package-sized, the regenerated handoff plus fresh tool results, not a corpus re-prefill; a cold transplant
would have inverted those two columns. Uncached input across the entire three-turn life: **10 tokens.** A
same-night fleet scan (1,457 cost ledgers, gated to post-fix receipts; all rows one model family) places
this in distribution rather than leaving it an anecdote: across **n = 12** clean rebirth boundaries on four
instances, boundary warm share ran **71.7–98.3%, median ~92%** — consistent with §6.2's corpus 92.8% — against
a steady-state median of **97.1%** (n = 31, min 82.5%).

The same scan produced a token-exact natural experiment that *sharpens* §6.2's mechanism claim. A freshly
spawned instance's first-ever turn and the fork's first turn (table above) read **exactly 41,090 tokens**
warm — the same number, because both were reading the **fleet-shared static prefix**, cached once and
reused by every instance. A fork's ~51% first-turn warmth is therefore *shared-prefix reuse, not
parental-trace reuse* — the carried trace bills as creation (39.9K above) — exactly the "dominant static
prefix" anatomy §6.2 argues, here confirmed by an identity across two different birth types rather than by
an aggregate. The measured ordering that falls out — steady state (~97%) > rebirth boundary (~92%) >
birth/fork (~51%, floored at the shared prefix) > cold (0%) — is the calibration a cache-health monitor
needs: each boundary *type* has its own healthy band, and "creation dominates read" is the failure
signature at any of them.

*(Scope: this is a single night's audit on one model family — an n = 1 self-reproduction placed in an
n = 12 boundary distribution. It upgrades §6.2 from "corpus aggregate" to "reproduced at row level, on the
author," and it calibrates the per-boundary-type bands; it does not replace the corpus result.)*
