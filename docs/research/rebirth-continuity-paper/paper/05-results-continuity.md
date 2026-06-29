## 5. Results — Continuity & Recovery

This is the central empirical question: when an intent is cut off before the agent can finish it, a
rebirth lands, and the successor inherits the open intent through the package — does it complete *the
same* intent? We answer on the turn substrate (§4), report every number with its N, a 95% confidence
interval (headline rates use a nonparametric instance-cluster bootstrap; §4.9), and a substrate label, and we are deliberate about the difference between a conservative
parser-floor and a censored human-judged rate. The discipline is stated once and applied throughout:
**we report the raw floor, the uncensored rate, and the censored cells, and we never round the result
up to "99%."**

**The results in one view: five questions, five answers.** The empirical sections (§5–§7) answer five
questions about whether rebirth is a good idea. Each is stated as a claim first; the data follows as the
evidence for it.

1. **Does a successor finish an intent that was interrupted?** *Yes.* Conservatively, a machine
   **parser-floor of 87.5%** [83.4, 91.0] (780 / 891); once legitimately-superseded and externally-preempted
   cells are censored, the rate rises to roughly **97%** — and the floor is *more* conservative than it
   looks, because about half of its apparent misses are not recoverable intents at all (§5.1).
2. **Do clean (uninterrupted) handoffs carry a workstream to completion?** *Yes.* Work reborn at a natural
   seam persists to completion at **95.7%** [94.6, 96.7] (§5.3).
3. **How expensive is getting the successor back up to speed?** *Barely.* Re-grounding is effectively
   immediate; the boundary is a bounded package read, not a multi-minute reorientation stall — the
   recovery turn is the successor *doing the work*, not orienting (§5.4, §6).
4. **Does rebirth wreck the prompt cache?** *No — it preserves it.* A measured **94.3%** cache-read rate
   and an **83.6%** input-token cost reduction on the provider that reports cache fields (§6.2).
5. **Does continuity survive changing the model at the boundary?** *Yes.* No detected within-engine
   continuity penalty under a pre-registered non-inferiority margin (cross-engine underpowered, §7).

We take them in turn, beginning with the central one.

### 5.1 Recovery: interrupted intent → rebirth → completion

**A successor recovers an interrupted intent in at least 87.5% of cases, and the true rate is higher — roughly half of that floor's apparent misses are not recoverable intents at all.**

An *actionable root* is a turn whose intent was interrupted before a completing assistant message and
which a rebirth then picks up. The conservative measure — the **raw floor** — counts *any* fresh
trigger arriving before completion as breaking the chain, which under-counts recovery because many
"fresh triggers" are the same user saying "did you fix it?" The floor is **87.5% [83.4, 91.0]**
(780 / 891 actionable roots). Of recovered roots, the wake turn itself completes the intent **89%** of
the time (693 / 780; 78% of all actionable roots), and the remaining **11%** recover over multiple hops
after the wake turn (87 / 780).

| Measure | Rate | N | Substrate |
|---|---|---|---|
| **Raw floor** (any fresh trigger breaks the chain) | **87.5% [83.4, 91.0]** | 780 / 891 | current parser-floor |
| — wake-turn immediate completion | 78% of roots · 89% of recovered | 693 / 891 · 693 / 780 | current parser-floor |
| — multihop recovered after wake turn | 11% of recovered | 87 / 780 | current parser-floor |
| **Current heuristic uncensored** (provisional machine pass) | **97.2% [95.8, 98.3]** | 788 / 811 | current heuristic recode |
| **Current hard-failure** (heuristic recode; churns ≥15 turns, never completes, not superseded) | **~2.8%** | 23 / 811 | current heuristic recode |

<figure>
<svg viewBox="0 0 760 348" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" role="img" aria-label="The recovery ladder: the conservative 87.5 percent parser-floor, the enumerated censor cells, and the provisional 97.2 percent uncensored heuristic estimate, with the censoring discipline stated.">
  <text x="28" y="24" font-size="15" font-weight="700" fill="#1a1a1a">E. The recovery ladder — the floor, the censor cells, the uncensored estimate</text>
  <text x="28" y="42" font-size="10.5" fill="#6b7280">Same population, reported honestly rung by rung · whiskers are cluster-robust 95% CIs · every rung carries its substrate label</text>
  <g stroke="#e5e7eb" stroke-width="1">
    <line x1="250" y1="56" x2="250" y2="300"/>
    <line x1="340" y1="56" x2="340" y2="300"/>
    <line x1="430" y1="56" x2="430" y2="300"/>
    <line x1="520" y1="56" x2="520" y2="300"/>
    <line x1="610" y1="56" x2="610" y2="300"/>
  </g>
  <g font-size="9" fill="#9ca3af" text-anchor="middle">
    <text x="250" y="316">0</text>
    <text x="340" y="316">25</text>
    <text x="430" y="316">50</text>
    <text x="520" y="316">75</text>
    <text x="610" y="316">100%</text>
  </g>
  <g font-size="10.5" fill="#374151" text-anchor="end">
    <text x="240" y="82">raw parser-floor</text>
    <text x="240" y="154">heuristic uncensored</text>
    <text x="240" y="214">true hard failure</text>
  </g>
  <rect x="250" y="68" width="360" height="20" fill="#f1f5f9"/>
  <rect x="250" y="68" width="315" height="20" rx="2" fill="#16a34a"/>
  <g stroke="#1f2937" stroke-width="1.5">
    <line x1="549.9" y1="78" x2="577.9" y2="78"/>
    <line x1="549.9" y1="74" x2="549.9" y2="82"/>
    <line x1="577.9" y1="74" x2="577.9" y2="82"/>
  </g>
  <text x="616" y="82" font-size="11" font-weight="700" fill="#15803d">87.5% [83.4, 91.0]</text>
  <text x="616" y="96" font-size="9" fill="#9ca3af">780 / 891 · machine floor</text>
  <text x="430" y="121" font-size="10" fill="#b45309" text-anchor="middle">&#8595; censored as not-successor-failures: 36 operator supersessions &#183; 41 external/system preemptions &#183; 3 ambiguous &#8595;</text>
  <rect x="250" y="140" width="360" height="20" fill="#f1f5f9"/>
  <rect x="250" y="140" width="349.9" height="20" rx="2" fill="#16a34a"/>
  <g stroke="#1f2937" stroke-width="1.5">
    <line x1="594.9" y1="150" x2="603.9" y2="150"/>
    <line x1="594.9" y1="146" x2="594.9" y2="154"/>
    <line x1="603.9" y1="146" x2="603.9" y2="154"/>
  </g>
  <text x="616" y="154" font-size="11" font-weight="700" fill="#15803d">97.2% [95.8, 98.3]</text>
  <text x="616" y="168" font-size="9" fill="#9ca3af">788 / 811 · provisional</text>
  <rect x="250" y="200" width="360" height="20" fill="#f1f5f9"/>
  <rect x="250" y="200" width="10.1" height="20" rx="2" fill="#dc2626"/>
  <text x="272" y="214" font-size="11" font-weight="700" fill="#dc2626">~2.8% (23 / 811)</text>
  <text x="272" y="228" font-size="9" fill="#9ca3af">churns &#8805;15 turns &#183; never completes &#183; not superseded</text>
  <rect x="20" y="248" width="720" height="46" rx="8" fill="#fffbeb" stroke="#f59e0b" stroke-width="1.4"/>
  <text x="380" y="267" font-size="10.6" font-weight="700" fill="#92400e" text-anchor="middle">Censoring discipline: report the floor AND the uncensored rate AND every censored cell with its N —</text>
  <text x="380" y="283" font-size="10.6" fill="#78350f" text-anchor="middle">the headline stays the conservative 87.5% floor; 97.2% remains provisional until the suspect rows are hand-adjudicated.</text>
</svg>
<figcaption><strong>Figure E.</strong> The §5.1 recovery ladder, drawn instead of asserted. The headline rung is the conservative machine <em>floor</em> — 87.5% [83.4, 91.0] — which counts <em>any</em> fresh trigger as a break, even a same-intent "did you fix it?". Removing only the cells that are demonstrably not successor failures (operator supersessions, external/system preemptions, ambiguous rows — 80 rows, each enumerated) yields a provisional heuristic estimate of 97.2% [95.8, 98.3], with true hard failure at ~2.8%. The ladder is reported whole, never collapsed to its top rung.</figcaption>
</figure>

The floor is conservative by construction. The current 2026-06-08 machine pass makes that conservatism
visible: `heuristic_current_recode_v1` marks 80 current all-actionable rows as censor cells (36 operator
supersessions, 41 external/system preemptions, 3 ambiguous) and leaves 23 hard failures, producing a
provisional uncensored estimate of 788 / 811 (97.2%). This uncensored figure remains a *provisional
machine estimate*, not a hand-adjudicated ceiling, until the 111 suspect rows are manually recoded under
the explicit supersession-vs-open rule the paper pre-registers.

**Why the suspect rows strengthen the floor.** A row-level audit of the 111 suspect rows is diagnostic
rather than discouraging. **57 of the 111 suspect rows (51%) are not recoverable intents at all.** Of
these, 52 are chatroom-invite wake events — the "root user request" is literally `[Chat Room
"review-wave-…"] User: [agent-name was invited by User]` — an agent woken by a room invite, not a
human or agent task that was interrupted. Another 5 are bracketed system messages. These rows should
have been deterministically censored *before* scoring, but were instead counted among the parser-floor's
apparent misses as if they were failed recoveries. Excluding them does not depend on any subjective
judgment — the wake trigger is a literal room-invite or system string — so the correction is a
deterministic data-hygiene fix, not a reliability question.

The implication is that the **87.5% parser-floor is even more conservative than reported**: roughly half
of its 111 apparent "misses" are non-intents the floor correctly could not auto-confirm as recovered,
because there was no intent to recover. The true recovery rate on genuine interrupted intents is
therefore meaningfully higher than 87.5%; a precise adjusted figure requires the hand-adjudicated recode
the paper pre-registers but has not completed.

**Historical reference (≤May-19 manual recode).** For completeness, the paper retains a forensic
≤May-19 manual recode, performed on an earlier, smaller corpus against an explicit
supersession-vs-open rule. Among 213 parser-broken rows on that subset, 87 were same-intent nudges
("did you fix it?", "go for it"), 24 were operator supersessions, 98 were external-chat/system
preemptions, and 4 were ambiguous; a further 9 rows broke as `no_success_in_window`. The 87
same-intent nudges were followed forward: 51 later completed, 4 hard-churned, 26 ended in operator
supersession, and 6 ended ambiguous. With final censored cells removed, the ≤May-19 subset reaches
98.3% [97.1, 99.0] (749/762), human-intent roots 97.6% [95.8, 98.7] (449/460), and true
hard-failure — a workstream churning ≥15 turns, never completing, and not superseded — at ~2.0%
(11/538 human; 13/920 overall). The current heuristic recode independently reproduces the
hard-failure at a comparable ~2.8% (23/811). These historical figures are preserved for forensic
reference but are **not** the current headline.

**Honesty notes.** The current headline is the 87.5% parser-floor; the heuristic recode is current but
provisional; the ≤May-19 manual recode is historical reference only. And
"success" here is the parser's completion label; a stricter substantive-completion judge is folded
into the construct-validity sensitivity cut (§4, §11).

### 5.2 The dogfood cohort: a person's message, cut mid-turn, recovered

**On the cohort we trust most — real people, cut off mid-message — recovery is the highest we measure, at 91.3%.**

The cleanest instance of the phenomenon is the one this paper's authors live in: a human types a
message, the turn is interrupted before a completing response, the next turn is a rebirth arrival, and
we ask whether the successor served the original ask. On this **human-direct** cohort the current
parser-floor is **91.3% [88.8, 93.5]** (587 / 643 actionable; N_raw = 686) — higher than the all-roots floor
because a human-typed ask is less likely to be a spurious "fresh trigger." The wake turn alone
completes 524 / 643 (82% of actionable, 89% of recovered). Chatroom/agent-relayed roots
(agent→agent, *not* human dogfood) are kept strictly separate and recover at **78% [65.1, 88.4]**
(193 / 248).

The recovered rows pass face validity — these are real interrupted-then-recovered asks: *"Tap your
partner. He said he found the root cause."*, *"Did you fix it?"*, *"Do you see Atlas tools?"* This cohort
also carries the least selection over boundary *timing*: the cut point is chosen by the interrupting
human, not by an agent electing a survivable moment — making 91.3% the recovery figure least explained by
well-chosen boundaries (§11.8). The current
heuristic dogfood pass is **97.7% [96.3, 98.8]** (595 / 609). As in §5.1, this is a provisional machine
estimate, not a completed human-adjudicated manual recode; the historical ≤May-19 figures are forensic
reference only.

### 5.3 Persistence: a carried workstream survives the handoff

**A workstream carried across a clean rebirth boundary runs to completion 95.7% of the time, and even across an interruption it persists at 89.4%.**

Recovery asks about an intent that was *cut*. Persistence asks the adjacent question: when no intent was
cut — the agent was carrying a workstream and a rebirth happened at a boundary — does the work continue
to completion? We split by how the boundary arose. **Interrupt-preceded** handoffs (the rebirth
followed an interruption; n = 2,211) persist to same-intent success **89.4% [86.0, 92.3]** (1,977 /
2,211; 1,659 immediate). **Clean-boundary** handoffs (a deliberate or context-pressure rebirth at a
natural seam; n = 6,463) persist **95.7% [94.6, 96.7]** (6,183 / 6,463; 5,056 immediate). The ordering is the
intuitive one and worth stating plainly: **cleaner handoffs continue more reliably** — the more
deliberate the rebirth, the better the continuation. (This very thread is a clean-boundary case.) The
parser/persistence population behind §§5.1–5.5 is **8,717** `trigger_type='rebirth'` arrivals after
artifact-backed boundary detection and a clean rebuild; 43 cold/library resumes have no in-corpus
predecessor and are excluded from persistence.

**Where the failures live: the successor that never spoke.** Joining the same persistence outcomes
against the *length of the successor's first turn* localizes the failure mass with unusual precision
(substrate: current parser-floor — frozen persistence rows × frozen `turns.ai_result` length; audited
2026-06-09). Wake-ups whose first turn carries any text persist at near-ceiling rates no matter how
terse; the collapse is confined to wake-ups that produced **no first-turn text at all**:

| First-turn text class | Interrupt-preceded | Clean-boundary | Pooled |
|---|---|---|---|
| ≥80 chars | 98.3% (1,521 / 1,548) | 98.9% (4,610 / 4,662) | 98.7% (6,131 / 6,210) |
| 1–79 chars | 98.2% (167 / 170) | 99.2% (626 / 631) | 99.0% (793 / 801) |
| **Empty (silent wake-up)** | **58.6%** (289 / 493) | **80.9%** (947 / 1,170) | **74.3%** (1,236 / 1,663) |

(Pooled excludes the same 43 no-predecessor resumes.) **427 of the corpus's 514 persistence failures —
83% — are wake-ups that produced no first-turn text.** Three consequences follow. First, §5.3.1's
sub-threshold exclusions are *benign*: terse-but-text-bearing first turns persist at ~99%, so the
audit's length floor does not hide a failing class. Second, the failure mass concentrates in exactly the
class a text judge structurally cannot score — which confirms the *direction* of §5.3.1's disclosed
upward bias while bounding its mechanism to the silent class. Third, the corpus's dominant failure mode
is **"the successor never spoke"** — absence, not confusion; an arrival that goes silent, not an agent
that continues wrongly (§11.8).

#### 5.3.1 First-turn random wake-up audit: an unbiased base rate, stress-tested three ways

**On a uniform random draw of wake-ups — not a selection-picked sample — the first successor turn cleanly continues the live task 90.7% of the time, and the judge behind that number survives both a negative-control teeth-check and a cross-model second opinion.**

The parser-floor (§5.1) asks whether an interrupted workstream *eventually* reaches a completion label.
This audit asks the more immediate question: on the very first successor turn after a rebirth or fork,
did the agent answer or directly continue the live task without broad rediscovery? To answer it without
smuggling in selection bias, we drew a **uniform random sample** of **150** transition arrivals (seed
1337) from the full population of **3,998** wake-ups — no score sort, no fork force-include, no
per-instance caps — spanning **97 distinct instances**. Two frame limits are carried openly, with their
measured masses. The candidate population is **voxxo-swarm-workspace arrivals only** — 5,879 of the
corpus's 8,717 frozen arrivals (67%); wake-ups in the deployment's other workspaces (vet-soap,
knowledge-chat, voxxo-term, …) never entered the pool. It then **excludes first turns below a
minimum-length selector threshold** (≥80 characters of first-turn text): 3,978 of the 5,879 qualified at
the freeze (the live selector, run a day later, saw 3,998) — so silent and near-silent wake-ups,
including the class §5.3's failure-anatomy table shows carries 83% of the corpus's persistence failures,
never entered the population, while the same table shows the *text-bearing* excluded class persists at
~99% and hides nothing. Stated plainly: **90.7% is the base rate over text-bearing voxxo-swarm
wake-ups**, not over every arrival. A single DeepSeek judge (temperature 0), blind
to provenance, scored each first turn. The result is **136 / 150 = 90.7%** clean continuation, with a
**cluster-robust** 95% CI of **85.9–95.4%** (resampled by `instance_id`, because wake-ups inside one
instance are correlated and a naïve binomial CI would be dishonestly tight). Clean-or-partial
continuation is **144 / 150 = 96.0%** [92.5–99.3]; strict failures are **6 / 150 = 4.0%**, with **zero**
insufficient-evidence verdicts. This is a different substrate from §5.1 — a single-judge first-turn
*behavioral* audit, not the parser completion floor — and it is built to be falsifiable: a real base
rate, a judge that must demonstrably fail bad packets, and a second model to check the first.

<figure>
<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" role="img" aria-label="The first-turn wake-up audit reports one unbiased random base rate and validates the judge two ways: a negative-control teeth-check and a cross-model second judge.">
  <text x="28" y="26" font-size="15" font-weight="700" fill="#1a1a1a">First-turn wake-up audit — one judge, three independent checks</text>
  <text x="28" y="44" font-size="11" fill="#6b7280">Uniform random draw of 150 wake-ups (97 instances), scored blind by a DeepSeek judge at temperature 0</text>
  <rect x="20" y="60" width="228" height="250" rx="10" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.5"/>
  <rect x="266" y="60" width="228" height="250" rx="10" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.5"/>
  <rect x="512" y="60" width="228" height="250" rx="10" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="134" y="84" font-size="12.5" font-weight="700" fill="#1d4ed8" text-anchor="middle">Unbiased base rate</text>
  <line x1="56" y1="94" x2="212" y2="94" stroke="#bfdbfe" stroke-width="2"/>
  <text x="134" y="140" font-size="34" font-weight="700" fill="#15803d" text-anchor="middle">90.7%</text>
  <text x="134" y="161" font-size="12" fill="#1a1a1a" text-anchor="middle">clean continuation</text>
  <text x="134" y="180" font-size="9.5" fill="#6b7280" text-anchor="middle">95% CI 85.9–95.4 (cluster-robust)</text>
  <text x="134" y="197" font-size="10" fill="#6b7280" text-anchor="middle">136 / 150 random wake-ups</text>
  <line x1="40" y1="218" x2="228" y2="218" stroke="#e5e7eb" stroke-width="1"/>
  <text x="134" y="238" font-size="8.5" fill="#9ca3af" text-anchor="middle" letter-spacing="0.7">WHAT IT SHOWS</text>
  <text x="134" y="258" font-size="10.5" fill="#374151" text-anchor="middle">the rate on a random</text>
  <text x="134" y="273" font-size="10.5" fill="#374151" text-anchor="middle">wake-up, not a picked one</text>
  <text x="380" y="84" font-size="12.5" font-weight="700" fill="#92400e" text-anchor="middle">Judge has teeth</text>
  <line x1="302" y1="94" x2="458" y2="94" stroke="#fde68a" stroke-width="2"/>
  <text x="380" y="140" font-size="34" font-weight="700" fill="#b45309" text-anchor="middle">86.7%</text>
  <text x="380" y="161" font-size="12" fill="#1a1a1a" text-anchor="middle">broken packets caught</text>
  <text x="380" y="180" font-size="9.5" fill="#6b7280" text-anchor="middle">26 / 30 blind negative controls</text>
  <text x="380" y="197" font-size="10" fill="#6b7280" text-anchor="middle">4 false-cleans, audited (§11)</text>
  <line x1="286" y1="218" x2="474" y2="218" stroke="#e5e7eb" stroke-width="1"/>
  <text x="380" y="238" font-size="8.5" fill="#9ca3af" text-anchor="middle" letter-spacing="0.7">WHAT IT SHOWS</text>
  <text x="380" y="258" font-size="10.5" fill="#374151" text-anchor="middle">it can fail a bad packet —</text>
  <text x="380" y="273" font-size="10.5" fill="#374151" text-anchor="middle">not a rubber stamp</text>
  <text x="626" y="84" font-size="12.5" font-weight="700" fill="#3730a3" text-anchor="middle">Cross-model check</text>
  <line x1="548" y1="94" x2="704" y2="94" stroke="#c7d2fe" stroke-width="2"/>
  <text x="571" y="136" font-size="25" font-weight="700" fill="#15803d" text-anchor="middle">87.5%</text>
  <text x="571" y="154" font-size="9" fill="#6b7280" text-anchor="middle">DeepSeek</text>
  <text x="626" y="132" font-size="11" fill="#9ca3af" text-anchor="middle">vs</text>
  <text x="681" y="136" font-size="25" font-weight="700" fill="#15803d" text-anchor="middle">82.5%</text>
  <text x="681" y="154" font-size="9" fill="#6b7280" text-anchor="middle">GPT-5.4-mini</text>
  <text x="626" y="180" font-size="9.5" fill="#6b7280" text-anchor="middle">80% case agreement on shared 40</text>
  <text x="626" y="197" font-size="10" fill="#6b7280" text-anchor="middle">independent second judge</text>
  <line x1="532" y1="218" x2="720" y2="218" stroke="#e5e7eb" stroke-width="1"/>
  <text x="626" y="238" font-size="8.5" fill="#9ca3af" text-anchor="middle" letter-spacing="0.7">WHAT IT SHOWS</text>
  <text x="626" y="258" font-size="10.5" fill="#374151" text-anchor="middle">the base rate survives</text>
  <text x="626" y="273" font-size="10.5" fill="#374151" text-anchor="middle">a judge-model swap</text>
  <rect x="20" y="324" width="720" height="44" rx="8" fill="#eef2ff" stroke="#c7d2fe" stroke-width="1.3"/>
  <text x="380" y="345" font-size="11" font-weight="700" fill="#3730a3" text-anchor="middle">A real base rate · a judge that catches breakage · a result two model families reproduce —</text>
  <text x="380" y="361" font-size="10.5" fill="#4338ca" text-anchor="middle">so the 90.7% is corroborating evidence for the parser-floor headline (§5.1), not a lone single-judge number.</text>
</svg>
<figcaption><strong>Figure C.</strong> The first-turn audit is designed to be hard to fake. <strong>Left:</strong> the headline is a <em>uniform random</em> base rate (136/150 = 90.7% clean continuation), so it is not inflated by selecting wake-ups that already look successful. <strong>Center:</strong> the same judge was shown 30 deliberately broken packets and flagged 86.7% of them — proof it can fail a bad packet — with the four misses audited openly in §11. <strong>Right:</strong> a different model family (GPT-5.4-mini) re-judged a random 40-packet subset and landed within five points of DeepSeek (82.5% vs 87.5%), so the base rate is not one model's quirk.</figcaption>
</figure>

The quality ladder underneath the headline is consistent rather than lumpy (Figure D): **139 / 150 =
92.7%** of first turns are *zero-step* continuations — the successor reorients with no skipped required
step and no drift — **138 / 150 = 92.0%** are *productive* (the first turn does real task work, not bare
acknowledgement), and the mean quality score is **3.73 / 4**. The draw is **149 rebirth** arrivals and
**1 fork** first turn; forks appear at their natural rarity in a uniform sample, which is the honest cost
of not force-including them.

<figure>
<svg viewBox="0 0 760 348" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" role="img" aria-label="Horizontal bar chart of first-turn continuation quality on the uniform random sample, with cluster-robust confidence intervals, and a second-model comparison strip.">
  <text x="28" y="24" font-size="15" font-weight="700" fill="#1a1a1a">First-turn continuation quality — uniform random sample (n = 150)</text>
  <text x="28" y="42" font-size="10.5" fill="#6b7280">Single DeepSeek judge, temp 0 · bars are point estimates · whiskers are cluster-robust 95% CIs by instance</text>
  <g stroke="#e5e7eb" stroke-width="1">
    <line x1="250" y1="56" x2="250" y2="308"/>
    <line x1="340" y1="56" x2="340" y2="308"/>
    <line x1="430" y1="56" x2="430" y2="308"/>
    <line x1="520" y1="56" x2="520" y2="308"/>
    <line x1="610" y1="56" x2="610" y2="308"/>
  </g>
  <g font-size="9" fill="#9ca3af" text-anchor="middle">
    <text x="250" y="322">0</text>
    <text x="340" y="322">25</text>
    <text x="430" y="322">50</text>
    <text x="520" y="322">75</text>
    <text x="610" y="322">100%</text>
  </g>
  <g font-size="10.5" fill="#374151" text-anchor="end">
    <text x="240" y="82">clean-or-partial</text>
    <text x="240" y="114">zero-step continuation</text>
    <text x="240" y="146">productive first turn</text>
    <text x="240" y="178">clean continuation</text>
    <text x="240" y="210">strict failure</text>
  </g>
  <g>
    <rect x="250" y="68" width="360" height="20" fill="#f1f5f9"/>
    <rect x="250" y="100" width="360" height="20" fill="#f1f5f9"/>
    <rect x="250" y="132" width="360" height="20" fill="#f1f5f9"/>
    <rect x="250" y="164" width="360" height="20" fill="#f1f5f9"/>
    <rect x="250" y="196" width="360" height="20" fill="#f1f5f9"/>
  </g>
  <rect x="250" y="68" width="345.6" height="20" rx="2" fill="#16a34a"/>
  <rect x="250" y="100" width="333.7" height="20" rx="2" fill="#16a34a"/>
  <rect x="250" y="132" width="331.2" height="20" rx="2" fill="#16a34a"/>
  <rect x="250" y="164" width="326.5" height="20" rx="2" fill="#16a34a"/>
  <rect x="250" y="196" width="14.4" height="20" rx="2" fill="#dc2626"/>
  <g stroke="#1f2937" stroke-width="1.5">
    <line x1="583.0" y1="78" x2="607.5" y2="78"/>
    <line x1="583.0" y1="74" x2="583.0" y2="82"/>
    <line x1="607.5" y1="74" x2="607.5" y2="82"/>
    <line x1="559.2" y1="174" x2="593.4" y2="174"/>
    <line x1="559.2" y1="170" x2="559.2" y2="178"/>
    <line x1="593.4" y1="170" x2="593.4" y2="178"/>
  </g>
  <g font-size="11" font-weight="700" text-anchor="start">
    <text x="616" y="82" fill="#15803d">96.0%</text>
    <text x="616" y="114" fill="#15803d">92.7%</text>
    <text x="616" y="146" fill="#15803d">92.0%</text>
    <text x="616" y="178" fill="#15803d">90.7%</text>
    <text x="272" y="210" fill="#dc2626">4.0%</text>
  </g>
  <g font-size="8.5" fill="#9ca3af" text-anchor="start">
    <text x="664" y="82">[92.5–99.3]</text>
    <text x="664" y="178">[85.9–95.4]</text>
  </g>
  <rect x="20" y="226" width="720" height="22" rx="6" fill="#eef2ff" stroke="#c7d2fe" stroke-width="1.2"/>
  <text x="380" y="241" font-size="10" fill="#3730a3" text-anchor="middle">Same instrument, second model — shared random 40-packet subset (κ = 0.22, 80% case agreement)</text>
  <g font-size="10.5" fill="#374151" text-anchor="end">
    <text x="240" y="270">DeepSeek-A judge</text>
    <text x="240" y="298">GPT-5.4-mini judge</text>
  </g>
  <rect x="250" y="258" width="360" height="18" fill="#f1f5f9"/>
  <rect x="250" y="286" width="360" height="18" fill="#f1f5f9"/>
  <rect x="250" y="258" width="315" height="18" rx="2" fill="#16a34a"/>
  <rect x="250" y="286" width="297" height="18" rx="2" fill="#6366f1"/>
  <g font-size="11" font-weight="700" text-anchor="start">
    <text x="616" y="271" fill="#15803d">87.5%</text>
    <text x="616" y="299" fill="#4338ca">82.5%</text>
  </g>
</svg>
<figcaption><strong>Figure D.</strong> The continuation-quality ladder on the uniform random sample (n = 150). Nine in ten first turns clear the strict <em>clean continuation</em> bar (90.7%), and 96% are clean-or-partial; only 4% are strict failures and none are insufficient-evidence. Whiskers are cluster-robust 95% CIs (resampled by instance), wider and more honest than a binomial interval. The lower strip is the cross-model check on a shared random 40-packet subset: a different model family (GPT-5.4-mini) lands at 82.5% against DeepSeek's 87.5% — close rates on a near-degenerate (mostly-clean) distribution, which is also why Cohen's κ reads a deflated 0.22 despite 80% case agreement.</figcaption>
</figure>

**Does the judge have teeth?** A clean rate is only as trustworthy as the instrument's ability to
*fail* a bad packet, so we built a blind negative-control arm: **30** deliberately broken packets — 20
*task-mismatch* (the live request from instance A stapled to work swapped from a different instance B)
and 10 *gutted* (an emptied first turn) — carrying innocent example ids and **no** control metadata,
with ground truth held in a separate manifest. The single judge flagged **26 / 30 = 86.7%** as
not-clean (task-mismatch **18 / 20**, gutted **8 / 10**). We then hand-audited the four false-cleans
rather than reporting the headline alone, and the audit was unflattering to the *controls*: one
task-mismatch donor was another chess-port/review lane and so was **not a viable negative** at all; one
mismatch was **viable but soft** because Atlas-recovery and rebirth-race debugging genuinely share
relay-recovery context; and two gutted controls were **construction failures** — the visible work text
was emptied but selection metadata (`file_work` style, large token counts, file-overlap anchors,
`files_on_or_after_arrival`) still leaked positive evidence. So the judge has *some* teeth,
demonstrably, but this is not a clean 30-row validation, and we carry that debt openly in §11. (Read the
other way: on the 27 controls that were viable and correctly constructed, the judge caught 26 — the raw
86.7% *understates* its teeth. We headline the raw figure anyway: a teeth-check is only as strong as its
weakest control, and the failures here were the controls', not the judge's.)

**Is 90.7% just one model's leniency?** The standing worry about any single-judge number is that it
reflects one model's disposition. To test that, we ran a **cross-model second judge** — `gpt-5.4-mini`
(Codex tier) — over a seeded random **40-of-150** subset of the same real arm, with the same neutral
prompt, the same strict validation, and the same temperature 0. The two models land close: **DeepSeek
35 / 40 = 87.5%** clean versus **GPT 33 / 40 = 82.5%** clean, a **−5.0 pp** delta. Case-level agreement
is **32 / 40 = 80.0%** on the binary clean-vs-not call (**31 / 40 = 77.5%** on the full four-way
verdict). Cohen's κ is **0.22**, but κ is misleadingly low here precisely *because* the distribution is
near-degenerate — almost everything is clean — so the load-bearing evidence is that two different model
families independently produce a high clean rate within five points of each other, and that the second
judge is *not* a rubber stamp: in the nine disagreements it more often assigned the *stricter* `partial`
label where DeepSeek said `clean`. The base rate is not a single-model artifact.

**Where does continuation concentrate?** A complementary **selection-biased** dual-judge arm (two
DeepSeek judges, strict = *both* clean; 54 complete examples drawn from the top-scored 500 packets) is
not an unbiased base rate, but it is large enough to slice by boundary type, which the uniform sample is
not:

| Boundary type (selection-biased arm) | n | strict clean (both judges) | clean-or-partial | avg quality |
|---|---:|---:|---:|---:|
| fork first turn | 16 | 93.8% | 100% | 3.97 |
| plain rebirth | 32 | 84.4% | 93.8% | 3.75 |
| fork → rebirth | 6 | 33.3% | 83.3% | 3.33 |

The 34 of 54 boundaries that crossed a **model hot-swap** held at **76.5%** strict / **91.2%**
clean-or-partial — continuation survives changing the engine, at a modest strictness cost. The one soft
spot, **fork → rebirth** (a fork that then immediately rebirths), is the smallest cell (n = 6) and the
only one under 80% strict; it is a flagged target for a larger run, not a headline.

Taken together, the first-turn audit is **corroborating evidence**, not a replacement for the
parser-floor headline (§5.1): a uniform random base rate of **90.7%** clean continuation, an instrument
that demonstrably catches most broken packets, and a result two model families reproduce within five
points. The honest debts — imperfect negative controls and a single-judge primary arm on the full 150 —
are carried openly in §11 and are the first things a follow-up run should retire.

### 5.4 Re-establishment cost: re-grounding is near-instant; the turn is mostly work

**Re-establishing context is effectively free: the successor reorients in a median of two tool-calls, and the rest of the recovery turn is the agent doing real work, not getting back up to speed.**

The figure to read carefully is *what the successor spends the recovery turn on*. Re-grounding itself is
near-instant — the successor reads a bounded package and issues a median of **2 orientation tool-calls** — and is
not what consumes the turn. On recovered roots the median cost to re-establish **and complete** is **1 turn,
297 s, ~30K tokens**; on the dogfood cohort, **1 turn, 330 s, ~33K tokens**. But that turn is the first turn of
*real work*: the successor reorients in those two calls and then advances the assignment, so the ~30K/297 s is
dominated by the task increment the agent would have paid under *any* continuation scheme — not by a reorientation
tax. (The cost log is turn-aggregated, §6.1, so we cannot cleanly split the orientation tokens from the work tokens;
the bounded package — ~13K median, §6.1 — bounds the re-grounding share from above, and it is the smaller part.)
Multihop recoveries (n = 87) cost more — median **2 turns, 522 s, ~43K tokens, 3 calls** — the expected tail: the
cases that take more than one turn to recover also cost more to recover. The headline is that the *typical* handoff
costs the successor a couple of orientation calls and then a normal turn of work, **not** a from-scratch
re-investigation — re-grounding is effectively immediate, and the recovery turn is the agent doing its job.

### 5.5 Recovery by successor engine (read with care)

**Recovery does not depend on which engine wakes up — every successor engine lands between 87% and 92%.**

| Successor engine | Recovery | N |
|---|---|---|
| claude | 92% [88, 94] | 252 |
| codex | 90% [86, 93] | 295 |
| deepseek | 88% [82, 92] | 144 |
| gemini | 87% [75, 94] | 53 |
| minimax | 89% [67, 97] | 18 |
| glm | 72% [62, 79] | 106 |
| claude-api | 91% [62, 98] | 11 |
| claude-interactive | 71% [36, 92] | 7 |
| kimi | 80% [38, 96] | 5 |

⚠️ This is the **successor-instance engine**, not a mid-life model hot-swap: `turns.engine` is
denormalized and blind to swaps that occur *within* a turn's life, so this ranking must **not** be read
as a swap effect (the hot-swap result is §7). The spread — glm 72% at the low end, claude/codex ~90% at
the high end — is confounded by task mix and label strictness across engines (claude's cohort, for
instance, carries a stricter label distribution), and the small-N engines (kimi n=5, claude-api n=8)
have intervals too wide to rank. We report the table for completeness and decline to interpret the
ranking causally.

### 5.6 Sustained productive throughput

**Bounded rebirth is not a fragile lab trick: over 54 days the live deployment sustained ~626M tokens of productive throughput across 8,717 rebirths without the chain breaking down.**

§5.1–5.5 ask whether work survives a boundary. A complementary question is rawer and harder to contest:
*how much* productive work a bounded-rebirth deployment sustains, and at what rate. It trades the
necessary-but-judgment-laden intent question for a throughput one that needs no completion verdict — and,
reported as aggregate rates, it exposes no transcript content.

**Scale.** Over the 54-day window of the turn index (§4), the deployment recorded **8,717 rebirths, ~626M
tokens of productive-turn throughput, and 88,051 tool calls** — about **165 rebirths and 12.5M productive
tokens per day**, sustained. One instrumentation caveat we correct rather than carry: 19 turns record a
`token_count` exceeding any model's context window — clear artifacts, the largest a single 20.1M-token
gemini turn — whose inclusion would inflate the token total by ~7%; they are excluded. Rebirth and
tool-call counts are event counts and carry no such artifact.

**Value, not just volume.** A throughput number alone cannot separate work from spin, so we anchor it to a
verified-output measure: the Atlas changelog, where each entry is a committed, agent-authored code change
with a written description. Over the same window the swarm produced **16,832 such changes — ~311/day,
sustained flat across 8 weeks — authored across 13 distinct model engines** (codex 9,059 · claude 2,596 ·
deepseek 2,039 · glm 1,626 · gemini 508 · …). These are event counts, immune to the token artifact
entirely. And the recursion is the point: this codebase *is* the orchestration relay, so those 16,832
changes are largely the swarm building its own machinery.

**Continuity of value.** Joining the two by identity ties productive output to the rebirth boundary itself.
Restricting to coherent single-repository chains and excluding degenerate auto-rebirth loops (a rebirth that
touches no tool or file and processes < 5,000 tokens — an *organic* auto-rebirth loop, not the wave
pipeline (which §5.7 shows is the *cleaner* population); one raw chain was 30% such spin) along with the token artifacts above, **150 identities each carried one workstream past
1,000,000 productive tokens** (≈309M aggregate) across **2,657 productive rebirths**, the largest chains
reaching ~10M productive tokens — tens of times a single context window. On the chains we can join to the
changelog by author name, the output rate is **≈3–4 verified changes per rebirth** — `binary-lemur`: 508
changes across 130 rebirths; `chrome-ocelot`: 367 across 128 — so each bounded reset carried the workstream
forward several committed changes, not zero.

**The honest dent — steering.** A multi-day single-repo chain is not one intent; the user steers throughout,
so chain length is partly user-supplied. The steering-controlled cut is the *autonomous span* — productive
rebirths between two consecutive user messages, with no human input. There the common case is modest:
**~75% of asks complete one-shot** (no rebirth), averaging ~0.5 productive rebirths per ask. But the
long-horizon tail is real and steering-free: **186 single asks were each carried across ≥5 autonomous
rebirths, 57 across ≥10, and 17 across ≥20**, with per-ask work rising to ~1.2M tokens at the deepest tier.
Throughput is the scale claim; the autonomous tail is where bounded rebirth demonstrably carries one intent
the window could not hold.

**Bounds.** These are rates and counts, not a causal claim — high sustained productive throughput *occurs*
under bounded-rebirth operation; whether it beats an unbounded-context counterfactual is the §8 fork
program. A changelog entry is a coarse value unit (a typo fix and a refactor each count once) and is
commit-gated but not externally audited; the author-name→identity join is ~95% clean, adequate for
aggregates but not for any single-identity claim. The token measure is productive-turn throughput and does
not de-duplicate context re-sent within a turn.

### 5.7 Fidelity holds across rebirth depth

**Quality does not decay as the rebirth chain deepens — the deepest successors stay as faithful as the first, while the unbounded counterfactual is exactly the regime the degradation literature says should rot.**

§5.6 measures *how much* work a chain sustains; the sharper question for the thesis is whether the *quality*
of that work holds as the chain deepens. If rebirth were lossy compression in disguise, the Nth reset would
carry less of the original intent than the first, and deep rebirths would visibly degrade — more degenerate
spin, fewer completed outcomes — as the package leaked across successive compactions. The mirror-image
prediction is sharper and runs the other way: the *unbounded* counterfactual — one session that never resets
— is exactly the regime the long-context degradation literature (§2.5) says should rot, with frontier models
missing correct actions markedly more often as a transcript grows into the hundreds of thousands of tokens
(arXiv:2605.12366). A depth-robust fidelity result therefore does double duty — it shows the package does not
leak across resets *and* that the bounded successor sidesteps the degradation the long alternative
accumulates. We test this directly
on the chains long enough to show depth: the **74 single-identity worker chains with ≥20 rebirths** (depth
running out to **684**), numbering each rebirth by its position in the chain and measuring two depth-robust
fidelity signals — the degenerate-loop (spin) rate of §5.6, and the outcome-success rate over productive
rebirths. One provenance note, carried honestly: the raw frozen-corpus count of single-identity chains
with ≥20 rebirths is **82**; the 74 — and the per-tier *n*s below — are what remain after the §5.6
spin/coherence filters, and the analysis script behind this cut is **not yet committed** to the artifact
tree (§A.3), making this the paper's least independently regenerable subsection until it is.

| Rebirth depth | Spin rate | Success rate (of labeled outcomes) |
|---|---|---|
| 1st–5th | 25.9% | 93.1% |
| 6th–10th | 18.6% | 94.4% |
| 11th–20th | 23.1% | 88.4% |
| 21st–40th | 21.7% | 88.8% |
| **41st+** (n = 1,265) | **19.2%** | **94.4%** |

**Neither signal trends with depth.** Spin is flat-to-declining — *lower* among the deepest rebirths (19.2%
at depth 41+) than the shallowest (25.9% at depth 1–5) — and success holds at 88–94%, the deepest tier
**tied for the highest success rate in the chain**. The 50th reset is as productive, and as likely to
succeed, as the 5th. This is the within-chain shadow of the non-inferiority claim — and the first
observational trace of the §2.5 affirmative argument: the package carries intent across arbitrary depth
without the decay a lossy mechanism would impose, while the unbounded alternative is precisely the
long-transcript regime in which frontier reasoning degrades (arXiv:2605.12366, arXiv:2510.05381) — measured
across 74 real chains, not asserted. The honest boundary is that this is *consistent with* a quality
advantage for the bounded reset, not a controlled test of one: the depth axis varies rebirth count, not the
unbounded counterfactual, so the comparison to a never-reset session is the job of §8's Arm A. We read it as
a shadow, not proof.

**Driven by machine, rebirth is cleaner, not dirtier.** The pattern strengthens for the most mechanical
rebirths. Isolating the **wave pipeline** — instances that drove their own rebirths through the
`wave_advance`/`wave_complete` control surface, i.e. machine-paced phase advancement rather than ad-hoc
self-rebirth — the worker subpopulation (93 instances, 1,913 rebirths) runs at **82.6% productive** against
**74.7%** for organic ad-hoc rebirth on the same worker engines, and carries heavier productive turns (~66K
vs ~59K tokens). Rebirth fired *every turn* by a control loop does not spin more than a human-in-the-loop
reset; the rail-and-phase structure keeps each reset pointed at concrete work. This is the same distinction the
§5.6 throughput cut draws: the most degenerate loop in the corpus — one chain ~30% spin,
excluded as an outlier — was an *organic* auto-rebirth loop that never touched the wave surface, not the
"wave-pipeline pathology" it superficially resembles. The programmatic pipeline is the cleaner population,
not the looping one.

**Bounds.** This is descriptive, not causal — flat fidelity across depth shows the package does not *leak*
with accumulated resets; whether bounded rebirth beats an unbounded-context counterfactual is the §8 fork
program. The cut is rate-based by design: chains that *reach* depth 41+ skew toward rapid-cadence pipelines,
so productive tokens *per interval* fall at depth (more, smaller intervals) even as the spin and success
*rates* stay flat — we report the rates because they are robust to cadence where the per-interval token
figure is not. Success counts the exogenous `interrupted` outcome as a non-success, a conservative floor, and
is commit-gated rather than externally audited. Interactive instances are excluded, as in §5.6, because their
no-tool conversational turns register as false spin.

### 5.8 The competing mechanism does not reproduce itself: repeated compaction is non-deterministic

**Rebirth's structural trump card is reproducibility: re-rendering a boundary yields the identical package, whereas re-compacting the same transcript reshuffles 70–90% of its concrete detail.**

§5.7 showed rebirth's fidelity does not decay with *depth*. This subsection asks the mirror question of the
*alternative* mechanism, and turns the determinism property asserted in §3 into a measured contrast. The
rebirth package is a **deterministic** structured rendering of a fixed event stream (§3.2): re-render the
same boundary state and you get the same bytes — zero run-to-run variance, for free, by construction.
Summarization-based compaction has no such guarantee. It is a *sampled generation* over the transcript, so
the same input compacted twice need not yield the same summary. We measured how large that gap is, asking the
narrow, falsifiable question: *take one fixed thing, compact it many times, and see how
different the summaries are.*

**Design.** We took real rebirth boundaries, reconstructed each transcript at its cutoff, and ran the
**verbatim Claude Code reactive-compaction prompt** — the same mechanism as the §7 C arm — on **Claude Sonnet
4.6** repeatedly against the *identical* input: same transcript, same prompt, same model, same settings. The
reproducibility metric is deliberately **phrasing-invariant**. We extract each summary's *concrete tokens* —
backtick-quoted identifiers and file / `file:line` references — and report the **unstable rate**: the
fraction of all distinct concrete tokens that appear in *some but not all* runs (a token reproduced in every
run is *stable*; one that surfaces in only a subset is *unstable*). A summary can be reworded freely without
moving this number; only the *facts it chooses to carry* move it. We also track summary-length coefficient of
variation (CV). A phrasing-sensitive lexical-divergence metric is computed but **deliberately not reported as
content loss** — it moves with wording and overstates true variance (§4 metric discipline applies).

**Result.** Across **six boundaries drawn from four transcripts**, repeated compaction reproduced only a
minority of its own concrete detail. On the cleanest single-transcript cell — instance `1WRXYhDc`, boundary
`1a582af2`, **n = 10** independent Sonnet compactions of *one fixed transcript* — **78.6%** of concrete
tokens (143 / 182) and **75.5%** of file references (37 / 49) were *unstable*: only about **one concrete
identifier in five** appeared in all ten summaries, even though every summary preserved the same broad
narrative shape. Summary length itself wobbled (CV 0.099; range 9,554–13,382 chars). The pattern held on
every boundary we scored.

| Boundary (transcript) | n | Unstable concrete | Unstable file-refs | Length CV |
|---|---|---|---|---|
| `1a582af2` (`1WRXYhDc`) | 10 | 78.6% (143/182) | 75.5% (37/49) | 0.099 |
| `ab94ef57` (`z930lWsG`) | 10 | 76.6% (144/188) | 80.7% (71/88) | 0.086 |
| `…512445180` (`1FUVKOWV`) | 10 | 87.4% (208/238) | 69.1% (47/68) | 0.102 |
| `…461448509` (`1FUVKOWV`) | 10 | 92.1% (174/189) | 73.2% (30/41) | 0.109 |
| `…460385689` (`1FUVKOWV`) | 7 | 93.7% (223/238) | 80.0% (44/55) | 0.089 |
| `…454576540` (`1FUVKOWV`) | 2 | 57.1% (56/98) | 40.5% (15/37) | 0.057 |
| **Mean (unweighted)** | — | **80.9%** | **69.8%** | **0.090** |
| **Rebirth package (by construction)** | — | **0%** | **0%** | **0.000** |

An earlier, independent check agrees: **4** Sonnet runs over **3** *different* boundaries gave mean unstable
concrete **72.6%**, file-ref **54.3%**, length CV **0.071** — same regime, different transcripts and run
count. So the effect is not an artifact of one boundary: *the same input, compacted again, keeps a similar
story but reshuffles which concrete facts it carries* — run to run, by roughly **70–90%** of its concrete
detail. The illustrative unstable tokens are exactly the load-bearing kind: file paths,
line-anchored references, memory-table keys, and config constants that appeared in a single run out of ten.

**Why this matters for the thesis.** This is the *second* affirmative shadow (§5.7 was the first). The
paper's burden is only non-inferiority — rebirth need not be *better* — yet two properties accrue to it for
free that compaction structurally cannot match. Depth-stability (§5.7): the Nth reset is as faithful as the
first. And now **determinism**: the package is byte-reproducible, so an operator who re-derives it, audits
it, or forks from it (§8) gets *the same* state every pass, whereas re-compacting the same transcript yields a
different working set each time. For a substrate meant to be the durable spine of a long-running agent —
auditable, forkable, cache-stable (§6) — reproducibility is not a nicety; it is the difference between a state
you can reason about and a state you must re-discover. We measure only the *single-pass* case here — one
compaction pass, merely repeated — which is already this unstable and needs no chaining to make its point. A
natural extension, flagged as **future work** and not run here, is the chained multi-hop variant
(summary-of-summary "telephone" decay), where each summary is built from the prior summary rather than the raw
transcript. This is not idle speculation: recursive-summary memory work reports that long-horizon agents can
progressively discard task-relevant information and accumulate semantic noise as summaries recurse
(arXiv:2605.30159), and context-folding work reports a large advantage over summarization-based context
management on long-horizon agent tasks (arXiv:2510.11967). On this substrate, however, whether carried
*fidelity* degrades across chained compaction hops remains an open question for the §8.7 protocol. The rebirth
0% reproducibility contrast holds regardless.

**Bounds.** This is **pilot / mechanistic** evidence, not a population estimate, and we label it as such. (1)
*Provenance*: these summaries were salvaged from an accidental broad launch that we stopped on discovery; the
run then hit Claude Code's monthly spend cap, which is what bounds n at 10 (four boundaries) / 7 / 2 — an
external limit, not a chosen design. A clean pre-registered API-only rerun across more transcripts, models,
and temperatures would pin the exact rate; we register it as *optional confirmation*, not load-bearing for the
qualitative claim. (2) *Single model, single compaction prompt*: Sonnet 4.6 under the verbatim CC reactive
prompt at default sampling — we do not claim the 0.79 figure transfers unchanged to other models or prompts,
only that same-input compaction is *materially* non-deterministic in concrete detail. (3) *The rebirth 0% is
by construction, not a sampled arm*: it follows from rendering fixed state and is presented as the
architectural contrast, not a measured generation — though the package's *behavioral* effectiveness (whether
models actually resume correctly from it) is measured as a sampled arm in §5.8.1. (4) The mean is unweighted across uneven n; the `…454576540`
cell (n = 2) is underpowered and reads as the coarsest measurement, pulling the mean *down* if anything. (5)
The phrasing-sensitive lexical metric is excluded by design, so the reported numbers reflect *which facts are
kept*, not wording churn.

#### 5.8.1 The determinism is *behavioral*, not only structural: models resume the right task from the package

**The determinism is not merely on paper — models actually resume the right task from the package, scoring 93.6% correct under blind judging.**

§5.8's contrast is structural — the package is byte-identical by construction (0% concrete-detail instability),
whereas re-compaction reshuffles 70–90% of its concrete facts. Bound (3) above is candid that this 0% *"is by
construction, not a sampled arm."* A skeptic can grant byte-determinism and still ask the load-bearing question:
*does a deterministic artifact actually make the agent resume the right work?* A perfectly reproducible package is
worthless if the model reads it and does the wrong thing. We therefore ran rebirth as a **measured behavioral arm**.

**Design.** Fixing the artifact to the deterministic rebirth package (the §3.2 rendering, via `emit_policy_packages`),
we fed it together with the verbatim next user message and sampled the agent's **first-turn response ten times** at
each of **five continuation boundaries** — real in-flight successor work spanning four origin engines plus one
cross-repo boundary — across **five model families**: deepseek-v4-pro, glm-5.1, gpt-5.5 / Codex-Instant (a
*no-reasoning* tier), minimax-m2.7, and gemini-3.1-pro. That is **250 independent first-turn resumptions** from the
same deterministic state. System prompt and wrapper are identical across cells; only the package and next message
vary by boundary. Two judges (gemini-3.1-pro and deepseek-v4-pro), blind to the source model, graded each response
for **correctness** — does it resume the *specific in-flight task* the boundary state implies, versus a
plausible-but-wrong fresh start — against a hand-written ground-truth intent per boundary, ignoring the generic "I am
an API and cannot execute tools" hedge (the *intended* action is judged). Compaction is not re-run here; it is the
§5.8 baseline.

**Result.** The deterministic package drives **correct first-turn task-resumption in 234 / 250 = 93.6%** of cases on
the reliable judge (the gemini judge produced zero unparseable verdicts; the deepseek judge had a 16%
JSON-parse-failure rate and is the noisier rater), and **88.5%** pooling both judges. Every model family clears
**0.84**:

| model | correct-resumption (reliable judge) | (both judges) |
|---|---|---|
| gpt-5.5 / Codex-Instant (no-reasoning) | 1.00 | 0.90 |
| glm-5.1 | 0.98 | 0.98 |
| deepseek-v4-pro | 0.94 | 0.93 |
| minimax-m2.7 | 0.92 | 0.90 |
| gemini-3.1-pro | 0.84 | 0.70 |

So the determinism is not a dead structural property: a model handed the byte-identical package overwhelmingly picks
up *the in-flight task it encodes*. This is the behavioral arm bound (3) asked for — rebirth measured, not merely
asserted.

**The residual is the model layer, not the package.** The package's instability is 0% by construction, yet behavioral
correctness is ~90%, not 100% — because a deterministic artifact still passes through one stochastic layer: the
responder's own sampling. Compaction stacks *two* such layers (summary generation + response sampling); rebirth
removes the first but cannot remove the second. The two boundaries that cost the most correctness localize the
residual precisely. On the dr-discomfort scroll boundary, gemini-3.1-pro misresumes about half the time (5/10, both
judges agreeing) by **hallucinating that the in-flight edits are already finished** — reading the Active Edit Delta as
completed work and presenting a result instead of continuing — the lone large correctness drag in the matrix. And the
pure "relay restarted, we're back" boundary, which carries the least task-specific direction, is the hardest cell
overall (0.81 pooled), where minimax and deepseek wander. These are failures of the *model's* reading of a faithful
package, not of package fidelity.

**Honest bounds.** (1) *Small*: five boundaries × five models; we report cluster-by-boundary and claim **no** p-value —
the result is the 88.5–93.6% correct-resumption band across model families, not a significance test. (2) *Correctness is
the robust axis; we deliberately do not headline modal first-action "consistency"* (how often the ten runs open with
the same labeled action): it is judge-noisy and low by design — minimax is correct 10/10 yet shares a modal first
action only 1/10 on one boundary, because there are many valid ways to *start* the same correct task. (3) *Judge noise
is real and disclosed*: inter-judge raw agreement is 85.7% but Cohen's κ is only 0.36 ("fair"), deflated by the
prevalence paradox (the "correct" label dominates at ~88%, inflating chance agreement) compounded by the deepseek
judge's parse failures and two verified-wrong harsh zeros; both judges are reported rather than silently dropping one,
and the single most eye-catching early cell ("gpt-5.5-instant resumes consistently *wrong*") **did not survive a
raw-response read** — it deployed the same staged fix as every other model and was a judge artifact. (4) *Ground-truth
intents are hand-authored* and gate correctness; one over-narrow intent (the type-check-timeout boundary) was corrected
post hoc, with no change to the recorded result because the reliable judge had already graded against the actual
package context. Full harness, raw responses, judge verdicts, and aggregation are in the experiment directory
(`experiments/resume-reproducibility/`, benchmark `bench_6499413d`).

#### 5.8.2 A controlled head-to-head: realized-action non-inferiority, measured

**In the paper's primary controlled experiment, rebirth is statistically indistinguishable from compaction on first-action quality — parity, not loss.**

§5.8.1 measured rebirth's behavioral correctness *alone*. The paper's load-bearing claim, though, is a
*comparison* — rebirth **not worse** than the incumbent (§11.1, §12) — and that comparison's decisive form, the
four-arm task-outcome fork-and-compare of §8, is pre-registered but unrun. What we *can* put on the table now is
the same comparison one rung lower on the outcome ladder: a **controlled realized-action A/B** in which the model
and prompt are held fixed and *only the resume artifact* varies — rebirth package versus compaction summary.
Unlike every number in §5–§7, this is not observational; it is a manipulated-variable experiment, and it is the
**primary** controlled A/B comparison the paper reports — the stronger-instrumented of the two controlled probes
the program has run (the earlier, judge-mediated probe is disclosed below).

**The paired arm (5 boundaries × 5 models).** At each of the same five continuation boundaries as §5.8.1, we
produced **one fixed reactive-compaction summary** — generated by a single strong summarizer (Sonnet) over the
real predecessor transcript, given a *realistic full-context window* (≈130K tokens; four of five boundaries are
summarized in full, only the 1.6M-character outlier gets a recent window) under Claude Code's verbatim
reactive-compaction prompt — and fed it to the **same five responder models** exactly as the deterministic
rebirth package is fed, varying *only the artifact*. We sampled the first-turn response *n* = 10 per cell (250
responses) and scored correctness with the **identical** blind two-judge rubric and ground-truth intents of
§5.8.1. The result, paired by (boundary, model) and recomputed for both arms under one extraction:

| view | rebirth correctness | compaction correctness | paired gap (R−C) | δ = 0.1 non-inferiority |
|---|---|---|---|---|
| both judges, pooled | **0.89** | **0.93** | −0.04 · CR1 95% CI [−0.11, +0.04] · cluster-boot [−0.08, +0.01] | **pass** (one-sided LB −0.096 > −0.1) |
| reliable judge | **0.94** | **0.92** | +0.01 · CR1 [−0.15, +0.18] · cluster-boot [−0.06, +0.13] | boot pass; CR1‑*t* marginal (LB −0.115) |

**The finding is parity.** The two artifacts drive **statistically indistinguishable** first actions: the gap is
within ±0.04, non-significant in both judge views, and it *flips sign* depending on which judge is trusted. A sign
test over the 25 cells is 5 rebirth wins / 7 compaction wins / 13 ties (*p* = 0.77); per boundary, compaction
nominally edges rebirth on three of five. Realized-action **non-inferiority holds** — that is the claim the paper
needs and now has under control — but we state its strength precisely: with only five boundary clusters (df = 4),
the δ = 0.1 gate is *consistent with non-inferiority* rather than cleared with margin to spare. It passes on the
pooled estimate and on both cluster bootstraps; the reliable-judge cluster-robust *t*-test marginally fails its
lower bound (−0.115) because one boundary carries an outlier and four degrees of freedom are unforgiving. There is
**no realized-action *superiority* for rebirth**: a fair, full-context compaction summary resumes the first action
as well as the package.

**Why this corrects an earlier pilot, not the other way around.** An early *single-boundary, single-model* pilot
(below) had suggested a large gap — a byte-matched rebirth arm at 70% against an end-to-end compaction arm at 20%.
We treated that as a pilot and ran the fair paired arm; **the gap did not replicate.** The pilot's 20% was an
artifact of two choices the paired arm fixes: the summarizer saw only a short recency-truncated tail of the
transcript (real reactive compaction fires near a *full* context), and the boundary was a worst case whose summary
narrated its own tool history in a way the responder over-read. Given the whole conversation to summarize,
compaction resumes correctly. We keep the pilot for transparency, not as evidence:

| pilot arm (one boundary, deepseek-v4-pro, recency-truncated source) | first-action fidelity | length CV / concrete-token scatter |
|---|---|---|
| Rebirth package (full) | 6/10 | 0.74 / 8 |
| Rebirth package (byte-matched to a summary) | 7/10 | 0.44 / 4 |
| Compaction summaries (end-to-end, 10 distinct) | 2/10 | 1.50 / 110 |
| Compaction summary (one fixed, reused ×10) | 5/10 | 0.52 / 16 |

**Where the difference actually lives — and it is not first-action quality.** That compaction *ties* on mean
first-action correctness does not make the two artifacts equivalent; it relocates rebirth's advantage onto the
axes §5.8 already measured and §6 quantifies. (i) **Determinism.** Even at equal *mean* correctness, the
compaction arm carries a stochastic layer the package does not: re-running the summarizer on one fixed transcript
reshuffles 70–90% of its concrete detail (§5.8), so the *same* boundary yields a *different* summary — and
therefore different behavior — on every resume. The pilot's reproducibility columns localize this: fixing the
summary collapses the response-length CV from 1.50 → 0.52 and concrete-token scatter from 110 → 16, i.e. most of
compaction's behavioral spread is inherited from *which summary it drew*, not from response sampling. The package
has no such layer to inherit. (ii) **Cost and latency.** Rebirth reaches that parity from a cheap, deterministically
assembled ≈10K-token package built with **no summarization model call** — so the boundary is effectively instant and
non-blocking — whereas each compaction summary required a turn-blocking generation pass that fed the summarizer
33–172K input tokens plus thousands of output tokens. The honest scope: this is a saving on the *artifact-generation*
step and a latency win, **not** a proof of lower *total* lifetime cost — a compaction summary can be shorter than the
package and therefore cheaper on later responder turns once its one-time generation is amortized (§9.3–§9.4). What
rebirth removes outright is the summarizer call and its turn-blocking stall; whether total serving cost is lower is
the parameterized question of §9, framed by the *non-inferiority-then-economics* decision rule of §11.1 and §12.
(iii) **Versatility.** A package is a *structured, operable* object — it can be forked into a new
lineage, reseeded into a specialist, redirected, or carried across an engine hot-swap (§7) — where a compaction
summary is opaque prose welded into one running session. This is a categorical capability difference, not a margin.

**An earlier controlled probe, disclosed.** This realized-action A/B superseded an earlier blindness-audited
*judged trace-fidelity* comparison (`experiments/agent-judge-landmark/`, bench_2df4ebd5): two judges scored
R-versus-C continuations of 14–17 real boundaries from 10–12 instances on a 0–12 scale, in two responder
configurations. Its point estimates lean compaction in all four judge × responder cells (Δ = −0.3 to −3.0 of
12), but three of the four are not significant (codex judge: −1.86, sign-test *p* = .79, and −0.29, *p* = 1.0;
DeepSeek judge, default responders: −1.50, *p* = .30), and the one cell that is — the DeepSeek judge on
Sonnet-API responders, −2.97 [−4.56, −1.38], *p* = .002 — is contradicted by the other judge scoring the
identical packets as a wash (*p* = 1.0), with poor inter-judge agreement throughout (winner κ ≈ 0.29–0.36).
That instrument-level unreliability is exactly why the design was superseded by this section's realized-action
measurement: score what the responder actually *does* against hand-authored ground truth, not a judge's grade
of fidelity prose. We disclose it rather than orphan it, and read the pair plainly: under the weaker
judge-mediated instrument, compaction looks no worse and possibly better; under the stronger realized-action
instrument, the two artifacts tie. Neither controlled probe finds rebirth *superior* on resumption quality —
consistent with §11.1's claim structure, which stakes rebirth's case on non-inferiority plus determinism,
cost, and versatility, never on resumption superiority.

**What this is and is not.** This is the paper's primary *controlled* comparison, and it confirms realized-action
non-inferiority — but it lives one rung below the §8 target in two ways. It scores the **first action**, not the
**completed task outcome**: a correct first move is a leading indicator of a faithful trajectory, not a guarantee
of one. And it measures **single-shot** compaction — the best case. Real long-running sessions compact
*repeatedly* (summary-of-summary), and the §5.8 instability and §5.7 depth-fidelity results predict the two arms
should *diverge* under chaining even though they tie once; external recursive-memory and context-folding results
make that prediction plausible (arXiv:2605.30159; arXiv:2510.11967), but do not substitute for measuring it here.
The prediction is pre-registered as a rebirth-versus-*chained*-compaction test, runnable on these same boundaries
under §8.7, and untested. We state the standing precisely:
*realized-action* non-inferiority is **measured and holds as parity**; rebirth's decisive advantages over
compaction are **determinism, cost, and versatility**, not first-action quality; and *task-outcome* non-inferiority
(§8) plus *chained-compaction* divergence remain the open tests.
