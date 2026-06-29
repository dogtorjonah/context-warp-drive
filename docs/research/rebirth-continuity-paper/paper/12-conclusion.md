## 12. Conclusion

A finite context window makes a long-running agent mortal: at the ceiling it dies, and whatever intent
was in flight dies with it. Rebirth changes that boundary from a death into a bounded,
identity-preserving handoff. A successor boots from a curated package, keeps the same identity, and
continues the same intent — and at deployment scale, across eight engines and 8,717
boundaries, it largely works: an interrupted intent is carried to completion **87.5%** of the time as a
current parser-floor — with a blind judged audit of a *uniform random* sample of first successor turns
independently landing at **90.7%** (§5.3.1) — clean handoffs persist at **96%**, re-grounding is effectively immediate (the recovery
turn is the successor *doing the work*, not getting back up to speed), swapping the model across the boundary shows
**no detected within-engine continuity penalty**, and the prompt cache survives the boundary for rebirth
(**94.3%** cache-read, an **83.6%** input-cost reduction). The
organizing finding is that **the package carries the intent, not the bytes**: continuity is a property
of what you curate for the successor, not of how much raw history you retain.

One limitation dominates the rest. Our *scale* evidence is **observational** — it records what happened across a
live system, not the counterfactual of the same task without rebirth (the controlled exceptions are the
realized-action A/B of §5.8.2 and the earlier judged probe it superseded, disclosed there) — and the headline rate is a
conservative parser-floor. A current deterministic heuristic recode estimates a ~98% uncensored ceiling,
and a row-level audit of the 111 suspect rows finds that roughly half are non-intents (chatroom-invite
wake events and system messages) the floor was correct to flag. The old ≤May-19 judged ceiling is
therefore historical context, not a current manual ceiling.
The clean causal test is designed and pre-registered (§8) but not yet run; until it is, we claim
association and mechanism, not cause. The hot-swap result is the most underpowered of the headline
claims: even the within-engine swap cell is wide once instance-clustering is accounted for
([−8.6, +10.7], §7.1) and sits on an over-determined state axis, so we report *no penalty detected*, not
*no penalty* — and the better-powered intent-continuity test is future work.

A word on provenance, because it cuts both ways. This paper was researched, drafted, and *red-teamed* by
agents running under the mechanism it studies — its sharpest reflexivity hazard (§11.10) and, handled
honestly, its most direct existence proof: a swarm that produced a rigorous, self-critical paper across
rebirths and model swaps, and whose forked reviewers retracted its own overclaims (§8.3, §11.5), is itself a
long-horizon demonstration that the mechanism carries hard work to completion. We lean on that only because it
is paired with a frozen, reproducible corpus and falsifiers that fired against us — the dogfooding earns its
keep through the disclosure, not despite it.

The forward bet is larger than our system. Its clean, load-bearing form is a non-inferiority claim: if a
successor can resume an interrupted intent **not worse** than ordinary continuation, then rebirth need not
stay a session-level rescue — it can become a **per-turn backend inference primitive**: transparent,
bounded-context continuation offered in place of lossy summarization, with the economics made precise by
the cost model of §9. But there is a stronger bet underneath it, which we make as a *registered secondary
hypothesis* rather than a result: because long context degrades reasoning *intrinsically* — accuracy falling
even under perfect retrieval (arXiv:2510.05381), earlier errors in the context biasing later steps toward
repeating them (arXiv:2602.04288; §2.5, §10.2) — the bounded, curated prefix may be not merely cheaper but
**better**, and the flat-fidelity-across-depth result (§5.7) is its first observational shadow. The cache
result matters because it removes the obvious objection; **realized-action non-inferiority is now measured** —
the paper's primary controlled head-to-head, varying only the resume artifact across five model families × five
boundaries, finds the package and a fair full-context compaction summary drive **equally correct first actions**
(≈ 0.89–0.93 each; paired gap within ±0.04, non-significant; §5.8.2). This parity is the *intended outcome*:
the null — "rebirth is worse by δ=0.1" — is rejected, meeting the non-inferiority burden the study was
designed to test. With first-action quality tied, rebirth's decisive advantages are the axes that genuinely differ:
**determinism, an instant non-blocking boundary, controllability, and versatility** — a cheap, inspectable,
field-ablatable, forkable, hot-swappable package whose retained state is explicit, versus opaque prose welded into
one running session. We are deliberate about what we do *not* claim: rebirth removes the summarizer's generation call
and bounds the prefix, but whether *total* serving cost beats a competent compactor is the parameterized question of
§9, not a settled result. Parity under non-inferiority is not a tie to apologize for — it is the win the experiment
was built to detect. The **task-outcome** non-inferiority test (§8) remains the open one, and
the degradation literature puts the wind at the bounded reset's back for the *chained*-compaction comparison
still to run.
Rebirth makes the context ceiling negotiable — and it makes long-agent memory an explicit, auditable, controllable
surface rather than a summary one hopes kept the right thing. The next experiment decides whether that control is
also cheaper — and perhaps better, not only cheaper.
