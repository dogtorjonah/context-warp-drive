# Rebirth: Bounded-Context Continuity for Long-Running LLM Agents via Same-Identity Successor Handoff

*Working preprint — preliminary. Author: Jonathan Tarashansky, DVM (independent). Instrument: voxxo-swarm.
Generated and measured within the system it describes.*

## Abstract

**The mechanism.** Long-running LLM agents die at the context ceiling, and the standard mitigation —
summarization-based compaction — is lossy, stalls inference while a model re-reads the transcript, and
gives the operator no control over what survives. We study a different boundary, deployed in a live
multi-agent system: **rebirth**. When an agent nears the ceiling — or an operator, a pipeline, or the
agent itself decides — the system assembles a bounded **package** from the live session: the open request
and recent thread *verbatim*, the in-flight edit delta, the task-rail cursor, coordination claims, and
the agent's own pinned notes. A **successor** boots from that package and continues as the **same
identity** — same instance id, same file claims, same rail step, same squad role — so per-turn context
follows a bounded *sawtooth* instead of a monotonic climb toward the ceiling (Figure A, §3). Rebirth is
*structured, intent-preserving compaction*: lossy in bytes by construction, designed to be lossless in
intent. It works because agent state is **over-determined** — the plan, the claims, the coordination log,
and the code history already live in durable stores the successor can re-query — so the package's
irreducible cargo is only the part no store holds: the open intent and the uncommitted edits (§4.2). And
it is portable: a thin wrapper (`brain-mcp`) reproduces it on the vanilla Claude Code CLI, which is what
makes a *backend, per-turn* version of the same move conceivable (§10.4).

**The measurement.** We report the largest deployment-scale measurement of such a mechanism we are aware
of: **8,717 rebirth arrivals across eight model engines**, frozen into a checksum-verified,
reproducible corpus and scored with conservative machine labels, cluster-robust confidence intervals, and
an explicit substrate tag on every number (§4). The question throughout is one question: when an intent
is interrupted at the boundary, does the *same* agent finish it?

**The evidence, four independent ways.** A conservative machine **parser-floor**: an interrupted intent
is completed **87.5%** of the time [83.4, 91.0] (780/891) — a deliberate lower bound that counts any
fresh trigger as a break; a current heuristic recode that censors legitimately-superseded asks estimates
**~97%** (provisional, machine-labeled); the human-dogfood cohort — a person's message cut mid-turn —
recovers at **91.3%** [88.8, 93.5]; and clean-boundary handoffs persist to completion at **95.7%**
[94.6, 96.7]. A **blind LLM judge** on a *uniform random* sample of 150 first successor turns: **90.7%**
clean continuation [85.9, 95.4], validated by a negative-control arm that catches 86.7% of deliberately
broken packets and by a cross-model second judge landing within five points (§5.3.1). The paper's primary
**controlled head-to-head** — model and prompt held fixed, *only the resume artifact* varied, five model
families × five continuation boundaries — finds **parity** with a fair, full-context compaction summary
(first-action correctness ≈ **0.89–0.93** each; paired gap within ±0.04, non-significant): precisely the
**non-inferiority** the design pre-registered — the null "rebirth is worse by δ = 0.1" is rejected, and
parity is the win condition, not a consolation (§5.8.2). And **fidelity is depth-stable**: across 74
chains running out to a 684th consecutive rebirth, neither degenerate spin nor success decays with depth
— the 50th reset is as productive as the 5th (§5.7).

**The operational profile.** Re-grounding is effectively immediate — a ~13K-token
median package plus a median of **two** orientation tool-calls, so the recovery turn is the successor
*advancing the task*, not getting back up to speed (§5.4) — the prompt cache survives the boundary on the
provider that reports it (**94.3%** cache-read, an **83.6%** input-token cost reduction; modeled as an
enabling condition for *both* regimes, since under exact-prefix caching the same static prefix would stay
cached under compaction too, §6) — and model **hot-swaps** show no detected within-engine continuity
penalty (+1 point [−8.6, +10.7]; the cross-engine cell is underpowered at −4 [−12.4, +4.4]), with one
live identity spanning five engines across sixteen swaps (§7).

**What actually differs.** With first-action quality tied, rebirth's advantages sit on the axes that
genuinely separate the two mechanisms. **Determinism**: re-rendering a boundary reproduces the package
byte-for-byte, where re-compacting one fixed transcript reshuffles **~70–90%** of its concrete
file-and-identifier detail from run to run (§5.8). **An instant, non-blocking boundary**: the package is
a deterministic render of already-durable state — no summarization model call, no turn-blocking stall.
**Controllability**: the carried state is explicit and structured, so it can be inspected, tuned, and
ablated field by field. **Versatility**: a package can be forked into parallel lineages, reseeded into a
specialist, or carried across an engine hot-swap, where a compaction summary is opaque prose welded into
one running session. We do **not** claim rebirth is unconditionally cheaper: it removes the summarizer's
generation call and bounds the carried prefix, and a parameterized cost model — whose steady-state
verdict is the prefix bound itself, L̄_A/P̄ — states where that wins and where it does not (§9).

**Scope, honestly.** The scale evidence is observational, on a single system, and the controlled A/B
covers the first action, not task outcomes. We additionally register — strictly separate from the primary
non-inferiority test, so a null cannot be laundered into a win — the *secondary directional hypothesis*
that a bounded prefix is **better** than a grown or summarized one, motivated by the long-context
degradation literature (reasoning falls with length even under perfect retrieval, arXiv:2510.05381,
arXiv:2601.15300; errors already in context bias later steps toward repeating them, arXiv:2602.04288) and
shadowed, not proven, by the depth result. The decisive fork-and-compare on task *outcomes* and the
rebirth-versus-*chained*-compaction test are pre-registered, not yet run (§8). The claim we defend now is
deliberately modest, and the economics are why it matters: **a bounded reset that is not worse makes the
context ceiling negotiable.**
