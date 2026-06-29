## 9. A Parameterized Cost Model for Backend Rebirth

The continuity results (§5) and the cache-stability result (§6) answer "does rebirth keep working" and
"does it break the cache." This section answers the economic question underneath the implications (§10):
*what does it cost, per turn, to serve a long-running agent two ways* — letting context grow under
periodic compaction, versus resetting it to a bounded package every few turns — and *when does one beat
the other?* We build a small, explicit model with named parameters so a reviewer can substitute their
own provider's numbers, and we calibrate it against the one input-cost reduction we actually measured
(83.6%) so that the model lands on a real number rather than floating free. We are deliberate about which
terms are **measured** and which are **assumed**, and we bound the claim accordingly (§9.6).

The economic argument is conditional on the quality gate in §4.10. If frequent rebirth is worse at the
work, cheaper tokens do not save it. If frequent rebirth is **non-inferior** at the work, the rest of the
argument is almost mechanical: bounded context lowers the length term, cache stability lowers the price
term, and the serving stack gets a predictable prefix instead of an ever-growing transcript.

### 9.1 Setup: two ways to serve T turns

Consider an agent that must serve a session of **T** turns. On every turn it sends a prefix (system
prompt + accumulated history or package + the new message) to the model and pays for the input tokens.
The two regimes differ only in how the prefix length evolves:

- **(A) Compaction baseline.** The prefix grows by roughly **g** tokens per turn as history
  accumulates. When it approaches the context ceiling **C**, a blocking summarization pass compresses it
  and it keeps growing again. Its steady-state mean length **L̄_A** sits high — near the ceiling, because
  the reason to compact at all is that you are near the limit.
- **(B) Periodic backend rebirth.** Every **τ** turns the agent is reborn into a curated package of size
  **P ≪ C**. Within a life the prefix grows by **g** per turn from P; at the boundary it resets to P.
  Its length is therefore a **sawtooth bounded in [P, P + gτ]**, with mean **P̄ = P + gτ/2**, and that
  bound is *independent of T*.

The measured anchors (§5, §6) fix two of these: **P ≈ 13K tokens median, ~38K cap**, and the cache
behavior below. Everything else (C, g, τ, the summarization cost) is a parameter the reviewer sets.

### 9.2 The cost of cached input, calibrated to the measured reduction

Prompt caching changes what a prefix costs. On a call sending L input tokens of which a fraction **ρ**
is served from cache, with cache-read priced at a multiplier **r** of the base input price **p** (and
the small per-turn delta written at multiplier **w**), the per-turn input cost is, to leading order:

```
c(L) ≈ p · L · [ ρ·r + (1−ρ) ]  +  (write term on the per-turn delta)
     ≡ p · L · κ(ρ, r)
```

where the **effective input-price multiplier** is

```
κ(ρ, r) = ρ·r + (1−ρ) = 1 − ρ·(1−r).
```

κ is the fraction of the naïve uncached input price you actually pay. The crucial modeling property for this
section: we treat **κ as multiplying *both* regimes**, because under exact-prefix caching both A and B re-send the
same large *static* prefix (system prompt, tools, SOP) ahead of whatever changed, and an unchanged prefix is not
re-prefilled. Two honesty notes. **We measured κ only for rebirth** (§6.2); we have no compaction cache telemetry in
this corpus, so "compaction also rides the cache" is an expectation from the exact-prefix mechanism, not an
observation. And the direction of that assumption is **conservative for rebirth** — granting compaction the same κ
denies rebirth any cache advantage — so caching cancels rather than separates the two. Caching is not what separates
them; the prefix bound is.

*Calibration.* Our measured Anthropic read rate is **ρ = 0.943** at a documented read multiplier
**r ≈ 0.1**. Plugging in:

```
κ = 1 − 0.943·(1−0.1) = 1 − 0.943·0.9 = 0.151,
```

an *idealized* **84.9% input-cost reduction** versus an uncached baseline (1 − κ). We measured **83.6%**.
The ~1.3-point shortfall is real and accounted for: cache-creation tokens are charged at **w ≈ 1.25×**,
and the first call after a boundary reads at **92.8%** rather than the warm **94.5%** (§6.2). Solving the
model backward, an *effective* read rate of **ρ_eff ≈ 0.929** reproduces the measured 83.6% exactly
(κ = 1 − 0.836 = 0.164 ⟹ ρ_eff = 0.836 / 0.9). So the raw 94.3% read rate and the 83.6% cost reduction
are not two independent boasts — they are the same quantity, related by the model with a ~1.4-point
write/boundary overhead, and the model reproduces the measured number. This is the empirical hook that
keeps the rest of the section honest.

### 9.3 Per-turn input cost: compaction vs rebirth

Applying κ to each regime's prefix length:

```
Compaction:   c_A(t) = κ·p·L_A(t)              + s/m      (amortized summarization, every m turns)
Rebirth:      c_B(t) = κ·p·L_B(t)              + B/τ      (amortized package-build, every τ turns)
```

with `L_A(t) = min(P + g·t, C)` climbing to and then held near the ceiling, and `L_B(t)` sawtoothing in
`[P, P + gτ]`. **s** is the cost of one blocking summarization pass (it must read ≈C tokens to produce a
summary, so `s ≈ κ·p·C + (summary output)`, and it *stalls the turn* — a latency cost on top of the
token cost). **B** is the cost of building one rebirth package (a bounded curation over the recent
context, paid once per τ turns). This is not the same as the measured ~30K-token re-establishment turn
of §5.4, which includes the package plus the successor's first turn of real work; it is an
implementation-specific overhead the model keeps separate.

### 9.4 Cumulative cost, the crossover, and the steady-state ratio

Summed over the session:

```
Σ_A(T) = κ·p·Σ_t L_A(t)  +  (T/m)·s
Σ_B(T) = κ·p·Σ_t L_B(t)  +  (T/τ)·B  =  κ·p·P̄·T  +  (T/τ)·B
```

**Short sessions — rebirth is not free.** While the session is young (t small), `L_A(t) ≈ L_B(t) ≈ P`,
both regimes cost nearly the same, and rebirth carries pure overhead (the `B/τ` package-builds buy
nothing because there is no accumulated context to save against). Rebirth *loses* on short tasks. The
**crossover T\*** is where compaction's accumulated excess context overtakes that overhead — on the
order of *tens of turns* for typical growth (with g = 400 tok/turn and P = 13K, the prefix reaches
2·P̄ ≈ 42K after ~70 turns and the ceiling C = 200K after ~470 turns). This is why the paper scopes its
claims to **long-running** agents: that is the regime where the model says rebirth pays.

**Steady state — the bound becomes the whole story.** For large T the per-turn cost in each regime
approaches a constant, and the ratio is simply the ratio of mean prefix lengths (κ and p cancel):

```
R  =  c_A* / c_B*  ≈  L̄_A / P̄ ,     with   P̄ = P + gτ/2   bounded,
                                            L̄_A ≤ C       and  L̄_A → C asymptotically.
```

This is the model's headline, and it is deliberately *not* "rebirth caches better." It is: **rebirth
bounds the prefix to P̄ while compaction lets it ride near the ceiling C, so the steady-state per-turn
input cost ratio is L̄_A / P̄ — an advantage that holds for the life of the session rather than degrading
as context accumulates.** Caching (the factor κ ≈ 0.15) lowers the absolute cost of *both* regimes by
the same ~85%; it does not touch the ratio. The lever is the context bound.

We state the honest envelope rather than the most flattering point: compaction's mean prefix L̄_A is
bounded above by C and reaches it only asymptotically (a compactor that reclaims aggressively runs at,
say, ~0.7·C, shrinking R proportionally). So R ranges from "modest but > 1, once context exceeds P̄" up
to the asymptotic envelope C/P̄.

### 9.5 Sensitivity: the steady-state ratio R ≈ L̄_A / P̄

Taking L̄_A = C (the asymptotic envelope) gives the per-turn input-cost advantage of bounding the prefix:

| Ceiling C \ Bounded mean P̄ | P̄ = 13K (floor) | P̄ = 21K (13K + g·τ/2) | P̄ = 38K (cap) |
|---|---|---|---|
| **C = 128K** | 9.8× | 6.1× | 3.4× |
| **C = 200K** | 15.4× | 9.5× | 5.3× |
| **C = 1M** | 76.9× | 47.6× | 26.3× |

Read it as: the larger the model's context window relative to the bounded package, the larger the
steady-state saving from keeping the prefix bounded — and on million-token windows the gap is an order of
magnitude or more. A reviewer who runs a more aggressive compactor (lower L̄_A) or a heavier package
(larger P̄) reads a smaller cell; the structure — `R = L̄_A / P̄`, multiplied onto an already cache-reduced
absolute cost — is the same. The summarization-stall term `s` and the package-build term `B` are
second-order in T (both amortized); the net overhead depends on implementation. The important asymmetry
is that `s` is a blocking ≈C-token pass, while `B` is a bounded curation over the rebirth package and
recent context.

### 9.6 What is measured and what is assumed (the honesty ledger)

| Symbol | Meaning | Status |
|---|---|---|
| ρ = 0.943 | Anthropic cache-read rate | **measured** (§6.2) |
| 92.8% / 94.5% | boundary / warm read rate | **measured** (§6.2) |
| 83.6% | input-cost reduction vs uncached | **measured** (§6.2) — model reproduces it |
| P ≈ 13K median, ~38K cap | rebirth package size | **measured** (§6.1) |
| ~30K | re-establishment turn, including package plus successor work | **measured** (§5.4) — bounds but does not equal B |
| r ≈ 0.1, w ≈ 1.25 | cache read / write multipliers | **documented** provider prices (semi-measured) |
| C | context ceiling | **assumed** — provider/model specific |
| g | per-turn context growth | **assumed** — workload specific |
| τ | rebirth interval | **policy choice** |
| s, B | summarization-pass / package-build cost | **assumed** — implementation specific |
| g equal across regimes | A and B accrue per-turn context at the same rate | **assumed** — a successor's tap/recovery reads could raise rebirth's effective g; the turn-aggregated cost log (§5.4) cannot split orientation from work |
| both regimes pay the same κ | compaction also rides the static-prefix cache | **assumed** — exact-prefix mechanism; measured only for rebirth (§6.2) |

The model's *load-bearing* claim — that the steady-state per-turn input cost ratio is `L̄_A / P̄` and that
caching does not change it — depends on measured quantities (P, ρ for rebirth) plus the architectural *expectation*,
from exact-prefix caching, that compaction re-sends the same cacheable static prefix (an assumption, not a compaction
measurement). That assumption is conservative: it denies rebirth a cache edge, so were it wrong in rebirth's favor
the ratio would only widen. The *magnitude* of the advantage (the §9.5 cells) depends on the assumed C, g, τ, which
is exactly why we parameterize rather than assert a single number.

### 9.7 The implication

Two regimes both ride the cache and both pay κ ≈ 0.15 of the naïve input price. The only structural
difference is whether the per-turn prefix is **bounded** (rebirth, at P̄) or **growing toward a ceiling**
(compaction, at L̄_A). Bounding it buys a steady-state per-turn input saving of `L̄_A / P̄` — single-digit
to order-of-magnitude on today's windows (§9.5) — that *persists* for the life of the session instead of
eroding as context fills. The continuity condition that makes this saving worth considering is not
quality superiority; it is quality non-inferiority. §5 provides observational evidence consistent with
that condition: resetting to the bounded, intent-preserving package shows a conservative 87% recovery
floor and no detected within-engine hot-swap penalty. §8 specifies the controlled fork that can test the
remaining counterfactual. This analysis is complementary to budget-constrained compression approaches that formulate context management as a sequential decision problem under a token limit (**ContextBudget**, Wu et al., arXiv:2604.01664); they optimize the compression decision within a fixed budget window, while the advantage here — P̄ ≪ C — holds for the session as a whole and compounds over long runs.
If that gate holds, a per-turn backend that performs rebirth-style bounded re-grounding becomes a
**controllable, intent-preserving alternative to opaque blocking summarization** — the argument §10
develops. The cost model is what makes that argument quantitative rather than rhetorical: the package is
not just continuity infrastructure, it is a *cost-control* lever whose savings the equations above let any
lab price out on its own parameters.

### 9.8 Relation to KV-cache serving work

The factor κ in this model is the **billing abstraction** of a broader prefix-cache serving surface: how
much of the repeated prefix must be paid for, recomputed, or stalled on after each turn. A fast-growing
serving literature optimizes the machinery underneath that abstraction, and the cost axis here belongs in
that context rather than beside it. The billing-economics case — the magnitude and fragility of cache savings in multi-turn agentic workloads — is developed in §6.2 (see **Don't Break the Cache**, Lumer et al., arXiv:2601.06007). Its foundations are two now-standard systems: **PagedAttention** (Kwon
et al., arXiv:2309.06180), which manages the KV cache as paged virtual memory so a prefix can be shared
within and across requests without fragmentation, and **RadixAttention** in **SGLang** (Zheng et al.,
arXiv:2312.07104), which makes that cross-request reuse of a shared prefix *automatic* — the exact serving
mechanism that keeps this paper's large static prefix (§6.2) cached across every turn and rebirth. The
recent agentic-serving work specializes them. **Stateful Inference for
Low-Latency Multi-Agent Tool Calling** (Norgren, arXiv:2605.26289) opens from the same observation that
motivates our §6 cache result — "85–95% of the prompt is unchanged from the previous turn" — and converts
the conventional per-turn **O(n)** serving cost into an **O(Δ)** delta-only cost by keeping a persistent KV
cache across turns and advancing it with only the new tokens, extended across interleaved agents by a radix
prefix cache (the RadixAttention idea above). **Leyline: KV Cache Directives for Agentic Inference** (Ma et al., arXiv:2606.01065) takes on
the harder agentic case that retries and pivots create, where policy-driven context editing moves or
invalidates content in an exact-prefix cache, and adds a serving-side directive to splice or trim cached
spans without a full re-prefill. Both operate on the **cache/serving mechanism** — the effective per-turn
input price, prefill latency, and compute reuse that κ abstracts at the paper's billing level — by reusing
or repairing the unchanged prefix rather than reprocessing
it.

Our model is deliberately *orthogonal* to that work, and saying so sharpens the claim rather than weakening
it. Because κ multiplies the compaction regime and the rebirth regime **equally** (§9.2), it cancels out of
the steady-state ratio `R = L̄_A / P̄` (§9.4): however good the serving stack's caching becomes, the lever
rebirth contributes is the **context bound P̄**, not a better cache. The two therefore **compose** — a
backend that runs rebirth-style bounded re-grounding *on top of* a stateful-inference cache collects both
the κ reduction and the P̄ bound — and the continuity-specific quantity this paper adds, *what bounding the
per-turn prefix is worth over the life of a session*, is exactly the axis these serving papers do not
report. We read them as complementary infrastructure for the same backend, not a competing account of the
same saving.
