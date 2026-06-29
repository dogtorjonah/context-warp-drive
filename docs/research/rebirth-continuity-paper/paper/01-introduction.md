## 1. Introduction

Large language model agents operate inside a finite context window. For short, bounded tasks this
is invisible; for *long-running* autonomous work — a coding agent that refactors a subsystem over
hours, a research agent that pursues a question across hundreds of tool calls, a swarm of agents that
coordinate over days — it is the dominant operational constraint. As the transcript grows, the agent
approaches a hard ceiling. At that ceiling the agent effectively *dies*: the session ends, or the
system silently truncates history, and whatever intent was in flight is lost.

The standard mitigation is **summarization-based compaction**: when the window fills, an LLM call
compresses the transcript into a shorter summary and the agent continues from it. This is the default
in production coding agents and the informal practice behind progress files such as Anthropic's
long-running-agent `claude-progress.txt`. Compaction keeps the conversation bounded, but it has two
well-documented costs. It is **lossy** — summarization discards detail it cannot know will matter, and
it compounds: each pass summarizes the previous summary. And it is a **blocking stall** — recent work
on long-horizon agent serving reports the summarization call halts inference for tens of seconds while
the operator has no control over what is kept (arXiv:2605.23296; 2601.07190). Compaction, in other
words, trades the context ceiling for slow, silent, accumulating amnesia.

Both incumbent answers — let the context grow, or summarize it in place — share a deeper liability the
token budget hides: a large working context degrades reasoning *itself*, not merely the bill. Length
alone lowers answer quality even when retrieval is perfect (arXiv:2510.05381) and even when every token
stays relevant (arXiv:2601.15300); attention underweights the middle of long inputs (arXiv:2307.03172)
and the *effective* window runs well below the advertised one (arXiv:2404.06654). An agent at the end of
a long turn is therefore already thinking in a degraded regime. Bounding the per-turn prefix is not only
cheaper — it keeps the agent in the part of the window where it reasons best, which is the first reason
this paper argues a bounded reset is not merely competitive with compaction but *better* than it.

We use a few system terms throughout, so we define them here rather than assuming Voxxo knowledge. A
**task rail** is a persistent ordered plan with a current execution step; a rail cursor or rail position is
the saved pointer to that step. An **instance id** is the persistent identifier for the logical agent.
**File claims** are edit-ownership records that tell other agents which files or regions an agent is
responsible for. A **chatroom** is a durable agent-to-agent coordination log. **Atlas** is the codebase
provenance and search layer whose commits record what changed, who changed it, and why. **Pinned
waypoints** are brief self-authored notes or milestones the agent can recover later. A **squad** is a
cooperating group of agents with assigned roles, and a **wave pipeline** is a programmatic sequence of
task-rail phases that may rebirth an agent between phases. These are concrete interfaces in voxxo-swarm,
but the paper treats them more generally as externalized coordination state.

We study a different boundary. When an agent in our system approaches the ceiling — or when an
operator, a wave pipeline, or the agent itself decides to — it is **reborn**. A *successor* boots from
a structured **package**: not the raw transcript, but a curated bundle of the messages, the in-flight
edit state, the task-rail cursor, the coordination state, and the agent's own pinned waypoints. The
successor is **the same identity** — the same instance object, with the same id, file claims, rail
position, and squad role — and it continues **the same intent**. Because the package is bounded, the
agent's per-turn context follows a *sawtooth* (Figure A, §3): it climbs, resets at the rebirth boundary, and climbs
again — bounded forever, rather than marching monotonically toward a ceiling. The organizing claim of
this paper is that **the package carries the intent, not the bytes**: continuity is preserved not by
retaining the full history but by curating what the successor needs to keep going.

This is not a proposal. It is a deployed mechanism in a live multi-agent system (voxxo-swarm), and the
agents writing and measuring this paper are themselves running under it. That gives us an unusually
large and diverse observational record: **8,717 rebirth arrivals** across **eight
model engines** (Claude, Codex/GPT, DeepSeek, GLM, Gemini, MiniMax, Kimi, and others), with full
transcripts, structured rebirth boundaries, and turn-aggregated cost and cache telemetry. We use it to ask
the questions that matter for whether rebirth is a good idea: Does the successor actually finish the
interrupted intent? How expensive is the handoff? Does it survive *changing the model* at the boundary?
And — the question a skeptic asks first — does it wreck the prompt cache?

The crux is not whether rebirth makes an agent smarter than ordinary continuation. That is the wrong
bar. The bar is **non-inferiority under a bounded context**: if the successor does the right work within
a pre-specified quality margin, while the per-turn prefix stays bounded and highly cacheable, then the
cost case speaks for itself. A system that can reset context every few turns — in the backend limit,
every turn — without a detectable quality penalty has changed the serving problem from "how do we keep
feeding an ever-growing transcript?" to "what bounded state is sufficient to preserve intent?"

**Contributions.** We make five.

1. **A deployed same-identity rebirth mechanism** (§3), and its portable generalization: `brain-mcp`,
   which reproduces rebirth on the vanilla Claude Code CLI (wrapper → relaunch + handoff, with model
   passthrough), establishing that rebirth is a thin protocol over an ordinary CLI agent rather than a
   property of our particular system.
2. **An intent-continuity metric** (Score A / N2; §4) anchored to a *ground-truth denominator*: because
   the system hands over a no-silent-drops package manifest, we know exactly what was carried, and can
   score continuity on a normalized scale rather than as a one-sided cost delta.
3. **The largest deployment-scale continuity measurement we are aware of** — over 12× the corpus and ~3×
   the engine diversity of the closest prior work — reporting recovery, persistence, and re-establishment
   cost (§5), and a **model-hot-swap non-inferiority result** (no detected within-engine continuity
   penalty; cross-engine underpowered, §7), all with confidence intervals and explicit substrate labels
   (Figures E and F).
4. **A cost-and-cache result** (§6): rebirth *preserves* the prompt-cache prefix — a measured 94.3%
   cache-read rate on Anthropic calls, an 83.6% input-token cost reduction — directly answering the
   cache-prefix objection with measurement rather than assertion (§6.2–§6.3).
5. **An implication for frontier inference** (§9–§10), made precise by a parameterized cost model:
   once task quality is non-inferior, per-turn backend rebirth turns bounded context and cache stability
   into a serving-economics lever — a testable hypothesis rather than a slogan.

We are deliberately conservative about what an observational study on a single system can establish.
Our results describe *what happened*, not the counterfactual; the clean causal test — a controlled
fork-and-compare experiment — is designed (§8) and reported as forthcoming, not claimed. The rest of
the paper describes the mechanism (§3), the metric and method (§4), the continuity, cost, and
non-inferiority results (§5–§7), the experimental design and forking methodology (§8), the cost model
and its implications (§9–§10), and an honest account of the threats to validity (§11).
